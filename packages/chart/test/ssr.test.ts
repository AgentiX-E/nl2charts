import * as echarts from 'echarts';
import { beforeAll, describe, expect, it } from 'vitest';
import { SERIES_TYPES, type ChartIR, type ChartType } from '@agentix-e/nl2charts-spec';
import { compileToECharts, describeMark } from '../src/index.js';

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
 * One fixture per mark. Every chart type needs its own encoding: a boxplot reads
 * five columns, a candlestick four, a river three. A renderer handed the generic
 * fixture would produce a plausible picture of the wrong data, which is worse
 * than refusing to draw.
 */
function fixture(mark: ChartType): ChartIR {
  const base = { version: '3.0' as const, mark, title: `SSR ${mark}`, alt: `${mark} chart` };
  switch (mark) {
    case 'boxplot':
      return { ...base, data: boxRows, encoding: { x: n('region'), y: [q('lo'), q('q1'), q('mid'), q('q3'), q('hi')] } };
    case 'candlestick':
      return { ...base, data: candleRows, encoding: { x: t('month'), y: [q('open'), q('close'), q('low'), q('high')] } };
    case 'themeRiver':
      return {
        ...base,
        data: rows.map((row) => ({ month: row.month, value: row.revenue, region: row.region })),
        encoding: { x: t('month'), y: q('value'), series: n('region') },
      };
    case 'radar':
      return {
        ...base,
        data: rows.map((row) => ({ metric: row.region, value: row.revenue })),
        encoding: { x: n('metric'), y: q('value') },
      };
    case 'parallel':
      return { ...base, data: rows, encoding: { x: n('region'), y: [q('revenue'), q('orders')] } };
    case 'lines':
      return { ...base, data: rows, encoding: { x: t('month'), y: q('revenue'), series: n('region') } };
    case 'map':
      return {
        ...base,
        map: 'fixture-geo',
        data: [{ region: 'north', revenue: 120 }],
        encoding: { x: n('region'), y: q('revenue') },
      };
    case 'heatmap':
      return { ...base, data: rows, encoding: { x: n('region'), y: n('month'), color: q('revenue') } };
    default:
      return {
        ...base,
        data: rows,
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

/**
 * A one-region map. The library never ships geometry: a `map` series draws
 * nothing until the caller registers a name, so the suite registers a fixture
 * instead of pretending the world map is available.
 */
beforeAll(() => {
  echarts.registerMap('fixture-geo', {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'north' },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]] },
      },
    ],
  } as never);
});

function render(mark: ChartType): string {
  const chart = echarts.init(null as unknown as HTMLElement, null, {
    renderer: 'svg',
    ssr: true,
    width: 480,
    height: 320,
  });
  try {
    chart.setOption(compileToECharts(fixture(mark)));
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

/**
 * The 22 core ECharts series, spelled out. Kept literal on purpose: adding a
 * member to the union has to fail here first, so a new chart cannot ship with an
 * encoding this suite has never drawn. 14 of these were covered before this
 * iteration, and nothing compared the hand-written list with the union.
 */
const CORE: readonly ChartType[] = [
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

describe('server-side rendering', () => {
  it('draws the whole contract, and a new series type fails here first', () => {
    expect([...SERIES_TYPES]).toEqual([...CORE]);
  });

  it.each(CORE)('renders %s to SVG without throwing', (mark) => {
    const svg = render(mark);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
    expect(svg.length).toBeGreaterThan(200);
  });

  it('renders the title text into the SVG', () => {
    expect(render('bar')).toContain('SSR bar');
  });

  it('is deterministic for the same IR up to renderer-scoped ids', () => {
    const strip = (svg: string): string => svg.replace(/zr\d+|cls-\d+/g, 'id');
    expect(strip(render('line'))).toBe(strip(render('line')));
  });

  it('draws real geometry for the marks that carry their own data shape', () => {
    // A blank SVG is what a mis-encoded series looks like, so the assertion is
    // about drawn elements rather than about the call returning.
    for (const mark of ['boxplot', 'candlestick', 'themeRiver', 'parallel', 'radar'] as const) {
      expect(render(mark).match(/<path/g) ?? [], mark).not.toHaveLength(0);
    }
  });

  it('draws regions only when the caller supplied geometry', () => {
    expect(describeMark('map').requiresGeo).toBe(true);
    expect(render('map').match(/<path/g) ?? []).not.toHaveLength(0);
  });

  it('emits no series at all when a map has no geometry name', () => {
    // ECharts throws on an unregistered map, and inventing one would be a lie
    // about the data, so the compiler refuses to emit the series.
    const ir: ChartIR = {
      version: '3.0',
      mark: 'map',
      title: 'no geo',
      alt: 'a map without geometry',
      data: [{ region: 'north', revenue: 120 }],
      encoding: { x: n('region'), y: q('revenue') },
    };
    expect(compileToECharts(ir).series).toEqual([]);
  });
});
