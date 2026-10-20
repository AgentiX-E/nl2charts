import { DuckDBInstance } from '@duckdb/node-api';
import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { Engine, EngineResult } from '@agentix-e/nl2charts-core';
import { fromDuckDbRow } from './values.js';

export interface DuckDbOptions {
  /** File path or ':memory:'. */
  readonly path?: string;
  readonly readOnly?: boolean;
}

/**
 * Native DuckDB adapter. This module is the reason the `-node` package exists:
 * it imports a native binding, so it must never be reachable from the browser
 * entry point (PLT1/PLT2).
 */
export async function createDuckDbEngine(options: DuckDbOptions = {}): Promise<Engine> {
  const instance = await DuckDBInstance.create(options.path ?? ':memory:', options.readOnly ? { access_mode: 'READ_ONLY' } : undefined);
  const connection = await instance.connect();
  let closed = false;

  return {
    id: 'duckdb-native',
    dialect: 'duckdb',
    streaming: false,
    async run(sql: string, runOptions?: { signal?: AbortSignal }): Promise<EngineResult> {
      if (closed) throw toNl2ChartsError('NL2C_E_ENGINE_UNAVAILABLE', 'engine is closed');
      if (runOptions?.signal?.aborted) {
        throw toNl2ChartsError('NL2C_E_TIMEOUT', 'query aborted before execution');
      }
      try {
        const reader = await connection.runAndReadAll(sql);
        return {
          columns: reader.columnNames(),
          rows: (reader.getRowObjects() as Readonly<Record<string, unknown>>[]).map(fromDuckDbRow),
        };
      } catch (error) {
        throw toNl2ChartsError('NL2C_E_ENGINE_FAILED', 'duckdb query failed', error, { engine: 'duckdb-native' });
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      connection.closeSync();
      instance.closeSync();
    },
  };
}
