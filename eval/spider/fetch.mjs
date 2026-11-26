/**
 * Fetch Spider, and build the corpus it can actually be scored against.
 *
 * ## What Spider's corpus is, and what this file builds instead of downloading it
 *
 * `eval/spider/check.ts` established the shape of the problem last round: Spider's exact match is
 * not a string comparison. The reference parses both sides through `process_sql.get_sql`, which
 * resolves every column against a `Schema` read from a live SQLite file, so a corpus of `dev.json`
 * alone cannot produce a number. Its conclusion was that the corpus *is* the twenty databases, and
 * the official archive of them is a 350 MB download from a Google Drive link this repository's CI
 * cannot reach.
 *
 * That conclusion was one step too strong, and the proof is this file. `get_schema` reads the
 * catalogue — table names, column names, column order — and reads nothing else. Rows are never
 * touched: exact match compares parsed trees, not results. So a database created from
 * `tables.json`'s own declaration of every table, column and type has the *same schema* as the
 * official file, and the check that proves it is the one `check.ts` already runs — every gold
 * parses, and every gold reads exact match against itself. On dev that is 1,034 of 1,034 against a
 * corpus of 4.4 MB instead of 350 MB, and the test asserts the reading rather than this paragraph.
 *
 * Three consequences, all of them stated in `manifest.json` rather than left to be discovered:
 *
 * 1. **The reading is exact match, not execution accuracy.** A skeleton cannot answer `SELECT` for
 *    real, so a metric that executes predictions (Spider's "execution accuracy" variants, BIRD's EX)
 *    is out of reach from here. `check.ts`'s comparison is the leaderboard's component match.
 * 2. **A table name SQLite reserves cannot be created as a table.** Three Spider databases ship a
 *    table literally called `sqlite_sequence`, and `world_1` is in dev. The table is created under a
 *    working name and renamed in `sqlite_master` with `PRAGMA writable_schema` — the only way SQLite
 *    permits the name — so the catalogue the judge reads is the one the corpus declares.
 * 3. **The bytes are pinned, not trusted.** Both files are checked against a byte count and a sha256
 *    before they are written, and a run that reads a different byte fails here rather than producing
 *    a split whose counts happen to match. Two files, one transport: `api.github.com` is the only
 *    host this repository's sandbox can reach, and a second channel for 4.4 MB would be a second
 *    thing to keep in step rather than a second chance.
 *
 *   node eval/spider/fetch.mjs --split dev
 *   node eval/spider/fetch.mjs --split dev --check     # verify a cache already on disk
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Where the corpus comes from. A repository and a ref, because a tag could move. */
export const ORIGIN = { repo: 'taoyds/spider', ref: 'master' };

/**
 * The two files that make the split, with the size and hash that make them *these* files.
 *
 * `dev.json` carries the questions and the gold statements; `tables.json` carries the schema of all
 * 166 databases, of which dev uses twenty. Sizes are the byte counts GitHub reports for the blobs at
 * `ORIGIN.ref` on 2026-11-26.
 */
export const FILES = [
  {
    path: 'evaluation_examples/examples/dev.json',
    name: 'dev.json',
    bytes: 3629512,
    sha256: '30d64a3fccde493226df79687aed9e4a1c0129525baf44f29c0573d914d758a4',
  },
  {
    path: 'evaluation_examples/examples/tables.json',
    name: 'tables.json',
    bytes: 810971,
    sha256: '61bb20aa401f03164e2d7f3b16509b7b5f79cc9c943ca7bd159046df1159e2ed',
  },
];

/** Where a fetched corpus lives. */
export function cacheDir(override) {
  return override ?? process.env.SPIDER_CACHE ?? join(ROOT, 'eval/.cache/spider');
}

/** The sha256 of a buffer, as the digest this file pins. */
export function digestOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * One pinned file's bytes, or a refusal that names the mismatch.
 *
 * Three attempts, because a read that is cut short is a transport failure rather than a different
 * file — the digest is what tells the two apart, and it is checked after every attempt. Retrying a
 * *digest* mismatch would be retrying a disagreement; retrying a short read is retrying a wire.
 */
