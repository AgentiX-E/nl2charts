/**
 * The ledger of the edits the pipeline applies, held to the pricer that justified each one.
 *
 * Two files state the same fact from opposite sides: `packages/ai/src/edits.ts` says what the
 * product does, and `eval/bird/rewrite.ts` says what the harness measured. Neither can import the
 * other's table, so the only thing that can hold them together is a test — and without one the
 * failure is silent in the direction that matters: an edit the product runs and nothing priced is
 * an edit whose effect appears only in a customer's accuracy, months later.
 *
 * The three checks below are the three ways the pair can disagree:
 *
 * 1. **A name.** The ledger names a rule; the pricer prints rule names. A rename on either side
 *    must be a red build, because the comparison is by name and a mismatch is otherwise invisible.
 * 2. **A requirement.** An edit that reads column values is inert without a reader. The ledger says
 *    `needs: 'data'`; the pricer says `needsDomains`. Those two fields are the same claim, and a
 *    ledger that understated it would make an inert edit look like a database with nothing to do.
 * 3. **A verdict.** Every non-ceiling rule decides: it ships, or it is refused with a reason. The
 *    pricer owns that decision and this file is where it is exercised on the real table rather than
 *    on a fixture.
 */
import { describe, expect, it } from 'vitest';
import { SHIPPED_EDITS, shippedEdit } from '@agentix-e/nl2charts-ai';
import { ledgerProblems, REWRITE_RULES } from '../eval/bird/rewrite.js';

describe('the shipped-edit ledger', () => {
  it('agrees with the pricer in both directions', () => {
    // The gate itself, on the real table: empty means every edit the product applies is priced and
    // every rule the pricer marks as the product's is applied.
    expect(ledgerProblems(REWRITE_RULES)).toEqual([]);
  });

  it('names rules the pricer prints, and no name twice', () => {
    const names = SHIPPED_EDITS.map((edit) => edit.rule);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      const priced = REWRITE_RULES.find((rule) => rule.name === name);
      expect(priced, `${name} is in the ledger and not in the pricer`).toBeDefined();
      expect(priced?.adoption, `${name} ships in the ledger and is ${String(priced?.adoption)} in the pricer`).toBe('product');
    }
  });

  it('states the same requirement the pricer does', () => {
    // `needs: 'data'` and `needsDomains: true` are one claim written twice, in the two packages that
    // need it. A ledger that understated the requirement would let the tool ship the edit with no
    // reader and report a rule that fired on nothing.
    for (const edit of SHIPPED_EDITS) {
      const priced = REWRITE_RULES.find((rule) => rule.name === edit.rule);
      expect(edit.needs === 'data', `${edit.rule} disagrees about what it needs`).toBe(priced?.needsDomains === true);
    }
  });

  it('quotes a reading a reader can go and check', () => {
    // Every entry says which corpus its numbers are on, because the next round's question is never
    // "is this edit on" but "on what grounds", and a ground that names no corpus is unrepeatable.
    for (const edit of SHIPPED_EDITS) {
      expect(edit.reading, `${edit.rule} quotes no corpus`).toMatch(/dev/i);
      expect(edit.reading, `${edit.rule} quotes no count`).toMatch(/\d/);
    }
  });

  it('refuses to answer for an edit it does not list', () => {
    // A lookup rather than a `find` at the call site: a tool that silently skipped an edit whose
    // name had changed would be a product running fewer rules than it says.
    expect(() => shippedEdit('drop-count-distinct')).toThrow(/no shipped edit named 'drop-count-distinct'/);
    expect(() => shippedEdit('drop-count-distinct')).toThrow(/ground-shipped/);
  });
});
