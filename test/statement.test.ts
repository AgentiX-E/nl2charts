import { describe, expect, it } from 'vitest';
import { codeOnly, literalSites, referencedFields, stringLiterals, tableRefs } from '../eval/bird/statement.js';

/**
 * The scanner exists so that an edit lands on the token a human would point at. Every
 * case here is one a real BIRD statement contains: a quoted column with an apostrophe, a
 * `from` inside a literal, a `--` comment that ends at the end of the text.
 */
describe('stringLiterals', () => {
  it('reads a plain literal with its offsets', () => {
    const sql = "select * from t where a = 'x'";
    const [literal] = stringLiterals(sql);
    expect(literal?.value).toBe('x');
    expect(sql.slice(literal?.start ?? 0, literal?.end ?? 0)).toBe("'x'");
  });

  it('unescapes a doubled quote', () => {
    expect(stringLiterals("select 'it''s'").map((literal) => literal.value)).toEqual(["it's"]);
  });

  it('skips a line comment and stops at the end of the text without a newline', () => {
    expect(stringLiterals("select 1 -- and 'not a literal'").map((literal) => literal.value)).toEqual([]);
  });

  it('resumes after a line comment that ends with a newline', () => {
    expect(stringLiterals("select 1 -- 'x'\n, 'y'").map((literal) => literal.value)).toEqual(['y']);
  });

  it('skips a block comment', () => {
    expect(stringLiterals("select /* 'x' */ 'y'").map((literal) => literal.value)).toEqual(['y']);
  });

  it('skips an unterminated block comment to the end', () => {
    expect(stringLiterals("select 'x' /* 'y'").map((literal) => literal.value)).toEqual(['x']);
  });

  it('skips a double-quoted identifier that holds a quote', () => {
    expect(stringLiterals(`select "O'Brien Rd" from t`).map((literal) => literal.value)).toEqual([]);
  });

  it('skips an unterminated double-quoted identifier to the end', () => {
    expect(stringLiterals(`select "oops from t`).map((literal) => literal.value)).toEqual([]);
  });

  it('skips a backticked identifier', () => {
    expect(stringLiterals('select `a` from t').map((literal) => literal.value)).toEqual([]);
  });

  it('skips an unterminated backticked identifier to the end', () => {
    expect(stringLiterals('select `oops from t').map((literal) => literal.value)).toEqual([]);
  });

  it('skips a bracketed identifier', () => {
    expect(stringLiterals('select [a b] from t').map((literal) => literal.value)).toEqual([]);
  });

  it('skips an unterminated bracketed identifier to the end', () => {
    expect(stringLiterals('select [oops from t').map((literal) => literal.value)).toEqual([]);
  });

  it('returns nothing for an unterminated literal', () => {
    expect(stringLiterals("select 'oops")).toEqual([]);
  });

  it('returns nothing for text with no literals', () => {
    expect(stringLiterals('select 1')).toEqual([]);
  });
});

