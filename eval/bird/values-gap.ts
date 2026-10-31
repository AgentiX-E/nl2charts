/**
 * The `values` bucket, split into the fixes it actually contains.
 *
 * `bench:bird:gap` classifies a question the candidate set never answered by the shape of
 * its failure, and on both splits and five arms it lands the same way: about three quarters
 * are `values` — the statement ran, the width matched, the numbers did not. That is a bucket
 * the size of four hundred dev questions, and "the numbers were wrong" is not a work item.
 *
 * This tool splits it, in the order of evidence rather than of frequency:
 *
 * 1. `no-statement` — the model returned nothing. No statement to read; a fix in generation.
 * 2. `filter-narrow` — the statement ran and returned no rows: a predicate matched nothing.
 * 3. `filter-wide` — a different number of rows: the predicate is too weak, or a join
 *    multiplied the rows.
 * 4. `scale` — every value a constant multiple of the gold's: an aggregation at the wrong
 *    level.
 * 5. `literal-missing` — a value the gold names does not appear at all: retrieval.
 * 6. `literal-case` — the value appears in a different case. SQLite compares strings
 *    case-sensitively, so this is a wrong answer produced by a right-looking statement, and
 *    the fix is in what the prompt shows the model about stored values.
 * 7. `tables` — the two statements read different base tables: join selection.
 * 8. `predicate` — same tables, different condition atoms: condition coverage.
 * 9. `aggregate` — different aggregate calls: which function answers the question.
 * 10. `grain` — different `group by`: the aggregation level.
 * 11. `projection` — different select list, in order: which columns, and in what order.
 * 12. `window` — different `order by` / `limit` / `offset`: which window of the same rows.
 * 13. `equivalent` — the statements normalize to the same text, so the difference is a tie
 *     the engine broke differently. Not a model error, and it is counted rather than hidden.
 *
 * The ladder stops at the first part that differs because that is the part a fix would
 * change: a statement that joined an extra table also has different predicates, and reporting
 * both would put one case in two work items and neither in the queue first.
 *
 * Everything here is computed from the two statements and the two result sets the diagnosis
 * already has, so it costs no model call and one query per case.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadQuestions } from './data.js';
import { caseMismatchedLiterals, classifyFailureShape, missingLiterals } from './failure-shape.js';
import type { FailureShape } from './failure-shape.js';
import { createOracle } from './oracle.js';
import { SHIPPED_ARM, requireArm } from './presence.js';
import { resolveLayout } from './run.js';
import type { BirdLayout } from './run.js';
import type { GapReportShape } from './gap.js';
import { statementShape, withoutWindow } from './sql-shape.js';

export { aggregateCalls, groupingColumns, predicateAtoms, projectionItems, statementShape } from './sql-shape.js';

/**
 * The buckets, in the order of the ladder.
 *
 * `unclassified` is last and is not a bucket anyone works on: it is the share of the set the
 * taxonomy cannot yet attribute, and the acceptance criterion is stated as its complement.
 */
export const VALUES_BUCKETS = [
  'no-statement',
  'filter-narrow',
  'filter-wide',
  'scale',
  'literal-missing',
  'literal-case',
  'tables',
  'predicate',
  'aggregate',
  'grain',
  'projection',
  'window',
  'equivalent',
  'unclassified',
] as const;
export type ValuesBucket = (typeof VALUES_BUCKETS)[number];

/**
 * Which of the judge's buckets this split reads.
 *
 * The first version read only `values`, and stated the reason: "a statement whose width is
 * wrong cannot be diagnosed clause by clause — the projection is the finding". That is an
 * assumption about the corpus, and it is false. `bench:bird:width` tried the only edit the
 * assumption allows — deleting the extra projected items, every subset, executed — and
 * recovered 2 of the 37 wide cases; the other 35 stay wrong with the right width, so their
 * width was a symptom of a different clause. Excluding them therefore excluded the majority
 * of a bucket whose cause this ladder can name.
 *
 * `values` is still the default so that every published table keeps its denominator, and
 * because the two buckets answer different questions until someone asks for both.
 */
