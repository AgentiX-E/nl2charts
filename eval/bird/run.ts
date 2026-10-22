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
import { applySelection, attachDefinitions, buildSelectionPrompt, buildSqlPrompt, choosePromptProfile, createPipeline, renderDefinitions, renderEvidence, renderSchemaCard } from '@agentix-e/nl2charts-ai';
import { compareArms, judgeOfficial, judgeStrict, majorityResult, mcnemarExact, summarise, wilsonInterval } from '@agentix-e/nl2charts-devkit';
import type { CaseOutcome, MatchReason } from '@agentix-e/nl2charts-devkit';
import { buildSchema, loadDescriptions, loadQuestions, loadTables, stratifiedSample } from './data.js';
import type { BirdQuestion } from './data.js';
import { createOracle } from './oracle.js';
import type { OracleResult } from './oracle.js';
import { profileDatabase } from './profile.js';
import { buildIndex, renderDemonstrations, renderRetrieved, retrieve } from './retrieval.js';
import { buildValueIndex, findValues, renderValues } from './values.js';
import { synthesizeRecord } from './synthesize.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
/**
 * Which split is being measured.
 *
 * `minidev` is the 500-question subset CI runs on every commit. `dev` is the
 * 1,534-question split the published leaderboards report, kept for on-demand runs
 * because a full sweep costs a model call per question per arm.
 */
const SPLIT = (process.env.BIRD_SPLIT ?? 'minidev') as 'minidev' | 'dev';
const DATA =
  process.env.BIRD_DATA ??
  (SPLIT === 'dev' ? join(ROOT, 'eval/.cache/bird/dev/dev_20240627') : join(ROOT, 'eval/.cache/bird/minidev/MINIDEV'));
/** The file name differs per split; everything else in the layout is identical. */
const QUESTIONS_FILE = SPLIT === 'dev' ? 'dev.json' : 'mini_dev_sqlite.json';
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

