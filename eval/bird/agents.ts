/**
 * The three agents the competitor splits the job into, and when each one fires.
 *
 * The 6.45pp gap to MAC-SQL has been attacked one lever at a time. Two are priced: the value
 * examples their selector reads (`differential.ts` — a ceiling of 2.22pp, measured at +2.82pp,
 * their sampling rule worth 0.00pp for +18.3% prompt) and the card cut to the columns a model
 * names (`inline+evidence+llm-select` — −5.65pp, kept as an ablation reference). What has not
 * been priced is the *shape* of their pipeline: three agents, each of which runs or does not.
 *
 * A condition can be counted. Their source states each one exactly:
 *
 * - **Selector** — `_is_need_prune` fires unless `total_columns // tables <= 6 and
 *   total_columns <= 30`. On a small database the selector never runs and the whole card goes
 *   through, so "they spend 2–3 calls a question" is itself a claim to be counted rather than
 *   repeated.
 * - **Decomposer** — no condition: it runs on every question, and its template is 5,643
 *   characters of which most is a worked example. Our own two readings of the decomposition
 *   shape (`decompose`, 100% firing, −1.1pp then −0.85pp) and of retrieved demonstrations
 *   (`inline+icl`, 41.7%) price the two halves of that prompt, so this file does not re-run it.
 * - **Refiner** — `_is_need_refine` fires on three conditions, and two of them are not errors:
 *   the statement threw, the statement returned no rows (their diagnostic: `no data selected`),
 *   or the first five rows contain a NULL (their diagnostic: ``exist None value, you can add
 *   `NOT NULL` in SQL``). The second and third messages are constants — the same string for
 *   every case — and the third tells the model to filter rows out of a result that was not
 *   wrong.
 *
 * So this counts, with no model call:
 *
 * 1. **Reach.** Of the statements the artifact kept, how many fire each trigger. A fire is a
 *    precondition for a repair, never a repair, so the count is a ceiling on what a refiner
 *    with that trigger could touch — and the cases that fire nothing are the ones no refiner
 *    of this kind can see at any budget.
 * 2. **Precision of the signal.** On BIRD Mini-Dev no gold result is empty, so the empty
 *    trigger fires only on wrong answers. The NULL trigger has no such guarantee, which is why
 *    the same count is taken over the *gold* statements: a gold result that fires is a case
 *    where a correct answer would be rewritten.
 * 3. **The bill.** Fires per case, and the characters each fire re-sends: the card again, the
 *    statement, the diagnostic, and the 1,046 characters of their template that are not
 *    placeholders.
 *
 * The result is a bound on the last unmeasured mechanism of their pipeline, computed from their
 * own predicates and our databases, before any model is asked to sit in the loop.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadQuestions, loadTables } from './data.js';
import type { BirdTable } from './data.js';
import type { CaseRecord } from './gap.js';
import { promptForCase } from './information.js';
import { createOracle } from './oracle.js';
import type { Oracle, OracleResult } from './oracle.js';
import { resolveArm, resolveLayout } from './run.js';
import type { Arm, BirdLayout } from './run.js';

/** Which pin the predicates below were read from. */
export const AGENT_RULE = 'mac-sql@31a9df5e';

export const TRIGGERS = ['error', 'empty', 'null', 'none'] as const;
export type Trigger = (typeof TRIGGERS)[number];

/**
 * The two diagnostics their refiner writes itself, byte for byte.
 *
 * They are here rather than paraphrased because the finding is about these strings: one is
 * empty of content and the other is false. The error trigger is the only one that forwards
 * what the engine actually said.
 */
export const FABRICATED: Readonly<Record<'empty' | 'null', string>> = {
  empty: 'no data selected',
  null: 'exist None value, you can add `NOT NULL` in SQL',
};

/** Characters of `refiner_template` that are not placeholders: what every refine re-sends. */
export const REFINE_TEMPLATE_CHARS = 1_046;

