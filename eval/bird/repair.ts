/**
 * The no-answer statements that one provable edit away from right.
 *
 * `bench:bird:gap:values` splits the `values` bucket into the thirteen clauses a statement
 * can get wrong, and the reading refuted the hypothesis it was built on: aggregation is one
 * case in 396, conditions and tables are 137. That leaves the question this tool answers —
 * of those, which can be *edited* rather than regenerated?
 *
 * Only one edit qualifies. A literal the column stores in another case (`'continuation
 * school'` against `Continuation School`) is a statement that runs, matches nothing, and is
 * wrong for a reason the schema states. Everything else in the bucket needs the model to have
 * meant something different, and no text substitution can recover a meaning that was never
 * there.
 *
 * Two probes were considered and are not here, because the measurement would have been about
 * the probe rather than about the statements:
 *
 * - **`select distinct`.** `filter-wide` is 88 of the 396, and a join that multiplies rows is
 *   the obvious explanation. It cannot be: BIRD's official judge compares result *sets*, so
 *   duplicates are already collapsed and `distinct` is a provable no-op on the metric. Row
 *   count differences are therefore different rows, not repeated ones, and the fan-out story
 *   is dead on the metric definition rather than on a measurement.
 * - **Nearest-value substitution.** `'2014-04-23 20:29:39'` → `'2014-04-23 20:29:39.0'` is one
 *   edit that recovers a case, and it is a guess that happens to be right. A repair that turns
 *   an empty answer into a plausible wrong one is worse than the empty answer, because only one
 *   of the two is visibly wrong.
 *
 * The instrument has two halves, and the second is what makes the first safe to ship:
 *
 * 1. **Inert on the gold corpus.** Every statement in the split that is already right is run
 *    through the same repair. The bar is zero changes: an edit that fires on a correct
 *    statement is an edit that can break one.
 * 2. **Effective on the failures.** Every retained no-answer statement is repaired, executed,
 *    and compared with the gold result set. The reading is fixed / still wrong / refused by the
 *    engine.
 *
 * `--strict` separates the gate from the measurement, as it does in `bench:bird:gap:values`:
 * the dev workflow runs it to read, the quality gate runs it to enforce. There is no floor on
 * the number of fixes — a repair that recovers nothing is a finding, not a broken build — but
 * an instrument that cannot measure is a broken build, and so is one that edits correct
 * statements.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { groundLiteralCase } from './literal-repair.js';
import type { ColumnDomain } from './literal-repair.js';
import { literalSites, tableRefs } from './statement.js';
import { loadQuestions } from './data.js';
import type { BirdQuestion } from './data.js';
import { createOracle } from './oracle.js';
import { requireArm } from './presence.js';
import { resolveLayout } from './run.js';
import type { BirdLayout } from './run.js';
import type { CaseRecord, GapReportShape, ReportedFailure } from './gap.js';

/**
 * The two verdicts a repaired statement can earn.
 *
 * There is no third. A literal edit cannot make a runnable statement unrunnable — the value is
 * quoted and the rest of the text is untouched — so "the engine refused the edit" is not a
 * result to report but a bug in the edit, and it throws.
 */
export const REPAIR_VERDICTS = ['fixed', 'still-wrong'] as const;
export type RepairVerdict = (typeof REPAIR_VERDICTS)[number];

export interface RepairRow {
  readonly id: string;
  /** How many literals the edit replaced. */
  readonly substitutions: number;
  readonly verdict: RepairVerdict;
}

export interface RepairOutcome {
  readonly split: string;
  readonly arm: string;
  /** Gold statements, how many the gate offered, and how many the repair touched. */
  readonly gold: { readonly statements: number; readonly empty: number; readonly changed: readonly string[] };
  /** No-answer statements: skipped by the gate, offered to the repair, rewritten by it. */
  readonly cases: { readonly offered: number; readonly repaired: number; readonly gated: number };
  readonly rows: readonly RepairRow[];
  readonly tally: Readonly<Record<RepairVerdict, number>>;
  readonly drops: {
    readonly unretained: number;
    readonly unknownQuestion: number;
    readonly goldFailed: number;
  };
  readonly problems: readonly string[];
}

