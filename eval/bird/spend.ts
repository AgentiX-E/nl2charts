/**
 * What a dispatch may spend, decided before it spends it.
 *
 * This file exists because of `45090651019`: `deepseek-v4-pro`, `bird-dev`, 1,532 questions, ¥110.08
 * on the artifact and ¥124 on the provider's page — and 975/1,532, which is 2.09 points *below* the
 * same arm on a model whose bill was ¥4. Four things were wrong and each is a rule here:
 *
 * 1. **The model had no price row.** `bench:bill` answered "no price on file for deepseek-v4-pro"
 *    about a run that had already been billed, so the one command this repository uses to answer
 *    "what did that cost" could not answer it — and the dispatch had gone out on a hand estimate
 *    of ¥35-55 that was written against the *idle-hour* rate of a model that was not on the table.
 *    An unpriceable model is refused outright: a route with no arithmetic is not a cheap route.
 * 2. **Thinking mode was a default.** 94.0% of that run's completion tokens were reasoning,
 *    charged as output at ¥27 a million. The same mode had already been refused by `ship.ts` at the
 *    tariff in `DEFAULT_SHIPMENT_POLICY` — five points per doubling — and this dispatch was its
 *    bigger sibling. A thinking model now has to declare the gain it expects, and the declaration is
 *    checked against that tariff rather than argued with.
 * 3. **The money was projected from a price instead of from a measurement.** A price says what a
 *    token costs; it does not say how many tokens a case takes, which on this corpus ranges from 134
 *    to 2,536 completion tokens depending on the model *and the prompt it was measured under*.
 *    Above {@link PROBE_LIMIT} questions there is no projection without a measured basis, and the
 *    basis is charged {@link SAFETY_MULTIPLE} because it was measured on whatever prompt that run
 *    sent, not on the one about to be sent.
 * 4. **The scale was never priced before it was bought.** Above {@link BUDGET_YUAN} the basis has to
 *    have been measured on *this* dispatch — a probe — and the caller has to state the ceiling it
 *    accepts. A ledger row measured on another arm is refused, because that is exactly the
 *    substitution that turned 134 tokens a case into 2,536.
 *
 * ## The basis is tokens, never money
 *
 * A recorded basis stores prompt / completion / cache-hit tokens per case and nothing else. Money
 * is derived by `billOf` at print time, so a provider's price change re-prices every recorded
 * measurement in one commit instead of leaving a table of stale yuan behind. This is the same
 * separation `eval/price.ts` makes between a citation and a calculation, and it is why the ledger
 * can be read by `bench:bill`'s own arithmetic instead of a second implementation of it.
 *
 * ## Why the refusals are codes
 *
 * `CODES` is exported and the report groups by it: a refusal that exists only as a sentence is
 * grouped by spelling, and the grouping is what a later round reads to decide what to fix.
 *
 *   tsx eval/bird/spend.ts --model deepseek-chat --limit 1534
 *   tsx eval/bird/spend.ts --model deepseek-flash --limit 100 --accept-thinking 20
 *   tsx eval/bird/spend.ts --model deepseek-chat --limit 3068 --arms a,b --accept-cost 14
 *   tsx eval/bird/spend.ts --record eval/out/bird-eval.json --model deepseek-chat
 *   tsx eval/bird/spend.ts --self-test
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_SHIPMENT_POLICY } from '@agentix-e/nl2charts-ai';
import { isEntry } from './compare.js';
import { billOf, formatYuan, PRICES } from '../price.js';

/** Where a measured basis lives, relative to the repository root. */
export const LEDGER_PATH = 'eval/spend/per-case.json';

/**
 * The tariff from `DEFAULT_SHIPMENT_POLICY.tokenTariff`: points a challenger must win per 1x extra
 * cost.
 *
 * Imported as a number rather than re-derived, because it is one policy: a change to what a point
 * of accuracy is worth has to move the shipment gate and this one in the same commit. A second
 * copy of the number would let a dispatch price itself against a rule the ledger does not use.
 */
