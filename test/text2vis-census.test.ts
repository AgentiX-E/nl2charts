/**
 * Why the recommender missed, counted rather than argued.
 *
 * The reading this file pins is the difference between a product that is wrong because a rule refused
 * the right answer and a product that is wrong because a ranking preferred something else. Every case
 * below is one of the two, built by hand so the classifier cannot be right about the corpus for the
 * wrong reason.
 *
 * The two cases that carry the argument are a table whose time column is a year (`2019`, which the
 * profiler types as a measure, so `line` is refused) and a table whose two category axes make a
 * heatmap outrank the bar the label names. The first is a type-inference defect if it is common, the
 * second a ranking defect, and a single "missed 684" cannot tell them apart.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readCues, recommendChart } from '@agentix-e/nl2charts-chart';
import type { ChartType } from '@agentix-e/nl2charts-spec';
import { TEXT2VIS_FIELDS } from '../eval/text2vis/dataset.js';
import {
  assertCensusReport,
  coercedColumns,
  type CensusRow,
  censusInputs,
  censusOf,
  classify,
  coveringMarks,
  describeCensus,
  describeProduct,
  entryCensus,
  firstAdmissibleWinner,
  noProfileReason,
  parseCensusArgs,
  snippet,
  timeLikeColumns,
  unreadNumerals,
} from '../eval/text2vis/census.js';
import { parseResultSet, profilesOf, scoreProfile, type ProfileInput } from '../eval/text2vis/profile.js';
import { familiesOfMark } from '../eval/text2vis/rule.js';

const root = mkdtempSync(join(tmpdir(), 'nl2charts-text2vis-census-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const ENTRY = resolve('eval/text2vis/census.ts');
const MODULE_URL = pathToFileURL(ENTRY).href;
const HEADER = `${TEXT2VIS_FIELDS.prompt},${TEXT2VIS_FIELDS.answer},${TEXT2VIS_FIELDS.code},${TEXT2VIS_FIELDS.chartType},Table Data`;

function cell(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/** A result set, written the way the corpus writes one: a header and rows of cells. */
function table(header: string, rows: readonly string[]): string {
  return [header, ...rows].join('\n');
}

/** `count` regions with a descending measure: enough slices to refuse a pie, few enough to admit one. */
function regions(count: number): string {
  const names = ['North', 'South', 'East', 'West', 'Central', 'Northeast', 'Southwest', 'Midwest', 'Coastal', 'Inland', 'Delta', 'Highland', 'Lowland', 'Border', 'Capital', 'Island', 'Valley', 'Forest', 'Desert', 'Plains'];
  const rows: string[] = [];
  for (let index = 0; index < count; index += 1) rows.push(`${names[index % names.length] as string} ${String(index + 1)}, ${String(100 - index * 3)}`);
  return table('Region, Revenue', rows);
}

/** A quarter of a year's revenue: the shape a `Line` label is usually drawn over. */
const QUARTERLY = table('Date, Revenue', [
  '2019-01-01, 10',
  '2019-04-01, 14',
  '2019-07-01, 18',
  '2019-10-01, 26',
  '2020-01-01, 31',
]);

/** A timeline written as years: one year per row, so the profiler reads it as the axis it is. */
const YEARS = table('Year, Revenue', ['2019, 10', '2020, 14', '2021, 18', '2022, 26', '2023, 31']);

/**
 * The same timeline with holes in it.
 *
 * This fixture used to carry the rule's residual: the profiler required a *contiguous* block of
 * years, so `2019, 2021, 2023` lost the axis, every line and bar over it was refused, and the
 * refusal sentence this file asserted was quoted in two documents. A survey fielded every two years
 * is a timeline and nothing else, so the rule now asks whether the column is a column of years
 * rather than whether its years are adjacent, and this fixture is the row that proves it.
 */
const GAPPED = table('Year, Revenue', ['2019, 10', '2021, 14', '2023, 18', '2025, 26', '2027, 31']);

/** A table with no axis at all: two measures and nothing to group them by, which no line can carry. */
const AXISLESS = table('Revenue, Cost', ['10, 4', '14, 5', '18, 6', '26, 8', '31, 9']);

/**
 * A time column that repeats, which the profiler refuses to order.
 *
 * The one shape the `timeLikeColumns` diagnostic still names, and the honest reason for it: a year
 * that appears on two rows is a *group* as much as a period — `Year, Revenue` with 2019 twice is
 * either a panel or a duplicate, and nothing in the values says which. So the profiler refuses the
 * axis, the diagnostic reports the column, and a reader decides. The corpus raises it zero times,
 * which is the number the census publishes.
 */
const REPEATED_YEARS = table('Year, Revenue', ['2019, 10', '2019, 14', '2021, 18', '2021, 26']);

/** A question that asks for the shape a line is drawn for. */
const TREND = 'How has revenue changed over time?';

function input(prompt: string, label: string, tableData: string): ProfileInput {
  return { prompt, label, tableData };
}

/**
 * A row that must have landed in one outcome.
 *
 * The union is narrowed here rather than asserted with `as`, so a test that expects a refusal and
 * gets a hit fails on the outcome it got instead of on a missing field two lines later.
 */
function expectOutcome<K extends CensusRow['outcome']>(
  row: ProfileInput,
  outcome: K,
): Extract<CensusRow, { outcome: K }> {
  const classified = classify(row);
  expect(classified.outcome).toBe(outcome);
  return classified as Extract<CensusRow, { outcome: K }>;
}

