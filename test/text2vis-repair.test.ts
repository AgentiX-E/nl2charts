/**
 * The second question, priced: the counts behind it, the arithmetic it can be wrong about, and the
 * command that asks it.
 *
 * The one thing every assertion here defends is the *denominator*. A repair reading is a share over
 * refused rows, and there are four ways to get that wrong without noticing: counting every row as a
 * refusal, counting a distinct question as a row (or a row as a question), scoring a repaired answer
 * against a row it was not asked about, and comparing the repair with itself instead of with what the
 * table would have drawn. Each of those produces a plausible percentage, which is why each has a test.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { LlmProvider, LlmRequest, LlmResponse } from '@agentix-e/nl2charts-ai';
import { TEXT2VIS_FIELDS } from '../eval/text2vis/dataset.js';
import { profileAnswer, type ProfileInput } from '../eval/text2vis/profile.js';
import { familyOfLabel } from '../eval/text2vis/rule.js';
import { replyOf, rosterOf, type StoredRow } from '../eval/text2vis/llm.js';
import { openStore } from '../eval/text2vis/content-store.js';
import {
  repairTarget,
  assertRepair,
  describeRepair,
  entryRepair,
  parseRepairArgs,
  runRepair,
  type RepairReport,
} from '../eval/text2vis/repair.js';

const root = mkdtempSync(join(tmpdir(), 'nl2charts-repair-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ENTRY = resolve('eval/text2vis/repair.ts');
const MODULE_URL = pathToFileURL(ENTRY).href;

function row(prompt: string, label: string, tableData: string): ProfileInput {
  return { prompt, label, tableData };
}

/**
 * Four rows, chosen so that every branch of "should this row be asked again" is present once.
 *
 * `r0` and `r2` refuse a mark their table holds four alternatives for. `r1` holds exactly one mark,
 * so a second question would have one possible answer. `r3` is a table no mark can hold.
 */
const ROWS: readonly ProfileInput[] = [
  row('Revenue by country', 'Bar', 'country,value\nUS,5\nDE,9\nFR,2'),
  row('Total revenue', 'Gauge', 'value\n42'),
  row('Revenue over the years', 'Line', 'year,value\n2019,3\n2020,4\n2021,8'),
  row('Which region', 'Bar', 'region\nNorth\nSouth'),
];

/** `boxplot` is on the roster and refused by both chartable tables: the row class this file repairs. */
const CHOICES: readonly (string | null)[] = ['boxplot', 'bar', 'boxplot', 'bar'];

const PRODUCTS = ROWS.map((one) => profileAnswer(one.prompt, one.tableData).mark);

/** A provider that answers by the question it was asked, so one stub serves both second questions. */
function scripted(
  answer: (request: LlmRequest) => string,
  options: { readonly finishReason?: 'stop' | 'length'; readonly model?: string; readonly thinksAloud?: boolean } = {},
): LlmProvider & { readonly calls: () => number; readonly seen: LlmRequest[] } {
  const named = options.model ?? 'deepseek-chat';
  const seen: LlmRequest[] = [];
  return {
    id: 'scripted',
    model: named,
    ...(options.thinksAloud === true ? { capabilities: { thinksAloud: true } as LlmProvider['capabilities'] } : {}),
    complete: async (request: LlmRequest): Promise<LlmResponse> => {
      seen.push(request);
      return {
        text: answer(request),
        model: named,
        usage: { promptTokens: 130, completionTokens: 2 },
        finishReason: options.finishReason ?? 'stop',
      };
    },
    calls: () => seen.length,
    seen,
  };
}

/** The second answer per question, so the two rows can differ. */
function answers(request: LlmRequest): string {
  const question = request.messages[1]?.content ?? '';
  return question === 'Revenue over the years' ? 'line' : 'pie';
}

const settings = (provider: LlmProvider) => ({ provider, rows: ROWS, choices: CHOICES, products: PRODUCTS, concurrency: 2 });

