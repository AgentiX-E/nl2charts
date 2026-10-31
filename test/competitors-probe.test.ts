/**
 * The probe that runs before any model call is spent.
 *
 * A clone of `main` is a clone of whatever `main` was that afternoon, and a patch written against
 * one commit stops applying against the next without saying so. Both are cheap to detect and
 * invisible afterwards, so the probe is tested against a real git repository rather than a stub:
 * the checkout, the head, and `git apply --check` are the three things it reports on, and all three
 * are git's answers rather than this repository's.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  failureDetail,
  main,
  probeLines,
  probeTree,
  readPins,
  writeProbeArtifact,
} from '../eval/competitors/probe.js';

const git = (tree: string, ...args: string[]): string =>
  execFileSync('git', ['-C', tree, ...args], { encoding: 'utf8' }).trim();

interface Checkout {
  readonly tree: string;
  readonly pins: string;
  readonly patch: string;
  readonly head: string;
}

/** A repository shaped like a pin: an entrypoint, a requirements file and a file to patch. */
function checkout(over: Record<string, unknown> = {}): Checkout {
  const tree = mkdtempSync(join(tmpdir(), 'probe-tree-'));
  mkdirSync(join(tree, 'src'), { recursive: true });
  writeFileSync(join(tree, 'src', 'main.py'), 'print("run")\n');
  writeFileSync(join(tree, 'requirements.txt'), '# deps\nopenai==0.28.1\nsqlparse\n\n');
  writeFileSync(join(tree, 'core.py'), 'api_type = "azure"\n');
  mkdirSync(join(tree, 'run'), { recursive: true });
  writeFileSync(join(tree, 'run', 'config.yaml'), 'setting: pinned\n');
  git(tree, 'init', '-q', '.');
  git(tree, 'config', 'user.email', 'test@example.com');
  git(tree, 'config', 'user.name', 'test');
  git(tree, 'add', '-A');
  git(tree, 'commit', '-qm', 'pinned');
  const head = git(tree, 'rev-parse', 'HEAD');

  writeFileSync(join(tree, 'core.py'), 'api_type = "openai"\n');
  const patch = mkdtempSync(join(tmpdir(), 'probe-patch-'));
  const patchPath = join(patch, 'adapter.patch');
  writeFileSync(patchPath, `${git(tree, 'diff')}\n`);
  git(tree, 'checkout', '--', '.');

  const pins = join(mkdtempSync(join(tmpdir(), 'probe-pins-')), 'pins.json');
  writeFileSync(
    pins,
    JSON.stringify({
      fake: {
        repo: 'someone/fake',
        commit: head,
        entrypoint: 'src/main.py',
        requirements: 'requirements.txt',
        patch: patchPath,
        modelHook: 'core.py',
        config: 'run/config.yaml',
        probe: ['core.py'],
        ...over,
      },
    }),
  );
  return { tree, pins, patch: patchPath, head };
}

describe('a checkout that matches its pin', () => {
  it('reports the head, the files, the patch state and the install size', () => {
    const base = checkout();
    const report = probeTree(base.pins, base.tree, 'fake');
    expect(report.pinned).toBe(true);
    expect(report.head).toBe(base.head);
    expect(report.files.every((file) => file.present)).toBe(true);
    expect(report.patch?.applies).toBe(true);
    // A comment and a blank line are not pinned lines: the count prices the install.
    expect(report.requirementLines).toBe(2);
    expect(report.problems).toEqual([]);
    expect(main(['--pins', base.pins, '--tree', base.tree, '--name', 'fake', '--out', join(base.tree, 'probe.json')])).toBe(0);
  });

  it('writes the report where it is asked to, with the pin inside it', () => {
    const base = checkout();
    const report = probeTree(base.pins, base.tree, 'fake');
    const path = writeProbeArtifact(join(base.tree, 'nested', 'probe.json'), report);
    const body = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    expect(body.commit).toBe(base.head);
    expect(body.pinned).toBe(true);
    expect(body.patch.applies).toBe(true);
  });

  it('prints one line per coordinate it checked', () => {
    const base = checkout();
    const lines = probeLines(probeTree(base.pins, base.tree, 'fake'));
    expect(lines[0]).toContain('@ ');
    expect(lines[0]).toContain('(pinned: yes)');
    expect(lines[1]).toBe('  files: 5/5 present');
    expect(lines[2]).toBe('  adapter patch: applies');
    expect(lines[3]).toBe('  requirements: 2 pinned lines');
    expect(lines).toHaveLength(4);
  });
});