export interface RepairSettings {
  readonly reportPath: string;
  readonly arm: string;
  readonly strict: boolean;
  readonly out: string;
  readonly layout: BirdLayout;
}

/** The rows a report can be read as, without trusting any of them. */
function casesOf(report: GapReportShape): readonly CaseRecord[] {
  return report.cases ?? [];
}

/**
 * One column's stored values, queried once per run.
 *
 * A read that fails is cached as no values, which makes the repair refuse to fire on that
 * column. That is the safe direction: the edit's whole licence is knowing what the column
 * stores, and a column whose contents are unknown is one where a substitution would be a
 * guess. A column reaches this function because a statement the engine accepted compares
 * against it, so in practice the read succeeds — the empty list is what happens when it does
 * not, not an alternative outcome that needs its own report.
 */
function domainReader(oracle: ReturnType<typeof createOracle>, db: string, cache: Map<string, readonly string[]>) {
  return async (table: string, column: string): Promise<readonly string[]> => {
    const key = `${db}\u0000${table}\u0000${column}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const quotedTable = `"${table.replace(/"/g, '""')}"`;
    const quotedColumn = `"${column.replace(/"/g, '""')}"`;
    const result = await oracle.run(db, `select distinct ${quotedColumn} from ${quotedTable}`);
    if (!result.ok) return [];
    const values = [...new Set(result.rows.map((row) => String(row[0])))].filter((value) => value !== '');
    cache.set(key, values);
    return values;
  };
}

type ReadDomain = (table: string, column: string) => Promise<readonly string[]>;

/**
 * The domains this statement's comparison sites could be reading.
 *
 * An unqualified column that exists in two joined tables yields two domains, and the repair
 * refuses to choose between them — that decision belongs in `groundLiteralCase`, which is
 * where it is tested.
 */
async function domainsOf(sql: string, read: ReadDomain): Promise<ColumnDomain[]> {
  const refs = tableRefs(sql);
  const aliases = new Map(refs.map((ref) => [ref.alias.toLowerCase(), ref.table.toLowerCase()]));
  const wanted = new Map<string, { table: string; column: string }>();
  for (const site of literalSites(sql)) {
    // A qualifier that is not one of the statement's own aliases names a table this reader
    // cannot see — a comma join, a subquery — and a column guessed from it would be read from
    // the wrong table. The site is skipped rather than resolved by elimination.
    const named = site.qualifier === undefined ? undefined : aliases.get(site.qualifier.toLowerCase());
    if (site.qualifier !== undefined && named === undefined) continue;
    const tables = named === undefined ? refs.map((ref) => ref.table) : [named];
    for (const table of tables) wanted.set(`${table.toLowerCase()}\u0000${site.column.toLowerCase()}`, { table, column: site.column });
  }
  const domains: ColumnDomain[] = [];
  for (const { table, column } of wanted.values()) {
    const values = await read(table, column);
    if (values.length > 0) domains.push({ table, column, values });
  }
  return domains;
}

/** Result sets compare as multisets of stringified tuples, which is what the judge does. */
function keyOf(rows: readonly (readonly unknown[])[]): string {
  return rows
    .map((row) => JSON.stringify(row.map((cell) => (cell === null ? null : String(cell)))))
    .sort()
    .join('\n');
}

export function tallyRepairs(rows: readonly RepairRow[]): Record<RepairVerdict, number> {
  const tally = { fixed: 0, 'still-wrong': 0 } as Record<RepairVerdict, number>;
  for (const row of rows) tally[row.verdict] += 1;
  return tally;
}

/**
 * The two conditions that make this a gate rather than a report.
 *
 * Inertness is absolute: one edited gold statement is a regression that the split's own
 * questions would have caught later and attributed to something else. The measurement
 * condition is narrower — a run with no no-answer case at all is a perfect run and passes,
 * while a run with no-answer cases and no readable statement is an artifact that cannot
 * support any claim, which is not the same thing.
 */
