import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';
import { createHttpProvider, withCallCounter } from '../src/provider.js';

let server: Server;
let baseUrl: string;
let lastBody: Record<string, unknown> = {};
let lastAuth: string | undefined;

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const instance = createServer(handler);
    instance.listen(0, '127.0.0.1', () => {
      const address = instance.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server: instance, url: `http://127.0.0.1:${port}/v1` });
    });
  });
}

beforeAll(async () => {
  const started = await listen((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      lastBody = JSON.parse(body) as Record<string, unknown>;
      lastAuth = request.headers.authorization;
      const url = request.url ?? '';
      if (url.includes('/slow')) {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ model: 'slow', choices: [{ message: { content: 'late' } }] }));
        }, 300);
        return;
      }
      if (url.includes('/error')) {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end('{"error":"quota"}');
        return;
      }
      if (url.includes('/garbage')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('not-json');
        return;
      }
      if (url.includes('/weird')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 'abc', completion_tokens: 'def' } }));
        return;
      }
      if (url.includes('/empty')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ model: 'm', choices: [{ message: {} }] }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          model: 'test-model',
          choices: [{ message: { content: 'SELECT 1' } }],
          usage: { prompt_tokens: 11, completion_tokens: 3 },
        }),
      );
    });
  });
  server = started.server;
  baseUrl = started.url;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('http provider', () => {
  it('calls an OpenAI-compatible endpoint and returns usage', async () => {
    const provider = createHttpProvider({ baseUrl, apiKey: 'secret', model: 'test-model' });
    const response = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response).toEqual({
      text: 'SELECT 1',
      model: 'test-model',
      usage: { promptTokens: 11, completionTokens: 3 },
    });
    expect(lastAuth).toBe('Bearer secret');
    expect(lastBody).toMatchObject({ model: 'test-model', temperature: 0 });
    expect(lastBody).not.toHaveProperty('max_tokens');
    expect(lastBody).not.toHaveProperty('response_format');
  });

  it('forwards max tokens, json mode and a custom temperature', async () => {
    const provider = createHttpProvider({ baseUrl, model: 'test-model' });
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 64, json: true, temperature: 0.2 });
    expect(lastBody).toMatchObject({ max_tokens: 64, response_format: { type: 'json_object' }, temperature: 0.2 });
    expect(lastBody).not.toHaveProperty('authorization');
  });

  it('maps an http error to LLM_UNAVAILABLE with the status', async () => {
    const provider = createHttpProvider({ baseUrl: `${baseUrl}/error`, model: 'm' });
    await expect(provider.complete({ messages: [] })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_LLM_UNAVAILABLE' && error.details.status === 429,
    );
  });

  it('rejects a non-json body', async () => {
    const provider = createHttpProvider({ baseUrl: `${baseUrl}/garbage`, model: 'm' });
    await expect(provider.complete({ messages: [] })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_LLM_INVALID_RESPONSE',
    );
  });

  it('rejects a response without content', async () => {
    const provider = createHttpProvider({ baseUrl: `${baseUrl}/empty`, model: 'm' });
    await expect(provider.complete({ messages: [] })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_LLM_INVALID_RESPONSE',
    );
  });

  it('times out a slow endpoint', async () => {
    const provider = createHttpProvider({ baseUrl: `${baseUrl}/slow`, model: 'm', timeoutMs: 20 });
    await expect(provider.complete({ messages: [] })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_LLM_UNAVAILABLE',
    );
  });

  it('honours an already-aborted caller signal', async () => {
    const provider = createHttpProvider({ baseUrl, model: 'm' });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.complete({ messages: [] }, { signal: controller.signal })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_LLM_UNAVAILABLE',
    );
  });

  it('falls back to the configured model and zero tokens when usage is unusable', async () => {
    const provider = createHttpProvider({ baseUrl: `${baseUrl}/weird`, model: 'fallback-model' });
    const response = await provider.complete({ messages: [] });
    expect(response.model).toBe('fallback-model');
    expect(response.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('aborts an in-flight call when the caller aborts', async () => {
    const provider = createHttpProvider({ baseUrl: `${baseUrl}/slow`, model: 'm', timeoutMs: 5_000 });
    const controller = new AbortController();
    const pending = provider.complete({ messages: [] }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_LLM_UNAVAILABLE',
    );
  });

  it('maps a connection failure to LLM_UNAVAILABLE', async () => {
    const provider = createHttpProvider({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm', timeoutMs: 500 });
    await expect(provider.complete({ messages: [] })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_LLM_UNAVAILABLE',
    );
  });
});

describe('retrying a rate-limited call', () => {
  const body = (): Response =>
    new Response(JSON.stringify({ model: 'm', choices: [{ message: { content: 'SELECT 1' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const scripted = (statuses: number[], headers: Record<string, string> = {}): { fetchImpl: typeof fetch; calls: number[] } => {
    const calls: number[] = [];
    const fetchImpl = (async () => {
      const status = statuses[calls.length] ?? 200;
      calls.push(status);
      if (status === 200) return body();
      return new Response('{}', { status, headers });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  };

  const delays: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    delays.push(ms);
  };

  it('turns a 429 into an answer when the retry succeeds', async () => {
    // A rate-limited call is not a wrong answer; without this, accuracy becomes a
    // function of how busy the endpoint was.
    const { fetchImpl, calls } = scripted([429, 429, 200]);
    const provider = createHttpProvider({ baseUrl: 'https://example.test/v1', model: 'm', fetchImpl, retries: 3, sleep });
    const reply = await provider.complete({ messages: [{ role: 'user', content: 'q' }] });
    expect(reply.text).toBe('SELECT 1');
    expect(calls).toHaveLength(3);
  });

  it('backs off exponentially between attempts', async () => {
    delays.length = 0;
    const { fetchImpl } = scripted([429, 503, 200]);
    const provider = createHttpProvider({ baseUrl: 'https://example.test/v1', model: 'm', fetchImpl, retries: 3, retryDelayMs: 100, sleep });
    await provider.complete({ messages: [{ role: 'user', content: 'q' }] });
    expect(delays).toEqual([100, 200]);
  });

  it('honours Retry-After over its own backoff', async () => {
    delays.length = 0;
    const { fetchImpl } = scripted([429, 200], { 'retry-after': '2' });
    const provider = createHttpProvider({ baseUrl: 'https://example.test/v1', model: 'm', fetchImpl, retries: 2, retryDelayMs: 10, sleep });
    await provider.complete({ messages: [{ role: 'user', content: 'q' }] });
    expect(delays).toEqual([2000]);
  });

  it('does not retry a request that is simply wrong', async () => {
    const { fetchImpl, calls } = scripted([400]);
    const provider = createHttpProvider({ baseUrl: 'https://example.test/v1', model: 'm', fetchImpl, retries: 3, sleep });
    await expect(provider.complete({ messages: [{ role: 'user', content: 'q' }] })).rejects.toThrow(/400/);
    expect(calls).toHaveLength(1);
  });

  it('gives up after the configured attempts and says how many it made', async () => {
    const { fetchImpl, calls } = scripted([429, 429, 429, 429]);
    const provider = createHttpProvider({ baseUrl: 'https://example.test/v1', model: 'm', fetchImpl, retries: 2, sleep });
    await expect(provider.complete({ messages: [{ role: 'user', content: 'q' }] })).rejects.toThrow(/429/);
    expect(calls).toHaveLength(2);
  });
});

describe('an empty answer that is not an outage', () => {
  it('names the finish reason and the fields it saw', async () => {
    // Zhipu's reasoning models return content: null with reasoning_content filled and
    // finish_reason=length when the token budget is spent thinking. "no content" alone
    // sends the reader to the endpoint's status page instead of its token budget.
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'thinking…' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    const provider = createHttpProvider({ baseUrl: 'https://example.test/v1', model: 'm', fetchImpl });
    await expect(provider.complete({ messages: [{ role: 'user', content: 'q' }] })).rejects.toThrow(
      /finish_reason=length, message fields: content,reasoning_content/,
    );
  });
});

describe('the edges of a retried call', () => {
  const ok = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('falls back to its own backoff when Retry-After is not a number', async () => {
    const delays: number[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': 'soon' } }) : ok({ choices: [{ message: { content: 'SELECT 1' } }] });
    }) as unknown as typeof fetch;
    const provider = createHttpProvider({
      baseUrl: 'https://example.test/v1',
      model: 'm',
      fetchImpl,
      retries: 2,
      retryDelayMs: 25,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await provider.complete({ messages: [{ role: 'user', content: 'q' }] });
    expect(delays).toEqual([25]);
  });

  it('stops retrying when the caller aborts during the wait', async () => {
    const external = new AbortController();
    const fetchImpl = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch;
    const provider = createHttpProvider({
      baseUrl: 'https://example.test/v1',
      model: 'm',
      fetchImpl,
      retries: 4,
      sleep: async () => {
        external.abort();
      },
    });
    // One attempt was made and then the caller gave up; reporting 429 after four calls
    // would claim work the provider never did.
    await expect(provider.complete({ messages: [{ role: 'user', content: 'q' }] }, { signal: external.signal })).rejects.toThrow(/429/);
  });

  it('says nothing came back rather than inventing a status', async () => {
    const fetchImpl = (async () => undefined) as unknown as typeof fetch;
    const provider = createHttpProvider({ baseUrl: 'https://example.test/v1', model: 'm', fetchImpl });
    await expect(provider.complete({ messages: [{ role: 'user', content: 'q' }] })).rejects.toThrow(/returned nothing/);
  });

  it('reports a body that is not JSON as an invalid response', async () => {
    const fetchImpl = (async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const provider = createHttpProvider({ baseUrl: 'https://example.test/v1', model: 'm', fetchImpl });
    await expect(provider.complete({ messages: [{ role: 'user', content: 'q' }] })).rejects.toThrow(/not JSON/);
  });

  it('says the finish reason is unknown when the body omits it', async () => {
    const fetchImpl = (async () => ok({ choices: [{ message: { content: '' } }] })) as unknown as typeof fetch;
    const provider = createHttpProvider({ baseUrl: 'https://example.test/v1', model: 'm', fetchImpl });
    await expect(provider.complete({ messages: [{ role: 'user', content: 'q' }] })).rejects.toThrow(/finish_reason=unknown/);
  });

  it('counts a usage field it cannot parse as zero rather than as NaN', async () => {
    const fetchImpl = (async () =>
      ok({ choices: [{ message: { content: 'SELECT 1' } }], usage: { prompt_tokens: 'many', completion_tokens: null } })) as unknown as typeof fetch;
    const provider = createHttpProvider({ baseUrl: 'https://example.test/v1', model: 'm', fetchImpl });
    const reply = await provider.complete({ messages: [{ role: 'user', content: 'q' }] });
    expect(reply.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
});

/**
 * The counter is the harness's measuring instrument, so it is tested as one: it must
 * count what was asked and nothing else, forward the identity the pipeline reports, and
 * count a call that failed — a throttled call still cost the endpoint a request.
 */
describe('withCallCounter', () => {
  const stub = (reply: string) => {
    const seen: string[] = [];
    return {
      seen,
      provider: {
        id: 'stub',
        model: 'stub-model',
        complete: async (request: { messages: readonly { content: string }[] }) => {
          seen.push(request.messages[0]?.content ?? '');
          return { text: reply, model: 'stub-model' };
        },
      },
    };
  };

  it('counts calls and forwards the answer unchanged', async () => {
    const inner = stub('SELECT 1');
    const counted = withCallCounter(inner.provider);
    expect(counted.calls()).toBe(0);
    const reply = await counted.provider.complete({ messages: [{ role: 'user', content: 'q1' }] });
    expect(reply.text).toBe('SELECT 1');
    expect(counted.calls()).toBe(1);
    await counted.provider.complete({ messages: [{ role: 'user', content: 'q2' }] });
    expect(counted.calls()).toBe(2);
    expect(inner.seen).toEqual(['q1', 'q2']);
  });

  it('keeps the identity the report prints', () => {
    const counted = withCallCounter(stub('x').provider);
    expect(counted.provider.id).toBe('stub');
    expect(counted.provider.model).toBe('stub-model');
  });

  it('counts a call that threw, because the endpoint still received it', async () => {
    const counted = withCallCounter({
      id: 'failing',
      model: 'm',
      complete: async () => {
        throw new Error('429');
      },
    });
    await expect(counted.provider.complete({ messages: [{ role: 'user', content: 'q' }] })).rejects.toThrow('429');
    expect(counted.calls()).toBe(1);
  });

  it('sums what each answer says it billed, and counts the ones that say nothing', async () => {
    // A provider is not a ledger: DeepSeek reports `usage` on every answer, a stub may report
    // none, and the two states have to be told apart, because "no usage block" is an unknown cost
    // and publishing it as zero would make the arm look free.
    let answer = 0;
    const priced = withCallCounter({
      id: 'priced',
      model: 'm',
      complete: async () => {
        answer += 1;
        return answer === 3
          ? { text: 'x', model: 'm' }
          : { text: 'x', model: 'm', usage: { promptTokens: 100, completionTokens: 10 } };
      },
    });
    expect(priced.usage()).toEqual({ promptTokens: 0, completionTokens: 0, chars: 0, unbilled: 0 });
    for (let index = 0; index < 3; index += 1) await priced.provider.complete({ messages: [{ role: 'user', content: 'q' }] });
    expect(priced.calls()).toBe(3);
    // `chars` is the text of the same three requests: one character per call in this stub, which
    // is how the ratio stays a fact about one request rather than two.
    expect(priced.usage()).toEqual({ promptTokens: 200, completionTokens: 20, chars: 3, unbilled: 1 });
  });

  it('counts two counters separately, so a concurrent case cannot borrow another case\'s calls', async () => {
    const inner = stub('ok');
    const first = withCallCounter(inner.provider);
    const second = withCallCounter(inner.provider);
    await first.provider.complete({ messages: [{ role: 'user', content: 'a' }] });
    await first.provider.complete({ messages: [{ role: 'user', content: 'b' }] });
    await second.provider.complete({ messages: [{ role: 'user', content: 'c' }] });
    expect(first.calls()).toBe(2);
    expect(second.calls()).toBe(1);
  });
});

/**
 * A connection that dies is not an answer.
 *
 * Two failures used to escape the retry loop entirely: a `fetch` that rejects (the run
 * ended with "endpoint unreachable" on the first reset), and a body that dies mid-read
 * (the run ended with "response is not JSON" at case 700 of 1,532). Both are the same
 * transient class as a 429 and both are retried now; a body that arrives whole and is not
 * JSON still is not, because that is an answer from the wrong endpoint.
 */
describe('transport failures', () => {
  const ok = (content: string) =>
    new Response(JSON.stringify({ model: 'm', choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('retries a fetch that rejects, and returns the answer from the next attempt', async () => {
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('fetch failed: ECONNRESET');
      return ok('SELECT 1');
    }) as unknown as typeof fetch;
    const provider = createHttpProvider({ baseUrl: 'https://example.test/v1', model: 'm', fetchImpl, retries: 3, retryDelayMs: 1, sleep: async () => {} });
    const reply = await provider.complete({ messages: [{ role: 'user', content: 'q' }] });
    expect(reply.text).toBe('SELECT 1');
    expect(attempt).toBe(2);
  });

  it('gives up after the retry budget and says how many attempts it made', async () => {
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      throw new TypeError('fetch failed: ECONNRESET');
    }) as unknown as typeof fetch;
    const provider = createHttpProvider({ baseUrl: 'https://example.test/v1', model: 'm', fetchImpl, retries: 3, retryDelayMs: 1, sleep: async () => {} });
    await expect(provider.complete({ messages: [{ role: 'user', content: 'q' }] })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_LLM_UNAVAILABLE' && error.details.attempts === 3,
    );
    expect(attempt).toBe(3);
  });

  it('retries a body that dies mid-read, which is the failure that killed a 1,532-question run', async () => {
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => {
            throw new TypeError('terminated');
          },
        } as unknown as Response;
      }
      return ok('SELECT 2');
    }) as unknown as typeof fetch;
    const provider = createHttpProvider({ baseUrl: 'https://example.test/v1', model: 'm', fetchImpl, retries: 3, retryDelayMs: 1, sleep: async () => {} });
    const reply = await provider.complete({ messages: [{ role: 'user', content: 'q' }] });
    expect(reply.text).toBe('SELECT 2');
    expect(attempt).toBe(2);
  });

  it('does not retry a body that arrived whole and is not JSON', async () => {
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      return new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    const provider = createHttpProvider({ baseUrl: 'https://example.test/v1', model: 'm', fetchImpl, retries: 3, retryDelayMs: 1, sleep: async () => {} });
    await expect(provider.complete({ messages: [{ role: 'user', content: 'q' }] })).rejects.toThrow(/not JSON/);
    expect(attempt).toBe(1);
  });
});
