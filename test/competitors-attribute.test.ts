/**
 * Attributing a paired comparison to a pool state and a gap kind.
 *
 * The fixture is a real SQLite database and thirteen real questions, because the whole reading
 * rests on executing statements that were already written and judging their rows: a stubbed verdict
 * would agree with whatever the attribution was written to expect. Each question is constructed so
 * that exactly one branch of the gap ladder is the answer, which is what makes a table of six
 * buckets mean six things rather than one thing counted six ways.
 *
 * The assertions are about four properties:
 *
 * - a pool-held case is separated from a pool-missed one, because selection and generation are
 *   different work;
 * - each gap kind is named from the two statements and nothing else;
 * - a join that disagrees with the score artifact's own four counts is refused rather than printed;
 * - a bucket below the run's resolution is reported as a bucket below the resolution.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { BirdLayout } from '../eval/bird/run.js';
import { resolveLayout } from '../eval/bird/run.js';
import {
  GAP_KINDS,
  atomSkeleton,
  attributeLines,
  conditionKindOf,
  conditionSkeletons,
  literalValues,
  sameStatement,
  gapKind,
  isEntry,
  linkOfCondition,
  main,
  messageOf,
  readOurCases,
  readTraits,
  resolveAttributionSettings,
  runAttribution,
  strayConditionKinds,
  strayKindProblems,
  writeAttribution,
} from '../eval/competitors/attribute.js';
import type { AttributionOutcome, AttributionSettings } from '../eval/competitors/attribute.js';
import { schemaIndex } from '../eval/bird/conditions.js';
import { createOracle } from '../eval/bird/oracle.js';
import { MINI_DB, writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();
const ARM = 'select-mixed';

/** The thirteen questions, their gold statements, and what each one is in the fixture to prove. */
const QUESTIONS = [
  { id: 1, question: 'How many items are there?', sql: 'select count(*) from items' },
  { id: 2, question: 'How many orders are for the pen?', sql: 'select count(*) from orders where item_id = 1' },
  // A pool-held case whose correct statement carries a filter the winner lacks: the case is a
  // selection failure, so no gap kind may be filed for it, and this is the shape that caught a
  // breakdown counting it anyway.
  { id: 3, question: 'What is the total price of every item?', sql: 'select sum(price) from items where price > 0' },
  { id: 4, question: 'How many distinct item names are there?', sql: 'select count(distinct name) from items' },
  { id: 5, question: 'How many cities are there?', sql: 'select count(distinct city) from cities' },
  // Their filter is on `orders.qty`; ours puts the same value on `items.price`, a column of another
  // table. That is the shape the linking split exists for, and it has to appear end to end: a unit
  // test of the split would not prove the instrument produces it.
  { id: 6, question: 'What is the largest quantity on an order?', sql: 'select max(qty) from orders where qty > 1' },
  { id: 7, question: 'What are the item names?', sql: 'select name from items' },
  { id: 8, question: 'What does the expensive stock cost in total?', sql: 'select sum(price) from items where price > 3' },
  { id: 9, question: 'How many orders per item?', sql: 'select item_id, count(*) from orders group by item_id' },
  { id: 10, question: 'What is the name of the most expensive item?', sql: 'select name from items order by price desc limit 1' },
  { id: 11, question: 'How many orders are larger than one unit?', sql: 'select count(*) from orders where qty > 1' },
  { id: 12, question: 'How many warehouses are there?', sql: 'select count(*) from items' },
  { id: 13, question: 'What is the cheapest price?', sql: 'select min(price) from items' },
] as const;

interface Candidate {
  readonly source: string;
  readonly correct: boolean;
  readonly sql: string;
}

interface Fixture {
  readonly dir: string;
  readonly layout: BirdLayout;
  readonly env: Record<string, string | undefined>;
  readonly report: string;
  readonly score: string;
  readonly predictions: string;
}

/** What our arm generated for each question, the statement it returned, and the judge's verdict. */
const OUR_CASES: Readonly<Record<number, { readonly passed: boolean; readonly candidates: readonly Candidate[]; readonly winner?: string }>> = {
  1: { passed: true, candidates: [{ source: 'inline+evidence', correct: true, sql: 'select count(*) from items' }], winner: 'inline+evidence' },
  2: {
    passed: true,
    candidates: [{ source: 'inline+evidence', correct: true, sql: 'select count(*) from orders where item_id = 1' }],
    winner: 'inline+evidence',
  },
  // A correct statement in the pool and the selector took the other one: selection, not generation.
  3: {
    passed: false,
    candidates: [
      { source: 'inline+evidence', correct: false, sql: 'select count(price) from items' },
      { source: 'evidence+values', correct: true, sql: 'select sum(price) from items where price > 0' },
    ],
    winner: 'inline+evidence',
  },
  4: { passed: false, candidates: [{ source: 'inline+evidence', correct: false, sql: 'select name, count(*) from items group by name' }], winner: 'inline+evidence' },
  5: { passed: false, candidates: [{ source: 'inline+evidence', correct: false, sql: 'select count(distinct name) from items' }], winner: 'inline+evidence' },
  6: {
    passed: false,
    candidates: [
      {
        source: 'inline+evidence',
        correct: false,
        sql: 'select max(qty) from orders join items on items.id = orders.item_id where items.price = 1',
      },
    ],
    winner: 'inline+evidence',
  },
  7: { passed: false, candidates: [{ source: 'inline+evidence', correct: false, sql: 'select price from items limit 1' }], winner: 'inline+evidence' },
  8: {
    passed: false,
    candidates: [{ source: 'inline+evidence', correct: false, sql: 'select sum(price) from items where price > 6' }],
    winner: 'inline+evidence',
  },
  9: { passed: false, candidates: [{ source: 'inline+evidence', correct: false, sql: 'select count(*) from orders' }], winner: 'inline+evidence' },
  10: { passed: false, candidates: [{ source: 'inline+evidence', correct: false, sql: 'select name from items limit 1' }], winner: 'inline+evidence' },
  11: {
    passed: false,
    candidates: [
      { source: 'inline+evidence', correct: false, sql: 'select count(*) from orders where item_id = 1 and qty > 1' },
      { source: 'evidence+values', correct: false, sql: 'select count(*) from orders where item_id = 1' },
    ],
    winner: 'inline+evidence',
  },
  // The same statement as theirs, recorded as wrong: the report's verdict disagrees with an
  // execution of that exact statement, which is a hole in the artifact rather than a pipeline gap.
  12: { passed: false, candidates: [{ source: 'inline+evidence', correct: false, sql: 'select count(*) from items' }], winner: 'inline+evidence' },
  // No candidate statements at all: the pool cannot be read, so this case is not a gap kind.
  13: { passed: false, candidates: [] },
};

