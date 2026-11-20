import { CONTRACT_VERSION, Nl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { ChartIR, ChartType, Encoding, FieldRef, Theme } from '@agentix-e/nl2charts-spec';
import type { Distribution } from './histogram.js';
import { pooledDistribution } from './histogram.js';
import type { WideTable } from './melt.js';
import { meltWide } from './melt.js';
import type { FieldProfile } from './profile.js';
import { profileRows } from './profile.js';

/**
 * Choosing a chart is a decision the caller can audit, not a score to trust.
 *
 * Two facts decide it, and both are counted rather than weighted: what the result
 * set can encode (a scatter needs two measures, a pie needs one category small
 * enough to name), and what the question asked for (`trend`, `share`, `distribution`).
 * A recommendation carries the facts that produced it, so a caller that disagrees
 * can point at the fact rather than at a 0.83.
 *
 * The layer exists because `enumerateCandidates` can only suggest five marks from a
 * profile alone — bar, line, pie, scatter, heatmap — so seventeen of the contract's
 * twenty-two series types could never be *chosen*, only hand-specified. A model is
 * not needed to widen that: the preconditions of a boxplot or a candlestick are
 * visible in the column types, and the question usually names the shape it wants.
 */

/**
 * The kinds a cue can be. The vocabulary is the product's, and two members of it are not emitted by
 * `CHART_CUES`: the two `share` discriminator widths that the corpus in `eval/text2vis` prices
 * before the shipped table changes — `share-by-any` and `share-ranked`. They are in the union so a
 * variant is written against the same type as the table it re-orders rather than against a cast, and
 * so a cue that ships later does not have to widen a type the readings already use.
 *
 * `histogram` used to be a third such member, and the reading that shipped it is the reason this
 * comment is shorter: `familiesOfMark` has said since it was written that a bar covers a histogram,
 * but only when a cue that *names* the intent put the bar there — and no cue did. So the widening was
 * unreachable, a histogram question was answered `boxplot` by the `distribution` cue, and 73 corpus
 * rows sat in `uncovered` where the product had answered but could not say what. Shipping the cue
 * moved 24 of them into the shortlist without moving a single hit, which is the whole distinction the
 * census's `shortlist` column exists to make.
 */
export type CueKind =
  | 'trend'
  | 'share'
  | 'share-by'
  | 'share-by-any'
  | 'share-ranked'
  | 'distribution'
  | 'histogram'
  | 'correlation'
  | 'ranking'
  | 'matrix'
  | 'progress'
  | 'stages'
  | 'multi-metric'
  | 'profile'
  | 'volatility'
  | 'explicit';

export interface CueRule {
  readonly kind: CueKind;
  /** Marks this cue speaks for, strongest first. The first one earns more. */
  readonly marks: readonly ChartType[];
  readonly pattern: RegExp;
}

/**
 * A cue is a phrase, not a keyword list. `top` and `bottom` earn the same cue
 * because they ask for the same picture; `open` earns the candlestick cue only in
 * the phrase that names a price series, which is why `volatility` matches
 * `open and close` rather than `open` on its own.
 *
 * The Chinese entries are here because the question is not always English: a
 * product that answers only English questions has a speaking defect, and a cue
 * table is the cheapest place to fix one.
 */
/**
 * The mark a question names outright, which is not a suggestion but a request.
 *
 * The corpus made this rule unavoidable: `plot these percentages in order of increasing 'Value' on a
 * line chart` is a Text2Vis question, and the shipped table had nothing that read "line chart", so a
 * reader who stated the answer they wanted was given a bar instead — 350 rows of that corpus, plus
 * every user who ever typed "draw me a pie chart".
 *
 * The pattern requires the mark word beside `chart`, `plot`, `graph` or `diagram`, which is what
 * keeps it from firing on the instruction boilerplate those same prompts carry ("generate matplotlib
 * code", "include axis labels"). It is listed first so that a named mark leads the cue list.
 */
const EXPLICIT: readonly CueRule[] = [
  {
    kind: 'explicit',
    marks: ['line'],
    pattern: /\bline (?:chart|plot|graph|diagram)\b/,
  },
  {
    kind: 'explicit',
    marks: ['line'],
    pattern: /\barea (?:chart|plot|graph|diagram)\b/,
  },
  {
    kind: 'explicit',
    marks: ['bar'],
    pattern: /\b(?:bar|column) (?:chart|plot|graph|diagram)\b/,
  },
  {
    kind: 'explicit',
    marks: ['pie'],
    pattern: /\b(?:pie|donut|doughnut) (?:chart|plot|graph|diagram)?\b/,
  },
  {
    kind: 'explicit',
    marks: ['scatter'],
    pattern: /\b(?:scatter|bubble) (?:plot|chart|graph|diagram)\b/,
  },
  {
    kind: 'explicit',
    marks: ['boxplot'],
    pattern: /\bbox ?plot\b|\bbox ?and ?whisker\b/,
  },
  {
    kind: 'explicit',
    marks: ['heatmap'],
    pattern: /\bheat ?map\b/,
  },
  {
    kind: 'explicit',
    marks: ['radar'],
    pattern: /\bradar (?:chart|plot|graph|diagram)?\b|\bspider (?:chart|plot)\b/,
  },
  {
    kind: 'explicit',
    marks: ['funnel'],
    pattern: /\bfunnel (?:chart|plot|diagram)?\b/,
  },
  {
    kind: 'explicit',
    marks: ['gauge'],
    pattern: /\bgauge (?:chart|plot|diagram)?\b/,
  },
  {
    kind: 'explicit',
    marks: ['candlestick'],
    pattern: /\bcandlestick (?:chart|plot)?\b/,
  },
  {
    kind: 'explicit',
    marks: ['parallel'],
    pattern: /\bparallel coordinates\b/,
  },
];

export const CHART_CUES: readonly CueRule[] = [
  ...EXPLICIT,
  {
    kind: 'trend',
    marks: ['line', 'bar'],
    pattern: /\b(?:trend|trending|over time|growth|time series|monthly|yearly|quarterly|weekly|by month|by year|by quarter|by week)\b|趋势|每月|按月|按年/,
  },
  {
    /**
     * A share word followed immediately by the dimension it splits on: a comparison, not a part.
     *
     * "The share of revenue that is refunds" is a part of a whole and the corpus drew a pie; "share by
     * status" is categories compared and it drew a bar. Listed ahead of `share` because the first mark
     * of the first fired cue leads — `share` keeps its marks untouched, so a question this does not
     * match is answered exactly as before. Priced before it shipped at 10 bar rows won, 5 pie rows
     * lost, and +3 on the product.
     */
    kind: 'share-by',
    marks: ['bar'],
    pattern: /\b(?:share|proportion|percentage|percent|composition|breakdown|split)\s+(?:by|across|per)\b/,
  },
  {
    kind: 'share',
    marks: ['pie', 'bar'],
    pattern: /\b(?:share|proportion|percentage|percent|composition|breakdown|split|makeup)\b|占比|比例|构成/,
  },
  {
    /**
     * The binned measure, named. Ahead of `distribution` because the leading mark is the first mark
     * of the first fired cue; narrow, because `distribution` keeps its own alternative and a question
     * this does not match is answered exactly as before. Priced before it shipped: 24 corpus rows
     * left `uncovered` for the shortlist and no hit moved.
     */
    kind: 'histogram',
    marks: ['bar'],
    pattern: /\bhistograms?\b|\bfrequency (?:distribution|counts?)\b|\bbinned\b/,
  },
  {
    kind: 'distribution',
    marks: ['boxplot', 'bar'],
    pattern: /\b(?:distribution|spread|dispersion|quartiles?|median|variability|histogram|box ?plot)\b|分布/,
  },
  {
    kind: 'correlation',
    marks: ['scatter', 'heatmap'],
    pattern: /\b(?:correlat\w*|relationship|related|versus|vs\.?|against each other)\b|相关/,
  },
  {
    kind: 'ranking',
    marks: ['bar'],
    pattern: /\b(?:top|bottom|rank\w*|highest|lowest|largest|smallest|best|worst)\b|排名|最高|最低/,
  },
  {
    /**
     * A crossing: two dimensions named inside one clause.
     *
     * It was `\bby\b[\s\S]*\band\b`, which spans the whole question, so "average revenue by region.
     * Generate matplotlib code and label the axes" was a heatmap question. That cue decided 223
     * corpus questions and was right about one; the bound is the same two words with a limit on the
     * distance between them. Bounded rather than reordered: reversing the marks scores +66 on the
     * question half and −34 on the product, and the bound is worth +43 there.
     */
    kind: 'matrix',
    marks: ['heatmap', 'bar'],
    pattern: /\bby\b[^.;?!\n]{0,60}\band\b|交叉|矩阵/,
  },
  {
    kind: 'progress',
    marks: ['gauge', 'bar'],
    pattern: /\b(?:against target|vs\.? target|versus target|target|goal|progress|kpi|completion rate|attainment)\b|目标|完成率/,
  },
  {
    kind: 'stages',
    marks: ['funnel', 'bar'],
    pattern: /\b(?:funnel|stages?|drop-?off|conversion rate|pipeline)\b|漏斗|阶段/,
  },
  {
    kind: 'multi-metric',
    marks: ['parallel', 'radar'],
    pattern: /\b(?:in parallel|several metrics|multiple metrics|parallel coordinates)\b|多维|平行/,
  },
  {
    kind: 'profile',
    marks: ['radar', 'parallel'],
    pattern: /\b(?:radar|profile|spider)\b|雷达/,
  },
  {
    kind: 'volatility',
    marks: ['candlestick', 'line'],
    pattern: /\b(?:open and close|ohlc|candlestick|high and low|price range)\b|开收盘|K线/,
  },
];

export interface Cue {
  readonly kind: CueKind;
  readonly marks: readonly ChartType[];
  /** The text that fired, lowercased, so the choice can be quoted back. */
  readonly phrase: string;
}

/**
 * Every cue the question fires, in table order, one entry per rule.
 *
 * `table` defaults to the shipped `CHART_CUES` and exists for the reading in `eval/text2vis`, which
 * has to price an alternative ordering against the corpus before anyone changes the shipped one.
 * A second exported table would be a second opinion about which cues exist; a parameter is the same
 * table under a different order, and the only thing a variant may change is the order and the
 * membership of `marks` — never the patterns, because a variant that also rewrote the phrases would
 * be measuring a different cue table rather than the same one re-ordered.
 */
export function readCues(question: string, table: readonly CueRule[] = CHART_CUES): Cue[] {
  const text = question.toLowerCase();
  // `exec` on a shared RegExp object advances `lastIndex` when the pattern is global; none of the
  // shipped patterns is, and a variant supplied with one would silently skip every other question.
  // Resetting per call makes the function total over the tables it accepts.
  const cues: Cue[] = [];
  for (const rule of table) {
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(text);
    if (match !== null) cues.push({ kind: rule.kind, marks: rule.marks, phrase: match[0] });
  }
  return cues;
}

/** The marks this layer will choose between. Every one is a mark a flat result set can witness. */
export type RecommendableMark =
  | 'bar'
  | 'line'
  | 'pie'
  | 'funnel'
  | 'scatter'
  | 'heatmap'
  | 'boxplot'
  | 'candlestick'
  | 'radar'
  | 'parallel'
  | 'gauge';

export interface Recommendation {
  readonly mark: RecommendableMark;
  /**
   * Counted points: a structural prior, a shape bonus, and three or two per cue that names the mark.
   *
   * The second key of the order, not the first: it breaks a tie between marks that an equal number
   * of cues name *first*. Reading it as the whole ranking is a misreading the contract does not
   * allow — see `recommendChart`.
   */
  readonly score: number;
  readonly cues: readonly CueKind[];
  readonly reasons: readonly string[];
}

export interface Refusal {
  readonly mark: RecommendableMark;
  /** Why the result set cannot carry this mark, in words a caller can act on. */
  readonly reason: string;
}

/**
 * What the result set can carry, counted.
 *
 * The three numbers every admission rule reads, reported beside the ranking for the same reason the
 * score is: a refusal a caller cannot explain is a refusal a caller cannot act on, and "a line needs
 * an ordered axis and a measure" is only actionable once the reader knows how many ordered columns
 * the table had. `eval/text2vis` counts refusals by this shape rather than re-deriving it, so the
 * two cannot disagree about what a table could carry.
 */
export interface ShapeCounts {
  /** Columns that are not measures: the axes a mark can group by. */
  readonly dims: number;
  /** The dims a line can order along: temporal and ordinal, never nominal. */
  readonly ordered: number;
  /** Measures the result set carries, including the counted one. */
  readonly measures: number;
  /** True when the only measure is the row count, materialised by `toChartIR` rather than read. */
  readonly counted: boolean;
}

/**
 * The fewest observations a five-number summary is read from, and the number is a property of the
 * summary: with `n` values interpolated, each quarter of the box is anchored by an observation of its
 * own exactly when `n` is at least four. Below that the box's shape is the interpolation rule's, not
 * the data's. The corpus prices the nearby floors on the 164 rows that named a boxplot their table
 * was said not to hold — two moves 43, three 42, four 39, five 38 — so four is the largest floor that
 * keeps a quarter per observation for four rows of reach.
 */
const MIN_OBSERVATIONS = 4;

export interface ChartChoice {
  readonly question: string;
  /**
   * Admissible marks, best first.
   *
   * Ordered by cues naming the mark first, then by `score`, then by the fixed preference order — the
   * three keys `recommendChart` documents. Empty when no mark can encode the result set.
   */
  readonly recommendations: readonly Recommendation[];  /** Every considered mark that was ruled out, so the audit trail is complete. */
  readonly refused: readonly Refusal[];
  /** The counts those rules were applied to. */
  readonly shape: ShapeCounts;
}

/**
 * How many slices a pie may carry before this layer stops calling it a pie.
 *
 * Twelve, and the number is a reading rather than a preference. Seven was the shipped cap and it was
 * never measured against anything; the corpus in `eval/text2vis` prices the cap at 7, 8, 9, 10, 12 and
 * unbounded on the same 1,470 rows, and the curve is not monotone: a cap of eight or nine reads *three
 * rows lower* than seven, because it admits the pies the corpus drew as bars at eight and nine
 * categories while still refusing the ones it drew as pies at ten and twelve. Twelve is the first
 * value where the pie claim the cue table makes is no longer overruled by a constant — 14 rows gained,
 * 10 rows lost, and both halves of the corpus move up.
 *
 * Exported to this package and not from it: a caller who wants a different cap passes
 * `RecommendOptions.maxSlices`, and a second public name for the default would be a second place to
 * read it from.
 */
export const DEFAULT_MAX_SLICES = 12;

export interface RecommendOptions {
  /** Slices a pie or a funnel may carry before it stops being readable. Defaults to twelve. */
  readonly maxSlices?: number;
  /**
   * The cue table to read the question against. Defaults to the shipped `CHART_CUES`.
   *
   * It exists for exactly one caller: the reading in `eval/text2vis`, which has to price a candidate
   * table on the *product* path before it ships. Without it the only table the product could be
   * measured on was the one already compiled in, so "does this cue change help the product" was a
   * question no run could answer — every cue decision rested on the cue-only reading, which never
   * sees an admission rule and therefore cannot see the difference between a mark the question named
   * and a mark the result set refused.
   *
   * A parameter rather than a second exported table, for the reason `readCues` gives: a second table
   * would be a second answer to which cues exist, and this is the same table under a different order.
   */
  readonly cues?: readonly CueRule[];
  /**
   * How many rows the profiles were taken from, when the caller knows.
   *
   * It decides whether a table with no measure column has the counted one, which is a comparison
   * between a distinct count and a row count — and a `FieldProfile` holds only the first. Omitted
   * means "do not count": a recommender given profiles alone cannot tell twelve countries from twelve
   * thousand sales. `toChartIR` always passes it, because it is the function that folds the rows.
   */
  readonly rows?: number;
}

interface Resolved {
  readonly maxSlices: number;
  readonly rows: number | undefined;
}

interface Shape {
  readonly dims: readonly FieldProfile[];
  readonly ordered: readonly FieldProfile[];
  /**
   * The one axis column whose values are all different, when the caller stated the row count: a table
   * that spells its order `Day 1 … Day 7` states a sequence without stating a date, which is what a
   * candlestick reads. A repeated label describes two interleaved series, so it is not one.
   */
  readonly sequence: FieldProfile | undefined;
  readonly measures: readonly FieldProfile[];
  /** The widest category still small enough to be named in a pie. */
  readonly sliceable: FieldProfile | undefined;
  /** True when `measures` holds the synthesised row count instead of a column of the result set. */
  readonly counted: boolean;
  /**
   * How many rows the table has, when the caller said.
   *
   * The one count a distribution can be read off, and the one a profile cannot hold: twelve countries
   * and twelve thousand sales profile the same. `undefined` means "not stated", which is why the
   * derived boxplot is refused for a caller that passed profiles alone rather than fabricated.
   */
  readonly observations: number | undefined;
}

interface Admission {
  readonly mark: RecommendableMark;
  readonly prior: number;
  readonly reason: string;
  /** Null when the data fits; otherwise the sentence explaining what is missing. */
  readonly admit: (shape: Shape, options: Resolved) => string | null;
  /**
   * A fact about the shape that makes this mark the better fit, paid at a cue's rate.
   *
   * `prior` says a mark *can* encode the shape, and two marks that can both encode it score the same
   * and fall to the preference order — which is a statement about the order of `RECOMMENDABLE_MARKS`,
   * not about the result set. Bar and line are exactly that pair: both need an axis and a measure,
   * both score two, and `bar` is first in the list, so **every** question that named neither mark and
   * had a time axis was answered with a bar. On Text2Vis that is 164 rows labelled `Line` where the
   * product answered `bar`, and the 47 of them that fired no cue at all are the pure form of it: a
   * coin flip dressed as a decision.
   *
   * What separates the pair is one property of the data, and it is not a weight: a bar over months and
   * a line over months carry the same numbers, and the line states the interval between them. When the
   * axis is a time axis the interval is in the result set, so the line is the mark that does not
   * discard it.
   *
   * **Paid in the score, never in the primary key**, because the two keys answer different questions.
   * The primary key asks what the question *asked for*, and only a phrase asks; the axis does not ask
   * for a line, it merely fits one best. So the bonus is worth what a phrase that names the mark is
   * worth — three — and loses to any mark a phrase names outright: a table of daily open and close
   * prices has a time axis and is still a candlestick, because `volatility` asks for one.
   *
   * Narrow by dimension rather than by measure: the bonus is paid when the time axis is *the* axis. A
   * table of region, month and revenue has an interval in it and has a grouping too, so the marks that
   * read two categories are admissible there and the product's own evidence — `matrix` names the
   * heatmap first — is about that table. It is not paid on an ordinal axis either: an ordered list of
   * stages is a ranking, and a ranking over stages is the funnel or the bar, not a trend.
   */
  readonly bonus?: { readonly reason: string; readonly when: (shape: Shape) => boolean };
}

/**
 * How a boxplot reads this table, or `undefined` when it cannot.
 *
 * Two shapes carry a distribution: **`tuple`** states five numbers per row (`min, q1, median, q3,
 * max`), which is what a pre-aggregated export looks like; **`derived`** states *observations*, one
 * measure with one row each, and the five numbers are folded out of them, one box per measure.
 *
 * One function because three readers ask the same question — the admission, `encodingFor` and
 * `toChartIR` — and three restatements of "does this table carry a distribution" would agree until
 * one of them changed. It returns the measures too: the fold needs exactly the columns this called
 * summarisable, and a five-number summary of two numbers is a line segment. A counted measure is
 * refused outright, because it is materialised *after* the fold, one number per group.
 */
function boxplotReading(shape: Shape): { readonly layout: 'tuple' | 'derived'; readonly measures: readonly FieldProfile[] } | undefined {
  if (shape.measures.length >= 5) return { layout: 'tuple', measures: shape.measures.slice(0, 5) };
  if (shape.counted) return undefined;
  if ((shape.observations ?? 0) < MIN_OBSERVATIONS) return undefined;
  const measures = shape.measures.filter((profile) => profile.numbers >= MIN_OBSERVATIONS);
  if (measures.length === 0) return undefined;
  return { layout: 'derived', measures };
}

/**
 * The sentence that says which condition a refused boxplot is missing, built from the same facts
 * `boxplotReading` reads: "five numbers per row" was true of a table with one measure over ten rows,
 * and the reader could not tell which half of the sentence their table failed.
 */
function boxplotRefusal(shape: Shape): string {
  const fullest = shape.measures.reduce((most, profile) => Math.max(most, profile.numbers), 0);
  const rows = shape.observations === undefined ? 'an unstated number of' : String(shape.observations);
  // Three counts in one sentence rather than a sentence per case: the reader's table failed one of
  // them, and naming all three says which without the writer having to guess. A counted measure
  // needs no case of its own — it holds 0 numbers by construction, because the column it will fill
  // is one value per group rather than one per row — so the same sentence is true of it.
  return `a boxplot reads five numbers per row, or one measure over at least ${String(MIN_OBSERVATIONS)} rows; this result has ${String(shape.measures.length)} measures over ${rows} rows, the fullest holding ${String(fullest)} numbers`;
}

const ADMISSIONS: readonly Admission[] = [
  {
    mark: 'bar',
    prior: 2,
    reason: 'profile:category-axis-and-measure',
    admit: (shape) => (shape.dims.length >= 1 && shape.measures.length >= 1 ? null : 'a bar needs a category axis and a measure'),
  },
  {
    mark: 'line',
    prior: 2,
    bonus: { reason: 'profile:time-axis', when: (shape) => shape.dims.length === 1 && shape.dims.some((dim) => dim.type === 'temporal') },
    // A line needs an axis to run along and a measure to draw; whether that axis carries its own
    // order is a property of how the line is *drawn*, not of whether it can be. Text2Vis labels 350
    // rows a line or an area over a category axis — `plot these percentages in order of increasing
    // Value ... on a line chart` is one of its questions verbatim — and the ordered form is the
    // categories sorted by the measure, which `encodingFor` can order. Refusing them was this
    // layer stating a rule about reading order where the corpus states a fact about the data.
    reason: 'profile:axis-and-measure',
    admit: (shape) =>
      shape.dims.length >= 1 && shape.measures.length >= 1 ? null : 'a line needs an axis and a measure',
  },
  {
    mark: 'pie',
    prior: 2,
    reason: 'profile:one-named-category-and-a-measure',
    admit: (shape, options) =>
      shape.sliceable !== undefined && shape.measures.length >= 1 && !shape.measures.some((field) => field.negative)
        ? null
        : `a pie needs one category of at most ${String(options.maxSlices)} slices, none of them negative`,
  },
  {
    mark: 'funnel',
    prior: 2,
    reason: 'profile:ordered-stages-and-a-measure',
    admit: (shape, options) =>
      shape.sliceable !== undefined && shape.measures.length >= 1 && !shape.measures.some((field) => field.negative)
        ? null
        : `a funnel needs one category of at most ${String(options.maxSlices)} stages, none of them negative`,
  },
  {
    mark: 'scatter',
    prior: 2,
    reason: 'profile:two-measures',
    admit: (shape) => (shape.measures.length >= 2 ? null : 'a scatter needs two measures'),
  },
  {
    mark: 'heatmap',
    prior: 2,
    reason: 'profile:two-category-axes-and-a-measure',
    admit: (shape) =>
      shape.dims.length >= 2 && shape.measures.length >= 1 ? null : 'a heatmap needs two category axes and a measure',
  },
  {
    mark: 'boxplot',
    // Two, like a bar. A table that states its distribution in *rows* is also a table a bar reads one
    // row at a time and discards nothing to do it, so only a question that asks for a distribution
    // argues for folding four rows into one box — and a question is what a cue is. A table that
    // states it in *columns* is the opposite case: a bar there draws one of its five numbers and
    // drops four, so that layout pays the bonus and outranks the bar unasked.
    prior: 2,
    reason: 'profile:five-numbers-per-row',
    bonus: {
      reason: 'profile:five-number-columns',
      when: (shape) => boxplotReading(shape)?.layout === 'tuple',
    },
    admit: (shape) => (boxplotReading(shape) === undefined ? boxplotRefusal(shape) : null),
  },
  {
    mark: 'candlestick',
    prior: 3,
    reason: 'profile:four-numbers-per-row-on-an-ordered-axis',
    // An axis that orders the rows: a date is one spelling of it, a label per row is another. The
    // corpus's three refusals here were all a week written `Day 1 … Day 7`.
    admit: (shape) =>
      shape.measures.length >= 4 && (shape.ordered.length >= 1 || shape.sequence !== undefined)
        ? null
        : shape.measures.length < 4
          ? `a candlestick reads four numbers per row and this result has ${String(shape.measures.length)}`
          : `a candlestick reads four numbers per row on an axis that orders them, and this result has neither a date column nor a label column with one value per row`,
  },
  {
    mark: 'radar',
    prior: 1,
    reason: 'profile:three-measures-per-named-row',
    admit: (shape) =>
      shape.measures.length >= 3 && shape.dims.length >= 1 ? null : 'a radar needs three measures and a named row',
  },
  {
    mark: 'parallel',
    prior: 1,
    reason: 'profile:three-measures-per-row',
    admit: (shape) =>
      shape.measures.length >= 3 && shape.dims.length >= 1 ? null : 'a parallel needs three measures and a named row',
  },
  {
    mark: 'gauge',
    prior: 3,
    reason: 'profile:single-measure',
    admit: (shape) =>
      shape.measures.length === 1 && shape.dims.length === 0 ? null : 'a gauge needs exactly one measure and no category axis',
  },
];

/**
 * Every mark this layer can recommend, in the order that decides ties.
 *
 * One list rather than two: the set of marks and the tie-break between them are the same fact, and a
 * second list of "the marks we consider" would be a second answer to it. Exported because a reading
 * that counts *why* a mark was refused has to iterate the same set the recommender does — a mark
 * added here without being added there would fall out of every count and read as a smaller corpus.
 */
export const RECOMMENDABLE_MARKS: readonly RecommendableMark[] = [
  'bar',
  'line',
  'scatter',
  'heatmap',
  'pie',
  'funnel',
  'boxplot',
  'candlestick',
  'radar',
  'parallel',
  'gauge',
];

/** Order that decides ties, so two marks that fit equally well always rank the same way. */
const PREFERENCE: readonly RecommendableMark[] = RECOMMENDABLE_MARKS;

/** The column `toChartIR` materialises a count into. */
const COUNT_FIELD = 'count';

/** The column a derived boxplot names its boxes by. */
const LABEL_FIELD = 'measure';

/**
 * A name no column of the result set holds, nearest to the one asked for.
 *
 * A materialised column is only useful if it is the chart's: a query that counted something returns
 * a column called `count`, and folding onto that name would replace the numbers the chart is about.
 * The same is true of the label a derived boxplot writes — a table with its own `measure` column
 * keeps it, and the summary names its boxes `measure_2`.
 */
function freeName(profiles: readonly FieldProfile[], wanted: string): string {
  return freeOf(profiles.map((profile) => profile.name), wanted);
}

/** The same rule for a caller that has the column names rather than their profiles. */
function freeOf(taken: Iterable<string>, wanted: string): string {
  const used = new Set(taken);
  if (!used.has(wanted)) return wanted;
  let suffix = 2;
  while (used.has(`${wanted}_${String(suffix)}`)) suffix += 1;
  return `${wanted}_${String(suffix)}`;
}

function countName(profiles: readonly FieldProfile[]): string {
  return freeName(profiles, COUNT_FIELD);
}

/**
 * The measure a result set without one always has: its own rows. Two conditions keep it honest — a
 * row count from the caller, and one dim that repeats, since a count over unique values is a row of
 * equal bars. `toChartIR` folds the rows; no compiler learns an aggregate.
 */
function countMeasure(
  dims: readonly FieldProfile[],
  profiles: readonly FieldProfile[],
  rows: number | undefined,
): FieldProfile | undefined {
  if (rows === undefined) return undefined;
  if (!dims.some((profile) => profile.distinct >= 2 && profile.distinct < rows)) return undefined;
  // A count's range is unknown until the rows are folded, and the only reader of a measure's range is
  // `widest`, which has one candidate here. The bounds are the widest a count could be.
  // `numbers: 0` is the fact that keeps a count out of a five-number summary: the column does not
  // exist yet, and the values it will hold are one per group rather than one per row.
  return { name: countName(profiles), type: 'quantitative', distinct: 1, nulls: 0, numbers: 0, min: 1, max: rows, negative: false };
}

function shapeOf(profiles: readonly FieldProfile[], options: Resolved): Shape {
  // A column every cell of which is null holds no values, so it is neither a dimension nor a
  // measure: choosing it as the category axis draws bars against `[None, None, None]`, which is a
  // chart whose shape says nothing and whose mark is still the right one. Five of the corpus's 1,464
  // tables did exactly that, and no label-based score could see it.
  const real = profiles.filter((profile) => profile.distinct > 0);
  const dims = real.filter((profile) => profile.type !== 'quantitative');
  const ordered = dims.filter((profile) => profile.type === 'temporal' || profile.type === 'ordinal');
  const measures = real.filter((profile) => profile.type === 'quantitative');
  // One label per row, and only one axis: a table with two dimensions states a grid, not a sequence,
  // and reading its row order as a timeline would splice several series into one line of candles.
  const sequence =
    dims.length === 1 && options.rows !== undefined && dims[0]?.nulls === 0 && dims[0].distinct === options.rows
      ? dims[0]
      : undefined;
  const sliceable = dims
    .filter((profile) => profile.distinct <= options.maxSlices && profile.distinct >= 2)
    .sort((left, right) => right.distinct - left.distinct || left.name.localeCompare(right.name))[0];
  if (measures.length > 0) return { dims, ordered, sequence, measures, sliceable, counted: false, observations: options.rows };
  const count = countMeasure(dims, real, options.rows);
  if (count === undefined) return { dims, ordered, sequence, measures, sliceable, counted: false, observations: options.rows };
  return { dims, ordered, sequence, measures: [count], sliceable, counted: true, observations: options.rows };
}

/**
 * How many cues name a mark first.
 *
 * The primary key of the ranking, and a count rather than a weight. A cue that fires states a
 * preference between the marks it speaks for, and the first one is what the phrase is *about*:
 * `share` is a pie question a bar can answer, `matrix` is a heatmap question a bar can answer. Bar is
 * the second mark of seven of the twelve shipped cues, so on a prompt carrying three cue phrases it
 * collects six points without being named — and outranks a mark the question named outright. The
 * corpus states the row: `line 5 [trend] < bar 6 [trend matrix]`.
 *
 * No weight can state this. Any value large enough to make one first claim beat three second places
 * would be a tuned number that the next corpus measurement could move; a lexicographic key says
 * "being named outranks being collected" exactly, and it is read off the same cue table the points
 * are.
 */
function firstClaims(cues: readonly Cue[], mark: RecommendableMark): number {
  return cues.filter((cue) => cue.marks[0] === mark).length;
}

/**
 * Rank the marks that can encode this result set, given the question.
 *
 * Three keys, in order: **how many cues name the mark first**, then the counted score, then the fixed
 * preference order. The first key is what keeps a mark the question asked for from losing to a mark
 * that only ever arrives second; the second keeps "named once and named by three points' worth of
 * cue" apart from "named once as a fallback", and it is where a fact about the shape is priced; the
 * third makes two marks that fit equally well rank the same way on every run — and it is the third
 * key, which is a statement about the order of a list, that used to decide between bar and line.
 *
 * The score is counted in points a reader can reproduce from the reasons: three for the first mark a
 * cue names, two for the rest, plus the structural prior, plus `Admission.bonus`. Nothing is normalised,
 * so `score: 5` means "this result set fits the mark and one cue named it", and a caller can
 * recompute it from the facts reported alongside.
 */
export function recommendChart(
  question: string,
  profiles: readonly FieldProfile[],
  options: RecommendOptions = {},
): ChartChoice {
  const resolved: Resolved = { maxSlices: options.maxSlices ?? DEFAULT_MAX_SLICES, rows: options.rows };
  const shape = shapeOf(profiles, resolved);
  const cues = readCues(question, options.cues);
  const recommendations: Recommendation[] = [];
  const refused: Refusal[] = [];

  for (const admission of ADMISSIONS) {
    const refusal = admission.admit(shape, resolved);
    if (refusal !== null) {
      refused.push({ mark: admission.mark, reason: refusal });
      continue;
    }
    const named = cues.filter((cue) => cue.marks.includes(admission.mark));
    const reasons = [admission.reason];
    let score = admission.prior;
    // The shape's own contribution, paid before the cues so a reader can see the two apart: a fact
    // about the result set is not a phrase from the question, and only the second can ask for a mark.
    if (admission.bonus?.when(shape) === true) {
      score += 3;
      reasons.push(admission.bonus.reason);
    }
    for (const cue of named) {
      score += cue.marks.indexOf(admission.mark) === 0 ? 3 : 2;
      reasons.push(`cue:${cue.kind} "${cue.phrase}"`);
    }
    recommendations.push({ mark: admission.mark, score, cues: named.map((cue) => cue.kind), reasons });
  }

  recommendations.sort(
    (left, right) =>
      firstClaims(cues, right.mark) - firstClaims(cues, left.mark) ||
      right.score - left.score ||
      PREFERENCE.indexOf(left.mark) - PREFERENCE.indexOf(right.mark),
  );

  return {
    question,
    recommendations,
    refused,
    shape: {
      dims: shape.dims.length,
      ordered: shape.ordered.length,
      measures: shape.measures.length,
      counted: shape.counted,
    },
  };
}

export interface ChartIROptions extends RecommendOptions {
  readonly title?: string;
  readonly subtitle?: string;
  readonly alt?: string;
  readonly theme?: Theme;
  /** Rows to carry. The contract refuses more than fifty thousand. */
  readonly limit?: number;
  /**
   * The columns in the order the result set has them.
   *
   * A record cannot carry this: `Object.keys` puts integer-like keys first, so a table with a year
   * column named `2016` enumerates with that column ahead of the ones the query selected. A caller
   * that read the columns from a table passes them here, and the chart is drawn from the table's
   * order rather than from a JavaScript property-order accident.
   */
  readonly columns?: readonly string[];
  /**
   * The mark to draw, when the choice was made outside this function.
   *
   * One use: `assist.ts` asks a model for a mark and hands the answer back here. The override decides
   * the mark and nothing else — admissions still apply, the encoding is still derived from the result
   * set, and the rows are still folded and ordered by the same code — so a model can change *what
   * shape* is drawn but never *what the chart says*.
   *
   * A mark the result set cannot hold is refused with the recommender's own reason rather than
   * coerced into a neighbour. Drawing a bar because a pie was not admitted is this function choosing
   * for the caller, and the caller is the one holding the answer key.
   */
  readonly mark?: RecommendableMark;
}

const ref = (profile: FieldProfile): FieldRef => ({ field: profile.name, type: profile.type });

/**
 * The marks a table read sideways can be drawn as.
 *
 * Three, and each one is a reading of the same long form (`entity × period × value`): a line per
 * entity, side-by-side bars per period, or a matrix of the two categories coloured by the value.
 *
 * This list used to be a single mark, and the comment that justified it said one line per entity is
 * "the only reading the reshape produces". The corpus says otherwise, and it says it 53 times: of the
 * 144 wide tables in `eval/text2vis`, **53 are labelled `Bar`** and 71 `Line`. The prediction was not
 * a reading of the data, it was a reading of the reshape's *first* implementation, and a shape with
 * two categories in it is what a grouped bar is for.
 */
const WIDE_MARKS: readonly RecommendableMark[] = ['line', 'bar', 'heatmap'];

/**
 * A wide table as the chart it is: one line per entity along the periods the table is wide in.
 *
 * The mark is not a recommendation, it is the shape — which is why it defaults to the line rather
 * than being ranked: the columns *are* a timeline, and a line keeps the entities apart while stating
 * the interval between periods. No admission rule has to be asked for that default, because there is
 * no choice left to admit — which is also why this path cannot decline a table it has already proved
 * is chartable.
 *
 * A caller that names a mark gets the mark, if the long form can hold it: the reshape produces two
 * categories and one measure, so a grouped bar and a heatmap are both pictures of it. A mark it
 * cannot hold is refused here rather than drawn as the nearest neighbour, for the reason
 * `ChartIROptions.mark` gives — a pie of the long form would slice entities against periods, which is
 * a total the table never stated.
 */
function wideIR(question: string, melt: WideTable, limit: number, options: ChartIROptions): ChartIR {
  const mark = options.mark ?? 'line';
  if (!WIDE_MARKS.includes(mark)) {
    throw new Nl2ChartsError(
      'NL2C_E_NOT_SUPPORTED',
      `this table is one row per ${melt.entity} written sideways across ${melt.period} columns, so its long form is ${melt.entity} × ${melt.period} × ${melt.value}; a ${mark} is not a picture of two categories and one measure`,
    );
  }
  const data = melt.rows.slice(0, limit).map((row) => ({ ...row }));
  const encoding: Encoding =
    mark === 'heatmap'
      ? {
          x: { field: melt.period, type: 'temporal' },
          y: [{ field: melt.entity, type: 'nominal' }],
          color: { field: melt.value, type: 'quantitative' },
        }
      : {
          x: { field: melt.period, type: 'temporal' },
          y: [{ field: melt.value, type: 'quantitative' }],
          series: { field: melt.entity, type: 'nominal' },
        };
  return {
    version: CONTRACT_VERSION,
    mark,
    encoding,
    data,
    title: options.title ?? question,
    alt: options.alt ?? `${mark} chart of ${String(data.length)} row(s): ${question}`,
    ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
    ...(options.theme === undefined ? {} : { theme: options.theme }),
  };
}

/** The column a histogram states its intervals in. */
const BIN_FIELD = 'bin';

/**
 * A table read as a histogram: every number in it, pooled and counted into bins.
 *
 * The reading is gated on the question, not on the shape, and that is the whole of its honesty: a
 * table of five numbers has as many readings as it has marks, and the pooled distribution is only
 * the one a question asked for in words. `cues` is the shipped table, so the gate is the same one
 * that offers the bar — the difference is that this reading also *rewrites the rows*, which is what
 * a bar of a histogram is and what a grouped bar of the period columns was not.
 *
 * Two tables are pooled by the same rule. A narrow one contributes every measure column; a table wide
 * in time contributes the single `value` column its melt produces, because the periods are the same
 * numbers written sideways. `meltWide` is asked first for exactly that reason, and it decides nothing
 * here: a wide table that is not asked for a histogram still goes down the line-per-entity path.
 */
export interface HistogramReading {
  /** One row per bin: the interval, and the number of pooled values that fell in it. */
  readonly rows: readonly Readonly<Record<string, string | number>>[];
  readonly bin: string;
  readonly count: string;
  /** The bins themselves, which is what the caller can label an axis with. */
  readonly distribution: Distribution;
}

/**
 * The histogram reading of `rows`, or nothing when the question did not ask for one.
 *
 * Exported because the readings in `eval/text2vis` price the product from profiles alone, and this
 * one predicate is the only thing that can keep the offline instrument and the shipped path from
 * disagreeing about what the product draws: `toChartIR` calls it before anything else, and
 * `profileAnswer` calls it through the same function rather than restating the gate.
 */
/**
 * The columns whose numbers a histogram pools.
 *
 * A quantitative column is a measure, and those are pooled first. The fallback catches the tables
 * the profiler cannot call a measure: a column that holds one number repeated is typed `ordinal`
 * (one distinct value is a category, by the rule that types every column), so a histogram of three
 * sevens had no measure to pool at all. A `temporal` column is never pooled whatever it holds — the
 * years are the axis the table runs along, and counting them is not a distribution of anything.
 */
function pooledColumns(profiles: readonly FieldProfile[]): readonly string[] {
  const measures = profiles.filter((profile) => profile.type === 'quantitative').map((profile) => profile.name);
  if (measures.length > 0) return measures;
  return profiles
    .filter((profile) => profile.type !== 'temporal' && profile.numbers > 0)
    .map((profile) => profile.name);
}

export function histogramReading(
  question: string,
  rows: readonly Readonly<Record<string, unknown>>[],
  columns?: readonly string[],
  cues?: readonly CueRule[],
): HistogramReading | undefined {
  const asked = readCues(question, cues);
  // Gated on the word, and the version of this gate that also read `distribution` was measured and
  // refused. On the corpus's 1,470 scored rows it buys 10 histogram rows and loses 26 — 13 bars and
  // 12 pies the product already answered correctly — because this reading returns before the share
  // reading and before every other one. `test/histogram.test.ts` pins the refusal with those numbers,
  // so the next round that proposes the widening meets the measurement instead of the argument.
  if (!asked.some((cue) => cue.kind === 'histogram')) return undefined;
  const melt = meltWide(rows, columns);
  const pooled = melt === undefined ? rows : melt.rows;
  const measures = melt === undefined ? pooledColumns(profileRows(rows, columns)) : [melt.value];
  const values: unknown[] = [];
  for (const row of pooled) for (const name of measures) values.push(row[name]);
  const distribution = pooledDistribution(values);
  if (distribution === undefined) return undefined;
  // Non-empty by construction at this point: a distribution needs at least one number, so the rows it
  // was pooled from exist. Indexing the source rather than the pool is what keeps the order the caller
  // stated — a melted table's names are the three the melt invented, and those are the ones it owns.
  const names =
    columns !== undefined && melt === undefined
      ? columns
      : Object.keys((melt?.rows[0] ?? rows[0]) as Readonly<Record<string, unknown>>);
  const bin = freeOf(names, BIN_FIELD);
  const count = freeOf([...names, bin], COUNT_FIELD);
  return {
    rows: distribution.bins.map((entry) => ({ [bin]: entry.label, [count]: entry.count })),
    bin,
    count,
    distribution,
  };
}

/**
 * A histogram, drawn: bars over the bins.
 *
 * No admission rule is asked and none could refuse, which is why this is a branch of its own rather
 * than a recommendation: the rows are the picture's, not the table's, so every rule that asked about
 * the table's columns would be answering a question about a table this chart no longer draws. The
 * limit applies to the bins because a bin is the unit this picture has — and there are never more
 * than twelve of them, so it truncates only when a caller asks for fewer.
 */
function binnedIR(question: string, reading: HistogramReading, limit: number, options: ChartIROptions): ChartIR {
  const data = reading.rows.slice(0, limit).map((row) => ({ ...row }));
  const encoding: Encoding = {
    // Ordered, because the bins are: a category axis sorts them lexically, and `[10, 20)` sorts
    // after `[100, 110)` as text. `ordinal` is the type that says the order is the data's.
    x: { field: reading.bin, type: 'ordinal' },
    y: [{ field: reading.count, type: 'quantitative' }],
  };
  return {
    version: CONTRACT_VERSION,
    mark: 'bar',
    encoding,
    data,
    title: options.title ?? question,
    alt:
      options.alt ??
      `bar chart of ${String(data.length)} bin(s) pooled from the table's numbers: ${question}`,
    ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
    ...(options.theme === undefined ? {} : { theme: options.theme }),
  };
}

/**
 * The observed range of a measure. A quantitative column always carries both
 * bounds — `profileRows` sets them whenever a column holds numbers — so this is a
 * subtraction rather than a defaulted one.
 */
const span = (profile: FieldProfile): number => (profile.max as number) - (profile.min as number);

/** The measure with the widest observed range: the one a chart can actually show variation in. */
function widest(profiles: readonly FieldProfile[]): FieldProfile | undefined {
  return [...profiles].sort((left, right) => span(right) - span(left) || left.name.localeCompare(right.name))[0];
}

const TUPLE_NAMES: Readonly<Record<'boxplot' | 'candlestick', readonly string[]>> = {
  boxplot: ['min', 'q1', 'median', 'q3', 'max'],
  candlestick: ['open', 'close', 'low', 'high'],
};

/**
 * The five (or four) columns a tuple mark reads, in the order the renderer reads
 * them. A candlestick is `[open, close, lowest, highest]` and a boxplot is
 * `[min, q1, median, q3, max]`; taking the first four numeric columns instead would
 * draw a picture whose shape depends on the order of the result set's columns.
 */
function tupleColumns(profiles: readonly FieldProfile[], mark: 'boxplot' | 'candlestick'): FieldProfile[] {
  const measures = profiles.filter((profile) => profile.type === 'quantitative');
  const wanted = TUPLE_NAMES[mark];
  const named = wanted
    .map((name) => measures.find((profile) => profile.name.toLowerCase() === name))
    .filter((profile): profile is FieldProfile => profile !== undefined);
  const rest = measures.filter((profile) => !named.includes(profile));
  return [...named, ...rest].slice(0, wanted.length);
}

/** Drop the channels a mark does not read, so the contract sees only keys that carry a field. */
function clean(channels: Record<string, unknown>): Encoding {
  return Object.fromEntries(Object.entries(channels).filter(([, value]) => value !== undefined)) as unknown as Encoding;
}

/** The tuple a pre-aggregated table states: five (or four) columns of `y`, along the axis that orders them. */
function tupleEncoding(
  mark: 'boxplot' | 'candlestick',
  shape: Shape,
  profiles: readonly FieldProfile[],
): Encoding {
  // A date column when there is one; else, for the candlestick only, the label column with one value per
  // row. The boxplot keeps its own reading, so widening its axis would be a change nobody measured.
  const axis = shape.ordered[0] ?? (mark === 'candlestick' ? shape.sequence : undefined);
  return clean({
    ...(axis === undefined ? {} : { x: ref(axis) }),
    y: tupleColumns(profiles, mark).map(ref),
  });
}

/**
 * The encoding for a mark that was already admitted.
 *
 * Every field read here was proven to exist by `ADMISSIONS`, which is the only
 * caller that decides a mark can be drawn. Re-checking that proof here would add
 * branches no input can reach, and a coverage number would be the only thing they
 * ever exercised, so the casts record the invariant instead of re-testing it.
 */
function encodingFor(mark: RecommendableMark, shape: Shape, profiles: readonly FieldProfile[]): Encoding {
  const first = shape.dims[0] as FieldProfile;
  const value = widest(shape.measures) as FieldProfile;
  // `aggregate: 'count'` says the column was folded rather than read, and it keeps the linter's
  // `measure-without-aggregate` — a rule about an aggregation forgotten, not one performed — quiet.
  const measure = (profile: FieldProfile): FieldRef =>
    shape.counted ? { ...ref(profile), aggregate: 'count' } : ref(profile);
  switch (mark) {
    case 'pie':
    case 'funnel':
      return clean({ theta: ref(shape.sliceable as FieldProfile), y: measure(value) });
    case 'gauge':
      return clean({ y: measure(value) });
    case 'heatmap':
      return clean({ x: ref(first), y: [ref(shape.dims[1] as FieldProfile)], color: measure(value) });
    case 'boxplot':
      // Two readings of one mark. A table that carries the five numbers states its boxes in columns;
      // a table that carries observations states them in rows, and this branch folds them — the
      // encoding names the five numbers the fold writes, plus a label column naming the measure each
      // box summarises. Both are proven to exist by `boxplotReading`, which is the only function that
      // decides a boxplot can be drawn.
      return boxplotReading(shape)?.layout === 'derived'
        ? clean({
            x: { field: freeName(profiles, LABEL_FIELD), type: 'nominal' },
            y: TUPLE_NAMES.boxplot.map((field) => ({ field, type: 'quantitative' as const })),
          })
        : tupleEncoding('boxplot', shape, profiles);
    case 'candlestick':
      return tupleEncoding('candlestick', shape, profiles);
    case 'radar':
      return clean({ theta: ref(first), y: [measure(value)] });
    case 'parallel':
      return clean({ x: ref(first), y: shape.measures.map(measure) });
    case 'scatter':
      // Both axes carry a measure: a scatter over a category axis is a bar chart
      // that lost its aggregation, and the linter refuses it outright.
      return clean({ x: ref(shape.measures[0] as FieldProfile), y: [ref(shape.measures[1] as FieldProfile)] });
    case 'line': {
      // A line runs along an axis, and an axis that does not carry its own order takes the order the
      // measure gives it — the admission rule above admits exactly that shape, on the corpus's own
      // words ("plot these percentages in order of increasing Value ... on a line chart"). Reading
      // `ordered[0]` alone was this branch disagreeing with the rule that admitted the mark: 106 of
      // the corpus's 1,470 scored rows reached here with no ordered column and threw.
      const axis = shape.ordered[0] ?? first;
      return clean({ x: ref(axis), y: [measure(value)] });
    }
    case 'bar':
      return clean({ x: ref(first), y: [measure(value)] });
  }
}

/**
 * The five numbers of one sample, by the estimator R calls type 7 and numpy calls `linear`: the
 * p-quantile sits at `(n - 1) * p`, interpolated between the order statistics around it. Named
 * because the alternatives are not equivalent — nearest-rank reads the quartiles of `1..10` as 3 and
 * 8 — and because it is what the reference code of the corpus we are measured against calls.
 */
function quantilesOf(sorted: readonly number[]): readonly [number, number, number, number, number] {
  const at = (p: number): number => {
    const position = (sorted.length - 1) * p;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const from = sorted[lower] as number;
    return from + ((sorted[upper] as number) - from) * (position - lower);
  };
  return [sorted[0] as number, at(0.25), at(0.5), at(0.75), sorted[sorted.length - 1] as number];
}

/**
 * One row per measure: the five-number summary of that column over the result set's rows.
 *
 * One box per measure rather than one box in all. The corpus states why: `Characteristic, Male,
 * Female` over fifteen countries is asked as "analyze the distribution of male percentages", and the
 * measure with the widest range there is `Female` — a single box would silently summarise the column
 * the question did not ask about, and no label-based score could see the substitution. A box per
 * column draws both, labelled, and the reader can find the one they asked for.
 *
 * The measures arrive from `boxplotReading`, which has already established that each of them holds at
 * least `MIN_OBSERVATIONS` finite numbers — so this is a fold and not a filter, and there is no
 * branch here for a column too sparse to summarise. A cell that is not a finite number is left out of
 * the sample: `NaN - NaN` is not a comparison, and one `NaN` in ten values would make every quartile
 * `NaN`.
 */
/** Every field an encoding groups by: the axes, and any non-measure on colour. */
function groupFieldsOf(encoding: Encoding): FieldRef[] {
  const out = new Map<string, FieldRef>();
  for (const channel of [encoding.x, encoding.theta, encoding.y, encoding.color]) {
    if (channel === undefined) continue;
    for (const field of Array.isArray(channel) ? channel : [channel]) {
      if (field.type !== 'quantitative') out.set(field.field, field);
    }
  }
  return [...out.values()];
}

/**
 * Rows in the order a measure gives them, ascending, with the cells that are not finite numbers last.
 *
 * The column was profiled as a measure, so every cell is a number — but a number is not always a
 * value: `NaN` and `Infinity` arrive from a result set that prints them, and `NaN - NaN` is not a
 * comparison. Those rows keep the order the query returned, after the measured ones, rather than
 * being dropped: the line still passes through them, and dropping a row would change how long the
 * line is, which is a fact about the picture rather than about the row.
 *
 * The index is the second key so that tied measures keep the query's order. A sort that reordered
 * equal values would make the reading depend on the engine's sort being stable.
 */
function orderedAlong(
  rows: readonly Readonly<Record<string, unknown>>[],
  field: string,
  direction: 'ascending' | 'descending' = 'ascending',
): readonly Readonly<Record<string, unknown>>[] {
  const keyed = rows.map((row, index) => ({ row, index, value: row[field] as number }));
  const sign = direction === 'ascending' ? 1 : -1;
  return keyed
    .sort((left, right) => {
      const leftRead = Number.isFinite(left.value);
      const rightRead = Number.isFinite(right.value);
      if (leftRead && rightRead) return sign * (left.value - right.value) || left.index - right.index;
      if (leftRead) return -1;
      if (rightRead) return 1;
      return left.index - right.index;
    })
    .map((entry) => entry.row);
}

/** The words that name each end of a ranking, in the spelling a question uses. */
const RANK_WORDS: readonly (readonly [RegExp, 'ascending' | 'descending'])[] = [
  [/\b(?:lowest|least|smallest|fewest|bottom|worst|cheapest)\b|最低|最少|最小|最差/, 'ascending'],
  // `rank` without an end names the usual one: a ranking written with no direction is a list from
  // the largest down, which is what every table of ranks in this corpus does.
  [/\b(?:top|highest|largest|greatest|most|best|rank\w*)\b|最高|最多|最大|最好|排名/, 'descending'],
];

/**
 * The direction a question's ranking asks for, or nothing when it asks for no ranking at all.
 *
 * Two tables answer two different questions here, and the difference is load-bearing. `readCues`
 * says whether a sentence ranks something *strongly enough to ask for a bar*, and that table is
 * deliberately narrow because every word in it pays three points to a mark. This one says which
 * end the sentence named, and it can be wider than the cue: a sort loses nothing, while a cue
 * changes which chart is drawn. `fewest` is the reading that separated them — it is a ranking word
 * the cue table does not carry, so the first version of this function answered `undefined` for
 * "Which products have the fewest orders?" and the counted path stayed largest-first.
 *
 * The earliest ranking word wins, so a question naming both ends is ordered by the one it asked
 * about first. `min` and `max` are left out of both lists on purpose: they are as often a column
 * name as an instruction.
 *
 * `undefined` is what leaves every chart whose question ranks nothing byte-identical: the rule fires
 * only on the sentences it was written for.
 */
export function rankingDirection(question: string): 'ascending' | 'descending' | undefined {
  const text = question.toLowerCase();
  let first: { readonly at: number; readonly direction: 'ascending' | 'descending' } | undefined;
  for (const [pattern, direction] of RANK_WORDS) {
    // Not global: `exec` on a global pattern advances `lastIndex` and would skip every other call.
    const found = pattern.exec(text);
    if (found === null) continue;
    if (first === undefined || found.index < first.at) first = { at: found.index, direction };
  }
  // No word at all is not "descending by default": it is a question that named no end, and the
  // caller leaves the rows where the query put them.
  return first?.direction;
}

/** The marks whose slices or bars are read as a comparison of their sizes, so an order is owed. */
const RANKED_MARKS = new Set(['bar', 'pie', 'funnel']);

/**
 * The field a chart is a **matrix** of, or nothing when it is not one.
 *
 * A matrix states a category on each axis and a measure in colour, so its rows are cells. Read off
 * the encoding rather than the mark's name for the reason `groupFieldsOf` reads channels. The test is
 * "neither axis is a measure", not "both are nominal": a heatmap's lanes are as often time as a
 * category, and asking for `nominal` twice left every one of those being cut inside a column.
 */
function matrixFieldOf(encoding: Encoding): string | undefined {
  const x = encoding.x;
  const y = encoding.y;
  if (x === undefined || Array.isArray(x) || x.type === 'quantitative') return undefined;
  if (y === undefined || !Array.isArray(y) || y.length !== 1 || (y[0] as FieldRef).type === 'quantitative') return undefined;
  return x.field;
}

/**
 * The limit, applied to a matrix **by the column** instead of by the row.
 *
 * A row limit is a limit on a picture when the picture is a sequence: cut a line at row 500 and you
 * get a shorter line. A matrix is not a sequence — cutting it inside a column leaves a lane that
 * reads as *missing data*, which is the one reading a heatmap exists to give. So whole columns are
 * kept in the order they first appear and the first that does not fit is dropped rather than started.
 * A limit below one column keeps nothing, and that is a refusal: the message names both numbers.
 */
export function wholeColumns<T>(rows: readonly T[], field: (row: T) => unknown, limit: number): T[] {
  // No rows is no matrix to cut, and it is not the refusal below: the refusal is about a limit that
  // is too small for the columns that exist, and here no column exists to be too small for.
  if (rows.length === 0) return [];
  const sizes = new Map<string, number>();
  for (const row of rows) {
    const key = String(field(row));
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  const admitted = new Set<string>();
  let taken = 0;
  for (const [key, size] of sizes) {
    if (taken + size > limit) break;
    admitted.add(key);
    taken += size;
  }
  if (admitted.size === 0) {
    const [column, size] = [...sizes][0] as [string, number];
    throw new Nl2ChartsError(
      'NL2C_E_INVALID_INPUT',
      `limit=${String(limit)} is smaller than one column of this matrix: "${column}" holds ${String(size)} cells, and a matrix cut inside a column reads as missing data rather than as a smaller picture`,
    );
  }
  return rows.filter((row) => admitted.has(String(field(row))));
}

/**
 * Fold rows into one row per group, with a count.
 *
 * A chart along an ordered axis keeps the order the query produced — a line over years ranked by its
 * counts is a line through a shuffle — and any other chart is ranked, because "which one has the
 * most" is the question a count chart answers.
 */
function countsOf(
  rows: readonly Readonly<Record<string, unknown>>[],
  fields: readonly string[],
  name: string,
  keepOrder: boolean,
  direction: 'ascending' | 'descending' = 'descending',
): Record<string, unknown>[] {
  const groups = new Map<string, { values: Record<string, unknown>; count: number }>();
  for (const row of rows) {
    const key = fields.map((field) => String(row[field])).join('\u0000');
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { values: Object.fromEntries(fields.map((field) => [field, row[field] ?? null])), count: 1 });
    } else group.count += 1;
  }
  const counted = [...groups.values()];
  // `Array#sort` is stable, so equal counts keep the order the query returned them in. The
  // direction is the ranking the question asked for, because a count is the only ranking a table
  // without a measure can express and `fewest` is the other end of it.
  if (!keepOrder) {
    counted.sort((left, right) => (direction === 'descending' ? right.count - left.count : left.count - right.count));
  }
  return counted.map((group) => ({ ...group.values, [name]: group.count }));
}

