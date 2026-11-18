import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertRenderReport,
  chartJobs,
  describeRender,
  entryRender,
  parseRenderArgs,
  renderJobs,
  summarize,
  type ChartJob,
  type ChartJobs,
  type ChartVerdict,
  type RenderReport,
} from '../eval/text2vis/render.js';
import type { ProfileInput } from '../eval/text2vis/profile.js';

const input = (prompt: string, label: string, tableData: string): ProfileInput => ({ prompt, label, tableData });

// Four rows with four distinct measures, because `inferType` reads a two-row measure of two distinct
// values as an *ordinal* scale (two values out of two rows is below its cardinality floor) and the
// recommender then has no measure to chart. That heuristic is about small tables, not about this
// reading, so the fixture stays clear of it.
const bars = input('Top products by revenue', 'Bar Chart', 'product,revenue\nalpha,10\nbeta,20\ngamma,30\ndelta,40');
const matrix = input(
  'Revenue by region and quarter',
  'Heatmap',
  'region,quarter,revenue\nnorth,q1,1\nnorth,q2,2\nsouth,q1,3\nsouth,q2,4\neast,q1,5\neast,q2,6',
);
const single = input('How are we tracking against target?', 'Gauge', 'revenue\n42');
// One row per country, one column per year: the shape the admission rules can only refuse, and the
// shape the melt answers. It has to reach a figure now, or this reading reports the product declining
// a table the product draws.
const wide = input(
  'How has the population changed?',
  'Line Chart',
  'country,2019,2020,2021\nOman,1203,1180,1164\nSamoa,200,210,219',
);
const nameless = input('Which products are there?', 'Bar Chart', 'product,region\nalpha,north');
const unreadable = input('Top products by revenue', 'Bar Chart', '');

const job = (id: string, mark: ChartJob['mark'] = 'bar'): ChartJob => ({ id, mark, code: 'import matplotlib.pyplot as plt\n' });

const verdict = (id: string, extra: Partial<ChartVerdict> = {}): ChartVerdict => ({ id, ok: true, ms: 12, bytes: 1_000, ...extra });

describe('turning corpus rows into the charts a worker can draw', () => {
  it('emits the source a bar chart compiles to, and counts the row as one chart', () => {
    const { jobs, refusals } = chartJobs([bars]);
    expect(refusals).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.mark).toBe('bar');
    expect(jobs[0]?.code).toContain('plt.bar(');
    expect(jobs[0]?.id).toBe('0');
  });

  it('emits a heatmap as a matrix when the result set carries two categories and a measure', () => {
    const { jobs } = chartJobs([matrix]);
    expect(jobs[0]?.mark).toBe('heatmap');
    expect(jobs[0]?.code).toContain('plt.imshow(');
  });

  it('draws a table that is wide in time as one line per entity, instead of declining it', () => {
    const { jobs, refusals } = chartJobs([wide]);
    expect(refusals).toEqual([]);
    expect(jobs[0]?.mark).toBe('line');
    expect(jobs[0]?.code).toContain('plt.plot(positions, s0, marker="o", label="Oman")');
    expect(jobs[0]?.code).toContain('label="Samoa"');
  });

  it('keeps "the product answered no chart" apart from "the compiler refused the answer"', () => {
    // Two failures, two repairs: a table that will not profile is a parsing gap, and a table no mark
    // can encode is the recommender's own refusal. Folding them into one counter would hide which of
    // the two a reading lost its rows to — the defect `profile.ts` publishes both counts to prevent.
    const { jobs, refusals } = chartJobs([nameless, unreadable]);
    expect(jobs).toEqual([]);
    expect(refusals.map((refusal) => refusal.code)).toEqual(['profile:refused', 'profile:none']);
    expect(refusals.every((refusal) => refusal.mark === 'declined')).toBe(true);
  });

  it('refuses a mark the compiler does not paint, and keeps the row as a priced refusal', () => {
    // A gauge is admitted by the recommender and refused by the compiler, because the IR carries the
    // value without the scale. That is a real number in the report rather than a missing row.
    const { jobs, refusals } = chartJobs([single]);
    expect(jobs).toEqual([]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ mark: 'gauge', code: 'NL2C_E_NOT_SUPPORTED' });
    expect(refusals[0]?.reason).toMatch(/gauge/);
  });

  it('names every row by its position, so a report can be traced back to the corpus', () => {
    const { jobs } = chartJobs([bars, matrix, bars]);
    expect(jobs.map((entry) => entry.id)).toEqual(['0', '1', '2']);
    expect(jobs.map((entry) => entry.mark)).toEqual(['bar', 'heatmap', 'bar']);
  });
});

