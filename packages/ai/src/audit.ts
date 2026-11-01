import type { LlmMessage } from './provider.js';

/**
 * The turn that asks the model what its own statement left out.
 *
 * Every other mechanism in this repository reads something the engine said: a refusal, an
 * empty result, a row count the shape guard found implausible. The largest failure class on
 * Mini-Dev says nothing at all — the statement runs, returns rows, and the answer is wrong
 * because a column the question filters on never appears in it (**16.1-18.8pp** of the 496
 * questions, measured by `bench:bird:conditions`). No result-based trigger can see it, so
 * the trigger has to be the question itself: put the statement back in front of the model
 * and ask which of the question's conditions it failed to write.
 *
 * The reply is asked for in a shape a program can read — one `MISSING:` line per omission,
 * `MISSING: none` when there is nothing to report, then one fenced statement. The counting
 * is the measurement: a turn that names nothing and rewrites nothing is a different finding
 * from one that names three, and without the count the arm could only be read as "it cost a
 * call and moved the number a bit".
 *
 * It deliberately does not say "the answer is wrong". The harness does not know that at the
 * time of the call, and a false claim would be the refiner mistake this project already
 * measured on gold statements: an instruction that is wrong for 1.81pp of the questions it
 * fires on. The audit asks a question that is true whenever a question and a statement are
 * both present.
 */
export function buildConditionAuditFeedback(question: string, statement: string): string {
  return [
    'The statement above answers this question:',
    question,
    'Check it against the question before rewriting. Write one line for every condition the question states that the statement does not express — a filter on a column, a join, a group, an order, a DISTINCT, or a set of columns to return. Each line starts with `MISSING: ` and names the column and the value, range or level it was compared with.',
    'If the statement expresses every condition the question states, write `MISSING: none`.',
    'Then write the statement again in one fenced block, as one SELECT: express every condition the question states, and add no condition the question does not state.',
    `The statement being checked: ${statement.length <= 600 ? statement : `${statement.slice(0, 599)}…`}`,
  ].join('\n');
}

/**
 * The two messages the audit call appends.
 *
 * The statement travels as the assistant turn rather than as a quote inside the user turn,
 * because it has to look like the model's own reply for a self-check to be one: rewriting a
 * sentence handed back by the user is a different task.
 */
export function auditMessages(question: string, statement: string, previous: string): LlmMessage[] {
  return [
    { role: 'assistant', content: previous },
    { role: 'user', content: buildConditionAuditFeedback(question, statement) },
  ];
}

/**
 * How many conditions the reply said were missing.
 *
 * A count rather than a list, because the list is the model's and the number is the
 * measurement: `named` is the reach of the mechanism on a case, and reading it as text
 * would make it a string a later report has to parse again. Lines are matched with the
 * prefix only, so a statement that happens to contain the word MISSING inside a fence does
 * not count, and `MISSING: none` — which is the model saying nothing is wrong — counts zero.
 */
export function countNamedConditions(text: string): number {
  let named = 0;
  // A fenced block is the statement, not the audit: a column called `missing_reason` or a
  // comment that begins with the word must not be read as an omission the model reported.
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^\s*MISSING\s*:\s*(.*)$/i.exec(line);
    if (match === null) continue;
    const body = (match[1] ?? '').trim();
    if (body === '' || /^none\b/i.test(body)) continue;
    named += 1;
  }
  return named;
}
