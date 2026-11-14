import { describe, expect, it } from 'vitest';
import { buildAskMessages } from '@agentix-e/nl2charts-ai';
import type { SchemaTable } from '@agentix-e/nl2charts-ai';
import { BLOCK_RULES, blockColumns, linkBlockColumns } from '../eval/bird/block-columns.js';
import { attachSamples, narrowSamples } from '../eval/bird/samples.js';

/**
 * Which columns carry stored values — the half of the block's price that is a set rather than a rule.
 *
 * `samples-wide` showed every profiled column and bought +2.02pp for +74.9% of the prompt, so the
 * question this file is about is not "are the values useful" but "how few columns can carry them".
 * Two rules answer it: the gold's filtered columns, which is an oracle and bounds the family, and the
 * prompt's own hint, which is the one a product can run. Both are pinned here, and the second is
 * pinned *against the prompt* rather than against a copy of the list: a rule that agreed with a
 * hand-written expectation while disagreeing with the hint would price a block on columns the model
 * was never pointed at.
 */

const schema: readonly SchemaTable[] = [
  {
    table: 'orders',
    columns: [
      { name: 'id', type: 'INTEGER' },
      { name: 'status', type: 'TEXT' },
      { name: 'customer_id', type: 'INTEGER' },
      { name: 'total', type: 'REAL' },
    ],
    foreignKeys: ['orders.customer_id = customers.id'],
  },
  {
    table: 'customers',
    columns: [
      { name: 'id', type: 'INTEGER' },
      { name: 'country', type: 'TEXT' },
      { name: 'segment', type: 'TEXT' },
    ],
  },
];

/** What the prompt builder renders as the hint, read back out of the message it sends. */
function hintOf(question: string, card: readonly SchemaTable[] = schema): string[] {
  const built = buildAskMessages({ question, schema: card, prompt: {}, linking: true });
  const first = built.messages[1].content.split('\n')[0] ?? '';
  if (!first.startsWith('Likely columns: ')) return [];
  return first
    .slice('Likely columns: '.length)
    .split(', ')
    .map((name) => name.trim());
}

describe('the columns the prompt already names', () => {
  it('reads the hint, so the block sits on columns the model was pointed at', () => {
    const question = 'the count of orders by status';
    expect(hintOf(question)).toContain('orders.status');
    expect(linkBlockColumns(question, schema)).toEqual(hintOf(question));
  });

  it('agrees with the prompt on a question that names more columns than the cap', () => {
    // The cap is the one thing the two call sites could disagree about: the builder passes its own
    // `topK`, the rule passes none. A question whose every column matches pins the default.
    const question = 'orders id status customer id total customers country segment';
    const hint = hintOf(question);
    expect(hint.length).toBeGreaterThan(3);
    expect(linkBlockColumns(question, schema)).toEqual(hint);
  });

  it('names nothing when the hint names nothing, and does not widen to the card', () => {
    // The empty answer is the arm's honest behaviour: a block on no column is the parent's card, and
    // widening to every profiled column would be `samples-wide` reporting under another name.
    expect(hintOf('How many rows are there')).toEqual([]);
    expect(linkBlockColumns('How many rows are there', schema)).toEqual([]);
  });

  it('keeps the hint order and drops a column only once', () => {
    const columns = linkBlockColumns('status of the orders by status', schema);
    expect(new Set(columns).size).toBe(columns.length);
    expect(columns).toEqual(hintOf('status of the orders by status'));
  });

  it('reads the card it is given, so a pruned card narrows the block with it', () => {
    const ordersOnly = schema.filter((table) => table.table === 'orders');
    const question = 'the country of each customer and the status of their orders';
    expect(linkBlockColumns(question, schema)).toContain('customers.country');
    expect(linkBlockColumns(question, ordersOnly)).not.toContain('customers.country');
  });

  it('names columns that the schema actually has, in its own spelling', () => {
    // The narrowed set is used to look up a profile key, so a name the schema does not spell that way
    // is a column that silently carries no values — a block that shrank without saying so.
    const known = new Set(schema.flatMap((table) => table.columns.map((column) => `${table.table}.${column.name}`)));
    for (const name of linkBlockColumns('status country segment of the orders and customers', schema)) {
      expect(known.has(name)).toBe(true);
    }
  });
});

