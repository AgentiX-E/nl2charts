import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  entryCheck, entryTail, judgeAll, main, messageOf, mismatch, parseDev, problemsOf, pythonOptions,
  reportSelfTest, selfTest, validate,
} from '../eval/spider/check.js';
import type { JudgeOptions } from '../eval/spider/check.js';

// The protocol, tested without the corpus and without nltk.
//
// Spider's judge imports `process_sql`, which imports `nltk` and needs the `punkt_tab` model — a
// dependency the reference carries and this repository cannot vendor. So `check.ts` is written
// against a *protocol* ("one JSON line in, one JSON line out") and these tests speak it from a stub
// that is nine lines of standard-library Python. The real judge has its own self-test below, which
// skips where its dependency is absent and says so.

const dirs: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `nl2charts-${prefix}-`));
  dirs.push(dir);
  return dir;
}

/** A judge that answers every pair the same way, in standard-library Python only. */
function stub(body: string): JudgeOptions {
  const dir = temp('spider-stub');
  const script = join(dir, 'stub.py');
  writeFileSync(script, body);
  return { python: process.env.PYTHON ?? 'python3', script };
}

const AGREES = stub([
  'import sys',
  'for line in sys.stdin:',
  '    if line.strip():',
  '        print(\'{"em": 1, "gold": "ok", "pred": "ok"}\')',
  '        sys.stdout.flush()',
  '',
].join('\n'));

const GOLD_BROKEN = stub([
  'import sys',
  'for line in sys.stdin:',
  '    if line.strip():',
  '        print(\'{"em": 0, "gold": "error", "pred": "unparsed"}\')',
  '        sys.stdout.flush()',
  '',
].join('\n'));

const ONE_ANSWER = stub([
  'import sys',
  'print(\'{"em": 1, "gold": "ok", "pred": "ok"}\')',
  '',
].join('\n'));

/** A corpus shape: `dev.json` beside `database/<db>/<db>.sqlite`. */
function corpus(rows: readonly unknown[], databases: readonly string[]): string {
  const dir = temp('spider-corpus');
  writeFileSync(join(dir, 'dev.json'), JSON.stringify(rows));
  for (const name of databases) {
    mkdirSync(join(dir, 'database', name), { recursive: true });
    writeFileSync(join(dir, 'database', name, `${name}.sqlite`), '');
  }
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the file\'s own claims', () => {
  it('checks its own assertions and finds nothing wrong', () => {
    // The flag path prints these; calling the function directly is what makes a failure a test
    // failure rather than a line in a log.
    expect(selfTest()).toEqual([]);
  });
});

describe('the judge protocol', () => {
  it('asks once per pair and reads one verdict per answer', () => {
    const verdicts = judgeAll([
      { db: '/tmp/a.sqlite', pred: 'SELECT 1', gold: 'SELECT 1' },
      { db: '/tmp/a.sqlite', pred: 'SELECT 2', gold: 'SELECT 2' },
    ], AGREES);
    expect(verdicts).toEqual([{ em: 1, gold: 'ok', pred: 'ok' }, { em: 1, gold: 'ok', pred: 'ok' }]);
  });

  it('starts no process for an empty set of pairs', () => {
    // A judge that is started to answer nothing is a process whose silence is read as agreement.
    expect(judgeAll([], { python: '/nonexistent/python', script: '/nonexistent.py' })).toEqual([]);
  });

  it('refuses a judge that answered fewer pairs than it was asked', () => {
    expect(() => judgeAll([
      { db: '/tmp/a.sqlite', pred: 'SELECT 1', gold: 'SELECT 1' },
      { db: '/tmp/a.sqlite', pred: 'SELECT 2', gold: 'SELECT 2' },
    ], ONE_ANSWER)).toThrow(/answered 1 of 2 pairs/u);
  });

  it('refuses a judge that could not be started, rather than reading a zero', () => {
    expect(() => judgeAll([{ db: '/tmp/a.sqlite', pred: 'SELECT 1', gold: 'SELECT 1' }],
      { python: '/nonexistent/python', script: '/nonexistent.py' })).toThrow(/could not start the judge/u);
  });

  it('refuses a judge that crashed', () => {
    const crashing = stub('import sys\nsys.exit(3)\n');
    expect(() => judgeAll([{ db: '/tmp/a.sqlite', pred: 'SELECT 1', gold: 'SELECT 1' }], crashing))
      .toThrow(/the judge exited 3/u);
  });
});

