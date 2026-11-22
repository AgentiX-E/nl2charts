/**
 * The price of a better prompt, and the one place that decides whether the product pays it.
 *
 * `recipe.ts` says *what* the shipped prompt is. This says *whether it is allowed to be*. The two
 * were conflated until a reading made the difference expensive: the accuracy table's best cell
 * (66.45%, run `45040430602`) cost 9.7× the shipped prompt's tokens per case for a +1.37pp paired
 * gain at p = 0.112 — an effect that design could not resolve, bought at a price the product would
 * have paid on every question, forever. A transfer rule that reads accuracy alone flips the product
 * to that cell and calls it an improvement. So the rule reads both columns, and it reads them
 * through one number rather than through a policy argument held after the fact.
 *
 * ## What is stored and what is derived
 *
 * The ledger stores **counts and a price**. It does not store a p-value, an interval or a verdict,
 * because those are functions of the counts: a stored statistic is a second source of truth and the
 * first thing to drift when a count is corrected. `eval/bird/ship.ts` derives `p` with the exact
 * McNemar tail in `devkit` — the same function every other reading in this repository uses — and
 * hands the gate one object per decision. The gate then re-derives everything that is arithmetic:
 * the effect the counts imply, the price ratio, the chain from one recipe to the next. Two halves of
 * one paired result are one number twice, and a declaration whose halves disagree is refused rather
 * than averaged.
 *
 * ## The transfer, and why it cannot silently diverge
 *
 * The instrument folds the chain and prints the recipe it ends on; CI requires that recipe to be the
 * one `recipe.ts` ships. So a new priced experiment cannot reach the product without a commit to the
 * ledger, and a commit to the ledger cannot leave the product behind: either both move together or
 * the build is red. That is the whole mechanism — there is no runtime switch and therefore no state
 * in which the product sends one prompt while the experiment believes it sends another.
 */
import { SQL_RECIPES } from './recipe.js';
import type { SqlRecipe, SqlRecipeName } from './recipe.js';

/** One arm of a paired experiment, as the run measured it. */
export interface ArmEvidence {
  /** The benchmark arm's name, which is how a recipe recognises itself in the ledger. */
  readonly arm: string;
  /** Questions answered correctly. Integer, because a correct answer is not a rate. */
  readonly correct: number;
  /** Questions asked. Both arms of a decision are asked the same ones; the gate refuses otherwise. */
  readonly total: number;
  /**
   * Cache-miss tokens per case: the quantity the bill is made of.
   *
   * Per case rather than per run because the decision is per question, and miss-only rather than
   * total because a cached prompt token costs a tenth of an uncached one — a prompt that reuses a
   * long card is not expensive, it is long.
   */
  readonly tokensPerCase: number;
}

/**
 * The cases the two arms answered differently.
 *
 * These are the only cases a paired test can use, and their difference is the difference of the
 * arms' correct counts — which is the arithmetic the gate checks. A declaration whose effect does
 * not equal `onlyChallenger - onlyIncumbent` has halves copied from different runs, and the one
 * failure a report cannot see is the one where each half is plausible on its own.
 */
export interface PairedEvidence {
  readonly onlyChallenger: number;
  readonly onlyIncumbent: number;
}

/**
 * One thing the project decided about one prompt, as the ledger stores it.
 *
 * No `p`, no interval, no verdict: all three are functions of the four counts and the two prices.
 */
export interface ShipmentRecord {
  /** The GitHub run the numbers come from, so a reader can re-open the artifact. */
  readonly run: string;
  readonly dataset: string;
  readonly incumbent: ArmEvidence;
  readonly challenger: ArmEvidence;
  readonly paired: PairedEvidence;
  /** What the decision was about, in one line, for the report. */
  readonly note: string;
}

/** A record with its statistics derived by the caller's single producer. */
export interface ShipmentDecision extends ShipmentRecord {
  /** Exact McNemar, two-sided, on the discordant counts. */
  readonly p: number;
  /** 95% interval on the paired difference, **in percentage points, positive when the challenger wins**. */
  readonly ci: { readonly low: number; readonly high: number };
}

