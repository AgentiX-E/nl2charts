/**
 * Why the recommender did not answer the mark the corpus labels.
 *
 * `profile.ts` says how often the product's entry point is right with the result set in front of it
 * (15.71% on Text2Vis, against a cue table that reads 37.35% on its own). A number that low is a
 * symptom, and the mechanisms that can produce it need different repairs: an admission rule can
 * refuse the mark the label asks for, the ranking can admit that mark and lose, and the family itself
 * may be one no mark in this product covers. This file separates them, and it costs nothing to run —
 * no model, no database, no renderer, just the corpus's own tables and the profiles the product
 * derives from them.
 *
 * **The five outcomes are exhaustive by construction, not by inspection.** A scored row is a hit, a
 * refusal (every mark that could cover the family was ruled out), a loss (a covering mark was
 * admitted and ranked below something else), a family no mark can cover, or a table that would not
 * profile. The counters are asserted to sum to the scored population, the same discipline `rule.ts`
 * and `profile.ts` apply, for the same reason: a share taken over the wrong denominator is the defect
 * a reader cannot see.
 *
 * **What a refusal means.** The instrument reports the admission rule's own sentence, not a
 * paraphrase, because the sentence names the missing fact ("a line needs an ordered axis and a
 * measure"). A refusal is not automatically a product defect: a corpus can label a line over a table
 * with no time column, and the product is right to refuse it. What decides the repair is the
 * `timeLike` census printed beside the refusals — if the tables that refused `line` carry a column of
 * years or quarters that the profiler typed as a measure, the defect is in type inference; if they
 * carry nothing that reads as time, the label asks for a picture the result set cannot witness.
 */
import type { FieldProfile, RecommendableMark } from '@agentix-e/nl2charts-chart';
import { readCues, recommendChart } from '@agentix-e/nl2charts-chart';
import { applyExitCode, isEntry, loadText2Vis, type LoadOptions } from './dataset.js';
import { familiesOfMark, familyOfLabel, type ChartFamily } from './rule.js';
import { parseResultSet, profilesOf, type ProfileInput, type ResultSet } from './profile.js';

/**
 * Every mark this product can recommend, in the order its type declares them.
 *
 * A local copy is unavoidable without exporting the list from the package, and it is checked rather
 * than trusted: `text2vis-census.test.ts` asserts it is the same set the recommender admits, so a
 * mark added to the product without being added here fails a test instead of going uncounted.
 */
const MARKS: readonly RecommendableMark[] = [
  'bar',
  'line',
  'pie',
  'funnel',
  'scatter',
  'heatmap',
  'boxplot',
  'candlestick',
  'radar',
  'parallel',
  'gauge',
];

/**
 * The marks that could have answered a family, derived from `familiesOfMark` rather than restated.
 *
 * A second table here would be a second opinion about which mark covers `area` (a line, because an
 * area chart is that line filled) and about `histogram` (a bar, but only when the leading cue is
 * `histogram`). Both widenings already live in the product, so they are asked for rather than copied:
 * `familiesOfMark(mark, 'histogram')` is the widest answer a mark can give, and a family nobody
 * answers for — `violin` — comes back empty, which is what makes it its own outcome.
 */
export function coveringMarks(family: ChartFamily): readonly RecommendableMark[] {
  return MARKS.filter(
    (mark) => familiesOfMark(mark).includes(family) || familiesOfMark(mark, 'histogram').includes(family),
  );
}

/** What became of one scored question. */
export type CensusOutcome = 'hit' | 'refused' | 'outranked' | 'uncovered' | 'noProfile';

/**
 * One scored question, classified, with the facts the classification was made from.
 *
 * A discriminated union rather than one shape with optional fields: a loss always has a winner and
 * two scores, a refusal has a sentence, and a hit has neither. Writing the three apart means the
 * tally cannot read a field the outcome does not carry, which is how the first draft could subtract
 * an absent score and call the gap zero.
 */
export type CensusRow =
  | { readonly expected: ChartFamily; readonly outcome: 'hit' | 'uncovered' | 'noProfile' }
  | {
      readonly expected: ChartFamily;
      readonly outcome: 'refused';
      /** The mark that could have covered the family and was ruled out. */
      readonly covering: RecommendableMark;
      /** The admission rule's own sentence, quoted rather than paraphrased. */
      readonly reason: string;
      /** What the product drew instead, when it drew anything: `profile.ts` counts that as a miss. */
      readonly answered?: RecommendableMark;
    }
  | {
      readonly expected: ChartFamily;
      readonly outcome: 'outranked';
      /** The mark that could have covered the family and lost the ranking. */
      readonly covering: RecommendableMark;
      readonly answered: RecommendableMark;
      readonly coveringScore: number;
      readonly answeredScore: number;
      /** Where the question's first cue placed each mark, when a cue named it at all. */
      readonly coveringCue?: number;
      readonly answeredCue?: number;
    };

