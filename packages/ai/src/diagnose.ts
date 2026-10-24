import type { SchemaTable } from './linking.js';

/**
 * Why a statement was rejected, in the terms the fix depends on.
 *
 * The classes are not a taxonomy for its own sake: each one implies a different
 * instruction. A binding failure is fixed by naming an existing column; a syntax
 * failure by changing a token at a position; a grouping failure by adding a column to
 * GROUP BY. A single "that failed, try again" sentence — which is what this pipeline
 * used to send — carries none of that, and the measured result was that repair bought
 * nothing (see docs/benchmarks.md).
 */
export type FailureClass =
  | 'guard'
  | 'syntax'
  | 'binding'
  | 'ambiguity'
  | 'type'
  | 'grouping'
  | 'permission'
  | 'timeout'
  | 'unknown';

/** The fields a driver reported, normalised across engines. */
export interface EngineErrorFields {
  readonly message: string;
  /** Driver-native code: a SQLSTATE for PostgreSQL, `ER_*`/`SQLITE_*` elsewhere. */
  readonly code?: string;
  /** Five-character SQLSTATE, when the engine actually uses one. */
  readonly sqlState?: string;
  /** 1-based character offset the engine pointed at, when it did. */
  readonly position?: number;
  readonly hint?: string;
  readonly detail?: string;
}

export interface Diagnosis {
  readonly failureClass: FailureClass;
  /** One line for logs and artifacts: class, code, engine message. */
  readonly summary: string;
  /** The user-role message for the next attempt. Deterministic and length-capped. */
  readonly feedback: string;
  /** Identifiers from the schema that the rejected one was probably meant to be. */
  readonly suggestions: readonly string[];
  readonly sqlState?: string;
  readonly position?: number;
}

const MAX_FEEDBACK = 900;
const MAX_SUGGESTIONS = 3;
const MAX_LISTED_COLUMNS = 8;
const MAX_DISTANCE = 2;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asPosition(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Read what the engine said, from whichever shape it arrived in.
 *
 * Adapters put the driver's own fields under `details.engineError`; a caller that
 * passes the driver's error straight through is read directly. Both paths exist
 * because the library is used without the engine packages, where there is no adapter
 * to normalise anything.
 */
export function readEngineError(error: unknown): EngineErrorFields {
  const outer = record(error);
  const embedded = outer === undefined ? undefined : record(record(outer.details)?.engineError);
  const source = embedded ?? outer ?? {};
  const fallback = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  // mysql2 puts the code in `message` and the engine's sentence in `sqlMessage`;
  // the sentence is what a repair reads, and the code is captured separately.
  const message =
    asText(source.sqlMessage) ?? asText(source.message) ?? asText(fallback) ?? 'the engine rejected the statement';
  const code = asText(source.code);
  const sqlState = asText(source.sqlState) ?? (code !== undefined && /^[0-9A-Z]{5}$/.test(code) ? code : undefined);
  const position = asPosition(source.position) ?? asPosition(source.offset);
  const hint = asText(source.hint);
  const detail = asText(source.detail);
  return {
    message,
    ...(code === undefined ? {} : { code }),
    ...(sqlState === undefined ? {} : { sqlState }),
    ...(position === undefined ? {} : { position }),
    ...(hint === undefined ? {} : { hint }),
    ...(detail === undefined ? {} : { detail }),
  };
}

const PATTERNS: readonly (readonly [FailureClass, RegExp])[] = [
  // Ambiguity is checked before binding: its message contains the word "column", and
  // the fix (qualify the name) is different from the fix for a missing name.
  ['ambiguity', /\bambiguous\b|\bambiguity\b/i],
  ['permission', /read[- ]?only|refused a write|permission denied|not authorized|access denied|insufficient privilege|attempt to write/i],
  ['timeout', /\btimeout\b|timed out|statement timeout|cancell?ing statement|\binterrupted\b|deadline/i],
  [
    'syntax',
    /\bsyntax error\b|\bparse error\b|\bparser error\b|near "[^"]*"|unexpected token|incomplete input|unrecognized token|unexpected end of/i,
  ],
  [
    'binding',
    /no such (column|table|function)|unknown (column|table|function)|column .* does not exist|relation .* does not exist|table .* does not exist|function .* does not exist|referenced column .* not found|column with name .* not found|binder error/i,
  ],
  ['grouping', /group by|misuse of aggregate|aggregate function|ungrouped column|must appear in the group/i],
  ['type', /datatype mismatch|cannot cast|operator does not exist|no such operator|type mismatch|invalid input syntax|incompatible types/i],
];

