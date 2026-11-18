import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheKey, openCache, type CacheIdentity } from '../eval/text2vis/judge-cache.js';
import type { LlmImage } from '@agentix-e/nl2charts-ai';

const SYSTEM = 'You grade one chart.';
const image = (data: string): LlmImage => ({ mediaType: 'image/png', data });

function identity(overrides: Partial<CacheIdentity> = {}): CacheIdentity {
  return {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'Question: who leads?\nGrade the chart.', images: [image('AAAA')] },
    ],
    model: 'glm-4.5v',
    thinking: undefined,
    maxTokens: 4096,
    temperature: 0,
    ...overrides,
  };
}

function temporary(): string {
  return mkdtempSync(join(tmpdir(), 'judge-cache-'));
}

describe('the key of a call, which is every input that can change the answer', () => {
  it('is stable for the same request, so a second reading of the same figure costs nothing', () => {
    expect(cacheKey(identity())).toBe(cacheKey(identity()));
    // 64 hex characters: a disk key, so it may not rely on a 32-bit fixture hash.
    expect(cacheKey(identity())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the picture changes, which is the whole point of keying on bytes', () => {
    const other = {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'Question: who leads?\nGrade the chart.', images: [image('BBBB')] },
      ],
    } satisfies Partial<CacheIdentity>;
    expect(cacheKey(identity(other))).not.toBe(cacheKey(identity()));
  });

  it('changes when the question changes, because the same figure answers two questions differently', () => {
    const other = {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'Question: who trails?\nGrade the chart.', images: [image('AAAA')] },
      ],
    } satisfies Partial<CacheIdentity>;
    expect(cacheKey(identity(other))).not.toBe(cacheKey(identity()));
  });

  it('changes with the decode mode, which is the defect this cache could otherwise introduce', () => {
    // The A/B reads the *same* figures in two modes. A key that ignored the mode would answer the
    // `--think off` arm out of the `--think on` arm's store, and the experiment would report two
    // identical means with zero calls spent — a perfect result and a fabricated one.
    const on = cacheKey(identity({ thinking: true }));
    const off = cacheKey(identity({ thinking: false }));
    const unstated = cacheKey(identity({ thinking: undefined }));
    expect(new Set([on, off, unstated]).size).toBe(3);
  });

  it('changes with the model, because a swap of grader is a swap of instrument', () => {
    expect(cacheKey(identity({ model: 'glm-4.5v' }))).not.toBe(cacheKey(identity({ model: 'glm-4.6v' })));
  });

  it('changes with the output cap, because a reply cut at 1,024 is a different answer', () => {
    expect(cacheKey(identity({ maxTokens: 4096 }))).not.toBe(cacheKey(identity({ maxTokens: 1024 })));
  });

  it('changes with the temperature, because a sample is not a reading', () => {
    expect(cacheKey(identity({ temperature: 0 }))).not.toBe(cacheKey(identity({ temperature: 0.7 })));
    expect(cacheKey(identity({ temperature: 0 }))).not.toBe(cacheKey(identity({ temperature: null })));
  });
});

