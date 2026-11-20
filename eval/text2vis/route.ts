/**
 * Routing between two arms: the same six rules, one seat moved.
 *
 * ## Why this file exists
 *
 * `llm.ts` prices one model on a corpus; `arbitrate.ts` prices rules over the disagreement between the
 * rule table and that model. The round before this one bought a second arm — the same vendor's
 * thinking mode, on the same rows, in the same dispatch — and it read **875** against the chat arm's
 * **861**, with a paired McNemar of p = 0.30. So the question the number poses is not "which arm is
 * better" (fourteen rows and a coin) but the one a product can act on: **is there a rule that reads the
 * two answers together better than either alone?**
 *
 * The ceiling for such a rule is the union, 948; the two arms agree on 1,234 rows and disagree on 236.
 * This file prices six rules on those 236, and reports what each one costs in rows.
 *
 * ## The one thing that makes the table honest
 *
 * The six rules are **the same six functions** `arbitrate.ts` already prices — reused by reference, not
 * re-implemented, and renamed only where a name would lie. A second copy of `cue-led` would be a second
 * definition of "the cue table leads with", and the two tables would then be able to disagree about a
 * row neither of them changed. `test/text2vis-route.test.ts` asserts the identity of the functions,
 * because a name is not an implementation.
 *
 * What changes between the two tables is which answer sits in `Dispute.product`: the arm that answers
 * without thinking. The field keeps its name because it is the seat, not the occupant — and the type's
 * guarantee, that the expected family is not among the fields, is exactly what makes a routing reading
 * a reading rather than a selector over the answer key.
 *
 * ## What a routed answer is allowed to be
 *
 * One of the two answers, or a refusal. `routeChoices` writes the mark an arm actually said, and
 * `null` where the rule refused; a hybrid mark would be an answer neither arm gave, and
 * `arbitrateDisputes` refuses it row by row. The shipping path then prices the routed answers exactly
 * as it prices a model's answers, which is the only comparison worth publishing: a decided number the
 * table can veto is not the number a caller receives.
 */
import { applyExitCode, isEntry, loadText2Vis, type LoadOptions } from './dataset.js';
import {
  arbitrateDisputes,
  assertArbitration,
  assertOfferedMark,
  describeArbitration,
  POLICIES,
  type ArbitrationReport,
  type Dispute,
  type Policy,
} from './arbitrate.js';
import { markAnswer, mcnemarExact, rosterOf, scoredRows, type ArmReport } from './llm.js';
import type { ProfileInput } from './profile.js';
import { cueMarks, familyOfLabel } from './rule.js';
import { shipReport, type ShipReport } from './ship.js';
import type { MarkName, RecommendableMark } from '@agentix-e/nl2charts-chart';

/**
 * The two answers and the cue table, read off one row.
 *
 * `left` is the arm that answers without thinking and `right` the one that thinks; that order is not
 * cosmetic, because `cue-led` and `cue-any` are rules about *when to keep the left answer*, and the
 * reading they produce is read the same way round in both tables.
 */
export function duelOf(row: ProfileInput, left: string | null, right: string | null): Dispute {
  assertOfferedMark(row, left);
  assertOfferedMark(row, right);
  const named = cueMarks(row.prompt);
  return {
    product:
      left === null
        ? { mark: 'declined', families: [] }
        : { mark: left as RecommendableMark, families: [left as RecommendableMark] },
    cueLead: named[0],
    cueNamed: named,
    model: right === null ? undefined : (right as RecommendableMark),
  };
}

/**
 * The six rules, renamed for the seat they sit in here.
 *
 * `choose` is taken from `POLICIES` rather than written again, and the notes are rewritten because a
 * note that says "the product" over a table whose baseline is a model is a sentence a reader would
 * have to correct before they could argue with the rule.
 */
