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
import { mcnemarExact } from '@agentix-e/nl2charts-devkit';
import {
  churn,
  compareLines,
  compareProblems,
  compareRuns,
  coordinatesOf,
  crossLines,
  crossPair,
  crossPairs,
  pairedIntervalPp,
  crossRunIntervalPp,
  displacement,
  isEntry,
  main,
  chiSquareSurvival,
  poolPair,
  pooledLines,
  readPairOf,
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
    // The coordinate that says which generator answered. A run written before this field existed
    // has none, and the instrument now prints that as NOT RECORDED rather than as agreement.
    baseFingerprint: { digest: 'a1b2c3d4e5f60718', probes: 3, total: 3, stable: true, bases: ['deepseek-flash'] },
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
      'model.fingerprint',
      'secondModel',
      'harness',
    ]);
  });

  it('separates two runs whose base answered the same probes differently under one name', () => {
    const coordinates = coordinatesOf(run(), run({ baseFingerprint: { digest: 'ffffffffffffffff', probes: 3, total: 3, stable: true } }));
    const fingerprint = coordinates.find((coordinate) => coordinate.name === 'model.fingerprint') as { same: boolean; recorded: boolean; left: string; right: string };
    expect(fingerprint.same).toBe(false);
    expect(fingerprint.recorded).toBe(true);
    expect(fingerprint.left).toBe('a1b2c3d4e5f60718');
    expect(fingerprint.right).toBe('ffffffffffffffff');
  });

  it('says a fingerprint was not recorded rather than calling it a difference', () => {
    const coordinates = coordinatesOf(run({ baseFingerprint: undefined }), run({ baseFingerprint: undefined }));
    const fingerprint = coordinates.find((coordinate) => coordinate.name === 'model.fingerprint') as { same: boolean; recorded: boolean; left: string };
    expect(fingerprint.left).toBe('not recorded');
    expect(fingerprint.same).toBe(false);
    expect(fingerprint.recorded).toBe(false);
  });

  it('refuses to compare a digest the endpoint would answer differently on the next draw', () => {
    const coordinates = coordinatesOf(run(), run({ baseFingerprint: { digest: 'a1b2c3d4e5f60718', probes: 3, total: 3, stable: false } }));
    const fingerprint = coordinates.find((coordinate) => coordinate.name === 'model.fingerprint') as { same: boolean; recorded: boolean; right: string };
    expect(fingerprint.right).toBe('a1b2c3d4e5f60718 (unstable)');
    expect(fingerprint.same).toBe(false);
    expect(fingerprint.recorded).toBe(false);
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

  it('marks a coordinate nobody recorded as NOT RECORDED, and says that in the verdict', () => {
    // The verdict used to call both cases "changed", which asserts that something moved in the one
    // case where the truth is that nobody looked. The two are different news and they are now two
    // different sentences.
    const text = render(compareRuns(run({ baseFingerprint: undefined }), run({ baseFingerprint: undefined }), 'a', 'b'));
    expect(text).toContain('NOT RECORDED');
    expect(text).not.toContain('DIFFERS');
    expect(text).toContain('model.fingerprint is not recorded on both sides');
    expect(text).not.toContain('model.fingerprint changed');
  });

  it('states both halves when one coordinate moved and another was never read', () => {
    const text = render(compareRuns(run(), run({ split: 'dev', baseFingerprint: undefined, corpus: { digest: '0000000000000000' } }), 'a', 'b'));
    expect(text).toContain('split, corpus.digest changed');
    expect(text).toContain('model.fingerprint is not recorded on both sides');
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
    expect(resolveCompareSettings(['x.json', 'y.json'], '/repo')).toEqual({ left: '/repo/x.json', right: '/repo/y.json', also: [] });
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

/**
 * One pair, read twice — the case that made the round before this one over-claim.
 *
 * `inline+evidence -> select` read 22 against 8 (p = 0.0161) in one run and 19 against 18
 * (p = 1.0000) in the next, on the same corpus with the same base model. A paired test conditions
 * on the questions and not on the generator's draw, and at 496 questions that draw is worth about
 * two points — so the unit of evidence has to be the pair pooled over the runs that read it, with
 * the disagreement between readings reported rather than averaged away.
 */
/**
 * Cochran's Q is referred to χ² with k−1 degrees of freedom, and the code that reported it used the
 * 1-df value for every k. The two coincide at k = 2 — which is the shape most of the tests above use
 * — and diverge from k = 3, so a wrong test sat under three rounds of published labels without a
 * single failing assertion. These are the table's 5% points, which is what a survival function has
 * to reproduce before anything can be referred to it.
 */
describe('the chi-square survival function the heterogeneity test needs', () => {
  const points: [number, number, number][] = [
    [3.841, 1, 0.05],
    [5.991, 2, 0.05],
    [7.815, 3, 0.05],
    [9.488, 4, 0.05],
    [12.592, 6, 0.05],
    [14.067, 7, 0.05],
    [18.307, 10, 0.05],
  ];

  it('reproduces the 5% points of the table it is standing in for', () => {
    for (const [q, df, p] of points) expect(chiSquareSurvival(q, df)).toBeCloseTo(p, 3);
  });

  it('is one at zero, and approaches zero as q grows', () => {
    expect(chiSquareSurvival(0, 3)).toBe(1);
    expect(chiSquareSurvival(1e-9, 1)).toBeGreaterThan(0.9999);
    expect(chiSquareSurvival(200, 6)).toBeLessThan(1e-30);
  });

  it('has no degrees of freedom below one', () => {
    expect(chiSquareSurvival(10, 0)).toBe(1);
  });
});

describe('pooling one pair over the runs that read it', () => {
  const reading = (wins: number, losses: number, p = 1): Parameters<typeof poolPair>[0][number] => ({
    artifact: `run-${String(wins)}-${String(losses)}`,
    examined: 496,
    wins,
    losses,
    deltaPp: Number((((wins - losses) / 496) * 100).toFixed(2)),
    p,
  });

  /**
   * A reading whose p is the test the ledger would run, rather than a number typed into a fixture.
   *
   * The default `p = 1` above is safe for the arithmetic tests and wrong for the label tests: a
   * verdict is a statement about which readings cleared their own test, so a fixture that hands
   * every reading the same p is a fixture that cannot tell one rule from another.
   */
  const observed = (wins: number, losses: number): Parameters<typeof poolPair>[0][number] =>
    reading(wins, losses, Number(mcnemarExact(losses, wins).toFixed(4)));

  it('weights each reading by its inverse variance and reports the pooled interval', () => {
    const pooled = poolPair([reading(22, 8, 0.0161), reading(19, 18)], 'a', 'b');
    expect(pooled.pooledPp).toBe(1.65);
    expect(pooled.pooledIntervalPp).toBe(1.61);
    expect(pooled.pooledP).toBe(0.0448);
    expect(pooled.readings).toHaveLength(2);
  });

  it('calls a pair one-run-only when the one significant reading does not survive the pool', () => {
    // +2.82pp (p = 0.0161), +0.20pp and +0.20pp: the same sign, homogeneous, and the pool is
    // +1.08pp ± 1.25 at p = 0.092. One run separated it; three runs could not.
    expect(poolPair([reading(22, 8, 0.0161), reading(19, 18), reading(14, 12)], 'a', 'b').verdict).toBe('one-run-only');
  });

  it('calls a pair a sign flip when a reading in each direction cleared its own test', () => {
    // A reversal is the one thing a pool must not average away, so it is checked before
    // heterogeneity: both readings are significant, in opposite directions, and Q rejects too.
    // The label names the kind of disagreement rather than the fact of it.
    const pooled = poolPair([observed(40, 5), observed(5, 40)], 'a', 'b');
    expect(pooled.verdict).toBe('sign-flip');
    expect(pooled.tauSquaredPp2).toBeGreaterThan(0);
  });

  it('does not call one null reading on the other side of zero a reversal', () => {
    // The eight real readings of `inline+evidence -> inline+evidence+audit`. Seven are positive and
    // one is negative — `8/11`, which is p = 0.65 on its own. This pair printed `sign-flip` for
    // three rounds because the rule asked whether *any* reading was significant and whether the sign
    // set had two members, and those were two different readings: the significance was in `17/4`
    // and the opposite sign was in `8/11`. A reading that cannot separate itself from zero is a
    // wobble, and calling the pool a reversal on its behalf made the label mean "not unanimous".
    const cells: [number, number][] = [[8, 11], [11, 7], [10, 9], [9, 8], [17, 4], [11, 6], [10, 5], [10, 7]];
    const pooled = poolPair(cells.map(([wins, losses]) => observed(wins, losses)), 'a', 'b');
    expect(pooled.verdict).toBe('established');
    expect(pooled.pooledP).toBeLessThan(0.05);
  });

  it('calls a sign change between two insignificant readings a wobble, not a flip', () => {
    expect(poolPair([reading(17, 18, 1), reading(18, 15, 0.7283)], 'a', 'b').verdict).toBe('none');
  });

  it('calls a pair significant in every reading established', () => {
    expect(poolPair([reading(40, 5, 0.0001), reading(38, 6, 0.0001)], 'a', 'b').verdict).toBe('established');
  });

  /**
   * The three real readings of `inline+evidence -> metadata+evidence`: 31/18, 28/15, 32/15 — +2.62,
   * +2.62, +3.43pp. No single run clears 0.05 except the third (0.0854, 0.0660, 0.0186), while the
   * pool is +2.89pp ± 1.55 at p = 0.0003 with Q p = 0.631. The rule used to require *every* reading
   * to be significant on its own, which labelled this `one-run-only` — a description of the readings
   * that contradicts the estimate they carry, and the label a decision would have been made on.
   */
  it('calls a pool that clears zero established even when only one reading did on its own', () => {
    const pooled = poolPair([reading(31, 18, 0.0854), reading(28, 15, 0.066), reading(32, 15, 0.0186)], 'a', 'b');
    expect(pooled.pooledPp).toBe(2.89);
    expect(pooled.pooledP).toBeLessThan(0.05);
    expect(pooled.readingsSignificant).toBe(1);
    expect(pooled.verdict).toBe('established');
  });

  it('does not let a label outrun the estimate it labels', () => {
    // 22/8 then 19/18: +2.82 against +0.20, pooled +1.65 ± 1.61 at p = 0.0448. The pool clears zero
    // and the readings are homogeneous, so the label is `established` — with `1 of 2 readings
    // significant` printed beside it, which is the fact that used to be smuggled into the label
    // instead. A third reading of the same pair (13/13) makes all three heterogeneous.
    const two = poolPair([reading(22, 8, 0.0161), reading(19, 18)], 'a', 'b');
    expect(two.readingsSignificant).toBe(1);
    expect(two.pooledP).toBeLessThan(0.05);
    expect(two.verdict).toBe('established');
  });

  it('calls two readings that agree on nothing the draw, not a lever', () => {
    expect(poolPair([reading(18, 17), reading(18, 15)], 'a', 'b').verdict).toBe('none');
  });

  it('refuses to call one reading a verdict', () => {
    const pooled = poolPair([reading(22, 8, 0.0161)], 'a', 'b');
    expect(pooled.verdict).toBe('one-run-only');
    expect(pooled.heterogeneityP).toBe(1);
  });

  /**
   * A dev-split table reads one run, and every row of it used to say `one-run-only` — including the
   * rows whose single reading was 37/39 and 75/61. `one-run-only` is the label for an effect one run
   * found and the pool could not keep; a reading that found nothing is `none`, and printing the
   * first for the second made the dev table read as though it had findings in three pairs when it
   * had none.
   */
  it('calls a single reading that found nothing nothing, not an effect one run found', () => {
    expect(poolPair([observed(75, 61)], 'a', 'b').verdict).toBe('none');
    expect(poolPair([observed(37, 39)], 'a', 'b').verdict).toBe('none');
    expect(poolPair([observed(40, 5)], 'a', 'b').verdict).toBe('one-run-only');
  });

  it('says a pair with no discordant case anywhere has nothing to pool', () => {
    const pooled = poolPair([reading(0, 0)], 'a', 'b');
    expect(pooled.problems).toHaveLength(1);
    expect(pooled.problems[0]).toContain('nothing to pool');
    expect(pooled.pooledPp).toBe(0);
  });

  /**
   * The interval has to be an interval for the estimate that is printed. Two readings of +11.09 and
   * −11.09pp on 65 discordant cases each are compatible with a pooled 0 and with nothing else: a
   * fixed-effect interval is ±2.1pp, which is narrower than either reading is from the mean, and it
   * claimed a precision the readings contradict in the same paragraph that said they contradict it.
   */
  it('widens the interval when the readings disagree by more than their sampling error', () => {
    const pooled = poolPair([reading(60, 5, 0.0001), reading(5, 60, 0.0001)], 'a', 'b');
    expect(pooled.tauSquaredPp2).toBeCloseTo(243.3, 1);
    expect(pooled.pooledIntervalPp).toBeCloseTo(21.73, 1);
    expect(pooled.pooledPp).toBe(0);
  });

  it('leaves a compatible pool exactly where the fixed-effect estimator put it', () => {
    const pooled = poolPair([reading(22, 8, 0.0161), reading(19, 18)], 'a', 'b');
    expect(pooled.tauSquaredPp2).toBe(0);
    expect(pooled.pooledIntervalPp).toBe(1.61);
  });

  /**
   * The invariant the pre-test buys, stated as a property rather than as five constants: a widened
   * interval is a *different estimator*, so a reader who sees ±0.87 next to `heterogeneous` is
   * entitled to know the label and the number agree about whether the readings are one number.
   *
   * Two labels say the readings are not one number: `heterogeneous` (they disagree about the size)
   * and `sign-flip` (they disagree about the direction, and both directions cleared their own test).
   * A reversal is a kind of heterogeneity, so it carries the widened interval too.
   */
  it('widens the interval exactly when the label says the readings are not one number', () => {
    const cases: [number, number][][] = [
      [[22, 8], [19, 18]],
      [[13, 13], [22, 8], [19, 18]],
      [[60, 5], [5, 60]],
      [[31, 18], [28, 15], [32, 15]],
      [[40, 5], [38, 6]],
      [[17, 18], [18, 15]],
      [[27, 26], [18, 34]],
    ];
    for (const cells of cases) {
      const pooled = poolPair(cells.map(([wins, losses]) => observed(wins, losses)), 'a', 'b');
      expect(pooled.tauSquaredPp2 > 0).toBe(pooled.verdict === 'heterogeneous' || pooled.verdict === 'sign-flip');
    }
  });

  it('calls readings that disagree beyond their intervals heterogeneous', () => {
    // Same direction, different sizes: +11.09pp and +4.03pp, Q p = 0.001. Nothing reversed, so the
    // label is the plain one — `heterogeneous` is the disagreement that is not a reversal.
    const pooled = poolPair([reading(60, 5, 0.0001), reading(30, 10, 0.0018)], 'a', 'b');
    expect(pooled.verdict).toBe('heterogeneous');
    expect(pooled.tauSquaredPp2).toBeGreaterThan(0);
  });

  it('prints each reading, the pooled line and what the readings do to each other', () => {
    const text = pooledLines([poolPair([reading(22, 8, 0.0161), reading(19, 18)], 'a', 'b')]).join('\n');
    expect(text).toContain('a -> b');
    expect(text).toContain('+2.82pp');
    expect(text).toContain('pooled');
    expect(text).toContain('established');
    expect(text).toContain('1 of 2 readings significant, Q p = 0.112 — the readings differ no more than their own intervals');
    expect(text).toContain('a single reading is not a result');
  });

  /**
   * The three real readings of `inline+evidence -> select`: 13/13, 22/8, 19/18. Pooling the last two
   * gives +1.65pp and calls the pair `established`; pooling all three gives +1.01pp and calls it
   * `one-run-only`, because the pool no longer clears zero once the third reading is in.
   *
   * This case used to be *the* example of a verdict changing with the number of readings: at three
   * readings it was labelled `heterogeneous` on Q p = 0.043, and the 1.26pp interval printed beside
   * that label was widened to 1.81pp by DerSimonian–Laird. Both of those numbers were artefacts of
   * referring Q to one degree of freedom. With two — which is what Q has at k = 3 — the readings are
   * compatible (p = 0.13), τ² is zero, the interval is the fixed-effect one, and the label is the
   * pool's own verdict. The test now pins the corrected behaviour and records what it replaced.
   */
  it('pools a third reading, and the verdict changes when it does', () => {
    const two = poolPair([reading(22, 8, 0.0161), reading(19, 18)], 'a', 'b');
    const three = poolPair([reading(13, 13), reading(22, 8, 0.0161), reading(19, 18)], 'a', 'b');
    expect(two.verdict).toBe('established');
    expect(three.verdict).toBe('one-run-only');
    expect(three.readings).toHaveLength(3);
    expect(three.pooledPp).toBe(1.01);
    expect(three.pooledIntervalPp).toBe(1.26);
    expect(three.heterogeneityP).toBeGreaterThan(0.05);
    expect(three.tauSquaredPp2).toBe(0);
  });

  it('says the readings differ by more than their own intervals when they do', () => {
    // The line used to print `→ heterogeneous, readings agree`: the label and the tail of the same
    // sentence contradicting each other, and the tail is the half a reader skims. A same-direction
    // disagreement is `heterogeneous`; the reversal beside it is `sign-flip`, and both are widened.
    const text = pooledLines([poolPair([reading(60, 5, 0.0001), reading(30, 10, 0.0018)], 'a', 'b')]).join('\n');
    expect(text).toContain('heterogeneous');
    expect(text).toContain('2 of 2 readings significant, Q p = 0.001 — the readings differ by more than their own intervals');
    expect(text).toContain('(random effects, DerSimonian–Laird)');
  });

  it('calls a reversal sign-flip and widens its interval, because a reversal is not a number either', () => {
    const text = pooledLines([poolPair([reading(60, 5, 0.0001), reading(5, 60, 0.0001)], 'a', 'b')]).join('\n');
    expect(text).toContain('± 21.74 (95%), p ≈ 1.000 → sign-flip');
    expect(text).toContain('(random effects, DerSimonian–Laird)');
  });

  it('says a pair is compatible when the chi-square test cannot reject', () => {
    const text = pooledLines([poolPair([reading(13, 13), reading(22, 8, 0.0161), reading(19, 18)], 'a', 'b')]).join('\n');
    expect(text).toContain('1 of 3 readings significant, Q p = 0.130 — the readings differ no more than their own intervals');
  });

  it('does not let a single reading borrow the language of a comparison', () => {
    const text = pooledLines([poolPair([reading(22, 8, 0.0161)], 'a', 'b')]).join('\n');
    expect(text).toContain('1 reading, and one reading is not a result');
    expect(text).not.toContain('readings significant');
  });

  it('says nothing about agreement when there is no reading to agree with', () => {
    const text = pooledLines([poolPair([reading(0, 0)], 'a', 'b')]).join('\n');
    expect(text).toContain('FAILED');
    expect(text).not.toContain('readings significant');
    expect(text).not.toContain('1 reading');
  });

  it('names the artifacts it was given that did not read this pair', () => {    const text = pooledLines([poolPair([reading(22, 8, 0.0161), reading(19, 18)], 'a', 'b')], ['c.json']).join('\n');
    expect(text).toContain('c.json did not score both arms, so it is not one of the readings');
  });

  it('says nothing about artifacts when every one of them read the pair', () => {
    const text = pooledLines([poolPair([reading(22, 8, 0.0161), reading(19, 18)], 'a', 'b')], []).join('\n');
    expect(text).not.toContain('did not score both arms');
  });

  it('prints nothing when there is no pair to pool', () => {
    expect(pooledLines([])).toEqual(['']);
  });

  it('fails the command when the pair it was asked to pool shares no question', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compare-nopair-'));
    const path = join(dir, 'a.json');
    writeFileSync(
      path,
      JSON.stringify({
        arms: [
          { arm: 'x', passed: 1, total: 2 },
          { arm: 'y', passed: 1, total: 2 },
        ],
        cases: [
          { arm: 'x', id: 1, passed: true },
          { arm: 'y', id: 2, passed: true },
        ],
      }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main([path, path, '--pair', 'x,y'], dir)).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  it('prints a failure beside a pair it could not pool', () => {
    expect(pooledLines([poolPair([reading(0, 0)], 'a', 'b')]).join('\n')).toContain('FAILED');
  });

  it('prints that failure once, because a problem printed twice reads as two problems', () => {
    const lines = pooledLines([poolPair([reading(0, 0)], 'a', 'b')]);
    expect(lines.filter((line) => line.includes('FAILED'))).toHaveLength(1);
  });

  it('prints every distinct failure, when a pair carries more than one', () => {
    const pooled = { ...poolPair([reading(22, 8, 0.0161), reading(19, 18)], 'a', 'b'), problems: ['first', 'second'] };
    const lines = pooledLines([pooled]);
    expect(lines.filter((line) => line.includes('FAILED'))).toEqual(['      FAILED first', '      FAILED second']);
  });
});

describe('reading one pair out of one artifact', () => {
  const artifact: RunArtifact = {
    cases: [
      { arm: 'x', id: 1, passed: true },
      { arm: 'x', id: 2, passed: true },
      { arm: 'y', id: 1, passed: false },
      { arm: 'y', id: 2, passed: true },
    ],
  };

  it('reads the counts the pair produced', () => {
    // `x` is right on both, `y` on one: the left arm loses one case and wins none.
    expect(readPairOf(artifact, 'run.json', 'x', 'y')).toMatchObject({ artifact: 'run.json', examined: 2, wins: 0, losses: 1, deltaPp: -50 });
  });

  it('reports a zero delta for a pair whose arms share no question', () => {
    const disjoint: RunArtifact = {
      cases: [
        { arm: 'x', id: 1, passed: true },
        { arm: 'y', id: 2, passed: true },
      ],
    };
    expect(readPairOf(disjoint, 'run.json', 'x', 'y')).toMatchObject({ examined: 0, deltaPp: 0 });
  });

  it('returns nothing when the artifact did not score both arms', () => {
    expect(readPairOf(artifact, 'run.json', 'x', 'missing')).toBeUndefined();
    expect(readPairOf({}, 'run.json', 'x', 'y')).toBeUndefined();
  });
});

describe('the pair flag', () => {
  it('is off unless asked for', () => {
    expect(resolveCompareSettings(['a.json', 'b.json'], '/root')).toEqual({ left: '/root/a.json', right: '/root/b.json', also: [] });
  });

  it('keeps every further path as a reading of the pair', () => {
    expect(resolveCompareSettings(['a.json', 'b.json', 'c.json', 'd.json'], '/root')).toEqual({
      left: '/root/a.json',
      right: '/root/b.json',
      also: ['/root/c.json', '/root/d.json'],
    });
  });

  it('takes two names', () => {
    expect(resolveCompareSettings(['a.json', 'b.json', '--pair', ' x , y '], '/root')).toMatchObject({ pair: ['x', 'y'] });
  });

  it('refuses one name or an empty one', () => {
    expect(() => resolveCompareSettings(['a.json', 'b.json', '--pair', 'x'], '/root')).toThrow('two arm names');
    expect(() => resolveCompareSettings(['a.json', 'b.json', '--pair'], '/root')).toThrow('two arm names');
  });

  it('still refuses a flag it does not know', () => {
    expect(() => resolveCompareSettings(['a.json', 'b.json', '--strict'], '/root')).toThrow('unrecognized argument --strict');
  });

  it('pools the pair across the two artifacts it was pointed at', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compare-pair-'));
    const write = (name: string, xRight: number[]): string => {
      const path = join(dir, name);
      writeFileSync(
        path,
        JSON.stringify({
          split: 'minidev',
          arms: [
            { arm: 'x', passed: 496 - xRight.length, total: 496 },
            { arm: 'y', passed: 496 - xRight.length, total: 496 },
          ],
          cases: [
            ...Array.from({ length: 496 }, (_, index) => ({ arm: 'x', id: index, passed: true })),
            ...Array.from({ length: 496 }, (_, index) => ({ arm: 'y', id: index, passed: !xRight.includes(index) })),
          ],
        }),
      );
      return path;
    };
    const left = write('left.json', Array.from({ length: 20 }, (_, index) => index));
    const right = write('right.json', Array.from({ length: 20 }, (_, index) => index + 100));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main([left, right, '--pair', 'x,y'], dir)).toBe(0);
      const text = log.mock.calls.flat().join('\n');
      expect(text).toContain('the same pair read in every run that scored it');
      expect(text).toContain('pooled');
    } finally {
      log.mockRestore();
    }
  });

  /** A 496-case artifact where `x` misses `onlyRight` and `y` misses `onlyLeft`: wins and losses. */
  const writer = (dir: string): ((name: string, onlyRight: number[], onlyLeft: number[]) => string) => {
    return (name, onlyRight, onlyLeft) => {
      const path = join(dir, name);
      const wrongX = new Set(onlyRight);
      const wrongY = new Set(onlyLeft);
      writeFileSync(
        path,
        JSON.stringify({
          split: 'minidev',
          arms: [
            { arm: 'x', passed: 496 - wrongX.size, total: 496 },
            { arm: 'y', passed: 496 - wrongY.size, total: 496 },
          ],
          cases: [
            ...Array.from({ length: 496 }, (_, id) => ({ arm: 'x', id, passed: !wrongX.has(id) })),
            ...Array.from({ length: 496 }, (_, id) => ({ arm: 'y', id, passed: !wrongY.has(id) })),
          ],
        }),
      );
      return path;
    };
  };
  const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, index) => from + index);

  it('pools every artifact it is pointed at, not just the two it compares', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compare-three-'));
    const write = writer(dir);
    const a = write('a.json', range(0, 13), range(100, 13));
    const b = write('b.json', range(0, 22), range(100, 8));
    const c = write('c.json', range(0, 19), range(100, 18));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main([a, b, c, '--pair', 'x,y'], dir)).toBe(0);
      const text = log.mock.calls.flat().join('\n');
      expect(text).toContain('the comparison above is the first two paths');
      expect(text).toContain('+2.82pp');
      expect(text).toContain('+0.20pp');
      expect(text).toContain('+1.01pp');
      // `one-run-only`, not `heterogeneous`: with Q referred to two degrees of freedom the three
      // readings are compatible, and the pool stops clearing zero once the tie is in it.
      expect(text).toContain('one-run-only');
    } finally {
      log.mockRestore();
    }
  });

  it('reads the pair in the artifacts that scored it and names the ones that did not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compare-partial-'));
    const write = writer(dir);
    const a = write('a.json', range(0, 22), range(100, 8));
    const b = write('b.json', range(0, 19), range(100, 18));
    const quiet = join(dir, 'quiet.json');
    writeFileSync(quiet, JSON.stringify({ split: 'minidev', arms: [{ arm: 'z', passed: 1, total: 1 }], cases: [{ arm: 'z', id: 0, passed: true }] }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main([a, b, quiet, '--pair', 'x,y'], dir)).toBe(0);
      const text = log.mock.calls.flat().join('\n');
      expect(text).toContain('quiet.json did not score both arms, so it is not one of the readings');
      expect(text).toContain('+1.65pp');
    } finally {
      log.mockRestore();
    }
  });
});

