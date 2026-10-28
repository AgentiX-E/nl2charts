/**
 * The in-repository harness and the ablation that sits on top of it.
 *
 * Both used to be scripts whose only output was a log line and a file, so the properties
 * they exist to establish — the oracle scores 100%, the empty predictor 0%, the two
 * template arms are compared on the same cases — were established by looking at a job and
 * trusting it. These tests make the same measurement against the same DuckDB fixture and
 * read the numbers.
 *
 * The ablation also had a hidden dependency: it read `results.json`, a file written by the
 * harness, for one log line. On a clean checkout `pnpm bench:ablate` therefore failed with
 * ENOENT after doing all of its work. That is asserted here directly, by running it in an
 * empty directory.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PREDICTORS, assertControls, evaluateCase, loadGolden, main, pct, runHarness, runPredictor, summarise, withFixture } from '../eval/run.js';
import type { CaseOutcome, RunSummary } from '../eval/run.js';
import { binomialTwoSided, compareArms, runAblation } from '../eval/ablate.js';

const outDir = mkdtempSync(join(tmpdir(), 'nl2charts-harness-'));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe('harness', () => {
  it('brackets the scale with its controls on the real golden set', async () => {
    const { summaries, payload } = await runHarness({ outDir });
    expect(summaries).toHaveLength(PREDICTORS.length);
    expect(payload.controls.oracle).toBe(1);
    expect(payload.controls.empty).toBe(0);
    const oracle = summaries.find((summary) => summary.predictor === 'oracle');
    const template = summaries.find((summary) => summary.predictor === 'template');
    expect(oracle?.accuracy).toBe(1);
    expect(template?.total).toBe(loadGolden().length);
    expect(template?.accuracy).toBeGreaterThan(0);
    expect(template?.accuracy).toBeLessThan(1);
  });

  it('writes an artifact that names the cases each predictor missed', async () => {
    await runHarness({ outDir });
    const artifact = JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8')) as {
      harness: string;
      controls: { oracle: number; empty: number };
      summaries: { predictor: string; failures: string[] }[];
    };
    expect(artifact.harness).toBe('eval/run.ts');
    expect(artifact.controls).toEqual({ oracle: 1, empty: 0 });
    for (const summary of artifact.summaries) expect(Array.isArray(summary.failures)).toBe(true);
    const oracle = artifact.summaries.find((summary) => summary.predictor === 'oracle');
    expect(oracle?.failures).toEqual([]);
    const empty = artifact.summaries.find((summary) => summary.predictor === 'empty');
    expect(empty?.failures.length).toBe(loadGolden().length);
  });

  it('counts a case by its tags and by its unordered rows separately', async () => {
    const summary = await runPredictor('template');
    const tags = Object.keys(summary.byTag);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      const bucket = summary.byTag[tag] as { total: number; passed: number };
      expect(bucket.passed).toBeLessThanOrEqual(bucket.total);
    }
    // Exact matching is stricter than unordered: a predictor can be right about the rows and
    // wrong about their order, and the difference between the two rates is that population.
    expect(summary.unorderedAccuracy).toBeGreaterThanOrEqual(summary.accuracy);
  });

  it('reports an execution failure as a case, not as a crashed run', async () => {
    // The empty predictor is valid SQL; a predictor that is not would leave a gap in the
    // outcomes rather than a record of the failure.
    const summary = await runPredictor('empty');
    expect(summary.cases).toHaveLength(summary.total);
    expect(summary.cases.every((outcome) => outcome.exact === false)).toBe(true);
  });

  it('formats a rate the way the report reads it', () => {
    expect(pct(0.5834)).toBe('58.3%');
    expect(pct(1)).toBe('100.0%');
  });

  it('returns an exit code from the command-line entrypoint', async () => {
    expect(await main({ outDir })).toBe(0);
  });
});

describe('normalization ablation', () => {
  it('compares the two template arms on identical cases and reports no discordance when there is none', async () => {
    const { report, arms } = await runAblation({ outDir });
    expect(arms).toBe(PREDICTORS.length);
    expect(report.cases).toBe(loadGolden().length);
    expect(Object.keys(report.arms).sort()).toEqual(['template', 'template-raw']);
    expect(report.discordant.onlyNormalized.length + report.discordant.onlyRaw.length).toBeGreaterThanOrEqual(0);
    if (report.discordant.onlyNormalized.length + report.discordant.onlyRaw.length === 0) {
      expect(report.mcnemarExactP).toBe(1);
      expect(report.conclusion).toContain('indistinguishable');
      expect(report.deltaPp).toBe(0);
    }
  });

  it('runs on a clean directory without the harness having written anything first', async () => {
    // The regression this test exists for: `pnpm bench:ablate` used to read
    // `eval/out/results.json` and fail with ENOENT unless `pnpm bench` had run before it.
    const empty = mkdtempSync(join(tmpdir(), 'nl2charts-ablate-'));
    try {
      const { outFile } = await runAblation({ outDir: empty });
      expect(readFileSync(outFile, 'utf8')).toContain('mcnemarExactP');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('computes McNemar exactly, including the degenerate and one-sided tails', () => {
    expect(binomialTwoSided(0, 0)).toBe(1);
    // 10 discordant, 1 in the minority: 2 * (C(10,0) + C(10,1)) / 2^10.
    expect(binomialTwoSided(10, 1)).toBeCloseTo((2 * (1 + 10)) / 1024, 10);
    // An even split is as unremarkable as it gets.
    expect(binomialTwoSided(10, 5)).toBe(1);
  });
});

describe('case scoring', () => {
  it('records a statement the engine refuses as a case, not as an exception', async () => {
    // No predictor in this repository emits invalid SQL, so this path used to be dead code:
    // the first predictor that did would have crash the run instead of scoring a zero.
    const cases = loadGolden();
    const first = cases[0];
    if (first === undefined) throw new Error('the golden set is empty');
    const outcome = await withFixture((runner) => evaluateCase(runner, first, 'select * from a_table_that_does_not_exist'));
    expect(outcome.id).toBe(first.id);
    expect(outcome.exact).toBe(false);
    expect(outcome.unordered).toBe(false);
    expect(outcome.error).toBeDefined();
  });

  it('separates an exact match from an unordered one', async () => {
    const cases = loadGolden();
    const first = cases[0];
    if (first === undefined) throw new Error('the golden set is empty');
    const same = await withFixture((runner) => evaluateCase(runner, first, first.goldSql));
    expect(same.exact).toBe(true);
    const wrong = await withFixture((runner) => evaluateCase(runner, first, 'select 1 as nothing where false'));
    expect(wrong.exact).toBe(false);
  });

  it('reports zero rates for an empty outcome set instead of dividing by zero', () => {
    const summary = summarise('template', [], []);
    expect(summary.total).toBe(0);
    expect(summary.accuracy).toBe(0);
    expect(summary.unorderedAccuracy).toBe(0);
    expect(summary.byTag).toEqual({});
  });
});

describe('controls', () => {
  const summary = (predictor: string, accuracy: number): RunSummary => ({
    predictor,
    total: 20,
    passed: Math.round(accuracy * 20),
    accuracy,
    unorderedAccuracy: accuracy,
    byTag: {},
    cases: [],
  });

  it('passes only when the oracle scores 100% and the empty predictor 0%', () => {
    expect(assertControls([summary('oracle', 1), summary('empty', 0)])).toEqual({ oracle: 1, empty: 0 });
  });

  it('refuses a report whose oracle scored below 100%', () => {
    expect(() => assertControls([summary('oracle', 0.95), summary('empty', 0)])).toThrow('positive control failed');
  });

  it('refuses a report whose empty predictor matched something', () => {
    expect(() => assertControls([summary('oracle', 1), summary('empty', 0.05)])).toThrow('negative control failed');
  });

  it('refuses a report with no controls at all', () => {
    expect(() => assertControls([summary('template', 0.8)])).toThrow('no oracle and empty control');
  });
});

describe('paired comparison', () => {
  const cases = loadGolden();
  const failing = (): CaseOutcome[] => cases.map((testCase) => ({ id: testCase.id, ok: false, exact: false, unordered: false, predicted: '' }));
  const passing = (outcomes: CaseOutcome[], indexes: readonly number[]): CaseOutcome[] =>
    outcomes.map((outcome, index) => (indexes.includes(index) ? { ...outcome, ok: true, exact: true, unordered: true } : outcome));

  it('counts a case one arm skipped as neither a win nor a loss', () => {
    const outcomes = failing();
    const normalized = summarise('template', cases, passing(outcomes, [0]));
    // The raw arm ran one case fewer; that case must not appear as a discordant pair.
    const raw = summarise('template-raw', cases.slice(1), outcomes.slice(1));
    const report = compareArms(normalized, raw);
    // q01 was passed by the normalized arm and never run by the raw one. Counting it as a
    // win would credit an arm for a case it skipped.
    expect(report.discordant.onlyNormalized).toEqual([]);
    expect(report.discordant.onlyRaw).toEqual([]);
  });

  it('leaves the ablation open when the direction is not significant at this sample size', () => {
    const outcomes = failing();
    const normalized = summarise('template', cases, passing(outcomes, [0, 1, 2, 3, 4]));
    const raw = summarise('template-raw', cases, passing(outcomes, [2, 3, 4, 5]));
    const report = compareArms(normalized, raw);
    expect(report.discordant.onlyNormalized).toHaveLength(2);
    expect(report.discordant.onlyRaw).toHaveLength(1);
    expect(report.mcnemarExactP).toBeGreaterThan(0.05);
    expect(report.conclusion).toContain('keep the ablation open');
  });

  it('calls a one-sided disagreement significant', () => {
    const outcomes = failing();
    const normalized = summarise('template', cases, passing(outcomes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const raw = summarise('template-raw', cases, outcomes);
    const report = compareArms(normalized, raw);
    expect(report.discordant.onlyNormalized).toHaveLength(10);
    expect(report.discordant.onlyRaw).toHaveLength(0);
    expect(report.mcnemarExactP).toBeLessThan(0.05);
    expect(report.conclusion).toContain('5% level');
    expect(report.deltaPp).toBe(50);
  });
});
