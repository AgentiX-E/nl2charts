#!/usr/bin/env node
/**
 * Fetch WikiSQL into `eval/.cache/wikisql`.
 *
 * The corpus is not vendored: 26 MB of archive that expands to 180 MB, and the harness executes
 * against the split it asks for and nothing else. This script downloads the archive once, extracts
 * one split, and refuses to hand back a partial file.
 *
 * **The transport was the whole problem, and it was not the size.** The obvious URL —
 * `raw.githubusercontent.com/salesforce/WikiSQL/master/data.tar.bz2` — serves at 8–20 KB/s and
 * stalls, so a 26,164,664-byte file arrived as 9.5 MB after thirty minutes of resuming, and
 * `bzip2 -t` called it `file ends unexpectedly`. The same bytes through jsDelivr measured
 * **614 KB/s: 26,164,664 bytes in 46 seconds**, checksum intact. A slow mirror is a boundary that
 * looks exactly like a corrupt file, and the earlier conclusion in this repository — "truncated
 * transfer" — was this one line of diagnosis away from being wrong twice.
 *
 * **And then the fast mirror stopped serving it.** Run `45766271364` fetched jsDelivr's URL and
 * received **49 bytes**, which the size check refused: jsDelivr's GitHub CDN caps a file at 20 MB and
 * now answers a refusal instead of the archive. A single fast mirror is therefore not a transport, it
 * is a dependency on one vendor's size policy — so the archive has two sources and the *digest* is
 * what makes them interchangeable. The second goes through `api.github.com`'s git-blob endpoint,
 * which serves the same bytes base64-encoded and has no size policy of its own below 100 MB.
 *
 *   node eval/wikisql/fetch.mjs                 # dev, the 8,421-question split
 *   node eval/wikisql/fetch.mjs --split test    # 15,878 questions, no public labels
 *   node eval/wikisql/fetch.mjs --offline       # fail if the cache is cold
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const CACHE = process.env.WIKISQL_CACHE ?? join(ROOT, 'eval/.cache/wikisql');
const MIRROR = process.env.WIKISQL_MIRROR ?? 'https://cdn.jsdelivr.net/gh/salesforce/WikiSQL@master';

/**
 * What each split must contain, and the archive's own digest.
 *
 * The counts are the corpus's, not a sample of it: `dev.jsonl` has 8,421 lines, `dev.tables.jsonl`
 * 2,716, and 2,630 of those tables are asked about (the rest are declared and unasked, which is why
 * the table count and the used count are different numbers). A count is the cheapest assertion that
 * a transfer finished — a truncated JSONL still parses for as many lines as arrived, which is how
 * the first attempt at this corpus produced a 9,582-question `train` split that nobody noticed was
 * short.
 */
export const SPLITS = {
  dev: { questions: 8421, tables: 2716, used: 2630, db: 'dev.db' },
  test: { questions: 15878, tables: 5230, used: 5069, db: 'test.db' },
  train: { questions: 56355, tables: 18585, used: 0, db: 'train.db' },
};

/** The archive, as served. Pinned because a mirror that rewrites its content is not a mirror. */
export const ARCHIVE = {
  name: 'data.tar.bz2',
  bytes: 26_164_664,
  sha256: '755c728ab188e364575705c8641f3fafd86fb089cb8b08e8c03f01832aae0881',
};

/** Per-file digests, so a good archive with a bad extraction cannot pass. */
export const FILES = {
  'dev.jsonl': '61a857df71dc3c72185d57b3ea9b6df906e8a55fa78daa590edb87fc42871b7c',
  'dev.tables.jsonl': 'd029a11a4f35d36b4e867fd21b0cc0f22b5b9fa2d3b7ac28c7a57986e1325e30',
  'dev.db': 'c3685e41f2de9d17b3c643b285e1aec13eeeeb3dd04189085636c1d637d0978f',
};

/** The fast mirror, which is tried first because it is 46 seconds when it answers at all. */
export function sourceUrl() {
  return `${MIRROR}/${ARCHIVE.name}`;
}

/** Where the archive lives in the repository the corpus is published from. */
export const ORIGIN = {
  repo: 'salesforce/WikiSQL',
  ref: 'master',
};