export const SCOPES = ['values', 'all'] as const;
export type Scope = (typeof SCOPES)[number];

/** The judge's reasons each scope admits. */
const ADMITTED: Readonly<Record<Scope, readonly string[]>> = {
  values: ['values'],
  all: ['values', 'column-count'],
};

/**
 * How "no answer" was decided, which is a property of the arm rather than of the corpus.
 *
 * A multi-candidate arm records `candidateRecall` per case, and the tool's subject has always
 * been the cases where it is false: the query was never generated, so the ladder is reading
 * generation rather than selection. A single-call arm writes no candidate set at all, so the
 * field is absent rather than false — and filtering on it selected nothing, which is how this
 * tool reported "0 cases" on the arm the product ships.
 *
 * Both definitions are honest and they are not the same number on a selecting arm, so the one
 * a reading used is written into the artifact beside it.
 */
export const POPULATIONS = ['candidate-set', 'failures'] as const;
export type Population = (typeof POPULATIONS)[number];

export function answerlessCases<T extends { readonly passed?: boolean; readonly candidateRecall?: boolean }>(
  rows: readonly T[],
): { readonly rows: readonly T[]; readonly population: Population } {
  const population: Population = rows.some((row) => row.candidateRecall !== undefined) ? 'candidate-set' : 'failures';
  return {
    population,
    rows:
      population === 'candidate-set'
        ? rows.filter((row) => row.candidateRecall === false)
        : rows.filter((row) => row.passed === false),
  };
}

/** Which fix the difference asks for, from the two statements and the measured shape. */
export function classifyValuesGap(input: {
  readonly gold: string;
  readonly predicted: string;
  readonly shape: FailureShape;
}): ValuesBucket {
  if (input.predicted.trim() === '') return 'no-statement';
  if (input.shape === 'empty') return 'filter-narrow';
  if (input.shape === 'row-count') return 'filter-wide';
  if (input.shape === 'scale') return 'scale';
  // Literals are compared with the window cut off: `limit 5` against `limit 6` is a window
  // difference and must not be reported as a missing value.
  const goldValues = withoutWindow(input.gold);
  const predictedValues = withoutWindow(input.predicted);
  if (missingLiterals(goldValues, predictedValues).length > 0) return 'literal-missing';
  if (caseMismatchedLiterals(goldValues, predictedValues).length > 0) return 'literal-case';
  const gold = statementShape(input.gold);
  const predicted = statementShape(input.predicted);
  if (gold.tables.join(',') !== predicted.tables.join(',')) return 'tables';
  if (gold.predicates.join('\u0001') !== predicted.predicates.join('\u0001')) return 'predicate';
  if (gold.aggregates.join(',') !== predicted.aggregates.join(',')) return 'aggregate';
  if (gold.groups.join(',') !== predicted.groups.join(',')) return 'grain';
  if (gold.projection.join('\u0001') !== predicted.projection.join('\u0001')) return 'projection';
  if (gold.window !== predicted.window) return 'window';
  if (gold.text !== predicted.text) return 'unclassified';
  return 'equivalent';
}

export interface ValuesTally {
  readonly total: number;
  readonly buckets: Readonly<Record<ValuesBucket, number>>;
  readonly classified: number;
  readonly coverage: number;
}

export function tallyValues(rows: readonly ValuesBucket[]): ValuesTally {
  const buckets = VALUES_BUCKETS.reduce((acc, bucket) => ({ ...acc, [bucket]: 0 }), {} as Record<ValuesBucket, number>);
  for (const row of rows) buckets[row] += 1;
  const classified = rows.length - buckets.unclassified;
  return {
    total: rows.length,
    buckets,
    classified,
    coverage: rows.length === 0 ? 1 : classified / rows.length,
  };
}

