/**
 * Can the question decide, before a call, whether the candidate set is worth buying?
 *
 * `bench:bird:gap` puts every arm's score on one line: 168 of 600 cases have no answer in the
 * candidate set at all, and the other 42 held one the selector did not take. Two different
 * failures with two different prices — the first is a purchase (another generation, another
 * source, a retrieval), the second is a judgment — and the purchase is only worth making where
 * it is needed. That makes this a routing question of exactly the shape `bench:bird:route`
 * answers for cards: **is the stratum readable from the question?**
 *
 * The honest answer has to be cheap, because the alternative is already known: buying a fourth
 * call on every case costs a quarter more and moves nothing (measured on `44917562527`: the
 * diversity line bought 3.6pp of ceiling and lost 2.8pp of answer). So the family below is the
 * smallest one that could work — one feature, one threshold, and a leave-one-database-out split,
 * because BIRD's eleven databases are visibly different and a router fitted on nine of them can
 * score by recognising the tenth's idioms rather than by reading the question.
 *
 * Two rules this file inherits from the round that made routing measurable:
 *
 * 1. **The features are available at decision time.** Question text, its evidence note, and the
 *    words it shares with the schema — never the gold statement, never the answer. A feature that
 *    needs one of those is a post-hoc explanation wearing a router's name.
 * 2. **The reading comes from the artifact alone.** `asked` is written per case by the runner, so
 *    this tool joins nothing, reads no corpus file and spends no call: any future artifact with
 *    `asked` and `candidateRecall` can be re-priced for free. That is also the check on the field
 *    itself — a router analysis whose inputs are not in the record is a router analysis that
 *    cannot be re-run.
 *
 * The criterion is stated here, before the run, so the reading cannot choose it:
 * the best single feature must reach **AUC >= 0.70** and beat the majority-class baseline by at
 * least **3pp out of fold**, while asking for no more than **80%** of the corpus — a router that
 * buys everywhere has not routed anything.
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { features, type Feature, type Labelled } from './route.js';

/** One case as the artifact recorded it, with the outcome the router would try to predict. */
export interface RouteCase {
  readonly id: string;
  readonly db: string;
  readonly difficulty: string;
  readonly question: string;
  readonly evidence: string;
  /** Whether the candidate set held a correct statement — the thing a purchase would change. */
  readonly recall: boolean;
  /** True when the runner capped the question text, which shortens every length feature. */
  readonly truncated: boolean;
}

/** The artifact fields this harness reads. Anything else is ignored. */
export interface ArtifactShape {
  readonly split?: unknown;
  readonly model?: unknown;
  readonly cases?: readonly {
    readonly arm?: unknown;
    readonly id?: unknown;
    readonly passed?: unknown;
    readonly candidateRecall?: unknown;
    readonly asked?: unknown;
  }[];
}

/**
 * Read the cases one arm answered, from the artifact and nothing else.
 *
 * A case without `asked` is dropped rather than defaulted, and the count is reported: a router
 * fitted on an empty question would read every feature as zero and learn the majority class,
 * which looks like a null result and is actually a join that failed.
 *
 * `candidateRecall` is the label when it is present. When it is absent the arm did not draw
 * candidates, so the question "did the pool hold an answer" has no answer and the case is dropped;
 * falling back to `passed` would silently redefine the label as "the arm got it right", which is
 * the quantity this tool is trying to see past.
 */
