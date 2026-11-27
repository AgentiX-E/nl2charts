/**
 * Whether the card hid a table the answer needed.
 *
 * The census (`census.ts`) says *which clause* a wrong statement differs from the gold in first, and
 * the largest bucket is the relation: on BIRD dev's canonical run 173 of 522 wrong statements differ
 * there first, and 136 of them never read a table the gold reads. The plan priced that population at
 * ¥15–25 for better schema linking. Before spending it, one question has to be answered, and it is
 * not a question about models: **was the table on the card at all?**
 *
 * The two answers lead to opposite work. A table that never reached the prompt is a retrieval defect
 * — a linker, a re-ranker, a wider card. A table the model was shown and did not join is a decision
 * defect, and no retriever can fix it. This instrument reads the second half of that sentence from
 * the artifact and the dataset, executes nothing, calls nothing, and costs **¥0**.
 *
 * ## What it found, and the defect it found on the way
 *
 * At the width the run was measured at (400 column lines) the card hid **nothing**: 75 of 75 tables,
 * `truncatedPrompts: []`, and every one of the 148 missing (case, table) pairs — 156 minus the 8 that
 * are CTE names the statement defines — was printed on the card the model was sent. So the relation
 * bucket is not a visibility problem, and the linker this plan had priced would have acted on a
 * population already served.
 *
 * The same measurement taken at the **product's own default** says something else. `resolveShipment`
 * used to leave the width to the caller, and both builders default to 40 column lines; at that width
 * 22 of the 75 tables never reach the prompt, 415 of 798 columns are cut, and **587 of the 1,532
 * questions** are asked about a schema that is missing a table their gold statement reads. That is
 * the defect this instrument exists to prevent: not a model failure but a configuration whose score
 * was never measured, because the reading was taken at 400 and the shipped path sent 40.
 *
 * ## What it counts, and what a count is not
 *
 * The unit is a **(question, gold table)** pair: a gold statement reads table `t`, the card for that
 * question does not print `t`, so the pair is hidden. A statement can hide several; a question can
 * hide several. Columns are counted the same way from the gold's own `table.column` references, with
 * bare identifiers skipped because a bare `id` belongs to a table the scanner cannot know without the
 * card.
 *
 * A hidden table is **not** automatically a wrong answer: a statement can answer the same question
 * through another relation, and nothing here executes. A visible table is **not** automatically
 * used. The instrument sizes a population and gates a configuration; it does not score anything, and
 * every sentence it prints says so.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderMacSqlCard } from '@agentix-e/nl2charts-ai';
import { buildSchema, loadDescriptions, loadTables } from './data.js';
import type { BirdTable, ColumnNote } from './data.js';
import { resolveLayout } from './run.js';
import type { BirdLayout } from './run.js';
import { definesOwnName, referencedFields, tableRefs } from './statement.js';

/** One question's gold statement and the database it runs on. */
export interface ReachQuestion {
  readonly id: string;
  readonly db: string;
  readonly gold: string;
}

/** A rendered card, read back into the tables and columns it prints. */
export interface CardShape {
  /** Lower-cased table name → lower-cased column names. A table absent here was not on the card. */
  readonly tables: ReadonlyMap<string, ReadonlySet<string>>;
}

/** One budget's card for every database the population touches. */
export interface ReachBudget {
  /** The width in the unit the recipe's renderer counts — column lines. */
  readonly lines: number;
  readonly cards: ReadonlyMap<string, CardShape>;
  /**
   * The schema each card was rendered from, lower-cased.
   *
   * Needed to tell two different things apart: a column the card cut, and a column the schema never
   * had. The second is a fact about the gold — BIRD's `formula_1` case 1016 reuses the alias `T4` in
   * two scopes, so `T4.min_time_in_seconds` resolves to `pitstops.min_time_in_seconds`, which does
   * not exist — and counting it as a hidden column would blame the card for a statement no card can
   * serve.
   */
  readonly schemas: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
}

