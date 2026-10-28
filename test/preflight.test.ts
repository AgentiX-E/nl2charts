import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolvePreflightSettings } from '../eval/preflight.js';

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
