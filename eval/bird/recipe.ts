/**
 * The prompt the product sends is the prompt the experiment priced.
 *
 * Every other instrument in this directory measures a *difference* between arms. This one measures
 * an *identity*, and it exists because the identity had no owner. The recipe in `packages/ai` says
 * which skeleton, which blocks and which hint the shipped prompt is; the arm table in `run.ts`
 * says which arm was dispatched. Two declarations of one prompt, in two packages, maintained by
 * two commits — the shape that fails quietly, because both sides keep working and only the
 * product's accuracy moves.
 *
 * So this compares them where the model sees them: `buildAskMessages`, per case, byte for byte.
 * The arm's side goes through `promptFor`, which is the harness's own builder; the shipped side
 * goes through `resolveShipment`, which is the product's. Neither is re-implemented here. The
 * pipeline's two messages are compared rather than the `PromptOptions` objects, because an option
 * that renders to the same text is the same prompt and an option that renders to different text is
 * a different one — and only the text is what the model reads.
 *
 * Two details are deliberate and each is a defect this instrument would otherwise paper over:
 *
 * - **The dialect is passed the way a runner reports it** — `sqlite`, lower case — because that is
 *   what `packages/node`'s SQLite runner says and therefore what the product sends. The recipe
 *   states `SQLite`; `resolvePrompt` canonicalises. A comparison that handed both sides `SQLite`
 *   would pass while the product's own path produced `Write sqlite SQL.` in the assembled fallback,
 *   so the spelling is part of what is checked.
 * - **The schema carries its notes on every case**, which is what the run does
 *   (`buildSchema(..., { withNotes: true })` once per database) and lets `descriptions` decide
 *   whether they are printed. An instrument that stripped the notes for an arm whose `notes` flag
 *   is false would compare a card neither side sends — the defect `card.ts` spent two rounds on.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAskMessages, resolveShipment, SHIPPED_SQL } from '@agentix-e/nl2charts-ai';
import type { SchemaTable, SqlRecipe } from '@agentix-e/nl2charts-ai';
import { buildSchema, loadDescriptions, loadQuestions, loadTables } from './data.js';
import type { BirdQuestion, BirdTable, ColumnNote } from './data.js';
import { BIRD_SCHEMA_LINES } from './prompt-shape.js';
import { promptFor, resolveArm, resolveLayout } from './run.js';
import type { Arm, BirdLayout } from './run.js';

/**
 * The dialect a runner reports, which is the spelling the product passes.
 *
 * Written here rather than read from a runner because this instrument must run without a
 * database: the value is the three runners' own (`packages/node` reports `sqlite`, `duckdb`,
 * `postgres`, `mysql`), and the recipe's canonical `SQLite` is the other side of the comparison.
 */
export const RUNNER_DIALECT = 'sqlite';

/** Where the two prompts first diverge, in words a reader can act on. */
export interface MessageDiff {
  /** Which of the pipeline's two messages. */
  readonly side: 'system' | 'user';
  /** Character offset of the first difference. */
  readonly at: number;
  /** The arm's text around that offset. */
  readonly arm: string;
  /** The shipped recipe's text around that offset. */
  readonly shipped: string;
}

/**
 * One case's verdict, as a union rather than a boolean beside an optional field.
 *
 * A boolean plus `diff?` would let a reader write `diff?.at ?? -1` in the report, which is a
 * branch no case can reach — `equal: false` and "no difference recorded" is not a state this
 * instrument produces. The union makes the report read the field it knows is there.
 */
export type RecipeCase =
  | { readonly id: string; readonly db: string; readonly equal: true }
  | PromptDifference;

/** A case the two prompts disagree on, with the disagreement. */
export type PromptDifference = { readonly id: string; readonly db: string; readonly equal: false; readonly diff: MessageDiff };

/**
 * The first difference between two strings, as a window on each side.
 *
 * A whole-prompt diff on a 4,600-token text is unreadable and a boolean is unactionable: the two
 * readings a reader needs are *where* and *what*, and both fit in one window per side. The window
 * is bounded so a report over 1,532 cases stays a report.
 */
