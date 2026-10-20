import { describe, expect, it } from 'vitest';
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
  ai: ['buildSqlPrompt', 'createHttpProvider', 'createPipeline', 'createReplayProvider', 'extractSql', 'linkSchema', 'recordProvider'],
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
