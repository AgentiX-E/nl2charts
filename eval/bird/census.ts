/**
 * Which part of a statement is wrong, over the cases that did not match.
 *
 * Every other instrument in this directory starts from an execution. `surplus` and `residue` run
 * the statement and the gold against SQLite; `gap` and `pool` read the judge's verdict; `rewrite`
 * reads the gold to build a ceiling. This one reads only the two strings, which makes it the
 * cheapest reading in the file and the only one that can say *where in the statement* a loss lives
 * without a database.
 *
 * The question it answers is the one the last two rounds closed two families trying to answer by
 * argument: **of the statements that came back wrong, how many differ from the gold in what the
 * query reads, and how many differ only in a literal.** A rewrite edits a literal or a clause on a
 * statement that is otherwise the gold's; a schema link or a join choice changes the relation. The
 * two mechanisms have different ceilings and different prices, and the size of each population is
 * a number, not an impression.
 *
 * ## The parts, and why they are these six
 *
 * `sql-shape.ts` already turns a statement into named parts, and the parts are chosen there by
 * which fix they imply. This module uses them unchanged, so a census and a shape comparison of one
 * case never disagree about what "the tables differ" means:
 *
 * - `tables` — the base tables read, aliases rewritten and sorted. A fix is join selection.
 * - `grain` — the `group by` columns. A fix is the grain hint.
 * - `aggregate` — the aggregate calls, `distinct` folded in. A fix is which function answers.
 * - `window` — `order by` / `limit` / `offset`. A fix is the window a rank question selects.
 * - `projection` — the select list, in order, aliases dropped. A fix is which columns answer.
 * - `filter` — the conditions, compared by `predicateKey` so two spellings of one condition are one
 *   condition. A fix is condition coverage.
 *
 * ## Three readings, because one is not enough
 *
 * A case can differ in several parts at once — a statement that reads the wrong table also selects
 * the wrong columns — so a single census over this population would have to choose between three
 * defensible answers, and picking one silently is how a number becomes an argument:
 *
 * 1. **Union** — how many cases differ in each part, counting a case once per part. The honest
 *    answer to "how many statements get the tables wrong", and useless as a partition: 405 of 522
 *    differ in *some* condition, so almost every part looks like the whole.
 * 2. **Sole** — the cases where exactly one part differs. This is the population a single
 *    mechanism can address *alone*, and it is therefore the only one over which "fix this part"
 *    is a claim that adds up.
 * 3. **Precedence** — one bucket per case by a stated order, `tables > grain > aggregate > window >
 *    projection > filter`. It partitions the population exactly, and the order runs from "a
 *    different relation" to "a different literal", so the last bucket is the population a rewrite
 *    can reach and the first is the population it cannot.
 *
 * The precedence is a claim about explanation, not about importance: a wrong table makes every
 * clause after it suspect, and a wrong literal leaves everything before it intact. Saying so here
 * is what lets `censusProblems` refuse a report whose buckets do not add up to its population.
 *
 * ## What a difference is not
 *
 * **A difference is not a defect.** Two statements can answer one question while reading different
 * tables — a join eliminated by a foreign key, a subquery flattened into a join — and the judge
 * scores both. Nothing here executes, so nothing here can tell those apart from a loss: the tool
 * counts *differences*, and every sentence built on it has to say so. The same applies in the other
 * direction: a statement that differs in nothing this segmentation models still scores zero, and
 * those are counted apart as `unmodelled` rather than folded into a bucket that would claim a cause.
 *
 * The population is also not "the errors". It is the cases the judge did not pass, which includes
 * statements the engine refused if the artifact retained them. That is deliberate: a statement that
 * never ran has no parts to compare, so it is counted as `unretained` when the text is missing and
 * compared like any other when it is present.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveLayout } from './run.js';
import { statementShape } from './sql-shape.js';

/** The parts a statement is compared on, in the order the precedence reading assigns them. */
export const CENSUS_PARTS = ['tables', 'grain', 'aggregate', 'window', 'projection', 'filter'] as const;
export type CensusPart = (typeof CENSUS_PARTS)[number];

