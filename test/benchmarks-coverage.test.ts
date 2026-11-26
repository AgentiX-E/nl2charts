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
  'eval/baseline/bird-ves.json': { rves: 56.56, ex: 65.93, scored: 600, of: 1532 },
  'eval/text2vis/baseline.json': { top1: 664, render: { rendered: 1418 } },
  // WikiSQL's row cites a percentage and carries the counts beside it; the fixture holds what the
  // manifest reads, and the file itself is checked against its own counts in
  // `test/wikisql-baseline.test.ts` rather than here.
  'eval/baseline/wikisql.json': { exact: 7183, exactPct: 85.3, scored: 8421 },
  // Spider's row carries the reading its corpus was built for this round; the counts are checked
  // against the percentage in `test/spider-baseline.test.ts`.
  'eval/baseline/spider.json': { exact: 593, exactPct: 57.35, scored: 1034 },
  // Held as the manifest reads it: a percent under `arms.selected.published`, because every row of
  // this table is a percent and the arm's raw fraction stays in `arms.readings`.
  'eval/nvbench2/metrics.json': { arms: { selected: { published: { 'f1@3': 32.23 } } } },
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

describe('a reading over a narrower denominator', () => {
  const narrowed = { scored: 600, of: 1532, why: 'the artifact in this repository covers 600 of the 1,532 questions, which is not the row' };
  const cited = { file: 'eval/baseline/bird-ves.json', path: ['rves'], kind: 'run' as const, unit: 'percent' as const, note: '' };
  const partial = (patch: Partial<Benchmark> = {}): Benchmark => row({ status: 'partial', reading: cited, narrowed, ...patch });
  const only = (issues: readonly string[]): string => issues.filter((issue) => !issue.includes('required')).join('\n');

  it('accepts a subset reading whose size and reason are both stated', () => {
    expect(only(checkCoverage([partial()], reader(TREE)))).toBe('');
  });

  it('refuses a subset reading with no denominator', () => {
    // The shape that put 63.67% on 600 questions beside 62.34% on 1,532 as though the two were
    // ordered. A `partial` row without a size is that sentence with the evidence removed.
    expect(only(checkCoverage([partial({ narrowed: undefined })], reader(TREE))))
      .toContain('partial with no denominator');
  });

  it('refuses a denominator that is not one, and one that is the whole split', () => {
    expect(only(checkCoverage([partial({ narrowed: { ...narrowed, scored: 0 } })], reader(TREE))))
      .toContain('is not a denominator');
    expect(only(checkCoverage([partial({ narrowed: { ...narrowed, scored: 1532 } })], reader(TREE))))
      .toContain('which is what measured means');
  });

  it('refuses a subset with a reason too thin to act on', () => {
    expect(only(checkCoverage([partial({ narrowed: { ...narrowed, why: 'subset' } })], reader(TREE))))
      .toContain('no reason a reader can act on');
  });

  it('refuses a row that claims a full measurement and a narrower one at once', () => {
    expect(only(checkCoverage([row({ status: 'measured', reading: cited, narrowed })], reader(TREE))))
      .toContain('names a narrower denominator');
    expect(only(checkCoverage([row({ status: 'instrumented', narrowed })], reader(TREE))))
      .toContain('names a narrower denominator');
  });

  it('still refuses a subset reading that reads no number', () => {
    const issues = checkCoverage([partial({ reading: { ...cited, path: ['nope'] } })], reader(TREE));
    expect(only(issues)).toContain('reads no number');
  });

  it('prints the denominator on the line a report quotes', () => {
    // "56.56% R-VES" and "56.56% R-VES over 600 of 1,532 questions" are different claims, and the
    // log line is the one that gets copied.
    const lines = describeCoverage([partial({ id: 'r' })], reader(TREE));
    expect(lines[0]).toContain('= 56.56 (600 of 1532)');
  });

  it('keeps the shipped manifest honest about its own denominator', () => {
    // This used to assert that at least one row was `partial`, because the R-VES row was — a
    // 600-question reading published beside a 1,532-question leaderboard. That reading was re-run
    // over the whole split, so the count is now zero and an assertion on the count would have had
    // to be deleted rather than strengthened. The invariant that survives the row is the pairing
    // between the status and the denominator, so it is asserted in both directions: a row that
    // carries a denominator is a subset row, and a subset row carries one.
    for (const benchmark of BENCHMARKS.filter((row) => row.narrowed !== undefined)) {
      expect(benchmark.status, `${benchmark.id} carries a denominator but is not partial`).toBe('partial');
      expect(benchmark.narrowed?.scored).toBeLessThan(benchmark.narrowed?.of ?? 0);
      expect(benchmark.narrowed?.scored).toBeGreaterThan(0);
    }
    for (const benchmark of BENCHMARKS.filter((row) => row.status === 'partial')) {
      expect(benchmark.narrowed, `${benchmark.id} is partial without a denominator`).toBeDefined();
    }
    // And the row whose denominator moved is pinned, because "no partial rows" is also what a
    // manifest looks like when somebody deletes a reading instead of widening it.
    const rves = BENCHMARKS.find((row) => row.id === 'bird-dev-rves');
    expect(rves?.status).toBe('measured');
    expect(rves?.narrowed).toBeUndefined();
  });
});

describe('the gate', () => {
  it('prints the table and exits zero on the shipped manifest', async () => {
    const lines: string[] = [];
    const exit = await main([], reader(TREE), (line) => lines.push(line));
    expect(exit).toBe(0);
    expect(lines.some((line) => line.includes('text2sql bird-dev: measured, EX = 65.93'))).toBe(true);
    expect(lines.some((line) => line.includes('text2viz text2vis: measured, top-1 = 664'))).toBe(true);
    expect(lines.at(-1)).toContain('8 of 9 leaderboards carry a number');
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

  it('says a floor is a floor, because a floor and a reading are different claims', () => {
    // The log line is what a reader quotes into a document. A floor is the minimum a rerun may not
    // fall below; a line that printed `62.5` bare would put a number in a report that no run
    // produced, and the reading on that arm is 62.34. `bird-dev` itself stops citing a floor this
    // round — its row is the shipped arm's run — so the property is tested on a row of its own.
    const lines = describeCoverage([row({
      id: 'f',
      status: 'measured',
      gap: '',
      reading: { file: 'eval/baseline/bird.json', path: ['floors', 'dev', 'select-mixed'], kind: 'floor', unit: 'percent', note: '' },
    })], reader(TREE));
    expect(lines[0]).toContain('= 62.5 (floor)');
  });

  it('says a count is a count, so 664 is never read as 664 percent', () => {
    const lines = describeCoverage([row({
      id: 'c',
      status: 'measured',
      gap: '',
      reading: { file: 'eval/text2vis/baseline.json', path: ['top1'], kind: 'run', unit: 'count', note: '' },
    })], reader(TREE));
    expect(lines[0]).toContain('= 664 (count)');
  });

  it('leaves an observed percentage unqualified', () => {
    const lines = describeCoverage([row({
      id: 'r',
      status: 'measured',
      gap: '',
      reading: { file: 'eval/baseline/bird.json', path: ['floors', 'dev', 'select-mixed'], kind: 'run', unit: 'percent', note: '' },
    })], reader(TREE));
    expect(lines[0]).toContain('= 62.5');
    expect(lines[0]).not.toContain('(floor)');
    expect(lines[0]).not.toContain('(count)');
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
    expect(lines.some((line) => line.includes('bird-dev: measured, EX = 65.93'))).toBe(true);
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
    expect(lines.at(-1)).toContain('8 of 9 leaderboards carry a number');
  });
});
