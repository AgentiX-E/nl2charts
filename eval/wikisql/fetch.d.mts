/**
 * The surface `fetch.mjs` exports for tests.
 *
 * The script stays plain JavaScript — it runs before `pnpm install` finishes on a fresh runner, and
 * it has no dependency to import a type from — so its shape is declared here rather than by
 * converting it.
 */
export interface SplitShape {
  readonly questions: number;
  readonly tables: number;
  readonly used: number;
  readonly db: string;
}

export interface ArchiveShape {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export const SPLITS: Record<string, SplitShape>;
export const ARCHIVE: ArchiveShape;
export const FILES: Record<string, string>;

export function sourceUrl(): string;
export const ORIGIN: { readonly repo: string; readonly ref: string };
/**
 * The second transport, declared with the seam a test uses.
 *
 * `fetchImpl` is `typeof fetch`, so a case can hand it a canned GitHub and assert what the fetcher
 * writes; the default is the platform's `fetch`, which is what a runner gets.
 */
export function fetchFromApi(target: string, fetchImpl?: typeof fetch): Promise<void>;
export function planOf(split: string): { split: string; members: string[]; files: string[]; shape: SplitShape };
export function sha256Of(path: string): Promise<string>;
export function countLines(path: string): number;
export function inspect(
  split: string,
  cache: string,
  shape?: { questions: number; tables: number },
): { problems: string[]; counts: { questions: number; tables: number } | null };
export function extract(archive: string, staging: string, plan: { members: string[]; files: string[] }): string[];
export function main(argv?: string[]): Promise<number>;
