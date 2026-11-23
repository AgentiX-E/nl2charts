/**
 * Score a WikiSQL split, or prove the split can be scored at all.
 *
 * Two modes, and the second is the one this round needed:
 *
 * - **validation** (no `--predictions`): execute every gold logical form, twice, and compare the two
 *   passes. A gold that fails is a question no system can be credited for; a gold that answers
 *   differently on the second pass is a judge that cannot reproduce itself, which is the failure mode
 *   that looks like a model's noise. The dev split reports 8,421 questions, 0 errors, 0 empty — the
 *   reading that makes an execution-accuracy number on it mean anything.
 * - **scoring** (`--predictions <jsonl>`): execute each predicted statement against the same
 *   database and compare with the reference's ordered comparison, reporting the order-free multiset
 *   count beside it.
 *
 *   tsx eval/wikisql/run.ts                        # validate dev
 *   tsx eval/wikisql/run.ts --limit 500            # the first 500 questions
 *   tsx eval/wikisql/run.ts --predictions out.jsonl
 *   tsx eval/wikisql/run.ts --digest               # the differential fixture's digest
 *   tsx eval/wikisql/run.ts --self-test
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createOracle } from '../bird/oracle.js';
import type { Oracle } from '../bird/oracle.js';
import { digestOf, Judge, parseSplit, parsePredictions, percent, readingOf, schemaOf } from './exec.js';
import type { Answer, CaseReading, Reading, SplitRow } from './exec.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const ORACLE = join(ROOT, 'eval/bird/oracle.py');

/** Where a fetched split lives. A parameter, because a test scores a split it wrote itself. */
export function cacheDir(override?: string): string {
  return override ?? process.env.WIKISQL_CACHE ?? join(ROOT, 'eval/.cache/wikisql');
}

/** Flags this file reads, and nothing else. */
export interface Settings {
  readonly split: string;
  readonly limit: number | undefined;
  readonly predictions: string | undefined;
  readonly out: string | undefined;
  readonly cache: string | undefined;
  /** Print the digest of every gold answer instead of a report, for the differential fixture. */
  readonly digest: boolean;
}

