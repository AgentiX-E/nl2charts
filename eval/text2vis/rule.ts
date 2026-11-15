import { CHART_CUES, readCues, type CueKind, type CueRule, type RecommendableMark } from '@agentix-e/nl2charts-chart';
import type { ChartType } from '@agentix-e/nl2charts-spec';
import { applyExitCode, isEntry, loadText2Vis, type LoadOptions, type Text2VisRow } from './dataset.js';

/**
 * The chart the cue table would pick, measured against the one the corpus says is right.
 *
 * This is the only external reading this project has on the *chart* half of the product, and it is
 * deliberately the narrowest one that is still a measurement: the corpus states a question and the
 * chart type its authors judged correct, so the question's cues can be scored against that label
 * without a model, without the corpus's tables and without a renderer. What that buys is a number
 * for the component this repository ships (the cue table in `@agentix-e/nl2charts-chart`) and what
 * it costs is stated below rather than implied.
 *
 * Three things this does **not** measure, in the order they would mislead:
 *
 * 1. **Encoding.** Whether the right mark is drawn with the right fields and aggregate is a
 *    different question, and it needs the tables Text2Vis keeps outside this CSV.
 * 2. **The recommender.** `recommendChart` decides a mark from cues *and* the result set's shape.
 *    With no result set only the cue half can run, so the reading below is an upper bound on what
 *    that half contributes and not a score for the recommender as a whole.
 * 3. **Anything the corpus disagrees with internally.** A label is one judgement by one annotator.
 *
 * The unit is a **family** rather than a label, because the corpus and this repository do not share
 * a vocabulary: the corpus writes `Bar Chart`, the contract writes `bar`. A family is what both are
 * talking about. A label this build has no family for is counted as unmapped and **excluded from
 * the score**, and the exclusion is published with the labels it dropped -- a reading that silently
 * scores the rows it understood reports the share of the corpus it is easy on.
 */

/**
 * The mark families a label can mean.
 *
 * `area` and `histogram` are here and not in `RecommendableMark` because they are real labels in
 * the corpus that this repository does not choose between: an area chart is a filled line, and a
 * histogram is a bar of binned values. Mapping them *onto* a product mark would decide in advance
 * that a question asking for a histogram is satisfied by a bar, which is a claim the confusion
 * table below should be allowed to falsify rather than assume.
 */
export type ChartFamily = RecommendableMark | 'area' | 'histogram' | 'violin';

/**
 * A label, as a family.
 *
 * Ordered because the first match wins and some labels contain others: `Scatter Plot` must not be
 * read as `plot`, and `Box Plot` must not be read as `plot` either -- which is why the patterns
 * anchor on the noun the label is about rather than on any word in it.
 */
const LABEL_FAMILIES: readonly (readonly [RegExp, ChartFamily])[] = [
  [/\bhistogram\b/, 'histogram'],
  [/\bviolin\b/, 'violin'],
  [/\bbox\s*(?:plot|chart)?\b/, 'boxplot'],
  [/\bcandlestick\b/, 'candlestick'],
  [/\bradar\b/, 'radar'],
  [/\bheat\s*map\b/, 'heatmap'],
  [/\bfunnel\b/, 'funnel'],
  [/\bgauge\b/, 'gauge'],
  [/\bparallel\b/, 'parallel'],
  [/\bscatter\b|\bbubble\b/, 'scatter'],
  [/\bpie\b|\bdonut\b|\bdoughnut\b/, 'pie'],
  [/\barea\b/, 'area'],
  // `Barh` is the corpus's horizontal bar and is the same decision as a bar with the axes swapped,
  // which the contract expresses through the encoding rather than through a second mark. It is in
  // this table because the first real reading of the corpus found 516 rows whose label this build
  // could not name, and a label that is *this* unambiguous should not be one of them.
  [/\bbar\b|\bbarh\b|\bcolumn\b/, 'bar'],
  [/\bline\b/, 'line'],
];

/**
 * The family a corpus label names, or `undefined` when this build has no family for it.
 *
 * `undefined` is the honest answer for a label nobody anticipated (`Waterfall`, `Treemap`): the
 * alternative is a fallback that folds it into `bar` and turns an unmeasured label into a hit for
 * whatever the rule happened to say.
 */
export function familyOfLabel(label: string): ChartFamily | undefined {
  const text = label.toLowerCase().replace(/[_-]+/g, ' ').trim();
  for (const [pattern, family] of LABEL_FAMILIES) {
    if (pattern.test(text)) return family;
  }
  return undefined;
}

/**
 * The families a product mark can stand in for.
 *
 * One entry per mark, and two widenings that are argued rather than convenient: a line covers an
 * area because an area chart is that line filled, and a bar covers a histogram because a histogram
 * is that bar's shape with the measure binned.
 *
 * The histogram widening is **conditional on the cue that produced the mark**, and the condition is
 * the whole reason it is honest. The first reading of this corpus reported "a bar does not answer
 * for a histogram" as a fact about the table — 90 histogram rows, 0.00%, answered `boxplot` — and
 * the fix is a cue that *names* the intent, not a blanket claim that every bar is a histogram. So
 * the widening lives in `familiesOfMark` below and only fires when the leading cue is `histogram`:
 * a bar recommended for a ranking question still answers for `bar` and nothing else.
 */
const MARK_FAMILIES: Readonly<Record<RecommendableMark, readonly ChartFamily[]>> = {
  bar: ['bar'],
  line: ['line', 'area'],
  pie: ['pie'],
  scatter: ['scatter'],
  boxplot: ['boxplot'],
  heatmap: ['heatmap'],
  funnel: ['funnel'],
  candlestick: ['candlestick'],
  radar: ['radar'],
  parallel: ['parallel'],
  gauge: ['gauge'],
};

/**
 * The families a mark is allowed to answer for, given the cue that named it.
 *
 * `cue` is optional because most callers are asking a question about the mark alone ("does a line
 * cover an area"), and the one widening that is not a property of the mark needs the cue to be
 * stated. A caller that omits it gets the unconditional table, which is the conservative answer.
 */
export function familiesOfMark(mark: RecommendableMark, cue?: CueKind): readonly ChartFamily[] {
  const base = MARK_FAMILIES[mark];
  return mark === 'bar' && cue === 'histogram' ? [...base, 'histogram'] : base;
}

/** One question and the chart the corpus says is right. */
export interface RuleInput {
  readonly prompt: string;
  readonly label: string;
}

/**
 * The cue table's answer for one question: every mark it would offer, best first, with the cue that
 * named it.
 *
 * The order is the cue table's own -- cues are listed strongest first and the first mark of the
 * first cue leads -- because a second ordering here would be a second opinion about the same table,
 * and the two would drift apart silently. The cue travels with the mark because one family claim is
 * conditional on it: `bar` answers for `histogram` only when a `histogram` cue put it there, and a
 * scorer that kept only the mark could not tell that bar from the one a ranking question asked for.
 */
export function cueAnswer(
  question: string,
  table?: readonly CueRule[],
): readonly { readonly mark: RecommendableMark; readonly cue: CueKind }[] {
  const answers: { mark: RecommendableMark; cue: CueKind }[] = [];
  for (const cue of readCues(question, table)) {
    for (const mark of cue.marks) {
      // The cue table types its marks as contract `ChartType`, which is wider than what this layer
      // chooses between; a cue naming a type this layer does not recommend is not a recommendation.
      if (isRecommendable(mark) && !answers.some((answer) => answer.mark === mark)) answers.push({ mark, cue: cue.kind });
    }
  }
  return answers;
}

