#!/usr/bin/env node
/**
 * External-benchmark floor guard (BIRD1).
 *
 * The benchmark is the only place where a claim about accuracy can be checked, so
 * a run that quietly gets worse has to fail the build rather than become a line in
 * a report nobody reads. The floor is per arm, taken from the recent minimum, with
 * the noise threshold from ADR-166 as tolerance — a gate tighter than the
 * measurement would fail on sampling alone.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

export function compare(report, baseline) {
  const issues = [];
  const scored = report?.selection?.scored;
  if (typeof scored !== 'number') {
    issues.push('BIRD1: the report has no selection.scored, so the sample size is unknown');
    return issues;
  }
  // A smaller sample is a different measurement, not a worse model: comparing the
  // two would attribute a dataset change to the pipeline.
  if (scored < Math.floor(baseline.scored * 0.95)) {
    issues.push(`BIRD1: scored ${scored} questions against a baseline of ${baseline.scored}; the sample changed`);
  }
  const byArm = new Map((report.arms ?? []).map((arm) => [arm.arm, arm]));
  const tolerance = baseline.tolerancePp;
  for (const [name, floor] of Object.entries(baseline.arms)) {
    const arm = byArm.get(name);
    if (arm === undefined) {
      issues.push(`BIRD1: arm ${name} is in the baseline and missing from the report`);
      continue;
    }
    const measured = (arm.passed / arm.total) * 100;
    if (measured < floor - tolerance) {
      issues.push(`BIRD1: ${name} at ${measured.toFixed(1)}% is below the ${floor}% floor less ${tolerance}pp`);
    }
  }
  return issues;
}

function selfTest() {
  const issues = [];
  const baseline = { scored: 100, tolerancePp: 4, arms: { names: 40, inline: 50 } };
  const arm = (name, passed, total = 100) => ({ arm: name, passed, total });
  const report = (arms, scored = 100) => ({ selection: { scored }, arms });

  const good = compare(report([arm('names', 42), arm('inline', 47)]), baseline);
  if (good.length !== 0) issues.push('BIRD1 has no self-test: a passing run was rejected');

  const noisy = compare(report([arm('names', 37), arm('inline', 47)]), baseline);
  if (noisy.length !== 0) issues.push('BIRD1 fails a run inside the noise threshold, which is not a regression');

  const regressed = compare(report([arm('names', 30), arm('inline', 52)]), baseline);
  if (regressed.length !== 1) issues.push('BIRD1 does not catch an arm 10pp below its floor');

  const missing = compare(report([arm('names', 42)]), baseline);
  if (missing.length !== 1) issues.push('BIRD1 does not notice a baseline arm that vanished');

  const shrunk = compare(report([arm('names', 42), arm('inline', 51)], 60), baseline);
  if (shrunk.length !== 1) issues.push('BIRD1 does not notice the sample shrinking');

  const empty = compare({ arms: [] }, baseline);
  if (empty.length !== 1) issues.push('BIRD1 does not reject a report with no sample size');
  return issues;
}

if (process.argv[2] === '--self-test') {
  const issues = selfTest();
  for (const issue of issues) console.error(issue);
  if (issues.length > 0) process.exit(1);
  console.log('BIRD floor self-test: pass, noise, regression, missing arm and shrunken sample all behave');
} else {
  const reportPath = resolve(ROOT, 'eval/out/bird-eval.json');
  const baseline = JSON.parse(readFileSync(resolve(ROOT, 'eval/baseline/bird.json'), 'utf8'));
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    console.error('BIRD1: eval/out/bird-eval.json is missing; run bench:bird before comparing');
    process.exit(1);
  }
  const issues = compare(report, baseline);
  for (const issue of issues) console.error(issue);
  if (issues.length > 0) process.exit(1);
  const arms = report.arms.map((arm) => `${arm.arm} ${((arm.passed / arm.total) * 100).toFixed(1)}%`).join(', ');
  console.log(`BIRD floor: ${report.selection.scored} questions, ${arms}`);
}
