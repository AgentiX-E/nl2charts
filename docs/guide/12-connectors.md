# Connectors: what the product promises each engine

A connector is not a driver. It is the set of promises this library makes about
an engine *before* a query reaches it: how identifiers are quoted, how rows are
capped, whether another database can be attached, and that the connection is
read-only. Drivers need a server; these promises do not, so all of them are
tested in CI without one.

## The six engines

| Engine | Identifier quoting | Row cap | `ATTACH` |
| --- | --- | --- | --- |
| `duckdb` | `"name"` | `limit n` | yes |
| `sqlite` | `"name"` | `limit n` | yes |
| `postgres` | `"name"` | `limit n` | no |
| `mysql` | `` `name` `` | `limit n` | no |
| `snowflake` | `"name"` | `limit n` | no |
| `bigquery` | `` `name` `` | `limit n` | no |

```ts
import { connectorFor } from '@agentix-e/nl2charts-node';

const mysql = connectorFor('mysql');
mysql.quote('order date');       // `order date`
mysql.limit('select 1', 100);    // select 1 limit 100
mysql.attach;                    // false
```

An engine that is not in this table is not treated as "probably standard SQL".
`connectorFor('oracle')` throws, because the alternative is discovering the
difference from a runtime syntax error on a customer's database.

## Read-only is a promise, not a setting

Every connector is read-only, and the check is lexical rather than trusting the
engine's user permissions:

```ts
import { requiresWrite, redactConnection, describeConnector } from '@agentix-e/nl2charts-node';

requiresWrite('insert into t values (1)');       // true
requiresWrite('  -- note\n select 1');            // false
redactConnection('postgres://analyst:s3cret@db/sales');
// postgres://analyst:***@db/sales
describeConnector('postgres', 'postgres://analyst:s3cret@db/sales');
// postgres (postgres://analyst:***@db/sales), read-only
```

Three reasons it is lexical:

1. a read-only *database user* is the right control, but it is not always granted;
2. a statement that starts with a comment must not hide an `insert` behind it;
3. the guard runs before the query leaves the process, so a rejected statement is
   never sent at all.

## Credentials

A password that reaches a log has leaked, and connection errors are the usual
path. `redactConnection` removes a password from the authority part and from the
common query parameters, and `describeConnector` is the only string this library
writes about a connection. Do not build your own message from the raw DSN.

## PostgreSQL: a real driver, two layers of read-only

```ts
import { createPostgresEngine } from '@agentix-e/nl2charts-node';

const engine = await createPostgresEngine({
  connectionString: process.env.DATABASE_URL as string,
  readOnly: true,          // default
  statementTimeoutMs: 30_000,
});

const result = await engine.run('select region, sum(total) from orders group by 1');
await engine.close();
```

Read-only is enforced twice, and both layers are covered by tests that run against
a real server:

1. **before sending**: `requiresWrite` rejects `insert`, `update`, `delete`,
   `create`, `alter`, `drop`, `truncate`, `merge`, `grant`, `revoke`, `copy`,
   `call`, `vacuum` — and also `select ... for update`, because it takes row locks;
2. **at the session level**: `default_transaction_read_only=on`, so a statement
   the lexical check cannot see is refused by the server. The test uses
   `select nextval('probe_seq')`, which contains no write keyword and still fails
   with *read-only transaction*.

Values are normalised to the same vocabulary as SQLite — dates as ISO text,
`boolean` as 1/0, `bytea` as `0x<hex>`, `int8`/`numeric` as numbers when they
survive the round trip and as strings when they would lose precision. Without that
the same logical row hashes differently per engine.

The integration suite is skipped unless `PG_TEST_URL` is set, so a laptop without
a database still runs the contract tests.

## MySQL and MariaDB: same two layers, one connection

```ts
import { createMysqlEngine } from '@agentix-e/nl2charts-node';

const engine = await createMysqlEngine({
  connectionString: process.env.DATABASE_URL as string,
  readOnly: true,
});
const result = await engine.run('select region, sum(total) from orders group by 1');
await engine.close();
```

The shape is the same as PostgreSQL — lexical guard before sending, then
`SET SESSION TRANSACTION READ ONLY` — with one implementation difference worth
knowing. The engine holds **one connection**, not a pool: a pool applies the
read-only setting to whichever physical connection served the call, so three of
four pooled sessions could stay writable. One connection makes the promise
unconditional; concurrent queries queue on it.

Two driver shapes are handled explicitly: `DECIMAL`/`BIGINT` arrive as strings
(the adapter converts them only when no precision is lost), and a write returns an
`OkPacket` rather than an array — the engine answers with an empty result set
instead of failing on a shape mismatch.

## What is not here yet

Snowflake and BigQuery have contracts but no drivers: shipping a driver without a
server to test it against would be a promise nobody checked. The honest statement
today is: `duckdb`, `sqlite`, `postgres` and `mysql` have real drivers and
integration tests (PostgreSQL 16 and MySQL 8 in CI services, MariaDB 10.11 in the
sandbox); the other two have tested promises only.
