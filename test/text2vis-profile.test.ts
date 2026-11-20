/**
 * The chart half, with the result set in front of the recommender.
 *
 * `text2vis-rule.test.ts` pins the cue table; this file pins the half the cue table cannot see. The
 * cases are chosen to be the ones the cue-only reading fails on: a share question over twenty
 * categories (the corpus labels it `Bar` and the cue table answers `pie`), a share question over
 * five (labelled `Pie`, where the cue table is already right and the profile must not break it), and
 * a table the profiler cannot read at all.
 *
 * Nothing here touches the network: the corpus is strings, and the one end-to-end case serves a CSV
 * from a local socket the way every other instrument's end-to-end case does.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { applyExitCode } from '../eval/text2vis/dataset.js';
import {
  assertProfileReport,
  describeProfile,
  entryProfile,
  parseProfileArgs,
  parseResultSet,
  profileAnswer,
  profileInputs,
  isMissingCell,
  numericCell,
  profilesOf,
  scoreProfile,
  typedRows,
} from '../eval/text2vis/profile.js';
import { scoreRule } from '../eval/text2vis/rule.js';
import { TEXT2VIS_FIELDS } from '../eval/text2vis/dataset.js';

const root = mkdtempSync(join(tmpdir(), 'nl2charts-text2vis-profile-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const ENTRY = resolve('eval/text2vis/profile.ts');
const MODULE_URL = pathToFileURL(ENTRY).href;
// Five columns, because this reading needs the fifth: `Table Data` is the result set, and a corpus
// without the column is a corpus this command can only decline on.
const HEADER = `${TEXT2VIS_FIELDS.prompt},${TEXT2VIS_FIELDS.answer},${TEXT2VIS_FIELDS.code},${TEXT2VIS_FIELDS.chartType},Table Data`;

/**
 * One CSV cell holding a whole table.
 *
 * Quoted, with the newlines left real: `JSON.stringify` would escape them to the two characters
 * `\n`, and the field would then be a single line of commas — the table would parse as its own
 * header and nothing else, which is the failure this fixture exists to avoid.
 */
