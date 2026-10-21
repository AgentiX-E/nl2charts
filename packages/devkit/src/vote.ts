/**
 * Self-consistency over executed answers.
 *
 * Language models are not deterministic even at temperature 0 in every provider,
 * and a single sample cannot separate "the model is wrong" from "this sample is
 * wrong". Asking k times and keeping the answer the most samples agree with is
 * the cheapest variance reduction available, and it needs no external knowledge.
 *
 * Equality is supplied by the caller: answers that produce the same result set
 * agree, even when the SQL text differs.
 */
export interface Majority<T> {
  readonly winner: T | undefined;
  /** Share of candidates that agree with the winner, in [0, 1]. */
  readonly agreement: number;
  /** How many distinct answers were produced. */
  readonly groups: number;
}

export function majorityResult<T>(items: readonly T[], equals: (left: T, right: T) => boolean): Majority<T> {
  if (items.length === 0) return { winner: undefined, agreement: 0, groups: 0 };
  const groups: T[][] = [];
  for (const item of items) {
    const group = groups.find((candidate) => equals(candidate[0] as T, item));
    if (group === undefined) groups.push([item]);
    else group.push(item);
  }
  // Largest group wins; the earliest candidate breaks a tie, because candidates
  // arrive in generation order and the first is the least perturbed sample.
  let best = groups[0] as T[];
  for (const group of groups) if (group.length > best.length) best = group;
  return { winner: best[0], agreement: best.length / items.length, groups: groups.length };
}
