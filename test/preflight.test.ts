import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { main, resolvePreflightSettings, resolvePreflightTargets, targetProblem } from '../eval/preflight.js';

/**
 * The preflight is a latency check, not a liveness check.
 *
 * One successful call says the endpoint answers; it does not say it answers inside the deadline
 * the run will impose. A glm-4.5 run once spent 3h43m and 1,532 calls to discover that 41% of
 * them exceeded a 180-second deadline — three timed calls would have said so in nine minutes.
 * These tests drive the script against a local server with a known delay, because the property
 * under test is arithmetic on measured milliseconds and nothing about it needs a real provider.
 */
const servers: { close: () => void }[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});

/** An OpenAI-compatible endpoint that answers after `delayMs`, or never when it hangs. */
async function endpoint(delayMs: number | 'hang'): Promise<string> {
  const server = createServer((request, response) => {
    request.resume();
    const reply = (): void => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'stub', choices: [{ message: { content: 'ready' } }] }));
    };
    if (delayMs === 'hang') return;
    setTimeout(reply, delayMs);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  servers.push({ close: () => server.close() });
  return `http://127.0.0.1:${String(port)}/v1`;
}

/**
 * Asynchronous on purpose: the stub endpoint lives in this process, and a blocking spawn would
 * stop the event loop that has to answer the child's request — the child would time out against
 * a server that is running perfectly, which is the sort of harness artefact these tests exist
 * to notice.
 */
