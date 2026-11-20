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
 * *second* claim — a line answering an `area` row), a reshape (the table was melted into a line
 * without any admission rule being asked, and the line cannot cover the label), a family no mark can
 * cover, or a table that would not profile. The counters are asserted to sum to the scored population, the same discipline
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
import {
  CHART_CUES,
  RECOMMENDABLE_MARKS,
  histogramReading,
  isCalendarColumn,
  meltWide,
  readCues,
  recommendChart,
} from '@agentix-e/nl2charts-chart';
import { applyExitCode, isEntry, loadText2Vis, type LoadOptions } from './dataset.js';
import { CUE_VARIANTS, familiesOfMark, familyCue, familyOfLabel, type ChartFamily, type TableVariant } from './rule.js';
import { isMissingCell, numericCell, parseResultSet, profilesOf, typedRows, type ProfileInput, type ResultSet } from './profile.js';

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
export type CensusOutcome = 'hit' | 'substituted' | 'reshaped' | 'binned' | 'refused' | 'outranked' | 'uncovered' | 'noProfile';

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
      readonly outcome: 'binned';
      /**
       * The mark the product drew: a bar, because a histogram in this contract is a bar over the
       * bins. Typed as the literal for the same reason `reshaped` is — the reading has one output.
       */
      readonly answered: 'bar';
      /** How many bins the pooled numbers were counted into. */
      readonly bins: number;
      /** The two column names the reading invented, which is what a reader checks the axis against. */
      readonly bin: string;
      readonly count: string;
    }
  | {
      readonly expected: ChartFamily;
      readonly outcome: 'reshaped';
      /**
       * What the product drew: always a line, because a wide table is melted into one line per entity
       * before any admission rule is asked about it.
       *
       * Spelled as the literal rather than as `RecommendableMark` because the reshape has exactly one
       * output — a fact worth typing — and because a reader comparing this outcome with `outranked`
       * should see that no ranking took place on these rows.
       */
      readonly answered: 'line';
      /**
       * The axis names the melt gave the table: the one column that was not a period, and the name
       * the periods moved into (`Year` for bare years, `Period` for anything else).
       *
       * Published because the two ways a reshape can be wrong are visible in them: an entity named
       * `Min` or a period named `Period` over columns like `Q1`…`Q4` is a table read sideways, while
       * an entity named `Series 1` is a five-number summary that this product mistook for years.
       */
      readonly entity: string;
      readonly period: string;
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
 * A cell that holds a decimal number, and that `numericCell` still refuses.
 *
 * The other half of the same question. `coercedColumns` names the columns a *format* rescued; this
 * names the cells nothing rescued, on tables that ended up with no measure at all — the tables that
 * refuse every mark needing one, which is the largest single shape in the refusal table.
 *
 * **The first version of this asked for a cell with a digit and no letter, and the corpus answered
 * with `71+`, `18-25` and `2018*`** — age bands and footnote-marked years, which are categories and
 * were typed as categories, correctly. The requirement is now a *decimal shape*, `\d` followed by a
 * separator and another digit, because that is what a mis-formatted quantity looks like: `−0.04` with
 * a typographic minus, `1.234,56` with the separators the other way round, `0.04 °C` with a unit.
 * A categorical code is not a number the reader declined, and an instrument that calls it one sends
 * the next round to the parser with a list of football scores and age brackets.
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
      (cell) => /\d[.,]\d/.test(cell) && !/\p{L}/u.test(cell) && numericCell(cell) === undefined,
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
  /** What the shipped typing is worth, priced on every run by un-typing it. */
  readonly calendar: CalendarCensus;
  /** The tables no mark can group by, published as a population rather than folded into the share. */
  readonly ceiling: CeilingCensus;
  /**
   * The labels whose picture this contract cannot lead with, and the denominator they change.
   *
   * Three of the corpus's sixteen labels name a mark no admission rule can produce: `area` is a
   * filled line, `histogram` is a binned bar, `violin` is a boxplot with a density. Each is covered
   * as a *second* family, which is why none of them can ever be a top-1 hit — the hit test reads the
   * first family a mark leads with. So 237 rows are outside what the product can answer at all, and
   * the share every other number is quoted against includes them. `renderable` and
   * `hitShareRenderable` are the same rows read against the population the contract can draw.
   */
  readonly unreachable: UnreachableCensus;
  /** Rows whose label is one the contract can lead with: `scored − unreachable.rows`. */
  readonly renderable: number;
  /** Hits as a share of `renderable`, which is the number a ranking can actually be judged on. */
  readonly hitShareRenderable: number;
  /** Columns that format as time and were not typed temporal, most rows first. */
  readonly timeLike: readonly TimeLike[];
  /** Rows whose table carries at least one such column. */
  readonly timeLikeRows: number;
  /** Columns that are numbers only after their formatting is read, most rows first. */
  readonly coerced: readonly CoercedColumn[];
  /** Rows whose table carries at least one such column. */
  readonly coercedRows: number;
  /** Rows whose table carried a printed absence where a measure's value would be. */
  readonly missingRows: number;
  /** Whether the table profiled into any measure at all, which every measure-consuming mark needs. */
  readonly measureless: { readonly tables: number; readonly refused: number };
  /** Cells made of digits that nothing read, on the tables that ended up with no measure. */
  readonly numerals: readonly UnreadNumeral[];
  /**
   * Every cue table this build can construct, priced on the *product* — admission rules and all.
   *
   * The cue-only sweep in `rule.ts` scores the question against the label and never sees a result set,
   * so it cannot tell a mark the question named from a mark the table refused. That is enough to rank
   * two phrase tables and not enough to ship one: a cue change that gains on the question can lose on
   * the shape, and only this reading can see it. Every candidate is priced here *before* it ships, on
   * the same rows and the same hit test the published `hit` count uses, so `product[0]` is a second
   * computation of `outcomes.hit` and `assertCensusReport` holds the two equal.
   */
  readonly product: readonly ProductVariant[];
  readonly variant: string;
}

