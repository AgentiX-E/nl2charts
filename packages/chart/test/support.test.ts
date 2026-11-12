import { describe, expect, it } from 'vitest';
import type { ChartIR, ChartType, FieldRef } from '@agentix-e/nl2charts-spec';
import { SERIES_TYPES } from '@agentix-e/nl2charts-spec';
import { compileToECharts, isRenderable, lint, supportOf } from '../src/index.js';
import { CORE, fixture } from './mark-fixtures.js';

const rows = [
  { a: 'north', b: 1, c: 2, d: 3, e: 4, f: 5, t: '2026-01-01' },
  { a: 'south', b: 6, c: 7, d: 8, e: 9, f: 10, t: '2026-02-01' },
];

const q = (field: string): FieldRef => ({ field, type: 'quantitative' });
const n = (field: string): FieldRef => ({ field, type: 'nominal' });

const ir = (mark: ChartType, encoding: ChartIR['encoding'], extra: Partial<ChartIR> = {}): ChartIR => ({
  version: '3.0',
  mark,
  encoding,
  data: rows,
  title: 'support',
  alt: 'support matrix',
  ...extra,
});

/**
 * Encoding shapes a caller can plausibly hand the compiler. They are not
 * exhaustive over the channel lattice — 2^6 x 22 would be a fuzz run, not a
 * readable matrix — but each one isolates a precondition a branch reads: a
 * category, a measure, two axes, a tuple, a group, a matrix.
 */
const SHAPES: Readonly<Record<string, ChartIR['encoding']>> = {
  none: {},
  xOnly: { x: n('a') },
  yOnly: { y: q('b') },
  xAndY: { x: n('a'), y: q('b') },
  twoY: { y: [q('b'), q('c')] },
  fourY: { x: n('a'), y: [q('b'), q('c'), q('d'), q('e')] },
  fiveY: { x: n('a'), y: [q('b'), q('c'), q('d'), q('e'), q('f')] },
  grouped: { x: n('a'), y: q('b'), series: n('a') },
  radial: { theta: n('a'), y: q('b') },
  matrix: { x: n('a'), y: n('a'), color: q('b') },
  river: { x: n('t'), y: q('b'), series: n('a') },
};

const seriesOf = (chart: ChartIR): unknown[] => (compileToECharts(chart).series as unknown[] | undefined) ?? [];

describe('the support matrix', () => {
  it('is total over the contract: every mark answers, for every shape', () => {
    for (const mark of SERIES_TYPES) {
      for (const [shape, encoding] of Object.entries(SHAPES)) {
        const verdict = supportOf(ir(mark, encoding));
        // A verdict with neither approval nor a reason is the failure this whole
        // layer exists to prevent: a caller cannot tell it from a chart of nothing.
        expect(verdict.supported || verdict.missing.length > 0, `${mark}/${shape}`).toBe(true);
        expect(verdict.missing.length === 0, `${mark}/${shape}`).toBe(verdict.supported);
      }
    }
  });

  it('agrees with the compiler on all 242 mark-shape pairs', () => {
    // The invariant, both directions. If the compiler emits a series the verdict
    // called impossible, the compiler is reading a channel nobody verified; if it
    // emits none the verdict called possible, a supported chart silently vanished.
    for (const mark of SERIES_TYPES) {
      for (const [shape, encoding] of Object.entries(SHAPES)) {
        const chart = ir(mark, encoding);
        const { supported } = supportOf(chart);
        expect(seriesOf(chart).length > 0, `${mark}/${shape} supported=${supported}`).toBe(supported);
      }
    }
  });

  it('agrees with the linter, so "renderable" means "the compiler will draw it"', () => {
    for (const mark of SERIES_TYPES) {
      for (const [shape, encoding] of Object.entries(SHAPES)) {
        const chart = ir(mark, encoding);
        const rules = lint(chart).map((issue) => issue.rule);
        const reported = rules.includes('encoding-unsupported');
        expect(reported, `${mark}/${shape}`).toBe(!supportOf(chart).supported);
        // And the promise callers actually rely on: a chart the linter clears with
        // no errors must produce a series when compiled.
        if (isRenderable(lint(chart))) expect(seriesOf(chart).length, `${mark}/${shape}`).toBeGreaterThan(0);
      }
    }
  });

  it('draws every mark that carries a fixture of its own', () => {
    // The fixtures live beside the SSR suite, so this also pins that the two
    // definitions of "a complete encoding" have not drifted apart.
    for (const mark of CORE) {
      if (mark === 'custom') continue;
      expect(supportOf(fixture(mark)), mark).toEqual({ supported: true, missing: [] });
    }
  });

  it('refuses the one mark whose gap is a function rather than a channel', () => {
    const verdict = supportOf(fixture('custom'));
    expect(verdict.supported).toBe(false);
    expect(verdict.missing).toEqual([
      'a custom series needs a renderItem function, which a serialisable contract cannot carry',
    ]);
    // It refuses while still carrying a complete encoding, which is why the
    // compiler treats it apart from the channel gaps.
    expect(fixture('custom').encoding.y).toBeDefined();
  });
});

