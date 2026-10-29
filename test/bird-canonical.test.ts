/**
 * The canonicaliser, held against a real engine.
 *
 * The module exists to close one channel: a judge that cannot see labels can still see
 * style, and the judge swap measured that it uses it (25.6% against 68.2% for the same
 * statement depending on who reads it). A transformation that closes the channel but
 * changes what a statement computes would be worse than the bias it removes, so the claim
 * that has to hold is not "the strings look alike" but "both forms return the same rows" —
 * and that claim is tested by executing both on SQLite rather than by reading the code.
 *
 * The corpus is deliberately adversarial: literals whose case decides the answer, quoted
 * identifiers, a blob literal, JSON operators, comments in both styles, `!=` beside `<>`,
 * a negative number beside a subtraction, and a semicolon that separates rather than ends.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { canonicalSql, tokenizeSql } from '../eval/bird/canonical.js';
import { readableCandidates } from '../eval/bird/run.js';

interface Executed {
  readonly ok: boolean;
  readonly rows: readonly (readonly unknown[])[];
  readonly error?: string;
}

const SCHEMA = [
  'create table items (id integer primary key, name text, price real, payload text, note text);',
  "insert into items values (1, 'Pen', 2.5, '{\"a\": 1}', 'Alpha');",
  "insert into items values (2, 'pen', 3.5, '{\"a\": 2}', 'beta');",
  "insert into items values (3, 'Ink', 4.0, null, 'Alpha');",
].join('\n');

const RUNNER = [
  'import json, sqlite3, sys',
  'payload = json.load(sys.stdin)',
  'db = sqlite3.connect(":memory:")',
  'db.executescript(payload["schema"])',
  'out = []',
  'for sql in payload["statements"]:',
  '    try:',
  '        # A blob comes back as bytes, which JSON cannot carry; hex keeps it comparable.',
  '        rows = [[("blob:" + v.hex()) if isinstance(v, bytes) else v for v in row] for row in db.execute(sql).fetchall()]',
  '        out.append({"ok": True, "rows": rows})',
  '    except Exception as exc:',
  '        out.append({"ok": False, "rows": [], "error": str(exc)})',
  'json.dump(out, sys.stdout)',
].join('\n');

/** Execute every statement in one interpreter, on one in-memory database. */
function execute(statements: readonly string[]): Executed[] {
  const stdout = execFileSync('python3', ['-c', RUNNER], {
    input: JSON.stringify({ schema: SCHEMA, statements }),
  });
  return JSON.parse(stdout.toString()) as Executed[];
}

/** A statement this file executes in both forms. */
const CORPUS: readonly string[] = [
  'SELECT  count(*)   FROM items;',
  'select COUNT(*) from items',
  "SELECT name FROM items WHERE name = 'Pen'",
  "select name from items where name='Pen'",
  "SELECT name FROM items WHERE name = 'pen'",
  'SELECT "name" FROM items',
  'SELECT [name] FROM items ORDER BY id',
  'SELECT * FROM items WHERE price != 2.5',
  'SELECT * FROM items WHERE price <> 2.5',
  'SELECT * FROM items WHERE price == 2.5',
  'SELECT * FROM items WHERE price >= 3 AND price <= 4',
  'SELECT * FROM items WHERE price>=3 and price<=4',
  'SELECT items.name FROM items ORDER BY items.id',
  'SELECT t.name FROM items AS t ORDER BY t.id',
  'SELECT count(*) FROM items -- how many',
  '/* leading */ SELECT count(*) FROM items /* trailing */',
  'SELECT 1e6',
  'SELECT 1e-3',
  'SELECT .5',
  'select sum(price) as total from items group by note having sum(price) > 3 order by total',
  "select json_extract(payload, '$.a') from items where payload is not null order by id",
  "select payload ->> '$.a' from items where payload is not null order by id",
  "select count(*) from items where name like 'pen'",
  "select count(*) from items where name glob 'Pen*'",
  'select -price from items order by id',
  'select - price from items order by id',
  'select 3 - -1',
  'select 3-1',
  "select x'41'",
  'select X\'41\'',
  "select cast('12' as integer)",
  'select name from items order by name desc limit 2 offset 1',
  'select distinct note from items order by note',
  "select ifnull(note, 'none') from items order by id",
  "select 'it''s'",
  "select group_concat(name, ',') from items",
  "select printf('%d-%s', id, name) from items order by id",
  'select (select count(*) from items) as n',
  'select case when price > 3 then 1 else 0 end from items order by id',
  'select name, Row_Number() OVER (PARTITION BY note ORDER BY id) as rn from items order by id',
];

