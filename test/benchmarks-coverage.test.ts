import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  BENCHMARKS,
  REQUIRED,
  checkCoverage,
  describeCoverage,
  entryCoverage,
  main,
  resolveReading,
  type Benchmark,
  type Reader,
} from '../eval/benchmarks.js';

/** A reader over an in-memory tree, so the gate's rules are tested without touching the disk. */
const reader = (files: Record<string, unknown>): Reader => (file) => {
  if (!(file in files)) throw new Error(`ENOENT ${file}`);
  return files[file];
};

const TREE = {
  'eval/baseline/bird.json': { floors: { minidev: { select: 56 }, dev: { 'select-mixed': 62.5 } } },
  'eval/text2vis/baseline.json': { top1: 664, render: { rendered: 1418 } },
};

const row = (patch: Partial<Benchmark> = {}): Benchmark => ({
  id: 'x',
  domain: 'text2sql',
  name: 'X',
  source: 'https://example.invalid',
  corpus: 'one table',
  metrics: ['EX'],
  status: 'absent',
  gap: 'The corpus is not vendored and no harness reads it, which is what a gap has to say.',
  ...patch,
});

describe('resolving a reading', () => {
  it('descends plain keys and array indices', () => {
    const value = resolveReading({ file: 'f', path: ['a', '0', 'b'], kind: 'run', unit: 'percent', note: '' },
      reader({ f: { a: [{ b: 7 }] } }));
    expect(value).toBe(7);
  });

  it('finds an arm by name rather than by position', () => {
    // An artifact's arms are an array whose order changes with what the dispatch asked for. A
    // position would be a citation that silently points at another arm three rounds later.
    const value = resolveReading({ file: 'f', path: ['arms', '#arm=select-mixed', 'accuracy'], kind: 'run', unit: 'percent', note: '' },
      reader({ f: { arms: [{ arm: 'select', accuracy: 0.6 }, { arm: 'select-mixed', accuracy: 0.6234 }] } }));
    expect(value).toBeCloseTo(0.6234, 6);
  });

  it('answers undefined for every way a citation can fail', () => {
    const missingFile = (): never => { throw new Error('ENOENT'); };
    expect(resolveReading({ file: 'f', path: ['a'], kind: 'run', unit: 'percent', note: '' }, missingFile)).toBeUndefined();
    expect(resolveReading({ file: 'f', path: ['a', 'b'], kind: 'run', note: '' }, reader({ f: { a: 1 } }))).toBeUndefined();
    expect(resolveReading({ file: 'f', path: ['a'], kind: 'run', unit: 'percent', note: '' }, reader({ f: { a: 'x' } }))).toBeUndefined();
    expect(resolveReading({ file: 'f', path: ['a'], kind: 'run', unit: 'percent', note: '' }, reader({ f: { a: Number.NaN } }))).toBeUndefined();
    expect(resolveReading({ file: 'f', path: ['#arm=x', 'acc'], kind: 'run', note: '' }, reader({ f: { a: [] } }))).toBeUndefined();
    expect(resolveReading({ file: 'f', path: ['a'], kind: 'run', unit: 'percent', note: '' }, reader({ f: null }))).toBeUndefined();
    expect(resolveReading({ file: 'f', path: ['x'], kind: 'run', note: '' }, reader({ f: [1, 2] }))).toBeUndefined();
  });

  it('resolves every reading the real manifest cites', () => {
    // The rows are only worth having if the numbers are there. This is the assertion the workflow
    // runs, written as a test so it fails on a pull request rather than on a schedule.
    for (const benchmark of BENCHMARKS) {
      if (benchmark.reading === undefined) continue;
      const value = resolveReading(benchmark.reading, reader(TREE));
      expect(value, `${benchmark.id} cites ${benchmark.reading.file} ${benchmark.reading.path.join('.')}`)
        .toBeTypeOf('number');
    }
  });
});