describe('what each family reads', () => {
  it('lets a gauge read a value and no category', () => {
    expect(supportOf(ir('gauge', { y: q('b') })).supported).toBe(true);
    expect(supportOf(ir('gauge', { theta: q('b') })).supported).toBe(true);
    expect(supportOf(ir('gauge', { x: q('b') })).supported).toBe(true);
    expect(supportOf(ir('gauge', {})).supported).toBe(false);
  });

  it('needs both axes of a matrix, not just one plus a colour', () => {
    expect(supportOf(ir('heatmap', { x: n('a'), y: n('a'), color: q('b') })).supported).toBe(true);
    expect(supportOf(ir('heatmap', { x: n('a'), color: q('b') })).missing).toEqual([
      'a heatmap needs a column for y and was given none',
    ]);
    expect(supportOf(ir('heatmap', { y: n('a'), color: q('b') })).missing).toEqual([
      'a heatmap needs a column for x and was given none',
    ]);
  });

  it('counts the axes of a parallel plot, because one axis is a scatter', () => {
    expect(supportOf(ir('parallel', { y: [q('b'), q('c')] })).supported).toBe(true);
    expect(supportOf(ir('parallel', { x: n('a'), y: q('b') })).supported).toBe(true);
    expect(supportOf(ir('parallel', { y: q('b') })).missing).toEqual([
      'a parallel coordinate plot needs two axes and was given 1',
    ]);
    expect(supportOf(ir('parallel', { x: n('a') })).missing).toEqual([
      'a parallel coordinate plot needs two axes and was given 1',
    ]);
  });

  it('reads a river from three channels rather than three columns', () => {
    expect(supportOf(ir('themeRiver', { x: n('t'), y: q('b'), series: n('a') })).supported).toBe(true);
    expect(supportOf(ir('themeRiver', { x: n('t'), y: q('b'), color: n('a') })).supported).toBe(true);
    expect(supportOf(ir('themeRiver', { x: n('t'), y: q('b') })).missing).toEqual([
      'a theme river needs a category to stack, from series or color, and was given none',
    ]);
  });

  it('counts the tuple columns a mark reads, because ECharts reads them by position', () => {
    expect(supportOf(ir('candlestick', { x: n('t'), y: [q('b'), q('c'), q('d'), q('e')] })).supported).toBe(true);
    expect(supportOf(ir('boxplot', { x: n('a'), y: [q('b'), q('c'), q('d'), q('e'), q('f')] })).supported).toBe(
      true,
    );
    expect(supportOf(ir('boxplot', { x: n('a'), y: [q('b'), q('c'), q('d'), q('e')] })).missing).toEqual([
      'a boxplot reads 5 numbers per row from y and was given 4',
    ]);
    expect(supportOf(ir('candlestick', { x: n('t') })).missing).toEqual([
      'a candlestick reads 4 numbers per row from y and was given 0',
    ]);
  });

  it('refuses geometry a contract cannot name, and names the column it still needs', () => {
    expect(supportOf(ir('map', { x: n('a'), y: q('b') })).missing).toEqual([
      'a map draws registered geometry and this contract names none',
    ]);
    expect(supportOf(ir('map', { x: n('a'), y: q('b') }, { map: 'geo' })).supported).toBe(true);
    expect(supportOf(ir('map', {}, { map: 'geo' })).missing).toEqual([
      'a map needs a region name from x or theta and was given none',
    ]);
  });

  it('refuses a network missing either end', () => {
    expect(supportOf(ir('graph', { x: n('a'), series: n('a') })).supported).toBe(true);
    expect(supportOf(ir('sankey', { x: n('a'), color: n('a') })).supported).toBe(true);
    expect(supportOf(ir('sankey', { x: n('a') })).missing).toEqual([
      'a sankey needs a target column from series or color and was given none',
    ]);
    expect(supportOf(ir('graph', { series: n('a') })).missing).toEqual([
      'a graph needs a source column from x and was given none',
    ]);
  });

  it('needs a name before it can draw a hierarchy or a profile', () => {
    expect(supportOf(ir('treemap', { x: n('a'), y: q('b') })).supported).toBe(true);
    expect(supportOf(ir('treemap', { y: q('b') })).missing).toEqual([
      'a treemap needs a name from theta or x and was given none',
    ]);
    expect(supportOf(ir('radar', { theta: n('a'), y: q('b') })).supported).toBe(true);
    expect(supportOf(ir('radar', { y: q('b') })).missing).toEqual([
      'a radar needs a metric from theta or x and was given none',
    ]);
  });

  it('needs both endpoints of a route', () => {
    expect(supportOf(ir('lines', { x: n('t'), y: q('b') })).supported).toBe(true);
    expect(supportOf(ir('lines', { y: q('b') })).missing).toEqual([
      'a lines series needs an x column and was given none',
    ]);
  });

  it('lets a cartesian mark take its measure from theta when y is empty', () => {
    // The compiler falls back to `theta` for the value axis, so the verdict has to
    // as well — otherwise it would refuse a chart the renderer can draw.
    expect(supportOf(ir('bar', { x: n('a'), theta: q('b') })).supported).toBe(true);
    // `theta` already falls back to `x`, so a lone x is a chart with one axis and
    // nothing to plot only when it is absent entirely.
    expect(supportOf(ir('bar', { x: q('a') })).supported).toBe(true);
    expect(supportOf(ir('bar', {})).missing).toEqual(['a bar needs a measure from y or theta and was given none']);
  });
});

describe('the refusal text', () => {
  it('names the channel and the count, once per gap', () => {
    const verdict = supportOf(ir('themeRiver', {}));
    expect(verdict.missing).toEqual([
      'a theme river needs a time column from x and was given none',
      'a theme river needs a measure from y and was given none',
      'a theme river needs a category to stack, from series or color, and was given none',
    ]);
    // Repeats would read as separate faults; a caller counting gaps must see three.
    expect(new Set(verdict.missing).size).toBe(verdict.missing.length);
  });

  it('is carried whole by the lint error, so a caller reads one message', () => {
    const chart = ir('boxplot', { x: n('a') });
    const error = lint(chart).find((issue) => issue.rule === 'encoding-unsupported');
    expect(error?.severity).toBe('error');
    expect(error?.message).toBe(supportOf(chart).missing.join('; '));
  });
});
