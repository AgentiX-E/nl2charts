/**
 * The contrast between two artifacts, and the two denominators it refuses to choose between.
 *
 * These tests exist because the numbers this file prints were computed by hand once, and the hand
 * that computed them was mine. `S1-b` lost 94 cases to a timeout; the raw delta was +0.98pp
 * (p=0.29) and the complete-case delta was +2.50pp (p=0.0049). Both are in the artifact and
 * neither is the verdict, which is a distinction a fixture can hold and a paragraph cannot.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { comparabilityProblems, contrastArtifacts, contrastLines, isEntry, main, pairedInterval, resolveContrastSettings, runIfEntry } from '../eval/bird/contrast.js';
import type { ContrastArtifact, ContrastCase } from '../eval/bird/contrast.js';

const artifact = (cases: readonly ContrastCase[], extra: Partial<ContrastArtifact> = {}): ContrastArtifact => ({
  split: 'dev',
  model: 'base',
  judgeModel: 'judge',
  armsRequested: ['inline+evidence'],
  promptChars: { mean: 2568 },
  cases,
  ...extra,
});

const pass = (id: string): ContrastCase => ({ id, passed: true, reason: 'match' });
const wrong = (id: string): ContrastCase => ({ id, passed: false, reason: 'values' });
/** A case with no verdict at all: the call never returned. */
const silent = (id: string): ContrastCase => ({ id, passed: false, error: 'llm call timed out' });

describe('the interval a rate difference has no denominator for', () => {
  it('is zero-width on a degenerate split and centred on the delta otherwise', () => {
    expect(pairedInterval(0, 0, 0)).toEqual([0, 0]);
    const [low, high] = pairedInterval(60, 96, 1438);
    expect(Number(((low + high) / 2).toFixed(2))).toBe(2.5);
    expect(low).toBeLessThan(2.5);
    expect(high).toBeGreaterThan(2.5);
  });

  it('is symmetric: swapping the sides flips the sign and keeps the width', () => {
    const [low, high] = pairedInterval(60, 96, 1438);
    const [swappedLow, swappedHigh] = pairedInterval(96, 60, 1438);
    expect(swappedLow).toBeCloseTo(-high, 6);
    expect(swappedHigh).toBeCloseTo(-low, 6);
  });
});

describe('what makes two artifacts one contrast', () => {
  it('accepts two runs that share the instrument and differ in the base', () => {
    expect(comparabilityProblems(artifact([pass('1')]), artifact([pass('1')], { model: 'other' }))).toEqual([]);
  });

  it('refuses a different split, judge, arm list or prompt size, and names both values', () => {
    // Each of the four is a way two numbers can look like a contrast and be two experiments. The
    // message carries both values because the reader's next act is to decide which one to fix.
    const base = artifact([pass('1')]);
    expect(comparabilityProblems(base, artifact([pass('1')], { split: 'mini-dev' }))).toEqual(['split: "dev" vs "mini-dev"']);
    expect(comparabilityProblems(base, artifact([pass('1')], { judgeModel: 'other' }))).toEqual(['judge: "judge" vs "other"']);
    expect(comparabilityProblems(base, artifact([pass('1')], { armsRequested: ['names'] }))).toEqual(['arms: ["inline+evidence"] vs ["names"]']);
    expect(comparabilityProblems(base, artifact([pass('1')], { promptChars: { mean: 2781 } }))).toEqual(['promptChars.mean: 2568 vs 2781']);
  });

  it('falls back to the settings block for the split, and refuses when only one side carries it', () => {
    // Two artifacts can name the split in two places; a check that only read `split` would call a
    // mini-dev run and a dev run comparable, and a check that only read `settings.split` would call
    // two dev runs incomparable. Either fallback on one side only is also a disagreement.
    expect(comparabilityProblems(artifact([pass('1')]), { settings: { split: 'dev' }, cases: [pass('1')] })).toEqual([]);
    expect(comparabilityProblems({ settings: { split: 'dev' }, cases: [pass('1')] }, artifact([pass('1')], { split: 'mini-dev' }))).toEqual([
      'split: "dev" vs "mini-dev"',
    ]);
    expect(comparabilityProblems(artifact([pass('1')]), { cases: [pass('1')] })).toEqual([]);
  });

  it('survives a side that answered nothing at all', () => {
    // The degenerate side: every case a forfeit. Its judged count is zero, so the share it
    // contributes is zero rather than a division by zero, and the pair still reads.
    const dead = artifact([silent('1'), silent('2')], { model: 'dead' });
    const alive = artifact([pass('1'), wrong('2')], { model: 'alive' });
    const outcome = contrastArtifacts(dead, alive);
    expect(outcome.left).toMatchObject({ judged: 0, unanswered: 2, passed: 0 });
    expect(outcome.intentToTreat).toMatchObject({ n: 2, onlyRight: 1, neither: 1 });
    expect(outcome.completeCase.n).toBe(0);
    const lines = contrastLines(outcome).join('\n');
    expect(lines).toContain('unanswered shares differ by 100.00pp');
  });

  it('does not refuse over a field an artifact simply does not carry', () => {
    // An older artifact has no `promptChars`. Absence is not disagreement, and a check that read
    // it as one would refuse every comparison against a file written before the field existed.
    expect(comparabilityProblems({ cases: [pass('1')] }, { cases: [pass('1')] })).toEqual([]);
  });

  it('throws rather than printing a number about two experiments', () => {
    expect(() => contrastArtifacts(artifact([pass('1')]), artifact([pass('1')], { split: 'mini-dev' }))).toThrow(/not one contrast/);
  });
});

