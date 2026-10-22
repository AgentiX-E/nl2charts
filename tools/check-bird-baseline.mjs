#!/usr/bin/env node
/**
 * External-benchmark floor guard (BIRD1).
 *
 * The benchmark is the only place where a claim about accuracy can be checked, so
 * a run that quietly gets worse has to fail the build rather than become a line in
 * a report nobody reads. The floor is per arm, taken from the recent minimum, with
 * the noise threshold from ADR-166 as tolerance — a gate tighter than the
 * measurement would fail on sampling alone.
 *
 * Two things this file learned the hard way:
 *
 * - Floors belong to a split. A floor derived on Mini-Dev is not a claim about the
 *   1,534-question dev split, so a split with no recorded floors reports itself as
 *   a measurement rather than pretending to be a gate.
 * - The expected arm list is part of the baseline. `inline+retrieval` was added to
 *   the catalogue, wired into the prompt and never executed, because the default
 *   chain was a second list nothing compared against this file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

/**
 * @returns {{issues: string[], notes: string[]}} issues fail the run, notes are
 * printed so a skipped check is visible rather than silent.
 */
export function compare(report, baseline) {
  const issues = [];
  const notes = [];
  const scored = report?.selection?.scored;
  const split = report?.selection?.split ?? 'unknown';
  if (typeof scored !== 'number') {
    issues.push('BIRD1: the report has no selection.scored, so the sample size is unknown');
    return { issues, notes };
  }
  // A smaller sample is a different measurement, not a worse model: comparing the
  // two would attribute a dataset change to the pipeline.
  if (scored < Math.floor(baseline.scored * 0.95)) {
    issues.push(`BIRD1: scored ${scored} questions against a baseline of ${baseline.scored}; the sample changed`);
  }

  const byArm = new Map((report.arms ?? []).map((arm) => [arm.arm, arm]));
  for (const name of baseline.expectedArms) {
    if (!byArm.has(name)) {
      issues.push(`BIRD1: arm ${name} is expected by the baseline and missing from the report`);
    }
  }

  const floors = baseline.floors?.[split];
  if (floors === undefined) {
    notes.push(`BIRD1: no floors recorded for split ${split}; this run is a measurement, not a gate`);
    return { issues, notes };
  }
  const tolerance = baseline.tolerancePp;
  for (const [name, floor] of Object.entries(floors)) {
    const arm = byArm.get(name);
    if (arm === undefined) continue; // already reported as a missing expected arm
    const measured = (arm.passed / arm.total) * 100;
    if (measured < floor - tolerance) {
      issues.push(`BIRD1: ${name} at ${measured.toFixed(1)}% is below the ${floor}% floor less ${tolerance}pp`);
    }
  }
  for (const name of baseline.expectedArms) {
    if (floors[name] === undefined && byArm.has(name)) {
      notes.push(`BIRD1: ${name} has no floor yet; its first measurement is recorded, not enforced`);
    }
  }
  return { issues, notes };
}

function selfTest() {
  const issues = [];
  const baseline = {
    scored: 100,
    tolerancePp: 4,
    expectedArms: ['names', 'inline'],
    floors: { minidev: { names: 40, inline: 50 } },
  };
  const arm = (name, passed, total = 100) => ({ arm: name, passed, total });
  const report = (arms, scored = 100, split = 'minidev') => ({ selection: { scored, split }, arms });
  const fail = (result, count, why) => {
    if (result.issues.length !== count) issues.push(why);
  };

  fail(compare(report([arm('names', 42), arm('inline', 47)]), baseline), 0, 'BIRD1 has no self-test: a passing run was rejected');
  fail(compare(report([arm('names', 37), arm('inline', 47)]), baseline), 0, 'BIRD1 fails a run inside the noise threshold, which is not a regression');
  fail(compare(report([arm('names', 30), arm('inline', 52)]), baseline), 1, 'BIRD1 does not catch an arm 10pp below its floor');
  fail(compare(report([arm('names', 42)]), baseline), 1, 'BIRD1 does not notice an expected arm that vanished');
  fail(compare(report([arm('names', 42), arm('inline', 51)], 60), baseline), 1, 'BIRD1 does not notice the sample shrinking');

  const empty = compare({ arms: [] }, baseline);
  fail(empty, 1, 'BIRD1 does not reject a report with no sample size');

  // A different split is a different measurement: floors do not transfer, and the
  // gate says so instead of failing on a number it never derived.
  const otherSplit = compare(report([arm('names', 20), arm('inline', 20)], 1534, 'dev'), baseline);
  fail(otherSplit, 0, 'BIRD1 applies Mini-Dev floors to another split');
  if (otherSplit.notes.length !== 1) issues.push('BIRD1 does not say that a split without floors is a measurement');

  // An unfloored arm is measured but not enforced; silence here would look like a
  // passing gate for an arm nothing is checking.
  const pendingBaseline = { ...baseline, expectedArms: ['names', 'inline', 'newcomer'], floors: { minidev: { names: 40, inline: 50 } } };
  const pending = compare(report([arm('names', 42), arm('inline', 51), arm('newcomer', 99)]), pendingBaseline);
  fail(pending, 0, 'BIRD1 fails an arm that has no floor yet');
  if (pending.notes.length !== 1) issues.push('BIRD1 does not say that an unfloored arm is unenforced');
  return issues;
}

if (process.argv[2] === '--self-test') {
  const issues = selfTest();
  for (const issue of issues) console.error(issue);
  if (issues.length > 0) process.exit(1);
  console.log('BIRD floor self-test: pass, noise, regression, missing arm, shrunken sample, other split and unfloored arm all behave');
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
  const { issues, notes } = compare(report, baseline);
  for (const note of notes) console.error(note);
  for (const issue of issues) console.error(issue);
  if (issues.length > 0) process.exit(1);
  const arms = report.arms.map((arm) => `${arm.arm} ${((arm.passed / arm.total) * 100).toFixed(1)}%`).join(', ');
  const gold = report.gold ?? {};
  // Derived from the two counts, not from the list: the list is capped so the
  // artifact stays readable, and an exclusion count that depended on the cap would
  // understate the sample it removed.
  const excluded = typeof gold.executed === 'number' ? gold.executed - gold.runnable : 0;
  console.log(
    `BIRD floor: ${report.selection.split ?? 'minidev'} split, ${report.selection.scored} questions` +
      (excluded > 0 ? ` (${String(excluded)} gold excluded: ${(gold.unrunnable ?? []).map((entry) => entry.id).join(', ')})` : '') +
      `, ${arms}`,
  );
}
