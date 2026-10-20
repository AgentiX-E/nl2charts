#!/usr/bin/env node
/**
 * Per-package coverage gate. The global vitest threshold can hide a package
 * that is barely tested but small; this gate aggregates each package on its own
 * and requires 95% on all four dimensions.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const THRESHOLD = Number(process.env.COVERAGE_THRESHOLD ?? 95);
const summary = JSON.parse(readFileSync(join(ROOT, 'coverage/coverage-summary.json'), 'utf8'));

const dimensions = ['statements', 'branches', 'functions', 'lines'];
const byPackage = new Map();
for (const [file, metrics] of Object.entries(summary)) {
  if (file === 'total') continue;
  const match = /packages\/([^/]+)\//.exec(file);
  if (!match) continue;
  const pkg = match[1];
  const bucket = byPackage.get(pkg) ?? Object.fromEntries(dimensions.map((dimension) => [dimension, { covered: 0, total: 0 }]));
  for (const dimension of dimensions) {
    bucket[dimension].covered += metrics[dimension].covered;
    bucket[dimension].total += metrics[dimension].total;
  }
  byPackage.set(pkg, bucket);
}

let failed = false;
if (byPackage.size === 0) {
  console.error('coverage gate: no package coverage found; run pnpm test:coverage first');
  process.exit(1);
}
for (const [pkg, bucket] of [...byPackage.entries()].sort()) {
  const cells = dimensions.map((dimension) => {
    const { covered, total } = bucket[dimension];
    const pct = total === 0 ? 100 : (covered / total) * 100;
    return `${dimension.slice(0, 2)}=${pct.toFixed(2)}`;
  });
  const bad = dimensions.filter((dimension) => {
    const { covered, total } = bucket[dimension];
    return total === 0 ? false : (covered / total) * 100 < THRESHOLD;
  });
  if (bad.length > 0) failed = true;
  console.log(`${bad.length === 0 ? 'PASS' : 'FAIL'} ${pkg.padEnd(8)} ${cells.join(' ')}`);
}

if (failed) {
  console.error(`coverage gate: every dimension of every package must be >= ${THRESHOLD}%`);
  process.exit(1);
}
console.log(`coverage gate: ${byPackage.size} packages, all dimensions >= ${THRESHOLD}%`);
