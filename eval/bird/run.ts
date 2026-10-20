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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHttpProvider } from '@agentix-e/nl2charts-ai';
import type { PromptOptions, SchemaTable } from '@agentix-e/nl2charts-ai';
import { buildSqlPrompt, choosePromptProfile, createPipeline, renderDefinitions, renderEvidence, renderSchemaCard } from '@agentix-e/nl2charts-ai';
import { compareArms, judgeOfficial, judgeStrict, mcnemarExact, summarise, wilsonInterval } from '@agentix-e/nl2charts-devkit';
import type { CaseOutcome, MatchReason } from '@agentix-e/nl2charts-devkit';
import { buildSchema, loadDescriptions, loadQuestions, loadTables, stratifiedSample } from './data.js';
import type { BirdQuestion } from './data.js';
import { createOracle } from './oracle.js';
import type { OracleResult } from './oracle.js';
import { profileDatabase } from './profile.js';
import { synthesizeDefinitions } from './synthesize.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const DATA = process.env.BIRD_DATA ?? join(ROOT, 'eval/.cache/bird/minidev/MINIDEV');
const DATABASES = process.env.BIRD_DATABASES ?? join(DATA, 'dev_databases');
/**
 * Which databases a run covers comes from the fetch manifest, so widening the
 * dataset is one command (`fetch.mjs`) rather than two edits that can drift.
 */
function databasesFromManifest(): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8')) as {
      databases?: { db: string }[];
    };
    return (manifest.databases ?? []).map((entry) => entry.db);
  } catch {
    return [];
  }
}

export interface Arm {
  readonly name: string;
  readonly notes: boolean;
  /**
   * Where the hint comes from. Modelled as one lever rather than a boolean pair:
   * "dataset hint" and "synthesized hint" are alternatives, not independent
   * switches, and an arm that flipped both would be a two-variable comparison.
   */
  readonly evidence?: 'dataset' | 'synthetic';
  readonly repairs: number;
  readonly linking: boolean;
  /** 'adaptive' lets the question shape choose the schema card and notes. */
  readonly profile?: 'adaptive';
  /**
   * Where the definition block comes from. Structural claims are derived from
   * the schema; synthesized ones are written once per database by the model.
   * Modelled as one lever for the same reason as the evidence source.
   */
  readonly definitions?: 'structural' | 'synthesized';
  /** Order synthesized evidence by the columns the question names. */
  readonly focus?: boolean;
}

/**
 * Each arm differs from its parent by exactly one thing, so a delta belongs to
 * one module:
 *
 *   names  ->  metadata          column labels, descriptions, join hints
 *   metadata  ->  metadata+evidence     the dataset's evidence hint
 *   metadata+evidence  ->  no-linking   our three-recaller schema linker
 *   metadata+evidence  ->  repair       the execution-feedback repair loop
 *
 * The previous round compared `full` (metadata + evidence + repair) against
 * `names`, which could not separate repair from the prompt changes.
 */
export const ARMS: readonly Arm[] = [
  { name: 'names', notes: false, repairs: 0, linking: true },
  { name: 'definitions', notes: false, repairs: 0, linking: true, definitions: 'structural' },
  { name: 'synth-definitions', notes: false, repairs: 0, linking: true, definitions: 'synthesized' },
  { name: 'definitions+evidence', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'structural' },
  { name: 'synth-definitions+evidence', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'synthesized' },
  { name: 'metadata', notes: true, repairs: 0, linking: true },
  { name: 'synthetic', notes: true, evidence: 'synthetic', repairs: 0, linking: true },
  { name: 'synthetic+focus', notes: true, evidence: 'synthetic', repairs: 0, linking: true, focus: true },
  { name: 'metadata+evidence', notes: true, evidence: 'dataset', repairs: 0, linking: true },
  { name: 'adaptive', notes: true, evidence: 'dataset', repairs: 0, linking: true, profile: 'adaptive' },
  // Available on demand (BIRD_ARMS=...,no-linking,repair). Both measured null in
  // the previous round and are kept instead of deleted, so a change that should
  // revive them can be tested without rewriting the harness.
  { name: 'no-linking', notes: true, evidence: 'dataset', repairs: 0, linking: false },
  { name: 'repair', notes: true, evidence: 'dataset', repairs: 2, linking: true },
];

