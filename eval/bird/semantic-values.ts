/**
 * Embedding-based value retrieval: the third way to attach a question word to a column.
 *
 * The repository already has two. `values.ts` resolves a token that *equals* a stored value
 * ("Banned" → legalities.status), and `askdata.ts` resolves a literal whose shingle set resembles
 * a stored value ("Fresno County Office of Education" → the column holding "Fresno County Office
 * Of Education"). Both are lexical: they need a shared token or a shared character n-gram. A
 * question that names a value in words the database does not store — "restricted cards" where the
 * column stores "Not Legal", or "the reissue" against a column of "reprint" — defeats both.
 *
 * OpenSearch-SQL, the strongest training-free system on BIRD (69.3 dev / 72.28 test), indexes
 * cells and column names in an HNSW space and retrieves by embedding distance. Round 214 shipped
 * the `EmbeddingProvider` contract that index needs; this module is the retrieval mechanism built
 * on it. It is deliberately a *candidate* mechanism: offline and testable with the deterministic
 * hash provider, injectable with any hosted provider, and honest that a semantic gain is a claim
 * that still needs a paired reading before it is priced against the 12.56pp BIRD gap.
 *
 * What the contract refuses, each a way to get a plausible-looking but wrong ranking:
 *
 * - **A query embedded in a different model space than the documents.** Cosine across two models
 *   is a number, but it is not a similarity; index and query must share provider id and model.
 * - **A dimension drift.** A vector from another model has a different length; scoring it would
 *   either throw deep in `cosine` or, if the lengths happened to match, compute nonsense.
 * - **An empty index or a question with no content words.** Both return before a call leaves: a
 *   retrieval block built on nothing is a prompt that invites the model to invent values.
 * - **An aborted signal.** `build` and `search` propagate it rather than returning a partial index.
 */
import {
  rankByEmbedding,
  type DatabaseProfile,
  type EmbeddingProvider,
} from '@agentix-e/nl2charts-ai';

/** One searchable field: the text that was embedded and the vector it became. */
export interface SemanticField {
  readonly table: string;
  readonly column: string;
  /** A stored value, when this field is a value rather than a column name. */
  readonly value?: string;
  /** The exact text handed to the embedding provider. */
  readonly text: string;
  readonly vector: readonly number[];
}

/** An immutable index. Callers build once per database and search many questions. */
export interface SemanticIndex {
  readonly fields: readonly SemanticField[];
  readonly providerId: string;
  readonly model: string;
  readonly dimensions: number;
}

/** The empty index, so a caller with no vocabulary needs no special case. */
export function emptySemanticIndex(): SemanticIndex {
  return { fields: [], providerId: '', model: '', dimensions: 0 };
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'for', 'to', 'is', 'are', 'was', 'were',
  'what', 'which', 'who', 'how', 'many', 'much', 'that', 'this', 'with', 'by', 'as', 'at',
  'from', 'be', 'do', 'does', 'did', 'list', 'give', 'show', 'find', 'me', 'all', 'their',
  'its', 'each', 'per', 'than', 'then', 'there',
]);

