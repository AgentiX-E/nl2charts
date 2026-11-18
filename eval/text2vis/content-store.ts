/**
 * A directory of answers keyed by the exact request that produced them.
 *
 * Two instruments in this repository are expensive and deterministic: the vision judge, which reads a
 * rendered figure and returns two integers, and the chart arm, which reads a question and returns one
 * word. Both were re-asked in full on every round, including the rows whose input had not changed
 * since the round before — a round that edits eleven tables paid for the other 1,400.
 *
 * The store below is the one implementation both use. It is here rather than inside either of them
 * because the cache key *is* the correctness argument, and two copies of it would be two definitions
 * of "the same request" that could drift apart while both kept passing their own tests.
 *
 * ## Why the key is what it is
 *
 * A cache is only as honest as its key. Every input that can change an answer is in it:
 *
 * | input | what goes wrong without it |
 * | --- | --- |
 * | the messages, byte for byte | a re-rendered figure is answered with the old figure's opinion |
 * | the pictures' bytes | two figures with one caption are one row in a cache that hashes only text |
 * | the model | a grader swap is an instrument swap, and a floor is relative to the instrument |
 * | the decode mode | the `--think` A/B reads the same figures twice, and would read one answer twice |
 * | the output cap | a reply cut at 1,024 tokens is a different answer from one that finished |
 * | the temperature | a sample is not a reading, and a cached sample is a fabricated one |
 *
 * The three absences are spelled out (`unstated`, `null`) rather than passed through `??`: a request
 * that did not name a mode and a request that named `false` are two different requests, and a key
 * that folded them together would make an A/B unreadable.
 *
 * The *record type's version* is an argument rather than a constant, and it is the first thing in the
 * material. A prompt is text and its text is already hashed, but a prompt assembled from a template
 * that changed *meaning* without changing bytes — a renamed variable, a reordered block, a list that
 * gained a member — is a prompt whose text no longer identifies it. Each record type owns a number it
 * bumps by hand in the commit that changes such a prompt, and because the number is in the key a bump
 * is a clean miss rather than a store full of entries every reader then has to refuse.
 *
 * ## Why SHA-256 and not the fixture hash
 *
 * `replay.ts` identifies a request by an FNV-1a hash of the payload, and says in its own comment that
 * it must never be used for a cache key on disk. This is that disk: 1,418 pictures in one store is a
 * birthday-problem population, and the cost of a collision is not a cache miss but one figure
 * silently graded with another's opinion.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmMessage } from '@agentix-e/nl2charts-ai';

export interface CacheIdentity {
  readonly messages: readonly LlmMessage[];
  readonly model: string;
  readonly thinking: boolean | undefined;
  readonly maxTokens: number | undefined;
  readonly temperature: number | null;
}

/** Everything that can change the answer, as one hex string, under one record type's version. */
export function cacheKey(identity: CacheIdentity, version: number): string {
  const sections = identity.messages.map((message) => {
    const pictures = (message.images ?? []).map((image) => createHash('sha256').update(image.data).digest('hex'));
    return [message.content, ...pictures].join('\u0000');
  });
  const material = JSON.stringify([
    version,
    sections,
    identity.model,
    identity.thinking === undefined ? 'unstated' : identity.thinking,
    identity.maxTokens ?? null,
    identity.temperature === null ? 'unstated' : identity.temperature,
  ]);
  return createHash('sha256').update(material).digest('hex');
}

/** What a reader may demand of an entry before trusting it. */
export interface StoreExpectation {
  /** The model that wrote the entry. A copied store is the only way this can differ; it still must. */
  readonly model: string;
}

export interface ContentStore<T> {
  /** The entry for this key, or `undefined` when there is none or it cannot be trusted. */
  get(key: string, expect?: StoreExpectation): T | undefined;
  /** Keeps an entry. One that already exists is left alone. */
  put(key: string, value: T): void;
  /** Entries answered from the store. */
  readonly hits: number;
  /**
   * Entries that cost a call, which is every row that is not a hit.
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

/** The two directories a key can land in, so one directory holds a few hundred files and not a million. */
const shardOf = (key: string): string => key.slice(0, 2);

/**
 * Open (or create) a store under `directory`.
 *
 * `version` is written into every entry and checked by `read`, which is the record type's own reader.
 * The reader is given the caller's expectation for the reason the judge needs one: a store copied
 * between two cache directories answers a key with an entry another model wrote, and rounding that
 * into a mean would be this file choosing a number the model did not write. `read` returns `undefined`
 * for anything it will not stand behind — a truncated write, a half-finished copy, a hand edit — and
 * the caller is charged a call for it rather than served it.
 */
export function openStore<T>(
  directory: string,
  version: number,
  read: (parsed: unknown, expect: StoreExpectation | undefined) => T | undefined,
): ContentStore<T> {
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
      const entry = read(parsed, expect);
      if (entry === undefined) {
        corrupt += 1;
        misses += 1;
        return undefined;
      }
      hits += 1;
      return entry;
    },
    put(key, value) {
      const shard = join(directory, shardOf(key));
      const path = join(shard, `${key}.json`);
      // Append-only: two workers can hold the same key, and the first answer is as good as the second.
      // Rewriting it would also make the store a place where a later run can change an earlier one's
      // published reading, which is the property an artifact is supposed to have.
      if (existsSync(path)) return;
      mkdirSync(shard, { recursive: true });
      writeFileSync(path, `${JSON.stringify({ version, ...value })}\n`);
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
