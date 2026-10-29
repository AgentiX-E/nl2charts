/**
 * Why the candidate set had no answer, read from the artifact.
 *
 * `candidateRecall − selectionLoss = passed` splits every arm's score into two mechanisms:
 * the questions whose candidate set held an answer, and the selector's ability to pick it.
 * The second half has been measured to death — judge swaps, prompt layouts, candidate
 * orders — and it is 4.6pp wide. The first half is 34pp wide and had never been looked at,
 * because the accuracy column prints one number for both.
 *
 * This is the first look, and it is deliberately the cheapest possible one: it reads the
 * artifact the run already wrote, spends no model call and no database, and classifies
 * every case in which no candidate matched. The buckets are the ones the artifact can
 * distinguish without re-running anything:
 *
 * - `engine-refused` — the case carries an error, so at least one candidate never produced
 *   a statement the engine accepted. Upstream of every other shape: nothing can be said
 *   about a projection that was never executed.
 * - `column-count` — the statements ran and returned the wrong number of columns. This is
 *   grain, not values: the model grouped by the wrong thing or projected the wrong set.
 * - `values` — right width, wrong numbers: a filter that matched nothing, an aggregation at
 *   the wrong level, or a literal that does not exist in the data.
 *
 * What this cannot say is *why* the literal was wrong or the column was unknown, because
 * that needs the gold statement executed against the database — `bench:bird:diagnose` does
 * that. The two are complementary and this file states the boundary rather than blurring it.
 *
 * It also counts what the artifact threw away. `failures` is capped at 200 statements per
 * arm, so a case whose statement was not retained cannot be diagnosed at all; that number
 * is printed instead of being discovered later by a reader who expected a census.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The shapes the artifact can tell apart on its own. */
export const GAP_BUCKETS = ['engine-refused', 'column-count', 'values', 'unclassified'] as const;
export type GapBucket = (typeof GAP_BUCKETS)[number];

/** A case as the artifact writes it, restricted to the fields this reads. */
export interface CaseRecord {
  readonly arm?: string;
  readonly id?: string;
  readonly passed?: boolean;
  readonly reason?: string;
  readonly errorKind?: string;
  readonly error?: string;
  readonly candidateRecall?: boolean;
  readonly candidates?: readonly { readonly source?: string; readonly correct?: boolean }[];
  readonly winnerSource?: string;
}

export interface ReportedFailure {
  readonly id?: string;
}

export interface GapReportShape {
  readonly split?: string;
  readonly model?: string | null;
  readonly cases?: readonly CaseRecord[];
  readonly arms?: readonly { readonly arm?: string; readonly candidateRecall?: number }[];
  readonly failures?: Readonly<Record<string, readonly ReportedFailure[]>>;
}

export interface ArmGap {
  readonly arm: string;
  /** Questions whose candidate set held no answer. */
  readonly noAnswer: number;
  /** Questions the arm was scored on, for the share column. */
  readonly scored: number;
  readonly buckets: Readonly<Record<GapBucket, number>>;
  /** No-answer cases whose statement is in the retained failure list. */
  readonly retained: number;
  readonly classified: number;
  readonly coverage: number;
}

/**
 * One case, one bucket.
 *
 * The order is causal, not alphabetical: an error means the statement never ran, so it is
 * reported before the shape it might have produced. A case that failed both ways is
 * attributed to the earlier fixable cause, which is the only attribution that suggests an
 * order of work.
 */
export function classifyGapCase(record: CaseRecord): GapBucket {
  const errorKind = typeof record.errorKind === 'string' ? record.errorKind.trim() : '';
  const error = typeof record.error === 'string' ? record.error.trim() : '';
  if (errorKind !== '' || error !== '') return 'engine-refused';
  if (record.reason === 'column-count') return 'column-count';
  if (record.reason === 'values') return 'values';
  return 'unclassified';
}

/**
 * The arm names that publish a ceiling.
 *
 * Read from `arms[]` rather than from the cases: a case carries `candidateRecall: false`,
 * and an arm with no ceiling at all (a single-candidate arm) writes neither, so deriving
 * the list from the cases would silently include arms that cannot have one.
 */
export function samplingArms(report: GapReportShape): string[] {
  return (report.arms ?? [])
    .filter((row) => typeof row.candidateRecall === 'number')
    .map((row) => String(row.arm));
}

