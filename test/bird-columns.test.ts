/**
 * What the column choice promises, pinned on the text it sends and the card it returns.
 *
 * The lever is one sentence — ask the model which columns the question needs, send those — and
 * every failure mode it has is a quiet one. A prompt that omits the comments asks the model to
 * guess from names alone and prices a different mechanism; a parser that counts a qualified name
 * twice inflates the choice; a parser that reads `items.name` and then also resolves the bare
 * `name` wherever it appears turns one named column into two; an applier that drops a join key
 * with the table it belongs to hands the model a card whose tables cannot be joined; and an
 * applier that keeps every column on an unreadable reply makes "the choice kept the whole card"
 * and "the choice was never made" the same number. Each of those is a case below.
 *
 * The registry cases pin the lever's claim to its parent: the arm must differ from
 * `inline+evidence` in `columnSelect` and in nothing else, or the delta prices two levers.
 */
import { describe, expect, it } from 'vitest';
import { applyColumnChoice, buildColumnPrompt, parseColumnChoice } from '../eval/bird/columns.js';
import type { ColumnChoice } from '../eval/bird/columns.js';
import { ARMS, DEFAULT_ARMS, ON_DEMAND_ARMS, assertColumnChoiceRan, columnChoiceFunnel, resolveArm } from '../eval/bird/run.js';
import type { CaseRun } from '../eval/bird/run.js';
import type { SchemaTable } from '@agentix-e/nl2charts-ai';

/**
 * A card with every shape the rule has to handle: a commented column, a column name that two
 * tables share (`name`), and a declared join whose two ends sit in different tables.
 */
const CARD: readonly SchemaTable[] = [
  {
    table: 'items',
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'name', type: 'text', comment: 'the label the store sells the item under' },
      { name: 'price', type: 'real' },
    ],
    foreignKeys: ['items.id = orders.item_id'],
  },
  {
    table: 'orders',
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'item_id', type: 'integer' },
      { name: 'qty', type: 'integer' },
    ],
    foreignKeys: ['orders.item_id = items.id'],
  },
  { table: 'cities', columns: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }] },
];

/** The total the applier reports, computed here so a wrong count cannot agree with itself. */
const CARD_COLUMNS = 8;

describe('the question a column choice asks', () => {
  it('lists every column with its table and type', () => {
    const prompt = buildColumnPrompt('How many orders are there?', CARD);
    expect(prompt).toContain('items.id integer');
    expect(prompt).toContain('orders.qty integer');
    expect(prompt).toContain('cities.name text');
    // One line per column: a column folded into another line is a column the model cannot name.
    expect(prompt.split('\n').filter((line) => /^(items|orders|cities)\./.test(line))).toHaveLength(CARD_COLUMNS);
  });

  it('carries the column comments, which are the knowledge the choice is made with', () => {
    const prompt = buildColumnPrompt('How many orders are there?', CARD);
    expect(prompt).toContain('items.name text -- the label the store sells the item under');
    // A column with no comment carries no separator, so a reader can tell "no description" from
    // "an empty description".
    expect(prompt).toContain('orders.qty integer\n');
    expect(prompt).not.toContain('orders.qty integer --');
  });

  it('asks the question it is answering, verbatim', () => {
    const prompt = buildColumnPrompt('How many orders are there for the pen?', CARD);
    expect(prompt).toContain('How many orders are there for the pen?');
  });

  it('says which names it will accept, because an invented name is a case the arm pays for', () => {
    const prompt = buildColumnPrompt('Anything', CARD);
    expect(prompt).toContain('`table.column`');
    expect(prompt).toContain('Name only columns from the list above');
  });
});

