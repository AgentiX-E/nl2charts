import { describe, expect, it } from 'vitest';
import type { ChartIR } from '@agentix-e/nl2charts-spec';
import { compileToECharts, lint, profileRows, refFor } from '../src/index.js';

const data = [{ a: 'x', b: 1, c: 2 }];

function chart(mark: ChartIR['mark'], encoding: ChartIR['encoding'], extra: Partial<ChartIR> = {}): ChartIR {
  return { version: '3.0', mark, encoding, data, ...extra };
}

describe('compilation edges', () => {
  it('defaults both axes to category when nothing is encoded', () => {
    const option = compileToECharts(chart('bar', {}));
    expect(option.xAxis).toEqual({ type: 'category' });
    expect(option.yAxis).toEqual({ type: 'category' });
    expect(option.series).toEqual([{ type: 'bar', encode: { x: undefined, y: [] } }]);
  });

  it('uses a value axis for a quantitative x', () => {
    const option = compileToECharts(chart('bar', { x: { field: 'b', type: 'quantitative' } }));
    expect(option.xAxis).toEqual({ type: 'value', name: 'b' });
  });

  it('accepts a list of y encodings', () => {
    const option = compileToECharts(
      chart('bar', {
        x: { field: 'a', type: 'nominal' },
        y: [
          { field: 'b', type: 'quantitative' },
          { field: 'c', type: 'quantitative' },
        ],
      }),
    );
    expect(option.series).toEqual([{ type: 'bar', encode: { x: 'a', y: ['b', 'c'] } }]);
  });

  it('falls back to the x field when a gauge has no y', () => {
    const option = compileToECharts(chart('gauge', { x: { field: 'b', type: 'quantitative' } }));
    expect(option.series).toEqual([{ type: 'gauge', name: 'b', data: [{ value: 1, name: 'b' }] }]);
  });

  it('emits placeholders when a gauge has no measure at all', () => {
    const option = compileToECharts(chart('gauge', {}));
    expect(option.series).toEqual([{ type: 'gauge', name: 'value', data: [{ value: null, name: 'value' }] }]);
  });

  it('emits placeholders for a pie without encodings', () => {
    const option = compileToECharts(chart('pie', {}));
    expect(option.series).toEqual([
      { type: 'pie', name: 'pie', encode: { itemName: undefined, value: undefined }, data: [{ name: '', value: null }] },
    ]);
  });

  it('draws nothing for a heatmap without two axes', () => {
    // A matrix needs two dimensions. Emitting `{type: 'heatmap'}` with one axis
    // gives an empty grid that looks like a rendering bug rather than a chart the
    // data cannot support.
    const option = compileToECharts(chart('heatmap', { x: { field: 'a', type: 'nominal' } }));
    expect(option.series).toEqual([]);
    expect(option.visualMap).toBeUndefined();
  });

  it('clamps an all-non-numeric heatmap to a unit range', () => {
    const option = compileToECharts(
      chart('heatmap', {
        x: { field: 'a', type: 'nominal' },
        y: { field: 'a', type: 'nominal' },
        color: { field: 'a', type: 'nominal' },
      }),
    );
    expect(option.visualMap).toEqual({ min: 0, max: 1, calculable: false });
  });

  it('emits an empty graph when the endpoints are not encoded', () => {
    const option = compileToECharts(chart('graph', {}));
    expect(option.series).toEqual([{ type: 'graph', layout: 'force', roam: false, data: [], links: [] }]);
  });

  it('omits the aria description when there is no alt text and keeps a subtitle', () => {
    const option = compileToECharts(chart('bar', {}, { subtitle: 'since 2020' }));
    expect(option.aria).toEqual({ enabled: true, label: { description: '' } });
    expect(option.title).toEqual({ text: '', subtext: 'since 2020' });
  });
});

