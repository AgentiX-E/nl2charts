/**
 * The second question, asked once per refused row and priced.
 *
 * ## What this pays for, and what it does not
 *
 * `ship.ts` established the shape of the shipped reading: 863 rows decided on the model's first
 * answer, 754 charts, and **223 rows where the model named a mark its own result set refuses** — 159 of
 * them `boxplot`. Those rows were answered by the rule table, and the table got 40 of them right.
 *
 * The model was not wrong about the table. It was asked to choose from eleven marks when this table
 * could hold fewer, and nothing in the prompt said which. So this file asks the *same* question a
 * second time over `admittedOptions` — the marks that table can actually be drawn as — and prices the
 * answer. It is the only lever this project has found that is both cheap and measurable: nothing here
 * is a routing rule over the two existing answers, because the arbitration already showed there is
 * nothing left for a rule to find. The ceiling did not move; the reader did.
 *
 * ## Why the set of questions is computed by running the chart pass
 *
 * `repairAsks` draws every row with a repair turned on and an advisor that declines it, so the rows
 * asked about are, by construction, the rows `ship.ts` will ask about — not a second opinion about
 * which rows are refused. The defect this repository keeps meeting is the same in every instance: two
 * implementations of one sentence that agree until the day one of them changes.
 *
 * ## Cost
 *
 * One call per refused row: **223 calls, ≈¥0.06** on this corpus, against ¥1.25 for re-asking all
 * 1,470. The answers go into the same content-addressed store the arm uses — the key is a hash of the
 * option list, which is the only thing that differs between the two questions — so a second dispatch
 * restores them and pays nothing.
 *
 * ## What would make this a negative result
 *
 * If the repaired rows read no better than the table's 40 of 223, the honest conclusion is that a
 * model asked about a picture it cannot draw has no better answer than the rules do, and the second
 * question stays off by default. `hits` is published for exactly that reason: a repair that only
 * *shifts* which rows are wrong is not an improvement, and a share over the repaired rows is the
 * number that says so.
 */
import { createHttpProvider, withCallCounter, type LlmProvider } from '@agentix-e/nl2charts-ai';
import { applyExitCode, isEntry, loadText2Vis, type LoadOptions } from './dataset.js';
import { billOf, formatYuan } from '../price.js';
import { openStore, type ContentStore } from './content-store.js';
import {
  PROMPT_VERSION,
  askOnce,
  markAnswer,
  pool,
  replyBudget,
  replyOf,
  rosterOf,
  scoredRows,
  type ArmCost,
  type ArmRequest,
  type ModelRow,
  type StoredRow,
} from './llm.js';
import { familyOfLabel } from './rule.js';
import type { ProfileInput } from './profile.js';
import { answerKey, messageOf, repairAsks } from './ship.js';

/** One stored answer: the question it belongs to, the list it was asked over, and what came back. */
export interface RepairRow {
  /** The population index of the first row that asked this question, so a reader can find it. */
  readonly row: number;
  readonly question: string;
  /** The option list, in the order it was offered: part of the question, and half of its key. */
  readonly options: readonly string[];
  /** The name the reply held, or absent when it held none of the offered names. */
  readonly choice?: string;
  readonly reply: string;
  readonly truncated: boolean;
}

export interface RepairReport {
  readonly model: string;
  readonly request: ArmRequest;
  readonly population: { readonly scored: number; readonly roster: string };
  /** Rows whose first answer was refused by their own table. */
  readonly refused: number;
  /**
   * Of those, the rows a second question was asked about.
   *
   * Fewer than `refused` by the rows whose table holds a single mark: a question with one possible
   * answer is not a question, and asking it would spend a call to be told what the table already said.
   */
  readonly asked: number;
  /** Distinct questions: fewer than `asked` when two rows share a question and a table. */
  readonly questions: number;
  readonly answered: number;
  readonly unparsed: number;
  readonly truncated: number;
  /** Refused rows whose second answer is right, scored by the same mark table every reading uses. */
  readonly hits: number;
  readonly hitShare: number;
  /**
   * The same rows as the table answered them, from the artifact's own verdict.
   *
   * Published beside `hits` because the two are the comparison: a repair is only worth its calls if
   * it beats what the product would otherwise have drawn on exactly these rows.
   */
  readonly tableHits: number;
  readonly tableHitShare: number;
  readonly rows: readonly RepairRow[];
  readonly cost: ArmCost;
  readonly cache: { readonly hits: number; readonly misses: number; readonly corrupt: number };
}

