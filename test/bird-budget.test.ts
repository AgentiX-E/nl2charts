/**
 * The clock, as a guard rather than as a tombstone.
 *
 * A reasoning model at two calls in flight spent **five hours** on one arm and produced nothing: the
 * job hit its 300-minute cap, GitHub marked it `cancelled`, and the artifact was 2,083 bytes of
 * nothing. The run had no way to say what it had learned, because the only thing it knew at minute
 * three hundred was how many cases it had finished — and nothing printed that either.
 *
 * Two instruments follow from that, and they are different instruments:
 *
 * - `progressLine` makes a long run **observable**: one line per case, so a reader can watch the
 *   rate, see a stall, and stop a run that is going nowhere without waiting for the cap.
 * - `budgetExhaustedMessage` makes it **instructive**: when a run is cut for time it says how many
 *   cases it got, what each one cost, how long the full split would have taken, and the `BIRD_LIMIT`
 *   that would have fitted. That is the number the next dispatch needs, and it is the number the
 *   five-hour run could not produce.
 *
 * The budget throws rather than publishing a partial table. A table is a claim about the sample the
 * run declared, and "137 of 496 cases" is a different population — the gate refuses a partial
 * artifact for the same reason. What a smaller run *can* claim is a pair against the anchor on the
 * questions both answered, which is `crossPair`'s job and needs an artifact of its own, not a
 * smuggled half of this one.
 */
import { describe, expect, it } from 'vitest';
import { budgetExhaustedMessage, parseBudgetMs, progressLine, suggestedLimit } from '../eval/bird/run.js';

describe('parseBudgetMs', () => {
  it('reads a positive millisecond count and treats absence as no budget', () => {
    expect(parseBudgetMs(undefined)).toBeUndefined();
    expect(parseBudgetMs('')).toBeUndefined();
    expect(parseBudgetMs('  ')).toBeUndefined();
    expect(parseBudgetMs('16200000')).toBe(16_200_000);
  });

  it('refuses a value that is not a budget instead of silently running without one', () => {
    // `BIRD_RUN_BUDGET_MS=abc` falling back to "no budget" would be a guard that turns itself off
    // on a typo, in the one place where being wrong costs hours.
    expect(() => parseBudgetMs('abc')).toThrow(/not a run budget/);
    expect(() => parseBudgetMs('0')).toThrow(/not a run budget/);
    expect(() => parseBudgetMs('-1')).toThrow(/not a run budget/);
    expect(() => parseBudgetMs('1.5')).toThrow(/not a run budget/);
  });
});

describe('suggestedLimit', () => {
  it('sizes a subset to three quarters of the budget, so the next run finishes with room', () => {
    // 100 cases in 10,000 s is 100 s a case. Three quarters of the budget is 7,500 s, which is 75
    // cases — deliberately short of the budget, because a run that stops at 99% of its clock has
    // learned nothing about how close it came.
    expect(suggestedLimit(10_000_000, 10_000_000, 100)).toBe(75);
  });

  it('rounds down, and never returns a subset of nothing', () => {
    expect(suggestedLimit(10_000_000, 10_000_000, 3)).toBe(2);
    // 1 case in a whole budget leaves one case: a suggestion of 0 is not a suggestion.
    expect(suggestedLimit(10_000_000, 10_000_000, 1)).toBe(1);
  });

  it('has no suggestion when no case finished, because there is no rate to extrapolate', () => {
    expect(suggestedLimit(10_000_000, 10_000_000, 0)).toBeUndefined();
    // A clock that has not moved is the same absence read from the other side: no elapsed time over
    // a positive case count is a rate of zero, and a subset sized from it would be infinite.
    expect(suggestedLimit(10_000_000, 0, 5)).toBeUndefined();
  });
});

describe('budgetExhaustedMessage', () => {
  it('states the cases done, the cost of each, the full-split projection and the limit that fits', () => {
    const message = budgetExhaustedMessage({
      arm: 'metadata+evidence',
      budgetMs: 10_000_000,
      elapsedMs: 10_000_000,
      casesDone: 100,
      total: 496,
      concurrency: 2,
    });
    expect(message).toContain('arm metadata+evidence: stopped after 100 of 496 cases');
    expect(message).toContain('100 s/case');
    expect(message).toContain('13.8 h');
    expect(message).toContain('BIRD_LIMIT=75');
    // The remaining cases are named as money not spent, the same way the failure breaker does it.
    expect(message).toContain('396 cases were not spent');
  });

  it('says which clock it is, because "the run stopped" and "the endpoint is slow" are different', () => {
    const message = budgetExhaustedMessage({
      arm: 'a',
      budgetMs: 3_600_000,
      elapsedMs: 3_600_500,
      casesDone: 40,
      total: 150,
      concurrency: 4,
    });
    expect(message).toContain('3600 s run budget');
    expect(message).toContain('concurrency 4');
    // Not an outage: nothing failed, the clock ran out. A reader who is told "stopped" without being
    // told why goes looking at the provider.
    expect(message).toContain('no call failed');
  });

  it('names the deadline and the retry budget when not one case finished', () => {
    // Zero cases in a whole budget is not a slow model, it is a shape: one case makes several
    // calls, each bounded by the per-call deadline, and the product is the thing to look at.
    const message = budgetExhaustedMessage({
      arm: 'metadata+evidence',
      budgetMs: 600_000,
      elapsedMs: 600_500,
      casesDone: 0,
      total: 150,
      concurrency: 2,
    });
    expect(message).toContain('not one case finished');
    expect(message).toContain('BIRD_LLM_TIMEOUT_MS');
    expect(message).not.toContain('BIRD_LIMIT=');
  });
});

describe('progressLine', () => {
  it('carries the rate so far, the case that just finished and the elapsed clock', () => {
    const line = progressLine({ index: 42, total: 150, passed: 16, elapsedMs: 756_000, caseMs: 7_200 });
    expect(line).toContain('[ 42/150]');
    expect(line).toContain('38.1%');
    expect(line).toContain('18.0 s/case');
    expect(line).toContain('case 7.2 s');
    expect(line).toContain('elapsed 756 s');
  });

  it('does not divide by a case count that is still zero', () => {
    // A line can be asked for before the first case lands, and it must still be a line.
    const line = progressLine({ index: 0, total: 150, passed: 0, elapsedMs: 5_000, caseMs: 0 });
    expect(line).toContain('[  0/150]');
    expect(line).toContain('n/a');
  });
});
