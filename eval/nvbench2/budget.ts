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

/**
 * One measured price: yuan per question, and where the number came from.
 *
 * `rules` is the instruction that was measured, and it is what makes the price comparable: a 4.9 KB
 * prompt and a 13.8 KB prompt on the same model differ by 2.5 times, so a price without its rule set
 * is a price for some other dispatch.
 */
export interface UnitPrice {
  readonly model: string;
  readonly cnyPerQuestion: number;
  /** The part of `metrics.json` the row was read from, so a surprising quote can be traced. */
  readonly source: string;
  readonly rules?: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numberAt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * Every measured yuan-per-question row, one per arm, with the instruction that was measured.
 *
 * `yuan` in an artifact is the whole split's bill and `asked` its denominator, so the ratio is a
 * question's price including the answers that were replayed from cache — which is the right unit for
 * a quote: a replay is what a re-dispatch of an unchanged arm will do.
 *
 * Kept per arm rather than per model because a model is not a price. `deepseek-reasoner` reading the
 * shipped rules costs ¥0.0263 a question and reading the corpus's 13.8 KB six-step prompt costs
 * ¥0.0671; collapsing those to the maximum is what turned a ¥19.70 dispatch into a quote of ¥50.29
 * and a refusal that named the wrong instrument.
 */
export function armPricesOf(metrics: unknown): readonly UnitPrice[] {
  const out: UnitPrice[] = [];
  const offer = (
    model: unknown,
    yuan: unknown,
    asked: unknown,
    rules: readonly string[],
    source: string,
  ): void => {
    const bill = numberAt(yuan);
    const questions = numberAt(asked);
    if (typeof model !== 'string' || bill === undefined || questions === undefined) return;
    out.push({ model, cnyPerQuestion: bill / questions, source, rules });
  };
  if (!isRecord(metrics)) return out;

  const rulesAt = (value: unknown): readonly string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

  const arms = isRecord(metrics['arms']) ? metrics['arms'] : {};
  const asked = arms['asked'];
  const readings = isRecord(arms['readings']) ? arms['readings'] : {};
  for (const [name, reading] of Object.entries(readings)) {
    if (!isRecord(reading)) continue;
    offer(arms['model'], reading['yuan'], asked, rulesAt(reading['rules']), `arms.readings.${name}`);
  }

  // The published reading is the arm the product ships, and it is the one a dispatch of the shipped
  // rules should be priced at — it is a full split on the reasoning tier, which no cell below is.
  const selected = isRecord(arms['selected']) ? arms['selected'] : {};
  const published = isRecord(selected['published']) ? selected['published'] : {};
  offer(
    selected['model'],
    published['yuan'],
    published['questions'],
    rulesAt(selected['rules']),
    'arms.selected.published',
  );

  const tiers = isRecord(arms['tiers']) ? arms['tiers'] : {};
  const cells = isRecord(tiers['cells']) ? tiers['cells'] : {};
  for (const [name, cell] of Object.entries(cells)) {
    if (!isRecord(cell)) continue;
    // `chat|count,corpus` — the tier is the model family, the rest is the instruction.
    const [model, list] = name.split('|');
    offer(model, cell['yuan'], tiers['rows'], (list ?? '').split(',').filter((rule) => rule !== ''), `arms.tiers.cells.${name}`);
  }

  const replicas = isRecord(metrics['replicas']) ? metrics['replicas'] : {};
  const replicaReadings = isRecord(replicas['readings']) ? replicas['readings'] : {};
  for (const [name, reading] of Object.entries(replicaReadings)) {
    if (!isRecord(reading)) continue;
    // A replica arm sends the corpus's prompt, so it has no rules of its own.
    offer(replicas['model'], reading['yuan'], replicas['asked'], [], `replicas.readings.${name}`);
  }
  return out;
}

/** Every measured yuan-per-question row, keyed by model, keeping the dearest. */
export function unitPricesOf(metrics: unknown): ReadonlyMap<string, UnitPrice> {
  const found = new Map<string, UnitPrice>();
  for (const arm of armPricesOf(metrics)) {
    const prior = found.get(arm.model);
    if (prior !== undefined && prior.cnyPerQuestion >= arm.cnyPerQuestion) continue;
    found.set(arm.model, arm);
  }
  return found;
}

/** How much two rule sets have in common, as a share of everything either of them names. */
function overlap(left: readonly string[], right: readonly string[]): number {
  const all = new Set([...left, ...right]);
  if (all.size === 0) return 1;
  let shared = 0;
  for (const rule of new Set(left)) if (right.includes(rule)) shared += 1;
  return shared / all.size;
}

/**
 * The measured arm whose instruction is closest to this dispatch's.
 *
 * Closeness rather than the maximum, with the maximum kept as the tie-break: the quote has to be an
 * upper bound on *this* prompt, and the dearest arm on the model is usually a different prompt. A
 * dispatch naming no rules at all has no instruction to be close to, so it gets the dearest.
 */
export function closestPriceOf(
  metrics: unknown,
  model: string,
  rules: readonly string[],
): UnitPrice | undefined {
  return closestOf(armPricesOf(metrics), model, rules);
}

/**
 * The closest arm in a list that is already in memory.
 *
 * Split from `closestPriceOf` so the choice can be tested against arms a caller constructs — including
 * one that carries no rule set, which is the shape a hand-written row has and the reason `rules` is
 * optional on `UnitPrice`.
 */
export function closestOf(
  arms: readonly UnitPrice[],
  model: string,
  rules: readonly string[],
): UnitPrice | undefined {
  const candidates = arms.filter((arm) => arm.model === model);
  if (candidates.length === 0) return undefined;
  let best = candidates[0] as UnitPrice;
  for (const arm of candidates) {
    const mine = overlap(arm.rules ?? [], rules);
    const theirs = overlap(best.rules ?? [], rules);
    if (mine > theirs || (mine === theirs && arm.cnyPerQuestion > best.cnyPerQuestion)) best = arm;
  }
  return best;
}

/**
 * What a question costs on this model under this instruction, or nothing if it was never measured.
 *
 * With `rules` the quote follows the closest measured arm, because an instruction is most of a bill;
 * without them it falls back to the dearest, which is the conservative read a caller gets when it
 * sends a replica (whose prompt has no rule set to be close to).
 */
export function unitPriceOf(
  metrics: unknown,
  model: string,
  rules?: readonly string[],
): UnitPrice | undefined {
  // Two views of one file, and the closest arm is only defined when there is an instruction to be
  // close to: an empty rule set is a dispatch that names nothing, which is the dearest case.
  if (rules !== undefined && rules.length > 0) return closestPriceOf(metrics, model, rules);
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
