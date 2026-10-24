import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';

export type Role = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  readonly role: Role;
  readonly content: string;
}

export interface LlmRequest {
  readonly messages: readonly LlmMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly json?: boolean;
}

export interface LlmUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface LlmResponse {
  readonly text: string;
  readonly model: string;
  readonly usage?: LlmUsage;
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  complete(request: LlmRequest, options?: { signal?: AbortSignal }): Promise<LlmResponse>;
}

export interface HttpProviderOptions {
  /** Must point at a server the deployer controls, never at a vendor from the browser. */
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * Attempts for a status that is worth retrying (429 and 5xx). One means no retry.
   *
   * A rate-limited call is not a wrong answer, but the caller that sees it becomes one:
   * a batch job that treats a 429 as a failed case reports an accuracy, and the accuracy
   * is a function of how busy the endpoint was. Retrying inside the provider keeps that
   * decision in one place instead of in every caller's loop.
   */
  readonly retries?: number;
  /** Base delay for exponential backoff, in milliseconds. Zero waits not at all. */
  readonly retryDelayMs?: number;
  /** Injection point for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Statuses that mean "try again", as opposed to "the request is wrong". */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function retryAfterMs(response: Response, fallback: number): number {
  const header = response.headers?.get?.('retry-after');
  if (header === null || header === undefined) return fallback;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : fallback;
}

interface CompletionBody {
  readonly model?: unknown;
  readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[];
  readonly usage?: { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown };
}

export function createHttpProvider(options: HttpProviderOptions): LlmProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retries = Math.max(1, options.retries ?? 1);
  const retryDelayMs = options.retryDelayMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const endpoint = `${options.baseUrl.replace(/\/$/, '')}/chat/completions`;

  return {
    id: 'http',
    model: options.model,
    async complete(request, callOptions) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      const external = callOptions?.signal;
      const onAbort = (): void => controller.abort(external?.reason);
      if (external) {
        if (external.aborted) controller.abort(external.reason);
        else external.addEventListener('abort', onAbort, { once: true });
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`;
      const body: Record<string, unknown> = {
        model: options.model,
        messages: request.messages,
        temperature: request.temperature ?? 0,
      };
      if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
      if (request.json === true) body.response_format = { type: 'json_object' };

      let response: Response | undefined;
      let attempts = 0;
      try {
        for (let attempt = 1; attempt <= retries; attempt += 1) {
          attempts = attempt;
          try {
            response = await doFetch(endpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              signal: controller.signal,
            });
          } catch (error) {
            throw toNl2ChartsError(
              'NL2C_E_LLM_UNAVAILABLE',
              controller.signal.aborted ? 'llm call timed out' : 'llm endpoint unreachable',
              error,
              { endpoint },
            );
          }
          if (response.ok || !RETRYABLE.has(response.status) || attempt === retries) break;
          // Backoff doubles per attempt; Retry-After wins when the endpoint sends one,
          // because only it knows when its own window reopens.
          await sleep(retryAfterMs(response, retryDelayMs * 2 ** (attempt - 1)));
          if (controller.signal.aborted) break;
        }
      } finally {
        clearTimeout(timer);
        external?.removeEventListener('abort', onAbort);
      }

      if (response === undefined || !response.ok) {
        throw toNl2ChartsError('NL2C_E_LLM_UNAVAILABLE', `llm returned ${response?.status ?? 'nothing'}`, undefined, {
          ...(response === undefined ? {} : { status: response.status }),
          attempts,
        });
      }

      let payload: CompletionBody;
      try {
        payload = (await response.json()) as CompletionBody;
      } catch (error) {
        throw toNl2ChartsError('NL2C_E_LLM_INVALID_RESPONSE', 'llm response is not JSON', error);
      }
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        throw toNl2ChartsError('NL2C_E_LLM_INVALID_RESPONSE', 'llm response has no content');
      }
      const promptTokens = Number(payload.usage?.prompt_tokens ?? 0);
      const completionTokens = Number(payload.usage?.completion_tokens ?? 0);
      const model = typeof payload.model === 'string' ? payload.model : options.model;
      return {
        text: content,
        model,
        usage: { promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0, completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0 },
      };
    },
  };
}