/**
 * The two readings that are not a part.
 *
 * `tie` is the statement the engine was given twice — equal after normalisation, so the difference
 * is the engine's tie-breaking and not the model's writing. `unmodelled` is the residue of the
 * segmentation: every part agrees and the text does not, which means the difference is in a
 * construct these six parts do not carry (`distinct`, a `union`, a nested statement's own text).
 * Both are counted rather than dropped, because a bucket that absorbs its exceptions silently is a
 * bucket whose number cannot be checked.
 */
export const CENSUS_RESIDUAL = ['tie', 'unmodelled'] as const;

/** A case the artifact kept no statement for: nothing can be said about its parts. */
export const CENSUS_UNRETAINED = 'unretained';

export const CENSUS_BUCKETS = [...CENSUS_PARTS, ...CENSUS_RESIDUAL] as const;
export type CensusBucket = (typeof CENSUS_BUCKETS)[number] | typeof CENSUS_UNRETAINED;

/** Which of the parts differ between two statements, in precedence order. */
export function differingParts(predicted: string, gold: string): readonly CensusPart[] {
  const mine = statementShape(predicted);
  const theirs = statementShape(gold);
  const differ: Record<CensusPart, boolean> = {
    tables: mine.tables.join('|') !== theirs.tables.join('|'),
    grain: mine.groups.join('|') !== theirs.groups.join('|'),
    aggregate: mine.aggregates.join('|') !== theirs.aggregates.join('|'),
    window: mine.window !== theirs.window,
    projection: mine.projection.join('|') !== theirs.projection.join('|'),
    filter: mine.predicates.join('|') !== theirs.predicates.join('|'),
  };
  return CENSUS_PARTS.filter((part) => differ[part]);
}

/**
 * The one bucket a case lands in.
 *
 * `differing` is what `differingParts` returned and `identicalText` is the normalised equality of
 * the two statements — passed in rather than recomputed so a caller that already normalised the
 * pair does not pay for it twice, and so the tie reading is decided by the same equality the rest
 * of the harness uses.
 */
export function bucketFor(differing: readonly CensusPart[], identicalText: boolean): CensusBucket {
  const first = differing[0];
  if (first !== undefined) return first;
  return identicalText ? 'tie' : 'unmodelled';
}

export type TableDirection = 'missing' | 'extra' | 'both';

/**
 * Whether the prediction reads too few tables, too many, or a different relation entirely.
 *
 * `both` is the case a join rewrite cannot reach: the statement is built on another relation, so
 * adding the table the gold reads would not make it the gold.
 *
 * The table set is read from `statementShape`, the same reader the `tables` part is compared with,
 * and not from `residue`'s `tablesOf`. The two disagree on a CTE and on a self-join by design —
 * one is a comparison of statements and the other a classification of row sources — and a census
 * whose direction was counted by a second reader could report a case that differs in `tables` with
 * no direction at all, which `censusProblems` would then have to accept or refuse on a technicality.
 */
export function tableDirection(predicted: string, gold: string): TableDirection {
  const mine = new Set(statementShape(predicted).tables);
  const theirs = new Set(statementShape(gold).tables);
  const missing = [...theirs].some((table) => !mine.has(table));
  const extra = [...mine].some((table) => !theirs.has(table));
  if (!missing && !extra) {
    throw new Error('a table direction is only defined for two statements whose table sets differ: both read the same tables');
  }
  if (missing && extra) return 'both';
  if (missing) return 'missing';
  return 'extra';
}

/** One case, as the artifact writes it, restricted to what a census reads. */
export interface CensusCase {
  readonly id: string;
  readonly sql?: string;
  readonly gold?: string;
  readonly asked?: { readonly difficulty?: string };
}

