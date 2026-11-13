import { describe, expect, it } from 'vitest';
import { attemptsStatement, DEFAULT_POLICY, inspectSql, statementHeads, tokenize, withRowLimit } from '../src/guard.js';

interface Case {
  readonly name: string;
  readonly sql: string;
  readonly ok: boolean;
  readonly reason?: string;
}

const LONG = `SELECT ${'a'.repeat(100_000)}`;

const CASES: readonly Case[] = [
  { name: 'plain select', sql: 'SELECT 1', ok: true },
  { name: 'star select', sql: 'select * from t', ok: true },
  { name: 'cte', sql: 'WITH x AS (SELECT 1) SELECT * FROM x', ok: true },
  { name: 'recursive cte', sql: 'WITH RECURSIVE r AS (SELECT 1) SELECT * FROM r', ok: true },
  { name: 'semicolon inside string', sql: "SELECT 'a;b' AS s", ok: true },
  { name: 'semicolon inside quoted identifier', sql: 'SELECT "weird;name" FROM t', ok: true },
  { name: 'replace function is not a banned keyword', sql: "SELECT replace(a,'x','y') FROM t", ok: true },
  { name: 'line comment is stripped', sql: 'SELECT * FROM t -- DROP TABLE t', ok: true },
  { name: 'block comment is stripped', sql: 'SELECT /* DROP TABLE t */ 1', ok: true },
  { name: 'trailing semicolon', sql: 'SELECT 1;', ok: true },
  { name: 'trailing semicolon then comment', sql: 'SELECT 1; -- done', ok: true },
  { name: 'dollar quoted string', sql: 'SELECT $$drop table x$$ AS s', ok: true },
  { name: 'tagged dollar quote', sql: 'SELECT $tag$ ; $tag$', ok: true },
  { name: 'values list', sql: 'VALUES (1),(2)', ok: true },
  { name: 'explain', sql: 'EXPLAIN SELECT 1', ok: true },
  { name: 'describe', sql: 'DESCRIBE SELECT 1', ok: true },
  { name: 'summarize', sql: 'SUMMARIZE SELECT 1', ok: true },
  { name: 'limit present', sql: 'SELECT 1 LIMIT 10', ok: true },
  { name: 'subquery', sql: 'SELECT (SELECT 1) AS x', ok: true },
  { name: 'escaped quote', sql: "SELECT a FROM t WHERE b = 'it''s'", ok: true },
  { name: 'exponent literal', sql: 'SELECT 1e10', ok: true },
  { name: 'negative decimal', sql: 'SELECT -1.5', ok: true },
  { name: 'signed exponent', sql: 'SELECT 1.0e-3', ok: true },
  { name: 'group by', sql: 'SELECT count(*) FROM t GROUP BY a', ok: true },
  { name: 'in list', sql: 'SELECT * FROM t WHERE x IN (1,2)', ok: true },
  { name: 'quoted banned word is an identifier', sql: 'SELECT a AS "SET" FROM t', ok: true },
  { name: 'banned word inside string', sql: "SELECT * FROM t WHERE s = 'INSERT'", ok: true },
  { name: 'empty statement', sql: '   ', ok: false, reason: 'empty-statement' },
  { name: 'two statements', sql: 'SELECT 1; SELECT 2', ok: false, reason: 'multiple-statements' },
  { name: 'statement then drop', sql: 'SELECT 1; DROP TABLE t', ok: false, reason: 'multiple-statements' },
  { name: 'ddl head', sql: 'DROP TABLE t', ok: false, reason: 'unclassified-statement' },
  { name: 'dml head', sql: 'INSERT INTO t VALUES (1)', ok: false, reason: 'unclassified-statement' },
  { name: 'pragma head', sql: 'PRAGMA database_list', ok: false, reason: 'unclassified-statement' },
  { name: 'select into', sql: 'SELECT * INTO x FROM t', ok: false, reason: 'banned-keyword' },
  { name: 'update as column name', sql: 'SELECT update FROM t', ok: false, reason: 'banned-keyword' },
  { name: 'pivot', sql: 'SELECT * FROM t PIVOT (sum(x) FOR y IN (1))', ok: false, reason: 'banned-keyword' },
  { name: 'version pinned table', sql: 'SELECT * FROM t AT (VERSION => 1)', ok: false, reason: 'version-pinned-table' },
  { name: 'file reading function', sql: "SELECT read_csv('x.csv')", ok: false, reason: 'banned-function' },
  { name: 'unterminated string', sql: "SELECT 'abc", ok: false, reason: 'unterminated-string' },
  { name: 'unterminated identifier', sql: 'SELECT "abc', ok: false, reason: 'unterminated-identifier' },
  { name: 'unterminated comment', sql: 'SELECT /* abc', ok: false, reason: 'unterminated-comment' },
  { name: 'unterminated dollar quote', sql: 'SELECT $tag$ abc', ok: false, reason: 'unterminated-dollar-quote' },
  { name: 'parameter placeholder', sql: 'SELECT * FROM t WHERE a = @x', ok: false, reason: 'unclassified-statement' },
  { name: 'over the length ceiling', sql: LONG, ok: false, reason: 'too-long' },
];

