/**
 * What a split's refusals are made of, and what a repair buys back — measured, not guessed.
 *
 * Round 197 left a plan item: classify the 45 statements the `grammar` arm still had refused, then
 * decide whether a fifth prompt sentence is worth a dispatch. This file is that classification as a
 * tool rather than as a paragraph, because the same question returns for every corpus: a refusal count
 * says how many were lost, the parser's reason says to whom, and only the second number tells a reader
 * whether the next move is a sentence, a repair, or nothing.
 *
 * Two passes over the judge, and the second is the experiment:
 *
 * 1. Every prediction is judged as written. Refusals are the input to the classification.
 * 2. Every refusal is judged again after `normalize`. A refusal that parses the second time was a
 *    spelling; one that still refuses is a construct the grammar does not have, and no amount of
 *    prompting makes a sentence out of it.
 *
 * The output separates three outcomes per class — refused, readable after repair, and *right* after
 * repair — because the 140 statements of the prompt arm's spellings taught what the middle number is
 * worth on its own: 25 of them were also right. A class that turns refusals into readable statements
 * and not into right ones is not a lever, it is a nicer error message.
 *
 *   tsx eval/spider/residue.ts --predictions eval/out/spider-predictions.jsonl
 *   tsx eval/spider/residue.ts --predictions p.jsonl --out eval/out/spider-residue.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeAll, parseDev } from './check.js';
import type { Verdict } from './check.js';
import { normalize, repairsOf, residueLines, residueOf } from './normalize.js';
import type { Residue } from './normalize.js';
import { cacheOf, parsePredictions } from './score.js';
import type { JudgeFn } from './score.js';

/** Flags this file reads. The corpus flags are `score.ts`'s, spelled the same way on purpose. */
export interface Settings {
  readonly predictions: string | undefined;
  readonly cache: string | undefined;
  readonly limit: number | undefined;
  readonly out: string | undefined;
}

export function resolveSettings(argv: readonly string[]): Settings {
  let predictions: string | undefined;
  let cache: string | undefined;
  let limit: number | undefined;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    const value = argv[index + 1];
    if (flag === '--predictions' && value !== undefined) {
      predictions = value;
      index += 1;
    } else if (flag === '--cache' && value !== undefined) {
      cache = value;
      index += 1;
    } else if (flag === '--limit' && value !== undefined) {
      limit = Number(value);
      index += 1;
    } else if (flag === '--out' && value !== undefined) {
      out = value;
      index += 1;
    }
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`--limit must be a positive integer, got ${String(limit)}`);
  }
  return { predictions, cache, limit, out };
}

/**
 * The classification for one predictions file, and the verdicts it was computed from.
 *
 * The first pass is judged once and returned rather than judged again: two passes over 1,034 pairs
 * would be two readings of one split, and a report that computed its total from a second pass could
 * disagree with the refusals it classified.
 */
export function classify(
  pairs: readonly { readonly index: number; readonly db: string; readonly pred: string; readonly gold: string }[],
  judge: JudgeFn,
): { readonly residue: Residue; readonly verdicts: readonly Verdict[] } {
  const verdicts = judge(pairs);
  if (verdicts.length !== pairs.length) {
    throw new Error(`the judge answered ${String(verdicts.length)} of ${String(pairs.length)} pairs`);
  }
  const refused = pairs
    .map((pair, position) => ({ pair, verdict: verdicts[position] as Verdict }))
    .filter((entry) => entry.verdict.pred === 'error');
  const repaired = judge(refused.map((entry) => ({ db: entry.pair.db, pred: normalize(entry.pair.pred), gold: entry.pair.gold })));
  if (repaired.length !== refused.length) {
    throw new Error(`the judge answered ${String(repaired.length)} of ${String(refused.length)} repairs`);
  }
  const residue = residueOf(
    refused.map((entry, position) => ({
      index: entry.pair.index,
      reason: entry.verdict.reason,
      repaired: repaired[position] as Verdict,
      repairs: repairsOf(entry.pair.pred).map((repair) => repair.rule),
    })),
  );
  return { residue, verdicts };
}

/** The residue and the reading it belongs to, as one artifact. */
export interface Artifact {
  readonly instrument: 'eval/spider/residue.ts';
  readonly predictions: string;
  readonly asked: number;
  readonly exact: number;
  readonly exactPct: number;
  readonly exactAfterRepair: number;
  readonly exactAfterRepairPct: number;
  readonly residue: Residue;
}

export function artifactOf(asked: number, exact: number, residue: Residue, predictionsPath: string): Artifact {
  const exactAfterRepair = exact + residue.exact;
  return {
    instrument: 'eval/spider/residue.ts',
    predictions: predictionsPath,
    asked,
    exact,
    exactPct: asked === 0 ? 0 : Math.round((10000 * exact) / asked) / 100,
    exactAfterRepair,
    exactAfterRepairPct: asked === 0 ? 0 : Math.round((10000 * exactAfterRepair) / asked) / 100,
    residue,
  };
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  log: (line: string) => void = console.log,
  deps: { readonly judge?: JudgeFn } = {},
): number {
  const settings = resolveSettings(argv);
  if (settings.predictions === undefined) {
    log('spider residue: --predictions is required');
    return 2;
  }
  const cache = cacheOf(settings);
  const questions = parseDev(readFileSync(join(cache, 'dev.json'), 'utf8'));
  const rows = settings.limit === undefined ? questions : questions.slice(0, settings.limit);
  const predictions = parsePredictions(readFileSync(settings.predictions, 'utf8'), settings.predictions);
  const asked = rows.map((row, index) => ({ row, index })).filter((entry) => predictions.has(entry.index));
  const pairs = asked.map(({ row, index }) => {
    const path = join(cache, 'database', row.db_id, `${row.db_id}.sqlite`);
    if (!existsSync(path)) throw new Error(`database ${row.db_id} is missing: expected ${path}`);
    return { index, db: path, pred: predictions.get(index) as string, gold: row.query };
  });
  const judge = deps.judge ?? judgeAll;
  const { residue, verdicts } = classify(pairs, judge);
  const exact = verdicts.filter((verdict) => verdict.em === 1).length;
  const artifact = artifactOf(asked.length, exact, residue, settings.predictions);
  log(`spider residue: ${settings.predictions}, ${String(asked.length)} question(s)`);
  log(`  exact as written   ${String(artifact.exact)} = ${artifact.exactPct.toFixed(2)}%`);
  log(`  exact after repair ${String(artifact.exactAfterRepair)} = ${artifact.exactAfterRepairPct.toFixed(2)}% (+${String(residue.exact)})`);
  for (const line of residueLines(residue)) log(line);
  if (settings.out !== undefined) {
    writeFileSync(settings.out, `${JSON.stringify(artifact, null, 1)}\n`);
    log(`  wrote ${settings.out}`);
  }
  return 0;
}

/** Is this module the program that was started? Named so both answers are testable. */
export function runsAsMain(argv1: string | undefined): boolean {
  return argv1?.endsWith('spider/residue.ts') === true;
}

if (runsAsMain(process.argv[1])) {
  process.exit(main());
}
