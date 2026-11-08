/**
 * The base model, as a digest that can be wrong.
 *
 * Every fixture here is a hand-written answer set, because the thing under test is what a digest
 * *does* to answers — and the four interesting answers are the ones an endpoint actually gives:
 * the same text twice, two different texts, one text and one refusal, and two refusals. The
 * endpoint itself is `createHttpProvider` with a scripted `fetch`, which is the same seam the
 * provider's own tests use: what is being checked is the whole path from a request to a reading,
 * not a stub standing in for it.
 */
import { describe, expect, it } from 'vitest';
import { createHttpProvider } from '@agentix-e/nl2charts-ai';
import { attachFingerprint } from '../eval/bird/run.js';
import {
  FINGERPRINT_PROBES,
  fingerprintLine,
  normaliseAnswer,
  probeBase,
  probeSetDigest,
  readFingerprint,
} from '../eval/bird/fingerprint.js';
import type { ProbeDraw } from '../eval/bird/fingerprint.js';

/** One probe asked `draws` times, each answer paired with the base that gave it. */
function asked(id: string, answers: readonly string[], model = 'deepseek-flash'): ProbeDraw {
  return { id, replies: answers.map((text) => ({ text, model })) };
}

/** A chat-completions body, as the endpoint writes one. */
function body(content: string, model = 'deepseek-flash'): string {
  return JSON.stringify({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    model,
    usage: { prompt_tokens: 12, completion_tokens: 2 },
  });
}

interface Scripted {
  readonly fetchImpl: typeof fetch;
  readonly asked: string[];
}

/**
 * An endpoint that answers the 7th prime with `prime`, the letter count with `letter`, and one
 * seventh with `seventh`, in that order of use.
 *
 * The queue is per-answer rather than per-call so a test can make the second draw differ without
 * knowing how many calls came before it.
 */
