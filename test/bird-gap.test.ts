/**
 * The no-answer diagnosis, driven through its entry points.
 *
 * The fixture is shaped like the artifact a real dev run writes — a `cases` array holding one
 * row per (arm, question), an `arms` array that states which arms publish a ceiling, and a
 * `failures` map capped below the number of failures. The cap is the part worth reproducing:
 * the tool's honesty depends on counting what it could not read, and a fixture with no cap
 * would have let a bug in that count pass.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyGapCase,
  gapArtifact,
  gapLines,
  gapPath,
  gapProblems,
  gapTable,
  isEntry,
  main,
  resolveGapSettings,
  runGap,
  samplingArms,
  subItemBuckets,
  writeGapArtifact,
} from '../eval/bird/gap.js';
import type { CaseRecord, GapReportShape } from '../eval/bird/gap.js';

const ROOT = process.cwd();

/** A scored question the candidate set answered, so the arm has both kinds of row. */
const hit = (arm: string, id: string): CaseRecord => ({ arm, id, passed: true, reason: 'match', candidateRecall: true });

/** A question no candidate answered, in one of the three shapes the artifact can tell. */
const miss = (arm: string, id: string, extra: Partial<CaseRecord> = {}): CaseRecord => ({
  arm,
  id,
  passed: false,
  reason: 'values',
  candidateRecall: false,
  ...extra,
});

function report(cases: readonly CaseRecord[]): GapReportShape {
  return {
    split: 'dev',
    model: 'deepseek-chat',
    arms: [
      { arm: 'select-cross', candidateRecall: 5 },
      { arm: 'names' },
    ],
    cases,
    failures: { 'select-cross': [{ id: '1' }, { id: '2' }] },
  };
}

describe('classifying one case', () => {
  it('reads an error as the engine refusing the statement, before any shape', () => {
    // A case cannot be both: the error means the statement never produced rows, so the
    // shape it might have had is not observable.
    expect(classifyGapCase({ reason: 'values', errorKind: 'other' })).toBe('engine-refused');
    expect(classifyGapCase({ reason: 'column-count', error: 'near "form": syntax error' })).toBe('engine-refused');
  });

  it('reads a width mismatch as grain rather than values', () => {
    expect(classifyGapCase({ reason: 'column-count' })).toBe('column-count');
  });

  it('reads a matched width with wrong numbers as values', () => {
    expect(classifyGapCase({ reason: 'values' })).toBe('values');
  });

  it('says unclassified rather than guessing, for a reason it does not know', () => {
    expect(classifyGapCase({ reason: 'match' })).toBe('unclassified');
    expect(classifyGapCase({})).toBe('unclassified');
  });

  it('treats a blank error as absent, because the artifact writes empty strings', () => {
    expect(classifyGapCase({ reason: 'values', errorKind: '   ', error: '' })).toBe('values');
  });
});

describe('which arms have a ceiling', () => {
  it('reads the arm list, not the cases', () => {
    // `names` generates one statement, so it never writes `candidateRecall`; deriving the
    // list from the cases would still be empty for it and would silently skip a sampling
    // arm whose cases were all dropped.
    expect(samplingArms(report([]))).toEqual(['select-cross']);
  });
});

