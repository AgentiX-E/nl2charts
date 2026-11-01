/**
 * What a cold start costs: the regret of calibrating on a few questions instead of all of them.
 *
 * `packages/ai/src/adapt.ts` decides which of four bounded strategies a deployment should run,
 * from outcomes it collects while serving. That decision is untested until someone prices the
 * two ways it can be wrong: eight questions is not many, and the arm that leads after eight is
 * not necessarily the arm a full split would have chosen. This harness prices exactly that,
 * offline, over an artifact that already exists — the four strategies map onto four arms of the
 * dev split, so the cost of a cold start is a subtraction rather than another benchmark.
 *
 * Three numbers, and the difference between them is the whole point:
 *
 * - **chosen** — the accuracy the calibration window's verdict earns on the questions it never
 *   saw. This is what a deployment gets.
 * - **best fixed** — the accuracy the best strategy would have earned had the split been known
 *   in advance. This is the ceiling of any fixed choice, and `chosen - best fixed` is regret.
 * - **oracle** — the accuracy of a per-question router, which no fixed strategy can reach. The
 *   gap between it and *best fixed* is the headroom a router would have to work with, and it is
 *   reported so that a small regret is not mistaken for a solved problem.
 *
 * The pre-registered criterion is regret below one point with a window of 24 questions, which
 * is the smallest window the observer in `adapt.ts` will decide on with a margin. If the number
 * comes back larger, the honest reading is that a deployment should not calibrate at all: it
 * should run the default strategy and let `observe()` move it, which pays no calibration cost
 * and inherits the same intervals.
 *
 * Nothing here calls a model. The artifact is read, aligned and re-scored, so the measurement
 * is reproducible from a file and can be re-run on any future split for the price of a download.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chooseStrategy, strategy } from '@agentix-e/nl2charts-ai';
import type { Decision, StrategyName, Tally } from '@agentix-e/nl2charts-ai';

/** The arm each strategy is priced on. One mapping, so the pair cannot drift apart. */
export const STRATEGY_ARMS: Readonly<Record<StrategyName, string>> = {
  'single-lean': 'names',
  'single-full': 'metadata+evidence',
  'repeat-3': 'select',
  'aimed-3': 'select-mixed',
};

/** One row of a `bench:bird` artifact: one arm, one case, one verdict. */
export interface CaseRow {
  readonly arm: string;
  readonly id: string;
  readonly passed: boolean;
}

export interface Artifact {
  readonly split?: string;
  readonly model?: string;
  readonly cases: readonly CaseRow[];
}

/** One case, scored by every strategy that has an arm in the artifact. */
export interface AlignedCase {
  readonly id: string;
  readonly outcomes: Partial<Record<StrategyName, boolean>>;
}

const NAMES = Object.keys(STRATEGY_ARMS) as StrategyName[];

/**
 * Align the artifact onto cases every mapped arm answered.
 *
 * Intersection rather than union: a case missing from one arm would otherwise be scored as a
 * failure for that arm, which is the one error that makes a cheaper strategy look better than
 * it is. Order is the artifact's own, because the calibration window is "the first N questions
 * a deployment meets" and that order is the only defensible stand-in for it.
 */
export function align(artifact: Artifact): AlignedCase[] {
  const present = new Set(artifact.cases.map((row) => row.arm));
  const mapped = NAMES.filter((name) => present.has(STRATEGY_ARMS[name]));
  if (mapped.length < 2) {
    throw new Error(
      `the artifact carries ${String(mapped.length)} of the four strategy arms (${mapped.join(', ') || 'none'}); ` +
        `a regret needs at least two, and they must come from one run`,
    );
  }
  const verdicts = new Map<string, Map<StrategyName, boolean>>();
  const order: string[] = [];
  for (const row of artifact.cases) {
    const name = mapped.find((candidate) => STRATEGY_ARMS[candidate] === row.arm);
    if (name === undefined) continue;
    let byCase = verdicts.get(row.id);
    if (byCase === undefined) {
      byCase = new Map();
      verdicts.set(row.id, byCase);
      order.push(row.id);
    }
    byCase.set(name, row.passed);
  }
  const cases: AlignedCase[] = [];
  for (const id of order) {
    const byCase = verdicts.get(id)!;
    if (byCase.size !== mapped.length) continue;
    const outcomes: Partial<Record<StrategyName, boolean>> = {};
    for (const name of mapped) outcomes[name] = byCase.get(name)!;
    cases.push({ id, outcomes });
  }
  return cases;
}

