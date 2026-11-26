/**
 * The ledger the product is allowed to ship from, checked against the product.
 *
 * A gate that decides what ships is worth exactly as much as its ability to disagree with the
 * product, so this file exists to be red. It reads `shipment.json` — counts and prices, nothing
 * statistical — derives the one statistic the gate needs from the same function every other reading
 * in this repository uses, folds the chain, and then requires the recipe the chain ends on to be the
 * recipe `packages/ai` ships. Two ways to fail, and both are real:
 *
 * - **The ledger moves and the product does not.** A priced experiment that won but was never
 *   applied is the defect this project has already paid for once: the best combination the
 *   experiment found was not the prompt the product sent, and nothing noticed.
 * - **The product moves and the ledger does not.** A hand-edited recipe has no price and no reading
 *   behind it, which is the state every "we tried it and it felt better" change arrives in.
 *
 * ## Why the statistic is derived here and not stored
 *
 * The same reason `readings.ts` stores counts: a stored p-value is a second source of truth, and the
 * first thing to survive a count being corrected. `mcnemarExact` and `pairedResolution` are the
 * producers; this file is a caller. The interval is handed to the gate in percentage points and in
 * the sign the gate reads (positive when the challenger wins), which is the one conversion worth
 * stating out loud, because it is the conversion that would otherwise be wrong silently.
 *
 * ## `--self-test`
 *
 * Four tampered ledgers, each of which must be refused, and the real one, which must be accepted. A
 * check that has never been observed to fail is a check whose failure path nobody has read: the
 * miscopied count, the skipped chain step, the arm nobody ships, and the ledger that ends on the
 * wrong prompt are the four ways this file's verdict can be wrong, so each is produced on purpose.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SHIPPED_SQL } from '@agentix-e/nl2charts-ai';
import {
  adjudicateShipment,
  DEFAULT_SHIPMENT_POLICY,
  shipmentLines,
} from '@agentix-e/nl2charts-ai';
import type {
  ShipmentDecision,
  ShipmentLedger,
  ShipmentPolicy,
  ShipmentRecord,
  ShipmentResult,
  SqlRecipe,
  SqlRecipeName,
} from '@agentix-e/nl2charts-ai';
import { mcnemarExact, pairedResolution } from '@agentix-e/nl2charts-devkit';
import { isEntry } from './compare.js';

/** Where the ledger lives, relative to the repository root. */
export const LEDGER_PATH = 'eval/bird/shipment.json';

/**
 * One stored record with its statistics derived.
 *
 * The two conversions are the whole content of this function, and both are easy to get wrong in a
 * way that reads as right: the interval is converted to percentage points (the gate's unit) and to
 * the challenger's sign (`pairedResolution` calls the first argument "only first"), and the exact
 * test is called with the challenger first so that a reader does not have to hold the sign in mind.
 */
export function deriveDecision(record: ShipmentRecord): ShipmentDecision {
  const { onlyChallenger, onlyIncumbent } = record.paired;
  const total = record.challenger.total;
  const interval = pairedResolution(onlyIncumbent, onlyChallenger, total);
  return {
    ...record,
    p: mcnemarExact(onlyChallenger, onlyIncumbent),
    ci: { low: interval.low * 100, high: interval.high * 100 },
  };
}

/** What the ledger says, and whether the product agrees with it. */
export interface ShipmentCheck {
  readonly result: ShipmentResult;
  /** Everything that should make a build red, in the words a reader can act on. */
  readonly problems: readonly string[];
}

/**
 * Fold the ledger and compare it with the recipe the product ships.
 *
 * The comparison is on the recipe *name* rather than on the prompt text, because the prompt text is
 * already checked by `bench:bird:recipe`: that instrument answers "is this the prompt the arm sent",
 * this one answers "is this the recipe the experiment chose". Two questions, two instruments, and a
 * defect that slips past one of them is not a duplicate of the other.
 */
export function checkShipment(
  records: readonly ShipmentRecord[],
  shipped: SqlRecipeName = SHIPPED_SQL.name,
  policy: ShipmentPolicy = DEFAULT_SHIPMENT_POLICY,
): ShipmentCheck {
  const result = adjudicateShipment(records.map(deriveDecision), policy);
  const problems: string[] = [];
  for (const step of result.steps) {
    for (const problem of step.problems) problems.push(`${step.run}: ${problem}`);
  }
  if (result.recipe !== shipped) {
    problems.push(
      `the ledger ends on '${result.recipe}' and the product ships '${shipped}'; ` +
        'either the decision was never applied or the recipe was changed without one',
    );
  }
  return { result, problems };
}