/** A table column that formats as time while the profiler typed it as something else. */
export interface TimeLike {
  readonly column: string;
  /** The type the profiler gave it. */
  readonly typed: string;
  /** One value, so a reader can see what was recognised. */
  readonly sample: string;
  /** Rows whose table carries this column. */
  readonly n: number;
}

export interface FamilyCensus {
  readonly family: ChartFamily;
  readonly n: number;
  readonly hit: number;
  readonly refused: number;
  readonly outranked: number;
  readonly uncovered: number;
  readonly noProfile: number;
}

export interface OutrankedCensus {
  readonly expected: ChartFamily;
  readonly winner: RecommendableMark;
  readonly n: number;
  /** The covering mark was named by a cue and lost anyway: naming the right mark was not enough. */
  readonly namedButLost: number;
  /** Both marks scored the same, so `PREFERENCE` decided the row and no fact did. */
  readonly onPreference: number;
  /** The score gap, most common first. */
  readonly gaps: readonly { readonly gap: number; readonly n: number }[];
}

export interface RefusalCensus {
  readonly mark: RecommendableMark;
  readonly expected: ChartFamily;
  readonly reason: string;
  readonly n: number;
  /**
   * How many of those rows were answered by some other mark anyway.
   *
   * The difference the other instrument already publishes: a refused row with a fallback is a
   * _miss_ in `profile.ts` (a mark that cannot cover the label was drawn), and a refused row without
   * one is a _decline_. Two repairs — an admission rule, and a product that has nothing to say —
   * and the sentence above cannot separate them, so the count travels with it.
   */
  readonly withFallback: number;
}

export interface CensusReport {
  readonly rows: number;
  readonly unmapped: number;
  readonly scored: number;
  readonly outcomes: Readonly<Record<CensusOutcome, number>>;
  readonly byFamily: readonly FamilyCensus[];
  readonly refusals: readonly RefusalCensus[];
  readonly outranked: readonly OutrankedCensus[];
  /** Columns that format as time and were not typed temporal, most rows first. */
  readonly timeLike: readonly TimeLike[];
  /** Rows whose table carries at least one such column. */
  readonly timeLikeRows: number;
  readonly variant: string;
}

/** A year, a quarter, a month name, or a year-and-month — the shapes a result set writes time in. */
const TIME_CELLS: readonly RegExp[] = [
  /^(?:19|20)\d{2}$/,
  /^(?:19|20)\d{2}[-/]\d{1,2}(?:[-/]\d{1,2})?$/,
  /^(?:19|20)\d{2}[-/]?q[1-4]$/i,
  /^q[1-4](?:\s*(?:19|20)\d{2})?$/i,
  /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(?:19|20)\d{2})?$/i,
];

/**
 * Columns a person reads as a date and the profiler did not.
 *
 * Read from the cells rather than from the profile, because the question is what the profiler made
 * of a column that formats as time. Numbers are stringified first so `2019` and `"2019"` are the same
 * evidence; a column with fewer than two distinct values is not a timeline and is skipped, since a
 * table whose whole period is one year has no axis to order.
 */
export function timeLikeColumns(set: ResultSet, profiles: readonly FieldProfile[]): TimeLike[] {
  const found: TimeLike[] = [];
  // A column with no profile is `nominal`, which is the answer `inferType` gives an empty column:
  // the fallback is the profiler's own default rather than a guess about a column it did not see.
  const types = new Map(profiles.map((profile) => [profile.name, profile.type]));
  for (const [index, name] of set.columns.entries()) {
    const cells = set.rows.map((row) => (row[index] as string).trim()).filter((cell) => cell.length > 0);
    if (cells.length < 2 || new Set(cells).size < 2) continue;
    if (!cells.every((cell) => TIME_CELLS.some((pattern) => pattern.test(cell)))) continue;
    const typed = types.get(name) ?? 'nominal';
    if (typed === 'temporal') continue;
    found.push({ column: name, typed, sample: cells[0] as string, n: 1 });
  }
  return found;
}

