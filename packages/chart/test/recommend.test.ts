import { describe, expect, it } from 'vitest';
import { SERIES_TYPES, isNl2ChartsError, parseChartIR } from '@agentix-e/nl2charts-spec';
import type { FieldProfile } from '../src/profile.js';
import { profileRows } from '../src/profile.js';
import { CHART_CUES, readCues, recommendChart, toChartIR } from '../src/recommend.js';
import { compileToECharts } from '../src/compile.js';
import { isRenderable, lint } from '../src/lint.js';

const rows = (spec: Record<string, readonly unknown[]>): Record<string, unknown>[] => {
  const keys = Object.keys(spec);
  const height = Math.max(...keys.map((key) => spec[key]?.length ?? 0));
  return Array.from({ length: height }, (_, index) =>
    Object.fromEntries(keys.map((key) => [key, spec[key]?.[index]])),
  );
};

const monthly = rows({
  month: ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'],
  revenue: [120, 150, 90, 210],
});
const regions = rows({
  region: ['north', 'south', 'west'],
  revenue: [120, 90, 60],
});
const products = rows({
  product: ['a', 'b', 'c', 'd'],
  revenue: [12, 30, 7, 21],
});
const twoMeasures = rows({
  price: [10, 12, 15, 20],
  rating: [4.1, 4.4, 3.9, 4.8],
});
const matrix = rows({
  region: ['north', 'north', 'south', 'south'],
  quarter: ['Q1', 'Q2', 'Q1', 'Q2'],
  revenue: [10, 12, 9, 11],
});
const fiveNumbers = rows({
  min: [1, 2, 3],
  q1: [4, 5, 6],
  median: [7, 8, 9],
  q3: [10, 11, 12],
  max: [13, 14, 15],
});
const ohlc = rows({
  day: ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'],
  open: [10, 11, 12, 13, 14.5, 15, 16, 17.5],
  close: [11, 12.5, 11, 14, 15.5, 16, 16.5, 18],
  low: [9, 10.5, 10, 12.5, 14, 14.5, 15.5, 17],
  high: [12, 13, 13, 14.5, 16, 16.5, 17, 19],
});
const stages = rows({
  stage: ['visit', 'signup', 'purchase'],
  users: [1000, 400, 90],
});
const metrics = rows({
  product: ['a', 'b', 'c'],
  revenue: [12, 30, 7],
  orders: [3, 8, 2],
  margin: [0.2, 0.35, 0.1],
});
const single = rows({ revenue: [42] });

const profiles = (data: readonly Record<string, unknown>[]): FieldProfile[] => profileRows(data);

describe('reading chart cues out of the question', () => {
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ['How did revenue trend over time?', ['trend']],
    ['Show the monthly revenue growth', ['trend']],
    ['What share of revenue does each region hold?', ['share']],
    ['Show the distribution of order values', ['distribution']],
    ['Is price correlated with rating?', ['correlation']],
    ['Top ten products by revenue', ['ranking']],
    ['Revenue by region and quarter', ['matrix']],
    ['How are we tracking against target this quarter?', ['progress']],
    ['Conversion funnel by stage', ['stages']],
    ['Compare the metrics in parallel across products', ['multi-metric']],
    ['Show a radar profile of the metrics', ['profile']],
    ['Daily open and close prices', ['volatility']],
  ];

  it.each(cases)('%s', (question, kinds) => {
    expect(readCues(question).map((cue) => cue.kind)).toEqual(kinds);
  });

  it('carries the phrase it matched, so the choice can be quoted back', () => {
    const [cue] = readCues('Top ten products by revenue');
    expect(cue?.phrase).toBe('top');
  });

  it('reads the same cues in Chinese, because the question is not always English', () => {
    expect(readCues('各区域销售额占比').map((cue) => cue.kind)).toEqual(['share']);
    expect(readCues('每月的销售趋势').map((cue) => cue.kind)).toEqual(['trend']);
  });

  it('finds nothing in a question that names no shape', () => {
    expect(readCues('How many orders shipped')).toEqual([]);
  });

  it('declares which marks every cue speaks for, and every one is in the contract', () => {
    for (const cue of CHART_CUES) {
      expect(cue.marks.length).toBeGreaterThan(0);
      for (const mark of cue.marks) expect(SERIES_TYPES).toContain(mark);
    }
  });
});

