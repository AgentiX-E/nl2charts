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
  entryCensus,
  parseCensusArgs,
  timeLikeColumns,
} from '../eval/text2vis/census.js';
import { parseResultSet, profilesOf, scoreProfile, type ProfileInput } from '../eval/text2vis/profile.js';

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

/** The same timeline written as years: four characters, and the profiler reads them as a measure. */
const YEARS = table('Year, Revenue', ['2019, 10', '2020, 14', '2021, 18', '2022, 26', '2023, 31']);

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
    expect(coveringMarks('histogram')).toEqual(['bar']);
    expect(coveringMarks('bar')).toEqual(['bar']);
    expect(coveringMarks('heatmap')).toEqual(['heatmap']);
  });

  it('has no mark for a family the contract cannot draw, so the gap is countable', () => {
    expect(coveringMarks('violin')).toEqual([]);
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
  it('names a year typed as a measure, which is what refuses a line', () => {
    const set = parseResultSet(YEARS);
    const found = timeLikeColumns(set, profilesOf(set));
    expect(found).toEqual([{ column: 'Year', typed: 'quantitative', sample: '2019', n: 1 }]);
  });

  it('leaves an ISO date alone, because the profiler already reads it as temporal', () => {
    const set = parseResultSet(QUARTERLY);
    expect(timeLikeColumns(set, profilesOf(set))).toEqual([]);
  });

  it('stops reporting a column once the profiler reads it as time', () => {
    // The diagnostic measures the gap between "a person reads a date" and "the profiler did", so it
    // has to shrink when the profiler widens: quarters, month names and a year-and-month are now
    // typed temporal, and only the shape the profiler still cannot read is left — a bare year, which
    // is indistinguishable from a measure of the same magnitude and stays one on purpose.
    for (const text of ['Q1 2019, 10\nQ2 2019, 12\nQ3 2019, 14', 'Jan 2019, 10\nFeb 2019, 12\nMar 2019, 14', '2019-01, 10\n2019-02, 12\n2019-03, 14']) {
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

describe('what became of one question', () => {
  it('reads a hit when the mark the label names is the one the profile admits', () => {
    expect(classify(input(TREND, 'Line Chart', QUARTERLY))).toEqual({ expected: 'line', outcome: 'hit' });
  });

  it('names the admission rule that refused a line over a year column', () => {
    // The reading this instrument exists for. The table cell says `2019`, the profiler stores a
    // number, `shape.ordered` is empty, and the sentence below is the product's own refusal — not a
    // paraphrase of it, so a document can quote the rule it quotes here.
    const row = expectOutcome(input(TREND, 'Line Chart', YEARS), 'refused');
    expect(row.outcome).toBe('refused');
    expect(row.covering).toBe('line');
    expect(row.reason).toBe('a line needs an ordered axis and a measure');
  });

  it('names the slice limit that refused a pie over twenty categories', () => {
    const row = expectOutcome(input('What percentage of revenue does each region contribute?', 'Pie Chart', regions(20)), 'refused');
    expect(row.outcome).toBe('refused');
    expect(row.covering).toBe('pie');
    expect(row.reason).toBe('a pie needs one category of at most 7 slices, none of them negative');
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

describe('the census over a population', () => {
  const population: readonly ProfileInput[] = [
    input(TREND, 'Line Chart', QUARTERLY),
    input(TREND, 'Line Chart', YEARS),
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
    expect(report.outcomes).toEqual({ hit: 2, refused: 2, outranked: 2, uncovered: 1, noProfile: 1 });
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
    // measures and a column of years the profiler called a measure), and the pie was refused on a
    // table that has a category axis and eight too many slices. A single "2 refused" sends the next
    // round to neither.
    const report = censusOf(population);
    expect(report.shapes).toEqual([
      { family: 'line', mark: 'line', dims: 0, ordered: 0, measures: 2, timeLike: true, n: 1, withFallback: 1 },
      { family: 'pie', mark: 'pie', dims: 1, ordered: 0, measures: 1, timeLike: false, n: 1, withFallback: 1 },
    ]);
  });

  it('counts the time-formatted columns the refusals point at', () => {
    const report = censusOf(population);
    expect(report.timeLikeRows).toBe(1);
    expect(report.timeLike).toEqual([{ column: 'Year', typed: 'quantitative', sample: '2019', n: 1 }]);
  });

  it('refuses a report whose counters do not add up', () => {
    const report = censusOf(population);
    expect(() => assertCensusReport({ ...report, outcomes: { ...report.outcomes, hit: 0 } })).toThrow(/five outcomes/);
    expect(() => assertCensusReport({ ...report, byFamily: [] })).toThrow(/per-family rows/);
    expect(() => assertCensusReport({ ...report, unmapped: 0 })).toThrow(/unmapped/);
  });

  it('prints the outcomes, the refusal sentences and the losses', () => {
    const lines = describeCensus(censusOf(population)).join('\n');
    expect(lines).toContain('8 scored of 9 rows');
    expect(lines).toContain('hit 2 (25.00%)');
    expect(lines).toContain('time-formatted columns the profiler did not call temporal: 1 rows');
    expect(lines).toContain('Year (quantitative, 1 rows, first value 2019)');
    expect(lines).toContain('refused line for line: 1 (1 answered by another mark) — a line needs an ordered axis and a measure');
    expect(lines).toContain('refused line for line: 1 (1 answered elsewhere) at dims 0 / ordered 0 / measures 2, time-formatted column present');
    expect(lines).toContain('refused pie for pie: 1 (1 answered elsewhere) at dims 1 / ordered 0 / measures 1');
    expect(lines).toContain('lost bar to heatmap: 1 (on preference 0, cue named and lost 1');
    expect(lines).toContain('lost heatmap to bar: 1 (on preference 1, cue named and lost 0');
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

  it('orders equal-sized refusals by the detail that differs, so two runs read the same', () => {
    // The shape table is read as a decision, so its order has to be a fact and not an insertion
    // order. Marks tie first by count, then by name, then by the count that differs between them.
    const report = censusOf([
      input(TREND, 'Line Chart', YEARS),
      input(TREND, 'Line Chart', table('Price, Revenue', ['10, 1', '20, 2', '30, 3', '40, 4'])),
      input('Show the price range', 'Candlestick Chart', table('Date, Open, Close', ['2019-01-01, 1, 2', '2019-01-02, 2, 3', '2019-01-03, 3, 4'])),
      input('Show the price range', 'Candlestick Chart', table('Region, Open, Close', ['A, 1, 2', 'B, 2, 3', 'C, 3, 4'])),
    ]);
    expect(report.shapes.filter((entry) => entry.mark === 'line').map((entry) => entry.timeLike)).toEqual([false, true]);
    expect(report.shapes.filter((entry) => entry.mark === 'candlestick').map((entry) => entry.ordered)).toEqual([0, 1]);
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
