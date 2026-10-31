import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildSchema,
  describeQuestionSet,
  distinctQuestions,
  loadDescriptions,
  loadQuestionSet,
  loadQuestions,
  loadTables,
  parseCsv,
  sqlType,
  stratifiedSample,
} from '../eval/bird/data.js';
import type { BirdQuestion, BirdTable } from '../eval/bird/data.js';

const directory = mkdtempSync(join(tmpdir(), 'nl2charts-bird-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function write(name: string, content: string): string {
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

describe('CSV parsing', () => {
  it('handles quoted commas, doubled quotes and embedded newlines', () => {
    const rows = parseCsv('a,b\n"x,y","he said ""hi"""\n"line1\nline2",z\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x,y', 'he said "hi"'],
      ['line1\nline2', 'z'],
    ]);
  });

  it('keeps a trailing empty field and ignores CRLF', () => {
    expect(parseCsv('a,b\r\n1,\r\n')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ]);
  });

  it('returns an empty list for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('dataset readers', () => {
  it('reads questions and type codes', () => {
    const file = write('q.json', JSON.stringify([{ question_id: 1, db_id: 'db', question: 'q', evidence: 'e', SQL: 'SELECT 1', difficulty: 'simple' }]));
    expect(loadQuestions(file)[0]?.db_id).toBe('db');
    expect(sqlType('text')).toBe('VARCHAR');
    expect(sqlType('real')).toBe('DOUBLE');
    expect(sqlType('BLOB')).toBe('BLOB');
  });

  it('reads tables with their column and key layout', () => {
    const file = write(
      't.json',
      JSON.stringify([
        {
          db_id: 'db',
          table_names: ['a readable', 'b readable'],
          table_names_original: ['a', 'b'],
          column_names: [
            [-1, '*'],
            [0, 'id'],
            [1, 'a id'],
          ],
          column_names_original: [
            [-1, '*'],
            [0, 'id'],
            [1, 'a_id'],
          ],
          column_types: ['text', 'integer', 'integer'],
          foreign_keys: [[2, 1]],
        },
      ]),
    );
    const table = loadTables(file).get('db') as BirdTable;
    expect(table.tableNames).toEqual(['a', 'b']);
    expect(table.columnNames[2]?.[1]).toBe('a_id');
    expect(table.columnNamesReadable[2]?.[1]).toBe('a id');
    expect(table.foreignKeys).toEqual([[2, 1]]);
  });

  it('falls back to the readable names when originals are absent', () => {
    const file = write(
      't2.json',
      JSON.stringify([
        { db_id: 'db2', table_names: ['t'], column_names: [[-1, '*'], [0, 'c']], column_types: ['text'], foreign_keys: [] },
      ]),
    );
    const table = loadTables(file).get('db2') as BirdTable;
    expect(table.tableNames).toEqual(['t']);
    expect(table.columnNames[1]?.[1]).toBe('c');
  });

  it('merges a column description and its value legend into one comment', () => {
    const csv = write(
      'a.csv',
      'original_column_name,column_name,column_description,data_format,value_description\nid,,the unique identifier,integer,\nstatus,,order status,text,"completed: finished\nrefunded: reversed"\n',
    );
    const notes = loadDescriptions(directory, ['a']);
    expect(notes.get('a')?.get('id')).toEqual({ description: 'the unique identifier' });
    expect(notes.get('a')?.get('status')?.values).toContain('completed: finished refunded: reversed');
    expect(csv).toContain('a.csv');
  });

  it('skips a table with no description file instead of failing', () => {
    expect(loadDescriptions(join(directory, 'missing'), ['nothing']).size).toBe(0);
  });

  it('survives the four ways a description row can be unusable', () => {
    // An empty file (no header), a row shorter than the header, a row with no name, and a row
    // whose only content is a value legend. Every one of them is a real shape in BIRD's own
    // CSVs, and none of them may become a comment with the word "undefined" in it.
    write('empty.csv', '');
    write(
      'ragged.csv',
      [
        'original_column_name,column_name,column_description,data_format,value_description',
        'id,,primary key,integer,',
        ',humanised only,ignored,text,',
        'short',
        'region,,where the order came from,text,north: the north',
        'status,,,text,"open: still open"',
      ].join('\n'),
    );
    const notes = loadDescriptions(directory, ['empty', 'ragged']);
    expect(notes.has('empty')).toBe(false);
    expect([...(notes.get('ragged')?.keys() ?? [])]).toEqual(['id', 'region', 'status']);
    expect(notes.get('ragged')?.get('id')).toEqual({ description: 'primary key' });
    // Both halves present, and one half alone: a note is the parts that exist, never a
    // comment with the word "undefined" in it.
    expect(notes.get('ragged')?.get('region')).toEqual({ description: 'where the order came from', values: 'north: the north' });
    expect(notes.get('ragged')?.get('status')).toEqual({ values: 'open: still open' });
  });

  it('flattens a wrapped description and cuts it at the budget', () => {
    // A BIRD description can carry newlines and markdown; a prompt line cannot. The cut is
    // 180 characters because a card with three wrapped paragraphs per column is a card that
    // silently loses its last tables.
    const long = `first line\n\nsecond line ${'x'.repeat(400)}`;
    // Quoted, because the newlines are part of the field rather than a row break.
    write('long.csv', `original_column_name,column_name,column_description,data_format,value_description\nid,,"${long}",integer,\n`);
    const notes = loadDescriptions(directory, ['long']);
    const description = notes.get('long')?.get('id')?.description as string;
    expect(description.startsWith('first line second line xxx')).toBe(true);
    expect(description).toHaveLength(180);
    expect(description.endsWith('...')).toBe(true);
  });
});