/**
 * The chain of decisions, as one artifact.
 *
 * `schemaVersion` is the version of *this* file's shape, not of the readings: a reader that does not
 * know the shape must refuse rather than guess, because the fields here decide what ships.
 */
export interface ShipmentLedger {
  readonly schemaVersion: 1;
  readonly decisions: readonly ShipmentRecord[];
}

/**
 * What a point of accuracy is worth, in tokens.
 *
 * Three numbers, each a budget the project can point at:
 *
 * - `alpha` — the significance the paired design is held to. 0.05 is the convention, and it is
 *   declared rather than assumed so that a 0.06 reading cannot be described as "nearly significant"
 *   by anyone who did not open this file.
 * - `minDeltaPp` — the smallest gain worth switching prompts for. 1.0pp, because 1,532 paired cases
 *   resolve about a point at 80% power: a smaller effect is not "small but real", it is unmeasured
 *   at this sample size, and a switch made on it would be a coin flip with a commit message.
 * - `tokenTariff` — points required per 1× extra cost. Five, so a prompt at twice the price must be
 *   five points better and one at nine times the price must be forty. This is the exchange rate
 *   between the two columns, and writing it as a number is the point: "is 0.5pp worth 9.7× tokens"
 *   is unanswerable as an argument and arithmetic as a rule.
 */
export interface ShipmentPolicy {
  readonly alpha: number;
  readonly minDeltaPp: number;
  readonly tokenTariff: number;
}

export const DEFAULT_SHIPMENT_POLICY: ShipmentPolicy = { alpha: 0.05, minDeltaPp: 1, tokenTariff: 5 };

/**
 * Why a candidate did not ship.
 *
 * A code and not a sentence, because the report groups by reason and a grouping over prose is a
 * grouping over spelling. `inconsistent` and `unknown-arm` refuse the *declaration*; the other three
 * refuse the *candidate*.
 */
export type RefusalCode =
  /** The declaration's own numbers do not close: a miscopied count, a chain that skips a step. */
  | 'inconsistent'
  /** The challenger's arm is not one the recipe table knows, so nothing could be shipped anyway. */
  | 'unknown-arm'
  /** The effect is not distinguishable from zero at the declared significance. */
  | 'not-significant'
  /** The effect is real but smaller than a switch is worth. */
  | 'below-min-effect'
  /** The effect is smaller than the price demands, at the declared rate. */
  | 'too-expensive';

/** One decision, adjudicated. */
export interface DecisionVerdict {
  readonly run: string;
  readonly arm: string;
  /** Percentage points, signed: the challenger's accuracy minus the incumbent's. */
  readonly deltaPp: number;
  /** Challenger tokens per case over the incumbent's. */
  readonly costRatio: number;
  /** The gain the policy demands at this price, in points. */
  readonly requiredPp: number;
  readonly p: number;
  readonly ship: boolean;
  readonly reasons: readonly RefusalCode[];
  /**
   * The arithmetic that did not close, in the words a reader can act on.
   *
   * Kept beside the code rather than folded into it because `inconsistent` says *that* something is
   * wrong and this says *which field*: a count copied from another run and a total that lost a
   * question are the same code and different repairs.
   */
  readonly problems: readonly string[];
}

/** The whole chain, adjudicated: every step, and the recipe it ends on. */
export interface ShipmentResult {
  readonly steps: readonly DecisionVerdict[];
  readonly recipe: SqlRecipeName;
  /** `true` when at least one step changed the recipe the product ships. */
  readonly moved: boolean;
}

/** The recipe an arm name refers to; a recipe without an arm is named by its own name. */
function recipeForArm(arm: string): SqlRecipe | undefined {
  return SQL_RECIPES.find((recipe) => (recipe.arm ?? recipe.name) === arm);
}

