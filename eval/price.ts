/**
 * What a call costs, in the unit the provider bills.
 *
 * Every reading in this repository has been published in *calls* — 1,418 figures, one call each —
 * and calls are not money. A call that answers two integers after nine hundred tokens of
 * deliberation and a call that answers them directly are the same column and about forty times
 * apart on the invoice, so a benchmark that counts calls cannot say what it spent and cannot be
 * asked to spend less.
 *
 * This file is the price list. It is deliberately a table of numbers read off a provider's page on
 * a named day rather than a formula, because a formula is a claim about a commercial relationship
 * and a table is a citation. A model that is not in the table is not free — it is unpriced, and
 * {@link billOf} returns `undefined` so the caller prints tokens and says so.
 *
 * ## Reading it
 *
 * Prices are 元 per million tokens, as the provider's own page states them, for the standard
 * per-call API. Two discounts exist and neither is applied here: a resource package (a prepaid
 * block, which is cheaper per token) and the batch API (half price, asynchronous). A reading that
 * used either is cheaper than the number this file prints, never more expensive.
 */

export interface ModelPrice {
  /** 元 per million prompt tokens the endpoint had to read. */
  readonly input: number;
  readonly output: number;
  /**
   * 元 per million prompt tokens the endpoint served from its own prefix cache.
   *
   * Required rather than optional, and that is a decision about what this table is for: every row on
   * it is a provider that publishes a hit price, and a row that left the field out would silently
   * charge every prompt token at the miss price. On `deepseek-flash` a hit is a fiftieth of a miss and
   * 76% of a BIRD push's prompt tokens are hits, so that omission is a seven-fold overstatement — the
   * direction of error that makes a cheap lever look expensive. A provider that truly has one price
   * for every prompt token states it twice, and says so in this field's absence being impossible.
   */
  readonly cached: number;
  /** The day the figure below was read off {@link ModelPrice.source}. */
  readonly asOf: string;
  readonly source: string;
}

const ZHIPU = 'https://docs.bigmodel.cn/cn/guide/start/pricing';
const DEEPSEEK = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';
const READ_ON = '2026-11-18';

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  // The grader. Vision, 32K context tier, which is where every one of these calls lands: the system
  // prompt is 1.1 KB and the picture is about 800 tokens.
  'glm-4.5v': { input: 2, output: 6, cached: 0.4, asOf: READ_ON, source: ZHIPU },
  // Half the price of 4.5V for a newer vision model, and the reason a grader swap is worth one
  // paired experiment rather than a paragraph of opinion.
  'glm-4.6v': { input: 1, output: 3, cached: 0.2, asOf: READ_ON, source: ZHIPU },
  'glm-4.6v-flashx': { input: 0.15, output: 1.5, cached: 0.03, asOf: READ_ON, source: ZHIPU },
  'glm-4.5-air': { input: 0.8, output: 6, cached: 0.16, asOf: READ_ON, source: ZHIPU },
  // There is no `glm-4.5` row, and its absence is a finding rather than an omission: that name was
  // `bird-model.yml`'s default for three months, and the page above lists GLM-4.5-Air and GLM-4.5V
  // and no plain GLM-4.5, so no citation exists to put in this table. A dispatch under a name with
  // no row is refused by `eval/bird/spend.ts` rather than costed at zero — which is the whole point
  // of the table, and the reason the workflow's default is now `glm-4.5-air`.
  // The BIRD backbone. Priced at the peak-hour, cache-miss column, so a bill read off this table is an
  // upper bound: the provider charges half in every hour outside 09:00-12:00 and 14:00-18:00 on
  // weekdays, and this repository runs most of its jobs at night.
  'deepseek-flash': { input: 2, output: 8, cached: 0.04, asOf: READ_ON, source: DEEPSEEK },
  // The larger base, and the one that answered `45090651019`. It is on this table because it was
  // dispatched while it was not: `bench:bill` printed "no price on file for deepseek-v4-pro" on a
  // reading that had already been billed, so the one command this repository uses to answer "what
  // did that cost" could not answer it. Same peak-hour, cache-miss column as Flash, for the same
  // reason — a bill read off this table is an upper bound, never an understatement.
  //
  // The rate is only half of what that run cost. The model's thinking mode is on by default and
  // 94.0% of its completion tokens were reasoning: 3,653,919 of 3,885,213, or ¥98.66 of a ¥110
  // reading. A price table that reports the rate without the mode says a run was expensive without
  // saying why.
  'deepseek-v4-pro': { input: 9, output: 27, cached: 0.3, asOf: '2026-11-23', source: DEEPSEEK },
  // The two names every reading before this table was written used. Both have left the provider's
  // list, and its own page says a request under either is served by V4.1-Flash and **billed at Flash
  // prices** — so these are the same numbers under an older name, not a guess. `deepseek-reasoner` is
  // one base model's thinking mode rather than a bigger model, and the page lists one rate for both.
  'deepseek-chat': { input: 2, output: 8, cached: 0.04, asOf: READ_ON, source: DEEPSEEK },
  'deepseek-reasoner': { input: 2, output: 8, cached: 0.04, asOf: READ_ON, source: DEEPSEEK },
  // The vector model behind the paired value-pricing dispatch. The provider's vector-model table
  // (read 2026-11-28) lists Embedding-3 at ¥0.5 per million input tokens and ¥0.25 on the batch API;
  // there is no output-token charge for an embedding. Without this row `bench:bill` prints "no price
  // on file" for a dispatch that already spent the tokens, so the pricing workflow could not be
  // costed before it ran. Batch is not modelled here because the dispatch is synchronous.
  'embedding-3': { input: 0.5, output: 0, cached: 0.5, asOf: '2026-11-28', source: ZHIPU },
};

