/**
 * The edits the product applies to a statement, named as one ledger.
 *
 * `recipe.ts` did this for the prompt, after the best combination the experiment had found turned
 * out not to be the prompt the product sent. The same seam exists one step later in the pipeline,
 * where three edits happen to a statement *after* the model has written it — and each of them was
 * wired by hand, in a different round, with its reading recorded in prose and nowhere a gate could
 * read it.
 *
 * The cost of that shape is not hypothetical. Round 203 shipped the grounding edit by handing
 * `readColumnValues` to the pipeline from the tool, and whether it runs is a literal in
 * `packages/mcp/src/ask.ts`; nothing connects that literal to the number that justified it. So the
 * edit could stop being measured and keep running, or be measured again and keep not running. Those
 * are the two failures the recipe layer has already paid for once, and the reason this file exists
 * rather than a fourth comment saying "shipped in round N".
 *
 * ## What a name buys
 *
 * Each entry names the *pricer's* rule, not a description of the edit: `eval/bird/rewrite.ts`
 * prints those names, and `test/bird-rules-ledger.test.ts` requires the two lists to agree in both
 * directions — every edit enabled here has a rule marked as the product's, and every rule marked as
 * the product's is enabled here. An edit with no price and a price with no edit are both refusals,
 * and the second one is the state a rule reaches by winning enough to look adopted: `drop-count-
 * distinct` wins 33 and loses 18 on dev, and for two rounds the pricer's own union printed it as
 * part of what a pipeline would recover.
 *
 * ## What a reading buys
 *
 * Nothing in this file is a threshold. Each `reading` is the measurement that put the edit in the
 * pipeline, quoted with its split and its counts, because the next round's question is never "is
 * this edit on" but "on what grounds" — and a grounds that lives only in a commit message is a
 * grounds that the next refactor deletes without noticing.
 */
export interface ShippedEdit {
  /**
   * The rule name the pricer prints, so the two lists compare by name and not by idea.
   *
   * Names rather than identifiers on purpose: the pricer is a script, this is a package, and the
   * only thing they can share without a dependency is the string a report prints. A rename on
   * either side is a red build rather than a silent divergence.
   */
  readonly rule: string;
  /**
   * Whether the pipeline applies it.
   *
   * The pricer marks the same rule `adoption: 'product'`; the ledger test requires the two to
   * agree, so turning an edit off here without retiring it there fails the build, and so does the
   * reverse.
   */
  readonly enabled: boolean;
  /**
   * What the edit needs before it can fire.
   *
   * `data` is not decoration. `needs: 'dialect'` means the edit can only be made by a caller who
   * declared the engine, because where an unknown value sorts is a property of the engine and the
   * wrong rewrite creates the defect it was meant to remove. `needs: 'data'` means the edit is
   * *inert* without a reader — and an inert edit is indistinguishable, in a result, from a database
   * where it had nothing to do. Naming the requirement here is what turns that failure into a
   * missing input rather than a missing effect.
   */
  readonly needs: 'nothing' | 'dialect' | 'data';
  /** The measurement that put the edit here: split, counts, and how it was read. */
  readonly reading: string;
}

/**
 * Every edit the pipeline applies, in the order the pipeline applies them.
 *
 * The order is load-bearing and is the reason this is a list rather than a set: the cap strip runs
 * before the null-order guard, because a cap the pipeline has just decided the statement could not
 * justify is gone by the time the guard looks for one, and a sort with no cap is unobservable. The
 * grounding edit runs first because it rewrites literals, and the other two rewrite clauses — an
 * edit that moved a value after a clause had been rebuilt would be measured on a statement the run
 * did not execute.
 */
export const SHIPPED_EDITS: readonly ShippedEdit[] = [
  {
    rule: 'ground-shipped',
    enabled: true,
    needs: 'data',
    reading:
      'BIRD dev 1,532 questions: 26 fired, 17 won, 0 lost, +1.11pp, exact McNemar p < 0.0001; Mini-Dev 496, ' +
      're-priced after the reader moved into this package: 11 fired, 10 won, 0 lost, +2.02pp, p = 0.0020. ' +
      'Ungated on purpose — the gate that only fires after an empty result took 7 of the 14 wins',
  },
  {
    rule: 'drop-unordered-limit',
    enabled: true,
    needs: 'nothing',
    reading:
      'Mini-Dev 496 questions, four arms: 49 fired, 11 won, 0 lost, sign test p = 0.00049. The ceiling that ' +
      'reads the gold statement fires 103, repairs 12 and breaks 23, which is the reading that says the ' +
      'conditions are the rule and not scaffolding around it',
  },
  {
    rule: 'null-order',
    enabled: true,
    needs: 'dialect',
    reading:
      'BIRD dev 1,532: 61 fired, 3 won, 0 lost. Mini-Dev 496: 23 fired, 1 won, 0 lost. Both deltas are below ' +
      'their split\u2019s resolution (0.3pp and 0.6pp), so the claim is "no cost" and not "more accurate"; the ' +
      'edit was held back for two rounds by a default that read every unnamed engine as SQLite',
  },
];

/**
 * The edit a rule name refers to, or a throw naming the ones this product applies.
 *
 * A lookup rather than a `find` at each call site: a pipeline that silently skipped an edit whose
 * name had changed would be a product running fewer rules than it says, which is the exact shape
 * this file was written to make impossible. The throw is unreachable in a passing build for the
 * same reason — the ledger test runs first.
 */
export function shippedEdit(rule: string): ShippedEdit {
  const found = SHIPPED_EDITS.find((edit) => edit.rule === rule);
  if (found === undefined) {
    throw new Error(`no shipped edit named '${rule}'; this product applies ${SHIPPED_EDITS.map((edit) => edit.rule).join(', ')}`);
  }
  return found;
}
