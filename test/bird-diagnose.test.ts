/**
 * The offline diagnosis, driven the way the entry drives it.
 *
 * Every case here runs through a real oracle subprocess against a real SQLite file, because
 * the thing being tested is a classification of two result sets the engine produced. A
 * stubbed result set would have agreed with the first version of this file, which is exactly
 * how it kept a silent denominator for three rounds.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  armLines,
  diagnoseLines,
  diagnosisArtifact,
  diagnosisPath,
  dropLines,
  format,
  NO_DROPS,
  prepareDiagnosis,
  resolveDiagnoseSettings,
  runDiagnose,
  runDiagnosis,
  tally,
} from '../eval/bird/diagnose-corpus.js';
import { main } from '../eval/bird/diagnose-corpus.js';
import type { DiagnoseSettings, GradedReport, Report, ReportedFailure } from '../eval/bird/diagnose-corpus.js';
import { MINI_DB, writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();

const failure = (id: string, predicted: string): ReportedFailure => ({ id, predicted, reason: 'values' });

/**
 * The shared fixture plus two questions it does not carry.
 *
 * `every item price` has a gold that returns three rows, which is the only way the grain
 * shape can be observed: a one-row result has no evidence for a factor. `a broken gold`
 * is a statement the engine refuses, which is the case that used to vanish.
 */
function dataset(): string {
  const dir = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'diagnose-')));
  const file = join(dir, 'mini_dev_sqlite.json');
  const questions = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
  questions.push(
    { question_id: 8, db_id: MINI_DB, question: 'What is the price of every item?', evidence: '', SQL: 'select price from items', difficulty: 'simple' },
    { question_id: 9, db_id: MINI_DB, question: 'A question whose gold cannot run', evidence: '', SQL: 'select nope from items', difficulty: 'simple' },
  );
  writeFileSync(file, JSON.stringify(questions));
  return dir;
}

function reportPath(body: Report): string {
  const dir = mkdtempSync(join(tmpdir(), 'diagnose-report-'));
  const path = join(dir, 'bird-eval.json');
  writeFileSync(path, JSON.stringify(body));
  return path;
}

function settingsFor(data: string, report: string): DiagnoseSettings {
  return resolveDiagnoseSettings({ BIRD_SPLIT: 'minidev', BIRD_DATA: data }, [report], ROOT);
}

/** One arm covering every shape and all three ways a failure can be dropped. */
const REPORT: Report = {
  failures: {
    names: [
      failure('1', 'select count(*) from items where price > 2'),
      failure('8', 'select price * 2 from items'),
      failure('3', 'select id from orders where qty > 100'),
      failure('2', 'select sum(price), 1 from items'),
      failure('4', 'select qty from orders'),
      failure('5', 'select count(*) from items where nmae = 1'),
      failure('7', 'select count(*) from orders where item_id = 2'),
      failure('999', 'select 1'),
      failure('6', '   '),
      failure('9', 'select price from items'),
    ],
  },
  failureSample: { cap: 50, total: { names: 10 }, truncated: [] },
};

describe('resolving where a diagnosis reads and writes', () => {
  it('takes the report path from the argument list and the rest from the layout', () => {
    const settings = resolveDiagnoseSettings({ BIRD_SPLIT: 'minidev', BIRD_DATA: '/data' }, ['/report.json'], ROOT);
    expect(settings.report).toBe('/report.json');
    expect(settings.layout.questionsFile).toBe(join('/data', 'mini_dev_sqlite.json'));
    expect(settings.layout.databaseRoot).toBe(join('/data', 'dev_databases'));
    // Beside the run artifact, so a run pointed elsewhere does not scatter its output.
    expect(settings.out).toBe(join(ROOT, 'eval/out'));
  });

  it('refuses to run without a report, rather than diagnosing nothing', () => {
    expect(() => resolveDiagnoseSettings({}, [], ROOT)).toThrow(/usage: diagnose-corpus\.ts/);
  });
});

