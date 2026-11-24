#!/usr/bin/env node
/**
 * Fetch nvBench 2.0 into `eval/.cache/nvbench2`.
 *
 * The benchmark is 107 MB in one repository and the corpus is three artifacts: two question files
 * (3.3 MB each) and one 18.4 MB archive of 803 CSV tables. Nothing here is executed — the judge
 * compares Vega-Lite fragments, so the tables are read for their column types and that is all — and
 * that is why the split is worth fetching at all: the whole judgement is local and costs nothing.
 *
 * **The third artifact is past jsDelivr's per-file limit and the first two are not.** `train.json`
 * is 27.5 MB and the mirror answers **403** for it, while `dev.json` (3.3 MB) and
 * `database_csv.zip` (18.4 MB) arrive intact. The train split has no role here — this repository
 * does not fine-tune — so it is named in `OUT_OF_SCOPE` rather than silently absent from the list.
 *
 *   node eval/nvbench2/fetch.mjs                 # dev, test, and the 803 tables
 *   node eval/nvbench2/fetch.mjs --offline       # fail if the cache is cold
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const DEFAULT_CACHE = join(ROOT, 'eval/.cache/nvbench2');
const MIRROR = process.env.NVBENCH2_MIRROR ?? 'https://cdn.jsdelivr.net/gh/HKUSTDial/nvBench-2.0@main';

/**
 * The three artifacts, pinned by byte count and digest.
 *
 * A mirror that rewrites its content is not a mirror, and the failure it produces is not "the
 * fetch broke" — it is "today's score is two points higher than yesterday's", which is the worst
 * kind of quiet. The archive expands to `database_csv/` with 803 tables and, beside it, an
 * `__MACOSX/database_csv/` holding 803 AppleDouble files that also end in `.csv`; a recursive
 * listing therefore finds 1,606 of them and half are 4 KB of binary header. `TABLES` counts the
 * flat directory, and `inspect` refuses a cache whose flat directory holds anything else.
 */
export const ARTIFACTS = [
  { name: 'dev.json', source: 'data/nvbench2.0/dev.json', bytes: 3_344_581,
    sha256: 'a815a23e0998f69f03fef7bdee45e18a69deec49490ee099b9511a133f34291c' },
  { name: 'test.json', source: 'data/nvbench2.0/test.json', bytes: 3_361_287,
    sha256: '22f8802d8e3fbf391b7dccee8f979c812f0792a3853c7f9914394c8016ae6cc2' },
  { name: 'database_csv.zip', source: 'data/database/database_csv.zip', bytes: 18_395_893,
    sha256: 'd8e31b2e8a62f61146f85eb208fb304f9ca22d62f25a9b8be9757c4a17a963dd' },
];

/** Why one artifact of the same repository is not in the list above. */
export const OUT_OF_SCOPE = {
  'train.json': '27.5 MB, and the mirror answers 403 for it — past the per-file limit at 20 MB. The '
    + 'train split exists to fine-tune a model, and this repository evaluates one it does not train.',
};

/** What each split must contain. `tables` is distinct tables asked about, not files in the corpus. */
export const SPLITS = {
  dev: { questions: 750, tables: 92 },
  test: { questions: 751, tables: 87 },
};

/** Tables in the archive. Pinned because a truncated archive expands without complaining. */
export const TABLES = 803;

/** Expand the archive in place. A function so that a test can run the loop without `unzip`. */
export function extract(cache) {
  execFileSync('unzip', ['-q', '-o', join(cache, 'database_csv.zip'), '-d', cache]);
}

/** Where the cache is, read at call time so a test can point the tool at its own directory. */
export function cachePath() {
  return process.env.NVBENCH2_CACHE ?? DEFAULT_CACHE;
}

export function sourceUrl(source) {
  return `${MIRROR}/${source}`;
}

export async function sha256Of(path) {
  return new Promise((keep, fail) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => keep(hash.digest('hex')));
  });
}

/**
 * Whether the cache already holds this artifact, byte for byte.
 *
 * A size check alone would accept a truncated file whose length happens to match, which is the
 * failure mode a resumed `curl` produces; the digest is the assertion.
 */
export async function warmOf(artifact, cache) {
  const target = join(cache, artifact.name);
  if (!existsSync(target) || statSync(target).size !== artifact.bytes) return false;
  return (await sha256Of(target)) === artifact.sha256;
}

