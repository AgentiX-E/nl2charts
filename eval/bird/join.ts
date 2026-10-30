/**
 * The tables a question names, and the tables its answer has to join.
 *
 * The previous measurement priced the card and found the lever: 74% of a prompt is the schema
 * card, and 41.6% of the card belongs to tables the gold statement never reads. What stopped the
 * lever was the linker, not the card — with the recallers the product ships, 230 of 496 Mini-Dev
 * cases keep every gold table and 86 keep none, because a question names an entity
 * ("the customers who pay in EUR") and the join partner that entity needs is never mentioned.
 *
 * This instrument asks whether walking the foreign-key graph from the tables a question *does*
 * name reaches the tables its answer reads. It is the same shape as the card measurement: zero
 * model calls, a per-case proposal compared against the gold statement's own table set, and a
 * ceiling stated as a ceiling.
 *
 * Four decisions make the number trustworthy rather than flattering:
 *
 * 1. **The edges are the database's, not the renderer's.** `dev_tables.json` carries
 *    `foreign_keys` as column-index pairs, and the graph is built from those indices. Parsing the
 *    `"a.x = b.y"` hints the card renders would have measured a string format.
 * 2. **The manifest's edges are not the whole graph, and the report says so.** `debit_card_
 *    specializing` declares one foreign key while its gold statements join four tables through
 *    `CustomerID` and `GasStationID`. The second edge source is a shared column name — the join
 *    the database forgot to declare — and it is measured as a separate block rather than merged,
 *    because more edges are more reach and less saving and a reader has to see both.
 * 3. **A gold reference the card cannot show is classified, not silently dropped.** BIRD's gold
 *    statements define CTEs, and a CTE name is not a table: counting it would make the coverage of
 *    every such case permanently short of `all`, and dropping it without a word would hide a
 *    corpus fact. A name the statement defines leaves the measurement and is counted; a name it
 *    does not is a defect in this instrument's table reading and fails the gate.
 * 4. **Depth is a parameter, and so is the fallback.** One hop is the cheap closure and two hops
 *    is the expensive one; a case whose seeds miss a gold table is sent the whole card rather than
 *    a card missing it. That last rule is what `safe` prices: the saving a deployment can bank
 *    without showing the model less than the answer needs.
 *
 * The unit is characters per case, the same unit the card measurement established, because the
 * question a reader has is what sending a smaller card would save.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Recaller, SchemaTable } from '@agentix-e/nl2charts-ai';
import { coverage, promptOf, tableChars } from './card.js';
import { EDGE_SOURCES, closureOf, joinGraphOf } from './join-graph.js';
import { CANDIDATE_RECALLERS, SHIPPED_RECALLERS, linkedTables } from './prune.js';
import type { EdgeSource, JoinGraph } from './join-graph.js';
import type { Coverage } from './card.js';
import { loadDescriptions, loadQuestions, loadTables } from './data.js';
import type { BirdQuestion, BirdTable, ColumnNote } from './data.js';
import type { CaseRecord } from './gap.js';
import { promptFor, renderableArm, resolveArm, resolveLayout } from './run.js';
import { definesOwnName, tableRefs } from './statement.js';
import type { Arm, BirdLayout } from './run.js';

/** The depths the report prices. Zero is the linker as it behaves today. */
export const HOPS = [0, 1, 2] as const;
export type Hop = (typeof HOPS)[number];

/** The two recaller sets, named rather than inlined. */
export const RECALLER_SETS = ['shipped', 'candidate'] as const;
export type RecallerSet = (typeof RECALLER_SETS)[number];

export const RECALLERS_OF: Readonly<Record<RecallerSet, readonly Recaller[]>> = {
  shipped: SHIPPED_RECALLERS,
  candidate: CANDIDATE_RECALLERS,
};

/** How the gold statement's table references divide up against the card. */
export interface GoldRefs {
  /** Tables the card shows and the statement reads. */
  readonly known: string[];
  /** Names the statement defines itself: a CTE, or a subquery it names. */
  readonly own: string[];
  /** Names the card does not show and the statement does not define. A defect. */
  readonly unknown: string[];
}

/**
 * Divide the statement's references into three piles, from the raw references rather than from a
 * filtered set.
 *
 * `goldTables` already drops the names a statement defines, because it answers "which tables does
 * this read". This function has to see them: a name the statement defines is a fact about the
 * corpus that a reader needs counted, and a filter applied upstream would make `own` permanently
 * empty and turn that count into a zero nobody could explain.
 */
