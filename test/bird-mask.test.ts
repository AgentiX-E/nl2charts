import { describe, expect, it } from 'vitest';
import { MASKED_PREAMBLE, canonicaliseDialect, maskIdentifiers, maskStatement } from '../eval/bird/mask.js';

/**
 * `I-84` is one edit measured against one reading: the `I-83` failure table, in which the stacked
 * examples moved `column-count` down 30 statements and added fifteen execution errors that named
 * either a column of another schema or a function SQLite does not have. The masker removes the
 * first, the canonicaliser the second, and this file states both as properties of the text rather
 * than as properties of one statement that happened to be read once.
 */

describe('masking the schema out of an example', () => {
  it('leaves the construction and replaces every name in it', () => {
    const sql =
      "SELECT T1.CustomerID FROM customers AS T1 INNER JOIN yearmonth AS T2 ON T1.CustomerID = T2.CustomerID " +
      "WHERE T1.Segment = 'LAM' GROUP BY T1.CustomerID ORDER BY SUM(T2.Consumption) ASC LIMIT 1";
    // The aggregate, the join direction, the equality, the grouping and the limit all survive; the
    // six names do not, and `CustomerID` is one placeholder on both sides of the equality — which
    // is the one thing a masked example must not lose, because it is what teaches the join.
    expect(maskIdentifiers(sql)).toBe(
      "SELECT T1.column_1 FROM table_1 AS T1 INNER JOIN table_2 AS T2 ON T1.column_1 = T2.column_1 " +
        "WHERE T1.column_2 = 'LAM' GROUP BY T1.column_1 ORDER BY SUM(T2.column_3) ASC LIMIT 1",
    );
  });

  it('masks a table that carries no alias at all', () => {
    // The table's own name doubles as its alias, and the name still has to go: an example that
    // keeps `from orders` keeps the word the mask exists to remove.
    expect(maskIdentifiers('SELECT SUM(price) FROM orders')).toBe('SELECT SUM(column_1) FROM table_1');
  });

  it('reads a comma-separated from as two tables', () => {
    expect(maskIdentifiers('SELECT * FROM authors, books WHERE authors.id = books.author_id')).toBe(
      'SELECT * FROM table_1, table_2 WHERE table_1.column_1 = table_2.column_2',
    );
  });

  it('keeps the names the statement binds itself', () => {
    // An alias is not schema and a table alias is what the rest of the statement reads: renaming
    // one end of it produces an example that does not run.
    const sql = 'SELECT o.total AS amount FROM orders o WHERE o.total > 0';
    expect(maskIdentifiers(sql)).toBe('SELECT o.column_1 AS amount FROM table_1 o WHERE o.column_1 > 0');
  });

  it('keeps a cast type, which is bound by the statement too', () => {
    expect(maskIdentifiers('SELECT CAST(score AS REAL) FROM exams')).toBe('SELECT CAST(column_1 AS REAL) FROM table_1');
  });

  it('keeps a CTE at both ends of the name', () => {
    const sql = 'WITH recent AS (SELECT * FROM orders WHERE created > 1) SELECT count(*) FROM recent';
    // Masking the definition and not the reference — or the other way round — is the failure that
    // makes a masked example fail to run, and the CTE is the one name both halves spell.
    expect(maskIdentifiers(sql)).toBe(
      'WITH recent AS (SELECT * FROM table_1 WHERE column_1 > 1) SELECT count(*) FROM recent',
    );
  });

  it('masks inside a subquery, and reads the subquery as a table list', () => {
    const sql = 'SELECT T1.a FROM (SELECT b FROM inner_table) AS T1';
    expect(maskIdentifiers(sql)).toBe('SELECT T1.column_1 FROM (SELECT column_2 FROM table_1) AS T1');
  });

  it('masks a quoted identifier and forgets its quote style', () => {
    expect(maskIdentifiers('SELECT `Order ID`, [Name] FROM `Orders`')).toBe('SELECT column_1, column_2 FROM table_1');
  });

  it('numbers tables and columns separately and by first appearance', () => {
    expect(maskIdentifiers('SELECT z, y FROM gamma JOIN delta ON gamma.z = delta.y')).toBe(
      'SELECT column_1, column_2 FROM table_1 JOIN table_2 ON table_1.column_1 = table_2.column_2',
    );
  });

  it('restarts the numbering for each statement', () => {
    // Placeholders are a per-example device, not a corpus-wide index: two examples that both say
    // `column_1` are two different columns, and numbering them 1 and 7 would suggest otherwise.
    expect(maskIdentifiers('SELECT a FROM one')).toBe('SELECT column_1 FROM table_1');
    expect(maskIdentifiers('SELECT b FROM two')).toBe('SELECT column_1 FROM table_1');
  });
});

