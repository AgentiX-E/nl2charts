import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { casesOf, parseSplit, resolveTypes } from '../eval/nvbench2/check.js';
import { compareCharts, digestOf, preprocess, readingOf } from '../eval/nvbench2/judge.js';

/**
 * The differential test: the port against the implementation every published nvBench 2.0 number
 * came from.
 *
 * `eval/nvbench2/metrics.json` holds what the *vendored* reference printed — `diff.py` imports
 * `reference/evaluation.py` and `reference/utils.py` unmodified, feeds them the map `metadata.py`
 * built, and prints one JSON object per split. This file recomputes the same three things in
 * TypeScript and compares them exactly: the digest over every preprocessed gold, the four metrics at
 * k=1,3,5, and the count of questions whose transposed gold still matches.
 *
 * That last count is the one that makes the type map load-bearing rather than decorative: it is 381
 * of dev's 750 and 437 of test's 751, and a map with entries missing moves it.
 *
 * The corpus is 22 MB and is not vendored, so this suite skips when the cache is cold — and prints
 * why, because a test that passes without running is worse than a test that does not exist.
 */
const CACHE = process.env.NVBENCH2_CACHE ?? resolve('eval/.cache/nvbench2');
const FIXTURE = resolve('eval/nvbench2/metrics.json');

interface SplitRecord {
  readonly questions: number;
  readonly transposed: number;
  readonly digest: string;
  readonly f1: Record<string, number>;
  readonly hit: Record<string, number>;
  readonly precision: Record<string, number>;
  readonly recall: Record<string, number>;
}

const record = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  tables: number;
  metadataDigest: string;
  splits: Record<string, SplitRecord>;
};

const warm = ['metadata.json', 'dev.json', 'test.json']
  .every((name) => existsSync(join(CACHE, name)));

function pythonJudge(): { ok: boolean; why: string } {
  try {
    execFileSync('python3', ['-c', 'import pandas'], { stdio: 'ignore' });
  } catch {
    return { ok: false, why: 'python3 without pandas cannot import the reference judge' };
  }
  if (!existsSync(resolve('eval/nvbench2/reference/evaluation.py'))) {
    return { ok: false, why: 'the vendored reference is not in this checkout' };
  }
  return { ok: true, why: '' };
}

const interpreter = pythonJudge();
const runnable = warm && interpreter.ok;

describe('the fixture', () => {
  it('records the split sizes the corpus states', () => {
    expect(record.tables).toBe(803);
    expect(record.splits.dev?.questions).toBe(750);
    expect(record.splits.test?.questions).toBe(751);
  });

  it('records a digest for the map, and a reading for each split', () => {
    expect(record.metadataDigest).toMatch(/^[0-9a-f]{64}$/u);
    for (const split of ['dev', 'test']) {
      const entry = record.splits[split];
      expect(entry).toBeDefined();
      expect(entry?.digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(entry?.f1['1']).toBeGreaterThan(0);
    }
  });
});

/**
 * The map, read on first use.
 *
 * `describe.skipIf` marks a suite skipped but **still runs the callback that registers its tests**,
 * so a `readFileSync` at describe scope throws `ENOENT` on every machine with a cold cache — the
 * failure this repository already paid for once, in the WikiSQL round. The read therefore belongs
 * inside the bodies, behind a memo.
 */
const memo = new Map<string, unknown>();
function loaded<T>(key: string, read: () => T): T {
  if (!memo.has(key)) memo.set(key, read());
  return memo.get(key) as T;
}
const typesOf = (): ReturnType<typeof resolveTypes> =>
  loaded('types', () => resolveTypes(JSON.parse(readFileSync(join(CACHE, 'metadata.json'), 'utf8'))));
const rowsOf = (split: string): ReturnType<typeof parseSplit> =>
  loaded(`rows:${split}`, () => parseSplit(readFileSync(join(CACHE, `${split}.json`), 'utf8')));

describe.skipIf(!runnable)(`the port against the reference${interpreter.ok ? '' : ` (${interpreter.why})`}`, () => {
  for (const split of ['dev', 'test'] as const) {
    it(`reproduces the reference's reading on ${split}`, () => {
      const cases = casesOf(rowsOf(split), typesOf());
      const reading = readingOf(cases);
      const expected = record.splits[split] as SplitRecord;
      expect(reading.questions).toBe(expected.questions);
      for (const k of ['1', '3', '5'] as const) {
        expect(reading.f1[Number(k)]).toBe(expected.f1[k]);
        expect(reading.hit[Number(k)]).toBe(expected.hit[k]);
        expect(reading.precision[Number(k)]).toBe(expected.precision[k]);
        expect(reading.recall[Number(k)]).toBe(expected.recall[k]);
      }
      expect(digestOf(cases)).toBe(expected.digest);
    }, 120_000);

    it(`agrees on how many ${split} questions survive a transposition`, () => {
      const cases = casesOf(rowsOf(split), typesOf());
      let transposed = 0;
      for (const item of cases) {
        const golds = preprocess(item.golds, item.types);
        const guess = preprocess([item.predictions[1]], item.types);
        const first = golds[0];
        if (guess[0] !== null && guess[0] !== undefined && first !== null && first !== undefined
          && compareCharts(guess[0], first)) transposed += 1;
      }
      expect(transposed).toBe((record.splits[split] as SplitRecord).transposed);
    }, 120_000);

    it(`is confirmed by the reference itself on ${split}, not by the fixture alone`, () => {
      const printed = execFileSync('python3', [resolve('eval/nvbench2/diff.py'), '--cache', CACHE,
        '--split', split], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      const reference = JSON.parse(printed.trim()) as {
        questions: number;
        transposed: number;
        digest: string;
        f1: Record<string, number>;
      };
      const expected = record.splits[split] as SplitRecord;
      expect(reference.questions).toBe(expected.questions);
      expect(reference.digest).toBe(expected.digest);
      expect(reference.transposed).toBe(expected.transposed);
      for (const k of ['1', '3', '5'] as const) expect(reference.f1[k]).toBe(expected.f1[k]);
    }, 300_000);
  }
});
