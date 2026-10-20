/**
 * Statement guard. This is a lexical gate, not a parser: it refuses anything it
 * cannot classify with certainty, and it never rewrites a statement it does not
 * understand. Being conservative is the point.
 */
export type StatementKind = 'select' | 'with' | 'values' | 'explain' | 'describe' | 'summarize';

export interface GuardPolicy {
  readonly allowedKinds: readonly StatementKind[];
  readonly bannedWords: readonly string[];
  readonly bannedFunctions: readonly string[];
  readonly maxLength: number;
}

export const DEFAULT_POLICY: GuardPolicy = {
  allowedKinds: ['select', 'with', 'values', 'explain', 'describe', 'summarize'],
  bannedWords: [
    'insert',
    'update',
    'delete',
    'merge',
    'create',
    'drop',
    'alter',
    'truncate',
    'attach',
    'detach',
    'pragma',
    'copy',
    'export',
    'import',
    'install',
    'load',
    'call',
    'grant',
    'revoke',
    'set',
    'reset',
    'vacuum',
    'checkpoint',
    'begin',
    'commit',
    'rollback',
    'savepoint',
    'release',
    'into',
    'pivot',
    'unpivot',
  ],
  bannedFunctions: [
    'read_csv',
    'read_csv_auto',
    'read_parquet',
    'read_json',
    'read_json_auto',
    'read_text',
    'read_blob',
    'glob',
    'shell',
    'getenv',
  ],
  maxLength: 100_000,
};

export type RejectReason =
  | 'empty-statement'
  | 'unterminated-string'
  | 'unterminated-identifier'
  | 'unterminated-comment'
  | 'unterminated-dollar-quote'
  | 'too-long'
  | 'multiple-statements'
  | 'unclassified-statement'
  | 'banned-keyword'
  | 'banned-function'
  | 'version-pinned-table';

export interface GuardAccepted {
  readonly ok: true;
  readonly kind: StatementKind;
  readonly sql: string;
  readonly hasLimit: boolean;
}

export interface GuardRejected {
  readonly ok: false;
  readonly reason: RejectReason;
  readonly detail: string;
}

export type GuardVerdict = GuardAccepted | GuardRejected;

interface Token {
  readonly type: 'word' | 'quoted' | 'string' | 'number' | 'punct';
  readonly value: string;
}

