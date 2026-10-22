/**
 * Noise floor: how often does the same case change its answer?
 *
 * Every accuracy number in `bird-eval.json` is one sample per case at
 * temperature 0. That is only defensible if identical prompts produce identical
 * answers. This probe asks a stratified subset three times, scores each repeat on
 * its own, and reports how many cases disagreed with themselves plus how far a
 * single run is from the majority.
 *
 *   pnpm bench:bird:stability
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHttpProvider, createPipeline, renderDefinitions } from '@agentix-e/nl2charts-ai';
import type { SchemaTable } from '@agentix-e/nl2charts-ai';
import { judgeOfficial } from '@agentix-e/nl2charts-devkit';
import { buildSchema, loadDescriptions, loadQuestions, loadTables, stratifiedSample } from './data.js';
import { createOracle } from './oracle.js';
import { ARMS, pool, promptFor } from './run.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const SPLIT = process.env.BIRD_SPLIT ?? 'minidev';
const DATA =
  process.env.BIRD_DATA ??
  (SPLIT === 'dev' ? join(ROOT, 'eval/.cache/bird/dev/dev_20240627') : join(ROOT, 'eval/.cache/bird/minidev/MINIDEV'));
const QUESTIONS_FILE = SPLIT === 'dev' ? 'dev.json' : 'mini_dev_sqlite.json';
const DATABASES = process.env.BIRD_DATABASES ?? join(DATA, 'dev_databases');
const LIMIT = Number(process.env.BIRD_STABILITY_LIMIT ?? 60);
const REPEATS = Number(process.env.BIRD_STABILITY_REPEATS ?? 3);
const CONCURRENCY = Number(process.env.BIRD_CONCURRENCY ?? 8);
const ARM = (ARMS.find((entry) => entry.name === (process.env.BIRD_STABILITY_ARM ?? 'metadata+evidence')) ?? ARMS[2]) as (typeof ARMS)[number];

async function main() {
  const manifest = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8')) as { databases: { db: string }[] };
  const dbs = manifest.databases.map((entry) => entry.db);
  const tables = loadTables(join(DATA, 'dev_tables.json'));
  const questions = stratifiedSample(
    loadQuestions(join(DATA, QUESTIONS_FILE)).filter((question) => dbs.includes(question.db_id)),
    LIMIT,
  );
  const schemas = new Map<string, SchemaTable[]>();
  for (const db of dbs) {
    const table = tables.get(db);
    if (table === undefined) continue;
    schemas.set(
      db,
      buildSchema(table, loadDescriptions(join(DATA, 'dev_databases', db, 'database_description'), table.tableNames), {
        withNotes: ARM.notes,
      }),
    );
  }

  const definitions = new Map<string, string>();
  for (const [db, schema] of schemas) definitions.set(db, renderDefinitions(schema));

  const oracle = createOracle(join(ROOT, 'eval/bird/oracle.py'), DATABASES);
  const gold = new Map<number, readonly (readonly unknown[])[]>();
  for (const question of questions) {
    const result = await oracle.run(question.db_id, question.SQL);
    if (result.ok) gold.set(question.question_id, result.rows);
  }
  const cases = questions.filter((question) => gold.has(question.question_id));

  const provider = createHttpProvider({
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'deepseek-chat',
  });

  const runs = await pool(cases, CONCURRENCY, async (question) => {
    const schema = schemas.get(question.db_id) as SchemaTable[];
    const pipeline = createPipeline({ provider, maxRepairs: ARM.repairs, linking: ARM.linking, prompt: promptFor(ARM, question, undefined, definitions.get(question.db_id)) });
    const passes: boolean[] = [];
    for (let attempt = 0; attempt < REPEATS; attempt += 1) {
      try {
        const asked = await pipeline.ask({ question: question.question, schema });
        const predicted = await oracle.run(question.db_id, asked.sql);
        passes.push(predicted.ok && judgeOfficial(gold.get(question.question_id) as readonly (readonly unknown[])[], predicted.rows) === 'match');
      } catch {
        passes.push(false);
      }
    }
    return { id: question.question_id, passes };
  });

  const flips = runs.filter((run) => new Set(run.passes).size > 1).length;
  const majority = runs.filter((run) => run.passes.filter(Boolean).length > REPEATS / 2).length;
  const firstRun = runs.filter((run) => run.passes[0] === true).length;
  const report = {
    dataset: 'bird-mini-dev',
    arm: ARM.name,
    model: process.env.LLM_MODEL ?? 'deepseek-chat',
    cases: runs.length,
    repeats: REPEATS,
    flips,
    flipRate: runs.length === 0 ? 0 : flips / runs.length,
    majorityAccuracy: runs.length === 0 ? 0 : majority / runs.length,
    firstRunAccuracy: runs.length === 0 ? 0 : firstRun / runs.length,
    absoluteDifference: runs.length === 0 ? 0 : Math.abs(majority - firstRun) / runs.length,
    generatedAt: new Date().toISOString(),
  };
  mkdirSync(join(ROOT, 'eval/out'), { recursive: true });
  writeFileSync(join(ROOT, 'eval/out/bird-stability.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `stability: ${report.cases} cases x ${REPEATS}; self-flips ${flips} (${(report.flipRate * 100).toFixed(1)}%); ` +
      `majority ${(report.majorityAccuracy * 100).toFixed(1)}% vs single ${(report.firstRunAccuracy * 100).toFixed(1)}%`,
  );
  await oracle.close();
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
