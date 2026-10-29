/**
 * Which slot a candidate sat in, and whether the selector followed the slot or the author.
 *
 * `CROSS_SOURCES` puts the second model's statement first on every question. So for every
 * cross-vendor run this repository has ever taken, "the judge prefers its own writing" and
 * "the judge prefers the first candidate in the list" predict the same number — and they call
 * for opposite work. The shuffled arm breaks the tie by moving the same three statements to
 * positions that depend only on the question id; this tool reads the artifact and groups the
 * cases by the slot the tracked candidate occupied, then reports how often it won in each
 * group.
 *
 * The strata are not a table of percentages. Each carries a Wilson interval, and the two
 * extreme strata carry a Newcombe interval for their difference, because "52%, 49%, 55%" on
 * four hundred cases a stratum and "52%, 20%, 48%" are the same sentence to a reader who is
 * not shown the widths — and the second is a finding while the first is not.
 *
 * The two outcomes are different questions and are counted separately:
 *
 *   - `took`  — the arm returned the tracked statement, which is what "the judge preferred
 *               that author" means in the artifact.
 *   - `passed` — the arm's answer was judged right. It can be true while `took` is false (two
 *               candidates answered and the arm picked the other one), and the gap between the
 *               two columns is the part of the reading the judge, not the selector, decided.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The ninety-five percent normal quantile. Named so no caller has to guess which one. */
const Z = 1.959963984540054;

/** The source whose slot the table stratifies by, unless a run says otherwise. */
export const DEFAULT_TRACKED = 'inline+evidence@second';

export interface Interval {
  readonly low: number;
  readonly high: number;
}

/** The member of a candidate set. `correct` is the official judge's verdict on its result. */
interface CandidateVerdict {
  readonly source: string;
  readonly correct: boolean;
}

/** One row of the artifact's `cases`: what one arm did on one question. */
interface CaseRow {
  readonly arm: string;
  readonly id: string;
  readonly passed: boolean;
  readonly candidates?: readonly CandidateVerdict[];
  readonly winnerSource?: string;
}

interface Artifact {
  readonly split?: string;
  readonly cases?: readonly CaseRow[];
}

/** One slot's worth of outcomes: the cases where the tracked source sat at this index. */
export interface SlotStratum {
  /** The index the tracked source occupied in `cases[].candidates`, zero-based. */
  readonly slot: number;
  /** Cases where it sat here and the row carried a winner label or not; see `unlabelled`. */
  readonly cases: number;
  /** Cases where it sat here and the arm returned it. */
  readonly took: number;
  /** Cases where it sat here and the arm's answer was judged right. */
  readonly passed: number;
  /** `took / cases`, as a fraction. */
  readonly share: number;
  /** Wilson score interval for `share`. Fraction of the same unit, not percentage points. */
  readonly interval: Interval;
}

export interface SlotReading {
  readonly arm: string;
  readonly split: string;
  readonly tracked: string;
  /** Rows this arm scored. */
  readonly scored: number;
  /** Rows carrying a candidate record: the only population with a slot at all. */
  readonly recorded: number;
  /** Rows where the tracked source did not appear: its candidate never arrived. */
  readonly absent: number;
  /** Rows that entered a stratum: the ones with exactly one slot for the tracked source. */
  readonly placed: number;
  /** Rows where it appeared but the arm's choice was not labelled, so the slot is known and the choice is not. */
  readonly unlabelled: number;
  readonly strata: readonly SlotStratum[];
  readonly problems: readonly string[];
}

/**
 * The comparison, as a union rather than a bag of optional fields.
 *
 * One stratum has no difference to report, and a `spreadPp?: number` would let every caller
 * write `?? 0` — a zero that means "no comparison" wearing the clothes of a measured zero.
 * The union makes the absent case unrepresentable as a number (ADR-217's rule).
 */
export type SlotComparison =
  | { readonly verdict: 'single-slot' }
  | {
      readonly verdict: 'separated' | 'overlapping';
      /** The stratum with the highest share, and the one with the lowest. */
      readonly high: SlotStratum;
      readonly low: SlotStratum;
      /** `high.share - low.share`, in percentage points. Never negative: the pair is chosen by share. */
      readonly spreadPp: number;
      /** Newcombe interval for that difference. It excludes zero exactly when the two separate. */
      readonly interval: Interval;
    };

export interface PositionSettings {
  readonly reportPath: string;
  readonly arm: string;
  readonly tracked: string;
}

/**
 * The Wilson score interval for a binomial proportion.
 *
 * Chosen over the textbook `p ± 1.96·√(p(1-p)/n)` because the strata here are exactly where
 * that approximation fails: a slot that was taken zero times or every time has an estimated
 * variance of zero and a Wald interval of zero width, which would read as a certainty that
 * the sample cannot support. No zero guard on `total`: every caller divides by a stratum's
 * `cases`, which only exists when at least one case landed there (ADR-219).
 */
