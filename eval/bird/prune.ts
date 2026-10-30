/**
 * Which tables a question's prompt keeps, when the prompt is the closure instead of the card.
 *
 * The card measurement priced the lever (74.1% of the prompt is the schema card, 58.4% of it
 * belongs to tables the gold statement never reads) and the join measurement said who can pull
 * it (one hop over the declared foreign keys keeps every gold table for 95.2% of cases). This
 * module is the rule that a prompt can actually ship, and it is deliberately smaller than the
 * oracle those numbers were taken with:
 *
 * 1. **The seeds are the linker's own output.** A table is a seed when `linkSchema` names one of
 *    its columns, using the same recallers and the same `topK` the pipeline sends. A second
 *    linker written for pruning would be a second definition of "which table the question is
 *    about", and the first disagreement would be invisible.
 * 2. **A question with no seed keeps the whole card.** The closure has nowhere to start, and a
 *    card built from an empty seed set is a prompt with no schema at all — the one failure mode
 *    that cannot be repaired by wording. Seventy of 496 Mini-Dev questions are in this state
 *    with the shipped recallers, so the fallback is the common case for exactly the questions
 *    the linker already struggles with.
 * 3. **Nothing here consults the gold statement.** The join instrument's `safe` column asks
 *    "would this have kept every table the answer needs", which is a question only an oracle can
 *    answer. A prompt cannot ask it, so the arm that sends the closure is measured on accuracy
 *    instead: the 24 cases whose closure misses a gold table are the price, and the run's job is
 *    to say what that price is.
 */
import { buildAskMessages } from '@agentix-e/nl2charts-ai';
import type { Recaller, SchemaTable } from '@agentix-e/nl2charts-ai';
import { closureOf } from './join-graph.js';
import type { JoinGraph } from './join-graph.js';

/**
 * The recallers the product uses, and the set the join instrument also prices.
 *
 * The second adds `table`, which is what a question that names an entity and none of its columns
 * needs. Both lists live here because the linker is what turns a question into seeds, and the
 * card instrument, the join instrument and the prune rule all read the same two names: a third
 * copy is how the shipped number and the measured number stop being the same number.
 *
 * `table` is not part of the shipped set. Adding a fourth recaller changes the reciprocal-rank
 * fusion, so the columns near the twelve-slot cutoff move — case 1057 keeps `country` under the
 * shipped set and loses it under the candidate one. The two sets are different linkers, not a
 * smaller and a larger one, which is why the prune arm ships the shipped set.
 */
export const SHIPPED_RECALLERS: readonly Recaller[] = ['name', 'alias', 'value'];
export const CANDIDATE_RECALLERS: readonly Recaller[] = ['name', 'alias', 'value', 'table'];

/** The tables the linker names for a question, lower-cased because a card may spell them otherwise. */
export function linkedTables(question: string, schema: readonly SchemaTable[], recallers: readonly Recaller[]): Set<string> {
  const linked = buildAskMessages({ question, schema, linking: true, recallers }).linked;
  return new Set(linked.map((column) => column.table.toLowerCase()));
}

/** Why a card was not pruned, when it was not. */
export const PRUNE_REASONS = ['pruned', 'no-seed'] as const;
export type PruneReason = (typeof PRUNE_REASONS)[number];

export interface PruneInput {
  /** The card as the arm would send it: notes, samples and definitions already applied. */
  readonly schema: readonly SchemaTable[];
  readonly question: string;
  readonly graph: JoinGraph;
  /** Joins to walk from each seed. Zero is "the tables the linker named, and nothing else". */
  readonly hops: number;
  readonly recallers?: readonly Recaller[];
}

export interface PruneOutcome {
  /** The card to send: the closure, or the whole card when the closure has no seed. */
  readonly schema: readonly SchemaTable[];
  /** Tables the linker named. Empty is the fallback, and is reported as one. */
  readonly seeds: readonly string[];
  /** Tables the outcome keeps, in card order. */
  readonly kept: readonly string[];
  readonly reason: PruneReason;
}

/**
 * Keep the tables within `hops` joins of the ones the question names.
 *
 * Table order is the card's own, not the closure's: the renderer's order is part of the prompt
 * the model reads, and re-sorting by discovery would move tables between the pruned and unpruned
 * arms for a reason that has nothing to do with the lever.
 */
export function pruneSchema(input: PruneInput): PruneOutcome {
  const { schema, question, graph, hops } = input;
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(`prune: ${String(hops)} is not a number of joins to walk`);
  }
  const seeds = [...linkedTables(question, schema, input.recallers ?? SHIPPED_RECALLERS)];
  if (seeds.length === 0) return { schema, seeds, kept: [], reason: 'no-seed' };
  const reached = closureOf(graph.adjacency, seeds, hops);
  // The seeds come from this schema, so the closure always keeps at least the table it started
  // from: no "and the card is now empty" branch exists, because the state cannot be reached and a
  // guard for it would be a claim nobody can test (ADR-219).
  const kept = schema.filter((table) => reached.has(table.table.toLowerCase()));
  return { schema: kept, seeds, kept: kept.map((table) => table.table.toLowerCase()), reason: 'pruned' };
}
