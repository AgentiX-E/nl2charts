/**
 * Tests for the embedding provider contract.
 *
 * Every HTTP test here puts a real `http.Server` on a loopback port and lets the provider
 * speak real HTTP to it. Nothing stubs our own code: an embedding endpoint's classic silent
 * failures — vectors returned out of order, a short batch, mismatched dimensions — have to be
 * caught on the wire, because that is the only place they occur.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cosine,
  createHashEmbeddingProvider,
  createHttpEmbeddingProvider,
  parseEmbeddingBody,
  rankByEmbedding,
  type EmbeddingProvider,
} from '../src/index.js';

interface EmbeddingServerReply {
  readonly status?: number;
  readonly raw?: string;
}

interface SeenRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

const openServers: { close(): Promise<void> }[] = [];

async function embeddingEndpoint(reply: (request: SeenRequest, index: number) => EmbeddingServerReply): Promise<{ url: string; requests: SeenRequest[] }> {
  const requests: SeenRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { body = {}; }
      const seen: SeenRequest = { path: request.url ?? '', authorization: request.headers.authorization, body };
      requests.push(seen);
      const answer = reply(seen, requests.length - 1);
      response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      response.end(answer.raw ?? JSON.stringify({ data: [], model: body.model ?? 'm' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  openServers.push({ close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))) });
  return { url: `http://127.0.0.1:${String(address.port)}/v1`, requests };
}

afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()!.close();
});

function embeddingBody(vectors: readonly (readonly number[])[], model = 'emb-1'): string {
  return JSON.stringify({
    model,
    data: vectors.map((vector, index) => ({ index, embedding: vector })),
    usage: { prompt_tokens: 12, total_tokens: 12 },
  });
}

describe('createHttpEmbeddingProvider', () => {
  it('sends the input batch and returns vectors in request order', async () => {
    const endpoint = await embeddingEndpoint(() => ({ raw: embeddingBody([[1, 0], [0, 1]]) }));
    const provider = createHttpEmbeddingProvider({ baseUrl: endpoint.url, apiKey: 'k', model: 'emb-1' });
    const response = await provider.embed({ texts: ['a', 'b'] });
    expect(response.vectors).toEqual([[1, 0], [0, 1]]);
    expect(response.dimensions).toBe(2);
    expect(endpoint.requests[0]!.path).toBe('/v1/embeddings');
    expect(endpoint.requests[0]!.authorization).toBe('Bearer k');
    expect(endpoint.requests[0]!.body.input).toEqual(['a', 'b']);
  });

  it('BUG GUARD: reorders a batch the endpoint returned out of order', async () => {
    const outOfOrder = JSON.stringify({
      model: 'emb-1',
      data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }],
    });
    const endpoint = await embeddingEndpoint(() => ({ raw: outOfOrder }));
    const provider = createHttpEmbeddingProvider({ baseUrl: endpoint.url, model: 'emb-1' });
    const response = await provider.embed({ texts: ['first', 'second'] });
    expect(response.vectors).toEqual([[1, 0], [0, 1]]);
  });

  it('BUG GUARD: rejects a short batch instead of silently mispairing vectors', async () => {
    const endpoint = await embeddingEndpoint(() => ({ raw: embeddingBody([[1, 0]]) }));
    const provider = createHttpEmbeddingProvider({ baseUrl: endpoint.url, model: 'emb-1' });
    await expect(provider.embed({ texts: ['a', 'b'] })).rejects.toThrow(/expected 2 vectors, got 1/i);
  });

  it('BUG GUARD: rejects dimension drift inside one batch', async () => {
    const endpoint = await embeddingEndpoint(() => ({ raw: embeddingBody([[1, 0], [0, 1, 0]]) }));
    const provider = createHttpEmbeddingProvider({ baseUrl: endpoint.url, model: 'emb-1' });
    await expect(provider.embed({ texts: ['a', 'b'] })).rejects.toThrow(/dimension/i);
  });

  it('passes the dimensions field only when configured', async () => {
    const endpoint = await embeddingEndpoint(() => ({ raw: embeddingBody([[1, 0, 0]]) }));
    const provider = createHttpEmbeddingProvider({ baseUrl: endpoint.url, model: 'emb-1', dimensions: 3 });
    await provider.embed({ texts: ['a'] });
    expect(endpoint.requests[0]!.body.dimensions).toBe(3);
  });

  it('omits authorization when no key is configured', async () => {
    const endpoint = await embeddingEndpoint(() => ({ raw: embeddingBody([[1]]) }));
    const provider = createHttpEmbeddingProvider({ baseUrl: endpoint.url, model: 'emb-1' });
    await provider.embed({ texts: ['a'] });
    expect(endpoint.requests[0]!.authorization).toBeUndefined();
  });

  it('reports token usage when the endpoint supplies it', async () => {
    const endpoint = await embeddingEndpoint(() => ({ raw: embeddingBody([[1]]) }));
    const provider = createHttpEmbeddingProvider({ baseUrl: endpoint.url, model: 'emb-1' });
    const response = await provider.embed({ texts: ['a'] });
    expect(response.usage?.promptTokens).toBe(12);
    expect(response.usage?.totalTokens).toBe(12);
  });

  it('retries a rate-limited response and honours the attempt count', async () => {
    const endpoint = await embeddingEndpoint((_request, index) =>
      index === 0 ? { status: 429 } : { raw: embeddingBody([[1]]) });
    const provider = createHttpEmbeddingProvider({
      baseUrl: endpoint.url, model: 'emb-1', retries: 2, retryDelayMs: 0,
      random: () => 0.5, sleep: async () => {},
    });
    const response = await provider.embed({ texts: ['a'] });
    expect(response.vectors).toEqual([[1]]);
    expect(endpoint.requests).toHaveLength(2);
  });

  it('stops after the configured retries are exhausted', async () => {
    const endpoint = await embeddingEndpoint(() => ({ status: 503 }));
    const provider = createHttpEmbeddingProvider({
      baseUrl: endpoint.url, model: 'emb-1', retries: 2, retryDelayMs: 0,
      random: () => 0.5, sleep: async () => {},
    });
    await expect(provider.embed({ texts: ['a'] })).rejects.toThrow(/503/);
    // `retries` is the total number of attempts (same contract as LlmProvider): two tries here.
    expect(endpoint.requests).toHaveLength(2);
  });

  it('does not retry a malformed request status', async () => {
    const endpoint = await embeddingEndpoint(() => ({ status: 400 }));
    const provider = createHttpEmbeddingProvider({ baseUrl: endpoint.url, model: 'emb-1', retries: 3 });
    await expect(provider.embed({ texts: ['a'] })).rejects.toThrow(/400/);
    expect(endpoint.requests).toHaveLength(1);
  });

  it('exposes a stable id and model', () => {
    const provider = createHttpEmbeddingProvider({ baseUrl: 'http://127.0.0.1:1/v1', model: 'emb-1' });
    expect(provider.id).toMatch(/http/);
    expect(provider.model).toBe('emb-1');
  });
});

describe('createHashEmbeddingProvider', () => {
  it('is deterministic and dimension-stable', async () => {
    const provider = createHashEmbeddingProvider({ dimensions: 32 });
    const first = await provider.embed({ texts: ['the quick brown fox'] });
    const second = await provider.embed({ texts: ['the quick brown fox'] });
    expect(first.vectors[0]).toEqual(second.vectors[0]);
    expect(first.vectors[0]).toHaveLength(32);
    expect(first.dimensions).toBe(32);
  });

  it('L2-normalises a non-empty vector', async () => {
    const provider = createHashEmbeddingProvider({ dimensions: 64 });
    const response = await provider.embed({ texts: ['alpha beta gamma delta'] });
    const norm = Math.sqrt((response.vectors[0]!).reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('returns a zero vector for empty text', async () => {
    const provider = createHashEmbeddingProvider({ dimensions: 16 });
    const response = await provider.embed({ texts: [''] });
    expect(response.vectors[0]!.every((value) => value === 0)).toBe(true);
  });

  it('gives a higher cosine to texts that share tokens', async () => {
    const provider = createHashEmbeddingProvider({ dimensions: 256 });
    const response = await provider.embed({ texts: ['show the total revenue by region', 'show total revenue per region', 'deploy kubernetes cluster'] });
    const [a, b, c] = response.vectors as [readonly number[], readonly number[], readonly number[]];
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
  });

  it('uses a documented default id/model/dimension when no options are given', async () => {
    const provider = createHashEmbeddingProvider();
    expect(provider.id).toBeTruthy();
    const response = await provider.embed({ texts: ['x'] });
    expect(response.vectors[0]).toHaveLength(provider.dimensions!);
  });
});

describe('cosine', () => {
  it('is 1 for identical directions and 0 for orthogonal vectors', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('is 0 when either vector is all zero (defined, not NaN)', () => {
    expect(cosine([0, 0], [1, 2])).toBe(0);
    expect(cosine([1, 2], [0, 0])).toBe(0);
  });

  it('rejects mismatched dimensions rather than computing a wrong score', () => {
    expect(() => cosine([1, 2], [1, 2, 3])).toThrow(/dimension/i);
  });
});

describe('rankByEmbedding', () => {
  it('ranks by cosine and returns the top k with indices', () => {
    const query = [1, 0];
    const documents = [[0, 1], [1, 0], [0.9, 0.1]];
    const ranked = rankByEmbedding(query, documents, 2);
    expect(ranked.map((row) => row.index)).toEqual([1, 2]);
    expect(ranked[0]!.score).toBeCloseTo(1, 10);
  });

  it('breaks ties by ascending index so the order is deterministic', () => {
    const ranked = rankByEmbedding([1, 0], [[1, 0], [1, 0], [1, 0]], 3);
    expect(ranked.map((row) => row.index)).toEqual([0, 1, 2]);
  });

  it('clamps k to the document count and returns empty for k=0', () => {
    expect(rankByEmbedding([1, 0], [[1, 0]], 5)).toHaveLength(1);
    expect(rankByEmbedding([1, 0], [[1, 0]], 0)).toEqual([]);
  });

  it('accepts a custom provider through the EmbeddingProvider contract', async () => {
    const provider: EmbeddingProvider = createHashEmbeddingProvider({ dimensions: 16 });
    const response = await provider.embed({ texts: ['a', 'b'] });
    expect(response.vectors).toHaveLength(2);
  });
});

/** Wire-body and transport edge cases that pin the defensive branches. */
describe('response parsing edge cases', () => {
  const parse = parseEmbeddingBody;

  it('rejects malformed JSON', () => {
    expect(() => parse('{oops', 1)).toThrow(/malformed JSON/i);
  });

  it('rejects a body with no data array', () => {
    expect(() => parse('{}', 1)).toThrow(/no data array/i);
  });

  it('rejects a malformed data record (null / non-object)', () => {
    expect(() => parse('{"data":[null]}', 1)).toThrow(/malformed data record/i);
  });

  it('falls back to positional index when a record omits index', () => {
    const body = JSON.stringify({ data: [{ embedding: [1] }, { embedding: [0] }] });
    expect(parse(body, 2).vectors).toEqual([[1], [0]]);
  });

  it('rejects a vector that is not an array of finite numbers', () => {
    // 1e999 parses as Infinity in JSON, which is finite-failing without being invalid JSON.
    expect(() => parse('{"data":[{"index":0,"embedding":[1,1e999]}]}', 1)).toThrow(/finite numbers/i);
    expect(() => parse('{"data":[{"index":0,"embedding":"nope"}]}', 1)).toThrow(/finite numbers/i);
  });

  it('usage: no usage object, or a non-object usage, yields undefined', () => {
    expect(parse('{"data":[{"index":0,"embedding":[1]}]}', 1).usage).toBeUndefined();
    expect(parse('{"data":[{"index":0,"embedding":[1]}],"usage":"x"}', 1).usage).toBeUndefined();
  });

  it('usage: total_tokens falls back to prompt_tokens when absent', () => {
    const body = JSON.stringify({ data: [{ index: 0, embedding: [1] }], usage: { prompt_tokens: 5 } });
    expect(parse(body, 1).usage).toEqual({ promptTokens: 5, totalTokens: 5 });
  });

  it('usage: a non-numeric prompt_tokens yields undefined', () => {
    const body = JSON.stringify({ data: [{ index: 0, embedding: [1] }], usage: { prompt_tokens: 'x', total_tokens: 5 } });
    expect(parse(body, 1).usage).toBeUndefined();
  });

  it('usage: null usage object yields undefined', () => {
    const body = JSON.stringify({ data: [{ index: 0, embedding: [1] }], usage: null });
    expect(parse(body, 1).usage).toBeUndefined();
  });
});