/**
 * Whether the split is worth publishing.
 *
 * The same bar the parent classification uses: four fifths of the bucket must reach a named
 * cause, because a table where a third of the rows say "unclassified" cannot order the work
 * it exists to order. An empty bucket is not a failure — it is a reading of zero — but it is
 * worth saying out loud, since a `values` bucket of zero means the parent tool disagrees
 * with the diagnosis and one of the two is measuring the wrong thing.
 */
export function valuesProblems(tally: ValuesTally, minimumCoverage = 0.8, drops: ValuesDrops = NO_VALUE_DROPS): string[] {
  const problems: string[] = [];
  if (tally.total === 0) {
    // Two states that read the same in a ratio and mean opposite things: nothing was retained,
    // or everything retained was outside the scope the caller asked for. Naming the second one
    // is the reason `otherBucket` was fixed — the sentence "no statement for any no-answer
    // case" was printed over artifacts that held a statement for every one of them.
    problems.push(
      drops.otherBucket === 0
        ? 'VGAP: the artifact holds no statement for any no-answer case, so the values bucket cannot be split'
        : `VGAP: the artifact holds ${String(drops.otherBucket)} no-answer cases and every one is outside this scope, so the split has nothing of its own to read`,
    );
    return problems;
  }
  if (tally.coverage < minimumCoverage) {
    problems.push(
      `VGAP: ${tally.classified} of ${tally.total} values cases reach a named cause (${(tally.coverage * 100).toFixed(1)}%), below the ${(minimumCoverage * 100).toFixed(0)}% the plan requires`,
    );
  }
  return problems;
}

/**
 * The lines a reader sees: one row per bucket, grouped by the question the bucket answers.
 *
 * The three groups are not decoration. "Did the statement run" and "did it read the right
 * table" are answered by different parts of the product, and a flat list of thirteen rows
 * makes a reader add that up themselves.
 */
export function valuesLines(tally: ValuesTally, scope: Scope = 'values'): string[] {
  const share = (count: number): string => (tally.total === 0 ? '0.0%' : `${((count / tally.total) * 100).toFixed(1)}%`);
  const rows = (buckets: readonly ValuesBucket[]): string[] =>
    buckets.map((bucket) => `  ${bucket.padEnd(18)} ${String(tally.buckets[bucket]).padStart(4)}  ${share(tally.buckets[bucket])}`);
  const out = [
    scope === 'all'
      ? 'every no-answer case, split by the fix it asks for'
      : 'values bucket, split by the fix it asks for',
    '',
  ];
  out.push('  did it run and return rows');
  out.push(...rows(['no-statement', 'filter-narrow', 'filter-wide', 'scale']));
  out.push('');
  out.push('  did it read the right values and tables');
  out.push(...rows(['literal-missing', 'literal-case', 'tables', 'predicate']));
  out.push('');
  out.push('  did it compute the right thing');
  out.push(...rows(['aggregate', 'grain', 'projection', 'window']));
  out.push('');
  out.push('  no difference to name');
  out.push(...rows(['equivalent', 'unclassified']));
  out.push('');
  out.push(`  ${String(tally.total)} cases, ${String(tally.classified)} classified (${(tally.coverage * 100).toFixed(1)}%)`);
  return out;
}

/** Where a split reads and writes. `arm` is the arm whose no-answer cases are split. */
export interface ValuesGapSettings {
  readonly report: string;
  readonly layout: BirdLayout;
  readonly arm: string;
  readonly out: string;
  /** Which judge buckets the split admits. See `SCOPES`. */
  readonly scope: Scope;
  /** Exit non-zero when the split misses the coverage bar. Off for a measurement, on for a gate. */
  readonly strict: boolean;
}

