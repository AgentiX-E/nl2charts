/**
 * The residue of `elsewhere`, pinned in the directions it can point and in the ways it is counted.
 *
 * `bench:bird:surplus` leaves 31 to 39 cases per dev arm that are still wrong with the gold's filter
 * in place. This instrument splits that residue by which way the read-set is wrong, and the split
 * is what the next lever is aimed at — so the tests are of two kinds. The unit cases pin the
 * readings that come from text (where a gold states its conditions, which tables either statement
 * reads, whether a statement caps its answer), because each of those has a wrong answer that looks
 * right: a CTE counted as a table, an `and` inside a literal counted as a conjunct. The end-to-end
 * cases run a real SQLite file through the real oracle, because the direction is a property of two
 * result sets and a stubbed pair would agree with whatever the tool expected.
 *
 * The fixture is wider than the shared one on purpose: `items` and `orders` alone cannot hold the
 * `over` branch, since a fan-out that projects only base columns preserves the row *set* — the
 * arithmetic this file's header relies on — so `over` needs a statement that genuinely answers with
 * more tuples than the gold, and `tags` is what makes that possible without inventing bad SQL.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESIDUE_ARM,
  RESIDUE_KINDS,
  conditionsOutsideWhere,
  directionOf,
  extraPredictionTables,
  hasLimit,
  isEntry,
  joinPieces,
  main,
  missingGoldTables,
  residueExtraLines,
  residueLines,
  residuePath,
  residueProblems,
  resolveResidueSettings,
  runResidue,
  isUnattributedOver,
  tablesOf,
  tallyResidue,
  withoutLimit,
  writeResidueArtifact,
} from '../eval/bird/residue.js';
import { MINI_DB, writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();
const ARM = DEFAULT_RESIDUE_ARM;

/**
 * The questions this file's cases are built on.
 *
 * Written over the shared fixture's seven golds rather than beside them: those are all aggregates,
 * and an aggregate answers in one row whatever the filter — so every case built on them would be a
 * `values` failure, never a `row-count` one, and the residue would be empty by construction.
 */
const QUESTIONS = [
  { id: 201, question: 'What are the names of the items?', sql: 'select name from items', difficulty: 'simple' },
  { id: 202, question: 'What are the ids of the items?', sql: 'select id from items', difficulty: 'simple' },
  {
    id: 203,
    question: 'What are the item ids and quantities of orders above one unit?',
    sql: 'select i.id, o.qty from items i join orders o on o.item_id = i.id where o.qty > 1',
    difficulty: 'moderate',
  },
  { id: 204, question: 'What are the names and prices of the items?', sql: 'select name, price from items', difficulty: 'simple' },
  { id: 205, question: 'What are the order ids and quantities?', sql: 'select id, qty from orders where id > 0', difficulty: 'moderate' },
  {
    id: 206,
    question: 'Which item ids carry an order above three units?',
    sql: 'select i.id, o.qty from items i join orders o on o.item_id = i.id and o.qty > 3',
    difficulty: 'challenging',
  },
  { id: 207, question: 'What are the ids of the warehouses?', sql: 'select id from warehouses', difficulty: 'simple' },
];

/**
 * A split whose `orders` table actually fans out.
 *
 * The shared fixture's orders are one per item, so a join from `items` multiplies nothing and none
 * of the directions can be built. Two more orders for the third item, and a `tags` table whose ids
 * fall outside `items`' id range — the only way a statement can answer with tuples the gold does
 * not contain while projecting the same number of columns.
 */
function writeFixture(dir: string): { readonly data: string } {
  const data = writeMiniBirdDataset(join(dir, 'MINIDEV'));
  const db = new DatabaseSync(join(data, 'dev_databases', MINI_DB, `${MINI_DB}.sqlite`));
  db.exec(`
    insert into orders values (4, 3, 1), (5, 3, 2);
    create table tags (id integer primary key, item_id integer);
    insert into tags values (7, 1), (8, 1), (9, 2);
  `);
  db.close();
  writeFileSync(
    join(data, 'mini_dev_sqlite.json'),
    JSON.stringify(
      QUESTIONS.map((entry) => ({
        question_id: entry.id,
        db_id: MINI_DB,
        question: entry.question,
        evidence: '',
        SQL: entry.sql,
        difficulty: entry.difficulty,
      })),
    ),
  );
  return { data };
}

