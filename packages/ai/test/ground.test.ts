import { describe, expect, it } from 'vitest';
import { applyGrounding, groundLiterals } from '../src/ground.js';
import type { ColumnValues } from '../src/ground.js';

/** A domain that answers from a table, and counts what it was asked. */
function domainOf(values: Readonly<Record<string, readonly string[]>>): { readonly read: ColumnValues; readonly asked: string[] } {
  const asked: string[] = [];
  const read: ColumnValues = (query) => {
    asked.push(query.qualifier === undefined ? query.column : `${query.qualifier}.${query.column}`);
    return Promise.resolve(values[query.column.toLowerCase()]);
  };
  return { read, asked };
}

const never = (): Promise<readonly string[] | undefined> => Promise.resolve(undefined);

describe('the one edit the data can prove', () => {
  it('replaces a value written in another case with the spelling the column stores', async () => {
    const { read } = domainOf({ status: ['Active', 'Banned', 'Pending'] });
    const outcome = await groundLiterals("select id from users where status = 'banned'", read);
    expect(outcome.sql).toBe("select id from users where status = 'Banned'");
    expect(outcome.substitutions).toEqual([{ literal: 'banned', column: 'status', value: 'Banned' }]);
  });

  it('asks the database once per site, and not at all when the statement names no literal', async () => {
    const { read, asked } = domainOf({ status: ['Active'] });
    await groundLiterals('select id from users where id > 5', read);
    expect(asked).toEqual([]);
    await groundLiterals("select id from users where status = 'active' and id = 1", read);
    expect(asked).toEqual(['status']);
  });

  it('grounds every member of an `in` list independently', async () => {
    const { read } = domainOf({ status: ['Active', 'Banned', 'Pending'] });
    const outcome = await groundLiterals("select id from users where status in ('active', 'BANNED', 'gone')", read);
    expect(outcome.sql).toBe("select id from users where status in ('Active', 'Banned', 'gone')");
    expect(outcome.substitutions.map((entry) => entry.value)).toEqual(['Active', 'Banned']);
  });

  it('refuses a column that stores two spellings of the same word', async () => {
    // The one case where the data does not decide: `Banned` and `BANNED` both equal the literal
    // ignoring case, and picking the first would be guessing which row the question meant.
    const { read } = domainOf({ status: ['Banned', 'BANNED'] });
    const outcome = await groundLiterals("select id from users where status = 'banned'", read);
    expect(outcome.sql).toBe("select id from users where status = 'banned'");
    expect(outcome.substitutions).toEqual([]);
    expect(outcome.refused).toEqual([{ literal: 'banned', column: 'status', reason: 'ambiguous' }]);
  });

  it('refuses a value the column does not contain, and says so', async () => {
    const { read } = domainOf({ status: ['Active'] });
    const outcome = await groundLiterals("select id from users where status = 'atlantis'", read);
    expect(outcome.sql).toBe("select id from users where status = 'atlantis'");
    expect(outcome.refused).toEqual([{ literal: 'atlantis', column: 'status', reason: 'absent' }]);
  });

  it('refuses when the column could not be read, rather than guessing', async () => {
    const outcome = await groundLiterals("select id from users where status = 'banned'", never);
    expect(outcome.sql).toBe("select id from users where status = 'banned'");
    expect(outcome.refused).toEqual([{ literal: 'banned', column: 'status', reason: 'unknown' }]);
  });

  it('matches whole values, not prefixes or substrings', async () => {
    // `Benalish Knight (Fellwar Stone)` contains `Benalish Knight`, and a rule that matched on
    // containment would answer a different question with a plausible-looking statement.
    const { read } = domainOf({ name: ['Benalish Knight (Fellwar Stone)'] });
    const outcome = await groundLiterals("select id from cards where name = 'benalish knight'", read);
    expect(outcome.sql).toBe("select id from cards where name = 'benalish knight'");
    expect(outcome.refused).toEqual([{ literal: 'benalish knight', column: 'name', reason: 'absent' }]);
  });

  it('leaves a `like` pattern alone, because a pattern is not a value', async () => {
    const { read, asked } = domainOf({ name: ['Card'] });
    const outcome = await groundLiterals("select id from cards where name like 'card%'", read);
    expect(outcome.sql).toBe("select id from cards where name like 'card%'");
    expect(asked).toEqual([]);
  });

  it('leaves a literal the statement does not compare against a column alone', async () => {
    // `select 'x'` and a `case` branch produce output rather than a lookup key; editing one
    // would change what the user is shown.
    const { read, asked } = domainOf({ x: ['X'] });
    const outcome = await groundLiterals("select 'x' as label, count(*) from t where y = 1", read);
    expect(outcome.sql).toBe("select 'x' as label, count(*) from t where y = 1");
    expect(asked).toEqual([]);
  });

  it('reads a quoted identifier and an escaped quote as what they are', async () => {
    const { read } = domainOf({ 'county name': ['Alameda'], name: ["O'Brien"] });
    const outcome = await groundLiterals(
      `select * from frpm where "County Name" = 'alameda' and name = 'o''brien'`,
      read,
    );
    expect(outcome.sql).toBe(`select * from frpm where "County Name" = 'Alameda' and name = 'O''Brien'`);
    expect(outcome.substitutions).toHaveLength(2);
  });

  it('does not read a literal that sits inside a comment or a quoted identifier', async () => {
    const { read } = domainOf({ status: ['Active'] });
    const outcome = await groundLiterals(
      "-- status = 'active'\nselect \"status\" from users where status = 'active'",
      read,
    );
    expect(outcome.sql).toBe("-- status = 'active'\nselect \"status\" from users where status = 'Active'");
    expect(outcome.substitutions).toHaveLength(1);
  });

  it('passes the qualifier along, so a caller can tell two tables apart', async () => {
    const { read, asked } = domainOf({ name: ['Cards'] });
    await groundLiterals("select c.id from cards c where c.name = 'cards'", read);
    expect(asked).toEqual(['c.name']);
  });

  it('is idempotent: grounding what is already grounded changes nothing', async () => {
    const { read } = domainOf({ status: ['Active'] });
    const once = await groundLiterals("select id from users where status = 'active'", read);
    const twice = await groundLiterals(once.sql, read);
    expect(twice.sql).toBe(once.sql);
    expect(twice.substitutions).toEqual([]);
  });

  it('reports the statement unchanged when it holds no comparison at all', async () => {
    const { read } = domainOf({});
    const outcome = await groundLiterals('select 1', read);
    expect(outcome).toEqual({ sql: 'select 1', substitutions: [], refused: [] });
  });
});

