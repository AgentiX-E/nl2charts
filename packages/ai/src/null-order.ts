/**
 * The sort key that decides an extreme, and the rows a DBMS puts in front of it.
 *
 * A question that asks for "the school with the lowest average reading score" is asking for a
 * minimum over a column that is allowed to be empty. Every engine this repository targets sorts
 * that emptiness somewhere, and where it sorts it is not a detail: with `ORDER BY score ASC
 * LIMIT 1`, a row whose score is unknown wins the question. BIRD's own gold statements say so
 * explicitly — they carry `AND score IS NOT NULL` next to the order in dozens of cases — and a
 * model writing the same query from the same prompt does not, because nothing in the schema says
 * the column is null-able or that the corpus's gold guards it.
 *
 * That is a defect between the statement and the engine, not between the statement and the
 * question, so no prompt, no sample and no extra call can fix it. It is also free to fix: the
 * rows are the same, the projection is the same, and only the position of the unknown values
 * changes. This module performs exactly that one rewrite.
 *
 * ## Where the trap is depends on the dialect, and the dialects disagree
 *
 * SQLite and MySQL treat NULL as smaller than every other value, so it sorts first ascending and
 * last descending: only `ASC` is a trap. PostgreSQL treats NULL as larger, so it sorts last
 * ascending and first descending: only `DESC` is a trap. A rule written for one engine and
 * applied to the other would introduce the very bug it exists to remove, so the direction is a
 * function of the dialect rather than a constant.
 *
 * ## What it refuses to touch, and why each refusal is a measurement
 *
 * - **No LIMIT, no rewrite.** Without a row cap the order changes nothing the judge — or a
 *   reader — can see, and a rewrite nobody can score is a risk with no upside.
 * - **An aggregate key is left alone.** `ORDER BY COUNT(*) DESC LIMIT 1` cannot be NULL, so the
 *   guard would be a constant prefix — but a constant sort key still changes which of several
 *   tied groups SQLite's sorter happens to return first. Priced on dev, guarding aggregate keys
 *   won 7 and lost 3, and the three losses were exactly this: ties broken differently, not
 *   nulls. Restricting the rule to keys that are arithmetic over plain columns gives 6 wins and
 *   0 losses on the same 1,532 questions.
 * - **An already-guarded key is left alone.** A statement that writes `IS NULL` in its own sort
 *   key has made this decision; prefixing it again would invert the decision rather than repeat
 *   it.
 * - **Only the first key is guarded.** A second key is a tie-break the statement chose on
 *   purpose, and the extreme the question names is decided before it is consulted.
 */
export interface NullOrderGuard {
  /** The statement with the guard in front of its first sort key. */
  readonly sql: string;
  /** The sort key, as the statement wrote it. */
  readonly key: string;
  /** The direction the trap was found in, which is a property of the dialect. */
  readonly direction: 'asc' | 'desc';
}

/** Engines that sort NULL after every value. Everything else sorts it first. */
const NULLS_LAST_DEFAULT = new Set(['postgres', 'postgresql', 'pg', 'oracle']);

