import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expandDatabases, promote } from '../eval/bird/fetch.mjs';

// The dev split ships its databases one archive down and that inner archive has its own
// root, which is why `bird-dev` failed the first time it ran in CI. These tests build the
// same layout with real zips: no mocks, no download.

const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nl2charts-fetch-'));
  dirs.push(dir);
  return dir;
}

function sqlite(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'SQLite format 3\u0000');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('promote', () => {
  it('moves the archive root to the directory the harness reads', () => {
    const dir = workspace();
    const root = join(dir, 'dev_20240627');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'dev.json'), '[]');

    promote(root, join(dir, 'dev', 'dev_20240627'));

    expect(existsSync(join(dir, 'dev', 'dev_20240627', 'dev.json'))).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it('merges instead of replacing, because the split is extracted twice', () => {
    // The first pass writes the questions, the second writes the databases. Replacing
    // the directory on the second pass deleted the questions — the failure this test
    // exists for.
    const dir = workspace();
    const dataDir = join(dir, 'dev', 'dev_20240627');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'dev.json'), '[]');

    const root = join(dir, 'dev_20240627');
    mkdirSync(join(root, 'dev_databases', 'a'), { recursive: true });
    sqlite(join(root, 'dev_databases', 'a', 'a.sqlite'));

    promote(root, dataDir);

    expect(readFileSync(join(dataDir, 'dev.json'), 'utf8')).toBe('[]');
    expect(existsSync(join(dataDir, 'dev_databases', 'a', 'a.sqlite'))).toBe(true);
  });

  it('does nothing when the archive already extracted in place', () => {
    const dir = workspace();
    expect(() => promote(join(dir, 'minidev', 'MINIDEV'), join(dir, 'minidev', 'MINIDEV'))).not.toThrow();
  });
});

describe('expandDatabases', () => {
  function archiveWith(root: string): string {
    const build = workspace();
    const inner = join(build, root, 'dev_databases');
    sqlite(join(inner, 'superhero', 'superhero.sqlite'));
    sqlite(join(inner, 'financial', 'financial.sqlite'));
    const archive = join(build, 'dev_databases.zip');
    execFileSync('zip', ['-qr', archive, root], { cwd: build });
    return archive;
  }

  it('finds dev_databases under the inner archive’s own root', () => {
    const archive = archiveWith('dev_20240627');
    const destination = workspace();
    expandDatabases(archive, destination);
    expect(existsSync(join(destination, 'dev_databases', 'superhero', 'superhero.sqlite'))).toBe(true);
    expect(existsSync(join(destination, 'dev_databases', 'financial', 'financial.sqlite'))).toBe(true);
  });

  it('also accepts an archive whose databases are at the top level', () => {
    const archive = archiveWith('.');
    const destination = workspace();
    // `zip -r … .` writes entries without a root directory; the helper must not depend on
    // one, because the two splits disagree about it.
    const flat = join(workspace(), 'flat.zip');
    execFileSync('zip', ['-qr', flat, 'dev_databases'], { cwd: join(archive, '..') });
    expandDatabases(flat, destination);
    expect(existsSync(join(destination, 'dev_databases', 'superhero', 'superhero.sqlite'))).toBe(true);
  });

  it('refuses an archive with no databases rather than reporting success', () => {
    const build = workspace();
    writeFileSync(join(build, 'notes.txt'), 'nothing here');
    const archive = join(build, 'empty.zip');
    execFileSync('zip', ['-qr', archive, 'notes.txt'], { cwd: build });
    expect(() => expandDatabases(archive, workspace())).toThrow(/layout changed/);
  });
});
