/**
 * Does the k-th candidate pay for itself?
 *
 * `pool-replay --compositions` prices every subset of a pool and prints the table. It does not say
 * which row to act on, and the gap between printing a table and making a decision is where this
 * repository has made its expensive mistakes: the composition table on 600 questions read "371 for
 * one call, 387 for three" and the sentence that followed it in `docs/benchmarks.md` was written by
 * a person. A person is the wrong owner of an arithmetic question.
 *
 * So this harness answers the arithmetic question directly. For every subset size it takes the
 * **best** subset, pairs it with the best subset one call smaller, and asks the only question a
 * bill can be paid against: *is the increment larger than this split can resolve?* Three things
 * make the answer trustworthy rather than plausible:
 *
 * 1. **The pair is paired.** Two subsets of one artifact run on the same questions, so the
 *    comparison is discordant cases — the ones they disagreed about — and not two rates. The
 *    exact McNemar tail and the Wald interval come from `devkit`, the two producers every other
 *    reading in this repository goes through; a second implementation of a statistic inside an
 *    instrument would be a second opinion about what a reading means.
 * 2. **The margin is declared, not chosen after the fact.** `--margin` defaults to the dev split's
 *    published 2.30pp, which is the smallest effect 1,532 paired questions resolve at 80% power.
 *    An increment below it is not a small gain, it is an unmeasured one, and the harness prints
 *    that sentence rather than "trending positive".
 * 3. **The subset's own vote is the policy.** A subset is scored by `vote` on the candidates it
 *    contains, which is the same function `compositions` uses — and the tests hold the two to
 *    identical counts on a real artifact. That identity is the whole reason this file can price a
 *    subset instead of a policy.
 *
 * What it deliberately does not do: it does not compare a subset against an arm it did not run.
 * `macsql-bird-os` scoring 1,007 on 1,532 questions is a *different run*, and pairing across runs
 * prices the runs as much as the change. Every number this file prints comes from one artifact.
 *
 * ## Why the shipped product reads this and not the other way round
 *
 * The output is a decision, so it is written as one: `pays` or `cannot pay`, with the increment,
 * the price in calls, and the p-value that decided it. A round that wants to ship a wider pool has
 * to move that line from `cannot pay` to `pays` first, and the change that would do it — a source
 * that answers questions the pool misses — is a fact about the corpus rather than about the judge.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mcnemarExact, pairedResolution } from '@agentix-e/nl2charts-devkit';
import { POLICIES, casesOf, widestArm } from '../../tools/pool-replay.mjs';
import type { ReplayRow } from '../../tools/pool-replay.mjs';
import { isEntry } from './compare.js';

/** The subset size above which the enumeration is refused rather than run. */
export const MAX_SOURCES = 6;

/** The dev split's published MDE, used when a caller does not state one. */
export const DEFAULT_MARGIN_PP = 2.3;

/** One subset's score over the cases it decided. */
export interface SubsetScore {
  /** The sources in the subset, sorted: the name a report prints. */
  readonly sources: readonly string[];
  /** Calls per case the subset costs: one generation a source. */
  readonly calls: number;
  /** Cases where the vote over this subset answered correctly. */
  readonly correct: number;
  /** Cases the subset decided at all; a vote over rows that all came back empty decides nothing. */
  readonly scored: number;
  /** Cases the subset left undecided. */
  readonly undecided: number;
}

/** A paired comparison of two subsets over one artifact. */
export interface SubsetPair {
  readonly left: SubsetScore;
  readonly right: SubsetScore;
  /** Cases both subsets decided, which is the only denominator a pair may use. */
  readonly cases: number;
  /** Cases both answered correctly. */
  readonly both: number;
  /** Cases only the right subset answered correctly. */
  readonly onlyRight: number;
  /** Cases only the left subset answered correctly. */
  readonly onlyLeft: number;
  /** Cases neither answered correctly. */
  readonly neither: number;
  /** The right-hand increment over the left, in percentage points of the paired cases. */
  readonly deltaPp: number;
  /** Exact McNemar tail for `onlyRight` against `onlyLeft`. */
  readonly p: number;
  /** Wald interval on the increment, in percentage points. */
  readonly ci: { readonly low: number; readonly high: number };
  /** Calls the right subset spends per case more than the left. */
  readonly extraCalls: number;
}

/** What the harness decided about one increment. */
export interface MarginalVerdict {
  readonly pair: SubsetPair;
  readonly pays: boolean;
  /** The sentence a report quotes: the decision, not the direction. */
  readonly sentence: string;
}

