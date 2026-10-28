import { describe, expect, it } from 'vitest';
import type { DatabaseProfile, SchemaTable } from '@agentix-e/nl2charts-ai';
import { attachSamples, sampleValuesOf } from '../eval/bird/samples.js';

/**
 * The card-level half of value grounding.
 *
 * `values` builds a separate block from the question's own literals, so it says nothing
 * exactly when the question spells a value differently from the store. This shows the
 * stored spellings unconditionally, which is the half that was never measured — and the
 * two functions here are the whole mechanism, so they are pinned rather than eyeballed.
 */

const profile: DatabaseProfile = {
  db: 'shop',
  columns: [
    { table: 'orders', column: 'status', kind: 'categorical', values: ['Banned', 'Active'] },
    // A profile entry with no values is a column whose spellings are unbounded, and it must
    // not become an empty sample list: the renderer tests `length > 0` to decide whether to
    // print the bracket at all.
    { table: 'orders', column: 'note', kind: 'categorical', distinct: 900 },
    { table: 'customers', column: 'country', kind: 'categorical', values: ['US', 'CN'] },
    // An identifier column the profiler kept as numeric: no values, no bracket.
    { table: 'customers', column: 'id', kind: 'numeric', min: 1, max: 25 },
  ],
};

const schema: readonly SchemaTable[] = [
  {
    table: 'orders',
    columns: [
      { name: 'id', type: 'INTEGER' },
      { name: 'status', type: 'TEXT', comment: 'order state' },
      { name: 'note', type: 'TEXT' },
    ],
    foreignKeys: ['orders.id = customers.id'],
  },
  { table: 'customers', columns: [{ name: 'country', type: 'TEXT' }, { name: 'id', type: 'INTEGER' }] },
];

describe('sampleValuesOf', () => {
  it('keys values by qualified column and keeps the profile order', () => {
    const values = sampleValuesOf(profile);
    expect([...values.keys()]).toEqual(['orders.status', 'customers.country']);
    // Frequency order is the profiler's ranking, and reordering it here would spend the
    // bracket on the least informative spelling.
    expect(values.get('orders.status')).toEqual(['Banned', 'Active']);
  });

  it('omits columns whose value set is unbounded', () => {
    // `orders.note` has 900 distinct values and no `values` list. An entry with an empty
    // array would render `note TEXT []`, which reads as "this column is empty".
    expect(sampleValuesOf(profile).has('orders.note')).toBe(false);
  });
});

describe('attachSamples', () => {
  it('attaches values only where the profile has them', () => {
    const decorated = attachSamples(schema, sampleValuesOf(profile));
    const orders = decorated.find((table) => table.table === 'orders') as SchemaTable;
    expect(orders.columns.find((column) => column.name === 'status')?.samples).toEqual(['Banned', 'Active']);
    expect(orders.columns.find((column) => column.name === 'note')?.samples).toBeUndefined();
    expect(orders.columns.find((column) => column.name === 'id')?.samples).toBeUndefined();
  });

  it('leaves every other property of the card in place', () => {
    // The decorator is layered on an arm's own schema, which may already carry comments
    // from the inline definitions or join hints. Dropping one here would be a second,
    // unmeasured lever.
    const decorated = attachSamples(schema, sampleValuesOf(profile));
    const orders = decorated.find((table) => table.table === 'orders') as SchemaTable;
    expect(orders.columns.find((column) => column.name === 'status')?.comment).toBe('order state');
    expect(orders.foreignKeys).toEqual(['orders.id = customers.id']);
  });

  it('does not mutate the schema it is given', () => {
    // The same object is handed to two arms; a mutation would leak samples into the parent
    // and erase the comparison the arm exists to make.
    const before = JSON.stringify(schema);
    attachSamples(schema, sampleValuesOf(profile));
    expect(JSON.stringify(schema)).toBe(before);
  });

  it('returns the schema unchanged when no values are known', () => {
    const decorated = attachSamples(schema, new Map());
    expect(decorated).toEqual(schema);
  });
});
