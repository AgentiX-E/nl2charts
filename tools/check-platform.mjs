#!/usr/bin/env node
/**
 * Platform boundary guard (PLT1-PLT7).
 *
 * PLT1/PLT2/PLT7 are decided from an esbuild metafile rather than by searching
 * the bundle text: a tree-shaken import never reaches the output, so string
 * matching silently passes a broken package.
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

function packageNameOf(modulePath) {
  if (/^node:/.test(modulePath)) return modulePath;
  const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(modulePath);
  if (match) return match[1];
  return modulePath;
}

export function violationsFromMetafile(metafile) {
  const issues = [];
  for (const module of Object.keys(metafile.inputs ?? {})) {
    const name = packageNameOf(module);
    if (/^node:/.test(name)) issues.push(`PLT1: browser graph imports ${name}`);
    if (/^(pg|mysql2|better-sqlite3)$/.test(name)) issues.push(`PLT2: browser graph imports ${name}`);
    if (/^@duckdb\//.test(name)) issues.push(`PLT2: browser graph imports ${name}`);
    if (name === '@agentix-e/nl2charts-ai') issues.push(`PLT7: core graph imports ${name}`);
    if (/^(openai|@anthropic-ai\/sdk|@google\/generative-ai)$/.test(name)) issues.push(`PLT7: core graph imports ${name}`);
  }
  return issues;
}

export function typeLeaks(dtsText) {
  const issues = [];
  const pattern = /(?:from|import\()\s*['"](node:[^'"]+|pg|mysql2|better-sqlite3|@duckdb\/[^'"]+)['"]/g;
  for (const match of dtsText.matchAll(pattern)) {
    issues.push(`PLT3: public types reference ${match[1]}`);
  }
  return issues;
}

async function bundleCore(entryDir) {
  try {
    const result = await build({
      entryPoints: [join(entryDir, 'index.ts')],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'browser',
      format: 'esm',
      logLevel: 'silent',
      external: ['@agentix-e/nl2charts-spec', '@agentix-e/nl2charts-core'],
    });
    return { metafile: result.metafile, errorText: '' };
  } catch (error) {
    // An unresolvable node builtin is itself a browser-build failure, which is
    // exactly the violation PLT1 describes.
    return { metafile: { inputs: {} }, errorText: String(error?.message ?? error) };
  }
}

export function violationsFromBuildError(text) {
  const issues = [];
  if (/Could not resolve "node:/.test(text)) issues.push('PLT1: browser build cannot resolve a node: builtin');
  if (/Could not resolve "(pg|mysql2|better-sqlite3|@duckdb\/)/.test(text)) {
    issues.push('PLT2: browser build cannot resolve a native driver');
  }
  if (/Could not resolve "@agentix-e\/nl2charts-ai/.test(text)) issues.push('PLT7: browser build cannot resolve the ai package');
  return issues;
}

async function realChecks() {
  const issues = [];
  const coreEntry = join(ROOT, 'packages/core/src');
  const bundle = await bundleCore(coreEntry);
  issues.push(...violationsFromMetafile(bundle.metafile), ...violationsFromBuildError(bundle.errorText));

  for (const entry of ['index.d.ts', 'guard.d.ts', 'normalize.d.ts', 'negotiate.d.ts']) {
    const path = join(ROOT, 'packages/core/dist', entry);
    try {
      issues.push(...typeLeaks(readFileSync(path, 'utf8')));
    } catch {
      issues.push(`PLT3: missing declaration ${entry}; run pnpm build first`);
    }
  }

  const nodeDts = readFileSync(join(ROOT, 'packages/node/dist/index.d.ts'), 'utf8');
  for (const forbidden of ['createAgent', 'askStream', 'createAdminHandler']) {
    if (new RegExp(`\\b${forbidden}\\b`).test(nodeDts)) issues.push(`PLT5: node package exports ${forbidden}`);
  }

  const specSource = readFileSync(join(ROOT, 'packages/spec/src/errors.ts'), 'utf8');
  if (!specSource.includes("Symbol.for('@agentix-e/nl2charts/error')")) issues.push('PLT6: error brand is not registered globally');
  if (/instanceof\s+Nl2ChartsError/.test(specSource)) issues.push('PLT6: error identity relies on instanceof');

  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) sources.push(path);
    }
  };
  for (const pkg of readdirSync(join(ROOT, 'packages'))) walk(join(ROOT, 'packages', pkg, 'src'));
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    if (/instanceof\s+(Nl2ChartsError|EngineBase|DuckDbEngine)/.test(text)) {
      issues.push(`PLT6: ${file.replace(ROOT + '/', '')} uses instanceof across a package boundary`);
    }
  }
  return issues;
}

async function selfTest() {
  const failures = [];
  const record = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} mutation: ${name}${detail ? ` -> ${detail}` : ''}`);
    if (!ok) failures.push(name);
  };

  const clean = await bundleCore(join(ROOT, 'packages/core/src'));
  const cleanIssues = [...violationsFromMetafile(clean.metafile), ...violationsFromBuildError(clean.errorText)];
  record('baseline core bundle is platform-clean', cleanIssues.length === 0, cleanIssues.join('; '));

  const workdir = mkdtempSync(join(ROOT, 'packages/core/.plt-'));
  const fakePackage = (name, code) => {
    const dir = join(workdir, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), code);
  };
  try {
    const copy = join(workdir, 'src1');
    cpSync(join(ROOT, 'packages/core/src'), copy, { recursive: true });
    writeFileSync(
      join(copy, 'index.ts'),
      `${readFileSync(join(copy, 'index.ts'), 'utf8')}\nimport { readFile } from 'node:fs/promises';\nexport const _mut = readFile;\n`,
    );
    const plt1Build = await bundleCore(copy);
    const plt1Issues = [...violationsFromMetafile(plt1Build.metafile), ...violationsFromBuildError(plt1Build.errorText)];
    record('PLT1 root imports node:fs', plt1Issues.some((issue) => issue.startsWith('PLT1')), plt1Issues.join('; '));

    fakePackage('pg', 'export const Pool = class {};\nexport default { Pool };');
    const copy2 = join(workdir, 'src2');
    cpSync(join(ROOT, 'packages/core/src'), copy2, { recursive: true });
    writeFileSync(
      join(copy2, 'index.ts'),
      `${readFileSync(join(copy2, 'index.ts'), 'utf8')}\nimport pg from 'pg';\nexport const _pg = pg;\n`,
    );
    const plt2Build = await bundleCore(copy2);
    const plt2Issues = [...violationsFromMetafile(plt2Build.metafile), ...violationsFromBuildError(plt2Build.errorText)];
    record('PLT2 root imports a driver', plt2Issues.some((issue) => issue.startsWith('PLT2')), plt2Issues.join('; '));

    fakePackage('@agentix-e/nl2charts-ai', 'export const createAgent = () => null;');
    const copy3 = join(workdir, 'src3');
    cpSync(join(ROOT, 'packages/core/src'), copy3, { recursive: true });
    writeFileSync(
      join(copy3, 'index.ts'),
      `${readFileSync(join(copy3, 'index.ts'), 'utf8')}\nexport { createAgent } from '@agentix-e/nl2charts-ai';\n`,
    );
    const plt7Build = await bundleCore(copy3);
    const plt7Issues = [...violationsFromMetafile(plt7Build.metafile), ...violationsFromBuildError(plt7Build.errorText)];
    record('PLT7 core imports the ai package', plt7Issues.some((issue) => issue.startsWith('PLT7')), plt7Issues.join('; '));
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }

  const leak = typeLeaks("import type { Pool } from 'pg';\nexport type X = Pool;");
  record('PLT3 public types leak a driver', leak.some((issue) => issue.startsWith('PLT3')), leak.join('; '));
  const cleanTypes = typeLeaks("import type { ChartIR } from '@agentix-e/nl2charts-spec';\nexport type X = ChartIR;");
  record('PLT3 baseline types are clean', cleanTypes.length === 0, cleanTypes.join('; '));

  const fakeNodeDts = 'export declare function createAgent(): void;';
  record('PLT5 node package exports orchestration', /\bcreateAgent\b/.test(fakeNodeDts));

  const fakeSource = 'if (x instanceof Nl2ChartsError) {}';
  record('PLT6 identity uses instanceof', /instanceof\s+Nl2ChartsError/.test(fakeSource));

  console.log(failures.length === 0 ? 'platform self-test: 7/7 mutations detected' : `platform self-test: ${failures.length} missed`);
  return failures.length;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  if (process.argv.includes('--self-test')) {
    const failures = await selfTest();
    process.exit(failures === 0 ? 0 : 1);
  }
  const issues = await realChecks();
  if (issues.length > 0) {
    for (const issue of issues) console.error(issue);
    process.exit(1);
  }
  console.log('platform: PLT1-PLT7 clean (metafile + declarations + source scan)');
}
