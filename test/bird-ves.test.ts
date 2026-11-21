import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  RVES_BANDS,
  cleanTimings,
  describeVes,
  main,
  measureVes,
  openTimer,
  runAsEntry,
  parseVesArgs,
  rewardFor,
  rvesOf,
  timeRatio,
  vesCandidates,
  type StatementTimer,
  type VesCase,
} from '../eval/bird/ves.js';

const root = mkdtempSync(join(tmpdir(), 'nl2charts-ves-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const at = (tau: number, correct = true): VesCase => ({
  id: String(tau),
  correct,
  goldTime: tau * 1000,
  predictedTime: 1000,
});

describe('the reward table', () => {
  it('steps at the boundaries BIRD quotes, not near them', () => {
    // Every value below is a band edge from the definition, and each pair is the edge and the
    // value one tick inside it. A `<` that should be `<=` moves one of these two rows.
    expect(rewardFor(2)).toBe(1.25);
    expect(rewardFor(1.999)).toBe(1);
    expect(rewardFor(1)).toBe(1);
    expect(rewardFor(0.999)).toBe(0.75);
    expect(rewardFor(0.5)).toBe(0.75);
    expect(rewardFor(0.499)).toBe(0.5);
    expect(rewardFor(0.25)).toBe(0.5);
    expect(rewardFor(0.249)).toBe(0.25);
    expect(rewardFor(0.001)).toBe(0.25);
  });

  it('pays the top band only for a ratio that is infinite or finite', () => {
    expect(rewardFor(Number.POSITIVE_INFINITY)).toBe(1.25);
    expect(rewardFor(40)).toBe(1.25);
  });

  it('refuses to read a ratio it does not have', () => {
    // NaN means the ratio could not be computed; 0 is what an unknown ratio would silently earn
    // if the table were searched with `find` and no guard, which is a wrong answer paid as a slow
    // right one.
    expect(rewardFor(Number.NaN)).toBe(0);
    expect(rewardFor(-1)).toBe(0);
  });

  it('publishes the table it applies, so a report can print the bands it counted', () => {
    expect(RVES_BANDS.map((band) => band.reward)).toEqual([1.25, 1, 0.75, 0.5, 0.25]);
  });
});

