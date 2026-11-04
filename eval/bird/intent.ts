import { INTENT_FUNCTIONS, compileIntent } from '@agentix-e/nl2charts-core/semantic';
import type { IntentRefusal } from '@agentix-e/nl2charts-core/semantic';

/**
 * The fourth candidate, written as a query instead of as a statement.
 *
 * Every other source in this harness asks for text and gets text: a statement that may join the
 * wrong column, forget a condition, name a function SQLite does not have, or spell a literal in a
 * case the store does not use. `renderIntent` removes that class by construction, and this module
 * is the wiring half — one rule appended to the prompt a parent arm already sends, and one reader
 * that turns a reply into a statement or into a name for why it could not.
 *
 * The rule is *appended to the rules block* rather than composed into a prompt of its own, for the
 * same reason the guard calls the production renderer: a second prompt builder would be a second
 * thing to keep in agreement with the card, and the failure mode of two prompt builders is not a
 * red test — it is a run that measured a prompt nobody sent.
 *
 * What a refusal means depends on which one it is, and the split is the point of this file. A
 * reader-level failure (`no-object`, `not-json`) is a model that did not follow the format, which
 * is a prompt problem. A grammar-level failure (`unsupported-function`, `bad-identifier`,
 * `missing-from`) is a model that answered the question in a vocabulary the renderer does not
 * have, which is a *grammar* decision — and the histogram of those over a split is the ordered
 * list of what to add next. Neither is an exception, and neither may be counted as zero.
 */

/**
 * The one rule that changes the answer's shape.
 *
 * Written as an example rather than as a schema on purpose: a model reproduces a shape it can see
 * far more reliably than it assembles one from a description, and the example is the cheapest
 * possible version of the contract — one line, every key once. The function list is stated because
 * a name outside it is refused rather than rendered, so a model that reaches for `json_extract`
 * loses a candidate to a rule it could have read.
 */
/** The function list as the prompt spells it. One string, derived once, compared in a test. */
export const INTENT_RULE_FUNCTIONS = INTENT_FUNCTIONS.join(', ');

export const INTENT_RULE = [  'Instead of a statement, reply with one JSON object describing the query:',
  '{"from":"table","alias":"t","joins":[{"table":"u","alias":"u","on":[{"left":"t.a","right":"u.b"}]}],"select":[{"expr":"count(*)","alias":"n"}],"where":[{"column":"t.c","op":"=","value":"x"}],"groupBy":["t.c"],"having":[{"column":"n","op":">","value":1}],"orderBy":[{"expr":"n","direction":"desc"}],"limit":10}',
  // The list is generated from the compiler's own set rather than typed twice: a prompt that
  // promises `median` and a renderer that refuses it would spend candidates on a rule the model
  // could have read, and the disagreement would be invisible in every number the run prints.
  `Only \`from\` and \`select\` are required. Every condition the question states is one \`where\` entry with its column, its operator and its value; an expression may use columns, numbers, 'string literals', + - * / ||, comparisons, CASE WHEN ... THEN ... ELSE ... END, parentheses and these functions: ${INTENT_RULE_FUNCTIONS}. Reply with the object and nothing else.`,
].join(' ');

/**
 * Why a reply did not become a statement.
 *
 * The three reader reasons are separate from the compiler's because they are fixed by a different
 * change: `no-object` is an instruction the model ignored, `not-json` is a nearly-right object, and
 * a grammar refusal is a vocabulary gap. Merging them would make the only actionable number — how
 * often the *grammar* was the reason — invisible.
 */
export type IntentReadReason = 'no-object' | 'not-json' | IntentRefusal;

export type IntentRead = { readonly ok: true; readonly sql: string } | { readonly ok: false; readonly reason: IntentReadReason; readonly detail: string };

/**
 * The first balanced `{...}` in a reply.
 *
 * Brace counting rather than a regular expression, because the reply is allowed to be prose and
 * the object is allowed to contain braces inside its string literals — and a value with a `}` in
 * it is not exotic here: dates, JSON columns and `strftime` formats all carry one. A regex that
 * matched to the last `}` would also swallow a second object, and the compiler would then refuse a
 * reply that was merely verbose.
 */
export function intentPayload(text: string): string | undefined {
  const fenced = [...text.matchAll(/```[A-Za-z]*\s*\n?([\s\S]*?)```/g)].map((match) => match[1] as string);
  for (const candidate of [...fenced, text]) {
    const start = candidate.indexOf('{');
    if (start === -1) continue;
    const balanced = balancedObject(candidate, start);
    if (balanced !== undefined) return balanced;
  }
  return undefined;
}

function balancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index] as string;
    if (inString) {
      if (character === '\\') index += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/**
 * A reply, read as a query and rendered, or refused with a name.
 *
 * Never throws: a candidate that cannot be read is a candidate that never arrived, which the
 * harness already counts (`candidateFailures.unparsed`) and which must not take the case with it.
 */
export function readIntentReply(text: string): IntentRead {
  const payload = intentPayload(text);
  if (payload === undefined) return { ok: false, reason: 'no-object', detail: 'reply carried no json object' };
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch (error) {
    // `JSON.parse` throws a `SyntaxError` and nothing else, so the message is the whole detail a
    // reader can act on; a defensive `instanceof` here would be a branch no reply can reach.
    return { ok: false, reason: 'not-json', detail: (error as Error).message };
  }
  const compiled = compileIntent(value);
  return compiled.ok ? { ok: true, sql: compiled.sql } : { ok: false, reason: compiled.reason, detail: compiled.detail };
}

/** One case's reading, kept in the artifact so the funnel can be rebuilt without the run. */
export interface IntentRecord {
  readonly read: 'ok' | IntentReadReason;
  /** The rendered statement, on the cases that produced one. */
  readonly sql?: string;
  /**
   * The sentence the refusal came with, clipped.
   *
   * The histogram says *which* construct is missing; this says which expression. The first probe
   * refused 10 of 40 replies and the names alone could not distinguish "the grammar has no `case`"
   * from "the model wrote a function we do not have" — two findings with two different fixes. The
   * clip is the artifact's, not the reader's: a refusal detail quotes the reply, and a reply can be
   * long.
   */
  readonly detail?: string;
}

export interface IntentFunnel {
  /** Replies the arm asked for, which is the denominator every other number is a share of. */
  readonly asked: number;
  readonly rendered: number;
  /** Share of replies that became a statement, which is the format's conversion rate. */
  readonly share: number;
  /** Refusals by name, most frequent first. Empty when every reply rendered. */
  readonly refused: Readonly<Record<string, number>>;
}

/**
 * The funnel, from records rather than from guesses.
 *
 * `share` is the number the prompt is judged on and `refused` is the number the grammar is judged
 * on. A run whose refusals are almost all `no-object` needs a clearer instruction and a wider
 * grammar would buy nothing; the opposite reading needs the reverse. That is why both are printed
 * and why neither is folded into the score.
 */
export function intentFunnel(records: readonly IntentRecord[]): IntentFunnel {
  const refused: Record<string, number> = {};
  let rendered = 0;
  for (const record of records) {
    if (record.read === 'ok') rendered += 1;
    else refused[record.read] = (refused[record.read] ?? 0) + 1;
  }
  const ordered = Object.fromEntries(Object.entries(refused).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
  return { asked: records.length, rendered, share: records.length === 0 ? 0 : rendered / records.length, refused: ordered };
}
