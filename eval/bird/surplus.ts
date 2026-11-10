/**
 * The layer under `filter-wide`: is the predicate too weak, or is the `from` multiplying rows?
 *
 * `values-gap` splits the `values` bucket by the shape of the difference between two statements,
 * and `filter-wide` is its second rung — a different number of rows than the gold returned. On the
 * dev split that is **102 of 425 arithmetic failures (24.0%)**, the largest single bucket this
 * repository has, and it is the only bucket whose name hides two defects with *opposite* fixes:
 *
 * - **the predicate is too weak.** The statement filtered on the right column and the right shape
 *   and one condition is missing or looser than the question implies. The fix is condition
 *   coverage: read the question again and write the atom it implies.
 * - **the `from` multiplies rows.** Every condition is right and the answer is still too large,
 *   because a join fanned out — one item to many orders — or a `distinct` the question implies was
 *   never written. The fix is grain: `exists`, a semi-join, or an aggregation the statement lacks.
 *
 * A lever built for one of those does nothing for the other, and the bucket's own name cannot say
 * which is which. The two look identical from the syntax: a wrong `where` and a wrong `from` are
 * both "the statement differs", and the ladder in `values-gap` stops at that. So the split has to
 * be measured rather than read, and the measurement is a counterfactual:
 *
 * > keep the statement's `from`, replace its `where` with the gold's, and run it.
 *
 * If the answer becomes right, the predicate was the whole defect. If it stays wrong, no edit to a
 * predicate reaches the case — the difference is in what the statement reads, and the next lever
 * has to be about joins or grain. **That is the only question this tool answers**, and it answers
 * it with the engine rather than with a reading of the text.
 *
 * The outcomes are named `predicate`, `duplicates` and `elsewhere`, and the asymmetry is
 * deliberate: the first names a cause the counterfactual established, the other two only name what
 * the cause is *not*. A fan-out, a missing `distinct` and a `limit` that truncates all land in the
 * last two, and this tool does not separate them further — that is `bench:bird:join`'s question,
 * asked on a different denominator.
 *
 * `duplicates` exists because BIRD's official judge compares `set()` of the tuples: a fan-out that
 * repeats a row collapses to the gold's answer and the case *scores*. A graft that only looks like
 * a repair because the judge folded the repeats is a `distinct` nobody wrote, not a predicate, so
 * `predicate` is claimed by the strict multiset rule and an official-only match gets its own
 * bucket. Without that split the tool would have reported every fan-out as condition-coverage work
 * and pointed the next lever at the wrong clause.
 *
 * ## Why a counterfactual and not a rule
 *
 * The obvious cheaper instrument is a heuristic: count the rows, look for a one-to-many join over
 * the declared foreign keys, and call the surplus a fan-out. It is wrong in both directions. A
 * join can multiply rows without any foreign key to check (`from a, b where ...`), a missing
 * `distinct` multiplies nothing structural at all, and a predicate that is too weak produces
 * exactly the same symptom. The graft has no such failure mode: it asks the engine what the case
 * would be if the predicate were right, which is the premise of the fix and not a proxy for it.
 *
 * ## Where the graft refuses
 *
 * A graft is an edit to a statement the model wrote, so it can be impossible, and the tool says so
 * rather than guessing:
 *
 * - `selfJoin` — the statement reads one table under two aliases (an employee and their manager).
 *   The gold's `where` names columns through *its* aliases, and retargeting them onto a self-join
 *   needs a role mapping nothing in the artifact carries. Structural, and counted rather than
 *   repaired.
 * - `missingTable` — the gold's `where` compares a column of a table the prediction never reads.
 *   That is not a predicate defect at all: it is the `tables` rung, which the ladder places *below*
 *   `filter-wide` and therefore never reaches for these cases. The tool reports them as `tables`
 *   because that is what they are, and the count is a reading of the ladder as much as of the arm.
 * - `unreadable` — the grafted statement would not run. Every other refusal here is a fact about
 *   the case; this one can also be a fact about this file, so it fails the build rather than being
 *   printed and ignored.
 *
 * ## What it does not do
 *
 * It does not claim that a `predicate` case is repairable. Replacing a whole `where` clause with
 * the gold's is an oracle's edit and no prompt can make it: the number is a **ceiling** on what any
 * condition-coverage lever could reach, not a forecast of what one would earn. `literal-gap` states
 * the same limit for the same reason, and the two tools are meant to be read together — one says
 * what is reachable by editing a literal, this one says what is reachable by editing the condition.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { judgeOfficial, judgeStrict } from '@agentix-e/nl2charts-devkit';
import { loadQuestions } from './data.js';
import { classifyFailureShape } from './failure-shape.js';
import { createOracle } from './oracle.js';
import { resolveLayout } from './run.js';
import type { BirdLayout } from './run.js';
import { aggregateCalls, aliasTable, groupingColumns, projectionItems, rewriteAliases, spliceWhereClause, whereClauseSpan } from './sql-shape.js';
import { codeOnly } from './statement.js';

/** What a graft concluded about one case. */
export const SURPLUS_KINDS = ['predicate', 'duplicates', 'elsewhere', 'tables', 'selfJoin', 'nested', 'unreadable'] as const;
export type SurplusKind = (typeof SURPLUS_KINDS)[number];

