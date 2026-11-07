import { describe, expect, it } from 'vitest';
import { caseMismatchedLiterals, classifyError, classifyFailureShape, missingLiterals, missingValueLiterals } from '../eval/bird/failure-shape.js';
import { format, tally } from '../eval/bird/diagnose-corpus.js';
import type { OracleResult } from '../eval/bird/oracle.js';

const ok = (rows: unknown[][]): OracleResult => ({ ok: true, columns: [], rows, ms: 1 });
const failed = (message: string): OracleResult => ({ ok: false, columns: [], rows: [], ms: 1, error: message });

describe('the shape of a wrong answer', () => {
  it('tells an empty result from a wrong one, because only one of them is free to detect', () => {
    expect(classifyFailureShape(ok([]), [[1]]).shape).toBe('empty');
    expect(classifyFailureShape(ok([[7]]), [[1]]).shape).toBe('values');
  });

  it('counts rows and columns apart, since the fixes differ', () => {
    expect(classifyFailureShape(ok([[1], [2]]), [[1]]).shape).toBe('row-count');
    expect(classifyFailureShape(ok([[1, 2]]), [[1]]).shape).toBe('column-count');
  });

  it('names the grain error the fan-out join produces, with its factor', () => {
    // Three rows per order, summed: the classic fan-out. The row count matches and only
    // the magnitude is wrong, which reads as "wrong values" to a comparator.
    const shape = classifyFailureShape(ok([[300], [600]]), [[100], [200]]);
    expect(shape.shape).toBe('scale');
    expect(shape.factor).toBe(3);
  });

  it('treats an empty prediction against an empty gold as a value difference', () => {
    // Both sides empty is not "the filter matched nothing": there was nothing to match.
    expect(classifyFailureShape(ok([]), []).shape).toBe('values');
  });

  it('does not read a factor out of values it cannot divide', () => {
    // Non-numeric rows, and a zero denominator: a ratio is not defined, and a NaN that
    // compared equal to itself would have reported a grain error on every string column.
    expect(classifyFailureShape(ok([['x'], ['y']]), [['a'], ['b']]).shape).toBe('values');
    expect(classifyFailureShape(ok([[1], [2]]), [[0], [0]]).shape).toBe('values');
  });

  it('does not call a genuine value difference a factor', () => {
    expect(classifyFailureShape(ok([[300], [700]]), [[100], [200]]).shape).toBe('values');
    // ...nor a factor of one, which would be a match.
    expect(classifyFailureShape(ok([[100], [200]]), [[100], [200]]).shape).toBe('values');
  });

  it('classifies a refusal, so an engine error is not counted as a wrong answer', () => {
    expect(classifyFailureShape(failed('no such column: x'), [[1]]).shape).toBe('error');
  });

  it('reads the engine message in the terms a fix would use', () => {
    expect(classifyError('no such column: customers.nmae')).toBe('unknown-identifier');
    expect(classifyError('no such table: orders')).toBe('unknown-identifier');
    expect(classifyError('ambiguous column name: id')).toBe('ambiguous');
    expect(classifyError('misuse of aggregate: SUM()')).toBe('grouping');
    expect(classifyError('near "FORM": syntax error')).toBe('syntax');
    expect(classifyError('datatype mismatch')).toBe('type');
    expect(classifyError('something new')).toBe('other');
  });
});

describe('the corpus tally', () => {
  it('reports shares over the statements it examined, not over the arm', () => {
    const entry = tally(
      'select-mixed',
      [
        { shape: 'empty' as const },
        { shape: 'values' as const },
        { shape: 'error' as const, error: 'unknown-identifier' },
        { shape: 'scale' as const, factor: 3 },
        { shape: 'scale' as const, factor: 3 },
      ],
      500,
    );
    expect(entry.examined).toBe(5);
    expect(entry.failing).toBe(500);
    expect(entry.shapes.empty).toBe(1);
    expect(entry.emptyShare).toBeCloseTo(0.2);
    expect(entry.errors).toEqual({ 'unknown-identifier': 1 });
    expect(entry.scaleFactors[0]).toEqual({ factor: 3, cases: 2 });
  });

  it('prints a table whose columns are the shapes', () => {
    const text = format([tally('a', [{ shape: 'empty' as const }], 10)]);
    expect(text.split('\n')[0]).toContain('empty');
    expect(text).toContain('100.0%');
  });
});

describe('the literals a prediction leaves out', () => {
  it('finds the value the gold filters on and the prediction never writes', () => {
    expect(missingLiterals("SELECT count(*) FROM t WHERE year = 2019 AND name = 'Bob'", 'SELECT count(*) FROM t WHERE year = 2020')).toEqual([
      '2019',
      "'Bob'",
    ]);
  });

  it('ignores case in strings and formatting in numbers, because the database does too', () => {
    expect(missingLiterals("SELECT 1 WHERE name = 'bob'", "SELECT 1 WHERE name = 'BOB'")).toEqual([]);
    expect(missingLiterals('SELECT 1 WHERE n = 3.0', 'SELECT 1 WHERE n = 3')).toEqual([]);
  });

  it('does not mistake an identifier for a literal', () => {
    // `t2` and `col_3` are names. A detector that reads them as values would report a miss
    // on every joined query and the hypothesis would never be testable.
    expect(missingLiterals('SELECT t2.a FROM t2 WHERE col_3 > 5', 'SELECT x.a FROM x WHERE col_3 > 5')).toEqual([]);
  });

  it('reports nothing when the prediction names every literal, which is the other half of the test', () => {
    expect(missingLiterals("SELECT 1 WHERE a = 'x' AND b = 2", "SELECT 1 WHERE b = 2 AND a = 'x'")).toEqual([]);
  });
});

