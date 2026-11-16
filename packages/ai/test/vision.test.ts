import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';
import { adaptRequest, CHAT_CAPABILITIES, capabilitiesOf } from '../src/capability.js';
import type { LlmMessage } from '../src/provider.js';
import { createHttpProvider, wireMessages, withCallCounter } from '../src/provider.js';
import { createReplayProvider, transcriptOf } from '../src/replay.js';

/**
 * The image channel, tested against a socket.
 *
 * Every assertion about the wire is taken from bytes a server actually received, not from the
 * object this package built: the defect this channel could ship is a request that looks right in
 * memory and is written as `[object Object]` to the endpoint, and only the far side of a socket
 * can see that.
 */

let server: Server;
let baseUrl: string;
/** The raw body of the last request, unparsed, so "byte-identical" can be asserted as bytes. */
let lastRaw = '';
let lastBody: Record<string, unknown> = {};
let hits = 0;

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
    hits += 1;
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      lastRaw = body;
      lastBody = JSON.parse(body) as Record<string, unknown>;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          model: 'vision-test',
          choices: [{ message: { content: '{"correctness": 8, "readability": 7}' } }],
          usage: { prompt_tokens: 1_040, completion_tokens: 12 },
        }),
      );
    });
  });
  server = started.server;
  baseUrl = started.url;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  hits = 0;
  lastRaw = '';
  lastBody = {};
});

/** A one-pixel PNG, base64 of the real header-plus-pixel bytes rather than a made-up string. */
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const vision = (): ReturnType<typeof createHttpProvider> =>
  createHttpProvider({ baseUrl, model: 'vision-test', capabilities: { vision: true } });

describe('a text-only message is the message it always was', () => {
  it('writes exactly {role, content} and nothing beside it', () => {
    expect(wireMessages([{ role: 'user', content: 'how many orders' }])).toEqual([
      { role: 'user', content: 'how many orders' },
    ]);
  });

  it('leaves the field names and the order of the body untouched on the wire', async () => {
    await vision().complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 64, temperature: 0 });
    // The exact bytes: a text request must be reproducible against every reading taken before the
    // image channel existed, and the only proof of that is the string the endpoint received.
    expect(lastRaw).toBe('{"model":"vision-test","messages":[{"role":"user","content":"hi"}],"temperature":0,"max_tokens":64}');
  });

  it('does not write an images field even when a caller passes an empty array', async () => {
    await vision().complete({ messages: [{ role: 'user', content: 'hi', images: [] }] });
    // `temperature: 0` is the repository's default and is written here as it always was: the point
    // of the assertion is that the message array did not grow a field, not that the body is short.
    expect(lastRaw).toBe('{"model":"vision-test","messages":[{"role":"user","content":"hi"}],"temperature":0,"max_tokens":4096}');
  });
});

describe('a message that carries an image', () => {
  it('writes a parts array with the text first and the image as a data URL', async () => {
    await vision().complete({
      messages: [
        { role: 'user', content: 'is this a bar chart?', images: [{ mediaType: 'image/png', data: PIXEL_PNG }] },
      ],
    });
    const messages = lastBody.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'is this a bar chart?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PIXEL_PNG}` } },
      ],
    });
  });

  it('writes no text part at all when the message has no words', () => {
    const wired = wireMessages([{ role: 'user', content: '', images: [{ mediaType: 'image/png', data: PIXEL_PNG }] }]);
    expect(wired[0]?.content).toEqual([{ type: 'image_url', image_url: { url: `data:image/png;base64,${PIXEL_PNG}` } }]);
  });

  it('keeps the order of several images, because the question may refer to them by position', () => {
    const wired = wireMessages([
      {
        role: 'user',
        content: 'compare',
        images: [
          { mediaType: 'image/png', data: PIXEL_PNG },
          { mediaType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' },
          { mediaType: 'image/webp', data: 'UklGRg==' },
        ],
      },
    ]);
    // The text part is first, so the images are the parts that have a `url` — selecting them by
    // shape rather than by index is also the assertion that no fourth part appeared.
    const parts = (wired[0]?.content as { readonly image_url?: { readonly url: string } }[]).filter(
      (part): part is { readonly image_url: { readonly url: string } } => part.image_url !== undefined,
    );
    expect(parts).toHaveLength(3);
    expect(parts.map((part) => part.image_url.url.split(';')[0])).toEqual([
      'data:image/png',
      'data:image/jpeg',
      'data:image/webp',
    ]);
  });

  it('survives a text message beside it in the same request', () => {
    const wired = wireMessages([
      { role: 'system', content: 'you grade charts' },
      { role: 'user', content: 'rate it', images: [{ mediaType: 'image/png', data: PIXEL_PNG }] },
    ]);
    expect(wired[0]).toEqual({ role: 'system', content: 'you grade charts' });
    expect(Array.isArray(wired[1]?.content)).toBe(true);
  });
});

