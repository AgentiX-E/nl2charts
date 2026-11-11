import { createPipeline } from '@agentix-e/nl2charts-ai';
import type { LlmProvider, SchemaColumn, SchemaTable } from '@agentix-e/nl2charts-ai';
import type { Runner } from '@agentix-e/nl2charts-core';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { ToolDefinition } from './server.js';
import type { ToolFailure } from './semantic.js';

/**
 * The question-to-SQL pipeline as a tool.
 *
 * `run_sql` and `query_metric` both require the caller to already know the statement or
 * the metric. The capability this project is named for — a question in, a statement
 * out — had no tool at all: `packages/ai` builds it, no package imported `packages/ai`,
 * so a server that speaks MCP could answer "run this SQL" and could not answer "what
 * does this question mean in SQL". This module is that missing edge.
 *
 * Three decisions are load-bearing here and each one is a way the tool can lie:
 *
 * 1. **The schema is the caller's, not the engine's.** Reading a schema out of a live
 *    database needs a driver, and `mcp` cannot depend on `node` (PLT4). So the caller
 *    passes the tables it wants the model to see, and the tool declines a call that
 *    passes none rather than inventing a schema. That is also what makes the tool
 *    usable against a warehouse whose catalog is behind a different credential.
 * 2. **The statement is executed before it is returned.** A pipeline that stops at the
 *    text has not delivered an answer, and an unexecuted statement is exactly the
 *    failure class `ask` exists to repair. Execution is also what lets the repair loop
 *    fire, so `attempts` means something.
 * 3. **The row cap is the runner's.** A caller's `preview` is a request; the server's
 *    `maxRows` is the permission, and a tool that forwarded the first as the second
 *    would let a client read a table it was never granted.
 */

/** What a caller must supply for the model to see a column. */
const COLUMN_SCHEMA = {
  type: 'object',
  description: 'One column: name, storage type, and optional business meaning.',
  properties: {
    name: { type: 'string' },
    type: { type: 'string' },
    comment: { type: 'string', description: 'One-line business meaning, shown in the schema card.' },
    samples: { type: 'array', items: { type: 'string' }, description: 'Stored values, for enum columns.' },
    aliases: { type: 'array', items: { type: 'string' }, description: 'Other names the business uses.' },
  },
  required: ['name', 'type'],
  additionalProperties: false,
} as const;

const TABLE_SCHEMA = {
  type: 'object',
  description: 'One table the question may read.',
  properties: {
    table: { type: 'string' },
    columns: { type: 'array', items: COLUMN_SCHEMA, minItems: 1 },
    foreignKeys: {
      type: 'array',
      items: { type: 'string' },
      description: 'Join hints, one per line, e.g. orders.customer_id = customers.id.',
    },
  },
  required: ['table', 'columns'],
  additionalProperties: false,
} as const;

export const ASK_TOOL: ToolDefinition = {
  name: 'ask_question',
  description:
    'Turn a natural-language question into one read-only SQL statement against the tables supplied, execute it, and return the rows with the statement. Prefer this over run_sql when the caller does not already know the SQL: the statement is generated, guarded, repaired once if the engine refuses it, and returned alongside its result so the caller can audit it.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, in the user\'s own words.' },
      schema: { type: 'array', items: TABLE_SCHEMA, minItems: 1, description: 'Tables the statement may read.' },
      dialect: { type: 'string', description: 'SQL dialect, e.g. SQLite or DuckDB. Defaults to the runner\'s.' },
      evidence: {
        type: 'string',
        description: 'Optional notes that explain business terms, as a data dictionary would.',
      },
      preview: {
        type: 'integer',
        minimum: 1,
        description: 'Rows to return. Clamped to the server\'s cap; the statement is not rewritten.',
      },
    },
    required: ['question', 'schema'],
    additionalProperties: false,
  },
};

/** What the server needs to answer a question. `provider` is the only required part. */
export interface AskOptions {
  readonly provider: LlmProvider;
  /** Columns the linker may hint at. The schema card itself is never truncated by it. */
  readonly topK?: number;
  /** Repair turns after the first refusal. Zero disables execution. */
  readonly maxRepairs?: number;
  /** Fixed dialect, when the deployment knows it and the caller should not choose. */
  readonly dialect?: string;
}

export interface AskContext {
  readonly runner: Runner;
  readonly ask: AskOptions;
}

const INVALID = -32602;

