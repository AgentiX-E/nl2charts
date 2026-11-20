/**
 * The chart half, answered by a model instead of by the cue table.
 *
 * ## Why this file exists
 *
 * Every reading the chart half has ever published is a reading about a **rule table**: `rule.ts`
 * scores the cues against the question, `profile.ts` scores the cues plus the result set's shape, and
 * both bottom out at 41.22% on Text2Vis. The corpus names a chart for each question, so the reading is
 * real — but it prices one mechanism, and no number in this repository says what a *model* would score
 * on the same rows. That is the gap this arm closes, and it is worth ¥1 before it is worth an
 * argument: the next round's whole plan (write a re-ranker, or stop and repair the labels) depends on
 * whether the model is thirty points ahead or level with the table.
 *
 * ## What it costs, and what it deliberately does not buy
 *
 * One call per question, one word out, no result set, no image, no repair loop. The prompt is a closed
 * list with a short gloss per entry — a list and not free generation, because a reader of the answer
 * would otherwise be the variable: an open answer has to be parsed by us, and two arms whose replies
 * are parsed by two different readers are not two arms.
 *
 * **Two scales, because they answer two questions, and they are two reports because the fields mean
 * two things.**
 *
 * | scale | options | report | comparable with |
 * | --- | --- | --- | --- |
 * | `mark` | the eleven marks this product can draw | `MarkArm` | `profile.ts`, row for row |
 * | `label` | the corpus's own chart names | `LabelArm` | the numbers a Text2Vis paper reports |
 *
 * The `mark` scale is the decision variable: it is the same eleven-way choice `recommendChart` makes,
 * scored by the same hit test through the same function, so `top1` here minus `top1` there is one
 * subtraction between two answers. The `label` scale is the diagnostic: three of the corpus's families
 * (`area`, `histogram`, `violin`) are ones no mark can lead with, so 237 of the 1,470 scored rows are
 * unreachable *by construction* on the mark scale. If a model names them correctly and the mark scale
 * does not move, the ceiling is the product's mark set and the next work is a mark rather than a
 * ranker — a distinction no reading in this repository could make before.
 *
 * The two reports are separate types on purpose. A single `ProfileReport` with a `scale` field would
 * have published a `shortlist` for the label scale that counts a `violin` answer as a refusal, and a
 * reader would have had to know which of its eleven fields meant something on which scale. There is
 * no field here that means two things.
 *
 * ## Refusals are counted, not folded
 *
 * A reply that names nothing admissible is `declined`, which `scoreAnswers` already knows how to
 * score, and it is *also* counted as `unparsed` and published. A run whose replies were mostly
 * unreadable reports a low accuracy that is a fact about the answer format; folding those rows into
 * `missed` would report the same number as a run where the model chose the wrong mark every time, and
 * the two have different repairs. The same discipline the judge learned about truncation applies here:
 * a truncated reply is not an answer, so `entryLlm` refuses to publish a run that had any.
 */
import { createHash } from 'node:crypto';
import { capabilitiesOf, createHttpProvider, withCallCounter, type LlmProvider } from '@agentix-e/nl2charts-ai';
import { RECOMMENDABLE_MARKS, type RecommendableMark } from '@agentix-e/nl2charts-chart';
import { applyExitCode, isEntry, loadText2Vis, type LoadOptions, type Text2VisCorpus } from './dataset.js';
import { billOf, formatYuan, type TokenCounts } from '../price.js';
import { cacheKey, openStore, type CacheIdentity, type ContentStore } from './content-store.js';
import { profileAnswer, scoreAnswers, type ChartAnswer, type ProfileInput, type ProfileReport } from './profile.js';
import { familiesOfMark, familyOfLabel, type ChartFamily } from './rule.js';

/**
 * Bumped when the prompt or the option list changes meaning.
 *
 * The list is part of the text and the text is hashed, so a *member* that was added is already a miss.
 * The number covers what the hash cannot see: a gloss whose wording changed the task ("a value over
 * time" → "a value over a period"), or a decision about the answer format. A bump is a clean miss;
 * without one, this file would keep serving answers to a prompt it no longer sends.
 */
export const PROMPT_VERSION = 1;

/** What each mark is, in one clause: the whole of the model's instruction, besides the question. */
const MARK_GLOSS: Readonly<Record<RecommendableMark, string>> = {
  bar: 'categories compared by the length of a bar',
  line: 'a value over time, joined into a line',
  scatter: 'two measures plotted against each other',
  heatmap: 'a measure over two categories, as colour',
  pie: 'parts of one whole, as slices',
  funnel: 'stages of a process, narrowing',
  boxplot: 'a five-number summary of a distribution',
  candlestick: 'open, high, low and close over time',
  radar: 'several measures on axes around a centre',
  parallel: 'several measures as parallel axes',
  gauge: 'one value against a fixed scale',
};

/** One admissible answer: the token the model must write, and the clause that says what it means. */
export interface ChoiceOption {
  readonly name: string;
  readonly gloss: string;
}

/**
 * The closed list this product can draw, which is the arm that is comparable with `profile.ts`.
 *
 * Derived from `RECOMMENDABLE_MARKS` rather than restated, for the reason `census.ts` gives about
 * `coveringMarks`: a second list of "the marks we can draw" is a second answer to a question the
 * contract already answers, and a mark added to one and not the other would make this arm score a
 * product that does not exist.
 */
export function markOptions(): readonly ChoiceOption[] {
  return RECOMMENDABLE_MARKS.map((mark) => ({ name: mark, gloss: MARK_GLOSS[mark] }));
}

/** The gloss for a family, from the mark that draws it — one table of meanings, not two. */
function glossOf(family: ChartFamily): string {
  // *Leads* with, not *covers*: a line covers `area` as its second claim, so a lookup by coverage would
  // describe an area chart as "a value over time, joined into a line" — the one difference the arm is
  // asking about. A family no mark leads with falls through to its own sentence.
  const mark = RECOMMENDABLE_MARKS.find((candidate) => familiesOfMark(candidate)[0] === family);
  if (mark !== undefined) return MARK_GLOSS[mark];
  // The three families no mark leads with are described by what they *are*, because the arm is being
  // asked about them precisely to find out whether the product should draw them.
  if (family === 'histogram') return 'a measure binned and counted, as adjacent bars';
  if (family === 'area') return 'a value over time, filled to the axis';
  return 'a distribution with its density drawn beside it';
}

