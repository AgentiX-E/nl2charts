/**
 * How much of a reading is an answer, and what the part that is not is worth.
 *
 * A reading reports one number: the mean F1 over the questions it scored. Two runs can read the same
 * number and be different instruments, because three kinds of row are counted and not all of them are
 * answers:
 *
 * | row | what happened | what the reading does |
 * | --- | --- | --- |
 * | `truncated` | the endpoint said the reply hit its token budget | scores it as no chart |
 * | `unparsed` | a reply arrived and held nothing this repository can score | scores it as no chart |
 * | `failed` | no reply at all — a deadline or a transport fault that survived every attempt | scores it as no chart |
 *
 * All three are in the denominator and contribute zero, which is what an execution-accuracy table
 * means by a question it counted. That was not always true of the third: `arm.ts` used to drop failed
 * rows, so the denominator was a function of the arm's own reliability — the arm that timed out more
 * reported the higher mean — and two arms over one split could not be paired at all. The asymmetry was
 * the defect, and this file's counters are what made it visible.
 *
 * The bound is computed rather than argued — if every zero row were answered perfectly the mean would
 * rise by the share of zero rows, so that share *is* the most the rows can be worth — and the number
 * that decides whether to buy them is the bound against the price of a re-dispatch.
 *
 * The same pass decomposes the `misplaced` bucket by channel pair (`movesOf`), because a bucket that
 * is one pair and one exchange away is a prompt rule with a ceiling, and a bucket spread over six
 * pairs is not a rule. Both numbers come from the artifact the reading came from, so neither can
 * describe a different run.
 *
 *   pnpm bench:nvbench2:census eval/out/nvbench2-arm.json
 *   pnpm bench:nvbench2:census eval/out/a.json eval/out/b.json --cache eval/.cache/nvbench2
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runIfEntry } from '../entry.js';
import { cacheDir, resolveTypes } from './check.js';
import { movesOf } from './diagnose.js';
import { isRecord, type Case, type FieldTypes } from './judge.js';

/** What a run answered, counted from the artifact rather than from its log. */
export interface AnswerCensus {
  readonly split: string;
  readonly model: string;
  /** The arms' rules, or an empty list for the arm that sent none — including artifacts older than the field. */
  readonly rules: readonly string[];
  /** The width the reading was taken at, which is also the width the move table is counted at. */
  readonly k: number;
  /** Questions the run was asked. Every one of them is in the reading, so this is its denominator. */
  readonly questions: number;
  /** Questions the reading is over, which is every asked question. Kept as a field for old artifacts. */
  readonly scored: number;
  /** Charts the replies held in total, before scoring. */
  readonly produced: number;
  /** Questions answered from the store rather than by a call. */
  readonly replayed: number;
  readonly truncated: number;
  readonly unparsed: number;
  /** Calls that produced no reply. In the reading as a zero, and counted here so transport is visible. */
  readonly absent: number;
  /** Rows that are in the reading and contributed nothing: truncated plus unparsed. */
  readonly dropouts: number;
  /** Every row in the reading that scored zero: the dropouts plus the absent. */
  readonly zeros: number;
  /** `zeros / scored`, which is also the number of F1 points a perfect answer to them would add. */
  readonly dropoutShare: number;
  /** Charts per question, over the questions that produced any. */
  readonly width: number;
}

/** A non-negative integer the artifact states, or an error naming the field rather than a silent zero. */
function countOf(value: unknown, field: string, artifact: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${artifact}: ${field} is not a count: ${String(value)}`);
  }
  return value;
}

/** The same, for the counters an older artifact may not carry — absent means the run had none. */
function optionalCountOf(value: unknown, field: string, artifact: string): number {
  return value === undefined ? 0 : countOf(value, field, artifact);
}

function stringOf(value: unknown, field: string, artifact: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${artifact}: ${field} is not a string`);
  return value;
}

