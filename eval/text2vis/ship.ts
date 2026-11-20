/**
 * The shipped path, priced on the same rows the arbitration table was priced on.
 *
 * ## What this file is for
 *
 * `arbitrate.ts` established that "the model everywhere it spoke, the table where it did not" reads
 * **861** of 1,470 against the table's 606. That number was computed by a policy over a cached
 * artifact: a `choose(dispute)` function and an answer key. It is a statement about a rule, not about
 * a product — and the difference matters, because the product has one more thing to reconcile that
 * the policy does not: the chart still has to be *drawable*.
 *
 * So this file runs the shipped code. `assistedMark` is the decision, exactly as a caller with an
 * advisor gets it; `assistedChartIR` is the drawing, and it is allowed to veto a mark the result set
 * cannot hold. Two readings come out of one pass:
 *
 * | reading | what it is | what it should equal |
 * | --- | --- | --- |
 * | `decided` | `assistedMark` on every scored row | the policy's 861, row for row |
 * | `shipped` | `assistedChartIR`, which does not ask about a wide table | at most `decided` |
 *
 * `decided === policy` is a hard identity: two implementations of one sentence, in two packages,
 * compared here on 1,470 rows. `shipped` is the honest product number and is allowed to sit below it,
 * because a veto is a real thing that happens to a real chart.
 *
 * ## Where the answers come from
 *
 * The artifact the arm already wrote. Nothing here calls a model: the answers were paid for once, the
 * cache is content-addressed, and this reading is therefore **¥0** — which is the only reason it can
 * be a gate that runs on every dispatch instead of a report somebody remembers to run.
 *
 * ## The two ways this could lie
 *
 * 1. **By scoring a population it did not ask about.** The roster is recomputed from the corpus this
 *    process loaded and compared with the artifact's, exactly as `arbitrate` does; a `--limit` run
 *    answers a prefix, and a prefix scored against the whole corpus would publish a share over rows
 *    nobody asked about.
 * 2. **By counting a veto as agreement.** A fallback nobody counts reads as a model that decided, so
 *    every reason the table answered is counted and published beside the score.
 */
import { applyExitCode, isEntry, loadText2Vis, type LoadOptions } from './dataset.js';
import { assistedChartIR, assistedMark, MARK_OPTIONS, type MarkAdvisor, type MarkName, type MarkOption } from '@agentix-e/nl2charts-chart';
import { POLICIES, disputeOf, type Policy } from './arbitrate.js';
import { markAnswer, rosterOf, scoredRows, type ArmReport } from './llm.js';
import { parseResultSet, scoreAnswers, typedRows, type ProfileInput } from './profile.js';
import type { ChartFamily } from './rule.js';

/** Why a row was answered by the table rather than by the model. */
export type ShipReason = 'no-advice' | 'unavailable' | 'unlisted' | 'wide' | 'not-admitted' | 'unchartable';

/** One row's decision, kept so the report can be audited rather than believed. */
export interface ShipRow {
  readonly mark: MarkName;
  readonly source: 'model' | 'product';
  readonly product: MarkName;
  readonly reason?: ShipReason;
  /** The model's first answer was refused by this table and its second one was drawn. */
  readonly repaired?: true;
}

/** The counts behind one rate. */
export interface ShipCounts {
  readonly hit: number;
  readonly share: number;
  /** Rows the model decided on its first answer. */
  readonly fromModel: number;
  /**
   * Rows the model decided on its *second* answer, after the table refused the first.
   *
   * Separate from `fromModel` rather than folded into it for the reason every other counter here is
   * separate: a repair is a call that only happened because the first answer was impossible, and a
   * reading that adds the two reports a gain the caller paid for as if it were free.
   */
  readonly repaired: number;
  /** Rows the table decided, for any of the reasons below. */
  readonly fromProduct: number;
  readonly reasons: Readonly<Record<ShipReason, number>>;
}

