import { describe, expect, it } from 'vitest';
import { buildSqlPrompt, createHashEmbeddingProvider, type DatabaseProfile } from '@agentix-e/nl2charts-ai';
import type { ValueMatch } from '../eval/bird/values.js';
import type { SemanticHit } from '../eval/bird/semantic-values.js';
import {
  buildFusedValueBlock,
  fuseValues,
  renderFusedValues,
  type FusedValue,
} from '../eval/bird/fused-values.js';

/**
 * These are hand-written records in the exact shape the two real arms emit. The fusion itself is a
 * pure function of those records, so a hash vector is unnecessary here; the async builder test below
 * runs the real semantic index end to end with a real (deterministic) hash provider.
 */
function lexical(table: string, column: string, value: string): ValueMatch {
  return { table, column, value };
}
function semantic(table: string, column: string, value: string, score: number): SemanticHit {
  return {
    field: { table, column, value, text: `${table}.${column}=${value}`, vector: [] },
    score,
  };
}
const keys = (rows: readonly FusedValue[]): string[] => rows.map((r) => `${r.table}.${r.column}=${r.value}`);

const profile: DatabaseProfile = {
  db: 'card_games',
  columns: [
    { table: 'legalities', column: 'status', kind: 'categorical', values: ['Banned', 'Legal', 'Restricted'] },
    { table: 'cards', column: 'name', kind: 'categorical', values: ['Abundance', 'Ancestor Chosen'] },
  ],
};

describe('fuseValues (TDD red until the module exists)', () => {
  it('keeps lexical hits ahead of semantic hits', () => {
    const out = fuseValues(
      [lexical('legalities', 'status', 'Banned')],
      [semantic('cards', 'name', 'Abundance', 0.9)],
    );
    expect(keys(out)).toEqual(['legalities.status=Banned', 'cards.name=Abundance']);
    expect(out.map((r) => r.source)).toEqual(['lexical', 'semantic']);
  });

  it('deduplicates a value found by both arms, keeping the lexical provenance', () => {
    const out = fuseValues(
      [lexical('legalities', 'status', 'Banned')],
      [semantic('legalities', 'status', 'Banned', 0.95)],
    );
    expect(keys(out)).toEqual(['legalities.status=Banned']);
    expect(out[0]?.source).toBe('lexical');
  });

  it('deduplicates repeated semantic hits on the same field', () => {
    const out = fuseValues(
      [],
      [semantic('cards', 'name', 'Abundance', 0.9), semantic('cards', 'name', 'Abundance', 0.7)],
    );
    expect(keys(out)).toEqual(['cards.name=Abundance']);
  });

  it('orders semantic-only hits by descending score', () => {
    const out = fuseValues(
      [],
      [semantic('cards', 'name', 'Abundance', 0.5), semantic('legalities', 'status', 'Legal', 0.9)],
      { perColumn: 8 },
    );
    expect(keys(out)).toEqual(['legalities.status=Legal', 'cards.name=Abundance']);
  });

  it('caps semantic hits per column so one column cannot fill the block', () => {
    const out = fuseValues(
      [],
      [
        semantic('cards', 'name', 'Abundance', 0.9),
        semantic('cards', 'name', 'Ancestor Chosen', 0.8),
        semantic('legalities', 'status', 'Legal', 0.7),
      ],
      { perColumn: 1 },
    );
    expect(keys(out)).toEqual(['cards.name=Abundance', 'legalities.status=Legal']);
  });

  it('does not apply the per-column cap to lexical hits', () => {
    const out = fuseValues(
      [lexical('cards', 'name', 'Abundance'), lexical('cards', 'name', 'Ancestor Chosen')],
      [],
      { perColumn: 1 },
    );
    expect(keys(out)).toHaveLength(2);
  });

  it('is stable across equal scores by field key', () => {
    const a = fuseValues(
      [],
      [semantic('legalities', 'status', 'Legal', 0.9), semantic('cards', 'name', 'Abundance', 0.9)],
    );
    const b = fuseValues(
      [],
      [semantic('cards', 'name', 'Abundance', 0.9), semantic('legalities', 'status', 'Legal', 0.9)],
    );
    expect(keys(a)).toEqual(keys(b));
  });

  it('deduplicates repeated lexical hits on the same value', () => {
    const out = fuseValues(
      [lexical('legalities', 'status', 'Banned'), lexical('legalities', 'status', 'Banned')],
      [],
    );
    expect(keys(out)).toEqual(['legalities.status=Banned']);
  });

  it('breaks an equal-score tie by field key regardless of input order', () => {
    // Input the lexicographically larger identity first so the sort takes its `> 0` branch.
    const out = fuseValues(
      [],
      [semantic('legalities', 'status', 'Legal', 0.7), semantic('cards', 'name', 'Abundance', 0.7)],
      { perColumn: 8 },
    );
    expect(keys(out)).toEqual(['cards.name=Abundance', 'legalities.status=Legal']);
  });

  it('returns nothing for empty arms', () => {
    expect(fuseValues([], [])).toEqual([]);
  });

  it('drops a semantic hit that carries no stored value', () => {
    const hit: SemanticHit = {
      field: { table: 'cards', column: 'name', text: 'cards.name', vector: [] },
      score: 0.9,
    };
    expect(fuseValues([], [hit])).toEqual([]);
  });
});

