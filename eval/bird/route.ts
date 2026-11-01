/**
 * Can a router read the question and pick the better card?
 *
 * `bench:bird:adapt` priced the choice *between deployments* and found it cannot move: the arms
 * it chooses among differ by 1.21pp, and separating them needs 5,040 questions. Its third column
 * pointed somewhere else — a per-question oracle sat 6.1-6.6pp above the best fixed strategy at
 * every window — and that column is what this file prices next.
 *
 * The reading is deliberately narrow. A router that spends more calls is not a routing claim, it
 * is a purchase, so the headroom is measured **among the arms that cost the same call**: `names`,
 * `inline+evidence` and `metadata+evidence` all send one request, and on the dev split the best of
 * them earns 61.16% while the per-question oracle earns 67.62%. Those 6.46pp are the entire prize.
 * Whether they are reachable is a question about *predictability*, not about implementation, and
 * it has an arithmetic answer that can be read off an existing artifact without spending a call:
 *
 * 1. **The disagreement is symmetric.** `inline+evidence` and `metadata+evidence` differ on 131 of
 *    1,532 questions — 65 one way, 66 the other. Two cards that carry the same information,
 *    flipping the answer equally often in both directions, is what noise looks like; a signing
 *    test says how often that symmetry occurs by chance.
 * 2. **No single feature separates them.** The router family here is the honest small one: one
 *    feature, one threshold, two arms. Every (feature, threshold) pair is tried, and the number
 *    reported is what the best of them earns on questions it was not fitted on, grouped by
 *    database so that a rule cannot memorise a corpus's corners.
 *
 * Both readings are upper bounds in the direction that matters: if the in-sample optimum of this
 * family cannot reach the criterion, no member of the family can, and the family is the one a
 * prompt-side router would be built from.
 *
 * The harness spends no model call. It joins an artifact the runner already produced against the
 * questions file and the table manifest, which is why it can be re-run on any future artifact for
 * free — the same property that made `adapt.ts` cheap to falsify.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BirdQuestion, BirdTable } from './data.js';
import { loadQuestions, loadTables } from './data.js';

/** One case, with the pass/fail of every arm that ran it. */
export interface Labelled {
  readonly id: string;
  readonly db: string;
  readonly difficulty: string;
  readonly question: string;
  readonly evidence: string;
  readonly passed: ReadonlyMap<string, boolean>;
  /** Why the arm under study failed, when the judge said. */
  readonly reasons: ReadonlyMap<string, string>;
}

/** The artifact fields this harness reads. Anything else is ignored, so older artifacts still join. */
export interface ArtifactShape {
  readonly cases?: readonly {
    readonly id?: unknown;
    readonly arm?: unknown;
    readonly passed?: unknown;
    readonly reason?: unknown;
  }[];
  readonly arms?: readonly { readonly arm?: unknown; readonly passed?: unknown; readonly total?: unknown }[];
  readonly split?: unknown;
  readonly model?: unknown;
}

const armName = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

/**
 * Join an artifact against the corpus, keeping only cases the corpus can describe.
 *
 * Cases whose question is missing are dropped rather than defaulted: a router fitted on a case
 * with no question text would be fitted on the empty string, and every feature would read zero —
 * a silent bias toward whichever arm wins on empty input.
 */
export function align(
  artifact: ArtifactShape,
  questions: readonly BirdQuestion[],
  tables: ReadonlyMap<string, BirdTable>,
): Labelled[] {
  const byId = new Map<number, BirdQuestion>();
  for (const one of questions) byId.set(one.question_id, one);
  const rows = new Map<string, { passed: Map<string, boolean>; reasons: Map<string, string> }>();
  for (const row of artifact.cases ?? []) {
    const arm = armName(row.arm);
    if (arm === undefined) continue;
    const id = String(row.id);
    const held = rows.get(id) ?? { passed: new Map<string, boolean>(), reasons: new Map<string, string>() };
    held.passed.set(arm, row.passed === true);
    if (typeof row.reason === 'string') held.reasons.set(arm, row.reason);
    rows.set(id, held);
  }
  const out: Labelled[] = [];
  for (const [id, held] of rows) {
    const question = byId.get(Number(id));
    if (question === undefined) continue;
    // The manifest is read here rather than in a feature, so a case whose database has no
    // manifest is still routable on its question: losing it would silently drop a stratum.
    void tables;
    out.push({
      id,
      db: question.db_id,
      difficulty: question.difficulty,
      question: question.question,
      evidence: question.evidence ?? '',
      passed: held.passed,
      reasons: held.reasons,
    });
  }
  out.sort((left, right) => Number(left.id) - Number(right.id));
  return out;
}

