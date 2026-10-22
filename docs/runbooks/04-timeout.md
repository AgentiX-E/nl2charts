# 4. Timeout

## Symptom

```
NL2C_E_TIMEOUT: query aborted
```

## What it means

The runner raced the engine against its own abort signal and the signal won. This
happens for three reasons: the statement exceeded `timeoutMs`, the caller aborted,
or the engine ignored the abort and the race had to break the tie.

## Do this

1. **Distinguish the two timeouts.** A caller-supplied `signal` that was already
   aborted fails immediately without touching the engine; a statement timeout fails
   after `timeoutMs`. The first is a bug in the caller, the second is a slow query.
2. **Look at the trace before the query.** A timeout on a statement that used to be
   fast is usually a missing index or a plan change; `replayTrace` shows which stage
   grew.
3. **Do not raise `timeoutMs` first.** Raise it after you know the query is
   legitimately long; otherwise the next incident is the same query holding a
   connection for longer.
4. **A timed-out statement may still be running in the database.** The library
   aborts the client; PostgreSQL needs `statement_timeout` on the session for the
   server side, which is a deployment concern, not a library one.

## Drill

`test/runbooks.test.ts` → *runbook: timeout* aborts a signal before the call and
asserts `NL2C_E_TIMEOUT` without touching the engine.
