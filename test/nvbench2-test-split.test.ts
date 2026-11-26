/**
 * The test split is a second instrument, and every gap it reports names the one thing it varied.
 *
 * `metrics.json` holds dev as `arms` — fourteen readings that decide `DEFAULT_RULES`, one per rule set,
 * on the 750 questions the ablation was run over. The test split answers a different question: what
 * happens on the 751 questions nobody tuned against. It cannot live in `arms.readings`, because that
 * table's highest reading is what a caller who names no rules gets (`test/nvbench2-arm.test.ts` pins
 * it), and a test-split reading folded into it would move the product default onto a split the
 * ablation never selected over.
 *
 * Four dispatches, four pairs, and each pair declares what it varies. That declaration is the whole
 * argument: a gap is a claim about a cause only when one thing differs, and the first test-split
 * attempt varied three at once (33.30 over 749 questions against 26.66 over 751, one arm at a 900-token
 * cap and one at 2600). So this file does not check the scores — it checks that `varies` is true of the
 * arms the pair names, that the interval is the arithmetic of those arms, and that nothing is allowed
 * to call itself a finding while sitting inside the instrument's own resolution.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Arm {
  readonly model: string;
  readonly rules: readonly string[];
  readonly maxTokens: number;
  readonly run: number;
  readonly artifact: { readonly sha256: string };
  readonly questions: number;
  readonly failed: number;
  readonly truncated: number;
  readonly 'f1@3': number;
  readonly 'hit@3': number;
  readonly yuan: number;
}

interface Pair {
  readonly base: string;
  readonly arm: string;
  /** The single thing the two arms are allowed to differ in. */
  readonly varies: 'cap' | 'rules' | 'model' | 'tier';
  readonly question: string;
  readonly k: number;
  readonly delta: number;
  readonly low: number;
  readonly high: number;
  readonly separated: boolean;
  readonly questions: number;
  readonly resamples: number;
}

interface TestSplit {
  readonly split: string;
  readonly k: number;
  readonly ask: number;
  readonly because: string;
  readonly resolution: number;
  readonly resolutionBecause: string;
  readonly arms: Readonly<Record<string, Arm>>;
  readonly pairs: Readonly<Record<string, Pair>>;
}

const metrics = JSON.parse(readFileSync(resolve(process.cwd(), 'eval/nvbench2/metrics.json'), 'utf8')) as {
  splits: Readonly<Record<string, { questions: number }>>;
  arms: {
    selected: { split: string };
    readings: Readonly<Record<string, unknown>>;
    layers: { chat: { rules: readonly string[] }; reasoning: { rules: readonly string[] } };
    test: TestSplit;
  };
};
const test = metrics.arms.test;
const pairEntries = Object.entries(test.pairs);
const f1 = (name: string): number => test.arms[name]?.['f1@3'] ?? Number.NaN;

describe('the test split is recorded beside the ablation, not inside it', () => {
  it('lives under its own key, so the product default keeps being decided by dev', () => {
    // The link a test can hold: `DEFAULT_RULES` is read off `arms.readings`, whose entries are dev arms
    // for one rule set each. A test-split reading in that table would be the highest one and would take
    // the default with it.
    expect(metrics.arms.selected.split).toBe('dev');
    for (const name of Object.keys(test.arms)) {
      expect(Object.keys(metrics.arms.readings)).not.toContain(name);
    }
    expect(test.split).toBe('test');
  });

  it('states why it exists, because a number without its question is a number to misquote', () => {
    expect(test.because.length).toBeGreaterThan(80);
    expect(test.because).toContain('test');
    for (const [name, pair] of pairEntries) {
      expect(pair.question, `${name} carries no question`).toContain('?');
      expect(pair.question.length, `${name} asks nothing`).toBeGreaterThan(60);
    }
  });
});

