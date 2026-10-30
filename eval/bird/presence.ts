/**
 * Whether the arm a tool was asked to measure is in the report at all.
 *
 * Every instrument in this directory filters an artifact's cases by arm name and prints a table
 * of what it found. When the name is not there the filter returns nothing and the table prints
 * zeros — a measurement of no cases, in the typography of a measurement of zero. The two are
 * not the same claim: one says the prompt has no card, the other says nobody rendered a prompt.
 *
 * That is not hypothetical. `bird-dev.yml` reads `select-cross` in five of its steps and runs
 * `names,inline-definitions,inline+evidence,metadata+evidence`, so every one of those steps has
 * been printing a table of zeros and passing: green, and empty. `--strict` catches it, and the
 * dev workflow omits `--strict` on purpose because the readings there are findings rather than
 * floors — which is exactly why the check belongs before the reading, not inside it.
 *
 * A zero is a finding. No rows is a missing input. Only the first may be reported.
 */
export interface CaseArm {
  readonly arm?: string;
}

/**
 * The arm these instruments read when no `--arm` is given.
 *
 * They used to default to `select-cross`, which no workflow's chain contains: the flag was
 * optional, the default named a dispatched-only arm, and a bare invocation answered a question
 * about a run that was not the run in front of it. The default is now the prompt the pipeline
 * ships and the chain always runs, so the answer to "what does the prompt cost" is about the
 * prompt somebody is paying for.
 */
export const SHIPPED_ARM = 'metadata+evidence';

/** The arm names a report holds, sorted, so an error message is stable across runs. */
export function reportArms(cases: readonly CaseArm[]): string[] {
  const names = new Set<string>();
  for (const row of cases) if (typeof row.arm === 'string') names.add(row.arm);
  return [...names].sort();
}

/**
 * Throws unless `wanted` is one of the arms the report holds, and returns the rows when it is.
 *
 * The return is the point of the signature: every caller went on to write `report.cases ?? []`
 * after the check, which is a second way to say "there are no rows" that the check has already
 * excluded. Returning the rows leaves one place where that state is decided.
 *
 * `source` names the file, because the caller's mistake is almost always a path: a tool pointed
 * at yesterday's artifact holds a different chain, and the arm it was asked for is in the run it
 * was written for rather than the one it was given.
 */
export function requireArm<T extends CaseArm>(
  cases: readonly T[] | undefined,
  wanted: string,
  source: string,
): readonly T[] {
  const rows = cases ?? [];
  const arms = reportArms(rows);
  if (arms.includes(wanted)) return rows;
  throw new Error(
    arms.length === 0
      ? `${source} holds no cases, so arm ${wanted} cannot be measured`
      : `${source} has no arm ${wanted}; it holds ${arms.join(', ')}`,
  );
}
