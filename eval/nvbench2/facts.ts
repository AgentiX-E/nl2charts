/**
 * What the corpus asks for, counted before anything is scored.
 *
 * ADR 0001 states three facts that must be published *before* the first F1 reading, because each of
 * them changes what the reading means:
 *
 * 1. **The distribution of `|G|`.** F1@3 is capped at `3/|G|` by the metric, so a corpus whose
 *    questions mostly carry four or five golds is mostly a measurement of that cap.
 * 2. **How much of the gold vocabulary this repository can express.** A gold whose mark no product
 *    mark can draw is *unreachable*, and counting it as a miss would report a contract as an error.
 * 3. **How many golds restrict their rows.** A filter is part of the compared chart: a prediction that
 *    is right about the fields and silent about the filter is a different chart.
 *
 * The arithmetic here is a property of the files, not of any arm, so it is computed from the split
 * alone and travels with every reading. A number that changes between two rounds is a corpus that
 * changed, and the digest beside it says so.
 */
import type { SplitRow } from './check.js';
import { isRecord } from './judge.js';

/** The marks this repository's chart contract can draw, and the Vega-Lite mark each is drawn as. */
export const MARK_FROM_VEGA: Readonly<Record<string, string>> = {
  bar: 'bar',
  line: 'line',
  point: 'scatter',
  rect: 'heatmap',
  arc: 'pie',
  boxplot: 'boxplot',
};

/** Corpus-wide facts about one split's gold answers. */
export interface GoldFacts {
  /** Questions in the split. */
  readonly questions: number;
  /** Gold charts across those questions. */
  readonly golds: number;
  /** `|G|` → questions. The sampling distribution of the metric's own cap. */
  readonly sizeHistogram: Readonly<Record<string, number>>;
  /** Vega-Lite mark → golds. */
  readonly marks: Readonly<Record<string, number>>;
  /** Encoding channel → golds that use it. */
  readonly channels: Readonly<Record<string, number>>;
  /** Aggregate → golds that name it on a channel. */
  readonly aggregates: Readonly<Record<string, number>>;
  /** Golds carrying a `transform` (a filter or anything else the reference keeps). */
  readonly transformed: number;
  /** Golds whose mark this repository's contract can draw. */
  readonly expressible: number;
  /**
   * The highest F1@k a perfect prediction could reach, averaged over questions.
   *
   * `matched = min(k, |G|)` for a perfect set, so `F1 = 2·matched / (k + |G|)`. It is the corpus's own
   * ceiling and not an arm's, which is why it is printed beside the reading rather than instead of it.
   */
  readonly ceiling: Readonly<Record<string, number>>;
}

/** Count occurrences, sorted by key so two runs of the same file produce the same object. */
function census(values: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of [...values].sort()) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** Every channel a gold names, and the aggregate it names on it. */
function channelsOf(chart: unknown): { channels: string[]; aggregates: string[] } {
  const channels: string[] = [];
  const aggregates: string[] = [];
  if (!isRecord(chart) || !isRecord(chart['encoding'])) return { channels, aggregates };
  for (const [channel, value] of Object.entries(chart['encoding'])) {
    if (!isRecord(value)) continue;
    channels.push(channel);
    if (typeof value['aggregate'] === 'string') aggregates.push(value['aggregate']);
  }
  return { channels, aggregates };
}

/** The ceiling for one question's gold set at one `k`, as the metric defines it. */
export function ceilingOf(size: number, k: number): number {
  const matched = Math.min(k, size);
  return (2 * matched) / (k + size);
}

/** Read one split's gold answers into the facts ADR 0001 requires before a reading is quoted. */
export function factsOf(rows: readonly SplitRow[], ks: readonly number[] = [1, 3, 5]): GoldFacts {
  const sizes: string[] = [];
  const marks: string[] = [];
  const channels: string[] = [];
  const aggregates: string[] = [];
  let golds = 0;
  let transformed = 0;
  let expressible = 0;
  for (const row of rows) {
    sizes.push(String(row.golds.length));
    for (const gold of row.golds) {
      golds += 1;
      const read = channelsOf(gold);
      channels.push(...read.channels);
      aggregates.push(...read.aggregates);
      const mark = isRecord(gold) && typeof gold['mark'] === 'string' ? gold['mark'] : 'none';
      marks.push(mark);
      if (MARK_FROM_VEGA[mark] !== undefined) expressible += 1;
      if (isRecord(gold) && gold['transform'] !== undefined) transformed += 1;
    }
  }
  // Summed per width rather than accumulated into a map while the rows are read: a seeded map makes
  // every `get` a branch that cannot be false, and a branch no input can reach is a branch a coverage
  // ledger has to carry as a deficit or a lie.
  const reading: Record<string, number> = {};
  for (const k of ks) {
    const total = rows.reduce((sum, row) => sum + ceilingOf(row.golds.length, k), 0);
    reading[String(k)] = rows.length === 0 ? 0 : total / rows.length;
  }
  return {
    questions: rows.length,
    golds,
    sizeHistogram: census(sizes),
    marks: census(marks),
    channels: census(channels),
    aggregates: census(aggregates),
    transformed,
    expressible,
    ceiling: reading,
  };
}
