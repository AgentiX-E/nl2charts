import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createHttpProvider } from '@agentix-e/nl2charts-ai';
import type { ProfileInput } from '../eval/text2vis/profile.js';
import {
  assertJudgeReport,
  buildJudgePrompt,
  defaultJudgeProvider,
  describeJudge,
  probeVision,
  sawRed,
  entryJudge,
  JUDGE_DIMENSIONS,
  JUDGE_SYSTEM,
  judgeJobs,
  judgeJobsWith,
  parseJudge,
  parseJudgeArgs,
  readRender,
  summarizeJudge,
  VISION_PROBE,
} from '../eval/text2vis/judge.js';
import type { JudgeJob, JudgeReport, JudgeVerdict } from '../eval/text2vis/judge.js';
import type { ChartJobs } from '../eval/text2vis/render.js';

/** The bytes of a real one-pixel PNG, so an assertion about "the file was read" reads real bytes. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const row = (prompt: string, label: string): ProfileInput => ({
  prompt,
  label,
  tableData: 'product,revenue\nalpha,10\nbeta,20\ngamma,30\ndelta,40',
});

/** The probe answer a run that could see would have produced. */
const SEEN = { answer: 'red', seen: true };

const job = (id: string, mark: string): JudgeJob => ({ id, mark, label: 'Bar Chart', question: 'top products by revenue', png: `/tmp/${id}.png` });

const chartsOf = (ids: readonly string[], refused: readonly { readonly id: string; readonly code: string }[] = []): ChartJobs => ({
  jobs: ids.map((id) => ({ id, mark: 'bar' as const, code: 'plt.bar(x, y)' })),
  refusals: refused.map((one) => ({ id: one.id, mark: 'declined' as const, code: one.code, reason: 'why' })),
});

describe('two scores out of a reply, and the replies it refuses', () => {
  it('reads the JSON object the prompt asked for', () => {
    expect(parseJudge('{"chart_correctness": 8, "readability": 7}')).toEqual({ chart_correctness: 8, readability: 7 });
  });

  it('reads it out of a code fence, which a small model adds unbidden', () => {
    expect(parseJudge('```json\n{"chart_correctness": 9, "readability": 6}\n```')).toEqual({ chart_correctness: 9, readability: 6 });
  });

  it('reads it out of a sentence that also says other things', () => {
    expect(parseJudge('Here is my grade: {"chart_correctness": 4, "readability": 10} — done.')).toEqual({
      chart_correctness: 4,
      readability: 10,
    });
  });

  it('reads the labelled form, which is the same statement without the braces', () => {
    expect(parseJudge('chart_correctness: 7\nreadability: 9')).toEqual({ chart_correctness: 7, readability: 9 });
  });

  it('keeps a decimal a grader insisted on, and does not round it into a different scale', () => {
    expect(parseJudge('{"chart_correctness": 7.5, "readability": 8}')).toEqual({ chart_correctness: 7.5, readability: 8 });
  });

  it('refuses an unlabelled pair, because only the prompt knows which number is which', () => {
    expect(() => parseJudge('8 7')).toThrow(/named neither score/);
  });

  it('refuses a number off the scale rather than clamping it', () => {
    expect(() => parseJudge('{"chart_correctness": 87, "readability": 7}')).toThrow(/outside the 0-10 scale/);
    expect(() => parseJudge('{"chart_correctness": -1, "readability": 7}')).toThrow(/outside the 0-10 scale/);
  });

  it('refuses prose, an empty reply, and a JSON object with only one of the two', () => {
    expect(() => parseJudge('the chart is quite good')).toThrow(/named neither score/);
    expect(() => parseJudge('')).toThrow(/\(empty reply\)/);
    expect(() => parseJudge('{"chart_correctness": 8}')).toThrow(/named neither score/);
  });

  it('quotes what it was given, because that is the only thing that explains the refusal', () => {
    expect(() => parseJudge('I would say the readability is high')).toThrow(/I would say the readability is high/);
  });

  it('falls back to the labelled form when the braces are there but the JSON is not', () => {
    // A model that writes `{chart_correctness: 8}` without quoting has written an unparseable
    // object; the two labels are still unambiguous, and refusing it would buy a retry to learn
    // what the sentence already said.
    expect(parseJudge('{chart_correctness: 8, readability: 9}')).toEqual({ chart_correctness: 8, readability: 9 });
  });

  it('refuses a JSON array and a null, which are objects to a loose reader', () => {
    expect(() => parseJudge('[8, 7]')).toThrow(/named neither score/);
    expect(() => parseJudge('null')).toThrow(/named neither score/);
    // A truncated object is the shape a token cap leaves behind.
    expect(() => parseJudge('{"chart_correctness": 8, "readability"')).toThrow(/named neither score/);
  });
});