/** One reading: what one width hid over one population. */
export interface ReachReading {
  readonly lines: number;
  readonly questions: number;
  /** Tables the card printed, summed over the databases this population uses. */
  readonly tables: number;
  readonly columns: number;
  /** (question, gold table) pairs whose table is not on the card. */
  readonly hiddenTables: number;
  readonly questionsHiding: number;
  /** (question, gold table.column) pairs whose column is on the schema and was cut by the width. */
  readonly hiddenColumns: number;
  readonly questionsHidingColumn: number;
  /** Gold columns no table of the schema holds: a statement's own arithmetic, or a reused alias. */
  readonly unmodelledColumns: number;
  /** Names the gold defines itself (`with x as (...)`) and therefore cannot be on a card. */
  readonly ownNames: number;
}

/** The whole report: one reading per width, the totals the readings are checked against, problems. */
export interface ReachReport {
  readonly split: string;
  readonly arm: string;
  readonly readings: readonly ReachReading[];
  /** Every table and column in the schemas of the databases the population uses. */
  readonly schemaTables: number;
  readonly schemaColumns: number;
  /** What the artifact says about the card, which is what the gates compare a reading against. */
  readonly control: ReachControl;
  readonly source: ReachSource;
  readonly problems: readonly string[];
}

/** The artifact's own account of its card, if it kept one. */
export interface ReachControl {
  readonly schemaLines?: number;
  readonly tablesInPrompts?: number;
  readonly tablesTotal?: number;
  readonly truncated: boolean;
}

export interface ReachSource {
  readonly path: string;
  readonly generatedAt?: string;
}

