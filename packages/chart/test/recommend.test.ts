import { describe, expect, it } from 'vitest';
import type { ChartIR } from '@agentix-e/nl2charts-spec';
import { SERIES_TYPES, isNl2ChartsError, parseChartIR } from '@agentix-e/nl2charts-spec';
import type { FieldProfile } from '../src/profile.js';
import { profileRows } from '../src/profile.js';
import { CHART_CUES, DEFAULT_MAX_SLICES, readCues, recommendChart, toChartIR, wholeColumns } from '../src/recommend.js';
import { compileToECharts } from '../src/compile.js';
import { compileToMatplotlib } from '../src/matplotlib.js';
import { isRenderable, lint } from '../src/lint.js';

const rows = (spec: Record<string, readonly unknown[]>): Record<string, unknown>[] => {
  const keys = Object.keys(spec);
  const height = Math.max(...keys.map((key) => spec[key]?.length ?? 0));
  return Array.from({ length: height }, (_, index) =>
    Object.fromEntries(keys.map((key) => [key, spec[key]?.[index]])),
  );
};

const monthly = rows({
  month: ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'],
  revenue: [120, 150, 90, 210],
});
const regions = rows({
  region: ['north', 'south', 'west'],
  revenue: [120, 90, 60],
});
const products = rows({
  product: ['a', 'b', 'c', 'd'],
  revenue: [12, 30, 7, 21],
});
const twoMeasures = rows({
  price: [10, 12, 15, 20],
  rating: [4.1, 4.4, 3.9, 4.8],
});
const matrix = rows({
  region: ['north', 'north', 'south', 'south'],
  quarter: ['Q1', 'Q2', 'Q1', 'Q2'],
  revenue: [10, 12, 9, 11],
});
const fiveNumbers = rows({
  min: [1, 2, 3],
  q1: [4, 5, 6],
  median: [7, 8, 9],
  q3: [10, 11, 12],
  max: [13, 14, 15],
});
const ohlc = rows({
  day: ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'],
  open: [10, 11, 12, 13, 14.5, 15, 16, 17.5],
  close: [11, 12.5, 11, 14, 15.5, 16, 16.5, 18],
  low: [9, 10.5, 10, 12.5, 14, 14.5, 15.5, 17],
  high: [12, 13, 13, 14.5, 16, 16.5, 17, 19],
});
const stages = rows({
  stage: ['visit', 'signup', 'purchase'],
  users: [1000, 400, 90],
});
const metrics = rows({
  product: ['a', 'b', 'c'],
  revenue: [12, 30, 7],
  orders: [3, 8, 2],
  margin: [0.2, 0.35, 0.1],
});
const single = rows({ revenue: [42] });

const profiles = (data: readonly Record<string, unknown>[]): FieldProfile[] => profileRows(data);

describe('reading chart cues out of the question', () => {
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ['How did revenue trend over time?', ['trend']],
    ['Show the monthly revenue growth', ['trend']],
    ['What share of revenue does each region hold?', ['share']],
    ['Show the distribution of order values', ['distribution']],
    ['Is price correlated with rating?', ['correlation']],
    ['Top ten products by revenue', ['ranking']],
    ['Revenue by region and quarter', ['matrix']],
    ['How are we tracking against target this quarter?', ['progress']],
    ['Conversion funnel by stage', ['explicit', 'stages']],
    ['Compare the metrics in parallel across products', ['multi-metric']],
    ['Show a radar profile of the metrics', ['explicit', 'profile']],
    ['Daily open and close prices', ['volatility']],
  ];

  it.each(cases)('%s', (question, kinds) => {
    expect(readCues(question).map((cue) => cue.kind)).toEqual(kinds);
  });

  it('tells a comparison from a part of a whole, because the corpus draws them differently', () => {
    // One cue for two questions was the defect: "the share of orders by status" is categories
    // compared and the corpus drew a bar; "the share of revenue that is refunds" is a part of a whole
    // and it drew a pie. The narrow cue is listed first, so the comparison leads and the part falls
    // through to `share` with its marks untouched.
    expect(readCues('share by status').map((cue) => cue.kind)).toEqual(['share-by', 'share']);
    expect(readCues('the share of revenue that is refunds').map((cue) => cue.kind)).toEqual(['share']);
    expect(readCues('a breakdown across regions').map((cue) => cue.kind)).toEqual(['share-by', 'share']);
    // The narrow width reads the phrase and not the thought: a measure between the two words
    // ("the share **of orders** by status") is out of reach, which is the limitation the wide width
    // was priced for and refused — it answered 186 more bar rows and lost 142 pies, which is the
    // blunt "a share is a bar" rule wearing a phrase.
    expect(readCues('the share of orders by status').map((cue) => cue.kind)).toEqual(['share']);
    // Both pictures are still on the list under the narrow cue, in its order.
    expect(readCues('share by status').flatMap((cue) => cue.marks)).toEqual(['bar', 'pie', 'bar']);
  });

  it('reads a crossing inside one clause, and stops reading one across a full stop', () => {
    // The unbounded pattern decided 223 questions on the corpus and was right about one: its `by` and
    // its `and` were in different sentences, which is how "average revenue by region. Plot it and
    // label the axes" became a heatmap question.
    expect(readCues('average revenue by region and channel').map((cue) => cue.kind)).toEqual(['matrix']);
    expect(readCues('average revenue by region. Plot it and label the axes').map((cue) => cue.kind)).toEqual([]);
    // The two words, in that order, one clause apart, is the whole rule; a bound of a sentence and not
    // a word count, so a measure named between them still reads as a crossing.
    expect(readCues('the share of revenue by region and the count of orders').map((cue) => cue.kind)).toContain('matrix');
  });

  it('carries the phrase it matched, so the choice can be quoted back', () => {
    const [cue] = readCues('Top ten products by revenue');
    expect(cue?.phrase).toBe('top');
  });

  it('reads the same cues in Chinese, because the question is not always English', () => {
    expect(readCues('各区域销售额占比').map((cue) => cue.kind)).toEqual(['share']);
    expect(readCues('每月的销售趋势').map((cue) => cue.kind)).toEqual(['trend']);
  });

  it('reads the mark a question names, because a reader who says "pie chart" wants a pie', () => {
    // The gap the corpus found: Text2Vis questions say `plot these percentages ... on a line chart`,
    // and this table had no rule for it. A user who names a chart type is not asking for a
    // recommendation, they are stating the answer, and the product ranked a bar instead. The rule
    // requires the mark word next to chart/plot/graph, so the instruction boilerplate ("generate
    // matplotlib code") cannot fire it.
    expect(readCues('Plot revenue as a pie chart').map((cue) => cue.marks[0])).toEqual(['pie']);
    expect(readCues('Show this on a line chart').map((cue) => cue.kind)).toEqual(['explicit']);
    expect(readCues('Draw a bar chart of revenue by region')[0]?.kind).toBe('explicit');
    expect(readCues('Show a scatter plot of price and rating')[0]?.marks).toEqual(['scatter']);
    expect(readCues('Generate matplotlib code that visualizes the result')).toEqual([]);
  });

  it('honours the named mark over the shape it would otherwise prefer', () => {
    // A category axis with one measure: the recommender's default is a bar, and a question that names
    // a line still gets the line — which is the case 350 corpus rows are labelled for.
    const choice = recommendChart('Plot these percentages on a line chart', profiles(regions));
    expect(choice.recommendations[0]?.mark).toBe('line');
    const named = recommendChart('Show a bar chart of this', profiles(monthly));
    expect(named.recommendations[0]?.mark).toBe('bar');
  });

  it('finds nothing in a question that names no shape', () => {
    expect(readCues('How many orders shipped')).toEqual([]);
  });

  it('reads a table it is given, and resets a global pattern so the second call can match', () => {
    // The parameter exists for `eval/text2vis`, which prices an alternative ordering against the
    // corpus. A caller that supplies a table with a `/g` pattern would otherwise see every other
    // question match nothing, because `exec` carries `lastIndex` between calls — a silent miss that
    // looks like a cue that does not fire.
    const table = [{ kind: 'ranking' as const, marks: ['bar'] as const, pattern: /\btop\b/g }];
    expect(readCues('top five by revenue', table).map((cue) => cue.kind)).toEqual(['ranking']);
    expect(readCues('top five by revenue', table).map((cue) => cue.kind)).toEqual(['ranking']);
    // The shipped table is untouched by a call that named another one.
    expect(readCues('Top ten products by revenue')[0]?.kind).toBe('ranking');
  });

  it('declares which marks every cue speaks for, and every one is in the contract', () => {
    for (const cue of CHART_CUES) {
      expect(cue.marks.length).toBeGreaterThan(0);
      for (const mark of cue.marks) expect(SERIES_TYPES).toContain(mark);
    }
  });
});

