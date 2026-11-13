import { describe, expect, it } from 'vitest';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';
import { createPipeline } from '../src/pipeline.js';
import type { LlmMessage, LlmProvider, LlmResponse } from '../src/provider.js';
import type { SchemaTable } from '../src/linking.js';

/**
 * What a reply is, before what it says.
 *
 * Every case here was taken from a real reply. `deepseek-v4-pro` answered six of 992 Mini-Dev
 * questions with prose — "Let me recall: in SQLite, NULLs sort…", 83,036 characters of it on one
 * case — and the harness classified all six as guard rejections, with
 * `unsupported character "?"` as the reason it published. That sentence was false in a way that
 * costs money: the repair turn then told the model its *statement* was unsafe, so a model that
 * had written no statement spent the budget fixing a safety problem it did not have.
 *
 * The distinction this file holds is the one the pipeline did not make: a reply that is prose and
 * a reply that is an unsafe statement are different facts with different fixes.
 */
const schema: SchemaTable[] = [
  { table: 'orders', columns: [{ name: 'order_id', type: 'BIGINT' }, { name: 'region', type: 'VARCHAR' }] },
];

/** A provider that answers each call with the next scripted reply, and keeps what it was asked. */
function scripted(replies: readonly (string | Omit<LlmResponse, 'model'>)[]): LlmProvider & { readonly seen: LlmMessage[][] } {
  const seen: LlmMessage[][] = [];
  let index = 0;
  return {
    id: 'scripted',
    model: 'scripted',
    seen,
    complete: async (request) => {
      seen.push([...request.messages]);
      const next = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (next === undefined) throw new Error('no reply scripted for this call');
      return typeof next === 'string' ? { text: next, model: 'scripted' } : { ...next, model: 'scripted' };
    },
  };
}

const prose = 'Let me recall: in SQLite, NULLs sort first in DESC order. So the answer needs a subquery?';

describe('a reply that never became a statement', () => {
  it('is refused as a shape, not as an unsafe statement', async () => {
    // The failure was reported as `guard` with a lexical reason invented from the first character
    // the tokenizer could not place — the `?` in the model's own question to itself.
    const pipeline = createPipeline({ provider: scripted([prose]), maxRepairs: 0 });
    await expect(pipeline.ask({ question: 'top region', schema })).rejects.toSatisfy(
      (error: unknown) =>
        isNl2ChartsError(error) &&
        error.code === 'NL2C_E_ENGINE_FAILED' &&
        typeof error.details.lastError === 'string' &&
        error.details.lastError.startsWith('shape: ') &&
        error.details.lastError.includes('holds no statement'),
    );
  });

  it('says how much prose there was, so a sentence and a runaway go apart', async () => {
    const pipeline = createPipeline({ provider: scripted([prose]), maxRepairs: 0 });
    await expect(pipeline.ask({ question: 'top region', schema })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && String(error.details.lastError).includes(`${prose.length} chars`),
    );
  });

  it('carries the reply shape it read, so the profile counts the failure', async () => {
    const pipeline = createPipeline({ provider: scripted([prose]), maxRepairs: 0 });
    await expect(pipeline.ask({ question: 'top region', schema })).rejects.toSatisfy(
      (error: unknown) =>
        isNl2ChartsError(error) &&
        (error.details.lastShape as { fenced?: boolean } | undefined)?.fenced === false,
    );
  });

  it('asks for a statement on the repair turn, not for a safer one', async () => {
    const provider = scripted([prose, '```sql\nSELECT region FROM orders\n```']);
    const pipeline = createPipeline({ provider, maxRepairs: 1 });
    const result = await pipeline.ask({ question: 'top region', schema });
    expect(result.attempts).toBe(2);
    expect(result.failures).toEqual(['shape']);
    const repair = provider.seen[1]?.at(-1)?.content ?? '';
    expect(repair).toContain('That reply contained no SQL statement.');
    expect(repair).toContain('```sql block');
    // The guard's sentence would send it looking for a safety problem. It must not appear.
    expect(repair).not.toContain('rejected before it ran');
  });

  it('does not treat a statement the guard bans as prose', async () => {
    // `insert` is a statement this guard refuses, and refusing it is the whole point of the guard.
    // Classifying it as "no statement" would hide a write attempt inside a channel failure.
    const pipeline = createPipeline({ provider: scripted(['INSERT INTO orders VALUES (1, \'north\')']), maxRepairs: 0 });
    await expect(pipeline.ask({ question: 'top region', schema })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_GUARD_REJECTED',
    );
  });

  it('does not treat a placeholder as prose either', async () => {
    // `?` outside a literal is a real statement with an unbound parameter: it must still be a
    // guard rejection, because the fix is to write the value and not to write a statement.
    const pipeline = createPipeline({ provider: scripted(['SELECT region FROM orders WHERE region = ?']), maxRepairs: 0 });
    await expect(pipeline.ask({ question: 'top region', schema })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && error.code === 'NL2C_E_GUARD_REJECTED',
    );
  });

  it('refuses an empty reply as a shape too', async () => {
    const pipeline = createPipeline({ provider: scripted(['   \n  ']), maxRepairs: 0 });
    await expect(pipeline.ask({ question: 'top region', schema })).rejects.toSatisfy(
      (error: unknown) =>
        isNl2ChartsError(error) && String(error.details.lastError).startsWith('shape: ') && error.code === 'NL2C_E_ENGINE_FAILED',
    );
  });

  it('refuses a preamble that carries the statement inline', async () => {
    // The most tempting case to read leniently: the statement is right there. It is still not a
    // statement the guard can classify, because the guard reads from the first token — and
    // accepting a line-hunting reader here would make every prose reply a candidate again.
    const pipeline = createPipeline({ provider: scripted(['Here is the query: SELECT region FROM orders']), maxRepairs: 0 });
    await expect(pipeline.ask({ question: 'top region', schema })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && String(error.details.lastError).startsWith('shape: '),
    );
  });
});

