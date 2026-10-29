import { describe, expect, it } from 'vitest';
import { literalSites, stringLiterals, tableRefs } from '../eval/bird/statement.js';

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
