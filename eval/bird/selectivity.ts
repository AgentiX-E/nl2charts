/**
 * What the linker reaches, and what nothing of its kind can reach (ADR-227).
 *
 * The card ceiling arm earned +11.09pp by keeping a different set of fields, and the shipped linker
 * names 31.0% of the fields the gold statements name. That pair of numbers supports two opposite
 * next steps and no way to choose between them: a linker that is under-built argues for a better
 * ranker, and a linker that has run out of information argues for a different input. This module
 * separates the two, without a model call, by varying three things that are all local.
 *
 * 1. **The budget.** `topK = 12` is a slice of a ranking, not the ranking. The same recallers with
 *    no slice differ by exactly the fields the cut removed — `cut` below. A field in that pile is
 *    recoverable by shipping a wider card, and the price is the width the card report already
 *    prints.
 * 2. **The information source.** `name` reads the column's own tokens, `alias` reads the curated
 *    note, `value` reads the stored values the profiler sampled, and `table` reads the entity the
 *    column belongs to. Opened one at a time they say where the misses live; opened together with
 *    no slice they say what the whole family reaches — the `all` mode at `UNBOUNDED`.
 * 3. **The ceiling.** A field that `all` at `UNBOUNDED` does not name is a field whose name, alias,
 *    values and table all never appear in the question. `unreachable` is that pile, and it is the
 *    arithmetic reason a ranker cannot fix it: there is nothing in the question to rank on.
 *
 * The three piles partition the fields the gold statements named, and that partition is the point.
 * `linked + cut + unreachable === total` is asserted rather than assumed, because a decomposition
 * whose parts do not add up to the whole is a table a reader will complete from whichever half
 * flatters a proposal.
 *
 * What this buys, concretely: embedding retrieval, a model that selects columns, and training all
 * work by carrying information from *outside* the question into the recaller. Their headroom is
 * bounded above by `unreachable` and by nothing else, so `unreachable` is the number that decides
 * whether any of them is worth a dispatch — the same rule the ordering arm was held to before it
 * was withdrawn (`card.ts`, `linkedFieldOrder`).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Recaller, SchemaTable } from '@agentix-e/nl2charts-ai';
import { blockReader, fieldCoverage, goldFieldKeys, linkedFieldKeys, promptOf } from './card.js';
import { loadDescriptions, loadQuestions, loadTables } from './data.js';
import type { BirdTable, ColumnNote } from './data.js';
import type { CaseRecord } from './gap.js';
import { SHIPPED_ARM, requireArm } from './presence.js';
import { CANDIDATE_RECALLERS, SHIPPED_RECALLERS } from './prune.js';
import { renderableArm, resolveArm, resolveLayout } from './run.js';
import type { BirdLayout } from './run.js';

/**
 * The budgets the report prices: the shipped one, and no budget at all.
 *
 * `UNBOUNDED` is `Number.MAX_SAFE_INTEGER` rather than a large constant, because the claim it
 * carries is "no slice", not "a big slice". A card with more columns than a constant would make the
 * ceiling depend on the constant, and a ceiling that depends on a number is a tuning parameter
 * dressed as a bound.
 */
export const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/** The budgets, in the order the report prints them. */
export const SELECTIVITY_BUDGETS = [12, UNBOUNDED] as const;

/** The information sources, one per recaller, plus the two sets a deployment would actually ship. */
export const RECALL_MODES = ['shipped', 'name', 'alias', 'value', 'table', 'all', 'comment'] as const;
export type RecallMode = (typeof RECALL_MODES)[number];

/**
 * What each mode opens.
 *
 * `shipped` and `all` are the two sets that exist elsewhere in the repository, imported rather than
 * respelled: a selector read here that disagreed with the one an arm sends would price a linker
 * nobody runs. The four single-atom modes exist only in this instrument, and that is the difference
 * they are here to measure.
 *
 * `comment` opens the same four recallers as `all` and gives the `alias` one something to read,
 * because on this corpus it has nothing: no constructor in the repository ever sets
 * `SchemaColumn.aliases`, so `alias` reports zero on every card and the shipped set is `name` in
 * disguise. The curated column comment is the alias a deployment already has — the card shows it,
 * the linker ignores it — so pricing `comment` is the zero-call way to decide whether wiring it is
 * worth a dispatch. It is deliberately a separate mode rather than a change to `shipped`: widening
 * a recaller would move the hint every measured arm sends, and those measurements would then
 * describe a prompt nobody had run.
 */
