import { describe, expect, it } from 'vitest';
import {
  classifyCase,
  classifyPair,
  summarizeClassifications,
  type PairClassification,
  type PairSummary,
  type PairRow,
} from '../eval/bird/value-pair-harness.js';

/**
 * The harness reads a paired value-retrieval result (`pairValueRetrieval` from r215) against the
 * gold `table.column` set a question's SQL actually needs. These tests pin the classification,
 * not the retrieval: a hash embedding is a lexical stand-in and the numbers here are a harness
 * proof, never a priced semantic-gain reading.
 */

const pair = (gained: string[], lost: string[], shared: string[]) => ({ gained, lost, shared });

describe('classifyPair', () => {
  it('marks a gained field the gold needs as a confirmed gain', () => {
    const out = classifyPair(pair(['orders.status'], [], []), new Set(['orders.status']));
    expect(out.semanticGainedConfirmed).toEqual(['orders.status']);
    expect(out.semanticGainedSpurious).toEqual([]);
  });

  it('marks a gained field the gold does not need as spurious', () => {
    const out = classifyPair(pair(['orders.status'], [], []), new Set(['users.name']));
    expect(out.semanticGainedConfirmed).toEqual([]);
    expect(out.semanticGainedSpurious).toEqual(['orders.status']);
  });

  it('marks a lost field the gold needs as a confirmed loss', () => {
    const out = classifyPair(pair([], ['orders.status'], []), new Set(['orders.status']));
    expect(out.semanticLostConfirmed).toEqual(['orders.status']);
    expect(out.semanticLostSpurious).toEqual([]);
  });

  it('marks a lost field the gold does not need as spurious (denoising)', () => {
    const out = classifyPair(pair([], ['orders.status'], []), new Set(['users.name']));
    expect(out.semanticLostConfirmed).toEqual([]);
    expect(out.semanticLostSpurious).toEqual(['orders.status']);
  });

  it('splits a shared field by whether the gold needs it', () => {
    const out = classifyPair(pair([], [], ['a.x', 'b.y']), new Set(['a.x']));
    expect(out.bothCorrect).toEqual(['a.x']);
    expect(out.bothWrong).toEqual(['b.y']);
  });

  it('sorts every bucket stably so a reading is reproducible', () => {
    const out = classifyPair(pair(['z.c', 'a.b', 'm.d'], [], []), new Set(['z.c', 'a.b', 'm.d']));
    expect(out.semanticGainedConfirmed).toEqual(['a.b', 'm.d', 'z.c']);
  });

  it('deduplicates repeated fields inside one bucket', () => {
    const out = classifyPair(pair(['a.b', 'a.b', 'a.b'], [], []), new Set(['a.b']));
    expect(out.semanticGainedConfirmed).toEqual(['a.b']);
  });

  it('returns five empty buckets for an empty pair and empty gold', () => {
    const out = classifyPair(pair([], [], []), new Set());
    expect(out).toEqual({
      semanticGainedConfirmed: [],
      semanticGainedSpurious: [],
      semanticLostConfirmed: [],
      semanticLostSpurious: [],
      bothCorrect: [],
      bothWrong: [],
    });
  });
});

describe('classifyCase', () => {
  const field = (key: string) => {
    const [table, column] = key.split('.');
    return { table: table as string, column: column as string };
  };

  it('pairs two arms and classifies against gold in one step', () => {
    // exact finds a.x ; semantic finds a.x, b.y ; gold = a.x, b.y
    const row = classifyCase(1, [field('a.x')], [field('a.x'), field('b.y')], [field('a.x'), field('b.y')]);
    expect(row.questionId).toBe(1);
    expect(row.goldCount).toBe(2);
    expect(row.classification.bothCorrect).toEqual(['a.x']);
    expect(row.classification.semanticGainedConfirmed).toEqual(['b.y']);
    expect(row.classification.semanticLostConfirmed).toEqual([]);
  });

  it('uses deduplicated gold size as the coverage denominator', () => {
    const row = classifyCase(7, [], [], [field('a.x'), field('a.x'), field('a.x')]);
    expect(row.goldCount).toBe(1);
  });

  it('handles no hits and no gold without throwing', () => {
    const row = classifyCase(9, [], [], []);
    expect(row.classification).toEqual(classifyPair({ gained: [], lost: [], shared: [] }, new Set()));
    expect(row.goldCount).toBe(0);
  });
});