describe('validate', () => {
  it('counts the databases, the questions, and the golds that agree with themselves', async () => {
    const reading = await validate(corpus([
      { db_id: 'a', query: 'SELECT 1', question: 'q' },
      { db_id: 'b', query: 'SELECT 2' },
    ], ['a', 'b']), AGREES);
    expect(reading).toEqual({ databases: 2, questions: 2, goldErrors: 0, agreement: 2, firstError: undefined });
  });

  it('names the first gold that does not parse instead of counting it invisibly', async () => {
    const reading = await validate(corpus([
      { db_id: 'a', query: 'SELECT nope' },
      { db_id: 'a', query: 'SELECT 2' },
    ], ['a']), GOLD_BROKEN);
    expect(reading.goldErrors).toBe(2);
    expect(reading.firstError).toBe('a: SELECT nope');
  });

  it('refuses a split whose database is missing, and says which one', async () => {
    const dir = corpus([{ db_id: 'a', query: 'SELECT 1' }, { db_id: 'gone', query: 'SELECT 2' }], ['a']);
    await expect(validate(dir, AGREES)).rejects.toThrow(/database gone is missing: expected .*gone\.sqlite/u);
  });

  it('refuses a checkout with no dev.json', async () => {
    const dir = temp('spider-empty');
    await expect(validate(dir, AGREES)).rejects.toThrow(/no dev\.json in /u);
  });
});

describe('parseDev', () => {
  it('keeps the two fields a check reads, and the question when there is one', () => {
    expect(parseDev('[{"db_id":"a","query":"SELECT 1","question":"how many"}]')).toEqual([
      { db_id: 'a', query: 'SELECT 1', question: 'how many' },
    ]);
  });

  it('refuses an entry that is not a question', () => {
    expect(() => parseDev('[{"db_id":3,"query":"SELECT 1"}]')).toThrow(/entry 0 has no db_id\/query/u);
  });
});

describe('problemsOf', () => {
  it('accepts only a split where every gold parsed and agrees with itself', () => {
    expect(problemsOf({ databases: 20, questions: 1034, goldErrors: 0, agreement: 1034, firstError: undefined })).toEqual([]);
  });

  it('reports both a parse failure and the agreement it costs', () => {
    expect(problemsOf({ databases: 1, questions: 4, goldErrors: 1, agreement: 3, firstError: 'a: SELECT x' })).toEqual([
      '1 of 4 golds do not parse, first at a: SELECT x',
      '3 of 4 golds read exact match against themselves',
    ]);
  });
});

describe('the file as a program', () => {
  const out = (): { seen: string[]; log: (line: string) => void } => {
    const seen: string[] = [];
    return { seen, log: (line) => seen.push(line) };
  };

  it('runs its self-test from the flag', async () => {
    const log = out();
    expect(await main(['--self-test'], log.log)).toBe(0);
    expect(log.seen.join('\n')).toContain('spider self-test: ok');
  });

  it('refuses to run without a corpus rather than inventing a default one', async () => {
    const log = out();
    expect(await main([], log.log)).toBe(2);
    expect(log.seen.join('\n')).toContain('--spider <dir> is required');
  });

  it('refuses a flag it does not read', async () => {
    const log = out();
    expect(await main(['--spider', '/tmp', '--wat'], log.log)).toBe(2);
    expect(log.seen.join('\n')).toContain('unexpected argument --wat');
  });

  it('refuses a dev.json entry that is not a question, before any judge is started', async () => {
    const log = out();
    const dir = corpus([], ['a']);
    writeFileSync(join(dir, 'dev.json'), '[{"db_id":"a"}]');
    expect(await main(['--spider', dir], log.log)).toBe(2);
    expect(log.seen.join('\n')).toContain('entry 0 has no db_id/query');
  });

  it('prints the reading for a scorable corpus and exits 0', async () => {
    const log = out();
    const dir = corpus([{ db_id: 'a', query: 'SELECT 1' }], ['a']);
    // A stub stands in for the judge: this asserts the printed shape and the exit code, not the
    // parse — the real judge's own self-test is the test above.
    expect(await main(['--spider', dir], log.log, AGREES)).toBe(0);
    expect(log.seen).toEqual([
      'spider corpus: 1 databases, 1 questions',
      'spider corpus: gold  1 / 1 parsed',
      'spider corpus: self  1 / 1 read exact match against themselves',
    ]);
  });

  it('exits 1, not 2, when the corpus is readable and unscorable', async () => {
    const log = out();
    const dir = corpus([{ db_id: 'a', query: 'SELECT nope' }], ['a']);
    expect(await main(['--spider', dir], log.log, GOLD_BROKEN)).toBe(1);
    expect(log.seen.join('\n')).toContain('1 of 1 golds do not parse, first at a: SELECT nope');
  });
});

