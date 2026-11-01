import { describe, expect, it } from 'vitest';
import { auditMessages, buildConditionAuditFeedback, countNamedConditions } from '../src/audit.js';
import { createPipeline } from '../src/pipeline.js';
import type { LlmMessage, LlmProvider, LlmRequest } from '../src/provider.js';

/**
 * The audit turn is the only mechanism in this repository aimed at the failure class that
 * passes, returns rows and is still wrong: 16.1-18.8pp of Mini-Dev where a column the gold
 * filters on never appears in the statement. It cannot read the result — the result looked
 * fine — so it asks the model to check its own statement against the question, one call,
 * and rewrites once.
 *
 * These tests pin the four properties that make it a measurement rather than a retry:
 * the audit question is its own turn after the statement; a reply is adopted only when it
 * is a safe statement; the count of conditions it named is recorded, because a turn that
 * names nothing and rewrites nothing is a different finding from one that names three;
 * and the call carries its own purpose, so its price is a column and not a guess.
 */

const schema = [
  {
    table: 'orders',
    columns: [
      { name: 'order_id', type: 'BIGINT', primaryKey: true },
      { name: 'region', type: 'TEXT' },
      { name: 'revenue', type: 'DOUBLE' },
      { name: 'status', type: 'TEXT' },
    ],
  },
] as never;

const QUESTION = 'revenue by region for orders that were not cancelled';

/** A scripted endpoint: one reply per call, in order, with the purpose it was asked for. */
function scripted(replies: readonly string[]): { provider: LlmProvider; seen: { purpose?: string; messages: LlmMessage[] }[] } {
  const seen: { purpose?: string; messages: LlmMessage[] }[] = [];
  let index = 0;
  return {
    seen,
    provider: {
      id: 'scripted',
      model: 'scripted',
      complete: async (request: LlmRequest) => {
        seen.push({ ...(request.purpose === undefined ? {} : { purpose: request.purpose }), messages: [...request.messages] });
        const text = replies[Math.min(index, replies.length - 1)] as string;
        index += 1;
        return { text, model: 'scripted' };
      },
    },
  };
}

describe('the audit turn', () => {
  it('places the statement as the assistant turn and the audit question after it', () => {
    const messages = auditMessages(QUESTION, 'SELECT region FROM orders', 'SELECT region FROM orders');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'assistant', content: 'SELECT region FROM orders' });
    expect(messages[1]?.role).toBe('user');
  });

  it('carries the question it is auditing, so the comparison does not depend on an earlier turn', () => {
    const feedback = buildConditionAuditFeedback(QUESTION, 'SELECT region FROM orders');
    expect(feedback).toContain(QUESTION);
  });

  it('asks for one MISSING line per condition and refuses conditions the question never stated', () => {
    const feedback = buildConditionAuditFeedback(QUESTION, 'SELECT region FROM orders');
    expect(feedback).toContain('MISSING:');
    expect(feedback).toContain('none');
    expect(feedback).toMatch(/add no condition the question does not state/i);
  });

  it('asks for the statement again in one fenced block', () => {
    const feedback = buildConditionAuditFeedback(QUESTION, 'SELECT region FROM orders');
    expect(feedback).toMatch(/fenced block/i);
    expect(feedback).toMatch(/one SELECT/i);
  });

  it('names the statement it is auditing in the prompt it sends', () => {
    const feedback = buildConditionAuditFeedback(QUESTION, 'SELECT region FROM orders');
    expect(feedback).toContain('SELECT region FROM orders');
  });

  it('keeps the instruction short enough to be a turn rather than a second prompt', () => {
    // The turn re-sends the card, so every character here is paid on every case. The
    // ceiling is deliberately generous but not infinite.
    expect(buildConditionAuditFeedback(QUESTION, 'SELECT 1').length).toBeLessThan(1200);
  });
});

describe('how many conditions the audit said were missing', () => {
  it('counts one per MISSING line', () => {
    const reply = ['MISSING: status is never filtered', 'MISSING: revenue is summed without a group', '```sql\nSELECT 1\n```'].join(
      '\n',
    );
    expect(countNamedConditions(reply)).toBe(2);
  });

  it('reads MISSING: none as nothing missing', () => {
    expect(countNamedConditions('MISSING: none\n```sql\nSELECT 1\n```')).toBe(0);
  });

  it('is case- and space-insensitive on the prefix', () => {
    expect(countNamedConditions('  missing :   status\n```sql\nSELECT 1\n```')).toBe(1);
  });

  it('ignores prose and fenced statements that are not MISSING lines', () => {
    const reply = ['The statement looks complete.', '```sql', 'MISSING: this is inside the statement', '```'].join('\n');
    expect(countNamedConditions(reply)).toBe(0);
  });

  it('does not count an empty MISSING line', () => {
    expect(countNamedConditions('MISSING:\nMISSING:   \n')).toBe(0);
  });

  it('counts a statement that names a column without a prefix as nothing', () => {
    expect(countNamedConditions('status is never filtered')).toBe(0);
  });
});

