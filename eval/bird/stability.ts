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
 *
 * The measurement is a value, not a side effect of importing this module: the settings
 * arrive as an argument, the provider and the oracle arrive as arguments, and the report is
 * returned. That is what lets a test drive the same numbers against a temporary dataset and
 * a local endpoint — and it is how the first defect in this file was found: an unknown
 * `BIRD_STABILITY_ARM` used to fall back to the third arm and still label the artifact with
 * the arm it measured, which is a report that lies about itself.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHttpProvider, createPipeline, renderDefinitions } from '@agentix-e/nl2charts-ai';
import type { LlmProvider, PromptOptions, SchemaTable } from '@agentix-e/nl2charts-ai';
import { judgeOfficial } from '@agentix-e/nl2charts-devkit';
import { describeError } from '../errors.js';
import { buildSchema, loadDescriptions, loadQuestions, loadTables, stratifiedSample } from './data.js';
import { createOracle } from './oracle.js';
import type { Oracle } from './oracle.js';
import { ARMS, pool, promptFor, resolveLayout } from './run.js';
import type { Arm, BirdLayout } from './run.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

/** The arm this probe measures when nothing names one. */
const DEFAULT_ARM = 'metadata+evidence';

export interface StabilitySettings {
  /** Paths come from the runner's layout, so the two cannot disagree about a split. */
  readonly layout: BirdLayout;
  readonly out: string;
  readonly dryRun: boolean;
  readonly limit: number;
  readonly repeats: number;
  readonly concurrency: number;
  readonly arm: Arm;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

/**
 * The arm a name refers to.
 *
 * The lookup used to be a `?? ARMS[2]` fallback, so a typo in `BIRD_STABILITY_ARM` produced
 * a complete, plausible artifact labelled `metadata+evidence` while the operator believed
 * they had measured something else. A name that does not resolve is now an error that lists
 * the names that do.
 */
export function pickArm(name: string | undefined): Arm {
  const wanted = name ?? DEFAULT_ARM;
  const found = ARMS.find((entry) => entry.name === wanted);
  if (found === undefined) {
    throw new Error(`no arm named '${wanted}'; known arms: ${ARMS.map((entry) => entry.name).join(', ')}`);
  }
  return found;
}

/** A count from the environment, or the default when the variable is absent or unreadable. */
function count(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got '${raw}'`);
  return value;
}

export function resolveStabilitySettings(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  root: string,
): StabilitySettings {
  const layout = resolveLayout(env, root);
  return {
    layout,
    out: env.BIRD_STABILITY_OUT ?? join(root, 'eval/out/bird-stability.json'),
    dryRun: argv.includes('--dry-run'),
    limit: count(env.BIRD_STABILITY_LIMIT, 60, 'BIRD_STABILITY_LIMIT'),
    repeats: count(env.BIRD_STABILITY_REPEATS, 3, 'BIRD_STABILITY_REPEATS'),
    concurrency: count(env.BIRD_CONCURRENCY, 8, 'BIRD_CONCURRENCY'),
    arm: pickArm(env.BIRD_STABILITY_ARM),
    model: env.LLM_MODEL ?? 'deepseek-chat',
    baseUrl: env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey: env.DEEPSEEK_API_KEY ?? env.LLM_API_KEY ?? '',
  };
}

/** One case as the probe will ask it: the prompt is a value, so all repeats share it. */
export interface StabilityCase {
  readonly id: number;
  readonly db: string;
  readonly question: string;
  readonly schema: readonly SchemaTable[];
  readonly prompt: PromptOptions;
}

export interface StabilityPrepared {
  readonly settings: StabilitySettings;
  readonly cases: readonly StabilityCase[];
  readonly gold: ReadonlyMap<number, readonly (readonly unknown[])[]>;
  /** Questions whose gold statement did not run, and so cannot be scored. */
  readonly unrunnable: number;
}

export interface StabilityIo {
  readonly oracle: Oracle;
  readonly provider: LlmProvider;
}

/**
 * Everything that must be true before a model is called.
 *
 * The gold statements run first, for the same reason they do in the runner: a case whose
 * gold returns nothing scores every answer wrong, and a repeat count multiplied by a broken
 * case is a stable number about nothing.
 */
export async function prepareStability(settings: StabilitySettings, io: StabilityIo): Promise<StabilityPrepared> {
  const { layout, limit } = settings;
  const data = layout.data;
  const manifest = JSON.parse(readFileSync(join(data, 'manifest.json'), 'utf8')) as { databases: { db: string }[] };
  const dbs = manifest.databases.map((entry) => entry.db);
  const tables = loadTables(join(data, 'dev_tables.json'));
  const questions = stratifiedSample(
    loadQuestions(layout.questionsFile).filter((question) => dbs.includes(question.db_id)),
    limit,
  );
  const schemas = new Map<string, SchemaTable[]>();
  for (const db of dbs) {
    const table = tables.get(db);
    if (table === undefined) continue;
    schemas.set(
      db,
      buildSchema(table, loadDescriptions(join(data, 'dev_databases', db, 'database_description'), table.tableNames), {
        withNotes: settings.arm.notes,
      }),
    );
  }
  const definitions = new Map<string, string>();
  for (const [db, schema] of schemas) definitions.set(db, renderDefinitions(schema));

  const gold = new Map<number, readonly (readonly unknown[])[]>();
  for (const question of questions) {
    const result = await io.oracle.run(question.db_id, question.SQL);
    if (result.ok) gold.set(question.question_id, result.rows);
  }

  const cases: StabilityCase[] = questions
    .filter((question) => gold.has(question.question_id) && schemas.has(question.db_id))
    .map((question) => ({
      id: question.question_id,
      db: question.db_id,
      question: question.question,
      schema: schemas.get(question.db_id) as SchemaTable[],
      // Every case survived a `schemas.has` filter above, and `definitions` has an entry for
      // every schema, so the lookup cannot miss; the assertion says so instead of carrying a
      // fallback branch no test could reach.
      prompt: promptFor(settings.arm, question, { definitions: definitions.get(question.db_id) as string }),
    }));

  return { settings, cases, gold, unrunnable: questions.length - cases.length };
}

/** What one case did across the repeats. */
export interface StabilityRun {
  readonly id: number;
  readonly passes: readonly boolean[];
  /** Repeats the harness could not complete: the call never produced a statement. */
  readonly outages: readonly string[];
  /** Repeats where the model produced a statement the engine refused. Scored, not lost. */
  readonly engineFailures: number;
}

export function stabilityReport(
  settings: StabilitySettings,
  prepared: StabilityPrepared,
  runs: readonly StabilityRun[],
): Record<string, unknown> {
  const repeats = settings.repeats;
  const flips = runs.filter((run) => new Set(run.passes).size > 1).length;
  const majority = runs.filter((run) => run.passes.filter(Boolean).length > repeats / 2).length;
  const firstRun = runs.filter((run) => run.passes[0] === true).length;
  const errors = runs.reduce((total, run) => total + run.outages.length, 0);
  const engineFailures = runs.reduce((total, run) => total + run.engineFailures, 0);
  return {
    dataset: settings.layout.split === 'dev' ? 'bird-dev' : 'bird-mini-dev',
    arm: settings.arm.name,
    model: settings.model,
    cases: runs.length,
    repeats,
    flips,
    flipRate: runs.length === 0 ? 0 : flips / runs.length,
    majorityAccuracy: runs.length === 0 ? 0 : majority / runs.length,
    firstRunAccuracy: runs.length === 0 ? 0 : firstRun / runs.length,
    absoluteDifference: runs.length === 0 ? 0 : Math.abs(majority - firstRun) / runs.length,
    // A repeat that never reached the model is not the model changing its mind, and a flip
    // count cannot tell the two apart. Reported separately so a reader can: an endpoint that
    // failed half the calls will show flips, and this is the line that says why.
    outages: errors,
    outageRate: runs.length === 0 ? 0 : errors / (runs.length * repeats),
    outageSamples: [...new Set(runs.flatMap((run) => run.outages))].slice(0, 5),
    // A statement the engine refused is a scored answer, not a lost one: it says the model
    // wrote broken SQL, which is a fact about the arm and belongs next to the accuracy.
    engineFailures,
    unrunnable: prepared.unrunnable,
    gold: prepared.gold.size,
    generatedAt: new Date().toISOString(),
  };
}

export async function runStability(
  settings: StabilitySettings,
  io: StabilityIo,
): Promise<Record<string, unknown>> {
  const prepared = await prepareStability(settings, io);
  const runs = await pool(prepared.cases, settings.concurrency, async (testCase): Promise<StabilityRun> => {
    const pipeline = createPipeline({
      provider: io.provider,
      maxRepairs: settings.arm.repairs,
      linking: settings.arm.linking,
      prompt: testCase.prompt,
    });
    const passes: boolean[] = [];
    const outages: string[] = [];
    let engineFailures = 0;
    for (let attempt = 0; attempt < settings.repeats; attempt += 1) {
      try {
        const asked = await pipeline.ask({ question: testCase.question, schema: [...testCase.schema] });
        const predicted = await io.oracle.run(testCase.db, asked.sql);
        passes.push(
          predicted.ok &&
            judgeOfficial(prepared.gold.get(testCase.id) as readonly (readonly unknown[])[], predicted.rows) === 'match',
        );
        // A statement the engine refused is an answer, not an outage: it is scored as wrong
        // and counted as an engine failure rather than as a call the harness lost.
        if (!predicted.ok) engineFailures += 1;
      } catch (error) {
        passes.push(false);
        outages.push(describeError(error));
      }
    }
    return { id: testCase.id, passes, outages, engineFailures };
  });
  return stabilityReport(settings, prepared, runs);
}

/** The line the workflow log shows; the artifact carries the same numbers. */
export function stabilitySummary(report: Record<string, unknown>): string {
  const percent = (value: unknown): string => `${((value as number) * 100).toFixed(1)}%`;
  const outages = report.outages as number;
  const engineFailures = report.engineFailures as number;
  return (
    `stability: ${String(report.cases)} cases x ${String(report.repeats)}; ` +
    `self-flips ${String(report.flips)} (${percent(report.flipRate)}); ` +
    `majority ${percent(report.majorityAccuracy)} vs single ${percent(report.firstRunAccuracy)}` +
    `${outages === 0 ? '' : `; ${String(outages)} unanswered repeat(s)`}` +
    `${engineFailures === 0 ? '' : `; ${String(engineFailures)} rejected statement(s)`}`
  );
}

export function writeStabilityArtifact(settings: StabilitySettings, report: Record<string, unknown>): void {
  mkdirSync(dirname(settings.out), { recursive: true });
  writeFileSync(settings.out, `${JSON.stringify(report, null, 2)}\n`);
}

export async function main(
  env: Readonly<Record<string, string | undefined>> = process.env,
  argv: readonly string[] = process.argv.slice(2),
  root: string = ROOT,
): Promise<number> {
  // Settings are resolved before the oracle exists, and the run's failures are not caught:
  // the runner treats a configuration error as a rejection rather than an exit code, and two
  // harnesses that report the same class of mistake two different ways is one convention too
  // many. The `finally` is only here to leave no python process behind.
  const settings = resolveStabilitySettings(env, argv, root);
  const oracle = createOracle(settings.layout.oracleScript, settings.layout.databaseRoot);
  try {
    const provider = createHttpProvider({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
    });
    if (settings.dryRun) {
      const prepared = await prepareStability(settings, { oracle, provider });
      console.log(
        `dry run: ${String(prepared.cases.length)} cases x ${String(settings.repeats)} repeats, ` +
          `gold runnable ${String(prepared.gold.size)}, arm ${settings.arm.name}; no model was called`,
      );
      return 0;
    }
    const report = await runStability(settings, { oracle, provider });
    writeStabilityArtifact(settings, report);
    console.log(stabilitySummary(report));
    return 0;
  } finally {
    await oracle.close();
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
