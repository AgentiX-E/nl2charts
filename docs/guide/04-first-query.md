# Your first query

## Create an engine

An engine is the only thing that touches a database. In Node:

```ts
import { createDuckDbEngine } from '@agentix-e/nl2charts-node';

const engine = await createDuckDbEngine();                       // in-memory
const persistent = await createDuckDbEngine({ path: './data.duckdb' });
const readOnly = await createDuckDbEngine({ path: './data.duckdb', readOnly: true });
```

`readOnly` opens the file with DuckDB's `READ_ONLY` access mode. Use it for
anything a user can reach: the guard can be bypassed by a bug, an OS-level
read-only handle cannot.

## Wrap it in a runner

```ts
import { createRunner } from '@agentix-e/nl2charts-core';

const runner = createRunner({
  engine,
  maxRows: 1_000,        // row cap per call
  timeoutMs: 5_000,      // abort the call, even if the driver ignores the signal
  onSpan: (span) => log(span),
});

const result = await runner.sql('select region, sum(amount) as total from orders group by 1');
```

`result`:

```ts
{
  sql: 'select region, sum(amount) as total from orders group by 1 LIMIT 1001',
  columns: ['region', 'total'],
  rows: [{ region: 'north', total: '120.50' }, …],   // canonical values
  rowCount: 4,
  truncated: false,
  provenance: { path: 'sql', chart: false },
}
```

Three details worth knowing:

- **`LIMIT` injection.** If the statement has no top-level `LIMIT`, the runner
  fetches `maxRows + 1` rows. The extra row is how `truncated` is known without
  a second count query.
- **Provenance.** Every result says whether a human or a model wrote the SQL
  (`chart: true` marks the natural-language path). Audit logs need this; it is
  not optional.
- **Timeouts are real.** The runner races the engine against an abort promise,
  so a driver that ignores `AbortSignal` cannot hang the caller.

## Reading the guard's answer

```ts
import { inspectSql, withRowLimit } from '@agentix-e/nl2charts-core';

inspectSql('select 1').ok;                       // true
inspectSql('select 1; drop table t');            // { ok: false, reason: 'multiple-statements' }
inspectSql("select read_csv('/etc/passwd')");    // { ok: false, reason: 'banned-function' }
inspectSql('select * from t at (version => 1)'); // { ok: false, reason: 'version-pinned-table' }
```

Use `inspectSql` when you want a decision without an exception — for example, to
explain a rejection in a UI. `runner.sql` turns the same decision into
`NL2C_E_GUARD_REJECTED` with `details.reason`.

The default policy is a value, not a constant baked into the code:

```ts
import { DEFAULT_POLICY, createRunner } from '@agentix-e/nl2charts-core';

const strict = { ...DEFAULT_POLICY, allowedKinds: ['select'] as const };
const runner = createRunner({ engine, policy: strict });
```

Narrowing the policy is safe. Widening it is a security decision: every keyword
you unban is a statement the engine will execute.

## Streaming

```ts
for await (const batch of runner.stream('select * from events')) {
  process(batch);          // arrays of canonical rows
}
```

If the engine cannot stream, the runner yields a single batch. If it can, the
cap is enforced across batches, not per batch.

## Closing

```ts
await runner.close();     // closes the engine
```

Do it once per process (or per test file). A closed engine rejects with
`NL2C_E_ENGINE_UNAVAILABLE`; calling `close()` twice is safe.

## Running several queries safely

```ts
const [a, b] = await Promise.all([
  runner.sql('select count(*) as n from orders', { limit: 1 }),
  runner.sql('select region from orders limit 10'),
]);
```

Each call gets its own abort controller. A timeout or a caller abort affects only
that call.

Next: [natural language](05-natural-language.md).
