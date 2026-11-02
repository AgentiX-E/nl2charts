import type { LlmProvider } from './provider.js';
import { turnTemperature } from './provider.js';

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
  /**
   * The 1-based number of the earliest candidate that returned exactly the same rows.
   *
   * Absent when this candidate's result is unique. The caller computes it, because equality
   * of two result sets is the benchmark's judge and not this package's — and because a
   * selector told "these two agree" is a different experiment from one left to infer it from
   * two truncated previews, which is what it has to do today.
   *
   * An empty result is the one case where the mark is true and uninformative: `resultKey` maps
   * every empty result to the same symbol, so two candidates that both returned nothing are
   * marked as agreeing. The row count beside the mark says so, and on BIRD an empty result is
   * wrong on every question — the arms that drop empties before asking never produce the mark,
   * and the arms that keep them are telling the truth about two candidates that agree.
   */
  readonly agreesWith?: number;
}

/**
 * How many distinct result sets the candidates produced, given their agreement marks.
 *
 * Each candidate reduces to its representative — itself when it is unique, the earlier
 * candidate it matches otherwise — and the representatives are the distinct results. The
 * mark is defined to point at the *earliest* member of a group, which is what makes that
 * reduction a partition rather than a chain: a mark that pointed at a middle member would
 * split one group into two here and report more distinct results than there are.
 */
function distinctResults(candidates: readonly Candidate[]): number {
  const representatives = candidates.map((candidate, index) => candidate.agreesWith ?? index + 1);
  return new Set(representatives).size;
}

