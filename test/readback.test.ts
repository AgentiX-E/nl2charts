/**
 * The readback channel.
 *
 * The rule this file exists for is narrow and was paid for twice: an uploaded artifact is served
 * from a signed storage URL that answers `401`, so a dispatched run's reading was visible only to a
 * browser. An issue comment is created and read through `api.github.com`, which is reachable, so
 * the workflow posts there and every reader reads there.
 *
 * The tests run a real HTTP server rather than a stubbed client: what can be wrong is the request
 * this tool builds — its path, its method, its headers, its pagination — and a mock would agree
 * with whatever the tool sent.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bodyOf,
  digest,
  ensureBranch,
  ensureIssue,
  findIssue,
  latestReading,
  main,
  mergeReading,
  metaFromEnvironment,
  parseBody,
  publish,
  publishToBranch,
  read,
  readFromBranch,
  readIndex,
  slugOf,
} from '../tools/readback.mjs';

/** A server that records every request and answers from a routing table. */
async function server(routes: (request: { method: string; url: string; body: string; headers: IncomingMessage['headers'] }) => {
  status?: number;
  body?: unknown;
}) {
  const seen: { method: string; url: string; body: string; headers: IncomingMessage['headers'] }[] = [];
  const instance = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const recorded = { method: request.method ?? 'GET', url: request.url ?? '', body: Buffer.concat(chunks).toString(), headers: request.headers };
      seen.push(recorded);
      const answer = routes(recorded);
      response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      response.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  if (address === null || typeof address === 'string') throw new Error('the test server did not bind a port');
  return { seen, api: `http://127.0.0.1:${String(address.port)}`, close: () => new Promise<void>((resolve) => instance.close(() => resolve())) };
}

/** A temporary artifact, for the command line to publish. */
const withArtifact = (body: unknown): { dir: string; path: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'readback-'));
  const path = join(dir, 'bird-eval.json');
  writeFileSync(path, JSON.stringify(body));
  return { dir, path };
};

/** Capture both streams, because the command reports on one and refuses on the other. */
const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err, restore: () => { stdout.mockRestore(); stderr.mockRestore(); } };
};

const ARTIFACT = {
  split: 'dev',
  dataset: 'BIRD dev',
  model: 'deepseek-chat',
  secondModel: 'deepseek-reasoner',
  generatedAt: '2026-11-21T00:00:00.000Z',
  corpus: { dev: 'db9e8a1aba23ddd9' },
  selection: { requested: 600, scored: 600 },
  arms: [
    {
      arm: 'select-cross',
      passed: 378,
      total: 600,
      accuracy: 0.63,
      candidateRecall: 415,
      selectionLoss: 37,
      calls: { mean: 4 },
      tokens: { prompt: 2508, completion: 589 },
      strictPassed: 370,
      spend: { asked: 600, priced: 600 },
      selectorRule: { rule: 'modal', decided: 554, eligible: 1570, emptyPool: 16, rules: { modal: 554 } },
    },
    { arm: 'names', passed: 100, total: 600, accuracy: 1 / 6 },
  ],
};

const VES = { rves: 56.63, ex: 63, scored: 600, of: 1532, runs: [56.58, 56.63], repeats: 5, floor: { rves: 57.96, net: -1.33 } };

