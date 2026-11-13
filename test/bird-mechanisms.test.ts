import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ARMS, MECHANISMS, mechanismsOf } from '../eval/bird/run.js';
import type { Arm, CaseRun, Mechanism, MechanismContext } from '../eval/bird/run.js';

/**
 * The register is the only place a mechanism can be added, which makes it the only place that can
 * be wrong in the way this file refuses.
 *
 * The defect it exists for (I-72) is not a wrong number: it is a lever that is declared in the arms
 * table, paired in `PAIRS`, described in `DISPATCH`, guarded by a function with a careful doc
 * comment — and never exercised end to end, so a wiring break in the runner ships green. Three
 * levers have now been published for a round with a zero funnel, and each time the only detector was
 * a paid artifact. The suite below is the free one: it pins the register to the code (every guard in
 * `run.ts` is registered), to the arms (every mechanism is declared by an arm that exists), to the
 * behavior (every guard refuses a bank in which its mechanism did not act) and to the tests (every
 * mechanism names an end-to-end scenario, and that scenario reads the field the mechanism writes).
 */

const source = readFileSync(resolve(import.meta.dirname, '..', 'eval', 'bird', 'run.ts'), 'utf8');
const e2e = readFileSync(resolve(import.meta.dirname, 'bird-run-e2e.test.ts'), 'utf8');

/**
 * The naming rule that separates a funnel guard from every other assertion in the runner.
 *
 * A guard that asks "did this mechanism act" is named for the act (`Fired`, `Ran`, `Answered`), and
 * every other `assert*` in the file is a verdict on the run or on the declaration. That is a
 * convention, so this test is also the thing that keeps it one: a new guard written to the
 * convention has to be registered, and a guard that dodges the suffix has to be documented below.
 */
const FUNNEL_SUFFIX = /(Fired|Ran|Answered)$/;

/**
 * The one guard that asks the funnel question without the funnel suffix, kept because the name is
 * the sentence: a candidate that never arrived is not a candidate that scored badly.
 */
const UNSUFFIXED_FUNNEL_GUARD = 'assertCandidateSurvival';

/**
 * The assertions that are not funnel guards, and why the register does not hold them.
 *
 * Written as a table rather than a filter so the next `assert*` added to `run.ts` arrives with a
 * decision attached: either it is a mechanism and it is registered, or it says here what it is.
 */
const NOT_A_MECHANISM: Readonly<Record<string, string>> = {
  assertArmProducedResults: 'a verdict on the run: an arm that never reached the database has no accuracy',
  assertFailureRate: 'a verdict on the run: an endpoint that refused most cases is an outage, not a lever',
  assertHarnessClean: 'a verdict on the run: a bug in the runner is not a wrong answer',
  assertMixedFeasible: 'declaration-time: two candidate sources must be able to differ',
  assertMixedSources: 'declaration-time: every named source must resolve to an arm',
  assertCandidatePasses: 'declaration-time: a candidate count that is not a whole number of passes over the sources draws one prompt more often than the others, so the arm is not the experiment its price describes',
  assertDissentRule: 'declaration-time: a fourth opinion must come from somewhere else',
  assertSampleRule: 'declaration-time: a column rule needs a sampler to read',
  assertCardRule: 'declaration-time: a card decided by two rules reports the order of operations',
  assertMaskingRule: 'declaration-time: a mask needs worked examples to act on',
  assertRuleSelection: 'declaration-time: a free rule needs a candidate set, and cannot sit beside a lever only the model selector reads',
  assertIntentRule: 'declaration-time: an arm whose statement is rendered on the candidate path cannot be dispatched alone',
  assertSecondModel: 'declaration-time: an arm that needs a second endpoint has to have one',
  assertUniqueArmLabels: 'the artifact: two rows must not wear the same label',
  assertPoolShared: 'the artifact: a pooled arm must be shown reading the pool it names',
  assertReportComplete: 'the artifact: every instrument the arms declare must reach the report',
};

