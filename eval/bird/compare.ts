/**
 * Two runs, and whether the difference between them is about the thing they changed.
 *
 * This repository has one number that stopped reproducing and cost it a published claim: the same
 * arm, `inline-definitions`, read 45.0% in one run and 40.3% in another, with the prompts, the
 * corpus and the declared model all identical. The pair instrument was built to answer exactly
 * that question and it answers it differently — inside one run, `synth-definitions` and
 * `inline-definitions` are 18 and 17 discordant cases (exact McNemar p = 1.0000), so the 3.6pp
 * that "attached definitions" was credited with is a comparison of two runs, not of two arms.
 *
 * Two artifacts side by side is a different instrument from two arms in one artifact, and the
 * difference is what it is allowed to claim:
 *
 * - `pair` refuses to join artifacts, because a paired test needs both arms scored on the same
 *   question by the same judge. Its output is a delta about a lever.
 * - This file does join them, and its output is **not** a delta about a lever. It is a reading of
 *   the instrument's own displacement: how far an arm moves between two runs whose coordinates all
 *   match. Measured on the two Mini-Dev runs of 2026-11-08 (`42482353883`, `42491745712`), that
 *   displacement is 0.6-0.8pp on an unchanged arm — which is one third of the 2.93pp resolution dev
 *   is usually quoted against, and larger than every prompt-layer delta this project has measured.
 *
 * So the verdict this tool prints is deliberately narrow. It does not say whether a difference is
 * significant; it says whether the two runs are **the same experiment**, and it names the
 * coordinate that broke when they are not. A delta across two comparable runs still carries the
 * displacement above, and the only safe use of it is as a hypothesis that `pair` then tests.
 *
 * ## Why the coordinates are these and not a hash
 *
 * A single hash over both artifacts would answer "identical or not" and nothing else, and almost no
 * two runs are identical: the arm sets differ by design, and a run that changed one lever is
 * *supposed* to be compared with the run before it. Comparability is therefore a list of named
 * coordinates, each with its own consequence:
 *
 * - `corpus.digest` — the questions. BIRD re-annotated Mini-Dev on 2026-10-28 and this repository
 *   downloads the split from a bucket URL, so the corpus is not a constant.
 * - `model.served` — the base that answered, as the endpoint named it. `deepseek-chat` is an alias
 *   and the two runs above were both answered by `deepseek-flash`; an alias that is re-pointed
 *   turns a re-run on new weights into what looks like a re-run of the same experiment.
 * - `model.fingerprint` — the same coordinate read from behaviour instead of from paperwork. A
 *   name survives a change of weights, and the pool of four runs this repository quotes averages
 *   readings taken hours apart, so "one generator answered all four" is a claim that needs a
 *   reading rather than a name. `eval/bird/fingerprint.ts` supplies it, and its absence is now a
 *   coordinate that says `NOT RECORDED` instead of a silence that reads as agreement.
 * - `harness` — deadline, concurrency and retry budget. A shorter deadline converts slow answers
 *   into failures without touching the pipeline.
 * - `secondModel` — the second endpoint, when an arm draws a candidate from it.
 *
 * `split` is a coordinate too, and it is the cheapest one to get wrong: a Mini-Dev rate and a dev
 * rate are two different numbers that both round to "accuracy".
 */
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pairOutcome } from './pair.js';
import type { PairArtifact } from './pair.js';

/** The slice of an artifact this instrument reads. Written out rather than imported: see `pair.ts`. */
export interface RunArm {
  readonly arm: string;
  readonly passed?: number;
  readonly total?: number;
  readonly accuracy?: number;
  /** How many cases each base model served, as the endpoint named them. */
  readonly servedModels?: Readonly<Record<string, number>>;
  readonly spend?: { readonly asked?: number };
  readonly calls?: number | { readonly mean?: number; readonly max?: number };
}

export interface RunArtifact {
  readonly split?: string;
  readonly model?: string | null;
  readonly secondModel?: string | null;
  readonly judgeModel?: string | null;
  readonly generatedAt?: string;
  readonly corpus?: { readonly digest?: string; readonly rows?: number; readonly questions?: number };
  readonly run?: { readonly timeoutMs?: number; readonly concurrency?: number; readonly retries?: number };
  readonly armsRequested?: readonly string[];
  readonly arms?: readonly RunArm[];
  /**
   * What the base model answered on the probe set, when the artifact recorded it.
   *
   * The third reading of the same coordinate the two above read badly: `model` is what was asked
   * for and `servedModels` is the name the endpoint reported, and neither can see weights that
   * changed under a name that did not. This is the only field here that is about the generator
   * rather than about the run's own paperwork.
   */
  readonly baseFingerprint?: {
    readonly digest?: string;
    readonly probes?: number;
    readonly total?: number;
    readonly stable?: boolean;
    readonly bases?: readonly string[];
    readonly probeSet?: string;
  };
  /** The per-case rows, when the artifact carries them. What the churn reading is built from. */
  readonly cases?: readonly { readonly arm?: string; readonly id?: string | number; readonly passed?: boolean }[];
}

/**
 * How many cases changed verdict between two runs of the same arm.
 *
 * A rate difference is the net of two flows, and this is the flows: `up` cases the second run
 * passed and the first did not, `down` the reverse. A net move of ten cases can be ten up and zero
 * down (a lever) or fifty-four up and forty-four down (a draw that happened to land), and no rate
 * difference on earth distinguishes them. `churnShare` is the denominator of every per-question
 * claim in this repository: a bucket that "fails on 61 questions" is a bucket observed through this
 * much flicker.
 */
