/**
 * What kind of wrong the failures are, measured offline.
 *
 * The runner reports a verdict per case: matched or not, and whether the column count
 * was off. That is enough to score an arm and not enough to decide what to build next —
 * "wrong values" covers a filter that matched nothing, an aggregation at the wrong grain
 * and a projection that picked the wrong column, and each has a different fix.
 *
 * This reads an artifact that kept its failing statements, executes them against the same
 * databases the run used, and classifies every one. It costs no model call, so it can run
 * over every failure instead of a sample.
 *
 *   tsx eval/bird/diagnose-corpus.ts eval/out/bird-eval.json
 *   BIRD_SPLIT=dev tsx eval/bird/diagnose-corpus.ts <report>
 *
 * The entry is a value, not a program: paths come in through `resolveDiagnoseSettings`, the
 * diagnosis comes out of `runDiagnosis`, and `main` is the three lines that turn one into
 * the other plus an exit code. A module whose top level *is* the program can only be tested
 * by spawning it, which is why the first version of this file measured 53% — the part that
 * decided anything ran at import time.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadQuestions } from './data.js';
import type { BirdQuestion } from './data.js';
import { createOracle } from './oracle.js';
import type { Oracle, OracleResult } from './oracle.js';
import { resolveLayout } from './run.js';
import type { BirdLayout } from './run.js';
import { classifyError, classifyFailureShape, missingLiterals } from './failure-shape.js';
import type { FailureShape } from './failure-shape.js';

/** Where a diagnosis reads and writes. Every field is a value the caller supplies. */
export interface DiagnoseSettings {
  /** The run artifact that kept its failing statements. */
  readonly report: string;
  /** The dataset layout, resolved once by the runner's own `resolveLayout`. */
  readonly layout: BirdLayout;
  /** Directory the diagnosis artifact is written to; beside the run artifact by default. */
  readonly out: string;
}

/**
 * Read the paths out of the environment and the argument list.
 *
 * `root` is a parameter rather than `import.meta.url`: a test that writes a fixture dataset
 * into a temporary directory has to be able to point the oracle and the output at it, and
 * the first version of this file baked the repository root in at import time. The layout
 * itself comes from `resolveLayout`, so a diagnosis reads the same questions, databases and
 * oracle script as the run whose failures it is explaining.
 */
export function resolveDiagnoseSettings(
  env: Record<string, string | undefined>,
  argv: readonly string[],
  root: string,
): DiagnoseSettings {
  const path = argv[0];
  if (path === undefined) throw new Error('usage: diagnose-corpus.ts <report.json>');
  const layout = resolveLayout(env, root);
  return { report: path, layout, out: dirname(layout.out) };
}

export interface ReportedFailure {
  readonly id: string;
  readonly question?: string;
  readonly predicted: string;
  readonly reason: string;
  readonly error?: string;
}

export interface FailureSample {
  readonly cap: number;
  readonly total: Record<string, number>;
  readonly truncated: readonly string[];
}

export interface Report {
  readonly failures?: Record<string, readonly ReportedFailure[]>;
  readonly failureSample?: FailureSample;
}

/**
 * A report that has been checked.
 *
 * `prepareDiagnosis` refuses a report without `failures`, so everything downstream can read
 * the list instead of defending against its absence. The first version kept a
 * `report.failures ?? {}` in the loop, which meant an unreachable fallback sat in the middle
 * of the only code that decides anything — a branch no test could ever cover.
 */
export interface GradedReport {
  readonly failures: Record<string, readonly ReportedFailure[]>;
  readonly sample?: FailureSample;
}

/**
 * The failures that could not be classified, and why.
 *
 * A share over the survivors is not a share. The first version dropped an unknown question
 * id, an empty prediction and a gold statement the engine refused with three bare
 * `continue`s, then divided by what was left — so a run with a broken gold would have
 * published a confident distribution over the handful of cases that survived.
 */
