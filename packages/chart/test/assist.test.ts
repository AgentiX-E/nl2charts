import { describe, expect, it, vi } from 'vitest';
import { assistedChartIR, assistedMark, MARK_GLOSS, MARK_OPTIONS } from '../src/assist.js';
import { RECOMMENDABLE_MARKS, toChartIR } from '../src/recommend.js';

/**
 * The advice, and the four ways it is allowed to matter.
 *
 * The suite is arranged around the states a decision can be in, because each one has a different
 * consequence and only one of them is "the model chose": no advisor at all (the default path, which
 * must not move), an advisor that named a mark (drawn), an advisor that named nothing (the table's
 * answer), and an advisor that failed or named something undrawable (also the table's answer, but
 * counted separately — "declined" and "unreachable" are different facts about an endpoint).
 */
const TABLE = [
  { country: 'US', revenue: 5 },
  { country: 'DE', revenue: 9 },
  { country: 'FR', revenue: 2 },
];

/** A table whose columns *are* a timeline: one row per entity, one column per year. */
const WIDE = [
  { entity: 'Oman', '2019': 1203, '2020': 1180, '2021': 1164 },
  { entity: 'Qatar', '2019': 980, '2020': 1010, '2021': 1044 },
];

/** One measure and no category axis: a gauge is the only mark admitted, so a bar is undrawable. */
const SINGLE = [{ value: 5 }, { value: 9 }];