describe('a checkout that does not match its pin', () => {
  it('reports a head that moved, and fails the step', () => {
    const base = checkout();
    writeFileSync(join(base.tree, 'src', 'main.py'), 'print("changed")\n');
    git(base.tree, 'commit', '-qam', 'later');
    const report = probeTree(base.pins, base.tree, 'fake');
    expect(report.pinned).toBe(false);
    expect(report.problems[0]).toContain('checkout is');
    expect(report.problems[0]).toContain('pin says');
    expect(main(['--pins', base.pins, '--tree', base.tree, '--name', 'fake', '--out', join(base.tree, 'probe.json')])).toBe(1);
  });

  it('reports a pin that is a branch or a short sha instead of refusing to read it', () => {
    const base = checkout({ commit: 'main' });
    const report = probeTree(base.pins, base.tree, 'fake');
    expect(report.problems).toContain('pin main is not a full sha');
    expect(probeLines(report).some((line) => line.includes('PROBLEM  pin main is not a full sha'))).toBe(true);
  });

  it('reports a file the pin names that the checkout does not carry', () => {
    const base = checkout({ entrypoint: 'src/does-not-exist.py' });
    const report = probeTree(base.pins, base.tree, 'fake');
    expect(report.problems).toContain('src/does-not-exist.py is not in the checkout');
    expect(report.files.find((file) => file.path === 'src/does-not-exist.py')?.present).toBe(false);
  });

  it('reports an adapter patch that no longer applies, with the reason git gave', () => {
    const base = checkout();
    writeFileSync(base.patch, '--- a/core.py\n+++ b/core.py\n@@ -1 +1 @@\n-api_type = "something else"\n+api_type = "openai"\n');
    const report = probeTree(base.pins, base.tree, 'fake');
    expect(report.patch?.applies).toBe(false);
    expect(report.problems[0]).toContain('the adapter patch does not apply');
    expect(probeLines(report)[2]).toContain('does not apply');
  });

  it('reports a patch file that this repository does not carry', () => {
    const base = checkout({ patch: 'eval/competitors/patches/missing.patch' });
    const report = probeTree(base.pins, base.tree, 'fake', '/nonexistent-root');
    expect(report.patch?.applies).toBe(false);
    expect(report.patch?.error).toContain('is not in this repository');
  });

  it('reports an unreadable requirements file instead of pricing it at zero', () => {
    const base = checkout({ requirements: 'nope.txt' });
    const report = probeTree(base.pins, base.tree, 'fake');
    expect(report.requirementLines).toBeUndefined();
    expect(report.problems).toContain('cannot read nope.txt, so the install is unpriced');
  });
});

describe('the pins file itself', () => {
  it('refuses a name it does not carry, listing the ones it does', () => {
    const base = checkout();
    expect(() => probeTree(base.pins, base.tree, 'nope')).toThrow(/has no pin named nope; it holds fake/);
  });

  it('refuses a pins file that is not a map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pins-'));
    const path = join(dir, 'pins.json');
    writeFileSync(path, '[]');
    expect(() => readPins(path)).toThrow(/is not a map of pins/);
  });

  it('needs both a name and a checkout', () => {
    expect(() => main([])).toThrow(/usage: probe.ts --name/);
    expect(() => main(['--name', 'fake'])).toThrow(/usage: probe.ts --name/);
    expect(() => main(['--name', 'fake', '--tree'])).toThrow(/--tree needs a value/);
  });
});

describe('a pin that names only what it needs', () => {
  it('probes a checkout with no adapter at all, and reports no patch to apply', () => {
    const base = checkout();
    const pins = join(mkdtempSync(join(tmpdir(), 'probe-minimal-')), 'pins.json');
    writeFileSync(
      pins,
      JSON.stringify({ bare: { repo: 'someone/bare', commit: base.head, entrypoint: 'src/main.py', requirements: 'requirements.txt' } }),
    );
    const report = probeTree(pins, base.tree, 'bare');
    expect(report.patch).toBeUndefined();
    expect(report.problems).toEqual([]);
    const lines = probeLines(report);
    expect(lines.some((line) => line.includes('adapter patch'))).toBe(false);
  });
});

describe('the failure a git refusal becomes', () => {
  it('prefers the diagnostic git wrote to stderr', () => {
    const error = Object.assign(new Error('Command failed'), { stderr: 'error: patch failed\n  context\n' });
    expect(failureDetail(error)).toBe('error: patch failed context');
  });

  it('falls back to the message when nothing was written to stderr', () => {
    expect(failureDetail(new Error('spawn git ENOENT'))).toBe('spawn git ENOENT');
    expect(failureDetail(Object.assign(new Error('x'), { stderr: '   ' }))).toBe('x');
  });

  it('accepts something that is not an Error, because a throw is not obliged to be one', () => {
    expect(failureDetail('git disappeared')).toBe('git disappeared');
    expect(failureDetail(undefined)).toBe('undefined');
  });

  it('truncates a diagnostic that would fill a log', () => {
    expect(failureDetail(new Error('x'.repeat(400)))).toHaveLength(300);
  });
});

describe('the defaults the workflow relies on', () => {
  it('reads the repository pins file and writes the artifact under eval/out', () => {
    const base = checkout();
    const root = mkdtempSync(join(tmpdir(), 'probe-root-'));
    mkdirSync(join(root, 'eval', 'competitors'), { recursive: true });
    writeFileSync(join(root, 'eval', 'competitors', 'pins.json'), readFileSync(base.pins, 'utf8'));
    expect(main(['--tree', base.tree, '--name', 'fake'], root)).toBe(0);
    const written = JSON.parse(readFileSync(join(root, 'eval', 'out', 'competitors', 'fake-probe.json'), 'utf8')) as Record<string, any>;
    expect(written.pinned).toBe(true);
  });
});