describe('the reading a comment carries', () => {
  it('keeps the coordinates and the fields a report quotes, and drops the rest', () => {
    const reading = digest(ARTIFACT, VES, { commit: 'abcdef1234567890', workflow: 'ci', runId: '42' });
    expect(reading).toMatchObject({
      kind: 'bench-readback',
      commit: 'abcdef1234567890',
      workflow: 'ci',
      runId: '42',
      split: 'dev',
      model: 'deepseek-chat',
      secondModel: 'deepseek-reasoner',
      selection: { requested: 600, scored: 600 },
    });
    expect(reading.arms[0]).toEqual({
      arm: 'select-cross',
      passed: 378,
      total: 600,
      accuracy: 0.63,
      candidateRecall: 415,
      selectionLoss: 37,
      calls: 4,
      promptTokens: 2508,
      completionTokens: 589,
      strictPassed: 370,
      spend: { asked: 600, priced: 600 },
      selectorRule: { rule: 'modal', decided: 554, eligible: 1570, emptyPool: 16, rules: { modal: 554 } },
    });
    // An arm without a pool has no pool fields rather than zeros: zero is a measurement, absent
    // is the absence of one, and a report that printed 0 would be inventing a ceiling.
    expect(reading.arms[1]).toEqual({ arm: 'names', passed: 100, total: 600, accuracy: 1 / 6 });
  });

  it('records absent coordinates as null, so a reader cannot mistake a missing run for one', () => {
    const reading = digest({});
    expect(reading).toMatchObject({ commit: null, workflow: null, runId: null, split: null, arms: [] });
    expect(reading.rves).toBeUndefined();
    expect(reading.selection).toBeNull();
  });

  it('carries the R-VES block only when the run measured one, floor included', () => {
    expect(digest(ARTIFACT, VES).rves).toEqual({ rves: 56.63, ex: 63, scored: 600, of: 1532, runs: [56.58, 56.63], repeats: 5, floor: 57.96, net: -1.33 });
    // A reading without its floor is the reading that produced a wrong explanation last round, so
    // the block states whichever fields the artifact has and never fills one in.
    expect(digest(ARTIFACT, { rves: 50, ex: 60, scored: 10, of: 10, runs: [50], repeats: 1 }).rves).toEqual({
      rves: 50,
      ex: 60,
      scored: 10,
      of: 10,
      runs: [50],
      repeats: 1,
    });
    expect(digest(ARTIFACT, undefined).rves).toBeUndefined();
    expect(digest(ARTIFACT, null as never).rves).toBeUndefined();
  });

  it('renders one table row per arm, a null-safe R-VES line, and a JSON block that parses back', () => {
    const body = bodyOf(digest(ARTIFACT, VES, { commit: 'abcdef1234' }));
    expect(body).toContain('### dev · deepseek-chat · abcdef12');
    expect(body).toContain('| `select-cross` | 378/600 | 63.00% | 415 | 37 | 600/600 | 4.00 | 2508 | 589 |');
    // An arm with no pool, no calls and no tokens prints an em dash per column rather than 0.
    expect(body).toContain('| `names` | 100/600 | 16.67% | — | — | — | — | — | — |');
    expect(body).toContain('R-VES **56.63** over 600 of 1532 questions · floor 57.96 · net -1.33pp');
    expect(parseBody(body)).toEqual(digest(ARTIFACT, VES, { commit: 'abcdef1234' }));
  });

  it('omits the R-VES line entirely when the run has no such reading', () => {
    const body = bodyOf(digest(ARTIFACT));
    expect(body).not.toContain('R-VES');
    expect(body).toContain('### dev · deepseek-chat');
  });

  it('reads nothing out of a comment that is not ours', () => {
    expect(parseBody('just a conversation about the issue')).toBeUndefined();
    expect(parseBody('<!-- bench-readback:json -->\nno fence here')).toBeUndefined();
    expect(parseBody('<!-- bench-readback:json -->\n```json\n{"unterminated": ')).toBeUndefined();
    expect(parseBody('<!-- bench-readback:json -->\n```json\nnot json\n```')).toBeUndefined();
  });

  it('takes the run coordinates from the environment the workflow sets', () => {
    expect(metaFromEnvironment({ GITHUB_SHA: 'abc', GITHUB_WORKFLOW: 'ci', GITHUB_RUN_ID: '7' })).toEqual({ commit: 'abc', workflow: 'ci', runId: '7' });
    expect(metaFromEnvironment({})).toEqual({ commit: null, workflow: null, runId: null });
  });
});

describe('the issue the readings live on', () => {
  const issues = [
    { number: 1, title: 'something else' },
    { number: 2, title: 'bench readback', pull_request: { url: 'x' } },
    { number: 3, title: 'bench readback' },
  ];

  it('finds the issue and not a pull request with the same title', () => {
    expect(findIssue(issues)?.number).toBe(3);
    expect(findIssue([{ number: 1, title: 'other' }])).toBeUndefined();
  });

  it('keeps the oldest when a title has been duplicated', () => {
    // The readback channel grew a second issue the round its label was dropped on create. Readings
    // belong on one issue, and the one they started on is the one a reader has bookmarked.
    expect(findIssue([{ number: 9, title: 'bench readback' }, { number: 2, title: 'bench readback' }])?.number).toBe(2);
  });
});

