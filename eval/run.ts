import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from '@agentix-e/nl2charts-core';
import type { Runner } from '@agentix-e/nl2charts-core';
import { canonicalRow } from '@agentix-e/nl2charts-core';
import { createDuckDbEngine } from '@agentix-e/nl2charts-node';
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

export async function withFixture<T>(fn: (runner: Runner, engine: Awaited<ReturnType<typeof createDuckDbEngine>>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'nl2c-eval-'));
  const engine = await createDuckDbEngine();
  try {
    await engine.run(readFileSync(join(ROOT, 'eval/fixtures.sql'), 'utf8'));
    const runner = createRunner({ engine, maxRows: 10_000 });
    return await fn(runner, engine);
  } finally {
    await engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function unorderedKey(rows: readonly Readonly<Record<string, unknown>>[]): string {
  return rows
    .map((row) => JSON.stringify(canonicalRow(row)))
    .sort()
    .join('\n');
}

export async function runPredictor(predictor: 'oracle' | 'empty' | 'template' | 'template-raw'): Promise<RunSummary> {
  const cases = loadGolden();
  const outcomes: CaseOutcome[] = [];
  await withFixture(async (runner) => {
    for (const testCase of cases) {
      const predicted = predict(predictor, testCase);
      try {
        const [gold, actual] = await Promise.all([runner.sql(testCase.goldSql, { limit: 10_000 }), runner.sql(predicted, { limit: 10_000 })]);
        const exact = unorderedKey(gold.rows) === unorderedKey(actual.rows) && gold.rows.length === actual.rows.length;
        const unordered = unorderedKey(gold.rows) === unorderedKey(actual.rows);
        outcomes.push({ id: testCase.id, ok: exact, exact, unordered, predicted });
      } catch (error) {
        outcomes.push({
          id: testCase.id,
          ok: false,
          exact: false,
          unordered: false,
          error: error instanceof Error ? error.message : String(error),
          predicted,
        });
      }
    }
  });

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
    cases: outcomes,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printSummary(summary: RunSummary): void {
  console.log(`\n[${summary.predictor}] exact=${pct(summary.accuracy)} unordered=${pct(summary.unorderedAccuracy)} (${summary.passed}/${summary.total})`);
  for (const [tag, bucket] of Object.entries(summary.byTag).sort()) {
    console.log(`  ${tag.padEnd(10)} ${bucket.passed}/${bucket.total}`);
  }
  for (const outcome of summary.cases) {
    if (!outcome.exact) console.log(`  MISS ${outcome.id}${outcome.error ? ` (${outcome.error})` : ''}`);
  }
}

async function main(): Promise<void> {
  const predictors = ['oracle', 'empty', 'template-raw', 'template'] as const;
  const summaries: RunSummary[] = [];
  for (const predictor of predictors) {
    const summary = await runPredictor(predictor);
    summaries.push(summary);
    printSummary(summary);
  }

  const oracle = summaries.find((summary) => summary.predictor === 'oracle');
  const empty = summaries.find((summary) => summary.predictor === 'empty');
  if (oracle?.accuracy !== 1) throw new Error('positive control failed: the oracle must score 100%');
  if (empty?.accuracy !== 0) throw new Error('negative control failed: the empty predictor must score 0%');

  mkdirSync(join(ROOT, 'eval/out'), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    harness: 'eval/run.ts',
    controls: { oracle: oracle.accuracy, empty: empty.accuracy },
    summaries: summaries.map(({ cases, ...rest }) => ({ ...rest, failures: cases.filter((entry) => !entry.exact).map((entry) => entry.id) })),
  };
  writeFileSync(join(ROOT, 'eval/out/results.json'), `${JSON.stringify(payload, null, 2)}\n`);
  console.log('\nharness: controls hold (oracle 100%, empty 0%); wrote eval/out/results.json');
}

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  await main();
}
