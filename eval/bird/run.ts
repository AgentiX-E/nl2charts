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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHttpProvider } from '@agentix-e/nl2charts-ai';
import type { PromptOptions, SchemaTable } from '@agentix-e/nl2charts-ai';
import { applySelection, attachDefinitions, buildSelectionPrompt, chooseCandidatePairwise, buildSqlPrompt, choosePromptProfile, createPipeline, renderDefinitions, renderEvidence, renderSchemaCard, withCallCounter } from '@agentix-e/nl2charts-ai';
import { compareArms, judgeOfficial, judgeStrict, majorityResult, mcnemarExact, summarise, wilsonInterval } from '@agentix-e/nl2charts-devkit';
import { ppPerExtraCall, repairFunnel } from './metrics.js';
import type { CaseOutcome, MatchReason } from '@agentix-e/nl2charts-devkit';
import { buildSchema, loadDescriptions, loadQuestions, loadTables, stratifiedSample } from './data.js';
import type { BirdQuestion } from './data.js';
import { createOracle } from './oracle.js';
import { shapeFailure, shapeMismatch } from './shape.js';
import type { OracleResult } from './oracle.js';
import { profileDatabase } from './profile.js';
import { buildIndex, renderDemonstrations, renderRetrieved, retrieve } from './retrieval.js';
import { deserializeIndex, findValues, indexCells, renderValues, serializeIndex } from './values.js';
import type { ValueIndex } from './values.js';
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
  /**
   * Ask for a query plan (scan, filter, join, group, answer) before the statement.
   * CHASE-SQL's second generator; one lever from `inline+evidence`.
   */
  readonly plan?: boolean;
  /**
   * What a repair turn says: a diagnosis (default) or the engine's raw error.
   * Both cost the same calls, so the pair prices the diagnosis and not the retry.
   */
  readonly repairFeedback?: 'diagnosed' | 'raw';
  /**
   * Treat a scalar question answered with many rows or columns as a failure and repair it.
   * The engine reports nothing here, so without this the loop never sees the case.
   */
  readonly shapeGuard?: boolean;
  /**
   * The arms whose prompts supply the candidates, in order, when they are not all the
   * same prompt.
   *
   * `select` samples one prompt three times and gets three near-identical statements:
   * the model's 90% agreement is diversity of wording, not of approach. A different
   * decomposition of the question is a different prompt, and the list is the lever —
   * its length is the candidate count, so `vote` must match it.
   */
  readonly mixed?: readonly string[];
  /**
   * Ask the selector to compare two statements at a time instead of ranking many.
   *
   * The absolute prompt keeps 95% of what a mixed candidate set contained; the missing
   * five points are candidates that were present and not chosen. Two statements and one
   * of two answers is the shape CHASE-SQL's selector has, and the shape is the part a
   * prompt can copy. One lever from `select`: same candidates, same count, `k - 1`
   * comparisons instead of one ranking.
   */
  readonly pairwise?: boolean;
  /**
   * Show the selector where each candidate came from.
   *
   * The cross arm's candidates differ by model and the mixed arm's by prompt, and all of
   * that disappears once they are three SQL strings. This is a change of *information*
   * rather than of wording (ADR-194): the question to the selector stays the same, the
   * facts in front of it grow by one field. One lever from `select-cross`.
   */
  readonly sourcesVisible?: boolean;
  /**
   * Who judges the candidates: the primary model (default) or the second one.
   *
   * The selector is the same model that wrote one of the candidates, and the measured
   * asymmetry is stark: when only the cross arm's set held the answer — the statement the
   * *second* model wrote — the selector returned it 47% of the time, while answers held only
   * by the all-primary set were returned 87% of the time. Two explanations fit that: the
   * judge prefers statements that look like its own (self-preference, measured in LLM-judge
   * work), or the second model's correct statements are simply harder to recognise. Swapping
   * the judge separates them: under self-preference the asymmetry flips, under oddity it does
   * not.
   */
  readonly judge?: 'second';
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
/**
 * The decompositions a mixed candidate set is drawn from.
 *
 * Each is an arm already measured on its own and each is the top of its family — the
 * direct statement with the dataset's hint, the curated-notes statement, and the
 * value-grounded statement — because a candidate set should combine parts whose
 * individual behaviour is known. They disagree by construction: the three prompts differ
 * in what evidence they carry and where it sits, which is what three samples of one
 * prompt cannot buy (they agree 90% of the time).
 *
 * `plan` is deliberately not a source. Its plan is written inside the pipeline at call
 * time, so the prompt this harness can lay side by side is byte-identical to
 * `inline+evidence` — the dry run proves it — and a candidate that costs two calls for a
 * block the check cannot see would be a cost nobody could audit. Its own measurement
 * (-7.2pp, 63/27, p=0.0002) does not argue for including it either.
 */
export const MIXED_SOURCES: readonly string[] = ['inline+evidence', 'metadata+evidence', 'values'];

/**
 * The two prompts that are always distinct.
 *
 * Measured on the dry run, not assumed: `values` only builds a block when the question
 * names a literal, and on Mini-Dev that leaves 326 of 498 questions with two distinct
 * prompts out of three sources. A pair that always differs is the honest denominator for
 * what prompt diversity buys.
 */
export const DUO_SOURCES: readonly string[] = ['inline+evidence', 'metadata+evidence'];

/** The trio with its first candidate drawn from the second model. */
export const CROSS_SOURCES: readonly string[] = ['inline+evidence@second', 'metadata+evidence', 'values'];

/**
 * The same three prompt styles, with the authorships reversed: two from the second model and
 * one from the primary.
 *
 * `CROSS_SOURCES` gives the second model one candidate out of three, which makes it a
 * permanent minority: when its statement alone is correct, the other two (both from the
 * primary model) agree with each other and outvote it — measured at 21.5% conversion under
 * modal voting and 47% under the model selector. Reversing the majority tests the authorship
 * hypothesis without changing the prompts, the count or the cost: exactly one candidate's
 * author moves.
 */
export const BALANCED_SOURCES: readonly string[] = ['inline+evidence@second', 'metadata+evidence@second', 'values'];

/**
 * A mixed candidate set is only three generations if its sources generate once each.
 *
 * A source that repairs or samples would spend an unbounded number of calls inside what
 * the arm reports as one candidate, and the arm's cost — the number the whole comparison
 * rests on — would be wrong in the flattering direction.
 */
