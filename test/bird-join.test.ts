/**
 * What the join closure promises, pinned on the graph and on the gate.
 *
 * The graph is the part that can be wrong quietly. An edge built from a column index pair looks
 * like an edge whichever way it was read, so the tests below drive the three ways the manifest can
 * disagree with itself — a self reference, a column the manifest does not have, the same foreign
 * key written twice — and the second edge source on the one thing that makes it safe, the shared
 * column that is everywhere.
 *
 * The sums are pinned value by value, because `safe` is the column an arm is run on: it charges
 * every case whose closure misses a gold table the whole card, and an implementation that narrowed
 * those cases anyway would report a larger saving and mean a smaller one.
 *
 * The end-to-end cases run the real dataset reader, the real card renderer and the real linker on
 * the seven-question fixture, since the claim is about the prompt that would be sent.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOPS,
  RECALLER_SETS,
  classifyGold,
  graphsOf,
  isEntry,
  joinLines,
  joinPath,
  joinProblems,
  main,
  resolveJoinSettings,
  runJoin,
  tallyJoins,
  writeJoinArtifact,
} from '../eval/bird/join.js';
import type { JoinCase, JoinTally } from '../eval/bird/join.js';
import { EDGE_SOURCES, SHARED_SHARE, closureOf, joinGraphOf, sharedColumns } from '../eval/bird/join-graph.js';
import type { JoinGraph } from '../eval/bird/join-graph.js';
import type { BirdTable } from '../eval/bird/data.js';
import { definesOwnName } from '../eval/bird/statement.js';
import { writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();

/**
 * A manifest entry built from column indices, which is the only shape the graph reads.
 *
 * The columns are listed as `[owner, name]` pairs and the owner is the index the callers below
 * assert on, so a test that adds a foreign key says exactly which tables it connects.
 */
function manifest(input: {
  tables: readonly string[];
  columns: readonly (readonly [number, string])[];
  fks?: readonly (readonly [number, number])[];
}): BirdTable {
  return {
    db_id: 'db',
    tableNames: input.tables,
    tableNamesReadable: input.tables,
    columnNames: input.columns,
    columnNamesReadable: input.columns,
    columnTypes: input.columns.map(() => 'text'),
    foreignKeys: input.fks ?? [],
  };
}

/** `orders.item_id -> items.id`, the fixture's own shape, with room to add tables. */
const SHOP = manifest({
  tables: ['items', 'orders'],
  columns: [
    [-1, '*'],
    [0, 'id'],
    [0, 'name'],
    [0, 'price'],
    [1, 'id'],
    [1, 'item_id'],
    [1, 'qty'],
  ],
  fks: [[5, 1]],
});

