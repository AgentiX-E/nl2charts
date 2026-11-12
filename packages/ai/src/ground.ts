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

/**
 * How a literal was resolved to the value the column stores.
 *
 * `case` is the same spelling in another case. `format` is the same calendar day in another
 * notation, which is a different claim: the literal and the value are not equal ignoring case, and
 * only the column's own values could say which of the two spellings it stores.
 */
export type GroundingMatch = 'case' | 'format';

/** One literal replaced, and the spelling it was replaced with. */
export interface GroundingSubstitution {
  /** As the model wrote it, unescaped. */
  readonly literal: string;
  /** The column it was compared with, as written. */
  readonly column: string;
  /** The spelling the column stores. */
  readonly value: string;
  /** Which rule found it, so a reading can tell the two edits apart. */
  readonly match: GroundingMatch;
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

/**
 * A date a literal could be, in the three shapes the calendar rule reads, and nothing else.
 *
 * Anchored at both ends and given no alternative branches: a literal with a time of day, a bare
 * year, or a trailing qualifier does not match, and a pattern that matched a prefix would answer
 * about a different day than the one the statement compares.
 */
const CALENDAR = /^\s*(?:(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})|(\d{1,2})[-/](\d{1,2})[-/](\d{4}))\s*$/;

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

/**
 * What the data said about one site.
 *
 * A discriminated pair rather than three optional fields, because the two outcomes carry different
 * facts and the caller needs both of them: a match has a spelling and the rule that found it, a
 * refusal has a reason. Written as optional fields, every read site would need a fallback for the
 * field the other branch cannot have, and `match ?? 'case'` is a branch no input can reach —
 * a fallback that reports a rule that never ran rather than a case that never happened.
 */
type Decision =
  | { readonly kind: 'match'; readonly value: string; readonly match: GroundingMatch }
  | { readonly kind: 'refuse'; readonly reason: GroundingRefusalReason };

/** One spelling, ignoring case, or the refusal that says why there is not one. */
function decide(values: readonly string[] | undefined, literal: string): Decision {
  if (values === undefined) return { kind: 'refuse', reason: 'unknown' };
  const lower = literal.toLowerCase();
  const spellings = new Set(values.filter((value) => value.toLowerCase() === lower));
  if (spellings.size > 1) return { kind: 'refuse', reason: 'ambiguous' };
  if (spellings.size === 1) return { kind: 'match', value: [...spellings][0] as string, match: 'case' };
  // No spelling matches ignoring case. The second reading is the calendar: the same day written
  // the way the column writes it. It is tried only after the case rule has failed, so a literal the
  // column stores exactly keeps the cheaper reason, and only a pure date is read this way — see
  // `calendarDay` for the precisions it refuses.
  const day = calendarDay(literal);
  if (day === undefined) return { kind: 'refuse', reason: 'absent' };
  const sameDay = new Set(values.filter((value) => {
    const stored = calendarDay(value);
    return stored !== undefined && stored.year === day.year && stored.month === day.month && stored.day === day.day;
  }));
  if (sameDay.size > 1) return { kind: 'refuse', reason: 'ambiguous' };
  if (sameDay.size === 1) return { kind: 'match', value: [...sameDay][0] as string, match: 'format' };
  return { kind: 'refuse', reason: 'absent' };
}

/** One calendar day as the three numbers that name it. */
interface CalendarDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * A year-first date, or a numeric date whose reading is not in doubt, and nothing else.
 *
 * The pattern is deliberately intolerant. It accepts `2019-09-09`, `2019/9/9`, `2019.9.9` and the
 * numeric `9/9/2019`, and it refuses every other shape a literal could have — a bare year, a
 * time of day, a partial date, an ISO timestamp. A timestamp is refused because a day and an
 * instant are different questions: writing `'2019-09-09 08:00:00'` into a statement that asked
 * about a day narrows it to one row, and writing `'2019-09-09'` into a comparison against a
 * timestamp column matches nothing.
 *
 * The numeric form is the one that carries a real ambiguity, and the rule is to read it only when
 * the numbers settle it: a first component above 12 can only be a day, a second component above 12
 * can only be a month, and two equal components name the same day either way. `3/4/2019` is left
 * unread, and the literal is reported as absent — the same answer a column that stores neither
 * spelling would give, which is the honest one when the statement never said which it meant.
 *
 * Month and day ranges are checked, including the length of the month, because `2019-13-01` parses
 * as three numbers and is not a date; without the check it would be rewritten against a column that
 * stores `2019-01-13`.
 */
function calendarDay(text: string): CalendarDay | undefined {
  const match = CALENDAR.exec(text);
  if (match === null) return undefined;
  const yearFirst = match[1] !== undefined;
  const first = Number(yearFirst ? match[1] : match[4]);
  const second = Number(yearFirst ? match[2] : match[5]);
  const third = Number(yearFirst ? match[3] : match[6]);
  let year: number;
  let month: number;
  let day: number;
  if (yearFirst) {
    year = first;
    month = second;
    day = third;
  } else if (first > 12) {
    day = first;
    month = second;
    year = third;
  } else if (second > 12) {
    month = first;
    day = second;
    year = third;
  } else if (first === second) {
    month = first;
    day = second;
    year = third;
  } else {
    return undefined;
  }
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  return { year, month, day };
}

/** A month's length, so that `2019-02-30` is refused rather than rewritten. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** The Gregorian rule, including the century exception a rule that only knew `% 4` would miss. */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
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
    if (decision.kind === 'refuse') {
      refused.push({ literal: site.literal.value, column: site.column, reason: decision.reason });
      continue;
    }
    // The column stores exactly this spelling already: nothing to edit, and nothing to report.
    if (decision.value === site.literal.value) continue;
    substitutions.push({
      literal: site.literal.value,
      column: site.column,
      value: decision.value,
      match: decision.match,
    });
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
