/**
 * Two readings of one split, compared case by case.
 *
 * ## Why a second tool instead of a second column
 *
 * 85.30% and 84.00% are two numbers about two prompts, and the difference between them is not
 * 1.30pp: questions differ in difficulty, so an arm can win four hard cases and lose forty easy ones
 * while the totals nearly cancel. The paired design throws away everything the two arms agree on and
 * keeps only the cases where they disagree — 8,421 questions, but a comparison whose standard error
 * is set by the 200 cases one arm got right and the other did not.
 *
 * This file is the consumer of those cases. `eval/wikisql/run.ts --cases` writes one line per judged
 * question; this file joins two such files on the question index, counts the four cells of the
 * 2×2 table, and hands the discordant pair to the same `mcnemarExact` and `pairedResolution` the
 * shipment gate uses. Nothing statistical is re-derived here: two producers of one p-value is how a
 * report ends up quoting a number the gate would not.
 *
 * ## What it refuses
 *
 * - **A duplicated index.** A case file with the same question twice would count one answer as two,
 *   and a denominator that counts one case twice is a share nobody can recompute.
 * - **Two files that do not cover the same questions.** A paired test over two denominators is an
 *   unpaired test wearing the word — unless the caller says `--intersect`, in which case the
 *   comparison is over the intersection *and the two dropped counts are printed*. The default
 *   refuses, because the interesting mistake is a challenger run at `--limit 400` against a baseline
 *   of 8,421, and the interesting fix is to say so out loud once.
 * - **A verdict it cannot read.** `ordered` decides the accuracy, `bag` is reported beside it; a
 *   line without `index` or `ordered` is a parse error rather than a wrong answer.
 *
 *   tsx eval/wikisql/paired.ts --first cases-a.jsonl --second cases-b.jsonl
 *   tsx eval/wikisql/paired.ts --first a.jsonl --second b.jsonl --intersect   # a subset run
 */
import { readFileSync } from 'node:fs';
import { mcnemarExact, pairedResolution } from '@agentix-e/nl2charts-devkit';
import { isEntry } from '../entry.js';

/** One judged case, as `run.ts --cases` writes it. */
export interface CaseVerdict {
  readonly index: number;
  /** The reference's comparison: same rows, same order. The leaderboard's accuracy. */
  readonly ordered: boolean;
  /** The same rows as a multiset: `ordered` false with `bag` true is the judging artefact. */
  readonly bag: boolean;
  /** Whether the statement ran at all. A crash is a different failure from a wrong answer. */
  readonly predOk: boolean;
}

/** What one case file holds, and what it says about itself. */
export interface CaseFile {
  readonly cases: ReadonlyMap<number, CaseVerdict>;
  /** How many lines the file had, which is not the map size when an index repeats. */
  readonly lines: number;
}