/** The rules an artifact names, or the empty list for one written before the field existed. */
function rulesOf(value: unknown, artifact: string): readonly string[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((rule) => typeof rule === 'string')) return value as string[];
  throw new Error(`${artifact}: rules is not a list of strings`);
}

/**
 * What one artifact answered.
 *
 * `name` is the file the report was read from, and it appears in every message: an ablation is a set
 * of artifacts, and "questions is not a count" without the file is a hunt.
 */
export function censusOf(report: unknown, name = 'the artifact'): AnswerCensus {
  if (!isRecord(report)) throw new Error(`${name}: the report is not an object`);
  const split = stringOf(report['split'], 'split', name);
  const model = stringOf(report['model'], 'model', name);
  // An artifact written before the field existed is the arm that sent no rules, which is what an
  // empty list means here; anything else that is not a list of strings is a different report.
  const rules = rulesOf(report['rules'], name);
  const k = countOf(report['k'], 'k', name);
  const questions = countOf(report['questions'], 'questions', name);
  const produced = countOf(report['produced'], 'produced', name);
  const truncated = optionalCountOf(report['truncated'], 'truncated', name);
  const unparsed = optionalCountOf(report['unparsed'], 'unparsed', name);
  const absent = optionalCountOf(report['failed'], 'failed', name);
  const dropouts = truncated + unparsed;
  if (dropouts + absent > questions) {
    throw new Error(`${name}: ${String(dropouts + absent)} dropouts and failures over ${String(questions)} questions`);
  }
  // Every asked question is in the reading, so the denominator is the split: a failed call scores zero
  // inside it rather than shrinking it.
  const scored = questions;
  const zeros = dropouts + absent;
  const answered = questions - zeros;
  return {
    split,
    model,
    rules,
    k,
    questions,
    scored,
    produced,
    replayed: optionalCountOf(report['replayed'], 'replayed', name),
    truncated,
    unparsed,
    absent,
    dropouts,
    zeros,
    dropoutShare: scored === 0 ? 0 : zeros / scored,
    width: answered === 0 ? 0 : produced / answered,
  };
}

/**
 * The most the zeros could be worth, in the same units as the reading.
 *
 * Not an estimate and not a gain: an estimate needs a model of what the rows would have said, and the
 * only thing this repository knows about them is that they said nothing. What it can state is the
 * ceiling — a mean over `scored` questions where `zeros` of them are 0 rises by at most
 * `zeros / scored` when those rows are answered perfectly — and a ceiling below the cost of the
 * cheapest way to buy them is a decision, not an opinion.
 */
export function ceilingOf(census: AnswerCensus, f1: number): number {
  return Math.min(1, f1 + census.dropoutShare);
}

/** The census as a reader needs it: one line per claim, with the share it is a share of. */
export function censusLines(census: AnswerCensus): string[] {
  const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;
  const rules = census.rules.length === 0 ? 'none' : census.rules.join(',');
  return [
    `${census.split} ${census.model} rules=${rules} k=${String(census.k)}`,
    `  questions ${String(census.questions)} · scored ${String(census.scored)} · produced ${String(census.produced)}`
      + ` · width ${census.width.toFixed(2)} · replayed ${String(census.replayed)}`,
    `  zeros ${String(census.zeros)} (${pct(census.dropoutShare)} of the reading:`
      + ` ${String(census.truncated)} truncated, ${String(census.unparsed)} unparsed,`
      + ` ${String(census.absent)} absent)`,
  ];
}

/**
 * The questions an artifact kept verbatim, as cases the diagnosis can read.
 *
 * `types` is the corpus's map, keyed by table: a sample names its table and the judge reverses axes by
 * the type of the field, so a sample whose table is not in the map cannot be diagnosed and is an error
 * rather than a case with an empty map — an empty map silently stops reversing axes, which reads as a
 * lower score and not as a missing file.
 */
