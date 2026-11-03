/**
 * What a worked example from another schema has to lose before it can be copied.
 *
 * `I-83` stacked BIRD's training-split demonstrations on the strongest card and read the
 * failure classes before and after. The gain was +0.91pp (951 against 937, 76:62, p = 0.2684)
 * and the movement underneath it was two-sided: `column-count` fell 136 → 106 — the largest
 * single-class move any prompt lever in this repository has produced — while fifteen new
 * execution errors appeared, every one of them `no such column: APTT / T-BIL / SC170 /
 * expense.link_to_event / T1.alignment / T1.Diagnosis` or `no such function: YEAR / MONTH /
 * DATEDIFF`. The examples taught a shape and leaked a word list, in the same block.
 *
 * That is exactly the separation DAIL-SQL's masked variant makes, and the comment on
 * `renderDemonstrationBlocks` has named it as "a candidate lever once this one is known" since
 * before the arm ran. Two harms, two edits:
 *
 * - `maskIdentifiers` replaces every schema-specific name with `table_1`, `column_1`, … so the
 *   construction survives (which aggregate, which join direction, how a ratio is guarded) and
 *   the names that do not exist in the database under test do not.
 * - `canonicaliseDialect` rewrites the MySQL and T-SQL spellings into the dialect the harness
 *   executes, so an example can no longer teach a function SQLite does not have.
 *
 * They are dispatched as one arm because they arrived as one failure population. Split, the
 * dialect half could only ever move the statements that *error on a function name* — eight of
 * them in the `I-83` delta, under a third of the 95% interval's width — so pricing it
 * separately would spend a 1,532-question run to measure something this split cannot resolve.
 * The functions stay separable, and the arm's own judgement criteria price the pair.
 *
 * The placeholders are in English and are named in the prompt (`MASKED_PREAMBLE`): a model that
 * was shown `from table_1` and not told what that is writes `from table_1`.
 */

/**
 * The sentence that makes the placeholders readable.
 *
 * Not decoration, and not a second lever: without it the mask is a trap rather than a lesson,
 * because `table_1` is a syntactically valid table name and the cheapest thing to do with an
 * example is copy it. The cost is 47 tokens a case — inside the arm's own `token ≤ +25%`
 * criterion — and it buys a block that says what it is.
 */
export const MASKED_PREAMBLE =
  'The examples below come from other databases: their tables and columns are renamed to table_1, table_2, ' +
  'column_1, column_2, ... Read the shape of each statement, then write the query against the tables above.';

type Kind = 'space' | 'comment' | 'string' | 'quoted' | 'number' | 'word' | 'punct';

interface Token {
  readonly kind: Kind;
  readonly text: string;
}

function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isWordStart(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_';
}

function isWordChar(char: string): boolean {
  return isWordStart(char) || isDigit(char) || char === '$';
}

/**
 * Split a statement into the tokens an edit can act on.
 *
 * A scanner rather than a regex, for the reason `statement.ts` gives for its own: `from` inside
 * a literal, `--` inside a string, a `#` that opens a comment in MySQL and a column name in
 * SQLite. BIRD's training split is MySQL written against SQLite, so both of the last two happen.
 *
 * Numbers are read by hand rather than by a sticky regex: a sticky `exec` at a digit always
 * matches, so the branch that handles "it did not" is a branch no input can reach, and this
 * repository has already deleted one guard that could not fire (ADR-219).
 */
