/**
 * Score Spider predictions with the reference's own judge.
 *
 * The judge is the ported `evaluation.py` + `process_sql.py` behind `eval/spider/judge.py`, the same
 * one `check.ts` validates a corpus with, so a reading here and a corpus check there cannot disagree
 * about what exact match means. Three counts come out of a run and they answer different questions:
 * a prediction that does not parse is a reading failure, a gold that does not parse is a corpus
 * failure, and a prediction that parses and differs is a wrong answer — the only one of the three
 * that is a fact about the model.
 *
 *   tsx eval/spider/score.ts --predictions eval/out/spider-predictions.jsonl --out eval/out/spider-reading.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { judgeAll, parseDev } from './check.js';
import type { Verdict } from './check.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

/** What a run of predictions reads as. */
export interface Reading {
  readonly cases: number;
  readonly scored: number;
  readonly exact: number;
  readonly exactPct: number;
  readonly goldErrors: number;
  readonly predErrors: number;
  readonly missing: number;
  readonly firstGoldError: string | undefined;
  readonly firstPredError: string | undefined;
}

/** `index → statement`, refusing a file that names one question twice. */
export function parsePredictions(text: string, where = 'predictions'): Map<number, string> {
  const predictions = new Map<number, string>();
  for (const [offset, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as { index?: unknown; sql?: unknown };
    if (typeof parsed.index !== 'number' || typeof parsed.sql !== 'string') {
      throw new Error(`${where} line ${String(offset + 1)} is not a prediction`);
    }
    if (predictions.has(parsed.index)) {
      throw new Error(`${where} line ${String(offset + 1)} repeats index ${String(parsed.index)}`);
    }
    predictions.set(parsed.index, parsed.sql);
  }
  return predictions;
}

/** The reading, from the judge's verdicts and the denominators they were computed over. */
export function readingOf(
  cases: number,
  verdicts: readonly { readonly em?: number; readonly gold?: string; readonly pred?: string }[],
  answered: number,
): Reading {
  const exact = verdicts.filter((verdict) => verdict.em === 1).length;
  const goldErrors = verdicts.filter((verdict) => verdict.gold === 'error').length;
  const predErrors = verdicts.filter((verdict) => verdict.pred === 'error').length;
  // Percentage of the *scored* cases, which is what the leaderboard's denominator is: a question
  // with no prediction was not answered, and counting it as zero would report the harness.
  return {
    cases,
    scored: answered,
    exact,
    exactPct: answered === 0 ? 0 : Math.round((10000 * exact) / answered) / 100,
    goldErrors,
    predErrors,
    missing: cases - answered,
    firstGoldError: undefined,
    firstPredError: undefined,
  };
}

/** The report, as lines. */
export function reportLines(reading: Reading): readonly string[] {
  return [
    `spider: ${String(reading.cases)} question(s), ${String(reading.scored)} answered, ${String(reading.missing)} missing`,
    `  exact    ${String(reading.exact)} / ${String(reading.scored)} = ${reading.exactPct.toFixed(2)}%  (component match)`,
    `  refused  ${String(reading.predErrors)} prediction(s) did not parse, ${String(reading.goldErrors)} gold(s) did not parse`,
  ];
}

/** Flags this file reads. */
export interface Settings {
  readonly predictions: string | undefined;
  readonly out: string | undefined;
  readonly cache: string | undefined;
  readonly limit: number | undefined;
}

export function resolveSettings(argv: readonly string[]): Settings {
  let predictions: string | undefined;
  let out: string | undefined;
  let cache: string | undefined;
  let limit: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    const value = argv[index + 1];
    if (flag === '--predictions' && value !== undefined) {
      predictions = value;
      index += 1;
    } else if (flag === '--out' && value !== undefined) {
      out = value;
      index += 1;
    } else if (flag === '--cache' && value !== undefined) {
      cache = value;
      index += 1;
    } else if (flag === '--limit' && value !== undefined) {
      limit = Number(value);
      index += 1;
    }
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`--limit must be a positive integer, got ${String(limit)}`);
  }
  return { predictions, out, cache, limit };
}

/** The judge, as this file calls it: pairs in, verdicts out. A parameter so a test needs no python. */
export type JudgeFn = (pairs: readonly { readonly db: string; readonly pred: string; readonly gold: string }[]) => readonly Verdict[];

export function main(
  argv: readonly string[] = process.argv.slice(2),
  log: (line: string) => void = console.log,
  deps: { readonly judge?: JudgeFn } = {},
): number {
  const settings = resolveSettings(argv);
  if (settings.predictions === undefined) {
    log('spider score: --predictions is required');
    return 2;
  }
  const cache = settings.cache ?? process.env.SPIDER_CACHE ?? join(ROOT, 'eval/.cache/spider');
  const questions = parseDev(readFileSync(join(cache, 'dev.json'), 'utf8'));
  const rows = settings.limit === undefined ? questions : questions.slice(0, settings.limit);
  const predictions = parsePredictions(readFileSync(settings.predictions, 'utf8'), settings.predictions);
  const asked = rows
    .map((row, index) => ({ row, index }))
    .filter((entry) => predictions.has(entry.index));
  // A question the corpus names but the database is missing cannot be judged at all; naming the
  // database is what turns "the corpus is broken" into a path a reader can look at.
  const pairs = asked.map(({ row, index }) => {
    const path = join(cache, 'database', row.db_id, `${row.db_id}.sqlite`);
    if (!existsSync(path)) throw new Error(`database ${row.db_id} is missing: expected ${path}`);
    return { db: path, pred: predictions.get(index) as string, gold: row.query };
  });
  const verdicts = (deps.judge ?? judgeAll)(pairs);
  const reading: Reading = {
    ...readingOf(rows.length, verdicts, pairs.length),
    firstGoldError: pairs.find((_, index) => verdicts[index]?.gold === 'error')?.gold,
    firstPredError: pairs.find((_, index) => verdicts[index]?.pred === 'error')?.pred,
  };
  for (const line of reportLines(reading)) log(line);
  if (reading.firstGoldError !== undefined) log(`  first gold error: ${reading.firstGoldError.slice(0, 160)}`);
  if (reading.firstPredError !== undefined) log(`  first refused prediction: ${reading.firstPredError.slice(0, 160)}`);
  if (settings.out !== undefined) {
    writeFileSync(settings.out, `${JSON.stringify({ split: 'dev', reading }, null, 1)}\n`);
    log(`  wrote    ${settings.out}`);
  }
  return reading.goldErrors === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('spider/score.ts')) {
  process.exit(main());
}
