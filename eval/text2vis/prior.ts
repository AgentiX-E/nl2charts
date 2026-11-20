/**
 * Which arm to pay, decided before the answer exists.
 *
 * ## The question this file answers
 *
 * `route.ts` priced a table of six rules between two arms and reads **828** shipped charts against
 * the chat arm's **807** — for two calls per row. A caller deciding whether to buy that has a
 * question the table cannot answer, because a table of decided rows is a table of quality and not of
 * price: 21 charts for double the inference is a trade, and a trade needs both sides stated in one
 * unit.
 *
 * The unit is **a shipped chart per yuan**. To put a router into it, the router's calls have to be
 * countable *before* it runs — which rules out anything that reads the other arm's answer, including
 * every rule in `route.ts`. So this file prices a different object: a **prior**, a function from what
 * is free before the call to one of the two seats.
 *
 * ## What is free before the call
 *
 * Three things, all deterministic, all already computed by code this repository runs on every row:
 *
 * | signal | what it costs | why a router may read it |
 * |---|---|---|
 * | `cueFired` | one pattern pass over the question | the cue table is the product; no model wrote it |
 * | `cueLead` | the same pass | the first mark the cue table names, its own order |
 * | `product` | `toChartIR` on the result set | the recommender's answer, and the row it *refuses* is a fact about the table |
 *
 * Nothing here looks at a label, and nothing here looks at an answer. A prior that read either would
 * be a selector over the answer key wearing a router's clothes, and the numbers would not survive a
 * corpus that has not been answered yet.
 *
 * ## The price
 *
 * One call per row, to the seat the prior names. The two seats are not the same price — the arm that
 * thinks spends its deliberation inside `completion_tokens` — so the price of a route is a mix:
 *
 * ```
 * calls(r) = chatRows + reasonerRows x r      r = what a thinking call costs in plain calls
 * ```
 *
 * `r` is the one number this file cannot measure from the artifact: the 2,940 answers on disk were
 * written before the store kept meters, so the reading knows its *calls* and not its bill. It is
 * therefore a parameter, and every conclusion below is stated as the value of `r` at which it would
 * stop holding. The default is 7.72 — the one live reasoning call this project ever metered, ¥0.00329
 * against a plain call's measured ¥0.000426 — and the arithmetic that matters does not depend on it:
 * see `breakEven`.
 *
 * ## What the run found
 *
 * Five priors, priced on the same 1,470 rows, ¥0. The best one is **`cue-gate`**: spend the thinking
 * call only on the 305 questions no cue reads. It ships **815** for 1,165 plain calls and 305 thinking
 * ones — 8 of the 21 charts the two-call router buys, for 27% of its bill — and it is the only one-call
 * router that beats shipping the thinking arm everywhere by more than three to one per yuan (818 for
 * 1,470 thinking calls). The prior that reads the recommender's *refusal* is dominated outright: 35
 * thinking calls, no chart gained.
 */
import { applyExitCode, isEntry, loadText2Vis, type LoadOptions } from './dataset.js';
import { markAnswer, rosterOf, scoredRows } from './llm.js';
import { cueMarks, familyOfLabel } from './rule.js';
import { parseResultSet, typedRows, type ProfileInput } from './profile.js';
import { shipReport } from './ship.js';
import { choicesOf, duelOf, routeChoices, seatsOf, DUEL_POLICIES, type ArtifactReading } from './route.js';
import type { Policy } from './arbitrate.js';
import { toChartIR, type MarkName, type RecommendableMark } from '@agentix-e/nl2charts-chart';

/** The two seats a prior chooses between: the arm that does not think, and the one that does. */
export type Seat = 'chat' | 'reasoner';

/**
 * What a row says before anybody is asked about it.
 *
 * `product` is absent rather than `'declined'` when the table refuses, because the refusal is not a
 * mark: it is the absence of one, and a prior that tested it for equality against a string would read
 * a table that answered `bar` as a table that refused.
 */