export const MODE_RECALLERS: Readonly<Record<RecallMode, readonly Recaller[]>> = {
  shipped: SHIPPED_RECALLERS,
  name: ['name'],
  alias: ['alias'],
  value: ['value'],
  table: ['table'],
  all: CANDIDATE_RECALLERS,
  comment: CANDIDATE_RECALLERS,
};

/**
 * The card each mode reads, where the mode changes the card rather than the recaller set.
 *
 * Kept separate from `MODE_RECALLERS` because the two are different interventions: one changes what
 * the ranker looks at, the other changes what there is to look at. A table that folded them into one
 * coordinate could not say which of the two a delta belonged to.
 */
export const MODE_SCHEMA: Readonly<Record<RecallMode, (schema: readonly SchemaTable[]) => readonly SchemaTable[]>> = {
  shipped: (schema) => schema,
  name: (schema) => schema,
  alias: (schema) => schema,
  value: (schema) => schema,
  table: (schema) => schema,
  all: (schema) => schema,
  comment: withCommentAliases,
};

/**
 * The card with every column's curated comment offered to the alias recaller.
 *
 * One string per column, the comment as written: the recaller tokenizes aliases itself, so splitting
 * here would be a second definition of what a token is. A column with no comment is passed through
 * untouched rather than given an empty alias, because an empty alias is not an input the other
 * columns do not have.
 */
export function withCommentAliases(schema: readonly SchemaTable[]): readonly SchemaTable[] {
  return schema.map((table) => ({
    ...table,
    columns: table.columns.map((column) => {
      const comment = column.comment;
      if (comment === undefined || comment.length === 0) return column;
      return { ...column, aliases: [...(column.aliases ?? []), comment] };
    }),
  }));
}

/** What one selector at one budget would keep of a corpus, and what it would reach. */
export interface SelectivityCell {
  readonly mode: RecallMode;
  readonly topK: number;
  /** The fields the selector names per case, averaged: the width of the card it would send. */
  readonly kept: number;
  /** The fields the gold statements named that these cards could offer. */
  readonly total: number;
  readonly linked: number;
  /** The fields the selector names that no gold statement does: what a filter would pay for. */
  readonly spare: number;
  /** The cases where every field the gold names was named. */
  readonly covered: number;
}

/** One case, with the three piles its fields fall into. */
export interface SelectivityCase {
  readonly id: string;
  readonly cells: readonly SelectivityCell[];
  /** The fields the gold names that the shipped linker keeps at the shipped budget. */
  readonly linked: number;
  /** The fields the shipped budget cut and an uncut budget keeps. */
  readonly cut: number;
  /** The fields no recaller names at any budget. */
  readonly unreachable: number;
  readonly total: number;
}

/**
 * One case's three piles, as the artifact keeps them.
 *
 * The per-selector cells stay out of the written report: they are 14 rows per case and the tally
 * already holds their sum, so writing them would turn a 60 kB artifact into a megabyte of numbers
 * nobody diffs. The artifact's job is to let a reader re-derive the table, and the table is the
 * tally.
 */
export interface SelectivityPile {
  readonly id: string;
  readonly linked: number;
  readonly cut: number;
  readonly unreachable: number;
  readonly total: number;
}

/** The same three piles over a corpus, plus one row per selector and budget. */
export interface SelectivityTally {
  readonly cases: number;
  readonly cells: readonly SelectivityCell[];
  readonly linked: number;
  readonly cut: number;
  readonly unreachable: number;
  readonly total: number;
}

/**
 * One case, every source at both budgets.
 *
 * The loop is ordered by `RECALL_MODES` then by `SELECTIVITY_BUDGETS` so the report is stable: a
 * reader comparing two runs compares two tables with the same rows in the same order, and a table
 * whose row order came from a map would make every diff a rewrite.
 */