describe('the prompt', () => {
  it('asks for both dimensions in one object, and says the format twice', () => {
    expect(JUDGE_SYSTEM).toContain('"chart_correctness"');
    expect(JUDGE_SYSTEM).toContain('"readability"');
    expect(JUDGE_SYSTEM).toContain('Integers only');
    expect(JUDGE_DIMENSIONS).toEqual(['chart_correctness', 'readability']);
  });

  it('names the corpus label as the reference, without announcing it as the answer', () => {
    const prompt = buildJudgePrompt(job('0', 'bar'));
    expect(prompt).toContain('top products by revenue');
    expect(prompt).toContain('labelled "Bar Chart"');
    expect(prompt).not.toMatch(/the correct chart is/i);
  });
});

describe('which figures get graded, and what happens to the rest', () => {
  it('grades the drawn rows and accounts for every other row by name', () => {
    const rows = [row('a', 'Bar Chart'), row('b', 'Bar Chart'), row('c', 'Gauge Chart')];
    const { jobs, skipped } = judgeJobs(rows, chartsOf(['0', '1'], [{ id: '2', code: 'profile:refused' }]), ['1'], '/png');
    // The failed row is a skip, not a gap: it drew no figure to grade.
    expect(jobs.map((one) => one.id)).toEqual(['0']);
    expect(skipped).toEqual([
      { id: '1', reason: 'render:failed' },
      { id: '2', reason: 'profile:refused' },
    ]);
    expect(jobs[0]?.png).toBe('/png/0.png');
    expect(jobs[0]?.label).toBe('Bar Chart');
    expect(jobs[0]?.question).toBe('a');
  });

  it('refuses a chart whose id names no row', () => {
    expect(() => judgeJobs([row('a', 'Bar Chart')], chartsOf(['7']), [], '/png')).toThrow(/names a row the corpus does not have/);
  });

  it('refuses a failure the corpus did not produce, rather than losing it', () => {
    expect(() => judgeJobs([row('a', 'Bar Chart')], chartsOf(['0']), ['9'], '/png')).toThrow(/which drew no chart/);
  });

  it('refuses a partition that does not add up', () => {
    const two = [row('a', 'Bar Chart'), row('b', 'Bar Chart')];
    expect(() => judgeJobs(two, chartsOf(['0']), [], '/png')).toThrow(/do not account for 2 rows/);
  });
});

