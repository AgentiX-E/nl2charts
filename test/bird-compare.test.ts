/**
 * Two runs, and the two findings a rate difference cannot produce.
 *
 * The fixtures below are small enough that every count can be derived by hand, and they are shaped
 * after the real pair that motivated the instrument: two Mini-Dev runs on 2026-11-08, identical
 * corpus, identical endpoint, identical harness, thirteen overlapping arms. The readings that came
 * out of it are in the header of `compare.ts`; these tests pin the arithmetic that produces them,
 * because an instrument whose disagreements are only checked against its own past output is an
 * instrument that cannot be wrong.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  churn,
  compareLines,
  compareProblems,
  compareRuns,
  coordinatesOf,
  crossRunIntervalPp,
  displacement,
  isEntry,
  main,
  rateOf,
  resolveCompareSettings,
  servedBases,
} from '../eval/bird/compare.js';
import type { RunArtifact } from '../eval/bird/compare.js';

function run(overrides: Partial<RunArtifact> = {}): RunArtifact {
  return {
    split: 'minidev',
    model: 'deepseek-chat',
    secondModel: null,
    generatedAt: '2026-11-08T13:00:00.000Z',
    corpus: { digest: '7f9b2384df7fd655', rows: 500, questions: 498 },
    run: { timeoutMs: 60000, concurrency: 8, retries: 3 },
    arms: [
      { arm: 'select', passed: 278, total: 496, accuracy: 0.5605, servedModels: { 'deepseek-flash': 496 } },
      { arm: 'names', passed: 180, total: 496, accuracy: 0.3629, servedModels: { 'deepseek-flash': 496 } },
    ],
    ...overrides,
  };
}

describe('servedBases', () => {
  it('unions the bases across arms and sorts them', () => {
    expect(
      servedBases({
        arms: [
          { arm: 'a', servedModels: { 'zulu-model': 10 } },
          { arm: 'b', servedModels: { 'alpha-model': 4 } },
          { arm: 'c', servedModels: { 'zulu-model': 6 } },
        ],
      }),
    ).toEqual(['alpha-model', 'zulu-model']);
  });

  it('is empty when no arm reports a base', () => {
    expect(servedBases({ arms: [{ arm: 'a' }] })).toEqual([]);
    expect(servedBases({})).toEqual([]);
  });
});

describe('rateOf', () => {
  it('prefers the count over the recorded rate', () => {
    expect(rateOf({ arm: 'a', passed: 1, total: 4, accuracy: 0.9 })).toBe(0.25);
  });

  it('falls back to the rate when a count is missing', () => {
    expect(rateOf({ arm: 'a', accuracy: 0.5 })).toBe(0.5);
  });

  it('returns nothing for an arm that scored no question, and for one that recorded neither', () => {
    expect(rateOf({ arm: 'a', passed: 0, total: 0 })).toBeUndefined();
    expect(rateOf({ arm: 'a' })).toBeUndefined();
    expect(rateOf({ arm: 'a', total: 496 })).toBeUndefined();
  });
});

describe('coordinatesOf', () => {
  it('marks every coordinate the same when two artifacts match', () => {
    const coordinates = coordinatesOf(run(), run());
    expect(coordinates.every((coordinate) => coordinate.same)).toBe(true);
    expect(coordinates.map((coordinate) => coordinate.name)).toEqual([
      'split',
      'corpus.digest',
      'model.asked',
      'model.served',
      'secondModel',
      'harness',
    ]);
  });

  it('separates what was asked from what answered', () => {
    const coordinates = coordinatesOf(run(), run({ arms: [{ arm: 'select', passed: 1, total: 2, servedModels: { 'deepseek-pro': 2 } }] }));
    const asked = coordinates.find((coordinate) => coordinate.name === 'model.asked') as { same: boolean };
    const served = coordinates.find((coordinate) => coordinate.name === 'model.served') as { same: boolean; left: string; right: string };
    expect(asked.same).toBe(true);
    expect(served.same).toBe(false);
    expect(served.left).toBe('deepseek-flash');
    expect(served.right).toBe('deepseek-pro');
  });

  it('treats an unrecorded corpus or base as a disagreement rather than as a match', () => {
    const coordinates = coordinatesOf(run(), run({ corpus: undefined, arms: [{ arm: 'select' }] }));
    expect(coordinates.find((coordinate) => coordinate.name === 'corpus.digest')?.same).toBe(false);
    expect(coordinates.find((coordinate) => coordinate.name === 'model.served')?.same).toBe(false);
    expect(coordinates.find((coordinate) => coordinate.name === 'corpus.digest')?.left).toBe('7f9b2384df7fd655');
    expect(coordinates.find((coordinate) => coordinate.name === 'corpus.digest')?.right).toBe('not recorded');
  });

  it('notes both unrecorded sides as not recorded, which is still not a match', () => {
    const coordinates = coordinatesOf({}, {});
    const corpus = coordinates.find((coordinate) => coordinate.name === 'corpus.digest') as { same: boolean; left: string };
    expect(corpus.left).toBe('not recorded');
    expect(corpus.same).toBe(false);
    expect(coordinates.find((coordinate) => coordinate.name === 'split')?.same).toBe(true);
    expect(coordinates.find((coordinate) => coordinate.name === 'secondModel')?.left).toBe('none');
  });

  it('renders a harness that was never recorded as such', () => {
    const coordinates = coordinatesOf(run({ run: undefined }), run({ run: undefined }));
    const harness = coordinates.find((coordinate) => coordinate.name === 'harness') as { left: string; same: boolean };
    expect(harness.left).toBe('not recorded');
    expect(harness.same).toBe(false);
  });

  it('renders a partial harness, because a missing retry budget is not a missing deadline', () => {
    const coordinates = coordinatesOf(run({ run: { timeoutMs: 30000 } }), run({ run: { timeoutMs: 30000 } }));
    const harness = coordinates.find((coordinate) => coordinate.name === 'harness') as { left: string; same: boolean };
    expect(harness.left).toBe('timeout 30000');
    expect(harness.same).toBe(true);
  });

  it('names the second endpoint as none when there is none', () => {
    const coordinates = coordinatesOf(run(), run({ secondModel: 'glm-4-flash' }));
    expect(coordinates.find((coordinate) => coordinate.name === 'secondModel')?.same).toBe(false);
    expect(coordinates.find((coordinate) => coordinate.name === 'secondModel')?.left).toBe('none');
  });

  it('calls a harness object with no fields unrecorded, because an empty object is not a setting', () => {
    const coordinates = coordinatesOf(run({ run: {} }), run({ run: {} }));
    expect(coordinates.find((coordinate) => coordinate.name === 'harness')?.left).toBe('not recorded');
  });

  it('refuses to call two splits the same run', () => {
    const coordinates = coordinatesOf(run(), run({ split: 'dev' }));
    expect(coordinates.find((coordinate) => coordinate.name === 'split')?.same).toBe(false);
    expect(coordinates.find((coordinate) => coordinate.name === 'split')?.left).toBe('minidev');
  });
});

describe('crossRunIntervalPp', () => {
  it('is zero on an empty sample rather than an interval', () => {
    expect(crossRunIntervalPp(0, 0, 0, 0)).toBe(0);
  });

  it('matches the closed form at an even split', () => {
    // 1.96 * sqrt(2 * 0.5 * 0.5 / 100) = 0.1386 -> 13.86pp
    expect(crossRunIntervalPp(50, 100, 50, 100)).toBe(13.86);
  });

  it('shrinks as the sample grows and widens as the rate approaches a half', () => {
    const wide = crossRunIntervalPp(50, 100, 50, 100);
    const narrow = crossRunIntervalPp(500, 1000, 500, 1000);
    const narrowEdge = crossRunIntervalPp(950, 1000, 950, 1000);
    expect(narrow).toBeLessThan(wide);
    expect(narrowEdge).toBeLessThan(narrow);
  });

  it('uses the thinner sample, because a difference cannot be resolved better than its smaller side', () => {
    expect(crossRunIntervalPp(250, 500, 50, 100)).toBe(crossRunIntervalPp(50, 100, 50, 100));
  });
});

describe('displacement', () => {
  it('orders the table by how far each arm moved', () => {
    const rows = displacement(
      run(),
      run({
        arms: [
          { arm: 'select', passed: 288, total: 496 },
          { arm: 'names', passed: 181, total: 496 },
        ],
      }),
    );
    expect(rows.map((row) => row.arm)).toEqual(['select', 'names']);
    expect(rows[0]?.deltaPp).toBe(2.02);
    expect(rows[1]?.deltaPp).toBe(0.2);
  });

  it('marks a move inside the interval as unreadable and one outside it as readable', () => {
    const inside = displacement(run(), run({ arms: [{ arm: 'select', passed: 288, total: 496 }] }));
    expect(inside[0]?.intervalPp).toBe(6.16);
    expect(inside[0]?.readable).toBe(false);
    const outside = displacement(
      { arms: [{ arm: 'select', passed: 200, total: 496 }] },
      { arms: [{ arm: 'select', passed: 300, total: 496 }] },
    );
    expect(outside[0]?.deltaPp).toBe(20.16);
    expect(outside[0]?.readable).toBe(true);
  });

  it('flags a row whose two runs scored different sample sizes', () => {
    const rows = displacement(run(), run({ arms: [{ arm: 'select', passed: 278, total: 400 }] }));
    expect(rows[0]?.sameSample).toBe(false);
  });

  it('skips an arm the other run did not score', () => {
    const rows = displacement(run(), run({ arms: [{ arm: 'select', passed: 288, total: 496 }] }));
    expect(rows.map((row) => row.arm)).toEqual(['select']);
  });

  it('reads an arm that reports only a rate, and treats a missing sample size as zero', () => {
    const rows = displacement({ arms: [{ arm: 'select', accuracy: 0.5 }] }, { arms: [{ arm: 'select', accuracy: 0.6 }] });
    expect(rows[0]?.deltaPp).toBe(10);
    expect(rows[0]?.intervalPp).toBe(0);
  });

  it('is empty when an artifact carries no arms at all', () => {
    expect(displacement({}, {})).toEqual([]);
  });

  it('skips an arm whose rate cannot be read on either side', () => {
    const rows = displacement({ arms: [{ arm: 'select', passed: 0, total: 0 }] }, { arms: [{ arm: 'select', passed: 1, total: 2 }] });
    expect(rows).toEqual([]);
    const other = displacement({ arms: [{ arm: 'select', passed: 1, total: 2 }] }, { arms: [{ arm: 'select' }] });
    expect(other).toEqual([]);
  });
});

describe('churn', () => {
  it('counts the cases that flipped and the direction of each flip', () => {
    const rows = churn(
      { cases: [{ arm: 'a', id: 1, passed: true }, { arm: 'a', id: 2, passed: false }, { arm: 'a', id: 3, passed: true }] },
      { cases: [{ arm: 'a', id: 1, passed: false }, { arm: 'a', id: 2, passed: true }, { arm: 'a', id: 3, passed: true }] },
    );
    expect(rows).toEqual([{ arm: 'a', examined: 3, up: 1, down: 1, net: 0, churnShare: 66.7 }]);
  });

  it('is empty when neither artifact carries case rows', () => {
    expect(churn(run(), run())).toEqual([]);
  });

  it('examines only the ids both runs scored and ignores a row with no verdict', () => {
    const rows = churn(
      { cases: [{ arm: 'a', id: 1, passed: true }, { arm: 'a', id: 2, passed: true }, { arm: 'a', id: 9 }] },
      { cases: [{ arm: 'a', id: 1, passed: false }, { arm: 'a', id: 3, passed: true }] },
    );
    expect(rows).toEqual([{ arm: 'a', examined: 1, up: 0, down: 1, net: -1, churnShare: 100 }]);
  });

  it('orders arms by churn, because the widest churn is the one that bounds the other readings', () => {
    const rows = churn(
      {
        cases: [
          { arm: 'steady', id: 1, passed: true },
          { arm: 'steady', id: 2, passed: true },
          { arm: 'churny', id: 1, passed: true },
          { arm: 'churny', id: 2, passed: true },
        ],
      },
      {
        cases: [
          { arm: 'steady', id: 1, passed: true },
          { arm: 'steady', id: 2, passed: true },
          { arm: 'churny', id: 1, passed: false },
          { arm: 'churny', id: 2, passed: false },
        ],
      },
    );
    expect(rows.map((row) => row.arm)).toEqual(['churny', 'steady']);
    expect(rows[0]?.churnShare).toBe(100);
    expect(rows[1]?.churnShare).toBe(0);
  });

  it('leaves out an arm whose two runs scored no question in common', () => {
    const rows = churn({ cases: [{ arm: 'a', id: 1, passed: true }] }, { cases: [{ arm: 'a', id: 2, passed: true }] });
    expect(rows).toEqual([]);
  });

  it('breaks a churn tie by arm name, so the order is stable between runs', () => {
    const rows = churn(
      { cases: [{ arm: 'zulu', id: 1, passed: true }, { arm: 'alpha', id: 1, passed: true }] },
      { cases: [{ arm: 'zulu', id: 1, passed: true }, { arm: 'alpha', id: 1, passed: true }] },
    );
    expect(rows.map((row) => row.arm)).toEqual(['alpha', 'zulu']);
  });

  it('leaves out an arm only one side carries', () => {
    const rows = churn({ cases: [{ arm: 'a', id: 1, passed: true }] }, { cases: [{ arm: 'b', id: 1, passed: true }] });
    expect(rows).toEqual([]);
  });
});

describe('compareRuns', () => {
  it('is comparable when every coordinate matches, and reports the largest move', () => {
    const report = compareRuns(run(), run(), 'a.json', 'b.json');
    expect(report.comparable).toBe(true);
    expect(report.broken).toEqual([]);
    expect(report.largestMovePp).toBe(0);
    expect(report.problems).toEqual([]);
  });

  it('names the coordinates that broke instead of refusing to print', () => {
    const report = compareRuns(run(), run({ corpus: { digest: '0000000000000000' }, split: 'dev' }), 'a.json', 'b.json');
    expect(report.comparable).toBe(false);
    expect(report.broken).toEqual(['split', 'corpus.digest']);
  });

  it('records arms only one run scored, in both directions', () => {
    const report = compareRuns(
      run({ arms: [{ arm: 'select', passed: 1, total: 2 }, { arm: 'old', passed: 1, total: 2 }] }),
      run({ arms: [{ arm: 'select', passed: 1, total: 2 }, { arm: 'new', passed: 1, total: 2 }] }),
      'a.json',
      'b.json',
    );
    expect(report.onlyLeft).toEqual(['old']);
    expect(report.onlyRight).toEqual(['new']);
  });

  it('handles an artifact that carries no arm list at all', () => {
    const report = compareRuns({}, {}, 'a', 'b');
    expect(report.onlyLeft).toEqual([]);
    expect(report.onlyRight).toEqual([]);
    expect(report.comparable).toBe(false);
  });

  it('fails the reading when the runs share no scored arm', () => {
    const report = compareRuns(run({ arms: [{ arm: 'one', passed: 1, total: 2 }] }), run({ arms: [{ arm: 'two', passed: 1, total: 2 }] }), 'a', 'b');
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('share no arm');
  });

  it('carries the churn reading when both artifacts keep their case rows', () => {
    const report = compareRuns(
      { arms: [{ arm: 'a', passed: 1, total: 2 }], cases: [{ arm: 'a', id: 1, passed: true }, { arm: 'a', id: 2, passed: false }] },
      { arms: [{ arm: 'a', passed: 1, total: 2 }], cases: [{ arm: 'a', id: 1, passed: false }, { arm: 'a', id: 2, passed: true }] },
      'a',
      'b',
    );
    expect(report.churn).toEqual([{ arm: 'a', examined: 2, up: 1, down: 1, net: 0, churnShare: 100 }]);
  });
});

describe('compareProblems', () => {
  it('says nothing when there is a shared arm', () => {
    expect(compareProblems(1)).toEqual([]);
  });
});

describe('compareLines', () => {
  const render = (report: ReturnType<typeof compareRuns>): string => compareLines(report, 'left meta', 'right meta').join('\n');

  it('prints the verdict in words a reader can act on', () => {
    expect(render(compareRuns(run(), run(), 'a.json', 'b.json'))).toContain('verdict: comparable');
    expect(render(compareRuns(run(), run({ split: 'dev' }), 'a.json', 'b.json'))).toContain('verdict: not comparable — split');
  });

  it('explains each broken coordinate rather than only marking it', () => {
    const text = render(compareRuns(run(), run({ arms: [{ arm: 'select', passed: 1, total: 2, servedModels: { other: 2 } }] }), 'a', 'b'));
    expect(text).toContain('DIFFERS');
    expect(text).toContain('the endpoint named a different base model');
  });

  it('prints the movement table with the interval and the reading of each row', () => {
    const text = render(compareRuns(run(), run({ arms: [{ arm: 'select', passed: 288, total: 496 }] }), 'a', 'b'));
    expect(text).toContain('56.05%');
    expect(text).toContain('58.06%');
    expect(text).toContain('+2.02');
    expect(text).toContain('inside');
  });

  it('says a delta is a hypothesis rather than a result when it is inside the interval', () => {
    const text = render(compareRuns(run(), run(), 'a', 'b'));
    expect(text).toContain('no arm moved outside that interval');
  });

  it('says the opposite when an arm clears the interval', () => {
    const text = render(
      compareRuns({ arms: [{ arm: 'select', passed: 200, total: 496 }] }, { arms: [{ arm: 'select', passed: 300, total: 496 }] }, 'a', 'b'),
    );
    expect(text).toContain('1 arm(s) moved outside that interval (select)');
  });

  it('names the arms each run scored alone', () => {
    const text = render(
      compareRuns(run({ arms: [{ arm: 'old', passed: 1, total: 2 }] }), run({ arms: [{ arm: 'new', passed: 1, total: 2 }] }), 'a', 'b'),
    );
    expect(text).toContain('scored only on the left: old');
    expect(text).toContain('scored only on the right: new');
    expect(text).toContain('no arm was scored by both runs');
    expect(text).toContain('FAILED the two runs share no arm');
  });

  it('omits the churn block when the artifacts carry no case rows', () => {
    expect(render(compareRuns(run(), run(), 'a', 'b'))).not.toContain('what moved under the rates');
  });

  it('prints the churn block and names the widest arm when the rows are there', () => {
    const text = render(
      compareRuns(
        { arms: [{ arm: 'a', passed: 1, total: 2 }], cases: [{ arm: 'a', id: 1, passed: true }, { arm: 'a', id: 2, passed: true }] },
        { arms: [{ arm: 'a', passed: 1, total: 2 }], cases: [{ arm: 'a', id: 1, passed: false }, { arm: 'a', id: 2, passed: true }] },
        'a',
        'b',
      ),
    );
    expect(text).toContain('what moved under the rates');
    expect(text).toContain('a did not change, yet 1 of 2 questions (50.0%) came out differently');
  });
});

describe('resolveCompareSettings', () => {
  it('takes two paths and resolves them against the root', () => {
    expect(resolveCompareSettings(['x.json', 'y.json'], '/repo')).toEqual({ left: '/repo/x.json', right: '/repo/y.json' });
  });

  it('refuses one path, because a comparison with one side is not a comparison', () => {
    expect(() => resolveCompareSettings(['x.json'], '/repo')).toThrow('usage: compare.ts');
    expect(() => resolveCompareSettings([], '/repo')).toThrow('usage: compare.ts');
  });

  it('refuses a flag, because there is nothing here for one to mean', () => {
    expect(() => resolveCompareSettings(['x.json', 'y.json', '--strict'], '/repo')).toThrow('unrecognized argument --strict');
  });
});

describe('the command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compare-'));
  const write = (name: string, body: unknown): string => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(body));
    return path;
  };

  it('reads two artifacts and exits zero when the pair is readable', () => {
    const left = write('left.json', run());
    const right = write('right.json', run({ arms: [{ arm: 'select', passed: 288, total: 496 }] }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main([left, right], dir)).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('two runs, one instrument');
    } finally {
      log.mockRestore();
    }
  });

  it('exits one when the runs share nothing to compare', () => {
    const left = write('left2.json', run({ arms: [{ arm: 'one', passed: 1, total: 2 }] }));
    const right = write('right2.json', run({ arms: [{ arm: 'two', passed: 1, total: 2 }] }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main([left, right], dir)).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  it('names an artifact that records nothing, rather than printing a blank column', () => {
    const left = write('bare-a.json', {});
    const right = write('bare-b.json', {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main([left, right], dir)).toBe(1);
      const text = log.mock.calls.flat().join('\n');
      expect(text).toContain('unknown split, no model');
      expect(text).toContain('no timestamp');
    } finally {
      log.mockRestore();
    }
  });

  it('writes the exit code when it is the entry point', async () => {
    const left = write('entry-a.json', run());
    const right = write('entry-b.json', run());
    const saved = process.argv.slice();
    const moduleUrl = new URL('../eval/bird/compare.ts', import.meta.url);
    process.argv.splice(0, process.argv.length, 'node', moduleUrl.pathname, left, right);
    const exits = process.exitCode;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      vi.resetModules();
      await import('../eval/bird/compare.js');
      expect(log.mock.calls.flat().join('\n')).toContain('two runs, one instrument');
      expect(process.exitCode).toBe(0);
    } finally {
      process.argv.splice(0, process.argv.length, ...saved);
      process.exitCode = exits;
      log.mockRestore();
      vi.resetModules();
    }
  });

  it('is a script only when it is the entry point', () => {
    expect(isEntry(undefined, 'file:///repo/eval/bird/compare.ts')).toBe(false);
    expect(isEntry('/repo/eval/bird/compare.ts', 'file:///repo/eval/bird/compare.ts')).toBe(true);
    expect(isEntry('/repo/other.ts', 'file:///repo/eval/bird/compare.ts')).toBe(false);
  });

  it('runs under tsx against two real files and prints the verdict', () => {
    const left = write('left3.json', run());
    const right = write('right3.json', run());
    const result = spawnSync('npx', ['tsx', 'eval/bird/compare.ts', left, right], { cwd: process.cwd(), encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verdict: comparable');
  });
});
