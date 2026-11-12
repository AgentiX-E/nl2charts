import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRunner } from '@agentix-e/nl2charts-core';
import type { Engine, Runner } from '@agentix-e/nl2charts-core';
import type { LlmProvider, LlmRequest, LlmResponse } from '@agentix-e/nl2charts-ai';
import { Nl2ChartsError } from '@agentix-e/nl2charts-spec';
import { createDuckDbEngine } from '@agentix-e/nl2charts-node';
import { asSchema, askQuestion, createMcpServer, toolsFor } from '../src/index.js';

/**
 * `ask_question` is the only tool that needs a model, so every test here supplies one.
 *
 * The provider is a script rather than a replay file: the tool's contract is "what the
 * model wrote, executed, returned", and a script that returns a statement is the smallest
 * thing that produces a real row set from a real engine. The engine is DuckDB, as in the
 * other server tests, so the statement is parsed and run rather than echoed.
 */

let engine: Engine;
let runner: Runner;

beforeAll(async () => {
  engine = await createDuckDbEngine();
  runner = createRunner({ engine, maxRows: 5 });
});

afterAll(async () => {
  await runner.close();
});

/** A provider that answers with a fixed statement, and records what it was asked. */
function scripted(statements: readonly string[]): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  let next = 0;
  return {
    id: 'scripted',
    model: 'scripted-1',
    requests,
    async complete(request: LlmRequest): Promise<LlmResponse> {
      requests.push(request);
      const text = statements[Math.min(next, statements.length - 1)] ?? '';
      next += 1;
      return { text, model: 'scripted-1' };
    },
  };
}

const schema = [
  {
    table: 'greetings',
    columns: [
      { name: 'id', type: 'INTEGER' },
      { name: 'word', type: 'VARCHAR', comment: 'The greeting itself.' },
    ],
  },
];

/**
 * The seed goes through the engine, not the runner.
 *
 * The runner's guard admits read-only statements by design, so a test that seeded through
 * it would be testing the guard rather than the tool. The engine is the same connection the
 * runner reads from, which is what makes the rows visible to the statement under test.
 */
async function seed(): Promise<void> {
  await engine.run('DROP TABLE IF EXISTS greetings');
  await engine.run('CREATE TABLE greetings (id INTEGER, word VARCHAR)');
  await engine.run("INSERT INTO greetings VALUES (1, 'hello'), (2, 'goodbye')");
}

describe('the tool list', () => {
  it('does not advertise a tool the deployment cannot answer', () => {
    const tools = toolsFor({ runner });
    expect(tools.map((tool) => tool.name)).not.toContain('ask_question');
  });

  it('lists ask_question second when an endpoint is configured', () => {
    const tools = toolsFor({ runner, ask: { provider: scripted(['SELECT 1']) } });
    expect(tools.map((tool) => tool.name)).toEqual([
      'run_sql',
      'ask_question',
      'engine_info',
      'query_metric',
      'explain_metric',
    ]);
  });

  it('serves the same list from tools/list as it dispatches', async () => {
    const server = createMcpServer({ runner, ask: { provider: scripted(['SELECT 1']) } });
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((response?.result as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual(
      toolsFor({ runner, ask: { provider: scripted(['SELECT 1']) } }).map((tool) => tool.name),
    );
  });

  it('refuses a call to a tool it did not list', async () => {
    const server = createMcpServer({ runner });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ask_question', arguments: { question: 'hi', schema } },
    });
    expect(response?.error?.code).toBe(-32602);
    expect(response?.error?.message).toContain('configured endpoint');
  });
});

