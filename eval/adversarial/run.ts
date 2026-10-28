/**
 * Adversarial evaluation: the four shapes an aggregate score hides.
 *
 * Runs the hand-written cases in `cases.ts` through the same execution oracle and
 * judge as the BIRD run, on six arms (names only, two placements of the definitions,
 * column metadata, synthesized evidence, and the adaptive profile) so the question
 * "does the metadata lever also work on hard shapes?" gets a number instead of an opinion.
 *
 *   pnpm bench:adversarial
 *   pnpm bench:adversarial -- --dry-run
 *
 * Two defects came out of making this file a function of its settings instead of a script
 * that runs at import time. The headline ablation compared the *definitions* arm and
 * reported it as `names -> metadata`, so the number the docs quote for the metadata lever
 * was a number about a different arm; the arms it meant are now looked up by name and a
 * missing one is an error. And the inline arm's definitions were synthesized before the gold
 * statements were checked, which is one model call spent on a case set that may not run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  attachDefinitions,
  choosePromptProfile,
  createHttpProvider,
  createPipeline,
  renderDefinitions,
  renderEvidence,
} from '@agentix-e/nl2charts-ai';
import type { LlmProvider, PromptOptions, SchemaTable } from '@agentix-e/nl2charts-ai';
import { compareArms, judgeOfficial, judgeStrict, mcnemarExact, summarise, wilsonInterval } from '@agentix-e/nl2charts-devkit';
import { describeError } from '../errors.js';
import { buildSchema, loadDescriptions, loadTables } from '../bird/data.js';
import { createOracle } from '../bird/oracle.js';
import type { Oracle } from '../bird/oracle.js';
import { profileDatabase } from '../bird/profile.js';
import { synthesizeDefinitions } from '../bird/synthesize.js';
import { pool } from '../bird/run.js';
import type { Arm } from '../bird/run.js';
import { CASES } from './cases.js';
import type { AdversarialCase, Category } from './cases.js';

export type { AdversarialCase } from './cases.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

export const WIDTH_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4 };

/**
 * The question states its output width; the gold must agree, or the case is wrong.
 *
 * Digits are read as well as words: the word table stops at four, and a question that
 * promises five columns used to return `undefined` here, which skipped the check entirely
 * rather than failing it.
 */
export function declaredWidth(question: string): number | undefined {
  const match = /exactly (\w+) columns?/i.exec(question);
  if (match === null) return undefined;
  const word = String(match[1]).toLowerCase();
  const numeric = Number(word);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  return WIDTH_WORDS[word];
}

export const ADVERSARIAL_ARMS: readonly Arm[] = [
  { name: 'names', notes: false, repairs: 0, linking: true },
  { name: 'definitions', notes: false, repairs: 0, linking: true, definitions: 'structural' },
  { name: 'inline-definitions', notes: false, repairs: 0, linking: true, definitions: 'inline' },
  { name: 'metadata', notes: true, repairs: 0, linking: true },
  { name: 'synthetic', notes: true, evidence: 'synthetic', repairs: 0, linking: true },
  { name: 'adaptive', notes: true, repairs: 0, linking: true, profile: 'adaptive' },
];

export function promptFor(arm: Arm, question: string, synthesized?: string, definitions?: string): PromptOptions {
  const profile = arm.profile === 'adaptive' ? choosePromptProfile(question) : undefined;
  const evidence = arm.evidence === 'synthetic' ? synthesized : undefined;
  return {
    dialect: 'SQLite',
    descriptions: arm.definitions === 'inline' ? true : (profile?.descriptions ?? arm.notes),
    foreignKeys: profile?.foreignKeys ?? arm.notes,
    samples: false,
    schemaLines: 2000,
    ...(profile === undefined ? {} : { notes: profile.notes }),
    ...(arm.definitions !== undefined && definitions !== undefined && definitions.length > 0 ? { definitions } : {}),
    ...(evidence === undefined || evidence.length === 0 ? {} : { evidence }),
  };
}

