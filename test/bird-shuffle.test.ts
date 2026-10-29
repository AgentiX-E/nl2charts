import { describe, expect, it } from 'vitest';
import {
  ARMS,
  CROSS_SOURCES,
  ON_DEMAND_ARMS,
  PAIRS,
  resolveArm,
  shuffleByCase,
} from '../eval/bird/run.js';
import type { Arm } from '../eval/bird/run.js';

/**
 * Where a candidate sits is not a fact about the SQL, and until this lever existed no arm could
 * tell it apart from who wrote the candidate.
 *
 * `CROSS_SOURCES` lists the second model's statement first on every question, so every measured
 * arm holds authorship and position perfectly collinear: `@second` is returned 52.6% of the time
 * and that single number supports "the judge prefers this author" and "the judge prefers slot
 * zero" equally well. The two readings point at different next steps — a different judge versus a
 * different prompt layout — so the permutation has to be an arm, not a footnote.
 *
 * These tests pin the two properties that make it an experiment rather than a shuffle: the order
 * is a function of the question alone, and nothing else about the arm moves.
 */
const ITEMS = [0, 1, 2] as const;

describe('a permutation that carries no authorship', () => {
  it('is a permutation: same members, same references, no drop and no duplicate', () => {
    const candidates = [{ sql: 'a' }, { sql: 'b' }, { sql: 'c' }];
    const out = shuffleByCase(candidates, 1);
    expect(out).toHaveLength(candidates.length);
    expect(new Set(out).size).toBe(candidates.length);
    expect([...out].map((candidate) => candidate.sql).sort()).toEqual(['a', 'b', 'c']);
    // The runner takes the winner from this array by index, so the members must be the same
    // objects the vote saw, not copies of them.
    for (const candidate of out) expect(candidates).toContain(candidate);
  });

  it('leaves the caller’s array alone', () => {
    const candidates = [...ITEMS];
    shuffleByCase(candidates, 7);
    expect(candidates).toEqual([0, 1, 2]);
  });

  it('returns a set it cannot permute untouched', () => {
    const single = [{ sql: 'only' }];
    expect(shuffleByCase(single, 3)).toBe(single);
    expect(shuffleByCase([], 3)).toEqual([]);
  });

  it('is a function of the question id, not of the run', () => {
    const first = shuffleByCase(ITEMS, 1_234);
    for (let key = 1; key <= 500; key += 1) shuffleByCase(ITEMS, key);
    expect(shuffleByCase(ITEMS, 1_234)).toEqual(first);
    expect(shuffleByCase(ITEMS, '1234')).toEqual(shuffleByCase(ITEMS, 1234));
  });

  it('does not turn the order into a rotation', () => {
    // A rotation would move every candidate by the same amount, which is a systematic position
    // preference with a different shape. It is what a naive `id % n` implementation produces.
    let rotated = 0;
    for (let key = 1; key <= 400; key += 1) {
      const out = shuffleByCase(ITEMS, key);
      if (out[0] === 1 && out[1] === 2 && out[2] === 0) rotated += 1;
    }
    expect(rotated).toBeLessThan(200);
  });

  it('spreads every candidate over every slot', () => {
    // If one author kept slot zero, the arm would not separate position from authorship at all.
    const N = 3_000;
    const first = new Map<number, number>();
    const orders = new Map<string, number>();
    for (let key = 1; key <= N; key += 1) {
      const out = shuffleByCase(ITEMS, key);
      first.set(out[0] as number, (first.get(out[0] as number) ?? 0) + 1);
      orders.set(out.join(''), (orders.get(out.join('')) ?? 0) + 1);
    }
    expect([...first.keys()].sort()).toEqual([0, 1, 2]);
    expect(orders.size).toBe(6);
    // Binomial with n=3000, p=1/3: sd is 25.8, so +/-120 is beyond four sigma. A tighter bound
    // would be a coin flip on the hash, and a looser one would not notice a stalled slot.
    for (const count of first.values()) expect(count).toBeGreaterThan(N / 3 - 120);
    for (const count of first.values()) expect(count).toBeLessThan(N / 3 + 120);
    for (const count of orders.values()) expect(count).toBeGreaterThan(N / 6 - 100);
  });
});

describe('the shuffled arm differs from its parent by position alone', () => {
  const LEVERS = ['notes', 'evidence', 'repairs', 'linking', 'profile', 'definitions', 'focus', 'interpret', 'vote', 'demonstrations', 'select', 'values', 'plan', 'repairFeedback', 'shapeGuard', 'mixed', 'pairwise', 'sourcesVisible', 'judge', 'emptyRetry', 'decompose', 'samples', 'canonical', 'shuffle'] as const;

  const parent = resolveArm('select-cross') as Arm;
  const arm = resolveArm('select-cross-shuffled') as Arm;

  it('exists, and is dispatched rather than run on every push', () => {
    expect(arm).toBeDefined();
    expect(ON_DEMAND_ARMS['select-cross-shuffled']).toContain('second model');
    expect(ARMS.some((entry) => entry.name === 'select-cross-shuffled')).toBe(true);
  });

  it('changes nothing but `shuffle`', () => {
    const changed = LEVERS.filter((lever) => parent[lever] !== arm[lever]);
    expect(changed).toEqual(['shuffle']);
    expect(arm.shuffle).toBe(true);
    expect(parent.shuffle).toBeUndefined();
  });

  it('keeps the candidate set, the count and the cost of the parent', () => {
    expect(arm.mixed).toEqual(CROSS_SOURCES);
    expect(arm.mixed).toEqual(parent.mixed);
    expect(arm.vote).toBe(parent.vote);
    expect(arm.select).toBe(true);
    expect(arm.judge).toBeUndefined();
    expect(arm.canonical).toBeUndefined();
  });

  it('is registered as the pair that answers author versus position', () => {
    expect(PAIRS).toContainEqual(['select-cross', 'select-cross-shuffled']);
  });
});
