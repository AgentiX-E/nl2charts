#!/usr/bin/env node
/**
 * The eval coverage ratchet.
 *
 * The main gate measures `packages/<name>/src` and says so. `eval/` — the harness every
 * published number comes out of — sat outside it in silence until ADR-213 drew the boundary,
 * and its honest number that day was 49.5% of lines. Drawing the boundary is not the same as
 * moving the number, and a directive that says "every dimension at 95%" needs something that
 * notices the distance closing.
 *
 * That something cannot be a threshold: `eval/` at 64% would make a 95% threshold red for
 * months, which is how thresholds become `|| true`. So this gate enforces the *direction*
 * instead: every file's four numbers are recorded in `eval/coverage-ledger.json`, and a run
 * that measures any of them lower than the ledger fails. Progress is an edit to that file;
 * a regression is a red build. The ledger also carries the target, so the distance to it is
 * a subtraction rather than an opinion.
 *
 * A ratchet's floor is wherever the last commit left it, so it can never say "the group is good
 * enough". Once every dimension of `eval/` reached the standard, that half became a gate too:
 * a dimension of the group below `target` fails the build (`groupProblems`), and a run that
 * covered nothing at all is refused rather than read as a group ratio (ADR-217).
 *
 *   node tools/check-eval-coverage.mjs             # measure, compare, report
 *   node tools/check-eval-coverage.mjs --update    # record this run (raises only)
 *   node tools/check-eval-coverage.mjs --from coverage-eval/coverage-summary.json
 *   node tools/check-eval-coverage.mjs --self-test
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const LEDGER = join(ROOT, 'eval/coverage-ledger.json');
const SUMMARY = join(ROOT, 'coverage-eval/coverage-summary.json');
const DIMENSIONS = ['lines', 'statements', 'functions', 'branches'];
const TARGET = 95;
/** v8 percentages move by a tenth of a point between runs on unrelated test changes. */
const TOLERANCE_PP = 0.2;

/** `/abs/path/eval/bird/run.ts` → `eval/bird/run.ts`. */
export function relativeToRoot(file) {
  const index = file.indexOf('/eval/');
  return index === -1 ? file : file.slice(index + 1);
}

/**
 * Did anything in this file execute?
 *
 * v8 reports a branch and a function ratio of 100% for a module it never entered, because
 * the denominator is zero and 0/0 is rendered as perfection. That is how
 * `eval/adversarial/run.ts` came to have `lines 0.0` and `branches 100.0` recorded in the
 * same row: the ledger was promising a number the file had never been asked for, and the
 * first honest measurement of it read as a regression. A file that executed no line has
 * measured nothing, and the ledger says so in all four dimensions.
 */
export function executed(metrics) {
  const lines = metrics?.lines ?? {};
  if (typeof lines.covered === 'number') return lines.covered > 0;
  return (lines.pct ?? 0) > 0;
}

