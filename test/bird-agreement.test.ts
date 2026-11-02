/**
 * The one fact the selector was never shown: which candidates agree.
 *
 * The selector receives each candidate's statement, row count, column count and the first
 * three rows — and three hundred characters of a wide result cannot establish that two result
 * sets are the same set. So the fact a 2+1 candidate pool is built on (two authors, or two
 * prompts, one duplicate answer) was the fact the selector had to infer. `select-cross` says
 * what that costs: on 20 of the 22 questions its reasoner slot added to the ceiling, the
 * correct answer was the lone dissenter and the two agreeing candidates were both wrong.
 *
 * These tests pin the definition of a mark, the property that the prompt of every other arm is
 * untouched by it, and the shape of the two arms that show it.
 */
import { describe, expect, it } from 'vitest';
import { buildSelectionPrompt } from '@agentix-e/nl2charts-ai';
import type { Candidate } from '@agentix-e/nl2charts-ai';
import { ARMS, ON_DEMAND_ARMS, agreementMarks } from '../eval/bird/run.js';
import type { Arm } from '../eval/bird/run.js';

/** A result set, as the runner holds it: rows of values, no column names. */
const rows = (...values: number[]): readonly (readonly unknown[])[] => values.map((value) => [value]);

describe('marking which candidates returned the same rows', () => {
  it('marks nothing when every result is different', () => {
    expect(agreementMarks([rows(1), rows(2), rows(3)])).toEqual([undefined, undefined, undefined]);
  });

  it('points at the earliest member of each group', () => {
    // The pointer always looks backwards, which is what makes the marks a partition: exactly
    // one member of each group has no mark, so the number of distinct results is countable
    // from the marks alone.
    expect(agreementMarks([rows(1), rows(2), rows(1)])).toEqual([undefined, undefined, 1]);
  });

  it('marks every later member of a unanimous set with the first', () => {
    expect(agreementMarks([rows(7), rows(7), rows(7)])).toEqual([undefined, 1, 1]);
  });

  it('reads two groups in five candidates without comparing every pair', () => {
    // A five-sample arm is in the catalogue, and a pairwise implementation would be quadratic
    // in a place where three candidates hid the difference.
    expect(agreementMarks([rows(1), rows(2), rows(1), rows(2), rows(3)])).toEqual([
      undefined,
      undefined,
      1,
      2,
      undefined,
    ]);
  });

  it('treats row order as immaterial, because the judge does', () => {
    // `resultKey` sorts, so `[[1],[2]]` and `[[2],[1]]` are the same answer. A mark computed
    // on the raw sequence would tell the selector two identical results differ, on the one
    // definition the score is already using.
    const ascending: readonly (readonly unknown[])[] = [[1], [2]];
    const descending: readonly (readonly unknown[])[] = [[2], [1]];
    expect(agreementMarks([ascending, descending])).toEqual([undefined, 1]);
  });

  it('separates results of the same width but different values', () => {
    expect(agreementMarks([[[1, 2]], [[1, 3]]])).toEqual([undefined, undefined]);
  });

  it('separates results of different widths even when the values match', () => {
    expect(agreementMarks([[[1]], [[1, 1]]])).toEqual([undefined, undefined]);
  });

  it('counts two empty results as the same result, which the row count makes honest', () => {
    // `resultKey` maps every empty result to the same symbol, so two candidates that returned
    // nothing are marked as agreeing — and they did agree. The mark is not misleading because
    // the row count sits beside it, and because the rule it triggers says agreement is not
    // proof. The arms that drop empties before selecting never produce the mark at all.
    expect(agreementMarks([[], []])).toEqual([undefined, 1]);
  });

  it('is empty for an empty candidate list', () => {
    expect(agreementMarks([])).toEqual([]);
  });
});

describe('the arms that show the marks', () => {
  const armNamed = (name: string): Arm => ARMS.find((arm) => arm.name === name) as Arm;

  it('differs from the adopted arm by the marks and by nothing else', () => {
    // One lever, or the delta prices two things. Everything but the flag and the name has to
    // be identical: same prompts, same candidate count, same four calls.
    const parent = armNamed('select-mixed');
    const child = armNamed('select-mixed+agree');
    expect({ ...child, agreement: undefined, name: parent.name }).toEqual(parent);
    expect(child.agreement).toBe(true);
    expect(child.vote).toBe(3);
  });

  it('differs from the cross arm by the marks and by nothing else', () => {
    const parent = armNamed('select-cross');
    const child = armNamed('select-cross-agree');
    expect({ ...child, agreement: undefined, name: parent.name }).toEqual(parent);
    expect(child.agreement).toBe(true);
  });

  it('runs on demand, with a stated reason, on both pools', () => {
    // The catalogue test in `bird-arms.test.ts` files every arm as default or on demand; this
    // one pins that the reason for these two names the lever rather than repeating a template.
    expect(ON_DEMAND_ARMS['select-mixed+agree']).toContain('agreement');
    expect(ON_DEMAND_ARMS['select-cross-agree']).toContain('marks');
    expect(ON_DEMAND_ARMS['select-mixed+agree']?.length).toBeGreaterThan(40);
    expect(ON_DEMAND_ARMS['select-cross-agree']?.length).toBeGreaterThan(40);
  });

  it('leaves every other selecting arm unmarked', () => {
    // The blast radius of a flag read in the wrong place: an arm whose selector prompt grows
    // the block would stop being comparable with the reading it was measured at.
    const marked = ARMS.filter((arm) => arm.agreement === true).map((arm) => arm.name);
    expect(marked).toEqual(['select-mixed+agree', 'select-cross-agree']);
  });
});

describe('what the selector reads', () => {
  /** The three shapes a 2+1 pool can produce, as the runner hands them to the prompt. */
  const candidates: Candidate[] = [
    { sql: 'SELECT COUNT(*) FROM orders', rows: 500, columns: 1, preview: '[[500]]' },
    { sql: 'SELECT COUNT(*) FROM orders WHERE 1', rows: 500, columns: 1, preview: '[[500]]', agreesWith: 1 },
    { sql: 'SELECT COUNT(*) FROM orders WHERE status = "done"', rows: 120, columns: 1, preview: '[[120]]' },
  ];

  it('names the dissenter rather than leaving it to be inferred from previews', () => {
    const prompt = buildSelectionPrompt('How many orders were completed?', candidates);
    expect(prompt).toContain('These 3 candidates returned 2 distinct results');
    expect(prompt).toContain('same result as candidate 1');
    // The candidate that agrees with nobody is the one the rule is about, and it carries no
    // mark — the absence is the signal, which is why the header counts distinct results.
    expect(prompt).not.toContain('same result as candidate 3');
  });
});
