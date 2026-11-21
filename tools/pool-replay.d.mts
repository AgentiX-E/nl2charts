/**
 * The surface `tools/pool-replay.mjs` exposes, declared for the tests that hold it to its rules.
 *
 * The script stays plain JavaScript for the reason `ci-scope.d.mts` gives: a workflow step may run
 * it before `pnpm install`, so it cannot depend on what the install provides.
 */

/** One candidate, as far as a policy reads it. */
export interface ReplayCandidate {
  readonly source?: string;
  readonly correct?: boolean;
  readonly sql?: string;
  readonly rows?: number;
  readonly columns?: number;
  readonly chosen?: boolean;
  readonly fingerprint: string;
}

/** One case row, as far as a policy reads it. */
export interface ReplayRow {
  readonly id?: string;
  readonly arm?: string;
  readonly passed?: boolean;
  readonly winnerSource?: string;
  readonly candidates: readonly ReplayCandidate[];
}

/** A policy: a name, whether it can ship, and a total function over a case. */
export interface ReplayPolicy {
  readonly name: string;
  readonly implementable: boolean;
  readonly note: string;
  readonly decide: (row: ReplayRow) => boolean | undefined;
}

/** What one policy scores over a set of cases. */
export interface PolicyPrice {
  readonly policy: string;
  readonly implementable: boolean;
  readonly note: string;
  readonly passed: number;
  readonly scored: number;
  readonly undecided: number;
  readonly accuracy: number;
}

/** One distinct-result bucket of the pool census. */
export interface CensusBucket {
  readonly groups: number;
  readonly cases: number;
  readonly recall: number;
  readonly modalCorrect: number;
  readonly tied: number;
}

/** Whether the replayed modal rule reproduces the arm that ran it. */
export interface VoteCheck {
  readonly arm: string;
  readonly compared: number;
  readonly agreements: number;
  readonly disagreements: readonly { readonly id?: string; readonly recorded: boolean; readonly replayed: boolean }[];
}

/** Candidates grouped by the judge's equality, earliest member first. */
export function resultGroups(candidates: readonly ReplayCandidate[]): ReplayCandidate[][];

/** The modal group, with the number of distinct results and whether the mode is tied. */
export function modalGroup(candidates: readonly ReplayCandidate[]): {
  readonly members: readonly ReplayCandidate[];
  readonly groups: number;
  readonly tied: boolean;
};

/** The member the arm answered with, when the record says so. */
export function chosenMember(candidates: readonly ReplayCandidate[]): ReplayCandidate | undefined;

/** The single member a source name identifies, or undefined when it names none or several. */
export function memberBySource(candidates: readonly ReplayCandidate[], source?: string): ReplayCandidate | undefined;

/** Every policy, in the order the table prints them. */
export const POLICIES: readonly ReplayPolicy[];

/** The cases of one arm that hold a candidate pool. */
export function casesOf(artifact: { readonly cases?: readonly ReplayRow[] }, arm?: string): ReplayRow[];

/** The arm with the widest pool, which is what an unnamed invocation prices. */
export function widestArm(artifact: { readonly cases?: readonly ReplayRow[] }): string | undefined;

/** The pricing table. */
export function pricePolicies(rows: readonly ReplayRow[]): PolicyPrice[];

/** The pool census. */
export function census(rows: readonly ReplayRow[]): CensusBucket[];

/** The vote replay check. */
export function verifyVote(artifact: { readonly cases?: readonly ReplayRow[] }, voteArm?: string): VoteCheck;

/** Entry point; resolves to the process exit code. */
export function main(argv: readonly string[]): Promise<number>;
