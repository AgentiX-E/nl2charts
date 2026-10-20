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

/** Wilson score interval for a binomial proportion (95% by default). */
export function wilsonInterval(successes: number, total: number, z = 1.96): Interval {
  if (total === 0) return { low: 0, high: 1 };
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}
