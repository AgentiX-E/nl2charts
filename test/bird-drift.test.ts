/**
 * Two artifacts compared, through the entry point and through the pair of runs it was written for.
 *
 * The unit cases are synthetic because every one of them is a refusal or a distinction that a real
 * artifact pair cannot produce on demand: a file compared with itself, two splits, an arm that only
 * one side carries, a case id that appears twice, a prompt that moved between the runs. The
 * end-to-end cases write real JSON to a temporary directory, because the settings resolution, the
 * artifact path and the exit code are the parts a caller actually touches.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DriftOutcome } from '../eval/bird/drift.js';
import {
  compareArtifacts,
  driftLines,
  driftPath,
  isEntry,
  main,
  resolveDriftSettings,
  runDrift,
  writeDriftArtifact,
} from '../eval/bird/drift.js';

type Row = { id: string; arm: string; passed: boolean; prompt?: number; chars?: number };

const row = (id: string, passed: boolean, prompt = 100, chars = 400, arm = 'arm'): Row => ({ id, arm, passed, prompt, chars });

// A row from an artifact that kept no usage block: absence, not zero. `row` cannot express it
// because a default parameter is what an explicit `undefined` resolves to.
const bare = (id: string, passed: boolean, arm = 'arm'): Row => ({ id, arm, passed });

const report = (
  rows: readonly Row[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  split: 'dev',
  model: 'deepseek-chat',
  judgeModel: 'deepseek-chat',
  dialect: 'SQLite',
  // A row without a `prompt` keeps no usage block at all, which is the `unknown` state: the
  // artifact says nothing about the prompt rather than saying it was empty.
  cases: rows.map((item) =>
    item.prompt === undefined
      ? { id: item.id, arm: item.arm, passed: item.passed }
      : { id: item.id, arm: item.arm, passed: item.passed, tokens: { prompt: item.prompt, chars: item.chars } },
  ),
  ...extra,
});

// The single row a one-arm pair produces, said once rather than nineteen times: the suite has
// `noUncheckedIndexedAccess` on, and an index that is provably present still reads as absent.
const only = (outcome: DriftOutcome) => {
  const [arm] = outcome.arms;
  if (arm === undefined) throw new Error('the pair produced no arm row');
  return arm;
};

const pair = (left: readonly Row[], right: readonly Row[], extra: Record<string, unknown> = {}) =>
  compareArtifacts(report(left, extra) as never, report(right, extra) as never, { left: 'a.json', right: 'b.json' });

describe('the flip table', () => {
  it('counts what kept its verdict and what changed it', () => {
    const outcome = pair([row('1', true), row('2', true), row('3', false), row('4', false)], [
      row('1', true),
      row('2', false),
      row('3', true),
      row('4', false),
    ]);
    const arm = only(outcome);
    expect(arm).toMatchObject({ arm: 'arm', cases: 4, leftPassed: 2, rightPassed: 2, kept: 2, gained: 1, lost: 1 });
    expect(arm.delta).toBe(0);
    expect(arm.instability).toBe(0.5);
    // One gained and one lost is the null hypothesis at its most exact.
    expect(arm.p).toBe(1);
  });

  it('reports a one-sided move at the p the sign of the discordant pairs allows', () => {
    const outcome = pair([row('1', false), row('2', false), row('3', false)], [row('1', true), row('2', true), row('3', true)]);
    const arm = only(outcome);
    expect(arm.gained).toBe(3);
    expect(arm.lost).toBe(0);
    expect(arm.delta).toBeCloseTo(100, 6);
    // 2 * (1/8): all three discordant pairs one way.
    expect(arm.p).toBeCloseTo(0.25, 6);
  });

  it('keeps a case that only one artifact scored out of the denominator', () => {
    const outcome = pair([row('1', true), row('2', false)], [row('1', true)]);
    expect(only(outcome).cases).toBe(1);
    expect(only(outcome).leftPassed).toBe(1);
  });
});

describe('the prompt distinction', () => {
  it('separates an identical prompt from a moved one', () => {
    const outcome = pair([row('1', true, 100, 400), row('2', true, 100, 400)], [row('1', true, 100, 400), row('2', false, 101, 400)]);
    expect(only(outcome).prompt).toEqual({ same: 1, differ: 1, unknown: 0 });
    expect(outcome.problems.some((line) => line.includes('1 case(s) sent a different prompt'))).toBe(true);
  });

  it('calls a token count equal but a character count different a different prompt', () => {
    // This is the case a token-only comparison misses: a retokenisation that lands on the same
    // total while the prompt itself grew.
    const outcome = pair([row('1', true, 100, 400)], [row('1', true, 100, 401)]);
    expect(only(outcome).prompt.differ).toBe(1);
  });

  it('refuses to attribute a flip whose prompt size one artifact never recorded', () => {
    const outcome = pair([bare('1', true)], [row('1', false, 100, 400)]);
    expect(only(outcome).prompt).toEqual({ same: 0, differ: 0, unknown: 1 });
    expect(outcome.problems.some((line) => line.includes('carry no prompt size'))).toBe(true);
  });

  it('says nothing about prompts when both artifacts recorded them and they match', () => {
    const outcome = pair([row('1', true)], [row('1', true)]);
    expect(outcome.problems).toEqual([]);
  });
});

describe('what makes a pair unreadable', () => {
  it('refuses a file compared with itself', () => {
    expect(() => compareArtifacts(report([row('1', true)]) as never, report([row('1', true)]) as never, {
      left: 'a.json',
      right: 'a.json',
    })).toThrow(/compared with itself/);
  });

  it('refuses a pair that names no split', () => {
    const bare = { cases: [] };
    expect(() => compareArtifacts(bare, bare, { left: 'a', right: 'b' })).toThrow(/neither artifact names a split/);
  });

  it('refuses two splits', () => {
    expect(() =>
      compareArtifacts(report([row('1', true)]) as never, report([row('1', true)], { split: 'mini-dev' }) as never, {
        left: 'a.json',
        right: 'b.json',
      }),
    ).toThrow(/a\.json is dev and b\.json is mini-dev/);
  });

  it('refuses an arm the caller named that only one side carries', () => {
    expect(() => compareArtifacts(report([row('1', true)]) as never, report([row('1', true)]) as never, {
      left: 'a',
      right: 'b',
      arm: 'other',
    })).toThrow(/do not both carry arm other/);
  });

  it('refuses a pair with no arm in common', () => {
    expect(() =>
      compareArtifacts(report([row('1', true, 100, 400, 'x')]) as never, report([row('1', true, 100, 400, 'y')]) as never, {
        left: 'a',
        right: 'b',
      }),
    ).toThrow(/share no arm/);
  });

  it('refuses a shared arm with no shared case', () => {
    expect(() => compareArtifacts(report([row('1', true)]) as never, report([row('2', true)]) as never, { left: 'a', right: 'b' })).toThrow(
      /share no case on arm arm/,
    );
  });

  it('refuses a pair that kept no case at all', () => {
    const empty = { split: 'dev' };
    expect(() => compareArtifacts(empty as never, empty as never, { left: 'a', right: 'b' })).toThrow(/share no arm/);
  });

  it('names the sides left and right when the caller does not', () => {
    const outcome = compareArtifacts(report([row('1', true)]) as never, report([row('1', false)]) as never);
    expect([outcome.left, outcome.right]).toEqual(['left', 'right']);
    expect(only(outcome).lost).toBe(1);
  });

  it('refuses a case a single artifact carries twice', () => {
    expect(() => pair([row('1', true), row('1', false)], [row('1', true)])).toThrow(/a\.json carries case 1 twice for arm arm/);
  });
});

describe('arms the pair does not share', () => {
  it('drops them, counts them, and leaves the shared arm readable', () => {
    const outcome = compareArtifacts(
      report([row('1', true, 100, 400, 'a'), row('1', true, 100, 400, 'b')]) as never,
      report([row('1', false, 100, 400, 'a')]) as never,
      { left: 'l.json', right: 'r.json' },
    );
    expect(outcome.arms.map((arm) => arm.arm)).toEqual(['a']);
    expect(outcome.unshared).toBe(1);
    expect(driftLines(outcome).join('\n')).toContain('1 unshared arm(s)');
  });

  it('compares only the arm the caller named', () => {
    const outcome = compareArtifacts(
      report([row('1', true, 100, 400, 'a'), row('1', false, 100, 400, 'b')]) as never,
      report([row('1', false, 100, 400, 'a'), row('1', false, 100, 400, 'b')]) as never,
      { left: 'l', right: 'r', arm: 'a' },
    );
    expect(outcome.arms.map((arm) => arm.arm)).toEqual(['a']);
  });
});

describe('a pair that is comparable but not an A/A', () => {
  it('names the model, the judge and the dialect that moved', () => {
    const left = report([row('1', true)]) as Record<string, unknown>;
    const right = report([row('1', true)], { model: 'glm-4-flash', judgeModel: 'deepseek-reasoner', dialect: 'PostgreSQL' }) as Record<
      string,
      unknown
    >;
    const outcome = compareArtifacts(left as never, right as never, { left: 'a', right: 'b' });
    const text = outcome.problems.join('\n');
    expect(text).toContain('different models (deepseek-chat and glm-4-flash)');
    expect(text).toContain('different models');
    expect(text).toContain('judged by different models');
    expect(text).toContain('different dialects');
  });

  it('prints every problem on its own line, prefixed', () => {
    const outcome = compareArtifacts(report([row('1', true, 100, 400)]) as never, report([row('1', true, 200, 400)], { model: 'other' }) as never, {
      left: 'a',
      right: 'b',
    });
    expect(outcome.problems.every((line) => line.startsWith('DRIFT: '))).toBe(true);
    expect(outcome.problems.length).toBe(2);
  });
});

describe('the lines it prints', () => {
  it('carry the arm, the move, the discordant pairs and the p', () => {
    const outcome = pair([row('1', true), row('2', false)], [row('1', false), row('2', true)]);
    const text = driftLines(outcome).join('\n');
    expect(text).toContain('drift: dev, a.json vs b.json');
    expect(text).toContain('1 -> 1 of 2 (+0.00pp)');
    expect(text).toContain('gained 1 / lost 1, exact McNemar p=1.0000');
    expect(text).toContain('one case changed its verdict on 100.00% of the split');
    expect(text).toContain('prompt same 2, differ 0, unreadable 0');
  });

  it('signs a positive move so a reader cannot mistake its direction', () => {
    const outcome = pair([row('1', false), row('2', false)], [row('1', true), row('2', true)]);
    expect(driftLines(outcome).join('\n')).toContain('(+100.00pp)');
  });
});

describe('settings, paths and the entry', () => {
  it('reads two positional paths and resolves them against the root', () => {
    const settings = resolveDriftSettings(['/tmp/a.json', '/tmp/b.json'], '/root');
    expect(settings.left).toBe('/tmp/a.json');
    expect(settings.right).toBe('/tmp/b.json');
    expect(settings.out).toBe('/tmp');
    expect(settings.arm).toBeUndefined();
    expect(settings.strict).toBe(false);
  });

  it('resolves a relative path against the root rather than the process', () => {
    expect(resolveDriftSettings(['one.json', 'two.json'], '/root').left).toBe('/root/one.json');
  });

  it('takes an arm and a strict flag', () => {
    const settings = resolveDriftSettings(['a.json', 'b.json', '--arm', 'arm', '--strict'], '/r');
    expect(settings).toMatchObject({ arm: 'arm', strict: true });
  });

  it('refuses an arm flag with no name', () => {
    expect(() => resolveDriftSettings(['a.json', 'b.json', '--arm'], '/r')).toThrow(/--arm needs a name/);
  });

  it('refuses one path or three', () => {
    expect(() => resolveDriftSettings(['a.json'], '/r')).toThrow(/usage: drift\.ts/);
    expect(() => resolveDriftSettings(['a.json', 'b.json', 'c.json'], '/r')).toThrow(/usage: drift\.ts/);
  });

  it('names the artifact after the arm, sanitised, and `all` when none is named', () => {
    expect(driftPath({ left: 'a', right: 'b', out: '/out', strict: false })).toBe('/out/drift-all.json');
    expect(driftPath({ left: 'a', right: 'b', out: '/out', strict: false, arm: 'inline+evidence+icl' })).toBe(
      '/out/drift-inline+evidence+icl.json',
    );
    expect(driftPath({ left: 'a', right: 'b', out: '/out', strict: false, arm: 'a/b c' })).toBe('/out/drift-a-b-c.json');
  });

  it('knows its own entry and not another module', () => {
    expect(isEntry(undefined, 'file:///x.js')).toBe(false);
    expect(isEntry('/tmp/other.js', import.meta.url)).toBe(false);
  });
});

describe('through the file system', () => {
  it('reads two artifacts, writes one, and returns zero when nothing is wrong', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-'));
    const left = join(dir, 'left.json');
    const right = join(dir, 'right.json');
    writeFileSync(left, JSON.stringify(report([row('1', true), row('2', false)])));
    writeFileSync(right, JSON.stringify(report([row('1', true), row('2', true)])));
    const settings = resolveDriftSettings([left, right], dir);
    const outcome = runDrift(settings);
    expect(only(outcome).gained).toBe(1);
    const path = writeDriftArtifact(settings, outcome);
    expect(path).toBe(join(dir, 'drift-all.json'));
    const written = JSON.parse(readFileSync(path, 'utf8')) as { arms: { arm: string }[] };
    expect(written.arms.map((row) => row.arm)).toEqual(['arm']);
    expect(main([left, right], dir)).toBe(0);
  });

  it('compares one named arm when the caller names one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-arm-'));
    const left = join(dir, 'left.json');
    const right = join(dir, 'right.json');
    writeFileSync(left, JSON.stringify(report([row('1', true, 100, 400, 'a'), row('1', false, 100, 400, 'b')])));
    writeFileSync(right, JSON.stringify(report([row('1', false, 100, 400, 'a'), row('1', true, 100, 400, 'b')])));
    const settings = resolveDriftSettings([left, right, '--arm', 'a'], dir);
    expect(runDrift(settings).arms.map((arm) => arm.arm)).toEqual(['a']);
    expect(driftPath(settings)).toBe(join(dir, 'drift-a.json'));
  });

  it('returns one on a problem only when it was asked to be strict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-strict-'));
    const left = join(dir, 'left.json');
    const right = join(dir, 'right.json');
    writeFileSync(left, JSON.stringify(report([row('1', true)])));
    writeFileSync(right, JSON.stringify(report([row('1', true)], { model: 'glm-4-flash' })));
    expect(main([left, right], dir)).toBe(0);
    expect(main([left, right, '--strict'], dir)).toBe(1);
  });
});

describe('as a script', () => {
  it('runs as the entry, because that is how a reader runs it', () => {
    // Imported, `import.meta.url` is never the process entry, so the guard at the bottom of the
    // module stays dark in every other test here — and a guard that never fires is a CLI nobody
    // has run.
    const dir = mkdtempSync(join(tmpdir(), 'drift-cli-'));
    const left = join(dir, 'left.json');
    const right = join(dir, 'right.json');
    writeFileSync(left, JSON.stringify(report([row('1', true), row('2', false)])));
    writeFileSync(right, JSON.stringify(report([row('1', false), row('2', false)])));
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(process.cwd(), 'eval/bird/drift.ts'), left, right], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('drift: dev,');
    expect(result.stdout).toContain('lost 1');
  });
});
