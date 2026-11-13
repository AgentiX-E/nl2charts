/**
 * What a model can do, as a value the request builder can read.
 *
 * The contract this file exists for: a deployment may swap the backbone, and a swap used to
 * change the answer without changing anything the pipeline could see. Two models were sent the
 * same `temperature: 0`; one honoured it and one silently dropped it, and the harness recorded
 * both as "sampled at zero". The refusal case is already handled (`probeProtocol` retries
 * without the field), which covers the models that say no. It does not cover the vendors that
 * say yes and mean nothing — DeepSeek's thinking-mode documentation states that `temperature`,
 * `top_p`, `presence_penalty` and `frequency_penalty` are accepted for compatibility and have no
 * effect. A parameter the pipeline cannot observe is indistinguishable from one it never sent.
 *
 * So a provider declares its capabilities, the request builder reads them, and every parameter
 * that was dropped is reported rather than assumed. Nothing here is a guess about quality: the
 * capabilities say what the endpoint does with a request, not how well it answers one.
 */
import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { LlmRequest } from './provider.js';

/**
 * The two shapes a chat-completions endpoint serves today.
 *
 * `reasoning` is not "better"; it is a different protocol. The model writes a chain of thought
 * before its answer, the sampling parameters do not apply to it, and the answer arrives in a
 * field beside the reasoning rather than inside it.
 */
export type ModelFamily = 'chat' | 'reasoning';

/** Whether the endpoint honours the sampling parameters the request carries. */
export type SamplingSupport = 'honoured' | 'ignored';

export interface ModelCapabilities {
  readonly family: ModelFamily;
  /**
   * `ignored` is the vendor's documented behaviour, not a suspicion. It changes the request:
   * a field that has no effect is removed, and its removal is reported.
   */
  readonly sampling: SamplingSupport;
  /** Whether `response_format: {type: 'json_object'}` is served. Reasoning endpoints often are not. */
  readonly jsonMode: boolean;
  /**
   * The cap on the *answer*, in tokens.
   *
   * This is the budget the first request names, and for a reasoning endpoint it is the *whole*
   * completion: the chain of thought is billed and counted inside `max_tokens`, so a budget sized
   * for the answer alone is a budget the deliberation can exhaust before writing a word. That is
   * not a theory here. `deepseek-v4-pro` was declared a chat endpoint, sent 4,096, and answered 50
   * of 366 calls with `content: null` and `finish_reason: "length"` — the tokens were spent
   * thinking. It is declared here because the endpoint's default is a number the pipeline never
   * chose and cannot see, and it is *sent* on every request that names no budget of its own: a
   * declared ceiling that never reaches the wire is a number the report prints and the endpoint
   * never reads.
   */
  readonly maxOutputTokens: number;
  /**
   * The largest budget this endpoint accepts, when the deployment knows it.
   *
   * Present, it lets the provider answer a truncated reply with a bigger budget instead of a
   * failure: `max_tokens` is a limit rather than a reservation, so raising it costs nothing unless
   * the model uses the room. Absent means "do not guess" — a self-hosted endpoint with an
   * undocumented limit would answer the guess with a 400, turning a truncation into a refusal.
   * Never below `maxOutputTokens`: a ceiling under the first budget would only make the first
   * request invalid.
   */
  readonly answerBudgetCeiling?: number;
  /**
   * Whether the prompt may ask for reasoning before the answer.
   *
   * A reasoning model that is told "answer with the number and nothing else" either ignores the
   * instruction (and produces prose a strict reader rejects) or obeys it and gives up the
   * deliberation it was chosen for. Both are the pipeline's fault, not the model's.
   */
  readonly thinksAloud: boolean;
  /**
   * Whether the endpoint accepts an explicit `thinking: {type: 'enabled' | 'disabled'}`.
   *
   * Not derived from the model name. A name that says "reasoner" describes a mode, not a
   * protocol, and the two ways of being wrong are silent: an endpoint that ignores the field
   * answers 200 and the report prints a mode nobody ran; one that rejects it answers 400 that
   * reads as a bad key. So the default is `false` and a deployment that knows its endpoint
   * says so — the same rule as every other field in this contract.
   */
  readonly thinkingSwitch: boolean;
}

