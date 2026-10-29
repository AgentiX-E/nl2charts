/**
 * One SQL style, so that a judge cannot recognise the author from the text.
 *
 * The judge swap measured a preference for authorship directly: on the same three
 * candidates, the second model's own statement is returned 25.6% of the time when the
 * other model judges and 68.2% of the time when its author does. The judge never sees a
 * label, so the preference has to travel through the only thing it does see — the text.
 * Two models writing the same query differ in keyword case, spacing, line breaks and
 * comments; none of that is SQL, all of it is a signature.
 *
 * This module removes that channel and nothing else. It does not reorder, rename, or
 * simplify: a statement whose keywords are upper case, whose identifiers are lower case,
 * whose whitespace is single spaces and whose comments are gone computes exactly what it
 * computed before, and looks like every other statement produced the same way.
 *
 * Three facts make the transformation safe, and each is a rule about SQLite rather than a
 * promise:
 *
 * - **Case never carries meaning** outside string literals and quoted identifiers. Keywords
 *   and identifiers are matched case-insensitively, so upper-casing a keyword and
 *   lower-casing a name cannot change what the statement returns — which is also why the
 *   keyword list below does not have to be complete to be correct.
 * - **Whitespace never carries meaning** except as a separator between two tokens. So the
 *   normalisation is "one space, or none where punctuation already separates", and the
 *   places where a separator is load-bearing are enumerated in `glued` rather than guessed.
 * - **Operator spelling is not meaning**: `!=` is `<>`, `==` is `=`, and a model that picks
 *   one of the two is telling you who it is.
 *
 * What it deliberately leaves alone is the part that carries the answer: string literals,
 * blob literals and quoted identifiers are copied byte for byte, because SQLite is
 * case-sensitive inside all three, and a canonicaliser that "tidies" them changes the
 * result to the question being asked.
 */
export type TokenKind = 'word' | 'quoted' | 'literal' | 'number' | 'punct' | 'op' | 'comment';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  /**
   * Whether the source had whitespace or a comment immediately before this token.
   *
   * Needed only by `glued`: `x'ab'` is a blob literal and `x 'ab'` is a name beside a
   * string, so the separator at that one boundary has to survive normalisation.
   */
  readonly spaceBefore: boolean;
}

/**
 * Words that are syntax rather than names.
 *
 * Function names are in here too: `count` and `Count` are the same function and the
 * difference between them is a signature, not a fact.
 */
const KEYWORDS = new Set([
  'ALL', 'ALTER', 'AND', 'ANY', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'CAST', 'COALESCE', 'COLLATE',
  'CONCAT', 'COUNT', 'CROSS', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'DATE', 'DAY',
  'DELETE', 'DESC', 'DISTINCT', 'DROP', 'DUPLICATE', 'ELSE', 'END', 'ESCAPE', 'EXCEPT', 'EXISTS',
  'EXPLAIN', 'FALSE', 'FILTER', 'FIRST', 'FOLLOWING', 'FROM', 'FULL', 'FUNCTION', 'GLOB', 'GROUP',
  'GROUP_CONCAT', 'HAVING', 'IF', 'IFNULL', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTERSECT', 'INTO',
  'IS', 'JOIN', 'JSON', 'JSON_ARRAY', 'JSON_EXTRACT', 'JSON_OBJECT', 'JULIANDAY', 'LAST', 'LEFT',
  'LENGTH', 'LIKE', 'LIMIT', 'LOWER', 'LTRIM', 'MAX', 'MIN', 'MONTH', 'NATURAL', 'NOT', 'NULL',
  'NULLIF', 'NULLS', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'OVER', 'PARTITION', 'PRINTF',
  'RANGE', 'REGEXP', 'REPLACE', 'RIGHT', 'ROUND', 'ROW', 'ROWS', 'RTRIM', 'SELECT', 'SET',
  'SIGN', 'STRFTIME', 'SUBSTR', 'SUBSTRING', 'SUM', 'TABLE', 'THEN', 'TIES', 'TOTAL', 'TRIM',
  'TRUE', 'UNBOUNDED', 'UNION', 'UNIQUE', 'UPPER', 'USING', 'VALUES', 'WHEN', 'WHERE', 'WINDOW',
  'WITH', 'YEAR',
]);

/**
 * Two spellings of one operator, folded to the one SQLite documents as canonical.
 *
 * `->` and `->>` are in `OPERATORS` as single tokens for the same reason: scanned as `-`
 * then `>`, `a->b` would come out as `a - > b`, which is not the statement that was written.
 */
const SPELLING: Readonly<Record<string, string>> = { '!=': '<>', '==': '=' };

const isDigit = (char: string): boolean => char >= '0' && char <= '9';
const isWordStart = (char: string): boolean => /[A-Za-z_]/.test(char);
const isWordPart = (char: string): boolean => /[A-Za-z0-9_$]/.test(char);
/** Characters that stick to what precedes them: they close or separate. */
const CLOSERS = new Set([',', ')', ']', ';']);
/** Multi-character operators, longest first so `<=` is not read as `<` then `=`. */
const OPERATORS = ['->>', '<>', '!=', '<=', '>=', '||', '<<', '>>', '->', '==', '=', '<', '>', '+', '-', '*', '/', '%', '&', '|', '~'];

