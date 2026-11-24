/**
 * nvBench 2.0's judge, ported from `reference/{evaluation,utils}.py`.
 *
 * The number a leaderboard reports here is F1@k over a list of Vega-Lite chart fragments per
 * question, and the reference makes three decisions before comparing anything. All three are
 * judgements about the *comparison*, not about the model, so a port that "simplifies" any of them
 * produces a number in a different coordinate system:
 *
 * 1. **Axes are canonicalised by field type.** `reverse_axes_if_needed` swaps `x` and `y` when both
 *    fields are quantitative and `x > y` lexicographically, or when the mark is bar/line/boxplot and
 *    `x` is quantitative while `y` is not. A prediction that transposed a chart is therefore correct,
 *    and whether it is recognised as correct depends entirely on the type map — which is why
 *    `metadata.py` exists and why its 8,952-of-8,952 agreement with the corpus is the load-bearing
 *    evidence here.
 * 2. **Keys are ordered before comparison.** `normalize_chart_order` rebuilds `mark`, `encoding`
 *    (channels `x, y, theta, color, size`; properties `field, aggregate, bin, sort`), `transform`
 *    (filter operators in a fixed order) and then everything else. It is not cosmetic: it also
 *    *drops* a transform that is not a filter, and leaves an empty `{}` behind for an encoding
 *    channel whose value is not an object.
 * 3. **Lists compare without consuming.** `deep_compare_charts` requires equal lengths and then asks
 *    whether every element of the first has *some* match in the second. `[1, 1]` and `[1, 2]` are
 *    therefore equal. That is the reference's semantics and it is reproduced here rather than
 *    quietly fixed, because a fixed judge reports a number the leaderboard does not; the consuming
 *    comparison is exported beside it as `compareExactly`, so the gap between the two can be read
 *    instead of argued about.
 *
 * Two deviations, both deliberate and both tested:
 *
 * - the reference *mutates* the chart it is given (`chart['encoding']['x'], ... = ...`), which means
 *   a caller that preprocesses the same list twice is trusting idempotence it never checked. This
 *   port copies.
 * - the reference raises `TypeError` when `encoding` is not an object and happens to contain a
 *   channel name (`'x' in 'xy'` is true for a string). A malformed prediction is worth 0, not a
 *   crashed 750-question run, so this port normalises it to an empty encoding.
 */
import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';

/** What a field is, in the reference's vocabulary. Only `quantitative` is ever asked about. */
export type FieldKind = 'quantitative' | 'category' | 'temporal';

/** `type_by_field` for one table, as `metadata.py` writes it. */
export type FieldTypes = Readonly<Record<string, FieldKind>>;

/** A Vega-Lite fragment. `unknown` throughout: a prediction is model output, not a schema. */
export type Chart = Readonly<Record<string, unknown>>;

/**
 * One question's worth of scoring: what was predicted, what the corpus says is right, and the type
 * map of the table it is about.
 *
 * The map lives on the case rather than as one argument for the whole corpus, because there is no
 * such thing as a corpus-wide map here: `type_by_field` is per table, and passing the whole
 * `{csv: fields}` object to `reverse_axes_if_needed` makes every lookup `undefined` — which does not
 * throw, does not warn, and silently turns the axis rules off. That mistake was made once while
 * wiring this file up, and it moved F1@3 by 0.04 while leaving F1@1 untouched.
 */
export interface Case {
  readonly predictions: readonly unknown[];
  readonly golds: readonly unknown[];
  readonly types: FieldTypes;
}

/** Hit, recall, precision and F1 at every k asked for. */
export interface Reading {
  readonly hit: Readonly<Record<number, number>>;
  readonly recall: Readonly<Record<number, number>>;
  readonly precision: Readonly<Record<number, number>>;
  readonly f1: Readonly<Record<number, number>>;
  /** Questions counted. A question with no gold is skipped, as in the reference. */
  readonly questions: number;
}

const CHANNELS = ['x', 'y', 'theta', 'color', 'size'];
const PROPERTIES = ['field', 'aggregate', 'bin', 'sort'];
const OPERATORS = ['equal', 'lt', 'lte', 'gt', 'gte', 'range', 'oneOf', 'valid'];