export function casesFromArtifact(artifact: ArtifactShape, arm: string): { cases: RouteCase[]; missingAsked: number; missingRecall: number } {
  let missingAsked = 0;
  let missingRecall = 0;
  const seen = new Set<string>();
  const cases: RouteCase[] = [];
  for (const row of artifact.cases ?? []) {
    if (row.arm !== arm) continue;
    const id = String(row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const asked = row.asked as
      | { db?: unknown; difficulty?: unknown; question?: unknown; evidence?: unknown; truncated?: unknown }
      | undefined;
    if (asked === undefined || typeof asked.question !== 'string' || typeof asked.db !== 'string') {
      missingAsked += 1;
      continue;
    }
    if (typeof row.candidateRecall !== 'boolean') {
      missingRecall += 1;
      continue;
    }
    cases.push({
      id,
      db: asked.db,
      difficulty: typeof asked.difficulty === 'string' ? asked.difficulty : 'unknown',
      question: asked.question,
      evidence: typeof asked.evidence === 'string' ? asked.evidence : '',
      recall: row.candidateRecall,
      truncated: asked.truncated === true,
    });
  }
  cases.sort((left, right) => {
    // Corpus ids are integers, but an artifact can be joined to a fixture whose ids are labels. A
    // `Number()` comparison would put every such case at NaN and leave the order to the sort's
    // implementation, which is how a reading becomes un-reproducible without anyone noticing.
    const leftNumber = Number(left.id);
    const rightNumber = Number(right.id);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
    return left.id.localeCompare(right.id);
  });
  return { cases, missingAsked, missingRecall };
}

/** The vector `route.ts` already defines, so the two routers cannot drift apart feature by feature. */
export function vectorOf(one: RouteCase): Feature[] {
  const labelled: Labelled = {
    id: one.id,
    db: one.db,
    difficulty: one.difficulty,
    question: one.question,
    evidence: one.evidence,
    passed: new Map(),
    reasons: new Map(),
  };
  return features(labelled);
}

/**
 * One feature's value, and a refusal when the name is not one this vector has.
 *
 * The three readers below all need it, and all three used to write `?.value ?? 0`: a feature that
 * silently read zero is a comparison against a constant, which is the shape of a null result that
 * nobody can tell from a bug.
 */
export function valueOf(one: RouteCase, feature: string): number {
  const found = vectorOf(one).find((entry) => entry.name === feature);
  if (found === undefined) throw new Error(`no feature named ${feature}`);
  return found.value;
}

/**
 * How well one feature separates "no answer in the pool" from "an answer in the pool".
 *
 * Written as the probability that a randomly chosen unanswered case scores above a randomly
 * chosen answered one, with ties counted half — the Mann-Whitney reading, and the only one that
 * needs no threshold. It is what makes this a measurement rather than a fit: a threshold can be
 * tuned until a corpus looks readable, an AUC on the same corpus cannot be moved by tuning.
 */
export function auc(ones: readonly RouteCase[], feature: string): number {
  const positives: number[] = [];
  const negatives: number[] = [];
  for (const one of ones) {
    (one.recall ? negatives : positives).push(valueOf(one, feature));
  }
  if (positives.length === 0 || negatives.length === 0) return 0.5;
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive > negative) wins += 1;
      else if (positive === negative) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}

/** One threshold, one direction: the whole family a single feature can express. */
export interface Threshold {
  readonly feature: string;
  readonly at: number;
  /** True when a value at or above the threshold predicts "no answer in the pool". */
  readonly above: boolean;
  readonly accuracy: number;
}

/**
 * The best threshold on the cases it is shown, and only those.
 *
 * Candidate cuts are the midpoints between distinct values plus one beyond each end, because a
 * cut at a value would make the comparison depend on floating-point equality between a feature and
 * itself. Ties go to the smaller threshold and then to `above`, so the same input always produces
 * the same rule — a fit that depends on iteration order cannot be re-run.
 */
export function fitThreshold(ones: readonly RouteCase[], feature: string): Threshold {
  // An empty set has no threshold, and the arithmetic below would happily produce one: `values[0]`
  // is undefined, `undefined - 1` is NaN, and every comparison against NaN is false, so the fit
  // would return `at: NaN, accuracy: 0` — a rule that looks fitted and cannot be applied.
  if (ones.length === 0) throw new Error(`no threshold can be fitted for ${feature} on an empty set`);
  const scored = ones.map((one) => ({ value: valueOf(one, feature), positive: !one.recall }));
  const values = [...new Set(scored.map((entry) => entry.value))].sort((left, right) => left - right);
  const cuts = [values[0]! - 1, ...values.slice(1).map((value, index) => (value + values[index]!) / 2)];
  // `cuts` is never empty (the set it was built from has at least one value), so the loop always
  // assigns a first candidate and the search can start from it rather than from `undefined`.
  let best: Threshold | undefined;
  for (const at of cuts) {
    for (const above of [true, false]) {
      let right = 0;
      for (const entry of scored) {
        const predicted = above ? entry.value >= at : entry.value < at;
        if (predicted === entry.positive) right += 1;
      }
      const accuracy = right / scored.length;
      if (best === undefined || accuracy > best.accuracy) best = { feature, at, above, accuracy };
    }
  }
  return best as Threshold;
}

/**
 * What a fitted threshold earns on a set it was not fitted on.
 *
 * `aimed` is the number of cases the rule would spend a fourth call on — the cases it calls empty.
 * Naming the count after the purchase rather than after the prediction is what keeps the two
 * readings apart: the first version called it `skipped` and inverted it at the report, so a rule
 * that would buy 3.7% of the corpus was printed as buying 96.3% of it.
 */
export function scoreThreshold(ones: readonly RouteCase[], rule: Threshold): { right: number; total: number; aimed: number } {
  let right = 0;
  let aimed = 0;
  for (const one of ones) {
    const value = valueOf(one, rule.feature);
    const predicted = rule.above ? value >= rule.at : value < rule.at;
    if (predicted === !one.recall) right += 1;
    if (predicted) aimed += 1;
  }
  return { right, total: ones.length, aimed };
}

