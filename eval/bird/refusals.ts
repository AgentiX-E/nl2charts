/**
 * What the engine refused, and what a rewrite would have bought.
 *
 * `bench:bird:residue` measures the `values` population — statements that ran and answered with
 * different rows — and its own predicate says so (`row.reason !== 'values'`). That predicate is why
 * this file exists: on the shipped arm's dev artifact the filter leaves **418 of 522** failures
 * inside the measurement and **104 outside it**, and those 104 have never been described anywhere.
 * A count is not a taxonomy, which is the lesson round 198 cost one dispatch to learn on Spider:
 * `predErrors: 185` said how much was lost and nothing about to whom, and splitting it into eight
 * classes turned a planned experiment into a refused one.
 *
 * ## The 104, split by the first check that failed rather than by a theory
 *
 * `76` carry `reason: 'column-count'`, and the first reading of that is "a projection defect". It
 * is not: **all 76 also return different rows**, so the artifact is reporting *the first check that
 * failed*, not a kind of failure — `classifyFailureShape` tests row count before arity and arity
 * before values. The class is therefore named `arity` here and reported beside `values`, because a
 * reader who takes the two as separate defects will count 494 wrong answers as two populations.
 *
 * `28` are refusals: the engine never returned rows at all. Splitting *those* is the useful work,
 * and the split is by the engine's own sentence, the same way `eval/spider/residue.ts` splits a
 * parser's:
 *
 * | the engine said | cases | what it means |
 * |---|---:|---|
 * | `no such column: X` | 21 | the statement names a column, and the column's home decides the fix |
 * | `no such function: YEAR` | 3 | MySQL's `YEAR()`; BIRD's own golds spell it `STRFTIME('%Y', …)` |
 * | `no such function: DATEDIFF` | 1 | the same dialect, and the corpus's own answer is not one rewrite |
 * | `interrupted` | 2 | the step budget, not a defect |
 * | `one statement at a time` | 1 | the reply held two statements |
 *
 * For the 21 names, where the column *lives* is the taxonomy, and it is decidable from the declared
 * corpus without a model: `name-misqualified` (a table the statement reads has it — the qualifier is
 * wrong), `name-not-joined` (a table the statement does **not** read has it — a join is missing) and
 * `name-nowhere` (no table in the database has it). The three call for opposite work: a re-qualifier,
 * a retry with another table, and nothing at all.
 *
 * ## Two repairs, and the line this file does not cross
 *
 * `requalify` rewrites `T2.School` to the alias of the one table the statement reads that owns
 * `School`. `year` rewrites `YEAR(x)` to `CAST(STRFTIME('%Y', x) AS INTEGER)` — BIRD's dialect, and
 * the cast is part of it: without the cast, `STRFTIME('%Y', x) = 1964` compares TEXT to INTEGER by
 * storage class and returns **no rows**, so a rewrite that parses may still empty the answer. That
 * defect was live in this round's first probe and one of the three date cases is what caught it.
 *
 * `name-not-joined` is **not** repaired. Adding the join would run, and it would be this file
 * inventing the relation the model failed to find — the Spider line, and the reason to hold it is
 * arithmetic: 17 cases at 0.78pp more than either repair is worth. It is reported instead, because
 * it is the largest mechanical defect on the shipped arm and the next round's trigger.
 *
 * ## The invariant
 *
 * A repair is attempted **only** on a statement the engine refused, so this instrument cannot lower
 * a reading: the accepted set is byte-identical to the one the artifact already judged, and the
 * difference between the two readings is exactly the refusals that became right. The result is that
 * the number is small and comparable: on the dev split the two rules reach 6 of 28 refusals, 4 run,
 * and **2 are right** — +0.13pp, against +2.13pp for the same exercise on Spider. The gap is the
 * judge, not the model: Spider's judge parses and BIRD's executes, so a spelling is worth what
 * sensitivity to spelling is worth, and on this corpus that is almost nothing.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SHIPPED_SQL } from '@agentix-e/nl2charts-ai';
import type { SqlRecipe } from '@agentix-e/nl2charts-ai';
import { judgeOfficial } from '@agentix-e/nl2charts-devkit';
import type { Tuple } from '@agentix-e/nl2charts-devkit';
import { loadQuestions, loadTables } from './data.js';
import type { BirdQuestion, BirdTable } from './data.js';
import { createOracle } from './oracle.js';
import type { Oracle } from './oracle.js';
import { layoutForSplit, resolveLayout } from './run.js';
import type { BirdLayout, DroppedCandidate } from './run.js';
import { qualifiedRefs, stringLiterals, tableRefs } from './statement.js';
import type { TableRef } from './statement.js';

/** The first check that failed, over the whole failure population. */
export const FAILURE_KINDS = ['values', 'arity', 'refused', 'unanswered'] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/**
 * What a refusal was, in the vocabulary of what a fix would be.
 *
 * The order is the order the report prints, and it is not alphabetical: the three ways a name can
 * be wrong come first, because they are the same sentence from the engine and three different
 * levers behind it.
 */
