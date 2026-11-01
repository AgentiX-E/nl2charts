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

The provider maps failures onto contract codes. The split that matters is
whether the same request could work later: an outage is worth retrying and a
refusal is not.

| Situation | Code |
| --- | --- |
| Network error, timeout, 408, 429, 5xx | `NL2C_E_LLM_UNAVAILABLE` |
| 4xx the endpoint will refuse again — wrong model name, bad key, a field it does not accept | `NL2C_E_LLM_REJECTED` |
| Body is not JSON, or parses to something that is not an object, or has no content | `NL2C_E_LLM_INVALID_RESPONSE` |

A `NL2C_E_LLM_REJECTED` carries the endpoint's own sentence in
`details.detail` when the body had one, so the error reads
`llm refused the request with 400: Unsupported value: 'temperature' does not
support 0 with this model` rather than `llm returned 400`.

## Running on a model we did not benchmark

Every reading in the benchmark table was taken on one backbone. If you point
this library at a different model, here is what is measured, what is not, and
what you have to decide.

**What still works without configuration.** The repair loop — execute, diagnose
the engine's error, send the diagnosis back — is not tuned to a model. On
`glm-4-flash`, which writes far more invalid SQL, three diagnosed repairs were
worth **+6.4pp** (30.1% → 36.5%, sixteen cases won and none lost, p<0.0001) at
0.63 extra calls per case. The weaker the model, the more the loop is worth:
on DeepSeek only 12 of 498 first statements fail to execute, so its entire
repair ceiling is 2.4pp.

**What costs accuracy.** Two things, and neither is the vendor:

1. *Levers selected for a stronger model.* Adding the dataset hint to
   `glm-4-flash` made its execution failures **worse**, 20.9% → 36.5%. More
   context is not more capability. If a model binds columns badly, a longer
   prompt is a longer wrong prompt.
2. *A candidate the prompts were not written for.* Feeding a second model's
   statement into the selector raised the ceiling by 2.7pp and lost 1.11pp,
   because the selector threw away 75 of the 1,018 winnable cases instead of
   17.

**What breaks silently.** Readers, not accuracy. `parseSelection` returns `-1`
when a reply is not a bare choice, and the caller keeps candidate one; the
decomposition reader counts zero steps; the audit reader counts zero omissions.
Each of those is "the mechanism did not run", which reports as a lower score
rather than an error. `replyShape` and `formatProfile` read that off the replies
themselves and every run's artifact carries the aggregate:

```ts
const { report } = await runBird({ /* … */ });
report.arms[0].format; // { replies: 496, fenced: 'always', index: 'sometimes', … }
```

`index: 'never'` means the selector cannot read this model — stop paying for it
before you read its score as a verdict on the model.

**What you may have to tell us.** A reasoning model that only accepts its own
default answers `temperature: 0` with a 400. Pass `null` and the field is not
sent at all; that is different from `undefined`, which sends zero:

```ts
const pipeline = createPipeline({ provider, temperature: null });
```

`retries` and `retryDelayMs` on the provider are worth raising for a model with
a tight rate limit — a 429 retried inside the provider is a call, and a 429
returned to the caller is a failed case.

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