/**
 * The vote policy, which is how a subset is scored.
 *
 * Named once and cast once: `compositions` in the tool takes the modal group directly, and this
 * harness has to take the *same* function or the two would be two definitions of one reading. The
 * cast rather than a `throw` keeps the failure where a missing export belongs — module load — and
 * keeps an unreachable branch out of a file the coverage gate reads line by line.
 */
const VOTE = POLICIES.find((candidate) => candidate.name === 'vote') as (typeof POLICIES)[number];

/** The sources an artifact's pools are drawn from, sorted so two runs enumerate in one order. */
export function sourcesOf(rows: readonly ReplayRow[]): string[] {
  const names = new Set<string>();
  for (const row of rows) for (const candidate of row.candidates ?? []) if (typeof candidate.source === 'string' && candidate.source.length > 0) names.add(candidate.source);
  return [...names].sort((left, right) => left.localeCompare(right));
}

/**
 * One subset's per-case verdict.
 *
 * The row handed to the policy carries only the subset's candidates, which is exactly what a
 * two-call pipeline would have had: the policy reads the pool it is given and nothing else. Rows
 * whose candidates are all outside the subset are dropped rather than scored false — a question a
 * subset never saw is not a question it got wrong.
 */
export function subsetOutcomes(rows: readonly ReplayRow[], sources: readonly string[]): Map<string, boolean> {
  const decide = VOTE.decide;
  const wanted = new Set(sources);
  const outcomes = new Map<string, boolean>();
  for (const row of rows) {
    const candidates = (row.candidates ?? []).filter((candidate) => typeof candidate.source === 'string' && wanted.has(candidate.source));
    if (candidates.length === 0) continue;
    const id = row.id === undefined ? undefined : String(row.id);
    if (id === undefined) continue;
    const outcome = decide({ ...row, candidates });
    if (outcome !== undefined) outcomes.set(id, outcome);
  }
  return outcomes;
}

/** Score one subset: how many cases it decided and how many of those it got right. */
export function scoreSubset(rows: readonly ReplayRow[], sources: readonly string[]): SubsetScore {
  const outcomes = subsetOutcomes(rows, sources);
  let correct = 0;
  for (const outcome of outcomes.values()) if (outcome) correct += 1;
  const considered = rows.filter((row) => (row.candidates ?? []).some((candidate) => typeof candidate.source === 'string' && sources.includes(candidate.source))).length;
  return {
    sources: [...sources].sort((left, right) => left.localeCompare(right)),
    calls: sources.length,
    correct,
    scored: outcomes.size,
    undecided: considered - outcomes.size,
  };
}

/**
 * Pair two subsets over the cases both decided.
 *
 * The denominator is the intersection rather than either subset's total: two subsets that dropped
 * different cases would otherwise be compared on different questions, and a rate difference across
 * two denominators is not an effect. The interval is converted to percentage points and to the
 * right-hand subset's sign, which are the two conversions that would otherwise be silently wrong.
 */
export function pairSubsets(rows: readonly ReplayRow[], left: readonly string[], right: readonly string[]): SubsetPair {
  const leftOutcomes = subsetOutcomes(rows, left);
  const rightOutcomes = subsetOutcomes(rows, right);
  const shared = [...leftOutcomes.keys()].filter((id) => rightOutcomes.has(id));
  let both = 0;
  let onlyRight = 0;
  let onlyLeft = 0;
  let neither = 0;
  for (const id of shared) {
    const onLeft = leftOutcomes.get(id) === true;
    const onRight = rightOutcomes.get(id) === true;
    if (onLeft && onRight) both += 1;
    else if (onRight) onlyRight += 1;
    else if (onLeft) onlyLeft += 1;
    else neither += 1;
  }
  const cases = shared.length;
  const deltaPp = cases === 0 ? 0 : ((onlyRight - onlyLeft) / cases) * 100;
  // Called with the left subset first, so the interval comes back already signed as the right-hand
  // increment: `pairedResolution` reports on "only second minus only first", and "first" here is
  // the smaller pool. Negating it afterwards would be the same number with one more chance to be
  // wrong.
  const resolution = pairedResolution(onlyLeft, onlyRight, cases);
  return {
    left: scoreSubset(rows, left),
    right: scoreSubset(rows, right),
    cases,
    both,
    onlyRight,
    onlyLeft,
    neither,
    deltaPp,
    p: mcnemarExact(onlyRight, onlyLeft),
    // The interval is a fraction of the paired cases; the report is in percentage points, which is
    // the unit the margin is stated in and the unit a reader compares by eye.
    ci: { low: resolution.low * 100, high: resolution.high * 100 },
    extraCalls: right.length - left.length,
  };
}

