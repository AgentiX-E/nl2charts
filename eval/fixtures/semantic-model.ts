import type { SemanticModel } from '../../packages/core/src/semantic/index.js';

export const salesModel: SemanticModel = {
  name: 'sales',
  tables: [
    {
      name: 'orders',
      columns: [
        { name: 'order_id', type: 'number' },
        { name: 'customer_id', type: 'number' },
        { name: 'order_date', type: 'date' },
        { name: 'region', type: 'string' },
        { name: 'channel', type: 'string' },
        { name: 'amount', type: 'number' },
        { name: 'tax', type: 'number' },
        { name: 'status', type: 'string' },
      ],
    },
    {
      name: 'order_items',
      columns: [
        { name: 'item_id', type: 'number' },
        { name: 'order_id', type: 'number' },
        { name: 'quantity', type: 'number' },
        { name: 'price', type: 'number' },
      ],
    },
    {
      name: 'customers',
      columns: [
        { name: 'customer_id', type: 'number' },
        { name: 'segment', type: 'string' },
        { name: 'region', type: 'string' },
        { name: 'email', type: 'string', masked: true },
      ],
    },
  ],
  relationships: [
    { from: 'orders', to: 'customers', on: { from: 'customer_id', to: 'customer_id' }, cardinality: 'many_to_one' },
    { from: 'order_items', to: 'orders', on: { from: 'order_id', to: 'order_id' }, cardinality: 'many_to_one' },
  ],
  dimensions: [
    { name: 'region', table: 'orders', column: 'region', kind: 'categorical' },
    { name: 'channel', table: 'orders', column: 'channel', kind: 'categorical' },
    { name: 'status', table: 'orders', column: 'status', kind: 'categorical' },
    { name: 'month', table: 'orders', column: 'order_date', kind: 'time', grain: 'month' },
    { name: 'segment', table: 'customers', column: 'segment', kind: 'categorical' },
    { name: 'customer_region', table: 'customers', column: 'region', kind: 'categorical' },
    { name: 'email', table: 'customers', column: 'email', kind: 'categorical' },
  ],
  metrics: [
    {
      kind: 'simple',
      name: 'revenue',
      table: 'orders',
      aggregation: 'sum',
      column: 'amount',
      filter: [{ column: 'status', op: '=', value: 'completed' }],
      grain: ['order_id'],
      additivity: 'additive',
      aliases: ['sales'],
      rationale: 'completed orders only',
    },
    {
      kind: 'simple',
      name: 'orders',
      table: 'orders',
      aggregation: 'count',
      column: 'order_id',
      grain: ['order_id'],
      additivity: 'additive',
    },
    {
      kind: 'simple',
      name: 'tax',
      table: 'orders',
      aggregation: 'sum',
      column: 'tax',
      filter: [{ column: 'status', op: '=', value: 'completed' }],
      grain: ['order_id'],
      additivity: 'additive',
    },
    { kind: 'ratio', name: 'aov', numerator: 'revenue', denominator: 'orders' },
    { kind: 'derived', name: 'net_revenue', expr: 'revenue - tax' },
    { kind: 'cumulative', name: 'ytd_revenue', input: 'revenue', orderBy: 'month', frame: 'unbounded' },
    {
      kind: 'conversion',
      name: 'paid_rate',
      table: 'orders',
      numerator: [{ column: 'status', op: '=', value: 'completed' }],
      denominator: [{ column: 'order_id', op: 'is not null' }],
      grain: ['order_id'],
    },
    {
      kind: 'simple',
      name: 'avg_order',
      table: 'orders',
      aggregation: 'avg',
      column: 'amount',
      grain: ['order_id'],
      additivity: 'non_additive',
    },
  ],
};

export const secureModel: SemanticModel = {
  ...salesModel,
  name: 'secure-sales',
  tables: salesModel.tables.map((table) =>
    table.name === 'orders' ? { ...table, rls: [{ column: 'region', op: '=' as const, value: 'north' }] } : table,
  ),
};