describe('summarizeClassifications', () => {
  const rowOf = (c: PairClassification, gold: number): PairRow => ({ questionId: 1, goldCount: gold, classification: c });

  it('computes confirmed net gain from the confirmed buckets', () => {
    const c = classifyPair(pair(['a.b', 'x.y'], ['m.n'], []), new Set(['a.b', 'x.y', 'm.n']));
    const s = summarizeClassifications([rowOf(c, 3)]);
    // gained-confirmed 2, lost-confirmed 1 -> net +1
    expect(s.confirmedGain).toBe(1);
    expect(s.semanticGainedConfirmed).toBe(2);
    expect(s.semanticLostConfirmed).toBe(1);
  });

  it('computes gold coverage for both arms from shared+gained / shared+lost', () => {
    // gold a,b,c ; shared a ; gained b (confirmed) ; lost c (confirmed)
    const c = classifyPair(pair(['b'], ['c'], ['a']), new Set(['a', 'b', 'c']));
    const s = summarizeClassifications([rowOf(c, 3)]);
    expect(s.semanticCoverage).toBeCloseTo(2 / 3);
    expect(s.exactCoverage).toBeCloseTo(2 / 3);
  });

  it('records spurious counts but never folds them into the gain', () => {
    const c = classifyPair(pair(['s1', 's2'], ['s3'], []), new Set());
    const s = summarizeClassifications([rowOf(c, 0)]);
    expect(s.semanticGainedSpurious).toBe(2);
    expect(s.semanticLostSpurious).toBe(1);
    expect(s.confirmedGain).toBe(0);
  });

  it('returns zero coverage and zero gain for no gold fields (no divide-by-zero)', () => {
    const c = classifyPair(pair(['a'], [], ['b']), new Set());
    const s = summarizeClassifications([rowOf(c, 0)]);
    expect(s.semanticCoverage).toBe(0);
    expect(s.exactCoverage).toBe(0);
    expect(s.confirmedGain).toBe(0);
  });

  it('aggregates across rows and counts gold fields', () => {
    const c1 = classifyPair(pair(['a.b'], [], []), new Set(['a.b']));
    const c2 = classifyPair(pair([], ['c.d'], []), new Set(['c.d']));
    const s = summarizeClassifications([rowOf(c1, 1), { ...rowOf(c2, 1), questionId: 2 }]);
    expect(s.questions).toBe(2);
    expect(s.goldFields).toBe(2);
    expect(s.confirmedGain).toBe(0); // +1 -1
    expect(s.semanticGainedConfirmed).toBe(1);
    expect(s.semanticLostConfirmed).toBe(1);
  });

  it('returns an all-zero summary for no rows', () => {
    const s = summarizeClassifications([]);
    expect(s).toEqual<PairSummary>({
      questions: 0,
      goldFields: 0,
      semanticGainedConfirmed: 0,
      semanticGainedSpurious: 0,
      semanticLostConfirmed: 0,
      semanticLostSpurious: 0,
      bothCorrect: 0,
      bothWrong: 0,
      confirmedGain: 0,
      semanticCoverage: 0,
      exactCoverage: 0,
    });
  });

  it('keeps coverage in [0,1] even with more hits than gold', () => {
    const c = classifyPair(pair(['a', 'b'], ['c'], ['a', 'b', 'c']), new Set(['a', 'b', 'c']));
    const s = summarizeClassifications([rowOf(c, 3)]);
    expect(s.semanticCoverage).toBeGreaterThanOrEqual(0);
    expect(s.semanticCoverage).toBeLessThanOrEqual(1);
    expect(s.exactCoverage).toBeGreaterThanOrEqual(0);
    expect(s.exactCoverage).toBeLessThanOrEqual(1);
  });
});
