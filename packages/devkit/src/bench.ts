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
export function compareArms(first: ArmResult, second: ArmResult): PairedComparison {
  const pending = new Map<string, boolean[]>();
  for (const { id, passed } of second.outcomes) pending.set(id, [...(pending.get(id) ?? []), passed]);
  let onlyFirst = 0;
  let onlySecond = 0;
  let both = 0;
  let neither = 0;
  for (const { id, passed } of first.outcomes) {
    const other = pending.get(id)?.shift();
    if (other === undefined) throw new Error(`arm ${second.arm} is missing case ${id}`);
    if (passed === other) {
      if (passed) both += 1;
      else neither += 1;
    } else if (passed) onlyFirst += 1;
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
