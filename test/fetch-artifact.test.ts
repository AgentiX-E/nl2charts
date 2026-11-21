/**
 * The artifact channel, tested against a server that behaves like the one that broke it.
 *
 * The defect this file exists for is not a logic error: `/actions/artifacts/{id}/zip` redirects to a
 * signed storage URL, the client forwards its bearer token to that URL, and the storage service
 * refuses a token it did not issue. The request had a valid signature and answered 401, which is why
 * five rounds believed the artifact was unreadable. A unit test over a stubbed `fetch` would have
 * agreed with the stub; the second server below refuses exactly what the real one refuses, and the
 * assertions are about the header it received rather than about the bytes it returned.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError, downloadArtifact, fetchWithoutForwardedAuth, listArtifacts, main, parseArgs, readZip, unpack } from '../tools/fetch-artifact.mjs';

/** CRC-32, which a stored zip entry needs even though nothing is compressed. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip holding `files`, stored (or deflated) — the smallest archive the reader has to accept. */
export function zipOf(files: Record<string, string>, deflate = false, methodOverride?: number): Buffer {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const body = deflate ? deflateRawSync(raw) : raw;
    const method = methodOverride ?? (deflate ? 8 : 0);
    const nameBytes = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(0, 10);
    header.writeUInt32LE(crc32(raw), 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    locals.push(header, nameBytes, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(0, 12);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}

/** What a handler says: a status, headers, and a body that may be bytes. */
interface Answer {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string | Buffer | unknown;
}

/** A server that records what it was asked and answers with `handler`. */
async function server(handler: (request: { url?: string; headers: { authorization?: string } }, count: number) => Answer) {
  const seen: { url?: string; authorization: string | null }[] = [];
  const instance = createServer((request, response) => {
    seen.push({ url: request.url, authorization: request.headers.authorization ?? null });
    const answer = handler(request, seen.length);
    response.writeHead(answer.status ?? 200, answer.headers ?? { 'content-type': 'application/json' });
    // A Buffer is bytes, not JSON: stringifying it would turn a zip into a list of numbers, which is
    // what made the download test read `not a zip` instead of an assertion about headers.
    response.end(Buffer.isBuffer(answer.body) ? answer.body : answer.body === undefined ? '' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', () => resolve()));
  const { port } = instance.address() as AddressInfo;
  return { api: `http://127.0.0.1:${String(port)}`, seen, close: () => new Promise<void>((resolve) => instance.close(() => resolve())) };
}

/** A storage host: a request carrying someone else's token is refused whatever its signature says. */
async function storageHost() {
  const seen: (string | null)[] = [];
  const instance = createServer((request, response) => {
    const auth = request.headers.authorization;
    seen.push(auth ?? null);
    response.writeHead(auth === undefined ? 200 : 401, auth === undefined ? { 'content-type': 'application/zip' } : {});
    response.end(auth === undefined ? ZIP : 'Server failed to authenticate the request');
  });
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', () => resolve()));
  const { port } = instance.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, seen, close: () => new Promise<void>((resolve) => instance.close(() => resolve())) };
}

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closes.length > 0) await (closes.pop() as () => Promise<void>)();
});

/** The zip this project's runs actually produce: a few JSON files, one of them nested. */
const ZIP = zipOf({ 'bird-eval.json': '{"arms":[]}', 'readings/index.json': '{"version":1}' });

describe('following the redirect that broke the download', () => {
  it('leaves the bearer token behind when the zip lives on another origin', async () => {
    const storage = await storageHost();
    closes.push(storage.close);
    const api = await server(() => ({ status: 302, headers: { location: `${storage.url}/zip` }, body: '' }));
    closes.push(api.close);

    const response = await fetchWithoutForwardedAuth(`${api.api}/repos/o/r/actions/artifacts/1/zip`, { token: 'ghp_secret' });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(ZIP)).toBe(true);
    // The assertion that matters: the storage host saw no header, so it had nothing to refuse.
    expect(storage.seen).toEqual([null]);
  });

  it('shows what the naive request would have done, which is why the tool exists', async () => {
    const storage = await storageHost();
    closes.push(storage.close);
    // A client that follows the redirect and forwards the header: the signature is fine and the
    // request is refused. This is the 401 five rounds read as "artifacts are unreadable".
    const naive = await fetch(`${storage.url}/zip`, { headers: { Authorization: 'Bearer ghp_secret' } });
    expect(naive.status).toBe(401);
    const clean = await fetch(`${storage.url}/zip`);
    expect(clean.status).toBe(200);
  });

  it('keeps the token on a redirect that stays on the same origin', async () => {
    const api = await server((request) =>
      request.url === '/zip'
        ? { status: request.headers.authorization === 'Bearer ghp_secret' ? 200 : 401, body: request.headers.authorization === 'Bearer ghp_secret' ? ZIP : 'no token' }
        : { status: 302, headers: { location: '/zip' }, body: '' },
    );
    closes.push(api.close);
    const response = await fetchWithoutForwardedAuth(`${api.api}/repos/o/r/actions/artifacts/1/zip`, { token: 'ghp_secret' });
    expect(response.status).toBe(200);
    expect(api.seen.at(-1)?.authorization).toBe('Bearer ghp_secret');
  });

  it('reports a redirect with no Location as the failure it is', async () => {
    const api = await server(() => ({ status: 302, body: '' }));
    closes.push(api.close);
    await expect(fetchWithoutForwardedAuth(`${api.api}/x`, { token: 't' })).rejects.toThrow(/redirect with no Location header/u);
  });

  it('sends no authorization header at all when it has no token', async () => {
    const api = await server(() => ({ status: 200, body: ZIP }));
    closes.push(api.close);
    await fetchWithoutForwardedAuth(`${api.api}/x`);
    expect(api.seen[0]?.authorization).toBeNull();
  });
});

