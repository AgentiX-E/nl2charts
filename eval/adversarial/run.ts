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
import { choosePromptProfile, createHttpProvider, createPipeline, renderDefinitions, renderEvidence } from '@agentix-e/nl2charts-ai';
import type { PromptOptions, SchemaTable } from '@agentix-e/nl2charts-ai';
import { compareArms, judgeOfficial, judgeStrict, mcnemarExact, summarise, wilsonInterval } from '@agentix-e/nl2charts-devkit';
import { buildSchema, loadDescriptions, loadTables } from '../bird/data.js';
import { createOracle } from '../bird/oracle.js';
import { profileDatabase } from '../bird/profile.js';
import { pool } from '../bird/run.js';
import type { Arm } from '../bird/run.js';
import { CASES } from './cases.js';
import type { Category } from './cases.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const DATA = process.env.BIRD_DATA ?? join(ROOT, 'eval/.cache/bird/minidev/MINIDEV');
const DATABASES = process.env.BIRD_DATABASES ?? join(DATA, 'dev_databases');
const CONCURRENCY = Number(process.env.BIRD_CONCURRENCY ?? 6);
const DRY_RUN = process.argv.includes('--dry-run');

const WIDTH_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };

/** The question states its output width; the gold must agree, or the case is wrong. */
function declaredWidth(question: string): number | undefined {
  const match = /exactly (\w+) columns?/i.exec(question);
  return match === null ? undefined : WIDTH_WORDS[match[1]?.toLowerCase() ?? ''];
}

const ARMS: readonly Arm[] = [
  { name: 'names', notes: false, repairs: 0, linking: true },
  { name: 'definitions', notes: false, repairs: 0, linking: true, definitions: 'structural' },
  { name: 'metadata', notes: true, repairs: 0, linking: true },
  { name: 'synthetic', notes: true, evidence: 'synthetic', repairs: 0, linking: true },
  { name: 'adaptive', notes: true, repairs: 0, linking: true, profile: 'adaptive' },
];

function promptFor(arm: Arm, question: string, synthesized?: string, definitions?: string): PromptOptions {
  const profile = arm.profile === 'adaptive' ? choosePromptProfile(question) : undefined;
  const evidence = arm.evidence === 'synthetic' ? synthesized : undefined;
  return {
    dialect: 'SQLite',
    descriptions: profile?.descriptions ?? arm.notes,
    foreignKeys: profile?.foreignKeys ?? arm.notes,
    samples: false,
    schemaLines: 2000,
    ...(profile === undefined ? {} : { notes: profile.notes }),
    ...(arm.definitions !== undefined && definitions !== undefined && definitions.length > 0 ? { definitions } : {}),
    ...(evidence === undefined || evidence.length === 0 ? {} : { evidence }),
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
  const definitions = new Map<string, string>();
  for (const [db, schema] of schemas) definitions.set(db, renderDefinitions(schema));
  const synthesized = new Map<string, string>();
  for (const db of dbs) synthesized.set(db, renderEvidence(await profileDatabase(oracle, db)));

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
  // A question that promises two columns and a gold that returns three makes
  // every otherwise-correct answer fail. Checked before any model call.
  for (const testCase of CASES) {
    const rows = gold.get(testCase.id);
    if (rows === undefined) continue;
    const declared = declaredWidth(testCase.question);
    const actual = (rows[0] as readonly unknown[]).length;
    if (declared !== undefined && declared !== actual) {
      broken.push({ id: testCase.id, error: `question promises ${declared} columns, gold returns ${actual}` });
    }
  }
  if (broken.length > 0) {
    console.error(`gold problems: ${broken.map((entry) => `${entry.id} (${entry.error})`).join(', ')}`);
    process.exitCode = 1;
    await oracle.close();
    return;
  }

  if (DRY_RUN) {
    mkdirSync(join(ROOT, 'eval/out'), { recursive: true });
    writeFileSync(
      join(ROOT, 'eval/out/adversarial-dry.json'),
      `${JSON.stringify({ cases: CASES.length, gold: gold.size, broken, generatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    console.log(`dry run: ${gold.size}/${CASES.length} gold statements run, all widths agree with the questions`);
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
      const pipeline = createPipeline({
        provider,
        maxRepairs: arm.repairs,
        linking: arm.linking,
        prompt: promptFor(arm, testCase.question, synthesized.get(testCase.db), definitions.get(testCase.db)),
      });
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
  const ablation = (from: string, to: string) => {
    const before = outcomes.get(from);
    const after = outcomes.get(to);
    if (before === undefined || after === undefined) return undefined;
    const paired = compareArms(summarise(from, before), summarise(to, after));
    return { delta: paired.delta, onlyFirst: paired.onlyFirst, onlySecond: paired.onlySecond, p: mcnemarExact(paired.onlyFirst, paired.onlySecond) };
  };
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
      ...Object.fromEntries(
        [ablation('metadata', 'synthetic'), ablation('metadata', 'adaptive')]
          .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
          .map((entry, index) => [index === 0 ? 'metadata -> synthetic' : 'metadata -> adaptive', entry]),
      ),
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
