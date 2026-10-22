import * as echarts from 'echarts';
import { beforeAll, describe, expect, it } from 'vitest';
import { SERIES_TYPES, type ChartIR, type ChartType } from '@agentix-e/nl2charts-spec';
import { compileToECharts, describeMark } from '../src/index.js';
import { CORE, FIXTURE_GEO, fixture } from './mark-fixtures.js';

const n = (field: string) => ({ field, type: 'nominal' as const });
const q = (field: string) => ({ field, type: 'quantitative' as const });

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

beforeAll(() => {
  // The library never ships geometry: a `map` series draws nothing until the
  // caller registers a name, so the suite registers a fixture instead of
  // pretending a world map is available.
  echarts.registerMap('fixture-geo', FIXTURE_GEO as never);
});

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