describe('recommending a chart from the question and the result set', () => {
  const cases: readonly (readonly [string, readonly Record<string, unknown>[], string])[] = [
    ['How did revenue trend over time?', monthly, 'line'],
    ['What share of revenue does each region hold?', regions, 'pie'],
    ['Top products by revenue', products, 'bar'],
    ['Is price correlated with rating?', twoMeasures, 'scatter'],
    ['Revenue by region and quarter', matrix, 'heatmap'],
    ['Show the distribution of order values', fiveNumbers, 'boxplot'],
    ['Daily open and close prices', ohlc, 'candlestick'],
    ['How are we tracking against target?', single, 'gauge'],
    ['Conversion funnel by stage', stages, 'funnel'],
    ['Compare the metrics in parallel across products', metrics, 'parallel'],
    ['Show a radar profile of the metrics per product', metrics, 'radar'],
  ];

  it.each(cases)('%s', (question, data, mark) => {
    const choice = recommendChart(question, profiles(data));
    expect(choice.recommendations[0]?.mark).toBe(mark);
  });

  it('still recommends on structure when the question names no shape at all', () => {
    const choice = recommendChart('How many orders shipped', profiles(regions));
    expect(choice.recommendations.map((item) => item.mark)).toContain('bar');
    expect(choice.recommendations[0]?.cues).toEqual([]);
  });

  it('answers a comparison with the bar the corpus drew for it, and a part with the pie', () => {
    // The shipped table's own reading of the two: same result set, two questions, two marks.
    expect(recommendChart('share by status', profiles(regions)).recommendations[0]?.mark).toBe('bar');
    expect(recommendChart('the share of revenue that is refunds', profiles(regions)).recommendations[0]?.mark).toBe('pie');
  });

  it('ranks a mark the question names above a mark that only collects second places', () => {
    // Bar is the second mark of seven of the twelve cues, so a prompt carrying three cue phrases pays
    // it twice each and it outranks a mark the question named outright. Text2Vis states the row:
    // `line 5 [trend] < bar 6 [trend matrix]`. Naming is a request, so it is the primary key.
    const choice = recommendChart('What is the trend of revenue by month and region?', profiles(regions));
    expect(choice.recommendations[0]?.mark).toBe('line');
    expect(choice.recommendations[0]?.cues).toEqual(['trend']);
    const bar = choice.recommendations.find((entry) => entry.mark === 'bar');
    // The score still says what the cues paid, so a reader can see that the bar scored higher and
    // why it did not win: two cues name it second, and none names it first.
    expect(bar?.score).toBe(6);
    expect(bar?.cues).toEqual(['trend', 'matrix']);
  });

  it('pays for that key when the label wants the collector, and says so rather than hiding it', () => {
    // The same rule read the other way: a bar label over a question that names a pie, a line and a
    // heatmap. The bar collected all three as a fallback and now it loses. This is the cost of the
    // ordering, and the reason it was measured on 1,470 rows before it was shipped.
    const choice = recommendChart('What percentage of revenue is trending by region and channel?', profiles(matrix));
    expect(choice.recommendations[0]?.mark).not.toBe('bar');
    expect(choice.recommendations.find((entry) => entry.mark === 'bar')?.score).toBeGreaterThan(
      choice.recommendations[0]?.score ?? 0,
    );
  });

  it('keeps the score order among marks named first the same number of times', () => {
    // Two keys, not one: `distribution` names the boxplot first, and the bar collects its second
    // place. Neither is named first twice, so the counted score decides between them.
    const choice = recommendChart('Show the distribution of order values', profiles(fiveNumbers));
    expect(choice.recommendations[0]?.mark).toBe('boxplot');
    const scores = choice.recommendations.map((entry) => entry.score);
    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
  });

  it('scores with counted facts, not a hidden weight', () => {
    const choice = recommendChart('How did revenue trend over time?', profiles(monthly));
    const line = choice.recommendations.find((item) => item.mark === 'line');
    expect(line?.score).toBe(8);
    expect(line?.reasons).toEqual(['profile:axis-and-measure', 'profile:time-axis', 'cue:trend "trend"']);
  });

  it('is deterministic, including the order of equal scores', () => {
    const first = JSON.stringify(recommendChart('Revenue by region', profiles(regions)));
    const second = JSON.stringify(recommendChart('Revenue by region', profiles(regions)));
    expect(first).toBe(second);
  });

  it('reports the shape its rules were applied to, so a refusal can be explained without re-deriving it', () => {
    // The three counts every admission rule reads. A caller that disagrees with a refusal can point
    // at the number that caused it — "a line needs an ordered axis and a measure" is not actionable
    // until the reader knows the table had no ordered column — and `eval/text2vis` counts refusals by
    // this shape rather than restating `shapeOf` in a second place.
    expect(recommendChart('How did revenue trend over time?', profiles(monthly)).shape).toEqual({
      dims: 1,
      ordered: 1,
      measures: 1,
      counted: false,
    });
    // A category axis and no time: the same dims, one fewer ordered dimension.
    expect(recommendChart('Revenue by region', profiles(regions)).shape).toEqual({
      dims: 1,
      ordered: 0,
      measures: 1,
      counted: false,
    });
    // Two measures and nothing to group them by.
    expect(recommendChart('Is price correlated with rating?', profiles(twoMeasures)).shape).toEqual({
      dims: 0,
      ordered: 0,
      measures: 2,
      counted: false,
    });
  });

  it('never ranks a mark the data cannot encode, and says why it refused', () => {
    const choice = recommendChart('What share of revenue does each region hold?', profiles(regions));
    expect(choice.recommendations.map((item) => item.mark)).not.toContain('scatter');
    expect(choice.refused.find((item) => item.mark === 'scatter')?.reason).toBe('a scatter needs two measures');
    expect(choice.refused.find((item) => item.mark === 'gauge')?.reason).toBe(
      'a gauge needs exactly one measure and no category axis',
    );
  });

  it('refuses a pie over a negative measure even when the question asks for a share', () => {
    const negative = rows({ region: ['north', 'south'], revenue: [-5, 20] });
    const choice = recommendChart('What share of revenue does each region hold?', profiles(negative));
    expect(choice.recommendations.map((item) => item.mark)).not.toContain('pie');
    expect(choice.refused.find((item) => item.mark === 'pie')?.reason).toBe(
      'a pie needs one category of at most 12 slices, none of them negative',
    );
  });

  it('refuses a pie over more slices than a reader can name, and admits the last one it can', () => {
    // The boundary is read off the constant rather than restated: twelve slices is a pie and thirteen
    // is a table, and a test that hard-coded both numbers would pass on a default nobody chose. The
    // corpus is what chose it — a cap of eight or nine scores *worse* than seven, and twelve is the
    // first value where the pie the cue table asks for is no longer overruled by a constant.
    const wide = (count: number): ReturnType<typeof rows> =>
      rows({
        region: Array.from({ length: count }, (_, index) => `r${String(index)}`),
        revenue: Array.from({ length: count }, (_, index) => index + 1),
      });
    const last = recommendChart('Share of revenue by region', profiles(wide(DEFAULT_MAX_SLICES)));
    expect(last.recommendations[0]?.mark).toBe('pie');
    const over = recommendChart('Share of revenue by region', profiles(wide(DEFAULT_MAX_SLICES + 1)));
    expect(over.recommendations.map((item) => item.mark)).not.toContain('pie');
    expect(over.refused.find((item) => item.mark === 'pie')?.reason).toContain(`at most ${String(DEFAULT_MAX_SLICES)} slices`);
  });

  it('refuses every mark when the result set carries no measure', () => {
    const names = rows({ product: ['a', 'b'], region: ['north', 'south'] });
    const choice = recommendChart('Which products are there?', profiles(names));
    expect(choice.recommendations).toEqual([]);
    expect(choice.refused.length).toBeGreaterThan(0);
  });

  it('lists a refusal for every mark it considered, so the audit trail is complete', () => {
    const choice = recommendChart('Top products by revenue', profiles(products));
    const seen = new Set([...choice.recommendations.map((item) => item.mark), ...choice.refused.map((item) => item.mark)]);
    expect(seen).toEqual(new Set(['bar', 'line', 'pie', 'funnel', 'scatter', 'heatmap', 'boxplot', 'candlestick', 'radar', 'parallel', 'gauge']));
  });

  it('records the cue that moved each mark, and only marks the cue speaks for', () => {
    const choice = recommendChart('Conversion funnel by stage', profiles(stages));
    const funnel = choice.recommendations.find((item) => item.mark === 'funnel');
    const pie = choice.recommendations.find((item) => item.mark === 'pie');
    // Two cues name the funnel now: the explicit `funnel` in the phrase and the stage vocabulary.
    expect(funnel?.cues).toEqual(['explicit', 'stages']);
    expect(pie?.cues).toEqual([]);
  });
});