const env = (data: string) => ({ BIRD_SPLIT: 'minidev', BIRD_DATA: data, BIRD_DATABASES: join(data, 'dev_databases') });

const artifactOf = (path: string, cases: readonly { id: number; passed?: boolean; reason?: string; sql?: string; arm?: string }[]): void => {
  writeFileSync(
    path,
    JSON.stringify({
      split: 'minidev',
      cases: cases.map((entry) => ({
        arm: entry.arm ?? ARM,
        id: entry.id,
        passed: entry.passed ?? false,
        reason: entry.reason ?? 'values',
        ...(entry.sql === undefined ? {} : { sql: entry.sql }),
      })),
    }),
  );
};

/** A temporary split plus the settings that point at it, which every end-to-end case needs. */
function fixture(): { readonly data: string; readonly artifact: string; readonly settings: ReturnType<typeof resolveResidueSettings> } {
  const dir = mkdtempSync(join(tmpdir(), 'residue-'));
  const { data } = writeFixture(dir);
  const artifact = join(dir, 'artifact.json');
  const settings = resolveResidueSettings(['--artifact', artifact, '--arm', ARM], ROOT, env(data));
  return { data, artifact, settings };
}

describe('which way the read-set differs', () => {
  it('says over when every row of the answer is there and more besides', () => {
    expect(directionOf([[1]], [[1], [2]])).toBe('over');
  });

  it('says under when the answer holds rows the statement never returned', () => {
    expect(directionOf([[1], [2]], [[1]])).toBe('under');
  });

  it('says mixed when neither side contains the other', () => {
    expect(directionOf([[1], [2]], [[2], [3]])).toBe('mixed');
  });

  it('reads containment as a set, because the rule it is built on does', () => {
    // The same row three times against the same row once: neither side is a strict superset as a
    // set, so no containment claim is made. A case shaped like this is the official judge's
    // `duplicates` before it reaches here, and the caller drops it there.
    expect(directionOf([[1], [1], [1]], [[1]])).toBe('mixed');
  });

  it('will not read a row of a different width as the same row', () => {
    // `resultKey` carries the column width, so a two-column row cannot be contained in a
    // one-column answer whatever its first value is.
    expect(directionOf([[1]], [[1, 2]])).toBe('mixed');
  });

  it('names the empty answer as over when the statement returned rows', () => {
    expect(directionOf([], [[1], [2]])).toBe('over');
  });

  it('names it under when the answer has rows and the statement returned none', () => {
    // An empty statement against a non-empty answer is a `row-count` failure with nothing in it,
    // which is the largest form of "reads too few rows" there is.
    expect(directionOf([[1], [2]], [])).toBe('under');
  });
});

describe('reading where a gold states its conditions', () => {
  it('names a having clause', () => {
    expect(conditionsOutsideWhere('select i.id from items i group by i.id having count(*) > 1')).toBe('having');
  });

  it('names a join whose on carries a filter beside its key', () => {
    expect(conditionsOutsideWhere('select i.id from items i join orders o on o.item_id = i.id and o.qty > 1')).toBe('on');
  });

  it('says nothing about a join that only names its key', () => {
    expect(conditionsOutsideWhere('select i.id from items i join orders o on o.item_id = i.id where i.price > 1')).toBeUndefined();
  });

  it('does not read a join inside a subquery as the statement\'s own', () => {
    // The clause a where-graft edits belongs to the outer statement; a condition one level down is
    // not something that graft ever carried, so counting it would overstate the audit.
    expect(conditionsOutsideWhere('select d.id from (select i.id from items i join orders o on o.item_id = i.id and o.qty > 1) d')).toBeUndefined();
  });

  it('does not read a word inside a literal as a clause', () => {
    expect(conditionsOutsideWhere("select i.id from items i where i.name = 'having'")).toBeUndefined();
    expect(conditionsOutsideWhere("select i.id from items i join orders o on o.item_id = i.id where o.note = 'x and y'")).toBeUndefined();
  });

  it('reads a bracketed conjunct as one condition, not as two', () => {
    // The `and` inside the brackets is at depth one, so the join states one filter beside its key.
    expect(conditionsOutsideWhere('select i.id from items i join orders o on o.item_id = i.id and (o.qty > 1)')).toBe('on');
  });

  it('says nothing about a join with no on clause at all', () => {
    expect(conditionsOutsideWhere('select i.id from items i cross join tags t')).toBeUndefined();
  });

  it('does not count a left join\'s on as two conditions for its modifier', () => {
    // `left join` is one piece and its `on` has one conjunct, so nothing is outside the where.
    expect(conditionsOutsideWhere('select i.id from items i left join orders o on o.item_id = i.id')).toBeUndefined();
  });
});