describe('statement guard corpus', () => {
  it('classifies every case in the 44-statement corpus exactly once', () => {
    expect(CASES.length).toBe(44);
    for (const testCase of CASES) {
      const verdict = inspectSql(testCase.sql);
      expect(verdict.ok, `${testCase.name}: ${JSON.stringify(verdict)}`).toBe(testCase.ok);
      if (!testCase.ok && !verdict.ok) {
        expect(verdict.reason, testCase.name).toBe(testCase.reason);
      }
      if (testCase.ok && verdict.ok) {
        expect(verdict.sql).toBe(testCase.sql);
      }
    }
  });

  it('reports the statement kind for accepted input', () => {
    const withCte = inspectSql('WITH x AS (SELECT 1) SELECT * FROM x');
    expect(withCte.ok && withCte.kind).toBe('with');
    const explain = inspectSql('EXPLAIN SELECT 1');
    expect(explain.ok && explain.kind).toBe('explain');
  });

  it('honours a narrowed policy', () => {
    const strict = { ...DEFAULT_POLICY, allowedKinds: ['select'] as const };
    expect(inspectSql('WITH x AS (SELECT 1) SELECT * FROM x', strict).ok).toBe(false);
    expect(inspectSql('SELECT 1', strict).ok).toBe(true);
  });

  it('keeps the default policy lists free of duplicates', () => {
    expect(new Set(DEFAULT_POLICY.bannedWords).size).toBe(DEFAULT_POLICY.bannedWords.length);
    expect(new Set(DEFAULT_POLICY.bannedFunctions).size).toBe(DEFAULT_POLICY.bannedFunctions.length);
  });
});

describe('tokenizer', () => {
  it('drops comments and keeps literal payloads', () => {
    const tokens = tokenize('SELECT 1 /* x */ -- y\n, \'a\'\n');
    expect(tokens.map((token) => token.value)).toEqual(['SELECT', '1', ',', 'a']);
    expect(tokens[3]?.type).toBe('string');
  });

  it('distinguishes quoted identifiers from strings', () => {
    const tokens = tokenize('SELECT "a""b", \'c\'\'d\'');
    expect(tokens[1]).toEqual({ type: 'quoted', value: 'a"b' });
    expect(tokens[3]).toEqual({ type: 'string', value: "c'd" });
  });

  it('keeps a literal that looks like an operator', () => {
    const tokens = tokenize('SELECT 1e-3');
    expect(tokens[1]).toEqual({ type: 'number', value: '1e-3' });
  });
});

describe('row limit injection', () => {
  it('appends a cap when there is none', () => {
    expect(withRowLimit('SELECT * FROM t', 99)).toBe('SELECT * FROM t LIMIT 99');
  });

  it('keeps an existing top-level limit', () => {
    expect(withRowLimit('SELECT * FROM t LIMIT 5', 99)).toBe('SELECT * FROM t LIMIT 5');
  });

  it('does not treat a nested limit as the top-level one', () => {
    expect(withRowLimit('SELECT (SELECT 1 LIMIT 1) FROM t', 9)).toBe('SELECT (SELECT 1 LIMIT 1) FROM t LIMIT 9');
  });

  it('inserts before a trailing semicolon', () => {
    expect(withRowLimit('SELECT 1;', 2)).toBe('SELECT 1 LIMIT 2');
  });

  it('leaves a rejected statement untouched', () => {
    expect(withRowLimit('DROP TABLE t', 5)).toBe('DROP TABLE t');
  });

  it('floors fractional and negative caps at zero', () => {
    expect(withRowLimit('SELECT 1', 3.9)).toBe('SELECT 1 LIMIT 3');
    expect(withRowLimit('SELECT 1', -4)).toBe('SELECT 1 LIMIT 0');
  });
});

