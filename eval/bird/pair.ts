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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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
  /** The arms, for the per-arm base model a header line names. Nothing here reads `passed` from it. */
  readonly arms?: readonly { readonly arm?: string; readonly servedModels?: Readonly<Record<string, number>> }[];
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

/**
 * The pairs a split promises to read, from `eval/baseline/pairs.json`.
 *
 * A declaration rather than a habit, because the habit was the problem: the placement reading was
 * taken by comparing two runs' rates (41.4 against 45.0), it was written into the benchmark
 * document as +3.6pp, and inside a single run the same two arms are 18 and 17 discordant cases with
 * p = 1.0000. A pair that is written down is read on every run; a pair that lives in someone's
 * memory is read once, in the direction the run happened to fall.
 *
 * A split with no entry declares nothing and this returns no pairs — an empty list is a statement
 * about the split, and it is the honest default for a split whose decision is not a delta.
 */
export function declaredPairs(root: string, split: string): string[][] {
  const path = join(root, 'eval/baseline/pairs.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const entry = raw[split];
  if (entry === undefined) return [];
  if (!Array.isArray(entry)) throw new Error(`pairs.json[${split}] is not a list of pairs`);
  return entry.map((item, index) => {
    if (!Array.isArray(item) || item.length !== 2 || item.some((name) => typeof name !== 'string' || name.trim() === '')) {
      throw new Error(`pairs.json[${split}][${String(index)}] is not a pair of arm names`);
    }
    return [String(item[0]).trim(), String(item[1]).trim()];
  });
}

/** The base models an artifact's arms were served by, for the header line. */
function servedOf(report: PairArtifact): string[] {
  const bases = new Set<string>();
  for (const arm of report.arms ?? []) for (const base of Object.keys(arm.servedModels ?? {})) bases.add(base);
  return [...bases].sort();
}

/** One declared pair as it came out: the outcome, or the arms the run did not score. */
export interface DeclaredReading {
  readonly left: string;
  readonly right: string;
  readonly outcome?: PairOutcome;
  readonly missing: readonly string[];
}

export function readDeclared(report: PairArtifact, pairs: readonly (readonly string[])[]): DeclaredReading[] {
  const scored = new Set((report.cases ?? []).map((entry) => entry.arm));
  return pairs.map((pair) => {
    const [left = '', right = ''] = pair;
    const missing = [left, right].filter((arm) => !scored.has(arm));
    return missing.length > 0
      ? { left, right, missing }
      : { left, right, missing: [], outcome: pairOutcome(report, left, right) };
  });
}

/** One line per pair: the counts, the test, and the only verdict a pair can support. */
export function declaredLines(readings: readonly DeclaredReading[], artifact: PairArtifact): string[] {
  const questions = new Set((artifact.cases ?? []).map((entry) => String(entry.id))).size;
  const bases = servedOf(artifact);
  const served = bases.length === 0 ? '' : ` served by ${bases.join('+')}`;
  const lines = [
    `paired readings · ${artifact.split ?? 'unknown split'} · ${artifact.model ?? 'no model'}${served} · ${String(questions)} questions`,
  ];
  for (const reading of readings) {
    const pair = `${reading.left} -> ${reading.right}`;
    if (reading.outcome === undefined) {
      lines.push(`  ${pair.padEnd(52)} not scored this run (${reading.missing.join(', ')})`);
      continue;
    }
    const outcome = reading.outcome;
    const rate = outcome.examined === 0 ? 0 : ((outcome.wins - outcome.losses) / outcome.examined) * 100;
    const verdict =
      outcome.p < 0.05
        ? `${rate >= 0 ? '+' : ''}${rate.toFixed(2)}pp, separable at p = ${outcome.p.toFixed(4)}`
        : `no difference (${outcome.wins} won, ${outcome.losses} lost, p = ${outcome.p.toFixed(4)})`;
    lines.push(`  ${pair.padEnd(52)} ${String(outcome.wins).padStart(3)} / ${String(outcome.losses).padStart(3)}   ${verdict}`);
  }
  return lines;
}

export interface PairSettings {
  readonly report: string;
  readonly left?: string;
  readonly right?: string;
  /** Set when the pairs come from the declaration file rather than from `--pair`. */
  readonly declared?: boolean;
}

export function resolvePairSettings(argv: readonly string[], root: string): PairSettings {
  const consumed = new Set<number>();
  argv.forEach((item, index) => {
    if (!item.startsWith('--')) return;
    consumed.add(index);
    // `--declared` takes no value, so the token after it is the artifact, not a name.
    if (item !== '--declared') consumed.add(index + 1);
  });
  const path = argv.find((item, index) => !item.startsWith('--') && !consumed.has(index));
  const flag = argv.indexOf('--pair');
  const declared = argv.includes('--declared');
  if (path === undefined) throw new Error('usage: pair.ts <artifact.json> --pair <left>,<right> -- or --declared <artifact.json>');
  if (declared && flag !== -1) {
    throw new Error('--pair and --declared name two different readings of the same artifact; run them as two commands');
  }
  if (declared) return { report: resolve(root, path), declared: true };
  if (flag === -1) throw new Error('pair.ts needs --pair <left>,<right>, because a pair with one name is an arm nobody compared');
  const names = (argv[flag + 1] ?? '').split(',');
  if (names.length !== 2 || names.some((name) => name.trim() === '')) {
    throw new Error('--pair takes two arm names, for example inline+evidence,inline+evidence+projection');
  }
  return { report: resolve(root, path), left: (names[0] as string).trim(), right: (names[1] as string).trim() };
}

/**
 * The declared pairs of one artifact, printed and written beside it.
 *
 * The file it writes is what the summary and any later reader consume, so a number that appears in
 * a document can be traced to a run rather than to a habit. A split with no declaration is not an
 * error: it is a split whose decision is not a delta, and saying so is more useful than inventing
 * a pair for it.
 */
export function runDeclared(report: PairArtifact, root: string, path: string): number {
  const split = report.split ?? 'minidev';
  const pairs = declaredPairs(root, split);
  const bases = servedOf(report);
  const served = bases.length === 0 ? '' : ` served by ${bases.join('+')}`;
  console.log(`  ${relative(root, path)} (${split}${report.model === undefined ? '' : `, ${report.model}`}${served})`);
  if (pairs.length === 0) {
    console.log(`  no pair is declared for ${split}, so this run settles no delta`);
    return 0;
  }
  const readings = readDeclared(report, pairs);
  for (const line of declaredLines(readings, report)) console.log(line);
  const questions = new Set((report.cases ?? []).map((entry) => String(entry.id))).size;
  // Beside the artifact it describes, not in `eval/out`: a run pointed at another file (`BIRD_OUT`)
  // must not have its readings land in the default directory, where the next summary would read
  // them as that run's — and where a test fixture would overwrite a CI reading.
  const beside = join(dirname(path), 'bird-pairs.json');
  mkdirSync(dirname(beside), { recursive: true });
  writeFileSync(
    beside,
    `${JSON.stringify(
      {
        split,
        model: report.model ?? null,
        served: bases,
        questions,
        pairs: readings.map((reading) =>
          reading.outcome === undefined
            ? { left: reading.left, right: reading.right, missing: reading.missing }
            : {
                left: reading.left,
                right: reading.right,
                examined: reading.outcome.examined,
                wins: reading.outcome.wins,
                losses: reading.outcome.losses,
                p: reading.outcome.p,
              },
        ),
      },
      null,
      1,
    )}\n`,
  );
  const problems = readings.flatMap((reading) => reading.outcome?.problems ?? []);
  for (const problem of problems) console.error(`PAIR: ${problem}`);
  return problems.length === 0 ? 0 : 1;
}

export function main(argv: readonly string[] = process.argv.slice(2), root = process.cwd()): number {
  const settings = resolvePairSettings(argv, root);
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as PairArtifact;
  if (settings.declared === true) return runDeclared(report, root, settings.report);
  const outcome = pairOutcome(report, settings.left as string, settings.right as string);
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