describe('a pair is only a pair when the thing it names is the only thing that differs', () => {
  it('holds four pairs, each naming two arms the table holds and a different free variable', () => {
    expect(pairEntries.map(([name]) => name).sort()).toEqual(['aa', 'decision', 'mechanism', 'selection']);
    expect(new Set(pairEntries.map(([, p]) => p.varies)).size).toBe(4);
    for (const [name, pair] of pairEntries) {
      expect(test.arms[pair.base], `${name} names a base the table does not hold`).toBeDefined();
      expect(test.arms[pair.arm], `${name} names an arm the table does not hold`).toBeDefined();
      expect(pair.base).not.toBe(pair.arm);
    }
  });

  it('varies one field and holds the rest, checked against the arms rather than the prose', () => {
    // `varies` is the assertion. Whatever a pair names is the field the two arms must differ in — and
    // every other field of the instrument must be equal, or the delta is two changes at once.
    // `tier` is the one declaration that covers two fields at once, and deliberately: a tier is a model
    // and the rules that model ships with, so holding the rules equal would leave it asking the
    // mechanism question again (`decision` would collapse into `mechanism`).
    const same = (a: Arm, b: Arm, except: Pair['varies']): void => {
      if (except !== 'model' && except !== 'tier') expect(a.model, `model differs in a ${except} pair`).toBe(b.model);
      if (except !== 'rules' && except !== 'tier') {
        expect(a.rules, `rules differ in a ${except} pair`).toEqual(b.rules);
      }
    };
    // A cap may differ outside an A/A only when the arm at the lower cap never reached it: then the cap
    // is not part of the experiment and the two arms answered the same question. The first test-split
    // attempt failed this in the other direction — 900 tokens against 2600 where the 900 was binding —
    // and the `aa` pair is what licenses the crossover here (chat moved -0.08 between those two caps
    // with nothing truncated at either).
    const cap = (a: Arm, b: Arm): void => {
      const [lower, higher] = [a, b].sort((x, y) => x.maxTokens - y.maxTokens) as [Arm, Arm];
      if (lower.maxTokens === higher.maxTokens) return;
      expect(lower.truncated, 'the arm at the lower cap truncated, so the caps are not comparable').toBe(0);
    };
    for (const [name, pair] of pairEntries) {
      const base = test.arms[pair.base] as Arm;
      const arm = test.arms[pair.arm] as Arm;
      same(base, arm, pair.varies);
      cap(base, arm);
      if (pair.varies === 'cap') expect(base.maxTokens).not.toBe(arm.maxTokens);
      if (pair.varies === 'rules') expect(base.rules).not.toEqual(arm.rules);
      if (pair.varies === 'model') expect(base.model).not.toBe(arm.model);
      if (pair.varies === 'tier') expect(arm.model).not.toBe(base.model);
      expect(pair.k, `${name} is read at a different width`).toBe(test.k);
    }
  });

  it('keeps every arm on one question set, one ask and one judge', () => {
    // `k` and `ask` are stated once for the table rather than per arm precisely so they cannot drift.
    for (const [name, arm] of Object.entries(test.arms)) {
      expect(arm.questions, `${name} asked another split`).toBe(metrics.splits[test.split]?.questions);
      expect(arm.failed, `${name} failed more questions than it asked`).toBeGreaterThanOrEqual(0);
      expect(arm.failed).toBeLessThanOrEqual(arm.questions);
      expect(Number.isInteger(arm.run), `${name} names no run`).toBe(true);
      expect(arm.artifact.sha256, `${name} names no artifact digest`).toMatch(/^[0-9a-f]{64}$/);
      expect(arm.yuan, `${name} has no bill`).toBeGreaterThan(0);
    }
    expect(test.ask).toBeGreaterThanOrEqual(test.k);
  });

  it('gives an A/A pair arms that differ only in a cap neither one hit', () => {
    // The reason a cap difference is not a product difference here: neither arm truncated a reply, so
    // the cap never bound and the two dispatches asked the identical question. If one of them starts
    // truncating, the A/A becomes two experiments and the resolution below stops being measurable.
    const aa = test.pairs.aa as Pair;
    expect(aa.varies).toBe('cap');
    expect(test.arms[aa.base]?.truncated).toBe(0);
    expect(test.arms[aa.arm]?.truncated).toBe(0);
    expect(test.arms[aa.base]?.maxTokens).not.toBe(test.arms[aa.arm]?.maxTokens);
  });

  it('puts a tier pair at the rules that tier ships, so the comparison is the product', () => {
    // `arms.layers` is what the dev ablation decided each tier sends. A `tier` pair that does not use
    // those lists is comparing two configurations nobody deploys — which is exactly how the first
    // version of this file reported 6.63 points for a tier that is worth 2.71 as shipped.
    const decision = test.pairs.decision as Pair;
    expect(decision.varies).toBe('tier');
    // Whichever side of the pair carries the reasoning model is the one that has to carry its rules.
    const sides = [decision.base, decision.arm].map((name) => test.arms[name] as Arm);
    const reasoning = sides.find((arm) => arm.model.includes('reasoner')) as Arm;
    const chat = sides.find((arm) => !arm.model.includes('reasoner')) as Arm;
    expect([...chat.rules].sort()).toEqual([...metrics.arms.layers.chat.rules].sort());
    expect([...reasoning.rules].sort()).toEqual([...metrics.arms.layers.reasoning.rules].sort());
  });
});

