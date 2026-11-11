/**
 * What is left under `elsewhere`, and which way the read-set is wrong.
 *
 * `bench:bird:surplus` carries the gold's `where` across and runs the statement again. Three things
 * can happen: it matches, and the predicate was the whole defect (`predicate`); it matches only
 * under the official rule, and the surplus was repetition (`duplicates`); or it still does not
 * match, and the tool stops there (`elsewhere`). On the dev split's five arms that last bucket
 * holds 31 to 39 cases, 52.5% to 60.0% of the row-count rung, and it is the largest number this
 * project has ever pointed a lever at.
 *
 * This instrument asks the one question `surplus` leaves, and it asks it without executing anything
 * the previous tool has not already executed: **when the gold's filter is in place and the rows
 * still differ, is the statement reading too many distinct rows, too few, or the wrong ones in both
 * directions?** Those three call for opposite work. Too many is a condition or a key the statement
 * never carried; too few is a join that drops rows the answer keeps; both is a statement built on a
 * different relation.
 *
 * **One of the kinds is not a direction at all.** `capped` is checked first and it is a *repair*: a
 * statement that answers the question and then keeps fewer rows than asked is truncating a right
 * answer, and removing its own top-level `limit` proves which it was with a single query. It is the
 * only number here a deployment can act on without a model, and on the dev split it is the largest
 * single part of the residue — 8 to 13 cases per arm carry such a cap, and stripping it repairs 5
 * to 8, which is 0.33 to 0.52pp of the split for a rule that needs no prompt and no card.
 *
 * ## Why this is a set question and not a fan-out question
 *
 * The plan this round inherited was "split one-to-many fan-out from a missing `distinct`". That
 * split already exists, and the arithmetic says so:
 *
 * > a fan-out repeats rows and preserves the row *set*. The official judge compares `set()`. So a
 * > case whose only defect is repetition **scores**, unless the gold's own answer repeats a row.
 *
 * Which is exactly the `duplicates` bucket: 4 to 13 cases per arm, credited by the judge because
 * `set()` folded them. **A case that reaches `elsewhere` therefore cannot be a pure fan-out** — if
 * it were, the set would match and the case would be a win. What is left is a statement reading a
 * *different* set of rows, and "how different, in which direction" is the partition that can be
 * measured rather than argued.
 *
 * That is why no join is removed and no `distinct` is spliced in here: both edits were tried on
 * paper first, and both are determined before they run. A `distinct` view of a `elsewhere` case
 * cannot match its gold — the set already differs, and the view does not change the set — and
 * removing a piece of a `from` clause cannot repair a statement whose rows are missing as well as
 * extra. Shipping a query whose answer is known is how a zero gets read as a measurement.
 *
 * ## The three directions
 *
 * Containment is tested through `resultKey`, the devkit's canonical identity for a result set, by
 * comparing the key of the concatenation with the key of each side: the union equals one side
 * exactly when that side contains the other. Two consequences worth stating, because they are the
 * difference between this and a hand-rolled set comparison: the normalisation is the judge's own
 * (so a `1` and a `1.0` are the same row here for the same reason they are in the score), and the
 * check is order-free and duplicate-free, like the rule it is built on.
 *
 * ## The audit this carries
 *
 * `surplus` can only carry a `where`. BIRD's gold statements also put conditions in a `having`
 * clause and in a join's `on` clause beside its key, and a gold that does either cannot be repaired
 * by that graft at all. Those cases are not row-source cases: they are condition cases the
 * instrument could not express, and every one of them inflates `elsewhere`. So the split is
 * cross-tabulated against where the gold states its conditions, and against the tables the gold
 * reads that the prediction never does — the two ways a residue case can be explained by something
 * other than the row source.
 *
 * ## What it does not do
 *
 * It does not price a lever, and it does not claim a cause it did not establish. `over` with no
 * condition outside the `where` and no missing table is the honest floor: the statement reads the
 * same tables, under the gold's own filter, and still returns rows the answer does not have. That
 * number is reported as `unattributed` rather than being assigned to a clause.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { judgeOfficial, judgeStrict, resultKey } from '@agentix-e/nl2charts-devkit';
import type { Tuple } from '@agentix-e/nl2charts-devkit';
import { loadQuestions } from './data.js';
import { classifyFailureShape } from './failure-shape.js';
import { createOracle } from './oracle.js';
import { resolveLayout } from './run.js';
import type { BirdLayout } from './run.js';
import { graftPredicate, readsSameShape } from './surplus.js';
import { codeOnly, definesOwnName, tableRefs } from './statement.js';

/**
 * What one residue case turned out to be.
 *
 * `capped` is out of order on purpose: it is not a direction, it is a *repair*. A statement that
 * answers the question and then keeps fewer rows than asked is not reading a narrower relation, it
 * is truncating a right answer, and stripping its own `limit` proves which it was with one query.
 * It is checked before the directions because it is the only kind here that names a fix rather than
 * a symptom.
 */