describe('canonicalisation on a real engine', () => {
  const originals = execute(CORPUS);
  const canonical = execute(CORPUS.map((sql) => canonicalSql(sql)));

  it('executes every statement of the corpus in both forms', () => {
    // If a statement did not run, the comparison below would be a comparison of two errors
    // and would pass for the wrong reason.
    const failed = CORPUS.filter((_, index) => originals[index]?.ok !== true);
    expect(failed).toEqual([]);
  });

  it('returns the same rows in the canonical form', () => {
    for (const [index, sql] of CORPUS.entries()) {
      expect(canonical[index]?.rows, sql).toEqual(originals[index]?.rows);
    }
  });

  it('keeps a statement valid where the original was', () => {
    for (const [index, sql] of CORPUS.entries()) {
      expect(canonical[index]?.ok, `${sql} -> ${String(canonical[index]?.error)}`).toBe(true);
    }
  });

  it('is idempotent over the whole corpus', () => {
    for (const sql of CORPUS) expect(canonicalSql(canonicalSql(sql)), sql).toBe(canonicalSql(sql));
  });

  it('collapses two styles of one statement to one string', () => {
    const pairs: readonly (readonly [string, string])[] = [
      ['SELECT count(*) FROM items', 'select  Count( * )  from  ITEMS ;'],
      ['SELECT name FROM items WHERE price >= 3', 'select NAME from ITEMS where PRICE>=3\n'],
      ['SELECT * FROM items WHERE price != 2.5', 'select * from items where price <> 2.5'],
      ['SELECT * FROM items WHERE price == 2.5', 'select * from items where price = 2.5'],
      ['SELECT t.name FROM items AS t', 'select T.NAME\n  from ITEMS as T'],
      ["select 'it''s'", "SELECT 'it''s'"],
    ];
    for (const [left, right] of pairs) expect(canonicalSql(right), right).toBe(canonicalSql(left));
  });

  it('leaves the two statements of a divided script apart', () => {
    // Dropping the interior semicolon would join them into one statement that returns
    // the second select only, which is a different answer.
    expect(canonicalSql('select 1; select 2;')).toBe('SELECT 1; SELECT 2');
    const rows = execute([canonicalSql('select 1')])[0]?.rows;
    expect(rows).toEqual([[1]]);
  });
});