describe('a payload that is not bytes is refused here, not at the endpoint', () => {
  const cases: readonly { readonly name: string; readonly data: string; readonly says: RegExp }[] = [
    { name: 'a data URL', data: 'data:image/png;base64,iVBORw0KGgo=', says: /is a data URL/ },
    { name: 'an empty payload', data: '', says: /carries no bytes/ },
    { name: 'a filesystem path', data: '/tmp/chart-17.png', says: /is not base64/ },
    { name: 'a url', data: 'https://example.test/chart-17.png', says: /is not base64/ },
    { name: 'a raw buffer spelling', data: 'Buffer <89 50 4e 47>', says: /is not base64/ },
  ];
  for (const one of cases) {
    it(`refuses ${one.name} before the request is built`, async () => {
      const provider = vision();
      let thrown: unknown;
      try {
        await provider.complete({ messages: [{ role: 'user', content: 'x', images: [{ mediaType: 'image/png', data: one.data }] }] });
      } catch (error) {
        thrown = error;
      }
      expect(isNl2ChartsError(thrown)).toBe(true);
      expect(thrown instanceof Error ? thrown.message : '').toMatch(one.says);
      // Nothing was sent. A refusal after a request has already travelled is a report about a
      // call that happened, which is the one thing a refusal exists to prevent.
      expect(hits).toBe(0);
    });
  }

  it('accepts a payload with line breaks, which the base64 MIME encoding of a large PNG carries', () => {
    expect(() =>
      // A wrapped payload puts the newline between two data characters; padding only ever appears
      // at the end, so this is the shape a MIME-wrapped PNG actually has.
      wireMessages([{ role: 'user', content: '', images: [{ mediaType: 'image/png', data: 'iVBORw0KGgoAAAADUlEQ\nVR42mP8' }] }]),
    ).not.toThrow();
  });
});

describe('the capability that decides whether a picture can be sent at all', () => {
  it('refuses an image to an endpoint that declares nothing', () => {
    const blind = createHttpProvider({ baseUrl, model: 'deepseek-chat' });
    const messages: readonly LlmMessage[] = [
      { role: 'user', content: 'rate this', images: [{ mediaType: 'image/png', data: PIXEL_PNG }] },
    ];
    let thrown: unknown;
    try {
      adaptRequest({ messages }, blind.capabilities ?? CHAT_CAPABILITIES);
    } catch (error) {
      thrown = error;
    }
    expect(isNl2ChartsError(thrown)).toBe(true);
    expect(thrown instanceof Error ? thrown.message : '').toMatch(/carries 1 image\(s\) and the endpoint declares no vision/);
    // The count is in the message because the usual cause is a batch where one row grew a figure.
    expect(isNl2ChartsError(thrown) ? (thrown as { details?: Record<string, unknown> }).details?.images : undefined).toBe(1);
  });

  it('never lets a provider send it either, so the refusal is not a promise the call site keeps', async () => {
    const blind = createHttpProvider({ baseUrl, model: 'deepseek-chat' });
    await expect(
      blind.complete({ messages: [{ role: 'user', content: 'rate this', images: [{ mediaType: 'image/png', data: PIXEL_PNG }] }] }),
    ).rejects.toThrow(/declares no vision/);
    expect(hits).toBe(0);
  });

  it('sends it when the deployment declares vision, and only then', async () => {
    await vision().complete({ messages: [{ role: 'user', content: 'rate this', images: [{ mediaType: 'image/png', data: PIXEL_PNG }] }] });
    expect(hits).toBe(1);
  });

  it('does not have to be declared on a family, only on the endpoint', () => {
    expect(capabilitiesOf('glm-4v', { vision: true }).vision).toBe(true);
    expect(capabilitiesOf('glm-4v', { vision: true, family: 'reasoning' }).vision).toBe(true);
    // Undeclared is undefined rather than false: "nobody said" and "it cannot" are both refusals
    // here, but only one of them is a statement about the model.
    expect(capabilitiesOf('glm-4v').vision).toBeUndefined();
  });

  it('counts every image in the request, not just the first message', () => {
    const messages: readonly LlmMessage[] = [
      { role: 'user', content: 'a', images: [{ mediaType: 'image/png', data: PIXEL_PNG }] },
      { role: 'user', content: 'b', images: [{ mediaType: 'image/png', data: PIXEL_PNG }, { mediaType: 'image/png', data: PIXEL_PNG }] },
    ];
    let thrown: unknown;
    try {
      adaptRequest({ messages }, CHAT_CAPABILITIES);
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof Error ? thrown.message : '').toMatch(/carries 3 image\(s\)/);
  });
});

