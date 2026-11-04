import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';

/**
 * A query as data, rendered by this file instead of written by a model.
 *
 * The generator this repository ships asks for a statement and gets one: text that may name a
 * table that does not exist, join it to itself, forget a condition the question stated, or put a
 * literal in the wrong case. Only the last of those is a defect the engine can report. So the
 * ceiling on any candidate pool built from statements is partly a ceiling on *syntax and layout*,
 * and nothing in the pool can tell that part from the part that is genuinely hard.
 *
 * This module removes that part by construction. The model answers with a JSON object — which
 * tables, which joins and on which column pairs, which filters as `(column, op, value)` triples,
 * which grain, which order — and the statement is rendered here, deterministically. A model that
 * fills this in cannot write a join predicate in the wrong clause, cannot invent a function
 * SQLite does not have, cannot drop a quote, and cannot disagree with itself about whether a
 * value is a number or a string: the renderer decides.
 *
 * What it cannot do is express everything. The grammar is closed on purpose, and every construct
 * outside it is a *refusal with a name* rather than a silently different query. The names matter
 * more than the count: a histogram of refusals over a real split is the list of what to add next,
 * in the order the corpus asks for it, and that is a data-driven answer to "how wide should the
 * grammar be" — a question that cannot be answered by reading SQL.
 *
 * Three rules the renderer keeps, each of which is a way the closed grammar stays safe:
 *
 * - **Identifiers are validated, never escaped.** A name matches `[A-Za-z_][A-Za-z0-9_]*`, with at
 *   most one dot for a qualifier, so nothing that reaches the output can be anything but a name.
 *   Quoting was the alternative and it is worse than useless on SQLite: a double-quoted token that
 *   names no column is read as a *string literal*, so `"customer_id"` in a database that spells it
 *   `CustomerID` compares a column to a constant and returns a clean, wrong answer.
 * - **Literals are rendered from values, not copied from text.** A string is quoted and its quotes
 *   doubled here, an integer stays an integer, `null` is `NULL`. This is the class of failure the
 *   diagnostics named `literal-case` and `literal-missing`, removed at the source.
 * - **Expressions are parsed, not pasted.** The expression inside a select item is a string in the
 *   contract, so it is the one place injection could hide; it is tokenised and parsed against a
 *   closed grammar (columns, literals, `+ - * /`, parentheses, a named function set) and anything
 *   else is refused. A string that parses renders in one canonical form, which is also why two
 *   intents that mean the same thing produce the same text.
 */

/** Comparison operators a filter may name. `between` is absent: it is two filters, and one shape. */
export const INTENT_OPERATORS = ['=', '<>', '!=', '>', '>=', '<', '<=', 'like', 'not like', 'in', 'not in', 'is null', 'is not null'] as const;

export type IntentOperator = (typeof INTENT_OPERATORS)[number];

/** Functions an expression may call. Closed, because an unknown name is an execution error. */
export const INTENT_FUNCTIONS = [
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'total',
  'round',
  'abs',
  'coalesce',
  'ifnull',
  'nullif',
  'length',
  'lower',
  'upper',
  'trim',
  'replace',
  'substr',
  'group_concat',
  'julianday',
  'date',
  'strftime',
] as const;

export interface IntentFilter {
  readonly column: string;
  readonly op: IntentOperator;
  readonly value?: unknown;
}

export interface IntentJoin {
  readonly table: string;
  readonly alias?: string;
  readonly type?: 'inner' | 'left';
  readonly on: readonly { readonly left: string; readonly right: string }[];
}

export interface IntentSelect {
  readonly expr: string;
  readonly alias?: string;
}

export interface IntentOrder {
  readonly expr: string;
  readonly direction?: 'asc' | 'desc';
}

export interface QueryIntent {
  readonly from: string;
  readonly alias?: string;
  readonly joins?: readonly IntentJoin[];
  readonly select: readonly IntentSelect[];
  readonly where?: readonly IntentFilter[];
  readonly groupBy?: readonly string[];
  readonly having?: readonly IntentFilter[];
  readonly orderBy?: readonly IntentOrder[];
  readonly limit?: number;
  readonly distinct?: boolean;
}

/**
 * Why a reply was not a query.
 *
 * Every name is a *sentence about the reply*, not about the schema: `bad-identifier` means the
 * model wrote something that is not a name, and it is the only thing wrong with the reply. The
 * histogram over a split is therefore readable as work — "11% of replies could not name a table"
 * is a prompt problem, "23% used a function outside the set" is a grammar decision.
 */
