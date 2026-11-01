/**
 * The competitor's application rule, pinned on the one place it differs from ours.
 *
 * `applyColumnChoice` and `applyDenseChoice` read the same reply and disagree about a table the
 * model never named: the first deletes it, the second keeps its first six columns. Every case
 * below is a shape that difference turns into a different card — a table narrower than the floor
 * (where `drop_all` is a no-op and the two rules still disagree about existence), a table nine
 * columns wide with one name in the reply (where the pad loop has to run), a table with six
 * names (where it must not), a foreign key rendered under a table the choice abandoned, and a
 * reply that resolved nothing at all (where the two rules must agree, because the fallback is
 * about the link between reply and card rather than about the rule).
 *
 * The registry cases pin the pair to a single lever: `inline+evidence+llm-select` and
 * `inline+evidence+llm-select-dense` must differ in `columnSelect` and in nothing else, or the
 * delta prices the prompt as well as the rule.
 */
import { describe, expect, it } from 'vitest';
import { applyColumnChoice, parseColumnChoice } from '../eval/bird/columns.js';
import type { ColumnChoice } from '../eval/bird/columns.js';
import { DENSE_FLOOR, applyDenseChoice } from '../eval/bird/dense.js';
import { ARMS, ON_DEMAND_ARMS, PAIRS, columnChoiceFunnel, resolveArm } from '../eval/bird/run.js';
import type { CaseRun } from '../eval/bird/run.js';
import type { SchemaTable } from '@agentix-e/nl2charts-ai';

/**
 * Three tables at the three widths the rule treats differently: one below the floor, one above
 * it, and one below the floor that the model nonetheless names a single column of.
 */
const CARD: readonly SchemaTable[] = [
  {
    table: 'items',
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'name', type: 'text' },
      { name: 'price', type: 'real' },
    ],
    foreignKeys: ['items.id = order_items.item_id'],
  },
  {
    table: 'orders',
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'customer_id', type: 'integer' },
      { name: 'status', type: 'text' },
      { name: 'created_at', type: 'text' },
      { name: 'shipped_at', type: 'text' },
      { name: 'notes', type: 'text' },
      { name: 'discount', type: 'real' },
      { name: 'tax', type: 'real' },
      { name: 'total', type: 'real' },
    ],
    foreignKeys: ['orders.customer_id = customers.id'],
  },
  {
    table: 'customers',
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'name', type: 'text' },
      { name: 'email', type: 'text' },
    ],
  },
];

/** A reply that named `columns`, written the way the parser reads it. */
const choiceOf = (reply: string): ColumnChoice => parseColumnChoice(reply, CARD);

const NONE: ColumnChoice = { named: [], unknown: [], decided: false };

const names = (schema: readonly SchemaTable[], table: string): readonly string[] => {
  const found = schema.find((entry) => entry.table === table);
  return found === undefined ? [] : found.columns.map((column) => column.name);
};

describe('the floor', () => {
  it('is the six columns the competitor keeps, in one constant', () => {
    expect(DENSE_FLOOR).toBe(6);
  });
});

describe('a table the model named nothing in', () => {
  it('survives, cut to its first six columns when it is wider than that', () => {
    const applied = applyDenseChoice(CARD, choiceOf('customers.email'));
    expect(applied.keptTables).toEqual(['items', 'orders', 'customers']);
    expect(names(applied.schema, 'orders')).toEqual(['id', 'customer_id', 'status', 'created_at', 'shipped_at', 'notes']);
  });

  it('survives whole when it is narrower than the floor, because six of three is three', () => {
    const applied = applyDenseChoice(CARD, choiceOf('orders.total'));
    expect(names(applied.schema, 'items')).toEqual(['id', 'name', 'price']);
  });

  it('is what the column rule gets wrong: the same reply drops two tables there', () => {
    const reply = 'orders.total';
    const column = applyColumnChoice(CARD, choiceOf(reply));
    const dense = applyDenseChoice(CARD, choiceOf(reply));
    expect(column.keptTables).toEqual(['orders']);
    expect(dense.keptTables).toHaveLength(CARD.length);
  });
});

