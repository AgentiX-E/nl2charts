import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  RVES_BANDS,
  cleanTimings,
  describeFloor,
  describeVes,
  main,
  measureVes,
  openTimer,
  runAsEntry,
  parseVesArgs,
  rewardFor,
  rvesOf,
  selfPaired,
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
    // A stand-alone flag is not a value: `--self-check --artifact a` must not file `--artifact` as
    // the flag's value and then lose the artifact.
    expect(parseVesArgs(['--artifact', 'a', '--dataset', 'b', '--arm', 'c']).selfCheck).toBe(false);
    expect(parseVesArgs(['--artifact', 'a', '--dataset', 'b', '--arm', 'c', '--self-check']).selfCheck).toBe(true);
    expect(parseVesArgs(['--self-check', '--artifact', 'a', '--dataset', 'b', '--arm', 'c']))
      .toMatchObject({ artifact: 'a', selfCheck: true });
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

  it('mirrors the statements a floor is measured on, and only those', () => {
    const cases = [
      { id: '1', db: 'shop', gold: 'G1', predicted: 'P1', correct: true },
      { id: '2', db: 'shop', gold: 'G2', predicted: 'P2', correct: false },
      { id: '3', db: 'shop', gold: 'G3', correct: true },
      { id: '4', db: 'shop', gold: 'G4', predicted: 'P4', correct: true },
    ];
    const mirrored = selfPaired(cases);
    expect(mirrored.map((entry) => entry.predicted)).toEqual(['G1', 'P2', undefined, 'G4']);
    // A floor is a second reading of the same artifact, not an edit of it.
    expect(cases[3]?.predicted).toBe('P4');
  });

  it("separates a statement's own speed from the reward table's step at a ratio of one", async () => {
    // The clock answers the same number every time, so the only difference left in the case list is
    // the one it carries: the prediction takes twice as long as the gold. The floor times the gold
    // against itself and reads 100%, and the difference is exactly one band — which is the whole
    // claim a floor makes, stated as arithmetic rather than as prose.
    const timer: StatementTimer = async (_db, sql) => ({ ok: true, us: sql === 'P' ? 2000 : 1000 });
    const candidates = [{ id: '1', db: 'shop', gold: 'G', predicted: 'P', correct: true }];
    const reading = await measureVes(candidates, timer, 3);
    const floor = await measureVes(selfPaired(candidates), timer, 3);
    expect(reading.rves).toBeCloseTo(0.75, 12);
    expect(floor.rves).toBe(1);
    const lines = describeFloor(reading, floor);
    expect(lines[0]).toContain('R-VES floor 100.00%');
    expect(lines[1]).toContain('R-VES net -25.00pp');
  });

  it('prints the floor only when it was asked for, and writes it beside the reading', async () => {
    const artifact = join(root, 'floor-artifact.json');
    const dataset = join(root, 'floor-dataset.json');
    const out = join(root, 'floor.json');
    writeFileSync(artifact, JSON.stringify({
      cases: [{ arm: 'a', id: 1, passed: true, winnerSource: 's', candidates: [{ source: 's', sql: 'P' }] }],
    }));
    writeFileSync(dataset, JSON.stringify([{ question_id: 1, db_id: 'shop', SQL: 'G' }]));
    const silent: string[] = [];
    await main(
      ['--artifact', artifact, '--dataset', dataset, '--arm', 'a', '--repeats', '2'],
      (line) => silent.push(line),
      async () => ({ timer: async () => ({ ok: true, us: 1000 }), close: async () => {} }),
    );
    expect(silent.join('\n')).not.toContain('floor');
    const asked: string[] = [];
    await main(
      ['--artifact', artifact, '--dataset', dataset, '--arm', 'a', '--repeats', '2', '--self-check', '--out', out],
      (line) => asked.push(line),
      async () => ({ timer: async () => ({ ok: true, us: 1000 }), close: async () => {} }),
    );
    expect(asked.join('\n')).toContain('R-VES floor 100.00%');
    expect(asked.join('\n')).toContain('R-VES net 0.00pp');
    const written = JSON.parse(readFileSync(out, 'utf8')) as { floor?: { rves: number } };
    expect(written.floor?.rves).toBeCloseTo(1, 12);
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

/**
 * A peer that speaks the protocol and reports whole milliseconds only.
 *
 * Every `oracle.py` before this round looked like this, and a harness that reads `ms * 1000` when
 * `us` is absent treats the coarsening as a measurement rather than as a missing instrument.
 */
const COARSE_PEER = `
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    print(json.dumps({"id": request["id"], "ok": True, "columns": [], "rows": [[1]], "ms": 1}), flush=True)
`;

describe('the real runner', () => {
  it('times a statement through the same Python process the benchmark uses', async () => {    // No mock: a real SQLite file, a real interpreter, the protocol the evaluation speaks. The unit
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

  it('refuses to time a peer that reports whole milliseconds, rather than paying 1.25 to everyone', async () => {
    // A peer that sends `ms` and no `us` cannot resolve this corpus: most BIRD statements finish
    // inside a millisecond, both sides then read the same integer, τ = 1, and the reward table pays
    // its top band to every system. `undefined` is the reading that says "not measurable"; the case
    // is counted as unmeasured instead of being floored at a whole millisecond.
    const root = mkdtempSync(join(tmpdir(), 'nl2charts-ves-coarse-'));
    const script = join(root, 'coarse_oracle.py');
    writeFileSync(script, COARSE_PEER);
    const { timer, close } = await openTimer(script, root);
    try {
      const result = await timer('shop', 'select 1');
      expect(result.ok).toBe(true);
      expect(result.us).toBeUndefined();
    } finally {
      await close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts a statement whose clock cannot resolve it as unmeasured, not as fastest', async () => {
    const reading = await measureVes(
      [{ id: '1', db: 'shop', gold: 'select 1', predicted: 'select 1', correct: true }],
      async () => ({ ok: true, us: undefined }),
      1,
    );
    expect(reading.cases).toBe(1);
    expect(reading.valid).toBe(0);
    expect(reading.unmeasured).toBe(1);
    expect(reading.rves).toBe(0);
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

describe('the reading this repository publishes', () => {
  // `eval/baseline/bird-ves.json` is a claim, and a claim with arithmetic in it is a claim that can be
  // checked. The bands are what the score is made of, so a reading whose bands do not add up to the
  // number of valid answers is a reading someone copied wrongly — and the file is edited by hand,
  // because it is a record of a run rather than an output of one.
  const baseline = JSON.parse(readFileSync(resolve('eval/baseline/bird-ves.json'), 'utf8')) as {
    rves: number;
    rvesOfValid: number;
    ex: number;
    scored: number;
    of: number;
    runs: number[];
    bands: { label: string; cases: number }[];
    repeats: number;
    floor: { rves: number; net: number; bands: { label: string; cases: number }[] };
  };

  it('accounts for every correct answer in one band and no other', () => {
    const valid = Math.round((baseline.ex / 100) * baseline.scored);
    expect(baseline.bands.reduce((sum, band) => sum + band.cases, 0)).toBe(valid);
  });

  it('derives its own score from the bands it reports', () => {
    // The band counts are means over two full runs, so the derived reward is allowed to sit a
    // twentieth of a point away from the published figure; anything larger means the bands and the
    // score describe different runs.
    const paid = baseline.bands.reduce((sum, row) => {
      const band = RVES_BANDS.find((entry) => entry.label === row.label);
      if (band === undefined) throw new Error(`unknown band ${row.label}`);
      return sum + band.reward * row.cases;
    }, 0);
    const derived = (paid / baseline.scored) * 100;
    expect(Math.abs(derived - baseline.rves)).toBeLessThan(0.1);
  });

  it('is a subset of the split, not the split', () => {
    // The row is `partial` for exactly this reason: 600 of 1,532 is not the leaderboard's denominator.
    expect(baseline.scored).toBeGreaterThan(0);
    expect(baseline.scored).toBeLessThan(baseline.of);
    expect(baseline.runs.length).toBeGreaterThan(1);
    expect(Math.max(...baseline.runs) - Math.min(...baseline.runs)).toBeLessThan(0.5);
    expect(baseline.repeats).toBeGreaterThanOrEqual(3);
  });

  it('carries a floor whose arithmetic is its own', () => {
    // The floor is a second reading of the same artifact, so it has to account for the same correct
    // answers and derive its own score the same way. A floor with no 1.25 band is the shape the
    // measurement predicts: a statement timed against itself cannot run twice as fast as itself,
    // and the table pays nothing between a ratio of one and a ratio of two.
    expect(baseline.floor.bands.reduce((sum, band) => sum + band.cases, 0))
      .toBe(Math.round((baseline.ex / 100) * baseline.scored));
    const paid = baseline.floor.bands.reduce((sum, row) => {
      const band = RVES_BANDS.find((entry) => entry.label === row.label);
      if (band === undefined) throw new Error(`unknown band ${row.label}`);
      return sum + band.reward * row.cases;
    }, 0);
    expect(Math.abs((paid / baseline.scored) * 100 - baseline.floor.rves)).toBeLessThan(0.1);
    expect(baseline.floor.bands.filter((row) => row.label === 'at least twice as fast')[0]?.cases).toBe(0);
    // A statement that is not running twice as slow as itself cannot be filed there either.
    const slow = baseline.floor.bands
      .filter((row) => row.label === 'slower than a quarter' || row.label === 'between a quarter and a half')
      .reduce((sum, row) => sum + row.cases, 0);
    expect(slow).toBe(0);
  });

  it('states the net the floor implies, to the hundredth of a point', () => {
    // `net` is the one number in this file that is a claim about the statements rather than about
    // the table, and it is derived: a hand-edited copy that does not follow from the two readings
    // is a copy that would survive review.
    expect(baseline.floor.net).toBeCloseTo(baseline.rves - baseline.floor.rves, 2);
    expect(baseline.floor.net).toBeLessThan(0);
  });
});
