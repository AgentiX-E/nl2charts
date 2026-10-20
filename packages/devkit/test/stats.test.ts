import { describe, expect, it } from 'vitest';
import { compareArms, mcnemarExact, sameRows, summarise, wilsonInterval } from '../src/index.js';

describe('McNemar exact test', () => {
  it('returns 1 when the arms never disagree', () => {
    expect(mcnemarExact(0, 0)).toBe(1);
  });

  it('matches the reference values from the design POCs', () => {
    expect(mcnemarExact(8, 4)).toBeCloseTo(0.3877, 3);
    expect(mcnemarExact(4, 0)).toBeCloseTo(0.125, 3);
    expect(mcnemarExact(1, 0)).toBe(1);
  });

  it('is symmetric', () => {
    expect(mcnemarExact(9, 3)).toBe(mcnemarExact(3, 9));
  });
});

describe('Wilson interval', () => {
  it('reproduces the 25/30 interval quoted in the design', () => {
    const interval = wilsonInterval(25, 30);
    expect(interval.low * 100).toBeCloseTo(66.4, 1);
    expect(interval.high * 100).toBeCloseTo(92.7, 1);
  });

  it('handles the degenerate bounds', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
    expect(wilsonInterval(0, 10).low).toBe(0);
    expect(wilsonInterval(10, 10).high).toBe(1);
  });
});

describe('arm summaries', () => {
  const first = summarise('a', [
    { id: '1', passed: true },
    { id: '2', passed: true },
    { id: '3', passed: false },
    { id: '4', passed: false },
  ]);
  const second = summarise('b', [
    { id: '1', passed: true },
    { id: '2', passed: false },
    { id: '3', passed: true },
    { id: '4', passed: false },
  ]);

  it('counts passes and accuracy', () => {
    expect(first).toMatchObject({ total: 4, passed: 2, accuracy: 0.5 });
    expect(summarise('empty', []).accuracy).toBe(0);
  });

  it('builds the paired table and delta', () => {
    expect(compareArms(first, second)).toEqual({
      onlyFirst: 1,
      onlySecond: 1,
      both: 1,
      neither: 1,
      total: 4,
      delta: 0,
      discordant: 2,
    });
  });

  it('refuses arms with different case sets', () => {
    expect(() => compareArms(first, summarise('c', [{ id: '1', passed: true }]))).toThrow(/missing case/);
  });
});

describe('execution accuracy', () => {
  it('ignores row and column order but not values', () => {
    expect(sameRows([{ a: 1, b: 2 }], [{ b: 2, a: 1 }])).toBe(true);
    expect(sameRows([{ a: 1 }, { a: 2 }], [{ a: 2 }, { a: 1 }])).toBe(true);
    expect(sameRows([{ a: 1 }], [{ a: 2 }])).toBe(false);
    expect(sameRows([{ a: 1 }], [{ a: 1 }, { a: 1 }])).toBe(false);
  });
});

describe('result-set comparison by shape', () => {
  it('ignores aliases but not column order or values', async () => {
    const { sameResult } = await import('../src/index.js');
    expect(sameResult({ columns: ['a'], rows: [{ a: 1 }] }, { columns: ['b'], rows: [{ b: 1 }] })).toBe(true);
    expect(sameResult({ columns: ['a', 'b'], rows: [{ a: 1, b: 2 }] }, { columns: ['b', 'a'], rows: [{ a: 1, b: 2 }] })).toBe(false);
    expect(sameResult({ columns: ['a'], rows: [{ a: 1 }] }, { columns: ['a'], rows: [{ a: 2 }] })).toBe(false);
    expect(sameResult({ columns: ['a'], rows: [] }, { columns: ['a', 'b'], rows: [] })).toBe(false);
  });
});
