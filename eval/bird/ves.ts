/**
 * R-VES: what a correct statement's speed is worth, and the clock that makes the reading possible.
 *
 * BIRD reports two numbers per submission. `EX` counts correct result sets; `R-VES` pays for the
 * ones that are also fast. The metric is a discretised reward over the execution-time ratio
 *
 *     tau = time(gold) / time(predicted)
 *
 * quoted identically by the three sources this repository holds (BAPPA §4.2, E-SQL §4.1.2 and the
 * BIRD-CRITIC leaderboard guide): 1.25 at `tau >= 2`, 1.0 at `1 <= tau < 2`, 0.75 at `0.5 <= tau < 1`,
 * 0.5 at `0.25 <= tau < 0.5`, 0.25 below that, and 0 for a wrong answer. The bands are not a smooth
 * function on purpose: BIRD's own definition is a table, and a table is what a test can pin.
 *
 * **Two normalisations exist in the literature and this module reports both.** The leaderboard guide
 * averages the reward over *all* questions (`100/N * sum(m_i * g(tau_i))`), while one paper's appendix
 * says `N` is "the total number of queries that passed the EX evaluation". The two cannot both be
 * right, and the leaderboard's own numbers decide it: OpenSearch-SQL is filed at 72.28 EX and 69.36
 * R-VES, a ratio of 0.96, which is what averaging over all questions produces when a correct
 * statement averages a little under 1.0 on the reward table. Dividing by the valid count instead
 * would put R-VES *above* EX for any system whose correct statements are mostly at par, and no
 * leaderboard row does that. So `rves` is the all-questions mean, `rvesOfValid` is the other one,
 * and a report prints the first with the second beside it rather than choosing silently.
 *
 * **The clock is the part that was missing.** `oracle.py` measured whole milliseconds, and most
 * statements on this corpus finish inside one, so both sides of the ratio read `0` and the ratio was
 * `0/0`. The oracle now reports microseconds (`us`) from the same stopwatch, and this module reads
 * that field; `ms * 1000` is the fallback for an older peer, which is a statement about resolution
 * and not about a statement that took no time.
 *
 * Timings are taken `repeats` times per statement and trimmed by median absolute deviation, because
 * a single reading on a loaded machine is a sample from a distribution whose right tail belongs to
 * the scheduler. The reference implementation runs each statement 100 times and drops outliers; the
 * default here is 5, which is what a CI runner can afford, and the count is written into the
 * artifact so a reader never has to guess which of the two numbers they are looking at.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { runIfEntry } from '../entry.js';

/** Where the reward table steps. Ordered from the fastest band to the slowest. */
export const RVES_BANDS = [
  { atLeast: 2, reward: 1.25, label: 'at least twice as fast' },
  { atLeast: 1, reward: 1, label: 'at least as fast' },
  { atLeast: 0.5, reward: 0.75, label: 'within a factor of two' },
  { atLeast: 0.25, reward: 0.5, label: 'between a quarter and a half' },
  { atLeast: 0, reward: 0.25, label: 'slower than a quarter' },
] as const;

/** The reward a correct statement earns at time ratio `tau`. A wrong answer earns nothing. */
export function rewardFor(tau: number): number {
  // A ratio that is not a measurement earns nothing, and so does an impossible one: the table's
  // slowest band pays for a statement that ran and was slow, not for a number no clock produced.
  // Both cases fall out of the loop without a guard of their own — `NaN >= x` is false for every
  // band, and so is `-1 >= 0` — which is why this is a loop and not a `find` with a fallback.
  if (tau === Number.POSITIVE_INFINITY) return RVES_BANDS[0].reward;
  for (const band of RVES_BANDS) {
    if (tau >= band.atLeast) return band.reward;
  }
  return 0;
}

/**
 * `time(gold) / time(predicted)`, in whatever unit both sides share.
 *
 * A predicted statement measured at zero and a gold statement measured at zero are the same
 * statement as far as this clock can tell, so the ratio is 1: a band that paid 1.25 for "no time
 * at all" would reward the resolution of the stopwatch rather than the query.
 */
export function timeRatio(goldTime: number, predictedTime: number): number {
  if (!Number.isFinite(goldTime) || goldTime < 0) return Number.NaN;
  if (!Number.isFinite(predictedTime) || predictedTime < 0) return Number.NaN;
  if (predictedTime > 0) return goldTime / predictedTime;
  return goldTime > 0 ? Number.POSITIVE_INFINITY : 1;
}