describe('lint edges', () => {
  it('handles a pie without a theta encoding', () => {
    expect(lint(chart('pie', {}, { title: 't', alt: 'a' }))).toEqual([]);
  });

  it('handles a funnel whose value comes only from colour', () => {
    const issues = lint(
      chart('funnel', { theta: { field: 'a', type: 'nominal' }, color: { field: 'b', type: 'quantitative' } }, { title: 't', alt: 'a' }),
    );
    expect(issues.map((issue) => issue.rule)).not.toContain('pie-negative-value');
  });

  it('accepts a scatter without an explicit x but with a quantitative y', () => {
    const issues = lint(chart('scatter', { y: { field: 'b', type: 'quantitative' } }, { title: 't', alt: 'a' }));
    expect(issues.map((issue) => issue.rule)).toContain('scatter-axis-not-quantitative');
  });

  it('detects duplicate fields across list encodings', () => {
    const issues = lint(
      chart(
        'bar',
        { x: { field: 'b', type: 'quantitative' }, y: [{ field: 'b', type: 'quantitative', aggregate: 'sum' }, { field: 'b', type: 'quantitative', aggregate: 'sum' }] },
        { title: 't', alt: 'a' },
      ),
    );
    expect(issues.map((issue) => issue.rule)).toContain('duplicate-encoding');
  });
});

describe('field references', () => {
  it('derives a reference from the profile and carries an aggregate', () => {
    const profiles = profileRows(data);
    expect(refFor('b', profiles, 'sum')).toEqual({ field: 'b', type: 'quantitative', aggregate: 'sum' });
    expect(refFor('missing', profiles)).toEqual({ field: 'missing', type: 'nominal' });
  });
});

