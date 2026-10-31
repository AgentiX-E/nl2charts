/**
 * What the competitor's value-example block adds to our card, measured without a model.
 *
 * The gap to MAC-SQL is 6.45pp and the plan's next step is to attribute it to a block rather
 * than to "their pipeline". Their selector reads a card on which every non-key column carries
 * `Value examples: [...]`; ours carries stored values for categorical columns only. Before
 * spending a model run on that difference, three questions have exact answers from the
 * database and the artifact, and each bounds the model run that follows:
 *
 * 1. **How much information is there?** For every gold statement, the filter values it
 *    compares against are already classified by `information.ts` as spelled, casing, notation
 *    or absent from our prompt. This asks the next question of the ones that are not spelled:
 *    is the value among the six the competitor's rule would have shown? A case their block
 *    spells is a case the block *could* fix; a case whose value is not in their six either is
 *    a case no sample of that rule reaches.
 * 2. **Which failures are beyond any sample?** A literal the column stores but outside their
 *    six needs a wider sample; a literal the column does not store at all is derived — a
 *    computed threshold, a concatenation — and no prompt-side lever puts it on the card.
 *    Those are different work items and they are counted apart.
 * 3. **What does it cost?** The block is prompt characters, so it is measured in characters
 *    and in columns added per database, on the card the arm actually builds.
 *
 * The output is a ceiling, not a score. It says how many cases the block could reach and how
 * many of those the arm currently fails, which is the largest accuracy change the block can
 * produce. Realising less is the expected outcome — a model has to *use* the example — and
 * presenting the ceiling as a prediction is the error this instrument exists to avoid.
 *
 * Zero model calls; the only oracle calls are "does this column store this value", which the
 * sample cannot answer because the answer may be no.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderSchemaCard } from '@agentix-e/nl2charts-ai';
import type { SchemaTable } from '@agentix-e/nl2charts-ai';
import { buildSchema, loadQuestions, loadTables } from './data.js';
import type { BirdTable } from './data.js';
import type { CaseRecord } from './gap.js';
import { INFO_CLASSES, classifyInformation, promptForCase } from './information.js';
import type { InfoClass } from './information.js';
import { createOracle } from './oracle.js';
import type { Oracle } from './oracle.js';
import { BIRD_CARD, BIRD_SCHEMA_LINES } from './prompt-shape.js';
import { resolveArm, resolveLayout } from './run.js';
import type { Arm, BirdLayout } from './run.js';
import { literalSites } from './statement.js';
import { exampleMapOf, exampleSetFor } from './value-examples.js';

/** Where a literal sits relative to the two cards. */
export type Reach =
  /** Our prompt already spells it. */
  | 'spelled'
  /** Their block spells it and ours does not. */
  | 'block-spells'
  /** The column stores it, but outside their six. */
  | 'stored-unsampled'
  /** The column does not store it: derived, not retrieved. */
  | 'not-stored';

export const REACHES = ['spelled', 'block-spells', 'stored-unsampled', 'not-stored'] as const;

export interface DifferentialSite {
  readonly column: string;
  readonly value: string;
  readonly cls: Exclude<InfoClass, 'none'>;
  readonly reach: Reach;
}

export interface DifferentialRow {
  readonly id: string;
  readonly passed: boolean;
  readonly cls: InfoClass;
  readonly sites: readonly DifferentialSite[];
}

export interface DifferentialTally {
  readonly total: number;
  readonly cases: Readonly<Record<InfoClass, number>>;
  /** Literal sites by reach, over every non-empty literal in every gold statement. */
  readonly sites: Readonly<Record<Reach, number>>;
  /** Cases with at least one site the block spells and the arm's card did not. */
  readonly reachableCases: number;
  /** ...of those, the ones the artifact records as failures: the ceiling in cases. */
  readonly flippableCases: number;
  /** Cases whose missing values are all derived: no prompt-side lever reaches them. */
  readonly derivedCases: number;
  /** Cases where a value is stored but outside their six: a wider sample would reach them. */
  readonly widerCases: number;
}

export interface DifferentialCost {
  /** Characters the block adds to the card, averaged over the cases measured. */
  readonly charsPerCase: number;
  /** Characters the card already has, averaged the same way. */
  readonly cardCharsPerCase: number;
  /** Share of the finished card the block is. */
  readonly shareOfCard: number;
  /** Columns carrying examples, averaged over the databases the cases touch. */
  readonly columnsPerDb: number;
  /** Examples per column, averaged the same way. */
  readonly valuesPerColumn: number;
}

export interface DifferentialOutcome {
  readonly split: string;
  readonly arm: string;
  readonly rows: readonly DifferentialRow[];
  readonly tally: DifferentialTally;
  readonly cost: DifferentialCost;
  readonly drops: { readonly unknownQuestion: number; readonly unknownArm: number; readonly noExamples: number };
  readonly problems: readonly string[];
}

