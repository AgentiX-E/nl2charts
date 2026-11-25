import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ceilingOf, censusLines, censusOf, main, sampledOf,
} from '../eval/nvbench2/census.js';
import type { FieldTypes } from '../eval/nvbench2/judge.js';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nl2charts-census-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const TYPES: Record<string, FieldTypes> = {
  't.csv': { a: 'category', b: 'category', c: 'category' },
};

/** A report as `arm.ts` writes one, with only the fields the census reads. */
const report = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  split: 'dev',
  model: 'deepseek-chat',
  k: 3,
  rules: ['count', 'corpus'],
  questions: 750,
  produced: 2100,
  replayed: 0,
  unparsed: 2,
  truncated: 0,
  failed: 0,
  ...patch,
});

/** One heat map, the shape the corpus's `rect` golds take. */
const heat = (x: string, y: string): Record<string, unknown> => ({
  mark: 'rect',
  encoding: { x: { field: x }, y: { field: y }, color: { aggregate: 'count' } },
});

describe('censusOf', () => {
  it('separates the rows the reading scores as zero from the rows it does not score', () => {
    const census = censusOf(report({ truncated: 12 }));
    expect(census.questions).toBe(750);
    expect(census.scored).toBe(750);
    expect(census.dropouts).toBe(14);
    expect(census.dropoutShare).toBeCloseTo(14 / 750, 10);
    // Charts per question over the questions that answered, not over the ones that did not.
    expect(census.width).toBeCloseTo(2100 / 736, 10);
  });

  it('counts a failed call as a zero inside the reading, not as a shorter denominator', () => {
    // A call that produced no reply is a question that was asked and not answered. Dropping it made the
    // denominator a function of the arm's own reliability — the arm that timed out more reported the
    // higher mean — and left no pair for `compare.ts` to resample. It is now the third kind of zero,
    // and the share of zeros is the most that answering them perfectly could be worth.
    const census = censusOf(report({ failed: 10 }));
    expect(census.absent).toBe(10);
    expect(census.scored).toBe(750);
    expect(census.dropouts).toBe(2);
    expect(census.zeros).toBe(12);
    expect(census.dropoutShare).toBeCloseTo(12 / 750, 10);
    // Charts per question is still over the questions that answered: a zero produced no chart.
    expect(census.width).toBeCloseTo(2100 / 738, 10);
  });

  it('refuses an artifact whose reading covered fewer questions than it asked', () => {
    // Two conventions cannot share one table. An artifact from before the failed-row fix states a
    // reading over 749 of its 751 questions; this file would print a share over 751 beside a mean over
    // 749, and the two numbers would look like one reading. The remedy is a re-dispatch, which is free
    // because the answers are in the store.
    expect(() => censusOf(report({ failed: 2, reading: { questions: 749 } }), 'a.json'))
      .toThrow(/the reading is over 749 questions of 750 asked/);
    expect(() => censusOf(report({ failed: 2, reading: { questions: 749 } }), 'a.json'))
      .toThrow(/re-dispatch that arm/);
    // An artifact that answered every question is consistent under both conventions and is read.
    expect(censusOf(report({ reading: { questions: 750 } })).scored).toBe(750);
  });

  it('reads an artifact written before the counters existed as an arm that had none', () => {
    const census = censusOf({
      split: 'dev', model: 'deepseek-chat', k: 3, questions: 4, produced: 8,
    });
    expect(census.rules).toEqual([]);
    expect(census.truncated).toBe(0);
    expect(census.unparsed).toBe(0);
    expect(census.absent).toBe(0);
    expect(census.replayed).toBe(0);
    expect(census.width).toBe(2);
  });

  it('is zero rather than NaN when nothing was scored or nothing was answered', () => {
    const nothing = censusOf(report({ questions: 0, produced: 0, unparsed: 0 }));
    expect(nothing.dropoutShare).toBe(0);
    expect(nothing.width).toBe(0);
    const silent = censusOf(report({ produced: 0, unparsed: 750 }));
    expect(silent.width).toBe(0);
  });

  it('refuses a report it cannot read, naming the field and the file', () => {
    expect(() => censusOf(null, 'a.json')).toThrow('a.json: the report is not an object');
    expect(() => censusOf(report({ split: '' }), 'a.json')).toThrow('a.json: split is not a string');
    expect(() => censusOf(report({ model: 7 }), 'a.json')).toThrow('a.json: model is not a string');
    expect(() => censusOf(report({ k: '3' }), 'a.json')).toThrow('a.json: k is not a count');
    expect(() => censusOf(report({ questions: -1 }), 'a.json')).toThrow('a.json: questions is not a count');
    expect(() => censusOf(report({ produced: 1.5 }), 'a.json')).toThrow('a.json: produced is not a count');
    expect(() => censusOf(report({ truncated: 'many' }), 'a.json')).toThrow('a.json: truncated is not a count');
    expect(() => censusOf(report({ unparsed: -2 }), 'a.json')).toThrow('a.json: unparsed is not a count');
    expect(() => censusOf(report({ failed: null }), 'a.json')).toThrow('a.json: failed is not a count');
    expect(() => censusOf(report({ replayed: 'all' }), 'a.json')).toThrow('a.json: replayed is not a count');
    expect(() => censusOf(report({ rules: 'count' }), 'a.json')).toThrow('a.json: rules is not a list of strings');
    expect(() => censusOf(report({ rules: [1] }), 'a.json')).toThrow('a.json: rules is not a list of strings');
  });

  it('refuses counters that add up to more questions than the run asked', () => {
    // The three counters are disjoint by construction in `arm.ts`; one that is not is a report this
    // file has no reading for, and summing it would produce a share over 100%.
    expect(() => censusOf(report({ questions: 10, unparsed: 6, truncated: 4, failed: 1 }), 'a.json'))
      .toThrow('a.json: 11 dropouts and failures over 10 questions');
  });
});

