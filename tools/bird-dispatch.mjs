#!/usr/bin/env node
/**
 * Dispatch a BIRD run without killing whatever is already running.
 *
 * `bird-dev`, `bird-model` and `ci`'s Mini-Dev job share one concurrency group (`bird-eval`)
 * because they draw on the same provider quota and write the same artifact path. The group does
 * not cancel — every workflow sets `cancel-in-progress: false` — but a dispatcher that pushes two
 * requests into an occupied group still lost a run: `42250898785` was created 13 seconds after
 * `42250903916`, stayed pending, and was cancelled, while the `ci` job that held the group was
 * cancelled two seconds after the first dispatch arrived. The mechanism is GitHub's (one pending
 * run per group, and an arrival re-evaluates the queue), and it is not something this repository
 * can configure away. What it can do is refuse to dispatch into a busy group.
 *
 * Reading the group once was not enough, and the second loss proved it: `42250898785` and
 * `42250903916` were dispatched two seconds apart, and the run list — which GitHub fills in
 * behind the dispatch, not with it — was still empty when the second caller read it. The arm that
 * was dispatched first was the one cancelled. So a dispatch is not finished when the API answers
 * 204; it is finished when the run it created is visible to the next caller. This tool now holds
 * a lock across both halves and does not release it until the new run shows up in the list.

 *
 *   node tools/bird-dispatch.mjs --model deepseek-flash --timeout 300000
 *   node tools/bird-dispatch.mjs --model deepseek-v4-pro --wait   # queue behind, never into
 *   node tools/bird-dispatch.mjs --self-test
 *
 * The token is read from `GH_TOKEN`, never from an argument: a token in `argv` lands in shell
 * history and in `ps`, and this repository has a gate that reads for exactly that.
 */
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = 'AgentiX-E/nl2charts';
const WORKFLOW = 'bird-dev.yml';
/** Runs that share the `bird-eval` group. A run outside this list cannot block a dispatch. */
const SHARED_GROUP = [/^bird-dev$/, /^bird-model$/, /^ci$/];
/** How long a dispatch lock is believed to belong to a live process. */
const LOCK_TTL_MS = 10 * 60_000;
/** How long a dispatch waits for its own run to appear before calling the group occupied anyway. */
const VISIBLE_TIMEOUT_MS = 90_000;

/**
 * The runs that would be disturbed by a dispatch.
 *
 * `status` is what Actions reports, and it has three live values rather than two: a run that has
 * been accepted but has no runner yet is `queued` in the API and `pending` in the UI, and reading
 * only `in_progress` would dispatch into a full queue — which is the case that lost a run.
 */
export function busyRuns(runs) {
  const live = new Set(['in_progress', 'pending', 'queued', 'requested', 'waiting']);
  return runs.filter((run) => live.has(run.status) && SHARED_GROUP.some((pattern) => pattern.test(run.name ?? '')));
}

/** The dispatch body, as the workflow's `inputs` declare them. */
export function dispatchBody({ model, timeoutMs, arms, limit }) {
  const inputs = {};
  if (model !== undefined) inputs.model = model;
  if (timeoutMs !== undefined) inputs.timeout_ms = String(timeoutMs);
  if (arms !== undefined) inputs.arms = arms;
  if (limit !== undefined) inputs.limit = String(limit);
  return { ref: 'master', inputs };
}

/**
 * The run this dispatch created, once GitHub lists it.
 *
 * The list read before the dispatch is the baseline, not the clock: a run's `created_at` is second
 * resolution and this repository dispatches far more than once a second, while a run id is unique.
 * Only runs in the shared group count, because a run outside it cannot occupy the slot this
 * dispatch just took.
 */
export function arrivedInGroup(knownIds, runs) {
  return runs.filter((run) => !knownIds.has(run.id) && SHARED_GROUP.some((pattern) => pattern.test(run.name ?? '')));
}