function tokenize(sql: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] as string;
    const next = sql[index + 1];
    const start = index;
    if (isSpace(char)) {
      while (index < sql.length && isSpace(sql[index] as string)) index += 1;
      tokens.push({ kind: 'space', text: sql.slice(start, index) });
      continue;
    }
    if ((char === '-' && next === '-') || char === '#') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end;
      tokens.push({ kind: 'comment', text: sql.slice(start, index) });
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      tokens.push({ kind: 'comment', text: sql.slice(start, index) });
      continue;
    }
    if (char === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] !== "'") {
          index += 1;
          continue;
        }
        // `''` is an escaped quote inside the literal, not its end.
        if (sql[index + 1] !== "'") break;
        index += 2;
      }
      // An unterminated literal takes the rest of the statement, which is what it means: the
      // statement is broken, and a rewrite that guessed where the quote closed would invent text.
      index = Math.min(index + 1, sql.length);
      tokens.push({ kind: 'string', text: sql.slice(start, index) });
      continue;
    }
    if (char === '"' || char === '`' || char === '[') {
      const end = sql.indexOf(char === '[' ? ']' : char, index + 1);
      index = end === -1 ? sql.length : end + 1;
      tokens.push({ kind: 'quoted', text: sql.slice(start, index) });
      continue;
    }
    if (isDigit(char)) {
      while (index < sql.length && isDigit(sql[index] as string)) index += 1;
      // `1.` is a number in SQLite, and reading it as `1` followed by a dot turns the next word into
      // a member of it: `select 1. from t` came out as `select 1. column_1 table_1`, which masks the
      // keyword that opens the table list and then masks the table after it as a column.
      if (sql[index] === '.') index += 1;
      while (index < sql.length && isDigit(sql[index] as string)) index += 1;
      tokens.push({ kind: 'number', text: sql.slice(start, index) });
      continue;
    }
    if (isWordStart(char)) {
      while (index < sql.length && isWordChar(sql[index] as string)) index += 1;
      tokens.push({ kind: 'word', text: sql.slice(start, index) });
      continue;
    }
    index += 1;
    tokens.push({ kind: 'punct', text: char });
  }
  return tokens;
}

function nextMeaningful(tokens: readonly Token[], from: number): number | undefined {
  for (let index = from + 1; index < tokens.length; index += 1) {
    const kind = (tokens[index] as Token).kind;
    if (kind !== 'space' && kind !== 'comment') return index;
  }
  return undefined;
}

function previousMeaningful(tokens: readonly Token[], from: number): number | undefined {
  for (let index = from - 1; index >= 0; index -= 1) {
    const kind = (tokens[index] as Token).kind;
    if (kind !== 'space' && kind !== 'comment') return index;
  }
  return undefined;
}

/** The name inside a quoted identifier, or the text as written when the quote never closed. */
function unquote(text: string): string {
  const close = text[0] === '[' ? ']' : (text[0] as string);
  if (text.length < 2 || !text.endsWith(close)) return text.slice(1);
  return text.slice(1, -1);
}

/**
 * The name a token spells, quoted or not.
 *
 * The kind matters: a bare `x` is a one-character name, and running it through `unquote` — which
 * strips a quote it assumes is there — would turn it into the empty string.
 */
function nameOf(token: Token): string {
  return token.kind === 'quoted' ? unquote(token.text) : token.text;
}

/**
 * A quoted identifier as SQLite writes it.
 *
 * Backticks and brackets are the MySQL and T-SQL spellings of the same thing, and an example that
 * teaches one of them teaches a syntax the harness would refuse. Double quotes are the form
 * SQLite accepts, so every quoted name is rendered in them — including names converted from a
 * quote style whose inner `"` had to be doubled to stay an identifier.
 */
function canonicalQuote(text: string): string {
  if (text[0] === '"') return text;
  const close = text[0] === '[' ? ']' : (text[0] as string);
  if (text.length < 2 || !text.endsWith(close)) return text;
  return `"${text.slice(1, -1).replaceAll('"', '""')}"`;
}

interface Call {
  readonly args: readonly (readonly Token[])[];
  /** Index of the closing parenthesis, or the last token when the call never closes. */
  readonly end: number;
}

function trim(tokens: readonly Token[]): readonly Token[] {
  let first = 0;
  let last = tokens.length;
  while (first < last && (tokens[first] as Token).kind === 'space') first += 1;
  while (last > first && (tokens[last - 1] as Token).kind === 'space') last -= 1;
  return tokens.slice(first, last);
}

/**
 * The arguments of the call that starts at `index`, or nothing when that word is not called.
 *
 * Split on commas at depth one, so `concat(a, coalesce(b, c))` is two arguments rather than
 * three, and the nested call is rewritten by the same loop that rewrote its parent.
 */
