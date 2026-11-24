import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { LlmProvider, LlmResponse } from '@agentix-e/nl2charts-ai';
import {
  answerOf, buildSpecPrompt, chartOf, DEFAULT_RULES, main, mapLimit, parseArgs, parseSpecs,
  providerFromEnv, runArm, rulesOf, splitDigest, summaryLine, timeoutMsOf, PROMPT_VERSION, SPEC_MARKS,
} from '../eval/nvbench2/arm.js';
import { cacheKey } from '../eval/text2vis/content-store.js';
import { factsOf, ceilingOf, MARK_FROM_VEGA } from '../eval/nvbench2/facts.js';
import type { SplitRow } from '../eval/nvbench2/check.js';
import type { FieldTypes } from '../eval/nvbench2/judge.js';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nl2charts-nvbench2-arm-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const TYPES: FieldTypes = { name: 'category', amount: 'quantitative' };

/** A gold that a chart naming `name` and `amount` matches exactly. */
const GOLD = { mark: 'bar', encoding: { x: { field: 'name' }, y: { field: 'amount' } } };

function row(index: number, golds: unknown[] = [GOLD], csv = 'a.csv'): SplitRow {
  return { index, csv, question: `how much per name (${String(index)})`, golds, columns: ['name', 'amount'], examples: {} };
}

/** A provider whose reply is a constant, so the arm's own reading is the only variable. */
function fake(reply: string, options: { readonly finishReason?: LlmResponse['finishReason'] } = {}): LlmProvider & { readonly seen: string[] } {
  const seen: string[] = [];
  return {
    id: 'fake',
    model: 'fake-model',
    seen,
    complete: async (request) => {
      seen.push(request.messages.map((message) => message.content).join('\n'));
      return {
        text: reply,
        model: 'fake-model',
        usage: { promptTokens: 100, completionTokens: 40 },
        finishReason: options.finishReason ?? 'stop',
      };
    },
  };
}

describe('the prompt', () => {
  it('lists every field with the type map’s own word for it', () => {
    const [system, user] = buildSpecPrompt({ question: 'who bought what' }, TYPES, 3);
    expect(user).toContain('name (category)');
    expect(user).toContain('amount (quantitative)');
    expect(user).toContain('Question: who bought what');
    for (const mark of SPEC_MARKS) expect(system).toContain(mark);
    expect(system).toContain('at most 3 charts');
    expect(system).toContain('"transform"');
  });

  it('names the budget it was given, so two k values are two prompts', () => {
    const [five] = buildSpecPrompt({ question: 'q' }, TYPES, 5);
    expect(five).toContain('at most 5 charts');
  });
});

