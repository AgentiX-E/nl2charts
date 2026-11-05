/**
 * Two arms, one artifact, and the counts a delta cannot produce on its own.
 *
 * Every number this repository publishes about an arm is a rate, and a rate difference has no
 * denominator for its own uncertainty. `941` against `939` on 1,532 questions is `-0.13pp`, and
 * that sentence alone cannot say whether the move was two cases or two hundred: an arm that wins
 * 64 cases and loses 66 is the same rate as an arm that wins 6 and loses 8, and only one of them
 * is worth a second dispatch.
 *
 * Three quantities are missing from a rate, and this file prints them:
 *
 * - **The discordant counts.** The cases where exactly one arm is right are the only cases that
 *   carry information about the difference; the rest are agree-correct or agree-wrong and a
 *   statistic over them measures the corpus, not the lever. `mcnemarExact` over the two counts is
 *   the test that uses only them.
 * - **The shape transition.** A wrong answer has a reason, and a lever that repairs a bucket
 *   shows it as `column-count -> match`. A lever that *moves* a failure into another bucket shows
 *   it as `column-count -> values`, and the two look identical in an accuracy column: this is the
 *   reading that separates a repair from a redistribution, and it is why the projection rule was
 *   rejected rather than adopted on a `-5` in its bucket.
 * - **The shape totals per arm.** The marginal the transition table is built from, so a reader
 *   can check the arithmetic instead of trusting the diagonal.
 *
 * The instrument spends no model call: it reads a single artifact in which both arms were scored
 * on the same questions by the same judge, which is the only shape in which a paired test is
 * legitimate. Two artifacts are refused rather than joined — a join across runs reintroduces the
 * endpoint's own displacement into a delta that was supposed to have no noise in it, and this
 * repository has already published one movement of that size.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mcnemarExact } from '@agentix-e/nl2charts-devkit';

/** The reason an arm is credited with on a case it got right. */
export const MATCH = 'match';

/** One case as the artifact files it: which arm, which question, and why it is wrong if it is. */
export interface PairCase {
  readonly arm: string;
  readonly id: string | number;
  readonly passed?: boolean;
  readonly reason?: string;
}

/** The part of a run artifact this instrument reads. */
export interface PairArtifact {
  readonly split?: string;
  readonly model?: string;
  readonly cases?: readonly PairCase[];
  readonly failures?: unknown;
}

/** One row of the transition table: a shape in the left arm, a shape in the right one. */
export interface ShapeTransition {
  readonly from: string;
  readonly to: string;
  readonly cases: number;
}

/** What one arm's cases are made of, in the order the artifact's own vocabulary names them. */
export interface ShapeTotal {
  readonly arm: string;
  readonly shape: string;
  readonly cases: number;
}

export interface PairOutcome {
  readonly left: string;
  readonly right: string;
  /** Questions both arms scored. The denominator of every count below. */
  readonly examined: number;
  /** Cases only the right arm passes. */
  readonly wins: number;
  /** Cases only the left arm passes. */
  readonly losses: number;
  readonly both: number;
  readonly neither: number;
  /** Exact McNemar over the two discordant counts. */
  readonly p: number;
  readonly transitions: readonly ShapeTransition[];
  readonly shapes: readonly ShapeTotal[];
  readonly unpaired: readonly string[];
  readonly problems: readonly string[];
}

/**
 * The shape a case was filed under, with success as a shape of its own.
 *
 * `match` rather than `pass` because the table is read as a movement *between shapes*, and a
 * column that means "not a failure" is one of them. A case the artifact does not classify is
 * `unclassified` rather than `match`: an absent reason is not a passing answer, which is the same
 * distinction the cache instrument makes between a zero and a missing column.
 */
export function shapeOf(entry: PairCase): string {
  if (entry.passed === true) return MATCH;
  return entry.reason ?? 'unclassified';
}

/** Case id → shape for one arm. Later duplicates win, because a re-scored case is the later one. */
function shapeIndex(cases: readonly PairCase[], arm: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of cases) {
    if (entry.arm !== arm) continue;
    index.set(String(entry.id), shapeOf(entry));
  }
  return index;
}

/**
 * The paired reading of two arms in one artifact.
 *
 * The left arm is the parent and the right one is the lever; the naming is not decorative —
 * `wins` and `losses` are stated from the parent's point of view, so `-0.13pp` arrives with the
 * 64 and the 66 that produced it.
 */
