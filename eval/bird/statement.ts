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

import {
  CLAUSE_WORDS,
  codeOnly,
  definesOwnName,
  enclosedBy,
  ignoredRegions,
  readIdentifier,
  regionAt,
  skipSpace,
  tableRefs,
} from '@agentix-e/nl2charts-ai';
import type { Region, RegionKind, TableRef } from '@agentix-e/nl2charts-ai';

/**
 * The statement's shape — which tables it reads, which names are its own, and where its code is —
 * moved to `packages/ai` when the product started reading column domains.
 *
 * The move was not tidying. `ask_question` has to answer "what does the column in this statement
 * hold" for the customer's own database, and that needs the same alias resolution the harness
 * prices with: `t1.status` is `orders.status` only because the statement said so. Two scanners
 * would agree on the easy statements and disagree on the ones with a CTE, a quoted identifier or a
 * `from` inside a literal, and nothing in this repository compares them — so there is one scanner,
 * in the library both callers already depend on, and this file re-exports it for the modules below
 * that import from here.
 */
export { codeOnly, definesOwnName, tableRefs };
export type { Region, RegionKind, TableRef };

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
  /** Where the token starts in the statement, quotes included. */
  readonly start: number;
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
    return { text: text.slice(at + 1, close), quoted: true, start: at, end: close + 1 };
  }
  const match = /^[A-Za-z_][\w$]*/.exec(text.slice(at));
  if (match === null) return { text: text.charAt(at), quoted: false, start: at, end: at + 1 };
  return { text: match[0], quoted: false, start: at, end: at + match[0].length };
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
  const scanned = scanFields(sql);
  const qualified = new Set<string>();
  for (const ref of scanned.qualified) {
    const table = alias.get(ref.qualifier.toLowerCase());
    // A pair whose qualifier matches no `from`/`join` reference is left out for the reason the
    // interface states: guessing at a correlated subquery's table would put a column on a card
    // that cannot express it.
    if (table !== undefined) qualified.add(`${table}\u0000${ref.column.toLowerCase()}`);
  }
  const fields: FieldRef[] = [];
  for (const key of qualified) {
    const [table, column] = key.split('\u0000');
    if (table !== undefined && column !== undefined) fields.push({ table, column });
  }
  return { qualified: fields, bare: [...new Set(scanned.bare)] };
}

/**
 * One `alias.column` pair as it was written, with the characters it occupies.
 *
 * The offsets exist because one consumer edits the statement: a name that the engine refused is
 * repaired by re-qualifying it, and a repair that re-renders the statement from a parse tree is a
 * repair that has to be right about every other token as well. Replacing two spans and copying the
 * rest is the smallest thing that can be wrong.
 *
 * `columnRaw` is the column exactly as it appeared, quotes included, so a rewrite of `T2."School"`
 * keeps the quoting the model chose and the diff is the qualifier alone.
 */
export interface QualifiedRef {
  readonly start: number;
  readonly end: number;
  readonly qualifier: string;
  readonly column: string;
  readonly columnRaw: string;
}

/**
 * The qualified pairs with their offsets, and the bare names, from one pass over the code.
 *
 * Whitespace between the qualifier, the dot and the column is collapsed into the span: `T1 . id`
 * is one pair whose replacement is written without the spaces. Nothing in this repository emits
 * that spelling and a rewrite that preserved it would be preserving a token boundary nobody asked
 * about.
 */
function scanFields(sql: string): { qualified: readonly QualifiedRef[]; bare: readonly string[] } {
  const code = codeKeepingNames(sql);
  const qualified: QualifiedRef[] = [];
  const bare: string[] = [];
  let token = nextToken(code, 0);
  while (token !== undefined) {
    if (!isIdentifier(token)) {
      token = nextToken(code, token.end);
      continue;
    }
    const after = nextToken(code, token.end);
    if (after !== undefined && after.text === '.') {
      const column = nextToken(code, after.end);
      if (column !== undefined && isIdentifier(column)) {
        qualified.push({
          start: token.start,
          end: column.end,
          qualifier: token.text,
          column: column.text,
          columnRaw: sql.slice(column.start, column.end),
        });
      }
      token = column === undefined ? undefined : nextToken(code, column.end);
      continue;
    }
    bare.push(token.text.toLowerCase());
    token = after;
  }
  return { qualified, bare };
}

/** The qualified pairs of a statement, for a caller that has to edit one of them. */
export function qualifiedRefs(sql: string): readonly QualifiedRef[] {
  return scanFields(sql).qualified;
}
