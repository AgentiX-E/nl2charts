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
 * period is a period. A number is not, which is why `[2019, 2020]` stays a measure — a column of
 * prices in the 2000s is indistinguishable from a column of years, and guessing from the magnitude
 * alone would turn a measure into an axis.
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

export function inferType(values: readonly unknown[]): FieldType {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return 'nominal';
  if (present.every((value) => typeof value === 'number')) {
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
