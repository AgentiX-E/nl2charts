/**
 * Can two levers that each paid, together, pay?
 *
 * This repository has a price for a prompt (`packages/ai/src/shipment.ts`: five points per 1× extra
 * cost) and an instrument that prices one lever at a time (`eval/bird/ship.ts`). It has never had an
 * instrument for the *compound*, and the plan's next item was exactly one: `macsql-bird-os` plus the
 * value block plus the row block. Three things were true of that item before this file existed:
 *
 * 1. Nobody had said what the compound had to score. The tariff is a function of the bill, and the
 *    bill of a prompt carrying two blocks is not the sum of the two bills — a shared card is paid
 *    once.
 * 2. Nobody had asked what the compound *could* score. Two blocks read the same card, so the cases
 *    they fix overlap, and the overlap is not small: 896 of the 1,020 questions either block
 *    answers are answered correctly by both.
 * 3. The one lever in the pair had already been closed in prose, against the wrong denominator.
 *
 * The third is the reason this file exists. `docs/benchmarks.md` recorded `samples-wide` as
 * "+2.02pp for +74.9% prompt tokens — refused on cost". The bill column of the same run reads
 * 241 → 317 tokens a case, which is +31.9%, and the gate's own definition of the quantity a
 * decision is made against (`ArmEvidence.tokensPerCase`) is the *miss* column plus the reply,
 * because a cached prompt token is a fiftieth of an uncached one. On the denominator the gate
 * actually uses, the block pays: +2.02pp against 1.60pp required, p = 0.0035. A lever worth two
 * points was closed by a sentence that divided by the wrong number.
 *
 * ## What this measures, and what it refuses to
 *
 * A compound's ceiling is the union of what its parts answer: a prompt that carried both blocks
 * could, at best, be right wherever either block's prompt was right. That is an oracle's bound and
 * it is stated as one — no implementable rule reaches it, which is why it can *refuse* an experiment
 * ("no arrangement of these blocks reaches the number the ledger demands") but can never *approve*
 * one. The expectation it prints next to the ceiling is the additive one, which counts the overlap
 * twice and is therefore an over-statement in the other direction on the same data.
 *
 * So the decision this file makes is narrow on purpose: **`cannot-pay` is final, `can-pay` is
 * permission to spend money on a run, not permission to ship.** The shipment gate still has to be
 * satisfied by a real paired reading, and nothing here can satisfy it.
 *
 * ## The two runs it reads
 *
 * Each artifact contributes one lever and the parent it was run against. The parents are allowed to
 * differ by a case or two — the rows run scored 939 on `inline+evidence` and the values run 941, on
 * the same 1,532 questions — and the ceiling is taken against the **larger** parent, because the
 * compound will be measured against one parent in one run and the unfavourable choice is the honest
 * one. A parent that differs by more than `PARENT_DRIFT_MAX` cases is refused instead: that is not
 * noise between two dispatches, that is two different prompts under one name.
 */
import { readFileSync } from 'node:fs';
import { isEntry } from './compare.js';
import { requiredPp } from './spend.js';

/** The most a parent's score may differ between two artifacts that name the same arm. */
export const PARENT_DRIFT_MAX = 5;

/** The tariff, re-exported so a caller importing this file cannot accidentally keep a second copy. */
export const requiredPpFor = requiredPp;

/** The token counts one case recorded, as the provider reported them. */
export interface CaseTokens {
  readonly prompt?: number;
  readonly completion?: number;
  readonly cached?: number;
}

/** One case, as an artifact stores it. */
export interface CaseRecord {
  readonly arm: string;
  readonly id: string;
  readonly passed: boolean;
  readonly tokens?: CaseTokens;
}

/** An artifact read into per-arm maps, with the run it came from. */
export interface ArtifactRead {
  readonly path: string;
  readonly run: string;
  readonly split: string;
  readonly arms: ReadonlyMap<string, ReadonlyMap<string, CaseRecord>>;
}