export function selectivityOf(question: string, sql: string, schema: readonly SchemaTable[]): SelectivityCase {
  const gold = goldFieldKeys(sql, schema);
  const cells: SelectivityCell[] = [];
  let shippedKeys: ReadonlySet<string> = new Set<string>();
  let ceilingKeys: ReadonlySet<string> = new Set<string>();
  for (const mode of RECALL_MODES) {
    // The card, not the field set: a mode that rewrites the card still names the same fields, so
    // the denominator is read once above and only the numerator changes here.
    const shaped = MODE_SCHEMA[mode](schema);
    for (const topK of SELECTIVITY_BUDGETS) {
      const keys = linkedFieldKeys(question, shaped, MODE_RECALLERS[mode], topK);
      const fields = fieldCoverage(gold, keys);
      cells.push({
        mode,
        topK,
        kept: keys.size,
        total: fields.total,
        linked: fields.linked,
        spare: fields.spare,
        covered: fields.coverage === 'all' ? 1 : 0,
      });
      if (mode === 'shipped' && topK === 12) shippedKeys = keys;
      // The ceiling is the widest source there is, which is the four recallers with the curated
      // comments wired in: `comment` contains `all`, so a ceiling read anywhere else would report
      // headroom as missing information.
      if (mode === 'comment' && topK === UNBOUNDED) ceilingKeys = keys;
    }
  }
  let linked = 0;
  let cut = 0;
  let unreachable = 0;
  for (const key of gold) {
    if (shippedKeys.has(key)) linked += 1;
    else if (ceilingKeys.has(key)) cut += 1;
    else unreachable += 1;
  }
  return { id: '', cells, linked, cut, unreachable, total: gold.size };
}

/** Sum the three piles, average the widths, sum the rest: a width is per case and a pile is a count. */
export function tallySelectivity(cases: readonly SelectivityCase[]): SelectivityTally {
  const cells: SelectivityCell[] = [];
  for (const mode of RECALL_MODES) {
    for (const topK of SELECTIVITY_BUDGETS) {
      let kept = 0;
      let total = 0;
      let linked = 0;
      let spare = 0;
      let covered = 0;
      for (const one of cases) {
        const cell = one.cells.find((entry) => entry.mode === mode && entry.topK === topK);
        if (cell === undefined) continue;
        kept += cell.kept;
        total += cell.total;
        linked += cell.linked;
        spare += cell.spare;
        covered += cell.covered;
      }
      cells.push({
        mode,
        topK,
        kept: cases.length === 0 ? 0 : kept / cases.length,
        total,
        linked,
        spare,
        covered,
      });
    }
  }
  return {
    cases: cases.length,
    cells,
    linked: cases.reduce((sum, one) => sum + one.linked, 0),
    cut: cases.reduce((sum, one) => sum + one.cut, 0),
    unreachable: cases.reduce((sum, one) => sum + one.unreachable, 0),
    total: cases.reduce((sum, one) => sum + one.total, 0),
  };
}

const pct = (part: number, whole: number): string => (whole === 0 ? '—' : `${((100 * part) / whole).toFixed(1)}%`);
const budget = (topK: number): string => (topK === UNBOUNDED ? 'none' : String(topK));

/**
 * The table, then the sentence the table is for.
 *
 * Two halves because they answer different questions. The table is per selector and per budget, and
 * it is what a reader checks the claim against. The paragraph is the decomposition, and it is what
 * a next step is chosen from: how much of the gap is width, how much is missing information, and —
 * the number no selector in this family can move — how much is not in the question at all.
 */
