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
import { diagnose, type Diagnostic } from './diagnose.js';
import { factsOf, type GoldFacts } from './facts.js';
import { perQuestionOf, readingOf, type Case, type Chart, type FieldTypes, type Reading } from './judge.js';

/**
 * Bumped when the instruction, the mark list or the reply format changes meaning.
 *
 * The text is hashed into the answer's key, so a changed sentence is already a miss; this number
 * covers what a hash cannot see — a reply format whose *meaning* changed while its bytes did not.
 */
export const PROMPT_VERSION = 1;

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
 */
export const RULES = ['count', 'variants', 'values', 'corpus', 'corpus2', 'steps'] as const;
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
export const DEFAULT_RULES: readonly Rule[] = ['count', 'corpus', 'corpus2', 'steps'];

/** What each rule adds to the instruction. Wrapped to keep the system message readable in a log. */
const RULE_TEXT: Readonly<Record<Rule, readonly string[]>> = {
  count: [
    'A count names no column: write {"aggregate": "count"} with no "field", because a count counts',
    'rows rather than a column of them. Name a field only for sum, mean, min and max.',
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
 * The instruction, and the table it is about.
 *
 * The two messages are separate for the reason `eval/text2vis/llm.ts` gives: the system half is
 * byte-identical across the run, so a provider's prefix cache is a discount rather than a hope. The
 * fields are listed with the type map's own word for each one, because the reference reverses axes by
 * type and a model that guesses a type produces a chart the corpus calls transposed.
 */
export function buildSpecPrompt(
  row: Pick<SplitRow, 'question'> & { readonly examples?: Readonly<Record<string, unknown>> },
  types: FieldTypes,
  k: number,
  rules: readonly Rule[] = DEFAULT_RULES,
): readonly [string, string] {
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
  const fields = Object.entries(types)
    .map(([name, kind]) => {
      if (!rules.includes('values')) return `${name} (${kind})`;
      const values = samples[name];
      const shown = Array.isArray(values) ? values.map((value) => String(value)).join(', ') : '';
      return shown.length === 0 ? `${name} (${kind})` : `${name} (${kind}): ${shown}`;
    })
    .join(', ');
  const user = [`Table columns: ${fields}`, `Question: ${row.question}`].join('\n');
  return [system, user];
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
export function parseSpecs(text: string, k: number): Chart[] {
  if (k <= 0) return [];
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
  const charts: Chart[] = [];
  for (const entry of parsed as unknown[]) {
    const chart = chartOf(entry);
    if (chart !== undefined) charts.push(chart);
  }
  return dedupe(charts).slice(0, k);
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
   * answer, which is one it can. A failed row is left out of the reading and counted, because scoring a
   * timeout as zero charts would put a network into a benchmark number.
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
  readonly questions: number;
  readonly asked: number;
  /** Charts produced in total. The reading is over their first `k`; this is what the ask returned. */
  readonly produced: number;
  readonly replayed: number;
  readonly unparsed: number;
  readonly truncated: number;
  /** Calls that produced no reply. Excluded from the reading and reported beside it. */
  readonly failed: number;
  readonly reading: Reading;
  /**
   * The same reading, one question at a time.
   *
   * Travels with the artifact because means cannot be compared without it: the standard error of a
   * difference between two arms is a function of how many questions they disagreed on, and
   * `eval/nvbench2/compare.ts` needs the paired vector to say whether a gap survives the noise.
   * Aligned with the counted questions, so index `i` is the same question in two arms over one split.
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
    readonly cache?: ContentStore<StoredAnswer>;
  },
): Promise<AnsweredRow> {
  const [system, user] = buildSpecPrompt(row, types, options.ask, options.rules);
  const key = cacheKey(identityOf(system, user, provider.model, options.maxTokens), PROMPT_VERSION);
  const cached = options.cache?.get(key, { model: provider.model });
  if (cached !== undefined) {
    return {
      index: row.index,
      charts: cached.truncated ? [] : parseSpecs(cached.reply, options.ask),
      truncated: cached.truncated,
      unparsed: !cached.truncated && parseSpecs(cached.reply, options.ask).length === 0,
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
  const charts = truncated ? [] : parseSpecs(reply, options.ask);
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
  readonly cache?: ContentStore<StoredAnswer>;
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
          ...(options.cache === undefined ? {} : { cache: options.cache }),
        });
    return {
      answer,
      row,
      // A failed row scores nothing because it answered nothing: its case is dropped below rather than
      // handed to the judge as an empty prediction.
      scored: { predictions: answer.charts, golds: row.golds, types: types ?? {} } satisfies Case,
    };
  });
  const answers = answered.map((entry) => entry.answer);
  const cases: Case[] = answered.filter((entry) => !entry.answer.failed).map((entry) => entry.scored);
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

export function parseArgs(argv: readonly string[]): {
  split: string;
  cache: string;
  artifact: string | undefined;
  limit: number | undefined;
  k: number;
  ask: number;
  concurrency: number;
  maxTokens: number;
  samples: number | undefined;
  rules: readonly Rule[];
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
  return {
    split,
    cache,
    artifact: value('--artifact'),
    limit,
    k,
    ask,
    concurrency: Number(value('--concurrency') ?? '6'),
    maxTokens: Number(value('--max-tokens') ?? '900'),
    samples: value('--samples') === undefined ? undefined : Number(value('--samples')),
    rules: rulesOf(value('--rules')),
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
 */
export function summaryLine(report: ArmReport): string {
  const f1 = report.reading.f1[3];
  const reading = f1 === undefined ? '—' : f1.toFixed(4);
  const price = report.cost.yuan === undefined ? 'unpriced' : formatYuan(report.cost.yuan);
  const failed = report.failed === 0 ? '' : ` · ${String(report.failed)} failed`;
  return `nvbench2 arm: ${report.split} F1@3 ${reading} · ${String(report.reading.questions)} of ${String(report.asked)} scored · ask ${String(report.ask)} · ${String(report.cost.calls)} calls${failed} · ${price}`;
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
  return 0;
}

// The guard returns the work rather than branching at module scope, so importing this file cannot
// start a run and running it cannot be forgotten (see `eval/entry.ts`).
runIfEntry(process.argv[1], import.meta.url, () => main(process.argv.slice(2), process.env));