/**
 * Classify one question.
 *
 * The hit test is `profileAnswer`'s, deliberately: a mark covers a family through `familiesOfMark`,
 * widened by the leading cue so a bar named by a histogram question answers for a histogram. A
 * different test here would make the two instruments disagree about the same row, and the census
 * would then be explaining a count nobody published — `text2vis-census.test.ts` asserts the two
 * agree row for row.
 */
export function classify(row: ProfileInput): CensusRow {
  const expected = familyOfLabel(row.label);
  if (expected === undefined) {
    throw new Error(`census: ${row.label} has no family, and an unmapped label is excluded before it is classified`);
  }
  const set = parseResultSet(row.tableData);
  const profiles = profilesOf(set);
  if (profiles.length === 0) return { expected, outcome: 'noProfile' };
  const covering = coveringMarks(expected);
  if (covering.length === 0) return { expected, outcome: 'uncovered' };
  const choice = recommendChart(row.prompt, profiles);
  const top = choice.recommendations[0];
  if (top !== undefined && familiesOfMark(top.mark, top.cues[0]).includes(expected)) {
    return { expected, outcome: 'hit' };
  }
  const admitted = choice.recommendations.filter((entry) => covering.includes(entry.mark));
  if (admitted.length === 0) {
    // Every mark that could have covered the family was ruled out. The sentence belongs to the
    // first such mark in the order `coveringMarks` lists them, so the same row always reports the
    // same reason rather than whichever mark happened to be considered last.
    const coveringMark = covering[0] as RecommendableMark;
    const sentence = choice.refused.find((entry) => entry.mark === coveringMark);
    return {
      expected,
      outcome: 'refused',
      covering: coveringMark,
      // A mark is either recommended or refused, so a covering mark that is not recommended has a
      // refusal, and `admitted.length === 0` says it is not recommended.
      reason: sentence === undefined ? 'profile:refused' : sentence.reason,
      ...(top === undefined ? {} : { answered: top.mark }),
    };
  }
  const coveringEntry = admitted[0] as (typeof admitted)[number];
  const winner = top as (typeof admitted)[number];
  // The cue that placed each mark, read from the question rather than from the recommendation's
  // reasons: a recommendation lists the cue *kinds* that named it and not where it stood among the
  // marks that cue speaks for, and the position is what three-of-two is paid on.
  const cues = readCues(row.prompt);
  const placeOf = (mark: RecommendableMark): number | undefined => {
    const cue = cues.find((entry) => entry.marks.includes(mark));
    return cue === undefined ? undefined : cue.marks.indexOf(mark);
  };
  const coveringCue = placeOf(coveringEntry.mark);
  const answeredCue = placeOf(winner.mark);
  return {
    expected,
    outcome: 'outranked',
    covering: coveringEntry.mark,
    answered: winner.mark,
    coveringScore: coveringEntry.score,
    answeredScore: winner.score,
    ...(coveringCue === undefined ? {} : { coveringCue }),
    ...(answeredCue === undefined ? {} : { answeredCue }),
  };
}

/**
 * The accumulators, mutable.
 *
 * The published shapes are `readonly` because a reader must not be able to edit a count, and a tally
 * has to add to one, so the two are written separately rather than by casting a `readonly` away at
 * every increment.
 */
interface FamilyTally {
  family: ChartFamily;
  n: number;
  hit: number;
  refused: number;
  outranked: number;
  uncovered: number;
  noProfile: number;
}

interface RefusalTally {
  mark: RecommendableMark;
  expected: ChartFamily;
  reason: string;
  n: number;
  withFallback: number;
}

interface TimeLikeTally {
  column: string;
  typed: string;
  sample: string;
  n: number;
}

