/**
 * The paired comparison, tested on case files the test writes itself.
 *
 * Three things decide whether a paired number means anything, and each has a suite here: the join
 * (two files must be about the same questions), the four cells (a count read wrong turns a tie into
 * a win), and the statistic (the p-value is the gate's, so this file may only be a caller). The
 * independent binomial in `twoSided` below is deliberately not the implementation under test: a test
 * that compares a function with itself proves the function is a function.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  main,
  pairedLines,
  pairingOf,
  parseCases,
  readingOfPairing,
  resolveSettings,
} from '../eval/wikisql/paired.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A case file written where the tool can read it, from a list of verdicts. */
function fileOf(verdicts: readonly (readonly [number, boolean])[], name = 'cases.jsonl'): string {
  const dir = mkdtempSync(join(tmpdir(), 'wikisql-paired-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(
    path,
    verdicts.map(([index, ordered]) => JSON.stringify({ index, ordered, bag: ordered, predOk: true })).join('\n') + '\n',
  );
  return path;
}

/**
 * The two-sided exact binomial tail for `minority` out of `discordant` at p = 0.5, computed here.
 *
 * Written with an explicit factorial loop rather than `mcnemarExact`, because the point of the check
 * is that two independent implementations of the same definition agree on a number this small enough
 * to also write by hand: 1 of 10 discordant cases is 2 × (11/1024) = 0.0215.
 */
function twoSided(minority: number, discordant: number): number {
  const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));
  let tail = 0;
  for (let k = 0; k <= minority; k += 1) {
    tail += factorial(discordant) / (factorial(k) * factorial(discordant - k)) / 2 ** discordant;
  }
  return Math.min(1, 2 * tail);
}

describe('reading a case file', () => {
  it('keeps one verdict per question, by the index the split gave it', () => {
    const parsed = parseCases('{"index":4,"ordered":true,"bag":true,"predOk":true}\n{"index":7,"ordered":false,"bag":true,"predOk":false}\n');
    expect(parsed.lines).toBe(2);
    expect(parsed.cases.get(4)).toEqual({ index: 4, ordered: true, bag: true, predOk: true });
    expect(parsed.cases.get(7)?.predOk).toBe(false);
  });

  it('refuses a repeated index, because counting one case twice is a denominator nobody can recompute', () => {
    expect(() => parseCases('{"index":1,"ordered":true}\n{"index":1,"ordered":false}\n', 'a.jsonl')).toThrow(
      'a.jsonl line 2 repeats index 1',
    );
  });

  it('refuses a line that is not a verdict, and says which line', () => {
    expect(() => parseCases('{"index":1}\n', 'b.jsonl')).toThrow('b.jsonl line 1 is not a verdict');
  });

  it('reads a file with a blank last line without inventing a case', () => {
    expect(parseCases('{"index":0,"ordered":true}\n\n').cases.size).toBe(1);
  });
});

describe('the join, which is where a paired test stops being paired', () => {
  it('counts the four cells of the 2x2 table', () => {
    const first = parseCases(
      [
        { index: 0, ordered: true },
        { index: 1, ordered: true },
        { index: 2, ordered: false },
        { index: 3, ordered: false },
      ]
        .map((v) => JSON.stringify({ ...v, bag: v.ordered, predOk: true }))
        .join('\n'),
    );
    const second = parseCases(
      [
        { index: 0, ordered: true },
        { index: 1, ordered: false },
        { index: 2, ordered: true },
        { index: 3, ordered: false },
      ]
        .map((v) => JSON.stringify({ ...v, bag: v.ordered, predOk: true }))
        .join('\n'),
    );
    const pairing = pairingOf(first, second);
    expect([pairing.both, pairing.onlyFirst, pairing.onlySecond, pairing.neither]).toEqual([1, 1, 1, 1]);
    expect(pairing.n).toBe(4);
  });

  it('refuses two files about different questions unless the caller says they are subsets', () => {
    const whole = parseCases([0, 1, 2, 3].map((index) => JSON.stringify({ index, ordered: true })).join('\n'));
    const slice = parseCases([0, 1].map((index) => JSON.stringify({ index, ordered: true })).join('\n'));
    expect(() => pairingOf(whole, slice)).toThrow('covers 2 of the first\'s 4 cases; pass --intersect');
    const paired = pairingOf(whole, slice, true);
    expect(paired.n).toBe(2);
    expect([paired.firstCases, paired.secondCases]).toEqual([4, 2]);
  });

  it('refuses a join that shares no question at all', () => {
    const a = parseCases('{"index":0,"ordered":true}\n');
    const b = parseCases('{"index":1,"ordered":true}\n');
    expect(() => pairingOf(a, b, true)).toThrow('share no question');
  });

  it('counts a statement that did not run, separately from one that ran and was wrong', () => {
    const a = parseCases('{"index":0,"ordered":false,"bag":false,"predOk":false}\n');
    const b = parseCases('{"index":0,"ordered":false,"bag":false,"predOk":true}\n');
    const pairing = pairingOf(a, b);
    expect([pairing.firstCrashed, pairing.secondCrashed]).toEqual([1, 0]);
    expect(pairing.neither).toBe(1);
  });
});

