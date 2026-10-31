/**
 * Which columns a question needs, as the model reads them.
 *
 * Three instruments already price the card from outside the model: the card measurement says
 * 74.1% of a prompt is the schema card and 58.4% of that belongs to tables the gold statement
 * never reads; the join measurement says one hop over the declared foreign keys keeps every
 * gold table for 95.2% of cases; `select-prune` ships that rule and loses 1.4pp, because the
 * closure reaches the wrong tables for the questions the linker already misses. Every one of
 * them decides *which tables* to keep, and none of them asks the model.
 *
 * This module is the other mechanism, and the one the competitor reading points at: MAC-SQL's
 * selector hands the model the schema and the question and lets it name the columns, which is
 * a different source of truth about relevance — the model's reading of the question rather than
 * a lexical linker's. It is deliberately the *only* file-selection mechanism in the lever: no
 * closure, no linker, no fallback ordering. If the model names nothing usable, the whole card is
 * sent, which is the same doctrine as `prune`'s "no seed" branch — a card built from an empty
 * choice is a prompt with no schema, the one failure no wording can repair.
 *
 * Two things this module does not do, both on purpose:
 *
 * 1. **It does not validate the choice against the gold statement.** The question "would this
 *    have kept every column the answer needs" is an oracle's question; the arm is measured on
 *    accuracy instead, and the cases where the choice drops a needed column are the price.
 * 2. **It does not preserve join keys speculatively.** A column named in a join hint is kept
 *    when *both* tables it connects survive the choice, because a join across a dropped table
 *    cannot be written and a key kept for a join nobody can make is a column the model pays
 *    for and cannot use.
 */
import type { SchemaTable } from '@agentix-e/nl2charts-ai';

/** One column, resolved against a card. */
export interface NamedColumn {
  readonly table: string;
  readonly column: string;
}

/** What the model named, and what of it the card could resolve. */
export interface ColumnChoice {
  /** Resolved names, in card order and deduplicated. */
  readonly named: readonly NamedColumn[];
  /** Names the reply contained that are not columns of this card. */
  readonly unknown: readonly string[];
  /** True when at least one name resolved. False means the whole card is sent instead. */
  readonly decided: boolean;
}

/** A card after a choice, with the numbers the artifact reports. */
export interface ColumnApplication {
  readonly schema: readonly SchemaTable[];
  /** Columns the card now carries. */
  readonly kept: number;
  /** Columns it carried before the choice. */
  readonly total: number;
  /** Tables the card now carries, in card order. */
  readonly keptTables: readonly string[];
}

