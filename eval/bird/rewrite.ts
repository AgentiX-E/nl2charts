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
 *    The rule lives in the AI package (`guardNullOrder`) and the pipeline calls it, on the statement
 *    about to execute, after the cap strip. It waited two rounds for a reason this harness stated
 *    first: where an unknown value sorts is a property of the dialect, `null-order.ts` read every
 *    engine it did not name as SQLite, and DuckDB sorts the other way — so wiring it before closing
 *    that default would have handed DuckDB the rewrite that creates the defect. The default is a
 *    closed map now and an unknown engine is declined, which is what made the wiring a one-line
 *    change. The `sqlite` argument below is the harness naming the engine it is pricing on rather
 *    than the module assuming one.
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
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mcnemarExact, pairedResolution } from '@agentix-e/nl2charts-devkit';
import type { MatchReason } from '@agentix-e/nl2charts-devkit';
import { applyGrounding, clauseAt, guardNullOrder, SHIPPED_EDITS, stripUnfoundedCap } from '@agentix-e/nl2charts-ai';
import { domainsOf, groundLiteralAbsence, groundLiteralCase } from './literal-repair.js';
import { aliasTable, spliceWhereClause, whereClauseSpan } from './sql-shape.js';
import type { ColumnDomain, GroundableKind } from './literal-repair.js';
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
  /**
   * What this row decided, which is a different question from what it measured.
   *
   * A rule can win more than it loses and still not ship, and until this field existed the
   * difference was invisible in the report: the union of wins — the number a product claim uses —
   * was computed over `net > 0`, so a refused rule's repairs were counted into "what a pipeline
   * would recover". `drop-count-distinct` was that rule for two rounds: 33 won against 18 lost on
   * dev, refused because 18 is a cost and not noise, and printed inside the union throughout.
   *
   *   - `product` — the pipeline applies it. The product's own ledger (`SHIPPED_EDITS` in
   *     `packages/ai/src/edits.ts`) must list it, and `test/bird-rules-ledger.test.ts` holds the
   *     two lists to each other in both directions.
   *   - `refused` — priced and not adopted, for the reason this carries.
   *   - `instrument` — not a candidate. The row prices an implementation or a gate so that another
   *     row's number can be read; it is never in the union and never in the ledger.
   *
   * Absent on ceilings, which are already labelled by `oracle` and can neither ship nor be
   * refused. `rewriteProblems` requires it everywhere else, because a rule that is priced and then
   * forgotten is the state this field exists to make impossible.
   */
  readonly adoption?: 'product' | 'refused' | 'instrument';
  /** Why, for every row that is not the product's. Required by `rewriteProblems`, not by types. */
  readonly reason?: string;
  /**
   * The split this refusal was read on.
   *
   * A reason is a sentence about a corpus, and the columns beside it are numbers about whichever
   * corpus the caller pointed the harness at. Without this field the two were joined by nothing: a
   * refusal read on dev printed its counts next to a Mini-Dev artifact's numbers, and a reader had
   * no way to see that the sentence and the columns described different sets of questions.
   *
   * It is a *name*, not a copy of the counts. The five refusals below quoted their own numbers in
   * prose for three rounds; every one of them was stale against the dev artifact that finally
   * priced them (see `docs/benchmarks.md`), because a number written in a sentence has no reader
   * that fails when it stops being true. The counts this row prints are the counts this run took.
   */
  readonly refusedOn?: string;
  /**
   * Whether a proposal the engine refuses is a reading rather than a defect in the rule.
   *
   * A shipped rule must produce statements that run — one that writes a statement the engine
   * cannot parse is wrong about something, and the report fails the build over it. A ceiling is
   * different: the gold clause spliced into a prediction that never read the gold's table cannot
   * run, and that refusal *is* the finding ("this statement is in the `tables` bucket, not the
   * `predicate` one"). Counting it as a broken rule would fail a gate over the measurement it was
   * built to take.
   */
  readonly tolerateRefusal?: true;
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
 * The same count over the same rows, with `distinct` removed.
 *
 * This is the one edit here that is not a repair of a defect the engine can prove — it is a
 * reversal of a habit. On the dev split 162 of 1,532 selected statements count distinct rows
 * (10.6%), and the gold counts plain rows on most of those: a `count(distinct t.id)` written over a
 * table whose `id` is already unique, or over a join the statement invented. The failure class it
 * lands in is `values` — the statement ran, the width matched, the number did not — which is 365
 * of the split's 569 failures, the largest block left after every prompt lever was closed.
 *
 * Only the word is removed. The function's spelling, the argument, the surrounding statement and
 * every literal are left as written, because a rule that normalized more than the claim it makes
 * would be two edits priced as one. `select distinct` is untouched: that `distinct` decides which
 * rows come back, not how many rows a count reads.
 *
 * ## Why a rule that can lose is still a rule
 *
 * Removing `distinct` can only over-count when the statement's rows repeat: a join that multiplies
 * a parent row, or a column that is not unique. Those cases exist and this rule will get them
 * wrong. The instrument therefore prices wins *and* losses and prints the net, which is what makes
 * this publishable as an unconditional rule rather than as a candidate: `drop-limit-on-count` was
 * refused at 1 win against 19 losses on the same instrument, and this one is the same measurement
 * in the other direction.
 */