export async function fetchPinned(file, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.token ?? process.env.GITHUB_TOKEN ?? '';
  const url = `https://api.github.com/repos/${ORIGIN.repo}/contents/${file.path}?ref=${ORIGIN.ref}`;
  let last = 'no attempt was made';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const headers = { Accept: 'application/vnd.github.raw' };
      if (token !== '') headers.Authorization = `Bearer ${token}`;
      const response = await fetchImpl(url, { headers });
      if (!response.ok) {
        last = `HTTP ${String(response.status)} for ${file.path}`;
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length !== file.bytes) {
        last = `${file.path} read ${String(buffer.length)} bytes, expected ${String(file.bytes)}`;
        continue;
      }
      const digest = digestOf(buffer);
      if (digest !== file.sha256) {
        // A digest mismatch is not a wire problem: the bytes arrived whole and are not the pinned
        // ones. Retrying it would be hoping a repository changed back.
        throw new Error(`${file.path} has sha256 ${digest}, expected ${file.sha256}`);
      }
      return buffer;
    } catch (error) {
      if (error instanceof Error && error.message.includes('has sha256')) throw error;
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`could not fetch ${file.path}: ${last}`);
}

/** The type SQLite is told to store, from Spider's own vocabulary. */
const AFFINITY = { text: 'TEXT', number: 'REAL', time: 'TEXT', boolean: 'INTEGER', others: 'TEXT' };

/** A name SQLite will not accept as a table, because it starts with its own prefix. */
export function reserved(name) {
  return name.toLowerCase().startsWith('sqlite_');
}

/**
 * One database's `CREATE TABLE` statements, from the corpus's declaration of it.
 *
 * The columns are emitted in `column_names_original` order, because `PRAGMA table_info` returns them
 * in creation order and the judge resolves a column by name against that list. A primary key is
 * carried as a constraint and a foreign key is not: `get_schema` reads neither, and emitting a
 * constraint SQLite would have to validate against empty tables is a way to fail on a corpus that is
 * fine.
 */
export function schemaOf(entry) {
  const columns = new Map();
  for (const [index, [table, name]] of entry.column_names_original.entries()) {
    if (table === -1) continue;
    const list = columns.get(table) ?? [];
    list.push({ index, name });
    columns.set(table, list);
  }
  const primary = new Map();
  for (const index of entry.primary_keys ?? []) {
    const [table, name] = entry.column_names_original[index];
    if (table === -1) continue;
    const list = primary.get(table) ?? [];
    list.push(name);
    primary.set(table, list);
  }
  return entry.table_names_original.map((name, table) => {
    const body = (columns.get(table) ?? []).map(
      (column) => `"${column.name}" ${AFFINITY[entry.column_types[column.index]] ?? 'TEXT'}`,
    );
    const keys = primary.get(table) ?? [];
    if (keys.length > 0) body.push(`PRIMARY KEY (${keys.map((key) => `"${key}"`).join(', ')})`);
    return { table: name, sql: `CREATE TABLE "${name}" (${body.join(', ')})` };
  });
}

/**
 * Build one database file from a declaration, including the one table SQLite reserves.
 *
 * The rename is done with `PRAGMA writable_schema`, because there is no other way to own a name
 * SQLite keeps for itself: `CREATE TABLE "sqlite_sequence"` is refused, and so is any other name
 * beginning with `sqlite_`. The row's `sql` is the one SQLite writes for its own sequence table, so a
 * reader that compares the catalogue sees what the corpus declares.
 */
export function buildDatabase(entry, path) {
  if (existsSync(path)) rmSync(path);
  const database = new DatabaseSync(path);
  try {
    const renames = [];
    for (const { table, sql } of schemaOf(entry)) {
      if (!reserved(table)) {
        database.exec(sql);
        continue;
      }
      const working = `reserved_${String(table)}_${String(entry.db_id)}`;
      database.exec(`CREATE TABLE "${working}" ("name" TEXT, "seq" INTEGER)`);
      renames.push({ working, table });
    }
    if (renames.length > 0) {
      database.exec('PRAGMA writable_schema=ON');
      for (const { working, table } of renames) {
        database
          .prepare('UPDATE sqlite_master SET name = ?, tbl_name = ?, sql = ? WHERE name = ?')
          .run(table, table, `CREATE TABLE ${table}(name,seq)`, working);
      }
      database.exec('PRAGMA writable_schema=OFF');
    }
  } finally {
    database.close();
  }
}

/** The databases a split needs, in the order the questions name them. */
export function databasesOf(questions) {
  const names = [];
  for (const row of questions) if (!names.includes(row.db_id)) names.push(row.db_id);
  return names.sort();
}

