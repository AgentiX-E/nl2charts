/**
 * Which condition of the question the statement never wrote.
 *
 * The clause ladder names the part of a statement that differs — `predicate`, `filter-wide`,
 * `tables` — and stops there, because "the condition is different" is where a reader starts
 * rather than where they finish. This goes one step further and asks the question a mechanism
 * would have to answer: the gold compares a column to a value, does the prediction compare that
 * column to anything at all?
 *
 * The distinction it draws is the one that decides which lever is worth building:
 *
 * - **a written condition, differently spelled** — same column, different literal, different
 *   operator, a range against a point. A lever here is spelling: which stored values the prompt
 *   shows, which operator the wording implies. That is the value-sampling family, and it has
 *   been priced at a ceiling of 2.22pp.
 * - **no condition on that column at all** — the statement filters on something else, or on
 *   nothing. No amount of value spelling reaches this: the model never decided the column was
 *   part of the question. A lever here has to revisit the statement against the question.
 *
 * The match is on identifiers, not on text: `where t1.segment = 'LAM'` and
 * `where t1.segment = 'SME'` share a column and differ in a value, which is the first case;
 * `where t1.segment = 'LAM'` against no mention of `segment` anywhere is the second. Matching
 * on normalized text would file both as missing, and matching on the whole atom would file
 * both as written.
 *
 * Zero model calls and zero queries: the two statements are in the artifact and the gold is in
 * the split. That is what makes it affordable on every failure rather than on a sample.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadQuestions } from './data.js';
import type { GapReportShape } from './gap.js';
import { SHIPPED_ARM, requireArm } from './presence.js';
import { resolveLayout } from './run.js';
import type { BirdLayout } from './run.js';
import { statementShape } from './sql-shape.js';

/** Words that are not identifiers, so two atoms are not related by sharing one. */
const KEYWORDS = new Set([
  'select',
  'from',
  'where',
  'and',
  'or',
  'not',
  'null',
  'is',
  'in',
  'like',
  'between',
  'case',
  'when',
  'then',
  'else',
  'end',
  'distinct',
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'cast',
  'as',
  'on',
  'join',
  'group',
  'by',
  'order',
  'having',
  'limit',
  'offset',
  'true',
  'false',
]);

/**
 * The identifiers one atom uses, lowercased.
 *
 * `t1.segment` keeps its qualifier: `segment` on two different tables is not the same
 * condition, and dropping the qualifier would let a statement that filtered the wrong table
 * pass as having written the condition.
 *
 * String literals are removed first. `where segment = 'lam'` and `where country = 'lam'` share
 * no column, but both spell `lam`, and a reader that counted the literal as an identifier would
 * call the second condition written. That is the one confusion this function exists to avoid:
 * a value is what a statement got wrong, a column is what it never considered.
 */
export function atomIdentifiers(atom: string): string[] {
  const code = atom.replace(/'(?:''|[^'])*'/g, ' ');
  const found = code.toLowerCase().match(/[a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?/g) ?? [];
  return [...new Set(found.filter((token) => !KEYWORDS.has(token)))];
}

/** Whether any written atom uses one of the identifiers the gold atom uses. */
export function hasCounterpart(atom: string, written: readonly string[]): boolean {
  const mine = atomIdentifiers(atom);
  return written.some((other) => {
    const theirs = new Set(atomIdentifiers(other));
    return mine.some((token) => theirs.has(token));
  });
}

/**
 * The conditions a statement states, in the form two statements can be compared in.
 *
 * Two normalizations matter here and both are `statementShape`'s: aliases are rewritten to
 * their table (`t1.segment` and `customers.segment` are one condition, and a reader that
 * compared the raw text would report a missing condition on every case where the model chose a
 * different alias), and keywords are folded before the split (BIRD's gold writes `WHERE`, and
 * `predicateAtoms` splits on lowercase — handed a raw statement it returns nothing, and an
 * empty list of gold conditions makes every statement look complete).
 *
 * That second defect was live for one run of this file and is worth recording: it reported 13
 * failures missing a condition where the truth is 192, because 207 of them had been compared
 * against a gold statement the reader had quietly decided had no conditions at all. A reading
 * of zero and a reading of "nothing to read" are the same number and opposite findings.
 */
function conditionsOf(sql: string): string[] {
  return [...statementShape(sql).predicates];
}

