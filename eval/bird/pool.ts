/**
 * What one more candidate actually buys.
 *
 * Every measurement in this repository has priced a *decision* — which card, which selector,
 * whether to repair — and almost all of them came back null. The reason is arithmetic and it
 * was never written down in one place: an arm's score is the size of its candidate set times
 * the rate at which the selector converts it, and the second factor has been measured at 84-98%
 * while the first has hovered around 62-66%. A lever on the selector can therefore move at most
 * a point. A lever on the pool can move five, and only if the pool is what limits the score.
 *
 * This harness reads that split off an artifact the runner already wrote. It costs no model call
 * and no oracle query: `cases[].candidates` records, per case, every candidate the arm kept and
 * whether it was the right answer, and `cases[].passed` records what the selector did with it.
 *
 * Three readings, in the order they decide anything:
 *
 * 1. **A pool's recall is its ceiling.** `select` keeps three draws of one prompt and 65.66% of
 *    the dev questions have a correct statement among them, while the arm scores 60.97%. The
 *    4.69pp between those two numbers is what its selector threw away, and no selector can score
 *    above the ceiling it is given.
 * 2. **The union is the ceiling of the whole idea.** Take every pool in the artifact, keep the
 *    questions any of them answers, and the number left is the most a selector could reach if it
 *    saw all of them at once. On the dev artifact that is 67.49% against a best arm of 62.34%,
 *    so the entire remaining prize in candidate work is 5.15pp, not the 10.9pp between this
 *    product and the published leader.
 * 3. **The marginal pool is the decision.** A ceiling is not purchasable in aggregate: each pool
 *    costs one generation call. So the harness greedily adds the pool that contributes the most
 *    questions it had not already covered, and prints the sequence with its price. Greedy is not
 *    optimal — the remaining pools interact — but it is deterministic, it is the rule an arm
 *    table can actually be written from, and the union printed beside it bounds the error.
 *
 * The criterion is stated before the reading, as everywhere else here: a pool that adds fewer
 * questions than the split's own minimum detectable effect cannot be told from the draw, so its
 * call is not worth spending. The number defaults to the dev split's published 2.30pp and is a
 * flag because a future artifact may be a different split with a different MDE.
 *
 * Two honest limits, both printed rather than argued:
 *
 * - A ceiling is not a score. Every pool's own `passed` is printed next to its recall so the
 *   conversion rate the reader should apply is the arm's, not 100%.
 * - Pools from different arms are *different draws*, not the same candidate twice. `select`'s
 *   three samples of `inline+evidence` and `select-mixed`'s single sample of the same prompt are
 *   four independent draws of one configuration, which is why the union of the two arms is
 *   measurable and an arm that samples five times is not the same purchase.
 */
import { readFileSync } from 'node:fs';
import { declaresCandidateSet, scoredQuestions } from './artifact.js';
import { pathToFileURL } from 'node:url';

/** The artifact fields this harness reads. Anything else is ignored, so older artifacts join. */
export interface PoolArtifact {
  readonly split?: unknown;
  readonly model?: unknown;
  readonly cases?: readonly {
    readonly id?: unknown;
    readonly arm?: unknown;
    readonly passed?: unknown;
    readonly winnerSource?: unknown;
    readonly candidates?: readonly { readonly source?: unknown; readonly correct?: unknown }[];
  }[];
  readonly arms?: readonly {
    readonly arm?: unknown;
    readonly calls?: { readonly mean?: unknown };
    /** Present only on a row that sampled more than one candidate: the ceiling it is read against. */
    readonly candidateRecall?: unknown;
  }[];
}

/**
 * One pool: the candidates one arm kept from one configuration, over the questions it ran.
 *
 * `covered` and `passed` are sets of question ids rather than counts because every downstream
 * reading is a set operation — a union, an intersection, a difference — and a count cannot be
 * unioned without losing which questions the two pools agreed on.
 */
