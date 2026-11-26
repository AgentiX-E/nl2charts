/**
 * Ask WikiSQL, and write the predictions the judge already knows how to score.
 *
 * ## What was missing, and why it was this file
 *
 * WikiSQL has had a corpus fetcher, an executed-twice gold validation, a port of the reference's
 * `dbengine` and a differential digest against it for several rounds. It has never had a reading,
 * because the runner scores a predictions file and nothing in this repository writes one: the
 * coverage table has said `instrumented` since the table existed, and `instrumented` means "the
 * instrument can be calibrated and nobody has pointed it at the sky".
 *
 * The missing half is small on purpose. One call a question, one statement out, no candidate set,
 * no repair loop, no vote. This is the reading a first dispatch has to produce — *our prompt, one
 * call, on WikiSQL* — because every later arm is a delta against it, and a delta against an arm
 * that was never measured is a number about nothing.
 *
 * ## Why the table is rendered and not just named
 *
 * WikiSQL's questions are answerable from one table and are mostly about *values* in it: `who was
 * picked first` needs the column, and `the writer of "The Duff"` needs a literal that is stored in
 * one cell with one spelling. The corpus ships the table (`{split}.tables.jsonl`: header, types and
 * rows) and the reference's own baselines feed the model the header and a sample of rows, so this
 * prompt does the same — and says out loud that a literal must be copied as the rows spell it,
 * which is the one instruction a value-matched corpus rewards and a schema-only prompt cannot.
 *
 * The sample is five rows and not the whole table: a WikiSQL table runs to thousands of rows, the
 * question never needs more than the cells it names, and a prompt that carried the table would cost
 * more than the answer is worth. Five is the corpus's own choice in its prompt experiments; it is a
 * constant here rather than a flag because a flag would make two readings incomparable without
 * saying so.
 *
 * ## What this file refuses to do
 *
 * - **Publish a number over a broken reader.** A reply that holds no `SELECT` is not a wrong
 *   answer, it is an answer that was not read, and a run whose replies were 30% unreadable reports
 *   an accuracy that is a fact about the reader. Above `MAX_UNREADABLE_SHARE` this file exits 3 and
 *   the workflow stops before the judge runs, so no number is printed. The threshold is the one the
 *   chart bench settled on for the same reason: 1% of a split this size is under the resolution the
 *   split can express.
 * - **Read a statement out of a cut reply.** `finish_reason=length` means the endpoint stopped
 *   mid-statement; the bytes look like SQL and are not, and scoring them would report a budget as a
 *   wrong answer. Those are counted as unreadable, which is what they are.
 * - **Send a key it was not given.** The key comes from the environment and the message says which
 *   variable to set. There is no default endpoint and no default key.
 *
 *   tsx eval/wikisql/ask.ts --limit 20          # a pilot: twenty questions, one call each
 *   tsx eval/wikisql/ask.ts --out eval/out/wikisql.jsonl
 *   pnpm bench:wikisql --predictions eval/out/wikisql.jsonl
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHttpProvider, type LlmMessage, type LlmProvider } from '@agentix-e/nl2charts-ai';
import { billOf, formatYuan } from '../price.js';
import { cacheDir, openSplit } from './run.js';
import { tableNameOf } from './form.js';
import type { SplitRow } from './exec.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

/** What this prompt is. A reading is comparable with another only under the same version. */
export const PROMPT_VERSION = 'wikisql-ask@1';

/** Rows of the table shown to the model, as the corpus's own prompt experiments do. */
export const SAMPLE_ROWS = 5;

/**
 * The share of replies that may be unreadable before this file refuses to publish.
 *
 * An unreadable reply is not a wrong answer, so a run that scores it as one reports the reader.
 * One percent of 8,421 questions is 84 cases — well under the 0.5pp a split of this size can
 * resolve, and far above the zero a working reader produces.
 */
export const MAX_UNREADABLE_SHARE = 0.01;

/**
 * What a case is assumed to cost before it is asked.
 *
 * An upper bound, not a measurement: the prompt is a schema of two to twelve columns plus five rows
 * plus the question, and the reply is one statement. Four hundred prompt tokens and sixty reply
 * tokens sit above every case this file has rendered offline. The point of the number is to refuse a
 * dispatch whose *projection* is over budget, so an over-estimate refuses a little early and an
 * under-estimate is the failure mode that costs money — the constants are therefore rounded up, and
 * the bill printed after the run is the number a reader quotes.
 */