export interface DiagnosisDrops {
  /** The id is not in the questions file, so there is no gold to compare against. */
  unknownQuestion: number;
  /** Nothing to execute: the model returned an empty string. */
  emptyPrediction: number;
  /** The gold statement itself failed, so the case cannot be graded by this tool. */
  goldFailed: number;
}

export const NO_DROPS: DiagnosisDrops = { unknownQuestion: 0, emptyPrediction: 0, goldFailed: 0 };

/** Counts per shape, plus the two facts a shape alone cannot carry. */
export interface ArmDiagnosis {
  readonly arm: string;
  /** Failures the run reported for this arm, before any were dropped. */
  readonly failing: number;
  /** Failures actually classified. */
  readonly examined: number;
  readonly drops: DiagnosisDrops;
  readonly shapes: Record<FailureShape, number>;
  readonly errors: Record<string, number>;
  readonly scaleFactors: { factor: number; cases: number }[];
  readonly emptyShare: number;
  /**
   * How many failures leave out a literal the gold statement names.
   *
   * This is the signature of the value-grounding hypothesis: a filter comparing against a
   * value the question did not spell the way the data stores it. If the share is small,
   * the next iteration is not about values, whatever the `values` arm did.
   */
  readonly literalMiss: { cases: number; share: number; top: { literal: string; cases: number }[] };
}

/** One failure, reduced to what the shapes can be counted from. */
export interface Classified {
  readonly shape: FailureShape;
  readonly error?: string;
  readonly factor?: number;
  readonly missing?: readonly string[];
}

export function tally(
  arm: string,
  classified: readonly Classified[],
  failing: number,
  drops: DiagnosisDrops = NO_DROPS,
): ArmDiagnosis {
  const shapes: Record<FailureShape, number> = { error: 0, empty: 0, 'row-count': 0, 'column-count': 0, scale: 0, values: 0 };
  const errors: Record<string, number> = {};
  const factors = new Map<string, number>();
  const missingCounts = new Map<string, number>();
  let literalsMissing = 0;
  for (const entry of classified) {
    if ((entry.missing?.length ?? 0) > 0) {
      literalsMissing += 1;
      for (const literal of new Set(entry.missing)) missingCounts.set(literal, (missingCounts.get(literal) ?? 0) + 1);
    }
    shapes[entry.shape] += 1;
    if (entry.shape === 'error' && entry.error !== undefined) errors[entry.error] = (errors[entry.error] ?? 0) + 1;
    if (entry.shape === 'scale' && entry.factor !== undefined) {
      const key = entry.factor.toFixed(2);
      factors.set(key, (factors.get(key) ?? 0) + 1);
    }
  }
  return {
    arm,
    failing,
    examined: classified.length,
    drops,
    shapes,
    errors,
    scaleFactors: [...factors.entries()]
      .map(([factor, cases]) => ({ factor: Number(factor), cases }))
      .sort((left, right) => right.cases - left.cases)
      .slice(0, 5),
    emptyShare: classified.length === 0 ? 0 : shapes.empty / classified.length,
    literalMiss: {
      cases: literalsMissing,
      share: classified.length === 0 ? 0 : literalsMissing / classified.length,
      top: [...missingCounts.entries()]
        .map(([literal, cases]) => ({ literal, cases }))
        .sort((left, right) => right.cases - left.cases)
        .slice(0, 5),
    },
  };
}

export function format(diagnoses: readonly ArmDiagnosis[]): string {
  const header = ['arm', 'examined', 'empty', 'row-count', 'column-count', 'scale', 'values', 'error'];
  const lines = [header.join('\t')];
  for (const entry of diagnoses) {
    lines.push(
      [
        entry.arm,
        String(entry.examined),
        share(entry.shapes.empty, entry.examined),
        share(entry.shapes['row-count'], entry.examined),
        share(entry.shapes['column-count'], entry.examined),
        share(entry.shapes.scale, entry.examined),
        share(entry.shapes.values, entry.examined),
        share(entry.shapes.error, entry.examined),
      ].join('\t'),
    );
  }
  return lines.join('\n');
}

function share(count: number, total: number): string {
  return `${String(count)} (${((count / Math.max(1, total)) * 100).toFixed(1)}%)`;
}