/** Tally a classified population into the report a document quotes. */
export function censusOf(rows: readonly ProfileInput[], options: { readonly variant?: string } = {}): CensusReport {
  const outcomes: Record<CensusOutcome, number> = { hit: 0, refused: 0, outranked: 0, uncovered: 0, noProfile: 0 };
  const byFamily = new Map<ChartFamily, FamilyTally>();
  const refusals = new Map<string, RefusalTally>();
  const outranked = new Map<
    string,
    {
      expected: ChartFamily;
      winner: RecommendableMark;
      n: number;
      namedButLost: number;
      onPreference: number;
      gaps: Map<number, number>;
    }
  >();
  const timeLike = new Map<string, TimeLikeTally>();
  let scored = 0;
  let unmapped = 0;
  let timeLikeRows = 0;

  for (const row of rows) {
    if (familyOfLabel(row.label) === undefined) {
      unmapped += 1;
      continue;
    }
    const classified = classify(row);
    scored += 1;
    outcomes[classified.outcome] += 1;
    const family = byFamily.get(classified.expected) ?? {
      family: classified.expected,
      n: 0,
      hit: 0,
      refused: 0,
      outranked: 0,
      uncovered: 0,
      noProfile: 0,
    };
    family.n += 1;
    family[classified.outcome] += 1;
    byFamily.set(classified.expected, family);

    if (classified.outcome === 'refused' && classified.reason !== undefined && classified.covering !== undefined) {
      const key = `${classified.covering}\u0000${classified.reason}`;
      const entry = refusals.get(key) ?? {
        mark: classified.covering,
        expected: classified.expected,
        reason: classified.reason,
        n: 0,
        withFallback: 0,
      };
      entry.n += 1;
      if (classified.answered !== undefined) entry.withFallback += 1;
      refusals.set(key, entry);
    }

    if (classified.outcome === 'outranked') {
      const winner = classified.answered;
      const key = `${classified.expected}\u0000${winner}`;
      const entry = outranked.get(key) ?? {
        expected: classified.expected,
        winner,
        n: 0,
        namedButLost: 0,
        onPreference: 0,
        gaps: new Map<number, number>(),
      };
      entry.n += 1;
      if (classified.coveringCue !== undefined) entry.namedButLost += 1;
      const gap = classified.answeredScore - classified.coveringScore;
      if (gap === 0) entry.onPreference += 1;
      entry.gaps.set(gap, (entry.gaps.get(gap) ?? 0) + 1);
      outranked.set(key, entry);
    }

    const set = parseResultSet(row.tableData);
    const profiles = profilesOf(set);
    if (profiles.length > 0) {
      const mistyped = timeLikeColumns(set, profiles);
      if (mistyped.length > 0) timeLikeRows += 1;
      for (const column of mistyped) {
        const entry = timeLike.get(column.column) ?? { ...column, n: 0 };
        entry.n += 1;
        timeLike.set(column.column, entry);
      }
    }
  }

  return {
    rows: rows.length,
    unmapped,
    scored,
    outcomes,
    byFamily: [...byFamily.values()].sort(
      (left, right) => right.n - left.n || left.family.localeCompare(right.family),
    ),
    refusals: [...refusals.values()].sort(
      (left, right) => right.n - left.n || left.reason.localeCompare(right.reason),
    ),
    outranked: [...outranked.values()]
      .map((entry) => ({
        expected: entry.expected,
        winner: entry.winner,
        n: entry.n,
        namedButLost: entry.namedButLost,
        onPreference: entry.onPreference,
        gaps: [...entry.gaps.entries()]
          .map(([gap, n]) => ({ gap, n }))
          .sort((left, right) => right.n - left.n || left.gap - right.gap),
      }))
      .sort(
        (left, right) =>
          right.n - left.n ||
          left.expected.localeCompare(right.expected) ||
          String(left.winner).localeCompare(String(right.winner)),
      ),
    timeLike: [...timeLike.values()].sort(
      (left, right) => right.n - left.n || left.column.localeCompare(right.column),
    ),
    timeLikeRows,
    variant: options.variant ?? 'census',
  };
}

/**
 * The arithmetic a report can be wrong about, refused rather than published.
 *
 * Every scored row lands in exactly one of the five outcomes, and the per-family rows sum to the
 * scored population. A report that breaks either is a share computed on the wrong denominator.
 */
export function assertCensusReport(report: CensusReport): void {
  const sum = Object.values(report.outcomes).reduce((total, count) => total + count, 0);
  if (sum !== report.scored) {
    throw new Error(
      `census report: the five outcomes sum to ${String(sum)} and ${String(report.scored)} rows were scored`,
    );
  }
  const perFamily = report.byFamily.reduce((total, entry) => total + entry.n, 0);
  if (perFamily !== report.scored) {
    throw new Error(
      `census report: the per-family rows sum to ${String(perFamily)} and ${String(report.scored)} rows were scored`,
    );
  }
  if (report.scored + report.unmapped !== report.rows) {
    throw new Error(
      `census report: ${String(report.scored)} scored + ${String(report.unmapped)} unmapped is not the ${String(report.rows)} rows read`,
    );
  }
}