const emptyReach = (): Record<Reach, number> => ({
  spelled: 0,
  'block-spells': 0,
  'stored-unsampled': 0,
  'not-stored': 0,
});

const emptyClasses = (): Record<InfoClass, number> =>
  INFO_CLASSES.reduce((acc, cls) => ({ ...acc, [cls]: 0 }), {} as Record<InfoClass, number>);

/**
 * Whether a column stores a value, asked of the database rather than guessed from the sample.
 *
 * A site carries a column name and sometimes a table qualifier. When the qualifier names a
 * table, only that table is asked; otherwise every table in the database holding the column is
 * asked, because the gold statement may reach the column through an alias and a wrong "not
 * stored" would file the case under "no lever reaches this" — the reading that stops work.
 */
export async function storedSomewhere(
  oracle: Oracle,
  db: string,
  table: BirdTable,
  column: string,
  value: string,
  qualifier: string | undefined,
): Promise<boolean> {
  const lower = column.toLowerCase();
  const owners = new Set<string>();
  for (const [index, name] of table.columnNames) {
    if (index < 0 || name.toLowerCase() !== lower) continue;
    const owner = table.tableNames[index];
    if (owner !== undefined) owners.add(owner);
  }
  const named =
    qualifier === undefined ? undefined : [...owners].find((owner) => owner.toLowerCase() === qualifier.toLowerCase());
  const targets = named === undefined ? [...owners] : [named];
  const quoted = `"${column.replace(/"/g, '""')}"`;
  const rendered = `'${value.replace(/'/g, "''")}'`;
  for (const target of targets) {
    const found = await oracle.run(
      db,
      `select 1 from "${target.replace(/"/g, '""')}" where ${quoted} = ${rendered} limit 1`,
    );
    if (found.ok && found.rows.length > 0) return true;
  }
  return false;
}

/**
 * The characters a column's examples add to its card line.
 *
 * Rendered the way `renderSchemaCard` renders them — ` [a|b|c]` — because the cost has to be
 * the cost of the thing that would be sent, not of a JSON encoding of it.
 */
export function blockCharsOf(values: readonly string[]): number {
  return values.length === 0 ? 0 : ` [${values.join('|')}]`.length;
}

/** What one database's block costs, computed once from the set. */
interface DbBlock {
  readonly byColumn: Map<string, readonly string[]>;
  readonly chars: number;
  readonly columns: number;
  readonly values: number;
}

