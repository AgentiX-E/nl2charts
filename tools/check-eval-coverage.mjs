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
 * That something cannot be a threshold: `eval/` is at 64%, and a 95% threshold would be red
 * for months, which is how thresholds become `|| true`. So this gate enforces the *direction*
 * instead: every file's four numbers are recorded in `eval/coverage-ledger.json`, and a run
 * that measures any of them lower than the ledger fails. Progress is an edit to that file;
 * a regression is a red build. The ledger also carries the target, so the distance to it is
 * a subtraction rather than an opinion.
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

export function buildLedger(summary, options = {}) {
  const files = {};
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === 'total') continue;
    files[relativeToRoot(file)] = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, round(metrics[dimension].pct)]));
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
 * Raise-only merge: the ledger records the best number each file has ever produced.
 *
 * A drop is never silent. Passing `--allow-regression` with a reason is the only way to
 * record one, and the reason is written into the ledger so the next reader can weigh it.
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
    const merged = {};
    for (const dimension of DIMENSIONS) {
      if (after[dimension] < before[dimension]) drops.push({ file: name, dimension, before: before[dimension], after: after[dimension] });
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
  const summary = (files) => ({
    total: { lines: { pct: 90 }, statements: { pct: 90 }, functions: { pct: 90 }, branches: { pct: 90 } },
    ...Object.fromEntries(
      Object.entries(files).map(([name, pct]) => [
        `/repo/eval/${name}`,
        Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, { pct }])),
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
  // Standing: the target is per file and all four dimensions.
  const standingResult = standing(summary({ 'a.ts': 96, 'b.ts': 94 }));
  fail(standingResult.done.join(',') === 'eval/a.ts', 'the standing list does not separate files that meet the target');
  fail(standingResult.short.join(',') === 'eval/b.ts', 'the standing list does not name the file below the target');
  // The relative path helper is what makes the ledger portable between machines.
  fail(relativeToRoot('/home/user/repo/eval/bird/run.ts') === 'eval/bird/run.ts', 'the relative path helper failed');

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
  const problems = compare(previous, summary);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAILED: ${problem}`);
    console.error('eval coverage: the measurement fell below the ledger; either fix the coverage or record the regression with --update --allow-regression <reason>');
    process.exit(1);
  }
  console.log('eval coverage: no file fell below its recorded coverage');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2));
}
