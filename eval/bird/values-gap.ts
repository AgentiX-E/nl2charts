/**
 * The `values` bucket, split into the fixes it actually contains.
 *
 * `bench:bird:gap` classifies a question the candidate set never answered by the shape of
 * its failure, and on both splits and five arms it lands the same way: about three quarters
 * are `values` — the statement ran, the width matched, the numbers did not. That is a bucket
 * the size of 388 dev questions, and it is still three different bugs:
 *
 * - `filter-narrow` — the statement returned no rows at all. A predicate matched nothing:
 *   the literal is wrong, its case is wrong, or it was written against the wrong column.
 * - `filter-wide` — it returned rows, a different number of them. The predicate is too weak,
 *   or a join multiplied the rows.
 * - `missing-literal` — it returned the same number of rows and values that are wrong,
 *   and a literal the gold statement names does not appear in it. The value was replaced,
 *   not filtered on.
 * - `scale` — every value is a constant multiple of the gold's: the aggregation is at the
 *   wrong level (per-row instead of grouped), which is a `sum` where the question asked
 *   for an average of a sum.
 * - `aggregate` — the same literals, a different set of aggregate functions.
 * - `grain` — the same literals and aggregates, a different `group by`.
 *
 * The order is the order of evidence, not of frequency: an empty result is measurable
 * without reading the SQL, a missing literal is measurable by comparing two strings, and
 * "the aggregate is wrong" and "the grain is wrong" are hypotheses about the same statement
 * and are therefore tried last, when nothing more direct explains the difference.
 *
 * Everything here is computed from the two statements and the two result sets the diagnosis
 * already has, so it costs no model call and no extra query.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadQuestions } from './data.js';
import { classifyFailureShape } from './failure-shape.js';
import type { FailureShape } from './failure-shape.js';
import { missingLiterals } from './failure-shape.js';
import { createOracle } from './oracle.js';
import { resolveLayout } from './run.js';
import type { BirdLayout } from './run.js';
import type { GapReportShape } from './gap.js';

export const VALUES_BUCKETS = ['filter-narrow', 'filter-wide', 'missing-literal', 'scale', 'aggregate', 'grain', 'unclassified'] as const;
export type ValuesBucket = (typeof VALUES_BUCKETS)[number];

/** The aggregate functions a statement calls, in a form two statements can be compared in. */
const AGGREGATES = ['count', 'sum', 'avg', 'min', 'max', 'total', 'group_concat'] as const;

/**
 * The aggregate calls in a statement, lowercased, sorted and with `distinct` folded in.
 *
 * `count(distinct x)` and `count(x)` are different answers to the same question, so the
 * modifier belongs to the name rather than being dropped by a regex that stops at the
 * parenthesis. String literals are stripped first: `'count(*)'` in a predicate is not an
 * aggregate, and a taxonomy that counted it would put a filter bug in the aggregation bucket.
 */
export function aggregateCalls(sql: string): string[] {
  const text = sql.replace(/'([^']|'')*'/g, "''").toLowerCase();
  const calls: string[] = [];
  for (const name of AGGREGATES) {
    const pattern = new RegExp(`\\b${name}\\s*\\(\\s*(distinct\\s+)?`, 'g');
    for (const match of text.matchAll(pattern)) {
      calls.push(match[1] === undefined ? name : `${name}-distinct`);
    }
  }
  return calls.sort();
}

/**
 * The columns a statement groups by, normalized enough to compare two spellings.
 *
 * Aliases and quoting are dropped because `group by 1` and `group by "Name"` are the same
 * instruction written two ways, and a taxonomy that called that a grain difference would
 * fill the bucket with the model's formatting rather than its mistakes.
 */
