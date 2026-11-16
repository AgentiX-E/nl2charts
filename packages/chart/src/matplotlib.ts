import type { ChartIR, FieldRef } from '@agentix-e/nl2charts-spec';
import { Nl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { LintIssue } from './lint.js';
import { isRenderable, lint } from './lint.js';
import { supportOf } from './support.js';

/**
 * The marks matplotlib can draw without inventing anything.
 *
 * Every other series type in the contract either has no matplotlib counterpart at all (`map`,
 * `graph`, `sankey`, `lines`) or is a tuple mark whose cell is five or four numbers (`boxplot`,
 * `candlestick`) — drawable in principle, but not from the encoding this compiler reads, and a
 * bar chart standing in for a candlestick is a picture that answers a different question. The set
 * is closed for the same reason `SERIES_TYPES` is closed: an unknown mark has to fail where the
 * mistake was made.
 *
 * `gauge` is the one mark that stays out of the set although matplotlib can draw an arc: a gauge
 * states a value *against a scale*, and this IR carries the value without the scale — no ceiling, no
 * target, no band. Drawing one anyway would be the compiler choosing a scale and reporting it as the
 * data's, which is the failure this file refuses everywhere else. The set therefore says what the
 * contract can express, not what the plotting library can paint.
 */
const DRAWABLE = new Set(['bar', 'line', 'scatter', 'effectScatter', 'pie', 'heatmap', 'funnel', 'boxplot', 'candlestick']);

/** What the emitted source calls, per mark. */
const CALL: Readonly<Record<string, string>> = {
  bar: 'plt.bar',
  line: 'plt.plot',
  scatter: 'plt.scatter',
  effectScatter: 'plt.scatter',
  pie: 'plt.pie',
  funnel: 'plt.barh',
};

/**
 * How wide a title line may be, in characters.
 *
 * The contract's title is the question, and a question in this corpus has a median of 203 characters
 * and a 90th percentile of 355. Drawn on one line, matplotlib's `bbox_inches="tight"` grows the
 * canvas to hold it: the first reading of the chart judge saw a 2,808 × 483 pixel ribbon where the
 * axes were a fifth of the width and the tick labels were unreadable — `readability 2/10`, and the
 * judge was right. Wrapping is the repair because it is the only one that loses nothing: the title
 * still says everything it said, and the figure stays a figure.
 *
 * 80 characters is about one line of a 6.4-inch figure at the default title size, which is what
 * makes the wrap match what a reader would do by hand.
 */
export const TITLE_WIDTH = 80;

/**
 * The title as a figure can hold it: the same words, wrapped at word boundaries.
 *
 * A word longer than the width is left whole rather than broken — a broken word reads as two, and a
 * title nobody can read is worse than a line nobody expected. A title that already fits comes back
 * unchanged, which is what keeps every short title's emitted source byte-identical to what it was.
 */
export function wrappedTitle(title: string, width: number = TITLE_WIDTH): string {
  if (title.length <= width) return title;
  const lines: string[] = [];
  let line = '';
  for (const word of title.split(/\s+/)) {
    if (word === '') continue;
    if (line === '') {
      line = word;
      continue;
    }
    if (line.length + 1 + word.length <= width) {
      line = `${line} ${word}`;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line !== '') lines.push(line);
  return lines.join('\n');
}

/**
 * A JavaScript value as a Python literal.
 *
 * JSON string literals and Python string literals agree on every escape that matters (`\"`, `\\`,
 * `\n`, `\t`, `\uXXXX`), and JSON is the only serialiser in this runtime whose output is
 * guaranteed to be one literal rather than a concatenation of them. The three keywords that differ
 * — `null`, `true`, `false` — are spelled here, because a table with a missing cell is a real
 * state and `None` is how Python says it.
 */
function pyLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  // A cell can hold what the driver returned rather than a scalar: a timestamp, an array, a nested
  // object. JSON keeps as much of it as Python can read; `String(value)` alone would write
  // `[object Object]` into the chart and lose the only content the cell had. A value JSON cannot
  // represent at all (a cycle, a function) falls back to its own text rather than throwing —
  // whether the code runs is one of the four criteria, and a TypeError here is a zero with no
  // visible cause.
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // fall through to the text form
  }
  return JSON.stringify(String(value));
}

/** A measure as a number, or nothing when the cell cannot be measured. */
function toNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * The first ref of a channel that may hold one or several.
 *
 * No `undefined` guard: `supportOf` has already proved every channel this function is asked for is
 * present, and a guard whose false branch no IR can reach is a line that only a coverage number
 * will ever execute. The cast carries that proof to the type system.
 */