export interface Pool {
  /** How the pool is named in the report: the arm, or `arm/source` when the arm drew several. */
  readonly name: string;
  readonly arm: string;
  /** Generation calls per question the arm spent, so a pool's price is its arm's price. */
  readonly calls: number;
  /** Questions where at least one of this pool's candidates was the right answer. */
  readonly covered: ReadonlySet<string>;
  /** Questions the arm ran at all. The denominator, before any intersection. */
  readonly cases: ReadonlySet<string>;
  /** Questions the arm scored, i.e. what its selector did with the pool. */
  readonly passed: ReadonlySet<string>;
}

/** One arm's pools taken together: the ceiling it offered, and what its selector made of it. */
export interface ArmSummary {
  readonly arm: string;
  readonly sources: number;
  readonly ceiling: ReadonlySet<string>;
  readonly scored: ReadonlySet<string>;
  readonly calls: number;
}

/** What reading an artifact produced: the pools, the shared denominator, and what was skipped. */
export interface Corpus {
  readonly pools: readonly Pool[];
  readonly arms: readonly ArmSummary[];
  /** Questions every pool ran, so one column can be compared with another. */
  readonly ids: readonly string[];
  /** Arms that carry no candidate set — one call, one statement — and cannot be a pool. */
  readonly single: readonly string[];
  /** Pools that ran fewer questions than the shared denominator, named with the shortfall. */
  readonly short: readonly { readonly name: string; readonly missing: number }[];
  /** Questions the judge passed whose record carries no correct candidate. */
  readonly unrecorded: number;
}

const nameOf = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

/**
 * Which pool a candidate belongs to, from the arm and the source the runner recorded.
 *
 * The single-prompt sampling arms record every candidate under their own name, so three draws of
 * one prompt are one pool named after the arm. A mixed arm records one source per candidate, so
 * each source is its own pool — they are different prompts, and a union over them is a claim
 * about prompt diversity rather than about sampling.
 */
export function poolName(arm: string, source: string): string {
  return source === arm ? arm : `${arm}/${source}`;
}

/**
 * Read the pools out of an artifact.
 *
 * Cases whose arm or id cannot be named are dropped instead of defaulted: a pool assembled from
 * unnamed rows would put anonymous questions in a union, and the union is the number that decides
 * the next arm.
 */
