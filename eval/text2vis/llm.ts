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
import { createHttpProvider, withCallCounter, type LlmProvider } from '@agentix-e/nl2charts-ai';
import { RECOMMENDABLE_MARKS, type RecommendableMark } from '@agentix-e/nl2charts-chart';
import { applyExitCode, isEntry, loadText2Vis, type LoadOptions } from './dataset.js';
import { billOf, formatYuan } from '../price.js';
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
}

/**
 * A stored answer: the row, plus the model that wrote it.
 *
 * The model is in the record as well as in the key for the reason `judge-cache.ts` gives: a store
 * copied between two cache directories answers a key with an entry another model wrote, and scoring
 * that answer would be this file reading a model it did not ask.
 */
interface StoredRow extends ModelRow {
  readonly model: string;
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
  return {
    model: row['model'],
    choice: typeof choice === 'string' ? choice : undefined,
    reply: row['reply'],
    truncated: row['truncated'],
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
  if (cached !== undefined) return cached;
  const response = await provider.complete({
    messages: identity.messages,
    temperature,
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    purpose: 'select',
  });
  const row: ModelRow = {
    choice: parseChoice(response.text, request.options),
    reply: response.text,
    // `length` is the only finish reason that says the *answer* was cut. Everything else either
    // finished or was stopped by something a reader can see in `reply`.
    truncated: response.finishReason === 'length',
  };
  // The model travels with the row: the key already separates models, and this is the lock a store
  // copied between two cache directories has to pass before its answer is read.
  options.cache?.put(key, { ...row, model: provider.model });
  return row;
}

/**
 * How much room a reply gets.
 *
 * A chat model answering with one word needs a handful of tokens, and a cap of 32 is enough for the
 * word plus the punctuation an endpoint appends. A model that declares it thinks aloud is not given a
 * cap at all: its deliberation is billed as completion, so a cap sized for the answer truncates the
 * thinking and reports the cut as an unreadable reply — the failure mode the judge met at 1,024
 * tokens, where 24 of 1,286 figures came back cut and the whole run had to be re-taken.
 */
export function replyBudget(provider: LlmProvider): number | undefined {
  return provider.capabilities?.thinksAloud === true ? undefined : 32;
}

export type Scale = 'mark' | 'label';

/** What both scales' reports carry: where the answers came from and what they cost. */
export interface ArmCost {
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  /** 元, from `price.ts`; absent when that table has no price for this model. */
  readonly yuan?: number;
  readonly perRowYuan?: number;
}

export interface ArmBase {
  readonly model: string;
  readonly options: readonly ChoiceOption[];
  /** Rows asked about. Not `scored`: a row whose label has no family is asked and not scored. */
  readonly requested: number;
  /** Answers that named an option this arm offered. */
  readonly answered: number;
  /** Answers that named nothing admissible: a subset of the declines, published apart from them. */
  readonly unparsed: number;
  /** Replies cut at the token budget. Any of these makes the run unpublishable. */
  readonly truncated: number;
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
  if (report.answered + report.unparsed !== report.requested) {
    throw new Error(
      `text2vis llm: ${String(report.answered)} answered + ${String(report.unparsed)} unparsed is not the ${String(report.requested)} rows asked`,
    );
  }
  if (report.scale === 'mark') {
    if (report.unparsed > report.declined) {
      throw new Error(
        `text2vis llm: ${String(report.unparsed)} unparsed replies but only ${String(report.declined)} declined rows, so an unreadable reply was scored as an answer`,
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

/** One row's answer, kept with the row so the pairing cannot drift from the scoring. */
export interface ModelOutcome {
  readonly row: ProfileInput;
  readonly answer: ModelRow;
}

/** The marks a `mark`-scale answer covers, as the scorer wants them. */
function markAnswer(choice: string | undefined): ChartAnswer {
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
  readonly usage: { readonly calls: number; readonly promptTokens: number; readonly completionTokens: number; readonly cachedPromptTokens: number };
  readonly cache: { readonly hits: number; readonly misses: number; readonly corrupt: number };
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
  const base: ArmBase = {
    model: options.model,
    options: options.options,
    requested: outcomes.length,
    answered,
    unparsed: outcomes.length - answered,
    truncated: outcomes.filter((outcome) => outcome.answer.truncated).length,
    cost: {
      ...options.usage,
      ...(yuan === undefined ? {} : { yuan, perRowYuan: outcomes.length === 0 ? 0 : yuan / outcomes.length }),
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
  readonly rows: readonly ProfileInput[];
  readonly cache?: ContentStore<StoredRow>;
  readonly concurrency: number;
  readonly log?: (line: string) => void;
}

/** How many calls are in flight at once. The same shape `eval/live/run.ts` uses. */
async function pool<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
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
    settings.scale === 'mark' ? markOptions() : labelOptions(settings.rows.map((row) => ({ label: row.label })));
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
    const all: ProfileInput[] = corpus.rows.map((row) => ({
      prompt: row.prompt,
      label: row.chartType,
      tableData: row.raw['Table Data'] ?? '',
    }));
    // The rows are cut *before* the ask, so `--limit` prices a smoke run and never silently scores a
    // corpus it did not send.
    const rows = args.limit === undefined ? all : all.slice(0, args.limit);
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
              timeoutMs: 60_000,
            }),
          )
        : options.providers(targets);
    const declared = Number(env.TEXT2VIS_LLM_CONCURRENCY ?? 6);
    const concurrency = Number.isFinite(declared) && declared > 0 ? declared : 6;
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
          concurrency,
          ...(cache === undefined ? {} : { cache }),
          log,
        });
        assertArmReport(report);
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
    const payload = { corpus: { rows: corpus.rows.length, asked: rows.length }, arms, paired };
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
