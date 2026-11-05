import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  MATCH,
  isEntry,
  main,
  pairLines,
  pairOutcome,
  pairProblems,
  resolvePairSettings,
  shapeOf,
  summaries,
} from '../eval/bird/pair.js';
import type { PairArtifact, PairCase, PairOutcome } from '../eval/bird/pair.js';

const case_ = (arm: string, id: number, shape: string): PairCase =>
  shape === MATCH ? { arm, id, passed: true, reason: 'match' } : { arm, id, passed: false, reason: shape };

const artifact = (left: readonly string[], right: readonly string[]): PairArtifact => ({
  split: 'dev',
  model: 'deepseek-chat',
  cases: [...left.map((shape, index) => case_('a', index, shape)), ...right.map((shape, index) => case_('b', index, shape))],
});

describe('the shape a case was filed under', () => {
  it('calls a passing case a match, whatever the reason says', () => {
    expect(shapeOf({ arm: 'a', id: 1, passed: true, reason: 'values' })).toBe('match');
  });

  it('takes the reason of a failure, and refuses to read an absent reason as success', () => {
    // An absent reason is not a passing answer: this is the same distinction the cache meter
    // makes between a zero and a missing column, and it decides a whole row of the table.
    expect(shapeOf({ arm: 'a', id: 1, passed: false, reason: 'column-count' })).toBe('column-count');
    expect(shapeOf({ arm: 'a', id: 1, passed: false })).toBe('unclassified');
  });
});

describe('the paired reading', () => {
  it('counts the four cells, and takes the two discordant ones as the only informative pair', () => {
    const outcome = pairOutcome(artifact([MATCH, MATCH, 'values', 'values'], [MATCH, 'values', MATCH, 'values']), 'a', 'b');
    expect(outcome.examined).toBe(4);
    expect(outcome.both).toBe(1);
    expect(outcome.neither).toBe(1);
    expect(outcome.wins).toBe(1);
    expect(outcome.losses).toBe(1);
    expect(outcome.p).toBe(1);
    expect(outcome.problems).toEqual([]);
  });

  it('reports the transition, including the one that is not a repair', () => {
    // The reading this instrument exists for: `column-count -> values` is a failure that moved,
    // and it is invisible in an accuracy column.
    const outcome = pairOutcome(artifact(['column-count', 'values'], ['values', MATCH]), 'a', 'b');
    expect(outcome.transitions).toContainEqual({ from: 'column-count', to: 'values', cases: 1 });
    expect(outcome.transitions).toContainEqual({ from: 'values', to: 'match', cases: 1 });
    // Sorted by count, so the biggest movement is the first thing a reader sees.
    expect(outcome.transitions[0]?.cases).toBeGreaterThanOrEqual(outcome.transitions[1]?.cases ?? 0);
  });

  it('keeps a case that was scored twice at its later shape', () => {
    const report: PairArtifact = {
      cases: [
        { arm: 'a', id: 1, passed: false, reason: 'values' },
        { arm: 'a', id: 1, passed: true, reason: 'match' },
        { arm: 'b', id: 1, passed: true, reason: 'match' },
      ],
    };
    const outcome = pairOutcome(report, 'a', 'b');
    expect(outcome.examined).toBe(1);
    expect(outcome.both).toBe(1);
  });

  it('refuses an arm the artifact does not score, naming it', () => {
    const report = artifact([MATCH], [MATCH]);
    expect(() => pairOutcome(report, 'a', 'nope')).toThrow(/nope is not scored/);
    expect(() => pairOutcome(report, 'nope', 'b')).toThrow(/nope is not scored/);
  });

  it('lists the questions only one arm scored, and refuses to call the pair paired', () => {
    const report: PairArtifact = {
      cases: [
        { arm: 'a', id: 1, passed: true, reason: 'match' },
        { arm: 'a', id: 2, passed: true, reason: 'match' },
        { arm: 'b', id: 1, passed: true, reason: 'match' },
        { arm: 'b', id: 3, passed: true, reason: 'match' },
      ],
    };
    const outcome = pairOutcome(report, 'a', 'b');
    expect(outcome.examined).toBe(1);
    expect(outcome.unpaired).toEqual(['2', '3']);
    expect(outcome.problems.join('\n')).toMatch(/2 question\(s\) are scored by one arm and not the other/);
  });

  it('reads an artifact with no cases at all as an arm that is not scored, not as a tie', () => {
    expect(() => pairOutcome({}, 'a', 'b')).toThrow(/a is not scored/);
    expect(() => pairOutcome({ cases: [] }, 'a', 'b')).toThrow(/a is not scored/);
  });
});

describe('what makes a pair unreadable', () => {
  it('says so when the two arms share no question', () => {
    const problems = pairProblems({ left: 'a', right: 'b', shared: 0, unpaired: [] });
    expect(problems).toEqual(['the two arms share no question, so a and b cannot be compared']);
  });

  it('says nothing when the pair is complete', () => {
    expect(pairProblems({ left: 'a', right: 'b', shared: 10, unpaired: [] })).toEqual([]);
  });
});

describe('the per-arm totals', () => {
  it('prints both arms, each shape in descending count with ties broken by name', () => {
    const rows = summaries(
      [case_('a', 1, MATCH), case_('a', 2, 'values'), case_('a', 3, 'values'), case_('a', 4, 'column-count'), case_('b', 1, MATCH)],
      ['a', 'b'],
    );
    expect(rows).toEqual([
      { arm: 'a', shape: 'values', cases: 2 },
      { arm: 'a', shape: 'column-count', cases: 1 },
      { arm: 'a', shape: 'match', cases: 1 },
      { arm: 'b', shape: 'match', cases: 1 },
    ]);
  });
});