/**
 * What the shipped calendar rule is worth, measured by removing it.
 *
 * A rule that types a contiguous run of years as a period axis was shipped on a reading, and a
 * reading that stops running is a number that can be quietly lost. This prices the rule on every run
 * by asking the inverse question — take the columns the profiler called temporal because of a run,
 * type them back as measures, and rank again — so the delta in `describeCensus` is always the delta
 * of the code that is currently in the tree rather than of the commit that introduced it.
 *
 * `hit` is the reading *without* the rule. The identity `outcomes.hit - converted + lost === hit` is
 * asserted, which is what makes this a counterfactual on the same rows instead of a second corpus.
 */
export interface CalendarCensus {
  readonly rule: string;
  /** Rows carrying a column the rule typed: the population the price is taken over. */
  readonly rows: number;
  /** Hits if those columns were measures again. */
  readonly hit: number;
  /** Rows the rule answers that the older typing does not. */
  readonly converted: number;
  /** Rows the older typing answers that the rule does not. */
  readonly lost: number;
  /**
   * The same two counts over the two disjoint halves of the scored population.
   *
   * A lever that gains on one half and loses on the other has not been shown to gain. This one is
   * published on every run rather than once, because the halves are cheap and the claim is not.
   */
  readonly split: {
    readonly a: { readonly converted: number; readonly lost: number };
    readonly b: { readonly converted: number; readonly lost: number };
  };
}

/**
 * The rows whose result set offers no axis at all.
 *
 * A table of two or more measures and no column a mark can group by cannot carry a bar, a line, a
 * pie, an area, a heatmap, a radar or a parallel — every one of them groups rows. What is left is the
 * scatter (two measures), the boxplot (five) and the gauge (one), so the only way to draw such a
 * table as a trend is to *invent* an axis out of the row order.
 *
 * **This is a ceiling, not a score.** The refused count is the most an index-axis encoding could ever
 * buy — those rows would still have to win the ranking afterwards — and it is published beside the
 * hit share so a reader can see how much of the denominator is out of reach before reading a rule
 * change as a ranking defect. It is not added to or subtracted from any hit count.
 *
 * The number was 177 rows before the calendar rule shipped, and 143 of them carried a column of
 * consecutive years the profiler was typing as a measure: the "no axis at all" bucket was mostly a
 * type-inference defect wearing its shape. What is left after the rule is the ceiling proper.
 */
/** One unreachable family, as the census counts it. */
interface UnreachableTally {
  n: number;
  outcome: Record<CensusOutcome, number>;
  coveredBy?: RecommendableMark;
}

/** Seven zeroes, one per outcome: a fresh object, because the tally mutates what it is given. */
function emptyOutcome(): Record<CensusOutcome, number> {
  return { hit: 0, substituted: 0, reshaped: 0, binned: 0, refused: 0, outranked: 0, uncovered: 0, noProfile: 0 };
}

export interface CeilingCensus {
  readonly rows: number;
  /** Of those, the rows whose covering mark was refused: the prize an index axis could compete for. */
  readonly refused: number;
  readonly byFamily: readonly { readonly family: ChartFamily; readonly n: number; readonly refused: number }[];
  /** The marks that were refused on those rows, largest first: which families the axis would unlock. */
  readonly marks: readonly { readonly mark: RecommendableMark; readonly n: number }[];
  /** Up to three questions, verbatim, for the reason `ShapeCensus.samples` gives. */
  readonly samples: readonly string[];
}

/**
 * One reading of the product, priced on the product's own hit test.
 *
 * "Reading" and not "table", because the axis is every one-edit change to the decision path: the
 * order of a cue's marks, the presence of a cue, and the admission cap are all single edits a caller
 * can make, and a gain is only attributable while the entry says which edit it was.
 */
export interface ProductVariant {
  readonly variant: string;
  /** What the entry changes, in one line: the name is a label and this is the claim. */
  readonly note: string;
  /** Rows whose label family the product's leading mark covers first. */
  readonly hit: number;
  /** `hit / scored`, with `scored` the same denominator every other reading uses. */
  readonly hitShare: number;
  /** Per-family hits, so a table that trades one family for another cannot pass as a gain. */
  readonly byFamily: readonly { readonly family: ChartFamily; readonly n: number; readonly hit: number }[];
  /**
   * The same hits over two disjoint halves of the scored population, split by row parity.
   *
   * The split is arbitrary with respect to content and fixed before the reading, and it exists
   * because a sweep of thirty candidates will always have a winner: a lever that gains on one half
   * and loses on the other has not been shown to gain, it has been shown to fit. Both halves are
   * published rather than a p-value, because the reader is the one who has to decide.
   */
  readonly split: { readonly a: number; readonly b: number };
  /**
   * Rows whose leading mark differs from the control's.
   *
   * The hit count answers "what does this entry cost", and that is not the same question as "what
   * does it change": five cues in this table move nothing on the score, because the corpus has no row
   * whose hit they could take — a funnel cue over eleven rows that are all misses is worth zero hits
   * either way, while every one of those eleven answers changes from a funnel to a bar. An ablation
   * that published only the delta would read as "these cues do nothing", which is a claim about the
   * product that the reading does not support.
   */
  readonly moved: number;
  /** Rows the leading mark covers the label's family with at all, first claim or second. */
  readonly shortlist: number;
  /** Of those, the rows covered as the *second* claim: the family the product shows instead. */
  readonly substituted: number;
}

