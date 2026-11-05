import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRATEGY,
  MIN_OBSERVATIONS,
  SELECTION_RULES,
  STRATEGIES,
  admissible,
  chooseStrategy,
  createObserver,
  probeProtocol,
  strategy,
  wilson,
} from '@agentix-e/nl2charts-ai';
import type { FormatProfile, StrategyName, Tally } from '@agentix-e/nl2charts-ai';

const profile = (index: 'always' | 'sometimes' | 'never'): FormatProfile => ({
  replies: 3,
  fenced: 'always',
  index,
  steps: 'always',
  named: 'always',
});

describe('the five bounded strategies', () => {
  it('prices every strategy in calls a user can count', () => {
    expect(STRATEGIES.map((entry) => [entry.name, entry.calls])).toEqual([
      ['single-lean', 1],
      ['single-full', 1],
      ['repeat-3', 3],
      ['aimed-3', 3],
      ['aimed-4', 4],
    ]);
  });

  it('charges for a selector exactly when the selector is a call', () => {
    // The invariant the retired boolean could not state: a rule reads the candidates the arm
    // already paid for, so its price is the candidate count, and the paid selector is the only
    // strategy whose calls exceed its candidates.
    for (const entry of STRATEGIES) {
      if (entry.selector === 'none') expect(entry.calls, entry.name).toBe(entry.candidates);
      else if (entry.selector === 'model') expect(entry.calls, entry.name).toBe(entry.candidates + 1);
      else expect(entry.calls, entry.name).toBe(entry.candidates);
    }
  });

  it('keeps the paid selector as a strategy, so the reading that retired it stays falsifiable', () => {
    const paid = STRATEGIES.filter((entry) => entry.selector === 'model').map((entry) => entry.name);
    expect(paid).toEqual(['aimed-4']);
    // The pair is one lever: same candidates, same card, same temperature, different chooser.
    const rule = STRATEGIES.find((entry) => entry.name === 'aimed-3');
    const model = STRATEGIES.find((entry) => entry.name === 'aimed-4');
    expect({ ...rule, name: '', calls: 0, selector: '' }).toEqual({ ...model, name: '', calls: 0, selector: '' });
  });

  it('names a rule that exists, on every strategy that names a rule', () => {
    for (const entry of STRATEGIES) {
      if (entry.selector === 'none' || entry.selector === 'model') continue;
      expect(SELECTION_RULES, entry.name).toContain(entry.selector);
    }
  });

  it('gives a one-candidate strategy nothing to choose among', () => {
    for (const entry of STRATEGIES) {
      if (entry.candidates === 1) expect(entry.selector, entry.name).toBe('none');
    }
    // The converse does not hold, and the test that said it did was wrong: `repeat-3` draws three
    // candidates and aggregates them by majority, which is a rule over results rather than over
    // statements and costs nothing — the same shape `aimed-3` has, with `modal` in place of
    // `shortest`. Both are `'none'` only if one reads the name as "no aggregation at all".
    const majority = STRATEGIES.filter((entry) => entry.candidates > 1 && entry.selector === 'none').map((entry) => entry.name);
    expect(majority).toEqual(['repeat-3']);
  });

  it('sends zero temperature exactly where one sample is the point', () => {
    expect(STRATEGIES.filter((entry) => entry.temperature === 0).map((entry) => entry.name)).toEqual([
      'single-lean',
      'single-full',
    ]);
    expect(STRATEGIES.filter((entry) => entry.temperature !== 0).map((entry) => entry.name)).toEqual([
      'repeat-3',
      'aimed-3',
      'aimed-4',
    ]);
  });

  it('looks up by name without a branch that can miss', () => {
    for (const entry of STRATEGIES) expect(strategy(entry.name)).toBe(entry);
  });
});

