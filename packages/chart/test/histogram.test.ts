import { describe, expect, it } from 'vitest';
import { parseChartIR } from '@agentix-e/nl2charts-spec';
import { pooledDistribution } from '../src/histogram.js';
import type { HistogramReading } from '../src/recommend.js';
import { histogramReading, toChartIR } from '../src/recommend.js';
import { compileToECharts } from '../src/compile.js';

const rows = (spec: Record<string, readonly unknown[]>): Record<string, unknown>[] => {
  const keys = Object.keys(spec);
  const height = Math.max(...keys.map((key) => spec[key]?.length ?? 0));
  return Array.from({ length: height }, (_, index) =>
    Object.fromEntries(keys.map((key) => [key, spec[key]?.[index]])),
  );
};

/** A table wide in time: one row per characteristic, one column per period. */
const wide = rows({
  Characteristic: ['a', 'b', 'c', 'd', 'e'],
  '2016': [10, 20, 30, 40, 50],
  '2017': [15, 25, 35, 45, 55],
});

const labelled = rows({
  region: ['north', 'south', 'west', 'east', 'centre'],
  revenue: [12, 30, 7, 21, 44],
});

const HISTOGRAM = 'Plot a histogram of all the values in the table and say whether it is skewed';

/** The values counted, which every bin partition has to preserve. */
const pooled = (reading: HistogramReading | undefined): number =>
  (reading?.rows ?? []).reduce((sum, row) => sum + Number(row[reading?.count ?? '']), 0);

describe('pooledDistribution', () => {
  it('declines a pool with no number in it, rather than stating an empty axis', () => {
    expect(pooledDistribution([])).toBeUndefined();
    expect(pooledDistribution(['a', null, undefined, Number.NaN])).toBeUndefined();
  });

  it('rounds a bin edge back to the number the arithmetic meant', () => {
    // 7 + 3 * 7.4 is 29.200000000000003 in binary floating point, and an axis label that says so is
    // a label nobody can check against the data.
    const distribution = pooledDistribution([7, 44, 12, 30, 21]);
    expect(distribution?.width).toBe(7.4);
    for (const bin of distribution?.bins ?? []) expect(bin.label).not.toMatch(/\d{10}/);
  });
});