describe('finding the joins of a statement', () => {
  it('finds one join and names the table it reads', () => {
    const pieces = joinPieces('select i.id from items i join orders o on o.item_id = i.id where o.qty > 1');
    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.table).toBe('orders');
    expect(pieces[0]?.text).toBe('join orders o on o.item_id = i.id');
  });

  it('keeps a left join whole, modifier included', () => {
    // A span that started at `join` would leave `left` in the clause, and the `on` test would then
    // read a span the statement does not have.
    expect(joinPieces('select i.id from items i left join orders o on o.item_id = i.id')[0]?.text).toBe('left join orders o on o.item_id = i.id');
  });

  it('finds two joins and splits them where the second begins', () => {
    const pieces = joinPieces('select i.id from items i join orders o on o.item_id = i.id join tags t on t.item_id = i.id where i.id > 0');
    expect(pieces.map((piece) => piece.table)).toEqual(['orders', 'tags']);
    expect(pieces[0]?.text).toBe('join orders o on o.item_id = i.id');
  });

  it('does not read a join inside a literal as a join', () => {
    expect(joinPieces("select i.id from items i where i.name = 'join orders o'")).toEqual([]);
  });

  it('reads nothing out of a statement with no from clause', () => {
    expect(joinPieces('select 1')).toEqual([]);
  });

  it('does not read a comma as a join', () => {
    expect(joinPieces('select i.id from items i, orders o where o.item_id = i.id')).toEqual([]);
  });
});

describe('reading which tables either statement touches', () => {
  it('lists the tables of a statement once and in lower case', () => {
    expect(tablesOf('select * from Items i join ORDERS o on o.item_id = i.id')).toEqual(['items', 'orders']);
  });

  it('does not count a name the statement defines as a table', () => {
    // A CTE name is not a table, and counting it would report a missing table on every gold that
    // opens one.
    expect(tablesOf('with recent as (select id from orders where qty > 1) select id from recent')).toEqual(['orders']);
  });

  it('names the gold tables the prediction never reads', () => {
    expect(missingGoldTables('select i.id from items i join orders o on o.item_id = i.id', 'select id from items')).toEqual(['orders']);
  });

  it('names the tables the prediction reads beyond the gold', () => {
    expect(extraPredictionTables('select id from items', 'select i.id from items i join tags t on t.item_id = i.id')).toEqual(['tags']);
  });

  it('lists a table read twice under two aliases once', () => {
    expect(tablesOf('select a.id from items a join items b on b.id = a.id')).toEqual(['items']);
  });

  it('says nothing when both statements read the same tables', () => {
    expect(missingGoldTables('select id from items', 'select i.id from items i')).toEqual([]);
    expect(extraPredictionTables('select id from items', 'select i.id from items i')).toEqual([]);
  });
});

describe('stripping the cap', () => {
  it('removes a top-level limit and leaves the statement', () => {
    expect(withoutLimit('select id from items limit 2')).toBe('select id from items');
  });

  it('takes the offset with the limit it belongs to', () => {
    expect(withoutLimit('select id from items order by id limit 2 offset 1')).toBe('select id from items order by id');
  });

  it('leaves a statement with no limit alone', () => {
    expect(withoutLimit('select id from items')).toBe('select id from items');
  });

  it('leaves a limit inside a subquery alone, because a top-N per group is the answer', () => {
    expect(withoutLimit('select id from items where id in (select id from items limit 1)')).toBe(
      'select id from items where id in (select id from items limit 1)',
    );
  });
});

