/**
 * The arm choice `bird-dev.yml`'s diagnostic steps consult, declared for the test that holds it
 * to its contract.
 *
 * The tool stays plain JavaScript for the reason `ci-scope.d.mts` gives: a workflow step runs it
 * without a build, so declaring the surface here keeps it out of the TypeScript build while the
 * test still gets a type.
 */
export const REQUESTED_ENV: string;

/** The arm the diagnostic steps should price, and the sentence that says why. */
export interface ArmChoice {
  readonly arm: string;
  readonly reason: string;
}

/** One case row, as far as this rule cares: it may name an arm. */
export interface CaseArmRow {
  readonly arm?: unknown;
}

/** Arm names the case rows carry, sorted. */
export function readArms(cases: readonly CaseArmRow[]): readonly string[];

/**
 * The arm to price: the first requested name the artifact holds, else the largest population.
 * Throws when the artifact holds no arm at all.
 */
export function chooseArm(cases: readonly CaseArmRow[], requested: string): ArmChoice;

/** The artifact's cases, or a message that says the path is not an artifact. */
export function casesOf(artifactPath: string): readonly CaseArmRow[];

/** The sentence for whatever was thrown: an `Error`'s message, or anything else stringified. */
export function message(thrown: unknown): string;

/** The command line: one name on stdout, the reason on stderr, non-zero when there is none. */
export function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  log: (line: string) => void,
  error: (line: string) => void,
): number;
