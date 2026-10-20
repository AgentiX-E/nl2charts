import { describe, expect, it } from 'vitest';
import { hasErrors, inferAdditivity, validateModel } from '../src/index.js';
import type { MdlModel } from '../src/index.js';

const base: MdlModel = {
  name: 'sales',
  tables: ['orders', 'customers'],
  metrics: [
    {
      name: 'revenue',
      expr: 'sum(orders.amount)',
      table: 'orders',
      grain: ['order_id'],
      additivity: 'additive',
      rationale: 'net of refunds',
    },
  ],
  relationships: [{ from: 'orders', to: 'customers', on: 'orders.customer_id = customers.id' }],
};

const codes = (model: MdlModel): string[] => validateModel(model).map((diagnostic) => diagnostic.code);

describe('model validation', () => {
  it('accepts a complete model', () => {
    expect(validateModel(base)).toEqual([]);
    expect(hasErrors(validateModel(base))).toBe(false);
  });

  it('requires at least one metric and stops there', () => {
    expect(validateModel({ metrics: [] })).toEqual([
      { severity: 'error', code: 'empty-model', message: 'a model needs at least one metric', path: '/metrics' },
    ]);
  });

  it('reports duplicate metric names with both paths', () => {
    const model: MdlModel = {
      ...base,
      metrics: [base.metrics[0]!, { ...base.metrics[0]!, rationale: 'again' }],
    };
    const duplicate = validateModel(model).find((diagnostic) => diagnostic.code === 'duplicate-metric');
    expect(duplicate?.path).toBe('/metrics/1/name');
    expect(duplicate?.message).toContain('/metrics/0');
  });

  it('reports alias conflicts between metrics and with names', () => {
    const model: MdlModel = {
      ...base,
      metrics: [
        { ...base.metrics[0]!, aliases: ['sales', 'revenue'] },
        { name: 'orders', expr: 'count(1)', table: 'orders', grain: ['x'], additivity: 'additive', rationale: 'r', aliases: ['sales'] },
      ],
    };
    expect(validateModel(model).filter((diagnostic) => diagnostic.code === 'alias-conflict')).toHaveLength(2);
  });

  it('rejects a non snake_case name', () => {
    const model: MdlModel = { ...base, metrics: [{ ...base.metrics[0]!, name: 'Total Revenue' }] };
    expect(validateModel(model).find((diagnostic) => diagnostic.code === 'invalid-name')?.path).toBe('/metrics/0/name');
  });

  it('requires an expression and a declared table', () => {
    const model: MdlModel = {
      ...base,
      metrics: [{ name: 'x', table: 'missing', grain: ['a'], rationale: 'r' }],
    };
    const found = codes(model);
    expect(found).toContain('missing-expr');
    expect(found).toContain('unknown-table');
  });

  it('warns about missing grain, rationale and additivity', () => {
    const model: MdlModel = { ...base, metrics: [{ name: 'x', expr: 'sum(a)', table: 'orders' }] };
    expect(validateModel(model).map((diagnostic) => diagnostic.code).sort()).toEqual([
      'additivity-inferred',
      'missing-grain',
      'missing-rationale',
    ]);
  });

  it('reports dangling and duplicated relationships', () => {
    const model: MdlModel = {
      ...base,
      relationships: [
        { from: 'orders', to: 'ghost', on: 'x' },
        { from: 'orders', to: 'customers', on: 'y' },
        { from: 'orders', to: 'customers', on: 'y' },
      ],
    };
    const found = validateModel(model);
    expect(found.filter((diagnostic) => diagnostic.code === 'relationship-endpoint-unknown')).toHaveLength(1);
    expect(found.filter((diagnostic) => diagnostic.code === 'duplicate-relationship')).toHaveLength(1);
  });

  it('skips table checks when no table list is declared', () => {
    const model: MdlModel = {
      metrics: [{ name: 'x', expr: 'sum(a)', table: 'anything', grain: ['a'], additivity: 'additive', rationale: 'r' }],
      relationships: [{ from: 'a', to: 'b', on: 'x' }],
    };
    expect(validateModel(model)).toEqual([]);
  });

  it('infers additivity from the expression', () => {
    expect(inferAdditivity('sum(x)')).toBe('additive');
    expect(inferAdditivity('count(*)')).toBe('additive');
    expect(inferAdditivity('avg(x)')).toBe('non-additive');
    expect(inferAdditivity('count(distinct x)')).toBe('non-additive');
    expect(inferAdditivity('x + 1')).toBe('unknown');
    expect(inferAdditivity(undefined)).toBe('unknown');
  });

  it('flags errors separately from warnings', () => {
    expect(hasErrors([{ severity: 'warn', code: 'missing-grain', message: '', path: '' }])).toBe(false);
    expect(hasErrors([{ severity: 'error', code: 'missing-expr', message: '', path: '' }])).toBe(true);
  });
});