/** The splits that ship a manifest are the derived ones; `dev` does not. */
function databasesFromQuestions(): string[] {
  try {
    const questions = loadQuestions(join(DATA, QUESTIONS_FILE));
    return [...new Set(questions.map((question) => question.db_id))].sort();
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
  readonly evidence?: 'dataset' | 'synthetic' | 'retrieved';
  readonly repairs: number;
  readonly linking: boolean;
  /** 'adaptive' lets the question shape choose the schema card and notes. */
  readonly profile?: 'adaptive';
  /**
   * Where the definition block comes from. Structural claims are derived from
   * the schema; synthesized ones are written once per database by the model.
   * Modelled as one lever for the same reason as the evidence source.
   */
  readonly definitions?: 'structural' | 'synthesized' | 'inline' | 'dataset-subset';
  /** Order synthesized evidence by the columns the question names. */
  readonly focus?: boolean;
  /** Ask for a reading of the question before writing SQL (one extra call). */
  readonly interpret?: boolean;
  /** Samples per question; the modal executed result wins. */
  readonly vote?: number;
  /**
   * Retrieved (question, evidence, SQL) triples from the training split, rendered as
   * worked examples. This is the lever DAIL-SQL and CHASE-SQL build on; here it is one
   * switch away from `inline+retrieval`, which supplies the same neighbours as text.
   */
  readonly demonstrations?: boolean;
  /**
   * Who chooses among the samples: the modal executed result (default) or the model
   * reading the candidates. Same samples, same count — one lever.
   */
  readonly select?: boolean;
  /**
   * Column values the question names, resolved against the database under test.
   * The instance-specific counterpart to retrieved knowledge, which is generic.
   */
  readonly values?: boolean;
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
  { name: 'inline-definitions', notes: false, repairs: 0, linking: true, definitions: 'inline' },
  // The dataset's own descriptions, truncated to the columns the inline arm
  // reached. Same placement, same columns, different author: the only way to
  // tell coverage apart from source quality.
  { name: 'dataset-subset', notes: false, repairs: 0, linking: true, definitions: 'dataset-subset' },
  { name: 'inline+evidence', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline' },
  // Retrieved knowledge instead of the dataset's per-question hint: the nearest
  // labelled questions from BIRD's train split, which shares no database with the
  // split under test. The arm exists to test whether the 13.8pp is knowledge or
  // the dataset's own wording.
  { name: 'inline+retrieval', notes: false, evidence: 'retrieved', repairs: 0, linking: true, definitions: 'inline' },
  // The same retrieved neighbours, but as worked examples with their statements.
  // Paired with `inline+retrieval`: one lever, so the delta prices the statements.
  { name: 'inline+icl', notes: false, evidence: 'retrieved', repairs: 0, linking: true, definitions: 'inline', demonstrations: true },
  // The only text that has measured is written per question; this arm writes it.
  { name: 'interpret', notes: false, repairs: 0, linking: true, definitions: 'inline', interpret: true },
  // Self-consistency over executed answers: no external knowledge, pure variance
  // reduction. Three samples at temperature 0.7, modal result set wins.
  { name: 'vote', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3 },
  // The same three samples, chosen by the model instead of counted: CHASE-SQL's
  // selection agent, without its fine-tuned weights, so the comparison prices the
  // idea rather than their training run.
  { name: 'select', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true },
  // The same inline arm plus the literals the question names, resolved against this
  // database. CHASE-SQL's first pipeline stage; here it is one lever from
  // `inline+evidence`, so the delta prices value grounding, not the hint.
  { name: 'values', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', values: true },
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

/**
 * The chain `pnpm bench:bird` runs when `BIRD_ARMS` is unset.
 *
 * This is a separate list from `ARMS` on purpose: the default chain is a budget
 * decision (seven arms x 500 questions), while `ARMS` is the catalogue. The cost of
 * that split showed up as a real bug — `inline+retrieval` was written, wired, paired
 * and never executed, because the chain is a second list that nothing forces you to
 * update. `test/bird-arms.test.ts` now demands a partition: every arm is either in
 * the chain or in `ON_DEMAND_ARMS` with a stated reason.
 */
export const DEFAULT_ARMS: readonly string[] = [
  'names',
  'synth-definitions',
  'inline-definitions',
  'inline+evidence',
  // Knowledge retrieved from BIRD's training split: the arm that tests whether the
  // 14pp from the per-question hint is knowledge or the dataset's own wording.
  'inline+retrieval',
  'inline+icl',
  'vote',
  'select',
  'values',
  'metadata+evidence',
];

/**
 * Arms that exist for on-demand runs, each with the reason it is not in the chain.
 * An arm that is neither here nor in `DEFAULT_ARMS` fails the suite.
 */
export const ON_DEMAND_ARMS: Readonly<Record<string, string>> = {
  definitions: 'structural semantics built from keys: superseded by inline placement, kept as the parent of definitions+evidence',
  'dataset-subset': 'isolates coverage from author, run when a definition arm moves',
  'definitions+evidence': 'second lever of the semantics chain, not a candidate for the chain itself',
  'synth-definitions+evidence': 'combines two levers already measured separately',
  interpret: 'one extra call per question; measured null, kept for re-testing',
  metadata: 'no definitions at all: parent of metadata+evidence, run only to re-derive the parent',
  synthetic: 'profiles as evidence: measured null',
  'synthetic+focus': 'profile plus a focus instruction: measured null',
  adaptive: 'per-database prompt profile: measured null',
  'no-linking': 'removes the schema linker: the arm that prices linking, run when linking changes',
  repair: 'execution-feedback repair: measured null, run when the repair path changes',
};

export const PAIRS: readonly (readonly [string, string])[] = [
  ['names', 'definitions'],
  ['definitions', 'synth-definitions'],
  ['synth-definitions', 'inline-definitions'],
  ['inline-definitions', 'dataset-subset'],
  ['inline-definitions', 'inline+evidence'],
  ['inline-definitions', 'inline+retrieval'],
  ['inline+retrieval', 'inline+icl'],
  ['inline-definitions', 'interpret'],
  ['inline+evidence', 'vote'],
  ['vote', 'select'],
  ['inline+evidence', 'values'],
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
  /** Share of samples that agreed with the answer the arm returned. */
  readonly agreement?: number;
  /** True when the selector returned a usable index; absent for the modal arm. */
  readonly selectedByModel?: boolean;
  readonly error?: string;
  readonly errorKind?: 'execution' | 'guard' | 'llm' | 'other';
  readonly attempts: number;
}

/**
 * How many questions to score.
 *
 * The default is the whole split: a cap is a sample, and the previous hard-coded
 * 240 was read as the dataset's size for two releases. An unset, empty or
 * unparseable value means "the whole split" rather than zero, because
 * `workflow_dispatch` passes an empty string when the input is left blank and
 * `Number('')` is 0 — which would score nothing and report an accuracy over an
 * empty sample.
 */
/**
 * Resolve an arm name to its definition.
 *
 * An A/A pair is the same arm twice, named `<arm>#2`: the suffix is stripped here so
 * the duplicate runs the identical configuration. Two arms that differ in anything
 * would measure that difference instead of the harness's noise.
 */
export function resolveArm(name: string): Arm | undefined {
  const base = name.includes('#') ? name.slice(0, name.indexOf('#')) : name;
  return ARMS.find((arm) => arm.name === base);
}

export function parseLimit(raw: string | undefined, split: 'minidev' | 'dev'): number {
  const fallback = split === 'dev' ? 1534 : 500;
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function settings() {
  const argv = process.argv.slice(2);
  return {
    dryRun: argv.includes('--dry-run'),
    limit: parseLimit(process.env.BIRD_LIMIT, SPLIT),
    concurrency: Number(process.env.BIRD_CONCURRENCY ?? 8),
    dbs: (
      process.env.BIRD_DBS !== undefined
        ? process.env.BIRD_DBS
        : (databasesFromManifest().length > 0 ? databasesFromManifest() : databasesFromQuestions()).join(',')
    )
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    // Default chain: baseline, the two definition sources, the synthesized one
    // with the dataset hint, and last round's best arm as the ceiling reference.
    arms: (() => {
      const requested = (process.env.BIRD_ARMS ?? DEFAULT_ARMS.join(',')).split(',').map((name) => name.trim());
      // `BIRD_AA=<arm>` appends the same arm a second time under a `#2` name. The
      // delta between the pair is the harness's own noise at this sample size, which
      // no amount of within-run pairing between *different* arms can reveal.
      const aa = process.env.BIRD_AA?.trim();
      return aa === undefined || aa === '' ? requested : [...requested, `${aa}#2`];
    })(),
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

/** Every block an arm could use. Callers supply what they have; the arm decides. */
export interface PromptBlocks {
  /** Synthesized hint (data profile rendered as text). */
  readonly synthesized?: string;
  readonly definitions?: string;
  /** Retrieved neighbours as text, without statements. */
  readonly retrieved?: string;
  /** Retrieved neighbours as worked examples, statements included. */
  readonly demonstrations?: string;
  /** Values from this database that the question names. */
  readonly values?: string;
}

/**
 * Render an arm's prompt options.
 *
 * The arm chooses which blocks it uses, and the caller only says what is available.
 * That shape exists because the previous one — six optional positional arguments —
 * let the live prompt and the prompt-size measurement diverge: the size was computed
 * with the retrieved block, the request was sent without it, and the arm's accuracy
 * was then read as evidence that retrieval does not help.
 */
export function promptFor(arm: Arm, question: BirdQuestion, blocks: PromptBlocks = {}): PromptOptions {
  const { synthesized, definitions, retrieved, demonstrations, values } = blocks;
  const profile = arm.profile === 'adaptive' ? choosePromptProfile(question.question) : undefined;
  const evidence =
    arm.evidence === 'dataset'
      ? question.evidence
      : arm.evidence === 'synthetic'
        ? synthesized
        : arm.evidence === 'retrieved'
          ? retrieved
          : undefined;
  return {
    dialect: 'SQLite',
    // The inline arm is a placement experiment: the same sentences, attached to
    // the column line the metadata block uses. Descriptions on is part of that
    // placement, not a second lever.
    descriptions:
      arm.definitions === 'inline' || arm.definitions === 'dataset-subset' ? true : (profile?.descriptions ?? arm.notes),
    foreignKeys: profile?.foreignKeys ?? arm.notes,
    samples: false,
    schemaLines: 400,
    ...(profile === undefined ? {} : { notes: profile.notes }),
    ...(arm.definitions !== undefined && definitions !== undefined && definitions.length > 0 ? { definitions } : {}),
    ...(evidence === undefined || evidence.length === 0 ? {} : { evidence }),
    ...(arm.demonstrations === true && demonstrations !== undefined && demonstrations.length > 0
      ? { demonstrations }
      : {}),
    ...(arm.values === true && values !== undefined && values.length > 0 ? { values } : {}),
  };
}

async function main() {
  const config = settings();
  const questions = loadQuestions(join(DATA, QUESTIONS_FILE)).filter((question) => config.dbs.includes(question.db_id));
  if (questions.length === 0) throw new Error(`no questions for ${config.dbs.join(',')}; run node eval/bird/fetch.mjs first`);
  const tables = loadTables(join(DATA, 'dev_tables.json'));
  const selected = stratifiedSample(questions, config.limit);
  // The training split is external knowledge, not a held-out answer: it shares no
  // database with the split under test, which is asserted in the run controls.
  const trainPath = join(ROOT, 'eval/.cache/bird/train/train.json');
  let retrievalIndex: ReturnType<typeof buildIndex> | undefined;
  try {
    retrievalIndex = buildIndex(JSON.parse(readFileSync(trainPath, 'utf8')) as { db_id: string; question: string; evidence?: string }[]);
  } catch {
    retrievalIndex = undefined;
  }
  const needsRetrieval = config.arms.some((name) => {
    const arm = resolveArm(name);
    return arm?.evidence === 'retrieved' || arm?.demonstrations === true;
  });
  if (needsRetrieval && retrievalIndex === undefined) {
    // An arm whose lever has no input is the parent arm with a different name: it ran
    // once, scored 44.4% against its parent's 43.6%, and the near-equality was read as
    // "retrieval does not help" when the truth was that nothing was retrieved.
    throw new Error(
      `arm(s) ${config.arms.join(',')} need the BIRD training split; ` +
        'run BIRD_SPLIT=train node eval/bird/fetch.mjs first (or drop the arms with BIRD_ARMS)',
    );
  }
  // Built once per selected question rather than once per arm: the blocks are inputs,
  // and recomputing them per arm made an empty result indistinguishable from a slow one.
  const retrievedByQuestion = new Map<number, string>();
  const demonstrationsByQuestion = new Map<number, string>();
  for (const question of selected) {
    if (retrievalIndex === undefined) break;
    const textHits = retrieve(retrievalIndex, question.question, { k: 3 });
    const text = renderRetrieved(textHits);
    if (text.length > 0) retrievedByQuestion.set(question.question_id, text);
    // Same corpus, same ranking, same k: the only difference from the evidence block
    // is that each neighbour arrives with its statement.
    const worked = renderDemonstrations(retrieve(retrievalIndex, question.question, { k: 3, requires: 'sql' }));
    if (worked.length > 0) demonstrationsByQuestion.set(question.question_id, worked);
  }
  const retrievedFor = (question: BirdQuestion): string | undefined => retrievedByQuestion.get(question.question_id);
  const demonstrationsFor = (question: BirdQuestion): string | undefined =>
    demonstrationsByQuestion.get(question.question_id);

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

  // Value grounding: the literals the question names, looked up in this database.
  const valueIndexes = new Map<string, ReturnType<typeof buildValueIndex>>();
  for (const [db, profile] of profiles) valueIndexes.set(db, buildValueIndex(profile));
  const valuesByQuestion = new Map<number, string>();
  for (const question of selected) {
    const index = valueIndexes.get(question.db_id);
    if (index === undefined) continue;
    const text = renderValues(findValues(index, question.question));
    if (text.length > 0) valuesByQuestion.set(question.question_id, text);
  }
  const valuesFor = (question: BirdQuestion): string | undefined => valuesByQuestion.get(question.question_id);

  /**
   * Evidence text for one case. The focused arm re-renders the same profile with
   * the question's words, so the two arms differ only in line order — not in
   * which columns were profiled and not in the character budget.
   */
  const evidenceFor = (arm: Arm, question: BirdQuestion): string | undefined => {
    if (arm.evidence !== 'synthetic') return undefined;
    const profile = profiles.get(question.db_id);
    if (profile === undefined) return undefined;
    return arm.focus === true ? renderEvidence(profile, { focus: question.question }) : synthesized.get(question.db_id);
  };

  /**
   * What this arm's prompt may use. One builder for every call site, so the prompt
   * that is measured and the prompt that is sent cannot disagree.
   */
  const blocksFor = (arm: Arm, question: BirdQuestion): PromptBlocks => ({
    ...(evidenceFor(arm, question) === undefined ? {} : { synthesized: evidenceFor(arm, question) }),
    ...(definitionsFor(arm, question.db_id) === undefined ? {} : { definitions: definitionsFor(arm, question.db_id) }),
    ...(retrievedFor(question) === undefined ? {} : { retrieved: retrievedFor(question) }),
    ...(demonstrationsFor(question) === undefined ? {} : { demonstrations: demonstrationsFor(question) }),
    ...(valuesFor(question) === undefined ? {} : { values: valuesFor(question) }),
  });

  // Structural semantics per database. Kept separate from the value profile:
  // one block says what a column means, the other says what it contains.
  const definitions = new Map<string, string>();
  for (const [db, schema] of schemas) definitions.set(db, renderDefinitions(schema));

  // Written once per database, cached on disk. The model that writes them is the
  // same one under test, but it sees only schema, values and a couple of rows —
  // never a question, never a gold statement.
  const synthesizedDefinitions = new Map<string, string>();
  /** Provenance per database: the prompt hash and whether the model was called. */
  const definitionsProvenance: Record<string, { hash: string; cached: boolean }> = {};
  const needsSynthesis = config.arms.some((name) => {
    const source = resolveArm(name)?.definitions;
    return source === 'synthesized' || source === 'inline';
  });
  const provider = createHttpProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
  if (!config.dryRun && needsSynthesis) {
    for (const [db, schema] of schemas) {
      try {
        const outcome = await synthesizeRecord({
          oracle,
          db,
          schema,
          ...(profiles.get(db) === undefined ? {} : { profile: profiles.get(db) as NonNullable<ReturnType<typeof profiles.get>> }),
          provider,
          model: config.model,
          force: process.env.BIRD_DEFINITIONS_FORCE === '1',
        });
        synthesizedDefinitions.set(db, outcome.definitions);
        definitionsProvenance[db] = { hash: outcome.hash, cached: outcome.cached };
      } catch {
        synthesizedDefinitions.set(db, '');
      }
    }
  }

  /**
   * The same sentences, attached to the column lines. Placement is the variable:
   * content, cache and budget are identical to the synthesized block.
   */
  // Bare schemas: no dataset labels, no dataset descriptions. The inline arm must
  // carry our definitions and nothing else, or it re-measures the metadata lever
  // that was already measured in an earlier round.
  const bareSchemas = new Map<string, SchemaTable[]>();
  for (const db of config.dbs) {
    const table = tables.get(db);
    if (table === undefined) continue;
    bareSchemas.set(
      db,
      buildSchema(table, loadDescriptions(join(DATA, 'dev_databases', db, 'database_description'), table.tableNames), {
        withNotes: false,
      }),
    );
  }

  const inlineSchemas = new Map<string, SchemaTable[]>();
  let inlineAttached = 0;
  let inlineUnplaced = 0;
  for (const [db, schema] of bareSchemas) {
    const placed = attachDefinitions(schema, synthesizedDefinitions.get(db) ?? '');
    inlineSchemas.set(db, placed.schema as SchemaTable[]);
    inlineAttached += placed.attached;
    inlineUnplaced += placed.unplaced.length;
  }

  /** The definition block this arm uses, if any (inline arms carry it per column). */
  const definitionsFor = (arm: Arm, db: string): string | undefined => {
    if (arm.definitions === 'inline' || arm.definitions === 'dataset-subset') return undefined;
    return arm.definitions === 'synthesized' ? synthesizedDefinitions.get(db) : definitions.get(db);
  };

  // The dataset's descriptions, cut down to the columns the inline arm reached.
  // Anything the inline arm could not address is removed here too, so the two
  // arms differ in the author of the text and nothing else.
  const subsetSchemas = new Map<string, SchemaTable[]>();
  for (const [db, schema] of schemas) {
    const reached = new Set<string>();
    for (const table of (inlineSchemas.get(db) ?? []) as SchemaTable[]) {
      for (const column of table.columns) {
        if (column.comment !== undefined) reached.add(`${table.table}\u0000${column.name}`);
      }
    }
    subsetSchemas.set(
      db,
      schema.map((table) => ({
        ...table,
        columns: table.columns.map((column) =>
          reached.has(`${table.table}\u0000${column.name}`) ? column : { name: column.name, type: column.type },
        ),
      })),
    );
  }

  const schemaFor = (arm: Arm, db: string): SchemaTable[] => {
    if (arm.definitions === 'inline') return inlineSchemas.get(db) as SchemaTable[];
    if (arm.definitions === 'dataset-subset') return subsetSchemas.get(db) as SchemaTable[];
    return schemas.get(db) as SchemaTable[];
  };


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
      split: SPLIT,
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
      // Corpus and block counts live here, not under `selection`: they are inputs to
      // an arm, and the gate reads them to tell a null result from an empty lever.
      retrievalCorpus: retrievalIndex === undefined ? 0 : retrievalIndex.rows.length,
      retrievedBlocks: retrievedByQuestion.size,
      demonstrationBlocks: demonstrationsByQuestion.size,
      valueMatches: valuesByQuestion.size,
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
      // Which databases were written in this run and which came from cache, with the
      // prompt hash: the difference between "the input changed" and "the model
      // answered differently" is otherwise a guess.
      definitionsProvenance,
      // The text itself, so a claim about what the model wrote can be checked
      // from the artifact instead of trusted.
      synthesizedDefinitions: Object.fromEntries(synthesizedDefinitions),
      inlineAttached,
      inlineUnplaced,
      subsetComments: [...subsetSchemas.values()].reduce(
        (total, schema) =>
          total + schema.reduce((count, table) => count + table.columns.filter((column) => column.comment !== undefined).length, 0),
        0,
      ),
      // How many columns in the inline schema carry any comment at all. If this
      // ever approaches the 798 dataset columns, the arm is measuring the
      // metadata lever again instead of placement.
      inlineSchemaComments: [...inlineSchemas.values()].reduce(
        (total, schema) =>
          total + schema.reduce((count, table) => count + table.columns.filter((column) => column.comment !== undefined).length, 0),
        0,
      ),
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
              promptFor(ARMS[1] as Arm, question, blocksFor(ARMS[1] as Arm, question)),
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
    const arm = resolveArm(name);
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
        interpret: arm.interpret === true,
        temperature: arm.vote === undefined ? 0 : 0.7,
        prompt: promptFor(arm, question, blocksFor(arm, question)),
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
      if (arm.vote !== undefined && arm.vote > 1) {
        const candidates: { sql: string; rows: readonly (readonly unknown[])[] }[] = [];
        for (let sample = 0; sample < arm.vote; sample += 1) {
          try {
            const askedSample = await pipeline.ask({ question: question.question, schema });
            const executed = await oracle.run(question.db_id, askedSample.sql);
            if (executed.ok) candidates.push({ sql: askedSample.sql, rows: executed.rows });
          } catch {
            // A sample that fails the guard or the engine casts no vote; the
            // other samples still produce one.
          }
        }
        if (candidates.length === 0) {
          return {
            id: String(question.question_id),
            passed: false,
            predicted: '',
            reason: 'values',
            strict: false,
            attempts: arm.vote,
            error: 'no sample survived guard and execution',
          };
        }
        const majority = majorityResult(candidates, (left, right) => judgeOfficial(left.rows, right.rows) === 'match');
        let winner = majority.winner as { sql: string; rows: readonly (readonly unknown[])[] };
        let selectedByModel: boolean | undefined;
        if (arm.select === true) {
          // The model sees what the vote cannot: the shape of each result. A statement
          // that answers a "how many" with 500 rows is wrong for a reason no majority
          // of identical mistakes will reveal.
          const offered = candidates.map((candidate) => ({
            sql: candidate.sql,
            rows: candidate.rows.length,
            columns: candidate.rows[0]?.length ?? 0,
            preview: JSON.stringify(candidate.rows.slice(0, 3)).slice(0, 300),
          }));
          const reply = await provider.complete({
            messages: [
              { role: 'system', content: buildSelectionPrompt(question.question, offered) },
              { role: 'user', content: question.question },
            ],
            temperature: 0,
          });
          const decision = applySelection(reply.text, offered);
          winner = candidates[decision.index] as typeof winner;
          selectedByModel = decision.decided;
        }
        const reason = judgeOfficial(expected.rows, winner.rows);
        return {
          id: String(question.question_id),
          passed: reason === 'match',
          predicted: winner.sql,
          reason,
          strict: judgeStrict(expected.rows, winner.rows) === 'match',
          attempts: candidates.length,
          agreement: majority.agreement,
          ...(selectedByModel === undefined ? {} : { selectedByModel }),
        };
      }
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
          schemaFor(arm, question.db_id),
          promptFor(arm, question, blocksFor(arm, question)),
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
      ...(arm.vote === undefined
        ? {}
        : {
            vote: arm.vote,
            agreement: runs.reduce((total, run) => total + (run.agreement ?? 0), 0) / Math.max(1, runs.filter((run) => run.agreement !== undefined).length),
            selector: arm.select === true ? 'model' : 'majority',
            // How often the selector produced a usable index. A selector that fails to
            // answer half the time is not a null result; it is a broken prompt.
            ...(arm.select === true
              ? {
                  selectorDecided: runs.filter((run) => run.selectedByModel === true).length,
                  selectorTotal: runs.filter((run) => run.selectedByModel !== undefined).length,
                }
              : {}),
          }),
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

  // The A/A pair, when one ran: same arm, same data, same prompt — twice.
  const aaPair = config.arms.find((name) => name.endsWith('#2'));
  const aa =
    aaPair === undefined
      ? undefined
      : (() => {
          const base = aaPair.slice(0, -2);
          const first = outcomes.get(base);
          const second = outcomes.get(aaPair);
          if (first === undefined || second === undefined) return undefined;
          const comparison = compareArms(summarise(base, first), summarise(aaPair, second));
          return {
            arm: base,
            delta: comparison.delta,
            onlyFirst: comparison.onlyFirst,
            onlySecond: comparison.onlySecond,
            p: mcnemarExact(comparison.onlyFirst, comparison.onlySecond),
          };
        })();
  if (aa !== undefined) {
    report.aa = aa;
    console.log(
      `A/A ${aa.arm}: ${(aa.delta * 100).toFixed(1)}pp (${String(aa.onlyFirst)}/${String(aa.onlySecond)}, p=${aa.p.toFixed(3)}) — the harness's own noise`,
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
