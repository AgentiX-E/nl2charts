import { isNl2ChartsError, toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import { adaptRequest, capabilitiesOf } from './capability.js';
import type { ModelCapabilities } from './capability.js';

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
export type CallPurpose =
  | 'generate'
  | 'retry'
  | 'select'
  | 'compare'
  | 'plan'
  | 'interpret'
  | 'synthesize'
  | 'columns'
  | 'audit'
  | 'reconcile'
  /**
   * A fixed question asked to identify the generator, not to answer anything.
   *
   * Its own bucket because it is the one call in the harness that is spent on the instrument
   * rather than on a case: folding it into `generate` would price it as part of an arm, and
   * leaving it unlabelled would make the meter's own "every call names a purpose" check fail
   * on a call that knows exactly what it is for.
   */
  | 'probe';

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
  /**
   * Prompt tokens the endpoint billed at its cache rate, when it said so.
   *
   * Not a saving this repository performs: it is a discount the *endpoint* applies, and the two
   * numbers here exist because a cost column that cannot see it publishes list price as if it
   * were the bill. Zero on an endpoint that does not report the field, which is why
   * `cachedReported` travels beside it — "nothing was cached" and "nobody said" are different
   * facts and only one of them is a measurement.
   */
  readonly cachedTokens: number;
  /** Answers that carried a cache field at all. The count is what makes the two above readable. */
  readonly cachedReported: number;
  /**
   * Completion tokens an endpoint spent deliberating, when it said so.
   *
   * Already inside `completionTokens` — this is a decomposition of that bill, not a second one.
   * It exists because a reasoning alias and a chat alias can write the same 58 tokens of SQL and
   * differ tenfold in cost, and `completionTokens` alone reports the two as one number.
   */
  readonly reasoningTokens: number;
  /** Answers that carried a reasoning count at all, for the same reason `cachedReported` exists. */
  readonly reasoningReported: number;
}

export interface LlmRequest {
  readonly messages: readonly LlmMessage[];
  /**
   * Sampling temperature, or `null` to send no temperature at all.
   *
   * The two absences are different answers to different questions. `undefined` means "use
   * this repository's default", which is zero — the value every reading in `docs/benchmarks.md`
   * was taken at, and changing it silently would make those readings incomparable with a run
   * made today. `null` means "do not name a value", for an endpoint that refuses the field
   * instead of ignoring it: a reasoning model that only accepts its own default answers a
   * `temperature: 0` with a 400, and the 400 used to arrive as "the endpoint is unreachable".
   *
   * A caller that does not know which of the two it needs should pass `undefined`; `null` is
   * a deployment decision, and `turnTemperature` documents the mapping.
   */
  readonly temperature?: number | null;
  readonly maxTokens?: number;
  readonly json?: boolean;
  /**
   * Ask for a thinking or a non-thinking decode, where the endpoint serves the choice.
   *
   * `undefined` is "this deployment has no opinion" and sends nothing — which is what every
   * published reading did, because the mode was selected by choosing a model name. That is the
   * arrangement this field replaces: an alias can be re-pointed at new weights, and a request
   * that names a mode cannot.
   */
  readonly thinking?: boolean;
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

/**
 * The temperature a turn is sent at, from whatever the deployment configured.
 *
 * A single function because the pipeline makes five kinds of call — the statement, the repair
 * turn, the audit turn, the empty-result turn and the selector — and they all go to the same
 * endpoint. A policy that reached only the statement call would still fail on the first model
 * that rejects the field, and it would fail in the repair turn, which is the turn a weak model
 * depends on most.
 *
 * `undefined` is this repository's default (zero, the value every published reading was taken
 * at); `null` is a deployment saying the endpoint must not be told.
 */
export function turnTemperature(configured: number | null | undefined): number | null {
  return configured === undefined ? 0 : configured;
}

export interface LlmUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  /**
   * Prompt tokens the endpoint served from its prefix cache, when it reported them.
   *
   * Three spellings exist for this one fact and all three are read, because a provider that
   * caches the prompt bills it at a lower rate and a meter that only counts `prompt_tokens`
   * reports the list price as the bill. `undefined` is not zero: an endpoint that says nothing
   * about caching has not said it cached nothing.
   */
  readonly cachedPromptTokens?: number;
  /**
   * Completion tokens the endpoint spent deliberating, when it reported them.
   *
   * Billed inside `completionTokens`, which is why this column exists: a reasoning alias and a
   * chat alias that both write 58 tokens of SQL are not the same bill, and a meter reading only
   * `completion_tokens` reports them as one. It is also the only direct evidence an artifact can
   * hold that a request reached a model that thinks — the response's `model` field names the
   * serving deployment, so it cannot say which alias answered.
   */
  readonly reasoningTokens?: number;
}

