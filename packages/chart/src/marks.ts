import type { ChartType } from '@agentix-e/nl2charts-spec';

/**
 * What a mark needs before it can be drawn.
 *
 * The contract lists 22 series types, and they are not interchangeable: a boxplot
 * reads five numbers per row, a candlestick four, a theme river three, a map needs
 * geometry that no result set contains, and a custom series needs a `renderItem`
 * function that cannot be serialised. Encoding one of them like a bar chart
 * produces a picture that looks plausible and is wrong, so the requirement is
 * declared here and asserted by the compiler's tests.
 */
export interface MarkSpec {
  readonly mark: ChartType;
  /** One line a caller can show next to the chart choice. */
  readonly summary: string;
  /** Encoding channels the mark reads, in the order the compiler uses them. */
  readonly channels: readonly ('x' | 'y' | 'theta' | 'series' | 'color' | 'size')[];
  /** Numbers per row the series consumes as one cell, when the mark is tuple-based. */
  readonly tuple?: number;
  /** Needs `registerMap` before it can draw anything. */
  readonly requiresGeo: boolean;
  /** Needs a `renderItem` function; the compiler emits an empty series instead. */
  readonly requiresRenderItem: boolean;
}

const mark = (
  name: ChartType,
  summary: string,
  channels: MarkSpec['channels'],
  extra: { tuple?: number; requiresGeo?: boolean; requiresRenderItem?: boolean } = {},
): MarkSpec => ({
  mark: name,
  summary,
  channels,
  requiresGeo: extra.requiresGeo ?? false,
  requiresRenderItem: extra.requiresRenderItem ?? false,
  ...(extra.tuple === undefined ? {} : { tuple: extra.tuple }),
});

/**
 * Every series type in the contract, with what it takes to draw it. Keyed by the
 * union, so a new member fails to compile until an entry exists.
 */
export const MARKS: Readonly<Record<ChartType, MarkSpec>> = {
  bar: mark('bar', 'Compare a measure across categories.', ['x', 'y', 'series']),
  line: mark('line', 'Show a measure changing over an ordered axis.', ['x', 'y', 'series']),
  pie: mark('pie', 'Split a whole into slices; parts must be non-negative.', ['theta', 'y', 'color']),
  scatter: mark('scatter', 'Relate two measures, one point per row.', ['x', 'y', 'size']),
  effectScatter: mark('effectScatter', 'Scatter with a ripple on the notable points.', ['x', 'y', 'size']),
  radar: mark('radar', 'Compare a profile across named metrics.', ['x', 'y', 'series']),
  tree: mark('tree', 'Show a hierarchy as a branching diagram.', ['x', 'y']),
  treemap: mark('treemap', 'Show a hierarchy as nested areas.', ['x', 'y']),
  sunburst: mark('sunburst', 'Show a hierarchy as concentric rings.', ['x', 'y']),
  boxplot: mark('boxplot', 'Show a distribution as min, quartiles and max.', ['x', 'y'], { tuple: 5 }),
  candlestick: mark('candlestick', 'Show open, close, low and high per period.', ['x', 'y'], { tuple: 4 }),
  heatmap: mark('heatmap', 'Colour a matrix of two dimensions and one measure.', ['x', 'y', 'color']),
  map: mark('map', 'Colour regions of a registered map by a measure.', ['x', 'y'], { requiresGeo: true }),
  parallel: mark('parallel', 'Compare rows across several measures at once.', ['x', 'y']),
  lines: mark('lines', 'Draw routes between ordered pairs of points.', ['x', 'y', 'series']),
  graph: mark('graph', 'Show nodes and weighted links.', ['x', 'series']),
  sankey: mark('sankey', 'Show flow volumes from sources to targets.', ['x', 'series']),
  funnel: mark('funnel', 'Show stages narrowing from start to finish.', ['theta', 'y', 'color']),
  gauge: mark('gauge', 'Show one value against a range.', ['y', 'theta']),
  pictorialBar: mark('pictorialBar', 'Bar chart with a repeated symbol instead of a solid bar.', ['x', 'y']),
  themeRiver: mark('themeRiver', 'Show how several categories contribute over time.', ['x', 'y', 'series'], {
    tuple: 3,
  }),
  custom: mark('custom', 'Draw anything, given a renderItem function.', ['x', 'y'], { requiresRenderItem: true }),
};

/** Look up what a mark needs. Total over the contract's union. */
export function describeMark(name: ChartType): MarkSpec {
  return MARKS[name];
}
