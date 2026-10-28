/**
 * The data profile is the input to three arms (`evidence=synthetic`, `samples`, `values`),
 * and it decides what a prompt can say about a column without a single dataset annotation.
 *
 * These tests run it against a real SQLite file through the real oracle, because every
 * branch in it is a claim about data: an `_id` column is dropped by name, free text is not
 * a dictionary, an opaque key is not a business value, and a date is a range rather than a
 * category. A profile that got any of those wrong would still produce a prompt, and the
 * prompt would be wrong in a way that reads like a model failure.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { createOracle } from '../eval/bird/oracle.js';
import { profileDatabase } from '../eval/bird/profile.js';

const root = mkdtempSync(join(tmpdir(), 'nl2charts-profile-'));
const cache = join(root, 'cache');
mkdirSync(join(root, 'shop'), { recursive: true });
const writer = new DatabaseSync(join(root, 'shop', 'shop.sqlite'));
writer.exec(`
  create table items (
    item_id integer,
    name text,
    price real,
    added_on text,
    notes text
  );
  create table customers (
    customer_id integer,
    segment text,
    region text
  );
  create table keys (token text);
  create table tags (tag text);
`);
const insertItem = writer.prepare('insert into items values (?, ?, ?, ?, ?)');
for (let index = 1; index <= 60; index += 1) {
    // Five distinct prices on sixty rows: a numeric column with repeats, which is what a
  // measure looks like. A distinct value on every row is free text by the profile's rule.
  insertItem.run(index, index % 2 === 0 ? 'pen' : 'cup', ((index % 5) + 1) * 1.5, `2024-03-${String((index % 28) + 1).padStart(2, '0')}`, `note ${String(index)}`);
}
const insertCustomer = writer.prepare('insert into customers values (?, ?, ?)');
const segments = ['smb', 'enterprise', 'consumer'];
const regions = ['north', 'south', 'east', 'west'];
for (let index = 1; index <= 30; index += 1) {
  insertCustomer.run(index, segments[index % 3] ?? 'smb', regions[index % 4] ?? 'north');
}
// Opaque join keys: few distinct values, no meaning.
const insertKey = writer.prepare('insert into keys values (?)');
for (const token of ['recLKj8BbTNqxFbTb', 'recLKj8BbTNqxFbTb', 'xY9mNpQrStUvWxYz']) insertKey.run(token);
// A dictionary with more distinct values than the cap.
const insertTag = writer.prepare('insert into tags values (?)');
for (let index = 0; index < 40; index += 1) insertTag.run(`tag${String(index)}`);
writer.close();

const oracle = createOracle(resolve('eval/bird/oracle.py'), root);
afterAll(async () => {
  await oracle.close();
  rmSync(root, { recursive: true, force: true });
});

describe('database profile', () => {
  it('drops identifier columns by name instead of profiling a number range', async () => {
    const profile = await profileDatabase(oracle, 'shop', { cacheDir: cache });
    const ids = profile.columns.filter((column) => column.column.endsWith('_id'));
    expect(ids.length).toBeGreaterThan(0);
    for (const column of ids) expect(column.kind).toBe('other');
  });

  it('profiles a small text column as a dictionary with its values', async () => {
    const profile = await profileDatabase(oracle, 'shop', { cacheDir: cache });
    const segment = profile.columns.find((column) => column.column === 'segment');
    expect(segment?.kind).toBe('categorical');
    expect(segment?.values).toEqual(expect.arrayContaining(['smb', 'consumer']));
    expect(segment?.distinct).toBe(3);
  });

  it('treats free text as other rather than as forty categories', async () => {
    const profile = await profileDatabase(oracle, 'shop', { cacheDir: cache });
    // Every notes value is distinct on 60 rows, which is above the free-text threshold.
    expect(profile.columns.find((column) => column.column === 'notes')?.kind).toBe('other');
  });

  it('refuses to call an opaque join key a business value', async () => {
    const profile = await profileDatabase(oracle, 'shop', { cacheDir: cache });
    expect(profile.columns.find((column) => column.column === 'token')?.kind).toBe('other');
  });

  it('drops a dictionary that exceeds the category cap', async () => {
    const profile = await profileDatabase(oracle, 'shop', { cacheDir: cache });
    // 40 distinct values on 40 rows is a dictionary by cardinality, but past the cap.
    const tag = profile.columns.find((column) => column.column === 'tag');
    expect(tag?.kind).toBe('other');
  });

  it('gives a numeric column a range and a date column a kind of its own', async () => {
    const profile = await profileDatabase(oracle, 'shop', { cacheDir: cache });
    const price = profile.columns.find((column) => column.column === 'price');
    expect(price?.kind).toBe('numeric');
    expect(price?.min).toBe('1.5');
    expect(price?.max).toBe('7.5');
    const added = profile.columns.find((column) => column.column === 'added_on');
    expect(added?.kind).toBe('date');
    expect(added?.min).toContain('2024-03');
  });

  it('reads its own cache instead of querying again, and force bypasses it', async () => {
    const first = await profileDatabase(oracle, 'shop', { cacheDir: cache });
    const file = join(cache, 'shop.json');
    // The cache is the file itself: corrupt it and a cache hit would return the corruption.
    writeFileSync(file, JSON.stringify({ db: 'shop', columns: [{ table: 'items', column: 'cached', kind: 'other' }] }));
    const cached = await profileDatabase(oracle, 'shop', { cacheDir: cache });
    expect(cached.columns).toHaveLength(1);
    const forced = await profileDatabase(oracle, 'shop', { cacheDir: cache, force: true });
    expect(forced.columns.length).toBe(first.columns.length);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(first);
  });

  it('skips a column whose statistics cannot be read rather than dropping the table', async () => {
    // A view or a blob column can fail its aggregate; the profile has to survive it, because
    // one unreadable column is not a reason to lose every other column in the database.
    const profile = await profileDatabase(oracle, 'shop', { cacheDir: cache, force: true });
    expect(profile.columns.length).toBeGreaterThan(5);
    expect(profile.db).toBe('shop');
  });
});
