/**
 * The in-repository harness: four predictors bracketing the scale on a 20-case golden set.
 *
 * The oracle scores 100% and the empty predictor 0%, or nothing else in this file means
 * anything — that is what makes the harness's own ability to tell right from wrong a
 * measurement rather than an assumption. The two template predictors sit between them and
 * are the subject of the normalization ablation.
 *
 * The report is separated from the printing so a test can make the same measurement the
 * benchmark makes, against the same fixture database, and read the numbers instead of the
 * log they used to leave behind.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createRunner } from '@agentix-e/nl2charts-core';
import type { Runner } from '@agentix-e/nl2charts-core';
import { canonicalRow } from '@agentix-e/nl2charts-core';
import { createDuckDbEngine } from '@agentix-e/nl2charts-node';
import { describeError } from './errors.js';
import { predict } from './baseline.js';
import type { GoldenCase } from './baseline.js';

export interface CaseOutcome {
  readonly id: string;
  readonly ok: boolean;
  readonly exact: boolean;
  readonly unordered: boolean;
  readonly error?: string;
  readonly predicted: string;
}

export interface RunSummary {
  readonly predictor: string;
  readonly total: number;
  readonly passed: number;
  readonly accuracy: number;
  readonly unorderedAccuracy: number;
  readonly byTag: Record<string, { total: number; passed: number }>;
  readonly cases: CaseOutcome[];
}

export const ROOT = new URL('..', import.meta.url).pathname;

export function loadGolden(): GoldenCase[] {
  const text = readFileSync(join(ROOT, 'eval/golden.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as GoldenCase);
}

/** A fresh DuckDB with the golden fixture loaded, torn down however the body ends. */
export async function withFixture<T>(fn: (runner: Runner, engine: Awaited<ReturnType<typeof createDuckDbEngine>>) => Promise<T>): Promise<T> {
  const engine = await createDuckDbEngine();
  try {
    await engine.run(readFileSync(join(ROOT, 'eval/fixtures.sql'), 'utf8'));
    const runner = createRunner({ engine, maxRows: 10_000 });
    return await fn(runner, engine);
  } finally {
    await engine.close();
  }
}

function unorderedKey(rows: readonly Readonly<Record<string, unknown>>[]): string {
  return rows
    .map((row) => JSON.stringify(canonicalRow(row)))
    .sort()
    .join('\n');
}

/**
 * Score one statement against one gold statement.
 *
 * A statement that does not run is a case, not an exception: the harness has to be able to
 * report "the predictor produced SQL the engine refused" without losing the other nineteen
 * cases. Splitting it out is also what makes the failure path reachable — no predictor in
 * this repository emits invalid SQL, so the branch was previously dead code that would
 * have thrown on its first real use.
 */
export async function evaluateCase(runner: Runner, testCase: GoldenCase, predicted: string): Promise<CaseOutcome> {
  try {
    const [gold, actual] = await Promise.all([runner.sql(testCase.goldSql, { limit: 10_000 }), runner.sql(predicted, { limit: 10_000 })]);
    const unordered = unorderedKey(gold.rows) === unorderedKey(actual.rows);
    // Exact means "the same rows in the same order, and the same count": the unordered key
    // alone collapses duplicates, which is the judge difference the harness exists to show.
    const exact = unordered && gold.rows.length === actual.rows.length;
    return { id: testCase.id, ok: exact, exact, unordered, predicted };
  } catch (error) {
    return {
      id: testCase.id,
      ok: false,
      exact: false,
      unordered: false,
      error: describeError(error),
      predicted,
    };
  }
}

/** Rates and per-tag buckets over a set of outcomes. Pure, so an empty set is testable. */
export function summarise(predictor: string, cases: readonly GoldenCase[], outcomes: readonly CaseOutcome[]): RunSummary {
  const byTag: Record<string, { total: number; passed: number }> = {};
  for (const testCase of cases) {
    const outcome = outcomes.find((entry) => entry.id === testCase.id);
    for (const tag of testCase.tags) {
      const bucket = byTag[tag] ?? { total: 0, passed: 0 };
      bucket.total += 1;
      if (outcome?.exact === true) bucket.passed += 1;
      byTag[tag] = bucket;
    }
  }
  const passed = outcomes.filter((outcome) => outcome.exact).length;
  const unorderedPassed = outcomes.filter((outcome) => outcome.unordered).length;
  return {
    predictor,
    total: outcomes.length,
    passed,
    accuracy: outcomes.length === 0 ? 0 : passed / outcomes.length,
    unorderedAccuracy: outcomes.length === 0 ? 0 : unorderedPassed / outcomes.length,
    byTag,
    cases: [...outcomes],
  };
}

