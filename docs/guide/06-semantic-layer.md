# Semantic layer

A semantic layer is a reviewed definition of metrics. The `studio` package
contains its validation core — deliberately without any UI, so it can run in CI.

## A model document

```ts
import { validateModel } from '@agentix-e/nl2charts-studio';

const model = {
  name: 'sales',
  tables: ['orders', 'customers'],
  metrics: [
    {
      name: 'revenue',
      expr: 'sum(orders.amount)',
      table: 'orders',
      grain: ['order_id'],
      additivity: 'additive',
      aliases: ['sales'],
      rationale: 'net of refunds',
    },
  ],
  relationships: [
    { from: 'orders', to: 'customers', on: 'orders.customer_id = customers.id' },
  ],
};

const diagnostics = validateModel(model);   // [] when the model is complete
```

## The rules

| Code | Severity | Meaning |
| --- | --- | --- |
| `empty-model` | error | no metrics at all |
| `duplicate-metric` | error | the same name twice; the message points at both paths |
| `alias-conflict` | error | an alias used by two metrics, or colliding with a name |
| `invalid-name` | error | not `snake_case` |
| `missing-expr` | error | a metric with no expression |
| `unknown-table` | error | `table` is not in the declared list |
| `relationship-endpoint-unknown` | error | a join to a table that does not exist |
| `missing-grain` | warn | grain undeclared |
| `missing-rationale` | warn | reviewers cannot tell why the definition is right |
| `additivity-inferred` | warn | additivity was guessed from the expression |
| `duplicate-relationship` | warn | the same join declared twice |

Every diagnostic carries a JSON Pointer (`/metrics/0/name`), so an editor can
place a marker without string matching.

## Additivity

```ts
import { inferAdditivity } from '@agentix-e/nl2charts-studio';

inferAdditivity('sum(x)');                 // 'additive'
inferAdditivity('count(distinct x)');      // 'non-additive'
inferAdditivity('avg(x)');                 // 'non-additive'
inferAdditivity('x + 1');                  // 'unknown'
```

The inference is a prompt, not an answer: writing `additivity` explicitly
silences the warning and records the decision.

## Why validation lives in a package without UI

- It runs in CI: a pull request that introduces an alias conflict fails before
  review.
- It runs in the editor: the same function produces markers.
- It has no React dependency, so it can be used from a CLI, a language server or
  a test.

The UI, when it exists, will be a projection of these diagnostics. That ordering
is deliberate: an editor that can input but cannot detect problems is worse than
no editor.

Next: [production checklist](07-production.md).