describe('the scanner', () => {
  const kinds = (sql: string): string[] => tokenizeSql(sql).map((token) => `${token.kind}:${token.text}`);

  it('reads a keyword, a name, a number and punctuation apart', () => {
    expect(kinds('select a1 from t')).toEqual(['word:select', 'word:a1', 'word:from', 'word:t']);
    expect(kinds('t.*')).toEqual(['word:t', 'punct:.', 'op:*']);
  });

  it('takes the longest operator, so a comparison is one token', () => {
    expect(kinds('a<=b')).toEqual(['word:a', 'op:<=', 'word:b']);
    expect(kinds('a<>b')).toEqual(['word:a', 'op:<>', 'word:b']);
    expect(kinds('a!=b')).toEqual(['word:a', 'op:!=', 'word:b']);
    expect(kinds('a ->> b')).toEqual(['word:a', 'op:->>', 'word:b']);
    expect(kinds('a->b')).toEqual(['word:a', 'op:->', 'word:b']);
    expect(kinds('a || b')).toEqual(['word:a', 'op:||', 'word:b']);
  });

  it('keeps a string literal whole, doubled quotes and all', () => {
    expect(kinds("'it''s a test'")).toEqual(["literal:'it''s a test'"]);
    expect(kinds(`"Order ""ID"""`)).toEqual(['quoted:"Order ""ID"""']);
    expect(kinds('`Order ID`')).toEqual(['quoted:`Order ID`']);
    expect(kinds('[Order ID]')).toEqual(['quoted:[Order ID]']);
  });

  it('takes the rest of the input when a construct is unterminated', () => {
    // A model that forgets a quote produces a wrong answer, not a crashed case.
    expect(kinds("select 'abc")).toEqual(['word:select', "literal:'abc"]);
    expect(kinds('select /* abc')).toEqual(['word:select']);
    expect(kinds('select [abc')).toEqual(['word:select', 'quoted:[abc']);
    expect(kinds('select 1 -- abc')).toEqual(['word:select', 'number:1']);
  });

  it('does not mistake a minus for a comment', () => {
    expect(kinds('a - b')).toEqual(['word:a', 'op:-', 'word:b']);
    expect(kinds('a- b')).toEqual(['word:a', 'op:-', 'word:b']);
    // `--` is a comment wherever it appears, which is SQLite's rule and not a guess.
    expect(kinds('a--b')).toEqual(['word:a']);
  });

  it('reads a number with a decimal point, a leading point, or an exponent', () => {
    expect(kinds('1.5')).toEqual(['number:1.5']);
    expect(kinds('.5')).toEqual(['number:.5']);
    expect(kinds('1e6')).toEqual(['number:1e6']);
    expect(kinds('1.2e-3')).toEqual(['number:1.2e-3']);
    // `e` is only an exponent when a digit or sign follows it, so this stays a name.
    expect(kinds('1e')).toEqual(['number:1', 'word:e']);
    expect(kinds('1ex')).toEqual(['number:1', 'word:ex']);
    // A dot at the very end has nothing after it to look at, and is still punctuation.
    expect(kinds('a.')).toEqual(['word:a', 'punct:.']);
  });

  it('marks whether a token was separated from the one before it', () => {
    const flags = (sql: string): boolean[] => tokenizeSql(sql).map((token) => token.spaceBefore);
    expect(flags("x'41'")).toEqual([true, false]);
    expect(flags("x '41'")).toEqual([true, true]);
    // A comment is a separator even though it produces no token.
    expect(flags('x/*c*/1')).toEqual([true, true]);
  });

  it('keeps a character it does not model rather than dropping it', () => {
    // Dropping the character would silently change the statement; keeping it makes the
    // canonical form fail to execute, which is a visible wrong answer.
    expect(kinds('a ? b')).toEqual(['word:a', 'op:?', 'word:b']);
    expect(canonicalSql('?1')).toBe('?1');
    expect(canonicalSql(':name')).toBe(':name');
    expect(canonicalSql('@name')).toBe('@name');
    expect(canonicalSql('$name')).toBe('$name');
  });
});

