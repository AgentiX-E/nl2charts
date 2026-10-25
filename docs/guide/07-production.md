# Production checklist

## Security

- [ ] **The database user is read-only.** The guard is a lexical filter, not a
      sandbox. `READ_ONLY` on the DuckDB instance and a read-only role on
      PostgreSQL are the actual boundary.
- [ ] **File-reading functions are banned at the policy level**, not only by the
      default list. If you add a function to `bannedFunctions`, add a test for it
      in `packages/core/test/guard.test.ts`.
- [ ] **LLM keys never reach the browser.** `ai.baseUrl` points at your proxy.
- [ ] **Prompt injection is assumed.** A schema comment or a value can contain
      instructions. The guard is the mitigation that does not depend on the
      model behaving.
- [ ] **Log provenance.** `result.provenance.path` tells you whether a human or
      a model wrote the SQL.

## Resource limits

```ts
const runner = createRunner({
  engine,
  maxRows: 5_000,
  timeoutMs: 10_000,
  onSpan: (span) => exporter(span),
});
```

- `maxRows` caps rows, not bytes. A query returning five wide JSON columns can
  still be large; cap at the connector if that matters.
- `timeoutMs` aborts the caller even if the driver keeps running. Pair it with a
  server-side statement timeout so the database stops too.
- Streaming enforces the cap across batches.

## Observability

`onSpan` receives one event per execution:

```ts
{
  name: 'execute',
  traceId: 'trace-000001',
  spanId: 'span-execute',
  startMs, endMs,
  status: 'ok' | 'error',
  attrs: {
    'nl2charts.engine': 'duckdb-native',
    'nl2charts.sql.length': 74,
    'nl2charts.rows': 4,
    'nl2charts.truncated': false,
    'nl2charts.path': 'sql',
  },
}
```

A throwing exporter cannot break a query: the call is wrapped. Attribute names
use the `nl2charts.` prefix; mapping them to OpenTelemetry is the host's job, so
the library does not depend on an observability SDK.

## MCP server

```ts
import { attachStreams, createMcpServer } from '@agentix-e/nl2charts-mcp';

const server = createMcpServer({ runner, name: 'warehouse', version: '1.0.0' });
await attachStreams(server, process.stdin, (chunk) => process.stdout.write(chunk));
```

Four tools are exposed:

| Tool | Input | Returns |
| --- | --- | --- |
| `run_sql` | `{ sql }` | rows, or a guard rejection |
| `engine_info` | `{}` | engine id, dialect, row cap |
| `query_metric` | `{ model, query }` | compiled SQL and rows |
| `explain_metric` | `{ model, query, optimize? }` | SQL before and after optimization, both plans |

`query_metric` is the one to give an agent. `run_sql` asks the caller to write the
statement, and a caller that does not know what `revenue` means writes the wrong
one — the failure this project exists to measure. `query_metric` takes a semantic
model once and then only names metrics and dimensions:

```json
{
  "name": "query_metric",
  "arguments": {
    "model": { "name": "shop", "tables": [], "metrics": [] },
    "query": { "metrics": ["revenue"], "dimensions": ["region"] }
  }
}
```

`explain_metric` compiles the same query and returns the plan without executing
it, so an agent can inspect what it is about to ask for. `stages` names the four
pipeline steps — plan, optimize, lower, render — and `plan` / `optimizedPlan` are
returned side by side so the rewrite is visible rather than asserted.

A client's `limit` is a request, not a permission: it is clamped to the runner's
row cap, so a server configured for 1,000 rows cannot be asked for 5,000.

A guard rejection or a semantic error is a tool error (`-32000`) with the contract
code in the message — `NL2C_E_UNKNOWN_METRIC` can be branched on, prose cannot.
Neither is a transport crash.

## Reading a trace

A trace is the story of one query: which stage ran, for how long, what came out.
It is also the artefact people cite when they argue about a number, so the library
lets you seal one and check it later.

```ts
import { sealTrace, verifyTrace, replayTrace } from '@agentix-e/nl2charts-studio';

const sealed = sealTrace([
  { name: 'guard', startMs: 0, endMs: 2 },
  { name: 'compile', startMs: 2, endMs: 9 },
  { name: 'execute', startMs: 9, endMs: 41, attrs: { 'nl2charts.rows': 239 } },
]);

verifyTrace(sealed);      // { ok: true, count: 3 }
replayTrace(sealed);      // { ok: true, durationMs: 41, slowest: { name: 'execute', … }, errors: [] }
```

