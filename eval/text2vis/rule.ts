import { CHART_CUES, readCues, type CueKind, type CueRule, type RecommendableMark } from '@agentix-e/nl2charts-chart';
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

function isRecommendable(mark: string): mark is RecommendableMark {
  return mark in MARK_FAMILIES;
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
  /** Top-1 hits per labelled family. A family with a smaller `n` than the shipped run has left the population. */
  readonly byFamily: readonly { readonly family: ChartFamily; readonly n: number; readonly top1: number }[];
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
 * The same table with the histogram cue inserted before `distribution`.
 *
 * A membership change and not a pattern edit: the variant discipline is that only `marks` and the
 * presence of a cue may differ, so a reading can be attributed to the order rather than to a
 * rewritten phrase.
 */
export function withHistogramCue(table: readonly CueRule[]): readonly CueRule[] {
  const at = table.findIndex((rule) => rule.kind === 'distribution');
  // A table without `distribution` still gets the cue: appended rather than dropped, because a
  // variant that silently lost a cue would be measured as if it had it.
  const index = at === -1 ? table.length : at;
  return [...table.slice(0, index), HISTOGRAM_CUE, ...table.slice(index)];
}

/**
 * Every cue table this build can construct, and what each one changes.
 *
 * Three rules, and the discipline is that a variant may re-order or re-membership `marks` and may
 * add a cue, but may never edit a pattern: a variant that rewrote the phrases would be a different
 * cue table rather than the same one re-ordered, and its reading could not be attributed.
 *
 * `shipped` comes first and is the table the package exports, so the sweep always contains the
 * control it is a sweep of.
 */
export const CUE_VARIANTS: readonly { readonly name: string; readonly note: string; readonly cues: readonly CueRule[] }[] = [
  { name: 'shipped', note: 'the table `@agentix-e/nl2charts-chart` exports', cues: CHART_CUES },
  {
    name: 'bar-share',
    note: "the `share` cue leads with a bar: the corpus drew 194 bars for questions this table answers `pie`",
    cues: CHART_CUES.map((rule) => (rule.kind === 'share' ? { ...rule, marks: ['bar', 'pie'] } : rule)),
  },
  {
    name: 'histogram',
    note: 'a cue that names the binned measure, so a histogram question is answered with a bar instead of a boxplot',
    cues: withHistogramCue(CHART_CUES),
  },
  {
    name: 'bar-share+histogram',
    note: 'both changes at once, because they touch different labels and a reader will ask',
    cues: withHistogramCue(CHART_CUES.map((rule) => (rule.kind === 'share' ? { ...rule, marks: ['bar', 'pie'] } : rule))),
  },
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
      byFamily: familyRows(report),
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
  }
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
  lines.push(...describeSweep(report));
  return lines;
}

/**
 * The sweep, one line per table, with what moved against the control.
 *
 * The control is the first table in the sweep — `shipped` — so every delta on these lines is a
 * difference the reader can check against a table the product actually exports. Only families whose
 * top-1 *count* moved are printed: a family that changed by zero is one line of noise per table,
 * and a family that moved is the whole reason the line exists.
 */
export function describeSweep(report: RuleReport): readonly string[] {
  if (report.sweep.length === 0) return [];
  const lines = [`  sweep: ${String(report.sweep.length)} tables over the same ${String(report.scored)} rows, each delta against the table above`];
  // The control is the table before this one, carried in the loop rather than read by index: the
  // first table is its own control and prints no delta, and a second `report.sweep[0]` read would be
  // a branch for a state the type system cannot rule out and the data cannot reach.
  let control: VariantReading | undefined;
  for (const reading of report.sweep) {
    const reference = control;
    control = reading;
    const moved = reading.byFamily
      .map((cell) => ({ family: cell.family, delta: reference === undefined ? 0 : cell.top1 - top1Of(reference, cell.family) }))
      .filter((cell) => cell.delta !== 0)
      .sort((left, right) => right.delta - left.delta)
      .map((cell) => `${cell.family} ${cell.delta > 0 ? '+' : ''}${String(cell.delta)}`);
    const bar = reading.byFamily.find((cell) => cell.family === 'bar');
    const barShare = bar === undefined || bar.n === 0 ? 0 : bar.top1 / bar.n;
    const head = `    ${reading.variant.padEnd(20)} top-1 ${(reading.top1Share * 100).toFixed(2)}% (${String(reading.top1)}), bar ${(barShare * 100).toFixed(2)}%`;
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