/**
 * The features a router may read.
 *
 * Every one is computed from the question, its evidence note and the schema's *size* — never from
 * the gold statement, the database contents, or the arm's own answer. A feature that needs any of
 * those is not available at the moment the router decides, and a feature that is not available is
 * not a router, it is a post-hoc explanation.
 */
const AGGREGATE = /\b(count|sum|avg|average|max|min|total|number of|how many|distinct)\b/;
const SUPERLATIVE = /\b(highest|lowest|most|least|largest|smallest|top|bottom|best|worst|greatest|maximum|minimum)\b/;
const COMPARISON = /\b(between|at least|at most|more than|less than|greater than|fewer|exceed|above|below)\b|[<>]/;
const WINDOW = /\b(rank|ranking|dense_rank|row_number|running|cumulative|previous|next|lag|lead)\b/;
const RATIO = /\b(ratio|fraction|proportion|share|percent|percentage|rate)\b/;
const GROUPING = /\b(per|each|among|across|respectively|for every)\b/;

export interface Feature {
  readonly name: string;
  readonly value: number;
}

/**
 * The vector, in a fixed order so two runs can be diffed field by field.
 *
 * `identifierHits` is the only feature that reads the schema's *content*: the number of distinct
 * question words that also name a column. It is the cheapest available proxy for "the card
 * already speaks this question's vocabulary", which is the one thing the two evidence cards differ
 * in from the model's point of view.
 */
