# Natural language

The `ai` package is the only place a model is called. It produces SQL; it never
executes it. Execution stays behind the guard in `core`.

## Bring your own provider

`createHttpProvider` talks to any OpenAI-compatible `/chat/completions`
endpoint:

```ts
import { createHttpProvider } from '@agentix-e/nl2charts-ai';

const provider = createHttpProvider({
  baseUrl: '/api/llm',          // your server, which holds the key
  model: 'your-model',
  timeoutMs: 30_000,
});
```

> **Never put a vendor URL and a key in browser code.** `baseUrl` must point at
> your own proxy. The library cannot enforce this; your build pipeline must.

The provider maps failures onto contract codes:

| Situation | Code |
| --- | --- |
| Network error, timeout, non-2xx | `NL2C_E_LLM_UNAVAILABLE` |
| Body is not JSON, or has no content | `NL2C_E_LLM_INVALID_RESPONSE` |

## Schema linking

Long schemas do not fit in a prompt. `linkSchema` ranks columns with three
independent recallers and fuses them with Reciprocal Rank Fusion:

1. **name** — the question tokens overlap the column name (`order_date` matches
   "date");
2. **alias** — a curated synonym matches (`sales` → `amount`);
3. **value** — a sample value matches (`north` → `region`).

```ts
import { linkSchema } from '@agentix-e/nl2charts-ai';

const linked = linkSchema('sales in the north by territory', [
  { table: 'orders', columns: [
      { name: 'region', type: 'VARCHAR', aliases: ['territory'], samples: ['north', 'south'] },
      { name: 'amount', type: 'DECIMAL', aliases: ['sales'] },
  ]},
], 12);

// [{ table: 'orders', column: 'amount', score: …, recalledBy: ['alias', 'name'] },
//  { table: 'orders', column: 'region', score: …, recalledBy: ['alias', 'name', 'value'] }]
```

Each recaller is optional. Disabling them is how the ablation measures each
one's contribution:

```ts
linkSchema(question, schema, 3, ['name']);              // name only
linkSchema(question, schema, 3, ['name', 'alias']);     // + aliases
linkSchema(question, schema, 3, ['name', 'alias', 'value']); // + value profiling
```

Measured on 25 questions over the benchmark fixture (recall@3): name 20%,
+alias 56%, +value 84%. The value profiler is worth 28pp on its own. See
[benchmarks](../benchmarks.md).

## The pipeline, including repair

```ts
import { createPipeline } from '@agentix-e/nl2charts-ai';

const pipeline = createPipeline({ provider, maxRepairs: 2 });

const { sql, attempts, linked } = await pipeline.ask({
  question: 'revenue by region',
  schema,
});
```

The loop is:

1. link the schema and build a prompt that states the rules (SELECT only, one
   statement, no comments);
2. ask for a candidate;
3. extract SQL from the answer (fenced block or plain text);
4. run the guard;
5. if rejected, send the rejection reason back and ask again — up to
   `maxRepairs` times;
6. if the budget is exhausted, throw `NL2C_E_GUARD_REJECTED` with the attempt
   count and the last reason.

A model that "fixes" a query by dropping a table cannot succeed, because the
guard runs on every attempt.

## Deterministic tests with replay

Recorded exchanges are a first-class provider, not a mock:

```ts
import { createReplayProvider } from '@agentix-e/nl2charts-ai';

const provider = createReplayProvider([
  { match: 'revenue by region', response: '```sql\nselect region, sum(amount) from orders group by 1\n```' },
]);
```

To capture new fixtures, wrap a live provider:

```ts
import { recordProvider } from '@agentix-e/nl2charts-ai';

const calls = [];
const recording = recordProvider(liveProvider, calls);
```

CI runs the replay provider, so tests are deterministic and cost nothing. Live
numbers are produced only by the benchmark workflow with a real key.

## Prompt size and cost

- `renderSchemaCard(schema)` prints one line per table; pass a limit to cap it.
- `buildSqlPrompt` includes only the rules and the card. Column hints go in the
  user message, so they can be regenerated without touching the system prompt.
- `temperature` defaults to `0`: the pipeline is not a creative task.

Next: [semantic layer](06-semantic-layer.md).
