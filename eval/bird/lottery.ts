/**
 * How much of an A/A delta the pool's own composition can produce.
 *
 * The gate reads `report.aa.delta` against a constant tolerance, and `43535849969` is the run that
 * made that constant look arbitrary: the same arm, twice, differed by **4.23pp** against a 4pp
 * threshold, so the run was refused. The artifact says what the refusal could not:
 *
 *   - 496 of 496 cases were sent byte-identical prompts (identical `tokens.prompt`), drew the same
 *     number of candidates (identical `calls`), and were served by the same base (`deepseek-flash`);
 *   - the A/A halves show no positional signature at all — the correlation between a case's
 *     position in the split and whether it passed is -0.09 in each half, and their per-decile pass
 *     rates trace the same shape, which is the split's difficulty order rather than a warm-up;
 *   - so the difference is in *which statements the model emitted*, not in what it was shown.
 *
 * That last sentence is a claim about a distribution, and it can be tested without spending a call.
 * Take the widest pool an arm kept, hold it fixed as the universe of shapes the endpoint offered on
 * that case, and draw `k` of them twice. That is the lottery a `k`-candidate arm plays on every
 * case, and its delta is the A/A reading a *stable* draw distribution would produce. If the
 * observed delta sits inside that band, the harness is stable and the noise is the draw. If it sits
 * outside, the draw distribution itself moved between the halves — and that is the one part of the
 * noise interleaving cannot remove, because interleaving changes when a case is asked, not which
 * statements the model writes.
 *
 * Two numbers come out of it and both are published:
 *
 *   - **the lottery band**, in percentage points, at 95% — computable from any artifact that kept
 *     its candidate records, with no model call and no database;
 *   - **the resolution**, `max(paired MDE, lottery 95%)`, which is the smallest delta a claim from
 *     this run can rest on.
 *
 * The instrument is deliberately one-sided in what it assumes: it never claims the model's draws
 * are independent. Holding the offered pool fixed makes the lottery the *narrowest* possible noise
 * model, so a delta beyond it is beyond every model that assumes the offered shapes were stable.
 *
 * Precedent for reading a pool as a distribution rather than a set: self-consistency prices `k`
 * samples as a vote (Wang et al., 2022) and MCS-SQL's ablation separates "more prompts" from "more
 * samples of one prompt" (73.34 -> 71.02 on BIRD dev when its five prompts collapse to one). This
 * harness asks the question those two leave open — how much of a *repeated* run's difference the
 * pool can explain — and answers it from an artifact that was already paid for.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { declaresCandidateSet, scoredQuestions } from './artifact.js';
import { candidateCases, largestPool } from './diversity.js';
import type { DiversityArtifact } from './diversity.js';
import { pairedResolution } from '@agentix-e/nl2charts-devkit';

/**
 * The sample floor every instrument in this repository uses before it prices anything.
 *
 * A band taken over forty cases is a band taken over the draw, and the number it prints would be
 * read as a property of the harness.
 */
export const LOTTERY_MINIMUM_SAMPLE = 100;

/**
 * The A/A block and the per-case fields this instrument reads.
 *
 * `cases` and `arms` are narrowed rather than extended so one interface describes the whole
 * artifact: `diversity.ts` reads a case's candidates and an arm's ceiling, this instrument also
 * reads a case's `candidateRecall` and an arm's declared `samples`, and two names for one field is
 * how one of them comes to be missing.
 */
export interface LotteryArtifact extends Omit<DiversityArtifact, 'arms' | 'cases'> {
  readonly aa?: {
    readonly arm?: unknown;
    readonly delta?: unknown;
    readonly mde?: unknown;
    readonly total?: unknown;
  };
  readonly arms?: readonly { readonly arm?: unknown; readonly candidateRecall?: unknown; readonly samples?: unknown }[];
  readonly cases?: readonly {
    readonly id?: unknown;
    readonly arm?: unknown;
    readonly passed?: unknown;
    readonly candidateRecall?: unknown;
    readonly candidates?: readonly { readonly source?: unknown; readonly correct?: unknown; readonly fingerprint?: unknown }[];
  }[];
}

/** One replicate's answer: the delta an A/A pair would read if only the drawn subset varied. */
export function drawDelta(universe: readonly (readonly boolean[])[], draws: number, random: () => number): number {
  let first = 0;
  let second = 0;
  for (const flags of universe) {
    // A case whose pool is no wider than the draw contributes to both halves or to neither: the two
    // draws take the whole pool, so the pair agrees by construction. Counting it keeps the
    // denominator the population the arm scored, which is what the observed delta is a share of.
    if (flags.length <= draws) {
      if (flags.some(Boolean)) {
        first += 1;
        second += 1;
      }
      continue;
    }
    if (sampleOf(flags.length, draws, random).some((index) => flags[index] === true)) first += 1;
    if (sampleOf(flags.length, draws, random).some((index) => flags[index] === true)) second += 1;
  }
  return (second - first) / universe.length;
}