describe('the report is two means and their denominators', () => {
  const jobs = [job('0', 'bar'), job('1', 'bar'), job('2', 'pie')];
  const verdicts: readonly JudgeVerdict[] = [
    { id: '0', chart_correctness: 10, readability: 8 },
    { id: '1', chart_correctness: 0, readability: 6 },
    { id: '2', chart_correctness: 8, readability: 8 },
  ];

  it('averages each dimension over the rows that were graded, to two places', () => {
    const report = summarizeJudge(6, 3, jobs, [{ id: '3', reason: 'profile:none' }, { id: '4', reason: 'render:failed' }, { id: '5', reason: 'NL2C_E_NOT_SUPPORTED' }], verdicts, 3, SEEN);
    expect(report.means).toEqual({ chart_correctness: 6, readability: 7.33 });
    expect(report).toMatchObject({ scored: 6, charts: 3, judged: 3, failed: 0, notSelected: 0, skipped: 3, calls: 3, callsPerRow: 1 });
    expect(assertJudgeReport(report)).toBeUndefined();
  });

  it('keeps a failure out of the mean and counts it beside them', () => {
    const report = summarizeJudge(2, 2, jobs.slice(0, 2), [], [{ id: '0', chart_correctness: 10, readability: 10, }, { id: '1', error: 'socket hang up' }], 2, SEEN);
    expect(report.means).toEqual({ chart_correctness: 10, readability: 10 });
    expect(report.failed).toBe(1);
    expect(report.failures).toEqual([{ id: '1', error: 'socket hang up' }]);
    expect(assertJudgeReport(report)).toBeUndefined();
  });

  it('publishes no pass rate, because a grader score has no calibrated threshold', () => {
    const report = summarizeJudge(1, 1, [job('0', 'bar')], [], verdicts.slice(0, 1), 1, SEEN);
    const keys = Object.keys(report).join(' ');
    expect(keys).not.toMatch(/pass|accuracy|correct(?!ness)/i);
    expect(Object.keys(report.means)).toEqual(['chart_correctness', 'readability']);
  });

  it('splits by mark, biggest bucket first, so a family that scores badly is visible', () => {
    const report = summarizeJudge(3, 3, jobs, [], verdicts, 3, SEEN);
    expect(report.byMark.map((one) => [one.mark, one.rows])).toEqual([
      ['bar', 2],
      ['pie', 1],
    ]);
    expect(report.byMark[0]).toMatchObject({ judged: 2, chart_correctness: 5, readability: 7 });
  });

  it('breaks a tie between two marks by name, so two runs of one corpus read the same', () => {
    const tied = [job('0', 'pie'), job('1', 'bar')];
    const report = summarizeJudge(2, 2, tied, [], [
      { id: '0', chart_correctness: 1, readability: 1 },
      { id: '1', chart_correctness: 2, readability: 2 },
    ], 2, SEEN);
    expect(report.byMark.map((one) => one.mark)).toEqual(['bar', 'pie']);
  });

  it('reports zero-and-zero on an empty set rather than NaN', () => {
    const report = summarizeJudge(2, 2, [job('0', 'bar'), job('1', 'bar')], [], [], 0, SEEN);
    expect(report.means).toEqual({ chart_correctness: 0, readability: 0 });
    expect(report.callsPerRow).toBe(0);
    expect(assertJudgeReport(report)).toBeUndefined();
    expect(describeJudge(report).join('\n')).toContain('chart_correctness 0.00/10');
  });

  it('refuses a verdict for a row that was never offered', () => {
    expect(() => summarizeJudge(1, 1, [job('0', 'bar')], [], [{ id: '9', chart_correctness: 1, readability: 1 }], 1, SEEN)).toThrow(
      /has no job/,
    );
  });

  it('prints the two means, the denominators and the failures, and nothing else', () => {
    const report = summarizeJudge(3, 3, jobs, [], verdicts, 3, SEEN);
    const lines = describeJudge(report).join('\n');
    expect(lines).toContain('judged 3/3 charts');
    expect(lines).toContain('chart_correctness 6.00/10, readability 7.33/10');
    expect(lines).toContain('calls 3, 1.000 per judged row');
    expect(lines).toContain('bar: 2/2 judged, correctness 5.00, readability 7.00');
  });
});