/** Whether a value is an object and not an array — the shape `isinstance(x, dict)` tests. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Python truthiness, which is not JavaScript truthiness.
 *
 * The reference reads `chart.get('encoding', {}).get('x') and ... .get('y')`, and an empty dict is
 * true in Python while an empty array is false. Both are reachable from model output.
 */
export function pyTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/** A deep copy, because the reference's in-place swap must not reach the caller's data. */
function copyOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyOf);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = copyOf(value[key]);
    return out;
  }
  return value;
}

/** The `field` of an encoding channel, taking the first element of a list as the reference does. */
export function fieldOf(channel: unknown): string | undefined {
  if (!isRecord(channel)) return undefined;
  const field = channel.field;
  if (typeof field === 'string') return field;
  if (Array.isArray(field) && typeof field[0] === 'string') return field[0];
  return undefined;
}

function swapAxes(encoding: Record<string, unknown>): void {
  const x = encoding.x;
  encoding.x = encoding.y;
  encoding.y = x;
}

/**
 * `reverse_axes_if_needed`, with the same two rules and the same early exits.
 *
 * Returns a copy; the reference returns the object it mutated, so both agree on the value and only
 * differ on whether the caller's chart still has its original orientation.
 */
export function reverseAxes(chart: Chart, types: FieldTypes): Chart {
  const out = copyOf(chart) as Chart;
  const encoding = out.encoding;
  if (!isRecord(encoding)) return out;
  if (!pyTruthy(encoding.x) || !pyTruthy(encoding.y)) return out;
  if (!isRecord(encoding.x) || !isRecord(encoding.y)) return out;
  const xField = fieldOf(encoding.x);
  const yField = fieldOf(encoding.y);
  if (xField === undefined || yField === undefined) return out;
  const xType = types[xField];
  const yType = types[yField];
  const mutable = out as Record<string, unknown>;
  const mutableEncoding = encoding as Record<string, unknown>;
  if (xType === 'quantitative' && yType === 'quantitative' && xField > yField) {
    swapAxes(mutableEncoding);
    return out;
  }
  const mark = mutable.mark;
  if ((mark === 'bar' || mark === 'line' || mark === 'boxplot')
    && xType === 'quantitative' && yType !== 'quantitative') {
    swapAxes(mutableEncoding);
  }
  return out;
}

/**
 * `normalize_chart_order`, including the two things it does besides ordering.
 *
 * A `transform` entry that is not a filter is dropped rather than passed through, and an encoding
 * channel whose value is not an object leaves an empty slot behind — `{}` is assigned before the
 * type test, and the `continue` comes after it. Both are reproduced because both are visible in a
 * comparison: a gold with `{"calculate": ...}` normalises to an empty transform list, and a
 * prediction carrying a string channel normalises to `{}`.
 */
export function normalizeOrder(chart: Chart): Chart {
  const out: Record<string, unknown> = {};
  if ('mark' in chart) out.mark = chart.mark;
  if ('encoding' in chart) {
    const encoding = chart.encoding;
    const normalized: Record<string, unknown> = {};
    if (isRecord(encoding)) {
      for (const channel of CHANNELS) {
        if (!(channel in encoding)) continue;
        const slot: Record<string, unknown> = {};
        normalized[channel] = slot;
        const value = encoding[channel];
        if (!isRecord(value)) continue;
        for (const property of PROPERTIES) {
          if (property in value) slot[property] = value[property];
        }
        for (const key of Object.keys(value)) {
          if (!PROPERTIES.includes(key)) slot[key] = value[key];
        }
      }
      for (const key of Object.keys(encoding)) {
        if (CHANNELS.includes(key)) continue;
        const value = encoding[key];
        if (isRecord(value)) normalized[key] = value;
      }
    }
    out.encoding = normalized;
  }
  if ('transform' in chart) {
    const transforms: Record<string, unknown>[] = [];
    const list = chart.transform;
    if (Array.isArray(list)) {
      for (const transform of list) {
        if (!isRecord(transform) || !('filter' in transform) || !isRecord(transform.filter)) continue;
        const filter: Record<string, unknown> = {};
        for (const operator of OPERATORS) {
          if (operator in transform.filter) filter[operator] = transform.filter[operator];
        }
        for (const key of Object.keys(transform.filter)) {
          if (!OPERATORS.includes(key)) filter[key] = transform.filter[key];
        }
        transforms.push({ filter });
      }
    }
    out.transform = transforms;
  }
  for (const key of Object.keys(chart)) {
    if (key === 'mark' || key === 'encoding' || key === 'transform') continue;
    out[key] = chart[key];
  }
  return out;
}