/**
 * A candidate source is an arm name, optionally suffixed `@second` for the other model.
 *
 * The suffix is part of the string rather than a second field because the arm table is
 * read as a sentence — three prompts, one of them from the second model, is what it says.
 * Anything else is a typo that has to fail loudly: a source name that resolves to nothing
 * would silently drop a candidate and turn a three-opinion arm into a two-opinion one.
 */
export function parseMixedSource(source: string): { arm: string; provider: 'primary' | 'second' } {
  const suffix = '@second';
  return source.endsWith(suffix)
    ? { arm: source.slice(0, -suffix.length), provider: 'second' }
    : { arm: source, provider: 'primary' };
}

export function assertMixedSources(sources: readonly string[] = MIXED_SOURCES): void {
  if (sources.length < 2) throw new Error(`a mixed candidate set needs at least two sources, not ${String(sources.length)}`);
  for (const source of sources) {
    const arm = resolveArm(parseMixedSource(source).arm);
    if (arm === undefined) throw new Error(`mixed candidate source ${source} is not an arm`);
    if (arm.repairs > 0 || arm.vote !== undefined) {
      throw new Error(
        `mixed candidate source ${source} must generate exactly one statement, but it repairs ${String(arm.repairs)} times and samples ${String(arm.vote ?? 1)}`,
      );
    }
  }
}

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
  // The same selector with two more samples to choose from. If selection works by
  // reading candidates, more of them should help; if it works by picking the first
  // plausible one, it will not.
  { name: 'select-pair', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, pairwise: true },
  { name: 'select5', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 5, select: true },
  // Three candidates from three decompositions, then the same selector. `select` draws
  // three samples of one prompt, which agree 90% of the time; the ceiling that matters
  // is how often the *set* contains a correct statement, and a set of paraphrases is a
  // narrow set. The sources are arms already measured on their own, so the candidate
  // set is a combination of known parts rather than a new invention.
  { name: 'select-mixed', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: MIXED_SOURCES },
  // The mixed arm without the value-grounded candidate. On Mini-Dev two thirds of the
  // questions name no literal, so the value block is empty and the arm pays three
  // generations for two distinct prompts; this is the same two prompts, always, for one
  // call less. It prices the candidate `values` actually contributes.
  { name: 'select-duo', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 2, select: true, mixed: DUO_SOURCES },
  // The trio with its strongest candidate generated by a second model: same three prompts,
  // same count, same four calls, one lever. Sampling one model buys paraphrases; a second
  // model buys a different set of mistakes, which is the only thing that can raise the
  // ceiling the selector is bounded by.
  { name: 'select-cross', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES },
  // The same candidates, with each one's origin in front of it.
  { name: 'select-tagged', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, sourcesVisible: true },
  // The same three prompts, aggregated by modal result instead of by a model. One lever
  // from `select-mixed` — same candidates, same count, one call fewer — and the reading is
  // the opposite of the selector experiments: a free aggregator cannot be argued with, only
  // counted. Three diverse candidates agree less often than three samples of one prompt, so
  // the modal answer is a weaker majority here; `agreement` says by how much.
  { name: 'vote-mixed', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, mixed: MIXED_SOURCES },
  // The cross set judged by the *other* model. One lever from `select-cross`: same
  // candidates, same selector prompt, different judge. If the judge favours statements that
  // read like its own, the asymmetry flips; if the second model's correct statements are
  // merely harder to recognise, it does not.
  { name: 'select-cross-judge', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, judge: 'second' },
  // The same three prompts with the authorship majority reversed: two candidates from the
  // second model, one from the primary. One lever from `select-cross` — one candidate's author
  // — and the direct test of "whoever wrote two of the three wins the tie".
  { name: 'select-balanced', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: BALANCED_SOURCES },
  // ...and the same aggregator on the cross-model set, where the candidates disagree by
  // model as well as by prompt.
  { name: 'vote-cross', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, mixed: CROSS_SOURCES },
  // The best prompt stack plus three diagnosed repairs: one lever from
  // `inline+evidence`, so the delta prices the repair loop and nothing else.
  { name: 'inline+repair', notes: false, evidence: 'dataset', repairs: 3, linking: true, definitions: 'inline' },
  // The same three retries with the engine's message and nothing else — the control the
  // diagnosis has to beat on the same cases, at the same cost.
  { name: 'inline+repair-raw', notes: false, evidence: 'dataset', repairs: 3, linking: true, definitions: 'inline', repairFeedback: 'raw' },
  // The same three retries, plus a check the engine cannot make: a question that asks for
  // one value answered with a list is wrong in a way SQL reports no error for.
  { name: 'inline+shape', notes: false, evidence: 'dataset', repairs: 3, linking: true, definitions: 'inline', shapeGuard: true },
  // The same inline arm plus the literals the question names, resolved against this
  // database. CHASE-SQL's first pipeline stage; here it is one lever from
  // `inline+evidence`, so the delta prices value grounding, not the hint.
  { name: 'values', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', values: true },
  // A plan before the statement: the ordering decisions (scan, filter, join, group,
  // answer) are made explicitly once instead of being encoded in one draft.
  { name: 'plan', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', plan: true },
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
  'inline+repair',
  'inline+repair-raw',
  'vote',
  'select',
  // Three decompositions instead of three samples of one: the arm that tests whether
  // the ceiling belongs to the sampler or to the prompt.
  'select-mixed',
  // The same two prompts that always differ, one call cheaper.
  'select-duo',
  'select5',
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
  repair: 'the original repair arm (dataset notes, two attempts, one generic sentence): superseded by inline+repair, which is one lever from inline+evidence and reports a funnel',
  'select-cross': 'the trio with its first candidate from a second model: needs BIRD_SECOND_MODEL and a second key, so it is dispatched rather than run on every push',
  'select-tagged': 'the cross arm with each candidate labelled by its source: needs the second model too, and is measured against `select-cross`',
  'vote-mixed': 'three prompts aggregated by modal result instead of by a model: 63% would make the selector call unnecessary, and below that it prices what the model adds',
  'vote-cross': 'the cross-model candidate set aggregated by modal result: needs the second model too',
  'select-cross-judge': 'the cross set judged by the second model: needs the second model and a second key, and prices self-preference in the judge',
  'select-balanced': 'the same three prompts with two candidates from the second model instead of one: flips which author holds the majority, and needs the second model',
  plan: 'query plan before the statement: 50.4% against 57.6% for its parent (-7.2pp, 63/27, p=0.0002) — anchoring, not helping; kept so the finding can be re-tested',
  'select-pair': 'pairwise comparison instead of an absolute ranking: 58.4% against 57.6% for its parent (+0.8pp, 17/20, p=0.74) at one more call, and it lost more of its candidate set (25 cases against 20) — the absolute prompt is not what the selector loses; kept so a different comparison order or a two-of-three vote can be measured against it',
  'inline+shape': 'scalar-shape guard before the repair loop: 57.2% against 58.4% for its parent (-1.2pp, 11/5, p=0.21) — it fired on 21 cases, repaired 2, and shifted 14 more into the wrong column count; kept so a better shape test can be measured against this one',
};

/**
 * Comparisons that answer a decision rather than price a module.
 *
 * `PAIRS` compares arms one lever apart, which is how a delta gets attributed. Some
 * questions are not about a lever: "is selection worth four calls instead of one?" and
 * "does the generated stack match the curated one?" compare across levels. They are
 * reported separately, with their own paired test, because mixing them into the
 * one-lever table would let a two-lever difference borrow the authority of a one-lever
 * experiment.
 */
export const COMPARISONS: readonly (readonly [string, string, string])[] = [
  ['inline+evidence', 'select', 'selection over three samples versus a single sample: four calls instead of one'],
  ['inline+evidence', 'select5', 'selection over five samples versus a single sample: six calls instead of one'],
  ['inline+evidence', 'values', 'value grounding on top of the hint: does instance knowledge add anything the hint lacks'],
  ['inline+evidence', 'metadata+evidence', 'generated definitions on the column line versus 798 curated notes'],
  ['inline+evidence', 'select-mixed', 'three decompositions and a selector versus a single sample: four calls instead of one'],
  ['select', 'select-duo', 'two prompts and a selector versus three samples of one prompt: three calls instead of four'],
  ['select-duo', 'select-mixed', 'the value-grounded candidate on top of two prompts: does a third source add anything'],
];

export const PAIRS: readonly (readonly [string, string])[] = [
  ['names', 'definitions'],
  ['definitions', 'synth-definitions'],
  ['synth-definitions', 'inline-definitions'],
  ['inline-definitions', 'dataset-subset'],
  ['inline-definitions', 'inline+evidence'],
  ['inline-definitions', 'inline+retrieval'],
  ['inline+retrieval', 'inline+icl'],
  ['inline+evidence', 'inline+repair'],
  // Same three retries, same prompt, same cost — only the text differs. The pair with
  // `inline+evidence` would change two fields (`repairs` and `repairFeedback`), and a
  // two-lever delta cannot say which of them moved the number.
  ['inline+repair-raw', 'inline+repair'],
  // One lever from `inline+repair`: same budget, same feedback, plus the shape check.
  ['inline+repair', 'inline+shape'],
  ['inline-definitions', 'interpret'],
  ['inline+evidence', 'vote'],
  ['vote', 'select'],
  // Where the candidates come from, held against how many there are: same count, same
  // selector, different prompts.
  ['select', 'select-mixed'],
  // One lever: who does the choosing, not how many candidates there are.
  ['select', 'select-pair'],
  // One lever: which model wrote the first candidate, not how many there are.
  ['select-mixed', 'select-cross'],
  // One lever: whether the selector is told where each candidate came from.
  ['select-cross', 'select-tagged'],
  // One lever: who aggregates the same three candidates, the model or the count.
  ['select-mixed', 'vote-mixed'],
  ['select-cross', 'vote-cross'],
  // One lever: which model judges the same three candidates.
  ['select-cross', 'select-cross-judge'],
  // One lever: which author holds the majority among the same three prompts.
  ['select-cross', 'select-balanced'],
  ['select', 'select5'],
  ['inline+evidence', 'values'],
  ['inline+evidence', 'plan'],
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
  /**
   * True when at least one candidate answered the question correctly, whether or not
   * the arm returned that candidate. Absent for an arm that generates once.
   *
   * Without it a selector's accuracy cannot be read: 58.8% could mean "the candidates
   * contained the answer and the selector threw it away" or "no candidate ever
   * contained it", and those call for opposite next steps. This is the ceiling any
   * selector could reach on this arm, measured rather than assumed.
   */
  readonly candidateRecall?: boolean;
  /**
   * Which decomposition the returned statement came from, on a mixed arm.
   *
   * Three candidates at the same price can hide a generator that never wins, and a
   * generator that never wins is a call that should not be in the set.
   */
  readonly winnerSource?: string;
  readonly error?: string;
  readonly errorKind?: 'execution' | 'guard' | 'llm' | 'shape' | 'other';
  /** Classes of the rejected attempts, in order; empty when the first one ran. */
  readonly failures?: readonly string[];
  /** Generations the repair loop spent. The funnel's unit, not the cost's. */
  readonly attempts: number;
  /**
   * Model calls this case actually made, counted at the provider.
   *
   * Required rather than optional so a return path that forgets it fails the build: the
   * cost column is what every ppPerExtraCall in the report is divided by, and a case
   * that reports zero calls would price its arm as free.
   */
  readonly calls: number;
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
/**
 * Read the frozen definitions, or undefined when there is no pin.
 *
 * A malformed pin is an error rather than a silent fallback to generation: falling
 * back would restore exactly the drift the pin exists to remove, and would do it
 * quietly.
 */
export function readPinnedDefinitions(path: string): Map<string, string> | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { definitions?: Record<string, string> };
  const definitions = parsed.definitions;
  if (definitions === undefined || Object.keys(definitions).length === 0) {
    throw new Error(`${path} has no definitions; regenerate with BIRD_DEFINITIONS_FORCE=1`);
  }
  return new Map(Object.entries(definitions));
}

export function resolveArm(name: string): Arm | undefined {
  const base = name.includes('#') ? name.slice(0, name.indexOf('#')) : name;
  return ARMS.find((arm) => arm.name === base);
}

/**
 * Turn `BIRD_ARMS` and `BIRD_AA` into the list of names to run.
 *
 * Pure and exported because the A/A suffix is a naming convention with a failure
 * mode: a duplicate that resolves to the same label as its original cannot be told
 * apart in the report.
 */
/**
 * Every arm must keep its own row in the report.
 *
 * An A/A duplicate resolves to the same Arm; if the report labelled rows by the
 * resolved name, the duplicate would sit in the table under the label of the arm it
 * duplicates, and a reader would see two identical arms and one missing control.
 */
/**
 * An arm whose every call failed did not measure anything.
 *
 * A dead key, an exhausted balance and a rate limit all arrive as "the model returned
 * nothing", which the harness scores as a wrong answer. That turns a provider outage
 * into 0% — a number that looks like a result, and that a floor gate can only report
 * as a regression. This refuses to run the table instead.
 */
export function assertArmProducedResults(armName: string, runs: readonly { errorKind?: string; error?: string }[]): void {
  if (runs.length === 0) return;
  const allFailed = runs.every((run) => run.errorKind === 'llm');
  if (!allFailed) return;
  const first = runs.find((run) => run.error !== undefined)?.error ?? 'no error text';
  throw new Error(
    `arm ${armName}: every case failed before reaching the database — the model provider refused all ${String(runs.length)} calls ` +
      `(first error: ${first}). This is not an accuracy of zero; it is a run that did not happen.`,
  );
}

/**
 * An arm that lost a tenth of its cases to the provider did not measure the model.
 *
 * The all-failed guard catches an outage; this catches a throttled run, which is worse
 * because it looks like a result. A 429 is retried inside the provider now, so what
 * reaches here is a failure after those attempts — for a batch this size that means the
 * endpoint is the variable, not the prompt.
 */
export function assertFailureRate(
  armName: string,
  runs: readonly { errorKind?: string; error?: string }[],
  maxShare = 0.1,
): void {
  if (runs.length === 0) return;
  const failures = runs.filter((run) => run.errorKind === 'llm');
  const share = failures.length / runs.length;
  if (share <= maxShare) return;
  // The first message, not a summary of them: "65% failed" without the reason sends the
  // reader to the workflow file when the answer is in the provider's reply.
  const first = failures.find((run) => run.error !== undefined)?.error ?? 'no error text';
  throw new Error(
    `arm ${armName}: ${String(failures.length)} of ${String(runs.length)} calls (${(share * 100).toFixed(1)}%) failed at the model, ` +
      `above the ${(maxShare * 100).toFixed(0)}% this harness treats as an outage (first error: ${first}). ` +
      'The accuracy would be a function of how busy the endpoint was.',
  );
}

/**
 * A repair arm whose repair path never ran is its parent arm with a bigger budget.
 *
 * This is the same failure the retrieval arm had: a switch that is on and never fires
 * still produces a number, and the number is the parent's. With a 40% failure rate on
 * this benchmark the loop must fire; a run where it did not is broken, not efficient.
 */
export function assertRepairPathFired(armName: string, cases: readonly { attempts: number }[], minimumSample = 100): void {
  if (cases.length < minimumSample) return;
  if (cases.some((entry) => entry.attempts > 1)) return;
  throw new Error(
    `arm ${armName}: no case needed a repair across ${String(cases.length)} questions, which cannot be right on a benchmark where the parent arm fails 40% of them — the repair path did not run`,
  );
}

/**
 * The repair and sampling fields an arm report may carry.
 *
 * `attempts` means one thing per arm kind: for an arm with a repair loop it is the number
 * of generations the loop spent, and for an arm that samples several candidates it is the
 * number of samples it drew. Counting `attempts > 1` for the second kind produced
 * `repaired: 496` on `select5` — an arm with no repair loop at all — in the one column a
 * reader uses to judge whether the loop is worth its calls. The field is therefore
 * reported only where it is true, and a sampling arm states its sample count instead.
 */
export function repairAccounting(
  arm: Pick<Arm, 'repairs' | 'vote'>,
  runs: readonly { attempts: number }[],
): { repaired?: number; samples?: number } {
  const sampling = arm.vote !== undefined && arm.vote > 1 ? { samples: arm.vote } : {};
  if (arm.repairs === 0) return sampling;
  return { repaired: runs.filter((run) => run.attempts > 1).length, ...sampling };
}

/**
 * The most a better selector could win on an arm that generates several candidates.
 *
 * `candidateRecall` is the share of questions where at least one candidate matched; that
 * is the ceiling any selector, however good, is bounded by on this candidate set.
 * `selectionLoss` counts the questions the set answered and the arm did not return —
 * cases that are pure selection failure and need no better generator. The two readings
 * decide where the next hour goes: a large loss means the selector is the defect, and a
 * loss near zero means the candidate set itself is the ceiling and no selector can lift
 * it, however it is prompted.
 */
export function candidateCeiling(runs: readonly { passed: boolean; candidateRecall?: boolean }[]): {
  candidateRecall: number;
  candidateRecallShare: number;
  selectionLoss: number;
} {
  const recall = runs.filter((run) => run.candidateRecall === true).length;
  return {
    candidateRecall: recall,
    candidateRecallShare: runs.length === 0 ? 0 : recall / runs.length,
    selectionLoss: runs.filter((run) => run.candidateRecall === true && !run.passed).length,
  };
}

/**
 * How often each decomposition produced the statement the arm returned.
 *
 * A generator that never wins is a call the arm should not be paying for, and without
 * this count the only visible fact about a mixed arm would be its total.
 */
export function winnerSources(
  runs: readonly { winnerSource?: string }[],
  sources: readonly string[] = MIXED_SOURCES,
): Record<string, number> {
  return Object.fromEntries(sources.map((source) => [source, runs.filter((run) => run.winnerSource === source).length]));
}

export function assertUniqueArmLabels(labels: readonly string[]): void {  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) throw new Error(`arm labels are not unique (${labels.join(', ')}); an A/A duplicate must keep its #2 name`);
    seen.add(label);
  }
}

