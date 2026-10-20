#!/usr/bin/env node
/**
 * Dependency layering guard (PKG1-PKG4 / PLT4).
 * A production package must never pull a package that breaks its runtime.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const EXPECTED = ['ai', 'chart', 'core', 'devkit', 'mcp', 'node', 'spec', 'studio'];

const FORBIDDEN = {
  spec: ['*'],
  core: ['chart', 'node', 'ai', 'mcp', 'studio', 'devkit'],
  chart: ['core', 'ai', 'node', 'mcp', 'studio', 'devkit'],
  node: ['chart', 'ai', 'mcp', 'studio', 'devkit'],
  ai: ['chart', 'node', 'mcp', 'studio', 'devkit'],
  mcp: ['chart', 'node', 'studio', 'devkit'],
  studio: ['core', 'ai', 'node', 'chart', 'mcp', 'devkit'],
  devkit: ['chart', 'node', 'mcp', 'studio'],
};

export function checkPackages(packages) {
  const issues = [];
  const names = packages.map((pkg) => pkg.short).sort();
  if (names.join(',') !== EXPECTED.join(',')) {
    issues.push(`PKG1: expected packages ${EXPECTED.join(',')} but found ${names.join(',')}`);
  }
  for (const pkg of packages) {
    const blocked = FORBIDDEN[pkg.short] ?? [];
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      if (!dependency.startsWith('@agentix-e/nl2charts-')) continue;
      const target = dependency.replace('@agentix-e/nl2charts-', '');
      const forbidden = blocked.includes('*') || blocked.includes(target);
      if (forbidden) issues.push(`PLT4: ${pkg.short} must not depend on ${target}`);
    }
    if (
      pkg.short !== 'devkit' &&
      Object.keys(pkg.dependencies ?? {}).includes('@agentix-e/nl2charts-devkit')
    ) {
      issues.push(`PKG2: production package ${pkg.short} depends on devkit`);
    }
  }
  return issues;
}

function loadPackages(root) {
  const base = join(root, 'packages');
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifest = JSON.parse(readFileSync(join(base, entry.name, 'package.json'), 'utf8'));
      return { short: entry.name, manifest };
    })
    .map(({ short, manifest }) => ({
      short,
      name: manifest.name,
      dependencies: manifest.dependencies ?? {},
      peerDependencies: manifest.peerDependencies ?? {},
      dependenciesOnSelf: manifest.name === `@agentix-e/nl2charts-${short}`,
    }));
}

function selfTest() {
  const base = EXPECTED.map((short) => ({
    short,
    name: `@agentix-e/nl2charts-${short}`,
    dependencies: {},
  }));
  const cases = [
    ['core depends on node', base.map((pkg) => (pkg.short === 'core' ? { ...pkg, dependencies: { '@agentix-e/nl2charts-node': 'workspace:*' } } : pkg)), 'PLT4'],
    ['chart depends on core', base.map((pkg) => (pkg.short === 'chart' ? { ...pkg, dependencies: { '@agentix-e/nl2charts-core': 'workspace:*' } } : pkg)), 'PLT4'],
    ['spec depends on core', base.map((pkg) => (pkg.short === 'spec' ? { ...pkg, dependencies: { '@agentix-e/nl2charts-core': 'workspace:*' } } : pkg)), 'PLT4'],
    ['mcp depends on devkit', base.map((pkg) => (pkg.short === 'mcp' ? { ...pkg, dependencies: { '@agentix-e/nl2charts-devkit': 'workspace:*' } } : pkg)), 'PKG2'],
    ['a package is missing', base.filter((pkg) => pkg.short !== 'studio'), 'PKG1'],
  ];
  let failures = 0;
  for (const [name, packages, expectedCode] of cases) {
    const issues = checkPackages(packages);
    const hit = issues.some((issue) => issue.startsWith(expectedCode));
    console.log(`${hit ? 'PASS' : 'FAIL'} mutation: ${name} -> ${issues.join('; ') || 'no issue'}`);
    if (!hit) failures += 1;
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const root = resolve(new URL('..', import.meta.url).pathname);
  if (process.argv.includes('--self-test')) {
    const failures = selfTest();
    console.log(failures === 0 ? 'layering self-test: 5/5 mutations detected' : `layering self-test: ${failures} missed`);
    process.exit(failures === 0 ? 0 : 1);
  }
  const packages = loadPackages(root);
  const issues = checkPackages(packages);
  for (const pkg of packages) {
    if (!pkg.dependenciesOnSelf) issues.push(`PKG3: directory ${pkg.short} declares ${pkg.name}`);
  }
  if (issues.length > 0) {
    for (const issue of issues) console.error(issue);
    process.exit(1);
  }
  console.log(`layering: ${packages.length} packages, 0 forbidden edges`);
}
