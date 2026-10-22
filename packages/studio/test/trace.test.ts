import { describe, expect, it } from 'vitest';
import { buildIssueList, canonicalJson, hashEvent, replayTrace, sealTrace, validateModel, verifyTrace } from '../src/index.js';
import type { TraceEvent } from '../src/index.js';

const events: TraceEvent[] = [
  { name: 'guard', startMs: 0, endMs: 2, status: 'ok', attrs: { 'nl2charts.rows': 0 } },
  { name: 'compile', startMs: 2, endMs: 9, status: 'ok' },
  { name: 'execute', startMs: 9, endMs: 41, status: 'ok', attrs: { 'nl2charts.rows': 239 } },
];

describe('trace sealing', () => {
  it('chains each event to the one before it', () => {
    const sealed = sealTrace(events);
    expect(sealed.events).toHaveLength(3);
    expect(sealed.events[0]?.prev).toBe('genesis');
    expect(sealed.events[1]?.prev).toBe(sealed.events[0]?.hash);
    expect(sealed.events[2]?.prev).toBe(sealed.events[1]?.hash);
    expect(sealed.head).toBe(sealed.events[2]?.hash);
  });

  it('accepts the trace it just sealed', () => {
    expect(verifyTrace(sealTrace(events))).toEqual({ ok: true, count: 3 });
  });

  it('detects an edited event and says which one', () => {
    const sealed = sealTrace(events);
    const tampered = {
      ...sealed,
      events: sealed.events.map((event, index) => (index === 1 ? { ...event, endMs: 10 } : event)),
    };
    const verdict = verifyTrace(tampered);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected a broken trace');
    expect(verdict.brokenAt).toBe(1);
    expect(verdict.reason).toBe('hash');
  });

  it('detects a removed event, because the chain no longer reaches the head', () => {
    const sealed = sealTrace(events);
    const shorter = { ...sealed, events: sealed.events.slice(0, 2) };
    const verdict = verifyTrace(shorter);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected a broken trace');
    expect(verdict.reason).toBe('head');
  });

  it('detects an event appended without re-sealing', () => {
    const sealed = sealTrace(events);
    const forged = { name: 'forged', startMs: 41, endMs: 42, prev: sealed.head, hash: 'deadbeef' };
    expect(verifyTrace({ ...sealed, events: [...sealed.events, forged] }).ok).toBe(false);
  });

  it('hashes the same event the same way on every call and every key order', () => {
    const left: TraceEvent = { name: 'a', startMs: 1, endMs: 2, attrs: { b: 2, a: 1 } };
    const right: TraceEvent = { name: 'a', startMs: 1, endMs: 2, attrs: { a: 1, b: 2 } };
    expect(hashEvent('genesis', left)).toBe(hashEvent('genesis', right));
    expect(canonicalJson({ b: 2, a: [1, { d: 4, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":4}],"b":2}');
  });
});

describe('trace replay', () => {
  it('summarises the run without reading the wall clock', () => {
    const replay = replayTrace(sealTrace(events));
    expect(replay.ok).toBe(true);
    expect(replay.durationMs).toBe(41);
    expect(replay.stages.map((stage) => stage.name)).toEqual(['guard', 'compile', 'execute']);
    expect(replay.slowest?.name).toBe('execute');
    expect(replay.errors).toEqual([]);
  });

  it('is deterministic: the same trace replays to the same summary', () => {
    const sealed = sealTrace(events);
    expect(replayTrace(sealed)).toEqual(replayTrace(sealed));
  });

  it('reports a broken trace instead of a timeline', () => {
    const sealed = sealTrace(events);
    const replay = replayTrace({ ...sealed, head: 'deadbeef' });
    expect(replay.ok).toBe(false);
    expect(replay.stages).toEqual([]);
    expect(replay.errors[0]).toContain('head');
  });

  it('handles an empty trace without inventing a duration', () => {
    const replay = replayTrace(sealTrace([]));
    expect(replay.ok).toBe(true);
    expect(replay.durationMs).toBe(0);
    expect(replay.stages).toEqual([]);
  });

  it('lists failing events with their attrs so a reader can see the cause', () => {
    const failing: TraceEvent[] = [
      { name: 'guard', startMs: 0, endMs: 1, status: 'ok' },
      { name: 'execute', startMs: 1, endMs: 3, status: 'error', attrs: { 'nl2charts.error': 'NL2C_E_GUARD_REJECTED' } },
    ];
    const replay = replayTrace(sealTrace(failing));
    expect(replay.errors).toEqual(['execute: NL2C_E_GUARD_REJECTED']);
    expect(replay.stages.find((stage) => stage.name === 'execute')?.status).toBe('error');
  });
});

describe('issue list', () => {
  it('orders errors before warnings and groups counts by code', () => {
    const list = buildIssueList([
      { severity: 'warn', code: 'missing-rationale', message: 'b' },
      { severity: 'error', code: 'missing-expr', message: 'a' },
      { severity: 'warn', code: 'missing-rationale', message: 'c' },
    ]);
    expect(list.items.map((item) => item.message)).toEqual(['a', 'b', 'c']);
    expect(list.counts).toEqual({ error: 1, warn: 2 });
    expect(list.byCode).toEqual({ 'missing-rationale': 2, 'missing-expr': 1 });
    expect(list.blocking).toBe(true);
  });

  it('is not blocking when there are only warnings', () => {
    const list = buildIssueList([{ severity: 'warn', code: 'missing-grain', message: 'x' }]);
    expect(list.blocking).toBe(false);
  });

  it('is an empty, non-blocking list for a clean model', () => {
    expect(buildIssueList([])).toEqual({ items: [], counts: { error: 0, warn: 0 }, byCode: {}, blocking: false });
  });
});

describe('canonical form', () => {
  it('handles primitives and null without pretending they are objects', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(7)).toBe('7');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(true)).toBe('true');
  });

  it('sorts keys in both directions', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 1 })).toBe('{"a":1}');
  });

  it('drops undefined values rather than writing them as null', () => {
    // A key that was never set and a key set to undefined are the same event; a
    // hash that distinguished them would fail on any JSON round trip.
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('chain diagnostics', () => {
  it('says the link is broken when prev does not point at the previous hash', () => {
    const sealed = sealTrace(events);
    const rewritten = sealed.events.map((event, index) =>
      index === 1 ? { ...event, prev: 'not-the-previous-hash' } : event,
    );
    const verdict = verifyTrace({ ...sealed, events: rewritten });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected a broken trace');
    expect(verdict.reason).toBe('link');
    expect(verdict.brokenAt).toBe(1);
  });

  it('treats a missing status as ok in both the hash and the timeline', () => {
    const sealed = sealTrace([{ name: 'compile', startMs: 0, endMs: 4 }]);
    expect(sealed.events[0]?.status).toBeUndefined();
    expect(verifyTrace(sealed).ok).toBe(true);
    expect(replayTrace(sealed).stages[0]?.status).toBe('ok');
  });

  it('picks the first of two equally slow stages rather than flipping a coin', () => {
    const sealed = sealTrace([
      { name: 'a', startMs: 0, endMs: 10 },
      { name: 'b', startMs: 10, endMs: 20 },
    ]);
    expect(replayTrace(sealed).slowest?.name).toBe('a');
  });

  it('names a failing stage without a code instead of printing undefined', () => {
    const sealed = sealTrace([
      { name: 'execute', startMs: 0, endMs: 3, status: 'error' },
      { name: 'guard', startMs: 3, endMs: 4, status: 'error', attrs: { 'nl2charts.error': 42 } },
    ]);
    expect(replayTrace(sealed).errors).toEqual(['execute: failed', 'guard: failed']);
  });
});

describe('relationship diagnostics', () => {
  it('does not report unknown endpoints when the model lists no tables', () => {
    // With no table list there is nothing to be unknown; reporting every endpoint
    // as unknown would make the smallest model the noisiest one.
    const diagnostics = validateModel({
      metrics: [{ name: 'revenue', expr: 'sum(amount)', table: 'orders', grain: ['order_id'], rationale: 'why' }],
      relationships: [{ from: 'orders', to: 'customers', on: 'orders.customer_id = customers.customer_id' }],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('relationship-endpoint-unknown');
  });
});
