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
 */
import type { SchemaTable } from '@agentix-e/nl2charts-ai';

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

  const aliases = new Map<string, string>();
  const relation = /\b(?:from|join)\s+(["`[]?[\w$]+["`\]]?)(?:\s+(?:as\s+)?(["`[]?[\w$]+["`\]]?))?/gi;
  for (const match of stripLiterals(sql).matchAll(relation)) {
    const table = (match[1] ?? '').replace(/["`[\]]/g, '');
    const alias = (match[2] ?? '').replace(/["`[\]]/g, '');
    if (known.has(table.toLowerCase())) {
      aliases.set(table.toLowerCase(), table.toLowerCase());
      if (alias.length > 0 && !KEYWORDS.has(alias.toLowerCase())) aliases.set(alias.toLowerCase(), table.toLowerCase());
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
    const name = (match[1] ?? '').replace(/["`[\]]/g, '');
    const table = known.get(name.toLowerCase());
    if (table !== undefined) push({ table: table.table });
  }

  // Qualified references: alias.column or table.column.
  for (const match of stripLiterals(sql).matchAll(/\b([A-Za-z_][\w$]*)\s*\.\s*([A-Za-z_][\w$]*)/g)) {
    const owner = (match[1] ?? '').toLowerCase();
    const column = match[2] ?? '';
    const table = aliases.get(owner);
    if (table === undefined) continue;
    const schemaTable = known.get(table);
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
      const column = table.columns.find((entry) => entry.name.toLowerCase() === lower);
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
export function summariseCoverage(rows: readonly Coverage[]): {
  readonly questions: number;
  readonly complete: number;
  readonly completeRate: number;
  readonly references: number;
  readonly covered: number;
  readonly referenceRate: number;
  readonly byMissing: readonly { readonly identifier: string; readonly questions: number }[];
} {
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

/**
 * Run the measurement over a split.
 *
 * No model, no network, no database: the prompt is rendered exactly as the pipeline would
 * send it, and the gold statement is read for the identifiers it needs. That makes this
 * affordable on all 1,532 dev questions, which is the point — it answers "is schema
 * coverage the constraint?" before anyone spends a call answering it.
 */
async function main(): Promise<void> {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { buildSqlPrompt, linkSchema } = await import('@agentix-e/nl2charts-ai');
  const { buildSchema, loadQuestions, loadTables } = await import('./data.js');

  const root = process.cwd();
  const split = process.env.BIRD_SPLIT ?? 'minidev';
  const data =
    process.env.BIRD_DATA ??
    (split === 'dev' ? join(root, 'eval/.cache/bird/dev/dev_20240627') : join(root, 'eval/.cache/bird/minidev/MINIDEV'));
  const questionsFile = split === 'dev' ? 'dev.json' : 'mini_dev_sqlite.json';
  const questions = loadQuestions(join(data, questionsFile));
  const tables = loadTables(join(data, 'dev_tables.json'));
  const limit = Number(process.env.BIRD_LIMIT ?? 0);

  const schemas = new Map<string, ReturnType<typeof buildSchema>>();
  const rows = [];
  const examples = [];
  for (const question of questions) {
    if (limit > 0 && rows.length >= limit) break;
    const table = tables.get(question.db_id);
    if (table === undefined) continue;
    let schema = schemas.get(question.db_id);
    if (schema === undefined) {
      schema = buildSchema(table, new Map(), { withNotes: false });
      schemas.set(question.db_id, schema);
    }
    const linked = linkSchema(question.question, schema, 12);
    const hint = linked.length === 0 ? '' : `Likely columns: ${linked.map((column) => `${column.table}.${column.column}`).join(', ')}`;
    const prompt = buildSqlPrompt(question.question, schema, {
      dialect: 'SQLite',
      ...(question.evidence === undefined ? {} : { evidence: question.evidence }),
    });
    const coverage = coverageOf(`${prompt}\n${hint}`, goldReferences(question.SQL, schema));
    rows.push(coverage);
    if (coverage.missing.length > 0 && examples.length < 5) {
      examples.push({ id: question.question_id, missing: coverage.missing.slice(0, 3) });
    }
  }

  const summary = summariseCoverage(rows);
  const out = join(root, 'eval/out');
  mkdirSync(out, { recursive: true });
  const artifact = { split, ...summary, examples, measuredAt: new Date().toISOString() };
  writeFileSync(join(out, `recall-${split}.json`), `${JSON.stringify(artifact, null, 2)}\n`);

  console.log(`recall ${split}: ${summary.questions} questions`);
  console.log(`  every gold identifier visible: ${summary.complete}/${summary.questions} (${(summary.completeRate * 100).toFixed(1)}%)`);
  console.log(`  identifiers visible: ${summary.covered}/${summary.references} (${(summary.referenceRate * 100).toFixed(1)}%)`);
  for (const entry of summary.byMissing.slice(0, 8)) console.log(`  missing ${entry.identifier} in ${entry.questions} questions`);

  // A missing identifier is not a wording problem: the model cannot name a column it was
  // never shown. The measurement is a gate because a truncation bug in the schema card
  // would otherwise only show up as a slow accuracy decline.
  if (summary.completeRate < 1) {
    throw new Error(
      `${summary.questions - summary.complete} of ${summary.questions} prompts hide at least one identifier the gold statement needs ` +
        `(worst: ${summary.byMissing.slice(0, 3).map((entry) => entry.identifier).join(', ')})`,
    );
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('recall.ts')) await main();