/** The marks alone, in the same order. */
export function cueMarks(question: string, table?: readonly CueRule[]): readonly RecommendableMark[] {
  return cueAnswer(question, table).map((answer) => answer.mark);
}

/**
 * One cue, scored by the rows it decided.
 *
 * The report above scores the *table*: a top-1 share over the corpus. That number cannot say which
 * phrase is wrong, because it is an average over twelve rules and the corpus's whole weight sits on
 * three of them. This reading is per cue, and it is read on the only population where a cue is
 * answerable: the rows where it fired **first**, since a cue that fired second never decided anything.
 *
 * Two counts, because a cue can be wrong in two different ways and they are repaired in different
 * files. `hits` is the rows where the cue's first mark covers the label — the cue named the right
 * picture. `inside` is the rows where *any* of its marks covers the label — the cue identified the
 * right family but put another mark first, which is a `marks` ordering defect and not a phrase
 * defect. The gap between `inside` and `hits` is therefore a lever that costs nothing but a reorder,
 * and the gap between `leads` and `inside` is what a narrower pattern could only ever buy back.
 *
 * Rows no cue fired on are not here at all: they are `RuleReport.declined`, and a cue cannot be
 * scored on a question it did not read.
 *
 * **What this reading is not.** It scores the cue that fired *first*, and the product does not rank
 * that way: `recommendChart` counts how many cues name a mark *first* and weighs each cue's own mark
 * order, so the order of the cue table is invisible to it. The gap was measured rather than argued —
 * a table that only moves `ranking` in front of `share` scores **+39 here and 0 on the product**, to
 * the row — and `packages/chart/test/recommend.test.ts` holds the assertion. So a reorder is a repair
 * this reading can see and no caller can; a repair worth shipping has to be argued on both, and the
 * two files are deliberately one directory apart.
 */
export interface CueReading {
  readonly kind: CueKind;
  /** The mark this cue puts first, which is the claim being scored. */
  readonly first: RecommendableMark | undefined;
  /** Rows where this cue was the first cue to fire. */
  readonly leads: number;
  /** Of those, rows whose label family is this cue's first mark. */
  readonly hits: number;
  /** Of those, rows whose label family is any mark this cue speaks for. */
  readonly inside: number;
  /** `hits / leads`: named the right picture. */
  readonly precision: number;
  /** `inside / leads`: named the right family, possibly in the wrong position. */
  readonly coverage: number;
}

/**
 * Score every cue by the rows it decided.
 *
 * Ordered by `leads` descending, and that order is the point: the cue that decides the most rows is
 * the one worth repairing first, and a table sorted by precision would put a cue that fired twice at
 * the top. Same argument as the unmapped-label list — a reader should be able to act in reading order.
 *
 * A cue whose only marks are types this layer does not recommend has `first: undefined` and cannot
 * hit: it is reported rather than dropped, because a cue that speaks for nothing is a finding.
 */
export function cuePrecision(rows: readonly RuleInput[], table: readonly CueRule[] = CHART_CUES): readonly CueReading[] {
  const tallies = new Map<CueKind, { first: RecommendableMark | undefined; leads: number; hits: number; inside: number }>();
  for (const row of rows) {
    const family = familyOfLabel(row.label);
    // An unmapped label is outside every denominator in this file, at every level: it is a family
    // this build cannot name, so neither a cue nor the table can be right or wrong about it.
    if (family === undefined) continue;
    const lead = readCues(row.prompt, table)[0];
    if (lead === undefined) continue;
    const first = lead.marks.find((mark) => isRecommendable(mark));
    const entry = tallies.get(lead.kind) ?? { first, leads: 0, hits: 0, inside: 0 };
    entry.leads += 1;
    if (first !== undefined && familiesOfMark(first, lead.kind).includes(family)) entry.hits += 1;
    if (lead.marks.some((mark) => isRecommendable(mark) && familiesOfMark(mark, lead.kind).includes(family))) entry.inside += 1;
    tallies.set(lead.kind, entry);
  }
  return [...tallies.entries()]
    .map(([kind, entry]) => ({
      kind,
      first: entry.first,
      leads: entry.leads,
      hits: entry.hits,
      inside: entry.inside,
      // No guard for `leads === 0`: an entry exists only because a row incremented it, so the
      // denominator is at least one by construction and a branch for it would be one no input can
      // reach — a branch whose only caller is a coverage report.
      precision: entry.hits / entry.leads,
      coverage: entry.inside / entry.leads,
    }))
    .sort((left, right) => right.leads - left.leads || left.kind.localeCompare(right.kind));
}

function isRecommendable(mark: string): mark is RecommendableMark {
  return mark in MARK_FAMILIES;
}

/**
 * What a cue's wrong-order rows have in common, which is the only evidence a reorder has.
 *
 * The gap between `inside` and `hits` in the reading above says *how many* rows a cue got the family
 * right and the order wrong. It cannot say *which* row to move, because the repair is not in the cue
 * being read — it is in the cue that fired beside it. `share` leading with a pie is wrong exactly on
 * the rows where the question also ranked, and `ranking` sits after `share` in the shipped table, so
 * it never gets to lead. That is a fact about the broken rows, not about the cue table, and it has to
 * be counted on the broken rows.
 *
 * So this reading splits a cue's covered rows in two and counts the companions separately in each
 * half. The split is what makes it evidence: a companion that fires on both halves is a cue that
 * fires often, and a companion that fires only on the broken half is the one to move — which is why
 * `hitWithCue` is published beside `withCue` rather than left out as uninteresting.
 *
 * A row whose family the cue did not cover at all is outside this reading: its loss is a phrase and
 * not an order, and a companion counted there would recommend a move that cannot fix it.
 */
export interface CueCrossing {
  readonly kind: CueKind;
  /** Rows this cue led where its first mark was the right family. */
  readonly hits: number;
  /** Rows this cue led where a later mark was the right family: the loss a reorder could recover. */
  readonly ordered: number;
  /** Other cues that fired on the wrong-order rows, most frequent first. */
  readonly withCue: readonly { readonly kind: CueKind; readonly n: number }[];
  /** The same count over the rows it got right, which is the control the comparison needs. */
  readonly hitWithCue: readonly { readonly kind: CueKind; readonly n: number }[];
}

/**
 * Every cue, with the companions its wrong-order rows keep.
 *
 * Ordered by `ordered` descending — the cue with the most recoverable rows leads the repair list —
 * and not by `withCue`: the question this answers is "which cue to fix", and the companion is the
 * answer to "with what". A tie is broken by name rather than by table order, because a reading that
 * moves when the table is reordered is a reading about the list.
 */
