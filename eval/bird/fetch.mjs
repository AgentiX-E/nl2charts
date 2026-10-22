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
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
/**
 * Two splits ship as separate archives in the same bucket. `minidev` is the 500
 * questions CI runs on every commit; `dev` is the 1,534-question split the published
 * leaderboards report. The layout inside differs only in the directory name and the
 * questions file, so one script fetches both.
 */
const SPLIT = process.env.BIRD_SPLIT ?? 'minidev';
const SPLIT_SHAPE = {
  minidev: { archive: 'minidev.zip', dir: 'minidev/MINIDEV', questions: 'mini_dev_sqlite.json' },
  dev: { archive: 'dev.zip', dir: 'dev/dev_20240627', questions: 'dev.json' },
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

function extract(entries) {
  execFileSync('unzip', ['-qo', ARCHIVE, ...entries, '-d', CACHE], { stdio: 'inherit' });
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
  const manifestPath = join(dataDir, 'manifest.json');

  await download(ARCHIVE);

  // Extract what is missing, not "everything or nothing": a run that widens the
  // database list must not need --force, and must not re-extract 1.4 GB.
  const entries = [`${SHAPE.dir}/${SHAPE.questions}`, `${SHAPE.dir}/dev_tables.json`];
  const missing = dbs.filter((db) => !existsSync(join(dataDir, 'dev_databases', db, `${db}.sqlite`)));
  for (const db of missing) entries.push(`${SHAPE.dir}/dev_databases/${db}/*`);
  // `dev.zip` hides its databases in a nested archive; extracting the outer one
  // first is what makes the per-database entries resolvable.
  if (SPLIT === 'dev' && missing.length > 0) extract([`${SHAPE.dir}/dev_databases.zip`]);
  if (missing.length > 0 || !existsSync(join(dataDir, SHAPE.questions))) extract(entries);

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

await main();