export function resolveValuesGapSettings(
  env: Record<string, string | undefined>,
  argv: readonly string[],
  root: string,
): ValuesGapSettings {
  const flag = argv.indexOf('--arm');
  const named = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && named === undefined) throw new Error('--arm needs a name');
  const scopeFlag = argv.indexOf('--scope');
  const scopeName = scopeFlag === -1 ? undefined : argv[scopeFlag + 1];
  if (scopeFlag !== -1 && scopeName === undefined) throw new Error('--scope needs a name');
  if (scopeName !== undefined && !(SCOPES as readonly string[]).includes(scopeName)) {
    throw new Error(`--scope must be one of ${SCOPES.join(', ')}`);
  }
  const consumed = [...(flag === -1 ? [] : [flag, flag + 1]), ...(scopeFlag === -1 ? [] : [scopeFlag, scopeFlag + 1])];
  const path = argv.find((item, index) => !item.startsWith('--') && !consumed.includes(index));
  if (path === undefined) throw new Error('usage: values-gap.ts <report.json> [--arm <name>] [--scope values|all] [--strict]');
  const layout = resolveLayout(env, root);
  return {
    report: path,
    layout,
    arm: named ?? SHIPPED_ARM,
    out: dirname(layout.out),
    scope: (scopeName ?? 'values') as Scope,
    strict: argv.includes('--strict'),
  };
}

export interface ValuesRow {
  readonly id: string;
  readonly bucket: ValuesBucket;
}

/**
 * The cases the split could not read, each with the reason.
 *
 * `otherBucket` is the one that matters, and it was dead: declared, printed, and never
 * incremented, so the line a reader saw — "0 in the column-count bucket" — was true by
 * construction on every artifact this tool ever ran. A counter that cannot move is worse
 * than no counter: it reads as evidence that the exclusion was measured.
 *
 * It now counts the no-answer cases whose judge reason is outside the split's scope, which
 * is the `column-count` bucket under the default scope and nothing at all under `all`.
 */
export interface ValuesDrops {
  readonly unknownQuestion: number;
  readonly unretained: number;
  readonly otherBucket: number;
  readonly engineRefused: number;
  readonly goldFailed: number;
}

export const NO_VALUE_DROPS: ValuesDrops = {
  unknownQuestion: 0,
  unretained: 0,
  otherBucket: 0,
  engineRefused: 0,
  goldFailed: 0,
};

export interface ValuesOutcome {
  readonly split: string;
  readonly arm: string;
  readonly scope: Scope;
  readonly population: Population;
  readonly rows: readonly ValuesRow[];
  readonly tally: ValuesTally;
  readonly drops: ValuesDrops;
  readonly problems: readonly string[];
}

/**
 * Split the arm's no-answer cases, one oracle run each.
 *
 * The input is the bucket `bench:bird:gap` publishes. The default scope is the `values`
 * bucket alone, which is what every published table's denominator counts; `--scope all`
 * admits the `column-count` cases too, because `bench:bird:width` showed that a width
 * difference is usually a symptom rather than the finding and this ladder can name the
 * clause behind it.
 *
 * The statement comes from the artifact's retained failures rather than from the case row:
 * the case row carries the verdict and the candidate set, the failure row carries the SQL.
 */
