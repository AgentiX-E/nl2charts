/**
 * The Spider asker: the prompt, the reader it borrows, and the gates it refuses behind.
 *
 * No test here asserts accuracy — that is a fact about the model, and the workflow's dispatches are
 * where it is measured. What is asserted is everything that would make such a number mean something
 * else: the schema the model is shown, the statement that is read out of the reply, and the run that
 * is not allowed to publish at all.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmProvider, LlmResponse } from '@agentix-e/nl2charts-ai';
import {
  BUDGET_YUAN,
  PER_CASE,
  PROMPT_VERSION,
  askAll,
  columnsOf,
  databaseOf,
  main,
  predictionsText,
  promptFor,
  projectedYuan,
  reportLines,
  resolveSettings,
  runsAsMain,
  schemaText,
  start,
  tallyOf,
  type Database,
} from '../eval/spider/ask.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dirOf(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spider-ask-'));
  dirs.push(dir);
  return dir;
}

const SHOP: Database = {
  db_id: 'shop',
  table_names_original: ['singer', 'concert'],
  column_names_original: [
    [-1, '*'],
    [0, 'singer_id'],
    [0, 'name'],
    [1, 'concert_id'],
    [1, 'singer_id'],
  ],
  column_types: ['text', 'number', 'text', 'number', 'number'],
  foreign_keys: [[4, 1]],
};

const AIRLINE: Database = { ...SHOP, db_id: 'airline', table_names_original: ['flights'], column_names_original: [[-1, '*'], [0, 'id']] };

/** A corpus the asker can read: two questions, two databases, no network. */
function corpus(): string {
  const dir = dirOf();
  writeFileSync(
    join(dir, 'dev.json'),
    `${JSON.stringify([{ db_id: 'shop', question: 'How many singers?', query: 'SELECT count(*) FROM singer' }])}\n`,
  );
  writeFileSync(join(dir, 'tables.json'), JSON.stringify([SHOP, AIRLINE]));
  return dir;
}

const providerOf = (answer: () => LlmResponse | Promise<LlmResponse>): LlmProvider => ({
  id: 'test',
  model: 'deepseek-chat',
  complete: async () => answer(),
});

describe('the schema is the observation, so its shape is asserted', () => {
  it('writes a CREATE TABLE per table, with the corpus\'s own type words', () => {
    const text = schemaText(SHOP);
    expect(text).toContain('CREATE TABLE singer (');
    expect(text).toContain('  singer_id NUMBER');
    expect(text).toContain('  name TEXT');
    expect(text).toContain('CREATE TABLE concert (');
  });

  it('writes a foreign key as a comment, because the model is not asked to run the DDL', () => {
    expect(schemaText(SHOP)).toContain('-- concert.singer_id references singer.singer_id');
  });

  it('keeps the columns of a table in declaration order, which is what the judge resolves against', () => {
    expect(columnsOf(SHOP, 0).map((column) => column.name)).toEqual(['singer_id', 'name']);
    expect(columnsOf(SHOP, 1).map((column) => column.name)).toEqual(['concert_id', 'singer_id']);
  });

  it('names the database it cannot find instead of sending an empty schema', () => {
    expect(() => databaseOf([SHOP], 'nope')).toThrow('tables.json does not describe nope');
  });

  it('carries the question, the schema, and the one instruction a compositional corpus needs', () => {
    const [system, user] = promptFor('Which singer has the most concerts?', SHOP);
    expect(system?.content).toContain('one SQLite statement');
    expect(user?.content).toContain('"shop"');
    expect(user?.content).toContain('CREATE TABLE singer (');
    expect(user?.content).toContain('Question: Which singer has the most concerts?');
    expect(user?.content).toContain('ORDER BY and LIMIT');
    // The corpus has no rows, so a prompt that promised any would be describing a corpus that is
    // not this one.
    expect(user?.content).not.toContain('rows');
  });

  it('is a version, because two prompts are two instruments', () => {
    expect(PROMPT_VERSION).toBe('spider-ask@1');
  });
});

describe('the projection, because a bill is authorised before the calls', () => {
  it('prices the split at the per-case bound and offers nothing for an unpriced model', () => {
    expect(projectedYuan(1_034, 'deepseek-chat')).toBeCloseTo((projectedYuan(1, 'deepseek-chat') as number) * 1_034, 9);
    expect(projectedYuan(10, 'a-model-with-no-row')).toBeUndefined();
    expect(PER_CASE.promptTokens).toBeGreaterThanOrEqual(900);
    expect(PER_CASE.completionTokens).toBeGreaterThanOrEqual(120);
    expect(BUDGET_YUAN).toBe(45);
  });

  it('refuses a dispatch over the ceiling, and runs when the caller names one', async () => {
    const cache = corpus();
    const out = join(dirOf(), 'p.jsonl');
    const lines: string[] = [];
    const over = await main(['--cache', cache, '--out', out, '--budget', '0.001'], {
      provider: providerOf(() => ({ text: 'SELECT count(*) FROM singer', model: 'deepseek-chat' })),
      log: (line) => lines.push(line),
    });
    expect(over).toBe(4);
    expect(lines.join('\n')).toContain('REFUSED');
    const ok = await main(['--cache', cache, '--out', out, '--accept-cost', '1'], {
      provider: providerOf(() => ({ text: 'SELECT count(*) FROM singer', model: 'deepseek-chat' })),
      log: (line) => lines.push(line),
    });
    expect(ok).toBe(0);
  });

  it('refuses to project a model it has no price for, unless the caller says the ceiling', async () => {
    const lines: string[] = [];
    const code = await main(['--cache', corpus(), '--out', join(dirOf(), 'p.jsonl')], {
      provider: { id: 'test', model: 'a-model-with-no-row', complete: async () => ({ text: 'SELECT 1', model: 'x' }) },
      log: (line) => lines.push(line),
    });
    expect(code).toBe(4);
    expect(lines.join('\n')).toContain('no price on file');
  });
});