describe('the rules a row has to keep', () => {
  it('accepts the manifest as it ships', () => {
    expect(checkCoverage(BENCHMARKS, reader(TREE))).toEqual([]);
  });

  it('refuses a duplicate id', () => {
    const issues = checkCoverage([row({ id: 'a' }), row({ id: 'a' })], reader(TREE));
    expect(issues.join('\n')).toContain('duplicate id');
  });

  it('refuses a row that names no metric', () => {
    expect(checkCoverage([row({ metrics: [] })], reader(TREE)).join('\n')).toContain('names no metric');
  });

  it('refuses a measured row with nothing to measure', () => {
    expect(checkCoverage([row({ status: 'measured' })], reader(TREE)).join('\n'))
      .toContain('measured with no reading');
  });

  it('refuses a citation that does not resolve', () => {
    const issues = checkCoverage([
      row({ status: 'measured', reading: { file: 'nope.json', path: ['a'], kind: 'run', unit: 'percent', note: '' } }),
    ], reader(TREE));
    expect(issues.join('\n')).toContain('reads no number');
  });

  it('refuses a percentage that is not one', () => {
    const issues = checkCoverage([
      row({ status: 'measured', reading: { file: 'f', path: ['a'], kind: 'run', unit: 'percent', note: '' } }),
    ], reader({ f: { a: 6234 } }));
    expect(issues.join('\n')).toContain('is not a percentage');
  });

  it('lets a count be larger than a hundred', () => {
    // 1,418 rendered figures and 664 hits are counts. The first draft of this table bounded every
    // measured value by 100 and called the Text2Vis reading "664 percent".
    expect(checkCoverage([
      row({ status: 'measured', reading: { file: 'f', path: ['a'], kind: 'census', unit: 'count', note: '' } }),
    ], reader({ f: { a: 1418 } })).filter((issue) => !issue.includes('required'))).toEqual([]);
  });

  it('refuses an absence with no reason and an instrumented row that cites a number', () => {
    const thin = checkCoverage([row({ gap: 'not built' })], reader(TREE));
    expect(thin.join('\n')).toContain('no reason a reader can act on');
    const cited = checkCoverage([
      row({ status: 'instrumented', reading: { file: 'f', path: ['a'], kind: 'run', unit: 'percent', note: '' } }),
    ], reader({ f: { a: 1 } }));
    expect(cited.join('\n')).toContain('instrumented but cites a reading');
  });

  it('refuses a missing leaderboard the plan names', () => {
    const issues = checkCoverage([row({ id: 'wikisql' })], reader(TREE));
    expect(issues.filter((issue) => issue.includes('required leaderboard is missing')))
      .toHaveLength(REQUIRED.length - 1);
  });
});

describe('the gate', () => {
  it('prints the table and exits zero on the shipped manifest', async () => {
    const lines: string[] = [];
    const exit = await main([], reader(TREE), (line) => lines.push(line));
    expect(exit).toBe(0);
    expect(lines.some((line) => line.includes('text2sql bird-dev: measured, EX = 62.5'))).toBe(true);
    expect(lines.some((line) => line.includes('text2viz text2vis: measured, top-1 = 664'))).toBe(true);
    expect(lines.at(-1)).toContain('4 of 9 leaderboards carry a number');
  });

  it('names the failing row and exits non-zero', async () => {
    const lines: string[] = [];
    const exit = await main([], () => { throw new Error('ENOENT'); }, (line) => lines.push(line));
    expect(exit).toBe(1);
    expect(lines.some((line) => line.startsWith('COVERAGE: bird-dev: reads no number'))).toBe(true);
  });

  it('can be asked to print nothing but the verdict', async () => {
    const lines: string[] = [];
    await main(['--quiet'], reader(TREE), (line) => lines.push(line));
    expect(lines.every((line) => line.startsWith('COVERAGE:'))).toBe(true);
    expect(lines.some((line) => line.includes('bird-dev: measured'))).toBe(false);
  });
});

describe('the table it prints', () => {
  it('groups by domain, because the two are read by different plans', () => {
    const lines = describeCoverage(BENCHMARKS, reader(TREE));
    const domains = lines.map((line) => line.split(' ')[1]);
    expect(domains.indexOf('text2viz')).toBeGreaterThan(domains.lastIndexOf('text2sql'));
  });

  it('prints a dash where there is no number, never a zero', () => {
    const lines = describeCoverage([row({ id: 'a' })], reader(TREE));
    expect(lines[0]).toContain('= —');
  });
});

describe('the defaults the workflow relies on', () => {
  it('reads the repository itself when no reader is injected', async () => {
    // `pnpm bench:coverage` passes nothing; the citations are resolved against the files on disk.
    // A test that only ever injects a reader would never load `eval/baseline/bird.json`, which is
    // the file the workflow actually checks.
    const lines: string[] = [];
    const exit = await main([], undefined, (line) => lines.push(line));
    expect(exit).toBe(0);
    expect(lines.some((line) => line.includes('bird-dev: measured, EX = 62.5'))).toBe(true);
  });

  it('prints to the console when no logger is injected', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await main(['--quiet'], reader(TREE));
      expect(spy.mock.calls.flat().join('\n')).toContain('COVERAGE:');
    } finally {
      spy.mockRestore();
    }
  });

  it('runs only when the module is the entry point', async () => {
    const moduleUrl = new URL('../eval/benchmarks.ts', import.meta.url).href;
    const lines: string[] = [];
    expect(await entryCoverage('elsewhere.ts', moduleUrl, (line) => lines.push(line))).toBeUndefined();
    expect(lines).toEqual([]);
    const code = await entryCoverage(fileURLToPath(moduleUrl), moduleUrl, (line) => lines.push(line), []);
    expect(code).toBe(0);
    expect(lines.at(-1)).toContain('4 of 9 leaderboards carry a number');
  });
});
