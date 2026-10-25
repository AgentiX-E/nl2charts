#!/usr/bin/env node
/**
 * Fetch BIRD Mini-Dev into `eval/.cache/bird`.
 *
 * The dataset is not vendored: the archive is ~800 MB and contains eight
 * thousand more files than we execute. This script downloads it once, extracts
 * only the manifest and the databases the run asks for, and records sizes so a
 * truncated extraction fails loudly instead of producing empty tables.
 *
 *   node eval/bird/fetch.mjs --dbs superhero,california_schools
 *   node eval/bird/fetch.mjs --offline        # fail if the cache is cold
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
/**
 * Three archives live in the same bucket. `minidev` is the 500 questions CI runs on
 * every commit; `dev` is the 1,534-question split the published leaderboards report;
 * `train` is 9,428 labelled questions over 69 databases and shares no database with
 * either, so it is knowledge rather than answers for the split under test.
 *
 * `train.zip` is 8.5 GB because it carries the training databases, which this harness
 * never executes: only `train.json` is extracted, and the archive is deleted straight
 * after, so the cache holds 4.2 MB rather than a second copy of the corpus.
 */
const SPLIT = process.env.BIRD_SPLIT ?? 'minidev';
/**
 * `root` is where the archive puts its files; `dir` is where the harness reads them.
 * They differ for `dev`, whose archive root is `dev_20240627` while the cache keeps it
 * under `dev/` — the mismatch that made the workflow fail the first time it ran.
 */
const SPLIT_SHAPE = {
  minidev: { archive: 'minidev.zip', root: 'minidev/MINIDEV', dir: 'minidev/MINIDEV', questions: 'mini_dev_sqlite.json' },
  dev: { archive: 'dev.zip', root: 'dev_20240627', dir: 'dev/dev_20240627', questions: 'dev.json', nested: 'dev_databases.zip' },
  train: { archive: 'train.zip', root: 'train', dir: 'train', questions: 'train.json', jsonOnly: true },
};
if (SPLIT_SHAPE[SPLIT] === undefined) throw new Error(`unknown BIRD_SPLIT: ${SPLIT}`);
const SHAPE = SPLIT_SHAPE[SPLIT];
const SOURCE = process.env.BIRD_ARCHIVE_URL ?? `https://bird-bench.oss-cn-beijing.aliyuncs.com/${SHAPE.archive}`;
const CACHE = process.env.BIRD_CACHE ?? join(ROOT, 'eval/.cache/bird');
const ARCHIVE = join(CACHE, SHAPE.archive);
const DEFAULT_DATABASES = [
  'superhero',
  'california_schools',
  'student_club',
  'thrombosis_prediction',
  'toxicology',
  'debit_card_specializing',
  'financial',
  'formula_1',
  'card_games',
  'european_football_2',
  'codebase_community',
];

