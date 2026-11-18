import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ablateJudgePair,
  describeAblation,
  entryAblate,
  parseAblateArgs,
  scoresOf,
  signed,
  type PairedVerdict,
} from '../eval/text2vis/ablate.js';

const verdict = (id: string, one: number, two: number): { id: string; chart_correctness: number; readability: number } => ({
  id,
  chart_correctness: one,
  readability: two,
});

describe('two readings of the same rows, as one difference per row', () => {
  it('pairs by id and reads each group on its own', () => {
    // The shape the sixth reading actually has: a group that moved and groups that did not. The
    // numbers are small on purpose — the arithmetic is what is under test, not the corpus.
    const reading = ablateJudgePair(
      [verdict('0', 3, 6), verdict('1', 3, 6), verdict('2', 1, 4), verdict('3', 1, 6)],
      [verdict('0', 3, 6), verdict('1', 3, 6), verdict('2', 5, 9), verdict('3', 7, 9)],
      (id) => (Number(id) < 2 ? 'kept:bar' : 'melted'),
    );
    expect(reading.paired).toBe(4);
    expect(reading.groups.map((group) => group.group)).toEqual(['kept:bar', 'melted']);
    const melted = reading.groups[1];
    expect(melted?.n).toBe(2);
    expect(melted?.correctness.before).toBe(1);
    expect(melted?.correctness.after).toBe(6);
    expect(melted?.correctness.delta).toBe(5);
    // The two differences are +4 and +6, so the mean is 5 and the interval is 1.96 wide: the table
    // says how much of the gain is the sample rather than the change.
    expect(melted?.correctness.interval).toBeCloseTo(1.96, 6);
  });

  it('widens the interval by the spread of the differences, not of the two means', () => {
    // Differences 1 and 3: mean 2, sample variance 2, standard error 1, interval 1.96. A paired
    // interval divided by the between-row variance of chart quality would be far wider, and the
    // whole reason to grade the same rows twice is that the variance is not in the comparison.
    const reading = ablateJudgePair([verdict('0', 1, 1), verdict('1', 1, 1)], [verdict('0', 2, 1), verdict('1', 4, 1)], () => 'melted');
    expect(reading.groups[0]?.correctness.delta).toBe(2);
    expect(reading.groups[0]?.correctness.interval).toBeCloseTo(1.96, 6);
  });

  it('refuses to invent an interval for a single row', () => {
    const reading = ablateJudgePair([verdict('0', 1, 1)], [verdict('0', 4, 4)], () => 'melted');
    expect(reading.groups[0]?.correctness.interval).toBeNull();
    expect(signed(3, reading.groups[0]?.correctness.interval ?? null)).toBe('+3.000');
    // A loss is a number too, and a table that only prints gains is a table nobody trusts.
    expect(signed(-0.444, 0.662)).toBe('-0.444 ± 0.662');
  });

  it('compares only the rows both readings graded, and counts the ones it could not', () => {
    // A refused row is not a zero: the fifth reading declined 39 tables and the sixth drew four of
    // them, so pairing them would put a change of population inside a change of quality.
    const reading = ablateJudgePair(
      [verdict('0', 3, 3), { id: '1', error: 'llm call timed out' }, verdict('2', 2, 2)],
      [verdict('0', 3, 3), verdict('1', 9, 9), verdict('3', 9, 9)],
      () => 'melted',
    );
    expect(reading.paired).toBe(1);
    expect(reading.dropped).toBe(1);
    expect(reading.added).toBe(2);
    // The row that was graded twice is the whole population of the table: its mean is its own score.
    expect(reading.groups[0]?.n).toBe(1);
  });

  it('groups a row it cannot place under the name the caller gave, never out of the table', () => {
    // An id the caller cannot place is a defect in the caller, and dropping the row would hide it:
    // the reading would report a mean over a population nobody can name, which is the failure this
    // whole instrument exists against.
    const reading = ablateJudgePair([verdict('7', 1, 1)], [verdict('7', 2, 2)], () => 'kept:unrendered');
    expect(reading.groups.map((group) => group.group)).toEqual(['kept:unrendered']);
  });

  it('sorts the biggest group first, because that is the one the reader is looking for', () => {
    const reading = ablateJudgePair(
      [verdict('0', 1, 1), verdict('1', 1, 1), verdict('2', 1, 1), verdict('3', 1, 1)],
      [verdict('0', 2, 2), verdict('1', 2, 2), verdict('2', 2, 2), verdict('3', 2, 2)],
      (id) => (id === '3' ? 'melted' : 'kept:bar'),
    );
    expect(reading.groups.map((group) => [group.group, group.n])).toEqual([
      ['kept:bar', 3],
      ['melted', 1],
    ]);
  });

  it('reads two scores out of a verdict, and nothing out of a failure', () => {
    expect(scoresOf({ chart_correctness: 3, readability: 6 })).toEqual([3, 6]);
    expect(scoresOf({ chart_correctness: 3 })).toBeUndefined();
    expect(scoresOf({ error: 'x' })).toBeUndefined();
    // A verdict that kept an error and a score is one the judge report already refuses; here it is
    // simply not a pair, so the row cannot enter a mean.
    expect(scoresOf({ chart_correctness: 3, readability: 6, error: 'x' })).toEqual([3, 6]);
  });
});

