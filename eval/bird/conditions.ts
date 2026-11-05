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

/**
 * What a missing condition actually is, once its literal is looked for elsewhere.
 *
 * `missingConditions` compares *columns*, and a column is not the only way to express a
 * restriction. On BIRD's dev split 41% of the conditions this reader calls missing are not
 * missing at all: the value is written, under a different column. `Contra Costa` filtered on
 * `schools.County` where the gold filters `satscores.cname`; `Kacey Gibson` split across
 * `AdmFName1` and `AdmLName1` where the gold has one name column. Reading both as "the
 * statement never considered this column" over-counts the population a repair could act on by
 * two thirds, and every lever aimed at that population inherits the error.
 *
 * So a missing condition is filed by where its value went:
 *
 * - **`substituted`** — some predicate of the statement compares the same literal against another
 *   column. The restriction is present; the column is not the one the gold used. A mechanism for
 *   this is schema linking, and a mechanism that writes the condition *again* would be adding a
 *   filter the statement already has.
 * - **`absent`** — no predicate compares anything to that literal. This is the population the
 *   census was written for: the value the question names never reaches the statement.
 * - **`unstated`** — the atom carries no literal at all, because it is a null test
 *   (`x IS NOT NULL`) or a comparison between two columns. Nothing in the question's wording
 *   could have pointed at it, so no question-side trigger can find it either.
 */
export type GapKind = 'substituted' | 'absent' | 'unstated';

export interface ConditionGap {
  /** The gold atom, as the reader printed it. */
  readonly atom: string;
  readonly kind: GapKind;
}

/**
 * The values an atom compares against, lowercased, unquoted, `''` unescaped.
 *
 * Numbers are read outside string literals only: `'2000'` is the value two-thousand and `2000` is
 * the same value written as a number, and the two have to match or a date filter would read as
 * substituted on one side and absent on the other depending on which side quoted it.
 */
export function literalsOf(atom: string): string[] {
  const found: string[] = [];
  // The capture group is inside the pattern, so it is always present when the pattern matched.
  for (const match of atom.matchAll(/'((?:''|[^'])*)'/g)) found.push((match[1] as string).replaceAll("''", "'").toLowerCase());
  // Quoted identifiers are removed too, not only literals: `"Free Meal Count (K-12)" > 0` contains
  // the digits of a name, and reading `12` as a value would make every column with a number in its
  // title look like a condition some statement had already written.
  const code = atom.replace(/'(?:''|[^'])*'/g, ' ').replace(/"[^"]*"/g, ' ').replace(/`[^`]*`/g, ' ');
  for (const match of code.matchAll(/(?<![\w.])(-?\d+(?:\.\d+)?)(?![\w.])/g)) found.push(match[1] as string);
  return [...new Set(found)];
}

/** The values a statement's predicates compare against, in the same form. */
export function writtenLiterals(written: readonly string[]): Set<string> {
  const values = new Set<string>();
  for (const atom of written) for (const literal of literalsOf(atom)) values.add(literal);
  return values;
}

/** Where a condition's value went. */
export function gapKindOf(atom: string, values: ReadonlySet<string>): GapKind {
  const literals = literalsOf(atom);
  if (literals.length === 0) return 'unstated';
  return literals.some((literal) => values.has(literal)) ? 'substituted' : 'absent';
}

/** Every condition of the gold the statement never names a column of, with where its value went. */
export function missingGaps(gold: string, predicted: string): ConditionGap[] {
  const written = conditionsOf(predicted);
  const values = writtenLiterals(written);
  return conditionsOf(gold)
    .filter((atom) => !hasCounterpart(atom, written))
    .map((atom) => ({ atom, kind: gapKindOf(atom, values) }));
}

/** The gold's conditions that the prediction never names a column of, in the reader's order. */
export function missingConditions(gold: string, predicted: string): string[] {
  const written = conditionsOf(predicted);
  return conditionsOf(gold).filter((atom) => !hasCounterpart(atom, written));
}