function preflight(env: Record<string, string>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn('npx', ['tsx', 'eval/preflight.ts'], {
      cwd: resolve(process.cwd()),
      env: { ...process.env, LLM_API_KEY: 'test', LLM_MODEL: 'stub', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

describe('preflight', () => {
  it('passes a fast endpoint and prints the deadline it tested', async () => {
    const baseUrl = await endpoint(0);
    const run = await preflight({ LLM_BASE_URL: baseUrl, BIRD_LLM_TIMEOUT_MS: '5000', BIRD_PREFLIGHT_SAMPLES: '2' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('deadline 5000 ms');
    expect(run.stdout).toContain('2 calls to stub');
  });

  it('fails an endpoint whose median is more than half the deadline', async () => {
    // 800 ms per call against a 1,000 ms deadline: every call may pass and the tail still
    // exceeds it, which is exactly how a run ends up with a failure column full of timeouts.
    const baseUrl = await endpoint(800);
    const run = await preflight({ LLM_BASE_URL: baseUrl, BIRD_LLM_TIMEOUT_MS: '1000', BIRD_PREFLIGHT_SAMPLES: '2' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('median call takes');
    expect(run.stderr).toContain('BIRD_LLM_TIMEOUT_MS');
  });

  it('fails an endpoint that never answers, naming the first error', async () => {
    const baseUrl = await endpoint('hang');
    const run = await preflight({ LLM_BASE_URL: baseUrl, BIRD_LLM_TIMEOUT_MS: '300', BIRD_PREFLIGHT_SAMPLES: '1' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('did not answer every call');
  });
});

describe('the settings a preflight reads', () => {
  it('defaults to the endpoint the published numbers were produced on', () => {
    // The defaults used to live inside `main`, where a test that pointed at a local server
    // never reached them: a default that has never been read is a default nobody has checked.
    expect(resolvePreflightSettings({})).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: '',
      samples: 3,
      deadlineMs: 60_000,
    });
  });

  it('takes every override, and prefers LLM_API_KEY over the older name', () => {
    expect(
      resolvePreflightSettings({
        LLM_BASE_URL: 'http://127.0.0.1:9/v1',
        LLM_MODEL: 'm',
        LLM_API_KEY: 'new',
        DEEPSEEK_API_KEY: 'old',
        BIRD_PREFLIGHT_SAMPLES: '1',
        BIRD_LLM_TIMEOUT_MS: '250',
      }),
    ).toEqual({ baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'new', samples: 1, deadlineMs: 250 });
    expect(resolvePreflightSettings({ DEEPSEEK_API_KEY: 'old' }).apiKey).toBe('old');
  });
});

/** An endpoint that refuses: the cross arm's endpoint when its key is wrong or absent. */
async function refusing(status: number): Promise<string> {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'invalid api key', code: '1000' } }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  servers.push({ close: () => server.close() });
  return `http://127.0.0.1:${String(port)}/v4`;
}

/**
 * The second endpoint is a first-class target, not a note in a workflow.
 *
 * `40792849132` is the run that taught this: `bird-dev` was dispatched with
 * `second_model=glm-4.5`, and 120 of 360 candidates — every single `@second` draw — never
 * arrived. The run discovered it three minutes in, after `names` had finished, because the
 * preflight only ever called the primary endpoint. On the 1,534-question split that discovery
 * costs forty minutes, and ADR-202 exists precisely because a forty-minute discovery is a
 * four-hour discovery waiting to happen.
 */
describe('every endpoint the run will call', () => {
  it('names the primary endpoint and nothing else when no second model is configured', () => {
    const targets = resolvePreflightTargets({ LLM_BASE_URL: 'https://a/v1', LLM_MODEL: 'm', LLM_API_KEY: 'k' });
    expect(targets).toEqual([{ role: 'primary', baseUrl: 'https://a/v1', model: 'm', apiKey: 'k' }]);
  });

  it('adds the second endpoint, and borrows the primary URL when it has none', () => {
    // The fallback has to match `createProviders` exactly: a run that preflights one
    // endpoint and calls another has measured the wrong thing twice.
    const withUrl = resolvePreflightTargets({
      LLM_BASE_URL: 'https://a/v1',
      LLM_MODEL: 'm',
      LLM_API_KEY: 'k',
      BIRD_SECOND_MODEL: 'glm-4.5',
      BIRD_SECOND_BASE_URL: 'https://b/v4',
      BIRD_SECOND_API_KEY: 'k2',
    });
    expect(withUrl.map((target) => [target.role, target.baseUrl, target.model, target.apiKey])).toEqual([
      ['primary', 'https://a/v1', 'm', 'k'],
      ['second', 'https://b/v4', 'glm-4.5', 'k2'],
    ]);
    const withoutUrl = resolvePreflightTargets({
      LLM_BASE_URL: 'https://a/v1',
      LLM_MODEL: 'm',
      LLM_API_KEY: 'k',
      BIRD_SECOND_MODEL: 'glm-4.5',
      BIRD_SECOND_API_KEY: 'k2',
    });
    expect(withoutUrl[1]?.baseUrl).toBe('https://a/v1');
    // An empty string is the workflow's "not provided", and taking it literally would send
    // every request to the relative path `/chat/completions`.
    const emptyUrl = resolvePreflightTargets({
      LLM_BASE_URL: 'https://a/v1',
      LLM_MODEL: 'm',
      LLM_API_KEY: 'k',
      BIRD_SECOND_MODEL: 'glm-4.5',
      BIRD_SECOND_BASE_URL: '',
      BIRD_SECOND_API_KEY: 'k2',
    });
    expect(emptyUrl[1]?.baseUrl).toBe('https://a/v1');
  });

  it('falls back to the organization key name for the second endpoint', () => {
    const targets = resolvePreflightTargets({ LLM_API_KEY: 'k', BIRD_SECOND_MODEL: 'glm-4.5', ZHIPU_API_KEY: 'zk' });
    expect(targets[1]?.apiKey).toBe('zk');
    // Neither name set is an empty key, not an absent target: the run would still try to
    // draw the candidate, and the preflight has to say why it cannot check that draw.
    const neither = resolvePreflightTargets({ LLM_API_KEY: 'k', BIRD_SECOND_MODEL: 'glm-4.5' });
    expect(neither[1]?.apiKey).toBe('');
  });

  it('says which variable is missing, on the target that is missing it', () => {
    // Read as a function rather than through `main`, because `main` is only reachable
    // through a child process and v8 does not collect coverage across processes — a branch
    // that only a subprocess can take is a branch no test can be shown to have taken.
    expect(targetProblem({ role: 'primary', baseUrl: 'u', model: 'deepseek-chat', apiKey: '' })).toBe(
      'no key for deepseek-chat. Set LLM_API_KEY (preferred) or DEEPSEEK_API_KEY.',
    );
    expect(targetProblem({ role: 'second', baseUrl: 'u', model: 'glm-4.5', apiKey: '' })).toBe(
      'no key for glm-4.5. Set BIRD_SECOND_API_KEY or ZHIPU_API_KEY.',
    );
    expect(targetProblem({ role: 'primary', baseUrl: 'u', model: 'deepseek-chat', apiKey: 'k' })).toBeNull();
    expect(targetProblem({ role: 'second', baseUrl: 'u', model: 'glm-4.5', apiKey: 'k' })).toBeNull();
  });

  it('reports a second endpoint that refuses, instead of discovering it after an arm', async () => {
    const primary = await endpoint(0);
    const second = await refusing(401);
    const result = await preflight({
      LLM_BASE_URL: primary,
      BIRD_SECOND_MODEL: 'glm-4.5',
      BIRD_SECOND_BASE_URL: second,
      BIRD_SECOND_API_KEY: 'bad',
      BIRD_PREFLIGHT_SAMPLES: '1',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('preflight[second]');
    expect(result.stderr).toContain('401');
    // The primary endpoint passed before the second one was tried, and the output says so:
    // one failing endpoint must not erase the fact that the other answered.
    expect(result.stdout).toContain('preflight[primary]');
  });

  it('refuses a second model with no key at all, rather than measuring an empty bearer token', async () => {
    const primary = await endpoint(0);
    const result = await preflight({
      LLM_BASE_URL: primary,
      BIRD_SECOND_MODEL: 'glm-4.5',
      BIRD_SECOND_API_KEY: '',
      ZHIPU_API_KEY: '',
      BIRD_PREFLIGHT_SAMPLES: '1',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('preflight[second]: no key for glm-4.5');
    expect(result.stderr).toContain('BIRD_SECOND_API_KEY or ZHIPU_API_KEY');
  });

  it('returns its verdict in-process, so the loop that produces it is not a subprocess secret', async () => {
    // The child-process tests above prove the command-line contract. They cannot prove the
    // loop ran, because v8 does not collect coverage across processes — the `failed` flag and
    // the `continue` that follows it would exist as unread lines. Called directly, the same
    // two paths are statements a test has executed.
    const primary = await endpoint(0);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const broken = await main({
        LLM_BASE_URL: primary,
        LLM_MODEL: 'stub',
        LLM_API_KEY: 'k',
        BIRD_SECOND_MODEL: 'glm-4.5',
        BIRD_SECOND_API_KEY: '',
        BIRD_PREFLIGHT_SAMPLES: '1',
      } as unknown as NodeJS.ProcessEnv);
      expect(broken).toBe(1);
      const healthy = await main({
        LLM_BASE_URL: primary,
        LLM_MODEL: 'stub',
        LLM_API_KEY: 'k',
        BIRD_PREFLIGHT_SAMPLES: '1',
      } as unknown as NodeJS.ProcessEnv);
      expect(healthy).toBe(0);
      // The primary endpoint is checked before the missing second key is reported, so a
      // reader sees what did work next to what did not.
      expect(logs.mock.calls.some((call) => String(call[0]).startsWith('preflight[primary]'))).toBe(true);
      expect(errors.mock.calls.some((call) => String(call[0]).startsWith('preflight[second]'))).toBe(true);
    } finally {
      errors.mockRestore();
      logs.mockRestore();
    }
  });

  it('passes when both endpoints answer, and prints one line for each', async () => {
    const primary = await endpoint(0);
    const second = await endpoint(0);
    const result = await preflight({
      LLM_BASE_URL: primary,
      BIRD_SECOND_MODEL: 'glm-4.5',
      BIRD_SECOND_BASE_URL: second,
      BIRD_SECOND_API_KEY: 'k2',
      BIRD_PREFLIGHT_SAMPLES: '1',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('preflight[primary]');
    expect(result.stdout).toContain('preflight[second]');
  });
});