export interface ShipReport {
  readonly model: string;
  readonly population: { readonly scored: number; readonly roster: string };
  /** `assistedMark` on every scored row: the policy's number, produced by the product's decision. */
  readonly decided: ShipCounts;
  /** `assistedChartIR` on every scored row: the chart a caller actually receives. */
  readonly shipped: ShipCounts;
  /**
   * Rows whose chart differs from the decision.
   *
   * A veto is not a no-op: it replaces the model's mark with the table's, and the table's answer can be
   * *more* often right than the model's was — the 144 wide tables are line charts, and a model that
   * answered `bar` on them was wrong. So `shipped` may sit **above** `decided`, and the first version
   * of this file asserted it could not. That assertion was wrong, not the run: the constraint is that
   * every changed row was changed *to the table's answer*, which is what `shipReport` checks row by row
   * while both answers are in hand.
   */
  readonly changed: number;
  /**
   * Rows where the shipped decision and the arbitration policy name different marks.
   *
   * Computed rather than asserted in a comment, and it must be zero: the two are one sentence written
   * twice, and a row they disagree about is a row where the published 861 does not describe the
   * product. The row is printed rather than counted, because a count of disagreements is a number to
   * argue with and a row is a bug report.
   */
  readonly divergence: readonly { readonly row: number; readonly policy: string; readonly shipped: MarkName }[];
}

/** The reasons a row can fall back, in the order a reader wants them. */
const REASONS: readonly ShipReason[] = ['no-advice', 'unavailable', 'unlisted', 'wide', 'not-admitted', 'unchartable'];

/** All six at zero, so a missing reason reads as a zero rather than as a field nobody set. */
function emptyReasons(): Record<ShipReason, number> {
  return { 'no-advice': 0, unavailable: 0, unlisted: 0, wide: 0, 'not-admitted': 0, unchartable: 0 };
}

/** The rows one pass answered, scored by the same scorer every other reading uses. */
export function countsOf(
  rows: readonly ProfileInput[],
  marks: readonly MarkName[],
  decisions: readonly ShipRow[],
): ShipCounts {
  if (marks.length !== rows.length || decisions.length !== rows.length) {
    throw new Error(
      `text2vis ship: ${String(rows.length)} rows, ${String(marks.length)} marks and ${String(decisions.length)} decisions`,
    );
  }
  const byRow = new Map<ProfileInput, { mark: MarkName; families: readonly ChartFamily[] }>();
  for (let index = 0; index < rows.length; index += 1) {
    const mark = marks[index] as MarkName;
    byRow.set(rows[index] as ProfileInput, markAnswer(mark === 'declined' ? undefined : mark));
  }
  const scored = scoreAnswers(rows, (row) => byRow.get(row) as { mark: MarkName; families: readonly ChartFamily[] }, {
    variant: 'ship',
  });
  const reasons = emptyReasons();
  let fromModel = 0;
  let repaired = 0;
  for (const decision of decisions) {
    if (decision.source === 'model') {
      if (decision.repaired === true) repaired += 1;
      else fromModel += 1;
      continue;
    }
    // A table-decided row has exactly one reason, and the type says so: `reason` is required whenever
    // `source` is `product` in every branch that builds one, and a missing one here would be a row the
    // report cannot explain.
    const reason = decision.reason;
    if (reason === undefined) throw new Error('text2vis ship: a table-decided row carries no reason');
    reasons[reason] += 1;
  }
  return {
    hit: scored.top1,
    share: scored.top1Share,
    fromModel,
    repaired,
    fromProduct: decisions.length - fromModel - repaired,
    reasons,
  };
}

/**
 * One advisor over an artifact, guarded by the question it is asked.
 *
 * Positional and checked. An advisor whose answers drift by one row is a reading about the wrong
 * questions, and the guard turns that into a refusal instead of a plausible number: an offset that
 * silently shifts a corpus by one still produces a table, and that table looks exactly like a result.
 */
