import { describe, expect, it } from 'vitest';
import {
  casesForEffect,
  compareArms,
  mcnemarExact,
  pairedResolution,
  sameRows,
  summarise,
  wilsonInterval,
} from '../src/index.js';

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

describe('what a paired result can see', () => {
  // 1 case only before, 4 only after, out of 120 — the cross-vendor comparison as
  // measured. Every number below is derived from those five discordant pairs.
  const measured = pairedResolution(1, 4, 120);

  it('reports the difference with its interval, not just its sign', () => {
    expect(measured.delta * 100).toBeCloseTo(2.5, 2);
    expect(measured.low * 100).toBeCloseTo(-1.15, 2);
    expect(measured.high * 100).toBeCloseTo(6.15, 2);
    expect(measured.discordantShare * 100).toBeCloseTo(4.17, 2);
  });

  it('reports the smallest difference this design could have detected', () => {
    // (1.96 + 0.8416) * sqrt(0.0417 / 120) = 5.2pp. A 2.5pp delta sits inside it,
    // which is why the p-value is allowed to be large without the lever being dead.
    expect(measured.mde * 100).toBeCloseTo(5.22, 2);
    expect(measured.mde).toBeGreaterThan(measured.delta);
  });

  it('widens the resolution a stricter power demands', () => {
    const eighty = pairedResolution(1, 4, 120, 0.8).mde;
    const ninety = pairedResolution(1, 4, 120, 0.9).mde;
    const ninetyFive = pairedResolution(1, 4, 120, 0.95).mde;
    expect(eighty).toBeLessThan(ninety);
    expect(ninety).toBeLessThan(ninetyFive);
    expect(ninety * 100).toBeCloseTo(6.04, 2);
    expect(ninetyFive * 100).toBeCloseTo(6.72, 2);
  });

  it('refuses a power whose multiplier is not in the file', () => {
    expect(() => pairedResolution(1, 4, 120, 0.7)).toThrow(/no multiplier/);
  });

  it('does not read perfect agreement as a design that could see anything', () => {
    // Zero discordant pairs is not a zero-width interval: three cases in 120 is the 95%
    // upper bound on a rate that produced no event, so the design still cannot exclude
    // a 4pp difference. A zero here would have called an unresolved question resolved.
    const agreed = pairedResolution(0, 0, 120);
    expect(agreed.delta).toBe(0);
    expect(agreed.discordantShare * 100).toBeCloseTo(2.5, 2);
    expect(agreed.mde * 100).toBeCloseTo(4.04, 2);
    expect(agreed.high).toBeGreaterThan(0);
  });

  it('reports a difference as the same size in either direction', () => {
    const forward = pairedResolution(1, 4, 120);
    const backward = pairedResolution(4, 1, 120);
    expect(backward.delta).toBeCloseTo(-forward.delta, 12);
    expect(backward.mde).toBeCloseTo(forward.mde, 12);
    expect(backward.high - backward.low).toBeCloseTo(forward.high - forward.low, 12);
  });

  it('says nothing about a comparison with no cases', () => {
    expect(pairedResolution(0, 0, 0)).toEqual({ delta: 0, low: 0, high: 0, discordantShare: 0, mde: 1 });
  });

  it('caps the resolution at "everything" when the design resolves nothing', () => {
    expect(pairedResolution(1, 1, 2).mde).toBe(1);
  });
});

describe('how many cases a claim needs', () => {
  // The discordance rate is the expensive parameter: it is a property of the pair, not
  // of the size of the effect, so it can be read from a 120-case run and used to size
  // the next one. 4.17% is what the cross-vendor pair actually produced.
  const share = 5 / 120;

  it('sizes the run for a 2pp claim', () => {
    // 2.8016^2 * 0.0417 / 0.02^2 = 817.6 -> 818 cases, which is why the 1,534-case
    // dev split is the smallest split that can settle a 2pp question.
    expect(casesForEffect(share, 0.02)).toBe(818);
    expect(casesForEffect(share, 0.03)).toBe(364);
  });

  it('needs four times the cases to halve the effect', () => {
    // n is proportional to 1/effect^2, so halving the claim quadruples the run:
    // 818 -> 3,271 (the four is exact before the ceiling rounds it off).
    expect(casesForEffect(share, 0.01)).toBe(3271);
    expect(casesForEffect(share, 0.01) / casesForEffect(share, 0.02)).toBeCloseTo(4, 0);
    expect(casesForEffect(share, 0.015)).toBe(1454);
  });

  it('needs no cases when the arms never disagree', () => {
    expect(casesForEffect(0, 0.02)).toBe(0);
  });

  it('refuses an effect it cannot size', () => {
    expect(() => casesForEffect(share, 0)).toThrow(/effect/);
    expect(() => casesForEffect(share, -0.02)).toThrow(/effect/);
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

  it('pairs a question the split lists twice by occurrence, not by id', () => {
    // Mini-Dev lists questions 137 and 138 twice each. A second arm keyed by id makes both of the
    // first arm's rows look up the last answer recorded for that id, so a pass on one draw is
    // compared against a pass on the other and the discordant counts — the numbers McNemar and the
    // interval are computed from — move by up to one pair per duplicate.
    const repeated = summarise('r', [
      { id: '137', passed: false },
      { id: '137', passed: true },
    ]);
    const crossed = summarise('c', [
      { id: '137', passed: true },
      { id: '137', passed: false },
    ]);
    expect(compareArms(repeated, crossed)).toEqual({
      onlyFirst: 1,
      onlySecond: 1,
      both: 0,
      neither: 0,
      total: 2,
      delta: 0,
      discordant: 2,
    });
  });

  it('refuses arms that did not answer the same questions', () => {
    const twice = summarise('t', [{ id: '7', passed: true }, { id: '7', passed: true }]);
    const once = summarise('u', [{ id: '7', passed: true }]);
    // The first arm runs out of answers to consume…
    expect(() => compareArms(twice, once)).toThrow(/missing case/);
    // …and when it is the second arm that has the extra row, the pairing says so with the id
    // rather than leaving it to the arithmetic identity: the old loop never looked at the
    // leftovers, so an arm with an extra row failed as "pairs do not add up", which names neither
    // the arm nor the case.
    expect(() => compareArms(once, twice)).toThrow(/arm u is missing case 7/);
    // Equal counts and different questions: the queue runs dry inside the loop, so a shorter arm
    // cannot pass for a mismatched one just because the totals match.
    const elsewhere = summarise('o', [{ id: '8', passed: true }, { id: '8', passed: true }]);
    expect(() => compareArms(twice, elsewhere)).toThrow(/missing case 7/);
  });

  it('refuses a pair whose cells do not add up to the arm totals', () => {
    // This is the check that would have caught the duplicate-id defect: a pairing that loses or
    // double-counts a pair breaks `onlyFirst - onlySecond == passes(first) - passes(second)` while
    // `delta` stays right, which is why the broken table looked plausible. `summarise` cannot build
    // such an arm, but a hand-assembled or stale `ArmResult` can, so the identity is asserted here
    // rather than assumed.
    const counted = summarise('a', [{ id: '1', passed: true }, { id: '2', passed: false }]);
    const lying = { arm: 'b', total: 2, passed: 2, accuracy: 1, outcomes: counted.outcomes };
    expect(() => compareArms(counted, lying)).toThrow(/do not add up/);
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