/**
 * The corpus's own vocabulary, one spelling per family, heaviest family first.
 *
 * The spelling is theirs because the comparison is with their paper: `Bar Chart` is what an annotator
 * wrote and what a Text2Vis table prints, and an arm that answered `bar` would be a second variable —
 * this reader's tolerance for a shorter name — inside a comparison of two systems. A family whose
 * labels appear in the corpus under several spellings gets the one that appears most, so the option
 * list is a function of the corpus rather than of this file's taste.
 */
export function labelOptions(rows: readonly { readonly label: string }[]): readonly ChoiceOption[] {
  // One entry per family, holding both spellings and the family's weight: two maps keyed the same way
  // would need a `?? 0` on every read, and a fallback that can never fire is a branch a reader has to
  // prove dead before trusting the numbers beside it.
  const families = new Map<ChartFamily, { readonly spellings: Map<string, number>; n: number }>();
  for (const row of rows) {
    const family = familyOfLabel(row.label);
    if (family === undefined) continue;
    const entry = families.get(family) ?? { spellings: new Map<string, number>(), n: 0 };
    entry.spellings.set(row.label, (entry.spellings.get(row.label) ?? 0) + 1);
    entry.n += 1;
    families.set(family, entry);
  }
  return [...families.entries()]
    .map(([family, entry]) => {
      const ranked = [...entry.spellings.entries()].sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      );
      return { family, name: (ranked[0] as [string, number])[0], n: entry.n };
    })
    .sort((left, right) => right.n - left.n || left.name.localeCompare(right.name))
    .map(({ family, name }) => ({ name, gloss: glossOf(family) }));
}

/**
 * The instruction, one text for both scales.
 *
 * Short on purpose. A chart name is a one-word answer and every sentence of setup is paid 1,470 times:
 * this prompt is about 180 tokens, which at the provider's cached rate is well under a fen per hundred
 * rows. The question is a separate message so the prefix is byte-identical across the run — that is
 * what makes the provider's own prefix cache a discount rather than a hope, and it is the one prompt
 * shape this repository has measured to be worth building (ADR-195).
 */
export function buildChoicePrompt(options: readonly ChoiceOption[], question: string): readonly [string, string] {
  const listed = options.map((option) => `${option.name} — ${option.gloss}`).join('\n');
  return [
    [
      'Choose the chart that best answers the question below.',
      'You are given the question only: no table, no result, no rows.',
      'Answer with exactly one name from this list, and nothing else:',
      listed,
    ].join('\n'),
    question,
  ];
}

/**
 * Read one name back, or nothing.
 *
 * Deliberately strict: an answer that is a sentence containing a name is an answer this arm did not
 * ask for, and guessing which name a paragraph meant would be this file choosing a mark for the model.
 * What *is* tolerated is the punctuation a chat endpoint adds on its own — quotes, backticks, a
 * trailing full stop, markdown emphasis, a code fence — because refusing those would score the
 * endpoint's formatting rather than its choice.
 */
export function parseChoice(text: string, options: readonly ChoiceOption[]): string | undefined {
  const cleaned = text
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/, '')
    .replace(/^[*_`'"\s]+|[*_`'"\s.]+$/g, '')
    .replace(/\s+/g, ' ');
  const lowered = cleaned.toLowerCase();
  for (const option of options) {
    if (option.name.toLowerCase() === lowered) return option.name;
  }
  return undefined;
}

/** One row's answer as the store keeps it, and as the scorer reads it. */
export interface ModelRow {
  /** The option the reply named, or `undefined` when it named none this arm offered. */
  readonly choice: string | undefined;
  readonly reply: string;
  readonly truncated: boolean;
  /**
   * The tokens the call that produced this answer was billed for, present only when the answer came
   * from the store.
   *
   * A live call's tokens are already in the provider meter that produced them, and counting them here
   * as well would inflate exactly the rows whose cost is under examination. A replayed answer's tokens
   * are in nobody's meter — the run that bought them ended — so this is the only place they survive.
   */
  readonly replayed?: TokenCounts;
  /**
   * Present when the answer came from a store written before it kept meters.
   *
   * Not the same fact as `replayed: {0, 0}`: that would say the call was free, and this says nobody
   * wrote down what it cost. The two are reported apart because a bill assembled from the first is
   * wrong in the direction that makes the next dispatch look cheap.
   */
  readonly unmetered?: true;
}

/**
 * A stored answer: the row, plus the model that wrote it.
 *
 * The model is in the record as well as in the key for the reason `judge-cache.ts` gives: a store
 * copied between two cache directories answers a key with an entry another model wrote, and scoring
 * that answer would be this file reading a model it did not ask.
 */
export interface StoredRow extends ModelRow {
  readonly model: string;
  /** What the call cost, kept with the answer so that a resumed run can say what the reading cost. */
  readonly usage?: TokenCounts;
}

/**
 * A stored answer, if the parsed file is one.
 *
 * Three fields, each checked rather than trusted: a truncated write and a half-finished copy both
 * arrive here as valid JSON, and a `choice` that is neither a string nor an explicit absence would be
 * compared against the option list and quietly fail to match — which is a miss the arm would report as
 * the model's.
 */
export function replyOf(parsed: unknown, expect: { readonly model: string } | undefined): StoredRow | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const row = parsed as Record<string, unknown>;
  if (row['version'] !== PROMPT_VERSION) return undefined;
  if (typeof row['reply'] !== 'string' || typeof row['truncated'] !== 'boolean') return undefined;
  if (typeof row['model'] !== 'string') return undefined;
  if (expect !== undefined && row['model'] !== expect.model) return undefined;
  const choice = row['choice'];
  if (choice !== undefined && choice !== null && typeof choice !== 'string') return undefined;
  const usage = usageOf(row['usage']);
  if (usage === false) return undefined;
  return {
    model: row['model'],
    choice: typeof choice === 'string' ? choice : undefined,
    reply: row['reply'],
    truncated: row['truncated'],
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * The meters in a stored record, `undefined` when the entry predates them, `false` when they are not
 * counts.
 *
 * The two counts a call is billed on are required together: a record with a prompt count and no
 * completion count is a half-written file, and billing half a call is worse than billing none of it
 * because the number would look like a measurement. The cache-hit count is optional *in the record*
 * because a provider is allowed not to report one, and its absence is read as **no hits** — the
 * assumption that costs more, which is the direction a bill should err in: an overstatement makes a
 * lever look expensive, and an understatement makes it look free.
 */
function usageOf(value: unknown): TokenCounts | undefined | false {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) return false;
  const counts = value as Record<string, unknown>;
  for (const field of ['promptTokens', 'completionTokens'] as const) {
    const count = counts[field];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return false;
  }
  const cached = counts['cachedPromptTokens'];
  if (cached !== undefined && (typeof cached !== 'number' || !Number.isInteger(cached) || cached < 0)) return false;
  return {
    promptTokens: counts['promptTokens'] as number,
    completionTokens: counts['completionTokens'] as number,
    cachedPromptTokens: typeof cached === 'number' ? cached : 0,
  };
}

/** What one call is asked, and the options it may answer with. */
export interface ChoiceRequest {
  readonly question: string;
  readonly options: readonly ChoiceOption[];
}

/**
 * Ask one question, once.
 *
 * No retry of its own: the provider retries a 429 or a 5xx inside its own budget, and a second attempt
 * at the *content* of an unreadable answer would be a second sample of a deterministic call, which is
 * a different reading.
 *
 * The temperature is named (`0`) rather than left to the default, because `cacheKey` has to hash the
 * same decision the request carries: `undefined` (this repository's zero) and `null` (no field at all)
 * are two different keys for two different requests.
 */
export async function askOnce(
  provider: LlmProvider,
  request: ChoiceRequest,
  options: { readonly cache?: ContentStore<StoredRow>; readonly maxTokens?: number } = {},
): Promise<ModelRow> {
  const [system, question] = buildChoicePrompt(request.options, request.question);
  const temperature = 0;
  const identity: CacheIdentity = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: question },
    ],
    model: provider.model,
    thinking: undefined,
    maxTokens: options.maxTokens,
    temperature,
  };
  const key = cacheKey(identity, PROMPT_VERSION);
  const cached = options.cache?.get(key, { model: provider.model });
  if (cached !== undefined) {
    // The meters travel with the row, under the name that says where it came from: `replayed` is the
    // cost of a call this run did not make, and `unmetered` is the admission that the store cannot say.
    if (cached.usage === undefined) return { ...cached, unmetered: true };
    return { ...cached, replayed: cached.usage };
  }
  const response = await provider.complete({
    messages: identity.messages,
    temperature,
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    purpose: 'select',
  });
  // `length` is the only finish reason that says the *answer* was cut. Everything else either
  // finished or was stopped by something a reader can see in `reply`.
  const truncated = response.finishReason === 'length';
  const row: ModelRow = {
    // A cut reply names nothing, whatever its first words happened to be. This is not pedantry: at
    // `max_tokens: 32` five replies were cut, and the three whose cut landed just after the name
    // ("Pie Chart." and then a sentence that was never read) were scored as answers, which is how the
    // first full run published 860 top-1 instead of 857. A prefix of an answer is not an answer —
    // the same rule the judge learned at 1,024 tokens, applied where the cut can still be seen.
    choice: truncated ? undefined : parseChoice(response.text, request.options),
    reply: response.text,
    truncated,
  };
  // The model travels with the row: the key already separates models, and this is the lock a store
  // copied between two cache directories has to pass before its answer is read.
  options.cache?.put(key, { ...row, model: provider.model, ...(response.usage === undefined ? {} : { usage: response.usage }) });
  return row;
}