describe('the reading, recomputed from the cells', () => {
  it('reads the paired difference as the cell counts, not as the two accuracies', () => {
    // 30 cases only the first arm got, 60 only the second, 800 compared: the paired difference is
    // +3.75pp and both accuracies are reported beside it, because a reader will recompute them.
    const pairing = { n: 800, firstCases: 800, secondCases: 800, both: 600, onlyFirst: 30, onlySecond: 60, neither: 110, firstCrashed: 0, secondCrashed: 0 };
    const reading = readingOfPairing(pairing);
    expect(reading.firstPct).toBeCloseTo(78.75, 10);
    expect(reading.secondPct).toBeCloseTo(82.5, 10);
    expect(reading.deltaPp).toBeCloseTo(3.75, 10);
    expect(reading.resolves).toBe(true);
    expect(reading.discordantShare).toBeCloseTo(90 / 800, 10);
  });

  it('agrees with an independent binomial on the p-value', () => {
    const pairing = { n: 800, firstCases: 800, secondCases: 800, both: 600, onlyFirst: 30, onlySecond: 60, neither: 110, firstCrashed: 0, secondCrashed: 0 };
    const reading = readingOfPairing(pairing);
    expect(reading.p).toBeCloseTo(twoSided(30, 90), 6);
    expect(reading.p).toBeLessThan(0.01);
  });

  it('reports a tie as unresolved rather than as zero difference', () => {
    const pairing = { n: 500, firstCases: 500, secondCases: 500, both: 400, onlyFirst: 50, onlySecond: 50, neither: 0, firstCrashed: 0, secondCrashed: 0 };
    const reading = readingOfPairing(pairing);
    expect(reading.deltaPp).toBe(0);
    expect(reading.p).toBe(1);
    expect(reading.resolves).toBe(false);
    // The interval is not zero-width: 100 discordant cases cannot exclude a 4pp difference.
    expect(reading.mdePp).toBeGreaterThan(3);
  });

  it('says out loud that a design cannot separate the arms, instead of leaving it to the numbers', () => {
    const pairing = { n: 120, firstCases: 120, secondCases: 120, both: 100, onlyFirst: 10, onlySecond: 10, neither: 0, firstCrashed: 0, secondCrashed: 0 };
    const lines = pairedLines(readingOfPairing(pairing), { first: 'a', second: 'b' });
    expect(lines.join('\n')).toContain('the interval holds zero');
    // And the positive verdict names the arm ahead, so a reader cannot misread the sign.
    const win = pairedLines(
      readingOfPairing({ n: 800, firstCases: 800, secondCases: 800, both: 600, onlyFirst: 10, onlySecond: 90, neither: 100, firstCrashed: 0, secondCrashed: 0 }),
      { first: 'values', second: 'schema' },
    );
    expect(win.join('\n')).toContain('the second arm is ahead by');
  });

  it('prints both denominators when the pairing is an intersection', () => {
    const lines = pairedLines(
      readingOfPairing({ n: 400, firstCases: 8421, secondCases: 400, both: 300, onlyFirst: 60, onlySecond: 40, neither: 0, firstCrashed: 0, secondCrashed: 0 }),
      { first: 'a', second: 'b' },
    );
    expect(lines.join('\n')).toContain('(of 8421 and 400)');
  });
});

describe('the tool, driven the way a workflow drives it', () => {
  it('prints the comparison for two files over the same questions', () => {
    const first = fileOf([[0, true], [1, true], [2, false]]);
    const lines: string[] = [];
    const code = main(['--first', first, '--second', fileOf([[0, true], [1, false], [2, true]])], (line) => lines.push(line));
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('wikisql paired:');
    expect(lines.join('\n')).toContain('both 1, only first 1, only second 1, neither 0');
  });

  it('refuses without both files, and names what it needs', () => {
    const lines: string[] = [];
    expect(main(['--first', 'a.jsonl'], (line) => lines.push(line))).toBe(2);
    expect(lines.join('\n')).toContain('--first and --second are both required');
  });

  it('refuses a mismatched pair with a message rather than a stack trace', () => {
    const lines: string[] = [];
    const code = main(['--first', fileOf([[0, true], [1, true]]), '--second', fileOf([[0, true]])], (line) => lines.push(line));
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('REFUSED: the second file covers 1 of the first\'s 2 cases');
  });

  it('reads --intersect, and only --intersect, as permission to compare a slice', () => {
    expect(resolveSettings(['--first', 'a', '--second', 'b'])).toEqual({ first: 'a', second: 'b', intersect: false });
    expect(resolveSettings(['--first', 'a', '--second', 'b', '--intersect']).intersect).toBe(true);
    expect(() => resolveSettings(['--first'])).toThrow('--first needs a path');
    expect(() => resolveSettings(['--second'])).toThrow('--second needs a path');
    expect(() => resolveSettings(['--nope'])).toThrow('unknown flag --nope');
    expect(() => resolveSettings(['stray'])).toThrow('unexpected argument stray');
  });
});