function endpoint(answers: { prime?: string[]; letter?: string[]; seventh?: string[]; model?: string }): Scripted {
  const queues = {
    prime: [...(answers.prime ?? ['17'])],
    letter: [...(answers.letter ?? ['4'])],
    seventh: [...(answers.seventh ?? ['14285714'])],
  };
  const asked: string[] = [];
  const fetchImpl = (async (_url: string, init: { body?: string }) => {
    const payload = JSON.parse(String(init.body ?? '{}')) as { messages?: { content?: string }[] };
    const question = payload.messages?.[0]?.content ?? '';
    asked.push(question);
    const queue = question.includes('7th prime') ? queues.prime : question.includes('letter s') ? queues.letter : queues.seventh;
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    return new Response(body(answer ?? '', answers.model ?? 'deepseek-flash'), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

function providerFor(scripted: Scripted, model = 'deepseek-chat') {
  return createHttpProvider({ baseUrl: 'https://example.test/v1', model, fetchImpl: scripted.fetchImpl, retries: 1, retryDelayMs: 0 });
}

describe('normaliseAnswer', () => {
  it('collapses whitespace runs and trims the ends', () => {
    expect(normaliseAnswer('  14285714 \n')).toBe('14285714');
    expect(normaliseAnswer('The 7th prime\n\n  is 17.')).toBe('The 7th prime is 17.');
  });

  it('keeps case and punctuation, because they are part of the answer', () => {
    expect(normaliseAnswer('17')).toBe('17');
    expect(normaliseAnswer('17.')).toBe('17.');
    expect(normaliseAnswer('Seventeen')).toBe('Seventeen');
  });

  it('turns a blank answer into the empty string rather than into a space', () => {
    expect(normaliseAnswer('  \n\t ')).toBe('');
  });
});

describe('probeSetDigest', () => {
  it('is stable across calls and does not depend on object identity', () => {
    expect(probeSetDigest()).toBe(probeSetDigest([...FINGERPRINT_PROBES]));
  });

  it('moves when a question moves, which is the reason it is recorded at all', () => {
    const edited = FINGERPRINT_PROBES.map((probe) => (probe.id === 'letter-count' ? { ...probe, ask: `${probe.ask} Be sure.` } : probe));
    expect(probeSetDigest(edited)).not.toBe(probeSetDigest());
  });

  it('is 16 hex characters, the same width as the corpus digest', () => {
    expect(probeSetDigest()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('readFingerprint', () => {
  it('reads three probes answered twice as one stable digest over three questions', () => {
    const reading = readFingerprint([asked('a', ['17', '17']), asked('b', ['4', '4']), asked('c', ['14285714', '14285714'])]);
    expect(reading.probes).toBe(3);
    expect(reading.draws).toBe(2);
    expect(reading.stable).toBe(true);
    expect(reading.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(reading.unstable).toEqual([]);
    expect(reading.empty).toEqual([]);
    expect(reading.bases).toEqual(['deepseek-flash']);
  });

  it('is a function of the answers and not of the order they were asked in', () => {
    const forward = readFingerprint([asked('a', ['17']), asked('b', ['4'])]);
    const backward = readFingerprint([asked('b', ['4']), asked('a', ['17'])]);
    expect(forward.digest).toBe(backward.digest);
  });

  it('reports a probe whose two draws differ as unstable, and names it', () => {
    const reading = readFingerprint([asked('a', ['17', '17']), asked('b', ['4', 'four']), asked('c', ['14285714', '14285714'])]);
    expect(reading.stable).toBe(false);
    expect(reading.unstable).toEqual(['b']);
    // The digest still exists — the first non-empty answer is what it hashes — but it is no longer
    // a fingerprint, and `stable` is the field every consumer reads before comparing it.
    expect(reading.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(reading.probes).toBe(3);
  });

  it('counts a probe that answered once and then not at all as unstable rather than as absent', () => {
    const reading = readFingerprint([asked('a', ['17', '  '])]);
    expect(reading.probes).toBe(1);
    expect(reading.unstable).toEqual(['a']);
    expect(reading.empty).toEqual([]);
  });

  it('excludes a probe that never answered from the digest and from the count', () => {
    const reading = readFingerprint([asked('a', ['17', '17']), asked('b', ['', ''])]);
    expect(reading.probes).toBe(1);
    expect(reading.empty).toEqual(['b']);
    expect(reading.stable).toBe(true);
  });

  it('has no digest at all when no probe answered, and says so with a count of zero', () => {
    const reading = readFingerprint([asked('a', []), asked('b', [''])]);
    expect(reading.digest).toBe('');
    expect(reading.probes).toBe(0);
    expect(reading.draws).toBe(1);
    expect(reading.stable).toBe(false);
    expect(reading.empty).toEqual(['a', 'b']);
  });

  it('carries nothing when there is nothing to read', () => {
    const reading = readFingerprint([]);
    expect(reading).toEqual({
      digest: '',
      probes: 0,
      total: 3,
      draws: 0,
      stable: false,
      unstable: [],
      empty: [],
      bases: [],
      probeSet: probeSetDigest(),
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      unbilled: 0,
      failures: [],
    });
  });

  it('unions the bases that actually answered, sorted, and ignores the ones that said nothing', () => {
    const reading = readFingerprint([
      { id: 'a', replies: [{ text: '17', model: 'zulu' }, { text: '17', model: 'alpha' }] },
      { id: 'b', replies: [{ text: '', model: 'never-answered' }] },
    ]);
    expect(reading.bases).toEqual(['alpha', 'zulu']);
  });

  it('reports what the probes cost when someone counted, and zero when nobody did', () => {
    const counted = readFingerprint([asked('a', ['17'])], {
      calls: 6,
      promptTokens: 72,
      completionTokens: 12,
      unbilled: 1,
      failures: ['b: timed out'],
    });
    expect([counted.calls, counted.promptTokens, counted.completionTokens, counted.unbilled]).toEqual([6, 72, 12, 1]);
    expect(counted.failures).toEqual(['b: timed out']);
    expect(readFingerprint([asked('a', ['17'])]).calls).toBe(0);
  });

  it('copies the failure list rather than aliasing the caller\'s array', () => {
    const failures: string[] = ['a: boom'];
    const reading = readFingerprint([asked('a', ['17'])], { failures });
    failures.push('b: boom');
    expect(reading.failures).toEqual(['a: boom']);
  });
});

describe('probeBase', () => {
  it('asks every probe twice at temperature zero and reads the answers', async () => {
    const scripted = endpoint({});
    const reading = await probeBase(providerFor(scripted));
    expect(scripted.asked).toHaveLength(6);
    expect(scripted.asked.filter((question) => question.includes('7th prime'))).toHaveLength(2);
    expect(reading.probes).toBe(3);
    expect(reading.draws).toBe(2);
    expect(reading.stable).toBe(true);
    expect(reading.calls).toBe(6);
    expect(reading.bases).toEqual(['deepseek-flash']);
    expect(reading.failures).toEqual([]);
    // The digest is the same one the same answers produce by hand: the endpoint is a seam, not a
    // second implementation of the reading.
    expect(reading.digest).toBe(readFingerprint([asked('letter-count', ['4', '4']), asked('one-seventh', ['14285714', '14285714']), asked('seventh-prime', ['17', '17'])]).digest);
  });

  it('records what the probes cost, so six calls do not vanish from the bill', async () => {
    const reading = await probeBase(providerFor(endpoint({})));
    expect(reading.promptTokens).toBe(72);
    expect(reading.completionTokens).toBe(12);
  });

  it('calls a base that answers differently on the second draw unstable', async () => {
    const reading = await probeBase(providerFor(endpoint({ letter: ['4', 'four'] })));
    expect(reading.stable).toBe(false);
    expect(reading.unstable).toEqual(['letter-count']);
  });

  it('keeps going when a call fails, and reports the failure against the probe it belonged to', async () => {
    let call = 0;
    const fetchImpl = (async (_url: string, init: { body?: string }) => {
      call += 1;
      const payload = JSON.parse(String(init.body ?? '{}')) as { messages?: { content?: string }[] };
      if ((payload.messages?.[0]?.content ?? '').includes('letter s')) return new Response('nope', { status: 500 });
      return new Response(body('17'), { status: 200 });
    }) as unknown as typeof fetch;
    const reading = await probeBase(createHttpProvider({ baseUrl: 'https://example.test/v1', model: 'm', fetchImpl, retries: 1, retryDelayMs: 0 }));
    expect(call).toBe(6);
    expect(reading.failures).toHaveLength(2);
    expect(reading.failures[0]).toContain('letter-count');
    expect(reading.empty).toEqual(['letter-count']);
    // Two questions still answered, so the digest is over two — which the gate reads as a
    // different probe set rather than as a changed model.
    expect(reading.probes).toBe(2);
    expect(reading.stable).toBe(true);
  });

  it('takes one draw when asked for one, and then has nothing to check it against', async () => {
    const scripted = endpoint({});
    const reading = await probeBase(providerFor(scripted), { draws: 1 });
    expect(scripted.asked).toHaveLength(3);
    expect(reading.draws).toBe(1);
    expect(reading.stable).toBe(true);
  });

  it('never asks fewer than one draw, whatever the caller passes', async () => {
    const scripted = endpoint({});
    const reading = await probeBase(providerFor(scripted), { draws: 0 });
    expect(scripted.asked).toHaveLength(3);
    expect(reading.draws).toBe(1);
  });

  it('asks the probes it was handed, which is how a test states its own question set', async () => {
    const scripted = endpoint({});
    const reading = await probeBase(providerFor(scripted), { probes: [{ id: 'only', ask: 'Which number is the 7th prime? Answer with the number only.' }], draws: 1 });
    expect(scripted.asked).toHaveLength(1);
    expect(reading.probes).toBe(1);
    // The probe-set digest follows the caller's set, so a narrowed run cannot be compared with a
    // pin taken over the standard three.
    expect(reading.probeSet).not.toBe(probeSetDigest());
  });
});

describe('attachFingerprint', () => {
  it('puts the reading on the report before any arm runs, and says it out loud', async () => {
    const report: Record<string, unknown> = { split: 'minidev' };
    const said: string[] = [];
    await attachFingerprint(report, providerFor(endpoint({})), (line) => said.push(line));
    const reading = report.baseFingerprint as { digest: string; probes: number };
    expect(reading.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(reading.probes).toBe(3);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('base fingerprint');
  });

  it('still writes the key when every probe failed, so the gate can see the absence', async () => {
    const report: Record<string, unknown> = {};
    const dead = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    await attachFingerprint(report, createHttpProvider({ baseUrl: 'https://example.test/v1', model: 'm', fetchImpl: dead, retries: 1, retryDelayMs: 0 }), () => {});
    const reading = report.baseFingerprint as { digest: string; probes: number; failures: string[] };
    expect(reading.digest).toBe('');
    expect(reading.probes).toBe(0);
    expect(reading.failures).toHaveLength(6);
  });
});

describe('fingerprintLine', () => {
  const base = readFingerprint([asked('a', ['17', '17']), asked('b', ['4', '4']), asked('c', ['14285714', '14285714'])], { calls: 6 });

  it('states the digest, the probe count, the draws and the base that answered', () => {
    const line = fingerprintLine(base);
    expect(line).toContain(base.digest);
    expect(line).toContain('3 probe(s) x 2 draws');
    expect(line).toContain('stable');
    expect(line).toContain('served by deepseek-flash');
    expect(line).toContain('6 calls');
  });

  it('says how many of the standard probes were read when some answered nothing', () => {
    const line = fingerprintLine(readFingerprint([asked('a', ['17', '17']), asked('b', ['', ''])], { calls: 6 }));
    expect(line).toContain('over 1 probe(s) x 2 draws, of 3');
  });

  it('refuses to call an unstable digest a fingerprint, in the same sentence', () => {
    const line = fingerprintLine(readFingerprint([asked('a', ['17', '17']), asked('b', ['4', 'four'])]));
    expect(line).toContain('unstable on b');
    expect(line).toContain('a draw and not a fingerprint');
  });

  it('reports a run whose probes all failed with the first failure as the reason', () => {
    const line = fingerprintLine(readFingerprint([asked('a', [])], { failures: ['a: llm returned 500'] }));
    expect(line).toBe('base fingerprint: none — 0 of 3 probes answered (a: llm returned 500)');
  });

  it('distinguishes an endpoint that answered nothing from one that could not be reached', () => {
    expect(fingerprintLine(readFingerprint([asked('a', [''])], { calls: 3 }))).toContain('every probe answered nothing');
  });
});
