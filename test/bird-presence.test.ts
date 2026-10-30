/**
 * The rule the instruments share: a report that does not hold the arm is not a zero reading.
 *
 * The unit tests here are the three states the check can be in. The integration tests that
 * drive each instrument live in their own files; this one pins the message, because the
 * message is what a failing workflow prints and the only thing that tells the reader whether
 * the arm is missing or the file is.
 */
import { describe, expect, it } from 'vitest';
import { SHIPPED_ARM, reportArms, requireArm } from '../eval/bird/presence.js';

describe('the arms a report holds', () => {
  it('names each arm once, in a stable order', () => {
    // Two cases per arm is the normal shape — 498 questions, one row each — and the error
    // message should not read as if the report held a thousand arms.
    expect(reportArms([{ arm: 'vote' }, { arm: 'names' }, { arm: 'vote' }, { arm: 'names' }])).toEqual(['names', 'vote']);
  });

  it('ignores rows that carry no arm, rather than inventing one', () => {
    // A hand-written fixture or an artifact from a format that predates the field: the row
    // exists and does not say what it measured, which is not the same as measuring `undefined`.
    expect(reportArms([{}, { arm: undefined }, { arm: 'select' }])).toEqual(['select']);
  });

  it('is empty for an artifact with no cases', () => {
    expect(reportArms([])).toEqual([]);
  });
});

describe('the check an instrument runs before it measures', () => {
  it('passes when the arm is there', () => {
    expect(() => requireArm([{ arm: 'select' }], 'select', 'bird-eval.json')).not.toThrow();
  });

  it('names every arm the report does hold when the one asked for is missing', () => {
    // The reader's mistake is almost always the path: the tool was pointed at the artifact of
    // another run, and the arm exists in the run it was written for. Listing what is there
    // turns "no such arm" into "you are reading Tuesday's file".
    expect(() => requireArm([{ arm: 'names' }, { arm: 'vote' }], 'select', 'bird-eval.json')).toThrow(
      'bird-eval.json has no arm select; it holds names, vote',
    );
  });

  it('separates a missing input from a measured zero', () => {
    // The distinction the whole check exists for: zero cases is "nobody rendered a prompt",
    // not "the prompt has no card", and only the second is a reading.
    expect(() => requireArm([], 'select', 'bird-eval.json')).toThrow(
      'bird-eval.json holds no cases, so arm select cannot be measured',
    );
  });

  it('defaults to the arm the chain runs, not to a dispatched-only one', () => {
    expect(SHIPPED_ARM).toBe('metadata+evidence');
  });
});
