/**
 * Live NL to SQL evaluation on the DuckDB warehouse fixture.
 *
 * The BIRD numbers are a benchmark; this is the case set we wrote ourselves, on a database
 * we built, with a judge that compares result sets. It exists to answer the two questions a
 * single accuracy figure cannot: does the value metadata lever move anything, and does the
 * repair loop earn its extra calls.
 *
 *   pnpm bench:live              # three arms, three repeats
 *   pnpm bench:live -- --dry-run # validate the cases and the gold, call no model
 *
 * Everything here used to happen at import time: the fixture was executed, the engine was
 * created, the gold statements ran, and the module threw if anything was wrong. That made
 * the file impossible to test and its gates impossible to observe — a broken case and a
 * model failure both produced a non-zero exit and nothing else. The work is now a function
 * of its settings, and `main` is the thin part that owns the exit code.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRunner } from '@agentix-e/nl2charts-core';
import type { Engine } from '@agentix-e/nl2charts-core';
import type { ArmResult, ResultSet } from '@agentix-e/nl2charts-devkit';
import { compareArms, mcnemarExact, sameResult, summarise, wilsonInterval } from '@agentix-e/nl2charts-devkit';
import { createHttpProvider, createPipeline } from '@agentix-e/nl2charts-ai';
import type { LlmProvider } from '@agentix-e/nl2charts-ai';
import { createDuckDbEngine } from '@agentix-e/nl2charts-node';
import { describeError } from '../errors.js';
import { ROOT } from '../run.js';
import { liveCases, liveSchema } from './cases.js';
import type { LiveCase } from './cases.js';

export interface LiveSettings {
  readonly root: string;
  /** The SQL file that builds the warehouse; every case is asked against it. */
  readonly fixture: string;
  readonly out: string;
  readonly dryRun: boolean;
  readonly concurrency: number;
  readonly repeats: number;
  /** How many generated cases to run; 0 means all of them. */
  readonly limit: number;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Accuracy the `samples` arm must reach before the run is worth publishing. */
  readonly floor: number;
  /** How far an arm may fall behind `names` before the run is a regression. */
  readonly tolerance: number;
}

/** One arm of the ablation: the same prompt, one lever apart. */
export interface ArmSpec {
  readonly name: string;
  readonly samples: boolean;
  readonly repairs: number;
}

export const LIVE_ARMS: readonly ArmSpec[] = [
  { name: 'names', samples: false, repairs: 0 },
  { name: 'samples', samples: true, repairs: 0 },
  { name: 'repair', samples: false, repairs: 2 },
];

function nonNegative(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number, got '${raw}'`);
  return value;
}

function positive(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got '${raw}'`);
  return value;
}

export function resolveLiveSettings(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  root: string,
): LiveSettings {
  return {
    root,
    fixture: env.LIVE_FIXTURE ?? join(root, 'eval/fixtures/semantic.sql'),
    out: env.LIVE_OUT ?? join(root, 'eval/out/live-eval.json'),
    dryRun: argv.includes('--dry-run'),
    concurrency: positive(env.LIVE_CONCURRENCY, 6, 'LIVE_CONCURRENCY'),
    repeats: positive(env.LIVE_REPEATS, 3, 'LIVE_REPEATS'),
    // A subset is a real evaluation on fewer intents, not a different one: the same cases, in
    // the order they are generated. CI uses it to prove the path without spending 1,890 calls.
    limit: nonNegative(env.LIVE_LIMIT, 0, 'LIVE_LIMIT'),
    model: env.LLM_MODEL ?? 'deepseek-chat',
    baseUrl: env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey: env.DEEPSEEK_API_KEY ?? env.LLM_API_KEY ?? '',
    floor: 0.5,
    tolerance: 0.05,
  };
}

/** One case's outcome across the repeats. */
export interface LiveCaseRun {
  readonly id: string;
  readonly intent: string;
  readonly question: string;
  readonly passed: boolean;
  readonly predicted: string;
  readonly error?: string;
  readonly passes: readonly boolean[];
}

export interface LiveArmResult {
  /** The paired summary, outcomes included: `compareArms` pairs case by case and needs them. */
  readonly summary: ArmResult;
  readonly arm: string;
  readonly wilson: { low: number; high: number };
  readonly repeats: number;
  readonly flips: number;
  readonly cases: readonly LiveCaseRun[];
  readonly byIntent: Readonly<Record<string, { passed: number; total: number }>>;
}