export function buildLedger(summary, options = {}) {
  const files = {};
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === 'total') continue;
    const name = relativeToRoot(file);
    files[name] = executed(metrics)
      ? Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, round(metrics[dimension].pct)]))
      : { ...Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 0])), unmeasured: true };
  }
  const totals = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, round(summary.total[dimension].pct)]));
  return {
    note:
      'Per-file eval coverage. Enforced by tools/check-eval-coverage.mjs: a number may rise freely and may only fall ' +
      'with an explicit, reviewed edit. `target` is the standard every file must reach before eval/ joins the main gate.',
    target: TARGET,
    tolerancePp: TOLERANCE_PP,
    measuredAt: options.now ?? new Date().toISOString().slice(0, 10),
    totals,
    files,
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * A record that cannot describe a measurement.
 *
 * A file with `lines: 0` executed nothing, so its functions and branches ratios came from a
 * zero denominator rather than from the file. The ledger carried two such rows — recorded as
 * `branches: 100` beside `lines: 0` — and the first real measurement of those files read as a
 * regression from a promise nobody had made. A record like that is replaced, not defended.
 */
export function unmeasuredRecord(entry) {
  return entry === undefined || entry.unmeasured === true || (entry.lines ?? 0) === 0;
}

/**
 * Raise-only merge: the ledger records the best number each file has ever produced.
 *
 * A drop is never silent. Passing `--allow-regression` with a reason is the only way to
 * record one, and the reason is written into the ledger so the next reader can weigh it.
 * The one exception is a record with no measurement behind it: it is replaced by the first
 * one that has.
 */
export function mergeLedger(previous, next) {
  const files = {};
  const drops = [];
  const names = new Set([...Object.keys(previous.files ?? {}), ...Object.keys(next.files)]);
  for (const name of [...names].sort()) {
    const before = previous.files?.[name];
    const after = next.files[name];
    if (before === undefined || after === undefined) {
      const present = before ?? after;
      if (present !== undefined) files[name] = present;
      continue;
    }
    if (unmeasuredRecord(before)) {
      files[name] = after;
      continue;
    }
    const merged = {};
    for (const dimension of DIMENSIONS) {
      // The same tolerance the comparison uses. It was strict here, so a hundredth of a point
      // of jitter — the difference between 98.97% and 98.96% of sixty-odd lines — refused to
      // record a run at all, while `compare` would have called the same move noise.
      if (after[dimension] < before[dimension] - TOLERANCE_PP) {
        drops.push({ file: name, dimension, before: before[dimension], after: after[dimension] });
      }
      merged[dimension] = Math.max(before[dimension], after[dimension]);
    }
    files[name] = merged;
  }
  const totals = {};
  for (const dimension of DIMENSIONS) {
    const before = previous.totals?.[dimension];
    const after = next.totals[dimension];
    totals[dimension] = before === undefined ? after : Math.max(before, after);
  }
  return { ledger: { ...next, files, totals }, drops };
}

/** Every way the current measurement fails to keep the ledger's promises. */
export function compare(ledger, summary) {
  const problems = [];
  const measured = new Set();
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === 'total') continue;
    const name = relativeToRoot(file);
    measured.add(name);
    const recorded = ledger.files?.[name];
    if (recorded === undefined) {
      problems.push(`${name} was measured but is not in the ledger; run --update to record it`);
      continue;
    }
    for (const dimension of DIMENSIONS) {
      const now = metrics[dimension].pct;
      const was = recorded[dimension];
      if (now < was - TOLERANCE_PP) {
        problems.push(`${name} ${dimension} fell from ${was.toFixed(2)}% to ${now.toFixed(2)}%`);
      }
    }
  }
  for (const name of Object.keys(ledger.files ?? {})) {
    if (!measured.has(name)) problems.push(`${name} is in the ledger but was not measured; a file that stopped being counted is not progress`);
  }
  return problems;
}

/** Files that already meet the standard on all four dimensions, and those that do not. */
export function standing(summary) {
  const done = [];
  const short = [];
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === 'total') continue;
    const meets = DIMENSIONS.every((dimension) => metrics[dimension].pct >= TARGET);
    (meets ? done : short).push(relativeToRoot(file));
  }
  return { done: done.sort(), short: short.sort() };
}

/**
 * The group standard, as a gate rather than a sentence.
 *
 * The per-file ratchet answers "did anything get worse". It cannot answer "is the group good
 * enough", because a ratchet's floor is wherever the last commit left it: `eval/` was 49.5% of
 * lines when the ratchet was written and every one of its rows was honest, which is why the
 * ratchet alone would have kept that number forever. The target therefore needs a second,
 * harder reader — one that fails the build while a dimension of the group is below the standard,
 * and that refuses to read a ratio whose denominator is zero (ADR-217).
 *
 * The zero-denominator check only fires when a denominator is actually reported. A fixture, or
 * a summary written by another tool, may omit `covered`; absent is not the same as zero.
 */
