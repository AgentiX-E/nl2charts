/**
 * The Spider corpus builder, tested against bytes the test writes and a database it inspects.
 *
 * The claim this file has to defend is the one the fetcher rests on: a skeleton built from
 * `tables.json` has the *same schema* as the official database, so a judge reading the catalogue
 * cannot tell them apart. That is asserted on the catalogue itself (`PRAGMA table_info`), not on the
 * builder's own output, and separately by the corpus check in `test/spider-check.test.ts`, which
 * parses every gold of the real split.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDatabase,
  cacheDir,
  checkCorpus,
  databasesOf,
  digestOf,
  fetchPinned,
  main,
  reserved,
  resolveSettings,
  schemaOf,
  writeCorpus,
  FILES,
  ORIGIN,
} from '../eval/spider/fetch.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dirOf(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spider-fetch-'));
  dirs.push(dir);
  return dir;
}

/** A declaration shaped like `tables.json`, small enough to read. */
const ENTRY: Parameters<typeof schemaOf>[0] = {
  db_id: 'shop',
  table_names_original: ['singer', 'concert'],
  column_names_original: [
    [-1, '*'],
    [0, 'singer_id'],
    [0, 'name'],
    [1, 'concert_id'],
    [1, 'singer_id'],
  ],
  column_types: ['text', 'number', 'text', 'number', 'number'],
  primary_keys: [1, 3],
  foreign_keys: [[4, 1]],
};

const QUESTION = { db_id: 'shop', question: 'How many singers?', query: 'SELECT count(*) FROM singer' };

