import type { LlmMessage } from './provider.js';

/**
 * The turn after a statement ran and returned nothing.
 *
 * A benchmark question asks for an answer, and a statement that returns no rows is not
 * one. On BIRD's dev split that claim is exact rather than statistical: no question in
 * the split has an empty gold result (`emptyGoldExcluded` is 0 in every published
 * report), so a zero-row statement there is wrong by construction. That makes the
 * signal free to read and perfectly precise, which is what separates it from the shape
 * guard — a heuristic over row and column counts that fired 21 times and repaired 2.
 *
 * The message is a diagnosis, not an instruction to "try again": a second statement
 * written from the same prompt would repeat the mistake that produced the first. It
 * names the three causes that produce an empty result on a schema the model has just
 * read, which is the part a model cannot infer from the schema alone.
 */
export function buildEmptyResultFeedback(statement: string): string {
  return clip(
    [
      'That statement ran without error and returned no rows:',
      clip(statement, 300),
      'A statement that returns nothing does not answer the question. The usual causes:',
      "- a literal is not spelled the way the database stores it; compare it against the values the question names;",
      '- a join removed every row because its keys do not compare, or its direction is reversed;',
      '- a condition is stricter than the question asked: an exclusive bound where it said "over", or a filter it never mentions.',
      'Write the statement again so that it answers the question, not merely so that it runs.',
    ].join('\n'),
    // The same ceiling the repair turns live under (`MAX_FEEDBACK` in diagnose.ts). Two
    // kinds of feedback with two budgets would make "the repair is capped" a claim about
    // one of them.
    FEEDBACK_LIMIT,
  );
}

/**
 * One value the statement compares against, and what the column stores instead.
 *
 * This is the part of the empty-result turn that is *evidence* rather than advice. The
 * diagnosed message says "a literal may not be spelled the way the database stores it",
 * which the author of the statement already believed; a gap says which literal, in which
 * column, and what that column holds — facts the model cannot derive from the schema and
 * would otherwise have to guess. `kind` is `case` when the column stores the same value in
 * another case, `partial` when it stores a longer string containing the literal (the
 * `Benalish Knight` / `Benalish Knight (Fellwar Stone)` shape), and `absent` when nothing in
 * the column contains it at all.
 */
export interface ValueGap {
  readonly literal: string;
  readonly column: string;
  readonly kind: 'case' | 'partial' | 'absent';
  readonly values: readonly string[];
}

/** Gaps a message will describe. The rest are counted by the caller, not rendered. */
export const VALUE_GAP_LITERALS = 3;
/** Values quoted per gap. A column with two hundred distinct values is not a hint. */
export const VALUE_GAP_VALUES = 4;
/** Characters a single quoted value may take. */
const VALUE_GAP_VALUE_CHARS = 60;

/**
 * The turn after a statement returned nothing, carrying the values the database does hold.
 *
 * The diagnosed message names three causes and leaves the model to find which one applies.
 * This one applies the first: the literals were looked up, the columns that were searched and
 * the values they store are quoted back, and the instruction narrows to "use these
 * spellings". It is the same call as the diagnosed turn — the difference is what the call
 * carries, which is what makes the pair an experiment about information rather than about
 * cost.
 *
 * `gaps` is empty when the retrieval found nothing to say, and the message then falls back to
 * the diagnosed one: a turn that paid a call must still tell the model what happened, and
 * "we looked and found nothing" is the diagnosed message with one extra sentence of history
 * that a model cannot act on.
 */
export function buildValueGapFeedback(statement: string, gaps: readonly ValueGap[]): string {
  const usable = dedupeGaps(gaps).slice(0, VALUE_GAP_LITERALS);
  if (usable.length === 0) return buildEmptyResultFeedback(statement);
  const lines = usable.map((gap) => {
    const quoted = gap.values.slice(0, VALUE_GAP_VALUES).map((value) => `'${clip(value, VALUE_GAP_VALUE_CHARS)}'`);
    if (gap.kind === 'case') {
      return `- '${clip(gap.literal, VALUE_GAP_VALUE_CHARS)}' is not stored in ${gap.column} in that case; it stores ${quoted.join(', ')}.`;
    }
    if (gap.kind === 'partial') {
      return `- '${clip(gap.literal, VALUE_GAP_VALUE_CHARS)}' is not a value of ${gap.column}; the column holds ${quoted.join(', ')}.`;
    }
    return `- ${gap.column} contains no value with '${clip(gap.literal, VALUE_GAP_VALUE_CHARS)}' in it.`;
  });
  return clip(
    [
      'That statement ran without error and returned no rows:',
      clip(statement, 300),
      'Its values were looked up in the database. This is what the columns actually hold:',
      lines.join('\n'),
      'Write the statement again using only the spellings quoted above, keeping every condition the question asks for and no others.',
    ].join('\n'),
    FEEDBACK_LIMIT,
  );
}

/**
 * One gap per literal and column, in the order the statement wrote them.
 *
 * Two candidates can compare the same literal against the same column, and the retrieval can
 * reach one column through two sites; repeating the line would spend the message budget on a
 * duplicate and make a three-gap message look like a five-gap one. First sighting wins, so
 * the order still describes the statement rather than the lookup.
 */
function dedupeGaps(gaps: readonly ValueGap[]): ValueGap[] {
  const seen = new Set<string>();
  const out: ValueGap[] = [];
  for (const gap of gaps) {
    const key = `${gap.column.toLowerCase()}\u0000${gap.literal}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(gap);
  }
  return out;
}

/**
 * What the control turn says.
 *
 * It carries no information about the previous result, so a pair of arms that differ
 * only in this message separates "the model learned something" from "the model rolled
 * the dice again". Both arms spend the same call on the same cases.
 */
export const EMPTY_BLIND_MESSAGE = 'Write the statement for this question again.';

/**
 * The messages appended after an empty result, in one place so every mode matches.
 *
 * `values` is the arm that retrieved the columns' actual values; it degrades to `diagnosed`
 * when the retrieval came back empty, because an extra call that says nothing at all would be
 * the blind control by accident rather than by design.
 */
export function emptyRetryMessages(
  mode: 'diagnosed' | 'blind' | 'values',
  statement: string,
  previous: string,
  gaps: readonly ValueGap[] = [],
): LlmMessage[] {
  const content =
    mode === 'blind'
      ? EMPTY_BLIND_MESSAGE
      : mode === 'values'
        ? buildValueGapFeedback(statement, gaps)
        : buildEmptyResultFeedback(statement);
  return [
    { role: 'assistant', content: previous },
    { role: 'user', content },
  ];
}

/** The ceiling the repair turns already live under, mirrored so both are capped. */
const FEEDBACK_LIMIT = 900;

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
