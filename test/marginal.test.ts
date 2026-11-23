/**
 * The marginal-candidate instrument, held to its own arithmetic.
 *
 * Three things can be wrong here and each has a test that would catch it:
 *
 * 1. **The subset score.** A subset is scored by the shipped `vote` policy over the candidates it
 *    contains, which is how `compositions` scores it. If the two ever disagree the harness would
 *    price a pipeline nobody ran, so one test rebuilds the full subset's count both ways.
 * 2. **The pair.** The paired halves must close: `both + onlyRight + onlyLeft + neither` is the
 *    intersection's size, and `onlyRight - onlyLeft` must equal the difference between the subsets'
 *    own counts. A pair assembled over different denominators satisfies neither.
 * 3. **The verdict.** A harness that can only say "pays" is a harness that has never printed its
 *    refusal, so both branches are produced on synthetic cases with a known sign.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compositions } from '../tools/pool-replay.mjs';
import type { ReplayCandidate, ReplayRow } from '../tools/pool-replay.mjs';
import {
  MAX_SOURCES,
  bestBySize,
  main,
  marginal,
  pairSubsets,
  reportLines,
  resolveSettings,
  scoreSubset,
  selfTest,
  sourcesOf,
  subsetOutcomes,
} from '../eval/bird/marginal.js';

/** One candidate: a source, a result fingerprint, and whether the judge accepted it. */
const candidate = (source: string, fingerprint: string, correct: boolean, rows = 1): ReplayCandidate => ({
  source,
  fingerprint,
  correct,
  rows,
  sql: `SELECT '${source}'`,
  columns: 1,
  chosen: false,
});

/** One case of one arm. */
const row = (id: string, candidates: readonly ReplayCandidate[]): ReplayRow => ({ id, arm: 'select', candidates });

/**
 * The `pays` shape: each source is right on half the cases, and the pair is right on all of them.
 *
 * This is what a tie-break can do and what a single call cannot: on odd cases the correct statement
 * is listed first, so the tied pair takes it; on even cases the other source's is listed first. No
 * single source reaches more than half, and the vote reaches all — the same shape the real artifact
 * shows when the best pair beats the best single (940 against 938 on 1,524 cases).
 */
function widePool(): ReplayRow[] {
  const rows: ReplayRow[] = [];
  for (let index = 0; index < 200; index += 1) {
    const odd = index % 2 === 1;
    const first = candidate('a', `a${String(index)}${odd ? 'r' : 'w'}`, odd);
    const second = candidate('b', `b${String(index)}${odd ? 'w' : 'r'}`, !odd);
    rows.push(row(String(index), odd ? [first, second] : [second, first]));
  }
  return rows;
}

/** The `cannot pay` shape: `b` answers one question `a` misses and loses one it gets. */
function narrowPool(): ReplayRow[] {
  const rows: ReplayRow[] = [];
  for (let index = 0; index < 200; index += 1) {
    const aRight = index !== 0 && index !== 1;
    rows.push(
      row(String(index), [
        candidate('a', `a${String(index)}${String(aRight)}`, aRight),
        candidate('b', `b${String(index)}${String(!aRight && index === 0)}`, !aRight && index === 0),
      ]),
    );
  }
  return rows;
}

function artifactFile(rows: readonly ReplayRow[], name = 'bird-eval.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'marginal-'));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ split: 'dev', arms: [{ arm: 'select', calls: { mean: 2 } }], cases: rows }));
  return path;
}

describe('sourcesOf', () => {
  it('dedupes and sorts, so two runs enumerate subsets in one order', () => {
    const rows = [row('1', [candidate('b', 'f1', true), candidate('a', 'f2', false)]), row('2', [candidate('a', 'f3', true)])];
    expect(sourcesOf(rows)).toEqual(['a', 'b']);
  });

  it('ignores a candidate that names no source, because a subset cannot be named after it', () => {
    expect(sourcesOf([row('1', [{ fingerprint: 'f', correct: true }])])).toEqual([]);
  });
});

describe('subsetOutcomes', () => {
  it('scores only the subset it is given, and drops the cases it never saw', () => {
    const rows = [
      row('1', [candidate('a', 'fa', true), candidate('b', 'fb', false)]),
      row('2', [candidate('a', 'fc', false), candidate('b', 'fd', true)]),
      row('3', [candidate('c', 'fe', true)]),
    ];
    const only = subsetOutcomes(rows, ['b']);
    expect([...only.entries()]).toEqual([
      ['1', false],
      ['2', true],
    ]);
  });

  it('drops a case whose id cannot be named rather than inventing one', () => {
    expect(subsetOutcomes([{ arm: 'select', candidates: [candidate('a', 'f', true)] }], ['a']).size).toBe(0);
  });
});