describe('asking the refused rows', () => {
  it('asks only the rows a second question can help, and says how many that is', async () => {
    const provider = scripted(answers);
    const report = await runRepair(settings(provider));
    // Three refusals, two of them repairable: the gauge table holds one mark and the region table holds
    // none, so the first is not asked and the second cannot be.
    expect(report.refused).toBe(3);
    expect(report.asked).toBe(2);
    expect(report.questions).toBe(2);
    expect(provider.calls()).toBe(2);
    expect(report.rows.map((one) => one.question)).toEqual(['Revenue by country', 'Revenue over the years']);
    // The option list is part of the question, and it is what the store keys on.
    for (const stored of report.rows) expect(stored.options).toEqual(['bar', 'line', 'pie', 'funnel']);
    expect(report.rows.map((one) => one.choice)).toEqual(['pie', 'line']);
  });

  it('scores the second answer against the row it was asked about, and the table beside it', async () => {
    const report = await runRepair(settings(scripted(answers)));
    // `pie` on a Bar row is a miss; `line` on a Line row is a hit. The table got both right, which is
    // the comparison the file exists to publish: a repair that does not beat it is not an improvement.
    expect(report.hits).toBe(1);
    expect(report.hitShare).toBe(0.5);
    expect(report.tableHits).toBe(2);
    expect(report.tableHitShare).toBe(1);
    assertRepair(report);
  });

  it('counts an answer outside the shorter list as unreadable rather than as a wrong mark', async () => {
    const report = await runRepair(settings(scripted(() => 'donut')));
    expect(report.answered).toBe(0);
    expect(report.unparsed).toBe(2);
    expect(report.hits).toBe(0);
    // A row that named nothing is still a row the product answers, so the report is publishable — it
    // is just a negative result.
    assertRepair(report);
  });

  it('asks one question per distinct pair, and counts rows rather than questions', async () => {
    // Two rows with one question and one table: the store answers the second from the first, so it is
    // one call and two rows of the reading. Without a store it would be two calls — which is why the
    // cache is in this test rather than assumed.
    const twin = [ROWS[0] as ProfileInput, ROWS[0] as ProfileInput];
    const provider = scripted(() => 'pie');
    const cache = openStore<StoredRow>(join(root, `twin-${String(Date.now())}`), 1, replyOf);
    const report = await runRepair({
      provider,
      rows: twin,
      choices: ['boxplot', 'boxplot'],
      products: [PRODUCTS[0] as string, PRODUCTS[0] as string],
      cache,
      concurrency: 1,
    });
    expect(report.refused).toBe(2);
    expect(report.asked).toBe(2);
    expect(report.questions).toBe(1);
    expect(provider.calls()).toBe(1);
    expect(cache.hits).toBe(1);
    expect(report.rows).toHaveLength(1);
    expect(report.hits).toBe(0);
  });

  it('prices the calls it made, and the price per question', async () => {
    const report = await runRepair(settings(scripted(answers)));
    expect(report.cost.calls).toBe(2);
    expect(report.cost.promptTokens).toBe(260);
    expect(report.cost.completionTokens).toBe(4);
    // Two yuan a million in, eight out — the price table's numbers, not a copy of them in a comment.
    expect(report.cost.yuan).toBeCloseTo((260 * 2 + 4 * 8) / 1_000_000, 10);
    expect(report.cost.perRowYuan).toBeCloseTo((report.cost.yuan as number) / 2, 12);
  });

  it('leaves the price unstated for a model its table does not know, rather than guessing', async () => {
    const report = await runRepair(settings(scripted(answers, { model: 'a-model-nobody-priced' })));
    expect(report.cost.yuan).toBeUndefined();
    expect(describeRepair(report).join('\n')).not.toContain('cost ¥');
  });

  it('does nothing, and says so, when no row was refused', async () => {
    const provider = scripted(() => 'bar');
    // The product's own answers: every one of them is a mark its table holds.
    const report = await runRepair({ ...settings(provider), choices: ['bar', 'gauge', 'line', 'bar'] });
    expect(report.refused).toBe(0);
    expect(report.asked).toBe(0);
    expect(report.questions).toBe(0);
    expect(report.hitShare).toBe(0);
    expect(provider.calls()).toBe(0);
    assertRepair(report);
    expect(describeRepair(report).join('\n')).toContain('0 refused rows');
  });

  it('sends no reply cap to a model that thinks aloud, and says so in the request it records', async () => {
    // The cap is a fence around a runaway chat reply. A reasoning endpoint's deliberation is billed as
    // completion, so the same fence truncates the thinking — the judge learned that at 1,024 tokens.
    const provider = scripted(answers, { thinksAloud: true });
    const report = await runRepair(settings(provider));
    expect(provider.seen[0]?.maxTokens).toBeUndefined();
    expect(report.request).toEqual({ promptVersion: 1 });
  });

  it('counts a cut reply as unreadable and refuses to publish the run', async () => {
    // Two facts, not one: the token was cut (a fact about the cap) and it named nothing (a fact about
    // the answer). The second is publishable; the first makes the whole run unpublishable.
    const report = await runRepair(settings(scripted(answers, { finishReason: 'length' })));
    expect(report.truncated).toBe(2);
    expect(report.unparsed).toBe(2);
    expect(report.hits).toBe(0);
    expect(() => assertRepair(report)).toThrow(/cut at the token budget/);
  });

  it('names the request it answered, so a reading can be told from another request s', async () => {
    const report = await runRepair(settings(scripted(answers)));
    expect(report.request).toEqual({ promptVersion: 1, budget: 96 });
  });

  it('records the population it was told about, so a replay can refuse another one', async () => {
    const report = await runRepair(settings(scripted(answers)));
    expect(report.population).toEqual({ scored: 4, roster: rosterOf(ROWS) });
  });
});