describe('the canonical form', () => {
  it('upper-cases a keyword and lower-cases a name', () => {
    expect(canonicalSql('select Name from Items')).toBe('SELECT name FROM items');
    expect(canonicalSql('SeLeCt COUNT(*) FrOm items')).toBe('SELECT COUNT(*) FROM items');
  });

  it('collapses runs of whitespace, newlines and tabs to one space', () => {
    expect(canonicalSql('select\n\tname\r\n  from   items')).toBe('SELECT name FROM items');
    expect(canonicalSql('  select 1  ')).toBe('SELECT 1');
  });

  it('binds punctuation without a space and separates words with one', () => {
    expect(canonicalSql('count ( * )')).toBe('COUNT(*)');
    expect(canonicalSql('t . name')).toBe('t.name');
    expect(canonicalSql('a , b')).toBe('a, b');
    expect(canonicalSql('sum ( price ) as revenue')).toBe('SUM(price) AS revenue');
    expect(canonicalSql('in ( 1 , 2 )')).toBe('IN(1, 2)');
  });

  it('removes both kinds of comment', () => {
    expect(canonicalSql('select 1 -- note')).toBe('SELECT 1');
    expect(canonicalSql('/* a */ select /* b */ 1')).toBe('SELECT 1');
    expect(canonicalSql('select 1 /* unterminated')).toBe('SELECT 1');
  });

  it('drops only a trailing semicolon', () => {
    expect(canonicalSql('select 1;')).toBe('SELECT 1');
    expect(canonicalSql('select 1 ;;;  ')).toBe('SELECT 1');
    expect(canonicalSql('select 1; select 2')).toBe('SELECT 1; SELECT 2');
  });

  it('returns nothing for nothing', () => {
    expect(canonicalSql('')).toBe('');
    expect(canonicalSql('   \n\t ')).toBe('');
    expect(canonicalSql(';')).toBe('');
    expect(canonicalSql('-- only a comment')).toBe('');
  });

  it('unifies the spelling of one operator', () => {
    expect(canonicalSql('a != b')).toBe('a <> b');
    expect(canonicalSql('a <> b')).toBe('a <> b');
    expect(canonicalSql('a == b')).toBe('a = b');
  });

  it('upper-cases a name that is also a function, which changes nothing', () => {
    // `total` is SQLite's sum-of-squares aggregate and also a perfectly good alias. Case is
    // not meaning for a name, and the corpus executes `AS TOTAL` to the same rows.
    expect(canonicalSql('select sum(price) as total from items')).toBe('SELECT SUM(price) AS TOTAL FROM items');
    expect(canonicalSql('select total(price) from items')).toBe('SELECT TOTAL(price) FROM items');
  });
});

describe('what it will not touch', () => {
  it('copies a string literal byte for byte, case included', () => {
    expect(canonicalSql("select * from t where s = 'Banned'")).toBe("SELECT * FROM t WHERE s = 'Banned'");
    expect(canonicalSql("select * from t where s = 'banned'")).toBe("SELECT * FROM t WHERE s = 'banned'");
    expect(canonicalSql("select 'it''s'")).toBe("SELECT 'it''s'");
  });

  it('copies a quoted identifier byte for byte, case included', () => {
    expect(canonicalSql('select "Order ID" from t')).toBe('SELECT "Order ID" FROM t');
    expect(canonicalSql('select `Order ID` from t')).toBe('SELECT `Order ID` FROM t');
    expect(canonicalSql('select [Order ID] from t')).toBe('SELECT [Order ID] FROM t');
  });

  it('keeps a blob literal glued to its prefix', () => {
    // `x'41'` is the blob "A" and `x '41'` is a name beside a string: the space is the
    // difference between the two statements, so it survives normalisation.
    expect(canonicalSql("select x'41'")).toBe("SELECT x'41'");
    expect(canonicalSql("select X'41'")).toBe("SELECT x'41'");
    expect(canonicalSql("select x '41'")).toBe("SELECT x '41'");
  });

  it('keeps a parameter glued to its prefix', () => {
    expect(canonicalSql('select * from t where a = ?1')).toBe('SELECT * FROM t WHERE a = ?1');
    expect(canonicalSql('select * from t where a = ? 1')).toBe('SELECT * FROM t WHERE a = ? 1');
    // SQLite's `?`, `:name`, `@name` and `$name` are bound parameters, not operators.
    expect(tokenizeSql('?1').map((token) => token.text)).toEqual(['?', '1']);
  });

  it('does not reorder, rename or simplify anything', () => {
    const sql = 'select a as alpha, b as beta from t1 join t2 on t1.k = t2.k where a > 0';
    expect(canonicalSql(sql)).toBe('SELECT a AS alpha, b AS beta FROM t1 JOIN t2 ON t1.k = t2.k WHERE a > 0');
  });
});

