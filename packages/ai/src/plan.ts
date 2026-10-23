import type { SchemaTable } from './linking.js';
import { renderSchemaCard } from './linking.js';

/**
 * A query plan, written before the statement.
 *
 * CHASE-SQL's second generator is chain-of-thought over a query *execution plan*: the
 * model reasons about the scan, the joins, the grouping and the final projection in
 * the order an engine would perform them. The point is not extra knowledge — the same
 * schema is visible either way — but that the ordering decisions are made explicitly
 * once instead of being encoded implicitly in one SQL draft.
 *
 * This is a separate lever from `interpret`, which asks what the question *means*.
 * A plan can be right about the meaning and wrong about the join, and the two failures
 * have different fixes, so they are measured apart.
 */
export function buildPlanPrompt(question: string, schema: readonly SchemaTable[]): string {
  return [
    'You plan a SQL query before it is written. Do not write SQL.',
    'Answer in these five labelled lines, in this order, one short phrase each:',
    '- SCAN: the tables that must be read, and why each is needed.',
    '- FILTER: the conditions the question states, with the column each applies to.',
    '- JOIN: how the tables connect, and the direction of each join.',
    '- GROUP: what is grouped or aggregated, if anything.',
    '- ANSWER: the single value, row or list the question expects.',
    'If the question names a value the schema cannot express, say which line is uncertain.',
    '',
    'Schema:',
    renderSchemaCard(schema, 60, { descriptions: true, foreignKeys: true }),
    '',
    `Question: ${question}`,
  ].join('\n');
}

const LABELS = ['SCAN', 'FILTER', 'JOIN', 'GROUP', 'ANSWER'] as const;

/**
 * Keep the plan, drop the prose around it.
 *
 * A model that answers with a paragraph is not wrong, but a prompt block that carries
 * three sentences of preamble per line costs characters that the schema needs. Lines
 * are kept only when they start with a known label, which also drops a plan that
 * ignored the format entirely — an ignored format is not a plan, and passing it on
 * would make the arm look like it ran.
 */
export function parsePlan(text: string, maxChars = 600): string {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/^[\s>*_`-]+/, '').trim())
    .filter((line) => LABELS.some((label) => line.toUpperCase().startsWith(`${label}:`) || line.toUpperCase().startsWith(`${label} :`)));
  if (lines.length === 0) return '';
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept.join('\n');
}