async function serve(body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/csv' });
    response.end(body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/Text2Vis.csv`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

describe('which marks could have answered a family', () => {
  it('derives the coverage from the product instead of restating it', () => {
    expect(coveringMarks('area')).toEqual(['line']);
    expect(coveringMarks('bar')).toEqual(['bar']);
    expect(coveringMarks('heatmap')).toEqual(['heatmap']);
  });

  it('has no mark for a family the contract cannot draw, so the gap is countable', () => {
    expect(coveringMarks('violin')).toEqual([]);
  });

  it('leaves the cue-conditional widening to the row, because a bar is a histogram only when told', () => {
    // `familiesOfMark('bar', 'histogram')` is `['histogram', 'bar']`: the widening exists, it is just
    // conditional on a cue naming the mark. Asking it of the table made every histogram row's covering
    // mark the bar that answered it — 43 rows reported as "lost histogram to bar" with bar on both
    // sides, a loss to itself. The table answers what a mark *is*; the row answers what this question
    // said.
    expect(coveringMarks('histogram')).toEqual([]);
    expect(familiesOfMark('bar', 'histogram')).toEqual(['histogram', 'bar']);
  });

  it('reads an uncovered family as uncovered when the answer never claimed it', () => {
    // A histogram label over a single measure, asked with no word that names the mark: the bar is the
    // only thing the product can draw and it does not claim to be a histogram.
    // `expectOutcome` narrows to a single-literal arm, and `uncovered` shares its arm with `hit` and
    // `noProfile` (all three carry nothing but the family), so the outcome is read directly here.
    const row = classify(input('Show the total revenue', 'Histogram', table('Revenue', ['12', '18', '31', '44'])));
    expect(row).toEqual({ expected: 'histogram', outcome: 'uncovered' });
  });

  it('lists every mark the recommender can return, so a new mark cannot go uncounted', () => {
    // A one-measure, no-dimension table admits exactly one mark and refuses the other ten. The union
    // is the recommender's whole domain, which is the list the census iterates: a mark the product
    // adds without adding it here would fall out of every count and read as a smaller corpus.
    const choice = recommendChart('Show the total', profilesOf(parseResultSet('Total\n42')));
    const seen = new Set<string>([
      ...choice.recommendations.map((entry) => entry.mark),
      ...choice.refused.map((entry) => entry.mark),
    ]);
    expect(choice.recommendations.map((entry) => entry.mark)).toEqual(['gauge']);
    expect(seen.size).toBe(11);
  });
});

describe('a column that formats as time', () => {
  it('reports nothing for a year column, contiguous or not, because the profiler reads both', () => {
    // What this bucket is for: a column a person reads as a date and the profiler typed as something
    // else. It used to hold gapped year columns, and holding them was the defect — every one of them
    // was a timeline the product refused. Both shapes are reported as nothing now, and the count is
    // published on every run so a rule that narrowed again would light this up on the next commit.
    for (const years of [GAPPED, YEARS]) {
      const set = parseResultSet(years);
      expect(timeLikeColumns(set, profilesOf(set))).toEqual([]);
    }
  });

  it('leaves an ISO date alone, because the profiler already reads it as temporal', () => {
    const set = parseResultSet(QUARTERLY);
    expect(timeLikeColumns(set, profilesOf(set))).toEqual([]);
  });

  it('stops reporting a column once the profiler reads it as time', () => {
    // The diagnostic measures the gap between "a person reads a date" and "the profiler did", so it
    // has to shrink when the profiler widens: quarters, month names, a year-and-month, a contiguous
    // column of years and now a column of years with holes in it are all typed temporal. What the
    // corpus still reports is six rows, and every one of them is a table too small to be a timeline —
    // two rows of years — or a *column named* `2020` whose cells are years, which no value rule can
    // read as a period column.
    for (const text of [
      'Q1 2019, 10\nQ2 2019, 12\nQ3 2019, 14',
      'Jan 2019, 10\nFeb 2019, 12\nMar 2019, 14',
      '2019-01, 10\n2019-02, 12\n2019-03, 14',
      '2019, 10\n2020, 12\n2021, 14',
    ]) {
      const set = parseResultSet(table('Period, Revenue', text.split('\n')));
      expect(timeLikeColumns(set, profilesOf(set))).toEqual([]);
    }
  });

  it('calls a column it has no profile for nominal, which is the profiler default and not a guess', () => {
    const set = parseResultSet(YEARS);
    expect(timeLikeColumns(set, [])).toEqual([{ column: 'Year', typed: 'nominal', sample: '2019', n: 1 }]);
  });

  it('is not fooled by a repeated value, a constant column, or a number that is not a year', () => {
    // A table whose whole period is one year has no axis to order, and a column of prices is not a
    // timeline: both would otherwise inflate the count the repair is argued from.
    const constant = parseResultSet(table('Year, Revenue', ['2019, 10', '2019, 12', '2019, 14']));
    expect(timeLikeColumns(constant, profilesOf(constant))).toEqual([]);
    const prices = parseResultSet(table('Price, Revenue', ['1199, 10', '1299, 12', '1399, 14']));
    expect(timeLikeColumns(prices, profilesOf(prices))).toEqual([]);
    const single = parseResultSet('Year\n2019');
    expect(timeLikeColumns(single, profilesOf(single))).toEqual([]);
  });
});

describe('a column that is a number only after its formatting is read', () => {
  it('names it, with the cell that needed the coercion', () => {
    const set = parseResultSet(table('Region, Revenue', ['North, "1,234"', 'South, "2,345"', 'East, "3,456"']));
    expect(coercedColumns(set)).toEqual([{ column: 'Revenue', sample: '1,234', n: 1 }]);
  });

  it('leaves a plain number alone, because the coercion bought nothing there', () => {
    const set = parseResultSet(table('Region, Revenue', ['North, 1234', 'South, 2345']));
    expect(coercedColumns(set)).toEqual([]);
  });

  it('does not mistake a category for a rescued measure', () => {
    const set = parseResultSet(table('Region, Revenue', ['North, a', 'South, b']));
    expect(coercedColumns(set)).toEqual([]);
  });

  it('counts the rows a formatted column refused, so the repair has a size', () => {
    const report = censusOf([
      input('Which region leads?', 'Bar Chart', table('Region, Revenue', ['North, "1,234"', 'South, "2,345"', 'East, "3,456"', 'West, "4,567"'])),
      input(TREND, 'Line Chart', QUARTERLY),
    ]);
    expect(report.coercedRows).toBe(1);
    expect(report.coerced).toEqual([{ column: 'Revenue', sample: '1,234', n: 1 }]);
    expect(describeCensus(report).join('\n')).toContain('columns that are numbers only after their formatting is read: 1 rows');
  });
});

describe('a cell that spells a missing value', () => {
  it('is missing, not a minus sign that turns its column into text', () => {
    // `-` is how a result set prints NULL, and reading it as a *string* made the whole column
    // nominal: a revenue column of fifteen numbers and one dash had no measure, and every mark that
    // needs one was refused. The census priced the defect at 192 of the 277 rows whose table offered
    // no measure at all — the largest single reason a question was answered with nothing.
    const set = parseResultSet(table('Year, Revenue', ['2019, 10', '2020, -', '2021, 14', '2022, 26', '2023, 31']));
    const revenue = profilesOf(set).find((profile) => profile.name === 'Revenue');
    expect(revenue?.type).toBe('quantitative');
    expect(revenue?.nulls).toBe(1);
  });

  it('accepts the spellings a result set actually prints, and only those', () => {
    // Every one of these is a NULL that reached the corpus as text. A dash, an em dash, the two
    // spellings of "not available", the SQL word for the absence, the word "none", and the lone dot
    // some exports write. `No data` is deliberately absent: it is two words, and a rule that read
    // phrases would start reading `None of the above` as a missing region.
    for (const spelling of ['-', '--', '—', '–', 'n/a', 'N/A', 'null', 'NULL', 'none', 'None', '.']) {
      const set = parseResultSet(table('Year, Revenue', ['2019, 10', `2020, ${spelling}`, '2021, 14', '2022, 26', '2023, 31']));
      expect(profilesOf(set).find((profile) => profile.name === 'Revenue')?.type, spelling).toBe('quantitative');
    }
  });

  it('does not read a missing cell as zero, which would be a value of the measure', () => {
    // A zero would move the minimum to a number no row carries, and the range-based rules read the
    // minimum. `nulls` is the count that says the cell was absent rather than empty of meaning.
    const set = parseResultSet(table('Year, Revenue', ['2019, 40', '2020, -', '2021, 50', '2022, 60', '2023, 70']));
    const revenue = profilesOf(set).find((profile) => profile.name === 'Revenue');
    expect(revenue?.min).toBe(40);
    expect(revenue?.nulls).toBe(1);
  });

  it('leaves a date, a name and a range alone', () => {
    // `2019-01-01` contains a dash and is not a missing value; so is a region called `North`, and so
    // is the string `5-10` a band rather than a NULL.
    expect(profilesOf(parseResultSet(table('Period, Revenue', ['2019-01-01, 10', '2019-02-01, 14', '2019-03-01, 18'])))?.find((p) => p.name === 'Period')?.type).toBe('temporal');
    expect(profilesOf(parseResultSet(table('Region, Revenue', ['North, 10', 'South, 14', 'East, 18'])))?.find((p) => p.name === 'Region')?.type).toBe('nominal');
    expect(profilesOf(parseResultSet(table('Band, Count', ['5-10, 3', '11-20, 5', '21-30, 7'])))?.find((p) => p.name === 'Band')?.type).toBe('nominal');
  });

  it('counts the rows it rescued, so the repair has a size in the report', () => {
    const report = censusOf([
      input('Which region leads?', 'Bar Chart', table('Region, Revenue', ['North, 40', 'South, -', 'East, 31', 'West, 63'])),
    ]);
    expect(report.missingRows).toBe(1);
    expect(report.outcomes.hit).toBe(1);
  });
});

describe('what became of one question', () => {
  it('reads a hit when the mark the label names is the one the profile admits', () => {
    expect(classify(input(TREND, 'Line Chart', QUARTERLY))).toEqual({ expected: 'line', outcome: 'hit' });
  });

  it('reads a substitution when the winner covers the family as its second claim', () => {
    // A line is a line and, filled, an area, so `familiesOfMark('line')` is `['line', 'area']` and a
    // line answers an `area` label second. `profile.ts` publishes that row in its shortlist and not
    // in its top-1, so the census has to split it out: reading the whole family list as a hit made
    // the census read 263 where the product reads 262 on the 1,470-row corpus.
    const row = expectOutcome(input(TREND, 'Area Chart', QUARTERLY), 'substituted');
    expect(row).toEqual({ expected: 'area', outcome: 'substituted', answered: 'line', ownFamily: 'line' });
  });

  it('reconciles with the profile file as shortlist = hit + substituted, which is why the split exists', () => {
    const rows = [input(TREND, 'Area Chart', QUARTERLY), input(TREND, 'Line Chart', QUARTERLY)];
    const report = censusOf(rows);
    const profile = scoreProfile(rows);
    expect(profile.shortlist).toBe(2);
    expect(profile.top1).toBe(1);
    expect(report.outcomes.hit).toBe(profile.top1);
    expect(report.outcomes.hit + report.outcomes.substituted).toBe(profile.shortlist);
  });

  it('classifies a table the product melts without asking any admission rule', () => {
    // The product answers a wide table before `recommendChart` is consulted — `profileAnswer` says so
    // and `toChartIR` does it — so three labels over the same table have three different outcomes and
    // not one ranking. The census used to rank this table, which is the defect this round repaired: it
    // filed the row as `outranked` and explained a decision no rule and no ranking had made.
    const WIDE = table('Country, 2019, 2020, 2021', ['France, 10, 12, 14', 'Spain, 9, 11, 13']);
    expect(classify(input(TREND, 'Line Chart', WIDE))).toEqual({ expected: 'line', outcome: 'hit' });
    // An area chart is that line filled, so the melt's line covers it as its second claim — the same
    // split `profile.ts` makes between its top-1 and its shortlist.
    expect(classify(input(TREND, 'Area Chart', WIDE))).toEqual({
      expected: 'area',
      outcome: 'substituted',
      answered: 'line',
      ownFamily: 'line',
    });
    // And a label the melt never considered is neither a refusal nor a loss: no rule refused this
    // table and nothing outranked anything. It gets the name of what happened, and the axis names
    // travel with it so a wrong reshape can be read without a rerun.
    expect(classify(input('Compare revenue by country', 'Bar Chart', WIDE))).toEqual({
      expected: 'bar',
      outcome: 'reshaped',
      answered: 'line',
      entity: 'Country',
      period: 'Year',
    });
  });

  it('bins a table wide in time that was asked for a histogram, because the bins are taken first', () => {
    // The product's order, pinned where the sweep had it backwards. Three corpus rows are both a
    // histogram question and a table wide in time: `toChartIR` pools and bins them, and the sweep
    // asked the melt first and priced them as lines, so the control claimed 661 hits against the
    // census's 664. The identity that compares the two is what found it; this is the row it stands on.
    const WIDE = table('Country, 2019, 2020, 2021', ['France, 10, 12, 14', 'Spain, 9, 11, 13']);
    const ask = 'Plot a histogram of all the values and say whether the distribution is skewed';
    // A hit, and only the bins path can produce it: a melt-first reading of this row is a line, and a
    // line is neither the label nor the picture the question asked for.
    expect(classify(input(ask, 'Histogram', WIDE))).toEqual({ expected: 'histogram', outcome: 'hit' });
    const report = censusOf([input(ask, 'Histogram', WIDE)]);
    expect(report.outcomes.hit).toBe(1);
    // One number, two code paths: the control must reproduce the classifier's count on this row too,
    // and it did not while the sweep asked the melt first.
    expect(report.product[0]?.hit).toBe(report.outcomes.hit);
  });

  it('keeps the profile reconciliation exact on a population that contains a reshape', () => {
    // The three outcomes above are the reason the identity is asserted on a mixed population and not
    // on a ranking-only one: a reshape is invisible to `scoreProfile`'s buckets except through the
    // answer it produces, so a classifier that invented a fourth bucket without agreeing on the mark
    // would still pass a hand-built test and fail this subtraction.
    const WIDE = table('Country, 2019, 2020, 2021', ['France, 10, 12, 14', 'Spain, 9, 11, 13']);
    const rows = [
      input(TREND, 'Line Chart', QUARTERLY),
      input(TREND, 'Area Chart', QUARTERLY),
      input(TREND, 'Line Chart', WIDE),
      input(TREND, 'Area Chart', WIDE),
      input('Compare revenue by country', 'Bar Chart', WIDE),
      input(TREND, 'Line Chart', AXISLESS),
    ];
    const report = censusOf(rows);
    const profile = scoreProfile(rows);
    expect(report.outcomes).toEqual({ hit: 2, substituted: 2, reshaped: 1, binned: 0, refused: 1, outranked: 0, uncovered: 0, noProfile: 0 });
    expect(report.outcomes.hit).toBe(profile.top1);
    expect(report.outcomes.hit + report.outcomes.substituted).toBe(profile.shortlist);
    expect(() => assertCensusReport(report)).not.toThrow();
  });

  it('names the admission rule that refused a line over a table with no axis', () => {
    // The reading this instrument exists for. Two measures and no column to group them by: the
    // sentence below is the product's own refusal — not a paraphrase of it, so a document can quote
    // the rule it quotes here. It used to be quoted about a *gapped* year column, which was the
    // defect rather than the reason: the rule refused an axis that was there.
    const row = expectOutcome(input(TREND, 'Line Chart', AXISLESS), 'refused');
    expect(row.outcome).toBe('refused');
    expect(row.covering).toBe('line');
    expect(row.reason).toBe('a line needs an axis and a measure');
  });

  it('reads a year column with holes in it as the axis it is, which is the repair of that sentence', () => {
    // One value away from the fixture above and the outcome is the opposite: a survey fielded every
    // two years is a timeline, `shape.ordered` is not empty, `line` is admitted and wins. The census
    // used to price this row as a refusal and publish the sentence as a fact about the product.
    expect(classify(input(TREND, 'Line Chart', GAPPED))).toEqual({ expected: 'line', outcome: 'hit' });
    expect(timeLikeColumns(parseResultSet(GAPPED), profilesOf(parseResultSet(GAPPED)))).toEqual([]);
  });

  it('reads a contiguous year column as the axis it is, which was the first repair', () => {
    // The other half of the same question, and the reason the rule was reversed: the same table with
    // `2020` in it is a run, the profiler reads a period, `line` is admitted and wins, and the row is
    // a hit. Nothing else changed — one value — so a reader can see that the rule is what decided it.
    expect(classify(input(TREND, 'Line Chart', YEARS))).toEqual({ expected: 'line', outcome: 'hit' });
  });

  it('names the slice limit that refused a pie over twenty categories', () => {
    const row = expectOutcome(input('What percentage of revenue does each region contribute?', 'Pie Chart', regions(20)), 'refused');
    expect(row.outcome).toBe('refused');
    expect(row.covering).toBe('pie');
    // The sentence carries the cap the product ships, so this expectation is also the assertion that
    // the default is twelve: a cap changed without a reading would fail here before it reached a log.
    expect(row.reason).toBe('a pie needs one category of at most 12 slices, none of them negative');
  });

  it('separates a family no mark covers from a mark a rule refused', () => {
    expect(classify(input(TREND, 'Violin Plot', QUARTERLY))).toEqual({ expected: 'violin', outcome: 'uncovered' });
  });

  it('separates a table that would not profile from a recommendation that refused', () => {
    expect(classify(input(TREND, 'Line Chart', ''))).toEqual({ expected: 'line', outcome: 'noProfile' });
  });

  it('reads a loss on preference when both marks scored the same, and says no fact decided it', () => {
    // Two category axes, two measures, and a question with no cue in it: bar, pie, funnel, scatter
    // and heatmap all score their prior of two, and `PREFERENCE` puts bar first. The row is a miss
    // that no admission rule and no cue caused — only the tie-break did.
    const wide = table('Region, Channel, Units, Revenue', [
      'North, Online, 12, 40',
      'South, Retail, 18, 55',
      'East, Online, 9, 31',
      'West, Retail, 21, 63',
    ]);
    const row = expectOutcome(input('Show the numbers.', 'Heat Map', wide), 'outranked');
    expect(row.outcome).toBe('outranked');
    expect(row.covering).toBe('heatmap');
    expect(row.answered).toBe('bar');
    expect(row.coveringScore).toBe(2);
    expect(row.answeredScore).toBe(2);
  });

  it('reads a loss to a cue that named the winner first', () => {
    // `by … and` fires the matrix cue, which speaks for heatmap first and bar second: 3 + prior
    // against 2 + prior, so the bar the label names loses by exactly one point. That is the
    // registered hypothesis — a second-position cue cancelled by the arithmetic — and it is a
    // different repair from the tie above.
    const two = table('Region, Channel, Revenue', [
      'North, Online, 40',
      'South, Retail, 55',
      'East, Online, 31',
      'West, Retail, 63',
    ]);
    const row = expectOutcome(input('Revenue by region and channel', 'Bar Chart', two), 'outranked');
    expect(row.outcome).toBe('outranked');
    expect(row.covering).toBe('bar');
    expect(row.answered).toBe('heatmap');
    expect(row.coveringScore).toBe(4);
    expect(row.answeredScore).toBe(5);
    expect(row.coveringCue).toBe(1);
    expect(row.answeredCue).toBe(0);
  });

  it('reads a refusal with nothing drawn beside it, which is the row the profile file calls a decline', () => {
    // A result set with no measure admits nothing: every mark either needs one or needs a shape this
    // table cannot give. `answered` is absent rather than `declined`, because the difference between
    // "the product picked something else" and "the product had nothing to say" is the repair.
    const names = table('Region', ['North', 'South', 'East', 'West']);
    const row = expectOutcome(input('Which region leads?', 'Bar Chart', names), 'refused');
    expect(row.covering).toBe('bar');
    expect(row.reason).toBe('a bar needs a category axis and a measure');
    expect(row).not.toHaveProperty('answered');
  });

  it('refuses a label with no family rather than counting it as a loss', () => {
    expect(() => classify(input(TREND, 'Word Cloud', QUARTERLY))).toThrow(/no family/);
  });
});

describe('a question, cut to the words that decide', () => {
  it('finds the question in a prompt wrapped in instructions', () => {
    // The corpus wraps every row as: instruction block, question, output-format spec. Only the middle
    // part distinguishes one row from another, and the first two versions of this cut printed the
    // other two — first the instructions at the front, then the schema at the back.
    const prompt = [
      'You are a data science assistant.',
      'Generate matplotlib code to answer the question below.',
      'The table has already been loaded into a pandas dataframe named df.',
      'Include axis labels, a legend and a title in the figure.',
      'Which region has the highest revenue?',
      'Write Python code using **matplotlib only** to visualize the result.',
      'Return your response strictly in the following JSON format **without any extra explanation**:',
      '{"answer": "<short answer>", "code": "<matplotlib code for visualization>"}',
    ].join('\n');
    expect(snippet(prompt)).toBe('Which region has the highest revenue?');
  });

  it('collapses the whitespace a wrapped question carries', () => {
    expect(snippet('What is\nthe trend   of revenue?')).toBe('What is the trend of revenue?');
  });

  it('keeps the last question when a prompt asks more than one', () => {
    // Some prompts restate the task before asking ("What is the trend? Which region leads?"), and the
    // question the row is labelled for is the one nearest the answer request, not the first.
    expect(snippet('What is the trend? Which region leads? Then draw it.')).toBe('Which region leads?');
  });

  it('cuts the code instruction when there is no question at all', () => {
    // A command rather than a question: `plot these percentages in order of increasing Value on a
    // line chart` is a Text2Vis row verbatim, and it has no `?` to find. The instruction that follows
    // it is still boilerplate, so it is cut and the tail is kept.
    const prompt =
      'Plot these percentages in order of increasing Value on a line chart. Write Python code using **matplotlib only** to visualize the result.';
    expect(snippet(prompt)).toBe('Plot these percentages in order of increasing Value on a line chart.');
  });

  it('leaves a short prompt alone, so a sample reads as the corpus wrote it', () => {
    expect(snippet('  Revenue by region  ')).toBe('Revenue by region');
  });

  it('keeps the tail of a long prompt that has neither a question nor a code instruction', () => {
    // The last path in the cut, and it has to exist: a command with no `?` and no instruction block
    // is still a prompt the census prints, and dropping it to an empty string would lose the row.
    const long = `${'Plot the series for each region in increasing order of value. '.repeat(6)}`;
    const cut = snippet(long);
    expect(cut.startsWith('…')).toBe(true);
    expect(cut).toHaveLength(161);
    expect(cut.endsWith('in increasing order of value.')).toBe(true);
  });

  it('cuts a long question from the left, because the end of a question is what it asks', () => {
    const long = `${'Which of these regions '.repeat(12)}had the highest revenue?`;
    const cut = snippet(long);
    expect(cut.length).toBeLessThanOrEqual(161);
    expect(cut.endsWith('had the highest revenue?')).toBe(true);
  });

  it('models a cue paying only the mark it can admit, which is the next lever', () => {
    // `share` fires on "percentage" and pays the pie three points and the bar two, whether or not a
    // pie was drawable. The model reads the list as what it says — "a pie, or a bar if a pie cannot
    // be drawn" — so a question with one cue pays one mark.
    const prompt = 'What percentage of revenue does each region hold?';
    const choice = recommendChart(prompt, profilesOf(parseResultSet(regions(5))));
    const under = firstAdmissibleWinner(choice, readCues(prompt));
    expect(under?.mark).toBe('pie');
    expect(under?.score).toBe(5);
    // The shipped ranking already answers this row with a pie, so the model cannot take it away.
    expect(choice.recommendations[0]?.mark).toBe('pie');
  });

  it('models the cost too, on the rows where the fallback is what the label wants', () => {
    // A bar label over a share question: the cue names the pie first and the bar second, and the
    // model stops paying the bar for being the fallback. A model that reported only wins would be an
    // advertisement rather than a price.
    const prompt = 'What percentage of revenue does each region hold?';
    const choice = recommendChart(prompt, profilesOf(parseResultSet(regions(5))));
    expect(choice.recommendations.map((entry) => entry.mark)).toContain('bar');
    expect(firstAdmissibleWinner(choice, readCues(prompt))?.mark).not.toBe('bar');
  });

  it('leaves the order alone when no cue fires, because a model may not invent a fact', () => {
    const profiles = profilesOf(parseResultSet(regions(5)));
    const choice = recommendChart('Show the numbers.', profiles);
    expect(firstAdmissibleWinner(choice, readCues('Show the numbers.'))).toEqual(choice.recommendations[0]);
  });
});

