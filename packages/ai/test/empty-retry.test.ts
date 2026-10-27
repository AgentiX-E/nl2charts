import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/pipeline.js';
import { createReplayProvider } from '../src/replay.js';
import { buildEmptyResultFeedback, EMPTY_BLIND_MESSAGE } from '../src/empty.js';
import type { LlmProvider, LlmRequest } from '../src/provider.js';
import type { SchemaTable } from '../src/linking.js';

const schema: SchemaTable[] = [
  {
    name: 'orders',
    columns: [
      { name: 'id', type: 'INTEGER' },
      { name: 'region', type: 'TEXT' },
      { name: 'revenue', type: 'REAL' },
    ],
  },
] as unknown as SchemaTable[];

/** A provider that answers in sequence and keeps every request it saw. */
function scripted(statements: readonly string[]): { provider: LlmProvider; seen: LlmRequest[] } {
  const seen: LlmRequest[] = [];
  let index = 0;
  return {
    seen,
    provider: {
      id: 'scripted',
      model: 'scripted',
      async complete(request: LlmRequest) {
        seen.push(request);
        const text = statements[Math.min(index, statements.length - 1)] as string;
        index += 1;
        return { text, model: 'scripted' };
      },
    },
  };
}

describe('empty-result feedback', () => {
  it('names the statement and the three ways a query returns nothing', () => {
    const feedback = buildEmptyResultFeedback('SELECT * FROM orders WHERE region = "EMEA"');
    expect(feedback).toContain('SELECT * FROM orders WHERE region = "EMEA"');
    expect(feedback).toMatch(/literal/i);
    expect(feedback).toMatch(/join/i);
    expect(feedback).toMatch(/condition/i);
  });

  it('stays inside the feedback budget the repair turns use', () => {
    const feedback = buildEmptyResultFeedback('SELECT 1');
    expect(feedback.length).toBeLessThan(900);
  });

  it('is deterministic, so two runs on one case see the same bytes', () => {
    expect(buildEmptyResultFeedback('SELECT 1')).toBe(buildEmptyResultFeedback('SELECT 1'));
  });

  it('clips a long statement instead of spending the feedback budget on it', () => {
    const long = `SELECT ${'a_very_long_column_name, '.repeat(60)}1 FROM orders`;
    const feedback = buildEmptyResultFeedback(long);
    expect(feedback).toContain('…');
    expect(feedback).not.toContain('a_very_long_column_name, '.repeat(40).trim());
    expect(feedback.length).toBeLessThan(900);
  });

  it('says nothing about emptiness in the blind control', () => {
    expect(EMPTY_BLIND_MESSAGE).not.toMatch(/empty|no rows|nothing|zero/i);
  });
});

