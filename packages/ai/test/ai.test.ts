import { describe, expect, it } from 'vitest';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';
import { createPipeline, extractSql } from '../src/pipeline.js';
import { linkSchema, renderSchemaCard, tokenizeQuestion } from '../src/linking.js';
import type { SchemaTable } from '../src/linking.js';
import { createReplayProvider, recordProvider } from '../src/replay.js';
import type { LlmProvider } from '../src/provider.js';
import type { RecordedCall } from '../src/replay.js';

const schema: SchemaTable[] = [
  {
    table: 'orders',
    columns: [
      { name: 'order_id', type: 'BIGINT' },
      { name: 'region', type: 'VARCHAR', samples: ['north', 'south'], aliases: ['area', 'territory'] },
      { name: 'revenue', type: 'DECIMAL', aliases: ['sales', 'amount'] },
      { name: 'order_date', type: 'DATE' },
    ],
  },
  { table: 'customers', columns: [{ name: 'customer_id', type: 'BIGINT' }, { name: 'segment', type: 'VARCHAR' }] },
];

describe('question tokenization', () => {
  it('drops stopwords and splits snake and camel case', () => {
    expect(tokenizeQuestion('Show the revenue by order_date for North')).toEqual(['revenue', 'order', 'date', 'north']);
    expect(tokenizeQuestion('orderId by customerSegment')).toEqual(['order', 'id', 'customer', 'segment']);
  });

  it('returns nothing for a pure stopword question', () => {
    expect(tokenizeQuestion('what is the')).toEqual([]);
  });
});

describe('schema linking', () => {
  it('ranks the measure and the dimension first', () => {
    const linked = linkSchema('revenue by region', schema);
    expect(linked.slice(0, 2).map((column) => column.column).sort()).toEqual(['region', 'revenue']);
  });

  it('uses aliases as a second recaller', () => {
    const linked = linkSchema('sales by territory', schema);
    const aliased = linked.filter((column) => column.recalledBy.includes('alias')).map((column) => column.column);
    expect(aliased.sort()).toEqual(['region', 'revenue']);
  });

  it('uses sample values as a third recaller', () => {
    const linked = linkSchema('north', schema);
    expect(linked[0]).toMatchObject({ table: 'orders', column: 'region', recalledBy: ['value'] });
  });

  it('scores a column matched by two recallers above one matched by one', () => {
    const linked = linkSchema('revenue sales', schema);
    const revenue = linked.find((column) => column.column === 'revenue');
    expect([...(revenue?.recalledBy ?? [])].sort()).toEqual(['alias', 'name']);
  });

  it('returns nothing when no token matches or the question is empty', () => {
    expect(linkSchema('unrelated words entirely', schema)).toEqual([]);
    expect(linkSchema('', schema)).toEqual([]);
    expect(linkSchema('what is the', schema)).toEqual([]);
  });

  it('honours the top-k limit', () => {
    expect(linkSchema('revenue by region', schema, 1)).toHaveLength(1);
  });

  it('renders a schema card with an optional line limit', () => {
    const card = renderSchemaCard(schema);
    expect(card.split('\n')).toHaveLength(2);
    expect(card).toContain('orders(order_id BIGINT');
    expect(renderSchemaCard(schema, 1).split('\n')).toHaveLength(1);
  });

  it('renders column comments and keeps samples optional', () => {
    const annotated = [{ table: 'orders', columns: [{ name: 'amount', type: 'DECIMAL', comment: 'order total', samples: ['1.00'] }] }];
    expect(renderSchemaCard(annotated)).toBe('orders(amount DECIMAL -- order total)');
    expect(renderSchemaCard(annotated, 40, { samples: true })).toBe('orders(amount DECIMAL [1.00] -- order total)');
  });

  it('adds enum samples only when asked', () => {
    const plain = renderSchemaCard(schema);
    const sampled = renderSchemaCard(schema, 40, { samples: true });
    expect(plain).not.toContain('[north|south]');
    expect(sampled).toContain('[north|south]');
    expect(sampled).toContain('order_id BIGINT');
  });
});

describe('sql extraction', () => {
  it('unwraps a fenced block', () => {
    expect(extractSql('here you go\n```sql\nSELECT 1\n```\n')).toBe('SELECT 1');
  });

  it('accepts an unfenced answer and an sql prefix', () => {
    expect(extractSql('SELECT 1')).toBe('SELECT 1');
    expect(extractSql('SQL: SELECT 1')).toBe('SELECT 1');
  });
});