export const RESIDUE_KINDS = ['capped', 'over', 'under', 'mixed', 'unreadable'] as const;
export type ResidueKind = (typeof RESIDUE_KINDS)[number];

/** Where a gold states conditions a `where` graft cannot carry. */
export type ConditionSite = 'having' | 'on';

/**
 * Which side's rows contain the other's, as a direction.
 *
 * `over`: the statement returns rows the answer does not have, and every row of the answer is
 * there. `under`: the answer's rows are all present and some are missing. `mixed`: neither
 * contains the other, so the statement is built on a different relation rather than a wider or
 * narrower reading of the same one.
 *
 * The union comparison is what makes this exact. `resultKey` sorts and deduplicates, so the key of
 * `gold ∪ grafted` equals `grafted`'s key precisely when `gold ⊆ grafted`; comparing sizes or
 * counting rows would answer a different question.
 */
export function directionOf(gold: readonly Tuple[], grafted: readonly Tuple[]): 'over' | 'under' | 'mixed' {
  const union = resultKey([...gold, ...grafted]);
  const goldKey = resultKey(gold);
  const graftKey = resultKey(grafted);
  if (union === graftKey && graftKey !== goldKey) return 'over';
  if (union === goldKey && graftKey !== goldKey) return 'under';
  return 'mixed';
}

/** Words that close a `from` clause at depth zero. `on` and `using` are part of a join. */
const FROM_BOUNDARY = ['where', 'group', 'having', 'order', 'limit', 'offset', 'union', 'except', 'intersect', 'window', 'returning'];
const JOIN_MODIFIERS = new Set(['left', 'right', 'full', 'inner', 'outer', 'cross', 'natural']);

/** Every top-level word in a statement, with the position it starts at. */
function topLevelWords(sql: string): { readonly word: string; readonly start: number; readonly end: number }[] {
  const masked = codeOnly(sql);
  const words: { word: string; start: number; end: number }[] = [];
  let depth = 0;
  let index = 0;
  while (index < masked.length) {
    const char = masked[index] as string;
    if (char === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(char)) {
      const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(masked.slice(index))?.[0] as string;
      words.push({ word: word.toLowerCase(), start: index, end: index + word.length });
      index += word.length;
      continue;
    }
    index += 1;
  }
  return words;
}

/** The statement without the terminator a statement does not need. */
function endOfStatement(sql: string): number {
  return sql.trimEnd().replace(/;\s*$/, '').trimEnd().length;
}