/** The rows their NULL scan covers, because `_execute_sql` returns `result[:5]`. */
export const NULL_WINDOW = 5;

/** `_is_need_prune`'s thresholds, as integers. */
export const SELECTOR_LIMITS = { average: 6, total: 30 } as const;

/** What a database's shape has to be for the selector to fire. */
export interface ColumnCounts {
  /** Columns with a table (`column_names` entries at index >= 0; the `*` row is not one). */
  readonly columns: number;
  readonly tables: number;
}

/**
 * Whether their selector runs on this database.
 *
 * `init_db2jsons` computes `avg_column_count` with floor division, so the comparison is on
 * `columns // tables` and not on the mean: a database of 41 columns over 7 tables averages
 * 5.86 and compares as 5, which is the difference between a selector call and none.
 */
export function selectsSchema(counts: ColumnCounts): boolean {
  // Their code would divide by zero here; a database with no tables has nothing to select.
  if (counts.tables === 0) return false;
  const average = Math.floor(counts.columns / counts.tables);
  return average > SELECTOR_LIMITS.average || counts.columns > SELECTOR_LIMITS.total;
}

/** What one statement did, in the three facts their refiner reads. */
export interface ExecutedShape {
  readonly error: string | null;
  readonly rows: number;
  readonly nullInWindow: boolean;
}

export function shapeOf(result: OracleResult): ExecutedShape {
  return {
    error: result.ok ? null : (result.error ?? 'the engine refused it without a message'),
    rows: result.rows.length,
    // The window is theirs: a NULL in the sixth row is invisible to `_is_need_refine`, and a
    // model of the rule that scanned every row would report fires that never happen.
    nullInWindow: result.rows.slice(0, NULL_WINDOW).some((row) => row.some((cell) => cell === null)),
  };
}

/** Which of their three conditions fires, in their order: error, then empty, then NULL. */
export function triggerOf(shape: ExecutedShape): Trigger {
  if (shape.error !== null) return 'error';
  if (shape.rows === 0) return 'empty';
  if (shape.nullInWindow) return 'null';
  return 'none';
}

export interface Diagnostic {
  readonly text: string;
  /** Whether the text carries anything about this case. */
  readonly specific: boolean;
}

/**
 * The message a fire sends to the model.
 *
 * An error forwards the engine's own words, which name the column, the table or the token. The
 * other two are constants: whatever went wrong, the model is told the same sentence.
 */
export function diagnosticOf(trigger: Exclude<Trigger, 'none'>, error: string | null): Diagnostic {
  if (trigger === 'error') return { text: error ?? '', specific: true };
  return { text: FABRICATED[trigger], specific: false };
}

export interface Population {
  readonly total: number;
  readonly byTrigger: Readonly<Record<Trigger, number>>;
  /**
   * The questions whose trigger fired, so a reader can open the cases rather than trust a count.
   *
   * Nine ids on the gold side is the whole of a claim about a competitor's mechanism damaging
   * its own correct answers; a number without the cases cannot be checked and reads as an
   * assertion.
   */
  readonly fired: readonly string[];
}

export interface FailurePopulation extends Population {
  /** Failure reason by trigger, so "reachable" can be read against what went wrong. */
  readonly reasons: Readonly<Record<Trigger, Readonly<Record<string, number>>>>;
}

export interface AgentTally {
  readonly cases: number;
  readonly failures: FailurePopulation;
  /** Gold statements of the same cases: the cases where a correct answer fires. */
  readonly gold: Population;
  /** Failures that fire something: the ceiling in cases. */
  readonly reachable: number;
  /** Failures that fire nothing, so no execution-triggered refiner can see them. */
  readonly invisible: number;
  readonly specific: number;
  readonly constant: number;
}

export interface AgentCost {
  readonly firesPerCase: number;
  readonly extraCallsPerCase: number;
  /** Characters a fire re-sends: card, statement, diagnostic, template. */
  readonly charsPerCall: number;
  /** ...times the fires per case. */
  readonly charsPerCase: number;
}