/**
 * The mean of the timings that survive a median-absolute-deviation trim.
 *
 * `undefined` when nothing survives: an empty sample is not a fast statement, and returning 0 here
 * would let a failed measurement win the top band.
 */
export function cleanTimings(samples: readonly number[]): number | undefined {
  const kept = samples.filter((value) => Number.isFinite(value) && value >= 0);
  if (kept.length === 0) return undefined;
  const sorted = [...kept].sort((left, right) => left - right);
  // Timing noise is additive: the scheduler and the page cache can make a statement slower and
  // never faster. With two samples there is no spread a trim can trust, so the fastest observation
  // is the least contaminated estimate, which is also why a benchmark harness that takes the
  // minimum is not cheating.
  if (sorted.length < 3) return sorted[0];
  const median = middle(sorted);
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((left, right) => left - right);
  const spread = middle(deviations);
  // A sample with no spread is a statement that took the same time every run; there is no outlier
  // to trim, and a window of zero width would delete the whole sample.
  const survivors = spread === 0 ? sorted : sorted.filter((value) => Math.abs(value - median) <= 3 * spread);
  return survivors.reduce((total, value) => total + value, 0) / survivors.length;
}

/**
 * The middle of a sorted sample: the member itself when the count is odd, the mean of the two
 * middle members when it is even.
 *
 * Written once because the trim uses it twice, and because `sorted[floor(n/2)]` — the shape this
 * had first — reports the upper member of an even sample, which on a two-value sample of
 * `[100, 10000]` is the outlier.
 */
function middle(sorted: readonly number[]): number {
  // Callers pass a non-empty sample: `cleanTimings` returns before this when nothing survived, and
  // the deviations are the same length as the sample. `bounded` is that fact written once, so the
  // four reads below do not each carry a `?? 0` for a branch no input can take.
  if (sorted.length % 2 === 1) return bounded(sorted, (sorted.length - 1) / 2);
  return (bounded(sorted, sorted.length / 2 - 1) + bounded(sorted, sorted.length / 2)) / 2;
}

/** A read the caller has bounded. The cast is the bound, and it is stated here rather than four times. */
function bounded(list: readonly number[], index: number): number {
  return list[index] as number;
}

export interface VesCase {
  readonly id: string;
  /** Whether the result set matched the gold statement's. */
  readonly correct: boolean;
  readonly goldTime: number;
  readonly predictedTime: number;
}

export interface VesBand {
  readonly label: string;
  readonly cases: number;
}

export interface VesReading {
  /** Questions scored, which is the denominator of `rves`. */
  readonly cases: number;
  /** Correct statements that were also timed. */
  readonly valid: number;
  /** Correct but unmeasurable: the statement would not time on one side or the other. */
  readonly unmeasured: number;
  /** Mean reward over all questions, the normalisation the leaderboard's numbers imply. */
  readonly rves: number;
  /** Mean reward over the correct statements only, printed so the choice is visible. */
  readonly rvesOfValid: number;
  readonly bands: readonly VesBand[];
}

/** The label each reward carries, so a count is a lookup rather than a search. */
const LABEL_OF_REWARD = new Map<number, string>(RVES_BANDS.map((band) => [band.reward, band.label]));

/** The reading over a set of cases. Wrong answers contribute 0 and are still counted. */
export function rvesOf(cases: readonly VesCase[]): VesReading {
  const total = cases.length;
  const counts = new Map<string, number>(RVES_BANDS.map((band) => [band.label, 0]));
  let valid = 0;
  let reward = 0;
  for (const entry of cases) {
    if (!entry.correct) continue;
    const tau = timeRatio(entry.goldTime, entry.predictedTime);
    if (Number.isNaN(tau)) continue;
    valid += 1;
    const earned = rewardFor(tau);
    reward += earned;
    // Every reward the table pays is one of its own five labels, so the label is a lookup and not a
    // search with a fallback; a search is how a band that pays something new would silently vanish
    // from the counts instead of failing a test.
    const label = LABEL_OF_REWARD.get(earned) as string;
    counts.set(label, (counts.get(label) as number) + 1);
  }
  return {
    cases: total,
    valid,
    unmeasured: cases.filter((entry) => entry.correct).length - valid,
    rves: total === 0 ? 0 : reward / total,
    rvesOfValid: valid === 0 ? 0 : reward / valid,
    bands: RVES_BANDS.map((band) => ({ label: band.label, cases: counts.get(band.label) as number })),
  };
}