export function artifactAdvisor(
  rows: readonly ProfileInput[],
  choices: readonly (string | null)[],
): (question: string) => Promise<string | undefined> {
  let cursor = 0;
  return async (question: string) => {
    const index = cursor;
    cursor += 1;
    const row = rows[index];
    if (row === undefined) {
      throw new Error(`text2vis ship: the advisor was asked about "${question}", which is not a row it was given`);
    }
    if (row.prompt !== question) {
      throw new Error(`text2vis ship: answer ${String(index)} belongs to "${row.prompt}" and was asked about "${question}"`);
    }
    return choices[index] ?? undefined;
  };
}

/**
 * Which of the answers a chart took, and a refusal when it took something else.
 *
 * There are three answers a chart can be, and the third one is not a loophole: the model's first
 * answer, the model's second answer after the table refused the first, and the table's. A chart that
 * is none of them is a defect no reading should absorb — `arbitrate.ts` guards the same property for
 * the policy (`side !== modelLead` throws), and this is the guard on the shipped path, which is the
 * one a caller can actually receive. A pure function rather than a closure because the third-answer
 * branch cannot occur in a run — the types say so — and a branch nobody can reach is a branch nobody
 * can test, which is how a guard rots.
 */
export function routedBy(
  index: number,
  decided: MarkName,
  product: MarkName,
  shipped: MarkName,
  repaired = false,
): 'same' | 'repair' | 'table' {
  if (shipped === decided) return 'same';
  // Tested before the table's answer: a repair that happened to land on the table's mark is still a
  // second question that was asked and paid for, and counting it as the table's answer would make the
  // table look smarter than it was on exactly the rows the repair rescued.
  if (repaired) return 'repair';
  if (shipped === product) return 'table';
  throw new Error(
    `text2vis ship: row ${String(index)} decided ${decided}, shipped ${shipped}, and the table answers ${product}; a chart may only be one of the two`,
  );
}

/**
 * The advisor the *chart* pass uses: the same answers, looked up by question.
 *
 * Separate from `artifactAdvisor` because the two passes consume the answers differently. The deciding
 * pass asks once per row in order, so a cursor is enough and a drift is visible immediately. The chart
 * pass does not ask about a wide table at all — 144 of them on this corpus — so a cursor would be
 * wrong by exactly the number of skips. Looking the row up by its question is the only reading that
 * survives a skip, and the miss branch is a refusal rather than a silent `undefined`: an answer that
 * cannot be placed is a population that changed under the run.
 */
export function chartAdvisor(
  rows: readonly ProfileInput[],
  choices: readonly (string | null)[],
): (question: string) => Promise<string | undefined> {
  return async (question: string) => {
    const at = rows.findIndex((candidate) => candidate.prompt === question);
    if (at < 0) {
      throw new Error(`text2vis ship: the chart asked about "${question}", which is not a row of this population`);
    }
    return choices[at] ?? undefined;
  };
}

/**
 * Which question an answer belongs to: the sentence, plus the list it was asked over.
 *
 * The second question is not identified by its row — a row can carry two answers — but by its
 * *option list*, which is the only thing that differs between them. Two rows with the same question
 * and the same table are therefore one question and one answer, which is also how the store keys
 * them: the key is a hash of exactly this material.
 */
export function answerKey(question: string, options: readonly { readonly name: string }[]): string {
  return `${question}\u0000${options.map((option) => option.name).join(',')}`;
}

/** One second question the chart pass needs an answer to. */
export interface RepairAsk {
  /** Index in the population, so a caller can score the answer against the row it was asked about. */
  readonly row: number;
  readonly question: string;
  readonly options: readonly MarkOption[];
}

/**
 * Draw every row, twice if a row is refused, and report what was drawn.
 *
 * The two passes in `shipReport` differ only in whether a repair is on the table. Factoring the
 * drawing out is what lets `repairAsks` compute the *set* of second questions by running the same
 * code that will ask them, rather than by restating the rule that decides which rows need one. A
 * restated rule is the defect this repository keeps finding: it agrees with the code until the day
 * one of them changes.
 *
 * `onRow` exists for the same reason: an advisor is called about a question, not about a row, and a
 * caller that needs to know which row is being drawn cannot recover it afterwards — a wide table is
 * skipped, so the advisor's own call count is not the row index.
 */
