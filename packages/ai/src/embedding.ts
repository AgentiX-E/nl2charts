/**
 * An embedding-provider contract, symmetric with `LlmProvider`.
 *
 * The repository can already reach any OpenAI-compatible chat endpoint through
 * `createHttpProvider`, and a caller can inject a custom `LlmProvider`. Embeddings had no
 * such contract: the only retrieval in the tree was BM25 over tokens, and the strongest
 * training-free competitor (OpenSearch-SQL) is blocked precisely here — its value index is
 * an HNSW over cells and column names, which needs an embedding backend the repository
 * could not reach. This module is that backend.
 *
 * Three facts shape the interface:
 *
 * - A batch comes back as a set of `{index, embedding}` records, and a vendor is free to
 *   return them in any order. Pairing by position rather than by `index` silently attaches
 *   the wrong vector to the wrong text — a retrieval reading that looks plausible and is
 *   wrong. The provider reorders by `index` before anything sees the vectors.
 * - A short batch is a failure, not a partial answer. Returning fewer vectors than texts
 *   and letting the caller zip them would drop tail documents from the index without an
 *   error. The provider rejects the count.
 * - Dimension drift inside a batch means one of the vectors is not from the same model.
 *   A cosine similarity across mismatched dimensions throws in this package; the provider
 *   rejects it earlier, at the boundary where the response can still be attributed.
 *
 * The hashing provider is a real, deterministic algorithm — not a stub. It is the offline
 * fallback for a machine with no API key and the fixture every test uses to pin ordering,
 * normalisation and ranking without a network call.
 */

/** What a caller is asking an embedding for, so a meter can file the cost under a purpose. */
export type EmbeddingPurpose = 'retrieval-query' | 'retrieval-document' | 'example-selection' | 'unmeasured';

/** One embed call. `texts` is a batch; a provider must return one vector per text, in order. */
export interface EmbeddingRequest {
  readonly texts: readonly string[];
  readonly purpose?: EmbeddingPurpose;
}

/** Token usage an embedding endpoint reports, when it reports any. */
export interface EmbeddingUsage {
  readonly promptTokens: number;
  readonly totalTokens: number;
}

/** The reply: one vector per input text, plus the model and the common dimension. */
export interface EmbeddingResponse {
  readonly vectors: readonly (readonly number[])[];
  readonly model: string;
  readonly dimensions: number;
  readonly usage?: EmbeddingUsage;
}

/**
 * The contract a caller injects.
 *
 * `dimensions` is optional so a hand-written provider in a deployment keeps compiling; a
 * provider built by either factory here always declares it.
 */
export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions?: number;
  embed(request: EmbeddingRequest, options?: { signal?: AbortSignal }): Promise<EmbeddingResponse>;
}

/** Options for an OpenAI-compatible `/v1/embeddings` endpoint. */
export interface HttpEmbeddingOptions {
  /** Base URL such as `https://api.deepseek.com/v1`; never read from a client from a browser. */
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  /** Ask the endpoint for a fixed dimension; omitted when not configured. */
  readonly dimensions?: number;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * Maximum texts in one `/embeddings` request. Defaults to 64, the limit Zhipu embedding-3
   * publishes (code 1214 above it). A whole profile vocabulary is larger than one request, so the
   * provider chunks rather than making every caller know the endpoint's batch ceiling.
   */
  readonly batchSize?: number;
  /** Attempts for a 429 or 5xx; one means no retry. */
  readonly retries?: number;
  readonly retryDelayMs?: number;
  readonly retryJitter?: number;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
/** Zhipu embedding-3 refuses an input array above 64 (code 1214); the safe default for any OpenAI-compatible endpoint. */
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_JITTER = 0.5;

/** Smallest positive spread, so jitter=0 means no wait at all rather than a random fraction. */
function delayFor(base: number, attempt: number, jitter: number, random: () => number): number {
  const window = base * 2 ** attempt;
  return window * (1 - jitter + jitter * random());
}

function parseUsage(raw: unknown): EmbeddingUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const total = typeof usage.total_tokens === 'number' ? usage.total_tokens : prompt;
  if (prompt === undefined || total === undefined) return undefined;
  return { promptTokens: prompt, totalTokens: total };
}

interface VectorRecord {
  readonly index: number;
  readonly vector: readonly number[];
}

/** Pull the ordered vector records out of a wire body, rejecting the three silent failures. */
export function parseEmbeddingBody(raw: string, expectedCount: number): { vectors: readonly (readonly number[])[]; usage?: EmbeddingUsage } {
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error('embedding: malformed JSON response'); }
  if (!Array.isArray(body.data)) throw new Error('embedding: response has no data array');
  const records: VectorRecord[] = [];
  for (const item of body.data) {
    if (typeof item !== 'object' || item === null) throw new Error('embedding: malformed data record');
    const record = item as Record<string, unknown>;
    const index = typeof record.index === 'number' ? record.index : records.length;
    if (!Array.isArray(record.embedding) || !record.embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error('embedding: a vector is not an array of finite numbers');
    }
    records.push({ index, vector: record.embedding as readonly number[] });
  }
  // Vendors may return a batch out of order; index, not position, is the identity.
  records.sort((left, right) => left.index - right.index);
  if (records.length !== expectedCount) throw new Error(`embedding: expected ${String(expectedCount)} vectors, got ${String(records.length)}`);
  const dimensions = records[0]?.vector.length;
  if (records.some((row) => row.vector.length !== dimensions)) throw new Error('embedding: dimension drift inside one batch');
  return { vectors: records.map((row) => row.vector), usage: parseUsage(body.usage) };
}