export function selectivityLines(tally: SelectivityTally): string[] {
  const lines: string[] = [];
  lines.push('### Which source reaches the fields the gold statement names');
  lines.push('');
  lines.push(
    `Cases: ${String(tally.cases)}. Fields: ${String(tally.total)}. Shares are of the fields the statements named, ` +
      'and a field a card cannot offer is neither a keep nor a loss.',
  );
  lines.push('');
  lines.push('| selector | budget | card width | gold fields | recalled | share | precision | full coverage |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const cell of tally.cells) {
    const precision = cell.linked + cell.spare === 0 ? '—' : pct(cell.linked, cell.linked + cell.spare);
    lines.push(
      `| ${cell.mode} | ${budget(cell.topK)} | ${cell.kept.toFixed(1)} | ${String(cell.total)} | ` +
        `${String(cell.linked)} | ${pct(cell.linked, cell.total)} | ${precision} | ${String(cell.covered)} |`,
    );
  }
  lines.push('');
  const ceiling = tally.cells.find((cell) => cell.mode === 'comment' && cell.topK === UNBOUNDED);
  const all = tally.cells.find((cell) => cell.mode === 'all' && cell.topK === UNBOUNDED);
  const reached = ceiling === undefined ? 0 : ceiling.linked;
  const withoutComments = all === undefined ? 0 : all.linked;
  lines.push(
    `Token matching reaches ${pct(reached, tally.total)} of the fields the gold statements name, ` +
      `${pct(withoutComments, tally.total)} of it without the curated comments and ${pct(reached - withoutComments, tally.total)} from them. ` +
      `${String(tally.cut)} fields (${pct(tally.cut, tally.total)}) are cut by the shipped budget and survive an uncut one; ` +
      `${String(tally.unreachable)} (${pct(tally.unreachable, tally.total)}) are named by no recaller at any budget — ` +
      'their name, alias, comment, values and table never appear in the question.',
  );
  lines.push('');
  lines.push(
    'The first pile is bought with card width. The second is what an embedding index, a column-selecting ' +
      'model or a trained linker would have to supply from outside the question, and it is the ceiling on all three.',
  );
  return lines;
}

/**
 * What would make this report unreadable.
 *
 * Five refusals, and each one is a table that would still print. The partition must add up, because
 * a reader who sees 31% recalled and 40% unreachable will assume the other 29% is width without
 * being told. A ceiling below a slice means the "no budget" arm was sliced after all, which would
 * make every `cut` a fiction. An empty corpus is a division by zero wearing a percentage sign. A
 * corpus where nothing is reachable is a reader whose schema never arrived. And a corpus that named
 * no field at all is `count(*)` on every case, which is an abstention and not a measurement.
 */
export function selectivityProblems(tally: SelectivityTally): string[] {
  const problems: string[] = [];
  if (tally.cases === 0) {
    problems.push('the selectivity report has no cases: a share of nothing is not a share');
  }
  if (tally.total === 0) {
    problems.push('the corpus named no field any card could offer, so every share would divide by zero');
  }
  if (tally.linked + tally.cut + tally.unreachable !== tally.total) {
    problems.push(
      `the three piles do not add up: ${String(tally.linked)} linked + ${String(tally.cut)} cut + ` +
        `${String(tally.unreachable)} unreachable against ${String(tally.total)} fields`,
    );
  }
  if (tally.total > 0 && tally.linked === 0 && tally.cut === 0) {
    problems.push('no field is reachable at any budget or any recaller, which is a reader that is not wired');
  }
  const ceiling = tally.cells.find((cell) => cell.mode === 'comment' && cell.topK === UNBOUNDED);
  if (ceiling === undefined) {
    problems.push('the report has no uncut ceiling row, so no budget can be priced against it');
  } else {
    for (const cell of tally.cells) {
      if (cell.linked > ceiling.linked) {
        problems.push(
          `the ceiling is below a slice: ${cell.mode} at ${budget(cell.topK)} recalls ${String(cell.linked)} ` +
            `against ${String(ceiling.linked)} uncut, so the budget was never removed`,
        );
      }
    }
  }
  return problems;
}

export interface SelectivitySettings {
  readonly report: string;
  readonly layout: BirdLayout;
  readonly arm: string;
  readonly out: string;
  readonly strict: boolean;
}

export function resolveSelectivitySettings(
  env: Record<string, string | undefined>,
  argv: readonly string[],
  root: string,
): SelectivitySettings {
  const flag = argv.indexOf('--arm');
  const named = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && named === undefined) throw new Error('--arm needs a name');
  const consumed = flag === -1 ? [] : [flag, flag + 1];
  const path = argv.find((item, index) => !item.startsWith('--') && !consumed.includes(index));
  if (path === undefined) throw new Error('usage: selectivity.ts <report.json> [--arm <name>] [--strict]');
  const layout = resolveLayout(env, root);
  return {
    report: path,
    layout,
    arm: named ?? SHIPPED_ARM,
    out: dirname(layout.out),
    strict: argv.includes('--strict'),
  };
}

