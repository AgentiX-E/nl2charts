import { inspectSql } from '@agentix-e/nl2charts-core';
import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { LlmMessage, LlmProvider } from './provider.js';
import { buildInterpretationPrompt, parseInterpretation } from './interpret.js';
import { diagnoseFailure } from './diagnose.js';
import type { Diagnosis, FailureClass } from './diagnose.js';
import { buildPlanPrompt, parsePlan } from './plan.js';
import { linkSchema, renderSchemaCard } from './linking.js';
import type { LinkedColumn, SchemaCardOptions, SchemaTable } from './linking.js';

export interface PromptOptions extends SchemaCardOptions {
  /** Dialect the statement must be written in, e.g. 'SQLite'. */
  readonly dialect?: string;
  /** Dataset hint that explains business terms (BIRD calls this "evidence"). */
  readonly evidence?: string;
  /** Structural semantics: grain, keys, join direction, column roles. */
  readonly definitions?: string;
  /** A reading of this question, produced before the SQL attempt. */
  readonly interpretation?: string;
  /**
   * Worked examples retrieved from another database, statements included.
   *
   * The heading states that the tables are not the ones above, because a statement
   * written for another schema is a shape to imitate and an identifier to avoid —
   * and which of the two a model takes is a measured question, not an assumption.
   */
  readonly demonstrations?: string;
  /**
   * Column values this question names, resolved against the database under test.
   *
   * Distinct from `evidence`, which is the dataset's hint: this block is derived from
   * the data, so it is available on a database nobody documented.
   */
  readonly values?: string;
  /**
   * A query plan written before the statement: scan, filter, join, group, answer.
   * Distinct from `interpretation`, which says what the question means rather than how
   * the engine would answer it.
   */
  readonly plan?: string;
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
  /** Ask for a one-sentence reading of the question before writing SQL. */
  readonly interpret?: boolean;
  /** Ask for a query plan (scan, filter, join, group, answer) before writing SQL. */
  readonly plan?: boolean;
  /** Sampling temperature for the SQL call. Above zero enables self-consistency. */
  readonly temperature?: number;
  /** When provided, a candidate is executed before it is accepted; failures
   *  become repair turns (syntax and binding errors, not wrong answers). */
  readonly execute?: (sql: string) => Promise<unknown>;
  /**
   * What a repair turn says: the diagnosed message (default) or the engine's raw error.
   *
   * The raw mode is not a fallback; it is the control. Diagnosed repair costs the same
   * number of calls either way, so the only way to know whether the diagnosis earns them
   * is to run both on the same cases.
   */
  readonly repairFeedback?: 'diagnosed' | 'raw';
}

export interface AskRequest {
  readonly question: string;
  readonly schema: readonly SchemaTable[];
}

