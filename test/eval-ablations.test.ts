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
import { ARMS, CASES, endsOf, evaluate, main as linkingMain, runLinkingAblation } from '../eval/linking-ablation.js';
import {
  buildQueries,
  equivalenceOf,
  fanoutRow,
  key,
  main as semanticMain,
  requireSemantic,
  runSemanticAblation,
  semanticProblems,
} from '../eval/semantic-ablation.js';
import type { SemanticReport } from '../eval/semantic-ablation.js';

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

describe('the semantic ablation on inputs that are wrong on purpose', () => {
  const query = { metrics: ['revenue'], dimensions: ['region'], filters: [] };
  const rows = (values: number[]): { revenue: number }[] => values.map((revenue) => ({ revenue }));

  it('counts a pair that disagrees, which the real fixture never produces', () => {
    // The property the file exists for is "the optimizer changed no result set". A report
    // that can only ever say `200/200` is not measuring that property, it is restating the
    // fixture; this drives the other side of the branch.
    const equivalence = equivalenceOf([
      { query, left: rows([1, 2]), right: rows([2, 1]) },
      { query, left: rows([1]), right: rows([2]) },
    ]);
    expect(equivalence.passed).toBe(1);
    expect(equivalence.total).toBe(2);
    expect(equivalence.rate).toBe(0.5);
    expect(equivalence.mismatches).toHaveLength(1);
  });

  it('compares result sets as multiset, not as text', () => {
    // Row order is not part of the answer: BIRD's own judge ignores it, and a comparator
    // that did not would report a mismatch on every plan that reorders a scan.
    expect(key(rows([1, 2]))).toBe(key(rows([2, 1])));
    expect(key(rows([1]))).not.toBe(key(rows([1, 1])));
  });

  it('has no division by zero when there is nothing to compare', () => {
    expect(equivalenceOf([]).rate).toBe(0);
  });

  it('measures fan-out only over the segment it asked for', () => {
    const entry = fanoutRow('smb', [{ segment: 'smb', revenue: 300 }, { segment: 'smb', revenue: 300 }], [{ segment: 'smb', revenue: 300 }]);
    expect(entry.naive).toBe(600);
    expect(entry.compiled).toBe(300);
    expect(entry.ratio).toBe(2);
    // A compiled row for another segment is not this segment's answer, and a missing
    // revenue is zero rather than NaN.
    const mixed = fanoutRow('smb', [{ revenue: 100 }], [{ segment: 'enterprise', revenue: 500 }]);
    expect(mixed.compiled).toBe(0);
    expect(mixed.ratio).toBe(0);
    // A row with no revenue column at all contributes zero, not NaN.
    expect(fanoutRow('smb', [{ segment: 'smb' }], [{ segment: 'smb', revenue: 2 }])).toEqual({
      query: 'smb',
      naive: 0,
      compiled: 2,
      ratio: 0,
    });
  });

  it('names both ways the measurement can have stopped measuring', () => {
    const base: SemanticReport = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      dataset: 'eval/fixtures/semantic.sql',
      cases: 2,
      equivalence: { passed: 2, total: 2, rate: 1, mismatches: [] },
      optimizer: { averageCtesOptimized: 1, averageCtesUnoptimized: 2, reduction: 0.5 },
      fanout: { cases: [], minRatio: 3 },
    };
    expect(semanticProblems(base)).toEqual([]);
    expect(semanticProblems({ ...base, equivalence: { passed: 1, total: 2, rate: 0.5, mismatches: ['{}'] } })).toEqual([
      'optimizer changed at least one result set',
    ]);
    expect(semanticProblems({ ...base, fanout: { cases: [], minRatio: 1.2 } })).toEqual([
      'fan-out fixture no longer reproduces the trap',
    ]);
    // The entry's exit path: a report that fails either condition is refused, and a report
    // that meets both is returned unchanged.
    expect(requireSemantic(base)).toBe(base);
    expect(() => requireSemantic({ ...base, fanout: { cases: [], minRatio: 0 } })).toThrow(
      'fan-out fixture no longer reproduces the trap',
    );
    expect(() =>
      requireSemantic({ ...base, equivalence: { passed: 0, total: 1, rate: 0, mismatches: ['{}'] }, fanout: { cases: [], minRatio: 0 } }),
    ).toThrow('optimizer changed at least one result set; fan-out fixture no longer reproduces the trap');
  });

  it('refuses a query budget the vocabulary cannot fill', () => {
    // 300 is above the 264 the metric/dimension/filter cross product yields after the
    // year-to-date grain guard, so the generator cannot honour it and says so.
    expect(buildQueries(264)).toHaveLength(264);
    expect(() => buildQueries(300)).toThrow(/expected 300 queries, generated 264/);
  });
});

describe('the ends of an arm chain', () => {
  it('takes the first arm as the baseline and the last as the best', () => {
    const arm = { arm: 'a', recallers: [], hits: 1, total: 2, recallAt3: 0.5, misses: [] };
    const other = { ...arm, arm: 'b', hits: 2, recallAt3: 1 };
    expect(endsOf([arm, other])).toEqual({ baseline: arm, best: other });
  });

  it('refuses an empty chain instead of dividing by nothing', () => {
    expect(() => endsOf([])).toThrow('no arms evaluated');
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

  it('defaults its artifact to eval/out', () => {
    const { outFile } = runLinkingAblation();
    expect(outFile.endsWith('/eval/out/linking-ablation.json')).toBe(true);
    rmSync(outFile, { force: true });
  });

  it('defaults the semantic artifact to eval/out too', async () => {
    // Both entries take an optional directory; a default that no test exercises is a path
    // nobody has written to. This one writes and then removes the file.
    const outFile = (await runSemanticAblation()).outFile;
    expect(outFile.endsWith('/eval/out/semantic-ablation.json')).toBe(true);
    rmSync(outFile, { force: true });
  });

  it('exits zero from both command-line entrypoints', async () => {
    expect(linkingMain({ outDir })).toBe(0);
    expect(await semanticMain({ outDir })).toBe(0);
  });
});
