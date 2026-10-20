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

export function inferType(values: readonly unknown[]): FieldType {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return 'nominal';
  if (present.every((value) => typeof value === 'number')) {
    const unique = new Set(present).size;
    return present.length > 1 && unique <= Math.max(2, Math.ceil(present.length * 0.5)) && unique <= 20
      ? 'ordinal'
      : 'quantitative';
  }
  if (present.every((value) => typeof value === 'string' && ISO_DATE.test(value))) return 'temporal';
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
