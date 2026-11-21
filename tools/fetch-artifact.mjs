#!/usr/bin/env node
/**
 * Fetch a workflow run's artifact through the API, which is the only route this sandbox has.
 *
 * Every round of this project needs the same thing: the artifact a dispatched run produced, so a
 * reading can be read case by case instead of quoted from a workflow step. For several rounds the
 * download answered **401**, and the conclusion drawn from that — "the artifact is served from a
 * signed URL a token cannot open" — is why `tools/readback.mjs` exists at all. It publishes a
 * summary to a branch, which was a workaround, not a design.
 *
 * The 401 was not the artifact. `/actions/artifacts/{id}/zip` answers 302 to a storage URL that
 * carries its own signature, and both `urllib` and `fetch` forward the caller's `Authorization`
 * header to that URL. The storage service treats a token it did not issue as a reason to refuse, so
 * a valid signature fails anyway. Dropping the header on the redirect — and only on a redirect to
 * another origin — returns 200 and the same bytes the Actions page downloads. That is the whole
 * fix, and this tool exists because "remember to strip a header" is not a thing to remember.
 *
 *   GITHUB_REPOSITORY=owner/repo GH_TOKEN=... node tools/fetch-artifact.mjs 44889941650 --out /tmp/run
 *   GITHUB_REPOSITORY=owner/repo GH_TOKEN=... node tools/fetch-artifact.mjs 44889941650 --list
 *
 * Exit codes: 0 fetched, 2 usage, 3 no artifact, 4 the API refused.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const DEFAULT_API = 'https://api.github.com';

/** A refusal by GitHub, with the status and the body that says why. */
export class HttpError extends Error {
  constructor(status, what, detail) {
    super(`${what} -> ${String(status)}: ${detail}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * One request, following a redirect with the bearer token left behind.
 *
 * Same-origin redirects keep the header, because that is the only case where it is still ours to
 * send. Cross-origin redirects do not, and that is the case the API produces: the zip lives on a
 * storage host whose URL is already signed.
 */
export async function fetchWithoutForwardedAuth(url, { token, fetchImpl = fetch } = {}) {
  const first = new URL(url);
  const auth = token === undefined ? {} : { Authorization: `Bearer ${token}` };
  const response = await fetchImpl(url, { redirect: 'manual', headers: { ...auth, Accept: 'application/vnd.github+json' } });
  if (response.status < 300 || response.status >= 400) return response;
  const location = response.headers.get('location');
  if (location === null) throw new HttpError(response.status, url, 'redirect with no Location header');
  // Relative like `/zip` or absolute like `https://…/zip`: both are what a redirect may say, and the
  // origin comparison has to be made against the resolved URL rather than the header text.
  const next = new URL(location, first);
  return fetchImpl(next, { headers: next.origin === first.origin ? auth : {} });
}

/** One run's artifacts, as the API lists them. */
export async function listArtifacts(runId, { repo, token, api = DEFAULT_API, fetchImpl = fetch }) {
  const url = `${api}/repos/${repo}/actions/runs/${String(runId)}/artifacts?per_page=100`;
  const response = await fetchImpl(url, {
    headers: { ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }), Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new HttpError(response.status, `artifacts of run ${String(runId)}`, await response.text());
  const body = await response.json();
  return body.artifacts ?? [];
}

/** The zip bytes for one artifact, through the redirect a naive client cannot follow. */
export async function downloadArtifact(artifactId, { repo, token, api = DEFAULT_API, fetchImpl = fetch }) {
  const response = await fetchWithoutForwardedAuth(`${api}/repos/${repo}/actions/artifacts/${String(artifactId)}/zip`, {
    token,
    fetchImpl,
  });
  if (!response.ok) throw new HttpError(response.status, `artifact ${String(artifactId)}`, await response.text());
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Read a zip into its entries.
 *
 * Written here rather than imported because this script runs in workflows that execute it *before*
 * `pnpm install`, which is the same constraint that keeps `tools/` in plain JavaScript. Node's
 * `unzipSync` is not a zip reader — it auto-detects gzip and deflate streams and rejects a real
 * archive with "incorrect header check", which is what the first version of this file did.
 *
 * Stored and deflated entries are the two methods GitHub's artifact zips use; anything else is
 * refused by name rather than misread, because a silent skip here would look like an empty run.
 */
export function readZip(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const floor = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (floor < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = buffer.readUInt16LE(floor + 10);
  let at = buffer.readUInt32LE(floor + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error(`corrupt zip: central entry ${String(index)} has no signature`);
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressed);
    if (!name.endsWith('/')) {
      if (method === 0) entries.push({ name, bytes: raw });
      else if (method === 8) entries.push({ name, bytes: inflateRawSync(raw) });
      else throw new Error(`zip entry ${name} uses compression method ${String(method)}, which this reader does not implement`);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Unpack a zip into `outDir` and report what was written.
 *
 * The entries are the few JSON files a run produces, so this writes them and nothing else: no
 * permission bits, no symlinks, and no path outside `outDir` — an artifact is data this repository
 * published, and a reader that trusts an entry name with `..` in it is a reader that writes wherever
 * a run says.
 */
export function unpack(zipBytes, outDir) {
  mkdirSync(outDir, { recursive: true });
  const root = resolve(outDir);
  const written = [];
  for (const entry of readZip(zipBytes)) {
    const path = resolve(root, entry.name);
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`zip entry ${entry.name} escapes the output directory`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry.bytes);
    written.push({ name: entry.name, path, bytes: entry.bytes.length });
  }
  return written;
}

export function parseArgs(argv) {
  const args = { runId: undefined, out: undefined, name: undefined, list: false };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--list') args.list = true;
    else if (arg === '--out') args.out = argv[++index];
    else if (arg === '--name') args.name = argv[++index];
    else rest.push(arg);
  }
  [args.runId] = rest;
  return args;
}

export async function main(argv = process.argv, env = process.env, deps = {}) {
  // `argv` is the whole `process.argv`, as in `tools/readback.mjs`: the two scripts are called the
  // same way from a workflow and from a test, and a second convention for the same three words is a
  // test that passes while the command line is broken.
  const args = parseArgs(argv.slice(2));
  const write = deps.stdout ?? ((line) => process.stdout.write(line));
  const fail = deps.stderr ?? ((line) => process.stderr.write(line));
  if (args.runId === undefined || !/^\d+$/.test(args.runId)) {
    fail('usage: fetch-artifact.mjs <runId> [--out DIR] [--name NAME] [--list]\n');
    return 2;
  }
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (repo === undefined || token === undefined) {
    fail('fetch-artifact: GITHUB_REPOSITORY and GITHUB_TOKEN (or GH_TOKEN) are required\n');
    return 2;
  }
  const options = { repo, token, ...(deps.api === undefined ? {} : { api: deps.api }), ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }) };
  const artifacts = await listArtifacts(args.runId, options);
  if (args.list) {
    for (const artifact of artifacts) write(`${artifact.name}  ${String(artifact.size_in_bytes)} B  id ${String(artifact.id)}\n`);
    return artifacts.length === 0 ? 3 : 0;
  }
  const chosen = artifacts.filter((artifact) => args.name === undefined || artifact.name === args.name);
  if (chosen.length === 0) {
    fail(`fetch-artifact: run ${args.runId} holds no artifact named ${String(args.name)}\n`);
    return 3;
  }
  for (const artifact of chosen) {
    const bytes = await downloadArtifact(artifact.id, options);
    for (const file of unpack(bytes, args.out ?? '.')) write(`fetch-artifact: ${file.name} ${String(file.bytes)} B -> ${file.path}\n`);
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`fetch-artifact: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(error instanceof HttpError ? 4 : 1);
    },
  );
}
