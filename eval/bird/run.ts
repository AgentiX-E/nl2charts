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
import type { LlmProvider, PromptOptions, SchemaTable } from '@agentix-e/nl2charts-ai';
import { applySelection, attachDefinitions, buildAskMessages, buildSelectionPrompt, chooseCandidatePairwise, buildSqlPrompt, choosePromptProfile, createPipeline, emptyRetryMessages, extractSql, renderDefinitions, renderEvidence, renderSchemaCard, withCallCounter } from '@agentix-e/nl2charts-ai';
import type { PurposeUsage } from '@agentix-e/nl2charts-ai';
// The retry turn writes a statement outside the pipeline, so it goes through the same
// guard the pipeline applies. Skipping it here would let the one arm that retries be the
// one arm that can execute DDL.
import { inspectSql } from '@agentix-e/nl2charts-core';
import { casesForEffect, compareArms, judgeOfficial, judgeStrict, majorityResult, mcnemarExact, pairedResolution, summarise, wilsonInterval } from '@agentix-e/nl2charts-devkit';
import type { PairedComparison } from '@agentix-e/nl2charts-devkit';
import { graphForDatabase } from './join-graph.js';
import { ppPerExtraCall, repairFunnel } from './metrics.js';
import { pruneSchema } from './prune.js';
import { applyColumnChoice, buildColumnPrompt, parseColumnChoice } from './columns.js';
import type { CaseOutcome, MatchReason } from '@agentix-e/nl2charts-devkit';
import { buildSchema, describeQuestionSet, distinctQuestions, loadDescriptions, loadQuestions, loadTables, stratifiedSample } from './data.js';
import type { BirdQuestion, QuestionSet } from './data.js';
import { createOracle } from './oracle.js';
import { canonicalSql } from './canonical.js';
import { shapeFailure, shapeMismatch } from './shape.js';
import { FAILURE_SAMPLE, failureCorpus } from './failures.js';
import type { Oracle, OracleResult } from './oracle.js';
import { profileDatabase } from './profile.js';
import { BIRD_SCHEMA_LINES } from './prompt-shape.js';
import { attachSamples, sampleValuesOf } from './samples.js';
import { exampleMapOf, exampleSetFor } from './value-examples.js';
import { buildIndex, renderDemonstrations, renderRetrieved, retrieve } from './retrieval.js';
import { deserializeIndex, findValues, indexCells, renderValues, serializeIndex } from './values.js';
import type { ValueIndex } from './values.js';
import { synthesizeRecord } from './synthesize.js';

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
   * Send the join closure instead of the card: keep the tables within this many joins of the
   * ones the question names, and fall back to the whole card when it names none.
   *
   * The number is hops, not a switch, because the join instrument priced depth as a parameter
   * and the optimum was not the deepest: one hop keeps every gold table for 95.2% of Mini-Dev
   * cases and leaves 15.1% of the prompt, two hops reaches 100% and leaves 2.1%, because a
   * closure that covers everything has become the card. `select-prune` runs at one.
   *
   * The rule is the closure of the arm's own linker. A prune that seeded itself from a different
   * recaller set would change the `Likely columns` hint as well — a hidden table cannot be named
   * by a hint — and the delta against the parent would price two levers at once.
   */
  readonly prune?: number;
  /**
   * Show what a column actually contains, on its own card line.
   *
   * Not `values`. That block is built from the question's own literals, so it is empty
   * exactly when the question spells a value differently from the store — which is the case
   * it exists to help, and it was empty on 60.9% of the questions that offered it. This one
   * is unconditional: `status TEXT [Banned|Active]` is in front of the model whether or not
   * the question said "banned".
   *
   * Two samplers, because the rule is the lever and not the bracket. `profile` is ours: the
   * profiler's top eight spellings of a categorical column, and nothing else. `example` is
   * MAC-SQL's, ported in `value-examples.ts`: six most-frequent values of every non-key
   * column, a small numeric dictionary included, a date collapsed to one, and a NULL first
   * when the column stores one. They differ in which columns are shown and in what a shown
   * column says, and a lever that silently picked one of them would make the pair one arm.
   *
   * The cost is prompt length and the risk the renderer warns about — samples invite
   * invented filters — which is why it is a lever and not a default.
   */
  readonly samples?: 'profile' | 'example';
  /**
   * Ask for a query plan (scan, filter, join, group, answer) before the statement.
   * CHASE-SQL's second generator; one lever from `inline+evidence`.
   */
  readonly plan?: boolean;
  /**
   * Generate by decomposition: sub-questions with their own statements, then the answer.
   *
   * Not `plan`. A plan is written in an earlier call and carried in, and it measured
   * -7.2pp here — the ordered plan anchored the statement it was supposed to prepare.
   * This one is inside the same reply: the model writes the pieces as statements and
   * composes them, so the composition is visible and the call count does not change.
   */
  readonly decompose?: boolean;
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
  /**
   * Rewrite every candidate into one SQL style before the selector reads it.
   *
   * The judge swap answered *whose* preference it is and left the *channel* open: the same
   * second model's statement was returned 25.6% of the time under the primary judge and
   * 68.2% under its author, on identical candidates, and the only thing that changed is who
   * reads the text. A judge sees no label and no author, so the preference has to travel
   * through keyword case, spacing, line breaks and comments — none of which is SQL.
   *
   * This lever removes that channel without changing a single computed value: keywords and
   * function names upper case, identifiers lower case, one space between tokens, comments
   * gone, string literals and quoted identifiers copied byte for byte. It does not reorder,
   * rename or simplify, so if accuracy moves the movement belongs to style and not to the
   * statements. One lever from `select-cross`: same candidates, same count, same cost.
   */
  readonly canonical?: boolean;
  /**
   * Present the candidates in an order that does not depend on who wrote them.
   *
   * `CROSS_SOURCES` lists the second model's statement first on every question, so on this
   * benchmark authorship and position are perfectly collinear: the candidate that is returned
   * 52.6% of the time may be preferred for its author or for its slot, and no count over the
   * existing arms separates the two readings. The experiment cannot change the candidate set
   * without becoming a different experiment, so it permutes the same three statements by
   * question id: reproducible, one lever, zero calls.
   *
   * It is measured against `select-cross` on the frozen per-candidate `winnerSource` field
   * rather than on accuracy alone — under authorship the second model keeps its 52.6% wherever
   * it is placed, under position the rate falls towards the 1-in-3 a permutation implies.
   */
  readonly shuffle?: boolean;
  /**
   * Treat an empty result as a failure and spend one call on it.
   *
   * The signal is exact on this benchmark rather than heuristic: no question in either
   * split has an empty gold result, so a statement that returns no rows is wrong by
   * construction (`emptyGoldExcluded` is 0 in every report). That is why this is a
   * separate lever from `shapeGuard`, which guessed from row and column counts and lost
   * 1.2pp doing it.
   *
   * It also drops candidates that returned nothing before the selector sees them, which
   * costs no calls: an option that cannot be right has no reason to be offered.
   *
   * `diagnosed` tells the next turn what happened; `blind` spends the same call and says
   * nothing about it, which is the control that prices the information.
   */
  readonly emptyRetry?: 'diagnosed' | 'blind';
  /**
   * Let the model name the columns the card keeps, in one call before the statement.
   *
   * Every card-cutting instrument this harness has decides *tables*: the card measurement says
   * how much of the prompt they are, the join measurement says one hop over the declared keys
   * keeps every gold table, and `prune` ships that rule and loses 1.4pp because the closure
   * reaches the wrong place for the questions the linker already misses. All three read the
   * question through the same lexical linker. This lever reads it through the model instead —
   * MAC-SQL's selector, which is the one mechanism in the competitor reading that no arm here
   * tests, and therefore the one that can explain a gap that pruning cannot.
   *
   * It is a *lever on the card*, not a selector: the arm still generates one statement, and the
   * call it adds is the price of the choice. Its delta against its parent prices "who decides
   * relevance", with the answer "the model, at one call" on one side and "nobody, the card is
   * the card" on the other.
   *
   * A reply with no resolvable column sends the whole card and is reported as `decided: false`
   * — the same doctrine as `prune`'s no-seed branch.
   */
  readonly columnSelect?: boolean;
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
 * The trio plus a fourth candidate written by decomposition.
 *
 * The routing analysis left one question open: not which candidate to pick, but whether a
 * correct statement exists at all. Seven configurations answered 466 of the 1,532 dev
 * questions wrongly — none of them held the right statement — so adding a way to *choose*
 * could not reach them, and the only lever left is a generation that produces a candidate
 * the three prompts cannot.
 *
 * `decompose` differs from them in shape rather than in knowledge: the model writes the
 * pieces as statements and composes them, inside one reply. `candidateRecall` is read
 * before accuracy, because a fourth prompt that raises the ceiling and not the score is a
 * selection finding, while one that raises neither is a prompt that adds nothing.
 */
export const MIXED_DC_SOURCES: readonly string[] = [...MIXED_SOURCES, 'decompose'];

/**
 * The same three candidates, with the third slot given to decomposition instead of to the
 * value index.
 *
 * The dev run of the empty-result experiment made the asymmetry visible: `values` won 81 of
 * 1,532 cases (5.3%), and on 933 of them (60.9%) its block was empty, so the trio was a duo
 * with a third vote that could not differ. Swapping that slot for a prompt that always
 * differs keeps the count and the cost at four calls and asks the only question the
 * arithmetic leaves: which prompt earns the third slot.
 */