/** Whether two scalars are `==` in the sense Python means: `True == 1`, `1 == 1.0`. */
function sameScalar(left: unknown, right: unknown): boolean {
  const leftNumber = typeof left === 'boolean' ? Number(left) : left;
  const rightNumber = typeof right === 'boolean' ? Number(right) : right;
  if (typeof leftNumber === 'number' && typeof rightNumber === 'number') {
    return leftNumber === rightNumber;
  }
  // `undefined` is `None` in a language that has one, so a chart that lost a key and a chart whose
  // key is explicitly null are the same chart. Parsed JSON never produces the former; model output
  // round-tripped through JavaScript can.
  const leftMissing = left === null || left === undefined;
  const rightMissing = right === null || right === undefined;
  if (leftMissing || rightMissing) return leftMissing && rightMissing;
  return left === right;
}

/**
 * `deep_compare_charts`: keys unordered and counted, lists unordered and **not consumed**.
 *
 * The last part is the reference's: equal length, then `all(any(...) for x in chart1)`, so
 * `[1, 1]` matches `[1, 2]`. `compareExactly` is the same comparison with the matches consumed.
 */
export function compareCharts(left: unknown, right: unknown): boolean {
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    return leftKeys.every((key) => key in right && compareCharts(left[key], right[key]));
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((item) => right.some((other) => compareCharts(item, other)));
  }
  return sameScalar(left, right);
}

/** The same comparison, with a list matched as a multiset: two `1`s need two partners. */
export function compareExactly(left: unknown, right: unknown): boolean {
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    return leftKeys.every((key) => key in right && compareExactly(left[key], right[key]));
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    const used = new Set<number>();
    for (const item of left) {
      const at = right.findIndex((other, index) => !used.has(index) && compareExactly(item, other));
      if (at === -1) return false;
      used.add(at);
    }
    return true;
  }
  return sameScalar(left, right);
}

/**
 * `preprocess_charts`: canonicalise orientation, then order, keeping non-objects as `null`.
 *
 * A non-object entry becomes `null` rather than being dropped, because the reference appends `None`
 * and the length of the list is part of what precision divides by.
 */
export function preprocess(charts: readonly unknown[], types: FieldTypes): (Chart | null)[] {
  return charts.map((chart) => (isRecord(chart) ? normalizeOrder(reverseAxes(chart, types)) : null));
}

/**
 * `evaluate_metrics`, one k-set for one corpus.
 *
 * A question whose gold list is empty is skipped *and removed from the denominator* — the reference
 * decrements `n_samples` inside the loop, which is the honest reading of "skip": the alternative
 * divides by questions that contributed nothing.
 *
 * The comparison is a parameter so that the reference's (non-consuming) list match and the
 * multiset match run through one implementation. Two copies of this loop would drift, and the
 * distance between the two readings is the thing worth reading.
 */
export function readingOf(cases: readonly Case[], ks: readonly number[] = [1, 3, 5],
  matches: (left: unknown, right: unknown) => boolean = compareCharts): Reading {
  const per = perQuestionOf(cases, ks, matches);
  // Summed from the per-question values in the order the questions were asked, which is the order the
  // single-pass loop summed them in: the aggregate and its own decomposition are the same arithmetic,
  // so a reading can never disagree with the vector a paired test compares. The means are taken
  // positionally because `perQuestionOf` emits exactly one vector per k, in the order asked for — a
  // lookup by key with a fallback would be a branch no input can reach.
  const means = (record: Readonly<Record<string, readonly number[]>>): number[] =>
    Object.values(record).map((vector) => {
      let sum = 0;
      for (const value of vector) sum += value;
      return vector.length === 0 ? 0 : sum / vector.length;
    });
  const byK = (record: Readonly<Record<string, readonly number[]>>): Record<number, number> => {
    const values = means(record);
    return Object.fromEntries(ks.map((k, index) => [k, values[index] as number]));
  };
  return {
    hit: byK(per.hit),
    recall: byK(per.recall),
    precision: byK(per.precision),
    f1: byK(per.f1),
    questions: per.questions,
  };
}

