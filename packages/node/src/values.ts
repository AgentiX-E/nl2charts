/**
 * Map DuckDB driver values onto plain JavaScript values. The contract layer must
 * not know about driver wrapper classes, so the translation happens here and
 * only here.
 */
function isoDateFromDays(days: number): string {
  return new Date(Date.UTC(1970, 0, 1) + days * 86_400_000).toISOString().slice(0, 10);
}

function isoFromMicros(micros: bigint): string {
  return new Date(Number(micros / 1_000n)).toISOString();
}

function timeFromMicros(micros: bigint): string {
  const totalMs = Number(micros / 1_000n);
  const ms = totalMs % 1_000;
  const seconds = Math.floor(totalMs / 1_000) % 60;
  const minutes = Math.floor(totalMs / 60_000) % 60;
  const hours = Math.floor(totalMs / 3_600_000);
  const pad = (value: number, width = 2): string => value.toString().padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(ms, 3)}`;
}

function uuidFromHugeint(hugeint: bigint): string {
  // DuckDB stores a UUID as int128 with the sign bit flipped.
  const unsigned = (hugeint + (1n << 127n)) & ((1n << 128n) - 1n);
  const hex = unsigned.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function constructorName(value: object): string {
  return Object.getPrototypeOf(value)?.constructor?.name ?? '';
}

export function fromDuckDbValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || value instanceof Uint8Array) return value;

  const record = value as Record<string, unknown>;
  const name = constructorName(value);

  if (name === 'DuckDBDateValue' || (typeof record.days === 'number' && !('micros' in record))) {
    return isoDateFromDays(Number(record.days));
  }
  if (name === 'DuckDBTimestampValue' || name === 'DuckDBTimestampTZValue') {
    return isoFromMicros(BigInt(record.micros as bigint));
  }
  if (name === 'DuckDBTimeValue') {
    return timeFromMicros(BigInt(record.micros as bigint));
  }
  if (name === 'DuckDBIntervalValue') {
    const months = Number(record.months ?? 0);
    const days = Number(record.days ?? 0);
    const micros = BigInt((record.micros as bigint | undefined) ?? 0n);
    return `${months} months ${days} days ${micros.toString()} microseconds`;
  }
  if (name === 'DuckDBUUIDValue' || typeof record.hugeint === 'bigint') {
    return uuidFromHugeint(BigInt(record.hugeint as bigint));
  }
  if (name === 'DuckDBListValue') {
    return (record.items as unknown[]).map((item) => fromDuckDbValue(item));
  }
  if (name === 'DuckDBStructValue') {
    const entries = record.entries as Record<string, unknown>;
    return Object.fromEntries(Object.entries(entries).map(([key, item]) => [key, fromDuckDbValue(item)]));
  }
  return value;
}

export function fromDuckDbRow(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) output[key] = fromDuckDbValue(value);
  return output;
}
