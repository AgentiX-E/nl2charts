import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { LlmProvider, LlmResponse } from '@agentix-e/nl2charts-ai';
import {
  answerOf, buildSpecPrompt, chartOf, DEFAULT_RULES, main, mapLimit, parseArgs, parseSpecs, pendingOf,
  DEFAULT_REPLICA, mirrorsOf, mirrorsOfFlag, productPrompt, providerFromEnv, retriesOf, replicaOf, runArm, rulesOf, splitDigest, withMirrors,
  summaryLine, timeoutMsOf, PROMPT_VERSION, MAX_FAILED_SHARE, REASONING_RULES, RULES, SPEC_MARKS, type StoredAnswer,
} from '../eval/nvbench2/arm.js';
import { cacheKey, openStore } from '../eval/text2vis/content-store.js';
import { compare } from '../eval/nvbench2/compare.js';
import { REPLICAS } from '../eval/nvbench2/corpus-prompt.js';
import { factsOf, ceilingOf, MARK_FROM_VEGA } from '../eval/nvbench2/facts.js';
import { parseSplit, type SplitRow } from '../eval/nvbench2/check.js';
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
  return { index, csv, question: `how much per name (${String(index)})`, golds, columns: ['name', 'amount'], examples: {}, counts: {} };
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

  it('asks for the entries to spend different columns, and only when the arm names that rule', () => {
    // The shipped prompt already says every free column is a chart of its own, and the replies still
    // spend 2.56 distinct columns where the golds use 3.15. `spread` is the same demand phrased as a
    // check on the array rather than as a description of the set, so the two are separate rules: the
    // ablation can tell whether the phrasing or the demand is what was missing.
    const [shipped] = buildSpecPrompt({ question: 'q' }, TYPES, 3);
    expect(shipped).not.toContain('no entry may name only columns');
    const [withSpread] = buildSpecPrompt({ question: 'q' }, TYPES, 3, ['count', 'corpus', 'corpus2', 'spread']);
    expect(withSpread).toContain('no entry may name only columns an earlier entry already named');
    expect(withSpread).not.toBe(shipped);
    // And it is not in the product's prompt, because nothing has measured it yet.
    const [product] = productPrompt({ question: 'q' }, TYPES, 3);
    expect(product).not.toContain('no entry may name only columns');
  });

  it('names the budget it was given, so two k values are two prompts', () => {
    const [five] = buildSpecPrompt({ question: 'q' }, TYPES, 5);
    expect(five).toContain('at most 5 charts');
  });
});