/**
 * The four records that answer "which arm does this repository ship", and whether they agree.
 *
 * `checkShipment` answers a question about the ledger and the recipe: does the chain the ledger
 * folds end on the prompt `packages/ai` sends. That question was answered correctly for three
 * rounds while a reader holding two files — `eval/baseline/bird.json`'s `armsBySplit.dev` and
 * `eval/baseline/bird-ves.json`'s `arm` — could find two records that each looked like the answer
 * and disagreed: one named `select-mixed`, whose 62.34% was the best of the selection family, the
 * other `macsql-prompt`, which is the arm that ships at 65.93%. Neither file was wrong. What was
 * missing was a field whose whole content is "this is the arm the product sends", and a check that
 * refuses when the four things that imply it drift apart.
 *
 * The four are: the recipe (`SHIPPED_SQL.arm`), the baseline's declaration (`shippedBySplit`), the
 * reading the project publishes for that arm (`bird-ves.json`), and the ledger row that put it
 * there (`shipment.json`). A disagreement between any two is a document that will be quoted
 * wrongly, and the last one is the expensive kind: an arm admitted to the chain with no floor is an
 * arm whose regression fails nothing.
 *
 * Each rule below is one way that drift has a printed consequence, and `test/bird-shipped.test.ts`
 * produces each one from a tampered tree — a check whose failure path has never been read is not a
 * check.
 */
export interface ShippedCoordinates {
  /** Files to read, relative to `root`; the defaults are the ones this repository ships. */
  readonly bird?: string;
  readonly ves?: string;
  readonly ledger?: string;
}

const BIRD_BASELINE = 'eval/baseline/bird.json';
const VES_BASELINE = 'eval/baseline/bird-ves.json';

interface BirdBaseline {
  readonly shippedBySplit?: Record<string, string>;
  readonly armsBySplit?: Record<string, string[]>;
  readonly floors?: Record<string, Record<string, number>>;
}

interface VesBaseline {
  readonly split?: string;
  readonly arm?: string;
  readonly ex?: number;
  readonly scored?: number;
  readonly artifact?: { readonly workflowRun?: number };
}

/** Percent, to the two decimals a published reading is written to. */
function percentOf(correct: number, total: number): number {
  return Math.round((correct / total) * 10000) / 100;
}

/**
 * Every way the four records can disagree, in the words a reader can act on.
 *
 * Returns an array rather than throwing so that `main` can print all of them: a tree that has lost
 * the baseline declaration *and* the floor is one edit away from being two, and the second one is
 * easier to fix while the first is still on screen.
 */