describe('recommending a chart from the question and the result set', () => {
  const cases: readonly (readonly [string, readonly Record<string, unknown>[], string])[] = [
    ['How did revenue trend over time?', monthly, 'line'],
    ['What share of revenue does each region hold?', regions, 'pie'],
    ['Top products by revenue', products, 'bar'],
    ['Is price correlated with rating?', twoMeasures, 'scatter'],
    ['Revenue by region and quarter', matrix, 'heatmap'],
    ['Show the distribution of order values', fiveNumbers, 'boxplot'],
    ['Daily open and close prices', ohlc, 'candlestick'],
    ['How are we tracking against target?', single, 'gauge'],
    ['Conversion funnel by stage', stages, 'funnel'],
    ['Compare the metrics in parallel across products', metrics, 'parallel'],
    ['Show a radar profile of the metrics per product', metrics, 'radar'],
  ];

  it.each(cases)('%s', (question, data, mark) => {
    const choice = recommendChart(question, profiles(data));
    expect(choice.recommendations[0]?.mark).toBe(mark);
  });

  it('still recommends on structure when the question names no shape at all', () => {
    const choice = recommendChart('How many orders shipped', profiles(regions));
    expect(choice.recommendations.map((item) => item.mark)).toContain('bar');
    expect(choice.recommendations[0]?.cues).toEqual([]);
  });

  it('scores with counted facts, not a hidden weight', () => {
    const choice = recommendChart('How did revenue trend over time?', profiles(monthly));
    const line = choice.recommendations.find((item) => item.mark === 'line');
    expect(line?.score).toBe(5);
    expect(line?.reasons).toEqual(['profile:ordered-axis-and-measure', 'cue:trend "trend"']);
  });

  it('is deterministic, including the order of equal scores', () => {
    const first = JSON.stringify(recommendChart('Revenue by region', profiles(regions)));
    const second = JSON.stringify(recommendChart('Revenue by region', profiles(regions)));
    expect(first).toBe(second);
  });

  it('never ranks a mark the data cannot encode, and says why it refused', () => {
    const choice = recommendChart('What share of revenue does each region hold?', profiles(regions));
    expect(choice.recommendations.map((item) => item.mark)).not.toContain('scatter');
    expect(choice.refused.find((item) => item.mark === 'scatter')?.reason).toBe('a scatter needs two measures');
    expect(choice.refused.find((item) => item.mark === 'gauge')?.reason).toBe(
      'a gauge needs exactly one measure and no category axis',
    );
  });

  it('refuses a pie over a negative measure even when the question asks for a share', () => {
    const negative = rows({ region: ['north', 'south'], revenue: [-5, 20] });
    const choice = recommendChart('What share of revenue does each region hold?', profiles(negative));
    expect(choice.recommendations.map((item) => item.mark)).not.toContain('pie');
    expect(choice.refused.find((item) => item.mark === 'pie')?.reason).toBe(
      'a pie needs one category of at most 7 slices, none of them negative',
    );
  });

  it('refuses a pie over more slices than a reader can name', () => {
    const wide = rows({
      region: Array.from({ length: 9 }, (_, index) => `r${String(index)}`),
      revenue: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    });
    const choice = recommendChart('Share of revenue by region', profiles(wide));
    expect(choice.recommendations.map((item) => item.mark)).not.toContain('pie');
    expect(choice.refused.find((item) => item.mark === 'pie')?.reason).toContain('at most 7 slices');
  });

  it('refuses every mark when the result set carries no measure', () => {
    const names = rows({ product: ['a', 'b'], region: ['north', 'south'] });
    const choice = recommendChart('Which products are there?', profiles(names));
    expect(choice.recommendations).toEqual([]);
    expect(choice.refused.length).toBeGreaterThan(0);
  });

  it('lists a refusal for every mark it considered, so the audit trail is complete', () => {
    const choice = recommendChart('Top products by revenue', profiles(products));
    const seen = new Set([...choice.recommendations.map((item) => item.mark), ...choice.refused.map((item) => item.mark)]);
    expect(seen).toEqual(new Set(['bar', 'line', 'pie', 'funnel', 'scatter', 'heatmap', 'boxplot', 'candlestick', 'radar', 'parallel', 'gauge']));
  });

  it('records the cue that moved each mark, and only marks the cue speaks for', () => {
    const choice = recommendChart('Conversion funnel by stage', profiles(stages));
    const funnel = choice.recommendations.find((item) => item.mark === 'funnel');
    const pie = choice.recommendations.find((item) => item.mark === 'pie');
    expect(funnel?.cues).toEqual(['stages']);
    expect(pie?.cues).toEqual([]);
  });
});

