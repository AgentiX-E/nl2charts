/**
 * The port of MAC-SQL's value-example rule, against a real SQLite file.
 *
 * The rule is being ported so a block of a competitor's prompt can be priced on our cases,
 * so the thing worth testing is not "does it produce some examples" but "does it produce
 * theirs". Each case below is a branch of their `_get_value_examples_str`, and each one
 * changes what a card says about a column: the numeric cut that keeps a column out of the
 * block, the URL and email tests that drop a column whole, the date collapse to one
 * example, the NULL that is emitted first, and the exact-case type tests that their code
 * has and a tidier port would not.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { createOracle } from '../eval/bird/oracle.js';
import type { Oracle, OracleResult } from '../eval/bird/oracle.js';
import {
  EXAMPLE_LIMITS,
  EXAMPLE_RULE,
  consideredColumns,
  exampleMapOf,
  exampleSetFor,
  examplesOf,
  isDateValue,
  isEmail,
  isKeyName,
  isNumericType,
  isTextType,
} from '../eval/bird/value-examples.js';

const root = mkdtempSync(join(tmpdir(), 'nl2charts-examples-'));
const cache = join(root, 'cache');
mkdirSync(join(root, 'shop'), { recursive: true });
const writer = new DatabaseSync(join(root, 'shop', 'shop.sqlite'));
writer.exec(`
  create table items (
    item_id integer primary key,
    name text,
    status text,
    price real,
    grade integer,
    added_on text,
    paid text,
    link text,
    mail text,
    essay text,
    loose varchar(50),
    many text
  );
  create table orders (
    code text,
    item_ref text references items(item_id),
    memo text
  );
`);
const insert = writer.prepare(
  'insert into items values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
);
// Three names, the commonest first: `group by ... order by count(*) desc` is what makes the
// examples frequent rather than arbitrary.
for (let index = 0; index < 12; index += 1) {
  const name = index < 6 ? 'pen' : index < 9 ? 'cup' : 'ink';
  // `status` holds a NULL, which their card emits first so the reader sees the column is
  // nullable; one of its spellings is also empty, which is dropped as a value but not as a
  // reason to drop the column.
  const status = index === 0 ? null : index === 1 ? '' : index < 7 ? 'Open' : 'Closed';
  // Twelve distinct prices: above their numeric cut-off of ten, so the column gets nothing.
  const price = index + 0.5;
  // Three grades: a small numeric dictionary, which their rule does show.
  const grade = index % 3;
  const addedOn = index % 2 === 0 ? '2012-08-25' : '2011-02-31';
  const paid = index % 2 === 0 ? 'yes' : 'no';
  // One URL is enough for their code to drop the whole column.
  const link = index === 0 ? 'https://example.org/a' : 'plain';
  const mail = index === 0 ? 'someone@example.org' : 'nobody';
  // One value longer than fifty characters is enough for the same.
  const essay = index === 0 ? 'x'.repeat(60) : 'short';
  // `varchar(50)` is not exactly `TEXT`, so their text filters never run on it and the long
  // value stays. A tidy port would filter it and measure a different prompt.
  const loose = index === 0 ? 'y'.repeat(60) : 'brief';
  const many = `tag${String(index)}`;
  insert.run(index, name, status, price, grade, addedOn, paid, link, mail, essay, loose, many);
}
const insertOrder = writer.prepare('insert into orders values (?, ?, ?)');
for (let index = 0; index < 5; index += 1) insertOrder.run(`o${String(index)}`, String(index), 'memo');
writer.close();

const oracle = createOracle(resolve('eval/bird/oracle.py'), root);
afterAll(async () => {
  await oracle.close();
});

describe('the value example rule', () => {
  it('keeps a numeric column only while it is a small dictionary', () => {
    // Their cut-off counts distinct values including the null, and it runs before the
    // empties are removed: a numeric column with eleven distinct values gets nothing even
    // when two of them would not have become examples.
    const eleven = Array.from({ length: EXAMPLE_LIMITS.numericDistinct + 1 }, (_, index) => String(index));
    expect(examplesOf(eleven, 'INTEGER')).toEqual([]);
    // Below the cut a numeric column is a dictionary, and the six-example cap still applies.
    expect(examplesOf(eleven.slice(0, EXAMPLE_LIMITS.numericDistinct), 'INTEGER')).toHaveLength(
      EXAMPLE_LIMITS.values,
    );
    // ...but the same eleven values in a `TEXT` column are a dictionary, not a measure.
    expect(examplesOf(eleven, 'TEXT')).toHaveLength(EXAMPLE_LIMITS.values);
  });

  it('drops a whole text column for one URL, one email or one long value', () => {
    const base = ['alpha', 'beta'];
    expect(examplesOf([...base, 'see https://example.org'], 'TEXT')).toEqual([]);
    // The test is a substring, not a prefix: their code asks whether `https://` is in the
    // value, so a link behind a sentence still disqualifies the column.
    expect(examplesOf([...base, 'mirror at http://example.org/x'], 'TEXT')).toEqual([]);
    expect(examplesOf([...base, 'someone@example.org'], 'TEXT')).toEqual([]);
    expect(examplesOf([...base, 'z'.repeat(EXAMPLE_LIMITS.maxTextLength + 1)], 'TEXT')).toEqual([]);
    // A value of exactly the limit survives, which is the boundary their comparison has.
    expect(examplesOf([...base, 'z'.repeat(EXAMPLE_LIMITS.maxTextLength)], 'TEXT')).toHaveLength(3);
  });

  it('collapses a date column to one example and puts a NULL first', () => {
    expect(examplesOf(['2012-08-25', '2011-02-31'], 'TEXT')).toEqual(['2012-08-25']);
    expect(examplesOf([null, 'Open', 'Closed'], 'TEXT')).toEqual(['NULL', 'Open', 'Closed']);
    // A column of dates with a null keeps the null and the single date, in that order.
    expect(examplesOf([null, '2012-08-25', '2013-01-01'], 'TEXT')).toEqual(['NULL', '2012-08-25']);
  });

  it('keeps six examples at most, after the empties are removed', () => {
    const values = ['', 'a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(examplesOf(values, 'TEXT')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    // A column that holds only nulls and empties has nothing to show: their code gives up
    // when the kept list is empty, before the null is prepended, so the nullability hint
    // does not reach the card for a column with no value at all.
    expect(examplesOf(['', '   ', null], 'TEXT')).toEqual([]);
    expect(examplesOf([], 'TEXT')).toEqual([]);
  });

  it('reads the declared type exactly as their code reads it', () => {
    expect(isTextType('TEXT')).toBe(true);
    expect(isTextType('VARCHAR')).toBe(true);
    // `varchar(50)` and `Text` are text to a reader and not text to their code, which is why
    // the long value in the fixture's `loose` column survives onto their card.
    expect(isTextType('varchar(50)')).toBe(false);
    expect(isTextType('Text')).toBe(false);
    expect(isNumericType('INTEGER')).toBe(true);
    expect(isNumericType('INT')).toBe(true);
    expect(isNumericType('BIGINT')).toBe(false);
    expect(examplesOf(['z'.repeat(80), 'brief'], 'varchar(50)')).toEqual(['z'.repeat(80), 'brief']);
  });

  it('reads a timestamp as a date and a longer token as not one', () => {
    // Their code keeps the first whitespace-delimited token and demands exactly ten characters,
    // so a timestamp is a date and a value with a digit appended is not.
    expect(isDateValue('2012-08-25 00:00:00')).toBe(true);
    expect(isDateValue(' 2012-08-25')).toBe(true);
    expect(isDateValue('2012-08-250')).toBe(false);
    expect(isDateValue('')).toBe(false);
  });

  it('holds their date test, including its laxness about the calendar', () => {
    expect(isDateValue('2012-08-25')).toBe(true);
    expect(isDateValue('2012-08-25 00:00:00')).toBe(true);
    // February 31 is not a date; their test only checks the ranges, so it is one here too.
    expect(isDateValue('2011-02-31')).toBe(true);
    expect(isDateValue('2011-13-01')).toBe(false);
    expect(isDateValue('12-08-25')).toBe(false);
  });

  it('names the columns their selector never looks at', () => {
    for (const name of ['id', 'item_id', 'user_id', 'email', 'contact_email', 'url', 'home_url', 'URL']) {
      expect(isKeyName(name)).toBe(true);
    }
    // `paid` ends in `id`, so their rule skips it. That is a real cost of testing names
    // rather than types, and the port keeps it rather than quietly improving the rule.
    expect(isKeyName('paid')).toBe(true);
    expect(isKeyName('status')).toBe(false);
    expect(isEmail('a.b-c@example.org')).toBe(true);
    expect(isEmail('not an email')).toBe(false);
  });

  it('skips primary keys, foreign keys and key-shaped names before reading any data', () => {
    const columns = [
      { name: 'item_id', type: 'INTEGER', pk: 1 },
      { name: 'code', type: 'TEXT', pk: 0 },
      { name: 'item_ref', type: 'TEXT', pk: 0 },
      { name: 'status', type: 'TEXT', pk: 0 },
    ];
    const kept = consideredColumns(columns, new Set(['item_ref']));
    expect(kept.map((column) => column.name)).toEqual(['code', 'status']);
  });
});

/**
 * An oracle that refuses one query, for the paths a healthy database never takes.
 *
 * Not a mock of the code under test: it is the database client seen through a locked file, which
 * is a scenario rather than a stub of the thing being measured.
 */