describe('tableRefs', () => {
  it('reads a from table with no alias as its own alias', () => {
    expect(tableRefs('select * from orders')).toEqual([{ table: 'orders', alias: 'orders', joined: false }]);
  });

  it('reads an alias written with as', () => {
    expect(tableRefs('select * from orders as o')).toEqual([{ table: 'orders', alias: 'o', joined: false }]);
  });

  it('reads an alias written without as', () => {
    expect(tableRefs('select * from orders o')).toEqual([{ table: 'orders', alias: 'o', joined: false }]);
  });

  it('does not read a clause word as an alias', () => {
    expect(tableRefs('select * from orders join items on 1 = 1')).toEqual([
      { table: 'orders', alias: 'orders', joined: false },
      { table: 'items', alias: 'items', joined: true },
    ]);
  });

  it('reads a quoted table name', () => {
    expect(tableRefs('select * from "order items" as oi')).toEqual([{ table: 'order items', alias: 'oi', joined: false }]);
  });

  it('reads a table introduced by join as joined', () => {
    const refs = tableRefs('select * from a as x left join b as y on y.id = x.id');
    expect(refs.map((ref) => [ref.table, ref.joined])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  it('ignores from inside a literal', () => {
    expect(tableRefs("select * from t where note = 'from nowhere'")).toEqual([{ table: 't', alias: 't', joined: false }]);
  });

  it('ignores from inside a comment', () => {
    expect(tableRefs('select * from t -- from elsewhere')).toEqual([{ table: 't', alias: 't', joined: false }]);
  });

  it('skips a from that is followed by a subquery', () => {
    expect(tableRefs('select * from (select 1) as x')).toEqual([]);
  });

  it('skips as with nothing after it', () => {
    expect(tableRefs('select * from t as')).toEqual([{ table: 't', alias: 't', joined: false }]);
  });

  it('skips a from that ends the statement', () => {
    expect(tableRefs('select 1 from')).toEqual([]);
  });

  it('skips an unterminated bracketed identifier to the end', () => {
    expect(tableRefs('select * from [oops')).toEqual([]);
  });

  it('ignores a block comment when it looks for a table', () => {
    expect(tableRefs('select * from t /* from elsewhere */ join u on 1 = 1').map((ref) => ref.table)).toEqual(['t', 'u']);
  });

  it('ignores a line comment before the next table', () => {
    expect(tableRefs('select * from t -- from elsewhere\n, u').map((ref) => ref.table)).toEqual(['t']);
  });

  it('skips a table reference that opens a quote and never closes it', () => {
    expect(tableRefs('select * from "oops')).toEqual([]);
    expect(tableRefs('select * from `oops')).toEqual([]);
  });

  it('does not treat punctuation after a table as its alias', () => {
    expect(tableRefs('select * from t;').map((ref) => ref.alias)).toEqual(['t']);
    expect(tableRefs('select * from t)').map((ref) => ref.alias)).toEqual(['t']);
  });

});

describe('literalSites', () => {
  it('attributes a literal to the column it is compared with', () => {
    const [site] = literalSites("select * from t where status = 'active'");
    expect(site).toMatchObject({ column: 'status', operator: '=', literal: { value: 'active' } });
    expect(site?.qualifier).toBeUndefined();
  });

  it('keeps the qualifier and resolves a quoted column', () => {
    const [site] = literalSites(`select * from frpm f where f."School Type" = 'x'`);
    expect(site).toMatchObject({ column: 'School Type', qualifier: 'f' });
  });

  it('reports one site per member of an in list', () => {
    const sites = literalSites("select * from t where s in ('a', 'b')");
    expect(sites.map((site) => site.literal.value)).toEqual(['a', 'b']);
    expect(sites.every((site) => site.column === 's' && site.operator === 'in')).toBe(true);
  });

  it('keeps reading an in list past a member that is not a literal', () => {
    const sites = literalSites("select * from t where s in ('a', 1, 'b')");
    expect(sites.map((site) => site.literal.value)).toEqual(['a', 'b']);
  });

  it('stops an in list at a nested parenthesis', () => {
    expect(literalSites("select * from t where s in ('a', (select 1), 'b')").map((site) => site.literal.value)).toEqual(['a']);
  });

  it('stops an in list at its closing parenthesis', () => {
    expect(literalSites("select * from t where s in ('a')").map((site) => site.literal.value)).toEqual(['a']);
  });

  it('reads both members of a between', () => {
    const sites = literalSites("select * from t where d between '2020-01-01' and '2020-12-31'");
    expect(sites.map((site) => [site.operator, site.literal.value])).toEqual([
      ['between', '2020-01-01'],
      ['between', '2020-12-31'],
    ]);
  });

  it('leaves a between whose second member is not a literal', () => {
    expect(literalSites('select * from t where d between 1 and 2')).toEqual([]);
    expect(literalSites("select * from t where d between '2020-01-01' and y").map((site) => site.literal.value)).toEqual(['2020-01-01']);
  });

  it('reads a not in list', () => {
    expect(literalSites("select * from t where s not in ('a')").map((site) => site.operator)).toEqual(['not in']);
  });

  it('reads a like as a site and keeps the pattern as written', () => {
    const [site] = literalSites("select * from t where name like '%a%'");
    expect(site).toMatchObject({ operator: 'like', literal: { value: '%a%' } });
  });

  it('reads a symbol operator', () => {
    expect(literalSites("select * from t where n >= '5'").map((site) => site.operator)).toEqual(['>=']);
    expect(literalSites("select * from t where n <> '5'").map((site) => site.operator)).toEqual(['<>']);
  });

  it('reads an operator whose literal is wrapped in another parenthesis', () => {
    expect(literalSites("select * from t where s = ('a')").map((site) => site.literal.value)).toEqual(['a']);
  });

  it('has no site for a literal that is not compared with a column', () => {
    expect(literalSites("select 'x' from t")).toEqual([]);
  });

  it('has no site when the comparison has no literal on the right', () => {
    expect(literalSites('select * from t where a = b')).toEqual([]);
  });

  it('has no site inside a literal', () => {
    expect(literalSites("select * from t where a = 'x = ''y'''").map((site) => site.literal.value)).toEqual(['x = \'y\'']);
  });

  it('has no site inside a comment', () => {
    expect(literalSites("select * from t -- where a = 'x'")).toEqual([]);
  });

  it('has no site when the column is a clause word', () => {
    expect(literalSites("select * from t where as = 'x'")).toEqual([]);
  });

  it('reads a bracketed column name', () => {
    expect(literalSites("select * from t where [a b] = 'x'").map((site) => site.column)).toEqual(['a b']);
  });

  it('leaves a between whose and has no second literal', () => {
    expect(literalSites("select * from t where d between 'a' and").map((site) => site.literal.value)).toEqual(['a']);
  });

  it('leaves a list that closes without another member', () => {
    expect(literalSites("select * from t where s in ('a',) ").map((site) => site.literal.value)).toEqual(['a']);
  });

  it('leaves a between whose second word is not and', () => {
    expect(literalSites("select * from t where d between 'a' or x").map((site) => site.literal.value)).toEqual(['a']);
  });

  it('leaves a list that runs to the end of the text', () => {
    expect(literalSites("select * from t where s in ('a', ").map((site) => site.literal.value)).toEqual(['a']);
  });

  it('stops a list at a nested parenthesis', () => {
    expect(literalSites("select * from t where s in ('a', (1))").map((site) => site.literal.value)).toEqual(['a']);
  });

  it('has no site when the right-hand side is empty', () => {
    expect(literalSites('select * from t where s = ')).toEqual([]);
  });

});

/**
 * The mask a caller reads numbers from.
 *
 * It exists because the reader that looked for numeric literals with a regex over the whole
 * statement found the digits of a value string as well: `where year = '2020'` came back with
 * two literals, one of which nobody wrote. The contract that makes the fix safe is length
 * preservation — the caller finds a match in the mask and slices the original at that offset.
 */
describe('codeOnly', () => {
  it('blanks a literal and keeps every offset', () => {
    const sql = "select * from t where a = 'xyz' and b = 7";
    expect(codeOnly(sql)).toBe("select * from t where a =       and b = 7");
    expect(codeOnly(sql)).toHaveLength(sql.length);
  });

  it('blanks a doubled quote as one region', () => {
    expect(codeOnly("where n = 'Ancestor''s Chosen'")).toBe('where n =                     ');
  });

  it('blanks an empty literal', () => {
    expect(codeOnly("a <> ''")).toBe('a <>   ');
  });

  it('blanks a line comment', () => {
    expect(codeOnly("select 1 -- 'x' 2020\nselect 2")).toBe('select 1            \nselect 2');
  });

  it('blanks a block comment', () => {
    expect(codeOnly('select 1 /* 2020 */ 2')).toBe('select 1            2');
  });

  it('blanks a double-quoted identifier so its digits are not a number', () => {
    expect(codeOnly('select "2020" from t')).toBe('select        from t');
  });

  it('blanks a backtick-quoted identifier', () => {
    expect(codeOnly('select `a b` from t')).toBe('select       from t');
  });

  it('blanks a bracketed identifier', () => {
    expect(codeOnly('select [a 1] from t')).toBe('select       from t');
  });

  it('does not open a literal at a quote inside a quoted identifier', () => {
    expect(codeOnly(`select "O'Brien Rd", 5`)).toBe('select             , 5');
  });

  it('leaves an unterminated literal readable', () => {
    expect(codeOnly("select 1 where a = 'x")).toBe("select 1 where a = 'x");
  });
});

describe('the fields a statement names', () => {
  it('resolves a qualified field through the alias the statement gave the table', () => {
    const fields = referencedFields('select max(o.qty) from orders as o join warehouses w on w.id = o.warehouse_id');
    expect(fields.qualified).toEqual([
      { table: 'orders', column: 'qty' },
      { table: 'warehouses', column: 'id' },
      { table: 'orders', column: 'warehouse_id' },
    ]);
  });

  it('keeps a quoted column name whole, spaces and punctuation included', () => {
    const fields = referencedFields('select f."Charter School (Y/N)" from frpm f');
    expect(fields.qualified).toEqual([{ table: 'frpm', column: 'charter school (y/n)' }]);
  });

  it('reports a bare name without attributing it to a table', () => {
    const fields = referencedFields('select name, price from items');
    expect(fields.bare).toEqual(expect.arrayContaining(['name', 'price']));
    expect(fields.qualified).toEqual([]);
  });

  it('drops a qualifier that matches no table the statement reads', () => {
    // `x` is a table-like prefix that no `from` introduces, which is how a correlated name or a
    // function argument arrives. Attributing it would put a column on a card that cannot express it.
    expect(referencedFields('select x.qty from items').qualified).toEqual([]);
  });

  it('contributes nothing from a string literal that looks like a field', () => {
    expect(referencedFields("select 1 from items where name = 'a.b'").qualified).toEqual([]);
  });

  it('reads a bracketed column the same way it reads a quoted one', () => {
    expect(referencedFields('select [Order Date] from orders').bare).toContain('order date');
  });

  it('names no field in a statement that reads no table, and keeps the keyword as a bare token', () => {
    // `select` is a bare token here because the reader does not know the schema: it reports every
    // unqualified identifier and the caller intersects with the columns a table actually has. A
    // keyword filter in this file would be a second list of SQL words to keep in agreement with the
    // parser, and the caller already has the only list that matters — the card.
    expect(referencedFields('select 1')).toEqual({ qualified: [], bare: ['select'] });
  });
});

describe('the field scanner at its edges', () => {
  it('stops a qualified pair at the dot when no column follows it', () => {
    // `t.` at the end of a statement is broken SQL, and reporting a field named "" would put an
    // empty column on a card.
    expect(referencedFields('select qty from orders o where o.').qualified).toEqual([]);
  });

  it('reports nothing for an unterminated quoted name', () => {
    // A statement that never closes its quote has no field after it; the scanner refuses to guess
    // where the name ended, which is the same rule the literal reader follows.
    expect(referencedFields('select "qty from orders').qualified).toEqual([]);
  });

  it('steps over punctuation and numbers without treating them as names', () => {
    const fields = referencedFields('select qty * 2 + 1, price from orders');
    expect(fields.qualified).toEqual([]);
    expect(fields.bare).toEqual(expect.arrayContaining(['qty', 'price']));
    expect(fields.bare).not.toContain('2');
  });

  it('reads a table name written in brackets as a name, not as punctuation', () => {
    expect(referencedFields('select [Order Date] from [orders]').bare).toContain('order date');
  });

  it('stops at the end of a statement whose last characters are spaces', () => {
    // The scanner walks tokens up to the end of the text; a statement that ends in whitespace is
    // every statement a formatter produced, and reading past it would index outside the string.
    expect(referencedFields('select qty from orders   ').qualified).toEqual([]);
    expect(referencedFields('select qty from orders   ').bare).toContain('qty');
  });
});
