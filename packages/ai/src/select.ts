import type { LlmProvider } from './provider.js';

/** A candidate statement together with the shape of what it returned. */
export interface Candidate {
  readonly sql: string;
  readonly rows: number;
  readonly columns: number;
  /** First few rows, rendered compactly; empty when the result was empty. */
  readonly preview: string;
  /**
   * Which prompt or model wrote this statement, when the caller wants it shown.
   *
   * The selector can only judge what it is told. Candidates that differ by *source* look
   * interchangeable once the label is gone, and a selector that cannot tell a
   * value-grounded statement from a notes-grounded one is choosing on style alone.
   */
  readonly source?: string;
}

export interface SelectionDecision {
  /** 0-based index into the candidate list. */
  readonly index: number;
  /** False when the reply carried no usable index and index 0 was used. */
  readonly decided: boolean;
}

/**
 * Candidate selection: who picks the answer when several samples disagree.
 *
 * Majority voting assumes errors are random, so the mode of the executed result sets
 * converges on the truth. CHASE-SQL measured the opposite for text-to-SQL: their
 * selection agent beats self-consistency by a wide margin, and the gap between the
 * best candidate and the modal one bounds what any selector can win. The reason is
 * visible in this harness's own numbers — three samples agree 90% of the time and
 * gain nothing, because they make the *same* mistake.
 *
 * The selector is the same three samples, read by the model instead of counted. It is
 * the cheap half of CHASE-SQL's design: their selector is a fine-tuned binary
 * classifier over candidate pairs; this one is a prompt that sees each candidate's
 * statement and the shape of its result. No weights, so the comparison stays honest
 * about what a prompt can and cannot buy.
 */
const RULES: readonly string[] = [
  '- Choose by what the question asks, not by which statement looks shortest or most familiar.',
  '- A row count that cannot answer the question is evidence against a candidate: a question asking for one number, one row, or one list is not answered by hundreds of rows, and a question asking for a list is not answered by a single number.',
  '- A candidate that groups or filters on a column the question never mentions is suspect unless the question implies it.',
];