export interface Churn {
  readonly arm: string;
  readonly examined: number;
  readonly up: number;
  readonly down: number;
  readonly net: number;
  readonly churnShare: number;
}

/** One thing that must be equal for a difference between two runs to be about anything. */
export interface Coordinate {
  readonly name: string;
  readonly left: string;
  readonly right: string;
  readonly same: boolean;
  /**
   * Whether both sides carry the fact at all.
   *
   * A coordinate that matches because neither side recorded it is not a match, and it is not a
   * disagreement either. Before this field the two were the same word — `not recorded` on both
   * sides read as `same: false`, and the verdict below called that "changed", which is an
   * assertion about the world in the one case where the truth is that nobody looked.
   */
  readonly recorded: boolean;
  /** What a disagreement means, printed only when it disagrees. */
  readonly consequence: string;
}

/** How far one arm moved, when both runs scored it. */
export interface Displacement {
  readonly arm: string;
  readonly left: number;
  readonly right: number;
  readonly deltaPp: number;
  /**
   * The 95% half-width of a difference between two independent rates on this arm's sample.
   *
   * This is the number that decides whether the delta above means anything, and it is not small:
   * at 496 questions and a rate near 0.57 it is 6.2pp. Two rates are two draws, and a difference of
   * two draws carries both draws' uncertainty — which is why the 45.0/40.3 pair was never a
   * reading, and why `pair` exists at all.
   */
  readonly intervalPp: number;
  /** Whether the delta is larger than the interval the two samples can resolve. */
  readonly readable: boolean;
  /** Whether the two runs scored the same number of questions on this arm. */
  readonly sameSample: boolean;
}

export interface CompareReport {
  readonly left: string;
  readonly right: string;
  readonly coordinates: readonly Coordinate[];
  readonly comparable: boolean;
  readonly broken: readonly string[];
  /**
   * The coordinates that broke because nobody recorded them, rather than because they moved.
   *
   * Printed apart from `broken` because the two are different news: `corpus.digest` disagreeing
   * means the questions changed, and `corpus.digest` missing means nobody can say. The verdict
   * used to call both "changed", which is a sentence asserting a fact in the one case where the
   * fact is that nobody looked.
   */
  readonly unrecorded: readonly string[];
  /** Arms both runs scored, most-moved first. The order is the finding. */
  readonly moved: readonly Displacement[];
  /** The flows behind each move, when both artifacts carry case rows. Most churn first. */
  readonly churn: readonly Churn[];
  /** Arms one run scored and the other did not: a difference in what was asked, not in what moved. */
  readonly onlyLeft: readonly string[];
  readonly onlyRight: readonly string[];
  readonly largestMovePp: number;
  readonly problems: readonly string[];
}

/** The base models an artifact's arms were served by, sorted and deduplicated across arms. */
export function servedBases(report: RunArtifact): string[] {
  const bases = new Set<string>();
  for (const arm of report.arms ?? []) for (const base of Object.keys(arm.servedModels ?? {})) bases.add(base);
  return [...bases].sort();
}

function harnessOf(report: RunArtifact): string {
  const run = report.run;
  if (run === undefined) return 'not recorded';
  const parts: string[] = [];
  if (run.timeoutMs !== undefined) parts.push(`timeout ${String(run.timeoutMs)}`);
  if (run.concurrency !== undefined) parts.push(`concurrency ${String(run.concurrency)}`);
  if (run.retries !== undefined) parts.push(`retries ${String(run.retries)}`);
  return parts.length === 0 ? 'not recorded' : parts.join(', ');
}

function label(report: RunArtifact): string {
  const split = report.split ?? 'unknown split';
  const model = typeof report.model === 'string' ? report.model : 'no model';
  const served = servedBases(report);
  const by = served.length === 0 ? '' : ` served by ${served.join('+')}`;
  return `${split}, ${model}${by}`;
}

/**
 * The coordinates, in the order a reader should check them.
 *
 * `model.asked` and `model.served` are separate lines on purpose: a run that asks for the same
 * alias twice and is answered by two different bases is the failure this list exists for, and a
 * single combined line would hide it by printing the alias on both sides.
 */
