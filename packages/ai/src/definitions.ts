/**
 * Semantics from structure, not from a data dictionary.
 *
 * The external benchmark ships one human-written sentence per question ("the
 * evidence"). A customer database does not. The previous round measured that
 * gap: the dataset hint was worth +12.1pp on BIRD Mini-Dev, while a profile of
 * the data itself was worth +1.7pp — so the missing information is not values,
 * it is meaning.
 *
 * This module recovers the part of that meaning which is derivable from the
 * schema alone: which column identifies a row, which table a foreign key points
 * at and in which direction rows multiply, what kind of quantity a column holds,
 * and which names are reused across tables with different scopes. Every claim is
 * name- or declaration-derived and is phrased as such; nothing here invents a
 * business definition that the database does not support.
 *
 * The renderer is pure. It is also deliberately compact: the block competes for
 * the same attention as the schema card, and a definition that pushes a real
 * column out of the prompt is a net loss.
 */

import { words } from './text.js';

export type ColumnRole =
  | 'identifier'
  | 'amount'
  | 'count'
  | 'ratio'
  | 'flag'
  | 'date'
  | 'timestamp'
  | 'text'
  | 'number'
  | 'other';

export interface DefinitionOptions {
  /** Hard character budget; the block is cut at the last complete line. */
  readonly maxChars?: number;
  /** How many reused column names to spell out. Two is enough to teach the rule. */
  readonly maxAmbiguous?: number;
}

const AMOUNT = new Set([
  'amount',
  'amt',
  'balance',
  'budget',
  'charge',
  'cost',
  'discount',
  'fee',
  'income',
  'payment',
  'price',
  'profit',
  'revenue',
  'salary',
  'sales',
  'spend',
  'tax',
  'total',
  'value',
]);
// 'number' is deliberately absent: in BIRD it names codes ("Charter School
// Number"), and a wrong gloss costs a line that a real measure needed.
const COUNT = new Set(['cnt', 'count', 'num', 'qty', 'quantity']);
const RATIO = new Set(['fraction', 'pct', 'percent', 'percentage', 'proportion', 'rate', 'ratio', 'share']);
const FLAG = new Set(['active', 'bool', 'boolean', 'enabled', 'flag']);
// Months and years are labels in most warehouses ("Academic Year" holds
// '2012-2013'), so only explicit date words promote a column to a date.
const DATE = new Set(['date', 'day']);
const TIME = new Set(['at', 'datetime', 'time', 'timestamp']);

const IRREGULAR: Record<string, string> = {
  children: 'child',
  data: 'record',
  men: 'man',
  people: 'person',
  series: 'series',
  species: 'species',
  women: 'woman',
};

/**
 * Singularise one word. The table name matters more than grammar here: a join
 * table such as `order_items` must keep its owner, so only the last segment is
 * inflected.
 */
function singularWord(word: string): string {
  const known = IRREGULAR[word];
  if (known !== undefined) return known;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(ses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('ss') || word.endsWith('us') || word.endsWith('is')) return word;
  if (word.endsWith('s') && word.length > 2) return word.slice(0, -1);
  return word;
}

export function singularize(table: string): string {
  const parts = table.split('_');
  const last = parts.pop() as string;
  return [...parts, singularWord(last.toLowerCase())].join('_');
}

/**
 * Classify a column from its name and declared type, in an order that resolves
 * the collisions: an identifier is never a measure, a flag is never a count, and
 * a ratio is never a count even when its name contains a countable noun.
 */
export function classifyColumn(name: string, type: string): ColumnRole {
  const tokens = words(name);
  const declared = type.toLowerCase();
  if (tokens.length === 0) return 'other';
  const last = tokens[tokens.length - 1] as string;
  if (last === 'id' || /Id$/.test(name)) return 'identifier';
  if (tokens[0] === 'is' || tokens[0] === 'has' || tokens.some((token) => FLAG.has(token))) return 'flag';
  if (tokens.some((token) => RATIO.has(token))) return 'ratio';
  if (tokens.some((token) => COUNT.has(token))) return 'count';
  if (tokens.some((token) => AMOUNT.has(token))) return 'amount';
  // DATETIME carries both words; the timestamp reading is the informative one.
  if (declared.includes('time')) return 'timestamp';
  if (declared.includes('date')) return 'date';
  if (tokens.some((token) => DATE.has(token))) return 'date';
  if (tokens.some((token) => TIME.has(token))) return 'timestamp';
  if (/char|text|clob|string/.test(declared)) return 'text';
  if (/int|real|num|dec|double|float/.test(declared)) return 'number';
  return 'other';
}

const ROLE_TEXT: Partial<Record<ColumnRole, string>> = {
  amount: 'monetary amount',
  count: 'count',
  ratio: 'fraction or rate',
  flag: 'yes/no flag',
  date: 'calendar date, day precision',
  timestamp: 'timestamp',
};