/** One candidate, as the selector reads it: statement, shape, first rows. */
function renderCandidate(candidate: Candidate, label?: string): string {
  const tag = candidate.source === undefined ? '' : `[${candidate.source}] `;
  const head = label === undefined ? `${tag}${candidate.sql}` : `${label}. ${tag}${candidate.sql}`;
  return [
    head,
    `   result: ${String(candidate.rows)} rows, ${String(candidate.columns)} columns`,
    candidate.preview.length === 0 ? '' : `   first rows: ${candidate.preview}`,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

export function buildSelectionPrompt(question: string, candidates: readonly Candidate[]): string {
  return [
    'You choose which candidate statement answers the question. Every candidate has already been executed.',
    'Rules:',
    ...RULES,
    '- If two candidates are equivalent, choose the one whose rows are more consistent with the question.',
    'Answer with the number of the chosen candidate and nothing else.',
    '',
    `Question: ${question}`,
    'Candidates:',
    candidates.map((candidate, index) => renderCandidate(candidate, String(index + 1))).join('\n'),
  ].join('\n');
}

/**
 * Read the chosen index back.
 *
 * Returns `-1` rather than a default when the reply carries no usable index: the
 * caller decides what an unreadable answer means, and a silent fallback to candidate 1
 * would make "the selector agreed" and "the selector did not answer" the same number.
 */
export function parseSelection(text: string, count: number): number {
  // Deliberately strict. "The answer is 2 because..." and "SELECT ... LIMIT 2" both
  // contain a number, and reading that number as a choice would make a model that
  // ignored the instruction look like a model that chose. Prose fails to parse, and
  // the caller reports it instead of guessing.
  const cleaned = text
    .trim()
    .replace(/^[*_`\s]+|[*_`\s.]+$/g, '');
  const match = /^(?:candidates?\s*[:#-]?\s*)?(\d{1,2})$/i.exec(cleaned);
  if (match === null) return -1;
  const index = Number(match[1]) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= count) return -1;
  return index;
}

/**
 * Apply a selector's answer to the candidate list.
 *
 * `decided: false` is a fact worth reporting: it counts how often the selector failed
 * to answer, which is the difference between a null result and a broken prompt.
 */
export function applySelection(
  text: string,
  candidates: readonly Candidate[],
): SelectionDecision {
  const index = parseSelection(text, candidates.length);
  return { index: index === -1 ? 0 : index, decided: index !== -1 };
}

/** A candidate statement with the rows it produced. */
export interface ExecutedCandidate {
  readonly sql: string;
  readonly rows: readonly (readonly unknown[])[];
}

/** Collapse a result into the shape a selector can read without a table dump. */
export function toCandidate(executed: ExecutedCandidate, previewRows = 3, maxChars = 300): Candidate {
  return {
    sql: executed.sql,
    rows: executed.rows.length,
    columns: executed.rows[0]?.length ?? 0,
    preview: JSON.stringify(executed.rows.slice(0, previewRows)).slice(0, maxChars),
  };
}

/**
 * Ask the model which candidate answers the question.
 *
 * This is the benchmark's `select` arm as a library function: it takes candidates
 * that have already been executed and returns the one the model chose, with `decided`
 * false when the reply carried no usable index. Callers decide what an undecided
 * answer means — the pipeline's own default is to keep the first candidate, which is
 * what a single-sample run would have returned anyway.
 */
export async function chooseCandidate(
  provider: LlmProvider,
  question: string,
  executed: readonly ExecutedCandidate[],
): Promise<SelectionDecision & { readonly sql: string }> {
  if (executed.length === 0) throw new Error('chooseCandidate needs at least one executed candidate');
  if (executed.length === 1) return { index: 0, decided: true, sql: (executed[0] as ExecutedCandidate).sql };
  const offered = executed.map((candidate) => toCandidate(candidate));
  const reply = await provider.complete({
    messages: [
      { role: 'system', content: buildSelectionPrompt(question, offered) },
      { role: 'user', content: question },
    ],
    temperature: 0,
    purpose: 'select',
  });
  const decision = applySelection(reply.text, offered);
  return { ...decision, sql: (offered[decision.index] as Candidate).sql };
}

/**
 * Compare two candidates instead of ranking many.
 *
 * The absolute-index prompt asks the model to hold every candidate in mind and emit one
 * number, and on this harness it kept 94.8% of what the candidate set contained — the
 * remaining 5pp were candidates that were present and not chosen. CHASE-SQL's selector
 * is a *binary* comparison for this reason: two statements in view, one of two answers,
 * no index to anchor on. This is that shape, as a prompt, so the comparison stays a
 * comparison of mechanisms rather than of weights.
 */
export function buildPairwisePrompt(question: string, left: Candidate, right: Candidate): string {
  return [
    'Two statements were written for the same question and both were executed.',
    'Which one answers the question?',
    'Rules:',
    ...RULES,
    '- If both would be judged correct, answer 1.',
    'Answer with 1 or 2 and nothing else.',
    '',
    `Question: ${question}`,
    renderCandidate(left, '1'),
    renderCandidate(right, '2'),
  ].join('\n');
}

/** Read a pairwise answer back: 0 or 1, or -1 when the reply carries neither. */
export function parsePairwise(text: string): number {
  const cleaned = text.trim().replace(/^[*_`\s]+|[*_`\s.]+$/g, '');
  const match = /^(?:candidates?\s*[:#-]?\s*)?([12])$/i.exec(cleaned);
  return match === null ? -1 : Number(match[1]) - 1;
}

/**
 * Choose by knockout: the incumbent meets each challenger in turn.
 *
 * Order matters no more than it does in a single-elimination bracket, and the count is
 * exact: `k - 1` calls for `k` candidates, which is what makes the price of a comparison
 * predictable rather than "one more call".
 *
 * An unreadable reply keeps the incumbent. That is the same conservative reading the
 * absolute selector takes, and it is reported: `decided` counts the comparisons that
 * produced no answer, so a broken pairwise prompt cannot hide behind a plausible result.
 */
export async function chooseCandidatePairwise(
  provider: LlmProvider,
  question: string,
  executed: readonly ExecutedCandidate[],
): Promise<SelectionDecision & { readonly sql: string }> {
  if (executed.length === 0) throw new Error('chooseCandidatePairwise needs at least one executed candidate');
  const offered = executed.map((candidate) => toCandidate(candidate));
  let best = 0;
  let decided = true;
  for (let challenger = 1; challenger < offered.length; challenger += 1) {
    const reply = await provider.complete({
      messages: [
        { role: 'system', content: buildPairwisePrompt(question, offered[best] as Candidate, offered[challenger] as Candidate) },
        { role: 'user', content: question },
      ],
      temperature: 0,
      purpose: 'compare',
    });
    const choice = parsePairwise(reply.text);
    if (choice === -1) {
      decided = false;
      continue;
    }
    if (choice === 1) best = challenger;
  }
  return { index: best, decided, sql: (offered[best] as Candidate).sql };
}