describe('the card the hint is read on', () => {
  const values = new Map<string, readonly string[]>([
    ['orders.status', ['Banned', 'Active', 'Shipped']],
    ['orders.total', ['9.5', '12']],
    ['customers.country', ['US', 'CN']],
    ['customers.segment', ['SME', 'Enterprise']],
  ]);

  it('names the column a stored value lives in, which the bare card cannot', () => {
    // The linker's third recaller matches a question word against a value in the column. Without the
    // overlay it names nothing for this question, and the block would be missing from exactly the
    // column a literal is filtered on — the case the block exists for.
    const question = 'how many customers are in the US';
    const bare = blockColumns({ rule: 'link', question, sql: '', schema, values: undefined });
    expect(bare).not.toContain('customers.country');
    const overlay = blockColumns({ rule: 'link', question, sql: '', schema, values });
    expect(overlay).toContain('customers.country');
  });

  it('matches the hint the prompt renders on the same card', () => {
    // Parity is the whole claim: the block sits on columns the prompt points at. The prompt links the
    // card with the values attached, which is what `blockColumns` is given here.
    const question = 'the total of orders whose status is Banned, by country';
    const card = attachSamples(schema, values);
    expect(blockColumns({ rule: 'link', question, sql: '', schema, values })).toEqual(hintOf(question, card));
  });

  it('is unaffected on the oracle rule, which reads the statement and not the card', () => {
    const filtered = "select count(*) from orders where status = 'Banned'";
    expect(blockColumns({ rule: 'gold', question: 'in the US', sql: filtered, schema, values })).toEqual(['status']);
  });
});

describe('the two rules', () => {
  const filtered = "SELECT count(*) FROM orders WHERE status = 'Banned' AND total > 10";

  it('reads the statement on the oracle rule and the question on the runnable one', () => {
    const gold = blockColumns({ rule: 'gold', question: 'how many orders are banned', sql: filtered, schema, values: undefined });
    expect(gold).toEqual(['status', 'total']);
    const link = blockColumns({ rule: 'link', question: 'how many orders are banned', sql: filtered, schema, values: undefined });
    // The literal names no column in this schema, so the runnable rule has only the hint's columns —
    // and it never sees `total`, because the statement is not its input.
    expect(link).toEqual(linkBlockColumns('how many orders are banned', schema));
    expect(link).not.toContain('total');
  });

  it('is a function of the case and not of a fitted list', () => {
    const input = { rule: 'link' as const, question: 'status of orders', sql: '', schema, values: undefined };
    expect(blockColumns(input)).toEqual(blockColumns({ ...input }));
    // Two questions with the same schema and different words get different sets, which is what a
    // per-database allow-list could not do.
    expect(blockColumns({ ...input, question: 'country of customers' })).not.toEqual(blockColumns(input));
  });

  it('states both rules and no third', () => {
    expect(BLOCK_RULES).toEqual(['gold', 'link']);
  });
});

describe('what the narrowed block costs', () => {
  const values = new Map<string, readonly string[]>([
    ['orders.id', ['1', '2', '3']],
    ['orders.status', ['Banned', 'Active', 'Shipped']],
    ['orders.customer_id', ['1', '2']],
    ['orders.total', ['9.5', '12']],
    ['customers.id', ['1', '2']],
    ['customers.country', ['US', 'CN']],
    ['customers.segment', ['SME', 'Enterprise']],
  ]);

  it('keeps the block on the hint columns and drops every other bracket', () => {
    const wanted = blockColumns({ rule: 'link', question: 'the count of orders by status', sql: '', schema, values: undefined });
    const narrowed = narrowSamples(values, wanted);
    expect([...narrowed.keys()]).toEqual(['orders.status']);
    // Seven profiled columns become one: the price of the block is the count, not the bracket.
    expect(narrowed.size).toBeLessThan(values.size);
  });

  it('keeps nothing when the hint names nothing, which is the parent card', () => {
    const wanted = blockColumns({ rule: 'link', question: 'How many rows are there', sql: '', schema, values: undefined });
    expect(narrowSamples(values, wanted).size).toBe(0);
  });

  it('matches a bare gold identifier against every table that has the name', () => {
    // The oracle rule names identifiers without a table, and narrowing must not turn an ambiguity in
    // the text into a missing block: both `id` columns carry values.
    const wanted = blockColumns({ rule: 'gold', question: '', sql: 'select 1 from orders where id = 3', schema, values: undefined });
    const narrowed = narrowSamples(values, wanted);
    expect([...narrowed.keys()].sort()).toEqual(['customers.id', 'orders.id']);
  });
});