/**
 * The labels whose picture no admission rule can produce, and what became of their rows.
 *
 * The list is *derived*, not declared: a family is unreachable when no recommendable mark leads with
 * it under any cue, which is the same predicate the hit test applies. Declaring it would be a second
 * opinion about which marks can lead, and the two would drift the first time a mark is added.
 */
export interface UnreachableCensus {
  readonly rows: number;
  readonly byFamily: readonly {
    readonly family: ChartFamily;
    readonly n: number;
    readonly outcome: Readonly<Record<CensusOutcome, number>>;
    /** The mark that stands in for the family, when one is admitted on those rows at all. */
    readonly coveredBy?: RecommendableMark;
  }[];
}

/**
 * The families no mark can lead with, read off the product's own `familiesOfMark`.
 *
 * `familiesOfMark` answers "what may this mark stand for", in order, and the hit test reads the
 * *first* entry. So the reachable set is the first entries over every mark and every cue, and its
 * complement is the set of labels this contract cannot answer whatever the question says. On
 * Text2Vis that is `area` and `violin` — two of sixteen labels, 147 of 1,470 rows.
 *
 * **`histogram` was the third until the reading existed.** `familiesOfMark('bar', 'histogram')` listed
 * the bar first, so the reachable set did not contain it, and 90 rows were published as a gap in the
 * contract rather than as a gap in the marks. Now that the cue leads, the family is reachable and the
 * list is shorter by a label — which is what a derived list is for: it shrinks by itself when the
 * capability arrives, and this paragraph is the only thing that had to be edited by hand.
 *
 * This is a reading and not a defect list. A product that draws a line where the corpus drew an area
 * has answered a nearby question, and calling that a top-1 hit would make the score say the product
 * draws an area chart. Publishing it separately is what lets the ranking be judged on the rows the
 * contract can draw while the corpus's own denominator stays visible beside it.
 */
