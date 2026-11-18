/**
 * The chart half, scored with the result set in front of it.
 *
 * `rule.ts` scores the cue table: a question in, a mark out, compared with the label the corpus
 * states. Its own header says what that leaves out, and the second item is this file — "the
 * recommender decides a mark from cues *and* the result set's shape, and with no result set only
 * the cue half can run". The reading it produces (~37% top-1) is therefore a number about half of
 * the product, and the half it omits is the one that can refuse a mark: a pie over twenty
 * countries is not a pie, whatever the question asked.
 *
 * Text2Vis ships the result set in `Table Data`, as CSV. That makes the missing half cheap: no
 * model, no database, no renderer — parse the table, profile it, and hand the profiles to the same
 * `recommendChart` the product ships.
 *
 * **What this measures, and what it does not.** The profiles come from the corpus's own table,
 * which is the result set the chart was drawn from — not from a query the product ran. So this is
 * the *accuracy ceiling* of the profile half under a perfect result set, in the same sense
 * `samples-gold` is the ceiling of the value block: it says how much a correct profile is worth
 * before anyone spends a call getting one. A number below the cue-only reading would mean the
 * recommender's shape rules cost accuracy and the product's ranking is wrong; a number above it is
 * the budget the query side has to hit.
 *
 * **What the labels do not carry.** A label is one annotator's judgement, the corpus's tables are
 * small, and the product renders a mark the corpus may name differently (`Donut` is a `pie` with a
 * hole). Families are compared, never labels, and an unmapped label is excluded and published with
 * its count — the same rule `rule.ts` states and for the same reason.
 */
import { meltWide, profileRows, recommendChart, type FieldProfile, type RecommendableMark } from '@agentix-e/nl2charts-chart';
import { applyExitCode, isEntry, loadText2Vis, parseCsv, type LoadOptions, type Text2VisRow } from './dataset.js';
import { familiesOfMark, familyOfLabel, scoreRule, type ChartFamily, type RuleInput, type RuleReport } from './rule.js';

/** One question, the chart the corpus says is right, and the result set it drew. */
export interface ProfileInput extends RuleInput {
  /** The corpus's `Table Data` cell, verbatim: CSV, first row is the header. */
  readonly tableData: string;
}

/** A result set, as the corpus spells it: a header and rectangular rows of text. */
export interface ResultSet {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/**
 * A table the corpus writes as an object of columns rather than as a CSV.
 *
 * 196 of the corpus's 1,985 `Table Data` cells are a JSON object whose values are equal-length lists —
 * `{"Year": [2018, 2019], "Coal": [1000, 950]}` — because the questions around them ask for Python
 * and the table was written the way Python prints one. The CSV reader read the whole object as a
 * one-line header, so the table had no rows, the profiler had no columns, and every mark was
 * refused: those rows were then counted as the recommender declining a chartable table. They are
 * 164 of the 352 declined rows the published reading carried, which is the largest single defect any
 * reading of this corpus has found — and it is a defect of this instrument, not of the product.
 *
 * Three answers rather than two, because the two failures have two repairs. A brace that is not JSON
 * at all is a CSV whose first cell starts with `{` and falls back to the CSV reader; a JSON object
 * that cannot be read as a rectangle — a column that is not a list, two columns of different
 * lengths, an empty column — is refused, since the representation *is* an object and padding it
 * would invent rows. A JSON array is refused for the reason it cannot be read: it is rows without a
 * header, and a column name invented here would be a field the result set never had.
 */
type ObjectTable = { readonly kind: 'table'; readonly set: ResultSet } | { readonly kind: 'refused' } | { readonly kind: 'csv' };

/** One cell of a column list, as the string the CSV reader would have produced for the same value. */
function cellOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return String(value as number | boolean);
}

