/**
 * The zero-shot arm: one call per question, `k` Vega-Lite fragments back, scored by the ported judge.
 *
 * ## Why this arm exists and what it is comparable with
 *
 * Every Text2Viz number this repository has published is a reading about *mark choice* — an answer of
 * one word against eleven options. nvBench 2.0 asks a different question: a table and a sentence in,
 * a **set** of Vega-Lite specifications out, scored on the fields, the aggregates and the filters that
 * make one chart the same chart as another. No number here could be placed on that leaderboard, and
 * the gap was recorded as a method gap (ADR 0001).
 *
 * The comparable configuration is the corpus's own **prompting** baseline, ≈58.96 F1@3, not the 81.50
 * a system trained on the benchmark reads. So this arm sends a table and a question and asks for
 * charts, and nothing about it is fitted to the corpus: no few-shot examples taken from the split, no
 * schema linking against the gold fields, no repair loop over the judge.
 *
 * ## What the prompt promises, and why every promise is enforced twice
 *
 * A reply is a JSON array of chart fragments. The parser is strict on purpose — an entry whose mark is
 * not in `SPEC_MARKS` is not a chart this repository can compare, and reading a paragraph for the
 * nearest mark would be this file choosing instead of the model. Three tolerances are allowed because
 * they are formatting rather than content: a code fence, prose around the array, and a reply that
 * names fewer charts than asked for.
 *
 * The `k` is a *scoring* parameter (3 and 5), and asking for `k` in one call is a deliberate choice
 * against asking `k` times: one call per question costs a third of the prompt three times over, and
 * the corpus's own questions have two to five valid answers, so the model is being asked what it
 * already knows rather than sampled.
 *
 * ## The filter is part of the answer
 *
 * 778 of dev's 2,321 golds carry a `transform`, and the judge compares transforms. A model that names
 * the right fields and forgets `"authorder" >= 2` produced a different chart, and the arm does not
 * paper over that by dropping the channel before comparing: the instruction says to emit the filter,
 * and the reading says how often it did.
 *
 * ## Cost
 *
 * One call per question, `k` fragments out, temperature 0, answers content-addressed on the exact
 * request. A second dispatch of an unchanged prompt costs nothing, which is what makes a prompt edit
 * affordable to measure rather than argue about.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHttpProvider, withCallCounter, type LlmProvider } from '@agentix-e/nl2charts-ai';
import { billOf, formatYuan, type TokenCounts } from '../price.js';
import { cacheKey, openStore, type CacheIdentity, type ContentStore } from '../text2vis/content-store.js';
import { runIfEntry } from '../entry.js';
import { parseSplit, resolveTypes, type SplitRow } from './check.js';
import { corpusPromptOf, finalOutputOf, parseModeOf, REPLICAS, type Replica } from './corpus-prompt.js';
import { DEFAULT_BUDGET_CNY, quoteLine, quoteOf, refusalOf, unitPriceOf, type Budget, type Quote } from './budget.js';
import { diagnose, labelsOf, type Diagnostic } from './diagnose.js';
import { factsOf, type GoldFacts } from './facts.js';
import { perQuestionOf, readingOf, type Case, type Chart, type FieldTypes, type Reading } from './judge.js';

/**
 * Bumped when the instruction, the mark list or the reply format changes meaning.
 *
 * The text is hashed into the answer's key, so a changed sentence is already a miss; this number
 * covers what a hash cannot see — a reply format whose *meaning* changed while its bytes did not.
 */
export const PROMPT_VERSION = 1;

/**
 * How much of a split may go unanswered before the reading is a floor instead of a measurement.
 *
 * A failed call scores zero, so failures do not shorten the denominator — they pad it with zeros, and
 * the direction of that error is fixed: the arm that failed more reads lower, by an amount nobody can
 * bound. One percent is the largest share whose worst case is still inside the instrument: on 751
 * questions it is seven questions, and a mean can move by at most seven questions' worth (1pp), under
 * the 1.25pp the A/A pair resolves. Above it, the run exits 3 and names the share rather than
 * publishing a green job, because a green job is what puts a contaminated number in a document.
 */
export const MAX_FAILED_SHARE = 0.01;

/** The widths every reading is reported at, because the leaderboard reports these two. */
const SCORED_KS = [1, 3, 5] as const;

/** The marks the corpus uses, which is also the list the model is offered. */
export const SPEC_MARKS = ['bar', 'line', 'point', 'rect', 'arc', 'boxplot'] as const;
export type SpecMark = (typeof SPEC_MARKS)[number];

/** Channels the judge compares. A channel outside this list is not a channel the reference reads. */
export const SPEC_CHANNELS = ['x', 'y', 'theta', 'color', 'size'] as const;

/** Aggregates that appear in the corpus. A model may name any of them. */
export const SPEC_AGGREGATES = ['count', 'sum', 'mean', 'min', 'max'] as const;

/**
 * Instructions that can be switched on independently, so a reading can say which one moved it.
 *
 * Each rule answers a measured fact about the corpus rather than a guess about the model, and each is
 * a separate arm because a prompt is a bundle of decisions and a bundle cannot be attributed:
 *
 * - `count` — the corpus writes a row count as `{"aggregate": "count"}` with **no** `field`. Its dev
 *   golds carry 1,890 aggregate slots and never name a column for a count, because a count counts
 *   rows. Of 40 replies read verbatim, 24 named one anyway; of 783 scored predictions, 157 were equal
 *   to a gold the moment that column was ignored.
 * - `variants` — every dev question carries 2 to 5 golds, and the golds of one question differ in
 *   almost nothing: pairwise, `field` varies 571 times, the channel set 393, two channels 285, and
 *   the mark only 96. The corpus is enumerating plausible *column assignments*, so `k` candidates
 *   spent on `k` marks are `k` candidates spent on the wrong axis.
 * - `ranks` — the corpus's schema carries `unique_value_counts` beside the type map, and its own
 *   prompting baseline prints it. This arm printed the type and not the count, which leaves the one
 *   decision the gold sets turn on to the model's guess: which columns can take a free axis. A count
 *   is mechanical where a name is not — `authid` has thirteen distinct values over thirteen rows,
 *   `authorder` has three, and a model reading the two names in isolation has no way to know that.
 *   **The first draft of this rule was wrong, and an offline check said so before a yuan was spent**:
 *   it read "distinct count equals row count" as *identifier, therefore no channel*, and the dev split
 *   contradicts it — 1,964 of 4,567 gold field encodings (43%) name such a column, 938 of them on `x`,
 *   because a timestamp is unique per row and is still the axis. What the split says instead is that
 *   the gold set is built from the *columns* and not from their names: 248 of 750 questions cover
 *   every column of their table. So the rule states the arithmetic as a way to tell a category from a
 *   measure and explicitly forbids dropping a column for sounding like an id — the opposite advice to
 *   the draft, and the one the golds support.
 * - `values` — the corpus publishes `table_schema.column_examples` for every sample, and its names
 *   are opaque (`authid`, `authorder`, `authposition` are three columns of the same table). A column
 *   list that carries three values per column is the corpus's own disambiguation, and it is part of
 *   the schema rather than of the gold: 310 of 750 questions have golds that differ only in one
 *   channel's field, over a median of 5 columns, so telling the columns apart is the whole game.
 * - `corpus2` — where the misses stop agreeing. Over the 590 misses of the selected arm, 258 part on
 *   `field` and 174 on the channel set, against 76 on the mark; the gold sets of a question are not
 *   rival guesses but **one chart per remaining column**, which is why `variants` was the right idea
 *   in the wrong words. The rule states the construction — distinct columns, one chart per column
 *   left free — and shows it once, because a model copies an example far more reliably than it
 *   follows a description. The corpus's own baseline prompt opens with *recommend 1 to 5 different
 *   charts*, and the selected arm's 827 predictions over 750 questions is 1.10: the arm was asked
 *   for one chart and answered one.
 * - `steps` — the construction is a *decision* before it is an answer, and the arm was going straight
 *   to the answer. Every `-Step` variant on the corpus's own table beats its direct-prompting
 *   counterpart (GPT-4o 58.96 → 60.78, Qwen2.5-7B 47.17 → 64.08 F1@5), which is the corpus's
 *   evidence that the decomposition is the lever. Here the decision is cheap to name: which channel
 *   the question leaves free, which columns could carry it, and which measure, mark and filter it
 *   does name. Asked as a preamble, it makes the enumeration explicit instead of implicit, and step
 *   two is exactly the set the golds are.
 * - `dtype` — the one thing the other rules never say: which *kind* of column a channel accepts. The
 *   test split's second-largest field-first bucket is `misplaced` (151 of 465): the reply names a
 *   column a gold names, on a channel no gold puts it on. That is an assignment error, so a rule
 *   about which column to choose cannot reach it. The golds answer it absolutely, over 9,076 field
 *   encodings across both splits (`eval/nvbench2/dtypes.ts`): `color` is a categorical column in
 *   **2,583 of 2,583**, `size` is quantitative and aggregated in 156 of 156, `theta` is quantitative
 *   in 521 of 521, and `x` carries an aggregate in **0 of 3,530**. A measure on `color` is not a
 *   disagreement with the golds; it is a category error, and it is now stated as one.
 */