/**
 * The column that makes a row unique, if anything in the schema says so. Two
 * sources: the naming convention (`orders.order_id`), and the foreign keys —
 * a column another table points at is a key here even when it is called
 * `CDSCode`, which is the common case in real warehouses.
 */
function keyOf(
  table: string,
  columns: readonly { name: string }[],
  referenced: ReadonlySet<string>,
): string | undefined {
  const singular = singularize(table).toLowerCase();
  const named = columns.find((column) => {
    const name = column.name.toLowerCase();
    return name === 'id' || name === `${singular}_id` || name === `${table.toLowerCase()}_id`;
  });
  if (named !== undefined) return named.name;
  return columns.find((column) => referenced.has(`${table}.${column.name}`))?.name;
}

interface Join {
  readonly column: string;
  readonly targetTable: string;
  readonly targetColumn: string;
}

/**
 * Parse the join hints the schema card already carries (`a.b = c.d`). A hint
 * that does not parse is dropped rather than half-rendered: a wrong join
 * direction is worse than no join direction.
 */
function joinsOf(table: string, hints: readonly string[] | undefined): Join[] {
  const joins: Join[] = [];
  for (const hint of hints ?? []) {
    const match = /^\s*([^.=\s]+)\.([^\s=]+)\s*=\s*([^.=\s]+)\.([^\s=]+)\s*$/.exec(hint);
    if (match === null) continue;
    const [, leftTable, leftColumn, rightTable, rightColumn] = match as unknown as [string, string, string, string, string];
    if (leftTable !== table) continue;
    joins.push({ column: leftColumn, targetTable: rightTable, targetColumn: rightColumn });
  }
  return joins;
}

/**
 * Render the block body, one line per claim. Empty string means "nothing
 * derivable": the prompt adds its own heading, so an empty body costs no
 * heading and therefore no attention.
 */
export function renderDefinitions(schema: readonly { table: string; columns: readonly { name: string; type: string }[]; foreignKeys?: readonly string[] }[], options: DefinitionOptions = {}): string {
  const maxChars = options.maxChars ?? 900;
  const maxAmbiguous = options.maxAmbiguous ?? 2;
  const lines: string[] = [];
  const owners = new Map<string, Set<string>>();
  // Every column another table joins to is a key of its own table.
  const referenced = new Set<string>();
  const joinColumns = new Set<string>();
  for (const table of schema) {
    for (const hint of table.foreignKeys ?? []) {
      const match = /^\s*([^.=\s]+)\.([^\s=]+)\s*=\s*([^.=\s]+)\.([^\s=]+)\s*$/.exec(hint);
      if (match === null) continue;
      referenced.add(`${match[3]}.${match[4]}`);
      joinColumns.add(`${match[1]}.${match[2]}`);
      joinColumns.add(`${match[3]}.${match[4]}`);
    }
  }

  for (const table of schema) {
    for (const column of table.columns) {
      const set = owners.get(column.name) ?? new Set<string>();
      set.add(table.table);
      owners.set(column.name, set);
    }

    const key = keyOf(table.table, table.columns, referenced);
    const singular = singularize(table.table);
    if (key !== undefined) lines.push(`- ${table.table}: one row per ${singular} (key: ${key}).`);

    const joins = joinsOf(table.table, table.foreignKeys);
    for (const column of table.columns) {
      const join = joins.find((entry) => entry.column === column.name);
      if (join !== undefined) {
        const selfReference = join.targetTable === table.table;
        const direction = selfReference
          ? ' (self reference)'
          : `; many ${table.table} per ${singularize(join.targetTable)}`;
        lines.push(`- ${table.table}.${column.name}: foreign key to ${join.targetTable}.${join.targetColumn}${direction}.`);
        continue;
      }
      const text = ROLE_TEXT[classifyColumn(column.name, column.type)];
      if (text !== undefined) lines.push(`- ${table.table}.${column.name}: ${text}.`);
    }
  }

  // A column that is the same key on both sides of a join is not ambiguous; the
  // two names denote one value. Reporting it would teach the model to distrust a
  // correct join.
  const repeated = [...owners.entries()]
    .filter(
      ([name, tables]) =>
        tables.size > 1 &&
        classifyColumn(name, '') !== 'identifier' &&
        [...tables].some((table) => !joinColumns.has(`${table}.${name}`)),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, maxAmbiguous);
  for (const [name, tables] of repeated) {
    const list = [...tables].sort();
    const joined = list.length === 2 ? `${list[0]} and ${list[1]}` : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
    lines.push(`- "${name}" appears in ${joined}; each is its own column.`);
  }

  if (lines.length === 0) return '';
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length === 0) return '';
  return kept.join('\n');
}
