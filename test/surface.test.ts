import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertBuilt, staleBuild } from '../tools/stale-build.mjs';
import * as spec from '@agentix-e/nl2charts-spec';
import * as core from '@agentix-e/nl2charts-core';
import * as ai from '@agentix-e/nl2charts-ai';
import * as node from '@agentix-e/nl2charts-node';
import * as chart from '@agentix-e/nl2charts-chart';
import * as mcp from '@agentix-e/nl2charts-mcp';
import * as studio from '@agentix-e/nl2charts-studio';
import * as devkit from '@agentix-e/nl2charts-devkit';

/**
 * Public surface snapshot. A1 of the compatibility rules: an export that
 * disappears is a breaking change and must be accompanied by a major bump.
 */
const SURFACE: Record<string, readonly string[]> = {
  spec: ['CONTRACT_VERSION', 'Nl2ChartsError', 'chartIrJsonSchema', 'isNl2ChartsError', 'parseChartIR', 'safeParseChartIR'],
  core: ['canonicalRow', 'canonicalValue', 'createCapabilities', 'createRunner', 'hashRows', 'inspectSql', 'negotiate', 'resultSetsEqual', 'withRowLimit'],
  ai: [
    'auditMessages',
    'buildConditionAuditFeedback',
    'buildSqlPrompt',
    'countNamedConditions',
    'createHttpProvider',
    'createPipeline',
    'createReplayProvider',
    'extractSql',
    'formatProfile',
    'linkSchema',
    'parseChoiceToken',
    'recordProvider',
    'replyShape',
    'turnTemperature',
  ],
  node: ['createDuckDbEngine', 'createFileCache'],
  chart: ['compileToECharts', 'enumerateCandidates', 'isRenderable', 'lint', 'profileRows'],
  mcp: ['attachStreams', 'createMcpServer', 'encodeMessage'],
  studio: ['hasErrors', 'inferAdditivity', 'validateModel'],
  devkit: ['recordCase', 'runContractSuite'],
};

describe('package surface', () => {
  const modules: Record<string, Record<string, unknown>> = { spec, core, ai, node, chart, mcp, studio, devkit };

  it.each(Object.keys(SURFACE))('%s exports every documented symbol', (name) => {
    const exported = modules[name] ?? {};
    for (const symbol of SURFACE[name] ?? []) {
      expect(exported[symbol], `${name} is missing ${symbol}`).toBeDefined();
    }
  });

  it('keeps the contract version pinned to the design', () => {
    expect(spec.CONTRACT_VERSION).toBe('3.0');
  });

  it('exposes subpath entry points', async () => {
    const guard = await import('@agentix-e/nl2charts-core/guard');
    const linking = await import('@agentix-e/nl2charts-ai/linking');
    const llm = await import('@agentix-e/nl2charts-ai/llm');
    const duckdb = await import('@agentix-e/nl2charts-node/duckdb');
    const cache = await import('@agentix-e/nl2charts-node/cache');
    expect(typeof guard.inspectSql).toBe('function');
    expect(typeof linking.linkSchema).toBe('function');
    expect(typeof llm.createHttpProvider).toBe('function');
    expect(typeof duckdb.createDuckDbEngine).toBe('function');
    expect(typeof cache.createFileCache).toBe('function');
  });
});

/**
 * The snapshot check reads `dist`, which is why it used to be able to say "no drift" about a
 * change that was not built: run 41255435708 failed in CI on three exports that had passed
 * this gate locally minutes earlier, because the local `dist` predated the module. `staleBuild`
 * is the guard that makes the difference visible before the push.
 */
describe('the snapshot refuses to read a build it cannot trust', () => {
  const root = mkdtempSync(join(tmpdir(), 'nl2charts-api-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const build = (name: string, options: { readonly built?: boolean; readonly builtAt?: number; readonly srcAt?: number }): void => {
    mkdirSync(join(root, 'packages', name, 'src', 'nested'), { recursive: true });
    mkdirSync(join(root, 'packages', name, 'dist'), { recursive: true });
    writeFileSync(join(root, 'packages', name, 'src', 'index.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'packages', name, 'src', 'nested', 'module.ts'), 'export const b = 2;\n');
    if (options.built !== false) {
      const file = join(root, 'packages', name, 'dist', 'index.d.ts');
      writeFileSync(file, 'export declare const a: number;\n');
      utimesSync(file, new Date(options.builtAt ?? 1_000_000), new Date(options.builtAt ?? 1_000_000));
    }
    if (options.srcAt !== undefined) {
      for (const source of ['index.ts', join('nested', 'module.ts')]) {
        utimesSync(join(root, 'packages', name, 'src', source), new Date(options.srcAt), new Date(options.srcAt));
      }
    }
  };

  it('says a build that is newer than every source is usable', () => {
    build('fresh', { builtAt: 2_000_000, srcAt: 1_000_000 });
    expect(staleBuild(root, 'fresh')).toBeUndefined();
  });

  it('names a build older than a source it should contain', () => {
    // The nested file is the point: a check that only compares `src/index.ts` would miss the
    // module that was added, which is the exact shape of the failure this guard exists for.
    build('old', { builtAt: 1_000_000, srcAt: 2_000_000 });
    expect(staleBuild(root, 'old')).toBe('stale');
  });

  it('names a package that was never built at all', () => {
    build('unbuilt', { built: false });
    expect(staleBuild(root, 'unbuilt')).toBe('missing');
  });

  it('lists every package whose build cannot be trusted, in the order it was asked', () => {
    // The two gates share this line, so the order is the caller's list and not a sort: a build
    // log is read top to bottom, and the package that must be rebuilt first should print first.
    expect(assertBuilt(root, ['fresh', 'old', 'unbuilt'])).toEqual([
      'A0: packages/old/dist is stale; run `pnpm build` before this check',
      'A0: packages/unbuilt/dist is missing; run `pnpm build` before this check',
    ]);
  });

  it('does not invent a verdict for a package with no sources', () => {
    mkdirSync(join(root, 'packages', 'empty', 'dist'), { recursive: true });
    writeFileSync(join(root, 'packages', 'empty', 'dist', 'index.d.ts'), 'export declare const a: number;\n');
    expect(staleBuild(root, 'empty')).toBeUndefined();
  });
});