describe('what a mask must not touch', () => {
  it('leaves a literal alone, even when it spells a table', () => {
    expect(maskIdentifiers("SELECT * FROM logs WHERE message = 'from orders where id = 1'")).toBe(
      "SELECT * FROM table_1 WHERE column_1 = 'from orders where id = 1'",
    );
  });

  it('leaves an escaped quote inside a literal alone', () => {
    expect(maskIdentifiers("SELECT name FROM people WHERE name = 'it''s me'")).toBe(
      "SELECT column_1 FROM table_1 WHERE column_1 = 'it''s me'",
    );
  });

  it('leaves keywords, functions and numbers alone', () => {
    const sql = 'SELECT COUNT(DISTINCT id), 1.5 FROM t WHERE x IS NOT NULL AND y LIKE \'%a%\' LIMIT 10';
    expect(maskIdentifiers(sql)).toBe(
      "SELECT COUNT(DISTINCT column_1), 1.5 FROM table_1 WHERE column_2 IS NOT NULL AND column_3 LIKE '%a%' LIMIT 10",
    );
  });

  it('keeps a time unit where the statement is using it as one', () => {
    // A unit is not a name: masking it produces an example that does not parse.
    expect(maskIdentifiers('SELECT * FROM events WHERE start > interval 30 day')).toBe(
      'SELECT * FROM table_1 WHERE column_1 > interval 30 day',
    );
    expect(maskIdentifiers('SELECT EXTRACT(YEAR FROM happened_at) FROM events')).toBe(
      'SELECT EXTRACT(YEAR FROM column_1) FROM table_1',
    );
  });

  it('masks a time unit that is used as a name', () => {
    // `day` after `select` and before `+` is neither of the two unit spellings, so it is a name.
    expect(maskIdentifiers('SELECT day + 1 FROM events')).toBe('SELECT column_1 + 1 FROM table_1');
  });

  it('masks a column that happens to be called year', () => {
    // `formula_1.races` has a column called `year`, and Mini-Dev's gold statements read it. A
    // keyword set that held the time units would leak that word on every one of them.
    expect(maskIdentifiers('SELECT year FROM races')).toBe('SELECT column_1 FROM table_1');
    expect(maskIdentifiers('SELECT T1.year FROM races AS T1')).toBe('SELECT T1.column_1 FROM table_1 AS T1');
  });

  it('drops a comment, which names columns as readily as the statement does', () => {
    expect(maskIdentifiers('SELECT a FROM t -- joins customers\nWHERE a = 1')).toBe(
      'SELECT column_1 FROM table_1  \nWHERE column_1 = 1',
    );
  });

  it('keeps a blank where a block comment stood, so two words do not become one', () => {
    expect(maskIdentifiers('SELECT a FROM/* the orders table */t')).toBe('SELECT column_1 FROM table_1');
  });

  it('masks a one-character name rather than emptying it', () => {
    // `unquote` on a bare `x` would strip a quote that is not there and leave nothing at all.
    expect(maskIdentifiers('SELECT x FROM t WHERE x > 1')).toBe('SELECT column_1 FROM table_1 WHERE column_1 > 1');
  });

  it('survives an unterminated literal', () => {
    // A statement this repository would refuse is still a statement a corpus can hold, and an
    // example renderer that threw on one would fail the run rather than publish a worse prompt.
    expect(maskIdentifiers("SELECT * FROM t WHERE a = 'unclosed")).toBe("SELECT * FROM table_1 WHERE column_1 = 'unclosed");
    expect(maskIdentifiers('SELECT a FROM t WHERE a = ')).toBe('SELECT column_1 FROM table_1 WHERE column_1 = ');
  });
});