export interface CensusInput {
  readonly split: string;
  readonly arm: string;
  readonly total: number;
  readonly passed: number;
  readonly cases: readonly CensusCase[];
  /** Where the numbers came from, so two populations can never be confused for one artifact. */
  readonly source?: CensusSource;
}

/** The artifact a census was taken on. `generatedAt` is what tells two runs of one split apart. */
export interface CensusSource {
  readonly path: string;
  readonly generatedAt?: string;
}

export type CensusTally = Readonly<Record<CensusBucket, number>>;
export type CensusPartTally = Readonly<Record<CensusPart, number>>;

export interface CensusOutcome {
  readonly split: string;
  readonly arm: string;
  readonly total: number;
  readonly passed: number;
  /** The cases the judge did not pass: the population every count below is over. */
  readonly population: number;
  /** One bucket per case, by the stated precedence. Sums to `population`. */
  readonly buckets: CensusTally;
  /** Cases where exactly one part differs. */
  readonly sole: CensusPartTally;
  /** Cases where each part differs, a case counted once per part. */
  readonly union: CensusPartTally;
  /** Direction of travel for the cases whose first differing part is `tables`. */
  readonly direction: Readonly<Record<TableDirection, number>>;
  /** Buckets cross-tabulated against the difficulty the corpus declares. */
  readonly difficulty: Readonly<Record<string, CensusTally>>;
  /** Cases that carried both statements, which is the only population the census can read. */
  readonly compared: number;
  /** The artifact the numbers came from. */
  readonly source: CensusSource;
  readonly problems: readonly string[];
}

const emptyTally = (): Record<CensusBucket, number> => ({
  tables: 0,
  grain: 0,
  aggregate: 0,
  window: 0,
  projection: 0,
  filter: 0,
  tie: 0,
  unmodelled: 0,
  unretained: 0,
});

const emptyParts = (): Record<CensusPart, number> => ({
  tables: 0,
  grain: 0,
  aggregate: 0,
  window: 0,
  projection: 0,
  filter: 0,
});

export function tallyCensus(input: CensusInput): CensusOutcome {
  const buckets = emptyTally();
  const sole = emptyParts();
  const union = emptyParts();
  const direction: Record<TableDirection, number> = { missing: 0, extra: 0, both: 0 };
  const difficulty: Record<string, Record<CensusBucket, number>> = {};
  let compared = 0;

  for (const item of input.cases) {
    // The difficulty row is opened before the retained check, so a case the artifact kept no
    // statement for still counts in the cross-tab. It did not, in the first version: `unretained`
    // left the loop before the row was touched, and the cross-tab then summed to less than the
    // population — which the gate caught, which is the only reason this comment exists.
    const label = item.asked?.difficulty ?? 'unstated';
    const row = (difficulty[label] ??= emptyTally());
    if (item.sql === undefined || item.sql.trim() === '' || item.gold === undefined || item.gold.trim() === '') {
      buckets.unretained += 1;
      row.unretained += 1;
      continue;
    }
    compared += 1;
    const differing = differingParts(item.sql, item.gold);
    const identicalText = differing.length === 0 && statementShape(item.sql).text === statementShape(item.gold).text;
    const bucket = bucketFor(differing, identicalText);
    buckets[bucket] += 1;
    row[bucket] += 1;
    for (const part of differing) union[part] += 1;
    if (differing.length === 1) sole[differing[0] as CensusPart] += 1;
    if (differing[0] === 'tables') direction[tableDirection(item.sql, item.gold)] += 1;
  }

  const outcome: CensusOutcome = {
    split: input.split,
    arm: input.arm,
    total: input.total,
    passed: input.passed,
    population: input.total - input.passed,
    buckets,
    sole,
    union,
    direction,
    difficulty,
    compared,
    source: input.source ?? { path: '' },
    problems: [],
  };
  return { ...outcome, problems: censusProblems(outcome) };
}

