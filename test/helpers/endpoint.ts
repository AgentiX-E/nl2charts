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
  /**
   * How many requests this server is answering right now, this one included.
   *
   * A provider's rate limit is a function of concurrent requests, not of requests: an endpoint
   * that answers twelve pings one at a time and refuses the eighth simultaneous one is healthy
   * to a serial prober and closed to a run. This is the number that lets a test say so.
   */
  readonly inFlight: number;
}

export interface EndpointReply {
  readonly status?: number;
  readonly content?: string;
  /** Milliseconds to wait before answering, for deadline tests. */
  readonly delayMs?: number;
  /**
   * Reasoning tokens to bill inside `completion_tokens`, the way a thinking endpoint reports them.
   *
   * Absent by default, so every existing test still answers like a chat endpoint that says nothing
   * about deliberation — which is the state of every run before the column existed.
   */
  readonly reasoningTokens?: number;
  /**
   * Why the endpoint says it stopped, when a test needs it to have been cut off.
   *
   * `stop` by default, which is what a healthy endpoint says. `length` is the one that matters:
   * a reply cut at the answer cap is a reply the pipeline must report as truncated rather than
   * present as the model's whole answer, and a fixture that could only ever say `stop` made that
   * path untestable without a live endpoint that happens to overrun its budget.
   */
  readonly finishReason?: 'stop' | 'length' | 'content_filter';
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
  // Counted here rather than in each test, because the tests that need it are the ones about a
  // provider under load and a hand-rolled counter in each of them would drift from the server.
  let inFlight = 0;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      inFlight += 1;
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
        inFlight,
      };
      requests.push(seen);
      const decided = options.reply(seen, requests.length - 1);
      const answer: EndpointReply = typeof decided === 'string' ? { content: decided } : decided;
      const send = (): void => {
        inFlight -= 1;
        const status = answer.status ?? 200;
        const payload =
          answer.raw ??
          JSON.stringify({
            model: body.model ?? 'test-model',
            choices: [{ finish_reason: answer.finishReason ?? 'stop', message: { role: 'assistant', content: answer.content ?? '' } }],
            usage: {
              prompt_tokens: 7,
              completion_tokens: 3,
              ...(answer.reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: answer.reasoningTokens } }),
            },
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
