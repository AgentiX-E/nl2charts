import type { ChartIR, FieldRef, FieldType } from '@agentix-e/nl2charts-spec';

export interface FieldProfile {
  readonly name: string;
  readonly type: FieldType;
  readonly distinct: number;
  readonly nulls: number;
  /**
   * How many cells hold a finite number.
   *
   * Reported because it is the count that decides whether a column can be *summarised*: a five-number
   * summary needs at least four numbers, and a cell that arrives as `NaN` — which a driver or a CSV
   * does send — is not one. `nulls` cannot answer this (a `NaN` is present and is not a null) and
   * neither can `distinct` (a column of ten `NaN`s has one distinct value). It is also the only way
   * `min` and `max` can stay finite: they are computed over exactly these cells.
   */
  readonly numbers: number;
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
 * Whether a column of numbers is a column of years.
 *
 * This exists because a year arrives in two transports and used to get two types. `PERIOD` reads
 * `'2019'` as time, and the same column handed over as a *number* — which is what a driver with a
 * `YEAR` column sends, and what the Text2Vis corpus stores — typed `quantitative`, so the table lost
 * its axis and every bar, line, pie and area drawn over it was refused. The census prices the defect
 * at 182 rows of the corpus and 53 hits; the fix is not to guess from magnitude, which would turn a
 * price column of `2019` dollars into an axis, but to read the shape a year column actually has:
 *
 * - every value is an integer (a year is; `2019.5` is a rating);
 * - no value repeats (a year appears once per row — a column that repeats is a group, not a period);
 * - every value lies inside the calendar window;
 * - there are at least three of them (two years are a pair, not a timeline).
 *
 * A fifth condition used to be here and it was wrong: the values had to be a contiguous block and
 * the rows had to read one year apart. A survey fielded every two or three years — `2002, 2004,
 * 2006, 2008, 2010` — is a time axis with holes in it, and the rule refused it, so the table lost its
 * axis: every line and bar over it was refused and a scatter was recommended from the measures that
 * survived. The defence was that a gap makes a year column indistinguishable from a price column that
 * happens to be large, and it was an argument rather than a reading. The reading: on the 1,470 scored
 * rows the gap clause is worth **ten rows gained against three lost**, and none of the three is a
 * price column — they are years the corpus labels a scatter, a boxplot or a bar.
 *
 * Exported because the census has to price this rule against the alternative on every run rather
 * than restate it: `eval/text2vis/census.ts` un-types the columns this accepts and measures what the
 * product loses, which is the same predicate asked the inverse question.
 */
export function isCalendarColumn(values: readonly unknown[]): boolean {
  // A missing cell breaks the column: the string path applies the same rule, where `PERIOD` has to
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
  return low >= CALENDAR_LOW && high <= CALENDAR_HIGH;
}

/** The most distinct values a scale may carry — a Likert row, a 1-10 rating, a decile. */
const SCALE_CEILING = 20;

/** The window a year column lives in, and the one `PERIOD` accepts as a bare year. */
const CALENDAR_LOW = 1900;
const CALENDAR_HIGH = 2100;

/**
 * Whether a column of numbers is a scale rather than a measurement.
 *
 * Three readings, and the rule needs all three.
 *
 * **It steps by one.** `1, 2, 3, 4, 5` is a rating and `9, 10, 12, 14` is four measurements. The rule
 * used to be cardinality alone — "does this number column repeat inside a small range" — and a
 * cardinality is not a scale: with eight rows and four values `unique <= ceil(n / 2)` holds for any
 * four-value column, so a survey's percentages per wave were read as an axis and the measure it
 * carried disappeared. The corpus shows what that cost: two-measure scatters answered `heatmap`, and
 * heatmaps answered `scatter`, because a measure had been promoted to a dimension.
 *
 * **It repeats.** `1, 2, 3, 4, 5` one value per row is a row index — what a `SELECT` over an
 * auto-increment key returns — and an axis of row numbers groups nothing, so the cardinality gate
 * stays: no more than half the rows may be distinct, and at most twenty values in all. The gate is
 * not a matter of taste: removing it reads **604** on the corpus against this rule's **606**.
 *
 * **It starts where a scale starts.** A *two-value* column is the case the first reading cannot
 * decide, because every pair of adjacent integers steps by one — `22, 23` as much as `1, 2`. The
 * corpus has both, and the difference is what they are: a two-point scale begins at zero or one, and
 * a pair of numbers that begins at 22 is two measurements. So a pair must begin at 0 or 1, or be a
 * pair of years — `1999, 2000` is a two-point time axis, and calling it a measurement would put a
 * measurement on the axis of a two-bar chart of years. Dropping the year half of that reads the same
 * top-1 (606) and one row fewer in `declined`; it is kept because a year is not a quantity, and one
 * row is not evidence enough to overrule that.
 *
 * The predicate that used to guard exactly this pair (`looksLikeScale`, with `isPair` beside it) is
 * gone: it asked whether every value was small or a year, which is the same question as "does the
 * run start at zero or one" asked about the whole column instead of about the pair, and it read
 * `[10, 12, 9, 14]` as a scale because all four values were small.
 */
function isScale(present: readonly unknown[]): boolean {
  if (present.length <= 1) return false;
  if (!present.every((value) => typeof value === 'number' && Number.isInteger(value))) return false;
  const sorted = [...new Set(present as readonly number[])].sort((left, right) => left - right);
  if (sorted.length > SCALE_CEILING) return false;
  if (sorted.length > Math.max(2, Math.ceil(present.length * 0.5))) return false;
  if (sorted.length === 2) {
    const low = sorted[0] as number;
    const years = low >= CALENDAR_LOW && (sorted[1] as number) <= CALENDAR_HIGH;
    if (low > 1 && !years) return false;
  }
  return sorted.every((value, at) => at === 0 || value === (sorted[at - 1] as number) + 1);
}

export function inferType(values: readonly unknown[]): FieldType {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return 'nominal';
  if (present.every((value) => typeof value === 'number')) {
    // Before the cardinality rule, because a year is not an ordinal scale: `[2019, 2020, 2021]` reads
    // as three categories of a measure otherwise, and the axis the table carries is thrown away.
    if (isCalendarColumn(values)) return 'temporal';
    return isScale(present) ? 'ordinal' : 'quantitative';
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
    // Finite numbers only: `NaN` and `±Infinity` arrive from a result set that prints them, and a
    // profile whose `min` is `NaN` is a profile nothing can be ordered by — the sort in `widest`
    // compares them, the span is `NaN`, and every admission that reads a range reads a number that
    // is not one.
    const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const present = values.filter((value) => value !== null && value !== undefined);
    const profile: FieldProfile = {
      name,
      type,
      distinct: new Set(present.map((value) => String(value))).size,
      nulls: values.length - present.length,
      numbers: numbers.length,
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