const RENAMED: readonly { readonly from: string; readonly name: string; readonly note: string }[] = [
  { from: 'product', name: 'chat', note: 'the arm that answers without thinking, always: the baseline every other rule is held to' },
  { from: 'model', name: 'reasoner', note: 'the arm that thinks first, always: the reading that arm published, and what "ship the reasoner" would score' },
  { from: 'cue-led', name: 'cue-led', note: 'trust the chat arm only where the cue table *leads* with the mark it answered: the question named that shape first, so deliberation has nothing to add' },
  { from: 'cue-any', name: 'cue-any', note: 'trust the chat arm wherever a cue named the mark it answered, not only the strongest cue: it also keeps the rows the question named second' },
  { from: 'product-holds', name: 'chat-holds', note: 'the chat arm, except where it refused and the reasoner did not: a refusal is one arm saying it has nothing, so there is nothing to lose' },
  { from: 'model-holds', name: 'reasoner-holds', note: 'the reasoner, except where its reply named nothing: an unreadable answer is not a better answer than a readable one' },
];

/**
 * Apply a rename table to a rule table, keeping the implementations.
 *
 * A function rather than a module-level `.map` so the refusal below can be reached by a test: a rename
 * table that names a rule the source does not have is a table of six rules with five implementations,
 * and the missing one would price as `undefined` on the first row it was asked.
 */
export function renamePolicies(
  renames: readonly { readonly from: string; readonly name: string; readonly note: string }[],
  policies: readonly Policy[] = POLICIES,
): readonly Policy[] {
  return renames.map((rename) => {
    const source = policies.find((candidate) => candidate.name === rename.from);
    if (source === undefined) {
      throw new Error(`text2vis route: there is no ${rename.from} policy to rename, so the duel would hold five rules and report six`);
    }
    return { name: rename.name, note: rename.note, choose: source.choose };
  });
}

export const DUEL_POLICIES: readonly Policy[] = renamePolicies(RENAMED);

/** The answers a routed reading hands to the shipping path: one mark per row, `null` for a refusal. */
export function routeChoices(disputes: readonly Dispute[], policy: Policy): readonly (string | null)[] {
  return disputes.map((dispute) => {
    const answer = policy.choose(dispute);
    return answer.mark === 'declined' ? null : answer.mark;
  });
}

/**
 * Price every rule on two arms' answers.
 *
 * Two checks before a number is printed, and both are about the population rather than the arithmetic:
 * the answer lists must be one per row, and the roster must be the corpus this process loaded. An
 * artifact that answered a prefix of the rows (`--limit`) would otherwise be priced against the whole
 * corpus, which publishes a share over rows nobody asked.
 */
export function duelReport(
  rows: readonly ProfileInput[],
  left: readonly (string | null)[],
  right: readonly (string | null)[],
  label: string,
  roster: string,
): ArbitrationReport {
  if (left.length !== rows.length || right.length !== rows.length) {
    throw new Error(
      `text2vis route: ${String(left.length)} and ${String(right.length)} answers for ${String(rows.length)} rows, so the two arms are not answering the same questions`,
    );
  }
  const recomputed = rosterOf(rows);
  if (roster !== recomputed) {
    throw new Error(
      `text2vis route: the artifact answered a different population (${roster.slice(0, 12)}…) than the one on disk (${recomputed.slice(0, 12)}…), so its answers belong to questions it was not asked`,
    );
  }
  const disputes = rows.map((row, index) => duelOf(row, left[index] as string | null, right[index] as string | null));
  return { ...arbitrateDisputes(rows, disputes, label, DUEL_POLICIES), population: { scored: rows.length, roster } };
}

/** What a caller receives for one set of answers: the shipped reading, priced by the shipping path. */
export interface ShippedReading {
  readonly answers: string;
  readonly decided: number;
  readonly shipped: number;
  readonly changed: number;
  readonly report: ShipReport;
}

/**
 * Run the shipping path over answers that no arm produced, which is what a routed reading is.
 *
 * `shipReport` takes an answer list rather than an artifact — a seam it has for its own tests — and
 * that is exactly the interface a router needs: the routed answers go in, and the number that comes
 * out is the number a caller would receive, vetoes and all.
 */
export async function shippedUnder(
  rows: readonly ProfileInput[],
  choices: readonly (string | null)[],
  answers: string,
  roster: string,
  repair?: ReadonlyMap<string, string | undefined>,
): Promise<ShippedReading> {
  const report = await shipReport(rows, choices, answers, { roster }, repair === undefined ? {} : { repair });
  return { answers, decided: report.decided.hit, shipped: report.shipped.hit, changed: report.changed, report };
}

