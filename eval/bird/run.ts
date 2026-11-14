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
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHttpProvider } from '@agentix-e/nl2charts-ai';
import type { LlmProvider, PromptOptions, SchemaTable } from '@agentix-e/nl2charts-ai';
import { applySelection, attachDefinitions, buildAskMessages, buildReconcilePrompt, buildSelectionPrompt, chooseCandidateByRule, chooseCandidatePairwise, buildSqlPrompt, choosePromptProfile, createPipeline, emptyRetryMessages, extractSql, formatProfile, renderDefinitions, renderEvidence, renderSchemaCard, resultGroups, withCallCounter } from '@agentix-e/nl2charts-ai';
import { capabilitiesOf } from '@agentix-e/nl2charts-ai';
import type { FormatProfile, ModelCapabilities, PurposeUsage, ReplyShape, SelectionRule, ValueGap } from '@agentix-e/nl2charts-ai';
// The retry turn writes a statement outside the pipeline, so it goes through the same
// guard the pipeline applies. Skipping it here would let the one arm that retries be the
// one arm that can execute DDL.
import { inspectSql } from '@agentix-e/nl2charts-core';
import { casesForEffect, compareArms, judgeOfficial, judgeStrict, majorityResult, mcnemarExact, pairedResolution, resultKey, summarise, wilsonInterval } from '@agentix-e/nl2charts-devkit';
import type { PairedComparison } from '@agentix-e/nl2charts-devkit';
import { graphForDatabase } from './join-graph.js';
import { INTENT_RULE, intentFunnel, readIntentReply } from './intent.js';
import type { IntentRecord } from './intent.js';
import { ppPerExtraCall, repairFunnel } from './metrics.js';
import { SHIPPED_RECALLERS, linkedTables, pruneSchema } from './prune.js';
import { renderRowSamples, sampleableColumns } from './row-samples.js';
import { applyColumnChoice, buildColumnPrompt, parseColumnChoice } from './columns.js';
import type { ColumnApplication } from './columns.js';
import { applyDenseChoice } from './dense.js';
import type { CaseOutcome, MatchReason } from '@agentix-e/nl2charts-devkit';
import { buildSchema, datasetName, describeQuestionSet, distinctQuestions, loadDescriptions, loadQuestions, loadTables, stratifiedSample } from './data.js';
import type { BirdQuestion, QuestionSet } from './data.js';
import { createOracle } from './oracle.js';
import { createDomainReader } from './literal-repair.js';
import { referencedFields, tableRefs } from './statement.js';
import { probeValueGaps } from './value-probe.js';
import type { ProbeColumn } from './value-probe.js';
import { canonicalSql } from './canonical.js';
import { shapeFailure, shapeMismatch } from './shape.js';
import { FAILURE_SAMPLE, failureCorpus } from './failures.js';
import { fingerprintLine, probeBase } from './fingerprint.js';
import type { BaseFingerprint } from './fingerprint.js';
import type { Oracle, OracleResult } from './oracle.js';
import { profileDatabase } from './profile.js';
import { BIRD_SCHEMA_LINES } from './prompt-shape.js';
import { attachSamples, narrowSamples, sampleValuesOf } from './samples.js';
import { blockColumns } from './block-columns.js';
import type { BlockRule } from './block-columns.js';
import { exampleMapOf, exampleSetFor } from './value-examples.js';
import { buildIndex, renderDemonstrationBlocks, renderRetrieved, retrieve } from './retrieval.js';
import { renderSqlLike } from '../../packages/ai/src/sql-like.js';
import { MASKED_PREAMBLE, maskStatement } from './mask.js';
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
  /**
   * Let the linker read the arm's evidence text as well as the question.
   *
   * One lever, because the two ways of building the hint differ in exactly one thing: which text
   * the linker is given. An arm that also changed `topK` would move the slot count and the input
   * together, and the delta would belong to neither.
   */
  readonly linkEvidence?: boolean;
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
   * The temperature a sampled candidate is drawn at.
   *
   * Sampling is what makes several candidates different *attempts* rather than one attempt typed
   * out several times, and 0.7 was written into the request builder as a constant — the value
   * every sampling arm here used, and the competitor's too. A constant made the question
   * unaskable: an arm could change how many draws it bought but never how far apart they landed,
   * so "the candidates are correlated" had a name and no experiment.
   *
   * The reading that made it a field: on Mini-Dev the six-draw arm returned **1.33 distinct
   * executed results per question** against the three-draw arm's **1.26**, and on **462 of 493
   * questions the second pass added no new answer at all** — the third and fourth calls bought a
   * restatement. Three different prompts at 0.7 are one opinion counted three times (74.85% of
   * questions unanimous, and 29.8% of those unanimous answers wrong). Whether that is the
   * endpoint's sampling or the prompts' shared information is exactly what a temperature arm
   * answers, at the same number of calls rather than three more.
   */
  readonly temperature?: number;
  /**
   * Retrieved (question, evidence, SQL) triples from the training split, rendered as
   * worked examples. This is the lever DAIL-SQL and CHASE-SQL build on; here it is one
   * switch away from `inline+retrieval`, which supplies the same neighbours as text.
   */
  readonly demonstrations?: boolean;
  /**
   * Mask the schema-specific names in the worked examples and canonicalise their dialect.
   *
   * `I-83` read the stacked examples as two-sided: `column-count` fell 136 → 106, the largest
   * single-class move any prompt lever here has produced, and fifteen execution errors appeared
   * naming either a column of the source schema or a function SQLite does not have. This is
   * DAIL-SQL's masked variant, which keeps the construction and drops both.
   *
   * Requires `demonstrations`: the mask only acts through the examples, and an arm that declares it
   * without them would be its parent with a name that claims otherwise. `assertMaskingRule` refuses
   * that at the declaration.
   */
  readonly masked?: boolean;
  /**
   * Who chooses among the samples: the modal executed result (default) or the model
   * reading the candidates. Same samples, same count — one lever.
   */
  readonly select?: boolean;
  /**
   * Choose among the candidates with a rule that costs no call, instead of with the model.
   *
   * Requires `select`: the arm still draws a candidate set, and this says who picks from it.
   * `first` returns the candidate the prompt offered first, `shortest` the fewest characters of
   * SQL, `modal` the result set most candidates agree on — all three ranking only candidates
   * that returned rows (`eligibleIndices`), which is the one member of a set that can be ruled
   * out without reading it.
   *
   * This exists because the reading said the fourth call loses: on 1,532 dev questions
   * `shortest` scored 63.64% against the model selector's 62.79% on the same candidates, and on
   * the strong pool 63.71% against 61.42% (+2.29pp, p = 0.0030, 38 wins 19 losses) at 3.00 calls
   * against 4.00. The arm exists to make that reading a *measurement* rather than a derivation:
   * the same candidates, the same prompts, the same judge, one call less — and, because the
   * artifact still records every candidate, a third instrument that must agree with both.
   */
  readonly selectRule?: SelectionRule;
  /**
   * Spend the adjudication only on the questions that have something to adjudicate.
   *
   * `'results'` reads the pool before the selector does: the executed candidates are grouped by
   * the judge's own equality, and when they all returned the same rows there is nothing to decide
   * — every member of the pool is scored by the same result, so any member is worth exactly what
   * any other is worth. The arm then chooses by `gateRule` and spends no call. When the pool
   * disagrees it calls the selector exactly as its parent does, on the same candidates and the
   * same prompt, so the delta between a gated arm and its parent is cost and nothing else.
   *
   * The reading that puts this here is the shape of the pool on Mini-Dev at temperature 0.7: 350
   * of 479 three-candidate questions (73.1%) returned one result, and on those cases the model
   * selector, the `shortest` rule and the `modal` rule all score **70.57%** — the same number to
   * the case. The fourth call is not wrong there, it is unspendable. On the 129 that disagree the
   * three choosers separate (44.2% / 35.7% / 26.4%), which is where a call can buy something.
   */
  readonly gate?: 'results';
  /** Who picks when the gate did not spend. Defaults to `shortest`, the rule this pool prefers. */
  readonly gateRule?: SelectionRule;
  /**
   * Show the judge the columns of the tables its candidates read.
   *
   * `'columns'` renders the schema of exactly the tables the candidate statements name, so the
   * judge can rule out a name that does not exist and can see the column a question describes
   * living somewhere other than where a candidate looked. The selector prompt has never carried
   * the schema; the generator's always has.
   */
  readonly selectorEvidence?: 'columns';
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
   * Whole rows of the tables the question names, this many per table.
   *
   * Not `samples`, which samples a **column**: a column sample shows the domain of one value, and
   * both samplers this repository ships were closed at a 2.22pp ceiling. A row sample shows which
   * values occur **together**, which is a property no per-column block can carry. It is the one
   * input in RSL-SQL's prompt — "the first three rows of values in the table" — that this
   * repository has never put in front of a model.
   *
   * The number is rows, not a switch, because the cost is linear in it: three rows of the text
   * columns of the tables a gold statement reads is 1,058 characters at the mean and 483 at the
   * median on 1,534 dev questions. `ROW_SAMPLE_BUDGET` caps the tail, which is where the cost is.
   */
  readonly rowSamples?: number;
  /**
   * Which columns carry the block, when `samples` is set.
   *
   * `'gold'` keeps the columns the gold statement filters on and nothing else. It is an oracle, and
   * it exists for one reason: the block's cost is the number of columns that carry a bracket, not
   * the bracket itself. Measured on the 500-question Mini-Dev split — and reproducible there by
   * `bench:bird:card`, which now reads the block from the cache the run writes — the sampler over
   * every profiled column costs **+38.4%** characters a case and the same sampler over the filtered
   * columns costs **+1.4%**, touching 185 of 500 cases. So the family "show stored values where a
   * condition needs one" has to be priced at the price it would actually be built at, and this arm
   * is the ceiling of that family: no realizable column rule can beat a rule that reads the answer.
   *
   * A ceiling is worth running because it closes the question in one direction. If the block buys
   * nothing when it is shown exactly the right columns, then no rule that guesses the columns can
   * buy anything either, and the samples family is finished rather than "underpowered" — which is
   * the reading that kept it alive for three rounds on a 2.22pp ceiling and +1.31pp at p = 0.052.
   * If it does buy something, the delta is the budget a realizable rule has to be judged against.
   *
   * Deliberately not a list of column names: the set is a property of the case, the same way
   * `prune` is a property of the question, and an arm that carried a per-database allow-list would
   * be fitted on the split it is measured on.
   */
  readonly sampleColumns?: BlockRule;
  /**
   * Keep only the fields the gold statement names, and count what that removed.
   *
   * The schema card is the prompt: on Mini-Dev it is 69.7% of the characters sent, and 56.1% of it
   * belongs to tables no gold statement reads. An arm that could drop all of it would be cheaper and,
   * if AskData's ablation transfers, more accurate — their perfect schema linking scores 77.4 against
   * 71.2 for the full schema on the same 500 questions and the same model. This arm is that ceiling
   * for this repository, and it is the first time the linker is priced in accuracy rather than in
   * characters: `card.ts` has only ever said how many characters a perfect linker would save.
   *
   * `'gold'` reads the answer, so the delta is a ceiling and never an adoption. It is deliberately
   * not a column allow-list: the set is a property of the case, and an arm carrying one fitted on the
   * split would price the fit.
   *
   * One field-selection lever per arm. `prune` seeds from the shipped linker and `columnSelect` asks
   * the model, and an arm that combined either with this one would report a delta about which rule
   * ran last.
   */
  readonly cardColumns?: 'gold';
  /**
   * Answer with a query object instead of a statement: which tables, which joins, which filters as
   * triples, which grain, which order. The statement is rendered by `renderIntent`.
   *
   * Every other lever on this page changes what the model *knows* when it writes. This one changes
   * what it is allowed to *write*, which is the only lever that can remove a failure class rather
   * than redistribute one: a join predicate cannot land in the wrong clause, a literal cannot be
   * left unquoted, a function SQLite does not have cannot be invented, and `count(distinct ...)`
   * cannot come back as `count(...)`. What it costs is expressiveness — the grammar is closed, and
   * anything outside it is a refusal with a name (`eval/bird/intent.ts`).
   *
   * It is a candidate source and not a generator: alone it would answer a different question from
   * the arm it is one lever away from, so `assertIntentRule` refuses a run that dispatches it as
   * anything but a source of a mixed arm. Its value is measured where a fourth candidate is
   * measured — the ceiling of the pool it joins — and its refusals are a histogram, because the
   * set of constructs the corpus asks for is not a thing that can be read off SQL.
   */
  readonly intent?: 'query';
  /**
   * Ask for a query plan (scan, filter, join, group, answer) before the statement.
   * CHASE-SQL's second generator; one lever from `inline+evidence`.
   */
  readonly plan?: boolean;
  /**
   * Who writes that plan, when the arm has one: the primary model (the default) or the second.
   *
   * `8u` is the only repair the paired reading of the model comparison leaves. The stronger
   * model is not worse at reading the question — it is worse at *projecting* it: `values` falls
   * 462 -> 432 while `column-count` rises 131 -> 204, and the widened statements are
   * disproportionately ones the weaker model already answered correctly (49 of 53). A projection
   * rule cannot reach that decision, because the decision is made inside a reasoning trace the
   * prompt never sees, and the rule's own judgement (`8s`) was a redistribution: 64 gains, 66
   * losses, p = 0.93.
   *
   * So the two halves are split instead of instructed: the reasoning model writes the plan —
   * where its better reading of conditions and joins is worth something — and the chat model
   * writes the statement from that plan, in a context that contains no trace at all. The claim
   * is falsifiable in one direction only: the arm has to beat **both** of its parents. Beat the
   * chat arm (939) and the reasoning arm keeps nothing; fail to beat it and one extra call buys
   * a worse answer than the free one.
   */
  readonly planBy?: 'second';
  /**
   * Add the projection rule to the prompt: one rule line, no extra call, no card change.
   *
   * The lever comes from a reading rather than from an idea. Holding everything else fixed and
   * changing only the model moved 127 cases down and 70 up (`8q`), and the shape of that
   * movement was not a general loss of reasoning: `values` fell 461 → 444 while `column-count`
   * rose 130 → 204. Of the 127 negative cases, 59 are filed under `column-count` — the statement
   * ran, returned the right number of rows, and carried the wrong number of columns — so all 59
   * repaired would put the reasoning model back at 61.55% against the plain one's 61.42%.
   *
   * `bench:bird:width` already priced the ceiling of a rule like this one by deleting the extra
   * items from the select list and re-executing: it is an oracle's ceiling, so no implementable
   * rule can beat it, which is what makes it able to decide the experiment before the dispatch
   * rather than after it. The rule itself has to be written in the prompt's voice and apply to
   * every question, so it says *which* columns rather than *fewer* columns — the width bucket is
   * two-sided, and a rule that only shortened answers would trade `column-count` for the `narrow`
   * half of the same bucket.
   */
  readonly projection?: 'asked';
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
   * Render each neighbour with the steps its statement encodes.
   *
   * The parent is `inline+icl`, which sends (question, evidence, SQL). This sends the same
   * neighbours with a labelled block between the evidence and the statement, which is
   * OpenSearch-SQL's self-taught CoT few-shot shape — one of the two components that system
   * credits for 69.3% on BIRD without training. One lever: the neighbours, the ranking and the
   * count are the parent's, and the only difference is what each block says about its statement.
   */
  readonly cotDemonstrations?: boolean;
  /**
   * Ask the model to write the labelled step block before its statement.
   *
   * The parent is `inline+evidence`. Different from `decompose`, which asks for free step
   * sentences and measured at a loss: these are eight named lines, and a demonstration written by
   * `cotDemonstrations` carries the same eight labels, so an arm that turns both on is testing
   * one format in two positions rather than two formats.
   */
  readonly reasoning?: 'sql-like';
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
   * Reuse the candidate pool another arm generated, instead of generating one.
   *
   * The reason this exists is a measurement defect, not a cost optimisation. Every arm draws
   * its own three candidates, so two arms that differ in one lever also differ in their pool —
   * and the pool's own run-to-run displacement, measured on `select-cross` twice, is ±1.3 to
   * 3.3pp at 600 questions. Two levers in this round read +2.17pp (p=0.035) and +2.50pp
   * (p=0.017) against a parent whose pool they did not share, while the *slot* the second one
   * targets moved +0.43pp and the same slot moved +1.60pp on an arm that changed no generation
   * at all. An effect and a noise floor of the same size is not a reading.
   *
   * On a shared pool the two arms read the same candidates, the same rows and the same
   * previews, and the only thing that differs is what the arm does with them: a judge swap
   * costs one call per case and generates nothing, so its delta has no generation noise in it
   * at all. The arm named here must run earlier in the same run, which the pool lookup enforces
   * by failing rather than generating.
   */
  readonly pool?: string;
  /**
   * Buy one more opinion, but only where the pool already agrees with itself.
   *
   * `bench:bird:diversity` priced the candidate set this repository has been reading for six
   * rounds: three quarters of its cases are unanimous, and two thirds of its ceiling losses are
   * losses the candidates *agreed* on. A selector cannot reach a loss the set agreed on — there
   * is nothing to select — so the only lever left on that side of the equation is a candidate
   * nobody wrote, bought exactly on the cases where the three agree.
   *
   * The condition is the lever. An unconditional fourth candidate is a fourth draw from the same
   * three opinions, which the diversity reading says carries almost nothing; a conditional one
   * costs 0.745 calls a case at the 74.5% unanimity this pool actually has, and its price is the
   * number the arm has to publish. The source named here must not already be in the arm's
   * candidate set — a fourth opinion that is one of the three is a fourth vote for it, not an
   * opinion — and `assertDissentRule` refuses that at the declaration.
   *
   * The arm's *answer* policy is deliberate and is written in `applyDissent`: the vote keeps the
   * pool's decision, and the dissent is recorded with its verdict so that every adoption rule can
   * be priced offline from one artifact. An arm that adopted the dissent on arrival would publish
   * one number and hide the fact that its value depends entirely on which rule you choose.
   */
  readonly dissent?: string;
  /**
   * Put the bought opinion to the selector, instead of putting it in front of the selector.
   *
   * `41551887197` priced the first form and returned a clean negative with a clean mechanism: the
   * conditional call raised the ceiling by 27 cases and fell none, and the four-candidate prompt
   * converted **none** of them — the selector adopted the bought statement 21 times and was right
   * 5 times, while that statement alone was right 27 times. Conversion fell from 92.08% to 89.62%,
   * and the oracle over the same four candidates was 68.54%: **the information was in the set and
   * the question could not reach it.**
   *
   * So this flag keeps the parent's prompt exactly — three candidates, one selection call, byte for
   * byte — and spends one more call **only** when the bought statement disagrees, on a comparison
   * between the pool's answer and it. That is the shape this repository has already priced as its
   * best selector (`select-pair`), applied to the one pair that matters, at 6.5% of the cases the
   * conditional call fires on.
   */
  readonly dissentVerify?: 'pairwise';
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
   * How the judge's reply is asked for and read.
   *
   * `strict` is the instruction every published selector reading was taken with: one number and
   * nothing else. `capability` asks the judge's provider what it is, and a reasoning judge is
   * asked to think and to end on the number instead — the model either ignores "nothing else"
   * (and its prose used to be counted as an undecided vote) or obeys it and gives up the
   * deliberation it was chosen for.
   *
   * The default is `strict`, not `capability`, so that an arm name keeps the reading it was
   * published with. The pair `select-cross-judge` / `select-cross-judge-reasoning` separates the
   * model change from the format change, which is the only way either delta is attributable.
   */
  readonly judgeFormat?: 'strict' | 'capability';
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
   *
   * `values` is the same call carrying evidence instead of advice: the literals the statement
   * compared against are looked up in their columns first (no model call), a literal that only
   * differs by case is grounded deterministically and adopted if it returns rows (still no
   * model call), and anything else is quoted back to the model as the values the column does
   * hold. The diagnosis `values-gap` names `literal-missing`/`literal-case` is 18 of the 19
   * dev questions whose whole candidate set returned nothing, so this is the one lever here
   * whose trigger is cheaper than its action.
   */
  readonly emptyRetry?: 'diagnosed' | 'blind' | 'values';
  /**
   * Tell the selector which candidates returned identical rows.
   *
   * The selector is shown each candidate's statement, row count, column count and the first
   * three rows. It is not shown that candidate 1 and candidate 2 returned *exactly* the same
   * thing, because equality is the judge's and the previews are truncated: three hundred
   * characters of a wide table cannot establish that two result sets are the same set. So the
   * one fact a 2+1 pool is built on is the one fact the selector has to guess.
   *
   * One lever from its parent: same candidates, same count, same four calls, and the marks cost
   * no tokens beyond a line per agreeing candidate. What it prices is whether the selector can
   * use "these two agree" as evidence — 20 of the 22 questions `select-cross`'s reasoner slot
   * added to the ceiling had the correct answer in the dissenting slot, which is a hole a
   * three-way vote cannot see and a selector might be able to.
   */
  readonly agreement?: boolean;
  /**
   * Ask the adjudication call for a statement instead of an index, one lever from `select-cross-pooled`.
   *
   * The two readings that point here are the reason this field exists rather than another prompt
   * tweak. On the 2+1 pool the paid selector is level with the free modal result (+0.17pp then
   * −0.17pp, both inside the ±0.67pp jitter the A/A pair measured), and the only lever that has
   * paid twice is the one that told the model *which candidates agree* (+1.17pp, +0.33pp). An
   * index cannot express an answer none of the candidates contains, which is the shape of every
   * case the ceiling holds and the decision loses: the pool contains a correct statement and the
   * selector returns a wrong one.
   *
   * `'groups'` is the only mode, and it is named rather than boolean because the input format is
   * the experiment: the prompt hands over the *result groups* (the partition the agreement marks
   * already define) and asks for the statement to run. A reply that echoes a group's statement is
   * a selector with a longer prompt, and the funnel counts exactly that (`novel`).
   */
  readonly reconcile?: 'groups';
  /**
   * What a reconcile arm does with a reply that restates a candidate.
   *
   * `'always'` — the default, and what `select-cross-pooled-reconcile` measured — adopts every
   * statement the engine runs, including the 514 of 600 replies that were a candidate rewritten in
   * other words. That arm scored 359 of 600 against the free vote's 380 (`41453395203`), and the
   * arithmetic of the loss points at the rewrites rather than at the corrections: a case whose
   * answer was already in hand was overwritten by a paraphrase of it.
   *
   * `'novel'` therefore hands the restatements back to the vote and adopts only statements nobody
   * wrote. It is the same prompt and the same call — the difference is what the arm does with a
   * reply that adds nothing — and it isolates `novel` cases as the only ones the lever can move.
   */
  readonly reconcileAdopt?: 'always' | 'novel';
  /**
   * Ask the model what its own statement left out, one call, then keep what it writes.
   *
   * The population is the one nothing else can see: statements that run, return rows and are
   * wrong because a column the question filters on never appears in them (16.1-18.8pp on
   * Mini-Dev, `bench:bird:conditions`). No result-based trigger fires on those, so the only
   * truthful trigger is the question itself.
   */
  readonly audit?: 'conditions';
  /**
   * Ground each literal in the column's own spelling, before the engine sees the statement.
   *
   * The one rewrite in this repository that needs no model judgement: `where status = 'banned'`
   * against a column storing `Banned` is a statement that returns nothing, and the column can say
   * so. It is a lever on the arm because it costs a query and changes the statement that runs;
   * `bench:bird:rewrite` priced the same edit offline at +14 wins and 0 losses on dev, and this arm
   * is that derivation under test.
   */
  readonly ground?: boolean;
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
   *
   * `'dense'` is the same call and the same prompt with the competitor's *application* rule
   * instead of ours (`dense.ts`): a table the model named nothing in keeps its first six columns
   * rather than disappearing, so the two arms differ in what is done with the reply and in
   * nothing else. The pair is the single-lever test of I-50d — `columns` is the column-level cut
   * that measured −5.65pp, `dense` is the table-level granularity their selector actually uses,
   * and the delta between them is the price of dropping tables rather than the price of asking
   * the model at all.
   */
  readonly columnSelect?: 'columns' | 'dense';
  /**
   * Per-source overrides for the schema hint the prompt carries.
   *
   * The hint (`Likely columns: ...`) is computed by our linker and is useful to a model that
   * cannot afford to read the whole card. For a reasoning model it is a pre-computed answer
   * placed in front of the work: the model was chosen to decide which columns matter, and the
   * one decision it would have made for itself has already been made for it. This map removes
   * the hint from a named source and leaves every other source byte-identical, so the delta
   * belongs to the hint and not to a shorter prompt.
   */
  readonly sourceLinking?: Readonly<Record<string, boolean>>;
  /**
   * Per-source overrides for the repair turns a candidate may spend.
   *
   * On a mixed arm this is the *only* place a repair count can be set: `runArm` resolves each
   * source to its own `Arm` and builds the pipeline from that arm's `repairs`, so the mixed arm's
   * own field never reaches the generator. That is a trap worth naming rather than fixing — the
   * field is read where it is honoured, and a mixed arm's `repairs` is decoration.
   *
   * Why a repair count is a lever at all: a repair turn fires only when the guard rejects the
   * statement or the engine refuses it, so it costs nothing on a case that already ran. ExCoT-DPO
   * (ACL 2025) reports the largest single-model gain on BIRD from exactly this loop — execution
   * feedback, 57.37% to 68.51% — and the loop is where a reasoning model's advantage should
   * appear, because reading an engine's error message and writing a corrected statement is
   * inference rather than recall. Keyed by source so the two models can be given different
   * amounts of it and the difference belongs to the model rather than to the arm.
   */
  readonly sourceRepairs?: Readonly<Record<string, number>>;
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
 * The shipped trio plus the one candidate whose statement is rendered rather than written.
 *
 * `values` was kept in the third slot on the third slot's own verdict (round 44: swapping it for
 * the sampled card bought +0.72pp at p = 0.15 and 32 sole-correct cases where the bar was 36), so
 * the trio is the pool a fourth source has to be read against — not a new trio.
 *
 * The source is `intent`, and its prompt is the trio's first prompt plus one rule, which is why
 * the mixed feasibility guard still sees four distinct prompts: the rule is part of the arm's
 * notes, so `buildSqlPrompt` differs by construction and `distinctShare` measures the difference
 * it would send rather than a difference it hopes for.
 */
export const INTENT_SOURCES: readonly string[] = [...MIXED_SOURCES, 'intent'];

/**
 * The trio plus the one candidate whose prompt shows stored rows instead of stored columns.
 *
 * The pool was read apart without a model call, from the artifact of `43450970534`: of 496 Mini-Dev
 * questions, **168 (33.9%) held no correct candidate at all**, and 156 of those had all three
 * candidates execute, so the miss was not an execution failure. 71.3% of those pools were filed by
 * the judge as `values` — the class where the shape, the row count and the column count are right
 * and the figures are not — and the corpus's own literal analysis says what those figures are:
 * seven sites in ten are a predicate aimed at a column that has never held the value.
 *
 * A column sample cannot answer that, because the question is which values occur *together*.
 * `inline+evidence+rows` is three stored rows per table, which is the only input in the catalogue
 * that can say `status = 'Banned'` belongs with `currency = 'EUR'` rather than with the column the
 * question's words point at. It is therefore the fourth source that differs in **knowledge**,
 * while `intent` differs in **grammar** — and the pair of candidates asks which kind of difference
 * a fourth candidate has to be, at one call each with no new prompt to write.
 */
export const ROWS_SOURCES: readonly string[] = [...MIXED_SOURCES, 'inline+evidence+rows'];

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
 * The trio with its third slot given to the sampled card instead of to the value index.
 *
 * `MIXED_SOURCES`' third candidate is the value index, and its block is empty on 933 of the 1,532
 * dev questions (60.9%) — the question names no literal, so the third vote is a restatement of one
 * of the other two. `inline+evidence+samples` costs the same one call, its block lands on 1,347 of
 * 1,532, and it is the largest single-call reading on this split since `notes` (+1.24pp over its
 * parent, 61 up and 42 down, p = 0.0756). The question this arm asks is the one `select-dc` asked
 * about decomposition — which prompt earns the third slot — at four calls either way, so the
 * comparison is a swap and not a purchase.
 */
export const SAMPLED_SOURCES: readonly string[] = ['inline+evidence', 'metadata+evidence', 'inline+evidence+samples'];

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

/**
 * Whether any of these arms reads the BIRD training split.
 *
 * Two levers do: retrieved evidence (`inline+retrieval`) and worked examples (`inline+icl` and the
 * arms that stack them on the hint). The workflow needs the same answer to decide whether it has to
 * fetch 8.5 GB for `train.json`, and a second copy of the rule in YAML would be a second opinion
 * about which arms exist — the failure mode `DEV_ARMS` already has a test for.
 */
export function armsNeedRetrieval(names: readonly string[]): boolean {
  return armsInEffect(names).some((arm) => arm.evidence === 'retrieved' || arm.demonstrations === true);
}

/**
 * Every arm whose prompt this run will send.
 *
 * A mixed arm does not send a prompt of its own: it sends one per source, and those sources are
 * other arms. So "which arms does this run read" is not the arm list — it is the arm list plus
 * every source those arms name — and it is the question the block loaders have to ask, because a
 * block that nothing loaded is not an error anywhere; it is a prompt that silently equals another
 * prompt.
 *
 * `select-samples` is the arm that found this. Its third source is `inline+evidence+samples`, no
 * *arm* in `BIRD_ARMS` declared `samples`, so the profile's value lists were never attached, all
 * three prompts collapsed to two, and `assertMixedFeasible` refused the run on all 1,532 questions
 * with "builds no question with 3 distinct prompts". The guard was right and the loader had asked
 * the narrower question. One function now answers both ends, and `armsNeedRetrieval` reads it too:
 * the workflow decides whether to fetch 8.5 GB of `train.json` from the same set.
 */
export function armsInEffect(names: readonly string[]): Arm[] {
  const resolved: Arm[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    const arm = resolveArm(name);
    if (arm === undefined || seen.has(arm.name)) return;
    seen.add(arm.name);
    resolved.push(arm);
    for (const source of arm.mixed ?? []) add(parseMixedSource(source).arm);
  };
  for (const name of names) add(name);
  return resolved;
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

/**
 * The row cap a run has to read its cache at, across the arms it requested *and their sources*.
 *
 * A mixed arm declares no `rowSamples` of its own: the block belongs to the source that sends it,
 * and that source is an arm. Reading the cap off the requested arms alone answered `undefined` for
 * `select-mixed-rule-rows`, so the cache stayed empty and the first render of that source's prompt
 * threw on a table nobody had read — `Cannot read properties of undefined (reading 'slice')`, run
 * `43466869878`. The cap is the maximum over both, because one cache serves every arm and the
 * largest request decides how deep it goes; the caller resolves the `#2` suffix of an A/A copy
 * before asking, since a name is not an arm.
 */
export function rowSampleRows(arms: readonly Arm[]): number | undefined {
  const caps = arms
    .flatMap((arm) => [arm, ...(arm.mixed ?? []).map((source) => resolveArm(parseMixedSource(source).arm))])
    .flatMap((arm) => (arm === undefined || arm.rowSamples === undefined ? [] : [arm.rowSamples]));
  return caps.length === 0 ? undefined : Math.max(...caps);
}

/**
 * A mixed arm's candidate count, checked against the sources it draws from.
 *
 * A source may be drawn more than once. `vote` is the number of candidates the arm buys and the
 * generation loop walks the source list round-robin, so `vote = 6` over three sources is each
 * prompt sampled twice: two draws of one prompt differ only by temperature, and a draw of two
 * different prompts differs by what is in front of the model — and the second kind was measured
 * to buy more per call here (`select-mixed`'s three prompts reached a 65.8% ceiling against
 * `select5`'s 64.7% on five samples, with two fewer calls).
 *
 * What must not happen is a count that is not a whole number of passes. Four candidates over
 * three sources would make the cost line true and the set askew — one prompt drawn twice while
 * the other two are drawn once — and the arm would be a different experiment than its name and
 * its price both say. It lives here rather than inside `runArm` because a rule that only a run
 * can trip is a rule no unit test can hold: the field would compile, the arm would look right,
 * and the first time anyone noticed would be in a report whose candidate set had already been
 * drawn unevenly.
 */
export function assertCandidatePasses(arm: Arm): void {
  const sources = arm.mixed;
  if (sources === undefined) return;
  assertMixedSources(sources);
  const declared = arm.vote ?? 1;
  if (declared % sources.length !== 0) {
    throw new Error(
      `arm ${arm.name} draws ${String(sources.length)} sources but declares ${String(declared)} candidates, which is not a whole number of passes over them; the candidate set would be askew and the cost claim unsupported`,
    );
  }
}

/**
 * Characters the rows block may spend on one question.
 *
 * Three rows of the text columns of the tables a question names costs 1,058 characters at the mean
 * and 3,244 at p90 on the dev split. Against a prompt of about 2,700 characters the mean is
 * affordable and the tail is not, so the rule ships with a ceiling: 800 keeps the median question
 * whole (483) and cuts the p90, which is where the cost lives.
 */
export const ROW_SAMPLE_BUDGET = 800;

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
  // The hint removed, everything else identical. Every arm this repository has ever run sets
  // `linking: true`, so "the hint helps" has never been a measurement — and the hint it ships
  // names 7.4 columns a question of which 29.8% are columns the gold statement uses, which is a
  // list that is wrong more often than it is right. This arm asks whether the prompt is better
  // or worse without it, and it is the cheapest experiment in the file: one flag, no new code.
  { name: 'inline+evidence-nolink', notes: false, evidence: 'dataset', repairs: 0, linking: false, definitions: 'inline' },
  // The hint built from the question *and* the evidence line. RSL-SQL's bidirectional linking
  // unions the columns its preliminary statement named, the columns the dataset's hint named and
  // an LLM's list; the middle one is a text scan, and this repository already puts that hint in
  // the prompt without ever showing it to the linker. Offline, at the same twelve slots, the
  // hint's column recall moves 39.3% → 55.2% and its precision 29.8% → 31.4%.
  { name: 'inline+evidence+link-evidence', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', linkEvidence: true },
  // Three stored rows per table, on the prompt the two arms above were measured on. This is the
  // input RSL-SQL's `Instruction.py` names five times and this repository has never sent: a column
  // sample shows a value's domain, a row sample shows which values occur together, and only the
  // second can say that `status = 'Banned'` belongs with `currency = 'EUR'`.
  //
  // The prediction was registered before this arm ran, in `docs/benchmarks.md`: if the pairing
  // hypothesis is right the gain concentrates on questions whose gold literal the `values` block
  // never found; if it is wrong the arm lands within ±1.7pp of its parent and the schema layer is
  // closed entirely rather than at both of its ends.
  { name: 'inline+evidence+rows', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', rowSamples: 3 },
  // The same prompt with the card carrying each categorical column's stored values. One
  // lever from `inline+evidence`, one call, no extra block: the instance knowledge sits on
  // the column line instead of in a list built from the question's wording.
  { name: 'inline+evidence+samples', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', samples: 'profile' },
  // The same lever with the competitor's rule instead of ours: six most-frequent values of
  // every non-key column, a small numeric dictionary included, a date collapsed to one, and a
  // NULL first when the column stores one. It exists to put the block MAC-SQL's selector reads
  // on our card, so the 6.45pp can be attributed to a block and not to "their pipeline".
  { name: 'inline+evidence+samples-wide', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', samples: 'example' },
  // The same block on the columns the prompt's own hint names, and on no other. This is the only
  // form of the value mechanism that can survive its own price: `samples-wide` bought +2.02pp for
  // +74.9% of the prompt, and the block's cost is its width rather than its bracket, so the
  // experiment is "how few columns still buy the gain". The rule reads the hint `buildAskMessages`
  // already renders, which makes it computable before the model is called and free of the answer.
  { name: 'inline+evidence+samples-wide-link', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', samples: 'example', sampleColumns: 'link' },
  // The same profiler on the columns the gold statement filters on, and on no other. An oracle
  // arm: it reads the answer, so it cannot be adopted, and it exists to bound the family.
  //
  // The block is priced by its width, not by its bracket: every profiled column costs +38.4% of
  // the card's characters on Mini-Dev, the filtered columns cost +1.4% and touch 37% of the
  // questions. So "show the stored values a condition needs" has to be measured at the size it
  // would actually be built, and this arm is that size. If it buys nothing while being shown
  // exactly the right columns, no rule that guesses them can either — and `samples` has been kept
  // alive for three rounds on a 2.22pp ceiling and +1.31pp at p = 0.052, which is the reading a
  // ceiling is supposed to settle rather than prolong.
  { name: 'inline+evidence+samples-gold', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', samples: 'profile', sampleColumns: 'gold' },
  // The card restricted to the fields the gold statement names, and to no other. An oracle arm, and
  // the answer to a question this repository has only ever asked in characters: what is a perfect
  // linker worth in accuracy?
  //
  // The literature prices it. AskData's own ablation, 500 Mini-Dev questions and one model: full
  // schema 71.2 with the hint, their linker 73.0, perfect linking 77.4 — so a linker that never errs
  // is worth +6.2pp over the schema we send, and +4.4pp over theirs. This repository's readings point
  // the other way, which is why the arm is decisive rather than confirmatory: `select-prune` loses
  // 1.50pp on the full split (p = 0.035) while saving 13.5% of the prompt, so "smaller card" is not
  // by itself a good. What prune cannot separate is size from content — it drops 4.8% of the gold's
  // tables to its seeds — and this arm drops none of the tables a gold statement reads. If it moves
  // the score, the lever is which fields are on the card; if it does not, the 8.2pp that separates
  // this repository from that cell is the author and the hint, not the linker.
  { name: 'inline+evidence+card-gold', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', cardColumns: 'gold' },
  // The empty-result turn on the arm this repository ships, which is not the arm it was
  // measured on: `select-mixed+empty` priced the message against a four-call parent whose
  // statements are chosen from three samples, and a trigger that fires on 5.2% of a single
  // call's answers has to be priced on that call. One lever from `inline+evidence`, and the
  // only one of their refiner's three triggers whose diagnostic is both true and ours.
  { name: 'inline+evidence+empty', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', emptyRetry: 'diagnosed' },
  // The only mechanism here that reads no result at all: the statement is put back in front of
  // the model with the question, and the reply names the conditions the statement failed to
  // write before it writes one that expresses them. One lever, one call, aimed at the largest
  // failure class the ladder found — 16.1-18.8pp where a gold filter's column is absent.
  { name: 'inline+evidence+audit', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', audit: 'conditions' },
  // The one rewrite the data proves, applied before the engine sees the statement.
  //
  // One lever from `inline+evidence`: the same prompt, the same card, the same single call, and a
  // query per literal instead of a call. `bench:bird:rewrite` priced the same edit offline on this
  // arm's own artifact — 22 fires, 14 wins, 0 losses, p = 0.0001 — and the gated form the project
  // measured for three rounds (only after an empty result) won 7, so the gate was costing exactly
  // what it excluded. This arm is the derivation under test: if the pipeline reaches the domain
  // reader, the score is the rewrite's; if it does not, the funnel reports zero substitutions and
  // `assertGroundingFired` refuses the reading rather than publishing the parent's accuracy.
  { name: 'inline+evidence+ground', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', ground: true },
  // One lever from `inline+evidence`, and the only one here that changes no card and spends no
  // call: a rule line about which columns the answer carries. It exists because the model
  // comparison put the largest negative term on `column-count` (130 → 204) while the same bucket
  // is already a fifth of this arm's no-answer corpus, so "the projection is the finding" was a
  // hypothesis with a bucket, a ceiling and a rule — not a hunch. It was dispatched once and the
  // hypothesis is wrong: the bucket fell 5 and `values` rose 7, 64 gains against 66 losses at
  // p = 0.93, and 77 cases changed shape to buy two net matches. See the note in `ON_DEMAND_ARMS`.
  { name: 'inline+evidence+projection', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', projection: 'asked' },
  // The same prompt with the card cut to the columns the model names, in one call before the
  // statement. One lever from `inline+evidence`, and the only card-cutting arm here whose rule
  // is not the lexical linker: `select-prune` prices the join closure and loses 1.4pp, this one
  // prices the model's own reading of the question. The plan calls it `llm-select`.
  { name: 'inline+evidence+llm-select', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', columnSelect: 'columns' },
  // The same prompt, the same call and the same one-line reply, applied the way the competitor
  // applies it: a table with no named column keeps its first six columns instead of vanishing.
  // One lever from `inline+evidence+llm-select` — the application rule — so the pair separates
  // "the model cannot choose" from "dropping the table was the mistake".
  { name: 'inline+evidence+llm-select-dense', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', columnSelect: 'dense' },
  // Retrieved knowledge instead of the dataset's per-question hint: the nearest
  // labelled questions from BIRD's train split, which shares no database with the
  // split under test. The arm exists to test whether the 13.8pp is knowledge or
  // the dataset's own wording.
  { name: 'inline+retrieval', notes: false, evidence: 'retrieved', repairs: 0, linking: true, definitions: 'inline' },
  // The same retrieved neighbours, but as worked examples with their statements.
  // Paired with `inline+retrieval`: one lever, so the delta prices the statements.
  { name: 'inline+icl', notes: false, evidence: 'retrieved', repairs: 0, linking: true, definitions: 'inline', demonstrations: true },
  { name: 'inline+icl-cot', notes: false, evidence: 'retrieved', repairs: 0, linking: true, definitions: 'inline', demonstrations: true, cotDemonstrations: true },
  { name: 'inline+reasoning', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', reasoning: 'sql-like' },
  { name: 'inline+icl-cot+reasoning', notes: false, evidence: 'retrieved', repairs: 0, linking: true, definitions: 'inline', demonstrations: true, cotDemonstrations: true, reasoning: 'sql-like' },
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
  // The same three prompts and the same four calls, drawn with the temperature the whole
  // multi-prompt family was in fact drawn at: zero.
  //
  // This arm is not a new idea. It is the coordinate `select-mixed` was measured at for a hundred
  // rounds without anyone choosing it: a mixed arm's candidates come from *source* arms, a source
  // declares no `vote`, and the pipeline read its temperature off the source — so `select-mixed`
  // sent 0 to every candidate while its comment, the catalogue and the plan all said "three
  // samples at temperature 0.7". The fix routes the arm's temperature to every candidate it buys,
  // and this arm is the control that keeps the historical reading reproducible in the same
  // dispatch as the repaired one: 0 against 0.7 against 1 is a dose-response curve for the one
  // variable, on one split, with one bill.
  //
  // Pre-registered: distinct executed results per question must rise from the cold arm's 1.26 to
  // at least 1.50 at 0.7; if it does not, the correlation is in what the three prompts share and
  // not in the endpoint, and every "buy more candidates" plan is closed for good.
  { name: 'select-mixed-cold', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: MIXED_SOURCES, temperature: 0 },
  // The same three prompts, the same four calls, drawn further apart.
  //
  // One lever in the only sense this repository counts: `select-mixed` with `temperature: 1`
  // instead of the 0.7 every sampling arm here was written against. Nothing else changes — same
  // card, same linker, same selector, same three sources, same cost — so the delta is the price of
  // asking the endpoint to move.
  //
  // It exists because the six-draw arm answered a different question than the one it was built for.
  // `select-mixed-spread2` bought three more draws and returned **1.33 distinct executed results
  // per question against 1.26** for three: on **462 of 493 questions the second pass added no new
  // answer at all**, and six questions in the whole split changed from "no correct candidate" to
  // "one". More draws at 0.7 are restatements, so the candidate-count ladder is not a lever on
  // this endpoint — but that reading cannot say *why*. Either 0.7 is too cold for this model, or
  // the three prompts share the information that decides the answer. This arm separates the two at
  // the same bill: if the pool widens and the ceiling moves, the temperature was the constraint and
  // the competitor's 21 draws are reachable here; if it does not, the constraint is what the
  // prompts know, and the next lever must change that rather than buy more of it.
  //
  // Pre-registered on Mini-Dev, beside `select-mixed` in one dispatch: `candidateRecall` must rise
  // from 64.3% by at least two points, and distinct results per question from 1.26 to at least
  // 1.50. A ceiling that moves by less than two points closes the sampling family — temperature,
  // draw count and source count are then one measurement, and the only lever left is information.
  { name: 'select-mixed-hot', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: MIXED_SOURCES, temperature: 1 },
  // The same three prompts, drawn twice each. Six candidates, seven calls.
  //
  // This is the one lever the strongest training-free competitor has and this repository has
  // never measured. `OpenSearch-AI/OpenSearch-SQL` (MIT, first place on BIRD in August 2024,
  // 69.3% dev / 72.28% test, no training and no fine-tuning) runs `"n": 21` at
  // `"temperature": 0.7` in `candidate_generate` and aggregates by *executed result* rather
  // than by statement (`vote.py` compares `set(tuple(row))` per candidate). Six candidates is
  // not twenty-one, and the reason is not thrift: this repository's own readings say the
  // second draw of one prompt is worth less than a draw of a second prompt (`select-mixed`
  // 65.8% ceiling on 3 prompts beat `select5`'s 64.7% on 5 samples, with two fewer calls), so
  // the ladder to twenty-one should climb by prompt first and repeat second.
  //
  // Pre-registered: the ceiling has to move. `select-mixed`'s pool reaches 67.75% on dev, and
  // a second pass over the same three prompts that does not add at least two points of ceiling
  // is a repetition the temperature paid for and the diversity did not — in which case the
  // remaining distance to the competitor is not candidate count and this ladder stops at one
  // rung instead of pretending to climb.
  { name: 'select-mixed-spread2', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 6, select: true, mixed: MIXED_SOURCES },
  // Three passes, nine candidates, ten calls: the rung that decides whether the curve is still
  // rising when it reaches double digits. Read against `spread2` rather than against the parent,
  // because two points between six and nine is the same slope that bought six over three, and a
  // slope that halves between the two rungs puts the twenty-one-candidate configuration of the
  // competitor out of reach on this prompt family — which would be a finding about *its*
  // candidate family, not about its candidate count, and the honest response would be to price
  // its prompts rather than to buy more draws.
  { name: 'select-mixed-spread3', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 9, select: true, mixed: MIXED_SOURCES },
  // The wide rungs with the free rule reading them instead of the model.
  //
  // The ladder above was built to climb to the competitor's `n: 21`, and it has only ever been
  // climbed by a chooser that costs a call. `select-mixed-rule` is the reading that matters at
  // three candidates — the rule beats the model selector by 2.29pp on 1,532 dev questions — and
  // it has never been pointed at a pool deeper than four, which is the one combination this
  // repository has documented as unmeasured rather than rejected.
  //
  // What it is for is arithmetic the artifact already contains. Rebuilt by subset over the
  // twelve candidates of `43473626220`'s four arms, the pool's ceiling rises with depth
  // (3 → 64.92%, 6 → 68.55%, 9 → 69.96%, 12 → 71.33%) while majority-by-result stays flat
  // (58.19%, 59.01%, 59.27%, 60.10%) and `shortest` at three candidates returns 61.29%. So
  // depth buys the pool and the *aggregator* throws it away, and the conversion these two arms
  // measure is the one number that decides whether depth is worth its calls: 92.7% of the
  // three-candidate ceiling is what the rule converts, and at that rate six draws are 63.6% and
  // nine are 64.8%. A conversion that falls with depth kills the configuration at 9 calls
  // instead of 21, which is the cheapest way this project can learn the answer.
  { name: 'select-mixed-rule-spread2', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 6, select: true, selectRule: 'shortest', mixed: MIXED_SOURCES },
  { name: 'select-mixed-rule-spread3', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 9, select: true, selectRule: 'shortest', mixed: MIXED_SOURCES },
  // `select-mixed` with its fourth call replaced by a rule that reads what that call was given.
  //
  // One lever in the only sense this repository counts: same three prompts, same card, same
  // candidates, same judge — a different chooser, and one call less. The reading that put this
  // arm here was taken offline from the parent's own artifact, where `shortest` scored 63.64%
  // against the selector's 62.79% on 1,532 dev questions, and 63.71% against 61.42% on the strong
  // pool (+2.29pp, p = 0.0030, 38 wins 19 losses). An offline rule reading is a *derivation*: it
  // assumes the pipeline would have produced the same candidates and ranked them the same way.
  // This arm is that assumption under test. Its artifact makes three instruments comparable on
  // one run — the score, the recorded candidates, and `bench:bird:consensus` over those
  // candidates — and the identity between the last two is exact or something is wrong.
  { name: 'select-mixed-rule', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, selectRule: 'shortest', mixed: MIXED_SOURCES },
  // The shipped three candidates and the shipped free rule, with one more candidate bought from a
  // source that differs in knowledge: three stored rows per table on the same prompt.
  //
  // This is the question the dev split left open and nobody asked. `select-intent` moved the pool
  // ceiling +2.22pp at p < 0.0001 and then *lost* the gain, because the paid selector's conversion
  // fell 3.50pp reading four candidates instead of three (`41767687844`). The shipped arm does not
  // read the pool with a model — `shortest` ranks it — so whether that arm inherits the ceiling or
  // the conversion loss is not derivable from the old artifact: the rule was never run on a
  // four-candidate pool. That is the only thing this arm measures, and it costs one call.
  //
  // Pre-registered against `select-mixed-rule`, same 496 questions, same run: ceiling ≥ +3.0pp,
  // `shortest` on four candidates ≥ +1.0pp, conversion (score ÷ `candidateRecall`) within 1.0pp of
  // the parent's, and `calls.mean` ≤ 4.05. A ceiling that rises while the score does not is the
  // `select-intent` finding reproduced on the free rule; a ceiling that does not rise retires the
  // source, and either outcome is a reading the next round can spend.
  { name: 'select-mixed-rule-rows', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 4, select: true, selectRule: 'shortest', mixed: ROWS_SOURCES },
  // The same purchase from the source that differs in grammar instead of in knowledge: a fourth
  // candidate rendered from a query intent. Same pool size, same rule, same calls as the arm above,
  // so the delta between the two arms is *which kind of difference* a fourth candidate has to be —
  // and read against `select-mixed-rule` it is the conversion test `select-intent` never got,
  // because that arm was measured with the paid selector and this one is not.
  { name: 'select-mixed-rule-intent', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 4, select: true, selectRule: 'shortest', mixed: INTENT_SOURCES },
  // The parent arm with the adjudication spent only where there is something to adjudicate.
  //
  // At temperature 0.7, 350 of Mini-Dev's 479 three-candidate questions (73.1%) returned one
  // result under the judge's own equality, and on those cases the model selector, `shortest` and
  // `modal` all score 70.57% — the same number, because the result is the answer and the statement
  // is not. The fourth call is not cheap there, it is unspendable. On the 129 that disagree the
  // three separate (44.2% / 35.7% / 26.4%), which is the only population a call can change.
  //
  // Pre-registered: accuracy within one point of the parent (the invariance is a construction, so a
  // departure is a defect in the gate and not a result about it), `calls.mean` at or below 3.35,
  // and `spend.asked` at or below 0.30 of the cases — the three readings that would make the paid
  // adjudication proportional to the questions that have something to decide.
  { name: 'select-mixed-gated', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: MIXED_SOURCES, gate: 'results' },
  // The same gate, with the judge shown the columns its candidates use.
  //
  // The selector has never read the schema; the generator always has. That costs nothing while the
  // pool agrees, and on a disagreeing pool it is the evidence the decision turns on — the failures
  // there are the shape where a candidate reads a column that exists in the wrong table, and a
  // preview cannot expose it because a plausible column returns a plausible result.
  //
  // Pre-registered, against `select-mixed-gated` on the same pool: accuracy at least +2pp, and on
  // the disagreeing subset the model's share of the ceiling at least 5pp higher than the parent's
  // 35.7/62.0. A block that changes nothing closes the "the judge was blind" explanation and points
  // the next mechanism at deliberation (pairwise, or a second reading) rather than at evidence.
  { name: 'select-mixed-gated-evidence', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: MIXED_SOURCES, gate: 'results', selectorEvidence: 'columns' },
  // The same gate, with the adjudication turned from a ranking into a knockout.
  //
  // The absolute prompt asks for one number out of three and has to hold the whole set in mind; the
  // knockout asks two questions with two candidates on the page and `k - 1` calls. CHASE-SQL's
  // selector is a binary comparison for this reason, and this harness priced the shape once
  // (`select-pair`, +0.8pp at 17/20) on the pool where every case pays for it. What it has never
  // been is *conditional*: on the 73% of Mini-Dev questions whose three candidates return the same
  // rows the comparison would be between two identical results, which is not a cheap call but an
  // unspendable one.
  //
  // Pre-registered against `select-mixed-gated`, on the disagreeing subset only (the population
  // both arms spend on): accuracy at least +5pp over `shortest`'s 44.2% there, `calls.mean` at or
  // below 3.65, and `pairwise.comparisons` exactly twice `pairwise.asked` — the closed form is the
  // instrument, and an arm whose comparisons are not `k - 1` per case compared something it did not
  // draw.
  { name: 'select-mixed-gated-pair', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: MIXED_SOURCES, gate: 'results', pairwise: true },
  // The same gate, with the adjudication asked for a statement instead of a choice.
  //
  // An index cannot name an answer none of the candidates contains, and on the cross pool that was
  // the whole 6.5pp the ceiling held and the decision missed. Here the population is narrower — the
  // disagreeing pool at temperature 0.7, where the candidates at least disagree about *something* —
  // but the shape is the same: the result groups go in, one statement comes back, and the arm pays
  // one call for it.
  //
  // Pre-registered against `select-mixed-gated`: accuracy at least +5pp on the disagreeing subset
  // over `shortest`'s 44.2%, and `reconcile.novel` at least 10% of the replies — the `always` policy
  // is what the last reconcile reading lost to, so this arm is read with `-novel` beside it rather
  // than instead of it.
  { name: 'select-mixed-gated-reconcile', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: MIXED_SOURCES, gate: 'results', reconcile: 'groups' },
  // The same prompt and the same one call, handing a restatement back to the vote.
  //
  // `select-cross-pooled-reconcile` adopted all 595 replies it could run and 514 of them restated a
  // candidate; it scored 359 against the free count's 380, and the loss is where the restatements
  // are. This is that finding applied to the gated pool: only a statement nobody wrote becomes the
  // answer, so the delta is the corrections and nothing else.
  { name: 'select-mixed-gated-reconcile-novel', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: MIXED_SOURCES, gate: 'results', reconcile: 'groups', reconcileAdopt: 'novel' },
  // The arm this split ships, plus one candidate that is a query description instead of a
  // statement. One lever from `select-mixed` in the sense that matters — same three prompts, same
  // card, same selector — and one call more, which the report publishes rather than hides.
  //
  // A fourth candidate can only raise the ceiling, so the ceiling is the pre-registered reading:
  // `select-mixed`'s pool reaches 67.75% on dev, and this arm has to reach 69.75% to be a lever
  // rather than a cost. The number is not arbitrary. Sources have been priced here three times
  // and the last one bought +0.58pp of ceiling for 17 sole-correct cases; two points needs a
  // source that is right on about thirty questions the other three all miss, and "the same
  // question, answered in a vocabulary that cannot express the wrong join" is the only candidate
  // left on the board that could be that.
  { name: 'select-intent', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 4, select: true, mixed: INTENT_SOURCES },
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
  // The empty-result turn on the cross set, spent by the model that wrote the statement.
  //
  // The turn used to be sent to the primary provider unconditionally, so on a cross arm the
  // reasoning model's empty result was rewritten by the chat model — a lever that silently
  // downgraded the arm it was attached to. This arm is the affordable test of the fix: it fires
  // only when the selected candidate returned nothing, and the artifact records which endpoint
  // answered the retry (`byPurpose.retry` moves between the two counters).
  { name: 'select-cross-empty', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, emptyRetry: 'diagnosed' },
  // The reasoning model in the judge's seat, asked in the shape it can answer.
  //
  // `select-cross`'s selector is the primary chat model reading a set whose dissenting member it
  // did not write. The measured asymmetry — the second model's correct statement returned 47% of
  // the time when only its set held the answer, against 87% for the primary's — has two readings,
  // and the judge swap is what separates them. The historical swap used the second model of that
  // day (`glm-4-flash`), which cost 6pp because it could not read SQL; this arm puts the
  // reasoning model there and asks it in the format it can follow. One lever from `select-cross`
  // (who judges), plus the format the capability contract says that judge needs.
  { name: 'select-cross-judge-reasoning', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, judge: 'second', judgeFormat: 'capability' },
  // The hint removed from the reasoning model's prompt and nothing else.
  //
  // On `select-cross`, the second model's slot is `inline+evidence`, whose user message ends with
  // `Likely columns: ...` — our linker's answer to the question this model was bought to answer.
  // The hypothesis is not "less prompt is better"; it is that the hint anchors a model that would
  // otherwise deliberate, and the arm exists to price that anchor with zero extra calls.
  { name: 'select-cross-unhinted', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, sourceLinking: { 'inline+evidence@second': false } },

  // The execution-feedback loop, granted to one model at a time. `select-cross` has none: its
  // candidates are executed by the harness after the fact, so a statement the engine refuses is
  // dropped and the ceiling falls by one without anyone ever being told why. These two arms put
  // the engine's message back in front of the model that wrote the statement, and they differ in
  // *which* model gets it — the question the capability contract exists to answer.
  { name: 'select-cross-repair-second', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, sourceRepairs: { 'inline+evidence@second': 2 } },
  { name: 'select-cross-repair-all', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, sourceRepairs: { 'inline+evidence@second': 2, 'metadata+evidence': 2, 'values': 2 } },
  // The same pool as `select-cross`, read by the same judge with the same instruction.
  //
  // By construction this arm must score exactly what `select-cross` scores: it generates nothing,
  // so its candidates, rows and previews are the parent's own objects. That makes it an
  // instrument rather than a lever — an exact-zero A/A on a shared pool. If the two do not agree
  // case for case, the pooling is broken (and `assertPoolShared` says so), and every judge-swap
  // delta measured on this pool would be suspect. It costs one call per case against the parent's
  // four, which is what makes the pair affordable at 600 questions.
  { name: 'select-cross-pooled', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, pool: 'select-cross' },
  // The judge swap with zero generation noise: same pool, same candidates, different judge.
  //
  // `select-cross-judge-reasoning` priced the swap against a parent whose pool it had drawn
  // itself, and the pool's own displacement at 600 questions (measured twice, ±1.3 to 3.3pp) is
  // the same size as the +2.17pp it reported. On this arm the reasoning model reads the chat
  // model's candidates: the only difference between it and `select-cross-pooled` is who judges and
  // in what format, so the delta is attributable by construction. One lever from
  // `select-cross-pooled` (who judges).
  { name: 'select-cross-pooled-judge-reasoning', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, pool: 'select-cross', judge: 'second', judgeFormat: 'capability' },
  // The same pool, decided by the count instead of by the model. Zero calls per case: the
  // candidates are read from `select-cross`, the official judge groups them by result, and the
  // modal group wins — which is what a voting arm does, on a pool no arm in this pair drew.
  //
  // This is the arm `bench:bird:decision` was written to ask for: across two archived readings
  // (41392023902 and 41380616205) the selector was right on 22 disputed cases where the modal
  // group was wrong and wrong on 53 where it was right (exact McNemar p = 4.5e-4). Those two
  // readings compared arms that drew their own pools, so the 2.58pp they imply is not yet a
  // measurement. Here it is one: same candidates, same rows, only the decision differs.
  { name: 'select-cross-pooled-vote', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, mixed: CROSS_SOURCES, pool: 'select-cross' },
  // Buy a fourth opinion, but only where the three already agree.
  //
  // `bench:bird:diversity` read this pool off the published artifact: 1.28 distinct results per
  // case, 447 of 600 cases unanimous, and 121 of the 185 ceiling losses *unanimous*. A selector
  // cannot reach a loss the set agreed on — there is nothing to choose between — so the only
  // lever left on the candidate side is a candidate nobody wrote, bought on the 74.5% of cases
  // where a fourth vote would otherwise be a wasted call.
  //
  // The source is `decompose`, and the choice is the registration: the pool's three opinions are
  // two prompts of the primary model and one prompt of the second model, so a fourth *prompt* on
  // the primary model would share a model with two of them. A decomposition is the one generator
  // in this repository that answers by a different method rather than by different wording, which
  // is the property XiYan-SQL's ensemble ablation prices at 4.04pp and MCS-SQL's at 1.3pp for five
  // prompts against 2.1pp for twenty samples of one. It is also not in `CROSS_SOURCES`, which the
  // suite enforces rather than trusts.
  //
  // The population is the unanimity the diversity reading found, and the criteria are written in
  // `docs/benchmarks.md` before the dispatch: the selector must convert at least 2.00pp of the
  // 600, the gain must sit on the unanimous cases (+1.5pp) and be absent on the others (±1.0pp),
  // `candidateRecall` must rise rather than re-rank, and the price is the funnel's `asked` share
  // — 0.745 calls a case, not one. The parent is `select-cross-pooled`: same pool, same selector,
  // same one selection call, and the only difference is the candidate the condition paid for.
  { name: 'select-cross-pooled-dissent', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, pool: 'select-cross', dissent: 'decompose' },
  // ...and the same bought opinion, put to the selector instead of in front of it.
  //
  // The first form returned a clean negative with a clean mechanism (`41551887197`): the ceiling
  // rose 1,023 → 1,050 and fell nowhere, and the four-candidate prompt converted none of it —
  // conversion 92.08% → 89.62%, 21 adoptions of which 5 were right, while the bought statement was
  // right 27 times. The oracle over the same four candidates is 68.54%, so the information was in
  // the set and the question could not reach it.
  //
  // This arm keeps the parent's prompt exactly — three candidates, one selection call — and spends
  // one more call only on the 100 cases where the bought statement disagrees: a comparison of the
  // pool's answer against it, which is the shape this repository's best selector already has
  // (`select-pair`) applied to the one pair that matters. Its price is 1 select + 0.724 generation
  // + 0.065 comparison ≈ 1.79 calls a case, 6.5% above the arm that bought the call and wasted it.
  //
  // The criteria are written in `docs/benchmarks.md` before the dispatch: the whole split must gain
  // at least 1.0pp (16 cases), the gain must sit on the 100 disagreements (at least 8 of them), the
  // rest of the split must stay within ±0.5pp, the ceiling must be unchanged at this arm's own
  // 1,050 (the candidate set did not change), conversion must return above 92%, and the comparison
  // costs 0.065 calls a case.
  { name: 'select-cross-pooled-dissent-pair', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, pool: 'select-cross', dissent: 'decompose', dissentVerify: 'pairwise' },
  // The same pool with the agreement marks the selector has never been given on this arm.
  //
  // Of 600 `select-cross` cases, 149 had candidates that returned different results — the only
  // cases where a choice exists — and the selector was told each candidate's row count but not
  // which of them matched. Two candidates that agree are one opinion counted twice, and a model
  // reading three truncated previews cannot compute that. One lever from `select-cross-pooled`,
  // so the pair prices the information and not the prompt template.
  { name: 'select-cross-pooled-agree', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, pool: 'select-cross', agreement: true },
  // Reconcile instead of choose: the same pool, the same one call, a statement for an answer.
  //
  // Everything above this line prices *which* candidate to return; on a heterogeneous pool the
  // answer has twice been "either one" — the count is free and the model costs a call for +0.17pp
  // then −0.17pp. The lever this arm prices is a different output: read the result groups, then
  // write the statement to run, which can be a correction no candidate contains. Same candidates,
  // same judge, same temperature, same single call; the difference is the question it answers.
  { name: 'select-cross-pooled-reconcile', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, pool: 'select-cross', reconcile: 'groups' },
  { name: 'select-cross-pooled-reconcile-novel', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, pool: 'select-cross', reconcile: 'groups', reconcileAdopt: 'novel' },
  // The same two arms on the *homogeneous* pool, which is the other half of the shape claim.
  //
  // `select-cross-pooled-vote` asked whether a free count is at least even where the candidates come
  // from two authors; it came back +0.17pp on 600 questions, which is a tie. The claim being tested
  // is not "the count is as good as the model" but "the model's value falls as the pool gets more
  // heterogeneous", and it is only tested by running the same pair where the pool is one author's
  // three prompts: there the candidates disagree less (8.3% of cases against 23-26%), a model has
  // more to notice, and the selector should win. Without this pair the reading has one pool and a
  // conclusion about shape drawn from it.
  { name: 'select-samples', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: SAMPLED_SOURCES },
  { name: 'select-mixed-pooled', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: MIXED_SOURCES, pool: 'select-mixed' },
  { name: 'select-mixed-pooled-vote', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, mixed: MIXED_SOURCES, pool: 'select-mixed' },
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
  // The adopted arm with the one fact its selector cannot see: which candidates returned the
  // same rows. Three hundred characters of a wide result cannot establish equality, so the
  // agreement a 2+1 pool turns on is left to be guessed. One lever from `select-mixed` — same
  // candidates, same prompts, same four calls — and the pair prices the information instead of
  // the model.
  { name: 'select-mixed+agree', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: MIXED_SOURCES, agreement: true },
  // ...and the same marks on the pool where they matter: `select-cross` is the arm whose
  // ceiling a dissenting slot raised and whose conversion fell, and 20 of the 22 questions the
  // slot added had the correct answer in the minority. Same candidates, same four calls.
  { name: 'select-cross-agree', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: CROSS_SOURCES, agreement: true },
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
  // The same drop and the same call, with the database's own values in the message instead of a
  // list of causes. Two steps come before the call and neither costs one: every literal the
  // statement compares against is looked up in its column, and a literal that differs only by
  // case is replaced with the stored spelling and adopted if the result is no longer empty. The
  // 19 dev questions whose whole candidate set returned nothing are the population, and 18 of
  // them wrote a value the database does not hold — `literal-missing` or `literal-case` in
  // `values-gap`'s taxonomy, arriving here as the detectable cause of a detectable state.
  { name: 'select-mixed+values', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', vote: 3, select: true, mixed: MIXED_SOURCES, emptyRetry: 'values' },
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
  // The same prompt one rule longer: reply with a query object, not a statement. One lever from
  // `inline+evidence`, and the only arm here whose output grammar is enforced — `intent.ts` renders
  // the statement, so what varies between this arm and its parent is what the model was allowed to
  // write, not what it knew. Run only as `select-intent`'s fourth source (`assertIntentRule`).
  { name: 'intent', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', intent: 'query' },
  // A plan before the statement: the ordering decisions (scan, filter, join, group,
  // answer) are made explicitly once instead of being encoded in one draft.
  { name: 'plan', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', plan: true },
  // `8u`: the plan is written by the second model and the statement by the primary, so the
  // writer never sees a reasoning trace. Priced against its parent, not against the `plan` arm:
  // the question is whether a better plan buys anything, not whether a plan written by the
  // weaker model does. See the lever's note for the criterion and why it is directional.
  { name: 'inline+evidence+plan-cross', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', plan: true, planBy: 'second' },
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
  // The dataset's hint *and* worked examples from the training split on the same card: the one
  // component of CHASE-SQL's pipeline that this repository has never stacked on its strongest arm.
  // `inline+icl` replaced the hint with retrieval, so it priced retrieval *instead of* the hint
  // (41-42% on Mini-Dev); this prices it *on top of* it, which is the configuration their paper
  // describes and the only one whose gain would show up as a higher ceiling.
  { name: 'metadata+evidence+icl', notes: true, evidence: 'dataset', repairs: 0, linking: true, demonstrations: true },
  // The same stacking with the definitions on the column line: the pair prices the card's
  // placement under the examples, which is the interaction `inline+icl` never measured because it
  // had no hint to interact with.
  { name: 'inline+evidence+icl', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', demonstrations: true },
  // The same stacking with the steps in each example. `inline+icl-cot` priced the block on an arm
  // that had already lost the dataset's hint (41% -> 48%), so the delta it produced was a delta
  // between two weak prompts. This pair prices the same block on the strongest single-call arm,
  // which is the configuration both competitors describe.
  { name: 'inline+evidence+icl-cot', notes: false, evidence: 'dataset', repairs: 0, linking: true, definitions: 'inline', demonstrations: true, cotDemonstrations: true },
  // The same stacking with the schema masked out of the examples and their dialect canonicalised —
  // DAIL-SQL's masked variant. One lever from `metadata+evidence+icl`, which `I-83` read as a
  // two-sided move: 30 fewer wrong-width statements and fifteen new execution errors naming another
  // schema's columns and functions. Paired with it in one run, so the delta prices the mask.
  { name: 'metadata+evidence+icl-masked', notes: true, evidence: 'dataset', repairs: 0, linking: true, demonstrations: true, masked: true },
  // The cheapest arm on the frontier with its card cut to the join closure. The card measurement
  // points at it: 90.5% of that prompt is the card, and 53.5% of the card belongs to tables the
  // gold statement never reads — so the lever that removed 12.6% of `select`'s prompt has more
  // to remove here, and the arm it acts on has no selector call to dilute the saving.
  { name: 'metadata+evidence+prune', notes: true, evidence: 'dataset', repairs: 0, linking: true, prune: 1 },
  // The two information levers on one card. Curated notes and stored values have each been
  // priced alone — the notes against a generated definition block (not separable, −0.8pp) and
  // the value block against a card with neither (+2.82pp, p=0.039) — and they have never been
  // on the same prompt. They are not the same information: a note says what a column means, the
  // block says which literal string it holds, and the largest remaining bucket of failures is
  // statements that run cleanly and answer the wrong question with the right shape. If the two
  // sources are complementary this is the arm that finds out; if they are redundant it prices
  // `values` on the strongest card instead of on the weakest one, which is the comparison the
  // +2.82pp has never had.
  { name: 'metadata+evidence+values', notes: true, evidence: 'dataset', repairs: 0, linking: true, values: true },
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
  // OpenSearch-SQL's self-taught CoT few-shot shape, which that system credits for part of its
  // 69.3% without training: the same neighbours as `inline+icl`, rendered with the steps each
  // statement encodes. In the chain because it is the mechanism under test this round.
  'inline+icl-cot',
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
  // Both are the same format in a position the chain does not yet price. They are on demand
  // because the round that introduces a mechanism asks for one number at a time: the few-shot
  // shape is in the chain, and these two wait for it to come back before spending 496 calls each.
  'inline+reasoning': 'the labelled step block in the prompt, without any few-shot change: run it beside `inline+icl-cot` to separate the format from the position it sits in',
  'inline+evidence+icl-cot': 'the steps inside the examples, on the arm that keeps the dataset hint: the position `inline+icl-cot` could not price, because its parent had already traded the hint for retrieval',
  'inline+icl-cot+reasoning': 'both positions at once: it is the pair that says whether the format is additive or the second copy is redundant, and it is not worth 496 calls until the two single-position arms have readings',
  vote: 'majority over the same three candidates: the selector control, measured 17:17 against `select` (p = 1) — running it every push re-derives a tie at 2,092 tokens',
  'inline+evidence+ground': 'the one rewrite the data proves, applied before the statement runs: priced offline on the parent arm\'s own artifact at 22 fires, 14 wins, 0 losses (+0.91pp, p = 0.0001) with the pairs disjoint from every other rule — run it when the domain reader or the prompt changes, and move it into the chain once the dispatch reproduces the offline count',
  'inline+evidence-nolink': 'the same prompt with the column hint removed: every arm in this file sets `linking: true`, so what the hint is worth has never been measured, and on 500 Mini-Dev questions it names 7.4 columns of which 29.8% are columns the gold statement uses — this is the only arm that can say whether a 30%-precise hint beats no hint, and it costs one flag',
  'inline+evidence+link-evidence': 'the hint built from the question and the dataset hint together, which is the middle source of RSL-SQL\'s bidirectional linking (its `extract_from_hint` scans the evidence for column names and unions the result): offline the same twelve slots move from 39.3% to 55.2% column recall at 29.8% → 31.4% precision, so this arm prices what that recall is worth at the answer rather than at the hint',
  'inline+evidence+rows': 'three stored rows per table on the same prompt: the one input RSL-SQL\'s `Instruction.py` names five times and this repository has never sent — a column sample shows a value\'s domain, a row sample shows which values occur together, and only the second can say that `status = \'Banned\'` belongs with `currency = \'EUR\'`; priced before it was built at 1,058 characters a question at the mean and 483 at the median on dev, with the prediction registered in `docs/benchmarks.md` (gain concentrates on questions whose gold literal `values` never found, or the schema layer closes entirely),',
  'select-prune': 'the card cut to the join closure: measured −1.4pp, and the loss is the ceiling rather than the selector (1,008 → 980 reachable cases), so it is priced; run it when the card changes',
  'inline+evidence+llm-select': 'the card cut to the columns the model names: measured −5.65pp against its parent (53:25, p = 0.0020, MDE 4.99pp) on 496 questions at `41190457163`, with the choice deciding 495 of 496 cases and keeping 10.8% of the columns for +39% prompt tokens — the mechanism fires and is a net loss, so it is kept as the ablation reference for relevance-by-model rather than run on every push',
  // Measured on `41290647076` in the same run as its parent and the column arm, so the three
  // numbers share one A/A: parent 278/496, column rule 253/496, this rule 261/496. Applied their
  // way the arm still loses 3.43pp to its grandparent (34:17, p=0.0241, MDE 4.03pp), and the
  // +1.61pp it recovers from the column rule is inside a 4.86pp MDE — the discordance (14.9%) is
  // what resolves, and separating 1.6pp at that rate needs 4,518 cases. So the verdict is the
  // sign of the earlier one with a corrected magnitude, and the card lever is closed at two
  // granularities rather than one.
  // Pre-registered before the dispatch, because an arm that runs without a prediction acquires a
  // verdict it did not earn. The value block was worth +2.82pp over a card with neither source;
  // the notes and a generated definition block were not separable (−0.8pp, four cases). So the
  // prediction is the interesting one of the two: the sources are complements and the arm lands
  // above `metadata+evidence`, or they are substitutes and it lands within noise, which would say
  // that the 166 failures left in the corpus are knowledge the card already carries and the model
  // is not using — a different next lever from "the prompt lacks a literal".
  // Measured on `41302183201` with an exact A/A (291 / 291, 5:5, delta 0.00pp): the pair is
  // 291 against 297, +1.21pp at 6:12, p=0.2379, MDE 2.40pp. So the answer is the second branch the
  // note was dispatched to separate: once the curated notes are on the card, the value block adds
  // nothing measurable, and the +2.82pp `values` is worth against a card with neither source was
  // filling the gap the notes fill as well. The block costs +7 prompt tokens a question, so this is
  // not a lever that fired and was too dear — it fired and did nothing.
  'metadata+evidence+values': "the curated notes and the value block on the same card — measured on `41302183201` at 297/496 against the parent's 291 (+1.21pp, 6:12, p=0.2379, MDE 2.40pp) with an exact A/A, so the two sources are substitutes rather than complements and the 166 remaining failures are knowledge the card already carries; kept as the ablation reference for 'more text on the prompt', not as a candidate",
  'inline+evidence+llm-select-dense': "the same reply applied their way: a table the model named nothing in keeps its first six columns instead of vanishing, which is what MAC-SQL's `drop_all` does — measured 261/496 against the column rule's 253 and the parent's 278 (`41290647076`), so it recovers 1.61pp of the 5.04pp loss (p=0.416, unresolved at 14.9% discordance) and still loses 3.43pp to the parent (p=0.0241); the card lever is closed at both granularities",
  'select-mixed': 'three decompositions instead of three samples: within its MDE of a single call on this split, and the decomposition question needs the dev split to be answered',
  'select-mixed-rule': "the parent's own candidates chosen by `shortest` instead of by the model: three calls instead of four, and the offline device already priced the rule at 63.64% against the selector's 62.79% on 1,532 dev questions (63.71% against 61.42% on the strong pool, +2.29pp, p = 0.0030) — this arm is the derivation becoming a measurement, and its artifact is what `bench:bird:consensus` must reproduce exactly",
  'select-mixed-rule-rows': "the shipped arm plus a fourth candidate drawn from three stored rows per table: the pool read apart offline says the missing statements are `values` failures (71.3% of the 168 questions whose pool held no correct candidate) and that seven filter sites in ten aim at a column that has never held the value, which is a fact about rows rather than about columns — the arm that asks whether a fourth candidate differing in knowledge converts under a rule instead of under a selector",
  'select-mixed-rule-intent': 'the same fourth call spent on a candidate rendered from a query intent: same pool size, same free rule, same price as `select-mixed-rule-rows`, so the two arms together say which kind of difference a fourth candidate has to be — and the delta against `select-mixed-rule` is the conversion test `select-intent` could not give, because that arm read four candidates with the paid selector and lost 3.50pp doing it',
  'select-samples': "the trio's third slot given to the sampled card rather than the value index: the same four calls, and the block it replaces is empty on 60.9% of the split",
  intent: 'the same card one rule longer, answering with a query object the renderer turns into SQL: the only arm whose output grammar is enforced, and the only one that cannot be dispatched alone — its statement is rendered on the candidate-source path, so `assertIntentRule` refuses a run that names it as an arm of its own',
  'select-intent': 'the shipped trio plus a fourth candidate rendered from a query intent: one call more than `select-mixed`, and the only arm on the board that can raise the pool ceiling rather than redistribute it — its verdict is the ceiling, pre-registered at +2.0pp (67.75 → 69.75) on dev',
  'select-duo': 'two prompts and a selector: measured −0.60pp against `vote` for the same money, superseded',
  select5: 'five samples and a selector: 4,103 tokens a case, the largest bill in the catalogue, and +0.40pp inside a 3.33pp MDE — the arm whose own measurement says the ceiling is not the sampler',
  'inline+evidence+samples': "the same prompt with each categorical column's stored values on its card line: one lever, one call, and the untested half of value grounding",
  // Its note is a question until the run that answers it lands. Saying "measured" here before
  // the number exists is how an arm acquires a verdict it never earned.
  'inline+evidence+samples-gold': 'the same sampler narrowed to the columns the gold statement filters on: an oracle, so its delta is a ceiling for the family and not an achievable one — run it when a column rule is proposed, never as a candidate',
  'inline+evidence+card-gold': 'the same prompt with the card cut down to the fields the gold statement names: an oracle for what a perfect linker is worth in accuracy, not in characters — run it to price the linker, never as a candidate',
  'inline+evidence+samples-wide': "the same lever with MAC-SQL's rule instead of ours: six most-frequent values of every non-key column, a small numeric dictionary included, a date collapsed to one, NULL first — measured on dev at +2.02pp (972/1532 against 941, p=0.0035, above the 1.89pp resolution) for +74.9% prompt tokens, so it is the priced ceiling of the value family and not a candidate: the shipped form of this mechanism has to fit a quarter of that budget",
  // Measured against its parent inside one dev artifact (`43591209696`), against a criterion
  // registered before the dispatch: +1.5pp and +25% tokens. Both were cleared, and the mechanism's
  // own bucket is the reason to believe it: `literal-case` fell 13 → 1 on a block an eighth the size
  // of the wide one. Its adoption is still open, because the arm this product ships is
  // `select-mixed-rule` and a block on one call is not a block on three.
  'inline+evidence+samples-wide-link': "the same sampler narrowed to the columns the prompt's own hint names: measured on dev at +1.50pp (960/1532 against 937, 52 wins to 29 losses, p=0.0140) for +9.17% prompt tokens, against a registered bar of +1.5pp and +25% — the wide block's two points cost three quarters of the prompt and this one costs a tenth of it, and `literal-case` fell 13 → 1 with it",
  // The verdict was recorded after the run, and it is the one the pre-registered criterion returns:
  // `column-count` fell 129 → 124 and `values` rose 462 → 469, so the rule moved failures rather
  // than repairing them, and 64 gains against 66 losses is a tie at p = 0.93. The transition table
  // is the reading: 13 cases became correct and 28 became `values`, 25 correct answers became
  // `column-count`, and 77 cases changed shape to buy two net matches. `bench:bird:width` said as
  // much in advance — 26 of 37 wide cases stay wrong with the right width — so the bucket was a
  // symptom and this lever is closed rather than "underpowered".
  'inline+evidence+projection': "one rule line about which columns the answer carries: measured on `42122026848` at 939/1,532 against its parent's 941 (-0.13pp, 64 gains, 66 losses, p = 0.93), with `column-count` 129 → 124 and `values` 462 → 469 — a redistribution, not a repair, and the pre-registered criterion's second clause (values must not rise) refused it. Kept as the ablation reference for a projection rule; the 59 `column-count` cases in the model comparison are not addressable by an instruction",
  // The condition rather than the block, and the one trigger of their refiner's three that is both
  // true and ours. `agents.ts` counts it firing on 26 of the 496 answers (5.2%) and on no gold
  // statement, so here it is exact: every fire is a wrong answer. Its size, though, comes from the
  // one place it has been measured — 63 fires under `select-mixed+empty` returned rows 32 times and
  // bought 9 cases, so 14.3% a fire, which on 26 fires is +0.75pp. That is below the 2.0pp this
  // harness moves by itself on 496 questions and below the dev split's MDE, so the arm is written
  // and paired and deliberately not dispatched: an experiment that cannot resolve its own effect
  // spends 496 calls to report noise.
  // The chain's only arm whose trigger is the question rather than the result, and the one
  // whose verdict moved it out of the chain. It targets the largest failure class left
  // (16.1-18.8pp) and is invisible to every other trigger on this page, which is why it was
  // written; measured on the dev split it pays 2x calls and 2.3x completion tokens for +1.2pp
  // at p = 0.48, so it is an ablation reference rather than a candidate. Kept beside
  // `inline+evidence+empty` because the two are the same question asked at different triggers:
  // a condition the question implies and never wrote, versus a result that came back empty.
  'inline+evidence+audit': "the condition audit as a second call, measured on dev at +1.2pp for 2x calls and 2.3x completion tokens (p = 0.48) — the largest failure class it targets is real and this trigger is not what repairs it, so it is the ablation reference for 'ask again about the conditions' rather than a candidate",
  'inline+evidence+empty': "the turn after a statement returns nothing, on the arm that ships: 5.2% of answers fire it and every fire is a wrong answer, but the measured yield is 9 cases in 63 fires, so +0.75pp on 496 questions — under this harness's own 2.0pp noise and under the dev split's MDE, which is why it is written, paired and not dispatched",
  definitions: 'structural semantics built from keys: superseded by inline placement, kept as the parent of definitions+evidence',
  'dataset-subset': 'isolates coverage from author, run when a definition arm moves',
  'definitions+evidence': 'second lever of the semantics chain, not a candidate for the chain itself',
  'synth-definitions+evidence': 'combines two levers already measured separately',
  interpret: 'one extra call per question; measured null, kept for re-testing',
  metadata: 'no definitions at all: parent of metadata+evidence, run only to re-derive the parent',
  'metadata+evidence+icl': "the dataset hint and worked examples from the training split on the same card: the one component of CHASE-SQL's pipeline never stacked on this repository's strongest arm, and the arm the ceiling criterion (>= +4pp) is registered against — it needs the training split, an 8.5 GB archive from which only `train.json` is kept, so it is dispatched rather than run on every push",
  'inline+evidence+icl': 'the same stacking on the inline card: the pair against `metadata+evidence+icl` prices the card placement under the examples, and it carries the same fetch cost',
  'metadata+evidence+icl-masked': 'the stacked examples with the schema masked out and the dialect canonicalised (DAIL-SQL\'s masked variant): one lever from `metadata+evidence+icl`, dispatched with it so the delta prices the mask, and carrying the same training-split fetch',
  'metadata+evidence+prune': 'one lever from metadata+evidence, on the arm where the card is 90.5% of the prompt: priced on the card measurement first, then dispatched, because the closure costs 33 of the 496 cases a gold table',
  synthetic: 'profiles as evidence: measured null',
  'synthetic+focus': 'profile plus a focus instruction: measured null',
  adaptive: 'per-database prompt profile: measured null',
  'no-linking': 'removes the schema linker: the arm that prices linking, run when linking changes',
  repair: 'the original repair arm (dataset notes, two attempts, one generic sentence): superseded by inline+repair, which is one lever from inline+evidence and reports a funnel',
  'select-cross': 'the trio with its first candidate from a second model: needs BIRD_SECOND_MODEL and a second key, so it is dispatched rather than run on every push',
  'select-mixed+agree': 'the adopted arm with agreement marked on the candidates: one lever, four calls, and the selector prompt differs by a line per agreeing candidate — run it against `select-mixed` when the pool question is conversion and not generation',
  'select-cross-agree': 'the cross arm with the marks: needs the second model, and is measured against `select-cross`, which is where a dissenting slot made agreement ambiguous',
  'select-cross-judge-reasoning': 'the cross set judged by the reasoning model, asked in the shape a reasoning model can answer: needs the second model and a second key, and is measured against `select-cross`; the pair `select-cross-judge` -> this arm prices the format, this arm -> `select-cross` prices the judge',
  'select-cross-empty': 'the cross set with one turn spent on an empty result, sent to the model that wrote the statement: needs the second model, and is measured against `select-cross`',
  'select-cross-unhinted': 'the cross set with the linker hint removed from the reasoning model\'s prompt only: needs the second model, no extra call, and is measured against `select-cross`',
  'select-cross-repair-second': 'the cross set where only the reasoning model may spend two repair turns on an engine error: the loop costs nothing on a case that already ran, and the delta is what a strong model does with feedback',
  'select-cross-repair-all': 'the cross set where all three candidates may spend two repair turns: measured against `select-cross` for the loop and against `select-cross-repair-second` for whether the weaker models benefit as much',
  'select-cross-pooled': 'the cross set read from `select-cross`\'s own pool instead of generating one: one call per case instead of four, and the pair must read exactly 0.0pp — it is the instrument that says whether two arms on this harness can be compared at all, so run it in the same dispatch as `select-cross` and before any pooled comparison',
  'select-cross-pooled-judge-reasoning': 'the reasoning model judging the chat model\'s candidates, in the format it can answer: needs the second model and a second key, one call per case, and is measured against `select-cross-pooled` on the same pool — the only judge-swap delta with no generation noise in it',
  'select-cross-pooled-vote': 'the same pool decided by the modal result instead of by a model: zero calls per case, and the only reading of "is the selector worth its call" whose candidates are shared — the archived artifacts say the count wins 53 disputed cases to 22 (p = 4.5e-4), and this arm is what turns that into a measurement instead of a re-reading',
  'select-cross-pooled-dissent': 'the same pool and the same selector with one decomposition bought only where the three agreed: 4 calls per case on the 74.5% of cases the diversity reading found unanimous and 3.0 on the rest, and it must be dispatched after `select-cross` because it reads that pool — the pair against `select-cross-pooled` is the whole lever, so run those two and no others',
  'select-cross-pooled-dissent-pair': 'the same bought opinion, compared against the pool\'s answer on the cases where it disagrees instead of shown to the selector as a fourth candidate: one comparison call on 6.5% of cases, and it must be dispatched after `select-cross` because it reads that pool — the pair against `select-cross-pooled-dissent` is the whole lever, so run those two and no others',
  'select-cross-pooled-agree': 'the same pool with the agreement marks the selector was never given: 149 of 600 cases had more than one distinct result, and which of three candidates returned the same rows is the one fact two truncated previews cannot yield; one lever from `select-cross-pooled`, one call per case',
  'select-cross-pooled-reconcile': 'the same pool and the same one call, asked for a statement instead of an index: an index cannot name an answer none of the candidates contains, and on this pool the correct statement is in the set on 70.5% of cases while the arm scores 64% — the 6.5pp the decision misses is the population this arm exists to reach; the funnel counts how often the reply is a statement nobody wrote, because an arm that restates a candidate is a selector with a longer prompt',
  'select-cross-pooled-reconcile-novel': 'the same prompt and the same call as `select-cross-pooled-reconcile`, with one policy difference: a reply that restates a candidate hands the decision back to the vote instead of overwriting it — the arm that measured 59.8% against the vote\'s 63.3% adopted every one of the 595 replies it could run while only 86 of its 600 replies were statements nobody wrote, so the rewrites are the population this arm stops paying for; run it against `select-cross-pooled-vote` to price the novel statements alone',
  'select-mixed-pooled': 'the homogeneous pool (`select-mixed`) read without generating anything: one call per case, and the A/A instrument for the shape claim — it must read exactly what `select-mixed` read, because the delta from it to `select-mixed-pooled-vote` is the one number that says whether a model is worth more where the candidates agree more',
  'select-mixed-pooled-vote': 'the homogeneous pool decided by the modal result: zero calls per case, and the other half of the shape claim — the selector should win here, which is the prediction a "the selector is bad" explanation does not make',
  'select-tagged': 'the cross arm with each candidate labelled by its source: needs the second model too, and is measured against `select-cross`',
  'vote-mixed': 'three prompts aggregated by modal result instead of by a model: 63% would make the selector call unnecessary, and below that it prices what the model adds',
  'vote-cross': 'the cross-model candidate set aggregated by modal result: needs the second model too',
  'select-cross-judge': 'the cross set judged by the second model: needs the second model and a second key, and prices self-preference in the judge',
  'select-cross-canon': 'the cross set rewritten into one SQL style before the selector reads it: the lever that closes the style channel the judge swap proved is open, not a different judge; needs the second model, and is measured against `select-cross`',
  'select-cross-judge-canon': 'the canonical text read by the second model: the arm that prices canonicalisation where the style channel was measured, one lever from `select-cross-judge` and two from `select-cross-canon`; needs the second model and a second key',
  'select-balanced': 'the same three prompts with two candidates from the second model instead of one: flips which author holds the majority, and needs the second model',
  'select-cross-shuffled': 'the same three candidates permuted per question id: flips which author holds slot zero, which is the one thing `select-cross` and `select-balanced` both hold fixed; needs the second model',
  plan: 'query plan before the statement: 50.4% against 57.6% for its parent (-7.2pp, 63/27, p=0.0002) — anchoring, not helping; kept so the finding can be re-tested',
  'inline+evidence+plan-cross': 'the plan written by the second model and the statement by the primary: `8u`, the only repair the paired widening reading leaves, and the first arm here whose criterion is to beat **both** parents — needs the second model and a second key, two calls per case',
  'select-pair': 'pairwise comparison instead of an absolute ranking: 58.4% against 57.6% for its parent (+0.8pp, 17/20, p=0.74) at one more call, and it lost more of its candidate set (25 cases against 20) — the absolute prompt is not what the selector loses; kept so a different comparison order or a two-of-three vote can be measured against it',
  'inline+shape': 'scalar-shape guard before the repair loop: 57.2% against 58.4% for its parent (-1.2pp, 11/5, p=0.21) — it fired on 21 cases, repaired 2, and shifted 14 more into the wrong column count; kept so a better shape test can be measured against this one',
  'select-mixed+empty': 'the adopted arm with an empty result treated as a failure: drops the candidate that returned nothing and spends one turn when every candidate did; the only lever measured so far whose signal is exact rather than heuristic',
  'select-mixed+empty-blind': 'the same drop and the same extra call with a message that says nothing about the empty result: the control that separates the information from the call, and it cannot be dispensed with, because a second draw at a non-zero temperature also moves the number',
  'select-mixed+values': 'the same drop and the same extra call, with the columns\' literals looked up first: a case-only difference is adopted without a call and everything else is quoted back as the values the column does hold. The pair with `select-mixed+empty` prices what the lookup knows against what the diagnosed message guesses, at the same call count',
  decompose: 'the statement composed from steps written in the same reply: one lever from `inline+evidence` at the same call count, so it prices a shape of generation rather than a budget',
  'select-mixed+dc': 'the adopted arm with a fourth candidate written by decomposition: the only addition that can create a statement the three prompts cannot, which is what the routing analysis left open',
  'select-dc': 'the third candidate written by decomposition instead of by the value index: same count, same four calls, and the slot values actually won 5.3% of the time',
  'select-mixed-spread2': 'the three prompts drawn twice each: six candidates and seven calls, which is the rung this repository has never climbed and the one the strongest training-free competitor stands on (it draws 21 at temperature 0.7 and votes on executed results). On demand rather than in the chain because its verdict is a ceiling reading on 1,532 dev questions — 498 cannot resolve two points of ceiling, and the arm costs 7 calls a question. Run it beside `select-mixed` and read `candidateRecall`, not the score: the question is whether a second pass over the same prompts widens the set at all',
  'select-mixed-gated': 'the parent arm with its fourth call conditional on the pool: 73.1% of Mini-Dev three-candidate questions at temperature 0.7 return one result, and on those the selector, `shortest` and `modal` all score 70.57%, so the call is unspendable rather than cheap. The gate reads the pool with the judge\'s own equality, picks by rule when it agreed, and calls the selector unchanged when it did not — so the delta from `select-mixed` is cost and nothing else. Read `calls.mean` (bar: at most 3.35), `spend.asked` (bar: at most 0.30 of cases) and accuracy (bar: within one point, because the invariance is a construction and a departure is a defect)',
  'select-mixed-gated-evidence': 'the gated arm with the judge shown the columns of the tables its candidates read: the selector has never seen the schema and the generator always has, which costs nothing on an agreeing pool and is the whole decision on a disagreeing one. Against `select-mixed-gated` the bar is +2pp overall, and on the disagreeing subset a model share of the ceiling at least 5pp above the parent\'s 35.7/62.0. A block that moves nothing retires the "the judge was blind" explanation and points the next mechanism at deliberation',
  'select-mixed-gated-pair': 'the gate with the adjudication turned into a knockout: two candidates on the page, two calls, and nothing spent on the 73% of the pool that agreed with itself. The absolute prompt has to hold three statements in mind and emit one number; CHASE-SQL\'s selector is binary for that reason. Bar, on the disagreeing subset: +5pp over `shortest`\'s 44.2%, `calls.mean` at most 3.65, and `pairwise.comparisons` exactly twice `pairwise.asked` — a knockout that compared anything but its own pool is a bill nobody can attribute',
  'select-mixed-gated-reconcile': 'the gate with the adjudication asked for a statement: the result groups go in, one statement comes back, and the arm pays one call only where the pool disagreed. An index cannot name an answer none of the candidates contains, which is the population the ceiling holds and the decision misses. Read `reconcile.novel` beside the delta: an arm whose replies all restate a candidate is a selector with a longer prompt',
  'select-mixed-gated-reconcile-novel': 'the same prompt and the same one call as `select-mixed-gated-reconcile`, handing a restatement back to the vote: the cross-pool reading adopted every runnable reply and 514 of 600 were paraphrases, which is where its 5pp loss lives. This arm isolates the corrections, so its delta is the statements nobody wrote',
  'select-mixed-cold': 'the same three prompts and the same four calls at temperature 0: the coordinate every multi-prompt arm was silently measured at, kept as the control rather than as a claim. It is the arm a "more candidates help" hypothesis has to beat, and it costs nothing beyond its four calls — dispatch it beside `select-mixed` and `select-mixed-hot` so the three rungs share one split, one judge and one bill',
  'select-mixed-hot': 'the same three prompts and the same four calls drawn at temperature 1 instead of 0.7: the one experiment that separates "0.7 is too cold for this endpoint" from "the three prompts already know the answer", at no extra cost. On demand because it is a ceiling reading and it must share a dispatch with `select-mixed` to be paired — 498 questions resolve about two points of ceiling and nothing finer. Read `candidateRecall` (bar: 64.3% + 2pp) and the distinct-results-per-question line from `bench:bird:diversity` (bar: 1.26 -> 1.50). A ceiling that does not move closes the sampling family: draw count, source count and temperature are then one measurement',
  'select-mixed-spread3': 'three passes, nine candidates, ten calls: the rung that says whether the ceiling curve is still rising at double digits. Read against `spread2`, not against the parent — a slope that halves between six and nine closes the competitor\'s 21-candidate configuration as an explanation and moves the question to its prompt family',
  'select-mixed-rule-spread2': 'six candidates from the three prompts, read by the free rule: the same pool as `spread2` with the model selector removed, so the pair prices what the fourth call buys on a wide pool and this arm prices what the rule costs. Read it against `select-mixed-rule`, not against its sibling: the ceiling went up (64.92 → 68.55% by subset on the previous artifact) and the only question is how much of it an aggregator that reads length can still return',
  'select-mixed-rule-spread3': 'nine candidates, nine calls, one rule. This is the rung where a decreasing conversion is visible as a number rather than as a trend, because the pool is three times the width the rule was measured on and `shortest` has no way to prefer a longer statement that a wider pool makes more likely to be right',
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
  // The audit turn was dispatched to dev twice without a declared pair, so both readings were
  // printed as two accuracies and the interval between them was left to the reader. 943 / 930
  // here, and the Mini-Dev run that first promoted it was +1.01pp against a 2.04pp MDE. Declaring
  // the pair costs nothing and turns the next dispatch into a paired test.
  ['inline+evidence', 'inline+evidence+audit', 'the condition audit as a second call: fired on 1,507 of 1,532 dev cases, named a missing condition on 30 and rewrote 43, and scored below its parent'],
  ['inline+evidence', 'select', 'selection over three samples versus a single sample: four calls instead of one'],
  ['inline+evidence', 'select5', 'selection over five samples versus a single sample: six calls instead of one'],
  ['inline+evidence', 'values', 'value grounding on top of the hint: does instance knowledge add anything the hint lacks'],
  // The block the competitor's selector reads, against the same card without it, and against
  // the same lever under our own sampler: the first prices the information, the second prices
  // the rule that selected it.
  //
  // Three arms are needed and not two. `samples` is the arm that says "stored values at all",
  // and without its pair against the plain card the two samplers' agreement could not be told
  // from both of them doing nothing: 20 cases each way is a tie, and a tie between two arms
  // that each beat the base is a different finding from a tie at the base's level.
  ['inline+evidence', 'inline+evidence+samples', 'stored values on the card, sampled by our profiler: the information, before any question of which values'],
  ['inline+evidence', 'inline+evidence+samples-wide', "the competitor's value examples on our card: the block MAC-SQL's selector reads, priced against the card without it"],
  ['inline+evidence+samples', 'inline+evidence+samples-wide', 'the same lever under two samplers: which columns are shown and what a shown column says'],
  // The width half of the same question, and the pair that decides whether the mechanism ships:
  // the sampler, the values, the order and the call count are held, and only the set of columns
  // carrying a bracket changes.
  ['inline+evidence', 'inline+evidence+samples-wide-link', "the competitor's values on the columns the hint names: the block at the width that could ship, against the card without it"],
  ['inline+evidence+samples-wide', 'inline+evidence+samples-wide-link', 'the same block on every profiled column versus on the columns the hint names: the delta is what narrowing costs in accuracy and the character column is what it saves'],
  // The block's width, which is the whole of its cost. The pair keeps the sampler, the values, the
  // order and the call count, and changes only which columns carry a bracket — so the delta is the
  // price of narrowing, and the character column beside it is the price of not narrowing.
  ['inline+evidence+samples', 'inline+evidence+samples-gold', 'the same sampler on every profiled column versus on the columns the gold statement filters on: an oracle for what a column rule could be worth'],
  ['inline+evidence', 'inline+evidence-nolink', 'the column hint removed from the same prompt: the first reading of what the hint is worth, on a hint that is 30% precise'],
  ['inline+evidence', 'inline+evidence+link-evidence', 'the same hint built from the question and the dataset hint together: what the linker gains when it reads the text the model already reads'],
  ['inline+evidence', 'inline+evidence+rows', 'three stored rows per table: the one input in RSL-SQL\'s prompt this repository never had, priced at 800 characters a question'],
  ['inline+evidence', 'inline+evidence+empty', 'the turn after a statement returns nothing: the one refiner trigger whose message carries something true, priced on the arm the empty trigger actually fires on'],
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
  // The conditional fourth opinion, against the same pool with the same selector and no extra
  // call. This is the one comparison in this file whose cost is a *share*: the child spends the
  // call on the 74.5% of cases where the pool agreed with itself and nothing on the rest, so its
  // delta is placed on a population that the pair states rather than assumes.
  ['select-cross-pooled', 'select-cross-pooled-dissent', 'the same pool and selector with one more opinion bought only where the three agreed: 0.745 calls a case, against the 30.83pp of ceiling the candidates agreed away'],
  // The question rather than the candidate: the same bought opinion, put to the selector on the
  // cases where it disagrees instead of added to the list it reads. One comparison call on 6.5% of
  // the split, against the four-candidate prompt that was read and not used.
  ['select-cross-pooled-dissent', 'select-cross-pooled-dissent-pair', 'the same bought opinion verified one-pair-at-a-time instead of offered in a longer list: 0.065 comparison calls a case against the conversion the longer prompt lost'],
];

export const PAIRS: readonly (readonly [string, string])[] = [
  ['names', 'definitions'],
  ['definitions', 'synth-definitions'],
  ['synth-definitions', 'inline-definitions'],
  ['inline-definitions', 'dataset-subset'],
  ['inline-definitions', 'inline+evidence'],
  ['inline-definitions', 'inline+retrieval'],
  ['inline+retrieval', 'inline+icl'],
  // One lever: the same neighbours, the same ranking, the same count — only each block gains the
  // steps its statement encodes. Without this pair the arm is a score with no parent.
  ['inline+icl', 'inline+icl-cot'],
  // The same format in the other position: the block is in the prompt instead of in the examples.
  ['inline+evidence', 'inline+reasoning'],
  // The block, and then the block with its steps, both on top of the dataset's hint: two levers,
  // each priced against the arm directly below it rather than against the retrieval arm.
  ['inline+evidence', 'inline+evidence+icl'],
  ['inline+evidence+icl', 'inline+evidence+icl-cot'],
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
  // One lever: the application rule for the same reply. Same prompt, same call, same temperature
  // — the dense arm keeps six columns of every table the model did not name, so the pair separates
  // the price of asking the model from the price of deleting the tables it did not name.
  ['inline+evidence+llm-select', 'inline+evidence+llm-select-dense'],
  // One lever from the strongest single-call arm: the value block. Same notes, same hint, same
  // prompt skeleton — the only difference is whether the literals the question names are spelled
  // beside the columns that hold them, which is what `values` adds and nothing else does.
  ['metadata+evidence', 'metadata+evidence+values'],
  // The audit pair is gone, and its absence is the record. It was declared here while the arm was
  // in the minidev chain; the arm left the chain on the dev split's own reading (+1.2pp for 2x
  // calls and 2.3x completion tokens, p = 0.48), and a pair that names an arm a split does not run
  // promises a reading nobody can take — `check-bird-baseline` refuses exactly that, which is how
  // this line came to be removed rather than left as a comment about a measurement that is over.
  // One lever from the plain single call, and the only pair in this table that spends no call at
  // all: the same prompt, the same card, one query per literal, and a statement the column can
  // correct. The pair prices a rewrite, not a decision — which is why its delta is expected to be
  // exactly the count `bench:bird:rewrite` already reported on the parent's own statements.
  ['inline+evidence', 'inline+evidence+ground'],
  // One lever from the plain single call, and the cheapest one in this table: one rule line
  // about the projection, no extra call and no card change. The pair exists so the delta is
  // attributable to the sentence rather than to a prompt that grew somewhere else too.
  ['inline+evidence', 'inline+evidence+projection'],
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
  // One lever: which prompt holds the third candidate, at the same call count. The value index it
  // replaces is empty on 60.9% of the split, so the pair is also the only reading of what a third
  // opinion is worth when the third slot stops being a restatement.
  ['select-mixed', 'select-samples'],
  // One lever: a fourth candidate whose statement is rendered from a query object instead of
  // written as text. The only pair in this table where the *grammar* differs rather than the
  // knowledge, and the only one that can move the pool's ceiling rather than redistribute it.
  ['select-mixed', 'select-intent'],
  // One lever: the schema. Same retrieval, same k, same card, same number of examples — the only
  // difference is that one block's statements name the source schema and the other's do not, which
  // is what `I-83`'s failure table separated (30 fewer wrong-width statements, 15 more execution
  // errors) and what `I-84` prices.
  ['metadata+evidence+icl', 'metadata+evidence+icl-masked'],
  // One lever: the same candidates in one SQL style, so the selector cannot see who wrote them.
  ['select-cross', 'select-cross-canon'],
  // One lever on the judge that used the channel: the same canonical text, read by its author.
  ['select-cross-judge', 'select-cross-judge-canon'],
  // One lever: which author holds the majority among the same three prompts.
  ['select-cross', 'select-balanced'],
  // One lever: where the authors sit, holding the majority and the prompts fixed. The pair
  // that can say whether the 52.6% belongs to the author or to slot zero.
  ['select-cross', 'select-cross-shuffled'],
  // One lever: who judges the same three candidates, with the format that judge needs. The
  // historical judge swap (glm-4-flash, -6pp) conflated "a weaker model cannot read SQL" with
  // "a different model is not the answer"; this pair separates the model from the format.
  ['select-cross', 'select-cross-judge-reasoning'],
  ['select-cross-judge', 'select-cross-judge-reasoning'],
  // One lever: whether the empty-result turn is sent to the statement's author or to the primary
  // model. The pair is what prices the fix; before it, the retry on a cross arm was a downgrade.
  ['select-cross', 'select-cross-empty'],
  // One lever: whether the reasoning model's prompt carries our linker's answer in front of it.
  // Zero extra calls, so the delta is the anchor and not a budget.
  ['select-cross', 'select-cross-unhinted'],
  // One lever each: the same three prompts, the same endpoints, and an engine that answers back.
  ['select-cross', 'select-cross-repair-second'],
  ['select-cross', 'select-cross-repair-all'],
  // Prices the *model* rather than the loop: both arms repair, one only on the reasoning
  // model's candidate, so the difference is what the stronger model does with feedback the
  // weaker ones were also given.
  ['select-cross-repair-second', 'select-cross-repair-all'],
  // One lever: whether the arm generates its candidates or reads the ones `select-cross` already
  // drew. This pair is an instrument, not a hypothesis — the delta must be exactly zero, because
  // the pooled arm chose among the parent's own candidate objects with the parent's own judge. A
  // non-zero delta here means the pooling is broken, and no judge-swap reading on this pool can be
  // trusted until it is fixed.
  ['select-cross', 'select-cross-pooled'],
  // One lever: who judges, on a pool neither arm generated. This is the pair the two previous
  // judge-swap arms could not be, and the only one whose delta has no generation noise in it.
  // The same pair on the homogeneous pool, which is where the shape claim makes the opposite
  // prediction: three prompts from one author disagree on 8.3% of cases, not 23-26%, so the model
  // has less to notice and the free count has less to gain. A pair that reads the same sign on both
  // pools would say the shape claim is wrong.
  ['select-mixed', 'select-mixed-pooled'],
  ['select-mixed-pooled', 'select-mixed-pooled-vote'],
  ['select-cross-pooled', 'select-cross-pooled-judge-reasoning'],
  // One lever: who decides on a pool neither arm drew — the model or the count. `vote-cross`
  // asked this across two pools and could not answer it; here the candidates, the rows and the
  // order are identical, so the delta is the decision and nothing else. It is also a call the
  // arm stops paying, which makes a positive delta a cost reduction rather than a trade.
  ['select-cross-pooled', 'select-cross-pooled-vote'],
  // One lever: whether the selector is told which candidates returned the same rows, on a pool
  // where 24.8% of the cases have more than one distinct result. The fact is not recoverable
  // from three truncated previews, which is what makes it information rather than emphasis.
  ['select-cross-pooled', 'select-cross-pooled-agree'],
  // One lever: the same pool, the same one call, and a different answer format — an index or a
  // statement. The pair is what prices "can the model write the correction" against "can it pick
  // it", and neither side of it generates a candidate of its own.
  ['select-cross-pooled', 'select-cross-pooled-reconcile'],
  // One lever, and the second time this project has had to state one as a policy rather than as a
  // prompt: the same statement, the same single call, and a different rule for what a reply is
  // worth. The pair prices the statements nobody wrote, because the arm that adopts every reply
  // spends its call on 514 paraphrases and cannot say what the 86 corrections came to.
  ['select-cross-pooled-reconcile', 'select-cross-pooled-reconcile-novel'],
  // One lever: the same candidates and the same selector, told which of them returned the same
  // rows. The fact a 2+1 pool turns on is the one fact the selector could not compute from two
  // truncated previews, and the pair prices the information rather than a rewrite.
  ['select-mixed', 'select-mixed+agree'],
  ['select-cross', 'select-cross-agree'],
  // One lever: who chooses among the same four-or-three candidates — a call that reads them, or
  // a rule that ranks them. The rule arm is the derivation from the parent's own artifact turned
  // into a run, so this pair is also the test of the offline device.
  ['select-mixed', 'select-mixed-rule'],
  // One lever: the same gated pool, and a different question to the same judge — one ranking of
  // three candidates, or two comparisons of two. The delta is the shape of the question, priced on
  // the population where the gate actually spends.
  ['select-mixed-gated', 'select-mixed-gated-pair'],
  // One lever: the same gate and the same one call, with the reply a statement instead of a choice.
  ['select-mixed-gated', 'select-mixed-gated-reconcile'],
  // One lever: what the arm does with a reply that restates a candidate — adopt the paraphrase, or
  // hand it back to the vote. Same prompt, same call, same pool.
  ['select-mixed-gated-reconcile', 'select-mixed-gated-reconcile-novel'],
  // One lever: the same three candidates, the same free rule, one more candidate bought from a
  // source that differs in knowledge. The dev split already showed what a fourth candidate does to
  // the *ceiling* (+2.22pp, p < 0.0001) and what the paid selector did to the gain (−3.50pp of
  // conversion); neither number is a prediction for a rule that ranks the pool.
  ['select-mixed-rule', 'select-mixed-rule-rows'],
  // The same purchase from the source that differs in grammar, at the same price. Read against the
  // parent it is a second conversion test; read against the arm above it, it is a comparison of two
  // kinds of difference rather than of two prompts.
  ['select-mixed-rule', 'select-mixed-rule-intent'],
  // One lever: the same candidates and selector, with an empty result treated as a
  // failure — dropped before the vote and retried once when nothing survives.
  ['select-mixed', 'select-mixed+empty'],
  // One lever: the words of the extra turn, at the same cost on the same cases.
  ['select-mixed+empty-blind', 'select-mixed+empty'],
  // One lever: the same extra turn on the same cases, carrying the values the columns hold
  // instead of a list of causes. The lookup itself is free, so the delta prices information.
  ['select-mixed+empty', 'select-mixed+values'],
  ['select', 'select5'],
  ['inline+evidence', 'values'],
  ['inline+evidence', 'plan'],
  // `8u` is one lever from `plan`, not from the shipped arm: the prompt, the call count and the
  // card are the same, and only the author of the plan moves. A pair against `inline+evidence`
  // would change two levers at once and could not say which one the delta belonged to — the
  // shipping criterion (beat both parents) is a reading of the artifact, not an ablation pair.
  ['plan', 'inline+evidence+plan-cross'],
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
   * Prompt tokens the endpoint served from its prefix cache, when it reported them.
   *
   * Absent rather than zero on an endpoint that says nothing about caching: those are different
   * facts, and only one of them is a measurement of a prompt that missed.
   */
  readonly cached?: number;
  /**
   * Completion tokens the endpoint spent deliberating, when it reported them.
   *
   * Already inside `completion`, so this is a decomposition of the bill rather than an addition to
   * it. It is the only direct evidence the artifact can hold that a request reached a model that
   * thinks: the response's `model` field names the serving deployment (`deepseek-flash` answered
   * both aliases here), so it cannot say which model ran, and completion tokens alone cannot tell
   * "wrote 594 tokens of SQL" from "thought for 540 and wrote 54".
   */
  readonly reasoning?: number;
  /**
   * The same cost split by what each call was for.
   *
   * Absent on an artifact written before the meter split it. Present, it sums to the fields
   * above exactly, because both are written at the same point rather than recounted later.
   */
  readonly byPurpose?: Readonly<Record<string, PurposeCost>>;
  /**
   * The models that actually answered this case, as the endpoint named them.
   *
   * The request carried an alias. An alias outlives the base model behind it — `deepseek-chat`
   * named one set of weights in June 2026 and another in November — so an artifact that records
   * only what it asked for cannot distinguish a re-run from a re-run on different weights. Sorted
   * and de-duplicated per case, because the question a reader has is "did this case see one base
   * or two", and the count per model belongs to the arm rather than to the case.
   */
  readonly served?: readonly string[];
}

/** One kind of call: what those calls cost this case. */
export interface PurposeCost {
  readonly calls: number;
  readonly prompt: number;
  readonly completion: number;
  readonly chars: number;
  readonly unbilled: number;
  /** The share of `completion` the endpoint said it spent thinking, when it said anything. */
  readonly reasoning?: number;
}

export interface CaseRun extends CaseOutcome {
  readonly predicted: string;
  /**
   * The judge's verdict, on a case that produced a result set to judge.
   *
   * Absent on a case that never got that far — a model timeout, a guard refusal, an engine
   * error. Those five branches used to write `'values'`, and the arm counter worked around it
   * with `&& run.error === undefined`; every other reader inherited the lie, so 94 timeouts in
   * the `S1` run were counted as 94 answers with the right shape and the wrong numbers. `values`
   * is what `judgeOfficial` returns after comparing two result sets, and a case with no result
   * set has no verdict to report.
   */
  readonly reason?: MatchReason;
  readonly strict: boolean;
  /** Share of samples that agreed with the answer the arm returned. */
  readonly agreement?: number;
  /** True when the selector returned a usable index; absent for the modal arm. On a reconcile arm
   * it means the reply carried a statement the engine ran, and `reconcile.adopted` says whether the
   * arm scored it — a restatement handed back by policy is a usable reply the arm declined. */
  readonly selectedByModel?: boolean;
  /**
   * The free decision, on an arm that made one.
   *
   * `index` is 0-based in the order the candidates were offered, `eligible` is how many of them
   * returned rows and could therefore be ranked, and `emptyPool` records the one set where the
   * rule had nothing to prefer — every candidate empty, which on a corpus whose answers are never
   * empty is a wrong set and on one whose answers sometimes are is the only correct choice. The
   * field is here rather than derived from the score because a rule that picks by accident and a
   * rule that picks by construction are the same accuracy and different mechanisms.
   */
  readonly selectedByRule?: { readonly rule: SelectionRule; readonly index: number; readonly eligible: number; readonly emptyPool: boolean };
  /**
   * Why the adjudicating call did not happen, on the cases where it did not.
   *
   * The selector used to be the one call in the vote branch with no catch around it: a refusal
   * from the endpoint escaped to the per-case wrapper, which returns a row with no candidate
   * record at all. That row says nothing about what the pool held — and `41410112996` fired the
   * shared-pool assertion on three such cases, reading "the selector's call failed" as "this arm
   * generated its own candidates". The two are opposite diagnoses, so the case is now scored by
   * the vote it already had and the failure is recorded here instead of erasing the evidence.
   */
  readonly selectionFailed?: 'llm' | 'truncated' | 'harness';
  /**
   * The same, for the empty-result turn: a rewrite that never arrived is a lever that did not
   * run, not a case without a candidate set.
   */
  readonly retryFailed?: 'llm' | 'truncated' | 'harness';
  /**
   * What the value lookup found on a zero-row case, and what it settled without a call.
   *
   * `queries` is the engine work (no model call), `literalGaps` the literals the columns do not
   * store as written, and `grounded`/`adoptedFree` the ones the deterministic case repair fixed
   * before the retry turn was spent. A case with `adoptedFree` is a case this lever answered for
   * free, and it is recorded per case so the reading can separate the lookup's contribution from
   * the call's instead of attributing both to the arm.
   */
  readonly emptyProbe?: { readonly queries: number; readonly literalGaps: number; readonly grounded: boolean; readonly adoptedFree: boolean };
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
   * Parameters the endpoint dropped on this case, and how many calls carried each.
   *
   * A reasoning endpoint accepts `temperature` and ignores it. The request is not wrong and the
   * answer is not an error, so nothing else in this artifact would show that the arm did not
   * sample at the temperature it printed. Absent when nothing was dropped, which is the state of
   * every arm run on the chat model.
   */
  readonly samplingOmitted?: Readonly<Record<string, number>>;
  /**
   * Which decomposition the returned statement came from, on a mixed arm.
   *
   * Three candidates at the same price can hide a generator that never wins, and a
   * generator that never wins is a call that should not be in the set.
   */
  readonly winnerSource?: string;
  /**
   * What the audit turn found and did, on the arm that spends the call.
   *
   * `named` is the reach and `rewritten` the yield: an audit that names nothing on most cases
   * says the model believes the statement is complete, which is a finding about where the
   * missing filter is decided, not a mechanism that failed to run.
   */
  readonly audit?: { readonly fired: boolean; readonly named: number; readonly rewritten: boolean };
  /**
   * How many literals the data settled before the statement ran.
   *
   * `substitutions` is the reach of the rewrite and `refused` is what it could not settle — a value
   * the column does not hold, two spellings of it, or a column the harness could not read. An arm
   * that declares the lever and reports zero substitutions on every case is an arm whose wiring
   * never arrived, which is the defect `emptyRetry` shipped with for one round.
   */
  readonly grounding?: { readonly substitutions: number; readonly refused: number };
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
   *
   * On an arm that verifies a bought opinion (`dissentVerify`), the set is four and the selector
   * was shown three: the fourth entry is the candidate the conditional call paid for, and it is
   * here because the ceiling has to describe the set the arm held rather than the prompt it read.
   *
   * `sql` and `fingerprint` are what turn this from a verdict into a *replayable* one: a
   * fingerprint equal to another candidate's means the two result sets are the same under the
   * benchmark's own judge (`resultKey`), so a rule that reads agreement can be scored from the
   * file instead of from a new run. `sqlClipped` says the recorded text is truncated and cannot
   * be re-executed as it stands.
   */
  readonly candidates?: readonly {
    readonly source: string;
    readonly correct: boolean;
    readonly sql?: string;
    readonly fingerprint?: string;
    readonly sqlClipped?: boolean;
  }[];
  /**
   * The shape of the first reply this arm's prompt produced on this case.
   *
   * Recorded per case rather than per arm because the aggregation is the report's job and the
   * reading is the case's: a profile built here would be a second definition of the same
   * concept, and the arm-level field below is derived from these in one place.
   *
   * The *first* reply, for a sampling arm, is the only one the prompt alone produced — the
   * later draws are the same prompt at a non-zero temperature, and folding them in would make
   * a three-sample arm's profile look more stable than its first call is.
   */
  readonly shape?: ReplyShape;
  /**
   * The endpoint stopped at the answer cap while the statement still parsed.
   *
   * The one flag that separates "this arm wrote a shorter statement" from "this arm's endpoint
   * cut it off": with a cap now sent on every request, a difference between two arms can be a
   * difference between two caps, and without this column that difference would be read as a
   * difference in the model.
   */
  readonly truncated?: boolean;
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
    /** Columns the six-column floor and the declared keys kept beyond the names (dense only). */
    readonly restored?: number;
  };
  /**
   * How many columns of this case's card carried stored values.
   *
   * Recorded only on arms that declare a sampler, so its absence means "no block" rather than
   * "no block measured". The arm that narrows the block needs it per case: on a statement with no
   * condition the block is empty by construction, and a run-wide count cannot separate that case
   * from a rule that selected nothing on every case — the two are the same number and opposite
   * findings, which is D56 in its counting form.
   */
  readonly sampleBlock?: { readonly columns: number };
  /**
   * What the field rule removed from this case's card, on the arm that keeps only the gold's fields.
   *
   * Per case rather than per arm because the two failures the guard has to separate are both
   * run-wide: a rule that removed nothing on any case (its parent renamed) and a rule that emptied
   * the card on one case (a statement naming no table). A total cannot tell them apart.
   */
  readonly fieldBlock?: { readonly columns: number; readonly dropped: number };
  /**
   * What the intent candidate's reply was read as, on the case that drew it.
   *
   * One record per case, not a per-arm count: the refusal reasons are a distribution over a
   * corpus, and a run that hits `unsupported-function` on every date question has found the next
   * thing to add to the grammar — a fact that only exists at the case level.
   */
  readonly intent?: IntentRecord;
  /**
   * How many worked examples this case's prompt carried, on the arms that ask for them.
   *
   * Absent rather than zero on every other arm, because "no block was attached" and "the block was
   * attached with nothing in it" are the two states the guard distinguishes, and a zero on an arm
   * that never asked would be the first one wearing the second one's name.
   */
  readonly examples?: number;
  /**
   * How many of those examples the masker rewrote, on the arms that ask for it.
   *
   * The masked arm's whole claim is that the block is the same block with the schema taken out, and
   * a masker that matches nothing produces the parent's prompt at the parent's accuracy. That state
   * is invisible in every other field — the examples still arrived, the calls are the same, the
   * tokens moved by the length of one sentence — so the count is the arm's own instrument.
   */
  readonly masked?: number;
  /**
   * What the conditional fourth opinion did on this case.
   *
   * Four facts, because four different failures all read as "the extra opinion did not help":
   * `asked` (the pool agreed with itself, so the arm spent the call), `arrived` (the endpoint
   * answered *and* the engine ran the statement), `distinct` (its rows differ from the pool's
   * answer — the only state in which an extra opinion carries information rather than being a
   * fourth vote for an answer that already had three), and `adopted` (it became this case's
   * answer, which on this arm only happens under an adoption policy the arm does not hold).
   *
   * Absent on arms that buy no dissent, which is D56's shape: the field's presence is the
   * statement "this arm could have bought one", and its `asked: false` is the measurement that
   * the pool was not unanimous. A run-wide rate cannot separate "the lever fired on 74.5% of
   * cases" from "the lever fired on none and the sampling read 0", because both publish 0.745.
   */
  readonly dissent?: {
    readonly asked: boolean;
    readonly arrived: boolean;
    readonly distinct: boolean;
    readonly adopted: boolean;
    /**
     * The verification turn, on an arm that puts the bought opinion to the selector.
     *
     * `asked` is the same condition as `distinct` — it is restated rather than inferred because a
     * reader who has to derive one field from another one has to know this file, and `choseDissent`
     * is the outcome: the selector compared the pool's answer against the bought statement and
     * preferred the bought one. A verifying arm whose `asked` is zero everywhere never fired, and a
     * verifying arm whose `choseDissent` is zero everywhere bought a turn that changed nothing —
     * two different sentences, which is why both are counted.
     */
    readonly pairwise?: { readonly asked: boolean; readonly choseDissent: boolean };
  };
  /**
   * Candidates that never arrived, by reason.
   *
   * A sampling arm's ceiling is a property of its candidate set, and a candidate the
   * endpoint refused is missing from that set. Reporting only the cases where *every*
   * candidate failed hides the run where one of three was refused for all 1,532
   * questions — which reads as a lower ceiling and is an outage.
   */
  /**
   * What the reconcile turn did on this case, on the arm that asks for a statement.
   *
   * Four facts, because they separate four different failures that all look like a wrong answer:
   * `returned` (a statement came back at all), `novel` (it is not one of the candidates restated —
   * a reply that echoes a candidate is a selector with a longer prompt), `executable` (the engine
   * ran it), `adopted` (it became this case's answer). Without the split, an arm whose every reply
   * is candidate 1 copied verbatim is indistinguishable from one that reconciled and was wrong.
   */
  readonly reconcile?: { readonly returned: boolean; readonly novel: boolean; readonly executable: boolean; readonly adopted: boolean };
  /**
   * What the knockout did on this case, on an arm that compares two statements at a time.
   *
   * `comparisons` is `k - 1` by construction, so it prices the turn without the counter and is the
   * only place the price of a pairwise arm can be checked against the pool it was drawn from.
   * `unreadable` is the half that cannot be derived: a comparison whose reply carried neither `1`
   * nor `2` keeps the incumbent, so a tournament that read nothing returns the pool's own first
   * candidate and scores whatever the vote scored — a lever that did not run, published under a
   * comparison's name. The row counts it, `pairwiseFunnel` sums it, and `assertPairwiseFired`
   * refuses the arm whose every comparison came back unreadable.
   */
  readonly pairwise?: { readonly comparisons: number; readonly unreadable: number };
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
  /**
   * `truncated` is its own kind, not a flavour of `llm`.
   *
   * `llm` means the endpoint did not answer, and the repairs are a bigger deadline, a lower
   * concurrency, a working key. `truncated` means it answered and the answer budget this harness
   * named was too small — the repair is a number, and a run that reports it as an outage sends its
   * reader at the network. Measured: `deepseek-v4-pro` declared as a chat endpoint, 50 of 366 calls
   * empty at 4,096 tokens, the outage guard killed a run that had 130 calls left in it.
   */
  readonly errorKind?: 'execution' | 'guard' | 'llm' | 'truncated' | 'shape' | 'harness' | 'other';
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
/**
 * The `cached` field of a case's token record, or nothing when nobody reported one.
 *
 * A field, not a number, because an endpoint that does not report cache figures has not claimed
 * it served none: writing `cached: 0` would put "the cache never hit" into an artifact where the
 * truth is "this endpoint says nothing about caching". Exported so the branch can be tested —
 * only a live endpoint produces the other side of it, and a branch only a live endpoint reaches is
 * a branch no test covers.
 */
export function cacheFieldOf(
  primary: { readonly cachedTokens: number; readonly cachedReported: number },
  second?: { readonly cachedTokens: number; readonly cachedReported: number },
): { readonly cached?: number } {
  if (primary.cachedReported + (second?.cachedReported ?? 0) === 0) return {};
  return { cached: primary.cachedTokens + (second?.cachedTokens ?? 0) };
}

/**
 * The `reasoning` field of a case's token record, or nothing when nobody reported one.
 *
 * The same shape as `cacheFieldOf` and for the same reason: an endpoint that says nothing about
 * deliberation has not said it spent none, and `reasoning: 0` in an artifact is a measurement
 * somebody made. Summed over both meters because a cross arm can ask two endpoints, and the case's
 * cost is what both of them billed.
 */
export function reasoningFieldOf(
  primary: { readonly reasoningTokens: number; readonly reasoningReported: number },
  second?: { readonly reasoningTokens: number; readonly reasoningReported: number },
): { readonly reasoning?: number } {
  if (primary.reasoningReported + (second?.reasoningReported ?? 0) === 0) return {};
  return { reasoning: primary.reasoningTokens + (second?.reasoningTokens ?? 0) };
}

/**
 * The mean of one optional per-case figure, over the cases that carried it.
 *
 * `undefined` when nobody reported one, so "no endpoint said" never renders as zero — the same rule
 * `cacheFieldOf` and `reasoningFieldOf` follow one layer down. The narrowing happens here rather
 * than at the call site: `?? 0` inside that reduce would be a branch no run can take, because the
 * array it reads was already filtered on the field, and an unreachable branch is coverage that
 * cannot be earned back with a test.
 */
export function meanReported<T>(costs: readonly T[], pick: (cost: T) => number | undefined): number | undefined {
  const values: number[] = [];
  for (const cost of costs) {
    const value = pick(cost);
    if (value !== undefined) values.push(value);
  }
  if (values.length === 0) return undefined;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

/**
 * How much of the completion bill was deliberation, over one population.
 *
 * The two columns it replaces could not answer this. `completion` is averaged over every case and
 * `reasoning` only over the cases whose endpoint reported a counter, so the printed pair reads
 * `completion 1,650, reasoning 1,691` on a run whose true share is 94% — a ratio above 100%, which
 * is not a rounding artefact but a division between two denominators. Measured on
 * `43343813778` (`deepseek-v4-pro`, reasoning declaration, 496 cases, 40 with no answer): the arm
 * row said 1650 and 1691, and summed over the cases that reported both counters, completion came to
 * 818,438 against 771,295 of deliberation — 94.2%. Both sums are the same population; the two means
 * were not. Those three figures hold each other up: 818,438 over the 496 scored cases is the row's
 * 1650, and the ratio is the 94.2% the row could not state.
 *
 * So the share is computed here, where both sums are over the same cases, and it carries its own
 * count. Absent rather than zero when nothing reported: a chat endpoint has not measured a share
 * of nothing.
 */
export function thinkingShare(
  costs: readonly { readonly completion: number; readonly reasoning?: number }[],
): { readonly share: number; readonly cases: number } | undefined {
  let completion = 0;
  let reasoning = 0;
  let cases = 0;
  for (const cost of costs) {
    if (cost.reasoning === undefined) continue;
    completion += cost.completion;
    reasoning += cost.reasoning;
    cases += 1;
  }
  if (cases === 0 || completion === 0) return undefined;
  return { share: reasoning / completion, cases };
}

export function mergePurposes(
  first: ReadonlyMap<string, PurposeUsage>,
  second?: ReadonlyMap<string, PurposeUsage>,
): Readonly<Record<string, PurposeCost>> {
  const total: Record<
    string,
    { calls: number; prompt: number; completion: number; chars: number; unbilled: number; cached: number; cachedReported: number; reasoning: number; reasoningReported: number }
  > = {};
  for (const source of second === undefined ? [first] : [first, second]) {
    for (const [purpose, usage] of source) {
      const slot = (total[purpose] ??= {
        calls: 0,
        prompt: 0,
        completion: 0,
        chars: 0,
        unbilled: 0,
        cached: 0,
        cachedReported: 0,
        reasoning: 0,
        reasoningReported: 0,
      });
      slot.calls += usage.calls;
      slot.prompt += usage.promptTokens;
      slot.completion += usage.completionTokens;
      slot.chars += usage.chars;
      slot.unbilled += usage.unbilled;
      slot.cached += usage.cachedTokens;
      slot.cachedReported += usage.cachedReported;
      slot.reasoning += usage.reasoningTokens;
      slot.reasoningReported += usage.reasoningReported;
    }
  }
  // `cached` is written only when some answer reported it, and this is the one place that decides.
  // A field that appeared as zero on every run would be read as "the cache never helped", which
  // is a claim no endpoint made; an absent field says the run did not measure it.
  return Object.fromEntries(
    Object.entries(total).map(([purpose, slot]) => [
      purpose,
      {
        calls: slot.calls,
        prompt: slot.prompt,
        completion: slot.completion,
        chars: slot.chars,
        unbilled: slot.unbilled,
        ...(slot.cachedReported === 0 ? {} : { cached: slot.cached }),
        ...(slot.reasoningReported === 0 ? {} : { reasoning: slot.reasoning }),
      },
    ]),
  );
}

export interface ArmReportRow {
  readonly arm: string;
  readonly total: number;
  /**
   * What the grounding rewrite reached, on the arm that carries it.
   *
   * `substitutions` is how many literals the data settled and `refused` how many it had an opinion
   * about but could not settle. The second number is what stops the first from being read as a
   * yield: a rewrite that fires nowhere because every column read failed is not a corpus that
   * spelled everything right.
   */
  readonly grounding?: { readonly substitutions: number; readonly refused: number; readonly rewritten: number; readonly share: number };
  /**
   * The arm whose candidates this arm read instead of generating any.
   *
   * Present only on a pooled arm, and the one field that makes its row readable: a four-call
   * parent and a one-call arm on the same pool are compared exactly as their rows say, and a
   * reader who did not know the candidates were shared would read the call column as a saving
   * rather than as the instrument it is.
   */
  readonly pool?: string;
  /**
   * How much of the pool this arm could verify, and how much of it it could not.
   *
   * `unrecorded` was documented as an unreachable state: once the adjudication and the empty-result
   * turn were caught, a case with no candidate record could not exist, so a "verified on N of M"
   * line would have described a state the harness could not reach. `41430569500` found the case that
   * can: the *source* arm produced no candidates at all, so the pooled arm had no pool to read and
   * wrote the source's reason instead (I-80). That is a gap in the sample rather than a bug, and the
   * only thing that separates the two for a reader is the count — D56: a missing case has to be
   * counted and has to be allowed to exist.
   *
   * Absent below the verification floor, where the number would describe a sample too small to be
   * checked rather than a pool that was not shared.
   */
  readonly poolRead?: { readonly shared: number; readonly unrecorded: number; readonly cases: number };
  /**
   * What the decision cost this arm, case by case, on every arm whose selector is the model.
   *
   * `asked` is the number of cases that reached a decision and `priced` the number of those that
   * spent a counted call. The pair exists because a mean cannot answer the question the gate asks:
   * on a pooled arm the rule that prices a generating arm — more calls than samples, since the
   * selector is one call on top of the candidates — says the opposite of the truth, because a pooled
   * arm draws nothing and one call per case *is* its bill (`41440646002` was refused for reporting
   * exactly that on four arms: I-81). And on either shape, a case that fails before the selector
   * lowers `calls.mean` for a legitimate reason, so `0.995` and `1.000` are the same number to a
   * reader and opposite facts to an auditor.
   *
   * Published for every arm that decides with the model rather than only for pooled ones, because
   * the invariant is the same in both shapes: a decision that ran spends one call, so
   * `priced === asked` is what a correctly priced arm reports and `priced < asked` is a selector
   * missing from the bill.
   */
  readonly spend?: { readonly asked: number; readonly priced: number };
  /**
   * What the free rule decided, on the arm that lets it decide.
   *
   * The counterpart of `spend` for a selector that costs nothing, and it exists for the same
   * reason: on a rule arm the accuracy alone cannot say whether the lever ran. `eligible` is the
   * summed candidate count the rule could rank and `emptyPool` the cases where it could rank
   * none, so an arm whose rule silently fell back to the first candidate on every case is a
   * reading no accuracy can distinguish from a rule that chose.
   */
  readonly selectorRule?: {
    readonly rule: SelectionRule;
    readonly decided: number;
    readonly eligible: number;
    readonly emptyPool: number;
  };
  /**
   * What the reconcile turn did across the arm's cases, on the arm that asks for a statement.
   *
   * The `novel` column is the one that decides whether the lever ran: an arm whose replies restate
   * a candidate on every case is a selector with a longer prompt, and publishing its accuracy as a
   * reconcile reading would attribute a choice to a correction nobody wrote.
   *
   * `policy` travels with the counts because the relationship between `executable` and `adopted`
   * depends on it — equal under `'always'`, nested under `'novel'` — and a reader who has only the
   * numbers cannot tell a policy at work from a funnel that counted something twice. The gate reads
   * it for the same reason: a row whose rule depends on the arm's name would be a rule a renamed arm
   * escapes. This is the field `emptyRetry.mode` already carries for the same class of reason.
   */
  readonly reconcile?: {
    readonly policy: 'always' | 'novel';
    readonly asked: number;
    readonly returned: number;
    readonly novel: number;
    readonly executable: number;
    readonly adopted: number;
  };
  readonly decomposition?: { readonly asked: number; readonly fired: number; readonly share: number; readonly meanSteps: number };
  /**
   * What the knockout spent, on the arm that compares two statements at a time.
   *
   * Published as the arm's own funnel rather than folded into `spend`, because the three numbers
   * answer three different questions: `asked` is how many cases reached the tournament (a gated arm
   * spends here only where the pool disagreed), `comparisons` is the bill and has a closed form
   * (`k - 1` per case), and `unreadable` is the share of that bill which bought nothing. A pairwise
   * arm without this row is a call count nothing can attribute to a comparison.
   */
  readonly pairwise?: { readonly asked: number; readonly comparisons: number; readonly unreadable: number };
  readonly candidateRecall?: number;
  readonly emptyRetry?: { readonly mode: string; readonly dropped: number; readonly fired: number; readonly recovered: number };
  /**
   * The audit turn's reach and yield, plus what it cost in calls.
   *
   * `named` is summed rather than averaged: "3.1 conditions named per case" hides whether the
   * arm named three on a tenth of the cases or one on a third, and the second is the shape that
   * suggests the trigger is half-right.
   */
  readonly audit?: { readonly fired: number; readonly named: number; readonly rewritten: number; readonly extraCallsPerCase: number };
  /**
   * What the value block carried, on the arm that declares a sampler.
   *
   * `cases` is the denominator, `withValues` the cases the rule reached and `empty` the cases it
   * did not — a statement that filters on nothing has no column to show. The arm that narrows the
   * block to the filtered columns is the reason this is a funnel and not a total: its whole claim
   * is that a smaller block buys the same information, and the ratio is that claim.
   */
  readonly sampleBlock?: {
    readonly cases: number;
    readonly withValues: number;
    readonly columns: number;
    readonly empty: number;
  };
  /**
   * What the field rule kept, on the arm whose card is the fields its gold names.
   *
   * The ratio is the lever: an arm that keeps 98% of the columns and publishes a delta is publishing
   * a delta about nothing. `emptied` is the D56 count on this rule — the cases it left with no column
   * at all cannot answer the question, and a wrong answer is a different finding.
   */
  readonly fieldBlock?: {
    readonly cases: number;
    readonly kept: number;
    readonly dropped: number;
    readonly emptied: number;
  };
  /**
   * What the worked examples reached, on the arms that ask for them.
   *
   * `cases` is the denominator, `blocks` the cases that carried at least one example and `examples`
   * the width of what arrived. Published rather than assumed because the block is retrieved per
   * question: an arm whose neighbours arrived on a third of the split is a blend of two prompts, and
   * its accuracy is a number about neither.
   */
  readonly demonstrations?: {
    readonly cases: number;
    readonly blocks: number;
    readonly examples: number;
    /** How many of those examples the masker rewrote. Zero on every arm that does not mask. */
    readonly rewritten: number;
  };
  /**
   * The shape of the replies this arm's prompt produced.
   *
   * The first reading that moves when a model nobody has calibrated is substituted for the one
   * this repository benchmarked, and the only one available before any result exists: a reply
   * that cannot be read is not a wrong answer, it is an unanswered call, and the profile says
   * which reader stopped working.
   */
  readonly format?: FormatProfile;
  /**
   * What the arm spent per case, and — when the meter split it — how much of that each kind of
   * call was. The split is what turns "the selector should earn its tokens" into a column.
   */
  readonly tokens?: {
    readonly prompt: number;
    readonly completion: number;
    readonly chars: number;
    readonly unbilled: number;
    /**
     * Prompt tokens the endpoint served from its prefix cache.
     *
     * Absent when no answer reported the field, which is the honest spelling of "not measured":
     * the meter cannot distinguish a cache that never hit from an endpoint that never said.
     */
    readonly cached?: number;
    /**
     * Completion tokens the endpoint said it spent deliberating, as `CaseTokens.reasoning` defines
     * that figure — averaged over the cases that reported one.
     *
     * Absent, rather than zero, on a chat endpoint and on any endpoint that reports no reasoning
     * counter. That distinction is the point of the field: every reading published before this
     * column existed came from an endpoint that said nothing, and `0` would have claimed the
     * deliberation had been measured and found empty.
     */
    readonly reasoning?: number;
    /**
     * The same fact as a ratio over the cases that reported both numbers.
     *
     * Not `reasoning / completion` from the two fields above: those are averages over two
     * populations — a case that answered without a usage block counts in neither, and an endpoint
     * that reports completion on every answer but reasoning on three quarters of them makes the
     * two denominators different. Dividing them once produced a share of 102% on an arm whose
     * deliberation was 94% of its output. `cases` is carried alongside so a reader can see how
     * many cases the ratio actually rests on. See `thinkingShare`.
     */
    readonly thinking?: { readonly share: number; readonly cases: number };
    readonly byPurpose?: Readonly<
      Record<
        string,
        {
          readonly calls: number;
          readonly prompt: number;
          readonly completion: number;
          readonly chars: number;
          readonly cached?: number;
          readonly reasoning?: number;
        }
      >
    >;
    /** The bases that answered these cases, as the endpoint named them. See `CaseTokens.served`. */
    readonly served?: readonly string[];
  };
  /**
   * How many cases each base model served.
   *
   * The settings record what was asked for; this records what answered. They differ whenever an
   * endpoint re-points an alias, which is how a re-run on new weights can be mistaken for a
   * re-run of the same experiment. Absent when no answer named a model.
   */
  readonly servedModels?: Readonly<Record<string, number>>;
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

/**
 * A column rule with no sampler under it is a declaration nothing reads.
 *
 * `samples` decides whether stored values are shown; `sampleColumns` decides which columns carry
 * them. The second without the first sends the plain card and reports a delta of zero for a lever
 * that never existed — the same shape as a samples arm with an empty block, one field further
 * along, and the same rule: refuse it at the declaration rather than after a run.
 */
/**
 * One field-selection lever per arm, and a reason for the rule.
 *
 * `prune` decides tables from the shipped linker's seeds, `columnSelect` asks the model, and
 * `cardColumns: 'gold'` reads the answer. Each produces a card, and an arm that declared two of them
 * would report the delta of whichever ran last — a number that looks like a measurement of one lever
 * and is a measurement of an order of operations.
 */
export function assertCardRule(arm: Pick<Arm, 'name' | 'cardColumns' | 'prune' | 'columnSelect'>): void {
  if (arm.cardColumns === undefined) return;
  const rivals = [arm.prune === undefined ? undefined : 'prune', arm.columnSelect === undefined ? undefined : 'columnSelect'].filter(
    (name): name is string => name !== undefined,
  );
  if (rivals.length > 0) {
    throw new Error(`arm ${arm.name} keeps only the gold's fields and also declares ${rivals.join(' and ')}, so its card would be decided twice`);
  }
}

export function assertSampleRule(arm: Pick<Arm, 'name' | 'samples' | 'sampleColumns'>): void {
  if (arm.sampleColumns === undefined || arm.samples !== undefined) return;
  throw new Error(
    `arm ${arm.name} narrows which columns carry stored values and declares no sampler, so the rule would never run`,
  );
}

/**
 * A mask on a prompt that carries no examples is a name for the parent arm.
 *
 * The masker only ever sees a statement from a demonstration block, so an arm that declares
 * `masked` without `demonstrations` sends the prompt it started from and reports the difference as
 * a reading about masking. Refused at the declaration, next to `assertSampleRule` and for its
 * reason: the alternative is a paid run that measures nothing.
 */
export function assertMaskingRule(arm: Pick<Arm, 'name' | 'masked' | 'demonstrations'>): void {
  if (arm.masked !== true || arm.demonstrations === true) return;
  throw new Error(
    `arm ${arm.name} masks the names in its worked examples and carries none, so the mask would never run`,
  );
}

/**
 * A temperature on an arm that draws once is a single draw with noise, not a lever.
 *
 * The field exists to move two or more draws apart, so an arm that declares it without a sample
 * count would send one request at that temperature and report the difference as a reading about
 * sampling. The range is the endpoint's: nothing outside [0, 2] is accepted, and a request outside
 * it is refused by the endpoint rather than by us — which would spend the run to learn a number
 * the declaration already had.
 *
 * Zero is legal and it means something specific: *repeat the same request*, which is the control a
 * sampling arm is read against rather than a sampling arm. It is the coordinate every multi-prompt
 * arm in this catalogue was silently measured at before the `temperature` override existed, so an
 * arm that declares it is the historical reading made reproducible instead of a claim about noise.
 *
 * Refused at the declaration, next to `assertSampleRule` and for its reason: the alternative is a
 * paid run that measures nothing.
 */
export function assertTemperature(arm: Pick<Arm, 'name' | 'temperature' | 'vote'>): void {
  if (arm.temperature === undefined) return;
  if (!Number.isFinite(arm.temperature) || arm.temperature < 0 || arm.temperature > 2) {
    throw new Error(`arm ${arm.name} draws at temperature ${String(arm.temperature)}, which is outside the range an endpoint accepts [0, 2]`);
  }
  if ((arm.vote ?? 1) < 2) {
    throw new Error(`arm ${arm.name} declares a temperature but draws ${String(arm.vote ?? 1)} candidate, so nothing would be drawn apart`);
  }
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
export function escapeKind(error: unknown): 'llm' | 'truncated' | 'harness' {
  const code = (error as { code?: string } | undefined)?.code;
  if (typeof code !== 'string' || !code.startsWith('NL2C_E_LLM')) return 'harness';
  // A call that ran out of budget escaped the per-sample catch exactly like an outage did, and
  // filing it under `llm` let a run that never had room to answer pass the outage guard while
  // reporting itself as an endpoint problem. Third kind, third sentence.
  return code === 'NL2C_E_LLM_TRUNCATED' ? 'truncated' : 'llm';
}

export function assertArmProducedResults(armName: string, runs: readonly { errorKind?: string; error?: string }[]): void {
  if (runs.length === 0) return;
  const allFailed = runs.every((run) => run.errorKind === 'llm');
  if (allFailed) {
    const first = runs.find((run) => run.error !== undefined)?.error ?? 'no error text';
    throw new Error(
      `arm ${armName}: every case failed before reaching the database — the model provider refused all ${String(runs.length)} calls ` +
        `(first error: ${first}). This is not an accuracy of zero; it is a run that did not happen.`,
    );
  }
  // The same verdict for the other way a run produces no answer at all, with the other repair:
  // an arm cut at the budget on every case did not measure the model either, and reporting it as
  // "0%" would send its reader at the prompt.
  if (!runs.every((run) => run.errorKind === 'truncated')) return;
  const first = runs.find((run) => run.error !== undefined)?.error ?? 'no error text';
  throw new Error(
    `arm ${armName}: every case was cut at the answer budget and no case reached the database ` +
      `(first error: ${first}). This is not an accuracy of zero; it is a budget the endpoint spent thinking.`,
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
/**
 * The one sentence both outage verdicts print.
 *
 * Composed here because there are two of them now — the table read after the run and the reading
 * taken during it — and two descriptions of one failure is how a log comes to look like two
 * different problems. The timeout hint rides in the same sentence for the same reason: a reader who
 * sees "429" in one place and "timed out" in the other learns nothing from either.
 */
/**
 * A failure's shape, read from its own message.
 *
 * The reader of a 59% failure rate needs to know *which* fault it is, and the message already says:
 * a timeout, an HTTP status, a body that is not JSON, an endpoint that never answered. `42723786747`
 * stopped with `first error: llm call timed out` over sixteen failures when only two of the
 * twenty-eight cases that landed had taken the full deadline — the sentence named the wrong fault
 * because one message out of sixteen was all it had.
 *
 * Text rather than the error's `code` because `scoreOne` stores a message, not an object: the code
 * is already folded into `errorKind`, and this is the level below it.
 */
export function failureLabel(error: string | undefined): string {
  const text = (error ?? '').toLowerCase();
  if (text.includes('timed out')) return 'timeout';
  const status = /\breturned (\d{3})\b/u.exec(text);
  if (status !== null) return `HTTP ${String(status[1])}`;
  if (text.includes('not json')) return 'not JSON';
  if (text.includes('unreachable')) return 'unreachable';
  return 'other';
}

/**
 * How many failures of each shape, largest group first.
 *
 * A tally is the cheapest sentence that cannot be misled by its own first element, and the tie-break
 * by label keeps two runs with the same counts printing the same line.
 */
export function failureTally(errors: readonly (string | undefined)[]): string {
  const counts = new Map<string, number>();
  for (const error of errors) {
    const label = failureLabel(error);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts]
    .sort((one, two) => two[1] - one[1] || one[0].localeCompare(two[0]))
    .map(([label, count]) => `${label} × ${String(count)}`)
    .join(', ');
}

function outageSentence(failures: number, seen: number, maxShare: number, errors: readonly (string | undefined)[]): string {
  const first = errors[0] ?? 'no error text';
  const labels = errors.map((error) => failureLabel(error));
  const timeouts = labels.filter((label) => label === 'timeout').length;
  const throttled = labels.filter((label) => label === 'HTTP 429').length;
  const refused = labels.filter((label) => /^HTTP 4\d\d$/u.test(label) && label !== 'HTTP 429').length;
  const hints: string[] = [];
  // The hint is chosen from the tally, not from the first message: the two disagree exactly when a
  // run fails for two reasons, and that is when a single hint is most likely to be wrong.
  if (timeouts > 0 && timeouts === labels.length) {
    hints.push('Every failure is a timeout, so the deadline (BIRD_LLM_TIMEOUT_MS) may be shorter than the model needs.');
  }
  if (refused > 0) {
    hints.push(
      `${String(refused)} are refusals (4xx), so the endpoint rejected the request: check the model name, the key and the ` +
        'request shape (BIRD_CAPABILITIES declares what this endpoint accepts, and a wrong guess there sends a parameter it refuses).',
    );
  }
  if (throttled > 0) {
    hints.push(`${String(throttled)} are 429s, so the account is being rate limited: lower BIRD_CONCURRENCY or raise the limit.`);
  }
  return (
    `${String(failures)} of ${String(seen)} calls (${((failures / seen) * 100).toFixed(1)}%) failed at the model, ` +
    `above the ${(maxShare * 100).toFixed(0)}% this harness treats as an outage (first error: ${first}). ` +
    `Shapes: ${failureTally(errors)}.${hints.length === 0 ? '' : ` ${hints.join(' ')}`}`
  );
}

export function assertFailureRate(
  armName: string,
  runs: readonly { errorKind?: string; error?: string }[],
  maxShare = 0.1,
): void {
  if (runs.length === 0) return;
  // Checked before the outage, and never folded into it. An arm whose replies are cut at the
  // answer budget still answers some questions, so its score looks like a score; the repairs are
  // also opposite — an outage is fixed by waiting, a truncation by naming a bigger number.
  const cut = runs.filter((run) => run.errorKind === 'truncated');
  if (cut.length / runs.length > maxShare) {
    throw new Error(
      `arm ${armName}: ${String(cut.length)} of ${String(runs.length)} calls ` +
        `(${((cut.length / runs.length) * 100).toFixed(1)}%) were cut at the answer budget, above the ` +
        `${(maxShare * 100).toFixed(0)}% this harness treats as a measurement of the budget rather than of the model ` +
        `(first error: ${cut[0]?.error ?? 'no error text'}). Every one of these calls was answered and ran out of room, ` +
        'so the accuracy would be a function of a number this harness named. Declare the family the endpoint actually is, ' +
        'or raise its answerBudgetCeiling in BIRD_CAPABILITIES.',
    );
  }
  const failures = runs.filter((run) => run.errorKind === 'llm');
  const share = failures.length / runs.length;
  if (share <= maxShare) return;
  // The first message, not a summary of them: "65% failed" without the reason sends the
  // reader to the workflow file when the answer is in the provider's reply.
  throw new Error(
    `arm ${armName}: ${outageSentence(failures.length, runs.length, maxShare, failures.map((run) => run.error))} ` +
      'The accuracy would be a function of how busy the endpoint was.',
  );
}

/**
 * Whether the outage verdict is already sealed, whatever the remaining calls do.
 *
 * `assertFailureRate` refuses a table in which more than a tenth of the cases failed at the model.
 * Failures only accumulate, so once the count exceeds a tenth of the *whole split* the run cannot
 * end below the threshold: the verdict is decided, and every further call is spent on a table that
 * will not be published.
 *
 * Stated as arithmetic rather than as a heuristic on purpose. A "grace period" — ignore the first
 * N calls — is a judgement about which refusals are transient, and a guard is the wrong place for
 * one: this rule cannot refuse a run the table guard would have accepted, which is the only
 * property the early verdict has to preserve.
 */
export function outageDecided(failures: number, total: number, maxShare = 0.1): boolean {
  if (!Number.isFinite(total) || total <= 0) return false;
  return failures > maxShare * total;
}

/**
 * The failure-share verdict, taken while the run can still stop spending.
 *
 * `assertFailureRate` reads a table, and a table only exists after every case has been asked: the
 * guard is correct and arrives after the budget is gone. `glm-4.6` answered 429 to 416 of 496
 * calls, and its first forty rows said so. This is the same tenth, counted as the cases land.
 */
export interface FailureBreaker {
  /** Record one case's outcome. Returns the verdict when this case is the one that confirms it. */
  observe(run: { errorKind?: string; error?: string }): string | null;
  /** The verdict once taken, or `null`. Read by the pool so the slots behind a stop make no call. */
  verdict(): string | null;
}

export function createFailureBreaker(armName: string, total: number, maxShare = 0.1): FailureBreaker {
  let seen = 0;
  let failures = 0;
  let cuts = 0;
  const errors: (string | undefined)[] = [];
  const cutErrors: (string | undefined)[] = [];
  let stopped: string | null = null;
  return {
    observe(run) {
      seen += 1;
      // Two faults can end a run early, and they are counted apart. `execution`, `guard`, `shape`
      // and a harness bug are output quality or this file's own defect; stopping on them would
      // report "the model writes bad SQL" as "the endpoint is down", which is the confusion
      // `escapeKind` exists to prevent.
      if (run.errorKind === 'truncated') {
        cuts += 1;
        cutErrors.push(run.error);
        if (stopped !== null) return null;
        if (seen >= total) return null;
        if (!outageDecided(cuts, total, maxShare)) return null;
        // The same tenth, the opposite repair. A cut reply is an answered call that ran out of
        // room, so the run is stoppable for the same reason an outage is: the number it would
        // print is a function of the budget. What it must not say is "the endpoint is down".
        stopped =
          `arm ${armName}: stopped after ${String(seen)} of ${String(total)} calls — ` +
          `${String(cuts)} of ${String(seen)} calls (${((cuts / seen) * 100).toFixed(1)}%) were cut at the answer budget, ` +
          `above the ${(maxShare * 100).toFixed(0)}% this harness treats as a measurement of the budget ` +
          `(first error: ${cutErrors[0] ?? 'no error text'}, budgets tried: see the message). ` +
          'Declare the family the endpoint actually is, or raise its answerBudgetCeiling. ' +
          `The remaining ${String(Math.max(0, total - seen))} calls were not spent.`;
        return stopped;
      }
      if (run.errorKind !== 'llm') return null;
      failures += 1;
      errors.push(run.error);
      if (stopped !== null) return null;
      // Nothing left to save on the last case, and the guards that read the finished table have a
      // better sentence for a run that never reached the database: `assertArmProducedResults` says
      // "this is not an accuracy of zero", which is the reading a one-case split needs.
      if (seen >= total) return null;
      if (!outageDecided(failures, total, maxShare)) return null;
      stopped =
        `arm ${armName}: stopped after ${String(seen)} of ${String(total)} calls — ` +
        `${outageSentence(failures, seen, maxShare, errors)} ` +
        `The remaining ${String(Math.max(0, total - seen))} calls were not spent.`;
      return stopped;
    },
    verdict() {
      return stopped;
    },
  };
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
 * The run's own clock, because the job's clock is not a report.
 *
 * `42666720439` was killed by its 300-minute job cap at `cancelled`, having spent five hours and
 * published nothing: not one line of progress, and an artifact of 2,083 bytes. Everything the run
 * had learned at minute 299 — how many cases it had done, what each one cost — died with it. The
 * cap is a wall; this is a reading taken before the wall.
 *
 * The value is read rather than defaulted, because a guard that turns itself on is a guard whose
 * absence is invisible. A run without one prints `budget: none`, and that line is the finding.
 */
export function parseBudgetMs(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`BIRD_RUN_BUDGET_MS=${JSON.stringify(raw)} is not a run budget; give whole milliseconds or leave it unset`);
  }
  return value;
}

/**
 * The subset a budget can afford, at three quarters of itself.
 *
 * Three quarters rather than all of it: a run that stops at 99% of its clock has learned nothing
 * about how close it came, and the next dispatch would be a second guess. A quarter of the clock is
 * headroom for the tail — and the tail is what a reasoning model has.
 *
 * Rounded down and floored at one, because a suggestion of zero is not a suggestion.
 */
/**
 * The partial run a dispatch was told to continue, or nothing.
 *
 * An empty string is `undefined` rather than a path: a workflow input that the operator cleared
 * arrives as `""`, and `readFileSync("")` fails with a message about a directory instead of about
 * the value that was wrong.
 */
export function parseResumeFrom(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function suggestedLimit(budgetMs: number, elapsedMs: number, casesDone: number): number | undefined {
  if (casesDone <= 0 || elapsedMs <= 0) return undefined;
  const perCaseMs = elapsedMs / casesDone;
  return Math.max(1, Math.floor((budgetMs * 0.75) / perCaseMs));
}

/**
 * Where a run that outgrew its clock leaves the cases it had already scored.
 *
 * The budget message used to be the only thing a long arm produced, and every case behind the stop
 * was spent for nothing: a 498-case arm that reached 300 had to start again at zero, and the arm
 * before it had already shown that a reasoning model cannot finish the split inside one job. This
 * file is the progress the message could not carry.
 *
 * It is not a reading. The gate refuses a partial table for the same reason it refuses a refused
 * one — a rate over the cases that happened to fit is a rate over a different population — and
 * nothing reads this file except the next dispatch of the same arm.
 */
export function partialPath(out: string): string {
  return `${out}.partial.json`;
}

/**
 * What this run told the endpoint to do with its request, as one short string.
 *
 * The four locks on a resume name the arm, the split, the model and the question set, and all four
 * can match while the *request* differs: `deepseek-v4-pro` takes `{family: 'chat'}` and
 * `{family: 'reasoning'}` under one name, and a run that changed its declaration halfway through
 * would publish a table in which half the answers were written under a 4,096-token budget and half
 * under 8,192 with sampling removed. That is not two halves of one reading; it is two readings with
 * one label. Measured motive: an acceptance run was stopped at 366 of 496 calls by a declaration
 * that was wrong, and its 366 paid cases were deliberately not resumed for exactly this reason.
 *
 * A digest rather than the record itself: the fields are the thing being compared, and the JSON
 * beside them is noise in a file whose purpose is a short refusal message. Written in a fixed field
 * order, never by iterating the object, so a field added later cannot reorder two equal records into
 * two different digests.
 */
export function declarationDigest(model: string, overrides?: Partial<ModelCapabilities>): string {
  const declared = capabilitiesOf(model, overrides);
  const canonical = JSON.stringify([
    declared.family,
    declared.sampling,
    declared.jsonMode,
    declared.maxOutputTokens,
    String(declared.answerBudgetCeiling),
    declared.thinksAloud,
    declared.thinkingSwitch,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** A partial run on disk: what produced it, over which questions, and what it finished. */
export interface PartialRun {
  readonly arm: string;
  readonly split: string;
  readonly model: string;
  /** `declarationDigest` of the request shape, so a resume cannot straddle two of them. */
  readonly declaration: string;
  /** Every question the interrupted run set out to score, so a resumed run cannot mix populations. */
  readonly questionIds: readonly number[];
  readonly cases: readonly { readonly questionId: number; readonly run: CaseRun }[];
}

/**
 * Read what a previous dispatch finished, refusing to weld two different runs together.
 *
 * A resume that trusted only the file's own arm name would graft a `deepseek-flash` arm onto a
 * `deepseek-v4-pro` reading, and the result would be an accuracy nobody could reproduce. The four
 * fields checked here are the four that decide whether a case's answer means the same thing in
 * both runs: the arm (which levers fired), the split, the model, and the exact question set.
 */
export function readPartialRun(
  path: string,
  expected: {
    readonly arm: string;
    readonly split: string;
    readonly model: string;
    readonly declaration: string;
    readonly questionIds: readonly number[];
  },
): Map<number, CaseRun> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PartialRun>;
  if (!Array.isArray(parsed.cases) || !Array.isArray(parsed.questionIds)) {
    throw new Error(`${path} is not a partial run: it carries no cases and questionIds arrays`);
  }
  const drift: string[] = [];
  if (parsed.arm !== expected.arm) drift.push(`arm ${String(parsed.arm)} != ${expected.arm}`);
  if (parsed.split !== expected.split) drift.push(`split ${String(parsed.split)} != ${expected.split}`);
  if (parsed.model !== expected.model) drift.push(`model ${String(parsed.model)} != ${expected.model}`);
  // The fifth lock, and the one no other field covers: same arm, same split, same model name, and a
  // different request. `parsed.declaration` is `undefined` on a file written before this field
  // existed, and an absent declaration is a mismatch rather than a pass — a run that cannot say
  // what it declared cannot be welded to one that can.
  if (parsed.declaration !== expected.declaration) {
    drift.push(`declaration ${String(parsed.declaration)} != ${expected.declaration}`);
  }
  const sameSet =
    parsed.questionIds.length === expected.questionIds.length &&
    parsed.questionIds.every((id, index) => id === expected.questionIds[index]);
  if (!sameSet) {
    drift.push(`${String(parsed.questionIds.length)} questions != ${String(expected.questionIds.length)}`);
  }
  if (drift.length > 0) {
    throw new Error(
      `${path} was written by a different run (${drift.join('; ')}). A case's answer means the same thing only when ` +
        'the arm, the split, the model, the request shape and the question set all match, so this file cannot be ' +
        'resumed into this run.',
    );
  }
  return new Map(parsed.cases.map((entry) => [entry.questionId, entry.run]));
}

/**
 * What a run says when its clock runs out instead of saying nothing.
 *
 * The message is the deliverable, not an apology for a missing table: the next dispatch needs a
 * sample size, and this is the only instrument that can compute one. A partial table is refused for
 * the same reason the gate refuses one — 137 of 496 cases is a different population, and a rate on
 * it is not a rate on the split. What a smaller run *can* claim is a pair against the anchor on the
 * questions both answered, which is a separate artifact and `crossPair`'s reading.
 */
export function budgetExhaustedMessage(state: {
  readonly arm: string;
  readonly budgetMs: number;
  readonly elapsedMs: number;
  readonly casesDone: number;
  readonly total: number;
  readonly concurrency: number;
  /** Where the cases that did finish were written, when the runner kept them. */
  readonly resumePath?: string;
}): string {
  const { arm, budgetMs, elapsedMs, casesDone, total, concurrency, resumePath } = state;
  const budgetS = (budgetMs / 1000).toFixed(0);
  const elapsedS = (elapsedMs / 1000).toFixed(0);
  const remaining = Math.max(0, total - casesDone);
  const head = `arm ${arm}: stopped after ${String(casesDone)} of ${String(total)} cases — the ${budgetS} s run budget ran out`;
  if (casesDone === 0) {
    // Zero cases in a whole budget is a shape, not a speed: one case makes several model calls and
    // each is bounded by the per-call deadline, so the product of the two is what to look at.
    return (
      `${head}. In ${elapsedS} s not one case finished, so there is no per-case rate to extrapolate and no BIRD_LIMIT that ` +
      'can help: a case makes several calls and each is bounded by BIRD_LLM_TIMEOUT_MS, so lower that, or the ' +
      'concurrency, before dispatching again.'
    );
  }
  const perCaseMs = elapsedMs / casesDone;
  const perCaseS = (perCaseMs / 1000).toFixed(0);
  const projectionH = ((perCaseMs * total) / 3_600_000).toFixed(1);
  const suggestion = suggestedLimit(budgetMs, elapsedMs, casesDone);
  return (
    `${head}; no call failed, the clock did. ${String(casesDone)} case(s) took ${elapsedS} s at concurrency ` +
    `${String(concurrency)} (${perCaseS} s/case), so a full split at this rate needs ${projectionH} h. Dispatch again ` +
    `with BIRD_LIMIT=${String(suggestion ?? 1)} (about ${(budgetMs * 0.75 / 1000).toFixed(0)} s of the same clock), or a ` +
    `longer budget, or a faster model. The remaining ${String(remaining)} cases were not spent.` +
    (resumePath === undefined
      ? ''
      : ` The ${String(casesDone)} that finished are in ${resumePath}; dispatch the same arm with ` +
        `BIRD_RESUME_FROM=${resumePath} to keep them.`)
  );
}

/**
 * One line per case, so a long run is watchable.
 *
 * The five-hour run printed nothing between its first case and its death. A rate is the only thing
 * that distinguishes "slow" from "stuck", and it cannot be read from a total that has not arrived:
 * the timestamps of these lines are the instrument, and the numbers beside them are what a reader
 * needs in order to stop a run that is going nowhere before the job cap does it.
 */
export function progressLine(state: {
  /** Cases finished so far. Zero is a legal state and prints `n/a` rather than dividing by it. */
  readonly index: number;
  readonly total: number;
  readonly passed: number;
  readonly elapsedMs: number;
  /** How long this case took on its own, which is where a tail is visible before it becomes a mean. */
  readonly caseMs: number;
}): string {
  const { index, total, passed, elapsedMs, caseMs } = state;
  const rate = index === 0 ? 'n/a' : `${(passed / index * 100).toFixed(1)}%`;
  const perCase = index === 0 ? 'n/a' : `${(elapsedMs / index / 1000).toFixed(1)} s/case`;
  return (
    `  [${String(index).padStart(3)}/${String(total)}] ${rate}  ${perCase}  ` +
    `case ${(caseMs / 1000).toFixed(1)} s  elapsed ${(elapsedMs / 1000).toFixed(0)} s`
  );
}

/**
 * How many cases an instrument needs before its share is a measurement.
 *
 * Every guard in this section asks a question of the form "did this mechanism fire often enough to
 * be read", and every one of them is silent below a hundred cases, where a single case is worth
 * more than a percentage point and the answer would describe the sample rather than the mechanism.
 * The number used to be written out in each signature; it is one number, so it has one name.
 */
export const MINIMUM_INSTRUMENT_SAMPLE = 100;

/**
 * A repair arm whose repair path never ran is its parent arm with a bigger budget.
 *
 * This is the same failure the retrieval arm had: a switch that is on and never fires
 * still produces a number, and the number is the parent's. With a 40% failure rate on
 * this benchmark the loop must fire; a run where it did not is broken, not efficient.
 */
export function assertRepairPathFired(
  armName: string,
  cases: readonly { attempts: number }[],
  minimumSample = MINIMUM_INSTRUMENT_SAMPLE,
): void {
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
 *   `NL2C_E_LLM_REJECTED`  the endpoint refused the request (model name, key, a field it
 *                          will not accept)                                    -> llm
 *   `NL2C_E_GUARD_REJECTED` / `NL2C_E_ENGINE_FAILED`  a statement that must not run -> engine
 *   `NL2C_E_LLM_INVALID_RESPONSE` and everything else  no usable statement         -> unparsed
 *
 * `INVALID_RESPONSE` is deliberately *not* `llm`: the endpoint answered, the answer was unusable,
 * which is output quality and not an outage. Counting it as an outage would let a prompt that
 * produces unparseable replies fail the run with "the endpoint is down". `REJECTED` is the
 * opposite case and belongs with the outage: nothing about the model's output was measured,
 * because the call never ran, and a batch that scores zero because a model name is wrong must
 * not read as a model that writes bad statements.
 */
export function classifyCandidateFailure(code: string | undefined): keyof CandidateFailures {
  if (code === 'NL2C_E_TIMEOUT' || code === 'NL2C_E_LLM_UNAVAILABLE' || code === 'NL2C_E_LLM_REJECTED') return 'llm';
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
  readonly literalGaps: number;
  readonly grounded: number;
  readonly adoptedFree: number;
  readonly probeQueries: number;
  readonly extraCallsPerCase: number;
} {
  const fired = runs.filter((run) => run.emptyRetried === true).length;
  const probes = runs.map((run) => run.emptyProbe).filter((probe) => probe !== undefined);
  return {
    dropped: runs.reduce((total, run) => total + (run.emptyDropped ?? 0), 0),
    fired,
    recovered: runs.filter((run) => run.emptyRecovered === true).length,
    // The lookup's own reach and yield, counted apart from the call's: a case adopted from the
    // grounded statement never spent a call, and folding the two into `recovered` would price a
    // free repair as if it were the fourth call.
    literalGaps: probes.reduce((total, probe) => total + probe.literalGaps, 0),
    grounded: probes.filter((probe) => probe.grounded).length,
    adoptedFree: probes.filter((probe) => probe.adoptedFree).length,
    probeQueries: probes.reduce((total, probe) => total + probe.queries, 0),
    extraCallsPerCase: Number((fired / Math.max(1, runs.length)).toFixed(4)),
  };
}

/**
 * What the reconcile turn produced, across the arm's cases.
 *
 * Four columns and not one, because the four failures behind "the arm scored 64%" are different
 * problems with different repairs: a turn that never came back (`asked` − `returned`), a turn that
 * only restated a candidate (`returned` − `novel`), a statement the engine refused
 * (`returned` − `executable`), and a statement the policy declined to score (`executable −
 * adopted`). The second column is the one that decides whether the lever is a lever at all.
 *
 * `executable − adopted` is empty on an arm that adopts every statement it can run, which is what
 * the first reconcile reading was taken with, and it is the restatement population on an arm whose
 * `reconcileAdopt` is `'novel'`. That is why the column is published as a count of its own rather
 * than derived: the same funnel then reads the same way on both policies, and a reader can tell
 * "the arm had nothing to correct" from "the arm had corrections and dropped them".
 */
export function reconcileFunnel(runs: readonly CaseRun[]): {
  readonly asked: number;
  readonly returned: number;
  readonly novel: number;
  readonly executable: number;
  readonly adopted: number;
} {
  const records = runs.map((run) => run.reconcile).filter((record) => record !== undefined);
  return {
    asked: records.length,
    returned: records.filter((record) => record.returned).length,
    novel: records.filter((record) => record.novel).length,
    executable: records.filter((record) => record.executable).length,
    adopted: records.filter((record) => record.adopted).length,
  };
}

/**
 * A reconcile arm whose every reply restates a candidate is a selector with a longer prompt.
 *
 * This is the guard the lever cannot ship without. The arm's premise is that a statement can say
 * something none of the three candidates does — an index cannot — and the ceiling says such a case
 * exists: on the cross pool the correct answer is in the set on 70.5% of cases and the arm scores
 * 64%, so 6.5pp of cases have a right candidate the decision misses. If the model never writes a
 * statement of its own, then nothing about that gap was tested and the number belongs to the
 * selector, not to reconciliation.
 *
 * The count is published whether or not it fires (`reconcile` in the row), because a share of
 * novel statements is what a reader needs to weigh the delta; the guard only refuses the case
 * where the answer is zero across a whole sample.
 *
 * The last branch is the one the policy added: an arm can write statements of its own and still
 * decide nothing with them, either because none of them ran or because every one that ran was a
 * restatement and the policy handed it back. That arm measured the vote as surely as the one whose
 * replies were all paraphrases, and it would otherwise publish a delta of zero with the date of a
 * measurement attached.
 */
export function assertReconcileFired(armName: string, runs: readonly CaseRun[], minimumSample = MINIMUM_INSTRUMENT_SAMPLE): void {
  if (runs.length < minimumSample) return;
  const funnel = reconcileFunnel(runs);
  if (funnel.asked === 0) {
    throw new Error(
      `arm ${armName}: the reconcile turn never ran across ${String(runs.length)} questions — no case reached it, so the arm measured the vote`,
    );
  }
  if (funnel.returned === 0) {
    throw new Error(
      `arm ${armName}: none of the ${String(funnel.asked)} reconcile replies carried a statement, so the turn was paid for and produced nothing to run`,
    );
  }
  if (funnel.novel === 0) {
    throw new Error(
      `arm ${armName}: all ${String(funnel.returned)} reconcile replies restated a candidate verbatim, which is a selector with a longer prompt — the lever did not run`,
    );
  }
  if (funnel.adopted === 0) {
    throw new Error(
      `arm ${armName}: ${String(funnel.novel)} of ${String(funnel.returned)} reconcile replies wrote a statement of their own and none of them was scored (${String(funnel.executable)} ran, ${String(funnel.adopted)} adopted), so the arm measured the vote`,
    );
  }
}

/**
 * What the knockout spent across the arm's cases, and how much of it came back readable.
 *
 * Two counts rather than one, because a pairwise arm has two ways to be a lever that did not run
 * and they need different repairs. `asked === 0` means no case reached the tournament — a
 * gated arm whose pool never disagreed, or a branch that returned before the comparison. Every
 * comparison unreadable means the tournament was paid for and read nothing, which is an outage of
 * the prompt or the parser wearing the arm's name. The price is published beside them
 * (`comparisons`) because it is the only number that lets a reader check the bill against the pool:
 * a knockout spends exactly `k - 1` calls, so an arm reporting three comparisons on a pool of three
 * is an arm that compared a candidate with itself.
 */
export function pairwiseFunnel(runs: readonly CaseRun[]): {
  readonly asked: number;
  readonly comparisons: number;
  readonly unreadable: number;
} {
  const records = runs.map((run) => run.pairwise).filter((record) => record !== undefined);
  return {
    asked: records.length,
    comparisons: records.reduce((total, record) => total + record.comparisons, 0),
    unreadable: records.reduce((total, record) => total + record.unreadable, 0),
  };
}

/**
 * A tournament that read nothing is the pool's own order under a comparison's name.
 *
 * The guard refuses the two states in which the arm's accuracy cannot be attributed to comparing
 * anything, and publishes the third: a tournament that read its comparisons and lost them anyway is
 * a measurement, and a measurement of zero is the finding. `MINIMUM_INSTRUMENT_SAMPLE` applies for
 * the same reason it does everywhere else here — on four questions nothing can be concluded about
 * whether a mechanism fires, so nothing is refused either.
 */
export function assertPairwiseFired(armName: string, runs: readonly CaseRun[], minimumSample = MINIMUM_INSTRUMENT_SAMPLE): void {
  if (runs.length < minimumSample) return;
  const funnel = pairwiseFunnel(runs);
  if (funnel.asked === 0) {
    throw new Error(
      `arm ${armName}: the knockout ran on none of ${String(runs.length)} questions, so the arm measured whatever chose the answer before it`,
    );
  }
  if (funnel.comparisons === 0) {
    throw new Error(
      `arm ${armName}: ${String(funnel.asked)} cases carry a comparison record with no comparison in it, so the turn was declared and never sent`,
    );
  }
  if (funnel.unreadable === funnel.comparisons) {
    throw new Error(
      `arm ${armName}: all ${String(funnel.comparisons)} comparisons came back unreadable, so the incumbent — the pool's own first candidate — became the answer on every case`,
    );
  }
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
  minimumSample = MINIMUM_INSTRUMENT_SAMPLE,
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
 * A pooled arm that did not read the pool is its parent under another name.
 *
 * The whole value of a shared pool is that the two arms read the same candidates, so the check is
 * not "did it run" but "did it read the same set": every case's ceiling must agree, and — when
 * both sides recorded them — the statements handed back must be the same ones, or the delta being
 * published is the pool's noise wearing the label of a lever. This is the
 * `assertSamplesRan`/`assertRepairPathFired` rule applied to the one instrument whose failure mode
 * is silent arithmetic rather than a missing call — a pooled arm that generated its own candidates
 * would cost four calls a case and look entirely healthy.
 *
 * The first version compared `candidateRecall` on every pooled case and read a missing record as a
 * disagreement. `41410112996` is what that cost: three of six hundred cases in the reasoning-judge
 * arm had no record at all, because the judge's call escaped and the per-case wrapper returns a row
 * without a candidate set, and the run died on a sentence that named the wrong bug — "the
 * shared-pool arm generated its own candidates" for an arm that had read the pool and then failed
 * to adjudicate it. So a case with no record on either side is not evidence of anything: it is
 * excluded from the comparison, counted, and returned, because an instrument that cannot check a
 * case has to say so rather than accuse it.
 *
 * Statements are compared as a multiset rather than in order: a shuffled arm shows the selector the
 * same set in another sequence, and a set that differs only in order is a shared pool. Order is
 * already the property `shuffle` is allowed to change.
 */
export function assertPoolShared(
  armName: string,
  pooled: readonly CaseRun[],
  source: readonly CaseRun[],
  minimumSample = MINIMUM_INSTRUMENT_SAMPLE,
  /**
   * The source whose candidate this arm bought itself, if any.
   *
   * A dissent arm holds one candidate the pool does not, and the identity check below compares
   * the *statements* slot by slot. Without this, every case the conditional call fired on would
   * fail the length comparison and be silently skipped — the check would be weakest exactly where
   * the arm's lever acted, which is the failure mode the check exists to prevent. Everything the
   * arm did *not* buy is still compared, so a pool that was regenerated is still caught.
   */
  ownSource?: string,
): { readonly shared: number; readonly unrecorded: number } {
  if (pooled.length < minimumSample) return { shared: 0, unrecorded: 0 };
  const byId = new Map(source.map((run) => [run.id, run]));
  const missing = pooled.filter((run) => !byId.has(run.id));
  if (missing.length > 0) {
    throw new Error(
      `arm ${armName}: ${String(missing.length)} of ${String(pooled.length)} cases are absent from the pool it reuses, so the two arms do not describe the same sample`,
    );
  }
  // Both sides have to have recorded a ceiling for the comparison to mean anything. A case the
  // source never decided and a case the pooled arm never decided are equally silent, and silence
  // is not disagreement.
  const comparable = pooled.filter((run) => byId.get(run.id)?.candidateRecall !== undefined && run.candidateRecall !== undefined);
  if (comparable.length === 0) {
    throw new Error(
      `arm ${armName}: none of its ${String(pooled.length)} cases carry a candidate record, so whether it read the pool it names cannot be checked — the arm's ceiling is unverified`,
    );
  }
  // The ceiling is compared over the candidates the pool supplied, not over everything the arm
  // holds: a dissent arm's ceiling may legitimately be higher than its pool's, and folding the
  // bought candidate into this comparison would report the lever's success as a broken pool.
  const ceilingOf = (run: CaseRun, except?: string): boolean =>
    except === undefined || run.candidates === undefined
      ? run.candidateRecall === true
      : run.candidates.filter((entry) => entry.source !== except).some((entry) => entry.correct);
  const disagreed = comparable.filter((run) => ceilingOf(byId.get(run.id) as CaseRun) !== ceilingOf(run, ownSource));
  if (disagreed.length > 0) {
    // Named by case, because the count alone cannot tell a pool that was regenerated from a pool
    // that was read and then half-lost: the reader has to be able to open the two cases.
    const sample = disagreed
      .slice(0, 3)
      .map((run) => `${run.id} (${String(byId.get(run.id)?.candidateRecall)} vs ${String(run.candidateRecall)})`)
      .join(', ');
    throw new Error(
      `arm ${armName}: ${String(disagreed.length)} cases read a different pool than the arm it names — the shared-pool arm generated its own candidates (${sample})`,
    );
  }
  // The ceiling agreeing is necessary and, on a case where both arms found the answer, weak: two
  // different sets can both hold one. The statements are the stronger identity and the artifact
  // already carries them, so a case whose texts differ in any slot is a pool that was not shared.
  const rewritten = comparable.filter((run) => {
    const expected = byId.get(run.id)?.candidates;
    const actual = ownSource === undefined ? run.candidates : run.candidates?.filter((entry) => entry.source !== ownSource);
    if (expected === undefined || actual === undefined) return false;
    if (expected.length !== actual.length) return false;
    return expected.map((entry) => entry.sql).sort().join('\u0000') !== actual.map((entry) => entry.sql).sort().join('\u0000');
  });
  if (rewritten.length > 0) {
    throw new Error(
      `arm ${armName}: ${String(rewritten.length)} cases read the same number of candidates but not the same statements (first: case ${rewritten[0]?.id ?? '?'}) — the pool was re-derived rather than reused`,
    );
  }
  return { shared: comparable.length, unrecorded: pooled.length - comparable.length };
}

/**
 * The candidates a pooled arm reads, checked against the pool it names.
 *
 * Pure and exported because the failures are ones a test can construct and a run mostly cannot:
 * inside `runArm` the pool exists (the ordering guard in `runBird` ran first), so the sentences
 * below would be branches no test could reach — a claim the reader has to verify rather than a
 * guard. Here they are lines a case can choose between.
 *
 * The size check this function used to carry was wrong, and a real run is what showed it: a
 * candidate the engine refuses is a candidate that does not exist, so a three-candidate arm
 * legitimately holds one candidate on a case where two statements failed to execute. It refused
 * nine of six hundred cases in `41389454128` — a guard firing on the harness's honest behaviour,
 * which is how a pool arm would have become unmeasurable. A pool of one is a pool.
 *
 * The empty pool was the second half of the same mistake, and it took another run to see it: a
 * source arm that produced *nothing* for a case has not failed to be read, it has failed the
 * question, and its row records why. That distinction needs both facts at once, so it lives in the
 * lookup (`PoolLookup`) rather than here — `41430569500` refused a run that had already scored six
 * arms because `reusePool` raised a plain `Error`, which is filed as a harness bug. This function now
 * refuses exactly one thing: a case the source never ran.
 */
export function reusePool(
  armName: string,
  source: string,
  reused: readonly PooledCandidate[] | undefined,
  caseId: string,
): readonly PooledCandidate[] {
  if (reused === undefined) {
    throw new Error(
      `arm ${armName} reuses the pool of ${source}, which has not run yet in this run and holds no entry for case ${caseId} — the pooled arm would answer a case its source never saw`,
    );
  }
  return reused;
}

/**
 * What a pooled arm's row says about the pool it read, or `undefined` when it cannot say anything.
 *
 * Two facts belong in one field. The first is the check itself (`assertPoolShared`): the candidates
 * are the ones the named arm drew. The second is how many cases that check *could* be performed on,
 * and `41430569500` is why it is published rather than assumed: the earlier comment here said a
 * case with no candidate record was unreachable, and I-80 produced two of them in six hundred — the
 * source arm wrote no candidates at all, so the pooled arm had nothing to read. A run in which that
 * happens is not broken; a run in which it happens and the artifact does not say so is unreadable.
 *
 * Below the instrument floor there is nothing to check and the field is absent, on the same rule
 * every other instrument in this file follows: a share over seven cases is a share about seven
 * cases. Pure and exported because the floor is a branch a test can decide in microseconds and a
 * real run needs a fixture of a hundred questions to reach.
 */
export function poolReadOf(
  armName: string,
  pooled: readonly CaseRun[],
  source: readonly CaseRun[],
  minimumSample = MINIMUM_INSTRUMENT_SAMPLE,
  ownSource?: string,
): ArmReportRow['poolRead'] {
  const read = assertPoolShared(armName, pooled, source, minimumSample, ownSource);
  return pooled.length < minimumSample ? undefined : { ...read, cases: pooled.length };
}

/**
 * The decision a free rule makes, over the candidates the arm already executed.
 *
 * Wrapped rather than inlined at the call site because two things have to be true of it and both
 * are cheap to state once: a rule refuses to run on an empty set (an arm that produced no
 * candidate has no answer, and scoring that as a miss would blame the rule for a generation
 * failure), and the record has to say how many candidates were eligible, since a set of three
 * where two returned nothing is a decision between one statement and itself.
 */
export function decideByRule(
  rule: SelectionRule,
  candidates: readonly { readonly sql: string; readonly rows: readonly (readonly unknown[])[] }[],
): NonNullable<CaseRun['selectedByRule']> {
  if (candidates.length === 0) {
    throw new Error(`the ${rule} rule was given no candidates; an arm with nothing to choose among has no answer to score`);
  }
  const decided = chooseCandidateByRule(rule, candidates);
  const eligible = candidates.filter((candidate) => candidate.rows.length > 0).length;
  return { rule, index: decided.index, eligible, emptyPool: eligible === 0 };
}

/**
 * The columns of exactly the tables a candidate set reads, rendered for the judge.
 *
 * The selector is asked which statement answers the question and shown the question, the
 * statements and three preview rows of each result. It has never been shown the schema. On a pool
 * that agrees that omission is free; on the 27% that disagree it is the evidence the decision turns
 * on, and the readings say the decision is being made without it: at temperature 0.7 the pool keeps
 * a correct candidate on 62.0% of its disagreeing questions, the model picks it on 35.7%, and a
 * rule that reads nothing but statement length picks it on 44.2%.
 *
 * Only the tables the candidates name are rendered, and a name that matches no table in the card is
 * dropped rather than shown: BIRD's golds open CTEs, and a CTE is not a table with columns. The
 * budget is characters, not tables, because the block is a prompt and a prompt is a bill — a card
 * with forty tables would cost more than the call it informs.
 */
export function columnEvidence(
  schema: readonly SchemaTable[],
  candidates: readonly { readonly sql: string }[],
  budget = 1200,
): string | undefined {
  const named = new Set<string>();
  for (const candidate of candidates) {
    for (const reference of tableRefs(candidate.sql)) named.add(reference.table.toLowerCase());
  }
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const table of schema) {
    if (!named.has(table.table.toLowerCase())) continue;
    const line = `${table.table}(${table.columns.map((column) => column.name).join(', ')})`;
    if (used + line.length > budget) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return undefined;
  return omitted === 0 ? lines.join('\n') : `${lines.join('\n')}\n(${String(omitted)} more tables omitted for length)`;
}

/**
 * A gate in front of a chooser that spends nothing is a rename, and a gate in front of a chooser
 * that fires only where the gate does is a chooser that can never run.
 *
 * Refused at the declaration for `assertRuleSelection`'s reason: the wrong combination compiles,
 * runs, is billed, and reports a number that reads as a measurement of the gate.
 *
 * What the gate is *for* is the composition it used to refuse. A paid adjudication — the model
 * selector, a knockout, a reconcile turn — is exactly the thing whose price should be proportional
 * to the questions that have something to decide, and the gate is the reading of the pool that
 * makes it so: zero calls on the 73% where every candidate returned the same rows, the arm's own
 * chooser unchanged on the rest. The two levers are then priced as one only in the sense that the
 * arm's total bill is one number, which is what a deployment pays. So `pairwise` and `reconcile`
 * are admitted here, and the refusal that remains is the one that is a real contradiction:
 * `dissent` buys an opinion *because* the pool was unanimous, which is the case the gate answers
 * by rule before the dissent branch is reached — the arm would pay for a call it cannot make.
 */
export function assertResultGate(arm: Pick<Arm, 'name' | 'select' | 'gate' | 'gateRule' | 'selectRule' | 'reconcile' | 'pairwise' | 'vote' | 'dissent'>): void {
  if (arm.gate === undefined) return;
  if (arm.select !== true) {
    throw new Error(`arm ${arm.name} gates a decision it never asks for; \`select: true\` is what draws a candidate set and what a gate saves a call on`);
  }
  if (arm.selectRule !== undefined) {
    throw new Error(`arm ${arm.name} gates the ${arm.selectRule} rule, which spends no call either way — the gate would be a second name for the same arm`);
  }
  if (arm.dissent !== undefined) {
    throw new Error(`arm ${arm.name} gates a pool it also buys a dissent for: the gate answers the unanimous pool by rule, which is the only pool the dissent turn fires on, so the bought opinion would be unreachable`);
  }
  if ((arm.vote ?? 1) < 2) {
    throw new Error(`arm ${arm.name} draws ${String(arm.vote ?? 1)} candidate, so its pool cannot agree or disagree and the gate would spend on every case`);
  }
}

/**
 * Evidence for a judge that is never asked is a block that is built, billed as a declaration and
 * never read — the shape `assertRuleSelection` refuses on the other side of the same call.
 */
export function assertEvidence(arm: Pick<Arm, 'name' | 'select' | 'selectRule' | 'reconcile' | 'selectorEvidence'>): void {
  if (arm.selectorEvidence === undefined) return;
  if (arm.select !== true || arm.selectRule !== undefined) {
    throw new Error(`arm ${arm.name} declares ${arm.selectorEvidence} evidence for a selector that never reads it: the block is rendered into the model selector's prompt, and this arm chooses by ${arm.selectRule === undefined ? 'nothing' : `the ${arm.selectRule} rule`}`);
  }
  if (arm.reconcile !== undefined) {
    throw new Error(`arm ${arm.name} asks for a reconcile turn, whose prompt does not render the evidence block — the lever would be declared and never run`);
  }
}

/**
 * How many of an arm's decisions carry a counted call.
 *
 * The one number its cost cannot be inferred from. `calls.mean` is a mean over cases that did not
 * all decide — a case whose candidate set came back empty, or whose pool was empty, returns before
 * the selector and spends nothing — so the same mean supports two opposite readings: 0.995 is "three
 * cases never reached the selector" on a correct arm and "the selector is not priced" on a broken
 * one. Counting the decisions instead of averaging them is the only way to tell those apart, because
 * the counter runs before the call (`withCallCounter`) and therefore includes the selector turns
 * that threw.
 *
 * No instrument floor: this is a reconciliation of two counts over the same cases, not a share, so
 * a seven-question fixture says as much as a six-hundred-question run.
 */
export function spendOf(runs: readonly CaseRun[]): ArmReportRow['spend'] {
  const decided = runs.filter((run) => run.selectedByModel !== undefined);
  return { asked: decided.length, priced: decided.filter((run) => run.calls >= 1).length };
}

/**
 * A selector that never answered is not a selector that chose badly.
 *
 * The call used to escape, which refused the run at the failure-share gate — loud, but for the
 * wrong reason and at the cost of the case's ceiling. Now the case is scored by the vote it already
 * had, so the outage needs its own guard: without one, an endpoint that refuses every adjudication
 * produces an arm whose accuracy is the free aggregator's, published under the selector's name.
 * Same share as the candidate-survival guard, for the same reason: a lever that did not run on a
 * tenth of the cases is an endpoint problem, and a rate measured over it is a rate about the
 * endpoint.
 */
export function assertSelectorAnswered(armName: string, runs: readonly CaseRun[], maxShare = 0.1, minimumSample = MINIMUM_INSTRUMENT_SAMPLE): void {
  if (runs.length < minimumSample) return;
  const lost = runs.filter((run) => run.selectionFailed !== undefined).length;
  const share = lost / runs.length;
  if (share <= maxShare) return;
  throw new Error(
    `arm ${armName}: ${String(lost)} of ${String(runs.length)} cases (${(share * 100).toFixed(1)}%) never reached the selector, ` +
      `above the ${(maxShare * 100).toFixed(0)}% this harness treats as an outage — those cases were scored by the vote, so the accuracy is the aggregator's, not the selector's`,
  );
}

/**
 * The audit turn's reach and yield, over the cases the arm ran.
 *
 * `extraCallsPerCase` is the price of the mechanism stated in the one unit the arms are
 * compared in: a single-call arm that audits spends two calls on every question, so a delta
 * has to be read against a doubled bill and not against "one more call sometimes".
 */
export function auditFunnel(runs: readonly CaseRun[]): {
  readonly fired: number;
  readonly named: number;
  readonly rewritten: number;
  readonly extraCallsPerCase: number;
} {
  const fired = runs.filter((run) => run.audit?.fired === true).length;
  const named = runs.reduce((total, run) => total + (run.audit?.named ?? 0), 0);
  const rewritten = runs.filter((run) => run.audit?.rewritten === true).length;
  return {
    fired,
    named,
    rewritten,
    extraCallsPerCase: runs.length === 0 ? 0 : Number((fired / runs.length).toFixed(2)),
  };
}

/**
 * The domain reader the grounding arm hands the pipeline, over one question's database.
 *
 * The pipeline knows no schema, so the reader resolves the statement's own references: an alias to
 * its table, a table name to itself, and an unqualified column to every table the statement reads
 * — the same rule `domainsOf` applies when the harness grounds a literal itself, so the two cannot
 * disagree about which column was asked.
 *
 * A qualifier that names neither an alias nor a table of the statement (a comma join, a subquery)
 * is answered as `undefined` rather than guessed at: reading the wrong table's values would ground
 * a literal against a column the statement never compares. `undefined` and an empty list are
 * different answers — one says "I could not look", the other "nothing is stored there" — and only
 * the second is a fact about the database.
 */
export function groundingReader(
  run: (sql: string) => Promise<OracleResult>,
  db: string,
): (query: { readonly column: string; readonly qualifier?: string; readonly sql: string }) => Promise<readonly string[] | undefined> {
  const cache = new Map<string, readonly string[]>();
  const read = createDomainReader(run, db, cache);
  return async (query) => {
    const refs = tableRefs(query.sql);
    const aliases = new Map(refs.map((ref) => [ref.alias.toLowerCase(), ref.table]));
    const named =
      query.qualifier === undefined
        ? undefined
        : (aliases.get(query.qualifier.toLowerCase()) ?? refs.find((ref) => ref.table.toLowerCase() === query.qualifier?.toLowerCase())?.table);
    if (query.qualifier !== undefined && named === undefined) return undefined;
    const tables = [...new Set(named === undefined ? refs.map((ref) => ref.table) : [named])];
    if (tables.length === 0) return undefined;
    const values: string[] = [];
    for (const table of tables) values.push(...(await read(table, query.column)));
    return values.length === 0 ? undefined : values;
  };
}

/**
 * The grounding rewrite's reach, over the cases the arm ran.
 *
 * `substitutions` is what it changed and `refused` is what it could not settle. The second number
 * is what keeps the first honest: a rule that fires on nothing because every column read failed
 * would otherwise be indistinguishable from a corpus where every spelling was already right.
 */
export function groundingFunnel(runs: readonly CaseRun[]): {
  readonly substitutions: number;
  readonly refused: number;
  readonly rewritten: number;
  readonly share: number;
} {
  const substitutions = runs.reduce((total, run) => total + (run.grounding?.substitutions ?? 0), 0);
  const refused = runs.reduce((total, run) => total + (run.grounding?.refused ?? 0), 0);
  const rewritten = runs.filter((run) => (run.grounding?.substitutions ?? 0) > 0).length;
  return { substitutions, refused, rewritten, share: runs.length === 0 ? 0 : Number((rewritten / runs.length).toFixed(4)) };
}

/**
 * A grounding arm that grounded nothing is its parent with a domain reader attached.
 *
 * The failure mode is silent by construction: the statement is unchanged, so the accuracy is the
 * parent's, and the only thing that distinguishes "the edit had nothing to do" from "the edit never
 * ran" is this count. The threshold is the sample size the other asserts use.
 */
export function assertGroundingFired(armName: string, runs: readonly CaseRun[], minimumSample = MINIMUM_INSTRUMENT_SAMPLE): void {
  if (runs.length < minimumSample) return;
  if (runs.some((run) => (run.grounding?.substitutions ?? 0) > 0)) return;
  throw new Error(
    `arm ${armName}: across ${String(runs.length)} questions the grounding rewrite substituted nothing, so the arm is its parent with a dead domain reader — the lever did not run`,
  );
}

/**
 * The shape the arm's replies had, aggregated over the cases that recorded one.
 *
 * Beside the accuracy rather than inside it, for the reason the contract exists: a score is
 * a claim about statements, and this is a claim about the channel that carries them. On the
 * models measured in this repository every dimension reads `always` — the number is written
 * here so that the first arm measured on a model nobody has calibrated shows where the
 * collapse would start, instead of reporting a lower accuracy with no address.
 *
 * Absent when no case recorded a shape, which is the dry run: a profile over zero replies
 * would be a verdict about a model that was never called.
 */
export function armFormat(runs: readonly CaseRun[]): { readonly format: FormatProfile } | Record<string, never> {
  const shapes = runs.flatMap((run) => (run.shape === undefined ? [] : [run.shape]));
  return shapes.length === 0 ? {} : { format: formatProfile(shapes) };
}

/**
 * An audit arm whose audit never fired is a single-call arm with a longer name.
 *
 * The same failure the empty-result lever had: written, wired, paired and silently absent,
 * with an accuracy next to the parent's that reads as "the mechanism did nothing" rather than
 * "the mechanism never ran". The threshold is the sample size the other asserts use.
 */
export function assertAuditFired(armName: string, runs: readonly CaseRun[], minimumSample = MINIMUM_INSTRUMENT_SAMPLE): void {
  if (runs.length < minimumSample) return;
  if (runs.some((run) => run.audit?.fired === true)) return;
  throw new Error(
    `arm ${armName}: across ${String(runs.length)} questions the audit turn never fired, so the arm is its parent with a longer prompt — the lever did not run`,
  );
}

/**
 * The intent source's one failure mode that is a defect rather than a finding.
 *
 * A refusal is a reading: a grammar that cannot express a question is a fact about the corpus, and
 * the histogram in the report says which construct to add. An arm that was *never asked*, or whose
 * every reply was refused, is not a reading — it is its parent with a longer prompt and an extra
 * call, and the accuracy would be published as if the vocabulary had been tested.
 *
 * The two zeros are separate sentences because they have separate fixes: no record at all means the
 * branch never ran (a wiring break), and records that are all refusals mean the rule or the reader
 * is wrong for the model in front of it (a format break). The share itself is deliberately not
 * guarded — a low conversion rate is the measurement.
 */
export function assertIntentFired(armName: string, runs: readonly CaseRun[], minimumSample = MINIMUM_INSTRUMENT_SAMPLE): void {
  const asked = runs.filter((run) => run.intent !== undefined);
  if (asked.length < minimumSample) return;
  const rendered = asked.filter((run) => run.intent?.read === 'ok').length;
  if (rendered > 0) return;
  throw new Error(
    `arm ${armName}: the intent source was asked on ${String(asked.length)} cases and none of them became a statement, so the vocabulary it exists to test was never read`,
  );
}

/** What the intent source produced: the format's conversion and the grammar's refusals by name. */
export function intentReport(runs: readonly CaseRun[]): ReturnType<typeof intentFunnel> & { readonly refusedCases: readonly { readonly case: string; readonly read: string; readonly detail: string }[] } {
  // The funnel is computed over the subset that asked, so a record's position is an index into this
  // array and not into `runs`: publishing the position as a case id would name the wrong question on
  // every arm whose first case failed before the intent call.
  const asked = runs.flatMap((run) => (run.intent === undefined ? [] : [{ id: run.id, intent: run.intent }]));
  const funnel = intentFunnel(asked.map((entry) => entry.intent));
  return {
    ...funnel,
    refusedCases: funnel.refusedSamples.map((sample) => ({
      case: asked[sample.at]?.id ?? '',
      read: sample.read,
      detail: sample.detail,
    })),
  };
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
 *
 * `restored` is the dense rule's own size — the columns the six-column floor and the declared
 * keys kept that the model never named — and it is reported only by an arm that has a floor.
 * Zero is a finding: it means the application rule added nothing to the parent and the pair's
 * delta is noise dressed as a lever.
 */
export function columnChoiceFunnel(runs: readonly CaseRun[]): {
  readonly cases: number;
  readonly decided: number;
  readonly decidedShare: number;
  readonly unknown: number;
  readonly cardShare: number;
  readonly restored?: number;
} | undefined {
  const chosen = runs.filter((run) => run.columnSelection !== undefined);
  if (chosen.length === 0) return undefined;
  const decided = chosen.filter((run) => run.columnSelection?.decided === true).length;
  const shares = chosen.map((run) => {
    const record = run.columnSelection as NonNullable<CaseRun['columnSelection']>;
    return record.total === 0 ? 1 : record.kept / record.total;
  });
  const restored = chosen.reduce((total, run) => total + (run.columnSelection?.restored ?? 0), 0);
  const floored = chosen.some((run) => run.columnSelection?.restored !== undefined);
  return {
    cases: chosen.length,
    decided,
    decidedShare: Number((decided / chosen.length).toFixed(4)),
    unknown: chosen.reduce((total, run) => total + (run.columnSelection?.unknown ?? 0), 0),
    cardShare: Number((shares.reduce((total, share) => total + share, 0) / chosen.length).toFixed(4)),
    ...(floored ? { restored } : {}),
  };
}

/**
 * A column-choosing arm whose choice never removed a column measured nothing.
 *
 * The same rule as `assertEmptyRetryFired` and `assertRepairPathFired`: a lever that fires on
 * every case with a full card is indistinguishable from an arm that spends a call to be told
 * what it already had, and its delta would be published as "choosing columns does not help".
 */
export function assertColumnChoiceRan(armName: string, runs: readonly CaseRun[], minimumSample = MINIMUM_INSTRUMENT_SAMPLE): void {
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
 * What the value block carried, over the cases an arm ran.
 *
 * `columns` is the sum and `withValues` the number of cases that carried any: the two answer
 * different questions. A sum alone cannot tell a block on every case from the same total spread
 * over a third of them, and the arm that narrows the block changes exactly that ratio. `empty` is
 * the D56 count — the cases the rule reached nothing on — and it is the number that separates "the
 * block was shown and ignored" from "the rule selected nothing".
 */
export function sampleBlockFunnel(
  runs: readonly CaseRun[],
): { readonly cases: number; readonly withValues: number; readonly columns: number; readonly empty: number } | undefined {
  const counted = runs.filter((run) => run.sampleBlock !== undefined);
  if (counted.length === 0) return undefined;
  const columns = counted.reduce((total, run) => total + (run.sampleBlock?.columns ?? 0), 0);
  const withValues = counted.filter((run) => (run.sampleBlock?.columns ?? 0) > 0).length;
  return { cases: counted.length, withValues, columns, empty: counted.length - withValues };
}

/**
 * A narrowed block that keeps nothing anywhere is its parent under another name.
 *
 * The rule the other levers follow: a rule that fires on no case publishes a delta of zero with
 * the authority of a measurement, and the reader takes it as "the columns that matter do not help".
 * `assertSamplesRan` cannot catch this one — it reads the profile, which has values on databases
 * this rule selects nothing from — so the count has to be the arm's own per-case one.
 */
export function assertSampleBlockFired(armName: string, runs: readonly CaseRun[], minimumSample = MINIMUM_INSTRUMENT_SAMPLE): void {
  if (runs.length < minimumSample) return;
  const funnel = sampleBlockFunnel(runs);
  if (funnel !== undefined && funnel.withValues > 0) return;
  throw new Error(
    `arm ${armName}: across ${String(runs.length)} questions no case carried a stored value, so the column rule selected nothing and the arm is its parent renamed`,
  );
}

/**
 * What the field rule kept, over the cases an arm ran.
 *
 * `kept` and `dropped` are sums, and the ratio between them is the lever: a card restricted to the
 * gold's fields is worth something only if it is materially smaller, and a rule that kept 98% of the
 * columns would publish an accuracy difference about nothing. `emptied` counts the cases where the
 * rule left no column at all — the statement named no table, or named only tables the card does not
 * describe — which is a case that cannot answer the question and must not be read as a wrong answer.
 */
export function fieldBlockFunnel(
  runs: readonly CaseRun[],
): { readonly cases: number; readonly kept: number; readonly dropped: number; readonly emptied: number } | undefined {
  // Narrowed by a type predicate rather than filtered and then read with `?.`: the fallback after
  // the optional chain can never fire, and a branch no run can reach is a number in the coverage
  // report that means nothing.
  const counted = runs.filter(
    (run): run is CaseRun & { readonly fieldBlock: { readonly columns: number; readonly dropped: number } } => run.fieldBlock !== undefined,
  );
  if (counted.length === 0) return undefined;
  const kept = counted.reduce((total, run) => total + run.fieldBlock.columns, 0);
  const dropped = counted.reduce((total, run) => total + run.fieldBlock.dropped, 0);
  return { cases: counted.length, kept, dropped, emptied: counted.filter((run) => run.fieldBlock.columns === 0).length };
}

/**
 * A field rule that removed nothing is its parent renamed.
 *
 * The arm publishes a delta and the reader attributes it to perfect linking; if the rule removed
 * nothing, the delta is the arm's own noise wearing that name. The count is the arm's per-case one —
 * the card measurement cannot stand in for it, because that instrument prices a *linker* and this
 * guard is about a rule that ran.
 */
export function assertFieldBlockFired(armName: string, runs: readonly CaseRun[], minimumSample = MINIMUM_INSTRUMENT_SAMPLE): void {
  if (runs.length < minimumSample) return;
  const funnel = fieldBlockFunnel(runs);
  if (funnel !== undefined && funnel.dropped > 0) return;
  throw new Error(
    `arm ${armName}: across ${String(runs.length)} questions the field rule removed no column, so the arm is its parent renamed`,
  );
}

/**
 * What the conditional fourth opinion did, over the cases an arm ran.
 *
 * `asked` is the number of cases whose pool agreed with itself, which is the only population the
 * lever acts on; the other three are the funnel below it. A hit rate cannot say any of this: an
 * arm that spent 1,140 calls and an arm that spent none publish the same accuracy when the vote
 * keeps its decision either way, and the difference between "the dissents were all the answer we
 * already had" and "the dissents were different and wrong" is the whole reading.
 */
export function dissentFunnel(
  runs: readonly CaseRun[],
):
  | {
      readonly asked: number;
      readonly arrived: number;
      readonly distinct: number;
      readonly adopted: number;
      readonly pairwise?: { readonly asked: number; readonly choseDissent: number };
    }
  | undefined {
  const counted = runs.filter((run) => run.dissent !== undefined);
  if (counted.length === 0) return undefined;
  // The verification turn is published only when some case carries it: an arm that does not
  // verify has no such turn, and a zero there would read as "it fired on nothing" rather than as
  // "it does not exist". Same rule as the block funnel's absent field.
  const verified = counted.filter((run) => run.dissent?.pairwise !== undefined);
  return {
    asked: counted.filter((run) => run.dissent?.asked === true).length,
    arrived: counted.filter((run) => run.dissent?.arrived === true).length,
    distinct: counted.filter((run) => run.dissent?.distinct === true).length,
    adopted: counted.filter((run) => run.dissent?.adopted === true).length,
    ...(verified.length === 0
      ? {}
      : {
          pairwise: {
            asked: verified.filter((run) => run.dissent?.pairwise?.asked === true).length,
            choseDissent: verified.filter((run) => run.dissent?.pairwise?.choseDissent === true).length,
          },
        }),
  };
}

/**
 * A conditional call that never fires, or never arrives, is not a reading.
 *
 * Two sentences rather than one, because the two states call for opposite fixes: `asked === 0`
 * means the condition was never true on this population (a lever that did not run, which is the
 * shape every other guard in this file refuses), and `arrived === 0` means it ran and nothing came
 * back, which is an outage wearing the arm's name. `distinct === 0` is deliberately *not* refused:
 * "the fourth opinion always returned the answer the pool already had" is a measurement, and a
 * measurement of zero is published, not thrown away — the whole reason the funnel counts it.
 */
export function assertDissentFired(
  armName: string,
  runs: readonly CaseRun[],
  minimumSample = MINIMUM_INSTRUMENT_SAMPLE,
  verify?: 'pairwise',
): void {
  if (runs.length < minimumSample) return;
  const funnel = dissentFunnel(runs);
  if (funnel === undefined) {
    throw new Error(`arm ${armName}: declares a dissent source and no case carries a dissent record, so the call cannot be priced`);
  }
  if (verify !== undefined && funnel.pairwise === undefined) {
    throw new Error(
      `arm ${armName}: declares a verification turn and no case carries one, so the arm is its parent plus an unmeasured call`,
    );
  }
  if (verify !== undefined && funnel.pairwise?.asked === 0) {
    throw new Error(
      `arm ${armName}: across ${String(runs.length)} questions the bought opinion never disagreed, so the verification turn the arm pays for never fired`,
    );
  }
  if (funnel.asked === 0) {
    throw new Error(
      `arm ${armName}: across ${String(runs.length)} questions the pool agreed with itself on none, so the conditional call never fired and the arm is its parent renamed`,
    );
  }
  if (funnel.arrived === 0) {
    throw new Error(
      `arm ${armName}: the dissent call was made on ${String(funnel.asked)} questions and none of them produced a runnable statement, which is an outage rather than a lever`,
    );
  }
}

/**
 * A rule with nothing to rank, or a model-only lever declared beside it, is a claim without wiring.
 *
 * Two ways the same mistake arrives. The first is a rule named on an arm that draws one candidate:
 * `select: true` is what builds the set, so a rule without it ranks a set of one and publishes the
 * parent arm under a name that says otherwise. The second is a lever only the model branch reads —
 * `pairwise`, `judge`, `agreement`, `reconcile`, `sourcesVisible`, `dissentVerify` — declared
 * beside a rule that never enters that branch. The arm would report the lever in its name, price
 * it in its diff, and never run it; three of the four levers caught this way over the last year
 * were found by a paid artifact, and this is the free version of that finding.
 *
 * Declaration-time, so it costs nothing and refuses before a call is spent.
 */
const MODEL_ONLY_LEVERS = [
  'agreement',
  'canonical',
  'dissentVerify',
  'judge',
  'judgeFormat',
  'pairwise',
  'reconcile',
  'reconcileAdopt',
  'sourcesVisible',
] as const;

export function assertRuleSelection(arm: Pick<Arm, 'name' | 'select' | 'selectRule'> & Partial<Arm>): void {
  if (arm.selectRule === undefined) return;
  if (arm.select !== true) {
    throw new Error(
      `arm ${arm.name} names the ${arm.selectRule} rule without a candidate set; \`select: true\` is what draws one and a rule with nothing to rank decides nothing`,
    );
  }
  const wired = MODEL_ONLY_LEVERS.filter((lever) => arm[lever] !== undefined && arm[lever] !== false);
  if (wired.length > 0) {
    throw new Error(
      `arm ${arm.name} selects with the ${arm.selectRule} rule and declares ${wired.join(', ')}, which only the model selector reads: the lever would be declared, priced and never run`,
    );
  }
}

/**
 * An arm that answers with a query object can only be read where a candidate is drawn.
 *
 * The statement it produces is rendered by the candidate-source branch, so dispatching it as an arm
 * of its own would send the intent prompt through the pipeline that reads a *statement* — the reply
 * would be a JSON object read by `extractSql`, the guard would refuse it, and the arm would publish
 * a near-zero accuracy that looks like a weak prompt. Refusing the dispatch is the only place this
 * can be said cheaply: every alternative costs a paid run that produces a number nobody can use.
 *
 * The rule is declared here rather than inside the arm because it is a property of the *dispatch*:
 * the same arm is legal as a source and illegal alone.
 */
export function assertIntentRule(dispatch: readonly string[]): void {
  const drawn = new Set<string>();
  for (const name of dispatch) {
    for (const source of resolveArm(name)?.mixed ?? []) drawn.add(parseMixedSource(source).arm);
  }
  for (const name of dispatch) {
    const arm = resolveArm(name);
    if (arm === undefined || arm.intent === undefined || drawn.has(arm.name)) continue;
    throw new Error(
      `arm ${arm.name} answers with a query object, which only the candidate-source path can read; dispatch an arm that names it as a source (e.g. select-intent) instead of this arm alone`,
    );
  }
}

/**
 * A dissent source that is already one of the candidates is a fourth vote, not an opinion.
 *
 * The lever's entire claim is that the fourth call comes from somewhere else; naming a source the
 * arm already draws would buy the same prompt again and publish a dilution of the pool as an
 * independent opinion. Refused at the declaration, before any call is spent, which is the same
 * place `assertSampleRule` refuses a column rule with no sampler.
 */
export function assertDissentRule(arm: Pick<Arm, 'name' | 'dissent' | 'dissentVerify' | 'vote' | 'mixed' | 'select'>): void {
  if (arm.dissentVerify !== undefined && arm.dissent === undefined) {
    throw new Error(`arm ${arm.name} verifies a dissent it never buys, so the turn it pays for has nothing to verify`);
  }
  if (arm.dissentVerify !== undefined && arm.select !== true) {
    throw new Error(`arm ${arm.name} verifies a dissent without a selector, so the comparison has no answer to compare against`);
  }
  if (arm.dissent === undefined) return;
  if ((arm.vote ?? 1) < 2) {
    throw new Error(
      `arm ${arm.name} buys a dissent and draws ${String(arm.vote ?? 1)} candidate, so there is no pool for the condition to be about`,
    );
  }
  if (arm.mixed?.includes(arm.dissent) === true) {
    throw new Error(
      `arm ${arm.name} buys a dissent from ${arm.dissent}, which is already one of its ${String(arm.mixed.length)} candidate sources, so the fourth opinion would be a fourth vote`,
    );
  }
  if (resolveArm(parseMixedSource(arm.dissent).arm) === undefined) {
    throw new Error(`arm ${arm.name} buys a dissent from ${arm.dissent}, which is not an arm`);
  }
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

/**
 * The worked examples an arm's prompts carried, as a funnel rather than a total.
 *
 * `cases` is the denominator and `blocks` the cases that carried at least one example: an arm that
 * retrieved neighbours for a third of the split is a blend of two prompts, and its accuracy is a
 * number about neither. `examples` is the width of what arrived — one example and three are
 * different prompts — and it is the count `assertDemonstrationsFired` refuses on. `rewritten` is
 * how many of those examples the masker changed, which is zero on every arm that does not mask.
 */
export function demonstrationsFunnel(
  runs: readonly CaseRun[],
): { readonly cases: number; readonly blocks: number; readonly examples: number; readonly rewritten: number } {
  const blocks = runs.filter((run) => (run.examples ?? 0) > 0).length;
  return {
    cases: runs.length,
    blocks,
    examples: runs.reduce((total, run) => total + (run.examples ?? 0), 0),
    rewritten: runs.reduce((total, run) => total + (run.masked ?? 0), 0),
  };
}

/**
 * An arm that asks for worked examples and receives none is its parent under another name.
 *
 * Three failures produce exactly that, and all three are infrastructure rather than readings: the
 * training split built an index in which no neighbour carries a statement (`requires: 'sql'` drops
 * them), the renderer's character budget is consumed by the first example, or the arm declares the
 * block while the run built none. The arm's whole claim is that the examples carry knowledge the
 * per-question hint does not, and a zero funnel publishes it as "examples do not help".
 *
 * The count is per case and per arm for the reason `assertSamplesRan` reads the arm's own sampler:
 * `controls.demonstrationBlocks` is a fact about the run, and a run with one examples arm and one
 * plain arm reports a positive total however the examples arm fared.
 */
export function assertDemonstrationsFired(
  armName: string,
  runs: readonly CaseRun[],
  minimumSample = MINIMUM_INSTRUMENT_SAMPLE,
): void {
  if (runs.length < minimumSample) return;
  const funnel = demonstrationsFunnel(runs);
  if (funnel.examples > 0) return;
  throw new Error(
    `arm ${armName}: worked examples were asked for and ${String(funnel.blocks)} of ${String(funnel.cases)} cases carried one, so the arm is its parent renamed`,
  );
}

/**
 * A masked arm whose examples came through the masker unchanged is its parent renamed.
 *
 * The mask is a text transform over statements this repository does not author, so it can stop
 * matching for reasons no type system sees: the training split's dialect changes, a statement is
 * written in a style the tokenizer reads as one string, an arm retrieves neighbours with no names
 * to replace. All of those leave the accuracy where the parent's is and publish a delta of ~0 as
 * "masking the schema does not help", which is the wrong finding from the right number.
 *
 * The threshold is "any example changed", not a share: `I-84`'s judgement criteria carry the
 * reading, and this is the guard that has to hold before there is a reading at all.
 */
export function assertMaskingFired(
  armName: string,
  runs: readonly CaseRun[],
  minimumSample = MINIMUM_INSTRUMENT_SAMPLE,
): void {
  if (runs.length < minimumSample) return;
  const funnel = demonstrationsFunnel(runs);
  if (funnel.rewritten > 0) return;
  throw new Error(
    `arm ${armName}: the mask was applied to ${String(funnel.examples)} example(s) across ${String(funnel.cases)} cases and rewrote none, so the arm is its parent renamed`,
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
export function assertReportComplete(report: {
  readonly arms?: readonly ArmReportRow[];
  readonly aa?: Record<string, unknown>;
}): void {
  // An A/A that reports the score's noise and not the ceiling's is the artifact that let two rounds
  // read resampling as a gain: the mechanism was argued for on a quantity whose noise was never
  // measured. The block carries it whenever the arm samples, so an artifact that lost it is refused
  // here rather than discovered by whoever reads the delta next.
  const ceiling = report.aa?.ceiling as { first?: unknown; second?: unknown; delta?: unknown } | undefined;
  // The requirement is keyed on whether the arm samples, not on whether the field happens to be
  // there: an artifact that dropped the block is exactly the one this guard has to refuse.
  const aaName = typeof report.aa?.arm === 'string' ? report.aa.arm : undefined;
  const aaArm = aaName === undefined ? undefined : resolveArm(aaName);
  if (report.aa !== undefined && (aaArm?.vote ?? 1) > 1 && ceiling === undefined) {
    throw new Error(
      `the A/A block prices ${String(aaName)}, an arm that samples, and carries no ceiling noise: ` +
        'the quantity a candidate buys has a noise of its own and this artifact does not state it',
    );
  }
  if (report.aa !== undefined && ceiling !== undefined) {
    for (const key of ['first', 'second', 'delta'] as const) {
      if (typeof ceiling[key] !== 'number' || Number.isNaN(ceiling[key])) {
        throw new Error(`the A/A block reports a ceiling noise without a numeric \`${key}\`, so the quantity it prices cannot be read`);
      }
    }
  }
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
    if (arm.reconcile !== undefined && row.reconcile === undefined) {
      // The arm's whole claim is that the model wrote a statement rather than picking one, and a row
      // without the funnel cannot tell "it reconciled and was wrong" from "it restated candidate 1".
      throw new Error(
        `arm ${row.arm} reconciles and its row carries no reconcile funnel, so its accuracy cannot be attributed to a statement the model wrote`,
      );
    }
    if (arm.audit !== undefined && row.audit === undefined) {
      throw new Error(`arm ${row.arm} runs the audit turn and its row carries no audit funnel, so the call cannot be priced`);
    }
    if (arm.pairwise === true && row.pairwise === undefined) {
      // A knockout's bill is `k - 1` per case and its failure is silent, so the row without the
      // funnel is a call count with nothing behind it: the accuracy would be read as a comparison's
      // result on an arm that may have compared nothing.
      throw new Error(
        `arm ${row.arm} decides by knockout and its row carries no pairwise funnel, so its accuracy cannot be attributed to a comparison`,
      );
    }
    if (arm.ground === true && row.grounding === undefined) {
      // The rewrite is invisible in the accuracy when it does nothing, so the row has to carry the
      // count: without it, "the corpus spelled everything right" and "the reader never answered"
      // are the same report.
      throw new Error(`arm ${row.arm} grounds its literals and its row carries no grounding funnel, so the rewrite cannot be told from a no-op`);
    }
    if (arm.cardColumns !== undefined && row.fieldBlock === undefined) {
      // The rule's whole claim is a smaller card, and the row without the count reports an accuracy
      // difference with no statement of what was removed — the same defect the block funnel was
      // added for, one lever over.
      throw new Error(`arm ${row.arm} keeps only the gold's fields and its row carries no field funnel, so the card cannot be priced`);
    }
    if (arm.samples !== undefined && row.sampleBlock === undefined) {
      // The block is the arm's only cost, and its width is the lever on the one arm that narrows it.
      // A row without the count reports an accuracy difference with no statement of what was shown.
      throw new Error(`arm ${row.arm} carries stored values and its row carries no block funnel, so its prompt cannot be priced`);
    }
    if (arm.demonstrations === true && row.demonstrations === undefined) {
      // The row's whole claim is that the block carries knowledge the hint does not. Without the
      // funnel, "the examples did not help" and "the examples arrived on a tenth of the cases" are
      // the same number.
      throw new Error(`arm ${row.arm} carries worked examples and its row carries no demonstration funnel, so the delta cannot be placed on the cases that read one`);
    }
    if (arm.masked === true && row.demonstrations?.rewritten === undefined) {
      // The masked arm's row is the parent's row with a sentence of preamble added unless the funnel
      // says how many examples the masker changed. `assertMaskingFired` refuses the all-zero case at
      // run time; this refuses the row that does not carry the number at all.
      throw new Error(
        `arm ${row.arm} masks the names in its examples and its funnel carries no rewritten count, so the mask cannot be told from a preamble`,
      );
    }
    if (arm.emptyRetry !== undefined && row.emptyRetry === undefined) {
      throw new Error(`arm ${row.arm} runs the empty-result lever and its row carries no empty-result funnel, so the call cannot be priced`);
    }
    if (arm.dissent !== undefined && row.dissent === undefined) {
      // The arm buys a call on a condition, so the row must publish how often the condition held
      // and what came back: without it, 0.745 calls a case is indistinguishable from 0.745 of a
      // case, and the delta cannot be placed on the population the lever claims to act on.
      throw new Error(`arm ${row.arm} buys a conditional dissent and its row carries no dissent funnel, so the call cannot be priced`);
    }
    if (arm.pool !== undefined && row.poolRead === undefined && row.total >= MINIMUM_INSTRUMENT_SAMPLE) {
      // The pooled arm's whole claim is that it read the same candidates as the arm it names, and a
      // row that does not say how much of that was checkable leaves the reader with a delta whose
      // denominator is unknown. Below the instrument floor there is nothing to check and the field
      // is legitimately absent.
      throw new Error(
        `arm ${row.arm} reads the pool of ${arm.pool} and its row carries no pool verification, so the delta it publishes rests on an unstated number of shared cases`,
      );
    }
    if (arm.select === true && arm.selectRule === undefined && row.spend === undefined && row.total >= MINIMUM_INSTRUMENT_SAMPLE) {
      // The row has to say how many decisions carried a counted call, on either shape. The gate cannot
      // read that off `calls.mean`: a case that fails before the selector returns and spends nothing,
      // which makes 1.0 and 0.99 the same number to a mean and opposite facts to a reader — one arm
      // priced its selector, the other never reached it.
      throw new Error(
        `arm ${row.arm} decides with the model and its row does not say how many of those decisions were priced: the selector call is one per decision and a mean cannot show it`,
      );
    }
    if (arm.gate !== undefined && arm.selectRule === undefined && row.spend === undefined && row.total >= MINIMUM_INSTRUMENT_SAMPLE) {
      // A gated arm's saving is a count, and the two counts that make it readable are the cases the
      // gate stopped (`selectorRule.decided`) and the cases that still reached a selector
      // (`spend.asked`). A row with neither reports an arm whose call mean moved for no stated
      // reason, which is the defect this whole function exists for one lever over.
      throw new Error(
        `arm ${row.arm} gates its adjudication and its row says neither how many cases the gate decided nor how many reached the selector, so the saving cannot be told from a mechanism that never ran`,
      );
    }
    if ((arm.selectRule !== undefined || arm.gate !== undefined) && row.selectorRule === undefined && row.total >= MINIMUM_INSTRUMENT_SAMPLE) {
      // The same question for a selector that spends nothing, and the one that a mean cannot
      // answer for the same reason: a rule arm's `calls.mean` equals its candidate count whether
      // the rule ran or the vote did. The funnel is the only record of the lever acting.
      throw new Error(
        `arm ${row.arm} lets the ${arm.selectRule} rule decide and its row carries no rule funnel, so the decision cannot be told from the vote that would have run without it`,
      );
    }
    if (row.total > 0 && row.format === undefined && row.pool === undefined) {
      // A pooled arm answered nothing, so there is no reply shape for it to describe: the
      // profile of those replies belongs to the arm that asked for them, and copying it here
      // would attribute one model's output to two prompts. The exemption is therefore keyed on
      // `pool` and not on "the arm is special": a row with neither a format profile nor a pool
      // is still refused, which is the reading this guard exists for.
      throw new Error(
        `arm ${row.arm} answered ${String(row.total)} cases and its row carries no format profile: ` +
          'the shape of every reply was read and then dropped, so the one reading that predicts a collapse on an uncalibrated model is missing',
      );
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
export function assertDecompositionFired(armName: string, runs: readonly CaseRun[], minimumSample = MINIMUM_INSTRUMENT_SAMPLE): void {
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
  arm: Pick<Arm, 'repairs' | 'vote' | 'sourceRepairs'>,
  runs: readonly {
    readonly tokens?: { readonly byPurpose?: Readonly<Record<string, { readonly calls: number }>> };
  }[],
): { repaired?: number; samples?: number } {
  const sampling = arm.vote !== undefined && arm.vote > 1 ? { samples: arm.vote } : {};
  // `repairs > 0` was the whole test, and on a mixed arm that field is never read by the
  // generator — the grant lives in `sourceRepairs`. An arm that repairs therefore reported no
  // `repaired` column at all, which is the same defect as reporting zero: the reader cannot tell
  // "the loop did not run" from "the column is missing".
  const declaresRepairs = arm.repairs > 0 || arm.sourceRepairs !== undefined;
  if (!declaresRepairs) return sampling;
  // The retry turn is read from the token ledger, not from `attempts`. On a voting arm
  // `attempts` is the sample count — always the vote — so `attempts > 1` reported
  // `repaired: 0` on an arm that spent eleven retry calls in one 600-question run: the
  // column was present and false, which is worse than absent.
  const spentRetry = (run: (typeof runs)[number]): boolean =>
    (run.tokens?.byPurpose?.['retry']?.calls ?? 0) > 0;
  return { repaired: runs.filter(spentRetry).length, ...sampling };
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
    // Inside the dataset, for the reason `.value-examples` is: a profile is a description of
    // *these files*, and one directory for every dataset let a fixture's `shop` answer for the
    // corpus's — the card rendered from another schema, on every case of the database, with no
    // instrument able to see it. Written into the dataset, it is fetched and evicted with it.
    profileCache: join(data, '.profiles'),
    // The competitor-rule sampler caches separately from the profiler: same column names,
    // different rule, and sharing a directory would serve one rule's answer under the other's
    // name. Old entries are rejected by the rule field they carry.
    //
    // It lives *inside* the dataset rather than in one directory for every dataset, because
    // the examples are a description of these files: a fixture and the corpus can name a
    // database alike, and a single directory let a test's `shop` be served to whatever read
    // `shop` next. Written into the dataset, the cache is also fetched and evicted with it.
    exampleCache: join(data, '.value-examples'),
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
  /**
   * What the primary endpoint does with a request, when its name does not say.
   *
   * The second endpoint has had this since the capability contract was written and the primary one
   * never did, which left `glm-4.6` unreadable: nothing in its name says "this endpoint deliberates
   * before it answers", so it was sent a chat request — sampling, a 4,096-token answer budget, no
   * thinking switch — and answered in 8.5 seconds with nothing in it. A caller that knows its own
   * endpoint must be able to say so without renaming the model.
   */
  readonly capabilities?: Partial<ModelCapabilities>;
  readonly second: {
    readonly model: string;
    readonly baseUrl: string;
    readonly apiKey: string;
    /**
     * What the second endpoint does with a request, when its name does not say.
     *
     * Absent means "the name decides" (`capabilitiesOf`), which is the right default for
     * `deepseek-reasoner` and wrong for a private deployment whose model is called `prod-a`. A
     * wrong guess here is not cosmetic: it decides whether `temperature` is sent and whether the
     * selector is asked for prose or for a number.
     */
    readonly capabilities?: Partial<ModelCapabilities>;
  };
  /**
   * The harness's own knobs, carried as values because a report that omits them cannot
   * say whether a difference between two runs is the pipeline or the instrument. A
   * glm-4.5 run once reported 88% "model failures" that were this deadline.
   */
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;
  /**
   * How long any one arm may spend, or `undefined` for no limit.
   *
   * Not a natural consequence of the deadline and the split: `42666720439` was killed by its job
   * cap after five hours at 300 s a call and 2 in flight, and the deadline cannot see that coming.
   * This can, because it measures the thing that ran out.
   */
  readonly budgetMs: number | undefined;
  /**
   * A partial run to continue, or `undefined` to start from zero.
   *
   * The cases it holds are not re-asked: they were paid for by a dispatch that ran out of clock,
   * and the file's own header is checked first so a run can never be welded to a different arm,
   * split, model or question set.
   */
  readonly resumeFrom: string | undefined;
  readonly valuesForce: boolean;
  readonly definitionsForce: boolean;
}

/**
 * A capability declaration from the environment, validated where it is read.
 *
 * Two fields decide a request's shape, so a typo in either is refused rather than ignored: a
 * `family` of `"reason"` would fall back to the chat default and send a parameter the endpoint
 * discards, which is precisely the failure this contract exists to make impossible. The rest of
 * the object is passed through: an unknown key is a deployment's own extension, not an error.
 */
export function parseCapabilityOverrides(raw: string | undefined, name: string): Partial<ModelCapabilities> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object, not ${Array.isArray(parsed) ? 'an array' : typeof parsed}`);
  }
  const value = parsed as Record<string, unknown>;
  if (value.family !== undefined && value.family !== 'chat' && value.family !== 'reasoning') {
    throw new Error(`${name}.family must be "chat" or "reasoning", not ${JSON.stringify(value.family)}`);
  }
  if (value.sampling !== undefined && value.sampling !== 'honoured' && value.sampling !== 'ignored') {
    throw new Error(`${name}.sampling must be "honoured" or "ignored", not ${JSON.stringify(value.sampling)}`);
  }
  return value as Partial<ModelCapabilities>;
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
  const capabilities = parseCapabilityOverrides(env.BIRD_CAPABILITIES, 'BIRD_CAPABILITIES');
  return {
    ...(capabilities === undefined ? {} : { capabilities }),
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
      ...(() => {
        const declared = parseCapabilityOverrides(env.BIRD_SECOND_CAPABILITIES, 'BIRD_SECOND_CAPABILITIES');
        return declared === undefined ? {} : { capabilities: declared };
      })(),
    },
    timeoutMs: Number(env.BIRD_LLM_TIMEOUT_MS ?? 60000),
    retries: Number(env.BIRD_LLM_RETRIES ?? 3),
    retryDelayMs: Number(env.BIRD_LLM_RETRY_DELAY_MS ?? 1000),
    budgetMs: parseBudgetMs(env.BIRD_RUN_BUDGET_MS),
    resumeFrom: parseResumeFrom(env.BIRD_RESUME_FROM),
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
 * The columns the lookup may search, taken from the card the model actually read.
 *
 * The card and not the database: a repair may only quote values from a column the statement's
 * author could have seen, or the lever would be measuring information the prompt never offered.
 */
export function probeColumns(schema: readonly SchemaTable[]): ProbeColumn[] {
  return schema.flatMap((table) => table.columns.map((column) => ({ table: table.table, column: column.name, type: column.type })));
}

/** How much of a candidate's statement an artifact keeps. BIRD's statements are well under it. */
export const CANDIDATE_SQL_CAP = 2000;

/**
 * A short, stable name for a result set: the official judge's identity, hashed.
 *
 * Sixteen hex characters of SHA-256 rather than a counter or a 32-bit hash: the fingerprint is
 * compared across a whole split (thousands of result sets, tens of thousands of comparisons),
 * and a 32-bit space would produce a birthday collision inside one run — which would read as
 * "two candidates agreed" on a question where they did not, and inflate every consensus number
 * silently. The digest is of `resultKey`, so the equality being hashed is the benchmark's.
 */
export function resultFingerprint(rows: readonly (readonly unknown[])[]): string {
  return createHash('sha256').update(resultKey(rows)).digest('hex').slice(0, 16);
}

/**
 * For each candidate, the 1-based number of the earliest candidate that returned the same rows.
 *
 * The same equality the judge uses — `resultKey`, not a fingerprint comparison — so "the
 * selector was told these two agree" and "these two are the same answer" are one definition
 * rather than two that can drift. A mark only ever points backwards, which is what makes the
 * marks a partition of the candidate list: each group has exactly one member without a mark,
 * and the count of those is the number of distinct results.
 *
 * One pass over a `Map` rather than pairwise comparison: three candidates would make the
 * difference invisible, but a five-sample arm under the same function would not, and the
 * selector prompt is on the hot path of every case.
 */
export function agreementMarks(results: readonly (readonly (readonly unknown[])[])[]): (number | undefined)[] {
  const firstSeen = new Map<string, number>();
  return results.map((rows, index) => {
    const key = resultKey(rows);
    const earlier = firstSeen.get(key);
    if (earlier === undefined) {
      firstSeen.set(key, index + 1);
      return undefined;
    }
    return earlier;
  });
}

/**
 * The candidate set, in the order the selector saw it, with the truth for each member.
 *
 * One pass of the official judge over the set answers both questions the report asks of
 * it — `candidateRecall` ("was the answer in there at all") and the per-candidate verdict
 * ("which member held it") — so the second cannot drift from the first. Judging each
 * candidate twice would let a loss be attributed to a candidate the recall count never
 * counted.
 *
 * The statement and a fingerprint of its result travel with the verdict, and both are there to
 * make a *different* measurement possible from the same artifact. A verdict alone says which
 * candidate held the answer; it cannot say whether two candidates agreed, so every selection
 * rule that reads agreement — modal result, the cheapest consensus, "keep the one the others
 * imply" — needed a fresh run to be priced, at one call per question per rule. With the
 * statement and the fingerprint recorded, those rules replay offline for nothing, and the
 * fingerprint is `resultKey` hashed rather than a second definition of equality, so "same
 * fingerprint" is the official judge's `match` and not a claim about text.
 */
export function candidateVerdicts(
  candidates: readonly { readonly sql: string; readonly rows: readonly (readonly unknown[])[]; readonly source: string }[],
  expected: readonly (readonly unknown[])[],
): readonly { readonly source: string; readonly correct: boolean; readonly sql: string; readonly fingerprint: string; readonly sqlClipped?: boolean }[] {
  return candidates.map((candidate) => {
    const clipped = candidate.sql.length > CANDIDATE_SQL_CAP;
    return {
      source: candidate.source,
      correct: judgeOfficial(expected, candidate.rows) === 'match',
      // The text, capped: a statement is what a reader needs to see *why* a candidate was wrong,
      // and every artifact so far threw it away unless the whole case failed. Truncation is
      // recorded rather than silent, because a clipped statement cannot be re-executed and a
      // reader who assumed it could would get an engine error they would blame on the harness.
      sql: clipped ? candidate.sql.slice(0, CANDIDATE_SQL_CAP) : candidate.sql,
      ...(clipped ? { sqlClipped: true } : {}),
      fingerprint: resultFingerprint(candidate.rows),
    };
  });
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
  /** A few stored rows per table, in the tables the question names. */
  readonly rows?: string;
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

/**
 * The projection rule, as one line in the prompt's own voice.
 *
 * "Exactly the columns the question asks for, in the order it names them" — not "fewer columns",
 * because the bucket this rule is aimed at is two-sided: a statement with too few columns fails
 * in the same bucket as one with too many, and a rule that only shortened answers would move
 * cases from one side to the other and call the movement a fix. "Do not add an identifier column
 * to make rows distinguishable" names the most common way a correct projection grows: a grouped
 * answer that returns the grouping key plus the aggregate, or a list answer that returns the id
 * beside the label.
 *
 * `bench:bird:width` priced the ceiling by deleting the extra items and re-executing, so this
 * sentence is the implementable half of a lever whose upper bound is already known. It is stated
 * as a requirement on the answer rather than as a warning about a failure, because the other
 * three rules in the prompt are requirements and a rule phrased as a prohibition reads as an
 * exception to them.
 */
export const PROJECTION_RULE =
  'Select exactly the columns the question asks for, in the order it names them. Do not add an identifier column to make rows distinguishable, and do not add a column the question does not mention.';

/**
 * The card a statement's own fields fit on, and what fitting it removed.
 *
 * Two rules decide membership, and they are different rules. A `alias.column` pair names its table,
 * so the pair is the field and the table is known. A bare identifier names no table: it is kept on
 * every referenced table that has a column of that name, which over-keeps — three joined tables with
 * an `id` keep three `id`s. That is the direction a ceiling has to err in. Under-keeping would make
 * the arm drop a field the gold reads and publish the loss as a property of perfect linking.
 *
 * A table the statement does not read is dropped with its columns. Keeping it would make this arm a
 * description of the card's size rather than of its content, and the two are what the measurement is
 * separating: `select-prune` already showed that a smaller card is not automatically a better one
 * (−1.50pp on the full split, p = 0.035) — but that arm loses 4.8% of the gold's tables to its seeds,
 * and this one loses none of the ones the gold reads.
 *
 * Two statements keep more than their fields, and both for the same reason: `select 1` reads no
 * table (an empty card is not a reading), and `count(*)` names no column of the table it reads (a
 * card stripped of the counted table cannot answer). In both cases the count says the rule removed
 * nothing on that case, which is what the guard reads — the rule's failure and its abstention are
 * different findings and the funnel keeps them apart.
 */
export function narrowFields(
  schema: readonly SchemaTable[],
  sql: string,
): { readonly schema: readonly SchemaTable[]; readonly columns: number; readonly dropped: number } {
  const fields = referencedFields(sql);
  const read = new Set(tableRefs(sql).map((ref) => ref.table.toLowerCase()));
  const total = schema.reduce((sum, table) => sum + table.columns.length, 0);
  // A statement that reads no table has no fields to keep. Returning the card it was given is the
  // only honest answer: an empty card is not a prompt, and the count says the rule removed nothing,
  // which is what `assertFieldBlockFired` reads.
  if (read.size === 0) return { schema, columns: total, dropped: 0 };
  const named = new Set(fields.qualified.map((field) => `${field.table}\u0000${field.column}`));
  const bare = new Set(fields.bare);
  const kept: SchemaTable[] = [];
  let columns = 0;
  for (const table of schema) {
    const name = table.table.toLowerCase();
    if (!read.has(name)) continue;
    const chosen = table.columns.filter((column) => named.has(`${name}\u0000${column.name.toLowerCase()}`) || bare.has(column.name.toLowerCase()));
    // A table the statement reads but whose columns we could not attribute keeps all of them:
    // `count(*)` names no column, and a card stripped of the table it counts from cannot answer.
    // Under-keeping here would make the arm's loss a property of the extractor rather than of
    // perfect linking, which is the measurement.
    const keptColumns = chosen.length === 0 ? table.columns : chosen;
    kept.push({ ...table, columns: keptColumns });
    columns += keptColumns.length;
  }
  return { schema: kept, columns, dropped: total - columns };
}

export function promptFor(arm: Arm, question: BirdQuestion, blocks: PromptBlocks = {}): PromptOptions {
  const { synthesized, definitions, retrieved, demonstrations, values, rows } = blocks;
  const profile = arm.profile === 'adaptive' ? choosePromptProfile(question.question) : undefined;
  const evidence =
    arm.evidence === 'dataset'
      ? question.evidence
      : arm.evidence === 'synthetic'
        ? synthesized
        : arm.evidence === 'retrieved'
          ? retrieved
          : undefined;
  // The intent rule joins the arm's own notes rather than replacing them: the notes are the
  // shape-specific instructions the card was chosen for, and an arm that dropped them would differ
  // from its parent by two things. The projection rule joins them the same way, and for the same
  // reason — a rule that replaced the profile's notes would be a different lever from the one its
  // name claims.
  const notes = [...(profile?.notes ?? []), ...(arm.intent === 'query' ? [INTENT_RULE] : []), ...(arm.projection === 'asked' ? [PROJECTION_RULE] : [])];
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
    ...(profile === undefined && arm.intent !== 'query' && arm.projection !== 'asked' ? {} : { notes }),
    ...(arm.definitions !== undefined && definitions !== undefined && definitions.length > 0 ? { definitions } : {}),
    ...(evidence === undefined || evidence.length === 0 ? {} : { evidence }),
    ...(arm.demonstrations === true && demonstrations !== undefined && demonstrations.length > 0
      ? { demonstrations }
      : {}),
    ...(arm.values === true && values !== undefined && values.length > 0 ? { values } : {}),
    ...(arm.rowSamples === undefined || rows === undefined ? {} : { rowSamples: rows }),
    // The decomposition is part of the prompt, not a block written in an earlier call, so
    // it belongs here: the size this harness reports for the arm, and the distinct-prompt
    // count a mixed arm is checked against, both read this object.
    ...(arm.decompose === true ? { decompose: true } : {}),
    ...(arm.reasoning === 'sql-like' ? { reasoning: 'sql-like' as const } : {}),
  };
}

/**
 * One call in the intent vocabulary, read as a statement.
 *
 * The prompt is the arm's own — `promptFor` appends the rule, so the card, the evidence and the
 * notes are byte-identical to the parent arm's and the only difference in front of the model is
 * one rule line. That is what makes the pair one lever, and it is why this function builds nothing
 * of its own: a second prompt builder here would be a second thing to keep in agreement with the
 * card, and the failure mode of two builders is a run that measured a prompt nobody sent.
 *
 * A refusal is returned rather than thrown, because the two callers need different things from it:
 * the loop counts it as a candidate that never arrived, and the report prints the reason. Both are
 * the same fact, and throwing would give it to only one of them.
 */
export async function askIntent(
  provider: LlmProvider,
  request: {
    readonly question: string;
    readonly schema: readonly SchemaTable[];
    readonly prompt: PromptOptions;
    readonly linking: boolean;
  },
): Promise<{ readonly ok: true; readonly sql: string } | { readonly ok: false; readonly reason: string; readonly detail: string }> {
  const built = buildAskMessages({
    question: request.question,
    schema: request.schema,
    prompt: request.prompt,
    linking: request.linking,
  });
  // The same temperature and the same purpose label the sampling path uses: the intent is a
  // different *vocabulary*, not a different price, and a call counted under another purpose would
  // make the two arms' cost tables disagree about what generation costs.
  const reply = await provider.complete({ messages: built.messages, temperature: 0.7, purpose: 'generate' });
  // The card is the schema this renderer is held to. Quoting is what lets a column the corpus spells
  // `County Name` be written at all, and quoting is also what turns a misspelling into a SQLite
  // *string literal* — a clean wrong answer instead of an error — so the column list is passed on
  // every call rather than left to a caller that might forget: a renderer without it can guarantee
  // the statement's shape and nothing about its meaning.
  return readIntentReply(reply.text, { columns: schemaColumnNames(request.schema) });
}

/**
 * Every column of a card, in the two spellings a name can arrive as.
 *
 * Both are listed because the renderer accepts a qualified name and a bare one, and a check that
 * only held `table.column` would refuse the bare form a grouped query often uses.
 */
export function schemaColumnNames(schema: readonly SchemaTable[]): string[] {
  const names: string[] = [];
  for (const table of schema) {
    for (const column of table.columns) {
      names.push(column.name, `${table.table}.${column.name}`);
    }
  }
  return names;
}

/** One advertised column the database does not have. */export interface MissingColumn {
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
  /**
   * Questions whose neighbours arrived with the steps their statements encode.
   *
   * A different text over the same neighbours, so this is the count that tells a reader the
   * `cotDemonstrations` arm ran its lever rather than sending its parent's prompt.
   */
  stepDemonstrationBlocks: number;
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
  /**
   * How many columns of the card carried stored values, on an arm that asks for any.
   *
   * The count is per case because the block is: an arm that narrows the block to the columns a
   * statement filters on has no column to show on a statement that filters on nothing, and the
   * run-wide `controls.sampledColumns` cannot tell that case from a rule that selected nothing
   * everywhere. Present only on arms with a sampler, so a zero is always a measured zero.
   */
  readonly samples?: { readonly columns: number };
  /**
   * What the field rule removed from this case's card, on the arm that keeps only the gold's fields.
   *
   * `dropped` is the number the guard reads: a rule that removed nothing anywhere is its parent
   * renamed, and the accuracy difference it publishes would be read as a statement about perfect
   * linking. Present only on that arm, so a zero is always a measured zero.
   */
  readonly fields?: { readonly columns: number; readonly dropped: number };
  readonly columns?: {
    readonly named: number;
    readonly unknown: number;
    readonly kept: number;
    readonly total: number;
    readonly decided: boolean;
    /** Columns the dense rule put back that the model did not name (dense arms only). */
    readonly restored?: number;
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
   * The card one candidate of a mixed set is sent on: the arm's card with the source's own
   * card-level levers overlaid. Same function for the prompt the guard measures and the prompt
   * the run sends, which is the whole point of it being here rather than in either caller.
   */
  readonly schemaForSource: (source: Arm, question: BirdQuestion) => readonly SchemaTable[];
  /** How many columns of a card carry stored values, counted the way the renderer reads them. */
  readonly samplesOn: (schema: readonly SchemaTable[]) => number;
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
   * The worked examples this question's prompt can carry: the rendered block, and how many examples
   * it holds.
   *
   * On the prepared run rather than read off `controls.demonstrationBlocks`, for the reason
   * `sampledFor` exists beside `sampledColumns`: with a plain arm and an examples arm in the same
   * run the control is positive whether or not *this* arm attached a block, so an arm that asked for
   * examples and received none would publish as its parent under another name with every gate green.
   *
   * `masked` asks for the block whose statements went through `maskStatement`. `rewritten` is how
   * many of its examples the masker actually changed: a mask that matches nothing on a statement is
   * a mask that published the parent arm's prompt, and the funnel has to be able to say so.
   */
  readonly demonstrationsFor: (
    question: BirdQuestion,
    options?: { readonly masked?: boolean },
  ) => { readonly text: string; readonly examples: number; readonly rewritten: number } | undefined;
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
  const needsRetrieval = armsNeedRetrieval(settings.arms);
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
  // The rendered block *and* how many examples it holds. The count exists because the arm that
  // stacks examples on the dataset's hint is priced by both: one example and three are different
  // prompts at the same size column, and a joined string cannot be counted without re-parsing it.
  const demonstrationsByQuestion = new Map<
    number,
    {
      readonly text: string;
      readonly examples: number;
      readonly masked: string;
      readonly maskedExamples: number;
      readonly rewritten: number;
      /** The same neighbours with the steps each statement encodes, and how many survived. */
      readonly steps: string;
      readonly stepExamples: number;
    }
  >();
  // Every arm whose prompt this run sends, which is not `settings.arms`: a mixed arm sends one
  // prompt per source, so the blocks to load are decided by the sources too.
  const inEffect = armsInEffect(settings.arms);
  // The masked block is only built when an arm asks for it: it costs a string transform per
  // example, and a run of five plain arms should not pay for a prompt none of them sends.
  const needsMasking = inEffect.some((arm) => arm.masked === true);
  // Same rule for the step block: an arm that asks for it and finds nothing would send its
  // parent's prompt under the new name.
  const needsSteps = inEffect.some((arm) => arm.cotDemonstrations === true);
  for (const question of selected) {
    if (retrievalIndex === undefined) break;
    const textHits = retrieve(retrievalIndex, question.question, { k: 3 });
    const text = renderRetrieved(textHits);
    if (text.length > 0) retrievedByQuestion.set(question.question_id, text);
    // Same corpus, same ranking, same k: the only difference from the evidence block
    // is that each neighbour arrives with its statement.
    const hits = retrieve(retrievalIndex, question.question, { k: 3, requires: 'sql' });
    const worked = renderDemonstrationBlocks(hits);
    if (worked.length === 0) continue;
    // Cut to the raw block's width, not the budget's: a masked example is shorter, so the same
    // 2,200 characters would carry *more* of them and the pair would differ in the number of
    // examples as well as in their text. `I-84` is one lever, and the count is half of it.
    const maskedBlocks = needsMasking
      ? renderDemonstrationBlocks(hits, { statement: maskStatement }).slice(0, worked.length)
      : [];
    // The step block is built only when an arm asks for it, for the same reason the masked one
    // is: it costs a parse per example, and the parse refuses a statement whose steps it cannot
    // recover — so the count is a reading rather than a copy of `worked.length`.
    const stepBlocks = needsSteps ? renderDemonstrationBlocks(hits, { reasoning: renderSqlLike }) : [];
    // Counted against the raw block rather than assumed: the masker is a text transform that can
    // stop matching, and "it rewrote nothing" is exactly the state that makes a masked arm its
    // parent under another name.
    const rewritten = maskedBlocks.filter((block, at) => block !== worked[at]).length;
    demonstrationsByQuestion.set(question.question_id, {
      text: worked.join('\n\n'),
      examples: worked.length,
      masked: maskedBlocks.length === 0 ? '' : `${MASKED_PREAMBLE}\n\n${maskedBlocks.join('\n\n')}`,
      maskedExamples: maskedBlocks.length,
      rewritten,
      steps: stepBlocks.join('\n\n'),
      stepExamples: stepBlocks.length,
    });
  }
  const retrievedFor = (question: BirdQuestion): string | undefined => retrievedByQuestion.get(question.question_id);
  const demonstrationsFor = (
    question: BirdQuestion,
    options: { readonly masked?: boolean; readonly cot?: boolean } = {},
  ): { readonly text: string; readonly examples: number; readonly rewritten: number } | undefined => {
    const found = demonstrationsByQuestion.get(question.question_id);
    if (found === undefined) return undefined;
    // An arm that asks for the step block and finds it missing has nothing to send, for the same
    // reason the masked arm has nothing to send: a fallback would publish the parent's prompt
    // under the child's name.
    if (options.cot === true) {
      if (found.steps.length === 0) return undefined;
      return { text: found.steps, examples: found.stepExamples, rewritten: 0 };
    }
    // An arm that asks for the masked block and finds it missing has nothing to send: falling back
    // to the raw text would publish the parent's prompt as the masked arm's reading.
    if (options.masked !== true) return { text: found.text, examples: found.examples, rewritten: 0 };
    if (found.masked.length === 0) return undefined;
    return { text: found.masked, examples: found.maskedExamples, rewritten: found.rewritten };
  };

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
  const widen = inEffect.some((arm) => arm.samples === 'example');
  if (inEffect.some((arm) => arm.samples === 'profile')) {
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

  const withSamples = (
    schema: readonly SchemaTable[],
    db: string,
    rule: 'profile' | 'example',
    wanted?: readonly string[],
  ): readonly SchemaTable[] => {
    const values = (rule === 'example' ? exampleValues : sampleValues).get(db);
    if (values === undefined) return schema;
    // The narrowing is a filter over the profile rather than a second sampler, so the value order,
    // the rule and the bracket stay the arm's and only the set of columns changes.
    return attachSamples(schema, wanted === undefined ? values : narrowSamples(values, wanted));
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
  const needsSynthesis = inEffect.some((arm) => arm.definitions === 'synthesized' || arm.definitions === 'inline');
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
  const cardPlan = (arm: Arm, question: BirdQuestion): { readonly schema: readonly SchemaTable[]; readonly fields?: { readonly columns: number; readonly dropped: number } } => {
    const db = question.db_id;
    const base =
      arm.definitions === 'inline'
        ? (inlineSchemas.get(db) as SchemaTable[])
        : arm.definitions === 'dataset-subset'
          ? (subsetSchemas.get(db) as SchemaTable[])
          : (schemas.get(db) as SchemaTable[]);
    // Samples are layered on whatever the arm resolved to, not on the plain schema: an arm
    // can ask for both, and silently dropping one is a two-lever comparison nobody wrote.
    //
    // The gold's own conditions decide the columns on the oracle arm; the prompt's own hint decides
    // them on the arm that has to be runnable. Both read the question and the card, neither reads the
    // answer, and the decision itself lives in `block-columns.ts` because the card instrument
    // (`card.ts`) has to make the same one.
    const wanted =
      arm.sampleColumns === undefined
        ? undefined
        : blockColumns({
            rule: arm.sampleColumns,
            question: question.question,
            sql: question.SQL,
            schema: base,
            // The hint's third recaller reads stored values, so the rule reads the card that carries
            // them — the same card the prompt's hint is rendered from, one step before the bracket.
            values: (arm.samples === 'example' ? exampleValues : sampleValues).get(db),
          });
    // Field selection runs before the block is layered, and after nothing else: the block is a
    // property of the columns that survived, so an arm that both narrowed the card and sampled it
    // would otherwise print values on columns its own rule removed.
    const narrowedPlan = arm.cardColumns === 'gold' ? narrowFields(base, question.SQL) : undefined;
    const fields = narrowedPlan === undefined ? undefined : { columns: narrowedPlan.columns, dropped: narrowedPlan.dropped };
    const narrowed = (narrowedPlan?.schema ?? base) as SchemaTable[];
    const layered = arm.samples === undefined ? narrowed : withSamples(narrowed, db, arm.samples, wanted);
    // One return, because the two card levers are mutually exclusive by declaration: a second
    // `fields` spread after the prune branch would be a branch no arm can reach.
    const schema = arm.prune === undefined ? layered : pruneSchema({ schema: layered, question: question.question, graph: graphFor(db), hops: arm.prune }).schema;
    return { schema, ...(fields === undefined ? {} : { fields }) };
  };

  const schemaFor = (arm: Arm, question: BirdQuestion): readonly SchemaTable[] => cardPlan(arm, question).schema;

  /**
   * The card one candidate of a mixed set is sent on: the source's own card.
   *
   * A mixed arm draws each candidate from another arm and describes itself as that many prompts.
   * The harness built one card per case — the parent's — and handed it to all three, so a source
   * whose card differs arrived as a copy of the first candidate. `distinctShare` counted the
   * prompts with each source's own card, which means the guard and the run disagreed about what
   * the arm was: the guard reported three distinct prompts for `select-mixed` while the run sent
   * two, because `metadata+evidence`'s card (descriptions as a block, joins listed) collapsed into
   * `inline+evidence`'s when it was printed on the inline card.
   *
   * `select-samples` is what made the disagreement visible. Its third source carries a card-level
   * lever of its own — the sampled block — and on the parent's card there is nothing for that lever
   * to act on: the three prompts became two, on every one of the 1,532 cases, and
   * `assertMixedFeasible` refused the run. The guard was reading the right thing and the run the
   * wrong one, so the run now reads what the guard reads: one card per candidate, from its source.
   */
  const schemaForSource = (source: Arm, question: BirdQuestion): readonly SchemaTable[] => schemaFor(source, question);

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

  /**
   * The columns of a card that carry a bracket, counted the way the renderer reads them.
   *
   * `length > 0` is the renderer's test, and an entry with an empty array would print `[]` — a
   * bracket that says "this column is empty". The count uses the same test so the number and the
   * prompt cannot disagree.
   */
  const samplesOn = (schema: readonly SchemaTable[]): number =>
    schema.reduce((total, table) => total + table.columns.filter((column) => (column.samples?.length ?? 0) > 0).length, 0);

  const cardFor = async (arm: Arm, question: BirdQuestion, provider: LlmProvider): Promise<CardOutcome> => {
    const plan = cardPlan(arm, question);
    const base = plan.schema;
    const samples = arm.samples === undefined ? {} : { samples: { columns: samplesOn(base) } };
    const fields = plan.fields === undefined ? {} : { fields: plan.fields };
    const mode = arm.columnSelect;
    if (mode === undefined) return { schema: base, ...samples, ...fields };
    const reply = await provider.complete({
      messages: [
        { role: 'system', content: buildColumnPrompt(question.question, base) },
        { role: 'user', content: question.question },
      ],
      temperature: 0,
      purpose: 'columns',
    });
    const choice = parseColumnChoice(reply.text, base);
    // The two rules are not a parameter of one function: they disagree about whether a table the
    // model did not name exists at all, and a flag threaded through both would make the pair's
    // single lever a claim about the flag rather than about the rule. The widened annotation is
    // what lets one card be built from either result: only the dense rule reports a safety net,
    // so the field is present exactly when there was one — a zero would otherwise be
    // indistinguishable from "this arm has no floor".
    const applied: ColumnApplication & { readonly restored?: number } =
      mode === 'dense' ? applyDenseChoice(base, choice) : applyColumnChoice(base, choice);
    const outcome: CardOutcome = {
      schema: applied.schema,
      ...(arm.samples === undefined ? {} : { samples: { columns: samplesOn(applied.schema) } }),
      columns: {
        named: choice.named.length,
        unknown: choice.unknown.length,
        kept: applied.kept,
        total: applied.total,
        decided: choice.decided,
        ...(applied.restored === undefined ? {} : { restored: applied.restored }),
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
   * Rows for the arms that ask for them, read once per (database, table).
   *
   * One query per table is the whole cost of the lever. Reading per question would be 1,532 times
   * the work for text that does not change between questions, and it would also make the block a
   * different thing on two runs of the same arm if a driver ever returned rows in another order.
   */
  // Every database gets an entry before any arm is looked at, and every table gets one when the
  // rows are read. Both exist so the read below is total *for the tables it filled* — and which
  // tables those are is `rowSampleRows`'s answer, not the requested arms' own flags: a mixed arm
  // carries no `rowSamples`, its source does, and reading the cap off the parent left this cache
  // empty for every mixed arm with a row source (run `43466869878`).
  const rowCache = new Map<string, Map<string, readonly (readonly unknown[])[]>>();
  for (const db of schemas.keys()) rowCache.set(db, new Map());
  // `settings.arms` holds names, including an A/A copy's `#2` suffix, so the arm is looked up here
  // rather than assumed: a filter over strings would compare `undefined` to `undefined` and load
  // nothing while reporting that it had. The row count travels with the arm that asked for it, so
  // nothing below reads `rowSamples` a second time and decides again what `undefined` means.
  const requestedArms = settings.arms.flatMap((name) => {
    const arm = ARMS.find((candidate) => candidate.name === name.split('#')[0]);
    return arm === undefined ? [] : [arm];
  });
  const wanted = rowSampleRows(requestedArms);
  if (wanted !== undefined) {
    for (const [db, schema] of schemas) {
      const perTable = rowCache.get(db) as Map<string, readonly (readonly unknown[])[]>;
      for (const table of schema) {
        const columns = sampleableColumns(table).map((column) => column.name);
        const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
        // A table with no textual column stores nothing: three numbers say no more than the type
        // does, and asking the engine for them would be a query whose answer is discarded. The
        // table still gets an entry, so the renderer reads a block rather than a missing key.
        //
        // A table the engine refuses comes back with no rows, which is a table with no sample
        // rather than an error: the block is an extra, and an arm whose prompt is shorter because
        // one view is unreadable is still a prompt the run can score.
        perTable.set(
          table.table,
          columns.length === 0
            ? []
            : (await io.oracle.run(db, `SELECT ${columns.map(quote).join(', ')} FROM ${quote(table.table)} LIMIT ${String(wanted)}`)).rows,
        );
      }
    }
  }

  /**
   * The rows block for one question, or nothing when the arm did not ask or nothing was readable.
   *
   * The tables are the ones the arm's own linker names — the same set `prune` closes over — so the
   * block and the hint cannot describe two different schemas. A question that names no table gets
   * the card's first three, which is the same cap the budget imposes on every other question.
   */
  const rowsFor = (arm: Arm, question: BirdQuestion): string | undefined => {
    if (arm.rowSamples === undefined) return undefined;
    // The database read is total by construction: `schemas` throws for a database its manifest has
    // no entry for, and every database in `schemas` has a cache entry. The table read is *not* —
    // the cache holds the tables `rowSampleRows` priced, and a mixed arm's fallback can name a table
    // outside that set — so it is typed as partial and the renderer treats a missing table as one
    // with nothing to show.
    const schema = schemas.get(question.db_id) as SchemaTable[];
    const perTable = rowCache.get(question.db_id) as ReadonlyMap<string, readonly (readonly unknown[])[]>;
    const named = linkedTables(question.question, schema, SHIPPED_RECALLERS);
    const seeded = schema.filter((table) => named.has(table.table.toLowerCase()));
    // A linker that names only numeric tables leaves the block with nothing to show, and the tables
    // it names are exactly the ones whose contents the model can least infer from a type. So the
    // fallback is not "no block" but "the card's first tables", which is what a question that names
    // nothing already gets.
    const chosen = seeded.some((table) => sampleableColumns(table).length > 0) ? seeded : schema.slice(0, 3);
    // An empty render is passed through rather than turned into `undefined`: the prompt builder
    // already refuses to print an empty block, and a second guard here would be a second rule.
    // No cast on the read: a table this cache never filled is a table the renderer drops, which is
    // what it does with a table that stores no sample. The cast that used to be here claimed the
    // read was total and the first mixed arm with a row source proved it was not.
    return renderRowSamples(chosen, (table) => perTable.get(table), {
      rows: arm.rowSamples,
      budget: ROW_SAMPLE_BUDGET,
    });
  };

  /**
   * What this arm's prompt may use. One builder for every call site, so the prompt
   * that is measured and the prompt that is sent cannot disagree.
   */
  const blocksFor = (arm: Arm, question: BirdQuestion): PromptBlocks => ({
    ...(evidenceFor(arm, question) === undefined ? {} : { synthesized: evidenceFor(arm, question) }),
    ...(definitionsFor(arm, question.db_id) === undefined ? {} : { definitions: definitionsFor(arm, question.db_id) }),
    ...(retrievedFor(question) === undefined ? {} : { retrieved: retrievedFor(question) }),
    // The arm decides which block it sends, the mask decides what is in it: the pair is one lever
    // only if the same retrieval produced both, which is why the choice is a parameter here rather
    // than a second preparation.
    ...(demonstrationsFor(question, { masked: arm.masked === true, cot: arm.cotDemonstrations === true }) === undefined
      ? {}
      : {
          demonstrations: demonstrationsFor(question, { masked: arm.masked === true, cot: arm.cotDemonstrations === true })
            ?.text,
        }),
    ...(valuesFor(question) === undefined ? {} : { values: valuesFor(question) }),
    ...(rowsFor(arm, question) === undefined ? {} : { rows: rowsFor(arm, question) }),
  });

  const controls: Controls = {
    selfConsistency: selfConsistent / cases.length,
    // Corpus and block counts live here, not under `selection`: they are inputs to
    // an arm, and the gate reads them to tell a null result from an empty lever.
    retrievalCorpus: retrievalIndex === undefined ? 0 : retrievalIndex.rows.length,
    retrievedBlocks: retrievedByQuestion.size,
    demonstrationBlocks: demonstrationsByQuestion.size,
    // The step block is a different text over the same neighbours, so its count is what tells a
    // reader that the arm ran the lever rather than the parent under a new name.
    stepDemonstrationBlocks: [...demonstrationsByQuestion.values()].filter((block) => block.steps.length > 0).length,
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
        const sourceArm = resolveArm(spec.arm) as Arm;
        // The source's card, not the arm's: the run sends each candidate on the card its own
        // source asks for, and a guard that counted a different card would be measuring a
        // prompt nobody sends — which is how `select-samples` produced three distinct prompts
        // here and two in the run.
        const prompt = buildSqlPrompt(
          question.question,
          schemaForSource(sourceArm, question),
          promptFor(sourceArm, question, blocksFor(sourceArm, question)),
        );
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
    demonstrationsFor,
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
    schemaForSource,
    samplesOn,
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

/** Where this artifact came from, when it came from a workflow. */
export interface Provenance {
  readonly run?: string | undefined;
  readonly workflow?: string | undefined;
}

/** The report before any arm runs: everything the inputs alone can say. */
export function baseReport(prepared: PreparedRun, provenance: Provenance = {}): Record<string, unknown> {
  const { settings, shape, questions, limit: preparedLimit, selected, cases, unrunnable, controls } = prepared;
  const layout = settings.layout;
  return {
    // Derived, never written: a name that can disagree with the field it names will.
    dataset: datasetName(layout.split),
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
    /**
     * What the run told the endpoint it could do.
     *
     * Without it a reader cannot say whether a difference between two runs is the model or the
     * request: `glm-4.6` read as a chat model is sent a temperature and a 4,096-token budget, and
     * read as a reasoning model is sent neither. The resolved row rather than the declaration,
     * because the row is what `adaptRequest` acted on — a declaration merged onto the wrong base
     * produced records that contradicted themselves once already.
     */
    modelCapabilities: capabilitiesOf(settings.model, settings.capabilities),
    // The instrument's own settings. Same argument as the model: two runs of "the same"
    // configuration can differ by the deadline, the concurrency or the retry budget, and a
    // report that omits them cannot say whether a difference is the pipeline or the harness.
    run: {
      timeoutMs: settings.timeoutMs,
      concurrency: settings.concurrency,
      retries: settings.retries,
      // Recorded, and deliberately not a `compare.ts` coordinate: a budget that did not fire did
      // not change the result, and a budget that fires publishes no artifact at all. So it can
      // never be a silent difference between two tables — which is the only thing a coordinate is
      // for — and adding it there would mark every comparison against a run from before this field
      // as `harness DIFFERS` for a field that never acted.
      ...(settings.budgetMs === undefined ? {} : { budgetMs: settings.budgetMs }),
      /**
       * Which dispatch this table continued, when it continued one.
       *
       * A resumed reading is a table built by two processes, and a reader holding the JSON is
       * entitled to know that without diffing it against a run log: the cases in the first part were
       * scored before whatever happened between the dispatches, including a model alias moving. The
       * file name rather than the path, because the path is a runner's scratch directory and the
       * name is the only part that names the run.
       */
      ...(settings.resumeFrom === undefined ? {} : { resumedFrom: basename(settings.resumeFrom) }),
    },
    generatedAt: new Date().toISOString(),
    // Which run produced this file, when it can say.
    //
    // Every published reading in this repository is cited by workflow run id, and until now the
    // artifact could not name its own: a reader holding the JSON had to infer it from the upload
    // it arrived in. A pin recorded from an artifact needs exactly this to be traceable, and a
    // document that quotes both can be checked by a stranger.
    provenance: {
      run: provenance.run ?? null,
      workflow: provenance.workflow ?? null,
    },
    // The arms this run set out to score. A subset is a measurement of those arms, and the
    // gate needs the declaration to tell it from a report that lost a row: the run that
    // scored six arms on dev was failed for not running two it never asked for.
    armsRequested: settings.arms,
    // What was read, not what was asked for. A rate is a claim about a corpus, and the corpus is
    // not a constant: BIRD re-annotated Mini-Dev on 2026-10-28 (corrected annotations, replaced
    // instances) and this repository downloads it from a bucket URL rather than a pinned archive.
    // An artifact that names only the path cannot separate "the pipeline moved" from "the
    // questions moved", and every floor in the baseline is a floor on the corpus that set it.
    corpus: {
      digest: shape.digest,
      rows: shape.rows,
      questions: questions.length,
    },
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
        ...(arm.columnSelect === undefined ? {} : { card: 'before-column-selection' }),
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
  /**
   * The candidates this arm generated per case, for an arm that reuses them.
   *
   * In memory and not in the artifact: the selector reads each candidate's first three rows,
   * and the per-case record deliberately keeps only a fingerprint of them. Sharing a pool is a
   * within-run instrument, so the pool only has to outlive the run.
   */
  readonly pool: ReadonlyMap<string, readonly PooledCandidate[]>;
}

/** One candidate as the selector reads it: a statement, the rows it returned, and its author. */
export interface PooledCandidate {
  readonly sql: string;
  readonly rows: readonly (readonly unknown[])[];
  readonly source: string;
}

/** What `runArm` needs from outside. */
export interface ArmIo {
  readonly oracle: Oracle;
  readonly provider: LlmProvider;
  readonly second?: LlmProvider;
  /**
   * The pool another arm already generated for this case, when this arm declares `pool`.
   *
   * A function rather than a map because the arm that owns the pool runs first and the one that
   * reuses it runs later: passing the map would freeze it at the moment of the call, and the
   * first version of an experiment like this is always "the map was empty when I read it".
   */
  readonly poolFor?: (arm: string, caseId: string) => PoolLookup | undefined;
}

/**
 * What the pool lookup found: candidates, or the row in which the source arm recorded its failure.
 *
 * The second arm of the union is the fix for I-80. `41430569500` refused a run that had already
 * scored six arms because two of six hundred cases in `select-mixed` produced no candidates at all —
 * every sample died at the engine — and `reusePool` raised a plain `Error`, which `escapeKind` files
 * under `harness` and `assertHarnessClean` refuses to publish. The refusal was right (a pooled arm
 * has nothing to read there) and the diagnosis was wrong: nothing is broken in this repository, the
 * source arm simply could not answer that question, and its row says so.
 */
export type PoolLookup = { readonly pool: readonly PooledCandidate[] } | { readonly cause: CaseRun };

/**
 * What a guard is given when the runner reaches the arm-level checks.
 *
 * The arguments used to be written at each call site, which is how the register and the guard
 * stayed in step only as long as whoever added a lever remembered both. One context object means a
 * row here can be a guard *and* its own test: everything the guard reads is in one place.
 */
export interface MechanismContext {
  readonly armName: string;
  readonly arm: Arm;
  readonly runs: readonly CaseRun[];
  readonly sampledFor: (arm: Arm) => { readonly columns: number; readonly values: number };
}

/**
 * One row per lever that acts at runtime, and the guard that decides whether it acted.
 *
 * The guards used to be an if-chain inside `runArm`, and the chain is the defect this table
 * retires: the arms are data, so a lever can be declared, paired, documented and *unwired* — and
 * nothing forces the guard to exist, because the only proof a mechanism runs end to end is a paid
 * artifact. Two of the four levers added this month were published for a round before anyone
 * noticed their funnel was zero.
 *
 * Four fields make a row a claim rather than a label. `records` is the artifact field the mechanism
 * writes when it acts, `scenarios` are the end-to-end titles that prove the wiring with a real run
 * behind them, and `quiet` is a bank of cases in which the mechanism did not act: the guard has to
 * refuse it, or the row is a guard that cannot fail. `test/bird-mechanisms.test.ts` reads all four,
 * and `runArm` reads `mechanismsOf`, so this table is the only place a mechanism can be added.
 */
export interface Mechanism {
  readonly lever: keyof Arm & string;
  readonly declares: (arm: Arm) => boolean;
  readonly guard: (context: MechanismContext) => void;
  readonly records: string;
  readonly scenarios: readonly string[];
  readonly quiet: () => readonly CaseRun[];
}

/**
 * A bank of cases in which one mechanism never acted.
 *
 * `attempts: 1` is the base case of a run that needed no repair, which is what most cases in a real
 * run look like; every other field a guard reads is supplied by the row. The cast is the cost of
 * numbering the fields once: a guard reads one or two of them, and a factory that filled the whole
 * `CaseRun` would be a second copy of the type.
 */
function quietBank(overrides: Record<string, unknown>): readonly CaseRun[] {
  return Array.from(
    { length: MINIMUM_INSTRUMENT_SAMPLE },
    (_unused, index) => ({ id: String(index), attempts: 1, calls: 1, ...overrides }) as unknown as CaseRun,
  );
}

/** Every lever that acts at runtime. A lever not in this table is not guarded, so it is not a lever. */
export const MECHANISMS: readonly Mechanism[] = [
  {
    lever: 'columnSelect',
    declares: (arm) => arm.columnSelect !== undefined,
    // A choice that never removed a column is an arm that spends a call to be told what it had.
    guard: ({ armName, runs }) => assertColumnChoiceRan(armName, runs),
    records: 'columnSelection',
    scenarios: ['an arm where the model chooses the columns'],
    quiet: () => quietBank({ columnSelection: { named: 4, unknown: 0, kept: 4, total: 4, decided: true } }),
  },
  {
    lever: 'vote',
    declares: (arm) => arm.vote !== undefined && arm.vote > 1,
    // A candidate that never arrived shrinks the set the ceiling is taken over, which no
    // case-level count can see.
    guard: ({ armName, arm, runs }) => assertCandidateSurvival(armName, runs, arm.vote as number),
    records: 'candidateFailures',
    scenarios: ['records the candidates that never arrived beside the ceiling they shrank'],
    quiet: () => quietBank({ candidateFailures: { llm: 1, engine: 0, unparsed: 0 } }),
  },
  {
    lever: 'select',
    declares: (arm) => arm.select === true,
    // The other half of the same outage, one call later: the candidates arrived and the
    // adjudication did not. Counted apart from the failures above because the case still has an
    // answer, which is exactly what makes an unguarded selector outage invisible in the accuracy.
    guard: ({ armName, runs }) => assertSelectorAnswered(armName, runs),
    records: 'selectorFailed',
    scenarios: ['scores an unanswerable selector by the vote, and keeps the ceiling it could not use'],
    quiet: () => quietBank({ selectionFailed: 'llm' }),
  },
  {
    lever: 'reconcile',
    declares: (arm) => arm.reconcile !== undefined,
    // A reconcile turn that only echoed a candidate is a selector with a longer prompt.
    guard: ({ armName, runs }) => assertReconcileFired(armName, runs),
    records: 'reconcile',
    scenarios: ['the reconcile arm'],
    quiet: () => quietBank({ reconcile: { returned: true, novel: false, executable: false, adopted: false } }),
  },
  {
    lever: 'pairwise',
    declares: (arm) => arm.pairwise === true,
    // The price of a knockout is derivable (`k - 1`) and its failure is not: a comparison nobody
    // could read keeps the incumbent, so the arm returns the pool's own first candidate and scores
    // what the vote scored. Without the count that arm is indistinguishable from a tournament.
    guard: ({ armName, runs }) => assertPairwiseFired(armName, runs),
    records: 'pairwise',
    scenarios: ['the knockout arm, whose price is two calls per disagreeing case and whose failure is a silent one'],
    quiet: () => quietBank({ pairwise: { comparisons: 2, unreadable: 2 } }),
  },
  {
    lever: 'repairs',
    declares: (arm) => arm.repairs > 0,
    // On a split where the parent arm fails 40% of the cases, a repair path that never ran is the
    // parent arm with a bigger budget.
    guard: ({ armName, runs }) => assertRepairPathFired(armName, runs),
    // The row's funnel rather than the case's `attempts`: the artifact publishes the repair record,
    // and a scenario that reads a field the artifact does not carry proves nothing.
    records: 'repair',
    scenarios: ['a repair arm'],
    quiet: () => quietBank({ attempts: 1 }),
  },
  {
    lever: 'emptyRetry',
    declares: (arm) => arm.emptyRetry !== undefined,
    // Two halves and only one of them unconditional: the drop costs nothing, the turn needs every
    // candidate to come back empty, so the refusal is "neither happened".
    guard: ({ armName, runs }) => assertEmptyRetryFired(armName, runs),
    records: 'emptyRetry',
    scenarios: ['spends one turn on a candidate set that came back empty, and adopts the answer'],
    quiet: () => quietBank({ emptyRetried: false, emptyDropped: 0 }),
  },
  {
    lever: 'audit',
    declares: (arm) => arm.audit !== undefined,
    // An audit arm whose audit never fired is a single-call arm with a longer name.
    guard: ({ armName, runs }) => assertAuditFired(armName, runs),
    records: 'audit',
    scenarios: ['the audit arm'],
    quiet: () => quietBank({ audit: { fired: false, named: 0, rewritten: false } }),
  },
  {
    lever: 'ground',
    declares: (arm) => arm.ground === true,
    // The rewrite is silent by construction: the statement changes, the score does not move, and a
    // dead domain reader looks exactly like a corpus whose spellings were already right.
    guard: ({ armName, runs }) => assertGroundingFired(armName, runs),
    records: 'grounding',
    scenarios: ['the grounding arm'],
    quiet: () => quietBank({ grounding: { substitutions: 0, refused: 0 } }),
  },
  {
    lever: 'intent',
    declares: (arm) => arm.intent !== undefined,
    // Asked and never rendered is the one state in which this arm is its parent plus a rule line
    // and an extra call. Every other refusal rate is the measurement, so the guard refuses only
    // the zero — a guard on the *rate* would refuse the reading it exists to publish.
    guard: ({ armName, runs }) => assertIntentFired(armName, runs),
    records: 'intent',
    scenarios: ['renders the fourth candidate from a query object, and counts what the vocabularies asked for'],
    quiet: () => quietBank({ intent: { read: 'no-object' } }),
  },
  {
    lever: 'samples',
    declares: (arm) => arm.samples !== undefined,
    // An arm that asks for samples and gets none is its parent under another name.
    guard: ({ armName, arm, sampledFor }) => assertSamplesRan(armName, sampledFor(arm)),
    // The control the runner takes, not the row's block funnel: the samples arm is priced by how
    // many columns carried values, and the scenario reads exactly that count.
    records: 'sampledColumns',
    scenarios: ['puts the stored values of bounded columns on the card, and counts what it put there'],
    quiet: () => quietBank({}),
  },
  {
    lever: 'sampleColumns',
    declares: (arm) => arm.sampleColumns !== undefined,
    // The same rule one level down: a rule that decides *which* columns carry the block can keep
    // none of them on every case while the profile it reads is full of values.
    guard: ({ armName, runs }) => assertSampleBlockFired(armName, runs),
    records: 'sampleBlock',
    scenarios: ['a value block narrowed to the columns the statement filters on'],
    quiet: () => quietBank({ sampleBlock: { columns: 0 } }),
  },
  {
    lever: 'cardColumns',
    declares: (arm) => arm.cardColumns !== undefined,
    // The rule's whole claim is a smaller card, so a run in which it removed nothing anywhere is its
    // parent renamed — and the delta it publishes would be read as a statement about perfect linking.
    guard: ({ armName, runs }) => assertFieldBlockFired(armName, runs),
    records: 'fieldBlock',
    scenarios: ['a card cut down to the fields the gold statement names'],
    quiet: () => quietBank({ fieldBlock: { columns: 4, dropped: 0 } }),
  },
  {
    lever: 'demonstrations',
    declares: (arm) => arm.demonstrations === true,
    // An arm that asks for worked examples and receives none is its parent renamed. The count is
    // per case, not `controls.demonstrationBlocks`: with a plain arm in the same run the control is
    // positive whether or not this arm attached a block.
    guard: ({ armName, runs }) => assertDemonstrationsFired(armName, runs),
    records: 'demonstrations',
    scenarios: ['attaches worked examples to the prompt, and counts the cases that carried one'],
    // A bank in which the arm exists and no prompt carried an example: the three ways that happens
    // (no neighbour with a statement, the budget consumed by the first example, a block the run
    // never built) all leave this bank behind.
    quiet: () => quietBank({}),
  },
  {
    lever: 'masked',
    declares: (arm) => arm.masked === true,
    // The mask is a text transform, and a transform that matches nothing produces the parent's
    // prompt at the parent's accuracy. Its half of a one-lever pair is one field.
    guard: ({ armName, runs }) => assertMaskingFired(armName, runs),
    records: 'demonstrations',
    scenarios: ['masks the schema out of the worked examples, and counts the ones it rewrote'],
    // Examples that arrived and came through the masker intact: the bank the register exists for,
    // because that arm's accuracy is its parent's and nothing else in the row says so.
    quiet: () => quietBank({ examples: 3, masked: 0 }),
  },
  {
    lever: 'dissent',
    declares: (arm) => arm.dissent !== undefined,
    // A conditional call has to be seen firing *and* seen arriving: the two failures produce the
    // same published accuracy and call for opposite fixes. The verification turn is the same call
    // one step later, so it is read here rather than given a row that would run the guard twice.
    guard: ({ armName, arm, runs }) => assertDissentFired(armName, runs, MINIMUM_INSTRUMENT_SAMPLE, arm.dissentVerify),
    records: 'dissent',
    scenarios: [
      'a fourth opinion bought only on the cases the pool agreed',
      'the bought opinion put to the selector instead of in front of it',
    ],
    quiet: () => quietBank({ dissent: { asked: false, arrived: false, distinct: false, adopted: false } }),
  },
  {
    lever: 'decompose',
    declares: (arm) => declaresDecomposition(arm),
    // A format the model ignored is not a prompt that did not help.
    guard: ({ armName, runs }) => assertDecompositionFired(armName, runs),
    records: 'decomposition',
    scenarios: [
      'counts the steps of a decomposed candidate inside a sampling arm',
      'counts the steps a decomposed reply wrote, not the instruction it was given',
    ],
    quiet: () => quietBank({ decomposition: { candidates: 1, steps: 0 } }),
  },
];

/** The mechanisms an arm declares, in the order their guards run. */
export function mechanismsOf(arm: Arm): readonly Mechanism[] {
  return MECHANISMS.filter((mechanism) => mechanism.declares(arm));
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
  assertSampleRule(arm);
  // ...and a card decided by two rules is a delta about which one ran last.
  assertCardRule(arm);
  // ...and a gate in front of a chooser that spends nothing, or a pool of one, is a second name
  // for the arm it gates.
  assertResultGate(arm);
  // ...and evidence rendered into a prompt no judge reads is a declaration, not a lever.
  assertEvidence(arm);
  // ...and a mask with no examples under it is a name for the parent arm.
  assertMaskingRule(arm);
  // ...and a temperature on an arm that draws once is one draw with noise, refused before the run
  // reports it as a reading about sampling.
  assertTemperature(arm);
  // ...and a dissent that names one of the arm's own sources is a fourth vote, refused before a
  // single call is spent on it.
  assertDissentRule(arm);
  // ...and a rule that is declared beside a lever only the model selector reads is a lever that
  // would be published without ever being wired.
  assertRuleSelection(arm);
  /**
   * The temperature every candidate this arm draws is sent at.
   *
   * It is the arm's own when it declares one and 0.7 otherwise, and it is resolved here rather
   * than at each pipeline because a candidate's temperature belongs to the arm that buys it: a
   * mixed arm's three candidates come from three *source* arms, a source declares no `vote`, and
   * the pipeline used to read the temperature off the source — which sent 0 and turned every
   * "sample" in the catalogue into a repeated deterministic request.
   */
  const samplerTemperature = arm.temperature ?? 0.7;
  /** What this arm drew per case, in the shape a pooled arm reads. */
  const collected = new Map<string, readonly PooledCandidate[]>();
  // A mixed arm runs three configurations under one label; if one of them repairs or
  // samples, the reported cost is wrong and the comparison loses its meaning.
  if (arm.mixed !== undefined) assertCandidatePasses(arm);
  /**
   * What this case's prompt carried of the worked examples, when it carried any.
   *
   * One expression for both paths that built a prompt, because the block is decided by the arm and
   * the prepared run rather than by how the case ended: a case whose statement the engine refused
   * still read the examples, and a guard that counted only successful cases would read an engine
   * outage as a lever that never fired.
   *
   * `rewritten` rides beside `examples` because masking is a text transform: an arm whose examples
   * arrived intact has published its parent's prompt, and that state is invisible in an accuracy.
   */
  const demonstrationsOf = (question: BirdQuestion): Pick<CaseRun, 'examples' | 'masked'> => {
    if (arm.demonstrations !== true) return {};
    const block = prepared.demonstrationsFor(question, { masked: arm.masked === true });
    if (block === undefined) return {};
    return { examples: block.examples, ...(arm.masked === true ? { masked: block.rewritten } : {}) };
  };
  const breaker = createFailureBreaker(name, cases.length);
  // The case body, as a function of the question rather than as the pool's argument, because the
  // pool now also has to decide whether to start it: a stopped run makes no further calls.
  const scoreOne = async (question: BirdQuestion): Promise<CaseRun> => {
    // Counted, not derived: a plan costs two calls, a selector costs one, and a
    // configuration-derived count got both wrong in opposite directions.
    const counter = withCallCounter(provider);
    const secondCounter = secondProvider === undefined ? undefined : withCallCounter(secondProvider);
    // The card this case was given. Assigned inside the wrapper below rather than here: the card is
    // the first call an arm makes, so building it outside made it the one call that could still take
    // a whole run down — which is exactly what the wrapper above this line exists to prevent, and
    // what a refused card did to a run until a test asked for one.
    let card: ReturnType<PreparedRun['cardOf']> | undefined;
    // The most columns carrying stored values across this case's candidates. A mixed arm sends one
    // opinion per source, and the lever under test may ride on only one of them, so the block is a
    // property of the *set* and the pre-registered criterion for `select-samples` reads this.
    let candidateColumns = 0;
    // Whether this case drew its candidates here. A pooled arm reads another arm's, so it has no
    // card of its own to report and a zero would read as "the block reached nothing".
    let drewCandidates = false;
    // Both models' calls are this case's cost. Summing two counters keeps the number
    // measured on each side instead of estimated from the arm's configuration.
    const callsMade = (): number => counter.calls() + (secondCounter?.calls() ?? 0);
    // Both models' usage is this case's cost, for the same reason both counters are. Added on
    // the way out rather than at each of the eleven return sites in this function, because a
    // cost that has to be remembered per branch is a cost that will be missing from one.
    const costOfCase = (): Pick<CaseRun, 'tokens'> & { readonly samplingOmitted?: Readonly<Record<string, number>> } => {
      const primary = counter.usage();
      const second = secondCounter?.usage();
      const dropped = new Map<string, number>();
      for (const ledger of [counter.omitted(), secondCounter?.omitted() ?? new Map<string, number>()]) {
        for (const [parameter, count] of ledger) dropped.set(parameter, (dropped.get(parameter) ?? 0) + count);
      }
      // Which base answered, unioned over both counters: a cross arm routinely asks two
      // endpoints, and the case is served by both. Kept as a sorted list rather than a map
      // because one case is one observation — how many cases each base served is the arm's
      // column, and counting it here would give that column two definitions.
      const served = new Set<string>();
      for (const ledger of [counter.servedModels(), secondCounter?.servedModels() ?? new Map<string, number>()]) {
        for (const model of ledger.keys()) served.add(model);
      }
      return {
        ...(dropped.size === 0 ? {} : { samplingOmitted: Object.fromEntries(dropped) }),
        tokens: {
          prompt: primary.promptTokens + (second?.promptTokens ?? 0),
          completion: primary.completionTokens + (second?.completionTokens ?? 0),
          chars: primary.chars + (second?.chars ?? 0),
          unbilled: primary.unbilled + (second?.unbilled ?? 0),
          ...cacheFieldOf(primary, second),
          ...reasoningFieldOf(primary, second),
          ...(served.size === 0 ? {} : { served: [...served].sort() }),
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
      // The card first, through the counter: on a column-choosing arm the choice is a call, and a
      // card decided by an uncounted provider would report the lever as free.
      card = await prepared.cardFor(arm, question, counter.provider);
      const schema = card.schema;
      // A pipeline is a prompt plus a budget, so building one per configuration costs
      // nothing and lets a mixed arm ask the same question three different ways.
      // The execute hook exists for repairs only: without repairs it would turn an
      // execution failure into a thrown pipeline error and hide the statement that
      // failed, which is the one thing a diagnosis needs.
      const providerFor = (which: 'primary' | 'second' = 'primary'): LlmProvider =>
        which === 'second' && secondCounter !== undefined ? secondCounter.provider : counter.provider;
      const pipelineFor = (
        target: Arm,
        which: 'primary' | 'second' = 'primary',
        overrides: { readonly linking?: boolean; readonly repairs?: number; readonly temperature?: number } = {},
      ): ReturnType<typeof createPipeline> =>
        createPipeline({
          provider: providerFor(which),
          // The repair count is resolved here, once, because the execute hook is attached from the
          // same number: an override that raised `maxRepairs` without attaching the hook would arm
          // a loop that can never hear the engine, which is the defect `emptyRetry` had.
          maxRepairs: overrides.repairs ?? target.repairs,
          linking: overrides.linking ?? target.linking,
          ...(target.linkEvidence === undefined ? {} : { linkEvidence: target.linkEvidence }),
          interpret: target.interpret === true,
          plan: target.plan === true,
          // The plan call is the one the arm moves to the second model; the statement stays on
          // the primary. Passing the provider rather than a model name is what keeps the arm's
          // cost on the meter that will be billed for it.
          ...(target.planBy === undefined ? {} : { planProvider: providerFor(target.planBy) }),
          decompose: target.decompose === true,
          ...(target.repairFeedback === undefined ? {} : { repairFeedback: target.repairFeedback }),
          ...(target.audit === undefined ? {} : { audit: target.audit }),
          // The pipeline owns the turn on a single-candidate arm, so the arm's switch has to reach
          // it. It did not: `emptyRetry` was read by the harness's own sampling branch and never
          // passed to `createPipeline`, which meant `inline+evidence+empty` — the arm the mechanism
          // was measured on — spent no call and reported no funnel.
          //
          // `values` is the harness's mode and not the pipeline's: the pipeline has a provider and
          // no engine, so it cannot look a literal up. An arm that names it is one that always has
          // three candidates, where the harness owns the turn; passing the mode down would give the
          // pipeline a switch for a lookup it cannot make.
          ...(target.emptyRetry === undefined || target.emptyRetry === 'values' ? {} : { emptyRetry: target.emptyRetry }),
          // The domain reader is the harness's, because the pipeline has no engine: it asks the
          // oracle for the column's values, resolving the statement's own aliases and unioning an
          // unqualified column over every table the statement reads. A column that resolves to no
          // table at all is reported as unknown rather than as empty, which is the difference
          // between "nothing is stored there" and "I did not look".
          ...(target.ground === true
            ? { readColumnValues: groundingReader((sql: string) => oracle.run(question.db_id, sql), question.db_id) }
            : {}),
          // The temperature is resolved in this order and the order is the repair: the caller's
          // override, then the arm that owns the turn, then the rule — 0.7 for a sampled arm, 0 for
          // a single draw, where sampling would be a cost with no second opinion to average.
          //
          // The override exists because a mixed arm's candidates are drawn from *source* arms, and
          // a source declares no `vote`: `pipelineFor(sourceArm, …)` therefore read the source's
          // `vote` as undefined and sent **0** to every candidate of every multi-prompt arm. Three
          // prompts drawn at 0 are three deterministic requests, so the arms named "three samples"
          // were three draws of the same answer and the whole sampling family was measured at the
          // wrong coordinate. Mini-Dev 496 is where it surfaced: `select-mixed-spread2` returned
          // 1.33 distinct executed results per question against 1.26 for three, and 462 of 493
          // questions gained no new answer from the second pass — a repeat, exactly what a
          // temperature of zero predicts.
          temperature: overrides.temperature ?? target.temperature ?? (target.vote === undefined ? 0 : 0.7),
          prompt: promptFor(target, question, prepared.blocksFor(target, question)),
          // Two mechanisms need the engine's answer, not one: the repair loop and the empty-result
          // turn. The hook used to be attached only when `repairs > 0`, so `inline+evidence+empty`
          // — an arm whose entire lever is that turn — never saw a row count and never fired. The
          // guard on the arm instead of on the hook is what made a published arm a no-op.
          ...((overrides.repairs ?? target.repairs) === 0 && target.emptyRetry === undefined
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
                    // The row count is the return value, not a side channel: the empty-result turn
                    // reads it, and a hook that returns nothing makes "returned no rows" a state
                    // the pipeline can never observe. On a repair-only arm the value is unused,
                    // which is why the defect survived — `inline+evidence+empty` spent no call.
                    return { rows: result.rows.length };
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
        const candidates: PooledCandidate[] = [];
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
        // The first reply of the set, kept because it is the only one the prompt alone
        // produced: the later draws are the same prompt at a non-zero temperature.
        let firstShape: ReplyShape | undefined;
        // What the intent source's one reply was read as, on the arm that drew it. Kept as a
        // record rather than folded into a counter because the *reason* is the instrument: a run
        // whose refusals are all `no-object` needs a clearer rule, and one whose refusals are
        // `unsupported-function` needs a wider grammar, and those are opposite next steps.
        let intentRecord: IntentRecord | undefined;
        // A pooled arm generates nothing: it reads the candidates another arm already drew for
        // this case, and spends its one call on what it does with them. The lookup is a function
        // so that "the pool was not there" is a sentence rather than an empty set — an arm that
        // quietly generated its own candidates would be its parent under a new name, and its
        // delta would be the pool's noise wearing the label of a lever.
        const lookup = arm.pool === undefined ? undefined : io.poolFor?.(arm.pool, String(question.question_id));
        // A case the source arm could not fill is a gap in the *sample*, not a bug here: the pooled
        // arm has nothing to read, and the honest row is the one the source already wrote, filed under
        // the same failure kind. Refusing the run instead would throw away every other case it scored
        // (I-80, found by a real run rather than by reading).
        if (lookup !== undefined && 'cause' in lookup) {
          return {
            id: String(question.question_id),
            passed: false,
            predicted: '',
            strict: false,
            attempts: 0,
            errorKind: lookup.cause.errorKind ?? 'other',
            error: `pool: ${String(arm.pool)} produced no candidates for this case (${lookup.cause.error ?? 'no reason recorded'})`.slice(0, 400),
            // No `candidateRecall`: this arm never held a candidate set, so it has no ceiling for
            // this case. Writing `false` here was the same defect as the one above in miniature —
            // it would have claimed the arm measured a pool it could not read, and `assertPoolShared`
            // would have counted the case as verified. The source's row carries the real `false`,
            // because the source did have an empty set and that is a measurement.
            calls: callsMade(),
          };
        }
        const reused =
          arm.pool === undefined ? undefined : reusePool(name, arm.pool, lookup?.pool, String(question.question_id));
        for (const candidate of reused ?? []) {
          candidates.push(candidate);
          const drawn = (survival[candidate.source] ??= { generated: 0, survived: 0 });
          drawn.generated += 1;
          drawn.survived += 1;
        }
        for (let sample = 0; reused === undefined && sample < arm.vote; sample += 1) {
          drewCandidates = true;
          try {
            // A mixed arm draws each candidate from a different decomposition. The
            // sources repair nothing by contract (asserted in the test suite), so a
            // candidate is always one generation and the cost stays three calls.
            const sources = arm.mixed;
            const source = sources === undefined ? name : (sources[sample % sources.length] as string);
            const spec = parseMixedSource(source);
            const drawn = (survival[source] ??= { generated: 0, survived: 0 });
            drawn.generated += 1;
            // The hint override is keyed by the *source*, not by the arm that resolves it: two
            // sources can share one prompt shape and differ in whether the linker's answer is in
            // front of the model, and keying by arm would silently apply the override to both.
            const hinted = arm.sourceLinking?.[source];
            const repairs = arm.sourceRepairs?.[source];
            // Resolved once: the loop reads the source arm four times (sampler, card, prompt,
            // linker answer) and a second `resolveArm` per read is four chances to disagree.
            const sourceArm = resolveArm(spec.arm) as Arm;
            // The pre-built pipeline is only good for the case nothing about this source was
            // overridden; once either override is present the pipeline is built for it, because a
            // reused pipeline would apply the parent's count to a source that asked for another.
            // The temperature belongs to the arm that buys the candidates, not to the source
            // that writes one of them: a source is a prompt, and `vote` — the number of draws —
            // is the mixed arm's. Passing it explicitly is what makes "three samples" true of a
            // mixed arm; without it every candidate went out at the single-draw temperature.
            const sampler =
              sources === undefined && hinted === undefined && repairs === undefined
                ? pipeline
                : pipelineFor(sourceArm, spec.provider, { linking: hinted, repairs, temperature: samplerTemperature });
            const candidateSchema = sources === undefined ? schema : prepared.schemaForSource(sourceArm, question);
            candidateColumns = Math.max(candidateColumns, prepared.samplesOn(candidateSchema));
            // The one source whose statement is rendered rather than written. It reads the same
            // card, the same evidence and the same linker answer, and differs by one rule line, so
            // the reading it produces is about the vocabulary and not about the context.
            const askedSample: { sql: string; shape?: ReplyShape; decomposedSteps?: number } =
              sources !== undefined && sourceArm.intent === 'query'
                ? await (async () => {
                    const read = await askIntent(providerFor(spec.provider), {
                      question: question.question,
                      schema: candidateSchema,
                      prompt: promptFor(sourceArm, question, prepared.blocksFor(sourceArm, question)),
                      linking: hinted ?? sourceArm.linking,
                    });
                    // Written before the refusal throws: a candidate that never became a statement
                    // is the case the report needs a reason for, and the catch below only knows
                    // that *something* did not arrive.
                    intentRecord = read.ok
                      ? { read: 'ok', sql: read.sql }
                      : { read: read.reason as IntentRecord['read'], detail: read.detail.slice(0, 160) };
                    if (!read.ok) throw Object.assign(new Error(read.detail), { code: 'NL2C_E_LLM_INVALID_RESPONSE' });
                    return { sql: read.sql };
                  })()
                : await sampler.ask({ question: question.question, schema: candidateSchema });
            if (firstShape === undefined && askedSample.shape !== undefined) firstShape = askedSample.shape;
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
        // Recorded before the empty-set branch, so a case whose pool is empty is a pool the next
        // arm can read as empty rather than a key that is missing: the difference between "this
        // case produced nothing" and "this arm never ran" is the whole reason the lookup throws.
        collected.set(String(question.question_id), candidates);
        if (candidates.length === 0) {
          const outage = sampleErrors.length === arm.vote && sampleErrors.every((kind) => kind === 'llm');
          return {
            id: String(question.question_id),
            passed: false,
            predicted: '',
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
            ...(firstShape === undefined ? {} : { shape: firstShape }),
            // The case where every candidate died is the case a refusal reason is most needed for:
            // an arm whose fourth source was the only one that failed still has to say why.
            ...(intentRecord === undefined ? {} : { intent: intentRecord }),
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
        // One definition of equality for the vote, for the unanimity the condition reads and for
        // the dissent's own `distinct` flag. Three comparisons that must agree about what "the
        // same answer" means, or the lever's condition and the reading of its effect would be
        // describing two different sets — and `resultKey` is already the official judge's
        // equality, which is why it is reused instead of compared as text.
        const sameResult = (left: { readonly rows: readonly (readonly unknown[])[] }, right: { readonly rows: readonly (readonly unknown[])[] }): boolean =>
          judgeOfficial(left.rows, right.rows) === 'match';
        // The conditional fourth opinion. Bought here, before the vote, because the vote is what
        // the condition is about and because the set the vote decides over is the set the selector
        // then reads: a candidate added after the decision would move the ceiling without moving
        // the answer, and the two have to be moved by the same set or neither reading is the arm's.
        let dissentRecord:
          | { asked: boolean; arrived: boolean; distinct: boolean; adopted: boolean; pairwise?: { asked: boolean; choseDissent: boolean } }
          | undefined;
        let dissentCandidate: PooledCandidate | undefined;
        if (arm.dissent !== undefined) {
          // A pool of one agreed vacuously, and the case for a fourth opinion is a case about
          // three opinions that agreed. The population is therefore the cases where at least two
          // candidates survived *and* they returned the same rows.
          const poolVote = majorityResult(choosable, sameResult);
          const asked = choosable.length > 1 && poolVote.groups === 1;
          const record = { asked, arrived: false, distinct: false, adopted: false };
          dissentRecord = record;
          if (asked) {
            const spec = parseMixedSource(arm.dissent);
            const drawn = (survival[arm.dissent] ??= { generated: 0, survived: 0 });
            drawn.generated += 1;
            try {
              const sampler = pipelineFor(resolveArm(spec.arm) as Arm, spec.provider, { temperature: samplerTemperature });
              const reply = await sampler.ask({ question: question.question, schema });
              const executed = await oracle.run(question.db_id, reply.sql);
              if (executed.ok) {
                drawn.survived += 1;
                record.arrived = true;
                const bought = { sql: reply.sql, rows: executed.rows, source: arm.dissent };
                // `distinct` is the only state in which the call bought information: a fourth
                // statement that returns the pool's own answer is a fourth vote for it. This is
                // the number that separates "the extra opinion agreed" from "the extra opinion
                // disagreed and lost the vote", which the score cannot tell apart at all.
                record.distinct = !sameResult(bought, poolVote.winner as PooledCandidate);
                if (record.distinct) dissentCandidate = bought;
              } else {
                // The same accounting as a candidate that never arrived during generation: the
                // engine refused it, so the set has no such member and the loss is counted where
                // it happened rather than read afterwards as a lower ceiling.
                sampleErrors.push(undefined);
                lost.engine += 1;
              }
            } catch (error) {
              const kind = classifyCandidateFailure((error as { code?: string }).code);
              sampleErrors.push(kind === 'llm' ? 'llm' : undefined);
              lost[kind] += 1;
            }
          }
        }
        // A verifying arm does not put the bought candidate in front of the selector: the whole
        // point of `41551887197` is that a fourth candidate in the list is read and not used. The
        // candidate is still part of what this arm holds — the ceiling counts it, and the verdict
        // record carries it — but the prompt the selector reads is its parent's, byte for byte.
        const considered: typeof candidates =
          dissentCandidate === undefined || arm.dissentVerify === 'pairwise' ? choosable : [...choosable, dissentCandidate];
        const majority = majorityResult(considered, sameResult);
        let winner = majority.winner as { sql: string; rows: readonly (readonly unknown[])[]; source: string };
        let selectedByModel: boolean | undefined;
        let selectedByRule: CaseRun['selectedByRule'];
        let selectionFailed: 'llm' | 'truncated' | 'harness' | undefined;
        let retryFailed: 'llm' | 'truncated' | 'harness' | undefined;
        // Declared here rather than inside the select branch because the case row is built after
        // it: the funnel is a property of the answer, and the answer is assembled at the end.
        let reconciled: CaseRun['reconcile'];
        // The tournament's own record, declared here for the same reason: what the knockout spent
        // is a property of the answer, and the answer is assembled at the end of this block.
        let pairwiseTurn: CaseRun['pairwise'];
        // The order the selector will read, which is the raw order unless the arm permutes it.
        // The vote above deliberately ran on the unpermuted set, so a tie it breaks is broken the
        // same way in both arms; only the selector's information changes. `ordered` is what the
        // per-candidate record below is written from, because a verdict is only attributable if
        // it is filed under the slot the judge actually saw.
        const ordered = arm.shuffle === true ? shuffleByCase(considered, question.question_id) : considered;
        if (arm.gate === 'results' && majority.groups === 1) {
          // The pool agreed, so the adjudication has nothing to decide and the call is not cheap,
          // it is unspendable: every member returned the same rows under the judge's own equality,
          // so every member is worth exactly what the model would have picked. The choice is made
          // by a rule that costs nothing, and `selectedByRule` records it, which is what keeps the
          // row readable as "the gate fired" rather than as "the selector answered cheaply".
          //
          // `spendOf` is the instrument: it counts the cases that reached a selector, so a gated
          // arm's `spend.asked` is the number of questions that had something to ask about.
          selectedByRule = decideByRule(arm.gateRule ?? 'shortest', ordered);
          winner = ordered[selectedByRule.index] as typeof winner;
        } else if (arm.select === true && arm.selectRule !== undefined) {
          // The choice the fourth call was buying. Every input is already in hand — the executed
          // rows and the statement text — so this branch spends nothing and cannot fail: there is
          // no reply to read, no index to parse and no endpoint to be down. That is the whole
          // claim of the arm, and the reason `spendOf` reports no decision here rather than a
          // decision that cost zero: a rule did not price a call, it replaced one.
          selectedByRule = decideByRule(arm.selectRule, ordered);
          winner = ordered[selectedByRule.index] as typeof winner;
        } else if (arm.select === true) {
          // What the selector reads, as opposed to what the arm runs: on a canonical arm the
          // text carries no author signature, and `winner` below still comes from the raw set.
          const readable = readableCandidates(ordered, arm.canonical);
          // The model sees what the vote cannot: the shape of each result. A statement
          // that answers a "how many" with 500 rows is wrong for a reason no majority
          // of identical mistakes will reveal.
          // Which candidates returned the same rows, computed only for the arm that shows it.
          // Every other arm passes no marks, so its prompt stays byte-identical to the one it
          // was measured with and the delta between the pair is the marks and nothing else.
          // A reconcile arm needs the same partition, because the grouping *is* its prompt: the
          // marks are computed whenever either arm asks for them, and the selector prompt still
          // only states them when `agreement` is set, which keeps the marked/unmarked delta the
          // marks and nothing else.
          const marks =
            arm.agreement === true || arm.reconcile !== undefined ? agreementMarks(readable.map((candidate) => candidate.rows)) : [];
          const offered = readable.map((candidate, index) => ({
            sql: candidate.sql,
            rows: candidate.rows.length,
            columns: candidate.rows[0]?.length ?? 0,
            preview: JSON.stringify(candidate.rows.slice(0, 3)).slice(0, 300),
            ...(arm.sourcesVisible === true ? { source: candidate.source } : {}),
            ...(marks[index] === undefined ? {} : { agreesWith: marks[index] }),
          }));
          // `counter.provider`, not `provider`: this call is part of the arm's price, and
          // the first version of this counter left it out — which the gate caught on the
          // very next run ("select samples 3 times and reports 3 calls per case").
          const judge = arm.judge === 'second' && secondCounter !== undefined ? secondCounter.provider : counter.provider;
          // The instruction and the reader follow the judge's declared capability, and only on an
          // arm that asked for it: `judgeFormat` defaults to `strict`, which is what every
          // published selector reading was taken with, so an arm name cannot silently change the
          // question it answers between one run and the next.
          const judgeReasoning = arm.judgeFormat === 'capability' && judge.capabilities?.thinksAloud === true;
          // The adjudication is the one call in this branch that used to be bare, and the failure
          // it produced was misread by every reader downstream: an escaped error returns a row
          // with no candidate record, so the ceiling of a case the pool *did* answer disappeared
          // and `assertPoolShared` reported it as a pool that was never shared. The vote above
          // already decided this case; a selector that could not answer leaves that decision
          // standing and is counted, which is the difference between a lever that did not run and
          // a case that was answered wrong.
          if (arm.reconcile === 'groups') {
            // The lever: hand over the result groups, ask for a statement. One call, one statement,
            // the same price as the index the parent arm asks for — so the delta between the two
            // arms is the output format and nothing else. The reply is adopted when the engine runs
            // it, whatever it says: scoring a statement the model wrote and then ignored would be
            // measuring the vote under the arm's name.
            //
            // `reconcileAdopt` is the one policy this branch cannot infer from the reply, and the
            // fifth dispatch (`41453395203`) is why it exists: `select-cross-pooled-reconcile`
            // adopted every reply it could run, and 514 of its 600 replies restated a candidate in
            // other words. It scored 359 against the free count's 380, and the loss is where those
            // restatements are: cases the vote had already answered were overwritten by a
            // paraphrase of the answer. An arm that adopts everywhere therefore cannot say what the
            // 86 statements nobody wrote were worth, which is the only population a reconcile turn
            // reaches and a selector cannot. This policy hands the restatements back and keeps the
            // corrections, at the same prompt and the same one call.
            const groups = resultGroups(offered);
            let reply: { text: string } | undefined;
            try {
              reply = await judge.complete({
                messages: [
                  { role: 'system', content: buildReconcilePrompt(question.question, groups) },
                  { role: 'user', content: question.question },
                ],
                // The same temperature the selector uses. The instruction asks for a line per group
                // before the statement, and a chat model that ignores that and answers with the
                // block alone is read correctly: `extractSql` takes the last fenced statement.
                temperature: 0,
                purpose: 'reconcile',
              });
            } catch (error) {
              // The same rule as the selector's: an outage leaves the vote's decision standing and
              // is counted. A reconcile turn that never arrived must not look like a reconcile
              // that disagreed.
              selectionFailed = escapeKind(error);
            }
            const written = reply === undefined ? '' : extractSql(reply.text);
            // A restatement is a reply that says what a candidate already said, compared on the
            // statement as the engine reads it: whitespace is not authorship.
            const novel = written.length > 0 && !readable.some((candidate) => candidate.sql.trim() === written.trim());
            // The policy, and the only thing `reconcileAdopt` changes. A `'novel'` arm scores what
            // the vote already decided on a restatement; an `'always'` arm scores the paraphrase.
            const keep = arm.reconcileAdopt !== 'novel' || novel;
            let executed = false;
            if (written.length > 0 && inspectSql(written).ok) {
              // Run even a reply the policy will hand back, because `executable` is a property of
              // the statement and not of the policy: two arms whose funnels are read column by
              // column must agree on the columns the policy does not govern. The query costs no
              // tokens, and the alternative — skipping it — would make the restatement population
              // unmeasurable in the one artifact that is supposed to measure it.
              const run = await oracle.run(question.db_id, written);
              if (run.ok) {
                executed = true;
                if (keep) winner = { sql: written, rows: run.rows, source: 'reconcile' };
              }
            }
            reconciled = {
              returned: written.length > 0,
              novel,
              executable: executed,
              adopted: executed && keep,
            };
            // The turn produced something runnable, which is what `selectedByModel` has always
            // meant. Whether the policy scored it is `reconcile.adopted`: an arm that hands a
            // restatement back still had a usable reply, and folding the policy into this flag
            // would make two arms' `selectorDecided` differ for a reason that is not the model.
            selectedByModel = executed;
          } else {
          let decision: { index: number; decided: boolean; sql: string };
          try {
            decision =
              arm.pairwise === true
                ? await (async () => {
                    const turn = await chooseCandidatePairwise(judge, question.question, readable);
                    pairwiseTurn = { comparisons: turn.comparisons, unreadable: turn.unreadable };
                    return turn;
                  })()
                : await (async () => {
                    // The evidence is rendered from the arm's own card and the candidates it is
                    // about to show: the columns of the tables those statements name, and nothing
                    // else. `undefined` when the card names none of them, which leaves the prompt
                    // byte-identical to the one the unmarked arms were measured with.
                    const evidence = arm.selectorEvidence === 'columns' ? columnEvidence(schema, readable) : undefined;
                    const reply = await judge.complete({
                      messages: [
                        { role: 'system', content: buildSelectionPrompt(question.question, offered, { reasoning: judgeReasoning, ...(evidence === undefined ? {} : { evidence }) }) },
                        { role: 'user', content: question.question },
                      ],
                      temperature: 0,
                      purpose: 'select',
                    });
                    const applied = applySelection(reply.text, offered, { reasoning: judgeReasoning });
                    return { index: applied.index, decided: applied.decided, sql: (offered[applied.index] as { sql: string }).sql };
                  })();
          } catch (error) {
            selectionFailed = escapeKind(error);
            // The vote's own winner, found in the order the selector was shown: the identity is
            // the candidate object, and a shuffle permutes references rather than copying them.
            // `Math.max` rather than a guard, because "the winner is not in the set" cannot happen
            // and a branch for it would be a line of coverage nobody could honestly earn.
            decision = { index: Math.max(0, ordered.indexOf(majority.winner as (typeof ordered)[number])), decided: false, sql: '' };
          }
          winner = ordered[decision.index] as typeof winner;
          selectedByModel = decision.decided;
          // The verification turn: the parent's answer, the bought statement, one question. It runs
          // only when the bought statement disagreed, because that is the only state in which there
          // is something to decide between — on the 90.9% of arrivals that restate the pool's
          // answer, a comparison would ask the selector to choose between two identical results.
          if (arm.dissentVerify === 'pairwise' && dissentRecord !== undefined) {
            const verified = { asked: dissentCandidate !== undefined, choseDissent: false };
            dissentRecord.pairwise = verified;
            if (dissentCandidate !== undefined) {
              try {
                const turn = await chooseCandidatePairwise(judge, question.question, [winner, dissentCandidate]);
                // Index 0 is the pool's answer and index 1 is the bought one, in the order the
                // prompt shows them; `decided: false` is an unreadable reply and leaves the pool's
                // answer standing, which is the same rule the selector itself follows.
                if (turn.decided && turn.index === 1) {
                  winner = dissentCandidate;
                  verified.choseDissent = true;
                }
              } catch (error) {
                // An outage on this turn is not a disagreement: the pool's answer stands and the
                // failure is counted where it happened, exactly as the selector's own failure is.
                selectionFailed = selectionFailed ?? escapeKind(error);
              }
            }
          }
          }
        }
        // The last thing this arm can learn for free: the winner ran and produced
        // nothing. On a split whose gold results are never empty that is proof of a
        // wrong statement, and the only information a second statement lacks is what
        // this one returned.
        let recovered = false;
        let retried = false;
        let probeRecord: CaseRun['emptyProbe'];
        if (arm.emptyRetry !== undefined && winner.rows.length === 0) {
          // The lookup before the call. It is the one step of this lever that is evidence rather
          // than a second opinion: the statement ran and returned nothing, so the literals it
          // compares against are either stored differently or not stored at all, and the engine
          // can say which without a model. 18 of the 19 dev questions whose whole candidate set
          // returned nothing wrote a value the database does not contain, which is the
          // population this reads.
          let gaps: readonly ValueGap[] = [];
          if (arm.emptyRetry === 'values') {
            const probe = await probeValueGaps(winner.sql, probeColumns(schema), async (statement) => {
              const result = await oracle.run(question.db_id, statement);
              // A refused lookup is not evidence: a column that is not text, a view the schema
              // lists but the engine does not have. `undefined` keeps it out of the message
              // rather than reporting an absence nobody verified.
              return result.ok ? result.rows : undefined;
            });
            gaps = probe.gaps;
            probeRecord = { queries: probe.queries, literalGaps: gaps.length, grounded: probe.grounded !== undefined, adoptedFree: false };
            // A case-only difference is settled by the lookup, so the statement is rewritten here
            // and adopted on the same rule the turn uses: it has to run and it has to return rows.
            // A grounded statement that still returns nothing falls through to the call with the
            // grounded text, which is strictly more information than the statement it replaces.
            if (probe.grounded !== undefined && probe.grounded !== winner.sql) {
              const grounded = await oracle.run(question.db_id, probe.grounded);
              if (grounded.ok && grounded.rows.length > 0) {
                winner = { sql: probe.grounded, rows: grounded.rows, source: winner.source };
                recovered = true;
                probeRecord = { ...probeRecord, adoptedFree: true };
              } else if (grounded.ok) {
                winner = { sql: probe.grounded, rows: grounded.rows, source: winner.source };
              }
            }
          }
          if (!recovered) {
            retried = true;
            // The turn belongs to the model that wrote the statement it replaces. It used to be
            // sent to the primary provider unconditionally, which on a cross arm meant the
            // reasoning model's empty result was rewritten by the chat model — a lever that
            // silently downgraded the arm it was attached to, and one whose cost was charged to
            // the wrong counter.
            const winnerSpec = arm.mixed === undefined ? { arm: arm.name, provider: 'primary' as const } : parseMixedSource(winner.source);
            const sourceArm = arm.mixed === undefined ? arm : (resolveArm(winnerSpec.arm) as Arm);
            const retryProvider = winnerSpec.provider === 'second' && secondCounter !== undefined ? secondCounter.provider : counter.provider;
            const retryPrompt = buildAskMessages({
              question: question.question,
              schema,
              prompt: promptFor(sourceArm, question, prepared.blocksFor(sourceArm, question)),
              linking: arm.sourceLinking?.[winner.source] ?? sourceArm.linking,
            });
            // The same bare call as the selector's, one line later: a rewrite that never arrived
            // used to erase the whole case, including the ceiling this arm is judged on. The turn is
            // optional by construction, so its absence is recorded and the original statement stands.
            let reply: { text: string } | undefined;
            try {
              reply = await retryProvider.complete({
                messages: [...retryPrompt.messages, ...emptyRetryMessages(arm.emptyRetry, winner.sql, winner.sql, gaps)],
                // The arm samples above zero, so a blind turn is a different draw and not a
                // copy of the statement it replaces. Both modes use the same temperature:
                // the pair differs by the words, and by nothing else.
                temperature: 0.7,
                purpose: 'retry',
              });
            } catch (error) {
              retryFailed = escapeKind(error);
            }
            const candidate = reply === undefined ? '' : extractSql(reply.text);
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
        }
        const reason = judgeOfficial(expected.rows, winner.rows);
        // Whether the bought opinion became the answer, which is a different question from
        // whether the selector was shown it: `selectedByModel` says a decision was made, and this
        // says the decision went to the candidate the extra call paid for. Read after every branch
        // has run, because on a vote-only arm nothing can become the answer and the record has to
        // publish that zero rather than omit the field.
        if (dissentRecord !== undefined) dissentRecord.adopted = winner.source === arm.dissent;
        // Judged once here and read twice below: the ceiling and the per-candidate record
        // are the same pass, so a loss cannot be attributed to a member the ceiling count
        // never saw.
        // What the arm holds, which is not always what the selector read: a verifying arm's
        // selector sees the pool's three candidates and the record carries four, because the
        // ceiling has to say whether the *set* held the answer — that is the reading the pair of
        // arms is about, and it is the same 1,050 on both of them. Only the order is the
        // selector's, and on this arm the fourth slot is not one it was shown.
        const judgedSet =
          arm.dissentVerify === 'pairwise' && dissentCandidate !== undefined ? [...ordered, dissentCandidate] : ordered;
        const verdicts = candidateVerdicts(judgedSet, expected.rows);
        return {
          id: String(question.question_id),
          passed: reason === 'match',
          predicted: winner.sql,
          reason,
          strict: judgeStrict(expected.rows, winner.rows) === 'match',
          // The generations this case actually paid for: the vote's draws, the empty-result turn
          // when it fired, and the conditional dissent when the pool was unanimous. A count that
          // left the dissent out would price the lever at zero on the very cases it acted on.
          attempts: arm.vote + (retried ? 1 : 0) + (dissentCandidate === undefined ? 0 : 1),
          agreement: majority.agreement,
          candidateRecall: verdicts.some((verdict) => verdict.correct),
          ...(dissentRecord === undefined ? {} : { dissent: dissentRecord }),
          // Recorded even when only one candidate survived: the case where two of three samples
          // died is exactly the case whose pool was smallest, and omitting its record made it
          // invisible to every reading of the artifact — `bench:bird:pool` counted seven dev
          // questions as passed with no correct candidate and reported them as a hole. A record
          // of one is still a record.
          ...(verdicts.length === 0 ? {} : { candidates: verdicts }),
          ...(selectedByModel === undefined ? {} : { selectedByModel }),
          ...(selectedByRule === undefined ? {} : { selectedByRule }),
          ...(selectionFailed === undefined ? {} : { selectionFailed }),
          ...(reconciled === undefined ? {} : { reconcile: reconciled }),
          ...(pairwiseTurn === undefined ? {} : { pairwise: pairwiseTurn }),
          ...(retryFailed === undefined ? {} : { retryFailed }),
          ...(firstShape === undefined ? {} : { shape: firstShape }),
          ...(arm.mixed === undefined ? {} : { winnerSource: winner.source }),
          ...(intentRecord === undefined ? {} : { intent: intentRecord }),
          ...(arm.emptyRetry === undefined
            ? {}
            : { emptyDropped: choice.dropped, emptyRetried: retried, emptyRecovered: recovered }),
          ...(probeRecord === undefined ? {} : { emptyProbe: probeRecord }),
          ...(lost.llm + lost.engine + lost.unparsed === 0 ? {} : { candidateFailures: lost }),
          ...(Object.keys(survival).length === 0 ? {} : { candidateSurvival: survival }),
          ...(decomposedCandidates === 0 ? {} : { decomposition: { candidates: decomposedCandidates, steps: decomposedSteps } }),
          calls: callsMade(),
        };
      }
      try {
        const asked = await pipeline.ask({ question: question.question, schema });
        // Read once and spread into both returns below: a case that executed and a case the
        // engine refused are the same prompt behaving the same way, and a profile that only
        // counted the successes would describe the failures as a different model.
        const shape = asked.shape === undefined ? {} : { shape: asked.shape };
        // Carried beside the shape for the same reason the shape is carried: the endpoint said it
        // stopped at the cap, and a statement that still parsed under a cut is a statement the
        // artifact should not present as the whole answer. Per case, because the arm-level reading
        // is a sum of these and a second definition here would be a second number.
        const cut = asked.truncated === true ? { truncated: true } : {};
        const predicted = await oracle.run(question.db_id, asked.sql);
        if (!predicted.ok) {
          return {
            id: String(question.question_id),
            passed: false,
            predicted: asked.sql,
            strict: false,
            attempts: asked.attempts,
            // Without the kind this case counted as `other`, which made
            // `errors.execution` permanently zero and hid where failures came from:
            // the GLM probe read as "no execution failures" while every one of its
            // top errors was a SQLite syntax or column error.
            errorKind: 'execution',
            calls: callsMade(),
            ...(asked.decomposedSteps === undefined ? {} : { decomposition: { candidates: 1, steps: asked.decomposedSteps } }),
            ...demonstrationsOf(question),
            ...shape,
            ...cut,
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
          ...(asked.audit === undefined ? {} : { audit: asked.audit }),
          ...(asked.grounding === undefined ? {} : { grounding: asked.grounding }),
          // The pipeline's own funnel, on the return path the sampling branch never takes. It was
          // absent here, so an arm whose lever is this turn reported `fired: 0` even after it ran
          // — the mechanism was observable in the pipeline and invisible in the artifact.
          ...(asked.emptyRetry === undefined
            ? {}
            : { emptyRetried: asked.emptyRetry.fired, emptyRecovered: asked.emptyRetry.recovered }),
          ...(asked.decomposedSteps === undefined ? {} : { decomposition: { candidates: 1, steps: asked.decomposedSteps } }),
          ...demonstrationsOf(question),
          ...shape,
          ...cut,
        };
      } catch (error) {
        // A repair arm reports the statement it gave up on, so a failure is
        // diagnosable from the artifact alone.
        const details = (error as { details?: Record<string, unknown> }).details ?? {};
        const lastError = typeof details.lastError === 'string' ? details.lastError : undefined;
        const failureClasses = Array.isArray(details.failureClasses) ? (details.failureClasses as string[]) : undefined;
        // The shape the guard kept refusing. An arm that failed every case has no `asked`
        // result to read, and this is the reading that says whether it failed the question or
        // failed the channel — without it the artifact reports a zero with no address.
        const lastShape = details.lastShape as ReplyShape | undefined;
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: string }).code ?? '';
        return {
          id: String(question.question_id),
          passed: false,
          predicted: typeof details.lastSql === 'string' ? details.lastSql : '',
          strict: false,
          attempts: arm.repairs + 1,
          calls: callsMade(),
          ...(failureClasses === undefined ? {} : { failures: failureClasses }),
          ...(lastShape === undefined ? {} : { shape: lastShape }),
          // No `examples` here, unlike the two paths above: this one can fail *before* a prompt was
          // built (a card the linker could not draw, a guard that refused the question), and a case
          // that never read a prompt must not be counted as one that read the block.
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
                  : code === 'NL2C_E_LLM_TRUNCATED'
                    ? 'truncated'
                    : code.startsWith('NL2C_E_LLM')
                      ? 'llm'
                      : 'other',
        };
      }
    });
    return {
      ...scored,
      ...costOfCase(),
      ...(card?.columns === undefined ? {} : { columnSelection: card.columns }),
      ...(card?.samples === undefined
        ? arm.mixed === undefined || !drewCandidates
          ? {}
          : { sampleBlock: { columns: candidateColumns } }
        : { sampleBlock: card.samples }),
      ...(card?.fields === undefined ? {} : { fieldBlock: card.fields }),
    };
  };
  /**
   * The slots that are already in flight finish their case; every case behind them is skipped.
   *
   * Skipping rather than throwing from the worker is deliberate: `pool` runs its slots as parallel
   * promises and rejects on the first throw, which would leave the other slots' loops running and
   * their rejections unhandled. A flag they all read costs one comparison and stops the spending.
   */
  const results = new Array<CaseRun | undefined>(cases.length);
  /**
   * The cases a previous dispatch finished, keyed by question.
   *
   * Read before the pool starts rather than inside it, because a file that names a different arm
   * must stop the run before a single call is spent, not after four hundred.
   */
  const resumed =
    settings.resumeFrom === undefined
      ? new Map<number, CaseRun>()
      : readPartialRun(settings.resumeFrom, {
          arm: name,
          split: settings.layout.split,
          model: settings.model,
          // The shape of the request, not its name: a resume that straddled two declarations would
          // publish one table over answers written under two budgets.
          declaration: declarationDigest(settings.model, settings.capabilities),
          questionIds: cases.map((question) => question.question_id),
        });
  const startedAt = Date.now();
  let finished = 0;
  let passing = 0;
  /**
   * The clock, checked before each case starts and reported after each one lands.
   *
   * Same shape as the failure breaker and for the same reason: the slots already in flight finish
   * their case, and every case behind them is skipped rather than thrown from a worker. The
   * difference is what a stop means — a breaker stop says the endpoint refused a tenth of the calls,
   * and a budget stop says nothing failed and the run simply outgrew its clock.
   */
  const budgetMs = settings.budgetMs;
  const expired = (): boolean => budgetMs !== undefined && Date.now() - startedAt > budgetMs;
  await pool(cases, settings.concurrency, async (question, index) => {
    // A case the previous dispatch already paid for is not re-asked. It is not skipped either: it
    // is counted, because the table this run publishes has to cover the same population the whole
    // split would have — which is the one thing a partial table cannot do.
    const prior = resumed.get(question.question_id);
    if (prior !== undefined) {
      results[index] = prior;
      finished += 1;
      if (prior.passed) passing += 1;
      return;
    }
    if (breaker.verdict() !== null || expired()) return;
    const caseStartedAt = Date.now();
    const run = await scoreOne(question);
    // Written by index so the table stays in split order: the artifact's row order is part of the
    // reading, and a stop must not reorder what did run.
    results[index] = run;
    breaker.observe(run);
    finished += 1;
    if (run.passed) passing += 1;
    // One line per case, and it is the only instrument that distinguishes "slow" from "stuck": the
    // five-hour run had neither a line nor a rate, so its death at the job cap was the first thing
    // anyone could read about it.
    console.log(progressLine({ index: finished, total: cases.length, passed: passing, elapsedMs: Date.now() - startedAt, caseMs: Date.now() - caseStartedAt }));
  });
  // A run that outgrew its clock has no table to publish, for the same reason a refused one does
  // not: the rate would be computed from the cases that happened to fit, which is a different
  // population from the one the run declared. What it *does* have is the number the next dispatch
  // needs, and that is what this message is.
  // Narrowed here rather than defaulted in the call: `expired()` answers true only when a budget
  // exists, and a `?? 0` on this line would be a branch no run can take.
  if (budgetMs !== undefined && Date.now() - startedAt > budgetMs) {
    // Written before the throw, because the throw is the end of the process: the cases that did
    // finish are the only thing this dispatch bought, and the next one cannot re-buy them without
    // spending the same clock twice.
    const resumePath = partialPath(settings.layout.out);
    writeFileSync(
      resumePath,
      `${JSON.stringify(
        {
          arm: name,
          split: settings.layout.split,
          model: settings.model,
          declaration: declarationDigest(settings.model, settings.capabilities),
          questionIds: cases.map((question) => question.question_id),
          cases: cases.flatMap((question, index) => {
            const run = results[index];
            return run === undefined ? [] : [{ questionId: question.question_id, run }];
          }),
        } satisfies PartialRun,
        null,
        2,
      )}\n`,
    );
    throw new Error(
      budgetExhaustedMessage({
        arm: name,
        budgetMs,
        elapsedMs: Date.now() - startedAt,
        casesDone: finished,
        total: cases.length,
        concurrency: settings.concurrency,
        resumePath,
      }),
    );
  }
  // Before any number is printed, and before a single row is summarised: a run stopped because the
  // endpoint refused a tenth of its calls has no accuracy, and reporting one would be a score
  // computed from the provider's mood. The table guard below would say the same thing an hour
  // later; this says it at call forty.
  const stopped = breaker.verdict();
  if (stopped !== null) throw new Error(stopped);
  const runs = results.filter((run): run is CaseRun => run !== undefined);
  // Before any number is printed: an arm that never reached the database has no
  // accuracy, and publishing 0% would hide the provider's message behind a score.
  assertArmProducedResults(name, runs);
  assertFailureRate(name, runs);
  // `engine` refusals are deliberately *not* guarded in this block: a statement that will not run
  // is the model's output quality, which is what the arm is measuring. The endpoint rule above is
  // an infrastructure verdict and belongs in a guard; this one belongs in the report. A run whose
  // every candidate the engine refused (a read-only database and a prompt that writes INSERTs) is
  // a 0% reading, not a broken harness -- the first version of this split failed that case and the
  // suite said so.
  // ...and a bug in the runner is not a wrong answer: it fails the arm outright.
  assertHarnessClean(name, runs);
  // ...then every lever this arm declares, from the one table that says which levers exist. The
  // chain that used to live here could be widened by adding an arm and forgetting a guard; a loop
  // over `MECHANISMS` cannot, and `test/bird-mechanisms.test.ts` proves each row's guard still
  // refuses a bank in which its mechanism never acted.
  for (const mechanism of mechanismsOf(arm)) {
    mechanism.guard({ armName: name, arm, runs, sampledFor: prepared.sampledFor });
  }
  return {
    name,
    runs,
    row: armReportRow(prepared, arm, runs, name),
    line: armSummaryLine(name, arm, runs),
    pool: collected,
  };
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
  // Printed only when it happened, and next to the accuracy it affects: a selector whose calls
  // failed is scored by the vote on those cases, and a reader comparing it against a parent has to
  // see how much of the arm's answer the lever was not present for.
  const failed = runs.filter((run) => run.selectionFailed !== undefined).length;
  // Printed only when it happened, and never silently: an arm whose answers came from two base
  // models is not one measurement, and a reader who compares it against a parent is comparing
  // against neither of them. The count of cases per base is in the artifact; this line exists
  // so that the console cannot show a clean score over a mixed base.
  const bases = new Set<string>();
  for (const run of runs) for (const model of run.tokens?.served ?? []) bases.add(model);
  // Forfeits, printed next to the score they moved. The S1 run reported 913/1532 = 59.6% and
  // this line said nothing about the 94 cases whose call timed out — 6.1% of the split, 21 of
  // them questions the other arm answered correctly. A denominator that quietly lost 6% of its
  // questions is not the same population as one that did not, and the arm row that reports the
  // score is where a reader looks before comparing it with anything.
  const forfeits = runs.filter((run) => run.errorKind === 'llm').length;
  // Printed beside the forfeits and never merged with them: a reader who sees `llm-failed 50`
  // looks at the network, and these fifty calls were answered.
  const cuts = runs.filter((run) => run.errorKind === 'truncated').length;
  return (
    `${label.padEnd(9)} ${summary.passed}/${summary.total}  ${(summary.accuracy * 100).toFixed(1)}%  ` +
    `strict ${runs.filter((run) => run.strict).length}` +
    `${printed.repaired === undefined ? '' : `  repaired ${String(printed.repaired)}`}` +
    `${printed.samples === undefined ? '' : `  samples ${String(printed.samples)}`}` +
    `${failed === 0 ? '' : `  select-failed ${String(failed)}`}` +
    `${bases.size < 2 ? '' : `  served-by ${String(bases.size)}`}` +
    `${forfeits === 0 ? '' : `  llm-failed ${String(forfeits)}`}` +
    `${cuts === 0 ? '' : `  cut-at-budget ${String(cuts)}`}` +
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
  // What the model read, per case. A mixed arm reads one prompt per candidate and the candidates
  // are not the same size — the sampled one carries bracket values — so the number is the widest
  // of them: a column that reported the arm's own card would price a prompt nobody sent, which is
  // how `select-samples` and `select-mixed` both came to publish 2,568 mean characters while one
  // of them was sending 16,109 columns of stored values on a third of every case's calls.
  const promptSizeOf = (question: (typeof cases)[number]): number => {
    const sources = arm.mixed;
    const sizeFor = (target: Arm): number =>
      buildSqlPrompt(
        question.question,
        // The card that was sent, not the card the arm would build now: on a column-choosing
        // arm those differ, and the prompt-size column exists to say what the model read.
        sources === undefined ? prepared.cardOf(arm, question).schema : prepared.schemaForSource(target, question),
        promptFor(target, question, prepared.blocksFor(target, question)),
      ).length;
    if (sources === undefined) return sizeFor(arm);
    return Math.max(...sources.map((source) => sizeFor(resolveArm(parseMixedSource(source).arm) as Arm)));
  };
  const promptSizes = cases.map(promptSizeOf);
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
    truncated: runs.filter((run) => kindOf(run) === 'truncated').length,
    shape: runs.filter((run) => kindOf(run) === 'shape').length,
    harness: runs.filter((run) => kindOf(run) === 'harness').length,
    other: runs.filter((run) => kindOf(run) === 'other').length,
    // The buckets that describe *failures*, restricted to failures here rather than at each
    // read. `reason` is the judge's verdict, and a pass has `'match'`, so this changes no
    // published number — it removes the need for every future reader to remember that a
    // bucket count is only a bucket count over the cases that failed.
    columnCount: runs.filter((run) => !run.passed && run.reason === 'column-count').length,
    values: runs.filter((run) => !run.passed && run.reason === 'values').length,
  };
  const messages = new Map<string, number>();
  for (const run of runs) {
    if (run.error === undefined) continue;
    const key = run.error.replace(/\d+/g, 'N').slice(0, 120);
    messages.set(key, (messages.get(key) ?? 0) + 1);
  }
  const firstFailure = runs.find((run) => run.error !== undefined);
  // The cases whose endpoint reported a cache figure. A run whose endpoint says nothing about
  // caching has none, and that absence is what keeps `tokens.cached` out of the row.
  // The two figures an endpoint reports on some answers and not others. Both are averaged over
  // the reporters rather than over every case: an endpoint that reports unevenly has measured a
  // subset, and dividing it by the whole would understate the ones it did answer.
  const cachedFigure = meanReported(metered, (cost) => cost.cached);
  const reasoningFigure = meanReported(metered, (cost) => cost.reasoning);
  const thinking = thinkingShare(metered);
  // How many cases each base model served. Counted from the rows rather than from a side
  // ledger for the same reason every other column here is: a figure that has one definition
  // cannot disagree with the rows it is reported beside. The alias that was requested is in
  // the artifact's settings; this is the answer, and a run where the two differ is a run that
  // measured something other than what its settings say.
  const servedTally = new Map<string, number>();
  for (const run of runs) {
    for (const model of run.tokens?.served ?? []) servedTally.set(model, (servedTally.get(model) ?? 0) + 1);
  }
  return {
    arm: label,
    passed: summary.passed,
    total: summary.total,
    ...(arm.pool === undefined ? {} : { pool: arm.pool }),
    // What the decision cost, on every arm whose selector is the model. A rule arm decides with
    // no call at all, so it has nothing to price — printing `{asked: 0, priced: 0}` there would
    // read as a selector nobody reached, which is the opposite of a selector that costs nothing.
    ...(arm.select !== true || arm.selectRule !== undefined ? {} : { spend: spendOf(runs) }),
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
    // Which base actually answered, and on how many cases. Absent on an artifact whose provider
    // reported nothing, which is the honest state: an endpoint that names no model has not said
    // what it ran. Present with one entry, it is the proof that the arm's numbers belong to the
    // model its settings name; present with two, it is the reason they do not.
    ...(servedTally.size === 0
      ? {}
      : { servedModels: Object.fromEntries([...servedTally].sort((left, right) => (left[0] < right[0] ? -1 : 1))) }),
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
            // The cache figure the endpoint reported, averaged over the cases that reported one.
            // A run whose endpoint says nothing about caching has no entry here at all: `0` would
            // read as "the prompt never hit" and the truth is "nobody said". Averaged over the
            // reporters rather than over every case because a partial reporter is an endpoint
            // that answers differently per call, and the mean of the answered ones is the only
            // figure that describes a hit.
            ...(cachedFigure === undefined ? {} : { cached: cachedFigure }),
            // How much of `completion` was thinking. Absent on a chat endpoint and on any endpoint
            // that reports no reasoning counter — the state every published reading before this
            // column was written in, and a state a reader has to be able to tell from `0`.
            ...(reasoningFigure === undefined ? {} : { reasoning: reasoningFigure }),
            // The same fact as a ratio, over the cases that reported both numbers, because the two
            // averages above are over two populations and their ratio is not one. `thinking` is the
            // sentence a reader wanted: "94% of the completion tokens on this arm were deliberation,
            // over 456 cases". See `thinkingShare`.
            ...(thinking === undefined ? {} : { thinking }),
            ...(byPurpose === undefined ? {} : { byPurpose }),
          },
        }),
    ...(repair === undefined ? {} : { repair }),
    // What the decomposition prompt produced, on any arm that asked for one. This was
    // inside the sampling-arm spread and therefore absent from `decompose` itself, which
    // is the arm the numbers exist for.
    ...armDecomposition(runs),
    ...armFormat(runs),
    // What this arm's endpoint refused to honour, summed over the cases that carried a dropped
    // parameter. Printed beside the accuracy because it qualifies the sampling claim: an arm
    // that says "temperature 0" while the endpoint ignored the field did not sample at zero,
    // and a report without this count cannot tell that state from the one every published
    // reading was taken in.
    ...(runs.some((run) => run.samplingOmitted !== undefined)
      ? {
          samplingOmitted: (() => {
            const totals: Record<string, number> = {};
            for (const run of runs) {
              for (const [parameter, count] of Object.entries(run.samplingOmitted ?? {})) {
                totals[parameter] = (totals[parameter] ?? 0) + count;
              }
            }
            return totals;
          })(),
        }
      : {}),
    ...(arm.emptyRetry === undefined ? {} : { emptyRetry: { mode: arm.emptyRetry, ...emptyRetryFunnel(runs) } }),
    ...(arm.reconcile === undefined ? {} : { reconcile: { policy: arm.reconcileAdopt ?? 'always', ...reconcileFunnel(runs) } }),
    // The knockout's own bill, on the arm that runs one. Read from the cases rather than computed
    // from the arm, because the pool size is a runtime fact: a case whose candidate died is a case
    // with fewer comparisons to make, and an arm whose `k - 1` never matched its pool was comparing
    // something other than what it drew.
    ...(arm.pairwise === true ? { pairwise: pairwiseFunnel(runs) } : {}),
    ...(arm.audit === undefined ? {} : { audit: auditFunnel(runs) }),
    ...(arm.ground === undefined ? {} : { grounding: groundingFunnel(runs) }),
    // The fourth candidate's whole mechanism, on the arm that draws it: how often the vocabulary
    // produced a statement and which refusals it produced when it did not. A mixed arm publishes
    // it because the lever rides on one of its sources rather than on the arm.
    ...(runs.some((run) => run.intent !== undefined) ? { intent: intentReport(runs) } : {}),
    // A mixed arm's block lives on one of its candidates, so the funnel is the arm's to publish
    // even though the arm itself declares no sampler: `select-samples`' whole claim is that its
    // third opinion rides a card with values on it.
    ...(arm.samples === undefined && arm.mixed === undefined ? {} : { sampleBlock: sampleBlockFunnel(runs) }),
    // The card's content, on the arm that decides it from the answer: the funnel is what separates
    // "smaller card helped" from "smaller card with the same fields helped", and the second is the
    // only thing this arm can claim.
    ...(arm.cardColumns === undefined ? {} : { fieldBlock: fieldBlockFunnel(runs) }),
    // What the examples cost and what they reached: the arm's whole claim is that the block carries
    // knowledge the hint does not, and a delta with no statement of how many cases carried one is a
    // reading about whichever subset of the split happened to retrieve a neighbour.
    ...(arm.demonstrations === true ? { demonstrations: demonstrationsFunnel(runs) } : {}),
    // The conditional call's whole price and its whole effect, on the arm that pays for it. On
    // this arm the accuracy is the same number as its parent's only when the selector never
    // adopts the bought candidate, so the funnel is what says whether the call carried anything.
    ...(arm.dissent === undefined ? {} : { dissent: dissentFunnel(runs) }),
    // What the model kept of the card, on the one arm that asks it to choose. Beside the
    // accuracy rather than inside the sampling spread, for the reason the decomposition funnel
    // moved out: the instrument belongs to the arm, not to how many candidates it draws.
    ...(arm.columnSelect === undefined ? {} : { columnSelection: columnChoiceFunnel(runs) }),
    ...(arm.vote === undefined
      ? {}
      : {
          vote: arm.vote,
          agreement:
            runs.reduce((total, run) => total + (run.agreement ?? 0), 0) /
            Math.max(1, runs.filter((run) => run.agreement !== undefined).length),
          selector:
            arm.selectRule === undefined ? (arm.select === true ? 'model' : 'majority') : `rule:${arm.selectRule}`,
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
          // `reconcile` is listed as a source on the arm that can write one: a statement the model
          // wrote is an answer nobody else in the set produced, and leaving it out of the tally
          // would make the per-source counts sum to less than the arm's cases without saying why.
          ...(arm.mixed === undefined ? {} : { sources: winnerSources(runs, arm.reconcile === undefined ? arm.mixed : [...arm.mixed, 'reconcile']) }),
          ...(runs.some((run) => run.candidateSurvival !== undefined)
            ? { candidateSurvival: candidateSurvivalBySource(runs) }
            : {}),
          // How often the selector produced a usable index. A selector that fails to
          // answer half the time is not a null result; it is a broken prompt.
          ...(arm.select === true && arm.selectRule === undefined
            ? {
                selectorDecided: runs.filter((run) => run.selectedByModel === true).length,
                selectorTotal: runs.filter((run) => run.selectedByModel !== undefined).length,
                // The calls that never came back, which `selectorDecided` alone cannot separate:
                // an index the reader could not find and a refusal from the endpoint are the same
                // number in that column and different findings. These cases are scored by the vote
                // they already had, so the arm's accuracy holds a lever that did not run on them.
                selectorFailed: runs.filter((run) => run.selectionFailed !== undefined).length,
                ...(runs.some((run) => run.retryFailed !== undefined)
                  ? { retryFailed: runs.filter((run) => run.retryFailed !== undefined).length }
                  : {}),
              }
            : {}),
          // The free decision's own funnel, on the arm that made one. `eligible` sums the
          // candidates the rule could rank, and `emptyPool` counts the sets where it had none to
          // prefer — the state in which every candidate returned nothing, which is a wrong set on
          // this corpus and the only correct one on a corpus whose answers are sometimes empty.
          // A gated arm makes a free decision too, on the cases its gate stopped: the rule it
          // names there is the one the gate fell back to, and publishing the same funnel for it
          // keeps "the gate fired" countable instead of leaving it to be inferred from a call mean.
          ...(arm.selectRule === undefined && arm.gate === undefined
            ? {}
            : {
                selectorRule: {
                  rule: arm.selectRule ?? arm.gateRule ?? 'shortest',
                  decided: runs.filter((run) => run.selectedByRule !== undefined).length,
                  eligible: runs.reduce((total, run) => total + (run.selectedByRule?.eligible ?? 0), 0),
                  emptyPool: runs.filter((run) => run.selectedByRule?.emptyPool === true).length,
                },
              }),
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
    // Beside the outage share and never inside it: the two say opposite things about where to look.
    truncatedShare: runs.filter((run) => run.errorKind === 'truncated').length / Math.max(1, runs.length),
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
 * The sampling noise of the quantity a candidate-side mechanism claims to move.
 *
 * Every A/A in this project priced the *score* and stopped there, and that is how a ceiling delta
 * of +0.4pp was allowed to read as a small gain twice (rounds 131 and 132). The score and the pool
 * ceiling are different statistics: the ceiling is `candidateRecall` per case, so on an A/A pair —
 * same arm, same questions, same temperature, twice — it has its own noise, and a mechanism whose
 * whole argument is "this lifts the ceiling" has to clear the ceiling's noise rather than the
 * score's.
 *
 * It is computed by the same paired machinery as the score, on purpose: `candidateRecall` is a
 * per-case boolean, so `compareArms` and `pairedResolution` apply verbatim and the two numbers in
 * one artifact cannot come from two definitions of "the same case twice".
 *
 * Returns `undefined` when the arm does not sample — a single-candidate arm has no pool to widen
 * and reporting 0.00% twice would be a reading of nothing.
 */
export function ceilingNoise(
  base: string,
  first: readonly CaseRun[],
  second: readonly CaseRun[],
): { first: number; second: number; delta: number; mde: number; discordantShare: number } | undefined {
  const asOutcomes = (runs: readonly CaseRun[]): CaseOutcome[] =>
    runs.map((run) => ({ id: run.id, passed: run.candidateRecall === true }));
  // Two guards, both about there being nothing to price: an arm that does not sample has no pool,
  // and a pair with no cases has no ceiling either -- a share over zero rows is a division this
  // function should not be the one to make.
  if (first.length === 0 || !first.some((run) => run.candidateRecall !== undefined)) return undefined;
  const comparison = compareArms(
    summarise(`${base}#ceiling`, asOutcomes(first)),
    summarise(`${base}#2#ceiling`, asOutcomes(second)),
  );
  const resolution = pairedResolution(comparison.onlyFirst, comparison.onlySecond, comparison.total);
  const four = (value: number): number => Number(value.toFixed(4));
  const share = (runs: readonly CaseRun[]): number =>
    runs.filter((run) => run.candidateRecall === true).length / runs.length;
  return {
    first: four(share(first)),
    second: four(share(second)),
    delta: four(comparison.delta),
    mde: four(resolution.mde),
    discordantShare: four(resolution.discordantShare),
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
          const ceiling = ceilingNoise(base, first, second);
          return {
            arm: base,
            delta: comparison.delta,
            onlyFirst: comparison.onlyFirst,
            onlySecond: comparison.onlySecond,
            p: mcnemarExact(comparison.onlyFirst, comparison.onlySecond),
            ...resolutionFields(comparison),
            // The noise of the quantity a candidate-side mechanism is argued for, beside the noise
            // of the score. Absent only when the arm does not sample, where there is no pool.
            ...(ceiling === undefined ? {} : { ceiling }),
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
export function caseRows(
  outcomes: ReadonlyMap<string, readonly CaseRun[]>,
  questions: readonly BirdQuestion[] = [],
): Record<string, unknown>[] {
  // The first question it is needed for: whether the mixed arm wins because its third
  // source is distinct on 35% of cases, or because a duplicated candidate is a frequency
  // signal on the other 65%. That is a stratum, and a stratum needs rows.
  const goldOf = new Map(questions.map((question) => [String(question.question_id), question.SQL]));
  return [...outcomes.entries()].flatMap(([name, runs]) =>
    runs.map((run) => ({
      arm: name,
      id: run.id,
      passed: run.passed,
      // Absent on a case the judge never saw. Writing a bucket here would put a timeout in the
      // same column as a wrong answer, which is the defect this row used to carry.
      ...(run.reason === undefined ? {} : { reason: run.reason }),
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
      // Which slot the free rule took, on the arm where a rule decides.
      //
      // The arm-level funnel counts the decisions; a reading of "the rule agreed with the vote
      // here and disagreed there" needs the case. It is also the only field that makes the arm's
      // score checkable against the artifact: `bench:bird:consensus` re-derives the same rule from
      // `candidates`, and the two must name the same slot on every case.
      ...(run.selectedByRule === undefined ? {} : { selectedByRule: run.selectedByRule }),
      // What the reconcile turn did on this case. The fifth dispatch published the arm-level
      // funnel and not the per-case record, so the loss could be attributed to the restatements in
      // arithmetic and not in evidence: 514 replies restated a candidate, and the archive could not
      // name the cases where adopting one turned a right answer wrong. A funnel says how many; a
      // row says which, and a pair of arms is tested on the second.
      ...(run.reconcile === undefined ? {} : { reconcile: run.reconcile }),
      // What the knockout compared on this case, and how much of it was readable. Per case for the
      // reason the reconcile record is per case: the funnel prices the turn, and only the row can
      // say *which* comparisons carried no answer — the population a prompt fix has to be aimed at.
      ...(run.pairwise === undefined ? {} : { pairwise: run.pairwise }),
      // What the value block put on this case's card, on an arm that declares a sampler.
      //
      // The narrowed arm published its funnel and not its record on its first dispatch, so "the
      // block reached 511 of 1,532 cases" could not be turned into "and here is what it did on
      // them": the only way to ask whether the block worked where it fired was to reconstruct its
      // presence from the per-case prompt tokens, which is a reading of the artifact's shadow
      // rather than of the artifact. A funnel says how many; a row says which.
      ...(run.sampleBlock === undefined ? {} : { sampleBlock: run.sampleBlock }),
      // The stratum the conditional call acted on, published per case for the same reason the
      // block is: a run-wide `asked` says how many, and every reading of "where did the extra
      // opinion help" needs to know which. `asked: false` is a measurement — the pool was not
      // unanimous here — and dropping it would make the arm's population look like the whole split.
      ...(run.dissent === undefined ? {} : { dissent: run.dissent }),
      // How many worked examples this case's prompt carried, when the arm asks for them: the
      // funnel says how many cases, and every reading of "did the examples help where they
      // arrived" needs which — the same reason the block above is per case.
      ...(run.examples === undefined ? {} : { examples: run.examples }),
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
      // The cut, on the cases it reached. It is written at the case level rather than summed into
      // the arm because a cap is priced per case: "twelve cases came back truncated" is a fact
      // about a run, and "these twelve" is the only form in which it can be paired against a
      // second arm or re-read against a second cap.
      ...(run.truncated === undefined ? {} : { truncated: run.truncated }),
      // What the zero-row lever did on this case, when the arm declares it.
      //
      // The arm funnel says how many cases triggered; a reading of "the lookup answered this one
      // without a call" or "the 96.2% that never trigger did not move" needs which. The probe
      // record is the only place `adoptedFree` exists — the funnel sums it, and a sum cannot be
      // paired against the arm it came from.
      ...(run.emptyRetried === undefined ? {} : { emptyRetried: run.emptyRetried }),
      ...(run.emptyRecovered === undefined ? {} : { emptyRecovered: run.emptyRecovered }),
      ...(run.emptyProbe === undefined ? {} : { emptyProbe: run.emptyProbe }),
      // The statement the arm returned, and the one it was measured against.
      //
      // `failure-shape` states the principle in its own header — the result set says "wrong",
      // the statement says "why" — and the artifact kept only the first. That was survivable
      // while every question was "which bucket did this land in". It stopped being survivable
      // at the model comparison: `column-count` 130 -> 204 is a reading of results, and the
      // sentence that followed it ("the reasoner projects too many columns") had no statement
      // behind it, so it could not be checked, refined, or refuted. A row that carries both
      // statements turns that sentence into a measurement.
      //
      // A case that produced no statement is not a case that produced an empty one, so the
      // field is omitted rather than written as `''`.
      ...(run.predicted.trim() === '' ? {} : { sql: run.predicted }),
      ...(goldOf.get(String(run.id)) === undefined ? {} : { gold: goldOf.get(String(run.id)) as string }),
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
 * Read the base fingerprint into the report, and say it in the log.
 *
 * Its own function so the step can be executed by a test: `runBird` needs a dataset and an oracle
 * to reach this line, and the one thing worth checking here is the order — the report carries the
 * reading before any arm runs, so a run killed by an outage at case 400 still says which generator
 * it was talking to.
 */
export async function attachFingerprint(
  report: Record<string, unknown>,
  provider: LlmProvider,
  log: (line: string) => void,
): Promise<void> {
  const fingerprint = await probeBase(provider);
  report.baseFingerprint = fingerprint;
  log(fingerprintLine(fingerprint));
}

/**
 * Ask the same probes again after the last arm, because a run is a forty-minute window.
 *
 * Round 133 measured something this harness could not explain: the same arm, twice in one dispatch,
 * differed by **4.2 points** (11:32, p = 0.002) while its prompts were byte-identical — 496 of 496
 * cases carried the same prompt-token count, the same three calls and the same completion length.
 * The bytes leaving this process did not change; the bytes coming back did. Two explanations survive
 * that evidence, and they call for opposite responses:
 *
 * 1. **The base drifted.** A serving stack under changing load answers the same prompt differently.
 *    Nothing to fix here; the run just has to publish the size of the window it measured in.
 * 2. **The base was swapped.** Weights changed mid-day, and every arm ran against a different
 *    model — which would make the whole artifact's arm-to-arm deltas meaningless.
 *
 * `probeBase` already asks three fixed questions twice each at temperature zero and digests the
 * answers, which is exactly a "is this still the same base" test. Asking it a second time at the
 * end costs six calls against the thousands the run spent, and it turns the ambiguity into one
 * field: an equal digest means the base held and the number is sampling noise; a different digest
 * means the run is confounded and `evaluateGate` refuses it.
 */
export async function recheckFingerprint(
  report: Record<string, unknown>,
  provider: LlmProvider,
  log: (line: string) => void,
): Promise<{ readonly changed: boolean; readonly before: string; readonly after: string }> {
  const first = report.baseFingerprint as BaseFingerprint | undefined;
  const again = await probeBase(provider);
  report.endFingerprint = again;
  const before = first?.digest ?? '';
  const after = again.digest;
  // A digest over zero probes is not a fingerprint: it is a probe set that answered nothing, and
  // two of those "agree" while saying nothing about the base.
  const comparable = first !== undefined && first.probes > 0 && again.probes > 0;
  const changed = comparable && before !== after;
  log(
    changed
      ? `base fingerprint changed during the run: ${before} -> ${after} after ${String(again.calls)} call(s) — every arm-to-arm delta in this artifact is confounded with the clock`
      : `base fingerprint after the last arm: ${after} (${comparable ? 'unchanged' : 'not comparable'}), ${String(again.calls)} call(s)`,
  );
  return { changed, before, after };
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
        `corpus ${(report.corpus as { digest: string }).digest}; ` +
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
  // The window test, and the one failure no amount of sampling can be read past: if the base
  // answered its own fixed probes differently at the end of the run than at the start, the arms did
  // not all run against the same model and their deltas are differences of bases rather than of
  // mechanisms. Refusing here is what keeps a swap from being published as a lever.
  const opened = (report.baseFingerprint as { digest?: string; probes?: number } | undefined);
  const closed = (report.endFingerprint as { digest?: string; probes?: number } | undefined);
  if (
    opened !== undefined &&
    closed !== undefined &&
    (opened.probes ?? 0) > 0 &&
    (closed.probes ?? 0) > 0 &&
    opened.digest !== closed.digest
  ) {
    problems.push(
      `the base answered its fixed probes as ${String(closed.digest)} at the end of the run and ${String(opened.digest)} at the start, so the arms were measured against two different models`,
    );
  }
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
    // A pooled arm names the sources of the arm whose candidates it reads, but it draws none of
    // them: requiring a second key for an arm that spends one call on a pool somebody else
    // generated would be a requirement about a request that is never sent.
    draws: arms.some(
      (name) =>
        resolveArm(name)?.pool === undefined &&
        ((resolveArm(name)?.mixed ?? []).some((source) => parseMixedSource(source).provider === 'second') ||
          // A plan written by the second model is a draw too: it is a request with that key on
          // it, and an arm that needs one without saying so fails at the endpoint instead.
          resolveArm(name)?.planBy === 'second'),
    ),
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
    ...(settings.capabilities === undefined ? {} : { capabilities: settings.capabilities }),
    retries: settings.retries,
    retryDelayMs: settings.retryDelayMs,
    timeoutMs: settings.timeoutMs,
  });
  if (settings.second.model === '') return { provider };
  const second = createHttpProvider({
    baseUrl: settings.second.baseUrl === '' ? settings.baseUrl : settings.second.baseUrl,
    apiKey: settings.second.apiKey,
    model: settings.second.model,
    ...(settings.second.capabilities === undefined ? {} : { capabilities: settings.second.capabilities }),
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
  // Before the preflight and before any call: an arm whose statement is rendered on the
  // candidate-source path cannot be run as an arm of its own, and the failure it would otherwise
  // produce is not a red test — it is a statement read by the wrong reader and a score that looks
  // like a weak prompt.
  assertIntentRule(settings.arms);
  const oracle = createOracle(settings.layout.oracleScript, settings.layout.databaseRoot);
  try {
    const prepared = await prepareRun(settings, { oracle, provider });
    // Above the rates, not below them: what the denominator is, stated before anything is
    // measured with it. A reader who stops after the first arm line still knows the pool.
    log(describeQuestionSet(prepared.shape, settings.layout.split));
    // Said before the first call, because a run that will be cut for time should say so up front:
    // the reader of a five-hour log should have been able to see at minute one whether a clock was
    // watching. `none` is printed rather than omitted — an absent guard is a finding, not a default.
    log(
      `budget: ${settings.budgetMs === undefined ? 'none' : `${(settings.budgetMs / 1000).toFixed(0)} s per arm`}` +
        `, deadline ${(settings.timeoutMs / 1000).toFixed(0)} s, concurrency ${String(settings.concurrency)}`,
    );
    const report = baseReport(prepared, { run: process.env.GITHUB_RUN_ID, workflow: process.env.GITHUB_WORKFLOW });
    if (settings.dryRun) {
      previewPrompts(prepared, report);
      writeArtifact(settings, report, log);
      return report;
    }
    // Which generator answered, read before the first arm spends a call on a case.
    //
    // Before, because a run whose endpoint turns out to be another base is a run whose numbers are
    // about another model, and the reader should learn that in the first minute rather than in the
    // gate an hour later; and separately from every arm's meter, because these six calls are the
    // instrument identifying itself and folding them into an arm would price a probe as a case.
    await attachFingerprint(report, provider, log);
    const outcomes = new Map<string, readonly CaseRun[]>();
    const armReports: ArmReportRow[] = [];
    // Pools by the arm *label* that generated them, so a pooled arm names the arm as it appears
    // in the run (`select-cross`, not its resolved form) and a label that never ran is a failure
    // rather than an empty lookup.
    const pools = new Map<string, ReadonlyMap<string, readonly PooledCandidate[]>>();
    for (const name of settings.arms) {
      const arm = resolveArm(name);
      const poolFor =
        arm?.pool === undefined
          ? undefined
          : (source: string, caseId: string): PoolLookup | undefined => {
              const pool = pools.get(source)?.get(caseId);
              // A pool with no members is not a pool: `select-mixed` produced one for two of six
              // hundred cases (`41430569500`) because every sample for that question died at the
              // engine, and a pooled arm asked to choose among zero candidates can only report the
              // emptiness as its own answer. The source's row already says what happened, so the
              // empty case is routed to it here rather than at the guard that used to throw.
              if (pool !== undefined && pool.length > 0) return { pool };
              // No entry: either the source never reached the vote (a card failure) or it never ran
              // the case at all (an ordering bug, caught above). Handing back the source's own row is
              // what turns the first into a recorded gap and leaves the second to `reusePool`.
              const cause = outcomes.get(source)?.find((run) => run.id === caseId);
              return cause === undefined ? undefined : { cause };
            };
      if (arm?.pool !== undefined && !pools.has(arm.pool)) {
        throw new Error(
          `arm ${name} reuses the pool of ${arm.pool}, which is not scheduled before it in this run; add ${arm.pool} to BIRD_ARMS ahead of it`,
        );
      }
      const armRun = await runArm(prepared, name, {
        oracle,
        provider,
        ...(second === undefined ? {} : { second }),
        ...(poolFor === undefined ? {} : { poolFor }),
      });
      // Keyed by the requested name, not the resolved one: an A/A duplicate resolves to
      // the same Arm, and keying by that overwrote the first run with the second, which
      // silently made the pair compare an arm with itself and report `aa: undefined`.
      outcomes.set(name, armRun.runs);
      pools.set(name, armRun.pool);
      // A pooled arm is checked against the arm it names, right after it runs: the failure it
      // guards is silent arithmetic, and a delta published from a pool that was not shared is the
      // pool's noise wearing the label of a lever. What the check could not read is published with
      // it — a reader has to be able to tell "the pool was read on 598 of 600 cases and two were
      // gaps in the sample" from "the pool was read on all 600".
      const verified =
        arm?.pool === undefined ? undefined : (() => {
          const source = outcomes.get(arm.pool);
          if (source === undefined) {
            throw new Error(`arm ${name} reuses the pool of ${arm.pool}, which produced no runs in this run`);
          }
          return poolReadOf(name, armRun.runs, source, MINIMUM_INSTRUMENT_SAMPLE, arm.dissent);
        })();
      armReports.push(verified === undefined ? armRun.row : { ...armRun.row, poolRead: verified });
      log(armRun.line);
    }
    // Every arm must keep its own row: two rows with the same label would let a
    // duplicate stand in for the arm it duplicates.
    assertUniqueArmLabels(armReports.map((entry) => entry.arm));
    // The window the arms were measured in, closed and sealed before anything is compared: the
    // probes are the same three fixed questions the run opened with, and the only way their digest
    // can differ is that the endpoint answered differently forty minutes later.
    await recheckFingerprint(report, provider, log);
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
        ceiling?: { first: number; second: number; delta: number; mde: number };
      };
      report.aa = paired.aa;
      // The noise floor is not a single number: a 0pp A/A on 120 cases still leaves a
      // 5pp difference unexcluded, and the delta of every other arm is read against that.
      log(
        `A/A ${aa.arm}: ${(aa.delta * 100).toFixed(1)}pp (${String(aa.onlyFirst)}/${String(aa.onlySecond)}, p=${aa.p.toFixed(3)}, ` +
          `95% CI [${(aa.ci.low * 100).toFixed(1)}, ${(aa.ci.high * 100).toFixed(1)}]pp, resolves ${(aa.mde * 100).toFixed(1)}pp) — the harness's own noise`,
      );
      // The second half of that sentence. A candidate-side mechanism is argued for on the ceiling,
      // so its noise has to be in the log beside the score's — otherwise the next +0.4pp reading
      // has to be compared against a number nobody published.
      if (aa.ceiling !== undefined) {
        log(
          `A/A ${aa.arm} ceiling: ${(aa.ceiling.first * 100).toFixed(2)}% vs ${(aa.ceiling.second * 100).toFixed(2)}% ` +
            `(${(aa.ceiling.delta * 100).toFixed(2)}pp, resolves ${(aa.ceiling.mde * 100).toFixed(2)}pp) — the noise of the quantity a candidate buys`,
        );
      }
    }
    report.comparisons = paired.comparisons;
    report.ablations = paired.ablations;
    report.arms = armReports;
    report.cases = caseRows(outcomes, prepared.cases);
    const { failures, failureSample } = failureSection(prepared, outcomes);
    report.failures = failures;
    report.failureSample = failureSample;
    assertReportComplete({ arms: armReports, ...(paired.aa === undefined ? {} : { aa: paired.aa }) });
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
