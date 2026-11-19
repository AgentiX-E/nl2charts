/**
 * One closed-list choice, asked of a model: the prompt, the reader, and the advisor.
 *
 * ## What this file is for
 *
 * The chart half has a decision that is eleven-way and one word wide: *which mark*. `chart` can read
 * that decision but cannot ask for it — the package declares "no DOM, no model" and the layering
 * guard enforces it — so the ask lives here and arrives at `chart` as a function. That is the whole
 * design: this file knows about HTTP, tokens and temperatures; `chart` knows about admissions and
 * encodings; neither imports the other.
 *
 * ## Why the prompt is a constant here and a measurement there
 *
 * `eval/text2vis/llm.ts` sends a prompt of four lines and it has been paid for 1,470 times twice
 * over. The reading it produced — 857 top-1 on the mark scale, 861 once the table's refusals are
 * routed in — is a number *about that text*. Reproducing the reading from the product is therefore
 * only possible if the product sends the same bytes, which is why `test/text2vis-ship.test.ts`
 * compares this builder against the arm's, character for character, instead of trusting a comment.
 *
 * The duplication is the price of the layering rule. The alternative — moving the prompt into `chart`
 * and having `eval` import it — would change `eval/text2vis/llm.ts`, which is one of the two files
 * hashed into the answer-cache key: every one of the 1,470 cached answers would miss, and the next
 * dispatch of the benchmark would pay ¥1.25 to re-learn what it already knows. A test that compares
 * two string literals costs nothing and catches the drift the comment cannot.
 *
 * ## Why a truncated reply is not an answer
 *
 * The same rule the judge learned at 1,024 tokens and the arm at 96: a reply cut at the cap is a
 * prefix, and a prefix of a name is not a name. `askOnce` folds it to "named nothing" and so does
 * this file — a `length` finish reason discards the text even when the first word of it happened to
 * be right. Scoring a lucky cut is how the first full run published 860 instead of 857.
 */
import type { LlmMessage, LlmProvider } from './provider.js';

/** The three instruction lines, byte-identical to the arm's (`eval/text2vis/llm.ts`). */
export const CHART_CHOICE_INSTRUCTION: readonly string[] = [
  'Choose the chart that best answers the question below.',
  'You are given the question only: no table, no result, no rows.',
  'Answer with exactly one name from this list, and nothing else:',
];

/** One admissible answer: the token a model must write, and the clause that says what it means. */
export interface ChartChoiceOption {
  readonly name: string;
  readonly gloss: string;
}

/**
 * The two messages, in the shape this repository sends everything.
 *
 * The system message is the instruction plus the list; the question is a separate user turn so the
 * prefix is byte-identical across a run, which is what makes the provider's own prefix cache a
 * discount rather than a hope (ADR-195). One prompt, ~180 tokens, paid once per row.
 */
export function buildChartChoicePrompt(
  options: readonly ChartChoiceOption[],
  question: string,
): readonly [string, string] {
  const listed = options.map((option) => `${option.name} — ${option.gloss}`).join('\n');
  return [[...CHART_CHOICE_INSTRUCTION, listed].join('\n'), question];
}

/**
 * Read one name back, or nothing.
 *
 * Strict on purpose. An answer that is a sentence containing a name is an answer this arm did not ask
 * for, and guessing which name a paragraph meant would be this file choosing a mark for the model. The
 * punctuation a chat endpoint adds on its own — quotes, backticks, a trailing full stop, markdown
 * emphasis, a code fence — *is* tolerated, because refusing those would score the endpoint's
 * formatting rather than its choice.
 */
export function parseChartChoice(text: string, options: readonly ChartChoiceOption[]): string | undefined {
  const cleaned = text
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/, '')
    .replace(/^[*_`'"\s]+|[*_`'"\s.]+$/g, '')
    .replace(/\s+/g, ' ');
  const lowered = cleaned.toLowerCase();
  for (const option of options) {
    if (option.name.toLowerCase() === lowered) return option.name;
  }
  return undefined;
}

/**
 * What a decode may spend on one word.
 *
 * A reply that thinks aloud needs room to think; an endpoint that does not declares so and gets a cap
 * that makes a runaway answer cheap. The cap is the arm's, and the arm's is measured: at 96 tokens the
 * corpus answered in one word 1,470 times, and the five replies cut at 32 were cut mid-sentence.
 */
export function chartChoiceBudget(provider: LlmProvider): number | undefined {
  return provider.capabilities?.thinksAloud === true ? undefined : 96;
}

/** What one answer cost, so a caller can meter a feature rather than a subscription. */
export interface ChartAdviceUsage {
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  /** Replies the endpoint cut at the cap, which were read as "named nothing". */
  readonly truncated: number;
}

/**
 * A function `chart` can call, plus the meter a product needs to price it.
 *
 * The callable is the contract (`MarkAdvisor` in `chart`); the fields beside it are this layer's own
 * business. A plain function would have been enough for the package and not for the product: a
 * feature whose cost cannot be read is a feature whose cost is discovered on the invoice.
 */
export interface ChartAdvisor {
  (question: string, options: readonly { readonly name: string; readonly gloss: string }[]): Promise<string | undefined>;
  readonly usage: () => ChartAdviceUsage;
}

/** How to ask: the model is the provider's, everything else is the caller's. */
export interface ChartAdvisorOptions {
  /** Overrides `chartChoiceBudget`; for an endpoint whose cap is not the corpus's. */
  readonly maxTokens?: number;
  /** Sampling temperature. `null` sends none, for an endpoint that refuses the field. */
  readonly temperature?: number | null;
  /** Recorded per call, so a trace can say why a question was asked at all. */
  readonly purpose?: 'select';
}

/**
 * Build the advisor.
 *
 * The three states of a reply are kept apart because they have three repairs: a name (drawn), no name
 * (the table's answer), and a failure (`unavailable` in the decision). This function never throws —
 * a provider that fails on one row must not take the chart down with it — so an error becomes a
 * `undefined` and the counter beside it records that a call was spent. That is the difference between
 * "the model declined" and "the model could not be reached", and a product that conflates them cannot
 * decide whether to ask again.
 */
export function createChartAdvisor(provider: LlmProvider, options: ChartAdvisorOptions = {}): ChartAdvisor {
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedPromptTokens = 0;
  let truncated = 0;
  const maxTokens = options.maxTokens ?? chartChoiceBudget(provider);
  const temperature = options.temperature === undefined ? 0 : options.temperature;
  const purpose = options.purpose ?? 'select';
  const advisor = async (
    question: string,
    list: readonly { readonly name: string; readonly gloss: string }[],
  ): Promise<string | undefined> => {
    const [system, user] = buildChartChoicePrompt(list, question);
    const messages: readonly LlmMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    calls += 1;
    let reply;
    try {
      reply = await provider.complete({
        messages,
        temperature,
        ...(maxTokens === undefined ? {} : { maxTokens }),
        purpose,
      });
    } catch {
      return undefined;
    }
    promptTokens += reply.usage?.promptTokens ?? 0;
    completionTokens += reply.usage?.completionTokens ?? 0;
    cachedPromptTokens += reply.usage?.cachedPromptTokens ?? 0;
    if (reply.finishReason === 'length') {
      truncated += 1;
      return undefined;
    }
    return parseChartChoice(reply.text, list);
  };
  return Object.assign(advisor, {
    usage: (): ChartAdviceUsage => ({ calls, promptTokens, completionTokens, cachedPromptTokens, truncated }),
  });
}
