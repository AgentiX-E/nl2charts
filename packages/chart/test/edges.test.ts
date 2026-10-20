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

  it('falls back to a generic series for a heatmap without two axes', () => {
    const option = compileToECharts(chart('heatmap', { x: { field: 'a', type: 'nominal' } }));
    expect(option.series).toEqual([{ type: 'heatmap', encode: { '0': 'a' } }]);
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
