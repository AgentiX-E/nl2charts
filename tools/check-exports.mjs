#!/usr/bin/env node
/**
 * Public API snapshot (rules A1-A5). Any change to the exported surface must be
 * an explicit commit: an export that silently disappears is a breaking change.
 *
 * Usage: node tools/check-exports.mjs [--update]
 *
 * It reads `dist`, so run `pnpm build` first: a stale `dist` reports the previous
 * surface as current, and that is how a new export passed this check locally and
 * failed it in CI, where the build runs first.
 *
 * That paragraph used to be the whole defence, and it is not one: the check passed on a
 * tree whose `dist` predated the module under test, and the missing export surfaced in CI
 * a cycle later (run 41255435708, `ai exports auditMessages without a snapshot update`).
 * `stale-build.mjs` now compares the built declaration against the newest source in the
 * package — nested modules included — and refuses to read a build that cannot contain the
 * code being checked. The budget gate shares it, because it reads the same files.
 *
 * One more number lives beside this one and had drifted: the README's gate table said "430 symbols
 * snapshotted" while the snapshot held 539, and it had said 430 for as long as anybody could tell —
 * a hand-typed count in prose is a checked-in claim about a file, and nothing was comparing the two.
 * The count is now read from the same list this check builds, so the sentence cannot outlive it:
 * a README that quotes a symbol count quotes *this* run's.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertBuilt } from './stale-build.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SNAPSHOT = join(ROOT, 'api-surface.json');
const PACKAGES = ['spec', 'core', 'ai', 'node', 'chart', 'mcp', 'studio', 'devkit'];
const SUBPATHS = {
  core: { guard: 'guard.d.ts', normalize: 'normalize.d.ts', negotiate: 'negotiate.d.ts', semantic: 'semantic/index.d.ts' },
  ai: { linking: 'linking.d.ts', llm: 'provider.d.ts' },
  node: { duckdb: 'duckdb.d.ts', cache: 'cache.d.ts' },
};

export function extractExports(dts) {
  const names = new Set();
  for (const match of dts.matchAll(/export\s+declare\s+(?:function|const|class|interface|type)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  for (const match of dts.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const cleaned = part.trim();
      if (cleaned.length === 0) continue;
      const alias = cleaned.split(/\s+as\s+/);
      names.add((alias[1] ?? alias[0]).trim());
    }
  }
  return [...names].sort();
}

function main() {
  const update = process.argv.includes('--update');
  // Before anything is read: a build that cannot contain the change would report the previous
  // surface as current, and "no drift" from stale files is the one answer this check must
  // never give.
  const unbuilt = assertBuilt(ROOT, PACKAGES);
  if (unbuilt.length > 0) {
    for (const problem of unbuilt) console.error(problem);
    process.exit(1);
  }
  const current = {};
  for (const name of PACKAGES) {
    current[name] = extractExports(readFileSync(join(ROOT, 'packages', name, 'dist', 'index.d.ts'), 'utf8'));
    for (const [subpath, file] of Object.entries(SUBPATHS[name] ?? {})) {
      current[`${name}/${subpath}`] = extractExports(readFileSync(join(ROOT, 'packages', name, 'dist', file), 'utf8'));
    }
  }

  if (update) {
    writeFileSync(SNAPSHOT, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`api surface: wrote ${SNAPSHOT}`);
    return;
  }

  const before = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const diffs = [];
  for (const name of Object.keys(current)) {
    const expected = new Set(before[name] ?? []);
    const actual = new Set(current[name] ?? []);
    for (const symbol of expected) {
      if (!actual.has(symbol)) diffs.push(`A1: ${name} no longer exports ${symbol}`);
    }
    for (const symbol of actual) {
      if (!expected.has(symbol)) diffs.push(`A4: ${name} exports ${symbol} without a snapshot update`);
    }
  }
  if (diffs.length > 0) {
    for (const diff of diffs) console.error(diff);
    process.exit(1);
  }
  const total = Object.values(current).reduce((sum, list) => sum + list.length, 0);
  // The README quotes the count in one sentence and the sentence is part of the gate table, so a
  // stale number there reads exactly like a current one. It is compared rather than removed: a
  // number a reader can sanity-check is worth keeping, and keeping it by derivation is the only
  // way it stays true.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const quoted = /\((\d+) symbols snapshotted\)/.exec(readme);
  if (quoted === null) {
    console.error('A6: README.md no longer quotes the snapshot size, so the gate table has no count to check');
    process.exit(1);
  }
  if (Number(quoted[1]) !== total) {
    console.error(`A6: README.md says ${quoted[1]} symbols snapshotted, the snapshot holds ${total}`);
    process.exit(1);
  }
  console.log(`api surface: ${total} symbols across ${PACKAGES.length} packages, no drift`);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