export function readPools(artifact: PoolArtifact): Corpus {
  const calls = new Map<string, number>();
  for (const row of artifact.arms ?? []) {
    const arm = nameOf(row.arm);
    if (arm === undefined) continue;
    const mean = row.calls?.mean;
    calls.set(arm, typeof mean === 'number' && Number.isFinite(mean) ? mean : 1);
  }
  // The denominator and the score belong to the *arm*, not to one of its prompts: a question
  // where every candidate died is still a question the arm ran and scored zero on, and taking the
  // cases from the candidate rows alone would delete exactly those — the hardest ones — from
  // every union and publish a ceiling nobody could reach.
  const armCases = new Map<string, Set<string>>();
  const armPassed = new Map<string, Set<string>>();
  const covered = new Map<string, Set<string>>();
  const winnerOf = new Map<string, string>();
  const arms = new Set<string>();
  for (const row of artifact.cases ?? []) {
    const arm = nameOf(row.arm);
    const id = row.id === undefined ? undefined : String(row.id);
    if (arm === undefined || id === undefined) continue;
    arms.add(arm);
    const ran = armCases.get(arm) ?? new Set<string>();
    ran.add(id);
    armCases.set(arm, ran);
    if (row.passed === true) {
      const scored = armPassed.get(arm) ?? new Set<string>();
      scored.add(id);
      armPassed.set(arm, scored);
    }
    const candidates = row.candidates ?? [];
    let recorded = false;
    for (const candidate of candidates) {
      const name = poolName(arm, nameOf(candidate.source) ?? arm);
      const held = covered.get(name) ?? new Set<string>();
      if (candidate.correct === true) {
        held.add(id);
        recorded = true;
      }
      covered.set(name, held);
    }
    // A passed question whose record names no correct candidate is a hole in the artifact, not a
    // question outside the ceiling: the judge saw a correct statement, so one existed. The runner
    // used to drop the per-candidate record when only one candidate survived, which is exactly
    // the case where the pool was smallest — so this branch is the repair of that defect and the
    // count is printed rather than absorbed.
    if (row.passed === true && !recorded) {
      const source = row.winnerSource;
      if (typeof source === 'string' && source.length > 0) winnerOf.set(`${arm}\u0000${id}`, poolName(arm, source));
      else winnerOf.set(`${arm}\u0000${id}`, arm);
    }
  }
  // Counted here rather than in the loop above: a one-call arm has no candidate record for *any*
  // question, so counting its passes as holes would report the arm's shape as an artifact defect.
  let unrecorded = 0;
  for (const [key, name] of winnerOf) {
    const [arm, id] = key.split('\u0000') as [string, string];
    const target = covered.has(name) ? name : covered.has(arm) ? arm : undefined;
    if (target === undefined) continue;
    unrecorded += 1;
    (covered.get(target) as Set<string>).add(id);
  }
  // An arm keeps a candidate set when at least one of its rows carries a candidate; the rest are
  // one-call arms, which have nothing to pool and are named apart so the report says how much of
  // the artifact it is describing.
  const single = [...arms].filter((arm) => ![...covered.keys()].some((name) => name === arm || name.startsWith(`${arm}/`)));
  const names = [...covered.keys()].sort((left, right) => left.localeCompare(right));
  if (names.length === 0) return { pools: [], arms: [], ids: [], single: single.sort((a, b) => a.localeCompare(b)), short: [], unrecorded };
  const poolArm = (name: string): string => (name.includes('/') ? (name.split('/')[0] as string) : name);
  // Every name in `names` came from a candidate row, and every candidate row added its arm to
  // `armCases`, so these lookups cannot miss. The casts say that rather than a `?? new Set()` that
  // no test could reach honestly.
  let ids = [...(armCases.get(poolArm(names[0] as string)) as Set<string>)];
  for (const name of names.slice(1)) {
    const held = armCases.get(poolArm(name)) as Set<string>;
    ids = ids.filter((id) => held.has(id));
  }
  ids.sort((left, right) => Number(left) - Number(right));
  const shared = new Set(ids);
  const short: { name: string; missing: number }[] = [];
  const pools: Pool[] = names.map((name) => {
    const arm = poolArm(name);
    const ran = armCases.get(arm) as Set<string>;
    const missing = ran.size - ids.length;
    if (missing > 0) short.push({ name, missing });
    const scored = new Set([...(armPassed.get(arm) ?? new Set<string>())].filter((id) => shared.has(id)));
    return {
      name,
      arm,
      calls: calls.get(arm) ?? 1,
      covered: new Set([...(covered.get(name) as Set<string>)].filter((id) => shared.has(id))),
      cases: new Set(ids),
      passed: scored,
    };
  });
  const summaries: ArmSummary[] = [...new Set(pools.map((pool) => pool.arm))]
    .sort((left, right) => left.localeCompare(right))
    .map((arm) => {
      const mine = pools.filter((pool) => pool.arm === arm);
      const ceiling = new Set<string>();
      for (const pool of mine) for (const id of pool.covered) ceiling.add(id);
      return {
        arm,
        sources: mine.length,
        ceiling,
        scored: (mine[0] as Pool).passed,
        calls: (mine[0] as Pool).calls,
      };
    });
  return { pools, arms: summaries, ids, single: single.sort((a, b) => a.localeCompare(b)), short, unrecorded };
}

/** How many of the shared questions a pool, or a set of them, has a correct statement for. */
export function coveredBy(pools: readonly Pool[], ids: readonly string[]): number {
  let count = 0;
  for (const id of ids) {
    if (pools.some((pool) => pool.covered.has(id))) count += 1;
  }
  return count;
}

/** The pools that answer a question no other pool answers. */
export function uniqueTo(pool: Pool, pools: readonly Pool[]): number {
  let count = 0;
  for (const id of pool.cases) {
    if (!pool.covered.has(id)) continue;
    if (pools.some((other) => other !== pool && other.covered.has(id))) continue;
    count += 1;
  }
  return count;
}

