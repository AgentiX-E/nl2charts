/**
 * The message of whatever was thrown, as a sentence.
 *
 * Eight places in `eval/` wrote `error instanceof Error ? error.message : String(error)`,
 * and in each of them the false branch is a branch no test can reach: the things this
 * harness throws are `Error`s. The expression is still correct — a promise can reject with a
 * string, and a benchmark that prints `[object Object]` for an outage is a benchmark nobody
 * can debug — so it stays, once, in a function whose input a test controls.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
