#!/usr/bin/env node
/**
 * Per-package coverage gate. The global vitest threshold can hide a package that is barely
 * tested but small; this gate aggregates each package on its own and requires 95% on all four
 * dimensions.
 *
 * Two rounds were spent misreading this gate's output, and the fix is in the message rather
 * than in the threshold. `FAIL node st=85.83 br=87.50` was read as "coverage fell" twice; it
 * meant "PostgreSQL and MariaDB were not running on this machine", because
 * `packages/node/test/mysql.test.ts` and `postgres.test.ts` are `describe.skipIf(url === undefined)`
 * and a skipped suite subtracts its lines from the numerator without touching the denominator.
 * With the services up the same tree measures 99.18 / 97.13 / 100 / 99.18 — the gate was
 * measuring the environment and reporting it as coverage.
 *
 * A gate cannot tell those apart from the summary alone, so it says which files are short and,
 * where it knows the suite is gated on a variable, whether that variable was set. `ENV_GATED`
 * is that knowledge, kept as data and pinned by `--self-test`: if either file is renamed the
 * self-test fails rather than letting the hint rot into a lie.
 *
 * Usage: node tools/coverage-gate.mjs [--self-test]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIMENSIONS = ['statements', 'branches', 'functions', 'lines'];

/**
 * Files whose test suite only runs when a service is reachable.
 *
 * The value is the variable the suite reads. A file listed here that no longer exists makes
 * the self-test red, which is the only thing keeping this table from describing a tree that
 * moved on.
 */
export const ENV_GATED = {
  'packages/node/src/mysql.ts': 'MYSQL_TEST_URL',
  'packages/node/src/postgres.ts': 'PG_TEST_URL',
};

/** How many offenders to name before summarising the rest. */
const OFFENDER_LIMIT = 8;

const percentOf = (metric) => (metric.total === 0 ? null : (metric.covered / metric.total) * 100);

/**
 * One number per package per dimension, summed from its files.
 *
 * The dimension totals are summed rather than averaged so a 400-line file cannot weigh the
 * same as a 4-line one — an average of ratios is a number about files, not about code.
 */
export function packageBuckets(summary) {
  const byPackage = new Map();
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === 'total') continue;
    const match = /packages\/([^/]+)\//.exec(file);
    if (match === null) continue;
    const pkg = match[1];
    const bucket = byPackage.get(pkg) ?? Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, { covered: 0, total: 0 }]));
    for (const dimension of DIMENSIONS) {
      bucket[dimension].covered += metrics[dimension].covered;
      bucket[dimension].total += metrics[dimension].total;
    }
    byPackage.set(pkg, bucket);
  }
  return byPackage;
}

/** Files of one package that miss the threshold, worst first, with the dimension that misses it. */
export function offenders(summary, pkg, threshold) {
  const rows = [];
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === 'total' || !file.includes(`packages/${pkg}/`)) continue;
    const numbers = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, percentOf(metrics[dimension])]));
    const short = DIMENSIONS.map((dimension) => numbers[dimension]).filter((value) => value !== null && value < threshold);
    if (short.length === 0) continue;
    rows.push({ file: file.slice(file.indexOf(`packages/${pkg}/`)), numbers, worst: Math.min(...short) });
  }
  return rows.sort((left, right) => left.worst - right.worst);
}

const cellsOf = (bucket) =>
  DIMENSIONS.map((dimension) => {
    const pct = percentOf(bucket[dimension]);
    return `${dimension.slice(0, 2)}=${pct === null ? 'n/a' : pct.toFixed(2)}`;
  });

/**
 * Evaluate a summary and return what to print.
 *
 * `fileExists` and `env` are parameters so the whole decision is a function of its inputs: the
 * self-test drives a tree where the gated file exists and the variable is unset, which is the
 * combination that produced two rounds of misdiagnosis.
 */