describe('the per-arm buckets', () => {
  const cases = [
    hit('select-cross', '0'),
    miss('select-cross', '1'),
    miss('select-cross', '2', { reason: 'column-count' }),
    miss('select-cross', '3', { errorKind: 'other', error: 'no such column: x' }),
    miss('select-cross', '4', { reason: 'match' }),
    miss('names', '5'),
  ];

  it('counts every no-answer case into exactly one bucket', () => {
    const [arm] = gapTable({ ...report(cases), arms: [{ arm: 'select-cross', candidateRecall: 1 }] });
    expect(arm?.noAnswer).toBe(4);
    expect(arm?.scored).toBe(5);
    expect(arm?.buckets).toEqual({ 'engine-refused': 1, 'column-count': 1, values: 1, unclassified: 1 });
  });

  it('separates a named bucket from a gap, and says which share is which', () => {
    const [arm] = gapTable({ ...report(cases), arms: [{ arm: 'select-cross', candidateRecall: 1 }] });
    expect(arm?.classified).toBe(3);
    expect(arm?.coverage).toBeCloseTo(0.75, 6);
  });

  it('counts the statements the failure cap kept, because only those can be diagnosed', () => {
    const [arm] = gapTable({ ...report(cases), arms: [{ arm: 'select-cross', candidateRecall: 1 }] });
    // Two ids are in `failures.select-cross`; three of the four misses are not.
    expect(arm?.retained).toBe(2);
  });

  it('diagnoses an arm the failure list never mentions, and reports zero retained', () => {
    // A report whose `failures` map omits the arm entirely: the cap kept nothing, which is a
    // fact about the artifact and not a reason to throw.
    const rows = gapTable({ ...report([]), arms: [{ arm: 'vote', candidateRecall: 0 }], cases: [miss('vote', '1')], failures: {} });
    expect(rows[0]?.noAnswer).toBe(1);
    expect(rows[0]?.retained).toBe(0);
  });

  it('treats a report with no cases array as an arm that answered nothing', () => {
    const rows = gapTable({ arms: [{ arm: 'select-cross', candidateRecall: 0 }] });
    expect(rows[0]?.noAnswer).toBe(0);
    expect(rows[0]?.scored).toBe(0);
  });

  it('reports a fully-solved arm as covered rather than dividing by zero', () => {
    const [arm] = gapTable({ ...report([hit('select-cross', '0')]), arms: [{ arm: 'select-cross', candidateRecall: 1 }] });
    expect(arm?.noAnswer).toBe(0);
    expect(arm?.coverage).toBe(1);
  });
});