/**
 * Why the endpoint stopped writing.
 *
 * Four values rather than the vendor's open string set, because the pipeline has exactly three
 * uses for it: `length` means the reply was cut off and cannot be the whole answer, `stop` means
 * the model chose to end, `content_filter` means the vendor ended it, and everything else is a
 * reason this code cannot act on. Keeping the vendor's own vocabulary would give a caller a
 * string it has to pattern-match, which is how a taxonomy becomes a guess.
 *
 * `undefined` is not `stop`: an endpoint that says nothing about why it stopped has not said it
 * finished. That difference is what lets a report count truncations instead of assuming them.
 */
export type FinishReason = 'stop' | 'length' | 'content_filter' | 'other';

/**
 * The vendor's stop reason, mapped onto the four this package acts on.
 *
 * `tool_calls` and the vendors' other extensions land in `other` rather than being dropped: a
 * reply that ended for an unmodelled reason is still a reply that ended, and a column that reads
 * `undefined` for it would fold it into "the endpoint said nothing".
 */
export function finishReasonOf(raw: unknown): FinishReason | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (raw === 'stop' || raw === 'length' || raw === 'content_filter') return raw;
  return 'other';
}

export interface LlmResponse {
  readonly text: string;
  readonly model: string;
  readonly usage?: LlmUsage;
  /**
   * Why the endpoint stopped, when it said.
   *
   * Carried on the response rather than folded into the text because the text cannot show it: a
   * statement cut at the token cap and a statement the model chose to end are the same bytes up
   * to the cut, and the difference is the whole question. Optional so a hand-written provider
   * still compiles — absent means "this provider does not report it", which is a third fact.
   */
  readonly finishReason?: FinishReason;
  /**
   * Parameters the request carried that this endpoint does not honour.
   *
   * Present only when something was dropped, because an empty list and an absent list would be
   * two spellings of "nothing", and the field exists to make a non-empty answer visible. A
   * caller that never reads it is not misled; a report that never prints it is.
   */
  readonly ignored?: readonly string[];
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  /**
   * What this endpoint does with a request, when the provider knows.
   *
   * Optional so that a hand-written provider in a test or a deployment keeps compiling: an
   * absent declaration means "unknown", and the pipeline then sends the request as it always
   * has. A provider built by `createHttpProvider` always declares it.
   */
  readonly capabilities?: ModelCapabilities;
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
  /**
   * How many times a reply cut at the answer budget is asked again with a larger budget.
   *
   * A truncation is not an answer and not an outage: the endpoint answered, and the number this
   * library named was too small for what it had to say. Asking again with more room is the repair,
   * and it is bounded by `capabilities.answerBudgetCeiling` — a deployment that has not declared a
   * ceiling is never asked for a budget it might refuse. Zero disables escalation, which is what a
   * priced ablation of the mechanism needs.
   */
  readonly budgetEscalations?: number;
  /** Injection point for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * What the endpoint does with a request. Defaults to what the model name implies.
   *
   * Declared here rather than derived at the call site because the provider is the only layer
   * that knows which endpoint it is talking to, and because a deployment with a private model
   * name has no other way to say "this one thinks before it answers".
   */
  readonly capabilities?: Partial<ModelCapabilities>;
}

/** Statuses that mean "try again", as opposed to "the request is wrong". */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function retryAfterMs(response: Response, fallback: number): number {
  const header = response.headers?.get?.('retry-after');
  if (header === null || header === undefined) return fallback;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : fallback;
}

/**
 * What a refused request said about itself, in as few characters as carry the reason.
 *
 * Vendors disagree on the shape — `{error: {message}}`, `{error: "..."}`, `{message: "..."}`,
 * or an HTML page from a proxy that never reached the model — and the one thing they agree on
 * is that the reason is in the body. Reading it is what turns a 400 into an instruction: the
 * field the endpoint refused, or the model name it does not serve.
 *
 * Never throws and never costs a retry. The body is read only on the refusal path, where the
 * response is about to be discarded, so a consumed or truncated body is a missing sentence
 * rather than a second failure stacked on the first.
 */
