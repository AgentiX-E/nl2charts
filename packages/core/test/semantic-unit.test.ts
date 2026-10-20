import { describe, expect, it } from 'vitest';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';
import {
  buildContext,
  compileQuery,
  dimensionOf,
  explainQuery,
  lowerPlan,
  metricOf,
  optimizePlan,
  parseMetricExpr,
  refsOf,
  relationshipBetween,
  renderExpr,
  renderPredicate,
  renderSqlPlan,
  resolveColumn,
  tableOf,
} from '../src/semantic/index.js';
import type { PlanNode, SemanticModel } from '../src/semantic/index.js';
import { salesModel } from '../../../eval/fixtures/semantic-model.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isNl2ChartsError(error) ? String(error.details.code) : 'NOT_CONTRACT';
  }
};

const kinds = (node: PlanNode, seen: string[] = []): string[] => {
  seen.push(node.kind);
  if (node.kind === 'join') {
    kinds(node.left, seen);
    kinds(node.right, seen);
  } else if (node.kind !== 'read') {
    kinds(node.input, seen);
  }
  return seen;
};

describe('model resolution', () => {
  it('resolves tables, columns, metrics and dimensions', () => {
    expect(tableOf(salesModel, 'orders').name).toBe('orders');
    expect(resolveColumn(salesModel, 'orders.amount')).toEqual({ table: 'orders', column: 'amount' });
    expect(resolveColumn(salesModel, 'status')).toEqual({ table: 'orders', column: 'status' });
    expect(metricOf(salesModel, 'revenue').kind).toBe('simple');
    expect(metricOf(salesModel, 'sales').name).toBe('revenue');
    expect(dimensionOf(salesModel, 'month')).toMatchObject({ table: 'orders', grain: 'month' });
  });

  it('refuses unknown names with a stable code', () => {
    expect(codeOf(() => tableOf(salesModel, 'ghost'))).toBe('UNKNOWN_TABLE');
    expect(codeOf(() => resolveColumn(salesModel, 'nope'))).toBe('UNKNOWN_COLUMN');
    expect(codeOf(() => metricOf(salesModel, 'nope'))).toBe('UNKNOWN_METRIC');
    expect(codeOf(() => dimensionOf(salesModel, 'nope'))).toBe('UNKNOWN_DIMENSION');
    expect(codeOf(() => resolveColumn(salesModel, 'orders.nope'))).toBe('UNKNOWN_COLUMN');
  });

  it('refuses an ambiguous unqualified column and lists the owners', () => {
    try {
      resolveColumn(salesModel, 'region');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(isNl2ChartsError(error)).toBe(true);
      if (isNl2ChartsError(error)) {
        expect(error.details.code).toBe('AMBIGUOUS_COLUMN');
        expect(error.details.candidates).toEqual(['orders', 'customers']);
      }
    }
  });

  it('refuses a masked column everywhere it could leak', () => {
    expect(codeOf(() => resolveColumn(salesModel, 'customers.email'))).toBe('MASKED_COLUMN');
    expect(codeOf(() => dimensionOf(salesModel, 'email'))).toBe('MASKED_COLUMN');
  });

  it('refuses a missing or ambiguous join path with candidates', () => {
    expect(codeOf(() => relationshipBetween(salesModel, 'orders', 'unknown_table'))).toBe('NO_JOIN_PATH');
    const ambiguous: SemanticModel = {
      ...salesModel,
      relationships: [
        ...salesModel.relationships,
        { from: 'orders', to: 'customers', on: { from: 'customer_id', to: 'customer_id' }, cardinality: 'many_to_one' },
      ],
    };
    try {
      relationshipBetween(ambiguous, 'orders', 'customers');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(isNl2ChartsError(error) && error.details.code).toBe('AMBIGUOUS_JOIN');
      if (isNl2ChartsError(error)) expect((error.details.candidates as string[]).length).toBe(2);
    }
  });

  it('refuses an ambiguous metric alias', () => {
    const conflicting: SemanticModel = {
      ...salesModel,
      metrics: salesModel.metrics.map((metric) =>
        metric.name === 'tax' ? { ...metric, aliases: ['sales'] } : metric,
      ),
    };
    expect(codeOf(() => metricOf(conflicting, 'sales'))).toBe('AMBIGUOUS_METRIC');
  });

  it('requires at least one metric', () => {
    expect(codeOf(() => buildContext({ metrics: [] }, salesModel))).toBe('EMPTY_QUERY');
  });
});