describe('reading a reply as a choice', () => {
  it('resolves qualified names in card order, not in reply order', () => {
    const choice = parseColumnChoice('cities.name\nitems.price', CARD);
    expect(choice.decided).toBe(true);
    expect(choice.named).toEqual([
      { table: 'items', column: 'price' },
      { table: 'cities', column: 'name' },
    ]);
  });

  it('resolves a bare name that only one table has', () => {
    const choice = parseColumnChoice('qty', CARD);
    expect(choice.named).toEqual([{ table: 'orders', column: 'qty' }]);
  });

  it('resolves an ambiguous bare name to every table that has it', () => {
    // The choice was ambiguous; two columns cost far less than one wrong one.
    const choice = parseColumnChoice('name', CARD);
    expect(choice.named).toEqual([
      { table: 'items', column: 'name' },
      { table: 'cities', column: 'name' },
    ]);
  });

  it('does not read a qualified name a second time as a bare one', () => {
    // `name` is on two tables. A parser that scanned the whole reply for bare names would turn
    // one named column into two, which is a card the model never asked for.
    const choice = parseColumnChoice('items.name', CARD);
    expect(choice.named).toEqual([{ table: 'items', column: 'name' }]);
  });

  it('counts a name once however often it is repeated', () => {
    const choice = parseColumnChoice('orders.qty, orders.qty\nqty', CARD);
    expect(choice.named).toEqual([{ table: 'orders', column: 'qty' }]);
  });

  it('ignores case', () => {
    const choice = parseColumnChoice('Orders.QTY', CARD);
    expect(choice.named).toEqual([{ table: 'orders', column: 'qty' }]);
  });

  it('reads through a code fence, which is how a model answers a list question', () => {
    const choice = parseColumnChoice('```text\nitems.price\n```', CARD);
    expect(choice.named).toEqual([{ table: 'items', column: 'price' }]);
  });

  it('keeps an invented name as its own fact instead of silently dropping it', () => {
    const choice = parseColumnChoice('items.price\nitems.discount', CARD);
    expect(choice.named).toEqual([{ table: 'items', column: 'price' }]);
    expect(choice.unknown).toEqual(['items.discount']);
    expect(choice.decided).toBe(true);
  });

  it('decides nothing when no name resolves', () => {
    const choice = parseColumnChoice('I need the revenue column.', CARD);
    expect(choice.decided).toBe(false);
    expect(choice.named).toEqual([]);
  });

  it('decides nothing on an empty reply', () => {
    expect(parseColumnChoice('', CARD).decided).toBe(false);
  });
});

describe('the card a choice produces', () => {
  it('returns the whole card when nothing resolved, and says it kept everything', () => {
    const choice: ColumnChoice = { named: [], unknown: ['x.y'], decided: false };
    const applied = applyColumnChoice(CARD, choice);
    expect(applied.schema).toEqual(CARD);
    expect(applied.kept).toBe(CARD_COLUMNS);
    expect(applied.total).toBe(CARD_COLUMNS);
  });

  it('keeps the chosen columns and drops a table that has none', () => {
    const applied = applyColumnChoice(CARD, parseColumnChoice('items.price', CARD));
    expect(applied.keptTables).toEqual(['items']);
    expect(applied.schema.map((table) => [table.table, table.columns.map((column) => column.name)])).toEqual([
      ['items', ['price']],
    ]);
    expect(applied.kept).toBe(1);
    expect(applied.total).toBe(CARD_COLUMNS);
  });

  it('keeps the keys of a join whose two ends both survived', () => {
    // Neither key was named, and without them the two selected tables cannot be joined — which is
    // the one thing the prompt explicitly asks the model to name.
    const applied = applyColumnChoice(CARD, parseColumnChoice('items.price\norders.qty', CARD));
    expect(applied.schema.map((table) => [table.table, table.columns.map((column) => column.name)])).toEqual([
      ['items', ['id', 'price']],
      ['orders', ['item_id', 'qty']],
    ]);
    expect(applied.kept).toBe(4);
  });

  it('does not keep a key whose partner table was dropped', () => {
    const applied = applyColumnChoice(CARD, parseColumnChoice('items.price\ncities.name', CARD));
    expect(applied.schema.map((table) => [table.table, table.columns.map((column) => column.name)])).toEqual([
      ['items', ['price']],
      ['cities', ['name']],
    ]);
  });

  it('keeps the card order, not the reply order', () => {
    const applied = applyColumnChoice(CARD, parseColumnChoice('cities.name\nitems.price', CARD));
    expect(applied.keptTables).toEqual(['items', 'cities']);
  });

  it('counts what it kept against what the arm would have sent', () => {
    const applied = applyColumnChoice(CARD, parseColumnChoice('orders.qty', CARD));
    expect(applied.kept).toBe(1);
    expect(applied.total).toBe(CARD_COLUMNS);
    expect(applied.schema.reduce((count, table) => count + table.columns.length, 0)).toBe(applied.kept);
  });

  it('ignores a join hint it cannot read, instead of failing the case', () => {
    // The hints come from a dataset file, so a malformed one is data rather than code: a hint
    // with no `=` and a hint with no qualified names both have to leave the choice intact.
    const malformed: readonly SchemaTable[] = [
      { table: 'items', columns: [{ name: 'id', type: 'integer' }, { name: 'price', type: 'real' }], foreignKeys: ['orders.qty', 'items = orders'] },
      { table: 'orders', columns: [{ name: 'item_id', type: 'integer' }] },
    ];
    const applied = applyColumnChoice(malformed, parseColumnChoice('items.price', malformed));
    expect(applied.schema.map((table) => [table.table, table.columns.map((column) => column.name)])).toEqual([['items', ['price']]]);
    expect(applied.kept).toBe(1);
  });
});