/**
 * How much room a reply gets.
 *
 * A model that declares it thinks aloud is not given a cap at all: its deliberation is billed as
 * completion, so a cap sized for the answer truncates the thinking and reports the cut as an
 * unreadable reply — the failure mode the judge met at 1,024 tokens, where 24 of 1,286 figures came
 * back cut and the whole run had to be re-taken.
 *
 * The cap for a chat model is a fence around a runaway reply, not a size for one word. It was 32,
 * on the reasoning that a chart name is one word plus the punctuation an endpoint appends, and the
 * first full run showed what that reasoning costs: **5 of 2,940 replies were cut**, every one of them
 * a model that began its answer with a sentence, and a single cut reply makes the whole reading
 * unpublishable — so five ordinary chat behaviours cost 1,470 × 2 calls their meaning. 96 leaves room
 * for that sentence to *finish*, which turns a model that will not answer in one word into a row that
 * is `unparsed` (a fact about the model) rather than a row that is `truncated` (a fact about the cap).
 *
 * The cap is part of the cache key, so changing it re-buys the store: this line cost ¥1.25 and the
 * 5 rows, which is the price of measuring the budget instead of assuming it.
 */
export function replyBudget(provider: LlmProvider): number | undefined {
  return provider.capabilities?.thinksAloud === true ? undefined : 96;
}

/** The deadline a chat endpoint has always been given: one word out of eleven, a second or two. */
const CHAT_DEADLINE_MS = 60_000;

/**
 * The deadline a model that thinks aloud is given.
 *
 * Five minutes, and the number is a consequence rather than a taste: the budget it may spend is
 * 8,192 tokens of deliberation (`adaptRequest` sends `maxOutputTokens` for every family) and the
 * endpoint's own stream is the slow part, so a deadline sized for a one-word answer aborts a call
 * that is working. That is not a theory: run `44681062395` dispatched `deepseek-chat` beside
 * `deepseek-reasoner` on the same 1,470 rows, the chat arms restored 2,940 answers from the store in
 * zero calls, and the reasoning arm died on `text2vis: llm call timed out` after ten minutes of
 * asking — a whole dispatch, and the ¥0 it cost is the only reason the receipt is cheap.
 */
const REASONING_DEADLINE_MS = 300_000;

/**
 * How long a call is waited for, before it is a timeout rather than a slow answer.
 *
 * Derived from what the endpoint declares, the way `replyBudget` is, and overridable by the
 * environment the way `BIRD_LLM_TIMEOUT_MS` already is — a deployment that knows its endpoint is
 * slower than this should not need a commit to say so. The parameter is a provider *or* a model name,
 * because the caller that builds the provider needs the deadline before the provider exists.
 */
export function replyDeadline(
  endpoint: LlmProvider | string,
  env: Record<string, string | undefined> = process.env,
): number {
  const declared = Number(env.TEXT2VIS_LLM_TIMEOUT_MS);
  if (Number.isFinite(declared) && declared > 0) return declared;
  const thinksAloud =
    typeof endpoint === 'string' ? capabilitiesOf(endpoint).thinksAloud : endpoint.capabilities?.thinksAloud === true;
  return thinksAloud ? REASONING_DEADLINE_MS : CHAT_DEADLINE_MS;
}