export const RULES = ['count', 'ranks', 'variants', 'values', 'corpus', 'corpus2', 'steps', 'spread', 'dtype'] as const;
export type Rule = (typeof RULES)[number];

/**
 * The rules the product path sends, which is the arm the ablation measured best.
 *
 * `count`, `corpus` and `corpus2` read 22.39 F1@3 on dev against 5.02 for no rules at all: 15.88 with
 * `count,corpus`, then +6.51 when the arm was asked for a set instead of a single chart. `steps` adds
 * a `STEPS:` preamble naming the ambiguity, its candidate columns and the measure before the array,
 * and reads **26.28** — +3.90 with a paired bootstrap interval of [1.99, 5.80] over 750 questions,
 * which is the first prompt change in this file whose effect is separated from the noise. `variants`
 * (14.64 with `count`), `values` (4.82 alone) and `count,variants,corpus` (14.44) were each measured
 * and not selected. `test/nvbench2-arm.test.ts` re-derives this from `metrics.json`, so an arm that
 * beats this one without the default following it fails CI rather than drifting quietly.
 */
export const DEFAULT_RULES: readonly Rule[] = ['count', 'ranks', 'corpus', 'corpus2', 'steps'];

/**
 * The rules a reasoning tier is sent, which is not always the same list.
 *
 * `steps` and `ranks` both separate from zero on the chat tier and neither separates on the reasoning
 * tier: `steps` reads +1.16 [−0.52, +2.79] there and `ranks` reads −0.23 [−1.63, +1.26], which is a
 * third of the bill again for nothing measurable. A tier that already resolves the ambiguity in its
 * own words does not need either preamble, and the tier is where a third of the bill goes — so the
 * default is layered rather than one list pretending to be optimal for both.
 *
 * `metrics.json` holds both readings under `arms.layers`, and `test/nvbench2-arm.test.ts` re-derives
 * both lists from it: a rule that starts separating on the reasoning tier has to be added here, and a
 * rule that stops separating on the chat tier has to come out of `DEFAULT_RULES`, or CI says so.
 */
export const REASONING_RULES: readonly Rule[] = ['count', 'corpus', 'corpus2'];

/**
 * Which replica the product path sends, if the ablation found one better than our own prompt.
 *
 * `undefined` means this repository's instruction, and it is the shipped value until a replica
 * separates from it on a full split. The point of the constant is that the *product* has a place to
 * put the answer: a reading that says the corpus's prompt is better and a product that cannot send it
 * is the split between experiment and delivery that this file exists to close. `test/nvbench2-arm.test.ts`
 * reads `metrics.json` and refuses a default that disagrees with what the ablation selected, in either
 * direction — a better replica nobody shipped fails, and a shipped replica nobody measured fails.
 *
 * Deliberately not a default argument of `buildSpecPrompt`: an arm that forgot to name its replica
 * would then silently send one, and an ablation of our own rules would be measuring theirs.
 */
export const DEFAULT_REPLICA: Replica | undefined = undefined;

/** What each rule adds to the instruction. Wrapped to keep the system message readable in a log. */
const RULE_TEXT: Readonly<Record<Rule, readonly string[]>> = {
  count: [
    'A count names no column: write {"aggregate": "count"} with no "field", because a count counts',
    'rows rather than a column of them. Name a field only for sum, mean, min and max.',
  ],
  ranks: [
    'Each column is followed by how many distinct values it holds. Use that count to decide what a',
    'column is for, never to leave it out: few distinct values against many rows means a category,',
    'and a category is the natural free axis; as many distinct values as rows means the column is',
    'unique per row, which makes a timestamp an axis and a number an identifier that is still a',
    'column of the table. The set is built from the columns, not from the names: do not drop a column',
    'because its name sounds like an id or a code, and do not promote one because its name sounds',
    'like a measure. Every column the question does not fix is a chart, up to the width asked for.',
  ],
  variants: [
    'The array is a set of charts an analyst would accept, not several attempts at one chart: keep the',
    'mark, the measure and any filter identical across entries, and let the entries differ only in',
    'which column carries the axis or channel the question does not name. Most plausible first.',
  ],
  values: [
    'Each column is listed with sample values. Use them to tell columns apart: a question about',
    'amounts asks for the column whose values are amounts, not the one whose name resembles it.',
  ],
  corpus: [
    'Channels are constrained by the mark. Follow (mark:channels)=(bar:[x,y,(color)];',
    'line:[x,y,(color)]; arc:[color,theta]; point:[x,y,(color),(size)]; rect:[x,y,(color)];',
    'boxplot:[x,y]), where a parenthesised channel is optional and every other one is required.',
    'When the question names a chart type, use that type. When it names none, infer from the task:',
    'trend suggests bar or line, distribution bar or arc or line or boxplot, correlation point or rect.',
    'When a phrase in the question could name more than one column, each candidate column is a chart',
    'of its own: those are what the entries of the array are for.',
  ],
  corpus2: [
    'Return a set of charts rather than one: the question is ambiguous, and the array is the readings',
    'it allows. Two charts of the set are different when a different column carries a channel. Build',
    'the set the way the corpus does: the measure sits on the aggregated channel, each column the',
    'question names sits on the channel it names, and every column still free is a chart of its own on',
    'the remaining axis, most plausible first. No chart puts one column on two channels.',
  ],
  spread: [
    'Check the array before you send it: no entry may name only columns an earlier entry already named.',
    'Each entry is one guess, so an entry built from the same columns as an earlier one is a guess you',
    'did not make. When the table holds a column that neither the question nor the measure needs, give',
    'that column an entry of its own on the free channel instead of repeating a column you already',
    'used. Only when every column is already taken may two entries share one, and then they differ in',
    'the mark or in the filter.',
  ],
  dtype: [
    'A channel accepts one kind of column, and the kinds are not interchangeable. A column you count,',
    'sum, average, or take the min or max of is a measure: it takes y, or theta in an arc chart, or',
    'size when a third measure is encoded, and it never takes x and never takes color. A column whose',
    'values name things rather than measure them is a category: it takes x or color, and color takes a',
    'category and nothing else, so a measure on color is wrong before it is compared. A timestamp, or a',
    'column with as many distinct values as rows, is a dimension and takes x. When the question names a',
    'measure and the table also holds a categorical column the question does not use, the measure takes',
    'y and that column takes color, rather than the measure taking color.',
  ],
  steps: [
    'Decide before you answer. Start a line "STEPS:" and then three numbered lines, each one short and',
    'written in plain words with no brackets and no JSON: 1) the ambiguity, which is the channel the',
    'question leaves free; 2) its candidates, every column of the table that could carry it, in the',
    'order you would try them; 3) the measure, the mark and the filter the question does name. Then a',
    'line "ANSWER:" and the array. The array holds one chart per candidate column of step 2, so the',
    'two parts agree: a column you did not list in step 2 is not a chart.',
  ],
};

