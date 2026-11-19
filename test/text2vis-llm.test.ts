/**
 * The chart half, asked of a model rather than read off a rule table.
 *
 * Two things are being defended here, and only one of them is arithmetic. The arithmetic is the cheap
 * half: a closed list, a one-word answer, and the same scorer the product uses, so `model.top1 -
 * profile.top1` is a difference between two answers. The expensive half is the *honesty of the
 * instrument*: an unreadable reply is not a wrong answer, a truncated reply is not an answer at all, a
 * cached reply is not a second sample, and the label scale is not the mark scale wearing a different
 * denominator. Each of those is a test below, because each of them has been a published defect in some
 * other part of this repository.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { REASONING_CAPABILITIES, type LlmProvider, type LlmRequest, type LlmResponse } from '@agentix-e/nl2charts-ai';
import { RECOMMENDABLE_MARKS } from '@agentix-e/nl2charts-chart';
import { TEXT2VIS_FIELDS } from '../eval/text2vis/dataset.js';
import { openStore } from '../eval/text2vis/content-store.js';
import {
  askOnce,
  assertArmPopulation,
  assertArmReport,
  buildChoicePrompt,
  describeArm,
  entryLlm,
  labelOptions,
  markOptions,
  mcnemarExact,
  pairArms,
  parseChoice,
  parseLlmArgs,
  replyBudget,
  replyOf,
  rosterOf,
  runArm,
  resolveTargets,
  scoreArm,
  type ArmReport,
  type ModelOutcome,
  type ModelRow,
} from '../eval/text2vis/llm.js';
import type { ProfileInput } from '../eval/text2vis/profile.js';

const root = mkdtempSync(join(tmpdir(), 'nl2charts-text2vis-llm-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const ENTRY = resolve('eval/text2vis/llm.ts');
const MODULE_URL = pathToFileURL(ENTRY).href;
const HEADER = `${TEXT2VIS_FIELDS.prompt},${TEXT2VIS_FIELDS.answer},${TEXT2VIS_FIELDS.code},${TEXT2VIS_FIELDS.chartType},Table Data`;

function cell(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

function table(header: string, rows: readonly string[]): string {
  return [header, ...rows].join('\n');
}

const QUARTERLY = table('Date, Revenue', ['2019-01-01, 10', '2019-04-01, 14', '2019-07-01, 18', '2019-10-01, 26']);
const REGIONS = table('Region, Revenue', ['North, 40', 'South, 55', 'East, 31', 'West, 63']);

function row(prompt: string, label: string, tableData: string): ProfileInput {
  return { prompt, label, tableData };
}

/**
 * A provider that answers from a script, so a test can say what the model said without a network.
 *
 * It reports usage because the meter reads it: a fake that returned no tokens would make every cost
 * assertion in this file vacuous, which is the shape of a test that passes over a number it never
 * produced.
 */
function scripted(
  answer: (request: LlmRequest) => string,
  options: { readonly finishReason?: 'stop' | 'length'; readonly model?: string } = {},
): LlmProvider & { readonly calls: () => number; readonly seen: LlmRequest[] } {
  const named = options.model ?? 'scripted-chat';
  const seen: LlmRequest[] = [];
  return {
    id: 'scripted',
    model: named,
    complete: async (request: LlmRequest): Promise<LlmResponse> => {
      seen.push(request);
      return {
        text: answer(request),
        model: named,
        usage: { promptTokens: 120, completionTokens: 2 },
        finishReason: options.finishReason ?? 'stop',
      };
    },
    calls: () => seen.length,
    seen,
  };
}

describe('the option lists', () => {
  it('offers exactly the marks the product can draw, each with a meaning', () => {
    const options = markOptions();
    expect(options.map((option) => option.name)).toEqual([...RECOMMENDABLE_MARKS]);
    for (const option of options) expect(option.gloss.length).toBeGreaterThan(10);
  });

  it('names the corpus vocabulary the way the corpus spells it, heaviest family first', () => {
    const rows = [
      { label: 'Bar Chart' },
      { label: 'Bar Chart' },
      { label: 'Column Chart' },
      { label: 'Line Chart' },
      { label: 'Area Chart' },
      { label: 'Histogram' },
      { label: 'Violin Plot' },
      { label: 'Word Cloud' },
    ];
    const options = labelOptions(rows);
    // `Bar Chart` twice and `Column Chart` once under one family: the spelling that appears most wins,
    // which is what makes the list a function of the corpus rather than of this file's taste.
    expect(options.map((option) => option.name)).toEqual(['Bar Chart', 'Area Chart', 'Histogram', 'Line Chart', 'Violin Plot']);
    // A label with no family is not an option: it is not a thing this arm could be right about.
    expect(options.map((option) => option.name)).not.toContain('Word Cloud');
    expect(options.every((option) => option.gloss.length > 10)).toBe(true);
    // The three families no mark leads with are described by what they are, because the arm is being
    // asked about them to find out whether the product should draw them.
    expect(options.find((option) => option.name === 'Violin Plot')?.gloss).toContain('density');
    expect(options.find((option) => option.name === 'Area Chart')?.gloss).toContain('filled');
  });
});

