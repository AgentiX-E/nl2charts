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
import { assistedChartIR, assistedMark, type MarkName } from '@agentix-e/nl2charts-chart';
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
}

/** The counts behind one rate. */
export interface ShipCounts {
  readonly hit: number;
  readonly share: number;
  /** Rows the model decided. */
  readonly fromModel: number;
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
  for (const decision of decisions) {
    if (decision.source === 'model') {
      fromModel += 1;
      continue;
    }
    // A table-decided row has exactly one reason, and the type says so: `reason` is required whenever
    // `source` is `product` in every branch that builds one, and a missing one here would be a row the
    // report cannot explain.
    const reason = decision.reason;
    if (reason === undefined) throw new Error('text2vis ship: a table-decided row carries no reason');
    reasons[reason] += 1;
  }
  return { hit: scored.top1, share: scored.top1Share, fromModel, fromProduct: decisions.length - fromModel, reasons };
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
 * Which of the two answers a chart took, and a refusal when it took a third.
 *
 * There are exactly two answers in this system — the model's and the table's — so a chart that is
 * neither is a defect no reading should absorb. `arbitrate.ts` guards the same property for the
 * policy (`side !== modelLead` throws); this is the same guard on the shipped path, which is the one a
 * caller can actually receive. A pure function rather than a closure because the third-answer branch
 * cannot occur in a run — the types say so — and a branch nobody can reach is a branch nobody can
 * test, which is how a guard rots.
 */
export function routedBy(index: number, decided: MarkName, product: MarkName, shipped: MarkName): 'same' | 'table' {
  if (shipped === decided) return 'same';
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
  options: { readonly policies?: readonly Policy[] } = {},
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

  // The second pass is the chart a caller receives. Its advisor is the same answers, read the same way;
  // a wide table never reaches it, which is the 144 calls this pass does not spend.
  const chartAnswers = chartAdvisor(rows, choices);
  const shippedMarks: MarkName[] = [];
  const shippedRows: ShipRow[] = [];
  /** Every row whose chart is not the decision, and every one of them must be the table's answer. */
  let changed = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as ProfileInput;
    const set = parseResultSet(row.tableData);
    try {
      const chart = await assistedChartIR(row.prompt, typedRows(set), {
        columns: set.columns,
        advisor: chartAnswers,
      });
      if (routedBy(index, decidedMarks[index] as MarkName, (decisionRows[index] as ShipRow).product, chart.decision.mark) === 'table') {
        changed += 1;
      }
      shippedMarks.push(chart.decision.mark);
      shippedRows.push({
        mark: chart.decision.mark,
        source: chart.decision.source,
        product: chart.decision.product,
        ...(chart.decision.fallback === undefined ? {} : { reason: chart.decision.fallback }),
        ...(chart.decision.veto === undefined ? {} : { reason: chart.decision.veto }),
      });
    } catch {
      // A result set no mark can hold. The table's published reading counts these as `declined`, and so
      // does this pass: a row with no chart is not a row with a wrong chart.
      if (routedBy(index, decidedMarks[index] as MarkName, (decisionRows[index] as ShipRow).product, 'declined') === 'table') {
        changed += 1;
      }
      shippedMarks.push('declined');
      shippedRows.push({ mark: 'declined', source: 'product', product: 'declined', reason: 'unchartable' });
    }
  }

  return {
    model,
    population: { scored: rows.length, roster },
    decided: countsOf(rows, decidedMarks, decisionRows),
    shipped: countsOf(rows, shippedMarks, shippedRows),
    changed,
    divergence,
  };
}

/**
 * The arithmetic a reader could not reproduce, refused rather than published.
 *
 * Five checks. The first is the one the file exists for: the shipped decision and the arbitration
 * policy are the same sentence, so a single row they disagree about means the published 861 does not
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
    if (counts.fromModel + counts.fromProduct !== scored) {
      throw new Error(
        `text2vis ship: ${name} split ${String(counts.fromModel)} model and ${String(counts.fromProduct)} table over a population of ${String(scored)}`,
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
  // A charter can only change a row it vetoed, and it can only change it to the table's answer —
  // `shipReport` checks that row by row. What is left to check here is the arithmetic: the number of
  // changed rows cannot exceed the number of rows a veto explains.
  const vetoes = report.shipped.reasons.wide + report.shipped.reasons['not-admitted'] + report.shipped.reasons.unchartable;
  if (report.changed > vetoes) {
    throw new Error(
      `text2vis ship: ${String(report.changed)} rows differ from the decision and only ${String(vetoes)} were vetoed`,
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
    `    shipped  ${String(report.shipped.hit)} (${share(report.shipped.share)})  model ${String(report.shipped.fromModel)}, table ${String(report.shipped.fromProduct)}`,
    `    reasons  ${reasons(report.shipped)}`,
    `    changed  ${String(report.changed)} row(s) drew the table s answer instead of the decision s`,
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

export interface ShipArgs {
  readonly json: boolean;
  readonly answers: string;
  readonly artifact?: string;
  readonly model?: string;
}

/** Parse the command line, refusing anything it does not use — the reason `parseLlmArgs` gives. */
export function parseShipArgs(argv: readonly string[]): ShipArgs {
  let json = false;
  let answers: string | undefined;
  let artifact: string | undefined;
  let model: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--answers' || flag === '--artifact' || flag === '--model') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a path or a name`);
      if (flag === '--answers') answers = value;
      else if (flag === '--artifact') artifact = value;
      else model = value;
      index += 1;
      continue;
    }
    throw new Error(
      `unknown argument ${flag}: this command asks nothing to a model and prices the shipped path against answers already on disk, so it takes --json, --answers <path>, --artifact <path> and --model <name>`,
    );
  }
  if (answers === undefined) {
    throw new Error('--answers is required: this command prices the answers an arm already wrote, and takes the path to them');
  }
  return { json, answers, ...(artifact === undefined ? {} : { artifact }), ...(model === undefined ? {} : { model }) };
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
    const report = await shipReport(rows, choices as readonly (string | null)[], String(arm.model), { roster });
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
