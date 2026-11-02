/**
 * Whether the model that does the choosing is worth the call it costs.
 *
 * `select` and `select-cross` pay one call per question to a model that reads the candidates
 * and names one. The alternative is free and older than any of this: return the modal result,
 * which is what a voting arm does. The two were compared as arms (`select` vs `vote`,
 * `select-cross` vs `vote-cross`) and the deltas were inside the noise of two pools that were
 * drawn separately.
 *
 * The archived readings answer the question a third way, and cheaply. A case's candidate
 * records carry `fingerprint`, the hash of the result the statement returned, and `correct`.
 * Grouping by fingerprint splits a case into the *opinions* it contains: one group means every
 * candidate agreed, and there the choice does not matter — selector and count return the same
 * rows, and any delta between them is measurement error. Two or more groups is the only
 * situation in which the choice is a decision at all, and it is exactly the situation the
 * selector exists for.
 *
 * Read that way, on two independent 600-question runs of `select-cross`, the selector lost the
 * only cases it could have won: 292 disputed cases, 22 where the selector was right and the
 * modal group wrong, 53 the other way round (exact McNemar p = 4.5e-4). The count won by
 * 31 cases, which is 2.58pp of 1,200 questions, and the direction held on `select-cross-judge-reasoning`
 * and `select-cross-unhinted` in the same runs.
 *
 * A reading that disagrees with three other readings is worth one confirmation and not a
 * rewrite, so this tool does not change any arm. It makes the reading repeatable: the same
 * numbers come out of any archived artifact in a second, and the arm that would settle it
 * (`select-cross-pooled-vote`, the modal result on a pool neither arm drew) is dispatched
 * beside it. Nothing here calls a model.
 *
 * Two details of the comparison are deliberate:
 *
 * 1. **The tie-break is part of the instrument.** A modal group is only unique when one group
 *    is strictly larger; 16 of the disputed cases in each run were 1:1:1. The winner is the
 *    earliest group, which is what `majorityResult` does with candidates in generation order,
 *    and the count of those cases is reported rather than folded into the total — a tie-break
 *    that happened to favour one author would look like a mechanism.
 * 2. **A case with no candidate is not a case the count can judge.** Zero candidates is a
 *    prompt that produced nothing, not an opinion, and it is counted apart instead of being
 *    scored as "the modal group was wrong".
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { mcnemarExact } from '@agentix-e/nl2charts-devkit';

/** The part of a candidate record this reading needs. Every other field is not evidence here. */
export interface DecidedCandidate {
  readonly fingerprint: string;
  readonly correct: boolean;
}

/** The part of a case record this reading needs. */
export interface DecidedCase {
  readonly id: string;
  readonly arm: string;
  readonly passed: boolean;
  readonly candidates?: readonly DecidedCandidate[];
}

/** One distinct result within a case, and who returned it. */
export interface ResultGroup {
  readonly fingerprint: string;
  readonly members: number;
  readonly correct: boolean;
  /** 1-based position of the earliest candidate in this group, i.e. the slot a reader sees. */
  readonly first: number;
}

/**
 * The opinions a candidate set contains, in the order they were drawn.
 *
 * Insertion order is preserved because the tie-break reads it: `majorityResult` keeps the
 * earliest group when two are the same size, and a grouping that reordered them would score a
 * different decision from the one the arm made.
 */
export function resultGroups(candidates: readonly DecidedCandidate[]): readonly ResultGroup[] {
  const groups = new Map<string, { members: number; correct: boolean; first: number }>();
  candidates.forEach((candidate, index) => {
    const seen = groups.get(candidate.fingerprint);
    if (seen === undefined) {
      groups.set(candidate.fingerprint, { members: 1, correct: candidate.correct, first: index + 1 });
      return;
    }
    seen.members += 1;
    seen.correct = seen.correct || candidate.correct;
  });
  return [...groups].map(([fingerprint, group]) => ({ fingerprint, ...group }));
}

/**
 * The group a voting arm would return: the largest, and the earliest when two are equal.
 *
 * `undefined` for an empty candidate set, which is a case no count can decide.
 */
export function modalGroup(groups: readonly ResultGroup[]): ResultGroup | undefined {
  let best: ResultGroup | undefined;
  for (const group of groups) if (best === undefined || group.members > best.members) best = group;
  return best;
}

export interface DecisionLedger {
  readonly arm: string;
  readonly cases: number;
  /** Cases with no candidate at all: a prompt that produced nothing, not an opinion. */
  readonly unreadable: number;
  /** Cases whose candidates all returned the same rows: the choice cannot change the answer. */
  readonly unanimous: number;
  /** Cases with two or more distinct results: the only ones where a selector decides anything. */
  readonly disputed: number;
  /** Disputed cases in which some candidate matched gold, i.e. the ones a selector could win. */
  readonly reachable: number;
  /** Disputed cases whose two largest groups are the same size, where the tie-break decided. */
  readonly ties: number;
  /** Both the selector and the modal group were right. */
  readonly both: number;
  /** Only the selector was right: what the call bought. */
  readonly selectorOnly: number;
  /** Only the modal group was right: what the call cost. */
  readonly modalOnly: number;
  readonly neither: number;
  /** Exact McNemar on the two discordant counts. */
  readonly p: number;
  /** `modalOnly - selectorOnly`, in cases: what a free decision would have added. */
  readonly net: number;
  /** `net` over every case in the arm, which is the number a score moves by. */
  readonly netShare: number;
}

