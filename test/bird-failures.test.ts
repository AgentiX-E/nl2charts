import { describe, expect, it } from 'vitest';
import { FAILURE_SAMPLE, failureCorpus } from '../eval/bird/failures.js';

const run = (id: string, passed: boolean) => ({
  id,
  passed,
  predicted: `SELECT ${id}`,
  reason: 'values',
});

describe('the failure corpus', () => {
  it('keeps the failures and drops the passes', () => {
    const { failures, failureSample } = failureCorpus([['arm', [run('1', true), run('2', false), run('3', false)]]], 10, () => 'q');
    expect(failures.arm).toHaveLength(2);
    expect(failures.arm?.[0]).toEqual({ id: '2', question: 'q', predicted: 'SELECT 2', reason: 'values' });
    expect(failureSample.total.arm).toBe(2);
    expect(failureSample.truncated).toEqual([]);
  });

  it('says which arms it truncated, and by how much', () => {
    // The defect this replaces: `slice(0, 25)` with no record, so a 1.4% sample of a
    // dev arm's failures read as the census.
    const many = Array.from({ length: 30 }, (_, index) => run(String(index), false));
    const { failures, failureSample } = failureCorpus([['big', many], ['small', many.slice(0, 3)]], 10, () => undefined);
    expect(failures.big).toHaveLength(10);
    expect(failureSample.total.big).toBe(30);
    expect(failureSample.truncated).toEqual(['big']);
    expect(failures.small).toHaveLength(3);
  });

  it('omits a question it does not have rather than writing undefined into the artifact', () => {
    const { failures } = failureCorpus([['arm', [run('1', false)]]], 10, () => undefined);
    expect(failures.arm?.[0]).not.toHaveProperty('question');
    expect(JSON.stringify(failures.arm?.[0])).not.toContain('undefined');
  });

  it('keeps a corpus large enough to diagnose from', () => {
    // 200 of a dev arm's ~563 failures is a third, not 1.4%.
    expect(FAILURE_SAMPLE).toBeGreaterThanOrEqual(200);
  });
});