export interface AgentsOutcome {
  readonly split: string;
  readonly arm: string;
  readonly tally: AgentTally;
  readonly cost: AgentCost;
  readonly selector: {
    readonly databases: number;
    readonly selecting: number;
    readonly questions: number;
    readonly selected: number;
  };
  readonly drops: {
    readonly unknownArm: number;
    readonly unknownQuestion: number;
    readonly noStatement: number;
    readonly unreadable: number;
  };
  readonly problems: readonly string[];
}

const emptyTriggers = (): Record<Trigger, number> => ({ error: 0, empty: 0, null: 0, none: 0 });

const emptyReasons = (): Record<Trigger, Record<string, number>> => ({
  error: {},
  empty: {},
  null: {},
  none: {},
});

/** Column counts the way `init_db2jsons` counts them. */
export function countsOf(table: BirdTable): ColumnCounts {
  let columns = 0;
  for (const [index] of table.columnNames) if (index >= 0) columns += 1;
  return { columns, tables: table.tableNames.length };
}

export async function runAgents(settings: AgentsSettings, oracle: Oracle): Promise<AgentsOutcome> {
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as {
    split?: string;
    cases?: readonly CaseRecord[];
    failures?: Readonly<Record<string, readonly { readonly id?: string; readonly predicted?: string; readonly reason?: string }[]>>;
    failureSample?: { readonly truncated?: readonly string[] };
    controls?: { readonly synthesizedDefinitions?: Readonly<Record<string, string>> };
  };
  const questions = loadQuestions(settings.layout.questionsFile);
  const tables = loadTables(settings.layout.tablesFile);
  const byId = new Map<string, (typeof questions)[number]>();
  for (const question of questions) byId.set(String(question.question_id), question);
  const definitions = report.controls?.synthesizedDefinitions ?? {};
  const drops = { unknownArm: 0, unknownQuestion: 0, noStatement: 0, unreadable: 0 };

  const cases = (report.cases ?? []).filter((row) => row.arm === settings.arm);
  if (cases.length === 0) drops.unknownArm = 1;
  const statements = new Map<string, string>();
  for (const entry of report.failures?.[settings.arm] ?? []) {
    if (entry.id !== undefined && entry.predicted !== undefined) statements.set(String(entry.id), entry.predicted);
  }

  const failures = { total: 0, byTrigger: emptyTriggers(), reasons: emptyReasons(), fired: [] as string[] };
  const gold = { total: 0, byTrigger: emptyTriggers(), fired: [] as string[] };
  const dbs = new Map<string, ColumnCounts>();
  let reachable = 0;
  let specific = 0;
  let constant = 0;
  let chars = 0;

  for (const record of cases) {
    const id = String(record.id);
    const question = byId.get(id);
    const table = question === undefined ? undefined : tables.get(question.db_id);
    if (question === undefined || table === undefined) {
      drops.unknownQuestion += 1;
      continue;
    }
    dbs.set(question.db_id, countsOf(table));
    const statement = record.passed === true ? undefined : statements.get(id);
    if (record.passed !== true && statement === undefined) drops.noStatement += 1;

    if (statement !== undefined) {
      const shape = shapeOf(await oracle.run(question.db_id, statement));
      const trigger = triggerOf(shape);
      failures.total += 1;
      failures.byTrigger[trigger] += 1;
      const reason = record.reason ?? 'unknown';
      failures.reasons[trigger][reason] = (failures.reasons[trigger][reason] ?? 0) + 1;
      if (trigger !== 'none') {
        reachable += 1;
        failures.fired.push(id);
        const diagnostic = diagnosticOf(trigger, shape.error);
        if (diagnostic.specific) specific += 1;
        else constant += 1;
        // The card is rebuilt per case rather than per database: it carries the question, so
        // a per-database cache would price one question and charge it to every other.
        const prompt = promptForCase(settings.armSpec, question, definitions[question.db_id] ?? '', table);
        chars += prompt.length + statement.length + diagnostic.text.length + REFINE_TEMPLATE_CHARS;
      }
    }

    // The same question's gold statement: a fire here is a fire on an answer that is right.
    const result = await oracle.run(question.db_id, question.SQL);
    if (!result.ok) {
      drops.unreadable += 1;
      continue;
    }
    gold.total += 1;
    const goldTrigger = triggerOf(shapeOf(result));
    gold.byTrigger[goldTrigger] += 1;
    if (goldTrigger !== 'none') gold.fired.push(id);
  }

  const fires = reachable;
  const cost: AgentCost = {
    firesPerCase: cases.length === 0 ? 0 : fires / cases.length,
    extraCallsPerCase: cases.length === 0 ? 0 : fires / cases.length,
    charsPerCall: fires === 0 ? 0 : chars / fires,
    charsPerCase: cases.length === 0 ? 0 : chars / cases.length,
  };
  let selecting = 0;
  for (const counts of dbs.values()) if (selectsSchema(counts)) selecting += 1;
  let selected = 0;
  for (const record of cases) {
    const question = byId.get(String(record.id));
    const counts = question === undefined ? undefined : dbs.get(question.db_id);
    if (counts !== undefined && selectsSchema(counts)) selected += 1;
  }
  const tally: AgentTally = {
    cases: cases.length,
    failures,
    gold,
    reachable,
    invisible: failures.byTrigger.none,
    specific,
    constant,
  };
  return {
    split: report.split ?? settings.layout.split,
    arm: settings.arm,
    tally,
    cost,
    selector: { databases: dbs.size, selecting, questions: cases.length, selected },
    drops,
    problems: agentsProblems({ tally, drops, arm: settings.arm, truncated: report.failureSample?.truncated ?? [] }),
  };
}