describe('a tie between bar and line is a fact about the data, not about the list order', () => {
  it('prefers the line when the axis is a time axis and the question names neither mark', () => {
    // 'for each month' fires no cue: `trend` needs `by month`, `monthly` or `trend` itself. Both marks
    // are admissible at the same prior, so this used to fall to the preference order — the answer was
    // a bar because `bar` is first in `RECOMMENDABLE_MARKS`, which is a fact about the list rather
    // than about the result set.
    const choice = recommendChart('Revenue for each month', profiles(monthly));
    expect(choice.recommendations[0]?.mark).toBe('line');
    expect(choice.recommendations[0]?.cues).toEqual([]);
  });

  it('states the time axis as a counted fact, so the score can be recomputed from the reasons', () => {
    const choice = recommendChart('Revenue for each month', profiles(monthly));
    const line = choice.recommendations.find((item) => item.mark === 'line');
    const bar = choice.recommendations.find((item) => item.mark === 'bar');
    // Two points for fitting the shape, three for the axis being time — what a cue that names the mark
    // is worth — and none for cues, because the question names neither mark.
    expect(line?.score).toBe(5);
    expect(line?.reasons).toEqual(['profile:axis-and-measure', 'profile:time-axis']);
    // The bar is not refused and it is not penalised: it is simply not the mark the data points at.
    expect(bar?.score).toBe(2);
    expect(bar?.reasons).toEqual(['profile:category-axis-and-measure']);
  });

  it('leaves a nominal axis on the tie-break it had, because nothing there says time', () => {
    // The bonus is about the axis, not about the line: the same question over a category axis is still
    // the bar the corpus draws for it, and that case is the one the bonus must not move.
    const choice = recommendChart('Revenue for each region', profiles(regions));
    expect(choice.recommendations[0]?.mark).toBe('bar');
    expect(choice.recommendations[0]?.cues).toEqual([]);
  });

  it('still gives the bar to a question that names it first, time axis or not', () => {
    // Naming is the primary key and stays the primary key: `highest` is a ranking question, and a
    // ranking question over months is a bar whatever the axis is. The bonus is the third key's
    // currency, so it cannot outrank the first.
    const choice = recommendChart('Which month has the highest revenue?', profiles(monthly));
    expect(choice.recommendations[0]?.mark).toBe('bar');
    expect(choice.recommendations[0]?.cues).toEqual(['ranking']);
  });

  it('does not pay the bonus to a mark that needs two axes', () => {
    // A heatmap over a time axis is not a trend: the bonus is stated for the mark whose whole
    // encoding is the interval, and a mark that reads two categories has no interval to state.
    const choice = recommendChart('Revenue for each month and region', profiles(matrix));
    expect(choice.recommendations.find((item) => item.mark === 'heatmap')?.reasons).not.toContain('profile:time-axis');
  });
});