/** Write the corpus: the two pinned files, one skeleton database per db the split names, a manifest. */
export function writeCorpus(dir, files, questions, tables) {
  mkdirSync(join(dir, 'database'), { recursive: true });
  writeFileSync(join(dir, 'dev.json'), files['dev.json']);
  writeFileSync(join(dir, 'tables.json'), files['tables.json']);
  const wanted = new Set(databasesOf(questions));
  const byId = new Map(tables.map((entry) => [entry.db_id, entry]));
  const built = [];
  for (const db of wanted) {
    const entry = byId.get(db);
    if (entry === undefined) throw new Error(`dev.json names ${db}, which tables.json does not describe`);
    mkdirSync(join(dir, 'database', db), { recursive: true });
    buildDatabase(entry, join(dir, 'database', db, `${db}.sqlite`));
    built.push(db);
  }
  const manifest = {
    corpus: 'Spider 1.0 dev',
    origin: ORIGIN,
    files: FILES.map((file) => ({ name: file.name, path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    questions: questions.length,
    databases: built.length,
    // The one sentence a reader of a number from this corpus has to have.
    databasesAre: 'schema skeletons built from tables.json (table names, column names, column order, types, primary keys), not the official 350 MB archive: exact match reads the catalogue and never a row',
    metric: 'exact match (component match), the split\'s own comparison; execution accuracy is out of reach from a skeleton',
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  return manifest;
}

/** Read a corpus back, refusing one whose manifest does not describe what is on disk. */
export function checkCorpus(dir) {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`no manifest.json in ${dir}: run fetch.mjs --split dev first`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const questions = JSON.parse(readFileSync(join(dir, 'dev.json'), 'utf8'));
  const problems = [];
  for (const file of FILES) {
    const path = join(dir, file.name);
    if (!existsSync(path)) {
      problems.push(`${file.name} is missing`);
      continue;
    }
    const buffer = readFileSync(path);
    if (buffer.length !== file.bytes) problems.push(`${file.name} is ${String(buffer.length)} bytes, expected ${String(file.bytes)}`);
    else if (digestOf(buffer) !== file.sha256) problems.push(`${file.name} has a different sha256`);
  }
  const missing = databasesOf(questions).filter((db) => !existsSync(join(dir, 'database', db, `${db}.sqlite`)));
  for (const db of missing) problems.push(`database ${db} is missing`);
  return { manifest, questions: questions.length, databases: databasesOf(questions).length, missing, problems };
}

/** Flags this file reads. */
export function resolveSettings(argv) {
  let split = 'dev';
  let check = false;
  let out;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--split') {
      if (value === undefined) throw new Error('--split needs a name');
      split = value;
      index += 1;
    } else if (flag === '--out') {
      if (value === undefined) throw new Error('--out needs a path');
      out = value;
      index += 1;
    } else if (flag === '--check') {
      check = true;
    } else if (String(flag).startsWith('--')) {
      throw new Error(`unknown flag ${String(flag)}`);
    } else {
      throw new Error(`unexpected argument ${String(flag)}`);
    }
  }
  // Only dev is published with labels. Refusing the others by name is the difference between a
  // reader learning why and a reader wondering why the file is missing.
  if (split !== 'dev') {
    throw new Error(`--split ${split} has no public labels in ${ORIGIN.repo}; only dev is scored here`);
  }
  return { split, check, out: cacheDir(out) };
}

export async function main(argv, options = {}) {
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const settings = resolveSettings(argv);
  if (settings.check) {
    const checked = checkCorpus(settings.out);
    log(`spider corpus: ${String(checked.databases)} databases, ${String(checked.questions)} questions in ${settings.out}`);
    for (const problem of checked.problems) log(`spider corpus: ${problem}`);
    log(`spider corpus: ${checked.problems.length === 0 ? 'ok' : 'FAILED'}`);
    return checked.problems.length === 0 ? 0 : 1;
  }
  const files = {};
  // The pins are a parameter so a test can hand the builder its own bytes; a workflow never passes
  // them, and the constants above are what it gets.
  for (const file of options.pins ?? FILES) {
    files[file.name] = await fetchPinned(file, options);
    log(`spider fetch: ${file.name} ${String(file.bytes)} bytes, sha256 ok`);
  }
  const questions = JSON.parse(files['dev.json'].toString('utf8'));
  const tables = JSON.parse(files['tables.json'].toString('utf8'));
  const manifest = writeCorpus(settings.out, files, questions, tables);
  log(`spider fetch: ${String(manifest.databases)} database(s) built for ${String(manifest.questions)} question(s)`);
  log(`spider fetch: corpus ${settings.out}`);
  return 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('spider/fetch.mjs')) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