export function resolveSettings(argv: readonly string[]): Settings {
  let split = 'dev';
  let limit: number | undefined;
  let predictions: string | undefined;
  let out: string | undefined;
  let cache: string | undefined;
  let digest = false;
  for (let index = 0; index < argv.length; index += 1) {
    // The bound is the guarantee: `argv[index]` cannot be undefined inside it. Writing the read
    // without the cast makes the type say it might be, and the guard that follows is a branch no
    // input can take.
    const flag = argv[index] as string;
    const value = argv[index + 1];
    if (flag === '--split') {
      if (value === undefined) throw new Error('--split needs a name');
      split = value;
      index += 1;
    } else if (flag === '--limit') {
      if (value === undefined) throw new Error('--limit needs a count');
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--limit ${value} is not a positive count`);
      limit = parsed;
      index += 1;
    } else if (flag === '--predictions') {
      if (value === undefined) throw new Error('--predictions needs a path');
      predictions = value;
      index += 1;
    } else if (flag === '--out') {
      if (value === undefined) throw new Error('--out needs a path');
      out = value;
      index += 1;
    } else if (flag === '--cache') {
      if (value === undefined) throw new Error('--cache needs a path');
      cache = value;
      index += 1;
    } else if (flag === '--digest') {
      digest = true;
    } else if (flag.startsWith('--')) {
      throw new Error(`unknown flag ${flag}`);
    } else {
      throw new Error(`unexpected argument ${flag}`);
    }
  }
  return { split, limit, predictions, out, cache, digest };
}

/** How many statements are in flight at once. The oracle queues them; this bounds memory, not speed. */
const WINDOW = 32;

async function mapWindow<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(WINDOW, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Answers one question. A function rather than a judge, so the folding below can be tested alone. */
export type GoldReader = (row: SplitRow) => Promise<Answer>;

export interface Validation {
  readonly cases: number;
  readonly errors: number;
  readonly empty: number;
  /** Questions whose second pass disagreed with the first: the judge did not reproduce itself. */
  readonly unstable: readonly number[];
  readonly firstError: string | undefined;
}

/** Execute every gold twice and report what could not be judged. */
export async function validate(read: GoldReader, rows: readonly SplitRow[]): Promise<Validation> {
  const once = await mapWindow(rows, (row) => read(row));
  const twice = await mapWindow(rows, (row) => read(row));
  let errors = 0;
  let empty = 0;
  let firstError: string | undefined;
  const unstable: number[] = [];
  for (const [index, answer] of once.entries()) {
    if (!answer.ok) {
      errors += 1;
      firstError ??= `${String(rows[index]?.index)}: ${answer.error}`;
      continue;
    }
    if (answer.rows.length === 0) empty += 1;
    const again = twice[index];
    if (again === undefined || !again.ok) {
      // A gold that executed and then did not is a judge whose database changed underneath it.
      unstable.push(index);
      continue;
    }
    if (JSON.stringify(answer.rows) !== JSON.stringify(again.rows)) unstable.push(index);
  }
  return { cases: rows.length, errors, empty, unstable, firstError };
}

/** Score predictions for the questions both sides have an answer for. */
export async function score(
  readGold: GoldReader,
  readPred: (row: SplitRow, sql: string) => Promise<Answer>,
  rows: readonly SplitRow[],
  predictions: Map<number, string>,
): Promise<{ readings: CaseReading[]; missing: number }> {
  const asked = rows.filter((row) => predictions.has(row.index));
  const readings = await mapWindow(asked, async (row) => {
    const gold = await readGold(row);
    const pred = await readPred(row, predictions.get(row.index) as string);
    return Judge.compare(row.index, gold, pred);
  });
  return { readings, missing: rows.length - asked.length };
}

/** The report, as lines: what was asked, what answered, and what the two comparisons saw. */
export function reportLines(reading: Reading, validation: Validation | undefined): readonly string[] {
  const lines = [
    `wikisql ${String(reading.cases)} questions`,
    `  gold     ${String(reading.cases - reading.goldErrors)} / ${String(reading.cases)} executed, ${String(reading.goldEmpty)} empty`,
  ];
  if (validation !== undefined && validation.unstable.length > 0) {
    lines.push(`  unstable ${String(validation.unstable.length)} questions answered differently on a second pass`);
  }
  if (validation !== undefined && validation.errors > 0) {
    lines.push(`  first gold error: ${validation.firstError ?? 'unknown'}`);
  }
  if (reading.scored > 0) {
    lines.push(
      `  exact    ${String(reading.exact)} / ${String(reading.scored)} = ${percent(reading.exact, reading.scored).toFixed(2)}%  (reference order)`,
      `  bag      ${String(reading.bag)} / ${String(reading.scored)} = ${percent(reading.bag, reading.scored).toFixed(2)}%  (order erased)`,
      `  refused  ${String(reading.predErrors)} statements did not execute`,
    );
  }
  return lines;
}

/**
 * One claim about this file, compared, and named if it is wrong.
 *
 * Exported so the *failure* path is executable: a self-test whose "everything is fine" line is the
 * only one that can run is a self-test that has never reported anything, and coverage says so.
 */
export function diff(label: string, actual: unknown, expected: unknown): string | undefined {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return undefined;
  return `${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`;
}

/**
 * The claims this file makes about itself, checked.
 *
 * Not a second test suite — the suite is `test/wikisql-run.test.ts`. This is the check a reader can
 * run against the file they were handed, and it fails loudly if the parse of a split's lines and the
 * denominator arithmetic have drifted from what the report says.
 */
export function selfTest(): readonly string[] {
  const rows = parseSplit('{"table_id":"1-2-3","question":"q","sql":{"sel":0,"agg":0,"conds":[]}}\n{"table_id":"1-2-4","question":"r","sql":{"sel":1,"agg":1,"conds":[[0,0,"x"]]}}');
  const shape = schemaOf('CREATE TABLE table_1_2_3 (col0 real, col1 text)', '1-2-3');
  const predictions = parsePredictions('{"index":0,"sql":"SELECT 1"}\n');
  const readings: CaseReading[] = [
    { index: 0, gold: { ok: true, rows: [[1]] }, pred: { ok: true, rows: [[1]] }, ordered: true, bag: true },
    { index: 1, gold: { ok: true, rows: [[1]] }, pred: { ok: false, error: 'x' }, ordered: false, bag: false },
  ];
  const reading = readingOf(readings, 2);
  const checks: readonly (readonly [string, unknown, unknown])[] = [
    ['parseSplit reads both lines', rows.length, 2],
    ['parseSplit indexes in file order', rows[1]?.index, 1],
    ['schemaOf names the table after its id', shape.name, 'table_1_2_3'],
    ['schemaOf reads the declared types', shape.types.join(','), 'real,text'],
    ['percent rounds to two decimals', percent(1, 3), 33.33],
    ['percent refuses an empty denominator', percent(1, 0), 0],
    ['readingOf counts exact matches', reading.exact, 1],
    ['readingOf counts refused predictions', reading.predErrors, 1],
    ['parsePredictions keeps the statement', predictions.get(0), 'SELECT 1'],
  ];
  return checks
    .map(([label, actual, expected]) => diff(label, actual, expected))
    .filter((problem): problem is string => problem !== undefined);
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  log: (line: string) => void = console.log,
): Promise<number> {
  if (argv.includes('--self-test')) {
    const problems = selfTest();
    for (const problem of problems) log(`wikisql self-test: ${problem}`);
    if (problems.length === 0) log('wikisql self-test: ok');
    return problems.length === 0 ? 0 : 1;
  }
  const settings = resolveSettings(argv);
  const cache = cacheDir(settings.cache);
  const questions = join(cache, `${settings.split}.jsonl`);
  const tables = join(cache, `${settings.split}.tables.jsonl`);
  const db = join(cache, `${settings.split}.db`);
  for (const path of [questions, tables, db]) {
    if (!existsSync(path)) {
      throw new Error(`cache is cold: ${path} — run \`node eval/wikisql/fetch.mjs --split ${settings.split}\``);
    }
  }
  const all = parseSplit(readFileSync(questions, 'utf8'));
  const rows = settings.limit === undefined ? all : all.slice(0, settings.limit);

  const oracle: Oracle = createOracle(ORACLE, cache);
  try {
    const judge = new Judge(oracle, `${settings.split}.db`);
    const read: GoldReader = (row) => judge.goldOf(row);
    const validation = await validate(read, rows);
    if (settings.digest) {
      const answers = await mapWindow(rows, read);
      log(digestOf(answers));
    } else {
      let reading: Reading = {
        cases: rows.length,
        scored: 0,
        exact: 0,
        bag: 0,
        goldErrors: validation.errors,
        goldEmpty: validation.empty,
        predErrors: 0,
      };
      let missing = 0;
      if (settings.predictions !== undefined) {
        const predictions = parsePredictions(readFileSync(settings.predictions, 'utf8'));
        const scored = await score(read, (row, sql) => judge.predictOf(row.tableId, sql), rows, predictions);
        reading = { ...reading, ...readingOf(scored.readings, rows.length) };
        missing = scored.missing;
      }
      for (const line of reportLines(reading, validation)) log(line);
      if (missing > 0) log(`  missing  ${String(missing)} questions have no prediction`);
      if (settings.out !== undefined) {
        writeFileSync(
          settings.out,
          `${JSON.stringify({ split: settings.split, provenance: { oracle: 'eval/bird/oracle.py', db: `${settings.split}.db` }, validation, reading }, null, 2)}\n`,
        );
        log(`  wrote    ${settings.out}`);
      }
    }
    return validation.errors === 0 && validation.unstable.length === 0 ? 0 : 1;
  } finally {
    await oracle.close();
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('wikisql/run.ts')) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(String(error));
      process.exit(1);
    },
  );
}