describe('a number the reader declined', () => {
  it('names a decimal that nothing read, which is the shape a mis-formatted quantity takes', () => {
    // The typographic minus and the European separator: two formats, two repairs, and a table with
    // no measure in either refuses every mark that needs one.
    expect(unreadNumerals(parseResultSet(table('Year, Anomaly', ['2019, −0.04', '2020, 0.12', '2021, 0.31'])))).toEqual([
      { column: 'Anomaly', cell: '−0.04', n: 1 },
    ]);
    // Quoted, because an unquoted `1.234,56` is three CSV fields: a European decimal is only a cell
    // when the table says where the cell ends.
    const european = table('Region, Revenue', [`North, ${cell('1.234,56')}`, `South, ${cell('2.345,67')}`]);
    expect(unreadNumerals(parseResultSet(european))).toEqual([{ column: 'Revenue', cell: '1.234,56', n: 1 }]);
  });

  it('does not call a categorical code a number the reader declined', () => {
    // The corpus answered the first version of this — which asked only for a digit and no letter —
    // with `71+`, `18-25` and `2018*`: age bands and footnote-marked years, typed as categories and
    // correctly so. Reporting them sends the next round to the parser with a list of age brackets.
    expect(unreadNumerals(parseResultSet(table('Entity, Age', ['Nigeria, 18-25', 'Ghana, 71+'])))).toEqual([]);
    expect(unreadNumerals(parseResultSet(table('Characteristic, Value', ['2018*, 12', '2019*, 15'])))).toEqual([]);
  });

  it('leaves a label alone and leaves a number it already read alone', () => {
    expect(unreadNumerals(parseResultSet(table('Region, Revenue', ['North, 1234', 'South, 2345'])))).toEqual([]);
    expect(unreadNumerals(parseResultSet(table('Region, Share', ['North, 12%', 'South, 30%'])))).toEqual([]);
    expect(unreadNumerals(parseResultSet(table('Region, Note', ['North, 2 of 5', 'South, 1 of 4'])))).toEqual([]);
  });

  it('counts the tables that profiled into no measure, and how many of them were refused', () => {
    // `Number('−1')` is `NaN`, so the anomaly column types `nominal`, the table has no measure, and
    // the bar the label asks for cannot be drawn from it.
    // The only numeric column is the one nothing could read, so the table has no measure at all. A
    // year column would have given it one — as a measure, which is its own defect.
    const typographic = table('Region, Anomaly', ['North, −0.04', 'South, 0.12', 'East, 0.31', 'West, 0.48']);
    const report = censusOf([input('Which region was warmest?', 'Bar Chart', typographic)]);
    expect(report.measureless).toEqual({ tables: 1, refused: 1 });
    expect(report.numerals).toEqual([{ column: 'Anomaly', cell: '−0.04', n: 1 }]);
    const lines = describeCensus(report).join('\n');
    expect(lines).toContain('tables with no measure at all: 1 rows (1 refused every mark that needs one)');
    expect(lines).toContain('Anomaly = "−0.04" (1 rows)');
  });

  it('does not count a table it could read', () => {
    const report = censusOf([input(TREND, 'Line Chart', QUARTERLY)]);
    expect(report.measureless).toEqual({ tables: 0, refused: 0 });
    expect(report.numerals).toEqual([]);
  });
});

