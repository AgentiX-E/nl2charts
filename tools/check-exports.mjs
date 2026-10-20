#!/usr/bin/env node
/**
 * Public API snapshot (rules A1-A5). Any change to the exported surface must be
 * an explicit commit: an export that silently disappears is a breaking change.
 *
 * Usage: node tools/check-exports.mjs [--update]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SNAPSHOT = join(ROOT, 'api-surface.json');
const PACKAGES = ['spec', 'core', 'ai', 'node', 'chart', 'mcp', 'studio', 'devkit'];

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
  const current = {};
  for (const name of PACKAGES) {
    const dts = readFileSync(join(ROOT, 'packages', name, 'dist', 'index.d.ts'), 'utf8');
    current[name] = extractExports(dts);
  }

  if (update) {
    writeFileSync(SNAPSHOT, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`api surface: wrote ${SNAPSHOT}`);
    return;
  }

  const before = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const diffs = [];
  for (const name of PACKAGES) {
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

main();
