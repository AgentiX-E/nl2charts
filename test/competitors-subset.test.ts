/**
 * The subset file, cut by the same function that cuts our own sample.
 *
 * The assertion that matters is the last one: the ids written for a competitor are the ids
 * `run.ts` would score at the same limit. If that ever stops holding, the two runs answer
 * different questions and the comparison is between two samples rather than two pipelines.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadQuestions, stratifiedSample } from '../eval/bird/data.js';
import { questionSetHash } from '../eval/competitors/coordinates.js';
import { main, resolveSubsetSettings, runIfEntry, writeSubset } from '../eval/competitors/subset.js';
import { writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();

const envFor = (dir: string, over: Record<string, string> = {}): Record<string, string> => ({
  BIRD_SPLIT: 'minidev',
  BIRD_DATA: dir,
  BIRD_DATABASES: join(dir, 'dev_databases'),
  BIRD_OUT: join(dir, 'bird-eval.json'),
  ...over,
});

describe('the subset a competitor is given', () => {
  it('is the sample the runner would take at the same limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subset-'));
    writeMiniBirdDataset(dir);
    const settings = resolveSubsetSettings(envFor(dir), ['--limit', '4'], dir);
    const subset = writeSubset(settings);
    const questions = loadQuestions(join(dir, 'mini_dev_sqlite.json'));
    const expected = stratifiedSample(questions, 4).map((question) => question.question_id);
    expect(subset.ids).toEqual(expected);
    expect(subset.hash).toBe(questionSetHash(expected));
    const written = JSON.parse(readFileSync(subset.path, 'utf8')) as { question_id: number; SQL: string }[];
    expect(written.map((question) => question.question_id)).toEqual(expected);
    // The gold travels with the questions: a competitor's own harness reads the same file shape.
    expect(written.every((question) => question.SQL.length > 0)).toBe(true);
  });

  it('is the whole split when the limit is larger than it, or blank', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subset-'));
    writeMiniBirdDataset(dir);
    const all = writeSubset(resolveSubsetSettings(envFor(dir), ['--limit', '40'], dir));
    expect(all.ids).toHaveLength(7);
    const blank = writeSubset(resolveSubsetSettings(envFor(dir, { BIRD_LIMIT: '' }), [], dir));
    expect(blank.ids).toHaveLength(7);
  });

  it('reads the limit from the environment, so one variable drives both runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subset-'));
    writeMiniBirdDataset(dir);
    const settings = resolveSubsetSettings(envFor(dir, { BIRD_LIMIT: '3' }), [], dir);
    expect(settings.limit).toBe(3);
  });

  it('names its output after the split and the limit, so two runs cannot overwrite each other', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subset-'));
    writeMiniBirdDataset(dir);
    const settings = resolveSubsetSettings(envFor(dir), ['--limit', '5'], ROOT);
    expect(settings.out.endsWith('eval/out/competitors/minidev-subset-5.json')).toBe(true);
  });

  it('refuses a flag with no value rather than falling back to the whole split', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subset-'));
    writeMiniBirdDataset(dir);
    expect(() => resolveSubsetSettings(envFor(dir), ['--limit'], dir)).toThrow(/--limit needs a number/);
    expect(() => resolveSubsetSettings(envFor(dir), ['--out'], dir)).toThrow(/--out needs a path/);
  });

  it('prints the count and the hash it wrote, and returns success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subset-'));
    writeMiniBirdDataset(dir);
    const out = join(dir, 'subset.json');
    expect(main(['--limit', '4', '--out', out], dir, envFor(dir))).toBe(0);
  });

  it('runs only when this module is the one being run, and says so by what it returns', () => {
    let ran = 0;
    const run = (): number => {
      ran += 1;
      return 7;
    };
    // Imported by a test: no command line, so no run.
    expect(runIfEntry(undefined, 'file:///a/subset.ts', run)).toBeUndefined();
    // Run as a different script: still no run.
    expect(runIfEntry('/a/other.ts', 'file:///a/subset.ts', run)).toBeUndefined();
    expect(ran).toBe(0);
    expect(runIfEntry('/a/subset.ts', 'file:///a/subset.ts', run)).toBe(7);
    expect(ran).toBe(1);
  });
});
