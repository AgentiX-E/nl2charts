/**
 * The surface `fetch.mjs` exports for tests.
 *
 * The script stays plain JavaScript — it runs before `pnpm install` finishes on a fresh runner and
 * has no dependency to import a type from — so its shape is declared here rather than by converting
 * it.
 */
export interface Artifact {
  readonly name: string;
  readonly source: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SplitShape {
  readonly questions: number;
  readonly tables: number;
}

export const ARTIFACTS: readonly Artifact[];
export const OUT_OF_SCOPE: Record<string, string>;
export const SPLITS: Record<string, SplitShape>;
export const TABLES: number;

export function cachePath(): string;
export function extract(cache: string): void;
export function sourceUrl(source: string): string;
export function sha256Of(path: string): Promise<string>;
export function warmOf(artifact: Pick<Artifact, 'name' | 'bytes' | 'sha256'>, cache: string): Promise<boolean>;
export function download(artifact: Artifact, cache: string): Promise<string>;
export function inspect(
  cache: string,
  tables?: number,
): {
  problems: string[];
  counts: { questions: Record<string, { questions: number; tables: number }>; tables: number | null };
};
export function main(
  argv?: string[],
  tools?: {
    download: (artifact: Artifact, cache: string) => Promise<string>;
    extract: (cache: string) => void;
  },
): Promise<number>;