/**
 * The value test the taxonomy runs on.
 *
 * `missingLiterals` answers a question about a statement pair; the bucket needs a question
 * about the *data*, and the two are not the same one. `* 100` is arithmetic, `'%Y'` is a mask,
 * and a classifier that counted either of them as a value filed arithmetic defects under
 * retrieval. On the dev split that was 36 of 72 `literal-missing` cases.
 */
describe('the values a prediction leaves out', () => {
  it('reports the stored value and not the arithmetic constant beside it', () => {
    expect(
      missingValueLiterals("select sum(x) * 100 / count(*) from t where county = 'Lake'", 'select sum(x) / count(*) from t'),
    ).toEqual(["'Lake'"]);
  });

  it('reports nothing when every missing literal is a number', () => {
    // Dev question 62 wrote the right value and a different percentage expression; the only
    // thing missing was `100`. Filed as retrieval, it asked for values that were already in
    // the prompt — and the case's real defect, the expression, was never counted anywhere.
    expect(
      missingValueLiterals('select CAST(free AS REAL) * 100 / enrolled from frpm', 'select free / enrolled from frpm'),
    ).toEqual([]);
    expect(missingLiterals('select CAST(free AS REAL) * 100 / enrolled from frpm', 'select free / enrolled from frpm')).toEqual([
      '100',
    ]);
  });

  it('reports nothing when every missing literal is a format mask', () => {
    // `'%Y'` is derived from the question, not stored in a column, and so is a `like` pattern:
    // the same scope `information.ts` states for its prompt-coverage classes.
    expect(missingValueLiterals("select 1 where strftime('%Y', d) = '1998'", "select 1 where d = '1998'")).toEqual([]);
    expect(missingValueLiterals("select 1 where name like '%cup%'", 'select 1 from t')).toEqual([]);
  });

  it('still reports a value whose only difference is the notation the gold used', () => {
    // `'2000'` is what the gold compares against; a prediction that writes `'2000-01-01'` has
    // not named it. This is a value gap that a stored-value sample can close, which is what
    // separates it from the mask above.
    expect(missingValueLiterals("select 1 where d between '2000' and '2005'", "select 1 where d between '2000-01-01' and '2005-12-31'")).toEqual([
      "'2000'",
      "'2005'",
    ]);
  });

  it('keeps the case-insensitive comparison the rest of the reader uses', () => {
    expect(missingValueLiterals("select 1 where name = 'cup'", "select 1 where name = 'CUP'")).toEqual([]);
    expect(missingValueLiterals("select 1 where year = '2020'", 'select 1 where year = 2020')).toEqual([]);
  });
});

/**
 * The value that contains the delimiter.
 *
 * `'Ancestor''s Chosen'` is one value, and the reader that regexed for `'([^']*)'` saw two:
 * `'Ancestor'` and `'s Chosen'`. It then reported both as missing from a prediction that had
 * written the value correctly, so the taxonomy named `literal-missing` on a case whose literal
 * was present — the wrong cause, on a case it had already read. Nineteen dev questions and
 * eight Mini-Dev questions carry a value with an apostrophe, and dev question 465 is one of
 * the Mini-Dev cases that was misattributed this way.
 */
describe('a literal whose value holds a quote', () => {
  it('reads a doubled quote as one value and finds nothing missing', () => {
    expect(missingLiterals("WHERE name = 'Ancestor''s Chosen'", "WHERE name = 'Ancestor''s Chosen'")).toEqual([]);
  });

  it('reports the whole value, not its fragments, when the prediction writes another one', () => {
    expect(missingLiterals("WHERE event_name = 'Women''s Soccer'", "WHERE event_name = 'Mens Soccer'")).toEqual(["'Women's Soccer'"]);
  });

  it('compares a doubled quote case-insensitively', () => {
    expect(missingLiterals("WHERE name = 'Ancestor''s Chosen'", "WHERE name = 'ancestor''s chosen'")).toEqual([]);
  });

  it('reads a case mismatch inside a value that holds a quote', () => {
    expect(caseMismatchedLiterals("WHERE name = 'Ancestor''s Chosen'", "WHERE name = 'ancestor''s chosen'")).toEqual([
      "'Ancestor's Chosen'",
    ]);
  });

  it('does not read the digits of a value string as a second literal', () => {
    // `where year = '2020'` names one value. The old reader also returned the number 2020,
    // so a report about the literal listed a token nobody wrote.
    expect(missingLiterals("WHERE year = '2020' AND n = 5", "WHERE n = 5")).toEqual(["'2020'"]);
  });

  it('does not read a literal inside a comment', () => {
    expect(missingLiterals('SELECT 1 -- WHERE a = \'x\'', 'SELECT 1')).toEqual([]);
  });
});
