import { words } from './text.js';

export interface SchemaColumn {
  readonly name: string;
  readonly type: string;
  /** One-line business meaning, shown in the schema card. */
  readonly comment?: string;
  readonly samples?: readonly string[];
  readonly aliases?: readonly string[];
}

export interface SchemaTable {
  readonly table: string;
  readonly columns: readonly SchemaColumn[];
  /** Join hints, rendered one per line under the table when enabled. */
  readonly foreignKeys?: readonly string[];
}

export interface LinkedColumn {
  readonly table: string;
  readonly column: string;
  readonly score: number;
  readonly recalledBy: readonly string[];
}

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'how',
  'in',
  'is',
  'of',
  'on',
  'per',
  'show',
  'the',
  'to',
  'top',
  'what',
  'which',
  'with',
]);

export function tokenizeQuestion(question: string): string[] {
  return words(question)
    .flatMap((token) => token.split('_'))
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function nameTokens(column: SchemaColumn): string[] {
  return tokenizeQuestion(column.name);
}

/**
 * Whether a question token names a table.
 *
 * The plural question is the common one: the question says "customers" and the table is
 * `customers`, or the question says "customer" and the table is plural. Four characters is
 * the floor, because `orders` starts with `or` and a two-letter prefix would make every table
 * whose name begins with a stopword look named.
 */
function namesTable(token: string, table: string): boolean {
  const name = table.toLowerCase();
  if (token === name) return true;
  if (token.length < 4 || name.length < 4) return false;
  return name.startsWith(token) || token.startsWith(name);
}

/**
 * Multi-recaller schema linking fused with Reciprocal Rank Fusion. Each recaller
 * is independent, so a failure in one (for example, no sample values) degrades
 * the ranking instead of emptying it.
 *
 * `table` is not in the default set. It was added after the corpus was measured rather than
 * before: on 496 Mini-Dev questions the linker with the default recallers named no column at
 * all for one case in six, because the questions that fail it name an entity ("the customers
 * who pay in EUR") and no column of it. Widening `name` to read table names would have fixed
 * that and changed the hint every measured arm sends, which would have made those
 * measurements describe a prompt nobody had run. The recaller is opt-in for that reason.
 */
export type Recaller = 'name' | 'alias' | 'value' | 'table';

export function linkSchema(
  question: string,
  schema: readonly SchemaTable[],
  topK = 12,
  recallers: readonly Recaller[] = ['name', 'alias', 'value'],
): LinkedColumn[] {
  const tokens = tokenizeQuestion(question);
  if (tokens.length === 0) return [];
  const tokenSet = new Set(tokens);

  interface Candidate {
    table: string;
    column: string;
    scores: Map<string, number>;
  }

  const candidates = new Map<string, Candidate>();
  for (const table of schema) {
    for (const column of table.columns) {
      candidates.set(`${table.table}.${column.name}`, {
        table: table.table,
        column: column.name,
        scores: new Map(),
      });
    }
  }

  const bump = (candidate: Candidate, recaller: string, rank: number): void => {
    const contribution = 1 / (60 + rank);
    candidate.scores.set(recaller, (candidate.scores.get(recaller) ?? 0) + contribution);
  };

  const rank = (recaller: string, score: (candidate: Candidate) => number): void => {
    const ranked = [...candidates.values()]
      .map((candidate) => ({ candidate, value: score(candidate) }))
      .filter((entry) => entry.value > 0)
      .sort((left, right) => right.value - left.value || left.candidate.column.localeCompare(right.candidate.column));
    ranked.forEach((entry, index) => bump(entry.candidate, recaller, index + 1));
  };

  if (recallers.includes('name')) rank('name', (candidate) => {
    const parts = nameTokens({ name: candidate.column, type: '' });
    return parts.filter((part) => tokenSet.has(part)).length;
  });

  if (recallers.includes('table')) rank('table', (candidate) => {
    const table = candidate.table.toLowerCase();
    return tokens.filter((token) => namesTable(token, table)).length;
  });

  if (recallers.includes('alias')) rank('alias', (candidate) => {
    const table = schema.find((entry) => entry.table === candidate.table);
    const column = table?.columns.find((entry) => entry.name === candidate.column);
    if (!column?.aliases) return 0;
    const aliasTokens = column.aliases.flatMap((alias) => tokenizeQuestion(alias));
    return aliasTokens.filter((alias) => tokenSet.has(alias)).length;
  });

  if (recallers.includes('value')) rank('value', (candidate) => {
    const table = schema.find((entry) => entry.table === candidate.table);
    const column = table?.columns.find((entry) => entry.name === candidate.column);
    if (!column?.samples) return 0;
    return column.samples.filter((sample) => {
      const sampleTokens = tokenizeQuestion(sample);
      return sampleTokens.some((sampleToken) => tokenSet.has(sampleToken));
    }).length;
  });

  return [...candidates.values()]
    .map((candidate) => ({
      table: candidate.table,
      column: candidate.column,
      score: [...candidate.scores.values()].reduce((total, value) => total + value, 0),
      recalledBy: [...candidate.scores.keys()].sort(),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.table.localeCompare(right.table) ||
        left.column.localeCompare(right.column),
    )
    .slice(0, topK);
}

export interface SchemaCardOptions {
  /** Include enum sample values. Off by default: samples invite invented filters. */
  readonly samples?: boolean;
  /** Include column comments. Off means names and types only. */
  readonly descriptions?: boolean;
  /** Include the table's join hints. */
  readonly foreignKeys?: boolean;
}

/**
 * Quote an identifier only when SQLite would need it. Datasets such as BIRD use
 * names like `Percent (%) Eligible Free (K-12)`; showing them bare invites the
 * model to read part of the name as an expression.
 */
export function renderName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export function renderSchemaCard(
  schema: readonly SchemaTable[],
  limit = 40,
  options: SchemaCardOptions = { descriptions: true },
): string {
  const withDescriptions = options.descriptions !== false;
  const lines: string[] = [];
  for (const table of schema) {
    const columns = table.columns.map((column) => {
      const base = `${renderName(column.name)} ${column.type}`;
      const withSamples =
        options.samples === true && column.samples !== undefined && column.samples.length > 0
          ? `${base} [${column.samples.join('|')}]`
          : base;
      return withDescriptions && column.comment !== undefined ? `${withSamples} -- ${column.comment}` : withSamples;
    });
    lines.push(`${table.table}(${columns.join(', ')})`);
    if (options.foreignKeys === true && table.foreignKeys !== undefined) {
      for (const hint of table.foreignKeys) lines.push(`  join: ${hint}`);
    }
    if (lines.length >= limit) break;
  }
  return lines.join('\n');
}