async function drawAll(
  rows: readonly ProfileInput[],
  options: {
    readonly advisor: MarkAdvisor;
    readonly repair: boolean;
    readonly onRow?: (index: number) => void;
  },
): Promise<{ readonly marks: MarkName[]; readonly decisions: ShipRow[] }> {
  const marks: MarkName[] = [];
  const decisions: ShipRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as ProfileInput;
    const set = parseResultSet(row.tableData);
    options.onRow?.(index);
    try {
      const chart = await assistedChartIR(row.prompt, typedRows(set), {
        columns: set.columns,
        advisor: options.advisor,
        repair: options.repair,
      });
      marks.push(chart.decision.mark);
      decisions.push({
        mark: chart.decision.mark,
        source: chart.decision.source,
        product: chart.decision.product,
        ...(chart.decision.fallback === undefined ? {} : { reason: chart.decision.fallback }),
        ...(chart.decision.veto === undefined ? {} : { reason: chart.decision.veto }),
        ...(chart.decision.repaired === undefined ? {} : { repaired: true as const }),
      });
    } catch {
      // A result set no mark can hold. The table's published reading counts these as `declined`, and so
      // does this pass: a row with no chart is not a row with a wrong chart.
      marks.push('declined');
      decisions.push({ mark: 'declined', source: 'product', product: 'declined', reason: 'unchartable' });
    }
  }
  return { marks, decisions };
}

/**
 * The advisor a replayed repair reads: question one from the arm, question two from the repair file.
 *
 * The two are told apart by the list, and the difference is structural rather than conventional:
 * question two is always a strict subset of the roster, because the mark that was just refused is
 * not on it. `missing` is the reason this returns `undefined` instead of throwing — a throw would be
 * caught by `assistedChartIR` and become a quiet fallback, and a repair that is not on disk must be a
 * refusal to publish, not a row answered by the table. `shipReport` turns the list into that refusal.
 */
export function repairAdvisor(
  first: (question: string) => Promise<string | undefined>,
  answers: ReadonlyMap<string, string | undefined>,
  missing: string[],
): MarkAdvisor {
  return async (question, options) => {
    if (options.length === MARK_OPTIONS.length) return first(question);
    const key = answerKey(question, options);
    if (!answers.has(key)) {
      missing.push(key);
      return undefined;
    }
    return answers.get(key);
  };
}

/**
 * The second questions the chart pass will ask, computed by asking it.
 *
 * The advisor answers question one and declines question two, so `assistedChartIR` falls back exactly
 * where it would without a repair and *records* each question two on the way. Running the pass is the
 * point: a repair set computed from the artifact alone would be a second opinion about which rows are
 * refused, and a row added to one side and not the other is a row whose second answer is never asked
 * for and never checked.
 *
 * One entry per *row*, not per question: two rows that share a question and a table are one question
 * and one call — the store folds them — but they are two rows of the reading, and a caller that
 * deduplicated here could not say how many rows the second question rescued.
 */
export async function repairAsks(
  rows: readonly ProfileInput[],
  choices: readonly (string | null)[],
): Promise<{ readonly refused: number; readonly asks: readonly RepairAsk[] }> {
  const first = chartAdvisor(rows, choices);
  const asks: RepairAsk[] = [];
  let at = 0;
  const advisor: MarkAdvisor = async (question, options) => {
    if (options.length === MARK_OPTIONS.length) return first(question);
    asks.push({ row: at, question, options });
    return undefined;
  };
  const drawn = await drawAll(rows, { advisor, repair: true, onRow: (index) => { at = index; } });
  // Two numbers, not one. `refused` is every row whose first answer its table refused; `asks` is the
  // subset a second question can help — a table that holds one mark is not asked. Reporting only the
  // second would hide the first, and the difference between them is a fact about the corpus: on
  // Text2Vis it is 23 rows out of 223, and a reader comparing this file with `ship.json` would find
  // them by subtraction and have no name for them.
  const refused = drawn.decisions.filter((decision) => decision.reason === 'not-admitted').length;
  return { refused, asks };
}

