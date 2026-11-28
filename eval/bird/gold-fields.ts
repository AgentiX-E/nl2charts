/**
 * The gold field set a pairing gate reads, taken from the question's gold SQL instead of a
 * token-overlap proxy over the question text.
 *
 * r216 delivered `classifyCase`, which crosses a retriever pair with a gold `table.column` set and
 * splits it into confirmed and spurious buckets. It left the gold set to its caller. Z.35 flagged
 * the consequence: a gold approximated by matching question words against column names produces a
 * plausible-looking but false reading — a "gain" is measured against fields the SQL never needed.
 * The honest source is the SQL itself.
 *
 * `referencedFields` (statement.ts) already splits a statement into two shapes, and this module
 * resolves both into the canonical `table.column` space that the retrieval arms use:
 *
 * - **qualified** `alias.column` pairs have their alias resolved back to the FROM/JOIN table; the
 *   column is lower-cased. We look it up in the profile to restore the canonical spelling.
 * - **bare** identifiers are lower-cased and unresolved, and include SQL keywords. We keep only
 *   names a named table actually owns, so keywords drop out for free, and expand an ambiguous
 *   name across every named table that owns it rather than guessing one.
 *
 * A qualified pair that resolves to no profile row (a CTE column, a temp table) is kept lower-cased:
 * dropping it would understate coverage, and inventing a canonical name would be worse than the
 * honest key we were given.
 *
 * This is a deterministic, offline resolver. It emits no score, makes no model call, and is not a
 * pricing signal: it only makes the gold side of a future paired dispatch trustworthy.
 */
import type { DatabaseProfile } from '@agentix-e/nl2charts-ai';
import { referencedFields, tableRefs } from './statement.js';

/** One gold field in the canonical space: the table and column exactly as the profile names them. */
export interface GoldField {
  readonly table: string;
  readonly column: string;
}

/** Lower-case lookup key. The scanner lower-cases both shapes, so matching is case-insensitive. */
const lower = (value: string): string => value.toLowerCase();

function canonicalRow(profile: DatabaseProfile, tableLower: string, columnLower: string) {
  return profile.columns.find(
    (row) => lower(row.table) === tableLower && lower(row.column) === columnLower,
  );
}

/**
 * Resolve one lower-cased qualified pair back to its canonical table and column.
 *
 * Returns undefined when the column does not belong to that table — a qualifier must not borrow a
 * column from another table just because the name exists somewhere in the profile.
 */
export function canonicalColumn(
  table: string,
  column: string,
  profile: DatabaseProfile,
): GoldField | undefined {
  const row = canonicalRow(profile, lower(table), lower(column));
  return row === undefined ? undefined : { table: row.table, column: row.column };
}

/**
 * Resolve lower-cased bare identifiers against the profile.
 *
 * `namedTables`, when given, restricts resolution to the tables the statement actually reads, so
 * a keyword or a column owned only by an unread table cannot enter the gold set. An empty or absent
 * list means "any profile table" — used when the statement's table references cannot be read.
 */
export function resolveBareColumns(
  bare: readonly string[],
  profile: DatabaseProfile,
  namedTables?: readonly string[],
): GoldField[] {
  const allowed = namedTables === undefined || namedTables.length === 0
    ? undefined
    : new Set(namedTables.map(lower));
  const out: GoldField[] = [];
  const seen = new Set<string>();
  for (const name of new Set(bare.map(lower))) {
    for (const row of profile.columns) {
      if (lower(row.column) !== name) continue;
      if (allowed !== undefined && !allowed.has(lower(row.table))) continue;
      const key = `${row.table}\u0000${row.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ table: row.table, column: row.column });
    }
  }
  return out.sort(fieldOrder);
}

/**
 * Stable order so a reading is byte-for-byte reproducible across runs.
 *
 * Both call sites deduplicate by canonical key before sorting, so two equal keys never reach this
 * comparator; the only two outcomes are "less" and "greater". Asserting that invariant here keeps
 * the sort total on real inputs without a third branch that no input can take.
 */
function fieldOrder(a: GoldField, b: GoldField): number {
  const left = `${a.table}.${a.column}`;
  const right = `${b.table}.${b.column}`;
  return left < right ? -1 : 1;
}

/**
 * Extract the canonical gold field set from one gold SQL statement.
 *
 * Qualified pairs go through `referencedFields` (alias already resolved) and are restored to the
 * profile spelling. Bare identifiers are resolved against the statement's FROM/JOIN tables. The two
 * sources are unioned, deduplicated by canonical `table.column`, and sorted.
 */
export function extractGoldFields(sql: string, profile: DatabaseProfile): GoldField[] {
  if (sql.length === 0) return [];
  const read = referencedFields(sql);
  const namedTables = tableRefs(sql).map((ref) => ref.table);
  const out: GoldField[] = [];
  const seen = new Set<string>();
  const add = (field: GoldField) => {
    const key = `${field.table}\u0000${field.column}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(field);
  };
  for (const pair of read.qualified) {
    const resolved = canonicalColumn(pair.table, pair.column, profile);
    // A pair whose alias resolves to an unprofiled table (CTE/temp) is kept lower-cased and bare —
    // the honest key we were handed — but only when the qualifier is a name in this statement.
    add(resolved ?? { table: lower(pair.table), column: lower(pair.column) });
  }
  for (const field of resolveBareColumns(read.bare, profile, namedTables)) add(field);
  return out.sort(fieldOrder);
}

/** The gold set as `table.column` keys, the shape `classifyCase` consumes. */
export function goldKeys(sql: string, profile: DatabaseProfile): Set<string> {
  return new Set(extractGoldFields(sql, profile).map((field) => `${field.table}.${field.column}`));
}
