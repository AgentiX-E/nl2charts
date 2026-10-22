import { describe, expect, it } from 'vitest';
import { SERIES_TYPES, type ChartType } from '@agentix-e/nl2charts-spec';
import { MARKS, describeMark } from '../src/index.js';

describe('mark registry', () => {
  it('answers for every series type the contract allows', () => {
    expect(Object.keys(MARKS).sort()).toEqual([...SERIES_TYPES].sort());
    for (const mark of SERIES_TYPES) expect(describeMark(mark).mark, mark).toBe(mark);
  });

  it('declares the data shape each mark consumes', () => {
    // A boxplot needs five numbers per row and a candlestick four. A renderer that
    // reads one column from a row produces a chart that looks plausible and is
    // wrong, so the shape is part of the contract rather than an implementation
    // detail of the compiler.
    expect(describeMark('boxplot').tuple).toBe(5);
    expect(describeMark('candlestick').tuple).toBe(4);
    expect(describeMark('themeRiver').tuple).toBe(3);
    expect(describeMark('bar').tuple).toBeUndefined();
  });

  it('says which marks need something the IR cannot supply', () => {
    expect(describeMark('map').requiresGeo).toBe(true);
    expect(describeMark('custom').requiresRenderItem).toBe(true);
    expect(describeMark('bar').requiresGeo).toBe(false);
    expect(describeMark('bar').requiresRenderItem).toBe(false);
  });

  it('lists the encoding channels each mark reads', () => {
    expect(describeMark('bar').channels).toEqual(['x', 'y', 'series']);
    expect(describeMark('candlestick').channels).toEqual(['x', 'y']);
    expect(describeMark('radar').channels).toEqual(['x', 'y', 'series']);
    expect(describeMark('pie').channels).toEqual(['theta', 'y', 'color']);
  });

  it('separates the eighteen self-contained marks from the two that need help', () => {
    const blocked = SERIES_TYPES.filter((mark: ChartType) => {
      const entry = describeMark(mark);
      return entry.requiresGeo || entry.requiresRenderItem;
    });
    expect([...blocked].sort()).toEqual(['custom', 'map']);
    expect(SERIES_TYPES).toHaveLength(20 + 2);
  });

  it('carries a one-line summary so a caller can explain the choice', () => {
    for (const mark of SERIES_TYPES) {
      expect(MARKS[mark].summary.length, mark).toBeGreaterThan(8);
    }
  });
});
