/**
 * What two statements differ in, clause by clause.
 *
 * A wrong answer that ran, matched the gold's width and still carried different numbers is
 * not one bug: on the dev split it is a wrong table (42 of 139 unclassified cases), a wrong
 * condition (37), a wrong column order or choice (8), a value written in the wrong case, and
 * a handful of statements that are textually identical and differ only in which tied row the
 * engine returned. Each of those is a different piece of work, and none of them is visible in
 * a result set: the result set says "wrong", the statement says "why".
 *
 * This module turns a statement into named parts so two statements can be compared part by
 * part. The parts are the ones with distinct fixes:
 *
 * - `tables` — which base tables are read. A fix here is join selection or foreign-key hints.
 * - `predicates` — the atoms of every `where` and `on` clause. A fix here is condition
 *   coverage: a missing `is not null`, a range that should have been inclusive.
 * - `aggregates` — the aggregate calls, with `distinct` folded in. A fix here is which
 *   function answers the question.
 * - `groups` — the `group by` columns. A fix here is the grain hint.
 * - `projection` — the select list, in order, with aliases and aggregates left in place.
 *   A fix here is which columns answer the question, and in what order the answer reads.
 * - `window` — `order by` / `limit` / `offset`. A fix here is the window a "7th highest"
 *   question selects.
 * - `text` — everything, normalized. Equal text with different results is a tie.
 *
 * Aliases are rewritten to their table before anything is compared. Without that step every
 * statement differs from every other one in the alias it chose, and a taxonomy built on the
 * raw text would report a grain problem on every question whose gold used `t1` and whose
 * prediction used `f`.
 *
 * The parser is deliberately shallow: it reads clause keywords and identifiers, not a grammar.
 * Three consequences are worth stating rather than discovering:
 *
 * - A subquery in the select list or the from clause contributes its tables, because a
 *   statement that reads three tables from a subquery does read three tables.
 * - `between a and b` splits into two atoms on the `and`, on both sides equally, so the
 *   comparison still holds; only a statement that writes `between` against one that writes
 *   two comparisons is read as a predicate difference.
 * - An `on` inside a string literal (`'on hold'`) starts a segment. The narrowing this would
 *   cause is symmetric, so it can mislabel an atom but cannot make two different statements
 *   compare equal.
 */

/** The aggregate functions a statement calls, in a form two statements can be compared in. */
const AGGREGATES = ['count', 'sum', 'avg', 'min', 'max', 'total', 'group_concat'] as const;

/** Words that follow `from`/`join` without naming a table. */
const CLAUSE_WORDS = new Set([
  'select',
  'as',
  'on',
  'where',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'group',
  'order',
  'limit',
  'offset',
  'having',
  'and',
  'or',
  'using',
  'union',
]);

/**
 * The alias group, told not to swallow the next clause keyword.
 *
 * `from orders join items` has no alias, and a regex whose optional alias group accepts any
 * word takes `join` as one — which costs more than a wrong name: the match has consumed the
 * `join`, so `items` is never seen as a table and a three-table statement reads as two. The
 * lookahead is what makes "no alias" a legal match instead of a mis-parse.
 */
const NOT_A_CLAUSE = `(?!(?:${[...CLAUSE_WORDS].join('|')})\\b)`;

/** Where one clause ends and the next begins. */
const BOUNDARY = /\b(where|on|join|group\s+by|order\s+by|having|limit|offset|union)\b/;

/** The parts of a statement a fix can name. */
export interface StatementShape {
  readonly tables: readonly string[];
  readonly predicates: readonly string[];
  readonly aggregates: readonly string[];
  readonly groups: readonly string[];
  readonly projection: readonly string[];
  readonly window: string;
  readonly text: string;
}

/**
 * One spelling for the same statement.
 *
 * Quoting and case are dropped, `limit a, b` is rewritten to `limit b offset a` (SQLite's two
 * spellings of the same window are one instruction), trailing semicolons go, and whitespace
 * collapses. Folding case also folds the case of a string literal, which is deliberate and
 * safe because literal case is decided before any statement is compared: `caseMismatchedLiterals`
 * runs on the raw pair and files that difference under its own bucket. The rewrite is what makes `text` equality mean "the engine was given the same
 * question twice", which is the only reading under which a tie is distinguishable from a
 * mistake.
 */
