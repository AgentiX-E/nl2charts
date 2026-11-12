/**
 * A statement read back into the steps that produced it.
 *
 * OpenSearch-SQL, which reached 69.3% on BIRD without training a single weight, credits two of
 * its mechanisms for the lead: few-shot examples shaped as (question, reasoning, SQL) rather
 * than (question, SQL), and a constrained intermediate language it calls "SQL-Like" whose job is
 * to make the pieces of a query explicit before the query is written. This module is that
 * intermediate language, read backwards.
 *
 * ## Why backwards
 *
 * The paper's version is self-taught: a strong model writes the reasoning for each training
 * question, and the pairs are retrieved as demonstrations. That costs one call per training row
 * and inherits whatever that model got wrong. Recovering the steps from the labelled statement
 * costs nothing, cannot invent a claim the gold statement does not make, and is available for
 * every row in the corpus rather than the ones a budget covered.
 *
 * What it cannot do is produce a step the statement does not encode. A statement that answers
 * "which region had the most refunded orders" does not say *why* the aggregation is a count, so
 * the reasoning block says `Intent: count` and stops. That is the honest half: the shape of the
 * query is what transfers between schemas, and the shape is exactly what a statement records.
 *
 * ## What it refuses, and why the refusal is the point
 *
 * A wrong reasoning block is worse than no block. The repository already paid for this lesson
 * once: `isDefinition` exists because a retrieved evidence line mapping "free" to `lowest_price
 * = 0` taught the model a false equivalence, and a demonstration that teaches a wrong
 * decomposition teaches it in the position the model trusts most — the worked example.
 *
 * So the reader returns `undefined` for every shape it cannot decompose with certainty:
 * subqueries, set operations, CTEs, window functions, and anything that does not start with
 * `SELECT`. A caller that wants a demonstration skips the row rather than rendering half of one;
 * a caller that wants a reasoning instruction keeps the instruction and drops the example.
 */
import { clauseAt, splitKeys } from './null-order.js';

/** The aggregate a projection reduces to, or `rows` when it projects columns. */
export type SqlLikeIntent = 'rows' | 'count' | 'sum' | 'avg' | 'max' | 'min';

export interface SqlLike {
  readonly intent: SqlLikeIntent;
  /** Tables in `FROM`, base table first, with aliases removed. */
  readonly tables: readonly string[];
  /** Equality predicates that relate two columns, whether written in `ON` or in `WHERE`. */
  readonly joins: readonly string[];
  /** Predicates that restrict one side to a value or a range. */
  readonly filters: readonly string[];
  readonly group: readonly string[];
  readonly having: readonly string[];
  readonly order: readonly string[];
  /** The row cap, when the statement has one. */
  readonly limit?: string;
}

/** A bare `column` or `alias.column` — what makes an equality a join rather than a filter. */
const COLUMN_REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** `join`, `left outer join`, `cross join`, and the rest, as a clause boundary. */
const JOIN = /\b(?:(?:left|right|full|inner|cross|natural)\s+)*(?:outer\s+)?join\b/i;

