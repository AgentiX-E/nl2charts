import { describe, expect, it } from 'vitest';
import { CLAUSE_WORDS, codeOnly, definesOwnName, enclosedBy, ignoredRegions, readIdentifier, regionAt, skipSpace, tableRefs } from '../src/sql-lex.js';

/**
 * The scanner, as a library contract rather than as a harness detail.
 *
 * It moved into `packages/ai` because `ask_question` resolves a statement's own aliases when it
 * reads a column's values, and the cases that matter here are the ones a naive regex gets wrong on
 * a real corpus: a `from` inside a literal, a table name in quotes with an apostrophe in it, a
 * comment that ends at the end of the text, a CTE that names itself.
 */
describe('tableRefs', () => {
  it('reports a table with no alias as its own alias', () => {
    expect(tableRefs('select * from orders')).toEqual([{ table: 'orders', alias: 'orders', joined: false }]);
  });

  it('reads an alias written with as', () => {
    expect(tableRefs('select * from orders as o')).toEqual([{ table: 'orders', alias: 'o', joined: false }]);
  });

  it('reads an alias written without as', () => {
    expect(tableRefs('select * from orders o')).toEqual([{ table: 'orders', alias: 'o', joined: false }]);
  });

  it('does not read a clause word as an alias', () => {
    expect(tableRefs('select * from orders where x = 1')[0]?.alias).toBe('orders');
    // `as` is the one word in the set that introduces an alias rather than following a table, and
    // the reader checks it before the clause list — `from orders as x` is an alias, not a clause.
    for (const word of CLAUSE_WORDS) {
      const expected = word === 'as' ? 'x' : 'orders';
      expect(tableRefs(`select * from orders ${word} x`)[0]?.alias).toBe(expected);
    }
  });

  it('reads a quoted table name as itself', () => {
    expect(tableRefs('select * from "order items" as oi')).toEqual([
      { table: 'order items', alias: 'oi', joined: false },
    ]);
  });

  it('marks a table introduced by join', () => {
    expect(tableRefs('select * from a join b on a.id = b.id').map((ref) => ref.joined)).toEqual([false, true]);
  });

  it('ignores from inside a literal', () => {
    expect(tableRefs("select * from t where note = 'from elsewhere'")).toHaveLength(1);
  });

  it('ignores from inside a line comment', () => {
    expect(tableRefs('select * from a -- from b\nwhere 1 = 1')).toHaveLength(1);
  });

  it('ignores from inside a block comment', () => {
    expect(tableRefs('select * from a /* from b */ where 1 = 1')).toHaveLength(1);
  });

  it('reports no reference for a from that opens a subquery', () => {
    // `from (` is not a table. The derived table's own name is the statement's invention, so
    // nothing here is a table of the database — which is the answer a reader of column values
    // needs, and the reason this returns nothing rather than guessing at `s`.
    expect(tableRefs('select * from (select 1) as s')).toEqual([]);
  });

  it('skips an as with no name after it', () => {
    expect(tableRefs('select * from orders as')).toEqual([{ table: 'orders', alias: 'orders', joined: false }]);
  });

  it('skips a from that ends the statement', () => {
    expect(tableRefs('select 1 from')).toEqual([]);
  });

  it('does not read punctuation after a table as its alias', () => {
    expect(tableRefs('select * from orders, customers')[0]?.alias).toBe('orders');
  });

  it('skips an identifier that opens a quote and never closes it', () => {
    expect(tableRefs('select * from "orders')).toEqual([]);
    expect(tableRefs('select * from `orders')).toEqual([]);
    expect(tableRefs('select * from [orders')).toEqual([]);
  });

  it('reads a table name in brackets and one in backticks', () => {
    expect(tableRefs('select * from [order items]')[0]?.table).toBe('order items');
    expect(tableRefs('select * from `order items`')[0]?.table).toBe('order items');
  });

  it('treats an unterminated literal as code, because a broken statement has no regions', () => {
    // A quote that never closes is not a region, so what follows it is read as code: the statement
    // is broken either way, and a position guessed from an unclosed quote would move every
    // reference after it.
    expect(tableRefs("select * from t where a = 'from b").map((ref) => ref.table)).toEqual(['t', 'b']);
  });
});

