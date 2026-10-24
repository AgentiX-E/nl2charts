import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { Engine, EngineResult } from '@agentix-e/nl2charts-core';
import { describeConnector, requiresWrite } from './connectors.js';
import { readDriverError } from './engine-error.js';

/**
 * The first candidate name the server accepts. Version differences are a fact of
 * life; this keeps the fallback out of the engine body and testable in isolation.
 */
export async function firstSupported<T>(
  candidates: readonly string[],
  probe: (name: string) => Promise<T>,
): Promise<{ name: string; value: T } | undefined> {
  for (const name of candidates) {
    try {
      return { name, value: await probe(name) };
    } catch {
      // An unknown name is a version fact, not a failure.
    }
  }
  return undefined;
}

/** Message of anything thrown; drivers throw strings in a few edge cases. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One error shape for "the optional driver is not installed", testable directly. */
export function driverUnavailable(engine: string, cause: unknown): Error {
  return toNl2ChartsError('NL2C_E_ENGINE_UNAVAILABLE', `the ${engine} driver is not installed`, cause, { engine });
}

export interface MysqlOptions {
  /** Connection URI, e.g. `mysql://user:pass@host:3306/db`. Never logged. */
  readonly connectionString: string;
  /** Open a read-only session. Defaults to true: the product never writes. */
  readonly readOnly?: boolean;
  /** Server-side statement timeout in milliseconds (max_execution_time). */
  readonly statementTimeoutMs?: number;
  readonly poolSize?: number;
}

interface MysqlConnection {
  query(options: string | { sql: string; timeout?: number }): Promise<[Record<string, unknown>[], { name: string }[]]>;
  end(): Promise<void>;
}

/**
 * MySQL / MariaDB adapter.
 *
 * Same two layers as PostgreSQL, with the engine's own spelling:
 *
 * 1. lexical — writes are refused before the statement leaves the process,
 *    including `select ... for update`, which takes row locks;
 * 2. session — `SET SESSION TRANSACTION READ ONLY`, so a statement the lexical
 *    check cannot see is refused by the server.
 *
 * Values are normalised the way the other adapters normalise them: `DATE` and
 * `DATETIME` stay text (the driver is configured with `dateStrings`), `DECIMAL`
 * becomes a number only when no precision is lost, `TINYINT(1)` arrives as 1/0
 * already, and binary columns become `0x<hex>`.
 */
export interface MysqlEngine extends Engine {
  /**
   * Which server variable reports the session's read-only state, and what it
   * said after the engine set it. MySQL 8 renamed the variable that MariaDB still
   * uses, so the engine probes instead of assuming, and exposes the answer as
   * evidence rather than hiding it in a log line.
   */
  readonly readOnlySession?: { readonly variable: string; readonly active: boolean };
}

export async function createMysqlEngine(options: MysqlOptions): Promise<MysqlEngine> {
  let mysql: { createConnection: (config: Record<string, unknown>) => Promise<MysqlConnection> };
  try {
    mysql = (await import('mysql2/promise')) as unknown as typeof mysql;
  } catch (error) {
    throw driverUnavailable('mysql', error);
  }

  const readOnly = options.readOnly !== false;
  let connection: MysqlConnection | undefined;
  let setupError: Error | undefined;
  let closed = false;
  let readOnlySession: { variable: string; active: boolean } | undefined;

  /** MySQL 8 has `transaction_read_only`; MariaDB 10.x still has `tx_read_only`. */
  const probeReadOnly = async (client: MysqlConnection): Promise<void> => {
    const found = await firstSupported(['transaction_read_only', 'tx_read_only'], async (variable) => {
      const [rows] = await client.query(`select @@${variable} as ro`);
      return Number((rows[0] as { ro: unknown }).ro);
    });
    if (found !== undefined) readOnlySession = { variable: found.name, active: found.value === 1 };
  };

  /**
   * One connection, opened on first use. A pool would apply the read-only
   * setting to whichever physical connection happened to serve the call, so a
   * four-connection pool could hand out three writable sessions; one connection
   * makes the promise unconditional. mysql2 queues concurrent queries on it.
   */
  const ensure = async (): Promise<MysqlConnection> => {
    if (setupError !== undefined) throw setupError;
    if (connection !== undefined) return connection;
    try {
      const opened = await mysql.createConnection({
        uri: options.connectionString,
        dateStrings: true,
        decimalNumbers: false,
        supportBigNumbers: true,
        bigNumberStrings: true,
        multipleStatements: false,
      });
      if (readOnly) {
        await opened.query('SET SESSION TRANSACTION READ ONLY');
        await probeReadOnly(opened);
      }
      connection = opened;
      return opened;
    } catch (error) {
      const cause = messageOf(error);
      setupError = toNl2ChartsError(
        'NL2C_E_ENGINE_FAILED',
        `${describeConnector('mysql', options.connectionString)}: cannot open a read-only session (${cause})`,
        error,
        { engine: 'mysql' },
      );
      throw setupError;
    }
  };

  return {
    id: 'mysql',
    dialect: 'mysql',
    streaming: false,
    get readOnlySession() {
      return readOnlySession;
    },
    async run(sql: string, runOptions?: { signal?: AbortSignal }): Promise<EngineResult> {
      if (closed) throw toNl2ChartsError('NL2C_E_ENGINE_UNAVAILABLE', 'engine is closed');
      if (runOptions?.signal?.aborted) throw toNl2ChartsError('NL2C_E_TIMEOUT', 'query aborted before execution');
      if (readOnly && requiresWrite(sql)) {
        throw toNl2ChartsError('NL2C_E_GUARD_REJECTED', 'read-only connection refused a write', undefined, {
          engine: 'mysql',
          statement: sql.slice(0, 120),
        });
      }
      const client = await ensure();
      try {
        const [rows, fields] = await client.query({
          sql,
          ...(options.statementTimeoutMs === undefined ? {} : { timeout: options.statementTimeoutMs }),
        });
        const columns = (fields ?? []).map((field) => field.name);
        // A write returns an OkPacket rather than an array. The engine contract
        // says "result set", so a statement that produces none answers with an
        // empty one instead of failing on a shape mismatch.
        if (!Array.isArray(rows)) return { columns: [], rows: [] };
        return {
          columns,
          rows: rows.map((row) => {
            const normalised: Record<string, unknown> = {};
            for (const column of columns) normalised[column] = fromMysqlValue(row[column]);
            return normalised;
          }),
        };
      } catch (error) {
        const message = messageOf(error);
        throw toNl2ChartsError('NL2C_E_ENGINE_FAILED', `${describeConnector('mysql', options.connectionString)}: ${message}`, error, {
          engine: 'mysql',
          engineError: readDriverError(error),
        });
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (connection !== undefined) await connection.end();
    },
  };
}

/** Normalise a mysql2 value to the vocabulary the other adapters use. */
export function fromMysqlValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (typeof value === 'string') {
    // DECIMAL and BIGINT arrive as strings when they do not fit a double.
    if (/^-?\d+$/.test(value) && value.length >= 16) return value;
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}