export const REFUSAL_CLASSES = [
  'name-misqualified',
  'name-not-joined',
  'name-nowhere',
  'date-function',
  'other-function',
  'step-budget',
  'statement-count',
  'other',
] as const;
export type RefusalClass = (typeof REFUSAL_CLASSES)[number];

/** The rule a class has, if it has one. A class with no rule is printed as an em dash. */
export type RepairRule = 'requalify' | 'year';

export const REFUSAL_RULES: Readonly<Record<RefusalClass, RepairRule | undefined>> = {
  'name-misqualified': 'requalify',
  'name-not-joined': undefined,
  'name-nowhere': undefined,
  'date-function': 'year',
  'other-function': undefined,
  'step-budget': undefined,
  'statement-count': undefined,
  other: undefined,
};

/** The one row of an artifact this tool reads, so a wider artifact still validates. */
export interface ArtifactCase {
  readonly arm: string;
  readonly id: string | number;
  readonly passed: boolean;
  readonly reason?: string;
  readonly errorKind?: string;
  readonly error?: string;
  readonly sql?: string;
  /**
   * The candidates this case lost, when the run kept them.
   *
   * Absent on an artifact written before the record existed, and the artifact-level
   * `candidateRecord` is what tells the two apart: this file may not read a silence as a zero.
   */
  readonly dropped?: readonly DroppedCandidate[];
}

/**
 * Which population a failed case belongs to.
 *
 * `row-count` is folded into `values` rather than given a row of its own: the residue tool measures
 * both (a different number of rows is the residue's whole subject), and a taxonomy that split them
 * here would disagree with the instrument that reads them there.
 *
 * The `errorKind` axis is wider than the two kinds this file was written against, and finding that
 * out cost one crash on the Mini-Dev split: `failureKindOf` knew `execution` and `other`, and a case
 * the *guard* refused (`guard: multiple-statements`) threw "failed without a reason or an error
 * kind" — a sentence that is true of the record and false of the run. The seven kinds the runner
 * writes are `execution`, `guard`, `llm`, `truncated`, `shape`, `harness` and `other`; the split
 * below is not a list of them but a rule about them, so an eighth cannot arrive as a crash.
 */
export function failureKindOf(row: ArtifactCase): FailureKind | 'passed' {
  if (row.passed) return 'passed';
  // A statement the engine refused and a statement the guard refused are one population here:
  // something was written, nothing ran, and the refusal has a sentence and a class. The guard's own
  // sentence (`multiple-statements`) is not the engine's, so the class comes out `other` until the
  // statement is replayed — and the replay is exactly what this branch licenses, because the guard
  // never let the engine speak.
  if (row.errorKind === 'execution' || row.errorKind === 'guard') return 'refused';
  // Everything else is "no usable statement came back": an endpoint that did not answer, an answer
  // the cap cut, a reply the parser could not read, a harness fault. None of them has a statement
  // to classify, and calling one of them a refusal would put an outage in the engine's column.
  if (row.errorKind !== undefined) return 'unanswered';
  if (row.reason === 'values' || row.reason === 'row-count') return 'values';
  if (row.reason === 'column-count') return 'arity';
  throw new Error(`case ${String(row.id)} of ${row.arm} failed without a reason or an error kind`);
}

/** What the engine's sentence says the fix is, before the schema is consulted. */
export type RefusalKind = 'name' | 'date-function' | 'other-function' | 'step-budget' | 'statement-count' | 'other';

export function refusalKindOf(message: string): RefusalKind {
  if (/no such (column|table)/iu.test(message)) return 'name';
  // `YEAR` is the one function whose BIRD spelling this repository can write, so it is separated
  // from the family before the family is counted: `DATEDIFF` is the same dialect and has no single
  // equivalent, which is a different answer to a reader deciding what to do next.
  if (/no such function:\s*year\b/iu.test(message)) return 'date-function';
  if (/no such function/iu.test(message)) return 'other-function';
  if (/interrupted/iu.test(message)) return 'step-budget';
  if (/one statement at a time/iu.test(message)) return 'statement-count';
  return 'other';
}