describe('the arithmetic a repair report can be wrong about', () => {
  const base: RepairReport = {
    model: 'a-model',
    request: { promptVersion: 1, budget: 96 },
    population: { scored: 4, roster: 'x' },
    refused: 3,
    asked: 2,
    questions: 2,
    answered: 2,
    unparsed: 0,
    truncated: 0,
    hits: 1,
    hitShare: 0.5,
    tableHits: 1,
    tableHitShare: 0.5,
    rows: [
      { row: 0, question: 'q', options: ['bar'], choice: 'bar', reply: 'bar', truncated: false },
      { row: 2, question: 'r', options: ['line'], choice: 'line', reply: 'line', truncated: false },
    ],
    cost: { calls: 2, promptTokens: 10, completionTokens: 2, cachedPromptTokens: 0 },
    cache: { hits: 0, misses: 2, corrupt: 0 },
  };

  it('passes a report that adds up', () => {
    expect(() => assertRepair(base)).not.toThrow();
  });

  it('refuses more refusals than rows', () => {
    expect(() => assertRepair({ ...base, refused: 5 })).toThrow(/5 refusals over a population of 4/);
  });

  it('refuses more rows asked than rows refused', () => {
    expect(() => assertRepair({ ...base, asked: 4 })).toThrow(/4 rows asked of 3 refused rows/);
  });

  it('refuses more questions than rows asked', () => {
    expect(() => assertRepair({ ...base, questions: 3 })).toThrow(/3 questions for 2 rows asked/);
  });

  it('refuses a stored row count that is not the question count', () => {
    expect(() => assertRepair({ ...base, rows: base.rows.slice(0, 1) })).toThrow(/1 rows kept and 2 questions asked/);
  });

  it('refuses answers and unreadable replies that do not cover the rows asked', () => {
    expect(() => assertRepair({ ...base, answered: 1 })).toThrow(/1 answered and 0 unreadable over 2 rows asked/);
  });

  it('refuses more hits than rows, on either column', () => {
    expect(() => assertRepair({ ...base, hits: 3 })).toThrow(/3 and 1 hits over 2 rows/);
    expect(() => assertRepair({ ...base, tableHits: 3 })).toThrow(/1 and 3 hits over 2 rows/);
  });

  it('refuses a run with a cut reply, because a prefix is not an answer', () => {
    expect(() => assertRepair({ ...base, truncated: 1 })).toThrow(/cut at the token budget/);
  });
});

describe('the reading as a reader sees it', () => {
  it('prints both shares, the counts behind them and the cost', async () => {
    const text = describeRepair(await runRepair(settings(scripted(answers)))).join('\n');
    expect(text).toContain('3 refused rows');
    expect(text).toContain('repairable 2 (2 distinct), answered 2, unparsed 0, truncated 0');
    expect(text).toContain('repaired hits 1 (50.00%)');
    expect(text).toContain("the table's 2 (100.00%)");
    expect(text).toContain('cost ¥');
  });
});

describe('the command line', () => {
  it('takes the two paths', () => {
    expect(parseRepairArgs(['--answers', 'a.json', '--artifact', 'r.json'])).toEqual({ answers: 'a.json', artifact: 'r.json' });
    expect(parseRepairArgs(['--answers', 'a.json'])).toEqual({ answers: 'a.json' });
  });

  it('refuses a missing --answers, because the refusals are read out of an artifact', () => {
    expect(() => parseRepairArgs([])).toThrow(/--answers is required/);
  });

  it('refuses a flag it does not use, and a value that is another flag', () => {
    expect(() => parseRepairArgs(['--answers', 'a.json', '--live'])).toThrow(/unknown argument --live/);
    expect(() => parseRepairArgs(['--artifact', '--answers'])).toThrow(/--artifact needs a path/);
  });
});

