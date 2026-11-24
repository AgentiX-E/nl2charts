import { describe, expect, it } from 'vitest';
import {
  canonical, compareCharts, compareExactly, digestOf, fieldOf, isRecord, normalizeOrder, preprocess,
  pyTruthy, readingOf, reverseAxes, strictReadingOf,
} from '../eval/nvbench2/judge.js';
import type { Case, FieldTypes } from '../eval/nvbench2/judge.js';

/** A table where `amount` and `score` are numbers and everything else is text. */
const TYPES: FieldTypes = {
  amount: 'quantitative',
  score: 'quantitative',
  name: 'category',
  stamp: 'temporal',
};

const chart = (encoding: Record<string, unknown>, mark: string = 'bar'): Record<string, unknown> => ({
  mark,
  encoding,
});

describe('reverseAxes', () => {
  it('swaps two quantitative axes when the field names are out of order', () => {
    // `score` > `amount` lexicographically, so a chart drawn score-by-amount is the transposed one.
    const swapped = reverseAxes(chart({ x: { field: 'score' }, y: { field: 'amount' } }), TYPES);
    expect(swapped.encoding).toEqual({ x: { field: 'amount' }, y: { field: 'score' } });
  });

  it('leaves a chart whose quantitative axes are already in order', () => {
    const kept = reverseAxes(chart({ x: { field: 'amount' }, y: { field: 'score' } }), TYPES);
    expect(kept.encoding).toEqual({ x: { field: 'amount' }, y: { field: 'score' } });
  });

  it('turns a bar with a measure on the x axis the right way up', () => {
    const swapped = reverseAxes(chart({ x: { field: 'amount' }, y: { field: 'name' } }), TYPES);
    expect(swapped.encoding).toEqual({ x: { field: 'name' }, y: { field: 'amount' } });
  });

  it('leaves a bar that already has the measure on the y axis', () => {
    const kept = reverseAxes(chart({ x: { field: 'name' }, y: { field: 'amount' } }), TYPES);
    expect(kept.encoding).toEqual({ x: { field: 'name' }, y: { field: 'amount' } });
  });

  it('applies the mark rule to line and boxplot, and to no other mark', () => {
    const line = reverseAxes(chart({ x: { field: 'amount' }, y: { field: 'name' } }, 'line'), TYPES);
    expect(line.encoding).toEqual({ x: { field: 'name' }, y: { field: 'amount' } });
    const box = reverseAxes(chart({ x: { field: 'amount' }, y: { field: 'name' } }, 'boxplot'), TYPES);
    expect(box.encoding).toEqual({ x: { field: 'name' }, y: { field: 'amount' } });
    const point = reverseAxes(chart({ x: { field: 'amount' }, y: { field: 'name' } }, 'point'), TYPES);
    expect(point.encoding).toEqual({ x: { field: 'amount' }, y: { field: 'name' } });
  });

  it('treats a temporal field exactly as it treats a category', () => {
    // The map can never say `temporal` for a published table — pandas reads `2010-05-01` as text —
    // and the reading below is why that costs nothing: the judge asks one question, "is this
    // quantitative", and both labels answer it the same way.
    const frame = chart({ x: { field: 'amount' }, y: { field: 'label' } });
    const asCalendar = reverseAxes(frame, { amount: 'quantitative', label: 'temporal' });
    const asText = reverseAxes(frame, { amount: 'quantitative', label: 'category' });
    expect(asCalendar).toEqual(asText);
    expect(asCalendar.encoding).toEqual({ x: { field: 'label' }, y: { field: 'amount' } });
  });

  it('reads a field with no type as "not quantitative", which is why a short map is not neutral', () => {
    // An untyped `y` answers the mark rule's `y_type != 'quantitative'` with *yes*, so a bar chart
    // whose x axis is a measure gets turned the right way up — the reference's behaviour, and the
    // reason a map that merely omits a column changes the score instead of leaving it alone.
    const kept = reverseAxes(chart({ x: { field: 'score' }, y: { field: 'unlisted' } }), TYPES);
    expect(kept.encoding).toEqual({ x: { field: 'unlisted' }, y: { field: 'score' } });
    // Two untyped fields cannot satisfy either rule: the first needs both to be quantitative and
    // the second needs the x axis to be.
    const both = reverseAxes(chart({ x: { field: 'zed' }, y: { field: 'alpha' } }), TYPES);
    expect(both.encoding).toEqual({ x: { field: 'zed' }, y: { field: 'alpha' } });
  });

  it('does nothing without two object channels', () => {
    expect(reverseAxes({ mark: 'bar' }, TYPES)).toEqual({ mark: 'bar' });
    expect(reverseAxes({ mark: 'bar', encoding: 'x' }, TYPES)).toEqual({ mark: 'bar', encoding: 'x' });
    expect(reverseAxes(chart({ x: { field: 'score' } }), TYPES)).toEqual(chart({ x: { field: 'score' } }));
    expect(reverseAxes(chart({ x: 'score', y: { field: 'amount' } }), TYPES))
      .toEqual(chart({ x: 'score', y: { field: 'amount' } }));
    expect(reverseAxes(chart({ x: {}, y: { field: 'amount' } }), TYPES))
      .toEqual(chart({ x: {}, y: { field: 'amount' } }));
    expect(reverseAxes(chart({ x: { aggregate: 'mean' }, y: { field: 'amount' } }), TYPES))
      .toEqual(chart({ x: { aggregate: 'mean' }, y: { field: 'amount' } }));
  });

  it('reads a list field as its first element', () => {
    const swapped = reverseAxes(chart({ x: { field: ['score', 'other'] }, y: { field: 'amount' } }), TYPES);
    expect(swapped.encoding).toEqual({ x: { field: 'amount' }, y: { field: ['score', 'other'] } });
  });

  it('copies rather than mutates, which is the one thing it does not do like the reference', () => {
    const original = chart({ x: { field: 'score' }, y: { field: 'amount' } });
    reverseAxes(original, TYPES);
    expect(original.encoding).toEqual({ x: { field: 'score' }, y: { field: 'amount' } });
  });
});