/** The name the engine could not resolve, split into a qualifier and a column. */
export function missingNameOf(message: string, sql?: string): { qualifier?: string; column: string } | undefined {
  const match = /no such (?:column|table):\s*(.+?)\s*$/iu.exec(message);
  if (match?.[1] === undefined) return undefined;
  const token = match[1];
  // Where the qualifier ends and the column begins is a property of the statement, not of the
  // message: SQLite strips the quotes from the name it reports, so `T2.`School`` arrives as
  // `T2.School` and a column that legitimately contains a dot would be split in the wrong place by
  // any rule that only looked at dots. The statement's own scanner already knows the boundary.
  if (sql !== undefined) {
    const found = qualifiedRefs(sql).find((ref) => `${ref.qualifier}.${ref.column}`.toLowerCase() === token.toLowerCase());
    if (found !== undefined) return { qualifier: found.qualifier, column: found.column };
  }
  const dot = token.lastIndexOf('.');
  return dot === -1 ? { column: token } : { qualifier: token.slice(0, dot), column: token.slice(dot + 1) };
}

/** A database's declared shape: what a name can be checked against without executing anything. */
export interface SchemaOf {
  readonly tables: readonly string[];
  columnsOf(table: string): readonly string[];
}

/** Where a name that the engine could not resolve actually lives. */
export type NameSite = 'read' | 'not-joined' | 'nowhere';

export function nameSiteOf(column: string, read: readonly string[], schema: SchemaOf): NameSite {
  const owners = schema.tables.filter((table) => schema.columnsOf(table).some((name) => name.toLowerCase() === column.toLowerCase()));
  if (owners.length === 0) return 'nowhere';
  const lower = new Set(read.map((table) => table.toLowerCase()));
  return owners.some((table) => lower.has(table.toLowerCase())) ? 'read' : 'not-joined';
}

/**
 * Re-qualify a name the engine refused, when exactly one table the statement reads owns it.
 *
 * Withheld in three cases, and each one is a different fact: the engine named no qualifier (a bare
 * name that does not exist is a vocabulary defect, not a qualifier one), no table or more than one
 * table the statement reads owns the column (the rewrite would be a guess), or the only owner is
 * already the qualifier the engine rejected (the engine is telling us the column is not there).
 *
 * The text is edited at its own offsets rather than re-rendered: a rewrite that reproduces the
 * statement from a parse tree has to be right about every other token as well, and this one only
 * has to be right about the qualifier.
 */
export function requalify(
  sql: string,
  missing: { readonly qualifier?: string; readonly column: string },
  refs: readonly TableRef[],
  schema: SchemaOf,
): string | undefined {
  if (missing.qualifier === undefined) return undefined;
  const owners = refs.filter((ref) => schema.columnsOf(ref.table).some((name) => name.toLowerCase() === missing.column.toLowerCase()));
  const owner = owners.length === 1 ? owners[0] : undefined;
  if (owner === undefined) return undefined;
  if (owner.alias.toLowerCase() === missing.qualifier.toLowerCase()) return undefined;
  const targets = qualifiedRefs(sql).filter(
    (ref) => ref.column.toLowerCase() === missing.column.toLowerCase() && ref.qualifier.toLowerCase() === (missing.qualifier as string).toLowerCase(),
  );
  if (targets.length === 0) return undefined;
  // A quoted alias stays quoted: `AS "T 1"` is a legal alias and writing it bare would not name it.
  const alias = /^[A-Za-z_][\w$]*$/u.test(owner.alias) ? owner.alias : `"${owner.alias.replace(/"/gu, '""')}"`;
  let out = sql;
  for (const target of [...targets].reverse()) {
    out = `${out.slice(0, target.start)}${alias}.${target.columnRaw}${out.slice(target.end)}`;
  }
  return out;
}

/**
 * `YEAR(x)` → `CAST(STRFTIME('%Y', x) AS INTEGER)`.
 *
 * The corpus's own spelling is `STRFTIME('%Y', x)` and the cast is this file's addition: SQLite
 * compares TEXT to INTEGER by storage class, so `STRFTIME('%Y', x) = 1964` is false for every row
 * while `CAST(… AS INTEGER) = 1964` is the comparison `YEAR(x) = 1964` made. Case `1188` is what
 * separates the two: without the cast the rewrite runs and answers nothing.
 *
 * Arguments are matched by balanced parentheses rather than by a regular expression, because the
 * argument is often `CURRENT_TIMESTAMP` or a nested call, and a literal inside it may hold a
 * parenthesis the scan must not count.
 */