describe('the arm that makes the choice', () => {
  it('differs from its parent in columnSelect and in nothing else', () => {
    const parent = resolveArm('inline+evidence');
    const lever = resolveArm('inline+evidence+llm-select');
    expect(parent).toBeDefined();
    expect(lever).toBeDefined();
    const { columnSelect, name, ...rest } = lever as NonNullable<ReturnType<typeof resolveArm>>;
    const { name: parentName, ...parentRest } = parent as NonNullable<ReturnType<typeof resolveArm>>;
    expect(columnSelect).toBe(true);
    expect(name).toBe('inline+evidence+llm-select');
    expect(parentName).toBe('inline+evidence');
    // One lever: same evidence, same card, same call count before the choice, same repairs.
    expect(rest).toEqual(parentRest);
  });

  it('is dispatched rather than run on every push, with the reason stated', () => {
    expect(DEFAULT_ARMS).not.toContain('inline+evidence+llm-select');
    expect(ON_DEMAND_ARMS['inline+evidence+llm-select']).toBeDefined();
    expect(ON_DEMAND_ARMS['inline+evidence+llm-select']).toContain('model names');
  });

  it('is the only arm that cuts the card with a model call', () => {
    expect(ARMS.filter((arm) => arm.columnSelect === true).map((arm) => arm.name)).toEqual(['inline+evidence+llm-select']);
  });
});

/** A case record, as the run leaves it: only the fields the funnel reads matter here. */
function run(selection: CaseRun['columnSelection']): CaseRun {
  return {
    id: '1',
    passed: true,
    predicted: 'select 1',
    reason: 'match',
    strict: true,
    attempts: 1,
    calls: 2,
    ...(selection === undefined ? {} : { columnSelection: selection }),
  } as CaseRun;
}

describe('what the artifact says the choice kept', () => {
  it('reports nothing for an arm that makes no choice', () => {
    expect(columnChoiceFunnel([run(undefined)])).toBeUndefined();
  });

  it('counts the decided cases and the names it could not resolve', () => {
    const funnel = columnChoiceFunnel([
      run({ named: 2, unknown: 0, kept: 2, total: 8, decided: true }),
      run({ named: 0, unknown: 3, kept: 8, total: 8, decided: false }),
    ]);
    expect(funnel).toEqual({ cases: 2, decided: 1, decidedShare: 0.5, unknown: 3, cardShare: 0.625 });
  });

  it('takes the mean of the per-case shares, not the ratio of the sums', () => {
    // Databases differ tenfold in width. The ratio of the sums would let the wide one decide what
    // "the card shrank" means: 2 of 12 columns is 0.167, while the two cases are 0.1 and 0.5.
    const funnel = columnChoiceFunnel([
      run({ named: 1, unknown: 0, kept: 1, total: 10, decided: true }),
      run({ named: 1, unknown: 0, kept: 1, total: 2, decided: true }),
    ]);
    expect(funnel?.cardShare).toBe(0.3);
  });
});

describe('a choice that never removed a column is a bug, not a null result', () => {
  it('refuses a run where no case recorded a choice', () => {
    expect(() => assertColumnChoiceRan('inline+evidence+llm-select', [run(undefined)], 1)).toThrow(/no case recorded a column choice/);
  });

  it('refuses a run where every choice kept the whole card', () => {
    expect(() =>
      assertColumnChoiceRan('inline+evidence+llm-select', [run({ named: 0, unknown: 0, kept: 8, total: 8, decided: false })], 1),
    ).toThrow(/never removed a column/);
  });

  it('accepts a run where one case actually shrank', () => {
    expect(() =>
      assertColumnChoiceRan(
        'inline+evidence+llm-select',
        [run({ named: 1, unknown: 0, kept: 1, total: 8, decided: true }), run({ named: 0, unknown: 0, kept: 8, total: 8, decided: false })],
        1,
      ),
    ).not.toThrow();
  });

  it('stays silent below the sample size the other levers use', () => {
    // A six-question fixture licenses the shape of a run, not a claim that the lever fired.
    expect(() => assertColumnChoiceRan('inline+evidence+llm-select', [run(undefined)])).not.toThrow();
  });
});