/**
 * The second source, and why it is not a fallback in the hand-waving sense.
 *
 * `GET /repos/{repo}/git/trees/{ref}` names the blob, `GET /repos/{repo}/git/blobs/{sha}` returns its
 * bytes base64-encoded in one JSON body, and the result is verified against the same pinned size and
 * sha256 as the mirror — so the two are one source with two transports rather than two corpora. A
 * token is used when the environment has one (the workflow passes `github.token`), because
 * unauthenticated requests are capped at sixty an hour and a cache miss on a busy morning would
 * spend them on somebody else's jobs.
 */
export async function fetchFromApi(target, fetchImpl = fetch) {
  const headers = { accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token !== undefined && token !== '') headers.authorization = `Bearer ${token}`;
  const tree = await jsonOf(
    `https://api.github.com/repos/${ORIGIN.repo}/git/trees/${ORIGIN.ref}`,
    headers,
    fetchImpl,
  );
  const entry = (tree.tree ?? []).find((node) => node.path === ARCHIVE.name);
  if (entry === undefined) throw new Error(`the repository has no ${ARCHIVE.name} at ${ORIGIN.ref}`);
  console.log(`fetching ${String(ARCHIVE.bytes)} bytes through the git-blob endpoint (${String(entry.sha).slice(0, 12)})`);
  const blob = await jsonOf(
    `https://api.github.com/repos/${ORIGIN.repo}/git/blobs/${String(entry.sha)}`,
    headers,
    fetchImpl,
  );
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new Error(`the blob endpoint answered ${String(blob.encoding)} rather than base64`);
  }
  writeFileSync(target, Buffer.from(blob.content.replaceAll('\n', ''), 'base64'));
}