/**
 * `k` distinct indices out of `size`, in draw order.
 *
 * A partial Fisher-Yates over an index array, which is uniform over k-subsets and — unlike a
 * rejection loop — terminates when `k` is close to `size`. The all-of-them case returns the whole
 * permutation rather than a short draw, because a pool that cannot be sampled from is a pool the
 * caller has already excluded.
 */
export function sampleOf(size: number, k: number, random: () => number): number[] {
  const indices = Array.from({ length: size }, (_, index) => index);
  const take = Math.min(k, size);
  for (let at = 0; at < take; at += 1) {
    const swap = at + Math.floor(random() * (size - at));
    const held = indices[at] as number;
    indices[at] = indices[swap] as number;
    indices[swap] = held;
  }
  return indices.slice(0, take);
}

/**
 * A deterministic stream of uniforms, so a published band can be reproduced.
 *
 * `Math.random` would make every reading a different number, and the whole point of this instrument
 * is that two readers of one artifact get one answer. mulberry32: 32 bits of state, one multiply
 * per output, and no dependency.
 */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LotteryNoise {
  readonly cases: number;
  readonly draws: number;
  readonly replicates: number;
  readonly mean: number;
  readonly sd: number;
  /** The 2.5th and 97.5th percentile of the replicate deltas, in shares. */
  readonly low: number;
  readonly high: number;
}

export function lotteryNoise(
  universe: readonly (readonly boolean[])[],
  draws: number,
  options: { readonly replicates: number; readonly seed: number },
): LotteryNoise {
  const random = seeded(options.seed);
  const deltas: number[] = [];
  for (let index = 0; index < options.replicates; index += 1) deltas.push(drawDelta(universe, draws, random));
  deltas.sort((left, right) => left - right);
  const mean = deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
  const variance = deltas.reduce((sum, delta) => sum + (delta - mean) * (delta - mean), 0) / deltas.length;
  return {
    cases: universe.length,
    draws,
    replicates: options.replicates,
    mean,
    sd: Math.sqrt(variance),
    low: deltas[Math.floor(0.025 * deltas.length)] as number,
    high: deltas[Math.min(deltas.length - 1, Math.ceil(0.975 * deltas.length) - 1)] as number,
  };
}

/** What the run itself measured, in the two quantities the lottery can be compared against. */
export interface LotteryObserved {
  /** The gate's number: the difference in published accuracy between the pair. */
  readonly score: number;
  /** The ceiling's number: the difference in "the pool held an answer", when the pair's rows exist. */
  readonly ceiling?: number;
  readonly mde?: number;
  readonly cases: number;
}

export interface LotteryRead {
  readonly arm: string;
  readonly cases: number;
  readonly draws: number;
  /** The widest pool the arm kept on any case, which is the draw a wider one would sample from. */
  readonly widest: number;
  /** Whether any case could be drawn from a pool wider than `draws`, i.e. whether a lottery exists. */
  readonly wide: boolean;
  readonly lottery: LotteryNoise;
  readonly observed?: LotteryObserved;
}

export interface LotteryOptions {
  readonly arm: string | undefined;
  readonly draws: number | undefined;
  readonly replicates: number;
  readonly seed: number;
}

/** The candidate count an arm declared, which is the draw this instrument prices by default. */
function declaredSamples(report: LotteryArtifact, arm: string): number | undefined {
  for (const row of report.arms ?? []) {
    if (row.arm === arm && typeof row.samples === 'number' && Number.isFinite(row.samples) && row.samples >= 1) return row.samples;
  }
  return undefined;
}

/**
 * The A/A pair's own numbers, read from its rows when the artifact kept them.
 *
 * The ceiling needs both halves' `candidateRecall`, and a run that asked for an A/A without keeping
 * candidate records has only the score. The two are reported separately rather than merged: the
 * score carries the selector's tie-breaks on top of the pool, so it is *larger* than what the pool
 * alone can explain, and comparing the score to a pool band would read the selector as noise.
 */