function readCall(tokens: readonly Token[], index: number): Call | undefined {
  const open = nextMeaningful(tokens, index);
  if (open === undefined || (tokens[open] as Token).text !== '(') return undefined;
  const args: (readonly Token[])[] = [];
  let current: Token[] = [];
  let depth = 1;
  for (let at = open + 1; at < tokens.length; at += 1) {
    const token = tokens[at] as Token;
    if (token.kind === 'punct' && token.text === '(') depth += 1;
    else if (token.kind === 'punct' && token.text === ')') {
      depth -= 1;
      if (depth === 0) {
        args.push(trim(current));
        // `now()` reads as one empty argument; a function of no arguments has none.
        const only = args.length === 1 && (args[0] as readonly Token[]).length === 0;
        return { args: only ? [] : args, end: at };
      }
    } else if (depth === 1 && token.kind === 'punct' && token.text === ',') {
      args.push(trim(current));
      current = [];
      continue;
    }
    current.push(token);
  }
  // A call that never closes is not a call: see the unterminated literal above.
  return undefined;
}

type Rename = (args: readonly string[]) => string | undefined;

function unary(render: (text: string) => string): Rename {
  return (args) => (args.length === 1 ? render(args[0] as string) : undefined);
}

function binary(render: (first: string, second: string) => string): Rename {
  return (args) => (args.length === 2 ? render(args[0] as string, args[1] as string) : undefined);
}

function variadic(minimum: number, render: (args: readonly string[]) => string): Rename {
  return (args) => (args.length >= minimum ? render(args) : undefined);
}

function nullary(render: () => string): Rename {
  return (args) => (args.length === 0 ? render() : undefined);
}

/**
 * The functions SQLite does not have, and what they become.
 *
 * Only the names that appear in BIRD's corpus *and* change the meaning of a statement when
 * dropped: a date part, a day difference, a concatenation, a length, a zero-argument clock. A
 * name missing here is not renamed and the call survives exactly as written — the failure mode is
 * "the example still teaches a foreign function", which leaves the arm measuring less than it
 * claims, and never "the example teaches a function that does not exist because a rewriter
 * guessed at its arity".
 */
const RENAMES: ReadonlyMap<string, Rename> = new Map<string, Rename>([
  ['year', unary((text) => `strftime('%Y', ${text})`)],
  ['month', unary((text) => `strftime('%m', ${text})`)],
  ['day', unary((text) => `strftime('%d', ${text})`)],
  ['dayofmonth', unary((text) => `strftime('%d', ${text})`)],
  ['hour', unary((text) => `strftime('%H', ${text})`)],
  ['minute', unary((text) => `strftime('%M', ${text})`)],
  ['datediff', binary((first, second) => `(julianday(${first}) - julianday(${second}))`)],
  ['concat', variadic(1, (args) => `(${args.join(' || ')})`)],
  ['substring', variadic(2, (args) => `substr(${args.join(', ')})`)],
  ['len', unary((text) => `length(${text})`)],
  ['ucase', unary((text) => `upper(${text})`)],
  ['lcase', unary((text) => `lower(${text})`)],
  ['now', nullary(() => `datetime('now')`)],
  ['curdate', nullary(() => `date('now')`)],
]);

function rewrite(tokens: readonly Token[]): string {
  let out = '';
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.kind === 'comment') {
      // A comment names columns as readily as the statement does, and it is not part of what an
      // example teaches. Replaced by a space rather than deleted: `from/*x*/orders` is two tokens.
      out += ' ';
      continue;
    }
    if (token.kind === 'quoted') {
      out += canonicalQuote(token.text);
      continue;
    }
    if (token.kind !== 'word') {
      out += token.text;
      continue;
    }
    const rename = RENAMES.get(token.text.toLowerCase());
    if (rename === undefined) {
      out += token.text;
      continue;
    }
    const call = readCall(tokens, index);
    if (call === undefined) {
      out += token.text;
      continue;
    }
    const rendered = rename(call.args.map(rewrite));
    // An arity this table does not know: the call is left exactly as written, arguments included.
    out += rendered ?? tokens.slice(index, call.end + 1).map((inner) => inner.text).join('');
    index = call.end;
  }
  return out;
}