/**
 * One line of log: how long this endpoint is waited for, and why.
 *
 * Said out loud because it is the one number in a run that the artifact cannot carry: a run stopped by
 * a deadline and a run stopped by a wrong answer leave the same file, and only the log says which.
 */
export function describeDeadline(provider: LlmProvider, env: Record<string, string | undefined>): string {
  const seconds = Math.round(replyDeadline(provider, env) / 1000);
  const thinks = provider.capabilities?.thinksAloud === true ? ', which thinks before it answers' : '';
  return `text2vis llm: waiting ${String(seconds)} s per call for ${provider.model}${thinks}`;
}

export type Scale = 'mark' | 'label';

/**
 * What a run spent on the answers it replayed instead of buying.
 *
 * Separate from `ArmCost` rather than added to it, because the two answer different questions and a
 * sum of them answers neither: `ArmCost` is this run's invoice, and this is what the reading would have
 * cost if every answer in it had to be bought again. The first dispatch of the reasoning arm spent a
 * real amount and died before printing a bill; the second printed Y0.0033. Neither number is the
 * reading's cost, and only the pair is.
 */
export interface ReplayedCost {
  /** Answers that came from the store. */
  readonly rows: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  /** 元 at the same table `yuan` uses; absent when the model is unpriced. */
  readonly yuan?: number;
  /** Rows replayed from an entry that recorded no meters: their cost is unknown, not zero. */
  readonly unpriced: number;
}

/** What both scales' reports carry: where the answers came from and what they cost. */
export interface ArmCost {
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  /** 元, from `price.ts`; absent when that table has no price for this model. */
  readonly yuan?: number;
  readonly perRowYuan?: number;
  /** The answers this run did not buy, and what they cost when somebody else did; absent on a live run. */
  readonly replayed?: ReplayedCost;
}

/**
 * The request an arm answered: the two facts that are not in the answers themselves.
 *
 * A report is read months later, and the reading it publishes is only the reading of *one* request.
 * The two variables a reader cannot see in a score are the version of the prompt that was sent and
 * the cap the reply had, and both of them move the number: the first dispatch of this arm read 857
 * at a 32-token cap and the same rows read 861 at 96, so a file that does not name its request
 * cannot be told apart from one taken on an instrument nobody sends any more. `assertArmReport`
 * requires both, and the floor records them, which is what makes the gate able to refuse a stale
 * artifact instead of calling it a re-sample.
 *
 * `budget` is absent rather than zero for a model that thinks aloud: no cap was sent at all, and a
 * `0` would read as a cap of zero tokens.
 */
export interface ArmRequest {
  readonly promptVersion: number;
  readonly budget?: number;
}

export interface ArmBase {
  readonly model: string;
  readonly options: readonly ChoiceOption[];
  /** What was asked of the endpoint, so a reading can be told apart from another request's. */
  readonly request: ArmRequest;
  /** Rows asked about. Not `scored`: a row whose label has no family is asked and not scored. */
  readonly requested: number;
  /** Answers that named an option this arm offered. */
  readonly answered: number;
  /** Answers that named nothing admissible: a subset of the declines, published apart from them. */
  readonly unparsed: number;
  /** Replies cut at the token budget. Any of these makes the run unpublishable. */
  readonly truncated: number;
  /**
   * One entry per asked row, in the order the rows were asked: what was answered, or `null`.
   *
   * A report carries the answers themselves because the alternative is to re-ask for them: an
   * arbitration between this arm and the product needs to know, row by row, what the model said, and
   * a table whose routing had to buy a second sample would be pricing a different reading. `null`
   * rather than an absent entry, because an array that shifted would silently attach every answer to
   * the row before it — which the two count checks in `assertArmReport` refuse.
   */
  readonly choices: readonly (string | null)[];
  readonly cost: ArmCost;
  readonly cache: { readonly hits: number; readonly misses: number; readonly corrupt: number };
}

/** The eleven-way choice, scored by the product's own scorer. */
export interface MarkArm extends ArmBase, ProfileReport {
  readonly scale: 'mark';
}

/** The corpus's own vocabulary, scored by exact family match. */
export interface LabelArm extends ArmBase {
  readonly scale: 'label';
  readonly scored: number;
  readonly exact: number;
  readonly exactShare: number;
  /** Answers naming a family no mark can lead with, which the mark scale can never reach. */
  readonly unreachableHits: number;
  readonly perFamily: readonly { readonly family: ChartFamily; readonly n: number; readonly exact: number }[];
}

export type ArmReport = MarkArm | LabelArm;

/** The arithmetic a report can be wrong about, refused rather than published. */
export function assertArmReport(report: ArmReport): void {
  // The request first, because it is the one field the counts cannot imply: a report whose numbers all
  // add up is a valid reading of *some* request, and this is what says which.
  const request = report.request;
  if (typeof request?.promptVersion !== 'number' || !Number.isInteger(request.promptVersion) || request.promptVersion < 1) {
    throw new Error(
      `text2vis llm: ${String(report.model)} reports prompt version ${String(request?.promptVersion)}, so the reading does not name the prompt that produced it`,
    );
  }
  if (request.budget !== undefined && (!Number.isInteger(request.budget) || request.budget < 1)) {
    throw new Error(
      `text2vis llm: ${String(report.model)} reports a reply budget of ${String(request.budget)}, which is not a positive whole number of tokens; an absent budget is how a model with no cap is written`,
    );
  }
  // The answer list is a column of the report, so it is checked like one: one entry per asked row, and
  // as many entries that name something as `answered` says. An array one short would attach every
  // answer to the row above it, and every later count would still add up.
  if (report.choices.length !== report.requested) {
    throw new Error(
      `text2vis llm: ${String(report.choices.length)} answers for ${String(report.requested)} rows asked, so the answers are not one per row`,
    );
  }
  const named = report.choices.filter((choice) => choice !== null).length;
  if (named !== report.answered) {
    throw new Error(
      `text2vis llm: ${String(named)} answers name an option and ${String(report.answered)} are counted as answered, so one of the two columns is wrong`,
    );
  }
  if (report.answered + report.unparsed !== report.requested) {
    throw new Error(
      `text2vis llm: ${String(report.answered)} answered + ${String(report.unparsed)} unparsed is not the ${String(report.requested)} rows asked`,
    );
  }
  if (report.scale === 'mark') {
    // Equality, not `>=`: every asked row is now scored, and `markAnswer` turns exactly one reply
    // into a refusal — the one that named no offered option. Anything else means a row was counted
    // twice or an unreadable reply was scored as an answer.
    if (report.unparsed !== report.declined) {
      throw new Error(
        `text2vis llm: ${String(report.unparsed)} unparsed replies but ${String(report.declined)} declined rows, so an unreadable reply was scored as an answer or a readable one was thrown away`,
      );
    }
    if (report.top1 > report.shortlist) {
      throw new Error(`text2vis llm: ${String(report.top1)} top-1 hits of ${String(report.shortlist)} shortlist hits`);
    }
    return;
  }
  if (report.exact > report.answered) {
    throw new Error(`text2vis llm: ${String(report.exact)} exact matches out of ${String(report.answered)} answers`);
  }
  const perFamily = report.perFamily.reduce((sum, entry) => sum + entry.n, 0);
  if (perFamily !== report.scored) {
    throw new Error(`text2vis llm: the per-family rows sum to ${String(perFamily)} and ${String(report.scored)} were scored`);
  }
}

