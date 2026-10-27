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
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadQuestions } from './data.js';
import { createOracle } from './oracle.js';
import type { OracleResult } from './oracle.js';
import { classifyError, classifyFailureShape } from './failure-shape.js';
import type { FailureShape } from './failure-shape.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const SPLIT = (process.env.BIRD_SPLIT ?? 'dev') as 'minidev' | 'dev';
const DATA =
  process.env.BIRD_DATA ??
  (SPLIT === 'dev' ? join(ROOT, 'eval/.cache/bird/dev/dev_20240627') : join(ROOT, 'eval/.cache/bird/minidev/MINIDEV'));
const QUESTIONS_FILE = SPLIT === 'dev' ? 'dev.json' : 'mini_dev_sqlite.json';

interface ReportedFailure {
  readonly id: string;
  readonly question?: string;
  readonly predicted: string;
  readonly reason: string;
  readonly error?: string;
}

interface Report {
  readonly failures?: Record<string, readonly ReportedFailure[]>;
  readonly failureSample?: { readonly cap: number; readonly total: Record<string, number>; readonly truncated: readonly string[] };
}

/** Counts per shape, plus the two facts a shape alone cannot carry. */
export interface ArmDiagnosis {
  readonly arm: string;
  readonly examined: number;
  readonly failing: number;
  readonly shapes: Record<FailureShape, number>;
  readonly errors: Record<string, number>;
  readonly scaleFactors: { factor: number; cases: number }[];
  readonly emptyShare: number;
}

export function tally(arm: string, classified: readonly { shape: FailureShape; error?: string; factor?: number }[], failing: number): ArmDiagnosis {
  const shapes: Record<FailureShape, number> = { error: 0, empty: 0, 'row-count': 0, 'column-count': 0, scale: 0, values: 0 };
  const errors: Record<string, number> = {};
  const factors = new Map<string, number>();
  for (const entry of classified) {
    shapes[entry.shape] += 1;
    if (entry.shape === 'error' && entry.error !== undefined) errors[entry.error] = (errors[entry.error] ?? 0) + 1;
    if (entry.shape === 'scale' && entry.factor !== undefined) {
      const key = entry.factor.toFixed(2);
      factors.set(key, (factors.get(key) ?? 0) + 1);
    }
  }
  return {
    arm,
    examined: classified.length,
    failing,
    shapes,
    errors,
    scaleFactors: [...factors.entries()]
      .map(([factor, cases]) => ({ factor: Number(factor), cases }))
      .sort((left, right) => right.cases - left.cases)
      .slice(0, 5),
    emptyShare: classified.length === 0 ? 0 : shapes.empty / classified.length,
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

async function main() {
  const path = process.argv[2];
  if (path === undefined) throw new Error('usage: diagnose-corpus.ts <report.json>');
  if (!existsSync(path)) throw new Error(`no such report: ${path}`);
  const report = JSON.parse(readFileSync(path, 'utf8')) as Report;
  if (report.failures === undefined) throw new Error('the report keeps no failing statements; nothing to diagnose');

  const questions = loadQuestions(join(DATA, QUESTIONS_FILE));
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));
  const oracle = createOracle(join(ROOT, 'eval/bird/oracle.py'), join(DATA, 'dev_databases'));

  const gold = new Map<string, OracleResult>();
  const diagnoses: ArmDiagnosis[] = [];
  try {
    for (const [arm, failures] of Object.entries(report.failures)) {
      const classified: { shape: FailureShape; error?: string; factor?: number }[] = [];
      for (const failure of failures) {
        const question = byId.get(failure.id);
        if (question === undefined || failure.predicted.trim() === '') continue;
        let expected = gold.get(failure.id);
        if (expected === undefined) {
          expected = await oracle.run(question.db_id, question.SQL);
          gold.set(failure.id, expected);
        }
        if (!expected.ok) continue;
        const predicted = await oracle.run(question.db_id, failure.predicted);
        const shape = classifyFailureShape(predicted, expected.rows);
        classified.push({
          shape: shape.shape,
          ...(shape.factor === undefined ? {} : { factor: shape.factor }),
          ...(predicted.ok || predicted.error === undefined ? {} : { error: classifyError(predicted.error) }),
        });
      }
      const total = report.failureSample?.total?.[arm] ?? failures.length;
      diagnoses.push(tally(arm, classified, total));
    }
  } finally {
    await oracle.close();
  }

  console.log(format(diagnoses));
  console.log('');
  for (const entry of diagnoses) {
    const kinds = Object.entries(entry.errors)
      .sort((left, right) => right[1] - left[1])
      .map(([kind, count]) => `${kind} ${String(count)}`)
      .join(', ');
    const factors = entry.scaleFactors.map((item) => `x${String(item.factor)} (${String(item.cases)})`).join(', ');
    console.log(
      `${entry.arm}: ${String(entry.failing)} failing, ${String(entry.examined)} examined` +
        `${kinds === '' ? '' : `; engine said: ${kinds}`}` +
        `${factors === '' ? '' : `; grain factors: ${factors}`}`,
    );
  }
  if (report.failureSample !== undefined && report.failureSample.truncated.length > 0) {
    console.log(`\ntruncated at ${String(report.failureSample.cap)}: ${report.failureSample.truncated.join(', ')}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
