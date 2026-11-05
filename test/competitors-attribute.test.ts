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
  conditionSkeletons,
  gapKind,
  isEntry,
  main,
  messageOf,
  readOurCases,
  readTraits,
  resolveAttributionSettings,
  runAttribution,
  writeAttribution,
} from '../eval/competitors/attribute.js';
import type { AttributionOutcome, AttributionSettings } from '../eval/competitors/attribute.js';
import { createOracle } from '../eval/bird/oracle.js';
import { MINI_DB, writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();
const ARM = 'select-mixed';

/** The thirteen questions, their gold statements, and what each one is in the fixture to prove. */
const QUESTIONS = [
  { id: 1, question: 'How many items are there?', sql: 'select count(*) from items' },
  { id: 2, question: 'How many orders are for the pen?', sql: 'select count(*) from orders where item_id = 1' },
  { id: 3, question: 'What is the total price of every item?', sql: 'select sum(price) from items' },
  { id: 4, question: 'How many distinct item names are there?', sql: 'select count(distinct name) from items' },
  { id: 5, question: 'How many cities are there?', sql: 'select count(distinct city) from cities' },
  { id: 6, question: 'What is the largest quantity on an order?', sql: 'select max(qty) from orders' },
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
      { source: 'evidence+values', correct: true, sql: 'select sum(price) from items' },
    ],
    winner: 'inline+evidence',
  },
  4: { passed: false, candidates: [{ source: 'inline+evidence', correct: false, sql: 'select name, count(*) from items group by name' }], winner: 'inline+evidence' },
  5: { passed: false, candidates: [{ source: 'inline+evidence', correct: false, sql: 'select count(distinct name) from items' }], winner: 'inline+evidence' },
  6: {
    passed: false,
    candidates: [{ source: 'inline+evidence', correct: false, sql: 'select max(qty) from orders where item_id = 1' }],
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
  3: 'select sum(price) from items',
  4: 'select count(distinct name) from items',
  5: 'select count(distinct city) from cities',
  6: 'select max(qty) from orders',
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
    expect(kinds(outcome)).toEqual({ aggregate: 1, table: 1, 'over-filter': 1, projection: 1, literal: 1, grain: 1, window: 1, identical: 1, other: 1 });
    expect(outcome.kinds.find((entry) => entry.gap === 'table')?.points).toBeCloseTo(7.69, 2);
  });

  it('files the questions we won by what our statement had and theirs did not', async () => {
    const { outcome } = await attribute(fixture());
    expect(outcome.ours).toEqual([{ id: 2, pool: 'missed', gap: 'condition', sources: [] }]);
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
      components: [],
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
      components: [],
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
      JSON.stringify({ idx: 106, pred: 'select count(*) from items', pruned: true }),
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
    expect(outcome.ours).toEqual([{ id: 101, pool: 'missed', sources: [] }]);
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
    expect(outcome.components.map((entry) => [entry.on, entry.off])).toEqual([[0, 3], [0, 3], [0, 3], [3, 0]]);
    const lines = attributeLines(outcome).join('\n');
    expect(lines).toContain('no contrast: it fired on no question');
    expect(lines).toContain('no contrast: it fired on every question');
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
