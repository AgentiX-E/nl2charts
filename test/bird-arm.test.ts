/**
 * The dev workflow's diagnostic steps must price the arm the run asked for.
 *
 * Run `41356370371` dispatched `select-mixed,select-cross` and died four steps after the
 * evaluation with `eval/out/bird-eval.json has no arm select; it holds select-cross,
 * select-mixed`. The evaluation itself had finished and the floor had passed: the failure was
 * five analysis steps passing the literal `--arm select`, an arm the Mini-Dev chain always runs
 * and a dev dispatch runs only on request. The other four steps would have printed the same
 * sentence, so a run that priced a new arm published its numbers and then failed to read them.
 *
 * The rule below is the fix, and the tests pin its two edges: a requested arm the artifact does
 * not hold, and a request that names nothing at all. The last test pins that the workflow asks
 * this tool rather than naming an arm, because a decision nobody consults is a comment.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chooseArm, casesOf, main, message, readArms, REQUESTED_ENV } from '../tools/bird-arm.mjs';

const DEV_FILE = resolve(process.cwd(), '.github/workflows/bird-dev.yml');
const TOOL = resolve(process.cwd(), 'tools/bird-arm.mjs');

/** The two arms run `41356370371` held, with the population sizes its artifact had. */
const crossRun = [
  ...Array.from({ length: 600 }, () => ({ arm: 'select-mixed' })),
  ...Array.from({ length: 600 }, () => ({ arm: 'select-cross' })),
];

function artifact(rows: readonly unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'bird-arm-'));
  const path = join(dir, 'bird-eval.json');
  writeFileSync(path, JSON.stringify({ split: 'dev', cases: rows }));
  return path;
}

describe('which arms an artifact holds', () => {
  it('names each arm once, sorted, and ignores rows that name none', () => {
    expect(readArms([{ arm: 'select-mixed' }, { arm: 'select-cross' }, { arm: 'select-mixed' }, {}, { arm: '' }])).toEqual([
      'select-cross',
      'select-mixed',
    ]);
  });
});

describe('the arm the run asked for', () => {
  it('takes the first requested name the artifact holds, not the artifact order', () => {
    // The artifact is sorted alphabetically, so `select-cross` comes first in the file and must
    // still lose: the dispatch asked for `select-mixed` first, and that is what the run is about.
    expect(chooseArm(crossRun, 'select-mixed,select-cross').arm).toBe('select-mixed');
    expect(chooseArm(crossRun, 'select-cross,select-mixed').arm).toBe('select-cross');
  });

  it('falls back to the largest population when none of the requested arms is in the artifact', () => {
    const chosen = chooseArm(crossRun, 'select');
    expect(chosen.arm).toBe('select-cross');
    expect(chosen.reason).toContain('none of the requested arms (select) is in this artifact');
  });

  it('falls back to the largest population when nothing was requested', () => {
    const chosen = chooseArm([{ arm: 'b' }, { arm: 'a' }, { arm: 'a' }], '');
    expect(chosen.arm).toBe('a');
    expect(chosen.reason).toContain('no arms were requested');
  });

  it('breaks a tie alphabetically so two identical runs print the same name', () => {
    expect(chooseArm([{ arm: 'zeta' }, { arm: 'alpha' }], '').arm).toBe('alpha');
  });

  it('does not count a row that names no arm, or names an empty one', () => {
    // The population sizes decide the fallback, so a nameless row counted as an arm would change
    // the answer. `readArms` ignores them; the counting loop has to as well, and it is a second
    // loop — which is exactly the kind of pair that drifts.
    const rows = [{ arm: 'a' }, { arm: 'b' }, { arm: 'b' }, {}, { arm: '' }];
    expect(chooseArm(rows, '').arm).toBe('b');
    expect(chooseArm(rows, 'gone').arm).toBe('b');
  });

  it('tolerates a request list with stray commas and spaces', () => {
    expect(chooseArm(crossRun, ' , select-cross , ').arm).toBe('select-cross');
  });

  it('refuses an artifact that holds no arm at all', () => {
    // An empty answer substituted into `--arm` would be reported as "arm `` has no cases",
    // which names the caller's shell rather than the artifact.
    expect(() => chooseArm([{}, {}], 'select')).toThrow(/holds no arm/);
  });
});

