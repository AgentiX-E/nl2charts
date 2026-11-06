#!/usr/bin/env node
/**
 * Bundle budget gate. Sizes are gzip bytes of the shipped JavaScript a consumer can reach from
 * the package's entry points.
 *
 * It reads `dist`, so it can measure the previous build as though it were this one: the audit
 * turn passed this gate locally by 735 B on a stale build and failed it in CI. `assertBuilt`
 * is the same guard the snapshot check uses, for the same reason.
 *
 * It used to sum *every* `.js` file under `dist`, which made the number depend on build history
 * rather than on source. One tree read 62,540 B (fail) and 58,891 B (pass) depending on whether
 * a turbo cache replay had left a chunk behind that the cached snapshot did not contain. The
 * measurement is now the import graph a consumer's `import` walks: every `exports` target, every
 * `main`/`module`, and everything those reach. Files nothing reaches are counted, reported and
 * *not* charged to the budget, because they are absent from a clean build and their presence is
 * a fact about the working tree, not about the package.
 *
 *   node tools/check-budgets.mjs             # measure and compare
 *   node tools/check-budgets.mjs --self-test # prove the graph reader on fixtures
 */
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, normalize, resolve } from 'node:path';
import { assertBuilt } from './stale-build.mjs';

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

/**
 * The relative specifiers one compiled module names.
 *
 * Static `import`/`export … from` are anchored to the start of a line because that is how
 * bundlers emit them, and anchoring is what keeps a string literal that happens to contain the
 * word `from` — this repository generates SQL for a living — from being read as an edge. Only
 * specifiers that point inside the package count: `node:fs` and `zod` are not files in `dist`,
 * and a resolver that pretended otherwise would report a broken build for a working one.
 */
export function specifiersOf(source) {
  const found = new Set();
  const patterns = [
    /^[ \t]*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /^[ \t]*import\s*['"]([^'"]+)['"]/gm,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith('./') || specifier.startsWith('../')) found.add(specifier);
    }
  }
  return [...found];
}

