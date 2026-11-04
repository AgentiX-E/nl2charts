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
 * - **Identifiers are checked, then quoted when they need it.** A name is a table or a column, at
 *   most one dot for a qualifier, and it may not carry a control character, a quote, a semicolon or
 *   a comment marker; anything else is refused with a name. Names that are not bare words are
 *   double-quoted on the way out, because the corpus does not spell every column with word
 *   characters: BIRD's `california_schools` stores `County Name` and `Charter School (Y/N)`, and a
 *   grammar that only accepted `[A-Za-z_][A-Za-z0-9_]*` could not name 4.6% of the columns in the
 *   benchmark's own databases — a vocabulary gap that reads, in a refusal histogram, as a model
 *   that cannot spell.
 *
 *   Quoting is also what makes the *schema* mandatory: SQLite reads a double-quoted token that
 *   names no column as a **string literal**, so `"County Nam"` compares a column to a constant and
 *   returns a clean, wrong answer. `compileIntent` therefore takes the column list when it has one
 *   and refuses a name that is not in it, and the harness always passes it — a renderer that cannot
 *   see the schema can guarantee shape, not meaning.
 * - **Literals are rendered from values, not copied from text.** A string is quoted and its quotes
 *   doubled here, an integer stays an integer, `null` is `NULL`. This is the class of failure the
 *   diagnostics named `literal-case` and `literal-missing`, removed at the source.
 * - **Expressions are parsed, not pasted.** The expression inside a select item is a string in the
 *   contract, so it is the one place injection could hide; it is tokenised and parsed against a
 *   closed grammar (columns, literals, `+ - * /`, parentheses, a named function set) and anything
 *   else is refused. A string that parses renders in one canonical form, which is also why two
 *   intents that mean the same thing produce the same text.
 */

/** Comparison operators a filter may name. `between` is here because a range is one shape, not two. */
export const INTENT_OPERATORS = ['=', '<>', '!=', '>', '>=', '<', '<=', 'like', 'not like', 'in', 'not in', 'between', 'not between', 'is null', 'is not null'] as const;

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
  | 'unknown-identifier'
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

/**
 * The characters a name may hold, once quoting is allowed to carry the rest.
 *
 * Deliberately not a whitelist of "word characters plus space": the point of the rule is that no
 * name can end a statement or start a comment, and a blacklist of the characters that do that is
 * both shorter and easier to check than an enumeration of every punctuation a real schema uses.
 * Quotes are *not* on it: a name that holds one is written quoted with the quote doubled, which is
 * the escape the identifier syntax has, and refusing it would fail on a column the corpus has.
 */