export type IntentRefusal =
  | 'not-an-object'
  | 'unknown-key'
  | 'missing-from'
  | 'missing-select'
  | 'empty-select'
  | 'bad-identifier'
  | 'bad-operator'
  | 'missing-value'
  | 'unexpected-value'
  | 'bad-value'
  | 'bad-limit'
  | 'bad-expression'
  | 'bad-join'
  | 'bad-order'
  | 'bad-direction'
  | 'unsupported-function';

export type IntentCompilation =
  | { readonly ok: true; readonly sql: string; readonly intent: QueryIntent }
  | { readonly ok: false; readonly reason: IntentRefusal; readonly detail: string };

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One optional `alias.` prefix, which is how a join or a `from` alias is referenced. */
function isColumnRef(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  // Two at most: `table.column` is the qualifier a join needs, and a third part would be a schema
  // name — which is a different database than the one this renders against.
  if (parts.length > 2) return false;
  return parts.every((part) => IDENTIFIER.test(part));
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function refuse(reason: IntentRefusal, detail: string): never {
  throw toNl2ChartsError('NL2C_E_INVALID_INPUT', `query intent: ${detail}`, undefined, { code: reason });
}

function reasonOf(error: unknown): IntentRefusal {
  const code = (error as { details?: { code?: string } }).details?.code;
  const known: readonly string[] = [
    'not-an-object',
    'unknown-key',
    'missing-from',
    'missing-select',
    'empty-select',
    'bad-identifier',
    'bad-operator',
    'missing-value',
    'unexpected-value',
    'bad-value',
    'bad-limit',
    'bad-expression',
    'bad-join',
    'bad-order',
    'bad-direction',
    'unsupported-function',
  ];
  return (code !== undefined && known.includes(code) ? code : 'bad-expression') as IntentRefusal;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const FILTER_KEYS = new Set(['column', 'op', 'value']);
const JOIN_KEYS = new Set(['table', 'alias', 'type', 'on']);
const SELECT_KEYS = new Set(['expr', 'alias']);
const ORDER_KEYS = new Set(['expr', 'direction']);
const INTENT_KEYS = new Set([
  'from',
  'alias',
  'joins',
  'select',
  'where',
  'groupBy',
  'having',
  'orderBy',
  'limit',
  'distinct',
]);

function objectAt(value: unknown, what: string, reason: IntentRefusal = 'bad-expression'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refuse(reason, `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, what: string, reason: IntentRefusal): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) refuse(reason, `${what} has unknown key ${JSON.stringify(key)}`);
  }
}

function arrayAt(value: unknown, what: string, reason: IntentRefusal): readonly unknown[] {
  if (!Array.isArray(value)) refuse(reason, `${what} must be an array`);
  return value;
}

function scalar(value: unknown, what: string): void {
  if (typeof value === 'object' && value !== null) refuse('bad-value', `${what} must be a scalar, not ${Array.isArray(value) ? 'an array' : 'an object'}`);
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || typeof value === 'undefined') {
    refuse('bad-value', `${what} is not a value SQL can carry`);
  }
}

function filterAt(value: unknown): IntentFilter {
  const object = objectAt(value, 'filter');
  onlyKeys(object, FILTER_KEYS, 'filter', 'unknown-key');
  if (!isColumnRef(object.column)) refuse('bad-identifier', `filter column ${JSON.stringify(object.column)} is not a name`);
  const op = object.op;
  if (typeof op !== 'string' || !(INTENT_OPERATORS as readonly string[]).includes(op)) {
    refuse('bad-operator', `filter operator ${JSON.stringify(op)} is not one of ${INTENT_OPERATORS.join(' ')}`);
  }
  const operator = op as IntentOperator;
  const nullary = operator === 'is null' || operator === 'is not null';
  if (nullary) {
    if (object.value !== undefined) refuse('unexpected-value', `${operator} takes no value`);
    return { column: object.column as string, op: operator };
  }
  if (object.value === undefined) refuse('missing-value', `${operator} needs a value`);
  const list = operator === 'in' || operator === 'not in';
  if (list) {
    const values = arrayAt(object.value, `${operator} value`, 'bad-value');
    if (values.length === 0) refuse('bad-value', `${operator} needs at least one value`);
    for (const entry of values) scalar(entry, `${operator} entry`);
    return { column: object.column as string, op: operator, value: [...values] };
  }
  scalar(object.value, `${operator} value`);
  return { column: object.column as string, op: operator, value: object.value };
}

function joinAt(value: unknown): IntentJoin {
  const object = objectAt(value, 'join');
  onlyKeys(object, JOIN_KEYS, 'join', 'unknown-key');
  if (!isName(object.table)) refuse('bad-identifier', `join table ${JSON.stringify(object.table)} is not a name`);
  if (object.alias !== undefined && !isName(object.alias)) refuse('bad-identifier', `join alias ${JSON.stringify(object.alias)} is not a name`);
  if (object.type !== undefined && object.type !== 'inner' && object.type !== 'left') {
    refuse('bad-join', `join type ${JSON.stringify(object.type)} is not inner or left`);
  }
  const pairs = arrayAt(object.on, 'join on', 'bad-join');
  if (pairs.length === 0) refuse('bad-join', 'join on needs at least one column pair');
  const on = pairs.map((pair) => {
    const entry = objectAt(pair, 'join pair');
    onlyKeys(entry, new Set(['left', 'right']), 'join pair', 'unknown-key');
    if (!isColumnRef(entry.left)) refuse('bad-identifier', `join left ${JSON.stringify(entry.left)} is not a column`);
    if (!isColumnRef(entry.right)) refuse('bad-identifier', `join right ${JSON.stringify(entry.right)} is not a column`);
    return { left: entry.left, right: entry.right };
  });
  return {
    table: object.table,
    ...(object.alias === undefined ? {} : { alias: object.alias }),
    ...(object.type === undefined ? {} : { type: object.type }),
    on,
  };
}

function selectAt(value: unknown): IntentSelect {
  const object = objectAt(value, 'select item');
  onlyKeys(object, SELECT_KEYS, 'select item', 'unknown-key');
  if (typeof object.expr !== 'string') refuse('bad-expression', 'select item needs an expr string');
  if (object.alias !== undefined && !isName(object.alias)) refuse('bad-identifier', `alias ${JSON.stringify(object.alias)} is not a name`);
  return { expr: object.expr, ...(object.alias === undefined ? {} : { alias: object.alias }) };
}

function orderAt(value: unknown): IntentOrder {
  const object = objectAt(value, 'order');
  onlyKeys(object, ORDER_KEYS, 'order item', 'unknown-key');
  if (typeof object.expr !== 'string') refuse('bad-order', 'order item needs an expr string');
  if (object.direction !== undefined && object.direction !== 'asc' && object.direction !== 'desc') {
    refuse('bad-direction', `order direction ${JSON.stringify(object.direction)} is not asc or desc`);
  }
  return { expr: object.expr, ...(object.direction === undefined ? {} : { direction: object.direction }) };
}

/**
 * Turn an untrusted value into a `QueryIntent`, or name what is wrong with it.
 *
 * Structural only: expressions stay strings here and are checked by the renderer, because the
 * renderer is the only place that knows what an expression has to become.
 */
export function parseQueryIntent(value: unknown): QueryIntent {
  const object = objectAt(value, 'intent', 'not-an-object');
  onlyKeys(object, INTENT_KEYS, 'intent', 'unknown-key');
  if (!isName(object.from)) refuse('missing-from', `from ${JSON.stringify(object.from)} is not a table name`);
  if (object.alias !== undefined && !isName(object.alias)) refuse('bad-identifier', `from alias ${JSON.stringify(object.alias)} is not a name`);
  const items = object.select === undefined ? undefined : arrayAt(object.select, 'select', 'missing-select');
  if (items === undefined) refuse('missing-select', 'intent has no select list');
  if (items.length === 0) refuse('empty-select', 'select list is empty');
  const select = items.map(selectAt);
  const joins = object.joins === undefined ? undefined : arrayAt(object.joins, 'joins', 'bad-join').map(joinAt);
  const where = object.where === undefined ? undefined : arrayAt(object.where, 'where', 'bad-value').map(filterAt);
  const having = object.having === undefined ? undefined : arrayAt(object.having, 'having', 'bad-value').map(filterAt);
  const groupBy =
    object.groupBy === undefined
      ? undefined
      : arrayAt(object.groupBy, 'groupBy', 'bad-identifier').map((entry) => {
          if (!isColumnRef(entry)) refuse('bad-identifier', `group by ${JSON.stringify(entry)} is not a column`);
          return entry;
        });
  const orderBy = object.orderBy === undefined ? undefined : arrayAt(object.orderBy, 'orderBy', 'bad-order').map(orderAt);
  if (object.limit !== undefined) {
    const limit = object.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) refuse('bad-limit', `limit ${JSON.stringify(limit)} is not a non-negative integer`);
  }
  if (object.distinct !== undefined && typeof object.distinct !== 'boolean') refuse('bad-value', 'distinct must be true or false');
  return {
    from: object.from,
    ...(object.alias === undefined ? {} : { alias: object.alias }),
    ...(joins === undefined ? {} : { joins }),
    select,
    ...(where === undefined ? {} : { where }),
    ...(groupBy === undefined ? {} : { groupBy }),
    ...(having === undefined ? {} : { having }),
    ...(orderBy === undefined ? {} : { orderBy }),
    ...(object.limit === undefined ? {} : { limit: object.limit as number }),
    ...(object.distinct === undefined ? {} : { distinct: object.distinct as boolean }),
  };
}

interface Token {
  readonly kind: 'name' | 'number' | 'string' | 'star' | 'op' | 'punct';
  readonly text: string;
}

/** Split an expression into the only token shapes the grammar has. Anything else is a refusal. */
function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expr.length) {
    const rest = expr.slice(index);
    const space = /^\s+/.exec(rest);
    if (space !== null) {
      index += space[0].length;
      continue;
    }
    const string = /^'((?:[^']|'')*)'/.exec(rest);
    if (string !== null) {
      tokens.push({ kind: 'string', text: (string[1] as string).replace(/''/g, "'") });
      index += string[0].length;
      continue;
    }
    const number = /^\d+(?:\.\d+)?/.exec(rest);
    if (number !== null) {
      tokens.push({ kind: 'number', text: number[0] });
      index += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/.exec(rest);
    if (name !== null) {
      tokens.push({ kind: 'name', text: name[0] });
      index += name[0].length;
      continue;
    }
    const character = rest[0] as string;
    if (character === '*') tokens.push({ kind: 'star', text: '*' });
    else if ('+-/'.includes(character)) tokens.push({ kind: 'op', text: character });
    else if ('(),'.includes(character)) tokens.push({ kind: 'punct', text: character });
    else refuse('bad-expression', `expression ${JSON.stringify(expr)} contains ${JSON.stringify(character)}`);
    index += 1;
  }
  if (tokens.length === 0) refuse('bad-expression', 'expression is empty');
  return tokens;
}

class ExprReader {
  private at = 0;

  constructor(private readonly tokens: readonly Token[], private readonly source: string) {}

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private take(): Token {
    const token = this.tokens[this.at];
    if (token === undefined) refuse('bad-expression', `expression ${JSON.stringify(this.source)} ends early`);
    this.at += 1;
    return token;
  }

  private expectPunct(text: string): void {
    const token = this.take();
    if (token.kind !== 'punct' || token.text !== text) {
      refuse('bad-expression', `expression ${JSON.stringify(this.source)} expected ${text} but found ${JSON.stringify(token.text)}`);
    }
  }

  parse(): string {
    const rendered = this.sum();
    if (this.at !== this.tokens.length) {
      refuse('bad-expression', `expression ${JSON.stringify(this.source)} has trailing ${JSON.stringify((this.peek() as Token).text)}`);
    }
    return rendered;
  }

  private sum(): string {
    let left = this.product();
    for (;;) {
      const token = this.peek();
      if (token === undefined || token.kind !== 'op' || (token.text !== '+' && token.text !== '-')) return left;
      this.at += 1;
      left = `${left} ${token.text} ${this.product()}`;
    }
  }

  private product(): string {
    let left = this.primary();
    for (;;) {
      const token = this.peek();
      const operator = token === undefined ? undefined : token.kind === 'star' ? '*' : token.kind === 'op' && token.text === '/' ? '/' : undefined;
      if (token === undefined || operator === undefined) return left;
      this.at += 1;
      left = `${left} ${operator} ${this.primary()}`;
    }
  }

  private primary(): string {
    const token = this.take();
    if (token.kind === 'number') return token.text;
    if (token.kind === 'string') return `'${token.text.replace(/'/g, "''")}'`;
    if (token.kind === 'star') return '*';
    if (token.kind === 'punct' && token.text === '(') {
      const inner = this.sum();
      this.expectPunct(')');
      return `(${inner})`;
    }
    if (token.kind !== 'name') refuse('bad-expression', `expression ${JSON.stringify(this.source)} has ${JSON.stringify(token.text)} where a value belongs`);
    const next = this.peek();
    if (next !== undefined && next.kind === 'punct' && next.text === '(') {
      const name = token.text;
      if (!(INTENT_FUNCTIONS as readonly string[]).includes(name)) {
        refuse('unsupported-function', `function ${JSON.stringify(name)} is outside the set this renderer can emit`);
      }
      this.at += 1;
      const args: string[] = [];
      let distinct = false;
      const first = this.peek();
      if (first !== undefined && first.kind === 'name' && first.text.toLowerCase() === 'distinct') {
        distinct = true;
        this.at += 1;
      }
      const closing = this.peek();
      if (closing !== undefined && closing.kind === 'punct' && closing.text === ')') {
        this.at += 1;
        // `count()` is what a model writes when it means every row; every other empty call is a
        // function missing the argument it is defined by, and rendering it would move the failure
        // from here to the engine, where it is invisible.
        if (name !== 'count') refuse('bad-expression', `${name}() needs an argument`);
        return 'count(*)';
      }
      for (;;) {
        args.push(this.sum());
        const separator = this.peek();
        if (separator !== undefined && separator.kind === 'punct' && separator.text === ',') {
          this.at += 1;
          continue;
        }
        break;
      }
      this.expectPunct(')');
      return `${name}(${distinct ? 'distinct ' : ''}${args.join(', ')})`;
    }
    return token.text;
  }
}