/**
 * The checks that make a census report a fact rather than a set of numbers that look right.
 *
 * Each of these has been false at some point in this repository's history under another instrument:
 * buckets that did not add up because a case landed in two, a sub-split larger than its parent
 * because a case was counted twice, and a population that did not equal the artifact's own two
 * totals because a case under another arm was read as this one's.
 */
export function censusProblems(outcome: CensusOutcome): readonly string[] {
  const problems: string[] = [];
  const partition = CENSUS_BUCKETS.reduce((total, bucket) => total + outcome.buckets[bucket], outcome.buckets.unretained);
  if (partition !== outcome.population) {
    problems.push(`buckets sum to ${String(partition)} but the arm left ${String(outcome.population)} case(s) unpassed`);
  }
  if (outcome.population !== outcome.total - outcome.passed) {
    problems.push(
      `population ${String(outcome.population)} is not the artifact's total minus its passed count (${String(outcome.total)} - ${String(outcome.passed)})`,
    );
  }
  if (outcome.compared + outcome.buckets.unretained !== outcome.population) {
    problems.push(
      `${String(outcome.compared)} compared and ${String(outcome.buckets.unretained)} unretained do not add up to the ${String(outcome.population)} unpassed case(s)`,
    );
  }
  const directions = outcome.direction.missing + outcome.direction.extra + outcome.direction.both;
  if (directions !== outcome.buckets.tables) {
    problems.push(`table directions sum to ${String(directions)} but ${String(outcome.buckets.tables)} case(s) landed in \`tables\``);
  }
  const soleTotal = CENSUS_PARTS.reduce((total, part) => total + outcome.sole[part], 0);
  if (soleTotal > outcome.population) {
    problems.push(`${String(soleTotal)} sole-difference cases exceed the ${String(outcome.population)} unpassed case(s)`);
  }
  for (const part of CENSUS_PARTS) {
    if (outcome.sole[part] > outcome.buckets[part]) {
      problems.push(
        `sole \`${part}\` is ${String(outcome.sole[part])}, above the ${String(outcome.buckets[part])} case(s) the precedence gave that part`,
      );
    }
    if (outcome.union[part] < outcome.buckets[part]) {
      problems.push(
        `union \`${part}\` is ${String(outcome.union[part])}, below the ${String(outcome.buckets[part])} case(s) the precedence gave that part`,
      );
    }
  }
  const difficultyTotal = Object.values(outcome.difficulty).reduce(
    (total, row) => total + CENSUS_BUCKETS.reduce((inner, bucket) => inner + row[bucket], row.unretained),
    0,
  );
  if (difficultyTotal !== outcome.population) {
    problems.push(`the difficulty cross-tab sums to ${String(difficultyTotal)}, not the ${String(outcome.population)} unpassed case(s)`);
  }
  return problems;
}

const percent = (count: number, base: number): string => `${((count / base) * 100).toFixed(1)}%`;

const share = (count: number, base: number): string => ((count / base) * 100).toFixed(2);

