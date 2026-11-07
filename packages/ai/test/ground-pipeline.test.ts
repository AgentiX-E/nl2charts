import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/pipeline.js';
import type { LlmProvider, LlmRequest } from '../src/provider.js';
import type { SchemaTable } from '../src/linking.js';

const schema: SchemaTable[] = [
  {
    table: 'users',
    columns: [
      { name: 'id', type: 'INTEGER' },
      { name: 'status', type: 'TEXT' },
    ],
  },
];

/** A provider that answers in sequence and keeps every request it saw. */
function scripted(statements: readonly string[]): { provider: LlmProvider; seen: LlmRequest[] } {
  const seen: LlmRequest[] = [];
  let index = 0;
  return {
    seen,
    provider: {
      id: 'scripted',
      model: 'scripted',
      async complete(request: LlmRequest) {
        seen.push(request);
        const text = statements[Math.min(index, statements.length - 1)] as string;
        index += 1;
        return { text, model: 'scripted' };
      },
    },
  };
}

const answer = (sql: string): string => `\`\`\`sql\n${sql}\n\`\`\``;

describe('the pipeline grounds a literal before the engine sees the statement', () => {
  it('rewrites the value the model wrote into the spelling the column stores', async () => {
    const { provider } = scripted([answer("SELECT id FROM users WHERE status = 'banned'")]);
    const executed: string[] = [];
    const pipeline = createPipeline({
      provider,
      readColumnValues: () => Promise.resolve(['Active', 'Banned']),
      execute: (sql) => {
        executed.push(sql);
        return Promise.resolve({ rows: 3 });
      },
    });
    const result = await pipeline.ask({ question: 'which users are banned?', schema });
    expect(result.sql).toBe("SELECT id FROM users WHERE status = 'Banned'");
    // What ran and what is reported are the same statement: a grounding applied after execution
    // would score the model's spelling and show the reader another one.
    expect(executed).toEqual([result.sql]);
    expect(result.grounding).toEqual({ substitutions: 1, refused: 0 });
  });

  it('counts a literal it could not settle instead of reporting a clean run', async () => {
    const { provider } = scripted([answer("SELECT id FROM users WHERE status = 'atlantis'")]);
    const pipeline = createPipeline({
      provider,
      readColumnValues: () => Promise.resolve(['Active', 'Banned']),
      execute: () => Promise.resolve({ rows: 0 }),
    });
    const result = await pipeline.ask({ question: 'who is atlantean?', schema });
    expect(result.sql).toBe("SELECT id FROM users WHERE status = 'atlantis'");
    expect(result.grounding).toEqual({ substitutions: 0, refused: 1 });
  });

  it('reports no grounding at all when the caller supplies no reader', async () => {
    // Absence is not a reading: a caller that did not wire the reader must not see `0`, which
    // would say the rewrite looked and found nothing to do.
    const { provider } = scripted([answer("SELECT id FROM users WHERE status = 'banned'")]);
    const pipeline = createPipeline({ provider });
    const result = await pipeline.ask({ question: 'which users are banned?', schema });
    expect(result.grounding).toBeUndefined();
    expect(result.sql).toBe("SELECT id FROM users WHERE status = 'banned'");
  });

  it('grounds the statement a repair turn writes, not only the first one', async () => {
    // The repair loop re-enters with a second reply; a rule applied only to the first would price
    // itself on the turn that needed it least.
    const { provider, seen } = scripted([
      answer('SELECT id FROM users WHERE status ='),
      answer("SELECT id FROM users WHERE status = 'pending'"),
    ]);
    const executed: string[] = [];
    const pipeline = createPipeline({
      provider,
      maxRepairs: 1,
      readColumnValues: () => Promise.resolve(['Active', 'Banned', 'Pending']),
      execute: (sql) => {
        executed.push(sql);
        if (sql !== "SELECT id FROM users WHERE status = 'Pending'") throw new Error('no such column: status =');
        return Promise.resolve({ rows: 2 });
      },
    });
    const result = await pipeline.ask({ question: 'which users are pending?', schema });
    expect(seen).toHaveLength(2);
    // The first turn wrote no literal to settle, so it reached the engine exactly as written and
    // the engine refused it; the repair's statement is the one the rule had something to say about.
    expect(executed).toEqual(["SELECT id FROM users WHERE status =", "SELECT id FROM users WHERE status = 'Pending'"]);
    expect(result.sql).toBe("SELECT id FROM users WHERE status = 'Pending'");
    expect(result.grounding).toEqual({ substitutions: 1, refused: 0 });
  });
});