export function yearToStrftime(sql: string): string {
  const literals = stringLiterals(sql);
  const inside = (index: number): boolean => literals.some((literal) => index >= literal.start && index < literal.end);
  const out: string[] = [];
  let at = 0;
  while (at < sql.length) {
    const rest = sql.slice(at);
    const match = /^year\s*\(/iu.exec(rest);
    if (match === null || inside(at)) {
      out.push(sql[at] as string);
      at += 1;
      continue;
    }
    let depth = 1;
    let index = at + match[0].length;
    while (index < sql.length && depth > 0) {
      if (inside(index)) {
        index += 1;
        continue;
      }
      const char = sql[index];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      index += 1;
    }
    // An unbalanced call is left exactly as it was: a rewrite of a statement this file cannot read
    // is a statement it should not be editing.
    if (depth > 0) {
      out.push(sql.slice(at));
      break;
    }
    const argument = sql.slice(at + match[0].length, index - 1);
    out.push(`CAST(STRFTIME('%Y', ${argument}) AS INTEGER)`);
    at = index;
  }
  return out.join('');
}

/** What one refusal turned out to be, and what the one rule for its class did. */
export interface RefusalRow {
  readonly id: string;
  readonly db: string;
  readonly message: string;
  readonly kind: RefusalKind;
  readonly refusal: RefusalClass;
  readonly rule?: RepairRule;
  readonly repaired?: string;
  readonly readable: boolean;
  readonly exact: boolean;
}

/** One row of the report: a class with the three counts that separate the questions it answers. */
export interface RefusalTally {
  readonly refusal: RefusalClass;
  readonly cases: number;
  /** Cases a rule was applied to. `cases - attempted` is the number the rule withheld. */
  readonly attempted: number;
  readonly readable: number;
  readonly exact: number;
}

export interface CensusDrops {
  readonly goldFailed: number;
  readonly unretained: number;
  readonly unknownQuestion: number;
  readonly otherArm: number;
}

export interface Census {
  readonly split: string;
  readonly arm: string;
  readonly asked: number;
  readonly passed: number;
  readonly kinds: Readonly<Record<FailureKind, number>>;
  readonly classes: readonly RefusalTally[];
  readonly rows: readonly RefusalRow[];
  readonly drops: CensusDrops;
  /**
   * The candidates that never reached the judge, which is a second population.
   *
   * A refusal happens at two levels and only one of them used to be in this file: a case whose
   * every candidate died is a `refused` case, and a case that lost one candidate and answered with
   * the other two is a `passed` case with a hole in its pool. The second is where
   * `select-mixed-rule`'s zero lived.
   */
  readonly candidates: DroppedCensus;
  readonly problems: readonly string[];
}

/**
 * The three counts per class, from the rows.
 *
 * `attempted` is separate from `cases` on purpose: a class whose rule withheld half its statements
 * is a class where the rule is too narrow, and a table that printed only `cases` and `exact` would
 * make that indistinguishable from a rule that fired and lost.
 */
export function tallyRefusals(rows: readonly RefusalRow[]): readonly RefusalTally[] {
  return REFUSAL_CLASSES.map((refusal) => {
    const mine = rows.filter((row) => row.refusal === refusal);
    return {
      refusal,
      cases: mine.length,
      attempted: mine.filter((row) => row.rule !== undefined).length,
      readable: mine.filter((row) => row.readable).length,
      exact: mine.filter((row) => row.exact).length,
    };
  });
}

export function censusProblems(census: Census): readonly string[] {
  const problems: string[] = [];
  // Two facts that look alike and are not. An arm the artifact never asked about was not measured,
  // and that is a statement about the dispatch rather than about the corpus: `main` prints it and
  // exits zero, because a dev dispatch is allowed to leave an arm out. An arm that was asked
  // 1,532 questions and refused none is a claim about the corpus that no reader should accept
  // without a second look, and that one fails the run.
  if (census.asked === 0) {
    problems.push(`REF: this artifact holds no case for ${census.arm}, so nothing was measured`);
  } else if (census.kinds.refused === 0) {
    // The three states this branch has to keep apart, and only the artifact can:
    //
    //   no candidate record           the run never looked, so a zero here is a silence
    //   kept, and it holds refusals   the refusals happened one level below the case, and they
    //                                 are counted in `candidates` rather than in `kinds`
    //   kept, and it holds none       a zero that was observed, which is a claim about the arm
    //
    // The first is what `select-mixed-rule` published for a hundred rounds, and it is still a
    // problem: the tool exists to classify refusals and it cannot classify a silence.
    if (!census.candidates.recorded) {
      problems.push(
        'REF: this artifact holds no refused case and keeps no candidate-level record, so the taxonomy measured nothing',
      );
    }
  }
  // Every engine refusal that a candidate carried has to land in a class, and the classes have to
  // account for all of them: a table that classified two of three would be a taxonomy over a
  // population it silently shrank. `llm` and `unparsed` are deliberately outside this identity —
  // they are mechanisms, not refusals, and no class may claim an outage.
  const classified = census.candidates.byClass.reduce((sum, row) => sum + row.dropped, 0);
  if (classified !== census.candidates.byStage.engine) {
    problems.push(
      `REF: ${String(classified)} candidate(s) classified against ${String(census.candidates.byStage.engine)} the engine refused`,
    );
  }
  if (classified + census.candidates.byStage.llm + census.candidates.byStage.unparsed !== census.candidates.dropped) {
    problems.push(
      `REF: ${String(census.candidates.dropped)} candidate(s) dropped against ${String(classified)} classified and ` +
        `${String(census.candidates.byStage.llm + census.candidates.byStage.unparsed)} by another mechanism`,
    );
  }
  // Every refusal is either classified or dropped for a reason the run printed, and the two
  // together have to be the artifact's own count. A census that dropped a refusal and did not say
  // so would report a taxonomy that adds up over a population it silently shrank.
  const counted = REFUSAL_CLASSES.reduce((sum, refusal) => sum + (census.classes.find((row) => row.refusal === refusal)?.cases ?? 0), 0);
  const dropped = census.drops.goldFailed + census.drops.unretained + census.drops.unknownQuestion;
  if (counted + dropped !== census.kinds.refused) {
    problems.push(
      `REF: ${String(counted)} classified + ${String(dropped)} dropped refusal(s) against ${String(census.kinds.refused)} in the artifact`,
    );
  }
  for (const row of census.classes) {
    if (row.exact > row.readable || row.readable > row.attempted) {
      problems.push(`REF: ${row.refusal} reads exact ${String(row.exact)} of readable ${String(row.readable)} of attempted ${String(row.attempted)}`);
    }
  }
  const failures = census.asked - census.passed;
  const kinds = FAILURE_KINDS.reduce((sum, kind) => sum + census.kinds[kind], 0);
  if (kinds !== failures) {
    problems.push(`REF: ${String(kinds)} failure(s) in the taxonomy against ${String(failures)} in the artifact`);
  }
  return problems;
}

const REPAIRABLE = new Set<RefusalClass>(REFUSAL_CLASSES.filter((refusal) => REFUSAL_RULES[refusal] !== undefined));

export function censusLines(census: Census): readonly string[] {
  const lines = [
    `refusals: ${String(census.asked)} asked, ${String(census.passed)} passed, ${String(census.asked - census.passed)} failed ` +
      `(${FAILURE_KINDS.map((kind) => `${kind} ${String(census.kinds[kind])}`).join(', ')})`,
    '  class              cases  rule        tried  runs  right',
  ];
  for (const row of census.classes) {
    lines.push(
      `  ${row.refusal.padEnd(18)}${String(row.cases).padStart(5)}  ${(REFUSAL_RULES[row.refusal] ?? '—').padEnd(10)}` +
        `${String(row.attempted).padStart(6)}${String(row.readable).padStart(6)}${String(row.exact).padStart(7)}`,
    );
  }
  const withRule = census.classes.filter((row) => REPAIRABLE.has(row.refusal) && row.attempted > 0);
  const tried = withRule.reduce((sum, row) => sum + row.attempted, 0);
  const runs = withRule.reduce((sum, row) => sum + row.readable, 0);
  const right = withRule.reduce((sum, row) => sum + row.exact, 0);
  lines.push(`  two rules reach ${String(tried)} statement(s): ${String(runs)} run, ${String(right)} right`);
  // The rule is not repeated here: the table above already says which rule each class has, and a
  // line that named it again would be a second place for the mapping to disagree with itself.
  for (const row of census.rows.filter((entry) => entry.readable && !entry.exact).slice(0, 5)) {
    lines.push(`  ran and answered wrong: #${row.id} ${row.refusal}`);
  }
  for (const row of census.rows.filter((entry) => entry.refusal === 'name-not-joined').slice(0, 3)) {
    lines.push(`  a join away, not a spelling: #${row.id} ${row.message}`);
  }
  // The second population. A refusal below the case is the one this table could not see, and the
  // distinction it carries is not cosmetic: a case that lost a candidate and answered anyway is a
  // `passed` case in every other reading of this artifact.
  if (!census.candidates.recorded) {
    lines.push('  candidates: this artifact keeps no record of what it dropped, so a silence here is not a zero');
    return lines;
  }
  lines.push('  candidates        dropped  with stmt');
  for (const row of census.candidates.byClass) {
    if (row.dropped === 0) continue;
    lines.push(`  ${row.refusal.padEnd(18)}${String(row.dropped).padStart(5)}${String(row.withStatement).padStart(11)}`);
  }
  lines.push(
    `  ${String(census.candidates.dropped)} candidate(s) dropped of ${String(census.asked)} case(s): ` +
      `${String(census.candidates.byStage.engine)} the engine refused, ${String(census.candidates.byStage.llm)} never arrived, ` +
      `${String(census.candidates.byStage.unparsed)} unreadable`,
  );
  return lines;
}

export interface RefusalSettings {
  readonly root: string;
  readonly artifact: string;
  readonly arm: string;
  readonly layout: BirdLayout;
}

/**
 * The arm whose refusals a bare run measures: the one the product sends, not a favourite.
 *
 * Read from the shipped recipe rather than written here, so the instrument and the product cannot
 * disagree about which arm is being described. Resolved by a function rather than at module load
 * because the recipe's `arm` is optional — the assembled skeleton is a fallback, not a benchmark
 * arm — and a name that had to be invented here would be a name this file made up.
 */
export function defaultRefusalArm(recipe: SqlRecipe = SHIPPED_SQL): string {
  const arm = recipe.arm;
  if (arm === undefined) throw new Error('REF: the shipped recipe names no arm, so a bare run has nothing to measure');
  return arm;
}

export function resolveRefusalSettings(
  argv: readonly string[],
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): RefusalSettings {
  const takesValue = new Set(['--artifact', '--arm']);
  let artifact: string | undefined;
  let arm: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!takesValue.has(token)) throw new Error(`unrecognized argument ${token}: this harness takes --artifact <path> and --arm <name>`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
    if (token === '--artifact') artifact = value;
    else arm = value;
    index += 1;
  }
  const layout = resolveLayout(env, root);
  return { root, artifact: artifact ?? layout.out, arm: arm ?? defaultRefusalArm(), layout };
}

