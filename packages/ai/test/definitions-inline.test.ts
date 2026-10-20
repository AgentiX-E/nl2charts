import { describe, expect, it } from 'vitest';
import { attachDefinitions } from '../src/definitions.js';
import type { SchemaTable } from '../src/linking.js';

/**
 * Placement, isolated from content.
 *
 * The benchmark's own column descriptions are attached to the column line; the
 * blocks this project tried were appended after the schema card. If placement
 * explains the difference, moving the same sentences onto the columns should
 * reproduce it. This function does the moving, and it must never invent a column
 * or silently drop a definition it cannot place.
 */
const schema: readonly SchemaTable[] = [
  {
    table: 'orders',
    columns: [
      { name: 'order_id', type: 'BIGINT' },
      { name: 'status', type: 'TEXT' },
      { name: 'total_amount', type: 'DOUBLE', comment: 'existing' },
    ],
  },
  { table: 'customers', columns: [{ name: 'customer_id', type: 'BIGINT' }] },
];

describe('attaching definitions to columns', () => {
  it('attaches a dotted line to the column it names', () => {
    const result = attachDefinitions(schema, '- orders.status: completed means paid and shipped.');
    expect(result.attached).toBe(1);
    expect(result.schema[0]?.columns[1]?.comment).toBe('completed means paid and shipped.');
  });

  it('keeps an existing comment and appends the definition', () => {
    const result = attachDefinitions(schema, '- orders.total_amount: charged amount, tax included.');
    expect(result.schema[0]?.columns[2]?.comment).toBe('existing; charged amount, tax included.');
  });

  it('matches a quoted column label from a dictionary-style reply', () => {
    const result = attachDefinitions(schema, '- "status" is the state of the order.');
    expect(result.attached).toBe(1);
    expect(result.schema[0]?.columns[1]?.comment).toBe('the state of the order.');
  });

  it('drops a line that names no column instead of guessing one', () => {
    const result = attachDefinitions(schema, '- revenue excludes refunded orders.');
    expect(result.attached).toBe(0);
    expect(result.unplaced).toEqual(['revenue excludes refunded orders.']);
    expect(result.schema).toBe(schema);
  });

  it('is case insensitive about the table and column', () => {
    const result = attachDefinitions(schema, '- ORDERS.Status = paid means shipped.');
    expect(result.attached).toBe(1);
  });

  it('does not mutate the input schema', () => {
    const before = JSON.stringify(schema);
    attachDefinitions(schema, '- orders.status: paid.');
    expect(JSON.stringify(schema)).toBe(before);
  });

  it('handles an empty block and a blank line', () => {
    expect(attachDefinitions(schema, '').attached).toBe(0);
    expect(attachDefinitions(schema, '\n  \n').schema).toBe(schema);
  });

  it('ignores a line whose column exists in a different table', () => {
    const result = attachDefinitions(schema, '- customers.status: paid.');
    expect(result.attached).toBe(0);
    expect(result.unplaced).toHaveLength(1);
  });
});
