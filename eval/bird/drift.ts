/**
 * Two runs of one arm, compared without spending a call.
 *
 * The instrument this file is: an artifact pair in, a flip table out. Its reason to exist is
 * that the harness scores one sample per case at temperature 0 and has no way to say whether
 * "the same prompt twice" produced the same statement. `I-84` answered that from two artifacts
 * rather than from a probe: the `metadata+evidence+icl` arm scored 951 on `41599208436`'s
 * predecessor and 939 on the run that carried the mask, with **every prompt token identical on
 * all 1,532 cases** — so 42 statements changed with nothing changed on this side, and a net of
 * −0.78pp arrived from the provider alone.
 *
 * That reading is the one thing a paired delta needs and never had: a noise floor measured on
 * the same split, on the same arm, with the prompt held fixed. The split between a flip whose
 * prompt was identical and a flip whose prompt moved is what makes it readable — the first is
 * the endpoint re-sampling, the second is a change on this side that the two artifacts disagree
 * about, and an artifact pair that has any of the second cannot price the first.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mcnemarExact } from '@agentix-e/nl2charts-devkit';

/** The part of a report this tool reads. Anything else in the artifact is not its business. */
interface DriftReportShape {
  readonly split?: string;
  readonly model?: string;
  readonly judgeModel?: string;
  readonly dialect?: string;
  readonly generatedAt?: string;
  readonly cases?: readonly DriftCaseShape[];
}

interface DriftCaseShape {
  readonly id: string | number;
  readonly arm: string;
  readonly passed: boolean;
  readonly tokens?: { readonly prompt?: number; readonly chars?: number };
}

/** Whether the prompt this case sent was the same one in both runs. */
export type PromptAgreement = 'same' | 'differ' | 'unknown';

export interface DriftCase {
  readonly id: string;
  readonly left: boolean;
  readonly right: boolean;
  readonly prompt: PromptAgreement;
}

export interface ArmDrift {
  readonly arm: string;
  readonly cases: number;
  readonly leftPassed: number;
  readonly rightPassed: number;
  /** Right minus left, in percentage points of the shared cases. */
  readonly delta: number;
  readonly kept: number;
  readonly gained: number;
  readonly lost: number;
  readonly prompt: {
    readonly same: number;
    readonly differ: number;
    readonly unknown: number;
  };
  /** Exact McNemar on the discordant pairs. Under a fixed prompt this is the provider's p. */
  readonly p: number;
  /** `gained + lost` over `cases`: how often one case changed its verdict between two runs. */
  readonly instability: number;
}

export interface DriftOutcome {
  readonly split: string;
  readonly left: string;
  readonly right: string;
  readonly arms: readonly ArmDrift[];
  /** Arms the two artifacts do not both carry. Dropped, counted, and named by the guard. */
  readonly unshared: number;
  readonly problems: readonly string[];
}

export interface DriftSettings {
  readonly left: string;
  readonly right: string;
  readonly arm?: string;
  readonly out: string;
  /** Exit non-zero on a problem. Off for a reading, on for a gate. */
  readonly strict: boolean;
}

const tokensOf = (row: DriftCaseShape): string | undefined => {
  const prompt = row.tokens?.prompt;
  const chars = row.tokens?.chars;
  // Both, because they fail differently: a token count is the tokenizer's view and a character
  // count is the prompt's. A provider that reports one and not the other is still a prompt this
  // tool can compare, and comparing only the token count would call two different prompts equal
  // whenever a retokenisation happened to land on the same total.
  return prompt === undefined || chars === undefined ? undefined : `${String(prompt)}:${String(chars)}`;
};

const readCases = (report: DriftReportShape, path: string): Map<string, Map<string, DriftCaseShape>> => {
  const byArm = new Map<string, Map<string, DriftCaseShape>>();
  for (const row of report.cases ?? []) {
    const arm = byArm.get(row.arm) ?? new Map<string, DriftCaseShape>();
    byArm.set(row.arm, arm);
    const id = String(row.id);
    // A case appears once per arm. Twice is a corrupt artifact, and the pairing below would
    // silently keep whichever row came last.
    if (arm.has(id)) throw new Error(`${path} carries case ${id} twice for arm ${row.arm}`);
    arm.set(id, row);
  }
  return byArm;
};