export async function runDifferential(settings: DifferentialSettings, oracle: Oracle): Promise<DifferentialOutcome> {
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as {
    split?: string;
    cases?: readonly CaseRecord[];
    controls?: { readonly synthesizedDefinitions?: Readonly<Record<string, string>> };
  };
  const questions = loadQuestions(settings.layout.questionsFile);
  const tables = loadTables(settings.layout.tablesFile);
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));
  const definitions = report.controls?.synthesizedDefinitions ?? {};
  const blocks = new Map<string, DbBlock>();
  const cards = new Map<string, number>();
  const rows: DifferentialRow[] = [];
  const drops = { unknownQuestion: 0, unknownArm: 0, noExamples: 0 };
  let blockChars = 0;
  let cardChars = 0;
  let measured = 0;

  const cases = (report.cases ?? []).filter((row) => row.arm === settings.arm);
  if (cases.length === 0) drops.unknownArm = 1;

  const blockFor = async (db: string): Promise<DbBlock> => {
    const cached = blocks.get(db);
    if (cached !== undefined) return cached;
    const set = await exampleSetFor(oracle, db, { cacheDir: settings.layout.exampleCache });
    const byColumn = exampleMapOf(set);
    // The nullability marker is a hint, not an example, and it costs characters like one. It
    // is counted here because the block that would be sent carries it.
    const chars = set.columns.reduce((sum, column) => sum + blockCharsOf(column.values), 0);
    const block: DbBlock = {
      byColumn,
      chars,
      columns: set.columns.length,
      values: set.columns.reduce((count, column) => count + column.values.length, 0),
    };
    blocks.set(db, block);
    return block;
  };

  for (const record of cases) {
    const id = String(record.id);
    const question = byId.get(id);
    const table = question === undefined ? undefined : tables.get(question.db_id);
    if (question === undefined || table === undefined) {
      drops.unknownQuestion += 1;
      continue;
    }
    const block = await blockFor(question.db_id);
    if (block.byColumn.size === 0) {
      drops.noExamples += 1;
      continue;
    }
    const prompt = promptForCase(settings.armSpec, question, definitions[question.db_id] ?? '', table);
    const verdict = classifyInformation(prompt, question.question, question.SQL);
    // The card without samples is the denominator: the block's share has to be a share of the
    // card it joins, and a share taken over the card *with* the block would flatter it.
    let cardLength = cards.get(question.db_id);
    if (cardLength === undefined) {
      const card = buildSchema(table, new Map(), { withNotes: false }) as SchemaTable[];
      cardLength = renderSchemaCard(card, BIRD_SCHEMA_LINES, BIRD_CARD).length;
      cards.set(question.db_id, cardLength);
    }
    blockChars += block.chars;
    cardChars += cardLength;
    measured += 1;

    const sites: DifferentialSite[] = [];
    // One parse per case, not one per value: `literalSites` walks the statement.
    const parsed = literalSites(question.SQL);
    for (const value of verdict.values) {
      const site = parsed.find(
        (candidate) =>
          candidate.column.toLowerCase() === value.column.toLowerCase() && candidate.literal.value === value.value,
      );
      const spellings = [...block.byColumn]
        .filter(([key]) => key.toLowerCase().endsWith(`.${value.column.toLowerCase()}`))
        .flatMap(([, values]) => values);
      const exact = spellings.includes(value.value);
      const folded = spellings.some((entry) => entry.toLowerCase() === value.value.toLowerCase());
      let reach: Reach;
      if (value.cls === 'spelled') reach = 'spelled';
      else if (exact || folded) reach = 'block-spells';
      else if (await storedSomewhere(oracle, question.db_id, table, value.column, value.value, site?.qualifier)) {
        reach = 'stored-unsampled';
      } else reach = 'not-stored';
      sites.push({ column: value.column, value: value.value, cls: value.cls, reach });
    }
    rows.push({ id, passed: record.passed === true, cls: verdict.cls, sites });
  }

  const tally = tallyDifferential(rows);
  const measuredBlocks = [...blocks.values()];
  const priced: DifferentialCost = {
    charsPerCase: measured === 0 ? 0 : blockChars / measured,
    cardCharsPerCase: measured === 0 ? 0 : cardChars / measured,
    shareOfCard: (() => {
      const plain = measured === 0 ? 0 : cardChars / measured;
      return plain + (measured === 0 ? 0 : blockChars / measured) === 0
        ? 0
        : (blockChars / measured) / (plain + blockChars / measured);
    })(),
    columnsPerDb:
      measuredBlocks.length === 0
        ? 0
        : measuredBlocks.reduce((sum, entry) => sum + entry.columns, 0) / measuredBlocks.length,
    valuesPerColumn: (() => {
      const withColumns = measuredBlocks.filter((entry) => entry.columns > 0);
      if (withColumns.length === 0) return 0;
      return withColumns.reduce((sum, entry) => sum + entry.values / entry.columns, 0) / withColumns.length;
    })(),
  };
  const problems = differentialProblems({ tally, drops, arm: settings.arm });
  return { split: settings.layout.split, arm: settings.arm, rows, tally, cost: priced, drops, problems };
}

export function tallyDifferential(rows: readonly DifferentialRow[]): DifferentialTally {
  const cases = emptyClasses();
  const sites = emptyReach();
  let reachableCases = 0;
  let flippableCases = 0;
  let derivedCases = 0;
  let widerCases = 0;
  for (const row of rows) {
    cases[row.cls] += 1;
    for (const site of row.sites) sites[site.reach] += 1;
    const reachable = row.sites.some((site) => site.reach === 'block-spells');
    const wider = row.sites.some((site) => site.reach === 'stored-unsampled');
    // "Derived" is the strict reading: every value the case cannot spell is one the column
    // does not store. A case with one derived value and one the block spells is reachable,
    // and calling it derived would understate what the block can do.
    const derived =
      row.cls !== 'none' && !reachable && !wider && row.sites.some((site) => site.reach === 'not-stored');
    if (reachable) reachableCases += 1;
    if (reachable && !row.passed) flippableCases += 1;
    if (wider && !reachable) widerCases += 1;
    if (derived) derivedCases += 1;
  }
  return { total: rows.length, cases, sites, reachableCases, flippableCases, derivedCases, widerCases };
}

/** The ceiling in percentage points, which is what a model run is compared against. */
export function ceilingPoints(tally: DifferentialTally): number {
  return tally.total === 0 ? 0 : (tally.flippableCases / tally.total) * 100;
}

/**
 * Whether the measurement is worth publishing.
 *
 * Three ways it is not, all absolute: nothing was read; the artifact has no cases for the arm;
 * or the block was empty for a database the cases belong to. An empty block is its parent
 * renamed, and a differential against it would report "the block adds nothing" while having
 * measured nothing — the failure mode this repository keeps finding in its own instruments.
 */