describe('asking', () => {
  it('asks every question once, in corpus order, and keeps its index', async () => {
    const cache = corpus();
    const questions = [{ db_id: 'shop', question: 'q', query: 'SELECT count(*) FROM singer' }];
    const records = await askAll(questions, [SHOP, AIRLINE], providerOf(() => ({ text: 'SELECT count(*) FROM singer', model: 'deepseek-chat' })), 2);
    expect(records.map((record) => record.index)).toEqual([0]);
    expect(records[0]?.sql).toBe('SELECT count(*) FROM singer');
    expect(cache).toContain('spider-ask-');
  });

  it('reads the statement out of a fenced reply, with the reader WikiSQL already uses', async () => {
    const records = await askAll(
      [{ db_id: 'shop', question: 'q', query: 'SELECT 1' }],
      [SHOP],
      providerOf(() => ({ text: '```sql\nSELECT name FROM singer;\n```', model: 'deepseek-chat' })),
      1,
    );
    expect(records[0]?.sql).toBe('SELECT name FROM singer');
  });

  it('counts a reply cut at the token cap as unreadable rather than as a statement', async () => {
    const records = await askAll(
      [{ db_id: 'shop', question: 'q', query: 'SELECT 1' }],
      [SHOP],
      providerOf(() => ({ text: 'SELECT name FROM', model: 'deepseek-chat', finishReason: 'length' })),
      1,
    );
    expect(records[0]?.truncated).toBe(true);
    expect(records[0]?.sql).toBeUndefined();
    expect(tallyOf(records).unreadable).toBe(1);
  });

  it('records a failed call instead of throwing, so one 429 does not end a run', async () => {
    const records = await askAll(
      [{ db_id: 'shop', question: 'q', query: 'SELECT 1' }],
      [SHOP],
      providerOf(() => Promise.reject(new Error('429'))),
      1,
    );
    expect(records[0]?.error).toBe('429');
    expect(tallyOf(records).failed).toBe(1);
  });
});

describe('what a run writes and what it says', () => {
  it('writes only the answers, so the judge sees a predictions file', () => {
    const text = predictionsText([
      { index: 0, sql: 'SELECT 1', reply: '', truncated: false, error: undefined },
      { index: 1, sql: undefined, reply: 'no select here', truncated: false, error: undefined },
    ]);
    expect(text).toBe('{"index":0,"sql":"SELECT 1"}\n');
    expect(predictionsText([])).toBe('');
  });

  it('reports the share that was not read, in the same shape as the WikiSQL asker', () => {
    const lines = reportLines({ asked: 10, answered: 9, unreadable: 1, truncated: 0, failed: 0 }, '¥0.01');
    expect(lines.join('\n')).toContain('unreadable 1 (10.0%)');
    expect(lines.join('\n')).toContain('bill ¥0.01');
  });

  it('writes the predictions and the evidence for a refusal, and refuses past the 1% ceiling', async () => {
    const cache = corpus();
    const out = join(dirOf(), 'p.jsonl');
    const lines: string[] = [];
    const code = await main(['--cache', cache, '--out', out, '--accept-cost', '1'], {
      provider: providerOf(() => ({ text: 'I cannot answer that.', model: 'deepseek-chat' })),
      log: (line) => lines.push(line),
    });
    expect(code).toBe(3);
    expect(readFileSync(`${out.replace(/\.jsonl$/u, '')}.unreadable.jsonl`, 'utf8')).toContain('I cannot answer that.');
  });
});