/** What the competitor wrote, per question, with the flags its own pipeline records. */
const THEIR_SQL: Readonly<Record<number, string>> = {
  1: 'select count(*) from items',
  2: 'select count(*) from orders',
  3: 'select sum(price) from items where price > 0',
  4: 'select count(distinct name) from items',
  5: 'select count(distinct city) from cities',
  6: 'select max(qty) from orders where qty > 1',
  7: 'select name from items',
  8: 'select sum(price) from items where price > 3',
  9: 'select item_id, count(*) from orders group by item_id',
  10: 'select name from items order by price desc limit 1',
  11: 'select count(*) from orders where qty > 1',
  12: 'select count(*) from items',
  13: 'select min(price) from items',
};

/** Flags are set on three questions only, so the lift's two denominators are small and checkable. */
const TRAITS: Readonly<Record<number, { qa_pairs?: string; fixed?: boolean; try_times?: number; pruned?: boolean }>> = {
  2: { qa_pairs: 'Sub question 1: how many orders?' },
  3: { qa_pairs: 'Sub question 1: what is the price?' },
  4: { fixed: true, try_times: 2 },
  6: { pruned: true },
};

const PREDICTIONS = QUESTIONS.map((entry) =>
  JSON.stringify({ idx: entry.id, db_id: MINI_DB, pred: THEIR_SQL[entry.id], ...(TRAITS[entry.id] ?? {}) }),
).join('\n');

function fixture(overrides: { readonly paired?: Record<string, number>; readonly predictions?: string } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'attribute-'));
  writeMiniBirdDataset(dir);
  // The fixture needs a table our candidates never read, so `table` is a kind rather than a
  // hypothetical: `cities` is one question away from every statement the arm generated.
  const writer = new DatabaseSync(join(dir, 'dev_databases', MINI_DB, `${MINI_DB}.sqlite`));
  writer.exec('create table cities (id integer primary key, city text); insert into cities values (1, \'Hangzhou\'), (2, \'Chengdu\');');
  writer.close();
  writeFileSync(
    join(dir, 'mini_dev_sqlite.json'),
    JSON.stringify(QUESTIONS.map((entry) => ({ question_id: entry.id, db_id: MINI_DB, question: entry.question, evidence: '', SQL: entry.sql, difficulty: 'simple' }))),
  );
  const env = { BIRD_SPLIT: 'minidev', BIRD_DATA: dir, BIRD_DATABASES: join(dir, 'dev_databases'), BIRD_OUT: join(dir, 'bird-eval.json') };
  const layout = resolveLayout(env, ROOT);
  const cases = QUESTIONS.map((entry) => {
    const record = OUR_CASES[entry.id] as { readonly passed: boolean; readonly candidates: readonly Candidate[]; readonly winner?: string };
    return {
      arm: ARM,
      id: String(entry.id),
      passed: record.passed,
      candidateRecall: record.candidates.some((candidate) => candidate.correct),
      candidates: record.candidates,
      ...(record.winner === undefined ? {} : { winnerSource: record.winner }),
    };
  });
  const report = join(dir, 'bird-eval.json');
  writeFileSync(report, JSON.stringify({ split: 'minidev', model: 'deepseek-chat', arms: [{ arm: ARM }], cases }));
  const score = join(dir, 'mac-sql-score.json');
  writeFileSync(
    score,
    JSON.stringify({
      competitor: { competitor: 'mac-sql', split: 'minidev' },
      reference: { arm: ARM },
      scope: { judged: 13 },
      execution: { judged: 13, passed: 12 },
      paired: { competitorOnly: 11, oursOnly: 1, both: 1, neither: 0, delta: -0.77, mde: 0.05, p: 0.01, resolves: true, needed: 40, ...(overrides.paired ?? {}) },
    }),
  );
  const predictions = join(dir, 'predictions.json');
  writeFileSync(predictions, overrides.predictions ?? PREDICTIONS);
  return { dir, layout, env, report, score, predictions };
}

async function attribute(
  base: Fixture,
  extra: readonly string[] = [],
): Promise<{ readonly outcome: AttributionOutcome; readonly settings: AttributionSettings }> {
  const argv = ['--report', base.report, '--score', base.score, '--predictions', base.predictions, ...extra];
  const settings = resolveAttributionSettings(base.env, argv, ROOT);
  const oracle = createOracle(base.layout.oracleScript, base.layout.databaseRoot);
  try {
    return { outcome: await runAttribution(settings, oracle), settings };
  } finally {
    await oracle.close();
  }
}

const kinds = (outcome: AttributionOutcome): Record<string, number> =>
  Object.fromEntries(outcome.kinds.map((entry) => [entry.gap, entry.cases]));