/** The two rows a share is computed over, refused rather than divided by zero. */
function shareOf(hit: number, total: number): number {
  return total === 0 ? 0 : hit / total;
}

export interface RepairSettings {
  readonly provider: LlmProvider;
  readonly rows: readonly ProfileInput[];
  readonly choices: readonly (string | null)[];
  /** The product's own answer per row, so the repair can be compared with what it replaced. */
  readonly products: readonly string[];
  readonly cache?: ContentStore<StoredRow>;
  readonly concurrency: number;
  readonly log?: (line: string) => void;
}

/**
 * Ask the second question, score it, and report what it cost.
 *
 * Every call is made before any score is taken, for the reason `runArm` gives: a run that dies at row
 * 200 should leave the store holding 200 answers rather than nothing.
 */
export async function runRepair(settings: RepairSettings): Promise<RepairReport> {
  const { refused, asks } = await repairAsks(settings.rows, settings.choices);
  // One call per distinct question. Two rows that share a question and a table are one question to the
  // endpoint and one row each to the reading, so the deduplication is here and the counting is not.
  const first = new Map<string, number>();
  const unique: (typeof asks)[number][] = [];
  for (const ask of asks) {
    const key = answerKey(ask.question, ask.options);
    if (first.has(key)) continue;
    first.set(key, unique.length);
    unique.push(ask);
  }
  const metered = withCallCounter(settings.provider);
  const budget = replyBudget(metered.provider);
  const cache = settings.cache;
  const before = { hits: cache?.hits ?? 0, misses: cache?.misses ?? 0, corrupt: cache?.corrupt ?? 0 };
  // One entry per *row*, in row order. The store folds two rows that ask one question — the second is
  // a hit and costs nothing — so the pool does not need to deduplicate, and an array that is the same
  // length as the rows cannot lose an answer.
  const answers = await pool(asks, settings.concurrency, async (ask) =>
    // The same `askOnce` the arm uses: one request, one reader, one store. A second implementation of
    // "ask a closed list" would be a second instrument, and the two would be compared by accident.
    askOnce(metered.provider, { question: ask.question, options: ask.options }, {
      ...(cache === undefined ? {} : { cache }),
      ...(budget === undefined ? {} : { maxTokens: budget }),
    }),
  );
  const usage = metered.usage();

  let hits = 0;
  let tableHits = 0;
  let answered = 0;
  let unparsed = 0;
  let truncated = 0;
  for (let at = 0; at < asks.length; at += 1) {
    const ask = asks[at] as (typeof asks)[number];
    const answer = answers[at] as ModelRow;
    if (answer.truncated) truncated += 1;
    if (answer.choice === undefined) unparsed += 1;
    else answered += 1;
    const row = settings.rows[ask.row] as ProfileInput;
    const expected = familyOfLabel(row.label);
    if (expected !== undefined && answer.choice !== undefined && markAnswer(answer.choice, row.prompt).families[0] === expected) {
      hits += 1;
    }
    // The verdict `ship.ts` would have drawn on this row without the repair: the table's mark.
    if (expected !== undefined && markAnswer(settings.products[ask.row], row.prompt).families[0] === expected) {
      tableHits += 1;
    }
  }

  const rows: RepairRow[] = unique.map((ask) => {
    const answer = answers[first.get(answerKey(ask.question, ask.options)) as number] as ModelRow;
    return {
      row: ask.row,
      question: ask.question,
      options: ask.options.map((option) => option.name),
      ...(answer.choice === undefined ? {} : { choice: answer.choice }),
      reply: answer.reply,
      truncated: answer.truncated,
    };
  });

  const yuan = billOf(settings.provider.model, usage);
  const cost: ArmCost = {
    calls: metered.calls(),
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cachedPromptTokens: usage.cachedTokens,
    ...(yuan === undefined ? {} : { yuan, perRowYuan: unique.length === 0 ? 0 : yuan / unique.length }),
  };
  const report: RepairReport = {
    model: settings.provider.model,
    request: { promptVersion: PROMPT_VERSION, ...(budget === undefined ? {} : { budget }) },
    population: { scored: settings.rows.length, roster: rosterOf(settings.rows) },
    refused,
    asked: asks.length,
    questions: unique.length,
    answered,
    unparsed,
    truncated,
    hits,
    hitShare: shareOf(hits, asks.length),
    tableHits,
    tableHitShare: shareOf(tableHits, asks.length),
    rows,
    cost,
    cache: {
      hits: (cache?.hits ?? 0) - before.hits,
      misses: (cache?.misses ?? 0) - before.misses,
      corrupt: (cache?.corrupt ?? 0) - before.corrupt,
    },
  };
  for (const line of describeRepair(report)) settings.log?.(line);
  return report;
}