/** One question's four numbers at one k. */
export interface Score {
  readonly hit: number;
  readonly recall: number;
  readonly precision: number;
  readonly f1: number;
}

/**
 * The same metrics, one question at a time.
 *
 * A reading is an average over questions, and an average cannot be compared with another average:
 * the standard error of a difference between two arms is a function of how many questions they
 * disagreed on, not of how far the two means are. So the arm ships the vector as well as the mean —
 * 750 numbers cost nothing and are what makes a paired bootstrap possible (`eval/nvbench2/compare.ts`).
 *
 * The vector is aligned with the questions that were counted: a question whose gold list is empty is
 * skipped in both, so two arms over the same split have vectors of the same length and index `i`
 * means the same question in both.
 */
export function perQuestionOf(cases: readonly Case[], ks: readonly number[] = [1, 3, 5],
  matches: (left: unknown, right: unknown) => boolean = compareCharts): {
  readonly questions: number;
  readonly hit: Readonly<Record<string, readonly number[]>>;
  readonly recall: Readonly<Record<string, readonly number[]>>;
  readonly precision: Readonly<Record<string, readonly number[]>>;
  readonly f1: Readonly<Record<string, readonly number[]>>;
} {
  const vectors = ks.map(() => ({ hit: [] as number[], recall: [] as number[], precision: [] as number[], f1: [] as number[] }));
  let counted = 0;
  for (const item of cases) {
    const predictions = preprocess(item.predictions, item.types);
    const golds = preprocess(item.golds, item.types);
    if (golds.length === 0) continue;
    counted += 1;
    for (const [kIndex, k] of ks.entries()) {
      const vector = vectors[kIndex]!;
      const top = predictions.slice(0, k);
      const matchedGold = new Set<number>();
      const matchedPrediction = new Set<number>();
      let intersection = 0;
      for (const [yIndex, prediction] of top.entries()) {
        for (const [gIndex, gold] of golds.entries()) {
          if (matchedGold.has(gIndex) || matchedPrediction.has(yIndex)) continue;
          if (matches(prediction, gold)) {
            intersection += 1;
            matchedGold.add(gIndex);
            matchedPrediction.add(yIndex);
            break;
          }
        }
      }
      const recallAt = intersection / golds.length;
      const precisionAt = top.length > 0 ? intersection / top.length : 0;
      vector.hit.push(intersection > 0 ? 1 : 0);
      vector.recall.push(recallAt);
      vector.precision.push(precisionAt);
      vector.f1.push(precisionAt + recallAt > 0 ? (2 * (precisionAt * recallAt)) / (precisionAt + recallAt) : 0);
    }
  }
  const byK = (pick: (vector: { hit: number[]; recall: number[]; precision: number[]; f1: number[] }) => number[]):
    Record<string, number[]> => Object.fromEntries(ks.map((k, index) => [String(k), pick(vectors[index]!)]));
  return {
    questions: counted,
    hit: byK((vector) => vector.hit),
    recall: byK((vector) => vector.recall),
    precision: byK((vector) => vector.precision),
    f1: byK((vector) => vector.f1),
  };
}

/**
 * The same reading with matching consumed, reported beside the reference's.
 *
 * The two differ only where a list repeats a value, so the gap counts questions decided by a
 * duplicate — a judging artefact rather than a capability, and therefore stated next to the headline
 * number instead of folded into it.
 */
export function strictReadingOf(cases: readonly Case[], ks: readonly number[] = [1, 3, 5]): Reading {
  return readingOf(cases, ks, compareExactly);
}

/**
 * Canonical JSON: keys sorted, and an integral number written without a fractional part.
 *
 * The last part is not tidiness. `176.0` and `176` are one value in SQLite and two different strings
 * in a digest, and the Python side writes the first while JavaScript writes the second — the exact
 * disagreement that cost the WikiSQL fixture 1,145 questions before it was normalised.
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number' && Number.isInteger(value)) return String(Math.trunc(value));
  if (value === undefined) return 'null';
  return JSON.stringify(value) ?? 'null';
}

/** One string over every preprocessed gold, so two languages can be compared in one line. */
export function digestOf(cases: readonly Case[], hash: Hash = createHash('sha256')): string {
  for (const [index, item] of cases.entries()) {
    hash.update(`${String(index)}\n${canonical(preprocess(item.golds, item.types))}\n`);
  }
  return hash.digest('hex');
}