describe('histogramReading', () => {
  it('pools every numeric cell of a table wide in time, in the order the melt gives them', () => {
    const reading = histogramReading(HISTOGRAM, wide);
    expect(reading).toBeDefined();
    const total = pooled(reading);
    // Ten numbers, and none of them may be lost: the count is the evidence and the bars are the reading.
    expect(total).toBe(10);
    expect(reading?.bin).toBe('bin');
    expect(reading?.count).toBe('count');
  });

  it('pools the value column of a table wide in time, which is the same numbers written sideways', () => {
    // Three period columns at least, or the melt does not fire: `meltWide` refuses a pair, because two
    // periods are a pair and not a timeline. Five entities over three years is fifteen numbers.
    const sideways = rows({
      Characteristic: ['a', 'b', 'c', 'd', 'e'],
      '2016': [10, 20, 30, 40, 50],
      '2017': [15, 25, 35, 45, 55],
      '2018': [12, 22, 32, 42, 52],
    });
    const reading = histogramReading(HISTOGRAM, sideways, ['Characteristic', '2016', '2017', '2018']);
    expect(pooled(reading)).toBe(15);
  });

  it('carries the caller\'s title, subtitle, theme and alt text through to the binned chart', () => {
    const named = toChartIR(HISTOGRAM, wide, {
      title: 'Distribution of the values',
      subtitle: 'pooled across both periods',
      theme: 'dark',
      alt: 'a histogram of ten numbers',
    });
    expect(named).toMatchObject({
      title: 'Distribution of the values',
      subtitle: 'pooled across both periods',
      theme: 'dark',
      alt: 'a histogram of ten numbers',
    });
  });

  it('pools one measure across a label column, which is the other table a histogram is drawn from', () => {
    const reading = histogramReading(HISTOGRAM, labelled);
    expect(pooled(reading)).toBe(5);
  });

  it('reads the column order the caller stated, because a record does not carry one', () => {
    // `Object.keys` puts integer-like keys first, so a table whose measure is headed `2016` enumerates
    // with the measure ahead of its label. The caller's order is the one the table was read in.
    const reading = histogramReading(HISTOGRAM, labelled, ['region', 'revenue']);
    expect(reading?.bin).toBe('bin');
    expect(pooled(reading)).toBe(5);
  });

  it('does nothing when the question does not name a histogram', () => {
    // The whole reason this is gated on the cue: a table of five numbers has many readings, and the
    // pooled distribution is only the one that was asked for.
    expect(histogramReading('Compare revenue by region', labelled)).toBeUndefined();
  });

  it('does nothing when the table holds no number to pool', () => {
    const labels = rows({ region: ['north', 'south'], status: ['open', 'closed'] });
    expect(histogramReading(HISTOGRAM, labels)).toBeUndefined();
  });

  it('takes a non-finite cell out of the pool rather than counting it as a value', () => {
    const mixed = rows({ region: ['a', 'b', 'c'], revenue: [10, Number.POSITIVE_INFINITY, 30] });
    const reading = histogramReading(HISTOGRAM, mixed);
    expect(pooled(reading)).toBe(2);
  });

  it('puts a column whose cells are all missing in no bin and in no count', () => {
    const missing = rows({ region: ['a', 'b'], revenue: [10, 30], hole: [null, null] });
    const reading = histogramReading(HISTOGRAM, missing);
    expect(pooled(reading)).toBe(2);
  });

  it('states one bin for a table whose every value is the same, rather than ten empty ones', () => {
    const flat = rows({ region: ['a', 'b', 'c'], revenue: [7, 7, 7] });
    const reading = histogramReading(HISTOGRAM, flat);
    expect(reading?.rows).toHaveLength(1);
    expect(reading?.rows[0]).toEqual({ bin: '[7, 7]', count: 3 });
  });

  it('builds equal-width bins that tile the range, with the maximum in the last one', () => {
    const reading = histogramReading(HISTOGRAM, labelled);
    const bins = reading?.rows ?? [];
    // Every value is counted exactly once, so the bins are a partition and not a sample of the cells.
    expect(pooled(reading)).toBe(5);
    // Ten years of numbers from 10 to 55, Sturges' rule, clamped to what a bar axis can label.
    expect(bins.length).toBeGreaterThanOrEqual(5);
    expect(bins.length).toBeLessThanOrEqual(12);
    // The last label has to be closed at both ends, or the maximum is a value no bar owns.
    expect(String(bins.at(-1)?.bin)).toMatch(/\]$/);
    for (const bin of bins.slice(0, -1)) expect(String(bin.bin)).toMatch(/\)$/);
  });

  it('never states more bins than it has distinct values', () => {
    const two = rows({ region: ['a', 'b', 'c'], revenue: [1, 2, 1] });
    const reading = histogramReading(HISTOGRAM, two);
    expect(reading?.rows).toHaveLength(2);
  });

  it('names its two fields around a table that already uses those names', () => {
    // A table that already has `bin` and `count` columns keeps them: the derived columns are the
    // chart's, and a name collision would overwrite the numbers the query returned.
    const clash = rows({ bin: ['a', 'b'], count: [1, 2], revenue: [10, 30] });
    const reading = histogramReading(HISTOGRAM, clash);
    expect(reading?.bin).toBe('bin_2');
    expect(reading?.count).toBe('count_2');
  });

  it('pools the numbers a table has even when the profiler could not call them a measure', () => {
    // `count` holds two distinct numbers and is typed `ordinal` by the profile rule, which is why the
    // fallback exists: the reading pools what the table holds, not what the profiler could name.
    const clash = rows({ bin: ['a', 'b'], count: [1, 2] });
    expect(histogramReading(HISTOGRAM, clash)?.rows).toHaveLength(2);
  });
});

describe('toChartIR, on a question that asked for a histogram', () => {
  const ir = toChartIR(HISTOGRAM, wide);

  it('draws bars over the bins, and the contract accepts the result', () => {
    expect(ir.mark).toBe('bar');
    expect(() => parseChartIR(ir)).not.toThrow();
    expect(ir.encoding.x).toEqual({ field: 'bin', type: 'ordinal' });
    expect(ir.encoding.y).toEqual([{ field: 'count', type: 'quantitative' }]);
  });

  it('carries only the bins, not the cells they were counted from', () => {
    for (const row of ir.data) {
      expect(Object.keys(row).sort()).toEqual(['bin', 'count']);
    }
  });

  it('emits an option that reads the bins as its category axis and the counts as its measure', () => {
    const option = compileToECharts(ir);
    // The compiler carries rows in `dataset.source` and names the columns through `encode`, so the
    // order the bins are stated in is the order the axis draws them.
    const source =
      (option.dataset as { source?: readonly Readonly<Record<string, unknown>>[] }).source ?? [];
    expect(source.map((row) => row.bin)).toEqual(ir.data.map((row) => row.bin));
    const xAxis = option.xAxis as { type?: string; name?: string };
    expect(xAxis.type).toBe('category');
    expect(xAxis.name).toBe('bin');
  });

  it('applies the row limit to the bins, which is the unit this picture has', () => {
    const cut = toChartIR(HISTOGRAM, wide, { limit: 3 });
    expect(cut.data).toHaveLength(3);
  });

  it('leaves a question that does not name a histogram exactly as it was', () => {
    const plain = toChartIR('Compare the values by characteristic', wide);
    expect(plain.data.some((row) => 'bin' in row)).toBe(false);
  });

  it('declines to bin a table whose mark the caller named something else', () => {
    // An explicit mark is an instruction, and the histogram reading is a data rewrite, not a decoration:
    // a caller that asked for a line gets the table's own rows and the marks that go with them.
    const named = toChartIR(HISTOGRAM, labelled, { mark: 'line' });
    expect(named.mark).toBe('line');
    expect(named.data.some((row) => 'bin' in row)).toBe(false);
  });
});