/** One step of the greedy path: the pool added, what it cost, and what it bought. */
export interface Step {
  readonly name: string;
  readonly calls: number;
  /** Questions covered after this step, over the shared denominator. */
  readonly covered: number;
  /** Questions this step added that no earlier step covered. */
  readonly added: number;
}

/**
 * Add pools in the order that buys the most uncovered questions, one call at a time.
 *
 * The first step is the widest pool, because the path describes a sequence of purchases and no
 * arm starts by buying its second-best prompt. Ties go to the alphabetically earlier name, so two
 * runs of the harness on one artifact produce the same table — a path that moved between runs
 * would make a changed reading indistinguishable from a changed tie-break.
 */
export function greedy(corpus: Corpus): Step[] {
  const { pools, ids } = corpus;
  if (pools.length === 0) return [];
  const remaining = [...pools].sort((left, right) => left.name.localeCompare(right.name));
  const seen = new Set<string>();
  const steps: Step[] = [];
  while (remaining.length > 0) {
    let bestAt = 0;
    let bestAdded = -1;
    for (let index = 0; index < remaining.length; index += 1) {
      const pool = remaining[index] as Pool;
      let added = 0;
      for (const id of ids) if (!seen.has(id) && pool.covered.has(id)) added += 1;
      if (added > bestAdded) {
        bestAdded = added;
        bestAt = index;
      }
    }
    const [pool] = remaining.splice(bestAt, 1) as [Pool];
    for (const id of pool.covered) seen.add(id);
    steps.push({ name: pool.name, calls: pool.calls, covered: seen.size, added: bestAdded });
  }
  return steps;
}

export interface PoolSettings {
  readonly artifact: string;
  /** The smallest gain the split can distinguish, in percentage points. */
  readonly margin: number;
  readonly json: boolean;
}

/** The dev split's published MDE, used when a caller does not state one. */
export const DEFAULT_MARGIN_PP = 2.3;

export function resolvePoolSettings(argv: readonly string[], _root: string): PoolSettings {
  // An argument this harness does not know is refused rather than ignored, and refused *first*,
  // because the first version ignored them: CI ran `bench:bird:pool eval/out/bird-eval.json`, the
  // path was read as nothing, the harness said "--artifact is required", and the step failed with a
  // message about a flag the caller had clearly meant to supply. A silent drop turns one mistake
  // into a hunt for a second one; naming the token ends it in the sentence that already exists.
  const takesValue = new Set(['--artifact', '--margin']);
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
  return { artifact, margin, json: argv.includes('--json') };
}

