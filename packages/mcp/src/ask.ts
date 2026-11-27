import { createGroundingReader, createPipeline, resolveShipment, shippedEdit } from '@agentix-e/nl2charts-ai';
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
  /**
   * Let the column linker read the caller's `evidence` as well as the question.
   *
   * Off by default, and for the reason the pipeline gives: turning it on changes the hint, so a
   * deployment that enables it is running a different prompt from one that does not. A caller that
   * always supplies evidence — a product with a glossary, say — can turn it on and measure the
   * result; the tool's own `evidence` argument decides what the linker reads, so a request that
   * omits it behaves exactly as before.
   */
  readonly linkEvidence?: boolean;
  /**
   * Read the domains of the columns a statement compares against, so a literal spelled in the
   * wrong case is corrected before the statement runs.
   *
   * On by default, because it is the shipped rule: on BIRD's dev split the ungated form won 14
   * cases and lost none, and the gated form — only after an empty result — won 7, so the gate was
   * the only thing between the rule and its own ceiling. It costs one `select distinct` per
   * compared column and no tokens.
   *
   * The switch exists for the reason `linkEvidence` does: a deployment measuring its own corpus
   * needs a control, and a tool that could only be tested with the rule on would make every reading
   * a reading of the rule plus the prompt. Off means the statement the model wrote is the statement
   * that runs.
   */
  readonly readDomains?: boolean;
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

/**
 * How many distinct values a domain read may return before it is treated as no answer.
 *
 * The rewrite's licence is the *set* of a column's values: exactly one of them matching the literal
 * ignoring case is a substitution, two is a judgement it declines. A read that stopped early
 * therefore cannot be narrowed — it can only be refused — so the cap is not a performance knob but
 * the boundary between a fact and a guess. A column with more than a thousand distinct values is
 * not a domain a literal is spelled wrongly against; it is a free-text or identifier column, and
 * the honest answer is "I did not look".
 *
 * The runner wraps the read in `limit + 1` rows and reports `truncated`, so the cost is bounded by
 * this number rather than by the table: a hundred-million-row table answers in the time it takes to
 * find a thousand and first distinct value.
 */
const DOMAIN_VALUES = 1000;

/**
 * The domain reader this tool hands the pipeline, over the caller's runner.
 *
 * One reader per asked question, because the cache inside it must not outlive the question: a
 * column's values can change between two questions, and a value cached across them would be a fact
 * about the past used to decide a statement about now.
 *
 * A statement the runner refuses or the engine fails to execute is `ok: false`, which the reader
 * turns into "unknown" and the rewrite into a refusal. That is the safe direction and it is also
 * the common one: the read names a column the model wrote, and a column that does not exist is a
 * statement that was going to fail anyway. It also keeps one failed read from taking down a
 * question the runner could still answer.
 */
function domainReaderFor(runner: Runner): ReturnType<typeof createGroundingReader> {
  return createGroundingReader(async (sql) => {
    try {
      const probe = await runner.sql(sql, { limit: DOMAIN_VALUES });
      // The read selects exactly one expression, so its rows are records with exactly one value and
      // the value is the one asked for. Reading it by `Object.values` rather than by the engine's
      // echo of the column name is deliberate: the name is the caller's guess at how an identifier
      // survives a round trip through the engine, while the value is not a guess at all.
      return { ok: true, rows: probe.rows.map((row) => Object.values(row)), truncated: probe.truncated };
    } catch {
      return { ok: false, rows: [] };
    }
  });
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
  /**
   * The prompt, taken from the package rather than assembled here.
   *
   * This line used to be `prompt: { dialect, evidence }`, which is a *combination* nobody had
   * measured: on BIRD dev the shipped combination answers 1,010 of 1,532 (65.93%) and this one
   * 980 (63.97%), at 40% of the cache-miss tokens. A product that builds its prompt field by
   * field cannot be the same prompt as an arm in an experiment, and the difference is invisible
   * from both sides — which is why the recipe now lives in `packages/ai` and the tool reads it.
   * A dialect the recipe cannot state (anything but SQLite) falls back to the assembled
   * skeleton, and the payload says so rather than quietly shipping a different prompt.
   */
  const shipped = resolveShipment({ dialect, ...(evidence === undefined ? {} : { evidence }) });

  try {
    const pipeline = createPipeline({
      provider: context.ask.provider,
      ...(context.ask.topK === undefined ? {} : { topK: context.ask.topK }),
      ...(context.ask.maxRepairs === undefined ? {} : { maxRepairs: context.ask.maxRepairs }),
      ...(context.ask.linkEvidence === undefined ? {} : { linkEvidence: context.ask.linkEvidence }),
      // The rule the data proves, on the caller's own database — see `domainReaderFor` for why the
      // reader is built per question rather than per deployment.
      //
      // Whether the rule runs is not this file's decision. It was, for one round: the default was
      // the literal `true` here, and a literal in a tool is a decision with no reading attached and
      // no gate reading it — so the edit could stop being measured and keep running. The ledger in
      // `packages/ai/src/edits.ts` holds the decision and the number behind it, and
      // `test/bird-rules-ledger.test.ts` requires it to agree with the pricer's own verdicts.
      ...(context.ask.readDomains ?? shippedEdit('ground-shipped').enabled
        ? { readColumnValues: domainReaderFor(context.runner) }
        : {}),
      prompt: shipped.options,
      // Part of the recipe, not of the call: the hint lives in the user message, so a pipeline
      // that turned it on would send a prompt the arm that chose this recipe never sent.
      linking: shipped.linking,
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
      // Which prompt answered. A caller comparing two deployments on accuracy needs the prompt in
      // the payload rather than in a log line, and a dialect that forced the fallback is a second
      // explanation of one delta — so it is named rather than left to be inferred from the dialect.
      promptRecipe: shipped.recipe,
      ...(shipped.fellBackFrom === undefined ? {} : { promptFallback: shipped.fellBackFrom }),
      ...(asked.capStripped === undefined ? {} : { capStripped: asked.capStripped }),
      // The second free rewrite, named for the same reason the first one is: `sql` alone cannot
      // tell a statement the model wrote from one the pipeline repaired, and a caller comparing two
      // deployments needs to know which of the two edits fired on this question.
      ...(asked.nullOrderGuarded === undefined ? {} : { nullOrderGuarded: asked.nullOrderGuarded }),
      ...(asked.emptyRetry === undefined ? {} : { emptyRetry: asked.emptyRetry }),
      // What the domain reader changed, and what it could not settle. The second number is what
      // keeps the first honest: a rule that fires on nothing because every read failed would
      // otherwise look exactly like a database where every spelling was already right — and until
      // this line existed the tool reported neither, so a deployment could not tell whether the
      // priced rule was running at all.
      ...(asked.grounding === undefined ? {} : { grounding: asked.grounding }),
    };
  } catch (error) {
    return failure(error);
  }
}