/** Where the census of one arm on one split goes. Named for both, so neither overwrites the other. */
export function refusalsPath(settings: { readonly root: string; readonly arm: string; readonly split: string }): string {
  const safe = settings.arm.replace(/[^a-z0-9+-]/gi, '_');
  return join(settings.root, 'eval', 'out', `refusals-${safe}-${settings.split}.json`);
}

/** The declared shape of one database, read from `dev_tables.json` rather than from the file. */
export function schemaFrom(table: BirdTable | undefined): SchemaOf {
  if (table === undefined) return { tables: [], columnsOf: () => [] };
  const byTable = new Map<string, string[]>();
  for (const name of table.tableNames) byTable.set(name.toLowerCase(), []);
  for (const [index, column] of table.columnNames) {
    // Column zero of a BIRD manifest is the `*` row every table carries; it belongs to no table and
    // a name check that read it as one would report every column as existing.
    if (index < 0) continue;
    const owner = table.tableNames[index];
    if (owner === undefined) continue;
    byTable.get(owner.toLowerCase())?.push(column);
  }
  return {
    tables: [...byTable.keys()],
    columnsOf: (name) => byTable.get(name.toLowerCase()) ?? [],
  };
}

/**
 * Everything that can be decided about a refusal without running anything.
 *
 * Two readers now share this: the case-level census, which classifies the statement a case gave up
 * on, and the candidate-level one, which classifies a member that was dropped while the case still
 * answered. Neither may disagree about what a class means — a `name-not-joined` read off the
 * winner's statement and a `name-not-joined` read off the dropped candidate's are the same finding,
 * and a second copy of these four lines would be a second taxonomy with the first one's name.
 *
 * `refs` is returned rather than recomputed because the repair needs the same list the site was
 * decided from: a `requalify` that scanned the statement twice could re-qualify against a table the
 * classification did not see.
 */
