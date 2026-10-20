# Compiling metrics to SQL

This chapter is about turning a reviewed metric definition into SQL you can
execute. It assumes the model from [the semantic layer chapter](06-semantic-layer.md).

## Why not string templates

A template like `select {dim}, sum({measure}) from {table}` is correct until the
first ratio, the first cumulative total, or the first one-to-many join. Then the
template grows `if` branches, and each branch is a place where a number can be
quietly wrong. The compiler instead builds a small graph of semantic operations
and rewrites that graph.

```
MetricQuery
   │ Plan       resolve metrics, dimensions, joins, grain
   ▼
DataflowPlan
   │ Optimize   deduplicate reads, collapse projections, merge limits
   ▼
DataflowPlan'
   │ Lower      one CTE per node, dialect-neutral
   ▼
SqlPlan
   │ Render     quoted SQL
   ▼
SQL
```

```ts
import { compileQuery, explainQuery } from '@agentix-e/nl2charts-core/semantic';

const compiled = compileQuery({ metrics: ['aov'], dimensions: ['region'] }, model);
compiled.sql;          // the statement
compiled.optimizedPlan; // the graph, for "how was this number computed"
compiled.sqlPlan;      // the CTEs
```

`explainQuery()` returns the same plan without rendering SQL.

## The model in one screen

```ts
const model: SemanticModel = {
  name: 'sales',
  tables: [{
    name: 'orders',
    columns: [
      { name: 'order_id', type: 'number' },
      { name: 'order_date', type: 'date' },
      { name: 'region', type: 'string' },
      { name: 'amount', type: 'number' },
      { name: 'status', type: 'string' },
    ],
    rls: [{ column: 'region', op: '=', value: 'north' }],   // injected everywhere
  }],
  relationships: [
    { from: 'orders', to: 'customers', on: { from: 'customer_id', to: 'customer_id' }, cardinality: 'many_to_one' },
  ],
  dimensions: [
    { name: 'region', table: 'orders', column: 'region', kind: 'categorical' },
    { name: 'month', table: 'orders', column: 'order_date', kind: 'time', grain: 'month' },
  ],
  metrics: [{
    kind: 'simple',
    name: 'revenue',
    table: 'orders',
    aggregation: 'sum',
    column: 'amount',
    filter: [{ column: 'status', op: '=', value: 'completed' }],
    grain: ['order_id'],          // the grain the measure lives on
    additivity: 'additive',
    rationale: 'completed orders only',
  }],
};
```

## Five metric types

| Kind | Compiles to | Trap it avoids |
| --- | --- | --- |
| `simple` | one aggregate, optional `FILTER (WHERE …)` | a filter written as a `WHERE` that drops other aggregates |
| `ratio` | numerator and denominator aggregated separately, then divided | `avg(a/b)` instead of `sum(a)/sum(b)` |
| `derived` | arithmetic over components (`revenue - tax`) | computing on unaggregated rows |
| `cumulative` | window `sum(...) over (order by month rows between unbounded preceding and current row)` | a self-join that double counts |
| `conversion` | two conditional counts, then divided | counting the denominator after filtering the numerator |

`ratio` is worth an example. `sum(amount) / count(order_id)` and
`avg(amount)` are equal only when every group has the same number of rows. The
compiler emits the first; the model cannot express the second as a ratio.

## Grain-first aggregation

Every measure declares `grain` (for example `order_id`). The compiler:

1. aggregates the measure at that grain (plus the join keys it needs);
2. joins dimension tables;
3. re-aggregates only if the metric is additive.

That order is what prevents fan-out. A hand-written join from `orders` to
`order_items` repeats each order once per item:

```sql
-- 3.00x the truth, and no error
select sum(o.amount) from orders o join order_items i on i.order_id = o.order_id;
```

Measured on the benchmark fixture, the naive join is **3.00x** the compiled
result for every customer segment. The compiler never adds that join unless a
requested dimension needs it, and when it does, the measure is already
aggregated.

## Row-level security and masking

- `rls` predicates are injected into **every** read of the table, including the
  reads the compiler generates for joins. A contradictory query filter cannot
  escape them: it produces zero rows.
- Columns marked `masked` are absent from every read; referencing one in a
  metric, dimension or filter is a compile error (`MASKED_COLUMN`), not a null.

```ts
import { compileQuery } from '@agentix-e/nl2charts-core/semantic';

compileQuery({ metrics: ['revenue'], dimensions: ['email'] }, model);
// Nl2ChartsError: column customers.email is masked  (details.code = 'MASKED_COLUMN')
```

## Errors you will actually see

| `details.code` | Meaning |
| --- | --- |
| `UNKNOWN_METRIC` | the metric does not exist; aliases are resolved first |
| `AMBIGUOUS_METRIC` | one alias is claimed by several metrics |
| `UNKNOWN_DIMENSION` | the dimension is not declared |
| `AMBIGUOUS_COLUMN` | an unqualified column exists in more than one table |
| `MASKED_COLUMN` | the column is not readable |
| `AMBIGUOUS_JOIN` | more than one relationship connects the tables; candidates are listed |
| `NO_JOIN_PATH` | no declared relationship connects the tables |
| `MISSING_WINDOW_ORDER` | a cumulative metric was queried without its order dimension |
| `UNUSED_FILTER` | a filter targets a table the query never reads |
| `NO_METRIC_REFS` | a derived expression references no metric |
| `METRIC_KIND_MISMATCH` | a ratio or derived metric references a metric that is not simple |

Every code is a value in `details`, so a UI can branch without parsing messages.

## Determinism and limits

- A query with `limit` is compiled with an `ORDER BY` over all output columns
  before the cap, so the truncated set is reproducible.
- The compiler is pure: no I/O, no clock, no random identifiers. The same model
  and query produce the same SQL.
- Generated SQL still goes through the statement guard when executed by the
  runner; the compiler does not bypass it.

## Current limits (v0.2.0)

- Dimensions may come from the metric's table or one `many_to_one` hop away.
- `derived` metrics reference `simple` metrics only.
- One dialect is rendered (DuckDB). Other engines need a new visitor set over
  `SqlPlan`; the plan itself is dialect-neutral.
- Optimizations are read deduplication, projection collapse and limit merging.
  Join pruning is not needed yet because joins are only added when a dimension
  needs them — and that is checked by the 144-query equivalence benchmark.