/** One line per arm, carrying the facts a table cell cannot hold. */
export function armLines(diagnoses: readonly ArmDiagnosis[]): string[] {
  return diagnoses.map((entry) => {
    const kinds = Object.entries(entry.errors)
      .sort((left, right) => right[1] - left[1])
      .map(([kind, count]) => `${kind} ${String(count)}`)
      .join(', ');
    const factors = entry.scaleFactors.map((item) => `x${String(item.factor)} (${String(item.cases)})`).join(', ');
    return (
      `${entry.arm}: ${String(entry.failing)} failing, ${String(entry.examined)} examined` +
      `${kinds === '' ? '' : `; engine said: ${kinds}`}` +
      `${factors === '' ? '' : `; grain factors: ${factors}`}` +
      `; leaves out a gold literal: ${String(entry.literalMiss.cases)} (${(entry.literalMiss.share * 100).toFixed(1)}%)` +
      (entry.literalMiss.top.length === 0
        ? ''
        : ` — most often ${entry.literalMiss.top.map((item) => `${item.literal} (${String(item.cases)})`).join(', ')}`)
    );
  });
}

/** The lines a dropped-failure count deserves: it is the denominator of every share above. */
export function dropLines(diagnoses: readonly ArmDiagnosis[]): string[] {
  const lines: string[] = [];
  for (const entry of diagnoses) {
    const dropped = entry.drops.unknownQuestion + entry.drops.emptyPrediction + entry.drops.goldFailed;
    if (dropped === 0) continue;
    const reasons = [
      ...(entry.drops.unknownQuestion === 0 ? [] : [`${String(entry.drops.unknownQuestion)} unknown question id`]),
      ...(entry.drops.emptyPrediction === 0 ? [] : [`${String(entry.drops.emptyPrediction)} empty prediction`]),
      ...(entry.drops.goldFailed === 0 ? [] : [`${String(entry.drops.goldFailed)} gold statement failed`]),
    ].join(', ');
    lines.push(
      `${entry.arm}: dropped ${String(dropped)} of ${String(entry.failing)} failures (${reasons}); ` +
        `shapes are shares of the other ${String(entry.examined)}`,
    );
  }
  return lines;
}

export interface DiagnosePrepared {
  readonly settings: DiagnoseSettings;
  readonly report: GradedReport;
  readonly byId: ReadonlyMap<string, BirdQuestion>;
  readonly oracle: Oracle;
}

/**
 * Read the report, read the questions, start the oracle.
 *
 * Separate from the classification so that a failure to start the oracle is not reported as
 * a diagnosis of zero failures. The first version ran both inside one try block, and a
 * missing `oracle.py` looked like a clean run.
 */
export function prepareDiagnosis(settings: DiagnoseSettings): DiagnosePrepared {
  if (!existsSync(settings.report)) throw new Error(`no such report: ${settings.report}`);
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as Report;
  if (report.failures === undefined) throw new Error('the report keeps no failing statements; nothing to diagnose');
  const questions = loadQuestions(settings.layout.questionsFile);
  const sample = report.failureSample;
  return {
    settings,
    report: { failures: report.failures, ...(sample === undefined ? {} : { sample }) },
    byId: new Map(questions.map((question) => [String(question.question_id), question])),
    oracle: createOracle(settings.layout.oracleScript, settings.layout.databaseRoot),
  };
}

export interface DiagnosisOutcome {
  readonly split: string;
  readonly diagnoses: readonly ArmDiagnosis[];
  /**
   * What the run sampled, when it kept a sample.
   *
   * `cap` and `truncated` travel together because they are one fact: the run stopped at a
   * cap and these arms were cut. Carrying them as two optional fields let the report print
   * `truncated at ?` — a line no run could have produced, so no test could reach it.
   */
  readonly sample?: { readonly cap: number; readonly truncated: readonly string[] };
}

