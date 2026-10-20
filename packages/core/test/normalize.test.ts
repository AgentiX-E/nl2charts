import { describe, expect, it } from 'vitest';
import { canonicalRow, canonicalValue, hashRows, isDecimalLike, resultSetsEqual } from '../src/normalize.js';

describe('canonical values', () => {
  it('normalizes nullish values to null', () => {
    expect(canonicalValue(null)).toBeNull();
    expect(canonicalValue(undefined)).toBeNull();
  });

  it('keeps primitives untouched', () => {
    expect(canonicalValue(true)).toBe(true);
    expect(canonicalValue('x')).toBe('x');
    expect(canonicalValue(42)).toBe(42);
  });

  it('normalizes negative zero', () => {
    expect(canonicalValue(-0)).toBe(0);
  });

  it('tags non-finite numbers instead of emitting invalid JSON', () => {
    expect(canonicalValue(Number.NaN)).toBe('NaN');
    expect(canonicalValue(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(canonicalValue(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
  });

  it('turns safe bigints into numbers and keeps unsafe ones exact', () => {
    expect(canonicalValue(7n)).toBe(7);
    expect(canonicalValue(-7n)).toBe(-7);
    expect(canonicalValue(9_007_199_254_740_993n)).toBe('9007199254740993');
  });

  it('formats DuckDB decimals without losing scale', () => {
    expect(canonicalValue({ width: 10, scale: 2, value: 150n })).toBe('1.50');
    expect(canonicalValue({ width: 10, scale: 2, value: -150n })).toBe('-1.50');
    expect(canonicalValue({ width: 10, scale: 0, value: 12n })).toBe('12');
    expect(canonicalValue({ width: 10, scale: 4, value: 5n })).toBe('0.0005');
  });

  it('formats dates and rejects invalid dates deterministically', () => {
    expect(canonicalValue(new Date('2026-10-20T00:00:00.000Z'))).toBe('2026-10-20T00:00:00.000Z');
    expect(canonicalValue(new Date('nope'))).toBe('Invalid Date');
  });

  it('formats byte arrays as hex', () => {
    expect(canonicalValue(new Uint8Array([0, 15, 255]))).toBe('0x000fff');
  });

  it('serializes arrays and objects with sorted keys', () => {
    expect(canonicalValue([1, 'a', null])).toBe('[1,"a",null]');
    expect(canonicalValue({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalValue({ b: 1, a: 2 })).toBe(canonicalValue({ a: 2, b: 1 }));
  });

  it('treats values that cannot come from a result set as null', () => {
    expect(canonicalValue(Symbol('x'))).toBeNull();
    expect(canonicalValue(() => 1)).toBeNull();
  });

  it('identifies decimal-shaped objects', () => {
    expect(isDecimalLike({ width: 1, scale: 0, value: 1n })).toBe(true);
    expect(isDecimalLike({ width: 1, scale: 0, value: 1 })).toBe(false);
    expect(isDecimalLike(null)).toBe(false);
    expect(isDecimalLike('x')).toBe(false);
  });
});

describe('row identity', () => {
  it('sorts keys so column order does not change the hash', () => {
    expect(canonicalRow({ b: 2, a: 1 })).toEqual({ a: 1, b: 2 });
    expect(hashRows([{ b: 2, a: 1 }])).toBe(hashRows([{ a: 1, b: 2 }]));
  });

  it('changes when a value changes', () => {
    expect(hashRows([{ a: 1 }])).not.toBe(hashRows([{ a: 2 }]));
  });

  it('changes when row order changes', () => {
    expect(hashRows([{ a: 1 }, { a: 2 }])).not.toBe(hashRows([{ a: 2 }, { a: 1 }]));
  });

  it('is stable across calls and 16 hex characters wide', () => {
    const hash = hashRows([{ a: 1, b: 'x' }]);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hashRows([{ a: 1, b: 'x' }])).toBe(hash);
  });

  it('compares result sets structurally', () => {
    expect(resultSetsEqual([{ a: 1 }], [{ a: 1 }])).toBe(true);
    expect(resultSetsEqual([{ a: 1 }], [{ a: 1 }, { a: 2 }])).toBe(false);
    expect(resultSetsEqual([{ a: 1 }], [{ a: 2 }])).toBe(false);
  });
});
