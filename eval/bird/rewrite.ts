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
 * 4. **`ground-case-empty`** and **`ground-case-any`** — a value written in the case the question
 *    used, against a column that stores another: `'East Bohemia'` where the table stores `'east
 *    Bohemia'`. The edit reads the column's own values, fires only when exactly one spelling
 *    matches ignoring case, and is the one rule here whose licence comes from the data rather
 *    than from the engine. The two names are the two gates on the same edit: the shipped
 *    instrument only applied it to a statement that returned nothing, and the pair prices what
 *    that gate leaves behind, because a wrong-case value does not only return *nothing* — an
 *    `in` list or a `like` pattern returns some rows and answers a different question.
 *
 * ## Rules that read the gold statement are ceilings, not rules
 *
 * A substitution taken from the gold statement is not available to a product that does not have
 * the gold, so pricing it as a rule would be a lie about what it costs. It is still worth
 * pricing, because it answers the question every instruction-level lever has failed to answer:
 * *how much of this bucket is even about the literal?* Those live in `ORACLE_RULES`, they run
 * only when the caller asks with `--oracle`, and every line they print is labelled, because the
 * difference between a 2pp rule and a 2pp ceiling is a dispatch.
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
import { applyGrounding, guardNullOrder } from '@agentix-e/nl2charts-ai';
import { domainsOf, groundLiteralCase } from './literal-repair.js';
import type { ColumnDomain } from './literal-repair.js';
import { literalSites } from './statement.js';
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
  /**
   * The stored values of every column this statement compares against.
   *
   * Read once per case rather than per rule, because two rules can need the same column and the
   * read is a query: an instrument that re-read a column for every rule would charge the second
   * rule for the first one's evidence. Empty when the caller supplies no reader, which is the
   * state a rule that needs domains must treat as "cannot fire" rather than "no values".
   */
  readonly domains: readonly ColumnDomain[];
  /**
   * Whether the statement returned no rows.
   *
   * The shipped literal repair was gated on this, and the gate is a hypothesis about where the
   * defect appears rather than a property of the defect. Passing it to the rules makes the gate
   * a thing this harness can price instead of a thing the caller decides.
   */
  readonly empty: boolean;
  /**
   * The gold statement, for the rules that are ceilings rather than rules.
   *
   * Present for every case — the split always knows its answer — and read only by `ORACLE_RULES`,
   * so that a rule which is meant to ship cannot accidentally depend on it.
   */
  readonly goldSql: string;
  /**
   * Whether the statement already answers its question.
   *
   * A ceiling has to be a ceiling: substituting a value the gold names into a statement that is
   * already right is not a repair, it is a different answer, and a rule that is allowed to do it
   * prices "how many questions can be answered by guessing the gold's literals" — 31 wins and 30
   * losses, a reading that says nothing about the failures it was meant to bound. Every other
   * rule here is admissible on a passing case because its licence is a property of the statement
   * (an unguarded sort, a wrong case) rather than of the answer.
   */
  readonly passed: boolean;
}

