/**
 * Ask Spider, one question at a time, with the schema and nothing else.
 *
 * ## Why this prompt has no rows, and WikiSQL's first arm had five
 *
 * WikiSQL is a corpus of values: its questions name a cell, and a prompt that shows five sample rows
 * is what lets a model copy the spelling the database actually stores. Spider is the opposite kind
 * of hard. Its questions are compositional — `Which singer has the most concerts?` needs a join, a
 * group and an ordinal — and the corpus ships no rows at all in the skeleton this repository builds
 * from `tables.json`. So the prompt is the schema, written as the `CREATE TABLE` statements a person
 * would read, plus the question.
 *
 * That is not a compromise, it is the coordinate. WikiSQL's schema arm measures the same thing on a
 * corpus where rows exist: what is left when the examples are taken away. Here nothing was ever
 * there. The two readings are therefore comparable in the one way that matters and not in any other,
 * and the note that travels with the number says so.
 *
 * ## What is reused rather than re-written
 *
 * The reader (`statementOfReply`), the concurrency pool, the unreadable-reply gate and the evidence
 * file all come from `eval/wikisql/ask.ts`. A reader is part of the instrument: two corpora read by
 * two different extractors are not two comparable readings. What is Spider's own is the prompt, the
 * price bound, and the statement that a `SELECT` here may be long enough to hit a token cap.
 *
 *   tsx eval/spider/ask.ts --limit 20
 *   tsx eval/spider/ask.ts --out eval/out/spider-predictions.jsonl
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { LlmProvider } from '@agentix-e/nl2charts-ai';
import { billOf, formatYuan } from '../price.js';
import {
  pool,
  providerFrom,
  reasonsFirst,
  reasonsOf,
  statementOfReply,
  unreadable,
  unreadableText,
  REASONING_COMPLETION_TOKENS,
} from '../wikisql/ask.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

/** A version is a name for a byte-string. `@1` is the first prompt this corpus is asked with. */
export const PROMPT_VERSION = 'spider-ask@1';

/**
 * A case's cost bound, before it is asked.
 *
 * A Spider schema is five tables of six columns — nine hundred prompt tokens is above every database
 * in dev — and a reply is one statement, longer than WikiSQL's because a join with grouping is
 * longer, so a hundred and twenty. The bound exists to refuse a dispatch whose projection is over
 * budget; an over-estimate refuses a little early and an under-estimate is the error that costs.
 */
export const PER_CASE = { promptTokens: 900, completionTokens: 120 } as const;

/** The ceiling a dispatch may project without saying the number out loud. */
export const BUDGET_YUAN = 45;

/**
 * The per-case bound for a model, in the tier it is billed at.
 *
 * A reasoning tier returns one statement and bills the thinking it never returns, so pricing it off
 * the reply approves the dispatch at a fraction of its cost — the same defect the WikiSQL asker was
 * fixed for, and the reason this file imports that predicate rather than writing a second one.
 */
export function perCaseFor(model: string): { readonly promptTokens: number; readonly completionTokens: number } {
  return reasonsFirst(model)
    ? { promptTokens: PER_CASE.promptTokens, completionTokens: REASONING_COMPLETION_TOKENS }
    : PER_CASE;
}

/** What `questions` cases would cost at the bound, or nothing when the model has no price. */
export function projectedYuan(questions: number, model: string): number | undefined {
  const per = billOf(model, perCaseFor(model));
  return per === undefined ? undefined : per * questions;
}

/** A column, as `tables.json` declares it. */
export interface Column {
  readonly table: number;
  readonly name: string;
}

/** One database's declaration, in the fields a prompt and a schema need. */
export interface Database {
  readonly db_id: string;
  readonly table_names_original: readonly string[];
  readonly column_names_original: readonly (readonly [number, string])[];
  readonly column_types: readonly string[];
  /** Pairs of flat column indices; the prompt names them, because a join is the point of Spider. */
  readonly foreign_keys?: readonly (readonly [number, number])[];
}

/** The declaration of one database, or a refusal that names it. */
export function databaseOf(tables: readonly Database[], dbId: string): Database {
  const found = tables.find((entry) => entry.db_id === dbId);
  if (found === undefined) throw new Error(`tables.json does not describe ${dbId}`);
  return found;
}