describe('expressions', () => {
  it('parses precedence and parentheses', () => {
    expect(parseMetricExpr('revenue - tax * 2')).toEqual({
      type: 'binary',
      op: '-',
      left: { type: 'ref', name: 'revenue' },
      right: { type: 'binary', op: '*', left: { type: 'ref', name: 'tax' }, right: { type: 'number', value: 2 } },
    });
    expect(parseMetricExpr('(a + b) / 2')).toMatchObject({ op: '/', left: { op: '+' } });
    expect(refsOf(parseMetricExpr('a + b * a'))).toEqual(['a', 'b', 'a']);
  });

  it('rejects malformed expressions', () => {
    expect(() => parseMetricExpr('a @ b')).toThrow(/unexpected character/);
    expect(() => parseMetricExpr('(a + b')).toThrow(/end of expression|closing parenthesis/);
    expect(() => parseMetricExpr('a b')).toThrow(/trailing/);
    expect(() => parseMetricExpr('')).toThrow(/end of expression/);
    expect(() => parseMetricExpr('1..2')).toThrow(/bad number/);
    expect(() => parseMetricExpr('* 2')).toThrow(/unexpected token/);
  });
});

describe('compilation stages', () => {
  it('compiles revenue by region and exposes the plan', () => {
    const compiled = compileQuery({ metrics: ['revenue'], dimensions: ['region'] }, salesModel);
    expect(compiled.columns).toEqual(['region', 'revenue']);
    expect(compiled.sql.startsWith('WITH')).toBe(true);
    expect(compiled.sql).toContain('"region"');
    expect(compiled.sql).toContain('FILTER (WHERE "status" = \'completed\')');
    expect(kinds(compiled.optimizedPlan)).toContain('aggregate');
    expect(explainQuery({ metrics: ['revenue'], dimensions: ['region'] }, salesModel).kind).toBe('aggregate');
  });

  it('compiles a global aggregate without dimensions', () => {
    const compiled = compileQuery({ metrics: ['revenue'] }, salesModel);
    expect(compiled.columns).toEqual(['revenue']);
    expect(compiled.sql).toContain('GROUP BY "order_id"');
    expect(compiled.sql).not.toContain('LEFT JOIN');
  });

  it('joins a dimension from another table and keeps its filters', () => {
    const compiled = compileQuery(
      { metrics: ['revenue'], dimensions: ['segment'], filters: [{ column: 'orders.status', op: '=', value: 'completed' }] },
      salesModel,
    );
    expect(compiled.sql).toContain('"customers"');
    expect(compiled.sql).toContain('LEFT JOIN');
    expect(compiled.sql).toContain('"segment"');
  });

  it('computes a ratio from separately aggregated components', () => {
    const compiled = compileQuery({ metrics: ['aov'], dimensions: ['region'] }, salesModel);
    expect(compiled.sql).toContain('nullif');
    expect(kinds(compiled.optimizedPlan)).toContain('compute');
  });

  it('computes a derived metric over two components', () => {
    const compiled = compileQuery({ metrics: ['net_revenue'], dimensions: ['region'] }, salesModel);
    expect(compiled.sql).toContain('"__c0"');
    expect(compiled.sql).toContain('"__c1"');
  });

  it('computes a cumulative metric with an explicit window frame', () => {
    const compiled = compileQuery({ metrics: ['ytd_revenue'], dimensions: ['month'] }, salesModel);
    expect(compiled.sql).toContain('over (order by "month" rows between unbounded preceding and current row)');
  });

  it('refuses a cumulative metric without its order dimension', () => {
    expect(codeOf(() => compileQuery({ metrics: ['ytd_revenue'], dimensions: ['region'] }, salesModel))).toBe('MISSING_WINDOW_ORDER');
  });

  it('computes a conversion rate from two conditional counts', () => {
    const compiled = compileQuery({ metrics: ['paid_rate'], dimensions: ['region'] }, salesModel);
    expect(compiled.sql).toContain('FILTER (WHERE "status" = \'completed\')');
    expect(compiled.sql).toContain('FILTER (WHERE "order_id" IS NOT NULL)');
  });

  it('aggregates a non-additive measure once, at the requested grain', () => {
    const compiled = compileQuery({ metrics: ['avg_order'], dimensions: ['region'] }, salesModel);
    expect(compiled.sql).toContain('avg("amount")');
    expect(compiled.sql).not.toContain('sum("avg_order")');
  });

  it('supports several metrics in one query', () => {
    const compiled = compileQuery({ metrics: ['revenue', 'orders'], dimensions: ['region'] }, salesModel);
    expect(compiled.columns).toEqual(['region', 'revenue', 'orders']);
    expect(kinds(compiled.optimizedPlan).filter((kind) => kind === 'join').length).toBeGreaterThan(0);
  });

  it('applies a limit as the last node', () => {
    const compiled = compileQuery({ metrics: ['revenue'], dimensions: ['region'], limit: 5 }, salesModel);
    expect(compiled.sql).toContain('LIMIT 5');
    expect(compiled.optimizedPlan.kind).toBe('limit');
  });

  it('rejects unknown metrics, dimensions and filters at compile time', () => {
    expect(codeOf(() => compileQuery({ metrics: ['ghost'] }, salesModel))).toBe('UNKNOWN_METRIC');
    expect(codeOf(() => compileQuery({ metrics: ['revenue'], dimensions: ['ghost'] }, salesModel))).toBe('UNKNOWN_DIMENSION');
    expect(codeOf(() => compileQuery({ metrics: ['revenue'], filters: [{ column: 'ghost', op: '=', value: 1 }] }, salesModel))).toBe('UNKNOWN_COLUMN');
  });

  it('rejects a filter on a table the query never reads', () => {
    expect(
      codeOf(() => compileQuery({ metrics: ['revenue'], filters: [{ column: 'customers.segment', op: '=', value: 'smb' }] }, salesModel)),
    ).toBe('UNUSED_FILTER');
  });

  it('rejects a ratio over a non-simple metric', () => {
    const model: SemanticModel = {
      ...salesModel,
      metrics: [...salesModel.metrics, { kind: 'ratio', name: 'broken', numerator: 'aov', denominator: 'orders' }],
    };
    expect(codeOf(() => compileQuery({ metrics: ['broken'] }, model))).toBe('METRIC_KIND_MISMATCH');
  });

  it('rejects a derived metric that references an unknown name', () => {
    const model: SemanticModel = {
      ...salesModel,
      metrics: [...salesModel.metrics, { kind: 'derived', name: 'broken', expr: 'revenue - ghost' }],
    };
    expect(codeOf(() => compileQuery({ metrics: ['broken'] }, model))).toBe('UNKNOWN_METRIC');
  });

  it('rejects a derived metric with an unparsable expression', () => {
    const model: SemanticModel = {
      ...salesModel,
      metrics: [...salesModel.metrics, { kind: 'derived', name: 'broken', expr: 'revenue @ tax' }],
    };
    expect(codeOf(() => compileQuery({ metrics: ['broken'] }, model))).toBe('BAD_EXPRESSION');
  });
});