describe('the two readings of one pair of artifacts', () => {
  // The shape of `S1`: 6 questions, one side silent on two of them, and both silences on
  // questions the other side got right — which is what makes the two readings differ.
  const left = artifact([pass('1'), pass('2'), pass('3'), wrong('4'), wrong('5'), wrong('6')]);
  const right = artifact([silent('1'), silent('2'), pass('3'), pass('4'), wrong('5'), wrong('6')], { model: 'wide' });

  it('splits the forfeits by cause, because two of the three causes are not the base being slow', () => {
    // A timeout, a guard refusal and an execution error all leave a case unjudged, and they call
    // for different work. `S1-b` lost 94 to timeouts and 15 to the other two; a single
    // `unanswered` count would have described all 109 as the same phenomenon.
    const side = artifact([
      pass('1'),
      { id: '2', passed: false, error: 'llm call timed out', errorKind: 'llm' },
      { id: '3', passed: false, error: 'llm call timed out', errorKind: 'llm' },
      { id: '4', passed: false, error: 'guard: refused', errorKind: 'guard' },
      { id: '5', passed: false, error: 'execution: no such column' },
    ]);
    const outcome = contrastArtifacts(side, artifact([pass('1')], { model: 'wide' }));
    expect(outcome.left.unanswered).toBe(4);
    expect(outcome.left.unansweredByKind).toEqual({ llm: 2, guard: 1, unspecified: 1 });
    expect(contrastLines(outcome).join('\n')).toContain('unanswered   4 (80.00%: llm 2, guard 1, unspecified 1)');
  });

  it('finds the attrition in an artifact written before the verdict was made absent', () => {
    // Every case row of a pre-fix artifact carries `reason: 'values'` on the five no-answer
    // branches, so a contrast that read the verdict as the evidence would report no attrition on
    // exactly the run it was built for. `error` is what a case that produced nothing always wrote.
    const stale = artifact([{ id: '1', passed: false, reason: 'values', error: 'llm call timed out' }]);
    const outcome = contrastArtifacts(stale, artifact([pass('1')], { model: 'wide' }));
    expect(outcome.left.unanswered).toBe(1);
    expect(outcome.intentToTreat).toMatchObject({ n: 1, onlyRight: 1 });
    expect(outcome.completeCase.n).toBe(0);
  });

  it('counts what each side answered, and what it forfeited', () => {
    const outcome = contrastArtifacts(left, right);
    expect(outcome.left).toMatchObject({ judged: 6, unanswered: 0, passed: 3 });
    expect(outcome.right).toMatchObject({ judged: 4, unanswered: 2, passed: 2 });
    expect(outcome.forfeitsRight).toBe(2);
    expect(outcome.forfeitsLeft).toBe(0);
  });

  it('scores the forfeits as wrong answers on one denominator and deletes them on the other', () => {
    const outcome = contrastArtifacts(left, right);
    // Intent-to-treat: only-right 1 (case 4), only-left 2 (cases 1 and 2, which are forfeits).
    expect(outcome.intentToTreat).toMatchObject({ n: 6, both: 1, neither: 2, onlyLeft: 2, onlyRight: 1, deltaPp: -16.67 });
    // Complete case: the two forfeits leave, and with them the two questions the left side won.
    expect(outcome.completeCase).toMatchObject({ n: 4, both: 1, neither: 2, onlyLeft: 0, onlyRight: 1, deltaPp: 25 });
  });

  it('says which reading the attrition disqualifies, in the units of the decision', () => {
    const lines = contrastLines(contrastArtifacts(left, right)).join('\n');
    expect(lines).toContain('2 discordant case(s) have an unanswered side (left 0, right 2)');
    // The share difference is the number that decides whether the complete-case reading may be
    // quoted: 2 of 6 against 0 of 6.
    expect(lines).toContain('unanswered shares differ by 33.33pp');
    expect(lines).toContain('not a verdict on the configuration');
  });

  it('says so when no case was decided by an unanswered side', () => {
    const lines = contrastLines(contrastArtifacts(left, artifact([pass('3'), wrong('4'), wrong('5')], { model: 'wide' }))).join('\n');
    expect(lines).toContain('the two readings are the same population');
  });

  it('reads an artifact that carries no cases and no model name', () => {
    // Two runs of an empty split, and two artifacts written by a tool that never set `model`:
    // neither may crash a comparison, and the side has to say `unnamed` rather than print an
    // empty cell a reader would take for a missing column.
    const outcome = contrastArtifacts({ split: 'dev' }, { split: 'dev' });
    expect(outcome.left).toMatchObject({ model: 'unnamed', judged: 0, unanswered: 0 });
    expect(outcome.intentToTreat.n).toBe(0);
    expect(contrastLines(outcome).join('\n')).toContain('unnamed');
  });

  it('reports a pair whose artifacts share no question rather than dividing by zero', () => {
    const outcome = contrastArtifacts(left, artifact([pass('9')], { model: 'wide' }));
    expect(outcome.intentToTreat).toMatchObject({ n: 0, deltaPp: 0 });
    expect(outcome.completeCase.n).toBe(0);
  });
});

