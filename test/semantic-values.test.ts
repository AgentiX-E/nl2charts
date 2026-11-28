import { describe, expect, it } from 'vitest';
import {
  createHashEmbeddingProvider,
  type DatabaseProfile,
  type EmbeddingProvider,
} from '@agentix-e/nl2charts-ai';
import {
  buildSemanticIndex,
  emptySemanticIndex,
  renderSemanticValues,
  searchSemanticValues,
  pairValueRetrieval,
} from '../eval/bird/semantic-values.js';

/**
 * A recording provider. It is not a mock of the algorithm — it delegates to the real hash
 * provider — but it captures what the caller asked for, so the contract parts that a hash
 * vector cannot show (purpose, dimension drift, abort, call count) are asserted directly.
 */
function recordingProvider(inner: EmbeddingProvider = createHashEmbeddingProvider()) {
  const purposes: (string | undefined)[] = [];
  const texts: string[][] = [];
  const provider: EmbeddingProvider = {
    id: inner.id,
    model: inner.model,
    dimensions: inner.dimensions,
    async embed(request, options) {
      purposes.push(request.purpose);
      texts.push([...request.texts]);
      return inner.embed(request, options);
    },
  };
  return { provider, purposes, texts };
}

const profile: DatabaseProfile = {
  db: 'card_games',
  columns: [
    { table: 'legalities', column: 'status', kind: 'categorical', values: ['Banned', 'Legal', 'Restricted'] },
    { table: 'sets', column: 'type', kind: 'categorical', values: ['core', 'expansion'] },
    { table: 'cards', column: 'name', kind: 'categorical', values: ['Abundance', 'Ancestor Chosen'] },
    { table: 'cards', column: 'number', kind: 'numeric', min: '1', max: '500' },
  ],
};

describe('buildSemanticIndex (TDD red until the module exists)', () => {
  it('embeds categorical values and column names, but not numeric ranges', async () => {
    const { provider, purposes } = recordingProvider();
    const index = await buildSemanticIndex(profile, provider);
    const texts = index.fields.map((field) => field.text);
    expect(texts).toContain('legalities.status = Banned');
    expect(texts).toContain('sets.type = core');
    expect(texts).toContain('cards.name column');
    // Numeric columns carry no vocabulary a question would name as a literal.
    expect(texts.some((text) => text.includes('number'))).toBe(false);
    // Both build and search tag the purpose, so a meter can file the cost.
    expect(purposes).toEqual(['retrieval-document']);
  });

  it('records the provider identity so a query cannot use a different model space', async () => {
    const provider = createHashEmbeddingProvider({ id: 'hash-a', model: 'm-a', dimensions: 128 });
    const index = await buildSemanticIndex(profile, provider);
    expect(index.providerId).toBe('hash-a');
    expect(index.model).toBe('m-a');
    expect(index.dimensions).toBe(128);
    expect(index.fields.every((field) => field.vector.length === 128)).toBe(true);
  });

  it('deduplicates a value repeated across build calls within one column', async () => {
    const dup: DatabaseProfile = {
      db: 'x',
      columns: [{ table: 't', column: 'c', kind: 'categorical', values: ['Banned', 'Banned'] }],
    };
    const index = await buildSemanticIndex(dup, createHashEmbeddingProvider());
    // One column-name field plus exactly one value field: the repeated "Banned" collapsed.
    expect(index.fields).toHaveLength(2);
    expect(index.fields.filter((field) => field.value !== undefined)).toHaveLength(1);
  });

  it('returns an empty index for a profile with no categorical vocabulary', async () => {
    const { provider, purposes } = recordingProvider();
    const index = await buildSemanticIndex({ db: 'x', columns: [] }, provider);
    expect(index.fields).toEqual([]);
    expect(index.dimensions).toBe(0);
    // No vocabulary means no request should leave at all — do not burn a call on nothing.
    expect(purposes).toEqual([]);
  });

  it('propagates abort instead of returning a partial index', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = createHashEmbeddingProvider();
    await expect(buildSemanticIndex(profile, provider, { signal: controller.signal })).rejects.toThrow();
  });
});

