/**
 * Is the nvBench 2.0 corpus scorable? The gate that answers before any number is quoted.
 *
 * Three things have to hold, and each of them fails silently if it does not:
 *
 * 1. **Every question's gold parses.** `gold_answer` is a JSON *string* inside the JSON, holding a
 *    list of Vega-Lite fragments. A gold that does not parse is a question nobody can be credited
 *    for, and the denominator would quietly shrink.
 * 2. **Every field a gold names has a type.** The judge reverses axes by field type, so a missing
 *    entry means a transposed prediction is read as wrong. Under the checkout's own filter stage
 *    243 of 9,076 gold field references had no entry; with the rule the corpus demonstrates, zero do.
 * 3. **The map agrees with the corpus's own record.** Each sample ships a `table_schema` whose
 *    `column_examples` were written by the generator that wrote the metadata — min/median/max for a
 *    quantitative column, three sampled values otherwise. That is 8,952 field decisions on dev and
 *    test, and it is the only thing standing between "we rebuilt the map" and "we rebuilt *their*
 *    map".
 *
 * Exit codes are the contract: 0 scorable, 1 readable but not scorable, 2 unreadable.
 *
 *   node eval/nvbench2/fetch.mjs
 *   python3 eval/nvbench2/metadata.py eval/.cache/nvbench2/database_csv --out eval/.cache/nvbench2/metadata.json
 *   npx tsx eval/nvbench2/check.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runIfEntry } from '../entry.js';
import { isRecord } from './judge.js';
import type { Case, FieldKind, FieldTypes } from './judge.js';

/** The split counts, as the corpus states them. A changed count is a changed benchmark. */
export const EXPECTED = {
  tables: 803,
  splits: {
    dev: { questions: 750, tables: 92 },
    test: { questions: 751, tables: 87 },
  },
};

/** One question, as `{split}.json` stores it. */
export interface SplitRow {
  /** Position in the file; every message names it. */
  readonly index: number;
  readonly csv: string;
  readonly question: string;
  readonly golds: readonly unknown[];
  readonly columns: readonly string[];
  readonly examples: Readonly<Record<string, unknown>>;
  /**
   * How many distinct values each column holds, when the schema says.
   *
   * The corpus ships `unique_value_counts` beside `column_examples`, and its own prompting baseline
   * prints both. It is the only signal in the schema that separates a category from a measure that
   * looks like one (`authorder` has three values, `authid` has thirteen), so a replica of that prompt
   * needs it; an empty object means the row's schema did not carry the field, which is a fact about
   * the row rather than an error.
   */
  readonly counts: Readonly<Record<string, unknown>>;
}

/** What one split reads as. */
export interface SplitReading {
  readonly split: string;
  readonly questions: number;
  readonly tables: number;
  readonly golds: number;
  readonly emptyGold: number;
  readonly fieldRefs: number;
  readonly unresolved: number;
  readonly schemaFields: number;
  readonly missingSchema: number;
  readonly typeDisagreements: number;
}

const KIND: readonly FieldKind[] = ['quantitative', 'category', 'temporal'];

/**
 * The map, checked for shape rather than trusted.
 *
 * A `metadata.json` that is a list, or whose values are strings, would type every field as
 * `undefined` and the judge would still run — no reversal, no error, a lower score. So the loader
 * refuses anything that is not `{csv: {field: kind}}` and says which entry is wrong.
 */
export function resolveTypes(payload: unknown): Record<string, FieldTypes> {
  if (!isRecord(payload)) throw new Error('metadata.json is not an object');
  const raw = payload.types ?? payload;
  if (!isRecord(raw)) throw new Error('metadata.json has no `types` object');
  const out: Record<string, FieldTypes> = {};
  for (const [csv, row] of Object.entries(raw)) {
    if (!isRecord(row)) throw new Error(`metadata entry ${csv} is not an object`);
    for (const [field, kind] of Object.entries(row)) {
      if (typeof kind !== 'string' || !KIND.includes(kind as FieldKind)) {
        throw new Error(`metadata entry ${csv}.${field} is not a kind: ${String(kind)}`);
      }
    }
    out[csv] = row as FieldTypes;
  }
  return out;
}