export const PER_CASE = { promptTokens: 400, completionTokens: 60 } as const;

/** The ceiling a dispatch may project, in yuan, without saying the number out loud. */
export const BUDGET_YUAN = 45;

/** What `questions` cases would cost at the per-case bound, or nothing when the model has no price. */
export function projectedYuan(questions: number, model: string): number | undefined {
  const per = billOf(model, PER_CASE);
  return per === undefined ? undefined : per * questions;
}

/** One table of the split, as `{split}.tables.jsonl` stores it. */
export interface Table {
  readonly id: string;
  readonly header: readonly string[];
  readonly types: readonly string[];
  /**
   * The table's cells, as the corpus stores them.
   *
   * `unknown` rather than `string` because the JSON does not keep that promise: a column of counts
   * arrives as numbers and an empty cell as `null`. The first pilot refused 14 of 40 cases with
   * `value.replaceAll is not a function` — a prompt renderer that assumed a string, discovered by the
   * refusal's own evidence rather than by the model, which had answered 26 of 40 correctly.
   */
  readonly rows: readonly (readonly unknown[])[];
}

/** One question's reply, kept beside the statement so a reader can audit the extraction. */
export interface AskRecord {
  readonly index: number;
  readonly sql: string | undefined;
  readonly reply: string;
  readonly truncated: boolean;
  readonly error: string | undefined;
}

/** What a run counted. Every field is a count a reader can recompute from the records. */
export interface AskTally {
  readonly asked: number;
  readonly answered: number;
  readonly unreadable: number;
  readonly truncated: number;
  readonly failed: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly yuan: number;
}

/** What the records add up to, before the bill: the counts a reader can recompute from the file. */
export type AskCounts = Omit<AskTally, 'promptTokens' | 'completionTokens' | 'yuan'>;

/** Flags this file reads, and nothing else. */
export interface Settings {
  readonly split: string;
  readonly limit: number | undefined;
  /** Always set: a run that wrote no predictions file is a run whose bill bought nothing. */
  readonly out: string;
  readonly cache: string | undefined;
  readonly concurrency: number;
  /** The yuan this dispatch may project, when the caller is willing to say it out loud. */
  readonly acceptCost: number | undefined;
  /** The ceiling the projection is compared against, when the caller narrows the default. */
  readonly budget: number;
}