export function groupingColumns(sql: string): string[] {
  const text = sql.replace(/'([^']|'')*'/g, "''").toLowerCase();
  const match = /\bgroup\s+by\b([\s\S]*?)(\border\s+by\b|\bhaving\b|\blimit\b|$)/.exec(text);
  if (match === null) return [];
  // `[\s\S]*?` can match the empty string, so `group by` at the end of a statement is a
  // clause with no columns rather than a group 1 that is missing (ADR-219: no unreachable
  // fallback).
  return match[1]
    .split(',')
    .map((part) => part.replace(/["'`]/g, '').replace(/\s+/g, ' ').trim())
    .filter((part) => part !== '')
    .sort();
}

/**
 * Which fix the difference asks for.
 *
 * `shape` is the verdict the oracle already produced from the two result sets, so this
 * function never re-derives what the engine measured — it only adds the reading of the two
 * statements that the result sets cannot give.
 */
export function classifyValuesGap(input: {
  readonly gold: string;
  readonly predicted: string;
  readonly shape: FailureShape;
}): ValuesBucket {
  if (input.shape === 'empty') return 'filter-narrow';
  if (input.shape === 'row-count') return 'filter-wide';
  if (input.shape === 'scale') return 'scale';
  if (missingLiterals(input.gold, input.predicted).length > 0) return 'missing-literal';
  const goldAggregates = aggregateCalls(input.gold);
  const predictedAggregates = aggregateCalls(input.predicted);
  if (goldAggregates.join(',') !== predictedAggregates.join(',')) return 'aggregate';
  const goldGroups = groupingColumns(input.gold);
  const predictedGroups = groupingColumns(input.predicted);
  if (goldGroups.join(',') !== predictedGroups.join(',')) return 'grain';
  return 'unclassified';
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

/** The lines a reader sees: one row per bucket, with the count and the share of the bucket. */
export function valuesLines(tally: ValuesTally): string[] {
  const out = ['values bucket, split by the fix it asks for', ''];
  for (const bucket of VALUES_BUCKETS) {
    const count = tally.buckets[bucket];
    const share = tally.total === 0 ? 0 : count / tally.total;
    out.push(`  ${bucket.padEnd(16)} ${String(count).padStart(4)}  ${(share * 100).toFixed(1)}%`);
  }
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
}

export function resolveValuesGapSettings(
  env: Record<string, string | undefined>,
  argv: readonly string[],
  root: string,
): ValuesGapSettings {
  const path = argv[0];
  if (path === undefined) throw new Error('usage: values-gap.ts <report.json> [--arm <name>]');
  const flag = argv.indexOf('--arm');
  const arm = flag === -1 ? 'select-cross' : argv[flag + 1];
  if (arm === undefined) throw new Error('--arm needs a name');
  const layout = resolveLayout(env, root);
  return { report: path, layout, arm, out: dirname(layout.out) };
}

export interface ValuesRow {
  readonly id: string;
  readonly bucket: ValuesBucket;
}

export interface ValuesDrops {
  readonly unknownQuestion: number;
  readonly unretained: number;
  readonly emptyPrediction: number;
  readonly goldFailed: number;
  readonly predictionFailed: number;
}

export const NO_VALUE_DROPS: ValuesDrops = {
  unknownQuestion: 0,
  unretained: 0,
  emptyPrediction: 0,
  goldFailed: 0,
  predictionFailed: 0,
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
 * The statement is read from the artifact's retained failures rather than from the case row:
 * the case row carries the verdict and the candidate set, the failure row carries the SQL.
 * A no-answer case whose statement was not retained is counted as `unretained` — it is the
 * artifact's loss, not the model's, and after the corpus cap was raised above the largest
 * split it can only mean an arm that failed more questions than the split holds.
 */
export async function runValuesGap(settings: ValuesGapSettings): Promise<ValuesOutcome> {
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as GapReportShape;
  const questions = loadQuestions(settings.layout.questionsFile);
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));
  const statements = new Map((report.failures?.[settings.arm] ?? []).map((entry) => [String(entry.id), entry]));
  const noAnswer = (report.cases ?? []).filter((row) => row.arm === settings.arm && row.candidateRecall === false);
  const rows: ValuesRow[] = [];
  const drops = { unknownQuestion: 0, unretained: 0, emptyPrediction: 0, goldFailed: 0, predictionFailed: 0 };
  const oracle = createOracle(settings.layout.oracleScript, settings.layout.databaseRoot);
  const gold = new Map<string, Awaited<ReturnType<typeof oracle.run>>>();
  try {
    for (const row of noAnswer) {
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
      if (predictedSql.trim() === '') {
        drops.emptyPrediction += 1;
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
        drops.predictionFailed += 1;
        continue;
      }
      const shape = classifyFailureShape(predicted, expected.rows);
      rows.push({ id, bucket: classifyValuesGap({ gold: question.SQL, predicted: predictedSql, shape: shape.shape }) });
    }
  } finally {
    await oracle.close();
  }
  const tally = tallyValues(rows.map((row) => row.bucket));
  const problems = valuesProblems(tally);
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

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const settings = resolveValuesGapSettings(env, argv, root);
  const outcome = await runValuesGap(settings);
  for (const line of valuesLines(outcome.tally)) console.log(line);
  console.log(
    `  dropped: ${String(outcome.drops.unretained)} unretained, ${String(outcome.drops.emptyPrediction)} empty, ` +
      `${String(outcome.drops.goldFailed)} unrunnable gold, ${String(outcome.drops.predictionFailed)} unrunnable prediction`,
  );
  const path = writeValuesArtifact(settings, outcome);
  console.log(`\nwrote ${path}`);
  for (const problem of outcome.problems) console.error(problem);
  return outcome.problems.length === 0 ? 0 : 1;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
