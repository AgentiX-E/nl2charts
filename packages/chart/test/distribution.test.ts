import { describe, expect, it } from 'vitest';
import { admittedOptions, assistedChartIR } from '../src/assist.js';
import { recommendChart, toChartIR } from '../src/recommend.js';
import { profileRows } from '../src/profile.js';

/**
 * The distribution a table states by *repeating* a measure, rather than by carrying five columns.
 *
 * A boxplot used to need `min, q1, median, q3, max` as five columns of the result set, which is what
 * a pre-aggregated export looks like. A result set that lists one observation per row — which is
 * what a `SELECT year, revenue` returns — carries the same distribution in a shape the admission
 * could not see, so 164 of Text2Vis's 1,470 scored rows named a boxplot their table was said not to
 * hold. The reading that follows from it is a *derivation*: fold the measure's values into the five
 * numbers, and label the box with the column they came from.
 *
 * Every test below is about one of the four facts that makes that derivation honest: the estimator
 * is named (type 7, not "some interpolation"), the label is the column rather than a row index, the
 * sample floor is stated, and a table that already carries five columns is read the old way.
 */
const YEARS = ['2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026', '2027', '2028'];

/** Ten observations of one measure along a time axis: values 1 to 10. */
const TEN = YEARS.map((year, index) => ({ year, value: index + 1 }));

describe('a boxplot derived from a repeated measure', () => {
  it('reads ten observations of one measure as one five-number box', () => {
    const ir = toChartIR('show the distribution of value', TEN, { mark: 'boxplot' });
    expect(ir.mark).toBe('boxplot');
    expect(ir.data).toHaveLength(1);
    // Values 1..10, interpolated: q1 sits a quarter of the way from 3 to 4, and so on. The numbers
    // are the assertion: a summary that is off by an interpolation rule is a picture of a different
    // distribution, and no label-based score can see it.
    expect(ir.data[0]).toEqual({ measure: 'value', min: 1, q1: 3.25, median: 5.5, q3: 7.75, max: 10 });
    // The five numbers are the encoding, in the order the contract fixes, and the box is named by a
    // column that is not in the result set — the same materialisation `countsOf` performs.
    expect(ir.encoding.y).toEqual([
      { field: 'min', type: 'quantitative' },
      { field: 'q1', type: 'quantitative' },
      { field: 'median', type: 'quantitative' },
      { field: 'q3', type: 'quantitative' },
      { field: 'max', type: 'quantitative' },
    ]);
    expect(ir.encoding.x).toEqual({ field: 'measure', type: 'nominal' });
  });

  it('interpolates the quartiles linearly, which is the estimator R calls type 7', () => {
    // Four observations, so every quartile lands between two values: 10, 20, 30, 40 reads
    // q1 = 17.5, median = 25, q3 = 32.5. A "nearest rank" estimator would read 10, 25, 30, and the
    // difference is the whole width of the box.
    const four = [10, 20, 30, 40].map((value, index) => ({ year: String(2000 + index), value }));
    expect(toChartIR('distribution of value', four, { mark: 'boxplot' }).data[0]).toEqual({
      measure: 'value',
      min: 10,
      q1: 17.5,
      median: 25,
      q3: 32.5,
      max: 40,
    });
  });

  it('draws one box per measure, named by the column it summarises', () => {
    // Two measures and one category axis: the reading is "these two columns, as distributions". It
    // is not one box per category — that would summarise a single observation per box — and it is
    // not the widest measure alone, which would silently drop the column the question named.
    const table = [
      { country: 'US', Male: 18.4, Female: 12.4 },
      { country: 'BR', Male: 26.4, Female: 20.4 },
      { country: 'CA', Male: 15.7, Female: 11 },
      { country: 'IN', Male: 24.1, Female: 18.2 },
      { country: 'JP', Male: 19.9, Female: 14.8 },
    ];
    const ir = toChartIR('analyze the distribution of male percentages', table, { mark: 'boxplot' });
    expect(ir.data.map((row) => row['measure'])).toEqual(['Male', 'Female']);
    expect(ir.data[0]).toMatchObject({ min: 15.7, max: 26.4, median: 19.9 });
    expect(ir.data[1]).toMatchObject({ min: 11, max: 20.4, median: 14.8 });
  });

  it('refuses a sample too small to have a quarter per observation, and says how many it has', () => {
    const three = [1, 2, 3].map((value, index) => ({ year: String(2000 + index), value }));
    expect(() => toChartIR('distribution of value', three, { mark: 'boxplot' })).toThrow(/at least 4 rows/);
    // Four is the floor and not a preference: at four every quarter of the box is anchored by its
    // own observation.
    expect(toChartIR('distribution of value', [...three, { year: '2003', value: 4 }], { mark: 'boxplot' }).data).toHaveLength(1);
  });

  it('does not read a distribution from a profile alone, because a profile has no rows in it', () => {
    // The discipline the counted measure already follows: twelve countries and twelve thousand sales
    // profile the same. A caller that knows the row count passes it; the recommender does not guess.
    const without = recommendChart('show the distribution of value', profileRows(TEN));
    expect(without.recommendations.map((entry) => entry.mark)).not.toContain('boxplot');
    expect(without.refused.map((entry) => entry.mark)).toContain('boxplot');
    const withRows = recommendChart('show the distribution of value', profileRows(TEN), { rows: TEN.length });
    expect(withRows.recommendations[0]?.mark).toBe('boxplot');
  });

  it('does not summarise the counted measure, which is a number per group rather than per row', () => {
    // Five years, twice each: the table has no measure column, so the recommender materialises a
    // count — and a summary of five counts is a histogram of the groups, not a distribution of the
    // result set. The admission refuses it with the sentence that names what is missing.
    const counts = YEARS.slice(0, 5).flatMap((year) => [{ year }, { year }]);
    expect(() => toChartIR('distribution of orders', counts, { mark: 'boxplot' })).toThrow(/at least 4 rows/);
  });

  it('keeps the five-column reading when the table already carries five numbers per row', () => {
    // Three regions, because a two-row column of `1, 2` profiles as a scale rather than a measure —
    // the profiler's own rule, and the reason this fixture is not the smallest one that would type.
    const fiveNumbers = [
      { region: 'north', min: 1, q1: 2, median: 3, q3: 4, max: 5 },
      { region: 'south', min: 2, q1: 3, median: 4, q3: 5, max: 6 },
      { region: 'east', min: 3, q1: 4, median: 5, q3: 6, max: 7 },
    ];
    const ir = toChartIR('distribution of revenue by region', fiveNumbers, { mark: 'boxplot' });
    expect(ir.data).toHaveLength(3);
    expect(ir.data[0]).toMatchObject({ region: 'north', min: 1, max: 5 });
    const y = ir.encoding.y;
    expect((Array.isArray(y) ? y : [y]).map((field) => field?.field)).toEqual(['min', 'q1', 'median', 'q3', 'max']);
    // The tuple reading is untouched, including its one gap: a pre-aggregated table with no ordered
    // axis labels its boxes by row index rather than by `region`. That is what shipped before this
    // change and it is not this change's to move — the derived reading below is the one with a label
    // column, because it is the one that invents rows and has to say what they are.
    expect(ir.encoding.x).toBeUndefined();
  });

  it('names its label column something the result set does not already hold', () => {
    const table = YEARS.map((_, index) => ({ measure: `group ${String(index)}`, value: index + 1 }));
    const ir = toChartIR('distribution of value', table, { mark: 'boxplot' });
    expect(ir.encoding.x).toEqual({ field: 'measure_2', type: 'nominal' });
    expect(ir.data[0]?.['measure_2']).toBe('value');
  });

  it('summarises the numbers and leaves the cells that are not numbers out of it', () => {
    // `NaN` is a cell a result set prints and a profile still types as a measure. Counting it would
    // make every quartile `NaN`, and a box whose five numbers are all `NaN` is a chart of nothing.
    const table = [1, 2, Number.NaN, 3, 4, 5].map((value, index) => ({ year: String(2000 + index), value }));
    const ir = toChartIR('distribution of value', table, { mark: 'boxplot' });
    expect(ir.data[0]).toEqual({ measure: 'value', min: 1, q1: 2, median: 3, q3: 4, max: 5 });
  });

  it('refuses when no measure holds enough numbers to summarise, and names the count that failed', () => {
    // Six rows and one measure, and not one cell of it is a number: the row count is satisfied and
    // the numbers are not. The refusal says which of the two, because "a boxplot reads five numbers
    // per row" is a sentence a reader of this table cannot act on — they have five rows per measure.
    const empty = Array.from({ length: 6 }, (_, index) => ({ year: String(2000 + index), value: Number.NaN }));
    expect(() => toChartIR('distribution of value', empty, { mark: 'boxplot' })).toThrow(/1 measures over 6 rows, the fullest holding 0 numbers/);
  });

  it('draws the same box on every run, because a prompt hashed into a cache key needs it to', () => {
    expect(JSON.stringify(toChartIR('distribution of value', TEN, { mark: 'boxplot' }))).toBe(
      JSON.stringify(toChartIR('distribution of value', TEN, { mark: 'boxplot' })),
    );
  });
});

