import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ARTIFACTS, OUT_OF_SCOPE, SPLITS, TABLES, extract, inspect, main, sourceUrl, warmOf } from '../eval/nvbench2/fetch.mjs';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nl2charts-nvbench2-fetch-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A cache that `inspect` calls clean, built by hand so that each failure can be added alone. */
function cache(options: {
  dev?: number;
  test?: number;
  tables?: number;
  devTables?: number;
  spread?: boolean;
} = {}): string {
  const dir = scratch();
  for (const [split, count] of [['dev', options.dev ?? 750], ['test', options.test ?? 751]] as const) {
    const spread = options.devTables ?? SPLITS[split]!.tables;
    const rows = Array.from({ length: count }, (_, index) => ({ csv_file: `t${String(index % spread)}.csv` }));
    writeFileSync(join(dir, `${split}.json`), JSON.stringify(rows));
  }
  const tables = options.tables ?? TABLES;
  mkdirSync(join(dir, 'database_csv'));
  for (let index = 0; index < tables; index += 1) {
    writeFileSync(join(dir, 'database_csv', `t${String(index)}.csv`), 'amount\n1\n');
  }
  if (options.spread === true) writeFileSync(join(dir, 'database_csv', '._t0.csv'), 'resource fork');
  return dir;
}

describe('the pinned artifacts', () => {
  it('names three files, each with a byte count and a digest', () => {
    expect(ARTIFACTS.map((artifact) => artifact.name))
      .toEqual(['dev.json', 'test.json', 'database_csv.zip']);
    for (const artifact of ARTIFACTS) {
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(artifact.bytes).toBeGreaterThan(0);
      expect(artifact.source).toMatch(/^data\//u);
    }
  });

  it('serves them from the mirror, by path rather than by name', () => {
    expect(sourceUrl('data/nvbench2.0/dev.json')).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/gh\/HKUSTDial\/nvBench-2\.0@main\/data/u);
  });

  it('says why the train split is not in the list instead of leaving it out silently', () => {
    expect(Object.keys(OUT_OF_SCOPE)).toEqual(['train.json']);
    expect(OUT_OF_SCOPE['train.json']).toContain('403');
    expect(OUT_OF_SCOPE['train.json']).toContain('fine-tune');
  });
});

describe('warmOf', () => {
  it('accepts a file whose bytes and length are the pinned ones', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'part'), 'three');
    const sha256 = createHash('sha256').update('three').digest('hex');
    expect(await warmOf({ name: 'part', bytes: 5, sha256 }, dir)).toBe(true);
  });

  it('refuses a file of the right length and the wrong bytes, which is a truncated resume', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'part'), 'throw');
    const sha256 = createHash('sha256').update('three').digest('hex');
    expect(await warmOf({ name: 'part', bytes: 5, sha256 }, dir)).toBe(false);
  });

  it('refuses a file that is not there, and one of the wrong length', async () => {
    const dir = scratch();
    expect(await warmOf({ name: 'absent', bytes: 1, sha256: 'x' }, dir)).toBe(false);
    writeFileSync(join(dir, 'part'), 'three');
    expect(await warmOf({ name: 'part', bytes: 6, sha256: 'x' }, dir)).toBe(false);
  });
});