describe('the reply', () => {
  it('keeps the three keys the judge compares and drops the rest', () => {
    const reply = JSON.stringify([
      { mark: 'bar', encoding: { x: { field: 'name' }, y: { field: 'amount' } }, title: 'a title', width: 300 },
    ]);
    const charts = parseSpecs(reply, 3);
    expect(charts).toHaveLength(1);
    expect(Object.keys(charts[0] as object).sort()).toEqual(['encoding', 'mark']);
  });

  it('reads through a code fence and through a sentence around the array', () => {
    const body = JSON.stringify([GOLD]);
    expect(parseSpecs(`\`\`\`json\n${body}\n\`\`\``, 3)).toHaveLength(1);
    expect(parseSpecs(`Here is the chart: ${body} — good luck.`, 3)).toHaveLength(1);
  });

  it('keeps a filter, because a filtered chart is a different chart', () => {
    const filtered = { mark: 'line', encoding: { x: { field: 'name' }, y: { field: 'amount', aggregate: 'mean' } }, transform: [{ filter: { field: 'amount', gte: 2 } }] };
    const charts = parseSpecs(JSON.stringify([filtered]), 3);
    expect(charts[0]?.['transform']).toEqual([{ filter: { field: 'amount', gte: 2 } }]);
  });

  it('drops an empty transform rather than carrying a key with nothing in it', () => {
    const charts = parseSpecs(JSON.stringify([{ ...GOLD, transform: [] }]), 3);
    expect(charts[0]).not.toHaveProperty('transform');
  });

  it('accepts a channel that names an aggregate and no field, as arc golds do', () => {
    const arc = { mark: 'arc', encoding: { theta: { aggregate: 'count' }, color: { field: 'name' } } };
    expect(parseSpecs(JSON.stringify([arc]), 3)).toHaveLength(1);
  });

  it('refuses a mark this repository cannot draw, and keeps the charts beside it', () => {
    const reply = JSON.stringify([{ mark: 'area', encoding: { x: { field: 'name' } } }, GOLD]);
    expect(parseSpecs(reply, 3)).toEqual([{ mark: 'bar', encoding: { x: { field: 'name' }, y: { field: 'amount' } } }]);
  });

  it('refuses an entry with no encoding, an empty encoding, or a channel that is not an object', () => {
    expect(parseSpecs(JSON.stringify([{ mark: 'bar' }]), 3)).toEqual([]);
    expect(parseSpecs(JSON.stringify([{ mark: 'bar', encoding: {} }]), 3)).toEqual([]);
    expect(parseSpecs(JSON.stringify([{ mark: 'bar', encoding: { x: 'name' } }]), 3)).toEqual([]);
    expect(parseSpecs(JSON.stringify([{ mark: 'bar', encoding: { x: { field: 7 } } }]), 3)).toEqual([]);
    expect(parseSpecs(JSON.stringify([{ mark: 'bar', encoding: { x: { aggregate: 3 } } }]), 3)).toEqual([]);
    expect(parseSpecs(JSON.stringify(['a string', 42, null]), 3)).toEqual([]);
  });

  it('drops a repeated chart and stops at k', () => {
    const other = { mark: 'line', encoding: { x: { field: 'name' }, y: { field: 'amount' } } };
    expect(parseSpecs(JSON.stringify([GOLD, GOLD]), 3)).toHaveLength(1);
    expect(parseSpecs(JSON.stringify([GOLD, other, { mark: 'point', encoding: { x: { field: 'name' } } }]), 2)).toHaveLength(2);
  });

  it('reads nothing out of a reply that is not JSON, or an array, or is empty', () => {
    expect(parseSpecs('[{"mark": }]', 3)).toEqual([]);
    expect(parseSpecs('I cannot answer that.', 3)).toEqual([]);
    expect(parseSpecs('{"mark": "bar"}', 3)).toEqual([]);
    expect(parseSpecs('[{"mark": ', 3)).toEqual([]);
    expect(parseSpecs('', 3)).toEqual([]);
    expect(parseSpecs(JSON.stringify([GOLD]), 0)).toEqual([]);
  });

  it('treats a channel list as one channel object, not as a list of fields', () => {
    expect(chartOf({ mark: 'bar', encoding: { x: [{ field: 'name' }] } })).toBeUndefined();
  });
});

describe('the stored answer', () => {
  it('is trusted only when its version, its model and its fields are the ones asked for', () => {
    const good = { version: PROMPT_VERSION, model: 'm', reply: '[]', truncated: false };
    expect(answerOf(good, 'm')).toEqual(good);
    expect(answerOf({ ...good, version: PROMPT_VERSION + 1 }, 'm')).toBeUndefined();
    expect(answerOf({ ...good, model: 'other' }, 'm')).toBeUndefined();
    expect(answerOf({ ...good, reply: 3 }, 'm')).toBeUndefined();
    expect(answerOf({ ...good, truncated: 'no' }, 'm')).toBeUndefined();
    expect(answerOf(null, 'm')).toBeUndefined();
    // A store read without an expectation takes the model from the entry: `get(key)` is legal, and a
    // reader that insisted on being told would refuse every such entry.
    expect(answerOf(good)?.model).toBe('m');
    expect(answerOf({ ...good, model: 7 })).toBeUndefined();
  });

  it('keeps the meters when they are counts, and refuses half a bill', () => {
    const base = { version: PROMPT_VERSION, model: 'm', reply: '[]', truncated: false };
    expect(answerOf({ ...base, usage: { promptTokens: 5, completionTokens: 6, cachedPromptTokens: 1 } }, 'm')?.usage)
      .toEqual({ promptTokens: 5, completionTokens: 6, cachedPromptTokens: 1 });
    expect(answerOf({ ...base, usage: { promptTokens: 5, completionTokens: 6 } }, 'm')?.usage?.cachedPromptTokens)
      .toBeUndefined();
    expect(answerOf({ ...base, usage: { promptTokens: 5 } }, 'm')).toBeUndefined();
    expect(answerOf({ ...base, usage: 'free' }, 'm')).toBeUndefined();
  });
});