describe('searchSemanticValues', () => {
  async function indexed() {
    return buildSemanticIndex(profile, createHashEmbeddingProvider());
  }

  it('ranks fields by cosine against the question and returns the best hits', async () => {
    const index = await indexed();
    const { provider, purposes } = recordingProvider();
    const hits = await searchSemanticValues(index, 'What is the status banned', provider);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.field.text).toContain('legalities.status');
    expect(hits.every((hit) => hit.score >= 0 && hit.score <= 1)).toBe(true);
    // Scores must be descending.
    for (let i = 1; i < hits.length; i += 1) expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score);
    expect(purposes).toEqual(['retrieval-query']);
  });

  it('respects k and the minimum score floor', async () => {
    const index = await indexed();
    const hits = await searchSemanticValues(index, 'banned legal', createHashEmbeddingProvider(), { k: 2 });
    expect(hits).toHaveLength(2);
    const all = await searchSemanticValues(index, 'banned legal', createHashEmbeddingProvider(), { minScore: 1.01 });
    expect(all).toEqual([]);
  });

  it('keeps at most one hit per column by default, and more when asked', async () => {
    const index = await indexed();
    const one = await searchSemanticValues(index, 'banned legal', createHashEmbeddingProvider(), { k: 10 });
    const cols = one.map((hit) => `${hit.field.table}.${hit.field.column}`);
    expect(new Set(cols).size).toBe(cols.length);
    const many = await searchSemanticValues(index, 'banned legal', createHashEmbeddingProvider(), { k: 10, perColumn: 10 });
    expect(many.length).toBeGreaterThan(one.length);
  });

  it('refuses a query built in a different model space instead of scoring nonsense', async () => {
    const index = await indexed();
    const drifted = createHashEmbeddingProvider({ id: 'hash-b', model: 'm-b', dimensions: 64 });
    await expect(searchSemanticValues(index, 'banned', drifted)).rejects.toThrow(/model|provider|dimension/i);
  });

  it('returns nothing for an empty index, without calling the provider', async () => {
    const { provider, purposes } = recordingProvider();
    const hits = await searchSemanticValues(emptySemanticIndex(), 'anything', provider);
    expect(hits).toEqual([]);
    expect(purposes).toEqual([]);
  });

  it('returns nothing for a question with no usable tokens, without calling the provider', async () => {
    const index = await indexed();
    const { provider, purposes } = recordingProvider();
    const hits = await searchSemanticValues(index, 'the a of and to', provider);
    expect(hits).toEqual([]);
    expect(purposes).toEqual([]);
  });

  it('breaks score ties on field order so the ranking is stable across runs', async () => {
    const index = await indexed();
    const first = await searchSemanticValues(index, 'status', createHashEmbeddingProvider(), { k: 20, perColumn: 20 });
    const second = await searchSemanticValues(index, 'status', createHashEmbeddingProvider(), { k: 20, perColumn: 20 });
    expect(first.map((hit) => hit.field.text)).toEqual(second.map((hit) => hit.field.text));
  });
});