const CARD_HEADER = /^# Table: (.+?)\s*$/;
const CARD_COLUMN = /^\s+\((.+?),/;

/**
 * A rendered card, read back.
 *
 * The template's card prints `# Table: <name>` followed by one `(column, TYPE. prose.)` line per
 * column, and the budget is counted in those lines — so a width can cut a table in half and the
 * half-cut table still occupies the prompt. Reading the rendering rather than the schema is the only
 * way to know which half arrived: a card built from the schema's own table list would report 75 of 75
 * at every width, which is the number this instrument exists to replace.
 */
export function readCard(text: string): CardShape {
  const tables = new Map<string, Set<string>>();
  let current: Set<string> | undefined;
  for (const line of text.split('\n')) {
    const header = CARD_HEADER.exec(line);
    if (header !== null) {
      current = new Set<string>();
      tables.set((header[1] as string).toLowerCase(), current);
      continue;
    }
    const column = CARD_COLUMN.exec(line);
    if (column !== null && current !== undefined) current.add((column[1] as string).trim().toLowerCase());
  }
  return { tables };
}

/**
 * The tables and qualified columns a gold statement reads.
 *
 * `tableRefs` is the scanner the repair stage edits with, so it resolves aliases the way the
 * statement wrote them; `definesOwnName` removes a name the statement defines, because a CTE is not a
 * table and counting one would make every such case permanently short of `all`. Both are counted
 * apart instead of dropped: a corpus fact belongs in a report, not in a silently narrower denominator.
 */
export function goldRefs(sql: string): { tables: string[]; columns: { table: string; column: string }[]; ownNames: number } {
  const seen = new Set<string>();
  const tables: string[] = [];
  let ownNames = 0;
  for (const ref of tableRefs(sql)) {
    const name = ref.table.toLowerCase();
    if (definesOwnName(sql, ref.table)) {
      ownNames += 1;
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    tables.push(name);
  }
  const columns = referencedFields(sql).qualified.map((field) => ({ table: field.table.toLowerCase(), column: field.column.toLowerCase() }));
  return { tables, columns, ownNames };
}

/** What one width hid. */
export function tallyReading(budget: ReachBudget, questions: readonly ReachQuestion[]): ReachReading {
  const used = new Set(questions.map((question) => question.db));
  let tables = 0;
  let columns = 0;
  for (const db of used) {
    const card = budget.cards.get(db);
    if (card === undefined) continue;
    tables += card.tables.size;
    for (const printed of card.tables.values()) columns += printed.size;
  }
  let hiddenTables = 0;
  let questionsHiding = 0;
  let hiddenColumns = 0;
  let questionsHidingColumn = 0;
  let unmodelledColumns = 0;
  let ownNames = 0;
  for (const question of questions) {
    const card = budget.cards.get(question.db);
    const refs = goldRefs(question.gold);
    ownNames += refs.ownNames;
    let hides = false;
    let hidesColumn = false;
    const known = budget.schemas.get(question.db);
    for (const table of refs.tables) {
      const printed = card?.tables.get(table);
      if (printed === undefined) {
        hiddenTables += 1;
        hides = true;
        continue;
      }
      for (const field of refs.columns.filter((column) => column.table === table)) {
        if (known?.get(table)?.has(field.column) !== true) {
          unmodelledColumns += 1;
          continue;
        }
        if (!printed.has(field.column)) {
          hiddenColumns += 1;
          hidesColumn = true;
        }
      }
    }
    if (hides) questionsHiding += 1;
    if (hidesColumn) questionsHidingColumn += 1;
  }
  return {
    lines: budget.lines,
    questions: questions.length,
    tables,
    columns,
    hiddenTables,
    questionsHiding,
    hiddenColumns,
    questionsHidingColumn,
    unmodelledColumns,
    ownNames,
  };
}

/** Read every budget over one population, and check the readings against each other. */
export function tallyReach(input: {
  readonly split: string;
  readonly arm: string;
  readonly questions: readonly ReachQuestion[];
  readonly budgets: readonly ReachBudget[];
  readonly schemaTables: number;
  readonly schemaColumns: number;
  readonly control: ReachControl;
  readonly source: ReachSource;
}): ReachReport {
  const readings = input.budgets.map((budget) => tallyReading(budget, input.questions)).sort((left, right) => left.lines - right.lines);
  const base: ReachReport = {
    split: input.split,
    arm: input.arm,
    readings,
    schemaTables: input.schemaTables,
    schemaColumns: input.schemaColumns,
    control: input.control,
    source: input.source,
    problems: [],
  };
  return { ...base, problems: reachProblems(base) };
}

/**
 * The arithmetic a reach report has to satisfy before any of it is quoted.
 *
 * Six checks, and the fourth is the one that would have caught the defect this instrument was built
 * for. Each is a statement two independently computed numbers have to agree on:
 *
 * 1. **A width cannot invent a table.** No reading may print more tables or columns than the schemas
 *    of the databases it read hold.
 * 2. **A wider card hides no more than a narrower one.** Monotonicity is not a property of this
 *    renderer by accident — it is the property the whole argument rests on, and a renderer that
 *    reordered tables would break it while still looking plausible at one width.
 * 3. **A hidden pair belongs to a question that hid something.** `questionsHiding` ≤ `questions`, and
 *    zero hidden pairs means zero such questions, in both directions.
 * 4. **The width the artifact says it was measured at cannot hide a table, if its own control says
 *    nothing was truncated.** `tablesInPrompts === tablesTotal` is the artifact claiming the card was
 *    complete; a reading at that width that hides a table means the two disagree about what was sent,
 *    and one of them is the number the published accuracy belongs to.
 * 5. **A reading with no questions is not a reading.** An empty population makes every count zero
 *    and every share undefined, which reads as a clean report.
 * 6. **The control's width, when it states one, is a width that was read.** Otherwise the gate in
 *    point 4 is comparing a run with a card nobody rendered.
 */
export function reachProblems(report: Omit<ReachReport, 'problems'>): string[] {
  const problems: string[] = [];
  for (const reading of report.readings) {
    if (reading.questions === 0) {
      problems.push(`REACH: the ${String(reading.lines)}-line reading has no question to read`);
    }
    if (reading.tables > report.schemaTables) {
      problems.push(
        `REACH: ${String(reading.lines)} lines printed ${String(reading.tables)} tables, more than the ${String(report.schemaTables)} the schemas hold`,
      );
    }
    if (reading.columns > report.schemaColumns) {
      problems.push(
        `REACH: ${String(reading.lines)} lines printed ${String(reading.columns)} columns, more than the ${String(report.schemaColumns)} the schemas hold`,
      );
    }
    if (reading.questionsHiding > reading.questions) {
      problems.push(`REACH: ${String(reading.questionsHiding)} questions hide a table of ${String(reading.questions)} asked`);
    }
    if (reading.hiddenTables === 0 !== (reading.questionsHiding === 0)) {
      problems.push(
        `REACH: the ${String(reading.lines)}-line reading hides ${String(reading.hiddenTables)} table(s) over ${String(reading.questionsHiding)} question(s), which cannot both be zero or both not`,
      );
    }
    if (reading.questionsHidingColumn > reading.questions) {
      problems.push(`REACH: ${String(reading.questionsHidingColumn)} questions hide a column of ${String(reading.questions)} asked`);
    }
  }
  for (let index = 1; index < report.readings.length; index += 1) {
    const narrow = report.readings[index - 1] as ReachReading;
    const wide = report.readings[index] as ReachReading;
    if (wide.hiddenTables > narrow.hiddenTables) {
      problems.push(
        `REACH: ${String(wide.lines)} lines hide ${String(wide.hiddenTables)} tables and ${String(narrow.lines)} lines hide ${String(narrow.hiddenTables)}; a wider card cannot hide more`,
      );
    }
    if (wide.hiddenColumns > narrow.hiddenColumns) {
      problems.push(
        `REACH: ${String(wide.lines)} lines hide ${String(wide.hiddenColumns)} columns and ${String(narrow.lines)} lines hide ${String(narrow.hiddenColumns)}; a wider card cannot hide more`,
      );
    }
  }
  const control = report.control;
  if (control.schemaLines !== undefined && !report.readings.some((reading) => reading.lines === control.schemaLines)) {
    problems.push(
      `REACH: the artifact was measured at ${String(control.schemaLines)} lines and no reading was taken there, so the gate has nothing to compare`,
    );
  }
  const complete = control.truncated === false && control.tablesInPrompts !== undefined && control.tablesInPrompts === control.tablesTotal;
  const measured = report.readings.find((reading) => reading.lines === control.schemaLines);
  if (complete && measured !== undefined && measured.hiddenTables > 0) {
    problems.push(
      `REACH: the artifact's control says every table reached the prompt (${String(control.tablesInPrompts)} of ${String(control.tablesTotal)}) and the reading at ${String(measured.lines)} lines hides ${String(measured.hiddenTables)} gold table(s) — the control and the card disagree`,
    );
  }
  return problems;
}

/** One line per width, in the order read. */
export function reachLines(report: ReachReport): string[] {
  return report.readings.map((reading) => {
    const share = percent(reading.questionsHiding, reading.questions);
    const columnShare = percent(reading.questionsHidingColumn, reading.questions);
    return (
      `  ${String(reading.lines).padStart(4)} lines  ` +
      `${String(reading.tables).padStart(3)} of ${String(report.schemaTables)} tables · ` +
      `${String(reading.columns).padStart(3)} of ${String(report.schemaColumns)} columns · ` +
      `hides ${String(reading.hiddenTables)} gold table(s) over ${String(reading.questionsHiding)} of ${String(reading.questions)} question(s) (${share}), ` +
      `${String(reading.hiddenColumns)} gold column(s) over ${String(reading.questionsHidingColumn)} (${columnShare})` +
      (reading.unmodelledColumns === 0 ? '' : `, ${String(reading.unmodelledColumns)} column(s) no schema holds`)
    );
  });
}

/** The sentence the report is for, over its widest reading. */
export function reachSentence(report: ReachReport): string {
  const widest = report.readings[report.readings.length - 1];
  if (widest === undefined) return 'no width was read';
  const hidden = widest.hiddenTables === 0;
  return (
    `at ${String(widest.lines)} lines the card ${hidden ? 'hid no table a gold statement reads' : `hid ${String(widest.hiddenTables)} gold table(s)`}; ` +
    `${hidden ? 'the relation bucket is a decision, not a retrieval' : 'a gold table the model never saw cannot be joined'} — ` +
    'nothing here was executed, so a hidden table is not by itself a wrong answer'
  );
}

export function reachPath(settings: { readonly root: string; readonly arm: string; readonly split: string }): string {
  return join(settings.root, 'eval', 'out', `reach-${settings.arm.replace(/[^a-z0-9.+#-]+/gi, '_')}-${settings.split}.json`);
}

/** Where a schema for one database comes from: the dataset's tables file and description directory. */
export function schemaForDatabase(table: BirdTable, notes: Map<string, Map<string, ColumnNote>>) {
  return buildSchema(table, notes, { withNotes: true });
}

export interface ReachSettings {
  readonly root: string;
  readonly artifact: string;
  readonly arm: string;
  readonly layout: BirdLayout;
  /** The width the run was measured at. Defaults to the artifact's own control. */
  readonly budget?: number;
  /** The width to price beside it. Defaults to the builders' own default of 40 column lines. */
  readonly compare: number;
  readonly out?: string;
}

export interface ReachArtifact {
  readonly split?: string;
  readonly generatedAt?: string;
  readonly controls?: {
    readonly schemaLines?: number;
    readonly tablesInPrompts?: number;
    readonly tablesTotal?: number;
    readonly truncatedPrompts?: readonly unknown[];
  };
  readonly cases: readonly {
    readonly arm: string;
    readonly id: string | number;
    readonly gold?: string;
    readonly asked?: { readonly db?: string };
  }[];
}

/** The gold statements of one arm's cases, which is the population reach is a property of. */
export function readReachQuestions(artifact: ReachArtifact, arm: string): ReachQuestion[] {
  const out: ReachQuestion[] = [];
  for (const row of artifact.cases) {
    if (row.arm !== arm) continue;
    if (row.gold === undefined || row.gold.trim().length === 0) continue;
    const db = row.asked?.db;
    if (db === undefined || db.trim().length === 0) continue;
    out.push({ id: String(row.id), db, gold: row.gold });
  }
  return out;
}

export function readReachControl(artifact: ReachArtifact): ReachControl {
  const controls = artifact.controls;
  return {
    ...(controls?.schemaLines === undefined ? {} : { schemaLines: controls.schemaLines }),
    ...(controls?.tablesInPrompts === undefined ? {} : { tablesInPrompts: controls.tablesInPrompts }),
    ...(controls?.tablesTotal === undefined ? {} : { tablesTotal: controls.tablesTotal }),
    truncated: (controls?.truncatedPrompts?.length ?? 0) > 0,
  };
}

export async function runReach(settings: ReachSettings): Promise<ReachReport> {
  const body = JSON.parse(readFileSync(settings.artifact, 'utf8')) as ReachArtifact;
  const questions = readReachQuestions(body, settings.arm);
  const control = readReachControl(body);
  const budgets = [...new Set([settings.budget ?? control.schemaLines ?? 400, settings.compare])];
  const tables = loadTables(settings.layout.tablesFile);
  const used = [...new Set(questions.map((question) => question.db))].sort();
  const render = (lines: number): Map<string, CardShape> => {
    const cards = new Map<string, CardShape>();
    for (const db of used) {
      const table = tables.get(db);
      if (table === undefined) throw new Error(`${settings.layout.tablesFile} has no entry for ${db}, so its card cannot be rendered`);
      const schema = schemaForDatabase(table, loadDescriptions(join(settings.layout.descriptionsRoot, db, 'database_description'), table.tableNames));
      cards.set(db, readCard(renderMacSqlCard(schema, { limit: lines })));
    }
    return cards;
  };
  // The totals are read from the same schemas the cards are: a reading cannot be compared with a
  // denominator it did not come from, and the gate's first check is that comparison.
  let schemaTables = 0;
  let schemaColumns = 0;
  const schemas = new Map<string, Map<string, Set<string>>>();
  for (const db of used) {
    const table = tables.get(db);
    if (table === undefined) continue;
    const schema = schemaForDatabase(table, loadDescriptions(join(settings.layout.descriptionsRoot, db, 'database_description'), table.tableNames));
    schemaTables += schema.length;
    schemaColumns += schema.reduce((total, entry) => total + entry.columns.length, 0);
    schemas.set(db, new Map(schema.map((entry) => [entry.table.toLowerCase(), new Set(entry.columns.map((column) => column.name.toLowerCase()))])));
  }
  return tallyReach({
    split: body.split ?? settings.layout.split,
    arm: settings.arm,
    questions,
    budgets: budgets.map((lines) => ({ lines, cards: render(lines), schemas })),
    schemaTables,
    schemaColumns,
    control,
    source: { path: settings.artifact, ...(body.generatedAt === undefined ? {} : { generatedAt: body.generatedAt }) },
  });
}

/**
 * Write the report, and refuse to replace one taken on a different artifact.
 *
 * One name is one population, for the reason `census.ts` states at its own writer: a split has two
 * populations the moment a second dispatch exists, and an instrument whose file can be overwritten
 * is an instrument whose numbers cannot be traced back to a run.
 */
export function writeReachArtifact(settings: ReachSettings, report: ReachReport): string {
  const path = settings.out ?? reachPath({ root: settings.root, arm: report.arm, split: report.split });
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as { source?: ReachSource };
    if (existing.source?.generatedAt !== report.source.generatedAt || existing.source?.path !== report.source.path) {
      throw new Error(
        `${path} already holds a reach report of ${existing.source?.path ?? 'another artifact'} (${existing.source?.generatedAt ?? 'no timestamp'}); ` +
          `refusing to replace it with ${report.source.path} — read the first one under its own name`,
      );
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

export function resolveReachSettings(
  argv: readonly string[],
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReachSettings {
  const takesValue = new Set(['--artifact', '--arm', '--budget', '--compare', '--out']);
  let artifact: string | undefined;
  let arm: string | undefined;
  let budget: number | undefined;
  let compare = 40;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!takesValue.has(token)) {
      throw new Error(`unrecognized argument ${token}: this harness takes --artifact, --arm, --budget, --compare and --out`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
    if (token === '--artifact') artifact = value;
    else if (token === '--arm') arm = value;
    else if (token === '--out') out = resolve(root, value);
    else {
      const lines = Number(value);
      if (!Number.isInteger(lines) || lines <= 0) throw new Error(`${token} needs a positive whole number of lines, not '${value}'`);
      if (token === '--budget') budget = lines;
      else compare = lines;
    }
    index += 1;
  }
  const layout = resolveLayout(env, root);
  return {
    root,
    artifact: artifact === undefined ? layout.out : resolve(root, artifact),
    arm: arm ?? 'macsql-prompt',
    layout,
    ...(budget === undefined ? {} : { budget }),
    compare,
    ...(out === undefined ? {} : { out }),
  };
}

export function percent(part: number, whole: number): string {
  if (whole === 0) return 'n/a';
  return `${((part / whole) * 100).toFixed(2)}%`;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const settings = resolveReachSettings(argv, root, env);
  const report = await runReach(settings);
  const path = writeReachArtifact(settings, report);
  const control = report.control;
  console.log(
    `reach · ${report.arm} · ${report.split} · ${String(report.readings[0]?.questions ?? 0)} question(s) · ` +
      `control: ${control.tablesInPrompts === undefined ? 'unstated' : `${String(control.tablesInPrompts)} of ${String(control.tablesTotal)} tables`}` +
      `${control.schemaLines === undefined ? '' : ` at ${String(control.schemaLines)} lines`}${control.truncated ? ', truncated' : ''}`,
  );
  for (const line of reachLines(report)) console.log(line);
  console.log(`  ${reachSentence(report)}`);
  console.log(`  written to ${path}`);
  for (const problem of report.problems) console.log(`  ${problem}`);
  return report.problems.length === 0 ? 0 : 1;
}

/**
 * Run `main` when this file is the program, and do nothing when it is imported.
 *
 * A function rather than a module-level `if`, for the reason the module's own gates exist: the
 * module-level form has a branch no test can take, so the line that decides whether a harness runs is
 * the one line in the file no test ever executes. Here both paths are exercised — the false one by
 * every import in the suite, the true one by `startIfEntry(..., async () => 0)`.
 */
export async function startIfEntry(
  argv1: string | undefined,
  moduleUrl: string,
  run: () => Promise<number>,
): Promise<void> {
  if (!isEntry(argv1, moduleUrl)) return;
  process.exitCode = await run();
}

await startIfEntry(process.argv[1], import.meta.url, main);
