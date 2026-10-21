import { describe, expect, it } from 'vitest';
import { buildInterpretationPrompt, parseInterpretation } from '../src/interpret.js';
import { createPipeline } from '../src/pipeline.js';
import { createReplayProvider } from '../src/replay.js';
import type { LlmProvider } from '../src/provider.js';
import type { SchemaTable } from '../src/linking.js';

/**
 * One sentence before the SQL.
 *
 * Everything written once per database measured as noise; the only term that
 * moves accuracy is the per-question hint. This stage asks the model to state
 * what the question computes *for this question*, using the definitions already
 * attached to the columns, and then to write SQL from that statement.
 *
 * The tests pin three things: the request must forbid SQL, the reply must be
 * reduced to a short statement, and the SQL call must actually see it.
 */
const schema: readonly SchemaTable[] = [
  {
    table: 'orders',
    columns: [
      { name: 'status', type: 'TEXT', comment: 'completed means paid and shipped' },
      { name: 'total_amount', type: 'DOUBLE', comment: 'charged amount, tax included' },
    ],
  },
];

describe('interpretation request', () => {
  it('carries the question and the column semantics', () => {
    const prompt = buildInterpretationPrompt('What is the revenue per status?', schema);
    expect(prompt).toContain('What is the revenue per status?');
    expect(prompt).toContain('completed means paid and shipped');
    expect(prompt).toContain('orders');
  });

  it('forbids SQL and bounds the answer', () => {
    const prompt = buildInterpretationPrompt('q', schema);
    expect(prompt).toContain('Do not write SQL');
    expect(prompt).toContain('at most two lines');
  });

  it('names the ambiguities that BIRD evidence resolves', () => {
    const prompt = buildInterpretationPrompt('q', schema);
    expect(prompt).toContain('numerator and denominator');
    expect(prompt).toContain('which rows are counted');
  });
});

describe('interpretation reply', () => {
  it('keeps at most two lines and drops fences', () => {
    const reply = '```\nRevenue = sum of total_amount over paid orders.\nCounted per status.\nthird line\n```';
    expect(parseInterpretation(reply)).toBe('Revenue = sum of total_amount over paid orders.\nCounted per status.');
  });

  it('rejects a reply that is actually SQL', () => {
    expect(parseInterpretation('SELECT status, sum(total_amount) FROM orders')).toBe('');
  });

  it('strips bullet markers and a leading label', () => {
    expect(parseInterpretation('- Interpretation: revenue excludes refunds.')).toBe('revenue excludes refunds.');
    expect(parseInterpretation('Interpretation: revenue excludes refunds.')).toBe('revenue excludes refunds.');
  });

  it('returns nothing for an empty or unhelpful reply', () => {
    expect(parseInterpretation('')).toBe('');
    expect(parseInterpretation('   \n  ')).toBe('');
  });

  it('caps a long sentence instead of dropping it', () => {
    const long = `Revenue is ${'very '.repeat(120)}long.`;
    const parsed = parseInterpretation(long);
    expect(parsed.length).toBeLessThanOrEqual(300);
    expect(parsed.endsWith('.')).toBe(false);
  });
});

describe('pipeline with interpretation', () => {
  it('asks for the interpretation first and shows it to the SQL call', async () => {
    const seen: string[] = [];
    const provider: LlmProvider = {
      id: 'recording',
      model: 'fixture',
      async complete(request) {
        const system = request.messages[0]?.content ?? '';
        seen.push(system);
        const isInterpretation = system.includes('Do not write SQL');
        return {
          text: isInterpretation ? 'Revenue = sum of total_amount over completed orders.' : 'SELECT 1',
          model: 'fixture',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
    };
    const pipeline = createPipeline({ provider, prompt: { dialect: 'SQLite' }, interpret: true });
    const result = await pipeline.ask({ question: 'revenue per status', schema });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('Do not write SQL');
    expect(seen[1]).toContain('Interpretation: Revenue = sum of total_amount over completed orders.');
    expect(result.sql).toBe('SELECT 1');
  });

  it('passes the sampling temperature through, so a caller can sample', async () => {
    const temperatures: (number | undefined)[] = [];
    const provider: LlmProvider = {
      id: 'thermometer',
      model: 'fixture',
      async complete(request) {
        temperatures.push(request.temperature);
        return { text: 'SELECT 1', model: 'fixture', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      },
    };
    await createPipeline({ provider, temperature: 0.7 }).ask({ question: 'q', schema });
    expect(temperatures).toEqual([0.7]);
    temperatures.length = 0;
    await createPipeline({ provider }).ask({ question: 'q', schema });
    expect(temperatures).toEqual([0]);
  });

  it('costs one call and no interpretation line when the stage is off', async () => {
    let calls = 0;
    const provider: LlmProvider = {
      id: 'counting',
      model: 'fixture',
      async complete() {
        calls += 1;
        return { text: 'SELECT 1', model: 'fixture', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      },
    };
    const pipeline = createPipeline({ provider, interpret: false });
    await pipeline.ask({ question: 'q', schema });
    expect(calls).toBe(1);
  });

  it('continues without an interpretation line when the stage declines', async () => {
    const provider = createReplayProvider([
      { match: 'Do not write SQL', response: 'I cannot determine this.' },
      { match: 'q', response: 'SELECT 1' },
    ]);
    const pipeline = createPipeline({ provider, interpret: true });
    const result = await pipeline.ask({ question: 'q', schema });
    expect(result.sql).toBe('SELECT 1');
  });

  it('keeps the guard: an interpretation stage cannot smuggle a DDL through', async () => {
    const replies = ['Delete every order.', 'DROP TABLE orders', 'SELECT 1'];
    let calls = 0;
    const provider: LlmProvider = {
      id: 'staged',
      model: 'fixture',
      async complete() {
        const text = replies[Math.min(calls, replies.length - 1)] as string;
        calls += 1;
        return { text, model: 'fixture', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      },
    };
    const pipeline = createPipeline({ provider, interpret: true });
    const result = await pipeline.ask({ question: 'q', schema });
    expect(result.sql).toBe('SELECT 1');
    expect(result.attempts).toBe(2);
    expect(calls).toBe(3);
  });
});