describe('turning a recommendation into a chart the compiler accepts', () => {
  it('builds a contract-valid IR whose title is the question and whose alt names the mark', () => {
    const question = 'How did revenue trend over time?';
    const ir = toChartIR(question, monthly);
    expect(parseChartIR(ir).mark).toBe('line');
    expect(ir.title).toBe(question);
    expect(ir.alt).toContain('line');
    expect(ir.encoding.x).toMatchObject({ field: 'month', type: 'temporal' });
    expect(ir.data.length).toBe(monthly.length);
  });

  it('runs a line over a category axis along the measure, because that is the only order there is', () => {
    // The admission rule for a line was widened to admit a category axis, on the ground that the
    // corpus labels 350 rows a line or an area over categories ("plot these percentages in order of
    // increasing Value ... on a line chart"). `encodingFor` kept reading `shape.ordered[0]`, which is
    // empty for a nominal axis, so the widened rule produced a TypeError on 106 of the corpus's 1,470
    // scored rows: a crash, not a refusal, and one that no reading of `recommendChart` could see
    // because the product's own chart builder is the only caller of `toChartIR`.
    const ranked = rows({ product: ['beta', 'alpha', 'gamma'], revenue: [30, 10, 20] });
    const ir = toChartIR('Plot the revenue by product on a line chart', ranked);
    expect(ir.mark).toBe('line');
    expect(ir.encoding.x).toMatchObject({ field: 'product', type: 'nominal' });
    expect(ir.data.map((row) => row.revenue)).toEqual([10, 20, 30]);
  });

  it('leaves an ordered axis in the order the query produced', () => {
    // The same line, with an axis that carries its own order: sorting by the measure here would be
    // the chart stating an order the result set already stated differently.
    const ir = toChartIR('How did revenue trend over time?', monthly);
    expect(ir.encoding.x).toMatchObject({ field: 'month', type: 'temporal' });
    expect(ir.data.map((row) => row.month)).toEqual(monthly.map((row) => row.month));
  });

  it('keeps ties and unreadable cells where the query put them when it orders a line by its measure', () => {
    // Two rows at 5 and two cells that are numbers but not values. The tied pair must keep the order
    // the query returned — a reading that depended on the engine's sort being stable would be a
    // reading about the engine — and the unreadable rows must stay on the line, in their own order,
    // because dropping them would shorten the picture.
    const tied = rows({ product: ['e', 'd', 'c', 'b', 'a'], revenue: [5, Number.NaN, 5, 1, Infinity] });
    const ir = toChartIR('Plot the revenue by product on a line chart', tied);
    expect(ir.data.map((row) => row.product)).toEqual(['b', 'e', 'c', 'd', 'a']);
  });

  it('orders a bar by its measure when the question asked for a ranking', () => {
    // A ranking question is a question about an order, and the order of a result set is the order of
    // its rows — which is the order the query returned them in, not the order the question asked
    // about. Drawn as returned, `Top products by revenue` is a bar chart whose bars are shuffled:
    // the reader has to find the tallest bar themselves, which is the one thing the mark exists to
    // save them. 287 of the corpus's 503 ranking questions drawn as a bar, pie or funnel came back
    // in an order the measure does not have.
    const ir = toChartIR('Top products by revenue', products);
    expect(ir.mark).toBe('bar');
    expect(ir.data.map((row) => row.revenue)).toEqual([30, 21, 12, 7]);
  });

  it('orders it the other way when the question asked for the bottom', () => {
    // `lowest` names the same order reversed, and a chart that answered it with the largest bar
    // first would be answering the other question. The direction is read from the question for the
    // reason the mark is: it is a fact about the sentence, not about the table.
    const ir = toChartIR('Which products have the lowest revenue?', products);
    expect(ir.mark).toBe('bar');
    expect(ir.data.map((row) => row.revenue)).toEqual([7, 12, 21, 30]);
  });

  it('follows the end the question names first when it names both', () => {
    // A sentence can carry both words — "the most, not the least" — and then the direction is the
    // one the reader reaches first: the position in the sentence decides, not the order the two
    // patterns happen to be listed in. This is the branch that reads the earlier of two matches,
    // and the reason the loop compares indices instead of taking the first pattern that matches.
    const both = toChartIR('Which products have the most revenue, not the least?', products);
    expect(both.data.map((row) => row.revenue)).toEqual([30, 21, 12, 7]);
    const reversed = toChartIR('Which products have the least revenue, not the most?', products);
    expect(reversed.data.map((row) => row.revenue)).toEqual([7, 12, 21, 30]);
  });

  it('leaves the rows alone when the question asked for no order', () => {
    // The rule fires on the sentence that asks for it. A bar of `Revenue by product` is the table
    // in the table's order, and sorting it would be the chart inventing a ranking nobody asked for
    // — the same defect as the aggregate this file refuses to invent.
    const ir = toChartIR('Revenue by product', products);
    expect(ir.mark).toBe('bar');
    expect(ir.data.map((row) => row.revenue)).toEqual([12, 30, 7, 21]);
  });

  it('does not rank a bar on a time axis, because a year is not a contest', () => {
    // `Top months by revenue` still runs along the calendar: the axis carries its own order, and
    // sorting a time axis by the measure would draw a line through a shuffle. The rule therefore
    // reads the axis type, not only the question.
    const ir = toChartIR('Top months by revenue', monthly);
    expect(ir.encoding.x).toMatchObject({ field: 'month', type: 'temporal' });
    expect(ir.data.map((row) => row.month)).toEqual(monthly.map((row) => row.month));
  });

  it('counts upward when the question asked for the fewest, because a count axis is a ranking too', () => {
    // The counted path already ranked its groups — it is the only ranking the table can express when
    // there is no measure — but it ranked them one way only. 35 of the corpus's 113 counted tables
    // are asked a ranking question and one of them asks for the smallest ("What is the smallest
    // number of countries ..."), which came back largest first: the same rule, two paths, and one of
    // them ignoring the direction.
    const log = rows({ product: ['a', 'a', 'b', 'c', 'c', 'c', 'c'] });
    const fewest = toChartIR('Which products have the fewest orders?', log);
    expect(fewest.data.map((row) => row.count)).toEqual([1, 2, 4]);
    const most = toChartIR('Which products have the most orders?', log);
    expect(most.data.map((row) => row.count)).toEqual([4, 2, 1]);
  });

  it('lints clean and compiles to a series for every recommendation it will make', () => {
    const fixtures: readonly (readonly [string, readonly Record<string, unknown>[]])[] = [
      ['How did revenue trend over time?', monthly],
      ['What share of revenue does each region hold?', regions],
      ['Top products by revenue', products],
      ['Is price correlated with rating?', twoMeasures],
      ['Revenue by region and quarter', matrix],
      ['Show the distribution of order values', fiveNumbers],
      ['Daily open and close prices', ohlc],
      ['How are we tracking against target?', single],
      ['Conversion funnel by stage', stages],
      ['Compare the metrics in parallel across products', metrics],
      ['Show a radar profile of the metrics per product', metrics],
    ];
    for (const [question, data] of fixtures) {
      const ir = toChartIR(question, data);
      const issues = lint(ir);
      expect({ question, errors: issues.filter((issue) => issue.severity === 'error') }).toEqual({
        question,
        errors: [],
      });
      expect(isRenderable(issues)).toBe(true);
      const option = compileToECharts(ir) as { series?: { type?: string }[] };
      expect(option.series?.[0]?.type).toBe(ir.mark);
    }
  });

  it('orders the candlestick tuple the way the renderer reads it, whatever the column order', () => {
    const shuffled = rows({
      day: ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06'],
      close: [11, 12.5, 11, 14, 15.5, 16],
      high: [12, 13, 13, 14.5, 16, 16.5],
      open: [10, 11, 12, 13, 14.5, 15],
      low: [9, 10.5, 10, 12.5, 14, 14.5],
    });
    const ir = toChartIR('Daily open and close prices', shuffled);
    expect(ir.mark).toBe('candlestick');
    const y = Array.isArray(ir.encoding.y) ? ir.encoding.y : [ir.encoding.y];
    expect(y.map((ref) => ref?.field)).toEqual(['open', 'close', 'low', 'high']);
  });

  it('caps the rows it will carry, because the contract refuses more than fifty thousand', () => {
    const big = rows({ region: Array.from({ length: 5 }, (_, index) => `r${String(index)}`), revenue: [1, 2, 3, 4, 5] });
    const ir = toChartIR('Top regions by revenue', big, { limit: 2 });
    expect(ir.data.length).toBe(2);
  });

  it('honours an explicit title, alt and theme', () => {
    const ir = toChartIR('Top products by revenue', products, { title: 'Revenue', alt: 'Bars', theme: 'print' });
    expect(ir).toMatchObject({ title: 'Revenue', alt: 'Bars', theme: 'print' });
  });

  it('carries a subtitle when the caller has one', () => {
    const ir = toChartIR('Top products by revenue', products, { subtitle: 'fiscal 2026' });
    expect(ir.subtitle).toBe('fiscal 2026');
  });

  it('takes the slice limit from the caller, because readability is a deployment decision', () => {
    const wide = rows({
      region: Array.from({ length: 9 }, (_, index) => `r${String(index)}`),
      revenue: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    });
    const choice = recommendChart('Share of revenue by region', profiles(wide), { maxSlices: 9 });
    expect(choice.recommendations[0]?.mark).toBe('pie');
  });

  it('refuses an empty result set instead of emitting a chart of nothing', () => {
    expect(() => toChartIR('Top products by revenue', [])).toThrow(/empty/);
    try {
      toChartIR('Top products by revenue', []);
    } catch (error) {
      expect(isNl2ChartsError(error) && error.code).toBe('NL2C_E_NOT_SUPPORTED');
    }
  });

  it('refuses a result set no mark can encode, and names the columns it saw', () => {
    const names = rows({ product: ['a', 'b'], region: ['north', 'south'] });
    expect(() => toChartIR('Which products are there?', names)).toThrow(/no chart fits/);
  });

  it('rejects a limit that is not a positive whole number of rows', () => {
    expect(() => toChartIR('Top products by revenue', products, { limit: 0 })).toThrow(/limit/);
  });
});

