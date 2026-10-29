/**
 * Where a selection loss came from, and which candidate held the answer it did not take.
 *
 * `candidateRecall` divides an arm's cases in two: the set held an answer, or it did not.
 * `selectionLoss` is the first half minus what the arm returned — the cases a better selector
 * could have won. Neither says *which* candidate was thrown away, and that is the difference
 * between two readings that call for opposite work:
 *
 *   - the selector rejected the second model's statement, or
 *   - the selector took a different wrong statement while a right one sat beside it.
 *
 * The cross-vendor run lost 75 of its 1,018 ceiling cases and the artifact could not say
 * which of those it was. This tool reads the candidate record the runner now writes
 * (`cases[].candidates`, `cases[].winnerSource`) and puts an address on every loss: which
 * sources held the answer, and which one the arm returned instead.
 *
 * It also reports the number a judge swap has to move. For every source, how often it was the
 * *only* correct candidate and how often the arm returned it — the 47%/87% asymmetry, with its
 * denominator printed rather than implied.
 *
 * Nothing here calls a model or a database: it is a second reading of an artifact.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  readonly candidateRecall?: boolean;
  readonly candidates?: readonly CandidateVerdict[];
  readonly winnerSource?: string;
}

interface Artifact {
  readonly split?: string;
  readonly model?: string;
  readonly secondModel?: string;
  readonly cases?: readonly CaseRow[];
  readonly arms?: readonly { readonly arm: string; readonly passed: number; readonly total: number }[];
}

/** One group of losses that share an address: the answer was here, the arm went there. */
export interface Attribution {
  /** Sources that answered the question, sorted. More than one means any of them would pass. */
  readonly correct: readonly string[];
  /** The source of the statement the arm actually returned. */
  readonly taken: string;
  readonly cases: readonly string[];
}

/** How often one source was the only answer, and how often the arm came back with it. */
export interface SourceRecord {
  readonly source: string;
  readonly alone: number;
  readonly returned: number;
}

export interface LossReading {
  readonly arm: string;
  readonly split: string;
  /** Rows this arm scored. */
  readonly scored: number;
  /** Rows carrying a candidate record; the only population this tool can read. */
  readonly recorded: number;
  /** Recorded rows where at least one candidate answered the question. */
  readonly ceiling: number;
  /** Recorded rows the arm got right. */
  readonly returned: number;
  readonly lost: readonly string[];
  readonly attributions: readonly Attribution[];
  readonly sources: readonly SourceRecord[];
  /** Ids scored without a candidate record: the artifact predates the field, or the arm generates once. */
  readonly unrecorded: readonly string[];
  readonly problems: readonly string[];
}

/** Sorts by case count, then by address, so a table of one run is stable across runs. */
function byCount(left: Attribution, right: Attribution): number {
  const size = right.cases.length - left.cases.length;
  return size === 0 ? `${left.correct.join('+')}>${left.taken}`.localeCompare(`${right.correct.join('+')}>${right.taken}`) : size;
}

/**
 * Read one arm's candidate record and attribute every loss.
 *
 * A row whose `candidateRecall` says the set held an answer while its own record marks no
 * candidate correct is a contradiction between two fields written by the same pass, and it is
 * reported as a problem rather than resolved by preferring one: two readings of one row that
 * disagree mean the writer is wrong, and a table built on either of them is not a measurement.
 */
