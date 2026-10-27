import { describe, expect, it } from 'vitest';
import { buildAskMessages, buildSqlPrompt, createPipeline, extractSql } from '../src/pipeline.js';
import { countSteps, DECOMPOSE_RULES, parseDecomposed } from '../src/decompose.js';
import type { LlmProvider, LlmRequest } from '../src/provider.js';
import type { SchemaTable } from '../src/linking.js';

const schema: SchemaTable[] = [
  {
    table: 'orders',
    columns: [
      { name: 'id', type: 'INTEGER' },
      { name: 'region', type: 'TEXT' },
      { name: 'revenue', type: 'REAL' },
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

const STEPS_THEN_ANSWER = [
  'STEP 1: SELECT id FROM orders WHERE region = "EMEA"',
  'STEP 2: SELECT SUM(revenue) FROM orders WHERE id IN (1, 2)',
  '```sql',
  'SELECT SUM(revenue) FROM orders WHERE region = "EMEA"',
  '```',
].join('\n');

describe('reading a decomposed reply', () => {
  it('takes the last block, not the first, which is the whole point of the reader', () => {
    // A reply that fences each step is the failure this exists for: the first block is a
    // statement that runs, returns rows, and answers a different question.
    const fencedSteps = [
      'Step 1: SELECT id FROM orders WHERE region = "EMEA"',
      '```sql',
      'SELECT id FROM orders WHERE region = "EMEA"',
      '```',
      'Step 2: sum those orders',
      '```sql',
      'SELECT SUM(revenue) FROM orders WHERE region = "EMEA"',
      '```',
    ].join('\n');
    expect(parseDecomposed(fencedSteps).sql).toBe('SELECT SUM(revenue) FROM orders WHERE region = "EMEA"');
    // ...and the plain reader would have returned step one, which is why the switch matters.
    expect(extractSql(fencedSteps)).toBe('SELECT id FROM orders WHERE region = "EMEA"');
  });

  it('reads the only block when the steps are written as plain lines', () => {
    const parsed = parseDecomposed(STEPS_THEN_ANSWER);
    expect(parsed.sql).toBe('SELECT SUM(revenue) FROM orders WHERE region = "EMEA"');
    expect(parsed.steps).toBe(2);
  });

  it('counts steps whatever marker or case the model used', () => {
    const text = ['- STEP 1: SELECT 1', '* Step 2: SELECT 2', '**step 3:** SELECT 3', 'Step 4 : SELECT 4'].join('\n');
    expect(countSteps(text)).toBe(4);
  });

  it('does not read `STEP` inside a statement as a step', () => {
    // `step` is a plausible column name; a counter that matches anywhere would inflate the
    // reach of the mechanism and make an ignored instruction look followed.
    expect(countSteps('SELECT step FROM routes WHERE step_name = "x"')).toBe(0);
  });

  it('falls back to the text after a FINAL marker when the reply used no fence', () => {
    const text = 'STEP 1: SELECT id FROM orders\nFINAL: SELECT COUNT(*) FROM orders';
    expect(parseDecomposed(text).sql).toBe('SELECT COUNT(*) FROM orders');
  });

  it('strips the label a model may put inside the block', () => {
    expect(parseDecomposed('```sql\nSQL: SELECT 1\n```').sql).toBe('SELECT 1');
    expect(parseDecomposed('```\nAnswer: SELECT 2\n```').sql).toBe('SELECT 2');
  });

  it('returns the whole reply when nothing marks the answer, so the guard refuses it', () => {
    // Silently returning step one here would let an unformatted reply be scored as if the
    // decomposition had produced an answer.
    const text = 'STEP 1: SELECT 1\nSTEP 2: SELECT 2';
    expect(parseDecomposed(text).sql).toBe(text);
  });
});

describe('the decomposition prompt', () => {
  it('replaces the one-statement rule instead of contradicting it', () => {
    const prompt = buildSqlPrompt('how much revenue in EMEA', schema, { decompose: true, dialect: 'SQLite' });
    expect(prompt).toContain('working notes and are not executed');
    expect(prompt).not.toContain('no DDL or DML, one statement, no comments');
    // One instruction about statements, not two that disagree.
    expect(prompt.match(/no DDL or DML/g)).toHaveLength(1);
  });

  it('ends with the format rules, after any per-shape notes', () => {
    const prompt = buildSqlPrompt('rank the regions', schema, {
      decompose: true,
      notes: ['This question needs a window function.'],
    });
    const tail = prompt.slice(prompt.indexOf('This question needs a window function.'));
    for (const rule of DECOMPOSE_RULES) expect(tail).toContain(rule);
  });

  it('leaves a plain prompt exactly as it was', () => {
    const prompt = buildSqlPrompt('how much revenue in EMEA', schema, { dialect: 'SQLite' });
    expect(prompt).toContain('Rules: SELECT only, no DDL or DML, one statement, no comments.');
    expect(prompt).not.toContain('STEP <n>');
  });

  it('lets the prompt block alone ask for it, so a direct caller cannot half-switch it', () => {
    const built = buildAskMessages({ question: 'how much revenue in EMEA', schema, prompt: { decompose: true } });
    expect(built.messages[0]?.content).toContain('STEP <n>');
  });
});

describe('the pipeline under decomposition', () => {
  it('adopts the final statement and reports how many steps it wrote', async () => {
    const { provider } = scripted([STEPS_THEN_ANSWER]);
    const pipeline = createPipeline({ provider, decompose: true });
    const result = await pipeline.ask({ question: 'how much revenue in EMEA', schema });
    expect(result.sql).toBe('SELECT SUM(revenue) FROM orders WHERE region = "EMEA"');
    expect(result.decomposedSteps).toBe(2);
    expect(result.attempts).toBe(1);
  });

  it('reports no step count when the pipeline did not ask for one', async () => {
    const { provider } = scripted(['```sql\nSELECT 1\n```']);
    const result = await createPipeline({ provider }).ask({ question: 'q', schema });
    expect(result.decomposedSteps).toBeUndefined();
  });

  it('reads a repair turn from its last block too', async () => {
    // The repair is written under the same prompt, so it carries steps as well; a reader
    // that switched back to the first block would adopt step one of the second reply.
    const first = 'STEP 1: SELECT nope FROM orders\n```sql\nSELECT nope FROM orders\n```';
    const second = 'STEP 1: SELECT id FROM orders\n```sql\nSELECT id FROM orders\n```';
    const { provider } = scripted([first, second]);
    const pipeline = createPipeline({
      provider,
      decompose: true,
      maxRepairs: 1,
      execute: async (sql) => {
        if (sql.includes('nope')) throw new Error('no such column: nope');
        return { rows: 1 };
      },
    });
    const result = await pipeline.ask({ question: 'q', schema });
    expect(result.sql).toBe('SELECT id FROM orders');
    expect(result.attempts).toBe(2);
    expect(result.decomposedSteps).toBe(1);
  });

  it('keeps the switch honest for the empty-result turn, which reads the same way', async () => {
    const first = 'STEP 1: SELECT id FROM orders\n```sql\nSELECT id FROM orders WHERE 1 = 0\n```';
    const retry = 'STEP 1: SELECT id FROM orders\n```sql\nSELECT id FROM orders\n```';
    const { provider } = scripted([first, retry]);
    const pipeline = createPipeline({
      provider,
      decompose: true,
      emptyRetry: 'diagnosed',
      execute: async (sql) => ({ rows: sql.includes('1 = 0') ? 0 : 3 }),
    });
    const result = await pipeline.ask({ question: 'q', schema });
    expect(result.sql).toBe('SELECT id FROM orders');
    expect(result.emptyRetry).toEqual({ fired: true, recovered: true });
  });
});