function readObjectTable(text: string): ObjectTable {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { kind: 'csv' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: 'csv' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'refused' };
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return { kind: 'refused' };
  if (!entries.every(([, value]) => Array.isArray(value))) return { kind: 'refused' };
  const lists = entries.map(([, value]) => value as unknown[]);
  // A list of lists is a column of cells that are not cells. Reading one as `'1,2'` would be this
  // parser writing a value the table does not hold, so it is refused instead.
  if (!lists.every((list) => list.every((cell) => cell === null || typeof cell !== 'object'))) return { kind: 'refused' };
  const height = (lists[0] as unknown[]).length;
  if (height === 0) return { kind: 'refused' };
  if (!lists.every((list) => list.length === height)) return { kind: 'refused' };
  const rows = Array.from({ length: height }, (_, index) => lists.map((list) => cellOf(list[index])));
  return { kind: 'table', set: { columns: entries.map(([name]) => name), rows } };
}

/**
 * Parse one `Table Data` cell.
 *
 * The corpus writes these as CSV and uses the same quoting rules as the file that carries them, so
 * the parser is `parseCsv` rather than a second one: a value like `"Korea, Rep."` is one column in
 * both places or the profile of one of them is wrong. Blank lines are dropped — the field is
 * line-oriented and a trailing newline is not a row — and a row is kept only when it has as many
 * cells as the header, because a short row is a corrupt table rather than a row with a null.
 *
 * A cell that holds a JSON object of columns is read by `readObjectTable` first, for the reason that
 * type states. The two paths produce the same `ResultSet`, which is what lets the profile of a table
 * be independent of how the corpus happened to spell it.
 */
export function parseResultSet(text: string): ResultSet {
  const object = readObjectTable(text);
  if (object.kind === 'refused') return { columns: [], rows: [] };
  if (object.kind === 'table') return object.set;
  const parsed = parseCsv(text);
  const columns = parsed.columns.map((name) => name.trim());
  // A blank line is not a row. `parseCsv` pads a short row to the header's width rather than
  // dropping it, so the only line that can be empty is a line that was empty: the field is
  // line-oriented and the file ends with a newline.
  //
  // Cells are trimmed here rather than at the point of use, because the corpus writes its tables
  // with a space after the comma: `Nigeria, 43.54` would otherwise give a measure the value
  // `" 43.54"`, and every column of every row in this family would be `nominal`. One place decides
  // it, and it is the place that produced the cells.
  const rows = parsed.rows
    .filter((cells) => cells.some((cell) => cell.trim().length > 0))
    .map((cells) => cells.map((cell) => cell.trim()));
  return { columns, rows };
}

/** A currency sign a result set may prefix a measure with. */
const CURRENCY = /^[$€£¥₹]\s?/;

/** Groups of three digits, which is the only comma placement that means a thousands separator. */
const GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/**
 * A cell a result set prints for a value that is not there.
 *
 * `-` is how a driver renders NULL and how this corpus carries one, and reading it as the *string*
 * `'-'` made the whole column text: a revenue column of fifteen numbers and one dash had no
 * measure, and every mark that needs one was refused. That is 192 of the 277 corpus rows whose table
 * offered no measure at all — the largest single reason a question was answered with nothing, and it
 * was not a fact about the data.
 *
 * The spellings are the ones a result set actually prints, and the list stops where reading would
 * start guessing: `No data` is two words, and a rule that read phrases would read `None of the above`
 * as a missing region. `5-10` is a band and not a NULL, which is why the match is on the whole cell.
 */
const MISSING = /^(?:-+|—|–|n\/?a|null|none|\.)$/i;

/**
 * Whether a cell is a printed absence rather than a value.
 *
 * Exported because the census counts the rows this reads, so a reader can see how many answers the
 * repair is responsible for instead of taking the column types on trust.
 */
export function isMissingCell(cell: string): boolean {
  return MISSING.test(cell.trim());
}