/** The ceiling in percentage points: failures that fire, over the questions scored. */
export function reachPoints(tally: AgentTally): number {
  return tally.cases === 0 ? 0 : (tally.reachable / tally.cases) * 100;
}

/**
 * The damage floor in points: gold results that fire the empty or NULL trigger.
 *
 * A gold statement that fires is a question whose *correct* answer asks for a rewrite, and the
 * rewrite is instructed with a constant that is not about this case. A correct prediction may
 * order its rows differently and present a different five-row window, so this is the floor of
 * that surface and not its size.
 */
export function damagePoints(tally: AgentTally): number {
  if (tally.gold.total === 0) return 0;
  return ((tally.gold.byTrigger.empty + tally.gold.byTrigger.null) / tally.gold.total) * 100;
}

export function agentsProblems(input: {
  readonly tally: AgentTally;
  readonly drops: AgentsOutcome['drops'];
  readonly arm: string;
  readonly truncated: readonly string[];
}): string[] {
  const problems: string[] = [];
  if (input.drops.unknownArm > 0) {
    problems.push(`AGENTS: the artifact has no cases for arm ${input.arm}, so no agent was counted`);
  }
  if (input.truncated.includes(input.arm)) {
    problems.push(
      `AGENTS: the failure list for ${input.arm} was truncated, so the reach is a floor on the reachable cases and not the count`,
    );
  }
  if (input.tally.failures.total === 0 && input.drops.unknownArm === 0) {
    problems.push('AGENTS: no failed statement was available, so no trigger was counted');
  }
  // One root cause, not two symptoms: an arm with no cases also has no gold, and reporting both
  // would make a missing arm read as two faults. Same rule as `differential.ts` and
  // `information.ts`.
  if (input.tally.gold.total === 0 && input.drops.unknownArm === 0) {
    problems.push('AGENTS: no gold statement could be read, so the damage floor has no denominator');
  }
  return problems;
}

export interface AgentsSettings {
  readonly report: string;
  readonly layout: BirdLayout;
  readonly arm: string;
  readonly armSpec: Arm;
  readonly out: string;
  readonly strict: boolean;
}