const NAME_PART = /^[^\u0000-\u001f;`]+$/;

/** Why a single name part cannot be rendered, or `undefined` when it can. */
function nameProblem(part: string): string | undefined {
  if (part.length === 0) return 'is empty';
  if (part.trim() !== part) return 'has a leading or trailing space';
  if (part.length > 128) return 'is longer than 128 characters';
  if (!NAME_PART.test(part)) return 'holds a character a name cannot carry';
  if (part.includes('--') || part.includes('/*') || part.includes('*/')) return 'holds a comment marker';
  return undefined;
}

/**
 * A name the way the model wrote it, with the quoting a schema's own spelling invites removed.
 *
 * `"County Name"` and `County Name` are the same column, and a model that has just read a card
 * showing the first will write it that way. Accepting only the unquoted form would put a correct
 * answer in the `bad-identifier` bucket — a refusal about our lexer that reads, in the histogram,
 * as a refusal about the corpus.
 */
function unquote(part: string): string {
  return part.length >= 2 && part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1).replace(/""/g, '"') : part;
}

/** The canonical form of a column reference, or `undefined` when it cannot be one. */
function refAt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.split('.');
  // Two at most: `table.column` is the qualifier a join needs, and a third part would be a schema
  // name — which is a different database than the one this renders against.
  if (parts.length > 2) return undefined;
  const bare = parts.map(unquote);
  return bare.every((part) => nameProblem(part) === undefined) ? bare.join('.') : undefined;
}

/** The canonical form of a table or an alias, or `undefined` when it cannot be one. */
function nameAt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const bare = unquote(value);
  if (bare.includes('.')) return undefined;
  return nameProblem(bare) === undefined ? bare : undefined;
}

/**
 * Write one name part out, quoting it only when a bare word would not survive the round trip.
 *
 * `"County Name"` and `County Name` are the same column to this renderer; the second cannot be
 * written to SQLite unquoted, and the first cannot be *read* as a name by a lexer that treats `"` as
 * the start of a string. Both spellings are accepted from the model and one form reaches the engine.
 */
function renderName(part: string): string {
  return IDENTIFIER.test(part) ? part : `"${part.replace(/"/g, '""')}"`;
}

function renderColumnRef(reference: string): string {
  return reference.split('.').map(renderName).join('.');
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
    'unknown-identifier',
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
  const column = refAt(object.column);
  if (column === undefined) refuse('bad-identifier', `filter column ${JSON.stringify(object.column)} is not a name`);
  const op = object.op;
  if (typeof op !== 'string' || !(INTENT_OPERATORS as readonly string[]).includes(op)) {
    refuse('bad-operator', `filter operator ${JSON.stringify(op)} is not one of ${INTENT_OPERATORS.join(' ')}`);
  }
  const operator = op as IntentOperator;
  const nullary = operator === 'is null' || operator === 'is not null';
  if (nullary) {
    if (object.value !== undefined) refuse('unexpected-value', `${operator} takes no value`);
    return { column, op: operator };
  }
  if (object.value === undefined) refuse('missing-value', `${operator} needs a value`);
  const list = operator === 'in' || operator === 'not in';
  if (list) {
    const values = arrayAt(object.value, `${operator} value`, 'bad-value');
    if (values.length === 0) refuse('bad-value', `${operator} needs at least one value`);
    for (const entry of values) scalar(entry, `${operator} entry`);
    return { column, op: operator, value: [...values] };
  }
  // A range is two bounds and one predicate, and it is the only operator that takes exactly two:
  // an `in` of two values is a different question, and a model that writes three bounds has
  // misunderstood the operator rather than the schema.
  if (operator === 'between' || operator === 'not between') {
    const bounds = arrayAt(object.value, `${operator} value`, 'bad-value');
    if (bounds.length !== 2) refuse('bad-value', `${operator} needs exactly two bounds`);
    for (const entry of bounds) scalar(entry, `${operator} bound`);
    return { column, op: operator, value: [...bounds] };
  }
  scalar(object.value, `${operator} value`);
  return { column, op: operator, value: object.value };
}

function joinAt(value: unknown): IntentJoin {
  const object = objectAt(value, 'join');
  onlyKeys(object, JOIN_KEYS, 'join', 'unknown-key');
  const table = nameAt(object.table);
  if (table === undefined) refuse('bad-identifier', `join table ${JSON.stringify(object.table)} is not a name`);
  const alias = object.alias === undefined ? undefined : nameAt(object.alias);
  if (object.alias !== undefined && alias === undefined) refuse('bad-identifier', `join alias ${JSON.stringify(object.alias)} is not a name`);
  if (object.type !== undefined && object.type !== 'inner' && object.type !== 'left') {
    refuse('bad-join', `join type ${JSON.stringify(object.type)} is not inner or left`);
  }
  const pairs = arrayAt(object.on, 'join on', 'bad-join');
  if (pairs.length === 0) refuse('bad-join', 'join on needs at least one column pair');
  const on = pairs.map((pair) => {
    const entry = objectAt(pair, 'join pair');
    onlyKeys(entry, new Set(['left', 'right']), 'join pair', 'unknown-key');
    const left = refAt(entry.left);
    const right = refAt(entry.right);
    if (left === undefined) refuse('bad-identifier', `join left ${JSON.stringify(entry.left)} is not a column`);
    if (right === undefined) refuse('bad-identifier', `join right ${JSON.stringify(entry.right)} is not a column`);
    return { left, right };
  });
  return {
    table,
    ...(alias === undefined ? {} : { alias }),
    ...(object.type === undefined ? {} : { type: object.type }),
    on,
  };
}

function selectAt(value: unknown): IntentSelect {
  const object = objectAt(value, 'select item');
  onlyKeys(object, SELECT_KEYS, 'select item', 'unknown-key');
  if (typeof object.expr !== 'string') refuse('bad-expression', 'select item needs an expr string');
  const alias = object.alias === undefined ? undefined : nameAt(object.alias);
  if (object.alias !== undefined && alias === undefined) refuse('bad-identifier', `alias ${JSON.stringify(object.alias)} is not a name`);
  return { expr: object.expr, ...(alias === undefined ? {} : { alias }) };
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
  const from = nameAt(object.from);
  if (from === undefined) refuse('missing-from', `from ${JSON.stringify(object.from)} is not a table name`);
  const tableAlias = object.alias === undefined ? undefined : nameAt(object.alias);
  if (object.alias !== undefined && tableAlias === undefined) refuse('bad-identifier', `from alias ${JSON.stringify(object.alias)} is not a name`);
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
          const reference = refAt(entry);
          if (reference === undefined) refuse('bad-identifier', `group by ${JSON.stringify(entry)} is not a column`);
          return reference;
        });
  const orderBy = object.orderBy === undefined ? undefined : arrayAt(object.orderBy, 'orderBy', 'bad-order').map(orderAt);
  if (object.limit !== undefined) {
    const limit = object.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) refuse('bad-limit', `limit ${JSON.stringify(limit)} is not a non-negative integer`);
  }
  if (object.distinct !== undefined && typeof object.distinct !== 'boolean') refuse('bad-value', 'distinct must be true or false');
  return {
    from,
    ...(tableAlias === undefined ? {} : { alias: tableAlias }),
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
  readonly kind: 'name' | 'quoted' | 'number' | 'string' | 'star' | 'op' | 'punct';
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
    // A quoted name, which is the only way an expression can mention a column the corpus spells
    // with a space in it. Double quotes are the identifier syntax in every engine BIRD runs on, so
    // reading them as names rather than as strings is what makes `"County Name" > 5` expressible;
    // a model that uses `"..."` for a *string* still gets a working statement out of SQLite, and
    // with a schema in hand it gets a refusal that says which name it invented.
    const quoted = /^"((?:[^"]|"")*)"/.exec(rest);
    if (quoted !== null) {
      tokens.push({ kind: 'quoted', text: (quoted[1] as string).replace(/""/g, '"') });
      index += quoted[0].length;
      continue;
    }
    const character = rest[0] as string;
    // Two characters before one, or `>=` would tokenise as `>` then a stray `=` and a comparison
    // would be refused for a reason that has nothing to do with the question.
    const pair = rest.slice(0, 2);
    if (pair === '>=' || pair === '<=' || pair === '<>' || pair === '!=' || pair === '||') {
      tokens.push({ kind: 'op', text: pair === '!=' ? '<>' : pair });
      index += 2;
      continue;
    }
    if (character === '*') tokens.push({ kind: 'star', text: '*' });
    else if ('+-/=<>'.includes(character)) tokens.push({ kind: 'op', text: character });
    else if ('(),'.includes(character)) tokens.push({ kind: 'punct', text: character });
    else refuse('bad-expression', `expression ${JSON.stringify(expr)} contains ${JSON.stringify(character)}`);
    index += 1;
  }
  if (tokens.length === 0) refuse('bad-expression', 'expression is empty');
  return tokens;
}

