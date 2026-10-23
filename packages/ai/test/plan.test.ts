import { describe, expect, it } from 'vitest';
import { buildPlanPrompt, parsePlan } from '../src/plan.js';
import { buildSqlPrompt, createPipeline } from '../src/pipeline.js';
import type { LlmProvider, LlmRequest } from '../src/provider.js';
import type { SchemaTable } from '../src/linking.js';

/**
 * The plan is a separate lever from the interpretation, so the tests pin the
 * differences that matter: it asks for engine order (scan → filter → join → group →
 * answer), it forbids SQL, and a reply that ignores the format is dropped rather than
 * passed on as if it were a plan.
 */
const schema: SchemaTable[] = [
  { table: 'orders', columns: [{ name: 'order_id', type: 'BIGINT' }, { name: 'status', type: 'TEXT' }] },
  { table: 'customers', columns: [{ name: 'customer_id', type: 'BIGINT' }, { name: 'region', type: 'TEXT' }] },
];

describe('plan prompt', () => {
  const prompt = buildPlanPrompt('How many completed orders per region?', schema);

  it('asks for the five decisions in engine order', () => {
    for (const label of ['SCAN:', 'FILTER:', 'JOIN:', 'GROUP:', 'ANSWER:']) expect(prompt).toContain(label);
    expect(prompt.indexOf('SCAN:')).toBeLessThan(prompt.indexOf('ANSWER:'));
  });

  it('forbids SQL, because the statement is the next call', () => {
    expect(prompt).toContain('Do not write SQL');
  });

  it('carries the schema, so the plan names real columns', () => {
    expect(prompt).toContain('orders');
    expect(prompt).toContain('customers');
  });
});

describe('reading a plan back', () => {
  it('keeps labelled lines and drops the prose around them', () => {
    const reply = [
      'Sure! Here is the plan:',
      '- SCAN: orders, customers',
      '- FILTER: orders.status = "completed"',
      'That should do it.',
      '- JOIN: orders.customer_id = customers.customer_id',
    ].join('\n');
    const plan = parsePlan(reply);
    expect(plan).toContain('SCAN: orders');
    expect(plan).toContain('JOIN: orders.customer_id');
    expect(plan).not.toContain('Sure!');
    expect(plan).not.toContain('That should do it');
  });

  it('returns nothing when the reply ignored the format', () => {
    // An ignored format is not a plan; passing it on would make the arm look like it
    // ran when the block carried no structure.
    expect(parsePlan('The answer is a join between orders and customers.')).toBe('');
    expect(parsePlan('')).toBe('');
  });

  it('respects the character budget without cutting a line in half', () => {
    const reply = ['SCAN: a', 'FILTER: b', 'JOIN: c'].join('\n');
    const trimmed = parsePlan(reply, 20);
    expect(trimmed.split('\n').every((line) => /^(SCAN|FILTER|JOIN):/.test(line))).toBe(true);
    expect(trimmed).not.toContain('JOI');
  });

  it('is stable for the same reply', () => {
    const reply = 'SCAN: x\nFILTER: y';
    expect(parsePlan(reply)).toBe(parsePlan(reply));
  });
});

describe('pipeline with a plan', () => {
  // The provider answers the plan call and the SQL call differently: returning the
  // same text twice would test the guard rather than the plan.
  const answering = (planReply: string, sqlReply = 'SELECT COUNT(*) FROM orders'): { provider: LlmProvider; calls: LlmRequest[] } => {
    const calls: LlmRequest[] = [];
    return {
      calls,
      provider: {
        id: 'test',
        model: 'test-model',
        async complete(request: LlmRequest) {
          calls.push(request);
          const text = calls.length === 1 ? planReply : sqlReply;
          return { text, usage: { promptTokens: 1, completionTokens: 1 } } as never;
        },
      },
    };
  };

  it('spends one extra call and carries the plan into the SQL prompt', async () => {
    const { provider, calls } = answering('SCAN: orders\nFILTER: none\nANSWER: one number');
    const pipeline = createPipeline({ provider, plan: true });
    await pipeline.ask({ question: 'How many orders?', schema });
    expect(calls).toHaveLength(2);
    const system = String(calls[1]?.messages[0]?.content ?? '');
    expect(system).toContain('Plan:');
    expect(system).toContain('SCAN: orders');
  });

  it('makes one call when the plan is off', async () => {
    const { provider, calls } = answering('SELECT 1');
    const pipeline = createPipeline({ provider });
    await pipeline.ask({ question: 'How many orders?', schema });
    expect(calls).toHaveLength(1);
  });

  it('drops an unformatted plan instead of adding an empty heading', async () => {
    const { provider, calls } = answering('I would join the two tables.');
    const pipeline = createPipeline({ provider, plan: true });
    await pipeline.ask({ question: 'q', schema });
    const system = String(calls[1]?.messages[0]?.content ?? '');
    expect(system).not.toContain('Plan:');
  });

  it('renders a plan block only when it has content', () => {
    const withoutPlan = buildSqlPrompt('q', schema, {});
    expect(withoutPlan).not.toContain('Plan:');
    expect(buildSqlPrompt('q', schema, { plan: 'SCAN: orders' })).toContain('Plan:\nSCAN: orders');
  });
});
