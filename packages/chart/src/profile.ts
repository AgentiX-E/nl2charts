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

export function inferType(values: readonly unknown[]): FieldType {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return 'nominal';
  if (present.every((value) => typeof value === 'number')) {
    // Before the cardinality rule, because a year is not an ordinal scale: `[2019, 2020, 2021]` reads
    // as three categories of a measure otherwise, and the axis the table carries is thrown away.
    if (isCalendarRun(values)) return 'temporal';
    const unique = new Set(present).size;
    return present.length > 1 && unique <= Math.max(2, Math.ceil(present.length * 0.5)) && unique <= 20
      ? 'ordinal'
      : 'quantitative';
  }
  if (present.every((value) => typeof value === 'string' && (ISO_DATE.test(value) || PERIOD.test(value)))) {
    return 'temporal';
  }
  return 'nominal';
}

export function profileRows(rows: readonly Readonly<Record<string, unknown>>[]): FieldProfile[] {
  const first = rows[0];
  if (first === undefined) return [];
  return Object.keys(first).map((name) => {
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