describe('a condition with its literals folded', () => {
  it('folds quoted strings and numbers, and nothing else', () => {
    expect(atomSkeleton("item_id = 1")).toBe('item_id = #');
    expect(atomSkeleton("name = 'pen'")).toBe("name = '?'");
    expect(atomSkeleton('price >= 1.5')).toBe('price >= #');
    expect(atomSkeleton('qty > 1 and 2 < 3')).toBe('qty > # and # < #');
  });

  it('reads the condition skeletons of a statement, deduplicated and sorted', () => {
    expect(conditionSkeletons('select count(*) from orders where item_id = 1 and qty > 1')).toEqual(['item_id = #', 'qty > #']);
    expect(conditionSkeletons('select count(*) from orders where item_id = 2 and item_id = 2')).toEqual(['item_id = #']);
    expect(conditionSkeletons('select count(*) from orders')).toEqual([]);
  });

  it('keeps the case of a literal when it asks whether two statements are the same one', () => {
    // Shape equality drops case; value equality must not. `'East Bohemia'` and `'east Bohemia'` are
    // the same shape and different values, and on dev that pair was filed as `identical` — which
    // claims the artifact contradicts itself. It does not: the judge was right and we were wrong.
    expect(literalValues("select * from t where a = 'East Bohemia' and b = 'x''y'")).toEqual(['East Bohemia', "x'y"]);
    expect(sameStatement("SELECT * FROM t WHERE a = 'East Bohemia'", "select *  from t where a = 'east Bohemia'")).toBe(false);
    // Spelling is not a difference: quoting, aliasing, case and whitespace all fold away.
    expect(sameStatement('SELECT COUNT(*) FROM account AS a WHERE a.frequency = \'POPLATEK\'', 'select count(*) from account where account.frequency = \'POPLATEK\'')).toBe(true);
    expect(gapKind("select * from t where a = 'East Bohemia'", ["select * from t where a = 'east Bohemia'"])).toBe('literal');
    expect(gapKind('select * from t where a = 1', ["SELECT * FROM t WHERE a = 1"])).toBe('identical');
  });

  it('reads the conditions of a statement written in upper case', () => {
    // The atom splitter matches `where` and `and` case-sensitively. Reading the raw statement is how
    // the first version of this comparison saw no conditions at all in 472 of MAC-SQL's 498
    // statements, published `condition: 0`, and still printed a table that looked like a reading.
    expect(conditionSkeletons("SELECT MAX(T2.qty) FROM orders T2 WHERE T2.item_id = 1 AND T2.qty > 1")).toEqual(['item_id = #', 'qty > #']);
    expect(gapKind('SELECT COUNT(*) FROM orders WHERE qty > 1', ['select count(*) from orders where item_id = 1'])).toBe('condition');
  });

  it('rewrites aliases on both sides before comparing, so an alias is not a missing condition', () => {
    // MAC-SQL writes `t1.item_id = 1` where this card's examples write `item_id = 1`. Comparing one
    // side rewritten and the other raw files every aliased filter as a condition we never wrote.
    expect(conditionSkeletons('select count(*) from orders t1 where t1.item_id = 1')).toEqual(['item_id = #']);
    expect(gapKind('select count(*) from orders t1 where t1.item_id = 1', ['select count(*) from orders where item_id = 2'])).toBe('literal');
    expect(gapKind('select count(*) from orders o where o.qty > 1', ['select count(*) from orders where item_id = 2'])).toBe('condition');
  });
});

describe('what a statement has that its rivals never wrote', () => {
  it('names a table none of the rivals reads', () => {
    expect(gapKind('select count(distinct city) from cities', ['select count(distinct name) from items'])).toBe('table');
  });

  it('names a filter none of the rivals writes', () => {
    expect(gapKind('select count(*) from orders where item_id = 1', ['select count(*) from orders'])).toBe('condition');
  });

  it('names a value inside a filter the rivals did write', () => {
    expect(gapKind('select sum(price) from items where price > 3', ['select sum(price) from items where price > 6'])).toBe('literal');
  });

  it('names an aggregate, a grouping, a window and a projection', () => {
    expect(gapKind('select count(distinct name) from items', ['select name, count(*) from items group by name'])).toBe('aggregate');
    expect(gapKind('select item_id, count(*) from orders group by item_id', ['select count(*) from orders'])).toBe('grain');
    expect(gapKind('select name from items order by price desc limit 1', ['select name from items limit 1'])).toBe('window');
    expect(gapKind('select name from items', ['select price from items limit 1'])).toBe('projection');
  });

  it('names a filter of our own that should not have been there', () => {
    expect(gapKind('select max(qty) from orders', ['select max(qty) from orders where item_id = 1'])).toBe('over-filter');
  });

  it('refuses to call the same statement a pipeline difference', () => {
    expect(gapKind('select count(*) from items', ['select count(*) from items'])).toBe('identical');
  });

  it('falls back to a name that claims nothing when the difference is not in the ladder', () => {
    // `qty > 1` is in the union of our conditions, no candidate spells it alone, and neither
    // candidate filters more narrowly than it: the ladder has no name for this pair.
    expect(
      gapKind('select count(*) from orders where qty > 1', [
        'select count(*) from orders where item_id = 1 and qty > 1',
        'select count(*) from orders where item_id = 1',
      ]),
    ).toBe('other');
  });

  it('orders the ladder so the widest fix wins when two of them apply', () => {
    // A new table *and* a new filter: the table is the wider repair, so that is the name.
    expect(gapKind('select count(*) from cities where city = \'Hangzhou\'', ['select count(*) from items'])).toBe('table');
  });

  it('every kind the ladder can produce has a place in the published order', () => {
    expect([...GAP_KINDS]).toEqual(['identical', 'table', 'condition', 'aggregate', 'grain', 'window', 'projection', 'over-filter', 'literal', 'other']);
  });
});

describe('the competitor flags, read through the same numbering', () => {
  it('resolves ids directly when there is no map', () => {
    const traits = readTraits(PREDICTIONS);
    expect(traits.get(2)?.decomposed).toBe(true);
    expect(traits.get(3)?.decomposed).toBe(true);
    expect(traits.get(4)).toEqual({ decomposed: false, refined: true, retried: true, extracted: false });
    expect(traits.get(6)?.extracted).toBe(true);
    expect(traits.get(1)).toEqual({ decomposed: false, refined: false, retried: false, extracted: false });
  });

  it('resolves a position through a declared map, and drops a position outside it', () => {
    const text = [JSON.stringify({ idx: 0, pred: 'select 1' }), JSON.stringify({ idx: 99, pred: 'select 2' }), JSON.stringify({ idx: 1, pred: 'select 3' })].join('\n');
    expect([...readTraits(text, [7, 9]).keys()]).toEqual([7, 9]);
  });

  it('skips a line that is not JSON and a line that names no integer', () => {
    const text = ['not json', JSON.stringify({ pred: 'select 1' }), JSON.stringify({ idx: 'many' }), JSON.stringify({ idx: 4, pred: 'select 4' })].join('\n');
    expect([...readTraits(text).keys()]).toEqual([4]);
  });

  it('reads qa_pairs as a list as well as a string, and a pruned schema as extracted', () => {
    const text = [JSON.stringify({ idx: 1, qa_pairs: ['a', 'b'] }), JSON.stringify({ idx: 2, extracted_schema: { items: ['id'] } })].join('\n');
    expect(readTraits(text).get(1)?.decomposed).toBe(true);
    expect(readTraits(text).get(2)?.extracted).toBe(true);
  });
});

