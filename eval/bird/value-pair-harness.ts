/**
 * Pairing value-retrieval arms against the fields a question's gold SQL actually needs.
 *
 * r215 added `pairValueRetrieval`, which says which `table.column` fields the semantic arm found
 * that the exact arm did not, and vice versa. That is a difference, not a decision: a gained field
 * the gold never needed is noise, and a lost field the gold did need is a real regression. This
 * harness crosses the pair with the gold field set so the difference becomes an auditable,
 * field-level reading — the shape a McNemar test consumes, split into confirmed and spurious.
 *
 * This is a **harness proof, not a priced reading**. The offline semantic arm uses the deterministic
 * hash embedding (a lexical stand-in), so a "gain" here is a structural result about the pairing
 * apparatus, not evidence that semantic retrieval beats exact retrieval on BIRD. No number this
 * module emits may be quoted as a semantic-gain accuracy claim. Pricing stays with `gate:shipment`
 * and needs a real paired dispatch.
 */
import { pairValueRetrieval, type ValueRetrievalPair } from './semantic-values.js';

/** One question's paired retrieval classified against its gold fields. */
export interface PairClassification {
  /** Semantic found, exact missed, gold needs — a candidate real gain. */
  readonly semanticGainedConfirmed: readonly string[];
  /** Semantic found, exact missed, gold does not need — a false positive. */
  readonly semanticGainedSpurious: readonly string[];
  /** Exact found, semantic missed, gold needs — a candidate real loss. */
  readonly semanticLostConfirmed: readonly string[];
  /** Exact found, semantic missed, gold does not need — denoising, not a loss. */
  readonly semanticLostSpurious: readonly string[];
  /** Both found, gold needs. */
  readonly bothCorrect: readonly string[];
  /** Both found, gold does not need. */
  readonly bothWrong: readonly string[];
}

/** Split one bucket into the part gold needs and the part it does not, both stable and deduped. */
function splitByGold(keys: readonly string[], gold: ReadonlySet<string>): { need: readonly string[]; spurious: readonly string[] } {
  const unique = [...new Set(keys)].sort();
  return {
    need: unique.filter((key) => gold.has(key)),
    spurious: unique.filter((key) => !gold.has(key)),
  };
}

/**
 * Classify a paired result against the gold field set.
 *
 * Every bucket is deduplicated and sorted so a reading is byte-for-byte reproducible across runs.
 * The same field can appear in more than one input bucket only if a caller built a malformed pair;
 * each bucket is classified independently, which keeps the function total.
 */
export function classifyPair(pair: ValueRetrievalPair, gold: ReadonlySet<string>): PairClassification {
  const gained = splitByGold(pair.gained, gold);
  const lost = splitByGold(pair.lost, gold);
  const shared = splitByGold(pair.shared, gold);
  return {
    semanticGainedConfirmed: gained.need,
    semanticGainedSpurious: gained.spurious,
    semanticLostConfirmed: lost.need,
    semanticLostSpurious: lost.spurious,
    bothCorrect: shared.need,
    bothWrong: shared.spurious,
  };
}

/** One classified question, with the number of gold fields the question needed. */
export interface PairRow {
  readonly questionId: number;
  /** How many `table.column` fields the gold SQL needed; the denominator for coverage. */
  readonly goldCount: number;
  readonly classification: PairClassification;
}

/** A field as the two arms and the gold SQL carry it: a table and a column name. */
export interface FieldRef {
  readonly table: string;
  readonly column: string;
}

/**
 * Pair two arms and classify them against gold in one step.
 *
 * This is the seam a real-data harness calls: exact fields from `values.ts`, semantic fields from
 * `searchSemanticValues`, gold fields from `referencedFields` on the question's SQL. Gold is keyed
 * by `table.column` exactly as `pairValueRetrieval` keys its pair, and its deduplicated size is the
 * per-question coverage denominator.
 */
export function classifyCase(
  questionId: number,
  exact: readonly FieldRef[],
  semantic: readonly FieldRef[],
  gold: readonly FieldRef[],
): PairRow {
  const key = (field: FieldRef) => `${field.table}.${field.column}`;
  const goldSet = new Set(gold.map(key));
  return {
    questionId,
    goldCount: goldSet.size,
    classification: classifyPair(pairValueRetrieval(exact, semantic), goldSet),
  };
}

/** Aggregate counters over a set of classified questions. */
export interface PairSummary {
  readonly questions: number;
  readonly goldFields: number;
  readonly semanticGainedConfirmed: number;
  readonly semanticGainedSpurious: number;
  readonly semanticLostConfirmed: number;
  readonly semanticLostSpurious: number;
  readonly bothCorrect: number;
  readonly bothWrong: number;
  /** Confirmed semantic gains minus confirmed semantic losses, in fields. */
  readonly confirmedGain: number;
  /** Gold fields the semantic arm found, over gold fields. */
  readonly semanticCoverage: number;
  /** Gold fields the exact arm found, over gold fields. */
  readonly exactCoverage: number;
}

/** Keep a ratio in [0,1]; a malformed pair can list more hits than gold has fields. */
function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.min(1, Math.max(0, numerator / denominator));
}

/**
 * Aggregate classified rows into one summary.
 *
 * Coverage is computed per question from that question's gold count, then summed and divided by
 * the total gold fields — so a question with no gold fields neither divides by zero nor inflates
 * the rate. `confirmedGain` counts fields, never questions: it is the McNemar-style discordance
 * the pricing gate would read, presented here without a p-value because the arm is offline.
 */
export function summarizeClassifications(rows: readonly PairRow[]): PairSummary {
  let goldFields = 0;
  let semanticGainedConfirmed = 0;
  let semanticGainedSpurious = 0;
  let semanticLostConfirmed = 0;
  let semanticLostSpurious = 0;
  let bothCorrect = 0;
  let bothWrong = 0;
  let semanticHits = 0;
  let exactHits = 0;
  for (const row of rows) {
    const c = row.classification;
    const confirmedGained = c.semanticGainedConfirmed.length;
    const confirmedLost = c.semanticLostConfirmed.length;
    const correct = c.bothCorrect.length;
    goldFields += row.goldCount;
    semanticGainedConfirmed += confirmedGained;
    semanticGainedSpurious += c.semanticGainedSpurious.length;
    semanticLostConfirmed += confirmedLost;
    semanticLostSpurious += c.semanticLostSpurious.length;
    bothCorrect += correct;
    bothWrong += c.bothWrong.length;
    semanticHits += correct + confirmedGained;
    exactHits += correct + confirmedLost;
  }
  return {
    questions: rows.length,
    goldFields,
    semanticGainedConfirmed,
    semanticGainedSpurious,
    semanticLostConfirmed,
    semanticLostSpurious,
    bothCorrect,
    bothWrong,
    confirmedGain: semanticGainedConfirmed - semanticLostConfirmed,
    semanticCoverage: ratio(semanticHits, goldFields),
    exactCoverage: ratio(exactHits, goldFields),
  };
}