/** Per-arm buckets, with the coverage the plan's acceptance criterion is stated in. */
export function gapTable(report: GapReportShape): ArmGap[] {
  const cases = report.cases ?? [];
  const retainedIds = new Map<string, Set<string>>();
  for (const [arm, list] of Object.entries(report.failures ?? {})) {
    retainedIds.set(arm, new Set(list.map((entry) => String(entry.id))));
  }
  return samplingArms(report).map((arm) => {
    const rows = cases.filter((row) => row.arm === arm);
    const empty = GAP_BUCKETS.reduce((acc, bucket) => ({ ...acc, [bucket]: 0 }), {} as Record<GapBucket, number>);
    const buckets = rows
      .filter((row) => row.candidateRecall === false)
      .reduce((acc, row) => {
        const bucket = classifyGapCase(row);
        return { ...acc, [bucket]: acc[bucket] + 1 };
      }, empty);
    const noAnswer = Object.values(buckets).reduce((sum, count) => sum + count, 0);
    const kept = retainedIds.get(arm) ?? new Set<string>();
    const retained = rows.filter((row) => row.candidateRecall === false && row.id !== undefined && kept.has(String(row.id))).length;
    // `unclassified` is a bucket, not a gap: a case the artifact describes well enough to
    // rule out all three shapes is still classified. Coverage is therefore the share of
    // cases that reached a named bucket, which is the number the plan's 80% applies to.
    const classified = noAnswer - buckets.unclassified;
    return {
      arm,
      noAnswer,
      scored: rows.length,
      buckets,
      retained,
      classified,
      coverage: noAnswer === 0 ? 1 : classified / noAnswer,
    };
  });
}

export interface GapSettings {
  readonly report: string;
  readonly out: string;
}

export function resolveGapSettings(argv: readonly string[] = [], root = process.cwd()): GapSettings {
  const path = argv[0] ?? 'eval/out/bird-eval.json';
  return { report: resolve(root, path), out: resolve(root, 'eval/out/bird-gap.json') };
}

/**
 * The problems that make the table unpublishable.
 *
 * Two of them, both about the instrument rather than the reading: a run whose arms report
 * no ceiling has nothing to diagnose (`0 of 0` would print as complete coverage), and a
 * classification that covers less than four fifths of the no-answer cases is a bucket list
 * that cannot carry a decision about where to spend the next iteration.
 */
export function gapProblems(arms: readonly ArmGap[], minimumCoverage = 0.8): string[] {
  if (arms.length === 0) {
    return ['GAP: no arm in this artifact publishes a candidate ceiling, so there is nothing to diagnose'];
  }
  const problems: string[] = [];
  for (const arm of arms) {
    if (arm.noAnswer === 0) continue;
    if (arm.coverage < minimumCoverage) {
      problems.push(
        `GAP: ${arm.arm} classifies ${arm.classified} of ${arm.noAnswer} no-answer cases (${(arm.coverage * 100).toFixed(1)}%), below the ${(minimumCoverage * 100).toFixed(0)}% the plan requires`,
      );
    }
  }
  return problems;
}

/**
 * The buckets wide enough to become their own iteration.
 *
 * The plan's threshold is share of the no-answer set, not share of the split: a bucket at
 * 10% of 523 questions is 52 questions, which is a week of work; a bucket at 10% of five is
 * a rounding error. The threshold is applied per arm and printed with the count so a reader
 * can disagree with the cut rather than with the number.
 */
export function subItemBuckets(arms: readonly ArmGap[], threshold = 0.1): { arm: string; bucket: GapBucket; count: number; share: number }[] {
  const items: { arm: string; bucket: GapBucket; count: number; share: number }[] = [];
  for (const arm of arms) {
    if (arm.noAnswer === 0) continue;
    for (const bucket of GAP_BUCKETS) {
      if (bucket === 'unclassified') continue;
      const count = arm.buckets[bucket];
      const share = count / arm.noAnswer;
      if (share > threshold) items.push({ arm: arm.arm, bucket, count, share });
    }
  }
  return items.sort((left, right) => right.count - left.count);
}

