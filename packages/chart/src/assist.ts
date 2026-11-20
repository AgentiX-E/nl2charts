/**
 * The model's advice about a chart, and what the product does with it.
 *
 * ## Why this file is in `chart` and not in `ai`
 *
 * `chart` declares "no DOM, no model" and the layering guard enforces it: `ai` may not depend on
 * `chart`, so the only place a decision about a *mark* can live is here. What arrives from outside is
 * a function, not a client: `MarkAdvisor` is `(question, options) => name | undefined`, and this file
 * never learns a URL, a token, a model name or a temperature. The dependency is inverted rather than
 * broken, and the package that draws a chart still cannot call one.
 *
 * The consequence is testable and the suite holds it: with no advisor, `assistedMark` returns before
 * its first `await`, and `assistedChartIR` returns the same value `toChartIR` does — the same object,
 * byte for byte through `JSON.stringify`. A default path that costs an `await` and a branch is a
 * default path that can be slow or wrong; this one is neither.
 *
 * ## Why the advice is not trusted, and what "not trusted" means
 *
 * Two refusals, and they are different facts:
 *
 * 1. **The advice was not an answer.** Empty, unparseable, or a name the list does not carry. The
 *    caller decides what counts as unparseable — the reader belongs to the arm that wrote the reply,
 *    because a second reader would be a second variable inside a comparison. This file only checks
 *    membership, because a name outside `RECOMMENDABLE_MARKS` is a chart this product cannot draw,
 *    and drawing a bar instead of a name nobody has is choosing for the model rather than reading it.
 * 2. **The advice was an answer the result set cannot hold.** Handled one layer up, in
 *    `assistedChartIR`: a wide table has exactly one reading, and a model asking for a pie of it is
 *    asking for a picture the reshape does not produce. That veto is recorded, not silent, because a
 *    fallback nobody counts reads as a model that agreed.
 *
 * Neither refusal throws. A product that fails because an optional advisor failed is a product whose
 * availability is a function of somebody else's endpoint, and the rule table already answers every
 * question this corpus can ask.
 *
 * ## The second question, and why the first one is not enough
 *
 * The first answer is given to a list of eleven marks, and the table can hold fewer than eleven of
 * them. On this corpus that is not a corner: **223 rows** name a mark their own result set refuses,
 * 159 of them `boxplot` on a table with no distribution in it. The model was answering a question
 * whose option list contained marks this table could never draw, and the product then quietly
 * replaced its answer with the rule table's — which is a fallback being reported as a decision.
 *
 * So `assistedChartIR` can ask again, over `admittedOptions`: the same question, the same
 * instructions, a shorter list. It is opt-in (`repair: true`) because it is one extra call per
 * *refused* row and a caller who has not measured the trade-off should not be paying for it. It
 * never changes the first answer's role: `decided` in `eval/text2vis/ship.ts` is still one question
 * per row, so the identity against the arbitration policy stays exact.
 *
 * The repair cannot rescue a wrong intent — a model that meant a boxplot and is offered `bar` may
 * simply name `bar` — and it is not supposed to. It answers a narrower question: *of the pictures
 * this table can actually make, which one did you mean?* Whether that is worth 223 calls is a
 * measurement, and it is taken on the same 1,470 rows as every other reading here.
 *
 * ## The reading this exists to move
 *
 * `eval/text2vis/arbitrate.ts` priced six ways to route between the table's answer and the model's,
 * and the winner — the model everywhere it spoke, the table where it did not — reads **863** of 1,470
 * against the table's 606. That number was computed by a policy over cached answers; this file is the
 * same policy as shipped code, and `eval/text2vis/ship.ts` asserts the two agree row for row. A
 * policy that reads well in a table and a product that behaves differently are two claims, and only
 * one of them is worth publishing.
 */
import type { ChartIR } from '@agentix-e/nl2charts-spec';
import { RECOMMENDABLE_MARKS, toChartIR, type ChartIROptions, type RecommendableMark } from './recommend.js';

/** A mark this layer can draw, or the refusal the table already knows how to score. */
export type MarkName = RecommendableMark | 'declined';

