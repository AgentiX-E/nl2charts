import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createSqliteEngine } from '@agentix-e/nl2charts-node';
import { createRunner } from '@agentix-e/nl2charts-core';
import type { SemanticModel } from '@agentix-e/nl2charts-core/semantic';
import { createMcpServer } from '../src/index.js';
import type { Runner } from '@agentix-e/nl2charts-core';

const MODEL: SemanticModel = {
  name: 'shop',
  tables: [
    {
      name: 'orders',
      columns: [
        { name: 'order_id', type: 'string' },
        { name: 'region', type: 'string' },
        { name: 'amount', type: 'number' },
        { name: 'customer_id', type: 'string' },
      ],
    },
    {
      name: 'customers',
      columns: [
        { name: 'customer_id', type: 'string' },
        { name: 'segment', type: 'string' },
      ],
    },
  ],
  relationships: [
    { from: 'orders', to: 'customers', on: { from: 'customer_id', to: 'customer_id' }, cardinality: 'many_to_one' },
  ],
  dimensions: [
    { name: 'region', table: 'orders', column: 'region', kind: 'categorical' },
    { name: 'segment', table: 'customers', column: 'segment', kind: 'categorical' },
  ],
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
    {
      name: 'orders',
      kind: 'simple',
      table: 'orders',
      aggregation: 'count',
      column: 'order_id',
      grain: ['order_id'],
      additivity: 'additive',
    },
  ],
};

let engine: Awaited<ReturnType<typeof createSqliteEngine>>;
let runner: Runner;
let directory: string;

beforeEach(async () => {
  // A file, not `:memory:`: the engine opens read-only by default, so the fixture
  // is seeded through a writable connection and then queried through the product's
  // default. Two in-memory databases would be two different databases.
  directory = mkdtempSync(join(tmpdir(), 'nl2charts-mcp-'));
  engine = await createSqliteEngine({ path: join(directory, 'fixture.db'), readOnly: false });
  await engine.run('create table customers (customer_id text, segment text)');
  await engine.run("insert into customers values ('c1', 'smb'), ('c2', 'ent')");
  await engine.run('create table orders (order_id text, region text, amount real, customer_id text)');
  await engine.run(
    "insert into orders values ('o1','north',10,'c1'), ('o2','north',20,'c2'), ('o3','south',5,'c1')",
  );
  runner = createRunner({ engine });
});

afterEach(async () => {
  await runner.close();
  rmSync(directory, { recursive: true, force: true });
});

function call(server: ReturnType<typeof createMcpServer>, name: string, args: Record<string, unknown>) {
  return server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

function textOf(response: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
  const result = response?.result as { content: { text: string }[] } | undefined;
  if (result === undefined) throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  return JSON.parse(result.content[0]?.text as string) as Record<string, unknown>;
}

describe('semantic tools', () => {
  it('runs a metric query against the real engine and returns its rows', async () => {
    const server = createMcpServer({ runner });
    const response = await call(server, 'query_metric', {
      model: MODEL,
      query: { metrics: ['revenue'], dimensions: ['region'] },
    });
    const payload = textOf(response);
    expect(String(payload.sql)).toContain('sum');
    expect(payload.rows).toEqual([
      { region: 'north', revenue: 30 },
      { region: 'south', revenue: 5 },
    ]);
    expect(payload.rowCount).toBe(2);
  });

  it('explains the same query without touching the engine', async () => {
    const server = createMcpServer({ runner });
    // A closed runner proves the explain path runs no SQL: if it tried, the call
    // would fail instead of returning a plan.
    const response = await call(server, 'explain_metric', {
      model: MODEL,
      query: { metrics: ['revenue'], dimensions: ['region'] },
    });
    const payload = textOf(response);
    expect(payload.stages).toEqual(['plan', 'optimize', 'lower', 'render']);
    expect(String(payload.sql).toLowerCase()).toContain('group by');
    // `plan` is the unoptimized tree (root + column list), `optimizedPlan` is the
    // root node after rewriting; both are returned so the difference is visible.
    expect((payload.plan as { root: { kind: string } }).root.kind).toBeTruthy();
    expect(payload.nodeCount).toBeGreaterThan(0);
  });

  it('reports the plan before and after optimization so a reader can see the change', async () => {
    const server = createMcpServer({ runner });
    const payload = textOf(
      await call(server, 'explain_metric', {
        model: MODEL,
        query: { metrics: ['revenue'], dimensions: ['region'] },
      }),
    );
    expect(payload.optimizedSql).toEqual(expect.any(String));
    expect(payload.plan).toBeTruthy();
    expect(payload.optimizedPlan).toBeTruthy();
    expect(payload.nodeCount).toBeGreaterThan(0);
  });

  it('rejects a call without a model instead of guessing one', async () => {
    const server = createMcpServer({ runner });
    const response = await call(server, 'query_metric', { query: { metrics: ['revenue'] } });
    expect(response?.error?.code).toBe(-32602);
    expect(String(response?.error?.message)).toContain('model');
  });

  it('surfaces a semantic error with its code rather than a 500', async () => {
    const server = createMcpServer({ runner });
    const response = await call(server, 'query_metric', { model: MODEL, query: { metrics: ['margin'] } });
    expect(response?.error?.code).toBe(-32000);
    expect(String(response?.error?.message)).toMatch(/NL2C_E_/);
  });

  it('clamps a requested limit to the runner row cap', async () => {
    const capped = createRunner({ engine, maxRows: 1 });
    const server = createMcpServer({ runner: capped });
    const payload = textOf(
      await call(server, 'query_metric', {
        model: MODEL,
        query: { metrics: ['revenue'], dimensions: ['region'], limit: 5000 },
      }),
    );
    expect(payload.rows).toHaveLength(1);
    expect(payload.truncated).toBe(true);
    await capped.close();
  });

  it('lists the semantic tools next to the SQL ones', async () => {
    const server = createMcpServer({ runner });
    const names = server.tools.map((tool) => tool.name);
    expect(names).toEqual(['run_sql', 'engine_info', 'query_metric', 'explain_metric']);
  });

  it('publishes a schema a client can validate against', async () => {
    const server = createMcpServer({ runner });
    for (const tool of server.tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.description.length, tool.name).toBeGreaterThan(10);
    }
    const metric = server.tools.find((tool) => tool.name === 'query_metric');
    expect(metric?.inputSchema.required).toEqual(['model', 'query']);
  });
});