function exportedAsserts(): readonly string[] {
  return [...source.matchAll(/export function (assert[A-Za-z0-9_]*)\s*\(/g)].map((match) => match[1] as string);
}

/**
 * The body of the test whose title is given, found by matching the braces it opens.
 *
 * A block's extent cannot be read off its indentation: `describe` and `it` nest, and a scenario that
 * grows a nested `describe` would silently shorten a text scan. Matching the braces is exact, and it
 * fails loudly — an unbalanced block is a parse error in the suite that runs it anyway.
 */
function blockOf(title: string): string {
  const at = e2e.indexOf(`'${title}'`);
  if (at < 0) throw new Error(`the end-to-end suite has no scenario titled "${title}"`);
  const open = e2e.indexOf('{', at);
  if (open < 0) throw new Error(`the scenario "${title}" opens no block`);
  let depth = 0;
  for (let index = open; index < e2e.length; index += 1) {
    if (e2e[index] === '{') depth += 1;
    else if (e2e[index] === '}') {
      depth -= 1;
      if (depth === 0) return e2e.slice(open, index + 1);
    }
  }
  throw new Error(`the scenario "${title}" never closes its block`);
}

/**
 * The value that makes each lever declare its mechanism.
 *
 * `true` is the value of every boolean lever, and the two counted ones need a count that clears
 * their own threshold — a repair budget of one and a candidate set of three. A `true` in place of a
 * number would be a declared lever that reads as absent, which is the false negative this test's
 * first half would have accepted.
 */
const DECLARING_VALUE: Readonly<Record<string, unknown>> = { vote: 3, repairs: 1 };

/** A bank the guard is expected to refuse: the mechanism did not act on any case in it. */
function refuses(mechanism: Mechanism): boolean {  const context: MechanismContext = {
    armName: 'bank',
    arm: { name: 'bank', notes: false, evidence: 'dataset', repairs: 0, [mechanism.lever]: true } as unknown as Arm,
    runs: mechanism.quiet(),
    // The sampler reads the profile, which belongs to the run and not to the mechanism, so the
    // bank supplies it: the samples row is about a card with no values, and the string arm has
    // values on this database.
    sampledFor: () => ({ columns: 0, values: 0 }),
  };
  try {
    mechanism.guard(context);
    return false;
  } catch {
    return true;
  }
}

describe('the register of runtime mechanisms', () => {
  it('names each lever once', () => {
    const levers = MECHANISMS.map((mechanism) => mechanism.lever);
    expect(new Set(levers).size).toBe(levers.length);
  });

  it('registers every guard the runner exports, by the naming rule the guards follow', () => {
    const funnelGuards = exportedAsserts().filter((name) => FUNNEL_SUFFIX.test(name) || name === UNSUFFIXED_FUNNEL_GUARD);
    const exempt = exportedAsserts().filter((name) => !funnelGuards.includes(name));
    // Every exemption is a decision someone wrote down, and a new one cannot arrive silently.
    expect(new Set(exempt)).toEqual(new Set(Object.keys(NOT_A_MECHANISM)));
    // Every funnel guard is in the table, so the loop in `runArm` reaches it.
    expect(funnelGuards.length).toBe(MECHANISMS.length);
    expect(new Set(MECHANISMS.map((mechanism) => mechanism.records)).size).toBeGreaterThan(0);
    // ...and each row's guard refuses a bank in which its mechanism never acted. A row wired to a
    // guard that cannot fail would pass every other assertion in this file.
    for (const mechanism of MECHANISMS) {
      expect([mechanism.lever, refuses(mechanism)]).toEqual([mechanism.lever, true]);
    }
  });

  it('declares a mechanism from the lever and from nothing else', () => {
    for (const mechanism of MECHANISMS) {
      const without = { name: 'bare', notes: false, evidence: 'dataset', repairs: 0 } as unknown as Arm;
      const withLever = { ...without, [mechanism.lever]: DECLARING_VALUE[mechanism.lever] ?? true } as unknown as Arm;
      // `declares` must be about the lever: a predicate that reads a second field would run a guard
      // on an arm that did not ask for the mechanism, or skip one that did.
      expect([mechanism.lever, mechanism.declares(without)]).toEqual([mechanism.lever, false]);
      expect([mechanism.lever, mechanism.declares(withLever)]).toEqual([mechanism.lever, true]);
    }
  });

  it('registers only mechanisms an arm can actually declare', () => {
    const declared = new Set(ARMS.flatMap((arm) => mechanismsOf(arm).map((mechanism) => mechanism.lever)));
    // A row no arm reaches is a guard that never runs in a benchmark and a scenario that proves
    // nothing about the product.
    const orphans = MECHANISMS.map((mechanism) => mechanism.lever).filter((lever) => !declared.has(lever));
    expect(orphans).toEqual([]);
  });

  it('pins every mechanism to an end-to-end scenario that reads the field it writes', () => {
    for (const mechanism of MECHANISMS) {
      expect([mechanism.lever, mechanism.scenarios.length > 0]).toEqual([mechanism.lever, true]);
      for (const title of mechanism.scenarios) {
        const block = blockOf(title);
        // The scenario has to read the record, not merely run the arm: a block that asserts on the
        // accuracy alone passes for a mechanism whose funnel is zero, which is the publication this
        // file exists to prevent.
        expect([mechanism.lever, title, block.includes(mechanism.records)]).toEqual([mechanism.lever, title, true]);
      }
    }
  });

  it('runs the mechanisms an arm declares, in register order', () => {
    const declared = ARMS.map((arm) => ({ name: arm.name, levers: mechanismsOf(arm).map((mechanism) => mechanism.lever) }));
    const order = MECHANISMS.map((mechanism) => mechanism.lever);
    for (const arm of declared) {
      // The selector's guards run after the sampling ones because a missing candidate is priced
      // before the decision over the candidates that did arrive; a filter preserves the table's
      // order, and a hand-kept order would be a second place to forget.
      expect([arm.name, arm.levers]).toEqual([arm.name, order.filter((lever) => arm.levers.includes(lever))]);
    }
  });

  it('holds a bank that is longer than the floor each guard is silent below', () => {
    for (const mechanism of MECHANISMS) {
      // A bank shorter than the floor would make `refuses` pass for the wrong reason: the guard
      // returns early, the mechanism never runs in production either, and the row would look proven.
      expect([mechanism.lever, (mechanism.quiet() as readonly CaseRun[]).length]).toEqual([mechanism.lever, 100]);
    }
  });
});