describe('publishing and reading back', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close !== undefined) await close();
    close = undefined;
  });

  it('creates the issue on first use, with the label that makes it findable', async () => {
    const { seen, api, close: stop } = await server((request) => {
      if (request.method === 'GET') return { body: [] };
      return { body: { number: 11 } };
    });
    close = stop;
    const issue = await ensureIssue({ api, token: 't', repo: 'o/r' });
    expect(issue.number).toBe(11);
    // Identity is the title: the list is read without a label filter, because a label that does
    // not exist is dropped from the create call silently and the next run then makes a second issue.
    expect(seen[0]?.url).toBe('/repos/o/r/issues?state=all&per_page=100');
    expect(seen[1]).toMatchObject({ method: 'POST', url: '/repos/o/r/issues' });
    expect(JSON.parse(seen[1]?.body ?? '{}')).toMatchObject({ title: 'bench readback', labels: ['bench-readback'] });
    // The headers are the part the proxy cares about, so they are asserted rather than assumed.
    expect(seen[1]?.headers.authorization).toBe('Bearer t');
    expect(seen[1]?.headers.accept).toBe('application/vnd.github+json');
    expect(seen[1]?.headers['user-agent']).toBe('nl2charts-readback');
  });

  it('reuses the issue when the repository already has one', async () => {
    const { seen, api, close: stop } = await server(() => ({ body: [{ number: 4, title: 'bench readback' }] }));
    close = stop;
    expect((await ensureIssue({ api, token: 't', repo: 'o/r' })).number).toBe(4);
    expect(seen).toHaveLength(1);
  });

  it('posts a reading as a comment, and reports where it landed', async () => {
    const { seen, api, close: stop } = await server((request) => {
      if (request.method === 'GET') return { body: [{ number: 4, title: 'bench readback' }] };
      return { body: { id: 99, html_url: 'https://github.com/o/r/issues/4#issuecomment-99' } };
    });
    close = stop;
    const reading = digest(ARTIFACT, VES, { commit: 'abc' });
    const published = await publish({ api, token: 't', repo: 'o/r', reading });
    expect(published).toEqual({ issue: 4, comment: 99, url: 'https://github.com/o/r/issues/4#issuecomment-99' });
    expect(seen[1]?.url).toBe('/repos/o/r/issues/4/comments');
    expect(parseBody(JSON.parse(seen[1]?.body ?? '{}').body)?.arms[0]?.arm).toBe('select-cross');
  });

  it('honours an explicit issue number instead of looking one up', async () => {
    const { seen, api, close: stop } = await server(() => ({ body: { id: 5, html_url: 'u' } }));
    close = stop;
    await publish({ api, token: 't', repo: 'o/r', reading: digest(ARTIFACT), issue: 77 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/repos/o/r/issues/77/comments');
  });

  it('reads the newest reading, skipping conversation and reaching into the next page', async () => {
    const older = bodyOf(digest({ ...ARTIFACT, generatedAt: 'old' }));
    const newer = bodyOf(digest({ ...ARTIFACT, generatedAt: 'new' }));
    const asked: string[] = [];
    const { api, close: stop } = await server((request) => {
      asked.push(request.url ?? '');
      if (request.url?.includes('/issues?') === true) return { body: [{ number: 4, title: 'bench readback' }] };
      if (request.url?.endsWith('page=1') === true) {
        return { body: [{ id: 1, body: older, html_url: 'a' }, { id: 2, body: 'chatter', html_url: 'b' }] };
      }
      if (request.url?.endsWith('page=2') === true) return { body: [{ id: 3, body: newer, html_url: 'c' }] };
      return { body: [] };
    });
    close = stop;
    const found = await read({ api, token: 't', repo: 'o/r' });
    // Two pages of comments and then an empty one: the newest reading is on the second, and the
    // read does not stop at the first because the first is not the newest.
    expect(asked.filter((url) => url.includes('comments'))).toHaveLength(3);
    expect(found?.comment).toBe(3);
    expect(found?.reading.generatedAt).toBe('new');
  });

  it('stops at the end of the list rather than asking for pages that cannot exist', async () => {
    const calls: string[] = [];
    const { api, close: stop } = await server((request) => {
      calls.push(request.url ?? '');
      if (request.url?.includes('/issues?') === true) return { body: [{ number: 4, title: 'bench readback' }] };
      if (request.url?.endsWith('page=1') === true) return { body: [{ id: 1, body: 'chatter', html_url: 'a' }] };
      return { body: [] };
    });
    close = stop;
    // Page 1 holds one comment that is not a reading and page 2 is empty: the read stops there and
    // reports no reading, instead of walking the three pages it was allowed.
    expect(await read({ api, token: 't', repo: 'o/r', pages: 5 })).toBeUndefined();
    expect(calls.filter((url) => url.includes('comments'))).toEqual([
      '/repos/o/r/issues/4/comments?per_page=100&page=1',
      '/repos/o/r/issues/4/comments?per_page=100&page=2',
    ]);
  });

  it('reports an HTTP failure with the status and the body it got', async () => {
    const { api, close: stop } = await server(() => ({ status: 401, body: { message: 'Bad credentials' } }));
    close = stop;
    await expect(read({ api, token: 't', repo: 'o/r', issue: 1 })).rejects.toThrow(/answered 401.*Bad credentials/u);
  });
});