export interface FreeSignals {
  /** The mark the cue table names first, or absent when no cue fires. */
  readonly cueLead?: RecommendableMark;
  /** Whether the cue table named anything at all. */
  readonly cueFired: boolean;
  /** The recommender's own mark, absent when the result set cannot hold a chart. */
  readonly product?: MarkName;
}

/**
 * One row's three free signals.
 *
 * `toChartIR` throws for a table nothing can draw — `NL2C_E_NOT_SUPPORTED` for an empty result, a
 * single column, a table of text — and that throw is the signal: it is the same call the shipped path
 * makes, so the prior and the product cannot disagree about whether a row was chartable.
 */
export function signalsOf(rows: readonly ProfileInput[]): readonly FreeSignals[] {
  return rows.map((row) => {
    const named = cueMarks(row.prompt);
    const product = productOf(row);
    return {
      ...(named[0] === undefined ? {} : { cueLead: named[0] }),
      cueFired: named.length > 0,
      ...(product === undefined ? {} : { product }),
    };
  });
}

/** The table's mark for one row, or nothing when the table refuses it. */
function productOf(row: ProfileInput): MarkName | undefined {
  try {
    const set = parseResultSet(row.tableData);
    return toChartIR(row.prompt, typedRows(set), { columns: set.columns }).mark as MarkName;
  } catch {
    return undefined;
  }
}

/** A router that decides a seat from the free signals alone. */
export interface Prior {
  readonly name: string;
  readonly note: string;
  readonly seat: (signals: FreeSignals) => Seat;
}

/**
 * The five priors, written as sentences rather than thresholds.
 *
 * Two of them are the arms themselves, and they are here because they are the alternatives a caller
 * actually has: "do nothing" is a router, and so is "buy the arm that scores higher". A price list
 * that omitted either would make every other row look like a gain.
 */
export const PRIORS: readonly Prior[] = [
  {
    name: 'chat',
    note: 'one call, always to the arm that does not think: the default path, and the price the rest of this table is read against',
    seat: () => 'chat',
  },
  {
    name: 'reasoner',
    note: 'one call, always to the arm that thinks: what a caller who read the scoreboard would buy, and the reading a prior has to beat by more than it costs',
    seat: () => 'reasoner',
  },
  {
    name: 'cue-gate',
    note: 'the question names no shape, so pay for deliberation there: a cue-fired question is one the plain arm reads, and a question no cue reads is one nothing free has an opinion about',
    seat: (signals) => (signals.cueFired ? 'chat' : 'reasoner'),
  },
  {
    name: 'table-agrees',
    note: 'the cue table leads with the mark the recommender chose: two free readers agreeing is the cheapest evidence available that the row is easy',
    seat: (signals) => (signals.cueLead !== undefined && signals.cueLead === signals.product ? 'chat' : 'reasoner'),
  },
  {
    name: 'table-refused',
    note: 'the recommender refused the result set: pay for the thinking arm exactly where the free path had nothing to say',
    seat: (signals) => (signals.product === undefined ? 'reasoner' : 'chat'),
  },
];

/** The seat a prior names for every row. */
export function seatsUnder(signals: readonly FreeSignals[], prior: Prior): readonly Seat[] {
  return signals.map((signal) => prior.seat(signal));
}

/**
 * The answers a prior would have bought, one per row.
 *
 * A `null` is the seat's own refusal rather than a fallback: the prior chose that arm, and what that
 * arm said — including "nothing" — is the answer the caller paid for.
 */
export function answersUnder(
  signals: readonly FreeSignals[],
  left: readonly (string | null)[],
  right: readonly (string | null)[],
  prior: Prior,
): readonly (string | null)[] {
  if (signals.length !== left.length || signals.length !== right.length) {
    throw new Error(
      `text2vis prior: ${String(left.length)} and ${String(right.length)} answers for ${String(signals.length)} rows, so the two arms are not answering the same questions`,
    );
  }
  return seatsUnder(signals, prior).map((seat, index) =>
    seat === 'chat' ? (left[index] as string | null) : (right[index] as string | null),
  );
}

