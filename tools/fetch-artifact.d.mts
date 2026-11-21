/** Hand-written types for `tools/fetch-artifact.mjs`, a script the workflows run before install. */

export interface FetchOptions {
  readonly token?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface ArtifactListOptions extends FetchOptions {
  readonly repo: string;
  readonly api?: string;
}

export interface ArtifactListing {
  readonly id: number;
  readonly name: string;
  readonly size_in_bytes: number;
}

export interface UnpackedFile {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
}

export interface ZipEntry {
  readonly name: string;
  readonly bytes: Buffer;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, what: string, detail: string);
}

export function fetchWithoutForwardedAuth(url: string, options?: FetchOptions): Promise<Response>;
export function listArtifacts(runId: string, options: ArtifactListOptions): Promise<readonly ArtifactListing[]>;
export function downloadArtifact(artifactId: number, options: ArtifactListOptions): Promise<Buffer>;
export function readZip(bytes: Buffer): readonly ZipEntry[];
export function unpack(zipBytes: Buffer, outDir: string): readonly UnpackedFile[];
export function parseArgs(argv: readonly string[]): {
  readonly runId: string | undefined;
  readonly out: string | undefined;
  readonly name: string | undefined;
  readonly list: boolean;
};
export function main(
  argv?: readonly string[],
  env?: Record<string, string | undefined>,
  deps?: {
    readonly api?: string;
    readonly fetchImpl?: typeof fetch;
    readonly stdout?: (line: string) => void;
    readonly stderr?: (line: string) => void;
  },
): Promise<number>;