function parseArgs(argv) {
  const args = { dbs: [], offline: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--offline') args.offline = true;
    else if (flag === '--force') args.force = true;
    else if (flag === '--dbs') {
      args.dbs = String(argv[index + 1] ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
      index += 1;
    }
  }
  return args;
}

async function download(target) {
  if (existsSync(target) && statSync(target).size > 1_000_000) {
    console.log(`archive present: ${(statSync(target).size / 1048576).toFixed(0)} MB`);
    return;
  }
  console.log(`downloading ${SOURCE}`);
  const response = await fetch(SOURCE, { redirect: 'follow' });
  if (!response.ok || response.body === null) throw new Error(`download failed: ${response.status}`);
  mkdirSync(dirname(target), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  console.log(`downloaded ${(statSync(target).size / 1048576).toFixed(0)} MB`);
}

function extract(entries, destination = CACHE) {
  execFileSync('unzip', ['-qo', ARCHIVE, ...entries, '-d', destination], { stdio: 'inherit' });
}

/**
 * Expand a nested archive into place, then make its layout match the split's.
 *
 * `dev.zip` ships `dev_20240627/dev_databases.zip`, and that inner archive carries its
 * own top-level directory. Extracting it into the split directory therefore produced
 * `dev/dev_20240627/<inner>/dev_databases`, while everything downstream expects
 * `dev/dev_20240627/dev_databases` — the workflow failed the first time it ran, in CI,
 * because that path had never been exercised.
 */
/**
 * Put the extracted tree where the harness reads it.
 *
 * `dev.zip` extracts to `dev_20240627/` while everything downstream reads
 * `dev/dev_20240627/`, so the archive's own root has to be moved into place. Doing it
 * here means no caller needs to know which split has the quirk.
 */
export function promote(archiveRoot, dataDir) {
  if (archiveRoot === dataDir || !existsSync(archiveRoot)) return;
  mkdirSync(dataDir, { recursive: true });
  // Merge, not replace: the split is extracted twice (metadata, then databases), and
  // replacing the directory on the second pass deleted the questions the first one
  // had just written.
  for (const entry of readdirSync(archiveRoot)) {
    const from = join(archiveRoot, entry);
    const to = join(dataDir, entry);
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    renameSync(from, to);
  }
  rmSync(archiveRoot, { recursive: true, force: true });
}

export function expandDatabases(archivePath, destination) {
  execFileSync('unzip', ['-qo', archivePath, '-d', destination], { stdio: 'inherit' });
  const direct = join(destination, 'dev_databases');
  if (existsSync(direct)) return;
  const entries = readdirSync(destination, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const entry of entries) {
    const nested = join(destination, entry.name, 'dev_databases');
    if (existsSync(nested)) {
      renameSync(nested, direct);
      return;
    }
  }
  throw new Error(`dev_databases not found inside ${archivePath}; layout changed and this needs updating`);
}

function requireFile(path) {
  if (!existsSync(path) || statSync(path).size === 0) throw new Error(`extraction produced nothing: ${path}`);
  return statSync(path).size;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fromEnv = (process.env.BIRD_DBS ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  const dbs = args.dbs.length > 0 ? args.dbs : fromEnv.length > 0 ? fromEnv : DEFAULT_DATABASES;
  const dataDir = join(CACHE, SHAPE.dir);
  const archiveRoot = join(CACHE, SHAPE.root);
  const manifestPath = join(dataDir, 'manifest.json');

  if (SHAPE.jsonOnly === true && existsSync(join(dataDir, SHAPE.questions))) {
    // The corpus is cached: the 8.5 GB archive is not downloaded at all.
    const bytes = requireFile(join(dataDir, SHAPE.questions));
    console.log(`ready: ${SHAPE.dir} corpus ${(bytes / 1048576).toFixed(1)} MB (no download)`);
    return;
  }

  await download(ARCHIVE);

  // Extract what is missing, not "everything or nothing": a run that widens the
  // database list must not need --force, and must not re-extract 1.4 GB.
  if (SHAPE.jsonOnly === true) {
    extract([`${SHAPE.dir}/${SHAPE.questions}`]);
    const bytes = requireFile(join(dataDir, SHAPE.questions));
    // The archive exists only to deliver this file; keeping it costs 8.5 GB on a
    // runner whose cache is 4.2 MB of the same data.
    if (process.env.BIRD_KEEP_ARCHIVE !== '1') rmSync(ARCHIVE, { force: true });
    console.log(`ready: ${SHAPE.dir} corpus ${(bytes / 1048576).toFixed(1)} MB (archive removed)`);
    return;
  }

  const missing = dbs.filter((db) => !existsSync(join(dataDir, 'dev_databases', db, `${db}.sqlite`)));
  const needMeta = !existsSync(join(dataDir, SHAPE.questions)) || !existsSync(join(dataDir, 'dev_tables.json'));
  if (needMeta) {
    extract([`${SHAPE.root}/${SHAPE.questions}`, `${SHAPE.root}/dev_tables.json`]);
    promote(archiveRoot, dataDir);
  }
  if (missing.length > 0 && SHAPE.nested !== undefined) {
    // The databases live one archive down, and the inner archive has its own root.
    extract([`${SHAPE.root}/${SHAPE.nested}`]);
    promote(archiveRoot, dataDir);
    expandDatabases(join(dataDir, SHAPE.nested), dataDir);
  } else if (missing.length > 0) {
    extract(missing.map((db) => `${SHAPE.root}/dev_databases/${db}/*`));
    promote(archiveRoot, dataDir);
  }
  // Fail on the database that is missing, not on a stat() three lines later.
  for (const db of dbs) {
    const file = join(dataDir, 'dev_databases', db, `${db}.sqlite`);
    if (!existsSync(file)) {
      throw new Error(`extraction left no SQLite file for ${db} at ${file}; the archive layout changed`);
    }
  }

  const questions = requireFile(join(dataDir, SHAPE.questions));
  const tables = requireFile(join(dataDir, 'dev_tables.json'));
  const databases = dbs.map((db) => ({
    db,
    file: join(dataDir, 'dev_databases', db, `${db}.sqlite`),
    bytes: requireFile(join(dataDir, 'dev_databases', db, `${db}.sqlite`)),
  }));

  const manifest = { source: SOURCE, questions, tables, databases, extractedAt: new Date().toISOString() };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const total = databases.reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(`ready: ${databases.length} databases, ${(total / 1048576).toFixed(0)} MB, questions ${(questions / 1024).toFixed(0)} KB`);
  for (const entry of databases) console.log(`  ${entry.db} ${(entry.bytes / 1048576).toFixed(1)} MB`);
}

// Importable for tests: the layout helpers are the part that broke in CI, and they are
// pure filesystem operations that can be checked without downloading 330 MB.
if (process.argv[1] !== undefined && process.argv[1].endsWith('fetch.mjs')) await main();
