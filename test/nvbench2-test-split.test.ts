/**
 * The test split is a second instrument, and it has to be the same instrument twice.
 *
 * `metrics.json` holds dev as `arms` — fourteen readings that decide `DEFAULT_RULES`, one per rule set,
 * on the 750 questions the ablation was run over. The test split answers a different question: does the
 * tier that wins on dev also win on the 751 questions nobody tuned against. It cannot live in
 * `arms.readings`, because that table's highest reading is what a caller who names no rules gets
 * (`test/nvbench2-arm.test.ts` pins it), and a test-split reading folded into it would move the product
 * default onto a split the ablation never selected over.
 *
 * What these assertions hold is the pairing, not the score. A pair is only a pair if the two arms were
 * asked the same questions with the same instruction: one split, one rule list, one ask, one output cap,
 * one judge — and two models. Any other difference and the delta is measuring two things at once, which
 * is exactly what the first test-split attempt did (33.30 over 749 questions against 26.66 over 751,
 * with a 900-token cap for one arm and 2600 for the other).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Arm {
  readonly model: string;
  readonly run: number;
  readonly artifact: { readonly sha256: string };
  readonly questions: number;
  readonly failed: number;
  readonly 'f1@3': number;
  readonly 'hit@3': number;
  readonly yuan: number;
}

interface TestSplit {
  readonly split: string;
  readonly k: number;
  readonly ask: number;
  readonly maxTokens: number;
  readonly because: string;
  readonly arms: Readonly<Record<string, Arm>>;
  readonly pair: {
    readonly base: string;
    readonly arm: string;
    readonly k: number;
    readonly delta: number;
    readonly low: number;
    readonly high: number;
    readonly separated: boolean;
    readonly questions: number;
    readonly resamples: number;
  };
}

const metrics = JSON.parse(readFileSync(resolve(process.cwd(), 'eval/nvbench2/metrics.json'), 'utf8')) as {
  splits: Readonly<Record<string, { questions: number }>>;
  arms: { selected: { split: string }; readings: Readonly<Record<string, unknown>>; test: TestSplit };
};
const test = metrics.arms.test;

describe('the test split is recorded beside the ablation, not inside it', () => {
  it('lives under its own key, so the product default keeps being decided by dev', () => {
    // The link a test can hold: `DEFAULT_RULES` is read off `arms.readings`, whose entries are dev arms
    // for one rule set each. A test-split reading in that table would be the highest one and would take
    // the default with it.
    expect(metrics.arms.selected.split).toBe('dev');
    expect(Object.keys(metrics.arms.readings)).not.toContain('chat@test');
    expect(Object.keys(metrics.arms.readings)).not.toContain('reasoner@test');
    expect(test.split).toBe('test');
  });

  it('states why it exists, because a number without its question is a number to misquote', () => {
    expect(test.because.length).toBeGreaterThan(80);
    expect(test.because).toContain('test');
  });
});

describe('a pair is only a pair when the model is the only thing that differs', () => {
  const arms = Object.entries(test.arms);

  it('holds two arms and two models', () => {
    expect(arms).toHaveLength(2);
    expect(new Set(arms.map(([, arm]) => arm.model)).size).toBe(2);
    expect(test.pair.base).not.toBe(test.pair.arm);
    expect(Object.keys(test.arms)).toEqual(expect.arrayContaining([test.pair.base, test.pair.arm]));
  });

  it('asks both arms the same question set, with the same instruction and the same cap', () => {
    // `rules`, `ask`, `k` and `maxTokens` are one instrument's settings, and they are stated once for
    // the table rather than per arm precisely so they cannot drift apart per arm.
    for (const [, arm] of arms) {
      expect(arm.questions).toBe(metrics.splits[test.split]?.questions);
      expect(arm.failed).toBeGreaterThanOrEqual(0);
      expect(arm.failed).toBeLessThanOrEqual(arm.questions);
    }
  });

  it('keeps the cap in the group settings, where a second value would be visible', () => {
    // Two caps in one pair is the defect the first attempt had, and the fix is structural: the cap is
    // stated once. This asserts the field exists and is a whole number of tokens.
    expect(Number.isInteger(test.maxTokens)).toBe(true);
    expect(test.maxTokens).toBeGreaterThan(0);
    expect(test.ask).toBeGreaterThanOrEqual(test.k);
  });

  it('names the run and the hash of each artifact, so the delta can be re-derived', () => {
    for (const [name, arm] of arms) {
      expect(Number.isInteger(arm.run), `${name} names no run`).toBe(true);
      expect(arm.artifact.sha256, `${name} names no artifact digest`).toMatch(/^[0-9a-f]{64}$/);
      expect(arm.yuan).toBeGreaterThan(0);
    }
  });
});

describe('the recorded pair is the arithmetic of the two readings', () => {
  it('computes the delta from the arms it names', () => {
    const base = test.arms[test.pair.base];
    const arm = test.arms[test.pair.arm];
    expect(base, 'the pair names an arm the table does not hold').toBeDefined();
    expect(arm, 'the pair names an arm the table does not hold').toBeDefined();
    expect(test.pair.delta).toBeCloseTo((arm?.['f1@3'] ?? 0) - (base?.['f1@3'] ?? 0), 2);
  });

  it('carries the interval and its denominator, in the units the tool prints', () => {
    // `compare.ts` prints percent; `metrics.json` stores fractions everywhere else. The pair stores
    // fractions too — a table that mixes the two is a table whose columns cannot be added up.
    expect(Math.abs(test.pair.delta)).toBeLessThan(1);
    expect(test.pair.low).toBeLessThanOrEqual(test.pair.high);
    expect(test.pair.low).toBeLessThanOrEqual(test.pair.delta);
    expect(test.pair.high).toBeGreaterThanOrEqual(test.pair.delta);
    expect(test.pair.questions).toBe(test.arms[test.pair.arm]?.questions);
    expect(test.pair.resamples).toBeGreaterThanOrEqual(100);
    expect(test.pair.separated).toBe(test.pair.low > 0 || test.pair.high < 0);
  });

  it('says whether the gap survives the noise, which is the only thing it is allowed to say', () => {
    // A gap inside the interval is a finding about the instrument's resolution, not a reason to keep a
    // configuration: the A/A run on this split reads -0.08pp with a 95% interval of [-1.25, +1.08], so
    // anything below about 1.2pp is indistinguishable from a re-run of the same arm.
    if (!test.pair.separated) {
      expect(Math.abs(test.pair.delta)).toBeLessThan(0.0125);
    }
  });
});