/** The aggregate that opens a projection, which decides the intent. */
const AGGREGATE_HEAD = /^(count|sum|avg|max|min)\s*\(/i;

interface Clause {
  readonly select?: string;
  readonly from?: string;
  readonly where?: string;
  readonly group?: string;
  readonly having?: string;
  readonly order?: string;
  readonly limit?: string;
}

const NAMES = ['select', 'from', 'where', 'group by', 'having', 'order by', 'limit'] as const;

/**
 * Cut the statement at its top-level clauses.
 *
 * Every boundary comes from `clauseAt`, which reads parenthesis depth and quotes, so a `from`
 * inside a string literal or a `order by` inside a window function is not a boundary. That is the
 * same walk `guardNullOrder` uses, and for the same reason: a statement is not a bag of words.
 */
function slice(sql: string): Clause {
  const found: { name: string; start: number; end: number }[] = [];
  for (const name of NAMES) {
    const end = clauseAt(sql, name);
    if (end === undefined) continue;
    found.push({ name, start: end - name.length, end });
  }
  found.sort((left, right) => left.start - right.start);
  const pieces: Record<string, string> = {};
  for (let at = 0; at < found.length; at += 1) {
    const current = found[at] as { name: string; start: number; end: number };
    const next = found[at + 1];
    pieces[current.name] = sql.slice(current.end, next === undefined ? sql.length : next.start).trim();
  }
  return {
    select: pieces.select,
    from: pieces.from,
    where: pieces.where,
    group: pieces['group by'],
    having: pieces.having,
    order: pieces['order by'],
    limit: pieces.limit,
  };
}

/** The table a `FROM` chunk names, with its alias and any join condition removed. */
function tableName(chunk: string): string | undefined {
  // `split` returns at least one element and `splitKeys` has already dropped empty pieces, so
  // the head is never blank here: the two guards that tested for a blank head and an undefined
  // first token were branches no input could reach, and a guard that cannot fire is a claim a
  // reader has to disprove (ADR-219).
  const head = (chunk.split(JOIN)[0] as string).trim();
  const name = head.split(/\s+/)[0] as string;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : undefined;
}

/**
 * Split a conjunction at its top-level `and`.
 *
 * `or` is deliberately not split: `a = 1 or a = 2` is one condition with two arms, and listing it
 * as two conditions would tell the reader the question has two requirements when it has one. The
 * whole disjunction is kept as a single filter, which is what it is.
 */
function conjunction(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  const lower = clause.toLowerCase();
  for (let at = 0; at < clause.length; at += 1) {
    const character = clause.charAt(at);
    if (quote !== undefined) {
      if (character === quote) {
        if (clause.charAt(at + 1) === quote) at += 1;
        else quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (depth === 0 && lower.startsWith('and', at)) {
      // `charAt(-1)` is the empty string and fails the test below, so a clause that opened with
      // `and` needs no separate branch: the earlier version had one, and no statement can reach
      // it.
      const before = lower.charAt(at - 1);
      const after = lower.charAt(at + 3);
      if (!/[a-z0-9_]/.test(before) && !/[a-z0-9_.]/.test(after)) {
        parts.push(clause.slice(start, at));
        start = at + 3;
      }
    }
  }
  parts.push(clause.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** True when the predicate relates two column references, which is a join written as a filter. */
function relatesColumns(predicate: string): boolean {
  const parts = predicate.split('=');
  if (parts.length !== 2) return false;
  const [left, right] = parts as [string, string];
  return COLUMN_REFERENCE.test(left.trim()) && COLUMN_REFERENCE.test(right.trim());
}

/**
 * Read a statement into its steps, or refuse.
 *
 * The five refusals below are not defensive programming; each one names a shape whose steps this
 * reader cannot recover, and rendering a guess for it would put a fabricated decomposition in
 * front of a model that is being asked to imitate it.
 */
export function parseSqlLike(sql: string): SqlLike | undefined {
  const text = sql.trim().replace(/\s+/g, ' ');
  if (text === '') return undefined;
  if (!/^select\b/i.test(text)) return undefined;
  // A CTE, a set operation or a subquery has more than one statement's worth of steps, and which
  // one the question is about is not recoverable from the text.
  if (clauseAt(text, 'union') !== undefined) return undefined;
  if (clauseAt(text, 'intersect') !== undefined) return undefined;
  if (clauseAt(text, 'except') !== undefined) return undefined;
  if (/\(\s*select\b/i.test(text)) return undefined;
  // A window function sorts rows the query has already chosen; its `order by` is not the query's.
  if (/\bover\s*\(/i.test(text)) return undefined;

  const clauses = slice(text);
  const select = clauses.select;
  const from = clauses.from;
  if (select === undefined || select === '') return undefined;
  if (from === undefined || from === '') return undefined;

  const aggregate = AGGREGATE_HEAD.exec(select);
  const intent: SqlLikeIntent = aggregate === null ? 'rows' : (aggregate[1] as string).toLowerCase() as SqlLikeIntent;

  const fromChunks = from.split(JOIN);
  const tables: string[] = [];
  const joins: string[] = [];
  for (let at = 0; at < fromChunks.length; at += 1) {
    const chunk = fromChunks[at] as string;
    for (const piece of splitKeys(chunk)) {
      const name = tableName(piece);
      if (name !== undefined && !tables.includes(name)) tables.push(name);
    }
  }
  // `A JOIN B ON a.x = b.y` — the condition belongs to the join, and every `on` in the `FROM`
  // clause is one, because `splitKeys` has already separated the comma-joined tables.
  for (const match of from.matchAll(/\bon\b([\s\S]*?)(?=\b(?:(?:left|right|full|inner|cross|natural)\s+)*(?:outer\s+)?join\b|$)/gi)) {
    const condition = (match[1] as string).trim();
    if (condition !== '') joins.push(condition);
  }
  if (tables.length === 0) return undefined;

  const filters: string[] = [];
  for (const predicate of clauses.where === undefined ? [] : conjunction(clauses.where)) {
    if (relatesColumns(predicate)) joins.push(predicate);
    else filters.push(predicate);
  }

  return {
    intent,
    tables,
    joins: [...new Set(joins)],
    filters,
    group: clauses.group === undefined ? [] : splitKeys(clauses.group),
    having: clauses.having === undefined ? [] : splitKeys(clauses.having),
    order: clauses.order === undefined ? [] : splitKeys(clauses.order),
    ...(clauses.limit === undefined ? {} : { limit: clauses.limit }),
  };
}

/**
 * The steps as lines, one per clause the statement actually has.
 *
 * Keys are lower case and values keep the statement's own spelling: this block is read by a model
 * being asked to imitate a shape, and a shape whose labels vary between examples is not a shape.
 */
export function renderSqlLike(sql: string): string | undefined {
  const parsed = parseSqlLike(sql);
  if (parsed === undefined) return undefined;
  const lines = [`Intent: ${parsed.intent}`, `Tables: ${parsed.tables.join(', ')}`];
  if (parsed.joins.length > 0) lines.push(`Joins: ${parsed.joins.join('; ')}`);
  if (parsed.filters.length > 0) lines.push(`Filters: ${parsed.filters.join('; ')}`);
  if (parsed.group.length > 0) lines.push(`Group: ${parsed.group.join(', ')}`);
  if (parsed.having.length > 0) lines.push(`Having: ${parsed.having.join(', ')}`);
  if (parsed.order.length > 0) lines.push(`Order: ${parsed.order.join(', ')}`);
  if (parsed.limit !== undefined && parsed.limit !== '') lines.push(`Limit: ${parsed.limit}`);
  return lines.join('\n');
}

/**
 * What the prompt tells the model to write before the statement.
 *
 * The steps are the same eight labels `renderSqlLike` emits, because a demonstration and an
 * instruction that named different steps would teach two formats and the model would average
 * them. Written as a constraint rather than a suggestion: OpenSearch-SQL's finding is that the
 * intermediate language works because it is structured, and a free-form "think first" is the
 * `decompose` rule this repository already measured at a loss.
 */
export const SQL_LIKE_RULES = [
  'Before the statement, write these lines — one per line, in this order, omitting a line only when the clause is absent:',
  'Intent: rows|count|sum|avg|max|min',
  'Tables: <table>, <table>',
  'Joins: <predicate>; <predicate>',
  'Filters: <predicate>; <predicate>',
  'Group: <key>, <key>',
  'Having: <predicate>',
  'Order: <key> <asc|desc>',
  'Limit: <n>',
  'Name every condition the question states in Filters, one per condition, before deciding how to combine them.',
  'Then write the statement in a ```sql block. The lines before it are read as notes and are not executed.',
];