export function firstDifference(arm: string, shipped: string): Omit<MessageDiff, 'side'> | undefined {
  if (arm === shipped) return undefined;
  const limit = Math.min(arm.length, shipped.length);
  let at = 0;
  while (at < limit && arm[at] === shipped[at]) at += 1;
  const from = Math.max(0, at - 40);
  return {
    at,
    arm: arm.slice(from, at + 60).replace(/\n/g, '\\n'),
    shipped: shipped.slice(from, at + 60).replace(/\n/g, '\\n'),
  };
}

/**
 * One case, both prompts, compared.
 *
 * `arm` is resolved by the caller so a run resolves it once; the schema is the run's own
 * (`withNotes: true`); the question supplies the evidence, which both sides get verbatim.
 */
export function compareCase(
  arm: Arm,
  question: BirdQuestion,
  schema: readonly SchemaTable[],
  dialect: string = RUNNER_DIALECT,
): RecipeCase {
  const shipped = resolveShipment({
    dialect,
    ...(question.evidence === undefined ? {} : { evidence: question.evidence }),
    schemaLines: BIRD_SCHEMA_LINES,
  });
  // A fallback here would compare the arm against the wrong prompt and report a difference that
  // is not drift — the arm is the template, and the fallback is the assembled skeleton. The
  // dialect is a parameter rather than a constant so this refusal is reachable from a test:
  // a guard that cannot be exercised is a comment.
  if (shipped.recipe !== SHIPPED_SQL.name) {
    throw new Error(
      `recipe: the shipped payload resolved to '${shipped.recipe}' rather than '${SHIPPED_SQL.name}' for dialect ` +
        `'${dialect}', so this instrument would compare the arm against a prompt the arm is not`,
    );
  }
  const armMessages = buildAskMessages({
    question: question.question,
    schema,
    prompt: promptFor(arm, question, {}),
    linking: arm.linking,
    samples: arm.samples !== undefined,
  });
  const shippedMessages = buildAskMessages({
    question: question.question,
    schema,
    prompt: shipped.options,
    linking: shipped.linking,
  });
  const id = String(question.question_id);
  // The two messages by their own positions, not by an index variable: the builder returns a
  // two-tuple, and a loop over it would need a `?? ''` that no prompt can reach.
  const system = firstDifference(armMessages.messages[0].content, shippedMessages.messages[0].content);
  if (system !== undefined) return { id, db: question.db_id, equal: false, diff: { side: 'system', ...system } };
  const user = firstDifference(armMessages.messages[1].content, shippedMessages.messages[1].content);
  if (user !== undefined) return { id, db: question.db_id, equal: false, diff: { side: 'user', ...user } };
  return { id, db: question.db_id, equal: true };
}

export interface RecipeSettings {
  readonly layout: BirdLayout;
  readonly arm: string;
}

/**
 * The arm a comparison runs against: the one the caller named, or the one the recipe was measured as.
 *
 * A recipe with no arm and no `--arm` has nothing to compare, and the throw says which of the two
 * was missing. Kept separate from the settings resolver so that both answers — a named arm, and a
 * recipe that names none — are reachable without a corpus.
 */
export function armForRecipe(recipe: SqlRecipe, named?: string): string {
  const arm = named ?? recipe.arm;
  if (arm === undefined) {
    throw new Error(`recipe '${recipe.name}' names no arm and none was passed, so there is no prompt to compare it with`);
  }
  return arm;
}

export function resolveRecipeSettings(env: Record<string, string | undefined>, argv: readonly string[], root: string): RecipeSettings {
  const flag = argv.indexOf('--arm');
  const named = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && named === undefined) throw new Error('--arm needs a name');
  // The shipped recipe names the arm it was measured as, so a bare invocation compares that arm.
  return { layout: resolveLayout(env, root), arm: armForRecipe(SHIPPED_SQL, named) };
}

export interface RecipeOutcome {
  readonly split: string;
  readonly arm: string;
  readonly cases: number;
  readonly equal: number;
  readonly differs: readonly PromptDifference[];
  /** Cases reported in full. The count is `differs.length`; this is what a log can hold. */
  readonly shown: number;
  readonly problems: readonly string[];
}

