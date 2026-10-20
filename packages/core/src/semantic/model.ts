/**
 * Semantic model: tables, relationships, dimensions and metrics.
 *
 * The model is data, not code. Compilation never guesses: a missing metric, an
 * ambiguous column or a second join path is an error with candidates, because a
 * silent choice here becomes a wrong number in a chart.
 */
import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';

export type ScalarType = 'string' | 'number' | 'date' | 'boolean';

export interface ColumnDef {
  readonly name: string;
  readonly type: ScalarType;
  /** Masked columns are not readable by the compiler at all (projection masking). */
  readonly masked?: boolean;
}

export interface Predicate {
  /** Either `column` or `table.column`. */
  readonly column: string;
  readonly op: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'is null' | 'is not null';
  readonly value?: string | number | boolean | readonly (string | number)[];
}

export interface TableDef {
  readonly name: string;
  readonly columns: readonly ColumnDef[];
  /** Row-level security: injected into every read of this table. */
  readonly rls?: readonly Predicate[];
}

export interface RelationshipDef {
  readonly from: string;
  readonly to: string;
  readonly on: { readonly from: string; readonly to: string };
  readonly cardinality: 'many_to_one' | 'one_to_many' | 'one_to_one';
}

export interface DimensionDef {
  readonly name: string;
  readonly table: string;
  readonly column: string;
  readonly kind: 'categorical' | 'time';
  /** Time dimensions are truncated to this grain. */
  readonly grain?: 'day' | 'month' | 'quarter' | 'year';
}

export type Aggregation = 'sum' | 'count' | 'count_distinct' | 'min' | 'max' | 'avg';
export type Additivity = 'additive' | 'semi_additive' | 'non_additive';

interface MetricBase {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly rationale?: string;
}

export interface SimpleMetric extends MetricBase {
  readonly kind: 'simple';
  readonly table: string;
  readonly aggregation: Aggregation;
  readonly column: string;
  /** Aggregation filter, rendered as `FILTER (WHERE …)`. */
  readonly filter?: readonly Predicate[];
  /** The grain of the table this measure lives on (for example `order_id`). */
  readonly grain: readonly string[];
  readonly additivity: Additivity;
}

export interface RatioMetric extends MetricBase {
  readonly kind: 'ratio';
  readonly numerator: string;
  readonly denominator: string;
}

export interface DerivedMetric extends MetricBase {
  readonly kind: 'derived';
  /** Arithmetic over metric names: `revenue - tax`, `(a + b) / 2`. */
  readonly expr: string;
}

export interface CumulativeMetric extends MetricBase {
  readonly kind: 'cumulative';
  readonly input: string;
  /** Dimension the running total advances along. */
  readonly orderBy: string;
  readonly frame: 'unbounded' | 'trailing';
}

export interface ConversionMetric extends MetricBase {
  readonly kind: 'conversion';
  readonly table: string;
  readonly numerator: readonly Predicate[];
  readonly denominator: readonly Predicate[];
  readonly grain: readonly string[];
}

export type MetricDef = SimpleMetric | RatioMetric | DerivedMetric | CumulativeMetric | ConversionMetric;

export interface SemanticModel {
  readonly name: string;
  readonly tables: readonly TableDef[];
  readonly relationships: readonly RelationshipDef[];
  readonly dimensions: readonly DimensionDef[];
  readonly metrics: readonly MetricDef[];
}

export interface MetricQuery {
  readonly metrics: readonly string[];
  readonly dimensions?: readonly string[];
  readonly filters?: readonly Predicate[];
  readonly limit?: number;
}

export interface ResolvedPredicate {
  readonly table: string;
  readonly column: string;
  readonly op: Predicate['op'];
  readonly value?: string | number | boolean | readonly (string | number)[];
}

export interface QueryContext {
  readonly model: SemanticModel;
  readonly metrics: readonly MetricDef[];
  readonly dimensions: readonly DimensionDef[];
  readonly predicates: readonly ResolvedPredicate[];
}

export function tableOf(model: SemanticModel, name: string): TableDef {
  const table = model.tables.find((candidate) => candidate.name === name);
  if (!table) {
    throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `unknown table "${name}"`, undefined, {
      code: 'UNKNOWN_TABLE',
      table: name,
    });
  }
  return table;
}