describe('inspect', () => {
  it('finds nothing wrong with a cache that holds what the corpus holds', () => {
    const { problems, counts } = inspect(cache());
    expect(problems).toEqual([]);
    expect(counts.tables).toBe(TABLES);
    expect(counts.questions.dev).toEqual({ questions: 750, tables: 92 });
    expect(counts.questions.test).toEqual({ questions: 751, tables: 87 });
  });

  it('names a missing split file', () => {
    const dir = scratch();
    const { problems } = inspect(dir);
    expect(problems).toContain('dev.json is missing');
    expect(problems).toContain('test.json is missing');
    expect(problems).toContain('database_csv/ is missing — the archive was not extracted');
  });

  it('names a split that does not parse, and one that is not a list', () => {
    const dir = cache();
    writeFileSync(join(dir, 'dev.json'), '{not json');
    writeFileSync(join(dir, 'test.json'), '{"a":1}');
    const { problems } = inspect(dir);
    expect(problems.some((problem) => problem.includes('dev.json does not parse'))).toBe(true);
    expect(problems).toContain('test.json is not an array');
  });

  it('counts questions and tables, and refuses a short split', () => {
    const { problems, counts } = inspect(cache({ dev: 749 }));
    expect(problems).toContain('dev.json holds 749 questions, expected 750');
    expect(counts.questions.dev?.questions).toBe(749);
  });

  it('refuses a split that asks about the wrong number of tables', () => {
    const { problems } = inspect(cache({ devTables: 91 }));
    expect(problems).toContain('dev.json asks about 91 tables, expected 92');
  });

  it('counts the tables in the flat directory, and refuses a short archive', () => {
    const { problems, counts } = inspect(cache({ tables: 802 }));
    expect(problems).toContain('database_csv/ holds 802 tables, expected 803');
    expect(counts.tables).toBe(802);
  });

  it('refuses AppleDouble files beside the tables, because half of a recursive listing is binary', () => {
    const { problems } = inspect(cache({ spread: true }));
    expect(problems).toContain('database_csv/ holds 1 AppleDouble files beside the tables');
  });

  it('takes the table count it is asked to expect, so a test can build four tables', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'dev.json'), JSON.stringify(Array.from({ length: 750 }, (_, index) => ({ csv_file: `t${String(index % 4)}.csv` }))));
    writeFileSync(join(dir, 'test.json'), JSON.stringify(Array.from({ length: 751 }, (_, index) => ({ csv_file: `t${String(index % 4)}.csv` }))));
    mkdirSync(join(dir, 'database_csv'));
    for (let index = 0; index < 4; index += 1) writeFileSync(join(dir, 'database_csv', `t${String(index)}.csv`), 'a\n1\n');
    const { problems, counts } = inspect(dir, 4);
    expect(counts.tables).toBe(4);
    expect(problems).toEqual([
      'dev.json asks about 4 tables, expected 92',
      'test.json asks about 4 tables, expected 87',
    ]);
  });
});

describe('extract', () => {
  it('expands the archive it is pointed at', () => {
    // A one-table zip built with the system's own archiver: the check is that `extract` runs the
    // command against the cache it was given, not that unzip works.
    const dir = scratch();
    mkdirSync(join(dir, 'database_csv'));
    writeFileSync(join(dir, 'database_csv', 't0.csv'), 'a\n1\n');
    execFileSync('sh', ['-c', `cd ${dir} && zip -q -r database_csv.zip database_csv`]);
    rmSync(join(dir, 'database_csv'), { recursive: true, force: true });
    extract(dir);
    expect(existsSync(join(dir, 'database_csv', 't0.csv'))).toBe(true);
  });
});

describe('main', () => {
  it('downloads what is missing, extracts, and reports the counts', async () => {
    const dir = scratch();
    const previous = process.env.NVBENCH2_CACHE;
    process.env.NVBENCH2_CACHE = dir;
    const downloaded: string[] = [];
    let extracted = false;
    const code = await main([], {
      download: async (artifact: { name: string }, at: string) => {
        downloaded.push(artifact.name);
        if (artifact.name !== 'database_csv.zip') {
          const split = artifact.name.replace('.json', '');
          const spread = SPLITS[split]!.tables;
          const count = SPLITS[split]!.questions;
          const rows = Array.from({ length: count }, (_, index) => ({ csv_file: `t${String(index % spread)}.csv` }));
          writeFileSync(join(at, artifact.name), JSON.stringify(rows));
        } else {
          writeFileSync(join(at, artifact.name), 'archive');
        }
        return join(at, artifact.name);
      },
      extract: (at: string) => {
        extracted = true;
        mkdirSync(join(at, 'database_csv'));
        for (let index = 0; index < TABLES; index += 1) {
          writeFileSync(join(at, 'database_csv', `t${String(index)}.csv`), 'a\n1\n');
        }
      },
    });
    if (previous === undefined) delete process.env.NVBENCH2_CACHE;
    else process.env.NVBENCH2_CACHE = previous;
    expect(downloaded).toEqual(['dev.json', 'test.json', 'database_csv.zip']);
    expect(extracted).toBe(true);
    expect(code).toBe(0);
  });

  it('says the cache is cold when asked to work offline without one', async () => {
    // `--offline` reads the environment's cache, so the assertion is about the exit code rather
    // than about a directory a test controls: an empty cache is the state this names.
    const previous = process.env.NVBENCH2_CACHE;
    process.env.NVBENCH2_CACHE = scratch();
    try {
      expect(await main(['--offline'])).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.NVBENCH2_CACHE;
      else process.env.NVBENCH2_CACHE = previous;
    }
  });

  it('says the cache is warm when it is, and exits 0', async () => {
    const previous = process.env.NVBENCH2_CACHE;
    const dir = cache();
    process.env.NVBENCH2_CACHE = dir;
    try {
      expect(await main(['--offline'])).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.NVBENCH2_CACHE;
      else process.env.NVBENCH2_CACHE = previous;
    }
  });
});