describe('specialised marks', () => {
  const num = (field: string) => ({ field, type: 'quantitative' as const });
  const nom = (field: string) => ({ field, type: 'nominal' as const });
  const box = [
    { region: 'n', lo: 1, q1: 2, mid: 3, q3: 4, hi: 5 },
    { region: 's', lo: 2, q1: 3, mid: 4, q3: 'n/a', hi: 6 },
  ];
  const series0 = (option: { series?: unknown }): Record<string, unknown>[] => option.series as Record<string, unknown>[];

  it('reads one cell per tuple column and nulls a cell it cannot measure', () => {
    const option = compileToECharts({
      version: '3.0',
      mark: 'boxplot',
      encoding: { x: nom('region'), y: [num('lo'), num('q1'), num('mid'), num('q3'), num('hi')] },
      data: box,
    });
    expect(option.yAxis).toEqual({ type: 'value' });
    expect(series0(option)[0]?.data).toEqual([
      [1, 2, 3, 4, 5],
      [2, 3, 4, null, 6],
    ]);
  });

  it('emits the cells it was given when fewer tuple columns are encoded', () => {
    // Two of four candlestick columns: the chart draws less, not something else.
    const option = compileToECharts({
      version: '3.0',
      mark: 'candlestick',
      encoding: { x: nom('region'), y: [num('lo'), num('q1')] },
      data: box,
    });
    expect(series0(option)[0]?.data).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });

  it('names a tuple chart after its mark when there is no title', () => {
    const option = compileToECharts({
      version: '3.0',
      mark: 'boxplot',
      encoding: { x: nom('region'), y: [num('lo'), num('q1'), num('mid'), num('q3'), num('hi')] },
      data: box,
    });
    expect(series0(option)[0]?.name).toBe('boxplot');
  });

  it('takes the river category from colour when no series channel is given', () => {
    const option = compileToECharts({
      version: '3.0',
      mark: 'themeRiver',
      encoding: { x: nom('region'), y: num('lo'), color: nom('region') },
      data: [{ region: 'n', lo: 1 }],
    });
    expect(series0(option)[0]?.data).toEqual([['n', 1, 'n']]);
  });

  it('draws no river without a category to stack', () => {
    const option = compileToECharts(chart('themeRiver', { x: nom('a'), y: num('b') }));
    expect(option.series).toEqual([]);
  });

  it('builds one radar polygon per series group and nulls a missing metric', () => {
    const option = compileToECharts({
      version: '3.0',
      mark: 'radar',
      title: 'profile',
      encoding: { theta: nom('metric'), y: num('value'), series: nom('team') },
      data: [
        { metric: 'speed', value: 10, team: 'a' },
        { metric: 'cost', value: 4, team: 'a' },
        { metric: 'speed', value: 7, team: 'b' },
      ],
    });
    const radar = option.radar as { indicator: { name: string; max: number }[] };
    expect(radar.indicator.map((entry) => entry.name)).toEqual(['speed', 'cost']);
    expect(radar.indicator.map((entry) => entry.max)).toEqual([10, 4]);
    const series = series0(option);
    expect(series).toHaveLength(2);
    expect(series[0]?.name).toBe('a');
    expect((series[0]?.data as { value: unknown[] }[])[0]?.value).toEqual([10, 4]);
    // `cost` has no row for team b; a zero would draw a spike that does not exist.
    expect((series[1]?.data as { value: unknown[] }[])[0]?.value).toEqual([7, null]);
  });

  it('keeps a radar maximum above zero so an all-zero metric still divides', () => {
    const option = compileToECharts({
      version: '3.0',
      mark: 'radar',
      encoding: { x: nom('metric'), y: num('value') },
      data: [{ metric: 'a', value: 0 }],
    });
    expect((option.radar as { indicator: { max: number }[] }).indicator[0]?.max).toBe(1);
    expect(series0(option)[0]?.name).toBeUndefined();
  });

  it('draws no radar without a measure', () => {
    expect(compileToECharts(chart('radar', { x: nom('a') })).series).toEqual([]);
  });

  it('builds a parallel axis per measure, with the category axis first', () => {
    const option = compileToECharts({
      version: '3.0',
      mark: 'parallel',
      encoding: { x: nom('region'), y: [num('lo'), num('hi')] },
      data: box,
    });
    const axes = option.parallelAxis as { name: string; type: string; data?: string[] }[];
    expect(axes.map((axis) => [axis.name, axis.type])).toEqual([
      ['region', 'category'],
      ['lo', 'value'],
      ['hi', 'value'],
    ]);
    expect(axes[0]?.data).toEqual(['n', 's']);
    expect(series0(option)[0]?.data).toEqual([
      ['n', 1, 5],
      ['s', 2, 6],
    ]);
  });

  it('omits the category axis when a parallel chart has no x', () => {
    const option = compileToECharts({
      version: '3.0',
      mark: 'parallel',
      encoding: { y: [num('lo'), num('hi')] },
      data: box,
    });
    expect((option.parallelAxis as { name: string }[]).map((axis) => axis.name)).toEqual(['lo', 'hi']);
    expect(series0(option)[0]?.data).toEqual([
      [1, 5],
      [2, 6],
    ]);
  });

  it('draws no parallel chart with a single axis', () => {
    expect(compileToECharts(chart('parallel', { y: num('b') })).series).toEqual([]);
  });

  it('splits lines into one polyline per group', () => {
    const option = compileToECharts({
      version: '3.0',
      mark: 'lines',
      title: 'routes',
      encoding: { x: nom('region'), y: num('lo'), series: nom('region') },
      data: box,
    });
    const series = series0(option);
    expect(series).toHaveLength(2);
    expect(series[0]?.name).toBe('n');
    expect(series[0]?.coordinateSystem).toBe('cartesian2d');
    expect((series[0]?.data as { coords: unknown[][] }[])[0]?.coords).toEqual([['n', 1]]);
  });

  it('draws lines without a group as a single polyline', () => {
    const option = compileToECharts({
      version: '3.0',
      mark: 'lines',
      encoding: { x: nom('region'), y: num('lo') },
      data: box,
    });
    expect(series0(option)).toHaveLength(1);
    expect((series0(option)[0]?.data as { coords: unknown[][] }[])[0]?.coords).toEqual([
      ['n', 1],
      ['s', 2],
    ]);
  });

  it('draws no lines without an x axis', () => {
    expect(compileToECharts(chart('lines', { y: num('b') })).series).toEqual([]);
  });

  it('takes a map name from theta and omits a value it was not given', () => {
    const option = compileToECharts({
      version: '3.0',
      mark: 'map',
      map: 'geo',
      encoding: { theta: nom('region') },
      data: [{ region: 'n' }],
    });
    expect(series0(option)[0]).toMatchObject({ type: 'map', map: 'geo', data: [{ name: 'n' }] });
  });

  it('emits an empty map data list when no region field is encoded', () => {
    const option = compileToECharts({ version: '3.0', mark: 'map', map: 'geo', encoding: {}, data: [{ a: 'n' }] });
    expect(series0(option)[0]?.data).toEqual([]);
  });

  it('reads the first axis when x is given as a list', () => {
    const option = compileToECharts({
      version: '3.0',
      mark: 'bar',
      encoding: { x: [nom('region'), nom('lo')], y: num('hi') },
      data: box,
    });
    expect(option.xAxis).toEqual({ type: 'category', name: 'region' });
  });
});