describe('the properties every recommendation has to hold, over generated result sets', () => {
  const random = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  };

  const column = (next: () => number, index: number): { name: string; values: unknown[] } => {
    const kind = Math.floor(next() * 4);
    const height = 2 + Math.floor(next() * 8);
    if (kind === 0) {
      return {
        name: `date${String(index)}`,
        values: Array.from({ length: height }, (_, row) => `2026-0${String(1 + (row % 9))}-01`),
      };
    }
    if (kind === 1) {
      const width = 2 + Math.floor(next() * 9);
      return {
        name: `label${String(index)}`,
        values: Array.from({ length: height }, (_, row) => `v${String(row % width)}`),
      };
    }
    if (kind === 2) {
      return {
        name: `amount${String(index)}`,
        values: Array.from({ length: height }, () => Math.round(next() * 1000) / 10 - (next() < 0.15 ? 500 : 0)),
      };
    }
    return {
      name: `count${String(index)}`,
      values: Array.from({ length: height }, () => 1 + Math.floor(next() * 5)),
    };
  };

  it('holds on 120 generated result sets', () => {
    const next = random(20261112);
    for (let trial = 0; trial < 120; trial += 1) {
      const width = 1 + Math.floor(next() * 6);
      const columns = Array.from({ length: width }, (_, index) => column(next, index));
      const data = rows(Object.fromEntries(columns.map((entry) => [entry.name, entry.values])));
      const question = 'Show me what is going on';
      const choice = recommendChart(question, profiles(data));
      for (const item of choice.recommendations) {
        expect(SERIES_TYPES).toContain(item.mark);
        expect(Number.isInteger(item.score)).toBe(true);
        expect(item.reasons.length).toBeGreaterThan(0);
      }
      if (choice.recommendations.length === 0) {
        // The recommender was handed profiles and no row count, so it could not offer the counted
        // measure; `toChartIR` is handed the rows and can. What must hold either way is that a chart
        // is not drawn from a table the recommender could not measure: it counts, or it refuses, and
        // a counted chart accounts for every row exactly once — that is what makes the fold a fold
        // rather than a filter.
        let counted: ChartIR | undefined;
        try {
          counted = toChartIR(question, data);
        } catch {
          counted = undefined;
        }
        if (counted !== undefined) {
          const measure = Array.isArray(counted.encoding.y) ? counted.encoding.y[0] : counted.encoding.y;
          expect(measure?.aggregate).toBe('count');
          expect(counted.data.reduce((total, row) => total + Number(row['count']), 0)).toBe(data.length);
          expect(lint(counted)).toEqual([]);
        }
        continue;
      }
      const ir = toChartIR(question, data);
      expect(lint(ir).filter((issue) => issue.severity === 'error')).toEqual([]);
      expect(() => compileToECharts(ir)).not.toThrow();
      expect(JSON.stringify(recommendChart(question, profiles(data)))).toBe(JSON.stringify(choice));
    }
  });
});