/**
 * The arithmetic a declaration must satisfy, in the order a reader would check it.
 *
 * Separated from the policy because the two answer different questions: this says "these numbers
 * describe one experiment", the policy says "that experiment is good enough to act on". A gate that
 * mixed them would refuse a well-formed *and* well-priced declaration with a message about counts.
 */
function inconsistencies(decision: ShipmentDecision): readonly string[] {
  const problems: string[] = [];
  const { incumbent, challenger, paired, ci, p } = decision;
  for (const [side, arm] of [
    ['incumbent', incumbent],
    ['challenger', challenger],
  ] as const) {
    if (!Number.isInteger(arm.correct) || !Number.isInteger(arm.total)) {
      problems.push(`${side} counts are not integers: ${arm.correct}/${arm.total}`);
    }
    if (arm.total <= 0) problems.push(`${side} total is ${arm.total}, so it measured nothing`);
    if (arm.correct < 0 || arm.correct > arm.total) {
      problems.push(`${side} correct ${arm.correct} is outside 0..${arm.total}`);
    }
    if (!Number.isFinite(arm.tokensPerCase) || arm.tokensPerCase <= 0) {
      problems.push(`${side} has no price: ${arm.tokensPerCase} tokens a case`);
    }
  }
  if (incumbent.total !== challenger.total) {
    // A paired design asks both arms the same questions. Two totals mean two populations, and the
    // paired counts then belong to neither.
    problems.push(`the arms answered ${incumbent.total} and ${challenger.total} questions, which cannot be paired`);
  }
  if (!Number.isInteger(paired.onlyChallenger) || !Number.isInteger(paired.onlyIncumbent)) {
    problems.push('the discordant counts are not integers');
  }
  if (paired.onlyChallenger < 0 || paired.onlyIncumbent < 0) problems.push('a discordant count is negative');
  const implied = paired.onlyChallenger - paired.onlyIncumbent;
  const observed = challenger.correct - incumbent.correct;
  if (implied !== observed) {
    problems.push(`the discordant counts imply ${implied} more correct answers, the arm totals ${observed}`);
  }
  if (!Number.isFinite(p) || p < 0 || p > 1) problems.push(`p is ${p}, which is not a probability`);
  if (!Number.isFinite(ci.low) || !Number.isFinite(ci.high)) problems.push('the interval is not finite');
  if (ci.low > ci.high) problems.push(`the interval is inverted: [${ci.low}, ${ci.high}]`);
  // The interval is in percentage points and the counts are in cases, so the two are compared after
  // one conversion rather than raw: an interval that does not contain the effect the counts state is
  // the number a reader trusts and the number the counts support, disagreeing — the shape that has
  // produced four document defects in this repository.
  const observedPp = challenger.total > 0 ? (observed / challenger.total) * 100 : Number.NaN;
  if (Number.isFinite(observedPp) && (ci.low > observedPp || ci.high < observedPp)) {
    problems.push(`the interval [${ci.low}, ${ci.high}] does not contain the effect ${observedPp.toFixed(2)}pp the counts imply`);
  }
  return problems;
}

