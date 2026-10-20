/**
 * Adversarial evaluation: the four shapes an aggregate score hides.
 *
 * Runs the hand-written cases in `cases.ts` through the same execution oracle and
 * judge as the BIRD run, on two arms (names only, and with column metadata) so
 * the question "does the metadata lever also work on hard shapes?" gets a number
 * instead of an opinion.
 *
 *   pnpm bench:adversarial
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHttpProvider, createPipeline } from '@agentix-e/nl2charts-ai';
import type { PromptOptions, SchemaTable } from '@agentix-e/nl2charts-ai';
import { compareArms, judgeOfficial, judgeStrict, mcnemarExact, summarise, wilsonInterval } from '@agentix-e/nl2charts-devkit';
import { buildSchema, loadDescriptions, loadTables } from '../bird/data.js';
import { createOracle } from '../bird/oracle.js';
import { pool } from '../bird/run.js';
import type { Arm } from '../bird/run.js';
import { CASES } from './cases.js';
import type { Category } from './cases.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const DATA = process.env.BIRD_DATA ?? join(ROOT, 'eval/.cache/bird/minidev/MINIDEV');
const DATABASES = process.env.BIRD_DATABASES ?? join(DATA, 'dev_databases');
const CONCURRENCY = Number(process.env.BIRD_CONCURRENCY ?? 6);

const ARMS: readonly Arm[] = [
  { name: 'names', notes: false, evidence: false, repairs: 0, linking: true },
  { name: 'metadata', notes: true, evidence: false, repairs: 0, linking: true },
];

function promptFor(arm: Arm): PromptOptions {
  return {
    dialect: 'SQLite',
    descriptions: arm.notes,
    foreignKeys: arm.notes,
    samples: false,
    schemaLines: 2000,
  };
}

async function main() {
  const tables = loadTables(join(DATA, 'dev_tables.json'));
  const dbs = [...new Set(CASES.map((testCase) => testCase.db))];
  const schemas = new Map<string, SchemaTable[]>();
  for (const db of dbs) {
    const table = tables.get(db);
    if (table === undefined) throw new Error(`dev_tables.json has no entry for ${db}`);
    schemas.set(
      db,
      buildSchema(table, loadDescriptions(join(DATA, 'dev_databases', db, 'database_description'), table.tableNames), {
        withNotes: true,
      }),
    );
  }

  const oracle = createOracle(join(ROOT, 'eval/bird/oracle.py'), DATABASES);

  // Gold first. A case whose gold fails or returns nothing is a defect in this
  // file and stops the run: an empty gold makes every prediction wrong and every
  // "0%" unreadable.
  const gold = new Map<string, readonly (readonly unknown[])[]>();
  const broken: { id: string; error: string }[] = [];
  for (const testCase of CASES) {
    const result = await oracle.run(testCase.db, testCase.sql);
    if (!result.ok) broken.push({ id: testCase.id, error: result.error ?? 'failed' });
    else if (result.rows.length === 0) broken.push({ id: testCase.id, error: 'gold returned no rows' });
    else gold.set(testCase.id, result.rows);
  }
  if (broken.length > 0) {
    console.error(`gold problems: ${broken.map((entry) => `${entry.id} (${entry.error})`).join(', ')}`);
    process.exitCode = 1;
    await oracle.close();
    return;
  }

  const provider = createHttpProvider({
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'deepseek-chat',
  });

  const outcomes = new Map<string, { id: string; passed: boolean }[]>();
  const armReports: unknown[] = [];
  for (const arm of ARMS) {
    const runs = await pool(CASES, CONCURRENCY, async (testCase) => {
      const schema = schemas.get(testCase.db) as SchemaTable[];
      const pipeline = createPipeline({ provider, maxRepairs: arm.repairs, linking: arm.linking, prompt: promptFor(arm) });
      try {
        const asked = await pipeline.ask({ question: testCase.question, schema });
        const predicted = await oracle.run(testCase.db, asked.sql);
        const passed =
          predicted.ok &&
          judgeOfficial(gold.get(testCase.id) as readonly (readonly unknown[])[], predicted.rows) === 'match';
        return {
          id: testCase.id,
          passed,
          strict: predicted.ok && judgeStrict(gold.get(testCase.id) as readonly (readonly unknown[])[], predicted.rows) === 'match',
          sql: asked.sql,
          ...(predicted.ok ? {} : { error: predicted.error }),
        };
      } catch (error) {
        return { id: testCase.id, passed: false, strict: false, sql: '', error: error instanceof Error ? error.message : String(error) };
      }
    });
    outcomes.set(arm.name, runs);
    const summary = summarise(arm.name, runs);
    const byCategory: Record<string, { passed: number; total: number }> = {};
    for (const testCase of CASES) {
      const run = runs.find((entry) => entry.id === testCase.id);
      const bucket = (byCategory[testCase.category] ??= { passed: 0, total: 0 });
      bucket.total += 1;
      if (run?.passed === true) bucket.passed += 1;
    }
    armReports.push({
      arm: arm.name,
      passed: summary.passed,
      total: summary.total,
      accuracy: summary.accuracy,
      wilson: wilsonInterval(summary.passed, summary.total),
      strictPassed: runs.filter((entry) => entry.strict).length,
      executionErrors: runs.filter((entry) => entry.error !== undefined).length,
      byCategory,
    });
    console.log(
      `${arm.name.padEnd(9)} ${summary.passed}/${summary.total}  ${(summary.accuracy * 100).toFixed(1)}%  ${JSON.stringify(byCategory)}`,
    );
  }

  const first = outcomes.get(ARMS[0]?.name as string) as { id: string; passed: boolean }[];
  const second = outcomes.get(ARMS[1]?.name as string) as { id: string; passed: boolean }[];
  const comparison = compareArms(summarise('names', first), summarise('metadata', second));
  const categories: Category[] = ['window', 'ratio', 'multi-hop', 'tie'];
  const perCategory: Record<string, unknown> = {};
  for (const category of categories) {
    const ids = CASES.filter((testCase) => testCase.category === category).map((testCase) => testCase.id);
    const before = ids.filter((id) => first.find((entry) => entry.id === id)?.passed === true).length;
    const after = ids.filter((id) => second.find((entry) => entry.id === id)?.passed === true).length;
    perCategory[category] = { cases: ids.length, names: before, metadata: after, delta: after - before };
  }

  const report = {
    dataset: 'hand-written adversarial cases',
    databases: dbs,
    model: process.env.LLM_MODEL ?? 'deepseek-chat',
    generatedAt: new Date().toISOString(),
    cases: CASES.length,
    gold: { runnable: gold.size, broken },
    arms: armReports,
    ablations: {
      'names -> metadata': {
        delta: comparison.delta,
        onlyFirst: comparison.onlyFirst,
        onlySecond: comparison.onlySecond,
        p: mcnemarExact(comparison.onlyFirst, comparison.onlySecond),
      },
    },
    perCategory,
    failures: Object.fromEntries(
      [...outcomes.entries()].map(([name, runs]) => [
        name,
        runs.filter((entry) => !entry.passed).map((entry) => ({
          id: entry.id,
          question: CASES.find((testCase) => testCase.id === entry.id)?.question,
          sql: (entry as { sql?: string }).sql,
          error: (entry as { error?: string }).error,
        })),
      ]),
    ),
  };

  mkdirSync(join(ROOT, 'eval/out'), { recursive: true });
  writeFileSync(join(ROOT, 'eval/out/adversarial.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`artifact: eval/out/adversarial.json; gold ${gold.size}/${CASES.length}`);
  await oracle.close();

  const best = Math.max(...(armReports as { accuracy: number }[]).map((arm) => arm.accuracy));
  if (best <= 0.05) {
    console.error('GATE FAILED: no arm scored above 5%; the harness sees no signal');
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