describe('the cue table a caller hands in', () => {
  const question = 'average revenue by region and channel';
  const shipped = recommendChart(question, profileRows(matrix));

  it('answers against the table it is given, and the default is the table that ships', () => {
    // The seam exists so a candidate table can be priced on the product before it ships: without it
    // the only table the product could be measured on was the one already compiled in.
    expect(shipped.recommendations[0]?.mark).toBe('heatmap');
    expect(readCues(question).map((cue) => cue.kind)).toContain('matrix');
    const without = CHART_CUES.filter((rule) => rule.kind !== 'matrix');
    const choice = recommendChart(question, profileRows(matrix), { cues: without });
    expect(choice.recommendations[0]?.mark).toBe('bar');
    expect(choice.recommendations[0]?.cues).not.toContain('matrix');
    // The default is not a copy of the table: a call with no option and a call with the exported
    // table are the same reading, which is the only way a sweep's control is the product.
    expect(recommendChart(question, profileRows(matrix), { cues: CHART_CUES })).toEqual(shipped);
  });

  it('does not depend on where a cue sits in the table, which is what `firstClaims` counts', () => {
    // The product ranks by how many cues name a mark *first*, not by which cue fired first, so moving
    // a cue changes nothing here. That is why a reorder scores +39 on the cue reading and 0 on the
    // product: the two instruments are two different functions, and reading one as a forecast of the
    // other is how a table change gets shipped for a gain no caller can see.
    const reverseOrder = [...CHART_CUES].reverse();
    const forward = recommendChart(question, profileRows(matrix));
    const reversed = recommendChart(question, profileRows(matrix), { cues: reverseOrder });
    expect(reversed.recommendations.map((entry) => entry.mark)).toEqual(forward.recommendations.map((entry) => entry.mark));
    expect(reversed.recommendations.map((entry) => entry.score)).toEqual(forward.recommendations.map((entry) => entry.score));
    // What the order *inside* a cue does move: three points for the first mark it names, two for the
    // rest, and `firstClaims` counts the leading mark. Both are the same lever the product can feel.
    const flipped = CHART_CUES.map((rule) => (rule.kind === 'matrix' ? { ...rule, marks: ['bar', 'heatmap'] as const } : rule));
    const choice = recommendChart(question, profileRows(matrix), { cues: flipped });
    expect(forward.recommendations[0]?.mark).toBe('heatmap');
    expect(choice.recommendations[0]?.mark).toBe('bar');
    // Same question, same rows, same cue: the only change is which mark it names first.
    expect(choice.recommendations[0]?.cues).toContain('matrix');
  });

  it('takes the table alongside the other options rather than instead of them', () => {
    // `maxSlices` decides what a pie may carry and the table decides what the question asks for; a
    // caller that passes both gets both, so a variant cannot silently lose the option beside it.
    const narrow = recommendChart(question, profileRows(matrix), { maxSlices: 1, cues: CHART_CUES });
    expect(narrow.refused.map((entry) => entry.mark)).toContain('pie');
    expect(narrow.refused.some((entry) => entry.reason.includes('at most 1 slices'))).toBe(true);
  });
});

/**
 * A table of names and nothing else is not unmeasurable.
 *
 * The result of a grouped query often carries one categorical column and no number at all — the
 * question asked for a count and the copy in front of the reader *is* the count.
 * `eval/text2vis` labels 106 such rows `bar` and this product refused every one of them with "a bar
 * needs a category axis and a measure", which was 28% of the corpus's refusals and the single largest
 * bucket on that side of the product.
 *
 * The measure is the row count, and these tests hold the three things that make it a measurement
 * rather than a licence to draw: it exists only when the caller says how many rows there were, only
 * when a category actually repeats, and it is materialised into the IR rather than declared and left
 * for a renderer to guess.
 */
