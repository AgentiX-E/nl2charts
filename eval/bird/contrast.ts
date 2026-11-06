/**
 * Two artifacts, two bases, and the two readings a rate cannot choose between.
 *
 * `pair.ts` refuses to join two artifacts, and it is right to: a join across runs puts the
 * endpoint's own displacement into a delta that was supposed to have none. `S1` is the case that
 * refusal cannot serve — comparing two *base models* means two dispatches, because `LLM_MODEL` is
 * a property of the run. So the refusal becomes a condition instead of a ban: two artifacts may be
 * contrasted when everything that could move a case is equal, and the instrument names what it
 * found equal. What is not equal is refused, with the two values that disagree.
 *
 * The second reading is the one this file exists for. `S1-b` lost 94 of 1,532 cases to a model
 * timeout and the other arm lost 1, so:
 *
 * - **Intent-to-treat** scores the forfeits as wrong answers, which is what the arm's own
 *   denominator does. It answers "what would this configuration score if I dispatched it".
 * - **Complete case** scores only the questions both bases answered. It answers "what does this
 *   base do when it does answer" — and it is biased, because the 94 deleted cases are the ones
 *   whose generation ran long, which correlates with the treatment (a 2.9x longer output) and not
 *   with the question.
 *
 * Neither is the verdict, so this instrument refuses to nominate one. It prints both, prints how
 * many discordant cases have an unanswered side — the number that says how much of the delta is
 * infrastructure — and states which reading the attrition makes unsafe. Deciding is the reader's
 * job; hiding one of them would be the instrument's.
 *
 *   tsx eval/bird/contrast.ts --left a.json --right b.json [--json]
 *
 * Zero model calls, zero database work: it reads two files.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mcnemarExact } from '@agentix-e/nl2charts-devkit';

/** One case as an artifact files it. Only the fields a contrast needs. */
export interface ContrastCase {
  readonly id: string | number;
  readonly passed?: boolean;
  readonly reason?: string;
  readonly error?: string;
  readonly errorKind?: string;
}

/** The part of a run artifact this instrument reads. */
export interface ContrastArtifact {
  readonly split?: string;
  readonly model?: string;
  readonly judgeModel?: string;
  readonly armsRequested?: readonly string[];
  readonly promptChars?: { readonly mean?: number };
  readonly settings?: { readonly split?: string; readonly timeoutMs?: number };
  /**
   * The instrument's own settings, as the runner writes them.
   *
   * `timeoutMs` is here because it is the one setting `S1` proved is not plumbing: the same
   * prompt, judge and arms at 120 s and at 300 s are two experiments whose difference is partly
   * the setting. A contrast that ignored it would accept the pair this round dispatched to
   * separate exactly that.
   */
  readonly run?: { readonly timeoutMs?: number; readonly concurrency?: number; readonly retries?: number };
  readonly cases?: readonly ContrastCase[];
}

/** What one side of a contrast did, in the terms the two readings need. */
export interface ContrastSide {
  readonly label: string;
  readonly model: string;
  /** Cases the judge saw: a pass, or a failure with a verdict. */
  readonly judged: number;
  /** Cases with no verdict at all — a timeout, a refusal, an engine error before judging. */
  readonly unanswered: number;
  /**
   * Those cases by the kind the artifact recorded.
   *
   * Split because the kinds answer different questions: a model timeout is the base being slow,
   * a guard refusal is the base writing something unusable, an execution error is the engine
   * rejecting a statement that was written. `S1`'s attrition is 94 timeouts and 15 of the other
   * two, and only the count by kind can say which of those two stories a dispatch produced.
   */
  readonly unansweredByKind: Readonly<Record<string, number>>;
  readonly passed: number;
}

/** A paired reading over one choice of denominator. */
export interface ContrastReading {
  readonly n: number;
  readonly both: number;
  readonly onlyLeft: number;
  readonly onlyRight: number;
  readonly neither: number;
  /** `onlyRight - onlyLeft` in percentage points of `n`. */
  readonly deltaPp: number;
  readonly p: number;
  readonly interval: readonly [number, number];
}

