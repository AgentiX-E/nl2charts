import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET_CNY, armPricesOf, closestOf, closestPriceOf, quoteLine, quoteOf, refusalOf, unitPriceOf, unitPricesOf,
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
    // The dearest chat arm is the one that also asks for the channel rule: ¥3.08 for the split,
    // against ¥3.02 for the arm it was measured on top of (itself ¥2.82 on top of the shipped list).
    // A price table that kept an older number would quote every later chat dispatch short, and the
    // direction of that error is the one that authorises spending — so it is the maximum, not the
    // arm the ablation selected, that the quote is built from.
    expect(chat?.cnyPerQuestion).toBeCloseTo(3.08 / 750, 6);
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

describe('the price of an instruction, not of a model', () => {
  const SHIPPED = ['count', 'corpus', 'corpus2', 'steps'] as const;

  it('lists one price per measured arm, each with the instruction that was measured', () => {
    const prices = armPricesOf(METRICS);
    // More arms than models: the reasoner alone is on file under the shipped rules, two tier cells
    // and four replicas, and they are five different prices.
    const reasoner = prices.filter((price) => price.model === 'deepseek-reasoner');
    expect(reasoner.length).toBeGreaterThan(4);
    expect(reasoner.some((price) => (price.rules ?? []).join(',') === SHIPPED.join(','))).toBe(true);
    // A replica has no rule set of its own, which is why a replica dispatch gets the dearest price.
    expect(reasoner.some((price) => (price.rules ?? []).length === 0)).toBe(true);
    // Tiers name their instruction in the key, because the cell is a different instrument otherwise.
    expect(prices.some((price) => price.source.startsWith('arms.tiers.cells.reasoner|count,corpus,'))).toBe(true);
    expect(armPricesOf(null)).toEqual([]);
  });

  it('quotes the arm whose instruction is closest, not the dearest one on the model', () => {
    // The dispatch that was refused: the shipped rules plus one, on the reasoning tier. The closest
    // measured arm is the published shipped arm at ¥0.02629 a question, not the 13.8 KB six-step
    // replica at ¥0.06705 — pricing the light prompt at the heavy prompt's rate made a ¥19.72 run
    // look like a ¥50.29 one and stopped it at a ¥25 ceiling.
    const close = closestPriceOf(METRICS, 'deepseek-reasoner', [...SHIPPED, 'ranks']);
    expect(close?.source).toBe('arms.selected.published');
    expect(close?.cnyPerQuestion).toBeCloseTo(0.02629, 5);
    expect((close?.cnyPerQuestion ?? 1) * 750).toBeLessThan(25);
    // The same model, the same question, priced with no rules at all: the dearest, deliberately.
    expect(unitPriceOf(METRICS, 'deepseek-reasoner')?.cnyPerQuestion).toBeCloseTo(0.06705, 4);
  });

  it('breaks a tie in closeness towards the dearer arm, because the quote is an upper bound', () => {
    const metrics = {
      arms: {
        model: 'm',
        asked: 10,
        readings: {
          a: { rules: ['x'], yuan: 10 },
          b: { rules: ['y'], yuan: 30 },
        },
      },
    };
    // Both arms are equally close to `['x','y']` (one of two rules each): the dearer one wins.
    expect(closestPriceOf(metrics, 'm', ['x', 'y'])?.source).toBe('arms.readings.b');
    // Closer beats dearer: `['x']` is a perfect match and is chosen over the dearer `['y']`.
    expect(closestPriceOf(metrics, 'm', ['x'])?.source).toBe('arms.readings.a');
    // A dispatch with no rules is every arm at once, and the conservative read is the dearest.
    expect(closestPriceOf(metrics, 'm', [])?.source).toBe('arms.readings.b');
    // The same through `unitPriceOf`: an empty rule set is "no instruction", so it keeps the maximum
    // rather than choosing the arm that happens to overlap least.
    expect(unitPriceOf(metrics, 'm', [])?.source).toBe('arms.readings.b');
    // A model with no arm at all has no closest arm either.
    expect(closestPriceOf(metrics, 'other', ['x'])).toBeUndefined();
  });

  it('reads the same price from the arm list as from the per-model maximum', () => {
    // `unitPricesOf` is the conservative summary and stays one; the two views may not disagree about
    // which model is which, or a quote and a refusal could cite different tables.
    for (const [model, price] of unitPricesOf(METRICS)) {
      const arms = armPricesOf(METRICS).filter((arm) => arm.model === model);
      const dearest = arms.reduce((left, right) => (right.cnyPerQuestion > left.cnyPerQuestion ? right : left));
      expect(price.cnyPerQuestion).toBeCloseTo(dearest.cnyPerQuestion, 10);
    }
  });
});

describe('a price table read from a file', () => {
  it('reads a rule list leniently, because metrics.json is a file and not a type', () => {
    const metrics = {
      arms: {
        model: 'm',
        asked: 10,
        readings: {
          // A rule set written as a string, and one that holds a number: both are how a hand-edited
          // table goes wrong, and neither may turn into a price for the wrong instruction.
          a: { rules: 'count', yuan: 10 },
          b: { rules: ['count', 3], yuan: 20 },
        },
      },
    };
    const prices = armPricesOf(metrics);
    expect(prices.find((price) => price.source.endsWith('.a'))?.rules).toEqual([]);
    expect(prices.find((price) => price.source.endsWith('.b'))?.rules).toEqual(['count']);
    // A reading that is not an object is not a reading: a table with one bad row still quotes.
    expect(armPricesOf({ arms: { model: 'm', asked: 10, readings: { bad: 'free' } } })).toEqual([]);
    expect(armPricesOf({ replicas: { model: 'm', asked: 10, readings: { bad: 'free' } } })).toEqual([]);
  });

  it('drops a tier cell that is not a price, and reads one whose name has no instruction', () => {
    const metrics = { arms: { tiers: { rows: 10, cells: { m: { yuan: 10 }, 'n|': { yuan: 0 }, o: 'free' } } } };
    const prices = armPricesOf(metrics);
    // `m` has no `|` in its name: the tier is the model and the instruction is empty, not the name.
    expect(prices).toHaveLength(1);
    expect(prices[0]?.model).toBe('m');
    expect(prices[0]?.rules).toEqual([]);
  });

  it('skips a replica reading whose denominator the file does not state', () => {
    // A replica divides by the replicas node's own `asked`. Without it there is a bill and no
    // denominator, which is not a price and must not become one.
    expect(armPricesOf({ replicas: { model: 'm', readings: { r: { yuan: 10 } } } })).toEqual([]);
    expect(armPricesOf({ replicas: { model: 'm', asked: 5, readings: { r: { yuan: 10 } } } }))
      .toEqual([{ model: 'm', cnyPerQuestion: 2, source: 'replicas.readings.r', rules: [] }]);
  });

  it('chooses among arms it is handed, including one that carries no rule set', () => {
    const arms = [
      { model: 'm', cnyPerQuestion: 1, source: 'hand-written' },
      { model: 'm', cnyPerQuestion: 9, source: 'measured', rules: ['count'] },
    ];
    // An arm with no rule set has nothing in common with a named one, so the named arm wins on
    // closeness even though it is dearer — and an empty request ties, which the dearer arm breaks.
    expect(closestOf(arms, 'm', ['count'])?.source).toBe('measured');
    // Two empty rule sets are the same instruction: overlap is 1, not a division by zero.
    expect(closestOf([arms[0]!], 'm', [])?.source).toBe('hand-written');
    expect(closestOf(arms, 'other', ['count'])).toBeUndefined();
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
