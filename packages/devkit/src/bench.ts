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

/** Pair two arms case by case. The ids must match exactly. */
export function compareArms(first: ArmResult, second: ArmResult): PairedComparison {
  const secondById = new Map(second.outcomes.map((outcome) => [outcome.id, outcome.passed]));
  let onlyFirst = 0;
  let onlySecond = 0;
  let both = 0;
  let neither = 0;
  for (const outcome of first.outcomes) {
    const other = secondById.get(outcome.id);
    if (other === undefined) throw new Error(`arm ${second.arm} is missing case ${outcome.id}`);
    if (outcome.passed && other) both += 1;
    else if (outcome.passed) onlyFirst += 1;
    else if (other) onlySecond += 1;
    else neither += 1;
  }
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