export const TOKEN_TARIFF = DEFAULT_SHIPMENT_POLICY.tokenTariff;

/** The most a single dispatch may project without a probe and a stated ceiling, in yuan. */
export const BUDGET_YUAN = 10;

/** The largest run that needs no cost basis, because a run this small *is* the basis. */
export const PROBE_LIMIT = 150;

/** The fewest cases an artifact may contain before its per-case mean is an anecdote. */
export const MIN_BASIS_CASES = 50;

/**
 * What a projection is multiplied by, and why it is not 1.
 *
 * The basis was measured on a prompt that is not the prompt about to be sent: a build that reads a
 * wider card, a corpus arm that inlines value blocks, an evidence block that pays for retrieval.
 * Those move completion tokens by tens of percent in either direction, and the direction that
 * matters is the one where the bill is larger than the reading that authorized it. Half again is
 * not a confidence interval; it is a stated surcharge for the fact that the number is a
 * measurement of a different run.
 */
export const SAFETY_MULTIPLE = 1.5;

/**
 * Models that may not be dispatched, with the measurement that closed them.
 *
 * This is a table and not a flag on purpose. A flag would be set to the value that gets the run
 * out the door — that is what flags are for — and the run this file was written after was
 * dispatched by someone holding every one of these numbers and a flag to spare. Reinstating a
 * model here is a reviewed diff, which is the only thing that has ever made this repository stop.
 */
export const RETIRED: Readonly<Record<string, string>> = {
  'deepseek-v4-pro':
    '975/1,532 on `macsql-bird-os` (63.64%), against 1,020 for the same arm on `deepseek-flash` ' +
    '(45090651019 against 45040430602): -2.09pp, at ¥0.0719 a case against ¥0.0016. That is 45.5x ' +
    'the price for less accuracy, and the reading was billed ¥110.08.',
};

/**
 * Models that reason before they answer, and what that cost the last time it was measured.
 *
 * `multiple` is a ratio of two measured bills on the same arm — ¥ a case with the mode, over ¥ a
 * case without it — and each entry names the run that produced it. It is the only number here that
 * is not read off a provider's page, so it is the one that has to carry its provenance.
 *
 * `deepseek-flash` is on this list even though it is also the name every chat reading is *served*
 * under: named as a model, that alias routes to an endpoint that answers `family: "reasoning"`,
 * ignores sampling, and spends 1,183 of its 1,250 completion tokens a case on deliberation.
 * `deepseek-chat` is the name that routes to the same weights in the mode this repository prices.
 */
export const THINKING: Readonly<
  Record<string, { readonly multiple: number; readonly run: string; readonly note: string }>
> = {
  'deepseek-flash': {
    multiple: 6.76,
    run: '45040430602',
    note: 'same arm `macsql-prompt` as 44991167518: ¥0.010670 a case against ¥0.001578, 1,183 of 1,250 completion tokens a case reasoning',
  },
  'deepseek-reasoner': {
    multiple: 6.76,
    run: '45040430602',
    note: "one base model's thinking mode, routed to the weights `deepseek-flash` names",
  },
  'deepseek-v4-pro': {
    multiple: 45.5,
    run: '45090651019',
    note: '2,385 of 2,536 completion tokens a case were reasoning',
  },
};

/** Every code {@link adjudicateSpend} can return. Exported so a report can group by it. */
export const CODES = [
  'ok',
  'bad-limit',
  'retired',
  'unpriced',
  'thinking-undocumented',
  'thinking-too-cheap',
  'artifact-model-mismatch',
  'artifact-too-thin',
  'artifact-unattributed',
  'no-cost-basis',
  'over-budget-no-probe',
  'accept-cost-missing',
  'accept-cost-too-low',
] as const;

export type SpendCode = (typeof CODES)[number];

