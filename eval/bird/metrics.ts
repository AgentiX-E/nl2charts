/**
 * What a repair actually bought, per case.
 *
 * Accuracy alone cannot price a repair loop: an arm that fixes 30 cases and breaks 25
 * has the same accuracy as one that does nothing, and the two are not the same system.
 * These numbers come from the per-case attempt count and the class of each rejection,
 * which the pipeline now reports.
 */
export interface RepairCase {
  /** How many model calls the case took; 1 means the first statement was accepted. */
  readonly attempts: number;
  readonly passed: boolean;
  /** Classes of the rejected attempts, in order. Empty when nothing was rejected. */
  readonly failures?: readonly string[];
  /** How the case ended when it did not end with an answer: `execution`, `guard`, `llm`. */
  readonly errorKind?: string;
}

export interface ClassFunnel {
  readonly failureClass: string;
  /** Cases whose first rejection was this class. */
  readonly cases: number;
  /** Of those, how many ended as a correct answer. */
  readonly fixed: number;
  /** Of those, how many exhausted the budget or ended wrong. */
  readonly remaining: number;
}

export interface RepairFunnel {
  readonly total: number;
  /** Correct on the first statement, with no repair involved. */
  readonly firstPass: number;
  /**
   * Ran once, executed, and answered wrong.
   *
   * These are the cases a repair loop cannot reach: the statement was accepted, so
   * there is no error to feed back. On BIRD with a strong model they are most of the
   * failures, which is what bounds the loop's ceiling.
   */
  readonly ranOnceWrong: number;
  /** Cases that needed at least one repair. */
  readonly repaired: number;
  /** Repaired cases that ended correct. */
  readonly fixedByRepair: number;
  /** Repaired cases that ended wrong or exhausted the budget. */
  readonly stillFailing: number;
  readonly accuracy: number;
  readonly firstPassRate: number;
  /** Share of cases the loop could possibly have fixed, i.e. its ceiling. */
  readonly repairableShare: number;
  /**
   * Repaired cases that still had no executable statement at the end.
   *
   * The difference from `stillFailing` is the mechanism's actual product: on BIRD,
   * eight of nine repaired cases ended as *executable but wrong*. A repair that turns a
   * syntax error into a runnable wrong answer has done what it can — it is the question
   * that was misread, and no error message says so.
   */
  readonly stillNotExecuting: number;
  /** `fixedByRepair / repaired`; 0 when no case needed a repair. */
  readonly repairSuccessRate: number;
  readonly meanAttempts: number;
  /** Mean model calls beyond the first, i.e. what the loop cost. */
  readonly extraCallsPerCase: number;
  readonly byClass: readonly ClassFunnel[];
}

function share(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

export function repairFunnel(cases: readonly RepairCase[]): RepairFunnel {
  const total = cases.length;
  let firstPass = 0;
  let ranOnceWrong = 0;
  let repaired = 0;
  let fixedByRepair = 0;
  let stillNotExecuting = 0;
  let attempts = 0;
  const byClass = new Map<string, { cases: number; fixed: number }>();
  for (const entry of cases) {
    attempts += entry.attempts;
    if (entry.attempts <= 1) {
      if (entry.passed) firstPass += 1;
      else ranOnceWrong += 1;
      continue;
    }
    repaired += 1;
    if (entry.passed) fixedByRepair += 1;
    if (entry.errorKind === 'execution' || entry.errorKind === 'guard') stillNotExecuting += 1;
    // The first rejection names the problem the repair had to overcome; later ones are
    // what happened on the way. Counting every class would double-count a case that
    // failed for two reasons and make the funnel sum past its own total.
    const first = entry.failures?.[0];
    if (first === undefined) continue;
    const bucket = byClass.get(first) ?? { cases: 0, fixed: 0 };
    bucket.cases += 1;
    if (entry.passed) bucket.fixed += 1;
    byClass.set(first, bucket);
  }
  const stillFailing = repaired - fixedByRepair;
  return {
    total,
    firstPass,
    ranOnceWrong,
    repaired,
    fixedByRepair,
    stillNotExecuting,
    stillFailing,
    accuracy: share(cases.filter((entry) => entry.passed).length, total),
    firstPassRate: share(firstPass, total),
    repairableShare: share(repaired, total),
    repairSuccessRate: share(fixedByRepair, repaired),
    meanAttempts: share(attempts, total),
    extraCallsPerCase: Math.max(0, share(attempts, total) - 1),
    byClass: [...byClass.entries()]
      .map(([failureClass, bucket]) => ({
        failureClass,
        cases: bucket.cases,
        fixed: bucket.fixed,
        remaining: bucket.cases - bucket.fixed,
      }))
      .sort((left, right) => right.cases - left.cases || left.failureClass.localeCompare(right.failureClass)),
  };
}

/**
 * Accuracy gained per extra model call.
 *
 * The unit matters: a mechanism that costs one call per case for +2pp is a different
 * proposition from one that costs a tenth of a call for +2pp, and a table of deltas
 * cannot say which one you are looking at.
 */
export function ppPerExtraCall(deltaPp: number, extraCallsPerCase: number): number | undefined {
  if (extraCallsPerCase <= 0) return undefined;
  return deltaPp / extraCallsPerCase;
}