describe('reading the artifact', () => {
  it('returns the cases array', () => {
    const path = artifact(crossRun.slice(0, 3));
    try {
      expect(casesOf(path)).toHaveLength(3);
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('names the path when the file is not an evaluation artifact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bird-arm-'));
    const path = join(dir, 'other.json');
    writeFileSync(path, JSON.stringify({ split: 'dev' }));
    try {
      expect(() => casesOf(path)).toThrow(new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} holds no cases array`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the command line the workflow substitutes', () => {
  it('writes one name on stdout and the reason on stderr', () => {
    // The caller does `--arm "$(node tools/bird-arm.mjs …)"`, so anything else on stdout would
    // become an argument: a reason printed there would be read as an arm name.
    const path = artifact(crossRun);
    try {
      const out: string[] = [];
      const err: string[] = [];
      const code = main([path], { [REQUESTED_ENV]: 'select-cross' }, (line) => out.push(line), (line) => err.push(line));
      expect(code).toBe(0);
      expect(out).toEqual(['select-cross']);
      expect(err.join('\n')).toContain('bird-arm: select-cross');
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('prints usage and fails when given no artifact', () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(main([], {}, (line) => out.push(line), (line) => err.push(line))).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('usage: bird-arm.mjs');
  });

  it('fails instead of printing an empty arm', () => {
    const path = artifact([{ arm: undefined }]);
    try {
      const out: string[] = [];
      const err: string[] = [];
      expect(main([path], { [REQUESTED_ENV]: 'select' }, (line) => out.push(line), (line) => err.push(line))).toBe(1);
      expect(out).toEqual([]);
      expect(err.join('\n')).toContain('holds no arm');
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('runs as a script and prints exactly one line', () => {
    const path = artifact(crossRun);
    try {
      const stdout = execFileSync(process.execPath, [TOOL, path], {
        encoding: 'utf8',
        env: { ...process.env, [REQUESTED_ENV]: 'select-mixed' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(stdout).toBe('select-mixed\n');
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('fails the process when there is no arm to print', () => {
    // The workflow substitutes the output into `--arm`, so a non-zero exit is the only thing that
    // stops the next step from being measured against an empty name.
    const path = artifact([{ arm: undefined }]);
    try {
      expect(() =>
        execFileSync(process.execPath, [TOOL, path], { encoding: 'utf8', env: { ...process.env, [REQUESTED_ENV]: 'select' }, stdio: ['ignore', 'pipe', 'pipe'] }),
      ).toThrow(/Command failed|exited with/);
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('reads the largest population when the environment says nothing', () => {
    const path = artifact(crossRun.slice(0, 4).concat([{ arm: 'select-cross' }]));
    try {
      const out: string[] = [];
      const err: string[] = [];
      expect(main([path], {}, (line) => out.push(line), (line) => err.push(line))).toBe(0);
      expect(out).toEqual(['select-mixed']);
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('turns whatever was thrown into a sentence', () => {
    // Both arms of the ternary, and the second one exists for a reason a test cannot reach through
    // `main`: every error this file raises is an `Error`.
    expect(message(new Error('no arm here'))).toBe('no arm here');
    expect(message('a thrown string')).toBe('a thrown string');
  });
});

describe('bird-dev.yml asks the tool instead of naming an arm', () => {
  const workflow = readFileSync(DEV_FILE, 'utf8');

  it('keeps no literal arm on any diagnostic step', () => {
    // The defect was a literal that outlived the assumption under it. `ci.yml` may keep a literal
    // arm because its arm list is fixed; the dev workflow may not, because its list is an input.
    // Only `run:` lines are read, because the prose around them quotes the old invocation.
    const commands = workflow.split('\n').filter((line) => line.trimStart().startsWith('run:'));
    expect(commands.length).toBeGreaterThan(10);
    for (const line of commands) expect(line).not.toMatch(/--arm\s+select\b/);
  });

  it('substitutes the chosen arm into every step that takes one', () => {
    const invocations = workflow.split('\n').filter((line) => line.includes('bench:bird:') && line.includes('--arm'));
    expect(invocations.length).toBe(5);
    for (const line of invocations) {
      expect(line).toContain('--arm "$(node tools/bird-arm.mjs eval/out/bird-eval.json)"');
    }
  });
});
