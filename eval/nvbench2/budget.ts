/**
 * What a dispatch is about to cost, said before it costs it.
 *
 * ## Why a quote and not a budget line in a plan
 *
 * A plan table said "≈¥3" for a full-split arm, and the invoice for the day was ¥100.01. The table
 * was not lying about the arithmetic; it was pricing every arm at the cheapest tier this repository
 * measures with (¥0.0023 a question, chat tier, short prompt) while the arm that was dispatched was a
 * reasoning tier reading a 13.8 KB instruction (¥0.0671 a question — 29 times more). A number that
 * lives in prose cannot refuse a dispatch, and a dispatch is the only moment the money is spent.
 *
 * So the quote is computed from three things that are all measurable before the first call:
 *
 * * **how many questions are already paid for.** The answer store is keyed by the exact request, so
 *   the arm can price the *misses* rather than the split. A re-read of 750 cached answers costs ¥0,
 *   and saying so beforehand is what makes "re-run it from cache" a decision instead of a hope.
 * * **what a question has cost on this model, at the dearest instrument measured so far.** The table
 *   is read out of `metrics.json` rather than typed here, so it cannot drift from the readings it
 *   describes, and taking the maximum is deliberate: an underestimate authorises spending, and the
 *   error this file exists to prevent is an underestimate.
 * * **the ceiling the dispatch declares.** A quote above the ceiling refuses the run instead of
 *   asking a log reader to notice the total afterwards.
 *
 * ## What it is not
 *
 * It is not a forecast of the reading. A cheap arm that answers nothing is not cheap; the quote says
 * what the calls cost, and `truncated` in the artifact says how much of that was thrown away.
 */

/** The ceiling a dispatch gets when it does not name one: a full split on the chat tier, and no more. */
export const DEFAULT_BUDGET_CNY = 12;

/**
 * A ceiling in yuan, or `none` for a model nobody has priced yet.
 *
 * `none` exists because this arm's job includes measuring a model before `eval/price.ts` has a row
 * for it, and a quote cannot be made from a price that does not exist. It has to be typed: the
 * failure this gate is built against is a dispatch that spends freely because nobody did the sum,
 * and "the model is unpriced so we ran it anyway" is that failure with a footnote.
 */
export type Budget = number | 'none';

