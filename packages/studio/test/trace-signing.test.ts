import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { replayTrace, sealTrace, verifyTrace } from '../src/index.js';
import type { TraceEvent } from '../src/index.js';

const events: TraceEvent[] = [
  { name: 'guard', startMs: 0, endMs: 2 },
  { name: 'execute', startMs: 2, endMs: 40, attrs: { 'nl2charts.rows': 3 } },
];

const hmac = (key: string) => (payload: string): string =>
  createHmac('sha256', key).update(payload).digest('hex').slice(0, 32);

describe('signing a trace', () => {
  it('verifies under the signer that sealed it', () => {
    const sealed = sealTrace(events, { sign: hmac('k1') });
    expect(verifyTrace(sealed, { sign: hmac('k1') })).toEqual({ ok: true, count: 2 });
  });

  it('rejects a trace sealed with a different key', () => {
    const sealed = sealTrace(events, { sign: hmac('k1') });
    const verdict = verifyTrace(sealed, { sign: hmac('k2') });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected a broken trace');
    expect(verdict.reason).toBe('hash');
    expect(verdict.brokenAt).toBe(0);
  });

  it('rejects a forger who recomputed the default FNV chain', () => {
    // This is the difference between detecting an edit and resisting one: a
    // trace re-sealed with the default signer verifies by default and fails the
    // moment a verifier checks it with a key the forger does not have.
    const forged = sealTrace([{ name: 'execute', startMs: 0, endMs: 1 }]);
    expect(verifyTrace(forged).ok).toBe(true);
    expect(verifyTrace(forged, { sign: hmac('k1') }).ok).toBe(false);
  });

  it('replays with the same signer, so a rejected chain has no timeline', () => {
    const sealed = sealTrace(events, { sign: hmac('k1') });
    const replay = replayTrace(sealed, { sign: hmac('k2') });
    expect(replay.ok).toBe(false);
    expect(replay.stages).toEqual([]);
    expect(replay.errors[0]).toContain('hash');
  });

  it('keeps the default signer when no options are given', () => {
    expect(verifyTrace(sealTrace(events))).toEqual({ ok: true, count: 2 });
  });
});
