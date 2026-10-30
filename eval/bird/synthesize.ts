/**
 * Definitions written once per database, by the model, and cached.
 *
 * The rule-based renderer in `packages/ai/src/definitions.ts` can only say what
 * the schema licenses; it measured +1.3pp, which is not the 12pp a human-written
 * hint buys. This module asks the model to write that hint from the same facts a
 * person would look at — schema, observed values, a couple of rows — once per
 * database rather than once per question.
 *
 * Three properties keep it honest:
 *
 * - the questions and their gold SQL are never in the prompt, so a definition
 *   cannot leak the test set;
 * - the reply is parsed and budgeted by the product's own parser, so what the
 *   benchmark measures is what a customer would ship;
 * - the cache key includes the model and a hash of the request, so a schema
 *   change cannot silently reuse an old answer.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildDefinitionPrompt, parseDefinitions } from '@agentix-e/nl2charts-ai';
import type { DatabaseProfile, LlmProvider, SchemaTable } from '@agentix-e/nl2charts-ai';
import type { Oracle } from './oracle.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const CACHE = join(ROOT, 'eval/.cache/bird/definitions');

export interface SynthesisRequest {
  readonly oracle: Oracle;
  readonly db: string;
  readonly schema: readonly SchemaTable[];
  readonly profile?: DatabaseProfile;
  readonly provider: LlmProvider;
  readonly model: string;
  readonly maxChars?: number;
  readonly force?: boolean;
  /** How many tables get sample rows, and how many rows each. */
  readonly sampleTables?: number;
  readonly sampleRows?: number;
  /** Cache directory; defaults to the repository cache. */
  readonly cacheDir?: string;
}

export interface SynthesisRecord {
  readonly db: string;
  readonly model: string;
  readonly hash: string;
  readonly generatedAt: string;
  readonly promptChars: number;
  readonly definitions: string;
}

/** Stable key: same facts and same model must hit the same cache entry. */
export function synthesisHash(prompt: string, model: string): string {
  return createHash('sha256').update(`${model}\n${prompt}`).digest('hex').slice(0, 16);
}

/**
 * Which tables get sample rows. Large databases get the ones with the most
 * columns first — a wide table teaches more about the domain than a two-column
 * lookup table, and the request has a budget too.
 */
export function pickSampleTables(schema: readonly SchemaTable[], limit: number): SchemaTable[] {
  return [...schema]
    .sort((left, right) => right.columns.length - left.columns.length || left.table.localeCompare(right.table))
    .slice(0, Math.max(0, limit));
}

async function sampleRows(oracle: Oracle, db: string, table: string, limit: number): Promise<readonly (readonly unknown[])[]> {
  const quoted = `"${table.replace(/"/g, '""')}"`;
  const result = await oracle.run(db, `select * from ${quoted} limit ${limit}`);
  return result.ok ? result.rows : [];
}

/**
 * One call per database. Returns the parsed body, or an empty string when the
 * model declines — an empty body costs the prompt nothing, which is the honest
 * outcome of "this schema does not support a definition".
 */
export interface SynthesisOutcome {
  readonly definitions: string;
  /** Hash of the prompt and model; the cache key. */
  readonly hash: string;
  /** True when this run reused a stored record instead of calling the model. */
  readonly cached: boolean;
}

/**
 * Synthesis with its provenance attached.
 *
 * `cached` is the fact that turns "the arm moved 5pp between runs" into a question
 * with an answer: if the definitions came from cache, the prompt was identical and
 * the movement is the model's; if they did not, the prompt changed and the movement
 * is the input's. Reporting only the text made those two indistinguishable.
 */
export async function synthesizeRecord(request: SynthesisRequest): Promise<SynthesisOutcome> {
  const maxChars = request.maxChars ?? 1200;
  const sampleTables = request.sampleTables ?? 6;
  const sampleRowsPerTable = request.sampleRows ?? 2;

  const samples: { table: string; rows: readonly (readonly unknown[])[] }[] = [];
  for (const table of pickSampleTables(request.schema, sampleTables)) {
    const rows = await sampleRows(request.oracle, request.db, table.table, sampleRowsPerTable);
    if (rows.length === 0) continue;
    samples.push({ table: table.table, rows });
  }

  const prompt = buildDefinitionPrompt({
    schema: request.schema,
    ...(request.profile === undefined ? {} : { profile: request.profile }),
    ...(samples.length === 0 ? {} : { samples }),
    maxChars,
  });
  const hash = synthesisHash(prompt, request.model);
  const cacheDir = request.cacheDir ?? CACHE;
  const cacheFile = join(cacheDir, `${request.db}.json`);
  if (request.force !== true && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as SynthesisRecord;
      if (cached.hash === hash) return { definitions: cached.definitions, hash, cached: true };
    } catch {
      // A corrupt cache entry is a cache miss, not a reason to fail a run.
    }
  }

  const reply = await request.provider.complete({ messages: [{ role: 'user', content: prompt }], temperature: 0, purpose: 'synthesize' });
  const definitions = parseDefinitions(reply.text, maxChars);
  mkdirSync(cacheDir, { recursive: true });
  const record: SynthesisRecord = {
    db: request.db,
    model: request.model,
    hash,
    generatedAt: new Date().toISOString(),
    promptChars: prompt.length,
    definitions,
  };
  writeFileSync(cacheFile, `${JSON.stringify(record, null, 2)}\n`);
  return { definitions, hash, cached: false };
}

/** The text alone, for callers that do not need the provenance. */
export async function synthesizeDefinitions(request: SynthesisRequest): Promise<string> {
  return (await synthesizeRecord(request)).definitions;
}
