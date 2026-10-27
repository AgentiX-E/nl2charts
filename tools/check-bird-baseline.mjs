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
  // A report that names two splits is a report nobody can read. This one did: the top level
  // said `mini_dev_sqlite` on every dev run while `selection.split` said `dev`, and the
  // field was read by nothing, so it stayed wrong for four releases. Keeping the check in
  // the gate rather than deleting the field means the disagreement cannot come back.
  if (report?.split !== undefined && report.split !== split) {
    issues.push(`BIRD1: the report says split ${String(report.split)} at the top level and ${split} in selection; one of them is wrong`);
  }

  // A smaller sample is a different measurement, not a worse model: comparing the
  // two would attribute a dataset change to the pipeline. The expected size is a
  // property of the split — a dev run compared against Mini-Dev's 500 would pass while
  // scoring a third of its own split.
  const expectedScored = baseline.scoredBySplit?.[split] ?? baseline.scored;
  if (scored < Math.floor(expectedScored * 0.95)) {
    issues.push(`BIRD1: scored ${scored} questions against a baseline of ${expectedScored}; the sample changed`);
  }

  // Which arms are expected is a property of the split, not of the project. The dev split
  // runs three arms because it is a comparison against a published leaderboard, and the
  // first dev run failed on "arm inline-definitions is missing" — a gate applying one
  // split's configuration to another. `armsBySplit` lets each split state its own list.
  const floors = baseline.floors?.[split];
  const gated = floors !== undefined;
  const expectedArms = baseline.armsBySplit?.[split] ?? (gated ? baseline.expectedArms : []);
  const byArm = new Map((report.arms ?? []).map((arm) => [arm.arm, arm]));
  for (const name of expectedArms) {
    if (!byArm.has(name)) {
      issues.push(`BIRD1: arm ${name} is expected by the baseline and missing from the report`);
    }
  }
  if (report.aa !== undefined && baseline.tolerancePp !== undefined) {
    // The A/A check applies to any split: it is about the harness, not the threshold.
    const delta = Math.abs(report.aa.delta) * 100;
    if (delta > baseline.tolerancePp) {
      issues.push(`BIRD1: the same arm twice differs by ${delta.toFixed(1)}pp, more than the ${String(baseline.tolerancePp)}pp the gate treats as noise`);
    }
  }

  // A lever with no input scores like its parent and reads like a finding. The
  // retrieval arm did exactly that once (44.4% vs 43.6%, corpus size 0), so the gate
  // checks that the blocks an arm depends on were actually built.
  const controls = report.controls ?? {};
  if (expectedArms.includes('inline+retrieval') && (controls.retrievedBlocks ?? 0) === 0) {
    issues.push('BIRD1: inline+retrieval ran with no retrieved block; the corpus is missing, so the arm is its parent renamed');
  }
  if (expectedArms.includes('inline+icl') && (controls.demonstrationBlocks ?? 0) === 0) {
    issues.push('BIRD1: inline+icl ran with no demonstration block; the corpus is missing, so the arm is its parent renamed');
  }
  if (expectedArms.includes('values') && (controls.valueMatches ?? 0) === 0) {
    issues.push('BIRD1: values ran with no matched value; the profile is missing, so the arm is its parent renamed');
  }

  // A repair arm has to report its funnel, and the funnel has to add up. The runner
  // computes it from the same cases it scores, so a mismatch means the two lists
  // drifted apart — and a funnel that does not sum is worse than no funnel, because it
  // looks like a measurement.
  const repairArm = (report.arms ?? []).find((arm) => arm.arm === 'inline+repair');
  if (expectedArms.includes('inline+repair')) {
    if (repairArm === undefined) {
      // Already reported as a missing arm above; nothing to add.
    } else if (repairArm.repair === undefined) {
      issues.push('BIRD1: inline+repair has no repair funnel, so the loop cannot be priced');
    } else {
      const funnel = repairArm.repair;
      // Three buckets, not two: a case that ran once and answered wrong is neither a
      // first-pass success nor a repair, and leaving it out is how this check first
      // fired on real data (285 + 9 != 498).
      if (funnel.firstPass + funnel.ranOnceWrong + funnel.repaired !== funnel.total) {
        issues.push(
          `BIRD1: inline+repair funnel does not add up: ${funnel.firstPass} first-pass + ${funnel.ranOnceWrong} ran-once-wrong + ${funnel.repaired} repaired != ${funnel.total}`,
        );
      }
      if (funnel.fixedByRepair + funnel.stillFailing !== funnel.repaired) {
        issues.push(`BIRD1: inline+repair funnel loses repaired cases: ${funnel.fixedByRepair} fixed + ${funnel.stillFailing} failing != ${funnel.repaired}`);
      }
      const byClass = (funnel.byClass ?? []).reduce((sum, entry) => sum + entry.cases, 0);
      if (byClass !== funnel.repaired) {
        issues.push(`BIRD1: inline+repair funnel assigns ${byClass} of ${funnel.repaired} repaired cases to a failure class`);
      }
    }
  }

  // What the artifact says an arm spent, and whether that is possible. Two numbers in
  // this report were once derived from a field that meant something else: `repaired`
  // counted samples on arms with no repair loop (496 of 498), and the cost of selection
  // came from generation counts, which left out the selector call and made selection
  // look free. A wrong number in a table outlives the run that produced it, so the
  // possibilities are checked here instead of trusted.
  for (const item of report.arms ?? []) {
    const samples = typeof item.vote === 'number' ? item.vote : undefined;
    const mean = item.calls?.mean;
    if (typeof mean !== 'number') {
      issues.push(`BIRD1: ${item.arm} reports no calls per case, so its delta cannot be priced`);
      continue;
    }
    // Only an arm whose selector is the model must spend a call on it. A majority vote
    // reads the same candidates with no model, so `calls == samples` is its correct
    // price — the first version of this check could not tell the two apart and would
    // have failed an arm that was right.
    if (samples !== undefined && item.selector === 'model' && mean <= samples) {
      issues.push(`BIRD1: ${item.arm} samples ${String(samples)} times, selects with the model, and reports ${String(mean)} calls per case; the selector call is not counted`);
    }
    if (samples === undefined && mean < 1) {
      issues.push(`BIRD1: ${item.arm} reports ${String(mean)} calls per case, fewer than the one call every arm makes`);
    }
    // A repair arm always reports its funnel, so a `repaired` count without one is a
    // count of something else — which is exactly what it was: samples, on an arm whose
    // only loop is the vote.
    if (item.repaired !== undefined && item.repair === undefined) {
      issues.push(`BIRD1: ${item.arm} reports ${String(item.repaired)} repaired cases and no repair funnel`);
    }
    // A case that failed inside the runner scored as a wrong answer, and the arm's accuracy is
    // then partly a measurement of the bug. The runner refuses to publish such an arm; this
    // catches an artifact written before it did.
    if ((item.errors?.harness ?? 0) > 0) {
      issues.push(`BIRD1: ${item.arm} recorded ${String(item.errors.harness)} harness errors; its accuracy measures a bug, not the pipeline`);
    }
  }

  // Which model produced the numbers is a third coordinate of a floor, and it was missing.
  // `bird-model.yml` therefore skipped this whole tool for cross-model runs — taking the
  // funnel, cost and empty-lever checks with it — because an accuracy floor taken on
  // DeepSeek says nothing about GLM. Now the floors apply only when the model matches,
  // and everything else in this file applies always.
  const model = report?.model;
  const floorModel = baseline.floorModel?.[split];
  if (model === undefined) {
    issues.push('BIRD1: the report does not name the model that produced it, so its floors cannot be attributed');
  }
  if (gated && floorModel === undefined) {
    issues.push(`BIRD1: the floors for split ${split} do not say which model they were taken on`);
  }
  // A cross-model run must say which second model wrote the `@second` candidates: without
  // it the artifact cannot be reproduced, and "the cross arm scored 63.5%" has no subject.
  const usesSecond = (report.mixedCandidatePrompts ?? []).some((entry) => (entry.sources ?? []).some((source) => source.endsWith('@second')));
  if (usesSecond && (report.secondModel === undefined || report.secondModel === null || report.secondModel === '')) {
    issues.push('BIRD1: an arm drew candidates from a second model and the report does not say which one');
  }
  if (!usesSecond && typeof report.secondModel === 'string' && report.secondModel !== '') {
    notes.push(`BIRD1: the report names a second model (${report.secondModel}) that no arm used`);
  }
  // A judge swap is the one experiment whose result is unreadable without knowing who judged.
  const judged = (report.arms ?? []).filter((arm) => arm.judge === 'second');
  if (judged.length > 0 && (report.judgeModel === undefined || report.judgeModel === null || report.judgeModel === '')) {
    issues.push(`BIRD1: ${judged.map((arm) => arm.arm).join(', ')} is judged by the second model and the report does not say which one`);
  }

  if (floors === undefined) {
    notes.push(`BIRD1: no floors recorded for split ${split}; this run is a measurement, not a gate`);
    return { issues, notes };
  }
  if (model === null) {
    notes.push('BIRD1: this report was produced without a model (dry run); accuracy floors do not apply');
    return { issues, notes };
  }
  if (floorModel !== undefined && model !== floorModel) {
    notes.push(`BIRD1: the floors for ${split} were taken with ${floorModel} and this run used ${model}; accuracy is a measurement, the structural checks still hold`);
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
  for (const name of expectedArms) {
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
    scoredBySplit: { minidev: 100, dev: 1532 },
    tolerancePp: 4,
    expectedArms: ['names', 'inline'],
    floors: { minidev: { names: 40, inline: 50 } },
    floorModel: { minidev: 'deepseek-chat' },
  };
  const arm = (name, passed, total = 100, extra = {}) => ({ arm: name, passed, total, calls: { mean: 1, max: 1 }, ...extra });
  const report = (arms, scored = 100, split = 'minidev', model = 'deepseek-chat') => ({ selection: { scored, split }, model, arms });
  const fail = (result, count, why) => {
    if (result.issues.length !== count) issues.push(why);
  };

  fail(compare(report([arm('names', 42), arm('inline', 47)]), baseline), 0, 'BIRD1 has no self-test: a passing run was rejected');
  fail(compare(report([arm('names', 37), arm('inline', 47)]), baseline), 0, 'BIRD1 fails a run inside the noise threshold, which is not a regression');
  fail(compare(report([arm('names', 30), arm('inline', 52)]), baseline), 1, 'BIRD1 does not catch an arm 10pp below its floor');
  fail(compare(report([arm('names', 42)]), baseline), 1, 'BIRD1 does not notice an expected arm that vanished');
  fail(compare(report([arm('names', 42), arm('inline', 51)], 60), baseline), 1, 'BIRD1 does not notice the sample shrinking');

  const empty = compare({ arms: [] }, baseline);

  const unstable = compare({ selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', aa: { delta: 0.085 }, arms: [arm('names', 42), arm('inline', 51)] }, baseline);
  if (unstable.issues.length !== 1) issues.push('BIRD1 does not notice an A/A pair that disagrees beyond the tolerance');

  // A different split with its own arm list: three arms on dev must not be judged
  // against Mini-Dev's thirteen.
  const devRun = compare(
    report([arm('names', 647, 1532), arm('inline+evidence', 929, 1532), arm('metadata+evidence', 941, 1532)], 1532, 'dev'),
    { ...baseline, scoredBySplit: { ...baseline.scoredBySplit, dev: 1532 }, armsBySplit: { dev: ['names', 'inline+evidence', 'metadata+evidence'] } },
  );
  if (devRun.issues.length !== 0) {
    issues.push(`BIRD1 applies the Mini-Dev arm list to another split (${devRun.issues.join('; ')})`);
  }

  // ...but a gated split still enforces its own list.
  const devMissing = compare(report([arm('names', 647, 1532)], 1532, 'dev'), {
    ...baseline,
    floors: { ...baseline.floors, dev: {} },
    floorModel: { ...baseline.floorModel, dev: 'deepseek-chat' },
    armsBySplit: { dev: ['names', 'inline+evidence'] },
  });
  fail(devMissing, 1, 'BIRD1 does not enforce a split-specific arm list');

  // The sample-size check must be split-scoped too. It was not: every split was measured
  // against Mini-Dev's 500, so a dev run that scored 600 of 1,532 questions passed a check
  // whose whole job is to notice a shrunken sample.
  const shrunkDev = compare(report([arm('names', 300, 600), arm('inline+evidence', 360, 600)], 600, 'dev'), {
    ...baseline,
    armsBySplit: { dev: ['names', 'inline+evidence'] },
  });
  if (!shrunkDev.issues.some((issue) => issue.includes('sample changed'))) {
    issues.push('BIRD1 compares a dev run against Mini-Dev and calls 600 of 1,532 questions a full sample');
  }

  // A report that names two splits. Every dev artifact said mini_dev_sqlite at the top
  // level while selection said dev; the field was read by nothing, so nothing noticed.
  const twoSplits = compare({ ...report([arm('names', 42), arm('inline', 51)]), split: 'mini_dev_sqlite' }, baseline);
  if (!twoSplits.issues.some((issue) => issue.includes('one of them is wrong'))) {
    issues.push('BIRD1 accepts a report whose two split fields disagree');
  }

  // A floor is a claim about (split, arms, model). A cross-model run must be measured
  // rather than failed — but only the accuracy floor is skipped, not the rest.
  const otherModel = compare(report([arm('names', 30), arm('inline', 20)], 100, 'minidev', 'glm-4.5'), baseline);
  fail(otherModel, 0, 'BIRD1 fails another model against floors taken on DeepSeek');
  if (!otherModel.notes.some((note) => note.includes('glm-4.5'))) {
    issues.push('BIRD1 does not say which model the floors were taken with');
  }
  const otherModelBadFunnel = compare(
    {
      selection: { scored: 100, split: 'minidev' },
      model: 'glm-4.5',
      arms: [{ ...arm('inline+repair', 50), repair: { total: 100, firstPass: 90, ranOnceWrong: 0, repaired: 20, fixedByRepair: 5, stillFailing: 15, byClass: [] } }],
    },
    { ...baseline, expectedArms: ['inline+repair'] },
  );
  if (!otherModelBadFunnel.issues.some((issue) => issue.includes('does not add up'))) {
    issues.push('BIRD1 skips its structural checks on a run by another model, which is why bird-model ran with no gate at all');
  }

  // Provenance: a report that omits the model, a floors table that omits the model it was
  // taken on, and a cross-model arm with no second model named.
  const anonymous = compare({ selection: { scored: 100, split: 'minidev' }, arms: [arm('names', 42), arm('inline', 51)] }, baseline);
  if (!anonymous.issues.some((issue) => issue.includes('does not name the model'))) {
    issues.push('BIRD1 accepts a report that does not name the model');
  }
  const unnamedFloors = compare(report([arm('names', 42), arm('inline', 51)]), { ...baseline, floorModel: {} });
  if (!unnamedFloors.issues.some((issue) => issue.includes('which model they were taken on'))) {
    issues.push('BIRD1 enforces floors that do not say which model they came from');
  }
  const crossWithoutSecond = compare(
    {
      ...report([arm('select-cross', 42)]),
      mixedCandidatePrompts: [{ arm: 'select-cross', sources: ['inline+evidence@second', 'metadata+evidence', 'values'] }],
    },
    { ...baseline, expectedArms: ['select-cross'] },
  );
  if (!crossWithoutSecond.issues.some((issue) => issue.includes('does not say which one'))) {
    issues.push('BIRD1 accepts a cross-model arm whose second model is not recorded');
  }
  const judgedWithoutJudge = compare(
    { ...report([arm('select-cross-judge', 42, 100, { vote: 3, selector: 'model', judge: 'second', calls: { mean: 4, max: 4 } })]), mixedCandidatePrompts: [{ arm: 'select-cross-judge', sources: ['inline+evidence@second', 'metadata+evidence', 'values'] }] },
    { ...baseline, expectedArms: ['select-cross-judge'] },
  );
  if (!judgedWithoutJudge.issues.some((issue) => issue.includes('does not say which one'))) {
    issues.push('BIRD1 accepts a judge swap whose judge is not recorded');
  }
  const dryRun = compare({ ...report([arm('names', 42), arm('inline', 51)]), model: null }, baseline);
  fail(dryRun, 0, 'BIRD1 fails a dry run against a model floor');
  if (!dryRun.notes.some((note) => note.includes('without a model'))) {
    issues.push('BIRD1 does not say that a dry run has no accuracy to gate');
  }

  // The funnel that does not add up: 90 + 0 + 20 != 100.
  const badFunnel = compare(
    {
      selection: { scored: 498, split: 'minidev' },
      model: 'deepseek-chat',
      arms: [
        {
          ...arm('inline+repair', 50),
          repair: { total: 100, firstPass: 90, ranOnceWrong: 0, repaired: 20, fixedByRepair: 5, stillFailing: 15, byClass: [] },
        },
      ],
    },
    { ...baseline, expectedArms: ['inline+repair'] },
  );
  if (!badFunnel.issues.some((issue) => issue.includes('does not add up'))) {
    issues.push('BIRD1 does not notice a repair funnel whose parts exceed its total');
  }

  // The two numbers that once lied, and the number that was simply absent: a repair
  // count on an arm with no loop, a selector that costs nothing, and an arm whose cost
  // cannot be read at all.
  const lyingSamples = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', arms: [arm('select5', 58, 100, { vote: 5, selector: 'model', calls: { mean: 5, max: 5 } })] },
    { ...baseline, expectedArms: ['select5'] },
  );
  if (!lyingSamples.issues.some((issue) => issue.includes('selector call is not counted'))) {
    issues.push('BIRD1 does not notice a sampling arm whose selector call is missing from its cost');
  }
  const lyingRepair = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', arms: [arm('select5', 58, 100, { vote: 5, selector: 'model', calls: { mean: 6, max: 6 }, repaired: 496 })] },
    { ...baseline, expectedArms: ['select5'] },
  );
  if (!lyingRepair.issues.some((issue) => issue.includes('no repair funnel'))) {
    issues.push('BIRD1 does not notice a repaired count on an arm that cannot repair');
  }
  // ...and the opposite mistake: a majority vote spends exactly one call per sample, so
  // an arm whose selector is not the model must not be accused of hiding a selector call.
  const majorityPriced = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', arms: [arm('vote', 55, 100, { vote: 3, selector: 'majority', calls: { mean: 3, max: 3 } })] },
    { ...baseline, expectedArms: ['vote'] },
  );
  if (majorityPriced.issues.length !== 0) {
    issues.push(`BIRD1 accuses a majority-vote arm of hiding a selector call (${majorityPriced.issues.join('; ')})`);
  }
  const harnessBroken = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', arms: [arm('names', 42, 100, { errors: { harness: 3, llm: 0 } })] },
    { ...baseline, expectedArms: ['names'] },
  );
  if (!harnessBroken.issues.some((issue) => issue.includes('measures a bug'))) {
    issues.push('BIRD1 accepts an arm whose cases failed inside the harness');
  }
  const unpriced = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', arms: [{ arm: 'names', passed: 42, total: 100 }] },
    { ...baseline, expectedArms: ['names'] },
  );
  if (!unpriced.issues.some((issue) => issue.includes('cannot be priced'))) {
    issues.push('BIRD1 does not notice an arm that reports no calls at all');
  }

  // The lever-with-no-input case: the arms are present, the blocks are not.
  const dryLever = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', controls: { retrievedBlocks: 0, demonstrationBlocks: 0 }, arms: [arm('names', 42), arm('inline', 51)] },
    { ...baseline, expectedArms: ['names', 'inline', 'inline+retrieval', 'inline+icl'] },
  );
  if (dryLever.issues.filter((issue) => issue.includes('corpus is missing')).length !== 2) {
    issues.push('BIRD1 does not notice an arm whose retrieved block was never built');
  }
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
  console.log('BIRD floor self-test: pass, noise, regression, missing arm, shrunken sample, a dev run measured against its own sample, two split fields that disagree, other split, other model, unfloored arm, empty lever, a funnel that does not add up, a split-specific arm list, an uncounted selector call, a majority vote that spends exactly its samples, a repair count without a loop, an unpriced arm, an unnamed model, floors from an unnamed model and a cross-model arm with no second model named, a judge swap with no judge named and an arm with harness errors all behave');
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