/**
 * The best subset of each size, by the vote's own count.
 *
 * Ties go to the alphabetically earlier name so two runs of the harness on one artifact print the
 * same table: a path that moved between runs would make a changed reading indistinguishable from a
 * changed tie-break. The enumeration is refused above `MAX_SOURCES` rather than truncated, because
 * a "best subset" chosen from a truncated search is a claim nobody checked.
 */
export function bestBySize(rows: readonly ReplayRow[], sources: readonly string[]): SubsetScore[] {
  if (sources.length > MAX_SOURCES) {
    throw new Error(`${String(sources.length)} sources is more than this harness enumerates (${String(MAX_SOURCES)}): a best subset from a truncated search is not a best subset`);
  }
  const bySize = new Map<number, SubsetScore>();
  const total = 1 << sources.length;
  for (let mask = 1; mask < total; mask += 1) {
    const chosen = sources.filter((_, index) => (mask & (1 << index)) !== 0);
    const score = scoreSubset(rows, chosen);
    const held = bySize.get(score.calls);
    if (held === undefined || score.correct > held.correct || (score.correct === held.correct && score.sources.join(',').localeCompare(held.sources.join(',')) < 0)) {
      bySize.set(score.calls, score);
    }
  }
  return [...bySize.values()].sort((left, right) => left.calls - right.calls);
}

/**
 * The increment each extra call buys, against the margin.
 *
 * A subset that adds fewer correct answers than the margin is not rejected for being small: it is
 * rejected because at this sample size it has not been measured, and the sentence says so. That
 * distinction is the difference between a decision and a shrug, and this repository has printed the
 * shrug — "trending positive" — in prose for long enough that it is worth being unable to.
 */
export function marginal(rows: readonly ReplayRow[], margin = DEFAULT_MARGIN_PP): MarginalVerdict[] {
  return marginalFor(rows, bestBySize(rows, sourcesOf(rows)), margin);
}

/**
 * The same verdicts from a ladder the caller already enumerated.
 *
 * `main` needs the ladder for its table and the verdicts for its sentences, and enumerating twice
 * would price every subset twice for a reader who cannot see the difference. The separation is the
 * cheap kind: one function computes, the other decides.
 */
export function marginalFor(rows: readonly ReplayRow[], steps: readonly SubsetScore[], margin = DEFAULT_MARGIN_PP): MarginalVerdict[] {
  const verdicts: MarginalVerdict[] = [];
  for (let index = 1; index < steps.length; index += 1) {
    const left = steps[index - 1] as SubsetScore;
    const right = steps[index] as SubsetScore;
    const pair = pairSubsets(rows, left.sources, right.sources);
    const pays = pair.deltaPp >= margin && pair.p <= 0.05 && pair.ci.low > 0;
    const price = `+${String(pair.extraCalls)} call(s)`;
    const gain = `${pair.deltaPp >= 0 ? '+' : ''}${pair.deltaPp.toFixed(2)}pp`;
    verdicts.push({
      pair,
      pays,
      sentence: pays
        ? `${price} buys ${gain} over ${left.calls} call(s) at p=${pair.p.toFixed(4)} — above the ${margin.toFixed(2)}pp line, so the wider pool pays`
        : `${price} buys ${gain} at p=${pair.p.toFixed(4)} — under the ${margin.toFixed(2)}pp this split can resolve, so the wider pool cannot pay`,
    });
  }
  return verdicts;
}

/** Every line the report prints, in the order a reader needs them. */
export function reportLines(rows: readonly ReplayRow[], verdicts: readonly MarginalVerdict[], steps: readonly SubsetScore[] = []): string[] {
  const lines = [
    `marginal candidate value on ${String(rows.length)} cases with a pool`,
    '  calls  subset                                          correct   share   p       interval (pp)',
  ];
  const first = steps[0];
  if (first !== undefined) {
    const share = first.scored === 0 ? 0 : (first.correct / first.scored) * 100;
    lines.push(`  ${String(first.calls).padStart(5)}  ${first.sources.join('+').padEnd(46)} ${String(first.correct).padStart(7)} ${share.toFixed(2).padStart(7)}% ${'—'.padStart(7)}  —`);
  }
  for (const verdict of verdicts) {
    const { pair } = verdict;
    const share = pair.cases === 0 ? 0 : (pair.right.correct / Math.max(1, pair.right.scored)) * 100;
    lines.push(
      `  ${String(pair.right.calls).padStart(5)}  ${pair.right.sources.join('+').padEnd(46)} ${String(pair.right.correct).padStart(7)} ${share.toFixed(2).padStart(7)}% ` +
        `${pair.p.toFixed(4).padStart(7)}  [${pair.ci.low.toFixed(2)}, ${pair.ci.high.toFixed(2)}]`,
    );
    lines.push(`         ${verdict.sentence}`);
  }
  return lines;
}