/**
 * Two shipped readings, paired row by row.
 *
 * A difference of two percentages is not a gain: 828 against 807 is twenty-one rows only if those
 * rows are the same rows, and the pairing is the only thing that says so. Each side is scored the way
 * the shipped path scores it — the leading family of the mark the row received against the family its
 * label names — so this is a comparison of two charts, not of two decisions.
 */
export function shippedPair(
  rows: readonly ProfileInput[],
  left: readonly MarkName[],
  right: readonly MarkName[],
): { readonly both: number; readonly leftOnly: number; readonly rightOnly: number; readonly neither: number; readonly p: number } {
  if (rows.length !== left.length || rows.length !== right.length) {
    throw new Error(
      `text2vis route: ${String(left.length)} and ${String(right.length)} marks for ${String(rows.length)} rows, so the two readings are not over the same rows`,
    );
  }
  let both = 0;
  let leftOnly = 0;
  let rightOnly = 0;
  let neither = 0;
  for (const [index, row] of rows.entries()) {
    const family = familyOfLabel(row.label);
    const leftHit = markAnswer(left[index] === 'declined' ? undefined : left[index]).families[0] === family;
    const rightHit = markAnswer(right[index] === 'declined' ? undefined : right[index]).families[0] === family;
    if (leftHit && rightHit) both += 1;
    else if (leftHit) leftOnly += 1;
    else if (rightHit) rightOnly += 1;
    else neither += 1;
  }
  return { both, leftOnly, rightOnly, neither, p: mcnemarExact(leftOnly, rightOnly) };
}

/** The floor a routing reading is held to, as the baseline records it. */
export interface DuelFloor {
  readonly scored: number;
  readonly best: string;
  readonly mark: number;
  readonly policies?: Readonly<Record<string, number>>;
}

/**
 * Refuse a routing reading that is below the floor, or about a different population.
 *
 * The floor is recorded per rule as well as in aggregate, because the aggregate is the one number a
 * round would be tempted to explain: a rule that reads 891 through five gains and one loss of fifteen
 * rows is not the same reading as one that reads 891 evenly, and the per-rule column is what lets a
 * later round say which of the two it reproduced.
 */
export function assertDuel(report: ArbitrationReport, floor: DuelFloor): void {
  if (report.population.scored !== floor.scored) {
    throw new Error(
      `text2vis route: the floor was taken on ${String(floor.scored)} rows and this reading is over ${String(report.population.scored)}; a share over another population is another instrument`,
    );
  }
  const best = report.policies.find((reading) => reading.name === floor.best);
  if (best === undefined) {
    throw new Error(`text2vis route: the floor names the rule ${floor.best}, which this table does not price`);
  }
  if (best.hit < floor.mark) {
    throw new Error(
      `text2vis route: ${best.name} reads ${String(best.hit)} and the floor is ${String(floor.mark)}; a rule that lost rows is a regression in the routing table, not a re-sample`,
    );
  }
  for (const [name, expected] of Object.entries(floor.policies ?? {})) {
    const reading = report.policies.find((candidate) => candidate.name === name);
    if (reading === undefined) throw new Error(`text2vis route: the floor records ${name}, which this table does not price`);
    if (reading.hit !== expected) {
      throw new Error(`text2vis route: ${name} reads ${String(reading.hit)} and the floor records ${String(expected)}`);
    }
  }
}

export interface RouteArgs {
  readonly json: boolean;
  readonly answers: string;
  readonly artifact?: string;
  readonly left?: string;
  readonly right?: string;
  readonly floor?: string;
  readonly require: boolean;
  readonly ship: boolean;
  readonly repair?: string;
}