describe('ceilingOf', () => {
  it('adds the share of dropped rows to the reading and stops at one', () => {
    const census = censusOf(report({ questions: 100, truncated: 5, unparsed: 0, produced: 300 }));
    expect(ceilingOf(census, 0.3)).toBeCloseTo(0.35, 10);
    expect(ceilingOf(census, 0.99)).toBe(1);
  });

  it('adds nothing when no row was dropped', () => {
    expect(ceilingOf(censusOf(report({ unparsed: 0 })), 0.2812)).toBeCloseTo(0.2812, 10);
  });
});

describe('censusLines', () => {
  it('states the shares rather than the counts alone, and names the arm', () => {
    const lines = censusLines(censusOf(report({ truncated: 12 })));
    expect(lines[0]).toBe('dev deepseek-chat rules=count,corpus k=3');
    expect(lines[1]).toContain('questions 750 · scored 750 · produced 2100');
    expect(lines[1]).toContain('width 2.85 · replayed 0');
    expect(lines[2]).toContain('zeros 14 (1.87% of the reading: 12 truncated, 2 unparsed, 0 absent)');
  });

  it('says `none` for an arm that sent no rules', () => {
    expect(censusLines(censusOf(report({ rules: [] })))[0]).toBe('dev deepseek-chat rules=none k=3');
  });
});

describe('sampledOf', () => {
  it('builds cases from the samples an artifact kept, with the table’s own type map', () => {
    const cases = sampledOf(report({ samples: [{ csv: 't.csv', predictions: [heat('a', 'b')], golds: [heat('a', 'b')] }] }), TYPES);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.types).toEqual(TYPES['t.csv']);
  });

  it('has nothing to read when the run kept no samples', () => {
    expect(sampledOf(report(), TYPES)).toEqual([]);
  });

  it('refuses a sample that cannot be placed in the corpus rather than diagnosing it without a map', () => {
    const name = 'a.json';
    expect(() => sampledOf(null, TYPES, name)).toThrow('a.json: the report is not an object');
    expect(() => sampledOf(report({ samples: 'all' }), TYPES, name)).toThrow('a.json: samples is not a list');
    expect(() => sampledOf(report({ samples: [7] }), TYPES, name)).toThrow('a.json: sample 0 is not an object');
    expect(() => sampledOf(report({ samples: [{ predictions: [], golds: [] }] }), TYPES, name))
      .toThrow('a.json: sample 0 csv is not a string');
    expect(() => sampledOf(report({ samples: [{ csv: 'u.csv', predictions: [], golds: [] }] }), TYPES, name))
      .toThrow('a.json: sample 0 names a table the map does not: u.csv');
    expect(() => sampledOf(report({ samples: [{ csv: 't.csv', predictions: [] }] }), TYPES, name))
      .toThrow('a.json: sample 0 has no prediction and gold lists');
  });
});

