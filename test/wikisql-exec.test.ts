import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { createOracle } from '../eval/bird/oracle.js';
import {
  answerOf,
  digestOf,
  Judge,
  parsePredictions,
  parseSplit,
  percent,
  readingOf,
  sameBag,
  schemaOf,
} from '../eval/wikisql/exec.js';
import type { Answer, CaseReading, SplitRow } from '../eval/wikisql/exec.js';

// A real SQLite file, a real Python oracle, and the corpus's own table naming: the judge's job is
// to turn an annotation into a statement and compare answers, and every part of that is executable
// without a mock. The fixture is three columns' worth of rows so an ordered comparison and an
// unordered one can disagree.

const dirs: string[] = [];

function cache(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nl2charts-wikisql-'));
  dirs.push(dir);
  const writer = new DatabaseSync(join(dir, 'dev.db'));
  writer.exec(`
    create table table_1_2_3 (col0 real, col1 text);
    insert into table_1_2_3 values (1, 'a'), (2, 'b'), (2, 'c');
  `);
  writer.close();
  return dir;
}

const root = cache();
const oracle = createOracle(resolve('eval/bird/oracle.py'), root);
const judge = new Judge(oracle, 'dev.db');

afterAll(async () => {
  await oracle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const QUESTION = { table_id: '1-2-3', question: 'what', sql: { sel: 1, agg: 0, conds: [[0, 0, 2]] } };

/** The first question of a one-line split, as the row a judge takes. */
function onlyRow(line: string): SplitRow {
  const row = parseSplit(line)[0];
  if (row === undefined) throw new Error('the fixture line produced no question');
  return row;
}

describe('parseSplit', () => {
  it('indexes questions by position in the file', () => {
    const rows = parseSplit(
      `${JSON.stringify(QUESTION)}\n${JSON.stringify({ ...QUESTION, sql: { sel: 0, agg: 3, conds: [] } })}\n`,
    );
    expect(rows.map((row) => row.index)).toEqual([0, 1]);
    expect(rows[0]?.tableId).toBe('1-2-3');
    expect(rows[1]?.form.agg).toBe(3);
  });

  it('keeps a numeric condition value a number', () => {
    // 2,953 of the dev split's 11,545 condition values are JSON numbers, and the annotation for
    // "played for 6 years" is `[4, 0, 6]`. Coercing it to text here would hand the comparison to
    // column affinity and lose the difference the next test measures.
    const row = onlyRow(`${JSON.stringify(QUESTION)}\n`);
    expect(typeof row?.form.conds[0]?.[2]).toBe('number');
  });

  it('refuses a file whose blank line would shift the index', () => {
    expect(() => parseSplit(`\n${JSON.stringify(QUESTION)}\n`)).toThrow(/shifted the question index/);
  });
});

describe('parsePredictions', () => {
  it('reads one statement per question', () => {
    const found = parsePredictions('{"index":0,"sql":"select 1"}\n{"index":2,"sql":"select 2"}\n');
    expect([...found.keys()]).toEqual([0, 2]);
  });

  it('refuses a line that is not a prediction', () => {
    expect(() => parsePredictions('{"index":"0","sql":"select 1"}')).toThrow(/not \{index, sql\}/);
  });

  it('refuses two predictions for one question', () => {
    expect(() => parsePredictions('{"index":0,"sql":"a"}\n{"index":0,"sql":"b"}')).toThrow(/two predictions/);
  });
});

describe('schemaOf', () => {
  it('reads the column types out of the CREATE TABLE the database stores', () => {
    // `DBEngine.execute` does exactly this: first parenthesised run, split on ", ", then on space.
    const shape = schemaOf('CREATE TABLE table_1_2_3 (col0 real, col1 text)', '1-2-3');
    expect(shape.name).toBe('table_1_2_3');
    expect(shape.types).toEqual(['real', 'text']);
  });

  it('refuses a statement with no column list', () => {
    expect(() => schemaOf('CREATE TABLE t', '1-2-3')).toThrow(/no column list/);
  });

  it('refuses a column that is not a name and a type', () => {
    expect(() => schemaOf('CREATE TABLE t (col0)', '1-2-3')).toThrow(/is not "<name> <type>"/);
  });
});

describe('answerOf', () => {
  it('turns a refused statement into a named failure, not an empty result', () => {
    expect(answerOf({ ok: false, columns: [], rows: [], ms: 0, error: 'no such column' })).toEqual({
      ok: false,
      error: 'no such column',
    });
    expect(answerOf({ ok: true, columns: [], rows: [[1]], ms: 0 })).toEqual({ ok: true, rows: [[1]] });
  });

  it('names a failure the oracle did not describe', () => {
    expect(answerOf({ ok: false, columns: [], rows: [], ms: 0 })).toEqual({ ok: false, error: 'no error text' });
  });
});

describe('sameBag', () => {
  it('erases order and keeps multiplicity', () => {
    expect(sameBag([[1], [2]], [[2], [1]])).toBe(true);
    expect(sameBag([[1], [1], [2]], [[1], [2]])).toBe(false);
    expect(sameBag([[1]], [[1], [2]])).toBe(false);
    // A null cell is a value: two empty answers are the same answer, and null is not the number 0.
    expect(sameBag([[null]], [[null]])).toBe(true);
    expect(sameBag([[null]], [[0]])).toBe(false);
  });
});

describe('Judge', () => {
  it('answers a gold form through the reference template', async () => {
    const row = onlyRow(`${JSON.stringify(QUESTION)}\n`);
    const answer = await judge.goldOf(row);
    expect(answer).toEqual({ ok: true, rows: [['b'], ['c']] });
  });

  it('caches the schema it read, so a second question does not ask again', async () => {
    // Two lookups, one statement: the second call returns the cached shape, and the assertion is
    // that it is the same object rather than an equal one.
    const first = await judge.tableOf('1-2-3');
    const second = await judge.tableOf('1-2-3');
    expect(second).toBe(first);
  });

  it('refuses a table the database does not have', async () => {
    await expect(judge.tableOf('9-9-9')).rejects.toThrow(/no table named table_9_9_9/);
  });

  it('reports a schema lookup that could not run as an error', async () => {
    const missing = new Judge(oracle, 'absent.db');
    await expect(missing.tableOf('1-2-3')).rejects.toThrow(/schema lookup for 1-2-3 failed/);
  });

  it('turns a form the statement builder refuses into an error, not a zero', async () => {
    const row = onlyRow(`${JSON.stringify({ ...QUESTION, sql: { sel: 9, agg: 0, conds: [] } })}\n`);
    const answer = await judge.goldOf(row);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error).toMatch(/outside table_1_2_3/);
  });

  it('scores a prediction whose rows are the same in another order as a bag match only', async () => {
    const row = onlyRow(`${JSON.stringify(QUESTION)}\n`);
    const gold = await judge.goldOf(row);
    const pred = await judge.predictOf('1-2-3', 'select col1 from table_1_2_3 where col0 = 2 order by col1 desc');
    const reading = Judge.compare(0, gold, pred);
    expect(reading.ordered).toBe(false);
    expect(reading.bag).toBe(true);
  });

  it('scores a refused prediction as a miss with the reason kept', async () => {
    const gold: Answer = { ok: true, rows: [[1]] };
    const pred: Answer = { ok: false, error: 'no such column: nope' };
    const reading = Judge.compare(4, gold, pred);
    expect(reading).toMatchObject({ index: 4, ordered: false, bag: false });
    expect(pred).toMatchObject({ error: 'no such column: nope' });
  });

  it('does not score a question whose gold did not execute', async () => {
    const reading = Judge.compare(1, { ok: false, error: 'x' }, { ok: true, rows: [] });
    expect([reading.ordered, reading.bag]).toEqual([false, false]);
  });
});

describe('readingOf', () => {
  const cases: CaseReading[] = [
    { index: 0, gold: { ok: true, rows: [[1]] }, pred: { ok: true, rows: [[1]] }, ordered: true, bag: true },
    { index: 1, gold: { ok: true, rows: [[1]] }, pred: { ok: true, rows: [[2]] }, ordered: false, bag: false },
    { index: 2, gold: { ok: false, error: 'x' }, pred: { ok: true, rows: [] }, ordered: false, bag: false },
    { index: 3, gold: { ok: true, rows: [] }, pred: { ok: false, error: 'y' }, ordered: false, bag: false },
  ];

  it('counts each denominator separately', () => {
    const reading = readingOf(cases, 5);
    expect(reading).toEqual({ cases: 5, scored: 4, exact: 1, bag: 1, goldErrors: 1, goldEmpty: 1, predErrors: 1 });
  });
});

describe('percent', () => {
  it('rounds to two decimals and refuses to divide by zero', () => {
    expect(percent(1, 3)).toBe(33.33);
    expect(percent(2, 3)).toBe(66.67);
    expect(percent(1, 0)).toBe(0);
  });
});

describe('digestOf', () => {
  it('chains answers in question order and records a failed gold as null', () => {
    const answers: Answer[] = [
      { ok: true, rows: [[1]] },
      { ok: false, error: 'x' },
    ];
    const left = digestOf(answers);
    expect(left).toMatch(/^[0-9a-f]{64}$/u);
    // Order is part of the contract: a digest that ignored it would let two runs that answered
    // different questions agree.
    expect(digestOf([...answers].reverse())).not.toBe(left);
    expect(digestOf([{ ok: true, rows: [[1]] }, { ok: false, error: 'x' }])).toBe(left);
  });
});
