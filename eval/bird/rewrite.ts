/**
 * What a deterministic rewrite of the statement is worth, priced by re-execution.
 *
 * Every lever in this repository so far has been a *decision*: another call, another candidate, a
 * different prompt. Each of them costs something and each of them was measured against a paired
 * baseline. There is a third kind that has never been priced here because it has nothing to
 * score until it is run: a rewrite of the statement that follows from the engine's semantics
 * rather than from the model's judgment. It costs no call, no token and no candidate, and it can
 * therefore be adopted on a rule that is unavailable to anything that spends — it must not lose.
 *
 * The three rules below are the ones this project can state with certainty:
 *
 * 1. **`null-order`** — an ascending sort that carries a row cap puts unknown values first in
 *    SQLite and MySQL, so a question asking for "the lowest score" is answered by the school whose
 *    score is missing. `IS NULL` in front of the sort key is the statement the question meant.
 *    This is the rule the product ships (`guardNullOrder` in the AI package); this harness is how
 *    it was priced and how a future engine-specific variant will be priced.
 * 2. **`drop-limit-on-count`** — the reverse suspicion: a row cap left in a statement whose
 *    question asks "how many". It is here because the suspicion is wrong, and a rule that is
 *    wrong at 1,532 questions is worth one line of code that says so: it fires 35 times, wins 1
 *    and loses 19. The loss is not noise. "How many students does the school with the highest
 *    score have" contains the phrase; the cap is what makes the statement correct.
 * 3. **`integer-division`** — two integer columns divided in SQLite truncate, so a rate computed
 *    as `a / b` is zero for every ratio below one. The rewrite multiplies the numerator by 1.0.
 *    It fires 17 times on dev and changes nothing: the statements that divide already write
 *    `* 1.0` or `CAST`, because that is the failure their author could see.
 *
 * ## The reading is only publishable if the baseline reconciles
 *
 * Re-execution is a second judge, and a second judge that disagrees with the first is not a
 * reading — it is a bug in one of them. So the harness recomputes every case's verdict from the
 * statement the artifact recorded, and requires the pass count to equal the arm's published count
 * exactly. When the two disagree it prints both numbers and refuses, the same discipline
 * `bench:bird:consensus` applies to its own totals: a rewrite priced against a baseline that
 * cannot reproduce the score would be a difference between two instruments, not between two
 * statements.
 *
 * ## What it does not do
 *
 * It does not rewrite the answer a model wrote into a statement it did not write, and it does not
 * try several rewrites in sequence: every rule is priced alone against the same baseline, so the
 * numbers add up only if they fire on disjoint cases — which the report prints rather than
 * assumes. It also does not decide that a rule is good because it wins: the win count is printed
 * next to the loss count and beside the split's resolution, because 6 wins in 1,532 questions is
 * 0.39pp and no instrument here is allowed to call that a gain on its own.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mcnemarExact, pairedResolution } from '@agentix-e/nl2charts-devkit';
import type { MatchReason } from '@agentix-e/nl2charts-devkit';
import { guardNullOrder } from '@agentix-e/nl2charts-ai';
import { loadQuestions, loadTables } from './data.js';
import type { BirdQuestion } from './data.js';
import { resolveLayout } from './run.js';

/** One case, as the artifact recorded it: the question, the statement, and the verdict. */
export interface RewriteCase {
  readonly id: string;
  readonly question: BirdQuestion;
  /** The statement the arm actually executed. */
  readonly sql: string;
  /** What the run said about it, which the re-execution has to reproduce. */
  readonly declared: boolean;
}

export interface RewriteInput {
  readonly question: string;
  readonly sql: string;
  /** Column type by lowercased bare name and by `table.name`, when the split supplies one. */
  readonly typeOf?: (name: string) => string | undefined;
}

export interface RewriteRule {
  readonly name: string;
  /** What the rule claims, in one line, printed beside its reading. */
  readonly claim: string;
  /** The rewritten statement, or `undefined` when the rule does not apply. */
  readonly apply: (input: RewriteInput) => string | undefined;
}