/** How many calls a prior spends on each seat, which is its whole bill. */
export function callsUnder(signals: readonly FreeSignals[], prior: Prior): { readonly chat: number; readonly reasoner: number } {
  let chat = 0;
  let reasoner = 0;
  for (const seat of seatsUnder(signals, prior)) {
    if (seat === 'chat') chat += 1;
    else reasoner += 1;
  }
  return { chat, reasoner };
}

/** One router, priced on a corpus: what it spends, and what a caller receives for it. */
export interface PriorReading {
  readonly name: string;
  readonly note: string;
  /** Rows priced. Not the number of calls: a router that buys both arms prices 1,470 rows with 2,940 calls. */
  readonly rows: number;
  readonly chatRows: number;
  readonly reasonerRows: number;
  /** Rows whose chart family is the one the prior's answer leads with. */
  readonly decided: number;
  /** Rows that survive the shipped path, which is what a caller gets. */
  readonly shipped: number;
}

/** Whether one answer is the row's family, scored the way the shipped path scores it. */
function hitOf(choice: string | null, label: string, asked: string): boolean {
  if (choice === null) return false;
  return markAnswer(choice, asked).families[0] === familyOfLabel(label);
}

/**
 * Price one prior, through the product's own shipped path.
 *
 * `decided` and `shipped` are both reported because only one of them is a product: a decided row can
 * still be a chart the result set cannot hold, and `shipReport` is the code that decides. The two
 * numbers are also the cross-check this file has against `route.ts` — the two-call router is priced
 * here by the same call, and its reading is asserted against the floor `route.ts` publishes.
 */
export async function priorReport(
  rows: readonly ProfileInput[],
  left: readonly (string | null)[],
  right: readonly (string | null)[],
  prior: Prior,
  roster: string,
): Promise<PriorReading> {
  if (rows.length !== left.length || rows.length !== right.length) {
    throw new Error(
      `text2vis prior: ${String(left.length)} and ${String(right.length)} answers for ${String(rows.length)} rows, so the two arms are not answering the same questions`,
    );
  }
  const recomputed = rosterOf(rows);
  if (roster !== recomputed) {
    throw new Error(
      `text2vis prior: the artifact answered a different population (${roster.slice(0, 12)}…) than the one on disk (${recomputed.slice(0, 12)}…)`,
    );
  }
  const signals = signalsOf(rows);
  const choices = answersUnder(signals, left, right, prior);
  let decided = 0;
  for (const [index, row] of rows.entries()) {
    if (hitOf(choices[index] as string | null, row.label, row.prompt)) decided += 1;
  }
  const calls = callsUnder(signals, prior);
  const shipped = (await shipReport(rows, choices, prior.name, { roster })).shipped.hit;
  return { name: prior.name, note: prior.note, rows: rows.length, chatRows: calls.chat, reasonerRows: calls.reasoner, decided, shipped };
}

/**
 * The two-call router, priced by this file's own arithmetic.
 *
 * It is not a prior — it reads both answers — and it is here because it is the alternative this round
 * is measured against. Building it out of `route.ts`'s exports rather than re-deriving it is the point:
 * `assertPrice` then holds this reading to the 891/828 `route.ts` publishes, so the two files cannot
 * drift into two definitions of the same router.
 */
export async function dualReading(
  rows: readonly ProfileInput[],
  left: readonly (string | null)[],
  right: readonly (string | null)[],
  roster: string,
  policies: readonly Policy[] = DUEL_POLICIES,
): Promise<PriorReading> {
  const policy = policies.find((candidate) => candidate.name === 'cue-led');
  if (policy === undefined) throw new Error('text2vis prior: the duel table has no cue-led rule, so there is no two-call router to price');
  const disputes = rows.map((row, index) => duelOf(row, left[index] as string | null, right[index] as string | null));
  const choices = routeChoices(disputes, policy);
  let decided = 0;
  for (const [index, row] of rows.entries()) {
    if (hitOf(choices[index] as string | null, row.label, row.prompt)) decided += 1;
  }
  const shipped = (await shipReport(rows, choices, 'both', { roster })).shipped.hit;
  return {
    name: 'both',
    note: 'both arms, and `cue-led` between them: the routing table of `route.ts`, at two calls per row',
    rows: rows.length,
    chatRows: rows.length,
    reasonerRows: rows.length,
    decided,
    shipped,
  };
}

