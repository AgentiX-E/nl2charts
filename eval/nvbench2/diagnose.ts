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

/**
 * How much of the reply width went to different columns.
 *
 * A set of `k` charts is a budget of `k` guesses, and a guess that repeats a column already used is
 * a guess not made. The reasoning arm spends 2.56 distinct columns per question while the golds use
 * 3.15, so about one entry in seven is such a repeat; that gap is the shape of the `elsewhere` and
 * `misplaced` buckets, seen from the side the model controls. Counted on the same normalised charts
 * the judge scores, so the number cannot describe a different run than the F1 next to it.
 */
export interface Spread {
  /** Questions with a gold and at least one usable prediction. */
  readonly questions: number;
  /** Predictions examined inside those questions. */
  readonly entries: number;
  /** Sum over questions of the distinct columns the golds use. */
  readonly goldColumns: number;
  /** Sum over questions of the distinct columns the predictions name. */
  readonly predictedColumns: number;
  /** Sum over questions of the columns both sides name. */
  readonly coveredColumns: number;
  /** Entries that name a column an earlier entry of the same question already named. */
  readonly repeatedEntries: number;
}

/** Every field a chart names on any channel, once each. */
export function columnsOf(chart: Chart): string[] {
  const encoding = chart['encoding'];
  if (!isRecord(encoding)) return [];
  const columns = new Set<string>();
  for (const slot of Object.values(encoding)) {
    if (!isRecord(slot)) continue;
    const field = slot['field'];
    if (typeof field === 'string') columns.add(field);
    else if (Array.isArray(field)) for (const entry of field) if (typeof entry === 'string') columns.add(entry);
  }
  return [...columns];
}

/**
 * How many distinct columns a reply uses, and how many of its entries repeat one.
 *
 * An entry repeats only when every column it names has already been named by an earlier entry: one
 * that introduces a new column is a new guess even if it shares the measure's column with the rest.
 * An entry with no column never repeats anything — two count charts are two charts, and calling them
 * a duplicate would make the widest arms look wasteful for a reason that is not about coverage.
 */
export function spreadOf(charts: readonly Chart[]): { columns: number; repeated: number } {
  const used = new Set<string>();
  let repeated = 0;
  for (const chart of charts) {
    const columns = columnsOf(chart);
    if (columns.length === 0) continue;
    if (columns.every((column) => used.has(column))) repeated += 1;
    for (const column of columns) used.add(column);
  }
  return { columns: used.size, repeated };
}

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
  /** How much of the reply width went to different columns, over the same questions. */
  readonly spread: Spread;
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
 * The channel the two charts part on, and the column the prediction put there.
 *
 * `field` is `undefined` when the channel names no column — a blank channel, or a count — which is a
 * repair of its own (`absent`) before any column can be looked for. Shared by the repair verdict and
 * the move tally so the two cannot scan the channels in different orders.
 */
function partedOf(candidate: Chart, closest: Chart): { channel: string; field: string | undefined } | undefined {
  const encoding = candidate.encoding;
  if (!isRecord(encoding)) return undefined;
  const channel = Object.keys(encoding)
    .sort()
    .find((name) => fieldAt(candidate, name) !== fieldAt(closest, name));
  return channel === undefined ? undefined : { channel, field: fieldAt(candidate, channel) };
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
  const parted = partedOf(candidate, closest);
  if (parted === undefined) return undefined;
  const field = parted.field;
  if (field === undefined) return 'absent';
  if (!Object.prototype.hasOwnProperty.call(types, field)) return 'offSchema';
  if (golds.some((gold) => gold !== closest && fieldAt(gold, parted.channel) === field)) return 'elsewhere';
  if (golds.some((gold) => slotsOf(gold).some(([, slot]) => slot['field'] === field))) return 'misplaced';
  return 'unused';
}

/** One column the prediction put on a channel and the golds put on another: the move that repairs it. */
export interface Move {
  /** The column both sides use, in the two different places. */
  readonly column: string;
  /** The channel this prediction gave it. */
  readonly from: string;
  /** The channel the golds give it. */
  readonly to: string;
}

