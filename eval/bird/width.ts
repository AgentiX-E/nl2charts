/**
 * How wide the answer is, and whether the extra columns are the mistake.
 *
 * The judge files about a quarter of the no-answer corpus under `column-count`: the statement
 * ran, returned the right number of rows, and carried a different number of columns. Two tools
 * already existed and both stop at that sentence. `bench:bird:gap` counts the bucket, and
 * `bench:bird:gap:values` excludes it on a stated doctrine — "a statement whose width is wrong
 * cannot be diagnosed clause by clause, because the projection is the finding".
 *
 * That doctrine is an assumption about the corpus, and this file tests it with the only edit
 * it permits: delete the extra items from the select list, every subset, re-execute, and ask
 * the same judge. A case that becomes correct is a case the projection really was the finding
 * for. A case that stays wrong with the right width had a different cause, and the width was a
 * symptom — which means the clause ladder that was excluding it is exactly the tool it needs.
 *
 * The measurement is a *ceiling*, and it is an oracle's: the subsets are chosen with knowledge
 * of the gold's width, so no implementable rule can do better than the number this prints.
 * That is why it can decide an experiment before the experiment is run. The lever it prices is
 * a projection rule in the prompt — "return only the columns the question asks for" — and a
 * ceiling below this harness's own noise means the rule is not worth 496 calls.
 *
 * Two directions are measured, because only one of them has an implementable edit:
 *
 * - `wide` — more columns than the answer. Removal is an edit a rule can make, so the ceiling
 *   is computed by trying it.
 * - `narrow` — fewer columns. Nothing can be added without the gold, so the reading is the
 *   list of gold items the statement never spells: a name to look for in the card, not a
 *   lever to pull.
 *
 * Everything here is deterministic and spends no model call: one query per case, plus one per
 * candidate subset. The subsets are bounded (`TRIM_TRIALS`), and a case too wide to enumerate
 * is reported as unexplored rather than silently counted as a zero.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { judgeOfficial } from '@agentix-e/nl2charts-devkit';
import { loadQuestions } from './data.js';
import type { GapReportShape } from './gap.js';
import { createOracle } from './oracle.js';
import type { OracleResult } from './oracle.js';
import { SHIPPED_ARM, requireArm } from './presence.js';
import { resolveLayout } from './run.js';
import type { BirdLayout } from './run.js';

/** Where the select list starts and ends inside a statement, as offsets into its text. */
export interface SelectList {
  /** Everything before the first item: `select`, an optional `distinct`, and the spaces. */
  readonly head: string;
  readonly items: readonly string[];
  /** From the first top-level `from` to the end of the statement. Empty when there is none. */
  readonly tail: string;
}

/**
 * The offsets of `select` and `from` at paren depth zero.
 *
 * A character scan rather than a regex, because both keywords are also legal inside a string
 * literal (`where note = 'select from'`) and inside a subquery, and a regex cannot tell the
 * three apart. Quotes are skipped with SQLite's doubled-quote escape.
 */
export function clauseOffsets(sql: string): { readonly selects: readonly number[]; readonly froms: readonly number[] } {
  const selects: number[] = [];
  const froms: number[] = [];
  const isWord = (char: string | undefined): boolean => char !== undefined && /[A-Za-z0-9_]/.test(char);
  let depth = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index] as string;
    if (char === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      continue;
    }
    if (depth !== 0 || !/[A-Za-z]/.test(char) || isWord(sql[index - 1])) continue;
    const rest = sql.slice(index, index + 6).toLowerCase();
    if (rest.startsWith('select') && !isWord(sql[index + 6])) selects.push(index);
    if (rest.startsWith('from') && !isWord(sql[index + 4])) froms.push(index);
  }
  return { selects, froms };
}

/**
 * The top-level select list of a statement.
 *
 * The *last* depth-zero `select` is the answer's, not the first: a CTE begins with one and its
 * body is inside parentheses, so the outer statement is the one furthest right. Taking the
 * first would have measured the width of whichever subquery the model happened to write.
 */
export function selectList(sql: string): SelectList | undefined {
  const { selects, froms } = clauseOffsets(sql);
  const start = selects.at(-1);
  if (start === undefined) return undefined;
  const afterKeyword = start + 'select'.length;
  const distinct = /^\s*distinct\b/i.exec(sql.slice(afterKeyword));
  const bodyStart = afterKeyword + (distinct === null ? 0 : distinct[0].length);
  const end = froms.find((index) => index >= bodyStart) ?? sql.length;
  return { head: sql.slice(0, bodyStart), items: splitItems(sql.slice(bodyStart, end)), tail: sql.slice(end) };
}