export function classifyFailure(message: string): FailureClass {
  for (const [failureClass, pattern] of PATTERNS) {
    if (pattern.test(message)) return failureClass;
  }
  return 'unknown';
}

/** `no such column: s.Schoolname` → `{ table: 's', bare: 'Schoolname', kind: 'column' }`. */
function readIdentifier(message: string, failureClass: FailureClass): { table?: string; bare: string; kind: 'column' | 'table' | 'function' } | undefined {
  const quoted = [
    /no such column:\s*([\w."`[\]]+)/i,
    /unknown column '([^']+)'/i,
    /column "([^"]+)" does not exist/i,
    /referenced column "?([\w."`[\]]+)"? not found/i,
    /column with name "?([\w."`[\]]+)"? not found/i,
    /unknown column '([^']+)' in 'field list'/i,
  ];
  for (const pattern of quoted) {
    const match = pattern.exec(message);
    if (match?.[1] !== undefined) return splitIdentifier(match[1], 'column');
  }
  const table = [
    /no such table:\s*([\w."`[\]]+)/i,
    /unknown table '([^']+)'/i,
    /relation "([^"]+)" does not exist/i,
    /table "([^"]+)" does not exist/i,
  ];
  for (const pattern of table) {
    const match = pattern.exec(message);
    if (match?.[1] !== undefined) return splitIdentifier(match[1], 'table');
  }
  const fn = /no such function:\s*([\w.]+)|function ([\w."]+) does not exist|unknown function '?([\w.]+)'?/i.exec(message);
  if (fn !== null) {
    const name = fn[1] ?? fn[2] ?? fn[3];
    if (name !== undefined) return { bare: name.replace(/"/g, ''), kind: 'function' };
  }
  if (failureClass === 'binding') return undefined;
  return undefined;
}

function splitIdentifier(raw: string, kind: 'column' | 'table' | 'function'): { table?: string; bare: string; kind: typeof kind } {
  const clean = raw.replace(/["`[\]]/g, '').trim();
  const dot = clean.lastIndexOf('.');
  if (dot === -1) return { bare: clean, kind };
  return { table: clean.slice(0, dot), bare: clean.slice(dot + 1), kind };
}

function normalise(name: string): string {
  return name.toLowerCase().replace(/[\s_]/g, '');
}

function distance(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  const rows = a.length + 1;
  const columns = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, (_, index) => [index]);
  for (let column = 1; column < columns; column += 1) (table[0] as number[])[column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      const current = table[row] as number[];
      const previous = table[row - 1] as number[];
      current[column] = Math.min(
        (previous[column] as number) + 1,
        (current[column - 1] as number) + 1,
        (previous[column - 1] as number) + cost,
      );
    }
  }
  return (table[rows - 1] as number[])[columns - 1] as number;
}

/** How far a candidate is from the rejected name, with prefix matches ranked near exact. */
function closeness(bare: string, candidate: string): number {
  const left = normalise(bare);
  const right = normalise(candidate);
  if (left === right) return 0;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length >= 4 && longer.startsWith(shorter)) return 1;
  return distance(left, right);
}

interface Suggestion {
  readonly qualified: string;
  readonly score: number;
}

const CLAUSE_WORDS = new Set([
  'where',
  'on',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'natural',
  'join',
  'group',
  'order',
  'limit',
  'having',
  'union',
  'except',
  'intersect',
  'window',
  'qualify',
  'using',
  'as',
  'offset',
  'fetch',
]);

/**
 * Alias → table, read from the statement that failed.
 *
 * The engine reports `no such column: s.Schoolname`, and `s` is an alias. Without
 * resolving it, the suggestion search falls back to the whole schema and offers
 * `schools.SchoolName` for a statement that only reads `students` — a repair aimed at
 * the wrong relation, which is worse than no suggestion.
 */
export function resolveAliases(sql: string, schema: readonly SchemaTable[]): Map<string, string> {
  const known = new Set(schema.map((table) => table.table.toLowerCase()));
  const aliases = new Map<string, string>();
  const pattern = /\b(?:from|join)\s+(["`[]?[\w$]+["`\]]?)(?:\s+(?:as\s+)?(["`[]?[\w$]+["`\]]?))?/gi;
  for (const match of sql.matchAll(pattern)) {
    const table = (match[1] ?? '').replace(/["`[\]]/g, '');
    const alias = (match[2] ?? '').replace(/["`[\]]/g, '');
    if (table.length === 0) continue;
    if (alias.length > 0 && !CLAUSE_WORDS.has(alias.toLowerCase()) && !known.has(alias.toLowerCase())) {
      aliases.set(alias.toLowerCase(), table.toLowerCase());
    }
  }
  return aliases;
}

/**
 * The one table the statement reads, when there is exactly one.
 *
 * `no such column: StudentNickname` arrives without a qualifier, and the schema-wide
 * column dump this used to produce was eight names from five tables. The statement's
 * own FROM clause is better information: with one relation, its columns are the ones
 * the statement could have meant.
 */
export function soleRelation(sql: string): string | undefined {
  const names = new Set<string>();
  const pattern = /\b(?:from|join)\s+(["`[]?[\w$]+["`\]]?)/gi;
  for (const match of sql.matchAll(pattern)) {
    const name = (match[1] ?? '').replace(/["`[\]]/g, '');
    if (name.length > 0) names.add(name.toLowerCase());
  }
  return names.size === 1 ? [...names][0] : undefined;
}

function suggestColumns(
  schema: readonly SchemaTable[],
  identifier: { table?: string; bare: string },
  aliases: ReadonlyMap<string, string>,
): Suggestion[] {
  const rawHint = identifier.table?.toLowerCase();
  const hint = rawHint === undefined ? undefined : (aliases.get(rawHint) ?? rawHint);
  const scoped = hint === undefined ? schema : schema.filter((table) => table.table.toLowerCase() === hint);
  const searched = scoped.length > 0 ? scoped : schema;
  const out: Suggestion[] = [];
  for (const table of searched) {
    for (const column of table.columns) {
      const score = closeness(identifier.bare, column.name);
      if (score <= MAX_DISTANCE) out.push({ qualified: `${table.table}.${column.name}`, score });
    }
  }
  return out.sort((left, right) => left.score - right.score || left.qualified.localeCompare(right.qualified));
}

function suggestTables(schema: readonly SchemaTable[], bare: string): Suggestion[] {
  const out: Suggestion[] = [];
  for (const table of schema) {
    const score = closeness(bare, table.table);
    if (score <= MAX_DISTANCE) out.push({ qualified: table.table, score });
  }
  return out.sort((left, right) => left.score - right.score || left.qualified.localeCompare(right.qualified));
}

/** The columns of the table a qualified name pointed at, for the "these exist" line. */
function columnList(schema: readonly SchemaTable[], tableHint: string | undefined, identifier: string): string[] {
  const tables = tableHint === undefined ? schema : schema.filter((table) => table.table.toLowerCase() === tableHint.toLowerCase());
  const names = (tables.length > 0 ? tables : schema).flatMap((table) => table.columns.map((column) => column.name));
  return names.filter((name) => normalise(name) !== normalise(identifier)).slice(0, MAX_LISTED_COLUMNS);
}

const INSTRUCTIONS: Readonly<Record<FailureClass, string>> = {
  guard: 'Only one read-only SELECT statement is accepted: no DDL or DML, no comments, no second statement, and no file or shell functions.',
  syntax: 'The statement does not parse in this dialect. Fix the token the caret points at and keep the rest as it is.',
  binding: 'Use only tables and columns that exist in the schema above, spelled exactly as they are there. Do not invent names.',
  ambiguity: 'Two relations expose that name. Qualify it with the table alias the question is about.',
  type: 'The comparison mixes incompatible types. Cast explicitly, or compare against a literal of the column type.',
  grouping: 'Every column in the select list that is not aggregated must appear in GROUP BY, spelled identically.',
  permission: 'The connection is read-only. Rewrite as a SELECT: no INSERT, UPDATE, DELETE, DDL or temporary tables.',
  timeout: 'The query exceeded the execution limit. Filter before joining, aggregate before joining, and avoid correlated subqueries per row.',
  unknown: 'Fix the engine\'s complaint and change nothing else about the question.',
};

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export interface FailureInput {
  readonly sql: string;
  readonly schema: readonly SchemaTable[];
  /** Dialect name used in the message, e.g. `SQLite`. */
  readonly dialect?: string;
  /** The error the engine threw. */
  readonly error?: unknown;
  /** A refusal from `inspectSql`, which never reaches the engine. */
  readonly guard?: { readonly reason: string; readonly detail: string };
}

/**
 * Turn a rejection into the next prompt turn.
 *
 * Everything here is derived from what the engine and the schema actually contain.
 * That is the difference between feedback and encouragement: the model is told which
 * identifier it invented, which one exists two edits away, and which columns the table
 * really has.
 */
export function diagnoseFailure(input: FailureInput): Diagnosis {
  if (input.guard !== undefined) {
    const summary = `guard: ${input.guard.reason} (${input.guard.detail})`;
    const feedback = [
      'That statement was rejected before it ran. Fix exactly the problem below; keep the rest as it is.',
      '',
      `Guard: ${input.guard.reason} — ${input.guard.detail}`,
      '',
      INSTRUCTIONS.guard,
    ].join('\n');
    return { failureClass: 'guard', summary, feedback: clip(feedback, MAX_FEEDBACK), suggestions: [] };
  }

  const fields = readEngineError(input.error);
  const failureClass = classifyFailure(fields.message);
  const identifier = readIdentifier(fields.message, failureClass);
  const aliases = resolveAliases(input.sql, input.schema);
  // A suggestion identical to the rejected *qualified* name is not a suggestion: the
  // engine has already said that name does not exist, and offering it back spends the
  // turn. Comparing only the column part would discard the useful case — the name is
  // right and the table is wrong (`s.SchoolName` where `s` is not `schools`).
  const relation = identifier?.table === undefined ? undefined : (aliases.get(identifier.table.toLowerCase()) ?? identifier.table);
  // A qualifier wins; without one, a single-relation statement names its own scope.
  const rejectedTable = relation ?? (identifier?.kind === 'column' ? soleRelation(input.sql) : undefined);
  // Case is preserved on purpose: in PostgreSQL an unquoted `Schoolname` folds to
  // `schoolname` and fails against a `"SchoolName"` column, so a suggestion that
  // differs only in case is the fix rather than a repeat.
  const canonical = (name: string): string => name.replace(/["`[\]]/g, '');
  const notSelf = (suggestion: Suggestion): boolean => {
    if (identifier === undefined) return true;
    const parts = suggestion.qualified.split('.');
    const column = parts.pop() ?? '';
    if (identifier.kind === 'table') return canonical(column) !== canonical(identifier.bare);
    if (canonical(column) !== canonical(identifier.bare)) return true;
    return rejectedTable === undefined || canonical(parts.join('.')) !== canonical(rejectedTable);
  };
  const suggestions =
    identifier === undefined
      ? []
      : identifier.kind === 'table'
        ? suggestTables(input.schema, identifier.bare).filter(notSelf).slice(0, MAX_SUGGESTIONS)
        : identifier.kind === 'column'
          ? suggestColumns(input.schema, identifier, aliases).filter(notSelf).slice(0, MAX_SUGGESTIONS)
          : [];
  const qualified = suggestions.map((suggestion) => suggestion.qualified);
  const dialect = input.dialect === undefined ? '' : `${input.dialect}, `;
  const summary = `${failureClass}: ${dialect}${fields.message}`;

  const lines: string[] = ['That statement was rejected. Fix exactly the problem below; keep the rest of the statement as it is.', ''];
  lines.push(`${dialect}${fields.sqlState === undefined ? '' : `${fields.sqlState}: `}${fields.message}`);

  const position = fields.position;
  if (position !== undefined && position <= input.sql.length) {
    const from = Math.max(0, position - 1 - 30);
    const to = Math.min(input.sql.length, position - 1 + 30);
    const head = from > 0 ? '…' : '';
    lines.push(head + input.sql.slice(from, to).replace(/\n/g, ' '));
    lines.push(`${' '.repeat((from > 0 ? 1 : 0) + (position - 1 - from))}^`);
  }
  if (fields.hint !== undefined) lines.push(`Engine hint: ${fields.hint}`);
  if (fields.detail !== undefined) lines.push(`Engine detail: ${fields.detail}`);

  if (qualified.length > 0) {
    lines.push('', `Closest identifier in the schema: ${qualified.join(', ')}.`);
  } else if (identifier !== undefined && identifier.kind === 'column') {
    lines.push('', `No column in the schema is close to \`${identifier.bare}\`.`);
  } else if (identifier !== undefined && identifier.kind === 'table') {
    lines.push('', `No table in the schema is close to \`${identifier.bare}\`.`);
  }
  // Only when the failure named a table. Without one, a dump of the first eight
  // columns across the whole schema reads as `id, alignment, id, attribute_name` —
  // noise that competes with the question and teaches nothing.
  if (identifier !== undefined && identifier.kind === 'column' && rejectedTable !== undefined) {
    const listed = columnList(input.schema, rejectedTable, identifier.bare);
    if (listed.length > 0) lines.push(`\`${rejectedTable}\` has: ${listed.join(', ')}.`);
  }
  if (identifier !== undefined && identifier.kind === 'function') {
    lines.push(`${input.dialect ?? 'This dialect'} has no function \`${identifier.bare}\`. Use a documented equivalent.`);
  }

  lines.push('', INSTRUCTIONS[failureClass]);
  return {
    failureClass,
    summary,
    feedback: clip(lines.join('\n'), MAX_FEEDBACK),
    suggestions: qualified,
    ...(fields.sqlState === undefined ? {} : { sqlState: fields.sqlState }),
    ...(position === undefined ? {} : { position }),
  };
}