/** A CSV cell holding a whole table, quoted with real newlines. */
function cell(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

const HEADER = `${TEXT2VIS_FIELDS.prompt},${TEXT2VIS_FIELDS.answer},${TEXT2VIS_FIELDS.code},${TEXT2VIS_FIELDS.chartType},Table Data`;
const CSV = [
  HEADER,
  ...ROWS.map((one) => `${cell(one.prompt)},code,SELECT 1,${one.label},${cell(one.tableData)}`),
  // A label no family names. The arm drops these before asking; this command must count the drop
  // rather than repair a row that is not in any population.
  `${cell('Revenue as a waterfall')},code,SELECT 1,Waterfall,${cell('stage,value\nstart,10\nend,4')}`,
].join('\n');

/** The artifact the arm writes, trimmed to the fields this command reads. */
const ANSWERS = join(root, 'answers.json');

function writeAnswers(over: Record<string, unknown> = {}): string {
  const { writeFileSync } = require('node:fs') as typeof import('node:fs');
  writeFileSync(
    ANSWERS,
    JSON.stringify({
      corpus: { roster: rosterOf(ROWS) },
      arms: [{ model: 'deepseek-chat', scale: 'mark', choices: CHOICES }],
      ...over,
    }),
  );
  return ANSWERS;
}

async function serveCsv(body: string): Promise<{ url: string; close: () => Promise<void> }> {
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

/** An endpoint that answers the way one does: a chat completion with one word in it. */
async function serveModel(body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          model: 'deepseek-chat',
          choices: [{ message: { role: 'assistant', content: body }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 130, completion_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/v1`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

describe('the command', () => {
  it('does nothing when it is not the entry module, so importing it has no effect', async () => {
    expect(await entryRepair('/somewhere/else.ts', MODULE_URL, () => undefined, { env: {} })).toBeUndefined();
  });

  it('refuses a run with no arguments, rather than guessing an artifact', async () => {
    const lines: string[] = [];
    const code = await entryRepair(ENTRY, MODULE_URL, (line) => lines.push(line), { env: {} });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('--answers is required');
  });

  it('asks, prices and writes the reading it printed', async () => {
    const served = await serveCsv(CSV);
    const model = await serveModel('pie');
    try {
      const lines: string[] = [];
      const out = join(root, 'repair.json');
      const code = await entryRepair(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', writeAnswers(), '--artifact', out],
        load: { url: served.url, cacheDir: join(root, 'corpus') } as never,
        env: { LLM_API_KEY: 'test-key', LLM_BASE_URL: model.url, TEXT2VIS_LLM_CACHE: join(root, 'store'), TEXT2VIS_LLM_CONCURRENCY: '1' },
      });
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('3 refused rows');
      expect(lines.join('\n')).toContain('1 rows carry a label no family names');
      expect(lines.join('\n')).toContain('wrote');
      const written = JSON.parse(readFileSync(out, 'utf8')) as RepairReport;
      // Three refusals and two repairable rows: `boxplot` is refused by both chartable tables, and
      // `bar` is refused by the gauge table, which holds one mark.
      expect(written.refused).toBe(3);
      expect(written.asked).toBe(2);
      expect(written.questions).toBe(2);
      expect(written.rows.map((one) => one.choice)).toEqual(['pie', 'pie']);
      expect(written.cost.calls).toBe(2);
    } finally {
      await served.close();
      await model.close();
    }
  });

  it('refuses to ask without a key, rather than reporting a repair nobody made', async () => {
    const served = await serveCsv(CSV);
    try {
      const lines: string[] = [];
      const code = await entryRepair(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', writeAnswers()],
        load: { url: served.url, cacheDir: join(root, 'corpus') } as never,
        env: {},
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('must be set');
    } finally {
      await served.close();
    }
  });

  it('refuses an artifact that does not say which rows it answered', async () => {
    const served = await serveCsv(CSV);
    try {
      const lines: string[] = [];
      const code = await entryRepair(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', writeAnswers({ corpus: {} })],
        load: { url: served.url, cacheDir: join(root, 'corpus') } as never,
        env: { LLM_API_KEY: 'test-key' },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('carries no corpus.roster');
    } finally {
      await served.close();
    }
  });

  it('refuses an artifact that answered a different population', async () => {
    const served = await serveCsv(CSV);
    try {
      const lines: string[] = [];
      const code = await entryRepair(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', writeAnswers({ corpus: { roster: 'somebody-else', asked: 4 } })],
        load: { url: served.url, cacheDir: join(root, 'corpus') } as never,
        env: { LLM_API_KEY: 'test-key' },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('different population');
    } finally {
      await served.close();
    }
  });

  it('refuses an artifact with no mark arm, and one whose choices are not per row', async () => {
    const served = await serveCsv(CSV);
    try {
      const first: string[] = [];
      expect(
        await entryRepair(ENTRY, MODULE_URL, (line) => first.push(line), {
          argv: ['--answers', writeAnswers({ arms: [{ model: 'deepseek-chat', scale: 'label' }] })],
          load: { url: served.url, cacheDir: join(root, 'corpus') } as never,
          env: { LLM_API_KEY: 'test-key' },
        }),
      ).toBe(1);
      expect(first.join('\n')).toContain('no mark-scale arm');
      const gone: string[] = [];
      expect(
        await entryRepair(ENTRY, MODULE_URL, (line) => gone.push(line), {
          argv: ['--answers', writeAnswers({ arms: undefined })],
          load: { url: served.url, cacheDir: join(root, 'corpus') } as never,
          env: { LLM_API_KEY: 'test-key' },
        }),
      ).toBe(1);
      expect(gone.join('\n')).toContain('no mark-scale arm');
      const second: string[] = [];
      expect(
        await entryRepair(ENTRY, MODULE_URL, (line) => second.push(line), {
          argv: ['--answers', writeAnswers({ arms: [{ model: 'deepseek-chat', scale: 'mark', choices: 'bar' }] })],
          load: { url: served.url, cacheDir: join(root, 'corpus') } as never,
          env: { LLM_API_KEY: 'test-key' },
        }),
      ).toBe(1);
      expect(second.join('\n')).toContain('carries no per-row choices');
    } finally {
      await served.close();
    }
  });
});

describe('what the rows refuse', () => {
  it('names a family no mark leads with, so the repair cannot take credit for it', () => {
    // A guarded fact rather than a repair concern: the corpus contains labels no mark can lead with,
    // and a repair share computed over them would be measuring the mark set.
    expect(familyOfLabel('Waterfall')).toBeUndefined();
  });
});

describe('where the question is asked', () => {
  it('reads the primary key or the BIRD one, and refuses to run without either', () => {
    expect(repairTarget({ LLM_API_KEY: 'k' }, 'm')).toEqual({
      model: 'm',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'k',
      cacheDir: 'eval/.cache/text2vis/llm-choices',
      concurrency: 6,
    });
    expect(
      repairTarget(
        { DEEPSEEK_API_KEY: 'k', LLM_BASE_URL: 'http://elsewhere/v1', TEXT2VIS_LLM_CACHE: '/tmp/store', TEXT2VIS_LLM_CONCURRENCY: '2' },
        'm',
      ),
    ).toEqual({ model: 'm', baseUrl: 'http://elsewhere/v1', apiKey: 'k', cacheDir: '/tmp/store', concurrency: 2 });
    expect(() => repairTarget({}, 'm')).toThrow(/must be set/);
  });

  it('does not default the environment, because a fallback to process.env is a branch no test can reach', () => {
    // A required field rather than `options.env ?? process.env`: the command reads the environment its
    // caller hands it, and the caller is the one place that knows it is the process.
    expect(entryRepair.length).toBe(4);
  });

  it('answers a prefix when the artifact records how many rows it asked', async () => {
    const served = await serveCsv(CSV);
    const model = await serveModel('pie');
    try {
      const lines: string[] = [];
      const code = await entryRepair(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--answers', writeAnswers({ corpus: { roster: rosterOf(ROWS.slice(0, 2)), asked: 2 } })],
        load: { url: served.url, cacheDir: join(root, 'corpus') } as never,
        env: { LLM_API_KEY: 'test-key', LLM_BASE_URL: model.url, TEXT2VIS_LLM_CACHE: join(root, 'prefix-store'), TEXT2VIS_LLM_CONCURRENCY: '1' },
      });
      // The prefix holds row 0 (refused) and row 1 (a gauge table, not repairable), so one question.
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('2 refused rows');
    } finally {
      await served.close();
      await model.close();
    }
  });
});
