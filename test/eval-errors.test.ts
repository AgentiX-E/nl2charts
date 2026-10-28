/**
 * The one place eval code turns a thrown value into a sentence.
 *
 * A promise can reject with anything, and the harnesses record the reason in an artifact a
 * human reads at one in the morning. The two branches here are the two shapes that reach
 * them: an `Error` and everything else.
 */
import { describe, expect, it } from 'vitest';
import { describeError } from '../eval/errors.js';

describe('describing what was thrown', () => {
  it('reads the message of an Error', () => {
    expect(describeError(new Error('the endpoint refused the third call'))).toBe('the endpoint refused the third call');
  });

  it('prints a string that was thrown as itself', () => {
    // `throw 'nope'` is legal JavaScript and a real thing a third-party client does.
    expect(describeError('nope')).toBe('nope');
  });

  it('prints an object that is not an Error without inventing a message', () => {
    expect(describeError({ code: 429 })).toBe('[object Object]');
    expect(describeError(undefined)).toBe('undefined');
  });
});