/** One dispatch, as the caller asks for it. */
export interface SpendRequest {
  readonly model: string;
  /** Questions this run will score. Blank in the workflow means the whole split, which is 1,534. */
  readonly limit: number;
  /** Percentage points the caller expects a thinking mode to buy. Checked, not believed. */
  readonly acceptThinkingPp?: number;
  /** The ceiling the caller accepts, in yuan. Required only above {@link BUDGET_YUAN}. */
  readonly acceptCostYuan?: number;
  /**
   * The arms this dispatch runs, when the caller knows them.
   *
   * The basis above the budget has to be measured on a prompt this dispatch actually sends, and an
   * arm name is how a ledger row says which prompt it measured. Without this the only way to
   * satisfy the check was a probe artifact, which a CI dispatch cannot pass — so a run measured on
   * its own arm yesterday was refused for not having been measured on it today, and the route out
   * was to stop asking. A row measured on one of these arms answers the question the check is
   * asking; a row measured on some other arm does not.
   */
  readonly arms?: readonly string[];
}

/** Tokens per case for one build, the unit every basis is stored in. */
export interface CostBasis {
  readonly prompt: number;
  readonly completion: number;
  readonly cached: number;
  readonly reasoning?: number;
  /** Cases the artifact scored, which is larger than the arm's own count when it had siblings. */
  readonly cases: number;
  readonly source: 'probe' | 'ledger';
  /** The build the mean was taken over. Required, because a mean over four builds is not a basis. */
  readonly arm: string;
  readonly run?: string;
  readonly asOf?: string;
  readonly served?: readonly string[];
}

/** What a run is projected to cost, and the basis it was projected from. */
export interface Projection {
  readonly perCase: number;
  readonly total: number;
  readonly limit: number;
  readonly safety: number;
  readonly basis: CostBasis;
}

export interface SpendVerdict {
  readonly ok: boolean;
  readonly code: SpendCode;
  readonly message: string;
  readonly projection?: Projection;
}

/** A row of the ledger: a basis with the run that measured it. */
export interface LedgerRow {
  readonly prompt: number;
  readonly completion: number;
  readonly cached: number;
  readonly reasoning?: number;
  readonly cases: number;
  readonly arm: string;
  readonly run: string;
  readonly asOf: string;
  readonly served: readonly string[];
}

export interface Ledger {
  readonly note?: string;
  readonly rows: Readonly<Record<string, LedgerRow>>;
}

/** The subset of an artifact this file reads. Every field is optional because artifacts have aged. */
export interface SpendCase {
  readonly arm?: string;
  readonly tokens?: {
    readonly prompt?: number;
    readonly completion?: number;
    readonly cached?: number;
    readonly reasoning?: number;
  };
}

export interface SpendArtifact {
  readonly model?: string;
  readonly cases?: readonly SpendCase[];
  readonly arms?: readonly {
    readonly arm: string;
    readonly servedModels?: Readonly<Record<string, number>>;
  }[];
  readonly provenance?: { readonly run?: string; readonly workflow?: string };
  readonly generatedAt?: string;
}

/** A refusal produced while reading an artifact, before any dispatch decision is made. */
interface ArtifactRefusal {
  readonly code: 'unpriced' | 'artifact-model-mismatch' | 'artifact-too-thin' | 'artifact-unattributed';
  readonly message: string;
}

const isRefusal = (value: unknown): value is ArtifactRefusal =>
  typeof value === 'object' && value !== null && 'code' in value;

/**
 * The gain the tariff demands at a given price multiple, in percentage points.
 *
 * The same arithmetic `adjudicateDecision` applies in `packages/ai/src/shipment.ts`: five points
 * per 1x extra cost, floored by the smallest gain worth switching for. At 6.76x the mode has to
 * win 28.8 points and at 45.5x it has to win 222.5 — neither of which any arm on this corpus has
 * ever produced, which is the point. The closure of thinking mode is derived here rather than
 * asserted somewhere, so an arm that really does move 29 points re-opens it without anybody
 * editing a rule.
 *
 * Written as the policy's own formula rather than as a logarithm, because a different curve here
 * would be a second tariff: the shipment gate prices a candidate at five points a unit of extra
 * cost, and a dispatch that priced the same model at five points a *doubling* would let through
 * what the ledger refuses. `test/spend.test.ts` checks the two agree number for number.
 */
