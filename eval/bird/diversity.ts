/**
 * How many independent opinions the pool actually holds.
 *
 * `bench:bird:pool` prices a *pool*: it takes every candidate an arm kept and asks what the union
 * covers, so it answers "what does one more call buy". It cannot answer the question underneath
 * that one, which is what the call is buying at all: a pool of three candidates that return the
 * same rows three times costs three calls and carries one opinion, and its union looks exactly
 * like a pool of three genuinely different attempts.
 *
 * This harness reads that apart, from the same artifact and with no model call:
 *
 * 1. **Distinct results per case.** Candidates carry a `fingerprint` of their result set, so the
 *    number of independent answers on a case is a fact about the artifact rather than a claim.
 *    Where it is one, the pool's extra calls bought nothing on that case.
 * 2. **Who carries the ceiling.** For each source, the cases it is *solely* right on — the ones
 *    that would leave the ceiling if that candidate disappeared. That is the source's marginal
 *    value, and it is not the same number as the cases it is right on: three sources that agree
 *    on the cases they get right each look valuable and none of them is.
 * 3. **Where diversity is missing and it matters.** A ceiling loss is a case with no correct
 *    candidate. If the candidates also *agree* on such a case, no selector can reach it and no
 *    re-ranking helps: the loss is correlated, and the only lever that moves it is a candidate
 *    that sees something the others did not.
 *
 * The three readings are printed with their denominators because each of them is a share of a
 * different set, and the two that decide anything — sole-carrier and correlated loss — are small
 * numbers that a reader will otherwise read as noise.
 *
 * Precedent, measured elsewhere and quoted here because it is the external anchor this lever is
 * judged against: XiYan-SQL's ablation removes multiple generators and loses 4.04pp of execution
 * accuracy (73.34 -> 69.30 on BIRD dev), and MCS-SQL's ablation prices five prompts at +1.3pp
 * against twenty samples of one prompt at +2.1pp. Both say the same thing this harness measures:
 * *more opinions* and *different opinions* are separate purchases.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The sample floor every instrument in this repository uses before it prints a share. */
export const MINIMUM_INSTRUMENT_SAMPLE = 100;

/** The artifact fields this harness reads; anything else is ignored so older artifacts join. */
export interface DiversityArtifact {
  readonly split?: unknown;
  readonly model?: unknown;
  readonly cases?: readonly {
    readonly id?: unknown;
    readonly arm?: unknown;
    readonly passed?: unknown;
    readonly winnerSource?: unknown;
    readonly candidates?: readonly {
      readonly source?: unknown;
      readonly correct?: unknown;
      readonly fingerprint?: unknown;
    }[];
  }[];
}

interface Candidate {
  readonly source: string;
  readonly correct: boolean;
  readonly fingerprint: string;
}

interface CaseRun {
  readonly id: string;
  readonly candidates: readonly Candidate[];
}

/** What the artifact says about one arm's candidate set. */
export interface DiversityRead {
  readonly arm: string;
  readonly cases: number;
  readonly ceiling: number;
  /** Distinct execution results per case: the number of opinions the pool actually carried. */
  readonly distinct: {
    readonly mean: number;
    readonly max: number;
    readonly unanimous: number;
    readonly unanimousCorrect: number;
  };
  readonly sources: readonly { readonly source: string; readonly generated: number; readonly correct: number; readonly sole: number }[];
  /** What the ceiling loses when a source is removed — its marginal value, not its hit rate. */
  readonly marginals: readonly { readonly source: string; readonly without: number; readonly lost: number }[];
  /** Cases with no correct candidate, and how many of those the candidates agreed on anyway. */
  readonly correlated: { readonly cases: number; readonly unanimous: number };
}

export interface DiversitySettings {
  readonly report: string;
  readonly arm: string | undefined;
  readonly json: boolean;
  readonly out: string | undefined;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function stringField(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`a case has no ${what}`);
  return value;
}

/** Every arm the artifact scored, in the order it wrote them. */
export function scoredArms(report: DiversityArtifact): string[] {
  const names = new Set<string>();
  for (const row of report.cases ?? []) if (typeof row.arm === 'string') names.add(row.arm);
  return [...names];
}

/** The arms that kept a candidate record, which is the only population this harness can read. */
export function poolingArms(report: DiversityArtifact): string[] {
  const names = new Set<string>();
  for (const row of report.cases ?? []) {
    if (typeof row.arm === 'string' && Array.isArray(row.candidates) && row.candidates.length > 0) names.add(row.arm);
  }
  return [...names];
}

/**
 * The arm with the most candidate records, which is the one this harness reads when nobody says.
 *
 * Not the first one: a dev artifact carries pooled arms that ran a handful of cases before their
 * pool was reused, and a reading taken on those would be a share of the draw. The largest
 * population is the same tie-break `tools/bird-arm.mjs` uses for the other instruments.
 */