/** Where one join of a `from` clause starts and ends, and which table it reads. */
export interface JoinPiece {
  readonly table: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Every join in the statement's own `from` clause, with its span.
 *
 * Only joins, not the base table and not the pieces after a comma, because the only caller is the
 * `on` test and a comma join has no `on` to test. Spans rather than text because the caller slices
 * the clause it is about to read, and re-finding a piece by searching for its first word lands in
 * the wrong place as soon as two joins read the same table.
 *
 * A `join` inside a subquery, a literal or a comment is not here: the scan runs on masked text and
 * only at depth zero, so the piece list is the statement's own joins and not its children's.
 */
export function joinPieces(sql: string): readonly JoinPiece[] {
  const words = topLevelWords(sql);
  const from = words.find((entry) => entry.word === 'from');
  if (from === undefined) return [];
  const bodyStart = from.end;
  const closing = words.find((entry) => entry.start > bodyStart && FROM_BOUNDARY.includes(entry.word));
  const bodyEnd = closing?.start ?? endOfStatement(sql);
  const masked = codeOnly(sql);
  const openings: number[] = [];
  let depth = 0;
  let index = bodyStart;
  while (index < bodyEnd) {
    const char = masked[index] as string;
    if (char === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (depth !== 0 || !/[A-Za-z_]/.test(char)) {
      index += 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(masked.slice(index, bodyEnd))?.[0] as string;
    if (word.toLowerCase() !== 'join') {
      index += word.length;
      continue;
    }
    openings.push(openingOfJoin(masked, bodyStart, index));
    index += word.length;
  }
  return openings.map((opening, position) => {
    const end = openings[position + 1] ?? bodyEnd;
    const text = sql.slice(opening, end).replace(/\s+/g, ' ').trim();
    const named = /\bjoin\s+([A-Za-z_][A-Za-z_0-9]*)/i.exec(text);
    return { table: (named?.[1] ?? '?').toLowerCase(), start: opening, end, text };
  });
}

/**
 * Where a join begins, which is not where its `join` keyword is.
 *
 * `left join x on …` is one piece. Cutting at the `join` would leave `left` behind, and a clause
 * that reads `… from a left where` is not the statement the model wrote — the `on` test would then
 * read the wrong span and report a condition that is not there.
 */
function openingOfJoin(masked: string, floor: number, at: number): number {
  let cursor = at;
  for (;;) {
    let back = cursor;
    while (back > floor && /\s/.test(masked[back - 1] as string)) back -= 1;
    const before = /([A-Za-z_][A-Za-z_0-9]*)$/.exec(masked.slice(floor, back));
    const candidate = before?.[1]?.toLowerCase();
    if (candidate === undefined || !JOIN_MODIFIERS.has(candidate)) return cursor;
    cursor = back - candidate.length;
  }
}

/** How many top-level `and`s a clause body has, which is one fewer than its conjuncts. */
function topLevelAnds(text: string): number {
  let count = 0;
  let depth = 0;
  let index = 0;
  const masked = codeOnly(text);
  while (index < masked.length) {
    const char = masked[index] as string;
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[A-Za-z_]/.test(char)) {
      const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(masked.slice(index))?.[0] as string;
      if (word.toLowerCase() === 'and') count += 1;
      index += word.length;
      continue;
    }
    index += 1;
  }
  return count;
}

/**
 * Where the gold states conditions that are not a `where`, or `undefined` when all of them are.
 *
 * A structural reading of the *gold*, not of the prediction, and it audits the previous rung rather
 * than the arm: `surplus.ts` carries the gold's `where` across and nothing else, so a gold whose
 * conditions live in a `having` clause or in a join's `on` clause beside its key cannot be repaired
 * by that graft. Those cases are not row-source cases at all, and the count is printed so a reader
 * can subtract them.
 *
 * The `on` test is "more than one conjunct", because a join's own key is one and a filter beside it
 * is another. It is a fact about the text and it is stated as one: it does not claim the extra
 * conjunct filters anything, and a case counted here can still be a genuine row-source case.
 */
export function conditionsOutsideWhere(sql: string): ConditionSite | undefined {
  if (topLevelWords(sql).some((entry) => entry.word === 'having')) return 'having';
  const masked = codeOnly(sql);
  for (const piece of joinPieces(sql)) {
    const at = /\bon\b/.exec(masked.slice(piece.start, piece.end));
    if (at === null) continue;
    if (topLevelAnds(masked.slice(piece.start + at.index, piece.end)) > 0) return 'on';
  }
  return undefined;
}

/**
 * The tables a statement reads, in the order it names them, once and in lower case.
 *
 * A name the statement defines is not a table: BIRD's golds open CTEs, and a CTE name counted as a
 * table would report a missing table on every such case. The rule `bench:bird:join` applies when it
 * prices card coverage, and for the same reason — a name is a table only if nothing in the
 * statement defined it.
 */
export function tablesOf(sql: string): readonly string[] {
  const out: string[] = [];
  for (const ref of tableRefs(sql)) {
    const table = ref.table.toLowerCase();
    if (out.includes(table)) continue;
    if (definesOwnName(sql, ref.table)) continue;
    out.push(table);
  }
  return out;
}

/** The gold's tables that the prediction never reads, in the order the gold names them. */
export function missingGoldTables(gold: string, predicted: string): readonly string[] {
  const read = new Set(tablesOf(predicted));
  return tablesOf(gold).filter((table) => !read.has(table));
}

/**
 * The tables the prediction reads that the gold never does.
 *
 * The direction that matters for a residue of `under` cases: every extra table is another join, an
 * inner join is an intersection, and a chain of them returns *fewer* rows than the answer — which
 * is the shape 15 to 20 cases of every arm turn out to have. It is a reading of the text, not of
 * the engine, and it is reported beside the direction rather than as a cause of it: a statement can
 * read an extra table and still be under for an unrelated reason.
 */
export function extraPredictionTables(gold: string, predicted: string): readonly string[] {
  const read = new Set(tablesOf(gold));
  return tablesOf(predicted).filter((table) => !read.has(table));
}

/**
 * Whether the statement caps its answer at a top-level `limit`.
 *
 * The mechanical half of `under`, and the cheapest lever this project has ever found: a statement
 * that answers correctly and then keeps one row is a case where the *answer* was right. `limit` is
 * read at depth zero, so a `limit` inside a subquery — which is how a top-N per group is written —
 * is not counted as a cap on the whole answer.
 */
export function hasLimit(sql: string): boolean {
  return limitSpan(sql) !== undefined;
}

/** Where a top-level `limit` clause starts and ends, `offset` included, or `undefined`. */
function limitSpan(sql: string): { readonly start: number; readonly end: number } | undefined {
  const words = topLevelWords(sql);
  const opening = words.find((entry) => entry.word === 'limit');
  if (opening === undefined) return undefined;
  // `offset` is not a boundary: it belongs to the `limit` it follows, and a span that stopped in
  // front of it would leave `offset 1` in a statement with no `limit` to apply it to.
  const closesAt = words.find((entry) => entry.start > opening.start && ['union', 'except', 'intersect', 'returning'].includes(entry.word));
  return { start: opening.start, end: closesAt?.start ?? endOfStatement(sql) };
}

/**
 * The statement with its top-level `limit` clause removed.
 *
 * The edit behind the cheapest lever this project has: a statement that answers the question and
 * then keeps the first row. `offset` goes with the `limit` it belongs to, and a `limit` inside a
 * subquery is left alone — a top-N per group is part of the answer, and removing it would be a
 * different repair wearing this one's name.
 */
export function withoutLimit(sql: string): string {
  const span = limitSpan(sql);
  if (span === undefined) return sql;
  return `${sql.slice(0, span.start)}${sql.slice(span.end)}`.replace(/\s+/g, ' ').replace(/\s+;/, ';').trim();
}

/**
 * Whether nothing in this file explains an `over` case.
 *
 * The floor, as a function rather than an expression inside the loop, because the corpus may hold
 * no case of it on a given run and a reading whose branch is only reachable from data is a reading
 * whose branch is untested. `over` with the gold's filter in place, every gold table read, and no
 * condition outside the `where` is the residue this instrument cannot attribute: the read-set is
 * too wide and no clause it knows about is why.
 */
export function isUnattributedOver(
  kind: ResidueKind,
  site: ConditionSite | undefined,
  missingTables: readonly string[],
): boolean {
  return kind === 'over' && site === undefined && missingTables.length === 0;
}

export interface ResidueTally {
  readonly total: number;
  readonly kinds: Readonly<Record<ResidueKind, number>>;
  /** Cases one of this file's edits repaired: `capped`. An oracle's number, not a forecast. */
  readonly repairedByAnEditTriedHere: number;
}

export function tallyResidue(kinds: readonly ResidueKind[]): ResidueTally {
  const counts = RESIDUE_KINDS.reduce((acc, kind) => ({ ...acc, [kind]: 0 }), {} as Record<ResidueKind, number>);
  for (const kind of kinds) counts[kind] += 1;
  return { total: kinds.length, kinds: counts, repairedByAnEditTriedHere: counts.capped };
}

/** The share of one kind, as a percentage with one decimal, or `0.0` over an empty set. */
function share(count: number, total: number): string {
  return total === 0 ? '0.0' : ((count / total) * 100).toFixed(1);
}

/**
 * The report: one line per kind, then the count the one repair accounts for.
 *
 * The repair line exists because `capped` is the only kind in this file a deployment can act on
 * without a model: strip the `limit`, check the answer, and the case is fixed or it is not. Printed
 * as a count and a share of the residue so the ceiling of that guard is a number rather than an
 * argument.
 */
export function residueLines(tally: ResidueTally): string[] {
  const lines = RESIDUE_KINDS.map(
    (kind) => `  ${kind.padEnd(12)} ${String(tally.kinds[kind]).padStart(4)}  ${share(tally.kinds[kind], tally.total).padStart(5)}%`,
  );
  lines.push(
    `  repaired by stripping a limit the gold does not have: ${String(tally.repairedByAnEditTriedHere)} of ${String(tally.total)}` +
      (tally.total === 0 ? '' : ` (${share(tally.repairedByAnEditTriedHere, tally.total)}%)`),
  );
  return lines;
}

export interface ResidueCrossTabs {
  /** Residue cases whose gold states conditions a `where` graft cannot carry. */
  readonly conditions: Readonly<Record<ConditionSite, number>>;
  /** Residue cases whose gold reads a table the prediction never does. */
  readonly missingTable: number;
  /** Residue cases whose prediction reads a table the gold never does: one more join, one less row. */
  readonly extraTable: number;
  /** Residue cases whose prediction caps its answer with a `limit` the gold does not have. */
  readonly capped: number;
  /** `under` cases that also join an extra table: the tightening this file exists to find. */
  readonly underWithExtraTable: number;
  /** `over` cases that also miss a table the gold reads. */
  readonly overWithMissingTable: number;
  /** `over` cases with neither explanation: the statement's own read-set is too wide. */
  readonly unattributedOver: number;
  /** How often each gold table is the one the prediction never reads. */
  readonly missingTables: Readonly<Record<string, number>>;
  /** How often each table is the one the prediction reads beyond the gold. */
  readonly extraTables: Readonly<Record<string, number>>;
  readonly unreadable: number;
}

/**
 * The readings that explain the split instead of extending it.
 *
 * Three of them, and the third is the point: `unattributedOver` is the set no explanation in this
 * file covers — the gold's conditions are all in its `where`, the same tables are read, and the
 * statement still returns rows the answer does not have. It is reported as a floor rather than
 * assigned to a clause, because assigning it is what the previous rung did and this round is the
 * correction.
 */
export function residueExtraLines(tally: ResidueTally, cross: ResidueCrossTabs): string[] {
  const lines: string[] = [];
  const conditions = cross.conditions.on + cross.conditions.having;
  lines.push(
    `  golds stating conditions a where-graft cannot carry: ${String(conditions)} of ${String(tally.total)}` +
      (tally.total === 0 ? '' : ` (${share(conditions, tally.total)}%)`) +
      ` — on ${String(cross.conditions.on)}, having ${String(cross.conditions.having)}`,
  );
  lines.push(
    `  golds reading a table the prediction never does: ${String(cross.missingTable)} of ${String(tally.total)}` +
      (tally.total === 0 ? '' : ` (${share(cross.missingTable, tally.total)}%)`) +
      ` — ${String(cross.overWithMissingTable)} of them over`,
  );
  lines.push(
    `  predictions reading a table the gold never does: ${String(cross.extraTable)} of ${String(tally.total)}` +
      (tally.total === 0 ? '' : ` (${share(cross.extraTable, tally.total)}%)`) +
      ` — ${String(cross.underWithExtraTable)} of them under: one more join, one less row`,
  );
  const tables = Object.entries(cross.extraTables).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (tables.length > 0) lines.push(`  tables read beyond the gold most often: ${tables.map(([table, count]) => `${table} ${String(count)}`).join(', ')}`);
  lines.push(
    `  capped by a limit the gold does not have: ${String(cross.capped)} of ${String(tally.total)}` +
      (tally.total === 0 ? '' : ` (${share(cross.capped, tally.total)}%)`) +
      ` — stripping it repairs ${String(tally.kinds.capped)}`,
  );
  lines.push(
    `  unattributed: ${String(cross.unattributedOver)} of ${String(tally.total)}` +
      (tally.total === 0 ? '' : ` (${share(cross.unattributedOver, tally.total)}%)`) +
      ' — over, same tables, the gold\'s own filter, so the read-set itself is too wide',
  );
  if (cross.unreadable > 0) {
    lines.push(
      `  ${String(cross.unreadable)} case(s) this tool could not read: counted, not failed, because the construct is a property of the corpus`,
    );
  }
  return lines;
}

/**
 * What has to be true for the split to be a reading.
 *
 * One condition, and it is about the denominator: an empty residue prints `0 of 0` as `0.0%` and
 * reads like a measured zero. A refused statement is deliberately not a failure — the discipline
 * `surplus.ts` states for its refusals, for the same reason: an artifact where part of the residue
 * holds a construct this tool cannot run would make every future run red, and a gate nobody can
 * satisfy is a gate nobody reads.
 */
export function residueProblems(tally: ResidueTally): string[] {
  const problems: string[] = [];
  if (tally.total === 0) problems.push('RES: no case in this artifact survived the predicate graft, so there is no residue to read');
  return problems;
}

export interface ResidueSettings {
  readonly root: string;
  readonly artifact: string;
  readonly arm: string;
  readonly layout: BirdLayout;
}

export const DEFAULT_RESIDUE_ARM = 'metadata+evidence';

export function resolveResidueSettings(
  argv: readonly string[],
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): ResidueSettings {
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
  return { root, artifact: artifact ?? layout.out, arm: arm ?? DEFAULT_RESIDUE_ARM, layout };
}

/** Where the artifact goes, named by the arm so two arms do not overwrite each other. */
export function residuePath(settings: { readonly root: string; readonly arm: string }): string {
  const safe = settings.arm.replace(/[^a-z0-9+-]/gi, '_');
  return join(settings.root, 'eval', 'out', `residue-${safe}.json`);
}

export interface ResidueDrops {
  readonly passed: number;
  readonly otherArm: number;
  readonly otherReason: number;
  readonly unretained: number;
  readonly unknownQuestion: number;
  readonly goldFailed: number;
  readonly engineRefused: number;
  readonly otherShape: number;
  readonly otherForm: number;
  /** The predicate graft repairs it, so `surplus.ts` counts it and this tool must not. */
  readonly predicate: number;
  /** The graft matches only under the official rule: repetition the judge folds, not a case here. */
  readonly duplicates: number;
  /** The graft itself was refused: a self-join, a nested statement, or a table the gold reads. */
  readonly graftRefused: number;
}

export interface ResidueRow {
  readonly id: string;
  readonly db: string;
  readonly kind: ResidueKind;
  readonly goldRows: number;
  readonly predictedRows: number;
  readonly conditionsOutsideWhere?: ConditionSite;
  readonly missingGoldTables?: readonly string[];
  readonly extraPredictionTables?: readonly string[];
  /** The prediction caps its answer with a `limit`, and the gold does not. */
  readonly capped?: boolean;
}

export interface ResidueOutcome {
  readonly split: string;
  readonly arm: string;
  readonly tally: ResidueTally;
  readonly cross: ResidueCrossTabs;
  readonly unreadableIds: readonly string[];
  readonly drops: ResidueDrops;
  readonly rows: readonly ResidueRow[];
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

export async function runResidue(settings: ResidueSettings): Promise<ResidueOutcome> {
  const body = JSON.parse(readFileSync(settings.artifact, 'utf8')) as EvalArtifact;
  const split = body.split === 'dev' || body.split === 'minidev' ? body.split : settings.layout.split;
  // The paths stay the caller's even when the artifact names another split: a harness pointed at a
  // dataset outside the repository must not fall back to `eval/.cache` and read a corpus it was not
  // given. The rule `surplus.ts` follows, for the same reason.
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
    predicate: 0,
    duplicates: 0,
    graftRefused: 0,
  };
  const rows: ResidueRow[] = [];
  const unreadableIds: string[] = [];
  const conditions = { having: 0, on: 0 };
  const missingTables: Record<string, number> = {};
  const extraTablesSeen: Record<string, number> = {};
  let missingTable = 0;
  let extraTable = 0;
  let capped = 0;
  let underWithExtraTable = 0;
  let overWithMissingTable = 0;
  let unattributedOver = 0;

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
      if (classifyFailureShape(predicted, gold.rows).shape !== 'row-count') {
        drops.otherShape += 1;
        continue;
      }
      if (!readsSameShape(question.SQL, row.sql)) {
        drops.otherForm += 1;
        continue;
      }
      const base = { id: String(row.id), db: question.db_id, goldRows: gold.rows.length, predictedRows: predicted.rows.length };
      const graft = graftPredicate(row.sql, question.SQL);
      if (graft.sql === undefined) {
        // A self-join, a nested statement or a missing table: the previous rung counts these as its
        // own kinds, so they are neither this tool's population nor its business to re-count.
        drops.graftRefused += 1;
        continue;
      }
      const grafted = await oracle.run(question.db_id, graft.sql);
      if (!grafted.ok) {
        unreadableIds.push(String(row.id));
        rows.push({ ...base, kind: 'unreadable' });
        continue;
      }
      if (judgeStrict(gold.rows, grafted.rows) === 'match') {
        drops.predicate += 1;
        continue;
      }
      // The official rule is the fan-out's bucket: a case it credits was folded to a match by
      // `set()`, and that is exactly a statement whose surplus is repetition. It belongs to
      // `surplus.ts`'s `duplicates` and not here — which is the arithmetic that makes "split the
      // fan-out from the missing `distinct`" a question this file does not have to ask.
      if (judgeOfficial(gold.rows, grafted.rows) === 'match') {
        drops.duplicates += 1;
        continue;
      }

      // The cheapest repair first, and the only one that is a repair: a statement that answers the
      // question and then keeps fewer rows than asked is truncating a right answer. The probe runs
      // on the statement the model wrote, not on the graft, because the claim is about that
      // statement: strip its own `limit` and the answer is the gold's.
      const goldLimit = hasLimit(question.SQL);
      const cappedHere = !goldLimit && hasLimit(row.sql);
      if (cappedHere) {
        capped += 1;
        const stripped = await oracle.run(question.db_id, withoutLimit(row.sql));
        if (stripped.ok && judgeStrict(gold.rows, stripped.rows) === 'match') {
          rows.push({ ...base, kind: 'capped', capped: true });
          continue;
        }
      }

      const kind = directionOf(gold.rows, grafted.rows);
      const site = conditionsOutsideWhere(question.SQL);
      if (site !== undefined) conditions[site] += 1;
      const missing = missingGoldTables(question.SQL, row.sql);
      if (missing.length > 0) {
        missingTable += 1;
        for (const table of missing) missingTables[table] = (missingTables[table] ?? 0) + 1;
      }
      const extra = extraPredictionTables(question.SQL, row.sql);
      if (extra.length > 0) {
        extraTable += 1;
        for (const table of extra) extraTablesSeen[table] = (extraTablesSeen[table] ?? 0) + 1;
      }
      if (kind === 'under' && extra.length > 0) underWithExtraTable += 1;
      if (kind === 'over' && missing.length > 0) overWithMissingTable += 1;
      if (isUnattributedOver(kind, site, missing)) unattributedOver += 1;
      rows.push({
        ...base,
        kind,
        ...(site === undefined ? {} : { conditionsOutsideWhere: site }),
        ...(missing.length === 0 ? {} : { missingGoldTables: missing }),
        ...(extra.length === 0 ? {} : { extraPredictionTables: extra }),
        ...(cappedHere ? { capped: true } : {}),
      });
    }
  } finally {
    await oracle.close();
  }

