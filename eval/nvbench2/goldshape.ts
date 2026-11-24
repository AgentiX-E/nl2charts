/**
 * What the gold sets of a split are built from.
 *
 * This module exists because a prompt rule was written, believed, and then contradicted by the
 * split — and the contradiction was found by an offline count rather than by a paid dispatch. The
 * rule said a column whose distinct count equals the row count is an identifier and must carry no
 * channel. The dev split says 1,964 of 4,567 gold field encodings (43%) name exactly such a column,
 * 938 of them on `x`: a timestamp is unique per row and is still the axis. Had the rule shipped, the
 * arm would have been told to drop the columns its own golds put on the axis.
 *
 * So the shape of the golds is a fact worth measuring rather than remembering. Everything here is a
 * pure function of the corpus, so the number a rule cites can be recomputed on any machine, at any
 * time, for nothing, and a later rule that contradicts it is a failing test rather than a paragraph.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSplit, type SplitRow } from './check.js';

/** One question's contribution, already reduced to what the shape is made of. */
export interface ShapeInput {
  /** Every column of the table, as the schema lists it. */
  readonly columns: readonly string[];
  /** Distinct values per column, as `unique_value_counts` states them. Omitted keys are unknown. */
  readonly counts: Readonly<Record<string, unknown>>;
  /** How many rows the table has, or `null` when the table is not on disk. */
  readonly rows: number | null;
  /** The gold set, as parsed charts. */
  readonly golds: readonly unknown[];
}

/** What the split's gold sets are built from. Counts, never rates: a rate hides its denominator. */
export interface GoldShape {
  /** Questions that contributed. A question with no table on disk contributes nothing. */
  readonly questions: number;
  /** Charts across every gold set, which is the corpus's own answer to "how many is an answer". */
  readonly golds: number;
  /** Charts whose encoding names at least one column. */
  readonly chartsWithFields: number;
  /** Field encodings, counted per channel: a chart with x and y contributes two. */
  readonly fieldEncodings: number;
  /** Of those, the ones naming a column whose distinct count equals the table's row count. */
  readonly onUniqueColumn: number;
  /** Questions whose table has at least one such column — the population the rule is about. */
  readonly questionsWithUniqueColumn: number;
  /** Questions whose gold set names every column of its table. */
  readonly fullCoverage: number;
  /** Mean of `named columns / table columns` over the questions that contributed. */
  readonly meanCoverage: number;
  /** Median gold set size, which is what `k` has to be at least. */
  readonly medianGoldSet: number;
}

/** Every chart in a gold answer, whichever shape the corpus wrote it in. */
function chartsOf(golds: readonly unknown[]): readonly Readonly<Record<string, unknown>>[] {
  return golds.filter((gold): gold is Readonly<Record<string, unknown>> =>
    typeof gold === 'object' && gold !== null && !Array.isArray(gold));
}

/** The `field` values a chart names, one per channel. A bare string channel is a field too. */
function fieldsOf(chart: Readonly<Record<string, unknown>>): string[] {
  const encoding = chart['encoding'];
  if (typeof encoding !== 'object' || encoding === null || Array.isArray(encoding)) return [];
  const out: string[] = [];
  for (const spec of Object.values(encoding as Record<string, unknown>)) {
    if (typeof spec === 'string') {
      out.push(spec);
      continue;
    }
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) continue;
    const field = (spec as Record<string, unknown>)['field'];
    if (typeof field === 'string') out.push(field);
  }
  return out;
}

/** A column that is unique per row, as the schema states it: distinct count equals the row count. */
function isUniquePerRow(raw: unknown, rows: number | null): boolean {
  if (rows === null || rows <= 0) return false;
  return typeof raw === 'number' && Number.isInteger(raw) && raw === rows;
}

/** The median of a list of integers, without sorting the caller's array. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * Reduce the split to what the rules are allowed to claim about it.
 *
 * `rows === null` means the table is not on disk, and such a question is dropped rather than counted
 * with a guessed denominator: a coverage rate over tables whose size nobody knows is an average of
 * two different measurements.
 */
export function shapeOf(inputs: readonly ShapeInput[]): GoldShape {
  let questions = 0;
  let golds = 0;
  let chartsWithFields = 0;
  let fieldEncodings = 0;
  let onUniqueColumn = 0;
  let questionsWithUniqueColumn = 0;
  let fullCoverage = 0;
  let coverageSum = 0;
  const sizes: number[] = [];

  for (const input of inputs) {
    if (input.rows === null || input.columns.length === 0) continue;
    questions += 1;
    sizes.push(input.golds.length);
    const unique = new Set(input.columns.filter((column) => isUniquePerRow(input.counts[column], input.rows)));
    if (unique.size > 0) questionsWithUniqueColumn += 1;
    const named = new Set<string>();
    for (const chart of chartsOf(input.golds)) {
      golds += 1;
      const fields = fieldsOf(chart);
      if (fields.length > 0) chartsWithFields += 1;
      for (const field of fields) {
        fieldEncodings += 1;
        named.add(field);
        if (unique.has(field)) onUniqueColumn += 1;
      }
    }
    coverageSum += named.size / input.columns.length;
    if ([...input.columns].every((column) => named.has(column))) fullCoverage += 1;
  }

  return {
    questions,
    golds,
    chartsWithFields,
    fieldEncodings,
    onUniqueColumn,
    questionsWithUniqueColumn,
    fullCoverage,
    meanCoverage: questions === 0 ? 0 : coverageSum / questions,
    medianGoldSet: median(sizes),
  };
}