/** Every line the report prints, in the order a reader needs them. */
export function reportLines(corpus: Corpus, settings: PoolSettings, artifact: PoolArtifact): string[] {
  const { pools, arms, ids } = corpus;
  const percent = (part: number, whole: number): string => `${((part / Math.max(1, whole)) * 100).toFixed(2)}%`;
  const points = (part: number, whole: number): string => `${((part / Math.max(1, whole)) * 100).toFixed(2)}pp`;
  const label = (text: string): string => `  ${text.padEnd(34)}`;
  const lines = [
    `candidate pools on ${String(ids.length)} questions (${String(artifact.split ?? 'unknown')}, ${String(artifact.model ?? 'unknown')})`,
    corpus.single.length === 0
      ? 'every arm in this artifact kept a candidate set'
      : `${String(corpus.single.length)} arm(s) kept one candidate and are not pools: ${corpus.single.join(', ')}`,
    ...corpus.short.map((entry) => `${entry.name} ran ${String(entry.missing)} question(s) fewer than the rest, so every number below is over the ${String(ids.length)} they share`),
    ...(corpus.unrecorded === 0
      ? []
      : [
          `${String(corpus.unrecorded)} passed question(s) carry no correct candidate in their record — the judge saw one, so they are counted as covered`,
        ]),
    '',
    `${label('arm')} ${'sources'.padStart(7)} ${'ceiling'.padStart(8)} ${'scored'.padStart(7)} ${'lost'.padStart(8)} ${'calls'.padStart(6)}`,
  ];
  const byCeiling = [...arms].sort((left, right) => right.ceiling.size - left.ceiling.size || left.arm.localeCompare(right.arm));
  for (const arm of byCeiling) {
    const scored = arm.scored.size;
    lines.push(
      `${label(arm.arm)} ${String(arm.sources).padStart(7)} ${percent(arm.ceiling.size, ids.length).padStart(8)} ` +
        `${percent(scored, ids.length).padStart(7)} ${points(arm.ceiling.size - scored, ids.length).padStart(8)} ${arm.calls.toFixed(2).padStart(6)}`,
    );
  }
  lines.push('');
  lines.push(`${label('pool')} ${'recall'.padStart(7)} ${'unique'.padStart(7)}`);
  const byRecall = [...pools].sort((left, right) => right.covered.size - left.covered.size || left.name.localeCompare(right.name));
  for (const pool of byRecall) {
    lines.push(
      `${label(pool.name)} ${percent(pool.covered.size, ids.length).padStart(7)} ${String(uniqueTo(pool, pools)).padStart(7)}`,
    );
  }
  const union = coveredBy(pools, ids);
  const best = byCeiling[0];
  lines.push('');
  lines.push(`${label(`union of all ${String(pools.length)} pools`)} ${' '.repeat(7)} ${percent(union, ids.length).padStart(7)}`);
  if (best !== undefined) {
    lines.push(`${label(`headroom over ${best.arm}`)} ${' '.repeat(7)} ${points(union - best.ceiling.size, ids.length).padStart(7)}`);
  }
  const steps = greedy(corpus);
  lines.push('');
  lines.push('  what each further call buys, adding pools in the order that covers the most questions:');
  for (const step of steps) {
    lines.push(
      `    + ${step.name.padEnd(34)} ${percent(step.covered, ids.length).padStart(7)}  ` +
        `+${percent(step.added, ids.length)} (${String(step.added)} questions) for ${step.calls.toFixed(2)} call(s) a question`,
    );
  }
  const first = steps[1];
  lines.push('');
  lines.push(`  criterion: a pool earns its call only if it adds ${settings.margin.toFixed(2)}pp or more of ceiling`);
  if (first === undefined) {
    lines.push('  verdict: one pool, nothing to add — this artifact prices no further candidate');
  } else {
    const gain = (first.added / Math.max(1, ids.length)) * 100;
    lines.push(
      gain >= settings.margin
        ? `  verdict: a second pool buys ${gain.toFixed(2)}pp of ceiling, above the ${settings.margin.toFixed(2)}pp line — the pool is worth widening`
        : `  verdict: the best second pool buys ${gain.toFixed(2)}pp of ceiling, under the ${settings.margin.toFixed(2)}pp the split can resolve — widening the pool cannot be measured here`,
    );
  }
  return lines;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function main(argv: readonly string[], root: string, log: (line: string) => void = console.log): number {
  const settings = resolvePoolSettings(argv, root);
  const artifact = readJson<PoolArtifact>(settings.artifact);
  const corpus = readPools(artifact);
  if (corpus.pools.length === 0) {
    // Two absences, one sentence each. A dispatch of single-call arms is a legal artifact and the
    // reading is that there is nothing to pool; an arm that publishes a ceiling with no candidates
    // beside it lost records it had, and is refused.
    if (declaresCandidateSet(artifact.arms)) {
      throw new Error('an arm in this artifact publishes a candidate ceiling and none of its cases carries a candidate, so the artifact lost records it had');
    }
    log(
      `no arm in this artifact draws more than one candidate, so there is no pool to price (${String(scoredQuestions(artifact.cases))} questions)`,
    );
    return 0;
  }
  const lines = reportLines(corpus, settings, artifact);
  if (settings.json) {
    log(JSON.stringify({ cases: corpus.ids.length, pools: corpus.pools.map((pool) => pool.name), union: coveredBy(corpus.pools, corpus.ids), steps: greedy(corpus), lines }, null, 2));
  } else {
    for (const line of lines) log(line);
  }
  return 0;
}

/**
 * Run as a script when — and only when — this file is the entry point.
 *
 * Split out for the same reason `route.ts` splits it: an entry check written inline is
 * unreachable from a test, and the branch it guards is the one that decides whether a mistyped
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
