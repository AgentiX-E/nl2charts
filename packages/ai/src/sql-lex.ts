/**
 * Where a statement reads from, as names rather than text.
 *
 * Two callers need this and they sit on opposite sides of the library boundary: the harness
 * (`eval/bird/statement.ts`) asks which tables a statement reads so it can price a rewrite, and
 * the product asks the same question so it can look up what a column stores before running the
 * statement. The second use is why this module exists in `packages/ai` at all — a caller that
 * wants to read a column's values has to know which table the statement meant, and the same alias
 * resolution that makes the harness's pricing exact is what makes the product's lookup exact.
 *
 * The alternative was a second scanner in the product package. Two implementations of "which
 * table does `t1.status` mean" is the class of defect this repository keeps finding: they agree on
 * the easy statements, disagree on the ones with a CTE, a quoted identifier or a `from` inside a
 * literal, and nothing compares them. One implementation, two callers.
 *
 * Everything here is a scanner rather than a regex over the whole statement. The one regex that
 * looked simpler was wrong in the way that matters: `from` inside a string literal, `= 'x'` inside
 * a comment, `"O'Brien Rd"` as an identifier. A statement with one of those is not exotic in BIRD —
 * the split has addresses, names and quoted column names with apostrophes — and every one of them
 * would have produced a silently wrong edit rather than an error.
 */

/**
 * One table reference: the table, the name the rest of the statement uses for it, and whether
 * `from` or `join` introduced it.
 *
 * `joined` is not decoration. A repair that removes a table is only allowed to remove a `join`;
 * removing the `from` table leaves a statement that reads nothing.
 */
export interface TableRef {
  readonly table: string;
  readonly alias: string;
  readonly joined: boolean;
}

/** Words that follow a table name without being its alias. */
export const CLAUSE_WORDS = new Set([
  'where', 'on', 'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'group',
  'order', 'having', 'limit', 'offset', 'union', 'except', 'intersect', 'using', 'as',
  'window', 'when', 'then', 'else', 'end',
]);

const BARE = /^[A-Za-z_][A-Za-z0-9_$]*/;

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

/** The index of the next character that is not whitespace. */
export function skipSpace(sql: string, from: number): number {
  let index = from;
  while (index < sql.length && isSpace(sql[index])) index += 1;
  return index;
}

/** Read one identifier — quoted, bracketed or bare — or nothing when there is none. */
export function readIdentifier(sql: string, at: number): { text: string; end: number } | undefined {
  const char = sql[at];
  if (char === '"' || char === '`') {
    const end = sql.indexOf(char, at + 1);
    return end === -1 ? undefined : { text: sql.slice(at + 1, end), end: end + 1 };
  }
  if (char === '[') {
    const end = sql.indexOf(']', at + 1);
    return end === -1 ? undefined : { text: sql.slice(at + 1, end), end: end + 1 };
  }
  if (char === undefined) return undefined;
  const bare = BARE.exec(sql.slice(at));
  return bare === null ? undefined : { text: bare[0], end: at + bare[0].length };
}

/**
 * The index just past the single-quoted literal that starts at `at`, or nothing when it never
 * closes.
 *
 * An unterminated literal is not a literal: the statement is broken, and a region built on a guess
 * about where the quote was meant to close would be worse than no region.
 */
