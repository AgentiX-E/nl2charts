import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface FileCacheOptions {
  readonly dir: string;
  readonly ttlMs?: number;
}

export interface FileCache {
  get(key: string): Promise<Buffer | null>;
  set(key: string, payload: Uint8Array): Promise<string>;
  has(key: string): Promise<boolean>;
  /** Exposed for callers that need to invalidate deterministically. */
  pathFor(key: string): string;
}

function digest(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Content-addressed file cache with atomic writes. A half-written entry is
 * never observable: the payload lands in a temp file and is renamed into place.
 */
export function createFileCache(options: FileCacheOptions): FileCache {
  const ttlMs = options.ttlMs ?? 0;

  const pathFor = (key: string): string => {
    const hex = digest(key);
    return join(options.dir, hex.slice(0, 2), `${hex}.bin`);
  };

  return {
    pathFor,
    async get(key) {
      const path = pathFor(key);
      try {
        if (ttlMs > 0) {
          const info = await stat(path);
          if (Date.now() - info.mtimeMs > ttlMs) return null;
        }
        return await readFile(path);
      } catch {
        return null;
      }
    },
    async has(key) {
      return (await this.get(key)) !== null;
    },
    async set(key, payload) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, payload);
      try {
        await rename(temp, path);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
      return path;
    },
  };
}
