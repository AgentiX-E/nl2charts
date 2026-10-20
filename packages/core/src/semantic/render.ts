import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { AggregateSpec, GroupExpr, PlanNode } from './plan.js';
import type { ExprAst } from './expr.js';
import type { ResolvedPredicate } from './model.js';

export interface Cte {
  readonly name: string;
  readonly sql: string;
}

export interface SqlPlan {
  readonly ctes: readonly Cte[];
  readonly final: string;
  readonly columns: readonly string[];
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (Array.isArray(value)) return `(${value.map((entry) => literal(entry)).join(', ')})`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function renderPredicate(predicate: ResolvedPredicate): string {
  const column = quote(predicate.column);
  switch (predicate.op) {
    case 'is null':
      return `${column} IS NULL`;
    case 'is not null':
      return `${column} IS NOT NULL`;
    case 'in': {
      if (!Array.isArray(predicate.value)) {
        throw toNl2ChartsError('NL2C_E_INVALID_INPUT', 'IN requires a list value', undefined, { code: 'BAD_PREDICATE' });
      }
      return `${column} IN ${literal(predicate.value)}`;
    }
    case '!=':
      return `${column} <> ${literal(predicate.value)}`;
    default:
      return `${column} ${predicate.op} ${literal(predicate.value)}`;
  }
}

export function renderExpr(ast: ExprAst): string {
  if (ast.type === 'ref') return quote(ast.name);
  if (ast.type === 'number') return String(ast.value);
  const left = renderExpr(ast.left);
  const right = renderExpr(ast.right);
  if (ast.op === '/') return `(${left} / nullif(${right}, 0))`;
  return `(${left} ${ast.op} ${right})`;
}

function aggregation(spec: Extract<AggregateSpec, { type: 'agg' }>): string {
  const column = spec.column === '*' ? '*' : quote(spec.column);
  const call = spec.fn === 'count_distinct' ? `count(distinct ${quote(spec.column)})` : `${spec.fn === 'count' && spec.column === '*' ? 'count' : spec.fn}(${column})`;
  const filter = spec.filter ? ` FILTER (WHERE ${spec.filter.map(renderPredicate).join(' AND ')})` : '';
  return `${call}${filter}`;
}

function aggregateProjection(aggregates: readonly AggregateSpec[]): string[] {
  return aggregates.map((spec) =>
    spec.type === 'sum' ? `sum(${quote(spec.source)}) AS ${quote(spec.alias)}` : `${aggregation(spec)} AS ${quote(spec.alias)}`,
  );
}

function groupProjection(groups: readonly GroupExpr[]): string[] {
  return groups.map((group) => `${group.expr} AS ${quote(group.alias)}`);
}

/**
 * Stage 3: lower a dataflow plan into dialect-neutral CTEs. Each node becomes
 * one CTE; the final select reads the root CTE. The renderer never sees plan
 * semantics, only SQL fragments.
 */
export function lowerPlan(root: PlanNode, columns: readonly string[]): SqlPlan {
  const ctes: Cte[] = [];
  const emitted = new Map<string, string>();

  const lower = (node: PlanNode): string => {
    const existing = emitted.get(node.id);
    if (existing !== undefined) return existing;
    emitted.set(node.id, node.id);
    switch (node.kind) {
      case 'read': {
        const where = node.predicates.length > 0 ? ` WHERE ${node.predicates.map(renderPredicate).join(' AND ')}` : '';
        ctes.push({
          name: node.id,
          sql: `SELECT ${node.outputs.map(quote).join(', ')} FROM ${quote(node.table)}${where}`,
        });
        return node.id;
      }
      case 'aggregate': {
        const input = lower(node.input);
        const projection = [...groupProjection(node.groupBy), ...aggregateProjection(node.aggregates)];
        const groupBy = node.groupBy.length > 0 ? ` GROUP BY ${node.groupBy.map((group) => group.expr).join(', ')}` : '';
        ctes.push({ name: node.id, sql: `SELECT ${projection.join(', ')} FROM ${quote(input)}${groupBy}` });
        return node.id;
      }
      case 'join': {
        const left = lower(node.left);
        const right = lower(node.right);
        const extra = node.right.outputs.filter((column) => !node.left.outputs.includes(column));
        const projection = [`${quote(left)}.*`, ...extra.map((column) => `${quote(right)}.${quote(column)}`)];
        const keyword = node.joinType === 'inner' ? 'INNER JOIN' : 'LEFT JOIN';
        const join = node.pairs.length > 0
          ? `${keyword} ${quote(right)} ON ${node.pairs.map((pair) => `${quote(left)}.${quote(pair.left)} = ${quote(right)}.${quote(pair.right)}`).join(' AND ')}`
          : `CROSS JOIN ${quote(right)}`;
        ctes.push({
          name: node.id,
          sql: `SELECT ${projection.join(', ')} FROM ${quote(left)} ${join}`,
        });
        return node.id;
      }
      case 'compute': {
        const input = lower(node.input);
        ctes.push({
          name: node.id,
          sql: `SELECT *, ${renderExpr(node.expr)} AS ${quote(node.alias)} FROM ${quote(input)}`,
        });
        return node.id;
      }
      case 'window': {
        const input = lower(node.input);
        ctes.push({
          name: node.id,
          sql: `SELECT *, ${node.expression} AS ${quote(node.alias)} FROM ${quote(input)}`,
        });
        return node.id;
      }
      case 'project': {
        const input = lower(node.input);
        const projection = node.columns.map((column) => `${quote(column.source)} AS ${quote(column.alias)}`);
        ctes.push({ name: node.id, sql: `SELECT ${projection.join(', ')} FROM ${quote(input)}` });
        return node.id;
      }
      case 'sort': {
        const input = lower(node.input);
        ctes.push({ name: node.id, sql: `SELECT * FROM ${quote(input)} ORDER BY ${node.keys.map(quote).join(', ')}` });
        return node.id;
      }
      case 'limit': {
        const input = lower(node.input);
        ctes.push({ name: node.id, sql: `SELECT * FROM ${quote(input)} LIMIT ${Math.max(0, Math.trunc(node.count))}` });
        return node.id;
      }
    }
  };

  const finalCte = lower(root);
  return {
    ctes,
    final: `SELECT ${columns.map(quote).join(', ')} FROM ${quote(finalCte)}`,
    columns,
  };
}

/** Stage 4: render the lowered plan to SQL. */
export function renderSqlPlan(plan: SqlPlan): string {
  const withClause = plan.ctes.map((cte) => `${quote(cte.name)} AS (${cte.sql})`).join(',\n');
  return `WITH\n${withClause}\n${plan.final}`;
}
