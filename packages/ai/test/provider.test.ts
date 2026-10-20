import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';
import { createHttpProvider } from '../src/provider.js';

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