/**
 * The population a report was taken over, refused when it is not the population it asked.
 *
 * A row that is asked and cannot be scored is a call that was paid for and thrown away, and the
 * counters above cannot see it: they are all consistent when 1,985 rows are asked and 1,470 scored,
 * because both numbers are true of different populations. The first full run did exactly that — the
 * 515 labels no family names were sent to the model and then dropped by the scorer — so the one
 * sentence that catches it is a comparison of the two, kept separate from the arithmetic so it is
 * reported as its own defect rather than as a rounding disagreement.
 */
export function assertArmPopulation(report: ArmReport): void {
  if (report.requested !== report.scored) {
    throw new Error(
      `text2vis llm: ${String(report.requested)} rows asked and ${String(report.scored)} scored; every row asked must be scored, or the calls the rest cost bought nothing`,
    );
  }
}

/** One row's answer, kept with the row so the pairing cannot drift from the scoring. */
export interface ModelOutcome {
  readonly row: ProfileInput;
  readonly answer: ModelRow;
}

/**
 * The marks a `mark`-scale answer covers, as the scorer wants them.
 *
 * Exported because the arbitration is a second reader of the same answer: `arbitrate.ts` routes a row
 * to one of two answers, and it must turn a mark into families exactly the way the arm that produced
 * the score did. A second copy of this line is a second definition of "what answering `bar` covers",
 * and the two readings would then be able to disagree about a row neither of them changed.
 */
export function markAnswer(choice: string | undefined): ChartAnswer {
  if (choice === undefined) return { mark: 'declined', families: [] };
  return { mark: choice as RecommendableMark, families: familiesOfMark(choice as RecommendableMark) };
}

/** The family a `label`-scale answer names, or nothing. */
function labelAnswer(choice: string | undefined): ChartFamily | undefined {
  return choice === undefined ? undefined : familyOfLabel(choice);
}

export interface ScoreArmOptions {
  readonly model: string;
  readonly options: readonly ChoiceOption[];
  readonly request: ArmRequest;
  readonly usage: { readonly calls: number; readonly promptTokens: number; readonly completionTokens: number; readonly cachedPromptTokens: number };
  readonly cache: { readonly hits: number; readonly misses: number; readonly corrupt: number };
}

/**
 * What the answers this run replayed cost when they were bought.
 *
 * `undefined` when nothing was replayed: a column of zeros would read as "the store answered nothing",
 * and the honest statement about a live run is that there is no replay to report. Rows whose store
 * entry has no meters are counted in `unpriced` rather than priced at zero — the second is a claim, the
 * first is a fact, and the difference is the whole reason this function exists.
 */
export function replayedCost(model: string, outcomes: readonly ModelOutcome[]): ReplayedCost | undefined {
  const replayed = outcomes.filter((outcome) => outcome.answer.replayed !== undefined || outcome.answer.unmetered === true);
  if (replayed.length === 0) return undefined;
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedPromptTokens = 0;
  let unpriced = 0;
  for (const outcome of replayed) {
    const usage = outcome.answer.replayed;
    if (usage === undefined) {
      unpriced += 1;
      continue;
    }
    promptTokens += usage.promptTokens;
    completionTokens += usage.completionTokens;
    cachedPromptTokens += usage.cachedPromptTokens ?? 0;
  }
  const yuan = billOf(model, { promptTokens, completionTokens, cachedPromptTokens });
  return {
    rows: replayed.length,
    promptTokens,
    completionTokens,
    cachedPromptTokens,
    ...(yuan === undefined ? {} : { yuan }),
    unpriced,
  };
}

/**
 * Price one model's answers on one scale.
 *
 * The mark scale is `scoreAnswers`, which is the function `scoreProfile` calls: `model.top1 -
 * profile.top1` is therefore a difference between two answers and not between two arithmetics.
 *
 * The label scale is a count, and it is a count on purpose. Its question is "did the model name the
 * chart the annotator named", an exact family match; giving it a shortlist would let a `line` answer
 * count for an `area` label a second time and would report an accuracy this arm was not asked for.
 */
export function scoreArm(rows: readonly ProfileInput[], outcomes: readonly ModelOutcome[], options: ScoreArmOptions, scale: Scale): ArmReport {
  const byRow = new Map<ProfileInput, ModelRow>(outcomes.map((outcome) => [outcome.row, outcome.answer]));
  const answered = outcomes.filter((outcome) => outcome.answer.choice !== undefined).length;
  const yuan = billOf(options.model, {
    promptTokens: options.usage.promptTokens,
    completionTokens: options.usage.completionTokens,
    cachedPromptTokens: options.usage.cachedPromptTokens,
  });
  const replayed = replayedCost(options.model, outcomes);
  const base: ArmBase = {
    model: options.model,
    options: options.options,
    request: options.request,
    choices: outcomes.map((outcome) => outcome.answer.choice ?? null),
    requested: outcomes.length,
    answered,
    unparsed: outcomes.length - answered,
    truncated: outcomes.filter((outcome) => outcome.answer.truncated).length,
    cost: {
      ...options.usage,
      ...(yuan === undefined ? {} : { yuan, perRowYuan: outcomes.length === 0 ? 0 : yuan / outcomes.length }),
      ...(replayed === undefined ? {} : { replayed }),
    },
    cache: options.cache,
  };
  if (scale === 'mark') {
    const baseReport = scoreAnswers(rows, (row) => markAnswer(byRow.get(row)?.choice), {
      variant: `${options.model}:mark`,
    });
    return { ...baseReport, ...base, scale: 'mark' };
  }
  const perFamily = new Map<ChartFamily, { n: number; exact: number }>();
  let scored = 0;
  let exact = 0;
  let unreachableHits = 0;
  for (const row of rows) {
    const expected = familyOfLabel(row.label);
    if (expected === undefined) continue;
    scored += 1;
    const cell = perFamily.get(expected) ?? { n: 0, exact: 0 };
    cell.n += 1;
    const named = labelAnswer(byRow.get(row)?.choice);
    if (named === expected) {
      exact += 1;
      cell.exact += 1;
      // A family no mark leads with is a hit here and unreachable on the mark scale, which is the one
      // number that separates "the model knows the picture" from "the product can draw it".
      if (RECOMMENDABLE_MARKS.every((mark) => familiesOfMark(mark)[0] !== named)) unreachableHits += 1;
    }
    perFamily.set(expected, cell);
  }
  return {
    ...base,
    scale: 'label',
    scored,
    exact,
    exactShare: scored === 0 ? 0 : exact / scored,
    unreachableHits,
    perFamily: [...perFamily.entries()]
      .map(([family, cell]) => ({ family, ...cell }))
      .sort((left, right) => right.n - left.n || left.family.localeCompare(right.family)),
  };
}