export function groupProblems(total) {
  const problems = [];
  const covered = total?.lines?.covered;
  if (typeof covered === 'number' && covered === 0) {
    return ['the run covered no line at all; a group ratio over a zero denominator is not a measurement'];
  }
  for (const dimension of DIMENSIONS) {
    const pct = total?.[dimension]?.pct ?? 0;
    if (pct < TARGET) {
      problems.push(`eval/ ${dimension} is ${pct.toFixed(2)}%, below the ${String(TARGET)}% the group must hold`);
    }
  }
  return problems;
}

function readSummary(path) {
  if (!existsSync(path)) {
    console.error(`eval coverage: no summary at ${path}; run the measurement first`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function measure() {
  execFileSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.eval.config.ts', '--coverage', '--reporter=dot'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function report(summary, ledger) {
  const totals = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, summary.total[dimension].pct]));
  const rows = Object.entries(summary)
    .filter(([file]) => file !== 'total')
    .map(([file, metrics]) => ({ name: relativeToRoot(file), metrics }));
  const short = rows.filter((row) => !DIMENSIONS.every((dimension) => row.metrics[dimension].pct >= TARGET));
  console.log(
    `eval coverage: ${totals.lines.toFixed(2)}% lines, ${totals.statements.toFixed(2)}% statements, ` +
      `${totals.functions.toFixed(2)}% functions, ${totals.branches.toFixed(2)}% branches`,
  );
  console.log(
    `eval coverage: ${String(rows.length - short.length)} of ${String(rows.length)} files meet ${String(TARGET)}% on all four dimensions`,
  );
  for (const row of short.sort((left, right) => left.name.localeCompare(right.name))) {
    const cell = DIMENSIONS.map((dimension) => `${dimension.slice(0, 2)}=${row.metrics[dimension].pct.toFixed(1)}`).join(' ');
    const recorded = ledger.files?.[row.name];
    const was = recorded === undefined ? 'new' : DIMENSIONS.map((dimension) => recorded[dimension].toFixed(1)).join(' ');
    console.log(`  SHORT ${row.name.padEnd(32)} ${cell}   ledger ${was}`);
  }
  for (const dimension of DIMENSIONS) {
    const gap = TARGET - totals[dimension];
    console.log(`  ${dimension.padEnd(10)} ${gap <= 0 ? 'at target' : `${gap.toFixed(2)}pp short of ${String(TARGET)}%`}`);
  }
}

