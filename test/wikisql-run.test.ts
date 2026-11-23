import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { cacheDir, diff, main, reportLines, resolveSettings, score, selfTest, validate } from '../eval/wikisql/run.js';
import { parseSplit } from '../eval/wikisql/exec.js';
import type { Answer, Reading, SplitRow } from '../eval/wikisql/exec.js';

// The command line is the contract a workflow calls, so these tests run it: a real cache, a real
// database, a real oracle process. The split is four questions over three rows, which is enough
// for one exact match, one bag-only match, one refused prediction and one gold that cannot execute.

const dirs: string[] = [];

function lines(): { log: (line: string) => void; seen: string[] } {
  const seen: string[] = [];
  return { seen, log: (line) => seen.push(line) };
}

function fixture(questions: readonly unknown[], name = 'dev'): string {
  const dir = mkdtempSync(join(tmpdir(), 'nl2charts-wikisql-run-'));
  dirs.push(dir);
  const writer = new DatabaseSync(join(dir, `${name}.db`));
  writer.exec(`
    create table table_1_2_3 (col0 real, col1 text);
    insert into table_1_2_3 values (1, 'a'), (2, 'b'), (2, 'c');
  `);
  writer.close();
  writeFileSync(join(dir, `${name}.jsonl`), `${questions.map((row) => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(join(dir, `${name}.tables.jsonl`), '{"id":"1-2-3"}\n');
  return dir;
}

const GOOD = [
  { table_id: '1-2-3', question: 'q', sql: { sel: 1, agg: 0, conds: [[0, 0, 2]] } },
  { table_id: '1-2-3', question: 'r', sql: { sel: 0, agg: 3, conds: [] } },
];

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveSettings', () => {
  it('defaults to the dev split with no limit and no predictions', () => {
    expect(resolveSettings([])).toEqual({
      split: 'dev',
      limit: undefined,
      predictions: undefined,
      out: undefined,
      cache: undefined,
      digest: false,
    });
  });

  it('reads every flag it documents', () => {
    const settings = resolveSettings([
      '--split',
      'test',
      '--limit',
      '500',
      '--predictions',
      'p.jsonl',
      '--out',
      'o.json',
      '--cache',
      '/tmp/c',
      '--digest',
    ]);
    expect(settings).toEqual({
      split: 'test',
      limit: 500,
      predictions: 'p.jsonl',
      out: 'o.json',
      cache: '/tmp/c',
      digest: true,
    });
  });

  it('refuses a flag without its value', () => {
    for (const flag of ['--split', '--limit', '--predictions', '--out', '--cache']) {
      expect(() => resolveSettings([flag])).toThrow(/needs/);
    }
  });

  it('refuses a limit that is not a positive whole count', () => {
    expect(() => resolveSettings(['--limit', '0'])).toThrow(/positive count/);
    expect(() => resolveSettings(['--limit', '2.5'])).toThrow(/positive count/);
    expect(() => resolveSettings(['--limit', 'many'])).toThrow(/positive count/);
  });

  it('refuses an unknown flag and a bare argument', () => {
    expect(() => resolveSettings(['--nope'])).toThrow(/unknown flag --nope/);
    expect(() => resolveSettings(['stray'])).toThrow(/unexpected argument stray/);
  });
});

describe('cacheDir', () => {
  it('takes the override, then the environment, then the repository default', () => {
    expect(cacheDir('/tmp/one')).toBe('/tmp/one');
    const previous = process.env.WIKISQL_CACHE;
    process.env.WIKISQL_CACHE = '/tmp/two';
    try {
      expect(cacheDir()).toBe('/tmp/two');
    } finally {
      if (previous === undefined) delete process.env.WIKISQL_CACHE;
      else process.env.WIKISQL_CACHE = previous;
    }
    expect(cacheDir()).toBe(resolve('eval/.cache/wikisql'));
  });
});

describe('reportLines', () => {
  const base: Reading = { cases: 4, scored: 0, exact: 0, bag: 0, goldErrors: 0, goldEmpty: 0, predErrors: 0 };

  it('reports the gold denominator even when nothing was scored', () => {
    const report = reportLines(base, { cases: 4, errors: 0, empty: 0, unstable: [], firstError: undefined });
    expect(report.join('\n')).toContain('gold     4 / 4 executed, 0 empty');
    expect(report.join('\n')).not.toContain('exact');
  });

  it('reports the two comparisons and the statements that did not run', () => {
    const report = reportLines({ ...base, scored: 4, exact: 3, bag: 4, predErrors: 1 }, undefined);
    const text = report.join('\n');
    expect(text).toContain('exact    3 / 4 = 75.00%  (reference order)');
    expect(text).toContain('bag      4 / 4 = 100.00%  (order erased)');
    expect(text).toContain('refused  1 statements did not execute');
  });

  it('names a gold that failed and a pass that disagreed with itself', () => {
    const report = reportLines(base, {
      cases: 4,
      errors: 1,
      empty: 0,
      unstable: [2],
      firstError: '3: column outside the table',
    });
    expect(report.join('\n')).toContain('unstable 1 questions answered differently on a second pass');
    expect(report.join('\n')).toContain('first gold error: 3: column outside the table');
  });

  it('keeps going when the failure has no message', () => {
    const report = reportLines(base, { cases: 1, errors: 1, empty: 0, unstable: [], firstError: undefined });
    expect(report.join('\n')).toContain('first gold error: unknown');
  });
});

describe('selfTest', () => {
  it('holds every claim it makes', () => {
    expect(selfTest()).toEqual([]);
  });
});

describe('main', () => {
  it('runs its own self-test from the flag', async () => {
    const out = lines();
    expect(await main(['--self-test'], out.log)).toBe(0);
    expect(out.seen.join('\n')).toContain('wikisql self-test: ok');
  });

  it('refuses a cold cache and says how to warm it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl2charts-wikisql-cold-'));
    dirs.push(dir);
    await expect(main(['--cache', dir], () => {})).rejects.toThrow(/cache is cold.*fetch\.mjs/u);
  });

  it('validates a split by executing every gold twice', async () => {
    const dir = fixture(GOOD);
    const out = lines();
    expect(await main(['--cache', dir], out.log)).toBe(0);
    const text = out.seen.join('\n');
    expect(text).toContain('wikisql 2 questions');
    expect(text).toContain('gold     2 / 2 executed, 0 empty');
  });

  it('scores predictions against the reference comparison', async () => {
    const dir = fixture(GOOD);
    writeFileSync(
      join(dir, 'predictions.jsonl'),
      '{"index":0,"sql":"select col1 from table_1_2_3 where col0 = 2 order by col1 desc"}\n' +
        '{"index":1,"sql":"select count(col0) from table_1_2_3"}\n',
    );
    const out = lines();
    expect(await main(['--cache', dir, '--predictions', join(dir, 'predictions.jsonl')], out.log)).toBe(0);
    const text = out.seen.join('\n');
    expect(text).toContain('exact    1 / 2 = 50.00%  (reference order)');
    // The first question is right and sorted the other way, which is the whole reason the bag
    // column exists: 50% is a judging artefact here, not a wrong answer.
    expect(text).toContain('bag      2 / 2 = 100.00%  (order erased)');
    expect(text).not.toContain('missing');
  });

  it('reports questions no prediction covers instead of scoring them as misses', async () => {
    const dir = fixture(GOOD);
    writeFileSync(join(dir, 'p.jsonl'), '{"index":1,"sql":"select count(col0) from table_1_2_3"}\n');
    const out = lines();
    expect(await main(['--cache', dir, '--predictions', join(dir, 'p.jsonl')], out.log)).toBe(0);
    expect(out.seen.join('\n')).toContain('missing  1 questions have no prediction');
    expect(out.seen.join('\n')).toContain('exact    1 / 1 = 100.00%');
  });

  it('prints a digest over every gold answer when asked', async () => {
    const dir = fixture(GOOD);
    const out = lines();
    expect(await main(['--cache', dir, '--digest'], out.log)).toBe(0);
    expect(out.seen.join('\n')).toMatch(/\b[0-9a-f]{64}\b/u);
  });

  it('writes the reading to a file, with the split and the engine it came from', async () => {
    const dir = fixture(GOOD);
    const target = join(dir, 'reading.json');
    expect(await main(['--cache', dir, '--out', target], () => {})).toBe(0);
    const written = JSON.parse(readFileSync(target, 'utf8')) as {
      split: string;
      validation: { cases: number };
      reading: Reading;
    };
    expect(written.split).toBe('dev');
    expect(written.validation.cases).toBe(2);
    expect(written.reading.goldErrors).toBe(0);
  });

  it('restricts the split to the first N questions', async () => {
    const dir = fixture(GOOD);
    const out = lines();
    expect(await main(['--cache', dir, '--limit', '1'], out.log)).toBe(0);
    expect(out.seen.join('\n')).toContain('wikisql 1 questions');
  });

  it('exits non-zero when a gold cannot be judged', async () => {
    const dir = fixture([
      GOOD[0],
      { table_id: '1-2-3', question: 'r', sql: { sel: 9, agg: 0, conds: [] } },
    ]);
    const out = lines();
    expect(await main(['--cache', dir], out.log)).toBe(1);
    expect(out.seen.join('\n')).toContain('gold     1 / 2 executed');
    expect(out.seen.join('\n')).toContain('outside table_1_2_3');
  });

  it('scores a named split beside the default one', async () => {
    const dir = fixture(GOOD);
    copyFileSync(join(dir, 'dev.db'), join(dir, 'test.db'));
    copyFileSync(join(dir, 'dev.jsonl'), join(dir, 'test.jsonl'));
    copyFileSync(join(dir, 'dev.tables.jsonl'), join(dir, 'test.tables.jsonl'));
    const out = lines();
    expect(await main(['--cache', dir, '--split', 'test', '--out', join(dir, 'r.json')], out.log)).toBe(0);
    expect(existsSync(join(dir, 'r.json'))).toBe(true);
  });
});

describe('diff', () => {
  it('says nothing when the two agree, and names the claim when they do not', () => {
    expect(diff('a', [1, 2], [1, 2])).toBeUndefined();
    expect(diff('a', [1, 2], [1, 3])).toBe('a: [1,2] !== [1,3]');
  });
});

describe('validate, folded over answers it is given', () => {
  const rows: SplitRow[] = parseSplit(
    '{"table_id":"t","question":"q","sql":{"sel":0,"agg":0,"conds":[]}}\n{"table_id":"t","question":"r","sql":{"sel":0,"agg":0,"conds":[]}}\n',
  );
  const answer = (rows: unknown[][]): Answer => ({ ok: true, rows: rows as number[][] });
  const failed: Answer = { ok: false, error: 'boom' };

  it('counts a gold that executed as empty without calling it an error', async () => {
    const validation = await validate(() => Promise.resolve(answer([])), rows);
    expect(validation).toEqual({ cases: 2, errors: 0, empty: 2, unstable: [], firstError: undefined });
  });

  it('keeps the first error and does not let the second overwrite it', async () => {
    const calls = { count: 0 };
    const validation = await validate(() => {
      calls.count += 1;
      // Two passes over two questions: every one of the four calls fails.
      return Promise.resolve({ ok: false, error: `boom ${String(calls.count)}` });
    }, rows);
    expect(validation.errors).toBe(2);
    expect(validation.firstError).toBe('0: boom 1');
  });

  it('reports a gold that answered differently on the second pass', async () => {
    const answers = [answer([[1]]), answer([[1]]), answer([[1]]), answer([[2]])];
    let index = 0;
    const validation = await validate(() => {
      const next = answers[index] as Answer;
      index += 1;
      return Promise.resolve(next);
    }, rows);
    expect(validation.unstable.length).toBe(1);
  });

  it('reports a gold that answered once and then did not', async () => {
    // The judge's database changed underneath it: the first pass executed and the second refused.
    const answers: Answer[] = [answer([[1]]), answer([[1]]), failed, failed];
    // Both questions executed on the first pass and neither did on the second, so both are unstable:
    // the unit is "a gold that stopped answering", not "a run that stopped".
    let index = 0;
    const validation = await validate(() => {
      const next = answers[index] as Answer;
      index += 1;
      return Promise.resolve(next);
    }, rows);
    expect(validation.unstable).toEqual([0, 1]);
  });
});

describe('score, folded over answers it is given', () => {
  const rows: SplitRow[] = parseSplit(
    '{"table_id":"t","question":"q","sql":{"sel":0,"agg":0,"conds":[]}}\n{"table_id":"t","question":"r","sql":{"sel":0,"agg":0,"conds":[]}}\n',
  );

  it('scores only the questions a prediction names, and counts the rest as missing', async () => {
    const gold: Answer = { ok: true, rows: [[1]] };
    const scored = await score(
      () => Promise.resolve(gold),
      (_row, sql) => Promise.resolve({ ok: true, rows: sql === 'hit' ? [[1]] : [[2]] }),
      rows,
      new Map([
        [0, 'hit'],
        [1, 'miss'],
      ]),
    );
    expect(scored.missing).toBe(0);
    expect(scored.readings.map((reading) => reading.ordered)).toEqual([true, false]);
  });

  it('reports the questions no prediction covers', async () => {
    const scored = await score(
      () => Promise.resolve({ ok: true, rows: [[1]] }),
      () => Promise.resolve({ ok: true, rows: [[1]] }),
      rows,
      new Map([[0, 'SELECT 1']]),
    );
    expect(scored.missing).toBe(1);
  });
});

describe('the file as a program', () => {
  it('runs its self-test from the command line and prints the claim it checked', () => {
    // The guard that makes the file an entry point is only exercised by being one: a test that
    // imported `main` and called it would leave every line after `if (process.argv[1]…)` unrun,
    // which is how an entry point that throws on startup ships.
    const result = spawnSync('pnpm', ['exec', 'tsx', 'eval/wikisql/run.ts', '--self-test'], {
      cwd: resolve('.'),
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(result.stdout).toContain('wikisql self-test: ok');
    expect(result.status).toBe(0);
  });

  it('exits non-zero and says why when the arguments are wrong', () => {
    const result = spawnSync('pnpm', ['exec', 'tsx', 'eval/wikisql/run.ts', '--nope'], {
      cwd: resolve('.'),
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown flag --nope');
  });
});
