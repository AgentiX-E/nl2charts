import { describe, expect, it } from 'vitest';
import type { ChartIR } from '@agentix-e/nl2charts-spec';
import { compileToECharts, enumerateCandidates, inferType, isRenderable, lint, profileRows } from '../src/index.js';

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

  it('reports each of the twelve rules', () => {
    const issues = new Set<string>();
    const collect = (chart: ChartIR): void => {
      for (const issue of lint(chart)) issues.add(issue.rule);
    };
    collect(ir({ mark: 'bar', data: [] }));
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

  it('adds a visual map to a heatmap', () => {
    const option = compileToECharts(ir({ mark: 'heatmap' }));
    expect(option.visualMap).toBeDefined();
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
        layout: 'force',
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

  it('carries theme, size and a custom fallback', () => {
    const option = compileToECharts(ir({ mark: 'custom', theme: 'print', width: 640, height: 480 }));
    expect(option).toMatchObject({ theme: 'print', width: 640, height: 480 });
    expect(option.series).toEqual([{ type: 'custom', encode: { '0': 'month', '1': 'revenue' } }]);
  });

  it('renders an empty title rather than omitting it', () => {
    const option = compileToECharts(ir({ mark: 'bar', title: undefined }));
    expect(option.title).toEqual({ text: '', subtext: '' });
  });
});