export const PAIRS: readonly (readonly [string, string])[] = [
  ['names', 'definitions'],
  ['definitions', 'synth-definitions'],
  ['definitions', 'definitions+evidence'],
  ['synth-definitions', 'synth-definitions+evidence'],
  ['names', 'metadata'],
  ['metadata', 'synthetic'],
  ['synthetic', 'synthetic+focus'],
  ['synthetic', 'metadata+evidence'],
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
    limit: Number(process.env.BIRD_LIMIT ?? 240),
    concurrency: Number(process.env.BIRD_CONCURRENCY ?? 8),
    dbs: (process.env.BIRD_DBS !== undefined ? process.env.BIRD_DBS : databasesFromManifest().join(','))
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    // Default chain: baseline, the two definition sources, the synthesized one
    // with the dataset hint, and last round's best arm as the ceiling reference.
    arms: (process.env.BIRD_ARMS ?? ['names', 'definitions', 'synth-definitions', 'synth-definitions+evidence', 'metadata+evidence'].join(','))
      .split(',')
      .map((name) => name.trim()),
    out: process.env.BIRD_OUT ?? join(ROOT, 'eval/out/bird-eval.json'),
    model: process.env.LLM_MODEL ?? 'deepseek-chat',
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? '',
  };
}

export async function pool<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
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