describe('our own rows, read from the report', () => {
  it('keeps the winner statement and whether the pool held the answer', () => {
    const report = {
      cases: [
        { arm: ARM, id: 3, passed: false, candidates: [{ source: 'a', correct: false, sql: 'select 1' }, { source: 'b', correct: true, sql: 'select 2' }], winnerSource: 'a' },
        { arm: ARM, id: 4, passed: true, candidates: [{ source: 'a', correct: true, sql: 'select 3' }], winnerSource: 'a' },
      ],
    };
    const cases = readOurCases(report, ARM, 'fixture');
    expect(cases.get('3')).toEqual({
      id: '3',
      passed: false,
      candidates: [
        { source: 'a', correct: false, sql: 'select 1' },
        { source: 'b', correct: true, sql: 'select 2' },
      ],
      winner: 'select 1',
      poolHeld: true,
    });
    expect(cases.get('4')?.winner).toBe('select 3');
  });

  it('drops a row with no id and survives a record with no statements', () => {
    const cases = readOurCases({ cases: [{ arm: ARM, passed: true }, { arm: ARM, id: 9, passed: false }] }, ARM, 'fixture');
    expect([...cases.keys()]).toEqual(['9']);
    expect(cases.get('9')).toEqual({ id: '9', passed: false, candidates: [], poolHeld: false });
  });

  it('refuses a report with no cases, and one that holds a different arm', () => {
    expect(() => readOurCases({}, ARM, 'fixture')).toThrow(/holds no cases/);
    expect(() => readOurCases({ cases: [{ arm: 'other', id: 1 }] }, ARM, 'fixture')).toThrow(/has no arm select-mixed/);
  });
});

describe('attributing a real pair of files', () => {
  it('separates the questions a selector could have won from the ones it never had', async () => {
    const { outcome } = await attribute(fixture());
    expect(outcome.judged).toBe(13);
    expect(outcome.reconciled).toEqual({ competitorOnly: 11, oursOnly: 1, both: 1, neither: 0, passed: 12 });
    expect(outcome.pool).toEqual({ held: 1, missed: 9, unread: 1 });
    expect(outcome.theirs.filter((entry) => entry.pool === 'held')).toEqual([{ id: 3, pool: 'held', sources: ['evidence+values'] }]);
  });

  it('files every pool miss under the one kind its two statements differ in', async () => {
    const { outcome } = await attribute(fixture());
    // Question 6 used to be this fixture's `over-filter`, and it is now its `condition`: the same
    // question cannot play both roles without inventing a fourteenth, and the ladder's over-filter
    // branch is still covered by the unit tests that pin every rung of it.
    expect(kinds(outcome)).toEqual({ aggregate: 1, table: 1, condition: 1, projection: 1, literal: 1, grain: 1, window: 1, identical: 1, other: 1 });
    expect(outcome.kinds.find((entry) => entry.gap === 'table')?.points).toBeCloseTo(7.69, 2);
  });

  it('says where a substituted value landed, and how much of the table bucket it shares', async () => {
    const { outcome } = await attribute(fixture());
    // Question 6, end to end: their filter is on `orders.qty`, ours puts the same value on
    // `items.price`. The case is a condition gap, the value is written, and the table is not the one
    // they filtered — which is the reading the next round is priced against.
    expect(outcome.theirs.find((entry) => entry.id === 6)).toEqual({
      id: 6,
      pool: 'missed',
      gap: 'condition',
      written: 'substituted',
      link: 'other-table',
      sources: [],
    });
    expect(outcome.linking).toEqual([{ level: 'other-table', cases: 1, points: 7.69 }]);
    // Question 5 is the `table` gap. One case each and no overlap: the union is two questions, and
    // printing it as two is the only way the resolution test can be honest about one mechanism.
    expect(outcome.overlap).toEqual({ table: 1, tableLevel: 1, both: 0, either: 2, eitherPoints: 15.38 });
  });

  it('files the questions we won by what our statement had and theirs did not', async () => {
    const { outcome } = await attribute(fixture());
    // No pool field on our own wins: they wrote one statement, so there is no pool of theirs.
    expect(outcome.ours).toEqual([{ id: 2, gap: 'condition', sources: [] }]);
    expect(outcome.reverse).toEqual([{ gap: 'condition', cases: 1, points: 7.69 }]);
  });

  it('reports the competitor flags as a lift, with both denominators', async () => {
    const { outcome } = await attribute(fixture());
    const decomposed = outcome.components.find((entry) => entry.component === 'decomposed');
    // Questions 2 and 3 are the only ones their decomposer touched; they won one of the two.
    expect(decomposed).toEqual({ component: 'decomposed', on: 2, off: 11, wonOn: 1, wonOff: 10, liftPp: -40.91 });
    expect(outcome.components.find((entry) => entry.component === 'refined')).toEqual({ component: 'refined', on: 1, off: 12, wonOn: 1, wonOff: 10, liftPp: 16.67 });
    expect(outcome.components.find((entry) => entry.component === 'retried')?.on).toBe(1);
    expect(outcome.components.find((entry) => entry.component === 'extracted')?.on).toBe(1);
  });

  it('prints the reconciliation, the buckets and the resolution', async () => {
    const { outcome } = await attribute(fixture());
    const lines = attributeLines(outcome);
    expect(lines[0]).toContain('attribution on 13 judged question(s) — mac-sql against select-mixed, minidev');
    expect(lines[1]).toContain('11 only theirs, 1 only ours, 1 both, 0 neither');
    expect(lines.join('\n')).toContain('our pool held a correct statement');
    expect(lines.join('\n')).toContain('selection share (7.69pp) clears the resolution');
    expect(lines.join('\n')).toContain('the widest kind, identical, is 7.69pp and clears it');
    expect(lines.join('\n')).toContain('no candidate statement recorded');
  });

  it('says a bucket under the resolution is a bucket under the resolution', async () => {
    const { outcome } = await attribute(fixture({ paired: { mde: 0.2 } }));
    const lines = attributeLines(outcome).join('\n');
    // An MDE of 20pp covers every bucket this fixture holds, so the run can name them and price none.
    expect(lines).toContain('the selection share (7.69pp) is inside the resolution, so this run cannot price it');
    expect(lines).toContain('no gap kind clears it');
  });

  it('writes the reading beside the score artifact, and to --out when one is given', async () => {
    const base = fixture();
    const { outcome, settings } = await attribute(base);
    expect(writeAttribution(settings, outcome)).toBe(join(base.dir, 'mac-sql-attribution.json'));
    const readings = JSON.parse(readFileSync(join(base.dir, 'mac-sql-attribution.json'), 'utf8')) as AttributionOutcome;
    expect(readings.reconciled.competitorOnly).toBe(11);
    const elsewhere = join(base.dir, 'elsewhere.json');
    writeAttribution({ ...settings, out: elsewhere }, outcome);
    expect(JSON.parse(readFileSync(elsewhere, 'utf8'))).toMatchObject({ judged: 13 });
  });

  it('runs from the command line, prints the table, and writes the artifact', async () => {
    const base = fixture();
    const printed: string[] = [];
    const code = await main(
      ['--report', base.report, '--score', base.score, '--predictions', base.predictions],
      ROOT,
      base.env,
      (line) => printed.push(line),
      () => undefined,
    );
    expect(code).toBe(0);
    expect(printed.join('\n')).toContain('reconciled with the score');
    expect(printed.join('\n')).toContain('wrote ');
    expect(readFileSync(join(base.dir, 'mac-sql-attribution.json'), 'utf8')).toContain('"judged": 13');
  });

  it('prints one JSON object with --json and no artifact line', async () => {
    const base = fixture();
    const printed: string[] = [];
    await main(['--report', base.report, '--score', base.score, '--predictions', base.predictions, '--json'], ROOT, base.env, (line) => printed.push(line));
    const parsed = JSON.parse(printed.join('\n')) as AttributionOutcome & { lines: string[] };
    expect(parsed.judged).toBe(13);
    expect(parsed.lines.some((line) => line.includes('reconciled with the score'))).toBe(true);
  });
});

