/**
 * The decode mode as a request field, and the one place it must not be dropped.
 *
 * The mode used to be selected by choosing a model name. Names are aliases: `deepseek-chat` and
 * `deepseek-reasoner` were one base model's two modes, and both were later re-pointed at new
 * weights without a version change. A request that names the mode is the only form that survives
 * that, so the pipeline carries it — and every turn the pipeline makes has to receive it, not
 * just the first one.
 *
 * The defect this file is written against: the first version of the change spread the option into
 * an object literal passed to `auditStatement`, whose parameter type did not declare the field.
 * TypeScript does not apply the excess-property check across a spread, so it compiled, and the
 * audit turn would have run in a mode nobody chose — D49's shape exactly, where a declaration
 * that never reaches the mechanism reports as a mechanism that ran.
 */
import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/pipeline.js';
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
      model: 'deepseek-flash',
      complete: async (request) => {
        seen.push(request);
        const text = statements[Math.min(index, statements.length - 1)] ?? 'SELECT 1';
        index += 1;
        return { text, model: 'deepseek-flash' };
      },
    },
  };
}

describe('the decode mode travels with every turn', () => {
  it('reaches a single generation', async () => {
    const { provider, seen } = scripted(['SELECT region FROM orders']);
    await createPipeline({ provider, thinking: true }).ask({ question: 'list the regions', schema });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.thinking).toBe(true);
  });

  it('reaches the repair turn, not just the first call', async () => {
    // A mode that is honoured on the first call and forgotten on the repair turn produces a run
    // that is half of each, and the score of neither. The repair turn is the one that is easiest
    // to miss because it is assembled in a different function.
    const { provider, seen } = scripted(['SELECT region FROM', 'SELECT region FROM orders']);
    // The engine refuses the first statement, which is what opens the repair turn. An `execute`
    // that merely returns zero rows opens the *empty-result* turn instead, and a fixture that
    // used it would have asserted the wrong mechanism.
    let executed = 0;
    await createPipeline({
      provider,
      thinking: true,
      maxRepairs: 1,
      execute: async () => {
        executed += 1;
        if (executed === 1) throw new Error('near "FROM": syntax error');
        return { rows: 1 };
      },
    }).ask({ question: 'list the regions', schema });
    expect(seen.length).toBeGreaterThan(1);
    for (const request of seen) expect(request.thinking).toBe(true);
  });

  it('reaches the audit turn, which is the one a spread can silently drop', async () => {
    const { provider, seen } = scripted(['SELECT region FROM orders', 'MISSING: none']);
    await createPipeline({ provider, thinking: true, audit: 'conditions', maxRepairs: 0 }).ask({
      question: 'list the regions',
      schema,
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.purpose).toBe('audit');
    expect(seen[1]?.thinking).toBe(true);
  });

  it('sends no field at all when the deployment has no opinion', async () => {
    // Byte-identical to a request written before the field existed. This is the property that
    // keeps every published reading reproducible, and it is asserted on the request rather than
    // on the wire so that a future provider refactor cannot quietly add a default.
    const { provider, seen } = scripted(['SELECT region FROM orders']);
    await createPipeline({ provider }).ask({ question: 'list the regions', schema });
    expect(Object.hasOwn(seen[0] as object, 'thinking')).toBe(false);
  });
});