/** Download one artifact, refusing a partial write. */
export async function download(artifact, cache) {
  const target = join(cache, artifact.name);
  const response = await fetch(sourceUrl(artifact.source));
  if (!response.ok) {
    throw new Error(`${artifact.name}: ${String(response.status)} from ${sourceUrl(artifact.source)}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength !== artifact.bytes) {
    throw new Error(`${artifact.name}: ${String(body.byteLength)} bytes, expected ${String(artifact.bytes)}`);
  }
  const digest = createHash('sha256').update(body).digest('hex');
  if (digest !== artifact.sha256) {
    throw new Error(`${artifact.name}: sha256 ${digest}, expected ${artifact.sha256}`);
  }
  writeFileSync(`${target}.part`, body);
  renameSync(`${target}.part`, target);
  return target;
}

/**
 * What the cache holds, and what is wrong with it.
 *
 * Separate from `main` so that a test can point it at a directory it wrote: the readings are the
 * contract, and a fetch that reports success while the directory is half-written is the failure
 * this function exists to name.
 */
export function inspect(cache, tables = TABLES) {
  const problems = [];
  const counts = { questions: {}, tables: null };
  for (const split of Object.keys(SPLITS)) {
    const path = join(cache, `${split}.json`);
    if (!existsSync(path)) {
      problems.push(`${split}.json is missing`);
      continue;
    }
    let rows;
    try {
      rows = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      problems.push(`${split}.json does not parse: ${String(error.message)}`);
      continue;
    }
    if (!Array.isArray(rows)) {
      problems.push(`${split}.json is not an array`);
      continue;
    }
    counts.questions[split] = { questions: rows.length, tables: new Set(rows.map((row) => row.csv_file)).size };
    if (rows.length !== SPLITS[split].questions) {
      problems.push(`${split}.json holds ${String(rows.length)} questions, expected ${String(SPLITS[split].questions)}`);
    }
    const distinct = new Set(rows.map((row) => row.csv_file)).size;
    if (distinct !== SPLITS[split].tables) {
      problems.push(`${split}.json asks about ${String(distinct)} tables, expected ${String(SPLITS[split].tables)}`);
    }
  }
  const dir = join(cache, 'database_csv');
  if (!existsSync(dir)) {
    problems.push('database_csv/ is missing — the archive was not extracted');
  } else {
    const names = readdirSync(dir);
    const spread = names.filter((name) => name.startsWith('._'));
    const files = names.filter((name) => name.endsWith('.csv') && !name.startsWith('._'));
    counts.tables = files.length;
    if (files.length !== tables) {
      problems.push(`database_csv/ holds ${String(files.length)} tables, expected ${String(tables)}`);
    }
    if (spread.length > 0) {
      problems.push(`database_csv/ holds ${String(spread.length)} AppleDouble files beside the tables`);
    }
  }
  return { problems, counts };
}

export async function main(argv = [], tools = { download, extract }) {
  const offline = argv.includes('--offline');
  const cache = cachePath();
  if (offline) {
    const { problems } = inspect(cache);
    for (const problem of problems) process.stdout.write(`nvbench2: ${problem}\n`);
    process.stdout.write(`nvbench2: ${problems.length === 0 ? 'cache is warm' : 'cache is cold'}\n`);
    return problems.length === 0 ? 0 : 1;
  }
  if (!existsSync(cache)) mkdirSync(cache, { recursive: true });
  for (const artifact of ARTIFACTS) {
    if (await warmOf(artifact, cache)) {
      process.stdout.write(`nvbench2: ${artifact.name} already present\n`);
      continue;
    }
    await tools.download(artifact, cache);
    process.stdout.write(`nvbench2: ${artifact.name} ${String(artifact.bytes)} bytes\n`);
  }
  tools.extract(cache);
  const { problems, counts } = inspect(cache);
  for (const problem of problems) process.stdout.write(`nvbench2: ${problem}\n`);
  process.stdout.write(`nvbench2: dev ${String(counts.questions.dev?.questions ?? 0)} / test `
    + `${String(counts.questions.test?.questions ?? 0)} questions, ${String(counts.tables ?? 0)} tables\n`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