/** Render one expression, or refuse it. Exported because an expression is the unit a test names. */
export function renderIntentExpression(expr: string): string {
  return new ExprReader(tokenize(expr), expr).parse();
}

function literal(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse('bad-value', `number ${String(value)} is not finite`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function renderFilter(filter: IntentFilter): string {
  const column = filter.column;
  if (filter.op === 'is null' || filter.op === 'is not null') return `${column} ${filter.op.toUpperCase()}`;
  if (filter.op === 'in' || filter.op === 'not in') {
    const values = (filter.value as readonly unknown[]).map(literal).join(', ');
    return `${column} ${filter.op.toUpperCase()} (${values})`;
  }
  const operator = filter.op === '!=' ? '<>' : filter.op.toUpperCase();
  return `${column} ${operator} ${literal(filter.value)}`;
}

/**
 * Render a validated intent as one statement.
 *
 * One line, keywords upper case, identifiers as written: the same intent always produces the same
 * text, which is what makes two candidates comparable and what makes a stored artifact enough to
 * reproduce a run. `INNER` is spelled out rather than implied so a reader can see which side of a
 * join is nullable without holding the schema.
 */
export function renderIntent(value: unknown): string {
  return renderValidated(parseQueryIntent(value));
}

function renderValidated(intent: QueryIntent): string {
  const select = intent.select.map((item) => {
    const rendered = renderIntentExpression(item.expr);
    return item.alias === undefined ? rendered : `${rendered} AS ${item.alias}`;
  });
  const from = `${intent.from}${intent.alias === undefined ? '' : ` ${intent.alias}`}`;
  const joins = (intent.joins ?? []).map((join) => {
    const target = `${join.table}${join.alias === undefined ? '' : ` ${join.alias}`}`;
    const on = join.on.map((pair) => `${pair.left} = ${pair.right}`).join(' AND ');
    return `${join.type === 'left' ? 'LEFT JOIN' : 'INNER JOIN'} ${target} ON ${on}`;
  });
  const where = intent.where === undefined || intent.where.length === 0 ? [] : [`WHERE ${intent.where.map(renderFilter).join(' AND ')}`];
  const groupBy = intent.groupBy === undefined || intent.groupBy.length === 0 ? [] : [`GROUP BY ${intent.groupBy.join(', ')}`];
  const having = intent.having === undefined || intent.having.length === 0 ? [] : [`HAVING ${intent.having.map(renderFilter).join(' AND ')}`];
  const orderBy =
    intent.orderBy === undefined || intent.orderBy.length === 0
      ? []
      : [
          `ORDER BY ${intent.orderBy
            .map((item) => {
              const expression = renderIntentExpression(item.expr);
              return item.direction === undefined ? expression : `${expression} ${item.direction.toUpperCase()}`;
            })
            .join(', ')}`,
        ];
  const limit = intent.limit === undefined ? [] : [`LIMIT ${String(intent.limit)}`];
  return [
    `SELECT ${intent.distinct === true ? 'DISTINCT ' : ''}${select.join(', ')}`,
    `FROM ${from}`,
    ...joins,
    ...where,
    ...groupBy,
    ...having,
    ...orderBy,
    ...limit,
  ].join(' ');
}

/**
 * The total form: a value in, a statement or a named refusal out, never an exception.
 *
 * The harness needs this shape for one reason — a refused intent is *evidence* about the grammar,
 * not a crash, and a caller that has to catch to count it will eventually count it as zero.
 */
export function compileIntent(value: unknown): IntentCompilation {
  try {
    const intent = parseQueryIntent(value);
    return { ok: true, sql: renderValidated(intent), intent };
  } catch (error) {
    return { ok: false, reason: reasonOf(error), detail: detailOf(error) };
  }
}