/** The settings a command line produced. */
export interface PairSettings {
  readonly artifact: string;
  readonly margin: number;
  /** Two subsets named by the caller, when the question is about them rather than about the ladder. */
  readonly left?: readonly string[];
  readonly right?: readonly string[];
}

export function resolveSettings(argv: readonly string[]): PairSettings {
  const takesValue = new Set(['--artifact', '--margin', '--left', '--right']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--json') continue;
    if (takesValue.has(token)) {
      index += 1;
      continue;
    }
    throw new Error(`unrecognized argument ${token}: this harness takes --artifact <path>, --margin <pp> and --json`);
  }
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const artifact = flag('--artifact');
  if (artifact === undefined) throw new Error('--artifact is required: this harness reads an artifact rather than producing one');
  const raw = flag('--margin');
  const margin = raw === undefined ? DEFAULT_MARGIN_PP : Number(raw);
  if (!Number.isFinite(margin) || margin <= 0) throw new Error(`--margin takes a positive number of percentage points, not ${String(raw)}`);
  // A pair is named by two lists or by none: one of them alone is a question about nothing, and
  // reading it as "the other side is the whole pool" would price a comparison the caller did not
  // ask for.
  const left = flag('--left');
  const right = flag('--right');
  if ((left === undefined) !== (right === undefined)) throw new Error('--left and --right go together: a pair named on one side only has no comparison in it');
  const split = (value: string): readonly string[] => value.split(',').map((name) => name.trim()).filter(Boolean);
  const named = left === undefined || right === undefined ? {} : { left: split(left), right: split(right) };
  if (named.left !== undefined && (named.left.length === 0 || (named.right ?? []).length === 0)) {
    throw new Error('--left and --right take comma-separated source names, and an empty side is not a subset');
  }
  return { artifact, margin, ...named };
}

/**
 * Build rows that answer a question the artifact does not contain.
 *
 * The self-test needs cases where an increment is real and cases where it is not, and a real
 * artifact has already decided which it is. Synthesising both is the only way to observe both
 * branches of the verdict — a harness whose "cannot pay" path has never printed is a harness that
 * has only been read on its happy side.
 */
function synthetic(kind: 'pays' | 'cannot'): ReplayRow[] {
  const rows: ReplayRow[] = [];
  for (let index = 0; index < 200; index += 1) {
    const odd = index % 2 === 1;
    if (kind === 'pays') {
      // Each source is right on half the cases and the fixture lists the correct one first, so a
      // tied pair takes the right answer every time: 100 for either source alone, 200 for the pair.
      const a = { source: 'a', correct: odd, fingerprint: `a${String(index)}${odd ? 'r' : 'w'}` };
      const b = { source: 'b', correct: !odd, fingerprint: `b${String(index)}${odd ? 'w' : 'r'}` };
      rows.push({ id: String(index), arm: 'synthetic', candidates: odd ? [a, b] : [b, a] });
    } else {
      // One swap and one agreement: `b` answers the question `a` misses on the first case and loses
      // the second, so the pair answers one fewer than the better single — an increment of -1 case.
      const aRight = index > 1;
      rows.push({
        id: String(index),
        arm: 'synthetic',
        candidates: [
          { source: 'a', correct: aRight, fingerprint: `a${String(index)}${String(aRight)}` },
          { source: 'b', correct: index === 0 ? true : aRight, fingerprint: `b${String(index)}${String(index === 0 || aRight)}` },
        ],
      });
    }
  }
  return rows;
}