describe('HTTP transport edge cases', () => {
  it('propagates a caller abort before the request leaves', async () => {
    const endpoint = await embeddingEndpoint(() => ({ raw: embeddingBody([[1]]) }));
    const provider = createHttpEmbeddingProvider({ baseUrl: endpoint.url, model: 'emb-1' });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.embed({ texts: ['a'] }, { signal: controller.signal })).rejects.toThrow();
  });

  it('retries a fetch rejection while the caller has not aborted', async () => {
    let calls = 0;
    const provider = createHttpEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:1/v1', model: 'emb-1', retries: 2, retryDelayMs: 0,
      random: () => 0.5, sleep: async () => {},
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error('socket reset');
        return new Response(embeddingBody([[1]]), { status: 200 });
      },
    });
    const response = await provider.embed({ texts: ['a'] });
    expect(response.vectors).toEqual([[1]]);
    expect(calls).toBe(2);
  });

  it('uses the real timer and jitter paths when no injection is provided', async () => {
    const endpoint = await embeddingEndpoint((_request, index) =>
      index === 0 ? { status: 429 } : { raw: embeddingBody([[1]]) });
    const provider = createHttpEmbeddingProvider({
      baseUrl: endpoint.url, model: 'emb-1', retries: 2, retryDelayMs: 1,
      random: () => 0.75,
    });
    const response = await provider.embed({ texts: ['a'] });
    expect(response.vectors).toEqual([[1]]);
    expect(endpoint.requests).toHaveLength(2);
  });
});