/** Classify every failure the report kept. The oracle owns the subprocess; this owns the loop. */
export async function runDiagnosis(prepared: DiagnosePrepared): Promise<DiagnosisOutcome> {
  const gold = new Map<string, OracleResult>();
  const diagnoses: ArmDiagnosis[] = [];
  try {
    for (const [arm, failures] of Object.entries(prepared.report.failures)) {
      const classified: Classified[] = [];
      const drops: DiagnosisDrops = { ...NO_DROPS };
      for (const failure of failures) {
        const question = prepared.byId.get(failure.id);
        if (question === undefined) {
          drops.unknownQuestion += 1;
          continue;
        }
        if (failure.predicted.trim() === '') {
          drops.emptyPrediction += 1;
          continue;
        }
        let expected = gold.get(failure.id);
        if (expected === undefined) {
          expected = await prepared.oracle.run(question.db_id, question.SQL);
          gold.set(failure.id, expected);
        }
        if (!expected.ok) {
          drops.goldFailed += 1;
          continue;
        }
        const predicted = await prepared.oracle.run(question.db_id, failure.predicted);
        const shape = classifyFailureShape(predicted, expected.rows);
        const missing = missingLiterals(question.SQL, failure.predicted);
        classified.push({
          shape: shape.shape,
          ...(shape.factor === undefined ? {} : { factor: shape.factor }),
          ...(predicted.ok || predicted.error === undefined ? {} : { error: classifyError(predicted.error) }),
          ...(missing.length === 0 ? {} : { missing }),
        });
      }
      const total = prepared.report.sample?.total[arm] ?? failures.length;
      diagnoses.push(tally(arm, classified, total, drops));
    }
  } finally {
    await prepared.oracle.close();
  }
  const sample = prepared.report.sample;
  return {
    split: prepared.settings.layout.split,
    diagnoses,
    ...(sample === undefined ? {} : { sample: { cap: sample.cap, truncated: sample.truncated } }),
  };
}

/** The artifact, so a diagnosis can be diffed between runs instead of retyped from a console. */
export function diagnosisArtifact(outcome: DiagnosisOutcome): Record<string, unknown> {
  return {
    split: outcome.split,
    arms: outcome.diagnoses,
    truncated: outcome.sample?.truncated ?? [],
    ...(outcome.sample === undefined ? {} : { cap: outcome.sample.cap }),
    measuredAt: new Date().toISOString(),
  };
}

/** Where the artifact goes. Named after the split, so two runs cannot overwrite each other. */
export function diagnosisPath(settings: DiagnoseSettings): string {
  return join(settings.out, `diagnosis-${settings.layout.split}.json`);
}

export function writeDiagnosisArtifact(settings: DiagnoseSettings, outcome: DiagnosisOutcome): string {
  mkdirSync(settings.out, { recursive: true });
  const path = diagnosisPath(settings);
  writeFileSync(path, `${JSON.stringify(diagnosisArtifact(outcome), null, 2)}\n`);
  return path;
}

/** Everything the entry prints, as data, so the wording is testable without capturing stdout. */
export function diagnoseLines(outcome: DiagnosisOutcome): string[] {
  const lines = [format(outcome.diagnoses), '', ...armLines(outcome.diagnoses)];
  const dropped = dropLines(outcome.diagnoses);
  if (dropped.length > 0) lines.push('', ...dropped);
  const sample = outcome.sample;
  if (sample !== undefined && sample.truncated.length > 0) {
    lines.push('', `truncated at ${String(sample.cap)}: ${sample.truncated.join(', ')}`);
  }
  return lines;
}

export async function runDiagnose(settings: DiagnoseSettings): Promise<{ outcome: DiagnosisOutcome; path: string }> {
  const prepared = prepareDiagnosis(settings);
  const outcome = await runDiagnosis(prepared);
  return { outcome, path: writeDiagnosisArtifact(settings, outcome) };
}

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

export async function main(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv.slice(2),
  root: string = ROOT,
): Promise<void> {
  const settings = resolveDiagnoseSettings(env, argv, root);
  const { outcome, path } = await runDiagnose(settings);
  for (const line of diagnoseLines(outcome)) console.log(line);
  console.log(`\nwrote ${path}`);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