export function requiredPp(multiple: number): number {
  return Math.max(DEFAULT_SHIPMENT_POLICY.minDeltaPp, TOKEN_TARIFF * Math.max(0, multiple - 1));
}

/** One arm's mean tokens a case, and the money it becomes at today's price. */
function armBasis(artifact: SpendArtifact, model: string): CostBasis | ArtifactRefusal {
  const cases = (artifact.cases ?? []).filter((entry) => entry.tokens !== undefined);
  if (cases.length < MIN_BASIS_CASES) {
    return {
      code: 'artifact-too-thin',
      message: `the artifact carries ${String(cases.length)} priced cases; a mean over fewer than ${String(MIN_BASIS_CASES)} is an anecdote, not a basis`,
    };
  }
  const byArm = new Map<
    string,
    {
      cases: number;
      prompt: number;
      completion: number;
      cached: number;
      reasoning: number;
    }
  >();
  for (const entry of cases) {
    const arm = entry.arm ?? 'unnamed';
    const totals = byArm.get(arm) ?? {
      cases: 0,
      prompt: 0,
      completion: 0,
      cached: 0,
      reasoning: 0,
    };
    totals.cases += 1;
    totals.prompt += entry.tokens?.prompt ?? 0;
    totals.completion += entry.tokens?.completion ?? 0;
    totals.cached += entry.tokens?.cached ?? 0;
    totals.reasoning += entry.tokens?.reasoning ?? 0;
    byArm.set(arm, totals);
  }
  // The worst arm, not the mean over arms: a dispatch has to be able to afford the build it will
  // actually send, and averaging a lean arm against a fat one prices a run nobody sends.
  let worst: CostBasis | undefined;
  let worstYuan = 0;
  for (const [arm, totals] of byArm) {
    if (totals.cases < MIN_BASIS_CASES) continue;
    const basis: CostBasis = {
      prompt: Math.round(totals.prompt / totals.cases),
      completion: Math.round(totals.completion / totals.cases),
      cached: Math.round(totals.cached / totals.cases),
      reasoning: Math.round(totals.reasoning / totals.cases),
      cases: cases.length,
      source: 'probe',
      arm,
    };
    // `as number` rather than `?? 0`: `basisOf` has already refused a model with no price row, so
    // an undefined here would mean that refusal was deleted, and pricing an arm at zero to keep a
    // cast quiet is the kind of silence this file exists to remove.
    const yuan = billOf(model, {
      promptTokens: basis.prompt,
      completionTokens: basis.completion,
      cachedPromptTokens: basis.cached,
    }) as number;
    if (worst === undefined || yuan > worstYuan) {
      worst = basis;
      worstYuan = yuan;
    }
  }
  if (worst === undefined) {
    return {
      code: 'artifact-too-thin',
      message: `no arm in the artifact has ${String(MIN_BASIS_CASES)} priced cases`,
    };
  }
  return worst;
}

/** The basis an artifact supports for one model, or the reason it supports none. */
export function basisOf(artifact: SpendArtifact, model: string): CostBasis | ArtifactRefusal {
  if (PRICES[model] === undefined) {
    return {
      code: 'unpriced',
      message: `${model} has no price row in eval/price.ts, so its arms cannot be compared on money`,
    };
  }
  if (artifact.model !== model) {
    return {
      code: 'artifact-model-mismatch',
      message: `the artifact answers as ${String(artifact.model)}, not ${model}; its token counts would price the wrong endpoint`,
    };
  }
  return armBasis(artifact, model);
}