describe('reading whether a statement caps its answer', () => {
  it('sees a top-level limit', () => {
    expect(hasLimit('select id from items limit 2')).toBe(true);
  });

  it('does not see a limit inside a subquery as a cap on the answer', () => {
    // A top-N per group is written this way, and the outer statement answers every group.
    expect(hasLimit('select id from items where id in (select id from items limit 1)')).toBe(false);
  });

  it('says no when there is no limit at all', () => {
    expect(hasLimit('select id from items')).toBe(false);
  });
});

describe('the floor this file cannot attribute', () => {
  it('names an over case with nothing else to explain it', () => {
    expect(isUnattributedOver('over', undefined, [])).toBe(true);
  });

  it('does not name an over case that misses a table the gold reads', () => {
    expect(isUnattributedOver('over', undefined, ['items'])).toBe(false);
  });

  it('does not name an over case whose gold states a condition outside its where', () => {
    expect(isUnattributedOver('over', 'on', [])).toBe(false);
  });

  it('does not name a case that is not over at all', () => {
    expect(isUnattributedOver('under', undefined, [])).toBe(false);
    expect(isUnattributedOver('mixed', undefined, [])).toBe(false);
    expect(isUnattributedOver('capped', undefined, [])).toBe(false);
  });
});

describe('tallying the residue', () => {
  it('counts each direction', () => {
    const tally = tallyResidue(['over', 'under', 'under', 'mixed']);
    expect(tally.total).toBe(4);
    expect(tally.kinds).toEqual({ capped: 0, over: 1, under: 2, mixed: 1, unreadable: 0 });
  });

  it('prints one line per direction, in the declared order', () => {
    const lines = residueLines(tallyResidue(['under']));
    expect(lines).toHaveLength(RESIDUE_KINDS.length + 1);
    expect(lines[2]).toMatch(/under\s+1\s+100\.0%/);
  });

  it('prints zero over an empty set as zero and not as a rate', () => {
    expect(residueLines(tallyResidue([]))[1]).toMatch(/over\s+0\s+0\.0%/);
  });

  it('refuses an empty residue, because 0 of 0 reads like a measured zero', () => {
    expect(residueProblems(tallyResidue([]))).toEqual(['RES: no case in this artifact survived the predicate graft, so there is no residue to read']);
  });

  it('does not fail a non-empty residue for the cases it could not read', () => {
    expect(residueProblems(tallyResidue(['under', 'unreadable']))).toEqual([]);
  });
});

describe('the readings printed beside the split', () => {
  const cross = {
    conditions: { having: 2, on: 3 },
    missingTable: 4,
    extraTable: 6,
    capped: 1,
    underWithExtraTable: 5,
    overWithMissingTable: 2,
    unattributedOver: 1,
    missingTables: { orders: 3, tags: 1 },
    extraTables: { tags: 6, cities: 2 },
    unreadable: 1,
  };

  it('adds the two ways a gold keeps a condition out of its where', () => {
    expect(residueExtraLines(tallyResidue(['under']), cross)[0]).toBe(
      '  golds stating conditions a where-graft cannot carry: 5 of 1 (500.0%) — on 3, having 2',
    );
  });

  it('names the tables read beyond the gold, most often first', () => {
    const lines = residueExtraLines(tallyResidue(['under']), cross);
    expect(lines[2]).toContain('6 of 1');
    expect(lines[3]).toBe('  tables read beyond the gold most often: tags 6, cities 2');
  });

  it('reports the cap and the floor separately', () => {
    const lines = residueExtraLines(tallyResidue(['mixed']), cross);
    expect(lines.some((line) => line.startsWith('  capped by a limit the gold does not have: 1 of 1'))).toBe(true);
    expect(lines.some((line) => line.startsWith('  unattributed: 1 of 1'))).toBe(true);
  });

  it('says how many cases it could not read', () => {
    const lines = residueExtraLines(tallyResidue(['under']), cross);
    expect(lines.some((line) => line.includes('1 case(s) this tool could not read'))).toBe(true);
  });

  it('says nothing about unreadable cases when there are none', () => {
    const lines = residueExtraLines(tallyResidue(['under']), { ...cross, unreadable: 0 });
    expect(lines.some((line) => line.includes('could not read'))).toBe(false);
  });

  it('prints 0.0 rather than a share when the residue is empty', () => {
    const empty = { ...cross, conditions: { having: 0, on: 0 }, missingTable: 0, extraTable: 0, capped: 0, unattributedOver: 0, missingTables: {}, extraTables: {}, unreadable: 0 };
    expect(residueExtraLines(tallyResidue([]), empty).some((line) => line.includes('read beyond the gold most often'))).toBe(false);
    const lines = residueExtraLines(tallyResidue([]), empty);
    expect(lines[0]).toBe('  golds stating conditions a where-graft cannot carry: 0 of 0 — on 0, having 0');
  });
});