describe('the sentence that turns the table into a claim', () => {
  const groups = (rows: readonly PairedVerdict[]) =>
    ablateJudgePair(
      rows.map((row) => verdict(row.id, row.before[0], row.before[1])),
      rows.map((row) => verdict(row.id, row.after[0], row.after[1])),
      (id) => rows.find((row) => row.id === id)?.group ?? 'unknown',
    );

  const pair = (id: string, group: string, before: [number, number], after: [number, number]): PairedVerdict => ({ id, group, before, after });

  it('says the instrument did not drift when every control group held its mean', () => {
    const reading = groups([pair('0', 'kept:bar', [3, 6], [3, 6]), pair('1', 'kept:bar', [4, 6], [4, 6]), pair('2', 'melted', [1, 4], [6, 9])]);
    const lines = describeAblation(reading).join('\n');
    expect(lines).toContain('1 control group(s) that did not change kept their means');
    expect(lines).toContain('melted: 1 rows, correctness 1.00 → 6.00');
  });

  it('puts a control group that moved ahead of the reading, because that is a defect first', () => {
    // The failure this line exists for: a control group whose mean moved means the instrument or the
    // renderer changed something it was not supposed to, and the melted group's gain cannot be read
    // until that is explained.
    const reading = groups([
      pair('0', 'kept:bar', [3, 6], [8, 6]),
      pair('1', 'kept:bar', [3, 6], [8, 6]),
      pair('2', 'melted', [1, 4], [6, 9]),
    ]);
    const lines = describeAblation(reading).join('\n');
    expect(lines).toContain('1 control group(s) moved without being changed: kept:bar');
  });

  it('names the groups too small to have an interval, rather than printing nothing about them', () => {
    const reading = groups([pair('0', 'kept:candlestick', [10, 9], [10, 9]), pair('1', 'melted', [1, 4], [6, 9])]);
    const lines = describeAblation(reading).join('\n');
    expect(lines).toContain('no interval: kept:candlestick (1 row)');
    expect(lines).toContain('2 rows graded in both readings, 0 only in the first, 0 only in the second');
  });
});