export function shippedProblems(
  root: string,
  files: ShippedCoordinates = {},
  recipe: SqlRecipe = SHIPPED_SQL,
  known?: readonly ShipmentRecord[],
): readonly string[] {
  const paths = {
    bird: resolve(root, files.bird ?? BIRD_BASELINE),
    ves: resolve(root, files.ves ?? VES_BASELINE),
    ledger: resolve(root, files.ledger ?? LEDGER_PATH),
  };
  let bird: BirdBaseline;
  let ves: VesBaseline;
  let records: readonly ShipmentRecord[];
  try {
    bird = JSON.parse(readFileSync(paths.bird, 'utf8')) as BirdBaseline;
    ves = JSON.parse(readFileSync(paths.ves, 'utf8')) as VesBaseline;
    records = known ?? readLedger(paths.ledger);
  } catch (error) {
    return [`shipped: ${(error as Error).message}`];
  }

  const problems: string[] = [];
  const declared = bird.shippedBySplit;
  if (declared === undefined || Object.keys(declared).length === 0) {
    problems.push(
      `shipped: ${BIRD_BASELINE} has no \`shippedBySplit\`, so nothing on disk says which arm the ` +
        `product sends and every reader has to infer it from a field that means something else`,
    );
    return problems;
  }
  // The last decision is the one the chain ends on, which is what `checkShipment` folds; an earlier
  // row is a step the product has already taken.
  const last = records.at(-1);
  const winner = last?.challenger;

  for (const [split, arm] of Object.entries(declared)) {
    if (arm !== recipe.arm) {
      problems.push(
        `shipped: the baseline says \`${arm}\` ships on \`${split}\` and \`${recipe.name}\` ships ` +
          `\`${recipe.arm}\`; one of the two is a document about an arm the product does not send`,
      );
    }
    const chain = bird.armsBySplit?.[split];
    if (chain === undefined) {
      problems.push(`shipped: \`${split}\` declares a shipped arm and \`armsBySplit\` does not name the split`);
    } else if (!chain.includes(arm)) {
      problems.push(
        `shipped: \`${arm}\` is not in \`armsBySplit.${split}\`, so no dispatch ever scores the arm ` +
          `that ships and a green run is a statement about the harness alone`,
      );
    }
    const floor = bird.floors?.[split]?.[arm];
    if (floor === undefined) {
      problems.push(
        `shipped: \`${arm}\` has no floor on \`${split}\`, so a regression in the product fails ` +
          `nothing — the arm ships and nothing measures it`,
      );
    }
    if (ves.split !== split) {
      problems.push(`shipped: the R-VES reading is on \`${String(ves.split)}\` and the baseline ships an arm on \`${split}\``);
    }
    if (ves.arm !== arm) {
      problems.push(
        `shipped: the R-VES reading was taken on \`${String(ves.arm)}\` and the baseline says ` +
          `\`${arm}\` ships; the published number and the shipped arm have to be the same arm`,
      );
    }
    // A floor above the reading it was taken from would fail the run that produced it.
    if (floor !== undefined && ves.ex !== undefined && floor > ves.ex) {
      problems.push(
        `shipped: the floor for \`${arm}\` on \`${split}\` is ${String(floor)} and the reading it ` +
          `was taken from is ${String(ves.ex)}; a floor above its own reading fails the run that set it`,
      );
    }
    if (winner === undefined) {
      problems.push(`shipped: the ledger holds no decision, so nothing put \`${arm}\` in the product`);
    } else {
      if (winner.arm !== arm) {
        problems.push(
          `shipped: the ledger's last decision carries \`${winner.arm}\` and the baseline says ` +
            `\`${arm}\` ships — the experiment and the product disagree about what won`,
        );
      }
      if (ves.scored !== undefined && winner.total !== ves.scored) {
        problems.push(
          `shipped: the ledger's decision is over ${String(winner.total)} questions and the R-VES ` +
            `reading over ${String(ves.scored)}; two denominators, so the two numbers are not one reading`,
        );
      }
      if (ves.ex !== undefined && Math.abs(percentOf(winner.correct, winner.total) - ves.ex) > 0.005) {
        problems.push(
          `shipped: the ledger's counts say ${String(percentOf(winner.correct, winner.total))}% ` +
            `(${String(winner.correct)} of ${String(winner.total)}) and the R-VES baseline says ` +
            `${String(ves.ex)}%; one of the two was copied from a different run`,
        );
      }
      if (ves.artifact?.workflowRun !== undefined && String(ves.artifact.workflowRun) !== last?.run) {
        problems.push(
          `shipped: the R-VES reading is the artifact of run ${String(ves.artifact.workflowRun)} and ` +
            `the ledger's decision is from run ${String(last?.run)}`,
        );
      }
    }
  }
  return problems;
}

/** The ledger as it sits on disk, with the shape refused rather than guessed when it is not v1. */
export function readLedger(path: string): readonly ShipmentRecord[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  // An array is an object to `typeof`, and a ledger-shaped array would pass every field check below
  // by being empty: the empty ledger is a *valid* ledger that folds to `assembled`, so the wrong
  // shape has to be refused here rather than reasoned about later.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: not an object`);
  }
  const ledger = parsed as Partial<ShipmentLedger>;
  if (ledger.schemaVersion !== 1) {
    throw new Error(`${path}: schemaVersion ${String(ledger.schemaVersion)} is not one this reader knows`);
  }
  if (!Array.isArray(ledger.decisions)) throw new Error(`${path}: 'decisions' is not an array`);
  return ledger.decisions;
}

/** The record the shipped reading is, as a fixture the self-test can tamper with. */
const SHIPPED_RECORD: ShipmentRecord = {
  run: '44991167518',
  dataset: 'bird-dev',
  incumbent: { arm: 'assembled', correct: 980, total: 1532, tokensPerCase: 587 },
  challenger: { arm: 'macsql-prompt', correct: 1010, total: 1532, tokensPerCase: 134 },
  paired: { onlyChallenger: 119, onlyIncumbent: 89 },
  note: 'the reading that put the MAC-SQL prompt in the product',
};

/**
 * Four ledgers that must be refused, and one that must not.
 *
 * Each describes a way this check could be wrong while printing something plausible: a count that
 * was copied one digit off, a chain that skips the step which bought the current prompt, an arm the
 * recipe table does not ship, and a ledger that is empty. The last one matters most — an empty
 * ledger folds to `assembled`, which is not what the product sends, and a check that treated "no
 * decisions" as "no objections" would pass a product nobody chose.
 */
