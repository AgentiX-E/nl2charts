import { describe, expect, it } from 'vitest';
import { CASES } from '../eval/adversarial/cases.js';

describe('adversarial case set', () => {
  it('has eight cases per category', () => {
    const counts = new Map<string, number>();
    for (const testCase of CASES) counts.set(testCase.category, (counts.get(testCase.category) ?? 0) + 1);
    expect([...counts.entries()].sort()).toEqual([
      ['multi-hop', 8],
      ['ratio', 8],
      ['tie', 8],
      ['window', 8],
    ]);
  });

  it('uses unique ids that encode their category', () => {
    const ids = CASES.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const testCase of CASES) {
      expect(testCase.id.startsWith(testCase.category.charAt(0))).toBe(true);
    }
  });

  it('states what each case probes and asks a question without leaking SQL', () => {
    for (const testCase of CASES) {
      expect(testCase.probes.length).toBeGreaterThan(10);
      expect(testCase.question.length).toBeGreaterThan(20);
      // A question that contains a SELECT would let the model copy the answer.
      expect(testCase.question.toLowerCase()).not.toContain('select ');
      expect(testCase.sql.trim().toLowerCase().startsWith('select') || testCase.sql.trim().toLowerCase().startsWith('with')).toBe(true);
    }
  });

  it('does not reuse a gold statement as a question or another gold statement', () => {
    const normalised = CASES.map((testCase) => testCase.sql.replace(/\s+/g, ' ').trim().toLowerCase());
    expect(new Set(normalised).size).toBe(normalised.length);
  });

  it('spreads cases over several databases so one schema cannot dominate', () => {
    const databases = new Set(CASES.map((testCase) => testCase.db));
    expect(databases.size).toBeGreaterThanOrEqual(4);
  });
});
