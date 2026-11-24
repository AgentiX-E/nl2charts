import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET_CNY, quoteLine, quoteOf, refusalOf, unitPriceOf, unitPricesOf,
} from '../eval/nvbench2/budget.js';

/** The published readings, so a test of the price table is a test of the file the product reads. */
const METRICS = JSON.parse(readFileSync('eval/nvbench2/metrics.json', 'utf8')) as unknown;

describe('the price of a question', () => {
  it('takes the dearest measured arm per model, because an underestimate authorises spending', () => {
    const prices = unitPricesOf(METRICS);
    const reasoner = prices.get('deepseek-reasoner');
    // The full six-step prompt: 13.8 KB of instruction and a reasoning tier's completion, ¥0.06705 a
    // question. It is the arm that cost ¥50.29 for one split, and the reason a plan that priced every
    // arm at the chat tier was wrong by 19 times.
    expect(reasoner?.cnyPerQuestion).toBeCloseTo(0.06705, 4);
    expect(reasoner?.source).toMatch(/^replicas\.readings\./);
    // And it is the maximum, not the first: the same model's shipped-rules arm is ¥0.0263 a question.
    const cheaper = Object.values(
      (JSON.parse(readFileSync('eval/nvbench2/metrics.json', 'utf8')) as {
        arms: { readings: Record<string, { yuan: number }> };
      }).arms.readings,
    ).map((reading) => reading.yuan / 750);
    expect(Math.min(...cheaper)).toBeLessThan(reasoner?.cnyPerQuestion ?? 0);
  });

  it('prices the chat tier far below the reasoning one, which is the error that produced the invoice', () => {
    const chat = unitPriceOf(METRICS, 'deepseek-chat');
    const reasoner = unitPriceOf(METRICS, 'deepseek-reasoner');
    expect(chat?.cnyPerQuestion).toBeCloseTo(0.0034533, 6);
    expect((reasoner?.cnyPerQuestion ?? 0) / (chat?.cnyPerQuestion ?? 1)).toBeGreaterThan(15);
  });

  it('says nothing for a model it has never measured, rather than guessing zero', () => {
    expect(unitPriceOf(METRICS, 'a-model-nobody-ran')).toBeUndefined();
    expect(unitPricesOf(null).size).toBe(0);
    expect(unitPricesOf({}).size).toBe(0);
    expect(unitPricesOf({ arms: { readings: { x: { yuan: 'free' } } } }).size).toBe(0);
  });

  it('reads the tier cells at the tier’s own denominator, not the split’s', () => {
    const cell = (JSON.parse(readFileSync('eval/nvbench2/metrics.json', 'utf8')) as {
      arms: { tiers: { rows: number; cells: Record<string, { yuan: number }> } };
    }).arms.tiers;
    const first = Object.entries(cell.cells)[0]!;
    const prices = unitPricesOf(METRICS);
    // The cells are 250-row runs; dividing by the split's 750 would report a third of the real price.
    expect(prices.get(first[0].split('|')[0] as string)?.cnyPerQuestion)
      .toBeGreaterThanOrEqual(first[1].yuan / cell.rows);
  });
});

describe('the quote', () => {
  const unit = unitPriceOf(METRICS, 'deepseek-reasoner');

  it('prices only the questions that are not already paid for', () => {
    const all = quoteOf({ model: 'deepseek-reasoner', questions: 750, paid: 0, unit });
    const replay = quoteOf({ model: 'deepseek-reasoner', questions: 750, paid: 750, unit });
    const half = quoteOf({ model: 'deepseek-reasoner', questions: 750, paid: 500, unit });
    expect(all.cny).toBeCloseTo(50.33, 1);
    expect(replay.cny).toBe(0);
    expect(replay.misses).toBe(0);
    expect(half.misses).toBe(250);
    expect(half.cny).toBeCloseTo(16.78, 1);
  });

  it('cannot claim more paid rows than it asked for, and says `none` when there is no price', () => {
    const over = quoteOf({ model: 'm', questions: 10, paid: 40, unit });
    expect(over.paid).toBe(10);
    expect(over.misses).toBe(0);
    const unpriced = quoteOf({ model: 'm', questions: 10, paid: 0, unit: undefined });
    expect(unpriced.basis).toBe('none');
    expect(unpriced.cny).toBe(0);
  });

  it('refuses an unpriced model, a quote over the ceiling, and neither otherwise', () => {
    expect(refusalOf(quoteOf({ model: 'm', questions: 1, paid: 0, unit: undefined }), DEFAULT_BUDGET_CNY))
      .toMatch(/no price on file for m/);
    const dear = quoteOf({ model: 'deepseek-reasoner', questions: 750, paid: 0, unit });
    expect(refusalOf(dear, DEFAULT_BUDGET_CNY)).toMatch(/¥50\.29 for 750 unpriced question\(s\).*over the ¥12\.00 ceiling/);
    expect(refusalOf(dear, 60)).toBeUndefined();
    // The cost of a re-read is zero, so the default ceiling cannot block one.
    const free = quoteOf({ model: 'deepseek-reasoner', questions: 750, paid: 750, unit });
    expect(refusalOf(free, DEFAULT_BUDGET_CNY)).toBeUndefined();
    // `none` is the one way to run an unpriced model, and it is a word rather than a number so that it
    // is greppable in a workflow and cannot be arrived at by typing a zero.
    expect(refusalOf(quoteOf({ model: 'm', questions: 1, paid: 0, unit: undefined }), 'none')).toBeUndefined();
    expect(() => refusalOf(dear, -1)).toThrow(/not an amount of money/);
  });

  it('prints the number it agreed to, including the rows it will not pay for', () => {
    const line = quoteLine(quoteOf({ model: 'deepseek-reasoner', questions: 750, paid: 748, unit }));
    expect(line).toContain('2 of 750 question(s) to buy, 748 already paid for');
    expect(line).toContain('¥0.13');
    expect(quoteLine(quoteOf({ model: 'm', questions: 3, paid: 0, unit: undefined })))
      .toBe('quote: 3 of 3 question(s) to buy · unpriced (m)');
  });

  it('keeps a default ceiling, and a number rather than an idea of one', () => {
    expect(DEFAULT_BUDGET_CNY).toBe(12);
  });
});