/**
 * A ledger row recorded from an artifact.
 *
 * Attribution is required rather than optional: a row with no run behind it is a number nobody can
 * re-derive, which is the state `eval/price.ts` was written to end for prices and this file ends
 * for token counts. The date comes from the artifact, not from the clock, so re-recording an old
 * artifact does not make it look fresh.
 */
export function recordRow(artifact: SpendArtifact, model: string): { readonly row: LedgerRow } | ArtifactRefusal {
  const basis = basisOf(artifact, model);
  if (isRefusal(basis)) return basis;
  const run = artifact.provenance?.run;
  const asOf = artifact.generatedAt?.slice(0, 10);
  if (run === undefined || run === '' || asOf === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    return {
      code: 'artifact-unattributed',
      message: `the artifact names no run or no date (run ${String(run)}, generatedAt ${String(artifact.generatedAt)}); a basis nobody can check is not a basis`,
    };
  }
  const served = (artifact.arms ?? []).find((entry) => entry.arm === basis.arm)?.servedModels;
  return {
    row: {
      prompt: basis.prompt,
      completion: basis.completion,
      cached: basis.cached,
      ...(basis.reasoning === undefined || basis.reasoning === 0 ? {} : { reasoning: basis.reasoning }),
      cases: basis.cases,
      arm: basis.arm,
      run,
      asOf,
      served: Object.keys(served ?? {}),
    },
  };
}

