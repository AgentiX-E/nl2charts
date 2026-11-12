/**
 * The second thing the data can prove: a date the model wrote in a different calendar notation.
 *
 * `ground.ts` settled case, and case was the whole of its rule: a column that stores `Banned` equals
 * `banned`, and a column that stores nothing equal to the literal is reported as `absent`. On BIRD's
 * Mini-Dev split, `values` is the largest failure class of every arm (160 of 223 failures on
 * `inline+evidence`), and a sample of it shows a notation error that no prompt can prevent: the
 * question says 9 September 2019, the column stores `2019-09-09`, and the statement is written with
 * `'9/9/2019'`. The literal is right and the spelling is wrong, on a column whose own values are the
 * only authority on the spelling.
 *
 * These tests are the boundary of that reading. Each case below is a way the rule could be wrong:
 * a date that could be read two ways, a day that a column stores twice, a column that stores a
 * timestamp rather than a date, a literal that is not a date at all, and a literal that is already
 * the column's exact spelling.
 */
import { describe, expect, it } from 'vitest';
import { applyGrounding } from '../packages/ai/src/index.js';

/** A lookup that holds one column's values, keyed by column name. */
function column(values: Readonly<Record<string, readonly string[]>>): (query: { readonly column: string }) => readonly string[] | undefined {
  return (query) => values[query.column];
}