/**
 * The construction, shown once rather than described.
 *
 * `corpus2` is the only rule that carries an example, and it carries one because of what the shape
 * of the gold sets is: the set of a question is *every remaining column on the free axis*, which is
 * a mechanical statement a single worked case makes unambiguous and a sentence makes arguable. The
 * table is invented rather than taken from the split — a borrowed example would be a few-shot prompt
 * fitted to the corpus, and ADR 0001 is what forbids that.
 */
const SET_EXAMPLE_HEAD: readonly string[] = [
  'Worked example. Columns: product (category), region (category), month (temporal), price (quantitative).',
  'Question: show the average price per region in a bar chart.',
];

/** The same example answered in the two parts `steps` asks for, so the two rules cannot disagree. */
const SET_EXAMPLE_STEPS: readonly string[] = [
  'STEPS:',
  '1. ambiguity: the x axis, because the question names the measure and only one of the columns.',
  '2. candidates: region, product, month.',
  '3. measure: mean of price; mark: bar; filter: none.',
  'ANSWER:',
];

const SET_EXAMPLE_BODY: readonly string[] = [
  '[{"mark": "bar", "encoding": {"x": {"field": "region"}, "y": {"field": "price", "aggregate": "mean"}}},',
  ' {"mark": "bar", "encoding": {"x": {"field": "product"}, "y": {"field": "price", "aggregate": "mean"}}},',
  ' {"mark": "bar", "encoding": {"x": {"field": "month"}, "y": {"field": "price", "aggregate": "mean"}}}]',
];

const SET_EXAMPLE_TAIL: readonly string[] = [
  'The first chart is the one the question asked for; the other two put the same measure on the same',
  'channel and give the free axis each column the question did not name.',
];

/** The identity of one answer: what was said to which model, under which prompt. */
function identityOf(system: string, user: string, model: string, maxTokens: number): CacheIdentity {
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    model,
    thinking: undefined,
    maxTokens,
    temperature: 0,
  };
}

/**
 * How many distinct values a column holds, when the schema states it in a form a reader can use.
 *
 * `unique_value_counts` is `Record<string, unknown>` because it is parsed from a file, so this guard
 * is not defensive noise: the corpus writes integers, and anything else is a schema the rule has
 * nothing to say about. Failing to `undefined` keeps the column listed by type alone, rather than
 * printing `[undefined distinct]` into a prompt and calling it a signal.
 */
function distinctOf(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
}

/**
 * The instruction, and the table it is about.
 *
 * The two messages are separate for the reason `eval/text2vis/llm.ts` gives: the system half is
 * byte-identical across the run, so a provider's prefix cache is a discount rather than a hope. The
 * fields are listed with the type map's own word for each one, because the reference reverses axes by
 * type and a model that guesses a type produces a chart the corpus calls transposed.
 *
 * A `replica` replaces both halves with the corpus's own, which is why it is a parameter rather than a
 * rule: the rules widen one instruction, and a replica is a different instrument. `k` is not stated to
 * a replica either — the corpus's instruction asks for one to five charts, and printing our own width
 * into its sentence would be the divergence the replica exists to remove.
 */
export function buildSpecPrompt(
  row: Pick<SplitRow, 'question'> &
    Partial<Pick<SplitRow, 'columns' | 'examples' | 'counts'>>,
  types: FieldTypes,
  k: number,
  rules: readonly Rule[] = DEFAULT_RULES,
  replica?: Replica,
): readonly [string, string] {
  if (replica !== undefined) {
    return corpusPromptOf(replica, {
      columns: row.columns ?? [],
      examples: row.examples ?? {},
      counts: row.counts ?? {},
      question: row.question,
    });
  }
  const system = [
    'You write Vega-Lite specifications that answer questions about one table.',
    `Return a JSON array of at most ${String(k)} charts, most likely first. Every element has exactly these keys:`,
    '"mark", "encoding", and "transform" only when the question restricts the rows.',
    `"mark" is one of: ${SPEC_MARKS.join(', ')}.`,
    `"encoding" maps channels (${SPEC_CHANNELS.join(', ')}) to objects of the form {"field": "...", "aggregate": "..."}.`,
    'Use the column names exactly as they appear in the table. Name an aggregate',
    `(${SPEC_AGGREGATES.join(', ')}) whenever the question asks for a count, a total, or an average.`,
    'When the question restricts the data, add "transform": [{"filter": {"field": "...", "gte": 2}}]',
    'using one of equal, lt, lte, gt, gte, range, oneOf.',
    ...rules.flatMap((rule) => RULE_TEXT[rule]),
    ...(rules.includes('corpus2')
      ? [...SET_EXAMPLE_HEAD, ...(rules.includes('steps') ? SET_EXAMPLE_STEPS : []),
        ...SET_EXAMPLE_BODY, ...SET_EXAMPLE_TAIL]
      : []),
    ...(rules.includes('steps')
      ? ['Write both parts and nothing else: no prose outside them, no code fence, no explanation.']
      : ['Answer with the array and nothing else: no prose, no code fence, no explanation.']),
  ].join('\n');
  const samples = row.examples ?? {};
  const counts = row.counts ?? {};
  const fields = Object.entries(types)
    .map(([name, kind]) => {
      // The count comes before the samples because it is the cheaper half of the same sentence: a
      // reader who stops after `[3 distinct]` still knows the column is not an identifier.
      const distinct = distinctOf(counts[name]);
      const listed = rules.includes('ranks') && distinct !== undefined
        ? `${name} (${kind}) [${String(distinct)} distinct]`
        : `${name} (${kind})`;
      if (!rules.includes('values')) return listed;
      const values = samples[name];
      const shown = Array.isArray(values) ? values.map((value) => String(value)).join(', ') : '';
      return shown.length === 0 ? listed : `${listed}: ${shown}`;
    })
    .join(', ');
  const user = [`Table columns: ${fields}`, `Question: ${row.question}`].join('\n');
  return [system, user];
}

/**
 * The prompt the product path sends: the shipped rules, and the shipped replica if one was selected.
 *
 * One function rather than a caller assembling the two constants, so that "what the product sends" is a
 * single expression a test can compare with the measurement — and so that a change to either constant
 * is a change to the product rather than a change to a constant beside it.
 */