function observedOf(report: LotteryArtifact): LotteryObserved | undefined {
  const aa = report.aa;
  if (aa === undefined || typeof aa.delta !== 'number' || !Number.isFinite(aa.delta)) return undefined;
  const first = typeof aa.arm === 'string' ? aa.arm : undefined;
  const second = first === undefined ? undefined : `${first}#2`;
  const cases = typeof aa.total === 'number' ? aa.total : 0;
  const base: LotteryObserved = {
    score: aa.delta,
    ...(typeof aa.mde === 'number' ? { mde: aa.mde } : {}),
    cases,
  };
  if (first === undefined || second === undefined) return base;
  const held = new Map<string, boolean>();
  for (const row of report.cases ?? []) {
    if (row.arm !== first || typeof row.id !== 'string') continue;
    if (typeof row.candidateRecall === 'boolean') held.set(row.id, row.candidateRecall);
  }
  let onlyFirst = 0;
  let onlySecond = 0;
  let paired = 0;
  for (const row of report.cases ?? []) {
    if (row.arm !== second || typeof row.id !== 'string' || typeof row.candidateRecall !== 'boolean') continue;
    const mine = held.get(row.id);
    if (mine === undefined) continue;
    paired += 1;
    if (mine && !row.candidateRecall) onlyFirst += 1;
    if (!mine && row.candidateRecall) onlySecond += 1;
  }
  if (paired === 0) return base;
  // The pair's own interval, from the same function every other paired reading in this repository
  // uses, so the two numbers in the report cannot be computed by two different rules.
  const resolution = pairedResolution(onlyFirst, onlySecond, paired);
  return { ...base, ceiling: resolution.delta, cases: paired, mde: base.mde ?? resolution.mde };
}

export function readLottery(report: LotteryArtifact, options: LotteryOptions, source: string): LotteryRead {
  const arm = options.arm ?? largestPool(report);
  if (arm === undefined) throw new Error(`${source} keeps no candidate record at all, so no pool can be read from it`);
  const rows = candidateCases(report, arm, source);
  if (rows.length < LOTTERY_MINIMUM_SAMPLE) {
    throw new Error(
      `${arm} has ${String(rows.length)} cases with candidates, under the ${String(LOTTERY_MINIMUM_SAMPLE)} this instrument needs; a band taken over ${String(rows.length)} cases is a band taken over the draw`,
    );
  }
  const universe = rows.map((row) => row.candidates.map((candidate) => candidate.correct));
  const widest = universe.reduce((most, flags) => Math.max(most, flags.length), 0);
  // The draw a k-candidate arm plays is the one it declared; a run with no A/A pair has no arm to
  // take it from, and a 3-candidate arm is the shape this benchmark's readings are written against.
  const aaArm = typeof report.aa?.arm === 'string' ? report.aa.arm : undefined;
  const draws = options.draws ?? (aaArm === undefined ? undefined : declaredSamples(report, aaArm)) ?? 3;
  if (draws > widest) {
    throw new Error(
      `--draws ${String(draws)} is wider than every pool in ${arm} (widest ${String(widest)}), so no draw can vary and the band would be a constant`,
    );
  }
  const observed = observedOf(report);
  return {
    arm,
    cases: rows.length,
    draws,
    widest,
    wide: universe.some((flags) => flags.length > draws),
    lottery: lotteryNoise(universe, draws, { replicates: options.replicates, seed: options.seed }),
    ...(observed === undefined ? {} : { observed }),
  };
}

export interface LotteryVerdict {
  readonly kind: 'inside' | 'beyond' | 'unmeasured';
  readonly sentence: string;
  /** How far beyond the band the observed delta sits, when it does. */
  readonly residual?: number;
  /** The smallest delta a claim from this run can rest on. */
  readonly resolution: number;
}

const pp = (share: number): string => `${(share * 100).toFixed(1)}pp`;

/**
 * What the band says about the run that produced it.
 *
 * The graded quantity is the *ceiling* when the pair's rows exist and the *score* when they do not,
 * and the sentence names which one it read: they are different measurements and the difference is
 * the selector, so a reader who is told "the delta is inside the band" has to know which delta.
 */
export function verdictOf(read: LotteryRead): LotteryVerdict {
  const band = Math.max(Math.abs(read.lottery.low), read.lottery.high);
  const resolution = Math.max(read.observed?.mde ?? 0, band);
  const observed = read.observed;
  if (observed === undefined) {
    return { kind: 'unmeasured', sentence: `no A/A pair in this run, so nothing was measured against the ${pp(band)} its pool can produce`, resolution };
  }
  const graded = observed.ceiling ?? observed.score;
  const what = observed.ceiling === undefined ? 'score' : 'ceiling';
  if (Math.abs(graded) <= band) {
    return {
      kind: 'inside',
      sentence: `the A/A ${what} delta of ${pp(graded)} is inside the ±${pp(band)} this pool's own composition can produce, so the pair read the draw rather than the harness`,
      resolution,
    };
  }
  const residual = Math.abs(graded) - band;
  return {
    kind: 'beyond',
    sentence:
      `the A/A ${what} delta of ${pp(graded)} is ${pp(residual)} beyond the ±${pp(band)} the offered pool can produce, ` +
      'so the draw distribution itself moved between the halves: no ordering of the arms removes that, and only more cases averages it',
    residual,
    resolution,
  };
}

