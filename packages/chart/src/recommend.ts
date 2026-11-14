import { CONTRACT_VERSION, Nl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { ChartIR, ChartType, Encoding, FieldRef, Theme } from '@agentix-e/nl2charts-spec';
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
 * The kinds a cue can be. The vocabulary is the product's, and one member of it — `histogram` — is
 * not emitted by `CHART_CUES`: the contract has no histogram series, a histogram is a bar with the
 * measure binned, and whether the table should *name* that intent is a question the corpus in
 * `eval/text2vis` prices as a variant before the shipped table changes. It is in the union so the
 * variant is written against the same type as the table it re-orders rather than against a cast.
 */
export type CueKind =
  | 'trend'
  | 'share'
  | 'distribution'
  | 'histogram'
  | 'correlation'
  | 'ranking'
  | 'matrix'
  | 'progress'
  | 'stages'
  | 'multi-metric'
  | 'profile'
  | 'volatility';

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
export const CHART_CUES: readonly CueRule[] = [
  {
    kind: 'trend',
    marks: ['line', 'bar'],
    pattern: /\b(?:trend|trending|over time|growth|time series|monthly|yearly|quarterly|weekly|by month|by year|by quarter|by week)\b|趋势|每月|按月|按年/,
  },
  {
    kind: 'share',
    marks: ['pie', 'bar'],
    pattern: /\b(?:share|proportion|percentage|percent|composition|breakdown|split|makeup)\b|占比|比例|构成/,
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
    kind: 'matrix',
    marks: ['heatmap', 'bar'],
    pattern: /\bby\b[\s\S]*\band\b|交叉|矩阵/,
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
  /** Counted points: a structural prior plus three or two per cue that names the mark. */
  readonly score: number;
  readonly cues: readonly CueKind[];
  readonly reasons: readonly string[];
}

export interface Refusal {
  readonly mark: RecommendableMark;
  /** Why the result set cannot carry this mark, in words a caller can act on. */
  readonly reason: string;
}

export interface ChartChoice {
  readonly question: string;
  /** Admissible marks, best first. Empty when no mark can encode the result set. */
  readonly recommendations: readonly Recommendation[];
  /** Every considered mark that was ruled out, so the audit trail is complete. */
  readonly refused: readonly Refusal[];
}

export interface RecommendOptions {
  /** Slices a pie or a funnel may carry before it stops being readable. */
  readonly maxSlices?: number;
}

interface Resolved {
  readonly maxSlices: number;
}

interface Shape {
  readonly dims: readonly FieldProfile[];
  readonly ordered: readonly FieldProfile[];
  readonly measures: readonly FieldProfile[];
  /** The widest category still small enough to be named in a pie. */
  readonly sliceable: FieldProfile | undefined;
}

interface Admission {
  readonly mark: RecommendableMark;
  readonly prior: number;
  readonly reason: string;
  /** Null when the data fits; otherwise the sentence explaining what is missing. */
  readonly admit: (shape: Shape, options: Resolved) => string | null;
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
    reason: 'profile:ordered-axis-and-measure',
    admit: (shape) =>
      shape.ordered.length >= 1 && shape.measures.length >= 1 ? null : 'a line needs an ordered axis and a measure',
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
    prior: 3,
    reason: 'profile:five-numbers-per-row',
    admit: (shape) =>
      shape.measures.length >= 5 ? null : `a boxplot reads five numbers per row and this result has ${String(shape.measures.length)}`,
  },
  {
    mark: 'candlestick',
    prior: 3,
    reason: 'profile:four-numbers-per-row-on-an-ordered-axis',
    admit: (shape) =>
      shape.measures.length >= 4 && shape.ordered.length >= 1
        ? null
        : `a candlestick reads four numbers per row on a date axis and this result has ${String(shape.measures.length)} and ${String(shape.ordered.length)}`,
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

/** Order that decides ties, so two marks that fit equally well always rank the same way. */
const PREFERENCE: readonly RecommendableMark[] = [
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

function shapeOf(profiles: readonly FieldProfile[], options: Resolved): Shape {
  const dims = profiles.filter((profile) => profile.type !== 'quantitative');
  const ordered = dims.filter((profile) => profile.type === 'temporal' || profile.type === 'ordinal');
  const measures = profiles.filter((profile) => profile.type === 'quantitative');
  const sliceable = dims
    .filter((profile) => profile.distinct <= options.maxSlices && profile.distinct >= 2)
    .sort((left, right) => right.distinct - left.distinct || left.name.localeCompare(right.name))[0];
  return { dims, ordered, measures, sliceable };
}

/**
 * Rank the marks that can encode this result set, given the question.
 *
 * The score is counted in points a reader can reproduce from the reasons: three for
 * the first mark a cue names, two for the rest, plus the structural prior. Nothing
 * is normalised, so `score: 5` means "this result set fits the mark and one cue
 * named it", and a caller can recompute it from the two facts reported alongside.
 */
export function recommendChart(
  question: string,
  profiles: readonly FieldProfile[],
  options: RecommendOptions = {},
): ChartChoice {
  const resolved: Resolved = { maxSlices: options.maxSlices ?? 7 };
  const shape = shapeOf(profiles, resolved);
  const cues = readCues(question);
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
    for (const cue of named) {
      score += cue.marks.indexOf(admission.mark) === 0 ? 3 : 2;
      reasons.push(`cue:${cue.kind} "${cue.phrase}"`);
    }
    recommendations.push({ mark: admission.mark, score, cues: named.map((cue) => cue.kind), reasons });
  }

  recommendations.sort(
    (left, right) =>
      right.score - left.score || PREFERENCE.indexOf(left.mark) - PREFERENCE.indexOf(right.mark),
  );

  return { question, recommendations, refused };
}

export interface ChartIROptions extends RecommendOptions {
  readonly title?: string;
  readonly subtitle?: string;
  readonly alt?: string;
  readonly theme?: Theme;
  /** Rows to carry. The contract refuses more than fifty thousand. */
  readonly limit?: number;
}

const ref = (profile: FieldProfile): FieldRef => ({ field: profile.name, type: profile.type });

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
  switch (mark) {
    case 'pie':
    case 'funnel':
      return clean({ theta: ref(shape.sliceable as FieldProfile), y: ref(value) });
    case 'gauge':
      return clean({ y: ref(value) });
    case 'heatmap':
      return clean({ x: ref(first), y: [ref(shape.dims[1] as FieldProfile)], color: ref(value) });
    case 'boxplot':
    case 'candlestick': {
      const axis = shape.ordered[0];
      return clean({
        ...(axis === undefined ? {} : { x: ref(axis) }),
        y: tupleColumns(profiles, mark).map(ref),
      });
    }
    case 'radar':
      return clean({ theta: ref(first), y: [ref(value)] });
    case 'parallel':
      return clean({ x: ref(first), y: shape.measures.map(ref) });
    case 'scatter':
      // Both axes carry a measure: a scatter over a category axis is a bar chart
      // that lost its aggregation, and the linter refuses it outright.
      return clean({ x: ref(shape.measures[0] as FieldProfile), y: [ref(shape.measures[1] as FieldProfile)] });
    case 'line':
      return clean({ x: ref(shape.ordered[0] as FieldProfile), y: [ref(value)] });
    case 'bar':
      return clean({ x: ref(first), y: [ref(value)] });
  }
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
  const profiles = profileRows(rows);
  const choice = recommendChart(question, profiles, options);
  const best = choice.recommendations[0];
  if (best === undefined) {
    const columns = profiles.map((profile) => `${profile.name}:${profile.type}`).join(', ');
    throw new Nl2ChartsError(
      'NL2C_E_NOT_SUPPORTED',
      `no chart fits a result set of (${columns}); a chart needs a measure, and a shape needs the columns that witness it`,
    );
  }
  const shape = shapeOf(profiles, { maxSlices: options.maxSlices ?? 7 });
  const data = [...rows].slice(0, limit).map((row) => ({ ...row }));
  const mark: ChartType = best.mark;
  const ir: ChartIR = {
    version: CONTRACT_VERSION,
    mark,
    encoding: encodingFor(best.mark, shape, profiles),
    data,
    title: options.title ?? question,
    alt: options.alt ?? `${mark} chart of ${String(data.length)} row(s): ${question}`,
    ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
    ...(options.theme === undefined ? {} : { theme: options.theme }),
  };
  return ir;
}