export async function runValuesGap(settings: ValuesGapSettings): Promise<ValuesOutcome> {
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as GapReportShape;

  const questions = loadQuestions(settings.layout.questionsFile);
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));
  const statements = new Map((report.failures?.[settings.arm] ?? []).map((entry) => [String(entry.id), entry]));
  const scoped = requireArm(report.cases, settings.arm, settings.report).filter((row) => row.arm === settings.arm);
  const { rows: noAnswer, population } = answerlessCases(scoped);
  const admitted = ADMITTED[settings.scope];
  const scored = noAnswer.filter((row) => row.reason !== undefined && admitted.includes(row.reason));
  const rows: ValuesRow[] = [];
  const drops = {
    unknownQuestion: 0,
    unretained: 0,
    otherBucket: noAnswer.length - scored.length,
    engineRefused: 0,
    goldFailed: 0,
  };
  const oracle = createOracle(settings.layout.oracleScript, settings.layout.databaseRoot);
  const gold = new Map<string, Awaited<ReturnType<typeof oracle.run>>>();
  try {
    for (const row of scored) {
      const id = String(row.id);
      const question = byId.get(id);
      if (question === undefined) {
        drops.unknownQuestion += 1;
        continue;
      }
      const failure = statements.get(id);
      if (failure === undefined || typeof failure.predicted !== 'string') {
        drops.unretained += 1;
        continue;
      }
      const predictedSql = failure.predicted;
      // A statement the model did not write is the first bucket, before any query is spent:
      // running nothing and calling it a filter error would file a generation failure under
      // retrieval, and the two have nothing to do with each other.
      if (predictedSql.trim() === '') {
        rows.push({ id, bucket: 'no-statement' });
        continue;
      }
      let expected = gold.get(id);
      if (expected === undefined) {
        expected = await oracle.run(question.db_id, question.SQL);
        gold.set(id, expected);
      }
      if (!expected.ok) {
        drops.goldFailed += 1;
        continue;
      }
      const predicted = await oracle.run(question.db_id, predictedSql);
      if (!predicted.ok) {
        drops.engineRefused += 1;
        continue;
      }
      const shape = classifyFailureShape(predicted, expected.rows);
      rows.push({ id, bucket: classifyValuesGap({ gold: question.SQL, predicted: predictedSql, shape: shape.shape }) });
    }
  } finally {
    await oracle.close();
  }
  const tally = tallyValues(rows.map((row) => row.bucket));
  // An arm with no no-answer case at all is a perfect run, and a gate must not red on one: the
  // empty bucket is the reading, not the failure. An arm with no-answer cases but nothing filed
  // under `values` is the opposite — either the artifact predates the field or the judge is
  // reporting something the split cannot see — and that is worth failing a gate over.
  const problems = noAnswer.length === 0 ? [] : valuesProblems(tally, 0.8, drops);
  const outcome: ValuesOutcome = {
    split: settings.layout.split,
    arm: settings.arm,
    scope: settings.scope,
    population,
    rows,
    tally,
    drops,
    problems,
  };
  return outcome;
}

/**
 * Where the split is written.
 *
 * The scope is part of the name, because two scopes are two readings of the same arm and one
 * file would have made the second invocation overwrite the first — the artifact on the runner
 * would then be whichever step ran last, under a name that reads like the other one.
 */
export function valuesGapPath(settings: ValuesGapSettings): string {
  const arm = settings.arm.replace(/[^a-z0-9+_-]/gi, '-');
  const scope = settings.scope === 'values' ? '' : `-${settings.scope}`;
  return join(settings.out, `values-gap-${arm}${scope}.json`);
}

export function writeValuesArtifact(settings: ValuesGapSettings, outcome: ValuesOutcome): string {
  const path = valuesGapPath(settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(outcome, null, 2));
  return path;
}

/**
 * The program: read, split, print, write, and report.
 *
 * `--strict` is the whole difference between a measurement and a gate. The dev workflow runs
 * this before the taxonomy has a reading, and a step that reds the build because the taxonomy
 * is incomplete teaches the wrong lesson: the finding is the output, the build is fine. The
 * quality gate runs it with `--strict` once the split is known to reach its bar, and there a
 * regression in coverage is a regression.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const settings = resolveValuesGapSettings(env, argv, root);
  const outcome = await runValuesGap(settings);
  for (const line of valuesLines(outcome.tally, outcome.scope)) console.log(line);
  console.log(
    `  population: ${outcome.population === 'candidate-set' ? 'cases whose candidate set held no answer' : 'cases the arm failed'}`,
  );
  console.log(
    `  dropped: ${String(outcome.drops.unretained)} unretained, ${String(outcome.drops.otherBucket)} outside the ${outcome.scope} scope, ` +
      `${String(outcome.drops.engineRefused)} refused by the engine, ${String(outcome.drops.goldFailed)} unrunnable gold, ` +
      `${String(outcome.drops.unknownQuestion)} unknown question`,
  );
  const path = writeValuesArtifact(settings, outcome);
  console.log(`\nwrote ${path}`);
  for (const problem of outcome.problems) console.error(problem);
  if (outcome.problems.length === 0) return 0;
  return settings.strict ? 1 : 0;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