describe('renderFusedValues', () => {
  it('emits one heading-free line per value, lexical first', () => {
    const text = renderFusedValues([
      { table: 'legalities', column: 'status', value: 'Banned', source: 'lexical', score: 1 },
      { table: 'cards', column: 'name', value: 'Abundance', source: 'semantic', score: 0.9 },
    ]);
    expect(text).toBe(
      "- legalities.status stores 'Banned'\n- cards.name stores 'Abundance'",
    );
  });

  it('returns an empty string for no values (the prompt owns the heading)', () => {
    expect(renderFusedValues([])).toBe('');
  });

  it('respects the character budget', () => {
    const rows: FusedValue[] = [
      { table: 'legalities', column: 'status', value: 'Banned', source: 'lexical', score: 1 },
      { table: 'cards', column: 'name', value: 'Ancestor Chosen', source: 'semantic', score: 0.9 },
    ];
    expect(renderFusedValues(rows, 5)).toBe('');
  });
});

describe('buildFusedValueBlock (async, real hash provider)', () => {
  it('fuses a real lexical index with a real semantic index without an API call', async () => {
    const provider = createHashEmbeddingProvider();
    // The lexical arm names 'Banned' exactly; 'Abundance' is only reachable by the semantic arm
    // because the question does not contain the word. A hash vector is a deterministic stand-in
    // for the retrieval *wiring*, not a priced semantic-quality reading.
    const block = await buildFusedValueBlock(
      'Which cards are banned',
      profile,
      [lexical('legalities', 'status', 'Banned')],
      provider,
      { k: 8, maxChars: 2000 },
    );
    expect(block.text).toContain("legalities.status stores 'Banned'");
    expect(block.lexicalCount).toBe(1);
    expect(block.fusedCount).toBeGreaterThanOrEqual(1);
  });

  it('produces a block the product prompt can consume verbatim', async () => {
    const block = await buildFusedValueBlock(
      'Which cards are banned',
      profile,
      [lexical('legalities', 'status', 'Banned')],
      createHashEmbeddingProvider(),
    );
    const prompt = buildSqlPrompt('Which cards are banned', [], { values: block.text });
    expect(prompt).toContain('Values in this database named by the question:');
    expect(prompt).toContain("legalities.status stores 'Banned'");
  });

  it('returns an empty block for a question with no retrievable words', async () => {
    const block = await buildFusedValueBlock('the a of and to', profile, [], createHashEmbeddingProvider());
    expect(block.text).toBe('');
    expect(block.fusedCount).toBe(0);
  });

  it('passes an abort signal through to the semantic arm', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildFusedValueBlock('banned', profile, [], createHashEmbeddingProvider(), { signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
  });
});