export interface GapArtifact {
  readonly split: string;
  readonly model: string | null;
  readonly generatedAt: string;
  readonly minimumCoverage: number;
  readonly arms: readonly ArmGap[];
  readonly subItems: readonly { arm: string; bucket: GapBucket; count: number; share: number }[];
  readonly retained: { readonly total: number; readonly hidden: number };
}

export function gapArtifact(report: GapReportShape, arms: readonly ArmGap[], minimumCoverage = 0.8): GapArtifact {
  const total = arms.reduce((sum, arm) => sum + arm.noAnswer, 0);
  const retained = arms.reduce((sum, arm) => sum + arm.retained, 0);
  return {
    split: String(report.split ?? 'unknown'),
    model: report.model ?? null,
    generatedAt: new Date().toISOString(),
    minimumCoverage,
    arms,
    subItems: subItemBuckets(arms, 0.1),
    retained: { total, hidden: total - retained },
  };
}

/**
 * The table a human reads, in fixed-width columns so two runs can be compared by eye.
 *
 * Every row is built from the same cell list as the header, so indexing a row by a column
 * index is total by construction; the `?? 0` this used to carry was a branch no input could
 * take, and ADR-219 deletes those rather than testing them.
 */
export function gapLines(artifact: GapArtifact): string[] {
  const head = ['arm', 'no-answer', 'of scored', 'engine-refused', 'column-count', 'values', 'unclassified', 'coverage'];
  const rows: string[][] = artifact.arms.map((arm) => [
    arm.arm,
    String(arm.noAnswer),
    `${((arm.noAnswer / Math.max(arm.scored, 1)) * 100).toFixed(1)}%`,
    String(arm.buckets['engine-refused']),
    String(arm.buckets['column-count']),
    String(arm.buckets.values),
    String(arm.buckets.unclassified),
    `${(arm.coverage * 100).toFixed(1)}%`,
  ]);
  const widths = head.map((title, index) => Math.max(title.length, ...rows.map((cells) => cells[index]!.length)));
  const line = (cells: readonly string[]): string => cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd();
  const out = [line(head), ...rows.map(line)];
  out.push('');
  out.push(
    `${String(artifact.retained.hidden)} of ${String(artifact.retained.total)} no-answer cases have no retained statement, so no oracle can be run on them`,
  );
  for (const item of artifact.subItems) {
    out.push(
      `${item.arm}: ${item.bucket} is ${String(item.count)} cases (${(item.share * 100).toFixed(1)}% of its no-answer set) — wide enough to be its own iteration`,
    );
  }
  return out;
}

export function gapPath(settings: GapSettings): string {
  return settings.out;
}

export function writeGapArtifact(settings: GapSettings, artifact: GapArtifact): string {
  mkdirSync(dirname(settings.out), { recursive: true });
  writeFileSync(settings.out, JSON.stringify(artifact, null, 2));
  return settings.out;
}

export function runGap(settings: GapSettings): { artifact: GapArtifact; problems: string[]; path: string } {
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as GapReportShape;
  const arms = gapTable(report);
  const problems = gapProblems(arms);
  const artifact = gapArtifact(report, arms);
  const path = writeGapArtifact(settings, artifact);
  return { artifact, problems, path };
}

/**
 * The program: resolve, measure, print, and put the table where a reviewer will see it.
 *
 * The step summary is written here rather than by a shell pipe in the workflow. `pnpm x | tee`
 * reports tee's exit status, so a step that failed would look green; a `|| true` would make
 * that explicit and permanent. Appending from the process that owns the exit code keeps the
 * one property that matters — the number and the verdict cannot disagree.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const settings = resolveGapSettings(argv, root);
  const { artifact, problems } = runGap(settings);
  const lines = gapLines(artifact);
  for (const line of lines) console.log(line);
  for (const problem of problems) console.error(problem);
  const summary = env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== '') {
    appendFileSync(summary, ['', '### Where the candidate set had no answer', '', '```', ...lines, '```', ''].join('\n'));
  }
  return problems.length === 0 ? 0 : 1;
}

/**
 * Whether this module is the program, as a value.
 *
 * `process.argv[1]` is never this file inside a test, and a guard nobody has executed is a
 * CLI nobody has run: the predicate is exported and asserted in three shapes instead of
 * being trusted because the script happened to work once.
 */
export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