describe('the command line', () => {
  it('proves the digest round trip without a network', async () => {
    const { out, restore } = capture();
    const code = await main(['node', 'readback.mjs', '--self-test']);
    restore();
    expect(code).toBe(0);
    expect(out.join('')).toContain('self-test: ok');
  });

  it('refuses to run without the two environment variables it cannot guess', async () => {
    const { err, restore } = capture();
    const code = await main(['node', 'readback.mjs', '--read'], {});
    restore();
    expect(code).toBe(2);
    expect(err.join('')).toContain('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  });

  it('says which of the three modes it needs when given none', async () => {
    const { err, restore } = capture();
    const code = await main(['node', 'readback.mjs'], { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' });
    restore();
    expect(code).toBe(2);
    expect(err.join('')).toContain('one of --publish, --read or --self-test is required');
  });

  it('publishes what the run wrote, with the run coordinates attached', async () => {
    const { dir, path } = withArtifact(ARTIFACT);
    const { seen, api, close: stop } = await server((request) => {
      if (request.method === 'GET') return { body: [{ number: 4, title: 'bench readback' }] };
      return { body: { id: 1, html_url: 'u' } };
    });
    const { out, restore } = capture();
    const code = await main(['node', 'readback.mjs', '--publish', '--channel', 'issue', '--out', path], {
      GITHUB_TOKEN: 't',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_SHA: 'deadbeef',
      GITHUB_WORKFLOW: 'bird-dev',
      GITHUB_RUN_ID: '9',
      READBACK_API: api,
    });
    restore();
    await stop();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out.join('')).toContain('published 2 arms');
    const posted = parseBody(JSON.parse(seen[1]?.body ?? '{}').body);
    expect(posted).toMatchObject({ commit: 'deadbeef', workflow: 'bird-dev', runId: '9' });
    // The VES file the workflow did not write is absent, so the reading has no R-VES block rather
    // than a zeroed one.
    expect(posted?.rves).toBeUndefined();
  });

  it('publishes the V-RES block when the run measured one', async () => {
    const { dir, path } = withArtifact(ARTIFACT);
    const vesDir = mkdtempSync(join(tmpdir(), 'readback-ves-'));
    const vesPath = join(vesDir, 'bird-ves.json');
    writeFileSync(vesPath, JSON.stringify(VES));
    const { seen, api, close: stop } = await server((request) => {
      if (request.method === 'GET') return { body: [{ number: 4, title: 'bench readback' }] };
      return { body: { id: 1, html_url: 'u' } };
    });
    const { restore } = capture();
    const code = await main(['node', 'readback.mjs', '--publish', '--channel', 'issue', '--out', path, '--ves', vesPath], {
      GITHUB_TOKEN: 't',
      GITHUB_REPOSITORY: 'o/r',
      READBACK_API: api,
    });
    restore();
    await stop();
    rmSync(dir, { recursive: true, force: true });
    rmSync(vesDir, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(parseBody(JSON.parse(seen[1]?.body ?? '{}').body)?.rves).toMatchObject({ rves: 56.63, floor: 57.96, net: -1.33 });
  });

  it('refuses to publish an artifact that is not there, rather than an empty reading', async () => {
    const { err, restore } = capture();
    const code = await main(['node', 'readback.mjs', '--publish', '--out', join(tmpdir(), 'definitely-absent.json')], {
      GITHUB_TOKEN: 't',
      GITHUB_REPOSITORY: 'o/r',
    });
    restore();
    expect(code).toBe(4);
    expect(err.join('')).toContain('nothing to publish');
  });

  it('reads the newest reading and prints it, as Markdown or as JSON', async () => {
    const body = bodyOf(digest(ARTIFACT, VES));
    const routes = (request: { url: string }) => {
      if (request.url.includes('/issues?') === true) return { body: [{ number: 4, title: 'bench readback' }] };
      return { body: [{ id: 1, body, html_url: 'u' }] };
    };
    const markdown = await server(routes);
    const json = await server(routes);
    const first = capture();
    expect(await main(['node', 'readback.mjs', '--read', '--channel', 'issue'], { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', READBACK_API: markdown.api })).toBe(0);
    first.restore();
    expect(first.out.join('')).toContain('| `select-cross` | 378/600 |');
    const second = capture();
    expect(await main(['node', 'readback.mjs', '--read', '--channel', 'issue', '--json'], { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', READBACK_API: json.api })).toBe(0);
    second.restore();
    expect(JSON.parse(second.out.join('')).split).toBe('dev');
    await markdown.close();
    await json.close();
  });

  it('says the issue holds no reading, with an exit code that is not a success', async () => {
    const { api, close: stop } = await server((request) => {
      if (request.url?.includes('/issues?') === true) return { body: [{ number: 4, title: 'bench readback' }] };
      return { body: [] };
    });
    const { err, restore } = capture();
    const code = await main(['node', 'readback.mjs', '--read', '--channel', 'issue'], { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', READBACK_API: api });
    restore();
    await stop();
    expect(code).toBe(3);
    expect(err.join('')).toContain('no comment on the issue carries a reading');
  });
});

describe('the branch channel', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close !== undefined) await close();
    close = undefined;
  });

  /**
   * A contents API, close enough to the real one: refs that may or may not exist, one file that
   * may or may not have been written, and a sha the write has to name when it replaces a file.
   */
  const contents = (state: { branch?: boolean; file?: { body: string; sha: string }; defaultBranch?: string }) =>
    (request: { method: string; url: string; body: string }) => {
      if (request.url === '/repos/o/r') return { body: { default_branch: state.defaultBranch ?? 'master' } };
      if (request.url === '/repos/o/r/git/ref/heads/readback') {
        if (state.branch !== true) return { status: 404, body: { message: 'Not Found' } };
        return { body: { object: { sha: 'head-of-readback' } } };
      }
      if (request.url === '/repos/o/r/git/ref/heads/master') return { body: { object: { sha: 'head-of-master' } } };
      if (request.url === '/repos/o/r/git/refs') {
        state.branch = true;
        return { body: { ref: 'refs/heads/readback' } };
      }
      if (request.url === '/repos/o/r/contents/readings/index.json' && request.method === 'PUT') {
        const payload = JSON.parse(request.body);
        state.file = { body: Buffer.from(payload.content, 'base64').toString('utf8'), sha: 'next-sha' };
        return { body: { commit: { sha: 'commit-sha' } } };
      }
      if (request.url.startsWith('/repos/o/r/contents/readings/index.json')) {
        if (state.file === undefined) return { status: 404, body: { message: 'Not Found' } };
        return { body: { content: Buffer.from(state.file.body, 'utf8').toString('base64'), sha: state.file.sha } };
      }
      return { status: 500, body: { message: `unexpected ${request.method} ${request.url}` } };
    };

  it('files a reading under a slug a later reader can name', () => {
    expect(slugOf({ GITHUB_WORKFLOW: 'bird dev' })).toBe('bird-dev');
    expect(slugOf({ GITHUB_WORKFLOW: ' POC reproduction ' })).toBe('poc-reproduction');
    expect(slugOf({}, 'Select Cross Tie')).toBe('select-cross-tie');
    // A workflow name that is all punctuation is not a key; the fallback is the channel's own name.
    expect(slugOf({ GITHUB_WORKFLOW: '///' })).toBe('bench');
    expect(slugOf({})).toBe('bench');
  });

  it('replaces its own entry and leaves every other workflow alone', () => {
    const merged = mergeReading({ readings: { other: digest({ ...ARTIFACT, split: 'minidev' }) } }, 'mine', digest(ARTIFACT));
    expect(Object.keys(merged.readings).sort()).toEqual(['mine', 'other']);
    expect(merged.version).toBe(1);
    // An absent index is the first publish, and the merge must not need one.
    expect(Object.keys(mergeReading(undefined, 'mine', digest(ARTIFACT)).readings)).toEqual(['mine']);
  });

  it('picks the newest entry by the run that wrote it, not by key order', () => {
    const older = digest({ ...ARTIFACT, generatedAt: '2026-01-01T00:00:00.000Z' });
    const newer = digest({ ...ARTIFACT, generatedAt: '2026-11-01T00:00:00.000Z' });
    expect(latestReading({ readings: { z: older, a: newer } })?.[0]).toBe('a');
    expect(latestReading({ readings: {} })).toBeUndefined();
    expect(latestReading(undefined)).toBeUndefined();
  });

  it('creates the branch from the default head on the first publish, and reuses it afterwards', async () => {
    const state: { branch?: boolean } = {};
    const { seen, api, close: stop } = await server(contents(state));
    close = stop;
    expect(await ensureBranch({ api, token: 't', repo: 'o/r' })).toBe('readback');
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'GET /repos/o/r/git/ref/heads/readback',
      'GET /repos/o/r',
      'GET /repos/o/r/git/ref/heads/master',
      'POST /repos/o/r/git/refs',
    ]);
    expect(JSON.parse(seen[3]?.body ?? '{}')).toEqual({ ref: 'refs/heads/readback', sha: 'head-of-master' });
    expect(seen.filter((entry) => entry.url.endsWith('/git/ref/heads/readback')).length).toBe(1);

    const again = await server(contents({ branch: true }));
    expect(await ensureBranch({ api: again.api, token: 't', repo: 'o/r' })).toBe('readback');
    expect(again.seen).toHaveLength(1);
    await again.close();
  });

  it('publishes into an empty index, and then into the one it wrote', async () => {
    const state: { branch?: boolean; file?: { body: string; sha: string } } = { branch: true };
    const { seen, api, close: stop } = await server(contents(state));
    close = stop;
    const reading = digest(ARTIFACT, VES, { commit: 'abc' });
    const first = await publishToBranch({ api, token: 't', repo: 'o/r', slug: 'bird-dev', reading });
    expect(first).toEqual({ branch: 'readback', path: 'readings/index.json', commit: 'commit-sha', slug: 'bird-dev', readings: 1 });
    const put = seen.find((entry) => entry.method === 'PUT');
    const payload = JSON.parse(put?.body ?? '{}');
    // The first write names no sha — there is no file to replace — and says what it is in a message
    // a `git log` reader can follow without opening the blob.
    expect(payload.sha).toBeUndefined();
    expect(payload.message).toContain('bench(readback): bird-dev dev deepseek-chat 2 arm(s)');
    expect(payload.branch).toBe('readback');

    const second = await publishToBranch({ api, token: 't', repo: 'o/r', slug: 'bird-other', reading: digest(ARTIFACT) });
    expect(second.readings).toBe(2);
    const replacement = JSON.parse([...seen].reverse().find((entry) => entry.method === 'PUT')?.body ?? '{}');
    // The second write names the sha it replaces, because a contents write without one is a 409.
    expect(replacement.sha).toBe('next-sha');
  });

  it('reads the index it wrote, by slug or by recency', async () => {
    const state: { branch?: boolean; file?: { body: string; sha: string } } = { branch: true };
    const { api, close: stop } = await server(contents(state));
    close = stop;
    await publishToBranch({ api, token: 't', repo: 'o/r', slug: 'bird-dev', reading: digest(ARTIFACT, VES, { commit: 'abc' }) });
    const bySlug = await readFromBranch({ api, token: 't', repo: 'o/r', slug: 'bird-dev' });
    expect(bySlug?.slug).toBe('bird-dev');
    expect(bySlug?.reading.rves?.rves).toBe(56.63);
    const newest = await readFromBranch({ api, token: 't', repo: 'o/r' });
    expect(newest?.slug).toBe('bird-dev');
    expect(await readFromBranch({ api, token: 't', repo: 'o/r', slug: 'absent' })).toBeUndefined();
  });

  it('treats a missing index as an empty one, and a refused request as a refusal', async () => {
    const missing = await server(() => ({ status: 404, body: { message: 'Not Found' } }));
    expect(await readIndex({ api: missing.api, token: 't', repo: 'o/r' })).toEqual({ index: { version: 1, readings: {} }, sha: undefined });
    await missing.close();
    const refused = await server(() => ({ status: 403, body: { message: 'Resource not accessible by personal access token' } }));
    // A 403 is not "empty": publishing over an index the token cannot read would drop every other
    // workflow's reading, so the failure has to stay a failure.
    await expect(readIndex({ api: refused.api, token: 't', repo: 'o/r' })).rejects.toThrow(/answered 403/u);
    await refused.close();
  });

  it('publishes and reads back through the command line, with the slug from the workflow', async () => {
    const state: { branch?: boolean; file?: { body: string; sha: string } } = {};
    const { api, close: stop } = await server(contents(state));
    const { dir, path } = withArtifact(ARTIFACT);
    const published = capture();
    const code = await main(['node', 'readback.mjs', '--publish', '--out', path], {
      GITHUB_TOKEN: 't',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_WORKFLOW: 'bird dev',
      GITHUB_SHA: 'deadbeef',
      READBACK_API: api,
    });
    published.restore();
    expect(code).toBe(0);
    expect(published.out.join('')).toContain('published 2 arms as bird-dev on readback');

    const readBack = capture();
    const readCode = await main(['node', 'readback.mjs', '--read', '--slug', 'bird-dev', '--json'], {
      GITHUB_TOKEN: 't',
      GITHUB_REPOSITORY: 'o/r',
      READBACK_API: api,
    });
    readBack.restore();
    rmSync(dir, { recursive: true, force: true });
    expect(readCode).toBe(0);
    expect(JSON.parse(readBack.out.join('')).commit).toBe('deadbeef');
    await stop();
  });

  it('says the branch holds no such slug rather than printing an empty reading', async () => {
    const state: { branch?: boolean; file?: { body: string; sha: string } } = { branch: true };
    const { api, close: stop } = await server(contents(state));
    const { err, restore } = capture();
    const code = await main(['node', 'readback.mjs', '--read', '--slug', 'never-ran'], { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', READBACK_API: api });
    restore();
    await stop();
    expect(code).toBe(3);
    expect(err.join('')).toContain('holds no reading for that slug');
  });

  it('opens an issue only when the issue channel is the one asked for', async () => {
    const { seen, api, close: stop } = await server((request) => {
      if (request.method === 'GET' && request.url.includes('/issues?') === true) return { body: [{ number: 5, title: 'bench readback' }] };
      return { body: { id: 1, html_url: 'u' } };
    });
    const { dir, path } = withArtifact(ARTIFACT);
    const { restore } = capture();
    const code = await main(['node', 'readback.mjs', '--publish', '--channel', 'issue', '--out', path], {
      GITHUB_TOKEN: 't',
      GITHUB_REPOSITORY: 'o/r',
      READBACK_API: api,
    });
    restore();
    await stop();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(seen.map((entry) => entry.url)).toEqual(['/repos/o/r/issues?state=all&per_page=100', '/repos/o/r/issues/5/comments']);
  });
});
