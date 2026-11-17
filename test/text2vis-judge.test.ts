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
  classifyFailure,
  JUDGE_ENDPOINTS,
  describeJudge,
  JudgeReplyError,
  probeVision,
  resolveJudge,
  sawRed,
  entryJudge,
  JUDGE_DIMENSIONS,
  JUDGE_SYSTEM,
  judgeJobs,
  judgeJobsWith,
  parseJudge,
  parseJudgeArgs,
  readRender,
  REPLY_LIMIT,
  score,
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

/** The kind a refusal carries, for the assertions that are about the reason rather than the words. */
const kindOf = (reply: string, finishReason?: string): string => {
  try {
    parseJudge(reply, finishReason);
    return 'parsed';
  } catch (error) {
    return error instanceof JudgeReplyError ? error.kind : 'other';
  }
};

const row = (prompt: string, label: string): ProfileInput => ({
  prompt,
  label,
  tableData: 'product,revenue\nalpha,10\nbeta,20\ngamma,30\ndelta,40',
});

/** The probe answer a run that could see would have produced. */
const SEEN = { answer: 'red', seen: true };

/** Who graded, for the reports a test builds by hand: a mean without an author is not publishable. */
const GRADER = { endpoint: 'zhipu', model: 'glm-4.5v' };

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
    // One label is not "neither": a run that reads this as "neither" sends its reader after the
    // parser when the reply stopped for a reason the reply itself shows.
    expect(() => parseJudge('{"chart_correctness": 8}')).toThrow(/named chart_correctness and stopped before readability/);
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
    // A truncated object is the shape a token cap leaves behind, and it names the score it got to.
    expect(() => parseJudge('{"chart_correctness": 8, "readability"')).toThrow(
      /named chart_correctness and stopped before readability/,
    );
  });

  it('names the one score it read when the reply was cut, which "neither" would deny', () => {
    // Run 43979969822 lost 24 of 1,286 rows to replies that ended at `"readability":` and reported
    // all of them as "the reply named neither score". The message is the only repair instruction a
    // failed row carries, and this one pointed at the parser instead of at the budget.
    expect(() => parseJudge('{"chart_correctness": 2, "readability":')).toThrow(
      /named chart_correctness and stopped before readability/,
    );
    expect(() => parseJudge('{"chart_correctness": 2')).toThrow(/named chart_correctness and stopped before readability/);
  });

  it('says the token cap was the reason when the endpoint reported a length stop', () => {
    expect(() => parseJudge('{"chart_correctness": 2, "readability":', 'length')).toThrow(/finish=length/);
    expect(() => parseJudge('', 'length')).toThrow(/token cap/);
    // A stop that is not a cap is not blamed on one.
    expect(() => parseJudge('{"chart_correctness": 2', 'stop')).not.toThrow(/finish=length/);
  });

  it('carries the reason as a kind, so a report can count it without reading the sentence', () => {
    expect(kindOf('{"chart_correctness": 2')).toBe('partial');
    expect(kindOf('nothing here')).toBe('unreadable');
    expect(kindOf('{"chart_correctness": 87, "readability": 7}')).toBe('out-of-range');
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
  // Every verdict carries the reply it was parsed from, because the assertion added this round
  // refuses a row whose score cannot be re-read: a mean is a product of a parse, and a parse over a
  // reply nobody kept is a number no reader can audit.
  const verdicts: readonly JudgeVerdict[] = [
    { id: '0', chart_correctness: 10, readability: 8, reply: '{"chart_correctness": 10, "readability": 8}' },
    { id: '1', chart_correctness: 0, readability: 6, reply: '{"chart_correctness": 0, "readability": 6}' },
    { id: '2', chart_correctness: 8, readability: 8, reply: '{"chart_correctness": 8, "readability": 8}' },
  ];

  it('averages each dimension over the rows that were graded, to two places', () => {
    const report = summarizeJudge(6, 3, jobs, [{ id: '3', reason: 'profile:none' }, { id: '4', reason: 'render:failed' }, { id: '5', reason: 'NL2C_E_NOT_SUPPORTED' }], verdicts, 3, SEEN, GRADER);
    expect(report.means).toEqual({ chart_correctness: 6, readability: 7.33 });
    expect(report).toMatchObject({ scored: 6, charts: 3, judged: 3, failed: 0, notSelected: 0, skipped: 3, calls: 3, callsPerRow: 1 });
    expect(assertJudgeReport(report)).toBeUndefined();
  });

  it('keeps a failure out of the mean and counts it beside them', () => {
    const hangUp = Object.assign(new Error('socket hang up'), { code: 'NL2C_E_LLM_UNAVAILABLE' });
    const report = summarizeJudge(
      2,
      2,
      jobs.slice(0, 2),
      [],
      [
        { id: '0', chart_correctness: 10, readability: 10, reply: '{"chart_correctness": 10, "readability": 10}' },
        { id: '1', error: hangUp.message, failure: classifyFailure(hangUp) },
      ],
      2,
      SEEN,
      GRADER,
    );
    expect(report.means).toEqual({ chart_correctness: 10, readability: 10 });
    expect(report.failed).toBe(1);
    expect(report.failures).toEqual([{ id: '1', error: 'socket hang up', kind: 'unavailable' }]);
    // The count is the fact a reader wants from "1 failed": an outage and a truncated reply are
    // the same number and two different repairs.
    expect(report.failedByKind.unavailable).toBe(1);
    expect(report.failedByKind.truncated).toBe(0);
    expect(assertJudgeReport(report)).toBeUndefined();
  });

  it('publishes no pass rate, because a grader score has no calibrated threshold', () => {
    const report = summarizeJudge(1, 1, [job('0', 'bar')], [], verdicts.slice(0, 1), 1, SEEN, GRADER);
    const keys = Object.keys(report).join(' ');
    expect(keys).not.toMatch(/pass|accuracy|correct(?!ness)/i);
    expect(Object.keys(report.means)).toEqual(['chart_correctness', 'readability']);
  });

  it('splits by mark, biggest bucket first, so a family that scores badly is visible', () => {
    const report = summarizeJudge(3, 3, jobs, [], verdicts, 3, SEEN, GRADER);
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
    ], 2, SEEN, GRADER);
    expect(report.byMark.map((one) => one.mark)).toEqual(['bar', 'pie']);
  });

  it('reports no reading at all on an empty set, because zero is a claim about the charts', () => {
    const report = summarizeJudge(2, 2, [job('0', 'bar'), job('1', 'bar')], [], [], 0, SEEN, GRADER);
    // `null` and not NaN, and not zero either: a run where every call failed would otherwise publish
    // "chart_correctness 0.00", a mean over no readings presented as a verdict.
    expect(report.means).toEqual({ chart_correctness: null, readability: null });
    expect(report.callsPerRow).toBe(0);
    expect(assertJudgeReport(report)).toBeUndefined();
    expect(describeJudge(report).join('\n')).toContain('chart_correctness no reading, readability no reading');
  });

  it('says no reading for a mark whose every row failed, instead of zero', () => {
    // The first production reading printed `boxplot 0/1 judged, correctness 0.00` — a mean over zero
    // rows, which reads as "the one boxplot scored zero" when the truth was that its call timed out.
    const report = summarizeJudge(1, 1, [job('0', 'boxplot')], [], [{ id: '0', error: 'llm call timed out' }], 1, SEEN, GRADER);
    expect(report.byMark).toEqual([{ mark: 'boxplot', rows: 1, judged: 0, chart_correctness: null, readability: null }]);
    expect(describeJudge(report).join('\n')).toContain('boxplot: 0/1 judged, correctness no reading, readability no reading');
  });

  it('spells a mean with no readings behind it as one, on the 0-10 scale for everything else', () => {
    // The two spellings live in one function because a reader who sees one of them will see the
    // other, and "0.00/10" for a bucket nothing was graded on is the defect this replaced.
    expect(score(null)).toBe('no reading');
    expect(score(0)).toBe('0.00/10');
    expect(score(10)).toBe('10.00/10');
  });

  it('refuses a verdict for a row that was never offered', () => {
    expect(() => summarizeJudge(1, 1, [job('0', 'bar')], [], [{ id: '9', chart_correctness: 1, readability: 1 }], 1, SEEN, GRADER)).toThrow(
      /has no job/,
    );
  });

  it('prints every graded row of a sample, with what the grader wrote, because that is what a rehearsal is for', () => {
    // Two of five charts unselected is the shape of a `--limit` run: the sample is printed, and the
    // rows it did not reach are counted rather than silently missing.
    const report = summarizeJudge(5, 5, jobs, [], verdicts, 3, SEEN, GRADER);
    const lines = describeJudge(report).join('\n');
    expect(lines).toContain('the 3 rows that were graded, with what the grader wrote:');
    expect(lines).toMatch(/row 0: correctness 10, readability 8(, \d+ ms)? — \{"chart_correctness": 10, "readability": 8\}/);
    // A full run keeps the artifact instead: 1,286 lines of log is not a summary.
    const full = summarizeJudge(3, 3, jobs, [], verdicts, 3, SEEN, GRADER);
    expect(describeJudge(full).join('\n')).not.toContain('rows that were graded');
  });

  it('prints the two means, the denominators and the failures, and nothing else', () => {
    const report = summarizeJudge(3, 3, jobs, [], verdicts, 3, SEEN, GRADER);
    const lines = describeJudge(report).join('\n');
    expect(lines).toContain('judged 3/3 charts');
    expect(lines).toContain('chart_correctness 6.00/10, readability 7.33/10');
    expect(lines).toContain('calls 3, 1.000 per judged row');
    expect(lines).toContain('bar: 2/2 judged, correctness 5.00/10, readability 7.00/10');
  });
});