/** The report, as lines a terminal and a document can both read. */
export function censusLines(outcome: CensusOutcome): readonly string[] {
  const lines: string[] = [];
  const base = outcome.population === 0 ? 1 : outcome.population;
  const whole = outcome.total === 0 ? 1 : outcome.total;
  lines.push(`  first differing part, one case per row (${CENSUS_PARTS.join(' > ')}, then tie/unmodelled):`);
  for (const bucket of CENSUS_BUCKETS) {
    const count = outcome.buckets[bucket];
    const detail =
      bucket === 'tables'
        ? `   missing ${String(outcome.direction.missing)} · extra ${String(outcome.direction.extra)} · both ${String(outcome.direction.both)}`
        : '';
    lines.push(
      `    ${bucket.padEnd(11)} ${String(count).padStart(5)}  ${percent(count, base).padStart(6)} of wrong  ` +
        `${share(count, whole).padStart(5)}pp of split${detail}`,
    );
  }
  if (outcome.buckets.unretained > 0) {
    lines.push(`  ${String(outcome.buckets.unretained)} case(s) carried no statement: not counted as a part, not dropped`);
  }
  const soleParts = CENSUS_PARTS.filter((part) => outcome.sole[part] > 0);
  const soleTotal = CENSUS_PARTS.reduce((total, part) => total + outcome.sole[part], 0);
  lines.push(
    `  only one part differs: ${String(soleTotal)} of ${String(outcome.population)}` +
      (soleParts.length === 0 ? '' : ` — ${soleParts.map((part) => `${part} ${String(outcome.sole[part])}`).join(', ')}`),
  );
  lines.push(`  differs in a part, each case counted once per part: ${CENSUS_PARTS.map((part) => `${part} ${String(outcome.union[part])}`).join(', ')}`);
  for (const [label, row] of Object.entries(outcome.difficulty).sort(([a], [b]) => a.localeCompare(b))) {
    const total = CENSUS_BUCKETS.reduce((sum, bucket) => sum + row[bucket], row.unretained);
    // Every non-zero bucket is listed, including `tie` and `unmodelled`: a row whose total is two
    // and whose part list is one reads as a lost case, and the residual buckets are the cases a
    // reader is most likely to be owed an explanation for.
    const parts = CENSUS_BUCKETS.filter((bucket) => row[bucket] > 0).map((bucket) => `${bucket} ${String(row[bucket])}`);
    if (row.unretained > 0) parts.push(`unretained ${String(row.unretained)}`);
    lines.push(`    ${label.padEnd(11)} ${String(total).padStart(5)}  ${parts.join(', ')}`);
  }
  return lines;
}

/** One sentence a document can quote without re-deriving the semantics of a bucket name. */
export function censusSentence(outcome: CensusOutcome): string {
  if (outcome.population === 0) return 'no unpassed case to read';
  let top: CensusPart = CENSUS_PARTS[0];
  for (const part of CENSUS_PARTS) if (outcome.buckets[part] > outcome.buckets[top]) top = part;
  return (
    `${String(outcome.population)} unpassed case(s), ${String(outcome.buckets[top])} of them ` +
    `(${percent(outcome.buckets[top], outcome.population)}) differ from the gold first in \`${top}\`; ` +
    `a difference is not a defect — nothing here was executed`
  );
}

/**
 * What a census needs, which is less than any other instrument here.
 *
 * No corpus, no database, no layout: both statements being compared are in the artifact, and the
 * gold is carried per case. The layout is read only to answer what the artifact path is when the
 * caller does not name one, and it does not travel past `resolveCensusSettings`.
 */
export interface CensusSettings {
  readonly root: string;
  readonly artifact: string;
  readonly arm: string;
  /** Where to write, when the caller is reading a population the default name already holds. */
  readonly out?: string;
}

export const DEFAULT_CENSUS_ARM = 'macsql-prompt';

export function resolveCensusSettings(
  argv: readonly string[],
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): CensusSettings {
  const takesValue = new Set(['--artifact', '--arm', '--out']);
  let artifact: string | undefined;
  let arm: string | undefined;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!takesValue.has(token)) {
      throw new Error(`unrecognized argument ${token}: this harness takes --artifact <path>, --arm <name> and --out <path>`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
    if (token === '--artifact') artifact = value;
    else if (token === '--out') out = value;
    else arm = value;
    index += 1;
  }
  const layout = resolveLayout(env, root);
  const settings: CensusSettings = { root, artifact: artifact ?? layout.out, arm: arm ?? DEFAULT_CENSUS_ARM };
  return out === undefined ? settings : { ...settings, out: resolve(root, out) };
}