export function promptFor(arm: Arm, question: BirdQuestion, synthesized?: string, definitions?: string): PromptOptions {
  const profile = arm.profile === 'adaptive' ? choosePromptProfile(question.question) : undefined;
  const evidence =
    arm.evidence === 'dataset' ? question.evidence : arm.evidence === 'synthetic' ? synthesized : undefined;
  return {
    dialect: 'SQLite',
    descriptions: profile?.descriptions ?? arm.notes,
    foreignKeys: profile?.foreignKeys ?? arm.notes,
    samples: false,
    schemaLines: 400,
    ...(profile === undefined ? {} : { notes: profile.notes }),
    ...(arm.definitions !== undefined && definitions !== undefined && definitions.length > 0 ? { definitions } : {}),
    ...(evidence === undefined || evidence.length === 0 ? {} : { evidence }),
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

  // 1. Schema fidelity. A prompt that advertises a column the database does not
  // have is a guaranteed failure, and it looks like a model error. The first
  // external run advertised BIRD's humanised names instead of the original ones
  // and 155 of 200 cases died on "no such column".
  const missingColumns: { db: string; table: string; column: string }[] = [];
  let checkedColumns = 0;
  for (const [db, schema] of schemas) {
    for (const table of schema) {
      const info = await oracle.run(db, `SELECT name FROM pragma_table_info('${table.table.replace(/'/g, "''")}')`);
      const present = new Set(info.rows.map((row) => String(row[0])));
      for (const column of table.columns) {
        checkedColumns += 1;
        if (!present.has(column.name)) missingColumns.push({ db, table: table.table, column: column.name });
      }
    }
  }

  // 2. Gold pre-execution. A case is scored only if its gold statement runs.
  // Synthesized evidence: a data profile per database, cached on disk after the
  // first run. The arm exists to answer one question — can a product without a
  // curated evidence column still get the gain that BIRD's evidence buys?
  const synthesized = new Map<string, string>();
  const profiles = new Map<string, Awaited<ReturnType<typeof profileDatabase>>>();
  for (const db of config.dbs) {
    try {
      const profile = await profileDatabase(oracle, db);
      profiles.set(db, profile);
      synthesized.set(db, renderEvidence(profile));
    } catch {
      synthesized.set(db, '');
    }
  }

  /**
   * Evidence text for one case. The focused arm re-renders the same profile with
   * the question's words, so the two arms differ only in line order — not in
   * which columns were profiled and not in the character budget.
   */
  /** The definition block this arm uses, if any. */
  const definitionsFor = (arm: Arm, db: string): string | undefined =>
    arm.definitions === 'synthesized' ? synthesizedDefinitions.get(db) : definitions.get(db);

  const evidenceFor = (arm: Arm, question: BirdQuestion): string | undefined => {
    if (arm.evidence !== 'synthetic') return undefined;
    const profile = profiles.get(question.db_id);
    if (profile === undefined) return undefined;
    return arm.focus === true ? renderEvidence(profile, { focus: question.question }) : synthesized.get(question.db_id);
  };

  // Structural semantics per database. Kept separate from the value profile:
  // one block says what a column means, the other says what it contains.
  const definitions = new Map<string, string>();
  for (const [db, schema] of schemas) definitions.set(db, renderDefinitions(schema));

  // Written once per database, cached on disk. The model that writes them is the
  // same one under test, but it sees only schema, values and a couple of rows —
  // never a question, never a gold statement.
  const synthesizedDefinitions = new Map<string, string>();
  const needsSynthesis = config.arms.some((name) => ARMS.find((arm) => arm.name === name)?.definitions === 'synthesized');
  const provider = createHttpProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
  if (!config.dryRun && needsSynthesis) {
    for (const [db, schema] of schemas) {
      try {
        synthesizedDefinitions.set(
          db,
          await synthesizeDefinitions({
            oracle,
            db,
            schema,
            ...(profiles.get(db) === undefined ? {} : { profile: profiles.get(db) as NonNullable<ReturnType<typeof profiles.get>> }),
            provider,
            model: config.model,
            force: process.env.BIRD_DEFINITIONS_FORCE === '1',
          }),
        );
      } catch {
        synthesizedDefinitions.set(db, '');
      }
    }
  }

  const gold = new Map<number, OracleResult>();
  const unrunnable: { id: number; db: string; error: string }[] = [];
  for (const question of selected) {
    const result = await oracle.run(question.db_id, question.SQL);
    if (result.ok) gold.set(question.question_id, result);
    else unrunnable.push({ id: question.question_id, db: question.db_id, error: result.error ?? 'unknown' });
  }
  const cases = selected.filter((question) => gold.has(question.question_id));

  // 3. Prompt coverage: a truncated schema card silently drops tables, and a
  // model cannot query what it was never shown.
  let tablesInPrompts = 0;
  let tablesTotal = 0;
  const truncated: { db: string; shown: number; total: number }[] = [];
  for (const [db, schema] of schemas) {
    const card = renderSchemaCard(schema, 2000, { descriptions: true, foreignKeys: true, samples: false });
    const shown = card.split('\n').filter((line) => !line.startsWith('  ')).length;
    tablesInPrompts += shown;
    tablesTotal += schema.length;
    if (shown !== schema.length) truncated.push({ db, shown, total: schema.length });
  }

  // 4. Controls. Both must hold before any accuracy number is meaningful.
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
      schemaChecked: checkedColumns,
      schemaMissing: missingColumns.slice(0, 10),
      schemaMissingTotal: missingColumns.length,
      tablesInPrompts,
      tablesTotal,
      truncatedPrompts: truncated,
      // How much of the schema yields a structural claim at all. A database of
      // free-text columns produces nothing, and that is a fact about the method
      // worth reporting next to its accuracy.
      semanticsDatabases: [...definitions.values()].filter((text) => text.length > 0).length,
      semanticsDatabaseTotal: definitions.size,
      semanticsCases: cases.filter((question) => (definitions.get(question.db_id) ?? '').length > 0).length,
      semanticsMeanChars: Math.round(
        [...definitions.values()].reduce((total, text) => total + text.length, 0) / Math.max(1, definitions.size),
      ),
      synthesizedDefinitionDatabases: [...synthesizedDefinitions.values()].filter((text) => text.length > 0).length,
      // The text itself, so a claim about what the model wrote can be checked
      // from the artifact instead of trusted.
      synthesizedDefinitions: Object.fromEntries(synthesizedDefinitions),
      synthesizedDefinitionMeanChars: Math.round(
        [...synthesizedDefinitions.values()].reduce((total, text) => total + text.length, 0) /
          Math.max(1, synthesizedDefinitions.size),
      ),
    },
  };

  if (config.dryRun) {
    const withSemantics = cases.find((question) => (definitions.get(question.db_id) ?? '').length > 0);
    const prompts = cases.slice(0, 3).map((question) => ({
      id: question.question_id,
      prompt: buildSqlPrompt(
        question.question,
        schemas.get(question.db_id) as SchemaTable[],
        promptFor(ARMS[0] as Arm, question),
      ),
      ...(withSemantics === undefined || withSemantics.question_id !== question.question_id
        ? {}
        : {
            definitionsPrompt: buildSqlPrompt(
              question.question,
              schemas.get(question.db_id) as SchemaTable[],
              promptFor(ARMS[1] as Arm, question, undefined, definitionsFor(ARMS[1] as Arm, question.db_id)),
            ),
          }),
    }));
    report.prompts = prompts;
    report.arms = [];
    finish(config, report);
    await oracle.close();
    return;
  }

  // 5. Arms.
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
        linking: arm.linking,
        prompt: promptFor(arm, question, evidenceFor(arm, question), definitions.get(question.db_id)),
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
    const promptSizes = cases.map(
      (question) =>
        buildSqlPrompt(
          question.question,
          schemas.get(question.db_id) as SchemaTable[],
          promptFor(arm, question, evidenceFor(arm, question), definitionsFor(arm, question.db_id)),
        ).length,
    );
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
      promptChars: {
        mean: Math.round(promptSizes.reduce((total, size) => total + size, 0) / Math.max(1, promptSizes.length)),
        max: Math.max(0, ...promptSizes),
      },
      byDifficulty,
      errors,
      topErrors: [...messages.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5),
    });
    console.log(
      `${arm.name.padEnd(9)} ${summary.passed}/${summary.total}  ${(summary.accuracy * 100).toFixed(1)}%  strict ${strictPassed}  repaired ${runs.filter((run) => run.attempts > 1).length}`,
    );
  }

  const ablations: Record<string, unknown> = {};
  for (const [from, to] of PAIRS) {
    const first = outcomes.get(from);
    const second = outcomes.get(to);
    if (first === undefined || second === undefined) continue;
    const comparison = compareArms(summarise(from, first), summarise(to, second));
    ablations[`${from} -> ${to}`] = {
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
    const controls = report.controls as { selfConsistency: number; negativeFalseMatches: number; schemaChecked: number; schemaMissingTotal: number };
    console.log(
      `dry run: gold runnable ${String((report.gold as { runnable: number }).runnable)}/${String((report.gold as { executed: number }).executed)}; ` +
        `self-consistency ${(controls.selfConsistency * 100).toFixed(1)}%; negative false matches ${String(controls.negativeFalseMatches)}; ` +
        `schema columns checked ${String(controls.schemaChecked)}, missing ${String(controls.schemaMissingTotal)}`,
    );
  }
}