/** Parse one question file. Anything that is not a question is an error naming its position. */
export function parseSplit(text: string): SplitRow[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('the split is not an array');
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`entry ${String(index)} is not an object`);
    const csv = entry.csv_file;
    const question = entry.nl_query;
    if (typeof csv !== 'string' || csv.length === 0) throw new Error(`entry ${String(index)} has no csv_file`);
    if (typeof question !== 'string' || question.length === 0) {
      throw new Error(`entry ${String(index)} has no nl_query`);
    }
    const gold = entry.gold_answer;
    if (typeof gold !== 'string') throw new Error(`entry ${String(index)} has a non-string gold_answer`);
    let golds: unknown;
    try {
      golds = JSON.parse(gold);
    } catch (error) {
      throw new Error(`entry ${String(index)} has a gold_answer that does not parse: ${String(error)}`);
    }
    if (!Array.isArray(golds)) throw new Error(`entry ${String(index)} has a gold_answer that is not a list`);
    const schema = entry.table_schema;
    if (typeof schema !== 'string') throw new Error(`entry ${String(index)} has a non-string table_schema`);
    const shape: unknown = JSON.parse(schema);
    if (!isRecord(shape)) throw new Error(`entry ${String(index)} has a table_schema that is not an object`);
    const columns = shape.table_columns;
    const examples = shape.column_examples;
    if (!Array.isArray(columns) || columns.some((name) => typeof name !== 'string')) {
      throw new Error(`entry ${String(index)} has no table_columns`);
    }
    if (!isRecord(examples)) throw new Error(`entry ${String(index)} has no column_examples`);
    const counts = shape.unique_value_counts;
    if (counts !== undefined && !isRecord(counts)) {
      throw new Error(`entry ${String(index)} has a unique_value_counts that is not an object`);
    }
    return {
      index,
      csv,
      question,
      golds,
      columns: columns as string[],
      examples,
      counts: counts === undefined ? {} : (counts as Record<string, unknown>),
    };
  });
}

/** Every field a chart names: the encoding channels, and a filter's field. */
export function fieldsOf(chart: unknown): string[] {
  if (!isRecord(chart)) return [];
  const out: string[] = [];
  const encoding = chart.encoding;
  if (isRecord(encoding)) {
    for (const channel of Object.values(encoding)) {
      if (!isRecord(channel)) continue;
      const field = channel.field;
      if (typeof field === 'string') out.push(field);
      else if (Array.isArray(field) && typeof field[0] === 'string') out.push(field[0]);
    }
  }
  const transforms = chart.transform;
  if (Array.isArray(transforms)) {
    for (const transform of transforms) {
      if (!isRecord(transform) || !isRecord(transform.filter)) continue;
      const field = transform.filter.field;
      if (typeof field === 'string') out.push(field);
    }
  }
  return out;
}

/** Whether the examples a column ships are the min/median/max triple of a quantitative column. */
export function looksQuantitative(examples: unknown): boolean {
  if (!Array.isArray(examples) || examples.length === 0) return false;
  return examples.every((value) => typeof value === 'number' && Number.isFinite(value));
}

/** Read one split against the map. */
export function readingOfSplit(split: string, rows: readonly SplitRow[],
  types: Readonly<Record<string, FieldTypes>>): SplitReading {
  let golds = 0;
  let emptyGold = 0;
  let fieldRefs = 0;
  let unresolved = 0;
  let schemaFields = 0;
  let missingSchema = 0;
  let typeDisagreements = 0;
  for (const row of rows) {
    const table = types[row.csv];
    if (row.golds.length === 0) emptyGold += 1;
    for (const gold of row.golds) {
      golds += 1;
      for (const field of fieldsOf(gold)) {
        fieldRefs += 1;
        if (table === undefined || table[field] === undefined) unresolved += 1;
      }
    }
    for (const column of row.columns) {
      schemaFields += 1;
      if (table === undefined || table[column] === undefined) {
        missingSchema += 1;
        continue;
      }
      const claimed = table[column] === 'quantitative';
      if (claimed !== looksQuantitative(row.examples[column])) typeDisagreements += 1;
    }
  }
  return {
    split,
    questions: rows.length,
    tables: new Set(rows.map((row) => row.csv)).size,
    golds,
    emptyGold,
    fieldRefs,
    unresolved,
    schemaFields,
    missingSchema,
    typeDisagreements,
  };
}

/**
 * A gold with its axes exchanged, when it has two object channels to exchange.
 *
 * The judge is supposed to recognise a transposed chart as correct — that is what
 * `reverse_axes_if_needed` is for — so this is the probe that turns the type map into a reading: if
 * the map is wrong, this prediction stops matching and F1@2 falls by exactly the questions whose
 * charts were transpose-equivalent. It is deliberately the *only* structural perturbation used.
 */
export function swappedOf(chart: unknown): unknown {
  if (!isRecord(chart) || !isRecord(chart.encoding)) return chart;
  const encoding = chart.encoding;
  if (!isRecord(encoding.x) || !isRecord(encoding.y)) return chart;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(chart)) out[key] = chart[key];
  out.encoding = { ...encoding, x: encoding.y, y: encoding.x };
  return out;
}

/** A gold with one property replaced, for a prediction that is close and must not match. */
export function patchedOf(chart: unknown, patch: Readonly<Record<string, unknown>>): unknown {
  if (!isRecord(chart)) return chart;
  return { ...chart, ...patch };
}

/**
 * The three predictions every question is asked for, in a fixed order.
 *
 * Deterministic and derived from the gold, because the differential test compares two languages on
 * the same input: `[gold, transposed gold, gold with a different mark]` at k=1,2,3 scores 1/1, 2/2
 * and 2/3 on a judge whose map is right, and something lower on one whose map is missing entries.
 */
