import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { Engine, EngineResult } from '@agentix-e/nl2charts-core';
import { describeConnector, requiresWrite } from './connectors.js';
import { readDriverError } from './engine-error.js';

/** Message of anything thrown; drivers throw strings in a few edge cases. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One error shape for "the optional driver is not installed", testable directly. */
export function driverUnavailable(engine: string, cause: unknown): Error {
  return toNl2ChartsError('NL2C_E_ENGINE_UNAVAILABLE', `the ${engine} driver is not installed`, cause, { engine });
}

export interface PostgresOptions {
  /** Connection string. Never logged; see `describeConnector`. */
  readonly connectionString: string;
  /** Open a read-only session. Defaults to true: the product never writes. */
  readonly readOnly?: boolean;
  /** Server-side statement timeout, in milliseconds. */
  readonly statementTimeoutMs?: number;
  /** Pool size. Four is enough for a pipeline that runs one query at a time. */
  readonly poolSize?: number;
}

/**
 * PostgreSQL adapter.
 *
 * Read-only is enforced twice, and both layers are asserted in the tests:
 *
 * 1. lexically, before the statement leaves the process (`requiresWrite`), so a
 *    write is never sent to a customer's primary;
 * 2. at the session level (`default_transaction_read_only=on`), so a statement
 *    the lexical check cannot see — a `SELECT ... FOR UPDATE`, a function with a
 *    side effect — is refused by the server.
 *
 * Values are normalised to the same primitive vocabulary the SQLite adapter uses:
 * dates as ISO strings, `boolean` as 1/0, `bytea` as `0x<hex>`, `int8` and
 * `numeric` as numbers when they survive the round trip and as strings when they
 * do not. Without that, the same logical row hashes differently per engine.
 */
/**
 * Ask the server to stop a statement, on a connection of its own.
 *
 * A separate connection rather than one from the pool, because the pool may have none free — the
 * statement being cancelled is holding one — and a cancellation that queues behind the thing it is
 * cancelling is not a cancellation.
 *
 * Nothing here throws. The caller's query is already rejecting for its own reason, and a second
 * error for one event only obscures the first; `pg_cancel_backend` returning false means the
 * statement had finished before the cancel arrived, which is a race, not a failure. Extracted from
 * the engine because every branch in it is then reachable from a fake driver — inside the closure
 * the "no driver" and "no pid" guards were two lines of coverage nobody could honestly earn.
 */
export function backendCanceller(
  Client: new (config: Record<string, unknown>) => {
    connect: () => Promise<void>;
    query: (config: { text: string; values?: readonly unknown[] }) => Promise<unknown>;
    end: () => Promise<void>;
  },
  connectionString: string,
): (pid: number) => Promise<void> {
  return async (pid: number): Promise<void> => {
    if (pid <= 0) return;
    // The same connection string, so the cancellation reaches the same server; read-write is
    // irrelevant here (`pg_cancel_backend` is a function call, not a write) and the read-only
    // session option would be one more thing to reason about.
    const client = new Client({ connectionString });
    try {
      await client.connect();
      await client.query({ text: 'select pg_cancel_backend($1)', values: [pid] });
    } catch {
      // Swallowed on purpose; see the comment above.
    } finally {
      await client.end().catch(() => undefined);
    }
  };
}

type Connection = {
  query: (config: { text: string; signal?: AbortSignal; values?: readonly unknown[] }) => Promise<{
    fields: { name: string }[];
    rows: Record<string, unknown>[];
  }>;
  /** `destroy` throws the connection away instead of returning it to the pool. */
  release: (destroy?: boolean) => void;
};

type Pool = {
  query: Connection['query'];
  connect: () => Promise<Connection>;
  end: () => Promise<void>;
};

type Types = { setTypeParser: (oid: number, parser: (value: string) => unknown) => void };

/**
 * The optional driver, loaded once and returned whole.
 *
 * A function rather than a `try` around the engine body, so that everything after it holds a pool
 * and a `Client` that are known to exist. The flatter version needed two `undefined` declarations and
 * a no-op default for the cancellation path — branches nothing can reach on a machine that has the
 * driver, which is every machine that gets this far.
 */
async function loadDriver(options: PostgresOptions): Promise<{ pool: Pool; types: Types; Client: Parameters<typeof backendCanceller>[0] }> {
  try {
    const pg = (await import('pg')) as unknown as {
      Pool: new (config: Record<string, unknown>) => Pool;
      Client: Parameters<typeof backendCanceller>[0];
      types: Types;
    };
    return {
      pool: new pg.Pool({
        connectionString: options.connectionString,
        max: options.poolSize ?? 4,
        statement_timeout: options.statementTimeoutMs ?? 30_000,
        ...(options.readOnly === false ? {} : { options: '-c default_transaction_read_only=on' }),
      }),
      types: pg.types,
      Client: pg.Client,
    };
  } catch (error) {
    throw driverUnavailable('postgres', error);
  }
}