/** How many divergent cases a report prints before it becomes a corpus dump. */
const SHOWN = 5;

export function runRecipe(settings: RecipeSettings): RecipeOutcome {
  const layout = settings.layout;
  const arm = resolveArm(settings.arm);
  if (arm === undefined) {
    throw new Error(`recipe: no arm named '${settings.arm}'; the recipe names '${String(SHIPPED_SQL.arm)}'`);
  }
  const problems: string[] = [];
  // The recipe's own claim about itself, checked before any case: an arm name that no arm answers
  // to would make this whole instrument compare nothing and pass, which is the one result it must
  // never give.
  if (SHIPPED_SQL.arm !== arm.name) {
    problems.push(
      `recipe: the shipped prompt is declared as arm '${String(SHIPPED_SQL.arm)}' and this instrument compared '${arm.name}', ` +
        'so a green reading here is about a different arm than the one the recipe was measured as',
    );
  }
  const questions = loadQuestions(layout.questionsFile);
  const tables = loadTables(settings.layout.tablesFile);
  const noteCache = new Map<string, Map<string, Map<string, ColumnNote>>>();
  const schemaCache = new Map<string, readonly SchemaTable[]>();
  const schemaFor = (db: string): readonly SchemaTable[] => {
    const cached = schemaCache.get(db);
    if (cached !== undefined) return cached;
    const table = tables.get(db) as BirdTable | undefined;
    if (table === undefined) throw new Error(`dev_tables.json has no entry for ${db}`);
    let notes = noteCache.get(db);
    if (notes === undefined) {
      notes = loadDescriptions(join(settings.layout.descriptionsRoot, db, 'database_description'), table.tableNames);
      noteCache.set(db, notes);
    }
    // The run's own card: notes attached once per database, `descriptions` deciding whether they
    // are printed. Stripping them here would compare a card neither side sends.
    const schema = buildSchema(table, notes, { withNotes: true });
    schemaCache.set(db, schema);
    return schema;
  };
  const differs: PromptDifference[] = [];
  let equal = 0;
  for (const question of questions) {
    const verdict = compareCase(arm, question, schemaFor(question.db_id));
    if (verdict.equal) equal += 1;
    else differs.push(verdict);
  }
  return {
    split: layout.split,
    arm: arm.name,
    cases: questions.length,
    equal,
    differs,
    shown: Math.min(differs.length, SHOWN),
    problems,
  };
}

export function recipeLines(outcome: RecipeOutcome): readonly string[] {
  const lines = [
    `recipe: ${String(outcome.arm)} against the shipped prompt on ${outcome.split} — ${String(outcome.cases)} cases`,
    `  identical: ${String(outcome.equal)} / ${String(outcome.cases)}`,
    `  ${SHIPPED_SQL.reading}`,
    // The fallback the product relies on, printed rather than asserted: an `if` that can only go
    // one way is a comment with a coverage cost, and `resolveShipment`'s fallback has its own
    // unit test. Here it is one line in the log, so a reading of the instrument states it.
    `  fallback: postgres -> ${resolveShipment({ dialect: 'postgres' }).recipe} (left ${String(resolveShipment({ dialect: 'postgres' }).fellBackFrom)})`,
  ];
  if (outcome.differs.length === 0) {
    lines.push('  the product sends the prompt the experiment priced, on every case');
    return lines;
  }
  lines.push(`  differs: ${String(outcome.differs.length)}`);
  for (const verdict of outcome.differs.slice(0, outcome.shown)) {
    const diff = verdict.diff;
    lines.push(
      `  q${verdict.id} (${verdict.db}) ${diff.side} at ${String(diff.at)}: ` +
        `arm ${JSON.stringify(diff.arm)} shipped ${JSON.stringify(diff.shipped)}`,
    );
  }
  return lines;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const settings = resolveRecipeSettings(env, argv, root);
  const outcome = runRecipe(settings);
  for (const line of recipeLines(outcome)) console.log(line);
  for (const problem of outcome.problems) console.error(problem);
  return outcome.differs.length === 0 && outcome.problems.length === 0 ? 0 : 1;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