function oracleFailing(predicate: (sql: string) => boolean, inner: Oracle, withMessage = true): Oracle {
  return {
    run: async (db: string, sql: string): Promise<OracleResult> =>
      predicate(sql)
        ? { ok: false, columns: [], rows: [], ms: 0, ...(withMessage ? { error: 'database is locked' } : {}) }
        : inner.run(db, sql),
    close: () => inner.close(),
  };
}

describe('one database, read through the oracle', () => {
  it('builds the block their card would carry, column by column', async () => {
    const set = await exampleSetFor(oracle, 'shop', { cacheDir: cache });
    const byColumn = exampleMapOf(set);
    // Frequent first, three names only. `cup` and `ink` tie on three rows, and the order
    // between them is whatever their `order by count(*) desc` yields — reproduced rather than
    // tidied, because the six values a tie decides are exactly what the port is for. So the
    // count is pinned and the tie is asserted as a set.
    const names = byColumn.get('items.name') as string[];
    expect(names).toHaveLength(3);
    expect(names[0]).toBe('pen');
    expect(new Set(names.slice(1))).toEqual(new Set(['cup', 'ink']));
    // The null leads, the empty string is gone.
    // `Open` and `Closed` tie on five rows; the order is the query's, and the null still
    // leads because their code inserts it after the six are chosen.
    const status = byColumn.get('items.status') as string[];
    expect(status[0]).toBe('NULL');
    expect(new Set(status.slice(1))).toEqual(new Set(['Open', 'Closed']));
    // The numeric cut and the three text drops.
    expect(byColumn.has('items.price')).toBe(false);
    expect(byColumn.has('items.link')).toBe(false);
    expect(byColumn.has('items.mail')).toBe(false);
    expect(byColumn.has('items.essay')).toBe(false);
    // A small numeric dictionary is shown; a date collapses to one example.
    // Three grades, four rows each: a three-way tie, ordered by the query rather than by value.
    expect(new Set(byColumn.get('items.grade'))).toEqual(new Set(['0', '1', '2']));
    // Two dates, one example: which of the two survives is decided by the tie order, and
    // either way the card says "a date column".
    const dates = byColumn.get('items.added_on') as string[];
    expect(dates).toHaveLength(1);
    expect(dates[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Key by identity, key by name, and the declared-type quirk.
    expect(byColumn.has('items.item_id')).toBe(false);
    expect(byColumn.has('items.paid')).toBe(false);
    // The long value survives on a `varchar(50)` column — not first, because frequency
    // order puts the common value first — where a `TEXT` column would have been dropped.
    expect(byColumn.get('items.loose')).toContain('y'.repeat(60));
    // Six is the cap, and the fixture has twelve distinct tags.
    expect(byColumn.get('items.many')).toHaveLength(EXAMPLE_LIMITS.values);
    expect(byColumn.get('orders.item_ref')).toBeUndefined();
    expect(byColumn.get('orders.memo')).toEqual(['memo']);
    // The quirk count is the number of columns a tidy port would treat differently, so the
    // report can say whether exact-case matching matters instead of assuming it does not.
    expect(set.typeQuirks).toBe(1);
    expect(set.capped).toEqual([]);
    expect(set.rule).toBe(EXAMPLE_RULE);
  });

  it('fails loudly when a column cannot be read, instead of shipping a smaller block', async () => {
    // Their code swallows the failure into an empty string, and an empty string is a column
    // without examples: the block comes out smaller than theirs and the ceiling comes out
    // lower, with nothing in the artifact saying so.
    const broken = oracleFailing((sql) => sql.includes('count(distinct "price")'), oracle);
    await expect(exampleSetFor(broken, 'shop', { cacheDir: join(cache, 'broken'), force: true })).rejects.toThrow(
      'items.price could not be counted',
    );
    // `price` never reaches the read: it has twelve distinct values, so their numeric cut-off
    // skips it before any list is fetched. The read failure needs a column that gets that far.
    // ...and the message carries the engine's own text when it has one, `undefined` when it
    // does not: a failure without a reason is still a failure, and the message has to say so
    // rather than invent one.
    const unreadable = oracleFailing((sql) => sql.includes('group by "name"'), oracle, false);
    await expect(exampleSetFor(unreadable, 'shop', { cacheDir: join(cache, 'unreadable'), force: true })).rejects.toThrow(
      'items.name could not be read (undefined)',
    );
    const noKeys = oracleFailing((sql) => sql.includes('pragma_foreign_key_list'), oracle);
    await expect(exampleSetFor(noKeys, 'shop', { cacheDir: join(cache, 'nokeys'), force: true })).rejects.toThrow(
      'could not be asked for its foreign keys',
    );
  });

  it('names a column above the fetch ceiling instead of fetching it', async () => {
    // The ceiling is a guard, not a rule, and the corpus never reaches it — so the branch that
    // skips a column is proved with a ceiling low enough to reach: three distinct tags against
    // a ceiling of two.
    const set = await exampleSetFor(oracle, 'shop', { cacheDir: join(cache, 'low'), force: true, distinctCap: 2 });
    expect(set.capped).toContain('items.many');
    expect(exampleMapOf(set).has('items.many')).toBe(false);
    // The columns under the ceiling are unaffected — and `name`, with three spellings, is
    // above a ceiling of two as well, which is the guard applying to every column alike.
    expect([...(exampleMapOf(set).get('orders.memo') ?? [])]).toEqual(['memo']);
    expect(exampleMapOf(set).has('items.name')).toBe(false);
  });

  it('serves the cache while the rule it was built with is the rule', async () => {
    const first = await exampleSetFor(oracle, 'shop', { cacheDir: cache });
    const file = join(cache, 'shop.json');
    // A cache hit is proved by writing a marker into the file: a rebuild would overwrite it.
    const marked = { ...first, marker: 'kept' } as unknown as typeof first;
    writeFileSync(file, JSON.stringify(marked));
    const second = await exampleSetFor(oracle, 'shop', { cacheDir: cache });
    expect((second as unknown as { marker?: string }).marker).toBe('kept');
  });

  it('rebuilds when the cached rule is not this rule', async () => {
    // A name-only cache would serve yesterday's rule and report the result as stable.
    const file = join(cache, 'shop.json');
    const stale = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...stale, rule: 'mac-sql@older', columns: [] }));
    const rebuilt = await exampleSetFor(oracle, 'shop', { cacheDir: cache });
    expect(rebuilt.rule).toBe(EXAMPLE_RULE);
    expect(rebuilt.columns.length).toBeGreaterThan(0);
  });
});