describe('what a report has to be before a mean can be read out of it', () => {
  const base: JudgeReport = {
    dimensions: [...JUDGE_DIMENSIONS],
    grader: GRADER,
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
    failedByKind: { truncated: 0, unreadable: 0, refused: 0, unavailable: 0, 'invalid-response': 0, 'call-failed': 0 },
    verdicts: [
      { id: '0', chart_correctness: 8, readability: 8, reply: '{"chart_correctness": 8, "readability": 8}' },
      { id: '1', chart_correctness: 8, readability: 8, reply: '{"chart_correctness": 8, "readability": 8}' },
    ],
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

  it('refuses a report that names no grader, because a mean without an author gets quoted as a fact about the charts', () => {
    reject({ grader: { endpoint: '', model: 'glm-4.5v' } }, /names no endpoint or model/);
    reject({ grader: { endpoint: 'zhipu', model: '  ' } }, /names no endpoint or model/);
  });

  it('refuses a mean outside the scale the prompt asked for', () => {
    reject({ means: { chart_correctness: 11, readability: 8 } }, /outside the scale/);
  });

  it('refuses a call count lower than the rows it claims to have attempted', () => {
    reject({ calls: 1 }, /spends one call per attempted row/);
  });
});

describe('a batch is priced in calls and in wall clock', () => {
  const rows = ['0', '1', '2', '3'].map((id) => job(id, 'bar'));

  /** A provider whose answer arrives later the *sooner* the row is, so completion order is reversed. */
  function reversed(calls: { inFlight: number; peak: number }) {
    return {
      id: 'staggered',
      model: 'glm-4.5v',
      complete: async (request: { readonly messages: readonly { readonly content: string }[] }) => {
        calls.inFlight += 1;
        calls.peak = Math.max(calls.peak, calls.inFlight);
        const prompt = request.messages[1]?.content ?? '';
        const id = /row (\d+)/.exec(prompt)?.[1] ?? '0';
        await new Promise((done) => setTimeout(done, (4 - Number(id)) * 12));
        calls.inFlight -= 1;
        return { text: '{"chart_correctness": 5, "readability": 5}', model: 'glm-4.5v' };
      },
    };
  }

  it('keeps the artifact in row order even though the replies came back backwards', async () => {
    const calls = { inFlight: 0, peak: 0 };
    const verdicts = await judgeJobsWith(rows, {
      provider: reversed(calls),
      concurrency: 4,
      readImage: async () => ({ mediaType: 'image/png', data: PIXEL_PNG.toString('base64') }),
    });
    // Four rows, finished 3-2-1-0, reported 0-1-2-3: the report is a statement about the corpus and
    // a scheduling accident must not be able to reorder it.
    expect(verdicts.map((verdict) => verdict.id)).toEqual(['0', '1', '2', '3']);
  });

  it('overlaps the calls it is told to overlap, and no more', async () => {
    const calls = { inFlight: 0, peak: 0 };
    await judgeJobsWith(rows, { provider: reversed(calls), concurrency: 2, readImage: async () => ({ mediaType: 'image/png', data: PIXEL_PNG.toString('base64') }) });
    expect(calls.peak).toBe(2);
    const serial = { inFlight: 0, peak: 0 };
    await judgeJobsWith(rows, { provider: reversed(serial), readImage: async () => ({ mediaType: 'image/png', data: PIXEL_PNG.toString('base64') }) });
    expect(serial.peak).toBe(1);
  });

  it('still spends one call per row, whatever the concurrency', async () => {
    let spent = 0;
    const counting = {
      id: 'counting',
      model: 'm',
      complete: async () => {
        spent += 1;
        return { text: '{"chart_correctness": 5, "readability": 5}', model: 'm' };
      },
    };
    await judgeJobsWith(rows, { provider: counting, concurrency: 3, readImage: async () => ({ mediaType: 'image/png', data: PIXEL_PNG.toString('base64') }) });
    expect(spent).toBe(4);
  });

  it('grades an empty list at any concurrency, and spends nothing', async () => {
    // A sample of zero rows is a run the caller asked for and a shape the loop has to survive: the
    // clamping to one worker exists because `Array.from({length: 0})` would otherwise await nothing
    // and still have to return an empty report.
    const verdicts = await judgeJobsWith([], { provider: reversed({ inFlight: 0, peak: 0 }), concurrency: 4 });
    expect(verdicts).toEqual([]);
  });

  it('refuses a concurrency that is not a whole number of at least one', async () => {
    const provider = reversed({ inFlight: 0, peak: 0 });
    await expect(judgeJobsWith(rows, { provider, concurrency: 0, readImage: async () => ({ mediaType: 'image/png', data: PIXEL_PNG.toString('base64') }) })).rejects.toThrow(
      /whole number of at least 1/,
    );
    await expect(judgeJobsWith(rows, { provider, concurrency: 1.5, readImage: async () => ({ mediaType: 'image/png', data: PIXEL_PNG.toString('base64') }) })).rejects.toThrow(
      /whole number of at least 1/,
    );
  });
});

describe('a reply that is kept, and bounded', () => {
  it('keeps the grader\'s own words beside the two scores', async () => {
    const verdicts = await judgeJobsWith([job('0', 'bar')], {
      provider: { id: 'p', model: 'm', complete: async () => ({ text: '  {"chart_correctness": 7, "readability": 6}  ', model: 'm' }) },
      readImage: async () => ({ mediaType: 'image/png', data: PIXEL_PNG.toString('base64') }),
    });
    // Trimmed but otherwise verbatim: the point is that a reader can tell a misread from a bad chart.
    expect(verdicts[0]?.reply).toBe('{"chart_correctness": 7, "readability": 6}');
  });

  it('truncates a reply that ran long, and says how long the report may be', async () => {
    const long = `{"chart_correctness": 7, "readability": 6}${' '.repeat(REPLY_LIMIT)}and then some commentary`;
    const verdicts = await judgeJobsWith([job('0', 'bar')], {
      provider: { id: 'p', model: 'm', complete: async () => ({ text: long, model: 'm' }) },
      readImage: async () => ({ mediaType: 'image/png', data: PIXEL_PNG.toString('base64') }),
    });
    expect(verdicts[0]?.reply).toHaveLength(REPLY_LIMIT);
    expect(assertJudgeReport(summarizeJudge(1, 1, [job('0', 'bar')], [], verdicts, 1, SEEN, GRADER))).toBeUndefined();
  });

  it('keeps no reply for a row that never got one, because a fabricated empty one reads as an answer', async () => {
    const verdicts = await judgeJobsWith([job('0', 'bar')], {
      provider: {
        id: 'p',
        model: 'm',
        complete: async () => {
          throw Object.assign(new Error('llm call timed out'), { code: 'NL2C_E_LLM_UNAVAILABLE' });
        },
      },
      readImage: async () => ({ mediaType: 'image/png', data: PIXEL_PNG.toString('base64') }),
    });
    expect(verdicts[0]).toEqual({ id: '0', error: 'llm call timed out', failure: 'unavailable', ms: expect.any(Number) });
  });

  it('calls a reply cut at the token cap what it is, and says the cap was the reason', async () => {
    // The shape run 43979969822 produced 24 times: the provider stopped for `length` and the text
    // ends mid-object. Reading it as "the reply named neither score" pointed the reader at the
    // parser; the row was a budget the next commit raised.
    const verdicts = await judgeJobsWith([job('0', 'bar')], {
      provider: {
        id: 'p',
        model: 'm',
        complete: async () => ({ text: '{"chart_correctness": 2, "readability":', finishReason: 'length' }),
      },
      readImage: async () => ({ mediaType: 'image/png', data: PIXEL_PNG.toString('base64') }),
    });
    expect(verdicts[0]?.failure).toBe('truncated');
    expect(verdicts[0]?.error).toMatch(/named chart_correctness and stopped before readability/);
    expect(verdicts[0]?.error).toMatch(/finish=length/);
  });

  it('refuses a reply longer than the report documents', () => {
    const report = summarizeJudge(1, 1, [job('0', 'bar')], [], [{ id: '0', chart_correctness: 5, readability: 5, reply: 'x'.repeat(REPLY_LIMIT + 1) }], 1, SEEN, GRADER);
    // The bound is what keeps 1,286 replies inside an artifact a person can open, and a run that
    // ignored it would be a run whose artifact nobody can load.
    expect(() => assertJudgeReport(report)).toThrow(new RegExp(`over the ${String(REPLY_LIMIT)} it documents`));
  });

  it('refuses a report whose row kept neither a reply nor an error', () => {
    const report = summarizeJudge(1, 1, [job('0', 'bar')], [], [{ id: '0', chart_correctness: 5, readability: 5 }], 1, SEEN, GRADER);
    expect(() => assertJudgeReport(report)).toThrow(/kept no reply, so its score cannot be re-read/);
  });

  it('refuses a report whose kept rows do not add up to the rows the means were over', () => {
    const report = summarizeJudge(1, 1, [job('0', 'bar')], [], [{ id: '0', chart_correctness: 5, readability: 5, reply: 'r' }], 1, SEEN, GRADER);
    // One row judged and one row kept is the only shape that adds up; a report where the array and
    // the counts disagree is one where a row was dropped between the summary and the artifact.
    expect(() => assertJudgeReport({ ...report, verdicts: [] })).toThrow(/0 rows kept for 1 judged and 0 failed/);
  });

  it('prints a failed row of a sample as a failure, with its own reason', () => {
    const report = summarizeJudge(3, 3, [job('0', 'bar'), job('1', 'pie'), job('2', 'line')], [], [
      { id: '0', chart_correctness: 5, readability: 5, reply: 'r', ms: 12 },
      { id: '1', error: 'llm call timed out', ms: 180_000 },
      { id: '2', chart_correctness: 1, readability: 1, reply: 'r' },
    ], 3, SEEN, GRADER);
    const lines = describeJudge({ ...report, notSelected: 1, charts: 4, scored: 5, skipped: 1 }).join('\n');
    expect(lines).toContain('row 1: FAILED llm call timed out, 180000 ms');
  });

  it('refuses a row that is scored and an error at the same time, or neither', () => {
    const both = summarizeJudge(1, 1, [job('0', 'bar')], [], [{ id: '0', chart_correctness: 5, readability: 5, error: 'x', reply: 'r' }], 1, SEEN, GRADER);
    expect(() => assertJudgeReport(both)).toThrow(/scored and also an error/);
    const neither = summarizeJudge(1, 1, [job('0', 'bar')], [], [{ id: '0', reply: 'nothing here' }], 1, SEEN, GRADER);
    expect(() => assertJudgeReport(neither)).toThrow(/neither scored nor an error/);
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
      // The reply is kept verbatim, so a later reader can tell a parse that misread a well-formed
      // reply from a grader that really wrote that number.
      expect(verdicts).toEqual([
        {
          id: '0',
          chart_correctness: 9,
          readability: 5,
          reply: '{"chart_correctness": 9, "readability": 5}',
          ms: expect.any(Number) as number,
        },
      ]);
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

  it('samples a row the way the endpoint is sampled, and can name no temperature at all', async () => {
    const { provider, bodies, close } = responder('{"chart_correctness": 9, "readability": 5}');
    try {
      // The default is this repository's zero, which every published reading was taken at.
      await judgeJobsWith([{ ...job('0', 'bar'), png }], { provider });
      expect(bodies[0]?.temperature).toBe(0);
      // `null` is "name none", and it has to survive the trip: an endpoint whose documented range
      // may exclude zero refuses the field rather than ignoring it, so it must not be sent.
      await judgeJobsWith([{ ...job('0', 'bar'), png }], { provider, temperature: null });
      expect(Object.keys(bodies[1] ?? {})).not.toContain('temperature');
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
    // A grader asked in English answers in English, but a Chinese vision model asked about a
    // colour sometimes answers in Chinese, and a probe that refused 红色 would call it blind.
    expect(sawRed('红色')).toBe(true);
    expect(sawRed('主色调是红色。')).toBe(true);
    expect(sawRed('蓝色')).toBe(false);
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
    expect(probe).toEqual({ answer: 'Red.', asked: true, seen: true });
    const messages = body.messages as { readonly role: string; readonly content: string; readonly images?: readonly unknown[] }[];
    expect(messages[1]?.content).toBe(VISION_PROBE);
    expect(messages[1]?.images).toHaveLength(1);
  });

  it('turns a refusal into an answer nobody saw, rather than into a stack trace', async () => {
    const refused = { id: 'p', model: 'p', complete: async () => ({ text: 'I cannot see images.', model: 'p' }) };
    // Answered, and could not name the colour: the one shape that is evidence about eyes.
    expect(await probeVision(refused)).toEqual({ answer: 'I cannot see images.', asked: true, seen: false });
    const broken = {
      id: 'p',
      model: 'p',
      complete: async () => {
        throw new Error('declares no vision capability');
      },
    };
    // Never answered: a quota or a url, which is not the same finding and must not be reported as one.
    expect(await probeVision(broken)).toEqual({ answer: 'declares no vision capability', asked: false, seen: false });
    const stringly = {
      id: 'p',
      model: 'p',
      complete: async () => {
        throw 'no route to host';
      },
    };
    expect(await probeVision(stringly)).toEqual({ answer: 'no route to host', asked: false, seen: false });
  });
});

describe('the endpoint a run grades with', () => {
  it('declares one endpoint, and it is one whose vision model this repository can name', () => {
    expect(JUDGE_ENDPOINTS.map((endpoint) => endpoint.name)).toEqual(['zhipu']);
    const row = JUDGE_ENDPOINTS[0]!;
    expect(row.model).toBe('glm-4.5v');
    expect(row.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    // The vendor's own sample sends the payload with no prefix, and this repository's default
    // spelling carries one: the row is where that difference is written down.
    expect(row.imageDialect).toBe('bare-base64');
    // No temperature, because the range this endpoint documents is not this repository's to assume.
    expect(row.temperature).toBe(null);
    // A first budget under the ceiling it may escalate to, and a budget that is a decision.
    // 1,024 was the first decision and it was wrong: on a thinking model the deliberation is
    // billed inside `max_tokens`, and run 43979969822 lost 24 of 1,286 rows to replies cut at
    // `{"chart_correctness": 2, "readability":`.
    expect(row.maxOutputTokens).toBe(4096);
    expect(row.answerBudgetCeiling).toBeGreaterThanOrEqual(row.maxOutputTokens);
  });

  it('takes the org secret by its vendor name, and the conventional name after it', () => {
    expect(resolveJudge({ ZHIPU_API_KEY: 'z' }).grader).toEqual({ endpoint: 'zhipu', model: 'glm-4.5v' });
    expect(resolveJudge({ LLM_API_KEY: 'l' }).grader.endpoint).toBe('zhipu');
    // A variable that holds whitespace holds no key, and an empty header is a 401 that reads as a
    // bad key rather than as a missing export.
    expect(() => resolveJudge({ ZHIPU_API_KEY: '   ' })).toThrow(/no key for the zhipu endpoint/);
    expect(() => resolveJudge({})).toThrow(/set ZHIPU_API_KEY or LLM_API_KEY/);
  });

  it('refuses a name it does not declare, and lists the ones it does', () => {
    expect(() => resolveJudge({ ZHIPU_API_KEY: 'z' }, 'openai')).toThrow(/no endpoint named "openai": this repository declares zhipu/);
    expect(resolveJudge({ ZHIPU_API_KEY: 'z', JUDGE_ENDPOINT: 'zhipu' }).grader.endpoint).toBe('zhipu');
    expect(() => resolveJudge({ ZHIPU_API_KEY: 'z', JUDGE_ENDPOINT: 'anthropic' })).toThrow(/no endpoint named "anthropic"/);
  });

  it('lets a dispatch point the same row at a mirror and an alias without losing the row', () => {
    const moved = resolveJudge({ ZHIPU_API_KEY: 'z', LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_MODEL: 'glm-4v-plus' });
    expect(moved.grader).toEqual({ endpoint: 'zhipu', model: 'glm-4v-plus' });
    expect(moved.baseUrl).toBe('http://127.0.0.1:9/v1');
    // The facts that are about the vendor rather than about this deployment still apply.
    expect(moved.imageDialect).toBe('bare-base64');
    expect(moved.temperature).toBe(null);
  });

  it('declares vision on the row, which is a declaration the probe then checks', () => {
    const resolved = resolveJudge({ ZHIPU_API_KEY: 'z' });
    expect(resolved.provider.capabilities?.vision).toBe(true);
    expect(resolved.provider.capabilities?.maxOutputTokens).toBe(JUDGE_ENDPOINTS[0]?.maxOutputTokens);
    expect(resolved.provider.model).toBe('glm-4.5v');
    expect(resolved.provider.id).toBe('http');
  });

  it('sends the image the way the vendor documents, and names no temperature at all', async () => {
    const sent: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', () => {
        sent.push(JSON.parse(body) as Record<string, unknown>);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ model: 'glm-4.5v', choices: [{ message: { content: 'red' } }], usage: { prompt_tokens: 900, completion_tokens: 2 } }),
        );
      });
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const { port } = server.address() as AddressInfo;
    try {
      const resolved = resolveJudge({ ZHIPU_API_KEY: 'z', LLM_BASE_URL: `http://127.0.0.1:${String(port)}/api/paas/v4` });
      // The probe is a request like any other, so it is sampled the way the row says.
      expect((await probeVision(resolved.provider, resolved.temperature)).seen).toBe(true);
      expect(sent).toHaveLength(1);
      const body = sent[0] as Record<string, unknown>;
      // Absent, not zero and not the vendor's default: the field is one this endpoint may refuse.
      expect(Object.keys(body)).not.toContain('temperature');
      expect(body.max_tokens).toBe(JUDGE_ENDPOINTS[0]?.maxOutputTokens);
      const messages = body.messages as { readonly content: readonly { readonly type: string; readonly image_url?: { readonly url: string } }[] }[];
      const image = messages[1]?.content.find((part) => part.type === 'image_url');
      // Bare base64: no `data:image/png;base64,` prefix, which is the spelling OpenAI documents.
      expect(image?.image_url?.url.startsWith('data:')).toBe(false);
      expect(image?.image_url?.url).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
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
    expect(parseJudgeArgs([])).toEqual({ png: 'eval/.cache/text2vis/png', json: false, probeOnly: false });
  });

  it('takes the five flags it documents', () => {
    expect(parseJudgeArgs(['--png', '/p', '--render', '/r.json', '--artifact', '/j.json', '--limit', '40', '--json'])).toEqual({
      png: '/p',
      render: '/r.json',
      artifact: '/j.json',
      limit: 40,
      json: true,
      probeOnly: false,
    });
  });

  it('takes the two flags that choose a grader rather than a row set', () => {
    expect(parseJudgeArgs(['--probe-only', '--endpoint', 'zhipu'])).toEqual({
      png: 'eval/.cache/text2vis/png',
      json: false,
      probeOnly: true,
      endpoint: 'zhipu',
    });
    expect(() => parseJudgeArgs(['--endpoint'])).toThrow(/--endpoint needs a value/);
  });

  it('takes the concurrency the runner has room for, and refuses one it cannot honour', () => {
    // The first reading measured 49 seconds per call over 1,286 rows, which is longer than any
    // runner will hold a job: the flag exists because the calls are independent, and the price
    // (`one call per row`) is asserted elsewhere and does not move with it.
    expect(parseJudgeArgs(['--concurrency', '8'])).toMatchObject({ concurrency: 8 });
    expect(() => parseJudgeArgs(['--concurrency', '0'])).toThrow(/positive whole number/);
    expect(() => parseJudgeArgs(['--concurrency', 'half'])).toThrow(/positive whole number/);
    expect(() => parseJudgeArgs(['--concurrency'])).toThrow(/--concurrency needs a value/);
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
        // An injected provider is named by its own id and model: the artifact says who graded even
        // when the table was not consulted at all.
        grader: { endpoint: 'http', model: 'grade' },
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
        // `--concurrency` is passed here rather than only parsed elsewhere: the flag has to reach the
        // loop, and the one place that proves it is a run.
        argv: [
          '--render',
          join(root, 'render.json'),
          '--png',
          root,
          '--limit',
          '1',
          '--concurrency',
          '2',
          '--artifact',
          join(root, 'judge.json'),
        ],
        load: { url: server.url, cacheDir: join(root, 'cache') },
        provider,
        // A provider that samples at a number rather than at zero: the injected path defaults to
        // zero, and the branch that lets a caller override it has to be taken once.
        temperature: 0.2,
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
    // A provider, so that the endpoint is not what stops the run: the missing artifact is.
    expect(await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), { argv: [], provider: grader('{}').provider })).toBe(1);
    expect(lines.join('\n')).toMatch(/--render <path> is required/);
    expect(await entryJudge(undefined, MODULE_URL, () => undefined)).toBeUndefined();
  });

  it('takes the endpoint from the environment, and refuses one it cannot name', async () => {
    const lines: string[] = [];
    // No key anywhere: the cheapest thing this command can be asked to do is still a call, so the
    // key is checked before the probe rather than discovered as a 401 that reads as a bad key.
    expect(await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), { argv: ['--probe-only'], env: {} })).toBe(1);
    expect(lines.join('\n')).toMatch(/set ZHIPU_API_KEY or LLM_API_KEY/);
    const named: string[] = [];
    expect(
      await entryJudge(ENTRY, MODULE_URL, (line) => named.push(line), { argv: ['--probe-only', '--endpoint', 'nope'], env: { ZHIPU_API_KEY: 'z' } }),
    ).toBe(1);
    expect(named.join('\n')).toMatch(/no endpoint named "nope"/);
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

  it('grades with the endpoint the environment names, over the wire, for one call', async () => {
    const sent: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', () => {
        sent.push(JSON.parse(body) as Record<string, unknown>);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ model: 'glm-4.5v', choices: [{ message: { content: 'red' } }], usage: { prompt_tokens: 900, completion_tokens: 2 } }));
      });
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const { port } = server.address() as AddressInfo;
    try {
      const lines: string[] = [];
      const code = await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--probe-only'],
        env: { ZHIPU_API_KEY: 'k', LLM_BASE_URL: `http://127.0.0.1:${String(port)}/api/paas/v4`, LLM_MODEL: 'glm-4.5v' },
      });
      expect(code).toBe(0);
      // The whole chain, from a variable name to the bytes on the socket: who grades, where, and the
      // three facts about this vendor that a default would have got wrong.
      expect(lines.join('\n')).toMatch(
        new RegExp(`grading with glm-4\\.5v \\(zhipu\\) at http://127\\.0\\.0\\.1:${String(port)}/api/paas/v4, images bare-base64, temperature unset`),
      );
      expect(sent).toHaveLength(1);
      expect(Object.keys(sent[0] ?? {})).not.toContain('temperature');
      expect(sent[0]?.max_tokens).toBe(JUDGE_ENDPOINTS[0]?.maxOutputTokens);
      const messages = sent[0]?.messages as { readonly content: readonly { readonly type: string; readonly image_url?: { readonly url: string } }[] }[];
      const image = messages[1]?.content.find((part) => part.type === 'image_url');
      expect(image?.image_url?.url.startsWith('data:')).toBe(false);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('says so when the temperature it will not name is none', async () => {
    const { provider } = grader('red');
    const lines: string[] = [];
    expect(await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), { argv: ['--probe-only'], provider, temperature: null })).toBe(0);
    expect(lines.join('\n')).toMatch(/temperature unset/);
    // An injected provider has no timeout of its own, and printing a number the run is not using
    // would be worse than printing that the provider's default applies.
    expect(lines.join('\n')).toMatch(/timeout provider default/);
  });

  it('carries the row\'s timeout, because a timeout is a fact about the model', async () => {
    // Measured, not assumed: the first reading lost 2 of 8 rows to the provider's 60-second default
    // while the six that answered averaged 49 seconds each.
    const row = JUDGE_ENDPOINTS.find((endpoint) => endpoint.name === 'zhipu');
    expect(row?.timeoutMs).toBe(180_000);
    const resolved = resolveJudge({ ZHIPU_API_KEY: 'k' });
    expect(resolved.timeoutMs).toBe(180_000);
  });

  it('falls back to the process environment when a caller hands it none, which is the CLI path', async () => {
    // The one arm no injected fixture reaches: a run started by hand reads `process.env`. It is not
    // covered by passing `env: {}` — that is the *other* arm — so the variables are removed and put
    // back, and the assertion is the message that names them.
    const kept = { z: process.env.ZHIPU_API_KEY, l: process.env.LLM_API_KEY };
    delete process.env.ZHIPU_API_KEY;
    delete process.env.LLM_API_KEY;
    try {
      const lines: string[] = [];
      expect(await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), { argv: ['--probe-only'] })).toBe(1);
      expect(lines.join('\n')).toMatch(/no key for the zhipu endpoint: set ZHIPU_API_KEY or LLM_API_KEY/);
    } finally {
      if (kept.z !== undefined) process.env.ZHIPU_API_KEY = kept.z;
      if (kept.l !== undefined) process.env.LLM_API_KEY = kept.l;
    }
  });

  it('checks an endpoint for one call, and grades nothing', async () => {
    const { provider, calls } = grader('{"chart_correctness": 6, "readability": 9}');
    const root = mkdtempSync(join(tmpdir(), 'nl2charts-judge-probe-only-'));
    try {
      const lines: string[] = [];
      const code = await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), { argv: ['--probe-only'], provider });
      expect(code).toBe(0);
      // One call, no corpus, no render artifact, no report: this is the cheapest question this
      // command can be asked, and it is the one a dispatch should ask first.
      expect(calls()).toBe(1);
      expect(existsSync(join(root, 'judge.json'))).toBe(false);
      const printed = lines.join('\n');
      expect(printed).toMatch(/grading with grade \(http\), images data-url, temperature 0/);
      expect(printed).toMatch(/the probe answered "red", so this endpoint can see; nothing was graded/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a probe-only run on a blind endpoint as a failure of that one call', async () => {
    let calls = 0;
    const blind = {
      id: 'blind',
      model: 'text-only',
      complete: async () => {
        calls += 1;
        return { text: 'I cannot see images.', model: 'text-only' };
      },
    };
    const lines: string[] = [];
    expect(await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), { argv: ['--probe-only'], provider: blind })).toBe(1);
    expect(calls).toBe(1);
    expect(lines.join('\n')).toMatch(/did not see the probe image .*nothing was graded/);
  });

  it('does not call a quota a blind model, which is what the first production run printed', async () => {
    let calls = 0;
    const limited = {
      id: 'limited',
      model: 'glm-4.5v',
      complete: async () => {
        calls += 1;
        throw new Error('llm returned 429');
      },
    };
    const lines: string[] = [];
    expect(await entryJudge(ENTRY, MODULE_URL, (line) => lines.push(line), { argv: ['--probe-only'], provider: limited })).toBe(1);
    expect(calls).toBe(1);
    expect(lines.join('\n')).toMatch(/never answered \(llm returned 429\).*not a verdict on what it can see/);
    // The batch path reads the same two facts the same way, and stops before the artifact is opened.
    const batch: string[] = [];
    expect(await entryJudge(ENTRY, MODULE_URL, (line) => batch.push(line), { argv: ['--render', '/nowhere/render.json'], provider: limited })).toBe(1);
    expect(batch.join('\n')).toMatch(/never answered \(llm returned 429\)/);
    expect(batch.join('\n')).not.toMatch(/did not see the probe image/);
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