export function features(one: Labelled, tables?: ReadonlyMap<string, BirdTable>): Feature[] {
  const text = one.question;
  // The corpus is JSON, and JSON is not typed: `align` normalises a missing note, but this
  // function is exported, and a caller that builds its own case should get zeros rather than a
  // TypeError from the middle of a feature vector.
  const evidence = one.evidence ?? '';
  const lower = text.toLowerCase();
  const words = text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const distinct = new Set(words.map((word) => word.toLowerCase()));
  const table = tables?.get(one.db);
  const columns = new Set<string>();
  for (const entry of table?.columnNames ?? []) {
    const name = entry[1];
    if (typeof name === 'string') columns.add(name.toLowerCase());
  }
  let hits = 0;
  for (const word of distinct) if (columns.has(word)) hits += 1;
  return [
    { name: 'chars', value: text.length },
    { name: 'words', value: words.length },
    { name: 'evidenceChars', value: evidence.length },
    { name: 'evidenceSpans', value: (evidence.match(/`/g) ?? []).length / 2 },
    { name: 'evidenceEmpty', value: evidence.trim().length === 0 ? 1 : 0 },
    { name: 'numbers', value: (text.match(/\d+(?:\.\d+)?/g) ?? []).length },
    { name: 'quoted', value: (text.match(/["']/g) ?? []).length / 2 },
    { name: 'aggregate', value: AGGREGATE.test(lower) ? 1 : 0 },
    { name: 'superlative', value: SUPERLATIVE.test(lower) ? 1 : 0 },
    { name: 'comparison', value: COMPARISON.test(lower) ? 1 : 0 },
    { name: 'window', value: WINDOW.test(lower) ? 1 : 0 },
    { name: 'ratio', value: RATIO.test(lower) ? 1 : 0 },
    { name: 'grouping', value: GROUPING.test(lower) ? 1 : 0 },
    { name: 'howMany', value: /\bhow many\b/.test(lower) ? 1 : 0 },
    { name: 'whichStart', value: /^which\b/.test(lower) ? 1 : 0 },
    { name: 'schemaTables', value: table?.tableNames.length ?? 0 },
    { name: 'schemaColumns', value: columns.size },
    { name: 'identifierHits', value: hits },
    { name: 'identifierShare', value: words.length === 0 ? 0 : hits / distinct.size },
  ];
}

/** How two arms divide the corpus: the four cells a paired comparison is made of. */
export interface Split {
  readonly n: number;
  readonly both: number;
  readonly leftOnly: number;
  readonly rightOnly: number;
  readonly neither: number;
  readonly left: number;
  readonly right: number;
}

export function split(ones: readonly Labelled[], left: string, right: string): Split {
  let both = 0;
  let leftOnly = 0;
  let rightOnly = 0;
  let neither = 0;
  for (const one of ones) {
    const leftPassed = one.passed.get(left) === true;
    const rightPassed = one.passed.get(right) === true;
    if (leftPassed && rightPassed) both += 1;
    else if (leftPassed) leftOnly += 1;
    else if (rightPassed) rightOnly += 1;
    else neither += 1;
  }
  return { n: ones.length, both, leftOnly, rightOnly, neither, left: both + leftOnly, right: both + rightOnly };
}

/** The best a fixed arm could do, and the best a per-case chooser could do. */
export function bounds(ones: readonly Labelled[], arms: readonly string[]): { best: string; bestAccuracy: number; oracle: number } {
  let best = arms[0] ?? '';
  // Starts at zero rather than at minus one: an arm list that is empty has no best arm, and
  // reporting -1 would let a caller print "-100%" for a bank nobody measured.
  let bestAccuracy = 0;
  for (const arm of arms) {
    const passed = ones.filter((one) => one.passed.get(arm) === true).length;
    const accuracy = ones.length === 0 ? 0 : passed / ones.length;
    if (accuracy > bestAccuracy) {
      bestAccuracy = accuracy;
      best = arm;
    }
  }
  const any = ones.filter((one) => arms.some((arm) => one.passed.get(arm) === true)).length;
  return { best, bestAccuracy, oracle: ones.length === 0 ? 0 : any / ones.length };
}

/**
 * What is left when every arm in the family fails, by the judge's own bucket.
 *
 * This is the reading that decides whether routing is the right lever at all. A router can only
 * recover a case on which *some* arm passed; a case that every arm failed is a case where the
 * choice was never the problem, and the bucket names what was. `values` means the statement ran
 * with the right width and the wrong number — a filter that matched nothing, an aggregation at the
 * wrong grain, a literal the data does not contain. `column-count` means the projection was wrong.
 *
 * Reported over the union of failures rather than per arm, because the union is what a router
 * would have to move.
 */
export interface Mix {
  readonly failed: number;
  readonly byReason: readonly { readonly reason: string; readonly count: number }[];
}

/** Every arm the artifact ran, in first-seen order, so the census is over the whole table. */
export function armsOf(ones: readonly Labelled[]): string[] {
  const seen = new Set<string>();
  for (const one of ones) for (const arm of one.passed.keys()) seen.add(arm);
  return [...seen];
}

export function mix(ones: readonly Labelled[], arms: readonly string[]): Mix {
  let failed = 0;
  const counts = new Map<string, number>();
  for (const one of ones) {
    if (arms.some((arm) => one.passed.get(arm) === true)) continue;
    failed += 1;
    // A case carries one reason per arm, and they do not always agree, so the census takes the
    // first arm that filed one: counting (case, arm) pairs instead would make the shares add up
    // to more than 100% of the cases that failed.
    const reason = arms.map((arm) => one.reasons.get(arm)).find((value) => value !== undefined) ?? 'unfiled';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const byReason = [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
  return { failed, byReason };
}

/**
 * Exact two-sided binomial probability of a split at least this lopsided.
 *
 * Used for the one claim a paired table cannot make on its own: 65 against 66 is not "a small
 * difference", it is the difference a fair coin produces. Computed in log space so that a corpus
 * of any size stays inside a double.
 */
export function signTest(left: number, right: number): number {
  const n = left + right;
  if (n === 0) return 1;
  const logFactorial = (value: number): number => {
    let total = 0;
    for (let index = 2; index <= value; index += 1) total += Math.log(index);
    return total;
  };
  const logChoose = (size: number, picks: number): number =>
    logFactorial(size) - logFactorial(picks) - logFactorial(size - picks);
  const tail = Math.min(left, right);
  let probability = 0;
  for (let index = 0; index <= tail; index += 1) probability += Math.exp(logChoose(n, index) - n * Math.LN2);
  return Math.min(1, 2 * probability);
}

/**
 * A one-feature, one-threshold rule.
 *
 * `above` and `below` are named rather than positional because both orientations are part of the
 * family: "long questions suit the inline card" and "long questions suit the metadata card" are
 * equally natural rules, and fitting only one of them would make the harness's negative reading
 * stronger than its evidence. The first version of this file did fit only one, and its positive
 * control — a bank where the length really does decide — scored 50%.
 */
export interface Stump {
  readonly feature: string;
  readonly threshold: number;
  readonly above: string;
  readonly below: string;
}

function passes(one: Labelled, arm: string): boolean {
  return one.passed.get(arm) === true;
}

/**
 * The best stump on the cases it is given, measured by the accuracy it earns on those cases.
 *
 * Ties break toward the larger threshold, and then toward the alphabetically earlier feature, so
 * that two runs of the harness on the same artifact produce the same rule. That determinism is not
 * cosmetic: without it a reader could not tell a changed reading from a changed tie-break.
 */
export function fitStump(
  ones: readonly Labelled[],
  left: string,
  right: string,
  tables?: ReadonlyMap<string, BirdTable>,
): Stump {
  const vectors = ones.map((one) => features(one, tables));
  const names = (vectors[0] ?? []).map((feature) => feature.name);
  let best: Stump = { feature: names[0] ?? '', threshold: 0, above: left, below: right };
  let bestScore = -1;
  for (const name of names) {
    const values = vectors.map((vector) => vector.find((feature) => feature.name === name)?.value ?? 0);
    const cuts = [...new Set(values)].sort((a, b) => a - b);
    for (const cut of cuts) {
      for (const [above, below] of [
        [left, right],
        [right, left],
      ] as const) {
        let score = 0;
        for (let index = 0; index < ones.length; index += 1) {
          const arm = (values[index] ?? 0) >= cut ? above : below;
          if (passes(ones[index]!, arm)) score += 1;
        }
        if (score >= bestScore) {
          bestScore = score;
          best = { feature: name, threshold: cut, above, below };
        }
      }
    }
  }
  return best;
}

/** What a fitted stump earns on cases it never saw. */
export function scoreStump(
  ones: readonly Labelled[],
  rule: Stump,
  tables?: ReadonlyMap<string, BirdTable>,
): number {
  let score = 0;
  for (const one of ones) {
    const value = features(one, tables).find((feature) => feature.name === rule.feature)?.value ?? 0;
    const arm = value >= rule.threshold ? rule.above : rule.below;
    if (passes(one, arm)) score += 1;
  }
  return score;
}

/** A database, and the cases that live in it. */
export interface Group {
  readonly name: string;
  readonly ones: readonly Labelled[];
}

/**
 * Group by database, because a split is ordered by database and a random fold is not.
 *
 * BIRD's dev split holds 11 databases with visibly different difficulty — `superhero` sits at 82.9%
 * and `debit_card_specializing` at 45.3% on the same arm. A router fitted on a random 90% of cases
 * and tested on the rest has seen cases from the test case's own database, its own idioms and its
 * own column vocabulary, so it can score by recognising the corpus rather than by reading the
 * question. Leaving a whole database out is the harsher test, and it is the one that corresponds to
 * "a question from a database you have not seen".
 */
export function groupByDatabase(ones: readonly Labelled[]): Group[] {
  const groups = new Map<string, Labelled[]>();
  for (const one of ones) {
    const held = groups.get(one.db) ?? [];
    held.push(one);
    groups.set(one.db, held);
  }
  return [...groups.entries()].map(([name, held]) => ({ name, ones: held })).sort((a, b) => a.name.localeCompare(b.name));
}

/** What the leave-one-database-out loop earned, and on how many cases. */
export interface CrossValued {
  readonly score: number;
  readonly total: number;
  readonly folds: readonly { readonly name: string; readonly n: number; readonly rule: Stump }[];
}

export function leaveOneOut(
  ones: readonly Labelled[],
  left: string,
  right: string,
  tables?: ReadonlyMap<string, BirdTable>,
): CrossValued {
  const groups = groupByDatabase(ones);
  let score = 0;
  let total = 0;
  const folds: { name: string; n: number; rule: Stump }[] = [];
  for (const held of groups) {
    const train = groups.filter((group) => group.name !== held.name).flatMap((group) => [...group.ones]);
    // One database in the corpus means there is nothing to learn from, and a rule fitted on the
    // empty set would report a reading that no fold could reproduce.
    if (train.length === 0) continue;
    const rule = fitStump(train, left, right, tables);
    score += scoreStump(held.ones, rule, tables);
    total += held.ones.length;
    folds.push({ name: held.name, n: held.ones.length, rule });
  }
  return { score, total, folds };
}

export interface RouteSettings {
  readonly artifact: string;
  readonly questions: string;
  readonly tables: string | undefined;
  readonly pair: readonly [string, string];
  readonly json: boolean;
}

export const DEFAULT_PAIR: readonly [string, string] = ['metadata+evidence', 'inline+evidence'];

/**
 * The criterion, stated before the run so that the reading cannot pick it.
 *
 * A router earns its place only if it recovers at least a point of the headroom on questions from
 * a database it never saw. Below that the honest product is the fixed arm, and the headroom is
 * recorded as a ceiling rather than as an opportunity.
 */
export const REQUIRED_GAIN = 0.01;

export function resolveRouteSettings(argv: readonly string[], root: string): RouteSettings {
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const artifact = flag('--artifact');
  if (artifact === undefined) throw new Error('--artifact is required: this harness reads an artifact rather than producing one');
  const split = flag('--questions') ?? join(root, 'eval/.cache/bird/dev/dev_20240627/dev.json');
  const tables = flag('--tables') ?? join(root, 'eval/.cache/bird/dev/dev_20240627/dev_tables.json');
  const pair = (flag('--pair') ?? DEFAULT_PAIR.join(',')).split(',');
  if (pair.length !== 2) throw new Error('--pair takes two arm names, for example metadata+evidence,inline+evidence');
  return { artifact, questions: split, tables, pair: [pair[0]!, pair[1]!], json: argv.includes('--json') };
}

/** Every line the report prints, in the order a reader needs them. */
export function reportLines(
  ones: readonly Labelled[],
  settings: RouteSettings,
  tables: ReadonlyMap<string, BirdTable> | undefined,
  artifact: ArtifactShape,
): string[] {
  const [left, right] = settings.pair;
  const cells = split(ones, left, right);
  const { best, bestAccuracy, oracle } = bounds(ones, [left, right]);
  const accuracy = (value: number): string => `${(value * 100).toFixed(2)}%`;
  const rule = fitStump(ones, left, right, tables);
  const inSample = scoreStump(ones, rule, tables) / Math.max(1, ones.length);
  const held = leaveOneOut(ones, left, right, tables);
  const heldAccuracy = held.total === 0 ? 0 : held.score / held.total;
  const tuned = Math.max(cells.left, cells.right) / Math.max(1, cells.n);
  const gain = heldAccuracy - tuned;
  const headroom = oracle - bestAccuracy;
  const lines = [
    `routing between ${left} and ${right} on ${String(ones.length)} cases (${String(artifact.split ?? 'unknown')}, ${String(artifact.model ?? 'unknown')})`,
    `schema features: ${tables === undefined ? 'off, no manifest — schemaColumns, schemaTables and identifierHits read zero' : 'on'}`,
    '',
    `  ${left.padEnd(20)} ${accuracy(cells.left / Math.max(1, cells.n))}  (${String(cells.left)}/${String(cells.n)})`,
    `  ${right.padEnd(20)} ${accuracy(cells.right / Math.max(1, cells.n))}  (${String(cells.right)}/${String(cells.n)})`,
    `  agreement on ${String(cells.both + cells.neither)} of ${String(cells.n)}; the cards disagree ${String(cells.leftOnly)} : ${String(cells.rightOnly)}`,
    `  sign test on that split: p = ${signTest(cells.leftOnly, cells.rightOnly).toFixed(4)}`,
    '',
    `  best fixed arm        ${best.padEnd(20)} ${accuracy(bestAccuracy)}`,
    `  per-question oracle   ${''.padEnd(20)} ${accuracy(oracle)}  headroom ${(headroom * 100).toFixed(2)}pp`,
    '',
    `  best stump, in sample ${rule.feature} >= ${String(rule.threshold)} -> ${rule.above}, otherwise ${rule.below}  ${accuracy(inSample)}`,
    `  best stump, held out  ${''.padEnd(20)} ${accuracy(heldAccuracy)}  gain over the fixed arm ${(gain * 100).toFixed(2)}pp`,
  ];
  for (const fold of held.folds) {
    lines.push(
      `    ${fold.name.padEnd(24)} n=${String(fold.n).padStart(4)}  ${fold.rule.feature} >= ${String(fold.rule.threshold)} -> ${fold.rule.above}`,
    );
  }
  const every = armsOf(ones);
  const union = mix(ones, every);
  lines.push('');
  lines.push(`  all ${String(every.length)} arms failed on ${String(union.failed)} cases, and the judge filed them as:`);
  for (const bucket of union.byReason) {
    const share = union.failed === 0 ? 0 : (bucket.count / union.failed) * 100;
    lines.push(`    ${bucket.reason.padEnd(24)} ${String(bucket.count).padStart(4)}  ${share.toFixed(1)}%`);
  }
  lines.push('');
  lines.push(
    gain >= REQUIRED_GAIN
      ? `verdict: a router clears the ${(REQUIRED_GAIN * 100).toFixed(0)}pp criterion out of fold; the headroom is at least partly readable`
      : `verdict: no router from this family clears ${(REQUIRED_GAIN * 100).toFixed(0)}pp out of fold; the ${(headroom * 100).toFixed(2)}pp headroom is a ceiling, not an opportunity`,
  );
  return lines;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function main(argv: readonly string[], root: string, log: (line: string) => void = console.log): number {
  const settings = resolveRouteSettings(argv, root);
  const artifact = readJson<ArtifactShape>(settings.artifact);
  const questions = loadQuestions(settings.questions);
  // A manifest that is not there is a corpus without one, not a run to abort: every other feature
  // still reads the question, and the header states which condition the reading was taken under.
  // A manifest that is there and malformed still throws, because that is a different sentence.
  const tables = settings.tables !== undefined && existsSync(settings.tables) ? loadTables(settings.tables) : undefined;
  const ones = align(artifact, questions, tables ?? new Map());
  if (ones.length === 0) throw new Error('the artifact and the question file share no case, so there is nothing to route');
  const lines = reportLines(ones, settings, tables, artifact);
  if (settings.json) {
    const [left, right] = settings.pair;
    const cells = split(ones, left, right);
    log(JSON.stringify({ cases: ones.length, pair: [left, right], cells, lines }, null, 2));
  } else {
    for (const line of lines) log(line);
  }
  return 0;
}

/**
 * Run as a script when — and only when — this file is the entry point.
 *
 * Split out from the module tail so the two branches can be exercised: an entry check written
 * inline is unreachable from a test, and the error path it guards is the one that decides whether a
 * mistyped flag prints a sentence or a stack trace. Returns the exit code, or `undefined` when this
 * module was imported rather than run.
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
