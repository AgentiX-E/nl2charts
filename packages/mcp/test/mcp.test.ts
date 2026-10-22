import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRunner } from '@agentix-e/nl2charts-core';
import type { Runner } from '@agentix-e/nl2charts-core';
import { createDuckDbEngine } from '@agentix-e/nl2charts-node';
import type { Engine } from '@agentix-e/nl2charts-core';
import { attachStreams, createDecoder, createMcpServer, encodeMessage } from '../src/index.js';

let engine: Engine;
let runner: Runner;
let server: ReturnType<typeof createMcpServer>;

beforeAll(async () => {
  engine = await createDuckDbEngine();
  runner = createRunner({ engine, maxRows: 5 });
  server = createMcpServer({ runner });
});

afterAll(async () => {
  await runner.close();
});

describe('ndjson framing', () => {
  it('decodes several messages from one chunk', () => {
    const decode = createDecoder();
    const messages = decode('{"jsonrpc":"2.0","method":"ping"}\n{"jsonrpc":"2.0","method":"ping"}\n');
    expect(messages).toHaveLength(2);
  });

  it('buffers a message split across chunks', () => {
    const decode = createDecoder();
    expect(decode('{"jsonrpc":"2.0","met')).toEqual([]);
    const messages = decode('hod":"ping"}\n');
    expect(messages[0]?.method).toBe('ping');
  });

  it('ignores blank lines and encodes with a trailing newline', () => {
    const decode = createDecoder();
    expect(decode('\n\n')).toEqual([]);
    expect(encodeMessage({ jsonrpc: '2.0', id: 1, result: {} })).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
  });
});

describe('mcp server', () => {
  it('answers initialize with server info and tool capability', async () => {
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(response?.result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'nl2charts', version: '0.1.0' },
      capabilities: { tools: {} },
    });
  });

  it('lists the guarded tools', async () => {
    const response = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (response?.result as { tools: { name: string }[] }).tools;
    // `query_metric` and `explain_metric` let a client name a metric instead of
    // writing SQL, which is the point of the semantic layer.
    expect(tools.map((tool) => tool.name).sort()).toEqual(['engine_info', 'explain_metric', 'query_metric', 'run_sql']);
  });

  it('runs a query through the guard and returns rows', async () => {
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'run_sql', arguments: { sql: 'select * from range(3) t(i)' } },
    });
    const content = (response?.result as { content: { text: string }[] }).content[0]?.text ?? '';
    const payload = JSON.parse(content) as { columns: string[]; rows: unknown[]; truncated: boolean };
    expect(payload.columns).toEqual(['i']);
    expect(payload.rows).toHaveLength(3);
    expect(payload.truncated).toBe(false);
  });

  it('refuses a destructive statement without executing it', async () => {
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'run_sql', arguments: { sql: 'drop table t' } },
    });
    expect(response?.error?.code).toBe(-32000);
    expect(response?.error?.message).toContain('NL2C_E_GUARD_REJECTED');
  });

  it('returns engine info', async () => {
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'engine_info', arguments: {} },
    });
    const text = (response?.result as { content: { text: string }[] }).content[0]?.text ?? '{}';
    expect(JSON.parse(text)).toMatchObject({ engine: 'duckdb-native', dialect: 'duckdb', maxRows: 5 });
  });

  it('rejects malformed requests with specific codes', async () => {
    expect((await server.handle({ jsonrpc: '1.0' as '2.0', id: 1, method: 'ping' }))?.error?.code).toBe(-32600);
    expect((await server.handle({ jsonrpc: '1.0' as '2.0', method: 'ping' }))?.id).toBeNull();
    expect((await server.handle({ jsonrpc: '2.0', id: 1, method: 'nope' }))?.error?.code).toBe(-32601);
    expect((await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }))?.error?.code).toBe(-32602);
    expect(
      (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } }))?.error?.code,
    ).toBe(-32602);
    expect(
      (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_sql', arguments: {} } }))?.error
        ?.code,
    ).toBe(-32602);
  });

  it('reports a runner failure as a tool error instead of a transport crash', async () => {
    const broken = createRunner({
      engine: {
        id: 'broken',
        dialect: 'duckdb',
        streaming: false,
        run: async () => {
          throw new Error('driver exploded');
        },
        close: async () => undefined,
      },
    });
    const brokenServer = createMcpServer({ runner: broken });
    const response = await brokenServer.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'run_sql', arguments: { sql: 'select 1' } },
    });
    expect(response?.error).toMatchObject({ code: -32000, message: 'NL2C_E_ENGINE_FAILED: engine failed' });
  });

  it('reports a non-contract failure without a code prefix', async () => {
    const raw = {
      capabilities: { engine: 'raw', dialect: 'raw', streaming: false, maxRows: 1 },
      sql: async () => {
        throw new Error('transport reset');
      },
      stream: async function* () {},
      close: async () => undefined,
    };
    const rawServer = createMcpServer({ runner: raw });
    const response = await rawServer.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'run_sql', arguments: { sql: 'select 1' } },
    });
    expect(response?.error).toMatchObject({ code: -32000, message: 'Error: transport reset' });
  });

  it('accepts a tools/call without params and answers a notification-shaped ping', async () => {
    expect(
      (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: null }))?.error?.code,
    ).toBe(-32602);
    const response = await server.handle({ jsonrpc: '2.0', method: 'ping' });
    expect(response).toMatchObject({ id: null, result: {} });
  });

  it('ignores notifications and answers ping', async () => {
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect((await server.handle({ jsonrpc: '2.0', id: 9, method: 'ping' }))?.result).toEqual({});
  });
});

describe('stdio attachment', () => {
  it('serves requests written to a stream and writes responses back', async () => {
    const input = new PassThrough();
    const chunks: string[] = [];
    const done = attachStreams(server, input, (chunk) => chunks.push(chunk));
    input.write(encodeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    input.end();
    await done;
    expect(chunks).toHaveLength(2);
    expect(JSON.parse(chunks[0] ?? '{}')).toMatchObject({ id: 1 });
    expect(JSON.parse(chunks[1] ?? '{}')).toMatchObject({ id: 2 });
  });
});
