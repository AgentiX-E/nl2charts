import { isNl2ChartsError, toNl2ChartsError } from '@agentix-e/nl2charts-spec';

export type Role = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  readonly role: Role;
  readonly content: string;
}

/**
 * What a call is for.
 *
 * Carried on the request rather than inferred at the call site's caller, because one provider
 * serves four different calls inside the pipeline and the same provider also serves the
 * selector. A meter that reports only per case cannot answer the one question a multi-call arm
 * raises — which of its calls earned its tokens — and the selector, which answers with one digit
 * to a prompt nobody else reads, is the call whose price is easiest to hide.
 */
export type CallPurpose = 'generate' | 'retry' | 'select' | 'compare' | 'plan' | 'interpret' | 'synthesize' | 'columns';

/**
 * The bucket a call lands in when it names no purpose.
 *
 * Reported as its own row and never folded into a named one: filing it under `generate` would
 * dissolve an unattributed cost into the bucket nobody questions, which is the metering version
 * of an instrument pricing a prompt nobody sends.
 */
export const UNLABELLED = 'unlabelled';

/** One bucket of the meter: what this kind of call cost, in the same unit as the case total. */
export interface PurposeUsage {
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly chars: number;
  readonly unbilled: number;
}

export interface LlmRequest {
  readonly messages: readonly LlmMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly json?: boolean;
  /**
   * What this call is for, for the meter to file it under.
   *
   * Optional because a caller that is not being measured (a preflight probe, a replay) has no
   * cost claim to attribute; the harness's own counter treats an omission as a reporting
   * problem rather than as a default, so a new call site that forgets is visible in the artifact
   * instead of being absorbed.
   */
  readonly purpose?: CallPurpose;
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
  readonly choices?: readonly {
    readonly finish_reason?: unknown;
    readonly message?: { readonly content?: unknown; readonly reasoning_content?: unknown };
  }[];
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

      let payload: CompletionBody | undefined;
      let response: Response | undefined;
      let attempts = 0;
      let transport: unknown;
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
            // A fetch implementation that resolves to nothing is an outcome, not a crash:
            // the guard below turns it into "returned nothing".
            if (response === undefined) break;
            if (response.ok) {
              // The body is read inside the attempt, because a connection that dies
              // mid-body is the same transient failure as one that never opened — and it
              // used to escape this loop entirely, killing a 1,532-question run at case
              // 700 with "llm response is not JSON" and no retry. A body that arrives
              // whole and is not JSON is a different thing: the endpoint answered, and the
              // answer is wrong. That one is diagnosed, not retried.
              const text = await response.text();
              try {
                payload = JSON.parse(text) as CompletionBody;
              } catch (error) {
                throw toNl2ChartsError('NL2C_E_LLM_INVALID_RESPONSE', 'llm response is not JSON', error, { attempts });
              }
              break;
            }
            if (!RETRYABLE.has(response.status) || attempt === retries) break;
            // Backoff doubles per attempt; Retry-After wins when the endpoint sends one,
            // because only it knows when its own window reopens.
            await sleep(retryAfterMs(response, retryDelayMs * 2 ** (attempt - 1)));
            if (controller.signal.aborted) break;
          } catch (error) {
            // A body that is not JSON is an answer, not a failure to get one; retrying it
            // would turn a wrong endpoint into a slow one.
            if (isNl2ChartsError(error) && error.code === 'NL2C_E_LLM_INVALID_RESPONSE') throw error;
            // Any other transport failure is retried like a 429: the request never
            // produced an answer, and the next one may. An aborted call is not retried —
            // the caller said stop, and a timeout is the caller's own deadline.
            transport = error;
            if (controller.signal.aborted || attempt === retries) {
              throw toNl2ChartsError(
                'NL2C_E_LLM_UNAVAILABLE',
                controller.signal.aborted ? 'llm call timed out' : 'llm endpoint unreachable',
                error,
                { endpoint, attempts },
              );
            }
            await sleep(retryDelayMs * 2 ** (attempt - 1));
          }
        }
      } finally {
        clearTimeout(timer);
        external?.removeEventListener('abort', onAbort);
      }

      if (response === undefined || !response.ok) {
        throw toNl2ChartsError('NL2C_E_LLM_UNAVAILABLE', `llm returned ${response?.status ?? 'nothing'}`, transport, {
          ...(response === undefined ? {} : { status: response.status }),
          attempts,
        });
      }
      if (payload === undefined) {
        throw toNl2ChartsError('NL2C_E_LLM_INVALID_RESPONSE', 'llm response is not JSON', transport, { attempts });
      }

      const choice = payload.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        // A reasoning model with a small token budget spends all of it thinking and
        // returns an empty answer with finish_reason=length. Saying so turns "no
        // content" into a diagnosis: the budget, not the endpoint.
        const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'unknown';
        const present = Object.keys(choice?.message ?? {});
        throw toNl2ChartsError(
          'NL2C_E_LLM_INVALID_RESPONSE',
          `llm response has no content (finish_reason=${finish}${present.length === 0 ? '' : `, message fields: ${present.join(',')}`})`,
          undefined,
          { finishReason: finish, fields: present },
        );
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

