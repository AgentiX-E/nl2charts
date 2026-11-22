/**
 * Examples written once per database, by the model, and cached — the harness half.
 *
 * `packages/ai/src/examples.ts` owns the prompt and the parser, because a customer would run
 * both. This module adds the two things a benchmark needs and a product does not: a cache keyed
 * on the prompt and the model, and provenance, so that "the arm moved between runs" can be told
 * apart from "the examples were rewritten between runs".
 *
 * The cost shape is the reason this is per database rather than per question. Dev has 11
 * databases and 1,534 questions: one call a database is 11 calls for the whole split, while the
 * per-question version of the same idea would be 1,534. CHASE-SQL generates the pairs once per
 * database for this reason, and their ablation is the reading this arm is priced against.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildExamplePrompt, parseExamples } from '@agentix-e/nl2charts-ai';
import type { LlmProvider, SchemaTable, SyntheticExample } from '@agentix-e/nl2charts-ai';

export interface ExampleRequest {
  readonly db: string;
  readonly schema: readonly SchemaTable[];
  readonly provider: LlmProvider;
  readonly model: string;
  /** How many pairs to ask for; the block is paid for on every question. */
  readonly count: number;
  readonly force?: boolean;
  /**
   * Where the block lives. Required rather than defaulted: the first version defaulted to a
   * directory in the repository, and an end-to-end test's fixture database then wrote a block
   * that the next real run read under the same name — a cache whose scope is the module's path
   * rather than the run's root cannot be isolated by a test, and the test that should have
   * caught it read zero synthesis calls and blamed the wiring.
   */
  readonly cacheDir: string;
}

export interface ExampleRecord {
  readonly db: string;
  readonly model: string;
  readonly hash: string;
  readonly generatedAt: string;
  readonly promptChars: number;
  readonly examples: readonly SyntheticExample[];
}

export interface ExampleOutcome {
  readonly examples: readonly SyntheticExample[];
  readonly hash: string;
  readonly cached: boolean;
  /** How many of the requested pairs the reply yielded; a short block is a fact worth reporting. */
  readonly written: number;
  readonly asked: number;
}

/** Same key discipline as the definition cache: the same prompt and model must hit the same entry. */
export function exampleHash(prompt: string, model: string): string {
  return createHash('sha256').update(`${model}\n${prompt}`).digest('hex').slice(0, 16);
}

/**
 * The pairs for one database, from the cache when it holds them.
 *
 * A reply that yields no usable pair throws rather than returning an empty block. An empty block
 * renders a prompt that says "the examples above" about nothing, and the arm would then read as
 * its parent with a longer instruction — the failure this repository has already paid for twice
 * (a `values` block read by the harness and never passed down, an `emptyRetry` wired to a hook
 * that never fired). Naming the database in the message is what turns that into a two-minute fix.
 */
export async function synthesizeExamples(request: ExampleRequest): Promise<ExampleOutcome> {
  const prompt = buildExamplePrompt(request.schema, request.count);
  const hash = exampleHash(prompt, request.model);
  const cacheDir = request.cacheDir;
  const cacheFile = join(cacheDir, `${request.db}.json`);
  if (request.force !== true && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as ExampleRecord;
      if (cached.hash === hash && cached.examples.length > 0) {
        return { examples: cached.examples, hash, cached: true, written: cached.examples.length, asked: request.count };
      }
    } catch {
      // A corrupt entry is a cache miss, not a reason to fail a run.
    }
  }

  const reply = await request.provider.complete({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    purpose: 'synthesize',
  });
  const examples = parseExamples(reply.text, request.count);
  if (examples.length === 0) {
    throw new Error(
      `examples for ${request.db}: the reply carried no usable question-SQL pair (${String(reply.text.length)} chars); ` +
        'the arm would otherwise send a block that says "the examples above" about nothing',
    );
  }
  mkdirSync(cacheDir, { recursive: true });
  const record: ExampleRecord = {
    db: request.db,
    model: request.model,
    hash,
    generatedAt: new Date().toISOString(),
    promptChars: prompt.length,
    examples,
  };
  writeFileSync(cacheFile, `${JSON.stringify(record, null, 2)}\n`);
  return { examples, hash, cached: false, written: examples.length, asked: request.count };
}