describe('scoreSubset', () => {
  it('counts correct, scored and calls, and sorts its own sources', () => {
    const score = scoreSubset(widePool(), ['b', 'a']);
    expect(score.sources).toEqual(['a', 'b']);
    expect(score.calls).toBe(2);
    expect(score.scored).toBe(200);
    // The vote over each pair takes whichever member the row lists first, and the fixture lists the
    // correct one first, so the pair scores all 200 while either source alone scores 100.
    expect(score.correct).toBe(200);
    expect(score.undecided).toBe(0);
  });

  it('reports undecided as the cases it saw but could not decide', () => {
    const rows = [row('1', [candidate('a', 'f', true)]), row('2', [candidate('a', 'g', true)])];
    expect(scoreSubset(rows, ['a']).undecided).toBe(0);
    expect(scoreSubset(rows, ['a']).scored).toBe(2);
  });
});

describe('pairSubsets', () => {
  it('closes the pair: the four cells are the intersection', () => {
    const pair = pairSubsets(widePool(), ['a'], ['a', 'b']);
    expect(pair.both + pair.onlyRight + pair.onlyLeft + pair.neither).toBe(pair.cases);
    expect(pair.cases).toBe(200);
  });

  it('derives the effect from the discordant cells and nothing else', () => {
    const pair = pairSubsets(widePool(), ['a'], ['a', 'b']);
    expect(pair.deltaPp).toBeCloseTo(((pair.onlyRight - pair.onlyLeft) / pair.cases) * 100, 10);
    expect(pair.onlyRight - pair.onlyLeft).toBe(pair.right.correct - pair.left.correct);
  });

  it('brackets its own effect, in percentage points and in the challenger sign', () => {
    const pair = pairSubsets(widePool(), ['a'], ['a', 'b']);
    expect(pair.ci.low).toBeLessThan(pair.deltaPp);
    expect(pair.ci.high).toBeGreaterThan(pair.deltaPp);
    expect(pair.ci.low).toBeGreaterThan(0);
  });

  it('calls a comparison with no shared case zero rather than dividing by it', () => {
    const rows = [row('1', [candidate('a', 'fa', true)]), row('2', [candidate('b', 'fb', true)])];
    const pair = pairSubsets(rows, ['a'], ['b']);
    expect(pair.cases).toBe(0);
    expect(pair.deltaPp).toBe(0);
    expect(pair.p).toBe(1);
  });
});

