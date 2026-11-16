import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse } from './provider.js';

export interface ReplayFixture {
  readonly match: string;
  readonly response: string;
  readonly model?: string;
}

/**
 * A payload's identity, at the precision a fixture table needs.
 *
 * FNV-1a rather than SHA-256 because this package carries no `node:` import — it is bundled for
 * more than one target, and the gates refuse a builtin here — and because the question is not
 * "is this the same file" but "would two rows of a fixture table ever be confused". A 32-bit hash
 * beside the payload length answers that: a collision needs two images of the same byte length
 * whose hashes agree, and the fixture tables this repository records hold tens of images.
 *
 * Never used for a cache key on disk: that one has to be collision-proof, and it is, in
 * `@agentix-e/nl2charts-node`, which has crypto to reach for.
 */
function digest(data: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${String(data.length)}:${hash.toString(16)}`;
}

/**
 * What a replay looks a request up by: the text, and the identity of every picture in it.
 *
 * The two are written into one string because that is what a fixture's `match` is compared with,
 * and because a picture that did not appear here would be invisible to the lookup: a fixture
 * recorded for "describe this figure" would then match a request asking about a *different*
 * figure, and the replay would answer with an opinion of a chart nobody rendered.
 */
export function transcriptOf(messages: readonly LlmMessage[]): string {
  return messages
    .map((message) => {
      const images = message.images ?? [];
      if (images.length === 0) return message.content;
      const marks = images.map((image) => `[image ${image.mediaType} ${digest(image.data)}]`).join(' ');
      return `${message.content}\n${marks}`;
    })
    .join('\n');
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
      const transcript = transcriptOf(request.messages);
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