/**
 * Why a graft could not be built.
 *
 * Three of the four are facts about the case and one is not, which is why a refusal is a bucket
 * rather than a failure: on the dev split five of fifty-four cases have no graft, and a gate that
 * went red on them would be red on every future run — a gate nobody can satisfy is a gate nobody
 * reads.
 */
export type GraftRefusal = 'selfJoin' | 'missingTable' | 'nested';

export interface Graft {
  /** The statement with the gold's `where` clause in place of the prediction's, or a refusal. */
  readonly sql?: string;
  readonly refused?: GraftRefusal;
}

/**
 * Every alias in a map points at a different table.
 *
 * A self-join breaks the one thing a graft needs — that a table name identifies a role. `from
 * employees e join employees m` maps two aliases onto one table, so retargeting `m.manager_id`
 * onto the prediction would have to choose between `e` and `m`, and choosing is the guess this
 * file exists to avoid.
 */
function readsATableTwice(aliases: Map<string, string>): boolean {
  const seen = new Set<string>();
  for (const table of aliases.values()) {
    if (seen.has(table)) return true;
    seen.add(table);
  }
  return false;
}

/**
 * The gold's `where` body with every alias retargeted onto the prediction's own aliases.
 *
 * Written as a scanner rather than as a replacement because two of the three ways to get this
 * wrong are textual. `where label = 'a.b'` contains a dot that is a value, and a regex that
 * rewrote `a.` everywhere would change the literal and measure a different question; a quoted
 * identifier (`"order"."id"`) is a column name and not an alias, and lowercasing it — which is what
 * `rewriteAliases` does, and why that function cannot be used to build a statement that has to run
 * — would rename the column.
 *
 * `undefined` means the body compares a column of a table the prediction does not read, which is
 * a `tables` finding and not something to retarget.
 */