const QUALIFIED = /([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)/g;

/**
 * The question and the columns, in the shape a model can answer with a list.
 *
 * Comments are included because that is the knowledge the arm has: `status TEXT -- active or
 * banned` is what makes "banned accounts" resolvable to a column, and stripping it would price
 * a blind selector rather than this one. The header says "only these names" because a reply
 * that invents a name is a reply the parser has to throw away, and throwing it away is a case
 * the arm pays for rather than a case it silently repairs.
 */
export function buildColumnPrompt(question: string, schema: readonly SchemaTable[]): string {
  const lines: string[] = [];
  for (const table of schema) {
    for (const column of table.columns) {
      const base = `${table.table}.${column.name} ${column.type}`;
      lines.push(column.comment === undefined ? base : `${base} -- ${column.comment}`);
    }
  }
  return [
    'You choose the columns a SQL query will need to answer a question.',
    '',
    'Question:',
    question,
    '',
    'Columns available:',
    ...lines,
    '',
    'Reply with one line per column you need, written as `table.column`, and nothing else.',
    'Name only columns from the list above. If you need a join, name the key columns of both tables.',
  ].join('\n');
}

/**
 * Read a reply as a set of columns.
 *
 * Qualified names are matched first and bare names second, because a model that answers
 * `customer_id` has made a choice and one that answers `orders.customer_id` has made a better
 * one; refusing the first would price the parser instead of the mechanism. A bare name that
 * matches two tables resolves to both — the choice was ambiguous, and the card can afford the
 * second column far better than it can afford a wrong one.
 */
export function parseColumnChoice(reply: string, schema: readonly SchemaTable[]): ColumnChoice {
  const index = new Map<string, NamedColumn>();
  const byColumn = new Map<string, NamedColumn[]>();
  for (const table of schema) {
    for (const column of table.columns) {
      const entry = { table: table.table, column: column.name };
      index.set(`${table.table.toLowerCase()}\u0000${column.name.toLowerCase()}`, entry);
      const key = column.name.toLowerCase();
      byColumn.set(key, [...(byColumn.get(key) ?? []), entry]);
    }
  }
  const order = new Map<string, number>();
  let position = 0;
  for (const table of schema) {
    for (const column of table.columns) {
      order.set(`${table.table.toLowerCase()}\u0000${column.name.toLowerCase()}`, position);
      position += 1;
    }
  }
  const resolved = new Map<string, NamedColumn>();
  const unknown: string[] = [];
  const text = reply.replace(/```[a-z]*/gi, ' ');
  const qualified: string[] = [];
  for (const match of text.matchAll(QUALIFIED)) {
    const [whole, table, column] = match;
    qualified.push(whole);
    const key = `${(table as string).toLowerCase()}\u0000${(column as string).toLowerCase()}`;
    const hit = index.get(key);
    if (hit === undefined) unknown.push(whole);
    else resolved.set(key, hit);
  }
  // Bare names are read from the words that were not part of a qualified match, so a qualified
  // name cannot also count as a bare one and inflate the choice with the same column twice.
  const rest = text.replace(QUALIFIED, ' ');
  for (const word of rest.match(/[A-Za-z_][\w$]*/g) ?? []) {
    const key = word.toLowerCase();
    const hits = byColumn.get(key);
    if (hits === undefined) continue;
    for (const hit of hits) resolved.set(`${hit.table.toLowerCase()}\u0000${hit.column.toLowerCase()}`, hit);
  }
  const named = [...resolved.entries()]
    .sort(([left], [right]) => (order.get(left) as number) - (order.get(right) as number))
    .map(([, entry]) => entry);
  return { named, unknown, decided: named.length > 0 };
}

/** The join pairs a card declares, as lower-cased `table\u0000column` keys on both sides. */
function joinPairs(schema: readonly SchemaTable[]): readonly (readonly [string, string])[] {
  const pairs: [string, string][] = [];
  for (const table of schema) {
    for (const hint of table.foreignKeys ?? []) {
      const [left, right] = hint.split('=').map((side) => side.trim());
      if (left === undefined || right === undefined) continue;
      const [leftTable, leftColumn] = left.split('.');
      const [rightTable, rightColumn] = right.split('.');
      if (leftTable === undefined || leftColumn === undefined || rightTable === undefined || rightColumn === undefined) continue;
      pairs.push([
        `${leftTable.toLowerCase()}\u0000${leftColumn.toLowerCase()}`,
        `${rightTable.toLowerCase()}\u0000${rightColumn.toLowerCase()}`,
      ]);
    }
  }
  return pairs;
}

/**
 * Send only what was chosen, plus the keys that make the chosen tables joinable.
 *
 * The whole card comes back when nothing resolved: `decided: false` is reported as its own
 * state, so "the model chose nothing" and "the model chose the whole card" stay different
 * numbers. Table order is the card's own, for the reason `prune` states — the renderer's order
 * is part of the prompt, and re-sorting by choice would move tables for a reason that is not
 * the lever.
 */
export function applyColumnChoice(schema: readonly SchemaTable[], choice: ColumnChoice): ColumnApplication {
  const total = schema.reduce((count, table) => count + table.columns.length, 0);
  if (!choice.decided) {
    return { schema, kept: total, total, keptTables: schema.map((table) => table.table) };
  }
  const keptTables = new Set(choice.named.map((entry) => entry.table.toLowerCase()));
  const keys = new Set(choice.named.map((entry) => `${entry.table.toLowerCase()}\u0000${entry.column.toLowerCase()}`));
  for (const [left, right] of joinPairs(schema)) {
    const leftTable = left.split('\u0000')[0] as string;
    const rightTable = right.split('\u0000')[0] as string;
    if (!keptTables.has(leftTable) || !keptTables.has(rightTable)) continue;
    keys.add(left);
    keys.add(right);
  }
  let kept = 0;
  const keptNames: string[] = [];
  const pruned = schema
    .filter((table) => keptTables.has(table.table.toLowerCase()))
    .map((table) => {
      const columns = table.columns.filter((column) => keys.has(`${table.table.toLowerCase()}\u0000${column.name.toLowerCase()}`));
      kept += columns.length;
      keptNames.push(table.table);
      return { ...table, columns };
    });
  return { schema: pruned, kept, total, keptTables: keptNames };
}