export interface RewriteRule {
  readonly name: string;
  /** What the rule claims, in one line, printed beside its reading. */
  readonly claim: string;
  /**
   * The rewritten statement, or `undefined` when the rule does not apply.
   *
   * A rule may propose several statements for one case, and the case counts as won when any of
   * them passes. That is what makes a ceiling expressible: "one of the substitutions from the
   * gold's literals repairs this case" is a real reading, and it is not the same claim as "this
   * particular substitution does".
   */
  readonly apply: (input: RewriteInput) => string | readonly string[] | undefined;
  /** The rule reads the column's stored values, so the harness pays one query per column. */
  readonly needsDomains?: boolean;
  /** The rule reads the gold statement, so its reading is a ceiling and not a candidate. */
  readonly oracle?: boolean;
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

/** The grounding edit, or nothing when the column cannot name exactly one spelling. */
function groundCase(input: RewriteInput): string | undefined {
  const edit = groundLiteralCase(input.sql, input.domains);
  return edit.substitutions.length === 0 ? undefined : edit.sql;
}

/**
 * The rules, in the order the report prints them: the one that ships first, then the two the
 * suspicion produced and the measurement refused, then the two gates on the grounding edit.
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
  {
    name: 'ground-case-empty',
    claim: 'a value written in the question\'s case, grounded only when the statement returned nothing',
    needsDomains: true,
    apply: (input) => (input.empty ? groundCase(input) : undefined),
  },
  {
    name: 'ground-case-any',
    claim: 'the same edit under no gate: what the "returned nothing" condition costs',
    needsDomains: true,
    apply: groundCase,
  },
  {
    // The rule the pipeline ships, priced as itself rather than as its idea: `applyGrounding` is
    // the function `inline+evidence+ground` calls, over the domains this harness already read. The
    // two lines above are the same edit built from the eval scanner, and the difference between
    // them is the difference between "what the corpus needs" and "what the product does".
    name: 'ground-shipped',
    claim: 'the rewrite the pipeline runs, on the statements this artifact executed',
    needsDomains: true,
    apply: (input) => {
      const byColumn = new Map<string, readonly string[]>();
      for (const domain of input.domains) {
        const key = domain.column.toLowerCase();
        byColumn.set(key, [...(byColumn.get(key) ?? []), ...domain.values]);
      }
      if (byColumn.size === 0) return undefined;
      const outcome = applyGrounding(input.sql, (query) => byColumn.get(query.column.toLowerCase()));
      return outcome.substitutions.length === 0 ? undefined : outcome.sql;
    },
  },
];

/** How many substitutions one oracle rule may propose per case, and why it is capped. */
export const TRANSPLANT_LIMIT = 6;

/**
 * Every statement one same-column literal substitution from the gold would produce.
 *
 * This is the ceiling of the whole literal family, not a rule: a product does not have the gold
 * statement, so nothing here can ship. What it can do is answer the question instructions have
 * failed to answer for six rounds — *how much of the bucket is about the literal at all?* — in a
 * form that costs executions instead of model calls.
 *
 * The substitution is same-column on purpose. Taking the gold's literal and putting it wherever
 * the prediction's literals sit would repair statements by accident and call the accident a
 * ceiling; a value is compared against a column, and a value from a different column is a
 * different question. The cap exists because the ceiling is a lower bound either way, and the
 * executions are the only thing a ceiling is charged for.
 */
function transplantGoldLiterals(input: RewriteInput): readonly string[] | undefined {
  if (input.passed) return undefined;
  const gold = literalSites(input.goldSql);
  const proposed: string[] = [];
  const seen = new Set<string>();
  for (const site of literalSites(input.sql)) {
    for (const candidate of gold) {
      if (candidate.column.toLowerCase() !== site.column.toLowerCase()) continue;
      if (candidate.literal.value === site.literal.value) continue;
      const text = `'${candidate.literal.value.replace(/'/g, "''")}'`;
      const rewritten = input.sql.slice(0, site.literal.start) + text + input.sql.slice(site.literal.end);
      if (seen.has(rewritten)) continue;
      seen.add(rewritten);
      proposed.push(rewritten);
      if (proposed.length >= TRANSPLANT_LIMIT) return proposed;
    }
  }
  return proposed.length === 0 ? undefined : proposed;
}

/**
 * The ceilings. Never printed beside a rule and never adopted: each one is the answer to "how
 * much would a mechanism that always succeeded here be worth", which is the number that decides
 * whether a dispatch is worth making.
 */
export const ORACLE_RULES: readonly RewriteRule[] = [
  {
    name: 'oracle-transplant',
    claim: 'one same-column value from the gold repairs the case',
    oracle: true,
    apply: transplantGoldLiterals,
  },
];

export interface RewriteReading {
  readonly rule: string;
  readonly claim: string;
  /** The reading is a ceiling: the rule reads the gold statement and cannot ship. */
  readonly oracle: boolean;
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
  /**
   * Distinct cases at least one shippable rule repairs.
   *
   * The number a product-side claim needs: rules are priced one at a time, but a pipeline applies
   * all of them, and the sum of their deltas is the right answer only if no two rules repair the
   * same case. `overlap` is that check rather than an assumption.
   */
  readonly union: number;
  /** Pairs of shippable rules that won the same case. Empty means the deltas add up. */
  readonly overlap: readonly { readonly left: string; readonly right: string; readonly cases: number }[];
  readonly problems: readonly string[];
}

export interface RewriteDeps {
  readonly execute: (db: string, sql: string) => Promise<{ readonly ok: boolean; readonly rows: readonly (readonly unknown[])[] }>;
  readonly judge: (gold: readonly (readonly unknown[])[], predicted: readonly (readonly unknown[])[]) => MatchReason;
  /**
   * One column's stored values, for the rules that ground a literal in the data.
   *
   * Optional because a split can be priced without a database — the three rules that follow from
   * the engine do not read one — but a run that omits it while asking for a grounding rule would
   * report that rule as inert, which is the one reading this instrument must never produce by
   * accident: `rewriteProblems` refuses it instead.
   */
  readonly domain?: (db: string, table: string, column: string) => Promise<readonly string[]>;
}

/** The artifact fields this harness reads. */
export interface RewriteArtifact {
  readonly split?: unknown;
  readonly cases?: readonly {
    readonly id?: unknown;
    readonly arm?: unknown;
    readonly passed?: unknown;
    readonly predicted?: unknown;
    /** The statement this case executed, published for passing cases too. */
    readonly sql?: unknown;
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
  // `sql` is the field the harness publishes for *every* case since the statements were retained,
  // and it was missing from this reader for one round. The consequence was not a gap in a table:
  // a passing case with no statement is dropped from the denominator, so every `pp` this report
  // prints was against the failures alone, and `lost` — the column that catches a rule breaking a
  // correct statement — was structurally zero on every single-call artifact. A rule that only
  // fires on failures cannot be caught breaking a pass.
  if (typeof row.sql === 'string') return row.sql;
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
): Promise<
  Omit<RewriteReport, 'split' | 'arm' | 'problems'> & { readonly unresolved: number; readonly unrunnable: number }
> {
  const tallies = rules.map(() => ({ fired: 0, won: 0, lost: 0, kept: 0, unchangedWrong: 0, broken: 0 }));
  // Which cases each shippable rule repaired. Only non-oracle wins are collected: a ceiling is
  // not adopted, so folding it into the union would price a pipeline that does not exist.
  const wonCases = new Map<string, Set<string>>();
  const readsDomains = rules.some((rule) => rule.needsDomains === true);
  if (readsDomains && deps.domain === undefined) {
    // A grounding rule with no reader is not a rule that loses; it is an instrument that cannot
    // see. Reporting it as a zero would be the most expensive kind of wrong: a real lever looks
    // inert and the line of work closes on a missing dependency.
    throw new Error('a rule needs column values and no domain reader was supplied');
  }
  const noDomains: readonly ColumnDomain[] = [];
  let recomputed = 0;
  let declared = 0;
  let agreed = 0;
  let unresolved = 0;
  let unrunnable = 0;
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
    // A statement the engine refused is not a statement a rewrite can be priced on: every rule
    // would be rewriting text that never ran, and a rewrite that also fails to run would be filed
    // as a defect in the rule. The case stays in the denominator — it is a failure the arm
    // produced — and is counted here so the exclusion is visible rather than silent.
    if (!base.ok) {
      unrunnable += 1;
      continue;
    }
    const lookup = typeOf(item.question.db_id);
    // One read per column per case, shared by every rule that needs it: the same column can be
    // the evidence for two rules, and a second query would be charged to the second rule.
    const domains =
      readsDomains && deps.domain !== undefined
        ? await domainsOf(item.sql, (table, column) => (deps.domain as NonNullable<RewriteDeps['domain']>)(item.question.db_id, table, column))
        : noDomains;
    for (const [index, rule] of rules.entries()) {
      const tally = tallies[index] as (typeof tallies)[number];
      const proposed = rule.apply({
        question: item.question.question,
        sql: item.sql,
        empty: base.ok && base.rows.length === 0,
        domains,
        goldSql: item.question.SQL,
        passed: before,
        ...(lookup === undefined ? {} : { typeOf: lookup }),
      });
      if (proposed === undefined) continue;
      const candidates = (typeof proposed === 'string' ? [proposed] : proposed).filter((text) => text !== item.sql);
      if (candidates.length === 0) continue;
      tally.fired += 1;
      // A rule may propose several statements and the case is won when any of them passes: that
      // is the shape a ceiling needs, and it is the same shape a product rule would have if it
      // ever learned to pick between two edits instead of refusing.
      let ran = 0;
      let now = false;
      for (const candidate of candidates) {
        const after = await deps.execute(item.question.db_id, candidate);
        if (!after.ok) continue;
        ran += 1;
        if (deps.judge(gold.rows, after.rows) === 'match') {
          now = true;
          break;
        }
      }
      // Every proposal refused by the engine is a defect in the rule, not a case that stayed
      // wrong: the rule wrote a statement that does not run.
      if (ran === 0) {
        tally.broken += 1;
        continue;
      }
      if (before && now) tally.kept += 1;
      else if (!before && now) {
        tally.won += 1;
        if (rule.oracle !== true) {
          const repaired = wonCases.get(rule.name) ?? new Set<string>();
          repaired.add(item.id);
          wonCases.set(rule.name, repaired);
        }
      }
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
      oracle: rule.oracle === true,
      ...tally,
      net,
      // The exact test the pairs call for: only the discordant cases carry information, and a rule
      // that won six and lost none is as extreme as six coin flips that all landed the same way.
      mcnemar: mcnemarExact(tally.won, tally.lost),
      resolutionPp: pairedResolution(tally.lost, tally.won, cases.length).mde * 100,
    };
  });
  // Only rules that win more than they lose are adopted, so only their wins are bankable. A rule
  // that repairs twenty and breaks thirty is not part of the pipeline, and counting its wins in
  // the union would price a product nobody would ship.
  const adopted = readings.filter((reading) => !reading.oracle && reading.net > 0).map((reading) => reading.rule);
  // `adopted` is exactly the rules that won something, so every name in it has a set: the first
  // version carried a `?? []` fallback here, which was a branch no run could take.
  const repaired = new Set<string>();
  for (const [name, won] of wonCases) if (adopted.includes(name)) for (const id of won) repaired.add(id);
  const overlap: { left: string; right: string; cases: number }[] = [];
  const names = adopted.filter((name) => wonCases.has(name));
  for (const [index, left] of names.entries()) {
    for (const right of names.slice(index + 1)) {
      const other = wonCases.get(right) as Set<string>;
      let shared = 0;
      for (const id of wonCases.get(left) as Set<string>) if (other.has(id)) shared += 1;
      if (shared > 0) overlap.push({ left, right, cases: shared });
    }
  }
  return { scored: cases.length, recomputed, declared, agreed, unresolved, unrunnable, readings, union: repaired.size, overlap };
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
  let ceiling = false;
  for (const reading of report.readings) {
    if (reading.oracle && !ceiling) {
      // A ceiling and a rule are different claims and must not share a column of numbers: one is
      // what a mechanism that always succeeded would be worth, the other is what this code does.
      lines.push('  -- ceilings: read the gold statement, cannot ship, exist to price a dispatch --');
      ceiling = true;
    }
    lines.push(
      `  ${(reading.oracle ? `${reading.rule}*` : reading.rule).padEnd(20)} fired ${String(reading.fired).padStart(4)}  won ${String(reading.won).padStart(2)}  lost ${String(reading.lost).padStart(2)}` +
        `  broken ${String(reading.broken).padStart(2)}  kept ${String(reading.kept).padStart(3)}/${String(reading.unchangedWrong).padStart(3)}` +
        `  net ${reading.net >= 0 ? '+' : ''}${share(reading.net)}  p ${reading.mcnemar < 0.0001 ? '<0.0001' : reading.mcnemar.toFixed(4)}` +
        `  resolves ${reading.resolutionPp.toFixed(1)}pp`,
    );
    lines.push(`  ${' '.repeat(20)} ${reading.claim}`);
  }
  // The union is what a pipeline would recover; the per-rule deltas add up only when nothing
  // overlapped. Both are printed because the second is a property of the corpus and the first is
  // the number a product claim would use.
  const adopted = report.readings.filter((reading) => !reading.oracle && reading.net > 0).length;
  if (adopted > 1) {
    lines.push(
      `  union of wins across adopted rules: ${String(report.union)} (+${share(report.union)})` +
        (report.overlap.length === 0 ? '  — no two rules won the same case, so the deltas add' : ''),
    );
    for (const pair of report.overlap) {
      lines.push(`  overlap ${pair.left} & ${pair.right}: ${String(pair.cases)} case(s), so those deltas do not add`);
    }
  }
  for (const problem of report.problems) lines.push(`  FAILED ${problem}`);
  return lines;
}

