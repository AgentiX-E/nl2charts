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
 * `staleBuild` now compares the built declaration against the newest source in the package
 * and refuses to read a build that cannot contain the code being checked.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

/**
 * Whether a package's build predates its sources, or is missing.
 *
 * A snapshot check over a stale build is worse than no check: it prints "no drift" from
 * files that cannot contain the change. `missing` and `stale` are separate words because
 * they call for different fixes — build the tree, or check out the tree that has one.
 */
export function staleBuild(root, name) {
  const dist = join(root, 'packages', name, 'dist', 'index.d.ts');
  let built;
  try {
    built = statSync(dist).mtimeMs;
  } catch {
    return 'missing';
  }
  const newest = newestSource(join(root, 'packages', name, 'src'));
  if (newest === undefined) return undefined;
  return newest > built ? 'stale' : undefined;
}

/** The newest modification time under a source tree, in the same clock as the build. */
function newestSource(directory) {
  let newest;
  let entries;
  try {
    entries = readdirSync(directory, { recursive: true, withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const stats = statSync(join(entry.parentPath ?? directory, entry.name));
    if (newest === undefined || stats.mtimeMs > newest) newest = stats.mtimeMs;
  }
  return newest;
}

function main() {
  const update = process.argv.includes('--update');
  // Before anything is read: a build that cannot contain the change would report the previous
  // surface as current, and "no drift" from stale files is the one answer this check must
  // never give.
  const unbuilt = PACKAGES.map((name) => [name, staleBuild(ROOT, name)]).filter(([, state]) => state !== undefined);
  if (unbuilt.length > 0) {
    for (const [name, state] of unbuilt) {
      console.error(`A0: packages/${name}/dist is ${state}; run \`pnpm build\` before the snapshot check`);
    }
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
  console.log(`api surface: ${total} symbols across ${PACKAGES.length} packages, no drift`);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