/**
 * Whether a lock file belongs to a process that is gone.
 *
 * The tool can be killed between taking the lock and releasing it, and a lock that outlives its
 * process would wedge every later dispatch. Ten minutes is longer than a dispatch takes (a poll
 * for visibility, then one POST) and shorter than a `--wait` queue, which does not hold the lock.
 */
export function lockIsStale(mtimeMs, nowMs) {
  return nowMs - mtimeMs > LOCK_TTL_MS;
}

export class LockBusy extends Error {}

/**
 * Take the dispatch lock, or say who holds it.
 *
 * Two invocations started in the same second are indistinguishable from one invocation started
 * twice, and they are the case that lost `42250898785`: both read a free group, both dispatched,
 * and the second arrival cancelled the first. The lock makes the second one wait or refuse.
 */
export function acquireLock(dir, nowMs = Date.now()) {
  const path = join(dir, 'bird-dispatch.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, `${String(process.pid)} ${String(nowMs)}\n`);
      closeSync(fd);
      return path;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const held = statSync(path).mtimeMs;
      if (!lockIsStale(held, nowMs)) {
        const holder = readFileSync(path, 'utf8').trim();
        throw new LockBusy(`another dispatch is in flight (${holder === '' ? 'unknown pid' : `pid ${holder.split(' ')[0]}`})`);
      }
      // A lock older than its process is not a lock; removing it and retrying once is the whole
      // recovery path, and retrying only once keeps a genuine race from becoming a spin.
      unlinkSync(path);
    }
  }
  throw new LockBusy('the dispatch lock could not be taken');
}

export function releaseLock(path) {
  rmSync(path, { force: true });
}

/** How long the queue poll waits for a free group. Long enough for a CI job, short enough to see. */
const QUEUE_POLL_MS = 60_000;