describe('counting a result set that carries no measure', () => {
  const dramas = rows({
    genre: ['History', 'History', 'Tragedy', 'Tragedy', 'Tragedy', 'Comedy'],
    play: ['Henry V', 'Richard III', 'Hamlet', 'Macbeth', 'Othello', 'Twelfth Night'],
  });
  const question = 'Among the genres, which one has the most plays?';

  it('refuses the table until the caller says how many rows it holds', () => {
    const profiles = profileRows(dramas);
    // Two categorical columns and no number: no mark can carry it, and the refusal names the measure.
    const blind = recommendChart(question, profiles);
    expect(blind.recommendations).toEqual([]);
    expect(blind.refused.some((entry) => entry.reason.includes('measure'))).toBe(true);
    expect(blind.shape).toEqual({ dims: 2, ordered: 0, measures: 0, counted: false });
    // The same profiles, with the one fact a profile cannot carry. Nothing else changed.
    const told = recommendChart(question, profiles, { rows: dramas.length });
    expect(told.recommendations[0]?.mark).toBe('bar');
    expect(told.shape).toEqual({ dims: 2, ordered: 0, measures: 1, counted: true });
  });

  it('refuses a column of unique values, because a count of one each is a row of equal bars', () => {
    // Every play is named once, so counting the plays would draw six bars of height one and say
    // nothing about the data. `distinct < rows` is the whole reason the measure is not synthesised
    // from the profiles alone.
    const unique = rows({ play: ['Hamlet', 'Macbeth', 'Othello'], genre: ['Tragedy', 'Tragedy', 'Tragedy'] });
    const choice = recommendChart('Which play is it?', profileRows(unique), { rows: unique.length });
    // `play` is distinct in every row and `genre` holds one value, so no dim repeats: the only count
    // available is one bar of height three beside three bars of height one, and the product refuses.
    expect(choice.shape.counted).toBe(false);
    expect(choice.recommendations).toEqual([]);
    // The boundary is a *repeating* category, not a table with more than one row: the same table with
    // one genre repeated by two of its three plays is a distribution and is charted.
    const spread = rows({ play: ['Hamlet', 'Macbeth', 'Othello'], genre: ['Tragedy', 'Tragedy', 'Comedy'] });
    expect(recommendChart('Which genre is it?', profileRows(spread), { rows: spread.length }).shape.counted).toBe(true);
  });

  it('materialises the count into the rows and names the column in the encoding', () => {
    const ir = toChartIR(question, dramas);
    expect(ir.mark).toBe('bar');
    const y = Array.isArray(ir.encoding.y) ? ir.encoding.y[0] : ir.encoding.y;
    // `aggregate: 'count'` is what tells a reader of the IR that this column was folded, and what
    // keeps the linter's `measure-without-aggregate` from firing on a chart whose aggregation was
    // performed rather than forgotten.
    expect(y).toEqual({ field: 'count', type: 'quantitative', aggregate: 'count' });
    // One row per genre, ranked, and the counts add up to the rows that went in: a fold that lost or
    // invented a row would still draw a picture.
    expect(ir.data).toEqual([
      { genre: 'Tragedy', count: 3 },
      { genre: 'History', count: 2 },
      { genre: 'Comedy', count: 1 },
    ]);
    expect(ir.data.reduce((total, row) => total + Number(row['count']), 0)).toBe(dramas.length);
    // The picture survives the contract, the linter and the compiler — the three readers of an IR.
    expect(parseChartIR(ir).mark).toBe('bar');
    expect(isRenderable(lint(ir))).toBe(true);
    const series = compileToECharts(ir).series as { encode: { x: string; y: string[] } }[];
    expect(series[0]?.encode).toEqual({ x: 'genre', y: ['count'] });
  });

  it('keeps the query order when the group axis is ordered, and ranks otherwise', () => {
    // Two rows in 2019 and three in 2020: ranking by count would put 2020 first, and a trend along
    // years read backwards is a chart through a shuffle.
    const years = rows({
      year: ['2019', '2020', '2020', '2020'],
      city: ['Oslo', 'Oslo', 'Rome', 'Rome'],
      district: ['a', 'b', 'c', 'd'],
    });
    const trend = toChartIR('How did the number of districts trend over time?', years);
    expect(trend.mark).toBe('line');
    expect(trend.data.map((row) => row['year'])).toEqual(['2019', '2020']);
    expect(trend.data.map((row) => row['count'])).toEqual([1, 3]);
    // The same shape without an ordered axis is a ranking, and a ranking is sorted by count: the
    // question a count chart answers is "which one has the most", and a reader should not have to
    // find the answer by scanning.
    const cities = rows({ city: ['Oslo', 'Oslo', 'Rome', 'Rome', 'Rome'], district: ['a', 'b', 'c', 'd', 'e'] });
    const ranked = toChartIR('Which city has the most districts?', cities);
    expect(ranked.mark).toBe('bar');
    expect(ranked.data.map((row) => row['city'])).toEqual(['Rome', 'Oslo']);
    expect(ranked.data.map((row) => row['count'])).toEqual([3, 2]);
  });

  it('never overwrites a column that is already called count', () => {
    // A query that counted something returns a column called `count`, and folding onto that name
    // would replace the numbers the chart is about with the numbers of rows that carry them.
    const counted = rows({
      genre: ['History', 'Tragedy', 'Tragedy'],
      count: ['one', 'two', 'three'],
    });
    const ir = toChartIR('Which genre has the most of them?', counted);
    const y = Array.isArray(ir.encoding.y) ? ir.encoding.y[0] : ir.encoding.y;
    expect(y?.field).toBe('count_2');
    // The result set's own column is still there, unchanged, in the folded rows.
    expect(ir.data).toEqual([
      { genre: 'Tragedy', count_2: 2 },
      { genre: 'History', count_2: 1 },
    ]);
    // And the search keeps going: a table that already holds `count` and `count_2` gets `count_3`,
    // because the name is chosen to be absent rather than to be conventionally first.
    const twice = rows({
      genre: ['History', 'Tragedy', 'Tragedy'],
      count: ['one', 'two', 'three'],
      count_2: ['i', 'ii', 'iii'],
    });
    const third = toChartIR('Which genre has the most of them?', twice);
    const measure = Array.isArray(third.encoding.y) ? third.encoding.y[0] : third.encoding.y;
    expect(measure?.field).toBe('count_3');
  });

  it('groups by both axes when the mark reads two categories', () => {
    // A heatmap counts cells, not rows: grouping by x alone would draw one bar per region and lose
    // the quarter it belongs to.
    const cells = rows({
      region: ['north', 'north', 'south', 'south', 'south'],
      product: ['a', 'b', 'a', 'a', 'b'],
    });
    const ir = toChartIR('Counts by region and product', cells);
    expect(ir.mark).toBe('heatmap');
    expect(ir.encoding.color?.aggregate).toBe('count');
    // One row per (region, product) cell, with the cells that hold two rows first.
    expect(ir.data).toEqual([
      { region: 'south', product: 'a', count: 2 },
      { region: 'north', product: 'a', count: 1 },
      { region: 'north', product: 'b', count: 1 },
      { region: 'south', product: 'b', count: 1 },
    ]);
  });

  it('applies the limit to the picture and not to the evidence', () => {
    // Folding after the limit would count the first N rows and call the total a count.
    const wide = rows({ kind: ['a', 'a', 'b', 'b', 'c', 'c', 'c'] });
    const ir = toChartIR('Which kind is the most common?', wide, { limit: 2 });
    expect(ir.data).toEqual([
      { kind: 'c', count: 3 },
      { kind: 'a', count: 2 },
    ]);
  });

  it('reads a matrix’s limit as columns, because half a column reads as missing data', () => {
    // The defect this exists for: `limit` sliced rows, so a heatmap came out with its last column
    // half drawn — and a cell that is absent because the limit cut it is indistinguishable from a
    // cell that is absent because the query had no value for it, which is the one reading a heatmap
    // exists to give. Three regions by three quarters, so a limit of four is one whole column and a
    // limit of six is two.
    const grid = rows({
      region: ['north', 'north', 'north', 'south', 'south', 'south', 'east', 'east', 'east'],
      quarter: ['Q1', 'Q2', 'Q3', 'Q1', 'Q2', 'Q3', 'Q1', 'Q2', 'Q3'],
      revenue: [10, 12, 9, 11, 13, 8, 7, 6, 5],
    });
    const one = toChartIR('Revenue by region and quarter', grid, { limit: 4 });
    expect(one.mark).toBe('heatmap');
    expect(one.data).toHaveLength(3);
    expect(new Set(one.data.map((cell) => cell['region']))).toEqual(new Set(['north']));
    const two = toChartIR('Revenue by region and quarter', grid, { limit: 6 });
    expect(two.data).toHaveLength(6);
    expect(new Set(two.data.map((cell) => cell['region']))).toEqual(new Set(['north', 'south']));
    // A sequence keeps the row limit it always had: the same caller, the same number, one bar.
    const bars = toChartIR('Revenue by region', grid, { limit: 2 });
    expect(bars.mark).not.toBe('heatmap');
    expect(bars.data).toHaveLength(2);
  });

  it('refuses a matrix limit smaller than one of its own columns, rather than cutting it', () => {
    // There is no picture at that size: a limit below one column keeps no column, and a chart of no
    // cells is a picture of nothing rather than a smaller picture. The message names both numbers so
    // the remedy is the caller's.
    const grid = rows({
      region: ['north', 'north', 'north', 'south', 'south', 'south'],
      quarter: ['Q1', 'Q2', 'Q3', 'Q1', 'Q2', 'Q3'],
      revenue: [10, 12, 9, 11, 13, 8],
    });
    expect(() => toChartIR('Revenue by region and quarter', grid, { limit: 2 })).toThrow(
      /limit=2 is smaller than one column of this matrix: "north" holds 3 cells/,
    );
  });

  it('keeps whole columns in the order they appear and the rows in the order they came', () => {
    const cells = [
      { x: 'a', y: 'p', v: 1 },
      { x: 'b', y: 'p', v: 2 },
      { x: 'a', y: 'q', v: 3 },
      { x: 'b', y: 'q', v: 4 },
      { x: 'c', y: 'p', v: 5 },
    ];
    // Columns `a` (2 cells) and `b` (2) fit in four; `c` would be the fifth and is dropped whole.
    expect(wholeColumns(cells, (cell) => cell.x, 4).map((cell) => `${cell.x}${cell.y}`)).toEqual([
      'ap',
      'bp',
      'aq',
      'bq',
    ]);
    // A column that appears after others and is the only one too big stops the walk, exactly as the
    // first one too big would: the limit is a budget spent in order, not a best fit.
    expect(wholeColumns(cells, (cell) => cell.x, 3).map((cell) => cell.x)).toEqual(['a', 'a']);
    // No rows is no matrix, and it is a different fact from a limit below one column.
    expect(wholeColumns([], () => 'x', 1)).toEqual([]);
  });

  it('leaves a table that has a measure of its own exactly as it was', () => {
    const measured = rows({ region: ['north', 'south', 'west'], revenue: [120, 90, 60] });
    const ir = toChartIR('Which region earned the most?', measured);
    expect(ir.data).toEqual(measured);
    const y = Array.isArray(ir.encoding.y) ? ir.encoding.y[0] : ir.encoding.y;
    expect(y?.aggregate).toBeUndefined();
    expect(recommendChart('Which region earned the most?', profileRows(measured), { rows: 3 }).shape.counted).toBe(false);
  });
});