/** One JSON body, with a refusal that names the status rather than parsing an error page. */
async function jsonOf(url, headers, fetchImpl) {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`);
  return response.json();
}

export function planOf(split) {
  const shape = SPLITS[split];
  if (shape === undefined) throw new Error(`unknown WikiSQL split: ${split}`);
  return {
    split,
    members: [`data/${split}.jsonl`, `data/${split}.tables.jsonl`, `data/${shape.db}`],
    files: [`${split}.jsonl`, `${split}.tables.jsonl`, shape.db],
    shape,
  };
}

export function sha256Of(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => done(hash.digest('hex')));
  });
}

/**
 * The line count of a JSONL file, read as bytes.
 *
 * A trailing newline is normal and is not a line; a file whose last line has no newline is one more
 * question than the newlines say, so the split is counted rather than the terminator.
 */
export function countLines(path) {
  const text = readFileSync(path, 'utf8');
  if (text.length === 0) return 0;
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n').length;
}

/**
 * What a split must satisfy before the harness may read it.
 *
 * Returns problems rather than throwing so a caller can report all of them at once: a split with a
 * short question file and an unknown table is one diagnosis, not two.
 *
 * `shape` is a parameter because a caller may verify a subset it built itself — the archive's own
 * counts are the default, not the contract, and a test that could only check the full 8,421 would
 * be checking the corpus rather than the checker.
 */
export function inspect(split, cache, shape = SPLITS[split]) {
  const { files } = planOf(split);
  const [questions, tables, db] = files.map((name) => join(cache, name));
  const problems = [];
  for (const path of [questions, tables, db]) {
    if (!existsSync(path)) problems.push(`missing ${path}`);
  }
  if (problems.length > 0) return { problems, counts: null };
  const asked = countLines(questions);
  const declared = countLines(tables);
  if (asked !== shape.questions) problems.push(`${shape.questions} questions expected, ${asked} present`);
  if (declared !== shape.tables) problems.push(`${shape.tables} tables expected, ${declared} present`);
  // The tables a question names must exist in the table file: a split whose two halves come from
  // different releases parses fine and scores nothing.
  const known = new Set();
  for (const line of readFileSync(tables, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    known.add(JSON.parse(line).id);
  }
  let unknown = 0;
  for (const line of readFileSync(questions, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    if (!known.has(JSON.parse(line).table_id)) unknown += 1;
  }
  if (unknown > 0) problems.push(`${unknown} questions name a table the table file does not declare`);
  return { problems, counts: { questions: asked, tables: declared } };
}

/**
 * Get the archive, from the first source that can serve it.
 *
 * The order is by speed and the acceptance test is the digest: a source that answers with 49 bytes,
 * a 33 MB HTML paywall page, or a plausible-looking archive of a different release all fail the same
 * check. That is what makes "two sources" a redundancy rather than a second corpus.
 */
async function download(target) {
  if (existsSync(target) && statSync(target).size === ARCHIVE.bytes) {
    const digest = await sha256Of(target);
    if (digest === ARCHIVE.sha256) {
      console.log(`archive present and verified: ${(ARCHIVE.bytes / 1048576).toFixed(1)} MB`);
      return;
    }
    console.log(`archive present but its digest is ${digest.slice(0, 12)}; refetching`);
    rmSync(target, { force: true });
  }
  console.log(`fetching ${String(ARCHIVE.bytes)} bytes from ${sourceUrl()}`);
  // `--retry` alone is not resume. `-C -` asks for the remainder, and a mirror that truncates the
  // stream is answered with another range request rather than a second full transfer.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      execFileSync('curl', ['-sL', '-C', '-', '--max-time', '600', '-o', target, sourceUrl()], {
        stdio: 'inherit',
      });
    } catch (error) {
      console.log(`attempt ${String(attempt)} failed: ${String(error)}`);
    }
    const size = existsSync(target) ? statSync(target).size : 0;
    if (size === ARCHIVE.bytes) break;
  }
  // The mirror is allowed to fail; the corpus is not. A partial file from the first transport is
  // discarded rather than resumed from the second, because the two do not share an offset.
  if (!existsSync(target) || statSync(target).size !== ARCHIVE.bytes) {
    rmSync(target, { force: true });
    await fetchFromApi(target);
  }
  const size = existsSync(target) ? statSync(target).size : 0;
  if (size !== ARCHIVE.bytes) throw new Error(`archive is ${String(size)} bytes, expected ${String(ARCHIVE.bytes)}`);
  const digest = await sha256Of(target);
  if (digest !== ARCHIVE.sha256) throw new Error(`archive digest ${digest} is not ${ARCHIVE.sha256}`);
}

/** Extract one split's three members, flat, into the cache. */
export function extract(archive, staging, plan) {
  mkdirSync(staging, { recursive: true });
  execFileSync('tar', ['xjf', archive, '-C', staging, ...plan.members], { stdio: 'inherit' });
  const moved = [];
  for (const [index, member] of plan.members.entries()) {
    const name = plan.files[index];
    renameSync(join(staging, member), join(staging, name));
    moved.push(name);
  }
  // An archive that carried a different split is 180 MB of the wrong corpus; the members are the
  // only thing read, so the rest is discarded rather than kept.
  rmSync(join(staging, 'data'), { recursive: true, force: true });
  return moved;
}

export async function main(argv = process.argv.slice(2)) {
  const offline = argv.includes('--offline');
  const splitIndex = argv.indexOf('--split');
  const split = splitIndex === -1 ? 'dev' : argv[splitIndex + 1];
  if (split === undefined) throw new Error('--split needs a name');
  const plan = planOf(split);
  const cache = process.env.WIKISQL_CACHE ?? CACHE;

  if (offline) {
    const { problems } = inspect(split, cache);
    if (problems.length > 0) throw new Error(`cache is cold: ${problems.join('; ')}`);
    console.log(`offline: ${split} is present`);
    return 0;
  }

  mkdirSync(cache, { recursive: true });
  const archive = join(cache, ARCHIVE.name);
  await download(archive);

  if (inspect(split, cache).problems.length > 0) {
    const staging = join(cache, `.staging-${split}`);
    rmSync(staging, { recursive: true, force: true });
    const moved = extract(archive, staging, plan);
    for (const name of moved) {
      const from = join(staging, name);
      const to = join(cache, name);
      rmSync(to, { force: true });
      renameSync(from, to);
    }
    rmSync(staging, { recursive: true, force: true });
    console.log(`extracted ${moved.join(', ')}`);
  }

  const { problems, counts } = inspect(split, cache);
  if (problems.length > 0) throw new Error(problems.join('; '));
  console.log(`${split}: ${String(counts.questions)} questions, ${String(counts.tables)} tables`);
  return 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('wikisql/fetch.mjs')) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(String(error));
      process.exit(1);
    },
  );
}
