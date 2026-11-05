/**
 * The ascending-sort guard, asserted as a rule rather than as a string transform.
 *
 * Three properties decide whether this rule may be applied silently to a user's statement, and each
 * one is a test here:
 *
 * 1. **It rewrites only where the engine's ordering is the defect.** A statement without a row cap
 *    returns the same rows in a different order, which is invisible to the judge and to the reader;
 *    a descending sort in SQLite already puts NULLs last. Rewriting either would be changing SQL
 *    for no measured reason.
 * 2. **It is dialect-correct in both directions.** SQLite and MySQL sort NULL first ascending,
 *    PostgreSQL sorts it first descending. A rule written once and applied twice would introduce
 *    the bug it removes on half the product's engines.
 * 3. **It refuses the keys where a constant prefix is not free.** A guard in front of `COUNT(*)`
 *    cannot change NULL placement — COUNT is never NULL — but it does change which of several tied
 *    groups the sorter returns first. Priced on dev that cost 3 wins to gain 1; the refusal is what
 *    makes the rule 6 wins and 0 losses.
 *
 * The first version of the rewrite emitted `... ASC LIMIT` as `... ASCLIMIT` on every case it
 * fired, because the clause was trimmed and the whitespace before `LIMIT` belonged to neither
 * slice. The instrument caught it as 80 broken statements; the test below is the same assertion in
 * one line, so it cannot come back.
 */
import { describe, expect, it } from 'vitest';
import { guardNullOrder, splitKeys } from '@agentix-e/nl2charts-ai';

describe('guardNullOrder', () => {
  it('puts the guard in front of an ascending key that carries a limit', () => {
    const guard = guardNullOrder('select phone from schools order by avg_read asc limit 1', 'sqlite');
    expect(guard).toEqual({
      sql: 'select phone from schools order by avg_read IS NULL, avg_read asc limit 1',
      key: 'avg_read',
      direction: 'asc',
    });
  });

  it('keeps the statement runnable: the keyword after the key is separated', () => {
    const guard = guardNullOrder('select a from t order by a asc limit 3;', 'sqlite');
    expect(guard?.sql).toBe('select a from t order by a IS NULL, a asc limit 3;');
    expect(guard?.sql).not.toContain('ASCLIMIT');
  });

  it('treats an implicit direction as ascending', () => {
    expect(guardNullOrder('select a from t order by a limit 3', 'sqlite')?.direction).toBe('asc');
  });

  it('leaves a statement with no row cap alone', () => {
    expect(guardNullOrder('select a from t order by a asc', 'sqlite')).toBeUndefined();
  });

  it('leaves an ascending sort alone on an engine that sorts NULL last', () => {
    expect(guardNullOrder('select a from t order by a asc limit 3', 'postgres')).toBeUndefined();
  });

  it('guards a descending sort on an engine that sorts NULL first descending', () => {
    // PostgreSQL: NULL is the largest value, so DESC puts it in the first row of a LIMIT 1.
    expect(guardNullOrder('select a from t order by a desc limit 3', 'postgres')).toEqual({
      sql: 'select a from t order by a IS NULL, a desc limit 3',
      key: 'a',
      direction: 'desc',
    });
  });

  it('leaves a descending sort alone on SQLite', () => {
    expect(guardNullOrder('select a from t order by a desc limit 3', 'sqlite')).toBeUndefined();
  });

  it('refuses an aggregate key, whose ties the prefix would reorder', () => {
    expect(guardNullOrder('select id from t group by id order by count(*) desc limit 1', 'postgres')).toBeUndefined();
    expect(guardNullOrder('select id from t group by id order by count(*) asc limit 1', 'sqlite')).toBeUndefined();
    expect(guardNullOrder('select id from t group by id order by sum(x) asc limit 1', 'sqlite')).toBeUndefined();
  });

  it('refuses a key that already states where the unknown values go', () => {
    expect(guardNullOrder('select a from t order by a is null, a asc limit 2', 'sqlite')).toBeUndefined();
    expect(guardNullOrder('select a from t order by (a is not null) desc, a asc limit 2', 'sqlite')).toBeUndefined();
  });

  it('guards the first key only and keeps the rest of the clause', () => {
    const guard = guardNullOrder('select a, b from t order by a asc, b desc limit 4', 'sqlite');
    expect(guard?.sql).toBe('select a, b from t order by a IS NULL, a asc, b desc limit 4');
  });

  it('reads a key that is arithmetic over columns, and keeps its parentheses', () => {
    const guard = guardNullOrder('select county from s order by (math + read + write) asc limit 1', 'sqlite');
    expect(guard?.key).toBe('(math + read + write)');
    expect(guard?.sql).toContain('(math + read + write) IS NULL');
  });

  it('ignores an ORDER BY that belongs to a window function', () => {
    expect(guardNullOrder('select rank() over (order by x asc) as r from t limit 5', 'sqlite')).toBeUndefined();
  });

  it('ignores the words when they appear inside a literal', () => {
    expect(guardNullOrder("select a from t where note = 'order by x asc limit 1'", 'sqlite')).toBeUndefined();
  });

  it('does not read a LIMIT that belongs to a subquery', () => {
    // The subquery's cap is not the outer row cap, and its parentheses are what say so.
    expect(guardNullOrder('select a from (select a from t limit 5) order by a asc', 'sqlite')).toBeUndefined();
  });

  it('refuses an empty sort clause', () => {
    expect(guardNullOrder('select a from t order by  limit 3', 'sqlite')).toBeUndefined();
  });

  it('accepts a key that is a quoted identifier and preserves the quotes', () => {
    const guard = guardNullOrder('select x from t order by "First Date" asc limit 1', 'sqlite');
    expect(guard?.sql).toContain('"First Date" IS NULL, "First Date" asc');
  });

  it('defaults to SQLite when no dialect is named', () => {
    expect(guardNullOrder('select a from t order by a asc limit 1')?.direction).toBe('asc');
  });
});

describe('splitKeys', () => {
  it('splits on top-level commas only', () => {
    expect(splitKeys('a asc, b desc')).toEqual(['a asc', 'b desc']);
  });

  it('keeps a comma that belongs to a call', () => {
    expect(splitKeys('coalesce(a, b) asc, c')).toEqual(['coalesce(a, b) asc', 'c']);
  });

  it('keeps a comma inside a literal', () => {
    expect(splitKeys("case when x = 'a,b' then 1 end asc")).toEqual(["case when x = 'a,b' then 1 end asc"]);
  });

  it('drops empty segments a trailing comma produced', () => {
    expect(splitKeys('a asc,')).toEqual(['a asc']);
    expect(splitKeys('   ')).toEqual([]);
  });

  it('reads a doubled quote inside a literal as an escaped one', () => {
    expect(splitKeys("'it''s, ok' asc, b")).toEqual(["'it''s, ok' asc", 'b']);
  });
});
