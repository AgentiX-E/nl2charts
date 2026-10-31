export interface CaseOutcome {
  readonly id: string;
  readonly passed: boolean;
}

export interface ArmResult {
  readonly arm: string;
  readonly total: number;
  readonly passed: number;
  readonly accuracy: number;
  readonly outcomes: readonly CaseOutcome[];
}

export function summarise(arm: string, outcomes: readonly CaseOutcome[]): ArmResult {
  const passed = outcomes.filter((outcome) => outcome.passed).length;
  return {
    arm,
    total: outcomes.length,
    passed,
    accuracy: outcomes.length === 0 ? 0 : passed / outcomes.length,
    outcomes,
  };
}

export interface PairedComparison {
  readonly onlyFirst: number;
  readonly onlySecond: number;
  readonly both: number;
  readonly neither: number;
  readonly total: number;
  readonly delta: number;
  readonly discordant: number;
}

/**
 * Pair two arms case by case. The ids must match exactly.
 *
 * An id is not a key. Mini-Dev lists questions 137 and 138 twice each — the published file has
 * 500 rows for 498 questions — and a map keyed by id lets both of the first arm's rows read the
 * last answer the second arm recorded for that id, so a pass on one draw is compared with a pass
 * on the other. That moves a pair between `onlyFirst` and `onlySecond`, which are the counts
 * McNemar and the interval are computed from, while `delta` stays right because it is taken from
 * the accuracies. Occurrences are consumed in the order the arms answered them instead, and an
 * arm that did not answer a question the same number of times is refused rather than matched to
 * whatever was left over.
 *
 * The last check is the one that would have caught it: `onlyFirst - onlySecond` is the first arm's
 * passes minus the second's, because every pair lands in exactly one of the four cells. A pairing
 * that loses or duplicates a pair breaks that identity while leaving `delta` intact, which is
 * exactly how the defect read as a plausible table for a round. It also covers the one mismatch the
 * loop cannot see — a second arm with more rows than the first runs out of questions to consume and
 * fails here instead of being silently truncated.
 */
export interface AlignedPair {
  readonly id: string;
  readonly first: boolean;
  readonly second: boolean;
}

export interface Pairing {
  readonly pairs: readonly AlignedPair[];
  /** Ids the first arm answered more often than the second, in the first arm's order. */
  readonly unmatchedFirst: readonly string[];
  /** Ids the second arm answered more often than the first, in the second arm's order. */
  readonly unmatchedSecond: readonly string[];
}

/**
 * Align two arms' cases by occurrence — the one definition of "the same case twice".
 *
 * There used to be two. `compareArms` consumed occurrences in the order the arms answered them,
 * because a map keyed by id let the first arm's two rows for Mini-Dev's repeated 137 read the
 * last answer the second arm recorded for that id; `pairCases` in `eval/bird/strata.ts` built that
 * map anyway and reported the repetition as "took the last one of each". Two pairings of the same
 * artifact then disagreed by one pair on a split with a repeated question, which meant the tool
 * that explains a delta and the tool that produces it could not be cross-checked — and the
 * cross-check is the only reason either number is believable.
 *
 * So the alignment is here, and both readers fold over it. Occurrence order is the only ordering
 * that needs no assumption about the file: an artifact lists what each arm did, in the order it
 * did it, and a repeated question is two draws rather than one answer recorded twice.
 */
export function pairByOccurrence(
  first: readonly CaseOutcome[],
  second: readonly CaseOutcome[],
): Pairing {
  const pending = new Map<string, boolean[]>();
  for (const { id, passed } of second) pending.set(id, [...(pending.get(id) ?? []), passed]);
  const pairs: AlignedPair[] = [];
  const unmatchedFirst: string[] = [];
  for (const { id, passed } of first) {
    const other = pending.get(id)?.shift();
    if (other === undefined) {
      unmatchedFirst.push(id);
      continue;
    }
    pairs.push({ id, first: passed, second: other });
  }
  const unmatchedSecond: string[] = [];
  for (const { id } of second) {
    const queue = pending.get(id);
    if (queue !== undefined && queue.length > 0) {
      unmatchedSecond.push(id);
      queue.shift();
    }
  }
  return { pairs, unmatchedFirst, unmatchedSecond };
}

export function compareArms(first: ArmResult, second: ArmResult): PairedComparison {
  const pairing = pairByOccurrence(first.outcomes, second.outcomes);
  // Both leftovers are refused, and each names the arm that answered the case fewer times: an
  // arm with an extra row used to pass through the loop untouched and fail on the arithmetic
  // identity, which names neither the arm nor the case.
  const missing = pairing.unmatchedFirst[0];
  if (missing !== undefined) throw new Error(`arm ${second.arm} is missing case ${missing}`);
  const extra = pairing.unmatchedSecond[0];
  if (extra !== undefined) throw new Error(`arm ${first.arm} is missing case ${extra}`);
  let onlyFirst = 0;
  let onlySecond = 0;
  let both = 0;
  let neither = 0;
  for (const pair of pairing.pairs) {
    if (pair.first === pair.second) {
      if (pair.first) both += 1;
      else neither += 1;
    } else if (pair.first) onlyFirst += 1;
    else onlySecond += 1;
  }
  if (onlyFirst - onlySecond !== first.passed - second.passed) throw new Error('pairs do not add up');
  return {
    onlyFirst,
    onlySecond,
    both,
    neither,
    total: first.outcomes.length,
    delta: second.accuracy - first.accuracy,
    discordant: onlyFirst + onlySecond,
  };
}

/** Execution accuracy: identical row sets, order-insensitive. */
export function sameRows(
  left: readonly Readonly<Record<string, unknown>>[],
  right: readonly Readonly<Record<string, unknown>>[],
): boolean {
  const key = (rows: readonly Readonly<Record<string, unknown>>[]): string =>
    rows
      .map((row) => JSON.stringify(Object.keys(row).sort().map((column) => [column, row[column]])))
      .sort()
      .join('\n');
  return left.length === right.length && key(left) === key(right);
}

export interface ResultSet {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}

/**
 * Execution accuracy for two SQL results: same column count, same values in the
 * same column order. Aliases are ignored (they are presentation), column order
 * is not (it is part of the result shape).
 */
export function sameResult(left: ResultSet, right: ResultSet): boolean {
  if (left.columns.length !== right.columns.length || left.rows.length !== right.rows.length) return false;
  const key = (result: ResultSet): string =>
    result.rows.map((row) => JSON.stringify(result.columns.map((column) => row[column] ?? null))).sort().join('\n');
  return key(left) === key(right);
}
