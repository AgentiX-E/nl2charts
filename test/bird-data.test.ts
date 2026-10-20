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
          table_names: ['a', 'b'],
          column_names: [
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
    expect(table.foreignKeys).toEqual([[2, 1]]);
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
});

describe('schema construction', () => {
  const table: BirdTable = {
    db_id: 'db',
    tableNames: ['orders', 'customers'],
    columnNames: [
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
        ['customer id', { description: 'who ordered' }],
      ]),
    ],
    ['customers', new Map([['segment', { description: 'segment', values: 'smb: small' }]])],
  ]);

  it('drops the star column and maps native types', () => {
    const schema = buildSchema(table, notes, { withNotes: false });
    expect(schema[0]?.columns.map((column) => column.name)).toEqual(['id', 'customer id']);
    expect(schema[0]?.columns[0]?.type).toBe('BIGINT');
    expect(schema[0]?.columns[0]?.comment).toBeUndefined();
    expect(schema[1]?.foreignKeys).toBeUndefined();
  });

  it('attaches comments and join hints only when asked', () => {
    const schema = buildSchema(table, notes, { withNotes: true });
    expect(schema[0]?.columns[1]?.comment).toBe('who ordered');
    expect(schema[1]?.columns[1]?.comment).toBe('segment (smb: small)');
    expect(schema[0]?.foreignKeys).toEqual(['orders.customer id = customers.id']);
  });

  it('omits a table with no columns left', () => {
    const empty: BirdTable = { db_id: 'db', tableNames: ['void'], columnNames: [[-1, '*']], columnTypes: ['text'], foreignKeys: [] };
    expect(buildSchema(empty, new Map(), { withNotes: true })).toEqual([{ table: 'void', columns: [] }]);
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
});