describe('a table that would not profile, by the reason it would not', () => {
  const set = (text: string) => parseResultSet(text);

  it('calls an empty cell empty, which is a corpus gap and not a parser defect', () => {
    expect(noProfileReason('', set(''))).toBe('empty');
    expect(noProfileReason('  \n \n', set('  \n \n'))).toBe('empty');
  });

  it('calls a line with no delimiter prose, because it is not a header either', () => {
    expect(noProfileReason('There is no table here.', set('There is no table here.'))).toBe('not-tabular');
  });

  it('calls a header with no record below it header-only, blanks included', () => {
    expect(noProfileReason('Region, Revenue', set('Region, Revenue'))).toBe('header-only');
    expect(noProfileReason('Region, Revenue\n,\n, ', set('Region, Revenue\n,\n, '))).toBe('header-only');
  });

  it('refuses to name a defect for a table that profiles', () => {
    // The precondition is the contract: this classifier is called from the `noProfile` bucket and
    // nowhere else, so a table with a record is a caller defect rather than a fourth reason.
    expect(() => noProfileReason('Region, Revenue\nNorth, 4', set('Region, Revenue\nNorth, 4'))).toThrow(/profiles/);
  });
});

describe('the census over a population', () => {
  const population: readonly ProfileInput[] = [
    input(TREND, 'Line Chart', QUARTERLY),
    input(TREND, 'Line Chart', AXISLESS),
    input('What percentage of revenue does each region contribute?', 'Pie Chart', regions(20)),
    input('What percentage of revenue does each region contribute?', 'Pie Chart', regions(5)),
    input(TREND, 'Violin Plot', QUARTERLY),
    input(TREND, 'Line Chart', ''),
    input('Show the numbers.', 'Heat Map', table('Region, Channel, Units, Revenue', ['North, Online, 12, 40', 'South, Retail, 18, 55', 'East, Online, 9, 31', 'West, Retail, 21, 63'])),
    input('Revenue by region and channel', 'Bar Chart', table('Region, Channel, Revenue', ['North, Online, 40', 'South, Retail, 55', 'East, Online, 31', 'West, Retail, 63'])),
    input(TREND, 'Word Cloud', QUARTERLY),
  ];

  it('puts every scored row in exactly one outcome', () => {
    const report = censusOf(population);
    expect(report.rows).toBe(9);
    expect(report.unmapped).toBe(1);
    expect(report.scored).toBe(8);
    expect(report.outcomes).toEqual({ hit: 2, substituted: 0, reshaped: 0, binned: 0, refused: 2, outranked: 2, uncovered: 1, noProfile: 1 });
    expect(() => assertCensusReport(report)).not.toThrow();
  });

  it('agrees with the profile reading about the same rows, or it is explaining another corpus', () => {
    // Two instruments, one population: a profile hit is a census hit, and a profile miss is a census
    // loss or an uncovered family. Only the declined bucket splits, because "no mark was admitted"
    // and "the table would not profile" are two failures the census separates on purpose.
    const report = censusOf(population);
    const profile = scoreProfile(population);
    const fallback = report.refusals.reduce((sum, entry) => sum + entry.withFallback, 0);
    const refusals = report.refusals.reduce((sum, entry) => sum + entry.n, 0);
    expect(report.outcomes.hit).toBe(profile.top1);
    expect(report.outcomes.outranked + report.outcomes.uncovered + fallback).toBe(profile.missed);
    expect(profile.declined).toBe(report.outcomes.noProfile + refusals - fallback);
  });

  it('keeps the two losing families apart in the tally', () => {
    const report = censusOf(population);
    // Ordered by the expected family when the counts tie, so the report reads the same twice.
    expect(report.outranked.map((entry) => `${entry.expected}->${entry.winner}`)).toEqual(['bar->heatmap', 'heatmap->bar']);
    expect(report.outranked[0]?.namedButLost).toBe(1);
    expect(report.outranked[1]?.onPreference).toBe(1);
    expect(report.refusals.map((entry) => entry.mark)).toEqual(['line', 'pie']);
  });

  it('groups each refusal by the shape it was refused against, which is what picks the repair', () => {
    // Two refusals, two different files: the line was refused on a table with no axis at all (two
    // measures and nothing to group them by), and the pie was refused on a table that has a category
    // axis and eight too many slices. A single "2 refused" sends the next round to neither.
    const report = censusOf(population);
    expect(report.shapes).toEqual([
      { family: 'line', mark: 'line', dims: 0, ordered: 0, measures: 2, timeLike: false, n: 1, withFallback: 1, samples: [TREND] },
      { family: 'pie', mark: 'pie', dims: 1, ordered: 0, measures: 1, timeLike: false, n: 1, withFallback: 1, samples: ['What percentage of revenue does each region contribute?'] },
    ]);
  });

  it('counts the time-formatted columns the refusals point at, which is nothing on this population', () => {
    // The bucket used to hold one: the gapped year column of a line that was refused. It is a
    // timeline and the profiler reads it, so the refusal it explained is gone and so is the column —
    // which is the shape of a fixed defect: the diagnostic empties, and it stays published because a
    // rule that narrowed again would put a row back in it on the next commit. It is not empty on the
    // corpus: six rows still carry a year column two rows long, which is a pair and not a timeline.
    const report = censusOf(population);
    expect(report.timeLikeRows).toBe(0);
    expect(report.timeLike).toEqual([]);
  });

  it('prints the time-formatted column a refusal points at, when there is one', () => {
    // The bucket reads zero on the population above and six on the corpus — a year column two rows
    // long, which is a pair and not a timeline, and a column *named* `2020` whose cells are years.
    // This row keeps the print path live and states the shape that is still in it.
    const lines = describeCensus(censusOf([input(TREND, 'Line Chart', REPEATED_YEARS)])).join('\n');
    expect(lines).toContain('time-formatted columns the profiler did not call temporal: 1 rows');
    expect(lines).toContain('Year (quantitative, 1 rows, first value 2019)');
  });

  it('refuses a report whose counters do not add up', () => {
    const report = censusOf(population);
    expect(() => assertCensusReport({ ...report, outcomes: { ...report.outcomes, hit: 0 } })).toThrow(/seven outcomes/);
    expect(() => assertCensusReport({ ...report, byFamily: [] })).toThrow(/per-family rows/);
    expect(() => assertCensusReport({ ...report, unmapped: 0 })).toThrow(/unmapped/);
    // The counterfactual is an ordering, not a second corpus: it can move a row and it cannot create
    // or destroy one, so its hits are the shipped hits plus what it converts minus what it loses.
    expect(() =>
      assertCensusReport({ ...report, counterfactual: { ...report.counterfactual, converted: 1 } }),
    ).toThrow(/counterfactual/);
  });

  it('prices the next lever on this population rather than on a claim about it', () => {
    const report = censusOf(population);
    // Neither loss here is one a fallback payment caused: `bar -> heatmap` loses to the only first
    // claim in the question, and `heatmap -> bar` has no cue at all. A rule that pays one mark per
    // cue converts nothing on this population and costs nothing, which is the honest reading of a
    // fixture that does not contain the shape the rule targets — and the reason the corpus fixture
    // for it is written by hand rather than borrowed from here.
    expect(report.counterfactual).toEqual({
      rule: 'a cue pays only the first mark it can admit',
      hit: 2,
      converted: 0,
      lost: 0,
    });
  });

  it('prints the outcomes, the refusal sentences and the losses', () => {
    const lines = describeCensus(censusOf(population)).join('\n');
    expect(lines).toContain('8 scored of 9 rows');
    expect(lines).toContain('hit 2 (25.00%)');
    expect(lines).toContain('time-formatted columns the profiler did not call temporal: 0 rows');
    expect(lines).toContain('refused line for line: 1 (1 answered by another mark) — a line needs an axis and a measure');
    expect(lines).toContain('refused line for line: 1 (1 answered elsewhere) at dims 0 / ordered 0 / measures 2');
    expect(lines).toContain('refused pie for pie: 1 (1 answered elsewhere) at dims 1 / ordered 0 / measures 1');
    expect(lines).toContain('lost bar to heatmap: 1 (on preference 0, cue named and lost 1');
    expect(lines).toContain('lost heatmap to bar: 1 (on preference 1, cue named and lost 0');
    expect(lines).toContain('tables that would not profile: empty 1');
    expect(lines).toContain('e.g. bar 4 [matrix] < heatmap 5 [matrix] — "Revenue by region and channel"');
  });

  it('maps a corpus the way the other instruments do', () => {
    const corpus = { rows: [{ prompt: TREND, chartType: 'Line Chart', raw: { 'Table Data': QUARTERLY } }] };
    expect(censusInputs(corpus)).toEqual([{ prompt: TREND, label: 'Line Chart', tableData: QUARTERLY }]);
    // A row with no `Table Data` cell is an empty result set, not a missing one: the census has to
    // classify it, and a throw here would take the whole run down on one malformed row.
    expect(censusInputs({ rows: [{ prompt: TREND, chartType: 'Line Chart', raw: {} }] })).toEqual([
      { prompt: TREND, label: 'Line Chart', tableData: '' },
    ]);
  });

  it('keeps three questions from each bucket, because the words decide which repair it needs', () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      input(`What percentage of revenue does region ${String(index + 1)} contribute?`, 'Pie Chart', regions(20)),
    );
    const report = censusOf(rows);
    expect(report.shapes[0]?.n).toBe(5);
    expect(report.shapes[0]?.samples).toEqual([
      'What percentage of revenue does region 1 contribute?',
      'What percentage of revenue does region 2 contribute?',
      'What percentage of revenue does region 3 contribute?',
    ]);
  });

  it('prints what the corpus put there instead of a table, when there was something to print', () => {
    const lines = describeCensus(
      censusOf([input(TREND, 'Line Chart', ''), input(TREND, 'Line Chart', 'Region, Revenue')]),
    ).join('\n');
    expect(lines).toContain('tables that would not profile: empty 1, header-only 1');
    expect(lines).toContain('header-only: e.g. "Region, Revenue"');
    // An empty cell has nothing to quote, and a line saying `empty: e.g. ""` is a line that teaches
    // a reader to skip the section.
    expect(lines).not.toContain('empty: e.g.');
  });

  it('counts what the lever would convert, on a row the shipped ranking loses', () => {
    // Correlation names the scatter, matrix names the heatmap, and the heatmap collects the other
    // cue's second place (7 against 5). Paying one mark per cue removes that point and the tie goes
    // to the scatter, which is ahead of the heatmap in the preference order.
    const both = table('Region, Channel, Price, Rating', [
      'North, Online, 12, 40',
      'South, Retail, 18, 55',
      'East, Online, 9, 31',
      'West, Retail, 21, 63',
    ]);
    const report = censusOf([input('Is price related to rating, by region and channel?', 'Scatter Chart', both)]);
    expect(report.outcomes.hit).toBe(0);
    expect(report.outcomes.outranked).toBe(1);
    expect(report.counterfactual).toEqual({
      rule: 'a cue pays only the first mark it can admit',
      hit: 1,
      converted: 1,
      lost: 0,
    });
    expect(() => assertCensusReport(report)).not.toThrow();
  });

  it('counts what the lever would cost, because a rule that only ever won is a rule nobody checked', () => {
    // The same row labelled `Heat Map`: the shipped ranking answers it, and the model takes it away.
    // A counterfactual that reported only `converted` would be an advertisement, and this pair is
    // the whole trade — the rule moves rows from the heatmap to the scatter and nothing else.
    const both = table('Region, Channel, Price, Rating', [
      'North, Online, 12, 40',
      'South, Retail, 18, 55',
      'East, Online, 9, 31',
      'West, Retail, 21, 63',
    ]);
    const report = censusOf([input('Is price related to rating, by region and channel?', 'Heat Map', both)]);
    expect(report.outcomes.hit).toBe(1);
    expect(report.counterfactual).toEqual({
      rule: 'a cue pays only the first mark it can admit',
      hit: 0,
      converted: 0,
      lost: 1,
    });
    expect(() => assertCensusReport(report)).not.toThrow();
  });

  it('orders equal-sized refusals by the detail that differs, so two runs read the same', () => {
    // The shape table is read as a decision, so its order has to be a fact and not an insertion
    // order. Marks tie first by count, then by name, then by the count that differs between them.
    const report = censusOf([
      input(TREND, 'Line Chart', REPEATED_YEARS),
      input(TREND, 'Line Chart', table('Price, Revenue', ['10, 1', '20, 2', '30, 3', '40, 4'])),
      input('Show the price range', 'Candlestick Chart', table('Date, Open, Close', ['2019-01-01, 1, 2', '2019-01-02, 2, 3', '2019-01-03, 3, 4'])),
      input('Show the price range', 'Candlestick Chart', table('Region, Open, Close', ['A, 1, 2', 'B, 2, 3', 'C, 3, 4'])),
    ]);
    expect(report.shapes.filter((entry) => entry.mark === 'line').map((entry) => entry.timeLike)).toEqual([false, true]);
    expect(report.shapes.filter((entry) => entry.mark === 'candlestick').map((entry) => entry.ordered)).toEqual([0, 1]);
  });

  it('keeps the arithmetic of a loss, because the gap alone says who won and not why', () => {
    // The ranked scores are in the row; what the tally adds is which cues paid them. This is the
    // shape the ranking now produces: a bar that collected three cue phrases (8) losing to a line
    // that one cue named first (5). The loser scored *higher* — the order is by first claims first —
    // and a report that showed only the gap would read as though the arithmetic were broken.
    const wide = table('Region, Channel, Revenue', [
      'North, Online, 40',
      'South, Retail, 55',
      'East, Online, 31',
      'West, Retail, 63',
    ]);
    const report = censusOf([
      input('What percentage of revenue is trending by region and channel over time?', 'Bar Chart', wide),
    ]);
    const loss = report.outranked[0];
    expect(loss?.expected).toBe('bar');
    expect(loss?.winner).toBe('line');
    expect(loss?.samples).toHaveLength(1);
    expect(loss?.samples[0]?.coveringScore).toBe(8);
    expect(loss?.samples[0]?.answeredScore).toBe(5);
    expect(loss?.samples[0]?.coveringCues).toEqual(['trend', 'share', 'matrix']);
    expect(loss?.samples[0]?.answeredCues).toEqual(['trend']);
  });

  it('keeps three losses from a pair, because three questions are enough to read the intent', () => {
    const wide = table('Region, Channel, Revenue', [
      'North, Online, 40',
      'South, Retail, 55',
      'East, Online, 31',
      'West, Retail, 63',
    ]);
    const rows = Array.from({ length: 4 }, (_, index) =>
      input(`What percentage of revenue is trending by region and channel? (${String(index + 1)})`, 'Bar Chart', wide),
    );
    const report = censusOf(rows);
    expect(report.outranked[0]?.n).toBe(4);
    expect(report.outranked[0]?.samples).toHaveLength(3);
  });

  it('names the reason a table would not profile, because the repairs are in three files', () => {
    const report = censusOf([
      input(TREND, 'Line Chart', ''),
      input(TREND, 'Line Chart', 'Region, Revenue'),
      input(TREND, 'Line Chart', 'No table accompanies this question.'),
    ]);
    expect(report.outcomes.noProfile).toBe(3);
    expect(report.noProfile.map((entry) => `${entry.reason}:${String(entry.n)}`)).toEqual([
      'empty:1',
      'header-only:1',
      'not-tabular:1',
    ]);
    expect(() => assertCensusReport(report)).not.toThrow();
    expect(() => assertCensusReport({ ...report, noProfile: [] })).toThrow(/no-profile reasons/);
  });

  it('orders two losses of the same family by the mark that beat it, so the tally is stable', () => {
    // One family losing to two different marks is the commonest shape in the corpus (a bar label
    // answered by a pie and by a heatmap), and without the third sort term the row order would
    // depend on insertion order and read differently on two runs of the same corpus.
    const report = censusOf([
      input('What percentage of revenue does each region contribute?', 'Bar Chart', regions(5)),
      input('Revenue by region and channel', 'Bar Chart', table('Region, Channel, Revenue', ['North, Online, 40', 'South, Retail, 55', 'East, Online, 31', 'West, Retail, 63'])),
    ]);
    expect(report.outranked.map((entry) => `${entry.expected}->${entry.winner}`)).toEqual(['bar->heatmap', 'bar->pie']);
  });
});

