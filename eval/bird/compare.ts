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
  return [
    {
      name: 'split',
      left: left.split ?? 'unknown',
      right: right.split ?? 'unknown',
      same: left.split === right.split,
      consequence: 'a rate on two splits is two numbers, not one reading twice',
    },
    {
      name: 'corpus.digest',
      left: digest(left),
      right: digest(right),
      same: digest(left) === digest(right) && digest(left) !== 'not recorded',
      consequence: 'the questions changed, so every floor pinned to either corpus is a floor on other questions',
    },
    {
      name: 'model.asked',
      left: typeof left.model === 'string' ? left.model : 'none',
      right: typeof right.model === 'string' ? right.model : 'none',
      same: (left.model ?? null) === (right.model ?? null),
      consequence: 'the two runs asked different endpoints for an answer',
    },
    {
      name: 'model.served',
      left: served(left),
      right: served(right),
      same: served(left) === served(right) && served(left) !== 'not recorded',
      consequence: 'the endpoint named a different base model, so the same alias answered with different weights',
    },
    {
      name: 'secondModel',
      left: second(left),
      right: second(right),
      same: second(left) === second(right),
      consequence: 'arms that draw a candidate from the second endpoint drew it from another one',
    },
    {
      name: 'harness',
      left: harnessOf(left),
      right: harnessOf(right),
      same: harnessOf(left) === harnessOf(right) && harnessOf(left) !== 'not recorded',
      consequence: 'a different deadline or concurrency converts slow answers into failures without touching the pipeline',
    },
  ];
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
  const broken = coordinates.filter((coordinate) => !coordinate.same).map((coordinate) => coordinate.name);
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
    const mark = coordinate.same ? 'same' : 'DIFFERS';
    lines.push(`    ${coordinate.name.padEnd(pad)}${coordinate.left}  ${coordinate.same ? '=' : '≠'}  ${coordinate.right}   ${mark}`);
  }
  for (const coordinate of report.coordinates.filter((item) => !item.same)) {
    lines.push(`    ${coordinate.name}: ${coordinate.consequence}`);
  }
  lines.push('');
  if (report.comparable) {
    lines.push('  verdict: comparable — these are the same experiment measured twice');
  } else {
    lines.push(`  verdict: not comparable — ${report.broken.join(', ')} changed, so a delta below is about that coordinate`);
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
}

export function resolveCompareSettings(argv: readonly string[], root: string): CompareSettings {
  const positional = argv.filter((item) => !item.startsWith('--'));
  if (positional.length !== 2) {
    throw new Error('usage: compare.ts <a.json> <b.json> — two artifacts, and the order is the direction of every delta');
  }
  const flags = argv.filter((item) => item.startsWith('--'));
  if (flags.length > 0) throw new Error(`unrecognized argument ${flags[0] as string}: this tool takes two artifact paths and nothing else`);
  return { left: resolve(root, positional[0] as string), right: resolve(root, positional[1] as string) };
}

/** The line a reader needs to identify an artifact without opening it. */
function metaOf(report: RunArtifact): string {
  const when = report.generatedAt ?? 'no timestamp';
  return `${label(report)} · ${when}`;
}

export function main(argv: readonly string[] = process.argv.slice(2), root = process.cwd()): number {
  const settings = resolveCompareSettings(argv, root);
  const left = JSON.parse(readFileSync(settings.left, 'utf8')) as RunArtifact;
  const right = JSON.parse(readFileSync(settings.right, 'utf8')) as RunArtifact;
  const report = compareRuns(left, right, basename(settings.left), basename(settings.right));
  for (const line of compareLines(report, metaOf(left), metaOf(right))) console.log(line);
  return report.problems.length === 0 ? 0 : 1;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
