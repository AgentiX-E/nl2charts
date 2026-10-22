import { compileQuery } from '@agentix-e/nl2charts-core/semantic';
import type { MetricQuery, SemanticModel } from '@agentix-e/nl2charts-core/semantic';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { Runner } from '@agentix-e/nl2charts-core';
import type { ToolDefinition } from './server.js';

/**
 * The semantic layer as tools.
 *
 * `run_sql` lets an agent write SQL, which means it can write the wrong SQL — the
 * failure this whole project exists to measure. These two tools move the decision
 * into the semantic model: the caller names a metric and dimensions, and the
 * compiler produces the statement. `explain_metric` returns the same compilation
 * without executing it, so an agent can inspect the plan before paying for rows.
 */

const MODEL_SCHEMA = {
  type: 'object',
  description: 'Semantic model: tables, relationships, dimensions and metrics.',
  properties: {
    name: { type: 'string' },
    tables: { type: 'array', items: { type: 'object' } },
    relationships: { type: 'array', items: { type: 'object' } },
    dimensions: { type: 'array', items: { type: 'object' } },
    metrics: { type: 'array', items: { type: 'object' } },
  },
  required: ['name', 'tables', 'metrics'],
  additionalProperties: false,
} as const;

const QUERY_SCHEMA = {
  type: 'object',
  description: 'Metric query: which measures, grouped by which dimensions.',
  properties: {
    metrics: { type: 'array', items: { type: 'string' }, minItems: 1 },
    dimensions: { type: 'array', items: { type: 'string' } },
    filters: { type: 'array', items: { type: 'object' } },
    limit: { type: 'integer', minimum: 1 },
  },
  required: ['metrics'],
  additionalProperties: false,
} as const;

export const SEMANTIC_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'query_metric',
    description:
      'Compile a metric query against a semantic model, run it read-only, and return rows. Prefer this over run_sql: the metric definition is applied here rather than remembered by the caller.',
    inputSchema: {
      type: 'object',
      properties: { model: MODEL_SCHEMA, query: QUERY_SCHEMA },
      required: ['model', 'query'],
      additionalProperties: false,
    },
  },
  {
    name: 'explain_metric',
    description:
      'Compile a metric query and return the SQL plus the plan before and after optimization, without running it. Use it to check what the metric means before spending a query.',
    inputSchema: {
      type: 'object',
      properties: {
        model: MODEL_SCHEMA,
        query: QUERY_SCHEMA,
        optimize: { type: 'boolean', description: 'Include the optimized plan. Defaults to true.' },
      },
      required: ['model', 'query'],
      additionalProperties: false,
    },
  },
];

/** A tool failure the transport reports as an error response, never a crash. */
export interface ToolFailure {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

const INVALID = -32602;

function asModel(value: unknown): SemanticModel | ToolFailure {
  if (value === null || typeof value !== 'object') {
    return { code: INVALID, message: 'query_metric requires a model object' };
  }
  const candidate = value as Partial<SemanticModel>;
  if (typeof candidate.name !== 'string' || !Array.isArray(candidate.tables) || !Array.isArray(candidate.metrics)) {
    return { code: INVALID, message: 'a model needs a name, tables and metrics' };
  }
  return {
    name: candidate.name,
    tables: candidate.tables,
    relationships: Array.isArray(candidate.relationships) ? candidate.relationships : [],
    dimensions: Array.isArray(candidate.dimensions) ? candidate.dimensions : [],
    metrics: candidate.metrics,
  };
}

function asQuery(value: unknown): MetricQuery | ToolFailure {
  if (value === null || typeof value !== 'object') {
    return { code: INVALID, message: 'query_metric requires a query object' };
  }
  const candidate = value as Partial<MetricQuery>;
  if (!Array.isArray(candidate.metrics) || candidate.metrics.length === 0) {
    return { code: INVALID, message: 'a query needs at least one metric' };
  }
  return candidate as MetricQuery;
}

function isFailure(value: unknown): value is ToolFailure {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

function failure(error: unknown): ToolFailure {
  // A semantic error carries the code the rest of the library uses, so a client
  // can branch on NL2C_E_UNKNOWN_METRIC instead of parsing prose.
  return isNl2ChartsError(error)
    ? { code: -32000, message: `${error.code}: ${error.message}`, ...(error.details === undefined ? {} : { data: error.details }) }
    : { code: -32000, message: error instanceof Error ? error.message : String(error) };
}

export interface SemanticContext {
  readonly runner: Runner;
}

/** Compile and run. Returns the payload object the tool encodes as text. */
export async function runQueryMetric(
  context: SemanticContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | ToolFailure> {
  const model = asModel(args.model);
  if (isFailure(model)) return model;
  const query = asQuery(args.query);
  if (isFailure(query)) return query;
  try {
    const compiled = compileQuery(query, model);
    // A client's limit is a request, not a permission. Passing it straight to the
    // runner would let a caller ask for 5,000 rows from a server configured for
    // 1,000 — the runner treats an explicit limit as the cap, so the clamp has to
    // happen here.
    const cap = context.runner.capabilities.maxRows;
    const requested = typeof query.limit === 'number' ? Math.trunc(query.limit) : cap;
    const result = await context.runner.sql(compiled.sql, { limit: Math.min(Math.max(1, requested), cap) });
    return {
      sql: compiled.sql,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
    };
  } catch (error) {
    return failure(error);
  }
}

/** Compile, explain, do not run. */
export function explainMetric(
  args: Record<string, unknown>,
): Record<string, unknown> | ToolFailure {
  const model = asModel(args.model);
  if (isFailure(model)) return model;
  const query = asQuery(args.query);
  if (isFailure(query)) return query;
  const optimize = args.optimize !== false;
  try {
    const optimized = compileQuery(query, model);
    const plain = compileQuery(query, model, { optimize: false });
    return {
      sql: plain.sql,
      optimizedSql: optimized.sql,
      plan: plain.plan,
      nodeCount: optimized.plan.nodeCount,
      ...(optimize ? { optimizedPlan: optimized.optimizedPlan } : {}),
      stages: ['plan', 'optimize', 'lower', 'render'],
    };
  } catch (error) {
    return failure(error);
  }
}
