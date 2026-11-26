/**
 * The declarations for `fetch.mjs`.
 *
 * A `.mjs` file is invisible to `tsc` in a way that only shows up in CI: the local resolution picks
 * the implementation and the runner's does not, which is how `eval/wikisql/fetch.d.mts` came to be
 * missing two exports that typechecked locally. Every export the test and the workflows use is
 * declared here, and adding one to the `.mjs` means adding it here.
 */

export interface Pin {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface FetchedCorpus {
  readonly corpus: string;
  readonly origin: { readonly repo: string; readonly ref: string };
  readonly files: readonly { readonly name: string; readonly path: string; readonly bytes: number; readonly sha256: string }[];
  readonly questions: number;
  readonly databases: number;
  readonly databasesAre: string;
  readonly metric: string;
}

export interface CorpusCheck {
  readonly manifest: FetchedCorpus;
  readonly questions: number;
  readonly databases: number;
  readonly missing: readonly string[];
  readonly problems: readonly string[];
}

export interface Settings {
  readonly split: string;
  readonly check: boolean;
  readonly out: string;
}

export interface MainOptions {
  readonly log?: (line: string) => void;
  readonly fetchImpl?: typeof fetch;
  readonly token?: string;
  readonly pins?: readonly Pin[];
}

export const ORIGIN: { readonly repo: string; readonly ref: string };
export const FILES: readonly Pin[];

export function cacheDir(override?: string): string;
export function digestOf(buffer: Uint8Array): string;
export function fetchPinned(file: Pin, options?: { readonly fetchImpl?: typeof fetch; readonly token?: string }): Promise<Buffer>;
export function reserved(name: string): boolean;
export function schemaOf(entry: {
  readonly db_id: string;
  readonly table_names_original: readonly string[];
  readonly column_names_original: readonly (readonly [number, string])[];
  readonly column_types: readonly string[];
  readonly primary_keys?: readonly number[];
  readonly foreign_keys?: readonly (readonly [number, number])[];
}): readonly { readonly table: string; readonly sql: string }[];
export function buildDatabase(entry: Parameters<typeof schemaOf>[0], path: string): void;
export function databasesOf(questions: readonly { readonly db_id: string }[]): readonly string[];
export function writeCorpus(
  dir: string,
  files: Readonly<Record<string, Buffer>>,
  questions: readonly { readonly db_id: string }[],
  tables: readonly Parameters<typeof schemaOf>[0][],
): FetchedCorpus;
export function checkCorpus(dir: string): CorpusCheck;
export function resolveSettings(argv: readonly string[]): Settings;
export function main(argv: readonly string[], options?: MainOptions): Promise<number>;
