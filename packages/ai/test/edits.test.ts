/**
 * The product's ledger of edits, tested for the two things a ledger has to get right.
 *
 * A ledger is a claim about behaviour, so the only useful tests are the ones that make the claim
 * fail: a name that no longer resolves, a reading that is not a reading, an entry that is listed
 * and disabled (a switch nobody turns, which is the shape `recipe.ts` already refuses to carry).
 * What it deliberately does not test is the pipeline's application of the edits — that is the
 * `ask_question` suite's job, with a real engine, because "the edit runs" is a fact about a
 * statement and not about a constant.
 */
import { describe, expect, it } from 'vitest';
import { shippedEdit, SHIPPED_EDITS } from '../src/edits.js';

describe('SHIPPED_EDITS', () => {
  it('lists the pipeline order, because the order is load-bearing', () => {
    // The grounding edit rewrites literals, the cap strip rewrites a clause, and the null-order
    // guard reads the cap the strip may have removed. A list sorted alphabetically would still
    // describe the same three edits and would lose the one fact a reader needs: which one runs
    // first, and why the second cannot run after the third.
    expect(SHIPPED_EDITS.map((edit) => edit.rule)).toEqual(['ground-shipped', 'drop-unordered-limit', 'null-order']);
  });

  it('enables every edit it lists', () => {
    // An entry that is listed and disabled is a switch nobody turns — the shape `recipe.ts`
    // refuses to carry, and here it would be worse: the gate compares the *enabled* set with the
    // pricer's, so a disabled entry would silently drop a rule out of both lists at once.
    expect(SHIPPED_EDITS.every((edit) => edit.enabled)).toBe(true);
  });

  it('resolves a listed edit to itself', () => {
    for (const edit of SHIPPED_EDITS) expect(shippedEdit(edit.rule)).toBe(edit);
  });

  it('names the engine as the requirement of the one edit that needs a dialect', () => {
    // `needs` is not documentation: where an unknown value sorts is a property of the engine, so an
    // edit that guessed SQLite for an unnamed caller would create the defect it removes.
    expect(shippedEdit('null-order').needs).toBe('dialect');
    expect(shippedEdit('ground-shipped').needs).toBe('data');
    expect(shippedEdit('drop-unordered-limit').needs).toBe('nothing');
  });

  it('refuses a name it does not hold, and says which ones it does', () => {
    expect(() => shippedEdit('integer-division')).toThrow(/no shipped edit named 'integer-division'/);
    // The list is the useful half of the message: the caller mistyped a name it nearly knew.
    expect(() => shippedEdit('integer-division')).toThrow(/ground-shipped, drop-unordered-limit, null-order/);
  });
});
