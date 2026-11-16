import { describe, expect, it } from 'vitest';
import type { ChartIR } from '@agentix-e/nl2charts-spec';
import { compileToECharts, compileToMatplotlib, enumerateCandidates, inferType, isRenderable, lint, profileRows, toChartIR } from '../src/index.js';

const rows = [
  { month: '2026-01-01', region: 'north', revenue: 120, orders: 12 },
  { month: '2026-02-01', region: 'north', revenue: 150, orders: 18 },
  { month: '2026-03-01', region: 'south', revenue: 90, orders: 9 },
];

function ir(overrides: Partial<ChartIR> & Pick<ChartIR, 'mark'>): ChartIR {
  return {
    version: '3.0',
    encoding: { x: { field: 'month', type: 'temporal' }, y: { field: 'revenue', type: 'quantitative' } },
    data: rows,
    title: 'Revenue',
    alt: 'Revenue by month',
    ...overrides,
  };
}

describe('profiling', () => {
  it('infers quantitative, temporal and nominal fields', () => {
    const profiles = profileRows(rows);
    expect(profiles.find((profile) => profile.name === 'revenue')).toMatchObject({
      type: 'quantitative',
      min: 90,
      max: 150,
      negative: false,
    });
    expect(profiles.find((profile) => profile.name === 'month')?.type).toBe('temporal');
    expect(profiles.find((profile) => profile.name === 'region')?.type).toBe('nominal');
  });

  it('reads a period written as text as a time axis, because the formatting is the evidence', () => {
    // The census counted 223 corpus rows whose time column was typed as something else, and the
    // largest group was a month written as `Dec`: `ISO_DATE` only accepted `2026-01-01`, so a column
    // of month names was `nominal`, `shape.ordered` was empty, and every line and area label over it
    // was refused — 532 corpus rows, none of them ever answered. A string that is written as a
    // period is a period.
    expect(inferType(['Dec', 'Jan', 'Feb'])).toBe('temporal');
    expect(inferType(['December', 'Jan 2026', 'March 2014'])).toBe('temporal');
    expect(inferType(['Q1 2019', 'Q2 2019', 'Q3 2019'])).toBe('temporal');
    expect(inferType(['2019-01', '2019-02'])).toBe('temporal');
    expect(inferType(['2019-01-01', '2019-02-01'])).toBe('temporal');
    expect(inferType(['2019', '2020'])).toBe('temporal');
  });

  it('gives the same column the same type in both transports, because a column is not its formatting', () => {
    // This assertion used to read `[2019, 2020, 2021]` -> `quantitative`, defended by "a column of
    // prices in the 2000s is indistinguishable from a column of years". The row above shows what that
    // defence cost: `['2019', '2020']` was a time axis and `[2019, 2020]` was a measure, so the same
    // column typed two ways depending on whether the driver handed over a string or a number — and a
    // year handed over as a number lost the axis, which refuses every line, bar, pie and area drawn
    // over it. The census prices that: 182 corpus rows carry a calendar run, and typing it as time is
    // worth 53 rows gained against 4 lost, on both halves (20/29 against 0/0 by construction).
    expect(inferType([2019, 2020, 2021])).toBe('temporal');
    expect(inferType(['2019', '2020', '2021'])).toBe('temporal');
    // Written the other way round, which is how a result set orders its years descending.
    expect(inferType([2023, 2022, 2021, 2020])).toBe('temporal');
  });

  it('reads the run, not the magnitude, so a measure that lives in the same numbers stays a measure', () => {
    // The guard that makes the widening safe, stated as five ways to fail it. Every one of them is a
    // column whose values sit in the calendar window and none of them is a timeline: gaps, a fraction,
    // a repeat, a pair, and a run that starts before the window. A price column of `2019` dollars is
    // only indistinguishable from a year by its magnitude, and magnitude is exactly what this reads
    // last.
    expect(inferType([2018, 2020, 2022])).toBe('quantitative');
    expect(inferType([2019, 2019.5, 2020])).toBe('quantitative');
    expect(inferType([2019, 2019, 2020, 2020])).toBe('ordinal');
    expect(inferType([1999, 2000])).toBe('ordinal');
    expect(inferType([1899, 1900, 1901])).toBe('quantitative');
    expect(inferType([2100, 2101, 2102])).toBe('quantitative');
    // A missing value breaks the run: the column is not a year per row, and the string path applies
    // the same rule (`PERIOD` matches every value or the column is not a period).
    expect(inferType([2019, 2020, 2021, 2022, null])).toBe('quantitative');
  });

  it('leaves a label a label, so the widening cannot swallow it', () => {
    expect(inferType(['North', 'South'])).toBe('nominal');
    // A column that is half month and half region is a label column, not a broken axis.
    expect(inferType(['Dec', 'North'])).toBe('nominal');
  });

  it('treats low-cardinality numbers as ordinal', () => {
    expect(inferType([1, 2, 1, 2])).toBe('ordinal');
    expect(inferType([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe('quantitative');
  });

  it('counts distinct values and nulls', () => {
    const profiles = profileRows([
      { a: 'x', b: 1 },
      { a: 'x', b: null },
      { a: 'y', b: 2 },
    ]);
    expect(profiles.find((profile) => profile.name === 'a')).toMatchObject({ distinct: 2, nulls: 0 });
    expect(profiles.find((profile) => profile.name === 'b')).toMatchObject({ distinct: 2, nulls: 1 });
  });

  it('takes the column order the table has, not the order a record enumerates in', () => {
    // The bug this exists for: `2016` is an integer-like key, so the language enumerates it before
    // `country` no matter what the query selected. 389 of the corpus's 1,464 tables were read this
    // way, five of them chose an entirely empty year column as the category axis, and the figure
    // that came out was a bar chart of `[None, None, None]`.
    const rows = [
      { country: 'Armenia', '2016': null },
      { country: 'Belize', '2016': null },
    ];
    expect(Object.keys(rows[0] as object)).toEqual(['2016', 'country']);
    expect(profileRows(rows).map((profile) => profile.name)).toEqual(['2016', 'country']);
    expect(profileRows(rows, ['country', '2016']).map((profile) => profile.name)).toEqual(['country', '2016']);
  });

  it('drops a column the caller named but the rows do not have', () => {
    // A name without a column would profile as a column of nulls, which is not a column.
    expect(profileRows([{ a: 1 }], ['b', 'a']).map((profile) => profile.name)).toEqual(['a']);
  });

  it('never chooses a column whose every cell is null as the axis or the measure', () => {
    // A column of nothing is neither: choosing it draws bars against `[None, None, None]`, and the
    // mark is still right, so every label-based score is unmoved by the picture being empty.
    // Four distinct values, so `value` profiles as a measure: two values are an ordinal scale.
    const rows = [
      { country: 'Armenia', '2016': null, value: 73 },
      { country: 'Belize', '2016': null, value: 31 },
      { country: 'Kenya', '2016': null, value: 12 },
      { country: 'Mozambique', '2016': null, value: 28 },
    ];
    const ir = toChartIR('which country has the highest value', rows, { columns: ['2016', 'country', 'value'] });
    expect(ir.encoding.x).toMatchObject({ field: 'country' });
    expect(compileToMatplotlib(ir)).not.toContain('labels = [None');
  });

  it('returns nothing for an empty result set and falls back to nominal for all-null columns', () => {
    expect(profileRows([])).toEqual([]);
    expect(inferType([null, undefined])).toBe('nominal');
  });

  it('flags negative measures', () => {
    expect(profileRows([{ v: -1 }, { v: 2 }])[0]?.negative).toBe(true);
  });
});

describe('candidate enumeration', () => {
  const profiles = profileRows(rows);

  it('prefers a line for temporal x and keeps bar as an alternative', () => {
    const candidates = enumerateCandidates(profiles);
    expect(candidates[0]?.mark).toBe('line');
    expect(candidates.map((candidate) => candidate.mark)).toContain('bar');
  });

  it('adds a pie only when the category count is small', () => {
    expect(enumerateCandidates(profiles, 7).map((candidate) => candidate.mark)).toContain('pie');
    expect(enumerateCandidates(profiles, 1).map((candidate) => candidate.mark)).not.toContain('pie');
  });

  it('suppresses a pie when the measure has negative values', () => {
    const negative = profileRows([{ region: 'a', revenue: -1 }]);
    expect(enumerateCandidates(negative).map((candidate) => candidate.mark)).not.toContain('pie');
  });

  it('adds scatter for two measures and heatmap for two dimensions', () => {
    const marks = enumerateCandidates(profiles).map((candidate) => candidate.mark);
    expect(marks).toContain('scatter');
    expect(marks).toContain('heatmap');
  });

  it('returns nothing when there is no measure', () => {
    expect(enumerateCandidates(profileRows([{ a: 'x' }, { a: 'y' }]))).toEqual([]);
  });

  it('deduplicates and sorts by score then name', () => {
    const marks = enumerateCandidates(profiles).map((candidate) => candidate.mark);
    expect(new Set(marks).size).toBe(marks.length);
    const scores = enumerateCandidates(profiles).map((candidate) => candidate.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('offers a single bar for a scalar result', () => {
    expect(enumerateCandidates(profileRows([{ total: 42 }]))).toEqual([
      { mark: 'bar', score: 0.5, reason: 'single-measure-single-value' },
    ]);
  });
});

describe('lint', () => {
  it('passes a clean chart', () => {
    const clean = ir({ mark: 'line', encoding: { x: { field: 'month', type: 'temporal' }, y: { field: 'revenue', type: 'quantitative', aggregate: 'sum' } } });
    expect(lint(clean)).toEqual([]);
    expect(isRenderable(lint(clean))).toBe(true);
  });

  it('reports each of the fifteen rules', () => {
    const issues = new Set<string>();
    const collect = (chart: ChartIR): void => {
      for (const issue of lint(chart)) issues.add(issue.rule);
    };
    collect(ir({ mark: 'bar', data: [] }));
    collect(ir({ mark: 'pie', encoding: {} }));
    collect(ir({ mark: 'bar', title: undefined }));
    collect(ir({ mark: 'bar', alt: undefined }));
    collect(
      ir({
        mark: 'pie',
        encoding: { theta: { field: 'region', type: 'nominal' }, y: { field: 'revenue', type: 'quantitative' } },
        data: Array.from({ length: 9 }, (_, index) => ({ region: `r${index}`, revenue: index + 1 })),
      }),
    );
    collect(
      ir({
        mark: 'pie',
        encoding: { theta: { field: 'region', type: 'nominal' }, y: { field: 'revenue', type: 'quantitative' } },
        data: [{ region: 'a', revenue: -1 }],
      }),
    );
    collect(
      ir({
        mark: 'bar',
        encoding: {
          x: { field: 'region', type: 'nominal' },
          y: { field: 'revenue', type: 'quantitative', aggregate: 'sum' },
          series: { field: 'month', type: 'temporal' },
        },
        data: Array.from({ length: 10 }, (_, index) => ({ region: 'r', revenue: 1, month: `2026-01-${index + 10}` })),
      }),
    );
    collect(
      ir({
        mark: 'bar',
        encoding: { x: { field: 'region', type: 'nominal' }, y: { field: 'revenue', type: 'quantitative' } },
        data: Array.from({ length: 31 }, (_, index) => ({ region: `r${index}`, revenue: 1 })),
      }),
    );
    collect(ir({ mark: 'line', encoding: { x: { field: 'region', type: 'nominal' }, y: { field: 'revenue', type: 'quantitative' } } }));
    collect(ir({ mark: 'bar', encoding: { x: { field: 'revenue', type: 'quantitative' }, y: { field: 'revenue', type: 'quantitative' } } }));
    collect(ir({ mark: 'scatter', encoding: { x: { field: 'region', type: 'nominal' }, y: { field: 'revenue', type: 'quantitative' } } }));
    collect(ir({ mark: 'bar', encoding: { x: { field: 'region', type: 'nominal' }, y: { field: 'revenue', type: 'quantitative' } } }));
    collect(
      ir({
        mark: 'bar',
        theme: 'print',
        encoding: { x: { field: 'region', type: 'nominal' }, y: { field: 'revenue', type: 'quantitative', aggregate: 'sum' }, color: { field: 'region', type: 'nominal' } },
      }),
    );
    collect(
      ir({
        mark: 'boxplot',
        encoding: {
          x: { field: 'region', type: 'nominal' },
          y: [
            { field: 'revenue', type: 'quantitative' },
            { field: 'orders', type: 'quantitative' },
          ],
        },
      }),
    );
    collect(
      ir({
        mark: 'candlestick',
        encoding: {
          x: { field: 'region', type: 'nominal' },
          y: [
            { field: 'month', type: 'quantitative' },
            { field: 'region', type: 'quantitative' },
            { field: 'month', type: 'quantitative' },
            { field: 'region', type: 'quantitative' },
          ],
        },
      }),
    );
    expect([...issues].sort()).toEqual(
      [
        'bar-category-overflow',
        'duplicate-encoding',
        'empty-data',
        'line-x-not-temporal',
        'measure-without-aggregate',
        'missing-alt',
        'missing-title',
        'pie-negative-value',
        'pie-slice-overflow',
        'print-relies-on-color',
        'scatter-axis-not-quantitative',
        'series-overflow',
        'tuple-columns-missing',
        'tuple-not-numeric',
        'encoding-unsupported',
      ].sort(),
    );
  });

  it('treats errors as non-renderable and warnings as renderable', () => {
    expect(isRenderable([{ rule: 'missing-title', severity: 'warn', message: '' }])).toBe(true);
    expect(isRenderable([{ rule: 'empty-data', severity: 'error', message: '' }])).toBe(false);
  });
});

describe('ECharts compilation', () => {
  it('compiles a cartesian chart with axes and encoding', () => {
    const option = compileToECharts(ir({ mark: 'bar' }));
    expect(option.xAxis).toMatchObject({ type: 'time' });
    expect(option.yAxis).toMatchObject({ type: 'value' });
    expect(option.series).toEqual([{ type: 'bar', encode: { x: 'month', y: ['revenue'] } }]);
    expect(option.aria).toMatchObject({ enabled: true });
  });

  it('adds a visual map to a heatmap, and draws none when the IR names no measure for the colour', () => {
    const option = compileToECharts(
      ir({
        mark: 'heatmap',
        encoding: {
          x: { field: 'month', type: 'temporal' },
          y: [{ field: 'region', type: 'nominal' }],
          color: { field: 'revenue', type: 'quantitative' },
        },
      }),
    );
    expect(option.visualMap).toBeDefined();
    // Both axes of a heatmap are categories and the colour is the measure. The compiler used to fall
    // back to `y` for the value, so an IR with no colour drew a heatmap whose colour was the region
    // name — a picture of its own axis, which `supportOf` now refuses before any channel is read.
    const colourless = compileToECharts(ir({ mark: 'heatmap', encoding: { x: { field: 'month', type: 'temporal' } } }));
    expect(colourless.series).toEqual([]);
    expect(colourless.visualMap).toBeUndefined();
  });

  it('compiles a pie from the theta encoding', () => {
    const option = compileToECharts(
      ir({ mark: 'pie', encoding: { theta: { field: 'region', type: 'nominal' }, y: { field: 'revenue', type: 'quantitative' } } }),
    );
    expect(option.series).toEqual([
      {
        type: 'pie',
        name: 'Revenue',
        encode: { itemName: 'region', value: 'revenue' },
        data: [
          { name: 'north', value: 120 },
          { name: 'north', value: 150 },
          { name: 'south', value: 90 },
        ],
      },
    ]);
  });

  it('compiles a gauge with one value per row', () => {
    const option = compileToECharts(ir({ mark: 'gauge' }));
    expect(option.series).toEqual([
      {
        type: 'gauge',
        name: 'revenue',
        data: [
          { value: 120, name: 'revenue' },
          { value: 150, name: 'revenue' },
          { value: 90, name: 'revenue' },
        ],
      },
    ]);
  });

  it('compiles hierarchical and network marks', () => {
    expect(compileToECharts(ir({ mark: 'treemap', encoding: { x: { field: 'region', type: 'nominal' }, y: { field: 'revenue', type: 'quantitative' } } })).series).toEqual([
      { type: 'treemap', data: [{ name: 'north', value: 120 }, { name: 'north', value: 150 }, { name: 'south', value: 90 }] },
    ]);
    expect(
      compileToECharts(
        ir({
          mark: 'graph',
          encoding: {
            x: { field: 'region', type: 'nominal' },
            series: { field: 'month', type: 'temporal' },
            y: { field: 'revenue', type: 'quantitative' },
          },
        }),
      ).series,
    ).toEqual([
      {
        type: 'graph',
        layout: 'circular',
        roam: false,
        data: [{ name: 'north' }, { name: '2026-01-01' }, { name: '2026-02-01' }, { name: 'south' }, { name: '2026-03-01' }],
        links: [
          { source: 'north', target: '2026-01-01', value: 120 },
          { source: 'north', target: '2026-02-01', value: 150 },
          { source: 'south', target: '2026-03-01', value: 90 },
        ],
      },
    ]);
  });

  it('carries theme and size, and refuses to emit a custom series it cannot render', () => {
    const option = compileToECharts(ir({ mark: 'custom', theme: 'print', width: 640, height: 480 }));
    expect(option).toMatchObject({ theme: 'print', width: 640, height: 480 });
    // A custom series without renderItem throws "series.render is required", and a
    // function cannot travel in a strict IR. The compiler says so by carrying no
    // series; the caller adds one to the option it receives.
    expect(option.series).toEqual([]);
  });

  it('renders an empty title rather than omitting it', () => {
    const option = compileToECharts(ir({ mark: 'bar', title: undefined }));
    expect(option.title).toEqual({ text: '', subtext: '' });
  });
});

describe('lint against the mark contract', () => {
  const box = [
    { region: 'n', lo: 1, q1: 2, mid: 3, q3: 4, hi: 5 },
    { region: 's', lo: 2, q1: 3, mid: 4, q3: 5, hi: 6 },
  ];
  const q = (field: string) => ({ field, type: 'quantitative' as const });

  it('warns when a tuple mark is handed fewer columns than its shape needs', () => {
    // A candlestick needs four numbers; two of them draw a shape that is not a
    // candlestick, and nothing else in the pipeline would notice.
    const partial = ir({
      mark: 'candlestick',
      encoding: { x: { field: 'region', type: 'nominal' }, y: [q('lo'), q('q1')] },
      data: box,
    });
    expect(lint(partial).map((issue) => issue.rule)).toContain('tuple-columns-missing');
  });

  it('accepts a tuple mark with exactly its width', () => {
    const complete = ir({
      mark: 'boxplot',
      encoding: { x: { field: 'region', type: 'nominal' }, y: [q('lo'), q('q1'), q('mid'), q('q3'), q('hi')] },
      data: box,
    });
    expect(lint(complete).map((issue) => issue.rule)).not.toContain('tuple-columns-missing');
  });

  it('warns when the cells a shape reads are mostly not numbers', () => {
    // Strings in a quartile mean the columns were picked by name, not by meaning.
    const texty = ir({
      mark: 'boxplot',
      encoding: { x: { field: 'region', type: 'nominal' }, y: [q('lo'), q('q1'), q('mid'), q('q3'), q('hi')] },
      data: [
        { region: 'n', lo: 'a', q1: 'b', mid: 'c', q3: 4, hi: 5 },
        { region: 's', lo: 'd', q1: 'e', mid: 4, q3: 5, hi: 6 },
      ],
    });
    expect(lint(texty).map((issue) => issue.rule)).toContain('tuple-not-numeric');
  });

  it('stays quiet for a few nulls, which are missing values rather than a mis-encoding', () => {
    const sparse = ir({
      mark: 'boxplot',
      encoding: { x: { field: 'region', type: 'nominal' }, y: [q('lo'), q('q1'), q('mid'), q('q3'), q('hi')] },
      data: [
        { region: 'n', lo: 1, q1: 2, mid: 3, q3: 4, hi: 5 },
        { region: 's', lo: 2, q1: 3, mid: 4, q3: null, hi: 6 },
      ],
    });
    expect(lint(sparse).map((issue) => issue.rule)).not.toContain('tuple-not-numeric');
  });

  it('does not apply the tuple rules to marks without a tuple width', () => {
    const bar = ir({ mark: 'bar', encoding: { x: { field: 'region', type: 'nominal' }, y: q('lo') }, data: box });
    const rules = lint(bar).map((issue) => issue.rule);
    expect(rules).not.toContain('tuple-columns-missing');
    expect(rules).not.toContain('tuple-not-numeric');
  });
});