/**
 * The `misplaced` verdict with the two channels named, or `undefined` when the miss is not one.
 *
 * `first.field` says the reply named a different column; `fieldRepair` says it was a column the golds
 * do use, somewhere else. Neither says *where* — and where is the whole of the repair: a column moved
 * from `x` to `color` is a chart that should have had two axes and a third encoding, while a column
 * moved from `x` to `y` is the orientation problem `withMirrors` already prices. The two need
 * different sentences in the prompt, so the count of one bucket cannot be the input to a decision.
 *
 * The gold searched is the nearest one, then any other gold of the question: a question whose golds
 * differ only in which column carries the free axis can put a column on a channel the nearest gold
 * does not use, and the move is still the same move.
 *
 * This is the same predicate `fieldRepairOf` returns `misplaced` for, expressed as the move rather
 * than as a name — `test/nvbench2-diagnose.test.ts` holds the two to one answer over every pair of
 * charts it can build, so the tally and the bucket cannot describe different runs.
 */
export function misplacedOf(candidate: Chart, closest: Chart, golds: readonly Chart[]): Move | undefined {
  const parted = partedOf(candidate, closest);
  if (parted === undefined) return undefined;
  const column = parted.field;
  if (column === undefined) return undefined;
  // A column another gold puts on this same channel is a tie-break (`elsewhere`), not a move: the
  // prediction assigned it exactly where a gold does.
  if (golds.some((gold) => gold !== closest && fieldAt(gold, parted.channel) === column)) return undefined;
  for (const gold of [closest, ...golds]) {
    for (const [channel, slot] of slotsOf(gold)) {
      if (slot['field'] !== column || channel === parted.channel) continue;
      return { column, from: parted.channel, to: channel };
    }
  }
  return undefined;
}

/** The same chart with two channels exchanged, which is the repair a `misplaced` miss needs. */
function swapped(candidate: Chart, move: Move): Chart {
  // Both channels exist: `misplacedOf` found the parted one in this encoding and the other one in a
  // gold that agreed with it on the channel set. The cast is that argument, not a hope.
  const encoding = candidate.encoding as Record<string, unknown>;
  const { from, to } = move;
  return { ...candidate, encoding: { ...encoding, [from]: encoding[to], [to]: encoding[from] } };
}

/** One channel pair of the `misplaced` bucket, and how many of its cases one exchange repairs. */
export interface PairCounts {
  /** Predictions that gave this column to `from` where the golds give it to `to`. */
  readonly count: number;
  /** Of those, how many become equal to a gold when `x` and `y` are exchanged. */
  readonly swapped: number;
}

/** How the `misplaced` bucket is built: which channel pair, and what the cheapest repair buys. */
export interface Moves {
  /** Predictions whose column the golds use on another channel — the bucket, counted. */
  readonly misplaced: number;
  /**
   * Of those, how many name one column on two channels — the measure's own column carried as the
   * dimension, or a column the question names reused as the free axis.
   *
   * The two are different repairs from the channel pair: a column put where the golds put it but
   * *also* kept somewhere else is not a transposition of two assignments, it is one assignment too
   * many, and the chart is missing the column the golds use. Counted because the corpus's own
   * construction forbids it in words (`corpus2`: no chart puts one column on two channels) and the
   * bucket says how often that sentence is not enough.
   */
  readonly selfRepeats: number;
  /** Counts keyed `from→to`, so the dominant misplacement is a row rather than an anecdote. */
  readonly pairs: Readonly<Record<string, PairCounts>>;
}

/**
 * Decompose the `misplaced` bucket by where the column went, and price the cheapest repair.
 *
 * `repairBySwap` is a *bound*, not a reading: it says how many misses a model would have got right if
 * it had put the two columns the other way round, and the judge is untouched by it. What it is worth
 * is the decision it makes possible — a bucket that is 90% one channel pair and mostly one exchange
 * away is a prompt rule with a measurable ceiling, and a bucket spread over six pairs is not a rule
 * at all. Costs nothing, because it compares charts the run already paid for.
 */
export function movesOf(cases: readonly Case[], k: number): Moves {
  const pairs: Record<string, PairCounts> = {};
  let misplaced = 0;
  let selfRepeats = 0;
  for (const item of cases) {
    const golds = preprocess(item.golds, item.types).filter((gold): gold is Chart => gold !== null);
    if (golds.length === 0) continue;
    for (const candidate of preprocess(item.predictions, item.types).slice(0, k)) {
      if (candidate === null) continue;
      const closest = nearest(candidate, golds);
      // The bucket is only defined for a miss that parts on the column: a reply that differs first in
      // its mark is a different repair, and the column it names may still agree with the gold.
      if (compareAspects(candidate, closest).first !== 'field') continue;
      const move = misplacedOf(candidate, closest, golds);
      if (move === undefined) continue;
      misplaced += 1;
      if (namesTwice(candidate)) selfRepeats += 1;
      const key = `${move.from}→${move.to}`;
      const at = pairs[key] ?? { count: 0, swapped: 0 };
      // An exchange is the repair for two position channels and a guess anywhere else: swapping `x`
      // with `color` leaves the colour slot holding what belonged on the axis, so a case that happens
      // to match a gold that way is a coincidence rather than a repair worth counting.
      const positions = move.from !== move.to && ['x', 'y'].includes(move.from) && ['x', 'y'].includes(move.to);
      const repaired = positions && golds.some((gold) => canonical(gold) === canonical(swapped(candidate, move)));
      pairs[key] = { count: at.count + 1, swapped: at.swapped + (repaired ? 1 : 0) };
    }
  }
  return { misplaced, selfRepeats, pairs };
}

