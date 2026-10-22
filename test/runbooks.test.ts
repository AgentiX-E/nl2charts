import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRunner } from '@agentix-e/nl2charts-core';
import type { SemanticModel } from '@agentix-e/nl2charts-core/semantic';
import { createSqliteEngine, createPostgresEngine, createMysqlEngine, describeConnector } from '@agentix-e/nl2charts-node';
import { createMcpServer } from '@agentix-e/nl2charts-mcp';
import { sealTrace, verifyTrace, replayTrace } from '@agentix-e/nl2charts-studio';

/**
 * Runbook drills.
 *
 * Each runbook in `docs/runbooks/` tells an operator what a failure looks like and
 * what to do about it. Prose that was never executed is a guess, so every drill
 * here reproduces the failure and asserts the signal the runbook promises: the
 * error code, the absence of a credential, and the fact that the system is still
 * usable afterwards.
 */

const ROOT = join(__dirname, '..');
const POSTGRES = process.env.PG_TEST_URL;
const MYSQL = process.env.MYSQL_TEST_URL;

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

describe('runbook: connection failure', () => {
  it('names the engine and hides the password, for every connector', async () => {
    for (const kind of ['postgres', 'mysql'] as const) {
      const describe = describeConnector(kind, `${kind}://analyst:s3cret@127.0.0.1:1/none`);
      expect(describe, kind).toContain('analyst:***@');
      expect(describe, kind).not.toContain('s3cret');
    }
  });

  it.skipIf(POSTGRES === undefined)('survives a refused PostgreSQL connection and reports it as an engine failure', async () => {
    const engine = await createPostgresEngine({ connectionString: 'postgres://analyst:s3cret@127.0.0.1:1/none' });
    const failure = await engine
      .run('select 1')
      .then(() => undefined)
      .catch((cause: unknown) => cause as Error & { code?: string });
    expect(failure?.code).toBe('NL2C_E_ENGINE_FAILED');
    expect(failure?.message).toMatch(/analyst:\*\*\*@/);
    expect(failure?.message).not.toContain('s3cret');
    await engine.close();
  });

  it.skipIf(MYSQL === undefined)('survives a refused MySQL connection the same way', async () => {
    const engine = await createMysqlEngine({ connectionString: 'mysql://analyst:s3cret@127.0.0.1:1/none' });
    const failure = await engine
      .run('select 1')
      .then(() => undefined)
      .catch((cause: unknown) => cause as Error & { code?: string });
    expect(failure?.code).toBe('NL2C_E_ENGINE_FAILED');
    expect(failure?.message).not.toContain('s3cret');
    await engine.close();
  });
});

describe('runbook: read-only rejection', () => {
  it('refuses a write before it leaves the process, and the data is unchanged', async () => {
    const engine = await createSqliteEngine({ path: ':memory:', readOnly: false });
    await engine.run('create table t (a integer)');
    await engine.run('insert into t values (1)');
    const runner = createRunner({ engine });
    await expect(runner.sql('delete from t')).rejects.toMatchObject({ code: 'NL2C_E_GUARD_REJECTED' });
    const after = await runner.sql('select count(*) as n from t');
    expect(after.rows[0]?.n).toBe(1);
    await runner.close();
  });
});

describe('runbook: semantic error', () => {
  it('carries the code and the candidates an operator needs', async () => {
    const engine = await createSqliteEngine({ path: ':memory:', readOnly: false });
    const runner = createRunner({ engine });
    const server = createMcpServer({ runner });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'query_metric', arguments: { model: MODEL, query: { metrics: ['margin'] } } },
    });
    expect(response?.error?.code).toBe(-32000);
    expect(String(response?.error?.message)).toContain('NL2C_E_');
    expect(response?.error?.data).toBeTruthy();
    await runner.close();
  });
});

describe('runbook: timeout', () => {
  it('aborts a query on the signal and reports a timeout code', async () => {
    const engine = await createSqliteEngine({ path: ':memory:', readOnly: false });
    const runner = createRunner({ engine });
    const controller = new AbortController();
    controller.abort();
    await expect(runner.sql('select 1', { signal: controller.signal })).rejects.toMatchObject({
      code: 'NL2C_E_TIMEOUT',
    });
    await runner.close();
  });
});

describe('runbook: trace verification failure', () => {
  it('tells an operator which event broke, and refuses to summarise it', () => {
    const sealed = sealTrace([
      { name: 'guard', startMs: 0, endMs: 1 },
      { name: 'execute', startMs: 1, endMs: 9 },
    ]);
    const edited = { ...sealed, events: sealed.events.map((event, index) => (index === 1 ? { ...event, endMs: 99 } : event)) };
    const verdict = verifyTrace(edited);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected a broken trace');
    expect(verdict.reason).toBe('hash');
    expect(verdict.brokenAt).toBe(1);
    expect(replayTrace(edited).stages).toEqual([]);
  });
});

describe('runbook: version rollback', () => {
  it('keeps every package on one version, so a rollback is a single decision', () => {
    const packages = readdirSync(join(ROOT, 'packages'))
      .map((name) => JSON.parse(readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
      })
      .map((manifest) => ({ name: manifest.name, version: manifest.version }));
    expect(packages).toHaveLength(8);
    const versions = new Set(packages.map((pkg) => pkg.version));
    expect([...versions]).toHaveLength(1);
    // Releasing `1.0.0` is a promise about the A1-A5 rules. A mixed workspace is
    // how that promise quietly stops being true.
    expect([...versions][0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('records the public surface of all eight packages, so a rollback is visible', () => {
    const surface = JSON.parse(readFileSync(join(ROOT, 'api-surface.json'), 'utf8')) as {
      packages?: Record<string, unknown>;
    };
    const recorded = surface.packages ?? (surface as unknown as Record<string, unknown>);
    const keys = Object.keys(recorded);
    // The snapshot also carries subpaths (`core/semantic`), so the check is that
    // every package is represented, not that the key count is eight.
    for (const name of ['spec', 'core', 'ai', 'node', 'chart', 'mcp', 'studio', 'devkit']) {
      expect(keys, name).toContain(name);
    }
  });
});
