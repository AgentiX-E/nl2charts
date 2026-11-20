import { describe, expect, it, vi } from 'vitest';
import { admittedOptions, assistedChartIR, assistedMark, MARK_GLOSS, MARK_OPTIONS } from '../src/assist.js';
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

  it('draws the mark a wide table can hold, instead of not asking', async () => {
    // The reshape has three readings and the advisor is asked about all three: a line per entity, a
    // grouped bar per period, a matrix of the two. The corpus says 53 of its 144 wide tables were
    // drawn as bars, and skipping the question cost those rows.
    const advisor = vi.fn(async () => 'bar');
    const assisted = await assistedChartIR('population by year', WIDE, { advisor });
    expect(advisor).toHaveBeenCalledTimes(1);
    expect(assisted.ir.mark).toBe('bar');
    // Same long form, same series: a model may change the picture's shape, never what it says.
    expect(assisted.ir.encoding.series?.field).toBe('entity');
    expect(assisted.ir.data).toHaveLength(6);
    expect(assisted.decision).toEqual({ mark: 'bar', source: 'model', product: 'line' });
  });

  it('vetoes a mark the long form cannot hold, and keeps the line', async () => {
    // A pie of `entity × period` slices entities against periods, which is a total the table never
    // stated — refused with the reshape's own reason rather than drawn as the nearest neighbour.
    const advisor = vi.fn(async () => 'pie');
    const assisted = await assistedChartIR('population by year', WIDE, { advisor });
    expect(assisted.ir.mark).toBe('line');
    expect(assisted.ir.encoding.series?.field).toBe('entity');
    expect(assisted.decision).toMatchObject({ mark: 'line', source: 'product', veto: 'not-admitted' });
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

describe('admittedOptions', () => {
  it('offers the marks this table can hold, in the roster s order', () => {
    // The second question is only worth asking if its list is the drawing's list, so the test asks the
    // drawer: every mark it offers must encode, and every mark it withholds must refuse.
    const offered = admittedOptions('revenue by country', TABLE).map((option) => option.name);
    expect(offered).toEqual(['bar', 'line', 'pie', 'funnel']);
    const order = RECOMMENDABLE_MARKS.filter((mark) => offered.includes(mark));
    expect(offered).toEqual([...order]);
    for (const mark of RECOMMENDABLE_MARKS) {
      const draws = (() => {
        try {
          toChartIR('revenue by country', TABLE, { mark });
          return true;
        } catch {
          return false;
        }
      })();
      expect(draws).toBe(offered.includes(mark));
    }
  });

  it('offers one mark when the table holds one, which is why the second question is skipped', () => {
    expect(admittedOptions('total revenue', SINGLE).map((option) => option.name)).toEqual(['gauge']);
  });

  it('offers the three readings of a table read sideways, and no fourth', () => {
    // Two categories and one measure: a line per entity, side-by-side bars, or the matrix. Every mark
    // outside those three names a picture the reshape does not produce — a pie of `entity × period`
    // would slice one against the other.
    expect(admittedOptions('population by year', WIDE).map((option) => option.name)).toEqual(['bar', 'line', 'heatmap']);
  });

  it('offers nothing when nothing can be drawn, rather than inventing a list', () => {
    expect(admittedOptions('nothing here', [])).toEqual([]);
  });

  it('carries the gloss with the name, because the gloss is half of the question', () => {
    for (const option of admittedOptions('revenue by country', TABLE)) {
      expect(option.gloss).toBe(MARK_GLOSS[option.name]);
    }
  });

  it('is always shorter than the roster it was drawn from when a mark has just been refused', async () => {
    // The property the replay reader depends on: question two is identified by its list being a strict
    // subset, so a repair ask can never be mistaken for a first ask.
    const asked: number[] = [];
    await assistedChartIR('revenue by country', TABLE, {
      advisor: async (_question, options) => {
        asked.push(options.length);
        return options.length === MARK_OPTIONS.length ? 'boxplot' : undefined;
      },
      repair: true,
    });
    expect(asked).toEqual([MARK_OPTIONS.length, 4]);
  });
});

describe('the second question', () => {
  it('is not asked when the caller did not opt in', async () => {
    const spy = vi.fn(async () => 'boxplot');
    const chart = await assistedChartIR('revenue by country', TABLE, { advisor: spy });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(chart.decision).toMatchObject({ mark: 'bar', source: 'product', veto: 'not-admitted' });
  });

  it('draws the model s second answer when the first was impossible on this table', async () => {
    const asked: readonly string[][] = [];
    const chart = await assistedChartIR('revenue by country', TABLE, {
      advisor: async (_question, options) => {
        (asked as string[][]).push(options.map((option) => option.name));
        return options.length === MARK_OPTIONS.length ? 'boxplot' : 'pie';
      },
      repair: true,
    });
    expect(asked).toHaveLength(2);
    expect(chart.ir.mark).toBe('pie');
    expect(chart.decision).toEqual({ mark: 'pie', source: 'model', product: 'bar', repaired: true });
  });

  it('is not asked when the table holds a single mark, because a one-answer question is not one', async () => {
    const spy = vi.fn(async () => 'bar');
    const chart = await assistedChartIR('total revenue', SINGLE, { advisor: spy, repair: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(chart.decision).toMatchObject({ mark: 'gauge', source: 'product', veto: 'not-admitted' });
  });

  it('keeps the table chart when the second answer names nothing on the shorter list', async () => {
    const chart = await assistedChartIR('revenue by country', TABLE, {
      advisor: async (_question, options) => (options.length === MARK_OPTIONS.length ? 'boxplot' : 'donut'),
      repair: true,
    });
    expect(chart.decision).toEqual({ mark: 'bar', source: 'product', product: 'bar', veto: 'not-admitted' });
  });

  it('keeps the table chart when the second call fails, so availability is still not the endpoint s', async () => {
    const chart = await assistedChartIR('revenue by country', TABLE, {
      advisor: async (_question, options) => {
        if (options.length === MARK_OPTIONS.length) return 'boxplot';
        throw new Error('ETIMEDOUT');
      },
      repair: true,
    });
    expect(chart.decision).toEqual({ mark: 'bar', source: 'product', product: 'bar', veto: 'not-admitted' });
  });

  it('is not asked when the first answer was drawable, because there is nothing to repair', async () => {
    // The saving that makes the option affordable: the flag is on, the row is fine, and the second
    // question does not happen. On this corpus that is 1,247 of 1,470 rows.
    const spy = vi.fn(async () => 'pie');
    const chart = await assistedChartIR('revenue by country', TABLE, { advisor: spy, repair: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(chart.decision).toEqual({ mark: 'pie', source: 'model', product: 'bar' });
  });

  it('still refuses a table nothing can chart, and does not ask about one', async () => {
    const spy = vi.fn(async () => 'bar');
    await expect(assistedChartIR('nothing here', [], { advisor: spy, repair: true })).rejects.toThrow(/nothing to chart/);
    expect(spy).not.toHaveBeenCalled();
  });
});
