import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOTTERY_MINIMUM_SAMPLE,
  type LotteryArtifact,
  dispatch,
  lotteryLines,
  lotteryNoise,
  main,
  readLottery,
  resolveLotterySettings,
  sampleOf,
  seeded,
  verdictOf,
} from '../eval/bird/lottery.js';

/**
 * A universe is what the endpoint *offered* across a run: for every case, the correctness of each
 * candidate that was kept. The lottery draws `k` of them twice and asks what an A/A pair would have
 * read if the model's draw distribution were stable and only the drawn subset varied.
 *
 * Every fixture below is written by hand so the expected number can be computed on paper: a case
 * whose pool is no wider than the draw contributes to neither half, and a case whose pool is wider
 * with exactly one correct candidate is the only kind that can produce a difference.
 */

const drawDeltaOf = (universe: readonly (readonly boolean[])[], draws: number, seed: number): number => {
  const random = seeded(seed);
  let first = 0;
  let second = 0;
  for (const flags of universe) {
    const k = Math.min(draws, flags.length);
    if (k >= flags.length) continue;
    if (sampleOf(flags.length, k, random).some((index) => flags[index] === true)) first += 1;
    if (sampleOf(flags.length, k, random).some((index) => flags[index] === true)) second += 1;
  }
  return (second - first) / universe.length;
};

