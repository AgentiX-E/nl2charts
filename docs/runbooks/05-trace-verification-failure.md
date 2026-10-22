# 5. Trace verification failure

## Symptom

```ts
verifyTrace(trace);
// { ok: false, brokenAt: 1, reason: 'hash' }
```

## What it means

| `reason` | Meaning | Likely cause |
| --- | --- | --- |
| `hash` | an event's content changed | a transform rewrote the trace, or it was edited by hand |
| `link` | an event's `prev` no longer points at its predecessor | events were reordered or spliced |
| `head` | the chain does not end at the recorded head | events were dropped or appended |

`replayTrace` refuses a broken trace and returns no timeline, which is deliberate:
a summary of an edited trace is an edited summary.

## Do this

1. **Use `brokenAt`.** Everything before that index verifies; the incident is at
   that event.
2. **Check for a JSON round trip.** Encoding and decoding used to break verification
   before the canonical form was introduced; if a middleware re-serialises events,
   make sure it does not reorder keys or introduce `undefined`.
3. **Do not re-seal a trace to "fix" it.** Sealing is what makes it evidence; a
   re-sealed trace is a new claim, not a repaired one.
4. **If the trace must resist forgery**, verify with an HMAC signer. The default is
   FNV-1a: it detects an edit, it does not stop someone who recomputes the chain.

## Drill

`test/runbooks.test.ts` → *runbook: trace verification failure* edits one duration
and asserts `reason: 'hash'`, `brokenAt: 1`, and an empty timeline.