export function sampledOf(report: unknown, types: Readonly<Record<string, FieldTypes>>, name = 'the artifact'): Case[] {
  if (!isRecord(report)) throw new Error(`${name}: the report is not an object`);
  const samples = report['samples'];
  if (samples === undefined) return [];
  if (!Array.isArray(samples)) throw new Error(`${name}: samples is not a list`);
  return samples.map((sample, index) => {
    if (!isRecord(sample)) throw new Error(`${name}: sample ${String(index)} is not an object`);
    const csv = stringOf(sample['csv'], `sample ${String(index)} csv`, name);
    const table = types[csv];
    if (table === undefined) throw new Error(`${name}: sample ${String(index)} names a table the map does not: ${csv}`);
    const predictions = sample['predictions'];
    const golds = sample['golds'];
    if (!Array.isArray(predictions) || !Array.isArray(golds)) {
      throw new Error(`${name}: sample ${String(index)} has no prediction and gold lists`);
    }
    return { predictions, golds, types: table };
  });
}

/**
 * The corpus's type map, or `undefined` when it is not on disk.
 *
 * A cold map is not an error of the artifact, and it is not a reason to refuse the census either: the
 * counts do not need the corpus. Only the move table does, and it says so and returns 1.
 */
function typesAt(path: string): Record<string, FieldTypes> | undefined {
  try {
    return resolveTypes(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * The tool: a census per artifact, and — when the corpus is on disk — the move table behind it.
 *
 * Exit codes are the contract, as in `check.ts`: 0 every artifact read, 1 read but the corpus is
 * missing so only the censuses are printed, 2 unreadable.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  try {
    const at = argv.indexOf('--cache');
    const cache = cacheDir(at === -1 ? undefined : argv[at + 1]);
    const paths = argv.filter((argument, index) => !argument.startsWith('--') && argv[index - 1] !== '--cache');
    if (paths.length === 0) throw new Error('name at least one artifact');
    const reports = paths.map((path) => {
      const report: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return { path, report, census: censusOf(report, path) };
    });
    const mapPath = join(cache, 'metadata.json');
    const types = typesAt(mapPath);
    // Every artifact is read and every sample placed before the first line is printed: a table that
    // covers four of five artifacts is a table a reader would quote, and the fifth would be missing
    // without a sentence saying so.
    const sampled = types === undefined ? [] : reports.map(({ path, report }) => sampledOf(report, types, path));
    for (const { census } of reports) for (const line of censusLines(census)) log(line);
    if (types === undefined) {
      log(`nvbench2 census: no corpus map at ${mapPath},`);
      log('  so the misplaced decomposition is not printed — run `pnpm bench:nvbench2:metadata` first');
      return 1;
    }
    for (const [index, { path, census }] of reports.entries()) {
      const cases = sampled[index] ?? [];
      if (cases.length === 0) {
        log(`  ${path}: no samples kept, so there is no misplaced decomposition (--samples 0)`);
        continue;
      }
      // The width the reading was taken at, from the artifact rather than from a flag: a move table
      // counted at a different `k` would describe a run nobody scored.
      const moves = movesOf(cases, census.k);
      const pairs = Object.entries(moves.pairs).sort((left, right) => right[1].count - left[1].count);
      const swapped = Object.values(moves.pairs).reduce((total, pair) => total + pair.swapped, 0);
      log(`  misplaced ${String(moves.misplaced)} over ${String(cases.length)} samples`
        + ` · one exchange away ${String(swapped)} · same column twice ${String(moves.selfRepeats)}`);
      for (const [pair, counts] of pairs) {
        log(`    ${pair} ${String(counts.count)} · one exchange away ${String(counts.swapped)}`);
      }
    }
    return 0;
  } catch (error) {
    log(`nvbench2 census: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

runIfEntry(process.argv[1], import.meta.url, () => {
  void main().then((code) => {
    process.exitCode = code;
  });
});