/** True when any candidate carries an agreement mark, i.e. when the prompt should say so. */
function marksAgreement(candidates: readonly Candidate[]): boolean {
  return candidates.some((candidate) => candidate.agreesWith !== undefined);
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

/**
 * The rule a marked candidate set adds, and the whole of the arbitration hypothesis.
 *
 * Two candidates that returned identical rows are one opinion counted twice when they come
 * from the same prompt, and one opinion counted twice *plus* a second author's agreement when
 * they do not — and the selector cannot tell which, because the rows it is shown are truncated
 * previews. Saying so changes the question from "which of these three looks right" to "is the
 * agreement here evidence", which is the distinction the 2+1 pool turned on: on `select-cross`,
 * 20 of the 22 questions the second model added to the ceiling had the correct answer in the
 * dissenting slot, and the two agreeing candidates were both wrong.
 */
const AGREEMENT_RULE =
  '- Candidates marked as returning the same result are not independent opinions: they may share one mistake. Agreement is evidence, not proof — when the question asks for something the agreeing candidates do not provide, the dissenting candidate is the answer.';

/**
 * One candidate, as the selector reads it: statement, shape, first rows, agreement.
 *
 * `label` is required rather than optional. It was optional, and no caller omitted it — every
 * prompt this file builds numbers its candidates, because a reply has to name one — so the
 * unnamed arm of the ternary was code no input could reach.
 */
function renderCandidate(candidate: Candidate, label: string): string {
  const tag = candidate.source === undefined ? '' : `[${candidate.source}] `;
  const head = `${label}. ${tag}${candidate.sql}`;
  return [
    head,
    `   result: ${String(candidate.rows)} rows, ${String(candidate.columns)} columns`,
    candidate.preview.length === 0 ? '' : `   first rows: ${candidate.preview}`,
    candidate.agreesWith === undefined ? '' : `   same result as candidate ${String(candidate.agreesWith)}`,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

export interface SelectionPromptOptions {
  /**
   * Ask for the deliberation the model was chosen for, and read the answer from the last line.
   *
   * A reasoning model that is told "nothing else" either ignores the instruction — and writes
   * prose the strict reader rejects, which the harness records as "the selector did not answer"
   * — or obeys it and drops the reasoning that is the only reason to pay for this model. The
   * two failure modes point in opposite directions and have the same cause: one instruction
   * written for a model that answers in one token.
   */
  readonly reasoning?: boolean;
}

export function buildSelectionPrompt(
  question: string,
  candidates: readonly Candidate[],
  options: SelectionPromptOptions = {},
): string {
  // The agreement block is opt-in and its absence is byte-identical to the prompt every arm
  // before this one was measured with: a caller that does not compute marks gets the prompt it
  // has always had, so the delta between marked and unmarked is the marks and nothing else.
  const marked = marksAgreement(candidates);
  return [
    'You choose which candidate statement answers the question. Every candidate has already been executed.',
    ...(marked
      ? [`These ${String(candidates.length)} candidates returned ${String(distinctResults(candidates))} distinct results; identical results are marked.`]
      : []),
    'Rules:',
    ...RULES,
    '- If two candidates are equivalent, choose the one whose rows are more consistent with the question.',
    ...(marked ? [AGREEMENT_RULE] : []),
    // The default is byte-identical to the instruction every published reading was taken with.
    // The reasoning branch is a different instruction, not a longer one: it asks for the work
    // and fixes where the answer has to end, so the reader can still be strict about the answer.
    options.reasoning === true
      ? 'Think about which candidate answers the question, then write the number of your choice alone on the final line.'
      : 'Answer with the number of the chosen candidate and nothing else.',
    '',
    `Question: ${question}`,
    'Candidates:',
    candidates.map((candidate, index) => renderCandidate(candidate, String(index + 1))).join('\n'),
  ].join('\n');
}

/**
 * The label a reply may put in front of its choice, as one alternative.
 *
 * Every word here was observed in a real reply from a model this repository has not been
 * benchmarked on: the selector prompt asks for a number, and a model that answers
 * "Option 2" has followed the instruction as it read it. The list is closed on purpose —
 * an open prefix would eventually accept "the second option", and deciding which ordinal
 * word means which candidate is a parser for English, not for an index.
 */
const CHOICE_LABEL = '(?:candidates?|options?|choices?|answers?|selections?|picks?|index)';

/**
 * A reply that is nothing but a decorated choice — markdown emphasis, a label, a full stop.
 *
 * The shape is what stays strict: the whole reply has to reduce to the label and the number.
 * "The answer is 2 because..." and "SELECT ... LIMIT 2" both still fail, which is the
 * property the caller depends on, because a model that ignored the instruction must not be
 * counted as a model that chose.
 */
const CHOICE_ONLY = new RegExp(`^(?:${CHOICE_LABEL}\\s*[:#.\\-–—]?\\s*)?(\\d{1,2})$`, 'i');

/**
 * The number a reply names as its choice, or null when it names none.
 *
 * Split out from `parseSelection` because a format profile wants to know whether a reply is
 * a bare choice at all, and that is a property of the text — it does not need, and must not
 * invent, the size of a candidate list to say so.
 */
export function parseChoiceToken(text: string): number | null {
  const cleaned = text.trim().replace(/^[*_`#\s]+|[*_`#\s.]+$/g, '');
  const match = CHOICE_ONLY.exec(cleaned);
  return match === null ? null : Number(match[1]);
}

/**
 * Read the chosen index back.
 *
 * Returns `-1` rather than a default when the reply carries no usable index: the
 * caller decides what an unreadable answer means, and a silent fallback to candidate 1
 * would make "the selector agreed" and "the selector did not answer" the same number.
 */
export function parseSelection(text: string, count: number, options: SelectionPromptOptions = {}): number {
  // Decoration is tolerated, prose is not: see `CHOICE_ONLY`. Widening the decoration is
  // how a model nobody has benchmarked yet gets read correctly on its first day; it does
  // not move the measured arms, where the selector already answered in 495 of 496 cases.
  const token = options.reasoning === true ? parseReasonedChoice(text) : parseChoiceToken(text);
  if (token === null) return -1;
  const index = token - 1;
  if (!Number.isInteger(index) || index < 0 || index >= count) return -1;
  return index;
}

/**
 * Apply a selector's answer to the candidate list.
 *
 * `decided: false` is a fact worth reporting: it counts how often the selector failed
 * to answer, which is the difference between a null result and a broken prompt.
 */
/**
 * The number a reasoning model names, read from the end of its reply.
 *
 * Strict first: a reply that is nothing but a choice is read exactly as before, so a model that
 * follows the instruction is not treated differently from one that needed the looser branch.
 * Only when the whole reply is not a choice does the reader look at the final line, which is
 * where a reply written under the reasoning instruction puts its answer. Prose in the middle is
 * still not a choice: a reply whose last line is not a number returns null, which the caller
 * reports as undecided rather than counting as a vote.
 */
export function parseReasonedChoice(text: string): number | null {
  const strict = parseChoiceToken(text);
  if (strict !== null) return strict;
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  return last === undefined ? null : parseChoiceToken(last);
}

export function applySelection(
  text: string,
  candidates: readonly Candidate[],
  options: SelectionPromptOptions = {},
): SelectionDecision {
  const index = parseSelection(text, candidates.length, options);
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
 *
 * `temperature` is the deployment's, passed through rather than fixed at zero: this call
 * goes to the same endpoint as the statement, so a model that refuses to be told a value
 * refuses this one too, and a selector that failed on a 400 would take down an arm whose
 * statements were all fine.
 */
export async function chooseCandidate(
  provider: LlmProvider,
  question: string,
  executed: readonly ExecutedCandidate[],
  temperature?: number | null,
): Promise<SelectionDecision & { readonly sql: string }> {
  if (executed.length === 0) throw new Error('chooseCandidate needs at least one executed candidate');
  if (executed.length === 1) return { index: 0, decided: true, sql: (executed[0] as ExecutedCandidate).sql };
  const offered = executed.map((candidate) => toCandidate(candidate));
  // What this endpoint can do decides the instruction and the reader, not the caller: a
  // deployment that swaps the selector's backbone should not also have to remember to swap the
  // format contract, and a selector that answered in prose would be reported as undecided.
  const reasoning = provider.capabilities?.thinksAloud === true;
  const reply = await provider.complete({
    messages: [
      { role: 'system', content: buildSelectionPrompt(question, offered, { reasoning }) },
      { role: 'user', content: question },
    ],
    temperature: turnTemperature(temperature),
    purpose: 'select',
  });
  const decision = applySelection(reply.text, offered, { reasoning });
  return { ...decision, sql: (offered[decision.index] as Candidate).sql };
}

/**
 * Compare two candidates instead of ranking many.
 *
 * `temperature` behaves as in `chooseCandidate`: absent means zero, `null` means the field is
 * not sent.
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
  temperature?: number | null,
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
      temperature: turnTemperature(temperature),
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

/**
 * One group of candidates that returned the same rows, as a reconciler reads it.
 *
 * `members` are the 1-based numbers of the candidates in the group, in the order the model was
 * shown them; `sql` is the statement of the earliest member, because a group's identity is its
 * result and any member of it produced that result. `rows` and `columns` describe the shared
 * result, and `preview` is the same truncated JSON the selector sees.
 */
export interface ResultGroup {
  readonly members: readonly number[];
  readonly sql: string;
  readonly rows: number;
  readonly columns: number;
  readonly preview: string;
}

/**
 * Partition executed candidates into the distinct results they returned.
 *
 * The partition is read off the agreement marks, so it is exactly the grouping the marked
 * selector prompt states in prose: each candidate reduces to its representative — itself when it
 * is unique, the earlier candidate it matches otherwise — and one group is built per
 * representative. Computing it here rather than in the caller keeps the two readings of the same
 * fact (the marks in a prompt, the groups in a reconcile prompt) from drifting apart.
 */
export function resultGroups(candidates: readonly Candidate[]): ResultGroup[] {
  const groups = new Map<number, { members: number[]; first: number }>();
  for (const [index, candidate] of candidates.entries()) {
    const representative = candidate.agreesWith ?? index + 1;
    const existing = groups.get(representative);
    if (existing === undefined) groups.set(representative, { members: [index + 1], first: index });
    else existing.members.push(index + 1);
  }
  // Ordered by the representative's own slot, which is the order the model read them in.
  return [...groups.entries()]
    .sort((left, right) => left[1].first - right[1].first)
    .map(([, group]) => {
      const candidate = candidates[group.first] as Candidate;
      return { members: group.members, sql: candidate.sql, rows: candidate.rows, columns: candidate.columns, preview: candidate.preview };
    });
}

/**
 * Reconcile instead of choose: read the results, then write the statement to run.
 *
 * This is the lever the two readings pointed at. A selector asked "which of these three" answers
 * with an index, and an index cannot express the answer to a question whose three candidates each
 * got part of it right — the modal result is worth one call less and the model's choice is worth
 * the same as counting, measured twice on the heterogeneous pool (+0.17pp, −0.17pp). The
 * information the model was missing was never the deliberation, it was the *grouping*: two
 * candidates that returned identical rows are one opinion, and the arm that said so (+1.17pp,
 * +0.33pp) is the only one that has paid in both runs.
 *
 * So this prompt hands over the grouping and asks for a statement rather than a number. The
 * output format is the whole experiment: a reply that is a group's statement unchanged is a
 * selector with a longer prompt, and the caller counts it as such (`novel` in the funnel).
 *
 * The deliberation is asked for even when the model is a chat model, because the reasoning is
 * what ties a group's result to the question; the answer is still read from the final fenced
 * block, so a model that ignores the instruction and answers with a statement is not penalised
 * for it.
 */
export function buildReconcilePrompt(question: string, groups: readonly ResultGroup[]): string {
  const total = groups.reduce((count, group) => count + group.members.length, 0);
  return [
    'Several statements were written for the same question and executed. They returned the results grouped below; statements in one group returned identical rows.',
    `These ${String(total)} statements produced ${String(groups.length)} distinct result${groups.length === 1 ? '' : 's'}.`,
    'Your job is not to pick one of them. Write the statement that answers the question.',
    'Rules:',
    '- Say what each group\'s result shows and whether it answers the question, one line per group.',
    ...RULES,
    '- Then write the statement to run. It may be a group\'s statement unchanged, or a correction that keeps what one group got right and fixes what another got wrong.',
    '- The statement must run against the schema the question was written for: no invented tables or columns.',
    'Answer with the statement alone, in a single ```sql block on the final line.',
    '',
    `Question: ${question}`,
    'Groups:',
    groups
      .map((group, index) => {
        const label = group.members.length === 1 ? `statement ${String(group.members[0])}` : `statements ${group.members.join(', ')}`;
        return [
          `${String(index + 1)}. ${label} — ${String(group.rows)} rows, ${String(group.columns)} columns`,
          `   ${group.sql}`,
          group.preview.length === 0 ? '' : `   first rows: ${group.preview}`,
        ]
          .filter((line) => line.length > 0)
          .join('\n');
      })
      .join('\n'),
  ].join('\n');
}