export interface ContrastOutcome {
  readonly left: ContrastSide;
  readonly right: ContrastSide;
  /** Every question both artifacts scored, whatever each side did with it. */
  readonly intentToTreat: ContrastReading;
  readonly completeCase: ContrastReading;
  /** Discordant intent-to-treat cases where one side produced no answer at all. */
  readonly forfeitsLeft: number;
  readonly forfeitsRight: number;
  /**
   * The per-call ceiling both sides ran under, when both recorded one.
   *
   * Absent when either artifact predates the field. Reported rather than assumed equal: the
   * comparison is only "same experiment, different base" because this number matched.
   */
  readonly deadlineMs?: number;
  readonly problems: readonly string[];
}

/** Wald interval on a paired difference, in percentage points. */
export function pairedInterval(onlyLeft: number, onlyRight: number, n: number): readonly [number, number] {
  if (n === 0) return [0, 0];
  const first = onlyRight / n;
  const second = onlyLeft / n;
  const variance = Math.max(0, first + second - (first - second) ** 2);
  const half = 1.96 * Math.sqrt(variance / n) * 100;
  const delta = (first - second) * 100;
  return [delta - half, delta + half];
}

function readingOf(ids: readonly string[], left: Map<string, boolean>, right: Map<string, boolean>): ContrastReading {
  let both = 0;
  let onlyLeft = 0;
  let onlyRight = 0;
  let neither = 0;
  for (const id of ids) {
    const a = left.get(id) === true;
    const b = right.get(id) === true;
    if (a && b) both += 1;
    else if (a) onlyLeft += 1;
    else if (b) onlyRight += 1;
    else neither += 1;
  }
  const n = ids.length;
  const [low, high] = pairedInterval(onlyLeft, onlyRight, n);
  return {
    n,
    both,
    onlyLeft,
    onlyRight,
    neither,
    deltaPp: n === 0 ? 0 : Number((((onlyRight - onlyLeft) / n) * 100).toFixed(2)),
    p: mcnemarExact(onlyLeft, onlyRight),
    interval: [Number(low.toFixed(2)), Number(high.toFixed(2))],
  };
}

/**
 * A case is judged when the artifact records no error for it.
 *
 * Not "has a reason": every artifact written before the `reason` fix records `'values'` on the
 * five no-answer branches, so reading the verdict as the evidence would find no attrition in
 * exactly the artifact this instrument was built to read. `error` is the field that has always
 * been written by a case that produced nothing, and the two artifacts of the `S1` run differ on
 * it by 94 cases — which is the whole subject of the second reading.
 */
function judgedOf(entry: ContrastCase): boolean {
  return entry.error === undefined;
}

