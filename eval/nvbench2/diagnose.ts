/**
 * Where a prediction stops agreeing with the gold it came closest to.
 *
 * A reading says *how many* charts were right and nothing about *why* the rest were not. Two very
 * different harness problems look identical in F1: a prompt that names the wrong column on every
 * chart, and a reply format that carries a key the reference does not expect. Both read as "0%
 * right", and guessing between them from a handful of samples is how a prompt gets rewritten to fix
 * a parsing bug.
 *
 * So the comparison is decomposed into the seven groups of keys `normalizeOrder` actually keeps,
 * **in the order the reference compares them**:
 *
 * | aspect | the keys it covers |
 * | --- | --- |
 * | `mark` | `mark` |
 * | `channels` | which encoding channels exist |
 * | `field` | each channel's `field` |
 * | `aggregate` | each channel's `aggregate` |
 * | `properties` | every other per-channel key — `type`, `bin`, `sort`, `timeUnit` |
 * | `transform` | the filters, after `normalizeOrder` has kept only the ones it keeps |
 * | `rest` | any top-level key besides `mark`, `encoding`, `transform` |
 *
 * The groups partition a normalised chart, so "all seven agree" and "the charts are equal" are the
 * same statement — asserted as an invariant in the tests rather than branched on here. What the
 * groups add is a direction: a run whose misses are all `properties` needs a prompt that stops
 * emitting `type`, and a run whose misses are all `field` needs one that picks better columns.
 *
 * `properties` is separated from `field` because the corpus's golds carry no `type` at all — 6,044
 * channel slots on dev, of which `field` 4,567, `aggregate` 1,890, `bin` 96, `timeUnit` 27, `sort` 19
 * — while every real Vega-Lite specification does. A reply written the way the Vega-Lite docs write
 * one is therefore unequal to a gold that agrees with it in every other respect, and that is a fact
 * about the harness's tolerance rather than about the model's accuracy.
 */
import {
  canonical,
  isRecord,
  preprocess,
  type Case,
  type Chart,
} from './judge.js';

/** The seven groups of keys the reference compares, in its order. */
export const ASPECTS = ['mark', 'channels', 'field', 'aggregate', 'properties', 'transform', 'rest'] as const;

/** One group of keys. */
export type Aspect = (typeof ASPECTS)[number];

/**
 * One prediction against one gold: which groups agree, and either "everything does" or the first
 * group that does not.
 *
 * A union rather than `first: Aspect | null` because the two cases are read differently and the
 * caller should not have to re-derive which one it holds: `diagnose` counts the equal case and the
 * parted case separately, and narrowing is what tells it which it is looking at.
 */
export type Comparison =
  | { readonly equal: true; readonly aspects: Readonly<Record<Aspect, boolean>>; readonly first: null }
  | { readonly equal: false; readonly aspects: Readonly<Record<Aspect, boolean>>; readonly first: Aspect };

/** How a split failed, counted over the charts that were scored. */
export interface Diagnostic {
  /** Predictions examined — the top `k` of every question that has a gold. */
  readonly predictions: number;
  /** How many of those were equal to some gold. */
  readonly matched: number;
  /** Of the unmatched, how many agree with their nearest gold on each group. */
  readonly agree: Readonly<Record<Aspect, number>>;
  /** Of the unmatched, the group each parted on first. */
  readonly first: Readonly<Record<Aspect, number>>;
  /**
   * How many misses are one convention away from a hit: equal to some gold once the `field` of a
   * `count` channel is dropped on both sides.
   *
   * The corpus writes a row count as `{"aggregate": "count"}` — no field — 1,890 of dev's channel
   * slots carry an aggregate and its golds never name a column for a count, because a count counts
   * rows and a row has no column. A reply that says `{"field": "paperid", "aggregate": "count"}`
   * means the same thing and compares unequal, and that is a fact about the corpus's tolerance that
   * only a probe can separate from "the model named the wrong column".
   *
   * It is reported and not applied: the judge is the reference's, the miss stands, and what a probe
   * may do is say what the next prompt should stop writing.
   */
  readonly countFieldless: number;
}

/**
 * A channel's slot, as an object.
 *
 * A narrowing with a proof rather than a fallback: `normalizeOrder` leaves `{}` behind for a channel
 * whose value was not an object, so every slot of a chart that went through it *is* an object. A
 * `?? {}` here would be a branch no input can reach, and a test could only reach it by handing this
 * module an un-normalised chart — which is the one thing its contract forbids.
 */
function asSlot(value: unknown): Readonly<Record<string, unknown>> {
  return value as Readonly<Record<string, unknown>>;
}

/** A chart's encoding, as sorted `[channel, slot]` pairs. */
function slotsOf(chart: Chart): readonly (readonly [string, Readonly<Record<string, unknown>>])[] {
  const encoding = chart.encoding;
  if (!isRecord(encoding)) return [];
  return Object.keys(encoding).sort().map((channel) => [channel, asSlot(encoding[channel])] as const);
}

/** Which channels a chart's encoding carries, in one comparable string. */
function channelsOf(chart: Chart): string {
  return slotsOf(chart).map(([channel]) => channel).join(',');
}