describe('normalizeOrder', () => {
  it('writes mark, encoding, transform and then everything else', () => {
    const ordered = normalizeOrder({ title: 't', transform: [], encoding: {}, mark: 'bar' });
    expect(Object.keys(ordered)).toEqual(['mark', 'encoding', 'transform', 'title']);
  });

  it('orders channels and their properties', () => {
    const ordered = normalizeOrder({
      mark: 'bar',
      encoding: {
        color: { sort: 'x', field: 'c', aggregate: 'mean' },
        x: { sort: 'y', field: 'a' },
        extra: { field: 'e' },
        size: { field: 's' },
      },
    });
    expect(Object.keys(ordered.encoding as object)).toEqual(['x', 'color', 'size', 'extra']);
    expect(Object.keys((ordered.encoding as Record<string, object>).x as object)).toEqual(['field', 'sort']);
    expect(Object.keys((ordered.encoding as Record<string, object>).color as object)).toEqual(['field', 'aggregate', 'sort']);
  });

  it('orders filter operators and drops a transform that is not a filter', () => {
    const ordered = normalizeOrder({
      mark: 'bar',
      transform: [{ calculate: 'datum.a * 2' }, { filter: { oneOf: [1], equal: 'x' } }, { filter: 'a > 1' }],
    });
    expect(ordered.transform).toEqual([{ filter: { equal: 'x', oneOf: [1] } }]);
  });

  it('leaves an empty slot for a channel whose value is not an object', () => {
    // The reference assigns `normalized['encoding'][channel] = {}` before it tests the type, so the
    // `continue` comes too late and the slot survives. A prediction may contain such a channel.
    const ordered = normalizeOrder({ mark: 'bar', encoding: { x: 'amount', y: { field: 'name' } } });
    expect(ordered.encoding).toEqual({ x: {}, y: { field: 'name' } });
  });

  it('normalises a non-object encoding to an empty one instead of raising', () => {
    // The reference raises `TypeError` here — `'x' in 'xy'` is true for a string. A malformed
    // prediction is worth zero, not a crashed run, and this is the difference.
    expect(normalizeOrder({ mark: 'bar', encoding: 'xy' })).toEqual({ mark: 'bar', encoding: {} });
    expect(normalizeOrder({ mark: 'bar', encoding: 7 })).toEqual({ mark: 'bar', encoding: {} });
  });

  it('is idempotent, on the charts the corpus actually holds', () => {
    const once = normalizeOrder({
      mark: 'line',
      encoding: { y: { field: 'b', aggregate: 'mean' }, x: { field: 'a' }, color: { field: 'c' } },
      transform: [{ filter: { gte: 2, field: 'b' } }],
      width: 400,
    });
    expect(normalizeOrder(once)).toEqual(once);
  });
});

