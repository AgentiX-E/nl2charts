/**
 * Divide and conquer: the pieces are written as statements, then composed.
 *
 * This is not `plan`. A plan is written *before* the statement and carried into the
 * prompt, and it measured -7.2pp (63/27, p=0.0002) — the ordered plan anchored the
 * statement it was meant to prepare. This is the other shape: the model writes the
 * pieces as executable statements, one line each, and only then composes them. The
 * pieces are where a multi-hop question is decided — which rows the first hop selects,
 * which key the second joins on — and composing them afterwards makes the composition
 * visible instead of leaving it implicit in one draft.
 *
 * It costs no extra call. The decomposition is inside the reply, not a second round
 * trip, so a candidate from this prompt is priced like any other candidate and the
 * comparison is prompt against prompt rather than prompt-plus-budget against prompt.
 *
 * The format is load-bearing: the final statement is the last block, and the steps are
 * not fenced, because a fenced step would be taken for the answer by a reader that stops
 * at the first block. `parseDecomposed` takes the last block for that reason.
 */
export const DECOMPOSE_RULES: readonly string[] = [
  'Work in two parts. Part 1: split the question into the smallest sub-questions where each is answered by one statement, at most four, and write that statement for each — one line per step, exactly `STEP <n>: <statement>`. The steps are working notes: they are not executed on their own and need not answer the question alone.',
  'Part 2: write the one statement that answers the original question, in a single ```sql block, and make it the last thing in your reply.',
  'Every step and the final statement must use column names and value spellings that appear in the schema and evidence above, so the steps and the answer agree.',
];

/**
 * A step line, allowing the decoration models put around a label — list markers, bold,
 * a heading hash — and either case. Everything before `STEP` is punctuation; a column
 * named `step` is not at the start of a line.
 */
const STEP_LINE = /^[\s>*_#-]*STEP\s*\d+\s*:/gim;

/** How many steps a reply wrote. Zero means the model ignored the format. */
export function countSteps(text: string): number {
  return [...text.matchAll(STEP_LINE)].length;
}

/**
 * The statement, taken from the last block rather than the first.
 *
 * A reply that follows the format has its steps as plain lines and its answer in one
 * fence, so the first block would also do. A reply that fences each step does not, and
 * the first block would then be step one — a statement that is executable, plausible and
 * answers a different question, which is the failure mode that costs accuracy without
 * leaving a trace. Taking the last block is correct for both shapes and wrong for
 * neither.
 */
export function parseDecomposed(text: string): { sql: string; steps: number } {
  const blocks = [...text.matchAll(/```(?:sql)?\s*([\s\S]*?)```/gi)]
    .map((match) => (match[1] ?? '').trim())
    .filter((block) => block.length > 0);
  const steps = countSteps(text);
  const last = blocks.length > 0 ? (blocks[blocks.length - 1] as string) : afterMarker(text);
  return { sql: (last ?? text).replace(/^(?:final|sql|answer)\s*:\s*/i, '').trim(), steps };
}

/** The text after a `FINAL:` or `ANSWER:` marker, when the reply used no fence at all. */
function afterMarker(text: string): string | undefined {
  const marked = /\b(?:FINAL|ANSWER)\s*:?\s*([\s\S]+)$/i.exec(text);
  return marked?.[1]?.trim();
}
