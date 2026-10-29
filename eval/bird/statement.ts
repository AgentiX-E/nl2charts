/**
 * Where the parts of a statement are, as positions rather than text.
 *
 * Two callers need this and neither wants the text rewritten into a normal form: the
 * repair stage has to edit one token in place, and the test suite has to say *why* an
 * edit did or did not fire. A normalizer that returns a new string answers neither — it
 * loses the offsets, so a caller can only re-parse its own output and hope the two agree.
 *
 * Everything here is a scanner rather than a regex over the whole statement. The one
 * regex that looked simpler was wrong in the way that matters: `from` inside a string
 * literal, `= 'x'` inside a comment, `"O'Brien Rd"` as an identifier. A statement with one
 * of those is not exotic in BIRD — the split has addresses, names and quoted column names
 * with apostrophes — and every one of them would have produced a silently wrong edit
 * rather than an error.
 */

/**
 * One table reference: the table, the name the rest of the statement uses for it, and
 * whether `from` or `join` introduced it.
 *
 * `joined` is not decoration. A repair that removes a table is only allowed to remove a
 * `join`; removing the `from` table leaves a statement that reads nothing.
 */
export interface TableRef {
  readonly table: string;
  readonly alias: string;
  readonly joined: boolean;
}

/** A single-quoted literal, with the offsets an edit needs. */
export interface StringLiteral {
  /** Index of the opening quote. */
  readonly start: number;
  /** Index just past the closing quote. */
  readonly end: number;
  /** The content, with `''` unescaped to `'`. */
  readonly value: string;
}

/** A literal and the column it is compared with. */
export interface LiteralSite {
  readonly literal: StringLiteral;
  /** Column name as written, without quotes or qualifier. */
  readonly column: string;
  /** Table or alias the statement qualified the column with, when it did. */
  readonly qualifier?: string;
  /** Lower-cased operator, `in` and `between` included. */
  readonly operator: string;
}

/** Words that follow a table name without being its alias. */
const CLAUSE_WORDS = new Set([
  'where', 'on', 'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'group',
  'order', 'having', 'limit', 'offset', 'union', 'except', 'intersect', 'using', 'as',
  'window', 'when', 'then', 'else', 'end',
]);

/**
 * Operators a literal can be compared with.
 *
 * Longest first inside each family, because the alternation is ordered: `not in` before
 * `in`, `>=` before `>`. The word operators carry a boundary and the symbols do not — a
 * symbol operator is followed by whitespace, where `\b` never matches.
 */
const WORD_OPERATORS = ['not in', 'not like', 'in', 'like', 'glob', 'match', 'between'];
const SYMBOL_OPERATORS = ['>=', '<=', '<>', '!=', '==', '=', '>', '<'];
const OPERATOR_PATTERN = [
  ...WORD_OPERATORS.map((operator) => `${operator.replace(/ /g, String.raw`\s+`)}\\b`),
  ...SYMBOL_OPERATORS,
].join('|');

const BARE = /^[A-Za-z_][A-Za-z0-9_$]*/;

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function skipSpace(sql: string, from: number): number {
  let index = from;
  while (index < sql.length && isSpace(sql[index])) index += 1;
  return index;
}

/** Read one identifier — quoted, bracketed or bare — or nothing when there is none. */
function readIdentifier(sql: string, at: number): { text: string; end: number } | undefined {
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
 * Read the literal that starts at `at`, or nothing when it never closes.
 *
 * An unterminated literal is not a literal: the statement is broken, and an edit built on
 * a guess about where the quote was meant to close would be worse than no edit.
 */
function readLiteral(sql: string, at: number): StringLiteral | undefined {
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
 * Every single-quoted literal in the statement, in order.
 *
 * Comments and quoted identifiers are skipped as whole regions so a quote inside one
 * cannot open a literal. This is the primitive the rest of the file is built on: a repair
 * that rewrites a literal must never rewrite one it invented.
 */
export function stringLiterals(sql: string): StringLiteral[] {
  const out: StringLiteral[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] as string;
    const next = sql[index + 1];
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (char === '"' || char === '`') {
      const end = sql.indexOf(char, index + 1);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (char === '[') {
      const end = sql.indexOf(']', index + 1);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (char === "'") {
      const literal = readLiteral(sql, index);
      if (literal === undefined) break;
      out.push(literal);
      index = literal.end;
      continue;
    }
    index += 1;
  }
  return out;
}

interface Region {
  readonly start: number;
  readonly end: number;
}

/**
 * The regions a keyword must not be looked for in: literals and both comment forms.
 *
 * Quoted identifiers are not listed because a table name may legitimately be quoted, and
 * `readIdentifier` handles them where they are read.
 */
function ignoredRegions(sql: string): Region[] {
  const regions: Region[] = stringLiterals(sql).map((literal) => ({ start: literal.start, end: literal.end }));
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] as string;
    const next = sql[index + 1];
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      const stop = end === -1 ? sql.length : end;
      regions.push({ start: index, end: stop });
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      regions.push({ start: index, end: stop });
      index = stop;
      continue;
    }
    index += 1;
  }
  return regions;
}