export function decisionLedger(cases: readonly DecidedCase[], arm = cases[0]?.arm ?? ''): DecisionLedger {
  let unreadable = 0;
  let unanimous = 0;
  let disputed = 0;
  let reachable = 0;
  let ties = 0;
  let both = 0;
  let selectorOnly = 0;
  let modalOnly = 0;
  let neither = 0;
  for (const entry of cases) {
    const groups = resultGroups(entry.candidates ?? []);
    const modal = modalGroup(groups);
    if (modal === undefined) {
      unreadable += 1;
      continue;
    }
    if (groups.length === 1) {
      // Both decisions return the same rows here, so there is nothing to attribute: the case
      // is counted as agreement whether or not it passed, and its verdict belongs to generation.
      unanimous += 1;
      continue;
    }
    disputed += 1;
    if (groups.some((group) => group.correct)) reachable += 1;
    const largest = Math.max(...groups.map((group) => group.members));
    if (groups.filter((group) => group.members === largest).length > 1) ties += 1;
    if (entry.passed && modal.correct) both += 1;
    else if (entry.passed) selectorOnly += 1;
    else if (modal.correct) modalOnly += 1;
    else neither += 1;
  }
  const total = cases.length;
  const net = modalOnly - selectorOnly;
  return {
    arm,
    cases: total,
    unreadable,
    unanimous,
    disputed,
    reachable,
    ties,
    both,
    selectorOnly,
    modalOnly,
    neither,
    p: mcnemarExact(selectorOnly, modalOnly),
    net,
    netShare: total === 0 ? 0 : net / total,
  };
}

/**
 * The ledger for every arm in a report, in the order the report lists them.
 *
 * The arm name is taken from the case records rather than from the arm rows: a report whose
 * arms and cases disagree about who ran is a report with a bug, and this reader should not
 * paper over it by trusting the summary.
 */
export function decisionLedgers(report: { readonly cases?: readonly DecidedCase[] }): readonly DecisionLedger[] {
  const byArm = new Map<string, DecidedCase[]>();
  for (const entry of report.cases ?? []) {
    const bucket = byArm.get(entry.arm);
    if (bucket === undefined) byArm.set(entry.arm, [entry]);
    else bucket.push(entry);
  }
  return [...byArm].map(([arm, cases]) => decisionLedger(cases, arm));
}

const percent = (value: number): string => `${(value * 100).toFixed(2)}pp`;

export function decisionLines(ledger: DecisionLedger): readonly string[] {
  const p = ledger.p < 1e-4 ? ledger.p.toExponential(1) : ledger.p.toFixed(4);
  return [
    `${ledger.arm}`,
    `  cases                              ${String(ledger.cases)}`,
    `  no candidate (unreadable)          ${String(ledger.unreadable)}`,
    `  one distinct result (the choice is free) ${String(ledger.unanimous)}`,
    `  two or more (the choice decides)    ${String(ledger.disputed)}`,
    `    ...with a correct candidate       ${String(ledger.reachable)}`,
    `    ...decided by the tie-break       ${String(ledger.ties)}`,
    `    selector and count both right     ${String(ledger.both)}`,
    `    only the selector right           ${String(ledger.selectorOnly)}`,
    `    only the count right              ${String(ledger.modalOnly)}`,
    `    neither right                     ${String(ledger.neither)}`,
    `  exact McNemar p                    ${p}`,
    `  count minus selector               ${String(ledger.net)} cases (${percent(ledger.netShare)})`,
  ];
}

export interface DecisionSettings {
  readonly reportPath: string;
  readonly arm: string | undefined;
}

export function resolveDecisionSettings(argv: readonly string[]): DecisionSettings {
  const flag = argv.indexOf('--arm');
  const named = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && named === undefined) throw new Error('--arm needs a name');
  const consumed = flag === -1 ? [] : [flag, flag + 1];
  const path = argv.find((item, index) => !item.startsWith('--') && !consumed.includes(index));
  if (path === undefined) throw new Error('usage: decision.ts <report.json> [--arm <name>]');
  return { reportPath: path, arm: named };
}

export function readDecisionReport(path: string): { readonly cases?: readonly DecidedCase[] } {
  return JSON.parse(readFileSync(path, 'utf8')) as { cases?: readonly DecidedCase[] };
}

export function main(argv: readonly string[] = process.argv.slice(2), log: (line: string) => void = console.log): number {
  const settings = resolveDecisionSettings(argv);
  const report = readDecisionReport(settings.reportPath);
  const all = decisionLedgers(report);
  const chosen = settings.arm === undefined ? all : all.filter((ledger) => ledger.arm === settings.arm);
  if (chosen.length === 0) {
    console.error(`no arm named ${String(settings.arm)} in ${settings.reportPath}`);
    return 1;
  }
  for (const ledger of chosen) {
    for (const line of decisionLines(ledger)) log(line);
    log('');
  }
  return 0;
}

/**
 * Run only when this file is the program, with the failure mode the other tools have.
 *
 * The entry point is a function rather than an `if` at the bottom of the module so that both
 * of its branches can be exercised: the suite calls it with a path that is not this file (it
 * must do nothing), with this file's own URL (it must run), and with a `run` that throws (it
 * must report the message instead of a stack trace). An `if` that reads `process.argv` can be
 * covered only by being the process, which is why three sibling tools carried an unreachable
 * line each.
 */
export function dispatch(
  entry: string | undefined,
  self: string,
  argv: readonly string[],
  log: (line: string) => void = console.log,
  error: (line: string) => void = console.error,
  run: (argv: readonly string[], log: (line: string) => void) => number = main,
): number | undefined {
  if (entry === undefined || pathToFileURL(entry).href !== self) return undefined;
  try {
    return run(argv, log);
  } catch (thrown) {
    error(thrown instanceof Error ? thrown.message : String(thrown));
    return 1;
  }
}

const exit = dispatch(process.argv[1], import.meta.url, process.argv.slice(2));
if (exit !== undefined) process.exitCode = exit;
