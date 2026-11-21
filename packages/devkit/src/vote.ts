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
  /**
   * True when the winner's group is tied with another group of the same size.
   *
   * The winner is still defined — the earliest candidate breaks the tie — but the *decision* was
   * not made by the vote, it was made by the arrival order. A caller that spends a call only where
   * the vote cannot decide needs this bit, and reading it off `agreement * groups === 1` is the
   * same statement written in a way a reader has to verify: on three candidates that is 1/3 × 3.
   * It is reported here because this function is the only place that knows the group sizes.
   */
  readonly tied: boolean;
}

export function majorityResult<T>(items: readonly T[], equals: (left: T, right: T) => boolean): Majority<T> {
  if (items.length === 0) return { winner: undefined, agreement: 0, groups: 0, tied: false };
  const groups: T[][] = [];
  for (const item of items) {
    const group = groups.find((candidate) => equals(candidate[0] as T, item));
    if (group === undefined) groups.push([item]);
    else group.push(item);
  }
  // Largest group wins; the earliest candidate breaks a tie, because candidates
  // arrive in generation order and the first is the least perturbed sample. The tie is recorded as
  // it is discovered rather than counted afterwards: one pass, and the flag cannot disagree with
  // the winner it describes.
  let best = groups[0] as T[];
  let tied = false;
  for (const group of groups) {
    if (group.length > best.length) best = group;
    else if (group !== best && group.length === best.length) tied = true;
  }
  return { winner: best[0], agreement: best.length / items.length, groups: groups.length, tied };
}