/** The gold's conditions that the prediction never names a column of, in the reader's order. */
export function missingConditions(gold: string, predicted: string): string[] {
  const written = conditionsOf(predicted);
  return conditionsOf(gold).filter((atom) => !hasCounterpart(atom, written));
}

/** One case's reading. */
export interface ConditionRow {
  readonly id: string;
  /** Conditions the prediction names no column of. */
  readonly missing: readonly string[];
  /** Every condition the gold states, for the denominator. */
  readonly stated: number;
  /** The ladder bucket the case was filed under, when a ladder artifact was supplied. */
  readonly bucket?: string;
}

export interface ConditionDrops {
  readonly unknownQuestion: number;
  readonly unretained: number;
  readonly unreadableLadder: number;
}

export const NO_CONDITION_DROPS: ConditionDrops = { unknownQuestion: 0, unretained: 0, unreadableLadder: 0 };

export interface ConditionTally {
  readonly total: number;
  /** Cases with at least one condition the statement never names a column of. */
  readonly missingSome: number;
  /** Cases whose every gold condition has a counterpart in the statement. */
  readonly missingNone: number;
  readonly atoms: number;
  /** Missing conditions per ladder bucket, when a ladder artifact was supplied. */
  readonly byBucket: Readonly<Record<string, { readonly cases: number; readonly missing: number }>>;
}

export function tallyConditions(rows: readonly ConditionRow[]): ConditionTally {
  const byBucket: Record<string, { cases: number; missing: number }> = {};
  for (const row of rows) {
    const bucket = row.bucket ?? 'unknown';
    const entry = byBucket[bucket] ?? { cases: 0, missing: 0 };
    byBucket[bucket] = { cases: entry.cases + 1, missing: entry.missing + (row.missing.length > 0 ? 1 : 0) };
  }
  return {
    total: rows.length,
    missingSome: rows.filter((row) => row.missing.length > 0).length,
    missingNone: rows.filter((row) => row.missing.length === 0).length,
    atoms: rows.reduce((sum, row) => sum + row.missing.length, 0),
    byBucket,
  };
}

export interface ConditionSettings {
  readonly report: string;
  readonly layout: BirdLayout;
  readonly arm: string;
  /** A `values-gap` artifact to join on, so the reading is per ladder bucket. */
  readonly ladder?: string;
  readonly out: string;
  readonly strict: boolean;
}

export function resolveConditionSettings(
  env: Record<string, string | undefined>,
  argv: readonly string[],
  root: string,
): ConditionSettings {
  const flag = argv.indexOf('--arm');
  const named = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && named === undefined) throw new Error('--arm needs a name');
  const ladderFlag = argv.indexOf('--ladder');
  const ladder = ladderFlag === -1 ? undefined : argv[ladderFlag + 1];
  if (ladderFlag !== -1 && ladder === undefined) throw new Error('--ladder needs a path');
  const consumed = [...(flag === -1 ? [] : [flag, flag + 1]), ...(ladderFlag === -1 ? [] : [ladderFlag, ladderFlag + 1])];
  const path = argv.find((item, index) => !item.startsWith('--') && !consumed.includes(index));
  if (path === undefined) throw new Error('usage: conditions.ts <report.json> [--arm <name>] [--ladder <values-gap.json>] [--strict]');
  const layout = resolveLayout(env, root);
  return {
    report: path,
    layout,
    arm: named ?? SHIPPED_ARM,
    ...(ladder === undefined ? {} : { ladder }),
    out: dirname(layout.out),
    strict: argv.includes('--strict'),
  };
}

export interface ConditionOutcome {
  readonly split: string;
  readonly arm: string;
  readonly scored: number;
  readonly rows: readonly ConditionRow[];
  readonly tally: ConditionTally;
  readonly drops: ConditionDrops;
  readonly problems: readonly string[];
}

/** The ladder's per-case buckets, keyed by question id. */
export function ladderBuckets(body: unknown): Map<string, string> {
  const rows = (body as { rows?: readonly { id?: string; bucket?: string }[] }).rows ?? [];
  const map = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.id === 'string' && typeof row.bucket === 'string') map.set(row.id, row.bucket);
  }
  return map;
}

