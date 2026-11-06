#!/usr/bin/env node
/**
 * Dispatch a BIRD run without killing whatever is already running.
 *
 * `bird-dev`, `bird-model` and `ci`'s Mini-Dev job share one concurrency group (`bird-eval`)
 * because they draw on the same provider quota and write the same artifact path. The group does
 * not cancel — every workflow sets `cancel-in-progress: false` — but a dispatcher that pushes two
 * requests into an occupied group still lost a run today: `42250898785` was created 13 seconds
 * after `42250903916`, stayed pending, and was cancelled, while the `ci` job that held the group
 * was cancelled two seconds after the first dispatch arrived. The mechanism is GitHub's
 * (one pending run per group, and an arrival re-evaluates the queue), and it is not something this
 * repository can configure away. What it can do is refuse to dispatch into a busy group.
 *
 *   node tools/bird-dispatch.mjs --model deepseek-flash --timeout 300000
 *   node tools/bird-dispatch.mjs --model deepseek-v4-pro --wait   # queue behind, never into
 *   node tools/bird-dispatch.mjs --self-test
 *
 * The token is read from `GH_TOKEN`, never from an argument: a token in `argv` lands in shell
 * history and in `ps`, and this repository has a gate that reads for exactly that.
 */
import { resolve } from 'node:path';

const REPO = 'AgentiX-E/nl2charts';
const WORKFLOW = 'bird-dev.yml';
/** Runs that share the `bird-eval` group. A run outside this list cannot block a dispatch. */
const SHARED_GROUP = [/^bird-dev$/, /^bird-model$/, /^ci$/];

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

function selfTest() {
  let failures = 0;
  const same = (name, actual, expected) => {
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

  if (failures > 0) {
    console.error(`bird-dispatch self-test: ${String(failures)} failure(s)`);
    process.exit(1);
  }
  console.log('bird-dispatch self-test: 5 assertions');
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
    selfTest();
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

  for (;;) {
    const list = await call(`/repos/${REPO}/actions/runs?per_page=20`, token);
    if (list.status !== 200) {
      console.error(`bird-dispatch: could not read the run list (HTTP ${String(list.status)})`);
      process.exit(1);
    }
    const busy = busyRuns(list.body?.workflow_runs ?? []);
    if (busy.length === 0) break;
    const described = busy.map((run) => `${String(run.id)} ${String(run.name)} ${String(run.status)}`).join(', ');
    if (!wait) {
      // Refused rather than queued: a second arrival is what cancelled the first one today.
      console.error(`bird-dispatch: bird-eval is busy (${described}); wait for it or pass --wait`);
      process.exit(1);
    }
    console.log(`bird-dispatch: busy (${described}); waiting`);
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }

  const dispatched = await call(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, token, {
    method: 'POST',
    body: JSON.stringify(dispatchBody({ model, timeoutMs: timeout, arms })),
  });
  if (dispatched.status !== 204) {
    console.error(`bird-dispatch: dispatch failed (HTTP ${String(dispatched.status)}) ${JSON.stringify(dispatched.body ?? {}).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`bird-dispatch: dispatched ${model}${timeout === undefined ? '' : ` at ${timeout} ms`} into a free bird-eval group`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main(process.argv.slice(2));
}