export function attribute(artifact: Artifact, arm: string): LossReading {
  const problems: string[] = [];
  const rows = (artifact.cases ?? []).filter((row) => row.arm === arm);
  const recorded: { row: CaseRow; verdicts: readonly CandidateVerdict[] }[] = [];
  const unrecorded: string[] = [];
  for (const row of rows) {
    if (row.candidates === undefined) unrecorded.push(row.id);
    else recorded.push({ row, verdicts: row.candidates });
  }
  // An arm that generates once has a set of one, and the runner does not write a record for
  // it. Every row unrecorded is therefore the same fact as "this arm has one candidate", and
  // the tool cannot tell that apart from a legacy artifact — so it says which one it read.
  if (recorded.length === 0 && rows.length > 0) {
    problems.push(`${arm} carries no candidate record in this artifact, so no loss can be attributed — the run predates the field`);
  }

  const lost: string[] = [];
  const groups = new Map<string, Attribution>();
  const sources = new Map<string, { alone: number; returned: number }>();
  let ceiling = 0;
  let returned = 0;
  for (const { row, verdicts } of recorded) {
    const correct = verdicts.filter((verdict) => verdict.correct).map((verdict) => verdict.source).sort();
    if (correct.length === 0) {
      if (row.candidateRecall === true) problems.push(`case ${row.id} says its set held an answer and records none, so the two fields disagree`);
      continue;
    }
    ceiling += 1;
    if (row.passed) returned += 1;
    // The singleton table is the selector's conversion rate per source: of the questions where
    // exactly one candidate was right, how often did the arm come back with it. `passed` rather
    // than `winnerSource` so the number exists for arms whose winner is not labelled — the
    // sampled arms have three candidates of one source and no source to name. A retry arm can
    // in principle come back with a correct statement that is not in the set, and that would
    // count as this source being taken; the arms with a retry say so in `emptyRetry`, and none
    // of them is the subject of a judge swap.
    if (correct.length === 1) {
      const only = correct[0] as string;
      const entry = sources.get(only) ?? { alone: 0, returned: 0 };
      entry.alone += 1;
      if (row.passed) entry.returned += 1;
      sources.set(only, entry);
    }
    if (row.passed) continue;
    lost.push(row.id);
    const taken = row.winnerSource ?? '(source not recorded)';
    // A loss whose taken statement is marked correct in the same row is a contradiction: the
    // arm cannot be wrong with a statement this file calls right.
    if (verdicts.some((verdict) => verdict.source === taken && verdict.correct)) {
      problems.push(`case ${row.id} failed while its record marks the returned statement (${taken}) correct, so the record and the score disagree`);
    }
    const key = `${correct.join('+')}>${taken}`;
    const group = groups.get(key) ?? { correct, taken, cases: [] };
    groups.set(key, { correct, taken, cases: [...group.cases, row.id] });
  }

  return {
    arm,
    split: artifact.split ?? 'unknown',
    scored: rows.length,
    recorded: recorded.length,
    ceiling,
    returned,
    lost,
    attributions: [...groups.values()].sort(byCount),
    sources: [...sources.entries()]
      .map(([source, counts]) => ({ source, ...counts }))
      .sort((left, right) => right.alone - left.alone || left.source.localeCompare(right.source)),
    unrecorded,
    problems,
  };
}

/**
 * A ratio of two counted sets.
 *
 * No zero guard: every caller divides by a count that only exists because the numerator's
 * population exists (a ceiling case, a source that was alone at least once). A `total === 0`
 * branch here would be a branch no input can reach, and an unreachable guard is a claim the
 * reader has to verify rather than a test target (ADR-219).
 */
const rate = (count: number, total: number): string => `${((count / total) * 100).toFixed(1)}%`;

/**
 * The sentence a reader needs: how much was lost, where the biggest group went, and the
 * conversion rate a judge swap would have to move.
 *
 * The last clause is deliberately a number rather than a verdict. Whether 38% is a judge that
 * prefers its own writing or a set of statements that are genuinely harder to recognise is the
 * question the swap answers, and this tool cannot.
 */
export function conclusion(reading: LossReading): string {
  if (reading.recorded === 0) {
    return `${reading.arm} carries no candidate record, so where its losses came from is unanswered rather than zero.`;
  }
  if (reading.ceiling === 0) {
    return `No recorded case of ${reading.arm} had an answer in its candidate set, so there is nothing to select and no loss to attribute.`;
  }
  if (reading.lost.length === 0) {
    return `${reading.arm} returned the answer on all ${String(reading.ceiling)} cases whose set held one, so nothing was thrown away.`;
  }
  const largest = reading.attributions[0] as Attribution;
  const address = `\`${largest.correct.join(' + ')}\` -> \`${largest.taken}\``;
  const head =
    `${reading.arm} lost ${String(reading.lost.length)} of ${String(reading.ceiling)} cases whose set held the answer ` +
    `(${rate(reading.lost.length, reading.ceiling)}); the largest group (${String(largest.cases.length)}) had it in ${address}.`;
  const only = largest.correct.length === 1 ? reading.sources.find((source) => source.source === largest.correct[0]) : undefined;
  if (only === undefined) {
    return `${head} Where two candidates both answered, the loss is a choice between two right statements and neither source can be priced alone.`;
  }
  return (
    `${head} \`${only.source}\` was the only answer in ${String(only.alone)} cases and it came back ${String(only.returned)} ` +
    `times (${rate(only.returned, only.alone)}), which is the number a judge swap has to move.`
  );
}