/**
 * A deterministic reordering, so the calibration window is not also a slice of the split.
 *
 * BIRD's dev split is ordered by database, and difficulty varies by database: a window taken
 * from the front of that order meets one corner of the corpus, and the questions that follow it
 * meet a different one. Shuffling with a fixed seed keeps the harness reproducible while
 * removing the ordering — so a regret that survives the shuffle is a cold-start cost, and one
 * that does not was a property of where the split happens to start.
 */
export function shuffle(cases: readonly AlignedCase[], seed = 0x9e3779b9): AlignedCase[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...cases];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    const held = out[index]!;
    out[index] = out[swap]!;
    out[swap] = held;
  }
  return out;
}

/** Pass counts per strategy over a slice of cases. */
export function score(cases: readonly AlignedCase[]): Partial<Record<StrategyName, Tally>> {
  const counts: Partial<Record<StrategyName, Tally>> = {};
  for (const one of cases) {
    for (const name of NAMES) {
      const passed = one.outcomes[name];
      if (passed === undefined) continue;
      const tally = counts[name] ?? { passed: 0, total: 0 };
      counts[name] = { passed: tally.passed + (passed ? 1 : 0), total: tally.total + 1 };
    }
  }
  return counts;
}

export interface SimulationOptions {
  /** Questions the deployment calibrates on before it freezes a strategy. */
  readonly calibrate?: number;
  /** The strategy in force before calibration, which is what a switch is measured against. */
  readonly incumbent?: StrategyName;
  readonly z?: number;
}

export interface Simulation {
  readonly calibrate: number;
  readonly cases: number;
  readonly decision: Decision;
  readonly chosen: StrategyName;
  readonly calibration: Partial<Record<StrategyName, Tally>>;
  readonly measured: Partial<Record<StrategyName, Tally>>;
  readonly chosenAccuracy: number;
  readonly bestFixed: StrategyName;
  readonly bestFixedAccuracy: number;
  readonly oracleAccuracy: number;
  /** `bestFixedAccuracy - chosenAccuracy`: what the cold start cost. */
  readonly regret: number;
  /** `oracleAccuracy - bestFixedAccuracy`: what a per-question router could still add. */
  readonly headroom: number;
}

/** The window the plan pre-registers, in questions. */
export const DEFAULT_CALIBRATION = 24;

/** A rate, or zero for a strategy the window never measured. `score` never builds an empty tally. */
function accuracyOf(tally: Tally | undefined): number {
  if (tally === undefined) return 0;
  return tally.passed / tally.total;
}

/**
 * Run one cold start: calibrate on the first `calibrate` cases, then live with the verdict.
 *
 * The calibration calls the same `chooseStrategy` the runtime calls, with the same intervals
 * and the same floor, because a simulation of a different rule answers a question nobody asked.
 */