export function largestPool(report: DiversityArtifact): string | undefined {
  const counts = new Map<string, number>();
  for (const row of report.cases ?? []) {
    if (typeof row.arm === 'string' && Array.isArray(row.candidates) && row.candidates.length > 0) {
      counts.set(row.arm, (counts.get(row.arm) ?? 0) + 1);
    }
  }
  let best: string | undefined;
  for (const [arm, count] of counts) if (best === undefined || count > (counts.get(best) ?? 0)) best = arm;
  return best;
}

/**
 * The candidates of one arm, or a refusal that names what the artifact does hold.
 *
 * Two absences stay apart, the same way `gap.ts` keeps them apart: an arm the artifact never
 * scored is a mistake in the step that named it, and an arm it scored without candidates cannot
 * have a pool at all because it never drew one. The second refusal names the arms that do carry
 * candidates, because the reader's next move is to point the flag at one of them.
 */
export function candidateCases(report: DiversityArtifact, arm: string, source: string): CaseRun[] {
  // An artifact with no case list is the first absence, and it is checked before the arm is:
  // "you named an arm this run did not score" is a true sentence about an artifact that holds no
  // cases at all, and it would send the reader looking for a typo in a flag that was correct.
  const cases = report.cases;
  if (cases === undefined || cases.length === 0) {
    throw new Error(`${source} carries no cases at all, so no pool can be read from it`);
  }
  const scored = scoredArms(report);
  if (!scored.includes(arm)) {
    throw new Error(`${source} has no arm ${arm}; it holds ${scored.join(', ')}`);
  }
  const pooling = poolingArms(report);
  if (!pooling.includes(arm)) {
    throw new Error(
      pooling.length === 0
        ? `${source} keeps no candidate record at all, so no pool can be read from it`
        : `${arm} keeps no candidate record in ${source}, so it has no pool to read; the arms that do are ${pooling.join(', ')}`,
    );
  }
  const rows: CaseRun[] = [];
  for (const row of cases) {
    // A row with no candidate array is not a case of this pool: it is a case the arm scored after
    // the pool had been read, and counting it would put a question into the denominator that no
    // candidate ever answered. `Array.isArray` is also what narrows the optional field.
    if (row.arm !== arm || !Array.isArray(row.candidates) || row.candidates.length === 0) continue;
    rows.push({
      id: stringField(row.id, 'id'),
      candidates: row.candidates.map((candidate) => ({
        source: stringField(candidate.source, 'candidate source'),
        correct: candidate.correct === true,
        // A missing fingerprint is not "the same result as everything else": it is a record that
        // cannot be compared, so it is given a name of its own and counted as its own opinion.
        // The alternative — dropping it — would silently make the pool look more diverse than it
        // is, and merging it would make the pool look more redundant than it is.
        fingerprint: typeof candidate.fingerprint === 'string' ? candidate.fingerprint : `unfingerprinted:${String(candidate.source)}`,
      })),
    });
  }
  return rows;
}

export function diversityRead(report: DiversityArtifact, arm: string, source = 'the artifact'): DiversityRead {
  const rows = candidateCases(report, arm, source);
  if (rows.length < MINIMUM_INSTRUMENT_SAMPLE) {
    throw new Error(
      `${arm} has ${String(rows.length)} cases with candidates, under the ${String(MINIMUM_INSTRUMENT_SAMPLE)} this instrument needs; a share of ${String(rows.length)} is a share of the draw`,
    );
  }
  const sources = [...new Set(rows.flatMap((row) => row.candidates.map((candidate) => candidate.source)))].sort();
  const ceiling = rows.filter((row) => row.candidates.some((candidate) => candidate.correct)).length;
  const distinct = rows.map((row) => new Set(row.candidates.map((candidate) => candidate.fingerprint)).size);
  const unanimousRows = rows.filter((_, index) => distinct[index] === 1);
  const sourceReads = sources.map((name) => {
    const hit = rows.filter((row) => row.candidates.some((candidate) => candidate.source === name && candidate.correct));
    const sole = hit.filter(
      (row) => !row.candidates.some((candidate) => candidate.source !== name && candidate.correct),
    );
    return {
      source: name,
      generated: rows.filter((row) => row.candidates.some((candidate) => candidate.source === name)).length,
      correct: hit.length,
      sole: sole.length,
    };
  });
  const marginals = sources.map((name) => {
    const without = rows.filter((row) =>
      row.candidates.some((candidate) => candidate.source !== name && candidate.correct),
    ).length;
    return { source: name, without, lost: ceiling - without };
  });
  const losses = rows.filter((row) => !row.candidates.some((candidate) => candidate.correct));
  return {
    arm,
    cases: rows.length,
    ceiling,
    distinct: {
      mean: distinct.reduce((sum, value) => sum + value, 0) / rows.length,
      max: Math.max(...distinct),
      unanimous: unanimousRows.length,
      unanimousCorrect: unanimousRows.filter((row) => row.candidates[0]?.correct === true).length,
    },
    sources: sourceReads,
    marginals,
    correlated: {
      cases: losses.length,
      unanimous: losses.filter((row) => new Set(row.candidates.map((candidate) => candidate.fingerprint)).size === 1).length,
    },
  };
}