export function gate({ summary, threshold = 95, env = {}, fileExists = (path) => existsSync(join(ROOT, path)) }) {
  const byPackage = packageBuckets(summary);
  const lines = [];
  const problems = [];
  if (byPackage.size === 0) {
    return { lines, problems: ['coverage gate: no package coverage found; run pnpm test:coverage first'], failed: true };
  }
  let failed = false;
  const gatedShort = [];
  for (const [pkg, bucket] of [...byPackage.entries()].sort()) {
    const missing = DIMENSIONS.filter((dimension) => bucket[dimension].total === 0);
    // A dimension with no measurable code is not 100% — it is unmeasured, which is a different
    // claim and one this gate must not pass (ADR-217 at the package level).
    const short = DIMENSIONS.filter((dimension) => {
      const pct = percentOf(bucket[dimension]);
      return pct !== null && pct < threshold;
    });
    if (short.length > 0 || missing.length > 0) failed = true;
    lines.push(`${short.length === 0 && missing.length === 0 ? 'PASS' : 'FAIL'} ${pkg.padEnd(8)} ${cellsOf(bucket).join(' ')}`);
    if (missing.length > 0) {
      problems.push(`coverage gate: ${pkg} has no measurable ${missing.join(', ')} at all, which is unmeasured rather than perfect`);
    }
    if (short.length === 0) continue;
    const worst = offenders(summary, pkg, threshold);
    for (const row of worst.slice(0, OFFENDER_LIMIT)) {
      const numbers = DIMENSIONS.map((dimension) => `${dimension.slice(0, 2)}=${row.numbers[dimension] === null ? 'n/a' : row.numbers[dimension].toFixed(2)}`);
      lines.push(`  short: ${row.file} ${numbers.join(' ')}`);
    }
    if (worst.length > OFFENDER_LIMIT) lines.push(`  short: … and ${String(worst.length - OFFENDER_LIMIT)} more files in ${pkg}`);
    for (const row of worst) {
      const variable = ENV_GATED[row.file];
      if (variable === undefined || env[variable] !== undefined) continue;
      gatedShort.push(row.file);
      lines.push(
        `  note: ${row.file} is measured by a suite gated on ${variable}, which is unset — every check in it was skipped, so this number describes a partial run rather than untested code`,
      );
      if (!fileExists(row.file)) problems.push(`coverage gate: the gate describes ${row.file} as gated on ${variable}, and that file does not exist`);
    }
  }
  if (failed) {
    problems.push(`coverage gate: every dimension of every package must be >= ${String(threshold)}%`);
    // The sentence that would have saved both rounds: a skipped suite and missing tests are the
    // same shape in a coverage summary, so the only way to tell them apart is the variable.
    if (gatedShort.length > 0) {
      problems.push(
        `coverage gate: ${String(gatedShort.length)} short file(s) belong to suites gated on an unset variable; start those services, or accept that this run measured part of the tree`,
      );
    } else {
      problems.push('coverage gate: no short file belongs to an environment-gated suite, so this is missing tests rather than a skipped suite');
    }
  }
  return { lines, problems, failed };
}

/**
 * The gate's own test: a passing tree, a failing one that must name the offender, an
 * environment-gated failure that must name the variable, an unmeasured package, and a tree
 * with no package coverage at all.
 */