describe('the printed reading', () => {
  const base = (over: Partial<PairOutcome>): PairOutcome => ({
    left: 'a',
    right: 'b',
    examined: 10,
    wins: 2,
    losses: 1,
    both: 5,
    neither: 2,
    p: 0.5,
    transitions: [],
    shapes: [],
    unpaired: [],
    problems: [],
    ...over,
  });

  it('says a pair with no movement failed in the same places, rather than printing an empty table', () => {
    const lines = pairLines(base({ transitions: [{ from: 'values', to: 'values', cases: 10 }] }));
    expect(lines.join('\n')).toContain('no case changed shape');
    // The diagonal is not a movement, so it is not printed as one either.
    expect(lines.join('\n')).not.toContain('values         -> values');
  });

  it('omits the share when there is no denominator rather than printing a ratio over nothing', () => {
    // A hand-built outcome is the only way to reach this: the table is built from the paired
    // cases, so a zero denominator cannot arrive with a transition attached.
    const lines = pairLines(base({ examined: 0, transitions: [{ from: 'values', to: 'match', cases: 1 }] }));
    expect(lines.join('\n')).toContain('  -  ');
  });
});

describe('the arguments', () => {
  it('reads the artifact and the pair', () => {
    const settings = resolvePairSettings(['eval/out/bird-eval.json', '--pair', 'a,b'], '/root');
    expect(settings).toEqual({ report: '/root/eval/out/bird-eval.json', left: 'a', right: 'b' });
  });

  it('refuses to run without a pair, with one name, or with an empty one', () => {
    expect(() => resolvePairSettings(['x.json'], '/root')).toThrow(/needs --pair/);
    expect(() => resolvePairSettings(['x.json', '--pair', 'a'], '/root')).toThrow(/two arm names/);
    expect(() => resolvePairSettings(['x.json', '--pair', 'a,'], '/root')).toThrow(/two arm names/);
    // A flag at the end of the command has no value at all, which is a different sentence from a
    // name that is empty, and both have to arrive as the same refusal rather than as a crash.
    expect(() => resolvePairSettings(['x.json', '--pair'], '/root')).toThrow(/two arm names/);
    expect(() => resolvePairSettings(['--pair', 'a,b'], '/root')).toThrow(/usage: pair.ts/);
  });

  it('trims the names, because a dispatch that pastes a space should not become a missing arm', () => {
    expect(resolvePairSettings(['x.json', '--pair', ' a , b '], '/root')).toMatchObject({ left: 'a', right: 'b' });
  });
});

describe('the entry point', () => {
  const run = (report: unknown, pair: string): { code: number; printed: string; errors: string[]; threw?: unknown } => {
    const dir = mkdtempSync(join(tmpdir(), 'pair-main-'));
    const file = join(dir, 'bird-eval.json');
    writeFileSync(file, JSON.stringify(report));
    const printed: string[] = [];
    const errors: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    const error = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      const code = main([file, '--pair', pair], dir);
      return { code, printed: printed.join('\n'), errors };
    } catch (thrown) {
      return { code: -1, printed: printed.join('\n'), errors, threw: thrown };
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  };

  it('names the split and the model it read, and exits zero on a readable pair', () => {
    const { code, printed } = run(artifact([MATCH, 'values'], ['values', MATCH]), 'a,b');
    expect(code).toBe(0);
    expect(printed).toContain('bird-eval.json (dev, deepseek-chat)');
    expect(printed).toContain('exact McNemar');
  });

  it('prints the artifact path alone when the artifact does not say which split it is', () => {
    const { printed } = run({ cases: [...artifact([MATCH], [MATCH]).cases as PairCase[]] }, 'a,b');
    expect(printed).toContain('  bird-eval.json\n');
    expect(printed).not.toContain('(dev');
  });

  it('prints the split without a model when the artifact carries one and not the other', () => {
    const report = { ...artifact([MATCH], [MATCH]), model: undefined };
    const { printed } = run(report, 'a,b');
    expect(printed).toContain('(dev)');
  });

  it('exits one on an unpaired artifact, and says which questions were unpaired', () => {
    const report = { cases: [{ arm: 'a', id: 1, passed: true, reason: 'match' }, { arm: 'b', id: 2, passed: true, reason: 'match' }] };
    const { code, errors } = run(report, 'a,b');
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('PAIR: the two arms share no question');
  });

  it('names a missing arm instead of reporting a pair of zeros', () => {
    const { threw } = run(artifact([MATCH], [MATCH]), 'a,nope');
    expect(String(threw)).toMatch(/nope is not scored/);
  });

  it('runs as a command, so the guard is not a branch only a reader believes in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pair-cli-'));
    const file = join(dir, 'bird-eval.json');
    writeFileSync(file, JSON.stringify(artifact([MATCH], [MATCH])));
    const out = execFileSync(join('node_modules', '.bin', 'tsx'), ['eval/bird/pair.ts', file, '--pair', 'a,b'], {
      cwd: join(import.meta.dirname, '..'),
      encoding: 'utf8',
    });
    expect(out).toContain('exact McNemar');
    expect(isEntry(undefined, import.meta.url)).toBe(false);
  });
});