describe('refusing to attribute what does not join', () => {
  it('refuses a score whose counts this run cannot reproduce', async () => {
    const base = fixture({ paired: { competitorOnly: 10 } });
    await expect(attribute(base)).rejects.toThrow(
      /disagrees with .* on competitorOnly \(11 here, 10 published\); two readings of the same pair of files must print the same counts/,
    );
  });

  it('refuses a score with no paired block, and one that names no arm', async () => {
    const base = fixture();
    const score = JSON.parse(readFileSync(base.score, 'utf8')) as Record<string, unknown>;
    writeFileSync(base.score, JSON.stringify({ ...score, paired: undefined }));
    await expect(attribute(base)).rejects.toThrow(/carries no paired block/);
    writeFileSync(base.score, JSON.stringify({ ...score, reference: {} }));
    await expect(attribute(base)).rejects.toThrow(/names no reference arm/);
  });

  it('refuses flags that name a question the statements do not', async () => {
    const base = fixture({ predictions: `${PREDICTIONS}\n${JSON.stringify({ idx: 404, pred: 'select 1' })}` });
    await expect(attribute(base)).rejects.toThrow(/component flags name 1 question\(s\) the prediction ledger does not hold \(404\)/);
  });

  it('reports a published execution count it cannot reproduce, without refusing the join', async () => {
    const base = fixture();
    const score = JSON.parse(readFileSync(base.score, 'utf8')) as Record<string, unknown>;
    writeFileSync(base.score, JSON.stringify({ ...score, execution: { judged: 13, passed: 11 }, scope: { judged: 14 } }));
    const { outcome } = await attribute(base);
    expect(outcome.problems).toEqual([
      `${base.score} published 11 correct statement(s) and this run executed 12`,
      `${base.score} judged 14 question(s) and this run executed 13; the four counts agree, so the difference sits outside the pairing`,
    ]);
    expect(attributeLines(outcome).join('\n')).toContain('problem: ');
  });
});

describe('the command line contract', () => {
  it('takes the report from the layout when --report is absent', () => {
    const base = fixture();
    const settings = resolveAttributionSettings(base.env, ['--score', base.score, '--predictions', base.predictions], ROOT);
    expect(settings.report).toBe(base.layout.out);
    expect(settings.json).toBe(false);
    expect(settings.idMap).toBeUndefined();
    expect(settings.out).toBeUndefined();
  });

  it('takes --id-map and --out and --json', () => {
    const settings = resolveAttributionSettings({}, ['--score', 's', '--predictions', 'p', '--id-map', 'm', '--out', 'o', '--json'], ROOT);
    expect([settings.idMap, settings.out, settings.json]).toEqual(['m', 'o', true]);
  });

  it('refuses a missing --score, a missing --predictions, and a flag with no value', () => {
    expect(() => resolveAttributionSettings({}, ['--predictions', 'p'], ROOT)).toThrow(/--score is required/);
    expect(() => resolveAttributionSettings({}, ['--score', 's'], ROOT)).toThrow(/--predictions is required/);
    expect(() => resolveAttributionSettings({}, ['--score', '--json'], ROOT)).toThrow(/--score needs a value/);
  });

  it('prints the refusal and returns 1 instead of a stack trace', async () => {
    const errors: string[] = [];
    expect(await main([], ROOT, {}, () => undefined, (line) => errors.push(line))).toBe(1);
    expect(errors).toEqual(['--score is required: attribution is a reading of a score, not a second opinion about one']);
    const base = fixture({ paired: { competitorOnly: 3 } });
    const again: string[] = [];
    expect(
      await main(['--report', base.report, '--score', base.score, '--predictions', base.predictions], ROOT, base.env, () => undefined, (line) => again.push(line)),
    ).toBe(1);
    expect(again.join('\n')).toContain('two readings of the same pair of files must print the same counts');
  });

  it('knows when it is the entry point', () => {
    expect(isEntry(undefined, 'file:///x')).toBe(false);
    expect(isEntry('/workspace/nl2charts/eval/competitors/attribute.ts', 'file:///other')).toBe(false);
    expect(isEntry('/workspace/nl2charts/eval/competitors/attribute.ts', 'file:///workspace/nl2charts/eval/competitors/attribute.ts')).toBe(true);
  });
});

describe('the reading it prints when there is nothing to read', () => {
  it('says so rather than printing an empty table', () => {
    const outcome: AttributionOutcome = {
      competitor: 'mac-sql',
      arm: ARM,
      split: 'minidev',
      judged: 4,
      reconciled: { competitorOnly: 0, oursOnly: 0, both: 0, neither: 4, passed: 0 },
      theirs: [],
      ours: [],
      pool: { held: 0, missed: 0, unread: 0 },
      kinds: [],
      reverse: [],
      conditionKinds: [],
      linking: [],
      overlap: { table: 0, tableLevel: 0, both: 0, either: 0, eitherPoints: 0 },
      components: [],
      collinear: [],
      mde: 5,
      problems: [],
    };
    const lines = attributeLines(outcome).join('\n');
    expect(lines).toContain('nothing: every pool miss is unreadable');
    expect(lines).toContain('verdict: nothing could be attributed');
    expect(lines).toContain('questions they won and we did not');
  });

  it('prints a pool-held count of zero without a verdict about selection', () => {
    const outcome: AttributionOutcome = {
      competitor: 'mac-sql',
      arm: ARM,
      split: 'minidev',
      judged: 10,
      reconciled: { competitorOnly: 2, oursOnly: 0, both: 0, neither: 8, passed: 2 },
      theirs: [],
      ours: [],
      pool: { held: 0, missed: 2, unread: 0 },
      kinds: [{ gap: 'table', cases: 2, points: 20 }],
      reverse: [],
      conditionKinds: [],
      linking: [],
      overlap: { table: 0, tableLevel: 0, both: 0, either: 0, eitherPoints: 0 },
      components: [],
      collinear: [],
      mde: 5,
      problems: [],
    };
    const lines = attributeLines(outcome).join('\n');
    expect(lines).not.toContain('selection share');
    expect(lines).toContain('the widest kind, table, is 20.00pp and clears it');
  });
});

