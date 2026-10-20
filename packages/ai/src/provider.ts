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
}

interface CompletionBody {
  readonly model?: unknown;
  readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[];
  readonly usage?: { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown };
}

export function createHttpProvider(options: HttpProviderOptions): LlmProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
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

      let response: Response;
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
      } finally {
        clearTimeout(timer);
        external?.removeEventListener('abort', onAbort);
      }

      if (!response.ok) {
        throw toNl2ChartsError('NL2C_E_LLM_UNAVAILABLE', `llm returned ${response.status}`, undefined, {
          status: response.status,
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