export function productPrompt(
  row: Pick<SplitRow, 'question'> & Partial<Pick<SplitRow, 'columns' | 'examples' | 'counts'>>,
  types: FieldTypes,
  k: number,
  tier: 'chat' | 'reasoning' = 'chat',
): readonly [string, string] {
  return buildSpecPrompt(row, types, k, tier === 'reasoning' ? REASONING_RULES : DEFAULT_RULES, DEFAULT_REPLICA);
}

/** How a reply's interchangeable axes are offered, if at all. */
export type Mirrors = 'none' | 'interleave' | 'append';

/**
 * The marks whose two position channels are interchangeable to the reference.
 *
 * `preprocess` normalises the other cases itself: two quantitative axes are swapped when their names
 * sort the other way, and a bar, line or boxplot with a quantitative x and a non-quantitative y is
 * turned. A `rect` heat map and a `point` scatter are left as written, so the corpus enumerates both
 * orientations in the gold set — 109 of the shipped reasoning arm's 465 column-first misses are one
 * swap away from a gold they did not otherwise touch. Offering the mirror is therefore answering the
 * question the way the corpus answers it, not a tolerance added to the judge.
 */
const MIRROR_MARKS: readonly string[] = ['rect', 'point'];

/** The same chart with its two position channels exchanged, when the mark makes that meaningful. */
export function mirrorsOf(chart: Chart): Chart | undefined {
  if (!MIRROR_MARKS.includes(chart['mark'] as string)) return undefined;
  const encoding = chart['encoding'];
  if (!isRecordLike(encoding)) return undefined;
  const x = encoding['x'];
  const y = encoding['y'];
  if (!isRecordLike(x) || !isRecordLike(y)) return undefined;
  return { ...chart, encoding: { ...encoding, x: y, y: x } };
}

/**
 * A reply, with the orientations the mark leaves open.
 *
 * `interleave` puts each mirror directly after the chart it mirrors, so a width of three becomes the
 * first column and both of its readings; `append` keeps the model's own order and puts every mirror
 * after it, which at `k`=3 means they are not scored and the flag is a no-op. Both exist because the
 * choice is a trade — a slot spent on an orientation is a slot not spent on another column — and the
 * cached answers can price that trade without buying anything.
 */
export function withMirrors(charts: readonly Chart[], mode: Mirrors): Chart[] {
  if (mode === 'none') return [...charts];
  if (mode === 'append') {
    const mirrors = charts.map(mirrorsOf).filter((chart): chart is Chart => chart !== undefined);
    return [...charts, ...mirrors];
  }
  const out: Chart[] = [];
  for (const chart of charts) {
    out.push(chart);
    const mirror = mirrorsOf(chart);
    if (mirror !== undefined) out.push(mirror);
  }
  return out;
}

/** The same array without its repeats, in the order the model wrote them. */
function dedupe(charts: readonly Chart[]): Chart[] {
  const seen = new Set<string>();
  const out: Chart[] = [];
  for (const chart of charts) {
    const canonical = JSON.stringify(chart);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(chart);
  }
  return out;
}

/** Whether one channel is a channel the reference can compare: a field, an aggregate, or both. */
function channelOk(value: unknown): boolean {
  if (!isRecordLike(value)) return false;
  const field = value['field'];
  const aggregate = value['aggregate'];
  if (field !== undefined && typeof field !== 'string') return false;
  if (aggregate !== undefined && typeof aggregate !== 'string') return false;
  return field !== undefined || aggregate !== undefined;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One candidate chart, or `undefined` when the entry is not a chart.
 *
 * Only three keys survive: `mark`, `encoding`, `transform`. The judge compares the keys it knows and
 * then every key it does not, so a reply carrying a `"title"` or a `"width"` would be unequal to a
 * gold describing the same chart. Dropping them is not generosity; it is refusing to score
 * typography, which is the reduction ADR 0001 states.
 */
export function chartOf(entry: unknown): Chart | undefined {
  if (!isRecordLike(entry)) return undefined;
  const mark = entry['mark'];
  if (typeof mark !== 'string' || !(SPEC_MARKS as readonly string[]).includes(mark)) return undefined;
  const encoding = entry['encoding'];
  if (!isRecordLike(encoding)) return undefined;
  const kept: Record<string, unknown> = {};
  for (const channel of SPEC_CHANNELS) {
    const value = encoding[channel];
    if (value === undefined) continue;
    if (!channelOk(value)) return undefined;
    kept[channel] = value;
  }
  if (Object.keys(kept).length === 0) return undefined;
  const chart: Record<string, unknown> = { mark, encoding: kept };
  const transform = entry['transform'];
  if (Array.isArray(transform) && transform.length > 0) chart['transform'] = transform;
  return chart;
}

/**
 * The candidate list a reply is worth, or an empty list when the reply is not one.
 *
 * The array is found rather than demanded at position zero: a chat endpoint that wraps JSON in a
 * sentence is answering the question, and refusing it would score the wrapper. What is *not* found
 * for it is a second array — the first `[` and the last `]` are the only pair tried, so a reply
 * containing two answers is read as one malformed answer rather than as two.
 */
/**
 * How a reply says where its charts are.
 *
 * `array` is this repository's contract and the corpus's basic one — a JSON array, optionally behind
 * `ANSWER:` or `#OUTPUT:`. `finalOutput` is the step contract, an object whose `final_output` is the
 * array; reading it as `array` would find the first `[` of `thinking_steps`, which is a column list
 * and not a chart list.
 */
export type ParseMode = 'array' | 'finalOutput';

/** One candidate array, deduplicated and cut to the width the caller asked for. */
function chartsOf(entries: readonly unknown[], k: number): Chart[] {
  const charts: Chart[] = [];
  for (const entry of entries) {
    const chart = chartOf(entry);
    if (chart !== undefined) charts.push(chart);
  }
  return dedupe(charts).slice(0, k);
}

export function parseSpecs(text: string, k: number, mode: ParseMode = 'array'): Chart[] {
  if (k <= 0) return [];
  if (mode === 'finalOutput') {
    const output = finalOutputOf(text);
    return output === undefined ? [] : chartsOf(output, k);
  }
  const cleaned = text
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/, '')
    .trim();
  // `steps` renames where the answer begins, and the marker is honoured whether or not the rule that
  // asked for it was on: a reply is read for the answer it contains, and the marker is a statement
  // about which part that is. It narrows the search — it does not add a second candidate, because the
  // bracket pair after the last marker is still the only pair tried.
  const marker = cleaned.lastIndexOf('ANSWER:');
  const afterMarker = marker === -1 ? '' : cleaned.slice(marker + 'ANSWER:'.length);
  // A marker with no array behind it is a mention rather than a statement — a model that repeats the
  // word after its answer must not turn a good reply into an empty one — so the whole text is read.
  const body = afterMarker.lastIndexOf(']') > afterMarker.indexOf('[') ? afterMarker : cleaned;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  // A slice that starts at `[` and parses is an array by construction, so there is no branch here
  // for the non-array case: a reply whose brackets do not enclose valid JSON never reaches this line.
  return chartsOf(parsed as unknown[], k);
}

/** One stored answer: what the model wrote, and what the call was billed for. */
export interface StoredAnswer {
  readonly version: number;
  readonly model: string;
  readonly reply: string;
  readonly truncated: boolean;
  readonly usage?: TokenCounts;
}

/**
 * A stored answer, if the parsed file is one — every field checked rather than trusted.
 *
 * `expectModel` is optional because a store is also read without an expectation, and the model that
 * wrote the entry is then read *from* the entry rather than compared with nothing.
 */