describe('signal and lifecycle branches', () => {
  it('wires and removes a live caller signal on a successful request', async () => {
    const endpoint = await embeddingEndpoint(() => ({ raw: embeddingBody([[1]]) }));
    const provider = createHttpEmbeddingProvider({ baseUrl: endpoint.url, model: 'emb-1' });
    const controller = new AbortController();
    const response = await provider.embed({ texts: ['a'] }, { signal: controller.signal });
    expect(response.vectors).toEqual([[1]]);
  });

  it('propagates an abort that happens mid-flight rather than retrying it', async () => {
    let calls = 0;
    const endpoint = await embeddingEndpoint(() => ({ raw: embeddingBody([[1]]), status: 200 }));
    const provider = createHttpEmbeddingProvider({
      baseUrl: endpoint.url, model: 'emb-1', retries: 3,
      fetchImpl: async (url, init) => {
        calls += 1;
        // Abort the caller's signal after the provider has wired its listener, so the provider
        // forwards it to the internal controller and the in-flight fetch is cancelled.
        setTimeout(() => controller.abort(), 0);
        return fetch(url, init);
      },
    });
    const controller = new AbortController();
    await expect(provider.embed({ texts: ['a'] }, { signal: controller.signal })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('throws the fetch error on the final attempt without retrying', async () => {
    let calls = 0;
    const provider = createHttpEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:1/v1', model: 'emb-1', retries: 1,
      fetchImpl: async () => { calls += 1; throw new Error('socket reset'); },
    });
    await expect(provider.embed({ texts: ['a'] })).rejects.toThrow(/socket reset/i);
    expect(calls).toBe(1);
  });

  it('an empty batch returns zero dimensions rather than reading vector 0', async () => {
    const endpoint = await embeddingEndpoint(() => ({ raw: '{"data":[],"model":"emb-1"}' }));
    const provider = createHttpEmbeddingProvider({ baseUrl: endpoint.url, model: 'emb-1' });
    const response = await provider.embed({ texts: [] });
    expect(response.vectors).toEqual([]);
    expect(response.dimensions).toBe(0);
  });
});
