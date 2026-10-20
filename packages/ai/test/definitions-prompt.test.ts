import { describe, expect, it } from 'vitest';
import { buildDefinitionPrompt, parseDefinitions } from '../src/definitions.js';
import type { SchemaTable } from '../src/linking.js';

/**
 * Offline definition writing: one model call per database, cached, then injected
 * as text. Two properties matter and are pinned here.
 *
 * 1. The request must carry only facts about *this* database — schema, profile,
 *    sampled rows — so a definition cannot come from the model's memory of a
 *    similarly named public dataset.
 * 2. The reply must be reduced to lines the prompt can use. A model that answers
 *    with a fenced block, a preamble, or 40 lines of prose must not corrupt the
 *    prompt or blow the budget.
 */
const schema: readonly SchemaTable[] = [
  {
    table: 'orders',
    columns: [
      { name: 'order_id', type: 'BIGINT' },
      { name: 'customer_id', type: 'BIGINT' },
      { name: 'status', type: 'TEXT' },
      { name: 'total_amount', type: 'DOUBLE' },
    ],
    foreignKeys: ['orders.customer_id = customers.customer_id'],
  },
  {
    table: 'customers',
    columns: [
      { name: 'customer_id', type: 'BIGINT' },
      { name: 'segment', type: 'TEXT' },
    ],
  },
];

const profile = {
  db: 'shop',
  columns: [
    { table: 'orders', column: 'status', kind: 'categorical' as const, values: ['completed', 'refunded'], distinct: 2 },
    { table: 'orders', column: 'total_amount', kind: 'numeric' as const, min: 0, max: 999 },
  ],
};

const samples = [
  { table: 'orders', rows: [['1', '7', 'completed', '42.5']] },
  { table: 'customers', rows: [['7', 'enterprise']] },
];

describe('definition request', () => {
  it('names every table and column so the answer is about this database', () => {
    const prompt = buildDefinitionPrompt({ schema, profile, samples });
    for (const table of schema) {
      expect(prompt).toContain(table.table);
      for (const column of table.columns) expect(prompt).toContain(column.name);
    }
    expect(prompt).toContain('orders.customer_id = customers.customer_id');
  });

  it('includes observed values and sample rows only when given', () => {
    const withData = buildDefinitionPrompt({ schema, profile, samples });
    expect(withData).toContain('completed');
    expect(withData).toContain('42.5');
    const bare = buildDefinitionPrompt({ schema });
    expect(bare).not.toContain('42.5');
    expect(bare).not.toContain('Data profile');
  });

  it('asks for the business rule, not a description of the type', () => {
    const prompt = buildDefinitionPrompt({ schema });
    expect(prompt).toContain('does not restate the column type');
    expect(prompt).toContain('one line per definition');
    expect(prompt).toContain('If the database does not support a definition, omit it.');
  });

  it('states the output budget it wants respected', () => {
    expect(buildDefinitionPrompt({ schema, maxChars: 200 })).toContain('at most 200 characters');
  });

  it('escapes a table name that would break the schema line', () => {
    const odd: SchemaTable[] = [{ table: 'a b', columns: [{ name: 'c d', type: 'TEXT' }] }];
    expect(buildDefinitionPrompt({ schema: odd })).toContain('"a b"');
  });
});

describe('definition reply', () => {
  it('keeps definition lines and drops the preamble', () => {
    const reply = 'Here are the definitions you asked for:\n- revenue = total_amount of completed orders.\n- one order per row.';
    expect(parseDefinitions(reply)).toBe('- revenue = total_amount of completed orders.\n- one order per row.');
  });

  it('unwraps a fenced block', () => {
    expect(parseDefinitions('```text\n- a = b.\n```')).toBe('- a = b.');
  });

  it('drops a heading the model added itself', () => {
    expect(parseDefinitions('Semantics:\n- a = b.')).toBe('- a = b.');
  });

  it('cuts on a line boundary at the budget', () => {
    const reply = ['- first definition is short.', '- second definition is also short.', '- third one is longer than the rest.'].join('\n');
    const kept = parseDefinitions(reply, 70);
    expect(kept.split('\n')).toHaveLength(2);
    expect(kept.length).toBeLessThanOrEqual(70);
  });

  it('returns nothing when the model declines instead of inventing', () => {
    expect(parseDefinitions('')).toBe('');
    expect(parseDefinitions('I cannot determine definitions from this schema.')).toBe('');
    expect(parseDefinitions('```\n```')).toBe('');
  });

  it('normalises bullet styles to one list', () => {
    expect(parseDefinitions('* a = b\n• c = d\n- e = f')).toBe('- a = b\n- c = d\n- e = f');
  });
});