/** Where a census goes, named by arm and split so two populations never replace each other. */
export function censusPath(settings: { readonly root: string; readonly arm: string; readonly split: string }): string {
  const safe = settings.arm.replace(/[^a-z0-9+-]/gi, '_');
  return join(settings.root, 'eval', 'out', `census-${safe}-${settings.split}.json`);
}

/** The artifact a census reads: the fields it needs, so a wider artifact still validates. */
export interface CensusArtifact {
  readonly split?: string;
  readonly generatedAt?: string;
  readonly arms?: readonly { readonly arm: string; readonly passed: number; readonly total: number }[];
  readonly cases: readonly {
    readonly arm: string;
    readonly id: string | number;
    readonly passed: boolean;
    readonly sql?: string;
    readonly gold?: string;
    readonly asked?: { readonly difficulty?: string };
  }[];
}

/**
 * The arm's unpassed cases, and the two totals the population is checked against.
 *
 * The `arms` block is preferred over counting `cases`, because an artifact may cap the cases it
 * retains while its `arms` row still carries the run's real denominator — reading the population
 * off the retained cases would shrink the denominator to whatever a 200-statement cap left behind.
 */
export function readCensusInputs(artifact: CensusArtifact, arm: string, source?: CensusSource): CensusInput {
  const mine = artifact.cases.filter((row) => row.arm === arm);
  const cases = mine
    .filter((row) => !row.passed)
    .map((row) => ({ id: String(row.id), sql: row.sql, gold: row.gold, asked: row.asked }));
  const declared = artifact.arms?.find((row) => row.arm === arm);
  return {
    split: artifact.split ?? 'unknown',
    arm,
    total: declared?.total ?? mine.length,
    passed: declared?.passed ?? mine.filter((row) => row.passed).length,
    cases,
    source: source ?? { path: '', generatedAt: artifact.generatedAt },
  };
}

export async function runCensus(settings: CensusSettings): Promise<CensusOutcome> {
  const body = JSON.parse(readFileSync(settings.artifact, 'utf8')) as CensusArtifact;
  const input = readCensusInputs(body, settings.arm, { path: settings.artifact, generatedAt: body.generatedAt });
  return tallyCensus(input);
}

/**
 * Write the census, and refuse to replace one taken on a different artifact.
 *
 * The name is `census-<arm>-<split>`, which is one name for one population — except that a split
 * has two populations the moment a second dispatch of the same arm exists. That is not
 * hypothetical: the residue reading this repository published last round was taken on the
 * replicate while the section quoting it was about the canonical run, and nothing in the file said
 * so. A named artifact that records its source and declines to be overwritten by another one is the
 * cheapest version of the rule that the mistake cannot be made silently.
 */
export function writeCensusArtifact(settings: CensusSettings, outcome: CensusOutcome): string {
  const path = settings.out ?? censusPath({ root: settings.root, arm: outcome.arm, split: outcome.split });
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as { source?: CensusSource };
    const same = existing.source?.generatedAt === outcome.source.generatedAt;
    if (!same) {
      throw new Error(
        `${path} already holds a census of ${existing.source?.path ?? 'another artifact'} (${existing.source?.generatedAt ?? 'no timestamp'}); ` +
          `refusing to replace it with ${outcome.source.path} — read the first one under its own name`,
      );
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(outcome, null, 2)}\n`);
  return path;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const settings = resolveCensusSettings(argv, root, env);
  const outcome = await runCensus(settings);
  const path = writeCensusArtifact(settings, outcome);
  const base = outcome.total === 0 ? 1 : outcome.total;
  console.log(
    `census · ${outcome.arm} · ${outcome.split} · ${String(outcome.population)} of ${String(outcome.total)} wrong (${percent(outcome.population, base)})`,
  );
  for (const line of censusLines(outcome)) console.log(line);
  console.log(`  ${censusSentence(outcome)}`);
  console.log(`  written to ${path}`);
  for (const problem of outcome.problems) console.log(`  ${problem}`);
  return outcome.problems.length === 0 ? 0 : 1;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