describe('a table the model named something in', () => {
  it('keeps the named column, its declared key, and pads back to the floor in declared order', () => {
    const applied = applyDenseChoice(CARD, choiceOf('orders.tax'));
    expect(names(applied.schema, 'orders')).toEqual(['id', 'customer_id', 'status', 'created_at', 'shipped_at', 'tax']);
  });

  it('does not pad when the choice already reached the floor', () => {
    const reply = ['orders.id', 'orders.status', 'orders.created_at', 'orders.shipped_at', 'orders.discount', 'orders.tax'].join('\n');
    const applied = applyDenseChoice(CARD, choiceOf(reply));
    expect(names(applied.schema, 'orders')).toEqual(['id', 'customer_id', 'status', 'created_at', 'shipped_at', 'discount', 'tax']);
  });

  it('never pads a table narrower than the floor, so a narrow table can still lose a column', () => {
    const applied = applyDenseChoice(CARD, choiceOf('customers.email'));
    expect(names(applied.schema, 'customers')).toEqual(['email']);
  });

  it('keeps a declared key the model did not name, because the join under it has to stay writable', () => {
    const applied = applyDenseChoice(CARD, choiceOf('orders.notes'));
    expect(names(applied.schema, 'orders')).toContain('customer_id');
  });

  it('ignores a foreign key whose left side belongs to another table', () => {
    const applied = applyDenseChoice(CARD, choiceOf('customers.email'));
    // `orders.customer_id = customers.id` names `id` only on the customers side, so a card that
    // named `customers.email` and nothing else keeps no key it did not have a reason to keep.
    expect(names(applied.schema, 'customers')).toEqual(['email']);
  });
});

describe('the numbers the artifact reports', () => {
  it('counts the columns the floor put back, not the columns the model named', () => {
    const choice = choiceOf('orders.tax');
    const applied = applyDenseChoice(CARD, choice);
    expect(choice.named).toHaveLength(1);
    expect(applied.kept).toBe(3 + 6 + 3);
    expect(applied.total).toBe(15);
    expect(applied.restored).toBe(applied.kept - 1);
  });

  it('reports zero restored when the choice resolved nothing, and sends the whole card', () => {
    const applied = applyDenseChoice(CARD, NONE);
    expect(applied.schema).toBe(CARD);
    expect(applied.kept).toBe(applied.total);
    expect(applied.restored).toBe(0);
    expect(applied.keptTables).toEqual(['items', 'orders', 'customers']);
  });
});

describe('a malformed join hint', () => {
  it('is skipped rather than thrown on, at every shape a hint can take', () => {
    const broken: readonly SchemaTable[] = [
      {
        table: 'orders',
        columns: [
          { name: 'id', type: 'integer' },
          { name: 'label', type: 'text' },
        ],
        foreignKeys: ['orders.id', 'orders', ' = ', 'orders.id = customers', 'orders.id = customers.id'],
      },
    ];
    const choice: ColumnChoice = { named: [{ table: 'orders', column: 'label' }], unknown: [], decided: true };
    const applied = applyDenseChoice(broken, choice);
    // The only hint with two dotted sides is the last one, and its left side is this table's.
    expect(applied.schema[0]?.columns.map((column) => column.name)).toEqual(['id', 'label']);
  });
});

describe('the pair is one lever', () => {
  const armOf = (name: string): NonNullable<ReturnType<typeof resolveArm>> => {
    const arm = resolveArm(name);
    if (arm === undefined) throw new Error(`arm ${name} is not registered`);
    return arm;
  };

  const fieldDiff = (left: string, right: string): string[] => {
    const a = armOf(left);
    const b = armOf(right);
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].filter((key) => key !== 'name' && JSON.stringify(a[key as keyof typeof a]) !== JSON.stringify(b[key as keyof typeof b]));
  };

  it('differs in the application rule only', () => {
    expect(fieldDiff('inline+evidence+llm-select', 'inline+evidence+llm-select-dense')).toEqual(['columnSelect']);
  });

  it('declares the pair, so the delta is reported as one lever rather than reconstructed', () => {
    expect(PAIRS).toContainEqual(['inline+evidence+llm-select', 'inline+evidence+llm-select-dense']);
  });

  it('is registered as an on-demand arm with a note that names its prediction', () => {
    expect(ARMS.map((arm) => arm.name)).toContain('inline+evidence+llm-select-dense');
    expect(ON_DEMAND_ARMS['inline+evidence+llm-select-dense']).toMatch(/question rather than the verdict/u);
  });
});

describe('the funnel', () => {
  const runOf = (restored: number | undefined): CaseRun =>
    ({
      id: 1,
      columnSelection: {
        named: 1,
        unknown: 0,
        kept: 3,
        total: 4,
        decided: true,
        ...(restored === undefined ? {} : { restored }),
      },
    }) as unknown as CaseRun;

  it('reads a card with no columns as an unshrunk card, not as a division by zero', () => {
    const empty = { columnSelection: { named: 0, unknown: 0, kept: 0, total: 0, decided: false } } as unknown as CaseRun;
    expect(columnChoiceFunnel([empty])?.cardShare).toBe(1);
  });

  it('reports the safety net only for an arm that has one', () => {
    const dense = columnChoiceFunnel([runOf(2), runOf(3)]);
    expect(dense?.restored).toBe(5);
    const column = columnChoiceFunnel([runOf(undefined)]);
    expect(column !== undefined && 'restored' in column).toBe(false);
  });
});