describe('what the derived boxplot changes about advice', () => {
  it('answers a distribution question with a boxplot, where it used to answer a bar', () => {
    // The product's own answer moves with the admission, which is the point: a cue table that asks
    // for a distribution and an admission that refuses every distribution is a cue being overruled
    // by a rule about columns.
    expect(toChartIR('show the distribution of value', TEN).mark).toBe('boxplot');
    // And a question that asks for no distribution still gets the bar it asked for.
    expect(toChartIR('revenue by year', TEN).mark).toBe('line');
  });

  it('admits a boxplot on a table whose distribution is in its rows', () => {
    expect(admittedOptions('distribution of value', TEN).map((option) => option.name)).toContain('boxplot');
    // And still refuses it where there is no distribution to read.
    expect(admittedOptions('total revenue', [{ value: 5 }]).map((option) => option.name)).toEqual(['gauge']);
  });

  it('draws the model s answer where the table used to veto it', async () => {
    // The reading this feature is for: a model that named a boxplot on a one-measure table was
    // answered with the table's bar, and the row was counted as a veto rather than as an answer.
    // Now the table answers the same mark, so the row is one model answer that the drawing agrees
    // with — the 164 rows of Text2Vis that named a boxplot their table was said not to hold.
    const chart = await assistedChartIR('analyze the distribution of value', TEN, { advisor: async () => 'boxplot' });
    expect(chart.ir.mark).toBe('boxplot');
    expect(chart.decision).toEqual({ mark: 'boxplot', source: 'model', product: 'boxplot' });
    // A boxplot is still refused where a distribution cannot be read, so the admission is a rule
    // about the result set and not a widening of what a model may ask for.
    const gauge = await assistedChartIR('total revenue', [{ value: 5 }], { advisor: async () => 'boxplot' });
    expect(gauge.decision).toMatchObject({ mark: 'gauge', source: 'product', veto: 'not-admitted' });
  });
});