describe('the arithmetic a render report is checked against', () => {
  const jobs: ChartJobs = { jobs: [job('0'), job('1', 'line')], refusals: [] };

  it('counts the outcomes per mark and publishes the whole', () => {
    const report = summarize(2, jobs, [verdict('0'), verdict('1')]);
    expect(report).toMatchObject({ scored: 2, charts: 2, rendered: 2, failed: 0, refused: 0, declined: 0 });
    expect(report.byMark.map((mark) => [mark.mark, mark.rows, mark.rendered])).toEqual([
      ['bar', 1, 1],
      ['line', 1, 1],
    ]);
  });

  it('keeps a failure visible, because a source that raised is this repository defect', () => {
    const report = summarize(2, jobs, [verdict('0'), verdict('1', { ok: false, error: 'ValueError: boom' })]);
    expect(report.failed).toBe(1);
    expect(report.failures).toEqual([{ id: '1', mark: 'line', error: 'ValueError: boom' }]);
    expect(report.rendered).toBe(1);
  });

  it('keeps ten failure messages and counts them all', () => {
    // The count is the reading; the messages are the evidence. Capping the messages keeps a report
    // readable when an emitter bug hits every row, and does not change what the count says.
    const many: ChartJobs = { jobs: Array.from({ length: 12 }, (_, index) => job(String(index))), refusals: [] };
    const report = summarize(12, many, many.jobs.map((entry) => verdict(entry.id, { ok: false, error: 'E' })));
    expect(report.failed).toBe(12);
    expect(report.failures).toHaveLength(10);
  });

  it('counts a verdict that reported no timing, because a verdict is about the file', () => {
    // A worker that does not measure is still a worker that drew: the counters must not depend on an
    // optional field, or a thinner protocol silently reads as fewer charts.
    const report = summarize(1, { jobs: [job('0')], refusals: [] }, [{ id: '0', ok: true }]);
    expect(report.rendered).toBe(1);
    expect(report.latency.max).toBe(0);
    expect(report.bytes.total).toBe(0);
  });

  it('reads latency and png size from the verdicts, and admits a run with no figure at all', () => {
    const report = summarize(2, jobs, [verdict('0', { ms: 10, bytes: 100 }), verdict('1', { ms: 30, bytes: 300 })]);
    expect(report.latency.max).toBe(30);
    expect(report.bytes.total).toBe(400);
    const empty = summarize(0, { jobs: [], refusals: [] }, []);
    expect(empty.latency).toEqual({ p50: 0, p95: 0, max: 0 });
    expect(empty.bytes).toEqual({ p50: 0, p95: 0, total: 0 });
  });

  it('puts a refusal in its own bucket and counts the code once', () => {
    const refused: ChartJobs = {
      jobs: [],
      refusals: [
        { id: '0', mark: 'gauge', code: 'NL2C_E_NOT_SUPPORTED', reason: 'a gauge has no scale' },
        { id: '1', mark: 'gauge', code: 'NL2C_E_NOT_SUPPORTED', reason: 'a gauge has no scale' },
        { id: '2', mark: 'declined', code: 'profile:none', reason: 'the table would not profile' },
      ],
    };
    const report = summarize(3, refused, []);
    expect(report).toMatchObject({ scored: 3, refused: 2, declined: 1 });
    expect(report.refusalCodes).toEqual([
      { code: 'NL2C_E_NOT_SUPPORTED', n: 2 },
      { code: 'profile:none', n: 1 },
    ]);
    expect(report.byMark.find((mark) => mark.mark === 'gauge')).toMatchObject({ rows: 2, refused: 2 });
  });
});