/** The tables each column name is declared on, and the columns each table declares. */
export interface SchemaIndex {
  /** Column name, lowercased, to the tables that declare it: one name can live on several. */
  readonly owners: ReadonlyMap<string, ReadonlySet<string>>;
  /** Table name, lowercased, to the columns it declares. */
  readonly columnsOf: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Which table every column of a database belongs to, keyed by database.
 *
 * A column name is not unique across a schema — `county` exists on `schools` and on `frpm` — so the
 * question "was the value compared on the same table" cannot be answered by the name alone. BIRD's
 * table file carries columns as `[tableOrdinal, columnName]`, which is exactly this map, and both
 * directions are built from it because both questions get asked: which tables hold this column, and
 * does this table hold this column at all.
 */
export function schemaIndex(tables: ReadonlyMap<string, { readonly tableNames: readonly string[]; readonly columnNames: readonly (readonly [number, string])[] }>): Map<string, SchemaIndex> {
  const out = new Map<string, SchemaIndex>();
  for (const [db, table] of tables) {
    const owners = new Map<string, Set<string>>();
    const columnsOf = new Map<string, Set<string>>();
    for (const [ordinal, name] of table.columnNames) {
      const tableName = table.tableNames[ordinal];
      if (tableName === undefined) continue;
      const column = name.toLowerCase();
      const owner = tableName.toLowerCase();
      owners.set(column, (owners.get(column) ?? new Set<string>()).add(owner));
      columnsOf.set(owner, (columnsOf.get(owner) ?? new Set<string>()).add(column));
    }
    out.set(db.toLowerCase(), { owners, columnsOf });
  }
  return out;
}

export type LinkLevel = 'same-table' | 'other-table' | 'nowhere' | 'unresolved';

export function linkLevelOf(
  atom: string,
  written: readonly string[],
  schema: SchemaIndex | undefined,
  tables: readonly string[] = [],
): LinkLevel {
  if (schema === undefined) return 'unresolved';
  const literals = literalsOf(atom);
  const column = atomIdentifiers(atom).map((token) => token.split('.').pop() as string)[0];
  if (literals.length === 0 || column === undefined) return 'unresolved';
  // Where each of the atom's values is compared: a predicate that names the value, whatever column it
  // names. This is the same test `gapKindOf` uses to call a condition `substituted`, so a case this
  // function calls `nowhere` can never have been called `substituted`.
  const sites = written.filter((other) => {
    const theirs = literalsOf(other);
    return literals.some((literal) => theirs.includes(literal));
  });
  if (sites.length === 0) return 'nowhere';
  const holders = schema.owners.get(column.toLowerCase());
  if (holders === undefined) return 'unresolved';
  // Qualified identifiers only: an unqualified `county = 'x'` cannot be placed on a table without
  // re-parsing the statement's FROM clause, and a reader that guessed would be inventing the very
  // distinction this function exists to measure.
  let qualified = false;
  for (const site of sites) {
    for (const token of atomIdentifiers(site)) {
      const [table, name] = token.split('.');
      if (name === undefined || table === undefined) continue;
      qualified = true;
      if (holders.has(table.toLowerCase())) return 'same-table';
    }
  }
  if (qualified) return 'other-table';
  // A statement that reads one table is not ambiguous about a column that table declares, and most
  // single-table statements never qualify anything: `where county = 'x'` is `schools.county` when
  // `schools` is all the statement reads. Two conditions, and both are checked: exactly one table,
  // and the column really is one of its own. An unqualified name the table does not declare is not
  // placed on it — that would be inventing the distinction this function exists to measure.
  if (tables.length === 1) {
    const only = (tables[0] as string).toLowerCase();
    const declared = schema.columnsOf.get(only);
    const named = sites.flatMap((site) =>
      atomIdentifiers(site)
        .filter((token) => !token.includes('.'))
        .map((token) => token.toLowerCase()),
    );
    if (declared === undefined || !named.some((token) => declared.has(token))) return 'unresolved';
    return holders.has(only) ? 'same-table' : 'other-table';
  }
  return 'unresolved';
}

/**
 * The columns a statement filters on, lowercased and deduplicated in statement order.
 *
 * The census counts the cases; this names the columns. Two consumers read the same population and
 * they have to agree about what it is, which is why this is the same reader the census uses rather
 * than a second one: the arm that shows stored values on the filtered columns and the instrument
 * that reports how many statements never mention one would otherwise be describing two sets, and
 * a delta priced against one of them would be attributed to the other.
 *
 * Identifiers only. A literal is what a statement got wrong; a column is what it never
 * considered — and BIRD's gold spells values that look like column names.
 */
export function conditionColumns(sql: string): string[] {
  const found = new Set<string>();
  for (const atom of conditionsOf(sql)) {
    for (const token of atomIdentifiers(atom)) found.add(token.toLowerCase());
  }
  return [...found];
}

/** One case's reading. */
export interface ConditionRow {
  readonly id: string;
  /** Conditions the prediction names no column of. */
  readonly missing: readonly string[];
  /** The same conditions, filed by where their value went. */
  readonly gaps: readonly ConditionGap[];
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
  /** Missing conditions whose value another predicate already compares against. */
  readonly substituted: number;
  /** Missing conditions whose value appears in no predicate at all. */
  readonly absent: number;
  /** Missing conditions that carry no literal, so no question wording could have named them. */
  readonly unstated: number;
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
    substituted: rows.filter((row) => row.gaps.some((gap) => gap.kind === 'substituted')).length,
    absent: rows.filter((row) => row.gaps.some((gap) => gap.kind === 'absent')).length,
    unstated: rows.filter((row) => row.gaps.some((gap) => gap.kind === 'unstated')).length,
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
  const layout = resolveLayout(withDeclaredSplit(env, declaredSplitOf(path)), root);
  return {
    report: path,
    layout,
    arm: named ?? SHIPPED_ARM,
    ...(ladder === undefined ? {} : { ladder }),
    out: dirname(layout.out),
    strict: argv.includes('--strict'),
  };
}

/**
 * The split an artifact says it was measured on, when it says one this repository knows.
 *
 * The census compares a prediction against the gold of *this* artifact's split, so the split is
 * an input to read rather than a default to assume. Read against the wrong file the numbers are
 * not a weaker reading but a different one: a 600-case dev artifact read against mini-dev's 500
 * questions reported 136 cases that "name a question the split does not hold" and compared the
 * remaining 464 against whatever mini-dev happened to hold at that id. It failed loudly under
 * `--strict`, which is how it was found - but a tool that is only ever run on one split in CI had
 * no way to notice, and the next reader would have had to know that.
 */
export function declaredSplitOf(report: string): string | undefined {
  try {
    const body = JSON.parse(readFileSync(report, 'utf8')) as { split?: unknown };
    return body.split === 'dev' || body.split === 'minidev' ? body.split : undefined;
  } catch {
    return undefined;
  }
}

/** The environment wins when it names a split: a reader may want the other file on purpose. */
function withDeclaredSplit(
  env: Record<string, string | undefined>,
  declared: string | undefined,
): Record<string, string | undefined> {
  return env.BIRD_SPLIT === undefined && declared !== undefined ? { ...env, BIRD_SPLIT: declared } : env;
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
    const gaps = missingGaps(question.SQL, failure.predicted);
    rows.push({
      id,
      missing: gaps.map((gap) => gap.atom),
      gaps,
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
    `  of which written on another column: ${String(tally.substituted)}  ${share(tally.substituted)}`,
    `  of which written nowhere:           ${String(tally.absent)}  ${share(tally.absent)}`,
    `  of which carry no literal at all:   ${String(tally.unstated)}  ${share(tally.unstated)}`,
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