/**
 * Rewrite the dialect of a statement into the one the harness executes.
 *
 * Separate from the masker because the two answer different questions — "does this example name
 * things that exist here" and "does it spell them the way this engine spells them" — and because
 * the `I-83` failure table separates them: fifteen new execution errors, six of them columns and
 * the rest functions.
 */
export function canonicaliseDialect(sql: string): string {
  return rewrite(tokenize(sql));
}

/**
 * Words that are SQL rather than a name.
 *
 * The time units are deliberately *not* here. `interval 30 day` and `extract(year from d)` spell
 * them as units, and a column called `year` — `formula_1.races` has one — spells the same word as
 * a name; a keyword set cannot tell those apart, and masking the unit produces an example that
 * does not parse while keeping the column leaks the word the mask exists to remove. The two
 * contexts are recognised in the loop instead.
 */
const KEYWORDS: ReadonlySet<string> = new Set([
  'select', 'from', 'where', 'group', 'by', 'order', 'having', 'limit', 'offset', 'join', 'inner',
  'left', 'right', 'full', 'outer', 'cross', 'natural', 'on', 'using', 'as', 'union', 'all',
  'distinct', 'intersect', 'except', 'with', 'recursive', 'window', 'partition', 'over', 'rows',
  'range', 'preceding', 'following', 'unbounded', 'current', 'row', 'filter', 'values', 'and', 'or',
  'not', 'in', 'is', 'null', 'like', 'glob', 'match', 'between', 'escape', 'collate', 'exists',
  'case', 'when', 'then', 'else', 'end', 'cast', 'asc', 'desc', 'true', 'false', 'interval', 'nulls',
  'first', 'last', 'extract', 'current_date', 'current_time', 'current_timestamp',
]);

/** The words SQL spells as units, kept only where the statement is using them as one. */
const TIME_UNITS: ReadonlySet<string> = new Set(['year', 'month', 'day', 'hour', 'minute', 'second', 'week', 'quarter']);

/**
 * Whether a time unit here is a unit rather than a column name.
 *
 * Two spellings put one in a statement: `interval 30 day`, where a number or `interval` precedes
 * it, and `extract(year from d)`, where `from` follows *inside the call's parenthesis*. A column
 * called `year` — `formula_1.races` has one, and Mini-Dev's gold statements read it — appears in
 * neither position and is masked like any other name. The parenthesis is what separates the second
 * spelling from `select year from races`, which is the same three words in a different order.
 */
function isTimeUnit(tokens: readonly Token[], index: number, previous: Token | undefined, next: Token | undefined): boolean {
  if (previous !== undefined && (previous.kind === 'number' || previous.text.toLowerCase() === 'interval')) return true;
  if (next === undefined || next.text.toLowerCase() !== 'from') return false;
  const open = previousMeaningful(tokens, index);
  if (open === undefined || (tokens[open] as Token).text !== '(') return false;
  const owner = previousMeaningful(tokens, open);
  return owner !== undefined && (tokens[owner] as Token).text.toLowerCase() === 'extract';
}



/**
 * Words that end a table list.
 *
 * `from orders o where …` binds `o` and then stops; `from orders where …` binds nothing, because
 * `where` is where the statement's own clause begins. The set is the reason an implicit alias can
 * be told from the next clause without a parser.
 */
const LIST_ENDS: ReadonlySet<string> = new Set([
  'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'intersect', 'except', 'join',
  'inner', 'left', 'right', 'full', 'outer', 'cross', 'natural', 'on', 'using', 'as', 'window',
  'select', 'from', 'and', 'or', 'when', 'then', 'else', 'end',
]);

interface TableName {
  readonly table: string;
  /** The name the statement binds it to, when it binds a different one. */
  readonly alias?: string;
}

/**
 * Calls whose parentheses contain the word `from` without reading a table.
 *
 * `extract(year from d)` and `trim(both ' ' from name)` are the two spellings that do this, and a
 * scan that took every `from` for a table list read `d` as a table — the identifier came out as a
 * `table_N` placeholder in a position where a column belongs, which is a demonstration that teaches
 * the wrong thing rather than one that fails loudly.
 */