export interface RewriteSettings {
  readonly artifact: string;
  readonly arm: string;
  readonly limit?: number;
  /** Price the ceilings too, which costs executions and reads the gold statement. */
  readonly oracle: boolean;
}

export function resolveRewriteSettings(argv: readonly string[]): RewriteSettings {
  const takesValue = new Set(['--artifact', '--arm', '--limit']);
  const flags = new Set(['--oracle']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (takesValue.has(token)) {
      index += 1;
      continue;
    }
    if (flags.has(token)) continue;
    throw new Error(
      `unrecognized argument ${token}: this harness takes --artifact <path>, --arm <name>, --limit <n> and --oracle`,
    );
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
  return { artifact, arm, oracle: argv.includes('--oracle'), ...(limit === undefined ? {} : { limit }) };
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
  const { createDomainReader } = await import('./literal-repair.js');
  const { judgeOfficial } = await import('@agentix-e/nl2charts-devkit');
  // The script is resolved against this module rather than against the run's root: a harness that
  // is pointed at a dataset outside the repository still needs the oracle it ships with, and the
  // first version looked for it under the caller's root and found nothing.
  const oracle = createOracle(fileURLToPath(new URL('./oracle.py', import.meta.url)), layout.databaseRoot);
  try {
    const priced = await priceRewrites(
      cases,
      settings.oracle ? [...REWRITE_RULES, ...ORACLE_RULES] : REWRITE_RULES,
      {
        execute: (db, sql) => oracle.run(db, sql),
        judge: judgeOfficial,
        // The cache is per database and lives for the run: a column's values do not change while
        // 1,532 statements are priced, and reading one twice would be the harness paying twice.
        domain: (() => {
          const cache = new Map<string, readonly string[]>();
          const readers = new Map<string, ReturnType<typeof createDomainReader>>();
          return async (db: string, table: string, column: string) => {
            const reader = readers.get(db) ?? createDomainReader((sql) => oracle.run(db, sql), db, cache);
            readers.set(db, reader);
            return reader(table, column);
          };
        })(),
      },
      typeLookup(layout.tablesFile),
    );
    const { unresolved, unrunnable, ...rest } = priced;
    const report: RewriteReport = { split: layout.split, arm: settings.arm, ...rest, problems: [] };
    const withProblems = { ...report, problems: rewriteProblems(report) };
    for (const line of rewriteLines(withProblems)) console.log(line);
    console.log(
      `  dropped: ${String(unretained)} without a statement, ${String(unknownQuestion)} naming a question the split does not hold` +
        (unresolved === 0 ? '' : `, ${String(unresolved)} whose gold the engine refused`) +
        (unrunnable === 0 ? '' : `, ${String(unrunnable)} whose own statement the engine refused`),
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
