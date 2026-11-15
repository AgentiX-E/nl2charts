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
 * **The outcomes are exhaustive by construction, not by inspection.** A scored row is a hit, a
 * refusal (every mark that could cover the family was ruled out), a loss (a covering mark was
 * admitted and ranked below something else), a substitution (the winner covers the family as its
 * *second* claim — a line answering an `area` row), a family no mark can cover, or a table that would
 * not profile. The counters are asserted to sum to the scored population, the same discipline
 * `rule.ts` and `profile.ts` apply, for the same reason: a share taken over the wrong denominator is
 * the defect a reader cannot see.
 *
 * **A hit is the published first choice, not the shortlist.** The census exists to explain the number
 * the product publishes — `profile.ts`'s top-1 — so its hit test has to be that test and not a wider
 * one. Counting a mark that covers the family second would have made the census read 263 where the
 * product reads 262, and a census one row ahead of the product is explaining a corpus nobody
 * published. The widening is not discarded: it is the `substituted` outcome, so the two readings
 * reconcile as `hit + substituted === shortlist`.
 *
 * **What a refusal means.** The instrument reports the admission rule's own sentence, not a
 * paraphrase, because the sentence names the missing fact ("a line needs an ordered axis and a
 * measure"). A refusal is not automatically a product defect: a corpus can label a line over a table
 * with no time column, and the product is right to refuse it. What decides the repair is the
 * `timeLike` census printed beside the refusals — if the tables that refused `line` carry a column of
 * years or quarters that the profiler typed as a measure, the defect is in type inference; if they
 * carry nothing that reads as time, the label asks for a picture the result set cannot witness.
 */
import type {
  ChartChoice,
  Cue,
  CueKind,
  FieldProfile,
  Recommendation,
  RecommendableMark,
  ShapeCounts,
} from '@agentix-e/nl2charts-chart';
import { RECOMMENDABLE_MARKS, readCues, recommendChart } from '@agentix-e/nl2charts-chart';
import { applyExitCode, isEntry, loadText2Vis, type LoadOptions } from './dataset.js';
import { familiesOfMark, familyOfLabel, type ChartFamily } from './rule.js';
import { numericCell, parseResultSet, profilesOf, type ProfileInput, type ResultSet } from './profile.js';

/**
 * The marks that could have answered a family, derived from `familiesOfMark` rather than restated.
 *
 * A second table here would be a second opinion about which mark covers `area` (a line, because an
 * area chart is that line filled), so it is asked for instead of copied. `familiesOfMark` with no cue
 * is the conservative table — what a mark *is*, before any question names anything — and a family no
 * mark is comes back empty, which is what makes it its own outcome.
 *
 * **The cue-conditional widening is deliberately not applied here.** `bar` answers for `histogram`
 * only when a histogram cue named it, and that is a fact about a row, not about the table. Asking the
 * widest question of every row made 43 histogram rows read as `lost histogram to bar` with `bar` as
 * both the covering mark and the winner: a loss to itself, which no ranking can produce and no lever
 * can repair. With the widening left to the row, those rows are `substituted` when the cue fired and
 * `uncovered` when it did not — and `outranked` holds losses again.
 */
export function coveringMarks(family: ChartFamily): readonly RecommendableMark[] {
  return RECOMMENDABLE_MARKS.filter((mark) => familiesOfMark(mark).includes(family));
}

/** How much of a prompt a sample keeps. Enough for a question, short enough for a log line. */
const SNIPPET = 160;

/**
 * The output-format spec every Text2Vis prompt ends with, and the code instruction that introduces
 * it: `… Python code using **matplotlib only** to visualize the result. Return your response strictly
 * in the following JSON format **without any extra explanation**: {"answer": …`.
 *
 * Cutting only at `{"answer"` was not enough. The tail of the surviving text is this sentence, which
 * is longer than a question, so the first two cuts both printed boilerplate — first the instruction
 * block at the front, then the schema instruction at the back. A sample is evidence; one that shows
 * what every row shares is evidence about nothing.
 */
const ANSWER_SPEC = /\{?\s*"answer"\s*:/;
const CODE_INSTRUCTION = /\b(?:Write|Give me|Generate|Provide|Create)\s+Python code\b/i;

/**
 * A prompt cut to the part that decides: the question.
 *
 * The corpus wraps each prompt as instruction block, question, output-format spec, and only the
 * middle part distinguishes one row from another. Three steps, each one visible in the file: cut the
 * spec off the end, then prefer the last sentence that ends with `?` — every question in this corpus
 * is one, and a sample that keeps the question is worth three that keep the instructions — and fall
 * back to cutting the code instruction, then to the tail.
 *
 * Nothing is rephrased: the sample is the corpus's own words, minus the parts every row repeats.
 */
export function snippet(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const spec = ANSWER_SPEC.exec(collapsed);
  const body = (spec === null ? collapsed : collapsed.slice(0, spec.index)).trim();
  const asked = /[^.!?:]+?\?/g;
  const questions = body.match(asked);
  const last = questions === null ? undefined : (questions[questions.length - 1] as string).trim();
  if (last !== undefined) return last.length <= SNIPPET ? last : `…${last.slice(last.length - SNIPPET)}`;
  const instruction = CODE_INSTRUCTION.exec(body);
  const trimmed = (instruction === null ? body : body.slice(0, instruction.index)).trim();
  if (trimmed.length <= SNIPPET) return trimmed;
  return `…${trimmed.slice(trimmed.length - SNIPPET)}`;
}

/**
 * Why a table produced no profile.
 *
 * `profilesOf` answers with an empty list for three different corpora, and the repair differs by
 * which one it is: a row with no `Table Data` cell at all is a gap in the benchmark (nothing to fix
 * in the product, and the 1,470-row denominator is the honest one), a header with no record below it
 * is a table the corpus truncated, and a line of prose in the cell is a table written in another
 * format that this parser does not read. One count of 164 says none of that.
 */
export type TableDefect = 'empty' | 'not-tabular' | 'header-only';

/**
 * The defect of a table that did not profile. Total over its domain, and only over it.
 *
 * The precondition is checked rather than assumed: a table that *does* profile is a caller defect,
 * and answering "header-only" for it would be the instrument inventing a fact about a table it did
 * not examine. The domain is the `noProfile` bucket, which is exactly the rows `profilesOf` refused.
 */
export function noProfileReason(text: string, set: ResultSet): TableDefect {
  if (set.columns.length > 0 && set.rows.length > 0) {
    throw new Error('noProfileReason: this table profiles, so it has no defect to name');
  }
  const body = text.trim();
  if (body === '') return 'empty';
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  // A separated first line is a header; a line with no separator in it is not a header of anything.
  return /[,;\t|]/.test(lines[0] as string) ? 'header-only' : 'not-tabular';
}

/** What became of one scored question. */
export type CensusOutcome = 'hit' | 'substituted' | 'refused' | 'outranked' | 'uncovered' | 'noProfile';

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
      readonly outcome: 'substituted';
      /**
       * The mark the product drew. It covers the label's family through its *second* family claim —
       * a line is a line and, filled, an area — so `profile.ts` counts the row in its shortlist and
       * not in its top-1, and the census has to make the same distinction or the two disagree about
       * one row out of 1,470.
       */
      readonly answered: RecommendableMark;
      /** The family the mark answered as, which is the one the label did not ask for. */
      readonly ownFamily: ChartFamily;
    }
  | {
      readonly expected: ChartFamily;
      readonly outcome: 'refused';
      /** The mark that could have covered the family and was ruled out. */
      readonly covering: RecommendableMark;
      /** The admission rule's own sentence, quoted rather than paraphrased. */
      readonly reason: string;
      /** What the product drew instead, when it drew anything: `profile.ts` counts that as a miss. */
      readonly answered?: RecommendableMark;
      /** The counts the admission rule was applied to, reported by the product rather than re-derived. */
      readonly shape: ShapeCounts;
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
      /**
       * The cues that paid each score, in table order.
       *
       * The gap says who won; the cue lists say why. A bar that collected four cues beating a line
       * that collected one is a scoring property — every cue the question fires pays the bar
       * something — while a bar that beat a line on equal cues is the tie-break, and neither is
       * repaired in the same place. Without this the report can only say "lost by 2".
       */
      readonly coveringCues: readonly CueKind[];
      readonly answeredCues: readonly CueKind[];
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

/**
 * A column whose cells are numbers only after the result set's formatting is read.
 *
 * Counted with `numericCell` — the same function the reading uses — against what `Number` alone
 * accepts, so the count says exactly which columns the coercion rescues rather than how many columns
 * look numeric to a person. On Text2Vis these columns were typed `nominal`, which left the table with
 * no measure at all and refused every mark that needs one.
 */
export interface CoercedColumn {
  readonly column: string;
  /** One cell that needed the coercion, so a reader can see the format that caused it. */
  readonly sample: string;
  readonly n: number;
}

export function coercedColumns(set: ResultSet): CoercedColumn[] {
  const found: CoercedColumn[] = [];
  for (const [index, name] of set.columns.entries()) {
    const cells = set.rows.map((row) => (row[index] as string).trim()).filter((cell) => cell.length > 0);
    const coerced = cells.filter((cell) => numericCell(cell) !== undefined && !Number.isFinite(Number(cell)));
    if (coerced.length === 0) continue;
    found.push({ column: name, sample: coerced[0] as string, n: 1 });
  }
  return found;
}

/**
 * A cell that is made of digits and punctuation, and that `numericCell` still refuses.
 *
 * The other half of the same question. `coercedColumns` names the columns a *format* rescued;
 * this names the cells nothing rescued, on tables that ended up with no measure at all — and those
 * tables refuse every mark that needs one, which is the largest single shape in the refusal table.
 * A cell with a letter in it is a label and is skipped; a cell with a digit and no letter is a number
 * the reader declined, and the string is the evidence: `−0.04` with a typographic minus, `1 234` with
 * a space, `0.04 °C` with a unit. Three formats, three repairs, and one count of 389 could not tell
 * them apart.
 */
export interface UnreadNumeral {
  readonly column: string;
  /** The cell as the corpus wrote it, which is the whole evidence. */
  readonly cell: string;
  readonly n: number;
}

export function unreadNumerals(set: ResultSet): UnreadNumeral[] {
  const found: UnreadNumeral[] = [];
  for (const [index, name] of set.columns.entries()) {
    const cells = set.rows.map((row) => (row[index] as string).trim()).filter((cell) => cell.length > 0);
    const offender = cells.find(
      (cell) => /\d/.test(cell) && !/\p{L}/u.test(cell) && numericCell(cell) === undefined,
    );
    if (offender === undefined) continue;
    found.push({ column: name, cell: offender, n: 1 });
  }
  return found;
}

export interface FamilyCensus {
  readonly family: ChartFamily;
  readonly n: number;
  readonly hit: number;
  readonly substituted: number;
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
  /**
   * Up to three of these losses, with both sides' arithmetic.
   *
   * The same argument as `shapes[].samples`: a pair of marks losing 199 times is one row in a table
   * and 199 different questions on the corpus. Whether they ask for the losing mark ("a line chart
   * of revenue over time") or merely arrive with a table the winner fits better decides whether the
   * next change is a cue or a weight, and only the words separate them.
   */
  readonly samples: readonly LossSample[];
}

/** One loss, with the facts that produced the score on both sides. */
export interface LossSample {
  readonly prompt: string;
  readonly covering: RecommendableMark;
  readonly answered: RecommendableMark;
  readonly coveringScore: number;
  readonly answeredScore: number;
  /** The cues that paid the mark the label asked for. */
  readonly coveringCues: readonly CueKind[];
  /** The cues that paid the mark that won. */
  readonly answeredCues: readonly CueKind[];
}

/**
 * A refusal, grouped by the shape it was refused against.
 *
 * The count that decides a repair. "454 rows were refused a line for an area label" names two
 * different defects: a table with a category axis and no ordered one is a rule that may be too strict
 * (a line over categories is drawable), and a table with no axis at all is a label asking for a
 * picture nothing can witness — unless the missing axis is a column of years the profiler typed as a
 * measure, which is `timeLike` beside it. Those are three files to open, and one number cannot choose
 * between them.
 */
export interface ShapeCensus {
  readonly family: ChartFamily;
  readonly mark: RecommendableMark;
  readonly dims: number;
  readonly ordered: number;
  readonly measures: number;
  /** The table carries a column that formats as time and was not typed temporal. */
  readonly timeLike: boolean;
  readonly n: number;
  readonly withFallback: number;
  /**
   * Up to three questions from this bucket, verbatim.
   *
   * A count says a shape was refused 350 times; it cannot say whether those questions asked for a
   * line ("over time", "monthly") or merely arrived with a time-shaped table. The two repairs are
   * different — a cue that the table has no axis for, against an admission rule that is too strict —
   * and the words are the evidence that separates them. Three is enough to read the intent and few
   * enough to keep the artifact small.
   */
  readonly samples: readonly string[];
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

/** The tables that would not profile, by the reason the profiler had nothing to read. */
export interface NoProfileCensus {
  readonly reason: TableDefect;
  readonly n: number;
  /** Up to three of the cells' first lines: what the corpus put there instead of what a table is. */
  readonly samples: readonly string[];
}

/**
 * A lever's expected effect, computed from the rows rather than argued from them.
 *
 * A registered prediction is a promise, and the corpus can price the promise before anyone ships it.
 * `converted` and `lost` are the two sides — a rule that buys 40 rows and costs 12 is a different
 * decision from one that buys 40 and costs none — and the next dispatch has to reproduce both, so
 * the model cannot quietly become the measurement.
 */
export interface Counterfactual {
  /** The rule, in the words the next dispatch will test. */
  readonly rule: string;
  /** Rows this rule answers with the label's family as the winner's first claim. */
  readonly hit: number;
  /** Rows it wins that the shipped ranking loses. */
  readonly converted: number;
  /** Rows it loses that the shipped ranking wins. */
  readonly lost: number;
}

export interface CensusReport {
  readonly rows: number;
  readonly unmapped: number;
  readonly scored: number;
  readonly outcomes: Readonly<Record<CensusOutcome, number>>;
  readonly byFamily: readonly FamilyCensus[];
  readonly refusals: readonly RefusalCensus[];
  /** The same refusals by shape, largest first: the table that decides which file to open. */
  readonly shapes: readonly ShapeCensus[];
  readonly outranked: readonly OutrankedCensus[];
  /** Why a table produced no profile, most rows first: a corpus gap and a parser gap are not the same. */
  readonly noProfile: readonly NoProfileCensus[];
  /** What the next lever would do, counted over the same rows and not yet shipped. */
  readonly counterfactual: Counterfactual;
  /** Columns that format as time and were not typed temporal, most rows first. */
  readonly timeLike: readonly TimeLike[];
  /** Rows whose table carries at least one such column. */
  readonly timeLikeRows: number;
  /** Columns that are numbers only after their formatting is read, most rows first. */
  readonly coerced: readonly CoercedColumn[];
  /** Rows whose table carries at least one such column. */
  readonly coercedRows: number;
  /** Whether the table profiled into any measure at all, which every measure-consuming mark needs. */
  readonly measureless: { readonly tables: number; readonly refused: number };
  /** Cells made of digits that nothing read, on the tables that ended up with no measure. */
  readonly numerals: readonly UnreadNumeral[];
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
 * The winner if a cue paid only the first mark it can actually admit — the next lever, priced before
 * it is shipped.
 *
 * The shipped rule still pays a cue's other marks two points, and that is what makes a fallback worth
 * something even when the mark it falls back *from* is available: `share` pays the bar two points on
 * every question that says "percentage", whether or not a pie was drawable. The alternative reads the
 * cue list as what it says — "a pie, or a bar if a pie cannot be drawn" — and pays one mark per cue.
 *
 * The model is written from published fields only, so it cannot drift from the table it describes:
 * `Recommendation.score` is `prior + 3·firsts + 2·seconds` and `Recommendation.cues` lists every cue
 * that named the mark, so the prior is whatever is left after the cues are subtracted. Nothing about
 * the admission rules is restated here.
 *
 * **It is a prediction, not a measurement.** The dispatch that ships the rule must reproduce
 * `converted` and `lost` exactly, or the rule it describes is a different rule.
 */
export function firstAdmissibleWinner(choice: ChartChoice, cues: readonly Cue[]): Recommendation | undefined {
  // The marks this result can carry, as a lookup from the cue table's vocabulary: a cue names
  // `ChartType`s and the ranking holds `RecommendableMark`s, and the intersection is what the cue can
  // pay here. Reading it as a map avoids a cast that would let a mark the ranking never considers
  // collect a point.
  const admissible = new Map<string, RecommendableMark>(
    choice.recommendations.map((entry) => [entry.mark, entry.mark]),
  );
  const paid = new Map<RecommendableMark, number>();
  for (const cue of cues) {
    const mark = cue.marks.map((candidate) => admissible.get(candidate)).find((entry) => entry !== undefined);
    if (mark === undefined) continue;
    paid.set(mark, (paid.get(mark) ?? 0) + 1);
  }
  const underRule = (entry: Recommendation): number => {
    const firsts = firstClaims(cues, entry.mark);
    const prior = entry.score - 3 * firsts - 2 * (entry.cues.length - firsts);
    return prior + 3 * (paid.get(entry.mark) ?? 0);
  };
  return [...choice.recommendations].sort(
    (left, right) =>
      underRule(right) - underRule(left) || RECOMMENDABLE_MARKS.indexOf(left.mark) - RECOMMENDABLE_MARKS.indexOf(right.mark),
  )[0];
}

/** How many cues name a mark first, read from the cue table rather than from the score. */
function firstClaims(cues: readonly Cue[], mark: RecommendableMark): number {
  return cues.filter((cue) => cue.marks[0] === mark).length;
}

/**
 * Classify one question.
 *
 * The hit test is `profileAnswer`'s, deliberately: `profile.ts` counts a hit when the *first* family
 * the answer covers is the label's, so a mark that covers the family second is a shortlist hit and
 * not a top-1 hit. Reading the whole family list here would have counted one `area` row answered by a
 * line as a hit while the published reading called it a shortlist-only row, and the census would then
 * be explaining a count nobody published — `text2vis-census.test.ts` asserts the two agree row for
 * row, and `substituted` is the outcome that makes them agree.
 */
export function classify(row: ProfileInput): CensusRow {
  const expected = familyOfLabel(row.label);
  if (expected === undefined) {
    throw new Error(`census: ${row.label} has no family, and an unmapped label is excluded before it is classified`);
  }
  const set = parseResultSet(row.tableData);
  const profiles = profilesOf(set);
  if (profiles.length === 0) return { expected, outcome: 'noProfile' };
  // The row's own answer is read before the family's coverage, because a mark can cover a family
  // through the cue that named it and no mark can be that family at all — a bar is a histogram only
  // when the question says so. Testing coverage first would file that row as `uncovered` and lose the
  // one fact that explains it.
  const choice = recommendChart(row.prompt, profiles);
  const top = choice.recommendations[0];
  const lead = top === undefined ? undefined : familiesOfMark(top.mark, top.cues[0]);
  const covering = coveringMarks(expected);
  if (covering.length === 0 && (lead === undefined || !lead.includes(expected))) {
    return { expected, outcome: 'uncovered' };
  }
  if (top !== undefined && lead !== undefined && lead[0] === expected) {
    return { expected, outcome: 'hit' };
  }
  if (top !== undefined && lead !== undefined && lead.includes(expected)) {
    // The answer covers the family, but as its second claim. It is neither a hit (the label asked for
    // the other picture) nor a loss (nothing outranked the covering mark: the covering mark *is* what
    // answered), so it gets the name of what happened.
    return { expected, outcome: 'substituted', answered: top.mark, ownFamily: lead[0] as ChartFamily };
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
      shape: choice.shape,
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
    coveringCues: coveringEntry.cues,
    answeredCues: winner.cues,
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
  substituted: number;
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

interface CoercedTally {
  column: string;
  sample: string;
  n: number;
}

interface NumeralTally {
  column: string;
  cell: string;
  n: number;
}

interface ShapeTally {
  family: ChartFamily;
  mark: RecommendableMark;
  dims: number;
  ordered: number;
  measures: number;
  timeLike: boolean;
  n: number;
  withFallback: number;
  samples: string[];
}

interface LossTally {
  expected: ChartFamily;
  winner: RecommendableMark;
  n: number;
  namedButLost: number;
  onPreference: number;
  gaps: Map<number, number>;
  samples: LossSample[];
}

interface NoProfileTally {
  reason: TableDefect;
  n: number;
  samples: string[];
}

/** Tally a classified population into the report a document quotes. */
export function censusOf(rows: readonly ProfileInput[], options: { readonly variant?: string } = {}): CensusReport {
  const outcomes: Record<CensusOutcome, number> = { hit: 0, substituted: 0, refused: 0, outranked: 0, uncovered: 0, noProfile: 0 };
  const byFamily = new Map<ChartFamily, FamilyTally>();
  const refusals = new Map<string, RefusalTally>();
  const outranked = new Map<string, LossTally>();
  const noProfile = new Map<TableDefect, NoProfileTally>();
  const timeLike = new Map<string, TimeLikeTally>();
  const shapes = new Map<string, ShapeTally>();
  const coerced = new Map<string, CoercedTally>();
  const numerals = new Map<string, NumeralTally>();
  let scored = 0;
  let unmapped = 0;
  let timeLikeRows = 0;
  let coercedRows = 0;
  let measurelessTables = 0;
  let measurelessRefused = 0;
  let underFirstClaims = 0;
  let converted = 0;
  let lost = 0;

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
      substituted: 0,
      refused: 0,
      outranked: 0,
      uncovered: 0,
      noProfile: 0,
    };
    family.n += 1;
    family[classified.outcome] += 1;
    byFamily.set(classified.expected, family);

    const set = parseResultSet(row.tableData);
    const profiles = profilesOf(set);
    // The counterfactual is counted here, not inside `classify`: `classify` reports what happened,
    // and this is a prediction about a ranking that does not exist yet. It is computed on the same
    // population and the same hit test, so `hit` and `counterfactual.hit` are the same measurement
    // of two orderings rather than two measurements of one ordering.
    if (profiles.length > 0) {
      const under = firstAdmissibleWinner(recommendChart(row.prompt, profiles), readCues(row.prompt));
      const answers = under !== undefined && familiesOfMark(under.mark, under.cues[0])[0] === classified.expected;
      const answered = classified.outcome === 'hit';
      if (answers) underFirstClaims += 1;
      if (answers && !answered) converted += 1;
      if (!answers && answered) lost += 1;
    }
    const mistyped = profiles.length === 0 ? [] : timeLikeColumns(set, profiles);
    if (mistyped.length > 0) timeLikeRows += 1;
    for (const column of mistyped) {
      const entry = timeLike.get(column.column) ?? { ...column, n: 0 };
      entry.n += 1;
      timeLike.set(column.column, entry);
    }
    const rescued = coercedColumns(set);
    if (rescued.length > 0) coercedRows += 1;
    for (const column of rescued) {
      const entry = coerced.get(column.column) ?? { ...column, n: 0 };
      entry.n += 1;
      coerced.set(column.column, entry);
    }
    // A table with no measure refuses every mark that draws one, so it is a shape of its own — and
    // the cells it declined to read are what says which repair it needs.
    const measureless = profiles.length > 0 && !profiles.some((entry) => entry.type === 'quantitative');
    if (measureless) {
      measurelessTables += 1;
      if (classified.outcome === 'refused') measurelessRefused += 1;
      for (const unread of unreadNumerals(set)) {
        const key = `${unread.column}\u0000${unread.cell}`;
        const entry = numerals.get(key) ?? { ...unread, n: 0 };
        entry.n += 1;
        numerals.set(key, entry);
      }
    }

    if (classified.outcome === 'refused') {
      const key = `${classified.expected}\u0000${classified.covering}\u0000${String(classified.shape.dims)}x${String(classified.shape.ordered)}x${String(classified.shape.measures)}\u0000${String(mistyped.length > 0)}`;
      const entry = shapes.get(key) ?? {
        family: classified.expected,
        mark: classified.covering,
        dims: classified.shape.dims,
        ordered: classified.shape.ordered,
        measures: classified.shape.measures,
        timeLike: mistyped.length > 0,
        n: 0,
        withFallback: 0,
        samples: [],
      };
      entry.n += 1;
      if (classified.answered !== undefined) entry.withFallback += 1;
      if (entry.samples.length < 3) entry.samples.push(snippet(row.prompt));
      shapes.set(key, entry);
    }

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
        samples: [],
      };
      entry.n += 1;
      if (classified.coveringCue !== undefined) entry.namedButLost += 1;
      const gap = classified.answeredScore - classified.coveringScore;
      if (gap === 0) entry.onPreference += 1;
      entry.gaps.set(gap, (entry.gaps.get(gap) ?? 0) + 1);
      if (entry.samples.length < 3) {
        entry.samples.push({
          prompt: snippet(row.prompt),
          covering: classified.covering,
          answered: classified.answered,
          coveringScore: classified.coveringScore,
          answeredScore: classified.answeredScore,
          coveringCues: classified.coveringCues,
          answeredCues: classified.answeredCues,
        });
      }
      outranked.set(key, entry);
    }

    if (classified.outcome === 'noProfile') {
      const reason = noProfileReason(row.tableData, set);
      const entry = noProfile.get(reason) ?? { reason, n: 0, samples: [] };
      entry.n += 1;
      // The sample is the cell's first line, not the question: the defect is in the table, and the
      // question is the same question the rest of the corpus asks.
      const first = row.tableData.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? '';
      // An empty cell has no first line to quote, so it carries no sample. The report reads the
      // difference: `empty` is a benchmark that ships no table, and there is nothing to show.
      if (first !== '' && entry.samples.length < 3) entry.samples.push(snippet(first));
      noProfile.set(reason, entry);
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
    shapes: [...shapes.values()].sort(
      (left, right) =>
        right.n - left.n ||
        left.mark.localeCompare(right.mark) ||
        left.dims - right.dims ||
        left.ordered - right.ordered ||
        Number(left.timeLike) - Number(right.timeLike),
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
        samples: entry.samples,
      }))
      .sort(
        (left, right) =>
          right.n - left.n ||
          left.expected.localeCompare(right.expected) ||
          String(left.winner).localeCompare(String(right.winner)),
      ),
    noProfile: [...noProfile.values()].sort(
      (left, right) => right.n - left.n || left.reason.localeCompare(right.reason),
    ),
    counterfactual: {
      rule: 'a cue pays only the first mark it can admit',
      hit: underFirstClaims,
      converted,
      lost,
    },
    timeLike: [...timeLike.values()].sort(
      (left, right) => right.n - left.n || left.column.localeCompare(right.column),
    ),
    timeLikeRows,
    coerced: [...coerced.values()].sort((left, right) => right.n - left.n || left.column.localeCompare(right.column)),
    coercedRows,
    measureless: { tables: measurelessTables, refused: measurelessRefused },
    numerals: [...numerals.values()].sort(
      (left, right) => right.n - left.n || left.column.localeCompare(right.column) || left.cell.localeCompare(right.cell),
    ),
    variant: options.variant ?? 'census',
  };
}

/**
 * The arithmetic a report can be wrong about, refused rather than published.
 *
 * Every scored row lands in exactly one of the six outcomes, and the per-family rows sum to the
 * scored population. A report that breaks either is a share computed on the wrong denominator.
 */
export function assertCensusReport(report: CensusReport): void {
  const sum = Object.values(report.outcomes).reduce((total, count) => total + count, 0);
  if (sum !== report.scored) {
    throw new Error(
      `census report: the six outcomes sum to ${String(sum)} and ${String(report.scored)} rows were scored`,
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
  // A bucket that carries its own breakdown has to add up to the bucket, or the breakdown is a
  // second opinion about the same rows and a reader who quotes it is quoting a different corpus.
  const unexplained = report.noProfile.reduce((total, entry) => total + entry.n, 0);
  if (unexplained !== report.outcomes.noProfile) {
    throw new Error(
      `census report: the no-profile reasons account for ${String(unexplained)} and ${String(report.outcomes.noProfile)} tables would not profile`,
    );
  }
  // A counterfactual is an ordering of the same rows, so it can move a hit and cannot make one: the
  // three counts have to satisfy the identity, or the prediction is about a different population.
  const { converted, lost } = report.counterfactual;
  if (report.counterfactual.hit !== report.outcomes.hit + converted - lost) {
    throw new Error(
      `census report: the counterfactual reads ${String(report.counterfactual.hit)} hits, which is not ${String(report.outcomes.hit)} + ${String(converted)} converted - ${String(lost)} lost`,
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
    `  hit ${String(outcome.hit)} (${share(outcome.hit)}), substituted ${String(outcome.substituted)}, refused ${String(outcome.refused)} (${share(outcome.refused)}), outranked ${String(outcome.outranked)} (${share(outcome.outranked)}), uncovered ${String(outcome.uncovered)}, no profile ${String(outcome.noProfile)}`,
    `  hit + substituted is the shortlist the profile file publishes: ${String(outcome.hit + outcome.substituted)} of ${String(report.scored)}`,
    `  time-formatted columns the profiler did not call temporal: ${String(report.timeLikeRows)} rows`,
    `  columns that are numbers only after their formatting is read: ${String(report.coercedRows)} rows`,
  ];
  for (const column of report.coerced.slice(0, 4)) {
    lines.push(`    ${column.column} (${String(column.n)} rows, first value ${column.sample})`);
  }
  for (const column of report.timeLike.slice(0, 6)) {
    lines.push(`    ${column.column} (${column.typed}, ${String(column.n)} rows, first value ${column.sample})`);
  }
  if (report.measureless.tables > 0) {
    lines.push(
      `  tables with no measure at all: ${String(report.measureless.tables)} rows (${String(report.measureless.refused)} refused every mark that needs one)`,
    );
    for (const numeral of report.numerals.slice(0, 8)) {
      lines.push(`    ${numeral.column} = "${numeral.cell}" (${String(numeral.n)} rows)`);
    }
  }
  for (const entry of report.refusals.slice(0, 6)) {
    lines.push(
      `  refused ${entry.mark} for ${entry.expected}: ${String(entry.n)} (${String(entry.withFallback)} answered by another mark) — ${entry.reason}`,
    );
  }
  for (const entry of report.shapes.slice(0, 10)) {
    lines.push(
      `  refused ${entry.mark} for ${entry.family}: ${String(entry.n)} (${String(entry.withFallback)} answered elsewhere) at dims ${String(entry.dims)} / ordered ${String(entry.ordered)} / measures ${String(entry.measures)}${entry.timeLike ? ', time-formatted column present' : ''} — e.g. "${entry.samples[0] as string}"`,
    );
  }
  for (const entry of report.outranked.slice(0, 8)) {
    const gaps = entry.gaps.map((gap) => `${gap.gap > 0 ? '+' : ''}${String(gap.gap)}×${String(gap.n)}`).join(' ');
    lines.push(
      `  lost ${entry.expected} to ${entry.winner}: ${String(entry.n)} (on preference ${String(entry.onPreference)}, cue named and lost ${String(entry.namedButLost)}, gaps ${gaps})`,
    );
    for (const sample of entry.samples) {
      lines.push(
        `    e.g. ${sample.covering} ${String(sample.coveringScore)} [${sample.coveringCues.join(' ')}] < ${sample.answered} ${String(sample.answeredScore)} [${sample.answeredCues.join(' ')}] — "${sample.prompt}"`,
      );
    }
  }
  if (report.noProfile.length > 0) {
    const counts = report.noProfile.map((entry) => `${entry.reason} ${String(entry.n)}`).join(', ');
    lines.push(`  tables that would not profile: ${counts}`);
    for (const entry of report.noProfile) {
      if (entry.samples.length === 0) continue;
      lines.push(`    ${entry.reason}: e.g. "${entry.samples[0] as string}"`);
    }
  }
  const under = report.counterfactual;
  lines.push(
    `  as if ${under.rule}: hit ${String(outcome.hit)} -> ${String(under.hit)} (converted ${String(under.converted)}, lost ${String(under.lost)}) — predicted, not shipped`,
  );
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
