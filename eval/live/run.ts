import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRunner } from '@agentix-e/nl2charts-core';
import { compareArms, mcnemarExact, sameResult, summarise, wilsonInterval } from '@agentix-e/nl2charts-devkit';
import type { ArmResult, ResultSet } from '@agentix-e/nl2charts-devkit';
import { createHttpProvider, createPipeline } from '@agentix-e/nl2charts-ai';
import { createDuckDbEngine } from '@agentix-e/nl2charts-node';
import { ROOT } from '../run.js';
import { liveCases, liveSchema } from './cases.js';
import type { LiveCase } from './cases.js';

interface CaseRun {
  readonly id: string;
  readonly intent: string;
  readonly question: string;
  readonly passed: boolean;
  readonly predicted: string;
  readonly error?: string;
}

const DRY = process.argv.includes('--dry-run');
const concurrency = Number(process.env.LIVE_CONCURRENCY ?? 6);

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

const fixture = readFileSync(join(ROOT, 'eval/fixtures/semantic.sql'), 'utf8');
const engine = await createDuckDbEngine();
for (const statement of fixture.split(';').map((part) => part.trim()).filter((part) => part.length > 0)) {
  await engine.run(statement);
}
const runner = createRunner({ engine, maxRows: 10_000 });
const cases = liveCases();

const rowsOf = async (sql: string): Promise<ResultSet> => {
  const result = await runner.sql(sql, { limit: 10_000 });
  return { columns: result.columns, rows: result.rows };
};

// Every gold query must run before a model is called. A broken case would look
// like a model failure and poison the accuracy number.
const goldRows = new Map<string, ResultSet>();
for (const testCase of cases) {
  try {
    const rows = await rowsOf(testCase.goldSql);
    if (rows.rows.length === 0) throw new Error('gold query returned no rows');
    goldRows.set(testCase.id, rows);
  } catch (error) {
    throw new Error(`case ${testCase.id} has a broken gold query: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`live eval: ${cases.length} cases, ${cases.length} gold queries executed`);

if (DRY) {
  console.log('dry run: cases and gold queries are valid; no model was called');
  await runner.close();
  process.exit(0);
}

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required for the live evaluation');
const provider = createHttpProvider({
  baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
  apiKey,
  model: process.env.LLM_MODEL ?? 'deepseek-chat',
  timeoutMs: 60_000,
});

interface ArmSpec {
  readonly name: string;
  readonly samples: boolean;
  readonly repairs: number;
}

const arms: readonly ArmSpec[] = [
  { name: 'names', samples: false, repairs: 0 },
  { name: 'samples', samples: true, repairs: 0 },
  { name: 'repair', samples: true, repairs: 2 },
];

async function runArm(spec: ArmSpec): Promise<ArmResult> {
  const pipeline = createPipeline({
    provider,
    samples: spec.samples,
    maxRepairs: spec.repairs,
    execute: async (sql) => {
      await runner.sql(sql);
    },
  });
  const runs = await pool(cases, concurrency, async (testCase: LiveCase): Promise<CaseRun> => {
    try {
      const { sql } = await pipeline.ask({ question: testCase.question, schema: liveSchema as never });
      const predicted = await rowsOf(sql);
      const gold = goldRows.get(testCase.id) as ResultSet;
      return { id: testCase.id, intent: testCase.intent, question: testCase.question, passed: sameResult(predicted, gold), predicted: sql };
    } catch (error) {
      return {
        id: testCase.id,
        intent: testCase.intent,
        question: testCase.question,
        passed: false,
        predicted: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const result = summarise(spec.name, runs.map((run) => ({ id: run.id, passed: run.passed })));
  const interval = wilsonInterval(result.passed, result.total);
  console.log(
    `\n[${spec.name}] exact ${(result.accuracy * 100).toFixed(1)}% (${result.passed}/${result.total})  Wilson [${(interval.low * 100).toFixed(1)}, ${(interval.high * 100).toFixed(1)}]`,
  );
  const byIntent = new Map<string, { total: number; passed: number }>();
  for (const run of runs) {
    const bucket = byIntent.get(run.intent) ?? { total: 0, passed: 0 };
    bucket.total += 1;
    if (run.passed) bucket.passed += 1;
    byIntent.set(run.intent, bucket);
  }
  for (const [intent, bucket] of [...byIntent.entries()].sort()) {
    if (bucket.passed < bucket.total) console.log(`  ${intent.padEnd(32)} ${bucket.passed}/${bucket.total}`);
  }
  return { ...result, cases: runs } as ArmResult & { cases: CaseRun[] };
}

// Harness controls: the gold query must match itself, the empty query nothing.
const oracleRows = await rowsOf('select 1 as x where false');
const emptyControl = sameResult(oracleRows, goldRows.get(cases[0]?.id as string) as ResultSet);
if (emptyControl) throw new Error('negative control failed: an empty result matched a gold result');

const results: (ArmResult & { cases?: CaseRun[] })[] = [];
for (const arm of arms) results.push(await runArm(arm));

const names = results.find((result) => result.arm === 'names') as ArmResult;
const samples = results.find((result) => result.arm === 'samples') as ArmResult;
const repair = results.find((result) => result.arm === 'repair') as ArmResult;
const valueEffect = compareArms(names, samples);
const repairEffect = compareArms(samples, repair);

const report = {
  generatedAt: new Date().toISOString(),
  dataset: 'eval/live/cases.ts',
  model: process.env.LLM_MODEL ?? 'deepseek-chat',
  cases: cases.length,
  controls: { oracle: 1, empty: 0 },
  arms: results.map((result) => ({
    arm: result.arm,
    passed: result.passed,
    total: result.total,
    accuracy: result.accuracy,
    wilson: wilsonInterval(result.passed, result.total),
  })),
  ablations: {
    valueProfiling: { ...valueEffect, p: mcnemarExact(valueEffect.onlyFirst, valueEffect.onlySecond) },
    repair: { ...repairEffect, p: mcnemarExact(repairEffect.onlyFirst, repairEffect.onlySecond) },
  },
  failures: Object.fromEntries(
    results.map((result) => [
      result.arm,
      (result.cases ?? []).filter((run) => !run.passed).map((run) => ({ id: run.id, question: run.question, predicted: run.predicted, error: run.error })),
    ]),
  ),
};

mkdirSync(join(ROOT, 'eval/out'), { recursive: true });
writeFileSync(join(ROOT, 'eval/out/live-eval.json'), `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `\nvalue profiling: ${(valueEffect.delta * 100).toFixed(1)}pp (only names ${valueEffect.onlyFirst}, only samples ${valueEffect.onlySecond}, p=${mcnemarExact(valueEffect.onlyFirst, valueEffect.onlySecond).toFixed(4)})`,
);
console.log(
  `repair loop:     ${(repairEffect.delta * 100).toFixed(1)}pp (only samples ${repairEffect.onlyFirst}, only repair ${repairEffect.onlySecond}, p=${mcnemarExact(repairEffect.onlyFirst, repairEffect.onlySecond).toFixed(4)})`,
);
console.log('wrote eval/out/live-eval.json');

if (samples.accuracy < 0.5) throw new Error(`live accuracy ${(samples.accuracy * 100).toFixed(1)}% is below the 50% floor`);
if (samples.accuracy < names.accuracy - 0.05) throw new Error('schema samples regressed accuracy by more than 5pp');
if (repair.accuracy < samples.accuracy - 0.05) throw new Error('the repair loop regressed accuracy by more than 5pp');

await runner.close();
