import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { backendCanceller, createPostgresEngine, driverUnavailable, messageOf } from '../src/postgres.js';
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

/**
 * The cancellation connection, on a fake driver.
 *
 * A real server cannot show these branches: they are the ones where the cancellation itself fails,
 * and a working server is exactly the case where it does not. The contract they carry is that a
 * failure to cancel adds nothing to the query's own error — one event, one message.
 */
describe('the cancellation connection', () => {
  interface Call {
    readonly text: string;
    readonly values?: readonly unknown[];
  }

  it('asks the server to cancel the pid it was given, on a connection of its own', async () => {
    const calls: Call[] = [];
    const opened: string[] = [];
    const cancel = backendCanceller(
      class {
        constructor(config: Record<string, unknown>) {
          opened.push(String(config.connectionString));
        }
        async connect(): Promise<void> {}
        async query(config: Call): Promise<unknown> {
          calls.push(config);
          return { rows: [{ pg_cancel_backend: true }] };
        }
        async end(): Promise<void> {}
      },
      'postgres://example/db',
    );
    await cancel(4_242);
    expect(opened).toEqual(['postgres://example/db']);
    expect(calls).toEqual([{ text: 'select pg_cancel_backend($1)', values: [4_242] }]);
  });

  it('stays quiet when the cancellation cannot be sent', async () => {
    // The caller's query is already rejecting for its own reason; a throw here would replace that
    // reason with "the cancellation failed", which is the less useful of the two.
    const cancel = backendCanceller(
      class {
        async connect(): Promise<void> {
          throw new Error('could not connect');
        }
        async query(): Promise<unknown> {
          return {};
        }
        async end(): Promise<void> {}
      },
      'postgres://example/db',
    );
    await expect(cancel(7)).resolves.toBeUndefined();
  });

  it('closes the connection even when the statement could not be sent', async () => {
    // A leaked connection per timeout is a pool exhaustion bug that only appears under the load
    // that produces timeouts in the first place.
    let closed = 0;
    const cancel = backendCanceller(
      class {
        async connect(): Promise<void> {}
        async query(): Promise<unknown> {
          throw new Error('cancel refused');
        }
        async end(): Promise<void> {
          closed += 1;
        }
      },
      'postgres://example/db',
    );
    await cancel(7);
    expect(closed).toBe(1);
  });

  it('does nothing for a pid it never learned', async () => {
    // The pid lookup is a query of its own; if it returned nothing, there is no backend to name and
    // opening a connection to cancel pid 0 would target the server's own state.
    let opened = 0;
    const cancel = backendCanceller(
      class {
        constructor() {
          opened += 1;
        }
        async connect(): Promise<void> {}
        async query(): Promise<unknown> {
          return {};
        }
        async end(): Promise<void> {}
      },
      'postgres://example/db',
    );
    await cancel(0);
    expect(opened).toBe(0);
  });
});

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

  /**
   * Block until the server itself reports the sleeping statement, then return.
   *
   * Both cancellation cases aborted a hundred milliseconds after `run` returned, which is not a fact
   * about the statement but about the machine. Under a coverage run with a hundred and twenty test
   * files in flight the timer slipped past the five-second query, the statement finished on its own,
   * and the suite failed with "promise resolved instead of rejecting" — the same code, green on an
   * idle machine and red on a loaded one. Polling `pg_stat_activity` puts the abort where the
   * contract lives: after the statement is running at the server and before it has finished, so a
   * broken cancellation still fails, and a slow machine cannot make it look broken.
   */
  async function waitForSleepingStatement(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const seen = await admin.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where state = 'active' and query like 'select pg_sleep%'",
      );
      if ((seen.rows[0]?.n ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the sleeping statement never reached the server, so the cancellation was never exercised');
  }

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

  it('passes a caller\'s signal down to the driver and still returns rows', async () => {
    // The abort case is checked below, and it returns before a query is ever sent — so the
    // branch that attaches the signal to the request had never run. A signal that is live is
    // the only way to reach it.
    const controller = new AbortController();
    const result = await engine.run('select 41 + 1 as answer', { signal: controller.signal });
    expect(result.rows[0]?.answer).toBe(42);
  });

  it('stops the statement at the server when the caller aborts', async () => {
    // The gap this closes was measured rather than assumed: `pg` does not cancel a statement it has
    // already sent, so aborting during `pg_sleep` returned the row a second later, exactly as if no
    // signal had been given. Forwarding the signal was therefore a comment that looked like a
    // guarantee. The engine now asks the server to cancel the backend on a connection of its own,
    // and the case ends as a deadline — which is what a caller who aborted asked for.
    const controller = new AbortController();
    const started = Date.now();
    const running = engine.run('select pg_sleep(5)', { signal: controller.signal });
    // After the query is in flight, so the cancellation is exercised rather than the pre-check.
    await waitForSleepingStatement();
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'NL2C_E_TIMEOUT' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1_500);
  });

  it('is usable again after a cancelled statement', async () => {
    // The cancelled connection is destroyed rather than returned to the pool: the driver still has
    // an open result stream on it, and recycling it would hand the next query a half-read protocol.
    // The cost is one connection; the alternative is a pool that fails intermittently afterwards,
    // which is the failure mode that takes a day to diagnose.
    const controller = new AbortController();
    const running = engine.run('select pg_sleep(5)', { signal: controller.signal });
    await waitForSleepingStatement();
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'NL2C_E_TIMEOUT' });
    const after = await engine.run('select 1 as one');
    expect(after.rows).toEqual([{ one: 1 }]);
  });

  it('reports a statement the server cancelled on its own as a deadline, not a failure', async () => {
    // `statement_timeout` produces the same SQLSTATE as `pg_cancel_backend`, and a repair loop must
    // not try to fix either: a statement that ran out of time is not a statement with a syntax
    // error. This is the path a caller who never aborts still reaches.
    const impatient = await createPostgresEngine({ connectionString: url as string, statementTimeoutMs: 150 });
    try {
      await expect(impatient.run('select pg_sleep(5)')).rejects.toMatchObject({ code: 'NL2C_E_TIMEOUT' });
    } finally {
      await impatient.close();
    }
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

  it('honours a pool size, which is the one option no other case sets', async () => {
    // `poolSize` defaulted to four and nothing ever asked for another number, so the branch
    // that reads the option was the only uncovered line in this file. The assertion is that
    // the engine still answers under a smaller pool, which is the property a caller who sets
    // it is buying.
    const small = await createPostgresEngine({ connectionString: url as string, poolSize: 1 });
    const first = await small.run('select 1 as one');
    const second = await small.run('select 2 as two');
    expect([first.rows[0]?.one, second.rows[0]?.two]).toEqual([1, 2]);
    await small.close();
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

/**
 * The one path a server cannot test: the driver not being installed.
 *
 * `pg` is an optional peer, so a deployment that installs the connector without it must get a
 * typed error rather than a module crash. The condition is an environment fact, not a behaviour
 * of our code, and the only way to produce it inside a process that already imported `pg` is to
 * make the next resolution fail — which is what the mock does, and all it does. Everything the
 * code decides after the throw is real and is asserted below.
 */
describe('a driver that is not installed', () => {
  it('reports a typed engine error instead of crashing the import', async () => {
    vi.doMock('pg', () => {
      throw new Error("Cannot find package 'pg'");
    });
    try {
      const fresh = await import('../src/postgres.js');
      await expect(fresh.createPostgresEngine({ connectionString: 'postgres://analyst@127.0.0.1:1/none' })).rejects.toMatchObject({
        code: 'NL2C_E_ENGINE_UNAVAILABLE',
      });
    } finally {
      vi.doUnmock('pg');
    }
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