describe('grounding a literal that names the same day in a different notation', () => {
  it('writes the spelling the column stores for a day written month-first', () => {
    const grounding = applyGrounding("select id from events where day = '9/9/2019'", column({ day: ['2019-09-09'] }));
    expect(grounding.sql).toBe("select id from events where day = '2019-09-09'");
    expect(grounding.substitutions).toEqual([{ literal: '9/9/2019', column: 'day', value: '2019-09-09', match: 'format' }]);
  });

  it('writes the spelling the column stores for a day written without a leading zero', () => {
    const grounding = applyGrounding("select id from expenses where expense_date = '2019-8-20'", column({ expense_date: ['2019-08-20'] }));
    expect(grounding.sql).toBe("select id from expenses where expense_date = '2019-08-20'");
    expect(grounding.substitutions[0]?.match).toBe('format');
  });

  it('reads a year-first date and a month-first date as the same day', () => {
    const grounding = applyGrounding("select id from t where d in ('2019-09-09', '2019/9/9')", column({ d: ['09/09/2019'] }));
    expect(grounding.sql).toBe("select id from t where d in ('09/09/2019', '09/09/2019')");
    expect(grounding.substitutions).toHaveLength(2);
  });

  it('refuses a numeric date that could be read either way', () => {
    // `3/4/2019` is 4 March to a reader of day-first dates and 3 April to a reader of month-first
    // ones, and the statement is the only thing that could have said which. Writing either one is
    // inventing an answer, which is what `absent` exists to prevent.
    const grounding = applyGrounding("select id from t where d = '3/4/2019'", column({ d: ['2019-03-04'] }));
    expect(grounding.sql).toBe("select id from t where d = '3/4/2019'");
    expect(grounding.refused).toEqual([{ literal: '3/4/2019', column: 'd', reason: 'absent' }]);
  });

  it('reads a numeric date whose first component can only be a day', () => {
    const grounding = applyGrounding("select id from t where d = '13/4/2019'", column({ d: ['2019-04-13'] }));
    expect(grounding.sql).toBe("select id from t where d = '2019-04-13'");
  });

  it('reads a numeric date whose second component can only be a month', () => {
    const grounding = applyGrounding("select id from t where d = '4/13/2019'", column({ d: ['2019-04-13'] }));
    expect(grounding.sql).toBe("select id from t where d = '2019-04-13'");
  });

  it('refuses a day the month does not have', () => {
    // `2019-02-30` parses as three numbers and is not a date. A rule that checked the month but not
    // the day would rewrite it against `2019-03-02` in a statement that meant neither.
    const grounding = applyGrounding("select id from t where d = '2019-02-30'", column({ d: ['2019-03-02'] }));
    expect(grounding.refused).toEqual([{ literal: '2019-02-30', column: 'd', reason: 'absent' }]);
  });

  it('refuses a day of zero', () => {
    const grounding = applyGrounding("select id from t where d = '2019-00-10'", column({ d: ['2019-01-10'] }));
    expect(grounding.refused).toEqual([{ literal: '2019-00-10', column: 'd', reason: 'absent' }]);
  });

  it('refuses 29 February in a year that does not have one', () => {
    const grounding = applyGrounding("select id from t where d = '2019-02-29'", column({ d: ['2019-03-01'] }));
    expect(grounding.refused).toEqual([{ literal: '2019-02-29', column: 'd', reason: 'absent' }]);
  });

  it('reads 29 February in a leap year, including a century that is one', () => {
    // Three Gregorian cases in one test because they are one rule: 2020 is a leap year by the
    // four-year rule, 1900 is not by the century exception, and 2000 is by the 400-year exception.
    const leap = applyGrounding("select id from t where d = '2020-02-29'", column({ d: ['29/02/2020'] }));
    expect(leap.sql).toBe("select id from t where d = '29/02/2020'");
    expect(applyGrounding("select id from t where d = '29/02/1900'", column({ d: ['1900-02-28'] })).refused).toHaveLength(1);
    expect(applyGrounding("select id from t where d = '29/02/2000'", column({ d: ['2000-02-29'] })).substitutions).toHaveLength(1);
  });

  it('reads a day in a 30-day month and one in a 31-day month', () => {
    const april = applyGrounding("select id from t where d = '30/4/2019'", column({ d: ['2019-04-30'] }));
    expect(april.substitutions).toHaveLength(1);
    const may = applyGrounding("select id from t where d = '31/5/2019'", column({ d: ['2019-05-31'] }));
    expect(may.substitutions).toHaveLength(1);
  });

  it('refuses when the column stores the same day twice', () => {
    // Two spellings of one day is the same ambiguity as `Banned` and `BANNED`, one level up: the
    // column says the day is stored, and does not say which way the statement should name it.
    const grounding = applyGrounding("select id from t where d = '9/9/2019'", column({ d: ['2019-09-09', '09/09/2019'] }));
    expect(grounding.sql).toBe("select id from t where d = '9/9/2019'");
    expect(grounding.refused).toEqual([{ literal: '9/9/2019', column: 'd', reason: 'ambiguous' }]);
  });

  it('declines on a timestamp column, which stores an instant rather than the day', () => {
    // Writing `'2019-09-09 08:00:00'` into a statement that asked about a day narrows it from a day
    // to an instant, and writing `'2019-09-09'` into a comparison against a timestamp column makes
    // the comparison false for every row. The two precisions are different questions, so the rule
    // only answers within one of them.
    const grounding = applyGrounding("select id from t where at = '2019-09-09'", column({ at: ['2019-09-09 08:00:00'] }));
    expect(grounding.sql).toBe("select id from t where at = '2019-09-09'");
    expect(grounding.refused).toEqual([{ literal: '2019-09-09', column: 'at', reason: 'absent' }]);
  });

  it('leaves a literal that is not a date to the case rule', () => {
    const grounding = applyGrounding("select id from t where status = 'banned'", column({ status: ['Banned'] }));
    expect(grounding.substitutions).toEqual([{ literal: 'banned', column: 'status', value: 'Banned', match: 'case' }]);
  });

  it('refuses a value that is absent in every notation', () => {
    const grounding = applyGrounding("select id from t where status = 'pending'", column({ status: ['Banned'] }));
    expect(grounding.refused).toEqual([{ literal: 'pending', column: 'status', reason: 'absent' }]);
  });

  it('does not read a bare year as a day', () => {
    const grounding = applyGrounding("select id from t where y = '2019'", column({ y: ['2019-09-09'] }));
    expect(grounding.refused).toEqual([{ literal: '2019', column: 'y', reason: 'absent' }]);
  });

  it('does not read a time-only literal as a day', () => {
    const grounding = applyGrounding("select id from t where at = '08:00:00'", column({ at: ['2019-09-09 08:00:00'] }));
    expect(grounding.refused).toEqual([{ literal: '08:00:00', column: 'at', reason: 'absent' }]);
  });

  it('does not read an out-of-range month as a day', () => {
    // `2019-13-01` parses as three numbers and is not a date. A rule that only counted components
    // would rewrite it against a column that stores `2019-01-13`.
    const grounding = applyGrounding("select id from t where d = '2019-13-01'", column({ d: ['2019-01-13'] }));
    expect(grounding.refused).toEqual([{ literal: '2019-13-01', column: 'd', reason: 'absent' }]);
  });

  it('does not rewrite a literal the column already stores verbatim', () => {
    const grounding = applyGrounding("select id from t where d = '2019-09-09'", column({ d: ['2019-09-09'] }));
    expect(grounding.substitutions).toEqual([]);
    expect(grounding.sql).toBe("select id from t where d = '2019-09-09'");
  });

  it('is idempotent: grounding a grounded statement substitutes nothing', () => {
    const lookup = column({ d: ['2019-09-09'] });
    const once = applyGrounding("select id from t where d = '9/9/2019'", lookup);
    const twice = applyGrounding(once.sql, lookup);
    expect(twice.substitutions).toEqual([]);
    expect(twice.sql).toBe(once.sql);
  });

  it('reports an unread column as unknown rather than as a notation it could not match', () => {
    const grounding = applyGrounding("select id from t where d = '9/9/2019'", () => undefined);
    expect(grounding.refused).toEqual([{ literal: '9/9/2019', column: 'd', reason: 'unknown' }]);
  });

  it('keeps every other part of the statement byte for byte', () => {
    const sql = "SELECT  e.id\nFROM events AS e\nWHERE e.day = '9/9/2019'   AND e.kind = 'meeting'";
    expect(applyGrounding(sql, column({ day: ['2019-09-09'], kind: ['meeting'] })).sql).toBe(
      "SELECT  e.id\nFROM events AS e\nWHERE e.day = '2019-09-09'   AND e.kind = 'meeting'",
    );
  });

  it('does not rewrite a like pattern, which is a pattern rather than a value', () => {
    const grounding = applyGrounding("select id from t where d like '9/9/2019%'", column({ d: ['2019-09-09'] }));
    expect(grounding.substitutions).toEqual([]);
  });
});
