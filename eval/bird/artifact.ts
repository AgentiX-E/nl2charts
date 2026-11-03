/**
 * Shared predicates over a written artifact.
 *
 * The three instruments that read a candidate pool — `bench:bird:pool`, `bench:bird:diversity` and
 * `bench:bird:consensus` — each refused an artifact with no candidates, and each refusal was written
 * as a bug report: "keeps no candidate set, so there is no pool to price". That was true when every
 * dev dispatch sampled three candidates. It stopped being true in the round the ceiling lever became
 * a single call: `metadata+evidence+icl` draws one candidate and is measured on 1,532 questions, and
 * the dev workflow died at the first of the three instruments *after* the evaluation and the floor
 * had both passed — so the run's two remaining readings were skipped and the build was red on an
 * artifact that was exactly what the dispatch asked for.
 *
 * The distinction that was missing is between two different absences:
 *
 * - **No arm draws more than one candidate.** There is nothing to pool, and that is a reading: the
 *   instrument says so in one line and exits successfully.
 * - **An arm publishes a ceiling and its cases carry no candidates.** That artifact lost records it
 *   had, and it is refused — `assertReportComplete` already fails the run that writes one, so this
 *   is the second line of defence rather than the only one.
 */

/** The one field an arm row carries when, and only when, it sampled more than one candidate. */
export interface CandidateClaimingArm {
  readonly candidateRecall?: unknown;
}

/**
 * Whether any arm in this artifact draws more than one candidate.
 *
 * `candidateRecall` is the signal rather than a `vote` count, because the artifact does not publish
 * the arm's configuration: the ceiling is the field the row carries *because* it sampled, and the
 * report gate refuses a sampling row without it. An artifact written before that field existed has
 * no ceiling on any row either, so it is read as single-call — which is what such an artifact can
 * be read as without inventing a number.
 */
export function declaresCandidateSet(arms: readonly object[] | undefined): boolean {
  // Typed as `object[]` rather than `CandidateClaimingArm[]` because an artifact's row type is
  // declared beside the instrument that reads it, and three near-identical interfaces are how this
  // repository ended up with three copies of the refusal. The cast is the price of one predicate.
  return (arms ?? []).some((row) => (row as CandidateClaimingArm).candidateRecall !== undefined);
}

/**
 * The questions an artifact scored, counted without needing a candidate record.
 *
 * The three instruments derive their denominators from the candidate rows, which is right for every
 * reading they print and wrong for this one sentence: an artifact with no candidates produced a
 * denominator of zero, so the line said "there is no pool to price (0 questions)" about a run that
 * had just scored 1,532. A sentence that states a number has to state the run's number.
 */
export function scoredQuestions(cases: readonly { readonly id?: unknown }[] | undefined): number {
  const ids = new Set<string>();
  for (const row of cases ?? []) if (row.id !== undefined) ids.add(String(row.id));
  return ids.size;
}
