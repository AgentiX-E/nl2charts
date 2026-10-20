import { describe, expect, it } from 'vitest';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';
import { componentsOf, compileQuery, parseMetricExpr, refsOf, relationshipBetween, resolveColumn, resolvePredicate } from '../src/semantic/index.js';
import type { MetricDef, SemanticModel } from '../src/semantic/index.js';
import { salesModel } from '../../../eval/fixtures/semantic-model.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isNl2ChartsError(error) ? String(error.details.code) : 'NOT_CONTRACT';
  }
};

const withMetrics = (extra: readonly MetricDef[]): SemanticModel => ({ ...salesModel, metrics: [...salesModel.metrics, ...extra] });

describe('reference edge cases', () => {
  it('rejects empty and malformed references', () => {
    expect(codeOf(() => resolveColumn(salesModel, ''))).toBe('UNKNOWN_COLUMN');
    expect(codeOf(() => resolveColumn(salesModel, '.amount'))).toBe('UNKNOWN_COLUMN');
  });

  it('resolves a predicate without a value', () => {
    expect(resolvePredicate(salesModel, { column: 'orders.status', op: 'is not null' })).toEqual({
      table: 'orders',
      column: 'status',
      op: 'is not null',
    });
    expect(resolvePredicate(salesModel, { column: 'status', op: '=', value: 'completed' })).toEqual({
      table: 'orders',
      column: 'status',
      op: '=',
      value: 'completed',
    });
  });

  it('finds a relationship in either direction', () => {
    expect(relationshipBetween(salesModel, 'customers', 'orders').from).toBe('orders');
  });
});

describe('component expansion', () => {
  it('returns no components for simple and conversion metrics', () => {
    const simple = salesModel.metrics.find((metric) => metric.name === 'revenue') as MetricDef;
    const conversion = salesModel.metrics.find((metric) => metric.name === 'paid_rate') as MetricDef;
    expect(componentsOf(salesModel, simple)).toEqual([]);
    expect(componentsOf(salesModel, conversion)).toEqual([]);
  });

  it('deduplicates repeated references in a derived metric', () => {
    const model = withMetrics([{ kind: 'derived', name: 'double_revenue', expr: 'revenue + revenue' }]);
    const metric = model.metrics.find((candidate) => candidate.name === 'double_revenue') as MetricDef;
    expect(componentsOf(model, metric)).toHaveLength(1);
  });

  it('rejects a derived metric that references no metric at all', () => {
    const model = withMetrics([{ kind: 'derived', name: 'constant', expr: '1 + 2' }]);
    expect(codeOf(() => compileQuery({ metrics: ['constant'] }, model))).toBe('NO_METRIC_REFS');
  });
});

describe('dimension attachment across tables', () => {
  it('attaches a remote dimension to a non-additive measure', () => {
    const compiled = compileQuery({ metrics: ['avg_order'], dimensions: ['segment'] }, salesModel);
    expect(compiled.sql).toContain('LEFT JOIN "');
    expect(compiled.sql).toContain('avg("amount")');
    expect(compiled.sql).not.toContain('sum("avg_order")');
  });

  it('attaches a remote dimension to a conversion metric', () => {
    const compiled = compileQuery({ metrics: ['paid_rate'], dimensions: ['segment'] }, salesModel);
    expect(compiled.sql).toContain('LEFT JOIN "');
    expect(compiled.sql).toContain('count(*)');
  });

  it('supports a metric on the other side of a relationship', () => {
    const model = withMetrics([
      {
        kind: 'simple',
        name: 'customer_count',
        table: 'customers',
        aggregation: 'count',
        column: 'customer_id',
        grain: ['customer_id'],
        additivity: 'additive',
      },
    ]);
    const compiled = compileQuery({ metrics: ['customer_count'], dimensions: ['region'] }, model);
    // customers -> orders is the reverse direction of the declared relationship.
    expect(compiled.sql).toContain('LEFT JOIN "');
    expect(compiled.sql).toContain('"region"');
  });

  it('renders count_distinct', () => {
    const model = withMetrics([
      {
        kind: 'simple',
        name: 'unique_orders',
        table: 'orders',
        aggregation: 'count_distinct',
        column: 'order_id',
        grain: ['order_id'],
        additivity: 'non_additive',
      },
    ]);
    const compiled = compileQuery({ metrics: ['unique_orders'] }, model);
    expect(compiled.sql).toContain('count(distinct "order_id")');
  });
});

describe('row-level security variants', () => {
  it('accepts a qualified column and a valueless predicate', () => {
    const secure: SemanticModel = {
      ...salesModel,
      tables: salesModel.tables.map((table) =>
        table.name === 'orders' ? { ...table, rls: [{ column: 'orders.region', op: 'is not null' as const }] } : table,
      ),
    };
    const compiled = compileQuery({ metrics: ['revenue'] }, secure);
    expect(compiled.sql).toContain('"region" IS NOT NULL');
  });
});

describe('expression edge cases', () => {
  it('reports a mismatched closing token', () => {
    expect(() => parseMetricExpr('(a b)')).toThrow(/closing parenthesis/);
  });

  it('returns no references for a number node', () => {
    expect(refsOf({ type: 'number', value: 3 })).toEqual([]);
  });
});