/**
 * What a call costs, in the two numbers the artifact cannot supply.
 *
 * `chatYuan` is one plain call at list price, measured on this corpus (¥1.2521 for 2,940 calls across
 * both scales). `ratio` is what one thinking call costs in plain calls; it is a parameter because the
 * store lost the meters of the answers this reading is computed from, and a parameter that is stated
 * is worth more than a constant that is assumed.
 */
export interface Rate {
  readonly chatYuan: number;
  readonly ratio: number;
}

/**
 * The calls a router makes per row — two for the router that buys both answers, one for every other.
 *
 * Kept apart from {@link pricePerRow} because they answer different questions and a table that merged
 * them would be wrong about the two-call router by a factor of four: it makes two calls per row and
 * spends eight plain calls' worth of money on it.
 */
export function callsPerRow(reading: PriorReading): number {
  if (reading.rows === 0) throw new Error(`text2vis prior: ${reading.name} prices no row, so it has no calls per row`);
  return (reading.chatRows + reading.reasonerRows) / reading.rows;
}

/** What those calls cost, in plain calls — the unit a ratio can price. */
export function pricePerRow(reading: PriorReading, ratio: number): number {
  return (reading.chatRows + reading.reasonerRows * ratio) / reading.rows;
}

/** 元 one router's reading costs. */
export function yuanOf(reading: PriorReading, rate: Rate): number {
  return (reading.chatRows + reading.reasonerRows * rate.ratio) * rate.chatYuan;
}

/**
 * 元 per shipped chart — the unit the whole file exists to produce.
 *
 * A router that ships nothing cannot be priced this way, and the division is refused rather than
 * returned as `Infinity`: an infinite price prints as a number in a column and would be read as one.
 */
export function yuanPerShippedRow(reading: PriorReading, rate: Rate): number {
  if (reading.shipped === 0) {
    throw new Error(`text2vis prior: ${reading.name} ships no chart, so a price per shipped chart is not a number this can compute`);
  }
  return yuanOf(reading, rate) / reading.shipped;
}

/**
 * 元 for each *additional* chart, against another router.
 *
 * The number a caller deciding whether to pay anything at all needs, and the one a table of averages
 * hides: the first chart a router buys is never the same price as the twenty-first. A router that
 * ships no more charts than its anchor has no such price — every price is infinite — and that is
 * returned as `undefined` rather than as a large number, because a column of infinities reads like a
 * column of numbers.
 */
export function marginalPrice(reading: PriorReading, anchor: PriorReading, rate: Rate): number | undefined {
  const gained = reading.shipped - anchor.shipped;
  if (gained <= 0) return undefined;
  return (yuanOf(reading, rate) - yuanOf(anchor, rate)) / gained;
}

/**
 * The ratio at which two routers cost the same per shipped chart.
 *
 * Setting `a.shipped x cost_b(r) = b.shipped x cost_a(r)` and solving for `r` gives one number, and
 * its *sign* is the interesting part:
 *
 * - **positive** — the cheaper router changes at that ratio, and the reading is only true on one side
 *   of it;
 * - **negative** — the ordering never changes for any ratio a provider could charge (r cannot be
 *   below zero, since a thinking call includes the plain prompt), so one of the two routers is the
 *   more efficient one at every price;
 * - **`undefined`** — the two spend calls in the same proportion, so the ratio cannot separate them.
 *
 * This is why the conclusion of the round does not depend on the unmeasured `r`: the two comparisons
 * that decide it are a negative root and a root below 1.05, against a measurement of 7.72.
 */
export function breakEven(a: PriorReading, b: PriorReading): number | undefined {
  const denominator = a.shipped * b.reasonerRows - b.shipped * a.reasonerRows;
  if (denominator === 0) return undefined;
  return (b.shipped * a.chatRows - a.shipped * b.chatRows) / denominator;
}

