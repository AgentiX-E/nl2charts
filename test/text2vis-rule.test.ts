/**
 * The chart rule arm, scored against a corpus that is served over a real socket.
 *
 * The score is a share, so the tests that matter are the ones that keep the denominator honest: an
 * unmapped label must leave the population rather than pass as a hit, a question the cue table says
 * nothing about must be counted as a miss, and the two constant baselines must be computed on the
 * same rows the rule was scored on. Each of those is a way to report a flattering number, and each
 * has a test below that fails if the number is computed any other way.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { TEXT2VIS_FIELDS } from '../eval/text2vis/dataset.js';
import {
  assertRuleReport,
  CUE_VARIANTS,
  cueAnswer,
  cueCrossings,
  cueMarks,
  cuePrecision,
  describeCrossings,
  describeCues,
  describeRule,
  describeSweep,
  entryRule,
  familiesOfMark,
  familyOfLabel,
  familyRows,
  parseRuleArgs,
  percentiles,
  ruleInputs,
  scoreRule,
  sweepRule,
  withHistogramCue,
  withCueAheadOf,
  withCueMoved,
  withMatrixBarFirst,
  withMatrixWide,
  withRankingBeforeShare,
  withShareByAnyCue,
  withShareRankedCue,
  withoutMatrix,
  type RuleReport,
  type VariantReading,
} from '../eval/text2vis/rule.js';

const root = mkdtempSync(join(tmpdir(), 'nl2charts-text2vis-rule-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const ENTRY = resolve('eval/text2vis/rule.ts');
const MODULE_URL = pathToFileURL(ENTRY).href;

async function serve(body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/csv' });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/Text2Vis.csv`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const HEADER = `${TEXT2VIS_FIELDS.prompt},${TEXT2VIS_FIELDS.answer},${TEXT2VIS_FIELDS.code},${TEXT2VIS_FIELDS.chartType}`;

describe('a label, as a family', () => {
  it('reads the corpus spellings of every family it knows', () => {
    expect(familyOfLabel('Bar Chart')).toBe('bar');
    expect(familyOfLabel('Column Chart')).toBe('bar');
    // The corpus's own spelling of a horizontal bar, found by the first real reading: 516 rows were
    // unmapped and this was the one label in that list which is unambiguously a bar.
    expect(familyOfLabel('Barh')).toBe('bar');
    expect(familyOfLabel('Line Chart')).toBe('line');
    expect(familyOfLabel('Pie Chart')).toBe('pie');
    expect(familyOfLabel('Donut Chart')).toBe('pie');
    expect(familyOfLabel('Scatter Plot')).toBe('scatter');
    expect(familyOfLabel('Bubble Chart')).toBe('scatter');
    expect(familyOfLabel('Area Chart')).toBe('area');
    expect(familyOfLabel('Histogram')).toBe('histogram');
    expect(familyOfLabel('Box Plot')).toBe('boxplot');
    expect(familyOfLabel('Heat Map')).toBe('heatmap');
    expect(familyOfLabel('Violin Plot')).toBe('violin');
  });

  it('is insensitive to case, spacing and underscores, which the file does not standardise', () => {
    expect(familyOfLabel('  BAR chart ')).toBe('bar');
    expect(familyOfLabel('heat_map')).toBe('heatmap');
    expect(familyOfLabel('BOX-PLOT')).toBe('boxplot');
  });

  it('reads the noun the label is about, not any word in it', () => {
    // `plot` is in both, and a table ordered wrongly would read either as a `plot`-shaped family
    // that does not exist. The order of the table is the assertion here.
    expect(familyOfLabel('Scatter Plot')).toBe('scatter');
    expect(familyOfLabel('Box Plot')).toBe('boxplot');
    expect(familyOfLabel('Violin Plot')).toBe('violin');
  });

  it('names the labels it dropped, and truncates the list only past a screenful', () => {
    // The corpus carries labels this build has never seen, and the log is where a reader finds out
    // which. A list cut at twelve without a mark reads as "twelve labels" when it is forty.
    const many = Array.from({ length: 14 }, (_, index) => ({ prompt: 'top 5 by revenue', label: `Shape${String(index)}` }));
    // One of the corpus's unmapped labels is the empty string -- a row whose authors left the column
    // blank -- and printing `labels: ` with nothing after it reads as a formatting bug rather than
    // as a row with no label.
    const report0 = scoreRule([...many, { prompt: 'top 5 by revenue', label: '' }]);
    expect(report0.unmapped.labels[0]).toEqual({ label: '', n: 1 });
    expect(describeRule(report0).join('\n')).toContain('<empty> (1)');
    const report = scoreRule(many);
    expect(report.unmapped.count).toBe(14);
    const text = describeRule(report).join('\n');
    expect(text).toContain(', ...');
    // Sorted, so the twelve kept are the first twelve by name and the rest are behind the mark.
    expect(text).toContain('Shape0');
    expect(text).not.toContain('Shape9,');
  });

  it('says it does not know a label rather than folding it into bar', () => {
    // The whole honesty of the score rests on this: a fallback would turn every label nobody
    // anticipated into a hit for whatever the rule happened to answer.
    expect(familyOfLabel('Treemap')).toBeUndefined();
    expect(familyOfLabel('Waterfall')).toBeUndefined();
    expect(familyOfLabel('')).toBeUndefined();
  });
});

describe('what a mark may answer for', () => {
  it('lets a line carry an area chart, because an area chart is that line filled', () => {
    expect(familiesOfMark('line')).toContain('area');
  });

  it('does not let a bar carry a histogram', () => {
    // A histogram is one measure binned; a bar is a category and a measure. Folding them together
    // would hide the finding the confusion table exists to surface: that this cue table never
    // recommends a histogram at all.
    expect(familiesOfMark('bar')).not.toContain('histogram');
    expect(familiesOfMark('pie')).toEqual(['pie']);
  });
});

describe('what the cue table answers', () => {
  it('leads with the first mark of the strongest cue, in the table order', () => {
    expect(cueMarks('what is the trend of revenue over time?')[0]).toBe('line');
    expect(cueMarks('show the share of orders by status')[0]).toBe('pie');
    expect(cueMarks('which product ranks highest by revenue')[0]).toBe('bar');
  });

  it('keeps every mark the question names, best first, without repeating one', () => {
    const marks = cueMarks('the share of revenue over time, by region');
    expect(marks[0]).toBe('line');
    expect(marks).toContain('pie');
    expect(new Set(marks).size).toBe(marks.length);
  });

  it('answers nothing when the question names no shape', () => {
    // A column lookup is not a chart decision, and inventing one is how a rule arm reports a share
    // about questions it had no opinion on.
    expect(cueMarks('what is the name of the customer')).toEqual([]);
  });
});

describe('scoring the rule against the corpus', () => {
  const input = (prompt: string, label: string): { prompt: string; label: string } => ({ prompt, label });

  it('counts a hit only when the leading mark carries the labelled family', () => {
    const report = scoreRule([
      input('show the share of orders by status', 'Pie Chart'),
      input('what is the trend of revenue over time', 'Line Chart'),
    ]);
    expect(report.top1).toBe(2);
    expect(report.top1Share).toBe(1);
    expect(report.scored).toBe(2);
  });

  it('counts a shortlist hit that is not a top-1 hit, so the two numbers stay distinguishable', () => {
    // A share question offers pie then bar; the label says bar. The rule can reach it, but not
    // first -- and a report that only has the shortlist would present that as a solved case.
    const report = scoreRule([input('show the share of orders by status', 'Bar Chart')]);
    expect(report.top1).toBe(0);
    expect(report.shortlist).toBe(1);
  });

  it('drops a label it cannot name, and publishes which ones it dropped', () => {
    const report = scoreRule([
      input('what is the trend of revenue over time', 'Line Chart'),
      input('show the hierarchy of accounts', 'Treemap'),
    ]);
    expect(report.rows).toBe(2);
    expect(report.scored).toBe(1);
    expect(report.unmapped).toEqual({ count: 1, labels: [{ label: 'Treemap', n: 1 }] });
    // The identity that makes the exclusion visible in one line rather than two tables apart.
    expect(report.rows).toBe(report.scored + report.unmapped.count);
  });

  it('counts a question with no cue as a miss rather than leaving it out', () => {
    const report = scoreRule([input('what is the name of the customer', 'Bar Chart')]);
    expect(report.declined).toBe(1);
    expect(report.scored).toBe(1);
    expect(report.top1).toBe(0);
  });

  it('computes both constant baselines on the same rows the rule was scored on', () => {
    // Three bars and one pie: always answering bar earns 75%, which is the number a cue table has
    // to beat. Computed over every row -- including the unmapped one -- it would be 60% and the
    // rule would look better than it is.
    const report = scoreRule([
      input('which product ranks highest by revenue', 'Bar Chart'),
      input('which product ranks lowest by revenue', 'Bar Chart'),
      input('top 5 customers by orders', 'Bar Chart'),
      input('how did revenue change month by month', 'Pie Chart'),
      input('show the hierarchy of accounts', 'Treemap'),
    ]);
    expect(report.scored).toBe(4);
    // Three bars of four scored rows. Over all five rows it would read 0.60 -- a baseline computed
    // on a population the rule was never scored on, which flatters the rule by construction.
    expect(report.baseline).toEqual({ mostFrequent: 'bar', share: 0.75, bar: 0.75 });
    // The cue table lands on three of four here, and the one it misses is a pie question whose
    // wording is a trend: a constant answer is not beaten by a cue table that misreads a question.
    expect(report.top1Share).toBeLessThanOrEqual(report.baseline.share);
    expect(report.top1).toBe(3);
  });

  it('breaks a tie between equally frequent families by name, so two runs agree', () => {
    const report = scoreRule([input('show the share of orders by status', 'Pie Chart'), input('trend over time', 'Line Chart')]);
    expect(report.baseline.mostFrequent).toBe('line');
    expect(report.baseline.share).toBe(0.5);
  });

  it('keeps the confusion table additive against the scored population', () => {
    const report = scoreRule([
      input('the share of revenue over time', 'Line Chart'),
      input('what is the name of the customer', 'Bar Chart'),
      input('which product ranks highest by revenue', 'Histogram'),
    ]);
    const cells = report.confusion.reduce((total, cell) => total + cell.n, 0);
    expect(cells + report.declined).toBe(report.scored);
    expect(report.confusion[0]?.n).toBeGreaterThan(0);
  });

  it('reports the cue path cost, which is the only cost this arm has', () => {
    // Injected clock so the arithmetic is checked rather than the machine: 1ms, 4ms, 8ms, 14ms.
    const ticks = [0, 1, 5, 9, 10, 18, 20, 34];
    let index = 0;
    const report = scoreRule(
      Array.from({ length: 4 }, (_, caseIndex) => input(`top ${String(caseIndex)} by revenue`, 'Bar Chart')),
      { clock: () => ticks[index++] as number },
    );
    expect(report.latency).toEqual({ p50: 4, p95: 14, max: 14 });
  });

  it('scores an empty corpus as zero rather than dividing by it', () => {
    const report = scoreRule([]);
    expect(report).toMatchObject({ rows: 0, scored: 0, top1Share: 0, shortlistShare: 0 });
    expect(report.baseline).toEqual({ mostFrequent: 'bar', share: 0, bar: 0 });
    expect(() => assertRuleReport(report)).not.toThrow();
  });
});

describe('the report that refuses to disagree with itself', () => {
  const good = (): RuleReport =>
    scoreRule([
      { prompt: 'which product ranks highest by revenue', label: 'Bar Chart' },
      { prompt: 'show the hierarchy of accounts', label: 'Treemap' },
    ]);

  it('accepts a report whose counters close', () => {
    expect(() => assertRuleReport(good())).not.toThrow();
  });

  it('refuses a per-label table that does not sum to the scored rows', () => {
    const report = good();
    expect(() => assertRuleReport({ ...report, scored: report.scored + 1 })).toThrow(/per-label rows sum to/);
  });

  it('refuses a confusion table that lost a case', () => {
    const report = good();
    // One cell removed: the remaining cells plus the declined count no longer account for the
    // population, which is what a dropped case looks like from the outside.
    expect(() => assertRuleReport({ ...report, confusion: [] })).toThrow(/confusion cells and the declined count/);
  });

  it('refuses a top-1 count larger than the shortlist it sits inside', () => {
    const report = good();
    expect(() => assertRuleReport({ ...report, top1: report.shortlist + 1 })).toThrow(/must be inside the shortlist/);
  });

  it('refuses a row count that does not split into scored and unmapped', () => {
    const report = good();
    expect(() => assertRuleReport({ ...report, rows: report.rows + 3 })).toThrow(/do not sum to it/);
  });
});

describe('percentiles by nearest rank', () => {
  it('reports a duration a question actually took', () => {
    // An interpolated p95 on four samples would be 3.85ms, a number no question cost. Nearest rank
    // is the only definition that is a measurement rather than an average of two measurements.
    expect(percentiles([4, 1, 3, 2])).toEqual({ p50: 2, p95: 4, max: 4 });
  });

  it('reports zero for an empty list rather than NaN', () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, max: 0 });
  });
});

describe('the command line', () => {
  it('reads --json and --artifact, and nothing else', () => {
    expect(parseRuleArgs([])).toEqual({ json: false });
    expect(parseRuleArgs(['--json'])).toEqual({ json: true });
    expect(parseRuleArgs(['--artifact', 'a.json', '--json'])).toEqual({ artifact: 'a.json', json: true });
  });

  it('refuses an artifact without a path, and a flag it does not use', () => {
    // Both are silent failures otherwise: `--artifact` with no value writes nothing, and a typo
    // succeeds while doing nothing at all.
    expect(() => parseRuleArgs(['--artifact'])).toThrow(/needs a path/);
    expect(() => parseRuleArgs(['--artifact', '--json'])).toThrow(/needs a path/);
    expect(() => parseRuleArgs(['--artfacts', 'a.json'])).toThrow(/unknown argument/);
  });
});

describe('the arm, run as a command', () => {
  it('scores a served corpus and writes the report it printed', async () => {
    const body = [
      HEADER,
      `Which city has the most orders?,Portland,"plt.bar([1],[2])",Bar Chart`,
      `How did revenue change month by month?,,"plt.plot([1],[2])",Line Chart`,
      `Show the hierarchy of accounts,,"plt.bar([1],[2])",Treemap`,
    ].join('\n');
    const server = await serve(`${body}\n`);
    const cacheDir = join(root, 'served');
    const artifact = join(root, 'out', 'text2vis-rule.json');
    const lines: string[] = [];
    try {
      const code = await entryRule(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--artifact', artifact],
        load: { cacheDir, url: server.url },
      });
      expect(code).toBe(0);
      const report = JSON.parse(readFileSync(artifact, 'utf8')) as RuleReport;
      expect(report.rows).toBe(3);
      expect(report.scored).toBe(2);
      expect(report.unmapped.labels).toEqual([{ label: 'Treemap', n: 1 }]);
      // The artifact is the same report the log described, not a second computation of it.
      expect(() => assertRuleReport(report)).not.toThrow();
      expect(lines.join('\n')).toContain('top-1');
    } finally {
      await server.close();
    }
  });

  it('prints JSON when asked, so a workflow can read it without a parser', async () => {
    const server = await serve(`${HEADER}\nTop 5 by revenue,,"plt.bar([1],[2])",Bar Chart\n`);
    const lines: string[] = [];
    try {
      const code = await entryRule(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--json'],
        load: { cacheDir: join(root, 'json'), url: server.url },
      });
      expect(code).toBe(0);
      const payload = lines.find((line) => line.startsWith('{'));
      expect(payload).toBeDefined();
      expect(JSON.parse(payload as string)).toMatchObject({ rows: 1, top1: 1 });
    } finally {
      await server.close();
    }
  });

  it('fails the run when no label could be read, rather than publishing 0%', async () => {
    // A corpus whose labels this build cannot name is a corpus it cannot score. Exiting 0 would
    // make an empty reading look like a measured zero.
    const server = await serve(`${HEADER}\nShow the hierarchy,,"plt.bar([1],[2])",Treemap\n`);
    const lines: string[] = [];
    try {
      const code = await entryRule(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: [],
        load: { cacheDir: join(root, 'none'), url: server.url },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('0 scored of 1 rows');
    } finally {
      await server.close();
    }
  });

  it('falls back to its own argv and to the corpus cache when it is given no options', async () => {
    // The two defaults the workflow depends on and no test had executed: `argv` becomes an empty
    // list and `load` becomes `{}`, which resolves the cache from `TEXT2VIS_CACHE`. The first version
    // of this test called it with no arguments *and* no cache, so it passed here on a warm directory
    // and downloaded the corpus in CI — a test whose verdict was the network's.
    const cacheDir = join(root, 'defaults');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'Text2Vis.csv'), `${HEADER}\nTop 5 by revenue,,"plt.bar([1],[2])",Bar Chart\n`);
    const previous = process.env.TEXT2VIS_CACHE;
    process.env.TEXT2VIS_CACHE = cacheDir;
    const lines: string[] = [];
    try {
      const code = await entryRule(ENTRY, MODULE_URL, (line) => lines.push(line));
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('1 scored of 1 rows');
    } finally {
      if (previous === undefined) delete process.env.TEXT2VIS_CACHE;
      else process.env.TEXT2VIS_CACHE = previous;
    }
  });

  it('returns nothing when it is imported rather than run', async () => {
    // Every test in this file imports the module, so this is the branch that keeps them from
    // setting an exit code on the test process.
    expect(await entryRule(undefined, MODULE_URL, () => undefined)).toBeUndefined();
    expect(await entryRule(resolve('eval/text2vis/dataset.ts'), MODULE_URL, () => undefined)).toBeUndefined();
  });

  it('names a transport that failed without an Error, rather than throwing at the caller', async () => {
    // A rejected promise carrying a string is what a hand-written transport does when it gives up,
    // and the CLI has to turn it into a line and an exit code like any other failure.
    const lines: string[] = [];
    const code = await entryRule(ENTRY, MODULE_URL, (line) => lines.push(line), {
      argv: [],
      load: {
        cacheDir: join(root, 'string-throw'),
        fetchImpl: (() => Promise.reject('gateway said no')) as unknown as typeof fetch,
      },
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('gateway said no');
  });

  it('reports a corpus it could not read as a download, not as a score', async () => {
    const lines: string[] = [];
    const code = await entryRule(ENTRY, MODULE_URL, (line) => lines.push(line), {
      argv: ['--artfacts', 'x'],
      load: { cacheDir: join(root, 'bad') },
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('unknown argument');
  });
});

describe('reading the corpus into rows', () => {
  it('takes the question from the raw field the file uses', () => {
    const inputs = ruleInputs({
      rows: [
        {
          prompt: 'Which city has the most orders?',
          answer: 'Portland',
          code: '',
          chartType: 'Bar Chart',
          raw: { [TEXT2VIS_FIELDS.prompt]: 'Which city has the most orders?', [TEXT2VIS_FIELDS.chartType]: 'Bar Chart' },
        },
      ],
    });
    expect(inputs).toEqual([{ prompt: 'Which city has the most orders?', label: 'Bar Chart' }]);
  });
});

describe('the lines a reader gets', () => {
  it('puts the score, both baselines and the cost in one block, and names the unmapped labels', () => {
    const report = scoreRule([
      { prompt: 'which product ranks highest by revenue', label: 'Bar Chart' },
      { prompt: 'show the hierarchy of accounts', label: 'Treemap' },
    ]);
    const text = describeRule(report).join('\n');
    expect(text).toContain('1 scored of 2 rows');
    expect(text).toContain('top-1');
    expect(text).toContain('baseline: always bar');
    expect(text).toContain('cue path');
    expect(text).toContain('unmapped labels: Treemap (1)');
  });
});

describe('the cue that named a mark', () => {
  it('travels with the mark, because one family claim depends on it', () => {
    // The word "histogram" fires two cues in the shipped table's order: `distribution` (which names
    // boxplot first) and nothing else, so a bar cannot appear at all. The variant inserts its cue
    // ahead of `distribution`, and the answer says which cue put the bar there.
    const shipped = cueAnswer('show a histogram of order totals');
    expect(shipped[0]).toEqual({ mark: 'boxplot', cue: 'distribution' });
    const swept = cueAnswer('show a histogram of order totals', withHistogramCue(CUE_VARIANTS[0]!.cues));
    expect(swept[0]).toEqual({ mark: 'bar', cue: 'histogram' });
    // The boxplot is still offered, one place down: the change is an order and not a deletion.
    expect(swept.map((answer) => answer.mark)).toEqual(['bar', 'boxplot']);
  });

  it('keeps the first cue that named a mark rather than the last', () => {
    // `trend` names line then bar, `ranking` names bar. A bar is named twice and the answer has to
    // be one cue, so it is the strongest one — the table's order, read once.
    const answers = cueAnswer('the trend of revenue by month, top 5 highest');
    const bar = answers.find((answer) => answer.mark === 'bar');
    expect(bar).toEqual({ mark: 'bar', cue: 'trend' });
    expect(cueMarks('the trend of revenue by month, top 5 highest')).toEqual(['line', 'bar']);
  });

  it('reads the table it is given, so a variant is a table and not a fork', () => {
    const reversed = [...CUE_VARIANTS[0]!.cues].reverse();
    // A question that fires `trend` and `share` leads with the cue the table lists first, so
    // reversing the table reverses the answer. This is the assertion that the parameter is live:
    // the marks inside a cue are untouched, and only their order in the table moved.
    expect(cueMarks('the share of revenue over time')[0]).toBe('line');
    expect(cueMarks('the share of revenue over time', reversed)[0]).toBe('pie');
    expect(cueMarks('the candlestick of open and close prices')).toEqual(['candlestick', 'line']);
  });
});

describe('a bar that answers for a histogram, when the table said so', () => {
  it('widens only under the histogram cue', () => {
    // One claim, stated once: a histogram is a bar with the measure binned. It is conditional
    // because a bar recommended for a ranking question is a ranking bar, and crediting it for a
    // histogram label would be the table grading itself.
    expect(familiesOfMark('bar', 'histogram')).toEqual(['bar', 'histogram']);
    expect(familiesOfMark('bar')).toEqual(['bar']);
    expect(familiesOfMark('bar', 'ranking')).toEqual(['bar']);
    expect(familiesOfMark('boxplot', 'histogram')).toEqual(['boxplot']);
  });

  it('scores a histogram question as a hit only in the table that names the intent', () => {
    const rows = [{ prompt: 'draw a histogram of order totals', label: 'Histogram' }];
    const shipped = scoreRule(rows);
    expect(shipped.top1).toBe(0);
    const named = scoreRule(rows, { cues: withHistogramCue(CUE_VARIANTS[0]!.cues), variant: 'histogram' });
    expect(named.top1).toBe(1);
    // Not even the shortlist reaches the label in the shipped table, and that is the honest reading
    // of a scoped claim: a bar is only a histogram when a cue said so, so a `distribution` cue that
    // happens to offer a bar second does not credit it.
    expect(shipped.shortlist).toBe(0);
    expect(named.variant).toBe('histogram');
  });
});

describe('the table a variant constructs', () => {
  it('inserts the histogram cue ahead of distribution, and only once', () => {
    const table = withHistogramCue(CUE_VARIANTS[0]!.cues);
    const kinds = table.map((rule) => rule.kind);
    expect(kinds.indexOf('histogram')).toBe(kinds.indexOf('distribution') - 1);
    expect(kinds.filter((kind) => kind === 'histogram')).toHaveLength(1);
    // Nothing else moved: the same cues, one more of them.
    expect(table.length).toBe(CUE_VARIANTS[0]!.cues.length + 1);
  });

  it('appends the cue to a table that has no distribution rule rather than dropping it', () => {
    // A variant that silently lost a cue would be measured as if it had it; the guard is that the
    // cue is always present, whatever the table it was built from.
    const without = CUE_VARIANTS[0]!.cues.filter((rule) => rule.kind !== 'distribution');
    const table = withHistogramCue(without);
    expect(table.at(-1)?.kind).toBe('histogram');
    expect(table.length).toBe(without.length + 1);
  });

  it('states one lever per variant, and the first is the table the package exports', () => {
    expect(CUE_VARIANTS[0]).toMatchObject({ name: 'shipped' });
    expect(CUE_VARIANTS.map((variant) => variant.name)).toEqual([
      'shipped',
      'matrix-wide',
      'matrix-bar-first',
      'matrix-wide+bar-first',
      'no-matrix',
      'bar-share',
      'share-by-any',
      'histogram',
      'share-by-any+histogram',
      'ranking-before-share',
      'share-ranked',
    ]);
    for (const variant of CUE_VARIANTS) expect(variant.note.length).toBeGreaterThan(20);
  });
});

describe('the distinction inside one cue, now that it shipped', () => {
  const shipped = CUE_VARIANTS[0]!.cues;
  const wide = withShareByAnyCue(shipped);

  it('answers an adjacent comparison with a bar and a part of a whole with a pie', () => {
    // The signal is a phrase about what the reader is asked to do: "share by" names the dimension to
    // compare across, "share of" names a denominator. The product answered both with a pie until the
    // narrow cue was priced (+10 bar rows for −5 pie rows) and shipped.
    expect(cueAnswer('breakdown by region')).toEqual([
      { mark: 'bar', cue: 'share-by' },
      { mark: 'pie', cue: 'share' },
    ]);
    expect(cueAnswer('the share of revenue that is refunds')[0]).toEqual({ mark: 'pie', cue: 'share' });
    // The `share` cue's own marks are untouched: what changed is which cue fires first.
    expect(shipped.find((rule) => rule.kind === 'share')?.marks).toEqual(['pie', 'bar']);
  });

  it('reads the phrase and not the thought, which is the width that was refused', () => {
    // "The share of revenue by region" puts four words between the two the narrow cue needs, and the
    // wide width that reads it anyway was priced at bar +186 / pie −142 — the blunt "a share is a
    // bar" rule wearing a phrase. It stays in the sweep so the refusal stays a reading.
    const question = 'show the share of revenue by region';
    expect(cueAnswer(question)[0]).toEqual({ mark: 'pie', cue: 'share' });
    expect(cueAnswer(question, wide)[0]).toEqual({ mark: 'bar', cue: 'share-by-any' });
    expect(cueMarks(question, wide)).toEqual(['bar', 'pie']);
  });

  it('reads five spellings of the same comparison and no spelling of a part', () => {
    for (const question of ['percentage by status', 'breakdown across regions', 'split per segment', 'proportion by country', 'composition by category']) {
      expect(cueMarks(question)[0]).toBe('bar');
      expect(cueMarks(question, wide)[0]).toBe('bar');
    }
    for (const question of ['the proportion of orders that were refunded', 'percentage of total revenue', 'the composition of the customer base']) {
      expect(cueMarks(question)[0]).toBe('pie');
      expect(cueMarks(question, wide)[0]).toBe('pie');
    }
  });

  it('leaves a question neither cue matches exactly as the table answered it before', () => {
    // The claim is a delta on one phrase. For the shipped rule that means: the questions the narrow
    // cue does not match must read exactly as `share` alone would read them.
    const without = shipped.filter((rule) => rule.kind !== 'share-by');
    for (const question of ['the share of revenue that is refunds', 'the trend of revenue over time', 'top 10 customers']) {
      expect(cueMarks(question)).toEqual(cueMarks(question, without));
    }
  });

  it('sits ahead of share, once, and the wide width is the same mechanism', () => {
    const kinds = shipped.map((rule) => rule.kind);
    expect(kinds.filter((kind) => kind === 'share-by')).toHaveLength(1);
    expect(kinds.indexOf('share-by')).toBe(kinds.indexOf('share') - 1);
    const widened = wide.map((rule) => rule.kind);
    expect(widened.filter((kind) => kind === 'share-by-any')).toHaveLength(1);
    expect(widened.indexOf('share-by-any')).toBe(widened.indexOf('share') - 1);
    expect(wide.length).toBe(shipped.length + 1);
  });

  it('places a cue ahead of another, and appends it when the table has no such cue', () => {
    // Every insertion in this file — shipped and priced — is one mechanism, written once so a fourth
    // lever cannot quietly implement "appended" instead of "ahead".
    const marker = { kind: 'ranking' as const, marks: ['bar' as const], pattern: /x/ };
    const inserted = withCueAheadOf(shipped, marker, 'distribution');
    expect(inserted.map((rule) => rule.kind).indexOf('ranking')).toBe(
      inserted.map((rule) => rule.kind).indexOf('distribution') - 1,
    );
    // `histogram` is not in the shipped table, so a cue placed before it lands at the end: the
    // fallback is "somewhere it is present", never "dropped".
    expect(withCueAheadOf(shipped, marker, 'histogram').at(-1)?.kind).toBe('ranking');
    const kinds = withHistogramCue(shipped).map((rule) => rule.kind);
    expect(kinds.indexOf('histogram')).toBe(kinds.indexOf('distribution') - 1);
  });

  it('keeps the refused widths and drops the one that shipped', () => {
    const names = CUE_VARIANTS.map((variant) => variant.name);
    for (const name of ['share-by-any', 'share-by-any+histogram', 'bar-share']) expect(names).toContain(name);
    // A candidate for a rule the product already has is a second copy of the control, so the shipped
    // lever is not a variant: the sweep's control *is* the narrow cue now.
    for (const name of ['share-by', 'share-by+histogram', 'matrix-window', 'matrix-window+share-by']) {
      expect(names).not.toContain(name);
    }
    expect(CUE_VARIANTS.find((variant) => variant.name === 'share-by-any+histogram')?.cues).toEqual(
      withHistogramCue(withShareByAnyCue(shipped)),
    );
  });
});

describe('the sweep: every table, the same rows', () => {
  const rows = [
    { prompt: 'show the share of orders by status', label: 'Pie Chart' },
    { prompt: 'show the share of revenue by region', label: 'Bar Chart' },
    { prompt: 'draw a histogram of order totals', label: 'Histogram' },
    { prompt: 'what is the trend of revenue over time', label: 'Line Chart' },
    { prompt: 'show the hierarchy of accounts', label: 'Treemap' },
  ];

  it('prices every table on the same population, control first', () => {
    const report = sweepRule(rows);
    expect(report.sweep.map((reading) => reading.variant)).toEqual(CUE_VARIANTS.map((variant) => variant.name));
    expect(report.sweep.every((reading) => reading.scored === report.scored)).toBe(true);
    expect(report.sweep[0]?.top1).toBe(report.top1);
    expect(() => assertRuleReport(report)).not.toThrow();
  });

  it('publishes the per-family rows a change has to move and the one it must not', () => {
    const report = sweepRule(rows);
    const shipped = report.sweep[0];
    // By name, not by index: the sweep is a list of alternatives and its order is not a fact about
    // the corpus, so a test that reads `sweep[1]` asserts something only this file controls.
    const barShare = report.sweep.find((reading) => reading.variant === 'bar-share');
    // The bar-first share table trades one pie row for one bar row on this corpus, and the pie row
    // it loses is printed rather than absorbed into a single top-1 number.
    expect(barShare?.byFamily.find((cell) => cell.family === 'bar')?.top1).toBe(
      (shipped?.byFamily.find((cell) => cell.family === 'bar')?.top1 ?? 0) + 1,
    );
    expect(barShare?.byFamily.find((cell) => cell.family === 'pie')?.top1).toBe(0);
    // The histogram table moves its own label and leaves the other four where they were.
    const histogram = report.sweep.find((reading) => reading.variant === 'histogram');
    expect(histogram?.byFamily.find((cell) => cell.family === 'histogram')?.top1).toBe(1);
    expect(histogram?.byFamily.find((cell) => cell.family === 'line')?.top1).toBe(
      shipped?.byFamily.find((cell) => cell.family === 'line')?.top1,
    );
  });

  it('counts a family from the per-label rows rather than from a second pass', () => {
    const report = scoreRule(rows);
    const family = familyRows(report);
    expect(family.reduce((total, cell) => total + cell.n, 0)).toBe(report.scored);
    expect(family[0]?.n).toBeGreaterThanOrEqual(family[1]?.n ?? 0);
    expect(family.map((cell) => cell.family)).toContain('histogram');
  });

  it('reads a variant that declines more rows against its own declined count', () => {
    // The one number a cue change moves without moving `scored`: removing a cue declines every
    // question that cue was the only answer to. Checking a variant's lead counts against the
    // shipped table's declined count refused a legal reading of 1,260 leads against 1,470 rows on
    // the first real corpus, so both directions are pinned here.
    const report = sweepRule([{ prompt: 'average revenue by region and channel', label: 'Heatmap' }]);
    const removed = report.sweep.find((reading) => reading.variant === 'no-matrix') as VariantReading;
    expect(report.declined).toBe(0);
    expect(removed.declined).toBe(1);
    expect(removed.cues).toEqual([]);
    expect(() => assertRuleReport(report)).not.toThrow();
    // And the reading the assertion refuses: the shipped table's declined count used to check a
    // variant that declined one row more, so the row it declined is counted as answered by nobody.
    expect(() => assertRuleReport({ ...report, sweep: [{ ...removed, declined: 0 }] })).toThrow(/per-cue leads sum to/);
  });

  it('prints one line per table and nothing when there is no sweep', () => {
    const report = sweepRule(rows);
    const lines = describeSweep(report);
    expect(lines).toHaveLength(CUE_VARIANTS.length + 1);
    expect(lines[0]).toContain(`${String(CUE_VARIANTS.length)} tables over the same ${String(report.scored)} rows`);
    expect(lines[1]).toContain('shipped');
    // Read by name rather than by position: which alternative sits second is this file's order and
    // not a fact about the corpus.
    expect(lines.find((line) => line.trimStart().startsWith('bar-share'))).toContain('bar +');
    // A report that priced one table says nothing about a sweep instead of claiming an empty one.
    expect(describeSweep(scoreRule(rows))).toEqual([]);
  });

  it('refuses a reading whose population is not the one the report scored', () => {
    const report = sweepRule(rows);
    const first = report.sweep[0] as VariantReading;
    expect(() => assertRuleReport({ ...report, sweep: [{ ...first, scored: first.scored + 1 }] })).toThrow(/not the same population/);
    expect(() => assertRuleReport({ ...report, sweep: [{ ...first, byFamily: [] }] })).toThrow(/per-family rows summing to/);
    expect(() => assertRuleReport({ ...report, sweep: [{ ...first, top1: first.shortlist + 1 }] })).toThrow(/above its shortlist/);
  });

  it('prints a table with no bar row as a zero rather than crashing on the share', () => {
    // A variant that never answers bar is a legal table, and the line has to divide something.
    const report = sweepRule(rows);
    const first = report.sweep[0] as VariantReading;
    const lines = describeSweep({ ...report, sweep: [{ ...first, byFamily: [{ family: 'line', n: 3, top1: 2 }] }] });
    expect(lines[1]).toContain('bar 0.00%');
  });

  it('prints a bar family with no rows as a zero share instead of dividing by it', () => {
    const report = sweepRule(rows);
    const first = report.sweep[0] as VariantReading;
    const lines = describeSweep({ ...report, sweep: [{ ...first, byFamily: [{ family: 'bar', n: 0, top1: 0 }] }] });
    expect(lines[1]).toContain('bar 0.00%');
  });

  it('reads a family the control never had as zero rather than as a missing cell', () => {
    // A variant that adds a cue can make a family appear that the control has no row for. The delta
    // is then measured from zero, which is the only reading that does not silently drop the gain.
    const report = sweepRule(rows);
    const first = report.sweep[0] as VariantReading;
    const lines = describeSweep({
      ...report,
      sweep: [
        { ...first, byFamily: [{ family: 'line', n: 3, top1: 2 }] },
        { ...first, variant: 'with-histogram', byFamily: [{ family: 'line', n: 3, top1: 2 }, { family: 'histogram', n: 1, top1: 1 }] },
      ],
    });
    expect(lines[2]).toContain('histogram +1');
  });

  it('names the variant on the report it produced, so an artifact says which table it read', () => {
    expect(scoreRule(rows).variant).toBe('shipped');
    expect(scoreRule(rows, { cues: CUE_VARIANTS[1]!.cues, variant: 'bar-share' }).variant).toBe('bar-share');
    expect(scoreRule(rows).sweep).toEqual([]);
  });
});

describe('which cue is wrong, read cue by cue', () => {
  const rows = [
    // `share` leads both of these and is right about one of them: the second is a comparison the
    // corpus drew as a bar, and the cue puts a pie first with the bar still on its list.
    { prompt: 'the share of revenue that is refunds', label: 'Pie Chart' },
    { prompt: 'the share of orders by status', label: 'Bar Chart' },
    { prompt: 'revenue over time', label: 'Line Chart' },
    { prompt: 'average revenue by region and channel', label: 'Heatmap' },
    // Unmapped and cue-less rows, which no cue may be scored on.
    { prompt: 'show the hierarchy of accounts', label: 'Treemap' },
    { prompt: 'how many orders were placed', label: 'Bar Chart' },
  ];

  it('scores a cue on the rows it decided first, and separates the two ways it can be wrong', () => {
    const share = cuePrecision(rows).find((cue) => cue.kind === 'share');
    expect(share).toMatchObject({ first: 'pie', leads: 2, hits: 1, inside: 2 });
    expect(share?.precision).toBe(0.5);
    // `inside` covers both, because the bar is the cue's second mark: the loss is an order and not a
    // phrase, and the two columns are what tell a reader which file to open.
    expect(share?.coverage).toBe(1);
  });

  it('never scores a cue on a question it did not fire on, or on a label with no family', () => {
    const readings = cuePrecision(rows);
    // Six rows: one unmapped and one with no cue at all, so four are decidable — two `share`, one
    // `trend`, one `matrix`.
    expect(readings.reduce((total, cue) => total + cue.leads, 0)).toBe(4);
    expect(readings.map((cue) => cue.kind)).toEqual(['share', 'matrix', 'trend']);
  });

  it('orders the cues by the rows they decided, so the repair list is in reading order', () => {
    const readings = cuePrecision(rows);
    const leads = readings.map((cue) => cue.leads);
    expect(leads).toEqual([...leads].sort((left, right) => right - left));
    // `share` decided half the population and leads the list; a table sorted by precision would put
    // the cue that fired twice on top for being right both times.
    expect(readings[0]?.kind).toBe('share');
    // The two cues that decided one row each are ordered by name, not by insertion: a tie broken by
    // the order the rules happen to sit in the table is a reading that moves when the table does.
    expect(leads.slice(1)).toEqual([1, 1]);
  });

  it('reports a cue that speaks for nothing this layer recommends, rather than dropping it', () => {
    // A cue naming only `sankey` is a cue the recommender cannot answer with, and it is still a
    // finding: silence would read as "this cue never fired".
    const table = [{ kind: 'matrix' as const, marks: ['sankey' as const], pattern: /\bflow\b/ }];
    const readings = cuePrecision([{ prompt: 'the flow between accounts', label: 'Heatmap' }], table);
    expect(readings).toEqual([{ kind: 'matrix', first: undefined, leads: 1, hits: 0, inside: 0, precision: 0, coverage: 0 }]);
  });

  it('carries the per-cue reading on the report the artifact keeps', () => {
    const report = scoreRule(rows);
    expect(report.cues.length).toBeGreaterThan(0);
    expect(report.cues).toEqual(cuePrecision(rows));
    // And on every variant, because a candidate's question is whether the cue it changed improved.
    expect(report.sweep).toEqual([]);
    expect(sweepRule(rows).sweep.every((reading) => reading.cues.length > 0)).toBe(true);
  });

  it('refuses a reading whose per-cue leads do not partition the answered rows', () => {
    const report = scoreRule(rows);
    const first = report.cues[0]!;
    expect(() => assertRuleReport({ ...report, cues: [{ ...first, leads: first.leads + 1 }] })).toThrow(/per-cue leads sum to/);
    // A one-cue population, so the partition identity holds and the ordering identity is what fails.
    const single = scoreRule([
      { prompt: 'revenue over time', label: 'Line Chart' },
      { prompt: 'how many orders were placed', label: 'Bar Chart' },
    ]);
    expect(single.cues).toHaveLength(1);
    const cue = single.cues[0]!;
    expect(() => assertRuleReport({ ...single, cues: [{ ...cue, inside: cue.leads + 1 }] })).toThrow(/leads$/);
    expect(() => assertRuleReport({ ...single, cues: [{ ...cue, hits: cue.inside + 1 }] })).toThrow(/hits inside/);
  });

  it('prints one line per cue, and nothing when there is none', () => {
    const lines = describeCues(cuePrecision(rows));
    expect(lines[0]).toContain('cue precision');
    expect(lines).toHaveLength(1 + cuePrecision(rows).length);
    expect(lines[1]).toContain('share');
    // A cue that speaks for no mark this layer recommends still gets a line, and the line says so
    // rather than leaving the column blank.
    const silent = cuePrecision(
      [{ prompt: 'the flow between accounts', label: 'Heatmap' }],
      [{ kind: 'matrix', marks: ['sankey'], pattern: /\bflow\b/ }],
    );
    expect(describeCues(silent)[1]).toContain('first none');
    expect(describeCues([])).toEqual([]);
  });
});

describe('the width of the matrix cue, now that it shipped', () => {
  const shipped = CUE_VARIANTS[0]!.cues;
  const wide = withMatrixWide(shipped);

  it('reads a crossing stated in one clause and not one across a full stop', () => {
    // The retired pattern was `\bby\b[\s\S]*\band\b`: unbounded in both directions, so a question
    // carrying "by" and, three sentences later, "and" led with a heatmap — 223 questions decided, one
    // of them right. The shipped pattern is the same two words with a bound on the distance.
    const across = 'average revenue by region. plot it and label the axes';
    expect(cueMarks(across)).toEqual([]);
    expect(cueMarks(across, wide)).toEqual(['heatmap', 'bar']);
    // And the phrase the cue was reached for still fires, measure in between and all.
    for (const question of ['average revenue by region and channel', 'revenue by region and by channel', 'the share of revenue by region and the count of orders']) {
      expect(cueMarks(question)).toContain('heatmap');
    }
  });

  it('keeps the retired width priced, because the rows it lost are only attributable while it runs', () => {
    expect(wide.length).toBe(shipped.length);
    expect(wide.map((rule) => rule.kind)).toEqual(shipped.map((rule) => rule.kind));
    expect(wide.find((rule) => rule.kind === 'matrix')?.marks).toEqual(shipped.find((rule) => rule.kind === 'matrix')?.marks);
    expect(wide.find((rule) => rule.kind === 'matrix')?.pattern).not.toBe(shipped.find((rule) => rule.kind === 'matrix')?.pattern);
    expect(CUE_VARIANTS.find((variant) => variant.name === 'matrix-wide')?.cues).toEqual(wide);
  });

  it('prices the removal beside the width, so a rewrite has a floor to clear', () => {
    const without = withoutMatrix(shipped);
    expect(without).toHaveLength(shipped.length - 1);
    expect(without.some((rule) => rule.kind === 'matrix')).toBe(false);
    expect(cueMarks('average revenue by region and channel', without)).toEqual([]);
    expect(CUE_VARIANTS.find((variant) => variant.name === 'no-matrix')?.cues).toEqual(without);
  });
});

describe('the delta a sweep prints', () => {
  const rows = [
    { prompt: 'the share of orders by status', label: 'Bar Chart' },
    { prompt: 'the share of revenue that is refunds', label: 'Pie Chart' },
    { prompt: 'revenue over time', label: 'Line Chart' },
    // No shipped cue reads this one, so the control declines it and the table that adds the
    // histogram cue answers it: the only shape in which a variant declines *fewer* rows.
    { prompt: 'show the binned counts of order totals', label: 'Histogram' },
    // And one only `matrix` answers, which is the shape in which removing that cue declines more.
    { prompt: 'average revenue by region and channel', label: 'Heatmap' },
  ];

  const reading = (report: RuleReport): VariantReading => ({
    variant: report.variant,
    note: 'built by the test',
    scored: report.scored,
    top1: report.top1,
    top1Share: report.top1Share,
    shortlist: report.shortlist,
    shortlistShare: report.shortlistShare,
    declined: report.declined,
    byFamily: familyRows(report),
    cues: report.cues,
  });

  const barFirst = CUE_VARIANTS[1]!.cues;
  const shipped = scoreRule(rows);
  const flipped = scoreRule(rows, { cues: barFirst, variant: 'bar-share' });
  const histogram = scoreRule(rows, { cues: withHistogramCue(CUE_VARIANTS[0]!.cues), variant: 'histogram' });
  const removed = scoreRule(rows, { cues: withoutMatrix(CUE_VARIANTS[0]!.cues), variant: 'no-matrix' });

  it('measures every table against the control and not against the line above it', () => {
    const lines = describeSweep({ ...shipped, sweep: [reading(shipped), reading(flipped), reading(histogram)] });
    expect(lines[0]).toContain('against shipped');
    // `histogram` follows `bar-share` in this order and still reports its delta against `shipped`:
    // the pie row it restores is +0 against the control and −1 against the line above it.
    expect(lines[3]).not.toContain('pie');
  });

  it('reports the same delta for a table wherever it is listed', () => {
    // The defect this closes: a delta against the previous row is a fact about the list, so moving
    // one variant changes the published number while no cue table changed at all.
    const forward = describeSweep({ ...shipped, sweep: [reading(shipped), reading(flipped), reading(histogram)] });
    const backward = describeSweep({ ...shipped, sweep: [reading(shipped), reading(histogram), reading(flipped)] });
    const deltaOf = (lines: readonly string[], variant: string): string =>
      (lines.find((line) => line.trimStart().startsWith(variant)) ?? '').split('|')[1]?.trim() ?? '';
    expect(deltaOf(forward, 'bar-share')).toBe(deltaOf(backward, 'bar-share'));
    expect(deltaOf(forward, 'histogram')).toBe(deltaOf(backward, 'histogram'));
    expect(deltaOf(forward, 'shipped')).toBe('');
  });

  it('prints the declined count only when a table moved it, with the sign it moved', () => {
    // A cue removal declines what the control answered and a cue addition answers what the control
    // declined. Both are one number apart from the control and neither is a share of it, so the line
    // carries the count and the direction rather than leaving the reader to subtract.
    const lines = describeSweep({ ...shipped, sweep: [reading(shipped), reading(histogram), reading(removed)] });
    expect(lines[2]).toContain('declined 0 (-1)');
    expect(lines[3]).toContain('declined 2 (+1)');
    // The control's own line says nothing about it, because there is nothing to compare it to.
    expect(lines[1]).not.toContain('declined');
  });
});

describe('the order of the matrix marks', () => {
  const shipped = CUE_VARIANTS[0]!.cues;
  const reversed = withMatrixBarFirst(shipped);

  it('leads a crossing with the bar the corpus draws for it, and keeps the heatmap beside it', () => {
    // `matrix` decided 223 questions and was right about one: the label is a bar 49 times to a
    // heatmap's 6, and the cue puts the heatmap first. The reversal is a re-membership, not a phrase
    // change, so the cue still speaks for both marks and can still be answered by either.
    const question = 'average revenue by region and channel';
    expect(cueMarks(question)).toEqual(['heatmap', 'bar']);
    expect(cueMarks(question, reversed)).toEqual(['bar', 'heatmap']);
    expect(reversed.find((rule) => rule.kind === 'matrix')?.pattern).toBe(
      shipped.find((rule) => rule.kind === 'matrix')?.pattern,
    );
  });

  it('changes nothing but the order of that one cue', () => {
    const before = shipped.find((rule) => rule.kind === 'matrix');
    const after = reversed.find((rule) => rule.kind === 'matrix');
    expect(after?.marks).toEqual(['bar', 'heatmap']);
    expect(before?.marks).toEqual(['heatmap', 'bar']);
    expect(reversed.map((rule) => rule.kind)).toEqual(shipped.map((rule) => rule.kind));
    // A question the cue does not fire on is answered exactly as before.
    expect(cueMarks('revenue over time', reversed)).toEqual(cueMarks('revenue over time'));
  });

  it('is priced alone and on the retired width, which is where it scored best and lost most', () => {
    expect(CUE_VARIANTS.find((variant) => variant.name === 'matrix-bar-first')?.cues).toEqual(reversed);
    expect(CUE_VARIANTS.find((variant) => variant.name === 'matrix-wide+bar-first')?.cues).toEqual(
      withMatrixBarFirst(withMatrixWide(shipped)),
    );
  });
});

describe('the companion a cue keeps when it got the family right and the order wrong', () => {
  // The 187 rows behind this reading are the second kind of loss: `share` led, the label was a bar,
  // and the bar was on the cue's own list in second place. A reorder is the repair, and which order
  // is the repair depends on what else the question said — which is a fact about the *broken* rows
  // and not about the cue table. These rows put one companion in the broken half and none in the
  // right half, so the reading has a direction rather than a distribution.
  const rows = [
    { prompt: 'top 5 categories by share of revenue', label: 'Bar Chart' },
    { prompt: 'the share of revenue that is refunds', label: 'Pie Chart' },
    { prompt: 'the top 3 regions by revenue', label: 'Bar Chart' },
    { prompt: 'revenue over time', label: 'Line Chart' },
  ];

  it('names the cue that fired beside it, counted only over the rows it got wrong', () => {
    const crossings = cueCrossings(rows);
    const share = crossings.find((crossing) => crossing.kind === 'share');
    expect(share).toMatchObject({ hits: 1, ordered: 1 });
    // `ranking` is the companion, and it is the whole finding: a share question that also ranks is a
    // comparison, and `ranking` sits *after* `share` in the shipped table so it never gets to lead.
    expect(share?.withCue).toEqual([{ kind: 'ranking', n: 1 }]);
    // The control: the row this cue got right carried no companion at all, so the companion is not
    // simply "a cue that fires often".
    expect(share?.hitWithCue).toEqual([]);
  });

  it('agrees with the per-cue reading it is a second view of', () => {
    const crossings = cueCrossings(rows);
    const readings = cuePrecision(rows);
    expect(crossings.map((crossing) => crossing.kind)).toEqual(expect.arrayContaining(readings.map((reading) => reading.kind)));
    for (const crossing of crossings) {
      const reading = readings.find((entry) => entry.kind === crossing.kind);
      // Two instruments over one population: the gap a reorder can recover is `inside - hits` here
      // and `ordered` there, and a disagreement is a second definition of "got it right".
      expect(crossing.hits).toBe(reading?.hits);
      expect(crossing.ordered).toBe((reading?.inside ?? 0) - (reading?.hits ?? 0));
      expect(crossing.hits + crossing.ordered).toBeLessThanOrEqual(reading?.leads ?? 0);
    }
  });

  it('orders the repair list by the rows each cue got wrong, which is the order to act in', () => {
    const crossings = cueCrossings([
      { prompt: 'top 5 categories by share of revenue', label: 'Bar Chart' },
      { prompt: 'top 3 products by share of revenue', label: 'Bar Chart' },
      { prompt: 'revenue over time', label: 'Line Chart' },
    ]);
    expect(crossings[0]?.kind).toBe('share');
    expect(crossings[0]?.ordered).toBe(2);
    expect(crossings[0]?.withCue).toEqual([{ kind: 'ranking', n: 2 }]);
    // A cue that got everything right is still reported, with an empty companion list rather than a
    // missing row: silence would read as "this cue never led".
    expect(crossings.find((crossing) => crossing.kind === 'trend')).toMatchObject({ hits: 1, ordered: 0, withCue: [] });
  });

  it('prints the companion with its share of the broken rows, so a big cue and a common cue differ', () => {
    const lines = describeCrossings(cueCrossings(rows));
    expect(lines[0]).toContain('order, not phrase');
    expect(lines[1]).toContain('share');
    expect(lines[1]).toContain('ranking (1/1)');
    // A cue with nothing wrong gets no line: the reading exists to name a repair, and a row of zeroes
    // is not a repair.
    expect(lines.join('\n')).not.toContain('trend');
    expect(describeCrossings([])).toEqual([]);
  });

  it('refuses a crossing whose own counters do not partition the rows it led', () => {
    const report = scoreRule(rows);
    const first = report.crossings[0]!;
    // The counters here are a second view of `cues`, so the assertion is that the two views cannot
    // drift: a crossing that claims more hits than its cue did is a second reading of the same rows.
    expect(() => assertRuleReport({ ...report, crossings: [{ ...first, hits: first.hits + 1 }] })).toThrow(/crossing/);
  });
});

describe('the share cue, split by what the question also asked for', () => {
  const shipped = CUE_VARIANTS[0]!.cues;

  it('moves one cue and leaves every other rule where it was', () => {
    const moved = withRankingBeforeShare(shipped);
    expect(moved).toHaveLength(shipped.length);
    expect(moved.findIndex((rule) => rule.kind === 'ranking')).toBeLessThan(moved.findIndex((rule) => rule.kind === 'share'));
    // The relative order of everything else is a fact the move must not touch, or the reading would
    // be about a reshuffled table rather than about one cue changing places.
    const others = (table: readonly { readonly kind: string }[]): readonly string[] =>
      table.map((rule) => rule.kind).filter((kind) => kind !== 'ranking');
    expect(others(moved)).toEqual(others(shipped));
    expect(moved.find((rule) => rule.kind === 'ranking')).toBe(shipped.find((rule) => rule.kind === 'ranking'));
  });

  it('lets a ranked share lead with the bar the corpus draws for it', () => {
    const question = 'top 5 categories by share of revenue';
    expect(cueMarks(question)[0]).toBe('pie');
    expect(cueMarks(question, withRankingBeforeShare(shipped))[0]).toBe('bar');
    // A share question with no ranking word is answered exactly as before: the move is worth nothing
    // if it also repaints the pies.
    expect(cueMarks('the share of revenue that is refunds', withRankingBeforeShare(shipped))[0]).toBe('pie');
  });

  it('reads the ranked share as one phrase, and only inside one clause', () => {
    const ranked = withShareRankedCue(shipped);
    expect(cueMarks('top 5 categories by share of revenue', ranked)[0]).toBe('bar');
    expect(cueMarks('what share of revenue came from the top 3 regions', ranked)[0]).toBe('bar');
    expect(cueMarks('the share of revenue that is refunds', ranked)[0]).toBe('pie');
    // A full stop ends the clause: a ranking stated after one is a second question, which is the
    // defect the unbounded `matrix` pattern cost this project 222 rows to learn.
    expect(cueMarks('the share of revenue that is refunds. show the top 3 regions', ranked)[0]).toBe('pie');
    // And the cue names a mark and nothing else, so it cannot repaint a line question either.
    expect(ranked.find((rule) => rule.kind === 'share-ranked')?.marks).toEqual(['bar']);
  });

  it('is a table that knows where it sits, and one that adds a phrase instead', () => {
    const names = CUE_VARIANTS.map((variant) => variant.name);
    expect(CUE_VARIANTS.find((variant) => variant.name === 'ranking-before-share')?.cues).toEqual(withRankingBeforeShare(shipped));
    expect(CUE_VARIANTS.find((variant) => variant.name === 'share-ranked')?.cues).toEqual(withShareRankedCue(shipped));
    // Two levers, priced apart on purpose: one is a reorder that costs no phrase, the other is a new
    // phrase that costs no order, and a reading that changed both could not say which one earned it.
    expect(names.indexOf('ranking-before-share')).toBeLessThan(names.indexOf('share-ranked'));
  });
});

describe('the edges of the crossing reading and the move behind it', () => {
  it('skips a row no cue fired on and a row whose label has no family', () => {
    // Both are outside every denominator in this file, at every level: a row the table said nothing
    // about cannot be a companion of anything, and a label this build cannot name cannot be wrong.
    const crossings = cueCrossings([
      { prompt: 'how many orders were placed', label: 'Bar Chart' },
      { prompt: 'top 3 regions by revenue', label: 'Treemap' },
      { prompt: 'top 3 regions by revenue', label: 'Bar Chart' },
    ]);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]).toMatchObject({ kind: 'ranking', hits: 1, ordered: 0 });
  });

  it('says so when no cue got the order wrong, rather than printing nothing', () => {
    // An empty reading and a clean reading are two different facts, and a section that vanishes on the
    // clean one leaves a reader unable to tell "nothing to fix" from "the instrument did not run".
    expect(describeCrossings([])).toEqual([]);
    const clean = describeCrossings(cueCrossings([{ prompt: 'revenue over time', label: 'Line Chart' }]));
    expect(clean).toHaveLength(2);
    expect(clean[1]).toContain('no cue led a row it covered with the wrong mark first');
  });

  it('leaves a table alone when the cue to move is not in it, or is already first', () => {
    // The totality is what keeps a variant built from a table that lost a cue measurable: a throw here
    // would drop the variant from the sweep instead of reporting it.
    const withoutRanking = CUE_VARIANTS[0]!.cues.filter((rule) => rule.kind !== 'ranking');
    expect(withCueMoved(withoutRanking, 'ranking', 'share')).toEqual(withoutRanking);
    // A `before` the table does not hold appends rather than dropping: a moved cue that disappeared
    // would be measured as an absence rather than as a move.
    const moved = withCueMoved(withoutRanking, 'trend', 'nowhere' as never);
    expect(moved[moved.length - 1]?.kind).toBe('trend');
    expect(moved).toHaveLength(withoutRanking.length);
  });

  it('refuses a crossing that names a cue the per-cue reading never saw', () => {
    const report = scoreRule([
      { prompt: 'the share of orders by status', label: 'Bar Chart' },
      { prompt: 'revenue over time', label: 'Line Chart' },
    ]);
    const stray = { ...report.crossings[0]!, kind: 'matrix' as const };
    expect(() => assertRuleReport({ ...report, crossings: [stray] })).toThrow(/no per-cue reading/);
  });
});
