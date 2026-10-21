/**
 * One question, one statement of what it computes.
 *
 * Three attempts to write knowledge once per database measured as noise; the
 * only block that moves accuracy is the sentence BIRD writes per *question*.
 * This stage is the product's version of that sentence: the model is shown the
 * question and the column semantics, and asked to state — before writing any SQL
 * — which measure it will use, over which rows, and what the denominator is.
 *
 * The statement is then part of the SQL prompt, so the SQL call reads an
 * explicit reading of the question instead of inferring one. It costs one extra
 * call per question, which is the price of the only thing that has measured.
 */
import { renderSchemaCard } from './linking.js';
import type { SchemaTable } from './linking.js';

const INSTRUCTION = [
  'You restate what a question computes, before any SQL is written.',
  'Use the column semantics shown. Do not write SQL and do not name tables in a query.',
  'State, in at most two lines: the measure and how it is computed, which rows are counted, and — when the question asks for a ratio, share or percentage — the numerator and denominator explicitly.',
  'If a term is ambiguous, choose the reading the column semantics support and say which one you chose.',
].join('\n');

export function buildInterpretationPrompt(question: string, schema: readonly SchemaTable[]): string {
  return [
    INSTRUCTION,
    '',
    'Schema:',
    renderSchemaCard(schema, 400, { descriptions: true, foreignKeys: true, samples: false }),
    '',
    `Question: ${question}`,
  ].join('\n');
}

/**
 * Reduce the reply to a statement the SQL prompt can carry. A model that answers
 * with SQL, a plan, or six paragraphs has not done the task; keeping two lines
 * bounds both the cost and the damage.
 */
export function parseInterpretation(reply: string, maxChars = 300): string {
  const inside = /```[a-z]*\s*([\s\S]*?)```/i.exec(reply)?.[1] ?? reply;
  const lines: string[] = [];
  for (const raw of inside.split('\n')) {
    const line = raw
      .trim()
      .replace(/^[-*•]\s*/, '')
      .replace(/^interpretation\s*:\s*/i, '')
      .trim();
    if (line.length === 0) continue;
    if (/\b(select|insert|update|delete|drop|create|alter)\b/i.test(line)) return '';
    lines.push(line);
    if (lines.length === 2) break;
  }
  if (lines.length === 0) return '';
  return lines.join('\n').slice(0, maxChars);
}
