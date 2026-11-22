/**
 * Examples written for one database by the model, instead of carried in the prompt.
 *
 * CHASE-SQL's third generator is the one mechanism in its ablation that no other system here
 * reproduces: before answering, it writes question-SQL pairs *for the database in front of it*
 * and answers with those in view. On BIRD dev it reads 68.02% alone against a 57.75% baseline,
 * which is the largest single-path gain in the paper — larger than its divide-and-conquer
 * (65.77) and its query plan (65.51) paths, both of which are procedures every prompt already
 * has room for.
 *
 * The repository registered the instruction to build this three rounds before this file
 * existed, in the falsifier that fired when retrieved examples measured +0.91pp against a
 * +4.0pp bar: *the next mechanism must synthesise the examples with the model rather than
 * retrieve them.* Nothing was dispatched. This module is that sentence, and it is written so
 * the product can ship it: the prompt and the parser are here, next to the template that
 * renders the block, and the harness only adds the cache.
 *
 * Three properties keep it honest, and they are the same three the definition synthesis keeps:
 *
 * - the model sees a schema, never a question from the split and never a gold statement, so an
 *   example cannot be the answer to the question being asked;
 * - the reply is parsed by the same function a customer would run, so what the benchmark
 *   measures is what ships;
 * - the count is fixed by the caller, because the block is paid for on every question and a
 *   generator that returns nine examples when three were asked for is a prompt nobody priced.
 */
import type { SchemaTable } from './linking.js';
import { renderMacSqlCard, renderMacSqlForeignKeys } from './template.js';
import type { SyntheticExample } from './template.js';

/**
 * The instruction that writes the examples.
 *
 * The four rules are the four ways a generated example is useless: it names a value the column
 * does not store (so the example teaches a literal that will not match), it asks something the
 * schema cannot answer (so the statement is invented), it repeats another example (so the block
 * costs tokens and carries no second fact), or it writes more than one statement (so the reader
 * that takes the last fence takes half an answer).
 *
 * The format is stated as a label plus a fence rather than as JSON, because the parser below is
 * the one that ships and a fence is what the rest of this pipeline already reads.
 */
export function buildExamplePrompt(schema: readonly SchemaTable[], count: number): string {
  return [
    `Write ${String(count)} practice questions for the database below, and the SQLite statement that answers each one.`,
    'Rules:',
    '- Each question must be answerable by one statement that reads only the tables and columns below.',
    '- Name the values the question compares in the spelling this schema stores them: a value the column does not hold makes the example useless.',
    '- Each statement must be a single SELECT with no comments, and the questions must ask for different things.',
    '- Do not ask about anything the schema cannot answer, and do not explain anything.',
    'Format: for each pair, one line `Question: <the question>`, then the statement inside a ```sql fence. Nothing else.',
    '',
    '【Database schema】',
    renderMacSqlCard(schema),
    '【Foreign keys】',
    renderMacSqlForeignKeys(schema),
    '',
    `Write the ${String(count)} pairs now:`,
  ].join('\n');
}

/** A `Question:` label, with the decoration a chat model puts around one. */
const HEADER = /^[ \t>*#-]*(?:\*\*)?Question[ \t]*\d*[ \t]*[:.\-][ \t]*(?:\*\*)?[ \t]*(.+)$/gim;

/** The statement in a block of reply text: the last fence, or else the first line that starts one. */
function statementOf(chunk: string): string | undefined {
  const fences = [...chunk.matchAll(/```(?:sql)?\s*([\s\S]*?)```/gi)]
    .map((match) => (match[1] ?? '').trim())
    .filter((block) => block.length > 0);
  if (fences.length > 0) return fences[fences.length - 1];
  // A fence that opened and never closed is a reply that was cut off, and half a statement in the
  // prompt is worse than one example fewer: the block would teach a syntax error. Only a chunk
  // with no fence marker at all falls through to the bare-statement read below.
  if (chunk.includes('```')) return undefined;
  const bare = /^[ \t]*((?:SELECT|WITH)\b[\s\S]*?)(?:\n[ \t]*\n|$)/im.exec(chunk);
  return bare?.[1]?.trim();
}

/** One statement, lowercased and stripped of whitespace runs: the key a duplicate collapses to. */
function keyOf(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The pairs a reply wrote, in the order it wrote them.
 *
 * A pair is kept only when it has a question and a statement that reads like one, and a pair
 * whose statement repeats an earlier one is dropped: the generator is asked for different
 * questions, and when it disobeys the block is a longer prompt carrying the same fact, which is
 * a confound rather than an example. Dropping it here means the arm's prompt is what the model
 * was asked for even when the model did something else.
 */
export function parseExamples(text: string, count: number): SyntheticExample[] {
  const headers = [...text.matchAll(HEADER)];
  const out: SyntheticExample[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < headers.length && out.length < count; index += 1) {
    const header = headers[index] as RegExpExecArray;
    const start = (header.index ?? 0) + header[0].length;
    const end = index + 1 < headers.length ? (headers[index + 1] as RegExpExecArray).index ?? text.length : text.length;
    const question = (header[1] ?? '').trim().replace(/\s+/g, ' ');
    if (question.length === 0) continue;
    const sql = statementOf(text.slice(start, end));
    if (sql === undefined) continue;
    if (!/^(?:SELECT|WITH)\b/i.test(sql)) continue;
    const key = keyOf(sql);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ question, sql });
  }
  return out;
}