/** The columns of one table, in declaration order. */
export function columnsOf(database: Database, table: number): Column[] {
  return database.column_names_original
    .map(([owner, name], index) => ({ owner, index, name }))
    .filter((column) => column.owner === table)
    .map((column) => ({ table: column.owner, name: column.name }));
}

/** The name of a flat column index, for a foreign-key pair. */
function columnName(database: Database, index: number): string {
  const [table, name] = database.column_names_original[index] as readonly [number, string];
  return `${database.table_names_original[table] as string}.${name}`;
}

/**
 * The schema as SQL, which is the form a model has read most of.
 *
 * The type words are the corpus's own (`NUMBER`, `TEXT`, `TIME`), not SQLite's affinities. The
 * skeleton database stores them as `REAL`/`TEXT` because a database has to choose, but the prompt
 * describes the corpus as `tables.json` describes it — one spelling per idea, and the one every
 * Spider reader has seen.
 *
 * Foreign keys are written as `--` comments rather than constraints: a constraint in a `CREATE TABLE`
 * the model is not asked to run is noise, and a comment is the same fact without pretending the
 * statement is executable.
 */
export function schemaText(database: Database): string {
  const lines: string[] = [];
  for (const [table, name] of database.table_names_original.entries()) {
    const declared = database.column_names_original
      .map(([owner, column], index) => ({ owner, column, type: database.column_types[index] ?? 'text' }))
      .filter((entry) => entry.owner === table)
      .map((entry) => `  ${entry.column} ${entry.type.toUpperCase()}`);
    lines.push(`CREATE TABLE ${name} (`);
    lines.push(declared.join(',\n'));
    lines.push(');');
  }
  for (const [left, right] of database.foreign_keys ?? []) {
    lines.push(`-- ${columnName(database, left)} references ${columnName(database, right)}`);
  }
  return lines.join('\n');
}

/** The prompt for one question: the database's schema, then the question. */
export function promptFor(question: string, database: Database): readonly { readonly role: 'system' | 'user'; readonly content: string }[] {
  return [
    { role: 'system', content: 'You write one SQLite statement for one database. You answer with the statement only.' },
    {
      role: 'user',
      content: [
        `The database is called "${database.db_id}". Its schema is:`,
        '',
        schemaText(database),
        '',
        `Question: ${question}`,
        '',
        'Write one SELECT statement that answers the question. Use only the tables and columns above,',
        'spelled exactly as they are declared. When the question asks for a superlative or a ranking,',
        'the statement needs the ORDER BY and LIMIT that express it. Answer with the statement only.',
      ].join('\n'),
    },
  ];
}

/** One question's reply, kept beside the statement so a reader can audit the extraction. */
export interface AskRecord {
  readonly index: number;
  readonly sql: string | undefined;
  readonly reply: string;
  readonly truncated: boolean;
  readonly error: string | undefined;
}

/** What a run counted. */
export interface AskTally {
  readonly asked: number;
  readonly answered: number;
  readonly unreadable: number;
  readonly truncated: number;
  readonly failed: number;
}

/** Flags this file reads. */
export interface Settings {
  readonly split: string;
  readonly limit: number | undefined;
  readonly out: string;
  readonly cache: string | undefined;
  readonly concurrency: number;
  readonly arm: string;
  readonly acceptCost: number | undefined;
  readonly budget: number;
}