describe('the pipeline with an audit turn', () => {
  it('does not spend the call unless the option is set', async () => {
    const { provider, seen } = scripted(['SELECT region, sum(revenue) FROM orders GROUP BY 1']);
    const result = await createPipeline({ provider }).ask({ question: QUESTION, schema });
    expect(seen).toHaveLength(1);
    expect(result.audit).toBeUndefined();
    expect(result.attempts).toBe(1);
  });

  it('adopts the audited statement and records what the audit named', async () => {
    const { provider, seen } = scripted([
      'SELECT region, sum(revenue) FROM orders GROUP BY 1',
      ['MISSING: status = \'cancelled\' is never excluded', '```sql', 'SELECT region, sum(revenue) FROM orders WHERE status <> \'cancelled\' GROUP BY 1', '```'].join('\n'),
    ]);
    const result = await createPipeline({ provider, audit: 'conditions' }).ask({ question: QUESTION, schema });
    expect(seen).toHaveLength(2);
    expect(result.sql).toContain("WHERE status <> 'cancelled'");
    expect(result.audit).toEqual({ fired: true, named: 1, rewritten: true });
    expect(result.attempts).toBe(2);
  });

  it('sends the audit on its own purpose, so its price is a column and not a guess', async () => {
    const { provider, seen } = scripted([
      'SELECT region FROM orders',
      'MISSING: none\n```sql\nSELECT region FROM orders\n```',
    ]);
    await createPipeline({ provider, audit: 'conditions' }).ask({ question: QUESTION, schema });
    expect(seen[0]?.purpose).toBe('generate');
    expect(seen[1]?.purpose).toBe('audit');
  });

  it('keeps the statement when the audit says nothing is missing and rewrites nothing', async () => {
    const { provider } = scripted(['SELECT region FROM orders', 'MISSING: none\n```sql\nSELECT region FROM orders\n```']);
    const result = await createPipeline({ provider, audit: 'conditions' }).ask({ question: QUESTION, schema });
    expect(result.sql).toBe('SELECT region FROM orders');
    expect(result.audit).toEqual({ fired: true, named: 0, rewritten: false });
  });

  it('keeps the original when the audit reply carries no statement', async () => {
    const { provider } = scripted(['SELECT region FROM orders', 'MISSING: status is never filtered']);
    const result = await createPipeline({ provider, audit: 'conditions' }).ask({ question: QUESTION, schema });
    expect(result.sql).toBe('SELECT region FROM orders');
    expect(result.audit?.named).toBe(1);
  });

  it('keeps the original when the audited statement is unsafe', async () => {
    const { provider } = scripted(['SELECT region FROM orders', 'MISSING: none\n```sql\nDROP TABLE orders\n```']);
    const result = await createPipeline({ provider, audit: 'conditions' }).ask({ question: QUESTION, schema });
    expect(result.sql).toBe('SELECT region FROM orders');
    expect(result.audit?.rewritten).toBe(false);
  });

  it('audits once, not once per repair turn', async () => {
    const { provider, seen } = scripted([
      'DROP TABLE orders',
      'SELECT region FROM orders',
      'MISSING: none\n```sql\nSELECT region FROM orders\n```',
    ]);
    const result = await createPipeline({ provider, audit: 'conditions' }).ask({ question: QUESTION, schema });
    expect(result.attempts).toBe(3);
    expect(seen.map((call) => call.purpose)).toEqual(['generate', 'retry', 'audit']);
  });

  it('audits the statement the guard accepted, not the one it rejected', async () => {
    const { provider, seen } = scripted([
      'DROP TABLE orders',
      'SELECT region FROM orders',
      'MISSING: none\n```sql\nSELECT region FROM orders\n```',
    ]);
    await createPipeline({ provider, audit: 'conditions' }).ask({ question: QUESTION, schema });
    const auditTurn = seen[2]?.messages.at(-1)?.content ?? '';
    expect(auditTurn).toContain('SELECT region FROM orders');
    expect(auditTurn).not.toContain('DROP');
  });

  it('reports the audited statement to an execute hook, so the caller runs what it was given', async () => {
    const executed: string[] = [];
    const { provider } = scripted([
      'SELECT region FROM orders',
      'MISSING: revenue is never summed\n```sql\nSELECT region, sum(revenue) FROM orders GROUP BY 1\n```',
    ]);
    const result = await createPipeline({
      provider,
      audit: 'conditions',
      execute: async (sql) => {
        executed.push(sql);
      },
    }).ask({ question: QUESTION, schema });
    expect(executed).toEqual([result.sql]);
    expect(result.sql).toContain('sum(revenue)');
  });
});
