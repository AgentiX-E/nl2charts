import * as echarts from 'echarts';
import { describe, expect, it } from 'vitest';
import type { ChartIR, ChartType } from '@agentix-e/nl2charts-spec';
import { compileToECharts } from '../src/index.js';

const data = [
  { month: '2026-01-01', region: 'north', revenue: 120, orders: 12 },
  { month: '2026-02-01', region: 'north', revenue: 150, orders: 18 },
  { month: '2026-03-01', region: 'south', revenue: 90, orders: 9 },
  { month: '2026-04-01', region: 'south', revenue: 110, orders: 11 },
];

function render(mark: ChartType): string {
  const isHeatmap = mark === 'heatmap';
  const ir: ChartIR = {
    version: '3.0',
    mark,
    encoding: isHeatmap
      ? {
          x: { field: 'region', type: 'nominal' },
          y: { field: 'month', type: 'nominal' },
          color: { field: 'revenue', type: 'quantitative' },
        }
      : {
          x: { field: 'month', type: 'temporal' },
          y: { field: 'revenue', type: 'quantitative', aggregate: 'sum' },
          theta: { field: 'region', type: 'nominal' },
          series: { field: 'region', type: 'nominal' },
          color: { field: 'region', type: 'nominal' },
        },
    data,
    title: `SSR ${mark}`,
    alt: `${mark} chart`,
  };
  const chart = echarts.init(null as unknown as HTMLElement, null, {
    renderer: 'svg',
    ssr: true,
    width: 480,
    height: 320,
  });
  try {
    chart.setOption(compileToECharts(ir));
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

describe('server-side rendering', () => {
  const SUPPORTED: readonly ChartType[] = [
    'bar',
    'line',
    'pie',
    'scatter',
    'effectScatter',
    'pictorialBar',
    'heatmap',
    'funnel',
    'gauge',
    'treemap',
    'sunburst',
    'tree',
    'graph',
    'sankey',
  ];

  it.each(SUPPORTED)('renders %s to SVG without throwing', (mark) => {
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
});
