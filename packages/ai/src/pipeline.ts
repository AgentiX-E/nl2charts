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
}

export interface PipelineOptions {
  readonly provider: LlmProvider;
  readonly maxRepairs?: number;
  readonly topK?: number;
  /** Include enum sample values in the schema card. */
  readonly samples?: boolean;
  /** Dialect, evidence and metadata switches for the system prompt. */
  readonly prompt?: PromptOptions;
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
      const linked = linkSchema(request.question, request.schema, topK);
      const schemaHint =
        linked.length > 0
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