function literalEnd(sql: string, at: number): number | undefined {
  let index = at + 1;
  while (index < sql.length) {
    if (sql[index] === "'") {
      if (sql[index + 1] === "'") {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return undefined;
}

/** What a region is, so a caller can decide whether to read through it. */
export type RegionKind = 'literal' | 'comment' | 'quoting';

/** One stretch of the statement that is not code. */
export interface Region {
  readonly start: number;
  readonly end: number;
  readonly kind: RegionKind;
}

/**
 * The region that starts at `at`, or nothing when code starts here.
 *
 * Quoting is a region even for the callers that read through it, and that is the whole point:
 * `"O'Brien"` is a column name, and a walk that did not skip it would open a literal at the
 * apostrophe and read the rest of the statement as a value.
 */
export function regionAt(sql: string, at: number): { end: number; kind: RegionKind } | undefined {
  const char = sql[at] as string;
  const next = sql[at + 1];
  if (char === '-' && next === '-') {
    const end = sql.indexOf('\n', at);
    return { end: end === -1 ? sql.length : end, kind: 'comment' };
  }
  if (char === '/' && next === '*') {
    const end = sql.indexOf('*/', at + 2);
    return { end: end === -1 ? sql.length : end + 2, kind: 'comment' };
  }
  if (char === '"' || char === '`') {
    const end = sql.indexOf(char, at + 1);
    return { end: end === -1 ? sql.length : end + 1, kind: 'quoting' };
  }
  if (char === '[') {
    const end = sql.indexOf(']', at + 1);
    return { end: end === -1 ? sql.length : end + 1, kind: 'quoting' };
  }
  if (char === "'") {
    const end = literalEnd(sql, at);
    return end === undefined ? undefined : { end, kind: 'literal' };
  }
  return undefined;
}

/**
 * The regions a keyword must not be looked for in: literals and both comment forms.
 *
 * Quoted identifiers are walked over but not reported, because a table name may legitimately be
 * quoted and `readIdentifier` handles them where they are read.
 */
export function ignoredRegions(sql: string): Region[] {
  const regions: Region[] = [];
  let index = 0;
  while (index < sql.length) {
    const region = regionAt(sql, index);
    if (region === undefined) {
      index += 1;
      continue;
    }
    if (region.kind !== 'quoting') regions.push({ start: index, end: region.end, kind: region.kind });
    index = region.end;
  }
  return regions;
}

/** Whether a position falls inside one of the regions. */
export function enclosedBy(regions: readonly Region[], at: number): boolean {
  return regions.some((region) => at >= region.start && at < region.end);
}

/**
 * The statement with every quoted region blanked out, at the same length.
 *
 * Length is preserved because the caller finds a pattern and then looks the position up in the
 * original: a mask built by deleting text moves every offset after the first literal, which is the
 * class of bug this file exists to avoid. Blanking rather than removing also keeps word
 * boundaries — two identifiers either side of a literal do not become one token.
 */
export function codeOnly(sql: string): string {
  const blank = sql.split('');
  let index = 0;
  while (index < sql.length) {
    const region = regionAt(sql, index);
    if (region === undefined) {
      index += 1;
      continue;
    }
    for (let at = index; at < region.end; at += 1) blank[at] = ' ';
    index = region.end;
  }
  return blank.join('');
}

/**
 * Every `from` and `join` reference, in the order they appear.
 *
 * The alias is the statement's own name for the table: `from orders as o`, `from orders o`
 * and `from orders` all resolve, and the third reports the table name as its own alias so
 * a caller can compare `o.` and `orders.` without special-casing either.
 */
export function tableRefs(sql: string): TableRef[] {
  const ignored = ignoredRegions(sql);
  const out: TableRef[] = [];
  const keyword = /\b(from|join)\b/gi;
  for (let match = keyword.exec(sql); match !== null; match = keyword.exec(sql)) {
    if (enclosedBy(ignored, match.index)) continue;
    const table = readIdentifier(sql, skipSpace(sql, match.index + match[0].length));
    if (table === undefined) continue;
    let alias: string | undefined;
    const afterTable = skipSpace(sql, table.end);
    const asWord = /^as\b/i.exec(sql.slice(afterTable));
    if (asWord !== null) {
      alias = readIdentifier(sql, skipSpace(sql, afterTable + asWord[0].length))?.text;
    } else {
      const candidate = readIdentifier(sql, afterTable);
      if (candidate !== undefined && !CLAUSE_WORDS.has(candidate.text.toLowerCase())) alias = candidate.text;
    }
    out.push({ table: table.text, alias: alias ?? table.text, joined: (match[1] ?? '').toLowerCase() === 'join' });
  }
  return out;
}

/**
 * Whether the statement defines this name itself, as a CTE.
 *
 * The pattern is a definition, not a mention: `name as (select` is a CTE, and BIRD writes several
 * per statement (`with a as (...), b as (...)`), so anchoring on the `with` would classify only the
 * first. A column alias is not a match — `... end as time_seconds` is followed by no parenthesis —
 * which is exactly the distinction that matters to a caller reading table references: a CTE is a
 * table of the statement's own making and not a table of the database.
 */
export function definesOwnName(sql: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`(?<![\w"])"?${escaped}"?\s+as\s*\(\s*(?:select|with)\b`, 'i').test(sql);
}