export function coordinatesOf(left: RunArtifact, right: RunArtifact): Coordinate[] {
  const digest = (report: RunArtifact): string => report.corpus?.digest ?? 'not recorded';
  const served = (report: RunArtifact): string => {
    const bases = servedBases(report);
    return bases.length === 0 ? 'not recorded' : bases.join('+');
  };
  const second = (report: RunArtifact): string =>
    typeof report.secondModel === 'string' ? report.secondModel : 'none';
  // A digest the endpoint would answer differently on the next draw is printed with the reason
  // attached, because a reader who sees only a hex string has no way to know it is a draw.
  const fingerprint = (report: RunArtifact): string => {
    const recorded = report.baseFingerprint;
    if (recorded === undefined || typeof recorded.digest !== 'string' || recorded.digest === '') return 'not recorded';
    return recorded.stable === true ? recorded.digest : `${recorded.digest} (unstable)`;
  };
  const fingerprintUsable = (report: RunArtifact): boolean =>
    typeof report.baseFingerprint?.digest === 'string' && report.baseFingerprint.digest !== '' && report.baseFingerprint.stable === true;
  return [
    {
      name: 'split',
      left: left.split ?? 'unknown',
      right: right.split ?? 'unknown',
      same: left.split === right.split,
      recorded: true,
      consequence: 'a rate on two splits is two numbers, not one reading twice',
    },
    {
      name: 'corpus.digest',
      left: digest(left),
      right: digest(right),
      same: digest(left) === digest(right) && digest(left) !== 'not recorded',
      recorded: digest(left) !== 'not recorded' && digest(right) !== 'not recorded',
      consequence: 'the questions changed, so every floor pinned to either corpus is a floor on other questions',
    },
    {
      name: 'model.asked',
      left: typeof left.model === 'string' ? left.model : 'none',
      right: typeof right.model === 'string' ? right.model : 'none',
      same: (left.model ?? null) === (right.model ?? null),
      recorded: true,
      consequence: 'the two runs asked different endpoints for an answer',
    },
    {
      name: 'model.served',
      left: served(left),
      right: served(right),
      same: served(left) === served(right) && served(left) !== 'not recorded',
      recorded: served(left) !== 'not recorded' && served(right) !== 'not recorded',
      consequence: 'the endpoint named a different base model, so the same alias answered with different weights',
    },
    {
      name: 'model.fingerprint',
      left: fingerprint(left),
      right: fingerprint(right),
      same: fingerprintUsable(left) && fingerprintUsable(right) && fingerprint(left) === fingerprint(right),
      recorded: fingerprintUsable(left) && fingerprintUsable(right),
      consequence:
        'the endpoint answered its fixed probes differently, so the two runs may be two generators under one name — ' +
        'this is the coordinate a re-pointed alias leaves behind when it keeps its name',
    },
    {
      name: 'secondModel',
      left: second(left),
      right: second(right),
      same: second(left) === second(right),
      recorded: true,
      consequence: 'arms that draw a candidate from the second endpoint drew it from another one',
    },
    {
      name: 'harness',
      left: harnessOf(left),
      right: harnessOf(right),
      same: harnessOf(left) === harnessOf(right) && harnessOf(left) !== 'not recorded',
      recorded: harnessOf(left) !== 'not recorded' && harnessOf(right) !== 'not recorded',
      consequence: 'a different deadline or concurrency converts slow answers into failures without touching the pipeline',
    },
  ];
}

/** Whether a broken coordinate broke because nobody recorded it rather than because it moved. */
export function isUnrecorded(coordinate: Coordinate): boolean {
  return !coordinate.recorded;
}

/**
 * The 95% half-width of the difference between two independent rates.
 *
 * Two rates are two draws from two runs, so the variance of their difference is the sum of the
 * variances — twice one rate's. A paired test avoids this because a pair is one draw of two arms on
 * the same questions, and the questions' own difficulty cancels; a comparison across runs has
 * nothing to cancel it against, so the interval has to be stated rather than assumed away.
 *
 * `n` is the smaller of the two samples, because a difference cannot be resolved better than the
 * thinner side of it.
 */
export function crossRunIntervalPp(leftPassed: number, leftTotal: number, rightPassed: number, rightTotal: number): number {
  const total = Math.min(leftTotal, rightTotal);
  if (total === 0) return 0;
  const pooled = (leftPassed / leftTotal + rightPassed / rightTotal) / 2;
  return Number(((1.96 * Math.sqrt((2 * pooled * (1 - pooled)) / total)) * 100).toFixed(2));
}

/** The arms both runs scored, with the move each one made, largest absolute move first. */
export function displacement(left: RunArtifact, right: RunArtifact): Displacement[] {
  const index = (report: RunArtifact): Map<string, RunArm> => {
    const byArm = new Map<string, RunArm>();
    for (const arm of report.arms ?? []) byArm.set(arm.arm, arm);
    return byArm;
  };
  const leftArms = index(left);
  const rightArms = index(right);
  const moved: Displacement[] = [];
  for (const [name, armLeft] of leftArms) {
    const armRight = rightArms.get(name);
    if (armRight === undefined) continue;
    const rateLeft = rateOf(armLeft);
    const rateRight = rateOf(armRight);
    if (rateLeft === undefined || rateRight === undefined) continue;
    const deltaPp = Number(((rateRight - rateLeft) * 100).toFixed(2));
    const intervalPp = crossRunIntervalPp(
      Math.round(rateLeft * (armLeft.total ?? 0)),
      armLeft.total ?? 0,
      Math.round(rateRight * (armRight.total ?? 0)),
      armRight.total ?? 0,
    );
    moved.push({
      arm: name,
      left: rateLeft,
      right: rateRight,
      deltaPp,
      intervalPp,
      readable: Math.abs(deltaPp) > intervalPp,
      sameSample: armLeft.total === armRight.total,
    });
  }
  moved.sort((one, two) => Math.abs(two.deltaPp) - Math.abs(one.deltaPp) || one.arm.localeCompare(two.arm));
  return moved;
}

/**
 * An arm's rate as a fraction, from the count when it is there and from the rate when it is not.
 *
 * The count is preferred because `accuracy` is a float that a writer may round, and a delta of two
 * roundings is not a delta. An arm that scored nothing returns `undefined` rather than zero: a rate
 * over no questions is a missing reading, and printing it as 0% would put it at the bottom of a
 * movement table where it looks like a regression.
 */
export function rateOf(arm: RunArm): number | undefined {
  if (typeof arm.passed === 'number' && typeof arm.total === 'number') {
    return arm.total === 0 ? undefined : arm.passed / arm.total;
  }
  return typeof arm.accuracy === 'number' ? arm.accuracy : undefined;
}

/**
 * The flows behind each rate difference, per arm, for the arms both runs scored on the same ids.
 *
 * Read from the case rows rather than from the totals because the totals cannot produce it: a rate
 * is a sum, and the only way to recover what moved is to compare the cases one id at a time. Arms
 * whose cases one artifact does not carry are left out rather than reported as zero churn — an
 * absent reading and a stable arm are different findings.
 */