export interface AdversarialSettings {
  readonly root: string;
  readonly data: string;
  readonly databases: string;
  readonly out: string;
  readonly profileCache: string;
  readonly dryRun: boolean;
  readonly concurrency: number;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

function positive(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got '${raw}'`);
  return value;
}

export function resolveAdversarialSettings(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  root: string,
): AdversarialSettings {
  const data = env.BIRD_DATA ?? join(root, 'eval/.cache/bird/minidev/MINIDEV');
  return {
    root,
    data,
    databases: env.BIRD_DATABASES ?? join(data, 'dev_databases'),
    out: env.ADVERSARIAL_OUT ?? join(root, 'eval/out/adversarial.json'),
    profileCache: env.BIRD_PROFILE_CACHE ?? join(root, 'eval/.cache/bird/profiles'),
    dryRun: argv.includes('--dry-run'),
    concurrency: positive(env.BIRD_CONCURRENCY, 6, 'BIRD_CONCURRENCY'),
    model: env.LLM_MODEL ?? 'deepseek-chat',
    baseUrl: env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey: env.DEEPSEEK_API_KEY ?? env.LLM_API_KEY ?? '',
  };
}

export interface AdversarialIo {
  readonly oracle: Oracle;
  readonly provider: LlmProvider;
  /** The cases to run; the CLI uses the hand-written set, a test uses its own. */
  readonly cases?: readonly AdversarialCase[];
}

export interface AdversarialPrepared {
  readonly settings: AdversarialSettings;
  readonly cases: readonly AdversarialCase[];
  readonly dbs: readonly string[];
  readonly schemas: ReadonlyMap<string, SchemaTable[]>;
  readonly inlineSchemas: ReadonlyMap<string, SchemaTable[]>;
  readonly definitions: ReadonlyMap<string, string>;
  readonly synthesized: ReadonlyMap<string, string>;
  readonly gold: ReadonlyMap<string, readonly (readonly unknown[])[]>;
  readonly broken: readonly { id: string; error: string }[];
}

/** A schema per database, built from the dataset's own table file and descriptions. */
export function buildSchemas(
  data: string,
  dbs: readonly string[],
  notes: boolean,
): Map<string, SchemaTable[]> {
  const tables = loadTables(join(data, 'dev_tables.json'));
  const schemas = new Map<string, SchemaTable[]>();
  for (const db of dbs) {
    const table = tables.get(db);
    if (table === undefined) throw new Error(`dev_tables.json has no entry for ${db}`);
    schemas.set(
      db,
      buildSchema(table, loadDescriptions(join(data, 'dev_databases', db, 'database_description'), table.tableNames), {
        withNotes: notes,
      }),
    );
  }
  return schemas;
}

/**
 * Run every gold statement, and check the widths the questions promise.
 *
 * A question that promises two columns and a gold that returns three makes every otherwise
 * correct answer fail. Both checks run before any model call.
 */
export async function checkGold(
  oracle: Oracle,
  cases: readonly AdversarialCase[],
): Promise<{ gold: Map<string, readonly (readonly unknown[])[]>; broken: { id: string; error: string }[] }> {
  const gold = new Map<string, readonly (readonly unknown[])[]>();
  const broken: { id: string; error: string }[] = [];
  for (const testCase of cases) {
    const result = await oracle.run(testCase.db, testCase.sql);
    if (!result.ok) broken.push({ id: testCase.id, error: result.error ?? 'failed' });
    else if (result.rows.length === 0) broken.push({ id: testCase.id, error: 'gold returned no rows' });
    else gold.set(testCase.id, result.rows);
  }
  for (const testCase of cases) {
    const rows = gold.get(testCase.id);
    if (rows === undefined) continue;
    const declared = declaredWidth(testCase.question);
    // A gold with no rows was already recorded as broken above, so `rows[0]` exists here.
    const actual = (rows[0] as readonly unknown[]).length;
    if (declared !== undefined && declared !== actual) {
      broken.push({ id: testCase.id, error: `question promises ${String(declared)} columns, gold returns ${String(actual)}` });
    }
  }
  return { gold, broken };
}

/**
 * Everything that must exist before an arm can be scored.
 *
 * The gold comes first now. It used to come after the inline arm's definitions, which are
 * generated by the model: a case set that does not run spent one call per database before
 * anyone knew it was broken.
 */
export async function prepareAdversarial(settings: AdversarialSettings, io: AdversarialIo): Promise<AdversarialPrepared> {
  const cases = io.cases ?? CASES;
  const dbs = [...new Set(cases.map((testCase) => testCase.db))];
  const schemas = buildSchemas(settings.data, dbs, true);
  const definitions = new Map<string, string>();
  for (const [db, schema] of schemas) definitions.set(db, renderDefinitions(schema));

  const { gold, broken } = await checkGold(io.oracle, cases);
  if (broken.length > 0) {
    return { settings, cases, dbs, schemas, inlineSchemas: new Map(), definitions, synthesized: new Map(), gold, broken };
  }

  const inlineSchemas = new Map<string, SchemaTable[]>();
  if (ADVERSARIAL_ARMS.some((arm) => arm.definitions === 'inline')) {
    for (const db of dbs) {
      const bare = buildSchemas(settings.data, [db], false);
      const written = await synthesizeDefinitions({
        oracle: io.oracle,
        db,
        schema: schemas.get(db) as SchemaTable[],
        provider: io.provider,
        model: settings.model,
      });
      inlineSchemas.set(db, attachDefinitions(bare.get(db) as SchemaTable[], written).schema as SchemaTable[]);
    }
  }
  const synthesized = new Map<string, string>();
  for (const db of dbs) {
    synthesized.set(
      db,
      renderEvidence(await profileDatabase(io.oracle, db, { cacheDir: settings.profileCache })),
    );
  }
  return { settings, cases, dbs, schemas, inlineSchemas, definitions, synthesized, gold, broken };
}

export interface ArmOutcome {
  readonly id: string;
  readonly passed: boolean;
  readonly strict: boolean;
  readonly sql: string;
  readonly error?: string;
}

export interface ArmReport {
  readonly arm: string;
  readonly passed: number;
  readonly total: number;
  readonly accuracy: number;
  readonly wilson: { low: number; high: number };
  readonly strictPassed: number;
  readonly executionErrors: number;
  readonly byCategory: Readonly<Record<string, { passed: number; total: number }>>;
}

export function schemaForArm(
  arm: Arm,
  db: string,
  prepared: Pick<AdversarialPrepared, 'schemas' | 'inlineSchemas'>,
): SchemaTable[] {
  const chosen = arm.definitions === 'inline' ? (prepared.inlineSchemas.get(db) ?? prepared.schemas.get(db)) : prepared.schemas.get(db);
  if (chosen === undefined) throw new Error(`no schema for ${db}`);
  return chosen;
}

export async function runArm(
  arm: Arm,
  prepared: AdversarialPrepared,
  io: AdversarialIo,
): Promise<{ report: ArmReport; outcomes: ArmOutcome[] }> {
  const outcomes = await pool(prepared.cases, prepared.settings.concurrency, async (testCase): Promise<ArmOutcome> => {
    const pipeline = createPipeline({
      provider: io.provider,
      maxRepairs: arm.repairs,
      linking: arm.linking,
      prompt: promptFor(
        arm,
        testCase.question,
        prepared.synthesized.get(testCase.db),
        arm.definitions === 'inline' ? undefined : prepared.definitions.get(testCase.db),
      ),
    });
    try {
      const asked = await pipeline.ask({ question: testCase.question, schema: schemaForArm(arm, testCase.db, prepared) });
      const predicted = await io.oracle.run(testCase.db, asked.sql);
      const reference = prepared.gold.get(testCase.id) as readonly (readonly unknown[])[];
      return {
        id: testCase.id,
        passed: predicted.ok && judgeOfficial(reference, predicted.rows) === 'match',
        strict: predicted.ok && judgeStrict(reference, predicted.rows) === 'match',
        sql: asked.sql,
        ...(predicted.ok ? {} : { error: predicted.error }),
      };
    } catch (error) {
      return {
        id: testCase.id,
        passed: false,
        strict: false,
        sql: '',
        error: describeError(error),
      };
    }
  });
  const summary = summarise(arm.name, outcomes.map((entry) => ({ id: entry.id, passed: entry.passed })));
  const byCategory: Record<string, { passed: number; total: number }> = {};
  for (const testCase of prepared.cases) {
    const run = outcomes.find((entry) => entry.id === testCase.id);
    const bucket = (byCategory[testCase.category] ??= { passed: 0, total: 0 });
    bucket.total += 1;
    if (run?.passed === true) bucket.passed += 1;
  }
  return {
    report: {
      arm: arm.name,
      passed: summary.passed,
      total: summary.total,
      accuracy: summary.accuracy,
      wilson: wilsonInterval(summary.passed, summary.total),
      strictPassed: outcomes.filter((entry) => entry.strict).length,
      executionErrors: outcomes.filter((entry) => entry.error !== undefined).length,
      byCategory,
    },
    outcomes,
  };
}

/** The arm a comparison names, or an error: a rename must not silently re-point a delta. */
export function requireOutcomes(
  outcomes: ReadonlyMap<string, readonly ArmOutcome[]>,
  name: string,
): readonly ArmOutcome[] {
  const found = outcomes.get(name);
  if (found === undefined) {
    throw new Error(`the run has no '${name}' arm; it ran ${[...outcomes.keys()].join(', ')}`);
  }
  return found;
}

export function armNamed(outcomes: ReadonlyMap<string, readonly ArmOutcome[]>, name: string) {
  return summarise(
    name,
    requireOutcomes(outcomes, name).map((entry) => ({ id: entry.id, passed: entry.passed })),
  );
}

export function ablationFor(
  outcomes: ReadonlyMap<string, readonly ArmOutcome[]>,
  from: string,
  to: string,
): { delta: number; onlyFirst: number; onlySecond: number; p: number } {
  const paired = compareArms(armNamed(outcomes, from), armNamed(outcomes, to));
  return {
    delta: paired.delta,
    onlyFirst: paired.onlyFirst,
    onlySecond: paired.onlySecond,
    p: mcnemarExact(paired.onlyFirst, paired.onlySecond),
  };
}

/**
 * The artifact a case set that cannot run still produces.
 *
 * It carries the broken cases and nothing else: an `arms` array of zeroes beside a broken
 * gold is a report that looks like a measurement of a failure rather than a refusal to
 * measure.
 */
export function brokenReport(prepared: AdversarialPrepared): Record<string, unknown> {
  return {
    dataset: 'hand-written adversarial cases',
    databases: prepared.dbs,
    model: prepared.settings.model,
    generatedAt: new Date().toISOString(),
    cases: prepared.cases.length,
    gold: { runnable: prepared.gold.size, broken: prepared.broken },
    arms: [],
    ablations: {},
    perCategory: {},
    failures: {},
  };
}

export function adversarialReport(
  prepared: AdversarialPrepared,
  reports: readonly ArmReport[],
  outcomes: ReadonlyMap<string, readonly ArmOutcome[]>,
): Record<string, unknown> {
  const categories: readonly Category[] = ['window', 'ratio', 'multi-hop', 'tie'];
  const baseline = requireOutcomes(outcomes, 'names');
  const metadata = requireOutcomes(outcomes, 'metadata');
  const perCategory: Record<string, unknown> = {};
  for (const category of categories) {
    const ids = prepared.cases.filter((testCase) => testCase.category === category).map((testCase) => testCase.id);
    const before = ids.filter((id) => baseline.find((entry) => entry.id === id)?.passed === true).length;
    const after = ids.filter((id) => metadata.find((entry) => entry.id === id)?.passed === true).length;
    perCategory[category] = { cases: ids.length, names: before, metadata: after, delta: after - before };
  }
  return {
    dataset: 'hand-written adversarial cases',
    databases: prepared.dbs,
    model: prepared.settings.model,
    generatedAt: new Date().toISOString(),
    cases: prepared.cases.length,
    gold: { runnable: prepared.gold.size, broken: prepared.broken },
    arms: reports,
    ablations: {
      'names -> metadata': ablationFor(outcomes, 'names', 'metadata'),
      ...(outcomes.has('synthetic') ? { 'metadata -> synthetic': ablationFor(outcomes, 'metadata', 'synthetic') } : {}),
      ...(outcomes.has('adaptive') ? { 'metadata -> adaptive': ablationFor(outcomes, 'metadata', 'adaptive') } : {}),
    },
    perCategory,
    failures: Object.fromEntries(
      [...outcomes.entries()].map(([name, runs]) => [
        name,
        runs
          .filter((entry) => !entry.passed)
          .map((entry) => ({
            id: entry.id,
            question: prepared.cases.find((testCase) => testCase.id === entry.id)?.question,
            sql: entry.sql,
            error: entry.error,
          })),
      ]),
    ),
  };
}

/** The arm lines the workflow log shows. */
export function armLines(reports: readonly ArmReport[]): string[] {
  return reports.map(
    (report) =>
      `${report.arm.padEnd(9)} ${String(report.passed)}/${String(report.total)}  ` +
      `${(report.accuracy * 100).toFixed(1)}%  ${JSON.stringify(report.byCategory)}`,
  );
}

/** The line the workflow log shows for a case set that cannot run. */
export function brokenLine(broken: readonly { id: string; error: string }[]): string {
  return `gold problems: ${broken.map((entry) => `${entry.id} (${entry.error})`).join(', ')}`;
}

/** Where this run writes its artifact: a dry run must not overwrite a measured one. */
export function artifactPath(settings: AdversarialSettings): string {
  return settings.dryRun ? join(dirname(settings.out), 'adversarial-dry.json') : settings.out;
}

export function writeAdversarialArtifact(settings: AdversarialSettings, report: Record<string, unknown>): string {
  const path = artifactPath(settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

export interface AdversarialOutcome {
  readonly report: Record<string, unknown>;
  readonly prepared: AdversarialPrepared;
  readonly reports: readonly ArmReport[];
  /** What the workflow log should say. */
  readonly lines: readonly string[];
  /** Why the run must not be published: a broken case set, or a gate that did not hold. */
  readonly problems: readonly string[];
}

/**
 * The whole run, dry or real, as a value.
 *
 * The dry run is not a separate path in `main`: it is the same preparation, stopped before
 * the arms. Written that way, the thing a dry run validates is exactly the thing the real
 * run depends on, and a test can reach both without a `--dry-run` flag reaching into `main`.
 */
export async function runAdversarial(
  settings: AdversarialSettings,
  io: AdversarialIo,
): Promise<AdversarialOutcome> {
  const prepared = await prepareAdversarial(settings, io);
  // A broken gold is a defect in the case set, not a result: the report says which case and
  // why, and no arm runs.
  if (prepared.broken.length > 0) {
    return { report: brokenReport(prepared), prepared, reports: [], lines: [], problems: [brokenLine(prepared.broken)] };
  }
  if (settings.dryRun) {
    return {
      report: {
        cases: prepared.cases.length,
        gold: prepared.gold.size,
        broken: prepared.broken,
        generatedAt: new Date().toISOString(),
      },
      prepared,
      reports: [],
      lines: [
        `dry run: ${String(prepared.gold.size)}/${String(prepared.cases.length)} gold statements run, ` +
          'all widths agree with the questions',
      ],
      problems: [],
    };
  }
  const outcomes = new Map<string, readonly ArmOutcome[]>();
  const reports: ArmReport[] = [];
  for (const arm of ADVERSARIAL_ARMS) {
    const result = await runArm(arm, prepared, io);
    outcomes.set(arm.name, result.outcomes);
    reports.push(result.report);
  }
  const report = adversarialReport(prepared, reports, outcomes);
  const lines = [
    ...armLines(reports),
    `artifact: ${artifactPath(settings)}; gold ${String(prepared.gold.size)}/${String(prepared.cases.length)}`,
  ];
  // A harness that scores every arm at zero is not measuring a hard case set; it is not
  // measuring. The floor is low because the point is to catch "no signal", not to grade.
  const best = Math.max(...reports.map((arm) => arm.accuracy));
  const problems = best <= 0.05 ? ['GATE FAILED: no arm scored above 5%; the harness sees no signal'] : [];
  return { report, prepared, reports, lines, problems };
}

export async function main(
  env: Readonly<Record<string, string | undefined>> = process.env,
  argv: readonly string[] = process.argv.slice(2),
  root: string = ROOT,
): Promise<number> {
  const settings = resolveAdversarialSettings(env, argv, root);
  const oracle = createOracle(join(resolve(new URL('../bird', import.meta.url).pathname), 'oracle.py'), settings.databases);
  try {
    const provider = createHttpProvider({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
    });
    const outcome = await runAdversarial(settings, { oracle, provider });
    writeAdversarialArtifact(settings, outcome.report);
    for (const line of outcome.lines) console.log(line);
    for (const problem of outcome.problems) console.error(problem);
    return outcome.problems.length === 0 ? 0 : 1;
  } finally {
    await oracle.close();
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