describe('the three claims the self-test is made of', () => {
  it('says nothing when a claim holds and names both values when it does not', () => {
    expect(mismatch('two questions', 2, 2)).toBeUndefined();
    expect(mismatch('two questions', 3, 2)).toBe('two questions: got 3, want 2');
  });

  it('reads a refusal whether or not it was thrown as an Error', () => {
    expect(messageOf(new Error('no dev.json'))).toBe('no dev.json');
    expect(messageOf(42)).toBe('42');
  });

  it('prints a self-test that failed, and exits 1', () => {
    const seen: string[] = [];
    expect(reportSelfTest(['a claim: got 1, want 2'], (line) => { seen.push(line); })).toBe(1);
    expect(seen).toEqual(['spider self-test: a claim: got 1, want 2', 'spider self-test: FAILED']);
    expect(reportSelfTest([], () => {})).toBe(0);
  });
});

describe('the edges a workflow touches', () => {
  it('reads the interpreter from the environment when it is set, and says python3 when it is not', () => {
    const previous = process.env.PYTHON;
    try {
      process.env.PYTHON = '/opt/other/python';
      expect(pythonOptions().python).toBe('/opt/other/python');
      delete process.env.PYTHON;
      expect(pythonOptions().python).toBe('python3');
      expect(pythonOptions().script).toMatch(/eval\/spider\/judge\.py$/u);
    } finally {
      if (previous === undefined) delete process.env.PYTHON;
      else process.env.PYTHON = previous;
    }
  });

  it('refuses a --spider with no directory after it', async () => {
    const seen: string[] = [];
    expect(await main(['--spider'], (line) => { seen.push(line); })).toBe(2);
    expect(seen.join('\n')).toContain('--spider needs a directory');
  });

  it('writes to stdout when no log is injected, which is how a workflow reads it', async () => {
    // The default logger is a function nothing else calls; a run that only ever injects one would
    // leave it uncovered and let a broken default ship.
    expect(await main(['--self-test'])).toBe(0);
  });

  it('does nothing at the tail when the module was only imported', () => {
    const seen: number[] = [];
    entryTail(undefined, (value) => seen.push(value));
    expect(seen).toEqual([]);
    entryTail(7, (value) => seen.push(value));
    expect(seen).toEqual([7]);
    // The default setter, which is what the tool itself uses.
    const previous = process.exitCode;
    entryTail(6);
    expect(process.exitCode).toBe(6);
    entryTail(undefined);
    expect(process.exitCode).toBe(6);
    process.exitCode = previous;
  });

  it('returns nothing rather than running when it is not the entry point', async () => {
    expect(await entryCheck(undefined, import.meta.url, () => {})).toBeUndefined();
  });
});

// The real judge, where its dependency exists.
const hasNltk = (): boolean => {
  const run = spawnSync(process.env.PYTHON ?? 'python3', ['-c', 'import nltk; nltk.data.find("tokenizers/punkt_tab")'], { encoding: 'utf8' });
  return run.status === 0;
};

describe.skipIf(!hasNltk())('the vendored reference judge', () => {
  it('runs its own self-test, including the label it consumes', () => {
    const run = spawnSync(process.env.PYTHON ?? 'python3', [resolve('eval/spider/judge.py'), '--self-test'], { encoding: 'utf8' });
    expect(run.stdout).toContain('spider judge: self-test: ok');
    expect(run.status).toBe(0);
  });
});