/** Division by an integer column truncates in SQLite and PostgreSQL alike. */
function integerDivision(input: RewriteInput): string | undefined {
  if (input.typeOf === undefined) return undefined;
  if (/\*\s*1\.0|1\.0\s*\*|as\s+real|cast\s*\(/i.test(input.sql)) return undefined;
  let changed = false;
  // The statement is split at its literals so a value like `'a/b'` is never read as arithmetic.
  const parts = input.sql.split(/('(?:''|[^'])*')/g);
  const rewritten = parts.map((part) => {
    if (part.startsWith("'")) return part;
    return part.replace(
      /(\([^()]*\)|\b(?:sum|count|avg|max|min|total)\s*\([^()]*\)|\b[\w."`[\]]+)\s*\//gi,
      (whole, left: string) => {
        const bare = left.replace(/["`[\]]/g, '').trim();
        const kind = /^(?:sum|count)\s*\(/i.test(bare) ? 'INTEGER' : (input.typeOf?.(bare) ?? '');
        if (!/int|bigint|smallint/i.test(kind)) return whole;
        changed = true;
        return `(${left.trim()}) * 1.0 /`;
      },
    );
  });
  return changed ? rewritten.join('') : undefined;
}

/**
 * The rules, in the order the report prints them: the one that ships first, then the two the
 * suspicion produced and the measurement refused.
 */
export const REWRITE_RULES: readonly RewriteRule[] = [
  {
    name: 'null-order',
    claim: 'an ascending sort behind a row cap must not let unknown values win',
    apply: (input) => guardNullOrder(input.sql, 'sqlite')?.sql,
  },
  {
    name: 'drop-limit-on-count',
    claim: 'a row cap left in a statement whose question asks how many',
    apply: (input) => {
      if (!/\bhow many\b|\bnumber of\b|\btotal\b|\bcount\b/i.test(input.question)) return undefined;
      if (!/\blimit\s+\d+/i.test(input.sql)) return undefined;
      // No comparison against the input: a cap the pattern does not reach (`LIMIT 3 OFFSET 2`) leaves
      // the statement unchanged, and the caller already skips a rewrite that changed nothing.
      return input.sql.replace(/\s+limit\s+\d+\s*;?\s*$/i, ';');
    },
  },
  { name: 'integer-division', claim: 'a rate divided by an integer column truncates to zero', apply: integerDivision },
];

export interface RewriteReading {
  readonly rule: string;
  readonly claim: string;
  /** Cases the rule rewrote. */
  readonly fired: number;
  /** Rewrites that turned a wrong answer into a right one. */
  readonly won: number;
  /** Rewrites that turned a right answer into a wrong one. */
  readonly lost: number;
  /** Fires that left a right answer right. */
  readonly kept: number;
  /** Fires that left a wrong answer wrong. */
  readonly unchangedWrong: number;
  /** Rewrites the engine refused, which is a defect in the rule rather than a reading. */
  readonly broken: number;
  readonly net: number;
  readonly mcnemar: number;
  /**
   * The smallest difference these discordant pairs could have resolved, in percentage points.
   *
   * Printed per rule rather than once for the run, because it is a property of the pairs the rule
   * produced: a rule that fires twice has two discordant cases and resolves nothing, and a report
   * that lent it the run's resolution would make a rule look decisive for being rare.
   */
  readonly resolutionPp: number;
}

export interface RewriteReport {
  readonly split: string;
  readonly arm: string;
  readonly scored: number;
  /** Recomputed from the recorded statements. */
  readonly recomputed: number;
  /** What the artifact claims. */
  readonly declared: number;
  readonly agreed: number;
  readonly readings: readonly RewriteReading[];
  readonly problems: readonly string[];
}

export interface RewriteDeps {
  readonly execute: (db: string, sql: string) => Promise<{ readonly ok: boolean; readonly rows: readonly (readonly unknown[])[] }>;
  readonly judge: (gold: readonly (readonly unknown[])[], predicted: readonly (readonly unknown[])[]) => MatchReason;
}

/** The artifact fields this harness reads. */
export interface RewriteArtifact {
  readonly split?: unknown;
  readonly cases?: readonly {
    readonly id?: unknown;
    readonly arm?: unknown;
    readonly passed?: unknown;
    readonly predicted?: unknown;
    readonly candidates?: readonly { readonly sql?: unknown }[];
    readonly selectedByRule?: { readonly index?: unknown };
  }[];
  readonly failures?: Readonly<Record<string, readonly { readonly id?: unknown; readonly predicted?: unknown }[]>>;
}

/**
 * The statement an arm executed, whichever way the artifact recorded it.
 *
 * A rule arm records the chosen candidate and the slot it chose; an arm without a pool records
 * the statement on the failure row and nowhere else, because a passing case's statement was never
 * written down before the pools existed. Both shapes have to join, or the harness would price
 * rewrites on one arm only — which is how a rule that "works" ends up measured on the arms that
 * were built to show it working.
 */
export function statementOf(
  row: NonNullable<RewriteArtifact['cases']>[number],
  failures: readonly { readonly id?: unknown; readonly predicted?: unknown }[],
): string | undefined {
  const at = row.selectedByRule?.index;
  if (typeof at === 'number') {
    const sql = row.candidates?.[at]?.sql;
    if (typeof sql === 'string') return sql;
  }
  if (typeof row.predicted === 'string') return row.predicted;
  const failure = failures.find((entry) => String(entry.id) === String(row.id));
  return typeof failure?.predicted === 'string' ? failure.predicted : undefined;
}

/** Every case the arm scored, with the statement it executed. */
export function rewriteCases(
  artifact: RewriteArtifact,
  arm: string,
  questions: readonly BirdQuestion[],
): { readonly cases: readonly RewriteCase[]; readonly unretained: number; readonly unknownQuestion: number } {
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));
  const failures = artifact.failures?.[arm] ?? [];
  const cases: RewriteCase[] = [];
  let unretained = 0;
  let unknownQuestion = 0;
  for (const row of artifact.cases ?? []) {
    if (row.arm !== arm) continue;
    const id = String(row.id);
    const question = byId.get(id);
    if (question === undefined) {
      unknownQuestion += 1;
      continue;
    }
    const sql = statementOf(row, failures);
    if (sql === undefined) {
      unretained += 1;
      continue;
    }
    cases.push({ id, question, sql, declared: row.passed === true });
  }
  return { cases, unretained, unknownQuestion };
}

/**
 * Price every rule against one baseline.
 *
 * The gold result is executed once per case and the baseline statement once; each rule then costs
 * one more execution and nothing else. That is why a rewrite can be priced at all: the model calls
 * in this corpus are the expensive part, and none of them happen here.
 */
export async function priceRewrites(
  cases: readonly RewriteCase[],
  rules: readonly RewriteRule[],
  deps: RewriteDeps,
  typeOf: (db: string) => ((name: string) => string | undefined) | undefined,
): Promise<Omit<RewriteReport, 'split' | 'arm' | 'problems'> & { readonly unresolved: number }> {
  const tallies = rules.map(() => ({ fired: 0, won: 0, lost: 0, kept: 0, unchangedWrong: 0, broken: 0 }));
  let recomputed = 0;
  let declared = 0;
  let agreed = 0;
  let unresolved = 0;
  for (const item of cases) {
    const gold = await deps.execute(item.question.db_id, item.question.SQL);
    const base = await deps.execute(item.question.db_id, item.sql);
    if (!gold.ok) {
      // A gold statement this engine cannot run is not a case this instrument can score: the
      // artifact's verdict came from a run that could, and counting it as a loss would attribute
      // the engine's gap to the rewrite.
      unresolved += 1;
      continue;
    }
    const before = deps.judge(gold.rows, base.rows) === 'match';
    recomputed += before ? 1 : 0;
    declared += item.declared ? 1 : 0;
    agreed += before === item.declared ? 1 : 0;
    const lookup = typeOf(item.question.db_id);
    for (const [index, rule] of rules.entries()) {
      const tally = tallies[index] as (typeof tallies)[number];
      const next = rule.apply({
        question: item.question.question,
        sql: item.sql,
        ...(lookup === undefined ? {} : { typeOf: lookup }),
      });
      if (next === undefined || next === item.sql) continue;
      tally.fired += 1;
      const after = await deps.execute(item.question.db_id, next);
      if (!after.ok) {
        tally.broken += 1;
        continue;
      }
      const now = deps.judge(gold.rows, after.rows) === 'match';
      if (before && now) tally.kept += 1;
      else if (!before && now) tally.won += 1;
      else if (before && !now) tally.lost += 1;
      else tally.unchangedWrong += 1;
    }
  }
  const readings = rules.map((rule, index) => {
    const tally = tallies[index] as (typeof tallies)[number];
    const net = tally.won - tally.lost;
    return {
      rule: rule.name,
      claim: rule.claim,
      ...tally,
      net,
      // The exact test the pairs call for: only the discordant cases carry information, and a rule
      // that won six and lost none is as extreme as six coin flips that all landed the same way.
      mcnemar: mcnemarExact(tally.won, tally.lost),
      resolutionPp: pairedResolution(tally.lost, tally.won, cases.length).mde * 100,
    };
  });
  return { scored: cases.length, recomputed, declared, agreed, unresolved, readings };
}

/**
 * The one thing that stops a reading being publishable.
 *
 * A baseline that does not reproduce the arm's score is the failure this harness exists to catch:
 * the rewrites were then priced against a different judge than the one that produced the number
 * they are compared with. A rule that breaks statements is the second: `broken` is a defect in the
 * rewrite, not a case that stayed wrong.
 */
export function rewriteProblems(
  report: Pick<RewriteReport, 'recomputed' | 'declared' | 'scored' | 'readings'>,
): string[] {
  const problems: string[] = [];
  if (report.recomputed !== report.declared) {
    problems.push(
      `REWRITE: re-execution scores ${String(report.recomputed)} of ${String(report.scored)} and the artifact claims ${String(report.declared)}, so the baseline is not the judge these rewrites were priced against`,
    );
  }
  for (const reading of report.readings) {
    if (reading.broken > 0) problems.push(`REWRITE: ${String(reading.broken)} rewrite(s) of ${reading.rule} no longer run, so the rule is wrong about something`);
  }
  return problems;
}

/** Every line the report prints. */
export function rewriteLines(report: RewriteReport): string[] {
  const share = (count: number): string => `${((count / Math.max(1, report.scored)) * 100).toFixed(2)}pp`;
  const lines = [
    `deterministic rewrites ${report.split} · ${report.arm}: ${String(report.scored)} questions`,
    `  baseline ${String(report.recomputed)} = ${((report.recomputed / Math.max(1, report.scored)) * 100).toFixed(2)}%` +
      `  (artifact ${String(report.declared)}, agreement ${String(report.agreed)}/${String(report.scored)})`,
  ];
  for (const reading of report.readings) {
    lines.push(
      `  ${reading.rule.padEnd(20)} fired ${String(reading.fired).padStart(4)}  won ${String(reading.won).padStart(2)}  lost ${String(reading.lost).padStart(2)}` +
        `  broken ${String(reading.broken).padStart(2)}  kept ${String(reading.kept).padStart(3)}/${String(reading.unchangedWrong).padStart(3)}` +
        `  net ${reading.net >= 0 ? '+' : ''}${share(reading.net)}  p ${reading.mcnemar < 0.0001 ? '<0.0001' : reading.mcnemar.toFixed(4)}` +
        `  resolves ${reading.resolutionPp.toFixed(1)}pp`,
    );
    lines.push(`  ${' '.repeat(20)} ${reading.claim}`);
  }
  for (const problem of report.problems) lines.push(`  FAILED ${problem}`);
  return lines;
}

export interface RewriteSettings {
  readonly artifact: string;
  readonly arm: string;
  readonly limit?: number;
}

export function resolveRewriteSettings(argv: readonly string[]): RewriteSettings {
  const takesValue = new Set(['--artifact', '--arm', '--limit']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (takesValue.has(token)) {
      index += 1;
      continue;
    }
    throw new Error(`unrecognized argument ${token}: this harness takes --artifact <path>, --arm <name> and --limit <n>`);
  }
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const artifact = flag('--artifact');
  if (artifact === undefined) throw new Error('--artifact is required: this harness re-executes an artifact rather than producing one');
  const arm = flag('--arm');
  if (arm === undefined) throw new Error('--arm is required: the artifact may hold several arms and only one of them has statements to reprice');
  const raw = flag('--limit');
  const limit = raw === undefined ? undefined : Number(raw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`--limit takes a positive whole number of questions, not ${String(raw)}`);
  }
  return { artifact, arm, ...(limit === undefined ? {} : { limit }) };
}

/** The type lookup the integer-division rule needs, per database. */
export function typeLookup(tablesFile: string): (db: string) => ((name: string) => string | undefined) | undefined {
  let tables: ReturnType<typeof loadTables>;
  try {
    tables = loadTables(tablesFile);
  } catch {
    return () => undefined;
  }
  const cache = new Map<string, (name: string) => string | undefined>();
  return (db: string) => {
    const cached = cache.get(db);
    if (cached !== undefined) return cached;
    const table = tables.get(db);
    if (table === undefined) return undefined;
    const types = new Map<string, string>();
    const names = table.columnNames;
    for (const [index, pair] of names.entries()) {
      const [tableIndex, column] = pair;
      const type = String(table.columnTypes[index] ?? '').toUpperCase();
      const lower = String(column).toLowerCase();
      types.set(lower, type);
      const owner = tableIndex >= 0 ? table.tableNames[tableIndex] : undefined;
      if (owner !== undefined) types.set(`${String(owner).toLowerCase()}.${lower}`, type);
    }
    const lookup = (name: string): string | undefined => types.get(name.toLowerCase().replace(/["`[\]]/g, ''));
    cache.set(db, lookup);
    return lookup;
  };
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const settings = resolveRewriteSettings(argv);
  const body = JSON.parse(readFileSync(settings.artifact, 'utf8')) as RewriteArtifact;
  const split = body.split === 'dev' || body.split === 'minidev' ? body.split : undefined;
  const layout = resolveLayout(split === undefined ? env : { ...env, BIRD_SPLIT: split }, root);
  const questions = loadQuestions(layout.questionsFile);
  const { cases: all, unretained, unknownQuestion } = rewriteCases(body, settings.arm, questions);
  const cases = settings.limit === undefined ? all : all.slice(0, settings.limit);
  const { createOracle } = await import('./oracle.js');
  const { judgeOfficial } = await import('@agentix-e/nl2charts-devkit');
  // The script is resolved against this module rather than against the run's root: a harness that
  // is pointed at a dataset outside the repository still needs the oracle it ships with, and the
  // first version looked for it under the caller's root and found nothing.
  const oracle = createOracle(fileURLToPath(new URL('./oracle.py', import.meta.url)), layout.databaseRoot);
  try {
    const priced = await priceRewrites(
      cases,
      REWRITE_RULES,
      { execute: (db, sql) => oracle.run(db, sql), judge: judgeOfficial },
      typeLookup(layout.tablesFile),
    );
    const { unresolved, ...rest } = priced;
    const report: RewriteReport = { split: layout.split, arm: settings.arm, ...rest, problems: [] };
    const withProblems = { ...report, problems: rewriteProblems(report) };
    for (const line of rewriteLines(withProblems)) console.log(line);
    console.log(
      `  dropped: ${String(unretained)} without a statement, ${String(unknownQuestion)} naming a question the split does not hold` +
        (unresolved === 0 ? '' : `, ${String(unresolved)} whose gold the engine refused`),
    );
    // Every case the instrument could not price fails the build. A gold the engine refuses is the
    // same kind of loss as a case with no statement: the denominator shrinks silently, and a
    // rewrite priced on the survivors would be a ratio over a set the caller did not choose.
    const problems = withProblems.problems.length + unretained + unknownQuestion + unresolved;
    return problems === 0 ? 0 : 1;
  } finally {
    await oracle.close();
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