const FROM_OWNERS: ReadonlySet<string> = new Set(['extract', 'trim', 'substring', 'position']);

/**
 * Every table a `from` or `join` reads, with the name the statement binds it to.
 *
 * Written over this file's tokens rather than reusing `tableRefs`, for two reasons that both
 * matter here and neither of which does to that function's callers: a comma-separated `from a, b`
 * is two tables (its regex reads the identifier after `from` and stops), and a second parse of the
 * same text is a second opinion about where the string literals are. The subquery case needs no
 * handling — an identifier is not `(`, so `from (select …) x` contributes the inner `from` when the
 * scan reaches it.
 */
function tableList(tokens: readonly Token[]): readonly TableName[] {
  const out: TableName[] = [];
  // Which call each open parenthesis belongs to, innermost last. `undefined` for a subquery or a
  // grouped expression, where `from` means what it usually means.
  const frames: (string | undefined)[] = [];
  let previous: Token | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.kind === 'space' || token.kind === 'comment') continue;
    if (token.text === '(') {
      frames.push(previous?.kind === 'word' ? previous.text.toLowerCase() : undefined);
      previous = token;
      continue;
    }
    if (token.text === ')') {
      frames.pop();
      previous = token;
      continue;
    }
    previous = token;
    if (token.kind !== 'word') continue;
    const keyword = token.text.toLowerCase();
    if (keyword !== 'from' && keyword !== 'join') continue;
    if (FROM_OWNERS.has(frames[frames.length - 1] ?? '')) continue;
    // The table list this keyword opens, at the depth it opened it: every comma at that depth
    // introduces another table and anything else ends the list.
    let after = index;
    for (;;) {
      const found = readTable(tokens, after);
      if (found === undefined) break;
      out.push({ table: found.table, ...(found.alias === undefined ? {} : { alias: found.alias }) });
      if ((tokens[found.next] as Token | undefined)?.text !== ',') break;
      after = found.next;
    }
  }
  return out;
}

/** One table reference and where the scan resumes: the next meaningful token, or the end. */
function readTable(tokens: readonly Token[], after: number): { table: string; alias?: string; next: number } | undefined {
  const start = nextMeaningful(tokens, after);
  if (start === undefined) return undefined;
  const first = tokens[start] as Token;
  // A parenthesis opens a subquery, and the name it is bound to is the statement's own — which is
  // why it lands in `localNames` through the `as` rule rather than here.
  if (first.kind !== 'word' && first.kind !== 'quoted') return undefined;
  const table = nameOf(first);
  const at = nextMeaningful(tokens, start);
  if (at === undefined) return { table, next: tokens.length };
  const next = tokens[at] as Token;
  const keyword = next.text.toLowerCase();
  if (keyword === 'as') {
    const named = nextMeaningful(tokens, at);
    if (named === undefined) return { table, next: tokens.length };
    const alias = tokens[named] as Token;
    const bound = nameOf(alias);
    return { table, alias: bound, next: nextMeaningful(tokens, named) ?? tokens.length };
  }
  if (LIST_ENDS.has(keyword) || (next.kind !== 'word' && next.kind !== 'quoted')) {
    return { table, next: at };
  }
  return { table, alias: nameOf(next), next: nextMeaningful(tokens, at) ?? tokens.length };
}

/** The names the statement binds itself: table aliases, column aliases and CTEs. */
function localNames(tokens: readonly Token[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const ref of tableList(tokens)) {
    // `from orders` binds nothing, and that name is the table's — it has to stay maskable or a
    // bare `from orders` would keep the word the examples are supposed to lose.
    if (ref.alias === undefined || ref.alias.toLowerCase() === ref.table.toLowerCase()) continue;
    names.add(ref.alias.toLowerCase());
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.kind !== 'word' && token.kind !== 'quoted') continue;
    const previous = previousMeaningful(tokens, index);
    if (previous === undefined) continue;
    // Everything after `as` is bound by this statement: a column alias, a table alias, a cast's
    // type name, a CTE's name. None of them exist in another database.
    if ((tokens[previous] as Token).text.toLowerCase() !== 'as') continue;
    names.add(nameOf(token).toLowerCase());
  }
  return names;
}