export function classifyGold(sql: string, names: ReadonlySet<string>): GoldRefs {
  const known = new Set<string>();
  const own = new Set<string>();
  const unknown = new Set<string>();
  for (const ref of tableRefs(sql)) {
    const table = ref.table.toLowerCase();
    if (names.has(table)) known.add(table);
    else if (definesOwnName(sql, table)) own.add(table);
    else unknown.add(table);
  }
  return { known: [...known], own: [...own], unknown: [...unknown] };
}

/** One case, with the pieces every cell of the report is computed from. */
export interface JoinCase {
  readonly id: string;
  readonly db: string;
  /** The gold tables the card shows, lower-cased. */
  readonly gold: readonly string[];
  /** The names the statement defines itself. Excluded from the measurement, and counted. */
  readonly own: readonly string[];
  /** Seeds per recaller set, lower-cased. */
  readonly seeds: Readonly<Record<RecallerSet, readonly string[]>>;
  /** Characters each card table costs, keyed the way the graph and the gold are keyed. */
  readonly chars: Readonly<Record<string, number>>;
  /** The whole card's characters, which is what the saving is measured against. */
  readonly card: number;
  /** Whether the database has any edge at all. Without one the closure cannot move. */
  readonly graphless: boolean;
}

/** One row of the depth table: one edge source, one recaller set, one depth. */
export interface JoinCell {
  readonly source: EdgeSource;
  readonly set: RecallerSet;
  readonly hops: Hop;
  readonly coverage: Readonly<Record<Coverage, number>>;
  /** Mean tables kept per case. */
  readonly tables: number;
  /** Mean characters kept per case when every case is narrowed, right or wrong. */
  readonly chars: number;
  /**
   * Mean characters kept under the rule a deployment can ship: a case whose seeds miss a gold
   * table is sent the whole card.
   *
   * Without this column the saving is the saving of a linker that is allowed to be wrong, which
   * is not a saving. It is the only number in the table an arm can be run on.
   */
  readonly safeChars: number;
  /**
   * Cases the closure finishes: the seeds miss some gold table and the closure has all of them.
   *
   * This is the number the whole instrument exists for — a closure that only adds tables the
   * answer does not read costs characters and reads as a regression in the depth table.
   */
  readonly completed: number;
  /** Cases where the closure keeps every card table, so the card could not shrink at all. */
  readonly whole: number;
  /** Cases with no seed at all, which fall back to the whole card. Counted, not covered. */
  readonly fallback: number;
}

export interface JoinTally {
  readonly total: number;
  readonly excluded: number;
  readonly own: number;
  readonly graphless: number;
  readonly databases: number;
  readonly databasesWithoutEdges: number;
  readonly edges: Readonly<Record<EdgeSource, number>>;
  readonly unknownRefs: readonly string[];
  readonly cells: readonly JoinCell[];
  /** Mean characters of the whole card: the denominator of every saving in the table. */
  readonly card: number;
}

/**
 * The sums, with the fallback folded into the safe column rather than left out.
 *
 * A case with no seed cannot be narrowed, so a deployment sends the whole card for it. Leaving
 * those cases out of the mean would price a linker that reads every question; counting them at
 * zero characters would price one that answers without a schema. They are charged the whole card.
 */