export function wilson(successes: number, total: number): Interval {
  const share = successes / total;
  const square = Z * Z;
  const denominator = 1 + square / total;
  const centre = (share + square / (2 * total)) / denominator;
  const half = (Z * Math.sqrt((share * (1 - share)) / total + square / (4 * total * total))) / denominator;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * Newcombe's hybrid score interval for the difference of two independent proportions.
 *
 * It is built from the two Wilson intervals rather than from the shares alone, so it inherits
 * their behaviour in the tails — which is the case that decides this reading. A slot whose
 * tracked candidate was taken on every one of its cases must be allowed to differ from one
 * taken on half of them, and a Wald interval would call that difference significant on a
 * handful of cases.
 */
export function differenceInterval(left: SlotStratum, right: SlotStratum): Interval {
  const gap = left.share - right.share;
  return {
    low: gap - Math.sqrt((left.share - left.interval.low) ** 2 + (right.interval.high - right.share) ** 2),
    high: gap + Math.sqrt((left.interval.high - left.share) ** 2 + (right.share - right.interval.low) ** 2),
  };
}

/**
 * Group one arm's cases by the slot its tracked candidate occupied.
 *
 * A row whose record carries the tracked source twice is reported as a problem rather than
 * resolved by taking the first index: the artifact says one statement is in two places, and a
 * table built on either of them would be attributing a position to a case that has none.
 */
export function slotStrata(artifact: Artifact, arm: string, tracked: string = DEFAULT_TRACKED): SlotReading {
  const rows = (artifact.cases ?? []).filter((row) => row.arm === arm);
  // Filtered through a type predicate rather than tested again inside the loop: a `row.candidates
  // ?? []` a few lines below would be a branch no input can reach, and an unreachable guard is a
  // claim the reader has to verify instead of a test target (ADR-219).
  const recorded = rows.filter(
    (row): row is CaseRow & { readonly candidates: readonly CandidateVerdict[] } => row.candidates !== undefined,
  );
  const problems: string[] = [];
  if (recorded.length === 0 && rows.length > 0) {
    problems.push(`${arm} carries no candidate record in this artifact, so no slot can be read — the run predates the field`);
  }

  const counts = new Map<number, { cases: number; took: number; passed: number }>();
  let absent = 0;
  let placed = 0;
  let unlabelled = 0;
  for (const row of recorded) {
    const slots = row.candidates.flatMap((verdict, index) => (verdict.source === tracked ? [index] : []));
    if (slots.length === 0) {
      absent += 1;
      continue;
    }
    if (slots.length > 1) {
      problems.push(`case ${row.id} records \`${tracked}\` in slots ${slots.join(' and ')}, so the case has no single position`);
      continue;
    }
    const slot = slots[0] as number;
    const entry = counts.get(slot) ?? { cases: 0, took: 0, passed: 0 };
    entry.cases += 1;
    placed += 1;
    if (row.winnerSource === undefined) unlabelled += 1;
    else if (row.winnerSource === tracked) entry.took += 1;
    if (row.passed) entry.passed += 1;
    counts.set(slot, entry);
  }

  const strata = [...counts.entries()]
    .map(([slot, entry]) => ({ slot, ...entry, share: entry.took / entry.cases, interval: wilson(entry.took, entry.cases) }))
    .sort((left, right) => left.slot - right.slot);

  return {
    arm,
    split: artifact.split ?? 'unknown',
    tracked,
    scored: rows.length,
    recorded: recorded.length,
    absent,
    placed,
    unlabelled,
    strata,
    problems,
  };
}

/**
 * Compare the two extreme strata.
 *
 * "Highest minus lowest" rather than "slot 0 minus slot 1", because under a shuffle the slot
 * that holds the second model's statement varies per question and there is no privileged pair
 * to name. Picking the extremes is what makes the comparison conservative in the direction
 * that matters: it is the largest difference in the table, so a run that separates them
 * separates every other pair as well.
 */
export function compare(reading: SlotReading): SlotComparison {
  if (reading.strata.length < 2) return { verdict: 'single-slot' };
  const sorted = [...reading.strata].sort((left, right) => right.share - left.share || left.slot - right.slot);
  const high = sorted[0] as SlotStratum;
  const low = sorted[sorted.length - 1] as SlotStratum;
  const interval = differenceInterval(high, low);
  return {
    high,
    low,
    spreadPp: (high.share - low.share) * 100,
    interval,
    verdict: interval.low > 0 || interval.high < 0 ? 'separated' : 'overlapping',
  };
}

const percent = (part: number, whole: number): string => `${((part / whole) * 100).toFixed(1)}%`;

const pp = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(1)}pp`;

const bounds = (interval: Interval): string => `${(interval.low * 100).toFixed(1)}% to ${(interval.high * 100).toFixed(1)}%`;

/**
 * The sentence a reader needs, in one of three shapes.
 *
 * The third one is the important one. A run that cannot separate the slot from the author is
 * not a run that found no difference: it is a run whose interval is wider than the effect it
 * was built to see, and saying so is the whole point of carrying intervals this far.
 */
export function conclusion(reading: SlotReading): string {
  if (reading.recorded === 0) {
    return `${reading.arm} carries no candidate record, so which slot \`${reading.tracked}\` sat in is unanswered rather than uniform.`;
  }
  if (reading.absent === reading.recorded) {
    return `None of the ${String(reading.recorded)} recorded cases of ${reading.arm} carries \`${reading.tracked}\`, so this arm does not draw that source at all.`;
  }
  if (reading.strata.length === 0) {
    return `No case of ${reading.arm} puts \`${reading.tracked}\` in one slot, so there is nothing to stratify — the problems below say why.`;
  }
  const comparison = compare(reading);
  if (comparison.verdict === 'single-slot') {
    const only = reading.strata[0] as SlotStratum;
    return (
      `Every case put \`${reading.tracked}\` in slot ${String(only.slot)}, so this artifact cannot separate the slot from the author: ` +
      `an arm that never moves the statement gives the same number for both readings, and only a shuffled arm can tell them apart.`
    );
  }
  const head =
    `\`${reading.tracked}\` was returned on ${percent(comparison.high.took, comparison.high.cases)} of its ${String(comparison.high.cases)} cases ` +
    `in slot ${String(comparison.high.slot)} and on ${percent(comparison.low.took, comparison.low.cases)} of its ${String(comparison.low.cases)} cases ` +
    `in slot ${String(comparison.low.slot)}, a gap of ${pp(comparison.spreadPp)} ` +
    `with an interval of ${pp(comparison.interval.low * 100)} to ${pp(comparison.interval.high * 100)}.`;
  if (comparison.verdict === 'separated') {
    return `${head} The interval excludes zero, so in this run the position of the statement changes how often it is taken.`;
  }
  return `${head} The interval does not exclude zero, so this run does not separate the slot from the author — which is not the same as showing they are the same.`;
}