describe('assistedMark', () => {
  it('returns before its first await when no advisor is configured', async () => {
    // The acceptance criterion is control flow, not a comment: with no key the default path must be
    // the default path. A spy that is never called is the closest a test can get to "no await".
    const spy = vi.fn(async () => 'line');
    const decision = await assistedMark('revenue by country', 'bar', undefined);
    expect(decision).toEqual({ mark: 'bar', source: 'product', product: 'bar' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('takes the model at its word when it names a mark on the list', async () => {
    const decision = await assistedMark('revenue by country', 'bar', async () => 'line');
    expect(decision).toEqual({ mark: 'line', source: 'model', product: 'bar' });
  });

  it('keeps the table answer when the model declined', async () => {
    const decision = await assistedMark('q', 'bar', async () => undefined);
    expect(decision).toEqual({ mark: 'bar', source: 'product', product: 'bar', fallback: 'no-advice' });
  });

  it('keeps the table answer when the endpoint failed, and says so', async () => {
    const decision = await assistedMark('q', 'bar', async () => {
      throw new Error('ETIMEDOUT');
    });
    expect(decision).toEqual({ mark: 'bar', source: 'product', product: 'bar', fallback: 'unavailable' });
  });

  it('refuses a name outside the list rather than choosing for the model', async () => {
    const decision = await assistedMark('q', 'bar', async () => 'donut');
    expect(decision).toEqual({ mark: 'bar', source: 'product', product: 'bar', fallback: 'unlisted' });
  });

  it('can overturn a refusal, which is the row class the policy exists for', async () => {
    const decision = await assistedMark('q', 'declined', async () => 'heatmap');
    expect(decision).toEqual({ mark: 'heatmap', source: 'model', product: 'declined' });
  });

  it('passes the same closed list the arm sends', async () => {
    let offered: readonly { name: string; gloss: string }[] = [];
    await assistedMark('q', 'bar', async (_question, options) => {
      offered = options;
      return undefined;
    });
    expect(offered).toEqual(MARK_OPTIONS);
  });
});

describe('the mark list', () => {
  it('is derived from the marks the layer can draw', () => {
    expect(MARK_OPTIONS.map((option) => option.name)).toEqual([...RECOMMENDABLE_MARKS]);
  });

  it('gives every mark a gloss, and no gloss to a mark that is not drawn', () => {
    expect(Object.keys(MARK_GLOSS).sort()).toEqual([...RECOMMENDABLE_MARKS].sort());
  });
});

describe('toChartIR with a mark decided elsewhere', () => {
  it('draws the requested mark and leaves the data to the result set', () => {
    const chosen = toChartIR('revenue by country', TABLE, { mark: 'line' });
    expect(chosen.mark).toBe('line');
    expect(chosen.data).toHaveLength(TABLE.length);
  });

  it('refuses a mark the result set cannot hold, with the recommender reason', () => {
    // A bar of one measure and no category axis is not a bar; coercing it would be this function
    // choosing a picture the caller did not ask for.
    expect(() => toChartIR('total', SINGLE, { mark: 'bar' })).toThrow(/a bar needs a category axis and a measure/);
    try {
      toChartIR('total', SINGLE, { mark: 'bar' });
      expect.unreachable('a refused mark must throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('NL2C_E_NOT_SUPPORTED');
    }
  });

  it('still refuses an empty result set, whatever mark was asked for', () => {
    expect(() => toChartIR('q', [], { mark: 'bar' })).toThrow(/the result set is empty/);
  });
});

describe('assistedChartIR', () => {
  it('is byte for byte the default chart when no advisor is configured', async () => {
    const plain = toChartIR('revenue by country', TABLE);
    const assisted = await assistedChartIR('revenue by country', TABLE, {});
    expect(JSON.stringify(assisted.ir)).toBe(JSON.stringify(plain));
    expect(assisted.decision).toEqual({ mark: plain.mark, source: 'product', product: plain.mark });
  });

  it('is byte for byte the default chart when the advisor named the same mark', async () => {
    const plain = toChartIR('revenue by country', TABLE);
    const assisted = await assistedChartIR('revenue by country', TABLE, { advisor: async () => plain.mark });
    expect(JSON.stringify(assisted.ir)).toBe(JSON.stringify(plain));
    expect(assisted.decision.source).toBe('model');
  });

  it('redraws when the model named a different drawable mark', async () => {
    const productMark = toChartIR('revenue by country', TABLE).mark;
    const other = productMark === 'bar' ? 'line' : 'bar';
    const assisted = await assistedChartIR('revenue by country', TABLE, { advisor: async () => other });
    expect(assisted.ir.mark).toBe(other);
    expect(assisted.decision).toEqual({ mark: other, source: 'model', product: productMark });
    // The data is still the result set, folded the same way: a model may change the picture's shape,
    // never what the picture says.
    expect(assisted.ir.data).toHaveLength(TABLE.length);
  });

  it('vetoes a name this result set cannot hold, and keeps the table chart', async () => {
    const plain = toChartIR('total', SINGLE);
    const assisted = await assistedChartIR('total', SINGLE, { advisor: async () => 'bar' });
    expect(assisted.ir).toEqual(plain);
    expect(assisted.decision).toMatchObject({ mark: plain.mark, source: 'product', veto: 'not-admitted' });
  });

  it('does not ask about a wide table, whose reshape leaves one reading', async () => {
    const advisor = vi.fn(async () => 'pie');
    const assisted = await assistedChartIR('population by year', WIDE, { advisor });
    expect(advisor).not.toHaveBeenCalled();
    expect(assisted.ir.mark).toBe('line');
    expect(assisted.ir.encoding.series?.field).toBe('entity');
    expect(assisted.decision).toMatchObject({ mark: 'line', source: 'product', veto: 'wide' });
  });

  it('does not ask about a table nothing can chart', async () => {
    const advisor = vi.fn(async () => 'bar');
    await expect(assistedChartIR('q', [], { advisor })).rejects.toThrow(/the result set is empty/);
    expect(advisor).not.toHaveBeenCalled();
  });

  it('keeps the table chart when the advisor failed, so availability is not the endpoint s', async () => {
    const plain = toChartIR('revenue by country', TABLE);
    const assisted = await assistedChartIR('revenue by country', TABLE, {
      advisor: async () => {
        throw new Error('502 Bad Gateway');
      },
    });
    expect(JSON.stringify(assisted.ir)).toBe(JSON.stringify(plain));
    expect(assisted.decision.fallback).toBe('unavailable');
  });
});