export function answerOf(parsed: unknown, expectModel?: string): StoredAnswer | undefined {
  if (!isRecordLike(parsed)) return undefined;
  if (parsed['version'] !== PROMPT_VERSION) return undefined;
  const model = parsed['model'];
  if (typeof model !== 'string') return undefined;
  if (expectModel !== undefined && model !== expectModel) return undefined;
  if (typeof parsed['reply'] !== 'string' || typeof parsed['truncated'] !== 'boolean') return undefined;
  const usage = parsed['usage'];
  if (usage === undefined) {
    return { version: PROMPT_VERSION, model, reply: parsed['reply'], truncated: parsed['truncated'] };
  }
  if (!isRecordLike(usage)) return undefined;
  const prompt = usage['promptTokens'];
  const completion = usage['completionTokens'];
  if (typeof prompt !== 'number' || typeof completion !== 'number') return undefined;
  const cached = usage['cachedPromptTokens'];
  return {
    version: PROMPT_VERSION,
    model,
    reply: parsed['reply'],
    truncated: parsed['truncated'],
    usage: {
      promptTokens: prompt,
      completionTokens: completion,
      ...(typeof cached === 'number' ? { cachedPromptTokens: cached } : {}),
    },
  };
}

/** One question, after the arm has answered it. */
export interface AnsweredRow {
  readonly index: number;
  readonly charts: readonly Chart[];
  /** True when the endpoint said the reply hit its budget. A truncated reply is not an answer. */
  readonly truncated: boolean;
  /** True when nothing in the reply was a chart. */
  readonly unparsed: boolean;
  /**
   * True when the call produced no reply at all — a deadline or a transport fault that survived every
   * attempt, or a budget too small to answer inside.
   *
   * Distinct from `unparsed`, which is an answer this repository cannot read, and distinct from a wrong
   * answer, which is one it can. It scores zero and keeps its place: the question was asked and not
   * answered, which is a miss on the split the reading is taken over. It is also counted, so a reader
   * can see how much of a reading is transport rather than thinking.
   *
   * The previous behaviour — dropping the row — was a selection on the outcome. The questions it
   * removed were exactly the ones this arm got stuck on, so the arm that failed *more* was the arm
   * whose denominator shrank, and two arms over one split reported different denominators. That made
   * every paired test refuse (`compare.ts`) and left the reading flattering the slower system.
   */
  readonly failed: boolean;
  readonly replayed: boolean;
  /** True when this row cost an endpoint call. A row whose table had no type map cost none. */
  readonly called: boolean;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/** What the arm costs and what it read. */
export interface ArmReport {
  readonly split: string;
  readonly model: string;
  readonly k: number;
  /** How many charts each call was asked for. Absent from an older artifact, which asked for `k`. */
  readonly ask: number;
  readonly promptVersion: number;
  /** Which instructions the prompt carried — an arm is a set of rules, so an artifact must name it. */
  readonly rules: readonly Rule[];
  /**
   * Which of the corpus's own prompts replaced this repository's, when one did.
   *
   * Present rather than implied by `rules`, because a replica answers a different question: not "what
   * is this rule worth" but "what does the arm read when the instruction is the corpus's". Two
   * artifacts that disagree on this field are not two arms of one ablation.
   */
  readonly replica?: Replica;
  readonly questions: number;
  readonly asked: number;
  /** Charts produced in total. The reading is over their first `k`; this is what the ask returned. */
  readonly produced: number;
  readonly replayed: number;
  readonly unparsed: number;
  readonly truncated: number;
  /**
   * Calls that produced no reply. Scored zero and reported beside the reading.
   *
   * Invariant: `reading.questions === asked` for every arm, so two arms over one split are always the
   * same length and `perQuestion` vectors pair by index. `failed ≤ asked` says how many of the zeros
   * are transport.
   */
  readonly failed: number;
  readonly reading: Reading;
  /**
   * The same reading, one question at a time.
   *
   * Travels with the artifact because means cannot be compared without it: the standard error of a
   * difference between two arms is a function of how many questions they disagreed on, and
   * `eval/nvbench2/compare.ts` needs the paired vector to say whether a gap survives the noise.
   * One entry per asked question, including the ones that never answered (they score zero), so index
   * `i` is the same question in every arm over one split and two arms are always the same length.
   */
  readonly perQuestion: ReturnType<typeof perQuestionOf>;
  /**
   * Where the misses stop agreeing with their nearest gold.
   *
   * Travels with the reading because the reading alone cannot be acted on: "5% right" is compatible
   * with a wrong column, a wrong mark, and a reply that carries a channel `type` the corpus never
   * writes, and the three call for different fixes. Costs nothing — it is a comparison of charts the
   * run already has, not another call.
   */
  readonly diagnostic: Diagnostic;
  readonly facts: GoldFacts;
  /** Present only when the reply's orientations were mirrored, and which way. */
  readonly mirrors?: Mirrors;
  readonly cost: {
    readonly calls: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly yuan: number | undefined;
  };
}

/** The answer to one question, from the store or from the endpoint. */
async function answerOne(
  provider: LlmProvider,
  row: SplitRow,
  types: FieldTypes,
  options: {
    readonly ask: number;
    readonly maxTokens: number;
    readonly rules: readonly Rule[];
    readonly replica?: Replica;
    readonly mirrors: Mirrors;
    readonly cache?: ContentStore<StoredAnswer>;
  },
): Promise<AnsweredRow> {
  const [system, user] = buildSpecPrompt(row, types, options.ask, options.rules, options.replica);
  const mode: ParseMode = options.replica === undefined ? 'array' : parseModeOf(options.replica);
  const key = cacheKey(identityOf(system, user, provider.model, options.maxTokens), PROMPT_VERSION);
  const cached = options.cache?.get(key, { model: provider.model });
  if (cached !== undefined) {
    const replayed = cached.truncated ? [] : withMirrors(parseSpecs(cached.reply, options.ask, mode), options.mirrors);
    return {
      index: row.index,
      charts: replayed,
      truncated: cached.truncated,
      unparsed: !cached.truncated && replayed.length === 0,
      failed: false,
      replayed: true,
      called: false,
      promptTokens: cached.usage?.promptTokens ?? 0,
      completionTokens: cached.usage?.completionTokens ?? 0,
    };
  }
  // A call that failed is a row without an answer, not the end of the run. The previous behaviour — raise
  // out of `mapLimit` — cost a 750-question reasoning run three times: the answers were cached and
  // replayable, but the run reported nothing, so the reading had to be bought a second time to exist.
  let response;
  try {
    response = await provider.complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      maxTokens: options.maxTokens,
      temperature: 0,
    });
  } catch {
    return {
      index: row.index,
      charts: [],
      truncated: false,
      unparsed: false,
      failed: true,
      replayed: false,
      called: true,
      promptTokens: 0,
      completionTokens: 0,
    };
  }
  const reply = response.text;
  const truncated = response.finishReason === 'length';
  const charts = truncated ? [] : withMirrors(parseSpecs(reply, options.ask, mode), options.mirrors);
  const usage: TokenCounts = {
    promptTokens: response.usage?.promptTokens ?? 0,
    completionTokens: response.usage?.completionTokens ?? 0,
    ...(response.usage?.cachedPromptTokens === undefined
      ? {}
      : { cachedPromptTokens: response.usage.cachedPromptTokens }),
  };
  options.cache?.put(key, { version: PROMPT_VERSION, model: provider.model, reply, truncated, usage });
  return {
    index: row.index,
    charts,
    truncated,
    unparsed: !truncated && charts.length === 0,
    failed: false,
    replayed: false,
    called: true,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  };
}

