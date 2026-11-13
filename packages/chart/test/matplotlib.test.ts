import { describe, expect, it } from 'vitest';
import type { ChartIR, ChartType, FieldRef } from '@agentix-e/nl2charts-spec';
import { compileToMatplotlib } from '../src/index.js';

const rows = [
  { region: 'north', total: 10.5, count: 3 },
  { region: 'south', total: 99.99, count: 7 },
];

/**
 * The error code, not the message.
 *
 * A matcher on the message text passes whenever the string appears anywhere in it, so a
 * compiler that mentioned every code it knows would satisfy it. The code is the contract.
 */
const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? 'no code';
  }
  return 'did not throw';
};

const n = (field: string): FieldRef => ({ field, type: 'nominal' });
const q = (field: string): FieldRef => ({ field, type: 'quantitative' });

const ir = (mark: ChartType, encoding: ChartIR['encoding'], extra: Partial<ChartIR> = {}): ChartIR => ({
  version: '3.0',
  mark,
  encoding,
  data: rows,
  title: 'by region',
  // The contract requires alt text before rendering, and the compiler asks the linter, so a
  // fixture without it is an IR this library refuses — which is the point of `alt` being in the
  // IR rather than in the renderer: every target gets it or none does.
  alt: 'totals by region',
  ...extra,
});

/**
 * The compiler's job is to emit Python a reader can run, not a string that merely
 * mentions a plotting call: `execution_result` is one of the four criteria the
 * score depends on, so a figure that fails to draw is a zero regardless of how the
 * code reads. These assertions are about structure — which function is called with
 * which column — because that is what can be checked without a Python runtime.
 */