class LexError extends Error {
  readonly reason: RejectReason;
  constructor(reason: RejectReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

const PUNCTUATION = new Set(['(', ')', ',', ';', '.', '*', '+', '-', '/', '%', '<', '>', '=', '!', '|', '[', ']', ':']);

function isWordStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isWordPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new LexError('unterminated-comment', 'block comment is not closed');
      i = end + 2;
      continue;
    }
    if (ch === "'") {
      let value = '';
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new LexError('unterminated-string', 'string literal is not closed');
        const current = sql.charAt(j);
        if (current === "'") {
          if (sql.charAt(j + 1) === "'") {
            value += "'";
            j += 2;
            continue;
          }
          break;
        }
        value += current;
        j += 1;
      }
      tokens.push({ type: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new LexError('unterminated-identifier', 'quoted identifier is not closed');
        const current = sql.charAt(j);
        if (current === '"') {
          if (sql.charAt(j + 1) === '"') {
            value += '"';
            j += 2;
            continue;
          }
          break;
        }
        value += current;
        j += 1;
      }
      tokens.push({ type: 'quoted', value });
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      // Backticks are ASCII-92 identifier quoting, valid in SQLite and MySQL.
      // Measured on BIRD Mini-Dev: 43 of 500 gold statements use them, and a
      // guard that rejects a valid identifier quote rejects a correct answer.
      let value = '';
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new LexError('unterminated-identifier', 'backtick identifier is not closed');
        const current = sql.charAt(j);
        if (current === '`') {
          if (sql.charAt(j + 1) === '`') {
            value += '`';
            j += 2;
            continue;
          }
          break;
        }
        value += current;
        j += 1;
      }
      tokens.push({ type: 'quoted', value });
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (match && match[0].length > 1) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) throw new LexError('unterminated-dollar-quote', 'dollar-quoted string is not closed');
        tokens.push({ type: 'string', value: sql.slice(i + tag.length, end) });
        i = end + tag.length;
        continue;
      }
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[0-9._eE+-]/.test(sql.charAt(j))) {
        const prev = sql.charAt(j);
        const next = sql.charAt(j + 1);
        if ((prev === 'e' || prev === 'E') && (next === '+' || next === '-')) {
          j += 2;
          continue;
        }
        j += 1;
      }
      tokens.push({ type: 'number', value: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (isWordStart(ch)) {
      let j = i;
      while (j < sql.length && isWordPart(sql.charAt(j))) j += 1;
      tokens.push({ type: 'word', value: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (PUNCTUATION.has(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    // An unknown character is not something we can classify, so it is a rejection.
    throw new LexError('unclassified-statement', `unsupported character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

function hasTopLevelLimit(tokens: readonly Token[]): boolean {
  let depth = 0;
  for (const token of tokens) {
    if (token.type === 'punct' && token.value === '(') depth += 1;
    if (token.type === 'punct' && token.value === ')') depth -= 1;
    if (depth === 0 && token.type === 'word' && token.value.toLowerCase() === 'limit') return true;
  }
  return false;
}

/**
 * Inspect a statement without executing it. Decision order is lexical error,
 * then length, then statement type (see design §8.22).
 */
export function inspectSql(sql: string, policy: GuardPolicy = DEFAULT_POLICY): GuardVerdict {
  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch (error) {
    if (error instanceof LexError) return { ok: false, reason: error.reason, detail: error.message };
    throw error;
  }
  if (tokens.length === 0) return { ok: false, reason: 'empty-statement', detail: 'nothing to execute' };
  if (sql.length > policy.maxLength) {
    return { ok: false, reason: 'too-long', detail: `${sql.length} > ${policy.maxLength}` };
  }

  const semicolons: number[] = [];
  tokens.forEach((token, index) => {
    if (token.type === 'punct' && token.value === ';') semicolons.push(index);
  });
  if (semicolons.length > 0) {
    const last = semicolons[semicolons.length - 1];
    if (last !== tokens.length - 1) {
      return { ok: false, reason: 'multiple-statements', detail: 'only one statement per call is allowed' };
    }
  }

  const head = tokens[0] as Token;
  const headWord = head.type === 'word' ? head.value.toLowerCase() : '';
  const kinds = policy.allowedKinds as readonly string[];
  if (!kinds.includes(headWord)) {
    return { ok: false, reason: 'unclassified-statement', detail: `statement must start with ${kinds.join('|')}` };
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.type !== 'word') continue;
    const lower = token.value.toLowerCase();
    if (policy.bannedWords.includes(lower)) {
      return { ok: false, reason: 'banned-keyword', detail: lower };
    }
    const next = tokens[index + 1];
    if (next && next.type === 'punct' && next.value === '(' && policy.bannedFunctions.includes(lower)) {
      return { ok: false, reason: 'banned-function', detail: lower };
    }
    if (lower === 'at') {
      const open = tokens[index + 1];
      const version = tokens[index + 2];
      if (
        open &&
        open.type === 'punct' &&
        open.value === '(' &&
        version &&
        version.type === 'word' &&
        version.value.toLowerCase() === 'version'
      ) {
        return { ok: false, reason: 'version-pinned-table', detail: 'AT (VERSION) reads historical snapshots' };
      }
    }
  }

  return { ok: true, kind: headWord as StatementKind, sql, hasLimit: hasTopLevelLimit(tokens) };
}

/** Append a row cap when the statement does not already carry one. */
export function withRowLimit(sql: string, maxRows: number): string {
  const verdict = inspectSql(sql);
  if (!verdict.ok || verdict.hasLimit) return sql;
  const trimmed = sql.trimEnd();
  const body = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed;
  return `${body} LIMIT ${Math.max(0, Math.trunc(maxRows))}`;
}