/** One line a log can carry, so a workflow run states the shape it is about to judge against. */
export function shapeLine(shape: GoldShape): string {
  const share = shape.fieldEncodings === 0 ? 0 : (100 * shape.onUniqueColumn) / shape.fieldEncodings;
  return `gold shape: ${String(shape.questions)} question(s), ${String(shape.golds)} chart(s), `
    + `median ${String(shape.medianGoldSet)} per question · ${String(shape.fieldEncodings)} field encoding(s), `
    + `${String(shape.onUniqueColumn)} on a unique-per-row column (${share.toFixed(1)}%) · `
    + `${String(shape.fullCoverage)} name every column (mean coverage ${(100 * shape.meanCoverage).toFixed(1)}%)`;
}

/** Turn a parsed row into a shape input, given the table's row count (or `null` when it is absent). */
export function shapeInputOf(row: SplitRow, rows: number | null): ShapeInput {
  return { columns: row.columns, counts: row.counts, rows, golds: row.golds };
}

/**
 * How many records a CSV text holds.
 *
 * Not `text.split('\n').length`: four of the 750 dev tables carry a newline inside a quoted field,
 * and a naive count inflates those tables' row counts. The direction of that error matters — an
 * inflated row count makes "distinct count equals row count" fail, so the population the `ranks`
 * rule is about would be undercounted by exactly the tables that need it most.
 */
function recordCount(text: string): number {
  let quoted = false;
  let records = 0;
  let pending = false;
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i] as string;
    if (character === '"') {
      // A doubled quote is an escaped quote inside a field, not the end of one.
      if (quoted && text[i + 1] === '"') {
        i += 1;
        pending = true;
        continue;
      }
      quoted = !quoted;
      pending = true;
      continue;
    }
    if (character === '\n' && !quoted) {
      records += 1;
      pending = false;
      continue;
    }
    if (character !== '\r') pending = true;
  }
  return pending ? records + 1 : records;
}

/** Data rows of a CSV text: records minus the header. A file with no header has no data rows. */
export function countDataRows(text: string): number {
  return Math.max(0, recordCount(text) - 1);
}

/** Where the corpus and the tables live, and how to read them. Injected so the CLI is testable. */
export interface MainDeps {
  readonly readText?: (path: string) => string;
  readonly log?: (line: string) => void;
}

/** The flags this tool documents. */
export interface MainOptions {
  readonly split: string;
  readonly cache: string;
}

/** `--split dev --cache eval/.cache/nvbench2`, and nothing else: a tool with no state has no config. */
export function parseArgs(argv: readonly string[]): MainOptions {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  return { split: value('--split') ?? 'dev', cache: value('--cache') ?? 'eval/.cache/nvbench2' };
}

/**
 * Print the shape of a split's golds, then stop.
 *
 * Read-only and offline: it opens the split and the tables it names, and it makes no request. That is
 * the point — a rule about what columns the golds use should be checkable before it costs anything.
 */
export function main(argv: readonly string[], deps: MainDeps = {}): number {
  const readText = deps.readText ?? ((path: string): string => readFileSync(path, 'utf8'));
  const log = deps.log ?? ((line: string): void => { process.stdout.write(`${line}\n`); });
  const options = parseArgs(argv);

  const splitPath = join(options.cache, `${options.split}.json`);
  let rows: SplitRow[];
  try {
    rows = parseSplit(readText(splitPath));
  } catch (error) {
    throw new Error(`cannot read ${splitPath}: ${(error as Error).message} — run \`node eval/nvbench2/fetch.mjs\` first`);
  }

  const inputs = rows.map((row) => {
    // A table the corpus names but does not ship is `null` rather than zero: the shape drops it, and a
    // dropped question is visible in the count instead of silently shrinking a denominator.
    let rowCount: number | null = null;
    try {
      rowCount = countDataRows(readText(join(options.cache, 'database_csv', row.csv)));
    } catch {
      rowCount = null;
    }
    return shapeInputOf(row, rowCount);
  });

  const shape = shapeOf(inputs);
  log(shapeLine(shape));
  log(`unique-per-row columns appear in ${String(shape.questionsWithUniqueColumn)} of ${String(shape.questions)} question(s)`);
  return 0;
}

/** Whether this module was run rather than imported, which is the only thing the entry checks. */
export function runsAsMain(argv1: string | undefined): boolean {
  return argv1?.endsWith('goldshape.ts') === true || argv1?.endsWith('goldshape.js') === true;
}

if (runsAsMain(process.argv[1])) process.exitCode = main(process.argv.slice(2));