/** What the runner has to answer for one execution: the microseconds, and whether it ran. */
export interface TimedRun {
  readonly ok: boolean;
  readonly us: number;
}

export type StatementTimer = (db: string, sql: string) => Promise<TimedRun>;

export interface VesCandidate {
  readonly id: string;
  readonly db: string;
  readonly gold: string;
  readonly predicted?: string;
  readonly correct: boolean;
}

/**
 * Time both statements of every correct candidate and read the reward table over them.
 *
 * A gold statement that fails to run is not a zero-time gold statement: the case is `unmeasured`
 * and contributes to neither mean, which is why `unmeasured` is reported rather than folded into
 * `valid`. A predicted statement that fails is impossible in a correct case by construction — the
 * result set matched — but the same guard covers an artifact whose judge and executor disagree.
 */
export async function measureVes(
  candidates: readonly VesCandidate[],
  timer: StatementTimer,
  repeats: number,
): Promise<VesReading> {
  const runs = Math.max(1, Math.floor(repeats));
  const cases: VesCase[] = [];
  for (const candidate of candidates) {
    if (!candidate.correct || candidate.predicted === undefined) {
      cases.push({ id: candidate.id, correct: false, goldTime: 0, predictedTime: 0 });
      continue;
    }
    const gold = await meanTime(timer, candidate.db, candidate.gold, runs);
    const predicted = await meanTime(timer, candidate.db, candidate.predicted, runs);
    // A statement that would not time is `unmeasured`, not wrong. Charging it as a wrong answer
    // would let the executor's failure look like the system's, and the two are different facts
    // about different components. `NaN` is how `rvesOf` tells them apart.
    cases.push({
      id: candidate.id,
      correct: true,
      goldTime: gold ?? Number.NaN,
      predictedTime: predicted === undefined ? Number.NaN : predicted,
    });
  }
  return rvesOf(cases);
}

/** One statement timed `runs` times, trimmed. `undefined` when it never executed. */
async function meanTime(
  timer: StatementTimer,
  db: string,
  sql: string,
  runs: number,
): Promise<number | undefined> {
  const samples: number[] = [];
  for (let attempt = 0; attempt < runs; attempt += 1) {
    const result = await timer(db, sql);
    if (!result.ok) return undefined;
    samples.push(result.us);
  }
  return cleanTimings(samples);
}

/** The reading as the lines a workflow log prints. */
export function describeVes(reading: VesReading, repeats: number): string[] {
  const lines = [
    `R-VES ${(reading.rves * 100).toFixed(2)}% over ${reading.cases} questions`
      + ` (mean over the valid ones: ${(reading.rvesOfValid * 100).toFixed(2)}%)`,
    `R-VES timed every statement ${repeats}x and trimmed by median absolute deviation`,
  ];
  for (const band of reading.bands) {
    if (band.cases === 0) continue;
    lines.push(`R-VES ${band.label}: ${band.cases}`);
  }
  if (reading.unmeasured > 0) {
    lines.push(`R-VES ${reading.unmeasured} correct statements could not be timed on one side`);
  }
  return lines;
}

interface VesArtifactCase {
  readonly arm?: string;
  readonly id?: string | number;
  readonly passed?: boolean;
  readonly winnerSource?: string;
  readonly candidates?: readonly { readonly source?: string; readonly sql?: string }[];
}

interface VesQuestion {
  readonly question_id: number;
  readonly db_id: string;
  readonly SQL: string;
}

/**
 * The pairs a timing run needs, read from an artifact and the question file it was scored against.
 *
 * The predicted statement is the one the arm *returned*, resolved through `winnerSource` rather than
 * guessed from the first candidate: an arm that drew three statements and chose the second was, for
 * the purposes of what a caller receives, the second.
 */
