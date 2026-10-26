#!/usr/bin/env node
/**
 * Does a mixed arm win on the questions where its sources differ, or on the ones where
 * they collapse to a duplicate?
 *
 * The trio (`inline+evidence` + `metadata+evidence` + `values`) builds three distinct
 * prompts on 172 of 498 Mini-Dev questions and two distinct prompts plus a duplicate on
 * the other 326, because the value block only exists when the question names a literal.
 * Its 60.4% is compatible with two readings:
 *
 *   diversity  — it wins where the third statement is genuinely different;
 *   frequency  — it wins where the same statement appears twice in the list it is shown,
 *                because a repeated option is a prior for a model choosing from a list.
 *
 * The dry run records which questions are degenerate; the evaluation records per-case
 * outcomes. This joins them and prints the two strata, so the reading is a measurement.
 *
 * Usage: node tools/stratify-mixed.mjs [eval/out/bird-eval.json]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

/**
 * @returns {{rows: {arm: string, baseline: string, stratum: string, n: number,
 *   armPassed: number, baselinePassed: number, onlyArm: number, onlyBaseline: number}[],
 *   notes: string[]}}
 */
export function stratify(report, pairs) {
  const notes = [];
  const cases = Array.isArray(report.cases) ? report.cases : [];
  if (cases.length === 0) {
    return { rows: [], notes: ['no per-case outcomes in this report: rerun the evaluation with the current runner'] };
  }
  const mixed = Array.isArray(report.mixedCandidatePrompts) ? report.mixedCandidatePrompts : [];
  const outcomes = new Map();
  for (const entry of cases) {
    outcomes.set(`${entry.arm}\u0000${entry.id}`, entry.passed === true);
  }
  const rows = [];
  for (const [armName, baselineName] of pairs) {
    const armEntry = mixed.find((entry) => entry.arm === armName);
    if (armEntry === undefined) {
      notes.push(`${armName} has no degeneracy record: it is not a mixed arm, or the dry run did not describe it`);
      continue;
    }
    const degenerate = new Set(armEntry.degenerateIds ?? []);
    for (const stratum of ['distinct', 'degenerate']) {
      let n = 0;
      let armPassed = 0;
      let baselinePassed = 0;
      let onlyArm = 0;
      let onlyBaseline = 0;
      for (const entry of cases) {
        if (entry.arm !== armName) continue;
        const isDegenerate = degenerate.has(entry.id);
        if ((stratum === 'degenerate') !== isDegenerate) continue;
        const other = outcomes.get(`${baselineName}\u0000${entry.id}`);
        if (other === undefined) continue;
        n += 1;
        const arm = entry.passed === true;
        if (arm) armPassed += 1;
        if (other) baselinePassed += 1;
        if (arm && !other) onlyArm += 1;
        if (!arm && other) onlyBaseline += 1;
      }
      rows.push({ arm: armName, baseline: baselineName, stratum, n, armPassed, baselinePassed, onlyArm, onlyBaseline });
    }
  }
  return { rows, notes };
}

function pct(part, whole) {
  return whole === 0 ? '–' : `${((part / whole) * 100).toFixed(1)}%`;
}

function main() {
  const path = process.argv[2] ?? resolve(ROOT, 'eval/out/bird-eval.json');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const pairs = report.arms
    .filter((arm) => Array.isArray(report.mixedCandidatePrompts) && report.mixedCandidatePrompts.some((entry) => entry.arm === arm.arm))
    .map((arm) => [arm.arm, 'select']);
  const { rows, notes } = stratify(report, pairs);
  for (const note of notes) console.error(note);
  if (rows.length === 0) process.exit(notes.length > 0 ? 0 : 1);
  console.log('| arm | stratum | n | arm | baseline | won / lost |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    console.log(
      `| ${row.arm} | ${row.stratum} | ${row.n} | ${pct(row.armPassed, row.n)} | ${pct(row.baselinePassed, row.n)} | ${row.onlyArm} / ${row.onlyBaseline} |`,
    );
  }
}

function selfTest() {
  const issues = [];
  const report = {
    arms: [{ arm: 'select-mixed' }, { arm: 'select' }],
    mixedCandidatePrompts: [{ arm: 'select-mixed', degenerateIds: ['3', '4'] }],
    cases: [
      { arm: 'select-mixed', id: '1', passed: true },
      { arm: 'select', id: '1', passed: false },
      { arm: 'select-mixed', id: '2', passed: false },
      { arm: 'select', id: '2', passed: true },
      { arm: 'select-mixed', id: '3', passed: true },
      { arm: 'select', id: '3', passed: false },
      { arm: 'select-mixed', id: '4', passed: true },
      { arm: 'select', id: '4', passed: true },
    ],
  };
  const { rows } = stratify(report, [['select-mixed', 'select']]);
  const distinct = rows.find((row) => row.stratum === 'distinct');
  const degenerate = rows.find((row) => row.stratum === 'degenerate');
  if (distinct?.n !== 2 || degenerate?.n !== 2) issues.push('the strata do not split on the recorded ids');
  if (distinct?.onlyArm !== 1 || distinct?.onlyBaseline !== 1) issues.push('the distinct stratum loses its discordant pairs');
  if (degenerate?.onlyArm !== 1 || degenerate?.onlyBaseline !== 0) issues.push('the degenerate stratum loses its discordant pairs');
  const empty = stratify({ arms: [], cases: [] }, []);
  if (empty.notes.length !== 1) issues.push('a report without per-case outcomes is not reported as such');
  const noRecord = stratify({ arms: [], cases: [{ arm: 'a', id: '1', passed: true }] }, [['x', 'y']]);
  if (noRecord.notes.length !== 1) issues.push('a mixed arm without a degeneracy record is not reported as such');
  return issues;
}

if (process.argv[2] === '--self-test') {
  const issues = selfTest();
  for (const issue of issues) console.error(issue);
  if (issues.length > 0) process.exit(1);
  console.log('stratify self-test: two strata, discordant pairs, an empty report and a missing degeneracy record all behave');
} else {
  main();
}