export function tallyJoins(
  cases: readonly JoinCase[],
  graphs: Readonly<Record<EdgeSource, ReadonlyMap<string, JoinGraph>>>,
  excluded = 0,
  own = 0,
  unknownRefs: readonly string[] = [],
): JoinTally {
  const n = cases.length === 0 ? 1 : cases.length;
  const cards = cases.reduce((sum, entry) => sum + entry.card, 0);
  const cells: JoinCell[] = [];
  for (const source of EDGE_SOURCES) {
    const graphOf = (db: string): JoinGraph | undefined => graphs[source].get(db);
    for (const set of RECALLER_SETS) {
      for (const hops of HOPS) {
        const coverageCount: Record<Coverage, number> = { all: 0, some: 0, none: 0 };
        let tables = 0;
        let chars = 0;
        let safeChars = 0;
        let completed = 0;
        let whole = 0;
        let fallback = 0;
        for (const entry of cases) {
          const seeds = entry.seeds[set];
          const empty = seeds.length === 0;
          if (empty) fallback += 1;
          const kept = empty
            ? new Set(Object.keys(entry.chars))
            : closureOf(graphOf(entry.db)?.adjacency ?? new Map(), seeds, hops);
          const gold = new Set(entry.gold);
          const verdict = coverage(gold, kept);
          coverageCount[verdict] += 1;
          // A fallback keeps every table, so it would otherwise count as a case the closure
          // finished — the one number this instrument exists to report.
          if (!empty && verdict === 'all' && coverage(gold, new Set(seeds)) !== 'all') completed += 1;
          if (kept.size >= Object.keys(entry.chars).length) whole += 1;
          let keptChars = 0;
          for (const name of kept) keptChars += entry.chars[name] ?? 0;
          tables += kept.size;
          chars += keptChars;
          // The shippable rule: narrow only where the closure provably has every gold table.
          safeChars += verdict === 'all' && !empty ? keptChars : entry.card;
        }
        cells.push({
          source,
          set,
          hops,
          coverage: coverageCount,
          tables: tables / n,
          chars: chars / n,
          safeChars: safeChars / n,
          completed,
          whole,
          fallback,
        });
      }
    }
  }
  const databases = graphs.manifest.size;
  const databasesWithoutEdges = [...graphs.manifest.values()].filter((graph) => graph.edges === 0).length;
  const edges = {
    manifest: [...graphs.manifest.values()].reduce((sum, graph) => sum + graph.edges, 0),
    shared: [...graphs.shared.values()].reduce((sum, graph) => sum + graph.edges, 0),
  };
  return {
    total: cases.length,
    excluded,
    own,
    graphless: cases.filter((entry) => entry.graphless).length,
    databases,
    databasesWithoutEdges,
    edges,
    unknownRefs,
    cells,
    card: cards / n,
  };
}

/** A percentage with one decimal, and `0.0%` rather than `NaN` for an empty denominator. */
function pct(value: number, of: number): string {
  return of === 0 ? '0.0%' : `${((value / of) * 100).toFixed(1)}%`;
}

/**
 * The lines a reader sees.
 *
 * The ceiling, the depth table, and the two savings side by side: a saving that comes from
 * dropping tables the answer reads is a regression wearing a smaller number, so `gold all` sits
 * in the same row as the characters, and `safe` is the only column an arm can be run on.
 */
export function joinLines(tally: JoinTally): string[] {
  const out = ['what a question names, and what its answer joins', ''];
  out.push(
    `  ${String(tally.total)} cases over ${String(tally.databases)} databases; ` +
      `${String(tally.edges.manifest)} declared foreign keys, ${String(tally.edges.shared)} with shared columns; ` +
      `${String(tally.databasesWithoutEdges)} database(s) declare none`,
  );
  if (tally.own > 0) out.push(`  ${String(tally.own)} case(s) name a table of their own (a CTE), which the reading leaves out`);
  if (tally.excluded > 0) out.push(`  ${String(tally.excluded)} case(s) read no table the card shows and are left out of the table below`);
  if (tally.graphless > 0) out.push(`  ${String(tally.graphless)} case(s) are in a database with no edge, where a closure cannot move`);
  out.push('');
  out.push(`  the whole card averages ${String(Math.round(tally.card))} chars`);
  out.push('');
  const header =
    `  ${'edges'.padEnd(9)} ${'recallers'.padEnd(10)} ${'hops'.padStart(4)} ${'tables'.padStart(7)} ${'chars'.padStart(7)} ` +
    `${'saved'.padStart(7)} ${'safe'.padStart(7)} ${'gold all'.padStart(9)} ${'some'.padStart(6)} ${'none'.padStart(6)} ${'finished'.padStart(9)} ${'no seed'.padStart(8)}`;
  out.push(header);
  for (const cell of tally.cells) {
    out.push(
      `  ${cell.source.padEnd(9)} ${cell.set.padEnd(10)} ${String(cell.hops).padStart(4)} ${cell.tables.toFixed(1).padStart(7)} ` +
        `${String(Math.round(cell.chars)).padStart(7)} ${pct(tally.card - cell.chars, tally.card).padStart(7)} ` +
        `${pct(tally.card - cell.safeChars, tally.card).padStart(7)} ` +
        `${String(cell.coverage.all).padStart(9)} ${String(cell.coverage.some).padStart(6)} ${String(cell.coverage.none).padStart(6)} ` +
        `${String(cell.completed).padStart(9)} ${String(cell.fallback).padStart(8)}`,
    );
  }
  out.push('');
  out.push('  "saved" narrows every case; "safe" narrows only the cases whose closure has all the gold reads');
  out.push('  and sends the whole card to the rest, so "safe" is the column a deployment can bank.');
  out.push('  "finished" counts the cases whose seeds miss a gold table and whose closure has all of them.');
  return out;
}

