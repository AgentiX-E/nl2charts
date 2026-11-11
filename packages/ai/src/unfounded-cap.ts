/**
 * The row cap a statement did not need, and the two conditions that make removing it safe.
 *
 * A statement that answers a question correctly and then keeps the first three rows is answering a
 * different question: the answer had fourteen. On BIRD's Mini-Dev split, 94 to 105 of every arm's
 * 496 statements carry a top-level `limit`, and the cases where removing it repairs the answer are
 * worth 0.20 to 0.81pp — for an edit that costs no call, no token and no candidate.
 *
 * ## Why it is not "remove every cap"
 *
 * Because that is a negative rule, and it was measured as one. `eval/bird/rewrite.ts` prices the
 * gross form — remove the cap whenever the gold statement does not state one — at **−1.01pp** on the
 * arm with the most caps: it repairs 3 and breaks 8. Eight of those caps are how a model expresses a
 * correct answer, and a rule that removes them turns a credited case into a wrong one. The cap is
 * not the defect; the cap *without a reason* is.
 *
 * Two reasons make a cap load-bearing, and both are readable without the gold, which is what makes
 * this a rule rather than a ceiling:
 *
 * - **The statement ranks its rows.** `order by x desc limit 3` asks for the top three; removing the
 *   cap answers a different question. Read at parenthesis depth zero, so an `order by` inside a
 *   subquery or a window function — which orders *that* scope — is not mistaken for the statement's
 *   own ranking.
 * - **The question asks for a ranked subset.** "What are the top 3 items by price?" is a question a
 *   cap answers, so the cap is not a truncation even when the statement forgot to order it. This is
 *   the only condition here that reads English, so it has an error rate, and the error is
 *   deliberately one-directional: a false positive (a question mentioning "at least three", which
 *   contains `least`) makes the rule decline to fire and costs a repair it could have made. A false
 *   negative would let it fire on a question that wanted a ranking, which is the only way it can
 *   cost a credited case.
 *
 * A third condition is a property of the cap rather than of the question: it must be a plain
 * positive integer with no `offset`. `limit 0` is not a truncation — it is how a statement asks for
 * a result's columns and none of its rows — and an `offset` is a second positional claim on the same
 * unordered relation, so removing one of the two would be a rewrite rather than a repair. On the
 * corpus this was priced on, the condition removes nothing and the two conditions above remove two
 * cases per arm; together they turn a −1.01pp rule into a +0.40pp one.
 *
 * ## What it does not do
 *
 * It does not reason about why the cap is there. A statement with no ordering and a question that
 * names no rank has no *expressible* reason for keeping the first k rows of an unordered relation,
 * and that is the whole licence: an unordered relation has no first k rows, so the cap cannot be
 * saying anything the question asked for. It says nothing about a statement whose cap is followed by
 * a clause this module does not read as a boundary, and it declines rather than guessing.
 */
import { clauseAt } from './null-order.js';

/**
 * Words that make a question ask for a ranked subset of the rows that match.
 *
 * Every entry names a rank. Two near-misses are deliberately absent: "at least" and "at most"
 * contain `least` and `most`, and a rule that read them as rankings would decline to fire on a large
 * class of filter questions. That is the safe direction to be wrong in — it costs repairs the rule
 * could have made and cannot cost a case the judge already credited.
 */
const RANKING = /\b(?:top|first|last|earliest|latest|most|least|fewest|largest|smallest|highest|lowest|biggest|best|worst|maximum|minimum|oldest|newest|only)\b/i;

/** Words that end a `limit` clause at depth zero. `offset` is a boundary this module refuses on. */
const CAP_BOUNDARY = ['offset', 'union', 'except', 'intersect', 'returning'] as const;

export interface UnfoundedCap {
  /** The statement with its cap removed. */
  readonly sql: string;
  /** The cap as the statement wrote it, so a caller can say what it dropped. */
  readonly cap: string;
}

/**
 * Whether the question asks for a ranked subset rather than for every row that matches.
 *
 * Exported because it is the one input to this module that is not a statement, and a predicate over
 * English is where a rule that looks free becomes a rule that costs a case.
 */
export function asksForRanking(question: string): boolean {
  return RANKING.test(question);
}

/**
 * The statement without the row cap it cannot justify, or `undefined` when it can.
 *
 * The order of the tests is the order of their cost: the syntactic ones first, because they settle
 * most statements without reading the question, and the question last.
 */
export function stripUnfoundedCap(sql: string, question: string): UnfoundedCap | undefined {
  const limitEnd = clauseAt(sql, 'limit');
  if (limitEnd === undefined) return undefined;
  const limitStart = limitEnd - 'limit'.length;
  // A ranking is what a cap is for. The clause is read at depth zero, so `order by` inside a
  // subquery or a window frame — which orders that scope rather than the answer — does not count.
  if (clauseAt(sql, 'order by') !== undefined) return undefined;
  const boundary = boundaryAfter(sql, limitEnd);
  if (boundary?.word === 'offset') return undefined;
  const cap = sql.slice(limitEnd, boundary === undefined ? undefined : boundary.start).trim().replace(/;+$/, '').trim();
  if (!/^[0-9]+$/.test(cap) || Number(cap) === 0) return undefined;
  if (asksForRanking(question)) return undefined;
  const head = sql.slice(0, limitStart).replace(/\s+$/, '');
  const tail = boundary === undefined ? terminatorOf(sql, limitEnd) : sql.slice(boundary.start);
  // The cap is removed rather than replaced, so the statement's own spacing and casing survive it:
  // a diff with one reason in it is a diff a reviewer can read. The one space this adds is the one
  // the cap's own leading whitespace used to be — without it `… from items` and `union …` would be
  // spliced into `… from itemsunion …`, which is not a statement. The first version of this line did
  // exactly that, and the test that reads a `union` after a cap is what caught it.
  const joined = tail === '' || tail.startsWith(';') ? `${head}${tail}` : `${head} ${tail}`;
  return { sql: joined, cap };
}

/** Where the first clause that ends a cap starts, and which word it is. */
function boundaryAfter(sql: string, from: number): { readonly word: (typeof CAP_BOUNDARY)[number]; readonly start: number } | undefined {
  let best: { word: (typeof CAP_BOUNDARY)[number]; start: number } | undefined;
  for (const word of CAP_BOUNDARY) {
    const end = clauseAt(sql, word, from);
    if (end === undefined) continue;
    const start = end - word.length;
    if (best === undefined || start < best.start) best = { word, start };
  }
  return best;
}

/**
 * The statement's terminator, kept exactly as the statement wrote it.
 *
 * A cap that runs to the end of the statement takes its trailing whitespace with it — the clause it
 * replaced was the end, and leaving the indentation behind would be a diff about whitespace — while
 * the `;` is the statement's rather than the clause's and stays. Text between the cap and the
 * terminator is a cap this module could not read, and it has already declined by then.
 */
function terminatorOf(sql: string, from: number): string {
  const rest = sql.slice(from);
  const at = rest.indexOf(';');
  return at < 0 ? '' : rest.slice(at).trimEnd();
}