/**
 * Split a statement into the pieces this module is willing to touch.
 *
 * A scanner rather than a parser: the input is a model's output, and a canonicaliser that
 * throws on malformed SQL would turn a wrong answer into a crashed case. Every unterminated
 * construct consumes the rest of the input and is emitted as it stands.
 */
export function tokenizeSql(sql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let spaceBefore = true;
  while (index < sql.length) {
    const char = sql[index] as string;
    if (/\s/.test(char)) {
      index += 1;
      spaceBefore = true;
      continue;
    }
    // Comments carry nothing a judge should weigh, and they are pure signature. They are
    // dropped rather than emitted, so they count as a separator for everything around them.
    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end + 1;
      spaceBefore = true;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      spaceBefore = true;
      continue;
    }
    // String literals and quoted identifiers: copied as they are, doubling included.
    if (char === "'" || char === '"' || char === '`') {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === char) {
          if (sql[end + 1] === char) {
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        end += 1;
      }
      tokens.push({ kind: char === "'" ? 'literal' : 'quoted', text: sql.slice(index, end), spaceBefore });
      spaceBefore = false;
      index = end;
      continue;
    }
    if (char === '[') {
      const end = sql.indexOf(']', index + 1);
      const stop = end === -1 ? sql.length : end + 1;
      tokens.push({ kind: 'quoted', text: sql.slice(index, stop), spaceBefore });
      spaceBefore = false;
      index = stop;
      continue;
    }
    if (isDigit(char) || (char === '.' && isDigit(sql[index + 1] ?? ''))) {
      let end = index;
      while (end < sql.length && /[0-9.]/.test(sql[end] as string)) end += 1;
      // Exponents stay part of the number, so `1e6` is not a name after a number.
      if ((sql[end] === 'e' || sql[end] === 'E') && /[0-9+-]/.test(sql[end + 1] ?? '')) {
        end += 2;
        while (end < sql.length && isDigit(sql[end] as string)) end += 1;
      }
      tokens.push({ kind: 'number', text: sql.slice(index, end), spaceBefore });
      spaceBefore = false;
      index = end;
      continue;
    }
    if (isWordStart(char)) {
      let end = index;
      while (end < sql.length && isWordPart(sql[end] as string)) end += 1;
      tokens.push({ kind: 'word', text: sql.slice(index, end), spaceBefore });
      spaceBefore = false;
      index = end;
      continue;
    }
    if (CLOSERS.has(char) || char === '(' || char === '.' || char === ';') {
      tokens.push({ kind: 'punct', text: char, spaceBefore });
      spaceBefore = false;
      index += 1;
      continue;
    }
    const operator = OPERATORS.find((candidate) => sql.startsWith(candidate, index));
    if (operator !== undefined) {
      tokens.push({ kind: 'op', text: operator, spaceBefore });
      spaceBefore = false;
      index += operator.length;
      continue;
    }
    // Anything this scanner does not model (a stray colon, a dialect quirk) is kept as a
    // token of its own rather than dropped: the canonical form must compute the same thing.
    tokens.push({ kind: 'op', text: char, spaceBefore });
    spaceBefore = false;
    index += 1;
  }
  return tokens;
}

/** Prefixes that only mean what they mean when the next token touches them. */
const BOUND_PREFIXES = new Set(['?', ':', '@', '$']);

/**
 * Pairs whose separator is load-bearing, and therefore copied from the source.
 *
 * `x'ab'` is a blob literal and `x 'ab'` is a name followed by a string; the space decides
 * which one the statement is. `?1`, `:name`, `@name` and `$name` are a single parameter and
 * fall apart the moment a space is inserted. Everything else normalises, because nothing
 * else can merge: two words are already one token at scan time, and punctuation is handled
 * by `separator`.
 */
function glued(previous: Token, current: Token): boolean {
  if (previous.kind === 'word' && (previous.text === 'x' || previous.text === 'X') && current.kind === 'literal') return true;
  return previous.kind === 'op' && BOUND_PREFIXES.has(previous.text) && (current.kind === 'word' || current.kind === 'number');
}

/** The separator between two tokens: one space, none, or the source's own at a glued pair. */
function separator(previous: Token, current: Token): string {
  if (glued(previous, current)) return current.spaceBefore ? ' ' : '';
  if (current.kind === 'punct' && (CLOSERS.has(current.text) || current.text === '(' || current.text === '.')) return '';
  if (previous.text === '(' || previous.text === '.') return '';
  return ' ';
}

/** A token as it will be printed: keywords and functions upper case, names lower case. */
function canonText(token: Token): string {
  if (token.kind !== 'word') return SPELLING[token.text] ?? token.text;
  return KEYWORDS.has(token.text.toUpperCase()) ? token.text.toUpperCase() : token.text.toLowerCase();
}

/**
 * The canonical form: keyword case, identifier case, whitespace, comments, operator spelling.
 *
 * Trailing semicolons are dropped — they are punctuation with no meaning and one more
 * thing two statements can disagree about.
 */
export function canonicalSql(sql: string): string {
  const tokens = tokenizeSql(sql);
  // Only a *trailing* semicolon goes. One between two statements separates them, and
  // dropping it would join them into a different (and wrong) statement.
  while (tokens.length > 0 && tokens[tokens.length - 1]?.text === ';') tokens.pop();
  let output = '';
  let previous: Token | undefined;
  for (const token of tokens) {
    output += previous !== undefined && separator(previous, token) !== '' ? ` ${canonText(token)}` : canonText(token);
    previous = token;
  }
  return output;
}
