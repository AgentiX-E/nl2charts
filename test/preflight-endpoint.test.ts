/**
 * The preflight answers one question before a 500-call arm is spent: does this endpoint
 * answer, and does it answer inside the deadline the run will impose?
 *
 * It used to be a script with `process.exit` in the middle, which meant the branch that
 * matters most — an endpoint that answers slowly enough that the tail will time out —
 * could be observed only by reading a job log. These tests run it against a real HTTP
 * server and assert on the report, and they cover the two ways the old version was wrong:
 * a median over half the deadline is a failure that still exits 0 if you only count
 * failures, and "no key" has to be a reportable code rather than a dead process.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runPreflight, main } from '../eval/preflight.js';
import { startEndpoint } from './helpers/endpoint.js';
import type { Endpoint } from './helpers/endpoint.js';

let endpoint: Endpoint | undefined;
afterEach(async () => {
  await endpoint?.close();
  endpoint = undefined;
});

describe('preflight', () => {
  it('reports a healthy endpoint with timings and a summary a reader can quote', async () => {
    endpoint = await startEndpoint({ reply: () => 'ready' });
    const lines: string[] = [];
    const report = await runPreflight({
      baseUrl: endpoint.url,
      model: 'test-model',
      apiKey: 'not-a-real-key',
      samples: 3,
      deadlineMs: 5000,
      log: (line) => lines.push(line),
    });
    expect(report.ok).toBe(true);
    expect(report.failures).toBe(0);
    expect(report.answered).toBe(3);
    expect(report.medianMs).toBeGreaterThanOrEqual(0);
    expect(report.worstMs).toBeGreaterThanOrEqual(report.medianMs ?? 0);
    expect(report.problems).toEqual([]);
    expect(report.summary).toContain('3 calls to test-model — 3 answered');
    // Logged once, not once per call: the first success answers the question.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('answered (5 chars)');
    // The key travels in the header, not the body: one assertion on the wire keeps that true.
    expect(endpoint.requests[0]?.authorization).toBe('Bearer not-a-real-key');
    expect(endpoint.requests[0]?.body.temperature).toBe(0);
    expect(endpoint.requests[0]?.body.max_tokens).toBeUndefined();
  });

  it('fails when one call of three is refused, and names the status', async () => {
    endpoint = await startEndpoint({ reply: (_request, index) => (index === 1 ? { status: 500 } : 'ready') });
    const report = await runPreflight({ baseUrl: endpoint.url, model: 'test-model', apiKey: 'k', samples: 3, deadlineMs: 5000 });
    expect(report.ok).toBe(false);
    expect(report.failures).toBe(1);
    expect(report.answered).toBe(2);
    expect(report.firstError).toContain('500');
    expect(report.problems[0]).toContain('1 of 3 calls failed');
    expect(report.problems[1]).toContain('did not answer every call');
  });

  it('fails on an endpoint whose median exceeds half the deadline, even with zero failures', async () => {
    // This is the glm-4.5 shape: every call answers, none of them answers in time to leave
    // headroom for the tail.
    // The margin between the delay and the deadline is deliberately wider than the delay's
    // half: a loaded machine must not turn this test into a timeout test, which is what the
    // next one is for.
    endpoint = await startEndpoint({ reply: () => ({ content: 'ready', delayMs: 400 }) });
    const report = await runPreflight({ baseUrl: endpoint.url, model: 'test-model', apiKey: 'k', samples: 2, deadlineMs: 700 });
    expect(report.failures).toBe(0);
    expect(report.ok).toBe(false);
    expect(report.medianMs).toBeGreaterThan(350);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('so the tail will exceed it');
  });

  it('reports an unreachable endpoint without timing out the process', async () => {
    // A port nobody listens on: the transport failure has to arrive as a report, not a throw.
    const report = await runPreflight({ baseUrl: 'http://127.0.0.1:1/v1', model: 'test-model', apiKey: 'k', samples: 2, deadlineMs: 500 });
    expect(report.ok).toBe(false);
    expect(report.failures).toBe(2);
    expect(report.medianMs).toBeUndefined();
    expect(report.summary).toContain('median n/a');
    expect(report.firstError.length).toBeGreaterThan(0);
  });

  it('treats an endpoint that answers nothing as a failure with the endpoint named', async () => {
    endpoint = await startEndpoint({ reply: () => ({ raw: JSON.stringify({ choices: [] }) }) });
    const report = await runPreflight({ baseUrl: endpoint.url, model: 'test-model', apiKey: 'k', samples: 1, deadlineMs: 5000 });
    expect(report.ok).toBe(false);
    expect(report.firstError).toContain('no content');
  });

  it('returns a non-zero code and never calls out when no key is configured', async () => {
    // `process.exit` in the module body made this branch untestable, and an untestable
    // branch is the one that reports "no key" as a dead job with no message.
    const code = await main({});
    expect(code).toBe(1);
  });

  it('exits 0 on a healthy endpoint through the command-line contract', async () => {
    endpoint = await startEndpoint({ reply: () => 'ready' });
    const code = await main({
      LLM_BASE_URL: endpoint.url,
      LLM_MODEL: 'test-model',
      LLM_API_KEY: 'k',
      BIRD_PREFLIGHT_SAMPLES: '2',
      BIRD_LLM_TIMEOUT_MS: '5000',
    });
    expect(code).toBe(0);
    expect(endpoint.requests).toHaveLength(2);
  });

  it('falls back to the documented defaults when the environment names only a key and a URL', async () => {
    endpoint = await startEndpoint({ reply: () => 'ready' });
    // DEEPSEEK_API_KEY is the second choice; LLM_MODEL, BIRD_PREFLIGHT_SAMPLES and
    // BIRD_LLM_TIMEOUT_MS are absent, so their defaults are what this call measures.
    const code = await main({ DEEPSEEK_API_KEY: 'k', LLM_BASE_URL: endpoint.url });
    expect(code).toBe(0);
    expect(endpoint.requests).toHaveLength(3);
    expect(endpoint.requests[0]?.body.model).toBe('deepseek-chat');
  });

  it('exits non-zero when the endpoint is too slow for the deadline the run will impose', async () => {
    endpoint = await startEndpoint({ reply: () => ({ content: 'ready', delayMs: 100 }) });
    const code = await main({
      LLM_BASE_URL: endpoint.url,
      LLM_MODEL: 'test-model',
      LLM_API_KEY: 'k',
      BIRD_PREFLIGHT_SAMPLES: '2',
      BIRD_LLM_TIMEOUT_MS: '100',
    });
    expect(code).toBe(1);
  });
});