/** Parse the command line, refusing anything it does not use — the reason `parseArbitrateArgs` gives. */
export function parseRouteArgs(argv: readonly string[]): RouteArgs {
  let json = false;
  let require = false;
  let ship = false;
  let answers: string | undefined;
  let artifact: string | undefined;
  let left: string | undefined;
  let right: string | undefined;
  let floor: string | undefined;
  let repair: string | undefined;
  const valued = new Set(['--answers', '--artifact', '--left', '--right', '--floor', '--repair']);
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
    if (flag === '--ship') {
      ship = true;
      continue;
    }
    if (valued.has(flag)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      if (flag === '--answers') answers = value;
      else if (flag === '--artifact') artifact = value;
      else if (flag === '--left') left = value;
      else if (flag === '--right') right = value;
      else if (flag === '--floor') floor = value;
      else repair = value;
      index += 1;
      continue;
    }
    throw new Error(
      `unknown argument ${flag}: this command prices answers already on disk, so it takes --answers <path>, --left <name>, --right <name>, --floor <path>, --require, --ship, --repair <path>, --json and --artifact <path>`,
    );
  }
  if (answers === undefined) throw new Error('--answers is required: this command routes between two arms whose answers are already on disk');
  return {
    json,
    require,
    ship,
    answers,
    ...(artifact === undefined ? {} : { artifact }),
    ...(left === undefined ? {} : { left }),
    ...(right === undefined ? {} : { right }),
    ...(floor === undefined ? {} : { floor }),
    ...(repair === undefined ? {} : { repair }),
  };
}

/** The shape this command reads out of `llm.ts`'s artifact, checked rather than trusted. */
interface Reading {
  readonly corpus?: { readonly roster?: unknown; readonly asked?: unknown };
  readonly arms?: readonly (Partial<ArmReport> & { readonly choices?: unknown })[];
}

/** One arm's answers, or the refusal that says which arm was missing. */
function choicesOf(reading: Reading, path: string, model: string): { model: string; choices: readonly (string | null)[] } {
  const arm = (reading.arms ?? []).filter((candidate) => candidate.scale === 'mark').find((candidate) => candidate.model === model);
  if (arm === undefined) {
    throw new Error(`${path} has no ${model} mark arm, and a route between one arm and nothing is not a reading`);
  }
  const choices = arm.choices;
  if (!Array.isArray(choices) || !choices.every((choice) => choice === null || typeof choice === 'string')) {
    throw new Error(`${path} carries no per-row choices for ${String(arm.model)}, so the rows it answered cannot be routed; re-run the arm that wrote it`);
  }
  return { model: String(arm.model), choices: choices as readonly (string | null)[] };
}

/**
 * The two seats, named or defaulted.
 *
 * A default of "the first arm in the file" for *both* seats is how a two-arm command prices one arm
 * against itself and reports a table of six rules that all read the same number. So the default is the
 * first two *distinct* mark arms, and a file with one arm is refused rather than doubled.
 */
function seatsOf(reading: Reading, path: string, left: string | undefined, right: string | undefined): { left: string; right: string } {
  const models = (reading.arms ?? []).filter((arm) => arm.scale === 'mark').map((arm) => String(arm.model));
  const distinct = [...new Set(models)];
  const leftName = left ?? distinct[0];
  if (leftName === undefined) throw new Error(`${path} has no mark-scale arm, so there are not two answers to route between`);
  const rightName = right ?? distinct.find((model) => model !== leftName);
  if (rightName === undefined) {
    throw new Error(
      `${path} holds one mark arm (${leftName}), and a route between one arm and itself prices the same answer twice; dispatch two models or name the second with --right`,
    );
  }
  return { left: leftName, right: rightName };
}

/** The repair file on disk, checked against the roster it was written for. */
async function readRepair(path: string, roster: string): Promise<ReadonlyMap<string, string | undefined>> {
  const { readFile } = await import('node:fs/promises');
  const { repairAnswers } = await import('./ship.js');
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { readonly population?: { readonly roster?: unknown } };
  const said = parsed.population?.roster;
  if (typeof said !== 'string') throw new Error(`${path} carries no population.roster, so the rows its second answers were given to cannot be identified`);
  if (said !== roster) throw new Error(`${path} answered a different population (${said.slice(0, 12)}…) than the artifact (${roster.slice(0, 12)}…)`);
  return repairAnswers(parsed);
}

export interface RouteEntryOptions {
  readonly argv?: readonly string[];
  readonly load?: LoadOptions;
}

/**
 * The command.
 *
 * Exit 1 for anything that would publish a routing table about the wrong population, the wrong
 * answers, or a rule below the floor it is held to. Nothing here calls a model: the two arms answered
 * once, the answers are on disk, and every number below is **¥0**.
 */
