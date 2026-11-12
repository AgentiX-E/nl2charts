import type { ChartIR, FieldRef } from '@agentix-e/nl2charts-spec';
import { describeMark } from './marks.js';

/**
 * Whether a mark can be drawn from a given IR, and if not, what is missing.
 *
 * The verdict is the single source of truth for the compiler: `compileToECharts`
 * asks it first and emits no series when the answer is negative, and `lint`
 * reports the same sentences as an error. Without that, an IR such as
 * `{ mark: 'bar', encoding: {} }` passed the linter and compiled into a chart
 * with two unnamed axes and no values — a picture that looks plausible, is
 * wrong, and carries no trace of the mistake.
 */
export interface SupportVerdict {
  /** True when the compiler will emit a series that carries this IR's data. */
  readonly supported: boolean;
  /** One sentence per unmet requirement, naming the channel and what it needs. */
  readonly missing: readonly string[];
}

const CARTESIAN = new Set(['bar', 'line', 'scatter', 'effectScatter', 'pictorialBar']);
const RADIAL = new Set(['pie', 'funnel']);
const HIERARCHICAL = new Set(['treemap', 'sunburst', 'tree']);
const NETWORK = new Set(['graph', 'sankey']);

const asList = (value: FieldRef | readonly FieldRef[] | undefined): readonly FieldRef[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value as FieldRef];

const first = (value: FieldRef | readonly FieldRef[] | undefined): FieldRef | undefined => asList(value)[0];

/**
 * Decide whether `ir` carries the channels its mark reads.
 *
 * The branches below follow `compileToECharts` case for case and in the same
 * order, because the two functions have to agree: a mark handled in a different
 * order here than there would approve an IR the compiler then drops. Two
 * orderings are load-bearing and easy to get wrong:
 *
 * - `gauge` is read before the radial marks even though it belongs to that
 *   family, because it takes a value and no category;
 * - `themeRiver` is read before the tuple marks even though `describeMark` calls
 *   it a three-value mark, because its three values come from three channels
 *   rather than from three columns of `y`.
 */
export function supportOf(ir: ChartIR): SupportVerdict {
  const missing: string[] = [];
  const y = asList(ir.encoding.y);
  const x = first(ir.encoding.x);
  const theta = ir.encoding.theta ?? x;
  const color = ir.encoding.color;
  const series = ir.encoding.series;
  const value = y[0] ?? theta;
  const spec = describeMark(ir.mark);

  if (spec.requiresRenderItem) {
    missing.push(`a ${ir.mark} series needs a renderItem function, which a serialisable contract cannot carry`);
  }
  if (spec.requiresGeo && ir.map === undefined) {
    missing.push('a map draws registered geometry and this contract names none');
  }

  if (ir.mark === 'gauge') {
    if (value === undefined) missing.push('a gauge reads one measure from y or theta and was given none');
  } else if (RADIAL.has(ir.mark)) {
    if (theta === undefined) missing.push(`a ${ir.mark} needs a category from theta or x and was given none`);
    if ((y[0] ?? color) === undefined) missing.push(`a ${ir.mark} needs a measure from y or color and was given none`);
  } else if (ir.mark === 'heatmap') {
    if (x === undefined) missing.push('a heatmap needs a column for x and was given none');
    if (y[0] === undefined) missing.push('a heatmap needs a column for y and was given none');
  } else if (ir.mark === 'themeRiver') {
    if (x === undefined) missing.push('a theme river needs a time column from x and was given none');
    if (y[0] === undefined) missing.push('a theme river needs a measure from y and was given none');
    if ((series ?? color) === undefined) {
      missing.push('a theme river needs a category to stack, from series or color, and was given none');
    }
  } else if (spec.tuple !== undefined) {
    const cells = y.slice(0, spec.tuple);
    if (cells.length < spec.tuple) {
      missing.push(`a ${ir.mark} reads ${spec.tuple} numbers per row from y and was given ${cells.length}`);
    }
  } else if (ir.mark === 'radar') {
    if (theta === undefined) missing.push('a radar needs a metric from theta or x and was given none');
    if (y[0] === undefined) missing.push('a radar needs a measure from y and was given none');
  } else if (ir.mark === 'parallel') {
    // One axis per column, and a parallel coordinate plot over a single axis is a
    // scatter that lost its second dimension, so two is the floor.
    const axes = (x === undefined ? 0 : 1) + y.length;
    if (axes < 2) missing.push(`a parallel coordinate plot needs two axes and was given ${axes}`);
  } else if (ir.mark === 'lines') {
    if (x === undefined) missing.push('a lines series needs an x column and was given none');
    if (y[0] === undefined) missing.push('a lines series needs a measure from y and was given none');
  } else if (ir.mark === 'map') {
    if ((x ?? theta) === undefined) missing.push('a map needs a region name from x or theta and was given none');
  } else if (CARTESIAN.has(ir.mark)) {
    if (value === undefined) missing.push(`a ${ir.mark} needs a measure from y or theta and was given none`);
  } else if (HIERARCHICAL.has(ir.mark)) {
    if ((theta ?? x) === undefined) missing.push(`a ${ir.mark} needs a name from theta or x and was given none`);
  } else if (NETWORK.has(ir.mark)) {
    if (x === undefined) missing.push(`a ${ir.mark} needs a source column from x and was given none`);
    if ((series ?? color) === undefined) {
      missing.push(`a ${ir.mark} needs a target column from series or color and was given none`);
    }
  }

  return { supported: missing.length === 0, missing };
}
