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
 * ## Why the key is what it is
 *
 * A cache is only as honest as its key. Six inputs can change the two integers a grader writes,
 * and every one of them is in the key:
 *
 * | input | what goes wrong without it |
 * | --- | --- |
 * | the picture's bytes | a re-rendered figure is answered with the old figure's opinion |
 * | the question and the label | one figure answers two questions differently |
 * | the model | a grader swap is an instrument swap, and the floor is relative to the instrument |
 * | the decode mode | the `--think` A/B reads the same figures twice, and would read one answer twice |
 * | the output cap | a reply cut at 1,024 tokens is a different answer from one that finished |
 * | the temperature | a sample is not a reading, and a cached sample is a fabricated one |
 *
 * `CACHE_VERSION` travels with them so a change to the *prompt* — which is an input this file does
 * not otherwise see — can be made a miss by bumping it. Both the version and the hashed text are in
 * the key rather than one or the other: the version is the author's promise that the prompt changed,
 * and the text is the proof.
 *
 * ## Why the digest is SHA-256 and not the fixture hash
 *
 * `replay.ts` identifies a request by an FNV-1a hash of the payload, and says in its own comment
 * that it must never be used for a cache key on disk. This is that disk: 1,418 pictures in one
 * store is a birthday-problem population, and the cost of a collision is not a cache miss but one
 * figure silently graded with another's opinion.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmMessage, LlmUsage } from '@agentix-e/nl2charts-ai';

/**
 * Bumped when the judge prompt changes.
 *
 * The prompt is not an argument to {@link cacheKey}, so an edit to `JUDGE_SYSTEM` would otherwise
 * keep serving the old prompt's answers — the one way a cache can turn a new reading into a
 * re-publication of the previous one. The text is hashed as well, so a forgotten bump is a miss
 * rather than a silent reuse; the version is kept because it also covers a change to this file's
 * own key scheme, which no text hash can see.
 */
export const CACHE_VERSION = 1;

export interface CacheIdentity {
  readonly messages: readonly LlmMessage[];
  readonly model: string;
  readonly thinking: boolean | undefined;
  readonly maxTokens: number | undefined;
  readonly temperature: number | null;
}

/**
 * Everything that can change the answer, as one hex string.
 *
 * The three absences are spelled out (`unstated`, `null`) rather than passed through `??`: a request
 * that did not name a mode and a request that named `false` are two different requests to this
 * endpoint, and a key that folded them together would make the A/B unreadable.
 */
export function cacheKey(identity: CacheIdentity): string {
  const sections = identity.messages.map((message) => {
    const pictures = (message.images ?? []).map((image) => createHash('sha256').update(image.data).digest('hex'));
    return [message.content, ...pictures].join('\u0000');
  });
  const material = JSON.stringify([
    CACHE_VERSION,
    sections,
    identity.model,
    identity.thinking === undefined ? 'unstated' : identity.thinking,
    identity.maxTokens ?? null,
    identity.temperature === null ? 'unstated' : identity.temperature,
  ]);
  return createHash('sha256').update(material).digest('hex');
}

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

export interface JudgeCache {
  /** The entry for this key, or `undefined` when there is none or it cannot be trusted. */
  get(key: string, expect?: { readonly model: string }): CachedReading | undefined;
  /** Keeps a reading. An entry that already exists is left alone. */
  put(key: string, reading: CachedReading): void;
  /** Rows answered from the store. */
  readonly hits: number;
  /**
   * Rows that cost a call, which is every row that is not a hit.
   *
   * `hits + misses` is the number of rows asked about, so a report can be checked against its own
   * denominator without a third counter. A corrupt entry is counted here as well as in `corrupt`,
   * because it is a row the endpoint will be charged for.
   */
  readonly misses: number;
  /** Entries that were present and unusable: a subset of `misses`, and always a defect. */
  readonly corrupt: number;
  /** How many entries the directory holds. */
  size(): number;
}

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

/** The two directories a key can land in, so one directory holds a few hundred files and not a million. */
const shardOf = (key: string): string => key.slice(0, 2);

export function openCache(directory: string): JudgeCache {
  let hits = 0;
  let misses = 0;
  let corrupt = 0;
  return {
    get hits() {
      return hits;
    },
    get misses() {
      return misses;
    },
    get corrupt() {
      return corrupt;
    },
    get(key, expect) {
      const path = join(directory, shardOf(key), `${key}.json`);
      if (!existsSync(path)) {
        misses += 1;
        return undefined;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        corrupt += 1;
        misses += 1;
        return undefined;
      }
      const reading = readingOf(parsed, expect);
      if (reading === undefined) {
        corrupt += 1;
        misses += 1;
        return undefined;
      }
      hits += 1;
      return reading;
    },
    put(key, reading) {
      const shard = join(directory, shardOf(key));
      const path = join(shard, `${key}.json`);
      // Append-only: two workers can hold the same key, and the first answer is as good as the second.
      // Rewriting it would also make the store a place where a later run can change an earlier one's
      // published reading, which is the property an artifact is supposed to have.
      if (existsSync(path)) return;
      mkdirSync(shard, { recursive: true });
      writeFileSync(path, `${JSON.stringify({ version: CACHE_VERSION, ...reading })}\n`);
    },
    size() {
      if (!existsSync(directory)) return 0;
      let total = 0;
      for (const shard of readdirSync(directory, { withFileTypes: true })) {
        if (!shard.isDirectory()) continue;
        total += readdirSync(join(directory, shard.name)).filter((name) => name.endsWith('.json')).length;
      }
      return total;
    },
  };
}
