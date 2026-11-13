/**
 * The Text2Vis loader, driven over a real socket and the real filesystem.
 *
 * Two things this file refuses to do. It does not mock `fetch`: the loader's whole job is to turn
 * bytes into a corpus, and a stub that returns a string tests the string rather than the contract
 * between an HTTP response and a parsed file. It does not mock the cache either -- each test writes
 * into its own temporary directory, so "the second call reads the cache" is a statement about a
 * file that exists on disk.
 *
 * The CSV cases are the awkward ones on purpose. The corpus is 1,985 rows of English prose with
 * commas in it, so a parser that is only tested on clean rows has not been tested at all: a split on
 * `,` returns the right *number* of rows and the wrong ones, which is the failure that survives a
 * row count.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  TEXT2VIS_FIELDS,
  TEXT2VIS_URL,
  applyExitCode,
  cacheDirFrom,
  chartTypeCounts,
  describeCorpus,
  entryExit,
  isEntry,
  loadText2Vis,
  parseCsv,
  readText2Vis,
} from '../eval/text2vis/dataset.js';

const root = mkdtempSync(join(tmpdir(), 'nl2charts-text2vis-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * The entry point as Node spells it.
 *
 * `isEntry` compares `pathToFileURL(argv[1])` against `import.meta.url`, so a fixture that wrote
 * `file:///repo/...` would be testing a URL no process can produce: the file has to be named by the
 * path this suite is running from.
 */
const ENTRY = resolve('eval/text2vis/dataset.ts');
const MODULE_URL = pathToFileURL(ENTRY).href;

/** A CSV with a header and one row, which is the smallest thing the loader accepts. */
const MINIMAL = `${TEXT2VIS_FIELDS.prompt},${TEXT2VIS_FIELDS.answer},${TEXT2VIS_FIELDS.code},${TEXT2VIS_FIELDS.chartType}\nWhich item sold most?,Widget,"plt.bar([1], [2])",Bar Chart\n`;

/**
 * One HTTP server per test, serving whatever the test wants to give it.
 *
 * Returned with its URL and a closer, because a leaked listener keeps the suite alive: every test
 * below closes what it opened, and the port is chosen by the OS so two tests cannot collide.
 */