export function cueCrossings(rows: readonly RuleInput[], table: readonly CueRule[] = CHART_CUES): readonly CueCrossing[] {
  const tallies = new Map<
    CueKind,
    {
      hits: number;
      ordered: number;
      withCue: Map<CueKind, number>;
      hitWithCue: Map<CueKind, number>;
    }
  >();
  for (const row of rows) {
    const family = familyOfLabel(row.label);
    if (family === undefined) continue;
    const cues = readCues(row.prompt, table);
    const lead = cues[0];
    if (lead === undefined) continue;
    const first = lead.marks.find((mark) => isRecommendable(mark));
    const covered = lead.marks.some((mark) => isRecommendable(mark) && familiesOfMark(mark, lead.kind).includes(family));
    if (!covered) continue;
    const hit = first !== undefined && familiesOfMark(first, lead.kind).includes(family);
    const entry = tallies.get(lead.kind) ?? { hits: 0, ordered: 0, withCue: new Map(), hitWithCue: new Map() };
    // The companion list is `cues.slice(1)`: a cue is not its own companion, and the lead is already
    // named by the row it is counted in.
    const companions = hit ? entry.hitWithCue : entry.withCue;
    if (hit) entry.hits += 1;
    else entry.ordered += 1;
    for (const cue of cues.slice(1)) companions.set(cue.kind, (companions.get(cue.kind) ?? 0) + 1);
    tallies.set(lead.kind, entry);
  }
  const listed = (counts: Map<CueKind, number>): readonly { readonly kind: CueKind; readonly n: number }[] =>
    [...counts.entries()]
      .map(([kind, n]) => ({ kind, n }))
      .sort((left, right) => right.n - left.n || left.kind.localeCompare(right.kind));
  return [...tallies.entries()]
    .map(([kind, entry]) => ({
      kind,
      hits: entry.hits,
      ordered: entry.ordered,
      withCue: listed(entry.withCue),
      hitWithCue: listed(entry.hitWithCue),
    }))
    .sort((left, right) => right.ordered - left.ordered || left.kind.localeCompare(right.kind));
}

export interface LabelReading {
  readonly label: string;
  readonly family: ChartFamily;
  /** Rows carrying this label in the scored population. */
  readonly n: number;
  readonly top1: number;
  readonly shortlist: number;
  /** What the rule answered for these rows, most frequent first. */
  readonly answered: readonly { readonly mark: RecommendableMark | 'declined'; readonly n: number }[];
}

export interface RuleReport {
  readonly rows: number;
  /**
   * Labels this build has no family for, each with the rows it accounts for.
   *
   * The count and the list were two facts with no bridge between them, so the first real reading
   * could say "516 rows are unmapped" and name eight labels without saying which one to fix first.
   * Ordered by size, because that is the order a reader should act in.
   */
  readonly unmapped: { readonly count: number; readonly labels: readonly { readonly label: string; readonly n: number }[] };
  /** Rows the score is computed on: the rows whose label has a family. */
  readonly scored: number;
  readonly top1: number;
  readonly top1Share: number;
  readonly shortlist: number;
  readonly shortlistShare: number;
  /** Questions the cue table says nothing about. A miss by construction, counted separately. */
  readonly declined: number;
  /**
   * The two bars any share has to clear.
   *
   * Without them a top-1 share is a number about nothing: a corpus that is 60% bar charts gives
   * 60% to a rule that always answers bar. `mostFrequent` is the best constant answer on the same
   * rows, so it is the strongest baseline a constant can reach, and `bar` is the one a product with
   * no cue table would ship.
   */
  readonly baseline: { readonly mostFrequent: ChartFamily; readonly share: number; readonly bar: number };
  readonly perLabel: readonly LabelReading[];
  /** `expected -> answered`, rows where the rule produced a mark, most frequent first. */
  readonly confusion: readonly { readonly expected: ChartFamily; readonly answered: RecommendableMark; readonly n: number }[];
  /**
   * Each cue scored by the rows it decided.
   *
   * A top-1 share is an average over every rule in the table and the corpus's weight sits on three of
   * them, so it can name a number and not a phrase. This is the per-phrase version of the same
   * measurement, on the same population minus the rows no cue fired on.
   */
  readonly cues: readonly CueReading[];
  /**
   * What each cue's wrong-order rows have in common.
   *
   * The reading above counts the rows a cue got the family right and the order wrong; this one names
   * the cue that fired beside them, split by whether the row was broken. It is a second view of the
   * same rows and is asserted against `cues` rather than trusted, because two views that can drift
   * are two definitions of "got it right".
   */
  readonly crossings: readonly CueCrossing[];
  /** Milliseconds per question on the cue path: no model, no renderer, no database. */
  readonly latency: { readonly p50: number; readonly p95: number; readonly max: number };
  /** Which cue table this report scored. `shipped` is the one the package exports. */
  readonly variant: string;
  /**
   * The same corpus, scored against every other table this build can construct.
   *
   * Scoring is free — a fifth of a millisecond per question, no model, no query — so the choice
   * between two orderings is a reading rather than an argument. One run prices all of them, and the
   * criterion a candidate has to clear (top-1, and the per-family rows that must not fall) is read
   * off `byFamily` instead of being asserted in a commit message.
   */
  readonly sweep: readonly VariantReading[];
}

/** One cue table's reading on the same corpus. */
export interface VariantReading {
  readonly variant: string;
  /** What this table changes, in one line, so the sweep is read without the source. */
  readonly note: string;
  readonly scored: number;
  readonly top1: number;
  readonly top1Share: number;
  readonly shortlist: number;
  readonly shortlistShare: number;
  /**
   * Rows this table answered with nothing.
   *
   * Carried per variant rather than read off the report, because it is the one number a cue change
   * moves without moving `scored`: removing a cue declines every question that cue was the only
   * answer to. The first run of the per-cue assertion compared a variant's lead counts against the
   * *shipped* table's declined count and refused a legal reading of 1,260 leads against 1,470 rows —
   * the denominator of one arm used to check another, which is the defect the assertion exists to
   * catch and not one it may commit.
   */
  readonly declined: number;
  /** Top-1 hits per labelled family. A family with a smaller `n` than the shipped run has left the population. */
  readonly byFamily: readonly { readonly family: ChartFamily; readonly n: number; readonly top1: number }[];
  /**
   * The same per-cue scoring as `RuleReport.cues`, for this table.
   *
   * Carried because the question a candidate raises is not only "did the total move" but "did the cue
   * I changed get better, or did it get worse while another cue paid for it". Both can be true of a
   * table that gains a row.
   */
  readonly cues: readonly CueReading[];
}

/**
 * Price the cue table against the corpus.
 *
 * The arithmetic identity is the instrument: `top1 + shortlistMisses + declined === scored`, and
 * every per-label `n` sums to `scored`. A report that breaks it is refused by
 * `assertRuleReport`, because a share computed on the wrong denominator is exactly the defect a
 * reader cannot see.
 */
