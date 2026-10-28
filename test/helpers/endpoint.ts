/**
 * A real HTTP endpoint that speaks the OpenAI chat-completions shape.
 *
 * The harness talks to endpoints over HTTP; the only way to test that path without
 * stubbing our own code is to put an endpoint on the other end. This one is an
 * `http.Server` on a loopback port, so `fetch`, timeouts, status codes and retry policy
 * all behave exactly as they do against a provider — the answers are decided by the test.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request as the endpoint saw it. */
export interface EndpointRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: {
    readonly model?: string;
    readonly messages?: readonly { readonly role?: string; readonly content?: string }[];
    readonly temperature?: number;
    readonly max_tokens?: number;
    readonly response_format?: { readonly type?: string };
  };
  /** The prompt text, joined, for tests that key their answer on it. */
  readonly prompt: string;
}

export interface EndpointReply {
  readonly status?: number;
  readonly content?: string;
  /** Milliseconds to wait before answering, for deadline tests. */
  readonly delayMs?: number;
  /** Overrides the whole body, for malformed-response tests. */
  readonly raw?: string;
}

export interface EndpointOptions {
  /** Decides the answer for the n-th request (0-based). */
  readonly reply: (request: EndpointRequest, index: number) => EndpointReply | string;
}

export interface Endpoint {
  readonly url: string;
  readonly requests: readonly EndpointRequest[];
  close(): Promise<void>;
}

export async function startEndpoint(options: EndpointOptions): Promise<Endpoint> {
  const requests: EndpointRequest[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: EndpointRequest['body'] = {};
      try {
        body = JSON.parse(text) as EndpointRequest['body'];
      } catch {
        body = {};
      }
      const prompt = (body.messages ?? []).map((message) => message.content ?? '').join('\n');
      const seen: EndpointRequest = {
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body,
        prompt,
      };
      requests.push(seen);
      const decided = options.reply(seen, requests.length - 1);
      const answer: EndpointReply = typeof decided === 'string' ? { content: decided } : decided;
      const send = (): void => {
        const status = answer.status ?? 200;
        const payload =
          answer.raw ??
          JSON.stringify({
            model: body.model ?? 'test-model',
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer.content ?? '' } }],
            usage: { prompt_tokens: 7, completion_tokens: 3 },
          });
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(payload);
      };
      if (answer.delayMs === undefined) send();
      else setTimeout(send, answer.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