export function repairProblems(outcome: {
  readonly gold: { readonly statements: number; readonly changed: readonly string[] };
  readonly cases: { readonly offered: number; readonly repaired: number };
}): string[] {
  // Inertness is measured, not assumed: the gate makes it a property of the corpus (no gold
  // is empty), and this is the check that the property holds for the split in hand.
  const problems: string[] = [];
  if (outcome.gold.changed.length > 0) {
    problems.push(
      `the repair edits ${String(outcome.gold.changed.length)} of ${String(outcome.gold.statements)} gold statements ` +
        `(${outcome.gold.changed.slice(0, 5).join(', ')}), so it can break a case that passes today`,
    );
  }
  if (outcome.cases.offered > 0 && outcome.cases.repaired === 0) {
    problems.push('no no-answer statement could be read, so nothing was measured');
  }
  return problems;
}

export async function runRepair(settings: RepairSettings): Promise<RepairOutcome> {
  const report = JSON.parse(readFileSync(settings.reportPath, 'utf8')) as GapReportShape;
  requireArm(casesOf(report), settings.arm, settings.reportPath);
  const questions = loadQuestions(settings.layout.questionsFile);
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));
  const statements = new Map((report.failures?.[settings.arm] ?? []).map((entry: ReportedFailure) => [String(entry.id), entry]));
  const noAnswer = casesOf(report).filter((row) => row.arm === settings.arm && row.candidateRecall === false);
  const drops = { unretained: 0, unknownQuestion: 0, goldFailed: 0 };
  const rows: RepairRow[] = [];
  const oracle = createOracle(settings.layout.oracleScript, settings.layout.databaseRoot);
  const cache = new Map<string, readonly string[]>();
  const readers = new Map<string, ReadDomain>();
  const readerFor = (db: string): ReadDomain => {
    const existing = readers.get(db);
    if (existing !== undefined) return existing;
    const created = domainReader(oracle, db, cache);
    readers.set(db, created);
    return created;
  };

  try {
    // Half one: the repair must be a no-op on everything that is already right. The gold
    // statements are the only corpus in the split that is known to be correct, which makes
    // them the right place to look for a break.
    const changed: string[] = [];
    let goldEmpty = 0;
    for (const question of questions) {
      const offered = await goldPass(question, oracle, readerFor(question.db_id), changed);
      if (offered) goldEmpty += 1;
    }
    const statementsSeen = questions.length;
    // Half two: the repair must recover something on what is wrong.
    let offered = 0;
    let repaired = 0;
    let gated = 0;
    for (const row of noAnswer) {
      const id = String(row.id);
      const question = byId.get(id);
      if (question === undefined) {
        drops.unknownQuestion += 1;
        continue;
      }
      const failure = statements.get(id);
      if (failure === undefined || typeof failure.predicted !== 'string') {
        drops.unretained += 1;
        continue;
      }
      const before = await oracle.run(question.db_id, failure.predicted);
      // The gate: a statement that returned rows is not offered to the repair, because the
      // corpus contains gold statements whose own literal is in the wrong case (dev 640
      // stores `mornington` and the gold says `Mornington`), and editing a statement that
      // already matches gold is how a passing case gets broken.
      if (!before.ok || before.rows.length > 0) {
        gated += 1;
        continue;
      }
      offered += 1;
      const read = readerFor(question.db_id);
      const domains = await domainsOf(failure.predicted, read);
      const edit = groundLiteralCase(failure.predicted, domains);
      if (edit.substitutions.length === 0) continue;
      repaired += 1;
      const expected = await oracle.run(question.db_id, question.SQL);
      if (!expected.ok) {
        drops.goldFailed += 1;
        continue;
      }
      const after = await oracle.run(question.db_id, edit.sql);
      // An edit that the engine refuses did not answer the question, which is what
      // `still-wrong` says. It cannot happen — the value is quoted and the rest of the text is
      // untouched — and inventing a third verdict for it would be a report column that only
      // ever prints zero.
      const verdict: RepairVerdict = after.ok && keyOf(after.rows) === keyOf(expected.rows) ? 'fixed' : 'still-wrong';
      rows.push({ id, substitutions: edit.substitutions.length, verdict });
    }
    const tally = tallyRepairs(rows);
    const problems = repairProblems({ gold: { statements: statementsSeen, changed }, cases: { offered, repaired } });
    return {
      split: settings.layout.split,
      arm: settings.arm,
      gold: { statements: statementsSeen, empty: goldEmpty, changed },
      cases: { offered, repaired, gated },
      rows,
      tally,
      drops,
      problems,
    };
  } finally {
    await oracle.close();
  }
}