/**
 * The paired comparison, which is the ablation this arm exists to produce.
 *
 * Two arms over the same rows are one number each and one subtraction, and a subtraction of two
 * accuracies cannot say whether the rows that moved are the same rows — this project has published
 * three rounds whose lesson was exactly that. So the rows are paired: `ruleOnly` is the set the
 * product got right and the model got wrong, `modelOnly` its mirror, and McNemar's exact test prices
 * the asymmetry. `both` and `neither` are published because they are the two facts a reader needs in
 * order to know what the disagreement is about at all.
 */
export interface PairedReading {
  readonly both: number;
  readonly ruleOnly: number;
  readonly modelOnly: number;
  readonly neither: number;
  /** Two-sided exact p for `ruleOnly` against `modelOnly`, on the discordant pairs. */
  readonly p: number;
}

/** McNemar's exact two-sided test, by the binomial sum over the smaller tail. */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const choose = (top: number, k: number): number => {
    let result = 1;
    for (let index = 0; index < k; index += 1) result = (result * (top - index)) / (index + 1);
    return result;
  };
  let tail = 0;
  for (let k = 0; k <= Math.min(b, c); k += 1) tail += choose(n, k);
  return Math.min(1, (2 * tail) / 2 ** n);
}

/** Pair the product's answer against the model's, row for row, on the rows both can be scored on. */
export function pairArms(rows: readonly ProfileInput[], modelChoice: (row: ProfileInput) => string | undefined): PairedReading {
  let both = 0;
  let ruleOnly = 0;
  let modelOnly = 0;
  let neither = 0;
  for (const row of rows) {
    const expected = familyOfLabel(row.label);
    if (expected === undefined) continue;
    const rule = profileAnswer(row.prompt, row.tableData).families[0] === expected;
    const model = markAnswer(modelChoice(row)).families[0] === expected;
    if (rule && model) both += 1;
    else if (rule) ruleOnly += 1;
    else if (model) modelOnly += 1;
    else neither += 1;
  }
  return { both, ruleOnly, modelOnly, neither, p: mcnemarExact(ruleOnly, modelOnly) };
}

/** The log's version of one report, and the reason a run is or is not a reading. */
export function describeArm(report: ArmReport): readonly string[] {
  const share = (value: number): string => `${(value * 100).toFixed(2)}%`;
  const head = [
    `\n  ${report.model} on the ${report.scale} scale (${String(report.options.length)} options)`,
    `    answered ${String(report.answered)}, unparsed ${String(report.unparsed)}, truncated ${String(report.truncated)}`,
  ];
  const cost = [
    `    calls ${String(report.cost.calls)}, tokens ${String(report.cost.promptTokens)}+${String(report.cost.completionTokens)}` +
      ` (cached ${String(report.cost.cachedPromptTokens)}), cache ${String(report.cache.hits)} hit / ${String(report.cache.misses)} miss`,
  ];
  if (report.cost.yuan !== undefined) {
    cost.push(`    cost ${formatYuan(report.cost.yuan)}, ${formatYuan(report.cost.perRowYuan ?? 0)} per row`);
  }
  if (report.cost.replayed !== undefined) {
    const replayed = report.cost.replayed;
    // Said as two facts, because it is two: how many answers this run did not buy, and what they cost
    // when they were bought. A resumed run's own bill is nearly nothing and says nothing about the price.
    const price = replayed.yuan === undefined ? 'unpriced model' : formatYuan(replayed.yuan);
    const unknown = replayed.unpriced === 0 ? '' : `, ${String(replayed.unpriced)} of them unmetered`;
    cost.push(`    replayed ${String(replayed.rows)} answers bought for ${price}${unknown}`);
  }
  if (report.scale === 'mark') {
    return [
      ...head,
      `    top-1 ${String(report.top1)} (${share(report.top1Share)}) of ${String(report.scored)} scored, shortlist ${String(report.shortlist)}, declined ${String(report.declined)}`,
      ...cost,
    ];
  }
  return [
    ...head,
    `    exact ${String(report.exact)} (${share(report.exactShare)}) of ${String(report.scored)} scored, of which ${String(report.unreachableHits)} are families no mark leads with`,
    ...cost,
  ];
}

/** One arm, from a corpus to a report. */
export interface ArmSettings {
  readonly provider: LlmProvider;
  readonly scale: Scale;
  /** The rows this arm asks about and scores. */
  readonly rows: readonly ProfileInput[];
  /**
   * Every label the corpus carries, when that is more than `rows` does.
   *
   * The option list is the *question*, and a question that shrank with the sample would make `--limit`
   * a second variable: the smoke run's first twenty rows name two families, so an option list built
   * from them offered two charts, and twelve of the twenty answers named a chart that was not on the
   * list and were counted as unreadable. A sample may decide how many rows are asked; it may not
   * decide what the model is allowed to say.
   */
  readonly vocabulary?: readonly { readonly label: string }[];
  readonly cache?: ContentStore<StoredRow>;
  readonly concurrency: number;
  readonly log?: (line: string) => void;
}

/**
 * How many calls are in flight at once. The same shape `eval/live/run.ts` uses.
 *
 * Exported because `repair.ts` asks a second question over a subset of these rows and must spread it
 * the same way: a concurrency chosen twice is two different wall clocks behind one reading.
 */