describe('the orientations a mark leaves open', () => {
  // 109 of the shipped reasoning arm's 465 column-first misses are one x/y swap away from a gold, and
  // every one of them is a `rect` or a `point`: the reference normalises the other marks itself, so
  // only these two are left as written and only these two are worth mirroring.
  const heat = { mark: 'rect', encoding: { x: { field: 'name' }, y: { field: 'amount' }, color: { aggregate: 'count' } } };

  it('swaps the two position channels for the marks the reference does not normalise', () => {
    expect(mirrorsOf(heat)).toEqual({ mark: 'rect', encoding: { x: { field: 'amount' }, y: { field: 'name' }, color: { aggregate: 'count' } } });
    expect(mirrorsOf({ mark: 'point', encoding: { x: { field: 'name' }, y: { field: 'amount' } } })).not.toBeUndefined();
  });

  it('refuses a mark it normalises, a chart missing an axis, and a shape it cannot read', () => {
    // Bar, line and boxplot are turned by `reverseAxes` when their x is quantitative, so a mirror of
    // one would be a second chart the judge calls equal — a wasted slot rather than a new reading.
    expect(mirrorsOf(GOLD)).toBeUndefined();
    expect(mirrorsOf({ mark: 'rect', encoding: { x: { field: 'name' } } })).toBeUndefined();
    expect(mirrorsOf({ mark: 'rect', encoding: 'x' })).toBeUndefined();
    expect(mirrorsOf({ mark: 'rect', encoding: { x: 'name', y: { field: 'amount' } } })).toBeUndefined();
  });

  it('interleaves a mirror behind its chart, and appends every mirror after the model’s own order', () => {
    const plain = { mark: 'bar', encoding: { x: { field: 'name' }, y: { field: 'amount' } } };
    const mirror = mirrorsOf(heat);
    expect(withMirrors([heat, plain], 'none')).toEqual([heat, plain]);
    expect(withMirrors([heat, plain], 'interleave')).toEqual([heat, mirror, plain]);
    expect(withMirrors([heat, plain], 'append')).toEqual([heat, plain, mirror]);
  });

  it('reads the flag, and refuses a value that is not one of the three', () => {
    expect(mirrorsOfFlag(undefined)).toBe('none');
    expect(mirrorsOfFlag('')).toBe('none');
    expect(mirrorsOfFlag('none')).toBe('none');
    expect(mirrorsOfFlag('interleave')).toBe('interleave');
    expect(mirrorsOfFlag('append')).toBe('append');
    expect(() => mirrorsOfFlag('both')).toThrow(/--mirrors both is not none, interleave or append/);
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

  it('answers from after the ANSWER marker, because a steps block may carry brackets', () => {
    // The steps preamble is prose the model writes in its own words, and a model that lists
    // candidates writes `[region, product]`. Reading from the first bracket would then parse the
    // steps block and score a reply that had a correct array three lines later as empty.
    const steps = [
      'STEPS:',
      '1. ambiguity: the free axis',
      '2. candidates: [region, product, month]',
      '3. measure: mean price, bar, price >= 2',
      'ANSWER:',
      JSON.stringify([GOLD]),
    ].join('\n');
    expect(parseSpecs(steps, 3)).toEqual([GOLD]);
    // The marker is a place to start reading, not a second answer: two markers mean the last one.
    const twice = `ANSWER:\nnot json\nANSWER:\n${JSON.stringify([GOLD])}`;
    expect(parseSpecs(twice, 3)).toEqual([GOLD]);
    // And a reply whose steps are the only brackets is still empty, not a parse of the steps.
    const noAnswer = 'STEPS:\n1. candidates: [region, product]\nANSWER:\nnone of them fit.';
    expect(parseSpecs(noAnswer, 3)).toEqual([]);
    // A marker with no array behind it is a mention, not a statement: a model that repeats the word
    // after its answer must not turn a good reply into an empty one.
    const mentioned = `ANSWER:\n${JSON.stringify([GOLD])}\nANSWER: the array above.`;
    expect(parseSpecs(mentioned, 3)).toEqual([GOLD]);
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

  it('asks for more charts than it scores, because a set cut to the scoring width loses recall', async () => {
    // Measured: on 250 dev questions the same rules read 27.46 F1@3 when asked for 3 charts and 29.50
    // when asked for 5 — the model forced to pre-filter to the evaluation width drops candidates the
    // gold set contains. So the number of charts asked for is a property of the call and k is a
    // property of the reading, and the two are separate flags.
    const five = [GOLD, { mark: 'line', encoding: { x: { field: 'name' }, y: { field: 'amount' } } },
      { mark: 'point', encoding: { x: { field: 'amount' }, y: { field: 'name' } } },
      { mark: 'bar', encoding: { x: { field: 'amount' }, y: { field: 'amount' } } },
      { mark: 'line', encoding: { x: { field: 'amount' }, y: { field: 'amount' } } }];
    const provider = fake(JSON.stringify(five));
    const report = await runArm({
      split: 'dev', rows: [row(0)], types: { 'a.csv': TYPES }, provider,
      k: 3, ask: 5, maxTokens: 1200, concurrency: 1, rules: ['count', 'corpus', 'corpus2'],
    });
    expect(report.ask).toBe(5);
    expect(report.k).toBe(3);
    // The prompt named the ask, not the scoring width, or the call would come back with three.
    expect(provider.seen[0]).toContain('at most 5 charts');
    // Five charts were kept and reported; the reading and the diagnostic are over the top three,
    // which is what this question's gold set is scored against.
    expect(report.produced).toBe(5);
    expect(report.diagnostic.predictions).toBe(3);
    // One gold, five charts: precision 1/3 and recall 1 at k=3, so F1 is 0.50; at k=5 the same hit
    // over five slots is 0.33. Asking wider is not a free widening — it pays only when the extra
    // charts are golds, which is a claim about the corpus (2 to 5 golds per question) and not about
    // this fixture, and the two numbers are here so the trade is visible rather than assumed.
    expect(report.reading.f1[3]).toBeCloseTo(0.5, 6);
    expect(report.reading.f1[5]).toBeCloseTo(1 / 3, 6);
  });

  it('asks for exactly k when no ask is given, so one flag is still enough', async () => {
    const provider = fake(JSON.stringify([GOLD]));
    const report = await runArm({
      split: 'dev', rows: [row(0)], types: { 'a.csv': TYPES }, provider,
      k: 3, maxTokens: 1200, concurrency: 1, rules: ['count'],
    });
    expect(report.ask).toBe(3);
    expect(provider.seen[0]).toContain('at most 3 charts');
  });

  it('survives a call that never answers, and keeps the row so the denominator is the split', async () => {
    // Three dispatches died this way before the arm did: a reasoning call past its deadline threw out of
    // `mapLimit`, the answers already bought stayed in the cache, and the run reported nothing — so the
    // reading had to be bought again to exist. A row without a reply is a missing row, not the end of
    // the run.
    //
    // It is also not a row to drop. Dropping it selected on the outcome: the questions removed were the
    // ones this arm got stuck on, so the arm that failed more was the arm whose denominator shrank, and
    // two arms over one split reported different denominators — which made every paired test refuse.
    // The measurement that exposed it: a reasoning arm at 749 questions against a chat arm at 751 had a
    // 6.64pp gap nobody could attach an interval to.
    const kinds: string[] = [];
    const provider: LlmProvider = {
      id: 'fake',
      model: 'fake-model',
      complete: async (request) => {
        const question = request.messages[1]?.content ?? '';
        if (question.includes('(1)')) {
          kinds.push('failed');
          throw new Error('timeout');
        }
        kinds.push('answered');
        return { text: JSON.stringify([GOLD]), model: 'fake-model', usage: { promptTokens: 10, completionTokens: 5 }, finishReason: 'stop' };
      },
    };
    const report = await runArm({
      split: 'dev', rows: [row(0), row(1), row(2)], types: { 'a.csv': TYPES }, provider,
      k: 3, maxTokens: 900, concurrency: 1, rules: ['count'],
    });
    expect(kinds).toEqual(['answered', 'failed', 'answered']);
    expect(report.failed).toBe(1);
    expect(report.asked).toBe(3);
    // The failed row is a zero in the reading, not an absence from it: the split has three questions.
    expect(report.reading.questions).toBe(3);
    expect(report.reading.f1[3]).toBeCloseTo(2 / 3, 6);
    expect(report.perQuestion.f1['3']).toHaveLength(3);
    // It still counts as a call, because the endpoint was asked; it is not billed, because a reply that
    // never arrived reported no tokens.
    expect(report.cost.calls).toBe(3);
    expect(summaryLine(report)).toContain('3 questions');
    expect(summaryLine(report)).toContain('1 failed');
  });

  it('pairs a failed arm with a clean one, because both vectors are the split', async () => {
    // The point of the row above. Two arms, one split, one of them losing a call: before the fix these
    // were 2- and 3-long vectors and `compare` refused them, which is a correct refusal of a wrong
    // measurement. Now the vectors are the same length by construction, so the interval exists.
    const flaky: LlmProvider = {
      id: 'fake',
      model: 'fake-model',
      complete: async (request) => {
        if ((request.messages[1]?.content ?? '').includes('(2)')) throw new Error('timeout');
        return { text: JSON.stringify([GOLD]), model: 'fake-model', usage: { promptTokens: 10, completionTokens: 5 }, finishReason: 'stop' };
      },
    };
    const rows = [row(0), row(1), row(2)];
    const broken = await runArm({
      split: 'dev', rows, types: { 'a.csv': TYPES }, provider: flaky,
      k: 3, maxTokens: 900, concurrency: 1, rules: ['count'],
    });
    const clean = await runArm({
      split: 'dev', rows, types: { 'a.csv': TYPES }, provider: fake(JSON.stringify([GOLD])),
      k: 3, maxTokens: 900, concurrency: 1, rules: ['count'],
    });
    expect(broken.failed).toBe(1);
    expect(clean.failed).toBe(0);
    const comparison = compare(
      broken.perQuestion.f1['3'] as number[],
      clean.perQuestion.f1['3'] as number[],
      { k: 3 },
    );
    expect(comparison.questions).toBe(3);
    expect(comparison.delta).toBeCloseTo(1 / 3, 6);
    // Three questions cannot separate a third of a point from zero, and the tool says so rather than
    // reporting the point estimate as a finding. That refusal is the reason the pairing had to exist:
    // the same call over 751 questions is what turns a gap into a claim.
    expect(comparison.separated).toBe(false);
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
    expect(summaryLine(base)).toBe('nvbench2 arm: dev F1@3 1.0000 · 1 questions · ask 3 · 1 calls · unpriced');
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

  it('writes how many distinct values a column holds only when the ranks rule is on', () => {
    const row = { question: 'q', counts: { amount: 240, name: 3 } };
    const types = { amount: 'quantitative', name: 'category' } as const;
    const [, bare] = buildSpecPrompt(row, types, 3, []);
    const [, ranked] = buildSpecPrompt(row, types, 3, ['ranks']);
    expect(bare).not.toContain('distinct');
    expect(ranked).toContain('amount (quantitative) [240 distinct]');
    expect(ranked).toContain('name (category) [3 distinct]');
    // A column the schema says nothing about is listed by type alone rather than as `[undefined
    // distinct]`, because a printed absence is worse than a missing clause: it reads as a fact.
    const partial = { question: 'q', counts: { amount: 240 } };
    const [, some] = buildSpecPrompt(partial, types, 3, ['ranks']);
    expect(some).toContain('amount (quantitative) [240 distinct]');
    expect(some).toContain('name (category)');
    expect(some).not.toContain('undefined');
  });

  it('counts only integers as a distinct count, because that is what the schema files hold', () => {
    const types = { name: 'category' } as const;
    const prompt = (count: unknown): string => buildSpecPrompt({ question: 'q', counts: { name: count } }, types, 3, ['ranks'])[1];
    // The corpus writes integers. Everything else is a schema this rule has nothing to say about, and
    // a quoted number is the one that would slip through a `Number()` conversion unnoticed.
    expect(prompt(3)).toContain('[3 distinct]');
    expect(prompt('3')).not.toContain('distinct');
    expect(prompt(1.5)).not.toContain('distinct');
    expect(prompt(-1)).not.toContain('distinct');
    expect(prompt(null)).not.toContain('distinct');
    expect(prompt({ count: 3 })).not.toContain('distinct');
    // Zero is a number the schema can state, and this guard is about the form of the value rather
    // than about its plausibility: dropping it would be the reader deciding what the schema means.
    expect(prompt(0)).toContain('[0 distinct]');
  });

  it('puts the count before the sample values, and keeps both when both rules are on', () => {
    const row = { question: 'q', counts: { name: 2 }, examples: { name: ['a', 'b'] } };
    const types = { name: 'category' } as const;
    const [, both] = buildSpecPrompt(row, types, 3, ['ranks', 'values']);
    expect(both).toContain('name (category) [2 distinct]: a, b');
  });

  it('ships the count on the chat tier and leaves it off the reasoning one, which the layers record', () => {
    expect(RULES).toContain('ranks');
    // The two tiers disagree on this rule, so the product has two prompts rather than one. Both
    // readings are in `metrics.json` under `arms.layers`; the drift test below re-derives the lists.
    const shipped = productPrompt({ question: 'q', counts: { name: 3 } }, { name: 'category' }, 3)[1];
    const reasoner = productPrompt({ question: 'q', counts: { name: 3 } }, { name: 'category' }, 3, 'reasoning')[1];
    expect(shipped).toContain('[3 distinct]');
    expect(reasoner).not.toContain('distinct');
    expect(reasoner).not.toContain('STEPS:');
  });

  it('takes each tier’s rules from the layer that measured them', () => {
    type Drop = { separated: boolean; delta: number; questions: number };
    const fixture = JSON.parse(readFileSync('eval/nvbench2/metrics.json', 'utf8')) as {
      arms: { layers: Record<'chat' | 'reasoning', { rules: string[]; drops: Record<string, Drop> }> };
    };
    // The two lists are the layers, rule for rule.
    expect([...DEFAULT_RULES].sort()).toEqual([...fixture.arms.layers.chat.rules].sort());
    expect([...REASONING_RULES].sort()).toEqual([...fixture.arms.layers.reasoning.rules].sort());
    // A tier may drop a rule, never invent one, and every dropped rule has to be dropped on evidence:
    // a rule that separates from zero on a tier and is missing from that tier's list is a product
    // sending something other than what was measured.
    for (const [tier, layer] of [['chat', fixture.arms.layers.chat], ['reasoning', fixture.arms.layers.reasoning]] as const) {
      const sent = tier === 'chat' ? DEFAULT_RULES : REASONING_RULES;
      for (const drop of Object.values(layer.drops)) {
        expect(drop.separated).toBe(false);
        // A comparison that does not state its denominator is not a comparison.
        expect(drop.questions).toBe(750);
      }
      for (const rule of sent) expect(layer.drops[rule]).toBeUndefined();
    }
    expect(REASONING_RULES.every((rule) => DEFAULT_RULES.includes(rule))).toBe(true);
  });

  it('asks for the ambiguity before the charts only when the steps rule is on', () => {
    const [bare] = buildSpecPrompt({ question: 'q' }, { a: 'quantitative' }, 3, ['count', 'corpus', 'corpus2']);
    const [stepped] = buildSpecPrompt({ question: 'q' }, { a: 'quantitative' }, 3, ['count', 'corpus', 'corpus2', 'steps']);
    expect(bare).not.toContain('STEPS:');
    expect(stepped).toContain('STEPS:');
    // The contract is two parts, and the closing sentence has to say so: a prompt whose rules ask
    // for a preamble and whose last line asks for "the array and nothing else" is two prompts.
    expect(stepped.trimEnd().endsWith('Write both parts and nothing else: no prose outside them, no code fence, no explanation.')).toBe(true);
    expect(stepped).not.toContain('Answer with the array and nothing else');
    // The array is still the answer, so the format the parser reads has not moved.
    expect(stepped).toContain('Return a JSON array of at most 3 charts');
    // The steps are the model's own words, so they may not be the parse's input: the rule says so.
    expect(stepped).toContain('with no brackets');
    // Step two is the enumeration the corpus's gold sets are, which is the whole point of the arm.
    expect(stepped).toContain('every column of the table that could carry it');
    // The example answers in two parts, so the format the prompt teaches is the format the parser
    // reads: an example that taught a shape the harness drops would be a prompt bug, not a model one.
    const taught = parseSpecs(stepped.slice(stepped.indexOf('Worked example')), 3);
    expect(taught).toHaveLength(3);
    expect(taught.map((chart) => (chart['encoding'] as Record<string, { field?: string }>)['x']?.field))
      .toEqual(['region', 'product', 'month']);
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

  it('ships the replica the ablation selected, and nothing else', () => {
    // The same link as the rules above, for the other half of the instrument: if a replica of the
    // corpus's prompt beats our own on a full split, the product has to be able to send it, and the
    // place it is recorded must be the place the product reads.
    const fixture = JSON.parse(readFileSync('eval/nvbench2/metrics.json', 'utf8')) as {
      arms: { selected: { replica?: string } };
    };
    expect(fixture.arms.selected.replica ?? null).toBe(DEFAULT_REPLICA ?? null);
    expect(productPrompt(row(0), TYPES, 3)).toEqual(buildSpecPrompt(row(0), TYPES, 3, DEFAULT_RULES));
  });

  it('ships a corpus prompt only if a corpus prompt beat the shipped one, and says so in metrics', () => {
    // The same link as above, made checkable in the direction the experiment can go: a replica that
    // reads *higher* than the shipped arm, with an interval that excludes zero, must be the one the
    // product sends. Without this, the ablation can find that the corpus's prompt wins and the product
    // keeps our own prompt forever, because nothing but prose connects the two.
    const fixture = JSON.parse(readFileSync('eval/nvbench2/metrics.json', 'utf8')) as {
      replicas: {
        readings: Record<string, { vsShipped: { delta: number; low: number; high: number; separated: boolean; questions: number } }>;
      };
    };
    const measured = Object.keys(fixture.replicas.readings);
    // Every prompt the instrument can send is measured, so a fifth replica cannot be added to the
    // module and left out of the table the product's default is read from.
    expect([...measured].sort()).toEqual([...REPLICAS].sort());
    const winners = measured.filter((name) => {
      const { delta, separated } = fixture.replicas.readings[name]!.vsShipped;
      return separated && delta > 0;
    });
    expect(winners).toEqual(DEFAULT_REPLICA === undefined ? [] : [DEFAULT_REPLICA]);
    // A comparison that does not say how many questions it paired is not a comparison.
    for (const name of measured) {
      expect(fixture.replicas.readings[name]!.vsShipped.questions).toBe(750);
    }
  });

  it('reads a rule list, refuses a rule it does not have, and treats the empty string as none', () => {
    expect(rulesOf(undefined)).toEqual(['count', 'ranks', 'corpus', 'corpus2', 'steps']);
    expect(rulesOf('')).toEqual([]);
    expect(rulesOf('variants')).toEqual(['variants']);
    expect(rulesOf('variants,count')).toEqual(['count', 'variants']);
    expect(rulesOf('corpus2,count')).toEqual(['count', 'corpus2']);
    expect(rulesOf('steps')).toEqual(['steps']);
    expect(rulesOf('spread')).toEqual(['spread']);
    // The order is the module's, not the caller's, because the sentence order is the prompt's.
    expect(rulesOf('spread,count')).toEqual(['count', 'spread']);
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

  it('retries a transport fault before it gives up on a paid run', () => {
    // A reset connection produced no answer and no bill, so the second attempt is free; a run that
    // dies on the first one throws away every answer bought before it.
    expect(retriesOf(undefined)).toBe(3);
    expect(retriesOf('')).toBe(3);
    expect(retriesOf('5')).toBe(5);
    expect(() => retriesOf('0')).toThrow(/positive whole number/);
    expect(() => retriesOf('2.5')).toThrow(/positive whole number/);
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
      split: 'dev', cache: 'eval/.cache/nvbench2', metrics: 'eval/nvbench2/metrics.json', artifact: undefined, limit: undefined, k: 3, ask: 3,
      concurrency: 6, maxTokens: 900, samples: undefined, rules: ['count', 'ranks', 'corpus', 'corpus2', 'steps'], replica: undefined,
      budget: 12, replay: false, mirrors: 'none',
    });
    expect(parseArgs(['--split', 'test', '--limit', '5', '--k', '5', '--artifact', 'out.json', '--concurrency', '2', '--max-tokens', '1200', '--cache', 'c']))
      .toEqual({ split: 'test', cache: 'c', metrics: 'eval/nvbench2/metrics.json', artifact: 'out.json', limit: 5, k: 5, ask: 5, concurrency: 2, maxTokens: 1200, samples: undefined, rules: ['count', 'ranks', 'corpus', 'corpus2', 'steps'], replica: undefined, budget: 12, replay: false, mirrors: 'none' });
  });

  it('reads a ceiling in yuan, and refuses an amount that is not money', () => {
    expect(parseArgs([]).budget).toBe(12);
    expect(parseArgs(['--budget', '25']).budget).toBe(25);
    expect(parseArgs(['--budget', '0']).budget).toBe(0);
    // `none` is a word, not a zero: running a model nobody has priced has to be typed deliberately.
    expect(parseArgs(['--budget', 'none']).budget).toBe('none');
    expect(() => parseArgs(['--budget', 'cheap'])).toThrow(/not an amount of money or none/);
    expect(() => parseArgs(['--budget', '-1'])).toThrow(/not an amount of money or none/);
  });

  it('reads --replica, and reads none for the empty string a cleared workflow box sends', () => {
    expect(parseArgs(['--replica', 'basic']).replica).toBe('basic');
    expect(parseArgs(['--replica', 'stepsFull']).replica).toBe('stepsFull');
    expect(parseArgs(['--replica', 'none']).replica).toBeUndefined();
    expect(parseArgs(['--replica', '']).replica).toBeUndefined();
    expect(parseArgs([]).replica).toBeUndefined();
    expect(() => parseArgs(['--replica', 'chat'])).toThrow(/is not one of basic, basicFull, steps, stepsFull or none/);
    expect(replicaOf('steps')).toBe('steps');
    expect(replicaOf(undefined)).toBeUndefined();
  });

  it('carries the sample count through the command line, and through the run it starts', () => {
    expect(parseArgs(['--samples', '4']).samples).toBe(4);
    expect(parseArgs(['--samples', '4']).limit).toBeUndefined();
  });

  it('reads --ask separately from --k, and refuses an ask that is not a positive whole number', () => {
    const both = parseArgs(['--k', '3', '--ask', '5', '--rules', 'steps']);
    expect(both.k).toBe(3);
    expect(both.ask).toBe(5);
    // Absent means the scoring width, because a caller who names one number means it for both.
    expect(parseArgs(['--k', '4']).ask).toBe(4);
    expect(() => parseArgs(['--ask', '0'])).toThrow(/positive whole number/);
    expect(() => parseArgs(['--ask', 'many'])).toThrow(/positive whole number/);
  });

  it('refuses a limit or a k that is not a positive whole number', () => {
    expect(() => parseArgs(['--limit', '0'])).toThrow(/positive whole number/);
    expect(() => parseArgs(['--limit', 'half'])).toThrow(/positive whole number/);
    expect(() => parseArgs(['--k', 'two'])).toThrow(/positive whole number/);
    // `--replay` is a flag, not a value: a dispatch that says it replays must not spend.
    expect(parseArgs([]).replay).toBe(false);
    expect(parseArgs(['--replay']).replay).toBe(true);
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

  /** A split of N questions over one table, so a share of failures has a denominator. */
  function many(dir: string, count: number): void {
    const rows = Array.from({ length: count }, () => ({
      csv_file: 'a.csv',
      nl_query: 'how much per name',
      gold_answer: JSON.stringify([GOLD]),
      table_schema: JSON.stringify({ table_columns: ['name', 'amount'], column_examples: { name: ['a'], amount: [1] } }),
      steps: [],
    }));
    writeFileSync(join(dir, 'dev.json'), JSON.stringify(rows));
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ types: { 'a.csv': TYPES } }));
  }

  it('refuses to replay a dispatch whose answers it does not have, and calls nothing', async () => {
    // The failure this prevents is silent and expensive: a hand-typed `--max-tokens` that differs from
    // the run that paid misses every key, the quote is recomputed from the published price, the ceiling
    // allows it, and 750 answers are bought again under a command line that said "replay".
    const dir = scratch();
    corpus(dir);
    const provider = fake(JSON.stringify([GOLD]));
    await expect(main(['--cache', dir, '--budget', 'none', '--replay'], {}, { provider }))
      .rejects.toThrow(/--replay was asked for, but 1 of 1 questions are not in the answer store/);
    expect(provider.seen).toHaveLength(0);
  });

  it('replays for free once the answers exist, and still calls nothing', async () => {
    const dir = scratch();
    corpus(dir);
    const first = fake(JSON.stringify([GOLD]));
    await main(['--cache', dir, '--budget', 'none'], {}, { provider: first });
    expect(first.seen).toHaveLength(1);
    const second = fake(JSON.stringify([GOLD]));
    await main(['--cache', dir, '--budget', 'none', '--replay'], {}, { provider: second });
    expect(second.seen).toHaveLength(0);
  });

  it('refuses a reading that lost more than a percent of its questions, and names the share', async () => {
    // 119 of 751 questions died to a 60-second deadline on the reasoning tier and the job went green
    // with 31.28 next to it — a floor whose distance to the truth is unknown, published as a
    // measurement. A failure scores zero, so it never shortens the denominator; it pads it.
    const dir = scratch();
    many(dir, 40);
    const provider = fake(JSON.stringify([GOLD]));
    const real = provider.complete;
    let calls = 0;
    const flaky: LlmProvider = {
      ...provider,
      complete: async (request) => {
        calls += 1;
        // 2 of 40 is 5%, five times the threshold.
        if (calls <= 2) throw new Error('timeout after 60000ms');
        return real(request);
      },
    };
    const artifact = join(dir, 'flaky.json');
    const code = await main(['--cache', dir, '--budget', 'none', '--artifact', artifact], {}, { provider: flaky });
    expect(code).toBe(3);
    const written = JSON.parse(readFileSync(artifact, 'utf8')) as { failed: number; asked: number };
    expect(written.failed).toBe(2);
    expect(written.asked).toBe(40);
  });

  it('reads a split that lost under a percent, with the loss counted as a zero', async () => {
    // The threshold is a share, not a policy against any failure: one dead question in a hundred is
    // inside the instrument, and refusing it would make a whole split unreadable for a transient.
    const dir = scratch();
    many(dir, 100);
    const provider = fake(JSON.stringify([GOLD]));
    const real = provider.complete;
    let calls = 0;
    const once: LlmProvider = {
      ...provider,
      complete: async (request) => {
        calls += 1;
        if (calls === 3) throw new Error('reset by peer');
        return real(request);
      },
    };
    const artifact = join(dir, 'once.json');
    const code = await main(['--cache', dir, '--budget', 'none', '--artifact', artifact], {}, { provider: once });
    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(artifact, 'utf8')) as { failed: number; asked: number; reading: { questions: number } };
    expect(written.failed).toBe(1);
    expect(written.reading.questions).toBe(100);
  });

  it('keeps the threshold inside what the instrument can resolve', () => {
    // A share worth more than the 1.25pp the A/A pair resolves would make the guard weaker than the
    // noise it exists to stay under: at 1% of a split, the worst case is 1pp of mean.
    expect(MAX_FAILED_SHARE).toBeGreaterThan(0);
    expect(MAX_FAILED_SHARE).toBeLessThan(0.0125);
  });

  it('refuses to publish a reading when the endpoint answered nothing, and leaves the artifact behind', async () => {
    // 0.00 over a split is what a system that is wrong everywhere prints, and an outage prints the same
    // number. Without this, a dead endpoint publishes a verdict on a model and the job goes green — the
    // exact shape of the R-VES defect, one directory over.
    const dir = scratch();
    corpus(dir);
    const dead: LlmProvider = {
      id: 'fake',
      model: 'fake-model',
      complete: async () => { throw new Error('502 from the endpoint'); },
    };
    const artifact = join(dir, 'dead.json');
    const code = await main(['--cache', dir, '--budget', 'none', '--artifact', artifact], {}, { provider: dead });
    expect(code).toBe(2);
    const written = JSON.parse(readFileSync(artifact, 'utf8')) as { failed: number; asked: number; reading: { f1: Record<string, number> } };
    // The artifact exists and says what happened, so a reader who opens the file the failed run cited
    // finds the run rather than a missing file.
    expect(written.failed).toBe(1);
    expect(written.asked).toBe(1);
    expect(written.reading.f1['3']).toBe(0);
  });

  it('turns a transposed heat map into a hit, because the corpus enumerates both orientations', async () => {
    // The reading this protects: 109 of the shipped arm's 465 column-first misses are exactly this —
    // the right two columns on each other's axes, for a mark the reference never normalises. Offering
    // the mirror answers the question the way the gold set answers it; nothing about the judge moves.
    const dir = scratch();
    const gold = { mark: 'rect', encoding: { x: { field: 'name' }, y: { field: 'amount' }, color: { aggregate: 'count' } } };
    const transposed = { mark: 'rect', encoding: { x: { field: 'amount' }, y: { field: 'name' }, color: { aggregate: 'count' } } };
    const entry = {
      csv_file: 'a.csv',
      nl_query: 'how many per name and amount',
      gold_answer: JSON.stringify([gold]),
      table_schema: JSON.stringify({ table_columns: ['name', 'amount'], column_examples: { name: ['a'], amount: [1] } }),
      steps: [],
    };
    writeFileSync(join(dir, 'dev.json'), JSON.stringify([entry]));
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ types: { 'a.csv': TYPES } }));

    const plain = join(dir, 'plain.json');
    await main(['--cache', dir, '--budget', 'none', '--artifact', plain], {}, { provider: fake(JSON.stringify([transposed])) });
    expect((JSON.parse(readFileSync(plain, 'utf8')) as { reading: { f1: Record<string, number> } }).reading.f1['3']).toBe(0);

    const mirrored = join(dir, 'mirrored.json');
    await main(['--cache', dir, '--budget', 'none', '--artifact', mirrored, '--mirrors', 'interleave', '--replay'], {}, { provider: fake(JSON.stringify([transposed])) });
    const payload = JSON.parse(readFileSync(mirrored, 'utf8')) as { reading: { f1: Record<string, number> }; mirrors?: string; produced: number };
    // One gold, two offered charts: recall 1, precision 1/2.
    expect(payload.reading.f1['3']).toBeCloseTo(2 / 3, 6);
    expect(payload.mirrors).toBe('interleave');
    expect(payload.produced).toBe(2);
  });

  it('writes the reading it took, with the corpus digest and the store’s own counters', async () => {
    const dir = scratch();
    corpus(dir);
    const artifact = join(dir, 'out', 'arm.json');
    // `--budget none`: `fake-model` has no row in `eval/price.ts`, and a dispatch under a name nobody
    // has priced is refused unless the caller says so — which is the gate this file tests elsewhere.
    const code = await main(['--cache', dir, '--artifact', artifact, '--budget', 'none'], {}, { provider: fake(JSON.stringify([GOLD])) });
    expect(code).toBe(0);
    const payload = JSON.parse(readFileSync(artifact, 'utf8')) as Record<string, unknown>;
    expect(payload['reading']).toMatchObject({ questions: 1 });
    expect(payload['digest']).toMatch(/^[0-9a-f]{64}$/);
    expect(payload['cache']).toMatchObject({ hits: 0, misses: 1 });
    expect(payload['promptVersion']).toBe(PROMPT_VERSION);
    // A second run of the same command reads the answer it already paid for.
    expect(await main(['--cache', dir, '--artifact', artifact, '--budget', 'none'], {}, { provider: fake(JSON.stringify([GOLD])) })).toBe(0);
    const again = JSON.parse(readFileSync(artifact, 'utf8')) as Record<string, unknown>;
    expect(again['cache']).toMatchObject({ hits: 1, misses: 0 });
    expect(again['replayed']).toBe(1);
  });

  it('records the replica an artifact was taken under, so the reading names its instrument', async () => {
    const dir = scratch();
    corpus(dir);
    const artifact = join(dir, 'out', 'replica.json');
    const code = await main(['--cache', dir, '--artifact', artifact, '--replica', 'basic', '--budget', 'none'], {}, { provider: fake(JSON.stringify([GOLD])) });
    expect(code).toBe(0);
    const payload = JSON.parse(readFileSync(artifact, 'utf8')) as Record<string, unknown>;
    expect(payload['replica']).toBe('basic');
    // The rules field still says what the product path would have sent, because an artifact is also a
    // record of the run's configuration; the replica field is what says those rules were not sent.
    expect(payload['rules']).toEqual(['count', 'ranks', 'corpus', 'corpus2', 'steps']);
  });

  it('counts the questions already paid for, so a re-dispatch knows it is free', async () => {
    const dir = scratch();
    corpus(dir);
    const store = openStore<StoredAnswer>(join(dir, 'answers'), PROMPT_VERSION, (parsed, expect) => answerOf(parsed, expect?.model));
    const rows = parseSplit(readFileSync(join(dir, 'dev.json'), 'utf8'));
    const types = { 'a.csv': TYPES };
    const first = pendingOf({ rows, types, k: 3, rules: DEFAULT_RULES, model: 'deepseek-chat', maxTokens: 900, store });
    expect(first).toEqual({ questions: 1, paid: 0 });
    // The store this counts against is the one a run writes to, and a stored answer is a paid answer.
    await main(['--cache', dir, '--budget', 'none'], {}, { provider: fake(JSON.stringify([GOLD])) });
    const second = pendingOf({ rows, types, k: 3, rules: DEFAULT_RULES, model: 'fake-model', maxTokens: 900, store });
    expect(second).toEqual({ questions: 1, paid: 1 });
    // A wider answer budget is a different request and therefore a different question, which is why the
    // count is taken from the request rather than from the row.
    const wider = pendingOf({ rows, types, k: 3, rules: DEFAULT_RULES, model: 'fake-model', maxTokens: 1200, store });
    expect(wider.paid).toBe(0);
  });

  it('prices a table it has no types for, and refuses a model it has no price for', async () => {
    const dir = scratch();
    corpus(dir);
    const store = openStore<StoredAnswer>(join(dir, 'answers'), PROMPT_VERSION, (parsed, expect) => answerOf(parsed, expect?.model));
    const rows = parseSplit(readFileSync(join(dir, 'dev.json'), 'utf8'));
    // No type map for this table: the run counts the row as unparsed, and the quote still counts it —
    // quoting only the rows expected to succeed would make a split of unknown tables look free.
    expect(pendingOf({ rows, types: {}, k: 3, rules: DEFAULT_RULES, model: 'm', maxTokens: 900, store }))
      .toEqual({ questions: 1, paid: 0 });
    // An unpriced model is refused rather than run at an unknown price, and the sentence says which.
    await expect(main(['--cache', dir, '--metrics', join(dir, 'metrics.json')], {}, { provider: fake(JSON.stringify([GOLD])) }))
      .rejects.toThrow(/ENOENT|no price on file/);
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify({ arms: { model: 'someone-else', asked: 1, readings: { a: { yuan: 1 } } } }));
    await expect(main(['--cache', dir, '--metrics', join(dir, 'metrics.json')], {}, { provider: fake(JSON.stringify([GOLD])) }))
      .rejects.toThrow(/no price on file for fake-model/);
  });

  it('refuses a dispatch whose quote is over its ceiling, before it spends anything', async () => {
    const dir = scratch();
    corpus(dir);
    const metrics = join(dir, 'metrics.json');
    // ¥1 a question, measured: the arithmetic the gate is allowed to trust is the arithmetic of a run.
    writeFileSync(metrics, JSON.stringify({ arms: { model: 'deepseek-chat', asked: 750, readings: { none: { yuan: 750 } } } }));
    const priced = { ...fake(JSON.stringify([GOLD])), model: 'deepseek-chat' };
    await expect(main(['--cache', dir, '--metrics', metrics, '--budget', '0.5'], {}, { provider: priced }))
      .rejects.toThrow(/over the ¥0\.50 ceiling/);
    // Nothing was bought: the refusal happens before the first call.
    expect(priced.seen).toHaveLength(0);
    expect(await main(['--cache', dir, '--metrics', metrics, '--budget', '2'], {}, { provider: priced })).toBe(0);
    expect(priced.seen).toHaveLength(1);
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
    expect(await main(['--cache', dir, '--limit', '1', '--artifact', artifact, '--budget', 'none'], {}, { provider: fake(JSON.stringify([GOLD])) })).toBe(0);
    const payload = JSON.parse(readFileSync(artifact, 'utf8')) as Record<string, unknown>;
    expect(payload['asked']).toBe(1);
    expect(payload['cost']).toMatchObject({ calls: 1 });
    // No `--samples` on this command: the field is absent rather than an empty list, so a reader can
    // tell "nothing was kept" from "nothing was answered".
    expect(payload).not.toHaveProperty('samples');
    expect(await main(['--cache', dir, '--limit', '1', '--samples', '1', '--artifact', artifact, '--budget', 'none'], {}, { provider: fake(JSON.stringify([GOLD])) })).toBe(0);
    const kept = JSON.parse(readFileSync(artifact, 'utf8')) as Record<string, unknown>;
    expect(kept['samples']).toHaveLength(1);
  });

  it('prints the reading when no artifact was named', async () => {
    const dir = scratch();
    corpus(dir);
    expect(await main(['--cache', dir, '--budget', 'none'], {}, { provider: fake(JSON.stringify([GOLD])) })).toBe(0);
  });
});

describe('a replica of the corpus prompt', () => {
  const STEP_REPLY = JSON.stringify({
    thinking_steps: { step_1: { answer: { column_list: [{ field: 'name' }], filter_list: [] } } },
    final_output: [GOLD],
  });

  it('sends the corpus instruction and input, and not this repository’s', () => {
    const [system, user] = buildSpecPrompt(row(0), TYPES, 3, ['count', 'corpus2'], 'basic');
    expect(system).toContain('You only answer with #OUTPUT.');
    expect(user).toContain('recommend 1 to 5 different charts');
    expect(user).toContain('#INPUT:');
    expect(user).toContain("Data Schema: ['name', 'amount']");
    expect(user).not.toContain('Table columns:');
    // The rules are ignored rather than applied to the corpus's sentence: a replica is a different
    // instrument, not a wider one, and a clause from this repository's prompt inside it would be a
    // prompt neither system published.
    expect(user).not.toContain('A count names no column');
    expect(user).not.toContain('at most 3 charts');
  });

  it('renders a row that carries no schema beyond its question, rather than throwing', () => {
    const [system, user] = buildSpecPrompt({ question: 'how much per name' }, TYPES, 3, DEFAULT_RULES, 'steps');
    expect(system).toBeTruthy();
    expect(user).toContain('Data Schema: []');
    // The worked example inside the step instruction carries its own `#INPUT:` block, so the assertion
    // is about the last one — the block built for this question — rather than about the whole prompt.
    const input = user.slice(user.lastIndexOf('#INPUT:'));
    expect(input).toContain('NL Query: how much per name');
    expect(input).not.toContain('Unique Value Num');
  });

  it('reads a step reply by the object its contract names, and scores the charts inside it', async () => {
    const report = await runArm({
      split: 'dev', rows: [row(0)], types: { 'a.csv': TYPES }, provider: fake(STEP_REPLY),
      k: 3, maxTokens: 1600, concurrency: 1, replica: 'steps',
    });
    expect(report.replica).toBe('steps');
    expect(report.unparsed).toBe(0);
    expect(report.produced).toBe(1);
    expect(report.reading.f1['3']).toBe(1);
  });

  it('counts a step reply with no final_output as unparsed, not as zero charts on purpose', async () => {
    const report = await runArm({
      split: 'dev', rows: [row(0)], types: { 'a.csv': TYPES },
      provider: fake(JSON.stringify({ step_1: { answer: { column_list: [] } } })),
      k: 3, maxTokens: 1600, concurrency: 1, replica: 'steps',
    });
    expect(report.unparsed).toBe(1);
    expect(report.reading.f1['3']).toBe(0);
  });

  it('reads a basic reply as an array, and records which replica produced the reading', async () => {
    const provider = fake(JSON.stringify([GOLD]));
    const report = await runArm({
      split: 'dev', rows: [row(0)], types: { 'a.csv': TYPES }, provider,
      k: 3, maxTokens: 900, concurrency: 1, replica: 'basic',
    });
    expect(report.replica).toBe('basic');
    expect(report.reading.f1['3']).toBe(1);
    expect(provider.seen[0]).toContain('#OUTPUT:');
  });

  it('leaves the field absent when no replica was asked for, so an artifact says which instrument ran', async () => {
    const report = await runArm({
      split: 'dev', rows: [row(0)], types: { 'a.csv': TYPES }, provider: fake(JSON.stringify([GOLD])),
      k: 3, maxTokens: 900, concurrency: 1,
    });
    expect(report).not.toHaveProperty('replica');
    expect(summaryLine(report)).not.toContain('replica');
  });

  it('names the replica in the one line a job log keeps', async () => {
    const report = await runArm({
      split: 'dev', rows: [row(0)], types: { 'a.csv': TYPES }, provider: fake(STEP_REPLY),
      k: 3, maxTokens: 1600, concurrency: 1, replica: 'stepsFull',
    });
    expect(summaryLine(report)).toContain('· replica stepsFull');
  });

  it('replays a replica answer from the store rather than buying it twice', async () => {
    const dir = scratch();
    const store = openStore<StoredAnswer>(dir, PROMPT_VERSION, (parsed, expect) => answerOf(parsed, expect?.model));
    const first = await runArm({
      split: 'dev', rows: [row(0)], types: { 'a.csv': TYPES }, provider: fake(STEP_REPLY),
      k: 3, maxTokens: 1600, concurrency: 1, replica: 'steps', cache: store,
    });
    expect(first.replayed).toBe(0);
    const second = await runArm({
      split: 'dev', rows: [row(0)], types: { 'a.csv': TYPES }, provider: fake(STEP_REPLY),
      k: 3, maxTokens: 1600, concurrency: 1, replica: 'steps', cache: store,
    });
    expect(second.replayed).toBe(1);
    expect(second.reading.f1['3']).toBe(first.reading.f1['3']);
  });

  it('reads nothing out of a final_output contract when the mode is the array one', () => {
    expect(parseSpecs(STEP_REPLY, 3)).toEqual([]);
    expect(parseSpecs(STEP_REPLY, 3, 'finalOutput')).toEqual([GOLD]);
    expect(parseSpecs('{"final_output": []}', 3, 'finalOutput')).toEqual([]);
    expect(parseSpecs('not json', 3, 'finalOutput')).toEqual([]);
    expect(parseSpecs(STEP_REPLY, 0, 'finalOutput')).toEqual([]);
  });
});
