/** Biostatistics used by the benchmark report. No dependencies, exact where it matters. */

function logFactorial(n: number): number {
  let total = 0;
  for (let index = 2; index <= n; index += 1) total += Math.log(index);
  return total;
}

/**
 * McNemar's exact test, two-sided, on the discordant pairs of a paired design.
 * Returns 1 when there are no discordant pairs.
 */
export function mcnemarExact(onlyFirst: number, onlySecond: number): number {
  const discordant = onlyFirst + onlySecond;
  if (discordant === 0) return 1;
  const minority = Math.min(onlyFirst, onlySecond);
  let tail = 0;
  for (let k = 0; k <= minority; k += 1) {
    tail += Math.exp(logFactorial(discordant) - logFactorial(k) - logFactorial(discordant - k) - discordant * Math.log(2));
  }
  return Math.min(1, 2 * tail);
}

export interface Interval {
  readonly low: number;
  readonly high: number;
}

/**
 * z for the power a resolution is quoted at.
 *
 * A power outside this table has no multiplier here on purpose: a value interpolated
 * between two rows would be a resolution nobody computed, quoted to the digit.
 */
function zForPower(power: number): number {
  switch (power) {
    case 0.8:
      return 0.8416;
    case 0.9:
      return 1.2816;
    case 0.95:
      return 1.6449;
    default:
      throw new Error(`power ${String(power)} has no multiplier in this file; supported: 0.8, 0.9, 0.95`);
  }
}

export interface PairedResolution {
  /** The observed paired difference, as a share of cases (0.025 = 2.5pp). */
  readonly delta: number;
  /** Lower end of the Wald interval on that difference. */
  readonly low: number;
  /** Upper end of the Wald interval on that difference. */
  readonly high: number;
  /** Share of cases the two arms disagreed on: the only cases a paired test can use. */
  readonly discordantShare: number;
  /** The smallest difference this many cases could have detected at the quoted power. */
  readonly mde: number;
}

/**
 * What a paired result can say, and what it cannot.
 *
 * A p-value answers "is the difference zero". It does not answer "could this design have
 * seen the difference at all", and a non-significant result from an underpowered design
 * reads as "no effect" when it means "no measurement". The paired difference has standard
 * error sqrt(discordant share / n) — only the discordant cases carry information about
 * which arm is better — so the smallest difference this design could detect is
 * (z_alpha/2 + z_power) standard errors. That is a property of the design and the observed
 * discordance, computable before and after the run, and belongs beside every p.
 *
 * Zero discordant pairs is not a zero-width interval. Three cases in n is the 95% upper
 * bound on a rate that produced no event ("the rule of three"), so two arms that agreed on
 * all 120 cases still cannot exclude a 4pp difference. Returning zero there would have
 * called an unresolved question resolved.
 */
export function pairedResolution(onlyFirst: number, onlySecond: number, total: number, power = 0.8): PairedResolution {
  // A comparison with no cases measured nothing; saying "resolves everything" is the only
  // honest reading of an empty design.
  if (total <= 0) return { delta: 0, low: 0, high: 0, discordantShare: 0, mde: 1 };
  const discordant = onlyFirst + onlySecond;
  // The rule of three: with no discordant pairs the plug-in rate is zero, and a zero rate
  // would claim an exact interval from a sample that simply did not see a disagreement.
  const share = discordant === 0 ? 3 / total : discordant / total;
  const delta = (onlySecond - onlyFirst) / total;
  const standardError = Math.sqrt(share / total);
  const margin = 1.96 * standardError;
  return {
    delta,
    low: delta - margin,
    high: delta + margin,
    discordantShare: share,
    // A design whose smallest detectable difference is the whole range is a design that
    // resolves nothing; the cap keeps the number readable instead of printing 180pp.
    mde: Math.min(1, (1.96 + zForPower(power)) * standardError),
  };
}

/**
 * Cases a claim needs, from the discordance rate the pair already showed.
 *
 * n = (z_alpha/2 + z_power)^2 * discordant share / effect^2. The rate is a property of the
 * pair rather than of the claim, so a 120-case run can size the next one: at the 4.17%
 * discordance the cross-vendor pair produced, a 2pp claim needs 818 cases and a 3pp claim
 * 364 — which is what decides whether 120 cases are a sample or a guess.
 */
export function casesForEffect(discordantShare: number, effect: number, power = 0.8): number {
  if (!(effect > 0)) throw new Error(`effect must be a positive difference, got ${String(effect)}`);
  const multiplier = 1.96 + zForPower(power);
  return Math.ceil((multiplier * multiplier * Math.max(0, discordantShare)) / (effect * effect));
}

/** Wilson score interval for a binomial proportion (95% by default). */
export function wilsonInterval(successes: number, total: number, z = 1.96): Interval {
  if (total === 0) return { low: 0, high: 1 };
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}