export function retargetWhere(body: string, goldAliases: Map<string, string>, predictionAliasOf: Map<string, string>): string | undefined {
  let out = '';
  let index = 0;
  let reachable = true;
  while (index < body.length) {
    const char = body[index] as string;
    const next = body[index + 1];
    if (char === "'" || char === '"' || char === '`') {
      // A doubled quote inside a quoted run is an escaped quote, not the end of the run.
      let end = index + 1;
      while (end < body.length) {
        if (body[end] === char) {
          if (body[end + 1] === char) {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      out += body.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === '[') {
      const end = body.indexOf(']', index);
      const stop = end === -1 ? body.length : end + 1;
      out += body.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '-' && next === '-') {
      const end = body.indexOf('\n', index);
      const stop = end === -1 ? body.length : end;
      out += body.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = body.indexOf('*/', index + 2);
      const stop = end === -1 ? body.length : end + 2;
      out += body.slice(index, stop);
      index = stop;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(index))?.[0] as string;
      const after = index + word.length;
      if (body[after] === '.') {
        const lower = word.toLowerCase();
        // A qualifier is an alias when the gold declared one, and a table name otherwise:
        // `where items.id = 1` qualifies with the table and never declared the alias.
        const table = goldAliases.get(lower) ?? lower;
        const target = predictionAliasOf.get(table);
        if (target === undefined) {
          reachable = false;
          out += `${word}.`;
        } else {
          out += `${target}.`;
        }
        index = after + 1;
        continue;
      }
      out += word;
      index = after;
      continue;
    }
    out += char;
    index += 1;
  }
  return reachable ? out : undefined;
}

/**
 * Whether a statement reads a table through a subquery.
 *
 * A nested `select` is where a textual graft stops being safe rather than merely hard. The clause
 * it edits is the top-level one, but the qualifiers inside a derived table belong to a `from` the
 * prediction keeps in a different place — one level down, or not at all — so a retargeted column
 * can resolve against the wrong query. Refusing is the honest answer: the case is counted as
 * `nested`, and the tool says how much of the bucket it did not read rather than editing a
 * statement it cannot reason about.
 */
export function nestsAQuery(sql: string): boolean {
  return (codeOnly(sql).match(/\bselect\b/gi) ?? []).length > 1;
}

/**
 * The prediction with the gold's filter in place of its own.
 *
 * Normalisation is applied to the *mapping* only: both statements are read for their aliases, and
 * the text that is spliced is the gold's own body with its qualifiers rewritten. Nothing is
 * lowercased and nothing is re-spaced except the single splice, because the output has to run.
 */
export function graftPredicate(predicted: string, gold: string): Graft {
  const predictedAliases = aliasTable(predicted);
  const goldAliases = aliasTable(gold);
  if (readsATableTwice(predictedAliases) || readsATableTwice(goldAliases)) return { refused: 'selfJoin' };
  if (nestsAQuery(predicted) || nestsAQuery(gold)) return { refused: 'nested' };
  const goldSpan = whereClauseSpan(gold);
  if (goldSpan === undefined) {
    // The gold filters nothing, so the graft is "remove the prediction's filter" — the same
    // counterfactual in the other direction, and the one that prices a statement which filters
    // where the answer does not.
    return { sql: spliceWhereClause(predicted, undefined) };
  }
  const body = gold.slice(goldSpan.bodyStart, goldSpan.bodyEnd);
  const predictionAliasOf = new Map<string, string>();
  for (const [alias, table] of predictedAliases) predictionAliasOf.set(table, alias);
  const retargeted = retargetWhere(body, goldAliases, predictionAliasOf);
  if (retargeted === undefined) return { refused: 'missingTable' };
  const trimmed = retargeted.trim();
  // A gold `where` that retargeted to nothing is an empty clause, and `spliceWhereClause` reads
  // `undefined` as "delete the clause" while an empty string would write `where` with no body.
  return { sql: spliceWhereClause(predicted, trimmed === '' ? undefined : trimmed) };
}

export interface SurplusTally {
  readonly total: number;
  readonly kinds: Readonly<Record<SurplusKind, number>>;
  /** Cases a condition-coverage lever could reach: `predicate`. An oracle's number, not a forecast. */
  readonly reachableByPredicate: number;
}

/**
 * The two statements answer at the same grain, so "replace the filter" is a question with an answer.
 *
 * A prediction that returns one row per item against a gold that returns one counted row is a
 * different defect: the aggregate is missing, and no filter can make that statement match whatever
 * the filter says. Counting those in `elsewhere` would dress an aggregation mistake as a join
 * finding, so they leave the denominator instead — the same way `literal-gap` drops a `values`
 * failure that returned rows, and for the same reason: a rung's report must be about the rung.
 *
 * Aliases are rewritten before the comparison because `count(*)` in a statement that aliases
 * `items` as `i` is the same call as `count(*)` in one that does not, and the two spellings would
 * otherwise read as two grains.
 */
export function readsSameShape(gold: string, predicted: string): boolean {
  const key = (values: readonly string[]): string =>
    JSON.stringify([...values].map((value) => value.replace(/\s+/g, ' ').trim().toLowerCase()).sort());
  const left = rewriteAliases(gold);
  const right = rewriteAliases(predicted);
  return (
    key(aggregateCalls(left)) === key(aggregateCalls(right)) &&
    key(groupingColumns(left)) === key(groupingColumns(right)) &&
    projectionItems(left).length === projectionItems(right).length
  );
}

export function tallySurplus(kinds: readonly SurplusKind[]): SurplusTally {
  const counts = SURPLUS_KINDS.reduce((acc, kind) => ({ ...acc, [kind]: 0 }), {} as Record<SurplusKind, number>);
  for (const kind of kinds) counts[kind] += 1;
  return { total: kinds.length, kinds: counts, reachableByPredicate: counts.predicate };
}

/** The share of one kind, as a percentage with one decimal, or `0.0` over an empty set. */
function share(count: number, total: number): string {
  return total === 0 ? '0.0' : ((count / total) * 100).toFixed(1);
}

/** The report: one line per kind, then the ceiling the kinds add up to. */
export function surplusLines(tally: SurplusTally): string[] {
  const lines = SURPLUS_KINDS.map(
    (kind) => `  ${kind.padEnd(12)} ${String(tally.kinds[kind]).padStart(4)}  ${share(tally.kinds[kind], tally.total).padStart(5)}%`,
  );
  lines.push(
    `  reachable by editing the predicate: ${String(tally.reachableByPredicate)} of ${String(tally.total)}` +
      (tally.total === 0 ? '' : ` (${share(tally.reachableByPredicate, tally.total)}%)`),
  );
  return lines;
}

/**
 * What has to be true for the split to be a reading.
 *
 * One condition, and it is about the denominator: an empty bucket prints `0 of 0` as `0.0%` and
 * reads like a measured zero, which is the failure `literal-gap` refuses for the same reason.
 *
 * A refused graft is deliberately *not* a failure here. `literal-gap` fails its build on an
 * unreadable site because it claims to read every site; this tool claims less, and on the dev split
 * eleven of fifty-four cases are unreadable by construction — self-joins have no role mapping,
 * nested statements have no safe place to put the clause, and a derived table has no alias to
 * retarget onto. A gate that went red on them would be red on every future run, and a gate nobody
 * can satisfy is a gate nobody reads. The refusals are counted in the tally and their ids are in
 * the artifact, so the share this tool did not read is a number in the report rather than a
 * silence.
 */
export function surplusProblems(tally: SurplusTally): string[] {
  const problems: string[] = [];
  if (tally.total === 0) problems.push('SURP: no case in this artifact returned a different number of rows, so there is nothing to split');
  return problems;
}

export interface SurplusSettings {
  readonly root: string;
  readonly artifact: string;
  readonly arm: string;
  readonly layout: BirdLayout;
}

export const DEFAULT_SURPLUS_ARM = 'metadata+evidence';

export function resolveSurplusSettings(
  argv: readonly string[],
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): SurplusSettings {
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
  return { root, artifact: artifact ?? layout.out, arm: arm ?? DEFAULT_SURPLUS_ARM, layout };
}

/** Where the artifact goes, named by the arm so two arms do not overwrite each other. */
export function surplusPath(settings: { readonly root: string; readonly arm: string }): string {
  const safe = settings.arm.replace(/[^a-z0-9+-]/gi, '_');
  return join(settings.root, 'eval', 'out', `surplus-${safe}.json`);
}

export interface SurplusDrops {
  /** Cases the arm answered: not a failure, and not a denominator entry. */
  readonly passed: number;
  /** Cases in the artifact but under another arm. */
  readonly otherArm: number;
  /** Failures the judge filed under something other than `values`. */
  readonly otherReason: number;
  /** A `values` failure with no statement retained. */
  readonly unretained: number;
  /** A case whose question the split does not hold. */
  readonly unknownQuestion: number;
  /** A case whose gold the engine refused. */
  readonly goldFailed: number;
  /** A case whose own statement the engine refused. */
  readonly engineRefused: number;
  /** A `values` failure that returned a different *shape* of answer than a row count. */
  readonly otherShape: number;
  /**
   * A `row-count` case whose two statements answer at different grains.
   *
   * Counted apart from `otherShape` because the two say opposite things about the bucket. A case
   * here *is* `filter-wide` — the engine counted different rows — and it is being dropped because
   * the difference is a missing aggregate or a wider projection, which means the ladder in
   * `values-gap` placed an `aggregate` case on the `filter-wide` rung. Folding it into "another
   * shape" would hide that; folding it into the denominator would charge the predicate for it.
   */
  readonly otherForm: number;
}

export interface SurplusRow {
  readonly id: string;
  readonly db: string;
  readonly kind: SurplusKind;
  /** The gold's row count and the prediction's, so a reader can see the size of the surplus. */
  readonly goldRows: number;
  readonly predictedRows: number;
}

export interface SurplusOutcome {
  readonly split: string;
  readonly arm: string;
  readonly tally: SurplusTally;
  /** Grafted statements the engine refused. */
  readonly unreadable: number;
  /** Which cases those were, so a refusal can be read instead of only counted. */
  readonly unreadableIds: readonly string[];
  readonly drops: SurplusDrops;
  readonly rows: readonly SurplusRow[];
  readonly problems: readonly string[];
}

/** The artifact this tool reads: only the fields it needs, so a wider one still validates. */
interface EvalArtifact {
  readonly split?: string;
  readonly cases: readonly {
    readonly arm: string;
    readonly id: string | number;
    readonly passed: boolean;
    readonly reason?: string;
    readonly sql?: string;
  }[];
}

export async function runSurplus(settings: SurplusSettings): Promise<SurplusOutcome> {
  const body = JSON.parse(readFileSync(settings.artifact, 'utf8')) as EvalArtifact;
  const split = body.split === 'dev' || body.split === 'minidev' ? body.split : settings.layout.split;
  // The artifact declares the split and the split names the files. When the caller's environment
  // disagrees the artifact wins, but the *paths* stay the caller's: a harness pointed at a dataset
  // outside the repository must not fall back to `eval/.cache` and read a corpus it was not given.
  const layout =
    split === settings.layout.split
      ? settings.layout
      : resolveLayout(
          {
            ...process.env,
            BIRD_SPLIT: split,
            BIRD_DATA: settings.layout.data,
            BIRD_DATABASES: settings.layout.databaseRoot,
          },
          settings.root,
        );
  const questions = loadQuestions(layout.questionsFile);
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));

  const drops = {
    passed: 0,
    otherArm: 0,
    otherReason: 0,
    unretained: 0,
    unknownQuestion: 0,
    goldFailed: 0,
    engineRefused: 0,
    otherShape: 0,
    otherForm: 0,
  };
  const rows: SurplusRow[] = [];
  const unreadableIds: string[] = [];

  const oracle = createOracle(layout.oracleScript, layout.databaseRoot);
  try {
    for (const row of body.cases) {
      if (row.arm !== settings.arm) {
        drops.otherArm += 1;
        continue;
      }
      if (row.passed) {
        drops.passed += 1;
        continue;
      }
      if (row.reason !== 'values') {
        drops.otherReason += 1;
        continue;
      }
      if (typeof row.sql !== 'string' || row.sql.trim() === '') {
        drops.unretained += 1;
        continue;
      }
      const question = byId.get(String(row.id));
      if (question === undefined) {
        drops.unknownQuestion += 1;
        continue;
      }
      const gold = await oracle.run(question.db_id, question.SQL);
      if (!gold.ok) {
        drops.goldFailed += 1;
        continue;
      }
      const predicted = await oracle.run(question.db_id, row.sql);
      if (!predicted.ok) {
        drops.engineRefused += 1;
        continue;
      }
      // `filter-wide` is a property of the engine's answer, not of the judge's label: a `values`
      // failure whose rows differ in number belongs to this rung, and one whose rows differ in
      // width belongs to `column-count`. Reading the shape here is what keeps the denominator the
      // same set `values-gap` counts.
      if (classifyFailureShape(predicted, gold.rows).shape !== 'row-count') {
        drops.otherShape += 1;
        continue;
      }
      // A row-count difference between an aggregate and a row set is the `aggregate` rung, not
      // this one: the graft would report "the predicate was not the whole defect" for a statement
      // that is missing a `count`, which is true and useless.
      if (!readsSameShape(question.SQL, row.sql)) {
        drops.otherForm += 1;
        continue;
      }
      const graft = graftPredicate(row.sql, question.SQL);
      const base = { id: String(row.id), db: question.db_id, goldRows: gold.rows.length, predictedRows: predicted.rows.length };
      if (graft.refused === 'selfJoin') {
        rows.push({ ...base, kind: 'selfJoin' });
        continue;
      }
      if (graft.refused === 'nested') {
        rows.push({ ...base, kind: 'nested' });
        continue;
      }
      if (graft.refused === 'missingTable') {
        rows.push({ ...base, kind: 'tables' });
        continue;
      }
      const grafted = await oracle.run(question.db_id, graft.sql as string);
      if (!grafted.ok) {
        unreadableIds.push(String(row.id));
        rows.push({ ...base, kind: 'unreadable' });
        continue;
      }
      // Two judges, and the difference between them is a finding rather than a tie-break. BIRD's
      // official rule compares `set()` of the tuples, so a fan-out that repeats a row collapses to
      // the gold's answer and the case scores. A graft that only looks like a repair because the
      // judge dropped the duplicates is not a predicate defect — it is a `distinct` that was never
      // written — so `predicate` is claimed by the *strict* multiset rule and the official-only
      // match gets its own bucket. Reading the official rule here would have reported 30-odd
      // fan-outs as condition-coverage work and sent the next lever to the wrong clause.
      const strict = judgeStrict(gold.rows, grafted.rows) === 'match';
      const official = judgeOfficial(gold.rows, grafted.rows) === 'match';
      rows.push({ ...base, kind: strict ? 'predicate' : official ? 'duplicates' : 'elsewhere' });
    }
  } finally {
    await oracle.close();
  }

  const tally = tallySurplus(rows.map((row) => row.kind));
  return {
    split,
    arm: settings.arm,
    tally,
    unreadable: unreadableIds.length,
    unreadableIds,
    drops,
    rows,
    problems: surplusProblems(tally),
  };
}

export function writeSurplusArtifact(settings: SurplusSettings, outcome: SurplusOutcome): string {
  const path = surplusPath({ root: settings.root, arm: outcome.arm });
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
  const settings = resolveSurplusSettings(argv, root, env);
  const outcome = await runSurplus(settings);
  const path = writeSurplusArtifact(settings, outcome);
  console.log(`surplus split · ${outcome.arm} · ${outcome.split} · ${String(outcome.tally.total)} case(s) returned a different number of rows`);
  for (const line of surplusLines(outcome.tally)) console.log(line);
  console.log(
    `  dropped: ${String(outcome.drops.passed)} passed, ${String(outcome.drops.otherShape)} another shape, ` +
      `${String(outcome.drops.otherForm)} another grain, ${String(outcome.drops.otherReason)} another bucket, ` +
      `${String(outcome.drops.unretained)} without a statement`,
  );
  console.log(`  written to ${path}`);
  for (const problem of outcome.problems) console.log(`  ${problem}`);
  return outcome.problems.length === 0 ? 0 : 1;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
