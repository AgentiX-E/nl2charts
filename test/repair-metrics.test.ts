import { describe, expect, it } from 'vitest';
import { ppPerExtraCall, repairFunnel } from '../eval/bird/metrics.js';

describe('the repair funnel', () => {
  const cases = [
    { attempts: 1, passed: true, failures: [] },
    { attempts: 1, passed: false, failures: [] },
    { attempts: 2, passed: true, failures: ['binding'] },
    { attempts: 3, passed: true, failures: ['binding', 'syntax'] },
    { attempts: 3, passed: false, failures: ['binding', 'binding'] },
    { attempts: 4, passed: false, failures: ['syntax', 'syntax', 'syntax'] },
  ];

  it('separates first-pass work from work the repair did', () => {
    const funnel = repairFunnel(cases);
    expect(funnel.total).toBe(6);
    expect(funnel.firstPass).toBe(1);
    // The case that ran once and answered wrong: the loop cannot reach it, and leaving
    // it out made the funnel's parts stop adding up to its total.
    expect(funnel.ranOnceWrong).toBe(1);
    expect(funnel.firstPass + funnel.ranOnceWrong + funnel.repaired).toBe(funnel.total);
    expect(funnel.repaired).toBe(4);
    expect(funnel.fixedByRepair).toBe(2);
    expect(funnel.stillFailing).toBe(2);
    // The distinction accuracy alone cannot make: the arm answers 3 of 6, and only two
    // of those three needed the loop at all.
    expect(funnel.accuracy).toBeCloseTo(3 / 6, 10);
    expect(funnel.firstPassRate).toBeCloseTo(1 / 6, 10);
    expect(funnel.repairSuccessRate).toBeCloseTo(2 / 4, 10);
  });

  it('counts each repaired case once, under the class that started it', () => {
    const funnel = repairFunnel(cases);
    const binding = funnel.byClass.find((entry) => entry.failureClass === 'binding');
    const syntax = funnel.byClass.find((entry) => entry.failureClass === 'syntax');
    // Three cases began with a binding failure: 2 attempts, 3 attempts (fixed), and
    // 3 attempts (not fixed). The third attempt of the fourth case is a syntax
    // failure, but that case began as binding, so it is counted there only.
    expect(binding).toEqual({ failureClass: 'binding', cases: 3, fixed: 2, remaining: 1 });
    expect(syntax).toEqual({ failureClass: 'syntax', cases: 1, fixed: 0, remaining: 1 });
  });

  it('separates a repaired statement that runs from one that is right', () => {
    // On BIRD, eight of nine repaired cases ended executable and wrong. Counting them
    // as "still failing" alone hides what the loop actually produced.
    const funnel = repairFunnel([
      { attempts: 2, passed: true, failures: ['binding'] },
      { attempts: 2, passed: false, failures: ['binding'] },
      { attempts: 2, passed: false, failures: ['syntax'], errorKind: 'execution' },
      { attempts: 2, passed: false, failures: ['guard'], errorKind: 'guard' },
    ]);
    expect(funnel.repaired).toBe(4);
    expect(funnel.fixedByRepair).toBe(1);
    expect(funnel.stillFailing).toBe(3);
    // Two of the three failures still had no statement the engine would run.
    expect(funnel.stillNotExecuting).toBe(2);
  });

  it('prices the loop in model calls', () => {
    const funnel = repairFunnel(cases);
    // (1+1+2+3+3+4)/6 = 2.33 attempts, of which one is the first.
    expect(funnel.meanAttempts).toBeCloseTo(14 / 6, 10);
    expect(funnel.extraCallsPerCase).toBeCloseTo(14 / 6 - 1, 10);
    // Its ceiling: four of six cases failed at execution and could in principle be
    // repaired. Two of them were.
    expect(funnel.repairableShare).toBeCloseTo(4 / 6, 10);
  });

  it('reports zero rather than NaN when nothing was repaired', () => {
    const funnel = repairFunnel([{ attempts: 1, passed: true }]);
    expect(funnel.repaired).toBe(0);
    expect(funnel.repairSuccessRate).toBe(0);
    expect(funnel.extraCallsPerCase).toBe(0);
    expect(Number.isNaN(funnel.meanAttempts)).toBe(false);
  });

  it('reports zero rather than NaN on an empty sample', () => {
    const funnel = repairFunnel([]);
    expect(funnel.accuracy).toBe(0);
    expect(funnel.meanAttempts).toBe(0);
    expect(funnel.byClass).toEqual([]);
  });

  it('sorts classes by how often they started a repair', () => {
    const funnel = repairFunnel([
      { attempts: 2, passed: true, failures: ['syntax'] },
      { attempts: 2, passed: true, failures: ['binding'] },
      { attempts: 2, passed: true, failures: ['binding'] },
    ]);
    expect(funnel.byClass[0]?.failureClass).toBe('binding');
  });
});

describe('price per extra call', () => {
  it('divides the gain by what it cost', () => {
    expect(ppPerExtraCall(3, 1)).toBeCloseTo(3, 10);
    expect(ppPerExtraCall(3, 3)).toBeCloseTo(1, 10);
  });

  it('has no answer when the mechanism is free', () => {
    // Undefined is the honest value: dividing by zero would rank a free mechanism
    // above every paid one on a number nobody can interpret.
    expect(ppPerExtraCall(3, 0)).toBeUndefined();
  });
});
