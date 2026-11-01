import { inspectSql } from '@agentix-e/nl2charts-core';
import { toNl2ChartsError } from '@agentix-e/nl2charts-spec';
import type { LlmMessage, LlmProvider } from './provider.js';
import { turnTemperature } from './provider.js';
import { buildInterpretationPrompt, parseInterpretation } from './interpret.js';
import { diagnoseFailure } from './diagnose.js';
import type { Diagnosis, FailureClass } from './diagnose.js';
import { buildPlanPrompt, parsePlan } from './plan.js';
import { DECOMPOSE_RULES, parseDecomposed } from './decompose.js';
import { emptyRetryMessages } from './empty.js';
import { auditMessages, countNamedConditions } from './audit.js';
import { replyShape } from './format.js';
import type { ReplyShape } from './format.js';
import { linkSchema, renderSchemaCard } from './linking.js';
import type { LinkedColumn, Recaller, SchemaCardOptions, SchemaTable } from './linking.js';

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
  /**
   * Ask for a decomposition: sub-questions with their own statements, then the answer.
   *
   * Different from `plan`, which is written in an earlier call and carried in: this
   * instruction is part of the SQL prompt, so the decomposition happens inside the same
   * reply and costs no extra call. Set through `PipelineOptions.decompose` as well, which
   * keeps the reader and the prompt from disagreeing.
   */
  readonly decompose?: boolean;
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
  /**
   * Which recallers the linker may use. Absent means its default set.
   *
   * A caller that has measured a recaller on its own corpus can turn it on here; nothing in
   * the product does, so the hint every shipped prompt carries is the one that was measured.
   */
  readonly recallers?: readonly Recaller[];
  /** Ask for a one-sentence reading of the question before writing SQL. */
  readonly interpret?: boolean;
  /** Ask for a query plan (scan, filter, join, group, answer) before writing SQL. */
  readonly plan?: boolean;
  /**
   * Generate by decomposition: sub-questions with their own statements, then the answer.
   *
   * One switch for two halves that must agree — the prompt gains the instruction and the
   * reply is read from its last block instead of its first. Set separately, the two drift
   * into a pipeline whose prompt asks for steps and whose reader takes step one.
   */
  readonly decompose?: boolean;
  /**
   * Sampling temperature for every call this pipeline makes.
   *
   * `undefined` sends zero — the value every reading in `docs/benchmarks.md` was taken at, and
   * above zero enables self-consistency when the caller draws more than one sample. `null`
   * sends no temperature at all, for an endpoint that refuses the field instead of ignoring
   * it: a reasoning model that only accepts its own default answers a `temperature: 0` with a
   * 400, and before this the failure arrived as "the endpoint is unreachable".
   *
   * It reaches every turn, not just the statement — the repair turn, the audit turn, the
   * empty-result turn and the selector all go to the same endpoint, and a policy that stopped
   * at the first would fail on the turn a weak model depends on most.
   */
  readonly temperature?: number | null;
  /** When provided, a candidate is executed before it is accepted; failures
   *  become repair turns (syntax and binding errors, not wrong answers). Returning
   *  a row count opts the pipeline into the empty-result turn; returning nothing
   *  says the caller does not measure it. */
  readonly execute?: (sql: string) => Promise<{ readonly rows: number } | void>;
  /**
   * One more turn when an accepted statement returns no rows.
   *
   * Distinct from `maxRepairs`, which is budgeted for statements the engine refused:
   * this turn answers a statement the engine accepted and the question did not. It is
   * budgeted separately because a repair and an empty result are different failures
   * and folding them into one counter would make the cost of each unreadable.
   *
   * `diagnosed` sends what the result says; `blind` sends nothing about it, which is
   * the control that prices the information rather than the extra call.
   */
  readonly emptyRetry?: 'diagnosed' | 'blind';
  /**
   * What a repair turn says: the diagnosed message (default) or the engine's raw error.
   *
   * The raw mode is not a fallback; it is the control. Diagnosed repair costs the same
   * number of calls either way, so the only way to know whether the diagnosis earns them
   * is to run both on the same cases.
   */
  readonly repairFeedback?: 'diagnosed' | 'raw';
  /**
   * One more turn after a statement is accepted: ask the model which of the question's
   * conditions it failed to write, and keep the statement it writes next.
   *
   * This is aimed at the failure class no result-based trigger can see — the statement runs,
   * returns rows and is still wrong because a filter is missing (16.1-18.8pp of Mini-Dev).
   * The turn fires on the accepted statement, before any execution: a mechanism that waited
   * for the engine to complain would be blind to exactly the cases it exists for. It costs
   * one call and re-sends the conversation, which is what `audit` in the meter prices.
   */
  readonly audit?: 'conditions';
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
  /**
   * What the empty-result turn did, when the pipeline was allowed one.
   *
   * `fired` is the reach of the mechanism and `recovered` is its yield; a run that
   * reports the first without the second cannot say whether the call was worth it.
   */
  readonly emptyRetry?: { readonly fired: boolean; readonly recovered: boolean };
  /**
   * What the audit turn found and did.
   *
   * `named` is the reach — how many conditions the model said were missing — and
   * `rewritten` is the yield. An arm whose audit names nothing on most cases is not a
   * mechanism that failed; it is evidence about where the missing filters are decided,
   * and without the count the two readings look the same.
   */
  readonly audit?: { readonly fired: boolean; readonly named: number; readonly rewritten: boolean };
  /**
   * How many sub-statements the reply wrote, when the pipeline asked for a decomposition.
   *
   * Reported rather than assumed: an instruction a model ignores leaves an arm that is
   * the plain generator with a longer prompt, and without this count the two are
   * indistinguishable in the artifact.
   */
  readonly decomposedSteps?: number;
  /**
   * The shape of the reply the prompt produced, read at the moment the guard accepted it.
   *
   * Reported for the same reason `decomposedSteps` is, one level up: an arm is a prompt, and
   * a prompt's first failure on an unfamiliar model is not a wrong statement but an unreadable
   * one. Reading the shape here — before any execution, before the audit and the empty-result
   * turn — keeps the profile a property of this arm's prompt rather than of every lever the
   * arm also carries.
   */
  readonly shape?: ReplyShape;
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
    // The plain rule says "one statement", which contradicts a reply that also carries
    // step statements. Replacing it rather than appending to it keeps one instruction
    // about statements in the prompt; two would be read as permission by whichever the
    // model prefers.
    resolved.decompose === true
      ? 'Rules: SELECT only, no DDL or DML. The STEP lines are working notes and are not executed; the statement in the final block must be a single SELECT with no comments.'
      : 'Rules: SELECT only, no DDL or DML, one statement, no comments.',
    'Use only the filters the question states. Sample values are examples, not defaults.',
  ];
  if (resolved.dialect !== undefined) {
    rules.push(`Write ${resolved.dialect} SQL. Use only functions and syntax that ${resolved.dialect} supports.`);
  }
  for (const note of resolved.notes ?? []) rules.push(note);
  // Last, after any per-shape notes: the format instruction has to be the final word on
  // what the reply looks like, or a note about window functions reads as the ending.
  if (resolved.decompose === true) rules.push(...DECOMPOSE_RULES);
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
  shape: ReplyShape | undefined,
): Error {
  const code = diagnosis.failureClass === 'guard' || diagnosis.failureClass === 'permission' ? 'NL2C_E_GUARD_REJECTED' : 'NL2C_E_ENGINE_FAILED';
  return toNl2ChartsError(
    code,
    diagnosis.failureClass === 'guard' ? 'model could not produce a safe statement' : 'model could not produce an executable statement',
    undefined,
    // The shape travels with the failure, not only with the success: an arm where every reply
    // was unreadable is the case a profile is most needed for, and it is the one a caller can
    // otherwise only report as a zero.
    { attempts, lastError: diagnosis.summary, lastSql: sql, failureClasses: failures, diagnoses, ...(shape === undefined ? {} : { lastShape: shape }) },
  );
}

