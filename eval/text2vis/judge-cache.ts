/**
 * The store that makes a second reading of an unchanged figure cost nothing.
 *
 * ## What this file is for
 *
 * The judge spent twelve full readings in two days, and every one of them re-graded all 1,418
 * figures — including the ~1,280 whose PNG bytes and question had not changed since the reading
 * before. That is the shape of the waste: a round that changes eleven tables pays for the corpus.
 * With a store keyed on the *content* of the request, a reading costs the rows that changed and
 * nothing else, and the same corpus re-read after a prompt edit costs what the prompt edit costs.
 *
 * The key and the store live in `content-store.ts`, because the chart arm needs the same two things
 * for the same reason and two copies of a cache key are two definitions of "the same request". What
 * is left here is the *record*: the two integers a grader writes, and the reader that refuses a
 * record it cannot stand behind.
 */

import type { LlmUsage } from '@agentix-e/nl2charts-ai';
import { cacheKey as keyOf, openStore, type CacheIdentity, type ContentStore } from './content-store.js';

// Re-exported rather than moved out of this module's surface: every caller of the judge asks for the
// identity in the same breath as the key, and a reader looking for "what identifies a reading" should
// not have to know that the answer lives one file away.
export type { CacheIdentity } from './content-store.js';

/**
 * Bumped when the judge prompt changes.
 *
 * The prompt is not visible to the key, whose material is only the rendered request, so an edit to
 * `JUDGE_SYSTEM` that leaves the *question* untouched would otherwise keep serving the old prompt's
 * answers — the one way a cache can turn a new reading into a re-publication of the previous one.
 */
export const CACHE_VERSION = 1;

/** One graded figure, as the store keeps it. */
export interface CachedReading {
  readonly chart_correctness: number;
  readonly readability: number;
  readonly reply: string;
  /** What the call that wrote this entry cost, so the bill it saved is measured rather than guessed. */
  readonly usage?: LlmUsage;
  /** The model that wrote it. The key already separates models; this is the lock a copied store checks. */
  readonly model?: string;
}

export type JudgeCache = ContentStore<CachedReading>;

const isScore = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10;

/**
 * A reading, if the parsed file is one.
 *
 * Every field is checked rather than trusted: a truncated write, a half-finished copy between two
 * cache directories, and a hand edit all arrive here as valid JSON. Rounding a bad score into the
 * histogram would be this file choosing a number the grader did not write, and caching it would
 * make the choice permanent.
 */
function readingOf(parsed: unknown, expect: { readonly model: string } | undefined): CachedReading | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const row = parsed as Record<string, unknown>;
  if (row['version'] !== CACHE_VERSION) return undefined;
  // Both columns before either reader: a row the grader wrote with one score off the scale is a row
  // this store will not serve at all, and each column is asserted by its own case below.
  if (!isScore(row['chart_correctness']) || !isScore(row['readability'])) return undefined;
  if (typeof row['reply'] !== 'string') return undefined;
  if (expect !== undefined && row['model'] !== expect.model) return undefined;
  const usage = row['usage'];
  const kept =
    typeof usage === 'object' && usage !== null && typeof (usage as Record<string, unknown>)['promptTokens'] === 'number'
      ? (usage as LlmUsage)
      : undefined;
  return {
    chart_correctness: row['chart_correctness'],
    readability: row['readability'],
    reply: row['reply'],
    ...(kept === undefined ? {} : { usage: kept }),
    ...(typeof row['model'] === 'string' ? { model: row['model'] } : {}),
  };
}

/** The key for one judge request, bound to this record's version. */
export function cacheKey(identity: CacheIdentity): string {
  return keyOf(identity, CACHE_VERSION);
}

export function openCache(directory: string): JudgeCache {
  return openStore<CachedReading>(directory, CACHE_VERSION, readingOf);
}
