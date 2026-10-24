/**
 * The engine's own words, kept.
 *
 * Each driver reports a different shape: PostgreSQL sends `code` (a SQLSTATE),
 * `position`, `hint` and `detail`; mysql2 sends `code` like `ER_BAD_FIELD_ERROR` plus
 * `sqlState`; SQLite and DuckDB only put everything in the message. The pipeline's
 * repair loop can act on all of that — a position lets it show a caret, a SQLSTATE
 * separates a missing column from a type error — but only if the adapters stop
 * throwing it away, which they did: the SQLite adapter's message was the constant
 * string "sqlite query failed".
 */
export interface EngineErrorFields {
  readonly message: string;
  readonly code?: string;
  readonly sqlState?: string;
  readonly position?: number;
  readonly hint?: string;
  readonly detail?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asPosition(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Read a driver error without assuming which driver it came from. */
export function readDriverError(error: unknown): EngineErrorFields {
  const source = record(error) ?? {};
  // mysql2 puts the code in `message` and the engine's sentence in `sqlMessage`;
  // the sentence is what a repair reads, and the code is captured separately.
  const message = asText(source.sqlMessage) ?? asText(source.message) ?? (error instanceof Error ? error.message : String(error));
  const code = asText(source.code) ?? asText(source.sqliteErrorname) ?? asText(source.errorType);
  const sqlState = asText(source.sqlState) ?? (code !== undefined && /^[0-9A-Z]{5}$/.test(code) ? code : undefined);
  const position = asPosition(source.position) ?? asPosition(source.offset);
  const hint = asText(source.hint);
  const detail = asText(source.detail);
  return {
    message,
    ...(code === undefined ? {} : { code }),
    ...(sqlState === undefined ? {} : { sqlState }),
    ...(position === undefined ? {} : { position }),
    ...(hint === undefined ? {} : { hint }),
    ...(detail === undefined ? {} : { detail }),
  };
}
