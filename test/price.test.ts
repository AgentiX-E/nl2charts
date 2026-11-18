import { describe, expect, it } from 'vitest';
import { PRICES, billOf, describeBill, formatYuan } from '../eval/price.js';

/** One million tokens of a model, so a unit price reads as a number rather than as arithmetic. */
const million = (model: string, prompt = 1_000_000, completion = 1_000_000) =>
  billOf(model, { promptTokens: prompt, completionTokens: completion });

describe('the price table', () => {
  it('names its source and the day it was read, on every row', () => {
    // A price without provenance is folklore: it cannot be re-checked, and it silently becomes a lie
    // when the provider changes the page.
    for (const [model, price] of Object.entries(PRICES)) {
      expect(price.asOf, model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(price.source, model).toMatch(/^https:\/\//);
      expect(price.input, model).toBeGreaterThanOrEqual(0);
      expect(price.output, model).toBeGreaterThanOrEqual(0);
    }
  });

  it('prices the grader at what the provider charges for it, per million tokens', () => {
    expect(PRICES['glm-4.5v']?.input).toBe(2);
    expect(PRICES['glm-4.5v']?.output).toBe(6);
    expect(million('glm-4.5v')).toBe(8);
  });

  it('charges reasoning once, because it is already inside the completion count', () => {
    // The bill is the reason the whole cost round exists: 98.3% of the judge's completion tokens are
    // deliberation. If `billOf` charged `reasoningTokens` on top of `completionTokens` it would report
    // roughly double the real bill for exactly the rows where the question is most interesting.
    const plain = billOf('glm-4.5v', { promptTokens: 828, completionTokens: 975 });
    const thinking = billOf('glm-4.5v', { promptTokens: 828, completionTokens: 975, reasoningTokens: 958 });
    expect(thinking).toBe(plain);
  });

  it('charges a cache hit at the hit price, because a hit is a fiftieth of a miss', () => {
    // The BIRD arms share one schema card across four calls, so a third of every prompt is a hit.
    // Pricing it as a miss would overstate a run by about a third of its prompt bill, and overstating a
    // bill is how a cheap lever gets rejected as expensive.
    const all = billOf('deepseek-flash', { promptTokens: 1_000_000, completionTokens: 0 });
    const half = billOf('deepseek-flash', { promptTokens: 1_000_000, completionTokens: 0, cachedPromptTokens: 500_000 });
    expect(all).toBe(2);
    expect(half).toBeCloseTo((500_000 * 2 + 500_000 * 0.04) / 1_000_000, 9);
    expect(half).toBeCloseTo(1.02, 9);
  });

  it('clamps a hit count larger than the prompt instead of billing a negative amount', () => {
    const impossible = billOf('deepseek-flash', { promptTokens: 100, completionTokens: 0, cachedPromptTokens: 1_000 });
    expect(impossible).toBeCloseTo((100 * 0.04) / 1_000_000, 12);
  });

  it('reports nothing rather than zero for a model it has no price for', () => {
    // `0` would be a claim that the call was free. Undefined is the claim that this file does not know,
    // which is what makes the tool print tokens-only instead of inventing a yuan figure.
    expect(billOf('a-model-nobody-priced', { promptTokens: 1_000_000, completionTokens: 1_000_000 })).toBeUndefined();
  });

  it('is linear in both directions, so a per-row price can be read off one full reading', () => {
    expect(million('glm-4.5v', 2_000_000, 0)).toBe(4);
    expect(million('glm-4.5v', 0, 2_000_000)).toBe(12);
    expect(billOf('glm-4.5v', { promptTokens: 0, completionTokens: 0 })).toBe(0);
  });
});

describe('what the log prints', () => {
  it('keeps four decimals for an amount under a fen, because most readings are one', () => {
    // A full 1,418-row reading is about ten yuan; one row is about seven thousandths of one. Printing
    // `¥0.00` for a row would make the per-row price unreadable exactly where it is being compared.
    expect(formatYuan(0.0071)).toBe('¥0.0071');
    expect(formatYuan(0.31)).toBe('¥0.310');
    expect(formatYuan(10.61)).toBe('¥10.61');
    expect(formatYuan(0)).toBe('¥0.0000');
  });

  it('names the deliberation and the hits, because both are on the invoice', () => {
    // A line that printed only `prompt + completion` would hide the two facts this round exists for:
    // the reasoning is inside completion and it is 98% of it, and the hits are prompt tokens that cost
    // a fiftieth of the rest.
    const line = describeBill('deepseek-flash', {
      promptTokens: 1_000_000,
      completionTokens: 500_000,
      reasoningTokens: 480_000,
      cachedPromptTokens: 760_000,
    });
    expect(line).toContain('480,000 reasoning');
    expect(line).toContain('760,000 of them cache hits');
    expect(line).toContain('¥');
  });

  it('says which model priced the line, and says when nobody could', () => {
    const usage = { promptTokens: 1_171_852, completionTokens: 1_380_180, reasoningTokens: 1_356_000 };
    const priced = describeBill('glm-4.5v', usage);
    expect(priced).toContain('glm-4.5v');
    expect(priced).toContain('¥10.62');
    expect(priced).toContain('1,171,852');
    expect(describeBill('unpriced-model', usage)).toContain('no price on file');
    expect(describeBill('unpriced-model', usage)).not.toContain('¥');
    // A reading with no deliberation and no hits prints neither clause: a `0 reasoning` on every line
    // of a non-reasoning run is noise that trains a reader to stop reading the line.
    const plain = describeBill('glm-4.5v', { promptTokens: 100, completionTokens: 100 });
    expect(plain).not.toContain('reasoning');
    expect(plain).not.toContain('cache hits');
  });
});