export async function pool<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * The arm, from a corpus to a report.
 *
 * Every call is made before any score is taken, because the score needs all of them — and because a run
 * that dies at row 900 should leave the cache holding 900 answers rather than nothing.
 */
export async function runArm(settings: ArmSettings): Promise<{ readonly report: ArmReport; readonly outcomes: readonly ModelOutcome[] }> {
  const options =
    settings.scale === 'mark'
      ? markOptions()
      : labelOptions(settings.vocabulary ?? settings.rows.map((row) => ({ label: row.label })));
  const metered = withCallCounter(settings.provider);
  const cache = settings.cache;
  const before = { hits: cache?.hits ?? 0, misses: cache?.misses ?? 0, corrupt: cache?.corrupt ?? 0 };
  const budget = replyBudget(metered.provider);
  const outcomes = await pool(settings.rows, settings.concurrency, async (row) => ({
    row,
    answer: await askOnce(metered.provider, { question: row.prompt, options }, {
      ...(cache === undefined ? {} : { cache }),
      ...(budget === undefined ? {} : { maxTokens: budget }),
    }),
  }));
  const usage = metered.usage();
  const report = scoreArm(
    settings.rows,
    outcomes,
    {
      model: settings.provider.model,
      options,
      request: { promptVersion: PROMPT_VERSION, ...(budget === undefined ? {} : { budget }) },
      usage: {
        calls: metered.calls(),
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cachedPromptTokens: usage.cachedTokens,
      },
      cache: {
        hits: (cache?.hits ?? 0) - before.hits,
        misses: (cache?.misses ?? 0) - before.misses,
        corrupt: (cache?.corrupt ?? 0) - before.corrupt,
      },
    },
    settings.scale,
  );
  for (const line of describeArm(report)) settings.log?.(line);
  return { report, outcomes };
}

/** Where a model endpoint is, as the environment states it. */
export interface ModelTarget {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

const PRIMARY_DEFAULT = 'deepseek-chat';
const PRIMARY_BASE = 'https://api.deepseek.com/v1';

/**
 * The endpoints this run will ask, primary first.
 *
 * The variable names are the ones `eval/bird/run.ts` already reads, so a workflow that has one set of
 * secrets does not need a second spelling of them: `LLM_MODEL` / `LLM_BASE_URL` / `DEEPSEEK_API_KEY`
 * for the primary and `BIRD_SECOND_*` / `ZHIPU_API_KEY` for the second. This arm adds one name of its
 * own (`TEXT2VIS_LLM_MODELS`) so a single dispatch can ask several models over one corpus rather than
 * a matrix job paying for the download twice.
 */
export function resolveTargets(env: Record<string, string | undefined>): readonly ModelTarget[] {
  const listed = (env.TEXT2VIS_LLM_MODELS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const primary: ModelTarget = {
    model: listed[0] ?? env.LLM_MODEL ?? PRIMARY_DEFAULT,
    baseUrl: env.LLM_BASE_URL ?? PRIMARY_BASE,
    apiKey: env.LLM_API_KEY ?? env.DEEPSEEK_API_KEY ?? '',
  };
  const targets: ModelTarget[] = [primary];
  for (const model of listed.slice(1)) {
    targets.push({
      model,
      // A second model on the same base is the same endpoint under another name — a provider serving a
      // strong and a weak alias — so the primary's URL is the default rather than a second variable.
      baseUrl: env.TEXT2VIS_SECOND_BASE_URL ?? env.BIRD_SECOND_BASE_URL ?? primary.baseUrl,
      apiKey: env.TEXT2VIS_SECOND_API_KEY ?? env.BIRD_SECOND_API_KEY ?? env.ZHIPU_API_KEY ?? primary.apiKey,
    });
  }
  const second = env.BIRD_SECOND_MODEL ?? '';
  if (listed.length <= 1 && second !== '') {
    targets.push({
      model: second,
      baseUrl: env.BIRD_SECOND_BASE_URL ?? primary.baseUrl,
      apiKey: env.BIRD_SECOND_API_KEY ?? env.ZHIPU_API_KEY ?? primary.apiKey,
    });
  }
  return targets;
}

export interface LlmArgs {
  readonly artifact?: string;
  readonly json: boolean;
  readonly limit?: number;
  readonly scales: readonly Scale[];
}

/** Parse the command line, refusing anything it does not use — the reason `parseRuleArgs` gives. */
export function parseLlmArgs(argv: readonly string[]): LlmArgs {
  let artifact: string | undefined;
  let json = false;
  let limit: number | undefined;
  let scales: Scale[] = ['mark', 'label'];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--artifact') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--artifact needs a path');
      artifact = value;
      index += 1;
      continue;
    }
    if (flag === '--limit') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value <= 0) throw new Error('--limit needs a positive whole number');
      limit = value;
      index += 1;
      continue;
    }
    if (flag === '--scales') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--scales needs a list of mark, label');
      const requested = value.split(',').map((name) => name.trim());
      for (const name of requested) {
        if (name !== 'mark' && name !== 'label') {
          throw new Error(`--scales: ${name} is not a scale this arm has (mark, label)`);
        }
      }
      scales = requested as Scale[];
      index += 1;
      continue;
    }
    throw new Error(
      `unknown argument ${flag}: this command asks a model to name a chart, and takes --json, --artifact <path>, --limit <n> and --scales mark,label`,
    );
  }
  return { json, scales, ...(artifact === undefined ? {} : { artifact }), ...(limit === undefined ? {} : { limit }) };
}

/**
 * The rows a scale can score, and how many labels it had to drop to get them.
 *
 * One definition, because two processes now need it: the arm asks these rows, and the arbitration
 * attaches its answers to these rows. `515` of the corpus's `1,985` labels name no family (`Waterfall`,
 * `Treemap`, …), so both scales are blind to them — a row asked and not scored is a call paid for and
 * thrown away, which is a defect the first full run published as 1,985 asked / 1,470 scored.
 */
export function scoredRows(corpus: Text2VisCorpus): { readonly rows: ProfileInput[]; readonly dropped: number } {
  const all: ProfileInput[] = corpus.rows.map((row) => ({
    prompt: row.prompt,
    label: row.chartType,
    tableData: row.raw['Table Data'] ?? '',
  }));
  const rows = all.filter((row) => familyOfLabel(row.label) !== undefined);
  return { rows, dropped: all.length - rows.length };
}