export function simulate(cases: readonly AlignedCase[], options: SimulationOptions = {}): Simulation {
  const calibrate = options.calibrate ?? DEFAULT_CALIBRATION;
  const incumbent = options.incumbent ?? 'single-full';
  if (cases.length === 0) throw new Error('no aligned cases: the artifact and the mapping share no arm');
  if (calibrate >= cases.length) {
    throw new Error(
      `a calibration window of ${String(calibrate)} leaves nothing to measure on ${String(cases.length)} cases`,
    );
  }
  const window = cases.slice(0, calibrate);
  const calibration = score(window);
  const decision = chooseStrategy(calibration, {
    incumbent,
    ...(options.z === undefined ? {} : { z: options.z }),
  });
  const rest = cases.slice(calibrate);
  const measured = score(rest);
  const chosen = decision.strategy;
  const ranked = NAMES.filter((name) => measured[name] !== undefined)
    .map((name) => ({ name, accuracy: accuracyOf(measured[name]) }))
    .sort((left, right) => right.accuracy - left.accuracy);
  const best = ranked[0]!;
  const oraclePassed = rest.filter((one) => NAMES.some((name) => one.outcomes[name] === true)).length;
  return {
    calibrate,
    cases: cases.length,
    decision,
    chosen,
    calibration,
    measured,
    chosenAccuracy: accuracyOf(measured[chosen]),
    bestFixed: best.name,
    bestFixedAccuracy: best.accuracy,
    oracleAccuracy: oraclePassed / rest.length,
    regret: best.accuracy - accuracyOf(measured[chosen]),
    headroom: oraclePassed / rest.length - best.accuracy,
  };
}

/** The same cold start at several window sizes, which is how a window is chosen rather than assumed. */
export function sweep(cases: readonly AlignedCase[], windows: readonly number[], options: SimulationOptions = {}): Simulation[] {
  return windows
    .filter((calibrate) => calibrate > 0 && calibrate < cases.length)
    .map((calibrate) => simulate(cases, { ...options, calibrate }));
}

const pp = (value: number): string => `${(value * 100).toFixed(2)}pp`;
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** The table a report quotes. Ports are fixed, because a table that shifts is not comparable. */
export function reportLines(simulations: readonly Simulation[], model = 'unknown'): string[] {
  const lines = [
    `cold start on ${String(simulations[0]?.cases ?? 0)} cases (${model})`,
    '',
    '| window | chosen | accuracy | best fixed | accuracy | oracle | regret | headroom |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const one of simulations) {
    lines.push(
      `| ${String(one.calibrate)} | \`${one.chosen}\` | ${pct(one.chosenAccuracy)} | \`${one.bestFixed}\` | ` +
        `${pct(one.bestFixedAccuracy)} | ${pct(one.oracleAccuracy)} | ${pp(one.regret)} | ${pp(one.headroom)} |`,
    );
  }
  return lines;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

interface Settings {
  readonly artifact: string;
  readonly windows: readonly number[];
  readonly order: 'artifact' | 'shuffled';
  readonly json: boolean;
}

export function resolveSettings(argv: readonly string[], root: string): Settings {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const windows = (flag('--windows') ?? '12,24,48,96,192')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  const artifact = flag('--artifact') ?? `${root}/eval/bird/artifacts/bird-eval-dev.json`;
  const order = (flag('--order') ?? 'artifact') === 'shuffled' ? 'shuffled' : 'artifact';
  return {
    artifact,
    windows: windows.length > 0 ? windows : [DEFAULT_CALIBRATION],
    order,
    json: argv.includes('--json'),
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2), root = process.cwd()): Promise<number> {
  const settings = resolveSettings(argv, root);
  const artifact = JSON.parse(readFileSync(settings.artifact, 'utf8')) as Artifact;
  const aligned = align(artifact);
  const cases = settings.order === 'shuffled' ? shuffle(aligned) : aligned;
  const simulations = sweep(cases, settings.windows);
  if (settings.json) {
    console.log(JSON.stringify({ artifact: settings.artifact, model: artifact.model, simulations }, null, 2));
    return 0;
  }
  const heading = settings.order === 'shuffled' ? `${artifact.model ?? 'unknown'}, shuffled` : (artifact.model ?? 'unknown');
  for (const line of reportLines(simulations, heading)) console.log(line);
  const price = simulations.map((one) => strategy(one.chosen).calls);
  console.log(`\n  calls per question: ${[...new Set(price)].sort().join(', ')}`);
  return 0;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