describe('schema construction', () => {
  const table: BirdTable = {
    db_id: 'db',
    tableNames: ['orders', 'customers'],
    tableNamesReadable: ['orders', 'customers'],
    columnNames: [
      [-1, '*'],
      [0, 'id'],
      [0, 'CustomerID'],
      [1, 'id'],
      [1, 'Segment'],
    ],
    columnNamesReadable: [
      [-1, '*'],
      [0, 'id'],
      [0, 'customer id'],
      [1, 'id'],
      [1, 'segment'],
    ],
    columnTypes: ['text', 'integer', 'integer', 'integer', 'text'],
    foreignKeys: [[2, 3]],
  };

  const notes = new Map([
    [
      'orders',
      new Map([
        ['id', { description: 'order identifier' }],
        ['CustomerID', { description: 'who ordered' }],
      ]),
    ],
    ['customers', new Map([['Segment', { description: 'segment', values: 'smb: small' }]])],
  ]);

  it('uses the identifiers the database actually has', () => {
    const schema = buildSchema(table, notes, { withNotes: false });
    expect(schema[0]?.columns.map((column) => column.name)).toEqual(['id', 'CustomerID']);
    expect(schema[0]?.columns[0]?.type).toBe('BIGINT');
    expect(schema[0]?.columns[0]?.comment).toBeUndefined();
    expect(schema[1]?.foreignKeys).toBeUndefined();
  });

  it('attaches the readable label and the description only when asked', () => {
    const schema = buildSchema(table, notes, { withNotes: true });
    expect(schema[0]?.columns[1]?.name).toBe('CustomerID');
    expect(schema[0]?.columns[1]?.comment).toBe('customer id - who ordered');
    expect(schema[1]?.columns[1]?.comment).toBe('segment - segment (smb: small)');
    expect(schema[0]?.foreignKeys).toEqual(['orders.CustomerID = customers.id']);
  });

  it('omits a table with no columns left', () => {
    const empty: BirdTable = {
      db_id: 'db',
      tableNames: ['void'],
      tableNamesReadable: ['void'],
      columnNames: [[-1, '*']],
      columnNamesReadable: [[-1, '*']],
      columnTypes: ['text'],
      foreignKeys: [],
    };
    expect(buildSchema(empty, new Map(), { withNotes: true })).toEqual([{ table: 'void', columns: [] }]);
  });

  it('falls back to a text type when the manifest is shorter than its column list', () => {
    // `dev_tables.json` carries one type per column; a manifest that carries fewer would
    // otherwise put the string "undefined" in the card, which reads as a SQL type to a model.
    const short: BirdTable = {
      db_id: 'db',
      tableNames: ['t'],
      tableNamesReadable: ['t'],
      columnNames: [[0, 'a'], [0, 'b']],
      columnNamesReadable: [[0, 'a'], [0, 'b']],
      columnTypes: ['integer'],
      foreignKeys: [],
    };
    expect(buildSchema(short, new Map(), { withNotes: false })[0]?.columns.map((column) => column.type)).toEqual(['BIGINT', 'VARCHAR']);
  });
});