describe('the render report refusing to publish what does not add up', () => {
  const base = (overrides: Partial<RenderReport> = {}): RenderReport => ({
    scored: 2,
    charts: 2,
    rendered: 2,
    failed: 0,
    refused: 0,
    declined: 0,
    byMark: [{ mark: 'bar', rows: 2, rendered: 2, refused: 0, declined: 0, failed: 0 }],
    refusalCodes: [],
    failures: [],
    latency: { p50: 0, p95: 0, max: 0 },
    bytes: { p50: 0, p95: 0, total: 0 },
    ...overrides,
  });

  it('accepts a report whose counters add up', () => {
    expect(() => assertRenderReport(base())).not.toThrow();
  });

  it('refuses a report where a row fell out of the counters', () => {
    expect(() => assertRenderReport(base({ rendered: 1 }))).toThrow(/not 2 scored/);
  });

  it('refuses a mark line that does not add up to its own rows', () => {
    expect(() =>
      assertRenderReport(base({ byMark: [{ mark: 'bar', rows: 2, rendered: 1, refused: 0, declined: 0, failed: 0 }] })),
    ).toThrow(/counts 1 outcomes for 2 rows/);
  });

  it('refuses a refusal produced by an exception this layer never throws', () => {
    // `internal` is what `codeOf` returns for an error that is not a `Nl2ChartsError`: a bug in the
    // emitter wearing a refusal's clothes. It must never reach a published report.
    expect(() => assertRenderReport(base({ refusalCodes: [{ code: 'internal', n: 1 }] }))).toThrow(/defect in the emitter/);
  });

  it('refuses a failure count with no message to explain it', () => {
    expect(() => assertRenderReport(base({ rendered: 1, failed: 1 }))).toThrow(/not one message was kept/);
  });

  it('refuses a verdict that never arrived, instead of counting the job as nothing', () => {
    const jobs: ChartJobs = { jobs: [job('0')], refusals: [] };
    expect(() => summarize(1, jobs, [])).toThrow(/no verdict for row 0/);
  });
});