describe('compareCharts', () => {
  it('ignores key order and counts keys', () => {
    expect(compareCharts({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(compareCharts({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(compareCharts({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it('ignores list order', () => {
    expect(compareCharts([1, 2], [2, 1])).toBe(true);
    expect(compareCharts([1, 2], [1, 2, 3])).toBe(false);
  });

  it('does not consume a match, so a repeated value is free', () => {
    // `all(any(...))` never removes what it matched: `[1, 1]` and `[1, 2]` are the same chart to the
    // reference. Pinned here so nobody "fixes" the port into a different coordinate system, and
    // reported by `compareExactly` so the difference is visible rather than argued about.
    expect(compareCharts([1, 1], [1, 2])).toBe(true);
    expect(compareExactly([1, 1], [1, 2])).toBe(false);
    expect(compareExactly([1, 1], [1, 1])).toBe(true);
    expect(compareExactly([1, 2], [2, 3])).toBe(false);
  });

  it('reads a boolean as the number Python reads it as', () => {
    expect(compareCharts(true, 1)).toBe(true);
    expect(compareCharts(false, 0)).toBe(true);
    expect(compareCharts(true, 'true')).toBe(false);
  });

  it('keeps null and zero apart, and matches null with null', () => {
    expect(compareCharts(null, 0)).toBe(false);
    expect(compareCharts(null, null)).toBe(true);
    expect(compareCharts(undefined, null)).toBe(true);
    expect(compareCharts('a', 'a')).toBe(true);
  });

  it('compares nested lists with the same looseness at every depth', () => {
    expect(compareCharts({ a: [[1], [1]] }, { a: [[1], [2]] })).toBe(true);
    expect(compareCharts({ a: [[1], [1]] }, { a: [[3], [2]] })).toBe(false);
  });
});

describe('readingOf', () => {
  const types: FieldTypes = { amount: 'quantitative', name: 'category' };
  const gold = { mark: 'bar', encoding: { x: { field: 'name' }, y: { field: 'amount' } } };
  const caseOf = (predictions: readonly unknown[], golds: readonly unknown[] = [gold]): Case =>
    ({ predictions, golds, types });

  it('reads a perfect prediction as one at every k', () => {
    const reading = readingOf([caseOf([gold])]);
    expect(reading.questions).toBe(1);
    for (const k of [1, 3, 5]) {
      expect(reading.hit[k]).toBe(1);
      expect(reading.f1[k]).toBe(1);
      expect(reading.recall[k]).toBe(1);
      expect(reading.precision[k]).toBe(1);
    }
  });

  it('scores one right answer among three as precision one third at k=3', () => {
    const wrong = { mark: 'point', encoding: { x: { field: 'name' }, y: { field: 'amount' } } };
    const reading = readingOf([caseOf([gold, wrong, wrong])]);
    expect(reading.precision[1]).toBe(1);
    expect(reading.precision[3]).toBeCloseTo(1 / 3, 12);
    expect(reading.recall[3]).toBe(1);
    expect(reading.hit[3]).toBe(1);
  });

  it('reads an empty prediction list as zero rather than as a division', () => {
    const reading = readingOf([caseOf([])]);
    expect(reading.precision[1]).toBe(0);
    expect(reading.recall[1]).toBe(0);
    expect(reading.hit[1]).toBe(0);
    expect(reading.f1[1]).toBe(0);
  });

  it('drops a question with no gold from the denominator', () => {
    const reading = readingOf([caseOf([gold]), caseOf([gold], [])]);
    expect(reading.questions).toBe(1);
    expect(reading.f1[1]).toBe(1);
  });

  it('reads nothing at all as zeroes rather than as NaN', () => {
    const reading = readingOf([]);
    expect(reading.questions).toBe(0);
    expect(reading.f1[1]).toBe(0);
    expect(reading.hit[5]).toBe(0);
  });

  it('credits each prediction once, so two identical predictions match one gold', () => {
    const reading = readingOf([caseOf([gold, gold])]);
    expect(reading.recall[3]).toBe(1);
    expect(reading.precision[3]).toBeCloseTo(1 / 2, 12);
    expect(reading.f1[3]).toBeCloseTo((2 * 0.5) / 1.5, 12);
  });

  it('reads a gold list of two and one prediction as recall one half', () => {
    const second = { mark: 'line', encoding: { x: { field: 'name' }, y: { field: 'amount' } } };
    const reading = readingOf([caseOf([gold], [gold, second])]);
    expect(reading.recall[1]).toBeCloseTo(1 / 2, 12);
    // p = 1, r = 1/2, so f1 = 2 * 0.5 / 1.5.
    expect(reading.f1[1]).toBeCloseTo(2 / 3, 12);
  });

  it('runs the strict comparison through the same loop', () => {
    const repeated = { mark: 'bar', encoding: { x: { field: ['name', 'name'] }, y: { field: 'amount' } } };
    const other = { mark: 'bar', encoding: { x: { field: ['name', 'stamp'] }, y: { field: 'amount' } } };
    const loose = readingOf([caseOf([repeated], [other])]);
    const strict = strictReadingOf([caseOf([repeated], [other])]);
    expect(loose.f1[1]).toBe(1);
    expect(strict.f1[1]).toBe(0);
  });

  it('canonicalises before comparing, so a transposed prediction is right', () => {
    const transposed = { mark: 'bar', encoding: { x: { field: 'amount' }, y: { field: 'name' } } };
    expect(readingOf([caseOf([transposed])]).f1[1]).toBe(1);
  });
});

describe('preprocess', () => {
  it('keeps a non-object entry as null, because the length is part of precision', () => {
    const out = preprocess([{ mark: 'bar' }, 'nonsense', null], {});
    expect(out).toEqual([{ mark: 'bar' }, null, null]);
  });
});

describe('canonical and digestOf', () => {
  it('writes an integral number without a fractional part', () => {
    // `176.0` and `176` are one value to Python and two strings to a digest; this is the line that
    // made the two languages agree.
    expect(canonical({ a: 176.0 })).toBe('{"a":176}');
    expect(canonical({ a: 1.5 })).toBe('{"a":1.5}');
    expect(canonical(undefined)).toBe('null');
    // `JSON.stringify` returns `undefined` for a function, which is not a string a digest can take.
    expect(canonical(() => 1)).toBe('null');
  });

  it('sorts keys at every depth and keeps list order', () => {
    expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
  });

  it('digests the gold it was given, and notices a change in one of them', () => {
    const types: FieldTypes = { amount: 'quantitative' };
    const one: Case = { predictions: [], golds: [{ mark: 'bar' }], types };
    const two: Case = { predictions: [], golds: [{ mark: 'line' }], types };
    expect(digestOf([one])).toMatch(/^[0-9a-f]{64}$/u);
    expect(digestOf([one, two])).not.toBe(digestOf([two, one]));
  });
});

describe('the small predicates', () => {
  it('keeps arrays out of isRecord', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('reads Python truthiness, not JavaScript truthiness', () => {
    expect(pyTruthy({})).toBe(false);
    expect(pyTruthy([])).toBe(false);
    expect(pyTruthy(0)).toBe(false);
    expect(pyTruthy('')).toBe(false);
    expect(pyTruthy(false)).toBe(false);
    expect(pyTruthy(undefined)).toBe(false);
    expect(pyTruthy({ a: 1 })).toBe(true);
    expect(pyTruthy([1])).toBe(true);
    expect(pyTruthy('x')).toBe(true);
    expect(pyTruthy(1)).toBe(true);
    // Anything Python has no falsy rule for is true, which is what a function would be.
    expect(pyTruthy(() => 1)).toBe(true);
  });

  it('reads a field from a string, a list, or not at all', () => {
    expect(fieldOf({ field: 'a' })).toBe('a');
    expect(fieldOf({ field: ['a', 'b'] })).toBe('a');
    expect(fieldOf({ field: [1] })).toBeUndefined();
    expect(fieldOf({})).toBeUndefined();
    expect(fieldOf('a')).toBeUndefined();
  });
});