describe('a pool-held question carries no gap kind', () => {
  it('does not try to name a difference for a statement that already existed', async () => {
    const { outcome } = await attribute(fixture());
    expect(outcome.theirs.filter((entry) => entry.pool === 'held').every((entry) => entry.gap === undefined)).toBe(true);
  });

  it('does not file a condition kind either, because there was no condition gap to file', async () => {
    // The dev reading had 61 condition gaps and printed a breakdown adding up to 45 cases, because
    // 11 selection failures were passed through `conditionKindOf` with no gap at all. The fixture's
    // third question is that shape on purpose: the pool held `sum(price) ... where price > 0`, the
    // selector took `count(price)`, and their statement is the one in the pool. Filed as `absent`,
    // it would be counted in a total printed directly beneath the 61.
    const { outcome } = await attribute(fixture());
    const held = outcome.theirs.filter((entry) => entry.pool === 'held');
    expect(held.length).toBe(1);
    expect(held.every((entry) => entry.written === undefined)).toBe(true);
    expect(outcome.problems).toEqual([]);
  });

  it('names the cases a breakdown would count outside the bucket above it', async () => {
    const { outcome } = await attribute(fixture());
    // A guard that can only be reached by a bug is a guard nobody tests, so the rule is a function:
    // given the cases, which ones carry a kind they were never entitled to.
    expect(strayConditionKinds(outcome.theirs)).toEqual([]);
    const stray = [
      { id: 7, pool: 'held', written: 'absent', sources: [] },
      { id: 8, pool: 'missed', gap: 'condition', written: 'absent', sources: [] },
      { id: 9, pool: 'missed', gap: 'table', sources: [] },
    ] as const;
    expect(strayConditionKinds(stray).map((entry) => entry.id)).toEqual([7]);
    // The sentence, not just the count: a reader whose breakdown is wrong needs to know that the
    // total it prints is not the size of the bucket above it.
    expect(strayKindProblems(stray)).toEqual([
      '1 case(s) carry a condition kind without a condition gap (7); the breakdown would count them, so the total it prints is not the size of the bucket above it',
    ]);
    expect(strayKindProblems([])).toEqual([]);
  });
});

/**
 * The same reading on a pair of files that are missing one field each.
 *
 * A live artifact is allowed to be thinner than the one in this file's main fixture: a competitor
 * that numbers nothing, a run whose execution block was written before the field existed, a case
 * whose candidate statements were recorded without their text. Each of those is a branch in the
 * reader, and a reader whose degenerate branches are only reachable by editing the source is a
 * reader nobody has run.
 */
function sparse(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'attribute-sparse-'));
  writeMiniBirdDataset(dir);
  const env = { BIRD_SPLIT: 'minidev', BIRD_DATA: dir, BIRD_DATABASES: join(dir, 'dev_databases'), BIRD_OUT: join(dir, 'bird-eval.json') };
  const layout = resolveLayout(env, ROOT);
  const questions = [
    { question_id: 101, db_id: MINI_DB, question: 'How many items are there?', evidence: '', SQL: 'select count(*) from items', difficulty: 'simple' },
    // A gold that will not run: both sides leave the denominator rather than being judged on it.
    { question_id: 102, db_id: MINI_DB, question: 'How many ghost rows?', evidence: '', SQL: 'select count(*) from missing_table', difficulty: 'simple' },
    { question_id: 105, db_id: MINI_DB, question: 'What is the cheapest price?', evidence: '', SQL: 'select min(price) from items', difficulty: 'simple' },
    // Both sides wrong: the case is neither a win nor a loss and must not enter either bucket.
    { question_id: 106, db_id: MINI_DB, question: 'How many cups are there?', evidence: '', SQL: "select count(*) from items where name = 'cup'", difficulty: 'simple' },
  ];
  writeFileSync(join(dir, 'mini_dev_sqlite.json'), JSON.stringify(questions));
  const report = join(dir, 'bird-eval.json');
  writeFileSync(
    report,
    JSON.stringify({
      cases: [
        // We won it and the record names no winner: there is no statement of ours to compare.
        { arm: ARM, id: '101', passed: true, candidates: [{ correct: true, sql: 'select count(*) from items' }] },
        { arm: ARM, id: '102', passed: false, candidates: [{ source: 'a', correct: false, sql: 'select count(*) from missing_table' }] },
        // A question the split does not hold: the join drops it rather than inventing a row.
        { arm: ARM, id: '103', passed: true, candidates: [{ source: 'a', correct: true, sql: 'select count(*) from items' }] },
        // Candidates recorded without their statements: the pool is unreadable, not missed.
        { arm: ARM, id: '105', passed: false, candidates: [{ source: 'a', correct: false }], winnerSource: 'a' },
        { arm: ARM, id: '106', passed: false, candidates: [{ source: 'a', correct: false, sql: 'select count(*) from items' }], winnerSource: 'a' },
      ],
    }),
  );
  const score = join(dir, 'mac-sql-score.json');
  writeFileSync(
    score,
    JSON.stringify({
      reference: { arm: ARM },
      paired: { competitorOnly: 1, oursOnly: 1, both: 0, neither: 1 },
    }),
  );
  const predictions = join(dir, 'predictions.json');
  writeFileSync(
    predictions,
    [
      JSON.stringify({ idx: 101, pred: 'select 1', pruned: true }),
      '',
      JSON.stringify({ idx: 105, pred: 'select min(price) from items', pruned: true }),
      // 106 is missing on purpose: a pipeline that skips a question is a pipeline that did not win
      // it, and the reader has to say that rather than failing on the absent record.

    ].join('\n'),
  );
  return { dir, layout, env, report, score, predictions };
}

