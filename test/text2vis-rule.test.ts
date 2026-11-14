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
  cueMarks,
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
    expect(CUE_VARIANTS.map((variant) => variant.name)).toEqual(['shipped', 'bar-share', 'histogram', 'bar-share+histogram']);
    for (const variant of CUE_VARIANTS) expect(variant.note.length).toBeGreaterThan(20);
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
    const barShare = report.sweep[1];
    // The bar-first share table trades one pie row for one bar row on this corpus, and the pie row
    // it loses is printed rather than absorbed into a single top-1 number.
    expect(barShare?.byFamily.find((cell) => cell.family === 'bar')?.top1).toBe(
      (shipped?.byFamily.find((cell) => cell.family === 'bar')?.top1 ?? 0) + 1,
    );
    expect(barShare?.byFamily.find((cell) => cell.family === 'pie')?.top1).toBe(0);
    // The histogram table moves its own label and leaves the other four where they were.
    const histogram = report.sweep[2];
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

  it('prints one line per table and nothing when there is no sweep', () => {
    const report = sweepRule(rows);
    const lines = describeSweep(report);
    expect(lines).toHaveLength(CUE_VARIANTS.length + 1);
    expect(lines[0]).toContain(`${String(CUE_VARIANTS.length)} tables over the same ${String(report.scored)} rows`);
    expect(lines[1]).toContain('shipped');
    expect(lines[2]).toContain('bar +');
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