/** One admissible answer: the token a model must write, and the clause that says what it means. */
export interface MarkOption {
  readonly name: RecommendableMark;
  readonly gloss: string;
}

/**
 * What each mark is, in one clause.
 *
 * These eleven strings are part of a *measured prompt*: `eval/text2vis/llm.ts` sends them and the
 * 861-top-1 reading was taken with them. They are repeated here rather than imported because `ai`
 * cannot be imported by `chart` and `eval` cannot be imported by either — and the duplication is
 * held together by a test that compares this table against the arm's, string for string
 * (`test/text2vis-ship.test.ts`). A wording changed in one place and not the other would change the
 * task without changing the measurement, which is the one kind of drift a test can catch for free.
 */
export const MARK_GLOSS: Readonly<Record<RecommendableMark, string>> = {
  bar: 'categories compared by the length of a bar',
  line: 'a value over time, joined into a line',
  scatter: 'two measures plotted against each other',
  heatmap: 'a measure over two categories, as colour',
  pie: 'parts of one whole, as slices',
  funnel: 'stages of a process, narrowing',
  boxplot: 'a five-number summary of a distribution',
  candlestick: 'open, high, low and close over time',
  radar: 'several measures on axes around a centre',
  parallel: 'several measures as parallel axes',
  gauge: 'one value against a fixed scale',
};

/**
 * The closed list, derived from the marks this layer can draw.
 *
 * Derived rather than restated for the reason `markOptions` in the arm gives: a second list of "the
 * marks we can draw" is a second answer to a question the recommender already answers, and a mark
 * added to one list and not the other would make the advice score a product that does not exist.
 */
export const MARK_OPTIONS: readonly MarkOption[] = RECOMMENDABLE_MARKS.map((mark) => ({ name: mark, gloss: MARK_GLOSS[mark] }));

/**
 * The marks *this table* can hold, in the roster's order.
 *
 * The list a second question is asked over. It is computed by trying every mark through the same
 * `toChartIR` that will draw the answer, which is the only definition of "drawable" that cannot drift
 * from the drawing: a separate predicate over column types would be a second opinion about admissions,
 * and the recommender already has one.
 *
 * Two properties are load-bearing downstream:
 *
 * - **It is shorter than `MARK_OPTIONS` whenever it is used**, because it is only built after a mark
 *   was refused and that mark is not on it. Callers rely on the difference to tell the two questions
 *   apart without being told which one they are answering.
 * - **The order is `RECOMMENDABLE_MARKS`'s**, not the order the marks survived in. A prompt hashed
 *   byte for byte is the cache key of the answer, so two implementations that agree on the set and
 *   disagree on the order would buy the same answer twice and read it as two.
 */
export function admittedOptions(
  question: string,
  rows: readonly Readonly<Record<string, unknown>>[],
  options: ChartIROptions = {},
): readonly MarkOption[] {
  const admitted: MarkOption[] = [];
  for (const option of MARK_OPTIONS) {
    try {
      toChartIR(question, rows, { ...options, mark: option.name });
      admitted.push(option);
    } catch {
      // The admission refused this mark for this table. Not an error: eleven refusals in a row is
      // what an unchartable table looks like, and it is the caller's job to have asked `toChartIR`
      // first — which `assistedChartIR` does, before it consults anybody.
    }
  }
  return admitted;
}

/** The second question, or nothing — an advisor is somebody else's endpoint and may throw. */
async function secondAnswer(
  advisor: MarkAdvisor,
  question: string,
  options: readonly MarkOption[],
): Promise<string | undefined> {
  try {
    return await advisor(question, options);
  } catch {
    return undefined;
  }
}

/**
 * A function that names a mark for a question, or declines to.
 *
 * `undefined` is a first-class answer and not an error: a model that says "none of these" is a model
 * that declined, and the product has an answer for that. Throwing is reserved for a caller whose
 * endpoint failed, which is also an answer — the table's.
 */
export interface MarkAdvisor {
  (question: string, options: readonly MarkOption[]): Promise<string | undefined>;
}

