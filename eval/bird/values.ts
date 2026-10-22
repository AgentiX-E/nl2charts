/**
 * Value grounding: the literals a question names, resolved to the column they live in.
 *
 * BIRD's per-question hint is worth 13.7pp over generated definitions, and two
 * attempts to replace it with external knowledge failed at +0.4pp and −0.6pp. The
 * reading that fits all three numbers: the hint is not general knowledge about how
 * "ratio" is defined, it is *instance* knowledge — that this database stores a
 * status as `Banned`, a currency as `EUR`, a meal price as `0`. Cross-database
 * retrieval cannot supply that, because the values belong to the schema under test.
 *
 * CHASE-SQL reaches the same conclusion from the other side: its first pipeline
 * stage is value retrieval, keyword extraction followed by LSH over the cells of the
 * database being queried.
 *
 * This module does the lookup without an embedding model: the profile already holds
 * the categorical values of every column, so a question token that equals a stored
 * value is a match. That is deliberately narrow — it finds `Banned`, not `banned
 * items` — because a fuzzy match would attach the wrong literal to the wrong column,
 * and a wrong literal is worse than an absent one.
 */
import type { DatabaseProfile } from '@agentix-e/nl2charts-ai';

export interface ValueMatch {
  readonly table: string;
  readonly column: string;
  /** The stored value, as it appears in the column. */
  readonly value: string;
}

/** One entry per (column, value) pair, keyed by the value a question would name. */
export type ValueIndex = ReadonlyMap<string, readonly ValueMatch[]>;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'for', 'to', 'is', 'are', 'was',
  'were', 'what', 'which', 'who', 'how', 'many', 'much', 'that', 'this', 'with',
  'by', 'as', 'at', 'from', 'be', 'do', 'does', 'did', 'list', 'give', 'show',
  'find', 'me', 'all', 'their', 'its', 'each', 'per', 'than', 'then', 'there',
]);

/** Values shorter than this collide with ordinary words too often to be evidence. */
const MIN_VALUE_LENGTH = 3;

export function normalizeValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Build the index for one database.
 *
 * Only categorical columns carry `values`, and only up to the profile's cap, so this
 * is the vocabulary a user could plausibly name — not every cell in the database.
 */
export function buildValueIndex(profile: DatabaseProfile): ValueIndex {
  const index = new Map<string, ValueMatch[]>();
  for (const column of profile.columns) {
    for (const raw of column.values ?? []) {
      const key = normalizeValue(raw);
      if (key.length < MIN_VALUE_LENGTH || STOPWORDS.has(key)) continue;
      const matches = index.get(key) ?? [];
      matches.push({ table: column.table, column: column.column, value: raw });
      index.set(key, matches);
    }
  }
  return index;
}

/** Words of the question, in order, without the ones that carry no content. */
export function questionTokens(question: string): string[] {
  return question
    .toLowerCase()
    .split(/[^a-z0-9_.]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= MIN_VALUE_LENGTH && !STOPWORDS.has(token));
}

/**
 * Values the question names, in the order the question names them.
 *
 * Two guards, both about not lying: a token that matches more than one column is
 * ambiguous and is dropped rather than guessed, and the same column is not repeated
 * for every token that lands in it.
 */
export function findValues(index: ValueIndex, question: string, max = 8): ValueMatch[] {
  const found: ValueMatch[] = [];
  const usedColumns = new Set<string>();
  for (const token of questionTokens(question)) {
    const matches = index.get(token);
    if (matches === undefined) continue;
    const columns = new Set(matches.map((match) => `${match.table}.${match.column}`));
    // "status" may be a value in three columns; attaching it to one of them is a coin
    // flip the model then has to correct.
    if (columns.size > 1) continue;
    const match = matches[0] as ValueMatch;
    const column = `${match.table}.${match.column}`;
    if (usedColumns.has(column)) continue;
    usedColumns.add(column);
    found.push(match);
    if (found.length >= max) break;
  }
  return found;
}

/**
 * Render the matches as lines, without a heading.
 *
 * The prompt owns every heading in this harness — a caller cannot add one for an
 * empty block, which is how a heading over nothing would invite the model to invent
 * the values it was promised.
 */
export function renderValues(matches: readonly ValueMatch[]): string {
  return matches.map((match) => `- ${match.table}.${match.column} stores '${match.value}'`).join('\n');
}