/**
 * The recommendation for one named mark, or a refusal carrying the recommender's own reason.
 *
 * Only reachable through `ChartIROptions.mark`, which exists so a caller that decided the mark
 * elsewhere — `assist.ts`, on a model's advice — can hand the decision back without reimplementing
 * the admissions. The two lists are exhaustive over `RECOMMENDABLE_MARKS`: `recommendChart` pushes
 * every mark into exactly one of them, so a mark that is in neither is a mark added to the list
 * without an admission, and returning `undefined` there would surface as "no chart fits" rather than
 * as the defect it is.
 */
function admitted(choice: ChartChoice, mark: RecommendableMark): Recommendation | undefined {
  const refusal = choice.refused.find((entry) => entry.mark === mark);
  if (refusal !== undefined) {
    throw new Nl2ChartsError('NL2C_E_NOT_SUPPORTED', `the mark ${mark} is refused on this result set: ${refusal.reason}`);
  }
  return choice.recommendations.find((entry) => entry.mark === mark);
}

/**
 * Turn the best recommendation into a chart contract, so the caller of a query
 * does not have to write one. The title is the question because a chart without
 * one cannot be cited, and the alt text names the mark because that is the part a
 * screen reader has to say out loud.
 *
 * Throws `NL2C_E_NOT_SUPPORTED` when no mark can encode the result set: a chart of
 * an empty or unmeasurable table is not a rendering problem to paper over.
 */