describe('backtick identifiers', () => {
  it('accepts a backtick-quoted identifier, as SQLite and MySQL do', () => {
    expect(inspectSql('select `Order Total` from orders')).toMatchObject({ ok: true });
    expect(inspectSql('select `a``b` from t')).toMatchObject({ ok: true });
    expect(inspectSql('select 1 from `t`')).toMatchObject({ ok: true });
  });

  it('rejects an unterminated backtick', () => {
    expect(inspectSql('select `open from t')).toMatchObject({ ok: false, reason: 'unterminated-identifier' });
  });

  it('does not treat a semicolon inside backticks as a statement separator', () => {
    expect(inspectSql('select `a;b` from t')).toMatchObject({ ok: true });
    expect(inspectSql('select 1; select 2')).toMatchObject({ ok: false });
  });

  it('still refuses a write hidden behind a backtick', () => {
    expect(inspectSql('delete from `orders`')).toMatchObject({ ok: false, reason: 'unclassified-statement' });
  });
});

describe('whether a reply is a statement at all', () => {
  it('reads the statement kinds the policy accepts', () => {
    for (const sql of ['SELECT 1', '  select * from t', '(SELECT 1) UNION (SELECT 2)', 'WITH x AS (SELECT 1) SELECT * FROM x', 'VALUES (1)']) {
      expect(attemptsStatement(sql), sql).toBe(true);
    }
  });

  it('reads the words the policy bans as statements too', () => {
    // A reply that opens with `insert` is a write attempt and the guard must refuse it as one.
    // Calling it prose would hide a write inside a channel failure, which is the wrong way round:
    // the dangerous reply would be reported as an unreadable one.
    for (const sql of ['INSERT INTO t VALUES (1)', 'delete from t', 'drop table t', 'PRAGMA database_list']) {
      expect(attemptsStatement(sql), sql).toBe(true);
    }
  });

  it('does not read prose as a statement', () => {
    for (const text of ['Let me think about this.', 'The answer needs a subquery.', 'Actually: SELECT 1 would work', '']) {
      expect(attemptsStatement(text), text).toBe(false);
    }
  });

  it('does not throw on the replies the tokenizer refuses', () => {
    // The input is exactly what `tokenize` throws on — a stray `?`, an unclosed quote — because
    // the classifier is consulted *because* the gate refused. A classifier that throws on its own
    // input reports nothing, and the refusal becomes a crash.
    expect(() => attemptsStatement('Is it 2012?')).not.toThrow();
    expect(attemptsStatement("Don't use the 2012 rows")).toBe(false);
    expect(attemptsStatement("SELECT 'open")).toBe(true);
  });

  it('accepts the prefix the statement reader accepts', () => {
    // `extractSql` strips `sql:`, so a reply carrying it is a statement to the reader. A
    // classifier that disagreed would call a statement prose and refuse it after the reader had
    // already found it.
    expect(attemptsStatement('sql: SELECT 1')).toBe(true);
  });

  it('agrees with the guard: nothing it accepts is prose', () => {
    // The invariant that makes the classification safe rather than a second opinion. Every
    // statement the gate accepts must be one the classifier calls a statement attempt; a single
    // disagreement would mean an accepted statement was refused as unreadable.
    const accepted = [
      'SELECT 1',
      'select `a` from t',
      'WITH RECURSIVE r AS (SELECT 1) SELECT * FROM r',
      'SELECT "weird;name" FROM t',
      "SELECT replace(a,'x','y') FROM t",
      'VALUES (1)',
    ];
    for (const sql of accepted) {
      expect(inspectSql(sql).ok, sql).toBe(true);
      expect(attemptsStatement(sql), sql).toBe(true);
    }
  });

  it('derives its words from the policy rather than from a second copy', () => {
    // A policy that bans a word the classifier does not know would classify a write attempt as
    // prose. Narrowing the policy in one place is the test: the classifier must follow it.
    const narrowed = { ...DEFAULT_POLICY, bannedWords: ['insert'] };
    expect(statementHeads(narrowed).has('insert')).toBe(true);
    expect(statementHeads(narrowed).has('truncate')).toBe(false);
    expect(attemptsStatement('truncate t')).toBe(true);
    expect(attemptsStatement('truncate t', narrowed)).toBe(false);
  });
});