/**
 * The number a cell holds, including the formatting a result set is displayed with.
 *
 * `Number('1,234')` is `NaN`, and that one fact refused 389 of the 890 refusals the census counted on
 * Text2Vis: a revenue column formatted with thousands separators typed `nominal`, the table had no
 * measure, and every mark that needs one — bar, line, pie, scatter, boxplot — was ruled out. The
 * corpus ships `Table Data` as text copied out of a database, and a driver with a typed schema would
 * hand the product numbers instead, so reading the formatting here is this instrument modelling the
 * layer the corpus omits rather than the product being lenient about its input.
 *
 * The formats are the ones a result set actually writes: grouped digits, a leading currency sign, a
 * trailing percent (kept as written — a chart cares about relative height, not about the unit), and
 * an accounting negative in parentheses. What is not read is deliberately not read: a space-grouped
 * number is indistinguishable from two words, and a European `1.234,56` would require guessing which
 * separator is the decimal one, so both stay text and the column stays a category.
 */
export function numericCell(cell: string): number | undefined {
  const text = cell.trim();
  if (text.length === 0) return undefined;
  const parenthesised = /^\((.*)\)$/.exec(text);
  const body = (parenthesised?.[1] ?? text).replace(CURRENCY, '').replace(/%$/, '').trim();
  const plain = GROUPED.test(body) ? body.replace(/,/g, '') : body;
  // A leading zero is a code — a zip, an account number — and not a quantity. This is the rule the
  // unformatted path applied before any formatting was read, kept in one place for both.
  if (plain.length === 0 || /^0\d/.test(plain)) return undefined;
  const value = Number(plain);
  if (!Number.isFinite(value)) return undefined;
  return parenthesised === null ? value : -value;
}

/**
 * The table as the profiler wants it: one object per row, cells typed by what they hold.
 *
 * Numbers are converted because the profiler's type inference reads JavaScript types: a column of
 * `"43.54"` strings would be `nominal` and every measure would disappear from the profile, which
 * turns every bar into a refusal and the whole reading into a number about parsing. The empty cell
 * stays `null` rather than becoming zero — a missing value is not a value of zero, and a measure
 * whose minimum is an artefact of missing data would decide a range-based rule wrongly.
 */
export function typedRows(set: ResultSet): Record<string, unknown>[] {
  return set.rows.map((cells) => {
    const row: Record<string, unknown> = {};
    for (const [index, name] of set.columns.entries()) {
      const cell = (cells[index] as string).trim();
      if (cell.length === 0 || isMissingCell(cell)) {
        row[name] = null;
        continue;
      }
      const numeric = numericCell(cell);
      row[name] = numeric === undefined ? cell : numeric;
    }
    return row;
  });
}

/**
 * The profiles the recommender ranks on, or nothing when the table cannot be read.
 *
 * The profile is the product's own (`profileRows`), imported rather than restated: a second
 * implementation of "what type is this column" would be a second answer to the question the
 * admission rules ask, and the reading would then be about the copy.
 */
export function profilesOf(set: ResultSet): FieldProfile[] {
  if (set.columns.length === 0 || set.rows.length === 0) return [];
  return profileRows(typedRows(set), set.columns);
}

/** What the recommender answered for one row, with the families the answer is allowed to cover. */
export interface ProfileAnswer {
  readonly mark: RecommendableMark | 'declined';
  readonly families: readonly ChartFamily[];
  /** The recommendation's own reasons, kept so a wrong answer can be read without a rerun. */
  readonly reasons: readonly string[];
}

/**
 * The product's answer for one case.
 *
 * `declined` is a real answer and not a miss by default: every admission rule can refuse, and a
 * table whose columns the profiler cannot type refuses all of them. Counting that as a wrong answer
 * would blame the ranking for a parsing failure, and the count is published separately for exactly
 * that reason.
 */