describe('classifying the failures an artifact kept', () => {
  it('separates every shape the two result sets can distinguish', async () => {
    const { outcome } = await runDiagnose(settingsFor(dataset(), reportPath(REPORT)));
    const arm = outcome.diagnoses[0];
    expect(arm?.arm).toBe('names');
    expect(arm?.shapes).toEqual({ error: 1, empty: 1, 'row-count': 1, 'column-count': 1, scale: 1, values: 2 });
    expect(arm?.errors).toEqual({ 'unknown-identifier': 1 });
    expect(arm?.scaleFactors).toEqual([{ factor: 2, cases: 1 }]);
  });

  it('counts the failures it could not grade instead of dividing by the survivors', async () => {
    // The defect this pins: three `continue`s used to erase an unknown id, an empty
    // prediction and a broken gold, and every share below was then computed over what was
    // left without saying so.
    const { outcome } = await runDiagnose(settingsFor(dataset(), reportPath(REPORT)));
    const arm = outcome.diagnoses[0];
    expect(arm?.failing).toBe(10);
    expect(arm?.examined).toBe(7);
    expect(arm?.drops).toEqual({ unknownQuestion: 1, emptyPrediction: 1, goldFailed: 1 });
    expect(dropLines(outcome.diagnoses)).toEqual([
      'names: dropped 3 of 10 failures (1 unknown question id, 1 empty prediction, 1 gold statement failed); shapes are shares of the other 7',
    ]);
  });

  it('finds the gold literal the prediction left out', async () => {
    const { outcome } = await runDiagnose(settingsFor(dataset(), reportPath(REPORT)));
    const arm = outcome.diagnoses[0];
    expect(arm?.literalMiss.cases).toBe(1);
    expect(arm?.literalMiss.top).toEqual([{ literal: '1', cases: 1 }]);
    expect(armLines(outcome.diagnoses)[0]).toContain('leaves out a gold literal: 1 (14.3%)');
  });

  it('writes the diagnosis, because a console that scrolled is not a measurement', async () => {
    const settings = settingsFor(dataset(), reportPath(REPORT));
    const { path, outcome } = await runDiagnose(settings);
    expect(path).toBe(diagnosisPath(settings));
    const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(written.split).toBe('minidev');
    expect(written.arms).toHaveLength(1);
    expect(outcome.split).toBe('minidev');
  });

  it('runs one oracle for every arm, and reads the gold once per question', async () => {
    const data = dataset();
    const twoArms: Report = { failures: { a: [failure('1', 'select 1')], b: [failure('1', 'select 2'), failure('1', 'select 3')] } };
    const { outcome } = await runDiagnose(settingsFor(data, reportPath(twoArms)));
    expect(outcome.diagnoses.map((entry) => entry.arm)).toEqual(['a', 'b']);
    // No failure sample in this report: the arm's own list is the denominator.
    expect(outcome.diagnoses.map((entry) => entry.failing)).toEqual([1, 2]);
    expect(outcome.sample).toBeUndefined();
  });

  it('never starts an oracle it has nothing to ask', () => {
    expect(() => prepareDiagnosis(settingsFor(dataset(), '/nowhere/report.json'))).toThrow(/no such report/);
  });

  it('refuses a report that kept no statements', () => {
    expect(() => prepareDiagnosis(settingsFor(dataset(), reportPath({})))).toThrow(/keeps no failing statements/);
  });

  it('closes the oracle even when the loop throws', async () => {
    const settings = settingsFor(dataset(), reportPath(REPORT));
    const prepared = prepareDiagnosis(settings);
    // A report whose failure list is not iterable is the cheapest way to make the loop
    // throw after the oracle is running; the assertion is that close() still happened,
    // which the oracle answers by refusing the next run.
    const broken = { ...prepared, report: { failures: { names: 5 } } as unknown as GradedReport };
    await expect(runDiagnosis(broken)).rejects.toThrow();
    await expect(prepared.oracle.run(MINI_DB, 'select 1')).rejects.toThrow(/closed/);
  });
});