export function churn(left: RunArtifact, right: RunArtifact): Churn[] {
  const index = (report: RunArtifact): Map<string, Map<string, boolean>> => {
    const arms = new Map<string, Map<string, boolean>>();
    for (const row of report.cases ?? []) {
      if (row.arm === undefined || row.id === undefined || typeof row.passed !== 'boolean') continue;
      const cases = arms.get(row.arm) ?? new Map<string, boolean>();
      cases.set(String(row.id), row.passed);
      arms.set(row.arm, cases);
    }
    return arms;
  };
  const leftArms = index(left);
  const rightArms = index(right);
  const rows: Churn[] = [];
  for (const [arm, leftCases] of leftArms) {
    const rightCases = rightArms.get(arm);
    if (rightCases === undefined) continue;
    let examined = 0;
    let up = 0;
    let down = 0;
    for (const [id, passedLeft] of leftCases) {
      const passedRight = rightCases.get(id);
      if (passedRight === undefined) continue;
      examined += 1;
      if (passedRight && !passedLeft) up += 1;
      if (passedLeft && !passedRight) down += 1;
    }
    if (examined === 0) continue;
    rows.push({
      arm,
      examined,
      up,
      down,
      net: up - down,
      churnShare: Number((((up + down) / examined) * 100).toFixed(1)),
    });
  }
  rows.sort((one, two) => two.churnShare - one.churnShare || one.arm.localeCompare(two.arm));
  return rows;
}

export function compareRuns(left: RunArtifact, right: RunArtifact, leftName: string, rightName: string): CompareReport {
  const coordinates = coordinatesOf(left, right);
  const brokenCoordinates = coordinates.filter((coordinate) => !coordinate.same);
  const broken = brokenCoordinates.map((coordinate) => coordinate.name);
  const unrecorded = brokenCoordinates.filter(isUnrecorded).map((coordinate) => coordinate.name);
  const leftArms = new Set((left.arms ?? []).map((arm) => arm.arm));
  const rightArms = new Set((right.arms ?? []).map((arm) => arm.arm));
  const onlyLeft = [...leftArms].filter((arm) => !rightArms.has(arm)).sort();
  const onlyRight = [...rightArms].filter((arm) => !leftArms.has(arm)).sort();
  const moved = displacement(left, right);
  const largestMovePp = moved.reduce((most, row) => Math.max(most, Math.abs(row.deltaPp)), 0);
  const problems = compareProblems(moved.length);
  return {
    left: leftName,
    right: rightName,
    coordinates,
    comparable: broken.length === 0,
    broken,
    unrecorded,
    moved,
    churn: churn(left, right),
    onlyLeft,
    onlyRight,
    largestMovePp: Number(largestMovePp.toFixed(2)),
    problems,
  };
}

/**
 * What makes the reading impossible, as opposed to unflattering.
 *
 * One thing only: two runs that share no arm have nothing to place side by side. A broken
 * coordinate is **not** listed here, and that is deliberate — "these are not the same experiment"
 * is this tool working, not this tool failing. It is a verdict for a reader, and an exit code that
 * went red on it would teach a caller to ignore the exit code.
 */
export function compareProblems(sharedArms: number): string[] {
  return sharedArms === 0
    ? ['the two runs share no arm that both scored, so there is nothing to place side by side']
    : [];
}