/** The floor a price list is held to, as `baseline.json` records it. */
export interface PriceFloor {
  readonly scored: number;
  /** Shipped charts per router name. */
  readonly readings: Readonly<Record<string, number>>;
  /** The two-call router's two numbers, which `route.ts` also publishes. */
  readonly dual: { readonly decided: number; readonly shipped: number };
}

/**
 * Refuse a price list that disagrees with the floor, before anything is printed.
 *
 * Three checks and each is about a different kind of drift: the population (a `--limit` run prices a
 * prefix), per-router shipped counts (a prior that changed reads a different number), and the two-call
 * router's *both* numbers (this file rebuilding `route.ts`'s router is only worth doing if it lands on
 * `route.ts`'s reading).
 */
export function assertPrice(readings: readonly PriorReading[], dual: PriorReading, floor: PriceFloor): void {
  const rows = readings[0] === undefined ? 0 : readings[0].rows;
  if (rows !== floor.scored || dual.rows !== floor.scored) {
    throw new Error(
      `text2vis prior: the floor was taken on ${String(floor.scored)} rows and this reading prices ${String(rows)} and ${String(dual.rows)}; a price over another population is another instrument`,
    );
  }
  for (const [name, expected] of Object.entries(floor.readings)) {
    const reading = readings.find((candidate) => candidate.name === name);
    if (reading === undefined) throw new Error(`text2vis prior: the floor records ${name}, which this table does not price`);
    if (reading.shipped !== expected) {
      throw new Error(`text2vis prior: ${name} ships ${String(reading.shipped)} and the floor records ${String(expected)}`);
    }
  }
  if (dual.decided !== floor.dual.decided || dual.shipped !== floor.dual.shipped) {
    throw new Error(
      `text2vis prior: the two-call router reads ${String(dual.decided)} decided and ${String(dual.shipped)} shipped, and the routing table publishes ${String(floor.dual.decided)} and ${String(floor.dual.shipped)}; the two files disagree about the same rule`,
    );
  }
}

/**
 * The price list, one line per router.
 *
 * `calls/row` and `¥/chart` are both printed because they answer different objections: the first is
 * what a deployment has to capacity-plan, the second is what a caller pays for a chart. The ratio is
 * in the header rather than in every line, so a reader cannot mistake a column for a measurement.
 */
export function describePrice(readings: readonly PriorReading[], rate: Rate): readonly string[] {
  const lines = [
    `text2vis prior: price per shipped chart, at ¥${rate.chatYuan.toFixed(6)} a plain call and a thinking call at x${rate.ratio.toFixed(2)}`,
  ];
  const anchor = readings[0];
  for (const reading of readings) {
    const marginal = anchor === undefined || reading === anchor ? undefined : marginalPrice(reading, anchor, rate);
    lines.push(
      `  ${reading.name.padEnd(15)} calls/row ${callsPerRow(reading).toFixed(3)}` +
        `, price/row ${pricePerRow(reading, rate.ratio).toFixed(3)}` +
        `, decided ${String(reading.decided)}, shipped ${String(reading.shipped)}` +
        `, ¥${yuanPerShippedRow(reading, rate).toFixed(6)} per chart` +
        `, ${marginal === undefined ? '-' : `¥${marginal.toFixed(6)}`} per extra chart`,
    );
  }
  return lines;
}

/**
 * One sentence per pair that the ratio decides, in either direction.
 *
 * A router that is cheaper *and* ships no fewer charts needs no sentence — it is the answer — so the
 * sentence is written only where the trade is real, and the ratio in it is the reason.
 */