/** Top-level commas, using the same scan as the clause reader. */
function splitItems(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string;
    if (char === "'") {
      index += 1;
      while (index < body.length) {
        if (body[index] === "'") {
          if (body[index + 1] === "'") {
            index += 2;
            continue;
          }
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      items.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(body.slice(start).trim());
  return items.filter((item) => item !== '');
}

/**
 * The statement with only the items at `keep`, in their original order.
 *
 * The two slices do not carry the whitespace between them — `head` stops right after
 * `select`/`distinct` and `tail` starts at `from` — so both edges have to be re-spaced. The
 * first version concatenated them directly and produced `… AS ageFROM Player …` and
 * `select distinct(…)`; the statements failed to run, the failures were counted as "that
 * subset did not help", and the tool reported a ceiling of 1 where the truth was 2. A silent
 * zero is the failure mode this whole file exists to avoid, so it is worth saying that it
 * happened here first.
 */
export function withItems(list: SelectList, keep: readonly number[]): string {
  const body = keep.map((index) => list.items[index] as string).join(', ');
  return `${list.head} ${body}${list.tail === '' ? '' : ` ${list.tail}`}`;
}

export type Width = 'wide' | 'narrow' | 'exact';

/** Which way the predicted answer is off, if it is. */
export function widthOf(goldWidth: number, predictedWidth: number): Width {
  if (predictedWidth > goldWidth) return 'wide';
  if (predictedWidth < goldWidth) return 'narrow';
  return 'exact';
}

/** How many subsets one case may try before the ceiling is reported as unexplored. */
export const TRIM_TRIALS = 64;

/** Every way to keep `keep` of `count` items, in lexicographic order. */
export function keeps(count: number, keep: number): number[][] {
  const out: number[][] = [];
  const walk = (from: number, chosen: number[]): void => {
    if (chosen.length === keep) {
      out.push([...chosen]);
      return;
    }
    for (let index = from; index < count; index += 1) walk(index + 1, [...chosen, index]);
  };
  walk(0, []);
  return out;
}

export interface TrimOutcome {
  readonly recovered: boolean;
  /** The items that had to go, when one subset fixed the answer. Fewest first. */
  readonly dropped: readonly string[];
  /** False when the case offered more subsets than `TRIM_TRIALS` allows. */
  readonly explored: boolean;
}

/**
 * Does deleting projected items fix the answer, and which ones?
 *
 * Fewest deletions first, because the reading is meant to name the smallest edit that would
 * have worked: a case that improves when three columns go is a different finding from one that
 * needs a single stray aggregate removed. Within a size, subsets are tried in lexicographic
 * order, so two runs of the same artifact pick the same one.
 */
export async function trimCeiling(input: {
  readonly list: SelectList;
  readonly goldWidth: number;
  readonly gold: readonly (readonly unknown[])[];
  readonly run: (sql: string) => Promise<OracleResult>;
  readonly trials?: number;
}): Promise<TrimOutcome> {
  const budget = input.trials ?? TRIM_TRIALS;
  const total = input.list.items.length;
  let tried = 0;
  for (let drop = 1; drop <= total - input.goldWidth; drop += 1) {
    for (const keep of keeps(total, total - drop)) {
      if (tried >= budget) return { recovered: false, dropped: [], explored: false };
      tried += 1;
      const attempt = await input.run(withItems(input.list, keep));
      if (!attempt.ok) continue;
      if (judgeOfficial(input.gold, attempt.rows) === 'match') {
        const dropped = input.list.items.filter((_, index) => !keep.includes(index));
        return { recovered: true, dropped, explored: true };
      }
    }
  }
  return { recovered: false, dropped: [], explored: true };
}

/** One case's reading: the two widths, and — for a wide case — what removing items bought. */
export interface WidthRow {
  readonly id: string;
  readonly goldWidth: number;
  readonly predictedWidth: number;
  readonly width: Width;
  readonly recovered: boolean;
  readonly dropped: readonly string[];
  /** A narrow case's gold items that the statement never spells, as a name to look for. */
  readonly missing: readonly string[];
  /** False when the statement has no select list this reader can find, so no subset was tried. */
  readonly located: boolean;
  /** False when the subsets overflowed the budget, so `recovered` is unknown rather than no. */
  readonly explored: boolean;
}

export interface WidthDrops {
  readonly unknownQuestion: number;
  readonly unretained: number;
  readonly engineRefused: number;
  readonly goldFailed: number;
}

export const NO_WIDTH_DROPS: WidthDrops = { unknownQuestion: 0, unretained: 0, engineRefused: 0, goldFailed: 0 };

export interface WidthTally {
  readonly total: number;
  readonly wide: number;
  readonly narrow: number;
  readonly exact: number;
  /** Wide cases a deletion made correct. */
  readonly recovered: number;
  /** Wide cases whose subsets overflowed the budget. */
  readonly unexplored: number;
  /** `recovered` as a share of every case the arm was scored on, in points. */
  readonly ceilingPoints: number;
}

export function tallyWidth(rows: readonly WidthRow[], scored: number): WidthTally {
  const wide = rows.filter((row) => row.width === 'wide').length;
  const narrow = rows.filter((row) => row.width === 'narrow').length;
  const recovered = rows.filter((row) => row.recovered).length;
  const points = scored === 0 ? 0 : (recovered / scored) * 100;
  return {
    total: rows.length,
    wide,
    narrow,
    exact: rows.length - wide - narrow,
    recovered,
    unexplored: rows.filter((row) => row.width === 'wide' && row.located && !row.explored).length,
    ceilingPoints: Number(points.toFixed(2)),
  };
}

/** Where a run reads and writes. */
export interface WidthSettings {
  readonly report: string;
  readonly layout: BirdLayout;
  readonly arm: string;
  readonly out: string;
  readonly strict: boolean;
}

export function resolveWidthSettings(
  env: Record<string, string | undefined>,
  argv: readonly string[],
  root: string,
): WidthSettings {
  const flag = argv.indexOf('--arm');
  const named = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && named === undefined) throw new Error('--arm needs a name');
  const consumed = flag === -1 ? [] : [flag, flag + 1];
  const path = argv.find((item, index) => !item.startsWith('--') && !consumed.includes(index));
  if (path === undefined) throw new Error('usage: width.ts <report.json> [--arm <name>] [--strict]');
  const layout = resolveLayout(env, root);
  return { report: path, layout, arm: named ?? SHIPPED_ARM, out: dirname(layout.out), strict: argv.includes('--strict') };
}

export interface WidthOutcome {
  readonly split: string;
  readonly arm: string;
  /** Every question the arm was scored on: the denominator the ceiling is quoted against. */
  readonly scored: number;
  readonly rows: readonly WidthRow[];
  readonly tally: WidthTally;
  readonly drops: WidthDrops;
  readonly problems: readonly string[];
}

/**
 * The gold's select items the prediction never spells, compared by column name.
 *
 * The qualifier is dropped from the gold item before the search: the question this answers is
 * "does the statement mention this column at all", and `t.price` against a prediction that
 * wrote `price` has spelled it. The name is matched on identifier edges for the same reason
 * `recall` does — `price` must not be satisfied by `unit_price`.
 */
export function missingItems(gold: SelectList | undefined, predicted: string): string[] {
  if (gold === undefined) return [];
  const flat = predicted.replace(/\s+/g, ' ').toLowerCase();
  return gold.items.filter((item) => {
    // The last dotted segment, which is the column. An item that is only a qualifier (`t.`)
    // has no column to look for, and an empty pattern matches nothing, so it is skipped rather
    // than reported as a name the answer is missing.
    const name = (item.split('.').pop() as string).replace(/\s+/g, ' ').trim();
    if (name === '') return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`(^|[^a-z0-9_])${escaped}($|[^a-z0-9_])`, 'i').test(flat);
  });
}

/**
 * Read the arm's `column-count` cases and price the projection lever.
 *
 * The widths come from the executed result sets rather than from the text: the judge's rule is
 * about columns the engine produced, and a select list split by a scanner is the scanner's
 * opinion. That costs one query per statement, which is also what makes the trim search
 * possible — the gold's rows have to be in hand to judge the trimmed candidates against.
 */
export async function runWidth(settings: WidthSettings): Promise<WidthOutcome> {
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as GapReportShape;
  const questions = loadQuestions(settings.layout.questionsFile);
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));
  const cases = requireArm(report.cases, settings.arm, settings.report).filter((row) => row.arm === settings.arm);
  const statements = new Map((report.failures?.[settings.arm] ?? []).map((entry) => [String(entry.id), entry]));
  const scored = cases.length;
  const filed = cases.filter((row) => row.reason === 'column-count');
  const rows: WidthRow[] = [];
  const drops = { unknownQuestion: 0, unretained: 0, engineRefused: 0, goldFailed: 0 };
  const oracle = createOracle(settings.layout.oracleScript, settings.layout.databaseRoot);
  const gold = new Map<string, OracleResult>();
  try {
    for (const row of filed) {
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
      let expected = gold.get(id);
      if (expected === undefined) {
        expected = await oracle.run(question.db_id, question.SQL);
        gold.set(id, expected);
      }
      if (!expected.ok) {
        drops.goldFailed += 1;
        continue;
      }
      const predicted = await oracle.run(question.db_id, failure.predicted);
      if (!predicted.ok) {
        drops.engineRefused += 1;
        continue;
      }
      const goldWidth = expected.columns.length;
      const predictedWidth = predicted.columns.length;
      const width = widthOf(goldWidth, predictedWidth);
      const list = selectList(failure.predicted);
      const trim =
        width === 'wide' && list !== undefined
          ? await trimCeiling({
              list,
              goldWidth,
              gold: expected.rows,
              run: (sql) => oracle.run(question.db_id, sql),
            })
          : { recovered: false, dropped: [], explored: width !== 'wide' };
      rows.push({
        id,
        goldWidth,
        predictedWidth,
        width,
        recovered: trim.recovered,
        dropped: trim.dropped,
        missing: width === 'narrow' ? missingItems(selectList(question.SQL), failure.predicted) : [],
        located: list !== undefined,
        explored: trim.explored,
      });
    }
  } finally {
    await oracle.close();
  }
  const tally = tallyWidth(rows, scored);
  return { split: settings.layout.split, arm: settings.arm, scored, rows, tally, drops, problems: widthProblems(rows, drops) };
}