export function casesOf(rows: readonly SplitRow[],
  types: Readonly<Record<string, FieldTypes>>): Case[] {
  return rows.map((row) => {
    const gold = row.golds[0];
    return {
      predictions: [gold, swappedOf(gold), patchedOf(gold, { mark: 'point' })],
      golds: row.golds,
      types: types[row.csv] ?? {},
    };
  });
}

/** The claims a reading has to satisfy to be worth a number. */
export function problemsOf(reading: SplitReading): string[] {
  const problems: string[] = [];
  const name = reading.split;
  if (reading.questions === 0) {
    problems.push(`${name}: the split has no questions`);
    return problems;
  }
  if (reading.emptyGold > 0) problems.push(`${name}: ${String(reading.emptyGold)} questions have no gold`);
  if (reading.unresolved > 0) {
    problems.push(`${name}: ${String(reading.unresolved)} of ${String(reading.fieldRefs)} gold fields have no type`);
  }
  if (reading.missingSchema > 0) {
    problems.push(`${name}: ${String(reading.missingSchema)} of ${String(reading.schemaFields)} table columns have no type`);
  }
  if (reading.typeDisagreements > 0) {
    problems.push(`${name}: ${String(reading.typeDisagreements)} of ${String(reading.schemaFields)} field types disagree with the corpus`);
  }
  const expected = EXPECTED.splits[name as keyof typeof EXPECTED.splits];
  if (expected !== undefined) {
    if (reading.questions !== expected.questions) {
      problems.push(`${name}: ${String(reading.questions)} questions, the corpus has ${String(expected.questions)}`);
    }
    if (reading.tables !== expected.tables) {
      problems.push(`${name}: ${String(reading.tables)} tables asked about, the corpus asks ${String(expected.tables)}`);
    }
  }
  return problems;
}

/** What the tool prints. One line per quantity, because a workflow's log is the only reader. */
export function reportLines(readings: readonly SplitReading[]): string[] {
  const lines: string[] = [];
  for (const reading of readings) {
    lines.push(`${reading.split}: ${String(reading.questions)} questions over ${String(reading.tables)} tables`);
    lines.push(`${reading.split}: ${String(reading.golds)} gold charts, ${String(reading.emptyGold)} questions without one`);
    lines.push(`${reading.split}: ${String(reading.fieldRefs)} field references, ${String(reading.unresolved)} untyped`);
    lines.push(`${reading.split}: ${String(reading.schemaFields)} table columns, ${String(reading.missingSchema)} untyped, `
      + `${String(reading.typeDisagreements)} disagreeing with column_examples`);
  }
  return lines;
}

/** Where the cache lives, so a test can point the tool at a directory it wrote. */
export function cacheDir(override?: string): string {
  return override ?? process.env.NVBENCH2_CACHE ?? resolve('eval/.cache/nvbench2');
}

/**
 * The tool. A cache without `metadata.json` is not an error of the corpus — it is an instruction
 * that was not followed, and the message names the command.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  try {
    const at = argv.indexOf('--cache');
    const cache = cacheDir(at === -1 ? undefined : argv[at + 1]);
    const mapPath = join(cache, 'metadata.json');
    if (!existsSync(mapPath)) {
      throw new Error(`metadata is cold: ${mapPath} — run \`python3 eval/nvbench2/metadata.py `
        + `${join(cache, 'database_csv')} --out ${mapPath}\``);
    }
    const types = resolveTypes(JSON.parse(readFileSync(mapPath, 'utf8')));
    const tables = Object.keys(types).length;
    if (tables !== EXPECTED.tables) {
      log(`nvbench2: the map holds ${String(tables)} tables, the corpus has ${String(EXPECTED.tables)}`);
      return 1;
    }
    const readings: SplitReading[] = [];
    for (const split of Object.keys(EXPECTED.splits)) {
      const path = join(cache, `${split}.json`);
      if (!existsSync(path)) throw new Error(`split is cold: ${path} — run \`node eval/nvbench2/fetch.mjs\``);
      readings.push(readingOfSplit(split, parseSplit(readFileSync(path, 'utf8')), types));
    }
    for (const line of reportLines(readings)) log(line);
    const problems = readings.flatMap(problemsOf);
    for (const problem of problems) log(`nvbench2 corpus: ${problem}`);
    return problems.length === 0 ? 0 : 1;
  } catch (error) {
    log(`nvbench2: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

/** What a tool does with the code it computed: nothing when imported, an exit code when run. */
export function entryTail(code: number | undefined,
  set: (value: number) => void = (value) => { process.exitCode = value; }): void {
  if (code !== undefined) set(code);
}

runIfEntry(process.argv[1], import.meta.url, () => {
  void main().then((code) => entryTail(code));
});
