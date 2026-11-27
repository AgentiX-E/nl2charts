import { describe, expect, it } from 'vitest';
import { createDomainReader, createGroundingReader } from '../src/domain.js';
import type { DomainRunner } from '../src/domain.js';

/**
 * A runner over a table of answers rather than a database.
 *
 * The read this module issues is one statement — `select distinct "column" from "table"` — so the
 * answer it needs is a column's values, and a fixture that maps exactly that is the whole interface.
 * It records what it was asked, because half of these tests are about statements that must *not* be
 * issued: a reader that refuses a qualifier it could not resolve and then queries the table anyway
 * would pass every assertion about values and fail the one thing the refusal exists for.
 */
function runnerOf(
  domains: Readonly<Record<string, readonly unknown[]>>,
  options: { readonly failing?: readonly string[]; readonly truncated?: readonly string[]; readonly outcome?: 'ok' | 'throw' } = {},
): { readonly run: DomainRunner; readonly asked: string[] } {
  const asked: string[] = [];
  const run: DomainRunner = async (sql) => {
    asked.push(sql);
    if (options.outcome === 'throw') throw new Error('the connection is gone');
    const match = /^select distinct "(.*)" from "(.*)"$/u.exec(sql);
    if (match === null) return { ok: false, rows: [] };
    const key = `${(match[2] as string).replace(/""/gu, '"')}.${(match[1] as string).replace(/""/gu, '"')}`;
    if (options.failing?.includes(key) === true) return { ok: false, rows: [] };
    const values = domains[key] ?? [];
    return {
      ok: true,
      rows: values.map((value) => [value]),
      ...(options.truncated?.includes(key) === true ? { truncated: true } : {}),
    };
  };
  return { run, asked };
}

describe('createDomainReader', () => {
  it('asks for the distinct values of one column and returns them', async () => {
    const { run, asked } = runnerOf({ 'orders.status': ['Active', 'Banned'] });
    const read = createDomainReader(run);
    expect(await read('orders', 'status')).toEqual(['Active', 'Banned']);
    expect(asked).toEqual(['select distinct "status" from "orders"']);
  });

  it('collapses a value the engine repeated and drops the empty string', async () => {
    const { run } = runnerOf({ 'orders.status': ['Active', 'Active', '', 'Banned'] });
    expect(await createDomainReader(run)('orders', 'status')).toEqual(['Active', 'Banned']);
  });

  it('does not turn the null group into the word null', async () => {
    // `select distinct` returns NULL as a row. `String(null)` is `'null'`, which is a spelling the
    // column does not contain — the defect this reader was moved out of the harness to fix.
    const { run } = runnerOf({ 'orders.status': [null, 'Active'] });
    expect(await createDomainReader(run)('orders', 'status')).toEqual(['Active']);
  });

  it('quotes an identifier that contains a quote', async () => {
    const { run, asked } = runnerOf({ 'orders.we"ird': ['x'] });
    expect(await createDomainReader(run)('orders', 'we"ird')).toEqual(['x']);
    expect(asked).toEqual(['select distinct "we""ird" from "orders"']);
  });

  it('reports a read the engine refused as unknown, not as empty', async () => {
    const { run } = runnerOf({}, { failing: ['orders.status'] });
    expect(await createDomainReader(run)('orders', 'status')).toBeUndefined();
  });

  it('treats a truncated read as unknown, because a partial domain cannot settle a literal', async () => {
    const { run } = runnerOf({ 'orders.status': ['Active'] }, { truncated: ['orders.status'] });
    expect(await createDomainReader(run)('orders', 'status')).toBeUndefined();
  });

  it('reads a column once, even when the answer was unknown', async () => {
    const { run, asked } = runnerOf({}, { failing: ['orders.status'] });
    const read = createDomainReader(run);
    await read('orders', 'status');
    await read('orders', 'status');
    expect(asked).toHaveLength(1);
  });

  it('shares one cache across two readers, which is why the cache is an option', async () => {
    const { run, asked } = runnerOf({ 'orders.status': ['Active'] });
    const cache = new Map<string, readonly string[] | undefined>();
    await createDomainReader(run, { cache })('orders', 'status');
    await createDomainReader(run, { cache })('orders', 'status');
    expect(asked).toHaveLength(1);
  });

  it('keeps two databases apart when they share a table name', async () => {
    const { run, asked } = runnerOf({ 'orders.status': ['Active'] });
    const cache = new Map<string, readonly string[] | undefined>();
    const first = createDomainReader(run, { cache, namespace: 'one' });
    const second = createDomainReader(run, { cache, namespace: 'two' });
    await first('orders', 'status');
    await second('orders', 'status');
    expect(asked).toHaveLength(2);
  });
});