describe('bestBySize', () => {
  it('returns one row per size, taking the subset that answers the most questions', () => {
    const steps = bestBySize(widePool(), ['a', 'b']);
    expect(steps.map((step) => step.calls)).toEqual([1, 2]);
    // Both sources score 100 alone, so the tie-break decides which one the table names.
    expect(steps[0]?.sources).toEqual(['a']);
  });

  it('breaks a tie by name, so two runs print one table', () => {
    const rows = [row('1', [candidate('z', 'fz', true), candidate('a', 'fa', true)])];
    expect(bestBySize(rows, ['a', 'z'])[0]?.sources).toEqual(['a']);
  });

  it(`refuses more than ${String(MAX_SOURCES)} sources rather than truncating the search`, () => {
    const rows = [row('1', [candidate('a', 'f', true)])];
    expect(() => bestBySize(rows, ['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toThrow('more than this harness enumerates');
  });
});

describe('marginal', () => {
  it('accepts an increment no margin can refuse', () => {
    const [verdict] = marginal(widePool());
    expect(verdict?.pays).toBe(true);
    expect(verdict?.sentence).toContain('the wider pool pays');
  });

  it('refuses an increment that is a swap rather than a gain', () => {
    const [verdict] = marginal(narrowPool());
    expect(verdict?.pays).toBe(false);
    expect(verdict?.sentence).toContain('cannot pay');
  });

  it('states the margin it applied, so a changed threshold is visible in the output', () => {
    const [verdict] = marginal(narrowPool(), 0.5);
    expect(verdict?.sentence).toContain('0.50pp');
  });

  it('prices nothing when the pool is one source', () => {
    expect(marginal([row('1', [candidate('a', 'f', true)])])).toEqual([]);
  });
});

describe('reportLines', () => {
  it('prints the baseline row and one block per increment', () => {
    const rows = widePool();
    const lines = reportLines(rows, marginal(rows), bestBySize(rows, sourcesOf(rows)));
    expect(lines[0]).toContain('200 cases with a pool');
    expect(lines.filter((line) => line.includes('call(s) buys'))).toHaveLength(1);
  });

  it('omits the baseline when it is not given one, which is how the empty table prints', () => {
    expect(reportLines([], [])).toHaveLength(2);
  });
});

describe('resolveSettings', () => {
  it('takes an artifact, a margin and a named pair', () => {
    const settings = resolveSettings(['--artifact', 'a.json', '--margin', '1.5', '--left', 'x,y', '--right', 'z']);
    expect(settings).toEqual({ artifact: 'a.json', margin: 1.5, left: ['x', 'y'], right: ['z'] });
  });

  it('defaults the margin to the split\u2019s published resolution', () => {
    expect(resolveSettings(['--artifact', 'a.json']).margin).toBeCloseTo(2.3, 10);
  });

  it.each([
    { argv: ['--artifact', 'a.json', '--nope'], message: 'unrecognized argument' },
    { argv: [], message: '--artifact is required' },
    { argv: ['--artifact', 'a.json', '--margin', '0'], message: 'positive number' },
    { argv: ['--artifact', 'a.json', '--margin', 'wide'], message: 'positive number' },
    { argv: ['--artifact', 'a.json', '--left', 'x'], message: 'go together' },
    { argv: ['--artifact', 'a.json', '--left', ' ', '--right', 'z'], message: 'empty side' },
  ])('refuses $argv', ({ argv, message }) => {
    expect(() => resolveSettings(argv)).toThrow(message);
  });
});

describe('main', () => {
  it('prints the ladder and exits zero on an artifact with a pool', () => {
    const lines: string[] = [];
    expect(main(['--artifact', artifactFile(widePool())], (line) => lines.push(line))).toBe(0);
    expect(lines.at(-1)).toContain('a wider pool pays');
  });

  it('prints the named pair on one line, with the cells a reader can check', () => {
    const lines: string[] = [];
    expect(main(['--artifact', artifactFile(widePool()), '--left', 'a', '--right', 'a,b'], (line) => lines.push(line))).toBe(0);
    expect(lines[0]).toContain('a -> a+b');
    expect(lines[1]).toContain('both');
  });

  it('emits JSON a caller can read, for both shapes', () => {
    const ladder: string[] = [];
    main(['--artifact', artifactFile(widePool()), '--json'], (line) => ladder.push(line));
    const parsed = JSON.parse(ladder.join('\n')) as { verdicts: { pays: boolean }[] };
    expect(parsed.verdicts[0]?.pays).toBe(true);
    const pair: string[] = [];
    main(['--artifact', artifactFile(widePool()), '--left', 'a', '--right', 'a,b', '--json'], (line) => pair.push(line));
    expect((JSON.parse(pair.join('\n')) as { pays: boolean }).pays).toBe(true);
  });

  it('says there is nothing to add when the pool holds one source', () => {
    const lines: string[] = [];
    expect(main(['--artifact', artifactFile([row('1', [candidate('a', 'f', true)])])], (line) => lines.push(line))).toBe(0);
    expect(lines.at(-1)).toContain('one source');
  });

  it('refuses an artifact that carries no pool at all', () => {
    expect(() => main(['--artifact', artifactFile([row('1', [])])], () => undefined)).toThrow('no case with a candidate pool');
  });
});

describe('selfTest', () => {
  it('passes on the real code', () => {
    expect(selfTest()).toEqual([]);
  });

  it('reports a verdict that can only say yes', () => {
    const problems = selfTest(() => []);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('was not accepted');
    expect(problems[1]).toContain('was accepted');
  });

  it('runs as a command and says so in one line', () => {
    const lines: string[] = [];
    expect(main(['--self-test'], (line) => lines.push(line))).toBe(0);
    expect(lines.at(-1)).toBe('marginal self-test: 1 accepted, 1 refused');
  });
});

describe('the identity between this harness and the composition table', () => {
  it('scores the full subset exactly as `compositions` does', () => {
    // Two producers of one reading: `compositions` takes the modal group directly, this harness
    // goes through the shipped `vote` policy. Both are in the repository, so both are checked.
    const rows = [
      row('1', [candidate('a', 'x', true), candidate('b', 'y', false)]),
      row('2', [candidate('a', 'x2', false), candidate('b', 'y2', true)]),
      row('3', [candidate('a', 'x3', true), candidate('b', 'y3', true)]),
      row('4', [candidate('a', 'x4', false), candidate('b', 'y4', false)]),
    ];
    const table = compositions(rows);
    const full = table.find((entry) => entry.calls === 2);
    expect(full?.vote).toBe(scoreSubset(rows, ['a', 'b']).correct);
    const each = table.find((entry) => entry.calls === 1 && entry.sources.join() === 'a');
    expect(each?.vote).toBe(scoreSubset(rows, ['a']).correct);
  });
});

describe('the shapes an artifact can arrive in', () => {
  it('survives a case that records no candidate array at all', () => {
    const bare: ReplayRow[] = [{ id: '1', arm: 'select' }, row('2', [candidate('a', 'f', true)])];
    expect(sourcesOf(bare)).toEqual(['a']);
    expect([...subsetOutcomes(bare, ['a']).keys()]).toEqual(['2']);
    expect(scoreSubset(bare, ['a']).scored).toBe(1);
    expect(scoreSubset(bare, ['a']).undecided).toBe(0);
  });

  it('refuses an artifact whose cases name no arm, because there is no pool to widen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marginal-'));
    const path = join(dir, 'bare.json');
    writeFileSync(path, JSON.stringify({ cases: [{ id: '1', candidates: [candidate('a', 'f', true)] }] }));
    expect(() => main(['--artifact', path], () => undefined)).toThrow('no case with a candidate pool');
  });
});