/** Who decided, what the table would have said, and why the table was asked after all. */
export interface AssistedDecision {
  /** The mark the chart will be drawn as. */
  readonly mark: MarkName;
  readonly source: 'model' | 'product';
  /** The table's own answer, published whether or not it was used: a fallback nobody shows is a fallback nobody audits. */
  readonly product: MarkName;
  /**
   * Why the table answered, when the advisor was asked and did not decide.
   *
   * Absent when no advisor was configured — that is the default path, not a refusal — and absent when
   * the model did decide. Three reasons, because they have three repairs: an endpoint that failed, a
   * reply that named nothing, and a name outside the list.
   */
  readonly fallback?: 'unavailable' | 'no-advice' | 'unlisted';
  /**
   * Why the model's answer was not drawn, when it named a mark this result set cannot hold.
   *
   * `wide` is the reshape: the table's columns are a timeline and one line per entity is the only
   * picture it produces, so the advisor was never asked. `not-admitted` is the recommender refusing
   * the mark the advisor named — the same admission that would have refused it had the table named it
   * — *after* the second question was asked and did not answer it either.
   */
  readonly veto?: 'wide' | 'not-admitted';
  /**
   * The model's first answer was refused by this table, and its *second* answer was drawn.
   *
   * Present only on a row that reached the repair, which is why it is a flag rather than a field on
   * every decision: a reading that cannot tell a first answer from a second reads as one model that
   * agreed with itself, and the whole point of the second question is that it does not.
   */
  readonly repaired?: true;
}

/**
 * The table's answer, unless a model gave a name this layer can draw.
 *
 * Read the order: `advisor === undefined` returns first, so the default path allocates one object and
 * awaits nothing. That is not an optimisation, it is the acceptance criterion — "with no key, byte for
 * byte the same as before" is a claim about control flow, and it is only true if there is no flow.
 */
export async function assistedMark(
  question: string,
  product: MarkName,
  advisor: MarkAdvisor | undefined,
): Promise<AssistedDecision> {
  if (advisor === undefined) return { mark: product, source: 'product', product };
  let named: string | undefined;
  try {
    named = await advisor(question, MARK_OPTIONS);
  } catch {
    // Swallowed on purpose. The advisor is somebody else's endpoint; a chart that fails because a
    // model timed out is a chart the user cannot have, and the table was already asked.
    return { mark: product, source: 'product', product, fallback: 'unavailable' };
  }
  if (named === undefined) return { mark: product, source: 'product', product, fallback: 'no-advice' };
  const mark = RECOMMENDABLE_MARKS.find((candidate) => candidate === named);
  if (mark === undefined) return { mark: product, source: 'product', product, fallback: 'unlisted' };
  return { mark, source: 'model', product };
}

/** The options `assistedChartIR` takes: everything `toChartIR` takes, plus the advisor. */
export interface AssistingChartIROptions extends ChartIROptions {
  readonly advisor?: MarkAdvisor;
  /**
   * Ask a second question when the first answer names a mark this table cannot hold.
   *
   * Off by default, and the default is the acceptance criterion: with no advisor — or with an advisor
   * and this flag absent — `assistedChartIR` returns what it returned before the flag existed, so a
   * caller who does not opt in cannot pay for a call they did not ask for. What it costs when it is
   * on: one call per *refused* row, not per row. On this corpus that is 223 of 1,470.
   */
  readonly repair?: boolean;
}

/** A chart and the decision that produced it, so a caller can log which one it got and why. */
export interface AssistedChart {
  readonly ir: ChartIR;
  readonly decision: AssistedDecision;
}

/**
 * `toChartIR`, with an optional model deciding the mark.
 *
 * The table is drawn **first**, always. Two reasons, and the second is the one that matters:
 *
 * 1. Its refusal is the honest answer for a table nothing can chart, and that answer must not depend
 *    on whether an advisor was configured — otherwise enabling a model would turn a refusal into a
 *    crash.
 * 2. It gives the advisor a `product` answer to fall back to *and* an admission set to be checked
 *    against, both computed by the same code that would have drawn the chart. Asking the recommender
 *    twice would let the two answers differ about a row neither of them changed.
 *
 * A wide table is not offered to the advisor at all: its columns *are* a timeline, one line per
 * entity is the only reading the reshape produces, and a bar of the long form would stack entities
 * the table went to the trouble of separating. Declining to ask is also 144 calls not spent — the
 * count `meltWide` reports on this corpus — which is the cost discipline the whole repository runs
 * on. The veto is recorded so a run that saved those calls cannot read as a model that agreed.
 */
