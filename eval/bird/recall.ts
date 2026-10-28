/**
 * Intrinsic coverage: does the prompt contain the identifiers the gold query uses?
 *
 * Every arm so far was priced by running the model, which costs a call per question per
 * arm. This measures the input instead: take the gold SQL, extract the tables and columns
 * it names, and check which of them appear in the prompt the model actually receives. A
 * missing column is a failure no prompt instruction can recover from, so the share of
 * questions with complete coverage is a ceiling on what better wording could buy — and it
 * costs nothing to compute.
 *
 * It is deliberately a *text* check rather than a schema-graph analysis: the question is
 * whether the model can see the name, not whether a linker scored it well.
 *
 * The prompt is rendered by `buildAskMessages`, the same builder the pipeline sends, rather
 * than by calling `buildSqlPrompt` here and re-deriving the linking hint beside it. The
 * first version did the latter and had already drifted: it appended no hint at all when the
 * linker matched nothing, while the pipeline sends `No column matched; use the schema
 * above.` — so the ceiling was measured on a prompt nobody sends. That is the same defect
 * this file's comment records having fixed one layer down, when the schema card here was
 * built without notes and rendered at 40 lines.
 */
import { buildAskMessages } from '@agentix-e/nl2charts-ai';
import type { LinkedColumn, SchemaColumn, SchemaTable } from '@agentix-e/nl2charts-ai';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildSchema, loadDescriptions, loadQuestions, loadTables } from './data.js';
import type { BirdQuestion, BirdTable } from './data.js';
import { BIRD_CARD } from './prompt-shape.js';
import { resolveLayout } from './run.js';
import type { BirdLayout } from './run.js';

export interface GoldReference {
  readonly table: string;
  readonly column?: string;
}

export interface Coverage {
  readonly total: number;
  /** Gold identifiers the schema knows about. */
  readonly referenced: number;
  readonly covered: number;
  /** Share of questions whose every referenced identifier appears in the prompt. */
  readonly completeQuestions: number;
  readonly missing: readonly GoldReference[];
}

const KEYWORDS = new Set([
  'select',
  'from',
  'where',
  'group',
  'by',
  'order',
  'having',
  'limit',
  'join',
  'inner',
  'left',
  'right',
  'outer',
  'cross',
  'on',
  'as',
  'and',
  'or',
  'not',
  'null',
  'is',
  'in',
  'like',
  'between',
  'case',
  'when',
  'then',
  'else',
  'end',
  'distinct',
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'cast',
  'union',
  'all',
  'asc',
  'desc',
  'with',
  'over',
  'partition',
  'using',
  'exists',
  'true',
  'false',
  'interval',
  'date',
  'year',
  'month',
  'day',
  'strftime',
  'substr',
  'round',
  'abs',
  'lower',
  'upper',
  'length',
  'coalesce',
  'nullif',
  'iif',
  'ifnull',
  'printf',
  'replace',
  'trim',
]);

/** Strip string literals, quoted identifiers survive as identifiers. */
function stripLiterals(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, " '' ");
}

/**
 * Read the tables and columns a gold statement names.
 *
 * Aliases are resolved against the statement's own FROM/JOIN clauses, so `s.col` becomes
 * `students.col`. A bare identifier is returned without a table, because the statement did
 * not say which one it meant — and the schema may have several.
 */