describe('the graph the manifest declares', () => {
  it('reads a foreign key as an undirected edge', () => {
    const graph = joinGraphOf(SHOP);
    expect(graph.edges).toBe(1);
    expect(graph.adjacency.get('orders')).toEqual(['items']);
    // The question may name either end, so the walk has to be able to start at either end.
    expect(graph.adjacency.get('items')).toEqual(['orders']);
  });

  it('counts a self reference without turning it into a path', () => {
    const graph = joinGraphOf(manifest({ tables: ['a'], columns: [[0, 'id'], [0, 'parent_id']], fks: [[1, 0]] }));
    expect(graph.selfLoops).toBe(1);
    expect(graph.edges).toBe(0);
    expect(graph.adjacency.get('a')).toEqual([]);
  });

  it('counts a foreign key whose column the manifest does not have', () => {
    const graph = joinGraphOf(manifest({ tables: ['a', 'b'], columns: [[0, 'id'], [1, 'id']], fks: [[99, 1]] }));
    expect(graph.outOfRange).toBe(1);
    expect(graph.edges).toBe(0);
  });

  it('counts one edge when the same foreign key is written twice', () => {
    // BIRD's manifests repeat keys, and two edges between one pair would weight the breadth-first
    // walk without changing what it reaches.
    const graph = joinGraphOf(manifest({ tables: ['a', 'b'], columns: [[0, 'id'], [1, 'a_id']], fks: [[1, 0], [1, 0]] }));
    expect(graph.edges).toBe(1);
    expect(graph.added).toBe(0);
  });

  it('adds the edge the manifest forgot, from a column two tables share', () => {
    // `debit_card_specializing` declares one key and joins four tables on two columns; the shared
    // column is the edge the declaration is missing.
    const table = manifest({
      tables: ['transactions_1k', 'gasstations'],
      columns: [[0, 'TransactionID'], [0, 'GasStationID'], [1, 'GasStationID'], [1, 'Country']],
    });
    expect(joinGraphOf(table, 'manifest').edges).toBe(0);
    const shared = joinGraphOf(table, 'shared');
    expect(shared.edges).toBe(1);
    expect(shared.added).toBe(1);
    expect(shared.adjacency.get('gasstations')).toEqual(['transactions_1k']);
  });

  it('treats one foreign key as one edge when a shared column repeats it', () => {
    const table = manifest({
      tables: ['items', 'orders'],
      columns: [[0, 'id'], [0, 'ItemCode'], [1, 'id'], [1, 'ItemCode']],
      fks: [[1, 3]],
    });
    const shared = joinGraphOf(table, 'shared');
    expect(shared.edges).toBe(1);
    expect(shared.added).toBe(0);
  });

  it('spells a column the same way whatever the database calls it', () => {
    const table = manifest({
      tables: ['a', 'b'],
      columns: [[0, 'GasStationID'], [1, 'gas_station_id']],
    });
    expect(sharedColumns(table).get('gasstationid')).toEqual(new Set(['a', 'b']));
    expect(joinGraphOf(table, 'shared').edges).toBe(1);
  });

  it('will not join on a column every table happens to have', () => {
    // `id` is in every table of every database. An edge per pair would make the closure the card.
    const table = manifest({ tables: ['a', 'b'], columns: [[0, 'id'], [1, 'id']] });
    expect(sharedColumns(table).has('id')).toBe(false);
    expect(joinGraphOf(table, 'shared').edges).toBe(0);
  });

  it('will not join on a column most of the database happens to have', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const table = manifest({ tables: names, columns: names.map((_, index) => [index, 'region'] as const) });
    // Six tables share it, and a third of six is two: the column is vocabulary, not a key.
    expect(joinGraphOf(table, 'shared').edges).toBe(0);
  });

  it('joins on a column two of five tables share, which is under the share', () => {
    const names = ['a', 'b', 'c', 'd', 'e'];
    const columns: [number, string][] = names.map((_, index) => [index, `col_${String(index)}`]);
    columns.push([0, 'owner_id'], [3, 'owner_id']);
    const table = manifest({ tables: names, columns });
    // Five tables times 0.3 floors to one, and the floor is two: a small database keeps its keys.
    expect(joinGraphOf(table, 'shared').edges).toBe(1);
    expect(SHARED_SHARE).toBe(0.3);
  });

  it('ignores the star column and a column with no owner', () => {
    const table = manifest({ tables: ['a', 'b'], columns: [[-1, '*'], [0, 'abc'], [1, 'abc']] });
    expect(sharedColumns(table).get('abc')).toEqual(new Set(['a', 'b']));
    expect([...sharedColumns(table).keys()]).not.toContain('*');
  });

  it('names an owner the manifest does not have as the empty name', () => {
    // A column whose owner index is past the table list is a broken manifest, and the graph reads
    // it as a table called nothing rather than dropping the column: naming it is how the join
    // reveals that the manifest disagrees with itself.
    const table = manifest({ tables: ['a'], columns: [[0, 'abc'], [7, 'abc']] });
    expect(sharedColumns(table).get('abc')).toEqual(new Set(['a', '']));
  });

  it('keeps a two-character column out of the evidence', () => {
    const table = manifest({ tables: ['a', 'b'], columns: [[0, 'ab'], [1, 'ab']] });
    expect(sharedColumns(table).size).toBe(0);
  });

  it('builds both sources for every database', () => {
    const graphs = graphsOf(new Map([['shop', SHOP]]));
    expect([...Object.keys(graphs)].sort()).toEqual(['manifest', 'shared']);
    expect(graphs.manifest.get('shop')?.edges).toBe(1);
  });
});

