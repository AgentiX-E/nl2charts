# Query a SQLite database

SQLite is the second engine that ships with `@agentix-e/nl2charts-node`, next to
DuckDB. It exists for two reasons: a large share of published text-to-SQL data
is SQLite, and a single-file database is often the only thing a small deployment
has.

```ts
import { createSqliteEngine } from '@agentix-e/nl2charts-node';
import { createRunner } from '@agentix-e/nl2charts-core';

const engine = await createSqliteEngine({ path: './shop.sqlite' });
const runner = createRunner({ engine });

const result = await runner.sql('select region, sum(amount) from orders group by region');
await engine.close();
```

The engine opens the file **read-only** by default. Everything above it (`guard`,
`runner`, `chart`) behaves exactly as it does for DuckDB, because they see an
`Engine`, not a dialect.

## What this adapter does not hide

`node:sqlite` returns rows as objects until Node exposes `setReturnArrays()`, and
that has three consequences you should know before relying on the output:

| Situation | What you get | Why |
| --- | --- | --- |
| `select 1 as a, 2 as a` | one column `a` | object keys collapse duplicates |
| Empty result | no columns listed | column names come from the first row |
| Column order | the order the driver reports | not affected by the above |

If a query must keep duplicate output names, alias them (`select 1 as left_a,
2 as right_b`). The benchmark harness does not use this adapter for judging for
exactly this reason: it executes through the reference SQLite driver, which
returns tuples. See [benchmarks](../benchmarks.md).

## Read-only is enforced by the file, not by trust

```ts
const engine = await createSqliteEngine({ path: './shop.sqlite', readOnly: false });
```

Only pass `readOnly: false` when the process is the writer. The statement guard
in `core` already refuses DDL and DML before the engine sees it, so a second
gate exists; the file mode is the one that survives a bug in the first.

## Errors you will see

| Code | When |
| --- | --- |
| `NL2C_E_ENGINE_UNAVAILABLE` | `node:sqlite` is missing (Node < 22) or the file does not exist |
| `NL2C_E_ENGINE_FAILED` | the statement is invalid, or the file is opened read-only and the statement writes |
| `NL2C_E_TIMEOUT` | the caller's `AbortSignal` was already aborted |

`node:sqlite` is experimental in Node 22 and prints a warning on first import.
The adapter imports it lazily, so a DuckDB-only deployment never pays for it.