describe('contract guards at the provider boundary', () => {
  /** A custom provider that returns a fixed vector set — a legal EmbeddingProvider, not a stub of the algorithm. */
  function fixedProvider(vectors: readonly (readonly number[])[], id = 'hash-local', model = 'fnv1a-bag-of-words') {
    return {
      id,
      model,
      dimensions: vectors[0]?.length ?? 0,
      async embed() {
        return { vectors, model, dimensions: vectors[0]?.length ?? 0 };
      },
    } as EmbeddingProvider;
  }

  it('tolerates a categorical column with no values array', async () => {
    const noValues: DatabaseProfile = {
      db: 'x',
      columns: [{ table: 't', column: 'c', kind: 'categorical' }],
    };
    const index = await buildSemanticIndex(noValues, createHashEmbeddingProvider());
    expect(index.fields).toHaveLength(1);
    expect(index.fields[0]?.value).toBeUndefined();
  });

  it('refuses a short batch instead of zipping fewer vectors to more texts', async () => {
    const short = fixedProvider([[1, 0, 0]]);
    await expect(buildSemanticIndex(profile, short)).rejects.toThrow(/expected .* vectors, got/);
  });

  it('refuses dimension drift inside one batch', async () => {
    // Ten fields, but the sixth vector has a different length than the declared dimensions.
    const vectors = Array.from({ length: 10 }, () => [1, 0]);
    vectors[5] = [0, 1, 0];
    const drift = fixedProvider(vectors);
    await expect(buildSemanticIndex(profile, drift)).rejects.toThrow(/dimension drift/);
  });

  it('passes a live abort signal through build and search', async () => {
    const controller = new AbortController();
    // Abort after the embed call has started, exercising the signal pass-through branch.
    const late = recordingProvider();
    const provider: EmbeddingProvider = {
      ...late.provider,
      async embed(request, options) {
        controller.abort();
        return createHashEmbeddingProvider().embed(request, options);
      },
    };
    // The hash provider ignores the signal, so build still completes; the pass-through is exercised.
    const index = await buildSemanticIndex(profile, provider, { signal: controller.signal });
    expect(index.fields.length).toBeGreaterThan(0);
  });

  it('refuses a search signal aborted before the query leaves', async () => {
    const index = await buildSemanticIndex(profile, createHashEmbeddingProvider());
    const controller = new AbortController();
    controller.abort();
    await expect(searchSemanticValues(index, 'banned', createHashEmbeddingProvider(), { signal: controller.signal })).rejects.toThrow(/aborted/);
  });

  it('passes a live (non-aborted) signal through to the search provider', async () => {
    const index = await buildSemanticIndex(profile, createHashEmbeddingProvider());
    const controller = new AbortController();
    const hits = await searchSemanticValues(index, 'banned', createHashEmbeddingProvider(), { signal: controller.signal });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('refuses a query vector of the wrong dimension', async () => {
    const index = await buildSemanticIndex(profile, createHashEmbeddingProvider({ dimensions: 256 }));
    const wrongDim = fixedProvider([[1, 0, 0]], 'hash-local', 'fnv1a-bag-of-words');
    await expect(searchSemanticValues(index, 'banned', wrongDim)).rejects.toThrow(/dimension/);
  });
});

describe('pairValueRetrieval', () => {
  const col = (table: string, column: string) => ({ table, column });

  it('reports what the semantic arm gained and lost on the same fields', () => {
    const exact = [col('t', 'a'), col('t', 'b')];
    const semantic = [col('t', 'b'), col('t', 'c')];
    expect(pairValueRetrieval(exact, semantic)).toEqual({
      gained: ['t.c'],
      lost: ['t.a'],
      shared: ['t.b'],
    });
  });

  it('is stable regardless of input order and deduplicates repeated fields', () => {
    const exact = [col('t', 'b'), col('t', 'a'), col('t', 'a')];
    const semantic = [col('t', 'c'), col('t', 'b')];
    expect(pairValueRetrieval(exact, semantic)).toEqual({
      gained: ['t.c'],
      lost: ['t.a'],
      shared: ['t.b'],
    });
  });

  it('gives an empty trade when both arms agree', () => {
    const fields = [col('t', 'a')];
    expect(pairValueRetrieval(fields, fields)).toEqual({ gained: [], lost: [], shared: ['t.a'] });
  });
});

describe('renderSemanticValues', () => {
  it('renders table.column = value lines within a character budget', async () => {
    const index = await buildSemanticIndex(profile, createHashEmbeddingProvider());
    const hits = await searchSemanticValues(index, 'banned', createHashEmbeddingProvider(), { k: 5 });
    const text = renderSemanticValues(hits, 120);
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).toContain('legalities.status');
  });

  it('renders an empty block for no hits', () => {
    expect(renderSemanticValues([])).toBe('');
  });

  it('drops a line that cannot fit the budget rather than emitting a partial one', async () => {
    const index = await buildSemanticIndex(profile, createHashEmbeddingProvider());
    const hits = await searchSemanticValues(index, 'banned', createHashEmbeddingProvider(), { k: 5 });
    expect(renderSemanticValues(hits, 5)).toBe('');
  });
});