async function refusalDetail(response: Response): Promise<string | undefined> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  const body = text.trim();
  if (body === '') return undefined;
  let reason = body;
  try {
    const parsed = JSON.parse(body) as { readonly error?: unknown; readonly message?: unknown };
    const error: unknown = parsed.error;
    if (typeof error === 'string') reason = error;
    else if (error !== null && typeof error === 'object' && 'message' in error) {
      const nested = (error as { readonly message?: unknown }).message;
      if (typeof nested === 'string') reason = nested;
    } else if (typeof parsed.message === 'string') reason = parsed.message;
  } catch {
    // Not JSON: a proxy's HTML, or a vendor's plain sentence. Both are still the reason.
  }
  const collapsed = reason.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return undefined;
  return collapsed.length > 200 ? `${collapsed.slice(0, 199)}…` : collapsed;
}

interface CompletionBody {
  readonly model?: unknown;
  readonly choices?: readonly {
    readonly finish_reason?: unknown;
    readonly message?: { readonly content?: unknown; readonly reasoning_content?: unknown };
  }[];
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    /** DeepSeek's spelling, at the top level of `usage`. */
    readonly prompt_cache_hit_tokens?: unknown;
    /** Some OpenAI-compatible gateways spell it here instead. */
    readonly cached_tokens?: unknown;
    /** OpenAI's spelling, nested beside the audio and reasoning counters. */
    readonly prompt_tokens_details?: { readonly cached_tokens?: unknown };
    /** The deliberation a reasoning model billed inside `completion_tokens`. */
    readonly completion_tokens_details?: { readonly reasoning_tokens?: unknown };
    /** Some gateways put the raw counter at the top of `usage` instead. */
    readonly reasoning_tokens?: unknown;
  };
}

/**
 * The cached-prompt count, from whichever field the endpoint used.
 *
 * The order is the vendor's own: DeepSeek reports `prompt_cache_hit_tokens` at the top level,
 * OpenAI nests `cached_tokens` under `prompt_tokens_details`, and a gateway in between may put
 * the raw name at the top. Reading all three in one place is what keeps the meter from
 * depending on which vendor answered.
 *
 * A non-numeric or missing field returns `undefined` rather than zero. The difference is the
 * whole point of the column: `0` says the prompt was not cached, and a provider that does not
 * report caching has not made that claim.
 */