describe('what makes the table unpublishable', () => {
  const arm = (overrides: Partial<Parameters<typeof gapProblems>[0][number]>) => ({
    arm: 'select-cross',
    noAnswer: 100,
    scored: 500,
    buckets: { 'engine-refused': 0, 'column-count': 0, values: 100, unclassified: 0 },
    retained: 50,
    classified: 100,
    coverage: 1,
    ...overrides,
  });

  it('refuses an artifact whose arms publish no ceiling, instead of reporting 0 of 0 as complete', () => {
    expect(gapProblems([])).toEqual([
      'GAP: no arm in this artifact publishes a candidate ceiling, so there is nothing to diagnose',
    ]);
  });

  it('fails a classification that covers less than four fifths of the no-answer cases', () => {
    const problems = gapProblems([arm({ classified: 79, coverage: 0.79 })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('79 of 100');
    expect(problems[0]).toContain('80%');
  });

  it('passes at the boundary and above it', () => {
    expect(gapProblems([arm({ classified: 80, coverage: 0.8 })])).toEqual([]);
  });

  it('does not fail an arm that answered every question', () => {
    expect(gapProblems([arm({ noAnswer: 0, classified: 0, coverage: 0 })])).toEqual([]);
  });
});

describe('which buckets are wide enough to be an iteration', () => {
  const arm = (values: number, noAnswer = 100, unclassified = 0) => ({
    arm: 'select-cross',
    noAnswer,
    scored: 500,
    buckets: { 'engine-refused': 0, 'column-count': 0, values, unclassified } as const,
    retained: 0,
    classified: noAnswer - unclassified,
    coverage: (noAnswer - unclassified) / noAnswer,
  });

  it('applies the threshold as a share of the no-answer set, strictly', () => {
    // 10 of 100 is exactly the threshold and not above it: the plan's wording is ">10%".
    expect(subItemBuckets([arm(10)])).toEqual([]);
    expect(subItemBuckets([arm(11)])).toHaveLength(1);
  });

  it('never proposes an unclassified bucket as work', () => {
    expect(subItemBuckets([arm(0, 100, 90)])).toEqual([]);
  });

  it('orders the buckets by size so the biggest lever is read first', () => {
    const wide = { ...arm(60, 100, 0), buckets: { 'engine-refused': 5, 'column-count': 35, values: 60, unclassified: 0 } };
    expect(subItemBuckets([wide]).map((item) => item.bucket)).toEqual(['values', 'column-count']);
  });

  it('skips an arm with nothing unanswered', () => {
    expect(subItemBuckets([arm(0, 0, 0)])).toEqual([]);
  });
});

describe('the artifact this writes', () => {
  const cases = [hit('select-cross', '0'), miss('select-cross', '1'), miss('select-cross', '2'), miss('select-cross', '3')];

  it('carries the split, the model and what the cap hid', () => {
    const arms = gapTable(report(cases));
    const artifact = gapArtifact(report(cases), arms);
    expect(artifact.split).toBe('dev');
    expect(artifact.model).toBe('deepseek-chat');
    expect(artifact.retained).toEqual({ total: 3, hidden: 1 });
  });

  it('names a report that does not say which split or model it came from', () => {
    const artifact = gapArtifact({ cases }, gapTable({ cases }));
    expect(artifact.split).toBe('unknown');
    expect(artifact.model).toBeNull();
  });
});

describe('the lines a reader sees', () => {
  it('prints the table, the cap cost and every bucket wide enough to act on', () => {
    const cases = [hit('select-cross', '0'), ...Array.from({ length: 12 }, (_, index) => miss('select-cross', String(index + 1)))];
    const artifact = gapArtifact(report(cases), gapTable(report(cases)));
    const lines = gapLines(artifact);
    expect(lines[0]).toContain('engine-refused');
    expect(lines[1]).toContain('select-cross');
    expect(lines.join('\n')).toContain('0 of 12 no-answer cases have no retained statement');
    expect(lines.join('\n')).toContain('values is 12 cases (100.0% of its no-answer set)');
  });

  it('omits the sub-item line when no bucket clears the threshold', () => {
    const cases = [hit('select-cross', '0'), miss('select-cross', '1', { reason: 'match' })];
    const artifact = gapArtifact(report(cases), gapTable(report(cases)));
    expect(gapLines(artifact).join('\n')).not.toContain('wide enough');
  });
});

describe('the entry, run the way a workflow runs it', () => {
  function written(body: GapReportShape): { root: string; report: string } {
    const root = mkdtempSync(join(tmpdir(), 'gap-'));
    const report = join(root, 'bird-eval.json');
    writeFileSync(report, JSON.stringify(body));
    return { root, report };
  }

  it('answers whether it is the program without depending on being run as one', () => {
    const own = new URL('../eval/bird/gap.ts', import.meta.url).href;
    expect(isEntry(new URL('../eval/bird/gap.ts', import.meta.url).pathname, own)).toBe(true);
    expect(isEntry(new URL('../eval/bird/losses.ts', import.meta.url).pathname, own)).toBe(false);
    expect(isEntry(undefined, own)).toBe(false);
  });

  it('resolves the report from the argument list and the output beside the run artifact', () => {
    const settings = resolveGapSettings([], ROOT);
    expect(settings.report).toBe(join(ROOT, 'eval/out/bird-eval.json'));
    expect(gapPath(settings)).toBe(join(ROOT, 'eval/out/bird-gap.json'));
  });

  it('aims at one arm, writes beside the chain table, and prints that arm alone', async () => {
    // The chain table has eleven rows; a reader looking for the arm that failed a gate had to
    // find the row themselves, which is not a diagnosis. `--arm` is the same flag the other
    // five instruments take.
    const { root, report: path } = written(
      report([hit('select-cross', '0'), miss('select-cross', '1'), hit('names', '2'), hit('names', '3')]),
    );
    const settings = resolveGapSettings([path, '--arm', 'select-cross'], root);
    expect(settings.arm).toBe('select-cross');
    expect(gapPath(settings)).toBe(join(root, 'eval/out/bird-gap-select-cross.json'));
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => printed.push(String(line)));
    try {
      expect(await main([path, '--arm', 'select-cross'], root)).toBe(0);
    } finally {
      log.mockRestore();
    }
    // One row, for the arm that was asked for: the other arm's row is gone rather than
    // sorted below it, which is the difference between aiming and scanning.
    expect(printed.some((line) => line.startsWith('select-cross'))).toBe(true);
    expect(printed.some((line) => line.startsWith('names'))).toBe(false);
  });

  it('refuses an arm the artifact never scored, naming the arms it does hold', () => {
    const { root, report: path } = written(report([hit('select-cross', '0')]));
    expect(() => runGap(resolveGapSettings([path, '--arm', 'select-mixed'], root))).toThrow(
      /has no arm select-mixed; it holds select-cross/,
    );
  });

  it('refuses an arm with no candidate ceiling, because it has no no-answer set', () => {
    // `names` was scored and publishes no `candidateRecall`: it generates one statement, so it
    // never had a candidate set to lose. An empty table would read as "no gaps found".
    const { root, report: path } = written(report([hit('names', '1')]));
    expect(() => runGap(resolveGapSettings([path, '--arm', 'names'], root))).toThrow(
      /names publishes no candidate ceiling .*the arms that do are select-cross/,
    );
  });

  it('refuses a flag with no name rather than diagnosing every arm', () => {
    expect(() => resolveGapSettings(['--arm'], ROOT)).toThrow(/--arm needs a name/);
  });

  it('reads the report path on either side of the flag, and defaults when there is none', () => {
    // `--arm sel eval/out/x.json` and `eval/out/x.json --arm sel` are the same request; the
    // path is whatever is left once the flag and its value are consumed.
    expect(resolveGapSettings(['--arm', 'select-cross', 'eval/out/x.json'], ROOT).report).toBe(join(ROOT, 'eval/out/x.json'));
    expect(resolveGapSettings(['eval/out/x.json', '--arm', 'select-cross'], ROOT).report).toBe(join(ROOT, 'eval/out/x.json'));
    expect(resolveGapSettings(['--arm', 'select-cross'], ROOT).report).toBe(join(ROOT, 'eval/out/bird-eval.json'));
  });

  it('refuses an arm when the artifact holds no ceiling at all, and says so once', () => {
    // No arm publishes a `candidateRecall`: there is no no-answer set anywhere, so naming one
    // arm cannot produce a table and the message must not claim the arm is the problem.
    const { root, report: path } = written({ split: 'dev', arms: [], cases: [hit('names', '1')] });
    expect(() => runGap(resolveGapSettings([path, '--arm', 'names'], root))).toThrow(
      /holds no arm with a candidate ceiling, so names has no no-answer set to diagnose/,
    );
  });

  it('writes the artifact where it says it will', () => {
    const { root, report: path } = written(report([hit('select-cross', '0'), miss('select-cross', '1')]));
    const settings = resolveGapSettings([path], root);
    const artifact = gapArtifact(JSON.parse(readFileSync(path, 'utf8')) as GapReportShape, gapTable(JSON.parse(readFileSync(path, 'utf8')) as GapReportShape));
    expect(writeGapArtifact(settings, artifact)).toBe(join(root, 'eval/out/bird-gap.json'));
    expect(JSON.parse(readFileSync(join(root, 'eval/out/bird-gap.json'), 'utf8'))).toMatchObject({ split: 'dev' });
  });

  it('runs end to end and exits zero on a classification that covers the set', async () => {
    const { root, report: path } = written(report([hit('select-cross', '0'), miss('select-cross', '1'), miss('select-cross', '2', { reason: 'column-count' })]));
    const outcome = runGap(resolveGapSettings([path], root));
    expect(outcome.problems).toEqual([]);
    expect(outcome.artifact.arms[0]?.coverage).toBe(1);
    expect(await main([path], root)).toBe(0);
  });

  it('writes the table into the step summary the review reads', async () => {
    const { root, report: path } = written(report([hit('select-cross', '0'), miss('select-cross', '1')]));
    const summary = join(root, 'summary.md');
    expect(await main([path], root, { GITHUB_STEP_SUMMARY: summary })).toBe(0);
    const text = readFileSync(summary, 'utf8');
    expect(text).toContain('Where the candidate set had no answer');
    expect(text).toContain('select-cross');
  });

  it('writes no summary when the step has none, which is how it runs locally', async () => {
    const { root, report: path } = written(report([hit('select-cross', '0'), miss('select-cross', '1')]));
    expect(await main([path], root, {})).toBe(0);
    expect(await main([path], root, { GITHUB_STEP_SUMMARY: '' })).toBe(0);
  });

  it('exits non-zero when the artifact cannot be classified', async () => {
    // Every case unclassified: the tool has nothing to say and must say that rather than
    // printing an empty table with exit zero.
    const cases = [miss('select-cross', '1', { reason: 'match' }), miss('select-cross', '2', { reason: 'match' })];
    const { root, report: path } = written(report(cases));
    expect(await main([path], root)).toBe(1);
  });
});