describe('the entry point', () => {
  const write = (name: string, body: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'contrast-'));
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(body));
    return path;
  };

  it('knows whether it was invoked as a program or imported', () => {
    // Both operands matter: a script run under `node -e` has no `argv[1]`, and an imported module
    // has one that is somebody else's path. Reading either as "this is me" would run the program
    // on import, which is the shape that made an earlier instrument measurable only by spawning it.
    const url = new URL('../eval/bird/contrast.ts', import.meta.url).href;
    expect(isEntry(undefined, url)).toBe(false);
    expect(isEntry('/somebody/else.ts', url)).toBe(false);
    expect(isEntry(new URL(url).pathname, url)).toBe(true);
  });

  it('runs only when it is the program, so an import has no side effect', () => {
    const url = new URL('../eval/bird/contrast.ts', import.meta.url).href;
    // Imported: nothing happens, and the return value says so rather than being undefined because
    // a branch fell through by accident.
    expect(runIfEntry([], '/somebody/else.ts', url)).toBeUndefined();
    // Promoted to a program: it runs and reports the code it would exit with.
    const dir = mkdtempSync(join(tmpdir(), 'contrast-entry-'));
    const left = join(dir, 'a.json');
    const right = join(dir, 'b.json');
    writeFileSync(left, JSON.stringify(artifact([pass('1')])));
    writeFileSync(right, JSON.stringify(artifact([pass('1')], { model: 'wide' })));
    const original = console.log;
    console.log = () => undefined;
    try {
      expect(runIfEntry(['--left', left, '--right', right], new URL(url).pathname, url, dir)).toBe(0);
    } finally {
      console.log = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs as a program', () => {
    // The one thing a unit call cannot prove: the module is executable. A CLI whose `main` is
    // tested but whose entry is not wired is a script that prints nothing when a reader runs it.
    const left = write('a.json', artifact([pass('1'), wrong('2')]));
    const right = write('b.json', artifact([silent('1'), wrong('2')], { model: 'wide' }));
    const dir = left.slice(0, left.lastIndexOf('/'));
    try {
      const out = execFileSync('npx', ['tsx', 'eval/bird/contrast.ts', '--left', left, '--right', right], {
        cwd: '/workspace/nl2charts',
        encoding: 'utf8',
      });
      expect(out).toContain('intent-to-treat');
      expect(out).toContain('complete case');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('demands both artifacts and says why', () => {
    expect(() => resolveContrastSettings([], '/tmp')).toThrow(/--left/);
    expect(() => resolveContrastSettings(['--left', 'a.json'], '/tmp')).toThrow(/--right/);
    expect(resolveContrastSettings(['--left', 'a.json', '--right', 'b.json'], '/tmp').json).toBe(false);
    expect(resolveContrastSettings(['--left', 'a.json', '--right', 'b.json', '--json'], '/tmp').json).toBe(true);
  });

  it('prints the two readings from two files, and can emit them as JSON', () => {
    const left = write('a.json', artifact([pass('1'), wrong('2')]));
    const right = write('b.json', artifact([silent('1'), wrong('2')], { model: 'wide' }));
    const dir = (path: string): string => path.slice(0, path.lastIndexOf('/'));
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      expect(main(['--left', left, '--right', right], dir(left))).toBe(0);
      expect(lines.join('\n')).toContain('intent-to-treat');
      lines.length = 0;
      expect(main(['--left', left, '--right', right, '--json'], dir(left))).toBe(0);
      expect(JSON.parse(lines.join('\n'))).toHaveProperty('intentToTreat.n', 2);
    } finally {
      console.log = original;
      rmSync(dir(left), { recursive: true, force: true });
    }
  });
});
