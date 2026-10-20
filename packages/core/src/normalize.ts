/**
 * Cross-layer value normalization. DuckDB returns BIGINT as bigint and DECIMAL
 * as `{width, scale, value}`, while the browser build returns numbers and
 * strings for the same logical value. Row hashes must not depend on which
 * runtime produced them, so every value is canonicalized here first.
 */
export type CanonicalValue = string | number | boolean | null;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export interface DecimalLike {
  readonly width: number;
  readonly scale: number;
  readonly value: bigint;
}

export function isDecimalLike(value: unknown): value is DecimalLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.width === 'number' && typeof candidate.scale === 'number' && typeof candidate.value === 'bigint';
}

function formatDecimal(decimal: DecimalLike): string {
  const negative = decimal.value < 0n;
  const digits = (negative ? -decimal.value : decimal.value).toString().padStart(decimal.scale + 1, '0');
  if (decimal.scale === 0) return `${negative ? '-' : ''}${digits}`;
  const cut = digits.length - decimal.scale;
  return `${negative ? '-' : ''}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

function canonicalBigInt(value: bigint): number | string {
  return value <= MAX_SAFE && value >= -MAX_SAFE ? Number(value) : value.toString();
}

function canonicalDate(value: Date): string {
  return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
}

function canonicalBytes(value: Uint8Array): string {
  let hex = '';
  for (const byte of value) hex += byte.toString(16).padStart(2, '0');
  return `0x${hex}`;
}

function canonicalObject(value: object): string {
  if (value instanceof Date) return canonicalDate(value);
  if (value instanceof Uint8Array) return canonicalBytes(value);
  if (isDecimalLike(value)) return formatDecimal(value);
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(canonicalValue(item))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${JSON.stringify(canonicalValue(item))}`).join(',')}}`;
}

export function canonicalValue(value: unknown): CanonicalValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    if (Object.is(value, -0)) return 0;
    return value;
  }
  if (typeof value === 'bigint') return canonicalBigInt(value);
  if (typeof value === 'object') return canonicalObject(value);
  // symbol / function cannot come out of a result set; treat as absent.
  return null;
}

export function canonicalRow(row: Readonly<Record<string, unknown>>): Record<string, CanonicalValue> {
  const output: Record<string, CanonicalValue> = {};
  for (const key of Object.keys(row).sort()) output[key] = canonicalValue(row[key]);
  return output;
}

/**
 * FNV-1a over the canonical serialization. 64-bit is enough to detect row-set
 * drift; this is an identity check, not a security primitive.
 */
export function hashRows(rows: readonly Readonly<Record<string, unknown>>[]): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const row of rows) {
    const line = JSON.stringify(canonicalRow(row));
    for (let index = 0; index < line.length; index += 1) {
      hash ^= BigInt(line.charCodeAt(index));
      hash = (hash * prime) & mask;
    }
    hash ^= 0x0an;
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export function resultSetsEqual(
  left: readonly Readonly<Record<string, unknown>>[],
  right: readonly Readonly<Record<string, unknown>>[],
): boolean {
  return left.length === right.length && hashRows(left) === hashRows(right);
}