function cell(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/** A table of `count` regions, so one fixture answers both the refusal and the admission. */
function regions(count: number): string {
  const names = ['North', 'South', 'East', 'West', 'Central', 'Northeast', 'Southwest', 'Midwest', 'Coastal', 'Inland', 'Delta', 'Highland', 'Lowland', 'Border', 'Capital', 'Island', 'Valley', 'Forest', 'Desert', 'Plains'];
  const lines = ['Region, Revenue'];
  for (let index = 0; index < count; index += 1) lines.push(`${names[index % names.length] as string} ${String(index + 1)}, ${String(100 - index * 3)}`);
  return lines.join('\n');
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

describe('the number a cell holds', () => {
  /**
   * The formats a result set writes numbers in.
   *
   * The corpus ships `Table Data` as text — a table copied out of a database, formatted for a reader
   * — and `Number('1,234')` is `NaN`. Every column of grouped numbers was therefore typed `nominal`,
   * the table had no measure, and every mark that needs one was refused: 389 of the 890 refusals the
   * census counted on Text2Vis. A driver with a typed schema would hand the product a number, so
   * reading the formatting is this instrument modelling that layer rather than the product being
   * lenient.
   */
  it('reads the grouping, currency and percent a table is displayed with', () => {
    expect(numericCell('1,234')).toBe(1234);
    expect(numericCell('1,234.56')).toBe(1234.56);
    expect(numericCell('$1,234')).toBe(1234);
    expect(numericCell('€1,234')).toBe(1234);
    expect(numericCell('12.5%')).toBe(12.5);
    expect(numericCell(' 42 ')).toBe(42);
    expect(numericCell('-5')).toBe(-5);
    expect(numericCell('0')).toBe(0);
  });

  it('reads an accounting negative, because a result set writes one that way', () => {
    expect(numericCell('(1,234)')).toBe(-1234);
    expect(numericCell('(42)')).toBe(-42);
  });

  it('refuses what is not a number, rather than coercing a word to zero', () => {
    expect(numericCell('')).toBeUndefined();
    expect(numericCell('North')).toBeUndefined();
    expect(numericCell('1,2')).toBeUndefined();
    expect(numericCell('NaN')).toBeUndefined();
    expect(numericCell('Infinity')).toBeUndefined();
    expect(numericCell('1 234')).toBeUndefined();
  });

  it('keeps a leading zero a code and not a quantity', () => {
    expect(numericCell('007')).toBeUndefined();
    expect(numericCell('0123')).toBeUndefined();
  });

  it('turns a formatted column into a measure, which is what the refusal was missing', () => {
    const set = parseResultSet('Region, Revenue\nNorth, "1,234"\nSouth, "2,345"\nEast, "3,456"\nWest, "4,567"');
    expect(profilesOf(set).find((profile) => profile.name === 'Revenue')?.type).toBe('quantitative');
    expect(typedRows(set)[0]?.Revenue).toBe(1234);
  });

  it('reads `nan` as a printed absence, because no person writes it into a category', () => {
    // 595 cells of the corpus are spelled exactly `nan`, in 320 columns of 120 rows. Read as the
    // string it is, each one demoted its column from a measure to a category — and a category axis is
    // enough to satisfy a shape rule, so the table drew a heatmap of a numeric column against itself.
    expect(isMissingCell('nan')).toBe(true);
    expect(isMissingCell('NaN')).toBe(true);
    expect(isMissingCell(' nan ')).toBe(true);
    // Not a substring match, and not a word that could name a region.
    expect(isMissingCell('nanogram')).toBe(false);
    expect(isMissingCell('Nassau')).toBe(false);
    const set = parseResultSet('Year, Value\n2019, 12\n2020, nan\n2021, 14');
    expect(typedRows(set)[1]?.Value).toBeNull();
    // Two numbers, so `inferType` reads a scale rather than a measure — the point is that the column
    // is numeric at all: a `nan` used to make it text.
    expect(profilesOf(set).find((profile) => profile.name === 'Value')?.numbers).toBe(2);
  });

  it('does not profile a column whose every cell is a printed absence', () => {
    // A header the query produced and never filled. Profiled, it is a category axis with no
    // categories — which satisfies "two category axes" and draws a heatmap whose lanes are all null.
    const set = parseResultSet('Country, 2016, Value\nArmenia, nan, 73\nBelize, nan, 31\nKenya, nan, 12');
    expect(profilesOf(set).map((profile) => profile.name)).toEqual(['Country', 'Value']);
    expect(profilesOf(set).find((profile) => profile.name === 'Country')?.type).toBe('nominal');
  });
});

describe('a result set, as the corpus spells it', () => {
  it('reads a header and its rows', () => {
    const set = parseResultSet('Country, Value\nNigeria, 43.54\nIndia, 0.76');
    expect(set.columns).toEqual(['Country', 'Value']);
    expect(set.rows).toEqual([
      ['Nigeria', '43.54'],
      ['India', '0.76'],
    ]);
  });

  it('keeps a quoted comma inside one cell, and drops the trailing newline', () => {
    // The corpus holds names like `Korea, Rep.`, which is why the parser is the file's own rather
    // than a split on commas: the same rules parse both files or the profile of one is wrong.
    const set = parseResultSet('Country, Value\n"Korea, Rep.", 12\n\n');
    expect(set.rows).toEqual([['Korea, Rep.', '12']]);
  });

  it('types numbers, leaves a missing cell null, and keeps a leading zero as text', () => {
    const set = parseResultSet('Code, Value\n007, 12\nA1, ');
    expect(typedRows(set)).toEqual([
      { Code: '007', Value: 12 },
      { Code: 'A1', Value: null },
    ]);
  });

  it('profiles the columns the recommender ranks on', () => {
    const profiles = profilesOf(parseResultSet(regions(5)));
    const revenue = profiles.find((profile) => profile.name === 'Revenue');
    const region = profiles.find((profile) => profile.name === 'Region');
    expect(revenue?.type).toBe('quantitative');
    expect(revenue?.max).toBe(100);
    expect(region?.type).toBe('nominal');
    expect(region?.distinct).toBe(5);
  });

  it('answers nothing for a table with no rows', () => {
    expect(profilesOf(parseResultSet('Region, Revenue'))).toEqual([]);
  });
});

/**
 * The `Table Data` cell is not always a CSV.
 *
 * 196 of the corpus's 1,985 rows write their table as a JSON object of columns — `{"Year": [2018,
 * 2019], "Coal": [1000, 950]}` — and the CSV reader read the whole object as a one-line header with
 * no rows. Every one of those rows was declined, not because its table could not be charted but
 * because this instrument could not read the representation: 164 of the 352 declined rows the
 * published reading carries. The cases below pin the two halves of the repair — an object that names
 * its columns is read, and an object that cannot be read as a rectangle is refused rather than
 * padded into one.
 */
describe('a table the corpus writes as an object instead of a csv', () => {
  it('reads a column-shaped object as the rows it names', () => {
    const set = parseResultSet('{"Year": [2018, 2019, 2020], "Coal": [1000, 950, 900]}');
    expect(set.columns).toEqual(['Year', 'Coal']);
    expect(set.rows).toEqual([
      ['2018', '1000'],
      ['2019', '950'],
      ['2020', '900'],
    ]);
  });

  it('keeps the key order, because the object states the column order', () => {
    // A transposition that sorted its keys would put `Coal` before `Year` and hand the recommender an
    // axis where the measure was — the failure mode a `Map` preserves order to avoid, not to tidy up.
    const set = parseResultSet('{"Zeta": [1], "Alpha": [2], "Mid": [3]}');
    expect(set.columns).toEqual(['Zeta', 'Alpha', 'Mid']);
    expect(set.rows).toEqual([['1', '2', '3']]);
  });

  it('profiles an object table exactly as it profiles the same table as a csv', () => {
    const object = parseResultSet('{"Region": ["North", "South", "East"], "Revenue": [100, 90, 80]}');
    const csv = parseResultSet('Region, Revenue\nNorth, 100\nSouth, 90\nEast, 80');
    expect(profilesOf(object)).toEqual(profilesOf(csv));
  });

  it('prints an absent value as an absent cell, not as the word null', () => {
    // `String(null)` is `'null'`, which `numericCell` reads as a number of nothing and the column
    // would keep a measure it does not have. The empty cell is what the CSV path writes for one.
    const set = parseResultSet('{"Region": ["North", "South"], "Revenue": [100, null]}');
    expect(typedRows(set)).toEqual([
      { Region: 'North', Revenue: 100 },
      { Region: 'South', Revenue: null },
    ]);
  });

  it('refuses columns of different lengths rather than padding the short one', () => {
    // A short column is a corrupt table, and padding it would invent a row: the same rule the CSV
    // path states for a row that has fewer cells than the header.
    expect(parseResultSet('{"A": [1, 2, 3], "B": [1, 2]}').columns).toEqual([]);
  });

  it('refuses an object whose values are not lists, an empty object, and a nested list', () => {
    expect(parseResultSet('{"A": 1, "B": 2}').columns).toEqual([]);
    expect(parseResultSet('{}').columns).toEqual([]);
    expect(parseResultSet('{"A": [[1, 2]], "B": [[3, 4]]}').columns).toEqual([]);
    expect(parseResultSet('{"A": [], "B": []}').columns).toEqual([]);
  });

  it('refuses a json array, which is rows without a header', () => {
    // `[[1, 2], [3, 4]]` cannot say what to call its columns, and a name invented here would be a
    // column the result set never had.
    expect(parseResultSet('[[1, 2], [3, 4]]').columns).toEqual([]);
  });

  it('reads a brace that is not json as the csv it is', () => {
    // A CSV whose first header cell starts with a brace is not a table that could not be read; it is
    // a table whose first cell happens to start with `{`. Falling back is what keeps the object
    // reader from swallowing the CSV path.
    const set = parseResultSet('{count}, value\n{a}, 1');
    expect(set.columns).toEqual(['{count}', 'value']);
    expect(set.rows).toEqual([['{a}', '1']]);
  });
});

describe('the recommender, with a table in front of it', () => {
  it('refuses a pie over twenty categories and answers bar', () => {
    // The row the cue-only reading gets wrong most often: `what percentage` names a share, the cue
    // table answers pie, and twenty categories cannot be sliced into one.
    const answer = profileAnswer('What percentage of revenue does each region contribute?', regions(20));
    expect(answer.mark).toBe('bar');
    expect(answer.families).toContain('bar');
  });

  it('answers pie for the same question over five categories', () => {
    // The other half of the same rule: a profile that only ever refuses pie would buy bar accuracy
    // by giving away the 145 pie rows the cue table already gets right.
    const answer = profileAnswer('What percentage of revenue does each region contribute?', regions(5));
    expect(answer.mark).toBe('pie');
  });

  it('declines a table it cannot profile rather than answering its first mark', () => {
    const answer = profileAnswer('What percentage of revenue does each region contribute?', '');
    expect(answer.mark).toBe('declined');
    expect(answer.reasons).toEqual(['profile:none']);
  });

  it('answers the reshape for a table that is wide in time, and says which rule answered it', () => {
    // The product draws this table as one line per entity without asking an admission rule, so a
    // reading that let every rule refuse it would publish a `declined` count the render report — which
    // reads the same rows — could not agree with. Two instruments disagreeing about "the product
    // answered nothing" is the defect both of them exist to catch.
    const answer = profileAnswer(
      'How has the population changed?',
      'country,2019,2020,2021\nOman,1,2,3\nSamoa,4,5,6',
    );
    expect(answer.mark).toBe('line');
    expect(answer.reasons).toEqual(['melt:wide']);
    expect(answer.families).toContain('line');
  });

  it('answers a histogram question with the bins, before the reshape or any admission rule', () => {
    // The reading the product takes first, and the reason this instrument had to learn it: `tallyChart`
    // pools and bins before it looks at a column, so an offline reading that ranked the table would be
    // pricing a chart nobody receives. The label here is `Histogram` and the answer leads with it.
    const answer = profileAnswer(
      'Draw a histogram of all the values and say whether it is skewed.',
      'Characteristic,2016,2017\nCoal,10,15\nGas,20,25\nOil,30,35',
    );
    expect(answer.mark).toBe('bar');
    expect(answer.families[0]).toBe('histogram');
    expect(answer.reasons).toEqual(['histogram:pooled']);
  });

  it('declines a table every admission refuses', () => {
    // One nominal column and no measure: a bar needs a measure, a line needs an ordered axis, a pie
    // needs a measure, and the two marks that read several numbers need columns that are not there.
    // The reading has to say *this* rather than blame the ranking, which is why the reason travels.
    const answer = profileAnswer('How many rows are there?', 'Label\nalpha\nbeta');
    expect(answer.mark).toBe('declined');
    expect(answer.reasons).toEqual(['profile:refused']);
  });
});

describe('the reading', () => {
  const row = (prompt: string, label: string, tableData: string): { prompt: string; label: string; tableData: string } => ({ prompt, label, tableData });

  it('counts a hit, a shortlist miss and a refusal separately', () => {
    const report = scoreProfile([
      row('What percentage of revenue does each region contribute?', 'Bar Chart', regions(20)),
      row('What percentage of revenue does each region contribute?', 'Pie Chart', regions(5)),
      row('What percentage of revenue does each region contribute?', 'Bar Chart', ''),
    ]);
    expect(report.scored).toBe(3);
    expect(report.top1).toBe(2);
    expect(report.shortlist).toBe(2);
    expect(report.declined).toBe(1);
    expect(() => assertProfileReport(report)).not.toThrow();
  });

  it('excludes an unmapped label and publishes it with its count', () => {
    const report = scoreProfile([row('Show the hierarchy', 'Treemap', regions(5))]);
    expect(report.scored).toBe(0);
    expect(report.unmapped.count).toBe(1);
    expect(report.unmapped.labels).toEqual([{ label: 'Treemap', n: 1 }]);
  });

  it('prints the cue-only reading beside it, so the delta has a control', () => {
    const inputs = [row('What percentage of revenue does each region contribute?', 'Bar Chart', regions(20))];
    const report = scoreProfile(inputs);
    const cue = scoreRule(inputs);
    const lines = describeProfile(report, cue);
    expect(lines.join('\n')).toContain('cue-only');
    expect(lines.join('\n')).toContain('+profile');
    // The control is the same rows: one question here, and the cue table answers it pie.
    expect(cue.scored).toBe(1);
    expect(lines.join('\n')).toContain('bar +1');
  });

  it('counts two rows of one family and one answer twice', () => {
    // The counters are keyed by `family -> answer`, and the second row of a pair is the case where
    // the key already exists: a reading whose increments only work for a new key would report one
    // answer for two rows and pass every per-label sum.
    const report = scoreProfile([
      row('Which region leads?', 'Bar Chart', regions(5)),
      row('Which region leads?', 'Bar Chart', regions(5)),
    ]);
    expect(report.top1).toBe(2);
    expect(report.confusion).toEqual([{ expected: 'bar', answered: 'bar', n: 2 }]);
  });

  it('counts two refusals of one family twice', () => {
    const report = scoreProfile([
      row('Which region leads?', 'Bar Chart', ''),
      row('Which region leads?', 'Bar Chart', ''),
    ]);
    expect(report.declined).toBe(2);
    expect(report.confusion).toEqual([{ expected: 'bar', answered: 'declined', n: 2 }]);
  });

  it('reports an empty corpus as an empty report rather than dividing by zero', () => {
    const report = scoreProfile([]);
    expect(report.scored).toBe(0);
    expect(report.top1Share).toBe(0);
    expect(report.baseline.mostFrequent).toBe('bar');
    expect(report.baseline.share).toBe(0);
    expect(() => assertProfileReport(report)).not.toThrow();
  });

  it('omits the delta line when the two readings agree', () => {
    // A profile that changes nothing is a fact, and the line that says so is silence rather than a
    // row of zeroes — the reader then knows the difference was not filtered away.
    const inputs = [row('What percentage of revenue does each region contribute?', 'Pie Chart', regions(5))];
    const report = scoreProfile(inputs);
    const cue = scoreRule(inputs);
    const lines = describeProfile(report, cue).join('\n');
    expect(lines).toContain('+profile');
    expect(lines).not.toContain('delta by family');
  });

  it('sums a family once, and subtracts the cue total once, not once per label', () => {
    // Two defects lived in this one line. `perLabel` is keyed by *label* and the line is titled by
    // *family*, so a family with eight labels printed eight times; and `cueOf` returns the whole
    // family's cue total, so subtracting it per label multiplied the negative side by the label count
    // — the real corpus read `line -864` where the honest number is a few dozen.
    //
    // Both rows are `bar` labels on a share question, which the cue table answers `pie`: profile 0 of
    // 2, cue 2 of 2, so the family's delta is exactly -2 and not -4.
    // Two pie labels over twenty categories: the cue table names the pie on both, and the profile
    // refuses it for having more slices than a reader can name, so the family loses two. (A line
    // fixture cannot carry this test any more: a line over a category axis is admitted now.)
    const inputs = [
      row('What percentage of revenue does each region contribute?', 'Pie Chart', regions(20)),
      row('What percentage of revenue does each region contribute?', 'Donut Chart', regions(20)),
    ];
    const lines = describeProfile(scoreProfile(inputs), scoreRule(inputs)).join('\n');
    const line = lines.split('\n').find((entry) => entry.includes('delta by family')) as string;
    // Two pie labels, cue right on both, profile wrong on both: -2, not -4.
    expect(line).toContain('pie -2');
    expect(line.match(/pie /g)?.length).toBe(1);
  });

  it('compares the two readings on the covering test they share, not on one each', () => {
    // An area question over a year column. The cue table names the line, and a line covers `area`
    // because an area chart is that line filled — so the cue reading counts this row a hit. This
    // report's `top1` is stricter and counts it a miss, which is correct for a published top-1 and
    // wrong for a delta: subtracting the two reads `area -58` on the real corpus, a difference
    // between two predicates printed as a difference between two instruments, and it made the area
    // family look like the worst result of the profile half for two rounds. The delta is taken on
    // the covering test the two share, so this row is a difference of zero and the line is silent.
    const years = 'Year, Revenue\n2019, 10\n2020, 14\n2021, 18\n2022, 26\n2023, 31';
    const inputs = [row('How has revenue changed over time?', 'Area Chart', years)];
    const report = scoreProfile(inputs);
    const cue = scoreRule(inputs);
    // The two readings disagree about the row and agree about the family.
    expect(cue.top1).toBe(1);
    expect(report.top1).toBe(0);
    expect(report.shortlist).toBe(1);
    expect(describeProfile(report, cue).join('\n')).not.toContain('delta by family');
  });

  it('prints a family the result set made worse with a minus', () => {
    // The delta line signs both directions, because the reading is not a sales document: a cue that
    // names the trend and a profile that then names a bar is a family this half *lost*, and a line
    // that only prints `+` would make the two halves of the table agree by construction.
    const inputs = [row('What percentage of revenue does each region contribute?', 'Pie Chart', regions(20))];
    const cue = scoreRule(inputs);
    const report = scoreProfile(inputs);
    expect(cue.top1).toBe(1);
    expect(report.top1).toBe(0);
    expect(describeProfile(report, cue).join('\n')).toContain('pie -1');
  });

  it('refuses more hits than shortlist hits', () => {
    const report = scoreProfile([row('Which region leads?', 'Bar Chart', regions(5))]);
    expect(() => assertProfileReport({ ...report, top1: report.shortlist + 1 })).toThrow(/more than/);
  });

  it('counts a named mark that misses the expected family as a miss, not as a row that vanished', () => {
    // The bucket this reading forgot, and the corpus found it: a question about the leading region
    // is answered `bar`, the label is `line`, and the row is neither a shortlist hit nor a refusal.
    // On Text2Vis that is the *largest* bucket — 684 of 1,470 rows — so a report that only carries
    // two of the three refused to publish at all, which is how the omission was caught.
    const report = scoreProfile([row('Which region leads?', 'Line Chart', regions(5))]);
    expect(report.scored).toBe(1);
    expect(report.shortlist).toBe(0);
    expect(report.declined).toBe(0);
    expect(report.missed).toBe(1);
    expect(report.confusion).toEqual([{ expected: 'line', answered: 'bar', n: 1 }]);
    expect(() => assertProfileReport(report)).not.toThrow();
  });

  it('prints the misses, because a bucket that is not printed is a bucket that can be forgotten', () => {
    const inputs = [row('Which region leads?', 'Line Chart', regions(5))];
    const lines = describeProfile(scoreProfile(inputs), scoreRule(inputs)).join('\n');
    expect(lines).toContain('missed 1');
  });

  it('refuses a report where a row fell out of the counters', () => {
    const report = scoreProfile([row('Which region leads?', 'Bar Chart', regions(5))]);
    expect(() => assertProfileReport({ ...report, top1: 0, shortlist: 0, declined: 0, missed: 0 })).toThrow(/fell out/);
  });

  it('refuses per-label rows that do not sum to the score', () => {
    const report = scoreProfile([row('Which region leads?', 'Bar Chart', regions(5))]);
    expect(() => assertProfileReport({ ...report, perLabel: [] })).toThrow(/sum to/);
  });

  it('refuses a report whose rows are not scored plus unmapped', () => {
    const report = scoreProfile([row('Which region leads?', 'Bar Chart', regions(5))]);
    expect(() => assertProfileReport({ ...report, rows: report.rows + 1 })).toThrow(/is not the/);
  });
});

describe('the command', () => {
  it('refuses an unknown argument by name', () => {
    expect(() => parseProfileArgs(['--artfacts', 'x'])).toThrow(/unknown argument/);
    expect(() => parseProfileArgs(['--artifact'])).toThrow(/needs a path/);
    expect(parseProfileArgs([])).toEqual({ json: false });
    expect(parseProfileArgs(['--json', '--artifact', 'a.json'])).toEqual({ json: true, artifact: 'a.json' });
  });

  it('scores a served corpus and writes both reports', async () => {
    const body = [
      HEADER,
      `What percentage of revenue does each region contribute?,,plt.pie([1]),Bar Chart,${cell(`${regions(20)}\n`)}`,
      `What percentage of revenue does each region contribute?,,plt.pie([1]),Pie Chart,${cell(`${regions(5)}\n`)}`,
      `Show the hierarchy of accounts,,plt.bar([1]),Treemap,${cell('Region, Revenue\nA, 1\n')}`,
    ].join('\n');
    const server = await serve(`${body}\n`);
    const artifact = join(root, 'out', 'text2vis-profile.json');
    const lines: string[] = [];
    try {
      const code = await entryProfile(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--artifact', artifact],
        load: { cacheDir: join(root, 'served'), url: server.url },
      });
      expect(code).toBe(0);
      const payload = JSON.parse(readFileSync(artifact, 'utf8')) as { cue: { scored: number }; profile: { scored: number; top1: number; unmapped: { count: number } } };
      expect(payload.profile.scored).toBe(2);
      expect(payload.profile.unmapped.count).toBe(1);
      // Bar over twenty categories and pie over five: both are the profile half's own claim.
      expect(payload.profile.top1).toBe(2);
      expect(payload.cue.scored).toBe(2);
      expect(lines.join('\n')).toContain('+profile');
    } finally {
      await server.close();
    }
  });

  it('takes no arguments at all, and reads the corpus it is given', async () => {
    // A dispatch that runs the command bare is the default in the workflow, and `argv` absent is a
    // state the harness must not turn into an exception: the argument list defaults, the artifact
    // stays unwritten, and the reading is still printed.
    const server = await serve(`${HEADER}\nWhich region leads?,,plt.bar([1]),Bar Chart,${cell(`${regions(5)}\n`)}\n`);
    const lines: string[] = [];
    try {
      const code = await entryProfile(ENTRY, MODULE_URL, (line) => lines.push(line), { load: { cacheDir: join(root, 'bare'), url: server.url } });
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('cue-only');
      expect(lines.join('\n')).not.toContain('wrote');
    } finally {
      await server.close();
    }
  });

  it('fails the run when nothing was scored, because a zero denominator is not a score', async () => {
    // Every row carries a label with no family, so the reading has no denominator. Returning 0 here
    // would put an empty table in the job summary and a green tick next to it.
    const server = await serve(`${HEADER}\nShow the hierarchy,,plt.bar([1]),Treemap,${cell('Region, Revenue\nA, 1\n')}\n`);
    const lines: string[] = [];
    try {
      const code = await entryProfile(ENTRY, MODULE_URL, (line) => lines.push(line), { load: { cacheDir: join(root, 'empty'), url: server.url } });
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('0 scored of 1 rows');
    } finally {
      await server.close();
    }
  });

  it('prints JSON when asked, and returns nothing when imported', async () => {
    const server = await serve(`${HEADER}\nWhich region leads?,,plt.bar([1]),Bar Chart,${cell(`${regions(5)}\n`)}\n`);
    const lines: string[] = [];
    try {
      const code = await entryProfile(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--json'],
        load: { cacheDir: join(root, 'json'), url: server.url },
      });
      expect(code).toBe(0);
      expect(lines.some((line) => line.startsWith('{'))).toBe(true);
      expect(await entryProfile(undefined, MODULE_URL, () => undefined)).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('reports a corpus it could not read as a failure, not a score', async () => {
    const server = await serve('not a corpus at all\n');
    const lines: string[] = [];
    try {
      const code = await entryProfile(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: [],
        load: { cacheDir: join(root, 'broken'), url: server.url },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('text2vis:');
    } finally {
      await server.close();
    }
  });

  it('hands the exit code to the process and answers for an empty corpus', () => {
    // A run that scored nothing is a run whose denominator is zero, and zero is not a score.
    const report = scoreProfile([{ prompt: '', label: 'Bar Chart', tableData: '' }]);
    expect(report.scored).toBe(1);
    expect(report.top1).toBe(0);
    expect(applyExitCode(undefined, { exitCode: 0 } as unknown as NodeJS.Process)).toBeUndefined();
  });
});

describe('the corpus rows this command reads', () => {
  it('takes the table the corpus ships, and leaves a row without one empty', () => {
    const inputs = profileInputs({
      rows: [
        { prompt: 'q', modelPrompt: '', answer: '', code: '', chartType: 'Bar Chart', raw: { 'Table Data': 'A, B\n1, 2' } },
        { prompt: 'q', modelPrompt: '', answer: '', code: '', chartType: 'Bar Chart', raw: {} },
      ],
    });
    expect(inputs[0]?.tableData).toBe('A, B\n1, 2');
    expect(inputs[1]?.tableData).toBe('');
  });
});
