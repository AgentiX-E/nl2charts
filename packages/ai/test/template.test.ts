import { describe, expect, it } from 'vitest';
import {
  assertTemplateCarries,
  MACSQL_CONSTRAINTS,
  renderMacSqlBirdPrompt,
  renderMacSqlCard,
  renderMacSqlForeignKeys,
  TEMPLATE_CONFLICTS,
} from '../src/template.js';
import { buildAskMessages, buildSqlPrompt, extractSql, readStatement } from '../src/pipeline.js';
import type { SchemaTable } from '../src/linking.js';

const schema: SchemaTable[] = [
  {
    table: 'orders',
    columns: [
      { name: 'order_id', type: 'BIGINT', comment: 'the id of the order.' },
      { name: 'region', type: 'VARCHAR', comment: 'where the order was placed.', samples: ['north', 'south'] },
      { name: 'revenue', type: 'DECIMAL' },
      { name: 'blank', type: 'TEXT', comment: '   ' },
    ],
    foreignKeys: ['orders.customer_id = customers.customer_id'],
  },
  { table: 'customers', columns: [{ name: 'customer_id', type: 'BIGINT' }] },
];

describe('MAC-SQL’s card, rendered from our schema', () => {
  it('writes one bracketed line per column, under the heading their examples use', () => {
    const card = renderMacSqlCard(schema);
    expect(card).toContain('# Table: orders\n[\n');
    expect(card).toContain('  (order_id, BIGINT. the id of the order.)');
    // The type is the one deliberate addition to their line: their format omits it, and a card
    // without types would be measured on an information deficit this project does not have.
    expect(card).toContain('(region, VARCHAR. where the order was placed.)');
    expect(card).toContain(']');
  });

  it('prints value examples only where the caller attached them, and only when asked', () => {
    expect(renderMacSqlCard(schema)).not.toContain('Value examples');
    expect(renderMacSqlCard(schema, { samples: true })).toContain('Value examples: [north, south]');
    // ...and not for a column that holds none, which is the branch a profiled card never reaches.
    expect(renderMacSqlCard(schema, { samples: true })).toContain('(customer_id, BIGINT.)');
  });

  it('drops the prose when descriptions are off, keeping the line and the type', () => {
    const card = renderMacSqlCard(schema, { descriptions: false });
    expect(card).not.toContain('the id of the order.');
    expect(card).toContain('(order_id, BIGINT.)');
  });

  it('treats a whitespace-only comment as no comment', () => {
    expect(renderMacSqlCard(schema)).toContain('(blank, TEXT.)');
  });

  it('spends the column budget the assembled prompt spends, across tables', () => {
    // The omission that made the first clean reading confounded: `schemaLines: 40` reached
    // `buildSqlPrompt` and the template rendered all 12,668 characters of card the schema held, so
    // the arm measured a template *and* a card four times the size of its parent's.
    const wide = [
      { table: 'a', columns: Array.from({ length: 30 }, (_, i) => ({ name: `a${i}`, type: 'TEXT' })) },
      { table: 'b', columns: Array.from({ length: 30 }, (_, i) => ({ name: `b${i}`, type: 'TEXT' })) },
    ];
    const card = renderMacSqlCard(wide, { limit: 40 });
    const lines = card.split('\n').filter((line) => line.trim().startsWith('('));
    expect(lines).toHaveLength(40);
    // ...continued into the second table rather than restarting the budget per table.
    expect(lines[39]).toContain('(b9,');
    expect(card).not.toContain('(b10,');
  });

  it('renders no table at all when the budget is zero', () => {
    expect(renderMacSqlCard(schema, { limit: 0 })).toBe('');
  });

  it('carries the budget through the prompt and through the builder', () => {
    const wide = [{ table: 'a', columns: Array.from({ length: 60 }, (_, i) => ({ name: `a${i}`, type: 'TEXT' })) }];
    const prompt = renderMacSqlBirdPrompt({ question: 'q', schema: wide, schemaLines: 40 });
    // The worked examples carry their own columns, including `(account_id,`, so the count is on
    // this table's own names rather than on the bracket.
    expect(prompt.split('\n').filter((line) => /^\s+\(a\d+,/.test(line))).toHaveLength(40);
    expect(buildSqlPrompt('q', wide, { template: 'macsql-bird', schemaLines: 40 })).toBe(prompt);
  });

  it('renders every join hint once, and says None when the schema declares none', () => {
    expect(renderMacSqlForeignKeys(schema)).toBe('orders.customer_id = customers.customer_id');
    expect(renderMacSqlForeignKeys([{ table: 't', columns: [] }])).toBe('None');
  });
});

describe('the whole prompt', () => {
  it('carries the five constraints, both worked examples and the question', () => {
    const prompt = renderMacSqlBirdPrompt({ question: 'How many orders are there?', schema, evidence: 'An order is a row.' });
    for (const rule of MACSQL_CONSTRAINTS) expect(prompt).toContain(rule);
    expect(prompt).toContain('【Database schema】');
    expect(prompt).toContain('# Table: frpm');
    expect(prompt).toContain('# Table: district');
    expect(prompt).toContain('Question Solved.');
    expect(prompt).toContain('【Question】\nHow many orders are there?');
    expect(prompt).toContain('【Evidence】\nAn order is a row.');
    expect(prompt.trimEnd().endsWith('thinking step by step:')).toBe(true);
  });

  it('leaves no placeholder behind, which is why the assembly is a concatenation', () => {
    const prompt = renderMacSqlBirdPrompt({ question: 'q', schema });
    expect(prompt).not.toMatch(/\{(?:desc_str|fk_str|query|evidence)\}/);
  });

  it('renders None for a missing or blank evidence note, the way their template does', () => {
    expect(renderMacSqlBirdPrompt({ question: 'q', schema })).toContain('【Evidence】\nNone\n');
    expect(renderMacSqlBirdPrompt({ question: 'q', schema, evidence: '   ' })).toContain('【Evidence】\nNone\n');
  });

  it('passes the card options through to the card', () => {
    const off = renderMacSqlBirdPrompt({ question: 'q', schema, descriptions: false });
    expect(off).not.toContain('the id of the order.');
    const sampled = renderMacSqlBirdPrompt({ question: 'q', schema, samples: true });
    expect(sampled).toContain('Value examples: [north, south]');
  });
});

describe('buildSqlPrompt dispatches on the template', () => {
  it('sends the template instead of the assembled prompt, not in addition to it', () => {
    const prompt = buildSqlPrompt('How many orders?', schema, { template: 'macsql-bird', evidence: 'x' });
    expect(prompt).toBe(renderMacSqlBirdPrompt({ question: 'How many orders?', schema, evidence: 'x' }));
    expect(prompt).not.toContain('You translate questions into one read-only SQL statement.');
  });

  it('refuses a block the template has no slot for, naming it', () => {
    expect(() => buildSqlPrompt('q', schema, { template: 'macsql-bird', decompose: true })).toThrow(/no slot for decompose/);
    expect(() => buildSqlPrompt('q', schema, { template: 'macsql-bird', notes: ['a rule'] })).toThrow(/no slot for notes/);
    // The dialect is stated by the template and by both examples, so another one is a contradiction.
    expect(() => buildSqlPrompt('q', schema, { template: 'macsql-bird', dialect: 'PostgreSQL' })).toThrow(/no slot for dialect/);
  });

  it('accepts the options the template does carry', () => {
    expect(() => buildSqlPrompt('q', schema, { template: 'macsql-bird', dialect: 'SQLite' })).not.toThrow();
    // An empty notes list is the profile's shape, not a rule the template would drop.
    expect(() => buildSqlPrompt('q', schema, { template: 'macsql-bird', notes: [] })).not.toThrow();
    expect(() => buildSqlPrompt('q', schema, { template: 'macsql-bird', definitions: '' })).not.toThrow();
  });

  it('keeps every conflict named in one list, so the harness and the builder agree', () => {
    // The harness asserts at arm declaration with the same function; a conflict added here without
    // reaching the runtime assert is the failure this test exists to prevent.
    for (const key of TEMPLATE_CONFLICTS) {
      const options: Record<string, unknown> = { template: 'macsql-bird' };
      options[key] = key === 'notes' ? ['rule'] : key === 'decompose' || key === 'reasoning' ? (key === 'reasoning' ? 'sql-like' : true) : 'block';
      expect(() => assertTemplateCarries(options as unknown as Parameters<typeof assertTemplateCarries>[0])).toThrow(new RegExp(key));
    }
  });
});

describe('the path the harness actually takes', () => {
  // The test above this one went through `buildSqlPrompt` and passed while every case of the first
  // `macsql-prompt` dispatch failed inside the harness: `buildAskMessages` sets `decompose` on every
  // call, so the prompt arrived carrying `decompose: false` and the conflict check read "off" as
  // "asked for". Six hundred rows at 0.0% and no call spent, reported two layers away as a missing
  // format profile. A prompt feature is only tested where the harness reaches it.
  it('sends the template through the message builder, where `decompose: false` is set for everyone', () => {
    const built = buildAskMessages({ question: 'How many orders?', schema, prompt: { template: 'macsql-bird' }, linking: false });
    expect(built.messages[0].content).toContain('【Constraints】');
    expect(built.messages[0].content).not.toContain('You translate questions into one read-only SQL statement.');
    // The user turn is the harness's own and does not carry the question twice: the template's
    // last line already asks for it.
    expect(built.messages[1].content).toContain('How many orders?');
  });

  it('still refuses a decomposition on a template, which is the conflict that matters', () => {
    expect(() => buildAskMessages({ question: 'q', schema, prompt: { template: 'macsql-bird' }, decompose: true })).toThrow(/no slot for decompose/);
  });
});

describe('reading a reply by the prompt that produced it', () => {
  const twoStatements = ['Sub question 1: ids', '```sql', 'SELECT id FROM orders', '```', 'Sub question 2: the answer', '```sql', 'SELECT count(*) FROM orders', '```'].join('\n');

  it('reads the first fence by default, which is what a one-statement prompt produces', () => {
    expect(readStatement(twoStatements).sql).toBe('SELECT id FROM orders');
    expect(readStatement(twoStatements).steps).toBe(0);
  });

  it('reads the last fence for a template, and counts no steps', () => {
    // The count is this project's marker, and the template writes `Sub question:`, so a number here
    // would be a reading about the marker rather than about the reply.
    expect(readStatement(twoStatements, { template: 'macsql-bird' })).toEqual({ sql: 'SELECT count(*) FROM orders', steps: 0 });
  });

  it('reads the last fence and the steps for a decomposition', () => {
    const decomposed = ['STEP 1: SELECT id FROM orders', 'STEP 2: count them', '```sql', 'SELECT count(*) FROM orders', '```'].join('\n');
    expect(readStatement(decomposed, { decompose: true })).toEqual({ sql: 'SELECT count(*) FROM orders', steps: 2 });
  });

  it('reads the last fence when the prompt asked for one and the model fenced each step anyway', () => {
    // The reconcile turn's shape: a line per group, then the statement. A model that fences every
    // group's statement would have its correction read off group one without this.
    expect(readStatement(twoStatements, { last: true }).sql).toBe('SELECT count(*) FROM orders');
    expect(readStatement(twoStatements, { last: true }).steps).toBe(0);
  });

  it('exposes the same last-block rule through extractSql', () => {
    expect(extractSql(twoStatements, { last: true })).toBe('SELECT count(*) FROM orders');
    expect(extractSql(twoStatements)).toBe('SELECT id FROM orders');
  });
});