describe('the store on disk', () => {
  it('round-trips a reading and counts the hit', () => {
    const directory = temporary();
    try {
      const cache = openCache(directory);
      const key = cacheKey(identity());
      expect(cache.get(key)).toBeUndefined();
      cache.put(key, { chart_correctness: 7, readability: 8, reply: '{"chart_correctness":7,"readability":8}' });
      expect(cache.get(key)).toEqual({
        chart_correctness: 7,
        readability: 8,
        reply: '{"chart_correctness":7,"readability":8}',
      });
      expect(cache.hits).toBe(1);
      expect(cache.misses).toBe(1);
      // A second reader of the same directory sees it too: the store is the filesystem, not ram.
      expect(openCache(directory).get(key)?.chart_correctness).toBe(7);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the usage of the call it replaced, so the avoided bill is measured and not estimated', () => {
    const directory = temporary();
    try {
      const cache = openCache(directory);
      const key = cacheKey(identity());
      cache.put(key, {
        chart_correctness: 4,
        readability: 5,
        reply: '{}',
        usage: { promptTokens: 828, completionTokens: 975, reasoningTokens: 958 },
      });
      const cache2 = openCache(directory);
      expect(cache2.get(key)?.usage).toEqual({
        promptTokens: 828,
        completionTokens: 975,
        reasoningTokens: 958,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('treats a damaged entry as a miss, because a corrupt cache must cost a call and not a score', () => {
    const directory = temporary();
    try {
      const key = cacheKey(identity());
      const shard = join(directory, key.slice(0, 2));
      mkdirSync(shard, { recursive: true });
      writeFileSync(join(shard, `${key}.json`), '{ this is not json');
      const cache = openCache(directory);
      expect(cache.get(key)).toBeUndefined();
      expect(cache.misses).toBe(1);
      expect(cache.corrupt).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses an entry another model wrote, which a copied store is the only way to produce', () => {
    const directory = temporary();
    try {
      const key = cacheKey(identity());
      const shard = join(directory, key.slice(0, 2));
      mkdirSync(shard, { recursive: true });
      // The key already separates models, so this entry is only reachable by copying a store from a
      // directory keyed on another one — and serving it would score a figure with the other grader's
      // opinion under this one's name.
      writeFileSync(
        join(shard, `${key}.json`),
        JSON.stringify({ version: 1, chart_correctness: 5, readability: 5, reply: '{}', model: 'glm-4.6v' }),
      );
      const cache = openCache(directory);
      expect(cache.get(key, { model: 'glm-4.5v' })).toBeUndefined();
      expect(cache.corrupt).toBe(1);
      // The same entry is served when the expectation names the model that wrote it.
      expect(openCache(directory).get(key, { model: 'glm-4.6v' })?.chart_correctness).toBe(5);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('treats an entry whose reply is not text as a miss', () => {
    const directory = temporary();
    try {
      const key = cacheKey(identity());
      const shard = join(directory, key.slice(0, 2));
      mkdirSync(shard, { recursive: true });
      // The reply is the only part of an entry a document quotes; a number there is a record this
      // reader will not serve, and serving it would put a non-string into a transcript.
      writeFileSync(join(shard, `${key}.json`), JSON.stringify({ version: 1, chart_correctness: 5, readability: 5, reply: 7 }));
      const cache = openCache(directory);
      expect(cache.get(key)).toBeUndefined();
      expect(cache.corrupt).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('treats a well-formed entry with impossible scores as a miss', () => {
    const directory = temporary();
    try {
      const key = cacheKey(identity());
      const shard = join(directory, key.slice(0, 2));
      mkdirSync(shard, { recursive: true });
      // 11 is off the 0-10 scale the prompt asks for. Rounding it into the histogram would be this
      // file choosing a score the grader did not write, and caching it would make the choice permanent.
      // `version` first: an entry without it is refused by the *version* check, so a fixture that
      // omitted it would pass this test while never reaching the predicate it is about — a green test
      // over an untested line, which is the exact defect a coverage floor exists to expose.
      writeFileSync(
        join(shard, `${key}.json`),
        JSON.stringify({ version: 1, chart_correctness: 11, readability: 5, reply: '{}' }),
      );
      // And the same for the other column: a reader that only ever refused the first score is a reader
      // whose second check was never exercised, which is a test passing over half a predicate.
      const cache = openCache(directory);
      expect(cache.get(key)).toBeUndefined();
      expect(cache.corrupt).toBe(1);
      // The same entry with the *second* column off the scale, written over the first: a reader whose
      // second check never ran is a reader that passes a test over half its predicate.
      writeFileSync(
        join(shard, `${key}.json`),
        JSON.stringify({ version: 1, chart_correctness: 5, readability: 11, reply: '{}' }),
      );
      const second = openCache(directory);
      expect(second.get(key)).toBeUndefined();
      expect(second.corrupt).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses to hand one model the reading another model wrote', () => {
    const directory = temporary();
    try {
      const cache = openCache(directory);
      const key = cacheKey(identity({ model: 'glm-4.5v' }));
      cache.put(key, { chart_correctness: 7, readability: 8, reply: '{}', model: 'glm-4.6v' });
      // The key already separates the models; this is the second lock, for a store that was written
      // by an older key scheme or copied between directories.
      expect(openCache(directory).get(key, { model: 'glm-4.5v' })).toBeUndefined();
      expect(openCache(directory).get(key, { model: 'glm-4.6v' })?.chart_correctness).toBe(7);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not rewrite an entry it already holds, so a shared cache directory stays append-only', () => {
    const directory = temporary();
    try {
      const cache = openCache(directory);
      const key = cacheKey(identity());
      cache.put(key, { chart_correctness: 2, readability: 3, reply: 'first' });
      cache.put(key, { chart_correctness: 9, readability: 9, reply: 'second' });
      expect(openCache(directory).get(key)?.chart_correctness).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports how many entries it holds, so a workflow can tell a warm cache from a cold one', () => {
    const directory = temporary();
    try {
      const cache = openCache(directory);
      expect(cache.size()).toBe(0);
      cache.put(cacheKey(identity()), { chart_correctness: 1, readability: 1, reply: '{}' });
      cache.put(cacheKey(identity({ model: 'glm-4.6v' })), { chart_correctness: 2, readability: 2, reply: '{}' });
      expect(openCache(directory).size()).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('the entries the store refuses, which are the only defence a copied directory has', () => {
  const place = (key: string, body: string): string => {
    const directory = mkdtempSync(join(tmpdir(), 'judge-cache-bad-'));
    const shard = join(directory, key.slice(0, 2));
    mkdirSync(shard, { recursive: true });
    writeFileSync(join(shard, `${key}.json`), body);
    return directory;
  };

  it('refuses an entry written by an older key scheme', () => {
    const key = cacheKey(identity());
    const directory = place(key, JSON.stringify({ version: 0, chart_correctness: 5, readability: 5, reply: '{}' }));
    try {
      // A version mismatch is the one case where the answer may be about a different prompt, so it has
      // to cost a call rather than be re-published under the new prompt's name.
      expect(openCache(directory).get(key)).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a file that is valid json and not an object', () => {
    const key = cacheKey(identity());
    const directory = place(key, 'null');
    try {
      expect(openCache(directory).get(key)).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses an entry whose reply is not the text the grader wrote', () => {
    const key = cacheKey(identity());
    const directory = place(key, JSON.stringify({ version: 1, chart_correctness: 5, readability: 5, reply: 42 }));
    try {
      expect(openCache(directory).get(key)).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('counts answers and not the debris a copied directory carries', () => {
    const directory = temporary();
    try {
      const key = cacheKey(identity());
      const cache = openCache(directory);
      cache.put(key, { chart_correctness: 1, readability: 1, reply: '{}' });
      // `.DS_Store`, an editor swap file, a half-copied tarball: none of them is an answer, and a size
      // that counted them would report a warm cache that is cold.
      writeFileSync(join(directory, 'README'), 'not an answer');
      expect(openCache(directory).size()).toBe(1);
      // And a directory that does not exist yet is empty rather than an error: the first run of a
      // fresh checkout asks this before anything has been written.
      expect(openCache(join(directory, 'never-created')).size()).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
