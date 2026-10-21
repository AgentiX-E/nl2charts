/**
 * Six connectors, one contract.
 *
 * A connector is not a driver: it is the set of promises the pipeline makes about
 * an engine before a query reaches it — how an identifier is quoted, how rows are
 * capped, whether another database can be attached, and that the connection is
 * read-only. Drivers live in this package too, but they need a server; this
 * module is pure, so every promise is testable in CI without one.
 *
 * The dialect list is deliberately short and honest: the engines this product
 * ships a contract for. An engine that is not here is not silently treated as
 * "probably standard SQL" — that is how `"` becomes `\`` at runtime.
 */

export type ConnectorKind = 'duckdb' | 'sqlite' | 'postgres' | 'mysql' | 'snowflake' | 'bigquery';

export interface Connector {
  readonly kind: ConnectorKind;
  /** Quote an identifier for this engine, doubling the quote character inside. */
  quote(name: string): string;
  /** Cap the rows a statement can return. */
  limit(sql: string, rows: number): string;
  /** Whether the engine can attach another database file to the same connection. */
  readonly attach: boolean;
}

function quoted(open: string, close: string): (name: string) => string {
  return (name: string) => `${open}${name.split(close).join(close + close)}${close}`;
}

export const CONNECTORS: Readonly<Record<ConnectorKind, Connector>> = {
  duckdb: { kind: 'duckdb', quote: quoted('"', '"'), limit: (sql, rows) => `${sql} limit ${rows}`, attach: true },
  sqlite: { kind: 'sqlite', quote: quoted('"', '"'), limit: (sql, rows) => `${sql} limit ${rows}`, attach: true },
  postgres: { kind: 'postgres', quote: quoted('"', '"'), limit: (sql, rows) => `${sql} limit ${rows}`, attach: false },
  mysql: { kind: 'mysql', quote: quoted('`', '`'), limit: (sql, rows) => `${sql} limit ${rows}`, attach: false },
  snowflake: { kind: 'snowflake', quote: quoted('"', '"'), limit: (sql, rows) => `${sql} limit ${rows}`, attach: false },
  bigquery: { kind: 'bigquery', quote: quoted('`', '`'), limit: (sql, rows) => `${sql} limit ${rows}`, attach: false },
};

export function connectorFor(kind: ConnectorKind): Connector {
  const connector = CONNECTORS[kind];
  if (connector === undefined) throw new Error(`unknown connector: ${String(kind)}`);
  return connector;
}

/**
 * Does this statement write? Comments are stripped first, because a leading
 * `-- note` must not hide an `insert`, and a string literal is not a keyword.
 */
export function requiresWrite(sql: string): boolean {
  const withoutComments = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  return /(^|[\s;(])(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|copy|call|vacuum)\b/i.test(
    withoutComments,
  );
}

/**
 * Remove a credential from a connection string. A password that reaches a log is
 * a password that has leaked, and error messages are the usual path.
 */
export function redactConnection(connection: string): string {
  return connection
    .replace(/(\/\/[^/:@\s]+):([^@\s/]+)@/g, '$1:***@')
    .replace(/([?&](?:password|passwd|pwd|token|key|secret)=)[^&\s]+/gi, '$1***');
}

/** One line for a log or a trace panel, without the credential. */
export function describeConnector(kind: ConnectorKind, connection: string): string {
  return `${kind} (${redactConnection(connection)}), read-only`;
}