Each event is hashed together with the previous event's hash, and replay refuses a
chain that does not reach its head:

| Edit | Verdict |
| --- | --- |
| change one `endMs` | `{ ok: false, brokenAt: 1, reason: 'hash' }` |
| drop an event | `{ ok: false, reason: 'head' }` |
| point `prev` elsewhere | `{ ok: false, brokenAt: 1, reason: 'link' }` |

Hashing uses canonical JSON — keys sorted, `undefined` dropped — so an event that
went through `JSON.stringify` and back still verifies. It is FNV-1a, not a
cryptographic hash: this detects an edit, it does not stop a determined forger, and
the guide says FNV-1a rather than "hash" because the difference matters.

`replayTrace` reads no clock. The same sealed trace replays to the same summary,
which is what makes it quotable.

Two views render that summary without a DOM — paste them into an incident review:

```ts
import { renderTraceSvg, renderIssueListText } from '@agentix-e/nl2charts-studio';

const svg = renderTraceSvg(replay);          // one bar per stage, width ∝ duration
const text = renderIssueListText(issues);    // errors first, summary last
```

The timeline marks a failed stage with `data-status="error"` and prints its code, so
"where did the time go" and "what broke" answer the same glance. A trace that does
not verify renders as that sentence rather than as an empty axis — an empty
timeline would be a claim, and the claim is exactly what failed.

## Choosing among candidates

One sample per question is the default. Three samples plus a model that picks between
them measured **+2.6pp over majority voting** in one BIRD Mini-Dev run and **+0.6pp
when repeated**, with five candidates doing no better than three — so treat this as a
capability to try on your data, not as a known improvement. The recipe is four steps
and no new dependency:

```ts
import { chooseCandidate, createPipeline, createHttpProvider } from '@agentix-e/nl2charts-ai';

const provider = createHttpProvider({ baseUrl, apiKey, model });
const pipeline = createPipeline({ provider, temperature: 0.7 });

const candidates = [];
for (let sample = 0; sample < 3; sample += 1) {
  const { sql } = await pipeline.ask({ question, schema });
  const result = await run(sql);              // your engine, read-only
  if (result.ok) candidates.push({ sql, rows: result.rows });
}

const { sql, decided } = await chooseCandidate(provider, question, candidates);
```

Three things worth knowing before you turn it on:

- **It costs three extra calls**, and on a schema the model already understands the
  gain is inside the noise: the two runs that measured it disagree (+2.6pp, then
  +0.6pp). Measure it on your own questions before paying for it.
- **`decided: false` is not an error.** It means the reply carried no usable index;
  the chosen candidate is then the first one, which is what a single call would have
  returned. Log the rate — a selector that stops answering is a prompt regression,
  not a model regression.
- **Only executed candidates are offered.** A statement that failed to run is not a
  candidate, and a selector shown one would have to guess whether it was broken.

### What selection can and cannot buy you

Before paying for candidates, it is worth measuring the ceiling: how often the set you
generated contains a correct statement at all. If it rarely does, a better selector has
nothing to select from, and the money belongs in the generator. `withCallCounter` gives
you the other half of the same ledger — what the pipeline actually spent:

```ts
import { createPipeline, createHttpProvider, withCallCounter } from '@agentix-e/nl2charts-ai';

const counter = withCallCounter(createHttpProvider({ baseUrl, apiKey, model }));
const pipeline = createPipeline({ provider: counter.provider, temperature: 0.7 });

await pipeline.ask({ question, schema });
counter.calls();  // 1, or more when a repair ran or a plan was written
```

Count rather than infer: an arm's own configuration does not know that writing a plan is
a second call or that the selector is a third, and a cost that is inferred is a cost that
can be wrong in the flattering direction.

## Repairing a rejected statement

The pipeline retries a statement the guard or the engine refused, and **three** times by
default. Each retry is not "try again": it carries a diagnosis built from what the engine
and the schema actually contain.

```ts
const pipeline = createPipeline({
  provider,
  maxRepairs: 3,                                  // default
  execute: async (sql) => { await engine.run(sql); },  // gate for execution errors
  prompt: { dialect: 'PostgreSQL' },
});
```

What the model is told on the second turn:

```
That statement was rejected. Fix exactly the problem below; keep the rest of the statement as it is.

PostgreSQL, 42703: column s.schoolname does not exist
Engine hint: Perhaps you meant to reference the column "s.SchoolName".

Closest identifier in the schema: students.SchoolName.
`s` has: StudentID, StudentName, Class, SchoolName.

Use only tables and columns that exist in the schema above, spelled exactly as they are there.
```

Four properties make that message worth the call:

- **The engine's own error**, not a summary: SQLSTATE where the engine uses one,
  position where it reports one, and its hint.
- **The schema's answer**: the identifier two edits away, resolved through the alias the
  statement bound (`s` → `students`), and the columns the table really has.
- **A class-specific instruction**: a grouping failure says to add the column to
  `GROUP BY`; a timeout says to filter before joining. Nine classes, each with its own
  sentence (`classifyFailure`).
- **A bound**: the block is capped at 900 characters, so a wide schema cannot crowd out
  the question.

`ask()` returns `failures` (the class of every rejected attempt) and `diagnoses` (one line
each), and when the budget is spent the thrown error carries `failureClasses`, `lastError`
and `lastSql` in `details`.

What the loop can and cannot reach is worth knowing before you enable it: a statement that
executes and answers the wrong question produces **no error**, so there is nothing to
diagnose. On BIRD Mini-Dev with `deepseek-chat`, 489 of 498 first statements executed — the
loop's ceiling there is 1.8pp. On a weaker model writing 20–36% invalid SQL, the same loop
has an order of magnitude more to work with. Measure the ceiling on your own model before
budgeting for retries. Those are what the repair funnel in [the benchmark page](../benchmarks.md) is computed from.

Three cases where the loop does nothing, which is the point:

| Case | What happens |
| --- | --- |
| First statement executes | `attempts: 1`, no repair turn, no extra call |
| Guard refuses a `DELETE` | Classified as `guard`, told the read-only rule, never executed |
| Engine reports a syntax error at a position | The caret line is drawn under that position, not under the first token |

## Gates you inherit

These run in CI on every commit, and the same commands run locally:

| Gate | Fails when |
| --- | --- |
| `gate:coverage` | any package is below 95% on statements, branches, functions or lines |
| `gate:layering` | a package imports one that breaks its runtime |
| `gate:exports` | the public API drifted from `api-surface.json` |
| `gate:budgets` | a package's gzipped output exceeds its ceiling |
| `gate:secrets` | a credential-shaped string is tracked |
| `gate:bird` | an external-benchmark arm falls more than 4pp below its floor |

The secret scan prints the file and the rule, never the matched text — echoing a
token into a CI log is the same leak to a different audience. It has a self-test
that plants a token, a clean environment reference and a key in a dotfile, so the
scanner is known to catch the first and third and to ignore the second.

## Upgrading

The public surface is snapshotted in `api-surface.json`. The compatibility rules:

| Rule | Meaning |
| --- | --- |
| A1 | An export never disappears within a major version |
| A2 | A required parameter is never added |
| A3 | A return type is never narrowed |
| A4 | New configuration is optional |
| A5 | A subpath keeps working |

`pnpm gate:exports` fails the build on any drift. Updating the snapshot is a
reviewed commit, not an automatic consequence of a refactor.

## Performance

- `core` is ~15 KB gzip; `chart` ~7 KB (ECharts is a peer, not a dependency).
- Import symbols, not namespaces: `import * as core` defeats tree-shaking.
  Package linting forbids it in documentation examples.
- Budgets are enforced per package in `budgets.json`. Raising one requires
  review; lowering one is always welcome.

## Testing your integration

Use the same tools CI uses:

```ts
import { recordCase, runContractSuite } from '@agentix-e/nl2charts-devkit';

const golden = await recordCase(runner, 'monthly revenue', 'select date_trunc(...)');
const { passed, failed, results } = await runContractSuite(runner, [golden]);
```

A golden case stores columns, row count and a row-set hash. It survives
formatting changes and fails when the data changes — which is usually what you
want for a warehouse contract test.

## Release checklist

- [ ] `pnpm verify` green locally
- [ ] CI `quality` and `benchmark` jobs green
- [ ] `api-surface.json` diff reviewed
- [ ] `budgets.json` diff reviewed
- [ ] Benchmark artifacts attached to the release
- [ ] No new `NL2C_E_*` code without a test that produces it