async function serve(body: string, status = 200): Promise<{ url: string; close: () => Promise<void>; hits: () => number }> {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(status, { 'content-type': 'text/csv' });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/Text2Vis.csv`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    hits: () => hits,
  };
}

describe('the CSV parser', () => {
  it('reads a header and its rows, and drops the terminator rather than opening an empty record', () => {
    expect(parseCsv('a,b\n1,2\n3,4\n')).toEqual({
      columns: ['a', 'b'],
      rows: [
        ['1', '2'],
        ['3', '4'],
      ],
    });
    // A file whose last line has no newline is still a file: the final record is flushed by the
    // end of the buffer rather than by a terminator that never arrives.
    expect(parseCsv('a,b\n1,2')).toEqual({ columns: ['a', 'b'], rows: [['1', '2']] });
  });

  it('keeps a comma that is inside quotes, and a newline that is inside quotes', () => {
    // The two cases a split on the delimiter cannot survive, and the reason this parser exists:
    // the corpus is prose, so both occur, and either one turns one row into two.
    expect(parseCsv('a,b\n"one, two",3\n')).toEqual({ columns: ['a', 'b'], rows: [['one, two', '3']] });
    expect(parseCsv('a,b\n"first\nsecond",3\n')).toEqual({ columns: ['a', 'b'], rows: [['first\nsecond', '3']] });
  });

  it('reads a doubled quote as one quote, and closes the field on a single one', () => {
    expect(parseCsv('a\n"she said ""no"""\n')).toEqual({ columns: ['a'], rows: [['she said "no"']] });
    // A quoted field that is then followed by more text on the same record: the quote closes, the
    // remaining characters are literal, and the delimiter still separates.
    expect(parseCsv('a,b\n"x"y,2\n')).toEqual({ columns: ['a', 'b'], rows: [['xy', '2']] });
  });

  it('treats CRLF as one terminator and strips a byte-order mark', () => {
    // Both are what Excel writes, and both are silent when mishandled: the first leaves a `\r` on
    // the last field of every row, the second renames the first column to `\uFEFFPrompt` so the
    // header check fails on a file whose header is correct.
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual({ columns: ['a', 'b'], rows: [['1', '2']] });
    expect(parseCsv('\uFEFFa,b\n1,2\n')).toEqual({ columns: ['a', 'b'], rows: [['1', '2']] });
  });

  it('pads a short row rather than dropping it, and trims the header names', () => {
    // A missing trailing cell is a fact about the row. Dropping the row would make the corpus
    // count disagree with the file, which is the one check a reader has.
    expect(parseCsv('a, b ,c\n1,2\n')).toEqual({ columns: ['a', 'b', 'c'], rows: [['1', '2', '']] });
  });

  it('returns no columns for an empty document, which is the state the loader refuses', () => {
    expect(parseCsv('')).toEqual({ columns: [], rows: [] });
  });
});

describe('the corpus reader', () => {
  it('pulls the four fields a reading uses out of the row and keeps the rest', () => {
    const corpus = readText2Vis(MINIMAL);
    expect(corpus.columns).toEqual(['Prompt', 'Answer', 'Visualization Code', 'Chart Type']);
    expect(corpus.rows).toHaveLength(1);
    const row = corpus.rows[0];
    expect(row?.prompt).toBe('Which item sold most?');
    expect(row?.answer).toBe('Widget');
    expect(row?.code).toBe('plt.bar([1], [2])');
    expect(row?.chartType).toBe('Bar Chart');
    // The whole row is kept under its own header names: the corpus has more fields than this
    // repository reads yet, and a loader that discarded them would make the next mechanism a
    // re-download rather than a new reading of the same bytes.
    expect(row?.raw).toEqual({
      Prompt: 'Which item sold most?',
      Answer: 'Widget',
      'Visualization Code': 'plt.bar([1], [2])',
      'Chart Type': 'Bar Chart',
    });
  });

  it('names the missing Prompt column instead of answering every question with an empty string', () => {
    // The failure this check exists for: a file whose header changed reads as 1,985 questions with
    // no text, and every accuracy computed from it is a number about nothing.
    expect(() => readText2Vis('Question,Answer\nq,a\n')).toThrow(/no Prompt column \(it has Question, Answer\)/);
    expect(() => readText2Vis('')).toThrow(/is empty: no header/);
  });

  it('leaves the optional fields empty when the file does not carry them', () => {
    // A reading of "can the engine pick the mark" needs no reference code, and a corpus stripped to
    // its question still has to load: the three optional fields are read when present, not required.
    const corpus = readText2Vis('Prompt\nWhich item sold most?\n');
    expect(corpus.rows[0]?.answer).toBe('');
    expect(corpus.rows[0]?.code).toBe('');
    expect(corpus.rows[0]?.chartType).toBe('');
  });
});

describe('what the corpus holds', () => {
  it('counts the chart types most frequent first, with ties broken by name', () => {
    // The denominator of every per-type score, and the only reading the corpus gives without a
    // model. Two runs over the same file have to print the same table, so the tie is broken by
    // name rather than by the order the rows happened to arrive in.
    const corpus = readText2Vis(
      'Prompt,Chart Type\nq1,Bar Chart\nq2,Line Chart\nq3,Bar Chart\nq4,\n',
    );
    expect(chartTypeCounts(corpus)).toEqual([
      ['Bar Chart', 2],
      ['(none)', 1],
      ['Line Chart', 1],
    ]);
  });

  it('describes the rows, the columns and how many carry code and an answer', () => {
    // The line a workflow log carries, so a run that loaded a truncated file says so before it
    // spends a single call.
    expect(describeCorpus(readText2Vis(MINIMAL))).toEqual([
      'rows 1',
      'columns 4',
      'with reference code 1',
      'with an answer 1',
      'Bar Chart 1',
    ]);
  });
});

describe('loading the file', () => {
  it('downloads once, writes the cache, and reads the cache the second time', async () => {
    const server = await serve(MINIMAL);
    const cacheDir = mkdtempSync(join(root, 'warm-'));
    try {
      const first = await loadText2Vis({ url: server.url, cacheDir });
      expect(first.source).toBe('network');
      expect(first.corpus.rows).toHaveLength(1);
      expect(existsSync(first.path)).toBe(true);
      const second = await loadText2Vis({ url: server.url, cacheDir });
      expect(second.source).toBe('cache');
      // One download for two loads: the cache is a file, not a statement about one.
      expect(server.hits()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('refuses a download that failed, and one whose header the reader would refuse', async () => {
    const down = await serve('', 404);
    const wrongShape = await serve('Question,Answer\nq,a\n');
    const cacheDir = mkdtempSync(join(root, 'cold-'));
    try {
      await expect(loadText2Vis({ url: down.url, cacheDir })).rejects.toThrow(/could not be downloaded: 404/);
      await expect(loadText2Vis({ url: wrongShape.url, cacheDir })).rejects.toThrow(/no Prompt column/);
      // Neither failure leaves a file a later run would trust, and neither leaves the staged file
      // behind: a half-written CSV parses into a smaller corpus, which reads as a lower score.
      expect(readdirSync(cacheDir)).toEqual([]);
    } finally {
      await down.close();
      await wrongShape.close();
    }
  });

  it('reads the cache path the environment names, which is what a workflow sets', async () => {
    const server = await serve(MINIMAL);
    const cacheDir = mkdtempSync(join(root, 'env-'));
    const previous = process.env.TEXT2VIS_CACHE;
    process.env.TEXT2VIS_CACHE = cacheDir;
    try {
      const loaded = await loadText2Vis({ url: server.url });
      expect(loaded.path).toBe(join(cacheDir, 'Text2Vis.csv'));
    } finally {
      process.env.TEXT2VIS_CACHE = previous;
      await server.close();
    }
  });
});

describe('the two seams the loader leaves open', () => {
  it('resolves the cache directory from the option, then the environment, then the checkout', () => {
    // Three sources in one order, and the third is the one a workflow relies on when it sets
    // nothing: without it the corpus would be cached in whatever directory the process started in.
    expect(cacheDirFrom({ cacheDir: '/tmp/a' }, { TEXT2VIS_CACHE: '/tmp/b' }, '/repo')).toBe('/tmp/a');
    expect(cacheDirFrom({}, { TEXT2VIS_CACHE: '/tmp/b' }, '/repo')).toBe('/tmp/b');
    expect(cacheDirFrom({}, {}, '/repo')).toBe('/repo/eval/.cache/text2vis');
  });

  it('downloads from the declared location when the caller names none', async () => {
    // The constant is a constant, so this is the only way to test it: a transport that records what
    // it was asked for, answering with a status the loader refuses. No network is touched, and the
    // URL the module ships is the URL it uses.
    const asked: string[] = [];
    const fetchImpl = ((input: string | URL | Request) => {
      asked.push(String(input));
      return Promise.resolve(new Response('', { status: 503, statusText: 'Service Unavailable' }));
    }) as typeof fetch;
    const cacheDir = mkdtempSync(join(root, 'default-url-'));
    await expect(loadText2Vis({ cacheDir, fetchImpl })).rejects.toThrow(/could not be downloaded: 503/);
    expect(asked).toEqual([TEXT2VIS_URL]);
  });
});

describe('the command line', () => {
  it('prints the corpus it read and exits zero, and exits one on a file it cannot use', async () => {
    const server = await serve(MINIMAL);
    const cacheDir = mkdtempSync(join(root, 'cli-'));
    const borrowed = await serve('', 500);
    const lines: string[] = [];
    try {
      const ok = await entryExit(ENTRY, MODULE_URL, (line) => {
        lines.push(line);
      }, { url: server.url, cacheDir });
      expect(ok).toBe(0);
      expect(lines[0]).toMatch(/^text2vis: network /);
      expect(lines).toContain('rows 1');
      const failed = await entryExit(ENTRY, MODULE_URL, (line) => {
        lines.push(line);
      }, { url: borrowed.url, cacheDir: join(root, 'cli-missing') });
      expect(failed).toBe(1);
      expect(lines.at(-1)).toMatch(/could not be downloaded: 500/);
    } finally {
      await server.close();
      await borrowed.close();
    }
  });

  it('exits one on a header with no rows, and one on a failure that is not an Error', async () => {
    // Two states the corpus can be in that a reading must not proceed from: a file whose header
    // parsed and whose body is empty, and a transport that threw something that is not an Error
    // (a string, which is what a hand-written `throw 'timeout'` produces).
    const headerOnly = await serve('Prompt\n');
    const lines: string[] = [];
    const cacheDir = mkdtempSync(join(root, 'cli-empty-'));
    try {
      expect(await entryExit(ENTRY, MODULE_URL, (line) => lines.push(line), { url: headerOnly.url, cacheDir })).toBe(1);
      expect(lines).toContain('rows 0');
    } finally {
      await headerOnly.close();
    }
    const thrown = await entryExit(ENTRY, MODULE_URL, (line) => lines.push(line), {
      cacheDir: mkdtempSync(join(root, 'cli-thrown-')),
      fetchImpl: (() => {
        throw 'timeout';
      }) as unknown as typeof fetch,
    });
    expect(thrown).toBe(1);
    expect(lines.at(-1)).toBe('text2vis: timeout');
  });

  it('assigns the exit code only when there is one to assign', () => {
    // The line the module runs on import: `entryExit` answers `undefined` there, and an assignment
    // that treated "no code" as a code would clear a failing runner's status from an import.
    const target: { exitCode?: string | number | null } = { exitCode: 7 };
    applyExitCode(undefined, target);
    expect(target.exitCode).toBe(7);
    applyExitCode(3, target);
    expect(target.exitCode).toBe(3);
  });

  it('contributes no exit code when it is imported rather than run', async () => {
    // A module that set the exit code on import would clear a failing runner's status from an
    // import, which is the defect `eval/bird/needs-train.ts` writes its entry check to avoid.
    expect(isEntry(resolve('eval/other.ts'), MODULE_URL)).toBe(false);
    expect(isEntry(undefined, MODULE_URL)).toBe(false);
    expect(isEntry(ENTRY, MODULE_URL)).toBe(true);
    const lines: string[] = [];
    expect(await entryExit(resolve('eval/other.ts'), MODULE_URL, (line) => lines.push(line))).toBeUndefined();
    expect(lines).toEqual([]);
  });
});