describe('layer 1: the first contact', () => {
  it('keeps the reply shape as free evidence when the endpoint answers', () => {
    const verdict = probeProtocol({ kind: 'answered', text: '```sql\nselect 1\n```' });
    expect(verdict.step).toBe('proceed');
    expect(verdict.omitTemperature).toBe(false);
    expect(verdict.shape?.fenced).toBe(true);
    expect(verdict.why).toContain('costs no call');
  });

  it.each([400, 422])('treats %i as a statement about the request, not the model', (status) => {
    const verdict = probeProtocol({ kind: 'refused', status });
    expect(verdict.step).toBe('retry-without-temperature');
    expect(verdict.omitTemperature).toBe(true);
    expect(verdict.shape).toBeUndefined();
    expect(verdict.why).toContain(String(status));
  });

  it.each([401, 403, 404, 429, 500])('stops on %i, where a retry is the wrong repair', (status) => {
    const verdict = probeProtocol({ kind: 'refused', status });
    expect(verdict.step).toBe('stop');
    expect(verdict.omitTemperature).toBe(false);
    expect(verdict.why).toContain(String(status));
  });
});

describe('layer 2: what the format profile leaves standing', () => {
  it('drops the paid selector when the model never writes a parseable choice', () => {
    expect(admissible(profile('never'))).toEqual(['single-lean', 'single-full', 'repeat-3', 'aimed-3']);
  });

  it('keeps the free selector whatever the model writes, because it reads no reply', () => {
    // The gate belongs to the call the strategy makes. `aimed-3` reads the executed candidates,
    // so a model that only ever answers in prose is a model `aimed-3` can still choose among.
    for (const index of ['never', 'sometimes', 'always'] as const) {
      expect(admissible({ ...profile(index), fenced: 'never', steps: 'never', named: 'never' }), index).toContain('aimed-3');
    }
  });

  it('keeps all five when the choice parses at least sometimes', () => {
    expect(admissible(profile('sometimes'))).toContain('aimed-4');
    expect(admissible(profile('always'))).toHaveLength(5);
  });

  it('never drops a reader that falls back instead of failing', () => {
    const noFence: FormatProfile = { ...profile('never'), fenced: 'never', steps: 'never', named: 'never' };
    expect(admissible(noFence)).toEqual(['single-lean', 'single-full', 'repeat-3', 'aimed-3']);
  });
});

