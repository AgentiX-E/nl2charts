/**
 * How many failing statements an arm may keep in the artifact.
 *
 * The corpus is the only material a failure can be diagnosed from after the run: the
 * requests are gone, and re-running to ask "what did it write on the 300 cases it got
 * wrong" costs another two hours. It was capped at 25 per arm — 1.4% of a dev arm's
 * failures, unannounced — then raised to 200, which was a third of the same arm.
 *
 * 200 was still a limit on a *measurement* rather than on a cost. `bench:bird:gap` read the
 * two dev arms of `40865112253` and found 687 of 1,043 no-answer cases with no retained
 * statement: two thirds of the set the next iteration exists to diagnose could not be
 * diagnosed, and the loss was silent because the cap is per failure rather than per
 * question. The limit is now above the largest split (1,534), so for both splits the corpus
 * is a census and `truncated` stays empty. The cost is bounded and small: ~600 statements of
 * ~250 bytes per arm, which is 1.5 MB for a ten-arm dev run against a 10 GB artifact limit.
 */
export const FAILURE_SAMPLE = 2000;

/**
 * The failures an arm reports, plus the count it did not report.
 *
 * `truncated` exists because a sample that does not announce itself is read as a census:
 * a reader who sees 200 entries in a 563-failure arm has no way to tell whether the arm
 * failed 200 times or whether the file stopped at a limit.
 */
export function failureCorpus<T extends { readonly id: string; readonly predicted: string; readonly reason: string; readonly error?: string }>(
  entries: readonly (readonly [string, readonly T[]])[],
  cap: number,
  questionOf: (id: string) => string | undefined,
): {
  failures: Record<string, { id: string; question?: string; predicted: string; reason: string; error?: string }[]>;
  failureSample: { cap: number; total: Record<string, number>; truncated: string[] };
} {
  const failures: Record<string, { id: string; question?: string; predicted: string; reason: string; error?: string }[]> = {};
  const total: Record<string, number> = {};
  const truncated: string[] = [];
  for (const [name, runs] of entries) {
    const failing = runs.filter((run) => (run as { passed?: boolean }).passed === false);
    total[name] = failing.length;
    if (failing.length > cap) truncated.push(name);
    failures[name] = failing.slice(0, cap).map((run) => {
      const question = questionOf(run.id);
      return {
        id: run.id,
        ...(question === undefined ? {} : { question }),
        predicted: run.predicted,
        reason: run.reason,
        ...(run.error === undefined ? {} : { error: run.error }),
      };
    });
  }
  return { failures, failureSample: { cap, total, truncated } };
}
