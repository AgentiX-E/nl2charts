/**
 * What the coverage gate does not measure, and why.
 *
 * The gate buckets by `packages/<name>/` and skips everything else in silence, so a
 * directory could carry a thousand lines of measurement code with no coverage number and
 * nothing would say so. It was not hypothetical: `eval/` — the harness every published
 * number comes out of — sits entirely outside the include glob, measured at 49.5% lines
 * when asked directly. A gate cannot defend a boundary it never drew.
 *
 * This test draws the boundary. Every source file in the repository is either inside the
 * coverage include globs declared in `vitest.config.ts`, or named here with a reason and a
 * task that will bring it inside. A new top-level directory, or a new file beside an
 * unmeasured one, fails this test rather than joining the silent majority.
 *
 * The declarations are also checked for rot: a reason for a file that no longer exists is a
 * reason nobody can act on.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');

/** Roots the coverage gate measures, read from the config rather than restated here. */
function measuredGlobs(): string[] {
  const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
  const block = /coverage:\s*\{[\s\S]*?include:\s*\[([^\]]*)\]/.exec(config);
  const list = block?.[1];
  if (list === undefined) throw new Error('vitest.config.ts has no coverage.include; the scope of the gate is unknown');
  return [...list.matchAll(/'([^']+)'/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

// A glob of the shape this repository uses: a directory wildcard, then src, then a suffix.
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '::DOUBLE::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE::/g, '(?:.*/)?');
  return new RegExp(`^${escaped}$`);
}

function sourceFiles(dir: string, suffixes: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      if (entry === 'node_modules' || entry === '.cache' || entry === 'out' || entry === 'dist') continue;
      const full = join(current, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else if (!entry.endsWith('.d.ts') && suffixes.some((suffix) => entry.endsWith(suffix))) out.push(relative(ROOT, full));
    }
  };
  walk(dir);
  return out;
}

/**
 * Directories deliberately outside the gate. The reason is not "it is hard": it is what the
 * code is and what stands in for a coverage number while the campaign lands.
 */
const UNMEASURED: readonly { readonly root: string; readonly suffixes: readonly string[]; readonly reason: string; readonly task: string }[] = [
  {
    root: 'eval',
    suffixes: ['.ts'],
    reason:
      'benchmark harness. Measured on request it is 49.5% lines / 86.6% functions / 87.1% branches; the gaps are the run entrypoints, which need a dataset and a model endpoint. Its correctness is currently held by the artifact gates and by the runs themselves',
    task: 'I-37',
  },
  {
    root: 'tools',
    suffixes: ['.mjs'],
    reason: 'gate scripts. Each is executed by gate:all, and every one that decides something carries a --self-test that runs in CI',
    task: 'I-37',
  },
];

describe('coverage scope', () => {
  const globs = measuredGlobs();
  const patterns = globs.map(globToRegExp);
  const isMeasured = (file: string): boolean => patterns.some((pattern) => pattern.test(file));

  it('measures the packages it claims to measure', () => {
    // The glob has to match real files, or the gate would pass over an empty set.
    const first = sourceFiles(join(ROOT, 'packages'), ['.ts']).filter((file) => file.includes('/src/'));
    expect(first.length).toBeGreaterThan(50);
    expect(first.every((file) => isMeasured(file))).toBe(true);
  });

  it('leaves no source file outside the gate without saying so', () => {
    const roots = readdirSync(ROOT).filter((entry) => {
      if (entry === 'node_modules' || entry === '.git' || entry === 'coverage' || entry.startsWith('.')) return false;
      return statSync(join(ROOT, entry)).isDirectory() && entry !== 'test' && entry !== 'docs';
    });
    const unmeasured = new Set(UNMEASURED.map((entry) => entry.root));
    for (const root of roots) {
      if (unmeasured.has(root)) continue;
      for (const file of sourceFiles(join(ROOT, root), ['.ts', '.mjs', '.tsx'])) {
        // Tests are not a coverage subject; they are the instrument.
        if (/\/test\//.test(file)) continue;
        // A directory may hold both measured and unmeasured code; only an unmeasured file
        // outside every declared root is the failure this test exists for.
        expect(isMeasured(file), `${file} is outside the coverage include and not declared unmeasured`).toBe(true);
      }
    }
  });

  it('declares nothing that has moved or vanished', () => {
    for (const entry of UNMEASURED) {
      expect(existsSync(join(ROOT, entry.root)), `the declaration for ${entry.root} names a root that does not exist`).toBe(true);
      const files = sourceFiles(join(ROOT, entry.root), entry.suffixes);
      expect(files.length, `the declaration for ${entry.root} covers no file`).toBeGreaterThan(0);
      // A declaration that has become measured is stale the other way: the campaign landed
      // and the reason now describes a file the gate does cover.
      expect(files.some((file) => isMeasured(file)), `${entry.root} is now measured; remove its declaration`).toBe(false);
      expect(entry.reason.length).toBeGreaterThan(40);
      expect(entry.task).toMatch(/^[A-Z]+-\d+[a-z]?$/);
    }
  });
});
