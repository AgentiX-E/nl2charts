export interface EngineResult {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}

export interface RunOptions {
  readonly signal?: AbortSignal;
}

/**
 * The only way core reaches a database. Implementations live in `-node`
 * (native DuckDB, PostgreSQL, MySQL) or in the browser build (WASM). Core must
 * never import them (PLT2/PLT4).
 */
export interface Engine {
  readonly id: string;
  readonly dialect: string;
  readonly streaming: boolean;
  run(sql: string, options?: RunOptions): Promise<EngineResult>;
  stream?(sql: string, options?: RunOptions): AsyncIterable<EngineResult>;
  close(): Promise<void>;
}