/** A chat endpoint: sampling applies, JSON mode is served, the answer cap is the vendor's usual 4K. */
export const CHAT_CAPABILITIES: ModelCapabilities = {
  family: 'chat',
  sampling: 'honoured',
  jsonMode: true,
  maxOutputTokens: 4096,
  // 8,192 is the largest `max_tokens` the chat endpoints this repository benchmarks document.
  // Named as a ceiling so that a reply cut at 4K can be asked again with room, rather than
  // reported as an answer that does not exist.
  answerBudgetCeiling: 8192,
  thinksAloud: false,
  thinkingSwitch: false,
};

/**
 * A reasoning endpoint, as documented by the vendors that serve one.
 *
 * 8,192 is what this repository sends first — a budget small enough that a model which decides to
 * deliberate for twenty thousand tokens cannot do it unnoticed. The ceiling is 32,768, and the
 * evidence for it is this repository's own artifact rather than a vendor page: one
 * `deepseek-v4-pro` reply was billed for **21,932 completion tokens**, so an endpoint that serves
 * that model accepts at least that much output, and a ceiling below it would refuse the very reply
 * the escalation exists to buy. Above the ceiling the answer is a truncation, reported as one.
 */
export const REASONING_CAPABILITIES: ModelCapabilities = {
  family: 'reasoning',
  sampling: 'ignored',
  jsonMode: false,
  maxOutputTokens: 8192,
  answerBudgetCeiling: 32768,
  thinksAloud: true,
  // A mode is not a switch: `deepseek-reasoner` is *always* thinking, and the endpoint that
  // can choose is a different one. Declaring it here would send the field to an endpoint that
  // never documented it.
  thinkingSwitch: false,
};

/**
 * The names that mean "this endpoint thinks before it answers".
 *
 * Deliberately narrow. A wrong guess in the `chat` direction sends a parameter that is ignored
 * (the status quo, harmless); a wrong guess in the `reasoning` direction removes a parameter the
 * endpoint would have honoured and refuses a JSON mode it serves. The pattern therefore matches
 * only families whose protocol is documented, and anything else must be declared by the
 * deployment through `capabilitiesOf`'s overrides.
 */
const REASONING_NAME = /(?:^|[-_/])(?:reasoner|thinking|r1|qwq|magistral|o[1-9])(?:$|[-_/])/i;

/**
 * A capability declaration: the family's defaults, with any field the deployment overrides.
 *
 * The base is chosen by the *declared* family, not by the name. The name is a guess and a
 * declaration is not, so the two must not be consulted in that order: picking the base from the
 * name and then overwriting `family` produced records that contradicted themselves, and the more
 * completely a deployment declared its endpoint the worse they got. On a model whose name says
 * nothing — `private-prod-a`, which is what a self-hosted reasoning endpoint is called — declaring
 * `{family: 'reasoning', sampling: 'ignored'}` produced `thinksAloud: false` (the chat judge
 * format) beside `jsonMode: true` (a JSON mode the endpoint does not serve) and a 4,096-token
 * answer budget against a documented 8,192. Declaring less was strictly better than declaring
 * more, which is the shape of a merge that reads the wrong source.
 */
export function capabilitiesOf(model: string, overrides?: Partial<ModelCapabilities>): ModelCapabilities {
  const family: ModelFamily = overrides?.family ?? (REASONING_NAME.test(model) ? 'reasoning' : 'chat');
  const base = family === 'reasoning' ? REASONING_CAPABILITIES : CHAT_CAPABILITIES;
  // `family` last so the record's own field agrees with the base it was derived from; every other
  // field keeps the caller's value, including one that deliberately contradicts the family — a
  // chat endpoint that ignores sampling is a documented vendor behaviour, not a mistake.
  return overrides === undefined ? base : { ...base, ...overrides, family };
}