describe('the interval the runtime decision shares with the report', () => {
  it('refuses to invent a bound from no observations', () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it('clamps both extremes inside [0, 1]', () => {
    expect(wilson(0, 10).low).toBe(0);
    expect(wilson(10, 10).high).toBe(1);
    expect(wilson(0, 10).high).toBeCloseTo(0.2775, 3);
    expect(wilson(10, 10).low).toBeCloseTo(0.7225, 3);
  });

  it('narrows as the same rate is observed more often', () => {
    const small = wilson(5, 10);
    const large = wilson(50, 100);
    expect(small.low).toBeLessThan(large.low);
    expect(small.high).toBeGreaterThan(large.high);
  });

  it('widens with a stricter z, which is what makes a switch conservative', () => {
    expect(wilson(5, 10, 2.58).low).toBeLessThan(wilson(5, 10, 1.96).low);
  });
});

describe('layer 3: which strategy the evidence separates', () => {
  it('refuses to decide below the observation floor', () => {
    const decision = chooseStrategy({ 'single-full': { passed: 3, total: 3 } });
    expect(decision.decided).toBe(false);
    expect(decision.strategy).toBe(DEFAULT_STRATEGY);
    expect(decision.reason).toContain(`3 of ${String(MIN_OBSERVATIONS)}`);
  });

  it('refuses to decide on no evidence at all', () => {
    const decision = chooseStrategy({});
    expect(decision.decided).toBe(false);
    expect(decision.strategy).toBe('single-full');
  });

  it('names the only measured arm instead of comparing it to an arm nobody ran', () => {
    const decision = chooseStrategy({ 'single-lean': { passed: 9, total: 12 } });
    expect(decision.decided).toBe(true);
    expect(decision.strategy).toBe('single-lean');
    expect(decision.reason).toContain('only measured arm');
  });

  it('keeps the incumbent when the intervals overlap', () => {
    const decision = chooseStrategy(
      { 'single-full': { passed: 6, total: 10 }, 'aimed-3': { passed: 7, total: 10 } },
      { incumbent: 'single-full' },
    );
    expect(decision.strategy).toBe('single-full');
    expect(decision.reason).toContain('overlaps');
  });

  it('keeps the incumbent when it is also the leader', () => {
    const decision = chooseStrategy(
      { 'single-full': { passed: 10, total: 12 }, 'single-lean': { passed: 4, total: 12 } },
      { incumbent: 'single-full' },
    );
    expect(decision.strategy).toBe('single-full');
    expect(decision.reason).toContain('leads on its own evidence (10/12)');
  });

  it('switches only when the challenger clears the incumbent', () => {
    const counts: Partial<Record<StrategyName, Tally>> = {
      'single-full': { passed: 2, total: 20 },
      'aimed-3': { passed: 18, total: 20 },
    };
    const decision = chooseStrategy(counts, { incumbent: 'single-full' });
    expect(decision.strategy).toBe('aimed-3');
    expect(decision.reason).toContain('separates');
  });

  it('leads with the best lower bound when the caller has no incumbent', () => {
    const decision = chooseStrategy({
      'single-lean': { passed: 1, total: 10 },
      'repeat-3': { passed: 9, total: 10 },
    });
    expect(decision.strategy).toBe('repeat-3');
  });

  it('honours an explicit floor, and a stricter z is what makes a switch conservative', () => {
    const counts: Partial<Record<StrategyName, Tally>> = {
      'single-full': { passed: 5, total: 8 },
      'aimed-3': { passed: 8, total: 8 },
    };
    expect(chooseStrategy(counts, { minTotal: 20 }).decided).toBe(false);
    const lenient = chooseStrategy(counts, { incumbent: 'single-full', z: 1 });
    const strict = chooseStrategy(counts, { incumbent: 'single-full', z: 3 });
    expect(lenient.strategy).toBe('aimed-3');
    expect(strict.strategy).toBe('single-full');
  });

  it('ignores an arm with no observations rather than dividing by zero', () => {
    const decision = chooseStrategy({
      'single-full': { passed: 8, total: 8 },
      'aimed-3': { passed: 0, total: 0 },
    });
    expect(decision.strategy).toBe('single-full');
    expect(decision.reason).toContain('leads on its own evidence (8/8)');
  });
});

describe('the online observer', () => {
  it('reports the incumbent until the eighth observation', () => {
    const observer = createObserver();
    for (let index = 0; index < 7; index += 1) observer.record('single-full', true);
    expect(observer.snapshot().decided).toBe(false);
    observer.record('single-full', true);
    const decision = observer.snapshot();
    expect(decision.decided).toBe(true);
    expect(decision.strategy).toBe('single-full');
  });

  it('counts both outcomes and hands out a copy of the tally', () => {
    const observer = createObserver();
    observer.record('aimed-3', true);
    observer.record('aimed-3', false);
    const counts = observer.counts();
    expect(counts['aimed-3']).toEqual({ passed: 1, total: 2 });
    counts['aimed-3']!.total === 99;
    expect(observer.counts()['aimed-3']?.total).toBe(2);
  });

  it('locks the decision it first reached, so a deployment cannot thrash', () => {
    const observer = createObserver({ incumbent: 'single-full' });
    for (let index = 0; index < 4; index += 1) {
      observer.record('single-full', false);
      observer.record('aimed-3', true);
    }
    const first = observer.snapshot();
    expect(first.strategy).toBe('aimed-3');
    observer.record('aimed-3', false);
    observer.record('aimed-3', false);
    observer.record('aimed-3', false);
    expect(observer.snapshot()).toBe(first);
  });

  it('re-decides when the caller asks it to', () => {
    const observer = createObserver({ incumbent: 'single-full', reevaluate: true });
    observer.record('single-full', true);
    for (let index = 0; index < 3; index += 1) observer.record('single-full', false);
    for (let index = 0; index < 4; index += 1) observer.record('aimed-3', true);
    expect(observer.snapshot().strategy).toBe('single-full');
    for (let index = 0; index < 12; index += 1) observer.record('aimed-3', true);
    expect(observer.snapshot().strategy).toBe('aimed-3');
  });

  it('passes an explicit floor and z through to the decision', () => {
    const observer = createObserver({ minTotal: 2, z: 1 });
    observer.record('repeat-3', true);
    observer.record('repeat-3', true);
    const decision = observer.snapshot();
    expect(decision.decided).toBe(true);
    expect(decision.strategy).toBe('repeat-3');
  });
});
