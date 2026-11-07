/**
 * The one result the data can prove, applied before the statement runs.
 *
 * SQL compares text case-sensitively in every engine this repository targets except where a
 * collation says otherwise, so `where status = 'banned'` against a column that stores `Banned`
 * is not a near miss — it is a statement that returns nothing, written by a model that had the
 * right column and the right value in mind. Nothing in a schema card says which case a column
 * uses, so no prompt and no sample can prevent it, and the repair is free: ask the column what it
 * stores, and if exactly one of its values equals the literal ignoring case, write that value.
 *
 * ## Why this is a rewrite and not a retry
 *
 * The alternative is the empty-result turn in `empty.ts`: run the statement, see that nothing came
 * back, and tell the model what the column holds. That turn costs a call and depends on the model
 * agreeing. This module costs one query per site and no tokens, and it runs *before* the first
 * execution, so a statement the data can correct never wastes the call. Measured on BIRD's dev
 * split at one 300 s ceiling for both bases, the gated form of this edit (only on a statement that
 * returned nothing) won 7 cases and the ungated form won 14, neither losing one — the gate was
 * the only thing standing between the rule and its own ceiling, and it is not in this module.
 *
 * ## What it refuses, and why each refusal is the point
 *
 * - **Two spellings.** A column that stores both `Banned` and `BANNED` equals the literal ignoring
 *   case twice, and choosing between them is a judgement about which rows the question meant. The
 *   rule refuses; the value-gap feedback in `empty.ts` quotes both back and lets the model decide.
 * - **A value the column does not contain.** Reported, not repaired: inventing a spelling is how a
 *   statement that returned nothing becomes a statement that returns something plausible.
 * - **A column that could not be read.** A failed read is cached as "no values" by the caller, and
 *   an empty list would make the rule silently inert; `unknown` is reported so it cannot be
 *   mistaken for `absent`.
 * - **Containment.** `Benalish Knight (Fellwar Stone)` contains `Benalish Knight`, and a rule that
 *   matched on containment would answer a different question. Only whole-value equality ignoring
 *   case counts.
 * - **`like` patterns and bare literals.** A pattern is not a value, and `select 'x'` is output
 *   rather than a lookup key. Only literals compared with a column by `=` or `in` are sites.
 *
 * The edit is idempotent: grounding a grounded statement substitutes nothing, which is what lets
 * the pipeline apply it on every turn — first generation, repair, and the empty-result retry —
 * without counting a case twice.
 */

/** What the rewrite needs to know about one site, including the statement it sits in. */
export interface ColumnQuery {
  readonly column: string;
  /** The table or alias the statement qualified the column with, when it did. */
  readonly qualifier?: string;
  /**
   * The statement being grounded.
   *
   * Carried so the caller can resolve an alias to its table, and so an unqualified column can be
   * resolved against every table the statement reads. The pipeline knows no schema; the caller
   * does, and this is the smallest thing that lets it answer.
   */
  readonly sql: string;
}

/** One column's stored values, or `undefined` when the caller could not read them. */
export type ColumnValues = (query: ColumnQuery) => Promise<readonly string[] | undefined>;

/** Why a literal was left as the model wrote it. */
export type GroundingRefusalReason = 'unknown' | 'absent' | 'ambiguous';

/** One literal replaced, and the spelling it was replaced with. */
export interface GroundingSubstitution {
  /** As the model wrote it, unescaped. */
  readonly literal: string;
  /** The column it was compared with, as written. */
  readonly column: string;
  /** The spelling the column stores. */
  readonly value: string;
}

/** One literal that was left alone, with the reason. */
export interface GroundingRefusal {
  readonly literal: string;
  readonly column: string;
  readonly reason: GroundingRefusalReason;
}

export interface Grounding {
  /** The statement to run: the model's, with every provable substitution applied. */
  readonly sql: string;
  readonly substitutions: readonly GroundingSubstitution[];
  readonly refused: readonly GroundingRefusal[];
}

/** A quoted region, so a scanner can step over it without reading through it. */
interface Region {
  readonly start: number;
  readonly end: number;
  readonly kind: 'comment' | 'literal' | 'quoting';
}

const BARE = /^[A-Za-z_][A-Za-z0-9_$]*/;

/** Words that follow a column without being one: `where not in (...)`. */
const NOT_A_COLUMN = new Set(['and', 'or', 'not', 'where', 'on', 'having', 'when', 'then', 'else', 'case', 'select']);

/**
 * The quoted region that starts at `at`, or nothing when code starts here.
 *
 * Comments and quoted identifiers are regions with `literal: false`; a single-quoted string is a
 * region with `literal: true`. Both are skipped when looking for a comparison, and only the second
 * is read as a value — `where "status" = 'x'` compares the column `status`, and a walk that read
 * through quotes would take `"status"` for a literal.
 */