export function resolveSettings(argv: readonly string[]): Settings {
  let limit: number | undefined;
  let out = 'eval/out/spider-predictions.jsonl';
  let cache: string | undefined;
  let concurrency = 6;
  let acceptCost: number | undefined;
  let budget = BUDGET_YUAN;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    const value = argv[index + 1];
    if (flag === '--limit' && value !== undefined) {
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
  // One arm, named rather than assumed: the workflow passes it so a log line says which prompt was
  // sent, and a second arm later changes this default rather than every caller.
  return { split: 'dev', limit, out, cache, concurrency, arm: 'schema', acceptCost, budget };
}

/** One line of `dev.json`, in the three fields this file reads. */
export interface DevQuestion {
  readonly db_id: string;
  readonly question: string;
  readonly query: string;
}

/** The corpus, as the asker needs it: the questions, and the declaration behind each schema. */
export function readCorpus(dir: string): { questions: DevQuestion[]; tables: Database[] } {
  const questions = JSON.parse(readFileSync(join(dir, 'dev.json'), 'utf8')) as DevQuestion[];
  const tables = JSON.parse(readFileSync(join(dir, 'tables.json'), 'utf8')) as Database[];
  return { questions, tables };
}

/** Ask every question once, and keep what came back. */
export async function askAll(
  questions: readonly DevQuestion[],
  tables: readonly Database[],
  provider: LlmProvider,
  concurrency: number,
): Promise<readonly AskRecord[]> {
  return pool(questions, concurrency, async (question, index) => {
    try {
      const response = await provider.complete({ messages: promptFor(question.question, databaseOf(tables, question.db_id)), temperature: 0, purpose: 'generate' });
      const truncated = response.finishReason === 'length';
      return {
        index,
        sql: truncated ? undefined : statementOfReply(response.text),
        reply: response.text,
        truncated,
        error: undefined,
      };
    } catch (error) {
      return { index, sql: undefined, reply: '', truncated: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** What the records add up to. */
export function tallyOf(records: readonly AskRecord[]): AskTally {
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
  const lines = records
    .filter((record) => record.sql !== undefined)
    .map((record) => JSON.stringify({ index: record.index, sql: record.sql }));
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** The report, as lines. */
export function reportLines(tally: AskTally, bill: string | undefined): readonly string[] {
  const lines = [
    `spider ask: ${String(tally.asked)} question(s), ${String(tally.answered)} answered`,
    `  unreadable ${String(tally.unreadable)} (${(100 * tally.unreadable / Math.max(tally.asked, 1)).toFixed(1)}%)`,
    `  truncated ${String(tally.truncated)}, failed ${String(tally.failed)}`,
  ];
  if (bill !== undefined) lines.push(`  bill ${bill}`);
  return lines;
}

/** The provider this file talks to, or the reason there is none. Shared with WikiSQL, on purpose. */
export { providerFrom };

export async function main(
  argv: readonly string[],
  deps: {
    readonly provider?: LlmProvider;
    readonly log?: (line: string) => void;
    readonly fetch?: typeof fetch;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const settings = resolveSettings(argv);
  const provider = deps.provider ?? providerFrom(deps.env ?? process.env, { ...(deps.fetch === undefined ? {} : { fetchImpl: deps.fetch }) });
  const cache = settings.cache ?? process.env.SPIDER_CACHE ?? join(ROOT, 'eval/.cache/spider');
  const { questions, tables } = readCorpus(cache);
  const rows = settings.limit === undefined ? questions : questions.slice(0, settings.limit);
  log(`spider ask: ${String(rows.length)} question(s) on dev, ${String(tables.length)} database(s) declared, ${provider.model}, ${PROMPT_VERSION}`);
  const projected = projectedYuan(rows.length, provider.model);
  if (projected === undefined && settings.acceptCost === undefined) {
    log(`REFUSED: no price on file for ${provider.model}, so this dispatch cannot be projected; pass --accept-cost to name the ceiling`);
    return 4;
  }
  const ceiling = settings.acceptCost ?? settings.budget;
  if (projected !== undefined && projected > ceiling) {
    log(`REFUSED: ${String(rows.length)} case(s) project ${formatYuan(projected)}, above the ${formatYuan(ceiling)} ceiling; narrow --limit or pass --accept-cost`);
    return 4;
  }
  if (projected !== undefined) log(`  projection ${formatYuan(projected)} at the per-case bound`);
  let promptTokens = 0;
  let completionTokens = 0;
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
  const records = await askAll(rows, tables, metered, settings.concurrency);
  const tally = tallyOf(records);
  const bill = billOf(provider.model, { promptTokens, completionTokens });
  for (const line of reportLines(tally, bill === undefined ? undefined : formatYuan(bill))) log(line);
  const out = resolve(ROOT, settings.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, predictionsText(records));
  writeFileSync(`${out.replace(/\.jsonl$/u, '')}.unreadable.jsonl`, unreadableText(records));
  log(`  predictions ${out}`);
  for (const reason of reasonsOf(records).slice(0, 5)) log(`  because ${reason}`);
  if (unreadable(tally)) {
    log(`REFUSED: ${String(tally.unreadable)} of ${String(tally.asked)} replies held no statement, above the 1% ceiling; nothing is scored`);
    return 3;
  }
  return 0;
}

/** Whether this module was run rather than imported. */
export function runsAsMain(argv1: string | undefined): boolean {
  return argv1?.endsWith('spider/ask.ts') === true || argv1?.endsWith('spider/ask.js') === true;
}

/** The entry, as a function a test can drive. Shared shape with the WikiSQL asker. */
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