describe('the paths a green run does not take', () => {
  it('reads every flag it documents, including the ceiling pair', () => {
    const settings = resolveSettings(['--limit', '3', '--out', 'x.jsonl', '--cache', '/tmp/c', '--concurrency', '2', '--accept-cost', '5', '--budget', '9']);
    expect(settings).toMatchObject({ limit: 3, out: 'x.jsonl', cache: '/tmp/c', concurrency: 2, acceptCost: 5, budget: 9 });
  });

  it('runs an unpriced model when the caller names the ceiling, and prints no bill when it has no price', async () => {
    const lines: string[] = [];
    const code = await main(['--cache', corpus(), '--out', join(dirOf(), 'p.jsonl'), '--accept-cost', '9'], {
      provider: { id: 'test', model: 'a-model-with-no-row', complete: async () => ({ text: 'SELECT 1', model: 'x' }) },
      log: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    // No price means no bill line: a zero would read as free.
    expect(lines.join('\n')).not.toContain('bill');
  });

  it('falls back to text when the corpus declares fewer types than columns, and omits absent keys', () => {
    const sparse: Database = {
      db_id: 'x',
      table_names_original: ['t'],
      column_names_original: [[-1, '*'], [0, 'a'], [0, 'b']],
      column_types: ['text', 'number'],
    };
    const text = schemaText(sparse);
    expect(text).toContain('  b TEXT');
    expect(text).not.toContain('references');
  });

  it('records a rejection that is not an Error, because an endpoint can throw a string', async () => {
    const records = await askAll(
      [{ db_id: 'shop', question: 'q', query: 'SELECT 1' }],
      [SHOP],
      providerOf(() => Promise.reject('socket closed')),
      1,
    );
    expect(records[0]?.error).toBe('socket closed');
  });

  it('builds its own provider from the environment and writes to stdout when no logger is given', async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await main(['--cache', corpus(), '--out', join(dirOf(), 'p.jsonl'), '--accept-cost', '1'], {
        env: { LLM_API_KEY: 'k', LLM_MODEL: 'deepseek-chat' },
        fetch: (async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: 'SELECT count(*) FROM singer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )) as unknown as typeof fetch,
      });
      expect(code).toBe(0);
      expect(written.join('')).toContain('spider ask: 1 question(s)');
    } finally {
      process.stdout.write = original;
    }
  });

  it('refuses a run with no key, naming the variable rather than the endpoint', async () => {
    await expect(main(['--cache', corpus(), '--out', join(dirOf(), 'p.jsonl')], { env: {} })).rejects.toThrow(
      /Set LLM_API_KEY/u,
    );
  });

  it('writes the failure to stderr when the entry is given no printer', async () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await start('/x/eval/spider/ask.ts', async () => {
        throw new Error('no key');
      }, () => {});
      expect(written.join('')).toContain('no key');
    } finally {
      process.stderr.write = original;
    }
  });

  it('reports a table index the declaration does not have as no columns, not as a crash', () => {
    expect(columnsOf(SHOP, 9)).toEqual([]);
  });

  it('records a question whose database is not declared, instead of ending the run', async () => {
    const records = await askAll(
      [{ db_id: 'gone', question: 'q', query: 'SELECT 1' }],
      [SHOP],
      providerOf(() => ({ text: 'SELECT 1', model: 'deepseek-chat' })),
      1,
    );
    expect(records[0]?.error).toBe('tables.json does not describe gone');
  });

  it('fails loudly when the corpus directory has no questions', async () => {
    await expect(
      main(['--cache', dirOf(), '--out', join(dirOf(), 'p.jsonl')], {
        provider: providerOf(() => ({ text: 'SELECT 1', model: 'deepseek-chat' })),
        log: () => {},
      }),
    ).rejects.toThrow(/ENOENT/u);
  });

  it('reports a run with no bill line when the model has no price', () => {
    expect(reportLines({ asked: 1, answered: 1, unreadable: 0, truncated: 0, failed: 0 }, undefined)).toHaveLength(3);
  });
});

describe('the flags and the entry', () => {
  it('defaults to dev, no limit, six in flight, one predictions file and the schema arm', () => {
    expect(resolveSettings([])).toEqual({
      split: 'dev',
      limit: undefined,
      out: 'eval/out/spider-predictions.jsonl',
      cache: undefined,
      concurrency: 6,
      arm: 'schema',
      acceptCost: undefined,
      budget: 45,
    });
  });

  it('refuses a limit or a concurrency that would publish an empty or unordered run', () => {
    expect(() => resolveSettings(['--limit', '0'])).toThrow('positive integer');
    expect(() => resolveSettings(['--concurrency', '0'])).toThrow('positive integer');
    expect(() => resolveSettings(['--accept-cost', '0'])).toThrow('positive number of yuan');
    expect(() => resolveSettings(['--budget', '0'])).toThrow('positive number of yuan');
  });

  it('runs only when it is the entry, and exits with the code the run returned', async () => {
    expect(runsAsMain('/x/eval/spider/ask.ts')).toBe(true);
    expect(runsAsMain('/x/eval/wikisql/ask.ts')).toBe(false);
    const codes: number[] = [];
    await start('/x/eval/spider/ask.ts', async () => 7, (code) => codes.push(code));
    expect(codes).toEqual([7]);
    const errors: string[] = [];
    await start('/x/eval/spider/ask.ts', async () => {
      throw new Error('boom');
    }, (code) => codes.push(code), (line) => errors.push(line));
    expect(errors).toEqual(['boom']);
    expect(codes).toEqual([7, 1]);
    await start('/x/other.ts', async () => 9, (code) => codes.push(code));
    expect(codes).toEqual([7, 1]);
  });
});
