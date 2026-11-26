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
import { normalize } from './normalize.js';

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

/**
 * One line per judged case, in the shape `eval/wikisql/paired.ts` reads.
 *
 * `predOk` is false when the reference could not parse the statement: that is a different failure from
 * a statement that parsed and was wrong, and a paired comparison that folded them together would
 * credit an arm for turning an unreadable statement into a readable wrong one.
 */
export function casesTextOf(
  asked: readonly { readonly index: number }[],
  verdicts: readonly { readonly em?: number; readonly pred?: string }[],
): string {
  return asked
    .map((entry, position) => {
      const verdict = verdicts[position];
      const exact = verdict?.em === 1;
      return JSON.stringify({ index: entry.index, ordered: exact, bag: exact, predOk: verdict?.pred === 'ok' });
    })
    .join('\n')
    .concat(asked.length === 0 ? '' : '\n');
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
  /** One line per judged case, so a later arm is a paired comparison rather than a subtraction. */
  readonly cases: string | undefined;
  /**
   * Judge a refused statement again after `normalize`.
   *
   * Off by default, because a reading that includes repairs is a different quantity from one that
   * does not, and a reader who cannot see which they were given cannot compare two rounds. On, the
   * artifact carries both numbers and `asWritten` is still the one a prompt comparison uses.
   */
  readonly normalize: boolean;
}

export function resolveSettings(argv: readonly string[]): Settings {
  let predictions: string | undefined;
  let out: string | undefined;
  let cache: string | undefined;
  let limit: number | undefined;
  let cases: string | undefined;
  let normalize = false;
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
    } else if (flag === '--cases' && value !== undefined) {
      cases = value;
      index += 1;
    } else if (flag === '--normalize') {
      normalize = true;
    }
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`--limit must be a positive integer, got ${String(limit)}`);
  }
  return { predictions, out, cache, limit, cases, normalize };
}

/** The judge, as this file calls it: pairs in, verdicts out. A parameter so a test needs no python. */
export type JudgeFn = (pairs: readonly { readonly db: string; readonly pred: string; readonly gold: string }[]) => readonly Verdict[];

/**
 * Where the corpus is: the flag, then the environment, then the repository's own cache.
 *
 * Named rather than inlined because the fallback is a claim — a run with no flag reads
 * `eval/.cache/spider`, the directory `fetch.mjs` writes — and a test that proves it by deleting the
 * cache would be a test that passes only on a machine that has never fetched the corpus.
 */
export function cacheOf(settings: { readonly cache: string | undefined }, env: NodeJS.ProcessEnv = process.env): string {
  return settings.cache ?? env.SPIDER_CACHE ?? join(ROOT, 'eval/.cache/spider');
}

/**
 * The verdicts a normalized reading is computed from, and how much of it the repairs bought.
 *
 * Only refusals are replaced. A statement the parser accepted is kept byte for byte, so the accepted
 * set of a normalized reading is the same set as the reading it is compared with and the difference
 * between the two numbers is a count of refusals that became right — never a rewrite of an answer.
 */
export function applyRepairs(
  pairs: readonly { readonly db: string; readonly pred: string; readonly gold: string }[],
  verdicts: readonly Verdict[],
  judge: JudgeFn,
): { readonly verdicts: readonly Verdict[]; readonly refused: number; readonly repaired: number; readonly repairedExact: number } {
  const positions = verdicts.map((verdict, position) => (verdict.pred === 'error' ? position : -1)).filter((position) => position >= 0);
  if (positions.length === 0) return { verdicts, refused: 0, repaired: 0, repairedExact: 0 };
  const repairsOf = judge(positions.map((position) => ({ db: pairs[position]?.db as string, pred: normalize(pairs[position]?.pred as string), gold: pairs[position]?.gold as string })));
  if (repairsOf.length !== positions.length) {
    throw new Error(`the judge answered ${String(repairsOf.length)} of ${String(positions.length)} repairs`);
  }
  const byPosition = new Map(positions.map((position, offset) => [position, repairsOf[offset] as Verdict]));
  return {
    verdicts: verdicts.map((verdict, position) => byPosition.get(position) ?? verdict),
    refused: positions.length,
    repaired: repairsOf.filter((verdict) => verdict.pred === 'ok').length,
    repairedExact: repairsOf.filter((verdict) => verdict.em === 1).length,
  };
}

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
  const cache = cacheOf(settings);
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
  const judge = deps.judge ?? judgeAll;
  const asWritten = judge(pairs);
  const repaired = settings.normalize
    ? applyRepairs(pairs, asWritten, judge)
    : { verdicts: asWritten, refused: 0, repaired: 0, repairedExact: 0 };
  const verdicts = repaired.verdicts;
  const reading: Reading = {
    ...readingOf(rows.length, verdicts, pairs.length),
    firstGoldError: pairs.find((_, index) => verdicts[index]?.gold === 'error')?.gold,
    firstPredError: pairs.find((_, index) => verdicts[index]?.pred === 'error')?.pred,
  };
  for (const line of reportLines(reading)) log(line);
  if (settings.normalize) {
    const written = readingOf(rows.length, asWritten, pairs.length);
    log(`  as written  ${String(written.exact)} / ${String(pairs.length)} = ${written.exactPct.toFixed(2)}%`);
    log(`  repaired    ${String(repaired.repaired)} of ${String(repaired.refused)} refusal(s) now parse, ${String(repaired.repairedExact)} also exact`);
  }
  if (reading.firstGoldError !== undefined) log(`  first gold error: ${reading.firstGoldError.slice(0, 160)}`);
  if (reading.firstPredError !== undefined) log(`  first refused prediction: ${reading.firstPredError.slice(0, 160)}`);
  if (settings.cases !== undefined) {
    writeFileSync(settings.cases, casesTextOf(asked, verdicts));
    log(`  cases    ${settings.cases} (${String(asked.length)})`);
  }
  if (settings.out !== undefined) {
    const artifact = settings.normalize
      ? { split: 'dev', reading, asWritten: readingOf(rows.length, asWritten, pairs.length), repaired: { refused: repaired.refused, parseable: repaired.repaired, exact: repaired.repairedExact } }
      : { split: 'dev', reading };
    writeFileSync(settings.out, `${JSON.stringify(artifact, null, 1)}\n`);
    log(`  wrote    ${settings.out}`);
  }
  return reading.goldErrors === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('spider/score.ts')) {
  process.exit(main());
}