/**
 * Compare two artifacts, arm by arm.
 *
 * Every refusal here names the thing that makes the pair unreadable rather than publishing a
 * zero: a file compared with itself, two splits, two artifacts with no arm in common, and an
 * artifact that does not carry the arm the caller named. A problem, rather than a refusal, is
 * for a pair that *can* be compared but whose disagreement has a cause other than drift — a
 * different model, a different judge, or prompts that moved between the runs.
 */
export function compareArtifacts(
  leftReport: DriftReportShape,
  rightReport: DriftReportShape,
  options: { readonly left?: string; readonly right?: string; readonly arm?: string } = {},
): DriftOutcome {
  const leftLabel = options.left ?? 'left';
  const rightLabel = options.right ?? 'right';
  if (leftLabel === rightLabel) throw new Error(`${leftLabel} is compared with itself, which measures nothing`);
  const split = leftReport.split ?? rightReport.split;
  if (split === undefined) throw new Error('neither artifact names a split');
  if (leftReport.split !== rightReport.split) {
    throw new Error(`${leftLabel} is ${String(leftReport.split)} and ${rightLabel} is ${String(rightReport.split)}`);
  }
  const left = readCases(leftReport, leftLabel);
  const right = readCases(rightReport, rightLabel);
  // Every arm both artifacts carry, with both sides already in hand. The pairing below never
  // looks a map up again: an arm that reached this list cannot be missing from one side of it,
  // which is why there is no fallback map to get wrong and no branch that only a corrupt
  // artifact could take.
  const shared: { readonly arm: string; readonly before: Map<string, DriftCaseShape>; readonly after: Map<string, DriftCaseShape> }[] = [];
  for (const [arm, before] of left) {
    const after = right.get(arm);
    if (after !== undefined) shared.push({ arm, before, after });
  }
  shared.sort((one, other) => one.arm.localeCompare(other.arm));
  if (options.arm !== undefined && !shared.some((entry) => entry.arm === options.arm)) {
    throw new Error(`${leftLabel} and ${rightLabel} do not both carry arm ${options.arm}`);
  }
  const arms = options.arm === undefined ? shared : shared.filter((entry) => entry.arm === options.arm);
  if (arms.length === 0) throw new Error(`${leftLabel} and ${rightLabel} share no arm`);

  const rows: ArmDrift[] = [];
  for (const { arm, before: leftArm, after: rightArm } of arms) {
    const ids = [...leftArm.keys()].filter((id) => rightArm.has(id));
    if (ids.length === 0) throw new Error(`${leftLabel} and ${rightLabel} share no case on arm ${arm}`);
    let kept = 0;
    let gained = 0;
    let lost = 0;
    const prompt = { same: 0, differ: 0, unknown: 0 };
    for (const id of ids) {
      const before = leftArm.get(id) as DriftCaseShape;
      const after = rightArm.get(id) as DriftCaseShape;
      const beforePrompt = tokensOf(before);
      const afterPrompt = tokensOf(after);
      if (beforePrompt === undefined || afterPrompt === undefined) prompt.unknown += 1;
      else if (beforePrompt === afterPrompt) prompt.same += 1;
      else prompt.differ += 1;
      if (before.passed === after.passed) kept += 1;
      else if (after.passed) gained += 1;
      else lost += 1;
    }
    const leftPassed = ids.filter((id) => (leftArm.get(id) as DriftCaseShape).passed).length;
    const rightPassed = ids.filter((id) => (rightArm.get(id) as DriftCaseShape).passed).length;
    rows.push({
      arm,
      cases: ids.length,
      leftPassed,
      rightPassed,
      delta: (100 * (rightPassed - leftPassed)) / ids.length,
      kept,
      gained,
      lost,
      prompt,
      p: mcnemarExact(lost, gained),
      instability: (gained + lost) / ids.length,
    });
  }

  const problems: string[] = [];
  if (leftReport.model !== rightReport.model) {
    problems.push(
      `DRIFT: the two artifacts were produced by different models (${String(leftReport.model)} and ${String(rightReport.model)}), so their disagreement is not a re-sample of one prompt`,
    );
  }
  if (leftReport.judgeModel !== rightReport.judgeModel) {
    problems.push(
      `DRIFT: the two artifacts were judged by different models (${String(leftReport.judgeModel)} and ${String(rightReport.judgeModel)}), so a flipped verdict has two possible causes`,
    );
  }
  if (leftReport.dialect !== rightReport.dialect) {
    problems.push(
      `DRIFT: the two artifacts were scored in different dialects (${String(leftReport.dialect)} and ${String(rightReport.dialect)})`,
    );
  }
  const differing = rows.reduce((total, row) => total + row.prompt.differ, 0);
  if (differing > 0) {
    problems.push(
      `DRIFT: ${String(differing)} case(s) sent a different prompt in the two runs, so this pair prices a change on this side as well as the endpoint`,
    );
  }
  const unreadable = rows.reduce((total, row) => total + row.prompt.unknown, 0);
  if (unreadable > 0) {
    problems.push(
      `DRIFT: ${String(unreadable)} case(s) carry no prompt size in one of the artifacts, so a flip there cannot be attributed`,
    );
  }
  const unshared = [...left.keys()].filter((arm) => !right.has(arm)).length + [...right.keys()].filter((arm) => !left.has(arm)).length;

  return { split, left: leftLabel, right: rightLabel, arms: rows, unshared, problems };
}