export function resolveAgentsSettings(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  root: string,
): AgentsSettings {
  const flag = argv.indexOf('--arm');
  const named = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && named === undefined) throw new Error('--arm needs a name');
  const consumed = flag === -1 ? [] : [flag, flag + 1];
  const path = argv.find((item, index) => !item.startsWith('--') && !consumed.includes(index));
  if (path === undefined) throw new Error('usage: agents.ts <report.json> [--arm <name>] [--strict]');
  const layout = resolveLayout(env, root);
  const arm = named ?? 'inline+evidence';
  const spec = resolveArm(arm);
  if (spec === undefined) throw new Error(`unknown arm: ${arm}`);
  return { report: path, layout, arm, armSpec: spec, out: dirname(layout.out), strict: argv.includes('--strict') };
}

export function agentsLines(outcome: AgentsOutcome): string[] {
  const share = (count: number, total: number): string => (total === 0 ? '0.0%' : `${((count / total) * 100).toFixed(1)}%`);
  const out = [`their three agents against ${outcome.arm} on ${outcome.split}`, ''];
  out.push(`  selector: fires on ${String(outcome.selector.selecting)} of ${String(outcome.selector.databases)} databases, so ${String(outcome.selector.selected)} of ${String(outcome.selector.questions)} questions pay for it`);
  out.push('');
  out.push(`  refiner: the ${String(outcome.tally.failures.total)} failed statement(s) the artifact kept, by the condition that fires`);
  for (const trigger of TRIGGERS) {
    const count = outcome.tally.failures.byTrigger[trigger];
    out.push(`  ${trigger.padEnd(6)} ${String(count).padStart(4)}  ${share(count, outcome.tally.failures.total)}`);
  }
  out.push('');
  out.push(`  reach: ${String(outcome.tally.reachable)} case(s) fire, so a refiner with these triggers could touch ${reachPoints(outcome.tally).toFixed(2)}pp`);
  out.push(`  invisible: ${String(outcome.tally.invisible)} failure(s) fire nothing — ${share(outcome.tally.invisible, outcome.tally.failures.total)} of them`);
  out.push(`  diagnostics: ${String(outcome.tally.specific)} carry the engine's words, ${String(outcome.tally.constant)} are one constant string`);
  out.push('');
  out.push('  gold, the same triggers over answers that are right');
  for (const trigger of TRIGGERS) {
    const count = outcome.tally.gold.byTrigger[trigger];
    out.push(`  ${trigger.padEnd(6)} ${String(count).padStart(4)}  ${share(count, outcome.tally.gold.total)}`);
  }
  out.push(`  damage floor: ${damagePoints(outcome.tally).toFixed(2)}pp of correct answers would be rewritten`);
  out.push('');
  out.push(
    `  cost: ${outcome.cost.extraCallsPerCase.toFixed(3)} calls a case, ${outcome.cost.charsPerCall.toFixed(0)} characters a fire (${outcome.cost.charsPerCase.toFixed(0)} a case)`,
  );
  return out;
}

export function agentsPath(settings: AgentsSettings): string {
  return join(settings.out, `agents-${settings.arm.replace(/[^a-z0-9+_-]/gi, '-')}.json`);
}

export function writeAgents(settings: AgentsSettings, outcome: AgentsOutcome): string {
  const path = agentsPath(settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(outcome, null, 2));
  return path;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const settings = resolveAgentsSettings(env, argv, root);
  const oracle = createOracle(join(root, 'eval/bird/oracle.py'), settings.layout.databaseRoot);
  try {
    const outcome = await runAgents(settings, oracle);
    for (const line of agentsLines(outcome)) console.log(line);
    const path = writeAgents(settings, outcome);
    console.log(`\nwrote ${path}`);
    for (const problem of outcome.problems) console.error(problem);
    if (outcome.problems.length === 0) return 0;
    return settings.strict ? 1 : 0;
  } finally {
    await oracle.close();
  }
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
