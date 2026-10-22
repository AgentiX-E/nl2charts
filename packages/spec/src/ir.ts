import { z } from 'zod';

/** Wire contract version. Bumped only for breaking changes (see API1-A5). */
export const CONTRACT_VERSION = '3.0' as const;

/**
 * ECharts series types understood by the chart compiler at this contract version.
 * The list is closed on purpose: an unknown mark must fail at parse time rather
 * than silently degrade into a bar chart.
 */
export const SERIES_TYPES = [
  'bar',
  'line',
  'pie',
  'scatter',
  'effectScatter',
  'radar',
  'tree',
  'treemap',
  'sunburst',
  'boxplot',
  'candlestick',
  'heatmap',
  'map',
  'parallel',
  'lines',
  'graph',
  'sankey',
  'funnel',
  'gauge',
  'pictorialBar',
  'themeRiver',
  'custom',
] as const;

export type ChartType = (typeof SERIES_TYPES)[number];

export const FIELD_TYPES = ['quantitative', 'nominal', 'ordinal', 'temporal'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const AGGREGATES = ['none', 'sum', 'mean', 'count', 'min', 'max', 'median'] as const;
export type Aggregate = (typeof AGGREGATES)[number];

export const THEMES = ['light', 'dark', 'print'] as const;
export type Theme = (typeof THEMES)[number];

export const FieldRefSchema = z
  .object({
    field: z.string().min(1),
    type: z.enum(FIELD_TYPES),
    aggregate: z.enum(AGGREGATES).optional(),
    title: z.string().min(1).optional(),
  })
  .strict();

export type FieldRef = z.infer<typeof FieldRefSchema>;

const FieldOrList = z.union([FieldRefSchema, z.array(FieldRefSchema).min(1)]);

export const EncodingSchema = z
  .object({
    x: FieldOrList.optional(),
    y: FieldOrList.optional(),
    theta: FieldRefSchema.optional(),
    series: FieldRefSchema.optional(),
    color: FieldRefSchema.optional(),
    size: FieldRefSchema.optional(),
    row: FieldRefSchema.optional(),
    column: FieldRefSchema.optional(),
    detail: FieldRefSchema.optional(),
    tooltip: z.array(FieldRefSchema).optional(),
  })
  .strict();

export type Encoding = z.infer<typeof EncodingSchema>;

export const ProvenanceSchema = z
  .object({
    path: z.enum(['sql', 'nl']),
    chart: z.boolean(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

export type Provenance = z.infer<typeof ProvenanceSchema>;

export const ChartIRSchema = z
  .object({
    version: z.literal(CONTRACT_VERSION),
    mark: z.enum(SERIES_TYPES),
    /**
     * Name of a geo map the caller registered with `echarts.registerMap`. Only a
     * `map` series reads it; without it the series draws nothing rather than
     * borrowing geometry the caller never supplied.
     */
    map: z.string().min(1).optional(),
    encoding: EncodingSchema,
    data: z.array(z.record(z.unknown())).max(50_000),
    title: z.string().optional(),
    subtitle: z.string().optional(),
    /** Alt text is mandatory for a11y at emit time; optional only while drafting. */
    alt: z.string().optional(),
    theme: z.enum(THEMES).optional(),
    width: z.number().int().positive().max(4_096).optional(),
    height: z.number().int().positive().max(4_096).optional(),
    provenance: ProvenanceSchema.optional(),
  })
  .strict();

export type ChartIR = z.infer<typeof ChartIRSchema>;

export const MetricQuerySchema = z
  .object({
    metric: z.string().min(1),
    groupBy: z.array(z.string().min(1)).optional(),
    where: z
      .array(
        z
          .object({
            field: z.string().min(1),
            op: z.enum(['=', '!=', '>', '>=', '<', '<=', 'in', 'not in', 'is null', 'is not null']),
            value: z.unknown().optional(),
          })
          .strict(),
      )
      .optional(),
    limit: z.number().int().positive().max(100_000).optional(),
  })
  .strict();

export type MetricQuery = z.infer<typeof MetricQuerySchema>;

export const ResultSchema = z
  .object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.unknown())),
    rowCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export type Result = z.infer<typeof ResultSchema>;

export function parseChartIR(input: unknown): ChartIR {
  return ChartIRSchema.parse(input);
}

export function safeParseChartIR(input: unknown): z.SafeParseReturnType<unknown, ChartIR> {
  return ChartIRSchema.safeParse(input);
}
