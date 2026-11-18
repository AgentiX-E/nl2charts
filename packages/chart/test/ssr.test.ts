import * as echarts from 'echarts';
import { beforeAll, describe, expect, it } from 'vitest';
import { SERIES_TYPES, type ChartIR, type ChartType } from '@agentix-e/nl2charts-spec';
import { compileToECharts, describeMark } from '../src/index.js';
import { CORE, FIXTURE_GEO, fixture } from './mark-fixtures.js';

const n = (field: string) => ({ field, type: 'nominal' as const });
const q = (field: string) => ({ field, type: 'quantitative' as const });

function renderIR(ir: ChartIR): string {
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

function render(mark: ChartType): string {
  return renderIR(fixture(mark));
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

  it('draws one series per group the encoding names, and names each in the legend', () => {
    // The flat alternative — one series over every row, named after the column — draws a single line
    // that walks back and forth through the periods, and a legend that names `country` rather than
    // Oman and Samoa. The assertion is on the rendered picture because that is what a reader sees;
    // the option object only says what was asked for.
    const ir: ChartIR = {
      version: '3.0',
      mark: 'line',
      title: 'population by year',
      alt: 'population by year and country',
      encoding: { x: { field: 'year', type: 'temporal' }, y: [q('value')], series: n('country') },
      data: [
        { country: 'Oman', year: '2019', value: 1 },
        { country: 'Oman', year: '2020', value: 2 },
        { country: 'Samoa', year: '2019', value: 4 },
        { country: 'Samoa', year: '2020', value: 6 },
      ],
    };
    const svg = renderIR(ir);
    expect(svg).toContain('Oman');
    expect(svg).toContain('Samoa');
    expect(svg).not.toContain('country');
    expect((svg.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('groups bars as well as lines, and keeps a group whose rows are not contiguous', () => {
    const ir: ChartIR = {
      version: '3.0',
      mark: 'bar',
      title: 'population',
      alt: 'population by year and country',
      encoding: { x: { field: 'year', type: 'nominal' }, y: [q('value')], series: n('country') },
      // The rows of one series are interleaved with the other's, which is the order a melted table
      // arrives in when the query groups by period first.
      data: [
        { country: 'Oman', year: '2019', value: 1 },
        { country: 'Samoa', year: '2019', value: 4 },
        { country: 'Oman', year: '2020', value: 2 },
        { country: 'Samoa', year: '2020', value: 6 },
      ],
    };
    const svg = renderIR(ir);
    expect(svg).toContain('Oman');
    expect(svg).toContain('Samoa');
    expect((svg.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('leaves a chart without a series channel exactly as one series, as it always was', () => {
    const ir: ChartIR = {
      version: '3.0',
      mark: 'bar',
      title: 'by region',
      alt: 'by region',
      encoding: { x: n('region'), y: [q('total')] },
      data: [
        { region: 'north', total: 1 },
        { region: 'south', total: 2 },
      ],
    };
    expect(compileToECharts(ir).series).toHaveLength(1);
    expect(renderIR(ir)).not.toContain('legend');
  });
});
