import { describe, expect, it } from 'vitest';
import { buildExamplePrompt, parseExamples } from '../src/examples.js';
import type { SchemaTable } from '../src/linking.js';

const schema: SchemaTable[] = [
  {
    table: 'orders',
    columns: [
      { name: 'order_id', type: 'BIGINT', comment: 'the id of the order.' },
      { name: 'region', type: 'VARCHAR', comment: 'where the order was placed.', samples: ['north'] },
    ],
    foreignKeys: ['orders.customer_id = customers.customer_id'],
  },
  { table: 'customers', columns: [{ name: 'customer_id', type: 'BIGINT' }] },
];

describe('the prompt that writes examples for one database', () => {
  it('states the count it wants and the two things a pair has to be', () => {
    const prompt = buildExamplePrompt(schema, 3);
    expect(prompt.startsWith('Write 3 practice questions for the database below')).toBe(true);
    // The value rule is the one that makes an example useful rather than decorative: a literal
    // the column does not store teaches a comparison that will not match.
    expect(prompt).toContain('in the spelling this schema stores them');
    expect(prompt).toContain('single SELECT with no comments');
    expect(prompt.endsWith('Write the 3 pairs now:')).toBe(true);
  });

  it('carries the card and the keys, so a pair can name a real join', () => {
    const prompt = buildExamplePrompt(schema, 2);
    expect(prompt).toContain('【Database schema】');
    expect(prompt).toContain('# Table: orders');
    expect(prompt).toContain('(region, VARCHAR. where the order was placed.)');
    expect(prompt).toContain('【Foreign keys】');
    expect(prompt).toContain('orders.customer_id = customers.customer_id');
  });

  it('never states a question or a statement of its own', () => {
    // The generator must not be handed anything to copy: a prompt that carried an example would
    // make every database's block a variant of that one example.
    const prompt = buildExamplePrompt(schema, 3);
    expect(prompt).not.toMatch(/```sql\n\s*SELECT/i);
    // The format line names the label; no line in the prompt is a question with text after it.
    expect(prompt).not.toMatch(/^Question:\s*\S/m);
  });
});

describe('the reply, parsed into pairs', () => {
  it('reads a label and a fence, in the order the reply wrote them', () => {
    const reply = [
      'Question: How many orders are there?',
      '```sql',
      'SELECT COUNT(*) FROM orders',
      '```',
      '',
      'Question: Which region has the most orders?',
      '```sql',
      'SELECT region FROM orders GROUP BY region ORDER BY COUNT(*) DESC LIMIT 1',
      '```',
    ].join('\n');
    const examples = parseExamples(reply, 3);
    expect(examples).toEqual([
      { question: 'How many orders are there?', sql: 'SELECT COUNT(*) FROM orders' },
      { question: 'Which region has the most orders?', sql: 'SELECT region FROM orders GROUP BY region ORDER BY COUNT(*) DESC LIMIT 1' },
    ]);
  });

  it('accepts the decoration a chat model puts around a label', () => {
    const reply = ['**Question 1:** What is the largest order?', '**SQL**', '```sql', 'SELECT MAX(order_id) FROM orders', '```'].join('\n');
    expect(parseExamples(reply, 1)).toEqual([{ question: 'What is the largest order?', sql: 'SELECT MAX(order_id) FROM orders' }]);
  });

  it('accepts a statement written without a fence', () => {
    const reply = ['Question: How many customers?', 'SELECT COUNT(*) FROM customers'].join('\n');
    expect(parseExamples(reply, 1)).toEqual([{ question: 'How many customers?', sql: 'SELECT COUNT(*) FROM customers' }]);
  });

  it('takes the last fence of a pair, which is the answer', () => {
    // The shape a model writes when it reasons first: a sub-query in one fence, the statement
    // that answers in another. The reader takes the last one everywhere else in this pipeline,
    // and an example that taught the first fence would teach a statement nobody runs.
    const reply = ['Question: Which region has the most orders?', '```sql', 'SELECT region FROM orders', '```', 'and then:', '```sql', 'SELECT region FROM orders GROUP BY region ORDER BY COUNT(*) DESC LIMIT 1', '```'].join('\n');
    const examples = parseExamples(reply, 1);
    expect(examples[0]?.sql).toBe('SELECT region FROM orders GROUP BY region ORDER BY COUNT(*) DESC LIMIT 1');
  });

  it('drops a pair whose statement is not a read', () => {
    const reply = ['Question: Delete every order?', '```sql', 'DELETE FROM orders', '```', 'Question: How many orders?', '```sql', 'SELECT COUNT(*) FROM orders', '```'].join('\n');
    expect(parseExamples(reply, 3)).toEqual([{ question: 'How many orders?', sql: 'SELECT COUNT(*) FROM orders' }]);
  });

  it('drops a repeated statement, which would cost tokens and carry no second fact', () => {
    const reply = ['Question: How many orders?', '```sql', 'SELECT COUNT(*) FROM orders', '```', 'Question: What is the order count?', '```sql', 'select  count(*)   from orders', '```'].join('\n');
    expect(parseExamples(reply, 3)).toHaveLength(1);
  });

  it('stops at the count the caller asked for', () => {
    const reply = ['Question: one', '```sql', 'SELECT 1 FROM orders', '```', 'Question: two', '```sql', 'SELECT 2 FROM orders', '```', 'Question: three', '```sql', 'SELECT 3 FROM orders', '```'].join('\n');
    expect(parseExamples(reply, 2)).toHaveLength(2);
  });

  it('returns nothing when there is no label, or a label with no statement under it', () => {
    expect(parseExamples('I cannot write questions about this schema.', 3)).toEqual([]);
    expect(parseExamples('Question: How many orders?\nNo statement follows.', 3)).toEqual([]);
    // An empty question is not a question, and the pair it belongs to is dropped rather than
    // rendered as a block with a blank line where the question should be.
    expect(parseExamples('Question:   \n```sql\nSELECT COUNT(*) FROM orders\n```', 3)).toEqual([]);
  });

  it('drops a pair whose fence was never closed', () => {
    // The strictness is deliberate: an unclosed fence means the reply was cut off, and half a
    // statement in the prompt is worse than one example fewer.
    expect(parseExamples('Question: How many orders?\n```sql\nSELECT COUNT(*) FROM orders', 3)).toEqual([]);
  });

  it('treats `WITH` as a statement, because a generated example may need one', () => {
    const reply = ['Question: Which region is above average?', '```sql', 'WITH per AS (SELECT region, COUNT(*) AS n FROM orders GROUP BY region) SELECT region FROM per WHERE n > (SELECT AVG(n) FROM per)', '```'].join('\n');
    expect(parseExamples(reply, 1)).toHaveLength(1);
  });
});
