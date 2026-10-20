import type { MetricQuery, SemanticModel } from './model.js';
import { buildContext } from './model.js';
import type { Plan, PlanNode } from './plan.js';
import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import { buildPlan } from './plan.js';
import { optimizePlan } from './optimize.js';
import { lowerPlan, renderSqlPlan } from './render.js';
import type { SqlPlan } from './render.js';

export interface CompileOptions {
  /** Turning this off must not change the rows, only the SQL. */
  readonly optimize?: boolean;
}

export interface CompiledQuery {
  readonly sql: string;
  readonly columns: readonly string[];
  readonly plan: Plan;
  readonly optimizedPlan: PlanNode;
  readonly sqlPlan: SqlPlan;
}

/**
 * Four stages: Plan -> Optimize -> Lower -> Render.
 * The returned SQL is the only artefact a caller executes; the plan is exposed
 * so an explanation can be rendered without parsing SQL back.
 */
function readTables(node: PlanNode, seen: Set<string> = new Set()): Set<string> {
  if (node.kind === 'read') seen.add(node.table);
  else if (node.kind === 'join') {
    readTables(node.left, seen);
    readTables(node.right, seen);
  } else seen = readTables(node.input, seen);
  return seen;
}

export function compileQuery(query: MetricQuery, model: SemanticModel, options: CompileOptions = {}): CompiledQuery {
  const context = buildContext(query, model);
  const plan = buildPlan(query, context);
  const tables = readTables(plan.root);
  const unused = context.predicates.filter((predicate) => !tables.has(predicate.table));
  if (unused.length > 0) {
    const first = unused[0] as { table: string; column: string };
    throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `filter on ${first.table}.${first.column} cannot be applied by this query`, undefined, {
      code: 'UNUSED_FILTER',
      table: first.table,
      column: first.column,
    });
  }
  const optimizedPlan = options.optimize === false ? plan.root : optimizePlan(plan.root);
  const sqlPlan = lowerPlan(optimizedPlan, plan.columns);
  return { sql: renderSqlPlan(sqlPlan), columns: plan.columns, plan, optimizedPlan, sqlPlan };
}

/** Return the optimized dataflow plan (the "how was this number computed" view). */
export function explainQuery(query: MetricQuery, model: SemanticModel): PlanNode {
  return compileQuery(query, model).optimizedPlan;
}