describe('the candidate set as the selector reads it', () => {
  const raw = [
    { sql: 'select  Count ( * )  from items ;', rows: [[3]], source: 'inline+evidence@second' },
    { sql: 'select count(*) from items', rows: [[3]], source: 'metadata+evidence' },
  ];

  it('rewrites the text and nothing else about a candidate', () => {
    const shown = readableCandidates(raw, true);
    expect(shown.map((candidate) => candidate.sql)).toEqual(['SELECT COUNT(*) FROM items', 'SELECT COUNT(*) FROM items']);
    // The row count, the preview and the source all reach the selector unchanged: this
    // lever changes the statement, not the facts beside it.
    expect(shown.map((candidate) => ({ rows: candidate.rows, source: candidate.source }))).toEqual(
      raw.map((candidate) => ({ rows: candidate.rows, source: candidate.source })),
    );
  });

  it('leaves the set it was given untouched', () => {
    // The winner is taken by index out of the original list, so a lever that reordered or
    // mutated it would make the selector's answer select a different statement.
    const before = raw.map((candidate) => candidate.sql);
    readableCandidates(raw, true);
    expect(raw.map((candidate) => candidate.sql)).toEqual(before);
  });

  it('hands back the same array when the lever is off', () => {
    expect(readableCandidates(raw, undefined)).toBe(raw);
    expect(readableCandidates(raw, false)).toBe(raw);
  });

  it('keeps the index-to-statement correspondence on a one-style set', () => {
    const set = readableCandidates(raw, true);
    // The selector answers with an index; the arm then takes the *raw* statement at that
    // index. Two statements that canonicalise to one string still occupy their own slots.
    expect(set[1]).not.toBe(raw[1]);
    expect(raw[1]?.sql).toBe('select count(*) from items');
  });
});

describe('the style channel, closed', () => {
  /** Deterministic pseudo-random numbers: a failure has to be reproducible. */
  function rng(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  }

  /** Gaps a human or a model might produce between two tokens. */
  const GAPS = [' ', '  ', '\n', '\t', ' \n  ', ' /* c */ ', ' -- c\n'];

  /**
   * Re-style a statement without changing what it says: random gaps and random word case.
   *
   * Only words are re-cased, because only words are case-insensitive in SQLite — a literal
   * or a quoted identifier that changed case would be a different statement, and the test
   * would be checking the wrong thing.
   */
  function restyle(sql: string, random: () => number): string {
    const pieces = tokenizeSql(sql).map((token, index) => {
      const text =
        token.kind === 'word'
          ? [...token.text].map((char) => (random() < 0.5 ? char.toUpperCase() : char.toLowerCase())).join('')
          : token.text;
      return index === 0 ? text : (GAPS[Math.floor(random() * GAPS.length)] as string) + text;
    });
    return pieces.join('');
  }

  it('maps a hundred restylings of one statement to a single form', () => {
    const base = 'SELECT t.name, count(*) FROM items AS t WHERE price >= 3 GROUP BY t.name';
    const random = rng(20251112);
    const forms = new Set<string>();
    for (let index = 0; index < 100; index += 1) forms.add(canonicalSql(restyle(base, random)));
    expect([...forms]).toEqual([canonicalSql(base)]);
  });

  it('still returns the same rows after restyling', () => {
    const random = rng(7);
    const base = "select name from items where name = 'Pen' and price >= 2";
    const statements: string[] = [];
    for (let index = 0; index < 20; index += 1) statements.push(restyle(base, random));
    const executed = execute([...statements, base]);
    const expected = executed[executed.length - 1]?.rows;
    expect(expected).toEqual([['Pen']]);
    for (const result of executed.slice(0, 20)) expect(result.rows).toEqual(expected);
  });
});