/**
 * What stops the reading being publishable.
 *
 * Deliberately narrow: the ceiling itself is a reading and a low one is a finding, not a
 * failure. What fails the build is the instrument being unable to do its job — a case whose
 * statement the artifact kept but the split cannot name, or a case whose select list this
 * reader cannot find. Those are defects in the tools, and a defect that prints a zero looks
 * exactly like a corpus with nothing to report.
 */
export function widthProblems(rows: readonly WidthRow[], drops: WidthDrops): string[] {
  const problems: string[] = [];
  if (drops.unknownQuestion > 0) {
    problems.push(`WIDTH: ${String(drops.unknownQuestion)} cases name a question the split does not hold, so their width was never measured`);
  }
  const unreadable = rows.filter((row) => row.width === 'wide' && !row.located).length;
  if (unreadable > 0) {
    problems.push(`WIDTH: ${String(unreadable)} wide cases hold no select list this reader can find, so their ceiling was not computed`);
  }
  return problems;
}

export function widthLines(outcome: WidthOutcome): string[] {
  const { tally } = outcome;
  const share = (count: number): string => (tally.total === 0 ? '0.0%' : `${((count / tally.total) * 100).toFixed(1)}%`);
  const lines = [
    `width ${outcome.split} · ${outcome.arm}: ${String(tally.total)} column-count cases of ${String(outcome.scored)} scored`,
    `  wide    ${String(tally.wide).padStart(4)}  ${share(tally.wide)}  more columns than the answer`,
    `  narrow  ${String(tally.narrow).padStart(4)}  ${share(tally.narrow)}  fewer columns than the answer`,
    `  exact   ${String(tally.exact).padStart(4)}  ${share(tally.exact)}  the judge and the re-execution disagree`,
    `  removing columns recovers ${String(tally.recovered)} of the ${String(tally.wide)} wide cases: ceiling ${tally.ceilingPoints.toFixed(2)}pp of ${String(outcome.scored)} scored`,
  ];
  if (tally.unexplored > 0) {
    lines.push(`  ${String(tally.unexplored)} wide cases offered more than ${String(TRIM_TRIALS)} subsets and were not enumerated`);
  }
  const recovered = outcome.rows.filter((row) => row.recovered);
  for (const row of recovered.slice(0, 5)) lines.push(`  recovered ${row.id} by dropping: ${row.dropped.join(' | ')}`);
  const missing = new Map<string, number>();
  for (const row of outcome.rows) for (const item of row.missing) missing.set(item, (missing.get(item) ?? 0) + 1);
  for (const [item, count] of [...missing.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 5)) {
    lines.push(`  narrow cases never spell ${item} (${String(count)})`);
  }
  for (const problem of outcome.problems) lines.push(`  FAILED ${problem}`);
  return lines;
}

export function widthPath(settings: WidthSettings): string {
  return join(settings.out, `width-${settings.arm.replace(/[^a-z0-9+_-]/gi, '-')}.json`);
}

export function writeWidthArtifact(settings: WidthSettings, outcome: WidthOutcome): string {
  const path = widthPath(settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(outcome, null, 2)}\n`);
  return path;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const settings = resolveWidthSettings(env, argv, root);
  const outcome = await runWidth(settings);
  for (const line of widthLines(outcome)) console.log(line);
  console.log(
    `  dropped: ${String(outcome.drops.unretained)} unretained, ${String(outcome.drops.engineRefused)} refused by the engine, ` +
      `${String(outcome.drops.goldFailed)} unrunnable gold, ${String(outcome.drops.unknownQuestion)} unknown question`,
  );
  const path = writeWidthArtifact(settings, outcome);
  console.log(`\nwrote ${path}`);
  for (const problem of outcome.problems) console.error(problem);
  if (outcome.problems.length === 0) return 0;
  return settings.strict ? 1 : 0;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