export interface MessageReading {
  readonly kind: RefusalKind;
  readonly refusal: RefusalClass;
  readonly missing?: { readonly qualifier?: string; readonly column: string };
  readonly refs: readonly TableRef[];
}

export function classifyMessage(message: string, sql: string | undefined, schema: SchemaOf): MessageReading {
  const kind = refusalKindOf(message);
  const refs = sql === undefined ? [] : tableRefs(sql);
  const missing = missingNameOf(message, sql);
  let refusal: RefusalClass;
  if (kind === 'name') {
    // A name with no `no such column: X` tail is a sentence this taxonomy cannot site, and `other`
    // says that rather than guessing a home for it.
    if (missing === undefined) refusal = 'other';
    else {
      const site = nameSiteOf(missing.column, refs.map((ref) => ref.table), schema);
      refusal = site === 'read' ? 'name-misqualified' : site === 'not-joined' ? 'name-not-joined' : 'name-nowhere';
    }
  } else {
    refusal = kind;
  }
  return { kind, refusal, ...(missing === undefined ? {} : { missing }), refs };
}

/**
 * One dropped candidate, classified.
 *
 * The statement is what a later turn would rewrite and the class is what it would do, so both are
 * kept: a table of classes with no statements says how many and not which, and a list of statements
 * with no classes says which and not what to do.
 */
export interface DroppedRow {
  readonly id: string;
  readonly refusal: RefusalClass;
  /** The engine's or the guard's own words, when the loss carried any. */
  readonly message?: string;
  /** The statement that was refused, when one was written before the refusal. */
  readonly sql?: string;
  readonly source?: string;
}