describe('what the meter says about a picture', () => {
  it('counts the text and the images apart, so the characters-per-token ratio stays about text', async () => {
    const metered = withCallCounter(vision());
    await metered.provider.complete({
      messages: [{ role: 'user', content: 'rate', images: [{ mediaType: 'image/png', data: PIXEL_PNG }] }],
      purpose: 'compare',
    });
    const usage = metered.usage();
    // `chars` is four, not four plus 96 — a 44 KiB figure would otherwise contribute 60,000
    // characters to a ratio whose token side includes the picture's tokens as one opaque number.
    expect(usage.chars).toBe(4);
    expect(usage.images).toBe(1);
    expect(usage.promptTokens).toBe(1_040);
    expect(metered.byPurpose().get('compare')?.images).toBe(1);
  });

  it('reports zero images on a text-only run, which is what makes the column comparable', async () => {
    const metered = withCallCounter(vision());
    await metered.provider.complete({ messages: [{ role: 'user', content: 'rate' }], purpose: 'generate' });
    expect(metered.usage().images).toBe(0);
    expect(metered.usage().chars).toBe(4);
  });

  it('keeps the buckets summing to the total, images included', async () => {
    const metered = withCallCounter(vision());
    await metered.provider.complete({ messages: [{ role: 'user', content: 'a', images: [{ mediaType: 'image/png', data: PIXEL_PNG }] }], purpose: 'compare' });
    await metered.provider.complete({ messages: [{ role: 'user', content: 'bb' }], purpose: 'generate' });
    const total = metered.usage();
    let images = 0;
    let chars = 0;
    for (const bucket of metered.byPurpose().values()) {
      images += bucket.images ?? 0;
      chars += bucket.chars;
    }
    expect(images).toBe(total.images);
    expect(chars).toBe(total.chars);
  });
});

describe('a replay looks a request up by its pictures as well as its words', () => {
  it('is the old transcript exactly when there are no images', () => {
    expect(transcriptOf([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }])).toBe('a\nb');
  });

  it('separates two requests that differ only by the figure they carry', () => {
    const one = transcriptOf([{ role: 'user', content: 'rate', images: [{ mediaType: 'image/png', data: PIXEL_PNG }] }]);
    const other = transcriptOf([{ role: 'user', content: 'rate', images: [{ mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' }] }]);
    expect(one).not.toBe(other);
    expect(one).toMatch(/\[image image\/png \d+:[0-9a-f]+\]$/);
  });

  it('is stable across two calls with the same picture, which is what a fixture needs', () => {
    const build = (): string => transcriptOf([{ role: 'user', content: 'rate', images: [{ mediaType: 'image/png', data: PIXEL_PNG }] }]);
    expect(build()).toBe(build());
  });

  it('will not serve a fixture recorded for a different figure', async () => {
    const recorded = transcriptOf([{ role: 'user', content: 'rate', images: [{ mediaType: 'image/png', data: PIXEL_PNG }] }]);
    const provider = createReplayProvider([{ match: recorded, response: 'eight' }]);
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'rate', images: [{ mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' }] }] }),
    ).rejects.toThrow(/no recorded response matches this prompt/);
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'rate', images: [{ mediaType: 'image/png', data: PIXEL_PNG }] }] }),
    ).resolves.toMatchObject({ text: 'eight' });
  });

  it('still matches a text fixture against a text request, byte for byte', async () => {
    const provider = createReplayProvider([{ match: 'how many orders', response: 'SELECT 1' }]);
    await expect(provider.complete({ messages: [{ role: 'user', content: 'how many orders' }] })).resolves.toMatchObject({
      text: 'SELECT 1',
    });
  });
});