export function normaliseSql(sql: string): string {
  const flat = sql
    .replace(/[`"]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;\s*$/, '')
    .trim();
  return flat
    .replace(/\blimit\s+(\d+)\s*,\s*(\d+)/g, 'limit $2 offset $1')
    // `inner join` and `join` are one instruction, and `left outer join` is `left join`. Left
    // alone, a statement that spells the join the long way differs from one that does not in
    // every part that reads the text, and the difference is the author's style.
    .replace(/\binner\s+join\b/g, 'join')
    .replace(/\b(left|right|full)\s+outer\s+join\b/g, '$1 join');
}

/**
 * Alias to table, read from the `from` and `join` clauses.
 *
 * A derived table (`from (select ...) d`) has no base table to map to, so its alias is left
 * alone: inventing a name for it would be worse than the alias, which is at least the same
 * word the statement uses everywhere.
 */
export function aliasTable(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  const pattern = new RegExp(
    `\\b(?:from|join)\\s+([a-z_][a-z0-9_]*)(?:\\s+(?:as\\s+)?(${NOT_A_CLAUSE}[a-z_][a-z0-9_]*))?`,
    'g',
  );
  for (const match of normaliseSql(sql).matchAll(pattern)) {
    const table = match[1] as string;
    const candidate = match[2];
    map.set(candidate ?? table, table);
  }
  return map;
}

/**
 * Every `alias.` becomes `table.`, and the declaration that introduced the alias is dropped.
 *
 * Doing only the first half would leave `from items as t1` against `from items i` — one
 * statement in two spellings, reported as a difference when nothing differs. The replacement
 * is order-sensitive (longest alias first) so `t1` cannot eat `t10`.
 */
export function rewriteAliases(sql: string): string {
  const map = aliasTable(sql);
  let out = normaliseSql(sql);
  for (const [alias, table] of [...map].sort((left, right) => right[0].length - left[0].length)) {
    if (alias === table) continue;
    out = out.replace(new RegExp(`\\b${alias}\\.`, 'g'), `${table}.`);
    out = out.replace(new RegExp(`\\b(from|join)(\\s+)${table}(\\s+)(?:as\\s+)?${alias}\\b`, 'g'), `$1$2${table}`);
  }
  return out;
}

/** The body of every `where`/`on` segment, up to the next clause keyword. */
function segments(sql: string, keyword: RegExp): string[] {
  const out: string[] = [];
  for (const match of sql.matchAll(new RegExp(keyword.source, 'g'))) {
    const rest = sql.slice(match.index + match[0].length);
    const end = rest.search(BOUNDARY);
    out.push(end === -1 ? rest : rest.slice(0, end));
  }
  return out;
}

/**
 * The condition atoms of a statement, in a comparable form.
 *
 * Splitting on `and` rather than parsing a boolean grammar is what makes this cheap enough
 * to run on every failure; the atoms are deduplicated and sorted so that `a and b` and
 * `b and a` are one predicate set, which is true of SQL and false of its text.
 */
export function predicateAtoms(sql: string): string[] {
  const bodies = [...segments(sql, /\bwhere\b/), ...segments(sql, /\bon\b/)];
  const atoms = bodies
    .flatMap((body) => body.split(/\band\b/))
    .map((atom) =>
      atom
        .replace(/[();]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((atom) => atom !== '');
  return [...new Set(atoms)].sort();
}

/**
 * The select list, in order, with aliases dropped and aggregates kept.
 *
 * Order is kept because column order is part of an answer: BIRD compares tuples, so two
 * statements that select the same two columns in different orders answer differently, and a
 * taxonomy that sorted this list would call that case "the same question" and lose it.
 * `as total` is dropped because an alias never reaches the result.
 */
export function projectionItems(sql: string): string[] {
  const text = normaliseSql(sql);
  const match = /^\s*select\s+(?:distinct\s+)?([\s\S]*?)\s+from\b/.exec(text);
  // A statement with no `from` (`select 1`) still has a select list; reading it as empty
  // would compare two different constants as one projection and lose the difference.
  const body = match !== null ? (match[1] as string) : text.replace(/^\s*select\s+(?:distinct\s+)?/, '');
  return body
    .split(',')
    .map((item) =>
      item
        .replace(/\s+as\s+[a-z_][a-z0-9_]*$/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((item) => item !== '');
}

/**
 * The aggregate calls in a statement, lowercased, sorted and with `distinct` folded in.
 *
 * `count(distinct x)` and `count(x)` are different answers to the same question, so the
 * modifier belongs to the name rather than being dropped by a regex that stops at the
 * parenthesis. String literals are stripped first: `'count(*)'` in a predicate is not an
 * aggregate, and a taxonomy that counted it would put a filter bug in the aggregation bucket.
 */
export function aggregateCalls(sql: string): string[] {
  const text = sql.replace(/'([^']|'')*'/g, "''").toLowerCase();
  const calls: string[] = [];
  for (const name of AGGREGATES) {
    const pattern = new RegExp(`\\b${name}\\s*\\(\\s*(distinct\\s+)?`, 'g');
    for (const match of text.matchAll(pattern)) {
      calls.push(match[1] === undefined ? name : `${name}-distinct`);
    }
  }
  return calls.sort();
}

/**
 * The columns a statement groups by, normalized enough to compare two spellings.
 *
 * Aliases and quoting are dropped because `group by 1` and `group by "Name"` are the same
 * instruction written two ways, and a taxonomy that called that a grain difference would
 * fill the bucket with the model's formatting rather than its mistakes.
 */
export function groupingColumns(sql: string): string[] {
  const text = normaliseSql(sql);
  const match = /\bgroup\s+by\b([\s\S]*?)(\border\s+by\b|\bhaving\b|\blimit\b|$)/.exec(text);
  if (match === null) return [];
  // `[\s\S]*?` can match the empty string, so a match always carries a group 1 — `group by`
  // at the end of a statement is a clause with no columns, not a missing group. The cast says
  // so; a `?? ''` here would be a branch no input can take (ADR-219).
  const body = match[1] as string;
  return body
    .split(',')
    .map((part) => part.replace(/["'`]/g, '').replace(/\s+/g, ' ').trim())
    .filter((part) => part !== '')
    .sort();
}