describe('optimizer', () => {
  it('deduplicates identical reads across ratio components', () => {
    const withoutOptimize = compileQuery({ metrics: ['aov'], dimensions: ['region'] }, salesModel, { optimize: false });
    const withOptimize = compileQuery({ metrics: ['aov'], dimensions: ['region'] }, salesModel);
    expect(withoutOptimize.sqlPlan.ctes.length).toBeGreaterThan(withOptimize.sqlPlan.ctes.length);
    expect(withoutOptimize.sql).not.toBe(withOptimize.sql);
  });

  it('collapses a limit over a limit to the smaller cap', () => {
    const compiled = compileQuery({ metrics: ['revenue'], limit: 9 }, salesModel);
    const outer = { kind: 'limit' as const, id: 'x', input: compiled.optimizedPlan, count: 4, outputs: compiled.optimizedPlan.outputs };
    const optimized = optimizePlan(outer);
    expect(optimized).toMatchObject({ kind: 'limit', count: 4 });
  });

  it('composes nested projections and drops the identity projection', () => {
    const filtered = compileQuery({ metrics: ['revenue'] }, salesModel);
    const inner = { kind: 'project' as const, id: 'p1', input: filtered.optimizedPlan, columns: [{ alias: 'revenue', source: 'revenue' }], outputs: ['revenue'] };
    const outer = { kind: 'project' as const, id: 'p2', input: inner, columns: [{ alias: 'renamed', source: 'revenue' }], outputs: ['renamed'] };
    const optimized = optimizePlan(outer);
    expect(optimized).toMatchObject({ kind: 'project', columns: [{ alias: 'renamed', source: 'revenue' }] });
  });

  it('is idempotent on its own output', () => {
    const once = compileQuery({ metrics: ['net_revenue'], dimensions: ['region'] }, salesModel).optimizedPlan;
    expect(optimizePlan(once)).toEqual(once);
  });
});