export function toChartIR(
  question: string,
  rows: readonly Readonly<Record<string, unknown>>[],
  options: ChartIROptions = {},
): ChartIR {
  const limit = options.limit ?? 5_000;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Nl2ChartsError('NL2C_E_INVALID_INPUT', `limit=${String(limit)} is not a positive whole number of rows`);
  }
  if (rows.length === 0) {
    throw new Nl2ChartsError('NL2C_E_NOT_SUPPORTED', 'the result set is empty, so there is nothing to chart');
  }
  // A question that asked for a histogram is answered with one, before any other reading: the rows
  // are pooled and binned, so every rule below would be reading a table this chart no longer draws.
  // A caller that named a different mark is not answered this way — an explicit mark is an
  // instruction, and a rewrite of the caller's data is not a decoration of it.
  const histogram = options.mark === undefined || options.mark === 'bar' ? histogramReading(question, rows, options.columns) : undefined;
  if (histogram !== undefined) return binnedIR(question, histogram, limit, options);
  // A table that is wide in time is read as the shape it states, before any column is profiled: its
  // rows are not observations, they are entities written sideways, and every rule below would read
  // the period columns as competing measures. See `meltWide` for why the predicate is that narrow.
  const melt = meltWide(rows, options.columns);
  if (melt !== undefined) return wideIR(question, melt, limit, options);
  const profiles = profileRows(rows, options.columns);
  // The one fact a column profile cannot hold, and the one that decides the counted measure.
  const choice = recommendChart(question, profiles, { ...options, rows: rows.length });
  const best = options.mark === undefined ? choice.recommendations[0] : admitted(choice, options.mark);
  if (best === undefined) {
    const columns = profiles.map((profile) => `${profile.name}:${profile.type}`).join(', ');
    throw new Nl2ChartsError(
      'NL2C_E_NOT_SUPPORTED',
      `no chart fits a result set of (${columns}); a chart needs a measure, and a shape needs the columns that witness it`,
    );
  }
  const shape = shapeOf(profiles, { maxSlices: options.maxSlices ?? DEFAULT_MAX_SLICES, rows: rows.length });
  const encoding = encodingFor(best.mark, shape, profiles);
  // Folding before the limit is what makes the limit a limit on the picture, not on the evidence.
  const groupFields = groupFieldsOf(encoding);
  // The axis a slice or bar runs along, whichever channel carries it: a pie states its categories
  // in `theta`, and reading only `x` here left every pie in the table's order.
  //
  // One field by construction, so this reads the channel rather than un-picking a list: no branch of
  // `encodingFor` puts an array on `x` or `theta` — the tuple marks put theirs on `y` — and the
  // `Array.isArray` that used to stand here was a branch no input could reach, kept alive by a
  // coverage number rather than by a caller.
  const axis = (encoding.x ?? encoding.theta) as FieldRef | undefined;
  const measureName = shape.counted ? undefined : (widest(shape.measures) as FieldProfile).name;
  /** The order a ranking question owes its mark, or nothing when the question asked for none. */
  const ranking =
    axis?.type === 'nominal' && RANKED_MARKS.has(best.mark) ? rankingDirection(question) : undefined;
  // The one mark whose rows are not the result set's rows: a boxplot read off observations replaces
  // them with five numbers per measure, so the fold happens here rather than in the ordering below.
  // `boxplotReading` is the same function the admission and the encoding asked, so this branch cannot
  // be entered for a table that carries its five numbers in columns, and the measures it summarises
  // are the ones that function decided have enough numbers to summarise.
  const reading = best.mark === 'boxplot' ? boxplotReading(shape) : undefined;
  const label = freeName(profiles, LABEL_FIELD);
  const boxes =
    reading?.layout === 'derived'
      ? reading.measures.map((measure) => {
          const values = rows
            .map((row) => row[measure.name])
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
            .sort((left, right) => left - right);
          const [min, q1, median, q3, max] = quantilesOf(values);
          return { [label]: measure.name, min, q1, median, q3, max };
        })
      : undefined;
  // Folding before the limit is what makes the limit a limit on the picture, not on the evidence.
  const folded = shape.counted
    ? countsOf(
        rows,
        groupFields.map((field) => field.field),
        (widest(shape.measures) as FieldProfile).name,
        groupFields.some((field) => field.type === 'temporal' || field.type === 'ordinal'),
        // The counted path ranks its groups already; only the direction is the question's to say.
        ranking ?? 'descending',
      )
    : (best.mark === 'line' && axis?.type === 'nominal'
        ? // A line over categories the data does not order runs along the measure; see `encodingFor`,
          // which chose the axis this order belongs to. Sorting before the limit keeps the limit a
          // limit on the picture: the rows that survive are the ones the line actually visits.
          orderedAlong(rows, measureName as string)
        : ranking === undefined
          ? [...rows]
          : // A bar, pie or funnel answering a ranked question: the tallest bar first is the whole
            // answer, and the order the query returned is not an order the question asked about.
            orderedAlong(rows, measureName as string, ranking)
      ).map((row) => ({ ...row }));
  // The limit is one decision, taken in one place, in the unit the picture has: rows for a sequence,
  // columns for a matrix. It used to be two `.slice` calls in the middle of the ordering expressions,
  // which is how a heatmap came to be cut inside a column.
  const columns = matrixFieldOf(encoding);
  const data =
    boxes !== undefined
      ? boxes.slice(0, limit)
      : columns === undefined
        ? folded.slice(0, limit)
        : wholeColumns(folded, (row) => row[columns], limit);
  const mark: ChartType = best.mark;
  const ir: ChartIR = {
    version: CONTRACT_VERSION,
    mark,
    encoding,
    data,
    title: options.title ?? question,
    alt: options.alt ?? `${mark} chart of ${String(data.length)} row(s): ${question}`,
    ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
    ...(options.theme === undefined ? {} : { theme: options.theme }),
  };
  return ir;
}