/** One class of dropped candidate: how many, and how many of those carry a rewritable statement. */
export interface DroppedTally {
  readonly refusal: RefusalClass;
  readonly dropped: number;
  readonly withStatement: number;
}

/**
 * What an artifact kept about the candidates that never reached the judge.
 *
 * `recorded` is the field the rest of this file reads before it reads any number, because an
 * artifact without the record and an artifact with an empty one are the same shape and different
 * facts: the first is a run that never looked, the second is a run that looked and found nothing.
 * Publishing the second as the first is how `select-mixed-rule`'s zero survived a hundred rounds.
 */
export interface DroppedCensus {
  readonly recorded: boolean;
  readonly dropped: number;
  /** By mechanism, in the same three words `candidateFailures` counts. */
  readonly byStage: Readonly<Record<'llm' | 'engine' | 'unparsed', number>>;
  /**
   * By class, over the engine refusals only.
   *
   * An endpoint that did not answer is not a refusal and no class may claim it: the repair is a key
   * or a deadline, and there is no statement to rewrite. Counting it under `other` would put an
   * outage in the same column as a guard that refused a write, which are two different next steps.
   */
  readonly byClass: readonly DroppedTally[];
  readonly rows: readonly DroppedRow[];
}

export function tallyDropped(rows: readonly DroppedRow[]): readonly DroppedTally[] {
  return REFUSAL_CLASSES.map((refusal) => {
    const mine = rows.filter((row) => row.refusal === refusal);
    return {
      refusal,
      dropped: mine.length,
      withStatement: mine.filter((row) => row.sql !== undefined).length,
    };
  });
}

/**
 * Read the kept candidates of one arm.
 *
 * `schemaOf` is asked per case rather than once, because the site of a missing name is a property of
 * the database the statement was run against and a split holds eleven of them.
 */
export function droppedCensus(
  body: { readonly candidateRecord?: string; readonly cases: readonly ArtifactCase[] },
  arm: string,
  schemaOf: (row: ArtifactCase) => SchemaOf,
): DroppedCensus {
  const byStage = { llm: 0, engine: 0, unparsed: 0 };
  const rows: DroppedRow[] = [];
  let dropped = 0;
  let recorded = body.candidateRecord === 'kept';
  for (const row of body.cases) {
    if (row.arm !== arm) continue;
    // Any case that carries the field is evidence the run kept them, even on an artifact whose
    // marker was written by a runner that had not yet learned to write it: the field cannot exist
    // otherwise, and refusing to read it would discard the only record there is.
    if (row.dropped !== undefined) recorded = true;
    for (const entry of row.dropped ?? []) {
      dropped += 1;
      byStage[entry.stage] += 1;
      // Only an engine refusal has a class. `llm` and `unparsed` are counted above and classified
      // here as nothing, which is the difference between "the engine said no" and "nothing came".
      if (entry.stage !== 'engine') continue;
      const message = entry.message ?? '';
      const reading = classifyMessage(message, entry.sql, schemaOf(row));
      rows.push({
        id: String(row.id),
        refusal: reading.refusal,
        ...(entry.message === undefined ? {} : { message }),
        ...(entry.sql === undefined ? {} : { sql: entry.sql }),
        ...(entry.source === undefined ? {} : { source: entry.source }),
      });
    }
  }
  return { recorded, dropped, byStage, byClass: tallyDropped(rows), rows };
}

/**
 * Classify one refusal and run the rule its class has, against the corpus's own declarations.
 *
 * The repaired statement is executed only when a rule produced one. `exact` is the official judge's
 * verdict on the repair's rows against the gold's — the same function that produced the artifact's
 * own `reason`, so "the repair was right" and "the case passed" are one definition.
 */
export async function classifyRefusal(
  entry: { readonly id: string; readonly db: string; readonly message: string; readonly sql: string; readonly gold: string },
  deps: { readonly oracle: Oracle; readonly schema: SchemaOf },
): Promise<RefusalRow> {
  // The class, the site and the table list all come from the one reading the candidate-level
  // census also uses. Recomputing any of them here would let the two levels disagree about what a
  // class means, and the repair below edits the same token list the site was decided from.
  const { kind, refusal, missing, refs } = classifyMessage(entry.message, entry.sql, deps.schema);
  const base = { id: entry.id, db: entry.db, message: entry.message, kind, refusal };
  const rule = REFUSAL_RULES[refusal];
  let repaired: string | undefined;
  if (rule === 'requalify') {
    if (missing !== undefined && missing.qualifier !== undefined) {
      repaired = requalify(entry.sql, { qualifier: missing.qualifier, column: missing.column }, refs, deps.schema);
    }
  } else if (rule === 'year') {
    const rewritten = yearToStrftime(entry.sql);
    if (rewritten !== entry.sql) repaired = rewritten;
  }
  if (repaired === undefined || repaired === entry.sql) return { ...base, readable: false, exact: false };
  const run = await deps.oracle.run(entry.db, repaired);
  if (!run.ok) return { ...base, rule, repaired, readable: false, exact: false };
  const gold = await deps.oracle.run(entry.db, entry.gold);
  if (!gold.ok) return { ...base, rule, repaired, readable: true, exact: false };
  const verdict = judgeOfficial(gold.rows as readonly Tuple[], run.rows as readonly Tuple[]);
  return { ...base, rule, repaired, readable: true, exact: verdict === 'match' };
}

