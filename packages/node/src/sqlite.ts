import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { Engine, EngineResult } from '@agentix-e/nl2charts-core';
import { readDriverError } from './engine-error.js';

export interface SqliteOptions {
  /** Path to a SQLite database file, or ':memory:'. */
  readonly path: string;
  /** Open the file read-only. Defaults to true: the product never writes. */
  readonly readOnly?: boolean;
}

interface SqliteStatement {
  readonly all: () => readonly Readonly<Record<string, unknown>>[];
  readonly setReadBigInts: (enabled: boolean) => void;
}

interface SqliteDatabase {
  readonly prepare: (sql: string) => SqliteStatement;
  readonly close: () => void;
}

/**
 * SQLite adapter over the built-in `node:sqlite` module.
 *
 * Two runtime facts shape this file:
 *
 * 1. The import is lazy. `node:sqlite` is experimental in Node 22 and absent
 *    before it, so a caller on an older runtime gets a typed error instead of a
 *    module-load crash that would take down every other engine in the package.
 * 2. Rows come back as objects until `setReturnArrays()` exists (Node 23+).
 *    Three consequences, asserted in the tests rather than assumed: two output
 *    columns with the same name collapse into one, column order comes from the
 *    first row, and an empty result reports no columns. External benchmarks
 *    therefore execute through the reference driver in `eval/bird/oracle.py`,
 *    which returns tuples.
 */
export async function createSqliteEngine(options: SqliteOptions): Promise<Engine> {
  let database: SqliteDatabase;
  try {
    const sqlite = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
    };
    database = new sqlite.DatabaseSync(options.path, { readOnly: options.readOnly !== false });
  } catch (error) {
    throw toNl2ChartsError('NL2C_E_ENGINE_UNAVAILABLE', 'node:sqlite is not available on this runtime', error, {
      engine: 'sqlite',
    });
  }

  let closed = false;
  return {
    id: 'sqlite',
    dialect: 'sqlite',
    streaming: false,
    async run(sql: string, runOptions?: { signal?: AbortSignal }): Promise<EngineResult> {
      if (closed) throw toNl2ChartsError('NL2C_E_ENGINE_UNAVAILABLE', 'engine is closed');
      if (runOptions?.signal?.aborted) {
        throw toNl2ChartsError('NL2C_E_TIMEOUT', 'query aborted before execution');
      }
      try {
        const statement = database.prepare(sql);
        statement.setReadBigInts(false);
        const raw = statement.all();
        const columns = raw.length === 0 ? [] : Object.keys(raw[0] as Record<string, unknown>);
        const rows = raw.map((row) => {
          const record: Record<string, unknown> = {};
          for (const [column, value] of Object.entries(row)) record[column] = normalise(value);
          return record;
        });
        return { columns, rows };
      } catch (error) {
        // The message used to be the constant string "sqlite query failed", which made
        // every SQLite failure indistinguishable from every other one.
        throw toNl2ChartsError('NL2C_E_ENGINE_FAILED', `sqlite query failed: ${readDriverError(error).message}`, error, {
          engine: 'sqlite',
          engineError: readDriverError(error),
        });
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}

/**
 * `node:sqlite` returns BLOBs as `Uint8Array`. They become `0x<hex>`, the same
 * encoding the DuckDB adapter uses, so a row means the same thing whichever
 * engine produced it (see the value model in docs/architecture.md).
 */
function normalise(value: unknown): unknown {
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  return value ?? null;
}
