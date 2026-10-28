/**
 * Two ablations that decide what a prompt is allowed to contain.
 *
 * The linking ablation asks whether the schema linker needs aliases and stored values to
 * put the right columns in the top three — the number the prompt budget is spent on. The
 * semantic ablation asks whether the optimizer changes a result (it must not) and whether
 * the fan-out trap is still reproduced by the fixture (it must, or the measurement has
 * stopped measuring).
 *
 * Both ran as scripts whose assertions only fired in a job; both are functions now, so the
 * assertions are the test.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ARMS, CASES, evaluate, main as linkingMain, runLinkingAblation } from '../eval/linking-ablation.js';
import { buildQueries, main as semanticMain, runSemanticAblation } from '../eval/semantic-ablation.js';

const outDir = mkdtempSync(join(tmpdir(), 'nl2charts-ablations-'));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe('schema-linking ablation', () => {
  it('adds one recaller per arm and keeps the case set fixed', () => {
    const arms = Object.entries(ARMS);
    expect(arms).toHaveLength(3);
    expect(arms[0]?.[1]).toEqual(['name']);
    expect(arms[2]?.[1]).toEqual(['name', 'alias', 'value']);
    expect(CASES.length).toBeGreaterThanOrEqual(20);
    // Every expected column is qualified: an unqualified expectation would match anything.
    for (const testCase of CASES) for (const column of testCase.expected) expect(column).toContain('.');
  });

  it('measures recall@3 per arm and attributes the gain to the value recaller', () => {
    const { arms, baseline, best, gainPp, outFile } = runLinkingAblation({ outDir });
    expect(arms).toHaveLength(3);
    expect(baseline.arm).toBe('name');
    expect(best.arm).toBe('name+alias+value');
    expect(best.hits).toBeGreaterThanOrEqual(baseline.hits);
    expect(gainPp).toBeCloseTo((best.recallAt3 - baseline.recallAt3) * 100, 6);
    // 64pp is the number the prompt budget is spent on, and it is measured, not claimed:
    // five cases reach their columns on names alone, twenty-one when aliases and stored
    // values are offered as well.
    expect(gainPp).toBeGreaterThanOrEqual(50);
    expect(best.recallAt3).toBeGreaterThan(baseline.recallAt3);
    expect(best.misses.length).toBeLessThan(baseline.misses.length);
    const artifact = JSON.parse(readFileSync(outFile, 'utf8')) as { cases: number; topK: number; arms: { arm: string }[] };
    expect(artifact.cases).toBe(CASES.length);
    expect(artifact.topK).toBe(3);
    expect(artifact.arms.map((arm) => arm.arm)).toEqual(['name', 'name+alias', 'name+alias+value']);
  });

  it('reports the misses of an arm that cannot reach the expected column', () => {
    // `orders.product` is only reachable through its stored values ("widget", "gizmo"), so a
    // name-only linker has to miss it. If this ever passes, the fixture stopped testing the
    // value recaller.
    const nameOnly = evaluate(['name']);
    expect(nameOnly.misses.length).toBeGreaterThan(0);
    expect(nameOnly.misses.join('\n')).toContain('widget');
    expect(nameOnly.hits).toBe(CASES.length - nameOnly.misses.length);
  });
});

describe('semantic compiler ablation', () => {
  it('builds exactly the 200 queries the report is quoted on', () => {
    const queries = buildQueries();
    expect(queries).toHaveLength(200);
    // Every ytd query carries a month dimension; a year-to-date metric without one has no
    // grain to be cumulative along.
    for (const query of queries) {
      if (query.metrics.includes('ytd_revenue')) expect(query.dimensions).toContain('month');
    }
  });

  it('changes the SQL but not a single result set, and still reproduces fan-out', async () => {
    const { report, outFile } = await runSemanticAblation({ outDir });
    expect(report.cases).toBe(200);
    expect(report.equivalence.passed).toBe(report.equivalence.total);
    expect(report.equivalence.mismatches).toEqual([]);
    // The optimizer has to actually do something, or "equivalent" is a statement about
    // SQL that was never rewritten.
    expect(report.optimizer.reduction).toBeGreaterThan(0);
    expect(report.optimizer.averageCtesUnoptimized).toBeGreaterThan(report.optimizer.averageCtesOptimized);
    expect(report.fanout.minRatio).toBeGreaterThanOrEqual(2);
    expect(report.fanout.cases.map((entry) => entry.query)).toEqual(['smb', 'enterprise', 'consumer']);
    for (const entry of report.fanout.cases) expect(entry.naive).toBeGreaterThan(entry.compiled);
    const artifact = JSON.parse(readFileSync(outFile, 'utf8')) as { cases: number };
    expect(artifact.cases).toBe(200);
  });
});

describe('ablation entrypoints', () => {
  it('logs every arm and its misses when a logger is supplied, and stays silent without one', () => {
    const lines: string[] = [];
    runLinkingAblation({ outDir, log: (line) => lines.push(line) });
    expect(lines[0]).toContain('recall@3');
    // One line per arm plus one per miss, then the summary: a reader of the job log sees
    // both the rate and the questions that produced it.
    expect(lines.some((line) => line.includes('MISS'))).toBe(true);
    expect(lines[lines.length - 1]).toContain('value profiler adds');
    const quiet = runLinkingAblation({ outDir });
    expect(quiet.arms).toHaveLength(3);
  });

  it('exits zero from both command-line entrypoints', async () => {
    expect(linkingMain({ outDir })).toBe(0);
    expect(await semanticMain({ outDir })).toBe(0);
  });
});