describe('the instruction, and reading the answer back', () => {
  it('puts the list and the question in two messages, so the prefix is one byte sequence for the run', () => {
    const [system, question] = buildChoicePrompt(markOptions(), 'How has revenue changed over time?');
    expect(question).toBe('How has revenue changed over time?');
    for (const mark of RECOMMENDABLE_MARKS) expect(system).toContain(mark);
    // Byte-identical across rows: the provider's prefix cache is a discount only if the prefix is the
    // same bytes every time, and a prompt that interpolated the question would never be cached.
    expect(buildChoicePrompt(markOptions(), 'Something else')[0]).toBe(system);
  });

  it('reads an exact name, and the punctuation an endpoint adds on its own', () => {
    const options = markOptions();
    expect(parseChoice('line', options)).toBe('line');
    expect(parseChoice('  Line  ', options)).toBe('line');
    expect(parseChoice('"line"', options)).toBe('line');
    expect(parseChoice('`line`.', options)).toBe('line');
    expect(parseChoice('**line**', options)).toBe('line');
    expect(parseChoice('```text\nline\n```', options)).toBe('line');
  });

  it('refuses an answer it would have to interpret', () => {
    const options = markOptions();
    // A paragraph containing a name is not the answer this arm asked for: choosing which name a
    // sentence meant is this file deciding the mark, and the reading would then be about the reader.
    expect(parseChoice('I would use a line chart here.', options)).toBeUndefined();
    expect(parseChoice('', options)).toBeUndefined();
    expect(parseChoice('lines', options)).toBeUndefined();
    expect(parseChoice('barchart', options)).toBeUndefined();
  });

  it('leaves a thinking model unbudgeted, and gives a chat model room to finish a sentence', () => {
    // 32 was "one word plus punctuation", and 5 of 2,940 replies were cut at it — every one a model
    // that opened with a sentence. The fence is sized so that hitting it is an anomaly; a reply that
    // finishes and names nothing is `unparsed`, which is a fact about the model rather than the cap.
    expect(replyBudget({ id: 'a', model: 'a', complete: async () => ({ text: '', model: 'a' }) })).toBe(96);
    expect(
      replyBudget({
        id: 'b',
        model: 'b',
        capabilities: REASONING_CAPABILITIES,
        complete: async () => ({ text: '', model: 'b' }),
      }),
    ).toBeUndefined();
  });
});

describe('one call, and what it leaves behind', () => {
  it('asks once and reads the name', async () => {
    const provider = scripted(() => 'bar');
    const answer = await askOnce(provider, { question: 'Compare revenue by region', options: markOptions() }, {
      maxTokens: replyBudget(provider),
    });
    expect(answer).toEqual({ choice: 'bar', reply: 'bar', truncated: false });
    expect(provider.calls()).toBe(1);
    // The meter's own rule: every measured call names a purpose, or the price table cannot say what
    // the money bought.
    expect(provider.seen[0]?.purpose).toBe('select');
    expect(provider.seen[0]?.temperature).toBe(0);
    expect(provider.seen[0]?.maxTokens).toBe(96);
  });

  it('sends no budget and keeps nothing when the caller asks for neither', async () => {
    const provider = scripted(() => 'line');
    const answer = await askOnce(provider, { question: 'Q', options: markOptions() });
    expect(answer.choice).toBe('line');
    expect(provider.seen[0]?.maxTokens).toBeUndefined();
  });

  it('takes the same answer from the store instead of paying for it twice', async () => {
    const directory = join(root, 'store');
    const cache = openStore<ModelRow & { model: string }>(directory, 1, (parsed) => {
      const row = parsed as Record<string, unknown>;
      return { model: String(row['model']), choice: row['choice'] as string, reply: String(row['reply']), truncated: false };
    });
    const provider = scripted(() => 'line');
    const request = { question: 'How has revenue changed over time?', options: markOptions() };
    await askOnce(provider, request, { cache, maxTokens: 32 });
    const second = await askOnce(provider, request, { cache, maxTokens: 32 });
    expect(provider.calls()).toBe(1);
    expect(second.choice).toBe('line');
    expect(cache.hits).toBe(1);
  });

  it('refuses a stored answer another model wrote, and charges a call for it', async () => {
    const cache = openStore<ModelRow & { model: string }>(join(root, 'copied'), 1, (parsed) => {
      const row = parsed as Record<string, unknown>;
      return { model: String(row['model']), choice: 'line', reply: 'line', truncated: false };
    });
    const wrote = scripted(() => 'line');
    await askOnce(wrote, { question: 'Q1', options: markOptions() }, { cache, maxTokens: 32 });
    const reads = scripted(() => 'bar', { model: 'another-chat' });
    const answer = await askOnce(reads, { question: 'Q1', options: markOptions() }, { cache, maxTokens: 32 });
    // The key separates models, so the second provider misses rather than reading the first's answer;
    // `corrupt` is zero because nothing was wrong with the entry — it was simply not this model's.
    expect(answer.choice).toBe('bar');
    expect(cache.corrupt).toBe(0);
    expect(reads.calls()).toBe(1);
  });

  it('marks a reply cut at the budget as truncated rather than as an answer', async () => {
    const provider = scripted(() => 'lin', { finishReason: 'length' });
    const answer = await askOnce(provider, { question: 'Q', options: markOptions() }, { maxTokens: 32 });
    expect(answer.truncated).toBe(true);
    expect(answer.choice).toBeUndefined();
  });

  it('does not score the prefix of a cut reply, even when the cut lands after a name', async () => {
    // At `max_tokens: 32` five replies were cut and three of them began with the name — "Pie Chart."
    // and then a sentence nobody read. `parseChoice` strips a trailing full stop, so those three were
    // scored as answers and the first full run published 860 top-1 instead of 857. A prefix is not an
    // answer: the cut has to make the row unreadable, not readable-with-less-text.
    const provider = scripted(() => 'pie. The question asks for a share of a whole, so the', { finishReason: 'length' });
    const answer = await askOnce(provider, { question: 'What share does each region hold?', options: markOptions() }, { maxTokens: 32 });
    expect(answer.truncated).toBe(true);
    expect(answer.choice).toBeUndefined();
    // The same text without the cut is still unreadable, because it is a sentence rather than a name;
    // what the cut changes is only whether this file could have been tempted to read a prefix.
    const whole = scripted(() => 'pie.', {});
    expect((await askOnce(whole, { question: 'Q', options: markOptions() }, { maxTokens: 96 })).choice).toBe('pie');
  });
});

