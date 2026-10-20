import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRunner } from '@agentix-e/nl2charts-core';
import type { Engine } from '@agentix-e/nl2charts-core';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { SpanEvent } from '@agentix-e/nl2charts-spec';
import { createDuckDbEngine } from '../src/duckdb.js';

let engine: Engine;

beforeAll(async () => {
  engine = await createDuckDbEngine();
});

afterAll(async () => {
  await engine.close();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('duckdb engine', () => {
  it('returns real columns, rows and native value types', async () => {
    const result = await engine.run(
      "select 1 as a, 'x' as b, 9223372036854775807::BIGINT as big, 1.5::DECIMAL(10,2) as dec, DATE '2026-10-20' as d",
    );
    expect(result.columns).toEqual(['a', 'b', 'big', 'dec', 'd']);
    const row = result.rows[0] ?? {};
    expect(row.a).toBe(1);
    expect(row.b).toBe('x');
    expect(row.big).toBe(9223372036854775807n);
    expect(row.dec).toEqual({ width: 10, scale: 2, value: 150n });
  });

  it('wraps a driver error into the contract error type', async () => {
    await expect(engine.run('select * from does_not_exist')).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_ENGINE_FAILED',
    );
  });

  it('refuses a pre-aborted call', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(engine.run('select 1', { signal: controller.signal })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_TIMEOUT',
    );
  });

  it('refuses to run after close and tolerates a second close', async () => {
    const local = await createDuckDbEngine();
    await local.close();
    await local.close();
    await expect(local.run('select 1')).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_ENGINE_UNAVAILABLE',
    );
  });
});

describe('runner against real DuckDB', () => {
  it('normalizes values and stamps provenance', async () => {
    const runner = createRunner({ engine });
    const result = await runner.sql(
      "select 1 as a, 1.50::DECIMAL(10,2) as dec, DATE '2026-10-20' as d, 9223372036854775807::BIGINT as big",
    );
    expect(result.columns).toEqual(['a', 'dec', 'd', 'big']);
    expect(result.rows[0]).toEqual({ a: 1, big: '9223372036854775807', d: '2026-10-20', dec: '1.50' });
    expect(result.provenance).toEqual({ path: 'sql', chart: false });
    expect(result.rowCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.sql).toBe(
      "select 1 as a, 1.50::DECIMAL(10,2) as dec, DATE '2026-10-20' as d, 9223372036854775807::BIGINT as big LIMIT 10001",
    );
  });

  it('marks model-authored queries in provenance', async () => {
    const runner = createRunner({ engine });
    const result = await runner.sql('select 1 as a', { chart: true });
    expect(result.provenance).toEqual({ path: 'nl', chart: true });
  });

  it('truncates at maxRows + 1 and reports it', async () => {
    const runner = createRunner({ engine, maxRows: 2 });
    const result = await runner.sql('select * from range(10) t(i)');
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.rowCount).toBe(2);
  });

  it('accepts a per-call limit that overrides the runner default', async () => {
    const runner = createRunner({ engine, maxRows: 100 });
    const result = await runner.sql('select * from range(10) t(i)', { limit: 4 });
    expect(result.rows).toHaveLength(4);
    expect(result.truncated).toBe(true);
    const all = await runner.sql('select * from range(10) t(i)', { limit: 10 });
    expect(all.rows).toHaveLength(10);
    expect(all.truncated).toBe(false);
  });

  it('keeps an explicit limit and does not double-cap', async () => {
    const runner = createRunner({ engine, maxRows: 100 });
    const result = await runner.sql('select * from range(10) t(i) limit 3');
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(false);
    expect(result.sql).toBe('select * from range(10) t(i) limit 3');
  });

  it('rejects a non-select statement before it reaches the engine', async () => {
    const runner = createRunner({ engine });
    await expect(runner.sql('drop table t')).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_GUARD_REJECTED',
    );
  });

  it('surfaces engine failures with the engine id attached', async () => {
    const runner = createRunner({ engine });
    await expect(runner.sql('select * from nope')).rejects.toSatisfy(
      (error: unknown) =>
        isNl2ChartsError(error) &&
        error.code === 'NL2C_E_ENGINE_FAILED' &&
        error.details.engine === 'duckdb-native',
    );
  });

  it('emits an ok span with row counts', async () => {
    const spans: SpanEvent[] = [];
    const runner = createRunner({ engine, onSpan: (span) => spans.push(span) });
    await runner.sql('select * from range(3) t(i)');
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: 'execute',
      status: 'ok',
      spanId: 'span-execute',
      attrs: { 'nl2charts.rows': 3, 'nl2charts.truncated': false, 'nl2charts.path': 'sql' },
    });
    expect(spans[0]?.traceId).toMatch(/^trace-[0-9a-f]{6}$/);
    expect(spans[0]?.endMs).toBeGreaterThanOrEqual(spans[0]?.startMs ?? 0);
  });

  it('survives a throwing span hook and still returns rows', async () => {
    const runner = createRunner({
      engine,
      onSpan: () => {
        throw new Error('collector down');
      },
    });
    const result = await runner.sql('select 1 as a');
    expect(result.rows).toEqual([{ a: 1 }]);
  });

  it('reports the declared capabilities', () => {
    const runner = createRunner({ engine, maxRows: 7 });
    expect(runner.capabilities).toEqual({
      engine: 'duckdb-native',
      dialect: 'duckdb',
      streaming: false,
      maxRows: 7,
    });
  });
});

