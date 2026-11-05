import { replyShape } from './format.js';
import type { FormatProfile, ReplyShape } from './format.js';
import type { SelectionRule } from './select.js';

/**
 * What a deployment should do with a model it has never benchmarked.
 *
 * Every number in this repository was measured on one backbone, and a user who swaps it keeps
 * the code and loses the calibration. The instinct is to re-run the benchmark — 1,532
 * questions, four calls each — which is not something a deployment can do, and would not be
 * something it should do if it could: the answer is not "which arm wins on BIRD", it is
 * "which of four bounded configurations is the right one for this model on this workload".
 *
 * So the adaptation is a choice among four fixed strategies, decided in three layers that get
 * more expensive in that order and stop as soon as one of them decides:
 *
 * 1. **Protocol** (`probeProtocol`) reads the first real reply. A refusal with a 400 or a 422
 *    is a statement about the *request* — the usual cause is a temperature field a reasoning
 *    model will not accept — and costs one retry, not a benchmark. An answer is a statement
 *    about the model, and its shape is free evidence.
 * 2. **Format** (`admissible`) disqualifies the strategies whose readers the model cannot
 *    satisfy. A selector needs a parseable choice; a model that never writes one turns
 *    `aimed-3` from four calls into four calls an arm still loses on.
 * 3. **Policy** (`chooseStrategy`, via `createObserver`) compares outcomes as they arrive and
 *    switches only when the intervals separate. Wilson intervals, the same instrument the
 *    published numbers use, so the runtime decision and the report cannot disagree about what
 *    "better" means.
 *
 * The product of all this is a `Strategy` — a value that can be diffed, pinned, rolled back
 * and put in a baseline. Nothing here rewrites a prompt: the measured 7.1% of this prompt that
 * a compiler could touch is already `renderSchemaCard`, and an optimizer that edits it would
 * make every number in `docs/benchmarks.md` unattributable.
 */

/**
 * The five configurations a deployment may run, named for what they spend.
 *
 * The design document calls these `lean` / `full` / `consensus` / `select`; they are named
 * here by the call shape instead, because "consensus" and "select" are both what the *model*
 * is asked to do and neither says how many calls it costs — and the number of calls is the
 * only part of this a user pays for. `aimed-3` and `aimed-4` are the same candidate set with
 * the two selectors, which is why they are the one pair whose names differ by their price.
 */
export type StrategyName = 'single-lean' | 'single-full' | 'repeat-3' | 'aimed-3' | 'aimed-4';

/** A bounded configuration. Every field is a value a caller can print, diff and pin. */
export interface Strategy {
  readonly name: StrategyName;
  /** Calls per question, which is also the price in units a user recognises. */
  readonly calls: number;
  /** Which card the prompt carries: the lean one, or the full one with curated notes. */
  readonly card: 'lean' | 'full';
  /** Candidate statements the strategy produces before it commits to one. */
  readonly candidates: 1 | 3;
  /**
   * Who chooses among the candidates, and what that costs.
   *
   * `'none'` is a strategy with one candidate, where a chooser would have nothing to choose.
   * The three rule names are `chooseCandidateByRule`'s, and they spend no call: on 1,532 dev
   * questions `shortest` scored 63.64% against the model selector's 62.79% on the same
   * candidates, and on the strong pool 63.71% against 61.42% (+2.29pp, p = 0.0030) — the only
   * difference between the two readings was the fourth call, and it lost. `'model'` is kept
   * as a strategy rather than deleted, because the reading that retired it as the default is
   * one split and one backbone and a pin that can be re-run is what keeps it falsifiable.
   *
   * The field is one name rather than a boolean plus a rule, because the two would allow the
   * state "a selector that is also a rule", which no executor can honour.
   */
  readonly selector: 'none' | SelectionRule | 'model';
  /**
   * Sampling temperature, or `null` for an endpoint that refuses the field.
   *
   * Zero everywhere the strategy has one candidate, because a second sample of a prompt that
   * is deterministic by design is a second bill for the same answer. Non-zero where the point
   * *is* the disagreement.
   */
  readonly temperature: number | null;
}

export const STRATEGIES: readonly Strategy[] = [
  { name: 'single-lean', calls: 1, card: 'lean', candidates: 1, selector: 'none', temperature: 0 },
  { name: 'single-full', calls: 1, card: 'full', candidates: 1, selector: 'none', temperature: 0 },
  { name: 'repeat-3', calls: 3, card: 'full', candidates: 3, selector: 'none', temperature: 0.7 },
  // The default the evidence points at: three candidates, and the free rule choosing among
  // them. It is the same candidate set `aimed-4` draws, one call cheaper, and the reading that
  // moved it here (`I-96`) is a paired one on that very set.
  { name: 'aimed-3', calls: 3, card: 'full', candidates: 3, selector: 'shortest', temperature: 0.7 },
  // What `aimed-3` used to be, kept as the ablation: the fourth call reads the candidates and
  // answers with an index. It is the strategy every published selector reading was taken with,
  // so deleting it would delete the comparison.
  { name: 'aimed-4', calls: 4, card: 'full', candidates: 3, selector: 'model', temperature: 0.7 },
];

