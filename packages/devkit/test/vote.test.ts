import { describe, expect, it } from 'vitest';
import { majorityResult } from '../src/vote.js';

/**
 * Self-consistency without a model in the loop: given several answers, return the
 * one the most answers agree with. The equality test is supplied by the caller
 * because "same answer" means "same result set" here, not "same string".
 *
 * A tie is not broken by cleverness: the first candidate wins, which is the one
 * produced at the lowest temperature and is therefore the least surprising.
 */
describe('majority result', () => {
  it('returns the answer two of three candidates agree on', () => {
    const result = majorityResult(['a', 'b', 'a'], (left, right) => left === right);
    expect(result.winner).toBe('a');
    expect(result.agreement).toBeCloseTo(2 / 3);
    expect(result.groups).toBe(2);
  });

  it('returns the first candidate when every answer differs', () => {
    const result = majorityResult(['a', 'b', 'c'], (left, right) => left === right);
    expect(result.winner).toBe('a');
    expect(result.agreement).toBeCloseTo(1 / 3);
    expect(result.groups).toBe(3);
  });

  it('breaks a tie between two groups by the earlier candidate', () => {
    const result = majorityResult(['b', 'a', 'a', 'b'], (left, right) => left === right);
    expect(result.winner).toBe('b');
    expect(result.agreement).toBe(0.5);
  });

  it('treats an empty input as no winner rather than an error', () => {
    expect(majorityResult([], () => true)).toEqual({ winner: undefined, agreement: 0, groups: 0, tied: false });
  });

  it('uses the caller equality, not identity', () => {
    const result = majorityResult([{ rows: [1, 2] }, { rows: [1, 2] }, { rows: [3] }], (left, right) => left.rows[0] === right.rows[0]);
    expect(result.winner).toEqual({ rows: [1, 2] });
    expect(result.groups).toBe(2);
  });

  it('says when the vote did not decide, which is the only case a call can buy anything', () => {
    // Three distinct answers: the winner is the first candidate because of arrival order, and a
    // policy that reads `winner` cannot tell that from a majority of three.
    expect(majorityResult(['a', 'b', 'c'], (left, right) => left === right).tied).toBe(true);
    // Two answers with two votes each: the tie is real, and the winner is again the earliest.
    expect(majorityResult(['b', 'a', 'a', 'b'], (left, right) => left === right).tied).toBe(true);
    // A majority is not a tie even though other groups exist, and unanimity is not one either.
    expect(majorityResult(['a', 'b', 'a'], (left, right) => left === right).tied).toBe(false);
    expect(majorityResult(['a', 'a', 'a'], (left, right) => left === right).tied).toBe(false);
    expect(majorityResult(['a'], (left, right) => left === right).tied).toBe(false);
  });
});
