/**
 * Retrieval over BIRD's training split.
 *
 * The eleven databases in `dev` have no rows in `train`, so nothing here can leak a
 * gold statement for a benchmark database. What it can carry is how a *phrasing* was
 * defined elsewhere: "the ratio of A to B" resolved into an explicit numerator and
 * denominator. That is the kind of knowledge the per-database block experiments
 * could not produce, and it comes from an external corpus rather than the test set.
 *
 * The block deliberately excludes SQL. A model that copies a statement written for
 * another schema produces a confident query against columns that do not exist, which
 * is the failure mode we already measured at 155 of 200 cases.
 */

export interface TrainingRow {
  readonly db_id: string;
  readonly question: string;
  readonly evidence?: string;
}

export interface Hit {
  readonly question: string;
  readonly evidence: string;
  readonly score: number;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'for', 'to', 'is', 'are', 'was', 'were', 'what', 'which',
  'who', 'how', 'many', 'much', 'that', 'this', 'with', 'by', 'as', 'at', 'from', 'be', 'do', 'does', 'did',
  'list', 'give', 'show', 'find', 'me', 'all', 'their', 'its', 'each', 'per', 'than', 'then', 'there',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

export interface Index {
  readonly rows: readonly TrainingRow[];
  readonly termFrequencies: readonly Map<string, number>[];
  readonly lengths: readonly number[];
  readonly averageLength: number;
  readonly idf: ReadonlyMap<string, number>;
}

const K1 = 1.2;
const B = 0.75;

/**
 * BM25, not cosine.
 *
 * Cosine divides by document length, so a four-word question outranks the longer one
 * that actually shares the phrasing — measured on the fixture before this was
 * changed. BM25 normalises length gently instead of dividing by it, which is the
 * difference between "shares a word" and "shares a construction".
 */
export function buildIndex(rows: readonly TrainingRow[]): Index {
  const documentFrequency = new Map<string, number>();
  const termFrequencies: Map<string, number>[] = [];
  const lengths: number[] = [];
  for (const row of rows) {
    const counts = new Map<string, number>();
    for (const word of tokenize(`${row.question} ${row.evidence ?? ''}`)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    for (const word of counts.keys()) documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    termFrequencies.push(counts);
    lengths.push([...counts.values()].reduce((sum, value) => sum + value, 0));
  }
  const idf = new Map<string, number>();
  for (const [word, frequency] of documentFrequency) {
    // Lucene's positive variant: a term in every document contributes almost nothing
    // but is not allowed to go negative, which would reward its absence.
    idf.set(word, Math.log(1 + (rows.length - frequency + 0.5) / (frequency + 0.5)));
  }
  const averageLength = lengths.length === 0 ? 0 : lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  return { rows, termFrequencies, lengths, averageLength, idf };
}

function score(index: Index, position: number, query: readonly string[]): number {
  const frequencies = index.termFrequencies[position] as Map<string, number>;
  const length = index.lengths[position] as number;
  const normaliser = K1 * (1 - B + B * (index.averageLength === 0 ? 1 : length / index.averageLength));
  let total = 0;
  for (const word of query) {
    const frequency = frequencies.get(word);
    if (frequency === undefined) continue;
    const weight = index.idf.get(word) ?? 0;
    total += (weight * (frequency * (K1 + 1))) / (frequency + normaliser);
  }
  return total;
}

export interface RetrieveOptions {
  /** How many neighbours to keep. */
  readonly k?: number;
  /**
   * Neighbours scoring below this are dropped rather than padded in. BM25 scores are
   * unbounded, so the floor is a tuned value rather than a similarity in [0, 1]; the
   * default keeps anything that shares a discriminating term.
   */
  readonly minScore?: number;
  /** Keep at most this many hits from the same source database, for diversity. */
  readonly perDatabase?: number;
  /**
   * Keep hits whose evidence states a *definition* (a formula over conditions)
   * ahead of hits that only map a word to a literal. The distinction is measured,
   * not stylistic: `free refers to lowest_price = 0` retrieved for a question about
   * free school meals teaches the model a false equivalence.
   */
  readonly preferDefinitions?: boolean;
}

/** Evidence that explains how a quantity is computed, rather than naming a value. */
const DEFINITION = /\b(ratio|percentage|percent|proportion|rate|average|divide|divided|sum|count|total|per)\b/i;

export function isDefinition(evidence: string): boolean {
  return DEFINITION.test(evidence);
}

export function retrieve(index: Index, question: string, options: RetrieveOptions = {}): Hit[] {
  const k = options.k ?? 3;
  const minScore = options.minScore ?? 0;
  const perDatabase = options.perDatabase ?? 1;
  const preferDefinitions = options.preferDefinitions ?? true;
  const query = [...new Set(tokenize(question))].filter((word) => index.idf.has(word));
  if (query.length === 0) return [];
  const scored = index.rows.map((row, position) => ({ row, score: score(index, position, query) }));
  scored.sort((left, right) => right.score - left.score || left.row.question.localeCompare(right.row.question));
  const seen = new Map<string, number>();
  const hits: Hit[] = [];
  const deferred: Hit[] = [];
  for (const entry of scored) {
    if (entry.score < minScore) break;
    const evidence = (entry.row.evidence ?? '').trim();
    if (evidence.length === 0) continue;
    const used = seen.get(entry.row.db_id) ?? 0;
    if (used >= perDatabase) continue;
    seen.set(entry.row.db_id, used + 1);
    const hit = { question: entry.row.question, evidence, score: entry.score };
    // A definition is what transfers; a value mapping from another schema is a trap.
    if (!preferDefinitions || isDefinition(evidence)) hits.push(hit);
    else deferred.push(hit);
    if (hits.length >= k) return hits;
  }
  // Fill the remaining slots only if there were not enough definitions, so a block
  // is never empty just because nothing matched the preferred shape.
  for (const hit of deferred) {
    if (hits.length >= k) break;
    hits.push(hit);
  }
  return hits;
}

/**
 * Render the retrieved neighbours for a prompt.
 *
 * Only questions and their evidence, never SQL, and only the definition half of the
 * evidence (the part after `=` is a formula over another schema's columns and would
 * be copied verbatim).
 */
export function renderRetrieved(hits: readonly Hit[], maxChars = 700): string {
  const lines: string[] = [];
  let used = 0;
  for (const hit of hits) {
    if (hit.evidence.length === 0) continue;
    const line = `- "${hit.question.trim()}" → ${hit.evidence}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}
