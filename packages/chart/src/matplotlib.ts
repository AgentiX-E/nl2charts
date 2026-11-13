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
 */
const DRAWABLE = new Set(['bar', 'line', 'scatter', 'effectScatter', 'pie']);

/** What the emitted source calls, per mark. */
const CALL: Readonly<Record<string, string>> = {
  bar: 'plt.bar',
  line: 'plt.plot',
  scatter: 'plt.scatter',
  effectScatter: 'plt.scatter',
  pie: 'plt.pie',
};

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
  const isPie = ir.mark === 'pie';
  const labelRef = (isPie ? (ir.encoding.theta ?? first(ir.encoding.x)) : first(ir.encoding.x)) as FieldRef;
  // One `??`, not two: `first(y) ?? (isPie ? color : undefined)` has a right-hand branch that no
  // IR reaches for a non-pie mark (`supportOf` requires a measure) and one that `first(y)` already
  // covers for a pie — a guard whose false side is unreachable is a line only coverage runs.
  const measure = first(ir.encoding.y ?? (isPie ? ir.encoding.color : undefined));
  const call = CALL[ir.mark] as string;
  const body: string[] = [];
  let dropped = 0;

  if (ir.mark === 'scatter' || ir.mark === 'effectScatter') {
    // A scatter relates two measures and has no category axis: both channels are read as numbers,
    // and a row survives only if both are. Every other drawable mark has a categorical channel
    // that may hold anything, including null, so only its measure is checked.
    const xs: string[] = [];
    const ys: string[] = [];
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
    body.push(`${call}(xs, ys)`, `plt.xlabel(${JSON.stringify(labelRef.field)})`, `plt.ylabel(${JSON.stringify(measure.field)})`);
  } else {
    const labels: string[] = [];
    const values: string[] = [];
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
    if (isPie) {
      // A pie has no axes to label: the slices are named, and the measure is the radius.
      body.push(`${call}(values, labels=labels)`);
    } else {
      body.push(`${call}(labels, values)`, `plt.xlabel(${JSON.stringify(labelRef.field)})`, `plt.ylabel(${JSON.stringify(measure.field)})`);
    }
  }

  if (ir.title !== undefined) body.push(`plt.title(${JSON.stringify(ir.title)})`);
  body.push('plt.show()');
  return ['import matplotlib.pyplot as plt', '', ...body].join('\n') + '\n';
}
