/**
 * The value examples MAC-SQL puts on its card, ported so the block can be priced.
 *
 * The competitor gap this repository is chasing is 6.45pp, and the plan's next step is to
 * attribute it to a *block* rather than to "their pipeline". Their selector reads a schema
 * description in which every non-key column carries `Value examples: [...]`, gathered by
 * `core/agents.py` at sha `31a9df5e`. Our card carries stored values only for categorical
 * columns, only eight of them, and never says whether the column stores a NULL. So before
 * any model is spent, the honest question is: what information does their block actually
 * add over ours, per gold case, and what does it cost in characters?
 *
 * Answering that requires the rule itself, not an approximation of it, or the differential
 * would price our reading of their prompt. So this file is a port with the quirks kept:
 *
 * - key columns are skipped by identity (primary key or foreign key), and any column whose
 *   name ends in `id`, `email` or `url` is skipped by name;
 * - values come from `group by column order by count(*) desc`, so the examples are the
 *   *most frequent* values, not a random sample — which is what makes them a relevant
 *   sample of a filter and also what makes them miss a rare one;
 * - a numeric column with more than ten distinct values gets no examples at all, so their
 *   block is not "values for every column" but "values for the columns that look like
 *   dictionaries", and the numeric branch is half of that decision;
 * - a text column is dropped whole — not truncated — when any stored value is longer than
 *   50 characters, is a URL, or is an email;
 * - six examples, cut to one when every example parses as a `YYYY-MM-DD` date;
 * - a NULL anywhere in the column is emitted first, because their decompose prompt reads
 *   it as a hint to use `IS NOT NULL`.
 *
 * Two deviations, both deliberate and both stated in the report:
 *
 * 1. `NULL` instead of Python's `None`, because the reader of our card is a SQL model and
 *    the card is SQL-shaped.
 * 2. `NULL` instead of Python's `None` (above). The query is theirs byte for byte, including
 *    the tie order their `order by count(*) desc` leaves to SQLite: a tie-broken port would
 *    pick different members for a column whose values are all distinct, and on this corpus
 *    that is most columns — 31 of 87 columns disagreed when this file added a tiebreak, all
 *    of them for that reason. A sample that is *theirs* is the whole point, so the order is
 *    reproduced rather than tidied. Cross-checked against their own code over three
 *    databases: 87 columns, 0 disagreements (`eval/bird/macsql-examples.py`).
 *
 * The type tests are exact-case on the declared type, as theirs are: a column declared
 * `varchar(50)` gets neither the numeric cut-off nor the text filters in their code, and a
 * port that "fixed" that would be measuring a different mechanism. `typeQuirks` counts the
 * columns where the difference between exact and loose matching would bite, so the report
 * can say whether the quirk matters instead of assuming either way.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Oracle } from './oracle.js';

/** The rule's identity, stored with the cache so a change to this file invalidates it. */
export const EXAMPLE_RULE = 'mac-sql@31a9df5e';

/** The cuts, named once. Tests assert the port against these, not against literals. */
export const EXAMPLE_LIMITS = {
  /** Examples per column. */
  values: 6,
  /** A numeric column above this many distinct values gets none. */
  numericDistinct: 10,
  /** A column whose examples all parse as dates keeps one. */
  dateValues: 1,
  /** A text value longer than this drops the column. */
  maxTextLength: 50,
  /**
   * Distinct values fetched per column, as a guard rather than a rule. Their query has no
   * bound; the widest column on this corpus is 189,959 distinct values and groups in 0.3 s,
   * so the ceiling sits far above anything measured and `capped` — not this number —
   * is what the report reads when a column is skipped.
   */
  distinctCap: 500000,
} as const;

/** Types their code treats as text, matched exactly as it matches them. */
const TEXT_TYPES = new Set(['TEXT', 'VARCHAR']);
/** Types their code refuses examples for once they are not a small dictionary. */
const NUMERIC_TYPES = new Set(['INTEGER', 'REAL', 'NUMERIC', 'FLOAT', 'INT']);