function enclosedBy(regions: readonly Region[], at: number): boolean {
  return regions.some((region) => at >= region.start && at < region.end);
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

/** Split a written column reference into its qualifier and its name. */
function splitColumn(text: string): { column: string; qualifier?: string } {
  const parts: string[] = [];
  let index = 0;
  while (index < text.length) {
    const at = skipSpace(text, index);
    // The caller only ever passes a regex-matched column reference, so an identifier is
    // always here; a guard for "no identifier" would be a branch nothing can reach.
    const identifier = readIdentifier(text, at) as { text: string; end: number };
    parts.push(identifier.text);
    index = skipSpace(text, identifier.end);
    if (text[index] === '.') index = skipSpace(text, index + 1);
  }
  const column = parts[parts.length - 1] as string;
  return parts.length > 1 ? { column, qualifier: parts[0] as string } : { column };
}

const COLUMN_THEN_OPERATOR = new RegExp(
  String.raw`((?:"[^"]*"|\x60[^\x60]*\x60|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*)` +
    String.raw`(?:\s*\.\s*(?:"[^"]*"|\x60[^\x60]*\x60|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*))?)` +
    String.raw`\s*(${OPERATOR_PATTERN})`,
  'gi',
);

/**
 * The index after the next list member, or nothing when the list has ended.
 *
 * `in ('a', 1, 'b')` has two groundable members and one that is not a literal; the list
 * must survive the number, or a repair would silently stop reading at the first element it
 * could not edit.
 */
function nextMember(sql: string, at: number): number | undefined {
  for (let index = at; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === '(' || char === ')') return undefined;
    if (char === ',') return index + 1;
  }
  return undefined;
}

/**
 * The literals the statement compares against a column, each with that column.
 *
 * `in ('a', 'b')` and `between 'a' and 'b'` report one site per literal rather than one
 * per list: a repair that grounds a value has to be able to edit the second member of a
 * list as readily as the first.
 *
 * A literal that is not compared with a column — `select 'x'`, or a `case` branch — is not
 * a site. That is not a gap: those literals are output, not lookup keys, and editing one
 * changes what the user is shown.
 */
export function literalSites(sql: string): LiteralSite[] {
  const ignored = ignoredRegions(sql);
  const out: LiteralSite[] = [];
  COLUMN_THEN_OPERATOR.lastIndex = 0;
  for (let match = COLUMN_THEN_OPERATOR.exec(sql); match !== null; match = COLUMN_THEN_OPERATOR.exec(sql)) {
    if (enclosedBy(ignored, match.index)) continue;
    const written = splitColumn(match[1] as string);
    const operator = (match[2] as string).toLowerCase().replace(/\s+/g, ' ');
    // A clause word here means the match started in the wrong place: the pattern accepts
    // any identifier, and `where as = 'x'` is not a comparison.
    if (CLAUSE_WORDS.has(written.column.toLowerCase())) continue;
    let at = skipSpace(sql, match.index + match[0].length);
    if (sql[at] === '(') at = skipSpace(sql, at + 1);
    const head = sql[at] === "'" ? readLiteral(sql, at) : undefined;
    if (head === undefined) continue;
    const site = { column: written.column, operator, ...(written.qualifier === undefined ? {} : { qualifier: written.qualifier }) };
    out.push({ ...site, literal: head });
    if (operator !== 'in' && operator !== 'not in' && operator !== 'between') continue;
    at = skipSpace(sql, head.end);
    if (operator === 'between') {
      const and = /^and\b/i.exec(sql.slice(at));
      if (and === null) continue;
      const second = readLiteral(sql, skipSpace(sql, at + and[0].length));
      if (second !== undefined) out.push({ ...site, literal: second });
      continue;
    }
    // One turn of this loop is one list member. A member that is not a literal is stepped
    // over rather than treated as the end of the list, because the later literals are
    // still comparisons with the same column.
    for (;;) {
      if (sql[at] === "'") {
        const member = readLiteral(sql, at);
        if (member === undefined) break;
        out.push({ ...site, literal: member });
        at = skipSpace(sql, member.end);
        if (sql[at] !== ',') break;
        at = skipSpace(sql, at + 1);
        continue;
      }
      const next = nextMember(sql, at);
      if (next === undefined) break;
      at = skipSpace(sql, next);
    }
  }
  return out;
}
