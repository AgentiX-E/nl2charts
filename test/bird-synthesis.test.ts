import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pickSampleTables, synthesisHash, synthesizeDefinitions, synthesizeRecord } from '../eval/bird/synthesize.js';
import type { LlmRequest, LlmResponse, SchemaTable } from '@agentix-e/nl2charts-ai';

/**
 * The cache is the difference between "one call per database" and "one call per
 * run". These tests pin the three ways it can go wrong: a stale entry reused
 * after the schema changed, a corrupt entry failing the run, and a cache write
 * that loses the answer.
 */
const schema: readonly SchemaTable[] = [
  { table: 'a', columns: [{ name: 'a1', type: 'TEXT' }] },
  { table: 'b', columns: [{ name: 'b1', type: 'TEXT' }, { name: 'b2', type: 'TEXT' }, { name: 'b3', type: 'TEXT' }] },
  { table: 'c', columns: [{ name: 'c1', type: 'TEXT' }, { name: 'c2', type: 'TEXT' }] },
];

describe('synthesis cache key', () => {
  it('is stable for the same prompt and model', () => {
    expect(synthesisHash('p', 'm')).toBe(synthesisHash('p', 'm'));
  });

  it('changes when the prompt or the model changes', () => {
    expect(synthesisHash('p', 'm')).not.toBe(synthesisHash('p2', 'm'));
    expect(synthesisHash('p', 'm')).not.toBe(synthesisHash('p', 'm2'));
  });
});

describe('sample table choice', () => {
  it('takes the widest tables first, then alphabetical', () => {
    expect(pickSampleTables(schema, 2).map((table) => table.table)).toEqual(['b', 'c']);
  });

  it('handles a zero or oversized limit', () => {
    expect(pickSampleTables(schema, 0)).toEqual([]);
    expect(pickSampleTables(schema, 10)).toHaveLength(3);
  });
});

describe('synthesis run', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
  });

  const oracleFixture = { async run() { return { ok: true, rows: [['1', 'x']] }; } };

  function counter(reply: string): { provider: { complete(request: LlmRequest): Promise<LlmResponse> }; calls: () => number } {
    let calls = 0;
    return {
      provider: {
        async complete() {
          calls += 1;
          return { text: reply, model: 'fixture', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
        },
      },
      calls: () => calls,
    };
  }

  it('writes the parsed reply and serves the next request from cache', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'nl2charts-synth-'));
    directories.push(cacheDir);
    const { provider, calls } = counter('Here you go:\n- revenue = paid orders only.');
    const request = {
      oracle: oracleFixture as never,
      db: 'shop',
      schema,
      provider: provider as never,
      model: 'test-model',
      sampleTables: 1,
      sampleRows: 1,
      cacheDir,
    };
    const first = await synthesizeDefinitions(request);
    const second = await synthesizeDefinitions(request);
    expect(first).toBe('- revenue = paid orders only.');
    expect(second).toBe(first);
    expect(calls()).toBe(1);
    const cached = JSON.parse(readFileSync(join(cacheDir, 'shop.json'), 'utf8'));
    expect(cached.definitions).toBe(first);
    expect(cached.hash).toHaveLength(16);
    expect(cached.model).toBe('test-model');
  });

  it('says whether the text was written in this run or reused', async () => {
    // Without this flag, "the arm moved 5pp between runs" cannot be split into
    // "the prompt changed" and "the model answered differently".
    const cacheDir = mkdtempSync(join(tmpdir(), 'nl2charts-synth-'));
    directories.push(cacheDir);
    const { provider, calls } = counter('- a = b.');
    const request = {
      oracle: oracleFixture as never,
      db: 'shop',
      schema,
      provider: provider as never,
      model: 'test-model',
      sampleTables: 1,
      sampleRows: 1,
      cacheDir,
    };
    const first = await synthesizeRecord(request);
    const second = await synthesizeRecord(request);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.hash).toBe(first.hash);
    expect(second.definitions).toBe(first.definitions);
    expect(calls()).toBe(1);
  });

  it('changes the hash exactly when the input changes', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'nl2charts-synth-'));
    directories.push(cacheDir);
    const { provider, calls } = counter('- a = b.');
    const base = {
      oracle: oracleFixture as never,
      db: 'shop',
      schema,
      provider: provider as never,
      model: 'test-model',
      sampleTables: 1,
      sampleRows: 1,
      cacheDir,
    };
    const same = await synthesizeRecord(base);
    const otherModel = await synthesizeRecord({ ...base, model: 'other-model' });
    expect(otherModel.hash).not.toBe(same.hash);
    expect(otherModel.cached).toBe(false);
    expect(calls()).toBe(2);
  });

  it('re-asks when the model or the schema changes instead of reusing the cache', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'nl2charts-synth-'));
    directories.push(cacheDir);
    const { provider, calls } = counter('- a = b.');
    const base = {
      oracle: oracleFixture as never,
      db: 'shop',
      schema,
      provider: provider as never,
      sampleTables: 1,
      sampleRows: 1,
      cacheDir,
    };
    await synthesizeDefinitions({ ...base, model: 'm1' });
    await synthesizeDefinitions({ ...base, model: 'm2' });
    await synthesizeDefinitions({ ...base, model: 'm2', schema: [{ table: 'z', columns: [{ name: 'z1', type: 'TEXT' }] }] });
    expect(calls()).toBe(3);
  });

  it('treats a corrupt cache entry as a miss instead of failing the run', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'nl2charts-synth-'));
    directories.push(cacheDir);
    writeFileSync(join(cacheDir, 'broken.json'), '{not json');
    const { provider, calls } = counter('- a = b.');
    const text = await synthesizeDefinitions({
      oracle: oracleFixture as never,
      db: 'broken',
      schema,
      provider: provider as never,
      model: 'm',
      cacheDir,
    });
    expect(text).toBe('- a = b.');
    expect(calls()).toBe(1);
  });

  it('keeps an empty reply empty rather than inventing a definition', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'nl2charts-synth-'));
    directories.push(cacheDir);
    const { provider } = counter('I cannot determine definitions from this schema.');
    const text = await synthesizeDefinitions({
      oracle: oracleFixture as never,
      db: 'declined',
      schema,
      provider: provider as never,
      model: 'm',
      cacheDir,
    });
    expect(text).toBe('');
  });
});