describe('the dialect the harness executes', () => {
  it('rewrites a date part into strftime', () => {
    // `no such function: YEAR` and `no such function: MONTH` are two of the fifteen errors the
    // stacked examples added, and both are this one spelling.
    expect(canonicaliseDialect('SELECT YEAR(d) FROM t')).toBe("SELECT strftime('%Y', d) FROM t");
    expect(canonicaliseDialect('SELECT MONTH(d), DAY(d), HOUR(d), MINUTE(d) FROM t')).toBe(
      "SELECT strftime('%m', d), strftime('%d', d), strftime('%H', d), strftime('%M', d) FROM t",
    );
    expect(canonicaliseDialect('SELECT DAYOFMONTH(d) FROM t')).toBe("SELECT strftime('%d', d) FROM t");
  });

  it('rewrites a day difference into a julianday subtraction', () => {
    expect(canonicaliseDialect('SELECT DATEDIFF(a.end, a.start) FROM appointments a')).toBe(
      'SELECT (julianday(a.end) - julianday(a.start)) FROM appointments a',
    );
  });

  it('rewrites a concatenation into the operator SQLite has', () => {
    expect(canonicaliseDialect("SELECT CONCAT(a.first, ' ', a.last) FROM authors a")).toBe(
      "SELECT (a.first || ' ' || a.last) FROM authors a",
    );
  });

  it('rewrites a nested call through the same loop as its parent', () => {
    expect(canonicaliseDialect('SELECT LEN(CONCAT(a, b)) FROM t')).toBe('SELECT length((a || b)) FROM t');
  });

  it('splits arguments on commas at depth one', () => {
    // `coalesce(b, c)` is one argument of `concat`, and splitting on every comma would produce a
    // three-way concatenation of two arguments and half a function call.
    expect(canonicaliseDialect('SELECT CONCAT(a, COALESCE(b, c), d) FROM t')).toBe(
      'SELECT (a || COALESCE(b, c) || d) FROM t',
    );
  });

  it('trims the blanks an argument was written with', () => {
    // `year( d )` is the same call as `year(d)`, and a rewrite that kept the blanks would produce
    // `strftime('%Y',  d )` — readable, and not the text this file is claiming to produce.
    expect(canonicaliseDialect('SELECT YEAR( d ) FROM t')).toBe("SELECT strftime('%Y', d) FROM t");
    expect(canonicaliseDialect('SELECT YEAR(d ) FROM t')).toBe("SELECT strftime('%Y', d) FROM t");
  });

  it('renames the functions whose name changed but whose signature did not', () => {
    expect(canonicaliseDialect("SELECT SUBSTRING(name, 1, 3), LEN(x), UCASE(y), LCASE(z) FROM t")).toBe(
      "SELECT substr(name, 1, 3), length(x), upper(y), lower(z) FROM t",
    );
  });

  it('rewrites the zero-argument clock functions', () => {
    expect(canonicaliseDialect('SELECT NOW(), CURDATE() FROM t')).toBe("SELECT datetime('now'), date('now') FROM t");
  });

  it('leaves a call of an arity it does not know exactly as written', () => {
    // The failure mode has to be "this example still teaches a foreign function", which the arm
    // measures, and never "this example teaches a function that does not exist because a rewriter
    // guessed where the second argument was".
    expect(canonicaliseDialect('SELECT YEAR(), CONCAT(), SUBSTRING(x) FROM t')).toBe(
      'SELECT YEAR(), CONCAT(), SUBSTRING(x) FROM t',
    );
    // The two shapes of the same rule: a function that takes two arguments given one, and a function
    // that takes none given one.
    expect(canonicaliseDialect('SELECT DATEDIFF(a) FROM t')).toBe('SELECT DATEDIFF(a) FROM t');
    expect(canonicaliseDialect('SELECT NOW(x) FROM t')).toBe('SELECT NOW(x) FROM t');
  });

  it('leaves a call whose parenthesis never closes exactly as written', () => {
    // The statement is broken and a rewrite built on a guess about where the call ended would invent
    // text; this is the same rule as the unterminated literal, one level up.
    expect(canonicaliseDialect('SELECT CONCAT(a, b FROM t')).toBe('SELECT CONCAT(a, b FROM t');
    expect(maskIdentifiers('SELECT CONCAT(a, b FROM t')).toBe('SELECT CONCAT(column_1, column_2 FROM table_1');
  });

  it('leaves a bare name that is not called alone', () => {
    expect(canonicaliseDialect('SELECT year FROM t')).toBe('SELECT year FROM t');
  });

  it('renders every quoted identifier in the quote style SQLite accepts', () => {
    expect(canonicaliseDialect('SELECT `a`, [b], "c" FROM `T`')).toBe('SELECT "a", "b", "c" FROM "T"');
  });

  it('doubles an inner quote when it converts one', () => {
    // `` `say "hi"` `` is an identifier whose name contains double quotes, and converting the
    // quotes around the name without doubling the ones inside it produces two identifiers.
    expect(canonicaliseDialect('SELECT `say "hi"` FROM t')).toBe('SELECT "say ""hi""" FROM t');
  });

  it('drops a comment rather than letting it rejoin two words', () => {
    expect(canonicaliseDialect('SELECT a FROM/*x*/t')).toBe('SELECT a FROM t');
    expect(canonicaliseDialect('SELECT a FROM t # trailing\nWHERE a = 1')).toBe('SELECT a FROM t  \nWHERE a = 1');
  });

  it('leaves an unterminated quote and an unterminated comment visibly broken', () => {
    expect(canonicaliseDialect('SELECT `a FROM t')).toBe('SELECT `a FROM t');
    expect(canonicaliseDialect('SELECT a FROM t /* never closed')).toBe('SELECT a FROM t  ');
  });
});

