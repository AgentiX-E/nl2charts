import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDuckDbEngine } from '../src/duckdb.js';
import { fromDuckDbRow, fromDuckDbValue } from '../src/values.js';

describe('driver value mapping', () => {
  it('maps every DuckDB wrapper type it can produce', async () => {
    const engine = await createDuckDbEngine();
    try {
      const result = await engine.run(
        `select DATE '2026-10-20' d,
                TIMESTAMP '2026-10-20 12:34:56.789' ts,
                TIMESTAMPTZ '2026-10-20 12:34:56+00' tstz,
                TIME '12:34:56.789' t,
                INTERVAL 1 DAY iv,
                [1, 2] arr,
                {'a': 1} st,
                '00000000-0000-0000-0000-000000000001'::UUID u`,
      );
      const row = result.rows[0] ?? {};
      expect(row.d).toBe('2026-10-20');
      expect(row.ts).toBe('2026-10-20T12:34:56.789Z');
      expect(row.tstz).toBe('2026-10-20T12:34:56.000Z');
      expect(row.t).toBe('12:34:56.789');
      expect(row.iv).toBe('0 months 1 days 0 microseconds');
      expect(row.arr).toEqual([1, 2]);
      expect(row.st).toEqual({ a: 1 });
      expect(row.u).toBe('00000000-0000-0000-0000-000000000001');
    } finally {
      await engine.close();
    }
  });

  it('passes through primitives, dates and byte arrays', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(fromDuckDbValue(1)).toBe(1);
    expect(fromDuckDbValue(null)).toBeNull();
    expect(fromDuckDbValue('x')).toBe('x');
    expect(fromDuckDbValue(date)).toBe(date);
    expect(fromDuckDbValue(new Uint8Array([1]))).toEqual(new Uint8Array([1]));
  });

  it('maps a bare {days} object and leaves unknown objects untouched', () => {
    expect(fromDuckDbValue({ days: 0 })).toBe('1970-01-01');
    expect(fromDuckDbValue({ days: -1 })).toBe('1969-12-31');
    const unknown = { something: 1 };
    expect(fromDuckDbValue(unknown)).toBe(unknown);
  });

  it('defaults a sparse interval to zeros and tolerates a null prototype', () => {
    const SparseInterval = class DuckDBIntervalValue {
      readonly months?: number;
      readonly days?: number;
      readonly micros?: bigint;
    };
    expect(fromDuckDbValue(new SparseInterval())).toBe('0 months 0 days 0 microseconds');
    const bare = Object.create(null) as Record<string, unknown>;
    bare.days = 1;
    expect(fromDuckDbValue(bare)).toBe('1970-01-02');
  });

  it('maps a whole row', () => {
    expect(fromDuckDbRow({ a: { days: 0 }, b: 2 })).toEqual({ a: '1970-01-01', b: 2 });
  });

  it('formats negative hugeints as unsigned 128-bit hex', () => {
    const uuid = fromDuckDbValue({ hugeint: -1n }) as string;
    expect(uuid).toBe('7fffffff-ffff-ffff-ffff-ffffffffffff');
  });
});

describe('read-only engine', () => {
  it('opens a file database read-only and refuses writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nl2c-ro-'));
    const path = join(dir, 'data.duckdb');
    const writer = await createDuckDbEngine({ path });
    await writer.run('create table t as select 1 as a');
    await writer.close();

    const reader = await createDuckDbEngine({ path, readOnly: true });
    try {
      const result = await reader.run('select * from t');
      expect(result.rows).toEqual([{ a: 1 }]);
      await expect(reader.run('insert into t values (2)')).rejects.toThrow(/duckdb query failed/);
    } finally {
      await reader.close();
      await unlink(path);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