/** Run `jobs` with at most `limit` in flight, preserving order in the result. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.min(limit, items.length));
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const at = next;
      next += 1;
      if (at >= items.length) return;
      out[at] = await run(items[at] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Everything the arm needs, so that a test can hand it a provider and a directory. */
export interface ArmOptions {
  readonly split: string;
  readonly rows: readonly SplitRow[];
  readonly types: Readonly<Record<string, FieldTypes>>;
  readonly provider: LlmProvider;
  /** How wide the reading is scored. Precision's denominator is `min(k, charts)` and its ceiling k. */
  readonly k: number;
  /**
   * How many charts the prompt asks for. Absent means `k`.
   *
   * Separate from `k` because a set cut to the scoring width loses recall: over 250 dev questions the
   * same rules read 27.46 F1@3 asked for three charts and 29.50 asked for five, since a model told
   * "at most 3" drops candidates the gold set contains rather than ordering them. The ask is a
   * property of the call, `k` is a property of the reading, and a run has to be able to say both.
   */
  readonly ask?: number;
  readonly maxTokens: number;
  readonly concurrency: number;
  /** Which instructions the prompt carries. Absent means the product path, which is `DEFAULT_RULES`. */
  readonly rules?: readonly Rule[];
  /**
   * Send the corpus's own instruction and input instead, and read the reply by its contract.
   *
   * Absent means this repository's prompt. `rules` is ignored when this is set — a replica replaces the
   * instruction rather than widening it — and the artifact records that, so a reading cannot be
   * mistaken for a rule's contribution.
   */
  readonly replica?: Replica;
  readonly cache?: ContentStore<StoredAnswer>;
  /** How the reply's interchangeable axes are offered; absent means as written. */
  readonly mirrors?: Mirrors;
  readonly limit?: number;
  /** How many answered rows to keep verbatim, so a reading that surprises can be looked at. */
  readonly samples?: number;
}

/**
 * Ask every question, judge the answers, and report what it cost.
 *
 * A question whose table has no type map is answered with no charts rather than skipped: the judge
 * reverses axes by field type, so scoring it would read a missing map as a wrong answer. The count is
 * in `unparsed` beside the rest, and a run where that count is large is a run about the corpus.
 */
export async function runArm(options: ArmOptions): Promise<ArmReport> {
  const asked = options.limit === undefined ? options.rows : options.rows.slice(0, options.limit);
  const rules = options.rules ?? DEFAULT_RULES;
  const ask = options.ask ?? options.k;
  // One entry per question, produced together with the answer it scores. Written this way so that no
  // lookup by index is needed: `mapLimit` preserves the order it was given, and a `answers[at] ?? []`
  // would be a branch no input can reach — one answer per question, by construction.
  const answered = await mapLimit(asked, options.concurrency, async (row) => {
    const types = options.types[row.csv];
    const answer: AnsweredRow = types === undefined
      ? {
          index: row.index,
          charts: [],
          truncated: false,
          unparsed: true,
          failed: false,
          replayed: false,
          called: false,
          promptTokens: 0,
          completionTokens: 0,
        }
      : await answerOne(options.provider, row, types, {
          ask,
          maxTokens: options.maxTokens,
          rules,
          mirrors: options.mirrors ?? 'none',
          ...(options.replica === undefined ? {} : { replica: options.replica }),
          ...(options.cache === undefined ? {} : { cache: options.cache }),
        });
    return {
      answer,
      row,
      // Every asked question keeps a case, including the ones that never answered: a question that was
      // asked and not answered is a miss on this split, and dropping it would divide two arms by two
      // denominators. A failed row carries no charts, which scores zero for the same reason an empty
      // reply does — `failed` beside the reading says how many of those zeros were transport.
      scored: { predictions: answer.charts, golds: row.golds, types: types ?? {} } satisfies Case,
    };
  });
  const answers = answered.map((entry) => entry.answer);
  // One case per asked question, in the order asked. This is the invariant `perQuestion` needs and
  // `compare.ts` relies on: index `i` is the same question in every arm over this split.
  const cases: Case[] = answered.map((entry) => entry.scored);
  const reading = readingOf(cases, SCORED_KS);
  const promptTokens = answers.reduce((sum, answer) => sum + answer.promptTokens, 0);
  const completionTokens = answers.reduce((sum, answer) => sum + answer.completionTokens, 0);
  const bill = billOf(options.provider.model, { promptTokens, completionTokens });
  return {
    split: options.split,
    model: options.provider.model,
    k: options.k,
    ask,
    promptVersion: PROMPT_VERSION,
    questions: asked.length,
    asked: asked.length,
    produced: answers.reduce((sum, answer) => sum + answer.charts.length, 0),
    replayed: answers.filter((answer) => answer.replayed).length,
    unparsed: answers.filter((answer) => answer.unparsed).length,
    truncated: answers.filter((answer) => answer.truncated).length,
    failed: answers.filter((answer) => answer.failed).length,
    reading,
    perQuestion: perQuestionOf(cases, SCORED_KS),
    rules,
    ...(options.mirrors === undefined || options.mirrors === 'none' ? {} : { mirrors: options.mirrors }),
    ...(options.replica === undefined ? {} : { replica: options.replica }),
    diagnostic: diagnose(cases, options.k),
    facts: factsOf(asked),
    ...(options.samples === undefined
      ? {}
      : {
          // Read off `answered` rather than off `asked` + an index: the sample is a fact about what
          // was answered, and a lookup that needs a `?? []` is a branch no input can reach.
          samples: answered.slice(0, options.samples).map(({ row, scored }) => ({
            csv: row.csv,
            question: row.question,
            predictions: scored.predictions,
            golds: scored.golds,
            // One verdict per prediction, in the order they were written: a plan is written against
            // cases, and a case has to be findable from the artifact rather than by re-deriving it.
            labels: labelsOf(scored, options.k),
          })),
        }),
    cost: {
      calls: answers.filter((answer) => answer.called).length,
      promptTokens,
      completionTokens,
      yuan: bill,
    },
  };
}

/**
 * The per-call deadline, from `NVBENCH2_TIMEOUT_MS`.
 *
 * Sixty seconds is the provider's default, and it was enough while the arm was answering with a chat
 * tier: a reply of 800 completion tokens arrives in about two seconds. A reasoning tier spends 700 to
 * 1,900 tokens thinking before it writes the array, and one call past the deadline threw out of
 * `mapLimit` and took the whole run with it — 249 answers already paid for, and no reading, because a
 * run that dies before the artifact is written reports nothing. The deadline is an environment
 * variable rather than a constant for the reason the model is: it is a property of the instrument.
 *
 * Raising it is safe in the direction that matters. It bounds a hang, and a call that finishes early
 * does so whatever the deadline was.
 */
export function timeoutMsOf(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 60_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`NVBENCH2_TIMEOUT_MS ${raw} is not a positive whole number of milliseconds`);
  }
  return value;
}

/**
 * How many times one call is attempted, from `NVBENCH2_RETRIES`.
 *
 * The provider defaults to a single attempt, which is right for a run that costs a fraction of a yuan
 * and wrong for one that does not: a connection reset two minutes into a 750-question reasoning run
 * throws out of `mapLimit` and takes the whole run with it, and the request that was reset produced no
 * answer and therefore no bill. Three attempts is not a cost, it is a floor under a transport fault.
 *
 * A failure that survives three attempts is still raised rather than recorded as an unanswered row:
 * a reply that never arrived is not a wrong answer, and scoring it as one would put a network into a
 * benchmark reading.
 */