describe('replay provider', () => {
  it('returns the recorded response for a matching prompt', async () => {
    const provider = createReplayProvider([{ match: 'revenue by region', response: 'SELECT region, sum(revenue) FROM orders GROUP BY 1' }]);
    const response = await provider.complete({ messages: [{ role: 'user', content: 'revenue by region' }] });
    expect(response.text).toContain('SELECT region');
    expect(response.usage?.promptTokens).toBeGreaterThan(0);
  });

  it('fails loudly when no fixture matches', async () => {
    const provider = createReplayProvider([]);
    await expect(provider.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_LLM_UNAVAILABLE',
    );
  });

  it('records calls made through a live provider', async () => {
    const sink: RecordedCall[] = [];
    const inner = createReplayProvider([{ match: 'x', response: 'SELECT 1' }]);
    const wrapped = recordProvider(inner, sink);
    await wrapped.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(sink).toHaveLength(1);
    expect(wrapped.id).toBe(inner.id);
  });
});

describe('question to guarded sql', () => {
  it('returns the first safe candidate with its linked columns', async () => {
    const provider = createReplayProvider([
      { match: 'revenue by region', response: '```sql\nSELECT region, sum(revenue) AS total FROM orders GROUP BY 1\n```' },
    ]);
    const pipeline = createPipeline({ provider });
    const result = await pipeline.ask({ question: 'revenue by region', schema });
    expect(result.attempts).toBe(1);
    expect(result.sql).toBe('SELECT region, sum(revenue) AS total FROM orders GROUP BY 1');
    expect(result.linked.length).toBeGreaterThan(0);
  });

  it('repairs a rejected candidate instead of returning it', async () => {
    const provider = createReplayProvider([
      { match: 'That statement failed', response: 'SELECT region FROM orders' },
      { match: 'revenue by region', response: 'DROP TABLE orders' },
    ]);
    const pipeline = createPipeline({ provider });
    const result = await pipeline.ask({ question: 'revenue by region', schema });
    expect(result.attempts).toBe(2);
    expect(result.sql).toBe('SELECT region FROM orders');
  });

  it('gives up after the repair budget and reports why', async () => {
    const stubborn: LlmProvider = {
      id: 'stubborn',
      model: 'stubborn',
      complete: async () => ({ text: 'DELETE FROM orders', model: 'stubborn' }),
    };
    const pipeline = createPipeline({ provider: stubborn, maxRepairs: 1 });
    await expect(pipeline.ask({ question: 'revenue by region', schema })).rejects.toSatisfy(
      (error: unknown) =>
        isNl2ChartsError(error) &&
        error.code === 'NL2C_E_GUARD_REJECTED' &&
        error.details.attempts === 2 &&
        typeof error.details.lastError === 'string',
    );
  });

  it('repairs an execution failure and returns the working statement', async () => {
    let calls = 0;
    const provider = createReplayProvider([
      { match: 'That statement failed', response: 'SELECT region FROM orders' },
      { match: 'revenue by region', response: 'SELECT region FROM missing_table' },
    ]);
    const pipeline = createPipeline({
      provider,
      execute: async (sql) => {
        calls += 1;
        if (sql.includes('missing_table')) throw new Error('Binder Error: table missing_table does not exist');
      },
    });
    const result = await pipeline.ask({ question: 'revenue by region', schema });
    expect(result.attempts).toBe(2);
    expect(result.sql).toBe('SELECT region FROM orders');
    expect(calls).toBe(2);
  });

  it('reports an execution failure as an engine error when the budget runs out', async () => {
    const provider = createReplayProvider([{ match: 'revenue by region', response: 'SELECT * FROM missing' }]);
    const pipeline = createPipeline({
      provider,
      maxRepairs: 0,
      execute: async () => {
        throw new Error('Binder Error');
      },
    });
    await expect(pipeline.ask({ question: 'revenue by region', schema })).rejects.toSatisfy(
      (error: unknown) =>
        isNl2ChartsError(error) && error.code === 'NL2C_E_ENGINE_FAILED' && error.details.attempts === 1,
    );
  });

  it('builds a prompt that states the read-only rules and the schema', async () => {
    const seen: string[] = [];
    const capturing: LlmProvider = {
      id: 'capture',
      model: 'capture',
      complete: async (request) => {
        seen.push(request.messages.map((message) => message.content).join('\n'));
        return { text: 'SELECT 1', model: 'capture' };
      },
    };
    await createPipeline({ provider: capturing }).ask({ question: 'unmatched words', schema });
    expect(seen[0]).toContain('SELECT only');
    expect(seen[0]).toContain('orders(order_id BIGINT');
    expect(seen[0]).toContain('No column matched');
  });
});
