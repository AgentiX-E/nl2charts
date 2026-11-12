/**
 * Three rows per table, which is the one input in RSL-SQL's prompt this repository never had.
 *
 * A column sample shows a value's domain. Three rows show which values occur together —
 * `status='Banned'` on the same line as `currency='EUR'` — and that pairing is the whole reason
 * the block exists. Everything here is about the two ways the block can go wrong: spending
 * characters it cannot pay for, and showing a value that is not a value.
 */
import { describe, expect, it } from 'vitest';
import { renderRowSamples, sampleableColumns } from '../eval/bird/row-samples.js';
import type { RowSampleTable } from '../eval/bird/row-samples.js';

const items: RowSampleTable = {
  table: 'items',
  columns: [
    { name: 'id', type: 'integer' },
    { name: 'name', type: 'text' },
    { name: 'price', type: 'real' },
    { name: 'status', type: 'text' },
  ],
};

/** A reader that answers from a fixed table of rows, keyed on the column names it was asked for. */
function reader(data: Record<string, readonly (readonly unknown[])[]>): (table: string, columns: readonly string[]) => readonly (readonly unknown[])[] {
  return (table) => data[table] ?? [];
}

describe('which columns a row sample may show', () => {
  it('keeps the text columns and drops the numbers', () => {
    // A number in the block costs characters and says nothing a column name does not: `price` is
    // already typed `real` on the card. A string is the only thing that can be a literal the
    // question names.
    expect(sampleableColumns(items).map((column) => column.name)).toEqual(['name', 'status']);
  });

  it('treats the date types as text, because they are stored as one', () => {
    const dated: RowSampleTable = {
      table: 'events',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'on', type: 'date' },
        { name: 'at', type: 'datetime' },
        { name: 'label', type: 'VARCHAR' },
      ],
    };
    expect(sampleableColumns(dated).map((column) => column.name)).toEqual(['on', 'at', 'label']);
  });

  it('returns nothing for a table of numbers', () => {
    const numeric: RowSampleTable = { table: 'counts', columns: [{ name: 'n', type: 'integer' }] };
    expect(sampleableColumns(numeric)).toEqual([]);
  });
});

describe('rendering the block', () => {
  it('shows three rows, column by column', () => {
    const text = renderRowSamples([items], reader({ items: [['pen', 'active'], ['cup', 'banned'], ['pen', null]] }));
    expect(text).toBe('items: name=pen, status=active | name=cup, status=banned | name=pen');
  });

  it('asks the reader for the sampleable columns and nothing else', () => {
    const asked: string[][] = [];
    renderRowSamples([items], (_table, columns) => {
      asked.push([...columns]);
      return [['pen', 'active']];
    });
    expect(asked).toEqual([['name', 'status']]);
  });

  it('drops a NULL rather than printing one', () => {
    // `status=NULL` is three characters that describe the storage, not the data. A row that is
    // entirely NULL disappears instead of becoming an empty line.
    const text = renderRowSamples([items], reader({ items: [[null, null], ['pen', null]] }));
    expect(text).toBe('items: name=pen');
  });

  it('collapses the whitespace inside a stored value', () => {
    // A cell with a newline would break the one-line-per-table shape and turn a sample into a
    // schema.
    const text = renderRowSamples([items], reader({ items: [['two\nwords  here', 'a']] }));
    expect(text).toBe('items: name=two words here, status=a');
  });

  it('cuts a value that is longer than the budget for one value', () => {
    const long = 'x'.repeat(80);
    const text = renderRowSamples([items], reader({ items: [[long, 'a']] }), { maxValue: 10 });
    expect(text).toBe('items: name=xxxxxxxxxx, status=a');
  });

  it('returns nothing when no table has a text column', () => {
    const numeric: RowSampleTable = { table: 'counts', columns: [{ name: 'n', type: 'integer' }] };
    expect(renderRowSamples([numeric], reader({ counts: [[1], [2]] }))).toBe('');
  });

  it('returns nothing when the tables are empty', () => {
    expect(renderRowSamples([items], reader({}))).toBe('');
  });
});

describe('the budget', () => {
  const wide: RowSampleTable = {
    table: 'wide',
    columns: [
      { name: 'a', type: 'text' },
      { name: 'b', type: 'text' },
    ],
  };

  it('drops whole tables from the end rather than cutting one in half', () => {
    // Half a table is worse than no table: the model cannot tell a truncated sample from a table
    // that stores one row, and the second reading is a claim about the data.
    const text = renderRowSamples([items, wide], reader({ items: [['pen', 'a']], wide: [['x', 'y']] }), { budget: 30 });
    expect(text).toBe('items: name=pen, status=a');
  });

  it('keeps both tables when the budget exactly covers them', () => {
    // 25 + 1 newline + 14 = 40, which is the budget: the rule is "fits", not "fits with room".
    const text = renderRowSamples([items, wide], reader({ items: [['pen', 'a']], wide: [['x', 'y']] }), { budget: 40 });
    expect(text.split('\n')).toHaveLength(2);
  });

  it('keeps the first row of a single table that is too wide even for itself', () => {
    // The alternative is an empty block on exactly the widest tables, which are the ones whose
    // rows the model can least infer.
    const text = renderRowSamples([items], reader({ items: [['pen', 'a'], ['cup', 'b']] }), { budget: 5 });
    expect(text).toBe('items: name=pen, status=a');
  });

  it('keeps every table when the budget is generous', () => {
    const text = renderRowSamples([items, wide], reader({ items: [['pen', 'a']], wide: [['x', 'y']] }), { budget: 10_000 });
    expect(text.split('\n')).toHaveLength(2);
  });
});

describe('determinism', () => {
  it('renders the same text for the same rows', () => {
    // The block is cached per database and compared across runs; a render that depended on
    // iteration order would make two identical runs different prompts.
    const data = { items: [['pen', 'active'], ['cup', null]] };
    expect(renderRowSamples([items], reader(data))).toBe(renderRowSamples([items], reader(data)));
  });
});

describe('the values this renderer refuses to invent', () => {
  it('drops an undefined as well as a NULL', () => {
    // A driver that returns a shorter tuple than it was asked for hands back `undefined`, and a
    // renderer that printed it would put the word in the prompt as if the column stored it.
    const text = renderRowSamples([items], reader({ items: [[undefined, 'a']] }));
    expect(text).toBe('items: status=a');
  });

  it('returns nothing when the only row it can afford is empty', () => {
    // Budget 0 falls all the way through: no table fits, so the last resort is the first row of the
    // first table — and that row stores nothing. An empty block is the only honest answer.
    const text = renderRowSamples([items], reader({ items: [[null, null]] }), { budget: 0 });
    expect(text).toBe('');
  });

  it('returns nothing when the first row it can afford has no printable value', () => {
    const text = renderRowSamples([items], reader({ items: [['', '  ']] }), { budget: 0 });
    expect(text).toBe('');
  });
});