function sideOf(label: string, artifact: ContrastArtifact): ContrastSide {
  const cases = artifact.cases ?? [];
  const silent = cases.filter((entry) => !judgedOf(entry));
  const byKind: Record<string, number> = {};
  for (const entry of silent) {
    const kind = typeof entry.errorKind === 'string' && entry.errorKind !== '' ? entry.errorKind : 'unspecified';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  return {
    label,
    model: artifact.model ?? 'unnamed',
    judged: cases.length - silent.length,
    unanswered: silent.length,
    unansweredByKind: byKind,
    passed: cases.filter((entry) => entry.passed === true).length,
  };
}

/**
 * What must be equal for two artifacts to be one contrast.
 *
 * Each check names both values, because the reader's next act is to decide which one to fix. The
 * prompt is compared by its mean size rather than by its text: the artifacts that reach this
 * instrument keep the size, not the prompt, and two blocks that differ in size are the cheapest
 * detectable difference between two prompts that are not the same prompt.
 */
export function comparabilityProblems(left: ContrastArtifact, right: ContrastArtifact): string[] {
  const problems: string[] = [];
  const differ = (field: string, a: unknown, b: unknown): void => {
    if (a === undefined || b === undefined) return;
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${field}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  };
  differ('split', left.split ?? left.settings?.split, right.split ?? right.settings?.split);
  differ('judge', left.judgeModel, right.judgeModel);
  differ('arms', left.armsRequested, right.armsRequested);
  differ('promptChars.mean', left.promptChars?.mean, right.promptChars?.mean);
  differ('run.timeoutMs', left.run?.timeoutMs, right.run?.timeoutMs);
  return problems;
}

/**
 * Two artifacts as one paired contrast.
 *
 * Throws when the two are not comparable, because a number produced from two different prompts or
 * two different judges is not a smaller version of the truth — it is a number about something else.
 */
export function contrastArtifacts(left: ContrastArtifact, right: ContrastArtifact): ContrastOutcome {
  const problems = comparabilityProblems(left, right);
  if (problems.length > 0) throw new Error(`the two artifacts are not one contrast: ${problems.join('; ')}`);
  const leftPassed = new Map<string, boolean>();
  const rightPassed = new Map<string, boolean>();
  const leftJudged = new Set<string>();
  const rightJudged = new Set<string>();
  for (const entry of left.cases ?? []) {
    const id = String(entry.id);
    leftPassed.set(id, entry.passed === true);
    if (judgedOf(entry)) leftJudged.add(id);
  }
  for (const entry of right.cases ?? []) {
    const id = String(entry.id);
    rightPassed.set(id, entry.passed === true);
    if (judgedOf(entry)) rightJudged.add(id);
  }
  const shared = [...leftPassed.keys()].filter((id) => rightPassed.has(id));
  const complete = shared.filter((id) => leftJudged.has(id) && rightJudged.has(id));
  const intentToTreat = readingOf(shared, leftPassed, rightPassed);
  const completeCase = readingOf(complete, leftPassed, rightPassed);
  const discordant = shared.filter((id) => leftPassed.get(id) !== rightPassed.get(id));
  return {
    left: sideOf('left', left),
    right: sideOf('right', right),
    intentToTreat,
    completeCase,
    forfeitsLeft: discordant.filter((id) => !leftJudged.has(id)).length,
    forfeitsRight: discordant.filter((id) => !rightJudged.has(id)).length,
    // Both sides carried it and the gate above let them through, which means the two values are
    // equal; one side missing it means there is nothing to print.
    ...(left.run?.timeoutMs === undefined ? {} : { deadlineMs: left.run.timeoutMs }),
    problems: [],
  };
}

function percentage(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}pp`;
}

export function contrastLines(outcome: ContrastOutcome): string[] {
  const { left, right, intentToTreat, completeCase } = outcome;
  const lines: string[] = [];
  lines.push(`  ${left.label} (${left.model}) vs ${right.label} (${right.model})`);
  // What was found equal, printed once. The deadline is the one equality that makes the pair a
  // base comparison rather than a settings comparison, and the artifacts that carry it are the
  // only ones where the claim can be checked at all.
  if (outcome.deadlineMs !== undefined) lines.push(`  deadline ${String(outcome.deadlineMs)} ms on both sides`);
  lines.push('');
  lines.push('  what each side answered:');
  for (const side of [left, right]) {
    const total = side.judged + side.unanswered;
    lines.push(
      `    ${side.model.padEnd(20)} judged ${String(side.judged).padStart(4)}/${String(total).padEnd(4)}` +
        `  passed ${String(side.passed).padStart(4)}` +
        `  unanswered ${String(side.unanswered).padStart(3)}${side.unanswered === 0 ? '' : ` (${((side.unanswered / total) * 100).toFixed(2)}%: ${Object.entries(side.unansweredByKind).map(([kind, count]) => `${kind} ${String(count)}`).join(', ')})`}`,
    );
  }
  const forfeits = outcome.forfeitsLeft + outcome.forfeitsRight;
  lines.push('');
  lines.push(`  intent-to-treat: ${String(intentToTreat.n)} question(s), both ${String(intentToTreat.both)}, neither ${String(intentToTreat.neither)},` +
    ` only-left ${String(intentToTreat.onlyLeft)}, only-right ${String(intentToTreat.onlyRight)}`);
  lines.push(`    ${percentage(intentToTreat.deltaPp)}  exact McNemar p = ${intentToTreat.p.toFixed(4)}  CI [${intentToTreat.interval[0].toFixed(2)}, ${intentToTreat.interval[1].toFixed(2)}]`);
  lines.push(`  complete case:   ${String(completeCase.n)} question(s), both ${String(completeCase.both)}, neither ${String(completeCase.neither)},` +
    ` only-left ${String(completeCase.onlyLeft)}, only-right ${String(completeCase.onlyRight)}`);
  lines.push(`    ${percentage(completeCase.deltaPp)}  exact McNemar p = ${completeCase.p.toFixed(4)}  CI [${completeCase.interval[0].toFixed(2)}, ${completeCase.interval[1].toFixed(2)}]`);
  lines.push('');
  if (forfeits === 0) {
    lines.push('  no discordant case was decided by an unanswered side: the two readings are the same population.');
  } else {
    // The sentence names the reading it disqualifies. A reader who takes the complete-case delta
    // without this line has taken a number computed after deleting cases in proportion to how long
    // the model's answer ran, which is the treatment.
    lines.push(`  ${String(forfeits)} discordant case(s) have an unanswered side (left ${String(outcome.forfeitsLeft)}, right ${String(outcome.forfeitsRight)}).`);
    // The share of *its own* questions a side failed to answer. Guarding on `judged === 0` was
    // wrong: a side that answered nothing has the largest share there is, and reporting it as zero
    // made two runs — one dead, one healthy — read as having identical attrition.
    // No zero-total guard: this line runs only when a discordant case exists, which requires a
    // case on both sides. A guard no input can reach is a branch no test can cover, and the last
    // three rounds have each ended by finding one (ADR-219).
    const shareOf = (side: ContrastSide): number => side.unanswered / (side.judged + side.unanswered);
    const leftRate = shareOf(left);
    const rightRate = shareOf(right);
    lines.push(`  unanswered shares differ by ${((Math.abs(rightRate - leftRate)) * 100).toFixed(2)}pp: the complete-case reading is a`);
    lines.push('  lead about what happens when the model does answer, not a verdict on the configuration, because the');
    lines.push('  cases it deletes are the ones whose generation ran long — a property of the base, not of the question.');
  }
  return lines;
}

export interface ContrastSettings {
  readonly left: string;
  readonly right: string;
  readonly json: boolean;
}

export function resolveContrastSettings(argv: readonly string[], root: string): ContrastSettings {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const left = value('--left');
  const right = value('--right');
  if (left === undefined || right === undefined) throw new Error('usage: contrast.ts --left <artifact.json> --right <artifact.json> [--json]');
  return { left: resolve(root, left), right: resolve(root, right), json: argv.includes('--json') };
}

export function main(argv: readonly string[] = process.argv.slice(2), root = process.cwd()): number {
  const settings = resolveContrastSettings(argv, root);
  const left = JSON.parse(readFileSync(settings.left, 'utf8')) as ContrastArtifact;
  const right = JSON.parse(readFileSync(settings.right, 'utf8')) as ContrastArtifact;
  const outcome = contrastArtifacts(left, right);
  if (settings.json) {
    console.log(JSON.stringify(outcome, null, 2));
    return 0;
  }
  console.log(`  ${relative(root, settings.left)} vs ${relative(root, settings.right)}`);
  for (const line of contrastLines(outcome)) console.log(line);
  return 0;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

/**
 * Run the instrument when this file is the program, and do nothing when it is imported.
 *
 * The decision is a function rather than an `if` at the top level for one reason: the body of that
 * `if` is unreachable from a test, so it would sit in the coverage report as a statement nobody
 * checked — and the last two rounds have both ended with a defect that lived in a branch nobody
 * could reach. Here both sides are callable, and the only line that runs on import is this call.
 */
export function runIfEntry(argv: readonly string[], argv1: string | undefined, moduleUrl: string, root = process.cwd()): number | undefined {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  const code = main(argv, root);
  process.exitCode = code;
  return code;
}

runIfEntry(process.argv.slice(2), process.argv[1], import.meta.url);