describe('createGroundingReader', () => {
  it('resolves an alias to the table it names', async () => {
    const { run, asked } = runnerOf({ 'orders.status': ['Banned'] });
    const read = createGroundingReader(run);
    const values = await read({ column: 'status', qualifier: 'o', sql: 'select * from orders as o where o.status = "x"' });
    expect(values).toEqual(['Banned']);
    expect(asked).toEqual(['select distinct "status" from "orders"']);
  });

  it('resolves a qualifier written as the table name itself', async () => {
    const { run, asked } = runnerOf({ 'orders.status': ['Banned'] });
    const read = createGroundingReader(run);
    await read({ column: 'status', qualifier: 'ORDERS', sql: 'select * from orders as o where orders.status = "x"' });
    expect(asked).toEqual(['select distinct "status" from "orders"']);
  });

  it('refuses a qualifier that names nothing in the statement, without reading anything', async () => {
    const { run, asked } = runnerOf({ 'orders.status': ['Banned'] });
    const read = createGroundingReader(run);
    const values = await read({ column: 'status', qualifier: 'x', sql: 'select * from orders as o where x.status = "y"' });
    expect(values).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('reads an unqualified column from every table the statement reads', async () => {
    const { run, asked } = runnerOf({ 'orders.status': ['Active'], 'customers.status': ['Banned'] });
    const read = createGroundingReader(run);
    const values = await read({ column: 'status', sql: 'select * from orders join customers on orders.id = customers.id' });
    expect(values).toEqual(['Active', 'Banned']);
    expect(asked).toEqual(['select distinct "status" from "orders"', 'select distinct "status" from "customers"']);
  });

  it('reads a table named twice only once', async () => {
    const { run, asked } = runnerOf({ 'orders.status': ['Active'] });
    const read = createGroundingReader(run);
    await read({ column: 'status', sql: 'select * from orders o join orders p on o.id = p.parent' });
    expect(asked).toEqual(['select distinct "status" from "orders"']);
  });

  it('has nothing to read when the statement names no table', async () => {
    const { run, asked } = runnerOf({});
    const read = createGroundingReader(run);
    expect(await read({ column: 'status', sql: "select 'x' as status" })).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('answers with the tables that could be read when another failed', async () => {
    const { run } = runnerOf({ 'customers.status': ['Banned'] }, { failing: ['orders.status'] });
    const read = createGroundingReader(run);
    const values = await read({ column: 'status', sql: 'select * from orders join customers on orders.id = customers.id' });
    expect(values).toEqual(['Banned']);
  });

  it('reports unknown when every table failed to answer', async () => {
    const { run } = runnerOf({}, { failing: ['orders.status'] });
    const read = createGroundingReader(run);
    expect(await read({ column: 'status', sql: 'select * from orders' })).toBeUndefined();
  });

  it('reports an empty list when every table answered that the column stores nothing', async () => {
    const { run } = runnerOf({ 'orders.status': [] });
    const read = createGroundingReader(run);
    expect(await read({ column: 'status', sql: 'select * from orders' })).toEqual([]);
  });

  it('propagates a thrown read instead of swallowing it', async () => {
    // The pipeline's own guard turns a thrown read into a refusal; a reader that caught it here
    // would report "the column stores nothing" about a database it never reached.
    const { run } = runnerOf({}, { outcome: 'throw' });
    const read = createGroundingReader(run);
    await expect(read({ column: 'status', sql: 'select * from orders' })).rejects.toThrow('the connection is gone');
  });
});
