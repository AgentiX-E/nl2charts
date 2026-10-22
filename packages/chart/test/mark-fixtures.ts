import type { ChartIR, ChartType } from '@agentix-e/nl2charts-spec';

/**
 * One fixture per series type, shared by the SSR and visual suites.
 *
 * Each mark needs its own encoding — a boxplot reads five columns, a candlestick
 * four, a river three — because a renderer handed the generic fixture would draw
 * a plausible picture of the wrong data. Keeping the fixtures in one place means
 * the baseline and the smoke test cannot drift apart.
 */
const rows = [
  { month: '2026-01-01', region: 'north', revenue: 120, orders: 12 },
  { month: '2026-02-01', region: 'north', revenue: 150, orders: 18 },
  { month: '2026-03-01', region: 'south', revenue: 90, orders: 9 },
  { month: '2026-04-01', region: 'south', revenue: 110, orders: 11 },
];

const boxRows = [
  { region: 'north', lo: 10, q1: 20, mid: 30, q3: 40, hi: 50 },
  { region: 'south', lo: 5, q1: 15, mid: 25, q3: 35, hi: 45 },
];

const candleRows = [
  { month: '2026-01-01', open: 10, close: 12, low: 9, high: 13 },
  { month: '2026-02-01', open: 12, close: 11, low: 10, high: 14 },
];

const q = (field: string) => ({ field, type: 'quantitative' as const });
const n = (field: string) => ({ field, type: 'nominal' as const });
const t = (field: string) => ({ field, type: 'temporal' as const });

/**
 * The 22 core ECharts series, spelled out. Adding a member to the union fails
 * here first, so a new chart cannot ship with an encoding no test has drawn.
 */
export const CORE: readonly ChartType[] = [
  'bar',
  'line',
  'pie',
  'scatter',
  'effectScatter',
  'radar',
  'tree',
  'treemap',
  'sunburst',
  'boxplot',
  'candlestick',
  'heatmap',
  'map',
  'parallel',
  'lines',
  'graph',
  'sankey',
  'funnel',
  'gauge',
  'pictorialBar',
  'themeRiver',
  'custom',
];

export function fixture(mark: ChartType, overrides: { revenue?: number } = {}): ChartIR {
  const data = overrides.revenue === undefined ? rows : rows.map((row) => ({ ...row, revenue: overrides.revenue as number }));
  const base = { version: '3.0' as const, mark, title: `SSR ${mark}`, alt: `${mark} chart` };
  switch (mark) {
    case 'boxplot':
      return { ...base, data: boxRows, encoding: { x: n('region'), y: [q('lo'), q('q1'), q('mid'), q('q3'), q('hi')] } };
    case 'candlestick':
      return { ...base, data: candleRows, encoding: { x: t('month'), y: [q('open'), q('close'), q('low'), q('high')] } };
    case 'themeRiver':
      return {
        ...base,
        data: data.map((row) => ({ month: row.month, value: row.revenue, region: row.region })),
        encoding: { x: t('month'), y: q('value'), series: n('region') },
      };
    case 'radar':
      return {
        ...base,
        data: data.map((row) => ({ metric: row.region, value: row.revenue })),
        encoding: { x: n('metric'), y: q('value') },
      };
    case 'parallel':
      return { ...base, data, encoding: { x: n('region'), y: [q('revenue'), q('orders')] } };
    case 'lines':
      return { ...base, data, encoding: { x: t('month'), y: q('revenue'), series: n('region') } };
    case 'map':
      return {
        ...base,
        map: 'fixture-geo',
        data: [{ region: 'north', revenue: 120 }],
        encoding: { x: n('region'), y: q('revenue') },
      };
    case 'heatmap':
      return { ...base, data, encoding: { x: n('region'), y: n('month'), color: q('revenue') } };
    default:
      return {
        ...base,
        data,
        encoding: {
          x: t('month'),
          y: q('revenue'),
          theta: n('region'),
          series: n('region'),
          color: n('region'),
          size: q('orders'),
        },
      };
  }
}

/** A one-region map, so a `map` series has geometry without shipping any. */
export const FIXTURE_GEO = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'north' },
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]] },
    },
  ],
} as const;