export function describeTrades(readings: readonly PriorReading[], rate: Rate): readonly string[] {
  const anchor = readings[0];
  if (anchor === undefined) throw new Error('text2vis prior: a price list with no routers has no trade to describe');
  const lines: string[] = [];
  const base = yuanPerShippedRow(anchor, rate);
  for (const reading of readings.slice(1)) {
    const multiple = yuanPerShippedRow(reading, rate) / base;
    lines.push(
      `text2vis prior: ${reading.name} ships ${String(reading.shipped - anchor.shipped)} more charts than ${anchor.name}` +
        ` for ${(pricePerRow(reading, rate.ratio) / pricePerRow(anchor, rate.ratio)).toFixed(2)}x its price per row and ${multiple.toFixed(2)}x its price per chart;` +
        ` the cheaper of the two is ${whereCheaper(anchor, reading)}`,
    );
  }
  const winner = readings.reduce((best, reading) => (yuanPerShippedRow(reading, rate) < yuanPerShippedRow(best, rate) ? reading : best));
  lines.push(`text2vis prior: at the measured x${rate.ratio.toFixed(2)} a thinking call, ${winner.name} is the cheapest chart in the table`);
  return lines;
}

/**
 * Where one router is the cheaper of two, as a phrase rather than a number.
 *
 * Read off the sign of the two roots `breakEven` gives, plus which side is cheaper at `r = 0` — the
 * only ratio at which the comparison needs no assumption at all, because it is the price of a route
 * that never buys the thinking arm.
 */
function whereCheaper(a: PriorReading, b: PriorReading): string {
  const ratio = breakEven(a, b);
  if (ratio === undefined || ratio < 0) return `${betterAtZero(a, b)} at every price a provider could charge`;
  const below = betterAtZero(a, b);
  const above = below === b.name ? a.name : b.name;
  return `${below} below x${ratio.toFixed(3)} a thinking call and ${above} above it`;
}

/**
 * Which of two routers is cheaper per chart at `r = 0`.
 *
 * The only ratio at which the comparison needs no assumption: it is the price of a route that never
 * buys the thinking arm, so it is the plain-call bill against the shipped charts and nothing else.
 */
function betterAtZero(a: PriorReading, b: PriorReading): string {
  return b.shipped * a.chatRows > a.shipped * b.chatRows ? b.name : a.name;
}

export interface PriorArgs {
  readonly json: boolean;
  readonly answers: string;
  readonly artifact?: string;
  readonly floor?: string;
  readonly ratio?: number;
  readonly chatYuan?: number;
  readonly require: boolean;
}

/** The ratio and the plain-call price the round measured, which a caller may override. */
export const MEASURED = { ratio: 7.72, chatYuan: 0.000426, left: 'deepseek-chat', right: 'deepseek-reasoner' } as const;

/** Parse the command line, refusing anything it does not use — the reason `parseRouteArgs` gives. */
export function parsePriorArgs(argv: readonly string[]): PriorArgs {
  let json = false;
  let require = false;
  let answers: string | undefined;
  let artifact: string | undefined;
  let floor: string | undefined;
  let ratio: number | undefined;
  let chatYuan: number | undefined;
  const valued = new Set(['--answers', '--artifact', '--floor', '--ratio', '--chat-yuan']);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--require') {
      require = true;
      continue;
    }
    if (valued.has(flag)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      if (flag === '--answers') answers = value;
      else if (flag === '--artifact') artifact = value;
      else if (flag === '--floor') floor = value;
      else if (flag === '--ratio') ratio = positive(flag, value);
      else chatYuan = positive(flag, value);
      index += 1;
      continue;
    }
    throw new Error(
      `unknown argument ${flag}: this command prices priors on answers already on disk, so it takes --answers <path>, --ratio <x>, --chat-yuan <元>, --floor <path>, --require, --json and --artifact <path>`,
    );
  }
  if (answers === undefined) throw new Error('--answers is required: this command prices the calls it would have made, and it needs the two arms to have made them');
  return {
    json,
    require,
    answers,
    ...(artifact === undefined ? {} : { artifact }),
    ...(floor === undefined ? {} : { floor }),
    ...(ratio === undefined ? {} : { ratio }),
    ...(chatYuan === undefined ? {} : { chatYuan }),
  };
}