export function profileAnswer(prompt: string, tableData: string): ProfileAnswer {
  const set = parseResultSet(tableData);
  // The reshape comes first, because the product's answer does. A table that is wide in time is
  // drawn as one line per entity by `toChartIR` without asking an admission rule, so a reading that
  // let every rule refuse it would report the product declining a table it charts — and the render
  // report, reading the same rows, would publish a different `declined` count for the same corpus.
  // Two instruments disagreeing about "the product answered nothing" is the defect both of them
  // exist to catch, so the one that runs offline asks the same predicate the pipeline asks.
  if (meltWide(typedRows(set), set.columns) !== undefined) {
    return { mark: 'line', families: familiesOfMark('line'), reasons: ['melt:wide'] };
  }
  const profiles = profilesOf(set);
  if (profiles.length === 0) return { mark: 'declined', families: [], reasons: ['profile:none'] };
  // The shipped cue table, and only it. `recommendChart` now takes a table as an option, and the
  // census is where that seam is used: it prices every candidate on the product path, against the
  // same rows, so a cue change is decided by both readings rather than by the one that ignores
  // admission. This function stays single-table because it is the *published* reading of the product
  // that ships, and a reading that could be run against a candidate would stop being that.
  // The row count is what lets a table with no measure be charted by counting its rows, and it is
  // the one fact the profiles cannot carry. It is passed here because this is the *published* reading
  // of the product: a path that withheld it would publish a number about a recommender the caller of
  // `toChartIR` never gets.
  const choice = recommendChart(prompt, profiles, { rows: set.rows.length });
  const top = choice.recommendations[0];
  if (top === undefined) return { mark: 'declined', families: [], reasons: ['profile:refused'] };
  const cue = top.cues[0];
  return { mark: top.mark, families: familiesOfMark(top.mark, cue), reasons: top.reasons };
}

/**
 * One result set per family, so the report can say where a refusal came from.
 *
 * The question a profile reading has to answer about itself is not "was it right" but "did it
 * decline because the recommender refused, or because the table would not parse" — two failures
 * with two different repairs.
 */
export interface ProfileReport {
  readonly rows: number;
  readonly unmapped: { readonly count: number; readonly labels: readonly { readonly label: string; readonly n: number }[] };
  readonly scored: number;
  readonly top1: number;
  readonly top1Share: number;
  readonly shortlist: number;
  readonly shortlistShare: number;
  readonly declined: number;
  /**
   * Rows where the recommender named a mark that cannot cover the expected family.
   *
   * The bucket this report did not have at first, and Text2Vis found it on the first paid run: a
   * question about the leading region is answered `bar`, the label is `line`, and the row is neither
   * a shortlist hit nor a refusal. On the 1,470 scored rows it is **684** — the largest of the three
   * — so `shortlist + declined < scored` and the report refused to publish, which is the whole reason
   * the identity is asserted instead of described.
   */
  readonly missed: number;
  readonly baseline: { readonly mostFrequent: ChartFamily; readonly share: number; readonly bar: number };
  readonly perLabel: readonly { readonly label: string; readonly family: ChartFamily; readonly n: number; readonly top1: number; readonly shortlist: number; readonly answered: readonly { readonly mark: RecommendableMark | 'declined'; readonly n: number }[] }[];
  readonly confusion: readonly { readonly expected: ChartFamily; readonly answered: RecommendableMark | 'declined'; readonly n: number }[];
  readonly variant: string;
}

/**
 * Price one cue table with the result set in front of the recommender.
 *
 * The arithmetic identity is the instrument, as it is in `rule.ts`: every scored row is a shortlist
 * hit, a refusal, or a miss — `shortlist + declined + missed === scored` — and a report that breaks
 * it is refused rather than published. The identity is checked here instead of in a second pass
 * because the two scorers disagree about nothing else: a row is scored when its label has a family,
 * and every scored row is exactly one of the three. The middle bucket was missing from the first
 * version of this function and the assertion is what caught it.
 */
/**
 * One answer for one question, in the only three shapes the scorer knows.
 *
 * `families` travels with the mark for the reason `rule.ts` gives: a bar answers for a histogram only
 * when a cue named it, and a line answers for an area unconditionally. The scorer reads the *first*
 * family as the top-1 claim and the whole list as the shortlist, so an answer function that returned
 * only a mark would have made one of the two readings impossible.
 */
export interface ChartAnswer {
  readonly mark: RecommendableMark | 'declined';
  readonly families: readonly ChartFamily[];
}