export function scoreRule(
  rows: readonly RuleInput[],
  options: { readonly clock?: () => number; readonly cues?: readonly CueRule[]; readonly variant?: string } = {},
): RuleReport {
  const clock = options.clock ?? ((): number => performance.now());
  const unmappedLabels = new Map<string, number>();
  const perLabel = new Map<string, { family: ChartFamily; n: number; top1: number; shortlist: number; answered: Map<RecommendableMark | 'declined', number> }>();
  const confusion = new Map<string, { expected: ChartFamily; answered: RecommendableMark; n: number }>();
  const durations: number[] = [];
  let scored = 0;
  let top1 = 0;
  let shortlist = 0;
  let declined = 0;
  let unmapped = 0;

  for (const row of rows) {
    const started = clock();
    const answers = cueAnswer(row.prompt, options.cues);
    durations.push(clock() - started);

    const family = familyOfLabel(row.label);
    if (family === undefined) {
      unmapped += 1;
      unmappedLabels.set(row.label, (unmappedLabels.get(row.label) ?? 0) + 1);
      continue;
    }
    scored += 1;
    const entry = perLabel.get(row.label) ?? { family, n: 0, top1: 0, shortlist: 0, answered: new Map() };
    entry.n += 1;

    const first = answers[0];
    entry.answered.set(first?.mark ?? 'declined', (entry.answered.get(first?.mark ?? 'declined') ?? 0) + 1);
    if (first === undefined) {
      declined += 1;
      perLabel.set(row.label, entry);
      continue;
    }
    const covered = new Set(answers.flatMap((answer) => familiesOfMark(answer.mark, answer.cue)));
    if (covered.has(family)) {
      shortlist += 1;
      entry.shortlist += 1;
    }
    if (familiesOfMark(first.mark, first.cue).includes(family)) {
      top1 += 1;
      entry.top1 += 1;
    }
    const key = `${family} -> ${first.mark}`;
    const cell = confusion.get(key) ?? { expected: family, answered: first.mark, n: 0 };
    cell.n += 1;
    confusion.set(key, cell);
    perLabel.set(row.label, entry);
  }

  const families = new Map<ChartFamily, number>();
  for (const entry of perLabel.values()) families.set(entry.family, (families.get(entry.family) ?? 0) + entry.n);
  // A tie is broken by name rather than by insertion order, so two runs over the same corpus
  // report the same baseline: the alternative is a number that depends on which label the file
  // happened to list first.
  const ranked = [...families.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const mostFrequent = ranked[0];

  return {
    rows: rows.length,
    unmapped: {
      count: unmapped,
      labels: [...unmappedLabels.entries()]
        .map(([label, n]) => ({ label, n }))
        .sort((left, right) => right.n - left.n || left.label.localeCompare(right.label)),
    },
    scored,
    top1,
    top1Share: scored === 0 ? 0 : top1 / scored,
    shortlist,
    shortlistShare: scored === 0 ? 0 : shortlist / scored,
    declined,
    // One guard for the whole block: with no scored row there is no family to name, and the three
    // numbers a reader compares against are all zero. Written as a branch rather than as three
    // `?? 0` fallbacks because those are unreachable once `scored > 0`.
    baseline:
      mostFrequent === undefined
        ? { mostFrequent: 'bar' as ChartFamily, share: 0, bar: 0 }
        : { mostFrequent: mostFrequent[0], share: mostFrequent[1] / scored, bar: (families.get('bar') ?? 0) / scored },
    perLabel: [...perLabel.entries()]
      .map(([label, entry]) => ({
        label,
        family: entry.family,
        n: entry.n,
        top1: entry.top1,
        shortlist: entry.shortlist,
        answered: [...entry.answered.entries()]
          .map(([mark, n]) => ({ mark, n }))
          .sort((left, right) => right.n - left.n || String(left.mark).localeCompare(String(right.mark))),
      }))
      .sort((left, right) => right.n - left.n || left.label.localeCompare(right.label)),
    confusion: [...confusion.values()].sort((left, right) => right.n - left.n),
    cues: cuePrecision(rows, options.cues ?? CHART_CUES),
    crossings: cueCrossings(rows, options.cues ?? CHART_CUES),
    latency: percentiles(durations),
    variant: options.variant ?? 'shipped',
    // Filled by `sweepRule`, which is the only caller that prices more than one table. A report from
    // `scoreRule` valued exactly one table and says so rather than implying the sweep found nothing.
    sweep: [],
  };
}

/**
 * The histogram cue, inserted ahead of `distribution`.
 *
 * Ahead, and that is the whole mechanism: the leading mark is the first mark of the first fired cue,
 * so a table in which `distribution` comes first can only ever answer a histogram question with a
 * boxplot. Its pattern is narrow on purpose — the words that mean *binned* and nothing else — and
 * `distribution` keeps its own `histogram` alternative, which then fires second and puts `boxplot`
 * on the shortlist where a reader can see it.
 */
const HISTOGRAM_CUE: CueRule = {
  kind: 'histogram',
  marks: ['bar'],
  pattern: /\bhistograms?\b|\bfrequency (?:distribution|counts?)\b|\bbinned\b/,
};

/**
 * The same table with one cue inserted ahead of `share`.
 *
 * Ahead, because the leading mark is the first mark of the first fired cue: a table in which `share`
 * comes first can only ever answer "the share of orders by status" with a pie, whatever else it
 * knows. The `share` cue keeps its own marks untouched, so a question the new phrase does not match
 * is answered exactly as it was before — which is what makes the reading a delta on one phrase.
 *
 * A table with no `share` rule still gets the cue: appended rather than dropped, because a variant
 * that silently lost a cue would be measured as if it had it.
 */
export function withCueAheadOf(table: readonly CueRule[], cue: CueRule, before: CueKind): readonly CueRule[] {
  const at = table.findIndex((rule) => rule.kind === before);
  const index = at === -1 ? table.length : at;
  return [...table.slice(0, index), cue, ...table.slice(index)];
}

/**
 * The same table with the histogram cue inserted before `distribution`.
 *
 * A membership change and not a pattern edit: the variant discipline is that only `marks` and the
 * presence of a cue may differ, so a reading can be attributed to the order rather than to a
 * rewritten phrase.
 */
export function withHistogramCue(table: readonly CueRule[]): readonly CueRule[] {
  return withCueAheadOf(table, HISTOGRAM_CUE, 'distribution');
}

/**
 * The narrow `share` discriminator is no longer here: it shipped.
 *
 * `share by X` was priced against the corpus as a variant for two rounds and then became the product
 * (`share-by` in `CHART_CUES`, ahead of `share`) on two readings that agreed: 10 bar rows won
 * against 5 pie rows lost on the question half, and 3 more rows on the product's own hit test. A
 * lever that becomes the table it was measured against leaves the sweep — the sweep's control is the
 * product, and a candidate for a rule the product already has is a second copy of the control.
 *
 * The width that remains is the one that was refused, kept so the refusal stays a reading:
 */

/**
 * The same signal at the width that also reads a measure between the two words.
 *
 * "The share of revenue by region" is the corpus's most natural way to ask for a comparison and it
 * does not match the narrow cue, because four words sit between `share` and `by`. Matching a share
 * word and a following `by` anywhere in the question is the honest wide reading of the same claim,
 * and it is registered *before* the sweep rather than after it: two widths of one signal, priced on
 * the same rows, so which one ships is a reading and not a choice made while looking at the result.
 *
 * It is not free of false positives and does not claim to be: "the share of orders by status that are
 * banned" names a comparison *and* a filter, and a cue table cannot tell which one the answer should
 * be drawn for. That is exactly what `pie` must not fall by to be worth the trade.
 */
const SHARE_BY_ANY_CUE: CueRule = {
  kind: 'share-by-any',
  marks: ['bar'],
  pattern: /\b(?:share|proportion|percentage|percent|composition|breakdown|split)\b[\s\S]*\bby\b/,
};

/** The wide width: a share word followed by `by` anywhere later in the question. */
export function withShareByAnyCue(table: readonly CueRule[]): readonly CueRule[] {
  return withCueAheadOf(table, SHARE_BY_ANY_CUE, 'share');
}

/**
 * The `matrix` pattern the product read before this round: unbounded, and the reading that retired it.
 *
 * `\bby\b[\s\S]*\band\b` spans the whole question, newlines included, so any question carrying "by"
 * anywhere and "and" anywhere later led with a heatmap — and the corpus's questions are instructions,
 * a sentence of data followed by "generate matplotlib code" followed by axis rules. The cue decided
 * 223 questions and was right about one.
 *
 * Kept as a variant rather than deleted with the code that shipped: the 43 product rows the window
 * recovered are only attributable while the table that lost them can still be priced. A counterfactual
 * that lives only in a commit message is a number nobody can re-take.
 */
const MATRIX_WIDE: RegExp = /\bby\b[\s\S]*\band\b|交叉|矩阵/;

/** The same table with the retired unbounded `matrix` pattern, to price what the window bought. */
export function withMatrixWide(table: readonly CueRule[]): readonly CueRule[] {
  return table.map((rule) => (rule.kind === 'matrix' ? { ...rule, pattern: MATRIX_WIDE } : rule));
}

/**
 * The `matrix` cue with its marks reversed: a crossing is a bar before it is a heatmap.
 *
 * The per-cue reading is what asks for this. `matrix` decides 223 questions and is right about one of
 * them, and its family coverage is 30.49% — 68 rows where the label is a heatmap *or a bar*. One of
 * those 68 is a heatmap. So the cue is not wrong about the family; it is wrong about the order, and
 * the order is the first mark, which is the whole of the claim it makes.
 *
 * Refused by the product reading, and this is the lever that made the two-reading rule worth having.
 * Reversing the marks scores **657 (+66)** on the question half — the largest gain in the sweep — and
 * **278 (−34)** on the product: bar +78 bought with line −75 and pie −29. The question half cannot see
 * that cost, because it scores the first cue that fired and `trend` comes before `matrix`, so the line
 * rows never enter its arithmetic; the product ranks by first claims across the whole question, so a
 * bar paid three points here outvotes a line the question actually named.
 */
export function withMatrixBarFirst(table: readonly CueRule[]): readonly CueRule[] {
  return table.map((rule) => (rule.kind === 'matrix' ? { ...rule, marks: ['bar', 'heatmap'] } : rule));
}

/**
 * The table with no `matrix` cue at all.
 *
 * Priced beside the window because the two answer different questions. The window asks "is the cue
 * right when it only reads a clause"; the removal asks "is the cue worth its leads at all", which is
 * the ceiling a narrower pattern can reach and the floor a rewrite has to clear. A table that loses
 * rows when the cue is removed is a table in which `by … and` really does identify a crossing.
 */
export function withoutMatrix(table: readonly CueRule[]): readonly CueRule[] {
  return table.filter((rule) => rule.kind !== 'matrix');
}

/**
 * The same table with one cue moved in front of another.
 *
 * The move is the cheapest lever this file prices: it costs no phrase, it cannot mis-read a question
 * the shipped table already reads correctly, and it changes exactly one thing — which of two cues that
 * both fired gets to lead. `withCueAheadOf` inserts a cue the table does not have; this one takes a
 * cue the table does have and changes its place, which is a different reading and a different shape of
 * change, so it is a different function rather than a flag.
 *
 * A table that does not hold `kind` comes back untouched, and so does one whose `before` is missing
 * (the moved cue is then appended). That totality is not politeness: a variant built from a table that
 * lost a cue must still be measurable, or the comparison silently drops a table instead of reporting
 * one.
 */
export function withCueMoved(table: readonly CueRule[], kind: CueKind, before: CueKind): readonly CueRule[] {
  const moved = table.find((rule) => rule.kind === kind);
  if (moved === undefined) return table;
  const rest = table.filter((rule) => rule.kind !== kind);
  const at = rest.findIndex((rule) => rule.kind === before);
  const index = at === -1 ? rest.length : at;
  return [...rest.slice(0, index), moved, ...rest.slice(index)];
}

/**
 * One cue's fallback moved in front of the mark it prefers.
 *
 * The `marks` array is a cue saying "this mark, or that one if the first cannot be drawn", and the
 * product pays the first three points and the rest two. So the order inside one cue is a claim the
 * product reads on every question the cue fires on — unlike the order of the *table*, which
 * `recommendChart` never reads (`firstClaims` is a count over a set) and which a round measured as
 * the identity function on the product.
 *
 * A mark that is not in the cue, or is already first, leaves the table untouched: a builder that
 * threw would drop a variant from the sweep instead of reporting it.
 */
export function withMarkFirst(table: readonly CueRule[], kind: CueKind, mark: ChartType): readonly CueRule[] {
  return table.map((rule) => {
    if (rule.kind !== kind) return rule;
    const at = rule.marks.indexOf(mark);
    if (at <= 0) return rule;
    return { ...rule, marks: [mark, ...rule.marks.filter((entry) => entry !== mark)] };
  });
}

/** The table without one cue kind: the ablation, which is the contribution of that cue. */
export function withoutCue(table: readonly CueRule[], kind: CueKind): readonly CueRule[] {
  return table.filter((rule) => rule.kind !== kind);
}

/**
 * A cue table this build prices, and the one line that says what it changes.
 *
 * The list is generated for everything that is an *instance* of a uniform edit — every cue that names
 * a fallback, every cue that can be removed — and hand-written only for the entries that a round
 * published under a name of its own. A hand-written list of candidates is a list of the repairs
 * somebody already imagined, and the point of the sweep is that the enumeration is a reading too.
 */
export interface TableVariant {
  readonly name: string;
  readonly note: string;
  readonly cues: readonly CueRule[];
}

/**
 * Two cues are reversed under the names their rounds published, and the generator skips them.
 *
 * `bar-share` and `matrix-bar-first` are the same tables a generated flip would build, and two names
 * for one table is a reading that looks like corroboration and is one measurement taken twice. The
 * guard is a test as well — no two entries in the sweep may hold the same table — because the
 * collision this comment prevents is the one a future cue will cause again.
 */
const REVERSED_UNDER_OTHER_NAMES: ReadonlySet<CueKind> = new Set<CueKind>(['share', 'matrix']);

/** Every cue that names a fallback, with that fallback moved first. */
const FALLBACK_FLIPS: readonly TableVariant[] = CHART_CUES.filter(
  (rule) => rule.marks.length > 1 && !REVERSED_UNDER_OTHER_NAMES.has(rule.kind),
).map((rule) => {
  const fallback = rule.marks[1] as ChartType;
  return {
    name: `${rule.kind}-${fallback}-first`,
    note: `\`${rule.kind}\` leads with ${fallback}: the mark it names second, moved in front of the one it names first`,
    cues: withMarkFirst(CHART_CUES, rule.kind, fallback),
  };
});

/**
 * Every cue removed, one at a time. `matrix` is registered as `no-matrix` already, and the same
 * table under a second name is the collision above.
 */
const ABLATIONS: readonly TableVariant[] = [...new Set(CHART_CUES.map((rule) => rule.kind))]
  .filter((kind) => kind !== 'matrix')
  .map((kind) => ({
    name: `no-${kind}`,
    note: `\`${kind}\` removed: what the product loses when the cue is gone, which is its contribution`,
    cues: withoutCue(CHART_CUES, kind),
  }));

/**
 * `ranking` in front of `share`, which is the reorder the crossing reading asks for.
 *
 * `share` decides more rows than any other cue and gets 28.01% of them right; the gap to its family
 * coverage is 187 rows where the label was a bar that the cue itself lists second. The question the
 * crossing reading answers is what those rows have in common, and the answer it counts is `ranking`:
 * a question that both shares and ranks is a comparison, and `ranking` — which speaks for a bar and
 * nothing else — sits *after* `share` in the shipped table, so it never leads. Moving it is a claim
 * that the ranking is the stronger statement, priced rather than asserted.
 */
export function withRankingBeforeShare(table: readonly CueRule[]): readonly CueRule[] {
  return withCueMoved(table, 'ranking', 'share');
}

/**
 * A cue for a share that ranks, at the width that reads one clause.
 *
 * The rival of the move above on the same rows, and priced separately because it is the other way to
 * fix one defect: the move changes an order and reads every question the table already reads, while
 * this changes the table's membership and reads only questions holding both a share word and a ranking
 * word within one clause. Which one ships is a reading — the move can repaint a share question whose
 * ranking word means something else, and the phrase costs a new name in the vocabulary.
 *
 * The window is bounded on purpose. `\bby\b[\s\S]*\band\b` cost this project 222 rows because an
 * instruction carries a full stop and then more words; the same sentence-final bound applies here.
 */
const SHARE_RANKED_CUE: CueRule = {
  kind: 'share-ranked',
  marks: ['bar'],
  pattern:
    /\b(?:share|proportion|percentage|percent|composition|breakdown|split|makeup)\b[^.;?!\n]{0,60}\b(?:top|bottom|ranks?|ranked|highest|lowest|largest|smallest|most|least|best|worst)\b|\b(?:top|bottom|ranks?|ranked|highest|lowest|largest|smallest|best|worst)\b[^.;?!\n]{0,60}\b(?:share|proportion|percentage|percent|composition|breakdown|split|makeup)\b/,
};

/** The same table with the ranked-share cue inserted ahead of `share`. */
export function withShareRankedCue(table: readonly CueRule[]): readonly CueRule[] {
  return withCueAheadOf(table, SHARE_RANKED_CUE, 'share');
}

/**
 * The tables this build prices, and what each one changes.
 *
 * The discipline is that a variant changes one thing and says what it is in one line: the order of
 * the cues, the membership of a cue's `marks`, the presence of a cue, or the width of exactly one
 * pattern. What it may never do is rewrite a phrase *and* reorder the table in the same entry — a
 * variant that changed two things could not be attributed, and the sweep exists so that a change is
 * attributable before it ships.
 *
 * What is left is the axis of refusals: the retired `matrix` width, the reversal of its marks, its
 * removal, the blunt `share` flip, the wide share discriminator, and the histogram cue. The two
 * narrow levers that shipped are not here — a candidate for a rule the product already has is a
 * second copy of the control.
 *
 * `shipped` comes first and is the table the package exports, so the sweep always contains the
 * control it is a sweep of.
 */
export const CUE_VARIANTS: readonly TableVariant[] = [
    { name: 'shipped', note: 'the table `@agentix-e/nl2charts-chart` exports', cues: CHART_CUES },
    {
      name: 'matrix-wide',
      note: 'the retired unbounded `matrix` pattern, so the 43 product rows the clause window recovered stay a measurement',
      cues: withMatrixWide(CHART_CUES),
    },
    {
      name: 'matrix-bar-first',
      note: '`matrix` reversed on the shipped pattern: a crossing is a bar before it is a heatmap',
      cues: withMatrixBarFirst(CHART_CUES),
    },
    {
      name: 'matrix-wide+bar-first',
      note: 'the reversal on the pattern that made it look good: +66 on the question half, −34 on the product',
      cues: withMatrixBarFirst(withMatrixWide(CHART_CUES)),
    },
    {
      name: 'no-matrix',
      note: '`matrix` removed outright: the ceiling a narrower pattern could reach and the floor a rewrite has to clear',
      cues: withoutMatrix(CHART_CUES),
    },
    {
      name: 'bar-share',
      note: 'the `share` cue leads with a bar: the corpus drew 194 bars for questions this table answers `pie`',
      cues: CHART_CUES.map((rule) => (rule.kind === 'share' ? { ...rule, marks: ['bar', 'pie'] } : rule)),
    },
    {
      name: 'share-by-any',
      note: 'the refused wide width of the share discriminator: a share word and a `by` anywhere after it',
      cues: withShareByAnyCue(CHART_CUES),
    },
    {
      name: 'histogram',
      note: 'a cue that names the binned measure, so a histogram question is answered with a bar instead of a boxplot',
      cues: withHistogramCue(CHART_CUES),
    },
    {
      name: 'share-by-any+histogram',
      note: 'the wide share discriminator and the histogram cue together, priced as a pair',
      cues: withHistogramCue(withShareByAnyCue(CHART_CUES)),
    },
    {
      name: 'ranking-before-share',
      note: '`ranking` moved in front of `share`, which is the reorder the crossing reading of the 187 wrong-order rows asks for',
      cues: withRankingBeforeShare(CHART_CUES),
    },
    {
      name: 'share-ranked',
      note: 'a ranked share read as one phrase: a share word and a ranking word inside one clause, answered with a bar',
      cues: withShareRankedCue(CHART_CUES),
    },
    ...FALLBACK_FLIPS,
    ...ABLATIONS,
  ];

/**
 * The corpus, priced against every variant.
 *
 * One table per variant, the same rows, the same denominator. The per-family rows are what makes
 * the sweep decidable: a variant that raises `bar` by 8 rows and lowers `pie` by 145 has not
 * improved, and a top-1 share alone cannot say which happened.
 */
export function sweepRule(rows: readonly RuleInput[], options: { readonly clock?: () => number } = {}): RuleReport {
  const readings: VariantReading[] = CUE_VARIANTS.map((variant) => {
    const report = scoreRule(rows, { ...options, cues: variant.cues, variant: variant.name });
    return {
      variant: variant.name,
      note: variant.note,
      scored: report.scored,
      top1: report.top1,
      top1Share: report.top1Share,
      shortlist: report.shortlist,
      shortlistShare: report.shortlistShare,
      declined: report.declined,
      byFamily: familyRows(report),
      cues: report.cues,
    };
  });
  return { ...scoreRule(rows, options), sweep: readings };
}

/**
 * Top-1 hits per labelled family, from a report's own per-label rows.
 *
 * Summed from `perLabel` rather than counted twice: a family total computed by a second pass is a
 * second definition of the population, and the two would disagree exactly when a label changed
 * family.
 */
export function familyRows(report: RuleReport): readonly { readonly family: ChartFamily; readonly n: number; readonly top1: number }[] {
  const byFamily = new Map<ChartFamily, { n: number; top1: number }>();
  for (const entry of report.perLabel) {
    const cell = byFamily.get(entry.family) ?? { n: 0, top1: 0 };
    cell.n += entry.n;
    cell.top1 += entry.top1;
    byFamily.set(entry.family, cell);
  }
  return [...byFamily.entries()]
    .map(([family, cell]) => ({ family, n: cell.n, top1: cell.top1 }))
    .sort((left, right) => right.n - left.n || left.family.localeCompare(right.family));
}

/**
 * Nearest-rank percentiles over the per-question durations.
 *
 * Nearest rank rather than interpolation because every value in this list is a real measured
 * duration: an interpolated p95 is a number no single question took, and the one thing this
 * instrument is for is saying what a question costs.
 */
export function percentiles(values: readonly number[], points: readonly number[] = [0.5, 0.95, 1]): { p50: number; p95: number; max: number } {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (point: number): number => {
    if (sorted.length === 0) return 0;
    const rank = Math.min(sorted.length, Math.max(1, Math.ceil(point * sorted.length)));
    return sorted[rank - 1] as number;
  };
  const [p50 = 0, p95 = 0, max = 0] = points.map(at);
  return { p50, p95, max: sorted.length === 0 ? 0 : Math.max(max, at(1)) };
}

/**
 * Refuse a report whose arithmetic does not close.
 *
 * Every field here is derived from the same three counters, so a report that disagrees with itself
 * is a report produced by a second definition of "a scored row". That is the class of defect this
 * project has paid for twice (the pairing that lost a case, the ceiling that was read off the
 * arm's own flag), and it costs four comparisons to refuse it.
 */
export function assertRuleReport(report: RuleReport): void {
  const sumN = report.perLabel.reduce((total, entry) => total + entry.n, 0);
  if (sumN !== report.scored) {
    throw new Error(`the per-label rows sum to ${String(sumN)} against ${String(report.scored)} scored rows, so a label is counted twice or dropped`);
  }
  const sumConfusion = report.confusion.reduce((total, cell) => total + cell.n, 0);
  if (sumConfusion + report.declined !== report.scored) {
    throw new Error(`the confusion cells and the declined count sum to ${String(sumConfusion + report.declined)} against ${String(report.scored)} scored rows, so a case changed cell without being counted`);
  }
  if (report.top1 > report.shortlist || report.shortlist > report.scored) {
    throw new Error(`top-1 (${String(report.top1)}) must be inside the shortlist (${String(report.shortlist)}) which must be inside the scored rows (${String(report.scored)})`);
  }
  if (report.rows !== report.scored + report.unmapped.count) {
    throw new Error(`the corpus holds ${String(report.rows)} rows but ${String(report.scored)} + ${String(report.unmapped.count)} do not sum to it`);
  }
  // Every row that fired a cue fired exactly one cue first, so the per-cue lead counts are a
  // partition of the answered rows. A cue counted twice, or a row dropped because its label was
  // unmapped twice over, shows up here rather than in a share nobody can re-derive.
  assertCueReadings(report.cues, report.scored - report.declined, report.variant);
  assertCrossings(report.crossings, report.cues, report.variant);
  // Each variant is scored on the same corpus, so a reading whose population is a different size was
  // computed by a second definition of the denominator — the one defect a sweep makes easy to miss,
  // because the tables differ and the rows must not.
  for (const reading of report.sweep) {
    if (reading.scored !== report.scored) {
      throw new Error(`variant ${reading.variant} scored ${String(reading.scored)} rows against ${String(report.scored)} for ${report.variant}, so the two are not the same population`);
    }
    const sum = reading.byFamily.reduce((total, cell) => total + cell.n, 0);
    if (sum !== reading.scored) {
      throw new Error(`variant ${reading.variant} publishes per-family rows summing to ${String(sum)} against ${String(reading.scored)} scored rows`);
    }
    if (reading.top1 > reading.shortlist || reading.shortlist > reading.scored) {
      throw new Error(`variant ${reading.variant} reports top-1 ${String(reading.top1)} above its shortlist ${String(reading.shortlist)} or above its scored rows`);
    }
    assertCueReadings(reading.cues, reading.scored - reading.declined, reading.variant);
  }
}

/**
 * The three per-cue counts, checked against the population they were read on.
 *
 * `leads` is a partition of the rows a cue decided, and `hits ⊆ inside ⊆ leads` holds because a cue's
 * first mark is one of its marks. Neither identity can fail by a small amount: both are true of every
 * row or the reading counted a row twice.
 */
function assertCueReadings(cues: readonly CueReading[], answered: number, variant: string): void {
  const leads = cues.reduce((total, cue) => total + cue.leads, 0);
  if (leads !== answered) {
    throw new Error(`variant ${variant}: the per-cue leads sum to ${String(leads)} against ${String(answered)} rows that fired a cue`);
  }
  for (const cue of cues) {
    if (cue.hits > cue.inside || cue.inside > cue.leads) {
      throw new Error(`variant ${variant}: cue ${cue.kind} reports ${String(cue.hits)} hits inside ${String(cue.inside)} covered inside ${String(cue.leads)} leads`);
    }
  }
}

/**
 * The crossing reading, checked against the per-cue reading it is a second view of.
 *
 * `ordered` is `inside - hits` by definition and `hits` is the same counter, so the only way the two
 * can disagree is a second definition of the population — and this file has paid for that class of
 * defect twice. A crossing naming a cue that has no per-cue row is the sharper failure: the two were
 * read on different row sets.
 */
function assertCrossings(crossings: readonly CueCrossing[], cues: readonly CueReading[], variant: string): void {
  const byKind = new Map(cues.map((cue) => [cue.kind, cue]));
  for (const crossing of crossings) {
    const cue = byKind.get(crossing.kind);
    if (cue === undefined) {
      throw new Error(`variant ${variant}: the crossing for ${crossing.kind} has no per-cue reading, so the two views are of different populations`);
    }
    if (crossing.hits !== cue.hits || crossing.ordered !== cue.inside - cue.hits) {
      throw new Error(
        `variant ${variant}: the crossing for ${crossing.kind} reports ${String(crossing.hits)} hits and ${String(crossing.ordered)} wrong-order rows against the per-cue reading's ${String(cue.hits)} and ${String(cue.inside - cue.hits)}`,
      );
    }
  }
}

/**
 * The repair list, one line per cue that has rows a reorder could recover.
 *
 * Two companion lists on one line, and the second is not decoration: a companion that fires on both
 * halves is a cue that fires often, and only the one that fires on the broken half is a candidate to
 * move. Printing only `withCue` would make every common cue look like the answer — which is the same
 * defect as reporting a share without its baseline, one level down.
 *
 * A cue with nothing wrong gets no line. This reading exists to name a repair, and a row of zeroes is
 * not one; the per-cue table above already reports every cue, right or wrong.
 */
export function describeCrossings(crossings: readonly CueCrossing[]): readonly string[] {
  if (crossings.length === 0) return [];
  const actionable = crossings.filter((crossing) => crossing.ordered > 0);
  const lines = [`  order, not phrase: the rows each cue got the family right and the mark order wrong`];
  if (actionable.length === 0) {
    lines.push('    no cue led a row it covered with the wrong mark first');
    return lines;
  }
  for (const crossing of actionable) {
    const companions = (entries: readonly { readonly kind: CueKind; readonly n: number }[], rows: number): string =>
      entries.length === 0 ? 'none' : entries.map((entry) => `${entry.kind} (${String(entry.n)}/${String(rows)})`).join(', ');
    lines.push(
      `    ${crossing.kind.padEnd(12)} ${String(crossing.ordered).padStart(4)} wrong order of ${String(crossing.ordered + crossing.hits)} covered  |  beside: ${companions(crossing.withCue, crossing.ordered)}  |  on the ${String(crossing.hits)} it got right: ${companions(crossing.hitWithCue, crossing.hits)}`,
    );
  }
  return lines;
}

/** The corpus, as the rows this arm reads. */
export function ruleInputs(corpus: { readonly rows: readonly Text2VisRow[] }): RuleInput[] {
  return corpus.rows.map((row) => ({ prompt: row.prompt, label: row.chartType }));
}

/** The lines a reader needs, in the order they answer "what did it score and what is the bar". */
export function describeRule(report: RuleReport): readonly string[] {
  const share = (value: number): string => `${(value * 100).toFixed(2)}%`;
  const lines = [
    `text2vis: ${String(report.scored)} scored of ${String(report.rows)} rows (${String(report.unmapped.count)} unmapped labels)`,
    `  top-1 ${share(report.top1Share)} (${String(report.top1)}), shortlist ${share(report.shortlistShare)} (${String(report.shortlist)}), declined ${String(report.declined)}`,
    `  baseline: always ${report.baseline.mostFrequent} ${share(report.baseline.share)}, always bar ${share(report.baseline.bar)}`,
    `  cue path: p50 ${report.latency.p50.toFixed(2)}ms, p95 ${report.latency.p95.toFixed(2)}ms, max ${report.latency.max.toFixed(2)}ms`,
  ];
  if (report.unmapped.labels.length > 0) {
    lines.push(
      `  unmapped labels: ${report.unmapped.labels
        .slice(0, 12)
        .map((entry) => `${entry.label === '' ? '<empty>' : entry.label} (${String(entry.n)})`)
        .join(', ')}${report.unmapped.labels.length > 12 ? ', ...' : ''}`,
    );
  }
  for (const entry of report.perLabel.slice(0, 12)) {
    lines.push(
      `  ${entry.label}: n=${String(entry.n)} top-1 ${share(entry.top1 / entry.n)} -> ${entry.answered
        .slice(0, 3)
        .map((answer) => `${answer.mark} (${String(answer.n)})`)
        .join(', ')}`,
    );
  }
  lines.push(...describeCues(report.cues));
  lines.push(...describeCrossings(report.crossings));
  lines.push(...describeSweep(report));
  return lines;
}

/**
 * The per-cue reading, one line per cue that decided at least one question.
 *
 * `hits` is the cue naming the right picture and `inside` the cue naming the right family in the wrong
 * position, so the gap between the two columns is the part of a cue's loss a reorder would recover and
 * the gap to `leads` is the part only a narrower phrase could. Printed for every cue rather than for
 * the worst one: which cue is worst depends on the corpus, and choosing it here would be this function
 * deciding which file to open.
 */
export function describeCues(cues: readonly CueReading[]): readonly string[] {
  if (cues.length === 0) return [];
  const lines = [`  cue precision, by the rows each cue decided first:`];
  for (const cue of cues) {
    const mark = cue.first ?? 'none';
    lines.push(
      `    ${cue.kind.padEnd(12)} ${String(cue.leads).padStart(4)} leads  first ${mark.padEnd(11)} hit ${(cue.precision * 100).toFixed(2).padStart(6)}% (${String(cue.hits)})  family ${(cue.coverage * 100).toFixed(2)}%`,
    );
  }
  return lines;
}

/**
 * The sweep, one line per table, with what moved against the control.
 *
 * The control is `shipped` — the table the product actually exports — and not the line above it. The
 * distinction is not cosmetic: a delta against the previous row is a position in a list, so reordering
 * `CUE_VARIANTS` would change every published delta while no cue table changed at all. A reading whose
 * value depends on the order the reader is shown the alternatives in is a reading about the list.
 *
 * Only families whose top-1 *count* moved are printed: a family that changed by zero is one line of
 * noise per table, and a family that moved is the whole reason the line exists.
 */
export function describeSweep(report: RuleReport): readonly string[] {
  if (report.sweep.length === 0) return [];
  const control = report.sweep[0] as VariantReading;
  const lines = [`  sweep: ${String(report.sweep.length)} tables over the same ${String(report.scored)} rows, each delta against ${control.variant}`];
  for (const reading of report.sweep) {
    const moved =
      reading === control
        ? []
        : reading.byFamily
            .map((cell) => ({ family: cell.family, delta: cell.top1 - top1Of(control, cell.family) }))
            .filter((cell) => cell.delta !== 0)
            .sort((left, right) => right.delta - left.delta)
            .map((cell) => `${cell.family} ${cell.delta > 0 ? '+' : ''}${String(cell.delta)}`);
    const bar = reading.byFamily.find((cell) => cell.family === 'bar');
    const barShare = bar === undefined || bar.n === 0 ? 0 : bar.top1 / bar.n;
    // `declined` is printed only when it moved: it is the one counter a cue removal moves, and a
    // variant that declines what the control answered is a different table rather than a better one.
    const declined = reading.declined === control.declined ? '' : `, declined ${String(reading.declined)} (${reading.declined > control.declined ? '+' : ''}${String(reading.declined - control.declined)})`;
    const head = `    ${reading.variant.padEnd(22)} top-1 ${(reading.top1Share * 100).toFixed(2)}% (${String(reading.top1)}), bar ${(barShare * 100).toFixed(2)}%${declined}`;
    lines.push(`${head}${moved.length === 0 ? '' : `  |  ${moved.join(', ')}`}`);
  }
  return lines;
}

/** A family's top-1 count in one reading, or zero when that reading has no row for it. */
function top1Of(reading: VariantReading, family: ChartFamily): number {
  return reading.byFamily.find((cell) => cell.family === family)?.top1 ?? 0;
}

/** The flags this command takes, and nothing else. */
export interface RuleArgs {
  /** Where to write the report, when a workflow wants to keep it. */
  readonly artifact?: string;
  /** Print the report as JSON on stdout instead of the reader's lines. */
  readonly json: boolean;
}

/**
 * Parse the command line, refusing anything it does not use.
 *
 * A positional argument is refused rather than ignored: `--artfacts` (a typo) and `--artifact` must
 * not both succeed with one of them silently doing nothing, because the run that "wrote no
 * artifact" is then indistinguishable from the run that wrote to the wrong name.
 */
export function parseRuleArgs(argv: readonly string[]): RuleArgs {
  const args: RuleArgs = { json: false };
  let artifact: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--artifact') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--artifact needs a path');
      }
      artifact = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${flag}: this command reads the corpus and scores the cue table, and takes --json and --artifact <path>`);
  }
  return { ...args, json, ...(artifact === undefined ? {} : { artifact }) };
}

/**
 * Score the shipped cue table against the corpus and publish both halves.
 *
 * The rule arm exists to be falsifiable: its share is printed beside two constants, so "the cue
 * table earns 31%" and "always answering bar earns 28%" are one line apart rather than one document
 * apart. A run with no model call cannot fail from an outage, so the only failure it reports is a
 * corpus it could not read -- which is a download, and is named as one.
 */
export async function entryRule(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  options: { readonly argv?: readonly string[]; readonly load?: LoadOptions } = {},
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  try {
    const args = parseRuleArgs(options.argv ?? []);
    const { corpus, source, path } = await loadText2Vis(options.load ?? {});
    log(`text2vis: ${source} ${path}`);
    const report = sweepRule(ruleInputs(corpus));
    assertRuleReport(report);
    if (args.json) {
      log(JSON.stringify(report, null, 2));
    } else {
      for (const line of describeRule(report)) log(line);
    }
    if (args.artifact !== undefined) {
      const { mkdir, writeFile, rename } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(args.artifact), { recursive: true });
      // The same staged write the corpus cache uses: an artifact a later run reads as half a
      // report is worse than no artifact, and a killed process leaves `.part` rather than the name.
      await writeFile(`${args.artifact}.part`, `${JSON.stringify(report, null, 2)}\n`);
      await rename(`${args.artifact}.part`, args.artifact);
      log(`text2vis: wrote ${args.artifact}`);
    }
    return report.scored === 0 ? 1 : 0;
  } catch (error) {
    log(`text2vis: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

void entryRule(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`), {
  argv: process.argv.slice(2),
}).then((code) => applyExitCode(code, process));