export function unreachableFamilies(): readonly ChartFamily[] {
  const reachable = new Set<ChartFamily>();
  for (const mark of RECOMMENDABLE_MARKS) {
    reachable.add(familiesOfMark(mark)[0] as ChartFamily);
    for (const cue of CHART_CUES) reachable.add(familiesOfMark(mark, cue.kind)[0] as ChartFamily);
  }
  const all: readonly ChartFamily[] = [...RECOMMENDABLE_MARKS, 'area', 'histogram', 'violin'];
  return all.filter((family) => !reachable.has(family));
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
 *
 * **One place they do not agree, measured and now repaired.** `profileAnswer` asks the reshape first —
 * a table that is wide in time is drawn as one line per entity by `toChartIR` without consulting an
 * admission rule — and this classifier used to rank every table, so on the 1,470 scored rows the two
 * disagreed about **73** of them. The repair is a third answer to a question this classifier had only
 * two answers to: a reshaped row is `hit` when the label asks for the picture the melt draws, a
 * `substituted` when the label's family is that picture's second claim (`area`, which a line covers),
 * and `reshaped` when the label asked for something the melt never considered. Nothing is fitted into
 * `outranked` or `refused`, because no ranking and no admission rule took place on these rows — and an
 * outcome that says "a rule refused this" about a row no rule was asked is the defect the counters
 * exist to prevent.
 */
export function classify(row: ProfileInput): CensusRow {
  const expected = familyOfLabel(row.label);
  if (expected === undefined) {
    throw new Error(`census: ${row.label} has no family, and an unmapped label is excluded before it is classified`);
  }
  const set = parseResultSet(row.tableData);
  // The two readings the product takes before any admission rule, in the order `toChartIR` takes
  // them: a histogram question is answered by pooling and binning the cells, and a table wide in time
  // is answered by melting it. Neither asks a rule, so a classifier that ranked these rows would be
  // explaining a decision the product never made.
  const bins = histogramReading(row.prompt, typedRows(set), set.columns);
  if (bins !== undefined) {
    const lead = familiesOfMark('bar', 'histogram');
    if (lead[0] === expected) return { expected, outcome: 'hit' };
    if (lead.includes(expected)) return { expected, outcome: 'substituted', answered: 'bar', ownFamily: 'histogram' };
    // The rows were rewritten, so the family the label asked for is not a picture of the numbers that
    // are left: nothing refused the mark and nothing outranked it, and calling it either would be a
    // diagnosis of a decision nobody made.
    return { expected, outcome: 'binned', answered: 'bar', bins: bins.distribution.bins.length, bin: bins.bin, count: bins.count };
  }
  const wide = meltWide(typedRows(set), set.columns);
  if (wide !== undefined) {
    const lead = familiesOfMark('line');
    const first = lead[0] as ChartFamily;
    if (first === expected) return { expected, outcome: 'hit' };
    if (lead.includes(expected)) return { expected, outcome: 'substituted', answered: 'line', ownFamily: first };
    return { expected, outcome: 'reshaped', answered: 'line', entity: wide.entity, period: wide.period };
  }
  const profiles = profilesOf(set);
  if (profiles.length === 0) return { expected, outcome: 'noProfile' };
  // The row's own answer is read before the family's coverage, because a mark can cover a family
  // through the cue that named it and no mark can be that family at all — a bar is a histogram only
  // when the question says so. Testing coverage first would file that row as `uncovered` and lose the
  // one fact that explains it.
  const choice = recommendChart(row.prompt, profiles, { rows: set.rows.length });
  const top = choice.recommendations[0];
  const lead = top === undefined ? undefined : familiesOfMark(top.mark, familyCue(top.cues));
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
  reshaped: number;
  binned: number;
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

interface CeilingTally {
  rows: number;
  refused: number;
  byFamily: Map<ChartFamily, { n: number; refused: number }>;
  marks: Map<RecommendableMark, number>;
  samples: string[];
}

interface ProductTally {
  hit: number;
  byFamily: Map<ChartFamily, { n: number; hit: number }>;
  split: { a: number; b: number };
  moved: number;
  shortlist: number;
  substituted: number;
}

/**
 * Every one-edit change to the product's decision path, priced on the same rows.
 *
 * Two axes, one table, because a reader compares candidates and not axes. The cue tables come from
 * `rule.ts` — the sweep that module owns is the question half's, and this is the same list asked a
 * different question. The knobs after them are the edits that are not cue tables at all: the
 * admission cap is a number the recommender takes as an option, so a pie with nine slices is one
 * argument away and has been refused by a constant nobody measured.
 *
 * Ordered, not sorted: the control first, then the cue tables, then the knobs. A sweep whose order
 * depends on its own numbers is a sweep a reader cannot compare with the previous round's.
 */
export interface ProductCandidate extends TableVariant {
  /** The admission cap this entry uses, when the edit is the cap rather than the table. */
  readonly maxSlices?: number;
}

export const PRODUCT_CANDIDATES: readonly ProductCandidate[] = [
  ...CUE_VARIANTS.map((variant) => ({ name: variant.name, note: variant.note, cues: variant.cues })),
  {
    name: 'slices-7',
    note: 'the retired cap: the only table that can still say what the four rows it cost were worth',
    cues: CHART_CUES,
    maxSlices: 7,
  },
  {
    name: 'slices-9',
    note: 'the interval where a cap reads worse than the retired one: a pie at eight or nine categories was drawn as a bar',
    cues: CHART_CUES,
    maxSlices: 9,
  },
  {
    name: 'slices-any',
    note: 'no slice cap at admission at all: the ceiling the cap could ever cost, which no product would ship',
    cues: CHART_CUES,
    maxSlices: Number.MAX_SAFE_INTEGER,
  },
];

/** Tally a classified population into the report a document quotes. */
export function censusOf(rows: readonly ProfileInput[], options: { readonly variant?: string } = {}): CensusReport {
  const outcomes: Record<CensusOutcome, number> = emptyOutcome();
  const byFamily = new Map<ChartFamily, FamilyTally>();
  const refusals = new Map<string, RefusalTally>();
  const outranked = new Map<string, LossTally>();
  const noProfile = new Map<TableDefect, NoProfileTally>();
  const timeLike = new Map<string, TimeLikeTally>();
  const shapes = new Map<string, ShapeTally>();
  const coerced = new Map<string, CoercedTally>();
  const numerals = new Map<string, NumeralTally>();
  const unreachable = new Map<ChartFamily, UnreachableTally>();
  const outOfReach = unreachableFamilies();
  // Seeded from the variant list rather than filled on demand: a table that hit nothing is a reading
  // of zero, and a table missing from the report because nobody added a key would be a reading of
  // nothing — the two are indistinguishable to a reader, and only one of them is true.
  const product = new Map<string, ProductTally>(
    PRODUCT_CANDIDATES.map((candidate) => [
      candidate.name,
      { hit: 0, byFamily: new Map(), split: { a: 0, b: 0 }, moved: 0, shortlist: 0, substituted: 0 },
    ]),
  );
  let scored = 0;
  let unmapped = 0;
  let unreachableRows = 0;
  let missingRows = 0;
  let timeLikeRows = 0;
  let coercedRows = 0;
  let measurelessTables = 0;
  let measurelessRefused = 0;
  let underFirstClaims = 0;
  let converted = 0;
  let lost = 0;
  const ceiling: CeilingTally = { rows: 0, refused: 0, byFamily: new Map(), marks: new Map(), samples: [] };
  const calendar = {
    rows: 0,
    hit: 0,
    converted: 0,
    lost: 0,
    split: { a: { converted: 0, lost: 0 }, b: { converted: 0, lost: 0 } },
  };

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
      reshaped: 0,
      binned: 0,
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
    // The reshape, asked once per row and outside the candidate loop: it is a property of the table
    // and not of the cue table, so every candidate answers these rows identically — with a line. A
    // sweep that ranked them would publish a candidate's hit count over rows where no candidate was
    // consulted, and the assertion that the shipped candidate reproduces `outcomes.hit` would fail on
    // precisely the rows this round repaired.
    const typed = typedRows(set);
    const wide = meltWide(typed, set.columns);
    // The two readings the product takes without ranking: a melt, and the pooled bins a histogram
    // question is answered with. The row's own `fixedLead` is read off the *shipped* table, because
    // the counterfactual and the calendar ablation below are about the product: on a row the product
    // answered without ranking, there is no ordering for another ordering to beat.
    const fixedLead =
      wide !== undefined || histogramReading(row.prompt, typed, set.columns) !== undefined
        ? wide !== undefined
          ? familiesOfMark('line')
          : familiesOfMark('bar', 'histogram')
        : undefined;
    // Every candidate table, on the product path, against the same rows. The profiles are computed
    // once per row and handed to each variant, so what differs between the numbers is the cue table
    // and nothing else — a second `profilesOf` per variant would make the readings differ by the
    // profiler as well, and the sweep would be measuring two things at once.
    // The half a row belongs to is decided by its position in the *scored* population, so the two
    // halves are halves of the denominator the hit count is taken over and not of the file.
    const half = scored % 2 === 0 ? 'b' : 'a';
    // The control's answer is read first and held: "changed" is only meaningful against the table
    // that ships, and the control is first in the list by construction.
    let control: RecommendableMark | undefined;
    // The shape the product reports for this table, kept from the control's own call rather than
    // re-derived here: the ceiling below asks "did this table offer an axis", and that answer has to
    // be the one the admission rules read or it is a second opinion about the same table.
    let controlDims: number | undefined;
    for (const candidate of PRODUCT_CANDIDATES) {
      const tally = product.get(candidate.name) as ProductTally;
      const cell = tally.byFamily.get(classified.expected) ?? { n: 0, hit: 0 };
      cell.n += 1;
      const choice = recommendChart(row.prompt, profiles, {
        rows: set.rows.length,
        cues: candidate.cues,
        // Only when the entry is about the cap: passing the default explicitly would make every cue
        // table a second test of a number none of them changes.
        ...(candidate.maxSlices === undefined ? {} : { maxSlices: candidate.maxSlices }),
      });
      const top = choice.recommendations[0];
      // A candidate's answer is priced with the candidate's own cue table — including the reading,
      // which is gated on a cue: the `no-histogram` ablation has to lose this row, or the sweep would
      // credit every table with a widening only one of them carries.
      const lead =
        wide !== undefined
          ? fixedLead
          : histogramReading(row.prompt, typed, set.columns, candidate.cues) !== undefined
            ? familiesOfMark('bar', 'histogram')
            : top === undefined
              ? undefined
              : familiesOfMark(top.mark, familyCue(top.cues));
      if (candidate === PRODUCT_CANDIDATES[0]) {
        control = top?.mark;
        controlDims = choice.shape.dims;
      } else if (top?.mark !== control) tally.moved += 1;
      if (lead !== undefined && lead.includes(classified.expected)) {
        tally.shortlist += 1;
        if (lead[0] !== classified.expected) tally.substituted += 1;
      }
      if (lead !== undefined && lead[0] === classified.expected) {
        tally.hit += 1;
        cell.hit += 1;
        tally.split[half] += 1;
      }
      tally.byFamily.set(classified.expected, cell);
    }
    // The counterfactual is counted here, not inside `classify`: `classify` reports what happened,
    // and this is a prediction about a ranking that does not exist yet. It is computed on the same
    // population and the same hit test, so `hit` and `counterfactual.hit` are the same measurement
    // of two orderings rather than two measurements of one ordering.
    //
    // A fixed row is excluded from the comparison rather than from the population: the product
    // answered it by melting or by binning, so there is no ranking here for another ranking to beat, and crediting
    // the counterfactual with a conversion it did not make would inflate one lever with the work of
    // another. `under` is set equal to `answered` on those rows, which is the arithmetic way of saying
    // "this row says nothing about that ordering" while keeping the identity the report asserts.
    const answered = classified.outcome === 'hit';
    if (profiles.length > 0) {
      const under =
        fixedLead === undefined
          ? firstAdmissibleWinner(recommendChart(row.prompt, profiles, { rows: set.rows.length }), readCues(row.prompt))
          : undefined;
      const answers =
        fixedLead === undefined
          ? under !== undefined && familiesOfMark(under.mark, familyCue(under.cues))[0] === classified.expected
          : answered;
      if (answers) underFirstClaims += 1;
      if (answers && !answered) converted += 1;
      if (!answers && answered) lost += 1;
    }
    // What the shipped typing is worth: the columns the profiler called temporal because they walk
    // the calendar are typed back to measures and the row is ranked again. Asking the product's own
    // predicate rather than restating the rule is the whole point — a copy of the rule here would be
    // a second answer to "is this a year", and the reading would then be about the copy.
    //
    // A fixed row takes no part in this, for the reason it takes none in the counterfactual: the
    // product did not read its columns as types at all. It still contributes its own answer to
    // `calendar.hit` when it is a hit, because the identity below is over the whole population.
    const runs =
      profiles.length === 0 || fixedLead !== undefined
        ? []
        : (() => {
            const typed = typedRows(set);
            return set.columns.filter((name) => isCalendarColumn(typed.map((cells) => cells[name])));
          })();
    if (profiles.length > 0) {
      // `rows` is the population the price is taken *over*; `hit` is a count over the whole scored
      // population, because the identity it has to satisfy is about the whole corpus. A row with no
      // run keeps the answer it already had, which is what makes the ablation a re-ranking of one
      // column rather than a second reading of the corpus.
      if (runs.length > 0) calendar.rows += 1;
      let under: boolean;
      if (runs.length === 0) {
        under = answered;
      } else {
        const untyped = profiles.map((profile) =>
          runs.includes(profile.name) ? { ...profile, type: 'quantitative' as const } : profile,
        );
        const top = recommendChart(row.prompt, untyped, { rows: set.rows.length }).recommendations[0];
        under = top !== undefined && familiesOfMark(top.mark, top.cues[0])[0] === classified.expected;
      }
      if (under) calendar.hit += 1;
      if (answered && !under) {
        calendar.converted += 1;
        calendar.split[half].converted += 1;
      }
      if (!answered && under) {
        calendar.lost += 1;
        calendar.split[half].lost += 1;
      }
    }
    // The ceiling: a table with no column any mark can group by is a population, not a score. Its
    // refused rows are the most an index-axis encoding could buy, and they are published beside the
    // hit count so that a shape nobody can encode is not read as a ranking that lost. A table that
    // would not profile is not part of it: it has no shape to read, and `noProfile` already owns it.
    if (profiles.length > 0 && controlDims === 0) {
      ceiling.rows += 1;
      const cell = ceiling.byFamily.get(classified.expected) ?? { n: 0, refused: 0 };
      cell.n += 1;
      if (classified.outcome === 'refused') {
        ceiling.refused += 1;
        cell.refused += 1;
        ceiling.marks.set(classified.covering, (ceiling.marks.get(classified.covering) ?? 0) + 1);
        if (ceiling.samples.length < 3) ceiling.samples.push(snippet(row.prompt));
      }
      ceiling.byFamily.set(classified.expected, cell);
    }
    // The labels whose picture the contract cannot lead with. Counted for every row rather than only
    // for the misses: the point of the population is the denominator, and a denominator that dropped
    // out when the ranking happened to be right would be a share of whatever was left.
    if (outOfReach.includes(classified.expected)) {
      unreachableRows += 1;
      const cell = unreachable.get(classified.expected) ?? { n: 0, outcome: emptyOutcome(), coveredBy: undefined };
      cell.n += 1;
      cell.outcome[classified.outcome] += 1;
      if (cell.coveredBy === undefined && classified.outcome === 'substituted') cell.coveredBy = classified.answered;
      unreachable.set(classified.expected, cell);
    }
    const mistyped = profiles.length === 0 ? [] : timeLikeColumns(set, profiles);
    if (mistyped.length > 0) timeLikeRows += 1;
    for (const column of mistyped) {
      const entry = timeLike.get(column.column) ?? { ...column, n: 0 };
      entry.n += 1;
      timeLike.set(column.column, entry);
    }
    if (set.rows.some((cells) => cells.some((cell) => isMissingCell(cell)))) missingRows += 1;
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
    calendar: {
      rule: 'a contiguous run of years is a measure again',
      rows: calendar.rows,
      hit: calendar.hit,
      converted: calendar.converted,
      lost: calendar.lost,
      split: calendar.split,
    },
    ceiling: {
      rows: ceiling.rows,
      refused: ceiling.refused,
      byFamily: [...ceiling.byFamily.entries()]
        .map(([family, cell]) => ({ family, n: cell.n, refused: cell.refused }))
        .sort((left, right) => right.n - left.n || left.family.localeCompare(right.family)),
      marks: [...ceiling.marks.entries()]
        .map(([mark, n]) => ({ mark, n }))
        .sort((left, right) => right.n - left.n || left.mark.localeCompare(right.mark)),
      samples: ceiling.samples,
    },
    unreachable: {
      rows: unreachableRows,
      byFamily: [...unreachable.entries()]
        .map(([family, cell]) => ({
          family,
          n: cell.n,
          outcome: cell.outcome,
          ...(cell.coveredBy === undefined ? {} : { coveredBy: cell.coveredBy }),
        }))
        .sort((left, right) => right.n - left.n || left.family.localeCompare(right.family)),
    },
    renderable: scored - unreachableRows,
    hitShareRenderable: scored === unreachableRows ? 0 : outcomes.hit / (scored - unreachableRows),
    timeLike: [...timeLike.values()].sort(
      (left, right) => right.n - left.n || left.column.localeCompare(right.column),
    ),
    timeLikeRows,
    coerced: [...coerced.values()].sort((left, right) => right.n - left.n || left.column.localeCompare(right.column)),
    coercedRows,
    missingRows,
    measureless: { tables: measurelessTables, refused: measurelessRefused },
    numerals: [...numerals.values()].sort(
      (left, right) => right.n - left.n || left.column.localeCompare(right.column) || left.cell.localeCompare(right.cell),
    ),
    product: PRODUCT_CANDIDATES.map((candidate) => {
      const tally = product.get(candidate.name) as ProductTally;
      return {
        variant: candidate.name,
        note: candidate.note,
        hit: tally.hit,
        hitShare: scored === 0 ? 0 : tally.hit / scored,
        split: { a: tally.split.a, b: tally.split.b },
        moved: tally.moved,
        shortlist: tally.shortlist,
        substituted: tally.substituted,
        byFamily: [...tally.byFamily.entries()]
          .map(([family, cell]) => ({ family, n: cell.n, hit: cell.hit }))
          .sort((left, right) => right.n - left.n || left.family.localeCompare(right.family)),
      };
    }),
    variant: options.variant ?? 'census',
  };
}

/**
 * The arithmetic a report can be wrong about, refused rather than published.
 *
 * Every scored row lands in exactly one of the seven outcomes, and the per-family rows sum to the
 * scored population. A report that breaks either is a share computed on the wrong denominator.
 */
export function assertCensusReport(report: CensusReport): void {
  const sum = Object.values(report.outcomes).reduce((total, count) => total + count, 0);
  if (sum !== report.scored) {
    throw new Error(
      `census report: the seven outcomes sum to ${String(sum)} and ${String(report.scored)} rows were scored`,
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
  // The same identity for the typing, and for the same reason: this one is an *ablation* rather than
  // a prediction — it removes a shipped rule and re-ranks — so a reader quoting the price of the
  // calendar rule is quoting a measurement, and a measurement has to reconcile with the count it is
  // quoted against.
  const calendar = report.calendar;
  if (calendar.hit !== report.outcomes.hit - calendar.converted + calendar.lost) {
    throw new Error(
      `census report: un-typing the calendar reads ${String(calendar.hit)} hits, which is not ${String(report.outcomes.hit)} - ${String(calendar.converted)} converted + ${String(calendar.lost)} lost`,
    );
  }
  if (calendar.split.a.converted + calendar.split.b.converted !== calendar.converted) {
    throw new Error(
      `census report: the calendar rule's two halves gain ${String(calendar.split.a.converted)} + ${String(calendar.split.b.converted)} rows, which is not the ${String(calendar.converted)} it reports`,
    );
  }
  if (calendar.split.a.lost + calendar.split.b.lost !== calendar.lost) {
    throw new Error(
      `census report: the calendar rule's two halves lose ${String(calendar.split.a.lost)} + ${String(calendar.split.b.lost)} rows, which is not the ${String(calendar.lost)} it reports`,
    );
  }
  if (calendar.converted + calendar.lost > calendar.rows) {
    throw new Error(
      `census report: the calendar rule moved ${String(calendar.converted + calendar.lost)} rows out of the ${String(calendar.rows)} that carry one`,
    );
  }
  // The ceiling is a population and not a bucket of its own: every row in it is a scored row, and the
  // refused rows are a subset of the refusals the report already publishes. A ceiling larger than the
  // corpus, or a refusal count larger than the ceiling, is a share about to be taken over nothing.
  const ceiling = report.ceiling;
  if (ceiling.refused > ceiling.rows) {
    throw new Error(
      `census report: the ceiling reports ${String(ceiling.refused)} refusals out of ${String(ceiling.rows)} rows without an axis`,
    );
  }
  if (ceiling.refused > report.outcomes.refused) {
    throw new Error(
      `census report: the ceiling claims ${String(ceiling.refused)} refusals and the corpus has ${String(report.outcomes.refused)}`,
    );
  }
  const inCeiling = ceiling.byFamily.reduce((total, entry) => total + entry.n, 0);
  if (inCeiling !== ceiling.rows) {
    throw new Error(
      `census report: the ceiling's families account for ${String(inCeiling)} rows and the ceiling is ${String(ceiling.rows)}`,
    );
  }
  const refusedInCeiling = ceiling.byFamily.reduce((total, entry) => total + entry.refused, 0);
  if (refusedInCeiling !== ceiling.refused) {
    throw new Error(
      `census report: the ceiling's families account for ${String(refusedInCeiling)} refusals and the ceiling reports ${String(ceiling.refused)}`,
    );
  }
  const marksInCeiling = ceiling.marks.reduce((total, entry) => total + entry.n, 0);
  if (marksInCeiling !== ceiling.refused) {
    throw new Error(
      `census report: the ceiling's marks account for ${String(marksInCeiling)} refusals and the ceiling reports ${String(ceiling.refused)}`,
    );
  }
  // The unreachable population and the renderable denominator are two readings of one partition, so
  // they add to the scored rows and each family's rows add to the population. A report where they do
  // not is quoting the ranking against a denominator it invented.
  const unreachable = report.unreachable;
  const inUnreachable = unreachable.byFamily.reduce((total, entry) => total + entry.n, 0);
  if (inUnreachable !== unreachable.rows) {
    throw new Error(
      `census report: the unreachable families account for ${String(inUnreachable)} rows and the population is ${String(unreachable.rows)}`,
    );
  }
  if (report.renderable + unreachable.rows !== report.scored) {
    throw new Error(
      `census report: ${String(report.renderable)} renderable rows and the unreachable population of ${String(unreachable.rows)} are not the ${String(report.scored)} scored rows`,
    );
  }
  // A family cannot claim more of an outcome than the corpus recorded for rows with that label: the
  // outcome counts are the same rows, read a second time.
  for (const entry of unreachable.byFamily) {
    const claimed = entry.outcome.hit;
    const actual = report.byFamily.find((cell) => cell.family === entry.family)?.hit ?? 0;
    if (claimed !== actual) {
      throw new Error(
        `census report: the unreachable family ${entry.family} claims ${String(claimed)} hits and the corpus has ${String(actual)}`,
      );
    }
  }
  // The product sweep's first entry is the table that ships, scored through a second code path: the
  // census classifies a row once inside `classify` and the sweep asks the same question again from
  // the row loop. Two computations of one number, so a disagreement is a defect in whichever one
  // drifted — and the alternative, publishing a candidate's gain against a control nobody
  // re-measured, is the defect this identity exists to make impossible.
  const shipped = report.product[0];
  if (shipped === undefined || shipped.variant !== 'shipped') {
    throw new Error('census report: the product sweep must begin with the shipped table, which is the control every delta is read against');
  }
  if (shipped.hit !== report.outcomes.hit) {
    throw new Error(
      `census report: the product sweep reads ${String(shipped.hit)} hits for the shipped table and the census reads ${String(report.outcomes.hit)}, so one of the two is not the product`,
    );
  }
  if (shipped.moved !== 0) {
    throw new Error(
      `census report: the control claims it changed ${String(shipped.moved)} answers, and a table cannot differ from itself`,
    );
  }
  for (const variant of report.product) {
    const population = variant.byFamily.reduce((total, cell) => total + cell.n, 0);
    if (population !== report.scored) {
      throw new Error(
        `census report: variant ${variant.variant} was priced on ${String(population)} rows against ${String(report.scored)} scored, so the comparison is between two corpora`,
      );
    }
    // The shortlist is the hits plus the rows covered as a second claim, so it is a partition of the
    // rows the table answers with the label's family at all. A candidate whose shortlist is not the
    // sum of its own two counts is publishing a number about a different population.
    if (variant.shortlist !== variant.hit + variant.substituted) {
      throw new Error(
        `census report: variant ${variant.variant} reads a shortlist of ${String(variant.shortlist)} against ${String(variant.hit)} hits and ${String(variant.substituted)} substituted, which is not the sum of the two`,
      );
    }
    if (variant.shortlist > report.scored) {
      throw new Error(
        `census report: variant ${variant.variant} shortlists ${String(variant.shortlist)} rows of ${String(report.scored)}`,
      );
    }
    // The two halves are a partition of the hits, so they add to the count they partition. A split
    // that adds to something else is a second population wearing the first one's denominator.
    if (variant.split.a + variant.split.b !== variant.hit) {
      throw new Error(
        `census report: variant ${variant.variant} reads ${String(variant.split.a)} + ${String(variant.split.b)} hits in its two halves, which is not the ${String(variant.hit)} it reports, so one of the halves is not a half`,
      );
    }
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
    `  hit ${String(outcome.hit)} (${share(outcome.hit)}), substituted ${String(outcome.substituted)}, reshaped ${String(outcome.reshaped)}, binned ${String(outcome.binned)}, refused ${String(outcome.refused)} (${share(outcome.refused)}), outranked ${String(outcome.outranked)} (${share(outcome.outranked)}), uncovered ${String(outcome.uncovered)}, no profile ${String(outcome.noProfile)}`,
    `  hit + substituted is the shortlist the profile file publishes: ${String(outcome.hit + outcome.substituted)} of ${String(report.scored)}`,
    `  time-formatted columns the profiler did not call temporal: ${String(report.timeLikeRows)} rows`,
    `  columns that are numbers only after their formatting is read: ${String(report.coercedRows)} rows`,
    `  cells that spell a missing value: ${String(report.missingRows)} rows`,
  ];
  if (report.unreachable.rows > 0) {
    const renderable = report.renderable;
    lines.push(
      `  labels no mark can lead with (${report.unreachable.byFamily.map((entry) => entry.family).join(', ')}): ${String(report.unreachable.rows)} rows, so ${String(report.outcomes.hit)} hit of ${String(renderable)} renderable rows (${(report.hitShareRenderable * 100).toFixed(2)}%), against ${String(report.outcomes.hit)} of ${String(report.scored)} (${(report.outcomes.hit / Math.max(1, report.scored) * 100).toFixed(2)}%)`,
    );
    for (const entry of report.unreachable.byFamily) {
      const took = Object.entries(entry.outcome)
        .filter(([, count]) => count > 0)
        .map(([name, count]) => `${name} ${String(count)}`)
        .join(', ');
      lines.push(`    ${entry.family}: ${String(entry.n)} rows (${took})${entry.coveredBy === undefined ? '' : ` — drawn as a ${entry.coveredBy}`}`);
    }
  }
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
  // The ablation of a rule that already shipped, printed in the direction it was shipped: what the
  // product would lose if the typing went back. A counterfactual that is never run again is a claim
  // about a commit; this one is a claim about the tree.
  const calendar = report.calendar;
  lines.push(
    `  as if ${calendar.rule}: hit ${String(outcome.hit)} -> ${String(calendar.hit)} (converted ${String(calendar.converted)}, lost ${String(calendar.lost)}, halves ${String(calendar.split.a.converted)}/${String(calendar.split.a.lost)} and ${String(calendar.split.b.converted)}/${String(calendar.split.b.lost)}) — the shipped typing, ablated`,
  );
  // The ceiling, printed after the two counterfactuals because it is not one: a row here has no
  // candidate to rank, and the count says how much of the denominator is out of reach before any
  // rule changes.
  const ceiling = report.ceiling;
  if (ceiling.rows > 0) {
    const families = ceiling.byFamily
      .slice(0, 4)
      .map((entry) => `${entry.family} ${String(entry.n)}/${String(entry.refused)}`)
      .join(', ');
    lines.push(
      `  tables with no axis at all (the ceiling of an index-axis encoding): ${String(ceiling.rows)} rows, ${String(ceiling.refused)} refused a mark that needs one — ${families}`,
    );
    for (const sample of ceiling.samples.slice(0, 2)) lines.push(`    e.g. "${sample}"`);
  }
  lines.push(...describeProduct(report));
  return lines;
}

/**
 * Every cue table on the product path, each delta against the table that ships.
 *
 * This is the half the cue-only sweep cannot see, and the reason a phrase change is no longer decided
 * on the question alone: a table can gain rows where the question named the right picture and lose
 * more where the result set refused it. The per-family columns are printed for the families that
 * moved, because "hit +2" and "bar +2, pie −2" are the same total and not the same product.
 */
export function describeProduct(report: CensusReport): readonly string[] {
  const control = report.product[0];
  if (control === undefined) return [];
  const lines = [`  the same rows on the product, ${String(report.product.length)} tables, each delta against ${control.variant}:`];
  for (const variant of report.product) {
    const moved =
      variant === control
        ? []
        : variant.byFamily
            .map((cell) => ({ family: cell.family, delta: cell.hit - hitOf(control, cell.family) }))
            .filter((cell) => cell.delta !== 0)
            .sort((left, right) => right.delta - left.delta)
            .map((cell) => `${cell.family} ${cell.delta > 0 ? '+' : ''}${String(cell.delta)}`);
    // A candidate can move the shortlist without moving a hit, and printing only the hit reads as
    // "this table does nothing": the histogram cue answers a histogram question with a bar, which
    // covers the family as its second claim, so the row leaves `uncovered` for `substituted` and a
    // user sees a picture of the distribution instead of a boxplot of a different question.
    const shelf = variant === control ? 0 : variant.shortlist - control.shortlist;
    const shelfNote = shelf === 0 ? '' : `  |  shortlist ${shelf > 0 ? '+' : ''}${String(shelf)}`;
    lines.push(
      `    ${variant.variant.padEnd(24)} hit ${String(variant.hit).padStart(4)} (${(variant.hitShare * 100).toFixed(2)}%)${moved.length === 0 ? '' : `  |  ${moved.join(', ')}`}${shelfNote}`,
    );
  }
  return lines;
}

/** A family's hit count in one product reading, or zero when that reading has no row for it. */
function hitOf(variant: ProductVariant, family: ChartFamily): number {
  return variant.byFamily.find((cell) => cell.family === family)?.hit ?? 0;
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
