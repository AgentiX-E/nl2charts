#!/usr/bin/env node
/**
 * Bundle budget gate. Sizes are gzip bytes of every shipped JavaScript file in
 * dist/. A budget that is exceeded fails the build; raising it requires a
 * reviewed change to budgets.json.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const BUDGETS = JSON.parse(readFileSync(join(ROOT, 'budgets.json'), 'utf8'));
const BUDGET_BYTES = BUDGETS.packages ?? BUDGETS;
const PACKAGES = Object.keys(BUDGET_BYTES);

function gzipSize(path) {
  return gzipSync(readFileSync(path), { level: 9 }).length;
}

function distJavaScript(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.cjs')) files.push(path);
    }
  };
  walk(dir);
  return files;
}

let failed = false;
for (const name of PACKAGES) {
  const dir = join(ROOT, 'packages', name, 'dist');
  let total = 0;
  for (const file of distJavaScript(dir)) total += gzipSize(file);
  const budget = BUDGET_BYTES[name];
  const ok = total <= budget;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(8)} ${String(total).padStart(6)} B gzip / budget ${budget} B`);
  if (!ok) failed = true;
}

if (failed) {
  console.error('bundle budget: at least one package exceeded its budget');
  process.exit(1);
}
console.log(`bundle budget: ${PACKAGES.length} packages within budget`);