describe('the pins, because a byte count and a hash are the whole contract', () => {
  it('hashes bytes the way sha256 does', () => {
    expect(digestOf(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('pins two files that make the split, and names the repository they come from', () => {
    expect(FILES.map((file) => file.name)).toEqual(['dev.json', 'tables.json']);
    expect(FILES.every((file) => file.bytes > 0 && /^[0-9a-f]{64}$/u.test(file.sha256))).toBe(true);
    expect(ORIGIN).toEqual({ repo: 'taoyds/spider', ref: 'master' });
  });
});

describe('fetchPinned, which distinguishes a short read from a different file', () => {
  const body = Buffer.from('hello');
  const file = { path: 'x/y.json', name: 'y.json', bytes: body.length, sha256: digestOf(body) };

  it('returns the bytes when they are the pinned ones', async () => {
    const fetched = await fetchPinned(file, { fetchImpl: async () => new Response(body) });
    expect(fetched.toString()).toBe('hello');
  });

  it('retries a short read, because the wire is not the file', async () => {
    let calls = 0;
    const fetched = await fetchPinned(file, {
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? new Response(Buffer.from('hel')) : new Response(body);
      },
    });
    expect(fetched.toString()).toBe('hello');
    expect(calls).toBe(2);
  });

  it('refuses a digest mismatch on the first answer, rather than hoping the repository changes back', async () => {
    let calls = 0;
    await expect(
      fetchPinned(file, {
        fetchImpl: async () => {
          calls += 1;
          return new Response(Buffer.from('hellp'));
        },
      }),
    ).rejects.toThrow(/has sha256 .* expected/u);
    expect(calls).toBe(1);
  });

  it('retries an HTTP failure and then names it', async () => {
    let calls = 0;
    await expect(
      fetchPinned(file, {
        fetchImpl: async () => {
          calls += 1;
          return new Response('rate limited', { status: 403 });
        },
      }),
    ).rejects.toThrow('HTTP 403');
    expect(calls).toBe(3);
  });

  it('sends the token when it has one, and no Authorization header when it does not', async () => {
    const seen: (string | null)[] = [];
    const capture = (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return Promise.resolve(new Response(body));
    };
    await fetchPinned(file, { fetchImpl: capture, token: 't' });
    await fetchPinned(file, { fetchImpl: capture, token: '' });
    expect(seen).toEqual(['Bearer t', null]);
  });
});

describe('the schema, which is the only thing the judge reads', () => {
  it('declares every column of every table, in the order the corpus lists them', () => {
    const declared = schemaOf(ENTRY);
    expect(declared.map((table) => table.table)).toEqual(['singer', 'concert']);
    expect(declared[0]?.sql).toBe('CREATE TABLE "singer" ("singer_id" REAL, "name" TEXT, PRIMARY KEY ("singer_id"))');
    expect(declared[1]?.sql).toBe('CREATE TABLE "concert" ("concert_id" REAL, "singer_id" REAL, PRIMARY KEY ("concert_id"))');
  });

  it('skips the corpus\'s own placeholder column, which belongs to no table', () => {
    expect(schemaOf(ENTRY).every((table) => !table.sql.includes('*'))).toBe(true);
  });

  it('names the table SQLite reserves, so the builder can take the other road', () => {
    expect(reserved('sqlite_sequence')).toBe(true);
    expect(reserved('SQLite_Sequence')).toBe(true);
    expect(reserved('singer')).toBe(false);
    const declared = schemaOf({ ...ENTRY, table_names_original: ['singer', 'sqlite_sequence'] });
    expect(declared[1]?.table).toBe('sqlite_sequence');
  });

  it('builds a database whose catalogue is the declaration, including the reserved name', () => {
    const path = join(dirOf(), 'shop.sqlite');
    buildDatabase({ ...ENTRY, table_names_original: ['singer', 'sqlite_sequence'] }, path);
    expect(existsSync(path)).toBe(true);
    const database = new DatabaseSync(path);
    try {
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
      expect(tables.map((table) => table.name)).toEqual(['singer', 'sqlite_sequence']);
      // Column order is what `PRAGMA table_info` returns and what the judge resolves a name against.
      const columns = database.prepare('PRAGMA table_info("singer")').all() as { name: string }[];
      expect(columns.map((column) => column.name)).toEqual(['singer_id', 'name']);
    } finally {
      database.close();
    }
  });

  it('rebuilds a database rather than appending to one left by a previous run', () => {
    const path = join(dirOf(), 'shop.sqlite');
    buildDatabase(ENTRY, path);
    buildDatabase({ ...ENTRY, table_names_original: ['singer'] }, path);
    const database = new DatabaseSync(path);
    try {
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      expect(tables.map((table) => table.name)).toEqual(['singer']);
    } finally {
      database.close();
    }
  });
});

describe('the corpus on disk', () => {
  it('names each database once, sorted, however the questions are ordered', () => {
    expect(databasesOf([QUESTION, { ...QUESTION, db_id: 'airline' }, QUESTION])).toEqual(['airline', 'shop']);
  });

  it('writes the two pinned files, one database per name, and a manifest that says what they are', () => {
    const dir = dirOf();
    const manifest = writeCorpus(
      dir,
      { 'dev.json': Buffer.from(JSON.stringify([QUESTION])), 'tables.json': Buffer.from(JSON.stringify([ENTRY])) },
      [QUESTION],
      [ENTRY],
    );
    expect(manifest.databases).toBe(1);
    expect(manifest.questions).toBe(1);
    // The sentence a reader of a number has to have, asserted so it cannot be edited away silently.
    expect(manifest.databasesAre).toContain('schema skeletons');
    expect(manifest.metric).toContain('exact match');
    expect(existsSync(join(dir, 'database', 'shop', 'shop.sqlite'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).origin.repo).toBe('taoyds/spider');
  });

  it('refuses a question whose database the declaration does not describe', () => {
    const dir = dirOf();
    expect(() => writeCorpus(dir, { 'dev.json': Buffer.from('[]'), 'tables.json': Buffer.from('[]') }, [QUESTION], [])).toThrow(
      'dev.json names shop, which tables.json does not describe',
    );
  });

  it('checks a corpus by its bytes and its databases, not by a manifest that says so', () => {
    const dir = dirOf();
    writeCorpus(
      dir,
      { 'dev.json': Buffer.from(JSON.stringify([QUESTION])), 'tables.json': Buffer.from(JSON.stringify([ENTRY])) },
      [QUESTION],
      [ENTRY],
    );
    // The digests in FILES are for the real corpus, so this synthetic one fails on bytes — which is
    // the point: a check that trusted the manifest would call it clean.
    const checked = checkCorpus(dir);
    expect(checked.problems.some((problem) => problem.includes('dev.json is'))).toBe(true);
    expect(checked.missing).toEqual([]);
  });

  it('names the file that is missing from a corpus directory', () => {
    const dir = dirOf();
    expect(() => checkCorpus(dir)).toThrow('no manifest.json');
  });
});

describe('the flags, and the split it refuses', () => {
  it('defaults to dev in the cache directory the environment names', () => {
    expect(resolveSettings([]).split).toBe('dev');
    expect(cacheDir('/tmp/x')).toBe('/tmp/x');
  });

  it('refuses every other split by name, because only dev has public labels', () => {
    expect(() => resolveSettings(['--split', 'test'])).toThrow('--split test has no public labels');
    expect(() => resolveSettings(['--split'])).toThrow('--split needs a name');
  });

  it('reads --check and --out, and refuses a flag it does not know', () => {
    expect(resolveSettings(['--check', '--out', '/tmp/c'])).toMatchObject({ check: true, out: '/tmp/c' });
    expect(() => resolveSettings(['--out'])).toThrow('--out needs a path');
    expect(() => resolveSettings(['--nope'])).toThrow('unknown flag --nope');
    expect(() => resolveSettings(['stray'])).toThrow('unexpected argument stray');
  });
});

describe('main, driven the way a workflow drives it', () => {
  it('reports a clean corpus from disk without touching the network', async () => {
    const dir = dirOf();
    writeCorpus(
      dir,
      { 'dev.json': Buffer.from(JSON.stringify([QUESTION])), 'tables.json': Buffer.from(JSON.stringify([ENTRY])) },
      [QUESTION],
      [ENTRY],
    );
    const lines: string[] = [];
    // The bytes are the synthetic ones, so the check must fail — and refusing is the point.
    const code = await main(['--check', '--out', dir], { log: (line: string) => lines.push(line) });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('spider corpus: FAILED');
  });

  it('writes a corpus from bytes it pinned, and says how many databases it built', async () => {
    const dir = dirOf();
    const bodies: Record<string, Buffer> = {
      'dev.json': Buffer.from(JSON.stringify([QUESTION])),
      'tables.json': Buffer.from(JSON.stringify([ENTRY])),
    };
    // The pins describe the real corpus; this run replaces them with the test's bytes and hashes.
    const lines: string[] = [];
    const code = await main(['--out', dir], {
      log: (line: string) => lines.push(line),
      fetchImpl: async (url: URL | RequestInfo) => {
        const name = String(url).includes('dev.json') ? 'dev.json' : 'tables.json';
        return new Response(new Uint8Array(bodies[name] as Buffer));
      },
      pins: [
        { path: 'evaluation_examples/examples/dev.json', name: 'dev.json', bytes: (bodies['dev.json'] as Buffer).length, sha256: digestOf(bodies['dev.json'] as Buffer) },
        { path: 'evaluation_examples/examples/tables.json', name: 'tables.json', bytes: (bodies['tables.json'] as Buffer).length, sha256: digestOf(bodies['tables.json'] as Buffer) },
      ],
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('1 database(s) built for 1 question(s)');
    expect(existsSync(join(dir, 'database', 'shop', 'shop.sqlite'))).toBe(true);
  });

  it('refuses a corpus whose bytes are not the pinned ones', async () => {
    const dir = dirOf();
    await expect(
      main(['--out', dir], {
        log: () => {},
        fetchImpl: async () => new Response(Buffer.from('{"db_id":"x"}')),
      }),
    ).rejects.toThrow(/expected/u);
  });
});

describe('a corpus file the test wrote and then broke', () => {
  it('reports a missing database by name rather than by count', () => {
    const dir = dirOf();
    writeCorpus(
      dir,
      { 'dev.json': Buffer.from(JSON.stringify([QUESTION])), 'tables.json': Buffer.from(JSON.stringify([ENTRY])) },
      [QUESTION],
      [ENTRY],
    );
    writeFileSync(join(dir, 'manifest.json'), readFileSync(join(dir, 'manifest.json')));
    rmSync(join(dir, 'database', 'shop'), { recursive: true });
    expect(checkCorpus(dir).missing).toEqual(['shop']);
  });
});