describe('what a report has to be before a mean can be read out of it', () => {
  const base: JudgeReport = {
    dimensions: [...JUDGE_DIMENSIONS],
    scored: 3,
    charts: 2,
    judged: 2,
    failed: 0,
    notSelected: 0,
    skipped: 1,
    means: { chart_correctness: 8, readability: 8 },
    byMark: [],
    calls: 2,
    callsPerRow: 1,
    failures: [],
    probe: SEEN,
  };
  const reject = (patch: Partial<JudgeReport>, says: RegExp): void => {
    expect(() => assertJudgeReport({ ...base, ...patch })).toThrow(says);
  };

  it('accepts a report that adds up', () => {
    expect(() => assertJudgeReport(base)).not.toThrow();
  });

  it('refuses a run that spent more than one call per attempted row', () => {
    reject({ calls: 3 }, /spends one call per attempted row/);
    reject({ callsPerRow: 2.5 }, /this instrument spends one/);
  });

  it('refuses a chart that is neither judged, failed, nor declared unselected', () => {
    reject({ charts: 3, judged: 2 }, /do not account for 3 charts/);
  });

  it('refuses a row that stopped existing between the two partitions', () => {
    reject({ scored: 4 }, /do not account for 4 scored rows/);
  });

  it('refuses a count of failures with fewer messages than failures', () => {
    reject({ failed: 1, calls: 3, charts: 3, scored: 4, failures: [] }, /1 failures and 0 messages/);
  });

  it('refuses a reading whose grader could not name the colour of a red image', () => {
    reject({ probe: { answer: 'I cannot see images', seen: false } }, /the endpoint did not say red to a red image/);
  });

  it('refuses a mean outside the scale the prompt asked for', () => {
    reject({ means: { chart_correctness: 11, readability: 8 } }, /outside the scale/);
  });

  it('refuses a call count lower than the rows it claims to have attempted', () => {
    reject({ calls: 1 }, /spends one call per attempted row/);
  });
});