export interface AskResult {
  readonly sql: string;
  readonly attempts: number;
  readonly linked: readonly LinkedColumn[];
  /**
   * Why each rejected attempt was rejected, in order.
   *
   * Recorded so a repair can be priced: `attempts` alone cannot tell a run where the
   * first statement was refused for a reason the schema could have prevented from one
   * where three different mistakes were made.
   */
  readonly failures: readonly FailureClass[];
  /** One-line diagnoses, for artifacts and logs. */
  readonly diagnoses: readonly string[];
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
  if (resolved.definitions !== undefined && resolved.definitions.trim().length > 0) {
    // The block arrives without its heading so that a caller cannot add a
    // heading for an empty block; the prompt owns the heading.
    context.push(['Semantics:', resolved.definitions.trim()].join('\n'));
  }
  if (resolved.evidence !== undefined && resolved.evidence.trim().length > 0) {
    context.push(`Evidence: ${resolved.evidence.trim()}`);
  }
  if (resolved.interpretation !== undefined && resolved.interpretation.trim().length > 0) {
    context.push(`Interpretation: ${resolved.interpretation.trim()}`);
  }
  if (resolved.plan !== undefined && resolved.plan.trim().length > 0) {
    context.push(['Plan:', resolved.plan.trim()].join('\n'));
  }
  if (resolved.values !== undefined && resolved.values.trim().length > 0) {
    context.push(['Values in this database named by the question:', resolved.values.trim()].join('\n'));
  }
  if (resolved.demonstrations !== undefined && resolved.demonstrations.trim().length > 0) {
    context.push(
      [
        'Examples from other databases (their tables and columns are not the ones above; imitate the shape, not the identifiers):',
        resolved.demonstrations.trim(),
      ].join('\n'),
    );
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
 * The error a caller sees when the repair budget is spent.
 *
 * It carries the last diagnosis, the classes of every failure and the statement that
 * was rejected, because "the model could not produce a statement" is a fact the caller
 * can do nothing with.
 */
function exhausted(
  diagnosis: Diagnosis,
  attempts: number,
  sql: string,
  failures: readonly FailureClass[],
  diagnoses: readonly string[],
): Error {
  const code = diagnosis.failureClass === 'guard' || diagnosis.failureClass === 'permission' ? 'NL2C_E_GUARD_REJECTED' : 'NL2C_E_ENGINE_FAILED';
  return toNl2ChartsError(
    code,
    diagnosis.failureClass === 'guard' ? 'model could not produce a safe statement' : 'model could not produce an executable statement',
    undefined,
    { attempts, lastError: diagnosis.summary, lastSql: sql, failureClasses: failures, diagnoses },
  );
}

/**
 * Question -> guarded SQL. The guard is applied to every candidate, including
 * repairs: a model that "fixes" a query by dropping a table is refused.
 */
export function createPipeline(options: PipelineOptions): {
  ask(request: AskRequest): Promise<AskResult>;
} {
  // Three, not two. Two is MAC-SQL's and CHASE-SQL's choice, but both stop after a
  // second failure and ours did so with a single generic sentence; with a diagnosis
  // that names the invented identifier, the third turn is the one that can act on it.
  // The value is configurable because a caller with a slow endpoint pays for it.
  const maxRepairs = options.maxRepairs ?? 3;
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
      // One extra call, only when asked: a reading of the question, written with
      // the column semantics in view, then carried into the SQL prompt.
      let interpretation: string | undefined;
      if (options.interpret === true) {
        const reading = await options.provider.complete({
          messages: [
            { role: 'system', content: buildInterpretationPrompt(request.question, request.schema) },
            { role: 'user', content: request.question },
          ],
          temperature: 0,
        });
        const parsed = parseInterpretation(reading.text);
        if (parsed.length > 0) interpretation = parsed;
      }
      // One extra call, only when asked: the plan is written with the schema in view
      // and then carried into the SQL prompt as its own block.
      let plan: string | undefined;
      if (options.plan === true) {
        const planned = await options.provider.complete({
          messages: [{ role: 'user', content: buildPlanPrompt(request.question, request.schema) }],
          temperature: 0,
        });
        const parsed = parsePlan(planned.text);
        if (parsed.length > 0) plan = parsed;
      }
      const messages: LlmMessage[] = [
        {
          role: 'system',
          content: buildSqlPrompt(request.question, request.schema, {
            samples: options.samples === true,
            ...options.prompt,
            ...(interpretation === undefined ? {} : { interpretation }),
            ...(plan === undefined ? {} : { plan }),
          }),
        },
        { role: 'user', content: `${schemaHint}\n${request.question}` },
      ];

      let attempts = 0;
      const failures: FailureClass[] = [];
      const diagnoses: string[] = [];
      for (;;) {
        attempts += 1;
        const response = await options.provider.complete({ messages, temperature: options.temperature ?? 0 });
        const sql = extractSql(response.text);
        const verdict = inspectSql(sql);
        if (verdict.ok) {
          if (!options.execute) return { sql, attempts, linked, failures, diagnoses };
          try {
            await options.execute(sql);
            return { sql, attempts, linked, failures, diagnoses };
          } catch (error) {
            const diagnosis = diagnoseFailure({
              sql,
              schema: request.schema,
              ...(options.prompt?.dialect === undefined ? {} : { dialect: options.prompt.dialect }),
              ...(options.repairFeedback === undefined ? {} : { mode: options.repairFeedback }),
              error,
            });
            failures.push(diagnosis.failureClass);
            diagnoses.push(diagnosis.summary);
            if (attempts > maxRepairs) throw exhausted(diagnosis, attempts, sql, failures, diagnoses);
            messages.push({ role: 'assistant', content: response.text });
            messages.push({ role: 'user', content: diagnosis.feedback });
            continue;
          }
        }
        const diagnosis = diagnoseFailure({
          sql,
          schema: request.schema,
          ...(options.prompt?.dialect === undefined ? {} : { dialect: options.prompt.dialect }),
          guard: { reason: verdict.reason, detail: verdict.detail },
        });
        failures.push(diagnosis.failureClass);
        diagnoses.push(diagnosis.summary);
        if (attempts > maxRepairs) throw exhausted(diagnosis, attempts, sql, failures, diagnoses);
        messages.push({ role: 'assistant', content: response.text });
        messages.push({ role: 'user', content: diagnosis.feedback });
      }
    },
  };
}
