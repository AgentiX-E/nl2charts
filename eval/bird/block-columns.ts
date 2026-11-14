/**
 * Which columns an arm is allowed to print stored values for.
 *
 * The value block is the one lever in this harness whose price is a property of the *set of
 * columns* rather than of the rule that renders them: the sampler, the bracket and the order are
 * identical whether one column carries a bracket or eighty, and `samples-wide` measured that price
 * at +74.9% prompt tokens for +2.02pp on dev (`43579551678`). A block three times the budget cannot
 * ship at any accuracy, so the remaining question is not whether the values are useful but *how few
 * columns can carry them and still buy the gain*.
 *
 * Two rules, and the difference between them is the whole experiment:
 *
 * - `gold` reads the columns a gold statement filters on. It is an oracle, its delta is a ceiling
 *   for the family, and no product can run it. It exists so a realizable rule has a number to be
 *   judged against rather than an intuition.
 * - `link` reads the columns the prompt's own hint names. That hint is already in front of the
 *   model — `buildAskMessages` renders `Likely columns: t.c, …` as the first line of the user
 *   message — so this rule adds the spellings of columns the prompt already points at and nothing
 *   else. It is computable from the question and the schema alone: no gold, no artifact, no fit.
 *
 * The rule is one function because it was two. `run.ts` decides the card a case is answered on and
 * `card.ts` decides the card an instrument prices; both carried their own copy of the `gold` branch,
 * and a second rule added to one of them would have priced a prompt nobody sends — the exact defect
 * `card.ts` documents twice about the block it used to drop entirely.
 */
import { linkSchema } from '@agentix-e/nl2charts-ai';
import type { SchemaTable } from '@agentix-e/nl2charts-ai';
import { conditionColumns } from './conditions.js';
import { attachSamples } from './samples.js';

/**
 * The narrowing rules, and the reason a name is not a list.
 *
 * An arm that carried a per-database allow-list of columns would be fitted on the split it is
 * measured on, and every later reading of that arm would be a reading about the fit. Both members
 * here are functions of the case instead.
 */
export type BlockRule = 'gold' | 'link';

export const BLOCK_RULES: readonly BlockRule[] = ['gold', 'link'];

/**
 * The columns the prompt's own hint names, in the hint's order.
 *
 * `linkSchema` is called with no options on purpose: those are the defaults `buildAskMessages` uses
 * when it renders the hint the model sees, so the block and the hint are the same list read twice
 * rather than two lists that agree today. `test/bird-block-columns` pins that by comparing this
 * function against the rendered hint, including the question whose only match is a stored value.
 *
 * The empty answer is a real one. A question the linker matched nothing in is a question whose
 * block would be shown on no column, and the honest card for it is the parent's: the arm reports the
 * empty count rather than quietly widening to every profiled column, because widening is `samples-wide`
 * and that arm is already in the table.
 */
export function linkBlockColumns(question: string, schema: readonly SchemaTable[]): string[] {
  const columns: string[] = [];
  for (const linked of linkSchema(question, schema)) {
    const name = `${linked.table}.${linked.column}`;
    if (!columns.includes(name)) columns.push(name);
  }
  return columns;
}

/**
 * What a narrowing rule needs: the case, its card, and nothing from the answer.
 *
 * `values` is not decoration. The linker's third recaller matches a question word against a *stored
 * value*, so a hint read on a card without values cannot name the column that holds `pen` — and that
 * is the column the block most has to appear on. The hint the model reads is rendered from the card
 * after the values are attached, so the rule that has to agree with it reads the same card. Omitting
 * it here was the first version's defect: the rule named four columns and the prompt five, and the
 * one it missed was the literal's.
 */
export interface BlockColumnInput {
  readonly rule: BlockRule;
  readonly question: string;
  readonly sql: string;
  readonly schema: readonly SchemaTable[];
  readonly values: ReadonlyMap<string, readonly string[]> | undefined;
}

/**
 * The columns that carry stored values under `rule`.
 *
 * `gold` keeps reading the statement, because that is what makes it an oracle. `link` reads the hint.
 * There is no third branch and no fallback: an unknown rule is refused by the type, and a rule that
 * silently fell back to "everything" would be `samples-wide` reporting another arm's delta.
 */
export function blockColumns(input: BlockColumnInput): readonly string[] {
  if (input.rule === 'gold') return conditionColumns(input.sql);
  const card = input.values === undefined ? input.schema : attachSamples(input.schema, input.values);
  return linkBlockColumns(input.question, card);
}
