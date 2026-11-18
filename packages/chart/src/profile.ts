import type { ChartIR, FieldRef, FieldType } from '@agentix-e/nl2charts-spec';

export interface FieldProfile {
  readonly name: string;
  readonly type: FieldType;
  readonly distinct: number;
  readonly nulls: number;
  readonly min?: number;
  readonly max?: number;
  readonly negative: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/;

/**
 * A period written as text: a year, a year and month, a quarter, a month name, or a month and a year.
 *
 * `ISO_DATE` alone accepted only `2026-01-01`, so a result set that spells its timeline `Dec` or
 * `Q1 2019` or `2019-01` typed `nominal`, no column was ordered, and every line or area the corpus
 * labels over such a table was refused before the question was read — 532 rows of Text2Vis, none of
 * them ever answered. The evidence for "this is time" is the *formatting*: a string written as a
 * period is a period.
 */
const PERIOD = new RegExp(
  '^(?:' +
    [
      '(?:19|20)\\d{2}', // 2019
      '(?:19|20)\\d{2}[-/]\\d{1,2}', // 2019-01
      '(?:19|20)\\d{2}[-/]?[qQ][1-4]', // 2019-Q1
      '[qQ][1-4](?:\\s*(?:19|20)\\d{2})?', // Q1, Q1 2019
      '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?(?:\\s+(?:19|20)\\d{2})?', // Dec, March 2014
    ].join('|') +
    ')$',
  'i',
);

/**
 * Whether a column of numbers walks the calendar, one year per row.
 *
 * This exists because a year arrives in two transports and used to get two types. `PERIOD` reads
 * `'2019'` as time, and the same column handed over as a *number* — which is what a driver with a
 * `YEAR` column sends, and what the Text2Vis corpus stores — typed `quantitative`, so the table lost
 * its axis and every bar, line, pie and area drawn over it was refused. The census prices the defect
 * at 182 rows of the corpus and 53 hits; the fix is not to guess from magnitude, which would turn a
 * price column of `2019` dollars into an axis, but to read the shape a timeline actually has:
 *
 * - every value is an integer (a year is; `2019.5` is a rating);
 * - no value repeats (a year appears once per row — a column that repeats is a group, not a period);
 * - the distinct values are a contiguous block, `max − min + 1` of them (a gap says the column is a
 *   sample of numbers that happen to be large, not a run of years);
 * - that block lies inside the calendar window;
 * - the rows read in order — each value one year from the one above it, ascending or descending.
 *
 * Five conditions, each one a way for a measure to fail it, and the last is what makes the read a
 * *timeline* rather than a block: an unsorted column of three consecutive years is a set, and a
 * result set that prints its years out of order is one that will be re-read by a person.
 *
 * Exported because the census has to price this rule against the alternative on every run rather
 * than restate it: `eval/text2vis/census.ts` un-types the columns this accepts and measures what the
 * product loses, which is the same predicate asked the inverse question.
 */
export function isCalendarRun(values: readonly unknown[]): boolean {
  // A missing cell breaks the run: the string path applies the same rule, where `PERIOD` has to
  // match every value or the column is not a period.
  if (values.length < 3) return false;
  if (!values.every((value) => typeof value === 'number' && Number.isInteger(value))) return false;
  const years = values as readonly number[];
  const distinct = new Set(years);
  if (distinct.size !== years.length) return false;
  let low = Infinity;
  let high = -Infinity;
  for (const year of distinct) {
    if (year < low) low = year;
    if (year > high) high = year;
  }
  if (low < 1900 || high > 2100) return false;
  if (high - low + 1 !== distinct.size) return false;
  return years.every((year, index) => index === 0 || Math.abs(year - (years[index - 1] as number)) === 1);
}

/**
 * Whether a column of numbers is exactly one pair of different values.
 *
 * Two values, not two rows: a three-row column holding `1, null, 2` reaches the rule with a present
 * count of two, and the rule it breaks is about how many values there are, not how many rows.
 *
 * The cardinality rule below asks "does this number column repeat inside a small range", and with two
 * values `unique <= max(2, ceil(n / 2))` is `2 <= 2` — true for every pair of different values. That
 * made the question unanswerable rather than answered: such a table had no measure at all.
 * 145 of the Text2Vis corpus's tables are exactly that shape, `Oman` and `Samoa` against seven year
 * columns, and every measure in them typed `ordinal`, so all ten admission rules refused the table
 * and the product drew nothing. A pair is therefore decided by what its numbers look like, below.
 */
function isPair(present: readonly unknown[]): boolean {
  return present.length === 2 && new Set(present).size === 2;
}

/** The largest whole number still read as a scale — a Likert row, a 1-10 rating, a decile. */
const SCALE_CEILING = 20;

/**
 * Whether a pair's numbers look like a two-point scale or two years, rather than two measurements.
 *
 * `[1999, 2000]` is the pair the calendar guard already refuses to call a timeline, and calling it a
 * measure would put a measurement on the axis of a two-bar chart of years. `[1, 2]` is an encoding
 * before it is a measurement. `[183.88, 40.72]` is neither: it is a measurement, and it is the
 * reading that says so — 145 tables of the corpus stopped being refused when this predicate was
 * written.
 */
function looksLikeScale(present: readonly unknown[]): boolean {
  return present.every(
    (value) =>
      typeof value === 'number' &&
      Number.isInteger(value) &&
      (Math.abs(value) <= SCALE_CEILING || (value >= 1900 && value <= 2100)),
  );
}

export function inferType(values: readonly unknown[]): FieldType {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return 'nominal';
  if (present.every((value) => typeof value === 'number')) {
    // Before the cardinality rule, because a year is not an ordinal scale: `[2019, 2020, 2021]` reads
    // as three categories of a measure otherwise, and the axis the table carries is thrown away.
    if (isCalendarRun(values)) return 'temporal';
    const unique = new Set(present).size;
    const low = present.length > 1 && unique <= Math.max(2, Math.ceil(present.length * 0.5)) && unique <= 20;
    return low && (!isPair(present) || looksLikeScale(present)) ? 'ordinal' : 'quantitative';
  }
  if (present.every((value) => typeof value === 'string' && (ISO_DATE.test(value) || PERIOD.test(value)))) {
    return 'temporal';
  }
  return 'nominal';
}

/**
 * One profile per column, in the order the caller named.
 *
 * `columns` exists because `Object.keys` does not answer "what order were these columns in?". The
 * language puts integer-like keys first, in ascending order, before every other key — so a record
 * keyed `{ country: 'Armenia', '2016': null }` enumerates as `['2016', 'country']`, and a result set
 * whose columns are years is silently reordered before this function sees it. The chart reading found
 * it the expensive way: 389 of 1,464 corpus tables had a first column that was not the table's first
 * column, five of them chose an entirely empty year column as the category axis, and the figure that
 * came out had `labels = [None, None, None, None, None]` — a bar chart of nothing whose mark was
 * still `bar`, so no label-based score moved and only a reader of the picture could see it.
 *
 * A caller that knows the order passes it. A caller that does not — one holding plain objects — gets
 * `Object.keys`, which is the only order a record has left.
 */
export function profileRows(rows: readonly Readonly<Record<string, unknown>>[], columns?: readonly string[]): FieldProfile[] {
  const first = rows[0];
  if (first === undefined) return [];
  // `name in first` rather than a cast: a column named by the caller but absent from the rows would
  // profile as a column of nulls, and a column of nulls is not a column.
  const names = columns === undefined ? Object.keys(first) : columns.filter((name) => name in first);
  return names.map((name) => {
    const values = rows.map((row) => row[name]);
    const type = inferType(values);
    const numbers = values.filter((value): value is number => typeof value === 'number');
    const present = values.filter((value) => value !== null && value !== undefined);
    const profile: FieldProfile = {
      name,
      type,
      distinct: new Set(present.map((value) => String(value))).size,
      nulls: values.length - present.length,
      negative: numbers.some((value) => value < 0),
    };
    if (numbers.length > 0) {
      return { ...profile, min: Math.min(...numbers), max: Math.max(...numbers) };
    }
    return profile;
  });
}

export function refFor(name: string, profiles: readonly FieldProfile[], aggregate?: FieldRef['aggregate']): FieldRef {
  const profile = profiles.find((candidate) => candidate.name === name);
  const ref: FieldRef = { field: name, type: profile?.type ?? 'nominal' };
  if (aggregate !== undefined) ref.aggregate = aggregate;
  return ref;
}

export function distinctValues(ir: ChartIR, field: string): string[] {
  const values = new Set<string>();
  for (const row of ir.data) values.add(String(row[field]));
  return [...values];
}