/**
 * The absolute failures, and no targets.
 *
 * The depth table has no passing value: a closure that reaches every table is a fact about the
 * schema, not a defect, and the saving it implies is a ceiling. What can be wrong is the reading
 * itself, and this instrument can be wrong in four ways.
 *
 * 1. Nothing was read: an empty population, or an artifact whose cases belong to another arm.
 * 2. A gold name the card does not show and the statement does not define. That is this
 *    instrument's table reader, and every coverage number after it would be about a statement it
 *    misread.
 * 3. A foreign key whose ends this manifest cannot name. The graph would be missing an edge, and
 *    a missing edge is a depth table that under-reports.
 * 4. Every case excluded. The measurement would be empty while looking complete.
 */
export function joinProblems(input: {
  readonly tally: JoinTally;
  readonly unrenderable: number;
  readonly graphDefects: number;
}): string[] {
  const problems: string[] = [];
  const { tally } = input;
  if (tally.total === 0 && input.unrenderable === 0 && tally.excluded === 0) {
    problems.push('JOIN: no case could be read, so nothing about the closure was measured');
  }
  if (tally.unknownRefs.length > 0) {
    problems.push(
      `JOIN: ${String(tally.unknownRefs.length)} name(s) in a gold statement are neither in the card nor defined by the statement (${tally.unknownRefs.slice(0, 5).join(', ')}), so the coverage this report prints is of a misread statement`,
    );
  }
  if (input.unrenderable > 0) {
    problems.push(
      `JOIN: ${String(input.unrenderable)} case(s) belong to an arm whose prompt needs a block the artifact does not keep, so the card this tool rebuilds is not the one that was sent`,
    );
  }
  if (input.graphDefects > 0) {
    problems.push(
      `JOIN: ${String(input.graphDefects)} foreign key(s) name a column this manifest does not have, so the graph is missing edges and every depth under-reports`,
    );
  }
  if (tally.total === 0 && tally.excluded > 0) {
    problems.push(`JOIN: all ${String(tally.excluded)} case(s) were excluded, so the depth table has no population`);
  }
  return problems;
}

export interface JoinSettings {
  readonly report: string;
  readonly layout: BirdLayout;
  readonly arm: string;
  readonly out: string;
  readonly strict: boolean;
}

export function resolveJoinSettings(
  env: Record<string, string | undefined>,
  argv: readonly string[],
  root: string,
): JoinSettings {
  const flag = argv.indexOf('--arm');
  const named = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && named === undefined) throw new Error('--arm needs a name');
  const consumed = flag === -1 ? [] : [flag, flag + 1];
  const path = argv.find((item, index) => !item.startsWith('--') && !consumed.includes(index));
  if (path === undefined) throw new Error('usage: join.ts <report.json> [--arm <name>] [--strict]');
  const layout = resolveLayout(env, root);
  return { report: path, layout, arm: named ?? 'select-cross', out: dirname(layout.out), strict: argv.includes('--strict') };
}

export interface JoinDrops {
  readonly unknownQuestion: number;
  readonly unknownArm: number;
  readonly unrenderable: number;
  readonly definitionGap: number;
}

export interface JoinOutcome {
  readonly split: string;
  readonly arm: string;
  readonly cases: readonly JoinCase[];
  readonly tally: JoinTally;
  readonly drops: JoinDrops;
  readonly problems: readonly string[];
}

export interface JoinReportShape {
  readonly split?: string;
  readonly cases?: readonly CaseRecord[];
  readonly controls?: { readonly synthesizedDefinitions?: Readonly<Record<string, string>> };
}

/** The schema a case's card is rendered from, built the way the pipeline builds it. */
export function schemaOf(
  arm: Arm,
  question: BirdQuestion,
  definitions: string,
  tables: BirdTable,
  notes?: Map<string, Map<string, ColumnNote>>,
): SchemaTable[] {
  return promptOf(arm, question, definitions, tables, notes).schema as SchemaTable[];
}

export function seedsOf(question: string, schema: readonly SchemaTable[]): Record<RecallerSet, readonly string[]> {
  return {
    shipped: [...linkedTables(question, schema, RECALLERS_OF.shipped)],
    candidate: [...linkedTables(question, schema, RECALLERS_OF.candidate)],
  };
}

export function graphsOf(tables: ReadonlyMap<string, BirdTable>): Record<EdgeSource, Map<string, JoinGraph>> {
  const build = (source: EdgeSource): Map<string, JoinGraph> =>
    new Map([...tables].map(([db, table]) => [db, joinGraphOf(table, source)]));
  return { manifest: build('manifest'), shared: build('shared') };
}