export interface LiveIo {
  readonly engine: Engine;
  readonly provider: LlmProvider;
  /** The cases to run; the CLI uses the generated set, a test uses as many as it needs. */
  readonly cases?: readonly LiveCase[];
}

/** Statements the fixture builder issues, in order. Empty parts are not statements. */
export function fixtureStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Rows for a statement, or an error the caller can attribute to the case.
 *
 * The runner caps rows: a gold statement returning a million rows and a prediction returning
 * a million rows would be compared cell by cell for no reason, and the cap is what makes the
 * comparison finite.
 */
export type RowsOf = (sql: string) => Promise<ResultSet>;

export function rowsOfFor(engine: Engine): { rowsOf: RowsOf; close: () => Promise<void> } {
  const runner = createRunner({ engine, maxRows: 10_000 });
  return {
    rowsOf: async (sql) => {
      const result = await runner.sql(sql, { limit: 10_000 });
      return { columns: result.columns, rows: result.rows };
    },
    close: () => runner.close(),
  };
}

/**
 * Every gold statement, run before any model is called.
 *
 * A gold query that fails or returns nothing makes every prediction wrong, and the resulting
 * "0%" is a statement about the fixture wearing the costume of a statement about the model.
 */
export async function executeGold(
  rowsOf: RowsOf,
  cases: readonly LiveCase[],
): Promise<Map<string, ResultSet>> {
  const gold = new Map<string, ResultSet>();
  for (const testCase of cases) {
    try {
      const rows = await rowsOf(testCase.goldSql);
      if (rows.rows.length === 0) throw new Error('gold query returned no rows');
      gold.set(testCase.id, rows);
    } catch (error) {
      throw new Error(
        `case ${testCase.id} has a broken gold query: ${describeError(error)}`,
      );
    }
  }
  return gold;
}

/**
 * The harness's own control: an empty result must not match the first case's gold.
 *
 * Returns the number of negative controls that held (always 1 when it does). It used to read
 * `cases[0]` with an `as string` cast, so a run with no cases compared against `undefined`
 * and passed for the wrong reason; the guard is now an error rather than a vacuous pass.
 */
export function negativeControl(gold: ReadonlyMap<string, ResultSet>, cases: readonly LiveCase[], empty: ResultSet): number {
  const first = cases[0];
  if (first === undefined) throw new Error('no cases: a run with nothing to ask has no negative control');
  const goldRows = gold.get(first.id);
  if (goldRows === undefined) throw new Error(`the first case (${first.id}) has no gold result`);
  if (sameResult(empty, goldRows)) {
    throw new Error('negative control failed: an empty result matched a gold result');
  }
  return 1;
}

async function pool<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

export interface LiveArmIo {
  readonly provider: LlmProvider;
  readonly rowsOf: RowsOf;
  readonly gold: ReadonlyMap<string, ResultSet>;
  readonly cases: readonly LiveCase[];
}

export async function runLiveArm(
  spec: ArmSpec,
  settings: LiveSettings,
  io: LiveArmIo,
): Promise<LiveArmResult> {
  const pipeline = createPipeline({
    provider: io.provider,
    samples: spec.samples,
    maxRepairs: spec.repairs,
    execute: async (sql) => {
      await io.rowsOf(sql);
    },
  });
  const runs = await pool(io.cases, settings.concurrency, async (testCase): Promise<LiveCaseRun> => {
    const passes: boolean[] = [];
    let lastSql = '';
    let lastError: string | undefined;
    for (let attempt = 0; attempt < settings.repeats; attempt += 1) {
      try {
        const { sql } = await pipeline.ask({ question: testCase.question, schema: liveSchema as never });
        lastSql = sql;
        const predicted = await io.rowsOf(sql);
        passes.push(sameResult(predicted, io.gold.get(testCase.id) as ResultSet));
        lastError = undefined;
      } catch (error) {
        passes.push(false);
        lastError = describeError(error);
      }
    }
    return {
      id: testCase.id,
      intent: testCase.intent,
      question: testCase.question,
      passed: passes.filter(Boolean).length > settings.repeats / 2,
      predicted: lastSql,
      ...(lastError === undefined ? {} : { error: lastError }),
      passes,
    };
  });
  const summary = summarise(
    spec.name,
    runs.map((run) => ({ id: run.id, passed: run.passed })),
  );
  const byIntent: Record<string, { passed: number; total: number }> = {};
  for (const run of runs) {
    const bucket = (byIntent[run.intent] ??= { passed: 0, total: 0 });
    bucket.total += 1;
    if (run.passed) bucket.passed += 1;
  }
  return {
    arm: spec.name,
    summary,
    wilson: wilsonInterval(summary.passed, summary.total),
    repeats: settings.repeats,
    flips: runs.filter((run) => new Set(run.passes).size > 1).length,
    cases: runs,
    byIntent,
  };
}

