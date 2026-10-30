/**
 * What the prune rule promises, pinned on the card it produces.
 *
 * The lever is one sentence — send the tables within a join of the ones the question names —
 * and its failure modes are all quiet ones. A rule that keeps a table order of its own changes
 * the prompt for a reason that has nothing to do with the lever; a rule that seeds itself from
 * a different recaller set changes the `Likely columns` hint as well, which would price two
 * levers against one parent; a rule that prunes a question the linker could not see sends a card
 * with no schema in it at all. Each of those is a case below.
 *
 * The end-to-end case renders the prompt with the same builder the pipeline sends, so what is
 * asserted is the text a model would read rather than a schema object that looks right.
 */
import { describe, expect, it } from 'vitest';
import { graphForDatabase, graphOf, joinGraphOf } from '../eval/bird/join-graph.js';
import { promptForCase } from '../eval/bird/information.js';
import { CANDIDATE_RECALLERS, SHIPPED_RECALLERS, linkedTables, pruneSchema } from '../eval/bird/prune.js';
import { promptOf } from '../eval/bird/card.js';
import { resolveArm } from '../eval/bird/run.js';
import type { Arm } from '../eval/bird/run.js';
import type { BirdQuestion, BirdTable } from '../eval/bird/data.js';
import type { SchemaTable } from '@agentix-e/nl2charts-ai';

/** A manifest built from column indices, which is the only shape the graph reads. */
function manifest(input: {
  tables: string[];
  columns: [number, string][];
  fks?: [number, number][];
}): BirdTable {
  return {
    db_id: 'db',
    tableNames: input.tables,
    tableNamesReadable: input.tables,
    columnNames: input.columns,
    columnNamesReadable: input.columns,
    columnTypes: input.columns.map(() => 'text'),
    foreignKeys: input.fks ?? [],
  } as BirdTable;
}

const TABLE = (table: string, columns: string[]): SchemaTable => ({
  table,
  columns: columns.map((name) => ({ name, type: 'text' })),
});

function question(text: string): BirdQuestion {
  return {
    question_id: 1,
    db_id: 'db',
    question: text,
    evidence: '',
    SQL: 'select 1',
    difficulty: 'simple',
  } as unknown as BirdQuestion;
}

/**
 * Three tables in a line: `items` joins `orders`, and `orders` joins `warehouses`.
 *
 * The line is the point. Two tables joined to each other cannot show whether the closure does
 * anything — one hop keeps both of them whatever the rule is — so the fixture holds a table that
 * is one join further away than the one the question names: `warehouses` is what one hop has to
 * drop and what two hops has to reach.
 */
const MANIFEST = manifest({
  tables: ['items', 'orders', 'warehouses'],
  columns: [
    [-1, '*'],
    [0, 'id'],
    [0, 'name'],
    [0, 'price'],
    [1, 'id'],
    [1, 'item_id'],
    [1, 'qty'],
    [2, 'warehouse_code'],
    [2, 'order_ref'],
  ],
  fks: [
    [5, 1],
    [8, 4],
  ],
});

const SCHEMA = [
  TABLE('items', ['id', 'name', 'price']),
  TABLE('orders', ['id', 'item_id', 'qty']),
  TABLE('warehouses', ['warehouse_code', 'order_ref']),
];

/** Names one column of `items` and no table: the shape the shipped recallers do see. */
const NAMES_A_COLUMN = 'what is the average price of something';
/** Names a table and no column: only the table recaller sees this one. */
const NAMES_A_TABLE = 'how many items are there';

describe('the tables a question names', () => {
  it('finds nothing with the shipped recallers when a question names only its table', () => {
    // A question that names an entity and no column of it matched nothing at all before the
    // table recaller existed, which is the shape 70 of 496 Mini-Dev questions have.
    const schema = [TABLE('customers', ['customer_id', 'segment'])];
    expect(linkedTables('how many customers are there', schema, SHIPPED_RECALLERS).size).toBe(0);
    expect([...linkedTables('how many customers are there', schema, CANDIDATE_RECALLERS)]).toEqual(['customers']);
  });

  it('finds the column a question names with either set', () => {
    const schema = [TABLE('orders', ['revenue', 'region'])];
    expect([...linkedTables('revenue by region', schema, SHIPPED_RECALLERS)]).toEqual(['orders']);
  });
});

