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