export async function runJoin(settings: JoinSettings): Promise<JoinOutcome> {
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as JoinReportShape;
  const arm = resolveArm(settings.arm);
  const questions = loadQuestions(settings.layout.questionsFile);
  const tables = loadTables(settings.layout.tablesFile);
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));
  const definitions = report.controls?.synthesizedDefinitions ?? {};
  const graphs = graphsOf(tables);
  // Same rule as the card report: an arm that sends column notes is rendered with them, or the
  // prompt this instrument prices is not the one the arm sends.
  const noteCache = new Map<string, Map<string, Map<string, ColumnNote>>>();
  const notesFor = (db: string, table: BirdTable): Map<string, Map<string, ColumnNote>> => {
    const cached = noteCache.get(db);
    if (cached !== undefined) return cached;
    const loaded = loadDescriptions(join(settings.layout.descriptionsRoot, db, 'database_description'), table.tableNames);
    noteCache.set(db, loaded);
    return loaded;
  };
  const cases: JoinCase[] = [];
  const drops: { -readonly [K in keyof JoinDrops]: number } = { unknownQuestion: 0, unknownArm: 0, unrenderable: 0, definitionGap: 0 };
  const selected = (report.cases ?? []).filter((row) => row.arm === settings.arm);
  const unknownRefs: string[] = [];
  let excluded = 0;
  let own = 0;
  if (arm === undefined) {
    drops.unknownArm = selected.length;
  } else if (!renderableArm(arm)) {
    drops.unrenderable = selected.length;
  } else {
    const seen = new Set<string>();
    for (const row of selected) {
      const id = String(row.id);
      // A case appears once per arm; the split's own question file is what holds a duplicate
      // twice, and counting it twice would inflate the denominator this report publishes.
      if (seen.has(id)) continue;
      seen.add(id);
      const question = byId.get(id);
      if (question === undefined) {
        drops.unknownQuestion += 1;
        continue;
      }
      const table = tables.get(question.db_id);
      const text = definitions[question.db_id];
      if (table === undefined || (text === undefined && arm.definitions === 'inline')) {
        drops.definitionGap += 1;
        continue;
      }
      const schema = schemaOf(arm, question, text ?? '', table, arm.notes === true ? notesFor(question.db_id, table) : undefined);
      const names = new Set(schema.map((entry) => entry.table.toLowerCase()));
      const refs = classifyGold(question.SQL, names);
      if (refs.unknown.length > 0) unknownRefs.push(...refs.unknown.map((name) => `${question.db_id}.${name}`));
      if (refs.own.length > 0) own += 1;
      if (refs.known.length === 0) {
        excluded += 1;
        continue;
      }
      const chars = tableChars(schema, promptFor(arm, question, {}));
      cases.push({
        id,
        db: question.db_id,
        gold: refs.known,
        own: refs.own,
        seeds: seedsOf(question.question, schema),
        chars: Object.fromEntries(chars),
        card: [...chars.values()].reduce((sum, value) => sum + value, 0),
        graphless: (graphs.manifest.get(question.db_id)?.edges ?? 0) === 0,
      });
    }
  }
  const tally = tallyJoins(cases, graphs, excluded, own, unknownRefs);
  const graphDefects = [...graphs.manifest.values()].reduce((sum, graph) => sum + graph.outOfRange, 0);
  const problems = joinProblems({
    tally,
    unrenderable: drops.unrenderable + drops.unknownArm + drops.definitionGap,
    graphDefects,
  });
  return { split: settings.layout.split, arm: settings.arm, cases, tally, drops, problems };
}

export function joinPath(settings: JoinSettings): string {
  return join(settings.out, `join-${settings.arm.replace(/[^a-z0-9+_-]/gi, '-')}.json`);
}

export function writeJoinArtifact(settings: JoinSettings, outcome: JoinOutcome): string {
  const path = joinPath(settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(outcome, null, 2));
  return path;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const settings = resolveJoinSettings(env, argv, root);
  const outcome = await runJoin(settings);
  for (const line of joinLines(outcome.tally)) console.log(line);
  console.log(
    `\n  dropped: ${String(outcome.drops.unknownQuestion)} unknown question, ${String(outcome.drops.definitionGap)} without definitions, ` +
      `${String(outcome.drops.unrenderable)} unrenderable arm, ${String(outcome.drops.unknownArm)} unknown arm`,
  );
  const path = writeJoinArtifact(settings, outcome);
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