/**
 * The arithmetic a repair report can be wrong about, refused rather than published.
 *
 * The first check is the one that matters: `asked` cannot exceed `refusals`, and `refusals` cannot
 * exceed the population. A repair report whose denominator is bigger than the rows it could have been
 * asked about is a share over rows nobody refused.
 */
export function assertRepair(report: RepairReport): void {
  if (report.refused > report.population.scored) {
    throw new Error(
      `text2vis repair: ${String(report.refused)} refusals over a population of ${String(report.population.scored)}`,
    );
  }
  if (report.asked > report.refused) {
    throw new Error(`text2vis repair: ${String(report.asked)} rows asked of ${String(report.refused)} refused rows`);
  }
  if (report.questions > report.asked) {
    throw new Error(`text2vis repair: ${String(report.questions)} questions for ${String(report.asked)} rows asked`);
  }
  if (report.rows.length !== report.questions) {
    throw new Error(`text2vis repair: ${String(report.rows.length)} rows kept and ${String(report.questions)} questions asked`);
  }
  if (report.answered + report.unparsed !== report.asked) {
    throw new Error(
      `text2vis repair: ${String(report.answered)} answered and ${String(report.unparsed)} unreadable over ${String(report.asked)} rows asked`,
    );
  }
  if (report.hits > report.asked || report.tableHits > report.asked) {
    throw new Error(`text2vis repair: ${String(report.hits)} and ${String(report.tableHits)} hits over ${String(report.asked)} rows`);
  }
  if (report.truncated !== 0) {
    throw new Error(
      `text2vis repair: ${String(report.truncated)} replies were cut at the token budget; a cut reply is not an answer, and a repair reading taken over the rows that survived is a share over a population chosen by the cap`,
    );
  }
}

/** The reading as a reader sees it. */
export function describeRepair(report: RepairReport, model = report.model): readonly string[] {
  const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
  const cost = [`    calls ${String(report.cost.calls)}`, `tokens ${String(report.cost.promptTokens)}+${String(report.cost.completionTokens)}`];
  if (report.cost.yuan !== undefined) cost.push(`cost ${formatYuan(report.cost.yuan)}`);
  return [
    `\n  the second question on ${String(report.refused)} refused rows against ${model}`,
    `    repairable ${String(report.asked)} (${String(report.questions)} distinct), answered ${String(report.answered)}, unparsed ${String(report.unparsed)}, truncated ${String(report.truncated)}`,
    `    repaired hits ${String(report.hits)} (${percent(report.hitShare)}), the table's ${String(report.tableHits)} (${percent(report.tableHitShare)})`,
    `    ${cost.join(', ')}, cache ${String(report.cache.hits)} hit / ${String(report.cache.misses)} miss`,
  ];
}

export interface RepairArgs {
  readonly answers: string;
  readonly artifact?: string;
}

