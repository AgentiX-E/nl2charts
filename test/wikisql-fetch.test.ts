import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARCHIVE, countLines, extract, inspect, main, planOf, sha256Of, sourceUrl } from '../eval/wikisql/fetch.mjs';

// The fetcher's job is to refuse a corpus that is not the corpus. These tests build the archive and
// the cache with real files — a real bzip2 tar for `extract`, real JSONL for `inspect` — because a
// count that is asserted against a fixture is only as honest as the fixture.

const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nl2charts-wikisql-fetch-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A cache laid out the way a successful fetch leaves it, with the counts the split declares. */
function warm(dir: string, questions: number, tables: string[], name = 'dev'): void {
  const rows = Array.from({ length: questions }, (_, index) =>
    JSON.stringify({ table_id: tables[index % tables.length], question: `q${String(index)}`, sql: { sel: 0, agg: 0, conds: [] } }),
  );
  writeFileSync(join(dir, `${name}.jsonl`), `${rows.join('\n')}\n`);
  writeFileSync(join(dir, `${name}.tables.jsonl`), `${tables.map((id) => JSON.stringify({ id })).join('\n')}\n`);
  writeFileSync(join(dir, `${name}.db`), 'SQLite format 3\u0000');
}

describe('planOf', () => {
  it('names the archive members and the flat files they become', () => {
    const plan = planOf('dev');
    expect(plan.members).toEqual(['data/dev.jsonl', 'data/dev.tables.jsonl', 'data/dev.db']);
    expect(plan.files).toEqual(['dev.jsonl', 'dev.tables.jsonl', 'dev.db']);
    expect(plan.shape.questions).toBe(8421);
  });

  it('refuses a split the corpus does not have', () => {
    expect(() => planOf('validation')).toThrow(/unknown WikiSQL split/);
  });

  it('points at the mirror that actually serves 26 MB', () => {
    expect(sourceUrl()).toBe(`https://cdn.jsdelivr.net/gh/salesforce/WikiSQL@master/${ARCHIVE.name}`);
    expect(ARCHIVE.bytes).toBe(26_164_664);
  });
});

describe('countLines', () => {
  it('does not count a trailing newline as a line, and counts a file without one', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'a'), 'one\ntwo\n');
    writeFileSync(join(dir, 'b'), 'one\ntwo');
    writeFileSync(join(dir, 'c'), '');
    expect([countLines(join(dir, 'a')), countLines(join(dir, 'b')), countLines(join(dir, 'c'))]).toEqual([2, 2, 0]);
  });
});

describe('sha256Of', () => {
  it('hashes the bytes it reads', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'x'), 'abc');
    // The digest of "abc", so the function is checked against a value it cannot have invented.
    expect(await sha256Of(join(dir, 'x'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('inspect', () => {
  it('names every file a cold cache is missing', () => {
    const dir = workspace();
    const { problems, counts } = inspect('dev', dir);
    expect(problems).toHaveLength(3);
    expect(counts).toBeNull();
  });

  it('reports a split whose question count is short', () => {
    const dir = workspace();
    warm(dir, 8400, ['1-2-3']);
    const { problems } = inspect('dev', dir);
    expect(problems).toContain('8421 questions expected, 8400 present');
  });

  it('reports a table file from another release', () => {
    const dir = workspace();
    warm(dir, 8421, ['1-2-3']);
    const { problems } = inspect('dev', dir);
    expect(problems.some((problem: string) => /2716 tables expected, 1 present/u.test(problem))).toBe(true);
  });

  it('reports a question that names a table the table file does not declare', () => {
    const dir = workspace();
    // Counts are forced to agree so the only remaining question is the join between the halves.
    warm(dir, 8421, ['1-2-3']);
    const { problems } = inspect('dev', dir, { questions: 8421, tables: 1 });
    expect(problems).toEqual([]);
    writeFileSync(
      join(dir, 'dev.jsonl'),
      `${Array.from({ length: 8421 }, () => JSON.stringify({ table_id: '9-9-9', question: 'q', sql: { sel: 0, agg: 0, conds: [] } })).join('\n')}\n`,
    );
    const broken = inspect('dev', dir, { questions: 8421, tables: 1 });
    expect(broken.problems.join('; ')).toMatch(/8421 questions name a table the table file does not declare/u);
  });

  it('accepts a cache that satisfies every claim', () => {
    const dir = workspace();
    warm(dir, 8421, ['1-2-3']);
    const { problems, counts } = inspect('dev', dir, { questions: 8421, tables: 1 });
    expect(problems).toEqual([]);
    expect(counts).toEqual({ questions: 8421, tables: 1 });
  });
});

describe('extract', () => {
  it('flattens the archive members and drops the rest', () => {
    const dir = workspace();
    const source = join(dir, 'src');
    mkdirSync(join(source, 'data'), { recursive: true });
    writeFileSync(join(source, 'data', 'dev.jsonl'), '{"table_id":"1-2-3"}\n');
    writeFileSync(join(source, 'data', 'dev.tables.jsonl'), '{"id":"1-2-3"}\n');
    writeFileSync(join(source, 'data', 'dev.db'), 'SQLite format 3\u0000');
    writeFileSync(join(source, 'data', 'test.jsonl'), 'not this split\n');
    const archive = join(dir, 'data.tar.bz2');
    execFileSync('tar', ['cjf', archive, '-C', source, 'data']);

    const staging = join(dir, 'staging');
    const moved = extract(archive, staging, planOf('dev'));

    expect(moved).toEqual(['dev.jsonl', 'dev.tables.jsonl', 'dev.db']);
    expect(readFileSync(join(staging, 'dev.jsonl'), 'utf8')).toContain('1-2-3');
    // The rest of the archive is 180 MB of other splits; keeping it would be keeping the corpus.
    expect(() => readFileSync(join(staging, 'data', 'test.jsonl'))).toThrow();
  });
});

describe('main', () => {
  it('refuses to work offline from a cold cache', async () => {
    const dir = workspace();
    process.env.WIKISQL_CACHE = dir;
    try {
      await expect(main(['--offline'])).rejects.toThrow(/cache is cold/);
      // The declared counts, because that is what `--offline` checks: 8,421 questions over the
      // 2,716 tables the split declares.
      warm(dir, 8421, Array.from({ length: 2716 }, (_, index) => `t${String(index)}`));
      await expect(main(['--offline'])).resolves.toBe(0);
    } finally {
      delete process.env.WIKISQL_CACHE;
    }
  });

  it('refuses a split name it does not know', async () => {
    await expect(main(['--split', 'validation', '--offline'])).rejects.toThrow(/unknown WikiSQL split/);
    await expect(main(['--offline', '--split'])).rejects.toThrow(/--split needs a name/);
  });
});