export function vesCandidates(
  artifactCases: readonly VesArtifactCase[],
  questions: readonly VesQuestion[],
  arm: string,
): VesCandidate[] {
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));
  const out: VesCandidate[] = [];
  for (const row of artifactCases) {
    if (row.arm !== arm || row.id === undefined) continue;
    const question = byId.get(String(row.id));
    if (question === undefined) continue;
    const chosen = row.winnerSource === undefined
      ? row.candidates?.[0]
      : row.candidates?.find((candidate) => candidate.source === row.winnerSource) ?? row.candidates?.[0];
    out.push({
      id: String(row.id),
      db: question.db_id,
      gold: question.SQL,
      ...(typeof chosen?.sql === 'string' ? { predicted: chosen.sql } : {}),
      correct: row.passed === true,
    });
  }
  return out;
}

export interface VesOptions {
  readonly artifact: string;
  readonly dataset: string;
  readonly arm: string;
  readonly repeats: number;
  readonly databases: string;
  readonly oracle: string;
  readonly out?: string;
}

/** Argument parsing, kept separate so the tool's behaviour can be tested without a process. */
export function parseVesArgs(argv: readonly string[]): VesOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) continue;
    values.set(token.slice(2), next);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new Error(`--${name} is required`);
    return value;
  };
  const repeats = Number(values.get('repeats') ?? '5');
  if (!Number.isFinite(repeats) || repeats < 1) throw new Error('--repeats must be a positive number');
  return {
    artifact: required('artifact'),
    dataset: required('dataset'),
    arm: required('arm'),
    repeats: Math.floor(repeats),
    databases: values.get('databases') ?? 'eval/.cache/bird/dev_databases',
    oracle: values.get('oracle') ?? 'eval/bird/oracle.py',
    ...(values.get('out') === undefined ? {} : { out: String(values.get('out')) }),
  };
}

/** The default timer: one long-lived Python process, exactly as the evaluation uses it. */
export async function openTimer(oracleScript: string, databaseRoot: string): Promise<{
  timer: StatementTimer;
  close: () => Promise<void>;
}> {
  const { createOracle } = await import('./oracle.js');
  const oracle = createOracle(oracleScript, databaseRoot);
  return {
    timer: async (db, sql) => {
      const result = await oracle.run(db, sql);
      return { ok: result.ok, us: result.us ?? result.ms * 1000 };
    },
    close: () => oracle.close(),
  };
}

/** Run the tool. Returns the process exit code; throws only on a malformed invite. */
export async function main(
  argv: readonly string[],
  log: (line: string) => void = (line) => console.log(line),
  open: (script: string, root: string) => Promise<{ timer: StatementTimer; close: () => Promise<void> }> = openTimer,
): Promise<number> {
  const options = parseVesArgs(argv);
  const artifact = JSON.parse(readFileSync(options.artifact, 'utf8')) as { cases?: readonly VesArtifactCase[] };
  const questions = JSON.parse(readFileSync(options.dataset, 'utf8')) as readonly VesQuestion[];
  const candidates = vesCandidates(artifact.cases ?? [], questions, options.arm);
  if (candidates.length === 0) {
    log(`R-VES no cases for arm ${options.arm} in ${options.artifact}`);
    return 1;
  }
  const { timer, close } = await open(options.oracle, options.databases);
  try {
    const reading = await measureVes(candidates, timer, options.repeats);
    for (const line of describeVes(reading, options.repeats)) log(line);
    if (options.out !== undefined) {
      writeFileSync(options.out, `${JSON.stringify({
        instrument: 'eval/bird/ves.ts',
        arm: options.arm,
        artifact: options.artifact,
        repeats: options.repeats,
        normalization: 'mean over all scored questions; the valid-only mean is reported beside it',
        ...reading,
      }, null, 1)}\n`);
    }
    return 0;
  } finally {
    await close();
  }
}

/**
 * The workflow's way in, exported so the guard's taken branch is a call a test can make.
 *
 * A module-scope `if (isEntry) …` is the shape `eval/entry.ts` was written to remove: the branch is
 * taken once, in a process no test can enter, so it is either uncovered or covered by a subprocess
 * whose coverage is not counted.
 */
export function runAsEntry(
  argv1: string | undefined,
  moduleUrl: string,
  argv: readonly string[],
  target: { exitCode?: number | string | null } = process,
): Promise<void> | undefined {
  return runIfEntry(argv1, moduleUrl, () => main(argv))?.then((code) => {
    target.exitCode = code;
  });
}

runAsEntry(process.argv[1], import.meta.url, process.argv.slice(2));
