import { describe, expect, it } from 'vitest';
import { renderEvidence } from '../src/evidence.js';

const profile = {
  db: 'shop',
  columns: [
    { table: 'orders', column: 'status', kind: 'categorical' as const, values: ['completed', 'refunded'], distinct: 2 },
    { table: 'orders', column: 'order_date', kind: 'date' as const, min: '2024-01-01', max: '2024-12-31' },
    { table: 'orders', column: 'amount', kind: 'numeric' as const, min: 10.5, max: 199.9 },
    { table: 'orders', column: 'id', kind: 'other' as const },
  ],
};

describe('rendered evidence', () => {
  it('states values, date ranges and number ranges in one line each', () => {
    expect(renderEvidence(profile)).toBe(
      ['Data profile:', '- orders.status: 2 values (completed, refunded)', '- orders.order_date: dates from 2024-01-01 to 2024-12-31', '- orders.amount: numbers from 10.5 to 199.9'].join('\n'),
    );
  });

  it('spends the budget on dictionaries before ranges', () => {
    const mixed = {
      db: 'x',
      columns: [
        { table: 'a', column: 'amount', kind: 'numeric' as const, min: 0, max: 10 },
        { table: 'b', column: 'status', kind: 'categorical' as const, values: ['open', 'closed'], distinct: 2 },
      ],
    };
    const text = renderEvidence(mixed, { maxChars: 60 });
    expect(text).toContain('b.status');
    expect(text).not.toContain('a.amount');
  });

  it('returns nothing when the profile carries no signal', () => {
    expect(renderEvidence({ db: 'x', columns: [{ table: 't', column: 'id', kind: 'other' }] })).toBe('');
    expect(renderEvidence({ db: 'x', columns: [] })).toBe('');
  });

  it('caps the values per column', () => {
    const many = {
      db: 'x',
      columns: [{ table: 't', column: 'c', kind: 'categorical' as const, values: ['a', 'b', 'c', 'd'], distinct: 4 }],
    };
    expect(renderEvidence(many, { maxValues: 2 })).toContain('(a, b)');
  });

  it('cuts on a line boundary instead of mid-line', () => {
    const long = {
      db: 'x',
      columns: Array.from({ length: 40 }, (_, index) => ({
        table: 't',
        column: `column_${index}`,
        kind: 'categorical' as const,
        values: ['alpha', 'beta'],
        distinct: 2,
      })),
    };
    const text = renderEvidence(long, { maxChars: 160 });
    const lines = text.split('\n');
    expect(text.length).toBeLessThanOrEqual(160);
    for (const line of lines.slice(1)) expect(line.endsWith(')')).toBe(true);
  });

  it('skips a categorical column whose values were not profiled', () => {
    const sparse = { db: 'x', columns: [{ table: 't', column: 'c', kind: 'categorical' as const, distinct: 3 }] };
    expect(renderEvidence(sparse)).toBe('');
  });
});