const BY_NAME: Readonly<Record<StrategyName, Strategy>> = {
  'single-lean': STRATEGIES[0]!,
  'single-full': STRATEGIES[1]!,
  'repeat-3': STRATEGIES[2]!,
  'aimed-3': STRATEGIES[3]!,
  'aimed-4': STRATEGIES[4]!,
};

/** Look one up. Total over the union, so there is no branch to leave uncovered. */
export function strategy(name: StrategyName): Strategy {
  return BY_NAME[name];
}

/** A refusal, with the status the endpoint gave. The status is what makes it actionable. */
export interface Refusal {
  readonly kind: 'refused';
  readonly status: number;
}

/** A reply. Its text is read for shape, which costs nothing. */
export interface Answer {
  readonly kind: 'answered';
  readonly text: string;
}

export type FirstContact = Answer | Refusal;

/**
 * What the first contact licenses.
 *
 * `proceed` means the request shape is accepted and the next call should be the real one.
 * `retry-without-temperature` means the request was rejected in a way that a request without
 * the temperature field usually fixes — the one repair that is worth a call, because a
 * reasoning endpoint that only accepts its own default answers every call with a 400.
 * `stop` means the fault is not in the shape: a wrong model name or a wrong key fails the same
 * way on every retry, and retrying it is how a misconfiguration becomes a timeout.
 */
export type ProtocolStep = 'proceed' | 'retry-without-temperature' | 'stop';

export interface ProtocolVerdict {
  readonly step: ProtocolStep;
  readonly omitTemperature: boolean;
  /** Present only for an answer: the first reply's shape, which no other layer can get free. */
  readonly shape?: ReplyShape;
  readonly why: string;
}

/**
 * Layer ①: read the first contact, decide whether to retry, and keep the free evidence.
 *
 * The status codes are the whole rule. 400 and 422 are the two ways an endpoint says "I do not
 * accept this field"; 401, 403, 404 and 5xx are four ways of saying the deployment is misnamed,
 * mis-keyed, or down, and neither a retry nor a different strategy changes any of them.
 */
export function probeProtocol(contact: FirstContact): ProtocolVerdict {
  if (contact.kind === 'answered') {
    return {
      step: 'proceed',
      omitTemperature: false,
      shape: replyShape(contact.text),
      why: 'the endpoint answered, and the reply carries the only evidence that costs no call',
    };
  }
  if (contact.status === 400 || contact.status === 422) {
    return {
      step: 'retry-without-temperature',
      omitTemperature: true,
      why: `the endpoint rejected the request with ${String(contact.status)}; retry once with no temperature field`,
    };
  }
  return {
    step: 'stop',
    omitTemperature: false,
    why: `the endpoint answered ${String(contact.status)}; neither a retry nor another strategy changes that`,
  };
}

/**
 * Layer ②: the strategies a format profile leaves standing.
 *
 * Only one dimension gates anything, and it gates only the paid selector: `aimed-4` spends a
 * fourth call asking the model to name a candidate, and a model whose replies never parse as a
 * choice answers that call with prose the selector still has to fall back from. The other
 * dimensions are warnings rather than gates — `extractSql` reads an unfenced reply as the whole
 * text, so a model that never fences is riskier, not disqualified, and a strategy that cannot be
 * run at all would be a worse verdict than the one the data supports.
 *
 * `aimed-3` is not gated, and that is the point of it: the rule reads the executed candidates,
 * not the model's prose, so there is no format it can fail. A layer that dropped it for a
 * reason belonging to a call it does not make would be a gate about the wrong strategy.
 */
export function admissible(profile: FormatProfile): StrategyName[] {
  const names: StrategyName[] = ['single-lean', 'single-full', 'repeat-3', 'aimed-3'];
  if (profile.index !== 'never') names.push('aimed-4');
  return names;
}

/** A pass count over a number of tries. */
export interface Tally {
  readonly passed: number;
  readonly total: number;
}

export interface Interval {
  readonly low: number;
  readonly high: number;
}

/**
 * The Wilson score interval, which is the interval this repository reports everywhere else.
 *
 * It is used here for the same reason it is used there: at three or five observations the
 * normal approximation puts a bound below zero or above one, and a bound outside [0, 1] cannot
 * be compared with another bound without inventing a rule for the overlap.
 */
export function wilson(passed: number, total: number, z = 1.96): Interval {
  if (total <= 0) return { low: 0, high: 1 };
  const p = passed / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return {
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator),
  };
}

export interface DecisionOptions {
  /** The strategy in force now. Absent means the best lower bound so far leads. */
  readonly incumbent?: StrategyName;
  /** Observations required before any decision is taken. */
  readonly minTotal?: number;
  readonly z?: number;
}