describe('tool input validation', () => {
  it('accepts a model that omits relationships and dimensions', async () => {
    // A single-table model is the common case; requiring empty arrays for the
    // other two keys would make the smallest useful model the most verbose.
    const server = createMcpServer({ runner });
    const lean = {
      name: 'lean',
      tables: MODEL.tables.slice(0, 1),
      metrics: MODEL.metrics.slice(0, 1),
    };
    const payload = textOf(await call(server, 'query_metric', { model: lean, query: { metrics: ['revenue'] } }));
    expect(payload.rowCount).toBe(1);
  });

  it('rejects a model without metrics', async () => {
    const server = createMcpServer({ runner });
    const response = await call(server, 'query_metric', { model: { name: 'x', tables: [] }, query: { metrics: ['revenue'] } });
    expect(response?.error?.code).toBe(-32602);
    expect(String(response?.error?.message)).toContain('tables and metrics');
  });

  it('rejects a model that is not an object', async () => {
    const server = createMcpServer({ runner });
    const response = await call(server, 'query_metric', { model: 'shop', query: { metrics: ['revenue'] } });
    expect(response?.error?.code).toBe(-32602);
  });

  it('rejects a query that is not an object', async () => {
    const server = createMcpServer({ runner });
    const response = await call(server, 'query_metric', { model: MODEL, query: 'revenue by region' });
    expect(response?.error?.code).toBe(-32602);
    expect(String(response?.error?.message)).toContain('query');
  });

  it('rejects an empty metric list', async () => {
    const server = createMcpServer({ runner });
    const response = await call(server, 'query_metric', { model: MODEL, query: { metrics: [] } });
    expect(response?.error?.code).toBe(-32602);
    expect(String(response?.error?.message)).toContain('at least one metric');
  });

  it('carries the error details a client can branch on', async () => {
    const server = createMcpServer({ runner });
    const response = await call(server, 'query_metric', { model: MODEL, query: { metrics: ['margin'] } });
    expect(response?.error?.data).toBeTruthy();
  });

  it('validates explain_metric the same way as the executing tool', async () => {
    const server = createMcpServer({ runner });
    const badModel = await call(server, 'explain_metric', { model: 7, query: { metrics: ['revenue'] } });
    expect(badModel?.error?.code).toBe(-32602);
    const badQuery = await call(server, 'explain_metric', { model: MODEL, query: [] });
    expect(badQuery?.error?.code).toBe(-32602);
  });

  it('reports a compile error from explain_metric instead of throwing', async () => {
    const server = createMcpServer({ runner });
    const response = await call(server, 'explain_metric', { model: MODEL, query: { metrics: ['margin'] } });
    expect(response?.error?.code).toBe(-32000);
  });

  it('leaves the optimized plan out when the caller turns it off', async () => {
    const server = createMcpServer({ runner });
    const payload = textOf(
      await call(server, 'explain_metric', { model: MODEL, query: { metrics: ['revenue'] }, optimize: false }),
    );
    expect(payload.optimizedPlan).toBeUndefined();
    expect(payload.optimizedSql).toEqual(expect.any(String));
  });
});