/** One decision against one policy, with the reason it was refused when it was. */
export function adjudicateDecision(
  decision: ShipmentDecision,
  policy: ShipmentPolicy = DEFAULT_SHIPMENT_POLICY,
): DecisionVerdict {
  const problems = inconsistencies(decision);
  const { incumbent, challenger } = decision;
  // Computed before the refusal so a report can print the effect of a malformed declaration; a
  // `NaN` beside `inconsistent` says which field was missing at a glance.
  const total = incumbent.total;
  const deltaPp = total > 0 ? ((challenger.correct - incumbent.correct) / total) * 100 : Number.NaN;
  const costRatio = incumbent.tokensPerCase > 0 ? challenger.tokensPerCase / incumbent.tokensPerCase : Number.NaN;
  const extra = Number.isFinite(costRatio) ? Math.max(0, costRatio - 1) : Number.NaN;
  const pricePp = policy.tokenTariff * extra;
  const requiredPp = Number.isFinite(pricePp) ? Math.max(policy.minDeltaPp, pricePp) : Number.NaN;

  const reasons: RefusalCode[] = [];
  if (problems.length > 0) reasons.push('inconsistent');
  if (recipeForArm(challenger.arm) === undefined) reasons.push('unknown-arm');
  // Significance needs both statements to agree. An exact test and a Wald interval can differ at the
  // margin; a gate that accepted either would accept the weaker of two statements about the same
  // data. Both must say the effect is positive and unlikely to be zero.
  if (!(decision.p <= policy.alpha) || !(decision.ci.low > 0)) reasons.push('not-significant');
  if (Number.isFinite(deltaPp) && deltaPp < policy.minDeltaPp) reasons.push('below-min-effect');
  // The price only gets to refuse when the price is what binds: at a ratio below 1 the tariff is
  // zero and `minDeltaPp` is the whole requirement, so firing here too would report a cheap
  // candidate as an expensive one.
  if (Number.isFinite(deltaPp) && pricePp > policy.minDeltaPp && deltaPp < pricePp) reasons.push('too-expensive');

  return {
    run: decision.run,
    arm: challenger.arm,
    deltaPp,
    costRatio,
    requiredPp,
    p: decision.p,
    ship: reasons.length === 0,
    reasons,
    problems,
  };
}

/**
 * The chain, folded: start on the assembled prompt, move to a challenger only when the gate says so.
 *
 * The chain is checked rather than assumed. Each decision's incumbent must be the recipe the
 * previous one left in place, because a ledger is a history: a step whose incumbent is not what the
 * product shipped is a step that measured something else, and folding it would move the product on
 * evidence about a prompt it does not send.
 */
export function adjudicateShipment(
  decisions: readonly ShipmentDecision[],
  policy: ShipmentPolicy = DEFAULT_SHIPMENT_POLICY,
): ShipmentResult {
  let current: SqlRecipeName = 'assembled';
  let moved = false;
  const steps: DecisionVerdict[] = [];
  for (const decision of decisions) {
    const verdict = adjudicateDecision(decision, policy);
    const currentArm = SQL_RECIPES.find((recipe) => recipe.name === current)?.arm ?? current;
    const chained = decision.incumbent.arm === currentArm;
    const reasons: readonly RefusalCode[] = chained ? verdict.reasons : [...verdict.reasons, 'inconsistent'];
    const ship = chained && verdict.ship;
    steps.push({ ...verdict, ship, reasons });
    if (ship) {
      const target = recipeForArm(decision.challenger.arm);
      // `unknown-arm` already refused this case, so the lookup is total wherever `ship` is true.
      if (target !== undefined) {
        current = target.name;
        moved = true;
      }
    }
  }
  return { steps, recipe: current, moved };
}

/** The verdicts as report lines: one per decision, with the numbers the refusal rested on. */
export function shipmentLines(result: ShipmentResult): readonly string[] {
  const lines: string[] = [];
  for (const step of result.steps) {
    const verdict = step.ship ? 'ship' : `refuse (${step.reasons.join(', ')})`;
    lines.push(
      [
        step.run,
        step.arm.padEnd(20),
        `${step.deltaPp >= 0 ? '+' : ''}${step.deltaPp.toFixed(2)}pp`,
        `p=${step.p.toFixed(4)}`,
        `cost=${step.costRatio.toFixed(2)}x`,
        `needs=${step.requiredPp.toFixed(2)}pp`,
        verdict,
      ].join('  '),
    );
    // Printed under the line rather than inside it: the arithmetic is the reason, and a reason that
    // shares a line with six numbers is the part of the report a reader skips.
    for (const problem of step.problems) lines.push(`    ${problem}`);
  }
  lines.push(`recipe: ${result.recipe}${result.moved ? ' (moved)' : ' (unchanged)'}`);
  return lines;
}