describe('grading a batch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nl2charts-judge-'));
  const png = join(dir, '0.png');
  writeFileSync(png, PIXEL_PNG);

  const responder = (reply: string): { provider: ReturnType<typeof createHttpProvider>; bodies: Record<string, unknown>[]; close: () => Promise<void> } => {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', () => {
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ model: 'judge-test', choices: [{ message: { content: reply } }], usage: { prompt_tokens: 900, completion_tokens: 14 } }));
      });
    });
    const listening = new Promise<number>((ready) => {
      server.listen(0, '127.0.0.1', () => ready((server.address() as AddressInfo).port));
    });
    const provider = createHttpProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'judge-test',
      capabilities: { vision: true },
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        const port = await listening;
        return fetch(`http://127.0.0.1:${String(port)}/v1/chat/completions`, init);
      }) as typeof fetch,
    });
    return { provider, bodies, close: () => new Promise<void>((done) => server.close(() => done())) };
  };

  it('sends the picture with the question and reads two scores back', async () => {
    const { provider, bodies, close } = responder('{"chart_correctness": 9, "readability": 5}');
    try {
      const verdicts = await judgeJobsWith([{ ...job('0', 'bar'), png }], { provider });
      expect(verdicts).toEqual([{ id: '0', chart_correctness: 9, readability: 5, ms: expect.any(Number) as number }]);
      const messages = bodies[0]?.messages as { readonly role: string; readonly content: unknown }[];
      expect(messages).toHaveLength(2);
      const parts = messages[1]?.content as { readonly type: string; readonly image_url?: { readonly url: string } }[];
      expect(parts[0]).toEqual({ type: 'text', text: expect.stringContaining('top products by revenue') as unknown as string });
      expect(parts[1]?.image_url?.url).toBe(`data:image/png;base64,${PIXEL_PNG.toString('base64')}`);
      // One call per row, which is the criterion this instrument was registered under.
      expect(bodies).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('turns a missing file into that row failing, not into a run that throws', async () => {
    const { provider, close } = responder('{"chart_correctness": 9, "readability": 5}');
    try {
      const verdicts = await judgeJobsWith([{ ...job('0', 'bar'), png: join(dir, 'absent.png') }], { provider });
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]?.error).toMatch(/ENOENT|no such file/);
      expect(verdicts[0]?.chart_correctness).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('turns an unreadable reply into that row failing, quoting the reply', async () => {
    const { provider, close } = responder('the chart looks nice');
    try {
      const verdicts = await judgeJobsWith([{ ...job('0', 'bar'), png }], { provider });
      expect(verdicts[0]?.error).toMatch(/named neither score: the chart looks nice/);
    } finally {
      await close();
    }
  });

  it('grades the rows after a failure, so one bad row costs one grade', async () => {
    let seen = 0;
    const provider = {
      id: 'flaky',
      model: 'flaky',
      complete: async () => {
        seen += 1;
        if (seen === 1) throw new Error('429 rate limited');
        return { text: '{"chart_correctness": 3, "readability": 4}', model: 'flaky' };
      },
    };
    const verdicts = await judgeJobsWith([{ ...job('0', 'bar'), png }, { ...job('1', 'bar'), png }], { provider });
    expect(verdicts.map((one) => one.error ?? 'ok')).toEqual(['429 rate limited', 'ok']);
  });

  it('keeps a thrown string as the row error, because a provider is not obliged to throw Errors', async () => {
    const provider = {
      id: 'p',
      model: 'p',
      complete: async () => {
        throw 'upstream said no';
      },
    };
    const verdicts = await judgeJobsWith([job('0', 'bar')], {
      provider,
      readImage: async () => ({ mediaType: 'image/png', data: PIXEL_PNG.toString('base64') }),
    });
    expect(verdicts[0]?.error).toBe('upstream said no');
  });

  it('reads the image through the seam it was given', async () => {
    const asked: string[] = [];
    const provider = { id: 'p', model: 'p', complete: async () => ({ text: '{"chart_correctness": 1, "readability": 2}', model: 'p' }) };
    const verdicts = await judgeJobsWith([job('0', 'bar')], {
      provider,
      readImage: async (path) => {
        asked.push(path);
        return { mediaType: 'image/png', data: PIXEL_PNG.toString('base64') };
      },
    });
    expect(asked).toEqual(['/tmp/0.png']);
    expect(verdicts[0]?.chart_correctness).toBe(1);
  });

  it('reports how long each grade took, from the clock it was given', async () => {
    let clock = 0;
    const provider = { id: 'p', model: 'p', complete: async () => ({ text: '{"chart_correctness": 5, "readability": 5}', model: 'p' }) };
    const verdicts = await judgeJobsWith([job('0', 'bar')], {
      provider,
      now: () => {
        clock += 7;
        return clock;
      },
      readImage: async () => ({ mediaType: 'image/png', data: PIXEL_PNG.toString('base64') }),
    });
    // Two ticks seven apart: the reading is the difference, which is what a duration is.
    expect(verdicts[0]?.ms).toBe(7);
  });
});

describe('the probe that proves the endpoint could see', () => {
  it('reads a colour as a reader that saw one, and refuses a reply that describes itself', () => {
    expect(sawRed('Red')).toBe(true);
    expect(sawRed('The dominant colour is crimson.')).toBe(true);
    expect(sawRed('#FF0000')).toBe(true);
    expect(sawRed('I cannot see images.')).toBe(false);
    expect(sawRed('I am sorry, I am a text-only model.')).toBe(false);
    expect(sawRed('')).toBe(false);
    // "reduce" and "credit" contain letters of "red" and are not a colour: the probe matches a word.
    expect(sawRed('reduced credit')).toBe(false);
  });

  it('asks one question about one image, and keeps the answer', async () => {
    let body: Record<string, unknown> = {};
    const provider = {
      id: 'p',
      model: 'p',
      complete: async (request: { readonly messages: readonly { readonly content: string; readonly images?: readonly unknown[] }[] }) => {
        body = { messages: request.messages };
        return { text: '  Red.\n', model: 'p' };
      },
    };
    const probe = await probeVision(provider);
    expect(probe).toEqual({ answer: 'Red.', seen: true });
    const messages = body.messages as { readonly role: string; readonly content: string; readonly images?: readonly unknown[] }[];
    expect(messages[1]?.content).toBe(VISION_PROBE);
    expect(messages[1]?.images).toHaveLength(1);
  });

  it('turns a refusal into an answer nobody saw, rather than into a stack trace', async () => {
    const refused = { id: 'p', model: 'p', complete: async () => ({ text: 'I cannot see images.', model: 'p' }) };
    expect(await probeVision(refused)).toEqual({ answer: 'I cannot see images.', seen: false });
    const broken = {
      id: 'p',
      model: 'p',
      complete: async () => {
        throw new Error('declares no vision capability');
      },
    };
    expect(await probeVision(broken)).toEqual({ answer: 'declares no vision capability', seen: false });
    const stringly = {
      id: 'p',
      model: 'p',
      complete: async () => {
        throw 'no route to host';
      },
    };
    expect(await probeVision(stringly)).toEqual({ answer: 'no route to host', seen: false });
  });
});

describe('the render artifact the denominator comes from', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nl2charts-render-read-'));
  const write = (name: string, text: string): string => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };

  it('reads the failure ids and the rendered count', async () => {
    const path = write('ok.json', JSON.stringify({ rendered: 2, failed: 1, failures: [{ id: '7', mark: 'bar', error: 'E' }] }));
    expect(await readRender(path)).toEqual({ failed: ['7'], rendered: 2 });
  });

  it('says what to do when there is no artifact, instead of grading nothing', async () => {
    await expect(readRender(join(dir, 'absent.json'))).rejects.toThrow(/run the renderer with --keep first/);
  });

  it('refuses a file that is not a render report', async () => {
    await expect(readRender(write('other.json', '{"rows": 3}'))).rejects.toThrow(/is not a render report/);
  });

  it('refuses an artifact whose own counts disagree', async () => {
    await expect(readRender(write('bad.json', JSON.stringify({ rendered: 1, failed: 2, failures: [] })))).rejects.toThrow(
      /reports 2 failures and lists 0/,
    );
  });
});