/** Node's file resolution, restricted to what a build emits: exact, `.js`, `.cjs`, `index`. */
export function resolveRelative(fromFile, specifier, known) {
  const base = normalize(join(dirname(fromFile), specifier));
  for (const candidate of [base, `${base}.js`, `${base}.cjs`, join(base, 'index.js'), join(base, 'index.cjs')]) {
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Every file reachable from `entries`, and every file that is not.
 *
 * `missing` is kept separate from `orphans` on purpose: a specifier that resolves to nothing is
 * a broken build, a file no specifier names is a leftover. Reading both as "not reachable" would
 * make a genuine breakage indistinguishable from a dirty directory.
 */
export function closureOf(entries, sources) {
  const reachable = new Set();
  const missing = [];
  const queue = [];
  for (const entry of entries) {
    if (sources.has(entry) && !reachable.has(entry)) {
      reachable.add(entry);
      queue.push(entry);
    }
  }
  while (queue.length > 0) {
    const file = queue.pop();
    for (const specifier of specifiersOf(sources.get(file) ?? '')) {
      const target = resolveRelative(file, specifier, sources);
      if (target === undefined) {
        missing.push(`${file} -> ${specifier}`);
      } else if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  const orphans = [...sources.keys()].filter((file) => !reachable.has(file)).sort();
  return { reachable, orphans, missing };
}

/** Entry files a consumer can name: every `exports` target, plus `main` and `module`. */
export function entriesOf(manifest) {
  const entries = new Set();
  const add = (value) => {
    if (typeof value === 'string' && !value.endsWith('.d.ts') && !value.endsWith('.d.cts')) entries.add(value);
  };
  const walk = (node) => {
    if (typeof node === 'string') add(node);
    else if (node !== null && typeof node === 'object') for (const [key, value] of Object.entries(node)) if (key !== 'types') walk(value);
  };
  walk(manifest.exports);
  add(manifest.main);
  add(manifest.module);
  return [...entries];
}

function selfTest() {
  let failures = 0;
  const same = (name, actual, expected) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    failures += 1;
    console.error(`FAIL ${name}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  };

  // Specifier reading. A bundle that names its chunks statically, a CJS require, a lazy import,
  // a side-effect import, and two things that must not be read as edges.
  const source = [
    'import { a } from "./chunk-A.js";',
    'export { b } from "./chunk-B.js";',
    'import "./side.js";',
    'const fs = require("./chunk-C.js");',
    'const lazy = () => import("./chunk-D.js");',
    'import { zod } from "zod";',
    'const query = "select name from people";',
    '// from "./commented.js"',
  ].join('\n');
  const found = specifiersOf(source);
  same('static import is an edge', found.filter((s) => s === './chunk-A.js'), ['./chunk-A.js']);
  same('re-export is an edge', found.filter((s) => s === './chunk-B.js'), ['./chunk-B.js']);
  same('side-effect import is an edge', found.filter((s) => s === './side.js'), ['./side.js']);
  same('require is an edge', found.filter((s) => s === './chunk-C.js'), ['./chunk-C.js']);
  same('dynamic import is an edge', found.filter((s) => s === './chunk-D.js'), ['./chunk-D.js']);
  same('a bare package is not an edge', found.filter((s) => s === 'zod'), []);
  same('SQL inside a string is not an edge', found.filter((s) => s.includes('people')), []);

  // Resolution. Compiled output always carries its extension, but a hand-written index or a
  // declaration-less layout does not, and a resolver that only accepted exact names would report
  // a healthy graph as broken.
  const known = new Set(['/d/index.js', '/d/chunk-A.js', '/d/chunk-B.cjs', '/d/linking/index.js']);
  same('exact hit', resolveRelative('/d/index.js', './chunk-A.js', known), '/d/chunk-A.js');
  same('extension is added', resolveRelative('/d/index.js', './chunk-A', known), '/d/chunk-A.js');
  same('cjs is found', resolveRelative('/d/index.js', './chunk-B', known), '/d/chunk-B.cjs');
  same('directory means index', resolveRelative('/d/index.js', './linking', known), '/d/linking/index.js');
  same('unknown is undefined', resolveRelative('/d/index.js', './absent.js', known), undefined);

  // Closure. Orphans are leftovers, missing edges are breakage, and a cycle terminates.
  const sources = new Map([
    ['/d/index.js', 'import { a } from "./a.js";'],
    ['/d/a.js', 'import { b } from "./b.js";\nimport { a } from "./a.js";'],
    ['/d/b.js', 'export const b = 1;'],
    ['/d/stale.js', 'export const s = 2;'],
    ['/d/linking.js', 'import { gone } from "./gone.js";'],
  ]);
  const closure = closureOf(['/d/index.js', '/d/linking.js'], sources);
  same('cycle terminates and everything reachable is found', [...closure.reachable].sort(), ['/d/a.js', '/d/b.js', '/d/index.js', '/d/linking.js']);
  same('leftover is an orphan', closure.orphans, ['/d/stale.js']);
  same('unresolvable specifier is missing, not an orphan', closure.missing, ['/d/linking.js -> ./gone.js']);

  // Entry derivation. Subpath exports are entries because a consumer may name them; a `.d.ts`
  // is not, because it is not shipped JavaScript and has no import graph.
  same(
    'exports tree yields every js target',
    entriesOf({
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.cjs' },
        './linking': { types: './dist/linking.d.ts', import: './dist/linking.js' },
      },
      main: './dist/index.cjs',
      module: './dist/index.js',
    }).sort(),
    ['./dist/index.cjs', './dist/index.js', './dist/linking.js'],
  );

  if (failures > 0) {
    console.error(`check-budgets self-test: ${String(failures)} failure(s)`);
    process.exit(1);
  }
  console.log('check-budgets self-test: 14 assertions');
}

function measure() {
  const unbuilt = assertBuilt(ROOT, PACKAGES);
  if (unbuilt.length > 0) {
    for (const problem of unbuilt) console.error(problem);
    process.exit(1);
  }

  let failed = false;
  for (const name of PACKAGES) {
    const dir = join(ROOT, 'packages', name, 'dist');
    const files = distJavaScript(dir);
    const sources = new Map(files.map((file) => [resolve(file), readFileSync(file, 'utf8')]));
    const manifest = JSON.parse(readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8'));
    const entries = entriesOf(manifest)
      .map((entry) => resolve(join(ROOT, 'packages', name, entry)))
      .filter((entry) => sources.has(entry));
    if (entries.length === 0) {
      console.error(`FAIL ${name}: no entry point from package.json resolves inside dist — the closure is not measurable`);
      failed = true;
      continue;
    }
    const { reachable, orphans, missing } = closureOf(entries, sources);
    if (missing.length > 0) {
      // A specifier that resolves to nothing means the build is broken, and a broken build must
      // not be priced: the bytes of the missing chunk are absent from every total below.
      for (const edge of missing) console.error(`FAIL ${name}: ${edge} resolves to nothing`);
      failed = true;
      continue;
    }
    let total = 0;
    for (const file of reachable) total += gzipSize(file);
    const budget = BUDGET_BYTES[name];
    const ok = total <= budget;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${name.padEnd(8)} ${String(total).padStart(6)} B gzip / budget ${String(budget)} B  (${String(reachable.size)} of ${String(sources.size)} files)`,
    );
    if (orphans.length > 0) {
      const wasted = orphans.reduce((sum, file) => sum + gzipSize(file), 0);
      // Reported, not charged. A cached build replayed over a dirty `dist` leaves chunks the
      // snapshot did not contain; they are absent from a clean build, so pricing them would make
      // the same source read two different numbers — which is the defect this reader replaced.
      console.log(
        `     ${name.padEnd(8)} ${String(orphans.length).padStart(6)} file(s) no entry reaches, ${String(wasted)} B gzip not counted; \`rm -rf packages/${name}/dist\` and rebuild to clear`,
      );
    }
    if (!ok) failed = true;
  }

  if (failed) {
    console.error('bundle budget: at least one package exceeded its budget');
    process.exit(1);
  }
  console.log(`bundle budget: ${String(PACKAGES.length)} packages within budget`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  if (process.argv.includes('--self-test')) selfTest();
  else measure();
}
