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

## What is not here yet

Live PostgreSQL and MySQL integration tests need servers, so the contract is
tested and the drivers are not shipped. Until they are, the honest statement is:
*the promises are verified, the wire protocol is not.* `duckdb` and `sqlite` are
the two engines with real, tested drivers.