/**
 * Whether one column is named on two channels, which is one assignment more than the gold makes.
 *
 * No shape guards: a chart that reaches this call carries an encoding of channel objects —
 * `misplacedOf` found a parted channel in it, and `normalizeOrder` leaves an object behind for every
 * channel it keeps. A guard here would be a branch no input can reach, and the count would be the
 * same on every input that can.
 */
function namesTwice(candidate: Chart): boolean {
  const named = Object.values(candidate.encoding as Record<string, unknown>)
    .map((slot) => asSlot(slot)['field'])
    .filter((field): field is string => typeof field === 'string');
  return new Set(named).size < named.length;
}

/** One prediction's verdict, as the counter sees it and as a reader needs to see it. */
export interface Label {
  /** Equal to some gold. */
  readonly equal: boolean;
  /** The group it parted on first, or `null` when it parted nowhere. */
  readonly first: Aspect | null;
  /** Why a `field`-first miss happened, when it was one. */
  readonly repair?: FieldRepair;
}

/**
 * The same verdicts `diagnose` counts, but one per prediction and in order.
 *
 * `diagnose` answers "how many", and a plan needs "which ones": reading twenty charts chosen by hand
 * from a bucket is how an arm gets designed against a case that is not in it. The labels are produced
 * from the same four calls `diagnose` makes, and a test asserts the two agree group by group, so the
 * sample cannot describe a different judgement than the summary beside it.
 *
 * A question with no usable gold has no verdict to give: nothing was scored, so nothing is labelled.
 */
export function labelsOf(item: Case, k: number): Label[] {
  const golds = preprocess(item.golds, item.types).filter((gold): gold is Chart => gold !== null);
  if (golds.length === 0) return [];
  const labels: Label[] = [];
  for (const candidate of preprocess(item.predictions, item.types).slice(0, k)) {
    if (candidate === null) continue;
    const closest = nearest(candidate, golds);
    const comparison = compareAspects(candidate, closest);
    if (comparison.equal) {
      labels.push({ equal: true, first: null });
      continue;
    }
    const repair = comparison.first === 'field' ? fieldRepairOf(candidate, closest, golds, item.types) : undefined;
    labels.push(repair === undefined ? { equal: false, first: comparison.first } : { equal: false, first: comparison.first, repair });
  }
  return labels;
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
  const spread: {
    questions: number; entries: number; goldColumns: number;
    predictedColumns: number; coveredColumns: number; repeatedEntries: number;
  } = { questions: 0, entries: 0, goldColumns: 0, predictedColumns: 0, coveredColumns: 0, repeatedEntries: 0 };
  for (const item of cases) {
    if (item.golds.length === 0) continue;
    const golds = preprocess(item.golds, item.types).filter((gold): gold is Chart => gold !== null);
    if (golds.length === 0) continue;
    const candidates = preprocess(item.predictions, item.types)
      .slice(0, k)
      .filter((candidate): candidate is Chart => candidate !== null);
    if (candidates.length > 0) {
      const goldColumns = new Set(golds.flatMap(columnsOf));
      const predictedColumns = new Set(candidates.flatMap(columnsOf));
      spread.questions += 1;
      spread.entries += candidates.length;
      spread.goldColumns += goldColumns.size;
      spread.predictedColumns += predictedColumns.size;
      spread.coveredColumns += [...predictedColumns].filter((column) => goldColumns.has(column)).length;
      spread.repeatedEntries += spreadOf(candidates).repeated;
    }
    for (const candidate of candidates) {
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
  return { predictions, matched, agree, first, fieldRepair, countFieldless, extraKeys, spread };
}

function emptyCounts(): Record<Aspect, number> {
  return Object.fromEntries(ASPECTS.map((aspect) => [aspect, 0])) as Record<Aspect, number>;
}

function emptyRepairs(): Record<FieldRepair, number> {
  return Object.fromEntries(FIELD_REPAIRS.map((repair) => [repair, 0])) as Record<FieldRepair, number>;
}