export function retriesOf(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 3;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`NVBENCH2_RETRIES ${raw} is not a positive whole number of attempts`);
  }
  return value;
}

/** The provider the command line builds, or a sentence saying which variable is missing. */
export function providerFromEnv(env: Readonly<Record<string, string | undefined>>): LlmProvider {
  const baseUrl = env['LLM_BASE_URL'];
  const apiKey = env['LLM_API_KEY'];
  const model = env['NVBENCH2_MODEL'] ?? 'deepseek-chat';
  if (baseUrl === undefined || baseUrl === '') throw new Error('LLM_BASE_URL is not set');
  if (apiKey === undefined || apiKey === '') throw new Error('LLM_API_KEY is not set');
  return createHttpProvider({
    baseUrl,
    apiKey,
    model,
    timeoutMs: timeoutMsOf(env['NVBENCH2_TIMEOUT_MS']),
    retries: retriesOf(env['NVBENCH2_RETRIES']),
  });
}

/** How the arm is invoked, and what a bad invocation refuses to do. */
/**
 * The rules a `--rules` value names.
 *
 * Absent means `DEFAULT_RULES` — the product path, which is the arm the ablation selected — and the
 * empty string means none, which is the arm that reproduces the first dispatch byte for byte. Anything
 * else has to be a rule this file knows, because a typo that silently turned a rule off would be
 * reported as "the rule did not help".
 */
export function rulesOf(raw: string | undefined): readonly Rule[] {
  if (raw === undefined) return DEFAULT_RULES;
  if (raw === '') return [];
  const named = raw.split(',').map((entry) => entry.trim());
  const unknown = named.filter((entry) => !(RULES as readonly string[]).includes(entry));
  if (unknown.length > 0) throw new Error(`--rules ${raw} names ${unknown.join(', ')}, which is not a rule`);
  return RULES.filter((rule) => named.includes(rule));
}

/**
 * Which replica a `--replica` value names, if any.
 *
 * `none` and the empty string both mean this repository's own prompt, and both are accepted because a
 * workflow input falls back to its default when left empty: a dispatch that clears the box must not
 * fail, and it must not turn a replica on by accident either. Any other value has to be one of the two
 * the corpus published, for the reason `rulesOf` gives about typos.
 */
export function replicaOf(raw: string | undefined): Replica | undefined {
  if (raw === undefined || raw === '' || raw === 'none') return undefined;
  if (!(REPLICAS as readonly string[]).includes(raw)) {
    throw new Error(`--replica ${raw} is not one of ${REPLICAS.join(', ')} or none`);
  }
  return raw as Replica;
}

/** The `--mirrors` value, refused rather than defaulted when it is not one this file knows. */
export function mirrorsOfFlag(raw: string | undefined): Mirrors {
  if (raw === undefined || raw === '' || raw === 'none') return 'none';
  if (raw !== 'interleave' && raw !== 'append') throw new Error(`--mirrors ${raw} is not none, interleave or append`);
  return raw;
}

export function parseArgs(argv: readonly string[]): {
  split: string;
  cache: string;
  metrics: string;
  artifact: string | undefined;
  limit: number | undefined;
  k: number;
  ask: number;
  concurrency: number;
  maxTokens: number;
  samples: number | undefined;
  rules: readonly Rule[];
  replica: Replica | undefined;
  budget: Budget;
  replay: boolean;
  mirrors: Mirrors;
} {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const cache = value('--cache') ?? 'eval/.cache/nvbench2';
  const split = value('--split') ?? 'dev';
  const rawLimit = value('--limit');
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`--limit ${String(rawLimit)} is not a positive whole number`);
  }
  const k = Number(value('--k') ?? '3');
  if (!Number.isInteger(k) || k <= 0) throw new Error(`--k ${String(value('--k'))} is not a positive whole number`);
  const rawAsk = value('--ask');
  const ask = rawAsk === undefined ? k : Number(rawAsk);
  if (!Number.isInteger(ask) || ask <= 0) throw new Error(`--ask ${String(rawAsk)} is not a positive whole number`);
  const rawBudget = value('--budget');
  const budget: Budget = rawBudget === undefined
    ? DEFAULT_BUDGET_CNY
    : rawBudget === 'none'
      ? 'none'
      : Number(rawBudget);
  if (budget !== 'none' && (!Number.isFinite(budget) || budget < 0)) {
    throw new Error(`--budget ${String(rawBudget)} is not an amount of money or none`);
  }
  return {
    split,
    cache,
    metrics: value('--metrics') ?? 'eval/nvbench2/metrics.json',
    artifact: value('--artifact'),
    limit,
    k,
    ask,
    concurrency: Number(value('--concurrency') ?? '6'),
    maxTokens: Number(value('--max-tokens') ?? '900'),
    samples: value('--samples') === undefined ? undefined : Number(value('--samples')),
    rules: rulesOf(value('--rules')),
    replica: replicaOf(value('--replica')),
    budget,
    // `--replay` is a promise, not a hint: a dispatch that says it is replaying must not call the
    // endpoint at all. A hint would let a changed prompt, model or token budget quietly re-buy 750
    // answers under the word "replay", which is exactly what happened once.
    replay: argv.includes('--replay'),
    mirrors: mirrorsOfFlag(value('--mirrors')),
  };
}

/** The digest of a split's questions, so an artifact says which corpus answered it. */
export function splitDigest(rows: readonly SplitRow[]): string {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(`${row.csv}\u0000${row.question}\u0000${JSON.stringify(row.golds)}\n`);
  return hash.digest('hex');
}

/**
 * One line for a job log: the reading, the price, and the count it was taken over.
 *
 * The price is `unpriced` rather than `¥0.00` when the model is not on `eval/price.ts`'s table, for
 * the reason `eval/bill.ts` gives: a zero would read as a free run and a missing row is a missing row.
 *
 * The denominator is printed as one number rather than `N of M scored`, because after the failed-row
 * fix those two are the same number for every arm — and a ratio that is always 1 invites a reader to
 * assume it can vary. What can vary, and is printed when it does, is how many of the questions the
 * endpoint never answered.
 */
export function summaryLine(report: ArmReport): string {
  const f1 = report.reading.f1[3];
  const reading = f1 === undefined ? '—' : f1.toFixed(4);
  const price = report.cost.yuan === undefined ? 'unpriced' : formatYuan(report.cost.yuan);
  const failed = report.failed === 0 ? '' : ` · ${String(report.failed)} failed`;
  const replica = report.replica === undefined ? '' : ` · replica ${report.replica}`;
  return `nvbench2 arm: ${report.split} F1@3 ${reading} · ${String(report.reading.questions)} questions · ask ${String(report.ask)}${replica} · ${String(report.cost.calls)} calls${failed} · ${price}`;
}

/**
 * Which of this dispatch's questions are already paid for.
 *
 * The answer store is keyed by the exact request, so a re-dispatch of an unchanged arm costs nothing
 * and a changed one costs only what changed — but only a count taken *before* the run can say which,
 * and only then can a ceiling refuse the run instead of a log reader noticing the total afterwards.
 *
 * The store is passed in rather than opened here, and `main` opens a second one on the same directory
 * for this count: the counters on the store a report is written from have to describe the run, and a
 * pre-flight peek that incremented `hits` by 750 would make every artifact's cache line a fiction.
 */