export function selfTest() {
  const issues = [];
  const file = (covered, total) => ({ statements: { covered, total }, branches: { covered, total }, functions: { covered, total }, lines: { covered, total } });
  const summary = (entries) => Object.fromEntries(entries);
  const expect = (condition, why) => {
    if (!condition) issues.push(why);
  };

  // A passing tree prints one PASS line per package and no problems.
  const passing = gate({ summary: summary([['/r/packages/core/src/a.ts', file(100, 100)]]) });
  expect(passing.failed === false, 'the gate failed a tree where every dimension is 100%');
  expect(passing.lines.length === 1 && passing.lines[0].startsWith('PASS core'), 'a passing package did not print PASS with its name');
  expect(passing.problems.length === 0, 'a passing tree produced a problem line');

  // A failing tree names the file, not only the package: that omission is what cost two rounds.
  const failing = gate({ summary: summary([['/r/packages/node/src/cache.ts', file(70, 100)], ['/r/packages/node/src/connectors.ts', file(100, 100)]]) });
  expect(failing.failed === true, 'the gate passed a package at 70%');
  expect(failing.lines.some((line) => line.includes('short: packages/node/src/cache.ts')), 'a failing package did not name the file that is short');
  expect(!failing.lines.some((line) => line.includes('connectors.ts')), 'a failing package named a file that meets the bar');
  expect(failing.problems.some((line) => line.includes('must be >= 95%')), 'the gate did not say what the bar is');
  expect(failing.problems.some((line) => line.includes('missing tests rather than a skipped suite')), 'a short file with no gated suite did not say which of the two causes it is');

  // The misdiagnosis itself: a gated file, an unset variable, and a hint naming it.
  const gated = gate({
    summary: summary([['/r/packages/node/src/postgres.ts', file(70, 100)]]),
    env: {},
    fileExists: () => true,
  });
  expect(gated.lines.some((line) => line.includes('gated on PG_TEST_URL, which is unset')), 'an unset variable behind a short file was not named');
  expect(gated.problems.some((line) => line.includes('suites gated on an unset variable')), 'the gate did not say a skipped suite can look like missing tests');

  // ...and with the variable set, the same tree is a coverage problem, stated as one.
  const started = gate({ summary: summary([['/r/packages/node/src/postgres.ts', file(70, 100)]]), env: { PG_TEST_URL: 'postgres://x' }, fileExists: () => true });
  expect(!started.lines.some((line) => line.includes('which is unset')), 'the gate blamed an unset variable that was set');
  expect(started.problems.some((line) => line.includes('missing tests rather than a skipped suite')), 'a real coverage gap with the service running was not called one');

  // A gated file that no longer exists makes the hint a lie, and the self-test is what notices.
  const renamed = gate({ summary: summary([['/r/packages/node/src/postgres.ts', file(70, 100)]]), env: {}, fileExists: () => false });
  expect(renamed.problems.some((line) => line.includes('that file does not exist')), 'the gate trusted a gated-file entry whose file is gone');
  for (const path of Object.keys(ENV_GATED)) expect(existsSync(join(ROOT, path)), `the gate names ${path} as environment-gated and it does not exist`);

  // Zero denominator is unmeasured, not 100%.
  const empty = gate({ summary: summary([['/r/packages/spec/src/types.ts', file(0, 0)]]) });
  expect(empty.failed === true, 'the gate called a package with no measurable code perfect');
  expect(empty.lines[0].includes('st=n/a'), 'an unmeasured dimension did not print n/a');
  expect(empty.problems.some((line) => line.includes('unmeasured rather than perfect')), 'the gate did not say a zero denominator is unmeasured');

  // No package coverage at all is refused rather than read as a pass.
  const nothing = gate({ summary: summary([['/r/other/a.ts', file(100, 100)]]) });
  expect(nothing.failed === true && nothing.problems[0].includes('no package coverage found'), 'an empty summary did not refuse to pass');

  // The offender list is ordered by the worst dimension and capped with a count.
  const many = summary(Array.from({ length: OFFENDER_LIMIT + 2 }, (_, index) => [`/r/packages/ai/src/f${String(index)}.ts`, file(50 + index, 100)]));
  const capped = gate({ summary: many });
  const shortLines = capped.lines.filter((line) => line.trim().startsWith('short:'));
  expect(shortLines.length === OFFENDER_LIMIT + 1, 'the offender list was not capped with a remainder line');
  expect(shortLines[0].includes('f0.ts'), 'the offender list did not start with the worst file');
  expect(shortLines[OFFENDER_LIMIT].includes('and 2 more files in ai'), 'the remainder line did not count the files it hid');
  return issues;
}

if (process.argv[2] === '--self-test') {
  const issues = selfTest();
  for (const issue of issues) console.error(issue);
  if (issues.length > 0) process.exit(1);
  console.log('coverage gate self-test: a passing tree, a failing one that names the short file, an environment-gated failure that names its variable, the same failure with the service running, a renamed gated file, an unmeasured package, an empty summary and a capped offender list all behave');
} else {
  const summary = JSON.parse(readFileSync(join(ROOT, 'coverage/coverage-summary.json'), 'utf8'));
  const outcome = gate({ summary, threshold: Number(process.env.COVERAGE_THRESHOLD ?? 95), env: process.env });
  for (const line of outcome.lines) console.log(line);
  for (const problem of outcome.problems) console.error(problem);
  if (outcome.failed) process.exit(1);
  console.log(`coverage gate: ${String(packageBuckets(summary).size)} packages, all dimensions >= ${String(Number(process.env.COVERAGE_THRESHOLD ?? 95))}%`);
}