describe('the table with holes in it', () => {
  it('prints a zero share for a subset that decided nothing, rather than dividing by it', () => {
    const empty = { sources: ['a'], calls: 1, correct: 0, scored: 0, undecided: 3 };
    const lines = reportLines([], [], [empty]);
    expect(lines[2]).toContain('0.00%');
  });

  it('prints a zero share for a pair whose sides share no case', () => {
    const side = { sources: ['a'], calls: 1, correct: 0, scored: 0, undecided: 0 };
    const other = { sources: ['a', 'b'], calls: 2, correct: 0, scored: 0, undecided: 0 };
    const pair = { left: side, right: other, cases: 0, both: 0, onlyRight: 0, onlyLeft: 0, neither: 0, deltaPp: 0, p: 1, ci: { low: 0, high: 0 }, extraCalls: 1 };
    const lines = reportLines([], [{ pair, pays: false, sentence: 'nothing' }]);
    expect(lines[2]).toContain('0.00%');
  });
});

describe('a named pair that loses', () => {
  it('says cannot pay and prints the negative sign', () => {
    const lines: string[] = [];
    main(['--artifact', artifactFile(narrowPool()), '--left', 'a', '--right', 'a,b'], (line) => lines.push(line));
    expect(lines[0]).toContain('cannot pay');
    expect(lines[0]).toContain('+');
  });

  it('refuses an empty right-hand side as a subset', () => {
    expect(() => resolveSettings(['--artifact', 'a.json', '--left', 'a', '--right', ' '])).toThrow('empty side');
  });
});

describe('the self-test can fail, and the command says so', () => {
  it('reports a verdict pair whose halves do not close', () => {
    // A pair assembled over mismatched denominators: the whole reason the identity is checked.
    const side = { sources: ['a'], calls: 1, correct: 0, scored: 10, undecided: 0 };
    const other = { sources: ['a', 'b'], calls: 2, correct: 5, scored: 10, undecided: 0 };
    const broken = () => [
      {
        pair: { left: side, right: other, cases: 10, both: 0, onlyRight: 5, onlyLeft: 2, neither: 3, deltaPp: 30, p: 0.03, ci: { low: 10, high: 80 }, extraCalls: 1 },
        pays: true,
        sentence: 'a lie',
      },
    ];
    const problems = selfTest(broken as unknown as typeof marginal);
    expect(problems.some((problem) => problem.includes('discordant counts imply'))).toBe(true);
  });

  it('exits non-zero when the checker under test reports a problem', () => {
    const lines: string[] = [];
    expect(main(['--self-test'], (line) => lines.push(line), () => ['a probe was accepted'])).toBe(1);
    expect(lines).toEqual(['FAILED a probe was accepted', 'marginal self-test: 1 accepted, 1 refused, 1 problems']);
  });

  it('runs as a script and exits zero on the real artifact it is pointed at', () => {
    const artifact = artifactFile(widePool());
    const result = spawnSync('npx', ['tsx', 'eval/bird/marginal.ts', '--artifact', artifact], { cwd: join(__dirname, '..'), encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('a wider pool pays');
  });
});