describe('the run and its artifacts', () => {
  it('lists what a run produced', async () => {
    const api = await server(() => ({ body: { artifacts: [{ id: 7, name: 'bird-dev-eval', size_in_bytes: 1234 }] } }));
    closes.push(api.close);
    const artifacts = await listArtifacts('44889941650', { repo: 'o/r', token: 't', api: api.api });
    expect(artifacts).toEqual([{ id: 7, name: 'bird-dev-eval', size_in_bytes: 1234 }]);
    expect(api.seen[0]?.url).toBe('/repos/o/r/actions/runs/44889941650/artifacts?per_page=100');
  });

  it('carries the body of a refusal into the error', async () => {
    const api = await server(() => ({ status: 403, body: { message: 'Resource not accessible by personal access token' } }));
    closes.push(api.close);
    await expect(listArtifacts('1', { repo: 'o/r', token: 't', api: api.api })).rejects.toThrow(/403.*Resource not accessible/u);
    await expect(downloadArtifact(1, { repo: 'o/r', token: 't', api: api.api })).rejects.toThrow(/403/u);
  });

  it('unpacks the files the readings are in, nested directories included', () => {
    const out = mkdtempSync(join(tmpdir(), 'fetch-artifact-'));
    try {
      const written = unpack(ZIP, out);
      expect(written.map((file) => file.name).sort()).toEqual(['bird-eval.json', 'readings/index.json']);
      expect(readFileSync(join(out, 'readings/index.json'), 'utf8')).toBe('{"version":1}');
      expect(existsSync(join(out, 'bird-eval.json'))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('reads a deflated entry, which is what a real artifact holds', () => {
    // GitHub's zips are deflated, not stored: the first version of the reader leaned on `unzipSync`,
    // which is a gzip reader and answered "incorrect header check" to a real archive.
    const deflated = zipOf({ 'deflated.json': 'x' }, true);
    expect(readZip(deflated).map((entry) => [entry.name, entry.bytes.toString('utf8')])).toEqual([['deflated.json', 'x']]);
  });

  it('refuses an entry name that would write outside the directory it was given', () => {
    const out = mkdtempSync(join(tmpdir(), 'fetch-artifact-escape-'));
    try {
      expect(() => unpack(zipOf({ '../escaped.json': '{}' }), out)).toThrow(/escapes the output directory/u);
      expect(existsSync(join(out, '..', 'escaped.json'))).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('names the format it cannot read instead of returning nothing', () => {
    expect(() => readZip(Buffer.from('not a zip at all'))).toThrow(/no end-of-central-directory record/u);
    const unsupported = zipOf({ 'a.json': '{}' }, false, 12);
    expect(() => readZip(unsupported)).toThrow(/compression method 12/u);
  });
});

describe('the command line', () => {
  const run = (argv: readonly string[], env: Record<string, string | undefined>, deps: { api?: string; stdout?: (line: string) => void; stderr?: (line: string) => void }) => main(['node', 'fetch-artifact.mjs', ...argv], env, deps);

  it('reads its arguments in the order a shell hands them over', () => {
    expect(parseArgs(['5', '--out', '/tmp/x', '--name', 'eval', '--list'])).toEqual({ runId: '5', out: '/tmp/x', name: 'eval', list: true });
    expect(parseArgs([])).toEqual({ runId: undefined, out: undefined, name: undefined, list: false });
  });

  it('refuses a call it cannot act on, before it reaches the network', async () => {
    const said: string[] = [];
    expect(await run([], { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' }, { stderr: (line) => said.push(line) })).toBe(2);
    expect(await run(['latest'], { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' }, { stderr: (line) => said.push(line) })).toBe(2);
    expect(await run(['5'], { GITHUB_TOKEN: 't' }, { stderr: (line) => said.push(line) })).toBe(2);
    expect(said.join('')).toContain('usage: fetch-artifact.mjs');
    expect(said.join('')).toContain('GITHUB_REPOSITORY and GITHUB_TOKEN');
  });

  it('names what a run holds without downloading it', async () => {
    const api = await server(() => ({ body: { artifacts: [{ id: 7, name: 'bird-dev-eval', size_in_bytes: 1234 }] } }));
    closes.push(api.close);
    const said: string[] = [];
    const code = await run(['5', '--list'], { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' }, { api: api.api, stdout: (line) => said.push(line) });
    expect(code).toBe(0);
    expect(said.join('')).toBe('bird-dev-eval  1234 B  id 7\n');
  });

  it('says so when the run has nothing, and when the name is not there', async () => {
    const empty = await server(() => ({ body: { artifacts: [] } }));
    closes.push(empty.close);
    expect(await run(['5', '--list'], { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' }, { api: empty.api, stdout: () => undefined })).toBe(3);
    const one = await server(() => ({ body: { artifacts: [{ id: 7, name: 'bird-dev-eval', size_in_bytes: 12 }] } }));
    closes.push(one.close);
    const said: string[] = [];
    const code = await run(['5', '--name', 'absent'], { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' }, { api: one.api, stderr: (line) => said.push(line) });
    expect(code).toBe(3);
    expect(said.join('')).toContain('holds no artifact named absent');
  });

  it('writes the artifact where it was told to', async () => {
    const storage = await server(() => ({ status: 200, headers: { 'content-type': 'application/zip' }, body: ZIP }));
    closes.push(storage.close);
    const api = await server((request) =>
      request.url?.includes('/artifacts') === true && request.url.endsWith('/zip') === false
        ? { body: { artifacts: [{ id: 7, name: 'bird-dev-eval', size_in_bytes: ZIP.length }] } }
        : { status: 302, headers: { location: `${storage.api}/zip` }, body: '' },
    );
    closes.push(api.close);
    const out = mkdtempSync(join(tmpdir(), 'fetch-artifact-cli-'));
    try {
      const said: string[] = [];
      const code = await run(['5', '--out', out], { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' }, { api: api.api, stdout: (line) => said.push(line) });
      expect(code).toBe(0);
      expect(said.join('')).toContain('bird-eval.json');
      expect(readFileSync(join(out, 'bird-eval.json'), 'utf8')).toBe('{"arms":[]}');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('turns a refusal into the error class the wrapper exits 4 on', async () => {
    const api = await server(() => ({ status: 401, body: 'Bad credentials' }));
    closes.push(api.close);
    await expect(run(['5'], { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' }, { api: api.api })).rejects.toBeInstanceOf(HttpError);
  });
});