/**
 * One arm, two generators, and the questions both of them answered.
 *
 * This is the reading a cheaper experiment produces, and it is the only reading that is *not* a
 * comparison of two samples. `displacement` says a delta between two runs carries both draws'
 * uncertainty — at 496 questions that is ±6.2pp — and it says so because the two runs need not have
 * scored the same questions. A model comparison never scores the same questions twice: a reasoning
 * model at 18 seconds a case cannot afford 496 of them, and `BIRD_LIMIT` has to cut the sample. The
 * cut is what makes the pair possible as well as cheap, because the anchor already holds a verdict
 * for every question the subset contains.
 *
 * So the counts below are deliberately *not* the artifacts' own totals. A tool that read the totals
 * would report 4/6 against 3/3 where the pair is 2/3 against 3/3, and the 16.7pp it printed would be
 * a difference between two populations wearing the name of a difference between two models.
 */
describe('crossPair', () => {
  const cases = (...rows: [string, number, boolean][]): RunArtifact['cases'] =>
    rows.map(([arm, id, passed]) => ({ arm, id, passed }));

  it('reads both rates on the questions the two artifacts share, not on their own totals', () => {
    const full = {
      arms: [{ arm: 'metadata+evidence', passed: 4, total: 6 }],
      cases: cases(
        ['metadata+evidence', 1, true],
        ['metadata+evidence', 2, true],
        ['metadata+evidence', 3, false],
        ['metadata+evidence', 4, false],
        ['metadata+evidence', 5, true],
        ['metadata+evidence', 6, true],
      ),
    };
    const subset = {
      arms: [{ arm: 'metadata+evidence', passed: 3, total: 3 }],
      cases: cases(['metadata+evidence', 1, false], ['metadata+evidence', 2, true], ['metadata+evidence', 3, true]),
    };
    const reading = crossPair(full, subset, 'metadata+evidence');
    // Two of the three shared questions, not four of six: the subset has no row for 4, 5 or 6.
    expect(reading?.examined).toBe(3);
    expect(reading?.leftPassed).toBe(2);
    expect(reading?.rightPassed).toBe(2);
    expect(reading?.leftRate).toBeCloseTo(2 / 3, 6);
    expect(reading?.rightRate).toBeCloseTo(2 / 3, 6);
    expect(reading?.deltaPp).toBe(0);
    expect(reading?.up).toBe(1);
    expect(reading?.down).toBe(1);
  });

  it('tests the flips with McNemar, and a pair that never flips is not evidence', () => {
    const same = {
      arms: [{ arm: 'a', passed: 3, total: 3 }],
      cases: cases(['a', 1, true], ['a', 2, true], ['a', 3, true]),
    };
    const alsoSame = { ...same };
    const quiet = crossPair(same, alsoSame, 'a');
    expect(quiet?.up).toBe(0);
    expect(quiet?.down).toBe(0);
    // Not zero: a test that finds nothing is p = 1, and printing 0 makes "no difference" read as
    // "certainly no difference".
    expect(quiet?.p).toBe(1);
    expect(quiet?.readable).toBe(false);
    // Eight flips one way and none the other is 2 × 2^-8, the smallest p eight cases can produce.
    const eight = { cases: cases(...(Array.from({ length: 8 }, (_, index) => ['a', index + 1, false] as [string, number, boolean]))) };
    const swept = { cases: cases(...(Array.from({ length: 8 }, (_, index) => ['a', index + 1, true] as [string, number, boolean]))) };
    const loud = crossPair(eight, swept, 'a');
    expect(loud?.up).toBe(8);
    expect(loud?.p).toBeCloseTo(0.0078, 4);
    expect(loud?.readable).toBe(true);
    expect(loud?.deltaPp).toBeCloseTo(100, 6);
  });

  it('refuses an arm one side never scored rather than inventing a reading for it', () => {
    expect(crossPair({ cases: cases(['a', 1, true]) }, { cases: cases(['b', 1, true]) }, 'a')).toBeUndefined();
    expect(crossPair({ cases:cases(['a', 1, true]) }, { cases: cases(['a', 1, true]) }, 'b')).toBeUndefined();
  });

  it('states the interval the pair has to clear, and it is narrower than the two-sample one', () => {
    const rows = (passed: boolean[]): RunArtifact['cases'] => cases(...passed.map((value, index) => ['a', index + 1, value] as [string, number, boolean]));
    // 100 shared questions, 12 flips one way and 2 the other.
    const left = [...Array.from({ length: 50 }, () => true), ...Array.from({ length: 50 }, () => false)];
    const right = [...Array.from({ length: 50 }, () => true), ...Array.from({ length: 50 }, () => false)];
    for (let index = 0; index < 12; index += 1) right[50 + index] = true;
    for (let index = 0; index < 2; index += 1) right[index] = false;
    const reading = crossPair({ cases: rows(left.concat()) }, { cases: rows(right) }, 'a');
    expect(reading?.examined).toBe(100);
    expect(reading?.up).toBe(12);
    expect(reading?.down).toBe(2);
    // Paired: the questions' own difficulty cancels, so the interval is built from the ten flips
    // rather than from both rates' uncertainty.
    expect(reading?.intervalPp).toBeLessThan(crossRunIntervalPp(50, 100, 60, 100));
  });

  it('lists every arm both sides scored, largest move first', () => {
    const pairs = crossPairs(
      {
        cases: cases(
          ['big', 1, false],
          ['big', 2, false],
          ['big', 3, false],
          ['big', 4, false],
          ['small', 1, true],
          ['small', 2, true],
          ['small', 3, false],
          ['small', 4, false],
        ),
      },
      {
        cases: cases(
          ['big', 1, true],
          ['big', 2, true],
          ['big', 3, true],
          ['big', 4, true],
          ['small', 1, true],
          ['small', 2, true],
          ['small', 3, true],
          ['small', 4, false],
        ),
      },
    );
    expect(pairs.map((row) => row.arm)).toEqual(['big', 'small']);
    expect(pairs[0]?.deltaPp).toBeCloseTo(100, 6);
    expect(pairs[1]?.deltaPp).toBeCloseTo(25, 6);
  });

  it('prints the restricted sample size, because a rate without it reads as the split', () => {
    const lines = crossLines([
      {
        arm: 'metadata+evidence',
        examined: 150,
        leftPassed: 87,
        rightPassed: 104,
        leftRate: 0.58,
        rightRate: 104 / 150,
        deltaPp: 11.33,
        up: 32,
        down: 15,
        p: 0.0193,
        intervalPp: 7.69,
        readable: true,
      },
    ]);
    const text = lines.join('\n');
    expect(text).toContain('metadata+evidence');
    expect(text).toContain('150');
    expect(text).toContain('58.00%');
    expect(text).toContain('+11.33');
    expect(text).toContain('32');
    expect(text).toContain('15');
    expect(text).toContain('0.0193');
    expect(text).toMatch(/outside|inside/);
  });

  it('says nothing rather than a header when no arm was scored twice', () => {
    expect(crossLines([])).toEqual([]);
  });

  it('says a pair that never moved is the draw, and does not leave the table to imply it', () => {
    const lines = crossLines([
      {
        arm: 'a',
        examined: 150,
        leftPassed: 87,
        rightPassed: 89,
        leftRate: 0.58,
        rightRate: 89 / 150,
        deltaPp: 1.33,
        up: 9,
        down: 7,
        p: 0.8036,
        intervalPp: 5.13,
        readable: false,
      },
    ]);
    expect(lines.join('\n')).toContain('no pair moved outside its own interval');
  });

  it('gives an interval of zero to a pair with nothing examined, rather than dividing by it', () => {
    expect(pairedIntervalPp(0, 0, 0)).toBe(0);
  });

  it('builds the interval from the flips, so a balanced pair is the least determined one', () => {
    // Sixteen flips split eight and eight: the difference is zero and the interval is the widest a
    // sixteen-flip pair can have, because the correction term `(b − c)²/n` — the part of the
    // imbalance the flips already determine — is at its minimum. Sixteen flips one way is the same
    // number of discordant cases with slightly less uncertainty, and neither is the two-sample
    // interval for two rates near 0.58 at this sample size, which is ±11.2pp.
    expect(pairedIntervalPp(8, 8, 100)).toBeCloseTo(7.84, 2);
    expect(pairedIntervalPp(16, 0, 100)).toBeCloseTo(7.19, 2);
    expect(pairedIntervalPp(8, 8, 100)).toBeGreaterThan(pairedIntervalPp(16, 0, 100));
    expect(pairedIntervalPp(16, 0, 100)).toBeLessThan(crossRunIntervalPp(58, 100, 74, 100));
  });
});