export interface Decision {
  /** Whether enough evidence exists to name a strategy at all. */
  readonly decided: boolean;
  readonly strategy: StrategyName;
  readonly reason: string;
}

/** Observations required before layer ③ will name a strategy. */
export const MIN_OBSERVATIONS = 8;

/** The default the caller holds when it has no evidence: one call, the full card. */
export const DEFAULT_STRATEGY: StrategyName = 'single-full';

/**
 * Layer ③: which strategy the evidence separates, or the incumbent if it separates nothing.
 *
 * The rule is interval separation, not a threshold on the difference: two arms measured on
 * eight questions differ by tens of points as a matter of arithmetic, and a fixed margin like
 * "switch above 5pp" would fire on that noise. It also refuses to decide at all below
 * `MIN_OBSERVATIONS`, because the honest report on seven observations is "seven observations".
 *
 * The incumbent wins ties and overlaps. Switching costs the work already done under the old
 * strategy, so the burden of proof is on the challenger, which is also what keeps a deployment
 * from oscillating between two arms whose intervals overlap.
 */
export function chooseStrategy(
  counts: Partial<Record<StrategyName, Tally>>,
  options: DecisionOptions = {},
): Decision {
  const minTotal = options.minTotal ?? MIN_OBSERVATIONS;
  const z = options.z ?? 1.96;
  const incumbent = options.incumbent ?? DEFAULT_STRATEGY;
  const measured = (Object.entries(counts) as [StrategyName, Tally][])
    .filter(([, tally]) => tally.total > 0)
    .map(([name, tally]) => ({ name, tally, interval: wilson(tally.passed, tally.total, z) }));

  const total = measured.reduce((sum, arm) => sum + arm.tally.total, 0);
  if (total < minTotal || measured.length === 0) {
    return {
      decided: false,
      strategy: incumbent,
      reason: `${String(total)} of ${String(minTotal)} observations; the incumbent stays in force until there is evidence`,
    };
  }

  const leading = measured.reduce((best, arm) => (arm.interval.low > best.interval.low ? arm : best));
  const current = measured.find((arm) => arm.name === incumbent);
  if (current === undefined) {
    return {
      decided: true,
      strategy: leading.name,
      reason: `${leading.name} is the only measured arm (${String(leading.tally.passed)}/${String(leading.tally.total)})`,
    };
  }
  if (leading.name === incumbent) {
    return {
      decided: true,
      strategy: incumbent,
      reason: `${incumbent} leads on its own evidence (${String(leading.tally.passed)}/${String(leading.tally.total)})`,
    };
  }
  if (leading.interval.low <= current.interval.high) {
    return {
      decided: true,
      strategy: incumbent,
      reason: `${incumbent} holds: its interval [${format(current.interval.low)}, ${format(current.interval.high)}] overlaps ${leading.name}'s lower bound ${format(leading.interval.low)}`,
    };
  }
  return {
    decided: true,
    strategy: leading.name,
    reason: `${leading.name} separates: its lower bound ${format(leading.interval.low)} clears ${incumbent}'s upper bound ${format(current.interval.high)}`,
  };
}

function format(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export interface ObserverOptions extends DecisionOptions {
  /**
   * Re-decide after the first decision.
   *
   * Off by default. A deployment that re-decides on every query is a deployment that can
   * oscillate between two arms whose intervals touch, and the cost of the work it abandons is
   * paid by the user rather than by the report. `health` re-runs the decision explicitly.
   */
  readonly reevaluate?: boolean;
}

export interface Observer {
  /** Record one outcome under the strategy that produced it. */
  record(name: StrategyName, passed: boolean): void;
  /** What the evidence says now. Cheap, pure, and safe to call after every record. */
  snapshot(): Decision;
  counts(): Partial<Record<StrategyName, Tally>>;
}

/**
 * The online half of layer ③: accumulate real outcomes and answer with a strategy.
 *
 * It exists so that adaptation needs no dataset, no label and no extra call — the observations
 * are the queries the deployment was going to run anyway, and the eighth one is when the
 * intervals first mean anything at all.
 */
export function createObserver(options: ObserverOptions = {}): Observer {
  const counts: Partial<Record<StrategyName, Tally>> = {};
  let locked: Decision | undefined;

  return {
    record(name, passed) {
      const tally = counts[name] ?? { passed: 0, total: 0 };
      counts[name] = { passed: tally.passed + (passed ? 1 : 0), total: tally.total + 1 };
    },
    counts() {
      return { ...counts };
    },
    snapshot() {
      if (locked !== undefined && options.reevaluate !== true) return locked;
      const decision = chooseStrategy(counts, {
        ...(options.incumbent === undefined ? {} : { incumbent: options.incumbent }),
        ...(options.minTotal === undefined ? {} : { minTotal: options.minTotal }),
        ...(options.z === undefined ? {} : { z: options.z }),
      });
      if (decision.decided) locked = decision;
      return decision;
    },
  };
}