describe('the recorded pairs are the arithmetic of the arms they name', () => {
  it('computes each delta from its own two readings', () => {
    for (const [name, pair] of pairEntries) {
      expect(pair.delta, `${name} does not equal its arms`).toBeCloseTo(f1(pair.arm) - f1(pair.base), 4);
    }
  });

  it('carries the interval and its denominator, in the units the rest of the file uses', () => {
    // `compare.ts` prints percent; `metrics.json` stores fractions everywhere else. The pairs store
    // fractions too — a table that mixes the two is a table whose columns cannot be added up.
    for (const [name, pair] of pairEntries) {
      expect(Math.abs(pair.delta), `${name} is in the wrong units`).toBeLessThan(1);
      expect(pair.low, `${name} has no interval`).toBeLessThanOrEqual(pair.high);
      expect(pair.low).toBeLessThanOrEqual(pair.delta);
      expect(pair.high).toBeGreaterThanOrEqual(pair.delta);
      expect(pair.questions).toBe(test.arms[pair.arm]?.questions);
      expect(pair.resamples).toBeGreaterThanOrEqual(100);
      expect(pair.separated, `${name} disagrees with its own interval`).toBe(pair.low > 0 || pair.high < 0);
    }
  });

  it('defines the resolution as what the A/A pair actually did, not as a round number', () => {
    // The resolution is not chosen; it is the widest excursion one arm has produced against itself on
    // this split. Reading it off the A/A pair keeps it a measurement, and the sign-agnostic form is
    // what lets it be compared to a delta of either sign.
    const aa = test.pairs.aa as Pair;
    expect(test.resolution).toBeCloseTo(Math.max(Math.abs(aa.low), Math.abs(aa.high)), 4);
    expect(test.resolutionBecause).toContain('aa');
    expect(aa.separated).toBe(false);
  });

  it('will not call a finding anything that sits inside the instrument', () => {
    // Two claims, in order: a gap has to be wider than the A/A movement to be a finding at all, and its
    // pessimistic end has to clear that movement for the finding to survive a pessimistic reading. The
    // second is stricter, and it is the one a deployment decision needs.
    for (const [name, pair] of pairEntries) {
      if (name === 'aa') continue;
      expect(Math.abs(pair.delta), `${name} is inside the resolution`).toBeGreaterThan(test.resolution);
    }
    const clears = pairEntries.filter(([, p]) => p.low > test.resolution);
    expect(clears.map(([name]) => name).sort()).toEqual(['mechanism', 'selection']);
    // `decision` clears the first bar and not the second: its delta (2.71) is more than twice the
    // resolution, and its lower bound (0.74) is under it. That is why the shipped default stays on the
    // chat tier while the reasoning tier stays available — the pessimistic end of the tier's advantage
    // is indistinguishable from a re-run of chat.
    const decision = test.pairs.decision as Pair;
    expect(Math.abs(decision.delta)).toBeGreaterThan(test.resolution);
    expect(decision.low).toBeLessThan(test.resolution);
  });
});