describe('running the jobs through a worker process', () => {
  const worker = async (body: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'nl2charts-worker-'));
    const path = join(dir, 'worker.mjs');
    await writeFile(path, body);
    return path;
  };

  it('returns nothing for no jobs, and starts no process to say so', async () => {
    await expect(renderJobs([], { outDir: '/tmp/unused' })).resolves.toEqual([]);
  });

  it('reads one verdict per job from the stream, in the order the jobs were handed over', async () => {
    const path = await worker(`
      let pending = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split('\\n');
        pending = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const job = JSON.parse(line);
          process.stdout.write(JSON.stringify({ id: job.id, ok: true, ms: 1, bytes: 2 }) + '\\n');
        }
      });
    `);
    const verdicts = await renderJobs([job('0'), job('1')], { outDir: '/tmp/unused', python: process.execPath, worker: path });
    expect(verdicts.map((entry) => entry.id)).toEqual(['0', '1']);
  });

  it('reads a verdict that arrived without a trailing newline', async () => {
    // A worker that writes its last line and exits may leave the buffer without the separator this
    // reader splits on. Losing that verdict would be losing a job.
    const path = await worker(`
      process.stdin.resume();
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({ id: '0', ok: true, ms: 1, bytes: 2 }));
      });
    `);
    const verdicts = await renderJobs([job('0')], { outDir: '/tmp/unused', python: process.execPath, worker: path });
    expect(verdicts).toHaveLength(1);
  });

  it('refuses a worker that exits non-zero, and quotes what it said', async () => {
    const path = await worker(`
      process.stdin.resume();
      process.stdin.on('end', () => {
        process.stderr.write('ImportError: no matplotlib\\n');
        process.exit(3);
      });
    `);
    await expect(renderJobs([job('0')], { outDir: '/tmp/unused', python: process.execPath, worker: path })).rejects.toThrow(
      /exited with 3: ImportError/,
    );
  });

  it('refuses a worker that lost a job, because a missing verdict is not a missing row', async () => {
    const path = await worker(`
      process.stdin.resume();
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({ id: '0', ok: true, ms: 1, bytes: 2 }) + '\\n');
      });
    `);
    await expect(
      renderJobs([job('0'), job('1')], { outDir: '/tmp/unused', python: process.execPath, worker: path }),
    ).rejects.toThrow(/no verdict for row 1/);
  });

  it('refuses a worker it cannot start at all', async () => {
    await expect(
      renderJobs([job('0')], { outDir: '/tmp/unused', python: 'definitely-not-an-interpreter-here' }),
    ).rejects.toThrow();
  });

  it('cleans up nothing it did not create: a real worker wrote the png where it was told', async () => {
    // The end-to-end shape, with a stand-in that writes the file the protocol names. The real worker's
    // own behaviour is priced by `bench:text2vis:render` on the corpus, where a Python exception would
    // arrive as `failed` rather than as a passing test.
    const dir = await mkdtemp(join(tmpdir(), 'nl2charts-png-'));
    const path = await worker(`
      import { writeFileSync } from 'node:fs';
      let pending = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        pending += chunk;
        for (const line of pending.split('\\n')) {
          if (!line.trim()) continue;
          const job = JSON.parse(line);
          writeFileSync(job.png, 'png');
          process.stdout.write(JSON.stringify({ id: job.id, ok: true, ms: 1, bytes: 3 }) + '\\n');
        }
        pending = '';
      });
    `);
    try {
      const verdicts = await renderJobs([job('7')], { outDir: dir, python: process.execPath, worker: path });
      expect(verdicts[0]).toMatchObject({ ok: true, bytes: 3 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the render command line', () => {
  it('takes the flags it documents and refuses the rest', () => {
    expect(parseRenderArgs([])).toEqual({ outDir: 'eval/.cache/text2vis/png', keep: false, json: false });
    expect(parseRenderArgs(['--json', '--keep', '--out', '/tmp/x', '--artifact', 'a.json'])).toEqual({
      outDir: '/tmp/x',
      keep: true,
      json: true,
      artifact: 'a.json',
    });
    expect(() => parseRenderArgs(['--artifact'])).toThrow(/needs a path/);
    expect(() => parseRenderArgs(['--out', '--json'])).toThrow(/needs a path/);
    expect(() => parseRenderArgs(['--nope'])).toThrow(/unknown argument --nope/);
  });

  it('prints one fact per line, including the refusals and the failures', () => {
    const report: RenderReport = {
      scored: 4,
      charts: 2,
      rendered: 1,
      failed: 1,
      refused: 1,
      declined: 1,
      byMark: [
        { mark: 'bar', rows: 2, rendered: 1, refused: 0, declined: 0, failed: 1 },
        { mark: 'gauge', rows: 1, rendered: 0, refused: 1, declined: 0, failed: 0 },
        { mark: 'declined', rows: 1, rendered: 0, refused: 0, declined: 1, failed: 0 },
      ],
      refusalCodes: [{ code: 'NL2C_E_NOT_SUPPORTED', n: 1 }],
      failures: [{ id: '0', mark: 'bar', error: 'ValueError: boom' }],
      latency: { p50: 12, p95: 30, max: 30 },
      bytes: { p50: 1_000, p95: 2_000, total: 1_048_576 },
    };
    const lines = describeRender(report).join('\n');
    expect(lines).toContain('rendered 1/4 (25.00%)');
    expect(lines).toContain('refusals 1 (25.00%)');
    expect(lines).toContain('NL2C_E_NOT_SUPPORTED 1');
    expect(lines).toContain('FAILED row 0 (bar): ValueError: boom');
    expect(lines).toContain('gauge: 1 rows, 0 rendered');
  });
});

describe('the render command, over a real socket and a real worker', () => {
  /** One HTTP server per test, closed by the test that opened it. */
  const serve = async (body: string): Promise<{ url: string; close: () => Promise<void> }> => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/csv' });
      response.end(body);
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${String(port)}/Text2Vis.csv`,
      close: () => new Promise<void>((done) => server.close(() => done())),
    };
  };

  const FIELDS = ['Question', 'Prompt', 'Answer', 'Visualization Code', 'Chart Type', 'Table Data'];
  const corpus = `${FIELDS.join(',')}\nTop products by revenue,You are a data science assistant.,Widget,"plt.bar([1], [2])",Bar Chart,"product,revenue\nalpha,10\nbeta,20\ngamma,30\ndelta,40"\n`;
  const ENTRY = resolve('eval/text2vis/render.ts');
  const MODULE_URL = pathToFileURL(ENTRY).href;

  /** A worker that writes the file it was told to and reports success. */
  const okWorker = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'nl2charts-ok-'));
    const path = join(dir, 'worker.mjs');
    await writeFile(
      path,
      `
      import { writeFileSync } from 'node:fs';
      let pending = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split('\\n');
        pending = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const job = JSON.parse(line);
          writeFileSync(job.png, 'png');
          process.stdout.write(JSON.stringify({ id: job.id, ok: true, ms: 2, bytes: 3 }) + '\\n');
        }
      });
    `,
    );
    return path;
  };

  it('renders the corpus, writes the report, and removes the pictures it was told not to keep', async () => {
    const server = await serve(corpus);
    const root = mkdtempSync(join(tmpdir(), 'nl2charts-entry-'));
    const lines: string[] = [];
    try {
      const code = await entryRender(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--artifact', join(root, 'render.json'), '--out', join(root, 'png')],
        load: { url: server.url, cacheDir: join(root, 'cache') },
        python: process.execPath,
        worker: await okWorker(),
      });
      expect(code).toBe(0);
      const report = JSON.parse(readFileSync(join(root, 'render.json'), 'utf8')) as RenderReport;
      expect(report).toMatchObject({ scored: 1, rendered: 1, failed: 0 });
      expect(existsSync(join(root, 'png'))).toBe(false);
      expect(lines.join('\n')).toContain('rendered 1/1 (100.00%)');
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the pictures when a caller is going to look at them', async () => {
    const server = await serve(corpus);
    const root = mkdtempSync(join(tmpdir(), 'nl2charts-keep-'));
    try {
      const code = await entryRender(ENTRY, MODULE_URL, () => undefined, {
        argv: ['--keep', '--json', '--out', join(root, 'png')],
        load: { url: server.url, cacheDir: join(root, 'cache') },
        python: process.execPath,
        worker: await okWorker(),
      });
      expect(code).toBe(0);
      expect(readdirSync(join(root, 'png'))).toEqual(['0.png']);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints the report as json when it is asked to, and exits one when a chart failed', async () => {
    const server = await serve(corpus);
    const root = mkdtempSync(join(tmpdir(), 'nl2charts-fail-'));
    const lines: string[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'nl2charts-bad-'));
    const workerPath = join(dir, 'worker.mjs');
    await writeFile(
      workerPath,
      `
      let pending = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split('\\n');
        pending = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const job = JSON.parse(line);
          process.stdout.write(JSON.stringify({ id: job.id, ok: false, error: 'ValueError: boom' }) + '\\n');
        }
      });
    `,
    );
    try {
      const code = await entryRender(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--json', '--out', join(root, 'png')],
        load: { url: server.url, cacheDir: join(root, 'cache') },
        python: process.execPath,
        worker: workerPath,
      });
      expect(code).toBe(1);
      const printed = JSON.parse(lines.find((line) => line.trimStart().startsWith('{')) as string) as RenderReport;
      expect(printed.failed).toBe(1);
      expect(printed.failures[0]?.error).toBe('ValueError: boom');
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a bad argument and a refused download instead of throwing at the caller', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nl2charts-arg-'));
    const lines: string[] = [];
    try {
      const bad = await entryRender(ENTRY, MODULE_URL, (line) => lines.push(line), { argv: ['--nope'] });
      expect(bad).toBe(1);
      expect(lines.join('\n')).toContain('unknown argument --nope');
      // A corpus that cannot be downloaded is a failure the command reports, not an exception a
      // workflow log has to parse out of a stack trace.
      const missing = await entryRender(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--out', join(root, 'png')],
        load: { url: 'http://127.0.0.1:9/Text2Vis.csv', cacheDir: join(root, 'cache') },
      });
      expect(missing).toBe(1);
      expect(lines.join('\n')).toContain('text2vis:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('contributes no exit code when it is imported rather than run', async () => {
    expect(await entryRender(undefined, MODULE_URL, () => undefined)).toBeUndefined();
  });
});

describe('a worker that misbehaves in the two ways the protocol has to survive', () => {
  it('stops a worker that outlives its budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nl2charts-slow-'));
    const path = join(dir, 'worker.mjs');
    await writeFile(path, 'process.stdin.resume(); setInterval(() => undefined, 1000);\n');
    try {
      await expect(
        renderJobs([job('0')], { outDir: join(dir, 'png'), python: process.execPath, worker: path, timeoutMs: 60 }),
      ).rejects.toThrow(/exited with null/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('survives a worker that exits before reading its input', async () => {
    // Writing to a closed pipe is an EPIPE this process would otherwise crash on, before it could
    // report the exit code that explains the empty report.
    const dir = await mkdtemp(join(tmpdir(), 'nl2charts-gone-'));
    const path = join(dir, 'worker.mjs');
    await writeFile(path, 'process.exit(0);\n');
    try {
      await expect(renderJobs([job('0')], { outDir: join(dir, 'png'), python: process.execPath, worker: path })).rejects.toThrow(
        /no verdict for row 0/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads the interpreter from the environment when the caller names none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nl2charts-env-'));
    const path = join(dir, 'worker.mjs');
    await writeFile(
      path,
      `
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        for (const line of chunk.split('\\n')) {
          if (!line.trim()) continue;
          const job = JSON.parse(line);
          process.stdout.write(JSON.stringify({ id: job.id, ok: true, ms: 1, bytes: 2 }) + '\\n');
        }
      });
    `,
    );
    const previous = process.env.TEXT2VIS_PYTHON;
    process.env.TEXT2VIS_PYTHON = process.execPath;
    try {
      const verdicts = await renderJobs([job('0')], { outDir: join(dir, 'png'), worker: path });
      expect(verdicts[0]?.ok).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TEXT2VIS_PYTHON;
      else process.env.TEXT2VIS_PYTHON = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the stream and the failure path the protocol still has to survive', () => {
  it('ignores the blank lines a worker may write between verdicts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nl2charts-blank-'));
    const path = join(dir, 'worker.mjs');
    await writeFile(
      path,
      `
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        for (const line of chunk.split('\\n')) {
          if (!line.trim()) continue;
          const job = JSON.parse(line);
          process.stdout.write('\\n' + JSON.stringify({ id: job.id, ok: true, ms: 1, bytes: 2 }) + '\\n\\n');
        }
      });
    `,
    );
    try {
      const verdicts = await renderJobs([job('0')], { outDir: join(dir, 'png'), python: process.execPath, worker: path });
      expect(verdicts).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a transport that threw something which is not an Error', async () => {
    // A hand-written `throw 'timeout'` produces a rejection with no message property, and a command
    // that printed `undefined` for it would be a log line nobody can act on.
    const root = mkdtempSync(join(tmpdir(), 'nl2charts-thrown-'));
    const lines: string[] = [];
    const ENTRY = resolve('eval/text2vis/render.ts');
    try {
      const code = await entryRender(ENTRY, pathToFileURL(ENTRY).href, (line) => lines.push(line), {
        argv: ['--out', join(root, 'png')],
        load: {
          cacheDir: join(root, 'cache'),
          url: 'http://127.0.0.1:9/Text2Vis.csv',
          fetchImpl: (() => Promise.reject('timeout')) as unknown as typeof fetch,
        },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('text2vis: timeout');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