/** Calls whose result is never NULL for a non-empty group, and whose ties are load-bearing. */
const AGGREGATE = /\b(?:count|sum|avg|max|min|total|group_concat|string_agg|array_agg)\s*\(/i;

/**
 * The index just past `word` when it appears at parenthesis depth zero, outside quotes.
 *
 * `ORDER BY` inside a window function (`RANK() OVER (ORDER BY x)`) is not the clause this module
 * rewrites: the rows are already chosen by the time it runs, and the rank *number* is part of the
 * answer. Reading only depth zero is what keeps the two apart, and the same walk keeps a literal
 * containing the words "order by" from being mistaken for the clause.
 */
export function clauseAt(sql: string, word: string, from = 0): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  const lower = sql.toLowerCase();
  const token = word.toLowerCase();
  for (let at = from; at < sql.length; at += 1) {
    const character = sql.charAt(at);
    if (quote !== undefined) {
      if (character === quote) {
        // A doubled quote is an escaped one, not the end of the literal.
        if (sql.charAt(at + 1) === quote) at += 1;
        else quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (depth === 0 && lower.startsWith(token, at)) {
      const before = at === 0 ? ' ' : lower.charAt(at - 1);
      const after = lower.charAt(at + token.length);
      if (!/[a-z0-9_]/.test(before) && !/[a-z0-9_]/.test(after)) return at + token.length;
    }
  }
  return undefined;
}

/** Split on commas that are not inside a call, a subquery, or a literal. */
export function splitKeys(clause: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
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
    else if (character === ',' && depth === 0) {
      keys.push(clause.slice(start, at));
      start = at + 1;
    }
  }
  keys.push(clause.slice(start));
  return keys.map((key) => key.trim()).filter((key) => key !== '');
}

/**
 * Put the unknown values last in the sort key that decides a `LIMIT`.
 *
 * Returns `undefined` when the statement is not one the rule applies to — which is most
 * statements, and the count of them is the price of the rule: on BIRD's dev split it fires on 86
 * of 1,525 answered questions and wins 6, losing none.
 */
export function guardNullOrder(sql: string, dialect?: string): NullOrderGuard | undefined {
  const orderEnd = clauseAt(sql, 'order by');
  if (orderEnd === undefined) return undefined;
  // The clause runs to the row cap. Without one, the order is unobservable and the rewrite buys
  // nothing a judge could score.
  const limitAt = clauseAt(sql, 'limit', orderEnd);
  if (limitAt === undefined) return undefined;
  const limitStart = limitAt - 'limit'.length;
  const clause = sql.slice(orderEnd, limitStart).trim().replace(/,$/, '').trim();
  if (clause === '') return undefined;
  const keys = splitKeys(clause);
  const first = keys[0];
  if (first === undefined) return undefined;
  if (/\bis\s+(?:not\s+)?null\b/i.test(first)) return undefined;
  // `NULLS FIRST` / `NULLS LAST` is the statement making this decision in the engine's own words,
  // and rewriting it would repeat a choice its author already made. The first version of this
  // check did not read that spelling, and the direction test — which looks for `desc` at the *end*
  // of the key — then read `alt desc nulls last` as ascending and rebuilt it as
  // `alt desc nulls last IS NULL, alt desc nulls last`, which SQLite refuses to parse. The case
  // that carried the defect was one the arm answered correctly, which is why it survived a
  // published reading: the rewrite pricer only read statements of the cases that failed.
  if (/\bnulls\s+(?:first|last)\b/i.test(first)) return undefined;
  if (AGGREGATE.test(first)) return undefined;
  const direction: 'asc' | 'desc' = /\bdesc\s*$/i.test(first) ? 'desc' : 'asc';
  const expression = first.replace(/\s+(?:asc|desc)\s*$/i, '').trim();
  if (expression === '') return undefined;
  const trap: 'asc' | 'desc' = NULLS_LAST_DEFAULT.has((dialect ?? 'sqlite').toLowerCase()) ? 'desc' : 'asc';
  if (direction !== trap) return undefined;
  const rest = keys.slice(1);
  // The key is echoed as the statement wrote it, direction included: this module changes where the
  // unknown values sort, and a rewrite that also upper-cases a keyword is a rewrite whose diff has
  // two reasons in it.
  const rebuilt = [`${expression} IS NULL`, first, ...rest].join(', ');
  return {
    // The separator is added rather than inherited: the clause was trimmed, so the whitespace that
    // preceded `LIMIT` is no longer in either slice, and the first version of this line emitted
    // `... ASCLIMIT 1` — a statement that does not run, on every case the rule fired.
    sql: `${sql.slice(0, orderEnd)} ${rebuilt} ${sql.slice(limitStart)}`,
    key: expression,
    direction,
  };
}
