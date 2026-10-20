import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { createOracle } from '../eval/bird/oracle.js';

// A real Python process, a real SQLite file, no mocks: the protocol is the
// contract, and the only way to know it holds is to speak it.
const root = mkdtempSync(join(tmpdir(), 'nl2charts-oracle-'));
mkdirSync(join(root, 'shop'), { recursive: true });
const writer = new DatabaseSync(join(root, 'shop', 'shop.sqlite'));
writer.exec(`
  create table items (id integer, name text, price real, blob_col blob);
  insert into items values (1, 'pen', 1.5, x'0a0b');
  insert into items values (2, 'cup', 3.25, null);
  insert into items values (3, 'pen', 1.5, null);
`);
writer.close();

const oracle = createOracle(resolve('eval/bird/oracle.py'), root);
afterAll(async () => {
  await oracle.close();
  rmSync(root, { recursive: true, force: true });
});

describe('SQLite execution oracle', () => {
  it('returns ordered tuples, not named rows', async () => {
    const result = await oracle.run('shop', 'select price, name from items order by id');
    expect(result.ok).toBe(true);
    expect(result.columns).toEqual(['price', 'name']);
    expect(result.rows).toEqual([
      [1.5, 'pen'],
      [3.25, 'cup'],
      [1.5, 'pen'],
    ]);
  });

  it('preserves duplicate rows and duplicate column names', async () => {
    const rows = await oracle.run('shop', 'select 1 as a, 2 as a');
    expect(rows.rows).toEqual([[1, 2]]);
    const duplicates = await oracle.run('shop', 'select name from items where name = \'pen\'');
    expect(duplicates.rows).toHaveLength(2);
  });

  it('encodes a blob so the row survives JSON', async () => {
    const [row] = (await oracle.run('shop', 'select blob_col from items where id = 1')).rows;
    expect(row?.[0]).toEqual({ $b64: 'Cgs=' });
  });

  it('reports a SQL error as data instead of crashing the process', async () => {
    const result = await oracle.run('shop', 'select missing from items');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no such column');
  });

  it('reports a missing database as an error, not a hang', async () => {
    const result = await oracle.run('absent', 'select 1');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('database not found');
  });

  it('keeps a database usable after a failed statement', async () => {
    expect((await oracle.run('shop', 'select from')).ok).toBe(false);
    expect((await oracle.run('shop', 'select count(*) from items')).rows).toEqual([[3]]);
  });

  it('runs concurrent requests and matches each response to its request', async () => {
    const results = await Promise.all([
      oracle.run('shop', 'select 1'),
      oracle.run('shop', 'select 2'),
      oracle.run('shop', 'select 3'),
      oracle.run('shop', 'select 4'),
    ]);
    expect(results.map((result) => result.rows[0]?.[0])).toEqual([1, 2, 3, 4]);
  });
});
