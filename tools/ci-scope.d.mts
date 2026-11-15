/**
 * The rule `ci.yml` consults, declared for the test that holds it to its contract.
 *
 * The tool stays plain JavaScript because the workflow runs it before `pnpm install`: it is the
 * job that decides whether the other jobs run at all, so it cannot depend on what they install.
 * Declaring the surface here keeps it out of the TypeScript build while still giving the test a
 * type — the same arrangement `stale-build.d.mts` and `check-exports.d.mts` use.
 */
export const TRUNCATED_AT: number;

export function isDocumentation(file: string): boolean;

/**
 * A file the `quality` job runs and no prompt or benchmark reads.
 *
 * Named for the two suites that exist — `test/` at the root and `packages/<name>/test/` — plus a
 * test colocated with its source, so a directory nobody argued for cannot buy a skipped run.
 */
export function isTest(file: string): boolean;

/**
 * A file the chart reading is made of, which no product path imports.
 *
 * `eval/text2vis/` is a leaf: its four sources import the chart package and each other, and nothing
 * imports them back, so a change there cannot reach a SQL prompt. `eval/bird/` is the opposite and is
 * not covered by this rule — it is the harness that spends the calls.
 */
export function isChartReading(file: string): boolean;

/**
 * A gate's own configuration: the two files at the repository root that `tools/check-*.mjs` read.
 *
 * `budgets.json` is a bundle ceiling and `api-surface.json` is an export snapshot. Both are read by
 * the `quality` job, which never skips, and neither is opened by a prompt builder — so a round that
 * moved a budget bought thirteen BIRD arms to re-measure a pipeline no byte of which had changed.
 * Two names rather than a suffix: `package.json` changes what runs, and has to measure.
 */
export function isToolConfig(file: string): boolean;

export interface ScopeResult {
  /** Whether the push has to be measured. */
  readonly measure: boolean;
  /** The sentence the workflow prints into the step summary. */
  readonly reason: string;
  /** The changed files that forced a measurement, when some did. */
  readonly files?: readonly string[];
}

export function needsModel(files: readonly string[]): ScopeResult;

/** The reading a human gets: the reason, then the files that forced it, capped at five. */
export function explain(result: ScopeResult): readonly string[];

/** The step summary, under a heading, so a skipped run explains itself. */
export function summary(result: ScopeResult): string;

/**
 * Write the `$GITHUB_OUTPUT` line and the step summary.
 *
 * The output file takes exactly one `key=value` line because that is all its parser accepts;
 * the summary takes Markdown. Passing the two paths in is what makes the split testable.
 */
export function publish(result: ScopeResult, targets: { summary?: string; output?: string }): void;
