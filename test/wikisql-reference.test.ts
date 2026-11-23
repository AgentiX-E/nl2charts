import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOracle } from '../eval/bird/oracle.js';
import { digestOf, Judge, parseSplit } from '../eval/wikisql/exec.js';

// The differential test: the port against the implementation every published WikiSQL number came
// from. `reference-digest.json` is produced by `eval/wikisql/reference/dump.py`, which imports the
// vendored `lib/` — `salesforce/WikiSQL`'s own `query.py` and `dbengine.py`, unmodified.
//
// It is a digest rather than 1.1 MB of answers because the whole split is what matters: a sample
// can agree while question 4,117 does not. The sample is kept beside it to name the question when
// the digest fails.
//
// The corpus is not vendored, so this file skips when the cache is cold. What runs in CI is the
// judge's own suite; what runs here is the reason to believe it.

const CACHE = process.env.WIKISQL_CACHE ?? resolve('eval/.cache/wikisql');
const FIXTURE = resolve('eval/wikisql/reference-digest.json');
const record = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  split: string;
  questions: number;
  errors: number;
  sha256: string;
  sampleEvery: number;
  sample: { index: number; rows: (number | string | null)[][] | null }[];
  source: string;
};
const warm = existsSync(join(CACHE, `${record.split}.db`)) && existsSync(join(CACHE, `${record.split}.jsonl`));

describe('the reference fixture', () => {
  it('records the split it was taken from, and that every gold executed', () => {
    expect(record.split).toBe('dev');
    expect(record.questions).toBe(8421);
    // A reference judge that could not execute a gold would have produced `null` for it, and a
    // prediction would then be compared against nothing.
    expect(record.errors).toBe(0);
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.source).toContain('salesforce/WikiSQL');
  });

  it('samples often enough to name a failing question', () => {
    expect(record.sampleEvery).toBe(32);
    expect(record.sample.length).toBeGreaterThan(200);
  });
});

describe.skipIf(!warm)('the port against the reference judge', () => {
  const oracle = createOracle(resolve('eval/bird/oracle.py'), CACHE);
  const judge = new Judge(oracle, `${record.split}.db`);
  const rows = parseSplit(readFileSync(join(CACHE, `${record.split}.jsonl`), 'utf8'));

  it('reproduces every gold answer in the split', async () => {
    const answers = [];
    for (const row of rows) answers.push(await judge.goldOf(row));
    // The digest covers all 8,421. The reference and this port disagreed on zero of them when the
    // fixture was made, and the claim is that they still do.
    expect(digestOf(answers)).toBe(record.sha256);
  }, 120_000);

  it('reproduces the sampled rows cell for cell', async () => {
    for (const entry of record.sample) {
      const row = rows[entry.index];
      expect(row).toBeDefined();
      const answer = await judge.goldOf(row as never);
      expect(answer.ok, `question ${String(entry.index)} did not execute`).toBe(true);
      if (!answer.ok) continue;
      // `176.0` and `176` are one value in SQLite and one value here; the digest normalises the
      // spelling for exactly this reason, and so does this comparison.
      expect(answer.rows).toEqual(entry.rows);
    }
  }, 120_000);
});