describe('the settings this harness accepts', () => {
  const layoutEnv = { BIRD_SPLIT: 'dev', BIRD_DATA: '/tmp/data', BIRD_DATABASES: '/tmp/data/dev_databases' };

  it('defaults the arm and takes the artifact from the environment layout', () => {
    const settings = resolveResidueSettings([], '/root', layoutEnv);
    expect(settings.arm).toBe(DEFAULT_RESIDUE_ARM);
    expect(settings.artifact).toMatch(/eval\/out/);
  });

  it('rejects a flag it does not know rather than ignoring it', () => {
    expect(() => resolveResidueSettings(['--split', 'dev'], '/root', layoutEnv)).toThrow(/unrecognized argument --split/);
  });

  it('rejects a flag with no value', () => {
    expect(() => resolveResidueSettings(['--arm'], '/root', layoutEnv)).toThrow(/--arm needs a value/);
    expect(() => resolveResidueSettings(['--artifact', '--arm', 'x'], '/root', layoutEnv)).toThrow(/needs a value/);
  });

  it('names the artifact by the arm, so two arms do not overwrite each other', () => {
    expect(residuePath({ root: '/root', arm: 'select-mixed' })).toBe('/root/eval/out/residue-select-mixed.json');
    expect(residuePath({ root: '/root', arm: 'a/b' })).toBe('/root/eval/out/residue-a_b.json');
  });
});