/**
 * One gold statement through the repair, behind the same gate the failures go through.
 *
 * The gate is the whole safety argument, and it is a property of the corpus rather than of
 * the edit: the repair only fires on a statement that returned nothing, and no gold answer in
 * either split is empty (`controls.emptyGoldExcluded` is 0 in both). A correct statement
 * therefore never reaches the edit, which is why the bar below can be absolute.
 *
 * Returns true when the gate offered the statement to the repair at all.
 */
async function goldPass(
  question: BirdQuestion,
  oracle: ReturnType<typeof createOracle>,
  read: ReadDomain,
  changed: string[],
): Promise<boolean> {
  const result = await oracle.run(question.db_id, question.SQL);
  if (!result.ok || result.rows.length > 0) return false;
  const domains = await domainsOf(question.SQL, read);
  if (domains.length === 0) return true;
  const edit = groundLiteralCase(question.SQL, domains);
  if (edit.substitutions.length > 0) changed.push(String(question.question_id));
  return true;
}

export function repairLines(outcome: RepairOutcome): string[] {
  const rows: string[] = [];
  rows.push(`${outcome.split}, arm ${outcome.arm}`);
  rows.push('');
  rows.push(`  gold statements           ${String(outcome.gold.statements)}`);
  rows.push(`  gold with no rows (gate)  ${String(outcome.gold.empty)}`);
  rows.push(`  gold edited by the repair ${String(outcome.gold.changed.length)}`);
  rows.push(`  failures with rows (gate) ${String(outcome.cases.gated)}`);
  rows.push(`  failures with no rows     ${String(outcome.cases.offered)}`);
  rows.push(`  it rewrote                ${String(outcome.cases.repaired)}`);
  rows.push('');
  rows.push(`  fixed                     ${String(outcome.tally.fixed)}`);
  rows.push(`  still wrong               ${String(outcome.tally['still-wrong'])}`);
  return rows;
}

export function repairGapPath(settings: RepairSettings): string {
  return join(settings.out, `repair-${settings.arm.replace(/[^a-z0-9+_-]/gi, '-')}.json`);
}

export function writeRepairArtifact(settings: RepairSettings, outcome: RepairOutcome): string {
  const path = repairGapPath(settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(outcome, null, 2));
  return path;
}

export function resolveRepairSettings(
  env: Record<string, string | undefined>,
  argv: readonly string[],
  root = process.cwd(),
): RepairSettings {
  const flag = argv.indexOf('--arm');
  const named = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && named === undefined) throw new Error('--arm needs a name');
  const consumed = flag === -1 ? [] : [flag, flag + 1];
  const path = argv.find((item, index) => !item.startsWith('--') && !consumed.includes(index));
  if (path === undefined) throw new Error('usage: repair.ts <report.json> [--arm <name>] [--strict]');
  return {
    reportPath: path,
    arm: named ?? 'select',
    strict: argv.includes('--strict'),
    out: join(root, 'eval', 'out'),
    layout: resolveLayout(env, root),
  };
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const settings = resolveRepairSettings(env, argv, root);
  const outcome = await runRepair(settings);
  for (const line of repairLines(outcome)) console.log(line);
  console.log(
    `\n  dropped: ${String(outcome.drops.unretained)} unretained, ${String(outcome.drops.unknownQuestion)} unknown question, ` +
      `${String(outcome.drops.goldFailed)} unrunnable gold`,
  );
  const path = writeRepairArtifact(settings, outcome);
  console.log(`\nwrote ${path}`);
  for (const problem of outcome.problems) console.error(problem);
  if (outcome.problems.length === 0) return 0;
  return settings.strict ? 1 : 0;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