export function parseArms(requested: string | undefined, aa: string | undefined, defaults: readonly string[]): string[] {
  const names = (requested ?? defaults.join(',')).split(',').map((name) => name.trim()).filter(Boolean);
  const trimmed = aa?.trim() ?? '';
  return trimmed === '' ? names : [...names, `${trimmed}#2`];
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
    // `BIRD_AA=<arm>` appends the same arm a second time under a `#2` name. The delta
    // between the pair is the harness's own noise at this sample size, which no
    // amount of within-run pairing between *different* arms can reveal.
    arms: parseArms(process.env.BIRD_ARMS, process.env.BIRD_AA, DEFAULT_ARMS),
    out: process.env.BIRD_OUT ?? join(ROOT, 'eval/out/bird-eval.json'),
    model: process.env.LLM_MODEL ?? 'deepseek-chat',
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? '',
    // The second model exists for one arm (`select-cross`) and is absent otherwise. It is
    // optional on purpose: a run that does not need it must not fail because an unrelated
    // key is missing, and a run that does need it must fail with a sentence rather than
    // quietly generate two candidates where it promised three.
    second: {
      model: process.env.BIRD_SECOND_MODEL ?? '',
      baseUrl: process.env.BIRD_SECOND_BASE_URL ?? '',
      apiKey: process.env.BIRD_SECOND_API_KEY ?? process.env.ZHIPU_API_KEY ?? '',
    },
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
  //
  // Scanned from the cells, not from the profile's top values: the profile keeps at
  // most thirty distinct values per categorical column and matched 90 of 498
  // questions, which measured the index rather than the idea. The scan is cached per
  // database because it costs one query per column.
  const valueIndexes = new Map<string, ValueIndex>();
  const valueCache = join(ROOT, 'eval/.cache/bird/values');
  mkdirSync(valueCache, { recursive: true });
  for (const [db, schema] of schemas) {
    const cacheFile = join(valueCache, `${db}.json`);
    if (existsSync(cacheFile) && process.env.BIRD_VALUES_FORCE !== '1') {
      try {
        valueIndexes.set(db, deserializeIndex(readFileSync(cacheFile, 'utf8')));
        continue;
      } catch {
        // A corrupt cache is a miss, not a reason to fail the run.
      }
    }
    const columns = schema.flatMap((table) => table.columns.map((column) => ({ table: table.table, column: column.name })));
    const index = await indexCells(columns, async (sql) => {
      const result = await oracle.run(db, sql);
      if (!result.ok) throw new Error(result.error ?? 'value scan failed');
      return result.rows;
    });
    valueIndexes.set(db, index);
    writeFileSync(cacheFile, serializeIndex(index));
  }
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
  const definitionsProvenance: Record<string, { hash: string; cached: boolean; source: string }> = {};
  const needsSynthesis = config.arms.some((name) => {
    const source = resolveArm(name)?.definitions;
    return source === 'synthesized' || source === 'inline';
  });
  // Retries live in the provider, not in the loop below: a throttled call is the
  // endpoint's answer, not a property of this arm.
  const provider = createHttpProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    retries: Number(process.env.BIRD_LLM_RETRIES ?? 3),
    retryDelayMs: Number(process.env.BIRD_LLM_RETRY_DELAY_MS ?? 1000),
  });
  const drawsSecond = config.arms.some((name) => (resolveArm(name)?.mixed ?? []).some((source) => parseMixedSource(source).provider === 'second'));
  const judgesSecond = config.arms.some((name) => resolveArm(name)?.judge === 'second');
  const needsSecond = drawsSecond || judgesSecond;
  if (needsSecond && (config.second.model === '' || config.second.apiKey === '')) {
    const missing = [config.second.model === '' ? 'BIRD_SECOND_MODEL' : '', config.second.apiKey === '' ? 'a second key (BIRD_SECOND_API_KEY or ZHIPU_API_KEY)' : '']
      .filter(Boolean)
      .join(' and ');
    // Naming the missing variable matters: "the arm needs a second model" sent me looking at
    // the workflow's model input the first time, when the key was what was absent. So does
    // naming the reason: a judged arm generates three candidates and would still do so with
    // no second model — it would just quietly judge with the first one.
    const consequence = drawsSecond
      ? 'the arm would generate two candidates where it promised three'
      : 'the arm would be judged by the primary model while claiming a swap';
    const cause = drawsSecond ? 'draws a candidate from the second model' : 'asks the second model to judge';
    throw new Error(`this arm set ${cause}, but ${missing} is not set; ${consequence}`);
  }
  const secondProvider =
    config.second.model === ''
      ? undefined
      : createHttpProvider({
          baseUrl: config.second.baseUrl === '' ? config.baseUrl : config.second.baseUrl,
          apiKey: config.second.apiKey,
          model: config.second.model,
          retries: Number(process.env.BIRD_LLM_RETRIES ?? 3),
          retryDelayMs: Number(process.env.BIRD_LLM_RETRY_DELAY_MS ?? 1000),
        });
  // Definitions are an *input* to the definition-dependent arms, so they are pinned in
  // the repository rather than regenerated: two runs with identical prompts produced
  // different text for 6 of 11 databases, which moved `synth-definitions` by 5.1pp and
  // made every delta on that arm a joint measurement of prompt and text.
  const pinned = readPinnedDefinitions(join(ROOT, 'eval/baseline/definitions.minidev.json'));
  if (!config.dryRun && needsSynthesis && pinned !== undefined && process.env.BIRD_DEFINITIONS_FORCE !== '1') {
    for (const [db] of schemas) {
      const text = pinned.get(db);
      if (text === undefined || text.length === 0) throw new Error(`pinned definitions have no entry for ${db}; regenerate with BIRD_DEFINITIONS_FORCE=1`);
      synthesizedDefinitions.set(db, text);
      definitionsProvenance[db] = { hash: 'pinned', cached: true, source: 'pinned' };
    }
  } else if (!config.dryRun && needsSynthesis) {
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
        definitionsProvenance[db] = { hash: outcome.hash, cached: outcome.cached, source: 'generated' };
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
    // Derived from the split actually loaded. It was the literal `mini_dev_sqlite`, so every
    // dev artifact said mini_dev_sqlite at the top level and `dev` inside `selection`, and
    // nothing read the duplicate field so nothing noticed. The gate now compares the two.
    split: SPLIT,
    dialect: 'SQLite',
    model: config.dryRun ? null : config.model,
    // Which model wrote the `@second` candidates, when an arm draws one. Without it the
    // cross-arm artifact cannot be reproduced and its number has no subject.
    secondModel: config.second.model === '' ? null : config.second.model,
    // ...and which model judged, when an arm asks the second one to. A judge swap is the one
    // experiment whose result is unreadable without this field.
    judgeModel: config.arms.some((name) => resolveArm(name)?.judge === 'second') ? config.second.model : null,
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

  // Prompt-level facts, measured for every run and not only the dry one: the report they
  // produce is what a stratum join needs, and the evaluation used to overwrite it away.
  // A mixed arm is as many prompts as it claims, or it is one prompt paid for several
  // times. The check cannot be made on one question: `values` only differs when the
  // question names a literal, and on the dev split the first question names none — the
  // three sources collapsed to two and the guard called the arm broken, which was the
  // guard's mistake, in the same family as applying one split's arm list to another.
  // What must hold is that the sources *can* differ; how often they cannot is measured
  // here and reported as a cost, not assumed away.
  const distinctShare = (sources: readonly string[]): { distinct: string[]; degenerate: string[] } => {
    const distinct: string[] = [];
    const degenerate: string[] = [];
    for (const question of cases) {
      // The provider is part of the identity: the same prompt sent to a second model is
      // a different opinion, not a duplicate, and counting it as one would misreport the
      // cost of exactly the arm that exists to test model diversity.
      const built = sources.map((source) => {
        const spec = parseMixedSource(source);
        const arm = resolveArm(spec.arm) as Arm;
        const prompt = buildSqlPrompt(question.question, schemas.get(question.db_id) as SchemaTable[], promptFor(arm, question, blocksFor(arm, question)));
        return `${spec.provider}\u0000${prompt}`;
      });
      (new Set(built).size === sources.length ? distinct : degenerate).push(String(question.question_id));
    }
    return { distinct, degenerate };
  };
  report.mixedCandidatePrompts = config.arms
    .map((name) => resolveArm(name))
    .filter((arm): arm is Arm => arm !== undefined && arm.mixed !== undefined)
    .map((arm) => {
      const sources = arm.mixed as readonly string[];
      const counted = distinctShare(sources);
      if (counted.distinct.length === 0) {
        throw new Error(`arm ${arm.name} builds no question with ${String(sources.length)} distinct prompts from ${sources.join(', ')}; it would pay ${String(sources.length)} times for one opinion on every case`);
      }
      return {
        arm: arm.name,
        sources,
        questions: cases.length,
        withAllDistinct: counted.distinct.length,
        degenerate: counted.degenerate.length,
        degenerateShare: counted.degenerate.length / Math.max(1, cases.length),
        // The ids, not only the count: the question "did the trio win on the diverse
        // questions or on the duplicated ones" is a stratum, and a stratum is a join
        // between these ids and the per-case outcomes.
        degenerateIds: counted.degenerate,
      };
    });

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
  // Mean calls per case, counted at the provider, so a delta can be divided by what it
  // cost. `attempts` cannot serve here: it counts generations inside a repair loop and
  // knows nothing about a selector call or the second call a plan costs, which made
  // selection look free and a plan candidate look like one call.
  const meanCalls = (runs: readonly { calls: number }[]): number =>
    runs.length === 0 ? 1 : runs.reduce((total, run) => total + run.calls, 0) / runs.length;

  const armReports: unknown[] = [];
  const outcomes = new Map<string, CaseRun[]>();
  for (const name of config.arms) {
    const arm = resolveArm(name);
    if (arm === undefined) throw new Error(`unknown arm ${name}`);
    // A mixed arm runs three configurations under one label; if one of them repairs or
    // samples, the reported cost is wrong and the comparison loses its meaning.
    if (arm.mixed !== undefined) {
      assertMixedSources(arm.mixed);
      if (arm.mixed.length !== arm.vote) {
        throw new Error(`arm ${name} draws ${String(arm.mixed.length)} sources but declares ${String(arm.vote ?? 1)} candidates; the cost claim would be false`);
      }
    }
    const runs = await pool(cases, config.concurrency, async (question): Promise<CaseRun> => {
      const schema = schemas.get(question.db_id) as SchemaTable[];
      // Counted, not derived: a plan costs two calls, a selector costs one, and a
      // configuration-derived count got both wrong in opposite directions.
      const counter = withCallCounter(provider);
      const secondCounter = secondProvider === undefined ? undefined : withCallCounter(secondProvider);
      // Both models' calls are this case's cost. Summing two counters keeps the number
      // measured on each side instead of estimated from the arm's configuration.
      const callsMade = (): number => counter.calls() + (secondCounter?.calls() ?? 0);
      // One case cannot take the run down. A provider error raised outside the per-sample
      // catch — the selector call, an engine call — used to escape the pool and end a
      // 1,532-question run at case 700 with a stack trace, which is why this wrapper
      // exists: an escaped error becomes a recorded `llm` failure, and the failure-share
      // guard decides whether the run is publishable.
      const guarded = async (work: () => Promise<CaseRun>): Promise<CaseRun> => {
        try {
          return await work();
        } catch (error) {
          return {
            id: String(question.question_id),
            passed: false,
            predicted: '',
            reason: 'values',
            strict: false,
            attempts: 1,
            errorKind: 'llm',
            error: `harness: ${error instanceof Error ? error.message : String(error)}`,
            calls: callsMade(),
          };
        }
      };
      return guarded(async (): Promise<CaseRun> => {
        // A pipeline is a prompt plus a budget, so building one per configuration costs
        // nothing and lets a mixed arm ask the same question three different ways.
        // The execute hook exists for repairs only: without repairs it would turn an
        // execution failure into a thrown pipeline error and hide the statement that
        // failed, which is the one thing a diagnosis needs.
        const pipelineFor = (target: Arm, which: 'primary' | 'second' = 'primary'): ReturnType<typeof createPipeline> =>
          createPipeline({
            provider: which === 'second' && secondCounter !== undefined ? secondCounter.provider : counter.provider,
            maxRepairs: target.repairs,
            linking: target.linking,
            interpret: target.interpret === true,
            plan: target.plan === true,
            ...(target.repairFeedback === undefined ? {} : { repairFeedback: target.repairFeedback }),
            temperature: target.vote === undefined ? 0 : 0.7,
            prompt: promptFor(target, question, blocksFor(target, question)),
            ...(target.repairs === 0
              ? {}
              : {
                  execute: async (sql: string) => {
                    const result = await oracle.run(question.db_id, sql);
                    if (result.ok) {
                      // A statement that runs and returns the wrong number of rows is invisible
                      // to the engine, so this is the only place the loop can hear about it.
                      if (target.shapeGuard === true && shapeMismatch(question.question, result.rows)) {
                        throw new Error(shapeFailure(result.rows));
                      }
                      return;
                    }
                    // The driver's own words, not a summary of them: the repair reads
                    // `details.engineError` to decide what to tell the model.
                    throw Object.assign(new Error(result.error ?? 'execution failed'), {
                      details: {
                        engineError: {
                          message: (result.error ?? 'execution failed').replace(/^\w*Error:\s*/, ''),
                          ...(result.errorName === undefined ? {} : { code: result.errorName }),
                        },
                      },
                    });
                  },
                }),
          });
        const pipeline = pipelineFor(arm);
        const expected = gold.get(question.question_id) as OracleResult;
        if (arm.vote !== undefined && arm.vote > 1) {
          const candidates: { sql: string; rows: readonly (readonly unknown[])[]; source: string }[] = [];
          // Why a sample died matters: a sample the engine refused is a candidate that
          // does not exist, while a sample the endpoint never answered is an outage that
          // used to be counted as "no sample survived guard and execution" — a content
          // failure the accuracy was then blamed for.
          const sampleErrors: (string | undefined)[] = [];
          for (let sample = 0; sample < arm.vote; sample += 1) {
            try {
              // A mixed arm draws each candidate from a different decomposition. The
              // sources repair nothing by contract (asserted in the test suite), so a
              // candidate is always one generation and the cost stays three calls.
              const sources = arm.mixed;
              const source = sources === undefined ? name : (sources[sample % sources.length] as string);
              const spec = parseMixedSource(source);
              const sampler = sources === undefined ? pipeline : pipelineFor(resolveArm(spec.arm) as Arm, spec.provider);
              const askedSample = await sampler.ask({ question: question.question, schema });
              const executed = await oracle.run(question.db_id, askedSample.sql);
              if (executed.ok) candidates.push({ sql: askedSample.sql, rows: executed.rows, source });
            } catch (error) {
              // A sample that fails the guard or the engine casts no vote; the other
              // samples still produce one. The reason is kept for the zero-candidate case.
              sampleErrors.push((error as { code?: string }).code?.startsWith('NL2C_E_LLM') === true ? 'llm' : undefined);
            }
          }
          if (candidates.length === 0) {
            const outage = sampleErrors.length === arm.vote && sampleErrors.every((kind) => kind === 'llm');
            return {
              id: String(question.question_id),
              passed: false,
              predicted: '',
              reason: 'values',
              strict: false,
              attempts: arm.vote,
              error: outage ? 'every sample failed at the model' : 'no sample survived guard and execution',
              // The distinction is what makes the failure-share guard able to fire on a
              // voting arm at all; before it, an endpoint outage read as three wrong
              // statements and quietly lowered the score.
              errorKind: outage ? 'llm' : 'other',
              candidateRecall: false,
              calls: callsMade(),
            };
          }
          const majority = majorityResult(candidates, (left, right) => judgeOfficial(left.rows, right.rows) === 'match');
          let winner = majority.winner as { sql: string; rows: readonly (readonly unknown[])[]; source: string };
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
              ...(arm.sourcesVisible === true ? { source: candidate.source } : {}),
            }));
            // `counter.provider`, not `provider`: this call is part of the arm's price, and
            // the first version of this counter left it out — which the gate caught on the
            // very next run ("select samples 3 times and reports 3 calls per case").
            const judge = arm.judge === 'second' && secondCounter !== undefined ? secondCounter.provider : counter.provider;
            const decision =
              arm.pairwise === true
                ? await chooseCandidatePairwise(judge, question.question, candidates)
                : await (async () => {
                    const reply = await judge.complete({
                      messages: [
                        { role: 'system', content: buildSelectionPrompt(question.question, offered) },
                        { role: 'user', content: question.question },
                      ],
                      temperature: 0,
                    });
                    const applied = applySelection(reply.text, offered);
                    return { index: applied.index, decided: applied.decided, sql: (offered[applied.index] as { sql: string }).sql };
                  })();
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
            attempts: arm.vote,
            agreement: majority.agreement,
            candidateRecall: candidates.some((candidate) => judgeOfficial(expected.rows, candidate.rows) === 'match'),
            ...(selectedByModel === undefined ? {} : { selectedByModel }),
            ...(arm.mixed === undefined ? {} : { winnerSource: winner.source }),
            calls: callsMade(),
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
              // Without the kind this case counted as `other`, which made
              // `errors.execution` permanently zero and hid where failures came from:
              // the GLM probe read as "no execution failures" while every one of its
              // top errors was a SQLite syntax or column error.
              errorKind: 'execution',
              calls: callsMade(),
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
            calls: callsMade(),
            failures: asked.failures,
          };
        } catch (error) {
          // A repair arm reports the statement it gave up on, so a failure is
          // diagnosable from the artifact alone.
          const details = (error as { details?: Record<string, unknown> }).details ?? {};
          const lastError = typeof details.lastError === 'string' ? details.lastError : undefined;
          const failureClasses = Array.isArray(details.failureClasses) ? (details.failureClasses as string[]) : undefined;
          const message = error instanceof Error ? error.message : String(error);
          const code = (error as { code?: string }).code ?? '';
          return {
            id: String(question.question_id),
            passed: false,
            predicted: typeof details.lastSql === 'string' ? details.lastSql : '',
            reason: 'values',
            strict: false,
            attempts: arm.repairs + 1,
            calls: callsMade(),
            ...(failureClasses === undefined ? {} : { failures: failureClasses }),
            error: lastError === undefined ? message : `${message}: ${lastError}`,
            // A shape failure ends with a statement that runs, so calling it `execution`
            // would say the engine rejected something it never saw.
            errorKind:
              lastError !== undefined && lastError.startsWith('shape:')
                ? 'shape'
                : code === 'NL2C_E_GUARD_REJECTED'
                  ? 'guard'
                  : code === 'NL2C_E_ENGINE_FAILED'
                    ? 'execution'
                    : code.startsWith('NL2C_E_LLM')
                      ? 'llm'
                      : 'other',
          };
        }
      });
    });
    // Keyed by the requested name, not the resolved one: an A/A duplicate resolves to
    // the same Arm, and keying by that overwrote the first run with the second, which
    // silently made the pair compare an arm with itself and report `aa: undefined`.
    outcomes.set(name, runs);
    // Before any number is printed: an arm that never reached the database has no
    // accuracy, and publishing 0% would hide the provider's message behind a score.
    assertArmProducedResults(name, runs);
    assertFailureRate(name, runs);
    if (arm.repairs > 0) assertRepairPathFired(name, runs);
    const summary = summarise(name, runs);
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
    // A repair arm is priced by its funnel, not only by its accuracy: an arm that
    // fixes 30 cases and breaks 25 has the same accuracy as one that does nothing.
    const repair =
      arm.repairs > 0
        ? repairFunnel(runs.map((run) => ({ attempts: run.attempts, passed: run.passed, failures: run.failures, errorKind: run.errorKind })))
        : undefined;
    const kindOf = (run: CaseRun): string | undefined => run.errorKind ?? (run.error === undefined ? undefined : 'other');
    const errors = {
      execution: runs.filter((run) => kindOf(run) === 'execution').length,
      guard: runs.filter((run) => kindOf(run) === 'guard').length,
      llm: runs.filter((run) => kindOf(run) === 'llm').length,
      shape: runs.filter((run) => kindOf(run) === 'shape').length,
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
      arm: name,
      passed: summary.passed,
      total: summary.total,
      accuracy: summary.accuracy,
      wilson: wilsonInterval(summary.passed, summary.total),
      strictPassed,
      duplicateCredit: summary.passed - strictPassed,
      exactMatchRate: runs.filter((run) => run.strict).length / summary.total,
      ...repairAccounting(arm, runs),
      // What the arm actually spent, beside what it gained: the division the whole
      // comparison rests on is this number, so it is published rather than recomputed
      // from the arm's configuration by whoever reads the artifact.
      calls: {
        mean: Number(meanCalls(runs).toFixed(3)),
        max: Math.max(0, ...runs.map((run) => run.calls)),
      },
      ...(repair === undefined ? {} : { repair }),
      ...(arm.vote === undefined
        ? {}
        : {
            vote: arm.vote,
            agreement: runs.reduce((total, run) => total + (run.agreement ?? 0), 0) / Math.max(1, runs.filter((run) => run.agreement !== undefined).length),
            selector: arm.select === true ? 'model' : 'majority',
            // Who judges, when it is not the primary model. The gate needs this to insist the
            // artifact names the judge: a judge swap whose result cannot be attributed is a
            // number with no owner.
            ...(arm.judge === undefined ? {} : { judge: arm.judge }),
            // The ceiling, measured: how often the candidate set contained a statement
            // that matched. Accuracy divided by this is what the selector kept, and the
            // difference between the two is the most a better selector could win here.
            ...candidateCeiling(runs),
            ...(arm.mixed === undefined ? {} : { sources: winnerSources(runs, arm.mixed) }),
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
        // Blocks written at call time (a plan, a reading of the question) are not in
        // the static prompt this counts, so an arm that uses one must say so: a size
        // that silently excludes the block it added would read as "this arm is cheap".
        ...(arm.plan === true || arm.interpret === true ? { excludes: ['plan/interpretation written at call time'] } : {}),
      },
      byDifficulty,
      errors,
      topErrors: [...messages.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5),
      llmFailureShare: runs.filter((run) => run.errorKind === 'llm').length / Math.max(1, runs.length),
      // The ungrouped first failure. `topErrors` replaces digits to group messages,
      // which is right for counting and wrong for diagnosis: "llm returned N" hides
      // the status code that says whether the key is dead or the balance is empty.
      ...(runs.find((run) => run.error !== undefined) === undefined
        ? {}
        : { firstError: (runs.find((run) => run.error !== undefined) as CaseRun).error?.slice(0, 200) }),
    });
    const printed = repairAccounting(arm, runs);
    const ceiling = arm.vote === undefined ? undefined : candidateCeiling(runs);
    console.log(
      `${name.padEnd(9)} ${summary.passed}/${summary.total}  ${(summary.accuracy * 100).toFixed(1)}%  strict ${strictPassed}` +
        `${printed.repaired === undefined ? '' : `  repaired ${String(printed.repaired)}`}` +
        `${printed.samples === undefined ? '' : `  samples ${String(printed.samples)}`}` +
        `${ceiling === undefined ? '' : `  recall@${String(arm.vote ?? 1)} ${(ceiling.candidateRecallShare * 100).toFixed(1)}% (lost ${String(ceiling.selectionLoss)})`}`,
    );
  }

  // Every arm must keep its own row: two rows with the same label would let a
  // duplicate stand in for the arm it duplicates.
  // `report.arms` is assigned further down, so the guard reads the list it is about.
  assertUniqueArmLabels((armReports as { arm: string }[]).map((entry) => entry.arm));

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

  const comparisons: Record<string, unknown> = {};
  for (const [from, to, question] of COMPARISONS) {
    const first = outcomes.get(from);
    const second = outcomes.get(to);
    if (first === undefined || second === undefined) continue;
    const comparison = compareArms(summarise(from, first), summarise(to, second));
    comparisons[`${from} -> ${to}`] = {
      question,
      delta: comparison.delta,
      onlyFirst: comparison.onlyFirst,
      onlySecond: comparison.onlySecond,
      p: mcnemarExact(comparison.onlyFirst, comparison.onlySecond),
    };
  }
  report.comparisons = comparisons;

  const ablations: Record<string, unknown> = {};
  for (const [from, to] of PAIRS) {
    const first = outcomes.get(from);
    const second = outcomes.get(to);
    if (first === undefined || second === undefined) continue;
    const comparison = compareArms(summarise(from, first), summarise(to, second));
    const extraCalls = meanCalls(second) - meanCalls(first);
    const priced = ppPerExtraCall(comparison.delta * 100, extraCalls);
    ablations[`${from} -> ${to}`] = {
      delta: comparison.delta,
      onlyFirst: comparison.onlyFirst,
      onlySecond: comparison.onlySecond,
      p: mcnemarExact(comparison.onlyFirst, comparison.onlySecond),
      // Undefined for a lever that costs no call (placement, a hint): those are not
      // "infinitely efficient", they are free, and dividing by zero would say the first.
      cost: {
        extraCallsPerCase: Number(extraCalls.toFixed(4)),
        ...(priced === undefined ? {} : { ppPerExtraCall: Number(priced.toFixed(3)) }),
      },
    };
  }

  report.arms = armReports;
  report.ablations = ablations;
  // Per-case outcomes, because a per-arm total cannot answer "on which questions did this
  // lever work". The first question it is needed for: whether the mixed arm wins because
  // its third source is distinct on 35% of cases, or because a duplicated candidate is a
  // frequency signal on the other 65%. That is a stratum, and a stratum needs rows.
  report.cases = [...outcomes.entries()].flatMap(([name, runs]) =>
    runs.map((run) => ({
      arm: name,
      id: run.id,
      passed: run.passed,
      reason: run.reason,
      calls: run.calls,
      // The ceiling per case, not only per arm: whether a candidate set contained a
      // correct statement is a paired outcome between two arms on the same question, and
      // a paired outcome can be tested. A share cannot.
      ...(run.candidateRecall === undefined ? {} : { candidateRecall: run.candidateRecall }),
    })),
  );
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