export function runConditions(settings: ConditionSettings): ConditionOutcome {
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as GapReportShape;
  const questions = loadQuestions(settings.layout.questionsFile);
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));
  const cases = requireArm(report.cases, settings.arm, settings.report).filter((row) => row.arm === settings.arm);
  const statements = new Map((report.failures?.[settings.arm] ?? []).map((entry) => [String(entry.id), entry]));
  const drops = { unknownQuestion: 0, unretained: 0, unreadableLadder: 0 };
  let ladder: Map<string, string> | undefined;
  if (settings.ladder !== undefined) {
    try {
      ladder = ladderBuckets(JSON.parse(readFileSync(settings.ladder, 'utf8')));
    } catch {
      // A ladder the join cannot read is a missing input rather than a reading of zero: the
      // bucket column would print a row called `unknown` and a reader would trust it.
      drops.unreadableLadder = 1;
      ladder = undefined;
    }
  }
  const rows: ConditionRow[] = [];
  for (const row of cases) {
    if (row.passed !== false) continue;
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
    const bucket = ladder?.get(id);
    rows.push({
      id,
      missing: missingConditions(question.SQL, failure.predicted),
      stated: conditionsOf(question.SQL).length,
      ...(bucket === undefined ? {} : { bucket }),
    });
  }
  const tally = tallyConditions(rows);
  return {
    split: settings.layout.split,
    arm: settings.arm,
    scored: cases.length,
    rows,
    tally,
    drops,
    problems: conditionProblems(tally, drops),
  };
}

/**
 * What stops the reading being publishable.
 *
 * The share with a missing condition is a finding and a low one is a finding too, so it is not
 * a floor. What fails the build is the instrument losing its own inputs: a case the split
 * cannot name, or a ladder that was asked for and could not be read.
 */
export function conditionProblems(tally: ConditionTally, drops: ConditionDrops): string[] {
  const problems: string[] = [];
  if (drops.unknownQuestion > 0) {
    problems.push(`COND: ${String(drops.unknownQuestion)} failed cases name a question the split does not hold, so their conditions were never compared`);
  }
  if (drops.unreadableLadder > 0) {
    problems.push('COND: the ladder artifact was supplied and could not be read, so no case carries a bucket');
  }
  if (tally.total > 0 && tally.atoms === 0) {
    problems.push('COND: not one failure is missing a condition, which contradicts the corpus every other instrument reads');
  }
  return problems;
}

export function conditionLines(outcome: ConditionOutcome): string[] {
  const { tally } = outcome;
  const share = (count: number): string =>
    tally.total === 0 ? '0.0%' : `${((count / tally.total) * 100).toFixed(1)}%`;
  const lines = [
    `conditions ${outcome.split} · ${outcome.arm}: ${String(tally.total)} failures of ${String(outcome.scored)} scored`,
    `  no condition on a column the gold filters: ${String(tally.missingSome)}  ${share(tally.missingSome)}`,
    `  every gold condition written somewhere:   ${String(tally.missingNone)}  ${share(tally.missingNone)}`,
    `  missing conditions in total: ${String(tally.atoms)}`,
  ];
  const buckets = Object.entries(tally.byBucket).sort((left, right) => right[1].cases - left[1].cases);
  for (const [bucket, entry] of buckets) {
    lines.push(`  ${bucket.padEnd(16)} ${String(entry.cases).padStart(4)} cases, ${String(entry.missing).padStart(4)} missing a condition`);
  }
  for (const problem of outcome.problems) lines.push(`  FAILED ${problem}`);
  return lines;
}

export function conditionPath(settings: ConditionSettings): string {
  return join(settings.out, `conditions-${settings.arm.replace(/[^a-z0-9+_-]/gi, '-')}.json`);
}

export function writeConditionArtifact(settings: ConditionSettings, outcome: ConditionOutcome): string {
  const path = conditionPath(settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(outcome, null, 2)}\n`);
  return path;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): number {
  const settings = resolveConditionSettings(env, argv, root);
  const outcome = runConditions(settings);
  for (const line of conditionLines(outcome)) console.log(line);
  console.log(
    `  dropped: ${String(outcome.drops.unretained)} unretained, ${String(outcome.drops.unknownQuestion)} unknown question, ` +
      `${String(outcome.drops.unreadableLadder)} unreadable ladder`,
  );
  const path = writeConditionArtifact(settings, outcome);
  console.log(`\nwrote ${path}`);
  for (const problem of outcome.problems) console.error(problem);
  if (outcome.problems.length === 0) return 0;
  return settings.strict ? 1 : 0;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