describe('scoring one arm', () => {
  const rows = [
    row('How has revenue changed over time?', 'Line Chart', QUARTERLY),
    row('Compare revenue by region', 'Bar Chart', REGIONS),
    row('Show the distribution of revenue', 'Box Plot', REGIONS),
  ];
  const usage = { calls: 3, promptTokens: 360, completionTokens: 6, cachedPromptTokens: 300 };
  const cache = { hits: 0, misses: 3, corrupt: 0 };

  function outcome(input: ProfileInput, choice: string | undefined): ModelOutcome {
    return { row: input, answer: { choice, reply: choice ?? 'I am not sure', truncated: false } };
  }

  it('prices the mark scale with the product’s own scorer', () => {
    const outcomes = [outcome(rows[0] as ProfileInput, 'line'), outcome(rows[1] as ProfileInput, 'pie'), outcome(rows[2] as ProfileInput, undefined)];
    const report = scoreArm(rows, outcomes, { model: 'deepseek-chat', options: markOptions(), usage, cache }, 'mark');
    expect(report.scale).toBe('mark');
    if (report.scale !== 'mark') throw new Error('unreachable');
    expect(report.scored).toBe(3);
    expect(report.top1).toBe(1);
    expect(report.declined).toBe(1);
    expect(report.answered).toBe(2);
    expect(report.unparsed).toBe(1);
    expect(report.cost.yuan).toBeGreaterThan(0);
    expect(() => assertArmReport(report)).not.toThrow();
  });

  it('counts exact family matches on the label scale, including the families no mark leads with', () => {
    // The diagnostic the mark scale cannot express: `Area Chart` and `Histogram` are answers this
    // product has no mark for, so they are unreachable there and exact matches here. A single
    // `ProfileReport` for both would have reported them as refusals on one scale and as nothing at all
    // on the other.
    const labelled = [
      row('How has revenue changed over time?', 'Area Chart', QUARTERLY),
      row('Show the distribution', 'Histogram', REGIONS),
      row('Compare revenue by region', 'Bar Chart', REGIONS),
      row('What share does each region hold?', 'Pie Chart', REGIONS),
    ];
    const outcomes = [
      outcome(labelled[0] as ProfileInput, 'Area Chart'),
      outcome(labelled[1] as ProfileInput, 'Histogram'),
      outcome(labelled[2] as ProfileInput, 'Line Chart'),
      outcome(labelled[3] as ProfileInput, 'Pie Chart'),
    ];
    const report = scoreArm(labelled, outcomes, { model: 'deepseek-chat', options: labelOptions(labelled), usage, cache }, 'label');
    expect(report.scale).toBe('label');
    if (report.scale !== 'label') throw new Error('unreachable');
    expect(report.scored).toBe(4);
    expect(report.exact).toBe(3);
    expect(report.exactShare).toBeCloseTo(0.75, 6);
    expect(report.unreachableHits).toBe(2);
    expect(report.perFamily.reduce((sum, entry) => sum + entry.n, 0)).toBe(4);
    expect(() => assertArmReport(report)).not.toThrow();
  });

  it('scores an empty population as nothing rather than as a perfect run', () => {
    const report = scoreArm([], [], { model: 'deepseek-chat', options: markOptions(), usage, cache }, 'label');
    if (report.scale !== 'label') throw new Error('unreachable');
    expect(report.scored).toBe(0);
    expect(report.exactShare).toBe(0);
    expect(report.perFamily).toEqual([]);
    expect(report.cost.perRowYuan).toBe(0);
    expect(() => assertArmReport(report)).not.toThrow();
  });

  it('accumulates a family that appears on more than one row', () => {
    const labelled = [
      row('Compare revenue by region', 'Bar Chart', REGIONS),
      row('Compare revenue by region again', 'Bar Chart', REGIONS),
      row('Compare revenue by region a third time', 'Column Chart', REGIONS),
    ];
    const outcomes = labelled.map((input) => outcome(input, 'Bar Chart'));
    const report = scoreArm(labelled, outcomes, { model: 'deepseek-chat', options: labelOptions(labelled), usage, cache }, 'label');
    if (report.scale !== 'label') throw new Error('unreachable');
    expect(report.exact).toBe(3);
    expect(report.perFamily).toEqual([{ family: 'bar', n: 3, exact: 3 }]);
    expect(() => assertArmReport(report)).not.toThrow();
  });

  it('refuses a report whose counters do not add up', () => {
    const outcomes = [outcome(rows[0] as ProfileInput, 'line')];
    const mark = scoreArm(rows, outcomes, { model: 'm', options: markOptions(), usage, cache }, 'mark');
    if (mark.scale !== 'mark') throw new Error('unreachable');
    expect(() => assertArmReport({ ...mark, unparsed: 5 })).toThrow(/unparsed is not the/);
    expect(() => assertArmReport({ ...mark, choices: ['line', null, null], requested: 3, answered: 1, unparsed: 2, declined: 1 })).toThrow(/unreadable reply was scored/);
    // Asked and unscored is a paid call that bought nothing, and it is a defect the counters above
    // cannot see: `1 answered + 0 unparsed` against `1 asked` is consistent while three rows were
    // scored, which is exactly the shape the first full run published as 1,985 asked / 1,470 scored.
    expect(() => assertArmPopulation(mark)).toThrow(/every row asked must be scored/);
    expect(() => assertArmPopulation({ ...mark, requested: 3, answered: 3, unparsed: 0, declined: 1 })).not.toThrow();
    const label = scoreArm(rows, outcomes, { model: 'm', options: labelOptions(rows), usage, cache }, 'label');
    if (label.scale !== 'label') throw new Error('unreachable');
    expect(() => assertArmReport({ ...label, exact: 9 })).toThrow(/exact matches out of/);
    expect(() => assertArmReport({ ...label, perFamily: [] })).toThrow(/per-family rows sum to 0/);
    // The answer column is checked like any other column of the report: a short list would attach every
    // answer to the row above it, and a list whose non-null count disagrees with `answered` is one of
    // the two columns being wrong. Both are refused rather than published.
    expect(() => assertArmReport({ ...mark, choices: [] })).toThrow(/not one per row/);
    expect(() => assertArmReport({ ...mark, choices: [null] })).toThrow(/one of the two columns is wrong/);
  });

  it('names the rows it answered, so an artifact cannot be read against another corpus', () => {
    const one = [{ prompt: 'Compare revenue by region', label: 'Bar Chart', tableData: 'Region, Revenue\nNorth, 40' }];
    expect(rosterOf(one)).toMatch(/^[0-9a-f]{64}$/);
    expect(rosterOf(one)).toBe(rosterOf([{ ...(one[0] as ProfileInput) }]));
    // A field separator that cannot occur in a field: concatenating without one would let `ab` + `c`
    // and `a` + `bc` hash to the same fingerprint, and two different populations would look identical.
    expect(rosterOf([{ ...(one[0] as ProfileInput), prompt: 'Compare revenue by regio', label: 'nBar Chart' }])).not.toBe(rosterOf(one));
  });

  it('says what the run cost, per row as well as in total', () => {
    const outcomes = rows.map((input) => outcome(input, 'line'));
    const report = scoreArm(rows, outcomes, { model: 'deepseek-chat', options: markOptions(), usage, cache }, 'mark');
    // 60 prompt tokens at the list rate and 300 at the cached rate, plus 6 completion: the number is a
    // function of both, which is what makes reporting `cachedPromptTokens` worth a column.
    expect(report.cost.perRowYuan).toBeCloseTo((report.cost.yuan as number) / 3, 9);
    expect(describeArm(report).join('\n')).toContain('per row');
  });

  it('prices a model the table has no rate for without inventing one', () => {
    const outcomes = [outcome(rows[0] as ProfileInput, 'line')];
    const report = scoreArm(rows, outcomes, { model: 'unpriced-model', options: markOptions(), usage, cache }, 'mark');
    expect(report.cost.yuan).toBeUndefined();
    expect(describeArm(report).join('\n')).not.toContain('cost ¥');
  });
});