function regionAt(sql: string, at: number): Region | undefined {
  const char = sql[at];
  const next = sql[at + 1];
  if (char === '-' && next === '-') {
    const end = sql.indexOf('\n', at);
    return { start: at, end: end === -1 ? sql.length : end, kind: 'comment' };
  }
  if (char === '/' && next === '*') {
    const end = sql.indexOf('*/', at + 2);
    return { start: at, end: end === -1 ? sql.length : end + 2, kind: 'comment' };
  }
  if (char === '"' || char === '`') {
    const end = sql.indexOf(char, at + 1);
    return { start: at, end: end === -1 ? sql.length : end + 1, kind: 'quoting' };
  }
  if (char === '[') {
    const end = sql.indexOf(']', at + 1);
    return { start: at, end: end === -1 ? sql.length : end + 1, kind: 'quoting' };
  }
  if (char === "'") {
    const literal = readLiteral(sql, at);
    // An unterminated literal is not a region: the statement is broken, and a caller that guessed
    // where the quote closes would be guessing about text it never saw.
    return literal === undefined ? undefined : { start: at, end: literal.end, kind: 'literal' };
  }
  return undefined;
}

/** One single-quoted literal, with the offsets an edit needs. */
interface Literal {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

function readLiteral(sql: string, at: number): Literal | undefined {
  let value = '';
  let index = at + 1;
  while (index < sql.length) {
    const char = sql[index] as string;
    if (char === "'") {
      if (sql[index + 1] === "'") {
        value += "'";
        index += 2;
        continue;
      }
      return { start: at, end: index + 1, value };
    }
    value += char;
    index += 1;
  }
  return undefined;
}

/**
 * The statement with comments and literals blanked out at the same length.
 *
 * Length is preserved because the match offsets are looked up in the original: a mask built by
 * deleting text moves every offset after the first literal, which is the class of bug that turns a
 * correct statement into a corrupted one. Blanking keeps word boundaries as well, so two
 * identifiers either side of a literal do not become one token.
 *
 * Quoted identifiers are *not* blanked. `"County Name" = 'Alameda'` is a comparison with a column
 * whose name contains a space, and a mask that hid it would hide the one site the edit exists for;
 * the regions are returned instead so a match that starts inside one can be ignored.
 */
function codeOnly(sql: string): { readonly text: string; readonly regions: readonly Region[] } {
  const blank = sql.split('');
  const regions: Region[] = [];
  let index = 0;
  while (index < sql.length) {
    const region = regionAt(sql, index);
    if (region === undefined) {
      index += 1;
      continue;
    }
    regions.push(region);
    if (region.kind !== 'quoting') for (let at = region.start; at < region.end; at += 1) blank[at] = ' ';
    index = region.end;
  }
  return { text: blank.join(''), regions };
}

const IDENT = String.raw`(?:"[^"]*"|\x60[^\x60]*\x60|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*)`;

/**
 * A column reference followed by an operator, read against the masked text.
 *
 * The symbol set is wider than the two operators this module acts on because the pattern has to
 * consume `>=` as one token: a pattern that only knew `=` would match the `=` of `>=` and report a
 * column that is never compared with a literal. `in` carries a boundary for the same reason in
 * reverse — `index` is not the token `in`.
 */
const COMPARISON = new RegExp(String.raw`(${IDENT})(?:\s*\.\s*(${IDENT}))?\s*(<>|!=|>=|<=|==|=|\bin\b)`, 'gi');

/** A column reference with the quotes the statement wrote around it removed. */
function unquote(text: string): string {
  const first = text[0];
  if (first === '"' || first === '`') return text.slice(1, -1);
  if (first === '[') return text.slice(1, -1);
  return BARE.exec(text)?.[0] ?? text;
}

/** One literal the statement compares against a column, and which column that is. */
interface Site {
  readonly literal: Literal;
  readonly column: string;
  readonly qualifier?: string;
}

/**
 * Every `column = literal` and `column in (literal, ...)` site in the statement.
 *
 * A literal is reported once per position, so an `in` list with two groundable members yields two
 * sites and each is decided on its own. The list is walked through its members rather than parsed:
 * a member that is not a literal (`in ('a', 1, 'b')`) is stepped over instead of ending the list,
 * because the later members are still comparisons with the same column.
 */
function sitesOf(sql: string): readonly Site[] {
  const { text, regions } = codeOnly(sql);
  const out: Site[] = [];
  for (const match of text.matchAll(COMPARISON)) {
    const at = match.index ?? 0;
    if (regions.some((region) => at >= region.start && at < region.end && region.kind !== 'quoting')) continue;
    const operator = (match[3] ?? '').toLowerCase();
    if (operator !== '=' && operator !== 'in') continue;
    const first = unquote(match[1] as string);
    const second = match[2] === undefined ? undefined : unquote(match[2]);
    const column = second ?? first;
    if (NOT_A_COLUMN.has(column.toLowerCase())) continue;
    const afterOperator = skipSpace(sql, (match.index ?? 0) + match[0].length);
    const head = sql[afterOperator] === '(' ? skipSpace(sql, afterOperator + 1) : afterOperator;
    const literal = sql[head] === "'" ? readLiteral(sql, head) : undefined;
    if (literal === undefined) continue;
    const site = { column, ...(second === undefined ? {} : { qualifier: first }) };
    out.push({ ...site, literal });
    if (operator !== 'in') continue;
    let cursor = skipSpace(sql, literal.end);
    while (sql[cursor] === ',') {
      const next = skipSpace(sql, cursor + 1);
      if (sql[next] === "'") {
        const member = readLiteral(sql, next);
        if (member === undefined) break;
        out.push({ ...site, literal: member });
        cursor = skipSpace(sql, member.end);
        continue;
      }
      // A member that is not a literal: step to the next comma without reading a value into it.
      const comma = sql.indexOf(',', next);
      if (comma === -1) break;
      cursor = comma;
    }
  }
  return out;
}

/** The next position that is not whitespace, or the length of the statement. */
function skipSpace(sql: string, from: number): number {
  let index = from;
  while (index < sql.length && /\s/.test(sql[index] as string)) index += 1;
  return index;
}

/** One spelling, ignoring case, or the refusal that says why there is not one. */
function decide(values: readonly string[] | undefined, literal: string): { readonly value?: string; readonly reason?: GroundingRefusalReason } {
  if (values === undefined) return { reason: 'unknown' };
  const lower = literal.toLowerCase();
  const spellings = new Set(values.filter((value) => value.toLowerCase() === lower));
  if (spellings.size === 0) return { reason: 'absent' };
  if (spellings.size > 1) return { reason: 'ambiguous' };
  return { value: [...spellings][0] as string };
}

/** One site's decision, turned into the edit list the statement is rebuilt from. */
function finish(
  sql: string,
  sites: readonly Site[],
  values: readonly (readonly string[] | undefined)[],
): Grounding {
  const substitutions: GroundingSubstitution[] = [];
  const refused: GroundingRefusal[] = [];
  const edits: { readonly start: number; readonly end: number; readonly text: string }[] = [];
  for (const [index, site] of sites.entries()) {
    const decision = decide(values[index], site.literal.value);
    if (decision.value === undefined) {
      refused.push({ literal: site.literal.value, column: site.column, reason: decision.reason ?? 'absent' });
      continue;
    }
    // The column stores exactly this spelling already: nothing to edit, and nothing to report.
    if (decision.value === site.literal.value) continue;
    substitutions.push({ literal: site.literal.value, column: site.column, value: decision.value });
    edits.push({ start: site.literal.start, end: site.literal.end, text: `'${decision.value.replace(/'/g, "''")}'` });
  }
  if (edits.length === 0) return { sql, substitutions, refused };
  // Applied from the end so an earlier edit cannot move a later one.
  let out = sql;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return { sql: out, substitutions, refused };
}

/**
 * The rewrite, driven by a lookup that already holds the values.
 *
 * Synchronous because a caller that has read the domains once — the pricing harness, a caller with
 * a cached profile — should not have to await a reader it does not have. `groundLiterals` is the
 * same rule over an async reader; both go through `finish`, so the two cannot drift into two
 * different rules that happen to share a name.
 */
export function applyGrounding(sql: string, lookup: (query: ColumnQuery) => readonly string[] | undefined): Grounding {
  const sites = sitesOf(sql);
  if (sites.length === 0) return { sql, substitutions: [], refused: [] };
  const values = sites.map((site) =>
    lookup({ column: site.column, ...(site.qualifier === undefined ? {} : { qualifier: site.qualifier }), sql }),
  );
  return finish(sql, sites, values);
}

/**
 * Ground every literal the data can settle, and report the ones it could not.
 *
 * The reads are sequential and per site rather than per column, because a caller that caches is the
 * only one that knows whether two sites share a column: deduplicating here would need this module
 * to know the caller's cache key, and reading one column twice is cheaper than a wrong join.
 */
export async function groundLiterals(sql: string, read: ColumnValues): Promise<Grounding> {
  const sites = sitesOf(sql);
  if (sites.length === 0) return { sql, substitutions: [], refused: [] };
  const values: (readonly string[] | undefined)[] = [];
  for (const site of sites) {
    values.push(await read({ column: site.column, ...(site.qualifier === undefined ? {} : { qualifier: site.qualifier }), sql }));
  }
  return finish(sql, sites, values);
}
