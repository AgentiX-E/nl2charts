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

/**
 * The ceiling and the conversion rate, as paired outcomes.
 *
 * "Contains a correct statement 67.1% of the time" is a share, and comparing shares across
 * arms is the mistake this project keeps catching. The same questions were answered by both
 * arms, so the ceilings are paired: the discordant pairs are the questions one set held and
 * the other did not.
 *
 * The half that was missing until now is what happens to those questions. A set that holds
 * 37 correct statements the other set lacks is worth nothing if the arm returns 18 of them,
 * and reporting only the ceiling turned a 2.4pp gain in material into an expected 2.4pp gain
 * in accuracy. `conversion` is that second number; ADR-198 makes reporting it mandatory for
 * any mechanism that claims to improve candidates.
 */
export function ceilingConversion(report, pairs) {
  const cases = Array.isArray(report.cases) ? report.cases : [];
  const rows = [];
  for (const [left, right] of pairs) {
    const marked = cases.filter((entry) => (entry.arm === left || entry.arm === right) && entry.candidateRecall !== undefined);
    const byArm = new Map();
    for (const entry of marked) {
      const bucket = byArm.get(entry.arm) ?? new Map();
      bucket.set(entry.id, { held: entry.candidateRecall === true, passed: entry.passed === true });
      byArm.set(entry.arm, bucket);
    }
    const first = byArm.get(left);
    const second = byArm.get(right);
    if (first === undefined || second === undefined) continue;
    const row = {
      left,
      right,
      n: 0,
      leftHeld: 0,
      rightHeld: 0,
      onlyLeft: 0,
      onlyRight: 0,
      onlyLeftReturned: 0,
      onlyRightReturned: 0,
      shared: 0,
      sharedLeft: 0,
      sharedRight: 0,
    };
    for (const [id, mine] of first) {
      if (!second.has(id)) continue;
      const theirs = second.get(id);
      row.n += 1;
      if (mine.held) row.leftHeld += 1;
      if (theirs.held) row.rightHeld += 1;
      if (mine.held && !theirs.held) {
        row.onlyLeft += 1;
        if (mine.passed) row.onlyLeftReturned += 1;
      }
      if (!mine.held && theirs.held) {
        row.onlyRight += 1;
        if (theirs.passed) row.onlyRightReturned += 1;
      }
      if (mine.held && theirs.held) {
        row.shared += 1;
        if (mine.passed) row.sharedLeft += 1;
        if (theirs.passed) row.sharedRight += 1;
      }
    }
    rows.push(row);
  }
  return rows;
}

function main() {
  const path = process.argv[2] ?? resolve(ROOT, 'eval/out/bird-eval.json');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const pairs = report.arms
    .filter((arm) => Array.isArray(report.mixedCandidatePrompts) && report.mixedCandidatePrompts.some((entry) => entry.arm === arm.arm))
    .map((arm) => [arm.arm, 'select']);
  const { rows, notes } = stratify(report, pairs);
  const mixedArms = report.arms.filter((arm) => Array.isArray(report.mixedCandidatePrompts) && report.mixedCandidatePrompts.some((entry) => entry.arm === arm.arm));
  // The selector arms are compared with each other, not with `select`: the question is what a
  // better candidate set converts at, and `select` draws a different (same-prompt) set.
  const reference = mixedArms.some((arm) => arm.arm === 'select-mixed') ? 'select-mixed' : 'select';
  const pairsForCeiling = mixedArms.filter((arm) => arm.arm !== reference).map((arm) => [arm.arm, reference]);
  const ceilings = ceilingConversion(report, pairsForCeiling);
  for (const note of notes) console.error(note);
  if (rows.length === 0) process.exit(notes.length > 0 ? 0 : 1);
  console.log('| arm | stratum | n | arm | baseline | won / lost |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    console.log(
      `| ${row.arm} | ${row.stratum} | ${row.n} | ${pct(row.armPassed, row.n)} | ${pct(row.baselinePassed, row.n)} | ${row.onlyArm} / ${row.onlyBaseline} |`,
    );
  }
  if (ceilings.length > 0) {
    console.log('');
    console.log('| ceiling | n | left held | right held | only left / only right |');
    console.log('| --- | --- | --- | --- | --- |');
    for (const row of ceilings) {
      console.log(`| ${row.left} vs ${row.right} | ${row.n} | ${pct(row.leftHeld, row.n)} | ${pct(row.rightHeld, row.n)} | ${row.onlyLeft} / ${row.onlyRight} |`);
    }
    console.log('');
    console.log('| conversion | held only by left | returned | held only by right | returned | both held | left returned | right returned |');
    console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of ceilings) {
      console.log(
        `| ${row.left} vs ${row.right} | ${row.onlyLeft} | ${row.onlyLeftReturned} (${pct(row.onlyLeftReturned, row.onlyLeft)}) | ${row.onlyRight} | ${row.onlyRightReturned} (${pct(row.onlyRightReturned, row.onlyRight)}) | ${row.shared} | ${pct(row.sharedLeft, row.shared)} | ${pct(row.sharedRight, row.shared)} |`,
      );
    }
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

  // The ceiling pair: three questions, one where only the left set held the answer, one
  // where only the right did, one where both did — and one question only one arm answered,
  // which must not be paired at all.
  const ceiling = ceilingConversion(
    {
      cases: [
        { arm: 'a', id: '1', candidateRecall: true, passed: true },
        { arm: 'b', id: '1', candidateRecall: false, passed: false },
        { arm: 'a', id: '2', candidateRecall: false, passed: false },
        { arm: 'b', id: '2', candidateRecall: true, passed: false },
        { arm: 'a', id: '3', candidateRecall: true, passed: true },
        { arm: 'b', id: '3', candidateRecall: true, passed: true },
        { arm: 'a', id: '4', candidateRecall: true, passed: true },
      ],
    },
    [['a', 'b']],
  );
  const pair = ceiling[0];
  if (pair?.n !== 3 || pair?.onlyLeft !== 1 || pair?.onlyRight !== 1) {
    issues.push('the ceiling pair loses its discordant questions or counts an unpaired one');
  }
  // The conversion half is what ADR-198 asks for: the question the left set alone answered
  // was returned, the one the right set alone answered was not.
  if (pair?.onlyLeftReturned !== 1 || pair?.onlyRightReturned !== 0) {
    issues.push('the conversion count does not follow the arm that held the answer');
  }
  if (pair?.shared !== 1 || pair?.sharedLeft !== 1 || pair?.sharedRight !== 1) {
    issues.push('the shared stratum loses an arm that also returned the answer');
  }
  // An arm that holds an answer it did not return is the whole point: it must not be counted
  // as a conversion.
  const missed = ceilingConversion(
    {
      cases: [
        { arm: 'a', id: '1', candidateRecall: true, passed: false },
        { arm: 'b', id: '1', candidateRecall: false, passed: false },
      ],
    },
    [['a', 'b']],
  );
  if (missed[0]?.onlyLeft !== 1 || missed[0]?.onlyLeftReturned !== 0) {
    issues.push('a held-but-not-returned answer is counted as a conversion');
  }
  return issues;
}

if (process.argv[2] === '--self-test') {
  const issues = selfTest();
  for (const issue of issues) console.error(issue);
  if (issues.length > 0) process.exit(1);
  console.log('stratify self-test: two strata, discordant pairs, an unpaired question, the conversion count, a held-but-not-returned answer, an empty report and a missing degeneracy record all behave');
} else {
  main();
}