describe('the residue of a real artifact against a real database', () => {
  it('calls a statement that answers with more tuples than the gold over', async () => {
    const { artifact, settings } = fixture();
    // Every id of the items is an id of the orders, and the statement read the orders: a superset
    // rather than a repetition, which is why the official rule does not credit it.
    artifactOf(artifact, [{ id: 202, sql: 'select id from orders' }]);
    const outcome = await runResidue(settings);
    expect(outcome.tally.total).toBe(1);
    expect(outcome.rows[0]?.kind).toBe('over');
    expect(outcome.rows[0]?.extraPredictionTables).toEqual(['orders']);
    // The gold reads `items` and the statement reads `orders` instead, so this is the case the
    // missing-table count names — not the floor.
    expect(outcome.rows[0]?.missingGoldTables).toEqual(['items']);
    expect(outcome.cross.overWithMissingTable).toBe(1);
    expect(outcome.cross.unattributedOver).toBe(0);
    expect(outcome.problems).toEqual([]);
  });

  it('calls a statement whose join filters rows away under', async () => {
    const { artifact, settings } = fixture();
    // The filter is in the join's `on` clause, so it removes rows rather than selecting them, and
    // every row it keeps is a row of the answer.
    artifactOf(artifact, [{ id: 202, sql: 'select i.id from items i join orders o on o.item_id = i.id and o.qty > 4' }]);
    const outcome = await runResidue(settings);
    expect(outcome.rows[0]?.kind).toBe('under');
    // The join is also a table the gold never reads, which is the correlation this file reports.
    expect(outcome.cross.underWithExtraTable).toBe(1);
  });

  it('names a capped answer as a repair, and counts what stripping the cap recovers', async () => {
    const { artifact, settings } = fixture();
    artifactOf(artifact, [{ id: 202, sql: 'select i.id from items i limit 2' }]);
    const outcome = await runResidue(settings);
    expect(outcome.rows[0]?.kind).toBe('capped');
    expect(outcome.rows[0]?.capped).toBe(true);
    expect(outcome.cross.capped).toBe(1);
    expect(outcome.tally.repairedByAnEditTriedHere).toBe(1);
  });

  it('counts a cap that does not explain the failure, and reads the direction instead', async () => {
    const { artifact, settings } = fixture();
    // The cap is real and the statement is still wrong without it: the repair is refused, the cap
    // is still counted, and the case is read for the direction it does have.
    artifactOf(artifact, [{ id: 201, sql: 'select i.name from items i where i.price > 2 limit 1' }]);
    const outcome = await runResidue(settings);
    expect(outcome.cross.capped).toBe(1);
    expect(outcome.tally.kinds.capped).toBe(0);
    expect(outcome.tally.total).toBe(1);
  });

  it('calls a statement wrong in both directions mixed', async () => {
    const { artifact, settings } = fixture();
    artifactOf(artifact, [{ id: 204, sql: 'select i.name, o.qty from items i join orders o on o.item_id = i.id' }]);
    const outcome = await runResidue(settings);
    expect(outcome.rows[0]?.kind).toBe('mixed');
  });

  it('drops the case the predicate graft repairs, because the previous rung counts it', async () => {
    const { artifact, settings } = fixture();
    artifactOf(artifact, [{ id: 202, sql: 'select i.id from items i where i.price > 2' }]);
    const outcome = await runResidue(settings);
    expect(outcome.tally.total).toBe(0);
    expect(outcome.drops.predicate).toBe(1);
  });

  it('drops the case the official rule folds, because that is the fan-out bucket', async () => {
    const { artifact, settings } = fixture();
    // Five rows whose set is the gold's two: the official judge credits this, which is why a
    // pure fan-out is not a case this file can see.
    artifactOf(artifact, [{ id: 201, sql: 'select i.name from items i join orders o on o.item_id = i.id where o.qty > 0' }]);
    const outcome = await runResidue(settings);
    expect(outcome.tally.total).toBe(0);
    expect(outcome.drops.duplicates).toBe(1);
  });

  it('counts the gold the engine cannot run rather than blaming the statement', async () => {
    const { artifact, settings } = fixture();
    // Question 207's gold reads a table this fixture does not have. A harness that counted that as
    // a direction would report a fact about its own corpus as a fact about the model.
    artifactOf(artifact, [{ id: 207, sql: 'select id from items' }]);
    const outcome = await runResidue(settings);
    expect(outcome.drops.goldFailed).toBe(1);
    expect(outcome.tally.total).toBe(0);
  });

  it('counts a statement the engine refuses rather than calling it empty', async () => {
    const { artifact, settings } = fixture();
    artifactOf(artifact, [{ id: 202, sql: 'select nope from items' }]);
    const outcome = await runResidue(settings);
    expect(outcome.drops.engineRefused).toBe(1);
    expect(outcome.tally.total).toBe(0);
  });

  it('counts a nested statement as refused, because the previous rung cannot graft it', async () => {
    const { artifact, settings } = fixture();
    artifactOf(artifact, [{ id: 202, sql: 'select id from (select id from items where id < 3) t' }]);
    const outcome = await runResidue(settings);
    expect(outcome.drops.graftRefused).toBe(1);
    expect(outcome.tally.total).toBe(0);
  });

  it('reads where the gold states its conditions when the case is otherwise an over', async () => {
    const { artifact, settings } = fixture();
    // The gold's filter is a conjunct of the join's `on`, so the statement without it answers more
    // than the gold, and no `where` graft could ever have carried that filter.
    artifactOf(artifact, [{ id: 206, sql: 'select i.id, o.qty from items i join orders o on o.item_id = i.id' }]);
    const outcome = await runResidue(settings);
    expect(outcome.rows[0]?.kind).toBe('over');
    expect(outcome.rows[0]?.conditionsOutsideWhere).toBe('on');
    expect(outcome.cross.conditions.on).toBe(1);
  });

  it('takes the split from the layout when the artifact does not name one', async () => {
    const { artifact, settings } = fixture();
    const cases = [{ arm: ARM, id: 202, passed: false, reason: 'values', sql: 'select i.id from items i limit 2' }];
    writeFileSync(artifact, JSON.stringify({ cases }));
    const outcome = await runResidue(settings);
    expect(outcome.split).toBe('minidev');
    expect(outcome.tally.total).toBe(1);
  });

  it("follows the artifact when it names another split, and reads that split's questions file", async () => {
    const { artifact, settings, data } = fixture();
    // The artifact says `dev`; the layout says `minidev`. The artifact wins, and the paths stay the
    // caller's, so the questions come from `<data>/dev.json` rather than from `eval/.cache`.
    writeFileSync(join(data, 'dev.json'), readFileSync(join(data, 'mini_dev_sqlite.json')));
    artifactOf(artifact, [{ id: 202, sql: 'select i.id from items i limit 2' }]);
    const body = JSON.parse(readFileSync(artifact, 'utf8')) as Record<string, unknown>;
    writeFileSync(artifact, JSON.stringify({ ...body, split: 'dev' }));
    const outcome = await runResidue(settings);
    expect(outcome.split).toBe('dev');
    expect(outcome.tally.total).toBe(1);
  });

  it('counts a graft the engine will not run instead of calling it a direction', async () => {
    const { artifact, settings } = fixture();
    // The gold's `id` is unambiguous in a one-table statement and ambiguous once the graft puts it
    // beside two tables that both have one.
    artifactOf(artifact, [{ id: 205, sql: 'select o.id, o.qty from orders o join items i on i.id = o.item_id where o.qty > 1' }]);
    const outcome = await runResidue(settings);
    expect(outcome.tally.kinds.unreadable).toBe(1);
    expect(outcome.unreadableIds).toEqual(['205']);
    expect(outcome.problems).toEqual([]);
  });

  it('files every case it cannot use under the reason it could not', async () => {
    const { artifact, settings } = fixture();
    artifactOf(artifact, [
      { id: 201, passed: true },
      { id: 201, reason: 'column-count' },
      { id: 201, arm: 'select' },
      { id: 201 },
      { id: 999, sql: 'select 1' },
      // Three rows and one column against a gold of three rows and two: the `column-count` rung.
      { id: 203, sql: 'select id from orders where id <= 3' },
      // One counted row against three projected ones: the `aggregate` rung, which the row-count test
      // would otherwise have handed to this one.
      { id: 202, sql: 'select count(*) from items' },
      { id: 204, sql: 'select i.name, o.qty from items i join orders o on o.item_id = i.id' },
    ]);
    const outcome = await runResidue(settings);
    expect(outcome.drops).toMatchObject({ passed: 1, otherReason: 1, otherArm: 1, unretained: 1, unknownQuestion: 1, otherShape: 1, otherForm: 1 });
    expect(outcome.tally.total).toBe(1);
    expect(outcome.rows[0]?.kind).toBe('mixed');
  });

  it('writes the artifact under the arm it was run for, and the entry reports it', async () => {
    const { artifact, settings } = fixture();
    artifactOf(artifact, [{ id: 202, sql: 'select i.id from items i limit 2' }]);
    const outcome = await runResidue(settings);
    const path = writeResidueArtifact(settings, outcome);
    expect(path).toBe(residuePath({ root: ROOT, arm: ARM }));
    const reread = JSON.parse(readFileSync(path, 'utf8')) as { tally: { total: number } };
    expect(reread.tally.total).toBe(1);
  });

  it('exits zero on a residue it can read', async () => {
    const { data, artifact } = fixture();
    artifactOf(artifact, [{ id: 202, sql: 'select i.id from items i limit 2' }]);
    expect(await main(['--artifact', artifact], ROOT, env(data))).toBe(0);
  });

  it('exits non-zero on an artifact with no residue, because 0 of 0 is not a reading', async () => {
    const { data, artifact } = fixture();
    artifactOf(artifact, [{ id: 202, passed: true }]);
    expect(await main(['--artifact', artifact], ROOT, env(data))).toBe(1);
  });
});

describe('the entry point', () => {
  it('recognises its own module and nothing else', () => {
    expect(isEntry(undefined, 'file:///x')).toBe(false);
    expect(isEntry('/workspace/nl2charts/eval/bird/residue.ts', 'file:///workspace/nl2charts/eval/bird/residue.ts')).toBe(true);
  });
});