describe('a statement the scanner can only partly read', () => {
  // BIRD's training split is 9,428 statements written by 69 different hands against SQLite, and a
  // renderer that threw on one of them would fail the run rather than publish a worse prompt. Each
  // case below is a truncation, and the claim is the same for all of them: the masker is total, it
  // keeps what it cannot read, and it never invents an identifier.
  it('keeps a comment that runs to the end of the statement', () => {
    // The comment becomes a blank, and the space before it stays: two blanks, one statement.
    expect(canonicaliseDialect('SELECT a FROM t -- the orders table')).toBe('SELECT a FROM t  ');
    expect(maskIdentifiers('SELECT a FROM t # the orders table')).toBe('SELECT column_1 FROM table_1  ');
  });

  it('reads a number the statement ends on', () => {
    // `1.` is one number in SQLite, and reading it as `1` and a dot made the dot the qualifier of
    // the next word: the keyword that opens the table list came out as a column and the table after
    // it as another one.
    expect(maskIdentifiers('SELECT 1. FROM t')).toBe('SELECT 1. FROM table_1');
  });

  it('reads a parenthesis that belongs to no call', () => {
    // `((a))` opens frames with no word in front of them, which is what tells the table scan that a
    // `from` inside them is a real one.
    expect(maskIdentifiers('SELECT ((a)) FROM t')).toBe('SELECT ((column_1)) FROM table_1');
  });

  it('keeps a from with nothing behind it', () => {
    expect(maskIdentifiers('SELECT * FROM')).toBe('SELECT * FROM');
    expect(maskIdentifiers('SELECT * FROM (')).toBe('SELECT * FROM (');
    // A lone quote is a name with nothing inside it, and it still comes out as the placeholder the
    // position calls for rather than as the character that would end the statement early.
    expect(maskIdentifiers('SELECT * FROM "')).toBe('SELECT * FROM table_1');
    expect(maskIdentifiers('SELECT * FROM t AS')).toBe('SELECT * FROM table_1 AS');
  });

  it('keeps an alias the statement ends on', () => {
    expect(maskIdentifiers('SELECT * FROM t x')).toBe('SELECT * FROM table_1 x');
  });

  it('keeps a CTE whose body never arrives', () => {
    expect(maskIdentifiers('WITH t AS (')).toBe('WITH t AS (');
    expect(maskIdentifiers('WITH t AS (1)')).toBe('WITH t AS (1)');
    expect(maskIdentifiers('WITH t AS (a) SELECT * FROM t')).toBe('WITH t AS (column_1) SELECT * FROM t');
  });
});

describe('both edits on one statement', () => {
  it('prices an example that would have taught a column of another schema and a function of another dialect', () => {
    const sql =
      "SELECT YEAR(T1.discharge_date) - YEAR(T1.admission_date) FROM stays AS T1 WHERE T1.hospital = 'X'";
    // The `I-83` failure table in one line: `YEAR` is one of the `no such function` errors and
    // `discharge_date` / `admission_date` / `hospital` are the `no such column` ones.
    expect(maskStatement(sql)).toBe(
      "SELECT strftime('%Y', T1.column_1) - strftime('%Y', T1.column_2) FROM table_1 AS T1 WHERE T1.column_3 = 'X'",
    );
  });

  it('says what the placeholders are, in a sentence that names them', () => {
    // A model shown `from table_1` and not told what it is writes `from table_1`: the mask is a
    // trap unless the block says so.
    expect(MASKED_PREAMBLE).toContain('table_1');
    expect(MASKED_PREAMBLE).toContain('column_1');
    expect(MASKED_PREAMBLE.length).toBeLessThan(220);
  });
});