describe('what the shipped typing is worth, measured by removing it', () => {
  it('prices the run rule on the population that carries one, and only there', () => {
    const report = censusOf([input(TREND, 'Line Chart', YEARS), input(TREND, 'Line Chart', GAPPED)]);
    // Both rows carry a column the rule typed, and both are hits with the rule and refusals without
    // it: `converted 2`, `lost 0`. The gapped row is the one the old rule left out, so it is the row
    // that says the population the price is taken over is a fact about the code and not about the
    // commit that wrote it.
    expect(report.calendar.rows).toBe(2);
    expect(report.calendar.converted).toBe(2);
    expect(report.calendar.lost).toBe(0);
    expect(report.calendar.hit).toBe(report.outcomes.hit - 2);
    expect(report.calendar.split).toEqual({ a: { converted: 1, lost: 0 }, b: { converted: 1, lost: 0 } });
    expect(() => assertCensusReport(report)).not.toThrow();
  });

  it('reads zero when no row carries one, so the ablation cannot invent a price', () => {
    // A quarter column is typed by its formatting and a table of two measures has no period column at
    // all, so neither row is one the calendar rule typed and the ablation has nothing to re-type.
    const report = censusOf([input(TREND, 'Line Chart', QUARTERLY), input(TREND, 'Line Chart', AXISLESS)]);
    expect(report.calendar).toMatchObject({ rows: 0, converted: 0, lost: 0 });
    expect(report.calendar.hit).toBe(report.outcomes.hit);
  });

  it('counts the rows the typing costs as well as the rows it wins', () => {
    // A year column is also one of the numbers the table has: the five-column reading of a boxplot
    // needs five per row, and reading the year as an axis leaves four, so the mark the label asks for
    // is refused where it used to be admitted. That is the −2 the corpus shows for boxplot, in one
    // hand-built row, and the reason the price is published as a pair rather than as a gain.
    //
    // Three rows, because a table with four or more would now take the *derived* reading instead —
    // one box per measure — and the typing would then cost nothing on this shape. Three rows is the
    // shape where the two readings are the only difference: three observations are below the floor a
    // five-number summary needs, so the five-column reading is the only one available, and the year
    // column is the one thing that decides whether it is available.
    const fiveNumbers = table('Year, A, B, C, D', ['2019, 1, 2, 3, 4', '2020, 2, 3, 4, 5', '2021, 3, 4, 5, 6']);
    const report = censusOf([input('Show the numbers.', 'Box Plot', fiveNumbers)]);
    expect(report.outcomes.refused).toBe(1);
    expect(report.calendar).toMatchObject({ rows: 1, converted: 0, lost: 1, hit: 1 });
    expect(report.calendar.split).toEqual({ a: { converted: 0, lost: 1 }, b: { converted: 0, lost: 0 } });
    expect(() => assertCensusReport(report)).not.toThrow();
  });

  it('refuses a calendar price that does not reconcile with the hits it is quoted against', () => {
    const report = censusOf([input(TREND, 'Line Chart', YEARS)]);
    expect(() =>
      assertCensusReport({ ...report, calendar: { ...report.calendar, converted: 2 } }),
    ).toThrow(/un-typing the calendar/);
    // The halves are a breakdown of the same two counts, so the total is checked first and the
    // halves second: a broken total is a different defect from a total whose halves were not added,
    // and a report that failed both should name the total.
    expect(() =>
      assertCensusReport({
        ...report,
        calendar: { ...report.calendar, converted: 1, hit: 0, split: { a: { converted: 0, lost: 0 }, b: { converted: 0, lost: 0 } } },
      }),
    ).toThrow(/calendar rule's two halves gain/);
    expect(() =>
      assertCensusReport({
        ...report,
        calendar: { ...report.calendar, converted: 0, lost: 1, hit: 2, split: { a: { converted: 0, lost: 0 }, b: { converted: 0, lost: 0 } } },
      }),
    ).toThrow(/two halves lose/);
    // A rule cannot move more rows than carry the column it reads, and that is the third way to be
    // inconsistent: the counts reconcile with the hits while the population they came from is empty.
    expect(() =>
      assertCensusReport({
        ...report,
        calendar: { ...report.calendar, rows: 0, hit: 0, converted: 1, split: { a: { converted: 1, lost: 0 }, b: { converted: 0, lost: 0 } } },
      }),
    ).toThrow(/moved 1 rows out of the 0/);
  });

  it('prints the ablation in the direction it shipped, with both halves', () => {
    const report = censusOf([input(TREND, 'Line Chart', YEARS)]);
    const lines = describeCensus(report).join('\n');
    expect(lines).toContain('as if a contiguous run of years is a measure again: hit 1 -> 0');
    expect(lines).toContain('converted 1, lost 0');
    expect(lines).toContain('halves 1/0 and 0/0');
  });
});

describe('the tables no mark can group by', () => {
  const NO_AXIS = table('Revenue, Cost', ['10, 4', '14, 6', '18, 9', '26, 12']);

  it('publishes them as a population with the marks they were refused, not as a score', () => {
    const report = censusOf([input(TREND, 'Line Chart', NO_AXIS)]);
    expect(report.ceiling.rows).toBe(1);
    expect(report.ceiling.refused).toBe(1);
    expect(report.ceiling.byFamily).toEqual([{ family: 'line', n: 1, refused: 1 }]);
    expect(report.ceiling.marks).toEqual([{ mark: 'line', n: 1 }]);
    expect(report.ceiling.samples).toHaveLength(1);
    expect(() => assertCensusReport(report)).not.toThrow();
  });

  it('leaves a table with an axis out of it, which is what makes the count a ceiling', () => {
    // The scatter label is answerable over the same table — two measures admit it — so the row is a
    // hit and not a refusal; the ceiling is about the axis, and a mark that needs none is outside it.
    const report = censusOf([input('How do revenue and cost relate?', 'Scatter Chart', NO_AXIS)]);
    expect(report.outcomes.hit).toBe(1);
    expect(report.ceiling.rows).toBe(1);
    expect(report.ceiling.refused).toBe(0);
    // A table that does carry an axis is not in the population at all, even when it is a miss.
    const withAxis = censusOf([input(TREND, 'Line Chart', table('Region, Revenue', ['North, 10', 'South, 14']))]);
    expect(withAxis.ceiling.rows).toBe(0);
  });

  it('puts a table that would not profile in noProfile and not in the ceiling', () => {
    // The defect this fixture caught: `recommendChart` reports a shape of zero dims for a table it
    // could not read at all, so counting every zero-dim shape made the ceiling 164 rows larger than
    // the corpus and read as if a fifth of the benchmark had no axis.
    const report = censusOf([input(TREND, 'Line Chart', ''), input(TREND, 'Line Chart', NO_AXIS)]);
    expect(report.outcomes.noProfile).toBe(1);
    expect(report.ceiling.rows).toBe(1);
  });

  it('refuses a ceiling larger than its own families or than the refusals that carry it', () => {
    const report = censusOf([input(TREND, 'Line Chart', NO_AXIS), input(TREND, 'Line Chart', GAPPED)]);
    expect(() => assertCensusReport({ ...report, ceiling: { ...report.ceiling, refused: 99 } })).toThrow(
      /without an axis/,
    );
    // A ceiling cannot claim more refusals than the corpus classified as refused, even when its own
    // arithmetic adds up: the two populations are the same rows, and a report where they disagree is
    // a second corpus wearing the first one's denominator.
    expect(() =>
      assertCensusReport({
        ...report,
        outcomes: { ...report.outcomes, refused: 0, uncovered: report.outcomes.uncovered + report.outcomes.refused },
      }),
    ).toThrow(/the corpus has/);
    expect(() =>
      assertCensusReport({ ...report, ceiling: { ...report.ceiling, byFamily: [] } }),
    ).toThrow(/ceiling's families account for 0 rows/);
    expect(() =>
      assertCensusReport({ ...report, ceiling: { ...report.ceiling, marks: [] } }),
    ).toThrow(/ceiling's marks account for 0/);
    // The per-family refused counts are a breakdown of the same rows, so they add to the ceiling's
    // own count or the breakdown is about a different population.
    expect(() =>
      assertCensusReport({
        ...report,
        ceiling: { ...report.ceiling, byFamily: [...report.ceiling.byFamily.map((entry) => ({ ...entry, refused: 0 }))] },
      }),
    ).toThrow(/families account for 0 refusals/);
  });

  it('prints the ceiling beside the hits, so a shape nobody can encode is not read as a loss', () => {
    const report = censusOf([input(TREND, 'Line Chart', NO_AXIS)]);
    const lines = describeCensus(report).join('\n');
    expect(lines).toContain('tables with no axis at all (the ceiling of an index-axis encoding): 1 rows, 1 refused');
    expect(lines).toContain('line 1/1');
  });

  it('prints no ceiling line when every table offers an axis', () => {
    const report = censusOf([input(TREND, 'Line Chart', QUARTERLY)]);
    expect(describeCensus(report).join('\n')).not.toContain('no axis at all');
  });
});

describe('the families no mark can lead with', () => {
  // Three of the corpus's sixteen labels name a picture this contract does not have: an area is a
  // filled line, a histogram is a binned bar, and a violin is a boxplot with a density. Each is
  // covered as a *second* family, which is exactly why none of them can ever be a top-1 hit — the
  // hit test reads the first family a mark leads with, and `line` leads with `line`.
  //
  // So the reading is not "the ranking lost 237 rows". It is "237 rows are outside what this
  // contract can answer at all, and the denominator every other number is quoted against includes
  // them". Printing the two together is what lets a share of 27.96% be read beside a share of the
  // rows the product can actually draw.

  it('derives the unreachable families from the product, not from a list', () => {
    const report = censusOf([
      input(TREND, 'Area Chart', QUARTERLY),
      input('Draw a histogram of revenue.', 'Histogram', table('Revenue', ['10', '14', '18', '26', '31'])),
      input(TREND, 'Line Chart', QUARTERLY),
    ]);
    expect(report.unreachable.byFamily.map((entry) => entry.family)).toEqual(['area']);
    expect(report.unreachable.rows).toBe(1);
    // A healthy report has to pass the same check that refuses a broken one, or the check is only
    // ever exercised by the fixtures that break it.
    expect(() => assertCensusReport(report)).not.toThrow();
    const rows = report.unreachable.byFamily.map((entry) => entry.outcome.hit);
    expect(rows).toEqual([0]);
  });

  it('says which outcome those rows took, and which mark stands in for them', () => {
    const report = censusOf([input(TREND, 'Area Chart', QUARTERLY)]);
    const area = report.unreachable.byFamily[0];
    expect(area?.family).toBe('area');
    expect(area?.n).toBe(1);
    // A line is the mark that covers an area, as its second claim: the row is a shortlist hit and not
    // a top-1 hit, and it is neither refused nor outranked.
    expect(area?.outcome.substituted).toBe(1);
    expect(area?.coveredBy).toBe('line');
  });

  it('stops counting a histogram row as unreachable once the reading rewrites its rows', () => {
    // The four rounds this test spent asserting `uncovered` were four rounds in which the product
    // offered a bar and drew a grouped bar of the columns. `histogramReading` pools and bins, the cue
    // leads, and the family is reachable — so the row is a hit and the family leaves the list without
    // any of it being declared: `unreachableFamilies` derives the list from the widening.
    const report = censusOf([
      input('Draw a histogram of revenue.', 'Histogram', table('Revenue', ['10', '14', '18', '26', '31'])),
    ]);
    expect(report.unreachable.rows).toBe(0);
    expect(report.outcomes.hit).toBe(1);
  });

  it('reads a histogram question labelled bar as the bar it is, with the bins named', () => {
    // The other side of the same claim: `['histogram', 'bar']` covers `bar` as its second family, so the
    // row is a substitution — the label asked for bars and got bins, which is a nearby picture and not
    // the one it named. There is no such row in the corpus, and the branch still has to be right: a
    // family list that covers a label must not be scored as a refusal.
    const row = classify(
      input('Draw a histogram of the revenue values.', 'Bar Chart', table('Revenue', ['10', '14', '18', '26', '31'])),
    );
    expect(row).toMatchObject({ expected: 'bar', outcome: 'substituted', answered: 'bar', ownFamily: 'histogram' });
  });

  it('files a histogram question whose label asked for another picture as a rewrite, not a loss', () => {
    // The reading answers these rows with bins whatever the label wanted, and nothing refused the
    // mark the label asked for, so calling it `refused` or `outranked` would be a diagnosis of a
    // decision nobody made. `binned` is that third answer.
    const row = classify(
      input('Draw a histogram of the revenue values.', 'Box Plot', table('Revenue', ['10', '14', '18', '26', '31'])),
    );
    expect(row).toMatchObject({ expected: 'boxplot', outcome: 'binned', answered: 'bar' });
  });

  it('publishes the denominator the reachable rows are a share of', () => {
    const report = censusOf([
      input('Which region leads?', 'Bar Chart', table('Region, Revenue', ['North, 40', 'South, 55', 'East, 31'])),
      input(TREND, 'Area Chart', QUARTERLY),
      input('Draw a histogram of revenue.', 'Histogram', table('Revenue', ['10', '14', '18', '26', '31'])),
    ]);
    // Two hits now: the bar row and the histogram row, which the reading answers with bins. One row is
    // still unreachable — the area chart, which no mark leads with — so the denominator is 2 of 3.
    expect(report.outcomes.hit).toBe(2);
    expect(report.unreachable.rows).toBe(1);
    expect(report.renderable).toBe(2);
    expect(report.hitShareRenderable).toBe(1);
    expect(describeCensus(report).join('\n')).toContain('2 hit of 2 renderable rows (100.00%), against 2 of 3 (66.67%)');
  });

  it('reads zero when every label is one the contract can lead with', () => {
    const report = censusOf([input('Which region leads?', 'Bar Chart', table('Region, Revenue', ['North, 40', 'South, 55']))]);
    expect(report.unreachable.rows).toBe(0);
    expect(report.renderable).toBe(report.outcomes.hit + report.outcomes.substituted + report.outcomes.refused + report.outcomes.outranked + report.outcomes.uncovered);
    expect(describeCensus(report).join('\n')).not.toContain('renderable');
  });

  it('refuses a report whose two denominators are about different populations', () => {
    const report = censusOf([
      input('Which region leads?', 'Bar Chart', table('Region, Revenue', ['North, 40', 'South, 55', 'East, 31'])),
      input(TREND, 'Area Chart', QUARTERLY),
    ]);
    expect(() => assertCensusReport({ ...report, renderable: report.renderable + 1 })).toThrow(
      /renderable rows and the unreachable population/,
    );
    expect(() =>
      assertCensusReport({
        ...report,
        unreachable: { ...report.unreachable, byFamily: report.unreachable.byFamily.map((entry) => ({ ...entry, n: 0 })) },
      }),
    ).toThrow(/unreachable families account for 0 rows/);
    // A family cannot claim more rows of an outcome than the corpus recorded for it.
    expect(() =>
      assertCensusReport({
        ...report,
        unreachable: {
          rows: report.unreachable.rows,
          byFamily: report.unreachable.byFamily.map((entry) => ({ ...entry, outcome: { ...entry.outcome, hit: 9 } })),
        },
      }),
    ).toThrow(/claims 9 hits/);
  });
});

describe('the command', () => {
  it('takes --json and --artifact, and refuses anything else', () => {
    expect(parseCensusArgs([])).toEqual({ json: false });
    expect(parseCensusArgs(['--json'])).toEqual({ json: true });
    expect(parseCensusArgs(['--artifact', 'out.json'])).toEqual({ json: false, artifact: 'out.json' });
    expect(() => parseCensusArgs(['--artifact'])).toThrow(/needs a path/);
    expect(() => parseCensusArgs(['--verbose'])).toThrow(/unknown argument --verbose/);
  });

  it('classifies a served corpus and writes the artifact', async () => {
    // The code cell is quoted because it holds a comma: an unquoted one would split into two cells and
    // push the chart type out of its column, which reads as an unmapped label rather than as a
    // parsing defect.
    const csv = `${HEADER}\n${cell(TREND)},line,${cell('plt.plot(x,y)')},Line Chart,${cell(QUARTERLY)}\n`;
    const server = await serve(csv);
    const lines: string[] = [];
    const target = join(root, 'census.json');
    try {
      const code = await entryCensus(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--artifact', target],
        load: { cacheDir: join(root, 'served'), url: server.url },
      });
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('text2vis census: 1 scored of 1 rows');
      const written = JSON.parse(readFileSync(target, 'utf8')) as { outcomes: { hit: number } };
      expect(written.outcomes.hit).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('prints JSON when asked', async () => {
    // The code cell is quoted because it holds a comma: an unquoted one would split into two cells and
    // push the chart type out of its column, which reads as an unmapped label rather than as a
    // parsing defect.
    const csv = `${HEADER}\n${cell(TREND)},line,${cell('plt.plot(x,y)')},Line Chart,${cell(QUARTERLY)}\n`;
    const server = await serve(csv);
    const lines: string[] = [];
    try {
      const code = await entryCensus(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--json'],
        load: { cacheDir: join(root, 'json'), url: server.url },
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(lines[1] as string) as { scored: number };
      expect(parsed.scored).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('fails when nothing was scored, because a zero denominator is not a census', async () => {
    const csv = `${HEADER}\n${cell(TREND)},x,${cell('plt.plot(x,y)')},Word Cloud,${cell(QUARTERLY)}\n`;
    const server = await serve(csv);
    const lines: string[] = [];
    try {
      const code = await entryCensus(ENTRY, MODULE_URL, (line) => lines.push(line), {
        load: { cacheDir: join(root, 'empty'), url: server.url },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('0 scored of 1 rows');
    } finally {
      await server.close();
    }
  });

  it('fails the run on an argument it does not use, rather than measuring something else', async () => {
    const lines: string[] = [];
    const code = await entryCensus(ENTRY, MODULE_URL, (line) => lines.push(line), { argv: ['--corpus', 'x'] });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('unknown argument --corpus');
  });

  it('returns nothing when imported rather than run', async () => {
    const spy = vi.spyOn(console, 'log');
    try {
      expect(await entryCensus('/elsewhere/main.ts', MODULE_URL, () => undefined)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the cue table the census reads', () => {
  it('is the shipped one, so the positions it reports are the ones the product pays on', () => {
    expect(readCues('Revenue by region and channel').map((cue) => cue.kind)).toEqual(['matrix']);
    const marks: readonly ChartType[] = readCues('Revenue by region and channel')[0]?.marks ?? [];
    expect(marks.indexOf('heatmap')).toBe(0);
    expect(marks.indexOf('bar')).toBe(1);
  });
});

describe('every cue table, priced on the product', () => {
  /** Three regions and one measure: a pie is admitted, a bar is admitted, and the label decides. */
  const REGIONS = table('Region, Revenue', ['North, 100', 'South, 80', 'East, 60']);
  /** A part of a whole, which the product answers with a pie and the blunt flip answers with a bar. */
  const PART = 'the share of revenue that is refunds';

  const rows = [input(PART, 'Pie Chart', REGIONS), input(TREND, 'Line Chart', QUARTERLY)];

  it('prices the shipped table through a second code path, and holds the two equal', () => {
    const report = censusOf(rows);
    expect(report.outcomes.hit).toBe(2);
    // Two computations of one number: `classify` decides the outcome of a row, and the sweep asks the
    // same question again from the row loop with the same table. A disagreement is a defect in one of
    // them, which is why `assertCensusReport` compares them rather than trusting either.
    expect(report.product[0]).toMatchObject({ variant: 'shipped', hit: 2, hitShare: 1 });
    expect(() => assertCensusReport(report)).not.toThrow();
  });

  it('shows a candidate losing a row the cue-only reading cannot see', () => {
    // The blunt flip rewards the question and costs the answer: a share word is a comparison on 186
    // more rows and a part of a whole on 142 fewer, and this row is one of the 142 — the table could
    // carry the pie the label asks for, and the flip answers a bar.
    const report = censusOf(rows);
    const flipped = report.product.find((variant) => variant.variant === 'bar-share');
    expect(flipped?.hit).toBe(1);
    expect(flipped?.byFamily.find((cell) => cell.family === 'pie')).toEqual({ family: 'pie', n: 1, hit: 0 });
    // Every table is priced on the same population, or the comparison is between two corpora.
    expect(report.product.every((variant) => variant.byFamily.reduce((total, cell) => total + cell.n, 0) === report.scored)).toBe(true);
  });

  it('refuses a sweep whose control is not the table that ships', () => {
    const report = censusOf(rows);
    const shipped = report.product[0]!;
    expect(() =>
      assertCensusReport({ ...report, product: [{ ...shipped, variant: 'bar-share' }, ...report.product.slice(1)] }),
    ).toThrow(/must begin with the shipped table/);
  });

  it('refuses a sweep that disagrees with the census about the shipped table', () => {
    const report = censusOf(rows);
    const shipped = report.product[0]!;
    expect(() =>
      assertCensusReport({ ...report, product: [{ ...shipped, hit: shipped.hit + 1 }, ...report.product.slice(1)] }),
    ).toThrow(/one of the two is not the product/);
  });

  it('refuses a variant priced on a different number of rows', () => {
    const report = censusOf(rows);
    const shipped = report.product[0]!;
    expect(() =>
      assertCensusReport({ ...report, product: [{ ...shipped, byFamily: [] }, ...report.product.slice(1)] }),
    ).toThrow(/two corpora/);
  });

  it('records the ablation of the cue that now produces a hit, row for row', () => {
    // This test used to be the argument for the cue: a `substituted` that no hit count could see,
    // and an ablation priced at ±0. The reading changed what the cue buys — the row is a hit, not a
    // substitution — so the same two cells are asserted the other way round. What has not changed is
    // why the sweep publishes both counts: `hit` and `shortlist` are one population read twice, and a
    // report where they disagree is a report about a different corpus.
    const report = censusOf([input('Draw a histogram of revenue.', 'Histogram', REGIONS)]);
    const shipped = report.product[0]!;
    expect(shipped).toMatchObject({ hit: 1, substituted: 0, shortlist: 1 });
    // The ablation of the cue that produces it: without `histogram` the distribution cue answers a
    // boxplot, which covers neither the label nor the bins, so the row falls out of both counts.
    const ablated = report.product.find((variant) => variant.variant === 'no-histogram');
    expect(ablated).toMatchObject({ hit: 0, substituted: 0, shortlist: 0 });
    // The two counts are the same population read twice, so a report where they disagree is a
    // report whose shortlist is about a different corpus.
    expect(() =>
      assertCensusReport({
        ...report,
        product: [{ ...shipped, shortlist: shipped.shortlist + 1 }, ...report.product.slice(1)],
      }),
    ).toThrow(/shortlist/);
    // And a shortlist cannot be larger than the population it is a share of, whatever its own two
    // counts are: an answer is one row, so a table cannot put more rows in front of a user than it
    // was shown.
    expect(() =>
      assertCensusReport({
        ...report,
        product: [
          { ...shipped, shortlist: report.scored + 1, substituted: report.scored + 1 - shipped.hit },
          ...report.product.slice(1),
        ],
      }),
    ).toThrow(/shortlists/);
  });

  it('prints one line per table with its delta against the control, and nothing when there is none', () => {
    const report = censusOf(rows);
    const lines = describeProduct(report);
    expect(lines[0]).toContain(`the same rows on the product, ${String(report.product.length)} tables`);
    expect(lines).toHaveLength(1 + report.product.length);
    const flipped = lines.find((line) => line.trimStart().startsWith('bar-share '));
    expect(flipped).toContain('pie -1');
    expect(lines.find((line) => line.trimStart().startsWith('shipped '))).not.toContain('|');
    expect(describeProduct({ ...report, product: [] })).toEqual([]);
  });
});

describe('the admission cap, priced beside the cue tables', () => {
  /** Nine slices: one more than a pie admits, and a bar answers it instead. */
  const NINE = table('Region, Revenue', regions(9).split('\n').slice(1));
  const PART = 'the share of revenue that is refunds';

  it('shows the retired cap refusing a pie the shipped one admits, and prices the ceiling', () => {
    // The cap is a product decision about legibility and the corpus disagrees with it on a specific
    // shape: a part of a whole with nine categories. Refusing the pie does not make the row a `bar`
    // question — the cue said pie and the admission said no — so the row is a refusal rather than a
    // wrong answer, which is the census telling a reader which file to open.
    const report = censusOf([input(PART, 'Pie Chart', NINE)]);
    expect(report.outcomes).toMatchObject({ hit: 1, refused: 0 });
    // The retired cap stays in the table rather than in a commit message: it is the only table that
    // can still say what the four rows were worth, and its reason sentence is the product's own.
    const retired = report.product.find((variant) => variant.variant === 'slices-7');
    expect(retired).toMatchObject({ hit: 0 });
    expect(censusOf([input(PART, 'Pie Chart', NINE)]).product[0]).toMatchObject({ variant: 'shipped', hit: 1 });
    expect(report.product.find((variant) => variant.variant === 'slices-any')).toMatchObject({ hit: 1 });
  });

  it('prices the knobs after every cue table, so the cue axis is read first', () => {
    const names = censusOf([input(PART, 'Pie Chart', NINE)]).product.map((variant) => variant.variant);
    const firstKnob = names.indexOf('slices-7');
    expect(firstKnob).toBeGreaterThan(0);
    // The frontier is a curve, not a single candidate: the smallest cap that reaches the gain is a
    // better product than the largest one that also reaches it, and which is which is a reading.
    expect(names.slice(firstKnob)).toEqual(['slices-7', 'slices-9', 'slices-any']);
    // Each entry says what it changed, because a name like `slices-12` is a label and the note is the
    // claim a reader checks.
    expect(censusOf([input(PART, 'Pie Chart', NINE)]).product[names.indexOf('slices-9')]?.note).toContain('eight or nine');
  });

  it('splits every table across two halves that sum to the whole', () => {
    // Two disjoint halves of the same population, fixed before the reading and arbitrary with respect
    // to content. They exist so that a candidate chosen for winning cannot be chosen for fitting: a
    // lever that gains on one half and loses on the other has not been shown to gain at all.
    // Ordered so that each half holds one hit and one miss: a split of two rows that both landed in
    // the same half would let a table that only ever wins on even rows pass as a table that wins.
    const SEVEN = table('Region, Revenue', regions(7).split('\n').slice(1));
    const report = censusOf([
      input(PART, 'Pie Chart', SEVEN),
      input(TREND, 'Line Chart', QUARTERLY),
      input(PART, 'Pie Chart', NINE),
      input(PART, 'Pie Chart', NINE),
    ]);
    for (const variant of report.product) expect(variant.split.a + variant.split.b).toBe(variant.hit);
    expect((report.product[0]?.split.a ?? -1) + (report.product[0]?.split.b ?? -1)).toBe(report.outcomes.hit);
    // Both halves are non-empty on a corpus of four rows, or the split is a way of reporting one half
    // twice and calling the other zero.
    expect(report.product[0]?.split.a).toBeGreaterThan(0);
    expect(report.product[0]?.split.b).toBeGreaterThan(0);
  });

  it('refuses a table whose halves do not add up, and one whose control does not', () => {
    const report = censusOf([input(PART, 'Pie Chart', NINE), input(TREND, 'Line Chart', QUARTERLY)]);
    const shipped = report.product[0]!;
    expect(() =>
      assertCensusReport({ ...report, product: [{ ...shipped, split: { a: shipped.split.a + 1, b: shipped.split.b } }] }),
    ).toThrow(/half/);
    expect(() =>
      assertCensusReport({ ...report, product: [{ ...shipped, split: { a: shipped.split.a + 1, b: shipped.split.b - 1 } }] }),
    ).not.toThrow();
  });

  it('counts the answers an entry changes, not only the hits it costs', () => {
    // The hit delta answers "what does this cost the score"; it does not answer "what does it change".
    // A cue whose rows are all misses can be worth zero hits either way while every one of those
    // answers moves, and an ablation that published only the delta would read as "this cue does
    // nothing" -- a claim about the product that the reading does not support.
    // Three rows rather than two: a two-value column of numbers profiles as `ordinal`, so the table
    // would carry no measure and every mark would be refused before either table was read.
    const two = table('Region, Channel, Revenue', ['North, Web, 10', 'South, App, 20', 'East, Web, 30']);
    const report = censusOf([input('revenue by region and channel', 'Pie Chart', two)]);
    const control = report.product[0]!;
    expect(control).toMatchObject({ variant: 'shipped', moved: 0 });
    const flip = report.product.find((variant) => variant.variant === 'matrix-bar-first');
    // The label is a pie, so neither answer can hit: the row is a miss under both tables, and the
    // answer it gets changes from a heatmap to a bar.
    expect(flip?.hit).toBe(control.hit);
    expect(flip?.moved).toBe(1);
    expect(() => assertCensusReport({ ...report, product: [{ ...control, moved: 1 }, ...report.product.slice(1)] })).toThrow(
      /differ from itself/,
    );
  });

  it('prints each knob with its delta, on the same line shape as a cue table', () => {
    const report = censusOf([input(PART, 'Pie Chart', NINE)]);
    const lines = describeProduct(report);
    expect(lines).toHaveLength(1 + report.product.length);
    // The knob reads as a loss because the cap it retires is what the control replaced: the sign is
    // the point, and a line that read `pie +1` would mean the default had not moved.
    const knob = lines.find((line) => line.trimStart().startsWith('slices-7 '));
    expect(knob).toContain('pie -1');
    expect(lines.find((line) => line.trimStart().startsWith('shipped '))).not.toContain('|');
  });
});