export const DC_SOURCES: readonly string[] = ['inline+evidence', 'metadata+evidence', 'decompose'];

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
  // The same prompt with the card carrying each categorical column's stored values. One
  // lever from `inline+evidence`, one call, no extra block: the instance knowledge sits on
  // the column line instead of in a list built from the question's wording.
  { name: 'inline+evidence+samples', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', samples: 'profile' },
  // The same lever with the competitor's rule instead of ours: six most-frequent values of
  // every non-key column, a small numeric dictionary included, a date collapsed to one, and a
  // NULL first when the column stores one. It exists to put the block MAC-SQL's selector reads
  // on our card, so the 6.45pp can be attributed to a block and not to "their pipeline".
  { name: 'inline+evidence+samples-wide', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', samples: 'example' },
  // The same prompt with the card cut to the columns the model names, in one call before the
  // statement. One lever from `inline+evidence`, and the only card-cutting arm here whose rule
  // is not the lexical linker: `select-prune` prices the join closure and loses 1.4pp, this one
  // prices the model's own reading of the question. The plan calls it `llm-select`.
  { name: 'inline+evidence+llm-select', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', columnSelect: true },
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
  // The card as the join closure rather than the whole schema. One lever from `select`: the
  // same linker, the same three samples, the same selector, and a smaller card — the 74.1% of
  // the prompt that the card measurement priced and the 15.1% of it the join measurement said
  // one hop can remove.
  { name: 'select-prune', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, prune: 1 },
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
  // The cross set read in one SQL style. One lever from `select-cross`: same candidates, same
  // count, same four calls, same selector prompt — the text in front of the selector has its
  // signatures removed. The judge swap showed the asymmetry is authorship; a judge recognises
  // authorship from formatting, so removing formatting is the test of whether the 6pp was
  // readability or taste.
  { name: 'select-cross-canon', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, canonical: true },
  // ...and the same canonical text read by the second model, which is where the style channel was
  // measured: the 128-case loss group belongs to that judge, so closing the channel has to be
  // priced on the judge that used it. One lever from `select-cross-judge`, and the arm that can
  // answer "does canonicalisation recover what the swap lost".
  { name: 'select-cross-judge-canon', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, judge: 'second', canonical: true },
  // The same three prompts with the authorship majority reversed: two candidates from the
  // second model, one from the primary. One lever from `select-cross` — one candidate's author
  // — and the direct test of "whoever wrote two of the three wins the tie".
  { name: 'select-balanced', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: BALANCED_SOURCES },
  // The same three candidates in an order that does not follow authorship. `select-cross` and
  // `select-balanced` both move authors, and both keep the second model's statement in slot
  // zero, so authorship and position stay collinear over every arm measured so far: the 52.6%
  // that `@second` is returned at is compatible with "the judge prefers that author" and with
  // "the judge prefers slot zero", and the two readings predict opposite next steps. This arm
  // permutes the order per question id and changes nothing else — same candidates, same
  // prompts, same four calls — so the per-candidate `winnerSource` decides between them.
  { name: 'select-cross-shuffled', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, shuffle: true },
  // ...and the same aggregator on the cross-model set, where the candidates disagree by
  // model as well as by prompt.
  { name: 'vote-cross', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, mixed: CROSS_SOURCES },
  // The adopted arm plus one idea no earlier arm could test: a statement that returns no
  // rows is wrong on a split whose gold results are never empty, so the candidate that
  // returned nothing is dropped before the selector votes and, when every candidate is
  // empty, one more turn is spent telling the model what happened. One lever from
  // `select-mixed`; the drop costs nothing and the turn costs a call only where it fires.
  { name: 'select-mixed+empty', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: MIXED_SOURCES, emptyRetry: 'diagnosed' },
  // The same drop, the same extra call, the same adoption rule, and a message that says
  // nothing about the empty result. The pair with the arm above prices the information
  // instead of the call.
  { name: 'select-mixed+empty-blind', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: MIXED_SOURCES, emptyRetry: 'blind' },
  // The adopted arm plus a candidate generated by decomposition instead of by paraphrase.
  // One lever from `select-mixed` in the sense that matters — the candidate set grows by
  // one source, the selector and the prompts it already had are untouched — at one more
  // call, which is the price the ceiling has to earn.
  { name: 'select-mixed+dc', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 4, select: true, mixed: MIXED_DC_SOURCES },
  // ...and the same generator occupying the third slot instead of adding a fourth: same
  // three candidates, same four calls as the adopted arm, one source swapped.
  { name: 'select-dc', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: DC_SOURCES },
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
  // The same prompt, with the statement composed from step statements written in the same
  // reply. One lever from `inline+evidence` at the same call count, which is what makes it
  // comparable to the other generators rather than to the budget ladder.
  { name: 'decompose', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', decompose: true },
  { name: 'definitions+evidence', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'structural' },
  { name: 'synth-definitions+evidence', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'synthesized' },
  { name: 'metadata', notes: true, repairs: 0, linking: true },
  { name: 'synthetic', notes: true, evidence: 'synthetic', repairs: 0, linking: true },
  { name: 'synthetic+focus', notes: true, evidence: 'synthetic', repairs: 0, linking: true, focus: true },
  { name: 'metadata+evidence', notes: true, evidence: 'dataset', repairs: 0, linking: true },
  // The cheapest arm on the frontier with its card cut to the join closure. The card measurement
  // points at it: 90.5% of that prompt is the card, and 53.5% of the card belongs to tables the
  // gold statement never reads — so the lever that removed 12.6% of `select`'s prompt has more
  // to remove here, and the arm it acts on has no selector call to dilute the saving.
  { name: 'metadata+evidence+prune', notes: true, evidence: 'dataset', repairs: 0, linking: true, prune: 1 },
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
  'values',
  'metadata+evidence',
  // The only multi-call arm left in the chain, and it is here to keep the path alive rather
  // than to answer a question. Its verdict — 0.39pp over a single call on the dev split, at
  // 37% more tokens — cannot be resolved on the 498 questions this workflow runs, so running
  // it every push buys no reading. What it buys is execution: the selector is the one codepath
  // that a prompt change, a provider change or a refactor can break without any unit test
  // noticing, and `inline+retrieval` is the precedent — written, wired, paired and never run.
  // Its four calls are 2,540 of this chain's 11,075 prompt tokens per question.
  'select',
];

/**
 * The arms `bird-dev.yml` runs when a dispatch names none.
 *
 * The dev split is the one that decides adoption, so its default list is the adopted arms and
 * the arms they are read against — `select-mixed` (63.0% on 1,532 questions) is the ceiling, and
 * the other four are what that ceiling is 2.4pp above. The list lives here rather than in the
 * workflow so that `eval/baseline/bird.json` (`armsBySplit.dev`) and the YAML cannot drift into
 * two opinions about which arms a dev run has: the baseline says which arms a dev run must be
 * *able to fail*, this says which ones a routine run *asks for*, and the difference is derived —
 * `select-cross` carries a dev floor and needs a second model a routine dispatch does not
 * configure.
 */
export const DEV_ARMS: readonly string[] = ['names', 'inline+evidence', 'metadata+evidence', 'select', 'select-mixed'];

/**
 * Arms that exist for on-demand runs, each with the reason it is not in the chain.
 * An arm that is neither here nor in `DEFAULT_ARMS` fails the suite.
 */
export const ON_DEMAND_ARMS: Readonly<Record<string, string>> = {
  // Moved out of the chain in the round that priced it. Each has a verdict, and each verdict
  // was taken on the split that can express it; what none of them can do is produce a *new*
  // verdict on 498 questions, because every one of their gaps is inside its own MDE there.
  // Measured on `41116622974` (498 questions): `vote` +0.00pp against `select` (17:17, p = 1,
  // MDE 3.28pp) for 2,092 tokens a case; `select-duo` −0.60pp (14:11, p = 0.690); `select-prune`
  // −1.41pp through the card's ceiling (1,008 → 980 reachable cases); `select-mixed` +0.60pp
  // inside 2.10pp; `select5` +0.40pp inside 3.33pp for the largest bill in the catalogue.
  vote: 'majority over the same three candidates: the selector control, measured 17:17 against `select` (p = 1) — running it every push re-derives a tie at 2,092 tokens',
  'select-prune': 'the card cut to the join closure: measured −1.4pp, and the loss is the ceiling rather than the selector (1,008 → 980 reachable cases), so it is priced; run it when the card changes',
  'inline+evidence+llm-select': 'the card cut to the columns the model names: measured −5.65pp against its parent (53:25, p = 0.0020, MDE 4.99pp) on 496 questions at `41190457163`, with the choice deciding 495 of 496 cases and keeping 10.8% of the columns for +39% prompt tokens — the mechanism fires and is a net loss, so it is kept as the ablation reference for relevance-by-model rather than run on every push',
  'select-mixed': 'three decompositions instead of three samples: within its MDE of a single call on this split, and the decomposition question needs the dev split to be answered',
  'select-duo': 'two prompts and a selector: measured −0.60pp against `vote` for the same money, superseded',
  select5: 'five samples and a selector: 4,103 tokens a case, the largest bill in the catalogue, and +0.40pp inside a 3.33pp MDE — the arm whose own measurement says the ceiling is not the sampler',
  'inline+evidence+samples': "the same prompt with each categorical column's stored values on its card line: one lever, one call, and the untested half of value grounding",
  // Its note is a question until the run that answers it lands. Saying "measured" here before
  // the number exists is how an arm acquires a verdict it never earned.
  'inline+evidence+samples-wide': "the same lever with MAC-SQL's rule instead of ours: six most-frequent values of every non-key column, a small numeric dictionary included, a date collapsed to one, NULL first — dispatched to price the competitor's block on our cases, and until that artifact exists this note is the question rather than the verdict",
  definitions: 'structural semantics built from keys: superseded by inline placement, kept as the parent of definitions+evidence',
  'dataset-subset': 'isolates coverage from author, run when a definition arm moves',
  'definitions+evidence': 'second lever of the semantics chain, not a candidate for the chain itself',
  'synth-definitions+evidence': 'combines two levers already measured separately',
  interpret: 'one extra call per question; measured null, kept for re-testing',
  metadata: 'no definitions at all: parent of metadata+evidence, run only to re-derive the parent',
  'metadata+evidence+prune': 'one lever from metadata+evidence, on the arm where the card is 90.5% of the prompt: priced on the card measurement first, then dispatched, because the closure costs 33 of the 496 cases a gold table',
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
  'select-cross-canon': 'the cross set rewritten into one SQL style before the selector reads it: the lever that closes the style channel the judge swap proved is open, not a different judge; needs the second model, and is measured against `select-cross`',
  'select-cross-judge-canon': 'the canonical text read by the second model: the arm that prices canonicalisation where the style channel was measured, one lever from `select-cross-judge` and two from `select-cross-canon`; needs the second model and a second key',
  'select-balanced': 'the same three prompts with two candidates from the second model instead of one: flips which author holds the majority, and needs the second model',
  'select-cross-shuffled': 'the same three candidates permuted per question id: flips which author holds slot zero, which is the one thing `select-cross` and `select-balanced` both hold fixed; needs the second model',
  plan: 'query plan before the statement: 50.4% against 57.6% for its parent (-7.2pp, 63/27, p=0.0002) — anchoring, not helping; kept so the finding can be re-tested',
  'select-pair': 'pairwise comparison instead of an absolute ranking: 58.4% against 57.6% for its parent (+0.8pp, 17/20, p=0.74) at one more call, and it lost more of its candidate set (25 cases against 20) — the absolute prompt is not what the selector loses; kept so a different comparison order or a two-of-three vote can be measured against it',
  'inline+shape': 'scalar-shape guard before the repair loop: 57.2% against 58.4% for its parent (-1.2pp, 11/5, p=0.21) — it fired on 21 cases, repaired 2, and shifted 14 more into the wrong column count; kept so a better shape test can be measured against this one',
  'select-mixed+empty': 'the adopted arm with an empty result treated as a failure: drops the candidate that returned nothing and spends one turn when every candidate did; the only lever measured so far whose signal is exact rather than heuristic',
  'select-mixed+empty-blind': 'the same drop and the same extra call with a message that says nothing about the empty result: the control that separates the information from the call, and it cannot be dispensed with, because a second draw at a non-zero temperature also moves the number',
  decompose: 'the statement composed from steps written in the same reply: one lever from `inline+evidence` at the same call count, so it prices a shape of generation rather than a budget',
  'select-mixed+dc': 'the adopted arm with a fourth candidate written by decomposition: the only addition that can create a statement the three prompts cannot, which is what the routing analysis left open',
  'select-dc': 'the third candidate written by decomposition instead of by the value index: same count, same four calls, and the slot values actually won 5.3% of the time',
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
  // The block the competitor's selector reads, against the same card without it, and against
  // the same lever under our own sampler: the first prices the information, the second prices
  // the rule that selected it.
  ['inline+evidence', 'inline+evidence+samples-wide', "the competitor's value examples on our card: the block MAC-SQL's selector reads, priced against the card without it"],
  ['inline+evidence+samples', 'inline+evidence+samples-wide', 'the same lever under two samplers: which columns are shown and what a shown column says'],
  ['inline+evidence', 'metadata+evidence', 'generated definitions on the column line versus 798 curated notes'],
  ['inline+evidence', 'select-mixed', 'three decompositions and a selector versus a single sample: four calls instead of one'],
  ['select', 'select-duo', 'two prompts and a selector versus three samples of one prompt: three calls instead of four'],
  ['select-duo', 'select-mixed', 'the value-grounded candidate on top of two prompts: does a third source add anything'],
  ['select', 'select-prune', 'the same three samples and the same selector with a card cut to the join closure: does the model need the tables the question does not reach'],
  // The cost frontier, stated as comparisons rather than left to a reader of the token
  // column. These pairs are the ones that decide whether a multi-call arm is worth its
  // bill, so they are measured on the same cases in the same run instead of being
  // reconstructed afterwards from two artifacts that happened to share a split.
  ['metadata+evidence', 'select', 'one prompt carrying 798 curated notes against three samples and a selector: three stack levels and 3.6 times the tokens'],
  ['metadata+evidence', 'select-prune', 'the same single prompt against the pruned card: the cheapest multi-call arm, priced against the cheapest arm'],
  ['metadata+evidence', 'select-mixed', 'the same single prompt against three decompositions and a selector: what the fourth call buys when the candidates are aimed'],
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
  // One lever: who cuts the card — nobody, or the model in one call before the statement. The
  // only card pair in this table whose rule is not the lexical linker, which is what makes it
  // the pair that can price relevance-by-model against relevance-by-graph.
  ['inline+evidence', 'inline+evidence+llm-select'],
  ['vote', 'select'],
  // Where the candidates come from, held against how many there are: same count, same
  // selector, different prompts.
  ['select', 'select-mixed'],
  // One lever: the card. Same linker, same samples, same selector — the prompt carries the
  // closure of the tables the question names instead of the whole schema.
  ['select', 'select-prune'],
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
  // One lever: the same candidates in one SQL style, so the selector cannot see who wrote them.
  ['select-cross', 'select-cross-canon'],
  // One lever on the judge that used the channel: the same canonical text, read by its author.
  ['select-cross-judge', 'select-cross-judge-canon'],
  // One lever: which author holds the majority among the same three prompts.
  ['select-cross', 'select-balanced'],
  // One lever: where the authors sit, holding the majority and the prompts fixed. The pair
  // that can say whether the 52.6% belongs to the author or to slot zero.
  ['select-cross', 'select-cross-shuffled'],
  // One lever: the same candidates and selector, with an empty result treated as a
  // failure — dropped before the vote and retried once when nothing survives.
  ['select-mixed', 'select-mixed+empty'],
  // One lever: the words of the extra turn, at the same cost on the same cases.
  ['select-mixed+empty-blind', 'select-mixed+empty'],
  ['select', 'select5'],
  ['inline+evidence', 'values'],
  ['inline+evidence', 'plan'],
  // One lever at the same cost: the statement is composed from steps written in the same
  // reply, which is the generator the routing analysis says is the only one left.
  ['inline+evidence', 'decompose'],
  // ...and the same generator as a fourth candidate beside the adopted trio.
  ['select-mixed', 'select-mixed+dc'],
  // Same three candidates, same cost, one source swapped: which prompt earns the third slot
  // when the value block is empty on 61% of the split.
  ['select-mixed', 'select-dc'],
  ['definitions', 'definitions+evidence'],
  ['synth-definitions', 'synth-definitions+evidence'],
  ['names', 'metadata'],
  ['metadata', 'synthetic'],
  ['synthetic', 'synthetic+focus'],
  ['synthetic', 'metadata+evidence'],
];

/**
 * Why a candidate is missing from the set the ceiling is taken over.
 *
 * One number used to hold two mechanisms, and the two call for opposite repairs: a statement
 * the engine refused means the prompt writes SQL that will not run, a reply the parser could not
 * read means the prompt produced nothing usable. A rerun put 440 of 4,596 candidates in that one
 * cell and 375 of the 380 cases that were short a candidate were short the *second model's* —
 * which is either a cross-arm ceiling finding or a prompt finding, and the merged counter could
 * not say which.
 */
export interface CandidateFailures {
  /** The endpoint did not answer: a throttled key, an outage, a timeout. */
  readonly llm: number;
  /** The statement was written and the database refused to run it. */
  readonly engine: number;
  /** No statement could be read out of the reply, or the call failed for a reason that is not the endpoint. */
  readonly unparsed: number;
}

/** What one case cost the endpoint, in the endpoint's own unit. */
export interface CaseTokens {
  readonly prompt: number;
  readonly completion: number;
  /**
   * Characters of the requests those tokens were counted from.
   *
   * The same calls, message for message, so the ratio between this and `prompt` is a fact about
   * one request. Pairing the token count with a character count taken from the system message
   * alone would produce a ratio no tokenizer stands behind — the selector call sends candidates
   * and no system card, and it is a quarter of the bill.
   */
  readonly chars: number;
  /** Answers that arrived without a usage block: a cost that is unknown, not zero. */
  readonly unbilled: number;
  /**
   * The same cost split by what each call was for.
   *
   * Absent on an artifact written before the meter split it. Present, it sums to the fields
   * above exactly, because both are written at the same point rather than recounted later.
   */
  readonly byPurpose?: Readonly<Record<string, PurposeCost>>;
}

/** One kind of call: what those calls cost this case. */
export interface PurposeCost {
  readonly calls: number;
  readonly prompt: number;
  readonly completion: number;
  readonly chars: number;
  readonly unbilled: number;
}

export interface CaseRun extends CaseOutcome {
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
   * What the endpoint said it billed for this case, in its own unit.
   *
   * `calls` counts what the harness asked for and this counts what came back, because the two
   * disagree in two ways worth seeing: a provider out of balance answers nothing, and a provider
   * that omits its usage block answers without a price. `unbilled` is how many answers arrived
   * without one — a case whose cost is unknown rather than zero — so the cost column can be
   * refused instead of published as a saving.
   */
  readonly tokens?: CaseTokens;
  /**
   * Which decomposition the returned statement came from, on a mixed arm.
   *
   * Three candidates at the same price can hide a generator that never wins, and a
   * generator that never wins is a call that should not be in the set.
   */
  readonly winnerSource?: string;
  /**
   * The candidate set, in the order the selector saw it, with the truth for each.
   *
   * `candidateRecall` says whether the set held an answer; it cannot say *which* candidate
   * held it, so a selection loss has no address. The cross-vendor run lost 75 cases while
   * its set held the answer 1,018 times, and the artifact could not distinguish "the
   * selector rejected the second model's statement" from "it took a wrong statement while
   * a right one sat next to it" — two readings that call for opposite fixes. Recording the
   * verdict per candidate makes every loss attributable from the file.
   *
   * Absent for an arm that generates once, where the set has one member and the answer is
   * already in `passed`.
   *
   * On a shuffled arm this is also the position record: entry `i` sat in slot `i` of the
   * prompt, so `source` crossed with the index says both who wrote the candidate and where it
   * was offered. That is what makes "52.6% for the author" and "52.6% for slot zero"
   * separable after the fact, without a second field to drift out of step with the order.
   */
  readonly candidates?: readonly { readonly source: string; readonly correct: boolean }[];
  /** Candidates the selector was not offered because their result was empty. */
  readonly emptyDropped?: number;
  /** True when the winner returned nothing and one more turn was spent. */
  readonly emptyRetried?: boolean;
  /** True when that turn produced a statement that returned rows. */
  readonly emptyRecovered?: boolean;
  /**
   * What the column choice kept, on the one arm that makes a choice.
   *
   * `kept` of `total` is the lever's own mechanism made visible per case: an arm whose reply
   * resolved nothing sends the whole card and is reported as `decided: false`, so "the model
   * chose the whole card" and "the model chose nothing" stay different numbers instead of both
   * looking like a card that did not shrink.
   */
  readonly columnSelection?: {
    readonly named: number;
    readonly unknown: number;
    readonly kept: number;
    readonly total: number;
    readonly decided: boolean;
  };
  /**
   * Candidates that never arrived, by reason.
   *
   * A sampling arm's ceiling is a property of its candidate set, and a candidate the
   * endpoint refused is missing from that set. Reporting only the cases where *every*
   * candidate failed hides the run where one of three was refused for all 1,532
   * questions — which reads as a lower ceiling and is an outage.
   */
  readonly candidateFailures?: CandidateFailures;
  /**
   * Per source: how many candidates it was asked for, and how many arrived.
   *
   * A mixed arm draws exactly one candidate from each source (a contract the suite enforces),
   * so a source that survived on 60% of the questions is a source that was refused or unparsed on
   * the other 40%. `candidateFailures` says how many were lost; this says *whose* — and on the
   * cross-model arm the answer was 375 of 380 times the second model, which is a statement about
   * that endpoint or that prompt rather than about the selector.
   */
  readonly candidateSurvival?: Readonly<Record<string, { readonly generated: number; readonly survived: number }>>;
  /**
   * What the decomposition prompt produced, on the candidates that were asked for one.
   *
   * `steps` is zero when the model ignored the format, and that is the number that
   * decides whether the arm measured decomposition or a longer instruction: the
   * report refuses to publish an arm whose own mechanism never fired.
   */
  readonly decomposition?: { readonly candidates: number; readonly steps: number };
  readonly error?: string;
  readonly errorKind?: 'execution' | 'guard' | 'llm' | 'shape' | 'harness' | 'other';
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
 * One row of `report.arms`.
 *
 * Typed rather than `unknown` so the completeness check reads the same fields the writer
 * fills, which is the only way a dropped instrument can be caught at write time. The open
 * index signature keeps the rest of a row — cost, errors, difficulty, selector counts —
 * out of this type's business.
 */
/**
 * Two meters' buckets, added by purpose.
 *
 * `first` is the primary model's and `second` an optional second model's. A purpose spent on
 * both sides is summed rather than listed twice: a cost table with two `select` rows is a table
 * whose share nobody can divide by.
 */
export function mergePurposes(
  first: ReadonlyMap<string, PurposeUsage>,
  second?: ReadonlyMap<string, PurposeUsage>,
): Readonly<Record<string, PurposeCost>> {
  const total: Record<string, { calls: number; prompt: number; completion: number; chars: number; unbilled: number }> = {};
  for (const source of second === undefined ? [first] : [first, second]) {
    for (const [purpose, usage] of source) {
      const slot = (total[purpose] ??= { calls: 0, prompt: 0, completion: 0, chars: 0, unbilled: 0 });
      slot.calls += usage.calls;
      slot.prompt += usage.promptTokens;
      slot.completion += usage.completionTokens;
      slot.chars += usage.chars;
      slot.unbilled += usage.unbilled;
    }
  }
  return total;
}

export interface ArmReportRow {
  readonly arm: string;
  readonly total: number;
  readonly decomposition?: { readonly asked: number; readonly fired: number; readonly share: number; readonly meanSteps: number };
  readonly candidateRecall?: number;
  readonly emptyRetry?: { readonly mode: string; readonly dropped: number; readonly fired: number; readonly recovered: number };
  /**
   * What the arm spent per case, and — when the meter split it — how much of that each kind of
   * call was. The split is what turns "the selector should earn its tokens" into a column.
   */
  readonly tokens?: {
    readonly prompt: number;
    readonly completion: number;
    readonly chars: number;
    readonly unbilled: number;
    readonly byPurpose?: Readonly<Record<string, { readonly calls: number; readonly prompt: number; readonly completion: number; readonly chars: number }>>;
  };
  readonly [field: string]: unknown;
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
/**
 * Can this candidate set ever be three opinions?
 *
 * The question is about the *split*, not about the sample: the first version of this check ran
 * on whatever `BIRD_LIMIT` selected, and a five-question run whose questions name no literal
 * had three sources collapse to two and was declared broken — the same mistake the check exists
 * to prevent, a sample standing in for the whole. It now fires only on a whole-split run and
 * reports the sample as a sample otherwise.
 */
export function assertMixedFeasible(
  armName: string,
  sources: readonly string[],
  counted: { distinct: readonly string[]; degenerate: readonly string[] },
  wholeSplit: boolean,
): string | undefined {
  if (!wholeSplit) {
    const total = counted.distinct.length + counted.degenerate.length;
    return `${armName}: this run sampled the split; ${String(counted.distinct.length)} of ${String(total)} questions could build ${String(sources.length)} distinct prompts, so the duplicate count describes the sample`;
  }
  if (counted.distinct.length === 0) {
    throw new Error(`arm ${armName} builds no question with ${String(sources.length)} distinct prompts from ${sources.join(', ')}; it would pay ${String(sources.length)} times for one opinion on every case`);
  }
  return undefined;
}

/**
 * What an escaped error means.
 *
 * A provider error that got past the per-sample catch is still the provider's; anything else
 * is this harness's own bug. Both used to be recorded as `llm`, which made a `TypeError` look
 * like a throttled endpoint and let the failure-share guard blame the wrong party. The
 * distinction is the difference between "the run did not happen" and "the run is wrong", and
 * only one of them should be retried.
 */
export function escapeKind(error: unknown): 'llm' | 'harness' {
  const code = (error as { code?: string } | undefined)?.code;
  return typeof code === 'string' && code.startsWith('NL2C_E_LLM') ? 'llm' : 'harness';
}

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
  // "Timed out" is not "busy": one is the endpoint queueing, the other is this harness giving
  // up. The message says which, because the fix is different and 1,355 of 1,532 cases were once
  // reported as an outage when the deadline was the cause.
  const hint = first.includes('timed out')
    ? ' Every failure is a timeout, so the deadline (BIRD_LLM_TIMEOUT_MS) may be shorter than the model needs.'
    : '';
  throw new Error(
    `arm ${armName}: ${String(failures.length)} of ${String(runs.length)} calls (${(share * 100).toFixed(1)}%) failed at the model, ` +
      `above the ${(maxShare * 100).toFixed(0)}% this harness treats as an outage (first error: ${first}).${hint} ` +
      'The accuracy would be a function of how busy the endpoint was.',
  );
}

/**
 * A harness error is a bug, not a property of the data.
 *
 * The case wrapper exists so one bad case cannot end a 1,532-question run, but the price of
 * that is silence: a `TypeError` inside the runner scores as a wrong answer and the arm looks
 * slightly worse. Any occurrence is reported with its first message, because a run with a bug
 * in it should not produce a number anyone quotes.
 */
export function assertHarnessClean(armName: string, runs: readonly { errorKind?: string; error?: string }[]): void {
  const broken = runs.filter((run) => run.errorKind === 'harness');
  if (broken.length === 0) return;
  const first = broken.find((run) => run.error !== undefined)?.error ?? 'no error text';
  throw new Error(
    `arm ${armName}: ${String(broken.length)} of ${String(runs.length)} cases failed inside the harness, not at the model ` +
      `(first: ${first}). This is a bug in the runner, and its accuracy would be a measurement of the bug.`,
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
 * A candidate the endpoint refused is a missing candidate, not a wrong one.
 *
 * `assertFailureRate` looks at cases, which is right for "did this arm run at all". It
 * cannot see a run where one of three candidates was refused on every question: every
 * case still returns an answer, the ceiling falls, and the artifact has no field that
 * says why. One dev run lost its second endpoint to a quota error mid-run and reported a
 * ceiling 2pp below the previous one for exactly this reason.
 */
/**
 * Per-source survival, summed over the run.
 *
 * `candidateFailures` answers "how many candidates were lost"; this answers "whose". On the
 * cross-model arm the two are different questions with different repairs — a second endpoint that
 * refused its candidate is a vendor problem, and a prompt that never parsed is ours.
 */
export function candidateSurvivalBySource(
  runs: readonly { candidateSurvival?: Readonly<Record<string, { readonly generated: number; readonly survived: number }>> }[],
): Record<string, { generated: number; survived: number }> {
  const out: Record<string, { generated: number; survived: number }> = {};
  for (const run of runs) {
    for (const [source, count] of Object.entries(run.candidateSurvival ?? {})) {
      const total = (out[source] ??= { generated: 0, survived: 0 });
      total.generated += count.generated;
      total.survived += count.survived;
    }
  }
  return out;
}

/**
 * Which of the three mechanisms a failed candidate belongs to.
 *
 * The error codes already distinguish them, and the distinction is exactly the repair:
 *
 *   `NL2C_E_TIMEOUT` / `NL2C_E_LLM_UNAVAILABLE`  the endpoint did not answer      -> llm
 *   `NL2C_E_GUARD_REJECTED` / `NL2C_E_ENGINE_FAILED`  a statement that must not run -> engine
 *   `NL2C_E_LLM_INVALID_RESPONSE` and everything else  no usable statement         -> unparsed
 *
 * `INVALID_RESPONSE` is deliberately *not* `llm`: the endpoint answered, the answer was unusable,
 * which is output quality and not an outage. Counting it as an outage would let a prompt that
 * produces unparseable replies fail the run with "the endpoint is down".
 */
export function classifyCandidateFailure(code: string | undefined): keyof CandidateFailures {
  if (code === 'NL2C_E_TIMEOUT' || code === 'NL2C_E_LLM_UNAVAILABLE') return 'llm';
  if (code === 'NL2C_E_GUARD_REJECTED' || code === 'NL2C_E_ENGINE_FAILED') return 'engine';
  return 'unparsed';
}

export function candidateFailureTotals(
  runs: readonly { candidateFailures?: CandidateFailures }[],
): CandidateFailures {
  return runs.reduce<CandidateFailures>(
    (total, run) => ({
      // A record written before the split carries no `engine`/`unparsed`. Reading its merged
      // `other` as either half would invent which mechanism it was, so the halves total zero.
      llm: total.llm + (run.candidateFailures?.llm ?? 0),
      engine: total.engine + (run.candidateFailures?.engine ?? 0),
      unparsed: total.unparsed + (run.candidateFailures?.unparsed ?? 0),
    }),
    { llm: 0, engine: 0, unparsed: 0 },
  );
}

export function assertCandidateSurvival(
  armName: string,
  runs: readonly { candidateFailures?: CandidateFailures }[],
  vote: number,
  maxShare = 0.1,
): void {
  const attempted = runs.length * vote;
  if (attempted === 0) return;
  const lost = candidateFailureTotals(runs).llm;
  const share = lost / attempted;
  if (share <= maxShare) return;
  throw new Error(
    `arm ${armName}: ${String(lost)} of ${String(attempted)} candidates (${(share * 100).toFixed(1)}%) never arrived from the model, ` +
      `above the ${(maxShare * 100).toFixed(0)}% this harness treats as an outage. ` +
      'The candidate set is smaller than the arm declares, so its ceiling measures the endpoint.',
  );
}


/**
 * What the empty-result lever did, on the cases that ran.
 *
 * Three numbers, because the lever has two parts and they are priced differently:
 * `dropped` is a decision that costs nothing, `fired` is the reach of the extra call,
 * and `recovered` is what that call bought. An arm that reports the third without the
 * second has lost the denominator.
 */
export function emptyRetryFunnel(runs: readonly CaseRun[]): {
  readonly dropped: number;
  readonly fired: number;
  readonly recovered: number;
  readonly extraCallsPerCase: number;
} {
  const fired = runs.filter((run) => run.emptyRetried === true).length;
  return {
    dropped: runs.reduce((total, run) => total + (run.emptyDropped ?? 0), 0),
    fired,
    recovered: runs.filter((run) => run.emptyRecovered === true).length,
    extraCallsPerCase: Number((fired / Math.max(1, runs.length)).toFixed(4)),
  };
}

/**
 * An empty lever is a bug, not a null result.
 *
 * The same reasoning as `assertRepairPathFired`: on a split where 37% of cases are wrong,
 * a mechanism that fires on none of them did not run, and its 0.0pp delta would otherwise
 * be published as "this does not help".
 */
export function assertEmptyRetryFired(
  armName: string,
  runs: readonly CaseRun[],
  minimumSample = 100,
): void {
  if (runs.length < minimumSample) return;
  // The lever has two halves and only one of them is unconditional: dropping costs nothing
  // and happens on any case with a mixed candidate set, while the turn needs every
  // candidate to come back empty, which is rarer. So the error is "neither happened" — the
  // same condition the gate checks, because a runner that refuses a run its gate accepts
  // is the drift this project keeps finding.
  const dropped = runs.reduce((total, run) => total + (run.emptyDropped ?? 0), 0);
  if (dropped > 0 || runs.some((run) => run.emptyRetried === true)) return;
  throw new Error(
    `arm ${armName}: across ${String(runs.length)} questions no candidate returned an empty result, so neither the drop nor the turn ran — the lever did not run`,
  );
}

/**
 * What the decomposition produced, over the cases that asked for one.
 *
 * `asked` is the denominator the share needs: an arm whose fourth candidate failed to
 * arrive on a tenth of the questions asked for a decomposition on nine tenths of them,
 * and a share taken over all the cases would blame the prompt for the endpoint.
 */
export function decompositionFunnel(runs: readonly CaseRun[]): {
  readonly asked: number;
  readonly fired: number;
  readonly share: number;
  readonly meanSteps: number;
} {
  const asked = runs.filter((run) => run.decomposition !== undefined);
  const fired = asked.filter((run) => (run.decomposition?.steps ?? 0) > 0).length;
  const steps = asked.reduce((total, run) => total + (run.decomposition?.steps ?? 0), 0);
  const candidates = asked.reduce((total, run) => total + (run.decomposition?.candidates ?? 1), 0);
  return {
    asked: asked.length,
    fired,
    share: asked.length === 0 ? 0 : fired / asked.length,
    meanSteps: candidates === 0 ? 0 : Number((steps / candidates).toFixed(2)),
  };
}

/**
 * What the column choice kept, over the cases that made one.
 *
 * `cardShare` is the mean of the per-case `kept / total`, not the ratio of the sums: databases
 * differ by a factor of ten in column count, and a ratio of sums would let one wide database
 * decide what "the card shrank" means. `decided` is reported beside it because a reply that
 * resolved nothing sends the whole card and would otherwise look like a choice that kept
 * everything.
 */
export function columnChoiceFunnel(runs: readonly CaseRun[]): {
  readonly cases: number;
  readonly decided: number;
  readonly decidedShare: number;
  readonly unknown: number;
  readonly cardShare: number;
} | undefined {
  const chosen = runs.filter((run) => run.columnSelection !== undefined);
  if (chosen.length === 0) return undefined;
  const decided = chosen.filter((run) => run.columnSelection?.decided === true).length;
  const shares = chosen.map((run) => {
    const record = run.columnSelection as NonNullable<CaseRun['columnSelection']>;
    return record.total === 0 ? 1 : record.kept / record.total;
  });
  return {
    cases: chosen.length,
    decided,
    decidedShare: Number((decided / chosen.length).toFixed(4)),
    unknown: chosen.reduce((total, run) => total + (run.columnSelection?.unknown ?? 0), 0),
    cardShare: Number((shares.reduce((total, share) => total + share, 0) / chosen.length).toFixed(4)),
  };
}

/**
 * A column-choosing arm whose choice never removed a column measured nothing.
 *
 * The same rule as `assertEmptyRetryFired` and `assertRepairPathFired`: a lever that fires on
 * every case with a full card is indistinguishable from an arm that spends a call to be told
 * what it already had, and its delta would be published as "choosing columns does not help".
 */
export function assertColumnChoiceRan(armName: string, runs: readonly CaseRun[], minimumSample = 100): void {
  if (runs.length < minimumSample) return;
  const chosen = runs.filter((run) => run.columnSelection !== undefined);
  if (chosen.length === 0) {
    throw new Error(`arm ${armName}: no case recorded a column choice, so the lever did not run`);
  }
  const shrank = chosen.filter((run) => {
    const record = run.columnSelection as NonNullable<CaseRun['columnSelection']>;
    return record.decided && record.kept < record.total;
  });
  if (shrank.length > 0) return;
  throw new Error(
    `arm ${armName}: across ${String(chosen.length)} questions the choice never removed a column — the lever did not run`,
  );
}

/**
 * An arm that asks for samples and shows none is its parent under another name.
 *
 * `check-bird-baseline.mjs` already refuses a samples arm with no values behind it, and it is
 * not enough for two reasons that this assertion closes at the source. It matches the arm's
 * *name* for `samples`, so an arm whose sampler is declared but named otherwise is invisible to
 * it; and it reads `controls.sampledColumns`, which is a total over every database the run
 * touched, so a run holding one samples arm and one plain arm has a positive total whichever
 * sampler fired. This reads the arm's own declaration and the arm's own count, which is the
 * quantity the floor gate is trying to infer.
 */
export function assertSamplesRan(
  armName: string,
  sampled: { readonly columns: number; readonly values: number },
): void {
  if (sampled.columns > 0 && sampled.values > 0) return;
  throw new Error(
    `arm ${armName}: the card was asked to carry stored values and ${String(sampled.columns)} column(s) had any, so the arm is its parent renamed`,
  );
}

/** True when this arm asks any of its candidates to decompose. */
export function declaresDecomposition(arm: Pick<Arm, 'decompose' | 'mixed'>): boolean {
  return arm.decompose === true || (arm.mixed ?? []).some((source) => parseMixedSource(source).arm === 'decompose');
}

/**
 * The funnel as the artifact states it, or nothing when no case asked.
 *
 * Extracted because the field was emitted inside the spread reserved for arms that sample
 * several candidates, so a single-candidate arm's funnel existed in memory and never
 * reached the report: `decompose` scored 911/1,532 on `40534288883` with its own guard
 * satisfied, and the gate read the missing field as "the prompt was never asked to
 * decompose". An arm's instrument belongs to the arm, not to how many candidates it draws.
 *
 * Zero asked cases yield `{}` rather than `{asked: 0, ...}`: the gate divides by `asked`
 * to check the share, so an empty funnel would be a claim with no denominator.
 */
export function armDecomposition(runs: readonly CaseRun[]): { decomposition?: ReturnType<typeof decompositionFunnel> } {
  const funnel = decompositionFunnel(runs);
  return funnel.asked === 0 ? {} : { decomposition: funnel };
}

/**
 * The artifact has to carry every instrument its arms declare.
 *
 * Three kinds of claim live in a report: what an arm was configured to do (resolved from
 * `ARMS`), what it did (the funnels), and what it scored. Nothing compared the first two,
 * so a dropped funnel was invisible at write time and was diagnosed downstream as a
 * mechanism that never ran — the wrong cause, in the one artifact a 90-minute run produces.
 * This runs before the file is written and names the arm and the missing field.
 */
export function assertReportComplete(report: { readonly arms?: readonly ArmReportRow[] }): void {
  for (const row of report.arms ?? []) {
    const arm = resolveArm(row.arm);
    if (arm === undefined) {
      throw new Error(`the report carries a row for ${row.arm}, an arm this build does not know, so its instruments cannot be checked`);
    }
    if (declaresDecomposition(arm) && row.decomposition === undefined) {
      throw new Error(`arm ${row.arm} asks for a decomposition and its row carries no decomposition funnel: the instrument ran and the artifact dropped it`);
    }
    if ((arm.vote ?? 1) > 1 && row.candidateRecall === undefined) {
      throw new Error(`arm ${row.arm} samples ${String(arm.vote)} candidates and its row carries no candidate ceiling, so its accuracy cannot be read`);
    }
    if (arm.emptyRetry !== undefined && row.emptyRetry === undefined) {
      throw new Error(`arm ${row.arm} runs the empty-result lever and its row carries no empty-result funnel, so the call cannot be priced`);
    }
  }
}

/**
 * A decomposition that never happened is not a null result.
 *
 * The instruction is one paragraph in a prompt that already carries a schema, a hint and
 * two rules; a model that ignores it produces the parent arm's statement with a longer
 * prompt, and the delta would be published as though the mechanism had run. The threshold
 * is deliberately blunt — more than half the cases and more than one step on average — so
 * that it refuses an arm that plainly did not do the task and accepts a model that
 * decomposes some questions and answers others directly, which is the behaviour the
 * mechanism claims to have.
 */
export function assertDecompositionFired(armName: string, runs: readonly CaseRun[], minimumSample = 100): void {
  if (runs.length < minimumSample) return;
  const funnel = decompositionFunnel(runs);
  if (funnel.asked === 0) {
    throw new Error(
      `arm ${armName}: no case reports a decomposition across ${String(runs.length)} questions — the prompt was never asked to decompose, so the lever did not run`,
    );
  }
  if (funnel.share < 0.5 || funnel.meanSteps < 1.5) {
    throw new Error(
      `arm ${armName}: the model wrote steps on ${String(funnel.fired)} of ${String(funnel.asked)} cases ` +
        `(${(funnel.share * 100).toFixed(1)}%, ${String(funnel.meanSteps)} steps per case), which is not enough to say the arm measured decomposition rather than a longer prompt`,
    );
  }
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

/**
 * How many questions a run was asked to score, or `undefined` for "whatever the split holds".
 *
 * The default used to be the split's published size — 500 for Mini-Dev, 1534 for dev — and that
 * number was a *row* count. Once `selection.available` became a count of question ids (Mini-Dev's
 * file carries 500 rows for 498 ids, because 137 and 138 each appear twice), the default asked for
 * two questions that do not exist: every push declared `requested: 500` against `available: 498`
 * and the floor gate failed the build with "the run asked for 500 questions and split minidev has
 * 498" (run 41169457147). The size of a split is a property of its file, so the value that means
 * "all of it" is the absence of a number rather than a second copy of the number that can drift.
 *
 * A value that is not a positive whole number of questions throws rather than falling back:
 * `BIRD_LIMIT=abc` quietly scoring the whole split is the same defect in a quieter form — a
 * published number whose sample nobody chose.
 */
export function parseLimit(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`BIRD_LIMIT=${JSON.stringify(raw)} is not a question count; leave it unset to score the whole split`);
  }
  return value;
}

/**
 * The sample size a run will use, given how many questions the split actually holds.
 *
 * Asking for more questions than exist is a typo, not a subset, so this throws with both numbers
 * instead of clamping: a clamp would publish a smaller sample under the number the caller declared,
 * and `selection.requested` is meant to be readable as a declaration rather than as a wish.
 */
export function resolveLimit(limit: number | undefined, available: number): number {
  if (limit === undefined) return available;
  if (limit > available) {
    throw new Error(
      `BIRD_LIMIT=${String(limit)} asks for more questions than this split holds (${String(available)}); ` +
        'leave it unset to score all of them',
    );
  }
  return limit;
}

/**
 * Where a run reads and writes.
 *
 * These used to be module constants read from `process.env` at import time, which made
 * the layout a property of the *process* rather than of the run: a test could only point
 * a run at a temporary dataset by re-importing the module, and a dry run could not be
 * reproduced from its own artifact because the paths were never in it. They are a value
 * now — resolved from an environment and a root, then passed down — which is what lets
 * `runBird` be called twice in one process against two different datasets.
 */
export type BirdSplit = 'minidev' | 'dev';

export interface BirdLayout {
  readonly root: string;
  /**
   * `minidev` is the 498-question subset (500 rows) CI runs on every commit. `dev` is the
   * 1,534-question split the published leaderboards report, kept for on-demand runs
   * because a full sweep costs a model call per question per arm.
   */
  readonly split: BirdSplit;
  readonly data: string;
  /** The file name differs per split; everything else in the layout is identical. */
  readonly questionsFile: string;
  readonly tablesFile: string;
  /** Where the SQLite files live; the oracle roots here. */
  readonly databaseRoot: string;
  /** Where `database_description/*.csv` live. Always under `data`, even when the databases are not. */
  readonly descriptionsRoot: string;
  readonly trainFile: string;
  readonly valueCache: string;
  readonly profileCache: string;
  /** Where `value-examples.ts` caches its per-database block. */
  readonly exampleCache: string;
  readonly definitionsCache: string;
  readonly definitionsFile: string;
  readonly oracleScript: string;
  readonly out: string;
}

/**
 * Where this file lives. The oracle is harness code, not dataset: it must be found even
 * when the run points at a dataset outside the repository, so it is resolved against the
 * module rather than against the run's root.
 */
const HARNESS = resolve(new URL('.', import.meta.url).pathname);

export function resolveLayout(env: Readonly<Record<string, string | undefined>>, root: string): BirdLayout {
  const split = (env.BIRD_SPLIT ?? 'minidev') as BirdSplit;
  const data =
    env.BIRD_DATA ??
    (split === 'dev'
      ? join(root, 'eval/.cache/bird/dev/dev_20240627')
      : join(root, 'eval/.cache/bird/minidev/MINIDEV'));
  return {
    root,
    split,
    data,
    questionsFile: join(data, split === 'dev' ? 'dev.json' : 'mini_dev_sqlite.json'),
    tablesFile: join(data, 'dev_tables.json'),
    databaseRoot: env.BIRD_DATABASES ?? join(data, 'dev_databases'),
    descriptionsRoot: join(data, 'dev_databases'),
    trainFile: join(root, 'eval/.cache/bird/train/train.json'),
    valueCache: join(root, 'eval/.cache/bird/values'),
    profileCache: join(root, 'eval/.cache/bird/profiles'),
    // The competitor-rule sampler caches separately from the profiler: same column names,
    // different rule, and sharing a directory would serve one rule's answer under the other's
    // name. Old entries are rejected by the rule field they carry.
    exampleCache: join(root, 'eval/.cache/bird/value-examples'),
    definitionsCache: join(root, 'eval/.cache/bird/definitions'),
    // Definitions are an *input* to the definition-dependent arms, so they are pinned in
    // the repository rather than regenerated: two runs with identical prompts produced
    // different text for 6 of 11 databases, which moved `synth-definitions` by 5.1pp and
    // made every delta on that arm a joint measurement of prompt and text.
    definitionsFile: join(root, 'eval/baseline/definitions.minidev.json'),
    oracleScript: join(HARNESS, 'oracle.py'),
    out: env.BIRD_OUT ?? join(root, 'eval/out/bird-eval.json'),
  };
}

/**
 * Which databases a run covers comes from the fetch manifest, so widening the
 * dataset is one command (`fetch.mjs`) rather than two edits that can drift.
 */
export function databasesFromManifest(data: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(data, 'manifest.json'), 'utf8')) as {
      databases?: { db: string }[];
    };
    return (manifest.databases ?? []).map((entry) => entry.db);
  } catch {
    return [];
  }
}

/** The splits that ship a manifest are the derived ones; `dev` does not. */
export function databasesFromQuestions(questionsFile: string): string[] {
  try {
    const questions = loadQuestions(questionsFile);
    return [...new Set(questions.map((question) => question.db_id))].sort();
  } catch {
    return [];
  }
}

/**
 * Everything a run was told to do, and nothing it inferred.
 *
 * The environment is a parameter rather than a global: `resolveSettings` is a pure
 * function of (env, argv, root), so the arm list, the sample size and the second-model
 * credentials of a published number can be re-derived from the values that produced it
 * instead of from whatever the process happened to hold at import time.
 */
export interface BirdSettings {
  readonly layout: BirdLayout;
  readonly dryRun: boolean;
  /**
   * The sample size the caller named, or `undefined` for the whole split. A number here is a
   * declaration, so it is checked against the split that was read (`resolveLimit`) rather than
   * being carried into the artifact as if the split had that many questions.
   */
  readonly limit: number | undefined;
  readonly concurrency: number;
  readonly dbs: readonly string[];
  readonly arms: readonly string[];
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly second: { readonly model: string; readonly baseUrl: string; readonly apiKey: string };
  /**
   * The harness's own knobs, carried as values because a report that omits them cannot
   * say whether a difference between two runs is the pipeline or the instrument. A
   * glm-4.5 run once reported 88% "model failures" that were this deadline.
   */
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;
  readonly valuesForce: boolean;
  readonly definitionsForce: boolean;
}

export function resolveSettings(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  root: string,
): BirdSettings {
  const layout = resolveLayout(env, root);
  const fromManifest = databasesFromManifest(layout.data);
  const databaseList =
    env.BIRD_DBS !== undefined
      ? env.BIRD_DBS
      : (fromManifest.length > 0 ? fromManifest : databasesFromQuestions(layout.questionsFile)).join(',');
  return {
    layout,
    dryRun: argv.includes('--dry-run'),
    limit: parseLimit(env.BIRD_LIMIT),
    concurrency: Number(env.BIRD_CONCURRENCY ?? 8),
    dbs: databaseList
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    // Default chain: baseline, the two definition sources, the synthesized one
    // with the dataset hint, and last round's best arm as the ceiling reference.
    // `BIRD_AA=<arm>` appends the same arm a second time under a `#2` name. The delta
    // between the pair is the harness's own noise at this sample size, which no
    // amount of within-run pairing between *different* arms can reveal.
    arms: parseArms(env.BIRD_ARMS, env.BIRD_AA, DEFAULT_ARMS),
    model: env.LLM_MODEL ?? 'deepseek-chat',
    baseUrl: env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey: env.DEEPSEEK_API_KEY ?? env.LLM_API_KEY ?? '',
    // The second model exists for one arm (`select-cross`) and is absent otherwise. It is
    // optional on purpose: a run that does not need it must not fail because an unrelated
    // key is missing, and a run that does need it must fail with a sentence rather than
    // quietly generate two candidates where it promised three.
    second: {
      model: env.BIRD_SECOND_MODEL ?? '',
      baseUrl: env.BIRD_SECOND_BASE_URL ?? '',
      apiKey: env.BIRD_SECOND_API_KEY ?? env.ZHIPU_API_KEY ?? '',
    },
    timeoutMs: Number(env.BIRD_LLM_TIMEOUT_MS ?? 60000),
    retries: Number(env.BIRD_LLM_RETRIES ?? 3),
    retryDelayMs: Number(env.BIRD_LLM_RETRY_DELAY_MS ?? 1000),
    valuesForce: env.BIRD_VALUES_FORCE === '1',
    definitionsForce: env.BIRD_DEFINITIONS_FORCE === '1',
  };
}

/**
 * The candidates a selector is allowed to see.
 *
 * When empty results are treated as failures, a candidate that returned no rows is
 * removed before the vote — but only while something else is left. Removing every
 * candidate would leave nothing to select from, and the arm would report a selector
 * failure where the truth is that the whole set came back empty.
 */
export function offeredCandidates<T extends { readonly rows: readonly unknown[] }>(
  candidates: readonly T[],
  dropEmpty: boolean,
): { offered: readonly T[]; dropped: number } {
  if (!dropEmpty) return { offered: candidates, dropped: 0 };
  const nonEmpty = candidates.filter((candidate) => candidate.rows.length > 0);
  if (nonEmpty.length === 0) return { offered: candidates, dropped: 0 };
  return { offered: nonEmpty, dropped: candidates.length - nonEmpty.length };
}

/**
 * The candidate set, in the order the selector saw it, with the truth for each member.
 *
 * One pass of the official judge over the set answers both questions the report asks of
 * it — `candidateRecall` ("was the answer in there at all") and the per-candidate verdict
 * ("which member held it") — so the second cannot drift from the first. Judging each
 * candidate twice would let a loss be attributed to a candidate the recall count never
 * counted.
 */
export function candidateVerdicts(
  candidates: readonly { readonly rows: readonly (readonly unknown[])[]; readonly source: string }[],
  expected: readonly (readonly unknown[])[],
): readonly { readonly source: string; readonly correct: boolean }[] {
  return candidates.map((candidate) => ({ source: candidate.source, correct: judgeOfficial(expected, candidate.rows) === 'match' }));
}

/**
 * The candidate set as the selector will read it.
 *
 * `canonical` is a display transformation and stays one: the returned statements replace the
 * text the selector sees, while the winner is taken from the untouched set by index, so the
 * arm executes the model's own statement and every other report field describes what ran.
 * An index is the only thing that crosses from one to the other.
 */
export function readableCandidates<T extends { readonly sql: string }>(candidates: readonly T[], canonical: boolean | undefined): readonly T[] {
  if (canonical !== true) return candidates;
  return candidates.map((candidate): T => ({ ...candidate, sql: canonicalSql(candidate.sql) }));
}

/** FNV-1a over the string form of a key. Only needs to be stable across machines. */
function hash32(text: string): number {
  let hash = 2166136261;
  for (const character of text) {
    // `charCodeAt(0)` rather than `codePointAt(0) ?? 0`: the fallback is unreachable, and an
    // unreachable branch in a hash is a line of coverage nobody can honestly earn. Keys here
    // are question ids, so a surrogate pair never reaches this loop.
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * The same candidates, in an order that carries no information about authorship.
 *
 * The permutation is keyed by the question id so that two arms running the same question see
 * the same order, and so that a rerun is comparable to the run it is being compared with. Each
 * swap draws its own hash — `key#i` — rather than advancing one generator: a single stream
 * would make the order of question N depend on how many questions were processed before it,
 * which silently breaks that comparability under a different concurrency or a different limit.
 *
 * Fewer than two candidates have nothing to permute and are returned untouched, which keeps
 * the identity between a returned index and the set the arm executes.
 */
export function shuffleByCase<T>(candidates: readonly T[], key: string | number): readonly T[] {
  if (candidates.length < 2) return candidates;
  const out = [...candidates];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = hash32(`${String(key)}#${String(i)}`) % (i + 1);
    const swap = out[i] as T;
    out[i] = out[j] as T;
    out[j] = swap;
  }
  return out;
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
/**
 * Whether an instrument can rebuild this arm's prompt from the artifact alone.
 *
 * An arm whose prompt draws on a block the artifact does not keep cannot be measured offline
 * without inventing text, and inventing text is how a benchmark ends up reporting a prompt
 * nobody sent. Four blocks are in that position: a synthesized evidence hint, retrieved
 * neighbours (the artifact keeps their count, not their text), matched values and a
 * decomposition.
 *
 * Retrieved evidence was missing from this list until `bench:bird:card` was written, and the
 * hole was exactly where the comment said the check was: `inline+retrieval` came back
 * renderable, and `promptFor` then dropped the evidence block without saying so, so an
 * instrument would have measured a prompt with the retrieved text missing and reported it as
 * the prompt that was sent. No gate ran that arm — the gates run `select` — which is why the
 * hole survived.
 */
export function renderableArm(arm: Arm): boolean {
  return (
    arm.evidence !== 'synthetic' &&
    arm.evidence !== 'retrieved' &&
    arm.values !== true &&
    arm.demonstrations !== true &&
    arm.decompose !== true
  );
}

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
    samples: arm.samples !== undefined,
    schemaLines: BIRD_SCHEMA_LINES,
    ...(profile === undefined ? {} : { notes: profile.notes }),
    ...(arm.definitions !== undefined && definitions !== undefined && definitions.length > 0 ? { definitions } : {}),
    ...(evidence === undefined || evidence.length === 0 ? {} : { evidence }),
    ...(arm.demonstrations === true && demonstrations !== undefined && demonstrations.length > 0
      ? { demonstrations }
      : {}),
    ...(arm.values === true && values !== undefined && values.length > 0 ? { values } : {}),
    // The decomposition is part of the prompt, not a block written in an earlier call, so
    // it belongs here: the size this harness reports for the arm, and the distinct-prompt
    // count a mixed arm is checked against, both read this object.
    ...(arm.decompose === true ? { decompose: true } : {}),
  };
}

/** One advertised column the database does not have. */
export interface MissingColumn {
  readonly db: string;
  readonly table: string;
  readonly column: string;
}

/** A gold statement that does not run, and is therefore excluded rather than scored. */
export interface UnrunnableGold {
  readonly id: number;
  readonly db: string;
  readonly error: string;
}

/** Everything under `report.controls`, produced once by `prepareRun`. */
export interface Controls {
  selfConsistency: number;
  retrievalCorpus: number;
  retrievedBlocks: number;
  demonstrationBlocks: number;
  valueMatches: number;
  negativeChecked: number;
  negativeFalseMatches: number;
  emptyGoldExcluded: number;
  schemaChecked: number;
  schemaMissing: MissingColumn[];
  schemaMissingTotal: number;
  tablesInPrompts: number;
  tablesTotal: number;
  sampledColumns: number;
  sampledValues: number;
  truncatedPrompts: { db: string; shown: number; total: number }[];
  semanticsDatabases: number;
  semanticsDatabaseTotal: number;
  semanticsCases: number;
  semanticsMeanChars: number;
  synthesizedDefinitionDatabases: number;
  definitionsProvenance: Record<string, { hash: string; cached: boolean; source: string }>;
  synthesizedDefinitions: Record<string, string>;
  inlineAttached: number;
  inlineUnplaced: number;
  subsetComments: number;
  inlineSchemaComments: number;
  synthesizedDefinitionMeanChars: number;
}

/**
 * The card one case sends, and — on an arm that chooses columns — what the choice kept.
 *
 * Returned as one object rather than as a schema plus a side channel, because the artifact's
 * claim ("the model was shown these columns") and the prompt's content have to be the same
 * value. `columns` is absent for every arm that does not cut the card, so a reader can tell
 * "no choice was made" from "a choice kept everything".
 */
export interface CardOutcome {
  readonly schema: readonly SchemaTable[];
  readonly columns?: {
    readonly named: number;
    readonly unknown: number;
    readonly kept: number;
    readonly total: number;
    readonly decided: boolean;
  };
}

/**
 * The dataset, the schemas and every input block, gathered before an arm runs.
 *
 * Separated from the arm loop because two of the four things this harness must get right
 * — schema fidelity and the gold controls — are properties of the *inputs*. They used to
 * live inside the same 1,100-line function as the arm loop, so the only way to find out
 * whether they held was to spend a full model run.
 */
export interface PreparedRun {
  readonly settings: BirdSettings;
  /**
   * The pool the run draws from, as a set rather than a list: rows read, questions kept, and the
   * ids the file repeats. `questions` is one row per question id, so a rate computed from it is a
   * rate per question rather than per row of somebody else's file.
   */
  readonly shape: QuestionSet;
  readonly questions: readonly BirdQuestion[];
  /**
   * How many questions this run set out to score: the declared limit, or every question of the
   * split when none was declared. It is resolved once, against the file that was read, because the
   * artifact's `selection.requested` is a statement about this run and not about the split.
   */
  readonly limit: number;
  readonly selected: readonly BirdQuestion[];
  readonly cases: readonly BirdQuestion[];
  readonly schemas: ReadonlyMap<string, readonly SchemaTable[]>;
  readonly gold: ReadonlyMap<number, OracleResult>;
  readonly unrunnable: readonly UnrunnableGold[];
  readonly controls: Controls;
  /** Rendered prompt blocks for one arm and one question. The only builder, so the measured prompt and the sent prompt cannot disagree. */
  readonly blocksFor: (arm: Arm, question: BirdQuestion) => PromptBlocks;
  readonly schemaFor: (arm: Arm, question: BirdQuestion) => readonly SchemaTable[];
  /**
   * How many columns this arm's sampler put on a card, over the databases the run covers.
   *
   * The gate below reads it. `controls.sampledColumns` reports the same total for the run, which
   * is enough for a reader and not enough for a gate: with one samples arm and one plain arm in
   * the same run the total is positive even when the samples arm itself sampled nothing, so the
   * arm would publish as its parent renamed and every gate would be green.
   */
  readonly sampledFor: (arm: Arm) => { readonly columns: number; readonly values: number };
  /**
   * The card to send for one case, spending the call that a column-choosing arm costs.
   *
   * Asynchronous and provider-taking for one reason: the choice is a model call, and a model
   * call made outside the counter is a cost the arm reports as zero. The caller owns the counter
   * (`runArm` creates one per case), so the price of the lever lands in the same `calls` field as
   * the generation it precedes — which is how the selector's own metering bug was caught.
   */
  readonly cardFor: (arm: Arm, question: BirdQuestion, provider: LlmProvider) => Promise<CardOutcome>;
  /**
   * The card that was sent for this arm and question, from the run's own record.
   *
   * A read, not a second decision: the report's prompt-size column and the artifact's per-case
   * evidence both have to describe the card that was actually rendered, and re-deciding it after
   * the run would describe a card nobody saw. Before a run — a dry run's prompt preview — it
   * falls back to the arm's card without a choice, which the preview labels.
   */
  readonly cardOf: (arm: Arm, question: BirdQuestion) => CardOutcome;
  /** Per-arm distinct-prompt audit for the arms that declare a candidate set. */
  readonly mixedCandidatePrompts: readonly unknown[];
}

/** What `prepareRun` needs from outside: an execution oracle and a model. */
export interface PrepareIo {
  readonly oracle: Oracle;
  readonly provider: LlmProvider;
}

/**
 * How many questions of each difficulty a set holds.
 *
 * The sample's mix is the only thing that decides whether its accuracy estimates the split's,
 * so it is reported rather than assumed. Unknown difficulty files with the moderates, the same
 * rule the sampler uses — two places with two rules would let the artifact describe a mix the
 * sample does not have.
 */
export function difficultyMix(questions: readonly BirdQuestion[]): Record<string, number> {
  const mix: Record<string, number> = { simple: 0, moderate: 0, challenging: 0 };
  for (const question of questions) {
    const key = question.difficulty === 'simple' || question.difficulty === 'challenging' ? question.difficulty : 'moderate';
    mix[key] = (mix[key] ?? 0) + 1;
  }
  return mix;
}

export async function prepareRun(settings: BirdSettings, io: PrepareIo): Promise<PreparedRun> {
  const layout = settings.layout;
  const { oracle, provider } = io;
  const shape = distinctQuestions(
    loadQuestions(layout.questionsFile).filter((question) => settings.dbs.includes(question.db_id)),
  );
  const questions = shape.questions;
  if (questions.length === 0) {
    throw new Error(`no questions for ${settings.dbs.join(',')}; run node eval/bird/fetch.mjs first`);
  }
  const tables = loadTables(layout.tablesFile);
  // Resolved here, where both numbers are known, and not in `resolveSettings`, where only the
  // caller's wish is: the split's size belongs to the file and is read from it once.
  const limit = resolveLimit(settings.limit, questions.length);
  const selected = stratifiedSample(questions, limit);
  // The training split is external knowledge, not a held-out answer: it shares no
  // database with the split under test, which is asserted in the run controls.
  let retrievalIndex: ReturnType<typeof buildIndex> | undefined;
  try {
    retrievalIndex = buildIndex(
      JSON.parse(readFileSync(layout.trainFile, 'utf8')) as { db_id: string; question: string; evidence?: string }[],
    );
  } catch {
    retrievalIndex = undefined;
  }
  const needsRetrieval = settings.arms.some((name) => {
    const arm = resolveArm(name);
    return arm?.evidence === 'retrieved' || arm?.demonstrations === true;
  });
  if (needsRetrieval && retrievalIndex === undefined) {
    // An arm whose lever has no input is the parent arm with a different name: it ran
    // once, scored 44.4% against its parent's 43.6%, and the near-equality was read as
    // "retrieval does not help" when the truth was that nothing was retrieved.
    throw new Error(
      `arm(s) ${settings.arms.join(',')} need the BIRD training split; ` +
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

  const schemas = new Map<string, SchemaTable[]>();
  for (const db of settings.dbs) {
    const table = tables.get(db);
    if (table === undefined) throw new Error(`dev_tables.json has no entry for ${db}`);
    schemas.set(
      db,
      buildSchema(
        table,
        loadDescriptions(join(layout.descriptionsRoot, db, 'database_description'), table.tableNames),
        { withNotes: true },
      ),
    );
  }

  // 1. Schema fidelity. A prompt that advertises a column the database does not
  // have is a guaranteed failure, and it looks like a model error. The first
  // external run advertised BIRD's humanised names instead of the original ones
  // and 155 of 200 cases died on "no such column".
  const missingColumns: MissingColumn[] = [];
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
  for (const db of settings.dbs) {
    try {
      const profile = await profileDatabase(oracle, db, { cacheDir: layout.profileCache });
      profiles.set(db, profile);
      synthesized.set(db, renderEvidence(profile));
    } catch {
      synthesized.set(db, '');
    }
  }

  // The card with values on it, built once per database and only when an arm asks for it.
  //
  // `samples` is derived from the profile this run already loads, so the lever costs no
  // query: a column whose stored spellings are bounded is exactly a column a question can
  // fail to match, and showing them is the cheaper half of value grounding — it needs no
  // match between the question's wording and the store, which is where `values` stalls.
  const sampleValues = new Map<string, Map<string, readonly string[]>>();
  const exampleValues = new Map<string, Map<string, readonly string[]>>();
  const sampled = { columns: 0, values: 0 };
  const widen = settings.arms.some((name) => resolveArm(name)?.samples === 'example');
  if (settings.arms.some((name) => resolveArm(name)?.samples === 'profile')) {
    for (const [db, profile] of profiles) {
      const byColumn = sampleValuesOf(profile);
      sampled.columns += byColumn.size;
      for (const values of byColumn.values()) sampled.values += values.length;
      sampleValues.set(db, byColumn);
    }
  }
  // The competitor's rule needs its own query: it samples numeric columns the profile calls
  // measures, collapses dates, and marks nullability, so it cannot be derived from the
  // profile the other arms already load.
  for (const db of widen ? settings.dbs : []) {
    const set = await exampleSetFor(oracle, db, { cacheDir: layout.exampleCache });
    const byColumn = exampleMapOf(set);
    sampled.columns += byColumn.size;
    for (const values of byColumn.values()) sampled.values += values.length;
    exampleValues.set(db, byColumn);
  }

  const withSamples = (schema: readonly SchemaTable[], db: string, rule: 'profile' | 'example'): readonly SchemaTable[] => {
    const values = (rule === 'example' ? exampleValues : sampleValues).get(db);
    return values === undefined ? schema : attachSamples(schema, values);
  };

  // Value grounding: the literals the question names, looked up in this database.
  //
  // Scanned from the cells, not from the profile's top values: the profile keeps at
  // most thirty distinct values per categorical column and matched 90 of 498
  // questions, which measured the index rather than the idea. The scan is cached per
  // database because it costs one query per column.
  const valueIndexes = new Map<string, ValueIndex>();
  mkdirSync(layout.valueCache, { recursive: true });
  for (const [db, schema] of schemas) {
    const cacheFile = join(layout.valueCache, `${db}.json`);
    if (existsSync(cacheFile) && !settings.valuesForce) {
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
  const needsSynthesis = settings.arms.some((name) => {
    const source = resolveArm(name)?.definitions;
    return source === 'synthesized' || source === 'inline';
  });
  // Retries live in the provider, not in the loop below: a throttled call is the
  // endpoint's answer, not a property of this arm.
  // Definitions are pinned rather than regenerated; see `BirdLayout.definitionsFile`.
  const pinned = readPinnedDefinitions(layout.definitionsFile);
  if (!settings.dryRun && needsSynthesis && pinned !== undefined && !settings.definitionsForce) {
    for (const [db] of schemas) {
      const text = pinned.get(db);
      if (text === undefined || text.length === 0) {
        throw new Error(`pinned definitions have no entry for ${db}; regenerate with BIRD_DEFINITIONS_FORCE=1`);
      }
      synthesizedDefinitions.set(db, text);
      definitionsProvenance[db] = { hash: 'pinned', cached: true, source: 'pinned' };
    }
  } else if (!settings.dryRun && needsSynthesis) {
    for (const [db, schema] of schemas) {
      try {
        const outcome = await synthesizeRecord({
          oracle,
          db,
          schema,
          ...(profiles.get(db) === undefined
            ? {}
            : { profile: profiles.get(db) as NonNullable<ReturnType<typeof profiles.get>> }),
          provider,
          model: settings.model,
          force: settings.definitionsForce,
          cacheDir: layout.definitionsCache,
        });
        synthesizedDefinitions.set(db, outcome.definitions);
        definitionsProvenance[db] = { hash: outcome.hash, cached: outcome.cached, source: 'generated' };
      } catch (error) {
        // A failed generation leaves an empty block *and* a record of the failure. The
        // block alone was silent: `definitionsProvenance` had no key for the database, so
        // the artifact could not tell "the model declined" from "this arm never needed
        // definitions", and the arm then read as its parent with a longer prompt. The
        // report's own promise — which databases were written here and which came from
        // cache — is only true if a failure is one of the states it can report.
        synthesizedDefinitions.set(db, '');
        definitionsProvenance[db] = {
          hash: '',
          cached: false,
          source: `failed: ${error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)}`,
        };
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
  for (const db of settings.dbs) {
    const table = tables.get(db);
    if (table === undefined) continue;
    bareSchemas.set(
      db,
      buildSchema(table, loadDescriptions(join(layout.descriptionsRoot, db, 'database_description'), table.tableNames), {
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

  // One graph per database, built the first time a prune arm asks for it.
  const graphFor = graphForDatabase(tables);

  /**
   * The card an arm sends for one question.
   *
   * Takes the question rather than only its database because one lever is about the question: an
   * arm that sends the join closure decides per question which tables to show. Every caller that
   * cannot prune still passes the question, so there is one signature and one place where a card
   * is decided — a second entry point is how the measured prompt and the sent prompt drift apart.
   */
  const schemaFor = (arm: Arm, question: BirdQuestion): readonly SchemaTable[] => {
    const db = question.db_id;
    const base =
      arm.definitions === 'inline'
        ? (inlineSchemas.get(db) as SchemaTable[])
        : arm.definitions === 'dataset-subset'
          ? (subsetSchemas.get(db) as SchemaTable[])
          : (schemas.get(db) as SchemaTable[]);
    // Samples are layered on whatever the arm resolved to, not on the plain schema: an arm
    // can ask for both, and silently dropping one is a two-lever comparison nobody wrote.
    const layered = arm.samples === undefined ? base : withSamples(base, db, arm.samples);
    if (arm.prune === undefined) return layered;
    return pruneSchema({ schema: layered, question: question.question, graph: graphFor(db), hops: arm.prune }).schema;
  };

  /**
   * What each column-choosing arm actually sent, keyed by arm and question.
   *
   * A record rather than a memo: the same arm measured twice (an A/A control) has to spend the
   * choice twice, or its cost per case describes one run and its accuracy describes two. The last
   * write wins, which is why `cardOf` is documented as "the card that was sent" and not "the card
   * this case sent" — for an A/A pair the two are the same card by construction.
   */
  const sentCards = new Map<string, CardOutcome>();
  const cardKey = (arm: Arm, question: BirdQuestion): string => `${arm.name}\u0000${String(question.question_id)}`;

  const cardFor = async (arm: Arm, question: BirdQuestion, provider: LlmProvider): Promise<CardOutcome> => {
    const base = schemaFor(arm, question);
    if (arm.columnSelect !== true) return { schema: base };
    const reply = await provider.complete({
      messages: [
        { role: 'system', content: buildColumnPrompt(question.question, base) },
        { role: 'user', content: question.question },
      ],
      temperature: 0,
      purpose: 'columns',
    });
    const choice = parseColumnChoice(reply.text, base);
    const applied = applyColumnChoice(base, choice);
    const outcome: CardOutcome = {
      schema: applied.schema,
      columns: {
        named: choice.named.length,
        unknown: choice.unknown.length,
        kept: applied.kept,
        total: applied.total,
        decided: choice.decided,
      },
    };
    sentCards.set(cardKey(arm, question), outcome);
    return outcome;
  };

  const cardOf = (arm: Arm, question: BirdQuestion): CardOutcome =>
    sentCards.get(cardKey(arm, question)) ?? { schema: schemaFor(arm, question) };

  const gold = new Map<number, OracleResult>();
  const unrunnable: UnrunnableGold[] = [];
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
    const card = renderSchemaCard(schema, BIRD_SCHEMA_LINES, { descriptions: true, foreignKeys: true, samples: false });
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

  const controls: Controls = {
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
    // Columns whose stored values reached the card, and how many values that is. An arm
    // that asks for samples and gets none is its parent renamed, so the count is a control
    // and the gate reads it.
    sampledColumns: sampled.columns,
    sampledValues: sampled.values,
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
        const prompt = buildSqlPrompt(question.question, schemaFor(arm, question), promptFor(arm, question, blocksFor(arm, question)));
        return `${spec.provider}\u0000${prompt}`;
      });
      (new Set(built).size === sources.length ? distinct : degenerate).push(String(question.question_id));
    }
    return { distinct, degenerate };
  };
  const mixedCandidatePrompts = settings.arms
    .map((name) => resolveArm(name))
    .filter((arm): arm is Arm => arm !== undefined && arm.mixed !== undefined)
    .map((arm) => {
      const sources = arm.mixed as readonly string[];
      const counted = distinctShare(sources);
      // `selected.length`, not `cases.length`: two questions whose gold statements refused do not
      // make a full run a sample, and the guard below must not be skipped because of them.
      const note = assertMixedFeasible(arm.name, sources, counted, selected.length === questions.length);
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
        // A sampled run's degeneracy share describes the sample, not the split. Sampling is
        // `selected` versus the pool; a case count that fell short because a gold statement refused
        // is a different fact and used to be read as a sample.
        sampled: selected.length !== questions.length,
        ...(note === undefined ? {} : { note }),
      };
    });

  return {
    settings,
    shape,
    questions,
    limit,
    selected,
    cases,
    schemas,
    gold,
    unrunnable,
    controls,
    blocksFor,
    schemaFor,
    // Summed over the databases the run covers rather than read off the first one: a run can
    // mix a database with dictionaries and one without, and the first is not the run.
    sampledFor: (arm: Arm) => {
      const maps = arm.samples === 'example' ? exampleValues : sampleValues;
      let columns = 0;
      let values = 0;
      for (const db of settings.dbs) {
        const byColumn = maps.get(db);
        columns += byColumn?.size ?? 0;
        for (const list of byColumn?.values() ?? []) values += list.length;
      }
      return { columns, values };
    },
    cardFor,
    cardOf,
    mixedCandidatePrompts,
  };
}

/**
 * Which model judged, or `null` when no arm asked for a swap.
 *
 * `null` means "nobody judged but the primary model", not "no second model is configured":
 * a run that has one configured and no judged arm would otherwise publish the name of a
 * model that never read anything. The distinction is the whole reason a judge-swap result
 * can be attributed, and it was written inline where no test could choose the second arm.
 */
export function judgeModelName(
  arms: readonly string[],
  second: Pick<BirdSettings['second'], 'model'>,
): string | null {
  return arms.some((name) => resolveArm(name)?.judge === 'second') ? second.model : null;
}

/** The report before any arm runs: everything the inputs alone can say. */
export function baseReport(prepared: PreparedRun): Record<string, unknown> {
  const { settings, shape, questions, limit: preparedLimit, selected, cases, unrunnable, controls } = prepared;
  const layout = settings.layout;
  return {
    dataset: 'bird-mini-dev',
    // Derived from the split actually loaded. It was the literal `mini_dev_sqlite`, so every
    // dev artifact said mini_dev_sqlite at the top level and `dev` inside `selection`, and
    // nothing read the duplicate field so nothing noticed. The gate now compares the two.
    split: layout.split,
    dialect: 'SQLite',
    model: settings.dryRun ? null : settings.model,
    // Which model wrote the `@second` candidates, when an arm draws one. Without it the
    // cross-arm artifact cannot be reproduced and its number has no subject.
    secondModel: settings.second.model === '' ? null : settings.second.model,
    // ...and which model judged, when an arm asks the second one to. A judge swap is the one
    // experiment whose result is unreadable without this field.
    judgeModel: judgeModelName(settings.arms, settings.second),
    // The instrument's own settings. Same argument as the model: two runs of "the same"
    // configuration can differ by the deadline, the concurrency or the retry budget, and a
    // report that omits them cannot say whether a difference is the pipeline or the harness.
    run: {
      timeoutMs: settings.timeoutMs,
      concurrency: settings.concurrency,
      retries: settings.retries,
    },
    generatedAt: new Date().toISOString(),
    // The arms this run set out to score. A subset is a measurement of those arms, and the
    // gate needs the declaration to tell it from a report that lost a row: the run that
    // scored six arms on dev was failed for not running two it never asked for.
    armsRequested: settings.arms,
    selection: {
      // The databases this run actually scored. It used to be the databases that were asked
      // for, which is a different claim: a 120-question sample of dev covered 2 of the 11.
      databases: [...new Set(cases.map((question) => question.db_id))].sort(),
      availableDatabases: [...new Set(questions.map((question) => question.db_id))].sort(),
      // Rows and questions are two different counts, and only one of them is a denominator. The
      // split's file carries 500 rows for 498 ids; a report that said `available: 500` was
      // quoting a row count as if it were a question count.
      rows: shape.rows,
      available: questions.length,
      repeats: shape.repeats.map((repeat) => repeat.id),
      // What the run asked for, resolved against the file it read: equal to `available` when the
      // caller named no size. It used to be the unresolved declaration — which the default made
      // 500 on a 498-question split, so every push declared a request for two questions that do
      // not exist and the floor gate read that as a changed sample (run 41169457147).
      requested: preparedLimit,
      split: layout.split,
      scored: cases.length,
      // Whether the pool was sampled or scored whole. The two facts `scored < available` confuses —
      // a sample, and a full run that lost cases to refused gold — decide different things, and one
      // of them is whether a rate estimates the split at all.
      sampled: selected.length !== questions.length,
      // What this sample actually is, not what the sampler was meant to do. A subset's
      // accuracy is an estimate of the split only if its difficulty mix and its databases
      // match, and both were invisible in the artifact while the sampler allocated one case
      // per bucket and consumed them in file order: 120 questions of dev came back 40/40/40
      // from a split that is 60/30/10, drawn from 2 of 11 databases.
      strategy: 'proportional to the split difficulty mix (largest remainder), seeded order within each stratum',
      mix: { sample: difficultyMix(selected), available: difficultyMix(questions) },
    },
    gold: {
      executed: selected.length,
      runnable: cases.length,
      // The whole list, not the first twenty. `score.ts` reads it to tell a question whose gold
      // refused from a question the file no longer holds, and a truncated list would make the
      // twenty-first refusal look like a numbering error in the competitor's file.
      unrunnable,
      runnableRate: cases.length / selected.length,
    },
    controls,
    mixedCandidatePrompts: prepared.mixedCandidatePrompts,
  };
}

/**
 * The dry-run body: what each arm would send, without sending it.
 *
 * The preview shows the arms this run was told to score, not the head of the chain.
 * It used to render `ARMS[0]` and `ARMS[1]` whatever `BIRD_ARMS` said, so the dry run
 * of a new lever put two unrelated prompts in the artifact and the lever stayed
 * unverified — and the second field was named `definitionsPrompt` after whichever arm
 * happened to sit at that index, which nothing read either.
 */
export function previewPrompts(prepared: PreparedRun, report: Record<string, unknown>): void {
  const preview = prepared.settings.arms.map((name) => resolveArm(name)).filter((arm): arm is Arm => arm !== undefined);
  report.prompts = prepared.cases.slice(0, 3).map((question) => ({
    id: question.question_id,
    arms: preview.map((arm) => {
      const rendered = buildSqlPrompt(
        question.question,
        prepared.cardOf(arm, question).schema,
        promptFor(arm, question, prepared.blocksFor(arm, question)),
      );
      // A dry run spends no calls, so an arm whose card is decided by a model call cannot show
      // the card it would send. Saying so is the only honest option: a preview presented as the
      // sent prompt while the sent prompt is smaller is the drift this harness exists to avoid.
      return {
        arm: arm.name,
        chars: rendered.length,
        prompt: rendered,
        ...(arm.columnSelect === true ? { card: 'before-column-selection' } : {}),
      };
    }),
  }));
  report.arms = [];
}

/**
 * Mean calls per case, counted at the provider, so a delta can be divided by what it
 * cost. `attempts` cannot serve here: it counts generations inside a repair loop and
 * knows nothing about a selector call or the second call a plan costs, which made
 * selection look free and a plan candidate look like one call.
 */
export function meanCalls(runs: readonly { readonly calls: number }[]): number {
  return runs.length === 0 ? 1 : runs.reduce((total, run) => total + run.calls, 0) / runs.length;
}

/** What one arm produced: its cases, its artifact row and the line printed for it. */
export interface ArmRun {
  readonly name: string;
  readonly runs: readonly CaseRun[];
  readonly row: ArmReportRow;
  readonly line: string;
}

/** What `runArm` needs from outside. */
export interface ArmIo {
  readonly oracle: Oracle;
  readonly provider: LlmProvider;
  readonly second?: LlmProvider;
}

/**
 * One arm over every case.
 *
 * The arm-level guards run here, before any number leaves this function: an arm that never
 * reached the database has no accuracy, a candidate that never arrived shrinks the set the
 * ceiling is taken over, and a bug in this file is not a wrong answer.
 */
export async function runArm(prepared: PreparedRun, name: string, io: ArmIo): Promise<ArmRun> {
  const { settings, cases, gold } = prepared;
  const { oracle, provider, second: secondProvider } = io;
  const arm = resolveArm(name);
  if (arm === undefined) throw new Error(`unknown arm ${name}`);
  // A mixed arm runs three configurations under one label; if one of them repairs or
  // samples, the reported cost is wrong and the comparison loses its meaning.
  if (arm.mixed !== undefined) {
    assertMixedSources(arm.mixed);
    if (arm.mixed.length !== arm.vote) {
      throw new Error(
        `arm ${name} draws ${String(arm.mixed.length)} sources but declares ${String(arm.vote ?? 1)} candidates; the cost claim would be false`,
      );
    }
  }
  const runs = await pool(cases, settings.concurrency, async (question): Promise<CaseRun> => {
    // Counted, not derived: a plan costs two calls, a selector costs one, and a
    // configuration-derived count got both wrong in opposite directions.
    const counter = withCallCounter(provider);
    const secondCounter = secondProvider === undefined ? undefined : withCallCounter(secondProvider);
    // The card first, through the counter: on a column-choosing arm the choice is a call, and a
    // card decided by an uncounted provider would report the lever as free.
    const card = await prepared.cardFor(arm, question, counter.provider);
    const schema = card.schema;
    // Both models' calls are this case's cost. Summing two counters keeps the number
    // measured on each side instead of estimated from the arm's configuration.
    const callsMade = (): number => counter.calls() + (secondCounter?.calls() ?? 0);
    // Both models' usage is this case's cost, for the same reason both counters are. Added on
    // the way out rather than at each of the eleven return sites in this function, because a
    // cost that has to be remembered per branch is a cost that will be missing from one.
    const costOfCase = (): Pick<CaseRun, 'tokens'> => {
      const primary = counter.usage();
      const second = secondCounter?.usage();
      return {
        tokens: {
          prompt: primary.promptTokens + (second?.promptTokens ?? 0),
          completion: primary.completionTokens + (second?.completionTokens ?? 0),
          chars: primary.chars + (second?.chars ?? 0),
          unbilled: primary.unbilled + (second?.unbilled ?? 0),
          // The same money, split by what each call was for. A cross arm draws candidates from a
          // second model and may have that model judge them, so one purpose can be spent on both
          // sides; adding per purpose keeps one row per kind of call, which is the only shape a
          // share can be read from.
          byPurpose: mergePurposes(counter.byPurpose(), secondCounter?.byPurpose()),
        },
      };
    };
    // One case cannot take the run down. A provider error raised outside the per-sample
    // catch — the selector call, an engine call — used to escape the pool and end a
    // 1,532-question run at case 700 with a stack trace, which is why this wrapper
    // exists: an escaped error becomes a recorded `llm` failure, and the failure-share
    // guard decides whether the run is publishable.
    const guarded = async (work: () => Promise<CaseRun>): Promise<CaseRun> => {
      try {
        return await work();
      } catch (error) {
        const kind = escapeKind(error);
        return {
          id: String(question.question_id),
          passed: false,
          predicted: '',
          reason: 'values',
          strict: false,
          attempts: 1,
          // `llm` only when the provider said so. A bug in this file is `harness`, which
          // the failure-share guard ignores and `assertHarnessClean` refuses to publish.
          errorKind: kind,
          error: `${kind}: ${error instanceof Error ? error.message : String(error)}`,
          calls: callsMade(),
        };
      }
    };
    const scored = await guarded(async (): Promise<CaseRun> => {
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
          decompose: target.decompose === true,
          ...(target.repairFeedback === undefined ? {} : { repairFeedback: target.repairFeedback }),
          temperature: target.vote === undefined ? 0 : 0.7,
          prompt: promptFor(target, question, prepared.blocksFor(target, question)),
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
        // A candidate that never arrived is not a candidate that was wrong, and the
        // difference is invisible in `candidateRecall`: an endpoint that refuses one of
        // three calls lowers the ceiling exactly as much as a prompt that writes a bad
        // statement. Counting them apart is the only way to tell the two apart after
        // the run, because by then the request is gone.
        const lost: { llm: number; engine: number; unparsed: number } = { llm: 0, engine: 0, unparsed: 0 };
        // Who was asked, and who answered. Kept per source because a merged count cannot say
        // whether the cross arm's missing candidate came from the second model or from one of
        // the two prompts the primary model wrote.
        const survival: Record<string, { generated: number; survived: number }> = {};
        // Only the candidates that were asked to decompose are counted here, and they are
        // counted whether or not the statement ran: the question is what the prompt
        // produced, not whether the engine liked it.
        let decomposedCandidates = 0;
        let decomposedSteps = 0;
        for (let sample = 0; sample < arm.vote; sample += 1) {
          try {
            // A mixed arm draws each candidate from a different decomposition. The
            // sources repair nothing by contract (asserted in the test suite), so a
            // candidate is always one generation and the cost stays three calls.
            const sources = arm.mixed;
            const source = sources === undefined ? name : (sources[sample % sources.length] as string);
            const spec = parseMixedSource(source);
            const drawn = (survival[source] ??= { generated: 0, survived: 0 });
            drawn.generated += 1;
            const sampler = sources === undefined ? pipeline : pipelineFor(resolveArm(spec.arm) as Arm, spec.provider);
            const askedSample = await sampler.ask({ question: question.question, schema });
            // The mechanism has to be observable, not declared: a prompt that asks for
            // steps and gets none is the plain generator with a longer instruction, and
            // the two arms would then differ by wording rather than by method.
            if (askedSample.decomposedSteps !== undefined) {
              decomposedCandidates += 1;
              decomposedSteps += askedSample.decomposedSteps;
            }
            const executed = await oracle.run(question.db_id, askedSample.sql);
            if (executed.ok) {
              candidates.push({ sql: askedSample.sql, rows: executed.rows, source });
              drawn.survived += 1;
            }
            else {
              // A statement the engine refused is a candidate that never arrived, and it used
              // to be dropped in silence here: `if (executed.ok) push` has no else, so the set
              // shrank, the case still answered, the ceiling fell, and `candidateFailures`
              // stayed zero — the same defect `assertCandidateSurvival` was written for on the
              // endpoint side. The verdict on a set that is missing a member is not a fact
              // about the selector, so the loss is counted where it happened.
              sampleErrors.push(undefined);
              lost.engine += 1;
            }
          } catch (error) {
            // A sample that fails the guard or the engine casts no vote; the other
            // samples still produce one. The reason is kept for the zero-candidate case.
            // Three outcomes, not two, and the error code already says which: the endpoint did
            // not answer, the statement must not run, or no statement came out. Merging them let
            // a prompt that produced nothing usable be read as a throttled key.
            const kind = classifyCandidateFailure((error as { code?: string }).code);
            sampleErrors.push(kind === 'llm' ? 'llm' : undefined);
            lost[kind] += 1;
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
            candidateFailures: lost,
            // The case where every candidate died is the one a per-source record is most needed
            // for, and it is the one the success path cannot write.
            ...(Object.keys(survival).length === 0 ? {} : { candidateSurvival: survival }),
            ...(decomposedCandidates === 0 ? {} : { decomposition: { candidates: decomposedCandidates, steps: decomposedSteps } }),
            calls: callsMade(),
          };
        }
        // An empty result is not an option on this benchmark: no question in either
        // split has an empty gold result, so a statement that returned nothing is wrong
        // by construction. Dropping it costs no call and can only help the selector,
        // which otherwise spends a tie-breaker on a candidate that cannot win. When
        // every candidate is empty there is nothing to drop, and the turn below is the
        // one thing left to spend.
        const choice = offeredCandidates(candidates, arm.emptyRetry !== undefined);
        const choosable = choice.offered as typeof candidates;
        const majority = majorityResult(choosable, (left, right) => judgeOfficial(left.rows, right.rows) === 'match');
        let winner = majority.winner as { sql: string; rows: readonly (readonly unknown[])[]; source: string };
        let selectedByModel: boolean | undefined;
        // The order the selector will read, which is the raw order unless the arm permutes it.
        // The vote above deliberately ran on the unpermuted set, so a tie it breaks is broken the
        // same way in both arms; only the selector's information changes. `ordered` is what the
        // per-candidate record below is written from, because a verdict is only attributable if
        // it is filed under the slot the judge actually saw.
        const ordered = arm.shuffle === true ? shuffleByCase(choosable, question.question_id) : choosable;
        if (arm.select === true) {
          // What the selector reads, as opposed to what the arm runs: on a canonical arm the
          // text carries no author signature, and `winner` below still comes from the raw set.
          const readable = readableCandidates(ordered, arm.canonical);
          // The model sees what the vote cannot: the shape of each result. A statement
          // that answers a "how many" with 500 rows is wrong for a reason no majority
          // of identical mistakes will reveal.
          const offered = readable.map((candidate) => ({
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
              ? await chooseCandidatePairwise(judge, question.question, readable)
              : await (async () => {
                  const reply = await judge.complete({
                    messages: [
                      { role: 'system', content: buildSelectionPrompt(question.question, offered) },
                      { role: 'user', content: question.question },
                    ],
                    temperature: 0,
                    purpose: 'select',
                  });
                  const applied = applySelection(reply.text, offered);
                  return { index: applied.index, decided: applied.decided, sql: (offered[applied.index] as { sql: string }).sql };
                })();
          winner = ordered[decision.index] as typeof winner;
          selectedByModel = decision.decided;
        }
        // The last thing this arm can learn for free: the winner ran and produced
        // nothing. On a split whose gold results are never empty that is proof of a
        // wrong statement, and the only information a second statement lacks is what
        // this one returned.
        let recovered = false;
        let retried = false;
        if (arm.emptyRetry !== undefined && winner.rows.length === 0) {
          retried = true;
          const sourceArm = arm.mixed === undefined ? arm : (resolveArm(parseMixedSource(winner.source).arm) as Arm);
          const retryPrompt = buildAskMessages({
            question: question.question,
            schema,
            prompt: promptFor(sourceArm, question, prepared.blocksFor(sourceArm, question)),
            linking: sourceArm.linking,
          });
          const reply = await counter.provider.complete({
            messages: [...retryPrompt.messages, ...emptyRetryMessages(arm.emptyRetry, winner.sql, winner.sql)],
            // The arm samples above zero, so a blind turn is a different draw and not a
            // copy of the statement it replaces. Both modes use the same temperature:
            // the pair differs by the words, and by nothing else.
            temperature: 0.7,
            purpose: 'retry',
          });
          const candidate = extractSql(reply.text);
          if (inspectSql(candidate).ok) {
            const executed = await oracle.run(question.db_id, candidate);
            // A replacement that returns rows is adopted; one that also returns nothing
            // is kept as well, because the statement it replaces is equally wrong and
            // this one was written with more in front of it. A replacement that fails to
            // run is discarded: the original at least produced a result.
            if (executed.ok) {
              recovered = executed.rows.length > 0;
              winner = { sql: candidate, rows: executed.rows, source: winner.source };
            }
          }
        }
        const reason = judgeOfficial(expected.rows, winner.rows);
        // Judged once here and read twice below: the ceiling and the per-candidate record
        // are the same pass, so a loss cannot be attributed to a member the ceiling count
        // never saw.
        const verdicts = candidateVerdicts(ordered, expected.rows);
        return {
          id: String(question.question_id),
          passed: reason === 'match',
          predicted: winner.sql,
          reason,
          strict: judgeStrict(expected.rows, winner.rows) === 'match',
          attempts: arm.vote + (retried ? 1 : 0),
          agreement: majority.agreement,
          candidateRecall: verdicts.some((verdict) => verdict.correct),
          ...(verdicts.length < 2 ? {} : { candidates: verdicts }),
          ...(selectedByModel === undefined ? {} : { selectedByModel }),
          ...(arm.mixed === undefined ? {} : { winnerSource: winner.source }),
          ...(arm.emptyRetry === undefined
            ? {}
            : { emptyDropped: choice.dropped, emptyRetried: retried, emptyRecovered: recovered }),
          ...(lost.llm + lost.engine + lost.unparsed === 0 ? {} : { candidateFailures: lost }),
          ...(Object.keys(survival).length === 0 ? {} : { candidateSurvival: survival }),
          ...(decomposedCandidates === 0 ? {} : { decomposition: { candidates: decomposedCandidates, steps: decomposedSteps } }),
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
            ...(asked.decomposedSteps === undefined ? {} : { decomposition: { candidates: 1, steps: asked.decomposedSteps } }),
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
          ...(asked.decomposedSteps === undefined ? {} : { decomposition: { candidates: 1, steps: asked.decomposedSteps } }),
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
    return { ...scored, ...costOfCase(), ...(card.columns === undefined ? {} : { columnSelection: card.columns }) };
  });
  // Before any number is printed: an arm that never reached the database has no
  // accuracy, and publishing 0% would hide the provider's message behind a score.
  assertArmProducedResults(name, runs);
  assertFailureRate(name, runs);
  if (arm.columnSelect === true) assertColumnChoiceRan(name, runs);
  // ...and a candidate that never arrived shrinks the set the ceiling is taken over,
  // which no case-level count can see.
  if (arm.vote !== undefined && arm.vote > 1) assertCandidateSurvival(name, runs, arm.vote);
  // `engine` refusals are deliberately *not* guarded here: a statement that will not run is the
  // model's output quality, which is what the arm is measuring. The endpoint rule above is an
  // infrastructure verdict and belongs in a guard; this one belongs in the report. A run whose
  // every candidate the engine refused (a read-only database and a prompt that writes INSERTs)
  // is a 0% reading, not a broken harness -- the first version of this split failed that case
  // and the suite said so.
  // ...and a bug in the runner is not a wrong answer: it fails the arm outright.
  assertHarnessClean(name, runs);
  if (arm.repairs > 0) assertRepairPathFired(name, runs);
  if (arm.emptyRetry !== undefined) assertEmptyRetryFired(name, runs);
  // ...and an arm that asks for samples and gets none is its parent under another name.
  if (arm.samples !== undefined) assertSamplesRan(name, prepared.sampledFor(arm));
  // ...and a format the model ignored is not a prompt that did not help.
  if (declaresDecomposition(arm)) assertDecompositionFired(name, runs);
  return { name, runs, row: armReportRow(prepared, arm, runs, name), line: armSummaryLine(name, arm, runs) };
}

/**
 * The one-line-per-arm summary, built from the same numbers the artifact carries.
 *
 * `label` is the name the run asked for, which is not always the arm's own name: the A/A
 * duplicate resolves to the same `Arm` and must still print as `names#2`.
 */
export function armSummaryLine(label: string, arm: Arm, runs: readonly CaseRun[]): string {
  const summary = summarise(label, runs);
  const printed = repairAccounting(arm, runs);
  const vote = arm.vote;
  return (
    `${label.padEnd(9)} ${summary.passed}/${summary.total}  ${(summary.accuracy * 100).toFixed(1)}%  ` +
    `strict ${runs.filter((run) => run.strict).length}` +
    `${printed.repaired === undefined ? '' : `  repaired ${String(printed.repaired)}`}` +
    `${printed.samples === undefined ? '' : `  samples ${String(printed.samples)}`}` +
    `${vote === undefined ? '' : ceilingColumn(vote, candidateCeiling(runs))}`
  );
}

/**
 * The ceiling column, on the arms that have a candidate set to measure.
 *
 * `vote` is a number here rather than `arm.vote ?? 1`: the column only exists when the arm
 * samples, so the fallback could not be reached, and a test cannot choose a value that
 * never occurs. Its presence in the template made the branch unreachable, which is the
 * same defect as an untested one — a claim the reader has to verify (ADR-219).
 */
function ceilingColumn(
  vote: number,
  ceiling: { candidateRecallShare: number; selectionLoss: number },
): string {
  return `  recall@${String(vote)} ${(ceiling.candidateRecallShare * 100).toFixed(1)}% (lost ${String(ceiling.selectionLoss)})`;
}

/**
 * One arm's row in the artifact.
 *
 * `label` is the requested name for the same reason `armSummaryLine` takes it: two rows
 * with one label would let a duplicate stand in for the arm it duplicates, and the A/A
 * pair would silently compare an arm with itself.
 */
export function armReportRow(prepared: PreparedRun, arm: Arm, runs: readonly CaseRun[], label: string): ArmReportRow {
  const { cases } = prepared;
  const summary = summarise(label, runs);
  const strictPassed = runs.filter((run) => run.strict).length;
  const byDifficulty: Record<string, { passed: number; total: number }> = {};
  for (const run of runs) {
    const difficulty = cases.find((question) => String(question.question_id) === run.id)?.difficulty ?? 'unknown';
    const bucket = (byDifficulty[difficulty] ??= { passed: 0, total: 0 });
    bucket.total += 1;
    if (run.passed) bucket.passed += 1;
  }
  // The cases whose cost the endpoint reported. An arm measured by a stub has none, and a mean
  // taken over a mixed list would divide by cases it never priced.
  const metered = runs.flatMap((run) => (run.tokens === undefined ? [] : [run.tokens]));
  // An unattributed call is a cost with no owner: it inflates the total and belongs to no row of
  // the table the total is read against. The run fails rather than publishing a share whose
  // denominator holds calls nobody can name — the same rule as an instrument that may not price
  // a prompt nobody sends, applied to the unit the cost claim is made in.
  const unattributed = metered.reduce((total, cost) => total + (cost.byPurpose?.unlabelled?.calls ?? 0), 0);
  if (unattributed > 0) {
    throw new Error(`${String(unattributed)} calls on arm ${label} do not say what they were for, so their tokens cannot be attributed`);
  }
  // Per case, per kind of call. Averaged the same way the total is, so the parts add up to the
  // whole a reader checks them against.
  const purposeSums = new Map<string, { calls: number; prompt: number; completion: number; chars: number }>();
  for (const cost of metered) {
    for (const [purpose, usage] of Object.entries(cost.byPurpose ?? {})) {
      const slot = (purposeSums.get(purpose) ?? { calls: 0, prompt: 0, completion: 0, chars: 0 });
      slot.calls += usage.calls;
      slot.prompt += usage.prompt;
      slot.completion += usage.completion;
      slot.chars += usage.chars;
      purposeSums.set(purpose, slot);
    }
  }
  const byPurpose =
    purposeSums.size === 0
      ? undefined
      : Object.fromEntries(
          [...purposeSums.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([purpose, sums]) => [
              purpose,
              {
                calls: Number((sums.calls / metered.length).toFixed(3)),
                prompt: Math.round(sums.prompt / metered.length),
                completion: Math.round(sums.completion / metered.length),
                chars: Math.round(sums.chars / metered.length),
              },
            ]),
        );
  const promptSizes = cases.map(
    (question) =>
      buildSqlPrompt(
        question.question,
        // The card that was sent, not the card the arm would build now: on a column-choosing
        // arm those differ, and the prompt-size column exists to say what the model read.
        prepared.cardOf(arm, question).schema,
        promptFor(arm, question, prepared.blocksFor(arm, question)),
      ).length,
  );
  // A repair arm is priced by its funnel, not only by its accuracy: an arm that
  // fixes 30 cases and breaks 25 has the same accuracy as one that does nothing.
  const repair =
    arm.repairs > 0
      ? repairFunnel(
          runs.map((run) => ({ attempts: run.attempts, passed: run.passed, failures: run.failures, errorKind: run.errorKind })),
        )
      : undefined;
  const kindOf = (run: CaseRun): string | undefined => run.errorKind ?? (run.error === undefined ? undefined : 'other');
  const errors = {
    execution: runs.filter((run) => kindOf(run) === 'execution').length,
    guard: runs.filter((run) => kindOf(run) === 'guard').length,
    llm: runs.filter((run) => kindOf(run) === 'llm').length,
    shape: runs.filter((run) => kindOf(run) === 'shape').length,
    harness: runs.filter((run) => kindOf(run) === 'harness').length,
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
  const firstFailure = runs.find((run) => run.error !== undefined);
  return {
    arm: label,
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
    // What the request cost in the endpoint's own unit, beside the characters the prompt
    // measurement counts. The two are not interchangeable: characters are a property of the text
    // and this is a property of the tokenizer, and the ratio between them is the only calibration
    // the zero-call instruments can get. Absent, rather than zero, for an artifact written before
    // the meter existed or by a provider that answered without a usage block — those are the two
    // states in which the column means nothing, and both are visible.
    ...(metered.length === 0
      ? {}
      : {
          tokens: {
            prompt: Math.round(metered.reduce((total, cost) => total + cost.prompt, 0) / metered.length),
            completion: Math.round(metered.reduce((total, cost) => total + cost.completion, 0) / metered.length),
            chars: Math.round(metered.reduce((total, cost) => total + cost.chars, 0) / metered.length),
            unbilled: metered.reduce((total, cost) => total + cost.unbilled, 0),
            ...(byPurpose === undefined ? {} : { byPurpose }),
          },
        }),
    ...(repair === undefined ? {} : { repair }),
    // What the decomposition prompt produced, on any arm that asked for one. This was
    // inside the sampling-arm spread and therefore absent from `decompose` itself, which
    // is the arm the numbers exist for.
    ...armDecomposition(runs),
    ...(arm.emptyRetry === undefined ? {} : { emptyRetry: { mode: arm.emptyRetry, ...emptyRetryFunnel(runs) } }),
    // What the model kept of the card, on the one arm that asks it to choose. Beside the
    // accuracy rather than inside the sampling spread, for the reason the decomposition funnel
    // moved out: the instrument belongs to the arm, not to how many candidates it draws.
    ...(arm.columnSelect === true ? { columnSelection: columnChoiceFunnel(runs) } : {}),
    ...(arm.vote === undefined
      ? {}
      : {
          vote: arm.vote,
          agreement:
            runs.reduce((total, run) => total + (run.agreement ?? 0), 0) /
            Math.max(1, runs.filter((run) => run.agreement !== undefined).length),
          selector: arm.select === true ? 'model' : 'majority',
          // Who judges, when it is not the primary model. The gate needs this to insist the
          // artifact names the judge: a judge swap whose result cannot be attributed is a
          // number with no owner.
          ...(arm.judge === undefined ? {} : { judge: arm.judge }),
          // The ceiling, measured: how often the candidate set contained a statement
          // that matched. Accuracy divided by this is what the selector kept, and the
          // difference between the two is the most a better selector could win here.
          ...candidateCeiling(runs),
          // How much of the declared candidate set never arrived. Reported beside the
          // ceiling, because a ceiling taken over a set that lost a third of its
          // candidates is not a measurement of the prompts.
          ...(runs.some((run) => run.candidateFailures !== undefined)
            ? {
                candidateFailures: {
                  ...candidateFailureTotals(runs),
                  attempted: runs.length * arm.vote,
                },
              }
            : {}),
          ...(arm.mixed === undefined ? {} : { sources: winnerSources(runs, arm.mixed) }),
          ...(runs.some((run) => run.candidateSurvival !== undefined)
            ? { candidateSurvival: candidateSurvivalBySource(runs) }
            : {}),
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
    ...(firstFailure === undefined ? {} : { firstError: firstFailure.error?.slice(0, 200) }),
  };
}

/**
 * The difference this project is willing to act on, in share of cases (2pp).
 *
 * Not a statistical convention: it is the size of claim the cross-vendor question was asked
 * with, and the smallest one the product would change a default over. Fixing it here is what
 * makes "how many cases would settle this" a number the harness can compute.
 */
const CLAIM_PP = 0.02;

/**
 * The resolution a paired delta has to be read against.
 *
 * A p-value cannot tell "no effect" from "no measurement". This harness already states its
 * noise floor as a number of percentage points; the smallest difference the same number of
 * cases could detect is the other half of that sentence, and it is a property of the design
 * (discordance rate and case count), not of the outcome. Delta +2.5pp at p=0.375 with a
 * resolution of 5.2pp says the sign is not the finding.
 *
 * `casesForClaim` is the same arithmetic run forwards: at the discordance this pair showed,
 * how many cases would a 2pp claim need? That number is what turns "run the full split next
 * time" from an opinion into a count, and it is computed here rather than in a document so
 * it cannot drift from the data it was derived from.
 */
export function resolutionFields(comparison: PairedComparison): {
  ci: { low: number; high: number };
  discordantShare: number;
  mde: number;
  casesForClaim: number;
} {
  const resolution = pairedResolution(comparison.onlyFirst, comparison.onlySecond, comparison.total);
  const four = (value: number): number => Number(value.toFixed(4));
  return {
    ci: { low: four(resolution.low), high: four(resolution.high) },
    discordantShare: four(resolution.discordantShare),
    mde: four(resolution.mde),
    casesForClaim: casesForEffect(resolution.discordantShare, CLAIM_PP),
  };
}

/**
 * The paired comparisons the run is allowed to make.
 *
 * Every pair here is two arms measured on the same cases, so a delta is a paired outcome
 * and not a difference of two shares. The A/A pair is the control: same arm, same data,
 * same prompt, twice.
 */
export function pairedComparisons(outcomes: ReadonlyMap<string, readonly CaseRun[]>): {
  aa?: Record<string, unknown>;
  comparisons: Record<string, unknown>;
  ablations: Record<string, unknown>;
} {
  // The A/A pair, when one ran: same arm, same data, same prompt — twice.
  const aaPair = [...outcomes.keys()].find((name) => name.endsWith('#2'));
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
            ...resolutionFields(comparison),
          };
        })();

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
      ...resolutionFields(comparison),
    };
  }

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
      ...resolutionFields(comparison),
      // Undefined for a lever that costs no call (placement, a hint): those are not
      // "infinitely efficient", they are free, and dividing by zero would say the first.
      cost: {
        extraCallsPerCase: Number(extraCalls.toFixed(4)),
        ...(priced === undefined ? {} : { ppPerExtraCall: Number(priced.toFixed(3)) }),
      },
    };
  }
  return { ...(aa === undefined ? {} : { aa }), comparisons, ablations };
}

/** Per-case outcomes, because a per-arm total cannot answer "on which questions did this lever work". */
export function caseRows(outcomes: ReadonlyMap<string, readonly CaseRun[]>): Record<string, unknown>[] {
  // The first question it is needed for: whether the mixed arm wins because its third
  // source is distinct on 35% of cases, or because a duplicated candidate is a frequency
  // signal on the other 65%. That is a stratum, and a stratum needs rows.
  return [...outcomes.entries()].flatMap(([name, runs]) =>
    runs.map((run) => ({
      arm: name,
      id: run.id,
      passed: run.passed,
      reason: run.reason,
      calls: run.calls,
      // The provider's own count for this case, when there is one. Per case rather than per arm
      // because the cost of a lever has to be paired with its outcome: an arm that spends more on
      // the questions it gets right is a different finding from one that spends more everywhere.
      ...(run.tokens === undefined ? {} : { tokens: run.tokens }),
      // The ceiling per case, not only per arm: whether a candidate set contained a
      // correct statement is a paired outcome between two arms on the same question, and
      // a paired outcome can be tested. A share cannot.
      ...(run.candidateRecall === undefined ? {} : { candidateRecall: run.candidateRecall }),
      // The candidate set and the member it took. `candidateRecall` alone makes every
      // selection loss anonymous: on the cross-vendor run 75 cases held the answer and
      // returned something else, and the file could not say whether the selector refused
      // the second model's statement or took a different wrong one beside it.
      ...(run.candidates === undefined ? {} : { candidates: run.candidates }),
      ...(run.candidateSurvival === undefined ? {} : { candidateSurvival: run.candidateSurvival }),
      ...(run.winnerSource === undefined ? {} : { winnerSource: run.winnerSource }),
      // Why this case has no candidate, when it has none.
      //
      // `select-mixed` cost 3 calls on two of 120 questions while `select-cross` cost 4,
      // and the artifact could not say why: `reason: 'values'` with `candidateRecall:
      // false` is exactly what a zero-candidate case looks like, and also what a
      // surviving-candidates-but-wrong case looks like. The difference — three statements
      // the engine refused versus three that ran and were wrong — is the whole question,
      // and it was one field away.
      ...(run.errorKind === undefined ? {} : { errorKind: run.errorKind }),
      ...(run.error === undefined ? {} : { error: run.error.slice(0, 160) }),
    })),
  );
}

/** The failure corpus, and a record of what was left out of it. */
export function failureSection(
  prepared: PreparedRun,
  outcomes: ReadonlyMap<string, readonly CaseRun[]>,
): { failures: unknown; failureSample: unknown } {
  // The cap used to be 25 per arm, which made the only material a failure can be
  // diagnosed from a 1.4% sample — and it said nothing about being a sample, so 25 read
  // as the set.
  const corpus = failureCorpus([...outcomes.entries()], FAILURE_SAMPLE, (id) =>
    prepared.cases.find((question) => String(question.question_id) === id)?.question,
  );
  return { failures: corpus.failures, failureSample: corpus.failureSample };
}

/**
 * The artifact, written once and only after the reporters have agreed with the arms.
 *
 * Before the file is written: an instrument that ran and did not reach the artifact is
 * indistinguishable, downstream, from a mechanism that never ran.
 */
export function writeArtifact(
  settings: BirdSettings,
  report: Record<string, unknown>,
  log: (line: string) => void = console.log,
): void {
  mkdirSync(join(settings.layout.root, 'eval/out'), { recursive: true });
  writeFileSync(settings.layout.out, `${JSON.stringify(report, null, 2)}\n`);
  log(`artifact: ${settings.layout.out}`);
  if (settings.dryRun) {
    const controls = report.controls as Controls;
    log(
      `dry run: gold runnable ${String((report.gold as { runnable: number }).runnable)}/${String((report.gold as { executed: number }).executed)}; ` +
        `self-consistency ${(controls.selfConsistency * 100).toFixed(1)}%; negative false matches ${String(controls.negativeFalseMatches)}; ` +
        `schema columns checked ${String(controls.schemaChecked)}, missing ${String(controls.schemaMissingTotal)}`,
    );
  }
}

/**
 * Thresholds, not decoration: a run that trips one of these must fail CI.
 *
 * Returns the problems instead of setting an exit code, so the list is a value a test can
 * read. The version that called `process.exitCode = 1` could only be observed by running
 * the whole harness against a real dataset.
 */
export function evaluateGate(report: Record<string, unknown>): string[] {
  const goldRate = (report.gold as { runnableRate: number }).runnableRate;
  const controls = report.controls as Controls;
  const arms = report.arms as { arm: string; accuracy: number }[];
  const problems: string[] = [];
  if (goldRate < 0.98) problems.push(`gold runnable rate ${(goldRate * 100).toFixed(1)}% is below 98%`);
  if (controls.selfConsistency < 1) {
    problems.push(`self-consistency ${(controls.selfConsistency * 100).toFixed(1)}% is not 100%`);
  }
  if (controls.negativeFalseMatches !== 0) {
    problems.push(`${controls.negativeFalseMatches} negative control(s) matched a gold result`);
  }
  if (controls.schemaMissingTotal !== 0) {
    problems.push(`${controls.schemaMissingTotal} of ${controls.schemaChecked} advertised columns do not exist in the database`);
  }
  if (controls.truncatedPrompts.length > 0) {
    problems.push(
      `schema card truncated for ${controls.truncatedPrompts.map((entry) => `${entry.db} (${entry.shown}/${entry.total})`).join(', ')}`,
    );
  }
  const best = arms.reduce((top, arm) => Math.max(top, arm.accuracy), 0);
  if (best < 0.05) problems.push(`best arm accuracy ${(best * 100).toFixed(1)}% is not above 5%: the harness sees no signal`);
  const first = arms[0];
  const last = arms[arms.length - 1];
  if (first !== undefined && last !== undefined && last.accuracy < first.accuracy - 0.05) {
    // A judge swap is the one comparison where trailing is the measurement rather than a
    // defect: the arm exists to price the judge, so its delta is the answer to the question
    // the run asked. The gate refused to publish `select-cross-judge` at 54.7% against 60.7%
    // (run 40828283888) — a 6.0pp drop with p = 2.7e-13 — and that refusal is what the arm
    // was built to produce: the second model judges its own candidate back into the answer
    // on 68% of the cases where it was the only right one, and agrees with two correct
    // candidates only when it is not the judge. An outage is caught elsewhere (the failure
    // share, the candidate survival, an arm that produced no results), so the exemption
    // cannot hide a broken endpoint.
    const swapped = resolveArm(first.arm)?.judge !== resolveArm(last.arm)?.judge;
    if (!swapped) problems.push(`${last.arm} trails ${first.arm} by more than 5pp, which is a regression not a result`);
  }
  return problems;
}

/**
 * The second model is required by two arms and by nothing else.
 *
 * Naming the missing variable matters: "the arm needs a second model" sent me looking at
 * the workflow's model input the first time, when the key was what was absent. So does
 * naming the reason: a judged arm generates three candidates and would still do so with
 * no second model — it would just quietly judge with the first one.
 */
export function secondModelRoles(arms: readonly string[]): { draws: boolean; judges: boolean } {
  return {
    draws: arms.some((name) => (resolveArm(name)?.mixed ?? []).some((source) => parseMixedSource(source).provider === 'second')),
    judges: arms.some((name) => resolveArm(name)?.judge === 'second'),
  };
}

export function assertSecondModel(settings: BirdSettings, roles: { draws: boolean; judges: boolean }): void {
  if (!roles.draws && !roles.judges) return;
  if (settings.second.model !== '' && settings.second.apiKey !== '') return;
  const missing = [
    settings.second.model === '' ? 'BIRD_SECOND_MODEL' : '',
    settings.second.apiKey === '' ? 'a second key (BIRD_SECOND_API_KEY or ZHIPU_API_KEY)' : '',
  ]
    .filter(Boolean)
    .join(' and ');
  const consequence = roles.draws
    ? 'the arm would generate two candidates where it promised three'
    : 'the arm would be judged by the primary model while claiming a swap';
  const cause = roles.draws ? 'draws a candidate from the second model' : 'asks the second model to judge';
  throw new Error(`this arm set ${cause}, but ${missing} is not set; ${consequence}`);
}

/** The provider pair a run needs, built from settings. `second` is absent unless configured. */
export function createProviders(settings: BirdSettings): {
  provider: LlmProvider;
  second?: LlmProvider;
} {
  const provider = createHttpProvider({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    retries: settings.retries,
    retryDelayMs: settings.retryDelayMs,
    timeoutMs: settings.timeoutMs,
  });
  if (settings.second.model === '') return { provider };
  const second = createHttpProvider({
    baseUrl: settings.second.baseUrl === '' ? settings.baseUrl : settings.second.baseUrl,
    apiKey: settings.second.apiKey,
    model: settings.second.model,
    retries: settings.retries,
    retryDelayMs: settings.retryDelayMs,
    timeoutMs: settings.timeoutMs,
  });
  return { provider, second };
}

export interface BirdRunOptions {
  readonly log?: (line: string) => void;
}

/**
 * A whole run, from a settings object to an artifact on disk.
 *
 * No `process.exit`, no module-level environment, and no work behind an early return that
 * a caller cannot observe: the report is returned and the artifact is written before the
 * function resolves, which is what makes "the instrument ran" a fact a test can assert.
 */
export async function runBird(settings: BirdSettings, options: BirdRunOptions = {}): Promise<Record<string, unknown>> {
  const log = options.log ?? ((line: string) => console.log(line));
  const { provider, second } = createProviders(settings);
  assertSecondModel(settings, secondModelRoles(settings.arms));
  const oracle = createOracle(settings.layout.oracleScript, settings.layout.databaseRoot);
  try {
    const prepared = await prepareRun(settings, { oracle, provider });
    // Above the rates, not below them: what the denominator is, stated before anything is
    // measured with it. A reader who stops after the first arm line still knows the pool.
    log(describeQuestionSet(prepared.shape, settings.layout.split));
    const report = baseReport(prepared);
    if (settings.dryRun) {
      previewPrompts(prepared, report);
      writeArtifact(settings, report, log);
      return report;
    }
    const outcomes = new Map<string, readonly CaseRun[]>();
    const armReports: ArmReportRow[] = [];
    for (const name of settings.arms) {
      const armRun = await runArm(prepared, name, { oracle, provider, ...(second === undefined ? {} : { second }) });
      // Keyed by the requested name, not the resolved one: an A/A duplicate resolves to
      // the same Arm, and keying by that overwrote the first run with the second, which
      // silently made the pair compare an arm with itself and report `aa: undefined`.
      outcomes.set(name, armRun.runs);
      armReports.push(armRun.row);
      log(armRun.line);
    }
    // Every arm must keep its own row: two rows with the same label would let a
    // duplicate stand in for the arm it duplicates.
    assertUniqueArmLabels(armReports.map((entry) => entry.arm));
    const paired = pairedComparisons(outcomes);
    if (paired.aa !== undefined) {
      const aa = paired.aa as {
        arm: string;
        delta: number;
        onlyFirst: number;
        onlySecond: number;
        p: number;
        mde: number;
        ci: { low: number; high: number };
      };
      report.aa = paired.aa;
      // The noise floor is not a single number: a 0pp A/A on 120 cases still leaves a
      // 5pp difference unexcluded, and the delta of every other arm is read against that.
      log(
        `A/A ${aa.arm}: ${(aa.delta * 100).toFixed(1)}pp (${String(aa.onlyFirst)}/${String(aa.onlySecond)}, p=${aa.p.toFixed(3)}, ` +
          `95% CI [${(aa.ci.low * 100).toFixed(1)}, ${(aa.ci.high * 100).toFixed(1)}]pp, resolves ${(aa.mde * 100).toFixed(1)}pp) — the harness's own noise`,
      );
    }
    report.comparisons = paired.comparisons;
    report.ablations = paired.ablations;
    report.arms = armReports;
    report.cases = caseRows(outcomes);
    const { failures, failureSample } = failureSection(prepared, outcomes);
    report.failures = failures;
    report.failureSample = failureSample;
    assertReportComplete({ arms: armReports });
    writeArtifact(settings, report, log);
    return report;
  } finally {
    await oracle.close();
  }
}

/**
 * The CLI: read the environment once, run, gate, and return an exit code.
 *
 * Nothing else lives here. The oracle's lifetime, the artifact and the gate's verdict are
 * all in `runBird`/`evaluateGate`, so a test drives the same code the workflow does.
 */
export async function main(
  env: Readonly<Record<string, string | undefined>> = process.env,
  argv: readonly string[] = process.argv.slice(2),
  root: string = resolve(new URL('../..', import.meta.url).pathname),
): Promise<number> {
  const settings = resolveSettings(env, argv, root);
  const report = await runBird(settings);
  if (settings.dryRun) return 0;
  const problems = evaluateGate(report);
  if (problems.length === 0) {
    console.log('gates: gold runnable, controls, signal and no regression all hold');
    return 0;
  }
  for (const problem of problems) console.error(`GATE FAILED: ${problem}`);
  return 1;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