/**
 * The lines a reader needs: what each outcome took, the sentences behind the refusals, the arithmetic
 * behind the losses, and the columns that should have been a time axis.
 *
 * Printed in that order because that is the order of the repairs: a refusal is answered by an
 * admission rule, a loss by a ranking, and a mistyped column by type inference. A document that
 * carried only the first would send the next round at the wrong file.
 */
export function describeCensus(report: CensusReport): readonly string[] {
  const share = (count: number): string => `${((count / Math.max(1, report.scored)) * 100).toFixed(2)}%`;
  const outcome = report.outcomes;
  const lines = [
    `text2vis census: ${String(report.scored)} scored of ${String(report.rows)} rows (${String(report.unmapped)} unmapped labels)`,
    `  hit ${String(outcome.hit)} (${share(outcome.hit)}), refused ${String(outcome.refused)} (${share(outcome.refused)}), outranked ${String(outcome.outranked)} (${share(outcome.outranked)}), uncovered ${String(outcome.uncovered)}, no profile ${String(outcome.noProfile)}`,
    `  time-formatted columns the profiler did not call temporal: ${String(report.timeLikeRows)} rows`,
  ];
  for (const column of report.timeLike.slice(0, 6)) {
    lines.push(`    ${column.column} (${column.typed}, ${String(column.n)} rows, first value ${column.sample})`);
  }
  for (const entry of report.refusals.slice(0, 6)) {
    lines.push(
      `  refused ${entry.mark} for ${entry.expected}: ${String(entry.n)} (${String(entry.withFallback)} answered by another mark) — ${entry.reason}`,
    );
  }
  for (const entry of report.outranked.slice(0, 8)) {
    const gaps = entry.gaps.map((gap) => `${gap.gap > 0 ? '+' : ''}${String(gap.gap)}×${String(gap.n)}`).join(' ');
    lines.push(
      `  lost ${entry.expected} to ${entry.winner}: ${String(entry.n)} (on preference ${String(entry.onPreference)}, cue named and lost ${String(entry.namedButLost)}, gaps ${gaps})`,
    );
  }
  return lines;
}

/** The flags this command takes, and nothing else. */
export interface CensusArgs {
  readonly artifact?: string;
  readonly json: boolean;
}

/** Parse the command line, refusing anything it does not use — the reason `parseRuleArgs` gives. */
export function parseCensusArgs(argv: readonly string[]): CensusArgs {
  let artifact: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--artifact') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--artifact needs a path');
      artifact = value;
      index += 1;
      continue;
    }
    throw new Error(
      `unknown argument ${flag}: this command classifies why the recommender missed, and takes --json and --artifact <path>`,
    );
  }
  return { json, ...(artifact === undefined ? {} : { artifact }) };
}

/** The corpus, as the rows this reading classifies. */
export function censusInputs(corpus: { readonly rows: readonly { readonly prompt: string; readonly chartType: string; readonly raw: Readonly<Record<string, string>> }[] }): ProfileInput[] {
  return corpus.rows.map((row) => ({ prompt: row.prompt, label: row.chartType, tableData: row.raw['Table Data'] ?? '' }));
}

/**
 * Classify the corpus and publish the census.
 *
 * The artifact is written atomically through a `.part` file for the reason every other instrument
 * does: a job that dies mid-write must leave the previous artifact readable, not half of a new one.
 */
export async function entryCensus(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  options: { readonly argv?: readonly string[]; readonly load?: LoadOptions } = {},
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  try {
    const args = parseCensusArgs(options.argv ?? []);
    const { corpus, source, path } = await loadText2Vis(options.load);
    log(`text2vis: ${source} ${path}`);
    const report = censusOf(censusInputs(corpus));
    assertCensusReport(report);
    if (args.json) {
      log(JSON.stringify(report, null, 2));
    } else {
      for (const line of describeCensus(report)) log(line);
    }
    if (args.artifact !== undefined) {
      const { mkdir, writeFile, rename } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(args.artifact), { recursive: true });
      await writeFile(`${args.artifact}.part`, `${JSON.stringify(report, null, 2)}\n`);
      await rename(`${args.artifact}.part`, args.artifact);
      log(`text2vis: wrote ${args.artifact}`);
    }
    return report.scored === 0 ? 1 : 0;
  } catch (error) {
    log(`text2vis: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

void entryCensus(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`), {
  argv: process.argv.slice(2),
}).then((code) => applyExitCode(code, process));