describe('the corpus facts', () => {
  const split = [
    row(0, [GOLD, GOLD, GOLD]),
    row(1, [{ mark: 'area', encoding: { color: { field: 'name', aggregate: 'count' } }, transform: [{ filter: {} }] }]),
  ];

  it('counts the gold-set sizes, the marks and the channels the golds use', () => {
    const facts = factsOf(split);
    expect(facts.questions).toBe(2);
    expect(facts.golds).toBe(4);
    expect(facts.sizeHistogram).toEqual({ '1': 1, '3': 1 });
    expect(facts.marks).toEqual({ area: 1, bar: 3 });
    expect(facts.channels).toEqual({ color: 1, x: 3, y: 3 });
    expect(facts.aggregates).toEqual({ count: 1 });
  });

  it('counts a gold that is not a chart as unexpressible, and a channel that is not an object as no channel', () => {
    const facts = factsOf([row(0, ['not a chart', { mark: 3 }, { mark: 'bar', encoding: { x: 'name' } }])]);
    expect(facts.marks).toEqual({ bar: 1, none: 2 });
    expect(facts.channels).toEqual({});
    expect(facts.expressible).toBe(1);
    expect(facts.transformed).toBe(0);
  });

  it('says how much of the vocabulary this repository can draw, and how much restricts its rows', () => {
    const facts = factsOf(split);
    expect(facts.expressible).toBe(3);
    expect(facts.transformed).toBe(1);
    expect(Object.keys(MARK_FROM_VEGA)).toContain('arc');
  });

  it('prints the metric’s own ceiling, which the gold sets impose before any arm is scored', () => {
    expect(ceilingOf(1, 3)).toBeCloseTo(0.5, 12);
    expect(ceilingOf(3, 3)).toBe(1);
    expect(ceilingOf(5, 3)).toBeCloseTo(0.75, 12);
    const facts = factsOf(split);
    expect(facts.ceiling['3']).toBeCloseTo((1 + 0.5) / 2, 12);
    expect(factsOf([]).ceiling['5']).toBe(0);
    expect(factsOf([]).golds).toBe(0);
  });
});

