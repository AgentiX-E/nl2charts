import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exampleHash, synthesizeExamples } from '../eval/bird/examples.js';
import { buildExamplePrompt } from '@agentix-e/nl2charts-ai';
import type { LlmRequest, LlmResponse, SchemaTable } from '@agentix-e/nl2charts-ai';

/**
 * The online synthetic examples are one call per database, so the cache is the difference
 * between 11 calls for the dev split and 11 calls for every run. These tests pin the four ways
 * that can go wrong: a stale block reused after the model or the count changed, a corrupt entry
 * failing the run, an empty reply becoming a prompt that refers to examples it does not carry,
 * and a block written but not reported as written.
 */
const schema: readonly SchemaTable[] = [{ table: 'orders', columns: [{ name: 'order_id', type: 'BIGINT' }, { name: 'region', type: 'VARCHAR' }] }];

const reply = [
  'Question: How many orders are there?',
  '```sql',
  'SELECT COUNT(*) FROM orders',
  '```',
  '',
  'Question: How many orders per region?',
  '```sql',
  'SELECT region, COUNT(*) FROM orders GROUP BY region',
  '```',
].join('\n');

describe('the examples cache key', () => {
  it('is stable for the same prompt and model, and moves when either does', () => {
    expect(exampleHash('p', 'm')).toBe(exampleHash('p', 'm'));
    expect(exampleHash('p2', 'm')).not.toBe(exampleHash('p', 'm'));
    expect(exampleHash('p', 'm2')).not.toBe(exampleHash('p', 'm'));
  });
});

describe('the examples run', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
  });

  function tempDir(): string {
    const directory = mkdtempSync(join(tmpdir(), 'nl2charts-examples-'));
    directories.push(directory);
    return directory;
  }

  function counter(text: string): { provider: { complete(request: LlmRequest): Promise<LlmResponse> }; calls: () => number } {
    let calls = 0;
    return {
      provider: {
        async complete() {
          calls += 1;
          return { text, model: 'fixture', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
        },
      },
      calls: () => calls,
    };
  }

  const request = (cacheDir: string, overrides: Record<string, unknown> = {}) => ({
    db: 'shop',
    schema,
    provider: counter(reply).provider as never,
    model: 'test-model',
    count: 3,
    cacheDir,
    ...overrides,
  });

  it('writes the pairs, serves the next request from cache, and records what it wrote', async () => {
    const cacheDir = tempDir();
    const { provider, calls } = counter(reply);
    const first = await synthesizeExamples(request(cacheDir, { provider: provider as never }));
    const second = await synthesizeExamples(request(cacheDir, { provider: provider as never }));
    expect(first.examples).toHaveLength(2);
    expect(first.cached).toBe(false);
    expect(first.written).toBe(2);
    expect(first.asked).toBe(3);
    expect(second.cached).toBe(true);
    expect(second.examples).toEqual(first.examples);
    // One call for the whole run, which is the property the per-database shape exists for.
    expect(calls()).toBe(1);
    const record = JSON.parse(readFileSync(join(cacheDir, 'shop.json'), 'utf8'));
    expect(record.model).toBe('test-model');
    expect(record.hash).toHaveLength(16);
    expect(record.examples).toHaveLength(2);
    expect(record.promptChars).toBeGreaterThan(0);
  });

  it('regenerates when the model changes, because the block belongs to the model that wrote it', async () => {
    const cacheDir = tempDir();
    const { provider, calls } = counter(reply);
    await synthesizeExamples(request(cacheDir, { provider: provider as never }));
    const other = await synthesizeExamples(request(cacheDir, { provider: provider as never, model: 'another-model' }));
    expect(other.cached).toBe(false);
    expect(calls()).toBe(2);
  });

  it('regenerates when the count changes, because the prompt changed', async () => {
    const cacheDir = tempDir();
    const { provider, calls } = counter(reply);
    await synthesizeExamples(request(cacheDir, { provider: provider as never }));
    const wider = await synthesizeExamples(request(cacheDir, { provider: provider as never, count: 4 }));
    expect(wider.cached).toBe(false);
    expect(calls()).toBe(2);
  });

  it('regenerates when the schema changes, because the prompt is the card', async () => {
    const cacheDir = tempDir();
    const { provider, calls } = counter(reply);
    await synthesizeExamples(request(cacheDir, { provider: provider as never }));
    const widened = await synthesizeExamples(
      request(cacheDir, {
        provider: provider as never,
        schema: [{ table: 'orders', columns: [{ name: 'order_id', type: 'BIGINT' }, { name: 'region', type: 'VARCHAR' }, { name: 'revenue', type: 'DECIMAL' }] }],
      }),
    );
    expect(widened.cached).toBe(false);
    expect(calls()).toBe(2);
  });

  it('treats a corrupt entry as a miss rather than as a failure', async () => {
    const cacheDir = tempDir();
    writeFileSync(join(cacheDir, 'shop.json'), '{ not json');
    const { provider, calls } = counter(reply);
    const outcome = await synthesizeExamples(request(cacheDir, { provider: provider as never }));
    expect(outcome.cached).toBe(false);
    expect(outcome.examples).toHaveLength(2);
    expect(calls()).toBe(1);
  });

  it('treats an entry that holds no example as a miss, because an empty block is not a block', async () => {
    const cacheDir = tempDir();
    // The hash matches this request exactly, so the only reason to miss is the empty block: that
    // is the branch a hash check alone would not take, and it is the one a reply that produced
    // nothing would leave behind.
    const hash = exampleHash(buildExamplePrompt(schema, 3), 'test-model');
    writeFileSync(join(cacheDir, 'shop.json'), `${JSON.stringify({ db: 'shop', model: 'test-model', hash, generatedAt: 'x', promptChars: 1, examples: [] })}\n`);
    const { provider, calls } = counter(reply);
    const outcome = await synthesizeExamples(request(cacheDir, { provider: provider as never }));
    expect(outcome.cached).toBe(false);
    expect(calls()).toBe(1);
  });

  it('reuses an entry whose hash matches even when its examples are a shorter block', async () => {
    // The count is part of the prompt, so a cached block of two for a request of three can only
    // come from a run that asked for three and was given two — and that answer is still the one
    // the prompt produced.
    const cacheDir = tempDir();
    const { provider } = counter(reply);
    await synthesizeExamples(request(cacheDir, { provider: provider as never }));
    const again = await synthesizeExamples(request(cacheDir, { provider: provider as never }));
    expect(again.asked).toBe(3);
    expect(again.written).toBe(2);
  });

  it('bypasses a valid entry when the caller asks for a rewrite', async () => {
    const cacheDir = tempDir();
    const { provider, calls } = counter(reply);
    await synthesizeExamples(request(cacheDir, { provider: provider as never }));
    const forced = await synthesizeExamples(request(cacheDir, { provider: provider as never, force: true }));
    expect(forced.cached).toBe(false);
    expect(calls()).toBe(2);
  });

  it('refuses a reply with no usable pair instead of sending a prompt that refers to nothing', async () => {
    const cacheDir = tempDir();
    const { provider } = counter('I cannot write questions about this schema.');
    await expect(synthesizeExamples(request(cacheDir, { provider: provider as never }))).rejects.toThrow(
      /examples for shop: the reply carried no usable question-SQL pair/,
    );
  });
});
