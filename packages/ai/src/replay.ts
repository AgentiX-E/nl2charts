import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { LlmProvider, LlmRequest, LlmResponse } from './provider.js';

export interface ReplayFixture {
  readonly match: string;
  readonly response: string;
  readonly model?: string;
}

/**
 * Deterministic provider backed by recorded responses. It is a first-class
 * provider, not a mock: CI uses it to exercise the whole pipeline, and a live
 * run uses the HTTP provider with the same interfaces.
 */
export function createReplayProvider(fixtures: readonly ReplayFixture[], id = 'replay'): LlmProvider {
  return {
    id,
    model: 'replay-fixture',
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const transcript = request.messages.map((message) => message.content).join('\n');
      const fixture = fixtures.find((candidate) => transcript.includes(candidate.match));
      if (!fixture) {
        throw toNl2ChartsError('NL2C_E_LLM_UNAVAILABLE', 'no recorded response matches this prompt', undefined, {
          provider: id,
          matchLength: transcript.length,
        });
      }
      return {
        text: fixture.response,
        model: fixture.model ?? 'replay-fixture',
        usage: { promptTokens: transcript.length, completionTokens: fixture.response.length },
      };
    },
  };
}

export interface RecordedCall {
  readonly request: LlmRequest;
  readonly response: LlmResponse;
}

/** Wrap a live provider and capture exchanges so they can become fixtures. */
export function recordProvider(
  inner: LlmProvider,
  sink: RecordedCall[],
): LlmProvider {
  return {
    id: inner.id,
    model: inner.model,
    async complete(request, options) {
      const response = await inner.complete(request, options);
      sink.push({ request, response });
      return response;
    },
  };
}