/** One property of every channel, in channel order: `x=paperid,y=mean`. */
function propertyOf(chart: Chart, property: string): string {
  return slotsOf(chart).map(([channel, slot]) => `${channel}=${canonical(slot[property])}`).join(',');
}

/** Every per-channel key the reference does not read as a property of its own. */
function extrasOf(chart: Chart): string {
  return slotsOf(chart)
    .map(([channel, slot]) => {
      const extras = Object.keys(slot)
        .filter((key) => key !== 'field' && key !== 'aggregate')
        .sort()
        .map((key) => `${key}:${canonical(slot[key])}`)
        .join(';');
      return extras.length === 0 ? '' : `${channel}{${extras}}`;
    })
    .filter((entry) => entry.length > 0)
    .join(',');
}

/**
 * The same chart with the `field` of every `count` channel removed — the probe, not a comparison.
 *
 * Applied to a normalised chart and compared through `canonical`, so a prediction that differs from
 * a gold only by naming a column on a count reads as equal here and unequal in the reading.
 */
export function withoutCountFields(chart: Chart): Chart {
  const encoding = chart.encoding;
  if (!isRecord(encoding)) return chart;
  const stripped: Record<string, unknown> = {};
  for (const key of Object.keys(encoding)) {
    const slot = asSlot(encoding[key]);
    if (slot.aggregate !== 'count' || !('field' in slot)) {
      stripped[key] = slot;
      continue;
    }
    const rest: Record<string, unknown> = {};
    for (const property of Object.keys(slot)) if (property !== 'field') rest[property] = slot[property];
    stripped[key] = rest;
  }
  return { ...chart, encoding: stripped };
}

/** Top-level keys other than the three the reference reads first. */
function restOf(chart: Chart): string {
  return Object.keys(chart)
    .filter((key) => key !== 'mark' && key !== 'encoding' && key !== 'transform')
    .sort()
    .map((key) => `${key}:${canonical(chart[key])}`)
    .join(',');
}

/**
 * Two normalised charts, compared group by group.
 *
 * Both arguments must already be normalised by `normalizeOrder` — this function reads the shapes
 * that pass produces and would compare a raw chart's `encoding` keys in the wrong vocabulary.
 */
export function compareAspects(prediction: Chart, gold: Chart): Comparison {
  const aspects: Record<Aspect, boolean> = {
    mark: canonical(prediction.mark) === canonical(gold.mark),
    channels: channelsOf(prediction) === channelsOf(gold),
    field: propertyOf(prediction, 'field') === propertyOf(gold, 'field'),
    aggregate: propertyOf(prediction, 'aggregate') === propertyOf(gold, 'aggregate'),
    properties: extrasOf(prediction) === extrasOf(gold),
    transform: canonical(prediction.transform) === canonical(gold.transform),
    rest: restOf(prediction) === restOf(gold),
  };
  const parted = ASPECTS.find((aspect) => !aspects[aspect]);
  return parted === undefined
    ? { equal: true, aspects, first: null }
    : { equal: false, aspects, first: parted };
}

/** The gold `prediction` agrees with on the most groups, taken as the first such gold. */
export function nearest(prediction: Chart, golds: readonly Chart[]): Chart {
  let best = golds[0] as Chart;
  let bestScore = -1;
  for (const gold of golds) {
    const { aspects } = compareAspects(prediction, gold);
    const score = ASPECTS.filter((aspect) => aspects[aspect]).length;
    if (score > bestScore) {
      best = gold;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Decompose a split's misses.
 *
 * `k` is passed rather than the whole prediction list because a reading is taken over the top `k`:
 * a chart ranked fourth contributed to no metric, and counting it would describe a run nobody ran.
 * Questions with no gold are skipped exactly as `readingOf` skips them.
 */
export function diagnose(cases: readonly Case[], k: number): Diagnostic {
  const agree = emptyCounts();
  const first = emptyCounts();
  let predictions = 0;
  let matched = 0;
  let countFieldless = 0;
  for (const item of cases) {
    if (item.golds.length === 0) continue;
    const golds = preprocess(item.golds, item.types).filter((gold): gold is Chart => gold !== null);
    if (golds.length === 0) continue;
    for (const candidate of preprocess(item.predictions, item.types).slice(0, k)) {
      if (candidate === null) continue;
      predictions += 1;
      const comparison = compareAspects(candidate, nearest(candidate, golds));
      if (comparison.equal) {
        matched += 1;
        continue;
      }
      for (const aspect of ASPECTS) if (comparison.aspects[aspect]) agree[aspect] += 1;
      first[comparison.first] += 1;
      const stripped = canonical(withoutCountFields(candidate));
      if (golds.some((gold) => canonical(withoutCountFields(gold)) === stripped)) countFieldless += 1;
    }
  }
  return { predictions, matched, agree, first, countFieldless };
}

function emptyCounts(): Record<Aspect, number> {
  return Object.fromEntries(ASPECTS.map((aspect) => [aspect, 0])) as Record<Aspect, number>;
}