describe('the same rule over a lookup that already holds the values', () => {
  it('answers without a reader, so a caller with a cached profile does not have to fake one', () => {
    const stored = new Map([['status', ['Active', 'Banned']]]);
    const outcome = applyGrounding("select id from users where status = 'banned'", (query) => stored.get(query.column.toLowerCase()));
    expect(outcome.sql).toBe("select id from users where status = 'Banned'");
    expect(outcome.substitutions).toHaveLength(1);
  });

  it('reports the same shape as the async driver, because both finish through one function', async () => {
    const { read } = domainOf({ status: ['Active', 'Banned'] });
    const sql = "select id from users where status in ('active', 'gone')";
    const asyncOutcome = await groundLiterals(sql, read);
    const syncOutcome = applyGrounding(sql, (query) => (query.column === 'status' ? ['Active', 'Banned'] : undefined));
    expect(syncOutcome).toEqual(asyncOutcome);
  });

  it('asks nothing of a statement with no comparison site', () => {
    const asked: string[] = [];
    const outcome = applyGrounding('select count(*) from users', (query) => {
      asked.push(query.column);
      return undefined;
    });
    expect(outcome).toEqual({ sql: 'select count(*) from users', substitutions: [], refused: [] });
    expect(asked).toEqual([]);
  });
});