export function goldReferences(sql: string, schema: readonly SchemaTable[]): GoldReference[] {
  const known = new Map<string, SchemaTable>();
  for (const table of schema) known.set(table.table.toLowerCase(), table);

  // The alias table holds the table itself, not its name. Holding the name meant looking it
  // up again in `known` and defending against a second lookup that could not fail — a
  // branch no test could reach, in the middle of the only resolution the file does.
  const aliases = new Map<string, SchemaTable>();
  const relation = /\b(?:from|join)\s+(["`[]?[\w$]+["`\]]?)(?:\s+(?:as\s+)?(["`[]?[\w$]+["`\]]?))?/gi;
  for (const match of stripLiterals(sql).matchAll(relation)) {
    const name = (match[1] as string).replace(/["`[\]]/g, '');
    const alias = (match[2] ?? '').replace(/["`[\]]/g, '');
    const table = known.get(name.toLowerCase());
    if (table !== undefined) {
      aliases.set(name.toLowerCase(), table);
      if (alias.length > 0 && !KEYWORDS.has(alias.toLowerCase())) aliases.set(alias.toLowerCase(), table);
    }
  }

  const out: GoldReference[] = [];
  const seen = new Set<string>();
  const push = (reference: GoldReference): void => {
    const key = `${reference.table}.${reference.column ?? ''}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(reference);
  };

  // Table references: FROM/JOIN targets.
  for (const match of stripLiterals(sql).matchAll(/\b(?:from|join)\s+(["`[]?[\w$]+["`\]]?)/gi)) {
    const name = (match[1] as string).replace(/["`[\]]/g, '');
    const table = known.get(name.toLowerCase());
    if (table !== undefined) push({ table: table.table });
  }

  // Qualified references: alias.column or table.column.
  for (const match of stripLiterals(sql).matchAll(/\b([A-Za-z_][\w$]*)\s*\.\s*([A-Za-z_][\w$]*)/g)) {
    const owner = (match[1] as string).toLowerCase();
    const column = match[2] as string;
    const schemaTable = aliases.get(owner);
    // A qualifier the statement never bound is not a reference to this schema: `x.col`
    // where `x` is a CTE or a typo says nothing about the table it might have meant.
    if (schemaTable === undefined) continue;
    if (schemaTable.columns.some((entry) => entry.name.toLowerCase() === column.toLowerCase())) {
      push({ table: schemaTable.table, column });
    }
  }

  // Bare identifiers that are column names anywhere in the schema, minus keywords and
  // aliases. A bare name the schema does not know is not a reference to anything.
  for (const match of stripLiterals(sql).matchAll(/\b([A-Za-z_][\w$]*)\b/g)) {
    const word = match[1] as string;
    const lower = word.toLowerCase();
    if (KEYWORDS.has(lower) || aliases.has(lower)) continue;
    for (const table of schema) {
      const column = table.columns.find((entry: SchemaColumn) => entry.name.toLowerCase() === lower);
      if (column !== undefined) {
        push({ table: table.table, column: column.name });
        break;
      }
    }
  }
  return out;
}

/**
 * Which of those references the prompt shows.
 *
 * Matching is case-insensitive and bounded by a word edge, because both sides are SQL
 * identifiers: `id` must not be satisfied by `student_id`, and `StudentName` must be
 * satisfied by `studentname` only if the prompt renders it that way — which it does not,
 * since the card uses the schema's own spelling.
 */
export function coverageOf(prompt: string, references: readonly GoldReference[]): Coverage {
  const missing: GoldReference[] = [];
  let covered = 0;
  for (const reference of references) {
    const needle = reference.column ?? reference.table;
    // Identifier edges, not substring: `id` must not be satisfied by `student_id`, and
    // `_` counts as part of the identifier for exactly that reason.
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_])`, 'i');
    if (pattern.test(prompt)) covered += 1;
    else missing.push(reference);
  }
  return {
    total: references.length,
    referenced: references.length,
    covered,
    completeQuestions: missing.length === 0 ? 1 : 0,
    missing,
  };
}

/** Aggregate over questions; each question contributes its own completeness. */
export interface CoverageSummary {
  readonly questions: number;
  readonly complete: number;
  readonly completeRate: number;
  readonly references: number;
  readonly covered: number;
  readonly referenceRate: number;
  readonly byMissing: readonly { readonly identifier: string; readonly questions: number }[];
}

export function summariseCoverage(rows: readonly Coverage[]): CoverageSummary {
  const questions = rows.length;
  const complete = rows.filter((row) => row.missing.length === 0).length;
  const references = rows.reduce((sum, row) => sum + row.referenced, 0);
  const covered = rows.reduce((sum, row) => sum + row.covered, 0);
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const reference of row.missing) {
      const key = reference.column === undefined ? reference.table : `${reference.table}.${reference.column}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return {
    questions,
    complete,
    completeRate: questions === 0 ? 0 : complete / questions,
    references,
    covered,
    referenceRate: references === 0 ? 0 : covered / references,
    byMissing: [...counts.entries()]
      .map(([identifier, count]) => ({ identifier, questions: count }))
      .sort((left, right) => right.questions - left.questions || left.identifier.localeCompare(right.identifier)),
  };
}

/** The two messages an arm sends, flattened, plus the columns the linker offered. */
export interface RenderedAsk {
  readonly prompt: string;
  readonly linked: readonly LinkedColumn[];
}

/**
 * Render the prompt exactly as the pipeline sends it.
 *
 * Both messages, because the linking hint lives in the user turn: a check that reads only
 * the system prompt is checking a prompt that is sent alongside a second one.
 */
export function renderAsk(question: Pick<BirdQuestion, 'question' | 'evidence'>, schema: readonly SchemaTable[], topK = 12): RenderedAsk {
  const evidence = question.evidence.trim();
  const { messages, linked } = buildAskMessages({
    question: question.question,
    schema,
    prompt: { dialect: 'SQLite', ...BIRD_CARD, ...(evidence === '' ? {} : { evidence }) },
    topK,
  });
  return { prompt: messages.map((message) => message.content).join('\n'), linked };
}

/** Coverage for one question, on the prompt the arm would send for it. */
export function coverageForQuestion(
  question: Pick<BirdQuestion, 'question' | 'evidence' | 'SQL'>,
  schema: readonly SchemaTable[],
  topK = 12,
): Coverage {
  return coverageOf(renderAsk(question, schema, topK).prompt, goldReferences(question.SQL, schema));
}

/** Where a recall run reads and writes. Splits and limits are values, not environment reads. */
export interface RecallSettings {
  readonly layout: BirdLayout;
  readonly out: string;
  /** Measure at most this many questions; 0 measures the whole split. */
  readonly limit: number;
}

/**
 * Read the paths out of the environment.
 *
 * The layout is the runner's own, so the prompt measured here is rendered against the same
 * questions file, the same manifest and the same description CSVs the arms receive.
 */
export function resolveRecallSettings(env: Record<string, string | undefined>, root: string): RecallSettings {
  const layout = resolveLayout(env, root);
  const limit = Number(env.BIRD_LIMIT ?? 0);
  return { layout, out: dirname(layout.out), limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0 };
}

export interface RecallPrepared {
  readonly settings: RecallSettings;
  readonly questions: readonly BirdQuestion[];
  readonly tables: ReadonlyMap<string, BirdTable>;
}

export function prepareRecall(settings: RecallSettings): RecallPrepared {
  return {
    settings,
    questions: loadQuestions(settings.layout.questionsFile),
    tables: loadTables(settings.layout.tablesFile),
  };
}

/** A database the split asks about but `dev_tables.json` does not describe. */
export interface RecallSkip {
  readonly db: string;
  readonly questions: number;
}

/** One question whose prompt hides something, kept for the artifact and the console. */
export interface RecallExample {
  readonly id: number;
  readonly missing: readonly GoldReference[];
}

/** How many examples an artifact keeps: enough to name the pattern, few enough to read. */
export const EXAMPLE_LIMIT = 5;

/**
 * Keep the first few questions that hide an identifier.
 *
 * A named rule rather than a compound condition inside the loop: "the first five, and only
 * the ones that are missing something" is two separate decisions, and written as `&&`
 * neither could be tested — a fixture where everything is visible never reaches the second.
 */
export function noteExample(examples: RecallExample[], id: number, coverage: Coverage): void {
  if (coverage.missing.length === 0) return;
  if (examples.length >= EXAMPLE_LIMIT) return;
  examples.push({ id, missing: coverage.missing.slice(0, 3) });
}

export interface RecallOutcome {
  readonly split: string;
  readonly summary: CoverageSummary;
  /** Questions the split asked about, before the limit and before any skip. */
  readonly offered: number;
  /** Questions the loop looked at, i.e. everything the limit allowed. */
  readonly examined: number;
  /** Questions that produced a coverage row. `measured === summary.questions`. */
  readonly measured: number;
  readonly skipped: readonly RecallSkip[];
  readonly examples: readonly RecallExample[];
  /** What the gate refuses, as data, so the artifact is written before anything is thrown. */
  readonly problems: readonly string[];
}

/** The measurement, without I/O beyond the dataset the caller already read. */
export function measureRecall(prepared: RecallPrepared): RecallOutcome {
  const { settings, questions } = prepared;
  const schemas = new Map<string, SchemaTable[]>();
  const rows: Coverage[] = [];
  const examples: RecallExample[] = [];
  const skipCounts = new Map<string, number>();
  let examined = 0;
  for (const question of questions) {
    // The limit bounds what the loop looks at, not what it manages to measure. Counting
    // measured rows meant a split with three undescribed databases examined
    // `BIRD_LIMIT + 3` questions, which is a sample nobody asked for.
    if (settings.limit > 0 && examined >= settings.limit) break;
    examined += 1;
    const table = prepared.tables.get(question.db_id);
    if (table === undefined) {
      skipCounts.set(question.db_id, (skipCounts.get(question.db_id) ?? 0) + 1);
      continue;
    }
    let schema = schemas.get(question.db_id);
    if (schema === undefined) {
      // The runner's own schema: notes on, descriptions merged into the column line. A gate
      // that renders a sparser card than the arms send is green about a card nobody sends,
      // and it was: this line built the schema without notes while every arm sends one with
      // them, then rendered it at the default 40 lines while the arms send 400.
      schema = buildSchema(
        table,
        loadDescriptions(join(settings.layout.descriptionsRoot, question.db_id, 'database_description'), table.tableNames),
        { withNotes: true },
      );
      schemas.set(question.db_id, schema);
    }
    const coverage = coverageForQuestion(question, schema);
    rows.push(coverage);
    noteExample(examples, question.question_id, coverage);
  }
  const summary = summariseCoverage(rows);
  const skipped = [...skipCounts.entries()]
    .map(([db, count]) => ({ db, questions: count }))
    .sort((left, right) => right.questions - left.questions || left.db.localeCompare(right.db));
  return {
    split: settings.layout.split,
    summary,
    offered: questions.length,
    examined,
    measured: rows.length,
    skipped,
    examples,
    problems: recallProblems(summary, rows.length, skipped),
  };
}

/**
 * What the gate refuses.
 *
 * Two conditions, and the first is the reason this function exists: a split where every
 * database is missing from the manifest measures nothing, and `completeRate` is then `0`
 * over `0`, which the old gate turned into the sentence "0 of 0 prompts hide at least one
 * identifier" — a true statement about no measurement at all.
 */
export function recallProblems(summary: CoverageSummary, measured: number, skipped: readonly RecallSkip[]): string[] {
  if (measured === 0) {
    const detail =
      skipped.length === 0
        ? 'the split offers no question'
        : `every database it names is missing from dev_tables.json (${skipped.map((entry) => entry.db).join(', ')})`;
    return [`nothing was measured: ${detail}`];
  }
  if (summary.completeRate >= 1) return [];
  const worst = summary.byMissing
    .slice(0, 3)
    .map((entry) => entry.identifier)
    .join(', ');
  return [
    `${summary.questions - summary.complete} of ${summary.questions} prompts hide at least one identifier the gold statement needs ` +
      `(worst: ${worst})`,
  ];
}

export interface RecallArtifact {
  readonly split: string;
  readonly questions: number;
  readonly complete: number;
  readonly completeRate: number;
  readonly references: number;
  readonly covered: number;
  readonly referenceRate: number;
  readonly byMissing: CoverageSummary['byMissing'];
  readonly offered: number;
  readonly examined: number;
  readonly measured: number;
  readonly skipped: readonly RecallSkip[];
  readonly examples: readonly RecallExample[];
  readonly problems: readonly string[];
  readonly passed: boolean;
  readonly measuredAt: string;
}

export function recallArtifact(outcome: RecallOutcome): RecallArtifact {
  return {
    split: outcome.split,
    ...outcome.summary,
    offered: outcome.offered,
    examined: outcome.examined,
    measured: outcome.measured,
    skipped: outcome.skipped,
    examples: outcome.examples,
    problems: outcome.problems,
    passed: outcome.problems.length === 0,
    measuredAt: new Date().toISOString(),
  };
}

export function recallPath(settings: RecallSettings): string {
  return join(settings.out, `recall-${settings.layout.split}.json`);
}

export function writeRecallArtifact(settings: RecallSettings, outcome: RecallOutcome): string {
  mkdirSync(settings.out, { recursive: true });
  const path = recallPath(settings);
  writeFileSync(path, `${JSON.stringify(recallArtifact(outcome), null, 2)}\n`);
  return path;
}

/** Everything the entry prints, as data: the wording is testable without capturing stdout. */
export function recallLines(outcome: RecallOutcome): string[] {
  const { summary } = outcome;
  const lines = [
    `recall ${outcome.split}: ${String(outcome.measured)} questions measured` +
      (outcome.measured === outcome.offered ? '' : ` of ${String(outcome.offered)} offered`) +
      (outcome.skipped.length === 0
        ? ''
        : `, ${String(outcome.skipped.reduce((sum, entry) => sum + entry.questions, 0))} skipped for missing table manifests (${outcome.skipped.map((entry) => entry.db).join(', ')})`),
    `  every gold identifier visible: ${String(summary.complete)}/${String(summary.questions)} (${(summary.completeRate * 100).toFixed(1)}%)`,
    `  identifiers visible: ${String(summary.covered)}/${String(summary.references)} (${(summary.referenceRate * 100).toFixed(1)}%)`,
  ];
  for (const entry of summary.byMissing.slice(0, 8)) lines.push(`  missing ${entry.identifier} in ${String(entry.questions)} questions`);
  for (const problem of outcome.problems) lines.push(`  FAILED ${problem}`);
  return lines;
}

export function runRecall(settings: RecallSettings): RecallOutcome {
  return measureRecall(prepareRecall(settings));
}

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

/**
 * Run the measurement over a split.
 *
 * No model, no network, no database: the prompt is rendered exactly as the pipeline would
 * send it, and the gold statement is read for the identifiers it needs. That makes this
 * affordable on all 1,532 dev questions, which is the point — it answers "is schema
 * coverage the constraint?" before anyone spends a call answering it.
 *
 * The artifact is written before the gate is applied, and it records the verdict. The first
 * version threw first and wrote never, so a red run left the previous green artifact in
 * place — a file that said 100% about a split nobody had just measured.
 */
export async function main(
  env: Record<string, string | undefined> = process.env,
  root: string = ROOT,
): Promise<void> {
  const settings = resolveRecallSettings(env, root);
  const outcome = runRecall(settings);
  const path = writeRecallArtifact(settings, outcome);
  for (const line of recallLines(outcome)) console.log(line);
  console.log(`\nwrote ${path}`);
  if (outcome.problems.length > 0) throw new Error(outcome.problems.join('; '));
}

// `import.meta.url`, not a suffix match on `process.argv[1]`: the first version used
// `argv[1].endsWith('recall.ts')`, which a file called `notrecall.ts` also satisfies, and
// which does nothing when the entry is imported rather than executed.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
