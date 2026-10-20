import type { Runner } from '@agentix-e/nl2charts-core';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { JsonRpcRequest, JsonRpcResponse } from './jsonrpc.js';
import { encodeMessage } from './jsonrpc.js';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpServerOptions {
  readonly runner: Runner;
  readonly name?: string;
  readonly version?: string;
}

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'run_sql',
    description: 'Run one read-only SQL statement and return rows.',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'engine_info',
    description: 'Return the engine id, dialect and row cap.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function errorResponse(id: JsonRpcResponse['id'], code: number, message: string, data?: unknown): JsonRpcResponse {
  return data === undefined
    ? { jsonrpc: '2.0', id, error: { code, message } }
    : { jsonrpc: '2.0', id, error: { code, message, data } };
}

export function createMcpServer(options: McpServerOptions): {
  tools: readonly ToolDefinition[];
  handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null>;
  handleLine(line: string): Promise<JsonRpcResponse | null>;
} {
  const name = options.name ?? 'nl2charts';
  const version = options.version ?? '0.1.0';

  const callTool = async (toolName: string, args: Record<string, unknown>, id: JsonRpcResponse['id']): Promise<JsonRpcResponse> => {
    if (toolName === 'engine_info') {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(options.runner.capabilities) }] },
      };
    }
    if (toolName !== 'run_sql') return errorResponse(id, -32602, `unknown tool: ${toolName}`);
    const sql = args.sql;
    if (typeof sql !== 'string') return errorResponse(id, -32602, 'run_sql requires a string sql argument');
    try {
      const result = await options.runner.sql(sql);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ columns: result.columns, rows: result.rows, truncated: result.truncated }),
            },
          ],
          isError: false,
        },
      };
    } catch (error) {
      // A runner failure is reported as a tool error, never as a transport crash.
      return isNl2ChartsError(error)
        ? errorResponse(id, -32000, `${error.code}: ${error.message}`, error.details)
        : errorResponse(id, -32000, String(error));
    }
  };

  return {
    tools: TOOLS,
    async handle(request) {
      if (request.jsonrpc !== '2.0') return errorResponse(request.id ?? null, -32600, 'jsonrpc must be "2.0"');
      const id = request.id ?? null;
      if (id === null && request.method.startsWith('notifications/')) return null;

      switch (request.method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-06-18',
              serverInfo: { name, version },
              capabilities: { tools: {} },
            },
          };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
        case 'tools/call': {
          const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
          if (typeof params.name !== 'string') return errorResponse(id, -32602, 'tools/call requires a tool name');
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          return callTool(params.name, args, id);
        }
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        default:
          return errorResponse(id, -32601, `method not found: ${request.method}`);
      }
    },
    async handleLine(line) {
      const request = JSON.parse(line) as JsonRpcRequest;
      return this.handle(request);
    },
  };
}

/** Wire a server to newline-delimited streams (stdio, socket, test pipeline). */
export async function attachStreams(
  server: ReturnType<typeof createMcpServer>,
  input: AsyncIterable<string>,
  write: (chunk: string) => void,
): Promise<void> {
  let buffer = '';
  for await (const chunk of input) {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        const response = await server.handleLine(line);
        if (response) write(encodeMessage(response));
      }
      index = buffer.indexOf('\n');
    }
  }
}
