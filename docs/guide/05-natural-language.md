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

## When the statement runs and returns nothing

A statement the engine accepts can still be wrong, and the cheapest evidence of that is
an empty result: if the question asks for something and the query returns no rows, the
filter matched nothing, a join eliminated every row, or the condition is stricter than
the question. The pipeline can spend one turn on exactly that.

```ts
const pipeline = createPipeline({
  provider,
  // One turn, only when the statement returns no rows. Budgeted apart from `maxRepairs`:
  // a statement the engine refused and a statement the question refused are different
  // failures, and one counter would make the cost of each unreadable.
  emptyRetry: 'diagnosed',
  // Return the row count and the turn becomes possible. Return nothing and the pipeline
  // does not look: "I do not measure rows" is not "there were none".
  execute: async (sql) => ({ rows: await countRows(sql) }),
});

const { sql, emptyRetry } = await pipeline.ask({ question, schema });
// emptyRetry: { fired: true, recovered: false } — reach and yield, so the call can be priced
```

What the second turn says is the lever, so it is a choice rather than a constant:

| mode | what the model sees | why |
| --- | --- | --- |
| `diagnosed` | the statement it wrote, that it returned no rows, and the three causes | the model cannot infer emptiness from the schema |
| `blind` | "write the statement again" | the control: same call, no information |

Use `diagnosed`. `blind` exists because a second sample at a non-zero temperature also
moves the number, and without the control a gain cannot be attributed to the diagnosis.
The pair has now been run on the dev split (1,532 questions) and the gap is not subtle:
the extra turn returned rows on **32 of 64** cases when it said what had happened, and on
**2 of 60** when it said nothing — Fisher p ≈ 9.8e-10, at a cost difference of 0.0033 calls
per case. "Write it again" is worth almost nothing; "here is what it returned" is worth
half.
On BIRD the signal is exact rather than heuristic — no question in either split has an
empty gold result, so a zero-row answer there is wrong by construction — which is why this
turn is allowed while the row-and-column *shape* guard was rejected: that one guessed.

## Writing the answer as steps

A single draft is one decision: the model picks the grain, the joins and the filters all at
once, and a mistake in the first of them is invisible in the result. `decompose` asks for the
pieces first, in the same reply:

```ts
const pipeline = createPipeline({ provider, decompose: true });
const { sql, decomposedSteps } = await pipeline.ask({ question, schema });
// decomposedSteps: 3 — how many sub-statements the model wrote before the answer
```

The model writes `STEP 1: …`, `STEP 2: …` as working statements and then the answer in a
single fenced block; the pipeline reads the **last** block, because a reply that fences each
step would otherwise hand step one to the executor — a statement that runs and answers a
different question. `decomposedSteps` is reported so an instruction the model ignored is
visible rather than assumed to have worked.

This is not the same as `plan`, which is written in an earlier call and carried into the
prompt: on the benchmark that shape measured **−7.2pp**, because the plan anchored the
statement it was meant to prepare. `decompose` keeps the reasoning inside the generation and
costs no extra call. Its own measurement is registered in
[benchmarks](../benchmarks.md#the-candidate-the-three-prompts-cannot-write) and is still
running; until it reports, the option stays off by default.

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

## Schema cards: comments yes, samples carefully

A schema card is not only names and types. One line of business meaning per
column (`amount DECIMAL -- total amount charged for the order`) measurably
prevents wrong joins. Enum sample values are different: they can make a model
invent a filter the question never asked for. Measured: with samples but without
an explicit rule, accuracy dropped 14.8pp because the model added
`status = 'completed'` to 31 questions. The prompt now states that sample values
are examples and only stated filters may be used; samples are off by default.

## Prompt size and cost

- `renderSchemaCard(schema)` prints one line per table; pass a limit to cap it.
- `buildSqlPrompt` includes only the rules and the card. Column hints go in the
  user message, so they can be regenerated without touching the system prompt.
- `temperature` defaults to `0`: the pipeline is not a creative task.

Next: [semantic layer](06-semantic-layer.md).