export async function assistedChartIR(
  question: string,
  rows: readonly Readonly<Record<string, unknown>>[],
  options: AssistingChartIROptions = {},
): Promise<AssistedChart> {
  // The table's own chart, computed before anything is asked. `toChartIR` throws
  // `NL2C_E_NOT_SUPPORTED` for a table nothing can draw, and that throw is the caller's answer — the
  // advisor is not consulted about a question with no chart in it.
  //
  // `chartOptions` is the same object minus the advisor: `ChartIROptions` is the contract `toChartIR`
  // reads, and an advisor is not part of it. Assigning rather than spreading keeps the identity of
  // the caller's options, so a field added to `ChartIROptions` reaches this call without an edit here.
  const chartOptions: ChartIROptions = options;
  const productIr = toChartIR(question, rows, chartOptions);
  const product = productIr.mark as MarkName;
  const advisor = options.advisor;
  if (advisor === undefined) return { ir: productIr, decision: { mark: product, source: 'product', product } };
  // The reshape has already happened inside `toChartIR`; a chart whose mark is `line` and whose data
  // carries a `series` channel is that path's output, and no other mark is available on it.
  if (productIr.encoding.series !== undefined) {
    return { ir: productIr, decision: { mark: product, source: 'product', product, veto: 'wide' } };
  }
  const decision = await assistedMark(question, product, advisor);
  if (decision.source === 'product') return { ir: productIr, decision };
  try {
    return {
      ir: toChartIR(question, rows, { ...chartOptions, mark: decision.mark as RecommendableMark }),
      decision,
    };
  } catch {
    // The name was on the roster and this result set still cannot hold it. That is a fact about the
    // table, not about the model's intent — and it is the one case where a second question has
    // something to add, because the model was answering a question whose option list contained marks
    // this table could never draw.
    const repaired = options.repair === true ? await repairMark(question, rows, chartOptions, advisor) : undefined;
    if (repaired !== undefined) {
      return {
        ir: toChartIR(question, rows, { ...chartOptions, mark: repaired }),
        decision: { mark: repaired, source: 'model', product, repaired: true },
      };
    }
    // A name the table cannot hold, and no second answer that it can. The refusal is the veto —
    // recorded, never silent, because a fallback nobody counts reads as a model that agreed.
    return { ir: productIr, decision: { ...decision, mark: product, source: 'product', veto: 'not-admitted' } };
  }
}

/**
 * The second question, asked over the marks this table can hold.
 *
 * Three refusals to ask, and each of them is a call that would have been wasted or a reading that
 * would have meant something else:
 *
 * 1. **Fewer than two drawable marks.** A question with one possible answer is not a question; the
 *    model would be asked to name the only name and the answer would be the table's by construction.
 * 2. **An answer outside the shorter list.** A model that writes a name the list does not carry is
 *    not being asked a second time; it is declining, and the table already has an answer.
 * 3. **An advisor that threw.** The endpoint is somebody else's, and a chart that fails because a
 *    model timed out is a chart the user cannot have.
 *
 * The returned mark is always one of `admitted`, so the caller can encode it without a second
 * admission check — and if that encode still throws, the caller's own `catch` is the honest answer.
 */
async function repairMark(
  question: string,
  rows: readonly Readonly<Record<string, unknown>>[],
  options: ChartIROptions,
  advisor: MarkAdvisor,
): Promise<RecommendableMark | undefined> {
  const admitted = admittedOptions(question, rows, options);
  if (admitted.length < 2) return undefined;
  const named = await secondAnswer(advisor, question, admitted);
  if (named === undefined) return undefined;
  return admitted.find((option) => option.name === named)?.name;
}