export function differentialProblems(input: {
  readonly tally: DifferentialTally;
  readonly drops: { readonly unknownQuestion: number; readonly unknownArm: number; readonly noExamples: number };
  readonly arm: string;
}): string[] {
  const problems: string[] = [];
  if (input.drops.unknownArm > 0) {
    problems.push(`DIFF: the artifact has no cases for arm ${input.arm}, so there is nothing to compare against`);
  }
  if (input.drops.noExamples > 0) {
    problems.push(
      `DIFF: ${String(input.drops.noExamples)} case(s) are in a database whose value-example block is empty, so a null result there would be a missing instrument`,
    );
  }
  // One root cause, not two symptoms: a population dropped for a named reason has already said
  // what went wrong, and "nothing was read" would only restate it. Same rule as `information.ts`.
  if (input.tally.total === 0 && problems.length === 0) {
    problems.push('DIFF: no case could be read, so the block was not priced');
  }
  return problems;
}

export interface DifferentialSettings {
  readonly report: string;
  readonly layout: BirdLayout;
  readonly arm: string;
  readonly armSpec: Arm;
  readonly out: string;
  readonly strict: boolean;
}

export function resolveDifferentialSettings(
  env: Record<string, string | undefined>,
  argv: readonly string[],
  root: string,
): DifferentialSettings {
  const flag = argv.indexOf('--arm');
  const named = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && named === undefined) throw new Error('--arm needs a name');
  const consumed = flag === -1 ? [] : [flag, flag + 1];
  const path = argv.find((item, index) => !item.startsWith('--') && !consumed.includes(index));
  if (path === undefined) throw new Error('usage: differential.ts <report.json> [--arm <name>] [--strict]');
  const layout = resolveLayout(env, root);
  const arm = named ?? 'inline+evidence';
  const spec = resolveArm(arm);
  if (spec === undefined) throw new Error(`unknown arm: ${arm}`);
  return {
    report: path,
    layout,
    arm,
    armSpec: spec,
    out: dirname(layout.out),
    strict: argv.includes('--strict'),
  };
}

export function differentialLines(outcome: DifferentialOutcome): string[] {
  const share = (count: number): string =>
    outcome.tally.total === 0 ? '0.0%' : `${((count / outcome.tally.total) * 100).toFixed(1)}%`;
  const out = [`the value-example block, priced against ${outcome.arm} on ${outcome.split}`, ''];
  out.push('  cases by what the prompt was missing');
  for (const cls of INFO_CLASSES) {
    out.push(`  ${cls.padEnd(10)} ${String(outcome.tally.cases[cls]).padStart(4)}  ${share(outcome.tally.cases[cls])}`);
  }
  out.push('');
  out.push('  literals by whether the block reaches them');
  for (const reach of REACHES) {
    out.push(`  ${reach.padEnd(16)} ${String(outcome.tally.sites[reach]).padStart(4)}`);
  }
  out.push('');
  out.push(`  the block spells a value the arm's card did not: ${String(outcome.tally.reachableCases)} case(s)`);
  out.push(
    `  ...of which the arm failed ${String(outcome.tally.flippableCases)}, so the ceiling is ${ceilingPoints(outcome.tally).toFixed(2)}pp`,
  );
  out.push(`  stored but outside their six: ${String(outcome.tally.widerCases)} case(s) — a wider sample reaches these`);
  out.push(`  stored nowhere in the column: ${String(outcome.tally.derivedCases)} case(s) — derived, not retrieved`);
  out.push('');
  out.push(
    `  cost: ${outcome.cost.charsPerCase.toFixed(0)} characters a case on a ${outcome.cost.cardCharsPerCase.toFixed(0)}-character card (${(outcome.cost.shareOfCard * 100).toFixed(1)}%)`,
  );
  out.push(
    `  block: ${outcome.cost.columnsPerDb.toFixed(1)} columns a database, ${outcome.cost.valuesPerColumn.toFixed(1)} values a column`,
  );
  return out;
}

export function differentialPath(settings: DifferentialSettings): string {
  return join(settings.out, `differential-${settings.arm.replace(/[^a-z0-9+_-]/gi, '-')}.json`);
}

export function writeDifferential(settings: DifferentialSettings, outcome: DifferentialOutcome): string {
  const path = differentialPath(settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(outcome, null, 2));
  return path;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const settings = resolveDifferentialSettings(env, argv, root);
  const oracle = createOracle(resolvePath(root, 'eval/bird/oracle.py'), settings.layout.databaseRoot);
  try {
    const outcome = await runDifferential(settings, oracle);
    for (const line of differentialLines(outcome)) console.log(line);
    const path = writeDifferential(settings, outcome);
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