/** What one invocation read, and what it refused. */
export interface SelectivityOutcome {
  readonly split: string;
  readonly arm: string;
  readonly cases: readonly SelectivityPile[];
  readonly tally: SelectivityTally;
  readonly drops: SelectivityDrops;
  readonly problems: readonly string[];
}

/** The cases an instrument could not read, by the reason it could not read them. */
export interface SelectivityDrops {
  readonly unknownQuestion: number;
  readonly unknownArm: number;
  readonly unrenderable: number;
  readonly definitionGap: number;
}

export async function runSelectivity(settings: SelectivitySettings): Promise<SelectivityOutcome> {
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as {
    readonly split?: string;
    readonly cases?: readonly CaseRecord[];
    readonly controls?: { readonly synthesizedDefinitions?: Readonly<Record<string, string>> };
  };
  const arm = resolveArm(settings.arm);
  const questions = loadQuestions(settings.layout.questionsFile);
  const tables = loadTables(settings.layout.tablesFile);
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));
  const definitions = report.controls?.synthesizedDefinitions ?? {};
  const drops = { unknownQuestion: 0, unknownArm: 0, unrenderable: 0, definitionGap: 0 };
  const cases: SelectivityCase[] = [];
  const seen = new Set<string>();
  if (arm === undefined) {
    drops.unknownArm = (report.cases ?? []).length;
  } else if (!renderableArm(arm)) {
    drops.unrenderable = (report.cases ?? []).length;
  } else {
    const valuesFor = blockReader(arm, settings.layout);
    // One database's notes, read once: the same arm carries the same block on every question of one
    // database, and reading the file 496 times would make the instrument's cost the corpus's size.
    const noteCache = new Map<string, Map<string, Map<string, ColumnNote>>>();
    const notesFor = (db: string, table: BirdTable): Map<string, Map<string, ColumnNote>> => {
      const cached = noteCache.get(db);
      if (cached !== undefined) return cached;
      const loaded = loadDescriptions(
        join(settings.layout.descriptionsRoot, db, 'database_description'),
        table.tableNames,
      );
      noteCache.set(db, loaded);
      return loaded;
    };
    for (const row of requireArm(report.cases, settings.arm, settings.report)) {
      if (row.arm !== settings.arm) continue;
      const id = String(row.id);
      // A case appears once per arm; a question file that holds a duplicate twice would otherwise
      // count it twice and inflate the denominator every share in the report divides by.
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
      const built = promptOf(
        arm,
        question,
        text ?? '',
        table,
        arm.notes === true ? notesFor(question.db_id, table) : undefined,
        valuesFor(question.db_id),
      );
      cases.push({ ...selectivityOf(question.question, question.SQL, built.schema), id });
    }
  }
  const tally = tallySelectivity(cases);
  const dropped = drops.unknownQuestion + drops.unknownArm + drops.unrenderable + drops.definitionGap;
  const problems = [
    ...selectivityProblems(tally),
    ...(dropped === 0
      ? []
      : [
          `the report could not be read for ${String(drops.unknownQuestion)} unknown questions, ` +
            `${String(drops.definitionGap)} without definitions, ${String(drops.unrenderable)} unrenderable ` +
            `arm cases and ${String(drops.unknownArm)} unknown arm cases`,
        ]),
  ];
  const piles = cases.map((one) => ({
    id: one.id,
    linked: one.linked,
    cut: one.cut,
    unreachable: one.unreachable,
    total: one.total,
  }));
  return { split: report.split ?? settings.layout.split, arm: settings.arm, cases: piles, tally, drops, problems };
}

export function selectivityPath(settings: SelectivitySettings): string {
  return join(settings.out, `selectivity-${settings.arm.replace(/[^a-z0-9+_-]/gi, '-')}.json`);
}

export function writeSelectivityArtifact(settings: SelectivitySettings, outcome: SelectivityOutcome): string {
  const path = selectivityPath(settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(outcome, null, 2));
  return path;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const settings = resolveSelectivitySettings(env, argv, root);
  const outcome = await runSelectivity(settings);
  for (const line of selectivityLines(outcome.tally)) console.log(line);
  const path = writeSelectivityArtifact(settings, outcome);
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