/**
 * Price the shipped path on the rows the artifact answered.
 *
 * Both passes run over the same population, in the same order, and the divergence list is built during
 * the first one — the arbitration policy is asked the same question the product asked itself, and the
 * two answers are compared while both are still in hand.
 */
export async function shipReport(
  rows: readonly ProfileInput[],
  choices: readonly (string | null)[],
  model: string,
  population: { readonly roster: string },
  options: { readonly policies?: readonly Policy[]; readonly repair?: ReadonlyMap<string, string | undefined> } = {},
): Promise<ShipReport> {
  if (rows.length !== choices.length) {
    throw new Error(
      `text2vis ship: the artifact holds answers for ${String(choices.length)} rows and the population has ${String(rows.length)}`,
    );
  }
  if (rows.length === 0) throw new Error('text2vis ship: the population is empty, so there is no shipped reading to publish');
  const roster = rosterOf(rows);
  if (population.roster !== roster) {
    throw new Error(
      `text2vis ship: the artifact answered a different population (${population.roster.slice(0, 12)}…) than the one on disk (${roster.slice(0, 12)}…)`,
    );
  }
  // The table is a parameter for the reason `arbitrateDisputes` gives about its own: a candidate
  // policy is priced by passing it, not by editing this file. It is also the seam that lets the suite
  // prove the divergence guard fires — a guard no test can reach is a guard nobody knows works.
  const policy = (options.policies ?? POLICIES).find((candidate) => candidate.name === 'model-holds');
  if (policy === undefined) {
    throw new Error('text2vis ship: the arbitration table has no model-holds policy, so there is nothing to be identical to');
  }

  const decide = artifactAdvisor(rows, choices);
  const decidedMarks: MarkName[] = [];
  const decisionRows: ShipRow[] = [];
  const divergence: { row: number; policy: string; shipped: MarkName }[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as ProfileInput;
    const dispute = disputeOf(row, choices[index] ?? null);
    const decision = await assistedMark(row.prompt, dispute.product.mark, decide);
    decidedMarks.push(decision.mark);
    decisionRows.push({
      mark: decision.mark,
      source: decision.source,
      product: decision.product,
      ...(decision.fallback === undefined ? {} : { reason: decision.fallback }),
    });
    const expected = policy.choose(dispute).mark;
    if (expected !== decision.mark) divergence.push({ row: index, policy: expected, shipped: decision.mark });
  }

  // The second pass is the chart a caller receives. Its advisor is the same answers, read the same
  // way; a wide table never reaches it, which is the 144 calls this pass does not spend. When a repair
  // file is given, the same pass also asks the refused rows' second question — and refuses to publish
  // if one of those questions has no answer on disk.
  const chartAnswers = chartAdvisor(rows, choices);
  const missing: string[] = [];
  const advisor = options.repair === undefined ? chartAnswers : repairAdvisor(chartAnswers, options.repair, missing);
  const drawn = await drawAll(rows, { advisor, repair: options.repair !== undefined });
  if (missing.length > 0) {
    const first = (missing[0] as string).split('\u0000')[0] as string;
    throw new Error(
      `text2vis ship: ${String(missing.length)} second question(s) have no answer in the repair artifact, the first asked about "${first}"; a repair that is not on disk is a row silently answered by the table`,
    );
  }
  /** Every row whose chart is not the decision, and every one of them must be a repair or the table's answer. */
  let changed = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const routed = routedBy(
      index,
      decidedMarks[index] as MarkName,
      (decisionRows[index] as ShipRow).product,
      drawn.marks[index] as MarkName,
      (drawn.decisions[index] as ShipRow).repaired === true,
    );
    if (routed !== 'same') changed += 1;
  }

  return {
    model,
    population: { scored: rows.length, roster },
    decided: countsOf(rows, decidedMarks, decisionRows),
    shipped: countsOf(rows, drawn.marks, drawn.decisions),
    changed,
    divergence,
  };
}