describe('a reply the answer cap cut off', () => {
  it('is refused as a cut, naming the reason the endpoint gave', async () => {
    const pipeline = createPipeline({ provider: scripted([{ text: prose, finishReason: 'length' }]), maxRepairs: 0 });
    await expect(pipeline.ask({ question: 'top region', schema })).rejects.toSatisfy(
      (error: unknown) =>
        isNl2ChartsError(error) &&
        String(error.details.lastError).includes('finish=length') &&
        String(error.details.lastError).includes('stopped at the token cap'),
    );
  });

  it('prefers the cut over the guard, even when the reply opens with select', async () => {
    // The bytes are a prefix of what the model meant to write, so whatever the gate objects to is
    // a property of the cut. `SELECT region FROM orders WHERE region = 'nor` is not an unsafe
    // statement; it is half of one.
    const pipeline = createPipeline({ provider: scripted([{ text: "SELECT region FROM orders WHERE region = 'nor", finishReason: 'length' }]), maxRepairs: 0 });
    await expect(pipeline.ask({ question: 'top region', schema })).rejects.toSatisfy(
      (error: unknown) => isNl2ChartsError(error) && String(error.details.lastError).startsWith('shape: '),
    );
  });

  it('keeps a statement that parsed under the cut, and reports the cut', async () => {
    // Refusing this would turn a possible correct answer into a certain wrong one because of a cap
    // this repository chose. Reporting it is what lets the cap be priced instead of argued about.
    const pipeline = createPipeline({ provider: scripted([{ text: '```sql\nSELECT region FROM orders\n```', finishReason: 'length' }]) });
    const result = await pipeline.ask({ question: 'top region', schema });
    expect(result.sql).toBe('SELECT region FROM orders');
    expect(result.truncated).toBe(true);
  });

  it('says nothing about a cut when the reply was not cut', async () => {
    const pipeline = createPipeline({ provider: scripted([{ text: '```sql\nSELECT region FROM orders\n```', finishReason: 'stop' }]) });
    const result = await pipeline.ask({ question: 'top region', schema });
    expect('truncated' in result).toBe(false);
  });

  it('does not claim a cut for a provider that reports no reason', async () => {
    // Absent is not `length`: a hand-written provider reports nothing, and treating silence as a
    // cut would label every reply from it as truncated.
    const pipeline = createPipeline({ provider: scripted(['```sql\nSELECT region FROM orders\n```']) });
    const result = await pipeline.ask({ question: 'top region', schema });
    expect('truncated' in result).toBe(false);
  });
});