/** The table, with the denominators a reader needs to price each row. */
export function reportLines(reading: SlotReading): string[] {
  const head =
    `${reading.arm} on ${reading.split}: ${String(reading.scored)} scored, ${String(reading.recorded)} with a candidate record, ` +
    `${String(reading.placed)} carried \`${reading.tracked}\` in ${String(reading.strata.length)} slot(s), ` +
    `${String(reading.absent)} did not`;
  const lines = [head];
  if (reading.strata.length > 0) {
    lines.push(
      '',
      '| slot | cases | took it | took it, 95% | passed | passed, 95% |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const stratum of reading.strata) {
      lines.push(
        `| ${String(stratum.slot)} | ${String(stratum.cases)} | ${percent(stratum.took, stratum.cases)} | ${bounds(stratum.interval)} ` +
          `| ${percent(stratum.passed, stratum.cases)} | ${bounds(wilson(stratum.passed, stratum.cases))} |`,
      );
    }
  }
  if (reading.unlabelled > 0) {
    lines.push(
      '',
      `${String(reading.unlabelled)} of ${String(reading.placed)} cases carry no winner label, so their slot is known and the arm's choice is not; they are counted in the denominators and never as a choice.`,
    );
  }
  lines.push('', conclusion(reading));
  for (const problem of reading.problems) lines.push(`  problem: ${problem}`);
  return lines;
}

export function resolvePositionSettings(argv: readonly string[], env: Record<string, string | undefined>, root: string): PositionSettings {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const reportPath = resolve(root, value('--report') ?? env.BIRD_REPORT ?? 'eval/out/bird-eval.json');
  const arm = value('--arm');
  if (arm === undefined) throw new Error('usage: position.ts --arm <arm> [--source <candidate source>] [--report <artifact>]');
  return { reportPath, arm, tracked: value('--source') ?? DEFAULT_TRACKED };
}

export function readArtifact(path: string): Artifact {
  return JSON.parse(readFileSync(path, 'utf8')) as Artifact;
}

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

/**
 * Print the strata for one arm of one artifact. No model, no database, no network.
 *
 * It throws after printing when the file contradicts itself, for the same reason `losses.ts`
 * does: a case recorded in two slots is a writer defect, and a tidy table over it would be a
 * measurement of nothing.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  root: string = ROOT,
): Promise<void> {
  const settings = resolvePositionSettings(argv, env, root);
  const reading = slotStrata(readArtifact(settings.reportPath), settings.arm, settings.tracked);
  for (const line of reportLines(reading)) console.log(line);
  if (reading.problems.length > 0) throw new Error(reading.problems.join('; '));
}

/**
 * Whether this module is the process entry point.
 *
 * A value rather than an inline guard, so the comparison itself is a test target: inside a
 * test process `process.argv[1]` is never the entry, and a guard nobody has executed is a CLI
 * nobody has run (ADR-219).
 */
export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  await main();
}
