import { describe, expect, it } from 'vitest';
import { createRunner } from '@agentix-e/nl2charts-core';
import type { SemanticModel } from '@agentix-e/nl2charts-core/semantic';
import { createMysqlEngine, createPostgresEngine, createSqliteEngine, describeConnector } from '@agentix-e/nl2charts-node';
import { createMcpServer } from '@agentix-e/nl2charts-mcp';

/**
 * Runtime leak audit.
 *
 * `gate:secrets` finds a credential that was committed. It cannot find one that is
 * echoed at run time — which is the more likely leak, because error paths are
 * written once and read by nobody until an incident. This enumerates the paths that
 * can surface a connection string and asserts a canary password never appears.
 */

const CANARY = 'canary-2f7a9c';
const POSTGRES = process.env.PG_TEST_URL;
const MYSQL = process.env.MYSQL_TEST_URL;

function messageOf(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message} ${JSON.stringify((error as { details?: unknown }).details ?? {})}`;
  return String(error);
}

const MODEL: SemanticModel = {
  name: 'shop',
  tables: [{ name: 'orders', columns: [{ name: 'order_id', type: 'string' }, { name: 'amount', type: 'number' }] }],
  relationships: [],
  dimensions: [],
  metrics: [
    {
      name: 'revenue',
      kind: 'simple',
      table: 'orders',
      aggregation: 'sum',
      column: 'amount',
      grain: ['order_id'],
      additivity: 'additive',
    },
  ],
};

describe('connection strings never reach a message', () => {
  it('redacts the authority part for every connector', () => {
    for (const kind of ['duckdb', 'sqlite', 'postgres', 'mysql', 'snowflake', 'bigquery'] as const) {
      const described = describeConnector(kind, `${kind}://analyst:${CANARY}@host:1/db?password=${CANARY}`);
      expect(described, kind).not.toContain(CANARY);
      expect(described, kind).toContain('***');
    }
  });

  it('keeps the password out of a PostgreSQL connection failure', async () => {
    const engine = await createPostgresEngine({ connectionString: `postgres://analyst:${CANARY}@127.0.0.1:1/none` });
    const message = await engine.run('select 1').catch(messageOf);
    expect(message).not.toContain(CANARY);
    expect(message).toContain('***@');
    await engine.close();
  });

  it('keeps the password out of a MySQL connection failure', async () => {
    const engine = await createMysqlEngine({ connectionString: `mysql://analyst:${CANARY}@127.0.0.1:1/none` });
    const message = await engine.run('select 1').catch(messageOf);
    expect(message).not.toContain(CANARY);
    await engine.close();
  });

  it('keeps the password out of an engine failure inside a runner', async () => {
    const engine = await createPostgresEngine({ connectionString: `postgres://analyst:${CANARY}@127.0.0.1:1/none` });
    const runner = createRunner({ engine });
    const message = await runner.sql('select 1').catch(messageOf);
    expect(message).not.toContain(CANARY);
    await runner.close();
  });

  it('keeps the password out of every MCP error, including the JSON encoding', async () => {
    const engine = await createPostgresEngine({ connectionString: `postgres://analyst:${CANARY}@127.0.0.1:1/none` });
    const runner = createRunner({ engine });
    const server = createMcpServer({ runner });

    const calls = [
      { name: 'run_sql', arguments: { sql: 'select 1' } },
      { name: 'query_metric', arguments: { model: MODEL, query: { metrics: ['revenue'] } } },
      { name: 'query_metric', arguments: { model: MODEL, query: { metrics: ['margin'] } } },
      { name: 'explain_metric', arguments: { model: MODEL, query: { metrics: ['revenue'] } } },
    ];
    for (const call of calls) {
      const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: call });
      const encoded = JSON.stringify(response);
      expect(encoded, call.name).not.toContain(CANARY);
    }
    await runner.close();
  });

  it.skipIf(POSTGRES === undefined)('keeps a real database password out of a query error', async () => {
    const engine = await createPostgresEngine({ connectionString: POSTGRES as string });
    const failure = await engine
      .run('select * from table_that_does_not_exist')
      .then(() => undefined)
      .catch((cause: unknown) => cause as Error & { code?: string });
    expect(failure?.code).toBe('NL2C_E_ENGINE_FAILED');
    // The password has to be checked in its URL position (`:pw@`), not as a bare
    // substring: CI's own password is `postgres`, which also names the engine, so
    // a substring check would pass or fail for the wrong reason.
    const password = /:\/\/([^:]+):([^@]+)@/.exec(POSTGRES as string)?.[2];
    if (password !== undefined) expect(failure?.message).not.toContain(`:${password}@`);
    expect(failure?.message).not.toContain(POSTGRES as string);
    await engine.close();
  });

  it.skipIf(MYSQL === undefined)('keeps a real database password out of a query error', async () => {
    const engine = await createMysqlEngine({ connectionString: MYSQL as string });
    const failure = await engine
      .run('select * from table_that_does_not_exist')
      .then(() => undefined)
      .catch((cause: unknown) => cause as Error & { code?: string });
    expect(failure?.code).toBe('NL2C_E_ENGINE_FAILED');
    const password = /:\/\/([^:]+):([^@]+)@/.exec(MYSQL as string)?.[2];
    if (password !== undefined) expect(failure?.message).not.toContain(`:${password}@`);
    expect(failure?.message).not.toContain(MYSQL as string);
    await engine.close();
  });

  it('redacts a password that also happens to be the engine name', async () => {
    // CI caught this: `postgres://postgres:postgres@…` makes a substring check
    // meaningless, so the assertion is about the URL position instead.
    const engine = await createPostgresEngine({ connectionString: 'postgres://postgres:postgres@127.0.0.1:1/none' });
    const failure = await engine
      .run('select 1')
      .then(() => undefined)
      .catch((cause: unknown) => cause as Error);
    expect(failure?.message).toContain('***@');
    expect(failure?.message).not.toContain(':postgres@');
    await engine.close();
  });

  it('does not put the whole model into a semantic error', async () => {
    // A model can carry a data-source string. An error that echoed the input would
    // leak it into a log, so the check is on the details, not the message.
    const engine = await createSqliteEngine({ path: ':memory:', readOnly: false });
    const runner = createRunner({ engine });
    const server = createMcpServer({ runner });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'query_metric', arguments: { model: MODEL, query: { metrics: ['margin'] } } },
    });
    const details = JSON.stringify(response?.error?.data ?? {});
    expect(details).not.toContain('select');
    expect(details.length).toBeLessThan(600);
    await runner.close();
  });
});

describe('sensitive values are not fabricated', () => {
  it('the canary is absent from a successful call too', async () => {
    // A leak is not limited to failures: a debug field or an echoed input would
    // show up in a 200 as well.
    const engine = await createSqliteEngine({ path: ':memory:', readOnly: false });
    await engine.run('create table orders (order_id text, amount real)');
    await engine.run("insert into orders values ('o1', 5)");
    const runner = createRunner({ engine });
    const server = createMcpServer({ runner });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'query_metric', arguments: { model: MODEL, query: { metrics: ['revenue'] } } },
    });
    expect(JSON.stringify(response)).not.toContain(CANARY);
    await runner.close();
  });
});