/** The table, capped so one wide run cannot bury the sentence under rows. */
export function reportLines(reading: LossReading, cap = 8): string[] {
  // A run with no record at all has no ceiling and no loss *to report*. Printing zeros there
  // would read as an arm whose candidate set never held an answer, which is the opposite of
  // what the file says: it says nothing (ADR-217's rule, one layer up).
  const lines = [
    reading.recorded === 0
      ? `${reading.arm} on ${reading.split}: ${String(reading.scored)} scored, none with a candidate record — nothing below is a measurement`
      : `${reading.arm} on ${reading.split}: ${String(reading.scored)} scored, ${String(reading.recorded)} with a candidate record, ` +
        `${String(reading.ceiling)} held an answer, ${String(reading.returned)} returned one, ${String(reading.lost.length)} lost`,
  ];
  if (reading.sources.length > 0) {
    lines.push('', '| source | only correct candidate | returned it | conversion |', '| --- | --- | --- | --- |');
    for (const source of reading.sources) {
      lines.push(`| \`${source.source}\` | ${String(source.alone)} | ${String(source.returned)} | ${rate(source.returned, source.alone)} |`);
    }
  }
  if (reading.attributions.length > 0) {
    lines.push('', '| the answer was in | the arm returned | cases |', '| --- | --- | --- |');
    for (const group of reading.attributions.slice(0, cap)) {
      lines.push(`| ${group.correct.map((source) => `\`${source}\``).join(' + ')} | \`${group.taken}\` | ${String(group.cases.length)} |`);
    }
    const rest = reading.attributions.length - cap;
    if (rest > 0) lines.push(`| … and ${String(rest)} more group(s) | | |`);
  }
  if (reading.unrecorded.length > 0) {
    lines.push(
      '',
      `${String(reading.unrecorded.length)} of ${String(reading.scored)} cases carry no candidate record (${reading.unrecorded
        .slice(0, 5)
        .join(', ')}), so they are outside every number above.`,
    );
  }
  lines.push('', conclusion(reading));
  for (const problem of reading.problems) lines.push(`  problem: ${problem}`);
  return lines;
}

export interface LossSettings {
  readonly reportPath: string;
  readonly arm: string;
}

export function resolveLossSettings(argv: readonly string[], env: Record<string, string | undefined>, root: string): LossSettings {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const reportPath = resolve(root, value('--report') ?? env.BIRD_REPORT ?? 'eval/out/bird-eval.json');
  const arm = value('--arm');
  if (arm === undefined) throw new Error('usage: losses.ts --arm <arm> [--report <artifact>]');
  return { reportPath, arm };
}

export function readArtifact(path: string): Artifact {
  return JSON.parse(readFileSync(path, 'utf8')) as Artifact;
}

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

/**
 * Read one artifact and print where the arm's losses went. No model, no database, no network.
 *
 * It throws after printing when the file contradicts itself, because a score and a candidate
 * record that disagree mean the run cannot be attributed at all — and printing a tidy table
 * over an inconsistent file is worse than printing nothing.
 */
export async function main(argv: readonly string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env, root: string = ROOT): Promise<void> {
  const settings = resolveLossSettings(argv, env, root);
  const reading = attribute(readArtifact(settings.reportPath), settings.arm);
  for (const line of reportLines(reading)) console.log(line);
  if (reading.problems.length > 0) throw new Error(reading.problems.join('; '));
}

/**
 * Whether this module is the process entry point.
 *
 * A value rather than an inline guard: `process.argv[1]` is never the entry inside a test
 * process, so an inline `argv[1] !== undefined && …` leaves its first half permanently dark
 * and a guard nobody has executed is a CLI nobody has run.
 */
export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  await main();
}