describe('asking a question', () => {
  it('generates, executes and returns the statement with its rows', async () => {
    await seed();
    const provider = scripted(['SELECT word FROM greetings ORDER BY id']);
    const server = createMcpServer({ runner, ask: { provider } });
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'ask_question', arguments: { question: 'list the greetings', schema } },
    });
    const payload = JSON.parse((response?.result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>;
    expect(payload.sql).toBe('SELECT word FROM greetings ORDER BY id');
    expect(payload.rows).toEqual([{ word: 'hello' }, { word: 'goodbye' }]);
    expect(payload.rowCount).toBe(2);
    expect(payload.attempts).toBe(1);
    expect(payload.question).toBe('list the greetings');
  });

  it('clamps the preview to the runner cap without rewriting the statement', async () => {
    await seed();
    const payload = (await askQuestion(
      { runner, ask: { provider: scripted(['SELECT word FROM greetings ORDER BY id']) } },
      { question: 'list the greetings', schema, preview: 500 },
    )) as Record<string, unknown>;
    // The runner is capped at five rows; two exist, so the clamp is invisible in the count
    // and visible in the statement, which still carries no limit of its own.
    expect(payload.sql).toBe('SELECT word FROM greetings ORDER BY id');
    expect(payload.rowCount).toBe(2);
  });

  it('repairs a statement the engine refuses, and says it took two attempts', async () => {
    await seed();
    const provider = scripted(['SELECT nope FROM greetings', 'SELECT word FROM greetings ORDER BY id']);
    const payload = (await askQuestion(
      { runner, ask: { provider, maxRepairs: 2 } },
      { question: 'list the greetings', schema },
    )) as Record<string, unknown>;
    expect(payload.sql).toBe('SELECT word FROM greetings ORDER BY id');
    expect(payload.attempts).toBe(2);
    expect((payload.failures as string[]).length).toBe(1);
  });

  it('passes the caller dialect and evidence into the prompt the model sees', async () => {
    await seed();
    const provider = scripted(['SELECT word FROM greetings ORDER BY id']);
    await askQuestion(
      { runner, ask: { provider } },
      { question: 'list the greetings', schema, evidence: 'A greeting is a word said on arrival.', dialect: 'SQLite' },
    );
    const system = provider.requests[0]?.messages[0]?.content ?? '';
    expect(system).toContain('A greeting is a word said on arrival.');
    expect(system).toContain('SQLite');
  });

  it('falls back to the runner dialect when the caller names none', async () => {
    await seed();
    const provider = scripted(['SELECT word FROM greetings ORDER BY id']);
    await askQuestion({ runner, ask: { provider } }, { question: 'list the greetings', schema });
    expect(provider.requests[0]?.messages[0]?.content ?? '').toContain(runner.capabilities.dialect);
  });

  it('reports a provider failure as a tool error, not a crash', async () => {
    const provider: LlmProvider = {
      id: 'broken',
      model: 'broken-1',
      async complete(): Promise<LlmResponse> {
        throw new Error('endpoint is down');
      },
    };
    const payload = await askQuestion({ runner, ask: { provider } }, { question: 'list', schema });
    expect(payload).toMatchObject({ code: -32000, message: 'endpoint is down' });
  });
});

describe('argument validation', () => {
  it('refuses a question that is missing or blank', async () => {
    const context = { runner, ask: { provider: scripted(['SELECT 1']) } };
    expect(await askQuestion(context, { schema })).toMatchObject({ code: -32602 });
    expect(await askQuestion(context, { question: '   ', schema })).toMatchObject({ code: -32602 });
  });

  it('refuses a schema that names no table', async () => {
    const context = { runner, ask: { provider: scripted(['SELECT 1']) } };
    expect(await askQuestion(context, { question: 'q', schema: [] })).toMatchObject({ code: -32602 });
    expect(await askQuestion(context, { question: 'q' })).toMatchObject({ code: -32602 });
  });

  it('refuses a table with no columns, because an empty card invites invented ones', async () => {
    const context = { runner, ask: { provider: scripted(['SELECT 1']) } };
    const payload = await askQuestion(context, { question: 'q', schema: [{ table: 't', columns: [] }] });
    expect(payload).toMatchObject({ code: -32602 });
    expect((payload as { message: string }).message).toContain('at least one column');
  });

  it('refuses a preview below one row', async () => {
    const context = { runner, ask: { provider: scripted(['SELECT 1']) } };
    expect(await askQuestion(context, { question: 'q', schema, preview: 0 })).toMatchObject({ code: -32602 });
  });

  it('keeps the optional parts of a column and drops the ones of the wrong type', () => {
    const parsed = asSchema([
      {
        table: 't',
        columns: [{ name: 'c', type: 'TEXT', comment: 'why', samples: ['a', 7], aliases: ['d'] }],
        foreignKeys: ['t.id = u.id', 3],
      },
    ]);
    expect(parsed).toEqual([
      { table: 't', columns: [{ name: 'c', type: 'TEXT', comment: 'why', samples: ['a'], aliases: ['d'] }], foreignKeys: ['t.id = u.id'] },
    ]);
  });
});

