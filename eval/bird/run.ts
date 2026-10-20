/**
 * BIRD Mini-Dev evaluation: the external benchmark, not the synthetic set.
 *
 * What makes a number from this file usable:
 *
 * - the dataset is external (schemas, questions, gold SQL and SQLite databases
 *   written by someone else), so a high score is not a property of our fixtures;
 * - every gold statement is executed before a model is called, and a gold that
 *   does not run is excluded and counted rather than scored as a model failure;
 * - gold is executed twice and compared to itself, so a broken judge or a
 *   nondeterministic database shows up as a failed control;
 * - arms differ in exactly one thing (metadata, evidence, repair) and are
 *   compared pairwise with McNemar's exact test on the same cases;
 * - the official BIRD judge (`set()` over tuples) and a strict multiset judge
 *   both run, so duplicate-collapse credit is visible instead of hidden.
 *
 *   pnpm bench:bird --dry-run     # gold execution, prompts, controls; no model
 *   pnpm bench:bird               # full run against the configured provider
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHttpProvider } from '@agentix-e/nl2charts-ai';
import type { PromptOptions, SchemaTable } from '@agentix-e/nl2charts-ai';
import { buildSqlPrompt, createPipeline } from '@agentix-e/nl2charts-ai';
import { compareArms, judgeOfficial, judgeStrict, mcnemarExact, summarise, wilsonInterval } from '@agentix-e/nl2charts-devkit';
import type { CaseOutcome, MatchReason } from '@agentix-e/nl2charts-devkit';
import { buildSchema, loadDescriptions, loadQuestions, loadTables, stratifiedSample } from './data.js';
import type { BirdQuestion } from './data.js';
import { createOracle } from './oracle.js';
import type { OracleResult } from './oracle.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const DATA = process.env.BIRD_DATA ?? join(ROOT, 'eval/.cache/bird/minidev/MINIDEV');
const DATABASES = process.env.BIRD_DATABASES ?? join(DATA, 'dev_databases');
const DEFAULT_DBS = [
  'superhero',
  'california_schools',
  'student_club',
  'thrombosis_prediction',
  'toxicology',
  'debit_card_specializing',
];

export interface Arm {
  readonly name: string;
  readonly notes: boolean;
  readonly evidence: boolean;
  readonly repairs: number;
}

export const ARMS: readonly Arm[] = [
  { name: 'names', notes: false, evidence: false, repairs: 0 },
  { name: 'metadata', notes: true, evidence: false, repairs: 0 },
  { name: 'evidence', notes: false, evidence: true, repairs: 0 },
  { name: 'full', notes: true, evidence: true, repairs: 2 },
];

interface CaseRun extends CaseOutcome {
  readonly predicted: string;
  readonly reason: MatchReason;
  readonly strict: boolean;
  readonly error?: string;
  readonly errorKind?: 'execution' | 'guard' | 'llm' | 'other';
  readonly attempts: number;
}

function settings() {
  const argv = process.argv.slice(2);
  return {
    dryRun: argv.includes('--dry-run'),
    limit: Number(process.env.BIRD_LIMIT ?? 200),
    concurrency: Number(process.env.BIRD_CONCURRENCY ?? 6),
    dbs: (process.env.BIRD_DBS ?? DEFAULT_DBS.join(',')).split(',').map((name) => name.trim()).filter(Boolean),
    arms: (process.env.BIRD_ARMS ?? ARMS.map((arm) => arm.name).join(',')).split(',').map((name) => name.trim()),
    out: process.env.BIRD_OUT ?? join(ROOT, 'eval/out/bird-eval.json'),
    model: process.env.LLM_MODEL ?? 'deepseek-chat',
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? '',
  };
}

async function pool<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}

function promptFor(arm: Arm, question: BirdQuestion): PromptOptions {
  return {
    dialect: 'SQLite',
    descriptions: arm.notes,
    foreignKeys: arm.notes,
    samples: false,
    schemaLines: 400,
    ...(arm.evidence ? { evidence: question.evidence } : {}),
  };
}

async function main() {
  const config = settings();
  const questions = loadQuestions(join(DATA, 'mini_dev_sqlite.json')).filter((question) => config.dbs.includes(question.db_id));
  if (questions.length === 0) throw new Error(`no questions for ${config.dbs.join(',')}; run node eval/bird/fetch.mjs first`);
  const tables = loadTables(join(DATA, 'dev_tables.json'));
  const selected = stratifiedSample(questions, config.limit);
  const oracle = createOracle(join(ROOT, 'eval/bird/oracle.py'), DATABASES);

  const schemas = new Map<string, SchemaTable[]>();
  for (const db of config.dbs) {
    const table = tables.get(db);
    if (table === undefined) throw new Error(`dev_tables.json has no entry for ${db}`);
    schemas.set(
      db,
      buildSchema(table, loadDescriptions(join(DATA, 'dev_databases', db, 'database_description'), table.tableNames), {
        withNotes: true,
      }),
    );
  }

  // 1. Gold pre-execution. A case is scored only if its gold statement runs.
  const gold = new Map<number, OracleResult>();
  const unrunnable: { id: number; db: string; error: string }[] = [];
  for (const question of selected) {
    const result = await oracle.run(question.db_id, question.SQL);
    if (result.ok) gold.set(question.question_id, result);
    else unrunnable.push({ id: question.question_id, db: question.db_id, error: result.error ?? 'unknown' });
  }
  const cases = selected.filter((question) => gold.has(question.question_id));

  // 2. Controls. Both must hold before any accuracy number is meaningful.
  let selfConsistent = 0;
  let negativeChecked = 0;
  let negativeFalseMatches = 0;
  const emptyGold = cases.filter((question) => (gold.get(question.question_id)?.rows.length ?? 0) === 0).length;
  for (const question of cases) {
    const first = gold.get(question.question_id) as OracleResult;
    const second = await oracle.run(question.db_id, question.SQL);
    if (second.ok && judgeOfficial(first.rows, second.rows) === 'match') selfConsistent += 1;
    if (first.rows.length > 0) {
      negativeChecked += 1;
      if (judgeOfficial(first.rows, []) === 'match') negativeFalseMatches += 1;
    }
  }

  const report: Record<string, unknown> = {
    dataset: 'bird-mini-dev',
    split: 'mini_dev_sqlite',
    dialect: 'SQLite',
    model: config.dryRun ? null : config.model,
    generatedAt: new Date().toISOString(),
    selection: {
      databases: config.dbs,
      available: questions.length,
      requested: config.limit,
      scored: cases.length,
      strategy: 'stratified by difficulty, then question id',
    },
    gold: {
      executed: selected.length,
      runnable: cases.length,
      unrunnable: unrunnable.slice(0, 20),
      runnableRate: cases.length / selected.length,
    },
    controls: {
      selfConsistency: selfConsistent / cases.length,
      negativeChecked,
      negativeFalseMatches,
      emptyGoldExcluded: emptyGold,
    },
  };

  if (config.dryRun) {
    const prompts = cases.slice(0, 3).map((question) => ({
      id: question.question_id,
      prompt: buildSqlPrompt(
        question.question,
        schemas.get(question.db_id) as SchemaTable[],
        promptFor(ARMS[0] as Arm, question),
      ),
    }));
    report.prompts = prompts;
    report.arms = [];
    finish(config, report);
    await oracle.close();
    return;
  }

  // 3. Arms.
  const provider = createHttpProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
  const armReports: unknown[] = [];
  const outcomes = new Map<string, CaseOutcome[]>();
  for (const name of config.arms) {
    const arm = ARMS.find((entry) => entry.name === name);
    if (arm === undefined) throw new Error(`unknown arm ${name}`);
    const runs = await pool(cases, config.concurrency, async (question): Promise<CaseRun> => {
      const schema = schemas.get(question.db_id) as SchemaTable[];
      // The execute hook exists for repairs only. Without repairs it would turn
      // an execution failure into a thrown pipeline error and hide the statement
      // that failed, which is the one thing a diagnosis needs.
      const pipeline = createPipeline({
        provider,
        maxRepairs: arm.repairs,
        prompt: promptFor(arm, question),
        ...(arm.repairs === 0
          ? {}
          : {
              execute: async (sql: string) => {
                const result = await oracle.run(question.db_id, sql);
                if (!result.ok) throw new Error(result.error ?? 'execution failed');
              },
            }),
      });
      const expected = gold.get(question.question_id) as OracleResult;
      try {
        const asked = await pipeline.ask({ question: question.question, schema });
        const predicted = await oracle.run(question.db_id, asked.sql);
        if (!predicted.ok) {
          return {
            id: String(question.question_id),
            passed: false,
            predicted: asked.sql,
            reason: 'values',
            strict: false,
            attempts: asked.attempts,
            error: `execution: ${predicted.error ?? 'unknown'}`,
          };
        }
        const reason = judgeOfficial(expected.rows, predicted.rows);
        return {
          id: String(question.question_id),
          passed: reason === 'match',
          predicted: asked.sql,
          reason,
          strict: judgeStrict(expected.rows, predicted.rows) === 'match',
          attempts: asked.attempts,
        };
      } catch (error) {
        // A repair arm reports the statement it gave up on, so a failure is
        // diagnosable from the artifact alone.
        const details = (error as { details?: Record<string, unknown> }).details ?? {};
        const lastError = typeof details.lastError === 'string' ? details.lastError : undefined;
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: string }).code ?? '';
        return {
          id: String(question.question_id),
          passed: false,
          predicted: typeof details.lastSql === 'string' ? details.lastSql : '',
          reason: 'values',
          strict: false,
          attempts: arm.repairs + 1,
          error: lastError === undefined ? message : `${message}: ${lastError}`,
          errorKind: code === 'NL2C_E_GUARD_REJECTED' ? 'guard' : code === 'NL2C_E_ENGINE_FAILED' ? 'execution' : code.startsWith('NL2C_E_LLM') ? 'llm' : 'other',
        };
      }
    });
    outcomes.set(arm.name, runs);
    const summary = summarise(arm.name, runs);
    const strictPassed = runs.filter((run) => run.strict).length;
    const byDifficulty: Record<string, { passed: number; total: number }> = {};
    for (const run of runs) {
      const difficulty = cases.find((question) => String(question.question_id) === run.id)?.difficulty ?? 'unknown';
      const bucket = (byDifficulty[difficulty] ??= { passed: 0, total: 0 });
      bucket.total += 1;
      if (run.passed) bucket.passed += 1;
    }
    const kindOf = (run: CaseRun): string | undefined => run.errorKind ?? (run.error === undefined ? undefined : 'other');
    const errors = {
      execution: runs.filter((run) => kindOf(run) === 'execution').length,
      guard: runs.filter((run) => kindOf(run) === 'guard').length,
      llm: runs.filter((run) => kindOf(run) === 'llm').length,
      other: runs.filter((run) => kindOf(run) === 'other').length,
      columnCount: runs.filter((run) => run.reason === 'column-count').length,
      values: runs.filter((run) => run.reason === 'values' && run.error === undefined).length,
    };
    const messages = new Map<string, number>();
    for (const run of runs) {
      if (run.error === undefined) continue;
      const key = run.error.replace(/\d+/g, 'N').slice(0, 120);
      messages.set(key, (messages.get(key) ?? 0) + 1);
    }
    armReports.push({
      arm: arm.name,
      passed: summary.passed,
      total: summary.total,
      accuracy: summary.accuracy,
      wilson: wilsonInterval(summary.passed, summary.total),
      strictPassed,
      duplicateCredit: summary.passed - strictPassed,
      exactMatchRate: runs.filter((run) => run.strict).length / summary.total,
      repaired: runs.filter((run) => run.attempts > 1).length,
      byDifficulty,
      errors,
      topErrors: [...messages.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5),
    });
    console.log(
      `${arm.name.padEnd(9)} ${summary.passed}/${summary.total}  ${(summary.accuracy * 100).toFixed(1)}%  strict ${strictPassed}  repaired ${runs.filter((run) => run.attempts > 1).length}`,
    );
  }

  const baseline = outcomes.get(config.arms[0] as string);
  const ablations: Record<string, unknown> = {};
  for (const name of config.arms.slice(1)) {
    const current = outcomes.get(name);
    if (baseline === undefined || current === undefined) continue;
    const comparison = compareArms(summarise(config.arms[0] as string, baseline), summarise(name, current));
    ablations[`${config.arms[0]} -> ${name}`] = {
      delta: comparison.delta,
      onlyFirst: comparison.onlyFirst,
      onlySecond: comparison.onlySecond,
      p: mcnemarExact(comparison.onlyFirst, comparison.onlySecond),
    };
  }

  report.arms = armReports;
  report.ablations = ablations;
  report.failures = Object.fromEntries(
    [...outcomes.entries()].map(([name, runs]) => [
      name,
      runs
        .filter((run) => !run.passed)
        .slice(0, 25)
        .map((run) => ({
          id: run.id,
          question: cases.find((question) => String(question.question_id) === run.id)?.question,
          predicted: (run as CaseRun).predicted,
          reason: (run as CaseRun).reason,
          error: (run as CaseRun).error,
        })),
    ]),
  );

  finish(config, report);
  await oracle.close();
  gate(report);
}

function finish(config: ReturnType<typeof settings>, report: Record<string, unknown>): void {
  mkdirSync(join(ROOT, 'eval/out'), { recursive: true });
  writeFileSync(config.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`artifact: ${config.out}`);
  if (config.dryRun) {
    console.log(
      `dry run: gold runnable ${String((report.gold as { runnable: number }).runnable)}/${String((report.gold as { executed: number }).executed)}; self-consistency ${((report.controls as { selfConsistency: number }).selfConsistency * 100).toFixed(1)}%; negative false matches ${String((report.controls as { negativeFalseMatches: number }).negativeFalseMatches)}`,
    );
  }
}

/** Thresholds, not decoration: a run that trips one of these must fail CI. */
function gate(report: Record<string, unknown>): void {
  const goldRate = (report.gold as { runnableRate: number }).runnableRate;
  const controls = report.controls as { selfConsistency: number; negativeFalseMatches: number };
  const arms = report.arms as { arm: string; accuracy: number }[];
  const problems: string[] = [];
  if (goldRate < 0.98) problems.push(`gold runnable rate ${(goldRate * 100).toFixed(1)}% is below 98%`);
  if (controls.selfConsistency < 1) problems.push(`self-consistency ${(controls.selfConsistency * 100).toFixed(1)}% is not 100%`);
  if (controls.negativeFalseMatches !== 0) problems.push(`${controls.negativeFalseMatches} negative control(s) matched a gold result`);
  const best = arms.reduce((top, arm) => Math.max(top, arm.accuracy), 0);
  if (best < 0.05) problems.push(`best arm accuracy ${(best * 100).toFixed(1)}% is not above 5%: the harness sees no signal`);
  const first = arms[0];
  const last = arms[arms.length - 1];
  if (first !== undefined && last !== undefined && last.accuracy < first.accuracy - 0.05) {
    problems.push(`${last.arm} trails ${first.arm} by more than 5pp, which is a regression not a result`);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`GATE FAILED: ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('gates: gold runnable, controls, signal and no regression all hold');
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
