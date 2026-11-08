import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  MATCH,
  declaredLines,
  declaredPairs,
  isEntry,
  main,
  pairLines,
  pairOutcome,
  pairProblems,
  readDeclared,
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

/**
 * The declared pairs, which is the half that turns a one-off reading into a standing one.
 *
 * The pair instrument already refused to join two artifacts. What it did not do was say *which*
 * pairs a run owes, so the reading that got published was the one somebody happened to run — and
 * on the placement question that reading was taken across two runs and came out +3.6pp while a
 * single run puts it at 17 against 18. A declaration is what makes the owed reading the taken one.
 */
describe('declared pairs', () => {
  const root = (pairs: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'pair-declared-'));
    mkdirSync(join(dir, 'eval/baseline'), { recursive: true });
    writeFileSync(join(dir, 'eval/baseline/pairs.json'), JSON.stringify(pairs));
    return dir;
  };

  it('reads the pairs a split declares and leaves the other splits alone', () => {
    const dir = root({ minidev: [['a', 'b']], dev: [] });
    expect(declaredPairs(dir, 'minidev')).toEqual([['a', 'b']]);
    expect(declaredPairs(dir, 'dev')).toEqual([]);
    expect(declaredPairs(dir, 'train')).toEqual([]);
  });

  it('trims a name, because a declaration pasted with spaces is still a declaration', () => {
    expect(declaredPairs(root({ minidev: [[' a ', 'b ']] }), 'minidev')).toEqual([['a', 'b']]);
  });

  it('refuses a split entry that is not a list, and an entry that is not a pair', () => {
    expect(() => declaredPairs(root({ minidev: { a: 'b' } }), 'minidev')).toThrow('is not a list of pairs');
    expect(() => declaredPairs(root({ minidev: [['a']] }), 'minidev')).toThrow('is not a pair of arm names');
    expect(() => declaredPairs(root({ minidev: [['a', 'b', 'c']] }), 'minidev')).toThrow('is not a pair of arm names');
    expect(() => declaredPairs(root({ minidev: [['a', '']] }), 'minidev')).toThrow('is not a pair of arm names');
  });

  it('names the arms a run did not score instead of throwing on them', () => {
    const [reading] = readDeclared(artifact([MATCH], [MATCH]), [['a', 'gone']]);
    expect(reading?.missing).toEqual(['gone']);
    expect(reading?.outcome).toBeUndefined();
  });

  it('reads the pair it can read', () => {
    const [reading] = readDeclared(artifact([MATCH, 'values'], ['values', MATCH]), [['a', 'b']]);
    expect(reading?.outcome?.wins).toBe(1);
    expect(reading?.outcome?.losses).toBe(1);
  });

  it('prints one line per pair with the counts, the test and a verdict word', () => {
    const report = artifact([MATCH, 'values'], ['values', MATCH]);
    const lines = declaredLines(readDeclared(report, [['a', 'b']]), report).join('\n');
    expect(lines).toContain('paired readings · dev · deepseek-chat · 2 questions');
    expect(lines).toContain('a -> b');
    expect(lines).toContain('no difference');
    expect(lines).toContain('p = 1.0000');
  });

  it('says so when a declared pair was not scored, rather than printing a zero', () => {
    const report = artifact([MATCH], [MATCH]);
    const lines = declaredLines(readDeclared(report, [['a', 'gone']]), report).join('\n');
    expect(lines).toContain('not scored this run (gone)');
  });

  it('prints a separable rate as a delta with its p', () => {
    const left = [MATCH, MATCH, MATCH, MATCH, MATCH, MATCH, MATCH, MATCH];
    const right = ['values', 'values', 'values', 'values', 'values', 'values', 'values', 'values'];
    const report = artifact(left, right);
    const lines = declaredLines(readDeclared(report, [['a', 'b']]), report).join('\n');
    expect(lines).toContain('-100.00pp, separable at p = 0.0078');
  });

  it('names the base models the artifact was served by', () => {
    const report = { ...artifact([MATCH], [MATCH]), arms: [{ arm: 'a', servedModels: { 'deepseek-flash': 1 } }] };
    expect(declaredLines(readDeclared(report, [['a', 'b']]), report).join('\n')).toContain('served by deepseek-flash');
  });

  it('writes the reading beside the artifact rather than in the default directory', () => {
    const dir = root({ dev: [['a', 'b']] });
    const file = join(dir, 'bird-eval.json');
    writeFileSync(file, JSON.stringify(artifact([MATCH, 'values'], ['values', MATCH])));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main([file, '--declared'], dir)).toBe(0);
    } finally {
      log.mockRestore();
    }
    const written = JSON.parse(readFileSync(join(dir, 'bird-pairs.json'), 'utf8')) as {
      split: string;
      questions: number;
      pairs: { left: string; wins: number; losses: number }[];
    };
    expect(written.split).toBe('dev');
    expect(written.questions).toBe(2);
    expect(written.pairs[0]).toMatchObject({ left: 'a', wins: 1, losses: 1 });
  });

  it('records a missing arm in the file rather than dropping the pair', () => {
    const dir = root({ dev: [['a', 'gone']] });
    const file = join(dir, 'bird-eval.json');
    writeFileSync(file, JSON.stringify(artifact([MATCH], [MATCH])));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main([file, '--declared'], dir)).toBe(0);
    } finally {
      log.mockRestore();
    }
    const written = JSON.parse(readFileSync(join(dir, 'bird-pairs.json'), 'utf8')) as { pairs: { missing?: string[] }[] };
    expect(written.pairs[0]?.missing).toEqual(['gone']);
  });

  it('says a split declares nothing rather than inventing a pair for it', () => {
    const dir = root({ dev: [] });
    const file = join(dir, 'bird-eval.json');
    writeFileSync(file, JSON.stringify(artifact([MATCH], [MATCH])));
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    try {
      expect(main([file, '--declared'], dir)).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(printed.join('\n')).toContain('no pair is declared for dev');
  });

  it('fails the reading when a declared pair shares no question', () => {
    const dir = root({ dev: [['a', 'b']] });
    const file = join(dir, 'bird-eval.json');
    const report: PairArtifact = {
      split: 'dev',
      cases: [
        { arm: 'a', id: 1, passed: true },
        { arm: 'b', id: 2, passed: true },
      ],
    };
    writeFileSync(file, JSON.stringify(report));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(main([file, '--declared'], dir)).toBe(1);
      expect(error.mock.calls.flat().join('\n')).toContain('PAIR: the two arms share no question');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('renders an artifact that names neither split nor model, and one with no cases', () => {
    const lines = declaredLines(readDeclared({}, [['a', 'b']]), {}).join('\n');
    expect(lines).toContain('paired readings · unknown split · no model · 0 questions');
    expect(lines).toContain('not scored this run (a, b)');
  });

  it('prints a positive separable rate with its sign', () => {
    const left = ['values', 'values', 'values', 'values', 'values', 'values', 'values', 'values'];
    const right = [MATCH, MATCH, MATCH, MATCH, MATCH, MATCH, MATCH, MATCH];
    const report = artifact(left, right);
    const lines = declaredLines(readDeclared(report, [['a', 'b']]), report).join('\n');
    expect(lines).toContain('+100.00pp, separable');
  });

  it('counts a base for the arms that name one and skips the arms that do not', () => {
    const report = {
      ...artifact([MATCH], [MATCH]),
      arms: [{ arm: 'a' }, { arm: 'b', servedModels: { 'deepseek-flash': 1 } }],
    };
    expect(declaredLines(readDeclared(report, [['a', 'b']]), report).join('\n')).toContain('served by deepseek-flash');
  });

  it('defaults the split and the question count when the artifact records neither', () => {
    const dir = root({ minidev: [['a', 'b']] });
    const file = join(dir, 'bird-eval.json');
    writeFileSync(
      file,
      JSON.stringify({
        cases: [
          { arm: 'a', id: 1, passed: true },
          { arm: 'b', id: 1, passed: true },
        ],
        arms: [{ arm: 'a', servedModels: { 'deepseek-flash': 1 } }],
      }),
    );
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    try {
      expect(main([file, '--declared'], dir)).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(printed.join('\n')).toContain('a -> b');
    expect(printed.join('\n')).toContain('(minidev served by deepseek-flash)');
    const written = JSON.parse(readFileSync(join(dir, 'bird-pairs.json'), 'utf8')) as { questions: number };
    expect(written.questions).toBe(1);
  });

  it('writes a question count of zero for an artifact with no case rows', () => {
    const dir = root({ dev: [['a', 'b']] });
    const file = join(dir, 'bird-eval.json');
    writeFileSync(file, JSON.stringify({ split: 'dev', cases: undefined }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main([file, '--declared'], dir)).toBe(0);
    } finally {
      log.mockRestore();
    }
    const written = JSON.parse(readFileSync(join(dir, 'bird-pairs.json'), 'utf8')) as { questions: number; pairs: { missing: string[] }[] };
    expect(written.questions).toBe(0);
    expect(written.pairs[0]?.missing).toEqual(['a', 'b']);
  });

  it('writes the exit code when it is the entry point', async () => {
    const dir = root({ dev: [['a', 'b']] });
    const file = join(dir, 'bird-eval.json');
    writeFileSync(file, JSON.stringify(artifact([MATCH, 'values'], ['values', MATCH])));
    const saved = process.argv.slice();
    const moduleUrl = new URL('../eval/bird/pair.ts', import.meta.url);
    process.argv.splice(0, process.argv.length, 'node', moduleUrl.pathname, file, '--declared');
    const exits = process.exitCode;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      vi.resetModules();
      await import('../eval/bird/pair.js');
      expect(process.exitCode).toBe(0);
    } finally {
      process.argv.splice(0, process.argv.length, ...saved);
      process.exitCode = exits;
      log.mockRestore();
      vi.resetModules();
    }
  });

  it('takes --declared as a switch with no value, and refuses it beside --pair', () => {
    expect(resolvePairSettings(['x.json', '--declared'], '/root')).toEqual({ report: '/root/x.json', declared: true });
    expect(() => resolvePairSettings(['x.json', '--declared', '--pair', 'a,b'], '/root')).toThrow('two different readings');
    expect(() => resolvePairSettings(['--declared'], '/root')).toThrow('usage: pair.ts');
  });
});