export interface ExampleColumn {
  readonly table: string;
  readonly column: string;
  /** The declared type SQLite reports, which is what their type tests read. */
  readonly type: string;
  /** The examples, in emission order, `NULL` first when the column stores one. */
  readonly values: readonly string[];
}

export interface ExampleSet {
  readonly db: string;
  readonly rule: string;
  readonly columns: readonly ExampleColumn[];
  /** Columns the fetch cap refused, by `table.column`. */
  readonly capped: readonly string[];
  /** Columns whose declared type is text-like but not exactly `TEXT`/`VARCHAR`. */
  readonly typeQuirks: number;
}

/** Whether their code applies the text filters to this declared type. */
export function isTextType(declaredType: string): boolean {
  return TEXT_TYPES.has(declaredType);
}

/** Whether their code refuses examples for this declared type above the distinct cut-off. */
export function isNumericType(declaredType: string): boolean {
  return NUMERIC_TYPES.has(declaredType);
}

/**
 * Their `is_valid_date`: ten characters, `YYYY-MM-DD`, month and day within range.
 *
 * The ranges are not a calendar — their code accepts `2011-02-31` — and that laxness is
 * kept, because a stricter test would keep six examples where they keep one.
 */
export function isDateValue(value: string): boolean {
  // Their `date_str.split()[0]` keeps the first token and then demands exactly ten characters,
  // which is the same thing as "a date, followed by whitespace or the end": one expression
  // instead of a split whose first element typescript still calls possibly-undefined, and a
  // branch that no input could reach either way.
  const match = /^\s*(\d{4})-(\d{2})-(\d{2})(?:\s|$)/.exec(value);
  if (match === null) return false;
  const [, year, month, day] = match as unknown as [string, string, string, string];
  return Number(year) >= 1 && Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31;
}

/** Their `is_email`: one local part, one domain, one dot, word characters and `.`/`-`. */
export function isEmail(value: string): boolean {
  return /^[\w.-]+@[\w.-]+\.\w+$/.test(value);
}

/** Whether a column name is skipped by name, before any statistics are read. */
export function isKeyName(column: string): boolean {
  const lower = column.toLowerCase();
  return lower.endsWith('id') || lower.endsWith('email') || lower.endsWith('url');
}

/**
 * The rule itself: one column's distinct values in, the examples their card shows out.
 *
 * `values` are the distinct values in frequency order, `null` standing for a stored NULL.
 * The order of the tests matters and is theirs: the numeric cut-off counts distinct values
 * *before* empties and nulls are removed, so a numeric column with eleven distinct values
 * gets nothing even if three of them are empty strings.
 */
export function examplesOf(values: readonly (string | null)[], declaredType: string): string[] {
  if (values.length === 0) return [];
  if (values.length > EXAMPLE_LIMITS.numericDistinct && isNumericType(declaredType)) return [];

  let hasNull = false;
  let kept: string[] = [];
  for (const value of values) {
    if (value === null) {
      hasNull = true;
      continue;
    }
    if (value.trim() === '') continue;
    kept.push(value);
  }
  if (kept.length === 0) return [];

  if (isTextType(declaredType)) {
    // No empty test here: the loop above already dropped every value whose trimmed form is
    // empty, so their `v == ''` check inside this branch cannot fire. Kept as a comment rather
    // than as code, because a guard no input can reach is a branch no test can cover.
    const filtered: string[] = [];
    for (const value of kept) {
      // Their code drops the whole column, not the one value: a single URL means the
      // column is a link, and six links are not a dictionary.
      if (value.includes('https://') || value.includes('http://')) return [];
      if (isEmail(value)) return [];
      filtered.push(value);
    }
    kept = filtered;
    // A loop rather than `Math.max(...kept)`: a text column on this corpus holds 189,959
    // distinct values, and spreading that many arguments overflows the stack. The first
    // version did, and the corpus found it — a test fixture of twelve rows never would.
    let longest = 0;
    for (const value of kept) longest = Math.max(longest, value.length);
    if (longest > EXAMPLE_LIMITS.maxTextLength) return [];
  }

  kept = kept.slice(0, EXAMPLE_LIMITS.values);
  if (kept.every((value) => isDateValue(value))) {
    kept = kept.slice(0, EXAMPLE_LIMITS.dateValues);
  }
  const out = [...kept];
  if (hasNull) out.unshift('NULL');
  return out;
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** A column as introspection reports it. */
interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly pk: number;
}