/** Read a case file, refusing a repeated index and a line that is not a verdict. */
export function parseCases(text: string, where = 'case file'): CaseFile {
  const cases = new Map<number, CaseVerdict>();
  let lines = 0;
  for (const [offset, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    lines += 1;
    const parsed = JSON.parse(line) as Partial<CaseVerdict>;
    if (typeof parsed.index !== 'number' || typeof parsed.ordered !== 'boolean') {
      throw new Error(`${where} line ${String(offset + 1)} is not a verdict: ${line.slice(0, 120)}`);
    }
    if (cases.has(parsed.index)) {
      throw new Error(`${where} line ${String(offset + 1)} repeats index ${String(parsed.index)}`);
    }
    cases.set(parsed.index, {
      index: parsed.index,
      ordered: parsed.ordered,
      bag: parsed.bag === true,
      predOk: parsed.predOk === true,
    });
  }
  return { cases, lines };
}

/** The four cells of a paired comparison, plus the denominators they came from. */
export interface Pairing {
  /** Cases compared: the intersection when `--intersect` was passed, the whole file otherwise. */
  readonly n: number;
  /** Cases each file held, which differ from `n` only under `--intersect`. */
  readonly firstCases: number;
  readonly secondCases: number;
  readonly both: number;
  /** Correct in the first arm and wrong in the second: the first arm's wins. */
  readonly onlyFirst: number;
  /** Correct in the second arm and wrong in the first: the challenger's wins. */
  readonly onlySecond: number;
  readonly neither: number;
  /** Cases the first arm's statement did not execute at all. */
  readonly firstCrashed: number;
  readonly secondCrashed: number;
}

/**
 * Join two case files.
 *
 * `intersect` is a flag rather than a default because the two states mean different things: a
 * challenger measured on the whole split and a challenger measured on a slice answer different
 * questions, and only the caller knows which one they ran. Under `--intersect` the pairing is honest
 * and *narrower*, and the dropped counts are part of the answer rather than a footnote.
 */
export function pairingOf(first: CaseFile, second: CaseFile, intersect = false): Pairing {
  const shared: number[] = [];
  for (const index of first.cases.keys()) if (second.cases.has(index)) shared.push(index);
  if (!intersect && shared.length !== first.cases.size) {
    throw new Error(
      `the second file covers ${String(second.cases.size)} of the first's ${String(first.cases.size)} cases; pass --intersect to compare the ${String(shared.length)} they share, or re-run the challenger on the whole split`,
    );
  }
  if (shared.length === 0) {
    throw new Error('the two case files share no question, so there is nothing paired to compare');
  }
  let both = 0;
  let onlyFirst = 0;
  let onlySecond = 0;
  let neither = 0;
  let firstCrashed = 0;
  let secondCrashed = 0;
  for (const index of shared) {
    const a = first.cases.get(index) as CaseVerdict;
    const b = second.cases.get(index) as CaseVerdict;
    if (!a.predOk) firstCrashed += 1;
    if (!b.predOk) secondCrashed += 1;
    if (a.ordered && b.ordered) both += 1;
    else if (a.ordered) onlyFirst += 1;
    else if (b.ordered) onlySecond += 1;
    else neither += 1;
  }
  return {
    n: shared.length,
    firstCases: first.cases.size,
    secondCases: second.cases.size,
    both,
    onlyFirst,
    onlySecond,
    neither,
    firstCrashed,
    secondCrashed,
  };
}

/** What a pairing reads as: two accuracies, the paired difference, and whether it is resolvable. */
export interface PairedReading {
  readonly pairing: Pairing;
  readonly firstPct: number;
  readonly secondPct: number;
  /** The paired difference in percentage points, positive when the second arm is better. */
  readonly deltaPp: number;
  readonly lowPp: number;
  readonly highPp: number;
  readonly p: number;
  readonly discordantShare: number;
  /** The smallest difference this many cases could have detected at 80% power, in points. */
  readonly mdePp: number;
  /** Whether the interval excludes zero. The one line a reader may quote without the table. */
  readonly resolves: boolean;
}

/** Derive the reading. The statistics come from the gate's own producers, not from here. */
export function readingOfPairing(pairing: Pairing): PairedReading {
  const { n } = pairing;
  const first = pairing.both + pairing.onlyFirst;
  const second = pairing.both + pairing.onlySecond;
  const resolution = pairedResolution(pairing.onlyFirst, pairing.onlySecond, n);
  const p = mcnemarExact(pairing.onlyFirst, pairing.onlySecond);
  return {
    pairing,
    firstPct: (100 * first) / n,
    secondPct: (100 * second) / n,
    deltaPp: 100 * resolution.delta,
    lowPp: 100 * resolution.low,
    highPp: 100 * resolution.high,
    p,
    discordantShare: resolution.discordantShare,
    mdePp: 100 * resolution.mde,
    resolves: resolution.low > 0 || resolution.high < 0,
  };
}

/** The report, as lines. Every number on them is recomputable from the four cells above it. */
export function pairedLines(reading: PairedReading, labels: { readonly first: string; readonly second: string }): readonly string[] {
  const { pairing } = reading;
  const lines = [
    `wikisql paired: ${labels.first} vs ${labels.second}`,
    `  cases    ${String(pairing.n)} paired${pairing.n === pairing.firstCases && pairing.n === pairing.secondCases ? '' : ` (of ${String(pairing.firstCases)} and ${String(pairing.secondCases)})`}`,
    `  first    ${String(pairing.both + pairing.onlyFirst)} / ${String(pairing.n)} = ${reading.firstPct.toFixed(2)}%`,
    `  second   ${String(pairing.both + pairing.onlySecond)} / ${String(pairing.n)} = ${reading.secondPct.toFixed(2)}%`,
    `  delta    ${reading.deltaPp >= 0 ? '+' : ''}${reading.deltaPp.toFixed(2)}pp (95% ${reading.lowPp.toFixed(2)} … ${reading.highPp.toFixed(2)})`,
    `  table    both ${String(pairing.both)}, only first ${String(pairing.onlyFirst)}, only second ${String(pairing.onlySecond)}, neither ${String(pairing.neither)}`,
    `  mcnemar  p = ${reading.p.toFixed(4)} over ${String(pairing.onlyFirst + pairing.onlySecond)} discordant case(s) (${(100 * reading.discordantShare).toFixed(2)}%)`,
    `  power    smallest detectable difference ${reading.mdePp.toFixed(2)}pp at 80%`,
    `  crashed  ${String(pairing.firstCrashed)} first, ${String(pairing.secondCrashed)} second`,
  ];
  lines.push(
    reading.resolves
      ? `  verdict  the interval excludes zero: the ${reading.deltaPp >= 0 ? 'second' : 'first'} arm is ahead by ${Math.abs(reading.deltaPp).toFixed(2)}pp`
      : `  verdict  the interval holds zero: this design cannot separate the two arms at ${reading.mdePp.toFixed(2)}pp`,
  );
  return lines;
}

/** Flags this file reads. */
export interface Settings {
  readonly first: string | undefined;
  readonly second: string | undefined;
  readonly intersect: boolean;
}

export function resolveSettings(argv: readonly string[]): Settings {
  let first: string | undefined;
  let second: string | undefined;
  let intersect = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    const value = argv[index + 1];
    if (flag === '--first') {
      if (value === undefined) throw new Error('--first needs a path');
      first = value;
      index += 1;
    } else if (flag === '--second') {
      if (value === undefined) throw new Error('--second needs a path');
      second = value;
      index += 1;
    } else if (flag === '--intersect') {
      intersect = true;
    } else if (flag.startsWith('--')) {
      throw new Error(`unknown flag ${flag}`);
    } else {
      throw new Error(`unexpected argument ${flag}`);
    }
  }
  return { first, second, intersect };
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  log: (line: string) => void = console.log,
): number {
  const settings = resolveSettings(argv);
  if (settings.first === undefined || settings.second === undefined) {
    log('wikisql paired: --first and --second are both required (two `run.ts --cases` files)');
    return 2;
  }
  const first = parseCases(readFileSync(settings.first, 'utf8'), settings.first);
  const second = parseCases(readFileSync(settings.second, 'utf8'), settings.second);
  let pairing: Pairing;
  try {
    pairing = pairingOf(first, second, settings.intersect);
  } catch (error) {
    // A refusal that names the counts is one the caller can act on; a stack trace is one they have
    // to re-read the source to understand.
    log(`REFUSED: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  for (const line of pairedLines(readingOfPairing(pairing), { first: settings.first, second: settings.second })) {
    log(line);
  }
  return 0;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
