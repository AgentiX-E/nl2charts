/**
 * The WikiSQL template, held to the reference implementation's choices.
 *
 * Every assertion here is a decision that would produce a number nobody else can reproduce if it
 * went the other way: the operator table's unused fourth entry, the `real`-column conversion, the
 * escaping of a quote, and — the one that looks like a bug and is not — the ordered comparison of
 * two unordered `SELECT`s.
 *
 * The port cannot be checked against the reference by running it, because the corpus does not
 * arrive: `data.tar.bz2` is 26 MB and the sandbox's egress proxy truncates a GitHub blob download
 * at about 7 MB (5,791,744 and 7,324,757 bytes on two attempts, both rejected by `bzip2 -t`). So
 * the tests are the evidence. They are written against the reference's source, `lib/query.py` and
 * `lib/dbengine.py`, which are eleven kilobytes and were read line by line.
 */
import { describe, expect, it } from 'vitest';
import {
  AGG_OPS,
  COND_OPS,
  LogicFormError,
  literalOf,
  sameResults,
  statementOf,
  tableNameOf,
} from '../eval/wikisql/form.js';
import type { LogicForm, TableShape } from '../eval/wikisql/form.js';

const table: TableShape = {
  name: 'table_1_10007452_3',
  types: ['varchar', 'real', 'text'],
};

const bare: LogicForm = { sel: 1, agg: 0, conds: [] };

describe('the vocabulary is the corpus vocabulary', () => {
  it('keeps the aggregator list indexed as the annotations carry it', () => {
    expect(AGG_OPS).toEqual(['', 'MAX', 'MIN', 'COUNT', 'SUM', 'AVG']);
  });

  it('keeps the unused operator at its index instead of dropping it', () => {
    expect(COND_OPS).toEqual(['=', '>', '<', 'OP']);
  });
});

describe('the table name', () => {
  it('rewrites every hyphen, not the first', () => {
    expect(tableNameOf('1-10007452-3')).toBe('table_1_10007452_3');
  });

  it('leaves a name that already carries the prefix alone', () => {
    expect(tableNameOf('table_1_10007452_3')).toBe('table_1_10007452_3');
  });
});

describe('a condition value becomes a literal', () => {
  it('quotes a string column', () => {
    expect(literalOf('1998', 'varchar')).toBe("'1998'");
  });

  it('doubles a quote rather than ending the literal early', () => {
    expect(literalOf("O'Brien", 'text')).toBe("'O''Brien'");
  });

  it('converts a real column, thousands separator included', () => {
    expect(literalOf('1,234.5', 'real')).toBe('1234.5');
  });

  it('converts a real column that is real only in SQLite terms', () => {
    expect(literalOf('3', 'REAL')).toBe('3');
  });

  it('extracts the first number when the cell is prose', () => {
    expect(literalOf('about 3.5 metres', 'real')).toBe('3.5');
  });

  it('refuses a real column with no number in it', () => {
    expect(() => literalOf('three', 'real')).toThrow(LogicFormError);
  });
});

describe('the statement a logical form denotes', () => {
  it('selects one column when there is no aggregation', () => {
    expect(statementOf(bare, table)).toBe('SELECT col1 AS result FROM table_1_10007452_3');
  });

  it('wraps the column in the aggregator when there is one', () => {
    expect(statementOf({ sel: 1, agg: 4, conds: [] }, table)).toBe(
      'SELECT SUM(col1) AS result FROM table_1_10007452_3',
    );
  });

  it('joins conditions with AND', () => {
    expect(
      statementOf(
        {
          sel: 0,
          agg: 0,
          conds: [
            [1, 0, '2.5'],
            [2, 1, 'b'],
          ],
        },
        table,
      ),
    ).toBe("SELECT col0 AS result FROM table_1_10007452_3 WHERE col1 = 2.5 AND col2 > 'b'");
  });

  it('lower-cases string values, which the reference does on both sides', () => {
    expect(statementOf({ sel: 0, agg: 0, conds: [[2, 0, 'Paul']] }, table)).toBe(
      "SELECT col0 AS result FROM table_1_10007452_3 WHERE col2 = 'paul'",
    );
  });

  it('keeps the case when asked to', () => {
    expect(statementOf({ sel: 0, agg: 0, conds: [[2, 0, 'Paul']] }, table, { lower: false })).toBe(
      "SELECT col0 AS result FROM table_1_10007452_3 WHERE col2 = 'Paul'",
    );
  });

  it('refuses a select index outside the table', () => {
    expect(() => statementOf({ sel: 9, agg: 0, conds: [] }, table)).toThrow(/outside/);
  });

  it('refuses a condition column outside the table', () => {
    expect(() => statementOf({ sel: 0, agg: 0, conds: [[9, 0, 'x']] }, table)).toThrow(/outside/);
  });

  it('refuses an aggregator index the vocabulary does not have', () => {
    expect(() => statementOf({ sel: 0, agg: 6, conds: [] }, table)).toThrow(/no aggregator/);
  });

  it('refuses an operator index the vocabulary does not have', () => {
    expect(() => statementOf({ sel: 0, agg: 0, conds: [[0, 4, 'x']] }, table)).toThrow(/no operator/);
  });
});

describe('two result sets are the same answer when the reference says they are', () => {
  it('is order-sensitive, because the reference compares tuples', () => {
    expect(sameResults([['a'], ['b']], [['b'], ['a']])).toBe(false);
  });

  it('calls 1 and 1.0 the same answer, as Python does', () => {
    expect(sameResults([[1]], [[1.0]])).toBe(true);
  });

  it('separates a number from its text', () => {
    expect(sameResults([[1]], [['1']])).toBe(false);
  });

  it('compares null to null and to nothing else', () => {
    expect(sameResults([[null]], [[null]])).toBe(true);
    expect(sameResults([[null]], [['']])).toBe(false);
  });

  it('reports a different number of rows rather than comparing the shared prefix', () => {
    expect(sameResults([['a']], [['a'], ['a']])).toBe(false);
  });

  it('reports a different row width', () => {
    expect(sameResults([['a']], [['a', 'b']])).toBe(false);
  });
});

describe('a condition value the annotation stored as a number', () => {
  // 2,953 of the dev split's 11,545 condition values are JSON numbers — `[4, 0, 6]` for "the
  // minimum ties played for 6 years". This file asserted that the value is always text until a run
  // over the whole split stopped on question one with `value.toLowerCase is not a function`.

  it('is written as a numeric literal, which is what the reference binds', () => {
    expect(literalOf(6, 'text')).toBe('6');
    expect(literalOf(150_817.6878461314, 'real')).toBe('150817.6878461314');
  });

  it('refuses a value that is not a finite number', () => {
    expect(() => literalOf(Number.NaN, 'text')).toThrow(LogicFormError);
    expect(() => literalOf(Number.POSITIVE_INFINITY, 'real')).toThrow(/finite/);
  });

  it('survives the statement builder without being lower-cased', () => {
    const table = { name: 'table_1_2_3', types: ['text', 'real'] };
    expect(statementOf({ sel: 0, agg: 0, conds: [[1, 0, 6]] }, table)).toBe(
      'SELECT col0 AS result FROM table_1_2_3 WHERE col1 = 6',
    );
  });
});