/** `order by`, `limit` and `offset`: the window a statement selects. */
export function windowClause(sql: string): string {
  const text = normaliseSql(sql);
  const parts: string[] = [];
  const order = /\border\s+by\b([\s\S]*?)(\blimit\b|\boffset\b|$)/.exec(text);
  if (order !== null) parts.push(`order by ${(order[1] as string).trim()}`);
  const limit = /\blimit\b\s*([\s\S]*)$/.exec(text);
  if (limit !== null) parts.push(`limit ${(limit[1] as string).trim()}`);
  return parts.join(' ');
}

/**
 * The statement without its window: everything up to the first `order by`/`limit`/`offset`.
 *
 * The window is where a `limit 5` against a `limit 6` lives, and those are numbers. Comparing
 * literals before comparing windows would therefore file a window error under "a value the
 * gold names is missing" — the same bucket as a wrong district name, which is a different fix
 * in a different part of the product. Cutting the window off first lets each difference land
 * where it belongs.
 *
 * `order by 2` is a column index rather than a value, which is a second reason the order-by
 * clause is not part of the literal comparison: `2` against `3` is a different column, not a
 * different constant.
 */
export function withoutWindow(sql: string): string {
  // Deliberately not `normaliseSql`: that folds case, and the whole point of this text is to
  // be handed to the literal comparison, where `'Directly funded'` and `'Directly Funded'` are
  // different values. Only whitespace is collapsed here.
  const text = sql.replace(/\s+/g, ' ').trim();
  const cut = /\border\s+by\b|\blimit\b|\boffset\b/i.exec(text);
  return cut === null ? text : text.slice(0, cut.index).trim();
}

/** Every part of a statement, aliases rewritten so two spellings compare equal. */
export function statementShape(sql: string): StatementShape {
  const tables = [...new Set([...aliasTable(sql).values()])].sort();
  const rewritten = rewriteAliases(sql);
  // A statement that reads one table may name it or not: `select name from items` and
  // `select items.name from items` are one instruction, and SQLite resolves both. Leaving the
  // qualifier in would report that pair as a projection difference, which is the kind of
  // finding that teaches a reader to ignore the tool.
  const text = tables.length === 1 ? rewritten.replaceAll(`${tables[0]}.`, '') : rewritten;
  return {
    tables,
    predicates: predicateAtoms(text),
    aggregates: aggregateCalls(text),
    groups: groupingColumns(text),
    projection: projectionItems(text),
    window: windowClause(text),
    text: text.replace(/\s+/g, ' ').trim(),
  };
}