function dropCountDistinct(input: RewriteInput): string | undefined {
  // Split at the literals so a value like `'count(distinct b)'` is never read as a count. The edit
  // is then "did the text change", compared rather than flagged: a separate `changed` boolean needs
  // a second regex to stay in agreement with this one, and the two disagree on the first statement
  // their difference admits (`count(distinct)` with no argument to count).
  const rewritten = input.sql
    .split(/('(?:''|[^'])*')/g)
    .map((part) => (part.startsWith("'") ? part : part.replace(/\b(count\s*\(\s*)distinct\s+/gi, '$1')))
    .join('');
  return rewritten === input.sql ? undefined : rewritten;
}

/**
 * The statement with its top-level cap removed, and nothing else asked.
 *
 * The ceiling's edit. It reads no condition and refuses nothing, which is exactly what makes it a
 * ceiling: the number it prints is the whole of what removing caps could ever be worth, before any
 * question of whether a given cap should be removed.
 */
function stripCapOnly(sql: string): string | undefined {
  const end = clauseAt(sql, 'limit');
  if (end === undefined) return undefined;
  const start = end - 'limit'.length;
  const rest = sql.slice(end);
  const terminator = rest.indexOf(';');
  const head = sql.slice(0, start).replace(/\s+$/, '');
  return `${head}${terminator < 0 ? '' : rest.slice(terminator)}`;
}

/** The grounding edit, or nothing when the column cannot name exactly one spelling. */
function groundCase(input: RewriteInput): string | undefined {
  const edit = groundLiteralCase(input.sql, input.domains);
  return edit.substitutions.length === 0 ? undefined : edit.sql;
}

/** The same edit machinery under a different licence, for the two forms that are priced here. */
function groundAbsence(input: RewriteInput, kinds: readonly GroundableKind[]): string | undefined {
  const edit = groundLiteralAbsence(input.sql, input.domains, kinds);
  return edit.substitutions.length === 0 ? undefined : edit.sql;
}

/**
 * The rules, in the order the report prints them: the one that ships first, then the two the
 * suspicion produced and the measurement refused, then the two gates on the grounding edit.
 */
export const REWRITE_RULES: readonly RewriteRule[] = [
  {
    // The rule with the longest gap between pricing and shipping: priced here at 6 wins and 0
    // losses, then blocked on a dialect default, then wired in round 203 once the default became a
    // closed map. Its reach on the artifact this harness last read is printed beside every other
    // rule, and it is the one number in this list that does not change when the rule ships — the
    // statements it reaches are the statements the pipeline already guarded, so a later run of this
    // harness shows it declining more often and the artifact's own field shows why.
    name: 'null-order',
    claim: 'an ascending sort behind a row cap must not let unknown values win',
    adoption: 'product',
    apply: (input) => guardNullOrder(input.sql, 'sqlite')?.sql,
  },
  {
    name: 'drop-limit-on-count',
    claim: 'a row cap left in a statement whose question asks how many',
    adoption: 'refused',
    refusedOn: 'dev',
    reason:
      'the phrase is in questions whose cap is the answer, so the rule reads a word the question had to contain either way — it loses far more than it wins and every loss is a cap the question asked for',
    apply: (input) => {
      if (!/\bhow many\b|\bnumber of\b|\btotal\b|\bcount\b/i.test(input.question)) return undefined;
      if (!/\blimit\s+\d+/i.test(input.sql)) return undefined;
      // No comparison against the input: a cap the pattern does not reach (`LIMIT 3 OFFSET 2`) leaves
      // the statement unchanged, and the caller already skips a rewrite that changed nothing.
      return input.sql.replace(/\s+limit\s+\d+\s*;?\s*$/i, ';');
    },
  },
  {
    // The third reading of the same suspicion, and the only one that pays. `drop-limit-on-count`
    // gates the edit on the question saying "how many" and `drop-limit` gates it on the gold; this
    // one gates it on the two things a deployment can see — whether the cap ranks its rows and
    // whether the question asked for a ranking. It is the rule the AI package ships, priced as
    // itself rather than as its idea.
    name: 'drop-unordered-limit',
    claim: 'a cap on an unordered statement answering a question that names no rank',
    adoption: 'product',
    apply: (input) => stripUnfoundedCap(input.sql, input.question)?.sql,
  },
  {
    name: 'integer-division',
    claim: 'a rate divided by an integer column truncates to zero',
    adoption: 'refused',
    refusedOn: 'dev',
    reason:
      'the statements that divide already carry `* 1.0` or a cast, because that is the failure their author could see: on the split that decided it, the rule fires at one case in a hundred and buys nothing a paired test resolves',
    apply: integerDivision,
  },
  {
    name: 'drop-count-distinct',
    claim: 'a count over distinct rows where the question counts rows',
    adoption: 'refused',
    refusedOn: 'dev',
    reason:
      'profitable and not admissible: it wins more than it loses, the loss is not resolvable on this split, and a ' +
      'rewrite that pays less than it breaks is a cost no gate here can call noise. Not conditionable either — see ' +
      'the proof on `dropCountDistinct`; every condition the data can express selects the cases where the edit is a no-op',
    apply: dropCountDistinct,
  },
  {
    name: 'ground-case-empty',
    claim: 'a value written in the question\'s case, grounded only when the statement returned nothing',
    adoption: 'refused',
    refusedOn: 'dev',
    reason:
      'the gate is what cost the edit its ceiling: the repairs behind "returned nothing" are a strict subset of ' +
      'what the same edit finds ungated, and no loss either way — a wrong-case value in an `in` list or a `like` ' +
      'pattern returns rows and answers a different question, which the gate cannot see',
    needsDomains: true,
    apply: (input) => (input.empty ? groundCase(input) : undefined),
  },
  {
    name: 'ground-case-any',
    claim: 'the same edit under no gate: what the "returned nothing" condition costs',
    adoption: 'instrument',
    reason:
      'not a candidate but the reference the gate is read against, and the edit itself ships — the product ' +
      'calls `applyGrounding` over the library reader (`ground-shipped`). This row prices the same edit ' +
      'through the harness\'s own scanner, which is a second implementation of it and therefore a check ' +
      'that the two agree rather than a second decision',
    needsDomains: true,
    apply: groundCase,
  },
  {
    // The other two forms of absence a column's own values can prove. They are priced rather than
    // adopted: `ground-case-any` is the one this corpus paid for, and these two are one case each,
    // which is below what a paired test resolves. Pricing them is what turns "the bucket might be
    // bigger than the shipped rule" into a number.
    name: 'ground-padding',
    claim: 'a number written without the leading zeros its column stores',
    adoption: 'refused',
    refusedOn: 'dev',
    reason: 'a candidate held for a corpus that has more of it, not a rejection on the merits: at this frequency no split here resolves it in either direction',
    needsDomains: true,
    apply: (input) => groundAbsence(input, ['padding']),
  },
  {
    name: 'ground-parenthetical',
    claim: 'a label written without the parenthetical the column appends',
    adoption: 'refused',
    refusedOn: 'dev',
    reason: 'a candidate held for a corpus that has more of it, not a rejection on the merits: at this frequency no split here resolves it in either direction',
    needsDomains: true,
    apply: (input) => groundAbsence(input, ['parenthetical']),
  },
  {
    // The rule the pipeline ships, priced as itself rather than as its idea: `applyGrounding` is
    // the function `inline+evidence+ground` calls, over the domains this harness already read. The
    // two lines above are the same edit built from the eval scanner, and the difference between
    // them is the difference between "what the corpus needs" and "what the product does".
    name: 'ground-shipped',
    claim: 'the rewrite the pipeline runs, on the statements this artifact executed',
    adoption: 'product',
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
  {
    // The gross form of the same edit: remove the cap whenever the gold states none. It is a
    // ceiling because it reads the gold, and it is here because it is the reading that refutes
    // "the cheapest lever": it repairs three and breaks eight on the same arm, which is what a rule
    // looks like when the cases it can hurt were never counted.
    name: 'oracle-drop-limit',
    claim: 'the cap removed whenever the gold states none, which is the rule without its conditions',
    oracle: true,
    apply: (input) => {
      if (clauseAt(input.goldSql, 'limit') !== undefined) return undefined;
      return stripCapOnly(input.sql);
    },
  },
  {
    name: 'oracle-predicate',
    claim: 'the gold statement\'s own filter, spliced into the prediction, repairs the case',
    oracle: true,
    tolerateRefusal: true,
    apply: transplantGoldPredicate,
  },
];

/**
 * The statement with its table qualifiers removed, when it reads exactly one table.
 *
 * The ceiling has to splice a clause from one statement into another, and the two spell the same
 * table differently: the gold writes `frpm.county` or `t1.county`, the prediction writes `f.county`
 * or nothing. Dropping the qualifier is safe only when one table is in scope — with two, `name`
 * stops meaning one column — so the rule refuses to run on a join rather than guess, and the
 * report prints the share it could not reach.
 */
function unqualify(sql: string, qualifiers: readonly string[]): string {
  let out = sql;
  // Longest first so `t1.` cannot eat `t10.`, and no empty-name guard: the names come from
  // `aliasTable`, whose keys and values are both matched by `[a-z_][a-z0-9_]*`.
  for (const name of [...qualifiers].sort((left, right) => right.length - left.length)) {
    out = out.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`, 'gi'), '');
  }
  return out;
}

/**
 * Both statements' single table and every name it goes by, or nothing when either reads a join.
 *
 * The predicate transplant is defined for the case where both statements read the same one table.
 * That restriction is the whole reason the rule can be trusted: without it, a spliced clause could
 * be valid SQL against a different table, run, and be scored as "the predicate was the problem"
 * when the tables were.
 */
function singleTableOf(sql: string): readonly string[] | undefined {
  const tables = [...aliasTable(sql).values()];
  if (new Set(tables).size !== 1) return undefined;
  const names = [...aliasTable(sql).keys(), tables[0] as string];
  return names;
}

/**
 * The ceiling: how many of this bucket are *exactly* one filter away.
 *
 * The `conditions` census says how often a statement never wrote a condition the gold has; it
 * cannot say whether writing it would have been enough, because a statement missing a filter is
 * usually missing something else too. Splicing the gold's whole clause answers that in one
 * execution per case, and the difference between this number and the census is the share of the
 * bucket where the filter was the *whole* difference.
 *
 * It reads the gold statement, so it can never ship; it exists to decide whether the next lever is
 * condition coverage at all, and it is measured on the same statements the artifact executed.
 */
function transplantGoldPredicate(input: RewriteInput): string | undefined {
  if (input.passed) return undefined;
  const goldNames = singleTableOf(input.goldSql);
  const baseNames = singleTableOf(input.sql);
  if (goldNames === undefined || baseNames === undefined) return undefined;
  const gold = unqualify(input.goldSql, goldNames);
  const base = unqualify(input.sql, baseNames);
  const span = whereClauseSpan(gold);
  const body = span === undefined ? undefined : gold.slice(span.bodyStart, span.bodyEnd).trim();
  const spliced = spliceWhereClause(base, body === undefined || body === '' ? undefined : body);
  return spliced === base ? undefined : spliced;
}

export interface RewriteReading {
  readonly rule: string;
  readonly claim: string;
  /** The reading is a ceiling: the rule reads the gold statement and cannot ship. */
  readonly oracle: boolean;
  /**
   * What the row decided, carried into the report so a printed number cannot be read as a verdict.
   *
   * The union below is computed from this and not from the sign of the net, which is the defect
   * that made a refused rule's repairs part of "what a pipeline would recover".
   */
  readonly adoption: 'product' | 'refused' | 'instrument' | 'ceiling' | 'unstated';
  /** Why, on every row that is not the product's. */
  readonly reason?: string;
  /** The split a refusal was read on, carried so the printed counts can be labelled with it. */
  readonly refusedOn?: string;
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
  /**
   * The cases the rule turned from wrong to right.
   *
   * A count says a rule works and cannot say where. The buckets are counted by the difference
   * between two statements, so a ceiling's reach over them is a join between two reports — and a
   * join needs the keys, not the total.
   */
  readonly wonCases: readonly string[];
  /** Rewrites the engine refused, which is a defect in the rule rather than a reading. */
  readonly broken: number;
  /**
   * Rewrites the engine refused where the rule declared refusal a reading.
   *
   * Only a ceiling sets this: the gold clause cannot run against a prediction that never read the
   * gold's table, and that refusal is how the ceiling reports the part of the bucket it cannot
   * reach instead of dropping those cases from its own denominator.
   */
  readonly refused: number;
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
  /**
   * What every ceiling together would repair, and how much of that the product does not.
   *
   * A ceiling is priced one mechanism at a time, and no single row answers the question that
   * decides whether the family is worth another round: **with the gold statement in hand, how many
   * cases of this corpus are about the mechanism at all?** That is the union, and it is the number
   * a plan compares against the gap to the leader — 41 cases against a 13.09pp gap is a different
   * sentence from 25 and 24 read separately, because the two mechanisms overlap and the second
   * number double-counts the cases both reach.
   *
   * `beyondProduct` is what the union adds on top of what ships. It is the only headroom a better
   * rewrite engine could ever collect, so a plan that proposes one has to beat this number and not
   * the gap.
   */
  readonly ceiling: {
    readonly cases: number;
    readonly beyondProduct: number;
    readonly rules: readonly string[];
  };
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
  const tallies = rules.map(() => ({ fired: 0, won: 0, lost: 0, kept: 0, unchangedWrong: 0, broken: 0, refused: 0 }));
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
        // A rule that may propose a statement the engine refuses is measuring something else: for
        // the predicate ceiling the refusal says the prediction never read the gold's table, which
        // is the `tables` bucket rather than a defect in the splice.
        if (rule.tolerateRefusal === true) tally.refused += 1;
        else tally.broken += 1;
        continue;
      }
      if (before && now) tally.kept += 1;
      else if (!before && now) {
        tally.won += 1;
        // Recorded for the ceilings too, and not for the union: `adopted` filters on `oracle`
        // before anything reads this, so the only thing a ceiling's list can be used for is the
        // question the table cannot answer — *which bucket did this ceiling reach*.
        const repaired = wonCases.get(rule.name) ?? new Set<string>();
        repaired.add(item.id);
        wonCases.set(rule.name, repaired);
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
      // An unstated verdict is carried as `unstated` rather than defaulted to a refusal: a rule
      // nobody decided about is not a rule that was rejected, and the whole point of the field is
      // that the difference is visible. `rewriteProblems` refuses it.
      adoption: (rule.oracle === true ? 'ceiling' : (rule.adoption ?? 'unstated')) as RewriteReading['adoption'],
      ...(rule.reason === undefined ? {} : { reason: rule.reason }),
      ...(rule.refusedOn === undefined ? {} : { refusedOn: rule.refusedOn }),
      ...tally,
      wonCases: [...(wonCases.get(rule.name) ?? [])],
      net,
      // The exact test the pairs call for: only the discordant cases carry information, and a rule
      // that won six and lost none is as extreme as six coin flips that all landed the same way.
      mcnemar: mcnemarExact(tally.won, tally.lost),
      resolutionPp: pairedResolution(tally.lost, tally.won, cases.length).mde * 100,
    };
  });
  // The union is the pipeline's claim, so it is computed from what the pipeline applies and not
  // from the sign of a net. `net > 0` was the first version and it was wrong in the direction that
  // flatters: `drop-count-distinct` wins 33 and loses 18 on dev, is refused for the 18, and its
  // repairs were counted here for two rounds — so the number a product claim would quote included
  // an edit the product does not run.
  const adopted = readings.filter((reading) => reading.adoption === 'product').map((reading) => reading.rule);
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
  // Every ceiling's repairs, unioned, and counted against what ships. Read from `wonCases` for the
  // same reason the shipped union is: the tallies are per rule, and a case two ceilings both repair
  // is one case.
  const ceilingSet = new Set<string>();
  for (const reading of readings) {
    if (reading.adoption !== 'ceiling') continue;
    for (const id of reading.wonCases) ceilingSet.add(id);
  }
  let beyondProduct = 0;
  for (const id of ceilingSet) if (!repaired.has(id)) beyondProduct += 1;
  return {
    scored: cases.length,
    recomputed,
    declared,
    agreed,
    unresolved,
    unrunnable,
    readings,
    union: repaired.size,
    overlap,
    // Counted from the same per-case lists the rows carry, never by adding the rows up: the two
    // ceilings overlap on this corpus, and the sum of two overlapping counts is a number no
    // mechanism can reach. The subtraction is the reason the field exists — a reader who has to do
    // it by hand gets it wrong once per document.
    ceiling: {
      cases: ceilingSet.size,
      beyondProduct: beyondProduct,
      rules: readings.filter((reading) => reading.adoption === 'ceiling').map((reading) => reading.rule),
    },
  };
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
  report: Pick<RewriteReport, 'recomputed' | 'declared' | 'scored' | 'readings' | 'split'>,
): string[] {
  const problems: string[] = [];
  if (report.recomputed !== report.declared) {
    problems.push(
      `REWRITE: re-execution scores ${String(report.recomputed)} of ${String(report.scored)} and the artifact claims ${String(report.declared)}, so the baseline is not the judge these rewrites were priced against`,
    );
  }
  // What the pipeline already collects. A refusal of a winning rule is only admissible when the
  // wins it gives up are wins something that ships already takes: `ground-case-empty` is refused
  // for exactly that reason and not for losing, so a check that reddened every refused winner
  // would be wrong about the one row it had a chance to check.
  const covered = new Set<string>();
  for (const reading of report.readings) {
    if (reading.adoption !== 'product') continue;
    for (const id of reading.wonCases) covered.add(id);
  }
  for (const reading of report.readings) {
    if (reading.broken > 0) problems.push(`REWRITE: ${String(reading.broken)} rewrite(s) of ${reading.rule} no longer run, so the rule is wrong about something`);
    // A reading without a verdict is a measurement nobody decided anything with, which is the
    // state `drop-count-distinct` sat in for two rounds while the union quoted its repairs.
    if (reading.adoption === 'unstated') {
      problems.push(`REWRITE: ${reading.rule} is priced and carries no verdict, so its reading decides nothing`);
      continue;
    }
    if ((reading.adoption === 'refused' || reading.adoption === 'instrument') && reading.reason === undefined) {
      problems.push(`REWRITE: ${reading.rule} is ${reading.adoption} and says no reason, so the verdict cannot be checked`);
    }
    if (reading.adoption === 'product' && reading.reason !== undefined) {
      problems.push(`REWRITE: ${reading.rule} ships and carries a refusal reason; one of the two is stale`);
    }
    // A refusal is a sentence about a corpus, and the row beside it is a set of counts about
    // whichever corpus this run priced. Naming the split is what lets the two be compared at all.
    if (reading.adoption === 'refused' && reading.refusedOn === undefined) {
      problems.push(
        `REWRITE: ${reading.rule} is refused without saying which split it was refused on, so the counts printed beside it belong to no corpus`,
      );
      continue;
    }
    // The one contradiction the table can catch on its own: a rule refused for not paying, priced
    // on the split it was refused on, now paying — and nothing that ships collects those cases.
    if (
      reading.adoption === 'refused' &&
      reading.refusedOn === report.split &&
      reading.net > 0 &&
      reading.mcnemar < 0.05 &&
      reading.wonCases.some((id) => !covered.has(id))
    ) {
      problems.push(
        `REWRITE: ${reading.rule} is refused on ${String(reading.refusedOn)} and wins there: ${String(reading.won)} won against ${String(reading.lost)} lost (p ${reading.mcnemar.toFixed(4)}), and no shipped rule turns those cases`,
      );
    }
  }
  return problems;
}

/**
 * The two lists this repository keeps about the product's edits, held to each other.
 *
 * `REWRITE_RULES` is what this harness prices; `SHIPPED_EDITS` is what the product imports and
 * applies. A disagreement means the product runs an edit nobody priced, or the pricer ships an edit
 * the product never wired — and the first of those is silent by construction, which is why the
 * comparison exists at all. It takes the rule table rather than a report because it is a claim about
 * the code, not about a corpus: a report over four hundred questions and a report over fifteen
 * hundred cannot disagree about which rules exist.
 */
export function ledgerProblems(rules: readonly RewriteRule[]): string[] {
  const priced = rules
    .filter((rule) => rule.adoption === 'product')
    .map((rule) => rule.name)
    .sort();
  const ledger = SHIPPED_EDITS.filter((edit) => edit.enabled)
    .map((edit) => edit.rule)
    .sort();
  if (priced.join(',') === ledger.join(',')) return [];
  // Named through a function rather than an inline `||`: an empty list is the case the message has
  // to read well in, because "the pricer marks nothing and the ledger enables three" is a real
  // failure — a product whose whole edit list arrived from somewhere other than this table.
  const list = (names: readonly string[]): string => (names.length === 0 ? 'nothing' : names.join(', '));
  return [
    `REWRITE: the pricer marks ${list(priced)} as the product's and the ledger enables ${list(ledger)}; ` +
      'an edit with no price and a price with no edit are both refusals',
  ];
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
        `  broken ${String(reading.broken).padStart(2)}${reading.refused === 0 ? '' : ` refused ${String(reading.refused).padStart(2)}`}  kept ${String(reading.kept).padStart(3)}/${String(reading.unchangedWrong).padStart(3)}` +
        `  net ${reading.net >= 0 ? '+' : ''}${share(reading.net)}  p ${reading.mcnemar < 0.0001 ? '<0.0001' : reading.mcnemar.toFixed(4)}` +
        `  resolves ${reading.resolutionPp.toFixed(1)}pp`,
    );
    lines.push(`  ${' '.repeat(20)} ${reading.claim}`);
    // A verdict on its own line rather than a column, because it is a sentence and the columns are
    // numbers: `refused: 119 fired, 33 won, 18 lost` reads as a cost, and the reason is what says
    // which cost it was.
    if (reading.adoption === 'ceiling' || reading.adoption === 'unstated') continue;
    // Which corpus the sentence is about, beside the columns that belong to this one. Three of the
    // refusals read "on dev" while the harness was being pointed at Mini-Dev, and nothing failed.
    const where =
      reading.adoption !== 'refused' || reading.refusedOn === undefined
        ? ''
        : reading.refusedOn === report.split
          ? ` (refused on ${reading.refusedOn}, and these are that split's counts)`
          : ` (refused on ${reading.refusedOn}; the counts above are ${report.split}'s)`;
    lines.push(
      `  ${' '.repeat(20)} ${reading.adoption === 'product' ? 'ships' : reading.adoption}${where}${reading.reason === undefined ? '' : `: ${reading.reason}`}`,
    );
  }
  // The union is what a pipeline would recover; the per-rule deltas add up only when nothing
  // overlapped. Both are printed because the second is a property of the corpus and the first is
  // the number a product claim would use.
  const adopted = report.readings.filter((reading) => reading.adoption === 'product').length;
  // Two rules that ship and repaired nothing have no union to print: "0 (+0.00pp) — the deltas add"
  // is a sentence about an addition that did not happen.
  if (adopted > 1 && report.union > 0) {
    lines.push(
      `  union of wins across adopted rules: ${String(report.union)} (+${share(report.union)})` +
        (report.overlap.length === 0 ? '  — no two rules won the same case, so the deltas add' : ''),
    );
    for (const pair of report.overlap) {
      lines.push(`  overlap ${pair.left} & ${pair.right}: ${String(pair.cases)} case(s), so those deltas do not add`);
    }
  }
  // The ceiling's union, printed with what it adds on top of the product. Both numbers appear
  // because the second is the whole headroom a better rewrite engine could collect, and reading
  // only the first is how 41 cases became a plan for two more rounds of rules that would have
  // rewritten 18.
  if (report.ceiling.cases > 0) {
    lines.push(
      `  ceiling union (${report.ceiling.rules.join(' + ')}, gold in hand): ${String(report.ceiling.cases)} case(s)` +
        ` (+${share(report.ceiling.cases)})  — ${String(report.ceiling.beyondProduct)} of them no shipped rule repairs`,
    );
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
  /**
   * Where to write the report, so a reading can be crossed with another instrument's.
   *
   * Until this existed the harness printed a table and nothing else, and the per-case rows it had
   * already computed were dropped with the process. That made one question unanswerable: a
   * ceiling's wins are counted by statement shape, and the buckets are counted by the difference
   * between two statements, so "which bucket does this ceiling actually reach" needs both
   * artifacts on disk at the same time. Printing a total cannot be joined to anything.
   */
  readonly write?: string;
}

export function resolveRewriteSettings(argv: readonly string[]): RewriteSettings {
  const takesValue = new Set(['--artifact', '--arm', '--limit', '--write']);
  const flags = new Set(['--oracle']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (takesValue.has(token)) {
      index += 1;
      continue;
    }
    if (flags.has(token)) continue;
    throw new Error(
      `unrecognized argument ${token}: this harness takes --artifact <path>, --arm <name>, --limit <n>, --write <path> and --oracle`,
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
  const write = flag('--write');
  return {
    artifact,
    arm,
    oracle: argv.includes('--oracle'),
    ...(limit === undefined ? {} : { limit }),
    ...(write === undefined ? {} : { write }),
  };
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
    // The measurement's own refusals, plus the one claim about the code that a report cannot make:
    // that the product's edit list and this table are the same list.
    const withProblems = { ...report, problems: [...rewriteProblems(report), ...ledgerProblems(REWRITE_RULES)] };
    if (settings.write !== undefined) writeFileSync(settings.write, `${JSON.stringify(withProblems, null, 2)}\n`);
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