/** The tokens of one call, in the shape every endpoint in this repository reports them. */
export interface TokenCounts {
  readonly promptTokens: number;
  readonly completionTokens: number;
  /**
   * Accepted and deliberately ignored.
   *
   * The provider bills deliberation *inside* `completion_tokens` — `provider.ts` says so where it
   * parses the field, and `docs/benchmarks.md` reports 1,272,338 of 1,294,167 completion tokens as
   * reasoning. Charging it again here would double the bill for exactly the rows whose cost is
   * under examination, and the error would point at the conclusion the round was written to test.
   */
  readonly reasoningTokens?: number;
  /** Prompt tokens the endpoint served from its prefix cache, when it said. */
  readonly cachedPromptTokens?: number;
}

/** 元 for one call, or `undefined` when this file has no price for the model. */
export function billOf(model: string, tokens: TokenCounts): number | undefined {
  const price = PRICES[model];
  if (price === undefined) return undefined;
  // A hit count larger than the prompt is an endpoint's arithmetic error, not a discount: clamped, so
  // the bill cannot go negative on a report that claims it.
  const cached = Math.min(tokens.cachedPromptTokens ?? 0, tokens.promptTokens);
  const missed = tokens.promptTokens - cached;
  const input = missed * price.input + cached * price.cached;
  return (input + tokens.completionTokens * price.output) / 1_000_000;
}

/**
 * A yuan amount, at a precision that fits its size.
 *
 * Most readings are single-digit yuan and the unit of interest is one row, which is a few
 * thousandths of one: printing `¥0.00` for a row would hide the number at the moment it is being
 * compared. Prices between a fen and a yuan get three decimals, below a fen four, and a whole
 * yuan gets the two that people actually read.
 */
export function formatYuan(yuan: number): string {
  if (yuan >= 1) return `¥${yuan.toFixed(2)}`;
  if (yuan >= 0.01) return `¥${yuan.toFixed(3)}`;
  return `¥${yuan.toFixed(4)}`;
}

const grouped = (value: number): string => value.toLocaleString('en-US');

/**
 * One line for the log: what was spent, in tokens and in money, and by which model.
 *
 * The token counts are printed even when the money is not, because they are measured and the money
 * is a table lookup: a reader can re-price the line with today's page, and a reader of a cached run
 * can see that the tokens were zero rather than that the endpoint forgot to report them.
 */
export function describeBill(model: string, tokens: TokenCounts): string {
  const reasoning =
    tokens.reasoningTokens === undefined || tokens.reasoningTokens === 0
      ? ''
      : ` (${grouped(tokens.reasoningTokens)} reasoning)`;
  const hits =
    tokens.cachedPromptTokens === undefined || tokens.cachedPromptTokens === 0
      ? ''
      : `, ${grouped(tokens.cachedPromptTokens)} of them cache hits`;
  const counts = `${grouped(tokens.promptTokens)} prompt${hits} + ${grouped(tokens.completionTokens)} completion${reasoning}`;
  const yuan = billOf(model, tokens);
  if (yuan === undefined) return `${counts}, no price on file for ${model}`;
  const price = PRICES[model] as ModelPrice;
  return `${counts} = ${formatYuan(yuan)} at ${model} list price (${price.asOf})`;
}