describe('the time ratio', () => {
  it('is gold over predicted', () => {
    expect(timeRatio(300, 100)).toBe(3);
    expect(timeRatio(100, 300)).toBeCloseTo(1 / 3, 12);
    expect(timeRatio(100, 100)).toBe(1);
  });

  it('reads two zero readings as parity, not as an infinite win', () => {
    // The defect this pins: `oracle.py` reported whole milliseconds, most BIRD statements finish
    // inside one, and both sides read 0. Paying 1.25 for that would rank a system by the
    // resolution of its stopwatch.
    expect(timeRatio(0, 0)).toBe(1);
    expect(timeRatio(500, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it('answers NaN for a reading that is not a measurement', () => {
    expect(timeRatio(Number.NaN, 10)).toBeNaN();
    expect(timeRatio(10, Number.NaN)).toBeNaN();
    expect(timeRatio(-1, 10)).toBeNaN();
    expect(timeRatio(10, -1)).toBeNaN();
  });
});

describe('trimming the timings', () => {
  it('drops the right tail a loaded machine adds', () => {
    const trimmed = cleanTimings([100, 101, 99, 100, 9000]);
    expect(trimmed).toBeCloseTo(100, 6);
  });

  it('keeps a sample whose spread is zero', () => {
    // A window of zero width would delete every member of a sample that took the same time every
    // run, which is the most stable statement in the corpus.
    expect(cleanTimings([7, 7, 7])).toBe(7);
  });

  it('answers undefined rather than zero when nothing survived', () => {
    expect(cleanTimings([])).toBeUndefined();
    expect(cleanTimings([Number.NaN, -3])).toBeUndefined();
  });

  it('reports the fastest observation when two samples cannot be told apart', () => {
    // Noise on a shared machine is additive, so of two readings the smaller one is the one the
    // statement actually took. This is also the case where a median-absolute-deviation window
    // cannot distinguish an outlier from the signal, and the module says so rather than averaging.
    expect(cleanTimings([100, 10000])).toBe(100);
  });
});

describe('the reading', () => {
  it('averages over every question, and says what the other normalisation would be', () => {
    // 1.0 + 1.0 + 1.25 over four questions, one of them wrong.
    const reading = rvesOf([at(1), at(1), at(2), at(0.1, false)]);
    expect(reading.cases).toBe(4);
    expect(reading.valid).toBe(3);
    expect(reading.rves).toBeCloseTo(3.25 / 4, 12);
    expect(reading.rvesOfValid).toBeCloseTo(3.25 / 3, 12);
  });

  it('counts the bands it paid', () => {
    const reading = rvesOf([at(3), at(1), at(0.75), at(0.3), at(0.1)]);
    expect(reading.bands.map((band) => band.cases)).toEqual([1, 1, 1, 1, 1]);
  });

  it('separates a correct statement that could not be timed from a wrong one', () => {
    const reading = rvesOf([
      at(1),
      { id: 'broken', correct: true, goldTime: Number.NaN, predictedTime: 10 },
    ]);
    expect(reading.valid).toBe(1);
    expect(reading.unmeasured).toBe(1);
    expect(reading.rves).toBeCloseTo(1 / 2, 12);
  });

  it('is zero, not NaN, on an empty corpus', () => {
    expect(rvesOf([])).toMatchObject({ cases: 0, valid: 0, rves: 0, rvesOfValid: 0 });
  });
});

describe('measuring over a runner', () => {
  const timerOf = (times: Record<string, number[]>, calls: string[]): StatementTimer => {
    return async (_db, sql) => {
      calls.push(sql);
      const queue = times[sql];
      if (queue === undefined) return { ok: false, us: 0 };
      const us = queue.length > 1 ? (queue.shift() as number) : (queue[0] as number);
      return { ok: true, us };
    };
  };

  it('times both statements of a correct case and neither of a wrong one', async () => {
    const calls: string[] = [];
    const reading = await measureVes(
      [
        { id: '1', db: 'shop', gold: 'G', predicted: 'P', correct: true },
        { id: '2', db: 'shop', gold: 'G2', predicted: 'P2', correct: false },
      ],
      timerOf({ G: [1000], P: [2000], G2: [1], P2: [1] }, calls),
      3,
    );
    expect(reading.valid).toBe(1);
    expect(reading.cases).toBe(2);
    // Three repeats of each side, and the wrong case never reached the runner.
    expect(calls.filter((sql) => sql === 'G')).toHaveLength(3);
    expect(calls).not.toContain('P2');
    expect(reading.rves).toBeCloseTo(0.75 / 2, 12);
  });

  it('marks a case unmeasured when the gold statement will not run', async () => {
    const calls: string[] = [];
    const reading = await measureVes(
      [{ id: '1', db: 'shop', gold: 'MISSING', predicted: 'P', correct: true }],
      timerOf({ P: [1] }, calls),
      2,
    );
    expect(reading.valid).toBe(0);
    expect(reading.unmeasured).toBe(1);
    expect(reading.rves).toBe(0);
  });

  it('treats a correct case with no predicted statement as wrong', async () => {
    const calls: string[] = [];
    const reading = await measureVes([{ id: '1', db: 'shop', gold: 'G', correct: true }],
      timerOf({ G: [1] }, calls), 2);
    expect(calls).toHaveLength(0);
    expect(reading.valid).toBe(0);
  });

  it('never runs fewer than once, whatever the caller asks for', async () => {
    const calls: string[] = [];
    await measureVes([{ id: '1', db: 'shop', gold: 'G', predicted: 'P', correct: true }],
      timerOf({ G: [1], P: [1] }, calls), 0);
    expect(calls).toHaveLength(2);
  });
});

describe('reading an artifact', () => {
  const questions = [
    { question_id: 1, db_id: 'shop', SQL: 'select 1' },
    { question_id: 2, db_id: 'shop', SQL: 'select 2' },
  ];

  it('follows the winner, because the winner is what a caller received', () => {
    const candidates = vesCandidates([
      {
        arm: 'select-mixed',
        id: 1,
        passed: true,
        winnerSource: 'second',
        candidates: [{ source: 'first', sql: 'A' }, { source: 'second', sql: 'B' }],
      },
    ], questions, 'select-mixed');
    expect(candidates[0]?.predicted).toBe('B');
    expect(candidates[0]?.gold).toBe('select 1');
    expect(candidates[0]?.db).toBe('shop');
  });

  it('falls back to the first candidate when the artifact names no winner', () => {
    const candidates = vesCandidates([
      { arm: 'select', id: 2, passed: true, candidates: [{ source: 'only', sql: 'X' }] },
    ], questions, 'select');
    expect(candidates[0]?.predicted).toBe('X');
  });

  it('falls back to the first candidate when the named winner is absent', () => {
    const candidates = vesCandidates([
      { arm: 'select', id: 2, passed: true, winnerSource: 'gone', candidates: [{ source: 'kept', sql: 'K' }] },
    ], questions, 'select');
    expect(candidates[0]?.predicted).toBe('K');
  });

  it('skips another arm, an unknown id and a row with no id', () => {
    const candidates = vesCandidates([
      { arm: 'other', id: 1, passed: true },
      { arm: 'select', id: 99, passed: true },
      { arm: 'select', passed: true },
    ], questions, 'select');
    expect(candidates).toEqual([]);
  });

  it('carries a correct case with no candidate as a wrong one', () => {
    const candidates = vesCandidates([{ arm: 'select', id: 1, passed: true }], questions, 'select');
    expect(candidates[0]).toMatchObject({ correct: true });
    expect(candidates[0]?.predicted).toBeUndefined();
  });
});

describe('the tool', () => {
  it('ignores a bare word and a flag with no value, rather than mistaking either for an invite', () => {
    // The workflow's command line is assembled from a shell string; an empty variable leaves a flag
    // with nothing behind it, and treating the next flag as its value silently swaps two arguments.
    const options = parseVesArgs([
      'stray', '--artifact', 'a.json', '--repeats', '--dataset', 'd.json', '--arm', 'x',
    ]);
    expect(options).toMatchObject({ artifact: 'a.json', dataset: 'd.json', arm: 'x', repeats: 5 });
  });

  it('parses the invite and its defaults', () => {
    const options = parseVesArgs(['--artifact', 'a.json', '--dataset', 'd.json', '--arm', 'x']);
    expect(options).toMatchObject({
      artifact: 'a.json',
      dataset: 'd.json',
      arm: 'x',
      repeats: 5,
      databases: 'eval/.cache/bird/dev_databases',
      oracle: 'eval/bird/oracle.py',
    });
    expect(parseVesArgs(['--artifact', 'a', '--dataset', 'b', '--arm', 'c', '--repeats', '20', '--out', 'o'])
      .repeats).toBe(20);
  });

  it('refuses an invite it cannot act on', () => {
    expect(() => parseVesArgs(['--artifact', 'a'])).toThrow(/--dataset is required/);
    expect(() => parseVesArgs(['--artifact', 'a', '--dataset', 'b', '--arm', 'c', '--repeats', '0']))
      .toThrow(/positive/);
    expect(() => parseVesArgs(['--artifact', 'a', '--dataset', 'b', '--arm', 'c', '--repeats', 'many']))
      .toThrow(/positive/);
  });

  it('describes what it read, and the repeats it used', () => {
    const lines = describeVes(rvesOf([at(3), at(1), at(0.1, false)]), 5);
    expect(lines[0]).toContain('over 3 questions');
    expect(lines[1]).toContain('5x');
    expect(lines.join('\n')).toContain('at least twice as fast: 1');
    const unmeasured = describeVes({ ...rvesOf([]), unmeasured: 2 }, 1);
    expect(unmeasured.join('\n')).toContain('2 correct statements could not be timed');
  });

  it('writes the reading, and refuses an artifact with no case for the arm', async () => {
    const artifact = join(root, 'artifact.json');
    const dataset = join(root, 'dataset.json');
    const out = join(root, 'ves.json');
    writeFileSync(artifact, JSON.stringify({
      cases: [{ arm: 'select-mixed', id: 1, passed: true, winnerSource: 's', candidates: [{ source: 's', sql: 'P' }] }],
    }));
    writeFileSync(dataset, JSON.stringify([{ question_id: 1, db_id: 'shop', SQL: 'G' }]));

    const printed: string[] = [];
    const exit = await main(
      ['--artifact', artifact, '--dataset', dataset, '--arm', 'select-mixed', '--repeats', '2', '--out', out],
      (line) => printed.push(line),
      async () => ({ timer: async () => ({ ok: true, us: 1000 }), close: async () => {} }),
    );
    expect(exit).toBe(0);
    expect(printed[0]).toContain('R-VES 100.00%');
    const written = JSON.parse(readFileSync(out, 'utf8')) as { repeats: number; rves: number };
    expect(written.repeats).toBe(2);
    expect(written.rves).toBeCloseTo(1, 12);

    const empty = join(root, 'no-cases.json');
    writeFileSync(empty, JSON.stringify({}));
    const none: string[] = [];
    expect(await main(
      ['--artifact', empty, '--dataset', dataset, '--arm', 'select-mixed'],
      (line) => none.push(line),
      async () => ({ timer: async () => ({ ok: true, us: 1 }), close: async () => {} }),
    )).toBe(1);
    expect(none[0]).toContain('no cases for arm select-mixed');

    const missing: string[] = [];
    const refused = await main(
      ['--artifact', artifact, '--dataset', dataset, '--arm', 'nobody'],
      (line) => missing.push(line),
      async () => ({ timer: async () => ({ ok: true, us: 1 }), close: async () => {} }),
    );
    expect(refused).toBe(1);
    expect(missing[0]).toContain('no cases for arm nobody');
  });

  it('closes the runner even when the measurement throws', async () => {
    const artifact = join(root, 'artifact2.json');
    const dataset = join(root, 'dataset2.json');
    writeFileSync(artifact, JSON.stringify({
      cases: [{ arm: 'a', id: 1, passed: true, candidates: [{ source: 's', sql: 'P' }] }],
    }));
    writeFileSync(dataset, JSON.stringify([{ question_id: 1, db_id: 'shop', SQL: 'G' }]));
    let closed = false;
    await expect(main(
      ['--artifact', artifact, '--dataset', dataset, '--arm', 'a'],
      () => {},
      async () => ({
        timer: async () => { throw new Error('python died'); },
        close: async () => { closed = true; },
      }),
    )).rejects.toThrow('python died');
    expect(closed).toBe(true);
  });
});

describe('the real runner', () => {
  it('times a statement through the same Python process the benchmark uses', async () => {
    // No mock: a real SQLite file, a real interpreter, the protocol the evaluation speaks. The unit
    // being tested is the adapter's own arithmetic — `us` where the peer sent it, `ms * 1000` where
    // it did not — and a fake would decide that answer for us.
    const root = mkdtempSync(join(tmpdir(), 'nl2charts-ves-runner-'));
    mkdirSync(join(root, 'shop'), { recursive: true });
    const writer = new DatabaseSync(join(root, 'shop', 'shop.sqlite'));
    writer.exec('create table items (id integer); insert into items values (1), (2);');
    writer.close();
    const { timer, close } = await openTimer(resolve('eval/bird/oracle.py'), root);
    try {
      const result = await timer('shop', 'select count(*) from items');
      expect(result.ok).toBe(true);
      expect(result.us).toBeGreaterThan(0);
      const broken = await timer('shop', 'select missing from items');
      expect(broken.ok).toBe(false);
    } finally {
      await close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sets the exit code only when the module is the entry point', async () => {
    const moduleUrl = new URL('../eval/bird/ves.ts', import.meta.url).href;
    const target: { exitCode?: number | string | null } = {};
    // Not the entry point: the guard returns before any run, so no code is set.
    expect(runAsEntry('somewhere-else.ts', moduleUrl, [], target)).toBeUndefined();
    expect(target.exitCode).toBeUndefined();
    // The entry point: the run happens and the code lands on the target.
    const artifact = join(root, 'entry-artifact.json');
    const dataset = join(root, 'entry-dataset.json');
    writeFileSync(artifact, JSON.stringify({
      cases: [{ arm: 'a', id: 1, passed: false }],
    }));
    writeFileSync(dataset, JSON.stringify([{ question_id: 1, db_id: 'shop', SQL: 'G' }]));
    const entry = runAsEntry(fileURLToPath(moduleUrl), moduleUrl,
      ['--artifact', artifact, '--dataset', dataset, '--arm', 'a'], target);
    expect(entry).toBeInstanceOf(Promise);
    await entry;
    expect(target.exitCode).toBe(0);
  });
});