export function compareLines(report: CompareReport, leftMeta: string, rightMeta: string): string[] {
  const lines: string[] = [];
  const pad = 18;
  lines.push('two runs, one instrument');
  lines.push(`  ${'left'.padEnd(pad)}${report.left}   ${leftMeta}`);
  lines.push(`  ${'right'.padEnd(pad)}${report.right}   ${rightMeta}`);
  lines.push('');
  lines.push('  coordinates — a difference between these runs is about the experiment only where every line matches:');
  for (const coordinate of report.coordinates) {
    const mark = coordinate.same ? 'same' : coordinate.recorded ? 'DIFFERS' : 'NOT RECORDED';
    lines.push(`    ${coordinate.name.padEnd(pad)}${coordinate.left}  ${coordinate.same ? '=' : '≠'}  ${coordinate.right}   ${mark}`);
  }
  for (const coordinate of report.coordinates.filter((item) => !item.same)) {
    lines.push(`    ${coordinate.name}: ${coordinate.consequence}`);
  }
  lines.push('');
  if (report.comparable) {
    lines.push('  verdict: comparable — these are the same experiment measured twice');
  } else {
    // Two ways to be incomparable, and saying which is the whole point: a coordinate that moved is
    // a difference between the runs, and a coordinate nobody recorded is a difference between what
    // the runs can be asked. The sentence used to call both "changed".
    const moved = report.broken.filter((name) => !report.unrecorded.includes(name));
    const missing = report.unrecorded;
    const parts = [
      moved.length === 0 ? '' : `${moved.join(', ')} changed`,
      missing.length === 0 ? '' : `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not recorded on both sides`,
    ].filter((part) => part !== '');
    lines.push(`  verdict: not comparable — ${parts.join('; ')}, so a delta below is about that coordinate`);
  }
  if (report.onlyLeft.length > 0) lines.push(`  scored only on the left: ${report.onlyLeft.join(', ')}`);
  if (report.onlyRight.length > 0) lines.push(`  scored only on the right: ${report.onlyRight.join(', ')}`);
  lines.push('');
  if (report.moved.length === 0) {
    lines.push('  no arm was scored by both runs');
  } else {
    lines.push(`  ${'arm'.padEnd(28)}${'left'.padStart(8)}${'right'.padStart(8)}${'delta'.padStart(9)}${'±95%'.padStart(8)}  reading`);
    for (const row of report.moved) {
      const verdict = row.readable ? 'outside' : 'inside';
      const sample = row.sameSample ? '' : ', different sample';
      lines.push(
        `  ${row.arm.padEnd(28)}${`${(row.left * 100).toFixed(2)}%`.padStart(8)}${`${(row.right * 100).toFixed(2)}%`.padStart(8)}` +
          `${`${row.deltaPp >= 0 ? '+' : ''}${row.deltaPp.toFixed(2)}`.padStart(9)}${`${row.intervalPp.toFixed(2)}`.padStart(8)}` +
          `  ${verdict}${sample}`,
      );
    }
    lines.push('');
    const readable = report.moved.filter((row) => row.readable);
    // The widest interval over the arms listed, not the first row's: the rows are ordered by how far
    // they moved and the widest interval belongs to the thinnest sample, so taking the first would
    // quote an interval that is smaller than the one some row has to clear.
    const widest = Math.max(...report.moved.map((row) => row.intervalPp));
    lines.push(
      `  the largest move on an arm that did not change is ${report.largestMovePp.toFixed(2)}pp; the interval a delta of two ` +
        `independent rates has to clear on this sample is ${widest.toFixed(2)}pp`,
    );
    lines.push(
      readable.length === 0
        ? '  no arm moved outside that interval: every difference here is the draw, not a lever'
        : `  ${String(readable.length)} arm(s) moved outside that interval (${readable.map((row) => row.arm).join(', ')}) — a reading worth testing, not yet a result`,
    );
    lines.push('  `bench:bird:pair` is the instrument that tests it, inside one run and on the same questions');
  }
  if (report.churn.length > 0) {
    lines.push('');
    lines.push('  what moved under the rates — cases that changed verdict on the same question:');
    lines.push(`  ${'arm'.padEnd(28)}${'cases'.padStart(7)}${'up'.padStart(6)}${'down'.padStart(6)}${'net'.padStart(5)}${'churn'.padStart(8)}`);
    for (const row of report.churn) {
      lines.push(
        `  ${row.arm.padEnd(28)}${String(row.examined).padStart(7)}${String(row.up).padStart(6)}${String(row.down).padStart(6)}` +
          `${String(row.net).padStart(5)}${`${row.churnShare.toFixed(1)}%`.padStart(8)}`,
      );
    }
    const widest = report.churn[0] as Churn;
    lines.push('');
    lines.push(
      `  ${widest.arm} did not change, yet ${String(widest.up + widest.down)} of ${String(widest.examined)} questions ` +
        `(${widest.churnShare.toFixed(1)}%) came out differently; its net move is ${String(widest.net)} case(s), so the rate hides the churn`,
    );
  }
  for (const problem of report.problems) lines.push(`  FAILED ${problem}`);
  return lines;
}

export interface CompareSettings {
  readonly left: string;
  readonly right: string;
  /**
   * Further artifacts, read for the pair only.
   *
   * The comparison table stays two-sided: it is a statement about what one coordinate did between
   * two runs. The pair table is not — a pair's evidence is every run that read it, and a command
   * that can only be handed two of them reports a verdict that depends on which two. That happened:
   * `inline+evidence -> select` was `one-run-only` when pooled over two of its three readings and
   * `heterogeneous` over all three, because the third is what made the readings disagree.
   */
  readonly also: readonly string[];
  /** The one pair whose readings are pooled across every artifact, when asked for. */
  readonly pair?: readonly [string, string];
}

export function resolveCompareSettings(argv: readonly string[], root: string): CompareSettings {
  const at = argv.indexOf('--pair');
  let pair: [string, string] | undefined;
  if (at !== -1) {
    const names = (argv[at + 1] ?? '').split(',');
    if (names.length !== 2 || names.some((name) => name.trim() === '')) {
      throw new Error('--pair takes two arm names, for example inline+evidence,select');
    }
    pair = [(names[0] as string).trim(), (names[1] as string).trim()];
  }
  const consumed = new Set<number>();
  argv.forEach((item, index) => {
    if (!item.startsWith('--')) return;
    consumed.add(index);
    if (item === '--pair') consumed.add(index + 1);
  });
  const positional = argv.filter((item, index) => !item.startsWith('--') && !consumed.has(index));
  if (positional.length < 2) {
    throw new Error(
      'usage: compare.ts <a.json> <b.json> [more.json ...] [--pair <left>,<right>] — the first two are the comparison, every path is a reading of the pair',
    );
  }
  const flags = argv.filter((item) => item.startsWith('--') && item !== '--pair');
  if (flags.length > 0) throw new Error(`unrecognized argument ${flags[0] as string}: this tool takes at least two artifact paths and optionally one pair`);
  const [left, right, ...also] = positional.map((path) => resolve(root, path)) as [string, string, ...string[]];
  return { left, right, also, ...(pair === undefined ? {} : { pair }) };
}

/** One artifact's reading of one pair, or nothing when the artifact did not score both arms. */
export function readPairOf(report: RunArtifact, name: string, left: string, right: string): PairReading | undefined {
  const scored = new Set((report.cases ?? []).map((row) => row.arm));
  if (!scored.has(left) || !scored.has(right)) return undefined;
  const outcome = pairOutcome(report as PairArtifact, left, right);
  const deltaPp = outcome.examined === 0 ? 0 : ((outcome.wins - outcome.losses) / outcome.examined) * 100;
  return {
    artifact: name,
    examined: outcome.examined,
    wins: outcome.wins,
    losses: outcome.losses,
    deltaPp: Number(deltaPp.toFixed(2)),
    p: Number(outcome.p.toFixed(4)),
  };
}