describe('the ablation', () => {
  it('matches the textbook values of McNemar’s exact test', () => {
    // Two-sided by the binomial sum over the smaller tail, which is the definition the repository's
    // other paired test uses (`p = 2 * P(X <= min(b, c))`).
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(1, 1)).toBe(1);
    expect(mcnemarExact(0, 5)).toBeCloseTo(2 * (1 / 32), 9);
    expect(mcnemarExact(0, 16)).toBeCloseTo(2 / 65536, 12);
    // Symmetric: the test does not know which arm is which.
    expect(mcnemarExact(3, 11)).toBeCloseTo(mcnemarExact(11, 3), 12);
  });

  it('pairs the product against the model on the same rows', () => {
    // Four rows: both right, product only, model only, neither. The product is `profileAnswer`, so a
    // `boxplot` label over a two-column table is a product miss whatever the model says.
    const rows = [
      row('How has revenue changed over time?', 'Line Chart', QUARTERLY),
      row('Compare revenue by region', 'Bar Chart', REGIONS),
      row('Show the distribution', 'Box Plot', REGIONS),
      row('What share does each region hold?', 'Pie Chart', REGIONS),
      // Neither arm gets this one: the product draws a bar over a two-column timeline and the model
      // answered a pie. The count exists so that a row nobody won is not filed as a row the other arm
      // lost.
      row('Show the spread of revenue', 'Box Plot', QUARTERLY),
    ];
    const choices = new Map([
      [rows[0] as ProfileInput, 'line'],
      [rows[1] as ProfileInput, 'pie'],
      [rows[2] as ProfileInput, 'boxplot'],
      [rows[3] as ProfileInput, 'scatter'],
      [rows[4] as ProfileInput, 'pie'],
    ]);
    const pair = pairArms(rows, (input) => choices.get(input));
    expect(pair.both + pair.ruleOnly + pair.modelOnly + pair.neither).toBe(5);
    // A row neither arm got right is its own count: folding it into `ruleOnly` would report the model as
    // worse than it was, and into `neither`'s opposite would report the product as better.
    expect(pair.neither).toBeGreaterThan(0);
    expect(pair.ruleOnly).toBeGreaterThan(0);
    expect(pair.modelOnly).toBeGreaterThan(0);
    expect(pair.p).toBeGreaterThanOrEqual(0);
    expect(pair.p).toBeLessThanOrEqual(1);
  });
});

