import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnection } from 'mysql2/promise';
import { createMysqlEngine, driverUnavailable, fromMysqlValue, messageOf } from '../src/mysql.js';

/**
 * Integration tests against a real MySQL-compatible server (MariaDB 10.11 in the
 * sandbox and in CI). `MYSQL_TEST_URL` decides whether they run; without it the
 * suite skips, so the contract tests still cover the pure parts on a laptop.
 */
const url = process.env.MYSQL_TEST_URL;

describe.skipIf(url === undefined)('mysql engine (real server)', () => {
  let admin: Awaited<ReturnType<typeof createConnection>>;
  let engine: Awaited<ReturnType<typeof createMysqlEngine>>;

  beforeAll(async () => {
    admin = await createConnection({ uri: url as string, multipleStatements: true });
    await admin.query('drop table if exists orders');
    await admin.query(
      'create table orders (id int primary key, region varchar(20), total decimal(10,2), placed_on date, paid tinyint(1), note varchar(40) null)',
    );
    await admin.query(
      "insert into orders values (1, 'north', 10.50, '2024-01-02', 1, null), (2, 'south', 99.99, '2024-02-03', 0, 'gift'), (3, 'north', 5.00, '2024-02-04', 1, null)",
    );
    engine = await createMysqlEngine({ connectionString: url as string, readOnly: true });
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

  it('opens the session read-only, which the server reports itself', async () => {
    const result = await engine.run('select @@tx_read_only as ro');
    expect(Number(result.rows[0]?.ro)).toBe(1);
  });

  it('refuses a write before it reaches the server', async () => {
    await expect(engine.run("insert into orders values (9, 'x', 1, '2024-03-01', 1, null)")).rejects.toMatchObject({
      code: 'NL2C_E_GUARD_REJECTED',
    });
    const [rows] = await admin.query('select count(*) as n from orders');
    expect(Number((rows as { n: number }[])[0]?.n)).toBe(3);
  });

  it('treats FOR UPDATE as a write, because it takes row locks', async () => {
    await expect(engine.run('select * from orders for update')).rejects.toMatchObject({ code: 'NL2C_E_GUARD_REJECTED' });
  });

  it('reports a connection failure without the password', async () => {
    const broken = await createMysqlEngine({ connectionString: 'mysql://analyst:s3cret@127.0.0.1:1/none' });
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

  it('surfaces a SQL error as an engine failure', async () => {
    await expect(engine.run('select * from missing_table')).rejects.toMatchObject({ code: 'NL2C_E_ENGINE_FAILED' });
  });

  it('can be opened read-write when a caller explicitly asks', async () => {
    const writer = await createMysqlEngine({ connectionString: url as string, readOnly: false });
    await writer.run("insert into orders values (10, 'west', 1.00, '2024-04-01', 1, null)");
    const [rows] = await admin.query('select count(*) as n from orders');
    expect(Number((rows as { n: number }[])[0]?.n)).toBe(4);
    await admin.query('delete from orders where id = 10');
    await writer.close();
  });

  it('honours a statement timeout', async () => {
    const impatient = await createMysqlEngine({ connectionString: url as string, statementTimeoutMs: 5_000 });
    const result = await impatient.run('select 1 as one');
    expect(result.rows[0]?.one).toBe(1);
    await impatient.close();
  });

  it('refuses to start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(engine.run('select 1', { signal: controller.signal })).rejects.toMatchObject({ code: 'NL2C_E_TIMEOUT' });
  });

  it('closes cleanly even when no query ever ran', async () => {
    const idle = await createMysqlEngine({ connectionString: url as string });
    await idle.close();
    await idle.close();
  });

  it('rejects after close instead of hanging', async () => {
    const temporary = await createMysqlEngine({ connectionString: url as string });
    await temporary.close();
    await expect(temporary.run('select 1')).rejects.toMatchObject({ code: 'NL2C_E_ENGINE_UNAVAILABLE' });
  });
});

describe('driver availability', () => {
  it('reads a message from a thrown string as well as from an Error', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
    expect(messageOf('plain string')).toBe('plain string');
  });

  it('turns a missing driver into a typed error instead of a module crash', () => {
    const error = driverUnavailable('mysql', new Error('Cannot find module'));
    expect(error).toMatchObject({ code: 'NL2C_E_ENGINE_UNAVAILABLE' });
  });
});

describe('mysql value normalisation', () => {
  it('maps the primitives the engine contract expects', () => {
    expect(fromMysqlValue(null)).toBeNull();
    expect(fromMysqlValue(undefined)).toBeNull();
    expect(fromMysqlValue('42')).toBe(42);
    expect(fromMysqlValue('10.50')).toBe(10.5);
    expect(fromMysqlValue('north')).toBe('north');
    expect(fromMysqlValue(Buffer.from([0xbe, 0xef]))).toBe('0xbeef');
  });

  it('keeps a big integer as text', () => {
    expect(fromMysqlValue('9007199254740993')).toBe('9007199254740993');
  });

  it('converts a Date that the driver hands back anyway', () => {
    expect(fromMysqlValue(new Date('2024-01-02T03:04:05.000Z'))).toBe('2024-01-02T03:04:05.000Z');
  });

  it('serialises a structured value deterministically', () => {
    expect(fromMysqlValue({ a: 1 })).toBe('{"a":1}');
  });
});