const percent = (part: number, whole: number): string => `${((100 * part) / Math.max(1, whole)).toFixed(2)}%`;

export function diversityLines(read: DiversityRead): string[] {
  const lines: string[] = [];
  lines.push(`arm ${read.arm}: ${String(read.cases)} cases with a candidate record`);
  lines.push('');
  lines.push(`  ceiling (any candidate correct)   ${String(read.ceiling).padStart(4)}  ${percent(read.ceiling, read.cases)}`);
  lines.push(`  distinct results per case         ${read.distinct.mean.toFixed(2)} mean, ${String(read.distinct.max)} max`);
  lines.push(
    `  unanimous cases                   ${String(read.distinct.unanimous).padStart(4)}  ${percent(read.distinct.unanimous, read.cases)}` +
      `   correct ${String(read.distinct.unanimousCorrect)} (${percent(read.distinct.unanimousCorrect, read.distinct.unanimous)})`,
  );
  lines.push('');
  const head = ['source', 'generated', 'correct', 'sole'];
  const cells = read.sources.map((row) => [
    row.source,
    String(row.generated),
    `${String(row.correct)} (${percent(row.correct, read.cases)})`,
    `${String(row.sole)} (${percent(row.sole, read.cases)})`,
  ]);
  const widths = head.map((title, index) => Math.max(title.length, ...cells.map((row) => row[index]!.length), 12));
  const line = (row: readonly string[]): string => `  ${row.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd()}`;
  lines.push(line(head));
  for (const row of cells) lines.push(line(row));
  lines.push('');
  lines.push('  what each source is worth on its own — the ceiling without it:');
  for (const row of [...read.marginals].sort((left, right) => right.lost - left.lost)) {
    lines.push(
      `    ${row.source.padEnd(28)} ceiling ${percent(row.without, read.cases).padStart(7)}  loses ${String(row.lost).padStart(3)} (${percent(row.lost, read.cases)})`,
    );
  }
  lines.push('');
  lines.push(
    `  cases with no correct candidate    ${String(read.correlated.cases).padStart(4)}  ${percent(read.correlated.cases, read.cases)}` +
      `   of which the candidates agreed ${String(read.correlated.unanimous)} (${percent(read.correlated.unanimous, read.correlated.cases)})`,
  );
  return lines;
}

export function resolveDiversitySettings(argv: readonly string[], root: string): DiversitySettings {
  let report = join(root, 'eval/out/bird-eval.json');
  let arm: string | undefined;
  let json = false;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === '--arm') {
      arm = argv[index + 1];
      if (arm === undefined) throw new Error('--arm needs an arm name');
      index += 1;
    } else if (flag === '--json') {
      json = true;
    } else if (flag === '--out') {
      out = argv[index + 1];
      if (out === undefined) throw new Error('--out needs a path');
      index += 1;
    } else if (flag.startsWith('-')) {
      throw new Error(`unknown flag ${flag}`);
    } else {
      report = resolve(root, flag);
    }
  }
  return { report, arm, json, out };
}

export function main(
  argv: readonly string[],
  root: string,
  log: (line: string) => void = console.log,
): number {
  const settings = resolveDiversitySettings(argv, root);
  const report = readJson<DiversityArtifact>(settings.report);
  const arm = settings.arm ?? largestPool(report);
  if (arm === undefined) throw new Error(`${settings.report} keeps no candidate record at all, so no pool can be read from it`);
  const read = diversityRead(report, arm, settings.report);
  const lines = diversityLines(read);
  if (settings.json) log(JSON.stringify(read, null, 2));
  else for (const line of lines) log(line);
  if (settings.out !== undefined) {
    writeFileSync(resolve(root, settings.out), JSON.stringify(read, null, 2));
  }
  return 0;
}

/**
 * Run as a script when — and only when — this file is the entry point.
 *
 * The same shape `pool.ts` and `route.ts` use, for the same reason: an entry check written inline
 * is unreachable from a test, and the branch it guards is the one that decides whether a mistyped
 * flag prints a sentence or a stack trace.
 */
export function dispatch(
  entry: string | undefined,
  self: string,
  argv: readonly string[],
  root: string,
  log: (line: string) => void = console.log,
  error: (line: string) => void = console.error,
  run: (argv: readonly string[], root: string, log: (line: string) => void) => number = main,
): number | undefined {
  if (entry === undefined || self !== pathToFileURL(entry).href) return undefined;
  try {
    return run(argv, root, log);
  } catch (thrown) {
    error(thrown instanceof Error ? thrown.message : String(thrown));
    return 1;
  }
}

const exit = dispatch(process.argv[1], import.meta.url, process.argv.slice(2), process.cwd());
if (exit !== undefined) process.exitCode = exit;