/** One artifact's reading of one declared pair. */
export interface PairReading {
  readonly artifact: string;
  readonly examined: number;
  readonly wins: number;
  readonly losses: number;
  readonly deltaPp: number;
  readonly p: number;
}

/** The same pair read in more than one run, and whether it survived the second reading. */
export interface PooledReading {
  readonly left: string;
  readonly right: string;
  readonly readings: readonly PairReading[];
  /** Inverse-variance pooled estimate of the difference, in percentage points. */
  readonly pooledPp: number;
  /** Its 95% half-width. */
  readonly pooledIntervalPp: number;
  /** Two-sided normal p for the pooled estimate. */
  readonly pooledP: number;
  /**
   * Cochran's Q on the readings, as a p-value with k-1 degrees of freedom.
   *
   * Two runs of one pair that disagree by more than their own intervals is the case this exists for:
   * the pooled estimate is still the best number available, and its interval is only honest if the
   * readings are compatible. Below 0.05 the verdict stops being about the lever and becomes about
   * the instrument, and the line says so rather than narrowing the interval over a disagreement.
   */
  readonly heterogeneityP: number;
  /**
   * The between-reading variance the interval was widened by, in pp².
   *
   * Zero means the readings are compatible and the interval is the fixed-effect one. Positive means
   * the pool was estimated by DerSimonian–Laird: `pooledPp` is unchanged, and `pooledIntervalPp`
   * and `pooledP` are wider, because an interval for a number the readings disagree about has to
   * include that disagreement. Publishing the fixed-effect interval beside a `heterogeneous` label
   * was the estimator answering a question it had just said it could not answer.
   */
  readonly tauSquaredPp2: number;
  /** How many of the readings cleared p < 0.05 on their own. */
  readonly readingsSignificant: number;
  /**
   * `established`, `sign-flip`, `heterogeneous`, `one-run-only` or `none`, in that order of
   * precedence: a reversal wins over heterogeneity because it names the kind of disagreement, and
   * both are checked before the pool's own significance.
   */
  readonly verdict: string;
  readonly problems: readonly string[];
}

function normalTwoSided(z: number): number {
  return erfcOf(z / Math.SQRT2);
}

/** `erfc(x)`, which is also the two-sided normal tail at x·√2. */
function erfcOf(x: number): number {
  // Abramowitz-Stegun 7.1.26 on the error function; the alternative is a dependency for one number.
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x));
  return Math.min(1, Math.max(0, 1 - erf));
}

/**
 * The survival function of a chi-square with `df` degrees of freedom: P(X > q).
 *
 * Cochran's Q is distributed as χ² with k−1 degrees of freedom, where k is the number of readings,
 * and this function is what refers Q to that distribution. It exists because the code that reported
 * the heterogeneity p-value did not do this: it computed `2·Q_normal(√Q)`, which is χ² **with one
 * degree of freedom**, whatever the number of readings. At k = 2 — the shape most of the pooling
 * tests use — the two coincide exactly, which is why nothing failed for three rounds while pairs of
 * three to eight readings were being called `heterogeneous` on a test that was too liberal by the
 * difference between χ²₁ and χ²_{k−1}.
 *
 * Closed form rather than a library: for even `df` the upper incomplete gamma is a finite sum, and
 * for odd `df` it is `erfc` plus a finite series, so the whole function is twenty lines and no
 * dependency. Accuracy is the 1.5e-7 of the error-function approximation already in use.
 */
export function chiSquareSurvival(q: number, df: number): number {
  if (df < 1 || !(q > 0)) return 1;
  const x = q / 2;
  const a = df / 2;
  if (Number.isInteger(a)) {
    // Q(a,x) = e^{-x} · Σ_{j=0}^{a-1} x^j / j!
    let term = 1;
    let sum = 1;
    for (let j = 1; j < a; j += 1) {
      term *= x / j;
      sum += term;
    }
    return Math.min(1, Math.max(0, Math.exp(-x) * sum));
  }
  // Q(m + ½, x) = erfc(√x) + Σ_{i=0}^{m-1} x^{i+½} e^{-x} / Γ(i + 3/2)
  const m = (df - 1) / 2;
  let sum = erfcOf(Math.sqrt(x));
  let gamma = Math.sqrt(Math.PI) / 2;
  let power = Math.sqrt(x);
  for (let i = 0; i < m; i += 1) {
    sum += (power * Math.exp(-x)) / gamma;
    power *= x;
    gamma *= i + 1.5;
  }
  return Math.min(1, Math.max(0, sum));
}

/**
 * One pair, read in every artifact it was scored in, and pooled.
 *
 * This exists because a single paired reading turned out not to be a result either. `inline+evidence
 * -> select` read 22 against 8 (p = 0.0161) in `42491745712` and 19 against 18 (p = 1.0000) in
 * `42502095942` — the same pair, the same corpus, the same base model, three hours apart. A paired
 * test conditions on the questions; it does not condition on the generator's own draw, and at 496
 * questions that draw is worth about two points.
 *
 * So the unit of evidence is not one run. It is the pair's estimate pooled over the runs that read
 * it, with the between-reading disagreement reported rather than averaged away. Which runs those are
 * is not the caller's choice: the command takes every artifact it is given, and one artifact fewer
 * can change the label — `inline+evidence -> select` is `+1.65pp one-run-only` over two of its three
 * readings and `+1.01pp heterogeneous` over all three.
 *
 * Pooling weights each reading by its inverse variance, and the variance comes from the discordant
 * count — the only cases that carry information about a pair. Two readings over the same questions
 * are not independent samples of the corpus, and this does not claim they are; what is independent
 * is the draw, which is exactly what a second run re-rolls.
 */
