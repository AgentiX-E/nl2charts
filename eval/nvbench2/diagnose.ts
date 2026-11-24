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

/** The four repairable causes of a `field`-first miss, plus the one that is a missing answer. */
export const FIELD_REPAIRS = ['elsewhere', 'misplaced', 'unused', 'offSchema', 'absent'] as const;

/** One cause of a `field`-first miss. */
export type FieldRepair = (typeof FIELD_REPAIRS)[number];

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
   * Of the misses that part on `field`, what the closest repair is.
   *
   * `first.field` is the size of a face, not of a job: 465 of the shipped reasoning arm's 1,518
   * scored predictions stop agreeing at the column, and four different causes hide behind that one
   * count. A prediction whose column another gold of the same question puts on the same channel is
   * a tie-break problem (`elsewhere`) — one more chart or a better ranking fixes it. A column the
   * gold uses on a different channel is a `misplaced` assignment. A column the table has and no gold
   * uses is `unused`, the semantic gap a prompt has not moved. A column the table does not have is
   * `offSchema`, a hallucination rather than a choice. A channel the prediction leaves blank while
   * the gold names one is `absent`.
   *
   * The distinction is the whole of the next decision: `elsewhere` and `misplaced` are repairable by
   * the same machinery that already exists, `unused` is not repairable by a prompt at all (three
   * prompt changes moved `first.field` from 794 to 800 while `channels` fell 482 to 414), and
   * `offSchema` is a schema-linking bug with a cheap fix. Reported per miss and never applied.
   */
  readonly fieldRepair: Readonly<Record<FieldRepair, number>>;
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
  /**
   * The per-channel keys that a miss carries and its nearest gold does not, counted by name.
   *
   * `first.properties` says *that* the two charts differ on a key the reference reads as a property;
   * it does not say which key, and "which key" is the whole of the next action. The first arm that
   * sent the corpus's own short prompt read 3.27 F1@3 with 25% of its misses parting on `properties`,
   * and finding out that the key was `type` — a field Vega-Lite infers from the column and the gold
   * never writes — took a dispatched sample of twenty replies. This counter is what makes that a
   * field in the artifact instead of an investigation.
   *
   * Counted per miss rather than per slot: a chart that writes `type` on three channels is one miss
   * with one cause.
   */
  readonly extraKeys: Readonly<Record<string, number>>;
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

/**
 * The per-channel keys a prediction carries and a gold does not.
 *
 * A key the *gold* has and the prediction does not is not reported: it is an omission, and the
 * counter exists to name what a prompt told the model to write rather than what it forgot.
 */
function extraKeysOf(prediction: Chart, gold: Chart): readonly string[] {
  const goldKeys = new Set(slotsOf(gold).flatMap(([, slot]) => Object.keys(slot)));
  const out = new Set<string>();
  for (const [, slot] of slotsOf(prediction)) {
    for (const key of Object.keys(slot)) if (!goldKeys.has(key)) out.add(key);
  }
  return [...out].sort();
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
 * The column one channel names, or `undefined` when the channel names none.
 *
 * A channel may be absent, may hold a non-object (which `normalizeOrder` leaves as `{}`), or may
 * hold an object with no `field` — a count, or a half-written reply. All three mean "this channel
 * names no column", and `first.field` compares them through the same string, so the repair counter
 * has to see them the same way.
 */
function fieldAt(chart: Chart, channel: string): string | undefined {
  const encoding = chart.encoding;
  if (!isRecord(encoding)) return undefined;
  const slot = encoding[channel];
  if (!isRecord(slot)) return undefined;
  const field = slot['field'];
  return typeof field === 'string' ? field : undefined;
}

/**
 * Why two charts that both name columns part on `field`, as the cheapest thing that would repair it.
 *
 * Returns `undefined` when they agree on every channel's column — the caller only asks after
 * `compareAspects` has said `field` parted, so that answer is unreachable in a run and is still a
 * value rather than a throw: a branch no input can reach is a branch a test cannot hold, and the
 * alternative is asserting an invariant this function does not own.
 *
 * The order of the tests is the order of certainty. A blank channel is not a choice. A column the
 * table does not have is not a choice either. After those two, a column that another gold of the
 * same question uses on the same channel is the corpus's own multi-answer structure showing
 * through, and a column some gold uses on another channel is an assignment error. Everything left
 * is a column no gold uses, and that is the only bucket a prompt could ever be blamed for.
 */
export function fieldRepairOf(
  candidate: Chart,
  closest: Chart,
  golds: readonly Chart[],
  types: Readonly<Record<string, unknown>>,
): FieldRepair | undefined {
  const encoding = candidate.encoding;
  if (!isRecord(encoding)) return undefined;
  const parted = Object.keys(encoding)
    .sort()
    .find((channel) => fieldAt(candidate, channel) !== fieldAt(closest, channel));
  if (parted === undefined) return undefined;
  const field = fieldAt(candidate, parted);
  if (field === undefined) return 'absent';
  if (!Object.prototype.hasOwnProperty.call(types, field)) return 'offSchema';
  if (golds.some((gold) => gold !== closest && fieldAt(gold, parted) === field)) return 'elsewhere';
  if (golds.some((gold) => slotsOf(gold).some(([, slot]) => slot['field'] === field))) return 'misplaced';
  return 'unused';
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
  const fieldRepair = emptyRepairs();
  const extraKeys: Record<string, number> = {};
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
      const closest = nearest(candidate, golds);
      const comparison = compareAspects(candidate, closest);
      if (comparison.equal) {
        matched += 1;
        continue;
      }
      for (const aspect of ASPECTS) if (comparison.aspects[aspect]) agree[aspect] += 1;
      first[comparison.first] += 1;
      if (comparison.first === 'field') {
        const repair = fieldRepairOf(candidate, closest, golds, item.types);
        if (repair !== undefined) fieldRepair[repair] += 1;
      }
      if (comparison.first === 'properties') {
        for (const key of extraKeysOf(candidate, closest)) extraKeys[key] = (extraKeys[key] ?? 0) + 1;
      }
      const stripped = canonical(withoutCountFields(candidate));
      if (golds.some((gold) => canonical(withoutCountFields(gold)) === stripped)) countFieldless += 1;
    }
  }
  return { predictions, matched, agree, first, fieldRepair, countFieldless, extraKeys };
}

function emptyCounts(): Record<Aspect, number> {
  return Object.fromEntries(ASPECTS.map((aspect) => [aspect, 0])) as Record<Aspect, number>;
}

function emptyRepairs(): Record<FieldRepair, number> {
  return Object.fromEntries(FIELD_REPAIRS.map((repair) => [repair, 0])) as Record<FieldRepair, number>;
}