describe('rendering', () => {
  const predicateBase = { table: 'orders', column: 'amount' } as const;

  it('renders every predicate operator', () => {
    expect(renderPredicate({ ...predicateBase, op: '=', value: 1 })).toBe('"amount" = 1');
    expect(renderPredicate({ ...predicateBase, op: '!=', value: 'x' })).toBe('"amount" <> \'x\'');
    expect(renderPredicate({ ...predicateBase, op: '>', value: 2 })).toBe('"amount" > 2');
    expect(renderPredicate({ ...predicateBase, op: 'is null' })).toBe('"amount" IS NULL');
    expect(renderPredicate({ ...predicateBase, op: 'is not null' })).toBe('"amount" IS NOT NULL');
    expect(renderPredicate({ ...predicateBase, op: 'in', value: ['a', 2] })).toBe('"amount" IN (\'a\', 2)');
    expect(renderPredicate({ ...predicateBase, op: '=', value: true })).toBe('"amount" = TRUE');
    expect(renderPredicate({ ...predicateBase, op: '=', value: null as never })).toBe('"amount" = NULL');
    expect(renderPredicate({ ...predicateBase, op: '=', value: Number.POSITIVE_INFINITY })).toBe('"amount" = NULL');
  });

  it('escapes quotes and refuses a non-list IN', () => {
    expect(renderPredicate({ ...predicateBase, op: '=', value: "it's" })).toBe('"amount" = \'it\'\'s\'');
    expect(() => renderPredicate({ ...predicateBase, op: 'in', value: 1 })).toThrow(/requires a list/);
  });

  it('renders arithmetic with a null-safe division', () => {
    expect(renderExpr(parseMetricExpr('a / b'))).toBe('("a" / nullif("b", 0))');
    expect(renderExpr(parseMetricExpr('a + 2 * b'))).toBe('("a" + (2 * "b"))');
    expect(renderExpr({ type: 'number', value: 3 })).toBe('3');
  });

  it('renders a lowered plan with one CTE per node', () => {
    const compiled = compileQuery({ metrics: ['revenue'], dimensions: ['region'] }, salesModel);
    expect(compiled.sqlPlan.ctes.length).toBeLessThanOrEqual(compiled.plan.nodeCount);
    expect(renderSqlPlan(compiled.sqlPlan)).toBe(compiled.sql);
    expect(compiled.sql).toContain('WITH');
    expect(compiled.sql).toContain('FROM "');
  });

  it('quotes identifiers with embedded quotes', () => {
    const plan = lowerPlan(
      { kind: 'read', id: 'r1', table: 'we"ird', predicates: [], outputs: ['a"b'] },
      ['a"b'],
    );
    const sql = renderSqlPlan(plan);
    expect(sql).toContain('"we""ird"');
    expect(sql).toContain('"a""b"');
  });
});