/**
 * A fingerprint of the rows a reading was taken over.
 *
 * Three fields and two separators that cannot occur in the fields, so two different populations
 * cannot hash to the same string by concatenation (`ab` + `c` against `a` + `bc`). The answer store is
 * content-addressed per question, which makes a single row's answer reusable; the roster is the other
 * half — it says *which* questions the answers were given to, so an artifact from an earlier corpus
 * cannot be scored against this one.
 */
export function rosterOf(rows: readonly ProfileInput[]): string {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(`${row.label}\u0000${row.prompt}\u0000${row.tableData}\u0001`);
  return hash.digest('hex');
}

export interface LlmEntryOptions {
  readonly argv?: readonly string[];
  readonly load?: LoadOptions;
  readonly env?: Record<string, string | undefined>;
  /** Builds the providers; overridden in tests, where the endpoint is a server on localhost. */
  readonly providers?: (targets: readonly ModelTarget[]) => readonly LlmProvider[];
  readonly cache?: ContentStore<StoredRow>;
}

/**
 * The command.
 *
 * The exit code carries the three facts a shell can act on and a reader must not have to infer: a run
 * with a truncated reply is a failure even when its share looks fine, a run that scored nothing is a
 * failure because a share over nothing is not a reading, and an unreadable payload is a failure
 * because it is not a corpus.
 */
export async function entryLlm(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  options: LlmEntryOptions = {},
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  try {
    const args = parseLlmArgs(options.argv ?? []);
    const env = options.env ?? process.env;
    const { corpus, source, path } = await loadText2Vis(options.load ?? {});
    log(`text2vis: ${source} ${path}`);
    // The rows are cut *before* the ask, so `--limit` prices a smoke run and never silently scores a
    // corpus it did not send.
    //
    // A label no family names cannot be scored by either scale, and asking it spends a call to learn
    // nothing: 515 of the corpus's 1,985 rows carry one (`Waterfall`, `Treemap`, …). They are dropped
    // here, before the slice, so `--limit 20` is twenty *scored* rows and `requested` is the
    // denominator the reading is published over. The drop is logged because a corpus silently
    // narrowed is a corpus whose score is over the rows that were easy to ask.
    const { rows: scored, dropped } = scoredRows(corpus);
    if (dropped > 0) {
      log(
        `text2vis llm: ${String(dropped)} of ${String(corpus.rows.length)} rows carry a label no family names, so they are not asked`,
      );
    }
    const rows = args.limit === undefined ? scored : scored.slice(0, args.limit);
    const targets = resolveTargets(env);
    if (options.providers === undefined && targets.some((target) => target.apiKey === '')) {
      throw new Error(
        'text2vis llm: no key. Set LLM_API_KEY (preferred) or DEEPSEEK_API_KEY in the environment, never in the repository',
      );
    }
    const providers =
      options.providers === undefined
        ? targets.map((target) =>
            createHttpProvider({
              baseUrl: target.baseUrl,
              apiKey: target.apiKey,
              model: target.model,
              retries: 2,
              // Not a constant: a model that thinks aloud is waited for longer, because the deadline
              // is a deadline on the *reply* and its reply includes the deliberation. Run
              // `44681062395` is the receipt — the chat arms read 861 and 886 out of the store for ¥0
              // and the reasoning arm was aborted at the one-word-answer deadline.
              timeoutMs: replyDeadline(target.model, env),
            }),
          )
        : options.providers(targets);
    const declared = Number(env.TEXT2VIS_LLM_CONCURRENCY ?? 6);
    const concurrency = Number.isFinite(declared) && declared > 0 ? declared : 6;
    // Said out loud, because it is the one number in the request that a reader cannot recover from
    // the artifact: a run that stopped on a deadline and a run that stopped on a wrong answer leave
    // the same file, and only the log says which one happened.
    for (const provider of providers) log(describeDeadline(provider, env));
    const cache =
      options.cache ??
      (env.TEXT2VIS_LLM_CACHE === 'none'
        ? undefined
        : openStore<StoredRow>(env.TEXT2VIS_LLM_CACHE ?? 'eval/.cache/text2vis/llm-choices', PROMPT_VERSION, replyOf));
    const arms: ArmReport[] = [];
    const paired: { readonly model: string; readonly pair: PairedReading }[] = [];
    for (const provider of providers) {
      for (const scale of args.scales) {
        const { report, outcomes } = await runArm({
          provider,
          scale,
          rows,
          // The whole corpus, not the sample: the option list is the question.
          vocabulary: scored.map((row) => ({ label: row.label })),
          concurrency,
          ...(cache === undefined ? {} : { cache }),
          log,
        });
        assertArmReport(report);
        assertArmPopulation(report);
        arms.push(report);
        if (scale === 'mark') {
          const byRow = new Map<ProfileInput, ModelRow>(outcomes.map((outcome) => [outcome.row, outcome.answer]));
          const pair = pairArms(rows, (row) => byRow.get(row)?.choice);
          paired.push({ model: provider.model, pair });
          log(
            `    paired against the product: both ${String(pair.both)}, product only ${String(pair.ruleOnly)}, model only ${String(pair.modelOnly)}, neither ${String(pair.neither)}, McNemar p=${pair.p.toFixed(4)}`,
          );
        }
      }
    }
    // The roster names the rows the answers belong to. It is not a checksum of the artifact: it is the
    // one thing a second process can recompute, and the reason a reading taken over one population
    // cannot be quietly scored against another.
    const payload = {
      corpus: { rows: corpus.rows.length, scored: scored.length, asked: rows.length, roster: rosterOf(rows) },
      arms,
      paired,
    };
    if (args.json) log(JSON.stringify(payload, null, 2));
    if (args.artifact !== undefined) {
      const { mkdir, writeFile, rename } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(args.artifact), { recursive: true });
      await writeFile(`${args.artifact}.part`, `${JSON.stringify(payload, null, 2)}\n`);
      await rename(`${args.artifact}.part`, args.artifact);
      log(`text2vis: wrote ${args.artifact}`);
    }
    const truncated = arms.reduce((sum, arm) => sum + arm.truncated, 0);
    if (truncated > 0) {
      log(`text2vis llm: ${String(truncated)} replies were cut at the token budget, so no share here is a reading`);
      return 1;
    }
    return arms.some((arm) => arm.scored === 0) ? 1 : 0;
  } catch (error) {
    log(`text2vis: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

void entryLlm(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`), {
  argv: process.argv.slice(2),
}).then((code) => applyExitCode(code, process));