describe('one more turn after a statement returns no rows', () => {
  it('spends one extra call and returns the statement that returned rows', async () => {
    const { provider, seen } = scripted(['SELECT region FROM orders WHERE region = "EMEA"', 'SELECT region FROM orders']);
    const pipeline = createPipeline({
      provider,
      emptyRetry: 'diagnosed',
      execute: async (sql) => ({ rows: sql.includes('WHERE') ? 0 : 3 }),
    });
    const result = await pipeline.ask({ question: 'list the regions', schema });
    expect(result.sql).toBe('SELECT region FROM orders');
    expect(result.attempts).toBe(2);
    expect(seen).toHaveLength(2);
    expect(result.emptyRetry?.fired).toBe(true);
  });

  it('tells the second turn what the first one returned', async () => {
    const { provider, seen } = scripted(['SELECT region FROM orders WHERE region = "EMEA"', 'SELECT region FROM orders']);
    const pipeline = createPipeline({
      provider,
      emptyRetry: 'diagnosed',
      execute: async (sql) => ({ rows: sql.includes('WHERE') ? 0 : 3 }),
    });
    await pipeline.ask({ question: 'list the regions', schema });
    const retry = seen[1] as LlmRequest;
    const transcript = retry.messages.map((message) => message.content).join('\n');
    expect(transcript).toContain('returned no rows');
    expect(transcript).toContain('WHERE region = "EMEA"');
  });

  it('keeps the blind control free of the diagnosis it is the control for', async () => {
    const { provider, seen } = scripted(['SELECT region FROM orders WHERE region = "EMEA"', 'SELECT region FROM orders']);
    const pipeline = createPipeline({
      provider,
      emptyRetry: 'blind',
      execute: async (sql) => ({ rows: sql.includes('WHERE') ? 0 : 3 }),
    });
    await pipeline.ask({ question: 'list the regions', schema });
    const retry = seen[1] as LlmRequest;
    const transcript = retry.messages.map((message) => message.content).join('\n');
    expect(transcript).toContain(EMPTY_BLIND_MESSAGE);
    expect(transcript).not.toContain('returned no rows');
  });

  it('does not spend a call when the statement returned rows', async () => {
    const { provider, seen } = scripted(['SELECT region FROM orders']);
    const pipeline = createPipeline({ provider, emptyRetry: 'diagnosed', execute: async () => ({ rows: 2 }) });
    const result = await pipeline.ask({ question: 'list the regions', schema });
    expect(seen).toHaveLength(1);
    expect(result.attempts).toBe(1);
    expect(result.emptyRetry).toBeUndefined();
  });

  it('retries once and not twice, even when the second statement is also empty', async () => {
    const { provider, seen } = scripted(['SELECT region FROM orders WHERE region = "EMEA"', 'SELECT region FROM orders WHERE region = "APAC"']);
    const pipeline = createPipeline({ provider, emptyRetry: 'diagnosed', execute: async () => ({ rows: 0 }) });
    const result = await pipeline.ask({ question: 'list the regions', schema });
    expect(seen).toHaveLength(2);
    expect(result.sql).toContain('APAC');
    expect(result.emptyRetry?.recovered).toBe(false);
  });

  it('does nothing when the engine hook reports no row count at all', async () => {
    const { provider, seen } = scripted(['SELECT region FROM orders']);
    const pipeline = createPipeline({ provider, emptyRetry: 'diagnosed', execute: async () => undefined });
    const result = await pipeline.ask({ question: 'list the regions', schema });
    expect(seen).toHaveLength(1);
    expect(result.emptyRetry).toBeUndefined();
  });

  it('is not a repair: it fires with no repair budget left', async () => {
    const { provider, seen } = scripted(['SELECT region FROM orders WHERE region = "EMEA"', 'SELECT region FROM orders']);
    const pipeline = createPipeline({
      provider,
      maxRepairs: 0,
      emptyRetry: 'diagnosed',
      execute: async (sql) => ({ rows: sql.includes('WHERE') ? 0 : 3 }),
    });
    const result = await pipeline.ask({ question: 'list the regions', schema });
    expect(seen).toHaveLength(2);
    expect(result.sql).toBe('SELECT region FROM orders');
  });

  it('discards a retry the guard refuses, rather than executing it', async () => {
    const { provider } = scripted(['SELECT region FROM orders WHERE region = "EMEA"', 'DROP TABLE orders']);
    let executed: string[] = [];
    const pipeline = createPipeline({
      provider,
      emptyRetry: 'diagnosed',
      execute: async (sql) => {
        executed = [...executed, sql];
        return { rows: 0 };
      },
    });
    const result = await pipeline.ask({ question: 'list the regions', schema });
    expect(executed).toEqual(['SELECT region FROM orders WHERE region = "EMEA"']);
    expect(result.sql).toBe('SELECT region FROM orders WHERE region = "EMEA"');
    expect(result.emptyRetry).toEqual({ fired: true, recovered: false });
  });

  it('keeps the first statement when the second one does not run', async () => {
    const { provider } = scripted(['SELECT region FROM orders WHERE region = "EMEA"', 'SELECT region FROM missing']);
    const pipeline = createPipeline({
      provider,
      emptyRetry: 'diagnosed',
      execute: async (sql) => {
        if (sql.includes('missing')) throw new Error('no such table: missing');
        return { rows: 0 };
      },
    });
    const result = await pipeline.ask({ question: 'list the regions', schema });
    expect(result.sql).toBe('SELECT region FROM orders WHERE region = "EMEA"');
    expect(result.emptyRetry?.recovered).toBe(false);
  });

  it('reports the retry on an arm that also repairs, without charging it to the repair budget', async () => {
    const provider = createReplayProvider([
      { match: 'returned no rows', response: 'SELECT region FROM orders' },
      { match: 'revenue by region', response: 'SELECT region FROM orders WHERE region = "EMEA"' },
    ]);
    const pipeline = createPipeline({
      provider,
      maxRepairs: 3,
      emptyRetry: 'diagnosed',
      execute: async (sql) => ({ rows: sql.includes('WHERE') ? 0 : 2 }),
    });
    const result = await pipeline.ask({ question: 'revenue by region', schema });
    expect(result.attempts).toBe(2);
    expect(result.failures).toHaveLength(0);
    expect(result.emptyRetry).toEqual({ fired: true, recovered: true });
  });
});
