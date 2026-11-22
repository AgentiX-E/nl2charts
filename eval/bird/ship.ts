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
 * `--ledger <path>` reads a ledger from somewhere else, which exists for one reason: a refusal is
 * part of what this instrument is *for*, and a refusal that can only be produced by editing the
 * file this repository ships is a refusal nobody tests. The gate runs the default; the suite runs a
 * tampered file through this flag and reads the exit code.
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
  log(
    `shipment: ${String(records.length)} decision(s) · ${checked.result.recipe} · ` +
      `alpha ${String(DEFAULT_SHIPMENT_POLICY.alpha)} · floor ${String(DEFAULT_SHIPMENT_POLICY.minDeltaPp)}pp · ` +
      `tariff ${String(DEFAULT_SHIPMENT_POLICY.tokenTariff)}pp/1x`,
  );
  return checked.problems.length === 0 ? 0 : 1;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