describe('the schema is validated rather than trusted', () => {
  it('refuses a schema whose entries are not objects', () => {
    expect(asSchema(['orders'])).toMatchObject({ code: -32602 });
    expect(asSchema([null])).toMatchObject({ code: -32602 });
  });

  it('refuses a table with no name, and one whose name is empty', () => {
    expect(asSchema([{ columns: [{ name: 'c', type: 'TEXT' }] }])).toMatchObject({ code: -32602 });
    expect(asSchema([{ table: '', columns: [{ name: 'c', type: 'TEXT' }] }])).toMatchObject({ code: -32602 });
  });

  it('refuses columns that are not a list, and entries that are not columns', () => {
    expect(asSchema([{ table: 't', columns: 'id INTEGER' }])).toMatchObject({ code: -32602 });
    expect(asSchema([{ table: 't', columns: [{ name: 'id' }] }])).toMatchObject({ code: -32602 });
    expect(asSchema([{ table: 't', columns: [null] }])).toMatchObject({ code: -32602 });
  });

  it('drops foreign keys that are not strings, and keeps the table', () => {
    expect(asSchema([{ table: 't', columns: [{ name: 'c', type: 'TEXT' }], foreignKeys: [1, 2] }])).toEqual([
      { table: 't', columns: [{ name: 'c', type: 'TEXT' }], foreignKeys: [] },
    ]);
  });
});

describe('a contract error keeps its code', () => {
  it('reports an NL2C_E_ code as a tool error that names it', async () => {
    const provider: LlmProvider = {
      id: 'refusing',
      model: 'refusing-1',
      async complete(): Promise<LlmResponse> {
        throw new Nl2ChartsError('NL2C_E_LLM_REJECTED', 'the endpoint refused the request');
      },
    };
    const payload = await askQuestion({ runner, ask: { provider } }, { question: 'list', schema });
    expect(payload).toMatchObject({ code: -32000 });
    expect((payload as { message: string }).message).toContain('NL2C_E_LLM_REJECTED');
  });
});

describe('the hint the server sends', () => {
  /** The user turn's first line, which is where the linker's hint is printed. */
  const hintOf = (request: LlmRequest): string => {
    const user = request.messages.find((message) => message.role === 'user');
    return (user?.content ?? '').split('\n')[0] ?? '';
  };

  it('does not read the caller evidence unless the deployment asked for it', async () => {
    // The default. A server whose hint started reading `evidence` because a caller supplied it
    // would answer one question two different ways depending on a switch nobody flipped.
    const provider = scripted(['SELECT count(*) FROM greetings']);
    await askQuestion(
      { runner, ask: { provider } },
      { question: 'How many rows are there?', schema, evidence: 'The word column holds the greeting.' },
    );
    expect(hintOf(provider.requests[0] as LlmRequest)).toBe('No column matched; use the schema above.');
  });

  it('names a column the evidence mentions when the deployment turned it on', async () => {
    const provider = scripted(['SELECT count(*) FROM greetings']);
    await askQuestion(
      { runner, ask: { provider, linkEvidence: true } },
      { question: 'How many rows are there?', schema, evidence: 'The word column holds the greeting.' },
    );
    expect(hintOf(provider.requests[0] as LlmRequest)).toContain('greetings.word');
  });

  it('behaves as before when the switch is on and the request carries no evidence', async () => {
    const provider = scripted(['SELECT count(*) FROM greetings']);
    await askQuestion({ runner, ask: { provider, linkEvidence: true } }, { question: 'How many rows are there?', schema });
    expect(hintOf(provider.requests[0] as LlmRequest)).toBe('No column matched; use the schema above.');
  });
});