export async function runPredictor(predictor: 'oracle' | 'empty' | 'template' | 'template-raw'): Promise<RunSummary> {
  const cases = loadGolden();
  const outcomes: CaseOutcome[] = [];
  await withFixture(async (runner) => {
    for (const testCase of cases) {
      outcomes.push(await evaluateCase(runner, testCase, predict(predictor, testCase)));
    }
  });
  return summarise(predictor, cases, outcomes);
}

/**
 * The two controls, checked in one place.
 *
 * An oracle below 100% means the judge or the fixture is broken; an empty predictor above
 * 0% means the judge matches anything. Every accuracy below them is then a number about the
 * fixture rather than about a predictor, which is why both callers refuse to publish.
 */
export function assertControls(summaries: readonly RunSummary[]): { readonly oracle: number; readonly empty: number } {
  const oracle = summaries.find((summary) => summary.predictor === 'oracle');
  const empty = summaries.find((summary) => summary.predictor === 'empty');
  if (oracle === undefined || empty === undefined) throw new Error('the harness has no oracle and empty control to check');
  if (oracle.accuracy !== 1) throw new Error('positive control failed: the oracle must score 100%');
  if (empty.accuracy !== 0) throw new Error('negative control failed: the empty predictor must score 0%');
  return { oracle: oracle.accuracy, empty: empty.accuracy };
}

export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** The number of distinct predictors the harness measures, exported so callers stop guessing. */
export const PREDICTORS = ['oracle', 'empty', 'template-raw', 'template'] as const;

/**
 * One line per miss, with the engine's sentence when there is one.
 *
 * A function rather than an inline template because the two halves of the interpolation have
 * different inputs: the predictors in this harness all miss with valid SQL, so the half that
 * prints an error message was a branch that only a broken case can reach — and a broken case
 * is exactly what a reader of the log is looking for.
 */
export function missLine(outcome: CaseOutcome): string {
  return `  MISS ${outcome.id}${outcome.error === undefined ? '' : ` (${outcome.error})`}`;
}

export interface HarnessPayload {
  readonly generatedAt: string;
  readonly harness: string;
  readonly controls: { readonly oracle: number; readonly empty: number };
  readonly summaries: readonly (Omit<RunSummary, 'cases'> & { readonly failures: string[] })[];
}

export interface HarnessResult {
  readonly summaries: RunSummary[];
  readonly payload: HarnessPayload;
}

/**
 * Run every predictor, refuse to report if the controls do not hold, and hand back the
 * artifact that `ablate.ts` reads.
 *
 * The controls are checked here rather than in the caller: an oracle that scores below
 * 100% means the judge or the fixture is broken, and every accuracy below it is then a
 * number about the fixture, not about a predictor.
 */
export async function runHarness(options: { readonly outDir?: string; readonly log?: (line: string) => void } = {}): Promise<HarnessResult> {
  const summaries: RunSummary[] = [];
  for (const predictor of PREDICTORS) {
    const summary = await runPredictor(predictor);
    summaries.push(summary);
    options.log?.(`\n[${summary.predictor}] exact=${pct(summary.accuracy)} unordered=${pct(summary.unorderedAccuracy)} (${summary.passed}/${summary.total})`);
    for (const [tag, bucket] of Object.entries(summary.byTag).sort()) {
      options.log?.(`  ${tag.padEnd(10)} ${bucket.passed}/${bucket.total}`);
    }
    for (const outcome of summary.cases) {
      if (!outcome.exact) options.log?.(missLine(outcome));
    }
  }

  const controls = assertControls(summaries);

  const payload: HarnessPayload = {
    generatedAt: new Date().toISOString(),
    harness: 'eval/run.ts',
    controls,
    summaries: summaries.map(({ cases, ...rest }) => ({ ...rest, failures: cases.filter((entry) => !entry.exact).map((entry) => entry.id) })),
  };
  const outDir = options.outDir ?? join(ROOT, 'eval/out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(payload, null, 2)}\n`);
  options.log?.('\nharness: controls hold (oracle 100%, empty 0%); wrote results.json');
  return { summaries, payload };
}

export async function main(options: { readonly outDir?: string } = {}): Promise<number> {
  await runHarness({ ...options, log: (line) => console.log(line) });
  return 0;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