/** One lever against the parent it was dispatched with. */
export interface Measurement {
  readonly path: string;
  readonly run: string;
  readonly parent: string;
  readonly lever: string;
  readonly cases: number;
  /** Every question both arms were asked: what a union may be taken over. */
  readonly asked: ReadonlySet<string>;
  readonly parentCorrect: number;
  readonly leverCorrect: number;
  /** Cache-miss prompt tokens plus completion, a case: the quantity a bill is made of. */
  readonly parentBill: number;
  readonly leverBill: number;
  /** The questions each arm answered correctly, which is what a union is taken over. */
  readonly parentRight: ReadonlySet<string>;
  readonly leverRight: ReadonlySet<string>;
}

/** What a compound of several measured levers would have to be, and what it could be. */
export interface CompoundReading {
  readonly parent: string;
  readonly levers: readonly string[];
  readonly runs: readonly string[];
  readonly cases: number;
  /** The parent's score, taken from the artifact that scored it highest. */
  readonly parentCorrect: number;
  /** Questions either lever answered correctly. */
  readonly unionCorrect: number;
  /** Questions more than one lever answered correctly: the part an additive sum counts twice. */
  readonly overlap: number;
  /** Union minus parent, in percentage points. An oracle's bound, not a forecast. */
  readonly ceilingPp: number;
  /** The sum of the levers' own paired gains, in percentage points. An over-statement. */
  readonly additivePp: number;
  /** The parent's bill a case. */
  readonly parentBill: number;
  /** The parent's bill plus every block's own increment. */
  readonly compoundBill: number;
  /** How many times the parent's bill the compound is. */
  readonly multiple: number;
  /** Points the tariff demands at that multiple. */
  readonly requiredPp: number;
  /** The best score already on the table, when the caller names it. */
  readonly frontier?: Frontier;
  /** Union minus that score: the headroom a ceiling has over what the product already is. */
  readonly headroomPp?: number;
}

/**
 * The score the product already has, and the arm that holds it.
 *
 * A ceiling measured against its own parent says whether a lever is worth running. It does not say
 * whether the result is worth having, and the difference decided this round: the compound's union
 * against `inline+evidence` is +5.16pp of ceiling over a parent at 941, and the frontier arm — a
 * different prompt that this repository already ships — answers 1,020 of the same 1,532 questions.
 * A ceiling that lands exactly on the number already on the table buys a tie at 1.594x the bill.
 */
export interface Frontier {
  readonly arm: string;
  readonly correct: number;
  readonly cases: number;
  readonly run: string;
}

/** The two verdicts, and nothing in between. */
export type CompoundCode = 'can-pay' | 'cannot-pay';

export interface CompoundVerdict {
  readonly code: CompoundCode;
  readonly message: string;
}

/**
 * The bill-bearing tokens of one case.
 *
 * `prompt - cached` plus `completion`, which is the definition `ArmEvidence.tokensPerCase` states:
 * a cached prompt token is a fiftieth of an uncached one, so a long card that is reused is long and
 * not expensive. A record with no token object is `undefined` rather than zero — an unmeasured case
 * is not a free one — and a record whose cache exceeds its prompt is refused, because that
 * arithmetic would make a block look cheaper than free.
 */
export function billOfCase(tokens: CaseTokens | undefined): number | undefined {
  if (tokens === undefined) return undefined;
  const prompt = tokens.prompt ?? 0;
  const completion = tokens.completion ?? 0;
  const cached = tokens.cached ?? 0;
  if (cached > prompt) {
    throw new Error(`a case recorded ${String(cached)} cached prompt tokens against a prompt of ${String(prompt)}`);
  }
  return prompt - cached + completion;
}

/** Read one artifact into per-arm maps. */
export function readArtifact(path: string): ArtifactRead {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    split?: string;
    provenance?: { run?: string };
    cases?: readonly CaseRecord[];
  };
  const cases = parsed.cases ?? [];
  if (cases.length === 0) {
    throw new Error(`${path} carries no case, so it names no arm and prices nothing`);
  }
  const arms = new Map<string, Map<string, CaseRecord>>();
  for (const record of cases) {
    const byId = arms.get(record.arm) ?? new Map<string, CaseRecord>();
    byId.set(record.id, record);
    arms.set(record.arm, byId);
  }
  return {
    path,
    run: parsed.provenance?.run ?? 'unknown',
    split: parsed.split ?? 'unknown',
    arms,
  };
}