export function lotteryLines(read: LotteryRead): string[] {
  const band = Math.max(Math.abs(read.lottery.low), read.lottery.high);
  const verdict = verdictOf(read);
  const lines = [
    `arm ${read.arm}: ${String(read.cases)} cases with a candidate record, draws ${String(read.draws)} of a pool of up to ${String(read.widest)}`,
    `  lottery   ±${pp(band)} at 95%  (sd ${pp(read.lottery.sd)}, mean ${pp(read.lottery.mean)}, ${String(read.lottery.replicates)} replicates, seeded)`,
  ];
  if (!read.wide) lines.push('  lottery   no case held a pool wider than the draw, so the band is a constant zero');
  if (read.observed === undefined) {
    lines.push('  A/A       no A/A pair in this run');
  } else {
    lines.push(
      `  A/A ceiling ${read.observed.ceiling === undefined ? 'not measured (the pair kept no candidate records)' : pp(read.observed.ceiling)}` +
        `   score ${pp(read.observed.score)}   over ${String(read.observed.cases)} cases`,
    );
  }
  lines.push(`  resolves  ${pp(verdict.resolution)} — the smallest delta a claim from this run can rest on`);
  lines.push(`  verdict   ${verdict.sentence}`);
  return lines;
}

export interface LotterySettings {
  readonly report: string;
  readonly arm: string | undefined;
  readonly draws: number | undefined;
  readonly replicates: number;
  readonly seed: number;
  readonly json: boolean;
  readonly out: string | undefined;
}

function positive(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value < 1) throw new Error(`${flag} takes a positive whole number, not ${JSON.stringify(raw)}`);
  return value;
}

export function resolveLotterySettings(argv: readonly string[], root: string): LotterySettings {
  let report = join(root, 'eval/out/bird-eval.json');
  let arm: string | undefined;
  let draws: number | undefined;
  let replicates = 2000;
  let seed = 20_240_101;
  let json = false;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (flag === '--arm') {
      arm = argv[index + 1];
      if (arm === undefined) throw new Error('--arm needs an arm name');
      index += 1;
    } else if (flag === '--draws') {
      draws = positive(argv[index + 1], '--draws');
      index += 1;
    } else if (flag === '--replicates') {
      replicates = positive(argv[index + 1], '--replicates');
      index += 1;
    } else if (flag === '--seed') {
      const raw = argv[index + 1];
      const value = Number(raw);
      if (raw === undefined || !Number.isInteger(value)) throw new Error(`--seed takes a whole number, not ${JSON.stringify(raw)}`);
      seed = value;
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
  return { report, arm, draws, replicates, seed, json, out };
}

export function main(
  argv: readonly string[],
  root: string,
  log: (line: string) => void = console.log,
  load: (path: string) => LotteryArtifact = (path) => JSON.parse(readFileSync(path, 'utf8')) as LotteryArtifact,
): number {
  const settings = resolveLotterySettings(argv, root);
  const report = load(settings.report);
  const arm = settings.arm ?? largestPool(report);
  if (arm === undefined) {
    // The same two absences `bench:bird:diversity` reads: a single-call dispatch has no pool of
    // opinions to price, which is a reading; an arm that claims a ceiling and kept no candidates
    // lost records, which is a refusal.
    if (declaresCandidateSet(report.arms)) {
      throw new Error(`${settings.report} publishes a candidate ceiling on an arm whose cases carry no candidates, so no pool can be read from it`);
    }
    log(`no arm in ${settings.report} draws more than one candidate, so there is no lottery to price (${String(scoredQuestions(report.cases))} questions)`);
    return 0;
  }
  const read = readLottery(report, { arm: settings.arm, draws: settings.draws, replicates: settings.replicates, seed: settings.seed }, settings.report);
  if (settings.json) log(JSON.stringify(read, null, 2));
  else for (const line of lotteryLines(read)) log(line);
  if (settings.out !== undefined) writeFileSync(resolve(root, settings.out), `${JSON.stringify(read, null, 2)}\n`);
  return 0;
}

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