/**
 * The arithmetic a reader could not reproduce, refused rather than published.
 *
 * Five checks. The first is the one the file exists for: the shipped decision and the arbitration
 * policy are the same sentence, so a single row they disagree about means the published 863 does not
 * describe this product.
 */
export function assertShip(report: ShipReport): void {
  const { scored } = report.population;
  if (report.divergence.length > 0) {
    const first = report.divergence[0] as { row: number; policy: string; shipped: MarkName };
    throw new Error(
      `text2vis ship: ${String(report.divergence.length)} row(s) where the shipped decision and model-holds disagree; row ${String(first.row)}: policy ${first.policy}, shipped ${first.shipped}`,
    );
  }
  for (const [name, counts] of [
    ['decided', report.decided],
    ['shipped', report.shipped],
  ] as const) {
    // Three sources and no fourth: a row is the model's first answer, the model's second one, or the
    // table's. A total that is not the population is a row counted twice or a source invented.
    if (counts.fromModel + counts.repaired + counts.fromProduct !== scored) {
      throw new Error(
        `text2vis ship: ${name} splits ${String(counts.fromModel)} first answers, ${String(counts.repaired)} repairs and ${String(counts.fromProduct)} table answers over a population of ${String(scored)}`,
      );
    }
    const reasons = REASONS.reduce((sum, reason) => sum + counts.reasons[reason], 0);
    // Every table-decided row carries exactly one reason and no model row carries one, so a total that
    // is not the table's own count is a row counted twice or a reason invented.
    if (reasons !== counts.fromProduct) {
      throw new Error(
        `text2vis ship: ${name} counted ${String(reasons)} reasons over ${String(counts.fromProduct)} table rows`,
      );
    }
    if (counts.hit > scored) {
      throw new Error(`text2vis ship: ${name} reads ${String(counts.hit)} hits over ${String(scored)} rows`);
    }
    if (counts.share > 1) throw new Error(`text2vis ship: ${name} has a share above one, which is not a rate`);
  }
  // A chart can only change a row it vetoed, and it can only change it to the table's answer or to the
  // model's second one — `shipReport` checks that row by row. What is left to check here is the
  // arithmetic: the number of changed rows cannot exceed the rows a veto or a repair explains.
  const vetoes = report.shipped.reasons.wide + report.shipped.reasons['not-admitted'] + report.shipped.reasons.unchartable;
  if (report.changed > vetoes + report.shipped.repaired) {
    throw new Error(
      `text2vis ship: ${String(report.changed)} rows differ from the decision and only ${String(vetoes)} were vetoed and ${String(report.shipped.repaired)} repaired`,
    );
  }
}

/** The reading as a reader sees it. */
export function describeShip(report: ShipReport, model = report.model): readonly string[] {
  const share = (value: number): string => `${(value * 100).toFixed(2)}%`;
  const reasons = (counts: ShipCounts): string =>
    REASONS.map((reason) => `${reason} ${String(counts.reasons[reason])}`).join(', ');
  return [
    `\n  shipped path on ${String(report.population.scored)} rows against ${model}`,
    `    decided  ${String(report.decided.hit)} (${share(report.decided.share)})  model ${String(report.decided.fromModel)}, table ${String(report.decided.fromProduct)}`,
    `    shipped  ${String(report.shipped.hit)} (${share(report.shipped.share)})  model ${String(report.shipped.fromModel)} first, ${String(report.shipped.repaired)} repaired, table ${String(report.shipped.fromProduct)}`,
    `    reasons  ${reasons(report.shipped)}`,
    `    changed  ${String(report.changed)} row(s) drew an answer other than the decision s`,
    `    route agrees with model-holds on ${String(report.population.scored - report.divergence.length)} of ${String(report.population.scored)} rows`,
  ];
}

