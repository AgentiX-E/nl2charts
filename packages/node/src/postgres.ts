import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { Engine, EngineResult } from '@agentix-e/nl2charts-core';
import { describeConnector, requiresWrite } from './connectors.js';

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
export async function createPostgresEngine(options: PostgresOptions): Promise<Engine> {
  let pool: {
    query: (config: { text: string; signal?: AbortSignal }) => Promise<{ fields: { name: string }[]; rows: Record<string, unknown>[] }>;
    connect: () => Promise<{ query: (config: { text: string; signal?: AbortSignal }) => Promise<{ fields: { name: string }[]; rows: Record<string, unknown>[] }>; release: () => void }>;
    end: () => Promise<void>;
  };
  let types: { setTypeParser: (oid: number, parser: (value: string) => unknown) => void };

  try {
    const pg = (await import('pg')) as unknown as {
      Pool: new (config: Record<string, unknown>) => typeof pool;
      types: typeof types;
    };
    types = pg.types;
    pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.poolSize ?? 4,
      statement_timeout: options.statementTimeoutMs ?? 30_000,
      ...(options.readOnly === false ? {} : { options: '-c default_transaction_read_only=on' }),
    });
  } catch (error) {
    throw driverUnavailable('postgres', error);
  }

  // Keep dates as text: the driver's Date objects are local-time and would make
  // the same value hash differently on two machines.
  types.setTypeParser(1082, (value) => value);
  types.setTypeParser(1114, (value) => value);
  types.setTypeParser(1184, (value) => value);

  const readOnly = options.readOnly !== false;
  let closed = false;

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
        });
      }
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
        // The connection string never appears in a pg error, but a caller-supplied
        // one might; describeConnector is the only string this library emits.
        throw toNl2ChartsError('NL2C_E_ENGINE_FAILED', `${describeConnector('postgres', options.connectionString)}: ${message}`, error, {
          engine: 'postgres',
        });
      } finally {
        client.release();
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