/** Content words of a question, in order. The same stopword list the lexical retriever uses. */
export function questionWords(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/**
 * The texts worth embedding from one profile, in a stable order.
 *
 * Two kinds, because the questions this retrieval serves name both: "status banned" is answered
 * by a *value* ("legalities.status = Banned") and "which table holds the status" by a *column*
 * ("legalities.status column"). Numeric and date columns are skipped — a question names their
 * ranges as arithmetic, not as a literal to resolve, and `evidence.ts` already covers ranges.
 */
export function vocabularyOf(profile: DatabaseProfile): { table: string; column: string; value?: string; text: string }[] {
  const entries: { table: string; column: string; value?: string; text: string }[] = [];
  const seen = new Set<string>();
  const add = (table: string, column: string, text: string, value?: string) => {
    const key = `${table}\u0000${column}\u0000${value ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(value === undefined ? { table, column, text } : { table, column, text, value });
  };
  for (const column of profile.columns) {
    if (column.kind !== 'categorical' && column.kind !== 'other') continue;
    add(column.table, column.column, `${column.table}.${column.column} column`);
    for (const value of column.values ?? []) {
      add(column.table, column.column, `${column.table}.${column.column} = ${value}`, value);
    }
  }
  return entries;
}

export interface BuildOptions {
  readonly signal?: AbortSignal;
}

/** Embed a profile's vocabulary into a searchable index. */
export async function buildSemanticIndex(
  profile: DatabaseProfile,
  provider: EmbeddingProvider,
  options: BuildOptions = {},
): Promise<SemanticIndex> {
  const entries = vocabularyOf(profile);
  if (entries.length === 0) return emptySemanticIndex();
  if (options.signal?.aborted) throw new Error('semantic-values: aborted before build');
  const response = await provider.embed(
    { texts: entries.map((entry) => entry.text), purpose: 'retrieval-document' },
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  if (response.vectors.length !== entries.length) {
    throw new Error(`semantic-values: expected ${String(entries.length)} vectors, got ${String(response.vectors.length)}`);
  }
  const dimensions = response.dimensions;
  const fields = entries.map((entry, position) => {
    const vector = response.vectors[position] as readonly number[];
    if (vector.length !== dimensions) throw new Error('semantic-values: dimension drift inside one batch');
    return { ...entry, vector };
  });
  return { fields, providerId: provider.id, model: provider.model, dimensions };
}

export interface SearchOptions {
  readonly k?: number;
  readonly minScore?: number;
  /** At most one hit per table.column by default, so one column cannot fill the block. */
  readonly perColumn?: number;
  readonly signal?: AbortSignal;
}

export interface SemanticHit {
  readonly field: SemanticField;
  readonly score: number;
}

/** Cosine-similarity of a query string against an index, with the contract guards. */
export async function searchSemanticValues(
  index: SemanticIndex,
  question: string,
  provider: EmbeddingProvider,
  options: SearchOptions = {},
): Promise<SemanticHit[]> {
  if (index.fields.length === 0) return [];
  const words = questionWords(question);
  if (words.length === 0) return [];
  if (provider.id !== index.providerId || provider.model !== index.model) {
    throw new Error('semantic-values: query provider does not match the index model');
  }
  if (options.signal?.aborted) throw new Error('semantic-values: aborted before search');
  const response = await provider.embed(
    { texts: [words.join(' ')], purpose: 'retrieval-query' },
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  const query = response.vectors[0];
  if (query === undefined || query.length !== index.dimensions) {
    throw new Error('semantic-values: query dimension does not match the index');
  }
  const ranked = rankByEmbedding(query, index.fields.map((field) => field.vector), index.fields.length);
  const k = options.k ?? 3;
  const minScore = options.minScore ?? 0;
  const perColumn = options.perColumn ?? 1;
  const used = new Map<string, number>();
  const hits: SemanticHit[] = [];
  for (const rank of ranked) {
    if (rank.score < minScore) break;
    const field = index.fields[rank.index] as SemanticField;
    const key = `${field.table}\u0000${field.column}`;
    const count = used.get(key) ?? 0;
    if (count >= perColumn) continue;
    used.set(key, count + 1);
    hits.push({ field, score: rank.score });
    if (hits.length >= k) break;
  }
  return hits;
}

/**
 * A paired reading: which fields one retriever found that the other did not.
 *
 * This is the unit of the pricing experiment Z.33 #1 asks for. A raw accuracy delta between two
 * arms is not enough — the two arms answer different questions, and an aggregate can hide that
 * the semantic retriever gained five columns and lost four. Pairing on the same fields exposes the
 * trade, and a McNemar test can then ask whether the imbalance is real. Keys are `table.column`:
 * both `values.ts` hits and `SemanticField` carry exactly those two names.
 */
export interface ValueRetrievalPair {
  readonly gained: readonly string[];
  readonly lost: readonly string[];
  readonly shared: readonly string[];
}

/** Fields found by `semantic` but not `exact`, and vice versa, each sorted for a stable reading. */
export function pairValueRetrieval(
  exact: readonly { readonly table: string; readonly column: string }[],
  semantic: readonly { readonly table: string; readonly column: string }[],
): ValueRetrievalPair {
  const key = (field: { readonly table: string; readonly column: string }) => `${field.table}.${field.column}`;
  const exactKeys = new Set(exact.map(key));
  const semanticKeys = new Set(semantic.map(key));
  return {
    gained: [...semanticKeys].filter((k) => !exactKeys.has(k)).sort(),
    lost: [...exactKeys].filter((k) => !semanticKeys.has(k)).sort(),
    shared: [...semanticKeys].filter((k) => exactKeys.has(k)).sort(),
  };
}

/** Render hits as a compact prompt block, cut at the last complete line under `maxChars`. */
export function renderSemanticValues(hits: readonly SemanticHit[], maxChars = 700): string {
  const lines: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const line = hit.field.value === undefined
      ? `- ${hit.field.table}.${hit.field.column} is a column`
      : `- ${hit.field.table}.${hit.field.column} stores '${hit.field.value}'`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}