/**
 * One sentence for anything thrown, because the catch cannot assume it is an `Error`.
 *
 * A provider adapter, a JSON parser and a hand-written `throw` are three sources and only two of them
 * throw `Error`. Logging `error.message` on a thrown string prints `undefined`, which is how a failure
 * becomes a mystery.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The repair artifact, read and checked: one answer per (question, list).
 *
 * Checked rather than trusted, for the reason every reader in this file is: the file is written by a
 * different process on a different machine, and a half-finished copy arrives as valid JSON. A row
 * whose answer is a number, a list that is not a list of names, and two different answers to one
 * question are three files this would otherwise place into a reading.
 */
export function repairAnswers(parsed: unknown): ReadonlyMap<string, string | undefined> {
  const refuse = (why: string): never => {
    throw new Error(`the repair artifact ${why}, so the second answers it holds cannot be placed`);
  };
  if (typeof parsed !== 'object' || parsed === null) refuse('is not an object');
  const rows = (parsed as Record<string, unknown>)['rows'];
  if (!Array.isArray(rows)) refuse('carries no rows array');
  const answers = new Map<string, string | undefined>();
  for (const entry of rows as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) refuse('carries a row that is not an object');
    const row = entry as Record<string, unknown>;
    const question = row['question'];
    const options = row['options'];
    const choice = row['choice'];
    if (typeof question !== 'string') refuse('carries a row without a question');
    if (!Array.isArray(options) || !(options as readonly unknown[]).every((name) => typeof name === 'string')) {
      refuse(`carries a row for "${String(question)}" without an option list`);
    }
    if (choice !== null && choice !== undefined && typeof choice !== 'string') {
      refuse(`carries an answer for "${String(question)}" that is not a name`);
    }
    const key = answerKey(question as string, (options as readonly string[]).map((name) => ({ name })));
    const answer = typeof choice === 'string' ? choice : undefined;
    // Two answers to one question is a file that was appended to by two runs, and picking either one
    // would be this reader choosing which of them is the measurement.
    if (answers.has(key) && answers.get(key) !== answer) {
      refuse(`answers "${String(question as string)}" twice, and the two answers differ`);
    }
    answers.set(key, answer);
  }
  return answers;
}

export interface ShipArgs {
  readonly json: boolean;
  readonly answers: string;
  readonly artifact?: string;
  readonly model?: string;
  readonly repair?: string;
}

/** Parse the command line, refusing anything it does not use — the reason `parseLlmArgs` gives. */
export function parseShipArgs(argv: readonly string[]): ShipArgs {
  let json = false;
  let answers: string | undefined;
  let artifact: string | undefined;
  let model: string | undefined;
  let repair: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--answers' || flag === '--artifact' || flag === '--model' || flag === '--repair') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a path or a name`);
      if (flag === '--answers') answers = value;
      else if (flag === '--artifact') artifact = value;
      else if (flag === '--repair') repair = value;
      else model = value;
      index += 1;
      continue;
    }
    throw new Error(
      `unknown argument ${flag}: this command asks nothing to a model and prices the shipped path against answers already on disk, so it takes --json, --answers <path>, --artifact <path>, --model <name> and --repair <path>`,
    );
  }
  if (answers === undefined) {
    throw new Error('--answers is required: this command prices the answers an arm already wrote, and takes the path to them');
  }
  return {
    json,
    answers,
    ...(artifact === undefined ? {} : { artifact }),
    ...(model === undefined ? {} : { model }),
    ...(repair === undefined ? {} : { repair }),
  };
}

