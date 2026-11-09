/**
 * Every command a document tells a reader to run.
 *
 * A document that says "reproduce it with `pnpm bench:bird:compare`" is making a promise about this
 * repository, and for five paragraphs in `docs/benchmarks.md` the promise was false: the script had
 * never been registered, so every one of those sentences was unexecutable. Nothing caught it,
 * because a command name is not a link a linter follows and not a symbol a compiler resolves.
 *
 * So the names become a checked set: every `pnpm <script>` in a document has to be a script in
 * `package.json`, and a typo gets the nearest real name as a suggestion rather than a shrug.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { audit, main, nearest, references } from '../tools/check-commands.mjs';

const SCRIPTS = { build: 'tsc', 'bench:bird': 'tsx eval/bird/run.ts', 'bench:bird:compare': 'tsx eval/bird/compare.ts' };

describe('reading a command out of prose', () => {
  it('finds one per line, with the line it is on', () => {
    const text = 'intro\nrun `pnpm build` first\n\nthen `pnpm bench:bird`\n';
    expect(references(text)).toEqual([
      { name: 'build', line: 2 },
      { name: 'bench:bird', line: 4 },
    ]);
  });

  it('reads the script out of `pnpm run`, and finds two on one line', () => {
    expect(references('`pnpm run build` or `pnpm bench:bird:compare`')).toEqual([
      { name: 'build', line: 1 },
      { name: 'bench:bird:compare', line: 1 },
    ]);
  });

  it('ignores the pnpm verbs that are not scripts', () => {
    const text = ['pnpm install', 'pnpm i', 'pnpm add left-pad', 'pnpm remove x', 'pnpm dlx foo', 'pnpm exec vitest', 'pnpm --filter core test', 'pnpm -C packages/core build'].join('\n');
    expect(references(text)).toEqual([]);
  });

  it('ignores a name that runs into punctuation, and keeps a scoped one', () => {
    expect(references('see (`pnpm gate:all`).')).toEqual([{ name: 'gate:all', line: 1 }]);
    expect(references('`pnpm @agentix-e/nl2charts-devkit`')).toEqual([{ name: '@agentix-e/nl2charts-devkit', line: 1 }]);
  });
});

describe('a name that is not a script', () => {
  it('passes every name package.json carries', () => {
    expect(audit([{ file: 'A.md', text: '`pnpm build`' }, { file: 'B.md', text: '`pnpm bench:bird:compare`' }], SCRIPTS)).toEqual([]);
  });

  it('reports the file, the line and the nearest real name', () => {
    const problems = audit([{ file: 'A.md', text: 'intro\n`pnpm bench:bird:comapre`\n' }], SCRIPTS);
    expect(problems).toEqual([{ file: 'A.md', line: 2, name: 'bench:bird:comapre', suggestion: 'bench:bird:compare' }]);
  });

  it('suggests nothing when the name is nowhere near a script', () => {
    expect(nearest('docker', Object.keys(SCRIPTS))).toBeUndefined();
    expect(audit([{ file: 'A.md', text: '`pnpm docker`' }], SCRIPTS)[0]?.suggestion).toBeUndefined();
  });

  it('prefers the nearer of two candidates', () => {
    expect(nearest('bench:bird:compar', Object.keys(SCRIPTS))).toBe('bench:bird:compare');
    expect(nearest('bench:bir', Object.keys(SCRIPTS))).toBe('bench:bird');
  });
});

describe('the command', () => {
  function repository(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'commands-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: SCRIPTS }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(root, name, '..'), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    return root;
  }

  it('passes when every command in every document exists', () => {
    const root = repository({ 'README.md': '`pnpm build`', 'docs/a.md': '`pnpm bench:bird`' });
    try {
      expect(main([], root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails on the one command that does not, and names it', () => {
    const root = repository({ 'README.md': '`pnpm build`', 'docs/a.md': '`pnpm bench:bird:compare` and `pnpm bench:bird:comapre`' });
    try {
      expect(main([], root)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes its own self-test', () => {
    expect(main(['--self-test'], process.cwd())).toBe(0);
  });

  it('refuses an argument it does not know', () => {
    expect(() => main(['--fix'], process.cwd())).toThrow(/unrecognized argument --fix/);
  });
});

describe('this repository', () => {
  it('documents only commands that exist', () => {
    expect(main([], join(import.meta.dirname, '..'))).toBe(0);
  });
});