/**
 * Price any answer function against the corpus.
 *
 * Extracted from `scoreProfile` in the round that added a second thing that answers the same question
 * — a language model given only the question, with no result set at all. Two scorers written side by
 * side would be two definitions of "hit", and the comparison between the two arms is a subtraction of
 * their totals: a subtraction of two numbers built by different arithmetic is a difference between the
 * arithmetic and not between the arms. Everything about the corpus, the denominators, the identity and
 * the baselines is therefore shared, and the only thing an arm brings is where its answer came from.
 */
export function scoreAnswers(
  rows: readonly ProfileInput[],
  answerOf: (row: ProfileInput) => ChartAnswer,
  options: { readonly variant?: string } = {},
): ProfileReport {
  const perLabel = new Map<
    string,
    { family: ChartFamily; n: number; top1: number; shortlist: number; answered: Map<RecommendableMark | 'declined', number> }
  >();
  const confusion = new Map<string, { expected: ChartFamily; answered: RecommendableMark | 'declined'; n: number }>();
  const unmappedLabels = new Map<string, number>();
  let scored = 0;
  let top1 = 0;
  let shortlist = 0;
  let declined = 0;
  let missed = 0;

  for (const row of rows) {
    const family = familyOfLabel(row.label);
    if (family === undefined) {
      unmappedLabels.set(row.label, (unmappedLabels.get(row.label) ?? 0) + 1);
      continue;
    }
    const answer = answerOf(row);
    scored += 1;
    const bucket = perLabel.get(row.label) ?? { family, n: 0, top1: 0, shortlist: 0, answered: new Map() };
    bucket.n += 1;
    bucket.answered.set(answer.mark, (bucket.answered.get(answer.mark) ?? 0) + 1);
    perLabel.set(row.label, bucket);
    if (answer.mark === 'declined') {
      declined += 1;
      const key = `${family}\u0000declined`;
      confusion.set(key, { expected: family, answered: 'declined', n: (confusion.get(key)?.n ?? 0) + 1 });
      continue;
    }
    // The shortlist is the families the answer can cover, which is why it travels with the mark:
    // a bar named by a histogram cue covers `histogram` and a bar named by a ranking question does
    // not, and one number for both would hide the difference the sweep exists to price.
    if (!answer.families.includes(family)) {
      // A named mark that cannot cover the label's family. Not a refusal — the recommender answered,
      // it answered something the label disagrees with — and the largest bucket of the three.
      missed += 1;
    } else {
      shortlist += 1;
      bucket.shortlist += 1;
      // A hit is the *first* family the answer covers: a bar named by a histogram cue covers
      // `histogram` as its second family, and counting that as a hit would make one answer two
      // answers — the reading would then be about how many families a mark can impersonate.
      if (answer.families[0] === family) {
        top1 += 1;
        bucket.top1 += 1;
      }
    }
    const key = `${family}\u0000${answer.mark}`;
    confusion.set(key, { expected: family, answered: answer.mark, n: (confusion.get(key)?.n ?? 0) + 1 });
  }

  const counts = [...perLabel.values()].map((bucket) => bucket.n);
  const total = counts.reduce((sum, n) => sum + n, 0);
  const mostFrequent = [...perLabel.entries()].sort(([, left], [, right]) => right.n - left.n)[0];
  return {
    rows: rows.length,
    unmapped: {
      count: [...unmappedLabels.values()].reduce((sum, n) => sum + n, 0),
      labels: [...unmappedLabels.entries()].map(([label, n]) => ({ label, n })).sort((left, right) => right.n - left.n || left.label.localeCompare(right.label)),
    },
    scored: total,
    top1,
    top1Share: total === 0 ? 0 : top1 / total,
    shortlist,
    shortlistShare: total === 0 ? 0 : shortlist / total,
    declined,
    missed,
    baseline: {
      mostFrequent: mostFrequent === undefined ? 'bar' : mostFrequent[1].family,
      share: mostFrequent === undefined ? 0 : mostFrequent[1].n / Math.max(1, total),
      bar: (perLabel.get('Bar')?.n ?? 0) / Math.max(1, total),
    },
    perLabel: [...perLabel.entries()]
      .map(([label, bucket]) => ({
        label,
        family: bucket.family,
        n: bucket.n,
        top1: bucket.top1,
        shortlist: bucket.shortlist,
        answered: [...bucket.answered.entries()].map(([mark, n]) => ({ mark, n })).sort((left, right) => right.n - left.n || String(left.mark).localeCompare(String(right.mark))),
      }))
      .sort((left, right) => right.n - left.n || left.label.localeCompare(right.label)),
    confusion: [...confusion.values()].sort((left, right) => right.n - left.n || left.expected.localeCompare(right.expected)),
    variant: options.variant ?? 'profile',
  };
}

