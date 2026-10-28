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

  it('breaks a width tie by name, so the sample set does not depend on input order', () => {
    const tied: readonly SchemaTable[] = [
      { table: 'zed', columns: [{ name: 'z1', type: 'TEXT' }, { name: 'z2', type: 'TEXT' }] },
      { table: 'alpha', columns: [{ name: 'a1', type: 'TEXT' }, { name: 'a2', type: 'TEXT' }] },
    ];
    expect(pickSampleTables(tied, 2).map((table) => table.table)).toEqual(['alpha', 'zed']);
    expect(pickSampleTables([...tied].reverse(), 2).map((table) => table.table)).toEqual(['alpha', 'zed']);
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


describe('sample rows, when the database does not cooperate', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
  });

  function provider(reply: string): { complete(): Promise<{ text: string; model: string; usage: never }> } {
    return {
      async complete() {
        return { text: reply, model: 'fixture', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } as never };
      },
    };
  }

  it('samples the tables it can read and skips the ones it cannot', async () => {
    // Two ways a sample can fail to arrive: the statement is refused (a table the
    // database does not have) and the statement succeeds with nothing in it. Neither is a
    // reason to fail a run, and neither may put an empty sample block in the prompt — the
    // block costs characters and teaches nothing.
    const cacheDir = mkdtempSync(join(tmpdir(), 'nl2charts-synth-'));
    directories.push(cacheDir);
    const asked: string[] = [];
    const oracle = {
      async run(_db: string, sql: string) {
        asked.push(sql);
        if (sql.includes('"b"')) return { ok: false, columns: [], rows: [], ms: 1, error: 'no such table: b' };
        if (sql.includes('"c"')) return { ok: true, columns: [], rows: [], ms: 1 };
        return { ok: true, columns: [], rows: [['1', 'x']], ms: 1 };
      },
    };
    const outcome = await synthesizeRecord({
      oracle: oracle as never,
      db: 'shop',
      schema,
      provider: provider('- a = b.') as never,
      model: 'm',
      sampleTables: 3,
      sampleRows: 1,
      cacheDir,
    });
    expect(asked).toHaveLength(3);
    // One table survives, so the prompt carries a sample block for exactly that table.
    expect(outcome.definitions).toBe('- a = b.');
    expect(outcome.cached).toBe(false);
  });

  it('sends no sample block at all when every table came back empty', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'nl2charts-synth-'));
    directories.push(cacheDir);
    const oracle = { async run() { return { ok: true, columns: [], rows: [], ms: 1 }; } };
    const empty = await synthesizeRecord({
      oracle: oracle as never,
      db: 'shop',
      schema,
      provider: provider('- a = b.') as never,
      model: 'm',
      sampleTables: 3,
      cacheDir,
    });
    // The hash is a function of the prompt, so two runs that differ only in whether a
    // sample block was sent must not share a cache entry.
    const oracle2 = { async run() { return { ok: true, columns: [], rows: [['1']], ms: 1 }; } };
    const withRows = await synthesizeRecord({
      oracle: oracle2 as never,
      db: 'shop',
      schema,
      provider: provider('- a = b.') as never,
      model: 'm',
      sampleTables: 3,
      cacheDir,
    });
    expect(withRows.hash).not.toBe(empty.hash);
  });
});

describe('the two defaults a caller can omit', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
  });

  function provider(reply: string): { complete(): Promise<{ text: string; model: string; usage: never }> } {
    return { async complete() { return { text: reply, model: 'fixture', usage: {} as never }; } };
  }

  it('carries the database profile into the prompt when one is supplied', async () => {
    // The profile is the difference between "here is the schema" and "here is what the
    // columns actually contain"; leaving it out of the prompt would make the arm that
    // pays for profiling identical to the one that does not.
    const cacheDir = mkdtempSync(join(tmpdir(), 'nl2charts-synth-'));
    directories.push(cacheDir);
    const oracle = { async run() { return { ok: true, columns: [], rows: [], ms: 1 }; } };
    const base = {
      oracle: oracle as never,
      db: 'shop',
      schema,
      provider: provider('- a = b.') as never,
      model: 'm',
      cacheDir,
    };
    const without = await synthesizeRecord(base);
    const withProfile = await synthesizeRecord({
      ...base,
      profile: { db: 'shop', columns: [{ table: 'a', column: 'a1', kind: 'categorical', values: ['x', 'y'] }] },
    });
    expect(withProfile.hash).not.toBe(without.hash);
  });

  it('falls back to the repository cache, which is the path a real run takes', async () => {
    // Every unit test above passes a directory, so the default was the one path nobody
    // had run. It writes into the repository cache, so the entry is removed afterwards.
    const { join: joinPath } = await import('node:path');
    const oracle = { async run() { return { ok: true, columns: [], rows: [], ms: 1 }; } };
    const db = `coverage-probe-${String(process.pid)}`;
    const file = joinPath(process.cwd(), 'eval/.cache/bird/definitions', `${db}.json`);
    try {
      const outcome = await synthesizeRecord({
        oracle: oracle as never,
        db,
        schema,
        provider: provider('- a = b.') as never,
        model: 'm',
      });
      expect(outcome.cached).toBe(false);
      expect(readFileSync(file, 'utf8')).toContain('- a = b.');
    } finally {
      rmSync(file, { force: true });
    }
  });
});
