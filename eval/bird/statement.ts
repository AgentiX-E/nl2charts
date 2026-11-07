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

/** What a region is, so a caller can decide whether to read through it. */
type RegionKind = 'literal' | 'comment' | 'quoting';

interface Region {
  readonly start: number;
  readonly end: number;
  readonly kind: RegionKind;
}

/**
 * The region that starts at `at`, or nothing when code starts here.
 *
 * One reader for both walks. The two callers disagree on exactly one point — a table name may
 * be quoted and has to be read as a name, while a quoted `"2020"` is a column name and must
 * not be read as the number 2020 — so the walk is shared and the *filter* differs, which is
 * the difference the `kind` field exists to express.
 *
 * Quoting is a region even for the callers that read through it, and that is the whole point:
 * `"O'Brien"` is a column name, and a walk that did not skip it would open a literal at the
 * apostrophe and read the rest of the statement as a value.
 *
 * An unterminated literal is not a region: `readLiteral` refuses it, the statement is broken,
 * and a caller that guessed where the quote closes would be guessing about text it never saw.
 */
function regionAt(sql: string, at: number): { end: number; kind: RegionKind } | undefined {
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
    const literal = readLiteral(sql, at);
    return literal === undefined ? undefined : { end: literal.end, kind: 'literal' };
  }
  return undefined;
}

/**
 * The regions a keyword must not be looked for in: literals and both comment forms.
 *
 * Quoted identifiers are walked over but not reported, because a table name may legitimately
 * be quoted and `readIdentifier` handles them where they are read.
 */
function ignoredRegions(sql: string): Region[] {
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

function enclosedBy(regions: readonly Region[], at: number): boolean {
  return regions.some((region) => at >= region.start && at < region.end);
}

/**
 * The statement with every quoted region blanked out, at the same length.
 *
 * Length is preserved because the caller finds a pattern and then looks the position up in the
 * original: a mask built by deleting text moves every offset after the first literal, which is
 * the class of bug this file exists to avoid. Blanking rather than removing also keeps word
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

/** One field a statement names, resolved against the tables the statement reads. */
export interface FieldRef {
  /** Lower-cased table name, not the alias: the alias belongs to the statement, the table to the card. */
  readonly table: string;
  readonly column: string;
}

/** What a statement names, split by how it named it. */
export interface ReferencedFields {
  /**
   * `alias.column` pairs, with the alias resolved back to the table.
   *
   * A pair whose qualifier matches no `from`/`join` reference is dropped rather than attributed to
   * a table: `strftime` arguments and correlated subqueries name tables the outer statement does
   * not read, and guessing would put a column on a card that cannot express the statement.
   */
  readonly qualified: readonly FieldRef[];
  /**
   * Identifiers written without a qualifier, lower-cased and not resolved.
   *
   * Resolution needs the card, which this file does not have: a bare `id` may belong to three of
   * the tables a statement joins. The caller attributes it to every referenced table that has a
   * column of that name — deliberately over-keeping, because the one consumer is a ceiling and a
   * ceiling that keeps too much understates the thing it is a ceiling of.
   */
  readonly bare: readonly string[];
}

/**
 * One token of the statement's code, with its position.
 *
 * The scanner rather than a regular expression because the two forms of an identifier cannot be
 * written as one alternation without either losing the quoted name or capturing the wrong group:
 * `"Driver Name"` and `Driver` are both identifiers, the first may contain the dot that separates a
 * qualifier from its column, and the second may not.
 */
interface CodeToken {
  readonly text: string;
  /** True when the token was written in double quotes, which is how BIRD escapes names with spaces. */
  readonly quoted: boolean;
  readonly end: number;
}

function nextToken(text: string, from: number): CodeToken | undefined {
  let at = from;
  while (at < text.length && /\s/.test(text[at] ?? '')) at += 1;
  if (at >= text.length) return undefined;
  if (text[at] === '"' || text[at] === '`' || text[at] === '[') {
    const closing = text[at] === '[' ? ']' : (text[at] as string);
    const close = text.indexOf(closing, at + 1);
    if (close === -1) return undefined;
    return { text: text.slice(at + 1, close), quoted: true, end: close + 1 };
  }
  const match = /^[A-Za-z_][\w$]*/.exec(text.slice(at));
  if (match === null) return { text: text.charAt(at), quoted: false, end: at + 1 };
  return { text: match[0], quoted: false, end: at + match[0].length };
}

function isIdentifier(token: CodeToken): boolean {
  return token.quoted || /^[A-Za-z_]/.test(token.text);
}

/**
 * The statement with comments and string literals blanked, and quoted names kept.
 *
 * `codeOnly` blanks every region, which is right for a caller reading numbers and wrong for this
 * one: `frpm."Charter School (Y/N)"` is a column of a BIRD database, and a mask that erases it
 * makes the hardest half of every schema invisible. Lengths are preserved for the same reason they
 * are there: the scanner reports offsets and the caller may edit at them.
 */
function codeKeepingNames(sql: string): string {
  const blank = sql.split('');
  let index = 0;
  while (index < sql.length) {
    const region = regionAt(sql, index);
    if (region === undefined) {
      index += 1;
      continue;
    }
    if (region.kind !== 'quoting') {
      for (let at = index; at < region.end; at += 1) blank[at] = ' ';
    }
    index = region.end;
  }
  return blank.join('');
}

/**
 * The fields a statement names, for the arm whose card is exactly what its gold reads.
 *
 * One pass over the code text, and two outcomes per identifier: an identifier followed by a dot is
 * a qualifier and its successor is the column; an identifier not followed by a dot is a bare name.
 * Doing it in one pass is what makes `"Driver Name"` work — a regular expression that blanks the
 * pairs to find the bare names would have to decide, at the same time, whether the quoted text
 * contains a dot.
 *
 * Comments and string literals are blanked and quoted names are kept: `'a.b'` contributes no pair,
 * while `frpm."Charter School (Y/N)"` contributes one, which is the case the whole function exists
 * for — BIRD's hard columns have spaces and punctuation in their names, and a mask that erased them
 * would report a perfect linker on a card that never mentioned them.
 */
export function referencedFields(sql: string): ReferencedFields {
  const alias = new Map<string, string>();
  for (const ref of tableRefs(sql)) alias.set(ref.alias.toLowerCase(), ref.table.toLowerCase());
  const code = codeKeepingNames(sql);
  const qualified = new Set<string>();
  const bare = new Set<string>();
  let token = nextToken(code, 0);
  while (token !== undefined) {
    if (!isIdentifier(token)) {
      token = nextToken(code, token.end);
      continue;
    }
    const after = nextToken(code, token.end);
    if (after !== undefined && after.text === '.') {
      const column = nextToken(code, after.end);
      const table = alias.get(token.text.toLowerCase());
      if (column !== undefined && isIdentifier(column) && table !== undefined) {
        qualified.add(`${table}\u0000${column.text.toLowerCase()}`);
      }
      token = column === undefined ? undefined : nextToken(code, column.end);
      continue;
    }
    bare.add(token.text.toLowerCase());
    token = after;
  }
  const fields: FieldRef[] = [];
  for (const key of qualified) {
    const [table, column] = key.split('\u0000');
    if (table !== undefined && column !== undefined) fields.push({ table, column });
  }
  return { qualified: fields, bare: [...bare] };
}