describe('stratified sampling', () => {
  const make = (id: number, difficulty: BirdQuestion['difficulty']): BirdQuestion => ({
    question_id: id,
    db_id: 'db',
    question: `q${id}`,
    evidence: '',
    SQL: 'SELECT 1',
    difficulty,
  });
  const questions = [
    make(5, 'challenging'),
    make(1, 'simple'),
    make(4, 'moderate'),
    make(2, 'simple'),
    make(6, 'challenging'),
    make(3, 'moderate'),
  ];
  const counts = (picked: readonly BirdQuestion[]): Record<string, number> => {
    const out: Record<string, number> = { simple: 0, moderate: 0, challenging: 0 };
    for (const question of picked) out[question.difficulty] = (out[question.difficulty] ?? 0) + 1;
    return out;
  };

  it('returns everything when the limit exceeds the input', () => {
    expect(stratifiedSample(questions, 10)).toHaveLength(6);
  });

  it('allocates in proportion to the split, not one per bucket', () => {
    // The dev split is 60.3% simple, 30.2% moderate, 9.5% challenging. A sampler that takes
    // one per bucket turns that into 33/33/33, which over-weights the hardest bucket by
    // 3.5x: a 120-question run then reports an accuracy no full-split run reproduces, and
    // the word "stratified" in the artifact describes a mix it never had.
    const lopsided = [
      ...Array.from({ length: 10 }, (_, index) => make(index + 1, 'simple')),
      ...Array.from({ length: 5 }, (_, index) => make(20 + index, 'moderate')),
      ...Array.from({ length: 5 }, (_, index) => make(40 + index, 'challenging')),
    ];
    expect(counts(stratifiedSample(lopsided, 10))).toEqual({ simple: 5, moderate: 3, challenging: 2 });
  });

  it('keeps a rare bucket rare instead of promoting it', () => {
    const rare = [
      ...Array.from({ length: 90 }, (_, index) => make(index + 1, 'simple')),
      ...Array.from({ length: 10 }, (_, index) => make(100 + index, 'challenging')),
    ];
    expect(counts(stratifiedSample(rare, 10))).toEqual({ simple: 9, moderate: 0, challenging: 1 });
  });

  it('gives a bucket that runs out to the ones that still have questions', () => {
    // One simple question in a split of ten: its quota is 0.5 of a case, and the sample has
    // to come from somewhere or it is smaller than the limit that was asked for.
    const lopsided = [make(1, 'simple'), ...Array.from({ length: 9 }, (_, index) => make(2 + index, 'moderate'))];
    expect(counts(stratifiedSample(lopsided, 5))).toEqual({ simple: 1, moderate: 4, challenging: 0 });
    expect(stratifiedSample([make(1, 'simple')], 5)).toHaveLength(1);
  });

  it('returns the sample in the split order, and the same sample twice', () => {
    const once = stratifiedSample(questions, 4).map((question) => question.question_id);
    expect([...once].sort((left, right) => left - right)).toEqual(once);
    expect(stratifiedSample(questions, 4).map((question) => question.question_id)).toEqual(once);
    // ...and it is not the head of the file: four of six questions, taken in id order, would be
    // [1, 2, 3, 4]. A seeded order within each stratum is what keeps a sample from being a
    // prefix — see the database test below for what a prefix costs.
    expect(once).not.toEqual([1, 2, 3, 4]);
  });

  it('does not take the head of the file, because the file is grouped by database', () => {
    // BIRD's dev file lists one database after another, so consuming a stratum in id order
    // samples the first databases and never reaches the rest: the 120-question runs of this
    // benchmark scored 2 of dev's 11 databases, with `california_schools` at 74% of the sample
    // against 5.8% of the split, which is why they reported 49% where the split reports 63%.
    const grouped = [
      ...Array.from({ length: 40 }, (_, index) => ({ ...make(index + 1, 'simple'), db_id: 'a' })),
      ...Array.from({ length: 40 }, (_, index) => ({ ...make(41 + index, 'simple'), db_id: 'b' })),
      ...Array.from({ length: 40 }, (_, index) => ({ ...make(81 + index, 'simple'), db_id: 'c' })),
    ];
    const picked = stratifiedSample(grouped, 30);
    expect(picked).toHaveLength(30);
    expect(new Set(picked.map((question) => question.db_id)).size).toBeGreaterThan(1);
    // A prefix of 30 would have been 'a' alone.
    expect(picked.filter((question) => question.db_id === 'a').length).toBeLessThan(30);
  });

  it('files an unrecognised difficulty with the moderates rather than dropping it', () => {
    // A split whose difficulty column says something new must still be sampled: the
    // alternative is a question that silently never runs. The limit has to be below the
    // input size, or the sampler returns the whole file and never consults the buckets.
    const odd = [{ ...make(1, 'simple'), difficulty: 'unknown' as BirdQuestion['difficulty'] }, make(2, 'simple'), make(3, 'simple')];
    const picked = stratifiedSample(odd, 2).map((question) => question.question_id);
    expect(picked).toHaveLength(2);
    expect(picked).toContain(1);
  });
});

/**
 * A file of rows is not a file of questions.
 *
 * Mini-Dev is both: 500 rows, 498 ids, because ids 137 and 138 each appear twice, byte for byte.
 * These cases hold the two rules that follow — a duplicate is one question counted once, and an id
 * that names two different questions is refused — because everything downstream joins on the id:
 * a competitor's answers, our own cases, and the pairing between them.
 */