/** The product's answer, priced on its own tables. The arm the published reading is about. */
export function scoreProfile(rows: readonly ProfileInput[], options: { readonly variant?: string } = {}): ProfileReport {
  return scoreAnswers(rows, (row) => profileAnswer(row.prompt, row.tableData), options);
}

/** The corpus, as the rows this reading scores. */
export function profileInputs(corpus: { readonly rows: readonly Text2VisRow[] }): ProfileInput[] {
  return corpus.rows.map((row) => ({ prompt: row.prompt, label: row.chartType, tableData: row.raw['Table Data'] ?? '' }));
}

/**
 * The arithmetic a report can be wrong about, refused rather than published.
 *
 * The identity is the instrument: every scored row is a hit, a shortlist miss, or a refusal, and a
 * report whose three counters do not add up is a share computed on the wrong denominator — the
 * defect a reader cannot see, which is why `rule.ts` checks it too and why this file checks it
 * separately rather than trusting the other's shape.
 */
export function assertProfileReport(report: ProfileReport): void {
  if (report.top1 > report.shortlist) {
    throw new Error(`profile report: ${String(report.top1)} top-1 hits is more than ${String(report.shortlist)} shortlist hits`);
  }
  if (report.shortlist + report.declined + report.missed !== report.scored) {
    throw new Error(
      `profile report: ${String(report.shortlist)} shortlist + ${String(report.declined)} declined + ${String(report.missed)} missed is not ${String(report.scored)} scored, so a row fell out of the counters`,
    );
  }
  const perLabel = report.perLabel.reduce((sum, entry) => sum + entry.n, 0);
  if (perLabel !== report.scored) {
    throw new Error(`profile report: the per-label rows sum to ${String(perLabel)} and the score was taken over ${String(report.scored)}`);
  }
  if (report.scored + report.unmapped.count !== report.rows) {
    throw new Error(
      `profile report: ${String(report.scored)} scored + ${String(report.unmapped.count)} unmapped is not the ${String(report.rows)} rows read`,
    );
  }
}

/**
 * The lines a reader needs: two readings on one corpus, one delta line, and where the misses are.
 *
 * The cue-only number is printed beside the profile number rather than in another document, because
 * the question a profile reading answers is not "how good is the recommender" but "what does the
 * result set add to the question alone", and a delta whose control lives in another file is a delta
 * nobody can check.
 */