export function driftLines(outcome: DriftOutcome): readonly string[] {
  const lines = [`\ndrift: ${outcome.split}, ${outcome.left} vs ${outcome.right}, ${String(outcome.unshared)} unshared arm(s)`];
  for (const row of outcome.arms) {
    lines.push(
      `  ${row.arm}\n` +
        `    ${String(row.leftPassed)} -> ${String(row.rightPassed)} of ${String(row.cases)} (${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(2)}pp), ` +
        `gained ${String(row.gained)} / lost ${String(row.lost)}, exact McNemar p=${row.p.toFixed(4)}\n` +
        `    one case changed its verdict on ${(100 * row.instability).toFixed(2)}% of the split; prompt same ${String(row.prompt.same)}, ` +
        `differ ${String(row.prompt.differ)}, unreadable ${String(row.prompt.unknown)}`,
    );
  }
  return lines;
}

const HEAD = 'usage: drift.ts <left.json> <right.json> [--arm <name>] [--strict]';

export function resolveDriftSettings(argv: readonly string[], root: string): DriftSettings {
  const flag = argv.indexOf('--arm');
  const named = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && named === undefined) throw new Error('--arm needs a name');
  const consumed = flag === -1 ? [] : [flag, flag + 1];
  const paths = argv.filter((item, index) => !item.startsWith('--') && !consumed.includes(index));
  if (paths.length !== 2) throw new Error(HEAD);
  const [left, right] = paths as [string, string];
  return {
    left: resolve(root, left),
    right: resolve(root, right),
    ...(named === undefined ? {} : { arm: named }),
    out: dirname(resolve(root, right)),
    strict: argv.includes('--strict'),
  };
}

export function driftPath(settings: DriftSettings): string {
  const suffix = settings.arm === undefined ? 'all' : settings.arm.replace(/[^a-z0-9+_-]/gi, '-');
  return resolve(settings.out, `drift-${suffix}.json`);
}

export function runDrift(settings: DriftSettings): DriftOutcome {
  const left = JSON.parse(readFileSync(settings.left, 'utf8')) as DriftReportShape;
  const right = JSON.parse(readFileSync(settings.right, 'utf8')) as DriftReportShape;
  return compareArtifacts(left, right, { left: settings.left, right: settings.right, ...(settings.arm === undefined ? {} : { arm: settings.arm }) });
}

export function writeDriftArtifact(settings: DriftSettings, outcome: DriftOutcome): string {
  const path = driftPath(settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(outcome, null, 2));
  return path;
}

export function main(argv: readonly string[] = process.argv.slice(2), root = process.cwd()): number {
  const settings = resolveDriftSettings(argv, root);
  const outcome = runDrift(settings);
  for (const line of driftLines(outcome)) console.log(line);
  const path = writeDriftArtifact(settings, outcome);
  console.log(`\nwrote ${path}`);
  for (const problem of outcome.problems) console.error(problem);
  if (outcome.problems.length === 0) return 0;
  return settings.strict ? 1 : 0;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