function selfTest() {
  const issues = [];
  let checks = 0;
  const fail = (condition, message) => {
    checks += 1;
    if (!condition) issues.push(message);
  };
  // `covered` is part of the fixture because it is part of the question: a file at 0% has
  // no measurement behind its ratios, and the ledger has to be able to tell that apart from
  // a file at 100%.
  const summary = (files) => ({
    total: { lines: { pct: 90 }, statements: { pct: 90 }, functions: { pct: 90 }, branches: { pct: 90 } },
    ...Object.fromEntries(
      Object.entries(files).map(([name, pct]) => [
        `/repo/eval/${name}`,
        Object.fromEntries(
          DIMENSIONS.map((dimension) => [
            dimension,
            { pct, covered: pct > 0 ? 1 : 0, total: 1 },
          ]),
        ),
      ]),
    ),
  });
  const ledger = buildLedger(summary({ 'a.ts': 90, 'b.ts': 50 }), { now: '2026-01-01' });
  fail(Object.keys(ledger.files).sort().join(',') === 'eval/a.ts,eval/b.ts', 'the ledger does not key files relative to the repository');

  // Steady: the same measurement twice is not a regression.
  fail(compare(ledger, summary({ 'a.ts': 90, 'b.ts': 50 })).length === 0, 'an unchanged run is reported as a regression');
  // Smaller tolerance: a tenth of a point is noise, a whole point is not.
  fail(compare(ledger, summary({ 'a.ts': 89.9, 'b.ts': 50 })).length === 0, 'noise inside the tolerance is reported');
  // The fixture gives a file the same value in all four dimensions, so a drop is four problems.
  fail(compare(ledger, summary({ 'a.ts': 89, 'b.ts': 50 })).length === DIMENSIONS.length, 'a one-point drop is not reported');
  // Direction: better is always allowed.
  fail(compare(ledger, summary({ 'a.ts': 99, 'b.ts': 50 })).length === 0, 'an improvement is reported as a problem');
  // A vanished file is not progress, and an unrecorded one is not allowed.
  fail(
    compare(ledger, summary({ 'a.ts': 90 })).some((problem) => problem.includes('was not measured')),
    'a file that disappeared from the measurement is accepted',
  );
  fail(
    compare(ledger, summary({ 'a.ts': 90, 'b.ts': 50, 'c.ts': 40 })).some((problem) => problem.includes('not in the ledger')),
    'a newly measured file is accepted without a ledger entry',
  );
  // Raise-only merge: the ledger keeps the best number, and a drop is named.
  const { ledger: merged, drops } = mergeLedger(ledger, buildLedger(summary({ 'a.ts': 80, 'b.ts': 60 }), { now: '2026-02-01' }));
  fail(merged.files['eval/a.ts']?.lines === 90, 'the merge lowered a number instead of keeping the maximum');
  fail(merged.files['eval/b.ts']?.lines === 60, 'the merge did not raise a number');
  fail(
    drops.length === DIMENSIONS.length && drops.every((drop) => drop.file === 'eval/a.ts'),
    'the merge did not name the files and dimensions it absorbed',
  );
  // An unexecuted file measured nothing: v8 reports 100% functions and branches for a module
  // it never entered, and the ledger must not promise those numbers.
  const hollow = buildLedger({
    total: { lines: { pct: 0 }, statements: { pct: 0 }, functions: { pct: 0 }, branches: { pct: 0 } },
    '/repo/eval/never.ts': {
      lines: { pct: 0, covered: 0, total: 40 },
      statements: { pct: 0, covered: 0, total: 40 },
      functions: { pct: 100, covered: 0, total: 0 },
      branches: { pct: 100, covered: 0, total: 0 },
    },
  });
  const never = hollow.files['eval/never.ts'];
  fail(
    DIMENSIONS.every((dimension) => never?.[dimension] === 0),
    'a file that executed nothing was recorded with ratios it never measured',
  );
  fail(never?.unmeasured === true, 'an unmeasured file is not marked as such');
  // A legacy record with `lines: 0` beside `branches: 100` is replaced by the first real
  // measurement, not defended as a regression.
  const legacy = { files: { 'eval/never.ts': { lines: 0, statements: 0, functions: 100, branches: 100 } }, totals: {} };
  const corrected = mergeLedger(legacy, buildLedger(summary({ 'never.ts': 90 }), { now: '2026-03-01' }));
  fail(corrected.ledger.files['eval/never.ts']?.branches === 90, 'an impossible ledger record was kept instead of replaced');
  fail(corrected.drops.length === 0, 'replacing an unmeasured record was reported as a regression');

  // Noise inside the tolerance is absorbed by the merge as well as by the comparison: a
  // recorder that refuses to write a run because a ratio moved by a hundredth of a point is a
  // recorder that stops recording.
  const jitter = mergeLedger(ledger, buildLedger(summary({ 'a.ts': 89.9, 'b.ts': 50 }), { now: '2026-02-02' }));
  fail(jitter.drops.length === 0, 'a drop inside the tolerance was reported as a regression by the merge');

  // Standing: the target is per file and all four dimensions.
  const standingResult = standing(summary({ 'a.ts': 96, 'b.ts': 94 }));
  fail(standingResult.done.join(',') === 'eval/a.ts', 'the standing list does not separate files that meet the target');
  fail(standingResult.short.join(',') === 'eval/b.ts', 'the standing list does not name the file below the target');
  // The relative path helper is what makes the ledger portable between machines.
  fail(relativeToRoot('/home/user/repo/eval/bird/run.ts') === 'eval/bird/run.ts', 'the relative path helper failed');

  // The group floor. A ratchet cannot say "the group is good enough" — its floor is wherever the
  // last commit left it — so the standard is a second, harder reader over the totals.
  const group = (pcts) =>
    Object.fromEntries(DIMENSIONS.map((dimension, index) => [dimension, { pct: pcts[index], covered: 100, total: 100 }]));
  fail(groupProblems(group([95, 95, 95, 95])).length === 0, 'a group exactly at the standard is reported as short');
  fail(
    groupProblems(group([99, 99, 100, 94.9])).length === 1 && groupProblems(group([99, 99, 100, 94.9]))[0].includes('branches'),
    'a group one tenth of a point below the standard on branches is not reported, or not named',
  );
  fail(groupProblems(group([90, 99, 100, 99])).length === 1, 'a group short on lines is not reported exactly once');
  fail(
    groupProblems({ lines: { covered: 0, total: 40, pct: 0 }, statements: { pct: 100 }, functions: { pct: 100 }, branches: { pct: 100 } }).some(
      (problem) => problem.includes('zero denominator'),
    ),
    'a run that covered nothing is read as a group ratio instead of refused',
  );
  // A summary that omits `covered` is not a summary that covered nothing.
  fail(
    groupProblems(Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, { pct: 99 }]))).length === 0,
    'an unreported denominator is treated as a zero denominator',
  );

  if (issues.length > 0) {
    for (const issue of issues) console.error(`SELF-TEST FAILED: ${issue}`);
    process.exit(1);
  }
  console.log(`eval coverage self-test: ${String(checks)} checks, all hold`);
}