export function selfTest(check: typeof checkShipment = checkShipment): readonly string[] {
  const problems: string[] = [];
  const accepted = check([SHIPPED_RECORD]);
  if (accepted.problems.length > 0) problems.push(`the shipped reading was refused: ${accepted.problems.join('; ')}`);
  if (accepted.result.recipe !== 'shipped-sql') problems.push(`the shipped reading ends on ${accepted.result.recipe}`);

  const expected: readonly { readonly name: string; readonly records: readonly ShipmentRecord[]; readonly ships: SqlRecipeName }[] = [
    {
      name: 'a miscopied count',
      records: [
        { ...SHIPPED_RECORD, challenger: { ...SHIPPED_RECORD.challenger, correct: 1009 } },
      ],
      ships: 'assembled',
    },
    {
      name: 'a chain that skips the step that bought the current prompt',
      records: [{ ...SHIPPED_RECORD, incumbent: { ...SHIPPED_RECORD.incumbent, arm: 'macsql-prompt' } }],
      ships: 'assembled',
    },
    {
      name: 'an arm the recipe table does not ship',
      records: [{ ...SHIPPED_RECORD, challenger: { ...SHIPPED_RECORD.challenger, arm: 'macsql-bird-os' } }],
      ships: 'assembled',
    },
    { name: 'an empty ledger', records: [], ships: 'assembled' },
  ];
  for (const probe of expected) {
    const checked = check(probe.records);
    if (checked.problems.length === 0) problems.push(`'${probe.name}' was accepted`);
    if (checked.result.recipe !== probe.ships) {
      problems.push(`'${probe.name}' ends on ${checked.result.recipe}, not ${probe.ships}`);
    }
  }
  return problems;
}

/**
 * Entry point: `--check` by default, `--self-test` to prove the check can fail.
 *
 * `--ledger <path>`, `--bird <path>` and `--ves <path>` read one of the four records from somewhere
 * else, which exists for one reason: a refusal is part of what this instrument is *for*, and a
 * refusal that can only be produced by editing the files this repository ships is a refusal nobody
 * tests. The gate runs the defaults; the suite runs a tampered file through these flags and reads
 * the exit code.
 */
export function main(
  argv: readonly string[] = process.argv.slice(2),
  log: (line: string) => void = console.log,
  check: typeof checkShipment = checkShipment,
): number {
  if (argv.includes('--self-test')) {
    const problems = selfTest(check);
    for (const problem of problems) log(`FAILED ${problem}`);
    log(`shipment self-test: 1 accepted, 4 refused${problems.length === 0 ? '' : `, ${String(problems.length)} problems`}`);
    return problems.length === 0 ? 0 : 1;
  }
  const flag = argv.indexOf('--ledger');
  const requested = flag >= 0 ? argv[flag + 1] : undefined;
  const root = resolve(new URL('../..', import.meta.url).pathname);
  const records = readLedger(resolve(root, requested ?? LEDGER_PATH));
  const checked = check(records);
  for (const line of shipmentLines(checked.result)) log(line);
  for (const problem of checked.problems) log(`FAILED ${problem}`);
  // The four records that imply "this arm ships" are read here rather than in a test, because this
  // is the step the workflow runs: `pnpm bench:bird:ship` is where a document that disagrees with
  // the product has to be able to stop a build.
  //
  // `--bird` and `--ves` exist for the same reason `--ledger` does: the tree this repository ships
  // is not tampered with to test a gate, so every refusal below is produced through a flag.
  const files: { bird?: string; ves?: string } = {};
  for (const name of ['bird', 'ves'] as const) {
    const at = argv.indexOf(`--${name}`);
    const value = at >= 0 ? argv[at + 1] : undefined;
    if (value !== undefined) files[name] = value;
  }
  const coordinates = shippedProblems(root, files, SHIPPED_SQL, records);
  for (const problem of coordinates) log(`FAILED ${problem}`);
  log(
    `shipment: ${String(records.length)} decision(s) · ${checked.result.recipe} · ` +
      `alpha ${String(DEFAULT_SHIPMENT_POLICY.alpha)} · floor ${String(DEFAULT_SHIPMENT_POLICY.minDeltaPp)}pp · ` +
      `tariff ${String(DEFAULT_SHIPMENT_POLICY.tokenTariff)}pp/1x`,
  );
  return checked.problems.length === 0 && coordinates.length === 0 ? 0 : 1;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
