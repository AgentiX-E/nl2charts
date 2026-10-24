import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';
import { createSqliteEngine } from '../src/sqlite.js';

// A real SQLite file, written once with the same driver the adapter reads with.
// No mocks: the point of this file is that the adapter talks to a database.
const directory = mkdtempSync(join(tmpdir(), 'nl2charts-sqlite-'));
const file = join(directory, 'fixture.sqlite');
const writer = new DatabaseSync(file);
writer.exec(`
  create table orders (id integer primary key, region text, amount real, note blob);
  insert into orders values (1, 'north', 10.5, x'00ff');
  insert into orders values (2, 'south', null, null);
  insert into orders values (3, 'north', 4.25, null);
`);
writer.close();

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

const rows = async (sql: string): Promise<readonly Readonly<Record<string, unknown>>[]> => {
  const engine = await createSqliteEngine({ path: file });
  try {
    return (await engine.run(sql)).rows;
  } finally {
    await engine.close();
  }
};

describe('SQLite engine', () => {
  it('reports its identity and dialect', async () => {
    const engine = await createSqliteEngine({ path: file });
    expect(engine.id).toBe('sqlite');
    expect(engine.dialect).toBe('sqlite');
    expect(engine.streaming).toBe(false);
    await engine.close();
  });

  it('keeps column order and values', async () => {
    const engine = await createSqliteEngine({ path: file });
    const result = await engine.run('select amount, region, id from orders order by id');
    expect(result.columns).toEqual(['amount', 'region', 'id']);
    expect(result.rows).toEqual([
      { amount: 10.5, region: 'north', id: 1 },
      { amount: null, region: 'south', id: 2 },
      { amount: 4.25, region: 'north', id: 3 },
    ]);
    await engine.close();
  });

  it('reports no columns for an empty result on this runtime', async () => {
    // Columns come from the first row; an empty result has none to read. A
    // documented limitation, not a silent one.
    expect(await rows('select amount from orders where amount < 0')).toEqual([]);
  });

  it('collapses duplicated output column names on this runtime', async () => {
    // node:sqlite before 23 exposes no setReturnArrays()/columns(), so rows are
    // objects and the earlier duplicate is lost. Recorded as a limitation of the
    // adapter rather than hidden: external benchmarks execute through the
    // reference driver in eval/bird/oracle.py, which returns tuples.
    expect(await rows('select 1 as a, 2 as a')).toEqual([{ a: 2 }]);
  });

  it('maps blobs to the same 0x-hex encoding the DuckDB adapter uses', async () => {
    const [row] = await rows('select note from orders where id = 1');
    expect(row?.note).toBe('0x00ff');
  });

  it('refuses writes on a read-only file', async () => {
    const engine = await createSqliteEngine({ path: file });
    await expect(engine.run('delete from orders')).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_ENGINE_FAILED',
    );
    await engine.close();
  });

  it('reports a missing database as unavailable', async () => {
    await expect(createSqliteEngine({ path: join(directory, 'absent.sqlite') })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_ENGINE_UNAVAILABLE',
    );
  });

  it('refuses to run after close and before an abort', async () => {
    const engine = await createSqliteEngine({ path: file });
    const controller = new AbortController();
    controller.abort();
    await expect(engine.run('select 1', { signal: controller.signal })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_TIMEOUT',
    );
    await engine.close();
    await expect(engine.run('select 1')).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_ENGINE_UNAVAILABLE',
    );
    await engine.close();
  });

  it('reports a syntax error with the engine named', async () => {
    const engine = await createSqliteEngine({ path: file });
    await expect(engine.run('select from')).rejects.toSatisfy(
      (error: unknown) =>
        isNl2ChartsError(error) && error.code === 'NL2C_E_ENGINE_FAILED' && error.details.engine === 'sqlite',
    );
    await engine.close();
  });

  it('keeps the driver message, so a repair has something to act on', async () => {
    const engine = await createSqliteEngine({ path: file });
    const error = await engine.run('select regionn from orders').catch((reason: unknown) => reason);
    await engine.close();
    expect(isNl2ChartsError(error)).toBe(true);
    const captured = error as { message: string; details: { engineError?: { message: string; code?: string } } };
    // The message used to be the constant "sqlite query failed", which made every
    // failure identical and left the repair loop with nothing to say.
    expect(captured.message).toContain('no such column');
    expect(captured.details.engineError?.message).toContain('no such column: regionn');
    expect(captured.details.engineError?.code).toBeDefined();
  });

  it('opens in memory when asked', async () => {
    const engine = await createSqliteEngine({ path: ':memory:' });
    expect((await engine.run('select 1 + 1 as two')).rows).toEqual([{ two: 2 }]);
    await engine.close();
  });
});
