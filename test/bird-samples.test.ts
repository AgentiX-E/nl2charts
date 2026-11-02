import { describe, expect, it } from 'vitest';
import type { DatabaseProfile, SchemaTable } from '@agentix-e/nl2charts-ai';
import { attachSamples, narrowSamples, sampleValuesOf } from '../eval/bird/samples.js';

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

/**
 * Which columns a narrowed block is allowed to show.
 *
 * The block measured +38.4% characters per case when every profiled column carried one, and
 * +1.4% when only the columns the gold statement filters on do — so the rule that decides the
 * set is the whole difference between a block that can be afforded and one that cannot. It is
 * a filter over the profile rather than a second sampler: the values, their order and the
 * renderer stay the arm's, and only the set of columns changes.
 */
describe('narrowSamples', () => {
  const values = sampleValuesOf(profile);

  it('keeps a column the statement qualifies', () => {
    // Qualified names are how the schema is keyed and how a normalized statement writes them,
    // so a match here is exact.
    const narrowed = narrowSamples(values, ['customers.country']);
    expect([...narrowed.keys()]).toEqual(['customers.country']);
  });

  it('keeps every column of that name when the statement does not qualify it', () => {
    // `where id = 3` on a database where two tables have an `id` is ambiguous in the statement
    // and unambiguous in the profile: the narrowing cannot resolve which table the writer meant,
    // and dropping both would turn an ambiguity into a missing block.
    const twoIds = new Map([
      ['orders.id', ['1', '2']],
      ['customers.id', ['3', '4']],
      ['orders.status', ['Banned', 'Active']],
    ]);
    expect([...narrowSamples(twoIds, ['id']).keys()]).toEqual(['orders.id', 'customers.id']);
  });

  it('is case-insensitive in both directions', () => {
    // BIRD's gold writes `WHERE`, the schema keeps `County Code`, and the profile keys them
    // as they are stored; a case-sensitive filter would find nothing and the arm would look
    // like a rule that selects no columns.
    expect([...narrowSamples(new Map([['Customers.Country', ['US']]]), ['customers.country']).keys()]).toEqual([
      'Customers.Country',
    ]);
  });

  it('keeps nothing when the statement names no column it can show', () => {
    // `select count(*) from items` filters on nothing, and a literal that looks like a column
    // name is not an identifier. Both produce an empty block, which is the parent's card — and
    // the arm counts those cases rather than pretending the lever fired.
    expect(narrowSamples(values, []).size).toBe(0);
    expect(narrowSamples(values, ['nowhere']).size).toBe(0);
  });

  it('does not mutate the map it is given', () => {
    // The same map is handed to every case of the arm; a delete would narrow the second case
    // with the first case's statement, and the arm would measure its own order.
    const narrowed = narrowSamples(values, ['orders.status']);
    expect(narrowed.size).toBe(1);
    expect(values.size).toBe(2);
    // The values themselves are shared, not copied: the narrowing is about which columns are
    // shown, and reordering the bracket here would be a second, unmeasured lever.
    expect(narrowed.get('orders.status')).toBe(values.get('orders.status'));
  });
});