/**
 * Fit on every database but one, score on the one held out.
 *
 * Leave-one-database-out rather than a random fold, for the reason `route.ts` states: a case from
 * a database the router has seen is a case whose column vocabulary it has memorised. This is the
 * harsher split and the one that corresponds to a new question arriving.
 */
export function leaveOneDatabaseOut(
  ones: readonly RouteCase[],
  feature: string,
): { accuracy: number; total: number; baseline: number; aimed: number; folds: readonly { name: string; n: number; rule: Threshold }[] } {
  const groups = new Map<string, RouteCase[]>();
  for (const one of ones) {
    const held = groups.get(one.db) ?? [];
    held.push(one);
    groups.set(one.db, held);
  }
  let right = 0;
  let total = 0;
  let majority = 0;
  let aimed = 0;
  const folds: { name: string; n: number; rule: Threshold }[] = [];
  for (const [name, held] of [...groups.entries()].sort((left, right_) => left[0].localeCompare(right_[0]))) {
    const train = ones.filter((one) => one.db !== name);
    // One database in the corpus is nothing to learn from, and a rule fitted on the empty set would
    // report a reading no fold could reproduce.
    if (train.length === 0) continue;
    const rule = fitThreshold(train, feature);
    const scored = scoreThreshold(held, rule);
    right += scored.right;
    total += scored.total;
    aimed += scored.aimed;
    // The baseline is the majority class *of the held-out fold*, which is what a router that
    // learned nothing would earn on it: "buy everywhere" on a corpus of 28% gaps is 72%.
    const gaps = held.filter((one) => !one.recall).length;
    majority += Math.max(gaps, held.length - gaps);
    folds.push({ name, n: held.length, rule });
  }
  return {
    accuracy: total === 0 ? 0 : right / total,
    total,
    baseline: total === 0 ? 0 : majority / total,
    aimed,
    folds,
  };
}

/**
 * The criterion, stated before the run so the reading cannot pick it.
 *
 * `REQUIRED_AUC` is the weakest separation worth wiring: below 0.70 the feature is closer to a
 * coin than to a decision, and the round that tried to route cards on seven pool features found
 * its best at 0.646 — a number this file must be able to reproduce as a null rather than explain.
 * `REQUIRED_GAIN` is what a purchase has to earn out of fold; `REQUIRED_BUY` caps how much of the
 * corpus the router may spend on, because a rule that buys everywhere has routed nothing.
 */
export const REQUIRED_AUC = 0.7;
export const REQUIRED_GAIN = 0.03;
export const REQUIRED_BUY = 0.8;

export interface CoverageRouteSettings {
  readonly artifact: string;
  readonly arm: string;
  readonly json: boolean;
}

export function resolveSettings(argv: readonly string[], root = process.cwd()): CoverageRouteSettings {
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  // A flag's value is not a positional argument. The first version of this line read
  // `--arm select-cross` as an artifact path called `select-cross`, and the error it produced
  // named a file rather than the missing flag.
  const consumed = new Set<number>();
  for (const name of ['--artifact', '--arm']) {
    const at = argv.indexOf(name);
    if (at !== -1) consumed.add(at + 1);
  }
  const raw = flag('--artifact') ?? argv.find((item, index) => !item.startsWith('--') && !consumed.has(index));
  if (raw === undefined) throw new Error('--artifact is required: this harness reads an artifact rather than producing one');
  // Relative to the root the caller named, not to the process's working directory: a workflow step
  // and a local run start in different directories, and the artifact a reading is about must not
  // depend on which one it was.
  const artifact = resolvePath(root, raw);
  const arm = flag('--arm');
  if (arm === undefined) throw new Error('--arm is required: the label is "did this arm\'s pool hold an answer"');
  return { artifact, arm, json: argv.includes('--json') };
}

