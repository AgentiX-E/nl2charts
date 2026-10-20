import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileCache } from '../src/cache.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nl2c-cache-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('file cache', () => {
  it('round-trips bytes under a content-addressed path', async () => {
    const cache = createFileCache({ dir });
    const path = await cache.set('select 1', new TextEncoder().encode('payload'));
    expect(path).toBe(cache.pathFor('select 1'));
    expect(path.startsWith(dir)).toBe(true);
    const bytes = await cache.get('select 1');
    expect(bytes?.toString()).toBe('payload');
    expect(await cache.has('select 1')).toBe(true);
  });

  it('returns null for a missing key instead of throwing', async () => {
    const cache = createFileCache({ dir });
    expect(await cache.get('absent')).toBeNull();
    expect(await cache.has('absent')).toBe(false);
  });

  it('is stable across keys and distinct between them', () => {
    const cache = createFileCache({ dir });
    expect(cache.pathFor('a')).toBe(cache.pathFor('a'));
    expect(cache.pathFor('a')).not.toBe(cache.pathFor('b'));
    expect(cache.pathFor('a')).toMatch(/[0-9a-f]{64}\.bin$/);
  });

  it('expires entries once the ttl has passed', async () => {
    const cache = createFileCache({ dir, ttlMs: 20 });
    const path = await cache.set('k', new Uint8Array([1, 2, 3]));
    expect(await cache.has('k')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await cache.get('k')).toBeNull();
    expect(await readdir(join(path, '..'))).toHaveLength(1);
  });

  it('keeps entries when the ttl is disabled', async () => {
    const cache = createFileCache({ dir });
    await cache.set('k', new Uint8Array([1]));
    expect(await cache.get('k')).toEqual(Buffer.from([1]));
  });

  it('does not leave a temp file behind after a successful write', async () => {
    const cache = createFileCache({ dir });
    const path = await cache.set('k', new Uint8Array([9]));
    const files = await readdir(join(path, '..'));
    expect(files.filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('overwrites an existing entry atomically', async () => {
    const cache = createFileCache({ dir });
    await cache.set('k', new TextEncoder().encode('one'));
    await cache.set('k', new TextEncoder().encode('two'));
    expect((await cache.get('k'))?.toString()).toBe('two');
  });

  it('reads a file that was placed out of band', async () => {
    const cache = createFileCache({ dir });
    const path = cache.pathFor('manual');
    await writeFile(join(dir, 'placeholder'), '');
    await rm(join(dir, 'placeholder'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'external');
    expect((await cache.get('manual'))?.toString()).toBe('external');
  });
});