describe('the lines a diagnosis prints', () => {
  it('keeps the table, the per-arm facts and the truncation notice', async () => {
    const truncated: Report = { ...REPORT, failureSample: { cap: 50, total: { names: 10 }, truncated: ['names'] } };
    const { outcome } = await runDiagnose(settingsFor(dataset(), reportPath(truncated)));
    const lines = diagnoseLines(outcome);
    expect(lines[0]?.split('\t')[0]).toBe('arm');
    expect(lines).toContain('names: 10 failing, 7 examined; engine said: unknown-identifier 1; grain factors: x2 (1)'.concat(
      '; leaves out a gold literal: 1 (14.3%) — most often 1 (1)',
    ));
    expect(lines.at(-1)).toBe('truncated at 50: names');
    expect(outcome.sample).toEqual({ cap: 50, truncated: ['names'] });
  });

  it('omits the drop and truncation lines when there is nothing to report', () => {
    const lines = diagnoseLines({ split: 'dev', diagnoses: [tally('a', [{ shape: 'empty' }], 1)], sample: { cap: 50, truncated: [] } });
    expect(dropLines([tally('a', [{ shape: 'empty' }], 1)])).toEqual([]);
    expect(lines.some((line) => line.startsWith('dropped'))).toBe(false);
    expect(lines.some((line) => line.startsWith('truncated'))).toBe(false);
  });

  it('prints a shape share without dividing by zero', () => {
    const text = format([tally('a', [], 0)]);
    expect(text.split('\n')[1]).toBe('a\t0\t0 (0.0%)\t0 (0.0%)\t0 (0.0%)\t0 (0.0%)\t0 (0.0%)\t0 (0.0%)');
  });

  it('keeps a dropped count at zero for an arm that dropped nothing', () => {
    expect(tally('a', [{ shape: 'values' }], 1).drops).toEqual(NO_DROPS);
  });
});

describe('the artifact', () => {
  it('carries the split, the cap and a timestamp', () => {
    const artifact = diagnosisArtifact({ split: 'dev', diagnoses: [], sample: { cap: 200, truncated: ['names'] } });
    expect(artifact.cap).toBe(200);
    expect(typeof artifact.measuredAt).toBe('string');
  });
});

describe('the entry, run the way the benchmark runs it', () => {
  it('writes the artifact and prints the table when called with paths', async () => {
    const data = dataset();
    const root = mkdtempSync(join(tmpdir(), 'diagnose-root-'));
    await main({ BIRD_SPLIT: 'minidev', BIRD_DATA: data }, [reportPath(REPORT)], root);
    const written = JSON.parse(readFileSync(join(root, 'eval/out/diagnosis-minidev.json'), 'utf8')) as Record<string, unknown>;
    expect(written.split).toBe('minidev');
    expect(written.cap).toBe(50);
  });

  it('is executable as a script, because that is the contract the workflow runs', () => {
    // The guard is only exercised by a real child process: imported, `import.meta.url` is
    // never the entry, so every other test in this file leaves that branch dark — and a
    // guard that never fires is a CLI nobody has run.
    const data = dataset();
    const root = mkdtempSync(join(tmpdir(), 'diagnose-cli-'));
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'eval/bird/diagnose-corpus.ts'), reportPath(REPORT)], {
      cwd: ROOT,
      env: { ...process.env, BIRD_SPLIT: 'minidev', BIRD_DATA: data, BIRD_OUT: join(root, 'bird-eval.json') },
      encoding: 'utf8',
    });
    expect(result.stderr).not.toContain('Error');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('names: 10 failing, 7 examined');
    expect(existsSync(join(root, 'diagnosis-minidev.json'))).toBe(true);
  });
});

describe('naming the reasons separately', () => {
  it('lists only the reason that occurred', () => {
    const only = (drops: { unknownQuestion: number; emptyPrediction: number; goldFailed: number }): string[] =>
      dropLines([tally('a', [], 1, drops)]);
    expect(only({ unknownQuestion: 1, emptyPrediction: 0, goldFailed: 0 })).toEqual([
      'a: dropped 1 of 1 failures (1 unknown question id); shapes are shares of the other 0',
    ]);
    expect(only({ unknownQuestion: 0, emptyPrediction: 1, goldFailed: 0 })).toEqual([
      'a: dropped 1 of 1 failures (1 empty prediction); shapes are shares of the other 0',
    ]);
    expect(only({ unknownQuestion: 0, emptyPrediction: 0, goldFailed: 1 })).toEqual([
      'a: dropped 1 of 1 failures (1 gold statement failed); shapes are shares of the other 0',
    ]);
  });
});