/** The shape this command reads out of `llm.ts`'s artifact, checked rather than trusted. */
interface Reading {
  readonly corpus?: { readonly roster?: unknown; readonly asked?: unknown };
  readonly arms?: readonly (Partial<ArmReport> & { readonly choices?: unknown })[];
}

export interface ShipEntryOptions {
  readonly argv?: readonly string[];
  readonly load?: LoadOptions;
}

/** The repair file on disk, with the one check that makes it about *this* population. */
async function readRepair(path: string, roster: string): Promise<ReadonlyMap<string, string | undefined>> {
  const { readFile } = await import('node:fs/promises');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not readable JSON: ${messageOf(error)}`);
  }
  const said = (parsed as { readonly population?: { readonly roster?: unknown } }).population?.roster;
  if (typeof said !== 'string') {
    throw new Error(`${path} carries no population.roster, so the rows its second answers were given to cannot be identified`);
  }
  if (said !== roster) {
    throw new Error(
      `${path} answered a different population (${said.slice(0, 12)}…) than the artifact on disk (${roster.slice(0, 12)}…)`,
    );
  }
  return repairAnswers(parsed);
}

/**
 * The command.
 *
 * Exit 1 for anything that would publish a reading about the wrong population or the wrong answers, and
 * for the one thing this file exists to catch: a single row where the shipped decision and the
 * arbitration policy disagree.
 */
export async function entryShip(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  options: ShipEntryOptions = {},
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  try {
    const args = parseShipArgs(options.argv ?? []);
    const answersPath = args.answers;
    const { corpus, source, path } = await loadText2Vis(options.load);
    log(`text2vis: ${source} ${path}`);
    const { rows: scored, dropped } = scoredRows(corpus);
    if (dropped > 0) {
      log(`text2vis ship: ${String(dropped)} rows carry a label no family names and are not part of any population`);
    }
    const { readFile } = await import('node:fs/promises');
    const reading = JSON.parse(await readFile(answersPath, 'utf8')) as Reading;
    const roster = reading.corpus?.roster;
    if (typeof roster !== 'string') {
      throw new Error(`${answersPath} carries no corpus.roster, so the rows its answers were given to cannot be identified; re-run the arm that wrote it`);
    }
    const asked = typeof reading.corpus?.asked === 'number' ? reading.corpus.asked : undefined;
    const rows = asked === undefined ? scored : scored.slice(0, asked);
    const marks = (reading.arms ?? []).filter((arm) => arm.scale === 'mark');
    if (marks.length === 0) throw new Error(`${answersPath} has no mark-scale arm, so there are no answers to ship`);
    const arm =
      args.model === undefined ? (marks[0] as Partial<ArmReport>) : marks.find((candidate) => candidate.model === args.model);
    if (arm === undefined) throw new Error(`${answersPath} has no ${String(args.model)} mark arm`);
    const choices = arm.choices;
    if (!Array.isArray(choices) || !choices.every((choice) => choice === null || typeof choice === 'string')) {
      throw new Error(`${answersPath} carries no per-row choices for ${String(arm.model)}, so the rows it answered cannot be shipped; re-run the arm that wrote it`);
    }
    const report = await shipReport(rows, choices as readonly (string | null)[], String(arm.model), { roster }, {
      ...(args.repair === undefined ? {} : { repair: await readRepair(args.repair, roster) }),
    });
    assertShip(report);
    for (const line of describeShip(report)) log(line);
    if (args.json) log(JSON.stringify(report, null, 2));
    if (args.artifact !== undefined) {
      const { mkdir, writeFile, rename } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(args.artifact), { recursive: true });
      await writeFile(`${args.artifact}.part`, `${JSON.stringify(report, null, 2)}\n`);
      await rename(`${args.artifact}.part`, args.artifact);
      log(`text2vis: wrote ${args.artifact}`);
    }
    return 0;
  } catch (error) {
    log(`text2vis: ${messageOf(error)}`);
    return 1;
  }
}

void entryShip(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`), {
  argv: process.argv.slice(2),
}).then((code) => applyExitCode(code, process));