/** Whether the group's own run has surfaced yet, or the wait ran out. */
export async function awaitVisible(knownIds, read, options = {}) {
  const { timeoutMs = VISIBLE_TIMEOUT_MS, intervalMs = 5_000, sleep = pause, now = Date.now } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    const arrived = arrivedInGroup(knownIds, await read());
    if (arrived.length > 0) return arrived;
    if (now() >= deadline) return [];
    await sleep(intervalMs);
  }
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selfTest() {
  let failures = 0;
  let assertions = 0;
  const same = (name, actual, expected) => {
    assertions += 1;
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    failures += 1;
    console.error(`FAIL ${name}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  };

  const runs = [
    { id: 1, name: 'bird-dev', status: 'in_progress' },
    { id: 2, name: 'ci', status: 'queued' },
    { id: 3, name: 'bird-dev', status: 'pending' },
    { id: 4, name: 'ci', status: 'completed' },
    { id: 5, name: 'POC reproduction', status: 'in_progress' },
    { id: 6, name: 'live-eval', status: 'in_progress' },
  ];
  // Queued counts: the run this tool was written after was cancelled while still pending, and a
  // check that only looked at `in_progress` would have called that group free.
  same('every live run in the shared group blocks a dispatch', busyRuns(runs).map((run) => run.id), [1, 2, 3]);
  same('a finished run does not', busyRuns([{ id: 7, name: 'bird-dev', status: 'completed' }]), []);
  same('a workflow outside the group does not', busyRuns([{ id: 5, name: 'live-eval', status: 'in_progress' }]), []);

  same('the body carries only what was asked for', dispatchBody({ model: 'deepseek-flash' }), {
    ref: 'master',
    inputs: { model: 'deepseek-flash' },
  });
  // The workflow spells the input `timeout_ms` and takes a string; a number here is silently
  // dropped by Actions, which would run the default 120 s that cost 94 cases.
  same('the timeout is spelled and typed as the workflow declares it', dispatchBody({ model: 'm', timeoutMs: 300000 }), {
    ref: 'master',
    inputs: { model: 'm', timeout_ms: '300000' },
  });

  // The dispatch that lost `42250898785`: the list read two seconds later still had no run in it,
  // so a guard built on "is the group busy" said free and the second arrival cancelled the first.
  const before = new Set([10, 11]);
  same(
    'a run that was not in the baseline is the one this dispatch created',
    arrivedInGroup(before, [
      { id: 10, name: 'bird-dev', status: 'completed' },
      { id: 12, name: 'bird-dev', status: 'queued' },
    ]).map((run) => run.id),
    [12],
  );
  same(
    'a new run outside the shared group is not ours',
    arrivedInGroup(before, [{ id: 13, name: 'live-eval', status: 'queued' }]),
    [],
  );
  same('an unchanged list means the dispatch has not surfaced yet', arrivedInGroup(before, [{ id: 11, name: 'ci', status: 'in_progress' }]), []);

  const started = 1_000_000;
  same('a lock held inside its window is live', lockIsStale(started, started + 60_000), false);
  same('a lock older than its process is stale', lockIsStale(started, started + 11 * 60_000), true);

  // The lock is exercised on a real directory rather than a stub: the failure it prevents was two
  // real processes racing, and a stubbed lockfile would pass a test the filesystem fails.
  const dir = mkdtempSync(join(tmpdir(), 'bird-dispatch-self-test-'));
  try {
    const held = acquireLock(dir);
    same('the lock records its holder', readFileSync(held, 'utf8').startsWith(`${String(process.pid)} `), true);
    let busy;
    try {
      acquireLock(dir);
    } catch (error) {
      busy = error instanceof LockBusy && /in flight/.test(error.message);
    }
    same('a second dispatch is refused while the first holds the lock', busy, true);
    releaseLock(held);
    const again = acquireLock(dir);
    same('the lock is reusable once released', typeof again, 'string');
    releaseLock(again);

    // A lock left behind by a killed process must not wedge the tool forever.
    const orphan = join(dir, 'bird-dispatch.lock');
    const fd = openSync(orphan, 'wx');
    writeSync(fd, '999999 0\n');
    closeSync(fd);
    let taken;
    try {
      taken = acquireLock(dir, Date.now() + 11 * 60_000);
    } catch (error) {
      // Reported as a failed assertion rather than thrown: a stack trace here reads like a broken
      // test, and the thing that broke is the recovery path.
      taken = undefined;
      same('a stale lock is broken rather than obeyed', String(error?.message), 'taken');
    }
    if (taken !== undefined) {
      same('a stale lock is broken rather than obeyed', readFileSync(taken, 'utf8').startsWith(`${String(process.pid)} `), true);
      releaseLock(taken);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`bird-dispatch self-test: ${String(failures)} failure(s)`);
    process.exit(1);
  }
  return assertions;
}

async function call(path, token, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  return { status: response.status, body };
}

function value(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv) {
  if (argv.includes('--self-test')) {
    const sync = selfTest();
    const asyncChecks = await selfTestAsync();
    console.log(`bird-dispatch self-test: ${String(sync + asyncChecks)} assertions`);
    return;
  }
  const token = process.env.GH_TOKEN;
  if (token === undefined || token === '') {
    console.error('bird-dispatch: GH_TOKEN is not set. A token in argv would land in shell history and in ps.');
    process.exit(1);
  }
  const model = value(argv, '--model');
  if (model === undefined) {
    console.error('bird-dispatch: --model is required, because a dispatch without one runs the alias that every published reading used');
    process.exit(1);
  }
  const timeout = value(argv, '--timeout');
  const arms = value(argv, '--arms');
  const wait = argv.includes('--wait');
  const listPath = `/repos/${REPO}/actions/runs?per_page=20`;

  let lock;
  for (;;) {
    try {
      lock = acquireLock(process.env.BIRD_DISPATCH_LOCK_DIR ?? tmpdir());
      break;
    } catch (error) {
      if (!(error instanceof LockBusy)) throw error;
      if (!wait) {
        console.error(`bird-dispatch: ${error.message}; wait for it or pass --wait`);
        process.exit(1);
      }
      console.log(`bird-dispatch: ${error.message}; waiting`);
      await pause(5_000);
    }
  }

  try {
    // The baseline is the list read on the pass that found the group free, because the run this
    // dispatch creates is only identifiable as "not in there".
    let known = new Set();
    for (;;) {
      const list = await call(listPath, token);
      if (list.status !== 200) {
        console.error(`bird-dispatch: could not read the run list (HTTP ${String(list.status)})`);
        process.exitCode = 1;
        return;
      }
      const listed = list.body?.workflow_runs ?? [];
      const busy = busyRuns(listed);
      if (busy.length === 0) {
        known = new Set(listed.map((run) => run.id));
        break;
      }
      const described = busy.map((run) => `${String(run.id)} ${String(run.name)} ${String(run.status)}`).join(', ');
      if (!wait) {
        // Refused rather than queued: a second arrival is what cancelled the first one today.
        console.error(`bird-dispatch: bird-eval is busy (${described}); wait for it or pass --wait`);
        process.exitCode = 1;
        return;
      }
      console.log(`bird-dispatch: busy (${described}); waiting`);
      await pause(QUEUE_POLL_MS);
    }

    const dispatched = await call(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, token, {
      method: 'POST',
      body: JSON.stringify(dispatchBody({ model, timeoutMs: timeout, arms })),
    });
    if (dispatched.status !== 204) {
      console.error(`bird-dispatch: dispatch failed (HTTP ${String(dispatched.status)}) ${JSON.stringify(dispatched.body ?? {}).slice(0, 200)}`);
      process.exitCode = 1;
      return;
    }

    const arrived = await awaitVisible(known, async () => (await call(listPath, token)).body?.workflow_runs ?? []);
    const landed = arrived.length === 0 ? '' : ` as run ${String(arrived[0].id)}`;
    if (arrived.length === 0) {
      console.log('bird-dispatch: dispatched, but the run was not listed within 90 s; a dispatch sent in the next minute could still be read as arriving into a free group');
    }
    console.log(`bird-dispatch: dispatched ${model}${timeout === undefined ? '' : ` at ${timeout} ms`} into a free bird-eval group${landed}`);
  } finally {
    // Released even when the dispatch was refused: a lock that outlives a refusal is the same
    // wedge as one that outlives a killed process, only faster to hit.
    releaseLock(lock);
  }
}

async function selfTestAsync() {
  let failures = 0;
  let assertions = 0;
  const same = (name, actual, expected) => {
    assertions += 1;
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    failures += 1;
    console.error(`FAIL ${name}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  };
  const noSleep = () => Promise.resolve();
  const known = new Set([20]);

  // The visibility wait is what closes the two-second window: the first read is empty for the same
  // reason the real one was, and the wait must not call the dispatch finished on it.
  const seen = [];
  const arrived = await awaitVisible(
    known,
    () => {
      seen.push(1);
      return Promise.resolve(seen.length < 2 ? [{ id: 20, name: 'bird-dev', status: 'completed' }] : [{ id: 21, name: 'bird-dev', status: 'queued' }]);
    },
    { sleep: noSleep },
  );
  same('an unlisted dispatch is waited for, then read', arrived.map((run) => run.id), [21]);
  same('the wait polls more than once when the list is behind', seen.length, 2);

  const gaveUp = await awaitVisible(known, () => Promise.resolve([{ id: 20, name: 'bird-dev', status: 'completed' }]), {
    timeoutMs: 0,
    sleep: noSleep,
  });
  same('a run that never surfaces ends the wait instead of spinning', gaveUp, []);

  if (failures > 0) {
    console.error(`bird-dispatch self-test: ${String(failures)} failure(s)`);
    process.exit(1);
  }
  return assertions;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main(process.argv.slice(2));
}