/**
 * The columns their selector would have considered, before any statistics.
 *
 * Primary keys come from `pragma table_info`'s `pk` ordinal and foreign keys from
 * `pragma foreign_key_list`, which is the same information their pre-generated database
 * dictionary carries.
 */
export function consideredColumns(
  columns: readonly ColumnInfo[],
  foreignKeys: ReadonlySet<string>,
): ColumnInfo[] {
  return columns.filter((column) => column.pk === 0 && !foreignKeys.has(column.name) && !isKeyName(column.name));
}

/**
 * Build one database's example set, or read it from the cache.
 *
 * The cache is keyed by database only and carries the rule's identity inside, so a change
 * to `examplesOf` invalidates every entry instead of silently serving yesterday's rule —
 * the failure mode a name-only cache has, and it reports itself as a stable measurement.
 */
export async function exampleSetFor(
  oracle: Oracle,
  db: string,
  options: {
    readonly cacheDir: string;
    readonly force?: boolean;
    /**
     * The fetch ceiling, lowered by a caller that wants to prove the branch rather than by a
     * run that needs a different one. The default is `EXAMPLE_LIMITS.distinctCap`, which no
     * column on this corpus reaches; a test with three values and a ceiling of two is the only
     * way the "named, not fetched" path is exercised at all.
     */
    readonly distinctCap?: number;
  },
): Promise<ExampleSet> {
  const cap = options.distinctCap ?? EXAMPLE_LIMITS.distinctCap;
  mkdirSync(options.cacheDir, { recursive: true });
  const cacheFile = join(options.cacheDir, `${db}.json`);
  if (options.force !== true && existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as ExampleSet;
    if (cached.rule === EXAMPLE_RULE) return cached;
  }

  const tables = await oracle.run(
    db,
    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
  );
  const columns: ExampleColumn[] = [];
  const capped: string[] = [];
  let typeQuirks = 0;
  // Both ends of every foreign key are key columns in their dictionary, so the referenced
  // column is skipped as well as the referring one. Their pre-generated dictionary adds both
  // indices of each pair; reading only the referring end left five columns of `student_club`
  // on our card that theirs never shows, which is how this was found.
  const schema = new Map<string, { name: string; type: string; pk: number }[]>();
  const keys = new Set<string>();
  for (const row of tables.rows) {
    const table = String(row[0]);
    const info = await oracle.run(
      db,
      `select name, type, pk from pragma_table_info('${table.replace(/'/g, "''")}') order by cid`,
    );
    // `pragma_table_info` reports a name, a type and a pk ordinal for every column of a table
    // that exists, so the nullish fallbacks that stood here guarded outcomes it cannot report.
    schema.set(
      table,
      info.rows.map((entry) => ({ name: String(entry[0]), type: String(entry[1]), pk: Number(entry[2] as number) })),
    );
    const fk = await oracle.run(
      db,
      `select "from", "table", "to" from pragma_foreign_key_list('${table.replace(/'/g, "''")}')`,
    );
    // A foreign-key list that cannot be read means the key set is wrong, and a wrong key set
    // is a block that shows columns theirs never shows: fail rather than widen quietly.
    if (!fk.ok) {
      throw new Error(
        `exampleSetFor: ${db}.${table} could not be asked for its foreign keys, so the key set would be smaller than theirs`,
      );
    }
    for (const entry of fk.rows) {
      keys.add(`${table}\u0000${String(entry[0])}`);
      keys.add(`${String(entry[1])}\u0000${String(entry[2])}`);
    }
  }
  for (const [table, declared] of schema) {
    const foreignKeys = new Set(
      [...keys].filter((key) => key.startsWith(`${table}\u0000`)).map((key) => key.slice(table.length + 1)),
    );
    for (const column of consideredColumns(declared, foreignKeys)) {
      const lower = column.type.toLowerCase();
      if ((lower.includes('char') || lower.includes('text')) && !isTextType(column.type)) typeQuirks += 1;
      // The distinct count is read first for two reasons, neither of them an optimisation
      // for its own sake. Their numeric cut-off counts distinct values, so a column above it
      // is skipped without fetching a list that would be discarded; and a column above the
      // fetch cap is named in `capped` instead of being fetched into memory, which keeps the
      // bound visible rather than implicit in however much the file happened to hold.
      // A column that cannot be counted is not a column without examples: it is a block that
      // came out smaller than theirs, which would understate the ceiling this instrument
      // exists to report. Their code swallows the error into an empty string; that is the kind
      // of silent hole the port refuses.
      const counted = await oracle.run(db, `select count(distinct ${quote(column.name)}) from ${quote(table)}`);
      if (!counted.ok) {
        throw new Error(
          `exampleSetFor: ${db}.${table}.${column.name} could not be counted (${String(counted.error)}), so the block would be smaller than their card`,
        );
      }
      // `count(distinct …)` returns exactly one row holding one number, so the fallbacks that
      // stood here described an outcome the aggregate cannot report.
      const distinctCount = Number((counted.rows[0] as [number])[0]);
      if (distinctCount > EXAMPLE_LIMITS.numericDistinct && isNumericType(column.type)) continue;
      if (distinctCount > cap) {
        capped.push(`${table}.${column.name}`);
        continue;
      }
      // Their statement, unprefixed and unbounded: adding a tiebreak or a limit changes both
      // the order of a tie and, with it, which six values a column of distinct values shows.
      // `cast(... as text)` because their values are printed by Python's `str`: a REAL
      // column whose entries are whole numbers reads `2.0` on their card and would read `2`
      // here, and a sample that spells the value differently from theirs is a different
      // sample. The grouping stays on the raw column, so `2` and `'2'` remain two groups.
      const values = await oracle.run(
        db,
        `select cast(${quote(column.name)} as text) from ${quote(table)} group by ${quote(column.name)} order by count(*) desc`,
      );
      if (!values.ok) {
        throw new Error(
          `exampleSetFor: ${db}.${table}.${column.name} could not be read (${String(values.error)}), so the block would be smaller than their card`,
        );
      }
      const distinct = values.rows.map((entry) => (entry[0] === null ? null : String(entry[0])));
      const examples = examplesOf(distinct, column.type);
      if (examples.length === 0) continue;
      columns.push({ table, column: column.name, type: column.type, values: examples });
    }
  }

  const set: ExampleSet = { db, rule: EXAMPLE_RULE, columns, capped, typeQuirks };
  writeFileSync(cacheFile, `${JSON.stringify(set, null, 2)}\n`);
  return set;
}

/**
 * The set as `table.column` → values, which is the shape `attachSamples` takes.
 *
 * A function rather than a field so that every caller reads the same map: two projections
 * of the same set is how the card and the measurement come to disagree.
 */
export function exampleMapOf(set: ExampleSet): Map<string, readonly string[]> {
  const byColumn = new Map<string, readonly string[]>();
  for (const column of set.columns) byColumn.set(`${column.table}.${column.column}`, column.values);
  return byColumn;
}
