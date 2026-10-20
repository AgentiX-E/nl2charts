import { inspectSql } from '@agentix-e/nl2charts-core';
import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { LlmMessage, LlmProvider } from './provider.js';
import { linkSchema, renderSchemaCard } from './linking.js';
import type { LinkedColumn, SchemaTable } from './linking.js';

export interface PipelineOptions {
  readonly provider: LlmProvider;
  readonly maxRepairs?: number;
  readonly topK?: number;
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

export function buildSqlPrompt(question: string, schema: readonly SchemaTable[]): string {
  return [
    'You translate questions into one read-only SQL statement.',
    'Rules: SELECT only, no DDL or DML, one statement, no comments.',
    'Schema:',
    renderSchemaCard(schema),
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
        { role: 'system', content: buildSqlPrompt(request.question, request.schema) },
        { role: 'user', content: `${schemaHint}\n${request.question}` },
      ];

      let attempts = 0;
      let lastError = '';
      for (;;) {
        attempts += 1;
        const response = await options.provider.complete({ messages, temperature: 0 });
        const sql = extractSql(response.text);
        const verdict = inspectSql(sql);
        if (verdict.ok) return { sql, attempts, linked };
        lastError = `${verdict.reason}: ${verdict.detail}`;
        if (attempts > maxRepairs) {
          throw toNl2ChartsError('NL2C_E_GUARD_REJECTED', 'model could not produce a safe statement', undefined, {
            attempts,
            lastError,
          });
        }
        messages.push({ role: 'assistant', content: response.text });
        messages.push({
          role: 'user',
          content: `That statement was rejected (${lastError}). Return one SELECT statement only.`,
        });
      }
    },
  };
}