export function poolPair(readings: readonly PairReading[], left: string, right: string): PooledReading {
  const usable = readings.filter((reading) => reading.examined > 0 && reading.wins + reading.losses > 0);
  const problems = usable.length === 0 ? [`the pair ${left} -> ${right} carries no discordant case in any run, so there is nothing to pool`] : [];
  // The variance of a paired difference is the discordant count over n squared, and the estimate is
  // in percentage points, so the weight carries the 10^4 that converts a fraction to a point. Getting
  // this wrong is not cosmetic: without it the pooled interval came out at 0.02pp and reported
  // certainty that two contradicting runs cannot support.
  const weights = usable.map((reading) => (reading.examined * reading.examined) / ((reading.wins + reading.losses) * 1e4));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  // The fixed-effect estimate: every reading weighted by its own precision, which is the right
  // answer when the readings estimate one number.
  const fixedPp = total === 0 ? 0 : usable.reduce((sum, reading, index) => sum + reading.deltaPp * (weights[index] as number), 0) / total;
  const fixedError = total === 0 ? 0 : Math.sqrt(1 / total);
  const q = usable.reduce((sum, reading, index) => sum + (weights[index] as number) * (reading.deltaPp - fixedPp) ** 2, 0);
  // Referred to χ² with k−1 degrees of freedom, which is what Q is distributed as under the
  // hypothesis that the readings share one mean. Reporting it as a 1-df statistic made every
  // three-to-eight-reading pair look less compatible than it was.
  const heterogeneityP = usable.length < 2 ? 1 : chiSquareSurvival(q, usable.length - 1);
  // DerSimonian–Laird (1986): the moment estimator of the between-reading variance. Q has k-1
  // degrees of freedom under the hypothesis that the readings share one mean, so the excess of Q
  // over k-1 is the disagreement sampling error does not explain, scaled by how much information
  // the readings carry.
  //
  // It is applied as a pre-test estimator: τ² is estimated only when the heterogeneity test
  // rejects, and is exactly zero otherwise. Textbook DL would take any Q above k-1, which is a
  // lower bar than p < 0.05 and would widen every pool in this document slightly for a disagreement
  // no test found. The pre-test has a known bias — it under-covers when Q sits just above the
  // threshold — and it buys an invariant that is worth more here than that bias: **the interval is
  // widened exactly when the label says the readings are not one number**, so the label and the
  // number beside it cannot disagree about whether the pair is poolable.
  //
  // What it replaces: the fixed-effect interval printed beside the word `heterogeneous` for three
  // pairs. The word said the readings are not one number; the interval was computed as if they
  // were, so it was narrower than the distance between the readings it claimed to summarise. A
  // reader acting on ±0.84 while the report says the readings disagree is being told two things and
  // handed the more confident one.
  const denominator = total - weights.reduce((sum, weight) => sum + weight * weight, 0) / (total === 0 ? 1 : total);
  const tauSquared =
    usable.length < 2 || heterogeneityP >= 0.05 || denominator <= 0
      ? 0
      : Math.max(0, (q - (usable.length - 1)) / denominator);
  const adjusted = weights.map((weight) => 1 / (1 / weight + tauSquared));
  const pooledTotal = adjusted.reduce((sum, weight) => sum + weight, 0);
  const pooledPp = pooledTotal === 0 ? fixedPp : usable.reduce((sum, reading, index) => sum + reading.deltaPp * (adjusted[index] as number), 0) / pooledTotal;
  const standardError = pooledTotal === 0 ? fixedError : Math.sqrt(1 / pooledTotal);
  const pooledP = pooledTotal === 0 ? 1 : normalTwoSided(Math.abs(pooledPp) / standardError);
  const significant = usable.filter((reading) => reading.p < 0.05);
  // A reversal is two readings pointing opposite ways *with evidence behind each direction*. The
  // rule used to be `significant.length > 0 && signs.size > 1`, which asks two different readings
  // two different questions: whether anything was significant anywhere, and whether any two signs
  // differed. `inline+evidence -> inline+evidence+audit` satisfied it with the significance in
  // `17/4` and the opposite sign in `8/11` — a reading that is p = 0.65 on its own — so a pair with
  // seven positive readings and one wobble printed `sign-flip` for three rounds. `metadata+evidence
  // -> select` did the same with `27/26` against a single significant negative reading. Both had the
  // same shape: one direction carried the evidence and the other carried only the sign.
  //
  // So the label now requires a reading that cleared its own test in *each* direction. A reading of
  // exactly zero is not a direction either: it contributes to neither count, which is what the tie
  // in `13/13` needed — before ties were excluded, `inline+evidence -> select` read `sign-flip` on
  // the strength of one tie followed by seven positive readings.
  //
  // A reversal is checked before heterogeneity, and both labels say the same thing about the
  // interval: the readings are not one number, so the interval is widened (see `tauSquaredPp2`).
  // The order names the kind of disagreement rather than only its existence.
  const positive = significant.filter((reading) => reading.deltaPp > 0).length;
  const negative = significant.length - positive;
  const reversal = positive > 0 && negative > 0;
  // The label describes the evidence, and the evidence is the pool: a pair is `established` when
  // the pooled estimate excludes zero and no reading cleared its own test in the other direction,
  // whatever any single reading managed on its own. The first version required every reading to
  // clear 0.05 by itself, which labelled `inline+evidence -> metadata+evidence` — +2.62, +2.62,
  // +3.43pp, pooled +2.89 ± 1.55 at p = 0.0003 with Q p = 0.631 — as `one-run-only`, contradicting
  // the estimate printed beside it. Whether one run carried the result or all of them did is a
  // printed count (`readingsSignificant`), not a label.
  //
  // A pair read once is not a verdict either way: a single reading that found something is
  // `one-run-only`, and a single reading that found nothing is `none`. The dev table used to print
  // `one-run-only` on all three of its rows, including 37/39 and 75/61, which reads as "an effect
  // one run found" for three pairs where no run found anything.
  const verdict =
    usable.length < 2
      ? pooledP < 0.05
        ? 'one-run-only'
        : 'none'
      : reversal
        ? 'sign-flip'
        : heterogeneityP < 0.05
          ? 'heterogeneous'
          : pooledP < 0.05
            ? 'established'
            : significant.length > 0
              ? 'one-run-only'
              : 'none';
  return {
    left,
    right,
    readings: [...usable],
    pooledPp: Number(pooledPp.toFixed(2)),
    pooledIntervalPp: Number((1.96 * standardError).toFixed(2)),
    pooledP: Number(pooledP.toFixed(4)),
    heterogeneityP: Number(heterogeneityP.toFixed(4)),
    tauSquaredPp2: Number(tauSquared.toFixed(2)),
    readingsSignificant: significant.length,
    verdict,
    problems,
  };
}