/**
 * A provider that counts the calls it is asked to make.
 *
 * The count is per case, which is the unit an ablation is priced in: an arm that spends
 * four calls to gain two points is a different proposition from one that spends a tenth
 * of a call. Deriving that number from the arm's configuration instead of counting it
 * produced two errors worth naming — the selector call was never counted at all, so
 * "selection" appeared free, and a plan-based candidate was counted as one call when
 * writing the plan costs one and the statement another.
 *
 * A retry inside the provider is one logical call: the harness asked once, and the
 * endpoint's queue is not the arm's design.
 */
/**
 * ...and what it was billed, in the endpoint's own unit.
 *
 * `chars` is the text those tokens were counted from — the same calls, the same messages — which
 * is what makes the characters-per-token ratio a measurement rather than a coincidence.
 *
 * `unbilled` is the field that makes the other two publishable. A provider that answers without a
 * usage block is not free — it is unmeasured, and a cost column that reported it as zero tokens
 * would be a measurement of nothing that reads as zero. Counting those answers apart is what lets
 * a gate refuse the column instead of publishing a number that means "unknown".
 *
 * The return type is written out rather than named: this meter exists for the evaluation
 * harness, and a public type for it would be a contract the product has to keep without ever
 * using it.
 */
export function withCallCounter(provider: LlmProvider): {
  readonly provider: LlmProvider;
  /** Calls the harness asked for, including the ones that never answered. */
  readonly calls: () => number;
  readonly usage: () => { readonly promptTokens: number; readonly completionTokens: number; readonly chars: number; readonly unbilled: number };
  /**
   * The same totals, split by what each call was for.
   *
   * Summing these gives `usage()` exactly, because the total *is* their sum rather than a second
   * running count: two counts written at the same point still drift apart whenever one is updated
   * on a branch the other is not, and a share divided by a total it does not add up to is not a
   * share.
   */
  readonly byPurpose: () => ReadonlyMap<CallPurpose | typeof UNLABELLED, PurposeUsage>;
  /** Calls that named no purpose. Zero on a harness that labels every call it measures. */
  readonly unlabelled: () => number;
} {
  type Meter = { calls: number; promptTokens: number; completionTokens: number; chars: number; unbilled: number };
  const zero = (): Meter => ({ calls: 0, promptTokens: 0, completionTokens: 0, chars: 0, unbilled: 0 });
  // One ledger, two views: the totals are accumulated beside the buckets at the same point rather
  // than recounted later, and a test holds them to the property that makes the share meaningful —
  // the buckets add up to the total. Recounting would be a second implementation of the same sum.
  const totals = zero();
  const purposes = new Map<CallPurpose | typeof UNLABELLED, Meter>();
  return {
    provider: {
      id: provider.id,
      model: provider.model,
      complete: async (request, options) => {
        const key = request.purpose ?? UNLABELLED;
        const meter = purposes.get(key) ?? zero();
        purposes.set(key, meter);
        meter.calls += 1;
        totals.calls += 1;
        // The characters of the request as it was sent. A token count can only be calibrated
        // against the text of the *same* request: pairing it with a character count taken from a
        // different prompt (say, the system message alone) produces a ratio that has no tokenizer
        // behind it and still looks like one.
        for (const message of request.messages) {
          meter.chars += message.content.length;
          totals.chars += message.content.length;
        }
        const response = await provider.complete(request, options);
        // Read per answer rather than per arm: an endpoint that reports usage on some answers and
        // not others is a state that exists, and summing only what arrived would hide it.
        if (response.usage === undefined) {
          meter.unbilled += 1;
          totals.unbilled += 1;
          return response;
        }
        meter.promptTokens += response.usage.promptTokens;
        meter.completionTokens += response.usage.completionTokens;
        totals.promptTokens += response.usage.promptTokens;
        totals.completionTokens += response.usage.completionTokens;
        return response;
      },
    },
    calls: () => totals.calls,
    usage: () => ({ promptTokens: totals.promptTokens, completionTokens: totals.completionTokens, chars: totals.chars, unbilled: totals.unbilled }),
    byPurpose: () => new Map(purposes),
    unlabelled: () => purposes.get(UNLABELLED)?.calls ?? 0,
  };
}
