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
import { profileRows, recommendChart, type FieldProfile, type RecommendableMark } from '@agentix-e/nl2charts-chart';
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
 * Parse one `Table Data` cell.
 *
 * The corpus writes these as CSV and uses the same quoting rules as the file that carries them, so
 * the parser is `parseCsv` rather than a second one: a value like `"Korea, Rep."` is one column in
 * both places or the profile of one of them is wrong. Blank lines are dropped — the field is
 * line-oriented and a trailing newline is not a row — and a row is kept only when it has as many
 * cells as the header, because a short row is a corrupt table rather than a row with a null.
 */
export function parseResultSet(text: string): ResultSet {
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

/**
 * The table as the profiler wants it: one object per row, cells typed by what they hold.
 *
 * Numbers are converted because the profiler's type inference reads JavaScript types: a column of
 * `"43.54"` strings would be `nominal` and every measure would disappear from the profile, which
 * turns every bar into a refusal and the whole reading into a number about parsing. The test for
 * "is this a number" is the one `Number` and `Number.isFinite` agree on, with the empty cell left
 * as the empty string rather than coerced to zero — a missing value is not a value of zero, and a
 * measure whose minimum is an artefact of missing data would decide a range-based rule wrongly.
 */
export function typedRows(set: ResultSet): Record<string, unknown>[] {
  return set.rows.map((cells) => {
    const row: Record<string, unknown> = {};
    for (const [index, name] of set.columns.entries()) {
      const cell = (cells[index] as string).trim();
      if (cell.length === 0) {
        row[name] = null;
        continue;
      }
      const numeric = Number(cell);
      row[name] = Number.isFinite(numeric) && !/^0\d/.test(cell) ? numeric : cell;
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
  return profileRows(typedRows(set));
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
  const profiles = profilesOf(set);
  if (profiles.length === 0) return { mark: 'declined', families: [], reasons: ['profile:none'] };
  // The shipped cue table, and only it: `recommendChart` reads `CHART_CUES` internally, so the
  // sweep in `rule.ts` — which is about which words name which mark — is a different instrument.
  // A profile reading against a variant table would be two levers in one number.
  const choice = recommendChart(prompt, profiles);
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
export function scoreProfile(rows: readonly ProfileInput[], options: { readonly variant?: string } = {}): ProfileReport {
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
    const answer = profileAnswer(row.prompt, row.tableData);
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
  const moved = report.perLabel
    .map((entry) => ({ family: entry.family, delta: entry.top1 - cueOf(entry.family) }))
    .filter((entry) => entry.delta !== 0)
    .sort((left, right) => right.delta - left.delta);
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