describe('a chart IR compiled to matplotlib', () => {
  it('draws a bar chart from a categorical axis and a measure', () => {
    const code = compileToMatplotlib(ir('bar', { x: n('region'), y: q('total') }));
    expect(code).toContain('import matplotlib.pyplot as plt');
    expect(code).toContain('plt.bar(');
    expect(code).toContain('"north"');
    expect(code).toContain('"south"');
    expect(code).toContain('10.5');
    expect(code).toContain('99.99');
    // The axis label is the column name, which is what a reader needs to map the
    // picture back to the table.
    expect(code).toContain('xlabel');
    expect(code).toContain('"region"');
  });

  it('draws a line chart, and keeps the row order rather than sorting', () => {
    // A line asserts an order. Sorting by the measure would draw a different chart
    // than the data says, and nothing in the picture would show it.
    const code = compileToMatplotlib(ir('line', { x: n('region'), y: q('total') }));
    expect(code).toContain('plt.plot(');
    expect(code.indexOf('"north"')).toBeLessThan(code.indexOf('"south"'));
  });

  it('draws a scatter plot from two measures', () => {
    const code = compileToMatplotlib(ir('scatter', { x: q('total'), y: q('count') }));
    expect(code).toContain('plt.scatter(');
  });

  it('draws a pie from theta and a measure, and refuses one with a negative slice', () => {
    // A negative slice cannot be drawn, and `lint` already says so with
    // `pie-negative-value`. The compiler asks the linter rather than reading the data
    // twice: two places deciding "is this drawable" is how a rule and a compiler come
    // to disagree about the same IR.
    expect(compileToMatplotlib(ir('pie', { theta: n('region'), y: q('total') }))).toContain('plt.pie(');
    const negative = ir('pie', { theta: n('region'), y: q('total') }, { data: [{ region: 'north', total: -1 }] });
    expect(codeOf(() => compileToMatplotlib(negative))).toBe('NL2C_E_INVALID_IR');
    expect(() => compileToMatplotlib(negative)).toThrow(/negative/);
  });

  it('sets the title from the IR, and emits an empty title rather than the word undefined', () => {
    expect(compileToMatplotlib(ir('bar', { x: n('region'), y: q('total') }))).toContain('"by region"');
    const untitled = compileToMatplotlib(ir('bar', { x: n('region'), y: q('total') }, { title: undefined }));
    expect(untitled).not.toContain('undefined');
    expect(untitled).not.toContain('plt.title');
  });

  it('refuses a mark it cannot draw instead of emitting a plausible wrong chart', () => {
    // The contract lists 22 series types and matplotlib covers four of them. A map
    // compiled to a bar chart is a picture that answers a different question, and
    // the score would call it a wrong answer without saying why.
    for (const mark of ['map', 'graph', 'sankey', 'treemap', 'sunburst', 'tree', 'heatmap', 'boxplot', 'candlestick'] as ChartType[]) {
      expect(codeOf(() => compileToMatplotlib(ir(mark, { x: n('region'), y: q('total') })))).toBe('NL2C_E_NOT_SUPPORTED');
    }
  });

  it('refuses an IR whose channels the mark reads are missing', () => {
    // `supportOf` is the single source of truth for this, and it is asked first:
    // an IR that carries no channels compiles to a chart of nothing in ECharts, and
    // the same IR must not become a chart of nothing here either.
    expect(codeOf(() => compileToMatplotlib(ir('bar', {})))).toBe('NL2C_E_NOT_SUPPORTED');
  });

  it('quotes data with the JSON rules Python also accepts, so a value cannot become code', () => {
    // The data comes from a file, and the reference harness runs the generated source with `exec`.
    // A category holding `'); import os; os.system(...)` must stay a category. Python and JSON
    // string literals agree on every escape that matters, so the values go through JSON and the
    // assertion is that the literal is byte-identical to `JSON.stringify` of the value: any other
    // rule (single quotes, no escaping) diverges from it here.
    const hostile = `'); import os; os.system('echo pwned`;
    const multiline = 'back\\slash\nnewline';
    const code = compileToMatplotlib(
      ir('bar', { x: n('region'), y: q('total') }, {
        data: [{ region: hostile, total: 1 }, { region: multiline, total: 2 }],
      }),
    );
    expect(code).toContain(JSON.stringify(hostile));
    expect(code).toContain(JSON.stringify(multiline));
    // The payload is a quoted literal and nothing else: no bare statement was emitted for it.
    expect(code).not.toContain(`import os; os.system('echo pwned` + '\n');
  });

  it('writes null as None and true as True, because JSON keywords are not Python', () => {
    // A missing cell is a real state in every table this library reads. Emitting
    // `null` would be a NameError at run time, and `execution_result` would be 0 for
    // a reason that has nothing to do with the chart.
    const code = compileToMatplotlib(ir('bar', { x: n('region'), y: q('total') }, {
      data: [{ region: null, total: 1 }, { region: true, total: 2 }],
    }));
    expect(code).toContain('None');
    expect(code).toContain('True');
    expect(code).not.toMatch(/\bnull\b/);
  });

  it('drops a non-finite measure rather than writing nan into the source', () => {
    // `float('nan')` plots as a gap; the JSON spelling `nan` is a NameError. Neither
    // is a value the endpoint returned, so the row is dropped and the count of
    // dropped rows travels in the emitted comment — a silently shorter series is
    // the failure mode this avoids.
    const code = compileToMatplotlib(ir('bar', { x: n('region'), y: q('total') }, {
      data: [{ region: 'a', total: 1 }, { region: 'b', total: Number.NaN }, { region: 'c', total: 3 }],
    }));
    expect(code).not.toContain('NaN');
    expect(code).toContain('1 row dropped');
    expect(code).toContain('"c"');
  });

  it('drops a scatter row when either measure is unmeasurable, and says how many', () => {
    // A scatter reads two measures, so it has two ways to lose a row where the other marks have
    // one. A row with a good x and a bad y is still a row matplotlib cannot place.
    const code = compileToMatplotlib(ir('scatter', { x: q('total'), y: q('count') }, {
      data: [
        { total: 1, count: 2 },
        { total: 3, count: Number.POSITIVE_INFINITY },
        { total: Number.NaN, count: 4 },
        { total: 5, count: 6 },
      ],
    }));
    expect(code).toContain('xs = [1, 5]');
    expect(code).toContain('ys = [2, 6]');
    expect(code).toContain('2 row dropped');
  });

  it('writes a value that is neither a string nor a number as its own text, not as a crash', () => {
    // A cell can hold whatever the driver returned: a Date, a Buffer, a nested object. None of them
    // is a category a reader can use, and none of them may break the emitter — the case is scored on
    // whether the code runs, and a TypeError here is a zero for a reason no reader can see. BigInt is
    // the one that would otherwise emit `1n`, which is not Python.
    const code = compileToMatplotlib(ir('bar', { x: n('region'), y: q('total') }, {
      data: [{ region: 10n, total: 1 }, { region: { nested: true }, total: 2 }],
    }));
    expect(code).not.toContain('1n');
    // A bigint is a whole number and goes in as one; an object keeps its content rather than
    // becoming `[object Object]`, which is what `String(value)` would have written.
    expect(code).toContain('labels = [10, {"nested":true}]');
  });

  it('falls back to text for a value JSON cannot represent, and still emits a literal', () => {
    // A cycle is what JSON throws on, a function is what it silently returns nothing for. Both must
    // still produce a label, and the assertion is that the emitted array parses as JSON — not what
    // the text says, because the text of a function is whatever the transpiler left behind and a
    // matcher on it would pin the test to esbuild's output rather than to this compiler's rule.
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const code = compileToMatplotlib(ir('bar', { x: n('region'), y: q('total') }, {
      data: [{ region: cyclic, total: 1 }, { region: () => 'x', total: 2 }],
    }));
    const labels = code.split('\n').find((line) => line.startsWith('labels = '));
    expect(labels).toBeDefined();
    const parsed = JSON.parse((labels as string).slice('labels = '.length)) as unknown[];
    expect(parsed).toHaveLength(2);
    expect(parsed.every((value) => typeof value === 'string')).toBe(true);
    expect(parsed[0]).toBe('[object Object]');
    expect(parsed[1]).toContain('x');
  });

  it('reads a pie named by x and measured by color, because the contract allows either spelling', () => {
    // `theta` and `y` are the canonical channels, and `x` plus `color` are the spelling the
    // recommender emits for some shapes. Both reach the same figure, and a compiler that only read
    // the canonical pair would refuse a valid IR.
    const code = compileToMatplotlib(ir('pie', { x: n('region'), color: q('total') }));
    expect(code).toContain('plt.pie(');
    expect(code).toContain('labels = ["north", "south"]');
  });

  it('takes the first measure of a multi-measure y, and names it', () => {
    // A bar chart with two measures is legal in the contract and is drawn here from the first one —
    // matplotlib would need a grouped-bar layout to draw both, and drawing the second under the
    // first's label is the silent wrongness this compiler refuses everywhere else. The axis label
    // names the column that was used, so the difference is visible on the figure.
    const code = compileToMatplotlib(ir('bar', { x: n('region'), y: [q('total'), q('count')] }));
    expect(code).toContain('values = [10.5, 99.99]');
    expect(code).toContain('plt.ylabel("total")');
    expect(code).not.toContain('count');
  });

  it('writes a numeric or boolean category as a number or a Python keyword', () => {
    // A category column is not always text: a table of years, of identifiers, of flags arrives with
    // numbers and booleans in it, and matplotlib labels an axis from either. `false` is the case
    // that would otherwise be written as the string "false" while `true` became `True` — two
    // spellings of one column in one figure.
    const code = compileToMatplotlib(ir('bar', { x: n('region'), y: q('total') }, {
      data: [{ region: 42, total: 1 }, { region: false, total: 2 }],
    }));
    expect(code).toContain('labels = [42, False]');
  });

  it('emits a figure that calls show(), which is what the reference harness patches to save the png', () => {
    // `eval_predictions.py` replaces `plt.show` with a saver and calls the generated
    // code with `exec`. Code that never calls `show` produces no file, and the case
    // scores zero for a reason the chart cannot explain.
    for (const mark of ['bar', 'line', 'scatter', 'pie'] as ChartType[]) {
      const encoding =
        mark === 'pie'
          ? { theta: n('region'), y: q('total') }
          : mark === 'scatter'
            ? { x: q('total'), y: q('count') }
            : { x: n('region'), y: q('total') };
      expect(compileToMatplotlib(ir(mark, encoding))).toContain('plt.show()');
    }
  });
});