/**
 * A positive number, or the argument is refused.
 *
 * A ratio of zero would price a thinking call as free — the one direction of error that makes the
 * expensive option look cheap — and a currency amount of zero is a price nobody charges.
 */
function positive(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} takes a positive number, not ${value}`);
  return parsed;
}

export interface PriorEntryOptions {
  readonly argv: readonly string[];
  readonly load: LoadOptions;
}

/**
 * The command.
 *
 * Exit 1 for anything that would publish a price about the wrong population, a router the floor does
 * not record, or a two-call reading that disagrees with `route.ts`. Nothing here calls a model: the
 * two arms answered once, in one dispatch, and this is a re-reading of their answers for **¥0**.
 */
export async function entryPrior(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  options: PriorEntryOptions,
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  try {
    const args = parsePriorArgs(options.argv);
    const { corpus, source, path } = await loadText2Vis(options.load);
    log(`text2vis: ${source} ${path}`);
    const { rows: scored, dropped } = scoredRows(corpus);
    if (dropped > 0) log(`text2vis prior: ${String(dropped)} rows carry a label no family names and are not part of any population`);
    const { readFile } = await import('node:fs/promises');
    const reading = JSON.parse(await readFile(args.answers, 'utf8')) as ArtifactReading;
    const roster = reading.corpus?.roster;
    if (typeof roster !== 'string') {
      throw new Error(`${args.answers} carries no corpus.roster, so the rows its answers were given to cannot be identified; re-run the arm that wrote it`);
    }
    const asked = typeof reading.corpus?.asked === 'number' ? reading.corpus.asked : undefined;
    const rows = asked === undefined ? scored : scored.slice(0, asked);
    const seats = seatsOf(reading, args.answers, undefined, undefined);
    if (args.ratio === undefined && (seats.left !== MEASURED.left || seats.right !== MEASURED.right)) {
      throw new Error(
        `the default ratio was measured on ${MEASURED.left} against ${MEASURED.right}, and these seats are ${seats.left} against ${seats.right}: state what a ${seats.right} call costs in ${seats.left} calls with --ratio`,
      );
    }
    const rate: Rate = { chatYuan: args.chatYuan ?? MEASURED.chatYuan, ratio: args.ratio ?? MEASURED.ratio };
    const left = choicesOf(reading, args.answers, seats.left);
    const right = choicesOf(reading, args.answers, seats.right);
    const readings: PriorReading[] = [];
    for (const prior of PRIORS) readings.push(await priorReport(rows, left.choices, right.choices, prior, roster));
    const dual = await dualReading(rows, left.choices, right.choices, roster);
    const priced = [...readings, dual];
    for (const line of describePrice(priced, rate)) log(line);
    for (const line of describeTrades(priced, rate)) log(line);

    if (args.require) {
      const floorPath = args.floor ?? 'eval/text2vis/baseline.json';
      const parsed = JSON.parse(await readFile(floorPath, 'utf8')) as { readonly llm?: { readonly prior?: PriceFloor } };
      const floor = parsed.llm?.prior;
      if (floor === undefined) {
        log(`text2vis prior: ${floorPath} records no llm.prior floor, so there is nothing to hold this price list to; this run establishes one`);
      } else {
        assertPrice(readings, dual, floor);
        log(`text2vis prior: ${String(readings.length)} priors hold the floor, and the two-call router reproduces ${String(floor.dual.shipped)} shipped`);
      }
    }

    const payload = { population: { scored: rows.length, roster }, rate, readings, dual };
    if (args.json) log(JSON.stringify(payload, null, 2));
    if (args.artifact !== undefined) {
      const { mkdir, writeFile, rename } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(args.artifact), { recursive: true });
      await writeFile(`${args.artifact}.part`, `${JSON.stringify(payload, null, 2)}\n`);
      await rename(`${args.artifact}.part`, args.artifact);
      log(`text2vis: wrote ${args.artifact}`);
    }
    return 0;
  } catch (error) {
    log(`text2vis: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

void entryPrior(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`), {
  argv: process.argv.slice(2),
  load: {},
}).then((code) => applyExitCode(code, process));