export function pairOutcome(report: PairArtifact, left: string, right: string): PairOutcome {
  const cases = report.cases ?? [];
  const leftIndex = shapeIndex(cases, left);
  const rightIndex = shapeIndex(cases, right);
  if (leftIndex.size === 0) throw new Error(`${left} is not scored in this artifact, so there is no pair to read`);
  if (rightIndex.size === 0) throw new Error(`${right} is not scored in this artifact, so there is no pair to read`);
  const shared: string[] = [];
  const unpaired: string[] = [];
  for (const id of leftIndex.keys()) (rightIndex.has(id) ? shared : unpaired).push(id);
  const reverseUnpaired: string[] = [];
  for (const id of rightIndex.keys()) if (!leftIndex.has(id)) reverseUnpaired.push(id);
  const transitions = new Map<string, number>();
  let wins = 0;
  let losses = 0;
  let both = 0;
  let neither = 0;
  for (const id of shared) {
    const from = leftIndex.get(id) as string;
    const to = rightIndex.get(id) as string;
    const key = `${from}\u0000${to}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
    const leftWon = from === MATCH;
    const rightWon = to === MATCH;
    if (leftWon && rightWon) both += 1;
    if (!leftWon && !rightWon) neither += 1;
    if (!leftWon && rightWon) wins += 1;
    if (leftWon && !rightWon) losses += 1;
  }
  const rows: ShapeTransition[] = [];
  for (const [key, count] of transitions) {
    const [from, to] = key.split('\u0000') as [string, string];
    rows.push({ from, to, cases: count });
  }
  rows.sort((one, two) => two.cases - one.cases || one.from.localeCompare(two.from) || one.to.localeCompare(two.to));
  const problems = pairProblems({ left, right, shared: shared.length, unpaired: [...unpaired, ...reverseUnpaired] });
  return {
    left,
    right,
    examined: shared.length,
    wins,
    losses,
    both,
    neither,
    p: mcnemarExact(losses, wins),
    transitions: rows,
    shapes: summaries(cases, [left, right]),
    unpaired: [...unpaired, ...reverseUnpaired].sort(),
    problems,
  };
}

/** What makes a pair unreadable, as opposed to unflattering. */
export function pairProblems(state: {
  readonly left: string;
  readonly right: string;
  readonly shared: number;
  readonly unpaired: readonly string[];
}): string[] {
  const problems: string[] = [];
  if (state.shared === 0) {
    problems.push(`the two arms share no question, so ${state.left} and ${state.right} cannot be compared`);
  }
  if (state.unpaired.length > 0) {
    problems.push(`${String(state.unpaired.length)} question(s) are scored by one arm and not the other, so the pair is not paired`);
  }
  return problems;
}

/** Per-arm shape totals, each arm's shapes in descending count and ties broken by name. */
export function summaries(cases: readonly PairCase[], arms: readonly string[]): ShapeTotal[] {
  const rows: ShapeTotal[] = [];
  for (const arm of arms) {
    const counts = new Map<string, number>();
    for (const shape of shapeIndex(cases, arm).values()) {
      counts.set(shape, (counts.get(shape) ?? 0) + 1);
    }
    const sorted = [...counts].sort((one, two) => two[1] - one[1] || one[0].localeCompare(two[0]));
    for (const [shape, count] of sorted) rows.push({ arm, shape, cases: count });
  }
  return rows;
}

/** A count with its share of the pairs examined, so a reader does not divide by hand. */
function share(count: number, total: number): string {
  return total === 0 ? '  -  ' : `${((count / total) * 100).toFixed(1)}%`;
}

export function pairLines(outcome: PairOutcome): string[] {
  const lines: string[] = [];
  lines.push(`  ${outcome.left} -> ${outcome.right}: ${String(outcome.examined)} paired question(s)`);
  lines.push(`  agree correct ${String(outcome.both)}  agree wrong ${String(outcome.neither)}  only right ${String(outcome.wins)}  only left ${String(outcome.losses)}`);
  lines.push(`  exact McNemar p = ${outcome.p.toFixed(4)}  (the agree rows carry no information about the difference)`);
  const moved = outcome.transitions.filter((row) => row.from !== row.to);
  lines.push('');
  if (moved.length === 0) {
    lines.push('  no case changed shape: the two arms fail in exactly the same places for exactly the same reasons');
  } else {
    lines.push('  what changed shape (diagonal omitted):');
    for (const row of moved) {
      lines.push(`    ${row.from.padEnd(14)} -> ${row.to.padEnd(14)} ${String(row.cases).padStart(5)}  ${share(row.cases, outcome.examined)}`);
    }
  }
  lines.push('');
  lines.push('  shapes, per arm:');
  for (const row of outcome.shapes) {
    lines.push(`    ${row.arm.padEnd(30)} ${row.shape.padEnd(14)} ${String(row.cases).padStart(5)}`);
  }
  return lines;
}

export interface PairSettings {
  readonly report: string;
  readonly left: string;
  readonly right: string;
}

export function resolvePairSettings(argv: readonly string[], root: string): PairSettings {
  const consumed = new Set<number>();
  argv.forEach((item, index) => {
    if (item.startsWith('--')) consumed.add(index).add(index + 1);
  });
  const path = argv.find((item, index) => !item.startsWith('--') && !consumed.has(index));
  if (path === undefined) throw new Error('usage: pair.ts <artifact.json> --pair <left>,<right>');
  const flag = argv.indexOf('--pair');
  if (flag === -1) throw new Error('pair.ts needs --pair <left>,<right>, because a pair with one name is an arm nobody compared');
  const names = (argv[flag + 1] ?? '').split(',');
  if (names.length !== 2 || names.some((name) => name.trim() === '')) {
    throw new Error('--pair takes two arm names, for example inline+evidence,inline+evidence+projection');
  }
  return { report: resolve(root, path), left: (names[0] as string).trim(), right: (names[1] as string).trim() };
}

export function main(argv: readonly string[] = process.argv.slice(2), root = process.cwd()): number {
  const settings = resolvePairSettings(argv, root);
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as PairArtifact;
  const outcome = pairOutcome(report, settings.left, settings.right);
  console.log(`  ${relative(root, settings.report)}${report.split === undefined ? '' : ` (${report.split}${report.model === undefined ? '' : `, ${report.model}`})`}`);
  for (const line of pairLines(outcome)) console.log(line);
  for (const problem of outcome.problems) console.error(`PAIR: ${problem}`);
  return outcome.problems.length === 0 ? 0 : 1;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