/** Prove the verdict can say both things, or report why it could not. */
export function selfTest(pair: typeof marginal = marginal): readonly string[] {
  const problems: string[] = [];
  const wide = pair(synthetic('pays'));
  const narrow = pair(synthetic('cannot'));
  if (wide.length !== 1 || !wide[0]?.pays) problems.push(`a +20pp increment over 200 cases was not accepted: ${wide.map((entry) => entry.sentence).join('; ')}`);
  if (narrow.length !== 1 || narrow[0]?.pays) problems.push(`a 1:1 increment over 200 cases was accepted: ${narrow.map((entry) => entry.sentence).join('; ')}`);
  // The identity the whole reading rests on: the paired halves must add up to the difference
  // between the two subsets' own counts. A pair built from mismatched denominators satisfies
  // neither number and prints both, which is the shape of four document defects in this repository.
  for (const verdict of [...wide, ...narrow]) {
    const implied = verdict.pair.onlyRight - verdict.pair.onlyLeft;
    const observed = verdict.pair.right.correct - verdict.pair.left.correct;
    if (implied !== observed) problems.push(`the discordant counts imply ${String(implied)} answers, the subset totals ${String(observed)}`);
  }
  return problems;
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  log: (line: string) => void = console.log,
  check: typeof selfTest = selfTest,
): number {
  if (argv.includes('--self-test')) {
    const problems = check();
    for (const problem of problems) log(`FAILED ${problem}`);
    log(`marginal self-test: 1 accepted, 1 refused${problems.length === 0 ? '' : `, ${String(problems.length)} problems`}`);
    return problems.length === 0 ? 0 : 1;
  }
  const settings = resolveSettings(argv);
  const artifact = JSON.parse(readFileSync(settings.artifact, 'utf8')) as { cases?: readonly ReplayRow[] };
  // One arm, not the artifact: two arms are two pools drawn by two configurations, and a subset
  // that mixes them prices a pipeline nobody ran. `widestArm` is the same default `pool-replay`
  // uses, so the two tools describe one pool.
  const arm = widestArm(artifact);
  if (arm === undefined) throw new Error(`${settings.artifact} carries no case with a candidate pool, so there is no subset to price`);
  const rows = casesOf(artifact, arm);
  if (rows.length === 0) {
    // `widestArm` names an arm as soon as a case exists, and an arm whose cases all lack a candidate
    // set is a dispatch of one-call arms: a legal artifact with nothing to pool, refused by name
    // rather than summarised as "one source", which is the reading for a pool of size one.
    throw new Error(`${settings.artifact} carries no case with a candidate pool on arm ${arm}, so there is no subset to price`);
  }
  const namedPair =
    settings.left === undefined || settings.right === undefined
      ? undefined
      : pairSubsets(rows, settings.left, settings.right);
  if (namedPair !== undefined) {
    const pays = namedPair.deltaPp >= settings.margin && namedPair.p <= 0.05 && namedPair.ci.low > 0;
    const line =
      `${namedPair.left.sources.join('+')} -> ${namedPair.right.sources.join('+')}: ` +
      `${namedPair.deltaPp >= 0 ? '+' : ''}${namedPair.deltaPp.toFixed(2)}pp over ${String(namedPair.cases)} paired cases, ` +
      `p=${namedPair.p.toFixed(4)}, CI [${namedPair.ci.low.toFixed(2)}, ${namedPair.ci.high.toFixed(2)}]pp, ` +
      `${String(namedPair.extraCalls)} extra call(s): ${pays ? 'pays' : 'cannot pay'} at ${settings.margin.toFixed(2)}pp`;
    if (argv.includes('--json')) log(JSON.stringify({ artifact: settings.artifact, arm, pair: namedPair, pays }, null, 2));
    else for (const text of [line, `  ${namedPair.both} both · ${namedPair.onlyRight} only ${namedPair.right.sources.join('+')} · ${namedPair.onlyLeft} only ${namedPair.left.sources.join('+')} · ${namedPair.neither} neither`]) log(text);
    return 0;
  }
  const steps = bestBySize(rows, sourcesOf(rows));
  const verdicts = marginalFor(rows, steps, settings.margin);
  if (argv.includes('--json')) {
    log(JSON.stringify({ artifact: settings.artifact, arm, cases: rows.length, margin: settings.margin, verdicts }, null, 2));
    return 0;
  }
  for (const line of reportLines(rows, verdicts, steps)) log(line);
  const first = verdicts[0];
  log(first === undefined ? '  verdict: one source, nothing to add' : `  verdict: ${first.pays ? 'a wider pool pays' : 'a wider pool cannot pay at this margin'}`);
  return 0;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}

/** Kept for the tests: the root this file's relative paths resolve against. */
export const ROOT = resolve(new URL('../..', import.meta.url).pathname);