export function resolveSettings(argv: readonly string[]): Settings {
  let split = 'dev';
  let limit: number | undefined;
  let out = 'eval/out/wikisql-predictions.jsonl';
  let cache: string | undefined;
  let concurrency = 6;
  let acceptCost: number | undefined;
  let budget = BUDGET_YUAN;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    const value = argv[index + 1];
    if (flag === '--split' && value !== undefined) {
      split = value;
      index += 1;
    } else if (flag === '--limit' && value !== undefined) {
      limit = Number(value);
      index += 1;
    } else if (flag === '--out' && value !== undefined) {
      out = value;
      index += 1;
    } else if (flag === '--cache' && value !== undefined) {
      cache = value;
      index += 1;
    } else if (flag === '--concurrency' && value !== undefined) {
      concurrency = Number(value);
      index += 1;
    } else if (flag === '--accept-cost' && value !== undefined) {
      acceptCost = Number(value);
      index += 1;
    } else if (flag === '--budget' && value !== undefined) {
      budget = Number(value);
      index += 1;
    }
  }
  // A limit that is not a positive integer is refused rather than coerced: `--limit 0` reads as
  // "run nothing" and would publish a 0% reading of an empty denominator, and `NaN` compares false
  // against every bound so a sliced array would silently be the whole split.
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`--limit must be a positive integer, got ${String(limit)}`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer, got ${String(concurrency)}`);
  }
  if (acceptCost !== undefined && (!Number.isFinite(acceptCost) || acceptCost <= 0)) {
    throw new Error(`--accept-cost must be a positive number of yuan, got ${String(acceptCost)}`);
  }
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error(`--budget must be a positive number of yuan, got ${String(budget)}`);
  }
  return { split, limit, out, cache, concurrency, acceptCost, budget };
}

/** Parse `{split}.tables.jsonl` into a map by table id. */
export function parseTables(text: string): Map<string, Table> {
  const tables = new Map<string, Table>();
  for (const [offset, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as {
      id: string;
      header: string[];
      types: string[];
      rows: string[][];
    };
    if (!Array.isArray(parsed.header) || parsed.header.length === 0) {
      throw new Error(`table ${String(parsed.id)} at line ${String(offset)} has no header`);
    }
    tables.set(parsed.id, {
      id: parsed.id,
      header: parsed.header,
      types: Array.isArray(parsed.types) ? parsed.types : [],
      rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    });
  }
  return tables;
}

/** One cell as the prompt spells it: quoted, with a quote inside it escaped the way SQL escapes one. */
export function cellOf(value: unknown): string {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

/**
 * The prompt for one question.
 *
 * The column list is positional because a WikiSQL statement is: `SELECT col2` names the third
 * column, and a model that is handed names-only has to map an ordinal it never sees. The types are
 * the corpus's own strings (`text`, `real`) rather than this repository's `quantitative` vocabulary,
 * because the corpus's numbers were produced with the corpus's words.
 */
export function promptFor(question: string, table: Table): readonly LlmMessage[] {
  const columns = table.header.map((name, index) => `  ${String(index)}: ${name} (${table.types[index] ?? 'text'})`);
  const sample = table.rows.slice(0, SAMPLE_ROWS).map((row) => `  ${row.map(cellOf).join(', ')}`);
  const system = 'You write one SQLite statement for one table. You answer with the statement only.';
  const user = [
    `The table is called "${tableNameOf(table.id)}" and its columns are, in order:`,
    ...columns,
    '',
    `The first ${String(sample.length)} rows, as this table stores them:`,
    ...sample,
    '',
    `Question: ${question}`,
    '',
    'Write one SELECT statement that answers the question. Use only this table and the columns',
    'listed above. When the question names a value, copy it exactly as the rows above spell it.',
    'Answer with the statement and nothing else.',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * The statement a reply holds, or nothing.
 *
 * A reader is part of the instrument: two arms whose replies are read by two different readers are
 * not two arms. So the rules are fixed, narrow and tested — a fenced block wins over prose, the
 * statement starts at the first `SELECT` and ends at the first `;` that follows it, and a reply
 * with no `SELECT` at all is unreadable rather than guessed at.
 */
export function statementOfReply(reply: string): string | undefined {
  const fenced = /```[a-zA-Z]*\n?([\s\S]*?)```/u.exec(reply);
  const body = fenced === null ? reply : (fenced[1] as string);
  const start = /\bSELECT\b/iu.exec(body);
  if (start === null) return undefined;
  const from = body.slice(start.index);
  const stop = from.indexOf(';');
  // The result cannot be empty: `start` matched `SELECT` inside `from`, so the slice always holds
  // at least those six characters. A guard against the empty string here would be a branch no reply
  // can take, which the coverage ledger treats as a defect rather than as caution.
  return (stop === -1 ? from : from.slice(0, stop)).trim();
}

/** Run `worker` over `items` with at most `width` in flight, results in input order. */
export async function pool<T, R>(
  items: readonly T[],
  width: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Ask every question once, and keep what came back. */
export async function askAll(
  rows: readonly SplitRow[],
  tables: ReadonlyMap<string, Table>,
  provider: LlmProvider,
  concurrency: number,
): Promise<readonly AskRecord[]> {
  return pool(rows, concurrency, async (row) => askOne(row, tables.get(row.tableId), provider));
}

/** One question. A missing table is a case this corpus cannot ask, not a crash. */
async function askOne(row: SplitRow, table: Table | undefined, provider: LlmProvider): Promise<AskRecord> {
  if (table === undefined) {
    return { index: row.index, sql: undefined, reply: '', truncated: false, error: `no table ${row.tableId}` };
  }
  try {
    const response = await provider.complete({ messages: promptFor(row.question, table), temperature: 0, purpose: 'generate' });
    const truncated = response.finishReason === 'length';
    return {
      index: row.index,
      sql: truncated ? undefined : statementOfReply(response.text),
      reply: response.text,
      truncated,
      error: undefined,
    };
  } catch (error) {
    return {
      index: row.index,
      sql: undefined,
      reply: '',
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** What the records add up to. */
export function tallyOf(records: readonly AskRecord[]): AskCounts {
  let answered = 0;
  let truncated = 0;
  let failed = 0;
  for (const record of records) {
    if (record.error !== undefined) failed += 1;
    if (record.truncated) truncated += 1;
    if (record.sql !== undefined) answered += 1;
  }
  return { asked: records.length, answered, unreadable: records.length - answered, truncated, failed };
}

/** The predictions file the judge reads, in question order. */
export function predictionsText(records: readonly AskRecord[]): string {
  const lines: string[] = [];
  for (const record of records) {
    if (record.sql === undefined) continue;
    lines.push(JSON.stringify({ index: record.index, sql: record.sql }));
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/**
 * Why the replies that were not read were not read.
 *
 * The first pilot refused 14 of 40 and the artifact held only the 26 that worked, so the refusal
 * named a count and nobody could see the reason — a refusal without evidence is a gate that has to be
 * re-run to be understood, and a re-run costs money. Three facts per case explain all of it: whether
 * the endpoint cut the reply, what it threw if it did, and the first 300 characters of what it said.
 */
export function unreadableText(records: readonly AskRecord[]): string {
  const lines: string[] = [];
  for (const record of records) {
    if (record.sql !== undefined) continue;
    lines.push(
      JSON.stringify({
        index: record.index,
        truncated: record.truncated,
        error: record.error ?? null,
        reply: record.reply.slice(0, 300),
      }),
    );
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** The distinct reasons, in the order they first appeared, for the log line that names them. */
export function reasonsOf(records: readonly AskRecord[]): readonly string[] {
  const reasons: string[] = [];
  for (const record of records) {
    if (record.sql !== undefined) continue;
    const reason = record.error ?? (record.truncated ? 'reply cut at the token cap' : 'reply held no SELECT');
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  return reasons;
}

/** The report, as lines: one per count, and the share the refusal is about. */
export function reportLines(tally: AskCounts, bill: string | undefined): readonly string[] {
  const lines = [
    `wikisql ask: ${String(tally.asked)} question(s), ${String(tally.answered)} answered`,
    `  unreadable ${String(tally.unreadable)} (${(100 * (tally.asked - tally.answered) / Math.max(tally.asked, 1)).toFixed(1)}%)`,
    `  truncated ${String(tally.truncated)}, failed ${String(tally.failed)}`,
  ];
  if (bill !== undefined) lines.push(`  bill ${bill}`);
  return lines;
}

/** Whether the unreadable share is above the ceiling this file refuses past. */
export function unreadable(tally: AskCounts): boolean {
  // Integer comparison, as the chart bench's failure gate learned to do: 16 of 8,421 is 0.19% in
  // double arithmetic and 0.19% is under the ceiling, but a comparison written as `share > 0.01`
  // on two rounded numbers is a comparison a reader cannot recompute from the counts.
  return (tally.asked - tally.answered) * 100 > tally.asked;
}

/** The provider this file talks to, or the reason there is none. */
export function providerFrom(env: NodeJS.ProcessEnv, options: { readonly fetchImpl?: typeof fetch } = {}): LlmProvider {
  const apiKey = env.LLM_API_KEY ?? env.DEEPSEEK_API_KEY ?? '';
  if (apiKey === '') {
    throw new Error('wikisql ask: no key. Set LLM_API_KEY (preferred) or DEEPSEEK_API_KEY in the environment, never in the repository');
  }
  return createHttpProvider({
    baseUrl: env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey,
    model: env.LLM_MODEL ?? 'deepseek-chat',
    retries: 3,
    timeoutMs: 120_000,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}

export async function main(
  argv: readonly string[],
  deps: {
    readonly provider?: LlmProvider;
    readonly log?: (line: string) => void;
    /** How a run with no injected provider reaches the endpoint. A test hands it a canned reply. */
    readonly fetch?: typeof fetch;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const settings = resolveSettings(argv);
  const provider = deps.provider ?? providerFrom(deps.env ?? process.env, { ...(deps.fetch === undefined ? {} : { fetchImpl: deps.fetch }) });
  const cache = cacheDir(settings.cache);
  const open = await openSplit(cache, settings.split, settings.limit);
  const tables = parseTables(readFileSync(join(cache, `${settings.split}.tables.jsonl`), 'utf8'));
  log(`wikisql ask: ${String(open.rows.length)} question(s) on ${String(settings.split)}, ${String(tables.size)} table(s), ${provider.model}, ${PROMPT_VERSION}`);
  // Priced before it is sent, because a run that is discovered to be expensive afterwards is a run
  // that was authorised by a field nobody read. Above the budget the caller says the number.
  const projected = projectedYuan(open.rows.length, provider.model);
  if (projected === undefined && settings.acceptCost === undefined) {
    log(`REFUSED: no price on file for ${provider.model}, so this dispatch cannot be projected; pass --accept-cost to name the ceiling`);
    return 4;
  }
  // `acceptCost` raises the ceiling; `budget` lowers it. They are two different decisions — "I know
  // this is expensive" and "I refuse to spend more than this" — and folding them into one number
  // would let a dispatch authorise itself by naming a large ceiling.
  const ceiling = settings.acceptCost ?? settings.budget;
  if (projected !== undefined && projected > ceiling) {
    log(`REFUSED: ${String(open.rows.length)} case(s) project ${formatYuan(projected)}, above the ${formatYuan(ceiling)} ceiling; narrow --limit or pass --accept-cost`);
    return 4;
  }
  if (projected !== undefined) log(`  projection ${formatYuan(projected)} at the per-case bound`);
  let promptTokens = 0;
  let completionTokens = 0;
  try {
    // Token counts are read off the response, which this file does not keep: a record is what the
    // artifact needs and a bill is what the log needs, so the provider is wrapped rather than the
    // record widened.
    const metered: LlmProvider = {
      id: provider.id,
      model: provider.model,
      complete: async (request, options) => {
        const response = await provider.complete(request, options);
        promptTokens += response.usage?.promptTokens ?? 0;
        completionTokens += response.usage?.completionTokens ?? 0;
        return response;
      },
    };
    const records = await askAll(open.rows, tables, metered, settings.concurrency);
    const counts = tallyOf(records);
    const bill = billOf(provider.model, { promptTokens, completionTokens });
    const tally: AskTally = { ...counts, promptTokens, completionTokens, yuan: bill ?? 0 };
    for (const line of reportLines(tally, bill === undefined ? undefined : formatYuan(bill))) log(line);
    mkdirSync(dirname(resolve(ROOT, settings.out)), { recursive: true });
    const out = resolve(ROOT, settings.out);
    writeFileSync(out, predictionsText(records));
    log(`  predictions ${out}`);
    // The evidence for the refusal, written whether or not there is a refusal: a run that read every
    // reply leaves an empty file, which is itself the answer to "did anything fail and why".
    const diagnostics = `${out.replace(/\.jsonl$/u, '')}.unreadable.jsonl`;
    writeFileSync(diagnostics, unreadableText(records));
    log(`  unreadable ${diagnostics}`);
    for (const reason of reasonsOf(records).slice(0, 5)) log(`  because ${reason}`);
    if (unreadable(tally)) {
      log(`REFUSED: ${String(tally.unreadable)} of ${String(tally.asked)} replies held no statement, above the 1% ceiling; nothing is scored`);
      return 3;
    }
    return 0;
  } finally {
    await open.close();
  }
}

/** Whether this module was run rather than imported, which is the only thing the entry checks. */
export function runsAsMain(argv1: string | undefined): boolean {
  return argv1?.endsWith('wikisql/ask.ts') === true || argv1?.endsWith('wikisql/ask.js') === true;
}

/**
 * The entry, as a function a test can drive.
 *
 * The obvious spelling is a module-scope `if (runsAsMain(...)) { ... }`, and it is wrong for the
 * reason `eval/entry.ts` writes down: the true arm runs in a process no test enters, so it is either
 * uncovered or covered by a subprocess whose coverage is not counted. Returning the work keeps the
 * module body one unconditional call, and the exit is a parameter so a test can read the code
 * instead of ending its own process.
 */
export async function start(
  argv1: string | undefined,
  run: () => Promise<number>,
  exit: (code: number) => void,
  stderr: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<void> {
  if (!runsAsMain(argv1)) return;
  try {
    exit(await run());
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    exit(1);
  }
}

void start(process.argv[1], () => main(process.argv.slice(2)), (code) => process.exit(code));
