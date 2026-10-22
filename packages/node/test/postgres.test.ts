import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createPostgresEngine, driverUnavailable, messageOf } from '../src/postgres.js';
import { fromPostgresValue } from '../src/postgres.js';

/**
 * Integration tests against a real PostgreSQL server.
 *
 * `PG_TEST_URL` decides whether they run: the local sandbox and the CI service
 * container set it, a laptop without a database does not, and the suite skips
 * instead of pretending. Nothing here is mocked — the read-only behaviour under
 * test is the server's, not ours.
 */
const url = process.env.PG_TEST_URL;

describe.skipIf(url === undefined)('postgres engine (real server)', () => {
  let admin: Client;
  let engine: Awaited<ReturnType<typeof createPostgresEngine>>;

  beforeAll(async () => {
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query('drop table if exists orders');
    await admin.query('drop sequence if exists probe_seq');
    await admin.query('create sequence probe_seq');
    await admin.query('create table orders (id int primary key, region text, total numeric(10,2), placed_on date, paid boolean, note text)');
    await admin.query(
      "insert into orders values (1, 'north', 10.50, '2024-01-02', true, null), (2, 'south', 99.99, '2024-02-03', false, 'gift'), (3, 'north', 5.00, '2024-02-04', true, null)",
    );
    engine = await createPostgresEngine({ connectionString: url as string, readOnly: true });
  });

  afterAll(async () => {
    await engine?.close();
    await admin?.end();
  });

  it('returns columns in select order and normalised values', async () => {
    const result = await engine.run('select id, region, total, placed_on, paid, note from orders order by id');
    expect(result.columns).toEqual(['id', 'region', 'total', 'placed_on', 'paid', 'note']);
    expect(result.rows[0]).toEqual({ id: 1, region: 'north', total: 10.5, placed_on: '2024-01-02', paid: 1, note: null });
    expect(result.rows[1]?.paid).toBe(0);
  });

  it('keeps a value that a float would round', async () => {
    const result = await engine.run("select 9007199254740993::bigint as big, 12345678901234567890::numeric as huge");
    expect(result.rows[0]?.big).toBe('9007199254740993');
    expect(result.rows[0]?.huge).toBe('12345678901234567890');
  });

  it('refuses a write before it reaches the server', async () => {
    await expect(engine.run("insert into orders values (9, 'x', 1, '2024-03-01', true, null)")).rejects.toMatchObject({
      code: 'NL2C_E_GUARD_REJECTED',
    });
    const count = await admin.query('select count(*)::int as n from orders');
    expect(count.rows[0].n).toBe(3);
  });

  it('refuses a write hidden inside a CTE', async () => {
    await expect(
      engine.run("with moved as (update orders set region = 'x' returning id) select * from moved"),
    ).rejects.toMatchObject({ code: 'NL2C_E_GUARD_REJECTED' });
  });

  it('treats FOR UPDATE as a write, because it takes row locks', async () => {
    await expect(engine.run('select * from orders for update')).rejects.toMatchObject({ code: 'NL2C_E_GUARD_REJECTED' });
  });

  it('refuses a statement the lexical check cannot see', async () => {
    // `nextval` writes to a sequence and contains none of the write keywords, so
    // only the session-level read-only setting can stop it. This is the assertion
    // that both layers exist rather than one being decoration.
    await expect(engine.run("select nextval('probe_seq')")).rejects.toMatchObject({
      code: 'NL2C_E_ENGINE_FAILED',
      message: expect.stringContaining('read-only transaction'),
    });
  });

  it('reports a connection failure without the password', async () => {
    const broken = await createPostgresEngine({ connectionString: 'postgres://analyst:s3cret@127.0.0.1:1/none' });
    let message = '';
    try {
      await broken.run('select 1');
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toContain('analyst:***@');
    expect(message).not.toContain('s3cret');
    await broken.close();
  });

  it('surfaces a SQL error as an engine failure with the statement context', async () => {
    await expect(engine.run('select * from missing_table')).rejects.toMatchObject({ code: 'NL2C_E_ENGINE_FAILED' });
  });

  it('can be opened read-write when a caller explicitly asks', async () => {
    const writer = await createPostgresEngine({ connectionString: url as string, readOnly: false });
    await writer.run("insert into orders values (10, 'west', 1.00, '2024-04-01', true, null)");
    const count = await admin.query('select count(*)::int as n from orders');
    expect(count.rows[0].n).toBe(4);
    await admin.query('delete from orders where id = 10');
    await writer.close();
  });

  it('refuses to start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(engine.run('select 1', { signal: controller.signal })).rejects.toMatchObject({ code: 'NL2C_E_TIMEOUT' });
  });

  it('honours a statement timeout', async () => {
    const impatient = await createPostgresEngine({ connectionString: url as string, statementTimeoutMs: 5_000 });
    const result = await impatient.run('select 1 as one');
    expect(result.rows[0]?.one).toBe(1);
    await impatient.close();
  });

  it('closes cleanly even when no query ever ran', async () => {
    const idle = await createPostgresEngine({ connectionString: url as string });
    await idle.close();
    await idle.close();
  });

  it('rejects after close instead of hanging', async () => {
    const temporary = await createPostgresEngine({ connectionString: url as string });
    await temporary.close();
    await expect(temporary.run('select 1')).rejects.toMatchObject({ code: 'NL2C_E_ENGINE_UNAVAILABLE' });
  });
});

describe('driver availability', () => {
  it('reads a message from a thrown string as well as from an Error', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
    expect(messageOf(7)).toBe('7');
  });

  it('turns a missing driver into a typed error instead of a module crash', () => {
    expect(driverUnavailable('postgres', new Error('Cannot find module'))).toMatchObject({ code: 'NL2C_E_ENGINE_UNAVAILABLE' });
  });
});

describe('postgres value normalisation', () => {
  it('maps the primitives the engine contract expects', () => {
    expect(fromPostgresValue(null)).toBeNull();
    expect(fromPostgresValue(undefined)).toBeNull();
    expect(fromPostgresValue(true)).toBe(1);
    expect(fromPostgresValue(false)).toBe(0);
    expect(fromPostgresValue('42')).toBe(42);
    expect(fromPostgresValue('10.50')).toBe(10.5);
    expect(fromPostgresValue('north')).toBe('north');
    expect(fromPostgresValue(Buffer.from([0xde, 0xad]))).toBe('0xdead');
  });

  it('keeps a big integer as text rather than rounding it', () => {
    expect(fromPostgresValue('9007199254740993')).toBe('9007199254740993');
  });

  it('serialises a structured value so two runs hash the same row', () => {
    expect(fromPostgresValue({ a: 1 })).toBe('{"a":1}');
  });
});
