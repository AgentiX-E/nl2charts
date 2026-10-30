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
export function valuesProblems(tally: ValuesTally, minimumCoverage = 0.8): string[] {
  const problems: string[] = [];
  if (tally.total === 0) {
    problems.push('VGAP: the artifact holds no statement for any no-answer case, so the values bucket cannot be split');
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
export function valuesLines(tally: ValuesTally): string[] {
  const share = (count: number): string => (tally.total === 0 ? '0.0%' : `${((count / tally.total) * 100).toFixed(1)}%`);
  const rows = (buckets: readonly ValuesBucket[]): string[] =>
    buckets.map((bucket) => `  ${bucket.padEnd(18)} ${String(tally.buckets[bucket]).padStart(4)}  ${share(tally.buckets[bucket])}`);
  const out = ['values bucket, split by the fix it asks for', ''];
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
  const consumed = flag === -1 ? [] : [flag, flag + 1];
  const path = argv.find((item, index) => !item.startsWith('--') && !consumed.includes(index));
  if (path === undefined) throw new Error('usage: values-gap.ts <report.json> [--arm <name>] [--strict]');
  const layout = resolveLayout(env, root);
  return { report: path, layout, arm: named ?? SHIPPED_ARM, out: dirname(layout.out), strict: argv.includes('--strict') };
}

export interface ValuesRow {
  readonly id: string;
  readonly bucket: ValuesBucket;
}

/**
 * The cases the split could not read, each with the reason.
 *
 * `otherBucket` is the one that matters: the judge calls about a fifth of the no-answer set
 * `column-count` and this tool has no business splitting those, because a statement whose
 * width is wrong cannot be diagnosed clause by clause — the projection is the finding. Before
 * this counter existed the tool split them anyway and reported 86 of them as `unclassified`,
 * which is how a taxonomy reports its own scope as its own blind spot.
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
  readonly rows: readonly ValuesRow[];
  readonly tally: ValuesTally;
  readonly drops: ValuesDrops;
  readonly problems: readonly string[];
}

/**
 * Split the arm's `values` cases, one oracle run each.
 *
 * The input is the bucket `bench:bird:gap` publishes — cases the judge scored as `values` —
 * not "every case with no answer". The two sets differ by the `column-count` cases, and
 * admitting them would make the split's denominator disagree with the parent's numerator:
 * the first run of this tool did exactly that and attributed 86 width errors to clauses.
 *
 * The statement comes from the artifact's retained failures rather than from the case row:
 * the case row carries the verdict and the candidate set, the failure row carries the SQL.
 */
export async function runValuesGap(settings: ValuesGapSettings): Promise<ValuesOutcome> {
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as GapReportShape;

  const questions = loadQuestions(settings.layout.questionsFile);
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));
  const statements = new Map((report.failures?.[settings.arm] ?? []).map((entry) => [String(entry.id), entry]));
  const noAnswer = requireArm(report.cases, settings.arm, settings.report).filter(
    (row) => row.arm === settings.arm && row.candidateRecall === false,
  );
  const scored = noAnswer.filter((row) => row.reason === 'values');
  const rows: ValuesRow[] = [];
  const drops = { unknownQuestion: 0, unretained: 0, otherBucket: 0, engineRefused: 0, goldFailed: 0 };
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
  const problems = noAnswer.length === 0 ? [] : valuesProblems(tally);
  const outcome: ValuesOutcome = { split: settings.layout.split, arm: settings.arm, rows, tally, drops, problems };
  return outcome;
}

export function valuesGapPath(settings: ValuesGapSettings): string {
  return join(settings.out, `values-gap-${settings.arm.replace(/[^a-z0-9+_-]/gi, '-')}.json`);
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
  for (const line of valuesLines(outcome.tally)) console.log(line);
  console.log(
    `  dropped: ${String(outcome.drops.unretained)} unretained, ${String(outcome.drops.otherBucket)} in the column-count bucket, ` +
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