export async function entryRoute(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  options: RouteEntryOptions = {},
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  try {
    const args = parseRouteArgs(options.argv ?? []);
    const { corpus, source, path } = await loadText2Vis(options.load ?? {});
    log(`text2vis: ${source} ${path}`);
    const { rows: scored, dropped } = scoredRows(corpus);
    if (dropped > 0) log(`text2vis route: ${String(dropped)} rows carry a label no family names and are not part of any population`);
    const { readFile } = await import('node:fs/promises');
    const reading = JSON.parse(await readFile(args.answers, 'utf8')) as Reading;
    const roster = reading.corpus?.roster;
    if (typeof roster !== 'string') {
      throw new Error(`${args.answers} carries no corpus.roster, so the rows its answers were given to cannot be identified; re-run the arm that wrote it`);
    }
    const asked = typeof reading.corpus?.asked === 'number' ? reading.corpus.asked : undefined;
    const rows = asked === undefined ? scored : scored.slice(0, asked);
    const seats = seatsOf(reading, args.answers, args.left, args.right);
    const left = choicesOf(reading, args.answers, seats.left);
    const right = choicesOf(reading, args.answers, seats.right);
    if (left.model === right.model) {
      throw new Error(`both seats are ${left.model}: a route between one arm and itself prices the same answer twice, and every rule would read the arm's own score`);
    }
    const report = duelReport(rows, left.choices, right.choices, `${left.model} + ${right.model}`, roster);
    assertArbitration(report, 'chat');
    for (const line of describeArbitration(report)) log(line);
    const best = report.policies.reduce((winner, reading) => (reading.hit > winner.hit ? reading : winner));
    // Against the *better single arm*, not against the reasoning one: which of the two is better is a
    // fact about the corpus, and a margin printed against a named arm would be wrong on a corpus where
    // the other one leads. `reduce` with a seed rather than `find` plus a guard, because a table always
    // holds both arms and a branch for the case it does not is a branch nobody can reach.
    const alone = report.policies
      .filter((reading) => reading.name === 'chat' || reading.name === 'reasoner')
      .reduce((highest, reading) => (reading.hit > highest ? reading.hit : highest), 0);
    const margin = best.hit - alone;
    log(
      `text2vis route: the best rule is ${best.name} at ${String(best.hit)} of ${String(report.population.scored)}` +
        ` (${margin >= 0 ? '+' : ''}${String(margin)} against the better single arm)`,
    );

    const shipped: ShippedReading[] = [];
    if (args.ship) {
      const repair = args.repair === undefined ? undefined : await readRepair(args.repair, roster);
      const disputes = rows.map((row, index) => duelOf(row, left.choices[index] as string | null, right.choices[index] as string | null));
      const bestDisputes = routeChoices(disputes, DUEL_POLICIES.find((candidate) => candidate.name === best.name) as Policy);
      shipped.push(await shippedUnder(rows, left.choices, left.model, roster, repair));
      shipped.push(await shippedUnder(rows, right.choices, right.model, roster, repair));
      shipped.push(await shippedUnder(rows, bestDisputes, best.name, roster, repair));
      for (const entry of shipped) {
        log(`text2vis route: ${entry.answers}: decided ${String(entry.decided)}, shipped ${String(entry.shipped)}, changed ${String(entry.changed)}`);
      }
      const base = shipped[0] as ShippedReading;
      const routed = shipped[2] as ShippedReading;
      const pair = shippedPair(rows, base.report.marks, routed.report.marks);
      log(
        `text2vis route: ${routed.answers} against ${base.answers} on the shipped charts: ${String(pair.rightOnly)} rows gained,` +
          ` ${String(pair.leftOnly)} lost, ${String(pair.neither)} wrong on both, McNemar p = ${pair.p.toFixed(4)}`,
      );
    }

    if (args.require) {
      const floorPath = args.floor ?? 'eval/text2vis/baseline.json';
      const floor = (JSON.parse(await readFile(floorPath, 'utf8')) as { readonly llm?: { readonly duel?: DuelFloor } }).llm?.duel;
      if (floor === undefined) {
        log(`text2vis route: ${floorPath} records no llm.duel floor, so there is nothing for ${best.name} to be held to; this run establishes one`);
      } else {
        assertDuel(report, floor);
        log(`text2vis route: ${best.name} holds the floor at ${String(floor.mark)}`);
      }
    }

    const payload = { ...report, shipped };
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

void entryRoute(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`), {
  argv: process.argv.slice(2),
}).then((code) => applyExitCode(code, process));