describe('walking the closure', () => {
  const adjacency = new Map<string, readonly string[]>([
    ['a', ['b']],
    ['b', ['a', 'c']],
    ['c', ['b']],
    ['island', []],
  ]);

  it('returns the seeds themselves at depth zero, lower-cased', () => {
    expect([...closureOf(adjacency, ['A'], 0)]).toEqual(['a']);
  });

  it('reaches one join away at depth one', () => {
    expect([...closureOf(adjacency, ['a'], 1)].sort()).toEqual(['a', 'b']);
  });

  it('reaches one join further at depth two', () => {
    expect([...closureOf(adjacency, ['a'], 2)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('stops when there is nowhere further to go', () => {
    // The walk breaks when a level is empty, so a depth past the graph's diameter costs nothing
    // and returns the same set rather than looping.
    expect([...closureOf(adjacency, ['a'], 9)].sort()).toEqual(['a', 'b', 'c']);
    expect([...closureOf(adjacency, ['island'], 9)]).toEqual(['island']);
  });

  it('keeps a seed the card does not have and counts it once', () => {
    // A name from the linker that is not a table contributes no characters, and dropping it here
    // would hide a linker defect behind a smaller card.
    expect([...closureOf(adjacency, ['a', 'a', 'ghost'], 0)].sort()).toEqual(['a', 'ghost']);
  });

  it('walks an empty graph without inventing a table', () => {
    expect([...closureOf(new Map(), ['a'], 2)]).toEqual(['a']);
  });
});

describe('what the statement calls its own tables', () => {
  const board = 'WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a JOIN b';

  it('recognises a CTE by its definition, not by the with', () => {
    // BIRD writes several CTEs per statement; anchoring on `with` would classify only the first.
    expect(definesOwnName(board, 'a')).toBe(true);
    expect(definesOwnName(board, 'b')).toBe(true);
  });

  it('does not mistake a column alias for a table', () => {
    expect(definesOwnName('SELECT CAST(x AS REAL) AS time_seconds FROM results', 'time_seconds')).toBe(false);
  });

  it('reads a quoted name and does not care about case', () => {
    expect(definesOwnName('WITH "Recent" AS (SELECT 1) SELECT * FROM "Recent"', 'recent')).toBe(true);
    expect(definesOwnName('with Recent as (select 1) select * from Recent', 'Recent')).toBe(true);
  });

  it('does not treat a mention as a definition', () => {
    expect(definesOwnName('SELECT * FROM champion_time', 'champion_time')).toBe(false);
  });

  it('survives a name that is a pattern', () => {
    expect(definesOwnName('WITH a_x AS (SELECT 1) SELECT * FROM a_x', 'a.x')).toBe(false);
  });

  it('divides a statement’s references into what the card shows and what it does not', () => {
    const names = new Set(['results', 'races']);
    const refs = classifyGold(
      'WITH champion_time AS (SELECT 1) SELECT * FROM results JOIN races ON 1 = 1 JOIN champion_time',
      names,
    );
    expect(refs.known.sort()).toEqual(['races', 'results']);
    expect(refs.own).toEqual(['champion_time']);
    expect(refs.unknown).toEqual([]);
  });

  it('keeps a name that is both a table and a CTE on the card’s side', () => {
    const refs = classifyGold('WITH items AS (SELECT 1) SELECT * FROM items', new Set(['items']));
    expect(refs.known).toEqual(['items']);
    expect(refs.own).toEqual([]);
  });

  it('calls a name it cannot place a defect', () => {
    const refs = classifyGold('SELECT * FROM nowhere', new Set(['items']));
    expect(refs.unknown).toEqual(['nowhere']);
  });
});

/** One case built directly, so the sums can be pinned without a dataset. */
function joinCase(overrides: Partial<JoinCase> = {}): JoinCase {
  return {
    id: '1',
    db: 'shop',
    gold: ['items'],
    own: [],
    seeds: { shipped: ['items'], candidate: ['items'] },
    chars: { items: 40, orders: 60 },
    card: 100,
    graphless: false,
    ...overrides,
  };
}

/** A one-edge graph: `items` and `orders` are one join apart. */
const SHOP_GRAPH: JoinGraph = {
  edges: 1,
  added: 0,
  adjacency: new Map([
    ['items', ['orders']],
    ['orders', ['items']],
  ]),
  selfLoops: 0,
  outOfRange: 0,
};

const GRAPHS = { manifest: new Map([['shop', SHOP_GRAPH]]), shared: new Map([['shop', SHOP_GRAPH]]) };

/** The cell for one source, recaller set and depth, which is what a reading cites. */
function cellOf(tally: JoinTally, source: 'manifest' | 'shared', set: 'shipped' | 'candidate', hops: 0 | 1 | 2) {
  return tally.cells.find((cell) => cell.source === source && cell.set === set && cell.hops === hops);
}

describe('the sums a reading cites', () => {
  it('prices every source, recaller set and depth', () => {
    const tally = tallyJoins([joinCase()], GRAPHS as never);
    expect(tally.cells).toHaveLength(EDGE_SOURCES.length * RECALLER_SETS.length * HOPS.length);
    expect(tally.cells.map((cell) => `${cell.source}/${cell.set}/${cell.hops}`)).toContain('shared/candidate/2');
  });

  it('charges the seeds at depth zero and the closure at depth one', () => {
    const tally = tallyJoins([joinCase()], GRAPHS as never);
    expect(cellOf(tally, 'manifest', 'shipped', 0)).toMatchObject({ chars: 40, tables: 1 });
    // The gold is `items` alone, so the closure keeps a table the answer never reads: the saving
    // at depth one is negative for this case, which is the trade the report has to show.
    expect(cellOf(tally, 'manifest', 'shipped', 1)).toMatchObject({ chars: 100, tables: 2 });
  });

  it('sends the whole card when a case has no seed at all', () => {
    const blind = joinCase({ seeds: { shipped: [], candidate: [] } });
    const tally = tallyJoins([blind], GRAPHS as never);
    const cell = cellOf(tally, 'manifest', 'shipped', 0);
    // No seed is not "no tables": a deployment sends the whole card, and charging zero would
    // price a prompt that never mentions a schema.
    expect(cell).toMatchObject({ chars: 100, tables: 2, fallback: 1 });
    // And a fallback must not be counted as a case the closure finished.
    expect(cell?.completed).toBe(0);
  });

  it('does not narrow a case whose closure misses a gold table', () => {
    const partial = joinCase({ gold: ['items', 'orders'], seeds: { shipped: ['items'], candidate: ['items'] } });
    const tally = tallyJoins([partial], GRAPHS as never);
    // Depth one reaches `orders`, so both are there; the safe column narrows.
    expect(cellOf(tally, 'manifest', 'shipped', 1)).toMatchObject({ safeChars: 100, coverage: { all: 1, some: 0, none: 0 } });
    // Depth zero does not, so the safe column charges the whole card while the eager column does not.
    expect(cellOf(tally, 'manifest', 'shipped', 0)).toMatchObject({ chars: 40, safeChars: 100, coverage: { all: 0, some: 1, none: 0 } });
  });

  it('counts a case the closure finishes', () => {
    const partial = joinCase({ gold: ['items', 'orders'], seeds: { shipped: ['items'], candidate: ['items'] } });
    const tally = tallyJoins([partial], GRAPHS as never);
    expect(cellOf(tally, 'manifest', 'shipped', 1)?.completed).toBe(1);
    expect(cellOf(tally, 'manifest', 'shipped', 0)?.completed).toBe(0);
  });

  it('charges nothing for a seed the card does not show', () => {
    // A seed from the linker that is not a table cannot contribute characters; charging it one
    // would invent a cost and dropping it from the count would hide the linker's mistake.
    const ghost = joinCase({ seeds: { shipped: ['ghost'], candidate: ['ghost'] } });
    const tally = tallyJoins([ghost], GRAPHS as never);
    expect(cellOf(tally, 'manifest', 'shipped', 0)).toMatchObject({ chars: 0, tables: 1, coverage: { all: 0, some: 0, none: 1 } });
  });

  it('counts a case whose closure is the whole card', () => {
    const tally = tallyJoins([joinCase({ seeds: { shipped: ['items'], candidate: ['items'] } })], GRAPHS as never);
    expect(cellOf(tally, 'manifest', 'shipped', 1)?.whole).toBe(1);
    expect(cellOf(tally, 'manifest', 'shipped', 0)?.whole).toBe(0);
  });

  it('charges a case in a database with no graph from its seeds alone', () => {
    const orphan = joinCase({ db: 'gone' });
    const tally = tallyJoins([orphan], GRAPHS as never);
    expect(cellOf(tally, 'manifest', 'shipped', 2)).toMatchObject({ chars: 40, tables: 1 });
  });

  it('adds up the population, the exclusions and the graphs', () => {
    const tally = tallyJoins([joinCase({ graphless: true })], GRAPHS as never, 2, 1, ['db.ghost']);
    expect(tally).toMatchObject({ total: 1, excluded: 2, own: 1, graphless: 1, databases: 1, databasesWithoutEdges: 0 });
    expect(tally.edges).toEqual({ manifest: 1, shared: 1 });
    expect(tally.unknownRefs).toEqual(['db.ghost']);
  });

  it('reads a population that is empty without dividing by zero', () => {
    const tally = tallyJoins([], GRAPHS as never);
    expect(tally).toMatchObject({ total: 0, card: 0 });
    expect(tally.cells.every((cell) => cell.chars === 0 && cell.tables === 0)).toBe(true);
  });

  it('counts a database whose manifest declares no edge', () => {
    const empty: JoinGraph = { ...SHOP_GRAPH, edges: 0 };
    const tally = tallyJoins([joinCase()], { manifest: new Map([['shop', empty]]), shared: new Map([['shop', empty]]) } as never);
    expect(tally.databasesWithoutEdges).toBe(1);
  });
});

describe('the lines a reader sees', () => {
  it('says what was read and how it is organised', () => {
    const tally = tallyJoins([joinCase()], GRAPHS as never, 1, 2);
    const text = joinLines(tally).join('\n');
    expect(text).toContain('1 cases over 1 databases');
    expect(text).toContain('2 case(s) name a table of their own');
    expect(text).toContain('1 case(s) read no table the card shows');
    expect(text).toContain('edges     recallers');
    expect(text).toContain('"safe" is the column a deployment can bank');
  });

  it('names a case in a database where a closure cannot move', () => {
    const text = joinLines(tallyJoins([joinCase({ graphless: true })], GRAPHS as never)).join('\n');
    expect(text).toContain('1 case(s) are in a database with no edge');
  });

  it('prints a share over nothing as zero rather than a number that is not one', () => {
    const text = joinLines(tallyJoins([], GRAPHS as never)).join('\n');
    expect(text).toContain('0.0%');
    expect(text).not.toContain('NaN');
  });
});

describe('the four ways the reading can be wrong', () => {
  const clean = (): JoinTally => tallyJoins([joinCase()], GRAPHS as never);

  it('says nothing when the reading holds', () => {
    expect(joinProblems({ tally: clean(), unrenderable: 0, graphDefects: 0 })).toEqual([]);
  });

  it('fails when nothing was read', () => {
    expect(joinProblems({ tally: tallyJoins([], GRAPHS as never), unrenderable: 0, graphDefects: 0 })[0]).toContain(
      'no case could be read',
    );
  });

  it('fails when a gold name is neither on the card nor defined by the statement', () => {
    const problem = joinProblems({ tally: tallyJoins([joinCase()], GRAPHS as never, 0, 0, ['db.ghost']), unrenderable: 0, graphDefects: 0 });
    expect(problem[0]).toContain('misread statement');
    expect(problem[0]).toContain('db.ghost');
  });

  it('fails when a foreign key names a column the manifest does not have', () => {
    const problem = joinProblems({ tally: clean(), unrenderable: 0, graphDefects: 3 });
    expect(problem[0]).toContain('missing edges');
  });

  it('fails when every case was excluded', () => {
    const tally = tallyJoins([], GRAPHS as never, 496);
    expect(joinProblems({ tally, unrenderable: 0, graphDefects: 0 })[0]).toContain('no population');
  });

  it('does not report an empty population twice when the drop is the reason', () => {
    // One root cause, one sentence: a case dropped for a reason a reader can act on is not also
    // "nothing was read", and the drop itself is what the reader is told.
    const tally = tallyJoins([], GRAPHS as never, 0);
    const problems = joinProblems({ tally, unrenderable: 5, graphDefects: 0 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not the one that was sent');
  });
});

describe('where the measurement reads and writes', () => {
  it('defaults to the arm every other tool reports on', () => {
    const settings = resolveJoinSettings({ BIRD_DATA: '/data' }, ['report.json'], ROOT);
    expect(settings.arm).toBe('select-cross');
    expect(settings.strict).toBe(false);
    expect(settings.report).toBe('report.json');
  });

  it('refuses an arm flag with no name, and a run with no report', () => {
    expect(() => resolveJoinSettings({}, ['report.json', '--arm'], ROOT)).toThrow('--arm needs a name');
    expect(() => resolveJoinSettings({}, ['--strict'], ROOT)).toThrow('usage: join.ts');
  });

  it('writes its artifact under a name the arm cannot break', () => {
    const dir = mkdtempSync(join(tmpdir(), 'join-out-'));
    const settings = resolveJoinSettings({ BIRD_DATA: '/data', BIRD_OUT: join(dir, 'bird-eval.json') }, ['report.json', '--arm', 'a/b'], ROOT);
    expect(joinPath(settings)).toBe(join(dir, 'join-a-b.json'));
    const path = writeJoinArtifact(settings, { tally: { total: 0 } } as never);
    expect(JSON.parse(readFileSync(path, 'utf8')).tally.total).toBe(0);
  });

  it('is its own entry point only when it was run as one', () => {
    expect(isEntry(undefined, 'file:///x')).toBe(false);
    expect(isEntry('/x', 'file:///x')).toBe(true);
  });
});

describe('a measurement over a real split', () => {
  const dataset = (): string => writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'join-data-')));

  function settingsFor(data: string, ids: readonly number[] = [1], arm = 'select', overrides: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'join-report-'));
    const path = join(dir, 'bird-eval.json');
    writeFileSync(
      path,
      JSON.stringify({
        split: 'minidev',
        cases: ids.map((id) => ({ arm, id: String(id), passed: false, reason: 'values', calls: 4 })),
        controls: { synthesizedDefinitions: { shop: '' } },
        ...overrides,
      }),
    );
    return {
      report: path,
      layout: { split: 'minidev', questionsFile: join(data, 'mini_dev_sqlite.json'), tablesFile: join(data, 'dev_tables.json'), out: join(dir, 'out.json') },
      arm,
      out: dir,
      strict: true,
    } as never;
  }

  it('finds the gold table one join from the one the question names', async () => {
    // "How many orders are there for the pen?" names the stored value and no column, so the
    // shipped linker has nothing; the candidate set reaches `orders`, whose foreign key reaches
    // `items`, which the statement reads.
    const outcome = await runJoin(settingsFor(dataset(), [7]));
    expect(outcome.tally.total).toBe(1);
    const manifest = outcome.tally.cells.find((cell) => cell.source === 'manifest' && cell.set === 'candidate' && cell.hops === 1);
    expect(manifest?.coverage.all).toBe(1);
    expect(outcome.problems).toEqual([]);
  });

  it('reads every case once, even when the question file holds it twice', async () => {
    const outcome = await runJoin(settingsFor(dataset(), [1, 1, 2]));
    expect(outcome.tally.total).toBe(2);
  });

  it('drops a case the question file does not have', async () => {
    const outcome = await runJoin(settingsFor(dataset(), [999]));
    expect(outcome.drops.unknownQuestion).toBe(1);
  });

  it('drops a case whose database has no definitions for an arm that needs them', async () => {
    const outcome = await runJoin(settingsFor(dataset(), [1], 'select', { controls: {} }));
    expect(outcome.drops.definitionGap).toBe(1);
    // The card this tool rebuilds for that case would not be the card that was sent, which is a
    // reason to say so rather than to publish a share measured from it.
    expect(outcome.problems[0]).toContain('not the one that was sent');
  });

  it('refuses an arm whose prompt it cannot rebuild, by name', async () => {
    const outcome = await runJoin(settingsFor(dataset(), [1], 'inline+retrieval'));
    expect(outcome.drops.unrenderable).toBe(1);
    expect(outcome.problems[0]).toContain('not the one that was sent');
  });

  it('counts every case and says why when the arm name is not one the runner has', async () => {
    const outcome = await runJoin(settingsFor(dataset(), [1, 2], 'no-such-arm'));
    expect(outcome.drops.unknownArm).toBe(2);
    expect(outcome.problems[0]).toContain('not the one that was sent');
  });

  it('leaves out a statement whose only table is its own CTE, and says so', async () => {
    const data = dataset();
    const file = join(data, 'mini_dev_sqlite.json');
    const questions = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
    writeFileSync(
      file,
      JSON.stringify(
        questions.map((entry) => (entry.question_id === 1 ? { ...entry, SQL: 'with t as (select 1) select * from t' } : entry)),
      ),
    );
    const outcome = await runJoin(settingsFor(data, [1]));
    expect(outcome.tally.total).toBe(0);
    expect(outcome.tally.excluded).toBe(1);
    expect(outcome.problems[0]).toContain('no population');
  });

  it('reads a report that carries no definitions block at all', async () => {
    const data = dataset();
    const outcome = await runJoin(settingsFor(data, [1], 'select', { controls: undefined }));
    expect(outcome.drops.definitionGap).toBe(1);
  });

  it('reads the seeds the linker produces for a rendered card', async () => {
    const outcome = await runJoin(settingsFor(dataset(), [1]));
    const first = outcome.cases[0];
    // "How many items are there?" names the table and no column of it: the shipped set is empty
    // and the table recaller is what produces `items`.
    expect(first?.seeds.shipped).toEqual([]);
    expect(first?.seeds.candidate).toEqual(['items']);
    expect(first?.card).toBeGreaterThan(0);
  });

  it('exits zero on a clean measurement and one under --strict when the instrument failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'join-main-'));
    const data = dataset();
    const path = join(dir, 'bird-eval.json');
    const env = { BIRD_SPLIT: 'minidev', BIRD_DATA: data, BIRD_OUT: join(dir, 'out.json') };
    writeFileSync(
      path,
      JSON.stringify({ split: 'minidev', cases: [{ arm: 'select', id: '1', passed: false, reason: 'values' }], controls: { synthesizedDefinitions: { shop: '' } } }),
    );
    expect(await main([path, '--arm', 'select'], ROOT, env)).toBe(0);
    writeFileSync(path, JSON.stringify({ split: 'minidev', cases: [], controls: {} }));
    expect(await main([path, '--arm', 'select'], ROOT, env)).toBe(0);
    expect(await main([path, '--arm', 'select', '--strict'], ROOT, env)).toBe(1);
  });

  it('turns a shared column into the edge a two-table fixture lacks', () => {
    // The fixture joins on a declared key and shares no other column, so the second source is
    // what a reader would expect it to be here: the same graph, with nothing added.
    const tables = graphsOf(new Map([['shop', SHOP]]));
    expect(tables.shared.get('shop')?.added).toBe(0);
  });
});