export function columnOf(model: SemanticModel, table: string, column: string): ColumnDef {
  const definition = tableOf(model, table);
  const found = definition.columns.find((candidate) => candidate.name === column);
  if (!found) {
    throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `unknown column ${table}.${column}`, undefined, {
      code: 'UNKNOWN_COLUMN',
      table,
      column,
    });
  }
  if (found.masked === true) {
    throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `column ${table}.${column} is masked`, undefined, {
      code: 'MASKED_COLUMN',
      table,
      column,
    });
  }
  return found;
}

/** Resolve `column` or `table.column` to exactly one table. */
export function resolveColumn(model: SemanticModel, reference: string): { table: string; column: string } {
  const parts = reference.split('.');
  const first = parts[0] as string;
  const second = parts[1];
  if (second !== undefined) {
    if (first === '') throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `bad column reference "${reference}"`, undefined, { code: 'UNKNOWN_COLUMN' });
    columnOf(model, first, second);
    return { table: first, column: second };
  }
  if (first === '') {
    throw toNl2ChartsError('NL2C_E_INVALID_INPUT', 'empty column reference', undefined, { code: 'UNKNOWN_COLUMN' });
  }
  const owners = model.tables.filter((table) => table.columns.some((column) => column.name === first));
  if (owners.length === 0) {
    throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `unknown column "${reference}"`, undefined, {
      code: 'UNKNOWN_COLUMN',
      column: reference,
    });
  }
  if (owners.length > 1) {
    throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `column "${reference}" is ambiguous`, undefined, {
      code: 'AMBIGUOUS_COLUMN',
      column: reference,
      candidates: owners.map((table) => table.name),
    });
  }
  const owner = owners[0] as TableDef;
  columnOf(model, owner.name, first);
  return { table: owner.name, column: first };
}

export function metricOf(model: SemanticModel, name: string): MetricDef {
  const direct = model.metrics.find((metric) => metric.name === name);
  if (direct) return direct;
  const aliased = model.metrics.filter((metric) => metric.aliases?.includes(name) === true);
  if (aliased.length === 1) return aliased[0] as MetricDef;
  if (aliased.length > 1) {
    throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `metric alias "${name}" is ambiguous`, undefined, {
      code: 'AMBIGUOUS_METRIC',
      candidates: aliased.map((metric) => metric.name),
    });
  }
  throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `unknown metric "${name}"`, undefined, {
    code: 'UNKNOWN_METRIC',
    metric: name,
  });
}

export function dimensionOf(model: SemanticModel, name: string): DimensionDef {
  const dimension = model.dimensions.find((candidate) => candidate.name === name);
  if (!dimension) {
    throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `unknown dimension "${name}"`, undefined, {
      code: 'UNKNOWN_DIMENSION',
      dimension: name,
    });
  }
  columnOf(model, dimension.table, dimension.column);
  return dimension;
}

export function relationshipBetween(
  model: SemanticModel,
  from: string,
  to: string,
): RelationshipDef {
  const candidates = model.relationships.filter(
    (relationship) =>
      (relationship.from === from && relationship.to === to) ||
      (relationship.from === to && relationship.to === from),
  );
  if (candidates.length === 0) {
    throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `no join path from ${from} to ${to}`, undefined, {
      code: 'NO_JOIN_PATH',
      from,
      to,
    });
  }
  if (candidates.length > 1) {
    throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `join path from ${from} to ${to} is ambiguous`, undefined, {
      code: 'AMBIGUOUS_JOIN',
      from,
      to,
      candidates: candidates.map((relationship) => `${relationship.from}.${relationship.on.from}=${relationship.to}.${relationship.on.to}`),
    });
  }
  return candidates[0] as RelationshipDef;
}

export function resolvePredicate(model: SemanticModel, predicate: Predicate): ResolvedPredicate {
  const resolved = resolveColumn(model, predicate.column);
  const output: ResolvedPredicate = { table: resolved.table, column: resolved.column, op: predicate.op };
  if (predicate.value !== undefined) return { ...output, value: predicate.value };
  return output;
}

export function buildContext(query: MetricQuery, model: SemanticModel): QueryContext {
  if (query.metrics.length === 0) {
    throw toNl2ChartsError('NL2C_E_INVALID_INPUT', 'a query needs at least one metric', undefined, {
      code: 'EMPTY_QUERY',
    });
  }
  const metrics = query.metrics.map((name) => metricOf(model, name));
  const dimensions = (query.dimensions ?? []).map((name) => dimensionOf(model, name));
  const predicates = (query.filters ?? []).map((predicate) => resolvePredicate(model, predicate));
  return { model, metrics, dimensions, predicates };
}