class ExprReader {
  private at = 0;

  /**
   * Every column this expression names, in the order it names them.
   *
   * Collected while parsing rather than recovered by scanning the rendered text: a scan cannot tell
   * `t.c` in a select item from the same characters inside a string literal, and the schema check
   * that reads this would then refuse a statement over a value it quoted correctly.
   */
  readonly references: string[] = [];

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
    const rendered = this.disjunction();
    if (this.at !== this.tokens.length) {
      refuse('bad-expression', `expression ${JSON.stringify(this.source)} has trailing ${JSON.stringify((this.peek() as Token).text)}`);
    }
    return rendered;
  }

  /** `or` binds loosest, which is why a `case when a = 1 or b = 2` condition parses as one. */
  private disjunction(): string {
    let left = this.conjunction();
    while (this.isKeyword(this.peek(), 'or')) {
      this.at += 1;
      left = `${left} or ${this.conjunction()}`;
    }
    return left;
  }

  private conjunction(): string {
    let left = this.comparison();
    while (this.isKeyword(this.peek(), 'and')) {
      this.at += 1;
      left = `${left} and ${this.comparison()}`;
    }
    return left;
  }

  /**
   * One comparison, not a chain.
   *
   * `a = b = c` is a different question in every engine that allows it, and a model that writes it
   * has misunderstood the question rather than the schema. Refusing the chain keeps the rendering a
   * reformatting rather than a decision about associativity.
   */
  private comparison(): string {
    const left = this.sum();
    const token = this.peek();
    // Every operator that can still be here is a comparison: `sum` and `product` have consumed
    // their own, so there is no second set to check and no branch that cannot be reached.
    if (token === undefined || token.kind !== 'op') return left;
    this.at += 1;
    return `${left} ${token.text} ${this.sum()}`;
  }

  private sum(): string {
    let left = this.product();
    for (;;) {
      const token = this.peek();
      if (token === undefined || token.kind !== 'op' || (token.text !== '+' && token.text !== '-' && token.text !== '||')) return left;
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

  private isKeyword(token: Token | undefined, word: string): boolean {
    return token !== undefined && token.kind === 'name' && token.text.toLowerCase() === word;
  }

  /**
   * `case [operand] when ... then ... [else ...] end`, searched or simple.
   *
   * It is in the grammar because it is how a question says "if this then that" without a table to
   * look the answer up in, and because leaving it out refused 5 of 40 replies in the first probe —
   * the largest single refusal bucket, and a construct the corpus uses constantly.
   */
  private caseExpression(): string {
    const parts: string[] = ['case'];
    if (!this.isKeyword(this.peek(), 'when')) parts.push(this.disjunction());
    let branches = 0;
    while (this.isKeyword(this.peek(), 'when')) {
      this.at += 1;
      parts.push('when', this.disjunction());
      if (!this.isKeyword(this.peek(), 'then')) {
        refuse('bad-expression', `expression ${JSON.stringify(this.source)} has a when without a then`);
      }
      this.at += 1;
      parts.push('then', this.disjunction());
      branches += 1;
    }
    if (branches === 0) refuse('bad-expression', `expression ${JSON.stringify(this.source)} has a case without a when`);
    if (this.isKeyword(this.peek(), 'else')) {
      this.at += 1;
      parts.push('else', this.disjunction());
    }
    if (!this.isKeyword(this.peek(), 'end')) {
      refuse('bad-expression', `expression ${JSON.stringify(this.source)} has a case without an end`);
    }
    this.at += 1;
    parts.push('end');
    return parts.join(' ');
  }

  private primary(): string {
    const token = this.take();
    if (this.isKeyword(token, 'case')) return this.caseExpression();
    if (token.kind === 'number') return token.text;
    if (token.kind === 'string') return `'${token.text.replace(/'/g, "''")}'`;
    if (token.kind === 'star') return '*';
    if (token.kind === 'quoted') {
      this.references.push(token.text);
      return renderName(token.text);
    }
    if (token.kind === 'punct' && token.text === '(') {
      const inner = this.disjunction();
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
        args.push(this.disjunction());
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
    this.references.push(token.text);
    return renderColumnRef(token.text);
  }
}

/** Render one expression, or refuse it. Exported because an expression is the unit a test names. */
export function renderIntentExpression(expr: string): string {
  return expressionOf(expr).sql;
}

/** A rendered expression and the columns it names, which the schema check reads. */
interface Rendered {
  readonly sql: string;
  readonly references: readonly string[];
}

function expressionOf(expr: string): Rendered {
  const reader = new ExprReader(tokenize(expr), expr);
  return { sql: reader.parse(), references: reader.references };
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
  const column = renderColumnRef(filter.column);
  if (filter.op === 'is null' || filter.op === 'is not null') return `${column} ${filter.op.toUpperCase()}`;
  if (filter.op === 'in' || filter.op === 'not in') {
    const values = (filter.value as readonly unknown[]).map(literal).join(', ');
    return `${column} ${filter.op.toUpperCase()} (${values})`;
  }
  if (filter.op === 'between' || filter.op === 'not between') {
    const bounds = (filter.value as readonly unknown[]).map(literal);
    return `${column} ${filter.op.toUpperCase()} ${bounds[0] as string} AND ${bounds[1] as string}`;
  }
  const operator = filter.op === '!=' ? '<>' : filter.op.toUpperCase();
  return `${column} ${operator} ${literal(filter.value)}`;
}

/**
 * What a caller can tell the renderer about the database it renders against.
 *
 * `columns` is the schema, as `table.column` or `column` spellings, and it is not optional in
 * practice: quoting a name is what lets a corpus column called `County Name` be written at all, and
 * quoting is also what turns a misspelling into a *string literal* on SQLite — `"County Nam" = 1` is
 * a clean, wrong answer rather than an error. A renderer that is handed the schema refuses that name
 * instead; a renderer that is not can guarantee the shape of the statement and nothing about its
 * meaning, which is the trade this option makes explicit rather than hides.
 */
export interface IntentOptions {
  readonly columns?: Iterable<string>;
}

/**
 * Render a validated intent as one statement.
 *
 * One line, keywords upper case, identifiers as written or quoted where a bare word would not
 * survive: the same intent always produces the same text, which is what makes two candidates
 * comparable and what makes a stored artifact enough to reproduce a run. `INNER` is spelled out
 * rather than implied so a reader can see which side of a join is nullable without holding the
 * schema.
 */
export function renderIntent(value: unknown, options?: IntentOptions): string {
  return renderValidated(parseQueryIntent(value), options);
}

/** Every column name a schema entry can be reached by, lower case because SQLite compares that way. */
function columnSets(columns: Iterable<string>): { readonly names: ReadonlySet<string>; readonly qualified: ReadonlySet<string> } {
  const names = new Set<string>();
  const qualified = new Set<string>();
  for (const entry of columns) {
    const text = String(entry).toLowerCase();
    qualified.add(text);
    const dot = text.lastIndexOf('.');
    names.add(dot === -1 ? text : text.slice(dot + 1));
  }
  return { names, qualified };
}

/**
 * Refuse a name the schema does not have.
 *
 * Only the column part is looked up, not the qualifier, and that is the honest limit of a flat
 * column list: `f."County Name"` is checked to name a column, not to name one that `f` has. A
 * binding error of that kind is left to the engine, which reports it; inventing a column is the
 * failure this closes, because the engine does not report it.
 */
function checkReferences(references: readonly string[], columns: Iterable<string>): void {
  const known = columnSets(columns);
  for (const reference of references) {
    const text = reference.toLowerCase();
    const dot = text.lastIndexOf('.');
    const column = dot === -1 ? text : text.slice(dot + 1);
    if (known.qualified.has(text) || known.names.has(column)) continue;
    refuse('unknown-identifier', `column ${JSON.stringify(reference)} is not in the schema`);
  }
}

function renderValidated(intent: QueryIntent, options?: IntentOptions): string {
  const references: string[] = [];
  const select = intent.select.map((item) => {
    const rendered = expressionOf(item.expr);
    references.push(...rendered.references);
    return item.alias === undefined ? rendered.sql : `${rendered.sql} AS ${renderName(item.alias)}`;
  });
  const from = `${renderName(intent.from)}${intent.alias === undefined ? '' : ` ${renderName(intent.alias)}`}`;
  const joins = (intent.joins ?? []).map((join) => {
    const target = `${renderName(join.table)}${join.alias === undefined ? '' : ` ${renderName(join.alias)}`}`;
    const on = join.on
      .map((pair) => {
        references.push(pair.left, pair.right);
        return `${renderColumnRef(pair.left)} = ${renderColumnRef(pair.right)}`;
      })
      .join(' AND ');
    return `${join.type === 'left' ? 'LEFT JOIN' : 'INNER JOIN'} ${target} ON ${on}`;
  });
  const filters = [...(intent.where ?? []), ...(intent.having ?? [])];
  references.push(...filters.map((filter) => filter.column));
  references.push(...(intent.groupBy ?? []));
  // Every expression is read before the schema is checked, because an expression is what names the
  // columns an order-by clause refers to: checking first would leave the last clause of a statement
  // the only one whose names are never looked up, which is a hole that shows up as a silent wrong
  // answer rather than as a gap in a test.
  const order = (intent.orderBy ?? []).map((item) => {
    const rendered = expressionOf(item.expr);
    references.push(...rendered.references);
    return item.direction === undefined ? rendered.sql : `${rendered.sql} ${item.direction.toUpperCase()}`;
  });
  if (options?.columns !== undefined) checkReferences(references, options.columns);
  const where = intent.where === undefined || intent.where.length === 0 ? [] : [`WHERE ${intent.where.map(renderFilter).join(' AND ')}`];
  const groupBy = intent.groupBy === undefined || intent.groupBy.length === 0 ? [] : [`GROUP BY ${intent.groupBy.map(renderColumnRef).join(', ')}`];
  const having = intent.having === undefined || intent.having.length === 0 ? [] : [`HAVING ${intent.having.map(renderFilter).join(' AND ')}`];
  const orderBy = order.length === 0 ? [] : [`ORDER BY ${order.join(', ')}`];
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
export function compileIntent(value: unknown, options?: IntentOptions): IntentCompilation {
  try {
    const intent = parseQueryIntent(value);
    return { ok: true, sql: renderValidated(intent, options), intent };
  } catch (error) {
    return { ok: false, reason: reasonOf(error), detail: detailOf(error) };
  }
}