/** The full census of one artifact and one arm. */
export async function runCensus(
  settings: RefusalSettings,
  deps: { readonly oracle?: Oracle; readonly questions?: readonly BirdQuestion[]; readonly tables?: ReadonlyMap<string, BirdTable> } = {},
): Promise<Census> {
  const body = JSON.parse(readFileSync(settings.artifact, 'utf8')) as {
    readonly split?: string;
    readonly candidateRecord?: string;
    readonly cases: readonly ArtifactCase[];
  };
  const layout = layoutForSplit(body.split, settings.layout, settings.root);
  const questions = deps.questions ?? loadQuestions(layout.questionsFile);
  const tables = deps.tables ?? loadTables(layout.tablesFile);
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));
  const oracle = deps.oracle ?? createOracle(layout.oracleScript, layout.databaseRoot);
  const kinds: Record<FailureKind, number> = { values: 0, arity: 0, refused: 0, unanswered: 0 };
  const drops = { goldFailed: 0, unretained: 0, unknownQuestion: 0, otherArm: 0 };
  const rows: RefusalRow[] = [];
  let asked = 0;
  let passed = 0;
  try {
    for (const row of body.cases) {
      if (row.arm !== settings.arm) {
        drops.otherArm += 1;
        continue;
      }
      asked += 1;
      const kind = failureKindOf(row);
      if (kind === 'passed') {
        passed += 1;
        continue;
      }
      kinds[kind] += 1;
      // The one place a repair can happen, and it is inside the branch that already knows the
      // engine refused: a statement that ran is never edited, which is why this reading cannot fall.
      if (kind !== 'refused') continue;
      const question = byId.get(String(row.id));
      if (question === undefined) {
        drops.unknownQuestion += 1;
        continue;
      }
      if (typeof row.sql !== 'string' || row.sql.trim() === '') {
        drops.unretained += 1;
        continue;
      }
      const gold = await oracle.run(question.db_id, question.SQL);
      if (!gold.ok) {
        drops.goldFailed += 1;
        continue;
      }
      rows.push(
        await classifyRefusal(
          { id: String(row.id), db: question.db_id, message: row.error ?? '', sql: row.sql, gold: question.SQL },
          { oracle, schema: schemaFrom(tables.get(question.db_id)) },
        ),
      );
    }
  } finally {
    if (deps.oracle === undefined) await oracle.close();
  }
  const census: Census = {
    split: layout.split,
    arm: settings.arm,
    asked,
    passed,
    kinds,
    classes: tallyRefusals(rows),
    rows,
    drops,
    // The schema is asked for by case, because the site of a missing name is a property of the
    // database the statement ran against and a split holds eleven of them. A name absent from the
    // question list is sited against nothing, which makes it `name-nowhere` — the honest answer for
    // a case this artifact cannot resolve, and the same answer the case-level path gives.
    candidates: droppedCensus(body, settings.arm, (row) => schemaFrom(tables.get(byId.get(String(row.id))?.db_id ?? ''))),
    problems: [],
  };
  return { ...census, problems: censusProblems(census) };
}

export function writeRefusalArtifact(settings: RefusalSettings, census: Census): string {
  const path = refusalsPath({ root: settings.root, arm: census.arm, split: census.split });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(census, null, 2)}\n`);
  return path;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
  log: (line: string) => void = console.log,
): Promise<number> {
  const settings = resolveRefusalSettings(argv, root, env);
  const census = await runCensus(settings);
  const path = writeRefusalArtifact(settings, census);
  log(`refusals · ${census.arm} · ${census.split}`);
  for (const line of censusLines(census)) log(line);
  log(
    `  dropped: ${String(census.drops.goldFailed)} gold refused, ${String(census.drops.unretained)} without a statement, ` +
      `${String(census.drops.unknownQuestion)} unknown question`,
  );
  log(`  written to ${path}`);
  for (const problem of census.problems) log(`  ${problem}`);
  // An artifact that never asked this arm is not a defect in the artifact, so the line is printed
  // and the exit is zero: a measurement nobody took is not a failed measurement.
  return census.problems.length === 0 || census.asked === 0 ? 0 : 1;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