describe('the card the prune rule keeps', () => {
  it('keeps the tables within one join and drops the one a second join reaches', () => {
    const outcome = pruneSchema({ schema: SCHEMA, question: NAMES_A_COLUMN, graph: joinGraphOf(MANIFEST), hops: 1 });
    expect(outcome.reason).toBe('pruned');
    expect(outcome.seeds).toEqual(['items']);
    // `warehouses` is on the card and shares no key with anything: a closure that kept it would
    // be measuring nothing.
    expect(outcome.kept).toEqual(['items', 'orders']);
  });

  it('walks one join further when it is asked to', () => {
    // Two hops is the depth that reaches every gold table in the join measurement and saves
    // almost nothing: the parameter exists so the trade can be measured rather than assumed.
    const graph = joinGraphOf(MANIFEST);
    expect(pruneSchema({ schema: SCHEMA, question: NAMES_A_COLUMN, graph, hops: 2 }).kept).toEqual(['items', 'orders', 'warehouses']);
    // ...and zero hops keeps only what the linker named, which is the depth that saves most and
    // knows least.
    expect(pruneSchema({ schema: SCHEMA, question: NAMES_A_COLUMN, graph, hops: 0 }).kept).toEqual(['items']);
  });

  it('keeps the card order rather than the order it walked the graph in', () => {
    // The renderer's order is part of the prompt a model reads. Re-sorting by discovery would
    // move tables between the pruned and unpruned arms for a reason unrelated to the lever.
    const schema = [TABLE('warehouses', ['warehouse_code', 'order_ref']), TABLE('orders', ['id', 'item_id', 'qty']), TABLE('items', ['id', 'name', 'price'])];
    const outcome = pruneSchema({ schema, question: NAMES_A_COLUMN, graph: joinGraphOf(MANIFEST), hops: 1 });
    // The card's order, not the closure's: `warehouses` is first on this card and last on the
    // walk, and what is kept follows the card.
    expect(outcome.kept).toEqual(['orders', 'items']);
  });

  it('sends the whole card when the linkers name nothing at all', () => {
    // The one failure a card cannot survive: a prompt with no schema in it. Seventy of 496
    // Mini-Dev cases are in this state with the shipped recallers, so the fallback is the rule
    // and not an error path.
    const outcome = pruneSchema({
      schema: SCHEMA,
      question: 'how many are there in total',
      graph: joinGraphOf(MANIFEST),
      hops: 1,
    });
    expect(outcome.reason).toBe('no-seed');
    expect(outcome.seeds).toEqual([]);
    expect(outcome.kept).toEqual([]);
    expect(outcome.schema).toBe(SCHEMA);
  });

  it('seeds itself from the recaller set it is given, not from another one', () => {
    // The table recaller turns "how many items are there" into a seed. An arm that used it would
    // also get a different `Likely columns` hint, so the set is a parameter rather than a default
    // that drifts: this test is the only place the two sets are asked for side by side.
    const built = { schema: SCHEMA, question: NAMES_A_TABLE, graph: joinGraphOf(MANIFEST), hops: 1 };
    expect(pruneSchema(built).reason).toBe('no-seed');
    expect(pruneSchema({ ...built, recallers: CANDIDATE_RECALLERS }).kept).toEqual(['items', 'orders']);
  });

  it('refuses a depth that is not a number of joins', () => {
    const built = { schema: SCHEMA, question: NAMES_A_COLUMN, graph: joinGraphOf(MANIFEST) };
    expect(() => pruneSchema({ ...built, hops: -1 })).toThrow('is not a number of joins');
    expect(() => pruneSchema({ ...built, hops: 1.5 })).toThrow('is not a number of joins');
  });
});

describe('the graph a run builds', () => {
  it('builds each database once and hands back the same graph', () => {
    // The prune arm asks for the same database on every question; rebuilding the graph per
    // question would make the lever pay for a walk of the manifest it never uses.
    const graphFor = graphForDatabase(new Map([['db', MANIFEST]]));
    expect(graphFor('db')).toBe(graphFor('db'));
    // One cache, two entry points: the map keyed by database and the one keyed by manifest are
    // the same graph, so an instrument cannot build a second graph and measure a second thing.
    expect(graphFor('db')).toBe(graphOf(MANIFEST));
    expect(graphFor('db').edges).toBe(joinGraphOf(MANIFEST).edges);
  });

  it('refuses a database the manifest does not describe, rather than pruning to nothing', () => {
    // An empty graph would keep only the tables the question named, which reads as a saving and
    // is a broken input: the error names the database instead.
    expect(() => graphForDatabase(new Map())('absent')).toThrow('no manifest for absent');
  });
});

describe('the prompt the arm sends', () => {
  const parent = resolveArm('select') as Arm;
  const pruned = resolveArm('select-prune') as Arm;

  it('is one lever: the same arm with a depth on its card', () => {
    expect(pruned.prune).toBe(1);
    expect({ ...pruned, prune: undefined, name: parent.name }).toEqual(parent);
  });

  it('renders the closure rather than the card', () => {
    // The defect this asserts against: an instrument that rebuilds the whole card for the prune
    // arm would report the lever as its parent with a longer name, and every character it saved
    // would be an invention.
    const text = question(NAMES_A_COLUMN);
    const whole = promptOf(parent, text, '', MANIFEST);
    const closed = promptOf(pruned, text, '', MANIFEST);
    expect(whole.system).toContain('warehouses');
    expect(closed.system).not.toContain('warehouse_code');
    expect(closed.system.length).toBeLessThan(whole.system.length);
    // What it keeps is still there: a closure that dropped the table the question named would be
    // a cheaper prompt measuring a different question.
    expect(closed.system).toContain('items');
    expect(closed.system).toContain('orders');
  });

  it('is the same rule in the instrument that reads the prompt, not only in the runner', () => {
    // `bench:bird:info` renders the prompt to ask what information it carries. An arm that sends
    // the closure must send it there too, or that instrument measures the whole card and reports
    // it as the prompt that was sent.
    expect(promptForCase(parent, question(NAMES_A_COLUMN), '', MANIFEST)).toContain('warehouse_code');
    expect(promptForCase(pruned, question(NAMES_A_COLUMN), '', MANIFEST)).not.toContain('warehouse_code');
  });

  it('renders the whole card for a question the linker cannot see', () => {
    const text = question('how many are there in total');
    expect(promptOf(pruned, text, '', MANIFEST).system).toBe(promptOf(parent, text, '', MANIFEST).system);
  });
});
