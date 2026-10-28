import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildSchema,
  loadDescriptions,
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

  it('returns everything when the limit exceeds the input', () => {
    expect(stratifiedSample(questions, 10)).toHaveLength(6);
  });

  it('keeps the difficulty mix instead of taking the head of the file', () => {
    const picked = stratifiedSample(questions, 3);
    expect(picked.map((question) => question.question_id)).toEqual([1, 3, 5]);
  });

  it('is deterministic and stops when the buckets run dry', () => {
    expect(stratifiedSample(questions, 4).map((question) => question.question_id)).toEqual([1, 3, 5, 2]);
    expect(stratifiedSample([make(1, 'simple')], 5)).toHaveLength(1);
  });

  it('skips an exhausted bucket and keeps drawing from the others', () => {
    // One simple question and four moderate ones: the third round has nothing in the simple
    // bucket, and a sampler that treated that as the end would return two cases for a limit
    // of four — a sample smaller than the one that was asked for, silently.
    const lopsided = [make(1, 'simple'), make(2, 'moderate'), make(3, 'moderate'), make(4, 'moderate'), make(5, 'moderate')];
    expect(stratifiedSample(lopsided, 4).map((question) => question.question_id)).toEqual([1, 2, 3, 4]);
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