describe('definesOwnName', () => {
  it('reads a CTE definition as a definition', () => {
    expect(definesOwnName('with a as (select 1) select * from a', 'a')).toBe(true);
  });

  it('does not read a column alias as a definition', () => {
    expect(definesOwnName('select x as a from t', 'a')).toBe(false);
  });

  it('reads a recursive CTE', () => {
    expect(definesOwnName('with a as (with b as (select 1) select * from b) select 1', 'a')).toBe(true);
  });

  it('does not treat a name inside a longer identifier as the name', () => {
    expect(definesOwnName('select ab as (select 1)', 'a')).toBe(false);
  });

  it('escapes a name that holds a regular-expression character', () => {
    expect(definesOwnName('with "a.b" as (select 1) select 1', 'a.b')).toBe(true);
    expect(definesOwnName('with "axb" as (select 1) select 1', 'a.b')).toBe(false);
  });
});

describe('codeOnly', () => {
  it('blanks literals, comments and quoted names without moving an offset', () => {
    const sql = "select \"a b\", 'x' from t -- note\n";
    const masked = codeOnly(sql);
    expect(masked).toHaveLength(sql.length);
    expect(masked).not.toContain('a b');
    expect(masked).not.toContain('x');
    expect(masked).not.toContain('note');
    expect(masked.startsWith('select ')).toBe(true);
  });

  it('leaves an unterminated quote as code', () => {
    expect(codeOnly("select 'x")).toBe("select 'x");
  });
});

describe('the primitives codeOnly and tableRefs are built on', () => {
  it('finds the next non-space character', () => {
    expect(skipSpace('  \n\tx', 0)).toBe(4);
    expect(skipSpace('x', 0)).toBe(0);
  });

  it('reads a bare, quoted, backticked and bracketed identifier', () => {
    expect(readIdentifier('ab.', 0)).toEqual({ text: 'ab', end: 2 });
    expect(readIdentifier('"a b"', 0)).toEqual({ text: 'a b', end: 5 });
    expect(readIdentifier('`a`', 0)).toEqual({ text: 'a', end: 3 });
    expect(readIdentifier('[a]', 0)).toEqual({ text: 'a', end: 3 });
  });

  it('reads no identifier from text that starts with something else', () => {
    expect(readIdentifier('*', 0)).toBeUndefined();
    expect(readIdentifier('', 0)).toBeUndefined();
    expect(readIdentifier('"open', 0)).toBeUndefined();
  });

  it('names the region that starts at a position, and nothing where code starts', () => {
    expect(regionAt("'x'", 0)?.kind).toBe('literal');
    expect(regionAt('-- x', 0)?.kind).toBe('comment');
    expect(regionAt('/* x */', 0)?.kind).toBe('comment');
    expect(regionAt('"x"', 0)?.kind).toBe('quoting');
    expect(regionAt('`x`', 0)?.kind).toBe('quoting');
    expect(regionAt('[x]', 0)?.kind).toBe('quoting');
    expect(regionAt('x', 0)).toBeUndefined();
  });

  it('reports no region for a quote that never closes', () => {
    expect(regionAt("'open", 0)).toBeUndefined();
  });

  it('skips to the end for a comment that never closes', () => {
    expect(regionAt('-- open', 0)?.end).toBe(7);
    expect(regionAt('/* open', 0)?.end).toBe(7);
    expect(regionAt('"open', 0)?.end).toBe(5);
    expect(regionAt('`open', 0)?.end).toBe(5);
    expect(regionAt('[open', 0)?.end).toBe(5);
  });

  it('keeps quoted names out of the ignored regions, because a table may be quoted', () => {
    expect(ignoredRegions('"t" \'x\' -- c')).toEqual([
      { start: 4, end: 7, kind: 'literal' },
      { start: 8, end: 12, kind: 'comment' },
    ]);
  });

  it('reports whether a position is inside a region', () => {
    const regions = ignoredRegions("'x'");
    expect(enclosedBy(regions, 0)).toBe(true);
    expect(enclosedBy(regions, 3)).toBe(false);
  });
});
