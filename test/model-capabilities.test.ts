/**
 * The capability contract: what an endpoint does with a request, declared rather than assumed.
 *
 * The defect this file is written against: `deepseek-reasoner` accepts `temperature` and ignores
 * it. The harness sent `temperature: 0`, the endpoint answered 200, `probeProtocol` said
 * `proceed`, and the report printed a sampling regime that never happened. Nothing failed, which
 * is why it survived three readings. A parameter the pipeline cannot observe is a parameter the
 * pipeline cannot claim — so it is removed, and the removal is counted.
 *
 * The second half is the format contract. A reasoning model that is told "answer with the number
 * and nothing else" either ignores the instruction (its prose used to be read as an undecided
 * vote) or obeys it and gives up the deliberation it was chosen for. The prompt therefore has two
 * shapes, and which one is sent is a property of the endpoint, not of the caller's memory.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAT_CAPABILITIES,
  REASONING_CAPABILITIES,
  adaptRequest,
  applySelection,
  buildSelectionPrompt,
  capabilitiesOf,
  createHttpProvider,
  parseReasonedChoice,
  withCallCounter,
} from '@agentix-e/nl2charts-ai';
import type { Candidate } from '@agentix-e/nl2charts-ai';
import { parseCapabilityOverrides } from '../eval/bird/run.js';
import { startEndpoint } from './helpers/endpoint.js';
import type { Endpoint } from './helpers/endpoint.js';

let endpoint: Endpoint | undefined;
afterEach(async () => {
  await endpoint?.close();
  endpoint = undefined;
});

const candidates: readonly Candidate[] = [
  { sql: 'SELECT 1', rows: 1, columns: 1, preview: '[[1]]' },
  { sql: 'SELECT 2', rows: 1, columns: 1, preview: '[[2]]' },
];

describe('capabilitiesOf', () => {
  it('reads a chat model as chat', () => {
    expect(capabilitiesOf('deepseek-chat')).toEqual(CHAT_CAPABILITIES);
  });

  it('reads a documented reasoning family as reasoning', () => {
    for (const model of ['deepseek-reasoner', 'o3-mini', 'qwq-32b', 'gemini-2.5-thinking', 'magistral-small', 'acme-r1']) {
      expect(capabilitiesOf(model).family, model).toBe('reasoning');
    }
  });

  it('does not read a model that merely mentions reasoning as reasoning', () => {
    // `reasoning` is not one of the tokens: a name that says it is about reasoning in prose is
    // not a protocol statement, and removing a parameter on that basis would be a guess.
    expect(capabilitiesOf('reasoning-notes-chat').family).toBe('chat');
  });

  it('lets a deployment override one field', () => {
    const declared = capabilitiesOf('private-prod-a', { family: 'reasoning' });
    expect(declared.family).toBe('reasoning');
    // A caller who says "reasoning" and leaves sampling alone would get the parameter back,
    // which is the whole defect. The derived fields follow the family.
    expect(declared.sampling).toBe('ignored');
    expect(declared.thinksAloud).toBe(true);
  });

  it('keeps an explicit sampling declaration even on a reasoning family', () => {
    const declared = capabilitiesOf('deepseek-reasoner', { sampling: 'honoured' });
    expect(declared.sampling).toBe('honoured');
  });

  it('returns a fresh object when overrides are given, so callers cannot mutate the defaults', () => {
    const declared = capabilitiesOf('deepseek-chat', { maxOutputTokens: 1024 });
    expect(declared).not.toBe(CHAT_CAPABILITIES);
    expect(CHAT_CAPABILITIES.maxOutputTokens).toBe(4096);
  });
});

describe('adaptRequest', () => {
  it('leaves a chat request byte-identical', () => {
    const adapted = adaptRequest({ messages: [{ role: 'user', content: 'q' }], temperature: 0, purpose: 'generate' }, CHAT_CAPABILITIES);
    expect(adapted.request).toEqual({ messages: [{ role: 'user', content: 'q' }], temperature: 0, purpose: 'generate' });
    expect(adapted.ignored).toEqual([]);
    // The default that was never a decision: a chat endpoint's own cap stays its own.
    expect(adapted.request.maxTokens).toBeUndefined();
  });

  it('drops a sampling parameter the endpoint ignores, and says so', () => {
    const adapted = adaptRequest({ messages: [{ role: 'user', content: 'q' }], temperature: 0 }, REASONING_CAPABILITIES);
    expect(adapted.request.temperature).toBeUndefined();
    expect(adapted.ignored).toEqual(['temperature']);
  });

  it('does not report a parameter that was already absent', () => {
    const adapted = adaptRequest({ messages: [{ role: 'user', content: 'q' }], temperature: null }, REASONING_CAPABILITIES);
    expect(adapted.request.temperature).toBeNull();
    expect(adapted.ignored).toEqual([]);
  });

  it('gives a reasoning endpoint an answer budget when the caller named none', () => {
    const adapted = adaptRequest({ messages: [{ role: 'user', content: 'q' }] }, REASONING_CAPABILITIES);
    expect(adapted.request.maxTokens).toBe(8192);
  });

  it('keeps the budget the caller named', () => {
    const adapted = adaptRequest({ messages: [{ role: 'user', content: 'q' }], maxTokens: 1024 }, REASONING_CAPABILITIES);
    expect(adapted.request.maxTokens).toBe(1024);
  });

  it('refuses JSON mode on an endpoint that does not serve it, naming the family', () => {
    expect(() => adaptRequest({ messages: [{ role: 'user', content: 'q' }], json: true }, REASONING_CAPABILITIES)).toThrow(
      /does not serve JSON mode \(model family: reasoning\)/,
    );
  });

  it('keeps JSON mode on a chat endpoint', () => {
    const adapted = adaptRequest({ messages: [{ role: 'user', content: 'q' }], json: true }, CHAT_CAPABILITIES);
    expect(adapted.request.json).toBe(true);
  });

  it('does not mutate the request it was given', () => {
    const request = { messages: [{ role: 'user' as const, content: 'q' }], temperature: 0 };
    adaptRequest(request, REASONING_CAPABILITIES);
    expect(request.temperature).toBe(0);
  });
});

describe('the provider on the wire', () => {
  it('omits temperature and sends the answer budget for a reasoning model', async () => {
    endpoint = await startEndpoint({ reply: () => 'SELECT 1' });
    const provider = createHttpProvider({ baseUrl: endpoint.url, model: 'deepseek-reasoner', apiKey: 'k' });
    const reply = await provider.complete({ messages: [{ role: 'user', content: 'q' }], temperature: 0 });
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]?.body.temperature).toBeUndefined();
    expect(endpoint.requests[0]?.body.max_tokens).toBe(8192);
    expect(reply.ignored).toEqual(['temperature']);
    expect(provider.capabilities?.family).toBe('reasoning');
  });

  it('keeps the chat request exactly as it was', async () => {
    endpoint = await startEndpoint({ reply: () => 'SELECT 1' });
    const provider = createHttpProvider({ baseUrl: endpoint.url, model: 'deepseek-chat', apiKey: 'k' });
    const reply = await provider.complete({ messages: [{ role: 'user', content: 'q' }], temperature: 0 });
    expect(endpoint.requests[0]?.body.temperature).toBe(0);
    expect(endpoint.requests[0]?.body.max_tokens).toBeUndefined();
    expect(reply.ignored).toBeUndefined();
  });

  it('counts what the endpoint dropped, so the report cannot claim the sampling regime', async () => {
    endpoint = await startEndpoint({ reply: () => 'SELECT 1' });
    const counter = withCallCounter(createHttpProvider({ baseUrl: endpoint.url, model: 'deepseek-reasoner', apiKey: 'k' }));
    await counter.provider.complete({ messages: [{ role: 'user', content: 'q' }], temperature: 0, purpose: 'generate' });
    await counter.provider.complete({ messages: [{ role: 'user', content: 'q' }], purpose: 'select' });
    expect(counter.omitted().get('temperature')).toBe(1);
    expect(counter.calls()).toBe(2);
  });

  it('counts nothing for a model that honours every field', async () => {
    endpoint = await startEndpoint({ reply: () => 'SELECT 1' });
    const counter = withCallCounter(createHttpProvider({ baseUrl: endpoint.url, model: 'deepseek-chat', apiKey: 'k' }));
    await counter.provider.complete({ messages: [{ role: 'user', content: 'q' }], temperature: 0 });
    expect(counter.omitted().size).toBe(0);
  });
});

describe('the selection format follows the judge', () => {
  it('asks a chat judge for one number and nothing else', () => {
    const prompt = buildSelectionPrompt('how many', candidates);
    expect(prompt).toContain('Answer with the number of the chosen candidate and nothing else.');
    expect(prompt).not.toContain('final line');
  });

  it('asks a reasoning judge to think, and fixes where the answer ends', () => {
    const prompt = buildSelectionPrompt('how many', candidates, { reasoning: true });
    expect(prompt).toContain('Think about which candidate answers the question');
    expect(prompt).toContain('alone on the final line');
    expect(prompt).not.toContain('and nothing else');
  });

  it('reads a reasoning reply from its last line, and only from there', () => {
    expect(parseReasonedChoice('2')).toBe(2);
    expect(parseReasonedChoice('Candidate 1 is wrong.\n2')).toBe(2);
    expect(parseReasonedChoice('2\nbecause the second returns what was asked')).toBeNull();
    expect(parseReasonedChoice('   ')).toBeNull();
  });

  it('applies the reasoning reader only when the arm asked for it', () => {
    expect(applySelection('The second is right.\n2', candidates, { reasoning: true })).toEqual({ index: 1, decided: true });
    // The default reader is the strict one every published reading was taken with: prose is
    // still not a choice, and the fallback to index 0 is reported as undecided.
    expect(applySelection('The second is right.\n2', candidates)).toEqual({ index: 0, decided: false });
  });
});

describe('parseCapabilityOverrides', () => {
  it('treats an absent or empty declaration as none', () => {
    expect(parseCapabilityOverrides(undefined, 'X')).toBeUndefined();
    expect(parseCapabilityOverrides('  ', 'X')).toBeUndefined();
  });

  it('refuses a declaration that is not JSON', () => {
    expect(() => parseCapabilityOverrides('{', 'BIRD_SECOND_CAPABILITIES')).toThrow(/is not JSON/);
  });

  it('refuses a JSON value that is not an object', () => {
    expect(() => parseCapabilityOverrides('[1,2]', 'X')).toThrow(/must be a JSON object/);
    expect(() => parseCapabilityOverrides('null', 'X')).toThrow(/must be a JSON object/);
  });

  it('refuses a family it does not know', () => {
    expect(() => parseCapabilityOverrides('{"family":"reason"}', 'X')).toThrow(/family must be "chat" or "reasoning"/);
  });

  it('refuses a sampling rule it does not know', () => {
    expect(() => parseCapabilityOverrides('{"sampling":"maybe"}', 'X')).toThrow(/sampling must be "honoured" or "ignored"/);
  });

  it('passes a well-formed declaration through, including fields it does not own', () => {
    expect(parseCapabilityOverrides('{"family":"reasoning","vendor":"acme"}', 'X')).toEqual({ family: 'reasoning', vendor: 'acme' });
  });
});
