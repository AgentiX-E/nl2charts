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
 * What the control turn says.
 *
 * It carries no information about the previous result, so a pair of arms that differ
 * only in this message separates "the model learned something" from "the model rolled
 * the dice again". Both arms spend the same call on the same cases.
 */
export const EMPTY_BLIND_MESSAGE = 'Write the statement for this question again.';

/** The messages appended after an empty result, in one place so both modes match. */
export function emptyRetryMessages(mode: 'diagnosed' | 'blind', statement: string, previous: string): LlmMessage[] {
  return [
    { role: 'assistant', content: previous },
    { role: 'user', content: mode === 'diagnosed' ? buildEmptyResultFeedback(statement) : EMPTY_BLIND_MESSAGE },
  ];
}

/** The ceiling the repair turns already live under, mirrored so both are capped. */
const FEEDBACK_LIMIT = 900;

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