/** Parse the command line, refusing anything it does not use — the reason `parseLlmArgs` gives. */
export function parseRepairArgs(argv: readonly string[]): RepairArgs {
  let answers: string | undefined;
  let artifact: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (flag === '--answers' || flag === '--artifact') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a path`);
      if (flag === '--answers') answers = value;
      else artifact = value;
      index += 1;
      continue;
    }
    throw new Error(
      `unknown argument ${flag}: this command asks one second question per refused row and writes the answers, so it takes --answers <path> and --artifact <path>`,
    );
  }
  if (answers === undefined) {
    throw new Error('--answers is required: the refusals are read out of the arm that produced them, not re-derived');
  }
  return { answers, ...(artifact === undefined ? {} : { artifact }) };
}

/** The shape this command reads out of `llm.ts`'s artifact, checked rather than trusted. */
interface Reading {
  readonly corpus?: { readonly roster?: unknown; readonly asked?: unknown };
  readonly arms?: readonly {
    readonly scale?: unknown;
    readonly model?: unknown;
    readonly choices?: unknown;
    readonly products?: unknown;
  }[];
}

/**
 * Where the second question is asked, as the environment states it.
 *
 * A function rather than four `??` expressions inside the command, for the reason `resolveTargets`
 * gives: a default nobody can set is a default nobody can test, and the four here are the difference
 * between a run that costs ¥0.03 and a run that hits the wrong endpoint. `env` is required rather than
 * defaulted, because a command whose fallback is `process.env` has a branch that no test can reach
 * without touching the real environment.
 */
export interface RepairTarget {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly cacheDir: string;
  readonly concurrency: number;
}

/** The variable names `eval/bird/run.ts` already uses, so one set of secrets serves both. */
export function repairTarget(env: Record<string, string | undefined>, model: string): RepairTarget {
  const apiKey = env.LLM_API_KEY ?? env.DEEPSEEK_API_KEY ?? '';
  if (apiKey === '') {
    throw new Error('LLM_API_KEY or DEEPSEEK_API_KEY must be set: the second question is a call, and a repair that asks nothing is a repair nobody made');
  }
  return {
    model,
    baseUrl: env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey,
    // The arm's own store, because a repair answer is an answer to a *request* — the key is the option
    // list — and two stores would make the same question cost twice.
    cacheDir: env.TEXT2VIS_LLM_CACHE ?? 'eval/.cache/text2vis/llm-choices',
    concurrency: Number(env.TEXT2VIS_LLM_CONCURRENCY ?? 6),
  };
}

export interface RepairEntryOptions {
  readonly argv?: readonly string[];
  readonly load?: LoadOptions;
  readonly env: Record<string, string | undefined>;
}

/**
 * The command.
 *
 * Exit 1 for anything that would publish a reading about the wrong population, and for any truncated
 * reply — a repair is one word wide, and a cap that cut one is a cap that should be raised rather
 * than a row that should be scored.
 */
export async function entryRepair(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  options: RepairEntryOptions,
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  try {
    const args = parseRepairArgs(options.argv ?? []);
    const env = options.env;
    const { corpus, source, path } = await loadText2Vis(options.load);
    log(`text2vis: ${source} ${path}`);
    const { rows: scored, dropped } = scoredRows(corpus);
    if (dropped > 0) log(`text2vis repair: ${String(dropped)} rows carry a label no family names and are not part of any population`);
    const { readFile } = await import('node:fs/promises');
    const reading = JSON.parse(await readFile(args.answers, 'utf8')) as Reading;
    const roster = reading.corpus?.roster;
    if (typeof roster !== 'string') {
      throw new Error(`${args.answers} carries no corpus.roster, so the rows its answers were given to cannot be identified`);
    }
    const asked = typeof reading.corpus?.asked === 'number' ? reading.corpus.asked : undefined;
    const rows = asked === undefined ? scored : scored.slice(0, asked);
    // The same population check `ship.ts` makes, for the same reason: a repair over a prefix reported
    // against the whole corpus would compare two row sets without saying so.
    if (roster !== rosterOf(rows)) {
      throw new Error(`${args.answers} answered a different population than the corpus on disk; re-run the arm before repairing it`);
    }
    const marks = (reading.arms ?? []).filter((arm) => arm.scale === 'mark');
    const arm = marks[0];
    if (arm === undefined) throw new Error(`${args.answers} has no mark-scale arm, so there is nothing to repair`);
    const choices = arm.choices;
    if (!Array.isArray(choices) || !choices.every((choice) => choice === null || typeof choice === 'string')) {
      throw new Error(`${args.answers} carries no per-row choices for ${String(arm.model)}, so its refusals cannot be found`);
    }
    // The product's answer per row: what the repair is compared against, and what `ship.ts` would have
    // drawn without it. Computed by the same recommender that draws, never restated.
    const { profileAnswer } = await import('./profile.js');
    const products = rows.map((row) => profileAnswer(row.prompt, row.tableData).mark);
    const target = repairTarget(env, String(arm.model));
    const provider = createHttpProvider({ model: target.model, baseUrl: target.baseUrl, apiKey: target.apiKey });
    const cache = openStore<StoredRow>(target.cacheDir, PROMPT_VERSION, replyOf);
    const report = await runRepair({
      provider,
      rows,
      choices: choices as readonly (string | null)[],
      products,
      cache,
      concurrency: target.concurrency,
      log,
    });
    assertRepair(report);
    if (args.artifact !== undefined) {
      const { mkdir, writeFile, rename } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(args.artifact), { recursive: true });
      await writeFile(`${args.artifact}.part`, `${JSON.stringify(report, null, 2)}\n`);
      await rename(`${args.artifact}.part`, args.artifact);
      log(`text2vis: wrote ${args.artifact}`);
    }
    return 0;
  } catch (error) {
    log(`text2vis: ${messageOf(error)}`);
    return 1;
  }
}

void entryRepair(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`), {
  argv: process.argv.slice(2),
  env: process.env,
}).then((code) => applyExitCode(code, process));