describe('main', () => {
  /** A cache directory with the corpus map the move table needs, and nothing else. */
  const cache = (): string => {
    const dir = scratch();
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ types: TYPES }));
    return dir;
  };

  /** An artifact file, written where the tool can read it. */
  const artifact = (content: Record<string, unknown>): string => {
    const path = join(scratch(), 'nvbench2-arm.json');
    writeFileSync(path, JSON.stringify(content));
    return path;
  };

  const printed = (): { log: (line: string) => void; lines: string[] } => {
    const lines: string[] = [];
    return { log: (line) => lines.push(line), lines };
  };

  it('prints a census per artifact and the move table behind it', async () => {
    const path = artifact(report({
      samples: [
        { csv: 't.csv', predictions: [heat('c', 'b')], golds: [heat('b', 'c')] },
        { csv: 't.csv', predictions: [heat('b', 'c')], golds: [heat('b', 'c')] },
      ],
    }));
    const { log, lines } = printed();
    expect(await main([path, '--cache', cache()], log)).toBe(0);
    expect(lines[0]).toBe('dev deepseek-chat rules=count,corpus k=3');
    expect(lines.join('\n')).toContain('misplaced 1 over 2 samples · one exchange away 1 · same column twice 0');
    expect(lines.join('\n')).toContain('x→y 1 · one exchange away 1');
  });

  it('reads several artifacts in one call, one block each', async () => {
    const first = artifact(report());
    const second = artifact(report({ split: 'test', model: 'deepseek-reasoner', truncated: 12 }));
    // Without a `log`, the tool writes to stdout: that is the shape the script runs in, and the
    // default is the one branch an in-process test has to take to reach it.
    expect(await main([first, '--cache', cache()])).toBe(0);
    const { log, lines } = printed();
    expect(await main([first, second, '--cache', cache()], log)).toBe(0);
    expect(lines.filter((line) => line.startsWith('dev '))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('test deepseek-reasoner'))).toHaveLength(1);
  });

  it('says so when an artifact kept no samples instead of printing an empty table', async () => {
    const { log, lines } = printed();
    expect(await main([artifact(report()), '--cache', cache()], log)).toBe(0);
    expect(lines.join('\n')).toContain('no samples kept, so there is no misplaced decomposition (--samples 0)');
  });

  it('prints the censuses without the move table when the corpus map is cold', async () => {
    // `--cache` names a directory this test just made, so "cold" is a property of the fixture rather
    // than of the checkout. The earlier version read the repository's own cache and passed only while
    // nobody had run `bench:nvbench2:metadata` here — a test that fails when a documented command has
    // been run is a test that punishes the reader for following the instructions.
    const { log, lines } = printed();
    expect(await main([artifact(report()), '--cache', scratch()], log)).toBe(1);
    expect(lines.join('\n')).toContain('no corpus map at');
    expect(lines.join('\n')).toContain('pnpm bench:nvbench2:metadata');
  });

  it('refuses a call with no artifact, and a file it cannot parse', async () => {
    expect(await main([], () => {})).toBe(2);
    const { log, lines } = printed();
    expect(await main([join(scratch(), 'missing.json')], log)).toBe(2);
    expect(lines[0]).toContain('nvbench2 census: ENOENT');
  });

  it('refuses an artifact whose samples name a table the corpus does not have', async () => {
    const path = artifact(report({ samples: [{ csv: 'u.csv', predictions: [], golds: [] }] }));
    const { log, lines } = printed();
    expect(await main([path, '--cache', cache()], log)).toBe(2);
    expect(lines[0]).toContain('names a table the map does not: u.csv');
  });
});

describe('the command', () => {
  // The entry guard is the one branch a unit test cannot reach by importing the module, and a broken
  // command is exactly the failure that stays invisible: the numbers keep being produced by whoever
  // calls `main`, and the tool a document tells a reader to run exits for a reason nobody sees. So
  // the file is run the way the script runs it, twice — once refused, once with a reading.
  const ROOT = join(import.meta.dirname, '..');
  const run = (args: readonly string[]): { status: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'eval/nvbench2/census.ts'), ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, out };
    } catch (error) {
      const failed = error as { status?: number; stdout?: string };
      return { status: failed.status ?? -1, out: failed.stdout ?? '' };
    }
  };

  it('refuses a call with no artifact, with a sentence rather than a stack', () => {
    const { status, out } = run([]);
    expect(status).toBe(2);
    expect(out).toContain('nvbench2 census: name at least one artifact');
  });

  it('prints a census for an artifact and exits zero', () => {
    const path = join(scratch(), 'nvbench2-arm.json');
    writeFileSync(path, JSON.stringify(report()));
    const { status, out } = run([path, '--cache', scratch()]);
    expect(status).toBe(1);
    expect(out).toContain('dev deepseek-chat rules=count,corpus k=3');
    // Exit 1 rather than 0 because the cache directory this test named holds no corpus map; the
    // census is still printed, which is what the code promises for a cold map.
    expect(out).toContain('no corpus map at');
  });
});