/** The ledger on disk, or an empty one when no measurement has been recorded yet. */
export function readLedger(path = LEDGER_PATH): Ledger {
  if (!existsSync(path)) return { rows: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
  return { note: parsed.note, rows: parsed.rows ?? {} };
}

/** Write one row, preserving every other row and the note that explains what the rows are. */
export function writeRow(row: LedgerRow, model: string, path = LEDGER_PATH): Ledger {
  const current = readLedger(path);
  const rows: Record<string, LedgerRow> = {};
  for (const key of [...Object.keys(current.rows), model].sort()) {
    if (key === model) rows[key] = row;
    else if (current.rows[key] !== undefined) rows[key] = current.rows[key];
  }
  const ledger: Ledger = {
    note:
      current.note ??
      'What a case costs on one model, in tokens a case, measured on the run named in each row. ' +
        'Money is derived from eval/price.ts at read time, so a price change re-prices every row. ' +
        'Written by `pnpm bench:spend --record`; see eval/bird/spend.ts for what reads it.',
    rows,
  };
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
  return ledger;
}

const refuse = (code: SpendCode, message: string, projection?: Projection): SpendVerdict => ({
  ok: false,
  code,
  message,
  ...(projection === undefined ? {} : { projection }),
});

/**
 * The decision, in the order the four failures happened.
 *
 * The order is the rule: a retired model is refused before it is priced, an unpriced model is
 * refused before it is projected, and a thinking model is refused before its basis is looked up —
 * because each of those questions is cheaper to answer than the one after it, and the cheapest
 * refusal is the one a reader sees.
 */
export function adjudicateSpend(
  request: SpendRequest,
  options: { readonly ledger?: Ledger; readonly probe?: SpendArtifact } = {},
): SpendVerdict {
  const { model, limit } = request;
  const ledger = options.ledger ?? { rows: {} };

  if (!Number.isInteger(limit) || limit < 1) {
    return refuse('bad-limit', `--limit ${String(limit)} is not a number of questions; pass the size of the run`);
  }

  const retirement = RETIRED[model];
  if (retirement !== undefined) {
    return refuse(
      'retired',
      `${model} is retired: ${retirement} Reinstating it is an edit to RETIRED in eval/bird/spend.ts, not a flag on a command line.`,
    );
  }

  if (PRICES[model] === undefined) {
    return refuse(
      'unpriced',
      `${model} has no price row, so no part of this repository can cost it — \`bench:bill\` would print ` +
        `"no price on file" about a reading that had already been billed. Add the row to eval/price.ts from the ` +
        `provider's page before dispatching it.`,
    );
  }

  const thinking = THINKING[model];
  if (thinking !== undefined) {
    const required = requiredPp(thinking.multiple);
    if (request.acceptThinkingPp === undefined) {
      return refuse(
        'thinking-undocumented',
        `${model} reasons before it answers: ${thinking.note} (run ${thinking.run}). That is ${String(thinking.multiple)}x ` +
          `the price a case, and at the tariff in DEFAULT_SHIPMENT_POLICY it has to buy ${required.toFixed(1)}pp. ` +
          `Declare the gain you expect with --accept-thinking <pp>, or dispatch the mode that does not think.`,
      );
    }
    if (request.acceptThinkingPp < required) {
      return refuse(
        'thinking-too-cheap',
        `${required.toFixed(1)}pp is what ${String(thinking.multiple)}x the price of a case costs at ${String(TOKEN_TARIFF)} ` +
          `points a doubling; --accept-thinking declares ${request.acceptThinkingPp.toFixed(1)}pp.`,
      );
    }
  }

  let basis: CostBasis | undefined;
  if (options.probe !== undefined) {
    const measured = basisOf(options.probe, model);
    if (isRefusal(measured)) return refuse(measured.code, measured.message);
    basis = measured;
  } else {
    const stored = ledger.rows[model];
    if (stored !== undefined && stored.cases >= MIN_BASIS_CASES) basis = { ...stored, source: 'ledger' };
  }

  if (basis === undefined) {
    if (limit > PROBE_LIMIT) {
      return refuse(
        'no-cost-basis',
        `${String(limit)} questions with nothing to project from: no probe and no ledger row for ${model}. ` +
          `Dispatch ${String(PROBE_LIMIT)} questions first and record its artifact ` +
          `(\`pnpm bench:spend --record eval/out/bird-eval.json --model ${model}\`), or pass --probe <artifact> ` +
          `measured on this model.`,
      );
    }
    return {
      ok: true,
      code: 'ok',
      message:
        `${String(limit)} questions on ${model}, at or below the ${String(PROBE_LIMIT)}-question probe limit: ` +
        `nothing is projected because a run this size is the probe.`,
    };
  }

  const perCase = billOf(model, {
    promptTokens: basis.prompt,
    completionTokens: basis.completion,
    cachedPromptTokens: basis.cached,
  }) as number;
  const projection: Projection = {
    perCase,
    total: perCase * limit * SAFETY_MULTIPLE,
    limit,
    safety: SAFETY_MULTIPLE,
    basis,
  };
  const priced =
    `${formatYuan(perCase)} a case × ${String(limit)} ×${String(SAFETY_MULTIPLE)} safety ` +
    `= ${formatYuan(projection.total)}`;

  if (projection.total > BUDGET_YUAN) {
    const onThisPrompt = basis.source === 'probe' || (request.arms ?? []).includes(basis.arm);
    if (!onThisPrompt) {
      return refuse(
        'over-budget-no-probe',
        `${priced}, from a ledger row measured on run ${String(basis.run)} (${String(basis.arm)}), which is not an arm this ` +
          `dispatch runs. Above ${formatYuan(BUDGET_YUAN)} the basis has to be measured on the prompt being paid for: ` +
          `pass --probe <artifact>, or --arms naming the arm the row was measured on.`,
        projection,
      );
    }
    if (request.acceptCostYuan === undefined) {
      return refuse(
        'accept-cost-missing',
        `${priced}. Above ${formatYuan(BUDGET_YUAN)} the ceiling has to be stated: pass --accept-cost ${String(Math.ceil(projection.total))}.`,
        projection,
      );
    }
    if (request.acceptCostYuan < projection.total) {
      return refuse(
        'accept-cost-too-low',
        `--accept-cost ${formatYuan(request.acceptCostYuan)} is below the ${formatYuan(projection.total)} this projects from ` +
          `run ${String(basis.run)} (${String(basis.arm)}).`,
        projection,
      );
    }
  }

  return {
    ok: true,
    code: 'ok',
    message: `${priced}, against a budget of ${formatYuan(BUDGET_YUAN)}.`,
    projection,
  };
}

/** The verdict as lines a log can carry. */
export function spendLines(verdict: SpendVerdict): readonly string[] {
  const lines = [`spend: ${verdict.code}`, `  ${verdict.message}`];
  if (verdict.projection !== undefined) {
    const basis = verdict.projection.basis;
    lines.push(
      `  basis: ${String(basis.source)} arm ${basis.arm}` +
        `${basis.run === undefined ? '' : ` run ${basis.run}`}` +
        ` ${String(basis.prompt)} prompt / ${String(basis.cached)} cached / ${String(basis.completion)} completion tokens a case` +
        ` over ${String(basis.cases)} cases`,
    );
  }
  return lines;
}

function value(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/**
 * The command line.
 *
 * Exported and injectable rather than buried behind the entry guard, because the gate's refusals
 * are the product: a test that can only reach them through a subprocess cannot see the argument
 * parsing that decides which refusal is printed.
 */
export function main(
  argv: readonly string[] = process.argv.slice(2),
  log: (line: string) => void = console.log,
  check: typeof selfTest = selfTest,
): number {
  if (argv.includes('--self-test')) {
    const { problems, assertions } = check();
    for (const problem of problems) log(`FAILED ${problem}`);
    log(
      `spend self-test: ${String(assertions)} assertions${problems.length === 0 ? '' : `, ${String(problems.length)} problems`}`,
    );
    return problems.length === 0 ? 0 : 1;
  }

  const ledgerPath = value(argv, '--ledger') ?? LEDGER_PATH;
  const model = value(argv, '--model');
  if (model === undefined || model === '') {
    log('spend: --model is required; a dispatch with no model runs whatever the workflow defaults to');
    return 2;
  }

  const recordPath = value(argv, '--record');
  if (recordPath !== undefined) {
    const artifact = JSON.parse(readFileSync(recordPath, 'utf8')) as SpendArtifact;
    const recorded = recordRow(artifact, model);
    if (isRefusal(recorded)) {
      log(`spend: ${recorded.code}`);
      log(`  ${recorded.message}`);
      return 1;
    }
    writeRow(recorded.row, model, ledgerPath);
    log(
      `spend: recorded ${model} from run ${recorded.row.run} (${recorded.row.asOf}, arm ${recorded.row.arm}): ` +
        `${String(recorded.row.prompt)} prompt / ${String(recorded.row.cached)} cached / ` +
        `${String(recorded.row.completion)} completion tokens a case over ${String(recorded.row.cases)} cases`,
    );
    return 0;
  }

  const limitText = value(argv, '--limit');
  if (limitText === undefined) {
    log('spend: --limit is required; a default would be a guess about how much money to spend');
    return 2;
  }
  const acceptThinkingText = value(argv, '--accept-thinking');
  const acceptCostText = value(argv, '--accept-cost');
  const probePath = value(argv, '--probe');
  const armsText = value(argv, '--arms');
  const arms =
    armsText === undefined
      ? undefined
      : armsText
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name !== '');

  const verdict = adjudicateSpend(
    {
      model,
      limit: Number(limitText),
      ...(acceptThinkingText === undefined ? {} : { acceptThinkingPp: Number(acceptThinkingText) }),
      ...(acceptCostText === undefined ? {} : { acceptCostYuan: Number(acceptCostText) }),
      ...(arms === undefined || arms.length === 0 ? {} : { arms }),
    },
    {
      ledger: readLedger(ledgerPath),
      ...(probePath === undefined
        ? {}
        : {
            probe: JSON.parse(readFileSync(probePath, 'utf8')) as SpendArtifact,
          }),
    },
  );
  for (const line of spendLines(verdict)) log(line);
  return verdict.ok ? 0 : 1;
}

/**
 * `--self-test`: every refusal reachable, and the allowance too.
 *
 * The four failures this file was written after are the four cases below. A gate that has never
 * printed its allowance is a gate that gets `|| true` on it, so the cheap dispatch that must pass
 * is asserted here next to the expensive one that must not.
 */
export function selfTest(): {
  readonly problems: readonly string[];
  readonly assertions: number;
} {
  const thin: SpendArtifact = {
    model: 'deepseek-chat',
    cases: [{ arm: 'a', tokens: { prompt: 100, completion: 10, cached: 0 } }],
    provenance: { run: '1' },
    generatedAt: '2026-11-22T00:00:00.000Z',
  };
  const fat: SpendArtifact = {
    model: 'deepseek-chat',
    cases: Array.from({ length: MIN_BASIS_CASES }, () => ({
      arm: 'a',
      tokens: { prompt: 10_000, completion: 7_500, cached: 0 },
    })),
    arms: [{ arm: 'a', servedModels: { 'deepseek-flash': MIN_BASIS_CASES } }],
    provenance: { run: '44991167518' },
    generatedAt: '2026-11-22T05:57:05.047Z',
  };
  const empty: Ledger = { rows: {} };

  const checks: readonly (readonly [string, unknown, unknown])[] = [
    [
      'a retired model is refused',
      adjudicateSpend({ model: 'deepseek-v4-pro', limit: 100 }, { ledger: empty }).code,
      'retired',
    ],
    [
      'an unpriced model is refused',
      adjudicateSpend({ model: 'nope', limit: 100 }, { ledger: empty }).code,
      'unpriced',
    ],
    [
      'a thinking model needs a declared gain',
      adjudicateSpend({ model: 'deepseek-flash', limit: 100 }, { ledger: empty }).code,
      'thinking-undocumented',
    ],
    [
      'a declared gain under the tariff is refused',
      adjudicateSpend({ model: 'deepseek-flash', limit: 100, acceptThinkingPp: 1 }, { ledger: empty }).code,
      'thinking-too-cheap',
    ],
    [
      'a probe from another model is refused',
      adjudicateSpend({ model: 'deepseek-chat', limit: 600 }, { probe: { ...fat, model: 'deepseek-flash' } }).code,
      'artifact-model-mismatch',
    ],
    [
      'a thin artifact is refused',
      adjudicateSpend({ model: 'deepseek-chat', limit: 600 }, { probe: thin }).code,
      'artifact-too-thin',
    ],
    [
      'a big run with no basis is refused',
      adjudicateSpend({ model: 'deepseek-chat', limit: 1534 }, { ledger: empty }).code,
      'no-cost-basis',
    ],
    [
      'a small run is the probe',
      adjudicateSpend({ model: 'deepseek-chat', limit: PROBE_LIMIT }, { ledger: empty }).code,
      'ok',
    ],
    [
      'a big run over budget needs a ceiling',
      adjudicateSpend({ model: 'deepseek-chat', limit: 1534 }, { probe: fat }).code,
      'accept-cost-missing',
    ],
    [
      'a stated ceiling that covers it passes',
      adjudicateSpend({ model: 'deepseek-chat', limit: 1534, acceptCostYuan: 1000 }, { probe: fat }).code,
      'ok',
    ],
    ['the recorded row is attributed', 'row' in recordRow(fat, 'deepseek-chat'), true],
    ['the tariff is five points a unit of extra cost', [requiredPp(2), requiredPp(9)], [TOKEN_TARIFF, TOKEN_TARIFF * 8]],
  ];

  const failures = checks
    .filter(([, actual, expected]) => JSON.stringify(actual) !== JSON.stringify(expected))
    .map(([name, actual, expected]) => `${name}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  return { problems: failures, assertions: checks.length };
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