/** The CTE names a statement defines, which are tables of its own making rather than schema. */
function cteNames(tokens: readonly Token[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.kind !== 'word' && token.kind !== 'quoted') continue;
    const as = nextMeaningful(tokens, index);
    if (as === undefined || (tokens[as] as Token).text.toLowerCase() !== 'as') continue;
    const open = nextMeaningful(tokens, as);
    // `name as (` is a CTE definition and nothing else in SQL is. The body is not read: a statement
    // whose body is missing still binds the name, and a check for `select` behind the parenthesis
    // would leave `with t as (` masking one end of a name it keeps at the other.
    if (open === undefined || (tokens[open] as Token).text !== '(') continue;
    names.add(nameOf(token).toLowerCase());
  }
  return names;
}

/**
 * Replace every name that belongs to another schema with a placeholder.
 *
 * What survives is the part that transfers: `select count(*) from table_1 join table_2 on
 * table_1.column_1 = table_2.column_2 where column_3 = 'Active' group by column_4` carries the
 * aggregate, the join direction, the equality and the grouping, and names nothing that the
 * database under test would have to have. Table and column placeholders are numbered separately
 * and by first appearance, so the same name is the same placeholder everywhere in the statement.
 *
 * Names the statement binds itself — aliases and CTEs — are kept, because they are not schema and
 * because renaming them would break the reference that makes the example a statement.
 */
export function maskIdentifiers(sql: string): string {
  const tokens = tokenize(sql);
  const ctes = cteNames(tokens);
  const tables = new Map<string, string>();
  for (const ref of tableList(tokens)) {
    const lower = ref.table.toLowerCase();
    if (ctes.has(lower) || tables.has(lower)) continue;
    tables.set(lower, `table_${String(tables.size + 1)}`);
  }
  const local = localNames(tokens);
  const columns = new Map<string, string>();
  const columnFor = (lower: string): string => {
    const known = columns.get(lower);
    if (known !== undefined) return known;
    const placeholder = `column_${String(columns.size + 1)}`;
    columns.set(lower, placeholder);
    return placeholder;
  };
  let out = '';
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.kind === 'comment') {
      out += ' ';
      continue;
    }
    if (token.kind !== 'word' && token.kind !== 'quoted') {
      out += token.text;
      continue;
    }
    const lower = nameOf(token).toLowerCase();
    if (ctes.has(lower)) {
      // A CTE is a table of the statement's own making: `with recent as (…) … from recent` names
      // nothing in another database, and masking one end of it produces an example that does not run.
      out += token.text;
      continue;
    }
    const table = tables.get(lower);
    if (table !== undefined) {
      out += table;
      continue;
    }
    const previous = previousMeaningful(tokens, index);
    const previousToken = previous === undefined ? undefined : (tokens[previous] as Token);
    if (previousToken?.text === '.') {
      // A member of whatever is on the left, and a member is a column however it is spelled:
      // `T1.year` is a column called year, not the word `year`.
      out += columnFor(lower);
      continue;
    }
    if (local.has(lower)) {
      out += token.text;
      continue;
    }
    if (token.kind === 'word' && KEYWORDS.has(lower)) {
      out += token.text;
      continue;
    }
    const next = nextMeaningful(tokens, index);
    const nextToken = next === undefined ? undefined : (tokens[next] as Token);
    if (nextToken?.text === '(') {
      // A function name. The canonicaliser is the pass that decides whether the function exists.
      out += token.text;
      continue;
    }
    if (TIME_UNITS.has(lower) && isTimeUnit(tokens, index, previousToken, nextToken)) {
      out += token.text;
      continue;
    }
    out += columnFor(lower);
  }
  return out;
}

/**
 * Both edits, in the order that cannot leave a hole: canonicalise, then mask.
 *
 * The other order would run the masker over text the canonicaliser is about to rewrite, and a
 * rewrite that spelled a name — none of them do today — would survive unmasked.
 */
export function maskStatement(sql: string): string {
  return maskIdentifiers(canonicaliseDialect(sql));
}
