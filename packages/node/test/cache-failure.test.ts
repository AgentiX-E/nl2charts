import { readdir } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileCache } from '../src/cache.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nl2c-cache-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('cache failure handling', () => {
  it('cleans up the temp file and rethrows when the rename fails', async () => {
    const cache = createFileCache({ dir });
    const target = cache.pathFor('blocked');
    // A directory at the target path makes rename(2) fail.
    await mkdir(target, { recursive: true });
    await expect(cache.set('blocked', new Uint8Array([1]))).rejects.toThrow();
    const parent = await readdir(join(target, '..'));
    expect(parent.filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });
});
