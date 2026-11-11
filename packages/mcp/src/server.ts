import type { Runner } from '@agentix-e/nl2charts-core';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { JsonRpcRequest, JsonRpcResponse } from './jsonrpc.js';
import { encodeMessage } from './jsonrpc.js';
import { ASK_TOOL, askQuestion } from './ask.js';
import type { AskOptions } from './ask.js';
import { SEMANTIC_TOOLS, explainMetric, runQueryMetric } from './semantic.js';
import type { ToolFailure } from './semantic.js';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpServerOptions {
  readonly runner: Runner;
  readonly name?: string;
  readonly version?: string;
  /**
   * The question-to-SQL pipeline, when the deployment has an endpoint to call.
   *
   * Absent means the server offers the three tools it can answer without a model, which is
   * a real deployment: a server configured with no key must not advertise a tool whose
   * every call would fail. Present means `ask_question` is listed and callable, and the
   * list is built from the same value that dispatches the call so the two cannot disagree.
   */
  readonly ask?: AskOptions;
}

const BASE_TOOLS: readonly ToolDefinition[] = [
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
  ...SEMANTIC_TOOLS,
];

/**
 * The tool list, and the only place the list is built.
 *
 * `ask_question` is first-class rather than always-present-with-an-error: a client reads
 * `tools/list` to decide what it may call, so a tool that is listed and then fails on every
 * call is a capability the server claimed and does not have. The list is derived from the
 * same `options` the dispatcher reads, which is the property a second array would lose.
 */
export function toolsFor(options: McpServerOptions): readonly ToolDefinition[] {
  if (options.ask === undefined) return BASE_TOOLS;
  return [BASE_TOOLS[0] as ToolDefinition, ASK_TOOL, ...BASE_TOOLS.slice(1)];
}

/** A tool error becomes a JSON-RPC error, never a thrown exception. */
function failureResponse(id: JsonRpcResponse['id'], failed: ToolFailure): JsonRpcResponse {
  return failed.data === undefined
    ? errorResponse(id, failed.code, failed.message)
    : errorResponse(id, failed.code, failed.message, failed.data);
}

function isFailure(value: unknown): value is ToolFailure {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

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
  const tools = toolsFor(options);

  const callTool = async (toolName: string, args: Record<string, unknown>, id: JsonRpcResponse['id']): Promise<JsonRpcResponse> => {
    if (toolName === 'ask_question') {
      // Unreachable while the list is built from `options`, and checked anyway: a client
      // may call a tool it never listed, and the alternative to this branch is a call
      // that falls through to `unknown tool` and reads like the tool does not exist.
      if (options.ask === undefined) return errorResponse(id, -32602, 'ask_question requires a configured endpoint');
      const payload = await askQuestion({ runner: options.runner, ask: options.ask }, args);
      if (isFailure(payload)) return failureResponse(id, payload);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false } };
    }
    if (toolName === 'engine_info') {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(options.runner.capabilities) }] },
      };
    }
    if (toolName === 'query_metric') {
      const payload = await runQueryMetric({ runner: options.runner }, args);
      if (isFailure(payload)) return failureResponse(id, payload);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false } };
    }
    if (toolName === 'explain_metric') {
      const payload = explainMetric(args);
      if (isFailure(payload)) return failureResponse(id, payload);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false } };
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
    tools,
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
          return { jsonrpc: '2.0', id, result: { tools } };
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