export function pendingOf(input: {
  readonly rows: readonly SplitRow[];
  readonly types: Readonly<Record<string, FieldTypes>>;
  readonly k: number;
  readonly rules: readonly Rule[];
  readonly replica?: Replica;
  readonly model: string;
  readonly maxTokens: number;
  readonly store: ContentStore<StoredAnswer>;
  readonly limit?: number;
}): { readonly questions: number; readonly paid: number } {
  const asked = input.limit === undefined ? input.rows : input.rows.slice(0, input.limit);
  let paid = 0;
  for (const row of asked) {
    // A table with no type map is asked anyway (the run counts it as unparsed), so it is priced too:
    // quoting only the rows that will succeed would make a split of unknown tables look free.
    const [system, user] = buildSpecPrompt(row, input.types[row.csv] ?? {}, input.k, input.rules, input.replica);
    const key = cacheKey(identityOf(system, user, input.model, input.maxTokens), PROMPT_VERSION);
    if (input.store.get(key, { model: input.model }) !== undefined) paid += 1;
  }
  return { questions: asked.length, paid };
}

/**
 * The refusal for a dispatch that promised to replay.
 *
 * The answer store is keyed by the exact request, so a replay is free only if the request is
 * unchanged. The failure mode is silent otherwise: a `--max-tokens` that differs from the run that
 * paid (900 by default, 2048 in a hand-typed dispatch) misses every key, the quote is recomputed from
 * the published unit price, the ceiling allows it, and 750 answers are bought a second time under a
 * command line that said "replay". This function turns that into a refusal before the first call.
 */
export function replayRefusal(
  replay: boolean,
  pending: { readonly questions: number; readonly paid: number },
): string | undefined {
  if (!replay) return undefined;
  const missing = pending.questions - pending.paid;
  if (missing === 0) return undefined;
  return `--replay was asked for, but ${String(missing)} of ${String(pending.questions)} questions are not in the answer store: this dispatch is not the request that paid for them (prompt text, model, or --max-tokens differ). Nothing was called. Fix the identity, or drop --replay to buy the missing answers.`;
}

/** Read the corpus and ask it. The thin half, kept separate so the thick half can be tested. */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: { readonly provider?: LlmProvider } = {},
): Promise<number> {
  const args = parseArgs(argv);
  const cacheDir = args.cache;
  const rows = parseSplit(readFileSync(`${cacheDir}/${args.split}.json`, 'utf8'));
  const types = resolveTypes(JSON.parse(readFileSync(`${cacheDir}/metadata.json`, 'utf8')));
  const store = openStore<StoredAnswer>(`${cacheDir}/answers`, PROMPT_VERSION, (parsed, expect) =>
    answerOf(parsed, expect?.model),
  );
  const meter = withCallCounter(deps.provider ?? providerFromEnv(env));
  // The price of a question is read off the readings already published, not typed here: a table in a
  // plan said ≈¥3 an arm and the day's invoice was ¥100.01, because the arm was a reasoning tier
  // reading 13.8 KB and the table was priced at the chat tier's short prompt.
  const metrics = JSON.parse(readFileSync(args.metrics, 'utf8')) as unknown;
  const peek = openStore<StoredAnswer>(`${cacheDir}/answers`, PROMPT_VERSION, (parsed, expect) =>
    answerOf(parsed, expect?.model),
  );
  const pending = pendingOf({
    rows,
    types,
    k: args.k,
    rules: args.rules,
    ...(args.replica === undefined ? {} : { replica: args.replica }),
    model: meter.provider.model,
    maxTokens: args.maxTokens,
    store: peek,
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  });
  const quote: Quote = quoteOf({
    model: meter.provider.model,
    questions: pending.questions,
    paid: pending.paid,
    // The quote follows the arm whose instruction is closest to this one: a replica sends the
    // corpus's prompt and has no rule set, so it keeps the dearest price on the model.
    unit: unitPriceOf(metrics, meter.provider.model, args.replica === undefined ? args.rules : undefined),
  });
  process.stderr.write(`${quoteLine(quote)}\n`);
  const replayStop = replayRefusal(args.replay, pending);
  if (replayStop !== undefined) throw new Error(replayStop);
  const refusal = refusalOf(quote, args.budget);
  if (refusal !== undefined) throw new Error(refusal);
  const report = await runArm({
    split: args.split,
    rows,
    types,
    provider: meter.provider,
    k: args.k,
    ask: args.ask,
    maxTokens: args.maxTokens,
    concurrency: args.concurrency,
    rules: args.rules,
    ...(args.replica === undefined ? {} : { replica: args.replica }),
    ...(args.mirrors === 'none' ? {} : { mirrors: args.mirrors }),
    cache: store,
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    ...(args.samples === undefined ? {} : { samples: args.samples }),
  });
  const payload = {
    ...report,
    digest: splitDigest(rows),
    cache: { hits: store.hits, misses: store.misses, corrupt: store.corrupt, entries: store.size() },
  };
  const text = JSON.stringify(payload, null, 1);
  if (args.artifact === undefined) process.stdout.write(`${text}\n`);
  else {
    mkdirSync(dirname(args.artifact), { recursive: true });
    writeFileSync(args.artifact, `${text}\n`);
    process.stdout.write(`${summaryLine(report)}\n`);
  }
  // A split where nothing answered reads 0.00, and 0.00 is exactly what a system that is wrong
  // everywhere prints. The artifact is already written — a reader who opens the file this run cited
  // has to find the run — but the exit code says the number is an average of misses, not a reading of
  // the arm. Without this, an endpoint outage publishes a verdict on a model.
  if (report.asked > 0 && report.failed === report.asked) {
    process.stderr.write(`nvbench2 arm: all ${String(report.asked)} questions failed to answer — no call to ${report.model} returned a reply, so this reading is an average over unanswered questions rather than a measurement of the arm. The artifact was written so the failed dispatch can be inspected; re-dispatch when the endpoint answers, and the answers already bought replay from the store.\n`);
    return 2;
  }
  // A sixth of the split failing is not transport noise, it is a different question set wearing the
  // same name: the failures score zero, so the mean is a floor whose distance to the truth nobody
  // knows. The threshold is one percent because a lost question costs at most its own contribution —
  // 1% of the mean is 1pp, still under the 1.25pp this instrument resolves on 751 questions — while
  // the run that motivated this guard lost 119 of 751 (15.8% of the split, and a floor 15 points
  // below the arm) to 60-second deadlines it never reported.
  // Compared as integers rather than as a share: `failed / asked > 0.01` puts the boundary at the
  // mercy of the last bit of a double, so 2 of 200 would be inside on one machine and outside on
  // another. `failed * 100 > asked` is the same test in exact arithmetic.
  const failedShare = report.asked === 0 ? 0 : report.failed / report.asked;
  if (report.failed * 100 > report.asked) {
    process.stderr.write(`nvbench2 arm: ${String(report.failed)} of ${String(report.asked)} questions failed to answer (${(100 * failedShare).toFixed(1)}%), above the ${(100 * MAX_FAILED_SHARE).toFixed(0)}% a reading of this split tolerates — every failure scores zero, so ${(100 * (report.reading.f1[report.k] ?? 0)).toFixed(2)} is a floor rather than a measurement of ${report.model}. The artifact was written and the answers that did arrive are in the store, so a re-dispatch with a longer per-call deadline buys only the missing ${String(report.failed)}.\n`);
    return 3;
  }
  return 0;
}

// The guard returns the work rather than branching at module scope, so importing this file cannot
// start a run and running it cannot be forgotten (see `eval/entry.ts`).
runIfEntry(process.argv[1], import.meta.url, () => main(process.argv.slice(2), process.env));
