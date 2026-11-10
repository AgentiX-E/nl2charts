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
import { createProviders, parseCapabilityOverrides, resolveSettings } from '../eval/bird/run.js';
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
    // And so do the two fields that are not covered by the sentence above, which is how they
    // came to be wrong: the record said `family: reasoning` while carrying the chat endpoint's
    // JSON mode and half its documented answer budget. A declaration that names the family has
    // to take the family's whole row, not one field of it.
    expect(declared.jsonMode).toBe(false);
    expect(declared.maxOutputTokens).toBe(REASONING_CAPABILITIES.maxOutputTokens);
  });

  it('derives the rest of the row from the declared family even when the name says nothing', () => {
    // The declaration is the only thing a self-hosted endpoint has: `private-prod-a` cannot be
    // read by name, and the two-field declaration below is the natural way to write it. Before
    // this case existed it produced `thinksAloud: false` beside `jsonMode: true` — the chat
    // judge format and a JSON mode the endpoint does not serve — so declaring more was worse
    // than declaring less.
    const declared = capabilitiesOf('private-prod-a', { family: 'reasoning', sampling: 'ignored' });
    expect(declared).toEqual(REASONING_CAPABILITIES);
    // A deployment that knows its own ceiling still wins over the family default.
    expect(capabilitiesOf('private-prod-a', { family: 'reasoning', maxOutputTokens: 32768 }).maxOutputTokens).toBe(32768);
  });

  it('reads a chat family declared over a reasoning-looking name as chat', () => {
    // The name heuristic is a guess and the declaration is not; when they disagree the
    // declaration is the one that was meant. `deepseek-reasoner` served behind a chat-shaped
    // proxy is the case: sampling applies there, and the answer budget is the proxy's.
    const declared = capabilitiesOf('deepseek-reasoner', { family: 'chat' });
    expect(declared.family).toBe('chat');
    expect(declared.jsonMode).toBe(true);
    expect(declared.thinksAloud).toBe(false);
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

  it('refuses to send a thinking switch to an endpoint that never declared one', () => {
    // The switch is a request field only some endpoints serve, and the two failure modes are
    // both silent: an endpoint that ignores it answers 200 and the report prints a mode nobody
    // ran, and one that rejects it answers 400 that reads as a bad key. Neither is a guess this
    // repository is entitled to make on a model name, so the default is "not served" and the
    // removal is counted exactly like a dropped sampling parameter.
    const adapted = adaptRequest({ messages: [{ role: 'user', content: 'q' }], thinking: true }, REASONING_CAPABILITIES);
    expect(adapted.request.thinking).toBeUndefined();
    expect(adapted.ignored).toEqual(['thinking']);
    const silent = adaptRequest({ messages: [{ role: 'user', content: 'q' }], thinking: false }, { ...CHAT_CAPABILITIES, thinkingSwitch: true });
    expect(silent.request.thinking).toBe(false);
    expect(silent.ignored).toEqual([]);
  });

  it('reports a thinking switch the endpoint does not serve only when one was asked for', () => {
    // `undefined` is "this deployment said nothing" and must stay byte-identical to a request
    // written before the field existed; otherwise every published reading changes shape.
    const quiet = adaptRequest({ messages: [{ role: 'user', content: 'q' }] }, { ...CHAT_CAPABILITIES, thinkingSwitch: false });
    expect(quiet.ignored).toEqual([]);
    expect('thinking' in quiet.request).toBe(false);
    const asked = adaptRequest({ messages: [{ role: 'user', content: 'q' }], thinking: false }, { ...CHAT_CAPABILITIES, thinkingSwitch: false });
    expect(asked.ignored).toEqual(['thinking']);
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

/**
 * The declaration has to reach the provider the run actually builds.
 *
 * Everything above tests a provider handed to a function by a test. Production builds it in
 * `createProviders` from `resolveSettings`, and until this block existed nothing asserted that
 * those two steps carried `capabilities` across. A contract that is honoured in a test and
 * dropped at the one call site that matters is exactly the failure this round is about: the
 * declaration is a property of the endpoint, and an endpoint assembled without it is the
 * pipeline this round set out to fix.
 */
describe('the declaration the run hands its second provider', () => {
  const SECOND = { BIRD_SECOND_MODEL: 'glm-5', BIRD_SECOND_API_KEY: 'k', BIRD_SECOND_BASE_URL: 'http://127.0.0.1:1/v1' };

  it('carries a declared family from the environment onto the provider', () => {
    const settings = resolveSettings(
      { ...SECOND, BIRD_SECOND_CAPABILITIES: '{"family":"reasoning","sampling":"ignored"}' },
      [],
      '/repo',
    );
    expect(settings.second.capabilities).toEqual({ family: 'reasoning', sampling: 'ignored' });
    // The whole row, not the two fields that were typed: the provider is what `adaptRequest`
    // reads, and reading `family` off a record that also says `jsonMode: true` is how a request
    // to a reasoning endpoint came to carry a JSON mode it does not serve.
    expect(createProviders(settings).second?.capabilities).toEqual(REASONING_CAPABILITIES);
  });

  it('falls back to the model name when nothing was declared, and says nothing it was not told', () => {
    // Absent in the settings is "the deployment did not say"; the provider still declares a row,
    // because a request that was sent has a shape. Which row it is comes from the name — the
    // documented guess — and the settings object must not invent one of its own.
    const named = resolveSettings({ ...SECOND, BIRD_SECOND_MODEL: 'deepseek-reasoner' }, [], '/repo');
    expect(named.second.capabilities).toBeUndefined();
    expect(createProviders(named).second?.capabilities).toEqual(REASONING_CAPABILITIES);
    const plain = resolveSettings({ ...SECOND, BIRD_SECOND_MODEL: 'some-chat-model' }, [], '/repo');
    expect(createProviders(plain).second?.capabilities).toEqual(CHAT_CAPABILITIES);
  });
});

/**
 * The same declaration, for the endpoint the run was actually pointed at.
 *
 * The block above exists because a declaration honoured in a test and dropped at the one call site
 * that matters is the failure mode of a contract. That block was written for the *second* provider
 * and the primary one was left out, which is the same defect one level over: a caller pointing the
 * harness at a reasoning endpoint had no way to say so, and the name is the only thing left to
 * guess from.
 *
 * `glm-4.6` is what that costs. Its name matches none of the documented families, so it is read as
 * a chat model: sampling sent, 4,096-token answer budget, no thinking switch — and a request shaped
 * for a model that answers immediately, sent to one that deliberates first. `42723786747` stopped at
 * 59.3% failures with answers arriving in 8.5 seconds, which is the shape of an empty completion
 * rather than a slow one.
 */
describe('the declaration the run hands its primary provider', () => {
  const PRIMARY = { LLM_MODEL: 'glm-4.6', LLM_API_KEY: 'k', LLM_BASE_URL: 'http://127.0.0.1:1/v1' };

  it('carries a declared family from the environment onto the provider', () => {
    const settings = resolveSettings({ ...PRIMARY, BIRD_CAPABILITIES: '{"family":"reasoning","maxOutputTokens":16384}' }, [], '/repo');
    expect(settings.capabilities).toEqual({ family: 'reasoning', maxOutputTokens: 16384 });
    // The whole row, not the two fields that were typed: `adaptRequest` reads the row, and a row
    // assembled from the chat base beside a declared reasoning family contradicts itself.
    expect(createProviders(settings).provider.capabilities).toEqual({ ...REASONING_CAPABILITIES, maxOutputTokens: 16384 });
  });

  it('refuses a declaration it cannot read instead of guessing', () => {
    // The same rule as the second provider's: a typo must not fall back to the guess, because the
    // guess is what the declaration exists to replace.
    expect(() => resolveSettings({ ...PRIMARY, BIRD_CAPABILITIES: '{' }, [], '/repo')).toThrow(/is not JSON/);
    expect(() => resolveSettings({ ...PRIMARY, BIRD_CAPABILITIES: '{"family":"reasoner"}' }, [], '/repo')).toThrow(/family/);
  });

  it('guesses from the name when nothing was declared, and reads glm-4.6 as a chat model', () => {
    // The guess is documented and unchanged: a wrong guess in the chat direction sends a parameter
    // the endpoint ignores, and this test pins which way the guess goes so that a later widening of
    // the name pattern is a decision rather than a drift.
    expect(createProviders(resolveSettings(PRIMARY, [], '/repo')).provider.capabilities).toEqual(CHAT_CAPABILITIES);
    const reasoner = createProviders(resolveSettings({ ...PRIMARY, LLM_MODEL: 'deepseek-reasoner' }, [], '/repo'));
    expect(reasoner.provider.capabilities).toEqual(REASONING_CAPABILITIES);
  });
});