/** Pick one lever out of an artifact and measure it against the parent it was run with. */
export function measure(read: ArtifactRead, parent: string, lever: string): Measurement {
  const parentCases = read.arms.get(parent);
  if (parentCases === undefined) {
    throw new Error(`${read.path} never ran ${parent}, so ${lever} has no parent to be paired with`);
  }
  const leverCases = read.arms.get(lever);
  if (leverCases === undefined) {
    throw new Error(`${read.path} carries no case on arm ${lever}`);
  }
  const ids = [...parentCases.keys()].filter((id) => leverCases.has(id)).sort();
  if (ids.length === 0) {
    throw new Error(`${read.path} has no question that both ${parent} and ${lever} were asked`);
  }
  const parentRight = new Set<string>();
  const leverRight = new Set<string>();
  let parentBill = 0;
  let leverBill = 0;
  let billed = 0;
  for (const id of ids) {
    const parentCase = parentCases.get(id) as CaseRecord;
    const leverCase = leverCases.get(id) as CaseRecord;
    if (parentCase.passed) parentRight.add(id);
    if (leverCase.passed) leverRight.add(id);
    const parentCost = billOfCase(parentCase.tokens);
    const leverCost = billOfCase(leverCase.tokens);
    if (parentCost === undefined || leverCost === undefined) continue;
    parentBill += parentCost;
    leverBill += leverCost;
    billed += 1;
  }
  if (billed === 0) {
    throw new Error(`${read.path} recorded no token count on both ${parent} and ${lever}, so it cannot be priced`);
  }
  return {
    path: read.path,
    run: read.run,
    parent,
    lever,
    cases: ids.length,
    asked: new Set(ids),
    parentCorrect: parentRight.size,
    leverCorrect: leverRight.size,
    parentBill: parentBill / billed,
    leverBill: leverBill / billed,
    parentRight,
    leverRight,
  };
}

/**
 * Fold several measurements into one compound: what it could score and what it would cost.
 *
 * The ceiling is taken against the **highest** parent score among the artifacts, not the lowest and
 * not the mean: the compound will be dispatched once, against one parent, and taking the friendliest
 * baseline would be pricing a run nobody makes.
 */