/** A request together with what the endpoint will actually do with it. */
export interface AdaptedRequest {
  readonly request: LlmRequest;
  /** Parameters the request carried that this endpoint does not honour. Empty on a chat model. */
  readonly ignored: readonly string[];
  readonly capabilities: ModelCapabilities;
}

/**
 * Rewrite a request into the shape the endpoint serves, and say what was removed.
 *
 * Four rules, each with a reason:
 *
 * 1. A sampling parameter the endpoint ignores is removed, because sending it makes the meter
 *    lie. `temperature: null` is already absent by contract and is not reported.
 * 2. Every endpoint is given an answer budget when the caller named none, from
 *    `maxOutputTokens`. The vendor's default is not a decision this repository made, and a
 *    truncated answer reads as a wrong one (`finish_reason=length` with empty content is
 *    diagnosed in `provider.ts`). The rule used to apply to `reasoning` alone, which left the
 *    family the field was written for with no cap at all.
 * 3. JSON mode on an endpoint that does not serve it is refused here, with the feature named,
 *    rather than sent and answered with a 400 that reads as a bad key.
 * 4. Nothing else is touched. A chat request gains `max_tokens` and is otherwise unchanged, so
 *    the readings taken before this file existed are reproducible by reading the column that
 *    says which cap was in force — which is why the cap is a declared field and not a constant
 *    in the request builder.
 */
export function adaptRequest(request: LlmRequest, capabilities: ModelCapabilities): AdaptedRequest {
  if (request.json === true && !capabilities.jsonMode) {
    throw toNl2ChartsError(
      'NL2C_E_NOT_SUPPORTED',
      `this endpoint does not serve JSON mode (model family: ${capabilities.family})`,
      undefined,
      { family: capabilities.family },
    );
  }
  const ignored: string[] = [];
  const next: {
    messages: LlmRequest['messages'];
    temperature?: number | null;
    maxTokens?: number;
    json?: boolean;
    thinking?: boolean;
    purpose?: LlmRequest['purpose'];
  } = { messages: request.messages };

  if (capabilities.sampling === 'ignored') {
    // Dropped, and counted only when the request actually carried a value. `null` is already
    // absent by contract and is not a parameter that was taken away; it is kept so the caller
    // can still see the difference between "this deployment said nothing" and "it said send
    // nothing", which is the distinction `turnTemperature` documents.
    if (request.temperature === null) next.temperature = null;
    else if (request.temperature !== undefined) ignored.push('temperature');
  } else if (request.temperature === null) {
    // Explicitly absent stays absent; it is not a parameter that was dropped.
    next.temperature = null;
  } else {
    // The repository's default, unchanged: an unconfigured call samples at zero, which is the
    // value every published reading was taken at.
    next.temperature = request.temperature ?? 0;
  }

  if (request.maxTokens !== undefined) next.maxTokens = request.maxTokens;
  // Sent for every family, from the number the declaration already carries. The field's own
  // documentation says it exists because "the endpoint's default is a number the pipeline never
  // chose and cannot see" — and until this line, that number was sent only for `reasoning`,
  // so the pipeline still could not see it for the family that needs it most. Measured on
  // `deepseek-v4-pro` (Mini-Dev, run 43262574193): one reply ran to 21,932 completion tokens
  // — 83,036 characters of deliberation that never reached a statement — because no `max_tokens`
  // accompanied the request and the endpoint applied its own ceiling.
  else if (capabilities.maxOutputTokens > 0) next.maxTokens = capabilities.maxOutputTokens;

  if (request.json !== undefined) next.json = request.json;
  // The mode selector. Sent only where the endpoint declared it serves one, and counted when it
  // was asked for and could not be honoured — the same rule as `temperature`, for the same
  // reason: a field the endpoint discards makes the report describe a run that did not happen.
  if (request.thinking !== undefined) {
    if (capabilities.thinkingSwitch) next.thinking = request.thinking;
    else ignored.push('thinking');
  }
  if (request.purpose !== undefined) next.purpose = request.purpose;

  return { request: next, ignored, capabilities };
}
