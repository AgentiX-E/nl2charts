import { describe, expect, it } from 'vitest';
import { classifyError, classifyFailureShape } from '../eval/bird/failure-shape.js';
import { format, tally } from '../eval/bird/diagnose-corpus.js';
import type { OracleResult } from '../eval/bird/oracle.js';

const ok = (rows: unknown[][]): OracleResult => ({ ok: true, columns: [], rows, ms: 1 });
const failed = (message: string): OracleResult => ({ ok: false, columns: [], rows: [], ms: 1, error: message });

describe('the shape of a wrong answer', () => {
  it('tells an empty result from a wrong one, because only one of them is free to detect', () => {
    expect(classifyFailureShape(ok([]), [[1]]).shape).toBe('empty');
    expect(classifyFailureShape(ok([[7]]), [[1]]).shape).toBe('values');
  });

  it('counts rows and columns apart, since the fixes differ', () => {
    expect(classifyFailureShape(ok([[1], [2]]), [[1]]).shape).toBe('row-count');
    expect(classifyFailureShape(ok([[1, 2]]), [[1]]).shape).toBe('column-count');
  });

  it('names the grain error the fan-out join produces, with its factor', () => {
    // Three rows per order, summed: the classic fan-out. The row count matches and only
    // the magnitude is wrong, which reads as "wrong values" to a comparator.
    const shape = classifyFailureShape(ok([[300], [600]]), [[100], [200]]);
    expect(shape.shape).toBe('scale');
    expect(shape.factor).toBe(3);
  });

  it('does not call a genuine value difference a factor', () => {
    expect(classifyFailureShape(ok([[300], [700]]), [[100], [200]]).shape).toBe('values');
    // ...nor a factor of one, which would be a match.
    expect(classifyFailureShape(ok([[100], [200]]), [[100], [200]]).shape).toBe('values');
  });

  it('classifies a refusal, so an engine error is not counted as a wrong answer', () => {
    expect(classifyFailureShape(failed('no such column: x'), [[1]]).shape).toBe('error');
  });

  it('reads the engine message in the terms a fix would use', () => {
    expect(classifyError('no such column: customers.nmae')).toBe('unknown-identifier');
    expect(classifyError('no such table: orders')).toBe('unknown-identifier');
    expect(classifyError('ambiguous column name: id')).toBe('ambiguous');
    expect(classifyError('misuse of aggregate: SUM()')).toBe('grouping');
    expect(classifyError('near "FORM": syntax error')).toBe('syntax');
    expect(classifyError('datatype mismatch')).toBe('type');
    expect(classifyError('something new')).toBe('other');
  });
});

describe('the corpus tally', () => {
  it('reports shares over the statements it examined, not over the arm', () => {
    const entry = tally(
      'select-mixed',
      [
        { shape: 'empty' as const },
        { shape: 'values' as const },
        { shape: 'error' as const, error: 'unknown-identifier' },
        { shape: 'scale' as const, factor: 3 },
        { shape: 'scale' as const, factor: 3 },
      ],
      500,
    );
    expect(entry.examined).toBe(5);
    expect(entry.failing).toBe(500);
    expect(entry.shapes.empty).toBe(1);
    expect(entry.emptyShare).toBeCloseTo(0.2);
    expect(entry.errors).toEqual({ 'unknown-identifier': 1 });
    expect(entry.scaleFactors[0]).toEqual({ factor: 3, cases: 2 });
  });

  it('prints a table whose columns are the shapes', () => {
    const text = format([tally('a', [{ shape: 'empty' as const }], 10)]);
    expect(text.split('\n')[0]).toContain('empty');
    expect(text).toContain('100.0%');
  });
});