  const tally = tallyResidue(rows.map((row) => row.kind));
  return {
    split,
    arm: settings.arm,
    tally,
    cross: {
      conditions,
      missingTable,
      extraTable,
      capped,
      underWithExtraTable,
      overWithMissingTable,
      unattributedOver,
      missingTables,
      extraTables: extraTablesSeen,
      unreadable: unreadableIds.length,
    },
    unreadableIds,
    drops,
    rows,
    problems: residueProblems(tally),
  };
}

export function writeResidueArtifact(settings: ResidueSettings, outcome: ResidueOutcome): string {
  const path = residuePath({ root: settings.root, arm: outcome.arm });
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
  const settings = resolveResidueSettings(argv, root, env);
  const outcome = await runResidue(settings);
  const path = writeResidueArtifact(settings, outcome);
  console.log(`residue · ${outcome.arm} · ${outcome.split} · ${String(outcome.tally.total)} case(s) survived the predicate graft`);
  for (const line of residueLines(outcome.tally)) console.log(line);
  for (const line of residueExtraLines(outcome.tally, outcome.cross)) console.log(line);
  console.log(
    `  dropped: ${String(outcome.drops.passed)} passed, ${String(outcome.drops.predicate)} repaired by the predicate graft, ` +
      `${String(outcome.drops.duplicates)} repetition the judge folds, ${String(outcome.drops.graftRefused)} refused a graft, ` +
      `${String(outcome.drops.otherForm)} another grain, ${String(outcome.drops.otherShape)} another shape, ` +
      `${String(outcome.drops.unretained)} without a statement`,
  );
  console.log(`  written to ${path}`);
  for (const problem of outcome.problems) console.log(`  ${problem}`);
  return outcome.problems.length === 0 ? 0 : 1;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