describe('a pair of files that are missing one field each', () => {
  it('reads the coordinates it was given and names the rest rather than assuming them', async () => {
    const base = sparse();
    const { outcome } = await attribute(base);
    // No competitor block: the split comes from the layout and the name is the word "competitor".
    expect(outcome.competitor).toBe('competitor');
    expect(outcome.split).toBe('minidev');
    // The broken gold leaves the denominator, and the question the split does not hold never joins.
    expect(outcome.judged).toBe(3);
    expect(outcome.reconciled).toEqual({ competitorOnly: 1, oursOnly: 1, both: 0, neither: 1, passed: 1 });
    expect(outcome.theirs).toEqual([{ id: 105, pool: 'unread', sources: [] }]);
    expect(outcome.pool).toEqual({ held: 0, missed: 0, unread: 1 });
    // Our win has no statement to compare, so it is filed under the name that claims nothing.
    expect(outcome.ours).toEqual([{ id: 101, sources: [] }]);
    // No MDE published: the reading says zero rather than inventing a resolution.
    expect(outcome.mde).toBe(0);
    expect(outcome.problems).toEqual([]);
  });

  it('refuses to call a rate a lift when a flag has no contrast', async () => {
    const { outcome } = await attribute(sparse());
    // Nothing was refined, retried or decomposed, and everything was pruned. Three flags have no
    // `on` half and one has no `off` half, so none of the four has a lift to print: the numbers that
    // would appear there are rates, and a rate is what this column must not contain.
    expect(outcome.components.map((entry) => entry.liftPp)).toEqual([null, null, null, null]);
    // Two questions carry flags at all: the one the competitor skipped has no record to read them
    // from, so it leaves the component denominators rather than counting as "did not fire".
    expect(outcome.components.map((entry) => [entry.on, entry.off])).toEqual([[0, 2], [0, 2], [0, 2], [2, 0]]);
    const lines = attributeLines(outcome).join('\n');
    expect(lines).toContain('no contrast: it fired on no question');
    expect(lines).toContain('no contrast: it fired on every question');
  });

  it('groups flags that split the questions the same way, so one event is not read as two', async () => {
    const { outcome } = await attribute(sparse());
    // Nothing decomposed, refined or retried: the three flags have the same partition of the run, so
    // there is one reading here wearing three names, and the table says so beside them.
    expect(outcome.collinear).toEqual([{ components: ['decomposed', 'refined', 'retried'], on: 0, off: 2, wonOn: 0, wonOff: 1 }]);
    const lines = attributeLines(outcome).join('\n');
    expect(lines).toContain('decomposed, refined and retried split the questions identically (0 of 0 won when it fired) — one event, 3 names');
  });

  it('merges the two flags that fired on the same question and not the one that tied on totals', async () => {
    const { outcome } = await attribute(fixture());
    // The refiner and the retry both fire on the one question whose first attempt failed — that is a
    // real identity. The extractor fires on a *different* question with the same totals (1 on, 12
    // off), and grouping by counts — which the first version of this did — merged all three into one
    // "event". The partition is the set, not the size.
    expect(outcome.collinear.map((group) => group.components)).toEqual([['refined', 'retried']]);
    const extracted = outcome.components.find((entry) => entry.component === 'extracted');
    expect([extracted?.on, extracted?.off]).toEqual([1, 12]);
    expect(attributeLines(outcome).join('\n')).toContain('refined and retried split the questions identically');
  });

  it('reads a pipeline that numbers its answers by row through the map the score used', async () => {
    const renumbered = fixture();
    // The same statements, numbered 0..12 as MAC-SQL's runner numbers them, plus the map that says
    // which question each position stands for. Without the map this file answers nothing.
    writeFileSync(
      renumbered.predictions,
      QUESTIONS.map((entry, position) => JSON.stringify({ idx: position, pred: THEIR_SQL[entry.id] })).join('\n'),
    );
    const map = join(renumbered.dir, 'subset.json');
    writeFileSync(map, JSON.stringify(QUESTIONS.map((entry) => ({ question_id: entry.id }))));
    const { outcome } = await attribute(renumbered, ['--id-map', map]);
    expect(outcome.reconciled).toEqual({ competitorOnly: 11, oursOnly: 1, both: 1, neither: 0, passed: 12 });
    expect(outcome.judged).toBe(13);
  });

  it('counts a question the competitor never answered as one it did not win', async () => {
    const { outcome } = await attribute(sparse());
    // 106 has no prediction line at all. It stays in the denominator as `neither` — the reading is
    // about what each side achieved, and a skipped question is achieved by nobody.
    expect(outcome.reconciled).toEqual({ competitorOnly: 1, oursOnly: 1, both: 0, neither: 1, passed: 1 });
    expect(outcome.judged).toBe(3);
  });

  it('refuses a paired count that is not a number', async () => {
    const base = fixture();
    const score = JSON.parse(readFileSync(base.score, 'utf8')) as { paired: Record<string, unknown> };
    writeFileSync(base.score, JSON.stringify({ ...score, paired: { ...score.paired, both: 'one' } }));
    await expect(attribute(base)).rejects.toThrow(/paired\.both is not a number/);
  });
});

describe('a refusal is a sentence, not a stack trace', () => {
  it('renders anything thrown as one line', () => {
    expect(messageOf(new Error('it broke'))).toBe('it broke');
    expect(messageOf('it broke')).toBe('it broke');
    expect(messageOf(17)).toBe('17');
  });

  it('closes the oracle it opened when the reading fails after it was constructed', async () => {
    const base = fixture();
    const errors: string[] = [];
    // The settings resolve, the oracle is created, and then the report turns out not to exist: the
    // failure path has to give the oracle back, and this is the only test that exercises a `finally`
    // reached with something to close.
    const code = await main(
      ['--report', join(base.dir, 'absent.json'), '--score', base.score, '--predictions', base.predictions],
      ROOT,
      base.env,
      () => undefined,
      (line) => errors.push(line),
    );
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('absent.json');
  });

  it('prints the problems it could not resolve and still exits zero', async () => {
    const base = fixture();
    const score = JSON.parse(readFileSync(base.score, 'utf8')) as { execution: Record<string, unknown> };
    writeFileSync(base.score, JSON.stringify({ ...score, execution: { judged: 13, passed: 4 } }));
    const errors: string[] = [];
    const code = await main(['--report', base.report, '--score', base.score, '--predictions', base.predictions], ROOT, base.env, () => undefined, (line) => errors.push(line));
    expect(code).toBe(0);
    expect(errors).toEqual([`${base.score} published 4 correct statement(s) and this run executed 12`]);
  });
});

