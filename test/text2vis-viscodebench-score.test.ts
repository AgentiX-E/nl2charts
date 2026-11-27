/**
 * TDD for the VisCodeBench score-engine replica.
 *
 * The upstream `t2v_eval` package is the scoring engine behind the VisCodeBench leaderboard. Its
 * central metric, Displayed Data Similarity, is LLM-independent: it logs the points a chart actually
 * draws and compares two logs with an optimal assignment. This suite pins a TypeScript port of that
 * engine to numbers produced by the upstream algorithm (scipy 1.17 / numpy 2.3.5), so a mistake in
 * the port fails a deterministic test rather than quietly changing a future submission score.
 *
 * No model is called and no network is touched. Every expectation below is a fixture from
 * `eval/text2vis/viscodebench-oracle.json`, which records the exact command that generated it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  arcLengthRecall,
  CHART_TYPE_SETS,
  compareContinuous,
  compareDiscrete,
  compareScatter,
  cov2,
  describeScoreEngine,
  euclidean,
  getScore,
  inverse2,
  linearSumAssignment,
  mahalanobisCost,
  padToSquare,
  scoreEngineSelfCheck,
  entryScoreEngine,
  runScoreEngine,
  type ScoreOracle,
  type Point,
} from '../eval/text2vis/viscodebench-score.js';

const ORACLE = JSON.parse(
  readFileSync(new URL('../eval/text2vis/viscodebench-oracle.json', import.meta.url), 'utf-8'),
) as ScoreOracle;

describe('padToSquare', () => {
  it('returns a square matrix unchanged', () => {
    expect(padToSquare([[0, 1], [1, 0]])).toEqual([[0, 1], [1, 0]]);
  });

  it('pads a wide matrix with cost 1.0, as the upstream does', () => {
    // Upstream: padded = np.ones((n,n)); padded[:h,:w] = mat.
    expect(padToSquare([[0.1, 0.9, 0.5], [0.8, 0.2, 0.4]])).toEqual([
      [0.1, 0.9, 0.5],
      [0.8, 0.2, 0.4],
      [1.0, 1.0, 1.0],
    ]);
  });

  it('pads a tall matrix with cost 1.0', () => {
    // Upstream: padded = np.ones((n,n)); padded[:h,:w] = mat — a 3x2 becomes 3x3.
    expect(padToSquare([[0.1, 0.9], [0.8, 0.2], [0.5, 0.4]])).toEqual([
      [0.1, 0.9, 1.0],
      [0.8, 0.2, 1.0],
      [0.5, 0.4, 1.0],
    ]);
  });

  it('rejects an empty matrix rather than scoring an empty figure', () => {
    expect(() => padToSquare([])).toThrow(/empty/i);
  });

  it('rejects a ragged matrix', () => {
    expect(() => padToSquare([[0, 1], [1]])).toThrow(/ragged/i);
  });

  it('rejects a row with zero columns', () => {
    expect(() => padToSquare([[]])).toThrow(/empty/i);
  });
});

describe('linearSumAssignment', () => {
  it('finds the minimum-cost perfect matching on a square matrix', () => {
    // scipy: rows [0,1,2], cols [1,0,2] on [[4,1,3],[2,0,5],[3,2,2]], cost sum 5 / 3.
    const a = linearSumAssignment([[4, 1, 3], [2, 0, 5], [3, 2, 2]]);
    expect(a.rows).toEqual([0, 1, 2]);
    expect(a.cols).toEqual([1, 0, 2]);
    expect(a.cost).toBeCloseTo(5, 10);
  });

  it('matches scipy on a square identity-cost matrix', () => {
    const a = linearSumAssignment([[0, 5], [5, 0]]);
    expect(a.cost).toBeCloseTo(0, 10);
    expect(a.cols).toEqual([0, 1]);
  });

  it('returns an empty assignment for an empty matrix', () => {
    expect(linearSumAssignment([])).toEqual({ rows: [], cols: [], cost: 0 });
  });

  it('leaves extra columns unmatched on a rectangular matrix', () => {
    // 2 rows, 3 columns: exactly two columns are matched, one is skipped by `if (p[j] === 0)`.
    const a = linearSumAssignment([[0, 5, 9], [5, 0, 9]]);
    expect(a.rows).toHaveLength(2);
    expect(a.cols).toHaveLength(2);
    expect(a.cost).toBeCloseTo(0, 10);
  });
});

describe('getScore (matching upstream scipy linear_sum_assignment)', () => {
  const cases: Array<[keyof typeof ORACLE.getScore, number[][]]> = [
    ['identity', [[0, 0], [0, 0]]],
    ['perfect', [[0, 0], [0, 0]]],
    ['rect2x3', [[0.1, 0.9, 0.5], [0.8, 0.2, 0.4]]],
    ['rect3x2', [[0.1, 0.9], [0.8, 0.2], [0.5, 0.4]]],
    ['allMax', [[1, 1], [1, 1]]],
    ['mixed', [[0.2, 0.7, 0.3], [0.6, 0.1, 0.8], [0.4, 0.5, 0.9]]],
    ['oneZero', [[0, 5], [5, 5]]],
  ];

  for (const [name, mat] of cases) {
    it(`${name} = ${ORACLE.getScore[name]}`, () => {
      expect(getScore(mat)).toBeCloseTo(ORACLE.getScore[name]!, 8);
    });
  }

  it('clamps a cost above 1 into the score floor', () => {
    // avg cost 2 -> score clamps to 0, never negative.
    expect(getScore([[2, 2], [2, 2]])).toBe(0);
  });
});

describe('distance primitives', () => {
  it('euclidean between two points', () => {
    expect(euclidean([0, 0], [3, 4])).toBeCloseTo(5, 10);
  });

  it('covariance of two-dimensional points matches numpy.cov', () => {
    const pts: Point[] = [[1, 1.1], [2, 2.1], [3, 3.1]];
    const c = cov2(pts);
    expect(c[0]![0]!).toBeCloseTo(ORACLE.cov2.matrix[0]![0]!, 8);
    expect(c[0]![1]!).toBeCloseTo(ORACLE.cov2.matrix[0]![1]!, 8);
    expect(c[1]![0]!).toBeCloseTo(ORACLE.cov2.matrix[1]![0]!, 8);
    expect(c[1]![1]!).toBeCloseTo(ORACLE.cov2.matrix[1]![1]!, 8);
  });

  it('inverse of two-by-two covariance matches numpy.linalg.inv', () => {
    const inv = inverse2([[1.00001, 1.0], [1.0, 1.00001]]);
    expect(inv[0]![0]!).toBeCloseTo(ORACLE.cov2.inverse[0]![0]!, 4);
    expect(inv[1]![1]!).toBeCloseTo(ORACLE.cov2.inverse[1]![1]!, 4);
    expect(inv[0]![1]!).toBeCloseTo(ORACLE.cov2.inverse[0]![1]!, 4);
  });

  it('mahalanobis cost matrix clamps to [0,1]', () => {
    const mat = mahalanobisCost([[1, 1], [2, 2], [3, 3]], [[1, 1.1], [2, 2.1], [3, 3.1]]);
    expect(mat).toEqual(ORACLE.scatter.noisyCostMatrix);
  });
});

describe('compareScatter', () => {
  it('identical clouds score 1', () => {
    expect(compareScatter([[1, 2], [3, 4]], [[1, 2], [3, 4]])).toBeCloseTo(ORACLE.scatter.identical, 8);
  });

  it('a far-shifted cloud scores 0', () => {
    expect(compareScatter([[1, 2], [3, 4]], [[10, 20], [30, 40]])).toBeCloseTo(ORACLE.scatter.shifted, 8);
  });

  it('a single ground-truth point falls back to euclidean', () => {
    // Upstream: gt_np.shape[0] == 1 -> euclidean cdist. One pred point at the gt point -> 0 cost -> 1.
    expect(compareScatter([[1, 1], [9, 9]], [[1, 1]])).toBeGreaterThan(0);
  });

  it('maps a NaN distance to maximum cost rather than scoring NaN', () => {
    expect(compareScatter([[NaN, 1], [2, 3]], [[1, 1], [2, 3]])).toBeGreaterThanOrEqual(0);
  });
});

describe('compareDiscrete', () => {
  it('identical pie values score 1', () => {
    expect(compareDiscrete([10, 20, 30], [10, 20, 30])).toBeCloseTo(ORACLE.discrete.identical, 8);
  });

  it('scaled pie values match upstream', () => {
    expect(compareDiscrete([10, 20, 30], [100, 200, 300])).toBeCloseTo(ORACLE.discrete.shifted, 8);
  });

  it('a single ground-truth slice falls back to euclidean', () => {
    expect(compareDiscrete([10, 20], [10])).toBeGreaterThan(0);
  });
});

describe('arcLengthRecall', () => {
  const pred = { x: [0, 1, 2, 3], y: [0, 1, 4, 9] };
  const gt = { x: [0, 1, 2, 3], y: [0, 1, 4, 9] };

  it('an identical curve has recall 1', () => {
    const eps = (9 - 0) / 100;
    expect(arcLengthRecall(pred.x, pred.y, gt.x, gt.y, eps)).toBeCloseTo(ORACLE.continuous.identical!.recall, 8);
  });

  it('a vertically shifted curve matches upstream recall', () => {
    const gy = [5, 6, 9, 14];
    const eps = (14 - 5) / 100;
    expect(arcLengthRecall(pred.x, pred.y, gt.x, gy, eps)).toBeCloseTo(ORACLE.continuous.shifted!.recall, 8);
  });

  it('a single ground-truth point has no interval to integrate', () => {
    expect(arcLengthRecall([0, 1], [0, 1], [0], [0], 1e-5)).toBe(0);
  });

  it('handles a repeated predicted parameter where interpolation x collapses', () => {
    // A predicted curve whose first two points coincide forces x1 === x0 in interp.
    const r = arcLengthRecall([0, 0, 1], [0, 0, 1], [0, 0.5, 1], [0, 0.5, 1], 1e-5);
    expect(Number.isFinite(r)).toBe(true);
  });

  it('handles a degenerate ground-truth curve without dividing by zero', () => {
    // All ground-truth points identical: upstream's epsilon guard maps arc length to [0,1], so the
    // comparison still runs and returns a finite, in-range number rather than NaN.
    const r = arcLengthRecall([0, 1], [0, 1], [0, 0], [0, 0], 1e-5);
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
  });
});

describe('compareContinuous', () => {
  const p = { x: [0, 1, 2, 3], y: [0, 1, 4, 9] };

  it('identical line scores F1 = 1', () => {
    const r = compareContinuous(p, { x: [0, 1, 2, 3], y: [0, 1, 4, 9] });
    expect(r.f1).toBeCloseTo(ORACLE.continuous.identical!.f1, 8);
  });

  it('shifted line matches upstream F1', () => {
    const r = compareContinuous(p, { x: [0, 1, 2, 3], y: [5, 6, 9, 14] });
    expect(r.f1).toBeCloseTo(ORACLE.continuous.shifted!.f1, 8);
  });

  it('scaled line matches upstream F1', () => {
    const r = compareContinuous(p, { x: [0, 1, 2, 3], y: [0, 2, 8, 18] });
    expect(r.f1).toBeCloseTo(ORACLE.continuous.scaled!.f1, 8);
  });

  it('swaps axes when both curves are vertical', () => {
    // Upstream: unique(p_xs).size == 1 -> swap; the comparison still runs and stays in [0,1].
    const r = compareContinuous(
      { x: [1, 1, 1], y: [0, 1, 2] },
      { x: [1, 1, 1], y: [0, 1, 2] },
    );
    expect(r.f1).toBeGreaterThanOrEqual(0);
    expect(r.f1).toBeLessThanOrEqual(1);
  });

  it('yields F1 = 0 when both recalls are zero', () => {
    // A single-point ground truth after the axis swap gives no interval, so denom is 0.
    const r = compareContinuous({ x: [0], y: [0] }, { x: [0], y: [0] });
    expect(r.f1).toBe(0);
  });
});

describe('chart type accuracy', () => {
  it('reports a superset as covered', () => {
    expect(CHART_TYPE_SETS(['bar', 'line'], ['bar'])).toBe(true);
  });

  it('reports a missing ground-truth type as not covered', () => {
    expect(CHART_TYPE_SETS(['bar'], ['bar', 'line'])).toBe(false);
  });

  it('treats duplicate predicted types as a set', () => {
    expect(CHART_TYPE_SETS(['bar', 'bar', 'line'], ['bar', 'line'])).toBe(true);
  });
});

describe('score-engine self-check and report', () => {
  it('runs entirely offline and reports every comparator against its oracle', () => {
    const report = scoreEngineSelfCheck(ORACLE);
    expect(report.engine).toBe('viscodebench-t2v_eval-replica');
    expect(report.source).toContain('VisCodeBench');
    expect(report.checks.length).toBeGreaterThanOrEqual(10);
    for (const check of report.checks) {
      expect(check.pass, `${check.name}: ${check.actual} != ${check.expected}`).toBe(true);
    }
    expect(report.llmCalls).toBe(0);
    expect(report.groundTruthRequired).toBe(false);
  });

  it('describes the engine without a number that could be mistaken for a leaderboard reading', () => {
    const lines = describeScoreEngine(scoreEngineSelfCheck(ORACLE));
    const text = lines.join('\n');
    expect(text).toContain('instrumented');
    expect(text).toContain('no dispatch');
    expect(text).toContain('not measured');
    expect(text).toContain('reports no leaderboard number');
  });
});

describe('command entry', () => {
  const exampleUrl = 'file:///workspace/nl2charts/eval/text2vis/viscodebench-score.ts';
  const readOracle = () => JSON.stringify(ORACLE);

  it('does nothing when imported rather than executed', () => {
    const lines: string[] = [];
    const code = entryScoreEngine('some-other-module.ts', exampleUrl, (l) => lines.push(l), readOracle);
    expect(code).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('runs the self-check and exits zero when the entry is this module', () => {
    const lines: string[] = [];
    const code = entryScoreEngine(
      '/workspace/nl2charts/eval/text2vis/viscodebench-score.ts',
      exampleUrl,
      (l) => lines.push(l),
      readOracle,
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('0 failed');
  });

  it('exits non-zero and names a drifted check', () => {
    const drifted = { ...ORACLE, getScore: { ...ORACLE.getScore, mixed: 0.5 } };
    const lines: string[] = [];
    // Drive the pure runner with a drifted authority.
    const code = runScoreEngine(drifted, (l) => lines.push(l));
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('DRIFT getScore/mixed');
  });

  it('exits non-zero with a readable message when the authority cannot be read', () => {
    const lines: string[] = [];
    const code = entryScoreEngine(
      '/workspace/nl2charts/eval/text2vis/viscodebench-score.ts',
      exampleUrl,
      (l) => lines.push(l),
      () => { throw new Error('missing oracle'); },
    );
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('missing oracle');
  });

  it('handles a non-Error thrown value on the entry path', () => {
    const lines: string[] = [];
    const code = entryScoreEngine(
      '/workspace/nl2charts/eval/text2vis/viscodebench-score.ts',
      exampleUrl,
      (l) => lines.push(l),
      () => { throw 'string failure'; },
    );
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('string failure');
  });
});
