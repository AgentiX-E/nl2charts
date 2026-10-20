import { inspectSql } from '@agentix-e/nl2charts-core';
import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { LlmMessage, LlmProvider } from './provider.js';
import { linkSchema, renderSchemaCard } from './linking.js';
import type { LinkedColumn, SchemaCardOptions, SchemaTable } from './linking.js';

export interface PromptOptions extends SchemaCardOptions {
  /** Dialect the statement must be written in, e.g. 'SQLite'. */
  readonly dialect?: string;
  /** Dataset hint that explains business terms (BIRD calls this "evidence"). */
  readonly evidence?: string;
  /** Maximum schema-card lines. Large schemas need more than the default 40. */
  readonly schemaLines?: number;
  /** Extra rule lines for a question shape, appended after the base rules. */
  readonly notes?: readonly string[];
}

export interface PromptProfile extends SchemaCardOptions {
  readonly notes: readonly string[];
}

/**
 * The two prompt components that help on one question shape and hurt on another.
 *
 * Measured on BIRD Mini-Dev (239 cases) and on 32 hand-written cases: column
 * descriptions are worth +12.6pp on filter-and-aggregate questions, but -9.4pp on
 * window and ratio questions, where the longer card invites hallucinated columns
 * and expensive correlated subqueries. A per-shape profile is the only way to
 * keep both, so the choice is explicit and testable rather than always-on.
 */
export function choosePromptProfile(question: string): PromptProfile {
  const text = question.toLowerCase();
  const windowShape = /\b(rank|ranking|ranked|dense_rank|row_number|running total|cumulative|previous|next|lag|lead|top \w+ per|per (each|group))\b/.test(text);
  const ratioShape = /\b(ratio|fraction|proportion|share|percentage|percent of)\b/.test(text);
  if (windowShape) {
    return {
      descriptions: false,
      foreignKeys: false,
      notes: [
        'This question needs a window function. Rank with RANK when ties share a rank, and DENSE_RANK when they do not consume a position.',
        'A previous/next comparison leaves the first or last row empty; do not invent a value for it.',
        'Order the window explicitly; an unordered window is not reproducible.',
      ],
    };
  }
  if (ratioShape) {
    return {
      descriptions: false,
      foreignKeys: false,
      notes: [
        'A ratio divides two aggregates. Guard the denominator with NULLIF instead of relying on the engine to return null.',
        'Count rows where the question counts rows, and count a column where it counts values; NULLs make the two differ.',
      ],
    };
  }
  return { descriptions: true, foreignKeys: true, notes: [] };
}

export interface PipelineOptions {
  readonly provider: LlmProvider;
  readonly maxRepairs?: number;
  readonly topK?: number;
  /** Include enum sample values in the schema card. */
  readonly samples?: boolean;
  /** Dialect, evidence and metadata switches for the system prompt. */
  readonly prompt?: PromptOptions;
  /** Ask the three-recaller linker for a column hint. Defaults to true. */
  readonly linking?: boolean;
  /** When provided, a candidate is executed before it is accepted; failures
   *  become repair turns (syntax and binding errors, not wrong answers). */
  readonly execute?: (sql: string) => Promise<unknown>;
}

export interface AskRequest {
  readonly question: string;
  readonly schema: readonly SchemaTable[];
}

export interface AskResult {
  readonly sql: string;
  readonly attempts: number;
  readonly linked: readonly LinkedColumn[];
}

const SQL_FENCE = /```(?:sql)?\s*([\s\S]*?)```/i;

export function extractSql(text: string): string {
  const fenced = SQL_FENCE.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const withoutPrefix = candidate.replace(/^sql:\s*/i, '');
  return withoutPrefix.trim();
}

export function buildSqlPrompt(
  question: string,
  schema: readonly SchemaTable[],
  options: boolean | PromptOptions = false,
): string {
  const resolved: PromptOptions = typeof options === 'boolean' ? { samples: options } : options;
  const rules = [
    'You translate questions into one read-only SQL statement.',
    'Rules: SELECT only, no DDL or DML, one statement, no comments.',
    'Use only the filters the question states. Sample values are examples, not defaults.',
  ];
  if (resolved.dialect !== undefined) {
    rules.push(`Write ${resolved.dialect} SQL. Use only functions and syntax that ${resolved.dialect} supports.`);
  }
  for (const note of resolved.notes ?? []) rules.push(note);
  const context: string[] = [];
  if (resolved.evidence !== undefined && resolved.evidence.trim().length > 0) {
    context.push(`Evidence: ${resolved.evidence.trim()}`);
  }
  return [
    ...rules,
    'Schema:',
    renderSchemaCard(schema, resolved.schemaLines ?? 40, resolved),
    ...context,
    `Question: ${question}`,
  ].join('\n');
}

/**
 * Question -> guarded SQL. The guard is applied to every candidate, including
 * repairs: a model that "fixes" a query by dropping a table is refused.
 */
export function createPipeline(options: PipelineOptions): {
  ask(request: AskRequest): Promise<AskResult>;
} {
  const maxRepairs = options.maxRepairs ?? 2;
  const topK = options.topK ?? 12;

  return {
    async ask(request) {
      const linked = options.linking === false ? [] : linkSchema(request.question, request.schema, topK);
      const schemaHint =
        options.linking === false
          ? 'Use the schema above.'
          : linked.length > 0
            ? `Likely columns: ${linked.map((column) => `${column.table}.${column.column}`).join(', ')}`
            : 'No column matched; use the schema above.';
      const messages: LlmMessage[] = [
        {
          role: 'system',
          content: buildSqlPrompt(request.question, request.schema, {
            samples: options.samples === true,
            ...options.prompt,
          }),
        },
        { role: 'user', content: `${schemaHint}\n${request.question}` },
      ];

      let attempts = 0;
      let lastError = '';
      let lastKind: 'guard' | 'execution' = 'guard';
      for (;;) {
        attempts += 1;
        const response = await options.provider.complete({ messages, temperature: 0 });
        const sql = extractSql(response.text);
        const verdict = inspectSql(sql);
        if (verdict.ok) {
          if (!options.execute) return { sql, attempts, linked };
          try {
            await options.execute(sql);
            return { sql, attempts, linked };
          } catch (error) {
            lastKind = 'execution';
            lastError = error instanceof Error ? error.message : String(error);
          }
        } else {
          lastKind = 'guard';
          lastError = `${verdict.reason}: ${verdict.detail}`;
        }
        if (attempts > maxRepairs) {
          const code = lastKind === 'guard' ? 'NL2C_E_GUARD_REJECTED' : 'NL2C_E_ENGINE_FAILED';
          throw toNl2ChartsError(code, lastKind === 'guard' ? 'model could not produce a safe statement' : 'model could not produce an executable statement', undefined, {
            attempts,
            lastError,
            lastSql: sql,
          });
        }
        messages.push({ role: 'assistant', content: response.text });
        messages.push({
          role: 'user',
          content: `That statement failed (${lastError}). Return one SELECT statement only.`,
        });
      }
    },
  };
}