/**
 * A table that is wide in time, through the whole pipeline.
 *
 * The melt is the one place in this package that *invents* rows, so the assertions are about the
 * three things that can go wrong: the table is not read at all (the refusal this replaced), the IR it
 * produces is not one the contract accepts, or the two renderers disagree about the series it names.
 */
describe('a table that is wide in time, through the chart pipeline', () => {
  const wide = [
    { country: 'Oman', '2019': 1, '2020': 2, '2021': 3 },
    { country: 'Samoa', '2019': 4, '2020': 5, '2021': 6 },
  ];

  it('produces the series the emitters read instead of declining the table', () => {
    const ir = toChartIR('How has the population changed?', wide);
    expect(ir.mark).toBe('line');
    expect(ir.encoding.x).toEqual({ field: 'Year', type: 'temporal' });
    expect(ir.encoding.y).toEqual([{ field: 'Value', type: 'quantitative' }]);
    expect(ir.encoding.series).toEqual({ field: 'country', type: 'nominal' });
    expect(ir.data).toHaveLength(6);
    // The IR this branch invents has to be one the contract accepts: the schema is the only reader
    // that would notice a field the emitters were taught and the contract was not.
    expect(() => parseChartIR(ir)).not.toThrow();
    expect(isRenderable(lint(ir))).toBe(true);
  });

  it('compiles to the same two series in both renderers', () => {
    const ir = toChartIR('How has the population changed?', wide);
    expect(compileToECharts(ir).series).toHaveLength(2);
    const code = compileToMatplotlib(ir);
    expect(code).toContain('label="Oman"');
    expect(code).toContain('label="Samoa"');
  });

  it('keeps the caller’s limit on the rows it carries', () => {
    expect(toChartIR('How has it changed?', wide, { limit: 3 }).data).toHaveLength(3);
  });

  it('carries the caller’s subtitle and theme through the wide path too', () => {
    // The wide path builds its own IR rather than going through the one `toChartIR` finishes, so the
    // two optional fields a caller passes are the ones it is easiest to drop: a subtitle that only
    // arrives on the narrow path is a subtitle half the charts have.
    const ir = toChartIR('How has the population changed?', wide, { subtitle: 'per country', theme: 'dark' });
    expect(ir.subtitle).toBe('per country');
    expect(ir.theme).toBe('dark');
    // And the absent case stays absent rather than becoming the string `undefined`, which the
    // contract would accept and a renderer would print.
    expect(toChartIR('How has the population changed?', wide)).not.toHaveProperty('subtitle');
  });

  it('leaves a table that is not wide alone, down to the absent channel', () => {
    const ir = toChartIR('Revenue by product', rows({ product: ['a', 'b', 'c'], revenue: [1, 2, 3] }));
    expect(ir.encoding.series).toBeUndefined();
    expect(ir.data).toHaveLength(3);
  });
});