describe('the ablate command', () => {
  const FIELDS = ['Question', 'Prompt', 'Answer', 'Visualization Code', 'Chart Type', 'Table Data'];
  const flat = 'product,revenue\nalpha,10\nbeta,20\ngamma,30';
  const wide = 'country,2016,2017,2018\nOman,1,2,3\nSamoa,4,5,6';
  const row = (question: string, label: string, table: string): string =>
    `${question},You are a data science assistant.,Widget,"plt.bar([1], [2])",${label},"${table}"`;
  // The fifth row is one the pipeline refuses — a table with one column and no measure — so the run
  // has a refusal to read and the grouping is exercised on a row the product declined to draw.
  const bare = 'city';
  const corpus = `${FIELDS.join(',')}\n${row('top products by revenue', 'Bar Chart', flat)}\n${row('revenue by product', 'Bar Chart', flat)}\n${row('population over time', 'Line Chart', wide)}\n${row('population of a country', 'Line Chart', wide)}\n${row('which city', 'Bar Chart', bare)}\n`;

  const serve = async (body: string): Promise<{ url: string; close: () => Promise<void> }> => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/csv' });
      response.end(body);
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${String(port)}/Text2Vis.csv`, close: () => new Promise<void>((done) => server.close(() => done())) };
  };

  const reading = (path: string, rows: readonly { id: string; one: number; two: number }[]): string => {
    writeFileSync(path, JSON.stringify({ verdicts: rows.map((entry) => verdict(entry.id, entry.one, entry.two)) }));
    return path;
  };

  it('pairs two artifacts over the corpus, and groups the rows by what the product did with them', async () => {
    // The two rows that melted and the two that did not are the two groups; the test does not name
    // them, because the grouping comes from `chartJobs` and `meltWide` and not from this file.
    const directory = mkdtempSync(join(tmpdir(), 'ablate-'));
    const server = await serve(corpus);
    try {
      const before = reading(join(directory, 'before.json'), [
        { id: '0', one: 3, two: 6 },
        { id: '1', one: 3, two: 6 },
        { id: '2', one: 1, two: 4 },
        { id: '3', one: 2, two: 5 },
        { id: '99', one: 4, two: 4 },
      ]);
      const after = reading(join(directory, 'after.json'), [
        { id: '0', one: 3, two: 6 },
        { id: '1', one: 3, two: 6 },
        { id: '2', one: 6, two: 9 },
        { id: '3', one: 7, two: 9 },
        { id: '99', one: 4, two: 4 },
      ]);
      const artifact = join(directory, 'out', 'ablation.json');
      const lines: string[] = [];
      const code = await entryAblate(join(process.cwd(), 'eval/text2vis/ablate.ts'), pathToFileURL(join(process.cwd(), 'eval/text2vis/ablate.ts')).href, (line) => lines.push(line), {
        argv: ['--before', before, '--after', after, '--artifact', artifact],
        // The cache directory is part of the fixture: `loadText2Vis` reads a cached file before it
        // reads the url, so a test that serves a corpus and does not own the cache reads whatever the
        // last run left in `eval/.cache/text2vis` — which is a 6 MB corpus of different rows, and in
        // CI it made all four synthetic rows group as `kept:declined`.
        load: { url: server.url, cacheDir: join(directory, 'cache') },
      });
      expect(code).toBe(0);
      const written = JSON.parse(readFileSync(artifact, 'utf8')) as { groups: { group: string; n: number; correctness: { delta: number } }[] };
      // The grouping names the mark `toChartIR` drew — the figure the judge looked at — not the
      // family the label wanted and not the mark `profile.ts` ranked first.
      // `kept:unrendered` is the row the corpus has no mark for: an id in the artifacts that the
      // pipeline never produced. It is grouped, not dropped — a row that leaves the table is the
      // failure this instrument exists to prevent.
      expect(written.groups.map((group) => [group.group, group.n])).toEqual([
        ['kept:bar', 2],
        ['melted', 2],
        ['kept:unrendered', 1],
      ]);
      expect(written.groups[1]?.correctness.delta).toBe(5);
      expect(lines.join('\n')).toContain('5 rows graded in both readings');
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('prints the table as JSON when asked, and writes nothing it was not told to', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ablate-json-'));
    const server = await serve(corpus);
    try {
      const before = reading(join(directory, 'a.json'), [{ id: '0', one: 1, two: 1 }]);
      const after = reading(join(directory, 'b.json'), [{ id: '0', one: 2, two: 2 }]);
      const lines: string[] = [];
      const entry = join(process.cwd(), 'eval/text2vis/ablate.ts');
      const code = await entryAblate(entry, pathToFileURL(entry).href, (line) => lines.push(line), {
        argv: ['--before', before, '--after', after, '--json'],
        load: { url: server.url, cacheDir: join(directory, 'cache') },
      });
      expect(code).toBe(0);
      expect(JSON.parse(lines.join('\n'))).toMatchObject({ paired: 1, dropped: 0, added: 0 });
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads one group over every paired row when the question is about the whole corpus', async () => {
    // The `--think` experiment is not a change to some rows and not others: every row was asked the
    // same two questions by a grader that either deliberated or did not. Grouping it by mark would
    // answer "did bar charts move", which is a different question and a weaker one — the decision
    // (does deliberation buy anything) is about the population, and so is the interval that decides.
    const directory = mkdtempSync(join(tmpdir(), 'ablate-all-'));
    const server = await serve(corpus);
    try {
      const before = reading(join(directory, 'before.json'), [
        { id: '0', one: 3, two: 6 },
        { id: '1', one: 3, two: 6 },
        { id: '2', one: 1, two: 4 },
        { id: '3', one: 2, two: 5 },
      ]);
      // Differences: 0, 0, +5, +5 — mean 2, and the interval is the paired one over those four.
      const after = reading(join(directory, 'after.json'), [
        { id: '0', one: 3, two: 6 },
        { id: '1', one: 3, two: 6 },
        { id: '2', one: 6, two: 9 },
        { id: '3', one: 7, two: 9 },
      ]);
      const artifact = join(directory, 'out', 'ablation.json');
      const lines: string[] = [];
      const entry = join(process.cwd(), 'eval/text2vis/ablate.ts');
      const code = await entryAblate(entry, pathToFileURL(entry).href, (line) => lines.push(line), {
        argv: ['--before', before, '--after', after, '--group', 'all', '--artifact', artifact],
        load: { url: server.url, cacheDir: join(directory, 'cache') },
      });
      expect(code).toBe(0);
      const written = JSON.parse(readFileSync(artifact, 'utf8')) as {
        paired: number;
        groups: { group: string; n: number; correctness: { delta: number; interval: number | null } }[];
      };
      expect(written.paired).toBe(4);
      expect(written.groups.map((group) => [group.group, group.n])).toEqual([['all', 4]]);
      // Differences 0, 0, +5, +5: mean 2.5, sample variance 25/3, so 1.96 · sqrt(25/12) = 2.829 —
      // the interval is wide because four rows and two distinct values cannot narrow it further.
      expect(written.groups[0]?.correctness.delta).toBe(2.5);
      expect(written.groups[0]?.correctness.interval).toBeCloseTo(2.829, 3);
      // The sentence a single group must not get: there is no control here, and a table that called
      // the whole population a control would be claiming the instrument was held still by a group
      // that was changed by the very thing being priced.
      const text = lines.join('\n');
      expect(text).toContain('all: 4 rows');
      expect(text).toContain('no control group: every paired row was changed');
      expect(text).not.toContain('control group(s) that did not change kept their means');
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('takes only the two groupings it can defend, and says so for anything else', () => {
    // `auto` is the default and stays the default: a change to some rows and not others is the case
    // the grouped table was built for, and an experiment that wants one population has to say so.
    expect(parseAblateArgs(['--group', 'all'])).toEqual({ json: false, group: 'all' });
    expect(parseAblateArgs(['--group', 'auto'])).toEqual({ json: false, group: 'auto' });
    expect(parseAblateArgs([])).toEqual({ json: false });
    expect(() => parseAblateArgs(['--group'])).toThrow(/needs a value/);
    expect(() => parseAblateArgs(['--group', 'mark'])).toThrow(/--group takes auto or all, not mark/);
  });

  it('refuses a file that is not a judge reading, and a command with one side of the pair', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ablate-bad-'));
    try {
      const missing = join(directory, 'not-there.json');
      const lines: string[] = [];
      const entry = join(process.cwd(), 'eval/text2vis/ablate.ts');
      const code = await entryAblate(entry, pathToFileURL(entry).href, (line) => lines.push(line), {
        argv: ['--before', missing, '--after', missing],
      });
      expect(code).toBe(1);
      // The missing file is reported as a missing file, before the corpus is fetched: a tool that
      // downloads 6 MB to answer a question about an argument is a tool nobody runs twice.
      expect(lines.join('\n')).toMatch(/ENOENT|no such file/);
      expect(
        await entryAblate(entry, pathToFileURL(entry).href, (line) => lines.push(line), { argv: ['--before', missing] }),
      ).toBe(1);
      expect(lines.join('\n')).toContain('--before and --after are both required');
      // And the argument parser is strict about the flags it does not know, which is how a typo
      // becomes a message rather than a run with the default.
      expect(() => parseAblateArgs(['--before'])).toThrow(/needs a value/);
      expect(() => parseAblateArgs(['--quiet'])).toThrow(/unknown argument --quiet/);
      expect(parseAblateArgs([])).toEqual({ json: false });
      expect(await entryAblate(undefined, 'file:///not/this/one', () => undefined, { argv: [] })).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports a reading that is not a pair of judge artifacts as one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ablate-shape-'));
    try {
      const path = join(directory, 'no-verdicts.json');
      writeFileSync(path, JSON.stringify({ charts: 1418 }));
      const lines: string[] = [];
      const entry = join(process.cwd(), 'eval/text2vis/ablate.ts');
      const code = await entryAblate(entry, pathToFileURL(entry).href, (line) => lines.push(line), { argv: ['--before', path, '--after', path] });
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('has no verdicts, so it is not a judge reading');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
