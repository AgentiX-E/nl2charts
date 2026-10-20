export interface SchemaColumn {
  readonly name: string;
  readonly type: string;
  readonly samples?: readonly string[];
  readonly aliases?: readonly string[];
}

export interface SchemaTable {
  readonly table: string;
  readonly columns: readonly SchemaColumn[];
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
  return question
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .flatMap((token) => token.split('_'))
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function nameTokens(column: SchemaColumn): string[] {
  return tokenizeQuestion(column.name);
}

/**
 * Multi-recaller schema linking fused with Reciprocal Rank Fusion. Each recaller
 * is independent, so a failure in one (for example, no sample values) degrades
 * the ranking instead of emptying it.
 */
export type Recaller = 'name' | 'alias' | 'value';

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

export function renderSchemaCard(schema: readonly SchemaTable[], limit = 40): string {
  const lines: string[] = [];
  for (const table of schema) {
    lines.push(`${table.table}(${table.columns.map((column) => `${column.name} ${column.type}`).join(', ')})`);
    if (lines.length >= limit) break;
  }
  return lines.join('\n');
}