/** One measured price: yuan per question, and where the number came from. */
export interface UnitPrice {
  readonly model: string;
  readonly cnyPerQuestion: number;
  /** The part of `metrics.json` the row was read from, so a surprising quote can be traced. */
  readonly source: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numberAt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * Every measured yuan-per-question row, keyed by model, keeping the dearest.
 *
 * `yuan` in an artifact is the whole split's bill and `asked` its denominator, so the ratio is a
 * question's price including the answers that were replayed from cache — which is the right unit for
 * a quote: a replay is what a re-dispatch of an unchanged arm will do.
 */
export function unitPricesOf(metrics: unknown): ReadonlyMap<string, UnitPrice> {
  const found = new Map<string, UnitPrice>();
  const offer = (model: unknown, yuan: unknown, asked: unknown, source: string): void => {
    const bill = numberAt(yuan);
    const questions = numberAt(asked);
    if (typeof model !== 'string' || bill === undefined || questions === undefined) return;
    const price = bill / questions;
    const prior = found.get(model);
    if (prior !== undefined && prior.cnyPerQuestion >= price) return;
    found.set(model, { model, cnyPerQuestion: price, source });
  };
  if (!isRecord(metrics)) return found;

  const arms = isRecord(metrics['arms']) ? metrics['arms'] : {};
  const asked = arms['asked'];
  const readings = isRecord(arms['readings']) ? arms['readings'] : {};
  for (const [name, reading] of Object.entries(readings)) {
    if (isRecord(reading)) offer(arms['model'], reading['yuan'], asked, `arms.readings.${name}`);
  }
  const tiers = isRecord(arms['tiers']) ? arms['tiers'] : {};
  const cells = isRecord(tiers['cells']) ? tiers['cells'] : {};
  for (const [name, cell] of Object.entries(cells)) {
    if (!isRecord(cell)) continue;
    // `chat|count,corpus` — the tier is the model family, and the cell's own `run` names the dispatch.
    const model = name.split('|')[0];
    offer(model, cell['yuan'], tiers['rows'], `arms.tiers.cells.${name}`);
  }

  const replicas = isRecord(metrics['replicas']) ? metrics['replicas'] : {};
  const replicaReadings = isRecord(replicas['readings']) ? replicas['readings'] : {};
  for (const [name, reading] of Object.entries(replicaReadings)) {
    if (isRecord(reading)) offer(replicas['model'], reading['yuan'], replicas['asked'], `replicas.readings.${name}`);
  }
  return found;
}

/** The dearest measured question on this model, or nothing if the model has never been measured. */
export function unitPriceOf(metrics: unknown, model: string): UnitPrice | undefined {
  return unitPricesOf(metrics).get(model);
}

/** A dispatch priced before it runs. */
export interface Quote {
  readonly model: string;
  /** Questions this dispatch would ask, after `--limit`. */
  readonly questions: number;
  /** Of those, the ones whose exact request is already in the answer store. */
  readonly paid: number;
  readonly misses: number;
  /** Yuan per question used for the misses. */
  readonly cnyPerQuestion: number;
  /** What the misses are expected to cost. */
  readonly cny: number;
  /** Where the unit price came from; `none` means the model is unpriced and the dispatch cannot run. */
  readonly basis: string;
}

export function quoteOf(input: {
  readonly model: string;
  readonly questions: number;
  readonly paid: number;
  readonly unit: UnitPrice | undefined;
}): Quote {
  const misses = Math.max(0, input.questions - input.paid);
  const cnyPerQuestion = input.unit?.cnyPerQuestion ?? 0;
  return {
    model: input.model,
    questions: input.questions,
    paid: Math.min(input.paid, input.questions),
    misses,
    cnyPerQuestion,
    cny: Math.round(misses * cnyPerQuestion * 10000) / 10000,
    basis: input.unit?.source ?? 'none',
  };
}

/**
 * The sentence that stops a run, or nothing when the run fits inside its ceiling.
 *
 * Three refusals, and they are different sentences because they have different fixes: an unpriced
 * model needs a row on `eval/price.ts`, a quote over the ceiling needs a bigger `--budget` (a human
 * decision, deliberately), and a dispatch that has already spent its ceiling cannot be rescued by
 * raising it — that one has to be argued for with a limit.
 */
export function refusalOf(quote: Quote, budget: Budget): string | undefined {
  if (budget === 'none') return undefined;
  if (!Number.isFinite(budget) || budget < 0) throw new Error(`a budget of ${String(budget)} is not an amount of money`);
  if (quote.basis === 'none') {
    return `no price on file for ${quote.model}: the quote cannot be made, so the dispatch is refused rather than run unpriced`;
  }
  if (quote.cny > budget) {
    return `the quote is ¥${quote.cny.toFixed(2)} for ${String(quote.misses)} unpriced question(s) at `
      + `¥${quote.cnyPerQuestion.toFixed(4)} each (${quote.basis}), over the ¥${budget.toFixed(2)} ceiling`
      + ' — raise --budget deliberately, or ask fewer rows with --limit';
  }
  return undefined;
}

/** The quote as one line, printed before the first call so the log carries the number it agreed to. */
export function quoteLine(quote: Quote): string {
  const paid = quote.paid === 0 ? '' : `, ${String(quote.paid)} already paid for`;
  if (quote.basis === 'none') return `quote: ${String(quote.misses)} of ${String(quote.questions)} question(s) to buy${paid} · unpriced (${quote.model})`;
  return `quote: ${String(quote.misses)} of ${String(quote.questions)} question(s) to buy${paid} · `
    + `¥${quote.cny.toFixed(2)} at ¥${quote.cnyPerQuestion.toFixed(4)}/question (${quote.basis})`;
}