function first(value: FieldRef | readonly FieldRef[] | undefined): FieldRef {
  return Array.isArray(value) ? (value[0] as FieldRef) : (value as FieldRef);
}

/**
 * Compile a `ChartIR` into Python source that draws it with matplotlib.
 *
 * This exists because one of the four criteria in the public NL2Vis benchmark is
 * `execution_result`: the generated *code* has to run and save a figure. This repository produces
 * a `ChartIR` and a browser option object, so a reading on that benchmark needs the IR to reach
 * Python somehow — and compiling it here, in a pure function with no interpreter and no IO, keeps
 * the step testable and keeps the judgement about "what can be drawn" in the two places that
 * already own it (`supportOf` for channels, `lint` for facts).
 *
 * Two refusals, two codes, because the two have different repairs:
 *
 * - `NL2C_E_NOT_SUPPORTED` — the mark has no matplotlib counterpart, or the IR is missing a
 *   channel its mark reads. The repair is a different mark or a different IR.
 * - `NL2C_E_INVALID_IR` — the linter found an error-level problem (a pie with a negative slice, an
 *   empty result set). The IR is drawable in principle and wrong in fact.
 *
 * Both are thrown rather than degraded: a chart of nothing draws fine and scores zero with no
 * trace of why, which is the failure mode this repository keeps finding in other people's
 * harnesses. The source ends with `plt.show()` because the reference harness replaces `plt.show`
 * with a saver — code that never calls it produces no file, and the case is scored as a failure it
 * cannot explain.
 */