export function describeProfile(report: ProfileReport, cue: RuleReport): readonly string[] {
  const share = (value: number): string => `${(value * 100).toFixed(2)}%`;
  // A family's cue-only hits, summed over the labels that map to it: the cue report is per *label*
  // and this one is per family, so the two are compared on the unit they share.
  const cueOf = (family: ChartFamily): number =>
    cue.perLabel.filter((entry) => entry.family === family).reduce((sum, entry) => sum + entry.top1, 0);
  // Summed by family, not listed by label: `perLabel` is keyed by label and this line is titled by
  // family, so the first published version printed `bar +142, scatter -26, bar -27, …` on the real
  // corpus — eight bars, one number each, and no column a reader could add up.
  //
  // **Covered, not first**, because that is the test the other side is taken on. The cue report counts
  // a hit when the first mark of the leading cue *covers* the family, and this report's `top1` counts
  // one only when the mark's **first** family is the label's. Two readings of the same corpus, two
  // different predicates, and a line that subtracts them publishes the difference between the
  // predicates as a difference between the instruments: it read `area -58` on this corpus for two
  // rounds, which says the result set made the area family worse. It does not. The cue table calls a
  // line an area and this report's strict count will not, so the pair is compared on the covering
  // test they share — `shortlist` here and `top1` there — and `top1` stays strict and published on
  // its own line where a reader can see it move.
  const byFamily = new Map<ChartFamily, number>();
  for (const entry of report.perLabel) byFamily.set(entry.family, (byFamily.get(entry.family) ?? 0) + entry.shortlist);
  const moved = [...byFamily.entries()]
    .map(([family, covered]) => ({ family, delta: covered - cueOf(family) }))
    .filter((entry) => entry.delta !== 0)
    .sort((left, right) => right.delta - left.delta || left.family.localeCompare(right.family));
  const lines = [
    `text2vis: ${String(report.scored)} scored of ${String(report.rows)} rows (${String(report.unmapped.count)} unmapped labels)`,
    `  cue-only  top-1 ${share(cue.top1Share)} (${String(cue.top1)}), shortlist ${share(cue.shortlistShare)} (${String(cue.shortlist)})`,
    `  +profile  top-1 ${share(report.top1Share)} (${String(report.top1)}), shortlist ${share(report.shortlistShare)} (${String(report.shortlist)}), declined ${String(report.declined)}, missed ${String(report.missed)}`,
    `  baseline: always ${report.baseline.mostFrequent} ${share(report.baseline.share)}, always bar ${share(report.baseline.bar)}`,
  ];
  if (moved.length > 0) {
    lines.push(`  delta by family: ${moved.map((entry) => `${entry.family} ${entry.delta > 0 ? '+' : ''}${String(entry.delta)}`).join(', ')}`);
  }
  for (const entry of report.perLabel.slice(0, 12)) {
    lines.push(
      `  ${entry.label}: n=${String(entry.n)} top-1 ${share(entry.top1 / entry.n)} -> ${entry.answered
        .slice(0, 3)
        .map((answer) => `${answer.mark} (${String(answer.n)})`)
        .join(', ')}`,
    );
  }
  return lines;
}

/** The flags this command takes, and nothing else. */
export interface ProfileArgs {
  readonly artifact?: string;
  readonly json: boolean;
}

/** Parse the command line, refusing anything it does not use — the reason `parseRuleArgs` gives. */
export function parseProfileArgs(argv: readonly string[]): ProfileArgs {
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
    throw new Error(`unknown argument ${flag}: this command scores the recommender with the result set in front of it, and takes --json and --artifact <path>`);
  }
  return { json, ...(artifact === undefined ? {} : { artifact }) };
}

/**
 * Score both halves on one corpus and publish the pair.
 *
 * Two reports rather than one, because the reading is a delta: the cue table alone is what the
 * product ships today and the profile reading is what it would ship with the result set, and a
 * document that carries only the second makes the first a number a reader has to trust.
 */
export async function entryProfile(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  options: { readonly argv?: readonly string[]; readonly load?: LoadOptions } = {},
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  try {
    const args = parseProfileArgs(options.argv ?? []);
    const { corpus, source, path } = await loadText2Vis(options.load);
    log(`text2vis: ${source} ${path}`);
    const inputs = profileInputs(corpus);
    const report = scoreProfile(inputs);
    assertProfileReport(report);
    const cue = scoreRule(inputs);
    const payload = { cue, profile: report };
    if (args.json) {
      log(JSON.stringify(payload, null, 2));
    } else {
      for (const line of describeProfile(report, cue)) {
        log(line);
      }
    }
    if (args.artifact !== undefined) {
      const { mkdir, writeFile, rename } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(args.artifact), { recursive: true });
      await writeFile(`${args.artifact}.part`, `${JSON.stringify(payload, null, 2)}\n`);
      await rename(`${args.artifact}.part`, args.artifact);
      log(`text2vis: wrote ${args.artifact}`);
    }
    return report.scored === 0 ? 1 : 0;
  } catch (error) {
    log(`text2vis: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

void entryProfile(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`), {
  argv: process.argv.slice(2),
}).then((code) => applyExitCode(code, process));