export interface LiveOutcome {
  readonly report: Record<string, unknown>;
  readonly results: readonly LiveArmResult[];
  readonly gold: number;
  readonly controls: { readonly oracle: number; readonly empty: number };
}

/** The artifact, in the shape the dashboards and the docs already read. */
export function liveReport(settings: LiveSettings, outcome: LiveOutcome, cases: readonly LiveCase[]): Record<string, unknown> {
  const arm = (name: string): LiveArmResult => {
    const found = outcome.results.find((result) => result.arm === name);
    if (found === undefined) throw new Error(`the run has no '${name}' arm to pair`);
    return found;
  };
  const names = arm('names').summary;
  const valueEffect = compareArms(names, arm('samples').summary);
  const repairEffect = compareArms(names, arm('repair').summary);
  return {
    generatedAt: new Date().toISOString(),
    dataset: 'eval/live/cases.ts',
    model: settings.model,
    cases: cases.length,
    gold: outcome.gold,
    controls: outcome.controls,
    arms: outcome.results.map((result) => ({
      arm: result.arm,
      passed: result.summary.passed,
      total: result.summary.total,
      accuracy: result.summary.accuracy,
      wilson: result.wilson,
      repeats: result.repeats,
      flips: result.flips,
      byIntent: result.byIntent,
    })),
    ablations: {
      valueProfiling: { ...valueEffect, p: mcnemarExact(valueEffect.onlyFirst, valueEffect.onlySecond) },
      repair: { ...repairEffect, p: mcnemarExact(repairEffect.onlyFirst, repairEffect.onlySecond) },
    },
    failures: Object.fromEntries(
      outcome.results.map((result) => [
        result.arm,
        result.cases
          .filter((run) => !run.passed)
          .map((run) => ({
            id: run.id,
            intent: run.intent,
            question: run.question,
            predicted: run.predicted,
            error: run.error,
          })),
      ]),
    ),
  };
}

/**
 * The three claims the run is only worth publishing if they hold.
 *
 * Returned rather than thrown: the artifact is written before this is called, and a wall of
 * exceptions on top of a readable report is worse than three sentences naming what failed.
 */
export function liveGate(settings: LiveSettings, results: readonly LiveArmResult[]): string[] {
  const arm = (name: string): LiveArmResult | undefined => results.find((result) => result.arm === name);
  const names = arm('names');
  const samples = arm('samples');
  const repair = arm('repair');
  const problems: string[] = [];
  if (names === undefined || samples === undefined || repair === undefined) {
    // Without all three there is no ablation, and a subset would silently compare the run to
    // itself.
    return [`the run is missing an arm: it has ${results.map((result) => result.arm).join(', ')}`];
  }
  if (samples.summary.accuracy < settings.floor) {
    problems.push(
      `live accuracy ${(samples.summary.accuracy * 100).toFixed(1)}% is below the ${String(settings.floor * 100)}% floor`,
    );
  }
  if (samples.summary.accuracy < names.summary.accuracy - settings.tolerance) {
    problems.push('schema samples regressed accuracy by more than 5pp');
  }
  if (repair.summary.accuracy < names.summary.accuracy - settings.tolerance) {
    problems.push('the repair loop regressed accuracy by more than 5pp');
  }
  return problems;
}

/**
 * Build the warehouse, run every gold statement, and hand back the reader.
 *
 * One function because there are two callers that must not disagree about what "the cases
 * are valid" means: the dry run and the real run. Two copies of this drifted apart the first
 * time someone edited one of them.
 */
export interface OpenedFixture {
  readonly rowsOf: RowsOf;
  readonly gold: ReadonlyMap<string, ResultSet>;
  readonly cases: readonly LiveCase[];
  readonly empty: ResultSet;
  close(): Promise<void>;
}