export function compileToMatplotlib(ir: ChartIR): string {
  const verdict = supportOf(ir);
  if (!verdict.supported) {
    throw new Nl2ChartsError(
      'NL2C_E_NOT_SUPPORTED',
      `${ir.mark} cannot be drawn from this IR: ${verdict.missing.join('; ')}`,
      { details: { mark: ir.mark, missing: [...verdict.missing] } },
    );
  }
  if (!DRAWABLE.has(ir.mark)) {
    throw new Nl2ChartsError(
      'NL2C_E_NOT_SUPPORTED',
      `${ir.mark} has no matplotlib counterpart in this compiler; drawable marks are ${[...DRAWABLE].join(', ')}`,
      { details: { mark: ir.mark, drawable: [...DRAWABLE] } },
    );
  }
  const issues = lint(ir);
  if (!isRenderable(issues)) {
    // `isRenderable` being false means at least one issue is an error, so the find cannot miss and a
    // fallback message would be a branch no input reaches.
    const firstError = issues.find((issue) => issue.severity === 'error') as LintIssue;
    throw new Nl2ChartsError(
      'NL2C_E_INVALID_IR',
      `this IR is not drawable: ${firstError.message}`,
      { details: { mark: ir.mark, rule: firstError.rule, issues: issues.map((issue) => issue.rule) } },
    );
  }

  // `supportOf` has just proved these present for this mark, which is the same ordering
  // `compileToECharts` uses: re-checking here would add branches no IR can reach.
  const isPie = ir.mark === 'pie' || ir.mark === 'funnel';
  const labelRef = (isPie ? (ir.encoding.theta ?? first(ir.encoding.x)) : first(ir.encoding.x)) as FieldRef;
  // One `??`, not two: `first(y) ?? (isPie ? color : undefined)` has a right-hand branch that no
  // IR reaches for a non-pie mark (`supportOf` requires a measure) and one that `first(y)` already
  // covers for a pie — a guard whose false side is unreachable is a line only coverage runs.
  const measure = first(ir.encoding.y ?? (isPie ? ir.encoding.color : undefined));
  const body: string[] = [];

  if (ir.mark === 'heatmap') {
    body.push(...heatmapSource(ir));
  } else if (ir.mark === 'boxplot' || ir.mark === 'candlestick') {
    body.push(...tupleSource(ir, ir.mark));
  } else if (ir.mark === 'scatter' || ir.mark === 'effectScatter') {
    // A scatter relates two measures and has no category axis: both channels are read as numbers,
    // and a row survives only if both are. Every other drawable mark has a categorical channel
    // that may hold anything, including null, so only its measure is checked.
    const xs: string[] = [];
    const ys: string[] = [];
    let dropped = 0;
    for (const row of ir.data) {
      const x = toNumber(row[labelRef.field]);
      const y = toNumber(row[measure.field]);
      if (x === undefined || y === undefined) {
        dropped += 1;
        continue;
      }
      xs.push(String(x));
      ys.push(String(y));
    }
    body.push(`xs = [${xs.join(', ')}]`, `ys = [${ys.join(', ')}]`);
    if (dropped > 0) body.push(`# ${String(dropped)} row dropped: a measure was not a finite number`);
    body.push(`${CALL[ir.mark] as string}(xs, ys)`, `plt.xlabel(${JSON.stringify(labelRef.field)})`, `plt.ylabel(${JSON.stringify(measure.field)})`);
  } else {
    const labels: string[] = [];
    const values: string[] = [];
    let dropped = 0;
    for (const row of ir.data) {
      const value = toNumber(row[measure.field]);
      if (value === undefined) {
        dropped += 1;
        continue;
      }
      labels.push(pyLiteral(row[labelRef.field]));
      values.push(String(value));
    }
    body.push(`labels = [${labels.join(', ')}]`, `values = [${values.join(', ')}]`);
    if (dropped > 0) body.push(`# ${String(dropped)} row dropped: the measure was not a finite number`);
    if (ir.mark === 'pie') {
      // A pie has no axes to label: the slices are named, and the measure is the radius.
      body.push(`plt.pie(values, labels=labels)`);
    } else if (ir.mark === 'funnel') {
      // A funnel is a bar chart turned on its side, with the first stage at the top: the narrowing
      // is what the mark states, and it only reads downward. The stages are addressed by position
      // for the reason the bar branch gives below.
      body.push(
        `positions = list(range(len(labels)))`,
        `plt.barh(positions, values)`,
        `plt.yticks(positions, labels)`,
        `plt.gca().invert_yaxis()`,
        `plt.xlabel(${JSON.stringify(measure.field)})`,
        `plt.ylabel(${JSON.stringify(labelRef.field)})`,
      );
    } else {
      // The categories are addressed by position rather than handed to matplotlib as labels.
      // Handing them over made this compiler emit source that raised on 152 of the corpus's 1,470
      // rows: a column that mixes numbers with text (`[65, "nan", 29, 42.84]`) arrives as an object
      // array, and the default bar width is a float, so `x - width/2` is a dtype mismatch inside
      // matplotlib — a chart of nothing that the string-level tests could not see, because the code
      // reads correctly. Positions are always integers, and `xticks` labels them with whatever the
      // column held, including the empty label a null cell produces.
      body.push(
        `positions = list(range(len(labels)))`,
        `${CALL[ir.mark] as string}(positions, values)`,
        `plt.xticks(positions, labels)`,
        `plt.xlabel(${JSON.stringify(labelRef.field)})`,
        `plt.ylabel(${JSON.stringify(measure.field)})`,
      );
    }
  }

  if (ir.title !== undefined) body.push(`plt.title(${JSON.stringify(wrappedTitle(ir.title))})`);
  body.push('plt.show()');
  // The label on a chart is data, not mathematics. matplotlib reads `$…$` as mathtext by default, so
  // a title quoting a price (`Revenue in $100k`) opened a formula that never closed and the figure
  // raised a `ParseSyntaxException` — one of the corpus's 1,470 rows, found only by running the
  // emitted source. Turning the parser off says what these strings are; escaping every `$` would say
  // the same thing in every label, title and axis name the emitter writes, forever.
  return ['import matplotlib.pyplot as plt', 'plt.rcParams["text.parse_math"] = False', '', ...body].join('\n') + '\n';
}

/**
 * A matrix of two categories and a measure, as the picture a heatmap states.
 *
 * The cell is looked up by the pair, so a missing combination stays missing: filling it with zero
 * would paint a value the result set never returned, and a reader cannot tell that colour from the
 * one a real zero would make. `float("nan")` is the gap matplotlib draws as blank.
 */
function heatmapSource(ir: ChartIR): string[] {
  const xRef = first(ir.encoding.x) as FieldRef;
  const yRef = first(ir.encoding.y) as FieldRef;
  const valueRef = ir.encoding.color as FieldRef;
  const xs: string[] = [];
  const ys: string[] = [];
  const cells = new Map<string, { readonly x: string; readonly y: string; readonly value: string }>();
  let dropped = 0;
  for (const row of ir.data) {
    const value = toNumber(row[valueRef.field]);
    if (value === undefined) {
      dropped += 1;
      continue;
    }
    const x = pyLiteral(row[xRef.field]);
    const y = pyLiteral(row[yRef.field]);
    if (!xs.includes(x)) xs.push(x);
    if (!ys.includes(y)) ys.push(y);
    // The first value for a pair wins: a result set that repeats a combination twice has no single
    // cell for it, and last-wins would make the picture depend on the query's row order.
    if (!cells.has(`${x}|${y}`)) cells.set(`${x}|${y}`, { x, y, value: String(value) });
  }
  const lines = [
    `xs = [${xs.join(', ')}]`,
    `ys = [${ys.join(', ')}]`,
    `cells = {${[...cells.values()].map((cell) => `(${cell.x}, ${cell.y}): ${cell.value}`).join(', ')}}`,
  ];
  if (dropped > 0) lines.push(`# ${String(dropped)} row dropped: the measure was not a finite number`);
  lines.push(
    `matrix = [[cells.get((x, y), float("nan")) for x in xs] for y in ys]`,
    `plt.imshow(matrix, aspect="auto", cmap="viridis")`,
    `plt.xticks(range(len(xs)), xs)`,
    `plt.yticks(range(len(ys)), ys)`,
    `plt.colorbar()`,
    `plt.xlabel(${JSON.stringify(xRef.field)})`,
    `plt.ylabel(${JSON.stringify(yRef.field)})`,
  );
  return lines;
}