describe('turning a recommendation into a chart the compiler accepts', () => {
  it('builds a contract-valid IR whose title is the question and whose alt names the mark', () => {
    const question = 'How did revenue trend over time?';
    const ir = toChartIR(question, monthly);
    expect(parseChartIR(ir).mark).toBe('line');
    expect(ir.title).toBe(question);
    expect(ir.alt).toContain('line');
    expect(ir.encoding.x).toMatchObject({ field: 'month', type: 'temporal' });
    expect(ir.data.length).toBe(monthly.length);
  });

  it('lints clean and compiles to a series for every recommendation it will make', () => {
    const fixtures: readonly (readonly [string, readonly Record<string, unknown>[]])[] = [
      ['How did revenue trend over time?', monthly],
      ['What share of revenue does each region hold?', regions],
      ['Top products by revenue', products],
      ['Is price correlated with rating?', twoMeasures],
      ['Revenue by region and quarter', matrix],
      ['Show the distribution of order values', fiveNumbers],
      ['Daily open and close prices', ohlc],
      ['How are we tracking against target?', single],
      ['Conversion funnel by stage', stages],
      ['Compare the metrics in parallel across products', metrics],
      ['Show a radar profile of the metrics per product', metrics],
    ];
    for (const [question, data] of fixtures) {
      const ir = toChartIR(question, data);
      const issues = lint(ir);
      expect({ question, errors: issues.filter((issue) => issue.severity === 'error') }).toEqual({
        question,
        errors: [],
      });
      expect(isRenderable(issues)).toBe(true);
      const option = compileToECharts(ir) as { series?: { type?: string }[] };
      expect(option.series?.[0]?.type).toBe(ir.mark);
    }
  });

  it('orders the candlestick tuple the way the renderer reads it, whatever the column order', () => {
    const shuffled = rows({
      day: ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06'],
      close: [11, 12.5, 11, 14, 15.5, 16],
      high: [12, 13, 13, 14.5, 16, 16.5],
      open: [10, 11, 12, 13, 14.5, 15],
      low: [9, 10.5, 10, 12.5, 14, 14.5],
    });
    const ir = toChartIR('Daily open and close prices', shuffled);
    expect(ir.mark).toBe('candlestick');
    const y = Array.isArray(ir.encoding.y) ? ir.encoding.y : [ir.encoding.y];
    expect(y.map((ref) => ref?.field)).toEqual(['open', 'close', 'low', 'high']);
  });

  it('caps the rows it will carry, because the contract refuses more than fifty thousand', () => {
    const big = rows({ region: Array.from({ length: 5 }, (_, index) => `r${String(index)}`), revenue: [1, 2, 3, 4, 5] });
    const ir = toChartIR('Top regions by revenue', big, { limit: 2 });
    expect(ir.data.length).toBe(2);
  });

  it('honours an explicit title, alt and theme', () => {
    const ir = toChartIR('Top products by revenue', products, { title: 'Revenue', alt: 'Bars', theme: 'print' });
    expect(ir).toMatchObject({ title: 'Revenue', alt: 'Bars', theme: 'print' });
  });

  it('carries a subtitle when the caller has one', () => {
    const ir = toChartIR('Top products by revenue', products, { subtitle: 'fiscal 2026' });
    expect(ir.subtitle).toBe('fiscal 2026');
  });

  it('takes the slice limit from the caller, because readability is a deployment decision', () => {
    const wide = rows({
      region: Array.from({ length: 9 }, (_, index) => `r${String(index)}`),
      revenue: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    });
    const choice = recommendChart('Share of revenue by region', profiles(wide), { maxSlices: 9 });
    expect(choice.recommendations[0]?.mark).toBe('pie');
  });

  it('refuses an empty result set instead of emitting a chart of nothing', () => {
    expect(() => toChartIR('Top products by revenue', [])).toThrow(/empty/);
    try {
      toChartIR('Top products by revenue', []);
    } catch (error) {
      expect(isNl2ChartsError(error) && error.code).toBe('NL2C_E_NOT_SUPPORTED');
    }
  });

  it('refuses a result set no mark can encode, and names the columns it saw', () => {
    const names = rows({ product: ['a', 'b'], region: ['north', 'south'] });
    expect(() => toChartIR('Which products are there?', names)).toThrow(/no chart fits/);
  });

  it('rejects a limit that is not a positive whole number of rows', () => {
    expect(() => toChartIR('Top products by revenue', products, { limit: 0 })).toThrow(/limit/);
  });
});