/** Every line the report prints, in the order a reader needs them. */
export function reportLines(
  ones: readonly RouteCase[],
  artifact: ArtifactShape,
  settings: CoverageRouteSettings,
  dropped: { missingAsked: number; missingRecall: number },
): string[] {
  const gaps = ones.filter((one) => !one.recall).length;
  const baseRate = ones.length === 0 ? 0 : gaps / ones.length;
  const truncated = ones.filter((one) => one.truncated).length;
  const names = [...new Set(ones.flatMap((one) => vectorOf(one).map((entry) => entry.name)))];
  const ranked = names
    .map((name) => ({ name, auc: auc(ones, name) }))
    .sort((left, right) => Math.abs(right.auc - 0.5) - Math.abs(left.auc - 0.5));
  const lines = [
    `routing "no answer in the pool" for ${settings.arm} on ${String(ones.length)} cases ` +
      `(${String(artifact.split ?? 'unknown')}, ${String(artifact.model ?? 'unknown')})`,
    `  no answer in the pool: ${String(gaps)} (${(baseRate * 100).toFixed(1)}%) — the class a router has to find`,
    `  questions capped by the runner: ${String(truncated)}` +
      (dropped.missingAsked + dropped.missingRecall === 0
        ? ''
        : `; dropped ${String(dropped.missingAsked)} without asked, ${String(dropped.missingRecall)} without candidateRecall`),
    '',
    '  feature              AUC    (0.5 is a coin)',
  ];
  for (const entry of ranked.slice(0, 8)) {
    lines.push(`    ${entry.name.padEnd(18)} ${entry.auc.toFixed(3)}`);
  }
  const best = ranked[0];
  if (best === undefined) {
    lines.push('', 'verdict: no feature could be computed, so there is nothing to route on');
    return lines;
  }
  const rule = fitThreshold(ones, best.name);
  const held = leaveOneDatabaseOut(ones, best.name);
  const gain = held.accuracy - held.baseline;
  const buyShare = held.total === 0 ? 1 : held.aimed / held.total;
  lines.push(
    '',
    `  best feature         ${best.name} (AUC ${best.auc.toFixed(3)})`,
    `  stump, in sample     ${rule.above ? `${best.name} >= ${String(rule.at)}` : `${best.name} < ${String(rule.at)}`} means "the pool is empty"  ` +
      `${(rule.accuracy * 100).toFixed(2)}%`,
  );
  // One database is a corpus with nothing to hold out. Printing "0.00% against 0.00%" for it would
  // read as a fitted rule that scored nothing, which is a different claim — and a worse one — than
  // "this question needs at least two databases to be asked at all".
  if (held.total === 0) {
    lines.push('  stump, held out      not measurable: the corpus holds one database, so no fold can be left out');
    lines.push('', 'verdict: the read is in sample only and cannot be tested out of fold, so nothing can be aimed');
    return lines;
  }
  lines.push(
    `  stump, held out      ${(held.accuracy * 100).toFixed(2)}% against a majority baseline of ${(held.baseline * 100).toFixed(2)}%  ` +
      `gain ${(gain * 100).toFixed(2)}pp`,
    `  the router would buy ${(buyShare * 100).toFixed(1)}% of the corpus, and skip ${((1 - buyShare) * 100).toFixed(1)}%`,
  );
  for (const fold of held.folds) {
    lines.push(
      `    ${fold.name.padEnd(24)} n=${String(fold.n).padStart(4)}  ` +
        `${fold.rule.above ? '>=' : '<'} ${String(fold.rule.at)}`,
    );
  }
  lines.push('');
  const readable = best.auc >= REQUIRED_AUC && gain >= REQUIRED_GAIN && buyShare <= REQUIRED_BUY;
  lines.push(
    readable
      ? `verdict: ${best.name} reads the stratum (AUC ${best.auc.toFixed(3)}) and earns ${(gain * 100).toFixed(2)}pp out of fold, so a purchase can be aimed`
      : `verdict: no feature clears AUC ${String(REQUIRED_AUC)}, ${(REQUIRED_GAIN * 100).toFixed(0)}pp out of fold and a ${(REQUIRED_BUY * 100).toFixed(0)}% buy ceiling at once ` +
        `(best ${best.name} at AUC ${best.auc.toFixed(3)}, gain ${(gain * 100).toFixed(2)}pp, buying ${(buyShare * 100).toFixed(1)}%), so a purchase cannot be aimed`,
  );
  return lines;
}

export function main(argv: readonly string[], root: string, log: (line: string) => void = console.log): number {
  const settings = resolveSettings(argv, root);
  const artifact = JSON.parse(readFileSync(settings.artifact, 'utf8')) as ArtifactShape;
  const { cases, missingAsked, missingRecall } = casesFromArtifact(artifact, settings.arm);
  if (cases.length === 0) {
    throw new Error(`no case in ${settings.artifact} carries both asked and candidateRecall for ${settings.arm}, so there is nothing to route`);
  }
  const lines = reportLines(cases, artifact, settings, { missingAsked, missingRecall });
  if (settings.json) {
    const gaps = cases.filter((one) => !one.recall).length;
    log(JSON.stringify({ cases: cases.length, gaps, arm: settings.arm, lines }, null, 2));
  } else {
    for (const line of lines) log(line);
  }
  return 0;
}

/**
 * Run as a script when — and only when — this file is the entry point.
 *
 * Split out for the reason `route.ts` splits it: an entry check written inline is unreachable from
 * a test, and the error path it guards is what turns a mistyped flag into a sentence.
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
  if (entry === undefined || self !== `file://${entry}`) return undefined;
  try {
    return run(argv, root, log);
  } catch (thrown) {
    error(thrown instanceof Error ? thrown.message : String(thrown));
    return 1;
  }
}

const exit = dispatch(process.argv[1], import.meta.url, process.argv.slice(2), process.cwd());
if (exit !== undefined) process.exitCode = exit;