/**
 * A tuple mark: five numbers per row (`boxplot`) or four (`candlestick`).
 *
 * Both are drawn from the columns the encoding names, in the order the contract fixes — `min, q1,
 * median, q3, max` and `open, close, low, high` — rather than from the column order of the table, so
 * a result set that spells its quartiles in another order draws the same picture. A row missing one
 * of the numbers is dropped and counted: half a box is not a box.
 */
function tupleSource(ir: ChartIR, mark: 'boxplot' | 'candlestick'): string[] {
  const columns = (Array.isArray(ir.encoding.y) ? ir.encoding.y : [ir.encoding.y]) as FieldRef[];
  const axis = Array.isArray(ir.encoding.x) ? ir.encoding.x[0] : ir.encoding.x;
  const lines: string[] = [];
  const labels: string[] = [];
  const tuples: number[][] = [];
  let dropped = 0;
  for (const row of ir.data) {
    const values = columns.map((column) => toNumber(row[column.field]));
    if (values.some((value) => value === undefined)) {
      dropped += 1;
      continue;
    }
    labels.push(axis === undefined ? pyLiteral(labels.length) : pyLiteral(row[axis.field]));
    tuples.push(values as number[]);
  }
  const [a, b, c, d, e] = columns.map((column) => column.field);
  lines.push(`labels = [${labels.join(', ')}]`);
  if (dropped > 0) lines.push(`# ${String(dropped)} row dropped: a tuple column was not a finite number`);
  if (mark === 'boxplot') {
    lines.push(
      `stats = [`,
      // `fliers` is not decoration: `Axes.bxp` reads the key and raises without it, which is how a
      // boxplot reached the worker as an `AttributeError` on the wrong function and then a
      // `KeyError` on the right one. An empty list says the figure draws no outliers, which is the
      // honest statement — every number the box is drawn from is one of the five columns.
      `    {"label": label, "whislo": row[0], "q1": row[1], "med": row[2], "q3": row[3], "whishi": row[4], "fliers": []}`,
      `    for label, row in zip(labels, ${pyTupleList(tuples)})`,
      `]`,
      // `pyplot` has no `bxp`: the method lives on an axes, and `plt.bxp` was a call that reads like
      // one that exists until it runs.
      `plt.gca().bxp(stats, showfliers=False)`,
      `plt.ylabel(${JSON.stringify(`${String(a)} / ${String(b)} / ${String(c)} / ${String(d)} / ${String(e)}`)})`,
    );
  } else {
    lines.push(
      `rows = ${pyTupleList(tuples)}`,
      `opens = [row[0] for row in rows]`,
      `closes = [row[1] for row in rows]`,
      `lows = [row[2] for row in rows]`,
      `highs = [row[3] for row in rows]`,
      `positions = list(range(len(labels)))`,
      `plt.vlines(positions, lows, highs, colors="#444444")`,
      `bodies = [abs(c - o) for o, c in zip(opens, closes)]`,
      `bottoms = [min(o, c) for o, c in zip(opens, closes)]`,
      // Rising is red and falling is green, the convention this project's readers use: a candle
      // coloured the other way is a picture that states the opposite of the data for half of them.
      `colors = ["#d62728" if c >= o else "#2ca02c" for o, c in zip(opens, closes)]`,
      `plt.bar(positions, bodies, bottom=bottoms, color=colors, width=0.6)`,
      `plt.xticks(positions, labels)`,
      `plt.ylabel(${JSON.stringify(`${String(a)} / ${String(b)} / ${String(c)} / ${String(d)}`)})`,
    );
  }
  return lines;
}

/** A list of numeric tuples, as Python literals a reader can run. */
function pyTupleList(tuples: readonly (readonly number[])[]): string {
  return `[${tuples.map((tuple) => `(${tuple.map((value) => String(value)).join(', ')})`).join(', ')}]`;
}