function failure(error: unknown): ToolFailure {
  return isNl2ChartsError(error)
    ? {
        code: -32000,
        message: `${error.code}: ${error.message}`,
        ...(error.details === undefined ? {} : { data: error.details }),
      }
    : { code: -32000, message: error instanceof Error ? error.message : String(error) };
}

function invalid(message: string): ToolFailure {
  return { code: INVALID, message };
}

function isFailure(value: unknown): value is ToolFailure {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

function asColumns(value: unknown): readonly SchemaColumn[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const columns: SchemaColumn[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') return undefined;
    const column = entry as Record<string, unknown>;
    if (typeof column.name !== 'string' || typeof column.type !== 'string') return undefined;
    columns.push({
      name: column.name,
      type: column.type,
      ...(typeof column.comment === 'string' ? { comment: column.comment } : {}),
      ...(Array.isArray(column.samples) ? { samples: column.samples.filter((item): item is string => typeof item === 'string') } : {}),
      ...(Array.isArray(column.aliases) ? { aliases: column.aliases.filter((item): item is string => typeof item === 'string') } : {}),
    });
  }
  return columns;
}

/**
 * The caller's tables, or a refusal.
 *
 * A table with no columns is refused rather than passed through: an empty card renders a
 * table name with nothing under it, which is a prompt asking the model to invent columns —
 * and an invented column is the one failure the guard reports as `ungrounded`.
 */
export function asSchema(value: unknown): readonly SchemaTable[] | ToolFailure {
  if (!Array.isArray(value) || value.length === 0) {
    return invalid('ask_question needs at least one table: pass the schema the statement may read');
  }
  const tables: SchemaTable[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') return invalid('every entry in schema must be an object');
    const table = entry as Record<string, unknown>;
    if (typeof table.table !== 'string' || table.table.length === 0) {
      return invalid('every table needs a name');
    }
    const columns = asColumns(table.columns);
    if (columns === undefined) {
      return invalid(`table ${table.table} needs at least one column with a name and a type`);
    }
    const foreignKeys = Array.isArray(table.foreignKeys)
      ? table.foreignKeys.filter((item): item is string => typeof item === 'string')
      : undefined;
    tables.push({
      table: table.table,
      columns,
      ...(foreignKeys === undefined ? {} : { foreignKeys }),
    });
  }
  return tables;
}

/** The payload the tool encodes as text. */
export async function askQuestion(
  context: AskContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | ToolFailure> {
  const question = args.question;
  if (typeof question !== 'string' || question.trim().length === 0) {
    return invalid('ask_question needs a question');
  }
  const schema = asSchema(args.schema);
  if (isFailure(schema)) return schema;
  const preview = typeof args.preview === 'number' ? Math.trunc(args.preview) : undefined;
  if (preview !== undefined && preview < 1) return invalid('preview must be at least 1');
  const cap = context.runner.capabilities.maxRows;
  const rows = Math.min(preview ?? cap, cap);
  const dialect = typeof args.dialect === 'string' ? args.dialect : (context.ask.dialect ?? context.runner.capabilities.dialect);
  const evidence = typeof args.evidence === 'string' ? args.evidence : undefined;

  try {
    const pipeline = createPipeline({
      provider: context.ask.provider,
      ...(context.ask.topK === undefined ? {} : { topK: context.ask.topK }),
      ...(context.ask.maxRepairs === undefined ? {} : { maxRepairs: context.ask.maxRepairs }),
      prompt: { dialect, ...(evidence === undefined ? {} : { evidence }) },
      // The repair loop needs the engine's verdict, and the verdict is the only thing
      // that separates "the statement is wrong" from "the statement is unreadable".
      // One row is enough to distinguish empty from non-empty and costs a second run of
      // a statement the caller is about to run anyway.
      execute: async (sql) => {
        const probe = await context.runner.sql(sql, { limit: 1 });
        return { rows: probe.rowCount };
      },
    });
    const asked = await pipeline.ask({ question, schema });
    const result = await context.runner.sql(asked.sql, { limit: rows });
    return {
      sql: asked.sql,
      question,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      // Below the answer, so a caller can tell a first-try statement from a repair and
      // a repair from an exhausted loop without running the pipeline again.
      attempts: asked.attempts,
      failures: asked.failures,
      diagnoses: asked.diagnoses,
      linked: asked.linked,
      ...(asked.capStripped === undefined ? {} : { capStripped: asked.capStripped }),
      ...(asked.emptyRetry === undefined ? {} : { emptyRetry: asked.emptyRetry }),
    };
  } catch (error) {
    return failure(error);
  }
}