export async function createPostgresEngine(options: PostgresOptions): Promise<Engine> {
  const { pool, types, Client } = await loadDriver(options);
  const cancelBackend = backendCanceller(Client, options.connectionString);

  // Keep dates as text: the driver's Date objects are local-time and would make
  // the same value hash differently on two machines.
  types.setTypeParser(1082, (value) => value);
  types.setTypeParser(1114, (value) => value);
  types.setTypeParser(1184, (value) => value);

  const readOnly = options.readOnly !== false;
  let closed = false;
  // Keyed by the connection object, not by its pid: the pid is what we look up, and a WeakMap keeps
  // the entry alive exactly as long as the connection the pool is holding.
  const backendPids = new WeakMap<object, number>();

  return {
    id: 'postgres',
    dialect: 'postgres',
    streaming: false,
    async run(sql: string, runOptions?: { signal?: AbortSignal }): Promise<EngineResult> {
      if (closed) throw toNl2ChartsError('NL2C_E_ENGINE_UNAVAILABLE', 'engine is closed');
      if (runOptions?.signal?.aborted) throw toNl2ChartsError('NL2C_E_TIMEOUT', 'query aborted before execution');
      if (readOnly && requiresWrite(sql)) {
        throw toNl2ChartsError('NL2C_E_GUARD_REJECTED', 'read-only connection refused a write', undefined, {
          engine: 'postgres',
          statement: sql.slice(0, 120),
        });
      }
      let client: Awaited<ReturnType<typeof pool.connect>>;
      try {
        client = await pool.connect();
      } catch (error) {
        const message = messageOf(error);
        throw toNl2ChartsError('NL2C_E_ENGINE_FAILED', `${describeConnector('postgres', options.connectionString)}: ${message}`, error, {
          engine: 'postgres',
          // SQLSTATE, position and hint are what a repair can act on.
          engineError: readDriverError(error),
        });
      }
      // One round trip per physical connection, not per query: the pid of a pooled connection does
      // not change, and asking for it every time would tax every statement in the product to make
      // one rare case cancellable.
      let pid = backendPids.get(client);
      if (pid === undefined) {
        const resolved = await client.query({ text: 'select pg_backend_pid() as pid' });
        pid = Number(resolved.rows[0]?.pid ?? 0);
        backendPids.set(client, pid);
      }
      // `pg` does not stop a statement it has already sent — aborting during `pg_sleep(1)` returns
      // the row a second later, exactly as if no signal had been given (measured on 2026-11-02 and
      // registered as I-79). So the signal is honoured where it can be: the server is asked to
      // cancel the backend, on a second connection, and the case ends as a timeout.
      let cancelled = false;
      const onAbort = (): void => {
        cancelled = true;
        void cancelBackend(pid);
      };
      if (runOptions?.signal !== undefined) runOptions.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await client.query({ text: sql, ...(runOptions?.signal === undefined ? {} : { signal: runOptions.signal }) });
        const columns = result.fields.map((field) => field.name);
        return {
          columns,
          rows: result.rows.map((row) => {
            const normalised: Record<string, unknown> = {};
            for (const column of columns) normalised[column] = fromPostgresValue(row[column]);
            return normalised;
          }),
        };
      } catch (error) {
        const message = messageOf(error);
        const engineError = readDriverError(error);
        // 57014 is `query_canceled`, which is what this engine asks the server to do when the
        // caller aborts and what the server-side `statement_timeout` produces on its own. Both are
        // deadlines rather than engine failures, and a repair loop must not try to fix them.
        // Unconditional on the caller: `statement_timeout` and `pg_cancel_backend` both produce
        // 57014, and both mean the same thing to everything above this line — the statement ran out
        // of time. `cancelled` is not consulted because a cancel asked for by this engine and one
        // the server applied on its own are the same event seen from here.
        if (engineError.sqlState === '57014') {
          throw toNl2ChartsError('NL2C_E_TIMEOUT', `${describeConnector('postgres', options.connectionString)}: statement cancelled after the caller aborted`, error, {
            engine: 'postgres',
            engineError,
          });
        }
        // The connection string never appears in a pg error, but a caller-supplied
        // one might; describeConnector is the only string this library emits.
        throw toNl2ChartsError('NL2C_E_ENGINE_FAILED', `${describeConnector('postgres', options.connectionString)}: ${message}`, error, {
          engine: 'postgres',
          // SQLSTATE, position and hint are what a repair can act on.
          engineError,
        });
      } finally {
        runOptions?.signal?.removeEventListener('abort', onAbort);
        // A connection whose statement was killed mid-flight is not returned to the pool: the
        // driver has an open result stream on it, and recycling it would hand the next query a
        // half-read protocol.
        client.release(cancelled);
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}

/** Normalise a pg value to the vocabulary the other adapters use. */
export function fromPostgresValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString('hex')}`;
  }
  if (typeof value === 'string') {
    // int8 and numeric arrive as strings. Keep them as strings when a number
    // would lose precision, so 9007199254740993 does not become ...992.
    if (/^-?\d+$/.test(value) && value.length >= 16) return value;
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
    return value;
  }
  if (typeof value === 'object') {
    // jsonb and arrays: stable text, so two runs hash the same row the same way.
    return JSON.stringify(value);
  }
  return value;
}