describe('where the value of a `condition` gap went', () => {
  it('files a value their statement compares on a column ours never names as absent', () => {
    expect(conditionKindOf("select 1 from t where school type = 'Public'", "select 1 from t where county = 'Alameda'", 'condition')).toBe('absent');
  });

  it('files a value our statement compares on another column as substituted', () => {
    expect(conditionKindOf("select 1 from t where cname = 'Contra Costa'", "select 1 from t where county = 'Contra Costa'", 'condition')).toBe('substituted');
  });

  it('files an atom that carries no literal as unstated', () => {
    expect(conditionKindOf('select 1 from t where sname is not null', 'select 1 from t where county = \'Alameda\'', 'condition')).toBe('unstated');
  });

  it('reports nothing when our statement names the column, which is the largest sub-bucket on dev', () => {
    // Same column, a different condition: they wrote `takers > 100` and we wrote `takers < 100`.
    expect(conditionKindOf("select 1 from t where takers > 100", 'select 1 from t where takers < 100', 'condition')).toBeUndefined();
  });

  it('reports nothing when the statement or the reference is unknown', () => {
    expect(conditionKindOf('select 1 from t', undefined, 'condition')).toBeUndefined();
    expect(conditionKindOf(undefined, 'select 1 from t', 'condition')).toBeUndefined();
  });

  it('reports nothing when the gap is not a condition at all', () => {
    expect(conditionKindOf("select 1 from t where c = 'x'", 'select 1 from t', 'table')).toBeUndefined();
  });

  it('prefers the strongest finding when one case carries two kinds', () => {
    const theirs = "select 1 from t where school type = 'Public' and sname is not null";
    expect(conditionKindOf(theirs, "select 1 from t where county = 'Alameda'", 'condition')).toBe('absent');
  });
});

describe('whether a substituted value landed on the right table', () => {
  const schema = schemaIndex(
    new Map([
      [
        MINI_DB,
        {
          tableNames: ['items', 'orders'],
          columnNames: [
            [-1, '*'],
            [0, 'id'],
            [0, 'name'],
            [0, 'price'],
            [1, 'id'],
            [1, 'item_id'],
            [1, 'qty'],
          ] as (readonly [number, string])[],
        },
      ],
    ]),
  ).get(MINI_DB);

  it('names a value compared on another table as the table-level difference it is', () => {
    expect(linkOfCondition("select count(*) from orders where qty = 3", "select count(*) from items where price = 3", schema)).toBe('other-table');
  });

  it('names a value compared on another column of the same table as a column choice', () => {
    expect(linkOfCondition("select count(*) from items where name = 'pen'", "select count(*) from items where price = 'pen'", schema)).toBe('same-table');
  });

  it('says nowhere when our statement compares no value at all', () => {
    expect(linkOfCondition("select count(*) from items where name = 'pen'", 'select count(*) from items', schema)).toBe('nowhere');
  });

  it('lets the table-level site name the case when one case has both', () => {
    // Two substituted atoms, one on the right table's other column and one on another table's column:
    // the wider fix names the case, because a column hint cannot move a value onto a table that was
    // never in view.
    expect(
      linkOfCondition(
        "select count(*) from orders o join items i on i.id = o.item_id where o.qty = 3 and i.name = 'pen'",
        "select count(*) from orders o join items i on i.id = o.item_id where i.price = 3 and i.id = 'pen'",
        schema,
      ),
    ).toBe('other-table');
    // The reverse order of the same two atoms changes nothing: precedence is by level, not by order.
    expect(
      linkOfCondition(
        "select count(*) from orders o join items i on i.id = o.item_id where i.name = 'pen' and o.qty = 3",
        "select count(*) from orders o join items i on i.id = o.item_id where i.id = 'pen' and i.price = 3",
        schema,
      ),
    ).toBe('other-table');
  });

  it('reports unresolved when the schema is missing rather than calling it absent', () => {
    expect(linkOfCondition("select count(*) from items where name = 'pen'", "select count(*) from items where price = 'pen'", undefined)).toBe('unresolved');
  });
});

describe('the condition breakdown the report prints', () => {
  const outcome: AttributionOutcome = {
    competitor: 'mac-sql',
    arm: ARM,
    split: 'dev',
    judged: 100,
    reconciled: { competitorOnly: 4, oursOnly: 0, both: 0, neither: 96, passed: 4 },
    theirs: [
      { id: 1, pool: 'missed', gap: 'condition', written: 'absent', sources: [] },
      { id: 2, pool: 'missed', gap: 'condition', written: 'substituted', sources: [] },
      { id: 3, pool: 'missed', gap: 'condition', sources: [] },
    ],
    ours: [],
    pool: { held: 0, missed: 3, unread: 0 },
    kinds: [{ gap: 'condition', cases: 3, points: 3 }],
    reverse: [],
    conditionKinds: [
      { kind: 'absent', cases: 1, points: 1 },
      { kind: 'substituted', cases: 1, points: 1 },
    ],
    linking: [{ level: 'other-table', cases: 1, points: 1 }],
    overlap: { table: 1, tableLevel: 1, both: 0, either: 2, eitherPoints: 2 },
    components: [],
    collinear: [],
    mde: 2.93,
    problems: [],
  };

  it('prints each kind beside its points and names what it means', () => {
    const lines = attributeLines(outcome).join('\n');
    expect(lines).toContain('of which a value written on another column');
    expect(lines).toContain('linking, not an omission');
    expect(lines).toContain('the omission the bucket was named for');
  });

  it('prints the remainder as a column that is filtered differently rather than as unreadable', () => {
    const lines = attributeLines(outcome).join('\n');
    expect(lines).toContain('the same column, another condition');
    expect(lines).not.toContain('unreadable');
  });

  it('prints a zero row for a kind the run never saw', () => {
    const lines = attributeLines({ ...outcome, conditionKinds: [{ kind: 'absent', cases: 1, points: 1 }] }).join('\n');
    expect(lines).toContain('of which an atom with no literal');
    expect(lines).toContain('0.00pp');
  });

  it('prints no remainder when every condition case carries a kind', () => {
    const full: AttributionOutcome = {
      ...outcome,
      conditionKinds: [
        { kind: 'absent', cases: 1, points: 1 },
        { kind: 'substituted', cases: 1, points: 1 },
        { kind: 'unstated', cases: 1, points: 1 },
      ],
    };
    expect(attributeLines(full).join('\n')).not.toContain('the same column, another condition');
  });

  it('prints no breakdown when the bucket is empty', () => {
    const lines = attributeLines({ ...outcome, kinds: [], conditionKinds: [] }).join('\n');
    expect(lines).not.toContain('of which a value written');
  });
});