/** The pair table, with the sentence a reader needs to stop reading one run as a result. */
export function pooledLines(pooled: readonly PooledReading[], unscored: readonly string[] = []): string[] {
  const lines: string[] = [''];
  if (pooled.length === 0) return lines;
  lines.push('  the same pair read in every run that scored it — a single reading is not a result:');
  for (const reading of pooled) {
    lines.push(`    ${reading.left} -> ${reading.right}`);
    for (const run of reading.readings) {
      lines.push(
        `      ${run.artifact.padEnd(28)}${String(run.wins).padStart(3)} / ${String(run.losses).padStart(3)}` +
          `${`${run.deltaPp >= 0 ? '+' : ''}${run.deltaPp.toFixed(2)}pp`.padStart(10)}   p = ${run.p.toFixed(4)}`,
      );
    }
    lines.push(
      `      ${'pooled'.padEnd(28)}${''.padStart(3)}${''.padStart(7)}${`${reading.pooledPp >= 0 ? '+' : ''}${reading.pooledPp.toFixed(2)}pp`.padStart(10)}` +
        `   ± ${reading.pooledIntervalPp.toFixed(2)} (95%), p ≈ ${reading.pooledP.toFixed(3)} → ${reading.verdict}` +
        // Which estimator produced the interval is part of the reading, not a footnote: the same
        // readings give ±1.26pp under one and ±1.81pp under the other.
        (reading.tauSquaredPp2 > 0 ? `   τ² = ${reading.tauSquaredPp2.toFixed(2)}pp² (random effects, DerSimonian–Laird)` : ''),
    );
    // The verdict is a statement about the readings, and the pooled p is a statement about the
    // estimate; printing one without the other let `p ≈ 0.047 → one-run-only` read as a defect, and
    // `→ heterogeneous, readings agree` read as a contradiction. Each half gets its own sentence.
    if (reading.readings.length === 1) {
      lines.push('      1 reading, and one reading is not a result — this line says what is missing, not what is true');
    } else if (reading.readings.length > 1) {
      lines.push(
        `      ${String(reading.readingsSignificant)} of ${String(reading.readings.length)} readings significant, ` +
          `Q p = ${reading.heterogeneityP.toFixed(3)} — the readings differ ` +
          `${reading.heterogeneityP < 0.05 ? 'by more than' : 'no more than'} their own intervals`,
      );
    }
    // One line per problem. The statement below was once written twice, which printed every
    // failure as a pair and made a single unpoolable pair look like two.
    for (const problem of reading.problems) lines.push(`      FAILED ${problem}`);
  }
  for (const name of unscored) lines.push(`      ${name} did not score both arms, so it is not one of the readings`);
  return lines;
}

/** The line a reader needs to identify an artifact without opening it. */
function metaOf(report: RunArtifact): string {
  const when = report.generatedAt ?? 'no timestamp';
  return `${label(report)} · ${when}`;
}

export function main(argv: readonly string[] = process.argv.slice(2), root = process.cwd()): number {
  const settings = resolveCompareSettings(argv, root);
  const paths = [settings.left, settings.right, ...settings.also];
  const artifacts = paths.map((path) => [basename(path), JSON.parse(readFileSync(path, 'utf8')) as RunArtifact] as const);
  const [[leftName, left], [rightName, right]] = [artifacts[0] as (typeof artifacts)[number], artifacts[1] as (typeof artifacts)[number]];
  const report = compareRuns(left, right, leftName, rightName);
  const lines = compareLines(report, metaOf(left), metaOf(right));
  if (settings.also.length > 0) {
    // A reader who handed this command three runs will read the table above as covering three.
    lines.splice(1, 0, `  the comparison above is the first two paths; ${String(settings.also.length)} further artifact(s) are read for the pair only`);
  }
  for (const line of lines) console.log(line);
  if (settings.pair === undefined) return report.problems.length === 0 ? 0 : 1;
  const [pairLeft, pairRight] = settings.pair;
  const readings = artifacts
    .map(([name, artifact]) => readPairOf(artifact, name, pairLeft, pairRight))
    .filter((reading): reading is PairReading => reading !== undefined);
  const unscored = artifacts.map(([name]) => name).filter((name) => !readings.some((reading) => reading.artifact === name));
  const pooled = poolPair(readings, pairLeft, pairRight);
  for (const line of pooledLines([pooled], unscored)) console.log(line);
  return report.problems.length === 0 && pooled.problems.length === 0 ? 0 : 1;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