export async function openFixture(settings: LiveSettings, engine: Engine, cases: readonly LiveCase[]): Promise<OpenedFixture> {
  if (cases.length === 0) throw new Error('no cases: the live evaluation has nothing to ask');
  const { rowsOf, close } = rowsOfFor(engine);
  try {
    const fixture = readFileSync(settings.fixture, 'utf8');
    for (const statement of fixtureStatements(fixture)) await engine.run(statement);
    const gold = await executeGold(rowsOf, cases);
    const empty = await rowsOf('select 1 as x where false');
    return { rowsOf, gold, cases, empty, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The cases this run will ask: the whole generated set, or its first `limit`. */
export function selectCases(settings: LiveSettings): readonly LiveCase[] {
  const all = liveCases();
  return settings.limit > 0 ? all.slice(0, settings.limit) : all;
}

export async function runLive(settings: LiveSettings, io: LiveIo): Promise<LiveOutcome> {
  const cases = io.cases ?? selectCases(settings);
  const opened = await openFixture(settings, io.engine, cases);
  try {
    // The control runs before the arms, so a judge that called an empty result a match stops
    // the run instead of inflating it.
    const controls = { oracle: 1, empty: 1 - negativeControl(opened.gold, cases, opened.empty) };
    const results: LiveArmResult[] = [];
    for (const spec of LIVE_ARMS) {
      results.push(await runLiveArm(spec, settings, { provider: io.provider, rowsOf: opened.rowsOf, gold: opened.gold, cases }));
    }
    const outcome: LiveOutcome = { report: {}, results, gold: opened.gold.size, controls };
    return { ...outcome, report: liveReport(settings, outcome, cases) };
  } finally {
    await opened.close();
  }
}

/** The lines the workflow log shows. */
export function liveLines(outcome: LiveOutcome): string[] {
  const lines: string[] = [];
  for (const result of outcome.results) {
    lines.push(
      `[${result.arm}] exact ${(result.summary.accuracy * 100).toFixed(1)}% ` +
        `(${String(result.summary.passed)}/${String(result.summary.total)})  ` +
        `Wilson [${(result.wilson.low * 100).toFixed(1)}, ${(result.wilson.high * 100).toFixed(1)}]`,
    );
    for (const [intent, bucket] of Object.entries(result.byIntent).sort()) {
      if (bucket.passed < bucket.total) lines.push(`  ${intent.padEnd(32)} ${String(bucket.passed)}/${String(bucket.total)}`);
    }
    lines.push(
      `  repeats per case: ${String(result.repeats)}; cases with a different outcome across repeats: ${String(result.flips)}`,
    );
  }
  const line = (
    label: string,
    other: string,
    effect: { delta: number; onlyFirst: number; onlySecond: number },
  ): string =>
    `${label} ${(effect.delta * 100).toFixed(1)}pp (only names ${String(effect.onlyFirst)}, ` +
    `only ${other} ${String(effect.onlySecond)}, ` +
    `p=${mcnemarExact(effect.onlyFirst, effect.onlySecond).toFixed(4)})`;
  const names = outcome.results.find((result) => result.arm === 'names')?.summary;
  const samples = outcome.results.find((result) => result.arm === 'samples')?.summary;
  const repair = outcome.results.find((result) => result.arm === 'repair')?.summary;
  if (names !== undefined && samples !== undefined) lines.push(line('value profiling:', 'samples', compareArms(names, samples)));
  if (names !== undefined && repair !== undefined) lines.push(line('repair loop:   ', 'repair', compareArms(names, repair)));
  return lines;
}

export async function main(
  env: Readonly<Record<string, string | undefined>> = process.env,
  argv: readonly string[] = process.argv.slice(2),
  root: string = ROOT,
): Promise<number> {
  const settings = resolveLiveSettings(env, argv, root);
  const engine = await createDuckDbEngine();
  try {
    if (settings.dryRun) {
      // The gold statements are the whole content of a dry run: they are what a broken case
      // breaks, and running them here is the only way to know the case set is intact.
      const opened = await openFixture(settings, engine, selectCases(settings));
      try {
        console.log(`live eval: ${String(opened.cases.length)} cases, ${String(opened.gold.size)} gold queries executed`);
        console.log('dry run: cases and gold queries are valid; no model was called');
      } finally {
        await opened.close();
      }
      return 0;
    }
    if (settings.apiKey.length === 0) {
      throw new Error('DEEPSEEK_API_KEY is required for the live evaluation');
    }
    const provider = createHttpProvider({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      timeoutMs: 60_000,
    });
    const outcome = await runLive(settings, { engine, provider });
    mkdirSync(dirname(settings.out), { recursive: true });
    writeFileSync(settings.out, `${JSON.stringify(outcome.report, null, 2)}\n`);
    for (const line of liveLines(outcome)) console.log(line);
    console.log(`wrote ${settings.out}`);
    const problems = liveGate(settings, outcome.results);
    for (const problem of problems) console.error(`GATE FAILED: ${problem}`);
    return problems.length === 0 ? 0 : 1;
  } finally {
    await engine.close();
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