function main(argv) {
  if (argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const fromIndex = argv.indexOf('--from');
  if (fromIndex === -1) measure();
  const summary = readSummary(fromIndex === -1 ? SUMMARY : resolve(argv[fromIndex + 1] ?? ''));
  const previous = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { files: {} };

  if (argv.includes('--update')) {
    const { ledger, drops } = mergeLedger(previous, buildLedger(summary));
    const allowIndex = argv.indexOf('--allow-regression');
    const reason = allowIndex === -1 ? undefined : argv[allowIndex + 1];
    if (drops.length > 0 && reason === undefined) {
      for (const drop of drops) console.error(`REFUSED: ${drop.file} ${drop.dimension} ${drop.before}% -> ${drop.after}% needs --allow-regression <reason>`);
      process.exit(1);
    }
    const record = reason === undefined ? ledger : { ...ledger, regressions: [...(previous.regressions ?? []), { at: ledger.measuredAt, reason, drops }] };
    writeFileSync(LEDGER, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`eval coverage: ledger updated for ${String(Object.keys(record.files).length)} files${drops.length === 0 ? '' : ` (${String(drops.length)} regression(s) recorded)`}`);
    return;
  }

  report(summary, previous);
  // The group floor is checked as well as the per-file ratchet. It is the reader that fails a
  // build for a dimension the group as a whole has not reached; the ratchet only fails a move
  // backwards from wherever the last commit left things.
  const belowStandard = groupProblems(summary.total);
  const problems = [...belowStandard, ...compare(previous, summary)];
  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAILED: ${problem}`);
    // Two different failures, two different sentences: a group below the standard is fixed by
    // writing coverage, and `--allow-regression` cannot record its way out of it.
    if (belowStandard.length > 0) {
      console.error(`eval coverage: a dimension of the group is below the ${String(TARGET)}% standard, which the ledger cannot record away`);
    }
    console.error('eval coverage: the measurement fell below the ledger; either fix the coverage or record the regression with --update --allow-regression <reason>');
    process.exit(1);
  }
  console.log('eval coverage: no file fell below its recorded coverage, and every dimension is at target');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2));
}