export function compoundOf(readings: readonly Measurement[]): CompoundReading {
  const [first] = readings;
  if (first === undefined) {
    throw new Error('a compound of nothing has no ceiling and must not be reported as one');
  }
  const parent = first.parent;
  const ids = [...first.asked];
  for (const reading of readings) {
    if (reading.parent !== parent) {
      throw new Error(
        `${reading.lever} was measured against ${reading.parent}, not ${parent}, so the pair shares no baseline`,
      );
    }
    const theirs = reading.asked;
    if (theirs.size !== first.asked.size || ids.some((id) => !theirs.has(id))) {
      throw new Error(
        `${reading.lever} was not asked the same questions as ${first.lever}, so a union over them is a union of two splits`,
      );
    }
    if (Math.abs(reading.parentCorrect - first.parentCorrect) > PARENT_DRIFT_MAX) {
      throw new Error(
        `${parent} scored ${String(reading.parentCorrect)} in ${reading.run} and ${String(first.parentCorrect)} in ${first.run}; more than ${String(PARENT_DRIFT_MAX)} cases apart is two prompts under one name`,
      );
    }
  }
  if (ids.length === 0) {
    throw new Error(`${parent} answered nothing correctly, so a ceiling over it would be a ceiling over the split`);
  }

  const union = new Set<string>();
  const counts = new Map<string, number>();
  for (const reading of readings) {
    for (const id of reading.leverRight) {
      union.add(id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const overlap = [...counts.values()].filter((count) => count > 1).length;
  const parentCorrect = Math.max(...readings.map((reading) => reading.parentCorrect));
  const parentBill = Math.max(...readings.map((reading) => reading.parentBill));
  const compoundBill = readings.reduce(
    (total, reading) => total + (reading.leverBill - reading.parentBill),
    parentBill,
  );
  const multiple = compoundBill / parentBill;
  const cases = first.cases;
  return {
    parent,
    levers: readings.map((reading) => reading.lever),
    runs: readings.map((reading) => reading.run),
    cases,
    parentCorrect,
    unionCorrect: union.size,
    overlap,
    ceilingPp: ((union.size - parentCorrect) / cases) * 100,
    additivePp: readings.reduce(
      (total, reading) => total + ((reading.leverCorrect - reading.parentCorrect) / cases) * 100,
      0,
    ),
    parentBill,
    compoundBill,
    multiple,
    requiredPp: requiredPpFor(multiple),
  };
}

/**
 * The score one arm already holds, read off an artifact.
 *
 * The artifact has to be a run of the same split, and this function refuses one that asked a
 * different number of questions: two scores over two corpora are not two scores over one, and the
 * comparison this feeds is the only thing standing between a ceiling and a purchase.
 */
export function frontierOf(path: string, arm: string, cases: number): Frontier {
  const read = readArtifact(path);
  const rows = read.arms.get(arm);
  if (rows === undefined) {
    throw new Error(`${path} never ran ${arm}, so it holds no frontier to compare against`);
  }
  if (rows.size !== cases) {
    throw new Error(
      `${path} scored ${arm} on ${String(rows.size)} questions and this compound is over ${String(cases)}, so the two numbers are not on one split`,
    );
  }
  let correct = 0;
  for (const row of rows.values()) if (row.passed) correct += 1;
  return { arm, correct, cases: rows.size, run: read.run };
}

/**
 * Does the compound's ceiling clear its own price?
 *
 * `cannot-pay` is the only final answer: a ceiling below the tariff means no arrangement of these
 * blocks reaches what the ledger demands, so the run is not a purchase. `can-pay` means the
 * arithmetic permits the experiment — the shipment gate still needs a paired reading, and this
 * function cannot produce one.
 *
 * A named frontier joins the price as a second way to be refused, and it is the stricter one: a
 * ceiling that ties the score the product already has cannot pay at any price, because the best
 * case is a tie at a bigger bill. The two refusals are different facts and the message says which.
 */
export function verdictOf(reading: {
  readonly ceilingPp: number;
  readonly requiredPp: number;
  readonly unionCorrect?: number;
  readonly frontier?: Frontier;
}): CompoundVerdict {
  const ceiling = Math.round(reading.ceilingPp * 100) / 100;
  const required = Math.round(reading.requiredPp * 100) / 100;
  if (reading.frontier !== undefined && reading.unionCorrect !== undefined && reading.frontier.correct >= reading.unionCorrect) {
    return {
      code: 'cannot-pay',
      message:
        `the ceiling reaches ${String(reading.unionCorrect)} questions and ${reading.frontier.arm} already answers ` +
        `${String(reading.frontier.correct)} of the same ${String(reading.frontier.cases)} (run ${reading.frontier.run}): the ` +
        `best arrangement of these blocks ties what the product has, and a tie at ${reading.requiredPp.toFixed(2)}pp of ` +
        `tariff is not a purchase`,
    };
  }
  if (ceiling < required) {
    return {
      code: 'cannot-pay',
      message: `ceiling ${ceiling.toFixed(2)}pp is under the ${required.toFixed(2)}pp its own bill demands, so no arrangement of these blocks can pay`,
    };
  }
  return {
    code: 'can-pay',
    message: `ceiling ${ceiling.toFixed(2)}pp clears the ${required.toFixed(2)}pp its bill demands, by ${(ceiling - required).toFixed(2)}pp; a paired run decides whether any arrangement of them reaches it`,
  };
}

/** The report, as lines: the ceiling, the expectation, the price, the verdict. */
export function reportLines(
  reading: CompoundReading,
  verdict: CompoundVerdict = verdictOf(reading),
): readonly string[] {
  const cases = String(reading.cases);
  const frontier =
    reading.frontier === undefined
      ? []
      : [
          `  frontier ${reading.frontier.arm} ${String(reading.frontier.correct)} / ${String(reading.frontier.cases)} = ` +
            `${((reading.frontier.correct / reading.frontier.cases) * 100).toFixed(2)}%  ` +
            `${(reading.headroomPp ?? 0) >= 0 ? '+' : ''}${(reading.headroomPp ?? 0).toFixed(2)}pp of headroom (run ${reading.frontier.run})`,
        ];
  return [
    `compound of ${reading.levers.join(' + ')} over ${reading.parent} (${cases} questions, runs ${reading.runs.join(', ')})`,
    `  parent   ${String(reading.parentCorrect)} / ${cases} = ${((reading.parentCorrect / reading.cases) * 100).toFixed(2)}%`,
    `  ceiling  ${String(reading.unionCorrect)} / ${cases} = ${((reading.unionCorrect / reading.cases) * 100).toFixed(2)}%  +${reading.ceilingPp.toFixed(2)}pp  (oracle: right wherever either block was)`,
    `  additive +${reading.additivePp.toFixed(2)}pp  (counts the ${String(reading.overlap)} questions both blocks fix twice)`,
    `  bill     ${reading.parentBill.toFixed(0)} -> ${reading.compoundBill.toFixed(0)} a case  x${reading.multiple.toFixed(3)}  demands +${reading.requiredPp.toFixed(2)}pp`,
    ...frontier,
    `  verdict  ${verdict.code}: ${verdict.message}`,
  ];
}

/** Asserts `--self-test` makes, for the line it prints. */
export const SELF_TEST_ASSERTIONS = 11;

/** The self-test: the arithmetic this file exists to get right, on numbers small enough to check. */
export function selfTest(): { problems: readonly string[]; assertions: number } {
  const problems: string[] = [];
  let assertions = 0;
  const same = (name: string, actual: unknown, expected: unknown): void => {
    assertions += 1;
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    problems.push(`${name}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  };

  same('a bill is misses plus the reply', billOfCase({ prompt: 1000, completion: 100, cached: 800 }), 300);
  same('an unmeasured case is not a free one', billOfCase(undefined), undefined);
  same('a union counts a question once', [...new Set(['a', 'a', 'b'])], ['a', 'b']);
  same('the tariff at parity is the smallest gain worth a switch', requiredPpFor(1) <= requiredPpFor(2), true);
  same('five points a unit of extra cost', requiredPpFor(3), 10);
  same('a ceiling under the price cannot pay', verdictOf({ ceilingPp: 1, requiredPp: 2 }).code, 'cannot-pay');
  same('a ceiling over the price may be run', verdictOf({ ceilingPp: 2, requiredPp: 1 }).code, 'can-pay');

  const compound = compoundOf([
    {
      path: 'a',
      run: '1',
      parent: 'p',
      lever: 'x',
      cases: 100,
      asked: new Set(Array.from({ length: 100 }, (_, i) => `q${String(i)}`)),
      parentCorrect: 60,
      leverCorrect: 62,
      parentBill: 200,
      leverBill: 260,
      parentRight: new Set(Array.from({ length: 60 }, (_, i) => `q${String(i)}`)),
      leverRight: new Set(Array.from({ length: 62 }, (_, i) => `q${String(i + 40)}`)),
    },
    {
      path: 'b',
      run: '2',
      parent: 'p',
      lever: 'y',
      cases: 100,
      asked: new Set(Array.from({ length: 100 }, (_, i) => `q${String(i)}`)),
      parentCorrect: 60,
      leverCorrect: 63,
      parentBill: 200,
      leverBill: 250,
      parentRight: new Set(Array.from({ length: 60 }, (_, i) => `q${String(i)}`)),
      leverRight: new Set(Array.from({ length: 63 }, (_, i) => `q${String(i + 50)}`)),
    },
  ]);
  same('the ceiling is the union minus the parent', compound.ceilingPp, 13);
  same(
    'the bill is the parent plus each block',
    [compound.compoundBill, Math.round(compound.multiple * 100) / 100],
    [310, 1.55],
  );
  // The refusal this round produced: a ceiling that lands on the score already on the table buys a
  // tie, and a tie at any tariff above zero is not a purchase. The union is 75 of 100 here.
  const frontier = { arm: 'shipped', correct: 75, cases: 100, run: '3' };
  same(
    'a ceiling that ties the shipped score cannot pay',
    verdictOf({ ceilingPp: compound.ceilingPp, requiredPp: compound.requiredPp, unionCorrect: 75, frontier }).code,
    'cannot-pay',
  );
  same(
    'a ceiling one question above the shipped score is a headroom rather than a tie',
    verdictOf({ ceilingPp: compound.ceilingPp, requiredPp: compound.requiredPp, unionCorrect: 76, frontier: { ...frontier, correct: 75 } }).code,
    'can-pay',
  );
  return { problems, assertions };
}

/** Flags this file reads, and nothing else. */
export interface Settings {
  readonly parent: string;
  readonly artifacts: readonly string[];
  /** The artifact holding the best score already on the table, when the caller names one. */
  readonly frontierArtifact?: string;
  readonly frontierArm?: string;
}

/** Parse the command line. */
export function resolveSettings(argv: readonly string[]): Settings {
  const artifacts: string[] = [];
  let parent = 'inline+evidence';
  let frontierArtifact: string | undefined;
  let frontierArm: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === '--parent') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--parent needs an arm name');
      parent = value;
      index += 1;
      continue;
    }
    if (argument === '--frontier') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--frontier needs an artifact path');
      frontierArtifact = value;
      index += 1;
      continue;
    }
    if (argument === '--frontier-arm') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--frontier-arm needs an arm name');
      frontierArm = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) throw new Error(`unknown flag ${argument}`);
    artifacts.push(argument);
  }
  if (artifacts.length === 0) {
    throw new Error('name at least one artifact: compound.ts <artifact>... [--parent <arm>] [--frontier <artifact> --frontier-arm <arm>]');
  }
  // Both or neither: a ceiling compared against an arm nobody named is a comparison to nothing, and
  // an arm named without its artifact is a number with no source.
  if ((frontierArtifact === undefined) !== (frontierArm === undefined)) {
    throw new Error('--frontier and --frontier-arm go together: an artifact with no arm names no score, and an arm with no artifact has no run behind it');
  }
  return {
    parent,
    artifacts,
    ...(frontierArtifact === undefined ? {} : { frontierArtifact }),
    ...(frontierArm === undefined ? {} : { frontierArm }),
  };
}

/** The entry point. */
export function main(
  argv: readonly string[] = process.argv.slice(2),
  log: (line: string) => void = console.log,
  // Injectable for the same reason `marginal.ts`'s is: a self-test whose failure path has never
  // run is a self-test that has only been proved to pass. A stub that returns one problem is the
  // only way to see the `FAILED` line and the exit code it produces.
  check: typeof selfTest = selfTest,
): number {
  if (argv.includes('--self-test')) {
    const { problems, assertions } = check();
    for (const problem of problems) log(`FAILED ${problem}`);
    log(
      `compound self-test: ${String(assertions)} assertions${problems.length === 0 ? '' : `, ${String(problems.length)} problems`}`,
    );
    return problems.length === 0 ? 0 : 1;
  }
  const settings = resolveSettings(argv);
  const readings = settings.artifacts.map((path) => {
    const read = readArtifact(path);
    const levers = [...read.arms.keys()].filter((arm) => arm !== settings.parent);
    if (levers.length !== 1) {
      throw new Error(
        `${path} carries ${String(levers.length)} arms besides ${settings.parent}, so it names no single lever`,
      );
    }
    return measure(read, settings.parent, levers[0] as string);
  });
  const reading = compoundOf(readings);
  const frontier =
    settings.frontierArtifact === undefined || settings.frontierArm === undefined
      ? undefined
      : frontierOf(settings.frontierArtifact, settings.frontierArm, reading.cases);
  const withFrontier: CompoundReading =
    frontier === undefined
      ? reading
      : { ...reading, frontier, headroomPp: ((reading.unionCorrect - frontier.correct) / reading.cases) * 100 };
  const verdict = verdictOf(withFrontier);
  for (const line of reportLines(withFrontier, verdict)) log(line);
  return verdict.code === 'can-pay' ? 0 : 1;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