/** Thresholds, not decoration: a run that trips one of these must fail CI. */
function gate(report: Record<string, unknown>): void {
  const goldRate = (report.gold as { runnableRate: number }).runnableRate;
  const controls = report.controls as {
    selfConsistency: number;
    negativeFalseMatches: number;
    schemaMissingTotal: number;
    schemaChecked: number;
  };
  const arms = report.arms as { arm: string; accuracy: number }[];
  const problems: string[] = [];
  if (goldRate < 0.98) problems.push(`gold runnable rate ${(goldRate * 100).toFixed(1)}% is below 98%`);
  if (controls.selfConsistency < 1) problems.push(`self-consistency ${(controls.selfConsistency * 100).toFixed(1)}% is not 100%`);
  if (controls.negativeFalseMatches !== 0) problems.push(`${controls.negativeFalseMatches} negative control(s) matched a gold result`);
  if (controls.schemaMissingTotal !== 0) {
    problems.push(`${controls.schemaMissingTotal} of ${controls.schemaChecked} advertised columns do not exist in the database`);
  }
  const truncated = (report.controls as { truncatedPrompts: { db: string; shown: number; total: number }[] }).truncatedPrompts;
  if (truncated.length > 0) {
    problems.push(`schema card truncated for ${truncated.map((entry) => `${entry.db} (${entry.shown}/${entry.total})`).join(', ')}`);
  }
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