describe('the properties every recommendation has to hold, over generated result sets', () => {
  const random = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  };

  const column = (next: () => number, index: number): { name: string; values: unknown[] } => {
    const kind = Math.floor(next() * 4);
    const height = 2 + Math.floor(next() * 8);
    if (kind === 0) {
      return {
        name: `date${String(index)}`,
        values: Array.from({ length: height }, (_, row) => `2026-0${String(1 + (row % 9))}-01`),
      };
    }
    if (kind === 1) {
      const width = 2 + Math.floor(next() * 9);
      return {
        name: `label${String(index)}`,
        values: Array.from({ length: height }, (_, row) => `v${String(row % width)}`),
      };
    }
    if (kind === 2) {
      return {
        name: `amount${String(index)}`,
        values: Array.from({ length: height }, () => Math.round(next() * 1000) / 10 - (next() < 0.15 ? 500 : 0)),
      };
    }
    return {
      name: `count${String(index)}`,
      values: Array.from({ length: height }, () => 1 + Math.floor(next() * 5)),
    };
  };

  it('holds on 120 generated result sets', () => {
    const next = random(20261112);
    for (let trial = 0; trial < 120; trial += 1) {
      const width = 1 + Math.floor(next() * 6);
      const columns = Array.from({ length: width }, (_, index) => column(next, index));
      const data = rows(Object.fromEntries(columns.map((entry) => [entry.name, entry.values])));
      const question = 'Show me what is going on';
      const choice = recommendChart(question, profiles(data));
      for (const item of choice.recommendations) {
        expect(SERIES_TYPES).toContain(item.mark);
        expect(Number.isInteger(item.score)).toBe(true);
        expect(item.reasons.length).toBeGreaterThan(0);
      }
      if (choice.recommendations.length === 0) {
        expect(() => toChartIR(question, data)).toThrow();
        continue;
      }
      const ir = toChartIR(question, data);
      expect(lint(ir).filter((issue) => issue.severity === 'error')).toEqual([]);
      expect(() => compileToECharts(ir)).not.toThrow();
      expect(JSON.stringify(recommendChart(question, profiles(data)))).toBe(JSON.stringify(choice));
    }
  });
});
