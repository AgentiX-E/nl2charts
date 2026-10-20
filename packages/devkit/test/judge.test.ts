import { describe, expect, it } from 'vitest';
import { judgeOfficial, judgeOfficialResult, judgeStrict, judgeStrictResult, toTuples } from '../src/index.js';

const t = (...rows: unknown[][]): unknown[][] => rows;

describe('BIRD official execution judge', () => {
  it('ignores row order but not column order', () => {
    expect(judgeOfficial(t([1, 'a'], [2, 'b']), t([2, 'b'], [1, 'a']))).toBe('match');
    expect(judgeOfficial(t([1, 'a']), t(['a', 1]))).toBe('values');
  });

  it('rejects a different column count', () => {
    expect(judgeOfficial(t([1, 2]), t([1]))).toBe('column-count');
  });

  it('credits a duplicate row because it compares sets', () => {
    // The loophole: 4 predicted rows with a duplicate equal a 3-row gold.
    expect(judgeOfficial(t([1], [2], [3]), t([1], [1], [2], [3]))).toBe('match');
    expect(judgeStrict(t([1], [2], [3]), t([1], [1], [2], [3]))).toBe('values');
  });

  it('distinguishes null from the string NULL and from zero', () => {
    expect(judgeOfficial(t([null]), t(['NULL']))).toBe('values');
    expect(judgeOfficial(t([null]), t([0]))).toBe('values');
    expect(judgeOfficial(t([null]), t([null]))).toBe('match');
  });

  it('treats a bigint and the same number as equal', () => {
    expect(judgeOfficial(t([1n]), t([1]))).toBe('match');
    expect(judgeOfficial(t([-0]), t([0]))).toBe('match');
  });

  it('compares text exactly', () => {
    expect(judgeOfficial(t(['north']), t(['North']))).toBe('values');
    expect(judgeOfficial(t(['north ']), t(['north']))).toBe('values');
  });

  it('compares empty results as equal only when both are empty', () => {
    // The official set() comparison cannot see columns without a row, so two
    // empty results match whatever their widths.
    expect(judgeOfficial([], [])).toBe('match');
    expect(judgeOfficial([], t([1]))).toBe('values');
  });
});

describe('strict multiset judge', () => {
  it('requires the same multiplicities', () => {
    expect(judgeStrict(t([1], [1]), t([1], [1]))).toBe('match');
    expect(judgeStrict(t([1], [2]), t([2], [2]))).toBe('values');
  });
});

describe('named-row adapter', () => {
  it('projects rows onto column order', () => {
    expect(toTuples({ columns: ['b', 'a'], rows: [{ a: 1, b: 2 }] })).toEqual([[2, 1]]);
    expect(judgeOfficialResult({ columns: ['a'], rows: [{ a: 1 }] }, { columns: ['x'], rows: [{ x: 1 }] })).toBe('match');
  });

  it('treats a missing key as null', () => {
    expect(toTuples({ columns: ['a', 'b'], rows: [{ a: 1 }] })).toEqual([[1, null]]);
  });
});

describe('judge value normalisation', () => {
  it('keeps an integer beyond 2^53 distinguishable', () => {
    expect(judgeOfficial(t([9007199254740993n]), t([9007199254740992n]))).toBe('values');
    expect(judgeStrict(t([9007199254740993n]), t([9007199254740993n]))).toBe('match');
  });

  it('compares blobs by content, and booleans as booleans', () => {
    expect(judgeOfficial(t([new Uint8Array([1, 2])]), t([Buffer.from([1, 2])]))).toBe('match');
    expect(judgeOfficial(t([new Uint8Array([1])]), t([new Uint8Array([2])]))).toBe('values');
    expect(judgeOfficial(t([true]), t([1]))).toBe('values');
  });

  it('treats NaN as equal to itself and undefined as null', () => {
    expect(judgeOfficial(t([Number.NaN]), t([Number.NaN]))).toBe('match');
    expect(judgeOfficial(t([undefined]), t([null]))).toBe('match');
  });

  it('reports a strict mismatch through the named-row wrapper', () => {
    expect(judgeStrictResult({ columns: ['a'], rows: [{ a: 1 }] }, { columns: ['a'], rows: [{ a: 1 }, { a: 1 }] })).toBe('values');
  });

  it('separates a width difference from a value difference', () => {
    expect(judgeOfficial(t([1, 2]), t([1]))).toBe('column-count');
    expect(judgeStrict(t([1, 2]), t(['x', 'y']))).toBe('values');
  });
});
