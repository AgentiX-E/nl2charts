import { describe, expect, it } from 'vitest';
import { groundingReader } from '../eval/bird/run.js';
import type { OracleResult } from '../eval/bird/oracle.js';

/**
 * A database that answers `select distinct "column" from "table"` from a table of values, and keeps
 * every statement it was asked.
 *
 * The reader under test is the seam between the pipeline, which knows no schema, and the harness,
 * which has one. Its whole job is to resolve a reference the pipeline wrote down — an alias, a
 * table name, or nothing at all — into the table whose values should be read, and to answer
 * "I could not look" rather than "nothing is stored" when it cannot.
 */
function database(values: Readonly<Record<string, readonly string[]>>): {
  readonly run: (sql: string) => Promise<OracleResult>;
  readonly asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    run: (sql) => {
      asked.push(sql);
      const match = /select distinct "([^"]+)" from "([^"]+)"/i.exec(sql);
      const found = match === null ? undefined : values[`${match[2] as string}.${match[1] as string}`];
      if (found === undefined) return Promise.resolve({ ok: false, columns: [], rows: [], error: 'no such table', ms: 0 });
      return Promise.resolve({ ok: true, columns: ['value'], rows: found.map((value) => [value]), ms: 0 });
    },
  };
}

describe('the domain reader the grounding arm hands the pipeline', () => {
  it('resolves an alias to its table', async () => {
    const db = database({ 'items.name': ['Cup', 'Lid'] });
    const read = groundingReader(db.run, 'shop');
    const values = await read({ column: 'name', qualifier: 'i', sql: 'select i.id from items i where i.name = ' });
    expect(values).toEqual(['Cup', 'Lid']);
    expect(db.asked).toEqual(['select distinct "name" from "items"']);
  });

  it('resolves a table name written as its own qualifier', async () => {
    const db = database({ 'items.name': ['Cup'] });
    const read = groundingReader(db.run, 'shop');
    expect(await read({ column: 'name', qualifier: 'items', sql: 'select items.name from items where items.id = 1' })).toEqual(['Cup']);
  });

  it('unions every table the statement reads when the column is unqualified', async () => {
    // The pipeline cannot say which table an unqualified column belongs to, and the caller must not
    // pick: the two domains together are what the statement compares against, which is the rule
    // `domainsOf` applies on the other side of this seam.
    const db = database({ 'items.name': ['Cup'], 'lids.name': ['Lid'] });
    const read = groundingReader(db.run, 'shop');
    const values = await read({ column: 'name', sql: 'select * from items join lids on lids.id = items.id where name = ' });
    expect(values?.slice().sort()).toEqual(['Cup', 'Lid']);
    expect(db.asked).toHaveLength(2);
  });

  it('answers "could not look" for a qualifier the statement does not define', async () => {
    // A comma join or a subquery names a table this reader cannot see, and reading a guess would
    // ground the literal against a column the statement never compares.
    const db = database({ 'items.name': ['Cup'] });
    const read = groundingReader(db.run, 'shop');
    expect(await read({ column: 'name', qualifier: 'elsewhere', sql: 'select name from items where elsewhere.name = ' })).toBeUndefined();
    expect(db.asked).toEqual([]);
  });

  it('answers "could not look" when the statement reads no table at all', async () => {
    const db = database({});
    const read = groundingReader(db.run, 'shop');
    expect(await read({ column: 'name', sql: 'select 1' })).toBeUndefined();
    expect(db.asked).toEqual([]);
  });

  it('answers "could not look" when the column read returns no values', async () => {
    // The distinction the pipeline depends on: an empty list would be read as "this column holds
    // nothing", which is a fact, while a failed read is not.
    const db = database({ 'items.missing': [] });
    const read = groundingReader(db.run, 'shop');
    expect(await read({ column: 'missing', sql: 'select * from items where missing = ' })).toBeUndefined();
    expect(db.asked).toEqual(['select distinct "missing" from "items"']);
  });

  it('reads a column once, however many times the pipeline asks for it', async () => {
    const db = database({ 'items.name': ['Cup'] });
    const read = groundingReader(db.run, 'shop');
    await read({ column: 'name', sql: 'select * from items where name = ' });
    await read({ column: 'name', sql: 'select * from items where name = ' });
    expect(db.asked).toHaveLength(1);
  });
});