describe('the command line', () => {
  it('defaults to the corpus png directory and no artifact', () => {
    expect(parseJudgeArgs([])).toEqual({ png: 'eval/.cache/text2vis/png', json: false });
  });

  it('takes the five flags it documents', () => {
    expect(parseJudgeArgs(['--png', '/p', '--render', '/r.json', '--artifact', '/j.json', '--limit', '40', '--json'])).toEqual({
      png: '/p',
      render: '/r.json',
      artifact: '/j.json',
      limit: 40,
      json: true,
    });
  });

  it('refuses a flag it does not use, and a flag without a value', () => {
    expect(() => parseJudgeArgs(['--nope'])).toThrow(/unknown argument --nope/);
    expect(() => parseJudgeArgs(['--png'])).toThrow(/--png needs a value/);
    expect(() => parseJudgeArgs(['--limit', '0'])).toThrow(/positive whole number/);
    expect(() => parseJudgeArgs(['--limit', 'ten'])).toThrow(/positive whole number/);
  });
});

describe('the judge command, over a real socket and a real PNG', () => {
  const serve = async (body: string): Promise<{ url: string; close: () => Promise<void> }> => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/csv' });
      response.end(body);
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${String(port)}/Text2Vis.csv`, close: () => new Promise<void>((done) => server.close(() => done())) };
  };

  const FIELDS = ['Question', 'Prompt', 'Answer', 'Visualization Code', 'Chart Type', 'Table Data'];
  const corpus = `${FIELDS.join(',')}\nTop products by revenue,You are a data science assistant.,Widget,"plt.bar([1], [2])",Bar Chart,"product,revenue\nalpha,10\nbeta,20\ngamma,30\ndelta,40"\n`;
  const ENTRY = join(process.cwd(), 'eval/text2vis/judge.ts');
  const MODULE_URL = pathToFileURL(ENTRY).href;
  const grader = (reply: string): { provider: ReturnType<typeof createHttpProvider>; calls: () => number } => {
    let calls = 0;
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', () => {
        calls += 1;
        // The first call is the vision probe, and it is answered the way an endpoint that can see
        // answers. Everything after it is a row, and gets the reply under test.
        const text = body.includes('dominant colour') ? 'red' : reply;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ model: 'grade', choices: [{ message: { content: text } }], usage: { prompt_tokens: 800, completion_tokens: 12 } }));
      });
    });
    const listening = new Promise<number>((ready) => {
      server.listen(0, '127.0.0.1', () => ready((server.address() as AddressInfo).port));
    });
    return {
      provider: createHttpProvider({
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'grade',
        capabilities: { vision: true },
        fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
          const port = await listening;
          return fetch(`http://127.0.0.1:${String(port)}/v1/chat/completions`, init);
        }) as typeof fetch,
      }),
      calls: () => calls,
    };
  };

  const prepare = (root: string): void => {
    writeFileSync(join(root, '0.png'), PIXEL_PNG);
    writeFileSync(join(root, 'render.json'), JSON.stringify({ rendered: 1, failed: 0, failures: [] }));
  };

  it('grades the corpus, writes the report, and spends one call', async () => {
    const server = await serve(corpus);
    const root = mkdtempSync(join(tmpdir(), 'nl2charts-judge-entry-'));
    const { provider, calls } = grader('{"chart_correctness": 6, "readability": 9}');
    try {
      prepare(root);
      const lines: string[] = [];
      const code = await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--render', join(root, 'render.json'), '--png', root, '--artifact', join(root, 'judge.json')],
        load: { url: server.url, cacheDir: join(root, 'cache') },
        provider,
      });
      expect(code).toBe(0);
      const report = JSON.parse(readFileSync(join(root, 'judge.json'), 'utf8')) as JudgeReport;
      expect(report).toMatchObject({
        scored: 1,
        charts: 1,
        judged: 1,
        failed: 0,
        notSelected: 0,
        skipped: 0,
        calls: 1,
        callsPerRow: 1,
        means: { chart_correctness: 6, readability: 9 },
      });
      // Two calls: the probe, and the one row. The report's own price is per row and stays 1.
      expect(calls()).toBe(2);
      expect(report.calls).toBe(1);
      expect(lines.join('\n')).toContain('judged 1/1 charts');
      expect(lines.join('\n')).toContain('wrote');
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('grades a sample when a caller is pricing the instrument', async () => {
    const server = await serve(`${corpus}Second question,You are a data science assistant.,Widget,"plt.bar([1], [2])",Bar Chart,"product,revenue\nalpha,10\nbeta,20\ngamma,30\ndelta,40"\n`);
    const root = mkdtempSync(join(tmpdir(), 'nl2charts-judge-limit-'));
    const { provider, calls } = grader('{"chart_correctness": 4, "readability": 4}');
    try {
      writeFileSync(join(root, '0.png'), PIXEL_PNG);
      writeFileSync(join(root, '1.png'), PIXEL_PNG);
      writeFileSync(join(root, 'render.json'), JSON.stringify({ rendered: 2, failed: 0, failures: [] }));
      const lines: string[] = [];
      const code = await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--render', join(root, 'render.json'), '--png', root, '--limit', '1', '--artifact', join(root, 'judge.json')],
        load: { url: server.url, cacheDir: join(root, 'cache') },
        provider,
      });
      expect(code).toBe(0);
      const report = JSON.parse(readFileSync(join(root, 'judge.json'), 'utf8')) as JudgeReport;
      expect(report).toMatchObject({ charts: 2, judged: 1, notSelected: 1, calls: 1 });
      expect(calls()).toBe(2);
      expect(lines.join('\n')).toContain('1 of 2 charts selected');
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to grade against an artifact that is about a different row set', async () => {
    const server = await serve(corpus);
    const root = mkdtempSync(join(tmpdir(), 'nl2charts-judge-mismatch-'));
    const { provider } = grader('{"chart_correctness": 6, "readability": 9}');
    try {
      writeFileSync(join(root, '0.png'), PIXEL_PNG);
      writeFileSync(join(root, 'render.json'), JSON.stringify({ rendered: 4, failed: 0, failures: [] }));
      const lines: string[] = [];
      const code = await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--render', join(root, 'render.json'), '--png', root],
        load: { url: server.url, cacheDir: join(root, 'cache') },
        provider,
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/they are not the same row set/);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('says why it cannot run without a render artifact, and without being the entry', async () => {
    const lines: string[] = [];
    expect(await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), { argv: [] })).toBe(1);
    expect(lines.join('\n')).toMatch(/--render <path> is required/);
    expect(await entryJudge(undefined, MODULE_URL, () => undefined)).toBeUndefined();
  });

  it('takes the default provider from the environment when a caller names none', () => {
    const declared = defaultJudgeProvider({ LLM_BASE_URL: 'http://127.0.0.1:1/v1', LLM_API_KEY: 'k', LLM_MODEL: 'glm-4v' });
    expect(declared.model).toBe('glm-4v');
    // The declaration this instrument cannot default: a blind endpoint would be refused, and the
    // refusal would arrive after the run had been priced.
    expect(declared.capabilities?.vision).toBe(true);
    const bare = defaultJudgeProvider({});
    expect(bare.model).toBe('deepseek-chat');
    expect(bare.capabilities?.vision).toBe(true);
    // The key is not readable from the provider by design, so the two spellings are held to what is
    // observable: either name produces a provider rather than a crash on a missing variable.
    expect(defaultJudgeProvider({ DEEPSEEK_API_KEY: 'one' }).id).toBe('http');
    expect(defaultJudgeProvider({ LLM_API_KEY: 'two' }).id).toBe('http');
  });

  it('writes the report as json when it is asked to, and reads the image through a caller seam', async () => {
    const server = await serve(corpus);
    const root = mkdtempSync(join(tmpdir(), 'nl2charts-judge-json-'));
    const { provider } = grader('{"chart_correctness": 2, "readability": 3}');
    const asked: string[] = [];
    try {
      prepare(root);
      const lines: string[] = [];
      const code = await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--render', join(root, 'render.json'), '--png', root, '--json'],
        load: { url: server.url, cacheDir: join(root, 'cache') },
        provider,
        readImage: async (path) => {
          asked.push(path);
          return { mediaType: 'image/png', data: PIXEL_PNG.toString('base64') };
        },
      });
      expect(code).toBe(0);
      expect(asked).toEqual([join(root, '0.png')]);
      const printed = lines.join('\n');
      expect(printed).toContain('"chart_correctness": 2');
      expect(printed).toContain('"readability": 3');
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults its argument list, which is what a bare command line is', async () => {
    const lines: string[] = [];
    const { provider } = grader('{"chart_correctness": 2, "readability": 3}');
    expect(await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), { provider })).toBe(1);
    expect(lines.join('\n')).toMatch(/--render <path> is required/);
  });

  it('reports a transport that threw a string rather than an Error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nl2charts-judge-string-'));
    const { provider } = grader('{"chart_correctness": 2, "readability": 3}');
    try {
      prepare(root);
      const lines: string[] = [];
      const code = await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--render', join(root, 'render.json'), '--png', root],
        load: {
          cacheDir: join(root, 'cache'),
          url: 'http://127.0.0.1:1/Text2Vis.csv',
          fetchImpl: (() => {
            throw 'connection reset';
          }) as unknown as typeof fetch,
        },
        provider,
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('connection reset');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses the whole run when the endpoint cannot name a colour, before grading a row', async () => {
    const server = await serve(corpus);
    const root = mkdtempSync(join(tmpdir(), 'nl2charts-judge-blind-'));
    let calls = 0;
    const blind = {
      id: 'blind',
      model: 'text-only',
      complete: async () => {
        calls += 1;
        return { text: 'I am a text-only model and cannot see images.', model: 'text-only' };
      },
    };
    try {
      prepare(root);
      const lines: string[] = [];
      const code = await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--render', join(root, 'render.json'), '--png', root],
        load: { url: server.url, cacheDir: join(root, 'cache') },
        provider: blind,
      });
      expect(code).toBe(1);
      // One call: the probe. The 1,286 that followed in a run without this check were the bill this
      // instrument exists to avoid paying.
      expect(calls).toBe(1);
      expect(lines.join('\n')).toMatch(/did not see the probe image/);
      expect(existsSync(join(root, 'judge.json'))).toBe(false);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a run whose every row failed as a failure, not as a zero mean', async () => {
    const server = await serve(corpus);
    const root = mkdtempSync(join(tmpdir(), 'nl2charts-judge-fail-'));
    const { provider } = grader('not json at all');
    try {
      prepare(root);
      const lines: string[] = [];
      const code = await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--render', join(root, 'render.json'), '--png', root, '--artifact', join(root, 'judge.json')],
        load: { url: server.url, cacheDir: join(root, 'cache') },
        provider,
      });
      expect(code).toBe(1);
      const report = JSON.parse(readFileSync(join(root, 'judge.json'), 'utf8')) as JudgeReport;
      expect(report).toMatchObject({ judged: 0, failed: 1, calls: 1 });
      expect(existsSync(join(root, 'judge.json'))).toBe(true);
      expect(lines.join('\n')).toMatch(/FAILED row 0: the reply named neither score/);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
