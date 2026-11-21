/**
 * The surface `tools/readback.mjs` exposes, declared for the tests that hold it to its rules.
 *
 * The script stays plain JavaScript for the reason `ci-scope.d.mts` gives: a workflow step runs it
 * before `pnpm install`.
 */

/** One arm, reduced to the fields a report quotes. */
export interface ReadbackArm {
  readonly arm: string;
  readonly passed: number;
  readonly total: number;
  readonly accuracy: number;
  readonly candidateRecall?: number;
  readonly selectionLoss?: number;
  readonly calls?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly strictPassed?: number;
}

/** An R-VES reading as the artifact writes it: the floor is a block. */
export interface VesSource {
  readonly rves: number;
  readonly ex: number;
  readonly scored: number;
  readonly of: number;
  readonly runs: readonly number[];
  readonly repeats: number;
  readonly floor?: { readonly rves: number; readonly net: number };
}

/** An R-VES reading as a published reading carries it: the floor is the number it contributes. */
export interface ReadbackVes {
  readonly rves: number;
  readonly ex: number;
  readonly scored: number;
  readonly of: number;
  readonly runs: readonly number[];
  readonly repeats: number;
  readonly floor?: number;
  readonly net?: number;
}

/** A published reading. */
export interface Readback {
  readonly kind: string;
  readonly commit: string | null;
  readonly workflow: string | null;
  readonly runId: string | null;
  readonly split: string | null;
  readonly dataset: string | null;
  readonly model: string | null;
  readonly secondModel: string | null;
  readonly generatedAt: string | null;
  readonly corpus: unknown;
  readonly selection: { readonly requested?: number; readonly scored?: number } | null;
  readonly arms: readonly ReadbackArm[];
  readonly rves?: ReadbackVes;
}

/** What the workflow knows about the run that produced a reading. */
export interface ReadbackMeta {
  readonly commit?: string | null;
  readonly workflow?: string | null;
  readonly runId?: string | null;
}

/** The file every workflow's reading is merged into. */
export const INDEX_PATH: string;

/** The branch readings are written to. */
export const READBACK_BRANCH: string;

/** An HTTP failure with its status, which is how "not written yet" is told from "not allowed". */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string);
}

/** Reduce an artifact, and optionally its R-VES reading, to what a comment can carry. */
export function digest(
  artifact: {
    readonly split?: string;
    readonly dataset?: string;
    readonly model?: string;
    readonly secondModel?: string;
    readonly generatedAt?: string;
    readonly corpus?: unknown;
    readonly selection?: { readonly requested?: number; readonly scored?: number };
    readonly arms?: readonly {
      readonly arm: string;
      readonly passed: number;
      readonly total: number;
      readonly accuracy: number;
      readonly candidateRecall?: number;
      readonly selectionLoss?: number;
      readonly calls?: { readonly mean: number };
      readonly tokens?: { readonly prompt: number; readonly completion: number };
      readonly strictPassed?: number;
    }[];
  },
  ves?: VesSource | null,
  meta?: ReadbackMeta,
): Readback;

/** The comment body: a readable table, then the same reading as fenced JSON. */
export function bodyOf(reading: Readback): string;

/** The reading in a comment body, or undefined when the comment does not carry one. */
export function parseBody(body: string): Readback | undefined;

/** The slug a reading is filed under. */
export function slugOf(environment: Record<string, string | undefined>, override?: string): string;

/** The index with one entry replaced. */
export function mergeReading(
  index: { readonly readings?: Readonly<Record<string, Readback>> } | undefined,
  slug: string,
  reading: Readback,
): { readonly version: number; readonly readings: Record<string, Readback> };

/** The newest entry in an index, by the run that wrote it. */
export function latestReading(index: { readonly readings?: Readonly<Record<string, Readback>> } | undefined): [string, Readback] | undefined;

/** The branch, created from the default branch's head on first use. */
export function ensureBranch(options: {
  readonly fetchImpl?: typeof fetch;
  readonly api?: string;
  readonly token: string;
  readonly repo: string;
  readonly branch?: string;
}): Promise<string>;

/** The index as it stands, with the blob sha a write has to name. */
export function readIndex(options: {
  readonly fetchImpl?: typeof fetch;
  readonly api?: string;
  readonly token: string;
  readonly repo: string;
  readonly branch?: string;
}): Promise<{ readonly index: { readonly version: number; readonly readings: Record<string, Readback> }; readonly sha: string | undefined }>;

/** Merge one reading into the index on the branch. */
export function publishToBranch(options: {
  readonly fetchImpl?: typeof fetch;
  readonly api?: string;
  readonly token: string;
  readonly repo: string;
  readonly branch?: string;
  readonly slug: string;
  readonly reading: Readback;
}): Promise<{ readonly branch: string; readonly path: string; readonly commit: string | undefined; readonly slug: string; readonly readings: number }>;

/** One reading, or the newest when no slug is named. */
export function readFromBranch(options: {
  readonly fetchImpl?: typeof fetch;
  readonly api?: string;
  readonly token: string;
  readonly repo: string;
  readonly branch?: string;
  readonly slug?: string;
}): Promise<{ readonly slug: string; readonly reading: Readback } | undefined>;

/** The long-lived issue, when the list contains one. */
export function findIssue(issues: readonly { readonly title?: string; readonly number: number; readonly pull_request?: unknown }[]): { readonly number: number } | undefined;

/** The issue, created if the repository does not have one. */
export function ensureIssue(options: {
  readonly fetchImpl?: typeof fetch;
  readonly api?: string;
  readonly token: string;
  readonly repo: string;
}): Promise<{ readonly number: number }>;

/** Post a reading as a comment. */
export function publish(options: {
  readonly fetchImpl?: typeof fetch;
  readonly api?: string;
  readonly token: string;
  readonly repo: string;
  readonly reading: Readback;
  readonly issue?: number;
}): Promise<{ readonly issue: number; readonly comment: number; readonly url: string }>;

/** The newest reading on the issue. */
export function read(options: {
  readonly fetchImpl?: typeof fetch;
  readonly api?: string;
  readonly token: string;
  readonly repo: string;
  readonly issue?: number;
  readonly pages?: number;
}): Promise<{ readonly issue: number; readonly comment: number; readonly url: string; readonly reading: Readback } | undefined>;

/** The run coordinates the workflow has in its environment. */
export function metaFromEnvironment(environment: Record<string, string | undefined>): ReadbackMeta;

/** Entry point; resolves to the process exit code. */
export async function main(argv: readonly string[], environment?: Record<string, string | undefined>): Promise<number>;