describe('the arm', () => {
  it('scores a chart that matches its gold, and bills what the calls reported', async () => {
    const report = await runArm({
      split: 'dev',
      rows: [row(0), row(1)],
      types: { 'a.csv': TYPES },
      provider: fake(JSON.stringify([GOLD])),
      k: 3,
      maxTokens: 900,
      concurrency: 2,
    });
    expect(report.reading.questions).toBe(2);
    expect(report.reading.f1['1']).toBe(1);
    expect(report.reading.f1['3']).toBe(1);
    expect(report.cost.calls).toBe(2);
    expect(report.cost.promptTokens).toBe(200);
    expect(report.cost.completionTokens).toBe(80);
    // `fake-model` has no price in `eval/price.ts`, and an unpriced model reports `undefined`
    // rather than a zero that would read as free.
    expect(report.cost.yuan).toBeUndefined();
    expect(report.unparsed).toBe(0);
    expect(report.truncated).toBe(0);
    expect(report.replayed).toBe(0);
    expect(report.facts.questions).toBe(2);
  });

  it('counts a truncated reply as no answer rather than as a wrong one', async () => {
    const report = await runArm({
      split: 'dev',
      rows: [row(0)],
      types: { 'a.csv': TYPES },
      provider: fake(JSON.stringify([GOLD]), { finishReason: 'length' }),
      k: 3,
      maxTokens: 900,
      concurrency: 1,
    });
    expect(report.truncated).toBe(1);
    expect(report.unparsed).toBe(0);
    expect(report.reading.f1['1']).toBe(0);
  });

  it('counts a reply that named no chart, and one whose table has no type map', async () => {
    const report = await runArm({
      split: 'dev',
      rows: [row(0), row(1, [GOLD], 'b.csv')],
      types: { 'a.csv': TYPES },
      provider: fake('I would draw a bar chart, but not today.'),
      k: 3,
      maxTokens: 900,
      concurrency: 1,
    });
    expect(report.unparsed).toBe(2);
    expect(report.cost.calls).toBe(1);
  });

  it('keeps the first N answers verbatim when it is asked to, so a surprising reading can be read', async () => {
    const report = await runArm({
      split: 'dev', rows: [row(0), row(1)], types: { 'a.csv': TYPES },
      provider: fake(JSON.stringify([GOLD])), k: 3, maxTokens: 900, concurrency: 1, samples: 1,
    });
    const samples = (report as unknown as { samples: { question: string; predictions: unknown[]; golds: unknown[] }[] }).samples;
    expect(samples).toHaveLength(1);
    expect(samples[0]?.predictions).toHaveLength(1);
    expect(samples[0]?.golds).toHaveLength(1);
    expect(samples[0]?.question).toContain('how much per name');
  });

  it('asks only the first N rows when a limit is given', async () => {
    const report = await runArm({
      split: 'dev',
      rows: [row(0), row(1)],
      types: { 'a.csv': TYPES },
      provider: fake(JSON.stringify([GOLD])),
      k: 3,
      maxTokens: 900,
      concurrency: 1,
      limit: 1,
    });
    expect(report.asked).toBe(1);
    expect(report.reading.questions).toBe(1);
  });

  it('replays a stored answer instead of buying it twice', async () => {
    const dir = scratch();
    const { openStore } = await import('../eval/text2vis/content-store.js');
    const store = openStore(dir, PROMPT_VERSION, (parsed, expect) => answerOf(parsed, expect?.model ?? ''));
    const provider = fake(JSON.stringify([GOLD]));
    const first = await runArm({ split: 'dev', rows: [row(0)], types: { 'a.csv': TYPES }, provider, k: 3, maxTokens: 900, concurrency: 1, cache: store });
    expect(first.cost.calls).toBe(1);
    const second = await runArm({ split: 'dev', rows: [row(0)], types: { 'a.csv': TYPES }, provider, k: 3, maxTokens: 900, concurrency: 1, cache: store });
    expect(second.replayed).toBe(1);
    expect(second.cost.calls).toBe(0);
    expect(second.reading.f1['1']).toBe(1);
  });

  it('bills a reply that reported no meters as zero tokens rather than crashing on the absence', async () => {
    const provider: LlmProvider = {
      id: 'fake', model: 'fake-model',
      complete: async () => ({ text: JSON.stringify([GOLD]), model: 'fake-model', finishReason: 'stop' }),
    };
    const report = await runArm({ split: 'dev', rows: [row(0)], types: { 'a.csv': TYPES }, provider, k: 3, maxTokens: 900, concurrency: 1 });
    expect(report.cost.promptTokens).toBe(0);
    expect(report.reading.f1['1']).toBe(1);
  });

  it('counts a truncated answer it replayed as truncated, and bills it as unpriced history', async () => {
    const dir = scratch();
    const { openStore } = await import('../eval/text2vis/content-store.js');
    const store = openStore(dir, PROMPT_VERSION, (parsed, expect) => answerOf(parsed, expect?.model));
    const [system, user] = buildSpecPrompt(row(0), TYPES, 3);
    const key = cacheKey({
      messages: [ { role: 'system', content: system }, { role: 'user', content: user } ],
      model: 'fake-model', thinking: undefined, maxTokens: 900, temperature: 0,
    }, PROMPT_VERSION);
    // An entry written before the store kept meters: the arm must say "nobody wrote it down" rather
    // than "the call was free".
    store.put(key, { version: PROMPT_VERSION, model: 'fake-model', reply: 'not json', truncated: true });
    const report = await runArm({
      split: 'dev', rows: [row(0)], types: { 'a.csv': TYPES }, provider: fake('[]'), k: 3, maxTokens: 900, concurrency: 1, cache: store,
    });
    expect(report.replayed).toBe(1);
    expect(report.truncated).toBe(1);
    expect(report.cost.calls).toBe(0);
    expect(report.cost.promptTokens).toBe(0);
  });

  it('prints a reading at the precision a bill is read at, and says `unpriced` when the model has no row', async () => {
    const base = await runArm({ split: 'dev', rows: [row(0)], types: { 'a.csv': TYPES }, provider: fake(JSON.stringify([GOLD])), k: 3, maxTokens: 900, concurrency: 1 });
    expect(summaryLine(base)).toBe('nvbench2 arm: dev F1@3 1.0000 · 1 asked · 1 calls · unpriced');
    const priced = { ...base, model: 'deepseek-chat', cost: { ...base.cost, yuan: 0.00042 } };
    expect(summaryLine(priced)).toContain('deepseek-chat' === priced.model ? '' : '¥');
    expect(summaryLine({ ...priced, reading: { ...priced.reading, f1: { 1: 1 } } })).toContain('F1@3 —');
  });

  it('records a cached prompt count when the endpoint reports one', async () => {
    const provider: LlmProvider = {
      id: 'fake', model: 'fake-model',
      complete: async () => ({ text: JSON.stringify([GOLD]), model: 'fake-model', usage: { promptTokens: 10, completionTokens: 2, cachedPromptTokens: 8 }, finishReason: 'stop' }),
    };
    const report = await runArm({ split: 'dev', rows: [row(0)], types: { 'a.csv': TYPES }, provider, k: 3, maxTokens: 900, concurrency: 1 });
    expect(report.cost.promptTokens).toBe(10);
    expect(report.reading.f1['1']).toBe(1);
  });

  it('carries the failure decomposition beside the reading, over the same top k', async () => {
    // A reply written the way the Vega-Lite documentation writes one: every channel carries `type`,
    // and the corpus's golds never do. The reading must be 0 and the diagnostic must say why.
    const typed = {
      mark: 'bar',
      encoding: {
        x: { field: 'name', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
    };
    const report = await runArm({
      split: 'dev', rows: [row(0)], types: { 'a.csv': TYPES }, provider: fake(JSON.stringify([typed])), k: 3, maxTokens: 900, concurrency: 1,
    });
    expect(report.reading.f1['1']).toBe(0);
    expect(report.diagnostic.predictions).toBe(1);
    expect(report.diagnostic.matched).toBe(0);
    expect(report.diagnostic.first.properties).toBe(1);
    expect(report.diagnostic.agree.field).toBe(1);
  });

  it('freezes the prompt the first dispatch was paid for, because an edit here orphans 750 answers', () => {
    // Not a snapshot for its own sake: the answer store is content-addressed on this text, so a
    // changed byte silently turns a ¥0 re-read into a ¥0.7 dispatch. A deliberate change is a
    // PROMPT_VERSION bump and this digest moving in the same commit.
    const [system] = buildSpecPrompt({ question: 'q' }, { a: 'quantitative' }, 3, []);
    expect(createHash('sha256').update(system).digest('hex'))
      .toBe('07dad132499784741e4f9cd8038f099c997012b283010bf07294c2ba9e4c3999');
  });

  it('appends each rule before the closing instruction, in the order the rules are declared', () => {
    const [bare] = buildSpecPrompt({ question: 'q' }, { a: 'quantitative' }, 3, []);
    const [counted] = buildSpecPrompt({ question: 'q' }, { a: 'quantitative' }, 3, ['count']);
    const [varied] = buildSpecPrompt({ question: 'q' }, { a: 'quantitative' }, 3, ['variants']);
    const [both] = buildSpecPrompt({ question: 'q' }, { a: 'quantitative' }, 3, ['count', 'variants']);
    const [withValues] = buildSpecPrompt({ question: 'q' }, { a: 'quantitative' }, 3, ['values']);
    expect(counted.length).toBeGreaterThan(bare.length);
    expect(counted).toContain('A count names no column');
    expect(varied).toContain('a set of charts an analyst would accept');
    expect(varied).not.toContain('A count names no column');
    expect(withValues).toContain('Each column is listed with sample values');
    expect(both).not.toContain('Each column is listed with sample values');
    // The closing instruction stays last, or the rules would be read as an afterthought.
    expect(both.trimEnd().endsWith('no prose, no code fence, no explanation.')).toBe(true);
    expect(both.indexOf('A count names no column')).toBeLessThan(both.indexOf('a set of charts an analyst'));
  });

  it('shows a worked set only to the arm that asks for one, and the example is a readable reply', () => {
    const [bare] = buildSpecPrompt({ question: 'q' }, { a: 'quantitative' }, 3, ['count', 'corpus']);
    const [set] = buildSpecPrompt({ question: 'q' }, { a: 'quantitative' }, 3, ['count', 'corpus', 'corpus2']);
    expect(bare).not.toContain('Worked example');
    expect(set).toContain('Return a set of charts rather than one');
    expect(set).toContain('Worked example');
    // The closing instruction stays last with the example in front of it, or the example reads as
    // the thing to answer with rather than as the shape of an answer.
    expect(set.trimEnd().endsWith('no prose, no code fence, no explanation.')).toBe(true);
    expect(set.indexOf('Worked example')).toBeLessThan(set.indexOf('Answer with the array'));
    // The example is a reply this arm has to be able to read. If the parser would drop one of its
    // three charts, the prompt is teaching a format the harness does not accept.
    const charts = parseSpecs(set.slice(set.indexOf('Worked example')), 3);
    expect(charts).toHaveLength(3);
    const axes = charts.map((chart) => {
      // The encoding of a chart `parseSpecs` returned is the object `chartOf` built, so this is a
      // shape the parse guarantees rather than a guess about the reply.
      const encoding = chart['encoding'] as Readonly<Record<string, { readonly field?: string }>>;
      return encoding['x']?.field;
    });
    expect(axes).toEqual(['region', 'product', 'month']);
    expect(charts.every((chart) => chart['mark'] === 'bar')).toBe(true);
  });

  it('lists a column with its sample values only when the values rule is on', () => {
    const row = { question: 'q', examples: { amount: [1, 2, 3], name: ['a', 'b', 'c'] } };
    const types = { amount: 'quantitative', name: 'category' } as const;
    const [, bare] = buildSpecPrompt(row, types, 3, []);
    const [, shown] = buildSpecPrompt(row, types, 3, ['values']);
    expect(bare).toContain('Table columns: amount (quantitative), name (category)');
    expect(shown).toContain('amount (quantitative): 1, 2, 3');
    expect(shown).toContain('name (category): a, b, c');
    // A column the corpus published no example for still gets a line, because a missing line would
    // read as a missing column.
    const partial = { question: 'q', examples: { amount: [1] } };
    expect(buildSpecPrompt(partial, types, 3, ['values'])[1]).toContain('name (category)');
    // And a row that carries no examples at all is still a row.
    expect(buildSpecPrompt({ question: 'q' }, types, 3, ['values'])[1]).toContain('amount (quantitative)');
  });

  it('ships the rules the ablation measured best, so the product path cannot drift from the experiment', () => {
    // The one link between an arm and the product that a test can hold: whatever `metrics.json` says
    // reads highest IS what a caller who names no rules gets. A better arm with no default change
    // fails here, and a default change with no arm behind it fails too.
    const fixture = JSON.parse(readFileSync('eval/nvbench2/metrics.json', 'utf8')) as {
      arms: { readings: Record<string, { rules: string[]; f1: Record<string, number> }> };
    };
    const readings = Object.entries(fixture.arms.readings);
    const best = readings.reduce((left, right) => (right[1].f1['3']! > left[1].f1['3']! ? right : left));
    expect([...best[1].rules].sort()).toEqual([...DEFAULT_RULES].sort());
    expect(DEFAULT_RULES).toContain('count');
  });

  it('reads a rule list, refuses a rule it does not have, and treats the empty string as none', () => {
    expect(rulesOf(undefined)).toEqual(['count', 'corpus', 'corpus2']);
    expect(rulesOf('')).toEqual([]);
    expect(rulesOf('variants')).toEqual(['variants']);
    expect(rulesOf('variants,count')).toEqual(['count', 'variants']);
    expect(rulesOf('corpus2,count')).toEqual(['count', 'corpus2']);
    expect(() => rulesOf('count,bogus')).toThrow(/bogus/);
  });

  it('reads a per-call deadline, because a reasoning tier outlives a chat tier\'s', () => {
    // The run that proved this lost 249 paid answers to one 60-second deadline; the fix is a number
    // the instrument declares, and a number that is not one is refused rather than defaulted.
    expect(timeoutMsOf(undefined)).toBe(60_000);
    expect(timeoutMsOf('')).toBe(60_000);
    expect(timeoutMsOf('180000')).toBe(180_000);
    expect(() => timeoutMsOf('0')).toThrow(/positive whole number/);
    expect(() => timeoutMsOf('-1')).toThrow(/positive whole number/);
    expect(() => timeoutMsOf('90s')).toThrow(/positive whole number/);
    expect(() => timeoutMsOf('1.5')).toThrow(/positive whole number/);
  });

  it('sends the same system message for every row, so a prefix cache is a discount', async () => {
    const provider = fake(JSON.stringify([GOLD]));
    await runArm({ split: 'dev', rows: [row(0), row(1)], types: { 'a.csv': TYPES }, provider, k: 3, maxTokens: 900, concurrency: 2 });
    const [first, second] = provider.seen;
    expect(first?.split('\n')[0]).toBe(second?.split('\n')[0]);
    expect(first).not.toBe(second);
  });

  it('keeps the answers in the order they were asked, whatever order the calls finished in', async () => {
    expect(await mapLimit([1, 2, 3], 2, async (value) => value * 2)).toEqual([2, 4, 6]);
    expect(await mapLimit([], 4, async (value: number) => value)).toEqual([]);
    expect(await mapLimit([1], 9, async (value) => value + 1)).toEqual([2]);
  });
});

describe('the command line', () => {
  it('reads the flags it documents and defaults the rest', () => {
    expect(parseArgs([])).toEqual({
      split: 'dev', cache: 'eval/.cache/nvbench2', artifact: undefined, limit: undefined, k: 3, concurrency: 6, maxTokens: 900, samples: undefined,
      rules: ['count', 'corpus', 'corpus2'],
    });
    expect(parseArgs(['--split', 'test', '--limit', '5', '--k', '5', '--artifact', 'out.json', '--concurrency', '2', '--max-tokens', '1200', '--cache', 'c']))
      .toEqual({ split: 'test', cache: 'c', artifact: 'out.json', limit: 5, k: 5, concurrency: 2, maxTokens: 1200, samples: undefined, rules: ['count', 'corpus', 'corpus2'] });
  });

  it('carries the sample count through the command line, and through the run it starts', () => {
    expect(parseArgs(['--samples', '4']).samples).toBe(4);
    expect(parseArgs(['--samples', '4']).limit).toBeUndefined();
  });

  it('refuses a limit or a k that is not a positive whole number', () => {
    expect(() => parseArgs(['--limit', '0'])).toThrow(/positive whole number/);
    expect(() => parseArgs(['--limit', 'half'])).toThrow(/positive whole number/);
    expect(() => parseArgs(['--k', 'two'])).toThrow(/positive whole number/);
  });

  it('builds a provider only from a host and a key, and names the variable that is missing', () => {
    expect(() => providerFromEnv({})).toThrow(/LLM_BASE_URL/);
    expect(() => providerFromEnv({ LLM_BASE_URL: 'https://example.test/v1' })).toThrow(/LLM_API_KEY/);
    expect(providerFromEnv({ LLM_BASE_URL: 'https://example.test/v1', LLM_API_KEY: 'k' }).model).toBe('deepseek-chat');
    expect(providerFromEnv({ LLM_BASE_URL: 'https://example.test/v1', LLM_API_KEY: 'k', NVBENCH2_MODEL: 'm' }).model).toBe('m');
  });

  it('digests the questions it asked, so an artifact names its corpus', () => {
    expect(splitDigest([row(0)])).toHaveLength(64);
    expect(splitDigest([row(0)])).not.toBe(splitDigest([row(1)]));
  });
});

describe('the command', () => {
  /** A cache directory the command can read: one split, one type map, no answers yet. */
  function corpus(dir: string): void {
    const entry = {
      csv_file: 'a.csv',
      nl_query: 'how much per name',
      gold_answer: JSON.stringify([GOLD]),
      table_schema: JSON.stringify({ table_columns: ['name', 'amount'], column_examples: { name: ['a'], amount: [1] } }),
      steps: [],
    };
    writeFileSync(join(dir, 'dev.json'), JSON.stringify([entry]));
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ types: { 'a.csv': TYPES } }));
  }

  it('writes the reading it took, with the corpus digest and the store’s own counters', async () => {
    const dir = scratch();
    corpus(dir);
    const artifact = join(dir, 'out', 'arm.json');
    const code = await main(['--cache', dir, '--artifact', artifact], {}, { provider: fake(JSON.stringify([GOLD])) });
    expect(code).toBe(0);
    const payload = JSON.parse(readFileSync(artifact, 'utf8')) as Record<string, unknown>;
    expect(payload['reading']).toMatchObject({ questions: 1 });
    expect(payload['digest']).toMatch(/^[0-9a-f]{64}$/);
    expect(payload['cache']).toMatchObject({ hits: 0, misses: 1 });
    expect(payload['promptVersion']).toBe(PROMPT_VERSION);
    // A second run of the same command reads the answer it already paid for.
    expect(await main(['--cache', dir, '--artifact', artifact], {}, { provider: fake(JSON.stringify([GOLD])) })).toBe(0);
    const again = JSON.parse(readFileSync(artifact, 'utf8')) as Record<string, unknown>;
    expect(again['cache']).toMatchObject({ hits: 1, misses: 0 });
    expect(again['replayed']).toBe(1);
  });

  it('refuses to run without an endpoint rather than inventing one', async () => {
    const dir = scratch();
    corpus(dir);
    await expect(main(['--cache', dir], {})).rejects.toThrow(/LLM_BASE_URL/);
  });

  it('asks only the rows a limit names', async () => {
    const dir = scratch();
    const entry = (index: number) => ({
      csv_file: 'a.csv',
      nl_query: `how much per name ${String(index)}`,
      gold_answer: JSON.stringify([GOLD]),
      table_schema: JSON.stringify({ table_columns: ['name', 'amount'], column_examples: { name: ['a'], amount: [1] } }),
      steps: [],
    });
    writeFileSync(join(dir, 'dev.json'), JSON.stringify([entry(0), entry(1)]));
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ types: { 'a.csv': TYPES } }));
    const artifact = join(dir, 'arm.json');
    expect(await main(['--cache', dir, '--limit', '1', '--artifact', artifact], {}, { provider: fake(JSON.stringify([GOLD])) })).toBe(0);
    const payload = JSON.parse(readFileSync(artifact, 'utf8')) as Record<string, unknown>;
    expect(payload['asked']).toBe(1);
    expect(payload['cost']).toMatchObject({ calls: 1 });
    // No `--samples` on this command: the field is absent rather than an empty list, so a reader can
    // tell "nothing was kept" from "nothing was answered".
    expect(payload).not.toHaveProperty('samples');
    expect(await main(['--cache', dir, '--limit', '1', '--samples', '1', '--artifact', artifact], {}, { provider: fake(JSON.stringify([GOLD])) })).toBe(0);
    const kept = JSON.parse(readFileSync(artifact, 'utf8')) as Record<string, unknown>;
    expect(kept['samples']).toHaveLength(1);
  });

  it('prints the reading when no artifact was named', async () => {
    const dir = scratch();
    corpus(dir);
    expect(await main(['--cache', dir], {}, { provider: fake(JSON.stringify([GOLD])) })).toBe(0);
  });
});