describe('the command', () => {
  it('accepts what it uses and refuses what it does not', () => {
    expect(parseLlmArgs([])).toEqual({ json: false, scales: ['mark', 'label'] });
    expect(parseLlmArgs(['--json', '--artifact', 'out.json', '--limit', '5'])).toEqual({
      json: true,
      scales: ['mark', 'label'],
      artifact: 'out.json',
      limit: 5,
    });
    // A dispatch that asked for one scale should pay for one scale.
    expect(parseLlmArgs(['--scales', 'mark']).scales).toEqual(['mark']);
    expect(() => parseLlmArgs(['--artfacts', 'x'])).toThrow(/unknown argument --artfacts/);
    expect(() => parseLlmArgs(['--artifact'])).toThrow(/needs a path/);
    expect(() => parseLlmArgs(['--limit', '0'])).toThrow(/positive whole number/);
    expect(() => parseLlmArgs(['--scales', 'marks'])).toThrow(/not a scale this arm has/);
    expect(() => parseLlmArgs(['--scales'])).toThrow(/needs a list of mark, label/);
    expect(() => parseLlmArgs(['--scales', '--json'])).toThrow(/needs a list of mark, label/);
  });

  it('resolves the endpoints from the names the bird jobs already use', () => {
    const primary = resolveTargets({ DEEPSEEK_API_KEY: 'k' });
    expect(primary).toEqual([{ model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k' }]);
    // A listed pair is a matrix over one corpus, the second model taking the second key.
    const pair = resolveTargets({ TEXT2VIS_LLM_MODELS: 'deepseek-chat,glm-4.5', DEEPSEEK_API_KEY: 'k', ZHIPU_API_KEY: 'z' });
    expect(pair.map((target) => target.model)).toEqual(['deepseek-chat', 'glm-4.5']);
    expect(pair[1]?.apiKey).toBe('z');
    // `BIRD_SECOND_MODEL` is honoured because it is the variable a BIRD dispatch already sets, and a
    // chart run should not need a second spelling of the same decision.
    expect(resolveTargets({ BIRD_SECOND_MODEL: 'glm-4.5', ZHIPU_API_KEY: 'z' }).map((target) => target.model)).toEqual([
      'deepseek-chat',
      'glm-4.5',
    ]);
  });
});

/** A corpus of two rows, served over a real socket: the same seam every other corpus test uses. */
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

const TWO_ROWS = [
  HEADER,
  [cell('How has revenue changed over time?'), cell('10'), cell(''), cell('Line Chart'), cell(QUARTERLY)].join(','),
  [cell('Compare revenue by region'), cell('North'), cell(''), cell('Bar Chart'), cell(REGIONS)].join(','),
].join('\n');

describe('the arm, end to end', () => {
  it('does not spend a call on a row no scale can score, and says how many it dropped', async () => {
    // The first full dispatch asked all 1,985 corpus rows for a 1,470-row reading: the 515 labels no
    // family names went to the model, came back, and were dropped by the scorer. That is 515 wasted
    // calls per scale, and the assertion that catches it is `requested === scored`.
    const body = [
      HEADER,
      [cell('How has revenue changed over time?'), cell('10'), cell(''), cell('Line Chart'), cell(QUARTERLY)].join(','),
      [cell('Draw the flows between stages'), cell('10'), cell(''), cell('Waterfall'), cell(QUARTERLY)].join(','),
    ].join('\n');
    const server = await serve(body);
    const lines: string[] = [];
    const provider = scripted(() => 'line');
    try {
      const target = join(root, 'unmapped.json');
      const code = await entryLlm(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--artifact', target, '--scales', 'mark'],
        load: { cacheDir: join(root, 'unmapped-corpus'), url: server.url },
        env: { TEXT2VIS_LLM_CACHE: 'none' },
        providers: () => [provider],
      });
      expect(code).toBe(0);
      // One scoreable row, one call: the waterfall row is never sent.
      expect(provider.calls()).toBe(1);
      expect(lines.join('\n')).toContain('1 of 2 rows carry a label no family names');
      const written = JSON.parse(readFileSync(target, 'utf8')) as {
        corpus: { rows: number; scored: number; asked: number; roster: string };
        arms: { requested: number; scored: number }[];
      };
      expect(written.corpus.rows).toBe(2);
      expect(written.corpus.scored).toBe(1);
      expect(written.corpus.asked).toBe(1);
      // The roster names the one row that was asked, so a second process can tell whether the answers
      // in this artifact belong to the rows it is holding.
      expect(written.corpus.roster).toMatch(/^[0-9a-f]{64}$/);
      expect(written.arms[0]?.requested).toBe(1);
      expect(written.arms[0]?.scored).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('asks once per row per scale and writes the report', async () => {
    const server = await serve(TWO_ROWS);
    const lines: string[] = [];
    // Two rows, two different answers, so an answer list that is not aligned with the rows is visible:
    // a provider that answered `line` twice would make the alignment untestable.
    const provider = scripted((request) => {
      const line = (request.messages[1]?.content ?? '').includes('changed over time');
      const labelScale = (request.messages[0]?.content ?? '').includes('Bar Chart');
      if (labelScale) return line ? 'Line Chart' : 'Bar Chart';
      return line ? 'line' : 'bar';
    });
    try {
      const target = join(root, 'arm.json');
      const code = await entryLlm(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--artifact', target],
        load: { cacheDir: join(root, 'served'), url: server.url },
        env: { TEXT2VIS_LLM_CACHE: 'none' },
        providers: () => [provider],
      });
      expect(code).toBe(0);
      const written = JSON.parse(readFileSync(target, 'utf8')) as {
        arms: ArmReport[];
        paired: { model: string; pair: { both: number } }[];
      };
      expect(written.arms.map((arm) => arm.scale)).toEqual(['mark', 'label']);
      // Two rows, two scales, one call each.
      expect(provider.calls()).toBe(4);
      expect(written.paired).toHaveLength(1);
      const mark = written.arms[0];
      expect(mark?.scale).toBe('mark');
      expect(mark?.scored).toBe(2);
      // The answers travel with the report: one entry per asked row, in the order they were asked, and
      // the label scale's list is aligned to the same rows so the two can be read side by side.
      expect(mark?.choices).toEqual(['line', 'bar']);
      expect(written.arms[1]?.choices).toEqual(['Line Chart', 'Bar Chart']);
      expect(lines.join('\n')).toContain('paired against the product');
    } finally {
      await server.close();
    }
  });

  it('publishes a null where the reply named nothing, so the column stays one per row', async () => {
    const server = await serve(TWO_ROWS);
    const provider = scripted(() => 'I would suggest a chart of some kind');
    try {
      const target = join(root, 'column.json');
      const code = await entryLlm(ENTRY, MODULE_URL, () => undefined, {
        argv: ['--artifact', target, '--scales', 'mark'],
        load: { cacheDir: join(root, 'column'), url: server.url },
        env: { TEXT2VIS_LLM_CACHE: 'none' },
        providers: () => [provider],
      });
      expect(code).toBe(0);
      const written = JSON.parse(readFileSync(target, 'utf8')) as { arms: { choices: (string | null)[] }[] };
      // `null` and not a short array: an array that shifted would attach every answer to the row above
      // it, and the arithmetic would still balance.
      expect(written.arms[0]?.choices).toEqual([null, null]);
    } finally {
      await server.close();
    }
  });

  it('counts an unreadable reply instead of scoring it, and still publishes', async () => {
    const server = await serve(TWO_ROWS);
    const lines: string[] = [];
    const provider = scripted(() => 'I would suggest a chart of some kind');
    try {
      const code = await entryLlm(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--json', '--scales', 'mark'],
        load: { cacheDir: join(root, 'unreadable'), url: server.url },
        env: { TEXT2VIS_LLM_CACHE: 'none' },
        providers: () => [provider],
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(lines.find((line) => line.startsWith('{')) as string) as {
        arms: { unparsed: number; answered: number; declined: number }[];
      };
      expect(parsed.arms[0]?.unparsed).toBe(2);
      expect(parsed.arms[0]?.answered).toBe(0);
      expect(parsed.arms[0]?.declined).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('refuses to publish a run whose replies were cut', async () => {
    const server = await serve(TWO_ROWS);
    const lines: string[] = [];
    const provider = scripted(() => 'lin', { finishReason: 'length' });
    try {
      const code = await entryLlm(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--scales', 'mark'],
        load: { cacheDir: join(root, 'truncated'), url: server.url },
        env: { TEXT2VIS_LLM_CACHE: 'none' },
        providers: () => [provider],
      });
      // A cut reply is not an answer, so the share this run would otherwise publish is not a reading.
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('cut at the token budget');
    } finally {
      await server.close();
    }
  });

  it('fails on a missing key before spending anything, and names the variable', async () => {
    const server = await serve(TWO_ROWS);
    const lines: string[] = [];
    try {
      const code = await entryLlm(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: [],
        load: { cacheDir: join(root, 'nokey'), url: server.url },
        env: {},
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('LLM_API_KEY');
    } finally {
      await server.close();
    }
  });
});

describe('a sample may decide how many rows are asked, not what may be answered', () => {
  it('builds the label vocabulary from the whole corpus while asking only the sampled rows', async () => {
    // The smoke run's first twenty rows name two families, and an option list built from them offered
    // two charts: twelve of twenty answers named a chart that was not on the list and were counted as
    // unreadable. The list is the question, and a question that shrinks with the sample makes `--limit`
    // a second variable in a comparison.
    const asked: string[] = [];
    const provider: LlmProvider = {
      id: 'p',
      model: 'deepseek-chat',
      complete: async (request) => {
        asked.push(request.messages[0]?.content ?? '');
        const question = request.messages[1]?.content ?? '';
        // The sampled line row is answered with a family the *sample* does not name, which is the
        // answer the shrunken list used to reject; the bar row is answered correctly.
        const text = question.includes('changed over time') ? 'Pie Chart' : 'Bar Chart';
        return { text, model: 'deepseek-chat', finishReason: 'stop' };
      },
    };
    const corpus = [
      row('How has revenue changed over time?', 'Line Chart', QUARTERLY),
      row('Compare revenue by region', 'Bar Chart', REGIONS),
      row('What share does each region hold?', 'Pie Chart', REGIONS),
    ];
    const { report } = await runArm({
      provider,
      scale: 'label',
      rows: corpus.slice(0, 2),
      vocabulary: corpus,
      concurrency: 2,
    });
    // Three families offered, two rows asked: the pie answer on the line row is a readable miss, not
    // an unreadable reply, and the bar answer is the one exact match.
    expect(asked[0]).toContain('Pie Chart');
    expect(asked[0]).toContain('Line Chart');
    expect(asked[0]).toContain('Bar Chart');
    if (report.scale !== 'label') throw new Error('unreachable');
    expect(report.requested).toBe(2);
    expect(report.unparsed).toBe(0);
    expect(report.answered).toBe(2);
    expect(report.exact).toBe(1);
  });

  it('offers only the rows it was given when the caller names no vocabulary', async () => {
    // The fallback, and the reason it is a fallback rather than the default: a caller that holds one
    // row can only describe that row's family. `entryLlm` is what supplies the corpus, so this path is
    // reached by a programmatic arm and must still be a list rather than an empty prompt.
    const asked: string[] = [];
    const provider: LlmProvider = {
      id: 'p',
      model: 'deepseek-chat',
      complete: async (request) => {
        asked.push(request.messages[0]?.content ?? '');
        return { text: 'Bar Chart', model: 'deepseek-chat', finishReason: 'stop' };
      },
    };
    const rows = [row('Compare revenue by region', 'Bar Chart', REGIONS)];
    const { report } = await runArm({ provider, scale: 'label', rows, concurrency: 1 });
    // One option, because one family is all this caller knows about; the gloss separator counts them.
    expect(asked[0]?.split('\n').filter((line) => line.includes(' — '))).toHaveLength(1);
    expect(asked[0]).toContain('Bar Chart');
    if (report.scale !== 'label') throw new Error('unreachable');
    expect(report.exact).toBe(1);
  });
});

describe('an arm on a model that thinks aloud', () => {
  it('sends no output cap at all, because a cap sized for one word truncates the deliberation', async () => {
    const seen: LlmRequest[] = [];
    const provider: LlmProvider = {
      id: 'reasoning',
      model: 'deepseek-reasoner',
      capabilities: REASONING_CAPABILITIES,
      complete: async (request) => {
        seen.push(request);
        return { text: 'line', model: 'deepseek-reasoner', finishReason: 'stop', usage: { promptTokens: 200, completionTokens: 40 } };
      },
    };
    const rows = [row('How has revenue changed over time?', 'Line Chart', QUARTERLY)];
    const { report } = await runArm({ provider, scale: 'mark', rows, concurrency: 1 });
    expect(seen[0]?.maxTokens).toBeUndefined();
    // The request is handed over as this arm built it; `adaptRequest` strips the sampling field before
    // the wire on an endpoint that declared it ignores one, which is where that decision belongs.
    expect(seen[0]?.temperature).toBe(0);
    if (report.scale !== 'mark') throw new Error('unreachable');
    expect(report.top1).toBe(1);
    // The deliberation is billed *inside* completion tokens, so the meter does not add it again: a
    // second charge for the same tokens would inflate exactly the rows whose cost is under review.
    expect(report.cost.yuan).toBeGreaterThan(0);
  });
});

describe('the record a second run reads', () => {
  it('accepts the row it wrote and refuses one it cannot stand behind', () => {
    const good = { version: 1, model: 'deepseek-chat', choice: 'bar', reply: 'bar', truncated: false };
    expect(replyOf(good, { model: 'deepseek-chat' })).toEqual({
      model: 'deepseek-chat',
      choice: 'bar',
      reply: 'bar',
      truncated: false,
    });
    // An answer that named nothing is a legal record, and the absence of the field is how it is
    // written -- `JSON.stringify` drops an `undefined`, so the reader has to accept it.
    expect(replyOf({ ...good, choice: undefined }, undefined)?.choice).toBeUndefined();
    expect(replyOf({ ...good, choice: null }, undefined)?.choice).toBeUndefined();
    // Every other failure is a record this reader will not serve: a version it does not know, a reply
    // that is not text, a truncation flag that is not a flag, a row with no model, a choice that is
    // neither a name nor an absence, and a row another model wrote.
    expect(replyOf('not an object', undefined)).toBeUndefined();
    expect(replyOf(null, undefined)).toBeUndefined();
    expect(replyOf({ ...good, version: 2 }, undefined)).toBeUndefined();
    expect(replyOf({ ...good, reply: 7 }, undefined)).toBeUndefined();
    expect(replyOf({ ...good, truncated: 'no' }, undefined)).toBeUndefined();
    expect(replyOf({ ...good, model: undefined }, undefined)).toBeUndefined();
    expect(replyOf({ ...good, choice: 42 }, undefined)).toBeUndefined();
    expect(replyOf(good, { model: 'another-chat' })).toBeUndefined();
  });
});

describe('the counters a report can be wrong about', () => {
  it('refuses more top-1 hits than the shortlist that contains them', () => {
    const rows = [row('How has revenue changed over time?', 'Line Chart', QUARTERLY)];
    const outcomes: ModelOutcome[] = [
      { row: rows[0] as ProfileInput, answer: { choice: 'line', reply: 'line', truncated: false } },
    ];
    const report = scoreArm(rows, outcomes, {
      model: 'deepseek-chat',
      options: markOptions(),
      usage: { calls: 1, promptTokens: 120, completionTokens: 2, cachedPromptTokens: 0 },
      cache: { hits: 0, misses: 1, corrupt: 0 },
    }, 'mark');
    if (report.scale !== 'mark') throw new Error('unreachable');
    expect(() => assertArmReport({ ...report, shortlist: 0 })).toThrow(/shortlist hits/);
  });

  it('skips a row whose label has no family rather than pairing it', () => {
    const rows = [row('How has revenue changed over time?', 'Word Cloud', QUARTERLY)];
    expect(pairArms(rows, () => 'line')).toEqual({ both: 0, ruleOnly: 0, modelOnly: 0, neither: 0, p: 1 });
  });
});

describe('the endpoints a dispatch can name', () => {
  it('lets a second model carry its own URL and key', () => {
    const targets = resolveTargets({
      TEXT2VIS_LLM_MODELS: 'deepseek-chat,glm-4.5',
      TEXT2VIS_SECOND_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
      TEXT2VIS_SECOND_API_KEY: 'z2',
    });
    expect(targets[1]).toEqual({ model: 'glm-4.5', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'z2' });
    // The bird names are read too, because a workflow that already holds one set of secrets should
    // not need a second spelling of the same decision.
    const bird = resolveTargets({ BIRD_SECOND_MODEL: 'glm-4.5', BIRD_SECOND_BASE_URL: 'https://z/v4', BIRD_SECOND_API_KEY: 'bk' });
    expect(bird[1]).toEqual({ model: 'glm-4.5', baseUrl: 'https://z/v4', apiKey: 'bk' });
    // The chain falls through: the chart arm's name, then the bird name, then the primary's own URL.
    expect(resolveTargets({ BIRD_SECOND_MODEL: 'glm-4.5', BIRD_SECOND_API_KEY: 'bk' })[1]?.baseUrl).toBe('https://api.deepseek.com/v1');
    // One listed model means one arm: the primary is not asked twice.
    expect(resolveTargets({ TEXT2VIS_LLM_MODELS: 'deepseek-chat', BIRD_SECOND_MODEL: 'glm-4.5', ZHIPU_API_KEY: 'z' })).toHaveLength(2);
  });
});

describe('a run that is not the entry point', () => {
  it('does nothing when another module is the one being imported', async () => {
    expect(await entryLlm('/somewhere/else.ts', MODULE_URL, () => undefined)).toBeUndefined();
  });
});

describe('the second run of the same corpus', () => {
  it('pays for nothing, and reports the hits it saved', async () => {
    const server = await serve(TWO_ROWS);
    const directory = join(root, 'warm');
    const provider = scripted(() => 'line');
    try {
      const first = await entryLlm(ENTRY, MODULE_URL, () => undefined, {
        argv: ['--scales', 'mark'],
        load: { cacheDir: join(root, 'warm-corpus'), url: server.url },
        env: { TEXT2VIS_LLM_CACHE: directory, TEXT2VIS_LLM_CONCURRENCY: '1' },
        providers: () => [provider],
      });
      expect(first).toBe(0);
      const callsAfterFirst = provider.calls();
      const lines: string[] = [];
      const second = await entryLlm(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--json', '--scales', 'mark', '--limit', '2'],
        load: { cacheDir: join(root, 'warm-corpus'), url: server.url },
        env: { TEXT2VIS_LLM_CACHE: directory, TEXT2VIS_LLM_CONCURRENCY: 'not a number' },
        providers: () => [provider],
      });
      expect(second).toBe(0);
      // The same two questions, the same prompt, the same model: the store answers both.
      expect(provider.calls()).toBe(callsAfterFirst);
      const parsed = JSON.parse(lines.find((line) => line.startsWith('{')) as string) as { arms: { cache: { hits: number } }[] };
      expect(parsed.arms[0]?.cache.hits).toBe(2);
    } finally {
      await server.close();
    }
  });
});

describe('the endpoint the arm actually talks to', () => {
  /** An OpenAI-compatible endpoint that answers with one word, so the wire is exercised, not mocked. */
  async function endpoint(word: string): Promise<{ url: string; bodies: string[]; close: () => Promise<void> }> {
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            model: 'deepseek-chat',
            choices: [{ message: { role: 'assistant', content: word }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 210, completion_tokens: 1, prompt_cache_hit_tokens: 200 },
          }),
        );
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${String(port)}/v1`,
      bodies,
      close: () => new Promise<void>((done) => server.close(() => done())),
    };
  }

  it('builds the provider from the environment and prices what the endpoint billed', async () => {
    const corpus = await serve(TWO_ROWS);
    const api = await endpoint('line');
    const lines: string[] = [];
    try {
      const code = await entryLlm(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--json', '--scales', 'mark'],
        load: { cacheDir: join(root, 'wire'), url: corpus.url },
        env: { LLM_API_KEY: 'test-key', LLM_BASE_URL: api.url, TEXT2VIS_LLM_CACHE: 'none' },
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(lines.find((line) => line.startsWith('{')) as string) as {
        arms: { cost: { calls: number; promptTokens: number; cachedPromptTokens: number; yuan?: number } }[];
      };
      const cost = parsed.arms[0]?.cost;
      expect(cost?.calls).toBe(2);
      // What the endpoint said it billed travels into the price, cached tokens included: a report that
      // counted only `prompt_tokens` would publish the list price as the bill.
      expect(cost?.promptTokens).toBe(420);
      expect(cost?.cachedPromptTokens).toBe(400);
      expect(cost?.yuan).toBeGreaterThan(0);
      // The wire, not just the report: the purpose a meter files the call under has to be on the
      // request, and the budget a chat model gets has to be the one `replyBudget` names.
      const body = JSON.parse(api.bodies[0] as string) as { max_tokens: number; temperature: number; model: string };
      expect(body.max_tokens).toBe(96);
      expect(body.temperature).toBe(0);
      expect(body.model).toBe('deepseek-chat');
    } finally {
      await api.close();
      await corpus.close();
    }
  });

  it('refuses a corpus on which nothing could be scored', async () => {
    // One row whose label has no family: the arm asks and cannot score, and a share over zero rows is
    // not a reading however good the answers were.
    const body = [
      HEADER,
      [cell('How has revenue changed over time?'), cell('10'), cell(''), cell('Word Cloud'), cell(QUARTERLY)].join(','),
    ].join('\n');
    const corpus = await serve(body);
    const lines: string[] = [];
    try {
      const code = await entryLlm(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--scales', 'mark'],
        load: { cacheDir: join(root, 'nothing'), url: corpus.url },
        env: { TEXT2VIS_LLM_CACHE: 'none' },
        providers: () => [scripted(() => 'line')],
      });
      expect(code).toBe(1);
    } finally {
      await corpus.close();
    }
  });

  it('reports a thrown string as a thrown string', async () => {
    const corpus = await serve(TWO_ROWS);
    const lines: string[] = [];
    try {
      const code = await entryLlm(ENTRY, MODULE_URL, (line) => lines.push(line), {
        argv: ['--scales', 'mark'],
        load: { cacheDir: join(root, 'thrown'), url: corpus.url },
        env: { TEXT2VIS_LLM_CACHE: 'none' },
        providers: () => {
          throw 'the provider factory refused';
        },
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('the provider factory refused');
    } finally {
      await corpus.close();
    }
  });
});