/**
 * Build an embedding provider against an OpenAI-compatible endpoint.
 *
 * Retries cover 429 and 5xx only; a 400 is a wrong request and retrying it is how a run
 * quietly burns its budget. The response body of a retryable status is read and put in the
 * error so the caller can tell a rate limit from an outage.
 */
export function createHttpEmbeddingProvider(options: HttpEmbeddingOptions): EmbeddingProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const retryJitter = options.retryJitter ?? DEFAULT_JITTER;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`embedding: batchSize must be a positive integer, got ${String(batchSize)}`);
  }
  const path = `${options.baseUrl.replace(/\/+$/, '')}/embeddings`;
  /** One HTTP request with retries; the caller concatenates the batches. */
  const embedBatch = async (texts: readonly string[], callOptions?: { signal?: AbortSignal }) => {
    const body: Record<string, unknown> = { model: options.model, input: texts };
    if (options.dimensions !== undefined) body.dimensions = options.dimensions;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`;
    let lastStatus = 0;
    let lastBody = '';
    for (let attempt = 0; attempt < retries; attempt += 1) {
      if (attempt > 0) await sleep(delayFor(retryDelayMs, attempt - 1, retryJitter, random));
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      callOptions?.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(path, {
          method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        callOptions?.signal?.removeEventListener('abort', onAbort);
        if (callOptions?.signal?.aborted) throw error;
        if (attempt === retries - 1) throw error;
        continue;
      }
      clearTimeout(timer);
      callOptions?.signal?.removeEventListener('abort', onAbort);
      lastStatus = response.status;
      lastBody = await response.text();
      if (response.ok) {
        const parsed = parseEmbeddingBody(lastBody, texts.length);
        return parsed;
      }
      if (!RETRYABLE.has(response.status) || attempt === retries - 1) break;
    }
    throw new Error(`embedding: endpoint returned ${String(lastStatus)}: ${lastBody.slice(0, 200)}`);
  };
  return {
    id: `http:${options.baseUrl}`,
    model: options.model,
    dimensions: options.dimensions,
    async embed(request, callOptions) {
      // An already-aborted signal must not spend a request: `addEventListener('abort')` fires only
      // on a *future* abort, so without this check a pre-aborted call still goes out.
      if (callOptions?.signal?.aborted) throw new Error('embedding: aborted before send');
      const vectors: (readonly number[])[] = [];
      let promptTokens = 0;
      let totalTokens = 0;
      let sawUsage = false;
      for (let start = 0; start < request.texts.length; start += batchSize) {
        if (callOptions?.signal?.aborted) throw new Error('embedding: aborted before send');
        const batch = request.texts.slice(start, start + batchSize);
        const parsed = await embedBatch(batch, callOptions);
        vectors.push(...parsed.vectors);
        if (parsed.usage !== undefined) {
          sawUsage = true;
          promptTokens += parsed.usage.promptTokens;
          totalTokens += parsed.usage.totalTokens;
        }
      }
      return {
        vectors,
        model: options.model,
        dimensions: vectors[0]?.length ?? 0,
        ...(sawUsage ? { usage: { promptTokens, totalTokens } } : {}),
      };
    },
  };
}

/** Options for the offline deterministic provider. */
export interface HashEmbeddingOptions {
  readonly id?: string;
  readonly model?: string;
  readonly dimensions?: number;
}

const DEFAULT_DIMENSIONS = 256;
const DEFAULT_HASH_ID = 'hash-local';
const DEFAULT_HASH_MODEL = 'fnv1a-bag-of-words';

/** FNV-1a over a token; unsigned 32-bit, stable across runtimes. */
function fnv1a(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function hashTokens(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((word) => word.length > 1);
  for (const token of tokens) {
    const bucket = fnv1a(token) % dimensions;
    // `vector` was filled with zeros and `bucket` is always in range, so the slot exists.
    vector[bucket] = (vector[bucket] as number) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

/**
 * A deterministic bag-of-words embedding over hashed token buckets.
 *
 * It is not a semantic model and makes no such claim; it is the offline fallback that keeps
 * retrieval testable and runnable with no key, and the fixture that pins ordering and
 * normalisation. Shared tokens give a higher cosine, which is the only property the tests
 * assert about meaning.
 */
export function createHashEmbeddingProvider(options: HashEmbeddingOptions = {}): EmbeddingProvider {
  const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
  return {
    id: options.id ?? DEFAULT_HASH_ID,
    model: options.model ?? DEFAULT_HASH_MODEL,
    dimensions,
    async embed(request) {
      return {
        vectors: request.texts.map((text) => hashTokens(text, dimensions)),
        model: options.model ?? DEFAULT_HASH_MODEL,
        dimensions,
      };
    },
  };
}

/** Cosine similarity. Zero vectors score 0 by definition; mismatched dimensions throw. */
export function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) throw new Error('cosine: dimension mismatch');
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] as number;
    const b = right[index] as number;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/** One ranked result: the document's index and its cosine against the query. */
export interface RankedEmbedding {
  readonly index: number;
  readonly score: number;
}

/**
 * Rank documents by cosine against a query vector.
 *
 * Ties break on ascending index so the returned order is deterministic across engines and
 * across runs — a retrieval block whose examples move between runs is not a stable arm.
 */
export function rankByEmbedding(query: readonly number[], documents: readonly (readonly number[])[], k = 3): RankedEmbedding[] {
  const keep = Math.max(0, Math.min(k, documents.length));
  if (keep === 0) return [];
  return documents
    .map((document, index) => ({ index, score: cosine(query, document) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, keep);
}