describe('one row per question', () => {
  const make = (id: number, overrides: Partial<BirdQuestion> = {}): BirdQuestion => ({
    question_id: id,
    db_id: 'db',
    question: `q${id}`,
    evidence: '',
    SQL: 'SELECT 1',
    difficulty: 'simple',
    ...overrides,
  });

  it('is the whole file when every id appears once, and reports nothing repeated', () => {
    const set = distinctQuestions([make(1), make(2), make(3)]);
    expect(set.rows).toBe(3);
    expect(set.questions.map((question) => question.question_id)).toEqual([1, 2, 3]);
    expect(set.repeats).toEqual([]);
  });

  it('keeps one row for a byte-for-byte repeat and reports where the copies were', () => {
    const set = distinctQuestions([make(1), make(2), make(1), make(3), make(1)]);
    expect(set.rows).toBe(5);
    expect(set.questions.map((question) => question.question_id)).toEqual([1, 2, 3]);
    expect(set.repeats).toEqual([{ id: 1, positions: [0, 2, 4] }]);
  });

  it('keeps the first occurrence, so the pool is in the file\'s own order', () => {
    const set = distinctQuestions([make(2), make(7, { SQL: 'SELECT 7' }), make(2)]);
    // First occurrence wins: the pool is the file's order, not the order of last mention.
    expect(set.questions.map((question) => question.question_id)).toEqual([2, 7]);
    expect(set.questions[1]?.SQL).toBe('SELECT 7');
  });

  it('refuses an id that names two different questions, naming the field that disagrees', () => {
    // Not a duplicate: two questions with one id. Keeping either one would make the id a key that
    // silently answers a different question than the one it was asked about.
    expect(() => distinctQuestions([make(4), make(4, { question: 'a different question' })])).toThrow(
      /question 4 appears at rows 0 and 1 with different content \(question\)/,
    );
  });

  it('refuses a repeat whose only difference is a field that is absent from one copy', () => {
    // The records differ, but no shared field explains it: the message has to say so rather than
    // name a field that matches on both sides.
    const withNull = { ...make(9), note: null } as unknown as BirdQuestion;
    expect(() => distinctQuestions([make(9), withNull])).toThrow(/different content \(no field differs\)/);
  });

  it('treats a record with its keys in another order as the same record', () => {
    // A JSON object's key order is not part of its content, and a re-serialised duplicate is the
    // same duplicate.
    const reordered = JSON.parse('{"difficulty":"simple","SQL":"SELECT 1","evidence":"","question":"q5","db_id":"db","question_id":5}') as BirdQuestion;
    const set = distinctQuestions([make(5), reordered]);
    expect(set.questions).toHaveLength(1);
    expect(set.repeats).toEqual([{ id: 5, positions: [0, 1] }]);
  });

  it('sees a difference inside a nested value', () => {
    const nested = { ...make(6), tags: ['a'] } as unknown as BirdQuestion;
    const other = { ...make(6), tags: ['b'] } as unknown as BirdQuestion;
    expect(() => distinctQuestions([nested, other])).toThrow(/question 6 .* \(tags\)/);
  });

  it('reads a file through the same rule, and can say what it found', () => {
    const file = write(
      'dupes.json',
      JSON.stringify([
        { question_id: 137, db_id: 'db', question: 'q', evidence: '', SQL: 'SELECT 1', difficulty: 'simple' },
        { question_id: 138, db_id: 'db', question: 'r', evidence: '', SQL: 'SELECT 2', difficulty: 'simple' },
        { question_id: 137, db_id: 'db', question: 'q', evidence: '', SQL: 'SELECT 1', difficulty: 'simple' },
      ]),
    );
    const set = loadQuestionSet(file);
    expect(set.rows).toBe(3);
    expect(describeQuestionSet(set, 'minidev')).toBe(
      'minidev: 3 row(s), 2 question(s) — 137 repeats byte-for-byte and is counted once',
    );
  });

  it('says nothing about repeats when there are none', () => {
    const set = distinctQuestions([make(1), make(2)]);
    expect(describeQuestionSet(set, 'minidev')).toBe('minidev: 2 row(s), 2 question(s)');
    expect(describeQuestionSet(distinctQuestions([]), 'dev')).toBe('dev: 0 row(s), 0 question(s)');
  });

  it('counts several repeats in one sentence, in the plural', () => {
    const set = distinctQuestions([make(1), make(2), make(1), make(2)]);
    expect(describeQuestionSet(set, 'minidev')).toBe(
      'minidev: 4 row(s), 2 question(s) — 1, 2 repeat byte-for-byte and are counted once',
    );
  });
});