describe('seeded draws', () => {
  it('repeats a sequence for a seed and separates two seeds', () => {
    const first = seeded(11);
    const again = seeded(11);
    const other = seeded(12);
    const a = [first(), first(), first()];
    const b = [again(), again(), again()];
    expect(a).toEqual(b);
    expect(a).not.toEqual([other(), other(), other()]);
  });

  it('stays inside [0, 1)', () => {
    const random = seeded(3);
    for (let index = 0; index < 500; index += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('draws k distinct indices in range', () => {
    const random = seeded(5);
    const drawn = sampleOf(5, 3, random);
    expect(drawn).toHaveLength(3);
    expect(new Set(drawn).size).toBe(3);
    for (const index of drawn) expect(index).toBeLessThan(5);
  });

  it('returns the whole pool rather than a short draw when k is not smaller', () => {
    expect(sampleOf(3, 9, seeded(1)).sort()).toEqual([0, 1, 2]);
  });
});

describe('one replicate of the lottery', () => {
  it('reads zero when every pool is unanimous', () => {
    expect(drawDeltaOf([[true, true, true], [false, false, false], [true]], 3, 1)).toBe(0);
  });

  it('reads zero when every case can be drawn whole', () => {
    // One correct in two, k = 2: both draws take the pool, so the pair agrees on every case. This is
    // why a case wider than the draw carries the lottery and a narrower one cannot.
    expect(drawDeltaOf([[true, false], [false, true], [true, true]], 2, 1)).toBe(0);
  });

  it('prices the widest pair at one case over the population', () => {
    // One case of four has a pool wider than the draw with a single correct candidate, so at most
    // one of the two halves can hold it and |delta| never exceeds a quarter.
    const universe = [[true, false, false, false], [false, false, false, false], [false, false], [false]];
    const random = seeded(21);
    const seen = new Set<number>();
    for (let index = 0; index < 200; index += 1) {
      let first = 0;
      let second = 0;
      for (const flags of universe) {
        if (flags.length <= 2) {
          if (flags.some(Boolean)) {
            first += 1;
            second += 1;
          }
          continue;
        }
        if (sampleOf(flags.length, 2, random).some((at) => flags[at] === true)) first += 1;
        if (sampleOf(flags.length, 2, random).some((at) => flags[at] === true)) second += 1;
      }
      seen.add((second - first) / universe.length);
    }
    expect([...seen].every((delta) => Math.abs(delta) <= 0.25 + 1e-12)).toBe(true);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('is symmetric around zero', () => {
    // The universe is fixed and the two draws are exchangeable, so the mean has to be zero. A
    // one-sided mean is the signature of an asymmetric draw, which no sampling model produces.
    const universe = [[true, false, false], [true, false, false], [false, false, false], [true, true, false]];
    const random = seeded(31);
    let sum = 0;
    const replicates = 4000;
    for (let index = 0; index < replicates; index += 1) {
      const first = sampleOf(3, 1, random).some((at) => universe[0]?.[at] === true) ? 1 : 0;
      const second = sampleOf(3, 1, random).some((at) => universe[0]?.[at] === true) ? 1 : 0;
      sum += (second - first) / 4;
    }
    expect(Math.abs(sum / replicates)).toBeLessThan(0.02);
  });
});

describe('the lottery distribution', () => {
  const flat = (cases: number, seed: number) =>
    lotteryNoise(
      Array.from({ length: cases }, () => [true, false, false]),
      1,
      { replicates: 800, seed },
    );

  it('reports a spread for a pool wider than the draw and none for a pool that is not', () => {
    const wide = lotteryNoise([[true, false, false], [true, false, false], [false, false, false]], 1, { replicates: 500, seed: 4 });
    expect(wide.sd).toBeGreaterThan(0);
    expect(wide.low).toBeLessThanOrEqual(wide.mean);
    expect(wide.mean).toBeLessThanOrEqual(wide.high);
    expect(wide.cases).toBe(3);
    expect(wide.draws).toBe(1);
    expect(wide.replicates).toBe(500);
    expect(Math.abs(wide.mean)).toBeLessThan(0.05);

    const narrow = lotteryNoise([[true, false], [false, false]], 3, { replicates: 500, seed: 4 });
    expect(narrow.sd).toBe(0);
    expect(narrow.low).toBe(0);
    expect(narrow.high).toBe(0);
  });

  it('narrows as the same lottery is spread over more cases', () => {
    // The band is a share of the population, not a count of cases: two cases carrying a lottery is
    // a wide band, two of four hundred is not.
    expect(flat(2, 6).sd).toBeGreaterThan(flat(40, 6).sd);
  });

  it('brackets its own replicates inside the range a share can take', () => {
    const read = flat(10, 8);
    expect(read.low).toBeLessThanOrEqual(read.high);
    expect(read.low).toBeGreaterThanOrEqual(-1);
    expect(read.high).toBeLessThanOrEqual(1);
  });
});

/** One arm's rows: a pool of `width` shapes, the first correct exactly when `recall` says so. */
function rows(arm: string, cases: number, recall: (index: number) => boolean, width = 4) {
  return Array.from({ length: cases }, (_, index) => {
    const correct = recall(index);
    return {
      id: String(index + 1),
      arm,
      passed: correct,
      candidateRecall: correct,
      candidates: Array.from({ length: width }, (_, at) => ({
        source: `s${String(at)}`,
        correct: at === 0 && correct,
        fingerprint: at === 0 && correct ? 'right' : `wrong-${String(at)}`,
      })),
    };
  });
}

const NARROW = 120;
const even = (index: number): boolean => index % 2 === 0;
const evenOrShifted = (index: number): boolean => index % 2 === 0 || index % 8 === 1;

/** One narrow arm run twice, plus the widest pool the artifact holds. */
function pairArtifact(overrides: Partial<LotteryArtifact> = {}): LotteryArtifact {
  return {
    split: 'minidev',
    model: 'deepseek-chat',
    aa: { arm: 'narrow', delta: 0.0423, mde: 0.037, total: NARROW, onlyFirst: 0, onlySecond: 15 },
    arms: [
      { arm: 'narrow', candidateRecall: 60, samples: 3 },
      { arm: 'narrow#2', candidateRecall: 75, samples: 3 },
    ],
    cases: [...rows('narrow', NARROW, even), ...rows('narrow#2', NARROW, evenOrShifted)],
    ...overrides,
  } as LotteryArtifact;
}

describe('reading an artifact', () => {
  it('takes the draw from the A/A arm when nobody says', () => {
    const read = readLottery(pairArtifact(), { arm: undefined, draws: undefined, replicates: 200, seed: 2 }, 'fixture');
    expect(read.draws).toBe(3);
    expect(read.cases).toBe(NARROW);
    expect(read.widest).toBe(4);
    expect(read.wide).toBe(true);
  });

  it('prefers the arm that kept the widest pool', () => {
    expect(readLottery(pairArtifact(), { arm: undefined, draws: 1, replicates: 200, seed: 2 }, 'fixture').arm).toBe('narrow');
  });

  it('measures the A/A pair from its own rows', () => {
    const read = readLottery(pairArtifact(), { arm: undefined, draws: 1, replicates: 200, seed: 2 }, 'fixture');
    // Fifteen cases the second half holds and the first does not, none the other way, of 120.
    expect(read.observed?.ceiling).toBeCloseTo(15 / NARROW, 10);
    expect(read.observed?.score).toBeCloseTo(0.0423, 10);
    expect(read.observed?.mde).toBeCloseTo(0.037, 10);
    expect(read.observed?.cases).toBe(NARROW);
  });

  it('falls back to the score when the pair kept no candidate records', () => {
    const artifact = pairArtifact({ cases: rows('narrow', NARROW, even) });
    const read = readLottery(artifact, { arm: 'narrow', draws: 2, replicates: 100, seed: 2 }, 'fixture');
    expect(read.observed?.ceiling).toBeUndefined();
    expect(read.observed?.score).toBeCloseTo(0.0423, 10);
    expect(lotteryLines(read).join('\n')).toContain('A/A ceiling not measured');
  });

  it('says the pair is unmeasured when the run carried no A/A at all', () => {
    const read = readLottery(pairArtifact({ aa: undefined }), { arm: undefined, draws: 2, replicates: 100, seed: 2 }, 'fixture');
    expect(read.observed).toBeUndefined();
    expect(lotteryLines(read).join('\n')).toContain('no A/A pair in this run');
  });

  it('refuses an artifact with no candidates at all', () => {
    expect(() =>
      readLottery(
        { cases: [{ id: '1', arm: 'names', passed: true }], arms: [{ arm: 'names' }] },
        { arm: undefined, draws: 3, replicates: 10, seed: 1 },
        'fixture',
      ),
    ).toThrow(/no candidate record/);
  });

  it('refuses an arm the artifact never scored, naming the ones it did', () => {
    expect(() => readLottery(pairArtifact(), { arm: 'nope', draws: 3, replicates: 10, seed: 1 }, 'fixture')).toThrow(
      /holds narrow, narrow#2/,
    );
  });

  it('refuses a sample under the instrument floor', () => {
    const thin: LotteryArtifact = { cases: rows('a', 4, even), arms: [{ arm: 'a', samples: 2 }] };
    expect(() => readLottery(thin, { arm: 'a', draws: 1, replicates: 10, seed: 1 }, 'fixture')).toThrow(
      new RegExp(String(LOTTERY_MINIMUM_SAMPLE)),
    );
  });

  it('refuses a draw wider than every pool, which would measure nothing', () => {
    expect(() => readLottery(pairArtifact(), { arm: undefined, draws: 9, replicates: 10, seed: 1 }, 'fixture')).toThrow(
      /wider than every pool/,
    );
  });

  it('defaults the draw to three when no arm declares one', () => {
    const bare: LotteryArtifact = { cases: rows('a', NARROW, even), arms: [{ arm: 'a' }] };
    expect(readLottery(bare, { arm: 'a', draws: undefined, replicates: 50, seed: 1 }, 'fixture').draws).toBe(3);
  });

  it('reads an A/A block that names no arm and keeps no case rows', () => {
    // An older artifact, or a run whose pair was read from its rows only: the block is a score and
    // nothing else, and the instrument has to price the pool without inventing a population.
    const artifact: LotteryArtifact = { aa: { delta: 0.05 }, cases: rows('a', NARROW, even) };
    const read = readLottery(artifact, { arm: 'a', draws: undefined, replicates: 50, seed: 1 }, 'fixture');
    expect(read.observed).toEqual({ score: 0.05, cases: 0 });
    expect(read.draws).toBe(3);
  });

  it('counts a case the first half holds and the second does not', () => {
    const artifact = pairArtifact({
      aa: { arm: 'narrow', delta: 0.01, mde: 0.02, total: NARROW },
      cases: [...rows('narrow', NARROW, even), ...rows('narrow#2', NARROW, (index) => index % 2 === 0 && index % 10 !== 0)],
    });
    const read = readLottery(artifact, { arm: 'narrow', draws: 1, replicates: 20, seed: 1 }, 'fixture');
    // Twelve cases the first half holds and the second does not — the even indices that are not
    // multiples of ten — and none the other way.
    expect(read.observed?.ceiling).toBeCloseTo(-12 / NARROW, 10);
    expect(read.observed?.mde).toBeCloseTo(0.02, 10);
  });

  it('ignores a row the other half never scored', () => {
    const artifact = pairArtifact({
      cases: [...rows('narrow', NARROW, even), ...rows('narrow#2', NARROW, even), { id: 'extra', arm: 'narrow#2', candidateRecall: true }],
    });
    const read = readLottery(artifact, { arm: 'narrow', draws: 1, replicates: 20, seed: 1 }, 'fixture');
    expect(read.observed?.cases).toBe(NARROW);
    expect(read.observed?.ceiling).toBe(0);
  });

  it('prices the pair itself when the block carries no resolution of its own', () => {
    const artifact = pairArtifact({ aa: { arm: 'narrow', delta: 0.0262, total: NARROW } });
    const read = readLottery(artifact, { arm: 'narrow', draws: 1, replicates: 20, seed: 1 }, 'fixture');
    // Thirty-one discordant cases of 120 is the pair's own resolution, from the same function every
    // other paired reading in this repository uses.
    expect(read.observed?.mde).toBeGreaterThan(0.05);
    expect(read.observed?.ceiling).toBeCloseTo(15 / NARROW, 10);
  });
});

describe('the verdict', () => {
  const read = {
    arm: 'a',
    cases: 496,
    draws: 3,
    widest: 9,
    wide: true,
    replicates: 2000,
    lottery: { cases: 496, draws: 3, replicates: 2000, mean: 0, sd: 0.0095, low: -0.018, high: 0.018 },
  };

  it('calls a delta inside the band a property of the draw', () => {
    const verdict = verdictOf({ ...read, observed: { score: 0.012, ceiling: 0.017, mde: 0.03, cases: 496 } });
    expect(verdict.kind).toBe('inside');
    expect(verdict.sentence).toContain('inside');
    expect(verdict.sentence).toContain('1.7pp');
    expect(verdict.sentence).toContain('ceiling');
  });

  it('calls a delta beyond the band a draw distribution that moved', () => {
    const verdict = verdictOf({ ...read, observed: { score: 0.0423, ceiling: 0.0262, mde: 0.037, cases: 496 } });
    expect(verdict.kind).toBe('beyond');
    expect(verdict.residual).toBeCloseTo(0.0262 - 0.018, 10);
    expect(verdict.sentence).toContain('beyond');
    expect(verdict.sentence).toContain('2.6pp');
  });

  it('grades the score when the pair kept no rows, and says so', () => {
    const verdict = verdictOf({ ...read, observed: { score: 0.009, mde: 0.02, cases: 496 } });
    expect(verdict.kind).toBe('inside');
    expect(verdict.sentence).toContain('score delta');
  });

  it('refuses to grade a run with no A/A', () => {
    expect(verdictOf(read).kind).toBe('unmeasured');
  });

  it('refuses to grade a pair whose pool is exactly the draw', () => {
    // The first dev artifact this instrument read had three candidates and kept three, so the band
    // was a constant zero and a -0.33pp pair read as "beyond" it. A zero band is not evidence of a
    // moved distribution, it is the absence of a lottery.
    const verdict = verdictOf({
      ...read,
      widest: 3,
      wide: false,
      lottery: { cases: 1532, draws: 3, replicates: 2000, mean: 0, sd: 0, low: 0, high: 0 },
      observed: { score: 0.0026, ceiling: -0.0033, mde: 0.0177, cases: 1532 },
    });
    expect(verdict.kind).toBe('unpriced');
    expect(verdict.sentence).toContain('exactly the draw');
    expect(verdict.sentence).toContain('1.8pp');
    expect(verdict.resolution).toBeCloseTo(0.0177, 10);
  });

  it('prints the resolution a claim has to clear', () => {
    // A claim has to clear both the pair's own paired resolution and the widest the lottery produced.
    expect(verdictOf({ ...read, observed: { score: 0.0423, ceiling: 0.0262, mde: 0.037, cases: 496 } }).resolution).toBeCloseTo(0.037, 10);
    expect(verdictOf({ ...read, observed: { score: 0.0423, ceiling: 0.0262, mde: 0.005, cases: 496 } }).resolution).toBeCloseTo(0.018, 10);
  });
});

describe('the lines', () => {
  it('names the universe, the draw, the band and the observed pair', () => {
    const artifact = pairArtifact({ aa: { arm: 'narrow', delta: 0.02, mde: 0.03, total: 200 } });
    const read = readLottery(artifact, { arm: 'narrow', draws: 1, replicates: 100, seed: 3 }, 'fixture');
    const text = lotteryLines(read).join('\n');
    expect(text).toContain('arm narrow');
    expect(text).toContain(`${String(NARROW)} cases`);
    expect(text).toContain('draws 1 of a pool');
    expect(text).toContain('A/A ceiling');
    expect(text).toContain('resolves');
    expect(text).toContain('verdict');
  });

  it('says the band is a constant when no pool could be drawn from', () => {
    const narrowArtifact: LotteryArtifact = { cases: rows('a', NARROW, even, 1), arms: [{ arm: 'a', samples: 1 }] };
    const text = lotteryLines(readLottery(narrowArtifact, { arm: 'a', draws: 1, replicates: 20, seed: 3 }, 'fixture')).join('\n');
    expect(text).toContain('the band is a constant zero');
  });
});

describe('the command', () => {
  it('reads its flags and refuses what it does not know', () => {
    const settings = resolveLotterySettings(
      ['--arm', 'wide', '--draws', '2', '--replicates', '50', '--seed', '7', '--json', '--out', 'x.json', 'report.json'],
      '/root',
    );
    expect(settings).toEqual({
      report: '/root/report.json',
      arm: 'wide',
      draws: 2,
      replicates: 50,
      seed: 7,
      json: true,
      out: 'x.json',
    });
    expect(resolveLotterySettings([], '/root').report).toBe('/root/eval/out/bird-eval.json');
    expect(() => resolveLotterySettings(['--arm'], '/root')).toThrow(/--arm needs an arm name/);
    expect(() => resolveLotterySettings(['--draws'], '/root')).toThrow(/--draws takes a positive whole number/);
    expect(() => resolveLotterySettings(['--draws', 'many'], '/root')).toThrow(/--draws takes a positive whole number/);
    expect(() => resolveLotterySettings(['--draws', '0'], '/root')).toThrow(/--draws takes a positive whole number/);
    expect(() => resolveLotterySettings(['--replicates', '0'], '/root')).toThrow(/--replicates takes a positive whole number/);
    expect(() => resolveLotterySettings(['--seed', 'x'], '/root')).toThrow(/--seed takes a whole number/);
    expect(() => resolveLotterySettings(['--out'], '/root')).toThrow(/--out needs a path/);
    expect(() => resolveLotterySettings(['--nope'], '/root')).toThrow(/unknown flag --nope/);
  });

  it('prints a reading and writes it where it was asked to', () => {
    const lines: string[] = [];
    const root = mkdtempSync(join(tmpdir(), 'lottery-'));
    expect(main(['--replicates', '20', '--draws', '1', '--out', 'reading.json'], root, (line) => lines.push(line), () => pairArtifact())).toBe(0);
    expect(lines.join('\n')).toContain('arm narrow');
    expect(JSON.parse(readFileSync(join(root, 'reading.json'), 'utf8'))).toMatchObject({ arm: 'narrow', draws: 1 });
  });

  it('prints the reading as json on one call', () => {
    const lines: string[] = [];
    main(['--replicates', '20', '--draws', '1', '--json'], '/root', (line) => lines.push(line), () => pairArtifact());
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ arm: 'narrow', draws: 1 });
  });

  it('says there is no pool rather than refusing, on a single-call dispatch', () => {
    const lines: string[] = [];
    expect(
      main([], '/root', (line) => lines.push(line), () => ({ cases: [{ id: '1', arm: 'names', passed: true }], arms: [{ arm: 'names' }] })),
    ).toBe(0);
    expect(lines.join('\n')).toContain('no arm in /root/eval/out/bird-eval.json draws more than one candidate');
  });

  it('refuses an artifact that claims a ceiling and kept no candidates', () => {
    expect(() =>
      main([], '/root', () => undefined, () => ({ cases: [{ id: '1', arm: 'names' }], arms: [{ arm: 'names', candidateRecall: 0.5 }] })),
    ).toThrow(/publishes a candidate ceiling/);
  });

  it('reads a report from disk when the caller does not hand one over', () => {
    const root = mkdtempSync(join(tmpdir(), 'lottery-disk-'));
    writeFileSync(join(root, 'report.json'), `${JSON.stringify({ ...pairArtifact(), aa: undefined })}\n`);
    const lines: string[] = [];
    expect(main(['report.json', '--replicates', '20'], root, (line) => lines.push(line))).toBe(0);
    // No A/A pair, so the draw falls back to three candidates rather than to an arm that is absent.
    expect(lines.join('\n')).toContain('draws 3 of a pool');
  });
});

describe('dispatch', () => {
  const lines: string[] = [];
  const log = (line: string): void => void lines.push(line);

  it('does nothing when another module is the entry point', () => {
    expect(dispatch(undefined, 'file:///self.ts', [], '/root', log)).toBeUndefined();
    expect(dispatch('/other.ts', 'file:///self.ts', [], '/root', log)).toBeUndefined();
  });

  it('runs main when this module is the entry point', () => {
    const root = mkdtempSync(join(tmpdir(), 'lottery-dispatch-'));
    writeFileSync(join(root, 'report.json'), `${JSON.stringify(pairArtifact())}\n`);
    expect(dispatch('/self.ts', 'file:///self.ts', ['report.json', '--draws', '1', '--replicates', '20'], root, log, () => undefined)).toBe(0);
    expect(lines.join('\n')).toContain('arm narrow');
  });

  it('turns a refusal into a sentence and an exit code', () => {
    const errors: string[] = [];
    const root = mkdtempSync(join(tmpdir(), 'lottery-refusal-'));
    writeFileSync(join(root, 'report.json'), '{}\n');
    const code = dispatch('/self.ts', 'file:///self.ts', ['report.json', '--arm'], root, log, (line) => void errors.push(line));
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('--arm needs an arm name');
  });

  it('prints a thrown string as it is', () => {
    const errors: string[] = [];
    const code = dispatch('/self.ts', 'file:///self.ts', [], '/root', log, (line) => void errors.push(line), () => {
      throw 'not an error';
    });
    expect(code).toBe(1);
    expect(errors).toEqual(['not an error']);
  });
});