export function cachedTokensOf(usage: { readonly prompt_cache_hit_tokens?: unknown; readonly cached_tokens?: unknown; readonly prompt_tokens_details?: { readonly cached_tokens?: unknown } } | undefined): number | undefined {
  if (usage === undefined) return undefined;
  for (const raw of [usage.prompt_cache_hit_tokens, usage.prompt_tokens_details?.cached_tokens, usage.cached_tokens]) {
    if (raw === undefined || raw === null) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * The reasoning-token count, from whichever field the endpoint used.
 *
 * OpenAI nests the counter under `completion_tokens_details`, DeepSeek reports none at all for a
 * thinking alias, and gateways in between put the raw name at the top of `usage`. Reading both
 * spellings in one place keeps the meter from depending on which vendor answered.
 *
 * `undefined` and `0` are different facts, for the same reason they are in `cachedTokensOf`: an
 * endpoint that reported the field and spent nothing thinking has measured something, and one
 * that said nothing has not. `0` is returned, not swallowed.
 */
export function reasoningTokensOf(
  usage:
    | { readonly reasoning_tokens?: unknown; readonly completion_tokens_details?: { readonly reasoning_tokens?: unknown }; readonly [field: string]: unknown }
    | undefined,
): number | undefined {
  if (usage === undefined) return undefined;
  for (const raw of [usage.completion_tokens_details?.reasoning_tokens, usage.reasoning_tokens]) {
    if (raw === undefined || raw === null) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

export function createHttpProvider(options: HttpProviderOptions): LlmProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retries = Math.max(1, options.retries ?? 1);
  const retryDelayMs = options.retryDelayMs ?? 500;
  /**
   * How many times a truncated reply may be asked again with a larger budget.
   *
   * Two, not one: a reasoning endpoint's deliberation is not bounded by a doubling, and the
   * measured reply that overran 4,096 was billed for 21,932 tokens. Two also keeps the arithmetic
   * legible — 4,096 becomes 8,192 becomes 16,384, and a chat endpoint's declared ceiling of 8,192
   * stops it at the second step.
   */
  const budgetEscalations = Math.max(0, options.budgetEscalations ?? 2);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const endpoint = `${options.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const capabilities = capabilitiesOf(options.model, options.capabilities);

  return {
    id: 'http',
    model: options.model,
    capabilities,
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
      // The request as this endpoint will read it. A parameter the endpoint ignores is removed
      // here rather than sent and forgotten: the meter reports what was asked for, and a field
      // that never took effect would make that report false. On a chat model this is a no-op.
      const adapted = adaptRequest(request, capabilities);
      const body: Record<string, unknown> = {
        model: options.model,
        messages: adapted.request.messages,
      };
      // Omitted rather than defaulted, so that `null` can mean what it says. The field is
      // written only when the deployment has an opinion about it and the endpoint honours it.
      if (adapted.request.temperature !== null && adapted.request.temperature !== undefined) {
        body.temperature = adapted.request.temperature;
      }
      if (adapted.request.maxTokens !== undefined) body.max_tokens = adapted.request.maxTokens;
      if (adapted.request.json === true) body.response_format = { type: 'json_object' };
      // Written only when the endpoint declared the switch. The value is a two-state object
      // rather than a boolean because that is the shape the vendors document, and an
      // undeclared mode is removed by `adaptRequest` before it reaches this line.
      if (adapted.request.thinking !== undefined) {
        body.thinking = { type: adapted.request.thinking ? 'enabled' : 'disabled' };
      }

      let payload: CompletionBody | undefined;
      let response: Response | undefined;
      let attempts = 0;
      let transport: unknown;
      // The answer budget is a floor, not a ceiling.
      //
      // A reply that comes back empty *because the endpoint spent the whole budget* is the one
      // fact that justifies naming a bigger number, and `max_tokens` is a limit rather than a
      // reservation: the bigger number costs nothing unless the model uses the room. So the
      // expensive direction is to keep sending a budget already proven too small — measured, a
      // 4,096-token budget against an endpoint whose single reply ran to 21,932 completion tokens,
      // where 13.7% of a run came back with no content at all. The loop is bounded twice, by the
      // declared ceiling and by `budgetEscalations`, because the cap exists to stop a rambling
      // model and an unbounded retry would remove the thing it was for.
      let budget = adapted.request.maxTokens;
      // `0` and absent both mean "this deployment has not told me a ceiling", which is the same
      // spelling `maxOutputTokens` already uses for "no cap declared". Guessing above an
      // undisclosed limit would trade a truncation for a refused request, which is the worse of
      // the two: a truncated reply is at least a reply.
      const proposed = capabilities.answerBudgetCeiling ?? 0;
      const ceiling = budget === undefined || proposed <= 0 ? undefined : Math.max(budget, proposed);
      const budgets: number[] = budget === undefined ? [] : [budget];
      let truncated = false;
      // What the endpoint charged for this call, which is not the same as what its last response
      // says. A discarded truncated attempt spent a whole budget and produced nothing, and a cost
      // column that read only the reply it kept would report the escalation as free — the exact
      // shape of a number that looks like a measurement and is a hole. `calls` stays one (a retry
      // inside the provider is one logical call, as it always was); tokens are what was billed.
      const spend = { prompt: 0, completion: 0, cached: 0, reasoning: 0, cachedSeen: false, reasoningSeen: false };
      const bill = (body: CompletionBody | undefined): void => {
        if (body === undefined) return;
        spend.prompt += Number(body.usage?.prompt_tokens ?? 0);
        spend.completion += Number(body.usage?.completion_tokens ?? 0);
        const cached = cachedTokensOf(body.usage);
        if (cached !== undefined) {
          spend.cached += cached;
          spend.cachedSeen = true;
        }
        const reasoning = reasoningTokensOf(body.usage);
        if (reasoning !== undefined) {
          spend.reasoning += reasoning;
          spend.reasoningSeen = true;
        }
      };
      try {
        for (let step = 0; ; step += 1) {
          if (budget !== undefined && step > 0) body.max_tokens = budget;
          payload = undefined;
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
                // `JSON.parse` is typed `any`, so `null` — which is valid JSON — would arrive as
                // a body and make the `payload.choices` read below throw a TypeError instead of
                // the error this layer promises. A body that parses to something other than an
                // object is not a completion, whatever it parses to.
                const parsed: unknown = JSON.parse(text);
                payload = parsed !== null && typeof parsed === 'object' ? (parsed as CompletionBody) : undefined;
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
          // Whether the endpoint used the whole budget and had nothing left to say. Content is the
          // test, not the stop reason: an endpoint can cut a reply *after* the statement it needed
          // to write, and paying twice for that would make a working case look expensive. Read
          // after the transport loop, never inside it: inside, a reply that was not cut would fall
          // through and ask the endpoint the same question again.
          const cut = payload?.choices?.[0];
          const wrote = cut?.message?.content;
          truncated = (typeof wrote !== 'string' || wrote.length === 0) && cut?.finish_reason === 'length';
          bill(payload);
          if (!truncated) break;
          const current = budget;
          if (current === undefined || ceiling === undefined || step >= budgetEscalations) break;
          const next = Math.min(current * 2, ceiling);
          if (next <= current) break;
          budget = next;
          budgets.push(budget);
        }
      } finally {
        clearTimeout(timer);
        external?.removeEventListener('abort', onAbort);
      }

      if (response === undefined || !response.ok) {
        const status = response?.status;
        // A 4xx that is not a rate limit is the endpoint refusing the request, which is a
        // different fault from the endpoint being absent — and it is the fault a deployment
        // meets first, because the request carries the model name, the key and the sampling
        // parameters. One code for both made "the model name is wrong" read as "the endpoint
        // is unreachable", and every question that follows from that reading sends the reader
        // at the network when the answer is in the request. 408 and 429 stay unavailable:
        // both mean the same request may work later.
        const refused =
          status !== undefined && status >= 400 && status < 500 && status !== 408 && !RETRYABLE.has(status);
        const detail = refused && response !== undefined ? await refusalDetail(response) : undefined;
        if (refused) {
          throw toNl2ChartsError(
            'NL2C_E_LLM_REJECTED',
            `llm refused the request with ${String(status)}${detail === undefined ? '' : `: ${detail}`}`,
            undefined,
            { status, endpoint, attempts, ...(detail === undefined ? {} : { detail }) },
          );
        }
        throw toNl2ChartsError('NL2C_E_LLM_UNAVAILABLE', `llm returned ${status ?? 'nothing'}`, transport, {
          ...(status === undefined ? {} : { status }),
          attempts,
        });
      }
      if (payload === undefined) {
        throw toNl2ChartsError('NL2C_E_LLM_INVALID_RESPONSE', 'llm response is not JSON', transport, { attempts });
      }

      const choice = payload.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        // Two faults used to share this one branch and one code, and the repairs are opposite. A
        // reply cut at the cap is a fact about a number this library chose: the fix is a larger
        // number, and the escalation above has already tried every number it is allowed to name.
        // Anything else empty is a fact about the endpoint. Reporting the first as the second is
        // how a harness came to count a budget as an outage and throw away 130 unmade calls.
        const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'unknown';
        const present = Object.keys(choice?.message ?? {});
        if (truncated) {
          throw toNl2ChartsError(
            'NL2C_E_LLM_TRUNCATED',
            `llm response was cut at the answer budget with nothing left ` +
              `(finish_reason=${finish}, budgets tried: ${budgets.join(' -> ')})`,
            undefined,
            { finishReason: finish, budget, budgets, attempts, fields: present },
          );
        }
        throw toNl2ChartsError(
          'NL2C_E_LLM_INVALID_RESPONSE',
          `llm response has no content (finish_reason=${finish}${present.length === 0 ? '' : `, message fields: ${present.join(',')}`})`,
          undefined,
          { finishReason: finish, fields: present },
        );
      }
      // Every attempt this call paid for, not the one it kept: see `bill` above. Read at the same
      // point as the cache figure and for the same reason — a reasoning alias's deliberation is
      // billed inside `completion_tokens`, so without that column "594 tokens" cannot be split
      // into "thought for 540, wrote 54", which is the whole question a reasoning comparison asks.
      const promptTokens = Number.isFinite(spend.prompt) ? spend.prompt : 0;
      const completionTokens = Number.isFinite(spend.completion) ? spend.completion : 0;
      const cachedPromptTokens = spend.cachedSeen ? spend.cached : undefined;
      const reasoningTokens = spend.reasoningSeen ? spend.reasoning : undefined;
      // Read on the success path as well as the failure path. The failure path above already
      // names the finish reason in its message; here it is the answer's own property, and the
      // reply that most needs it — twenty thousand tokens of deliberation that never reached a
      // statement — arrives with status 200 and content.
      const finishReason = finishReasonOf(choice?.finish_reason);
      const model = typeof payload.model === 'string' ? payload.model : options.model;
      return {
        text: content,
        model,
        ...(finishReason === undefined ? {} : { finishReason }),
        usage: {
          promptTokens,
          completionTokens,
          ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
          ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        },
        ...(adapted.ignored.length === 0 ? {} : { ignored: adapted.ignored }),
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
  readonly usage: () => {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly chars: number;
    readonly unbilled: number;
    readonly cachedTokens: number;
    readonly cachedReported: number;
    readonly reasoningTokens: number;
    readonly reasoningReported: number;
  };
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
  /**
   * Parameters the endpoint dropped, and how many calls carried one.
   *
   * The counterpart of `unbilled`, one layer up: a run that sent `temperature: 0` to an endpoint
   * that ignores it has not sampled at zero, and a report that prints "temperature 0" without
   * this count asserts something the endpoint never did. Empty on a provider that honours every
   * field, which is the state this repository's published readings were taken in.
   */
  readonly omitted: () => ReadonlyMap<string, number>;
  /**
   * The model that answered, per answer, keyed by the name the endpoint reported.
   *
   * A requested model name is an alias, and an alias is a promise kept on the endpoint's
   * schedule: the same string can be served by a different base model next month, and a run
   * that recorded only the request cannot tell a re-measurement from a re-measurement on new
   * weights. The answer carries the truth, so it is kept per call rather than folded into the
   * requested name — one arm served by two bases is a state this ledger has to be able to show.
   */
  readonly servedModels: () => ReadonlyMap<string, number>;
} {
  type Meter = {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    chars: number;
    unbilled: number;
    cachedTokens: number;
    cachedReported: number;
    reasoningTokens: number;
    reasoningReported: number;
  };
  const zero = (): Meter => ({
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    chars: 0,
    unbilled: 0,
    cachedTokens: 0,
    cachedReported: 0,
    reasoningTokens: 0,
    reasoningReported: 0,
  });
  // One ledger, two views: the totals are accumulated beside the buckets at the same point rather
  // than recounted later, and a test holds them to the property that makes the share meaningful —
  // the buckets add up to the total. Recounting would be a second implementation of the same sum.
  const totals = zero();
  const purposes = new Map<CallPurpose | typeof UNLABELLED, Meter>();
  const dropped = new Map<string, number>();
  const served = new Map<string, number>();
  return {
    provider: {
      id: provider.id,
      model: provider.model,
      // A wrapper that drops the declaration is the same defect one layer up: the pipeline reads
      // `capabilities` off whatever provider it is handed, and a metered provider without one
      // silently looked like an endpoint whose protocol nobody knows — which is how a reasoning
      // judge was asked for a bare number and answered in prose.
      ...(provider.capabilities === undefined ? {} : { capabilities: provider.capabilities }),
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
        for (const parameter of response.ignored ?? []) dropped.set(parameter, (dropped.get(parameter) ?? 0) + 1);
        // Counted before the usage branch, because an answer without a usage block is still an
        // answer from a model. Recording only the billed calls would let a base change hide
        // behind an endpoint that stopped reporting tokens that hour.
        served.set(response.model, (served.get(response.model) ?? 0) + 1);
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
        // Counted only when the endpoint said something, and counted on the same branch as the
        // prompt it describes: a cache figure added to a case whose prompt tokens were never
        // metered would be a share of a total that does not exist.
        const cached = response.usage.cachedPromptTokens;
        if (cached !== undefined) {
          meter.cachedTokens += cached;
          meter.cachedReported += 1;
          totals.cachedTokens += cached;
          totals.cachedReported += 1;
        }
        // Same rule one column over: counted per answer, and only when the endpoint said
        // something. A reasoning count that arrived on a third of the answers is an endpoint that
        // reports unevenly, and averaging it over all of them would divide one fact by another.
        const reasoning = response.usage.reasoningTokens;
        if (reasoning !== undefined) {
          meter.reasoningTokens += reasoning;
          meter.reasoningReported += 1;
          totals.reasoningTokens += reasoning;
          totals.reasoningReported += 1;
        }
        return response;
      },
    },
    calls: () => totals.calls,
    usage: () => ({
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      chars: totals.chars,
      unbilled: totals.unbilled,
      cachedTokens: totals.cachedTokens,
      cachedReported: totals.cachedReported,
      reasoningTokens: totals.reasoningTokens,
      reasoningReported: totals.reasoningReported,
    }),
    byPurpose: () => new Map(purposes),
    unlabelled: () => purposes.get(UNLABELLED)?.calls ?? 0,
    omitted: () => new Map(dropped),
    servedModels: () => new Map(served),
  };
}