export interface AskMessagesInput {
  readonly question: string;
  readonly schema: readonly SchemaTable[];
  readonly prompt?: PromptOptions;
  readonly linking?: boolean;
  /** Which recallers the linker may use; absent means its default set. */
  readonly recallers?: readonly Recaller[];
  readonly samples?: boolean;
  readonly interpretation?: string;
  readonly plan?: string;
  /** Ask for a decomposition inside the same reply; the reader follows this switch. */
  readonly decompose?: boolean;
  readonly topK?: number;
}

/**
 * The two messages the SQL call sees, built in one place.
 *
 * Extracted so a caller that needs to continue the same conversation — the empty-result
 * turn does — can reproduce the first two messages byte for byte. A second builder that
 * drifted would make the extra turn a different prompt, and the arm that spends it would
 * be measuring the drift.
 */
export function buildAskMessages(input: AskMessagesInput): {
  messages: readonly [LlmMessage, LlmMessage];
  linked: readonly LinkedColumn[];
} {
  const linked = input.linking === false ? [] : linkSchema(input.question, input.schema, input.topK ?? 12, input.recallers);
  const schemaHint =
    input.linking === false
      ? 'Use the schema above.'
      : linked.length > 0
        ? `Likely columns: ${linked.map((column) => `${column.table}.${column.column}`).join(', ')}`
        : 'No column matched; use the schema above.';
  return {
    linked,
    messages: [
      {
        role: 'system',
        content: buildSqlPrompt(input.question, input.schema, {
          samples: input.samples === true,
          ...input.prompt,
          ...(input.interpretation === undefined ? {} : { interpretation: input.interpretation }),
          ...(input.plan === undefined ? {} : { plan: input.plan }),
          // After the spread: a caller that supplies `prompt.decompose` and a pipeline
          // switch that disagrees resolves to the pipeline's switch, which is the one the
          // reader obeys.
          decompose: input.decompose === true || input.prompt?.decompose === true,
        }),
      },
      { role: 'user', content: `${schemaHint}\n${input.question}` },
    ],
  };
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
  // Resolved once, so every turn sends the same answer and `null` survives: `??` would
  // turn "do not name a value" into "hold the model at zero" and the endpoint that refuses
  // the field would still refuse it.
  const temperature = turnTemperature(options.temperature);

  return {
    async ask(request) {
      // One extra call, only when asked: a reading of the question, written with
      // the column semantics in view, then carried into the SQL prompt.
      let interpretation: string | undefined;
      if (options.interpret === true) {
        const reading = await options.provider.complete({
          messages: [
            { role: 'system', content: buildInterpretationPrompt(request.question, request.schema) },
            { role: 'user', content: request.question },
          ],
          temperature,
          // Named for the meter: this call exists only on an arm that asked for a reading, and
          // a cost table that folded it into generation would make it look like part of the
          // statement's price.
          purpose: 'interpret',
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
          temperature,
          purpose: 'plan',
        });
        const parsed = parsePlan(planned.text);
        if (parsed.length > 0) plan = parsed;
      }
      const built = buildAskMessages({
        question: request.question,
        schema: request.schema,
        ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
        ...(options.linking === undefined ? {} : { linking: options.linking }),
        ...(options.recallers === undefined ? {} : { recallers: options.recallers }),
        ...(options.samples === undefined ? {} : { samples: options.samples }),
        ...(interpretation === undefined ? {} : { interpretation }),
        ...(plan === undefined ? {} : { plan }),
        decompose: options.decompose === true,
        topK,
      });
      // The builder returns a pair; the repair loop appends to a copy of it.
      const messages: LlmMessage[] = [...built.messages];
      const linked = built.linked;

      let attempts = 0;
      const failures: FailureClass[] = [];
      const diagnoses: string[] = [];
      // The first reply, kept across repair turns: the profile describes what the prompt
      // produced before any feedback was in front of the model, and the same reading is taken
      // for a sampling arm, so an arm's profile does not depend on how many turns it spent.
      let firstShape: ReplyShape | undefined;
      // One reader for every reply, including repairs and the empty-result turn: a
      // statement written under the decomposition prompt is read from its last block each
      // time, so a repair cannot silently fall back to reading step one.
      const readReply = (text: string): { sql: string; steps: number } =>
        options.decompose === true ? parseDecomposed(text) : { sql: extractSql(text), steps: 0 };
      for (;;) {
        attempts += 1;
        const response = await options.provider.complete({
          messages,
          temperature,
          // The first turn is the statement the arm is named for; every later turn is a repair,
          // and a repair's price is the thing a repair arm is judged on. One label would make
          // "three attempts cost three times one attempt" an assumption instead of a column.
          purpose: attempts === 1 ? 'generate' : 'retry',
        });
        const read = readReply(response.text);
        if (firstShape === undefined) firstShape = replyShape(response.text);
        const sql = read.sql;
        const steps = options.decompose === true ? { decomposedSteps: read.steps } : {};
        const verdict = inspectSql(sql);
        if (verdict.ok) {
          // Read once, where the guard says yes: this is the reply the arm's own prompt
          // produced, and the turns appended below belong to levers the arm may or may not
          // carry. A profile that included them would make `inline+evidence` and
          // `inline+evidence+audit` differ on a dimension neither of them changed.
          const shape = firstShape === undefined ? {} : { shape: firstShape };
          // The audit turn, when the arm asked for it: the statement the guard accepted goes
          // back in front of the model with the question, and the statement it writes next is
          // the one executed. It runs *before* any execution on purpose — the failure class it
          // targets is the one that runs and returns rows, so a trigger keyed on the engine's
          // answer would never fire on it.
          const audited =
            options.audit === 'conditions'
              ? await auditStatement({
                  provider: options.provider,
                  question: request.question,
                  messages,
                  previous: response.text,
                  statement: sql,
                  temperature,
                  read: (text: string) => readReply(text).sql,
                })
              : undefined;
          const stated = audited === undefined ? sql : audited.sql;
          const spent = audited === undefined ? attempts : attempts + 1;
          const audit =
            audited === undefined
              ? {}
              : { audit: { fired: true, named: audited.named, rewritten: stated !== sql } };
          if (!options.execute) return { sql: stated, attempts: spent, linked, failures, diagnoses, ...audit, ...steps, ...shape };
          try {
            const outcome = await options.execute(stated);
            const rows = rowCountOf(outcome);
            if (rows === 0 && options.emptyRetry !== undefined) {
              const retried = await retryEmpty({ provider: options.provider, mode: options.emptyRetry, execute: options.execute, messages, previous: response.text, sql: stated, temperature, read: (text: string) => readReply(text).sql });
              return {
                sql: retried.sql,
                attempts: spent + 1,
                linked,
                failures,
                diagnoses,
                emptyRetry: { fired: true, recovered: retried.recovered },
                ...audit,
                ...steps,
                ...shape,
              };
            }
            return { sql: stated, attempts: spent, linked, failures, diagnoses, ...audit, ...steps, ...shape };
          } catch (error) {
            const diagnosis = diagnoseFailure({
              sql: stated,
              schema: request.schema,
              ...(options.prompt?.dialect === undefined ? {} : { dialect: options.prompt.dialect }),
              ...(options.repairFeedback === undefined ? {} : { mode: options.repairFeedback }),
              error,
            });
            failures.push(diagnosis.failureClass);
            diagnoses.push(diagnosis.summary);
            if (attempts > maxRepairs) throw exhausted(diagnosis, attempts, stated, failures, diagnoses, firstShape);
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
        if (attempts > maxRepairs) throw exhausted(diagnosis, attempts, sql, failures, diagnoses, firstShape);
        messages.push({ role: 'assistant', content: response.text });
        messages.push({ role: 'user', content: diagnosis.feedback });
      }
    },
  };
}

/**
 * The row count an execution hook reported, or `undefined` when it reported none.
 *
 * A hook that returns nothing is not saying "zero rows"; it is saying it does not
 * measure them. Reading absence as emptiness would fire the retry on every case of
 * every caller that only wanted execution feedback.
 */
function rowCountOf(outcome: { readonly rows: number } | void): number | undefined {
  if (outcome === undefined || outcome === null || typeof outcome !== 'object') return undefined;
  return typeof outcome.rows === 'number' ? outcome.rows : undefined;
}

/**
 * One extra call that asks the model what its own statement left out.
 *
 * The turn is not a retry: it never sees a result, and the statement it is given was already
 * accepted by the guard. What it adds is a comparison the model did not make — the question's
 * conditions against the ones the statement wrote — and the reply is read for both halves,
 * the count of conditions it names (`named`) and the statement it writes (`sql`).
 *
 * A reply whose statement fails the guard is discarded and the original kept, for the same
 * reason a failed repair is discarded: the first statement is known to be safe, and a
 * second one that is not cannot be executed at all. The count still stands — the model did
 * say what it thought was missing, and dropping that reading because the statement was bad
 * would lose the only part of the turn that is evidence.
 */
async function auditStatement(input: {
  readonly provider: LlmProvider;
  readonly question: string;
  readonly messages: readonly LlmMessage[];
  readonly previous: string;
  readonly statement: string;
  readonly temperature: number | null;
  readonly read: (text: string) => string;
}): Promise<{ readonly sql: string; readonly named: number }> {
  const response = await input.provider.complete({
    messages: [...input.messages, ...auditMessages(input.question, input.statement, input.previous)],
    temperature: input.temperature,
    // Its own purpose, so the price table can say what the check cost rather than folding it
    // into generation: on a one-call arm this turn doubles the characters billed.
    purpose: 'audit',
  });
  const named = countNamedConditions(response.text);
  const candidate = input.read(response.text);
  if (!inspectSql(candidate).ok) return { sql: input.statement, named };
  return { sql: candidate, named };
}

/**
 * One more turn after a statement ran and returned nothing.
 *
 * The replacement is adopted when it returns rows; a replacement that fails to run is
 * discarded, because the statement it would replace at least produced a result. A
 * replacement that also returns nothing is kept — both are wrong on a split whose gold
 * results are never empty, and the later one is the one written with the extra fact.
 */
async function retryEmpty(input: {
  readonly provider: LlmProvider;
  readonly mode: 'diagnosed' | 'blind';
  readonly execute: (sql: string) => Promise<{ readonly rows: number } | void>;
  readonly messages: readonly LlmMessage[];
  readonly previous: string;
  readonly sql: string;
  readonly temperature: number | null;
  /** How a reply is read: the last block under a decomposition, the first otherwise. */
  readonly read: (text: string) => string;
}): Promise<{ readonly sql: string; readonly recovered: boolean }> {
  const response = await input.provider.complete({
    messages: [...input.messages, ...emptyRetryMessages(input.mode, input.sql, input.previous)],
    temperature: input.temperature,
    purpose: 'retry',
  });
  const candidate = input.read(response.text);
  if (!inspectSql(candidate).ok) return { sql: input.sql, recovered: false };
  try {
    const rows = rowCountOf(await input.execute(candidate));
    return { sql: candidate, recovered: rows !== undefined && rows > 0 };
  } catch {
    return { sql: input.sql, recovered: false };
  }
}