describe('runner timeouts and cancellation', () => {
  const slowEngine = async (): Promise<Engine> => {
    const base = await createDuckDbEngine();
    return {
      id: 'duckdb-delayed',
      dialect: 'duckdb',
      streaming: false,
      async run(sql, options) {
        await delay(80);
        return base.run(sql, options);
      },
      close: () => base.close(),
    };
  };

  it('times out even when the engine ignores the signal', async () => {
    const slow = await slowEngine();
    const spans: SpanEvent[] = [];
    const runner = createRunner({ engine: slow, timeoutMs: 10, onSpan: (span) => spans.push(span) });
    const startedAt = Date.now();
    await expect(runner.sql('select 1 as a')).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_TIMEOUT',
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(spans[0]?.status).toBe('error');
    await delay(120);
    await runner.close();
  });

  it('honours an already-aborted caller signal', async () => {
    const runner = createRunner({ engine, timeoutMs: 5_000 });
    const controller = new AbortController();
    controller.abort();
    await expect(runner.sql('select 1', { signal: controller.signal })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_TIMEOUT',
    );
  });

  it('honours a caller abort that arrives mid-flight', async () => {
    const slow = await slowEngine();
    const runner = createRunner({ engine: slow, timeoutMs: 5_000 });
    const controller = new AbortController();
    const pending = runner.sql('select 1 as a', { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_TIMEOUT',
    );
    await delay(120);
    await runner.close();
  });
});

describe('runner streaming', () => {
  const streamingEngine = async (): Promise<Engine> => {
    const base = await createDuckDbEngine();
    return {
      id: 'duckdb-stream',
      dialect: 'duckdb',
      streaming: true,
      run: (sql, options) => base.run(sql, options),
      async *stream(sql, options) {
        const result = await base.run(sql, options);
        for (let index = 0; index < result.rows.length; index += 2) {
          yield { columns: result.columns, rows: result.rows.slice(index, index + 2) };
        }
      },
      close: () => base.close(),
    };
  };

  it('falls back to one batch when the engine cannot stream', async () => {
    const runner = createRunner({ engine });
    const batches: unknown[] = [];
    for await (const batch of runner.stream('select * from range(3) t(i)')) batches.push(batch);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });

  it('yields multiple batches and stops at the limit', async () => {
    const streaming = await streamingEngine();
    const runner = createRunner({ engine: streaming, maxRows: 100 });
    const batches: unknown[][] = [];
    for await (const batch of runner.stream('select * from range(10) t(i)', { limit: 3 })) batches.push([...batch]);
    expect(batches).toEqual([[{ i: 0 }, { i: 1 }], [{ i: 2 }]]);
    await runner.close();
  });

  it('does not yield empty batches', async () => {
    const streaming = await streamingEngine();
    const runner = createRunner({ engine: streaming });
    const batches: unknown[] = [];
    for await (const batch of runner.stream('select * from range(0) t(i)')) batches.push(batch);
    expect(batches).toEqual([]);
    await runner.close();
  });

  it('applies the guard to the stream path too', async () => {
    const runner = createRunner({ engine });
    const iterate = async (): Promise<void> => {
      for await (const _batch of runner.stream('delete from t')) void _batch;
    };
    await expect(iterate()).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_GUARD_REJECTED',
    );
  });
});
