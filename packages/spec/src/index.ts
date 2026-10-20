export {
  AGGREGATES,
  CONTRACT_VERSION,
  ChartIRSchema,
  EncodingSchema,
  FIELD_TYPES,
  FieldRefSchema,
  MetricQuerySchema,
  ProvenanceSchema,
  ResultSchema,
  SERIES_TYPES,
  THEMES,
  parseChartIR,
  safeParseChartIR,
} from './ir.js';
export type { Aggregate, ChartIR, ChartType, Encoding, FieldRef, FieldType, MetricQuery, Provenance, Result, Theme } from './ir.js';
export { ERROR_CODES, Nl2ChartsError, isNl2ChartsError, toNl2ChartsError } from './errors.js';
export type { ErrorCode, ErrorDetail } from './errors.js';
export { chartIrJsonSchema } from './jsonschema.js';
export type { SpanEvent } from './span.js';
