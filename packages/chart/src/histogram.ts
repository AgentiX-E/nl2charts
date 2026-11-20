/**
 * Pooling a table's numbers and binning them, which is the one picture a histogram is.
 *
 * A histogram is not a mark in this contract: ECharts has no series for it, and the corpus's reference
 * code does not draw one either — it calls `plt.hist(values, bins=…)`, which bins the values and then
 * draws bars. So the capability is a **data rewrite**, exactly like the melt in `melt.ts`: the numbers
 * are counted into equal-width bins, the counts become the rows, and a bar chart over those rows is the
 * histogram. Nothing downstream learns an aggregate and the contract does not change.
 *
 * The corpus says why it is worth having. Of 1,470 scored rows, 90 are labelled `Histogram` and none
 * could be reached: `familiesOfMark('bar', 'histogram')` widened the bar to answer for the family, but
 * the hit test reads the *first* family, so a bar answer scored as a bar. The pictures were not
 * histograms either — `Characteristic | 2016 | 2017` was drawn as a grouped bar of the period columns
 * when the question asked for the distribution of all the cells together.
 *
 * What is pooled: every finite number in every measure column, and nothing else. Not one column at a
 * time, not the sum of a column — `plt.hist` of "all the values in the table" pools them, and the
 * questions say so in words. A cell that is absent or not a number contributes nothing, because a bin
 * count is evidence and a fabricated zero is not.
 *
 * How many bins: Sturges' rule — `ceil(log2 n) + 1` — clamped to `[5, 12]` and to the distinct values.
 * The floor is there because four bins hide the shape the question asks about, the ceiling because this
 * product already knows what a crowded axis looks like (`TICK_CROWD` in `matplotlib.ts`), and the
 * distinct clamp keeps a table of two values from being cut into five bins with three empty ones.
 */

/** Bins a histogram of `n` values is drawn with, before the distinct values have their say. */
const STURGES_BASE = 5;
const BIN_CEILING = 12;

/** One bar of the distribution: the interval it states, and how many values fell in it. */
export interface Bin {
  /** `[low, high)`, and `[low, high]` for the last one: the maximum has to land in a bin. */
  readonly label: string;
  readonly count: number;
}

/** Every value counted once, in bins that tile the observed range. */
export interface Distribution {
  readonly bins: readonly Bin[];
  /** The interval every bin has, before rounding: what a reader needs to redraw the axis. */
  readonly width: number;
}

/** An edge as a reader can check it: `7 + 3 * 7.4` is `29.200000000000003` before rounding. */
const tidy = (value: number): number => Number(value.toPrecision(12));

/** The pooled distribution of `values`, or nothing when there is no number in them. */
export function pooledDistribution(values: readonly unknown[]): Distribution | undefined {
  const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const first = numbers[0];
  if (first === undefined) return undefined;
  const sorted = [...numbers].sort((left, right) => left - right);
  const low = sorted[0] as number;
  const high = sorted[sorted.length - 1] as number;
  const distinct = new Set(numbers).size;
  // One value is a distribution of one point. It is not an error and it is not five empty bins.
  if (low === high) return { bins: [{ label: `[${String(low)}, ${String(low)}]`, count: numbers.length }], width: 0 };
  const sturges = Math.ceil(Math.log2(numbers.length)) + 1;
  const count = Math.min(Math.max(sturges, STURGES_BASE), BIN_CEILING, distinct);
  const width = (high - low) / count;
  const counts = new Array<number>(count).fill(0);
  for (const value of numbers) {
    // The last bin is closed at both ends, so the maximum is counted rather than rounded out of the
    // picture: `Math.floor` of the top edge is `count`, which is one past the last bin.
    const index = Math.min(count - 1, Math.floor((value - low) / width));
    counts[index] = (counts[index] as number) + 1;
  }
  return {
    bins: counts.map((binCount, index) => ({
      label:
        index === count - 1
          ? `[${String(tidy(low + index * width))}, ${String(tidy(high))}]`
          : `[${String(tidy(low + index * width))}, ${String(tidy(low + (index + 1) * width))})`,
      count: binCount,
    })),
    width: tidy(width),
  };
}
