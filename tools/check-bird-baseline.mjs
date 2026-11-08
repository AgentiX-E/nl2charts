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
 * The arms a run set out to score, when the artifact says so.
 *
 * A declaration that is present but unreadable is an issue, not an absence: a report
 * carrying `armsRequested: []` claims to have run nothing, and falling back to the strict
 * check would hide the claim instead of refusing it. Absent means an artifact from before
 * the field existed, which is checked against the split's full list as it always was.
 *
 * @returns {string[]|undefined}
 */
function armRequest(value, issues) {
  if (value === undefined) return undefined;
  const usable = Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === 'string' && name.trim() !== '');
  if (!usable) {
    issues.push('BIRD1: the report declares an arm set it cannot describe, so no arm list can be checked against it');
    return undefined;
  }
  return value;
}

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
  // The same disagreement one field over, and it outlived the first fix. `baseReport` wrote the
  // literal `'bird-mini-dev'` whatever the split, so every artifact from a full 1,532-question
  // sweep announced the per-commit subset — and `tools/live-summary.mjs` prints this field, so
  // the summary a reader saw named the wrong corpus. The name is derived from the split now;
  // this is what stops a literal creeping back. The mapping is repeated rather than imported
  // because the gate is plain JavaScript and has to run before any build.
  if (report?.dataset !== undefined) {
    const expected = split === 'dev' ? 'bird-dev' : 'bird-mini-dev';
    if (report.dataset !== expected) {
      issues.push(`BIRD1: the report names dataset ${String(report.dataset)} but its split is ${split}; the name is derived, so a disagreement means one of them was written by hand`);
    }
  }

  // The corpus a rate is about, named as content rather than as a path. BIRD re-annotated
  // Mini-Dev on 2026-10-28 — corrected annotations, replaced instances — and this repository
  // downloads the split from a bucket URL rather than a pinned archive. Every floor in this
  // file is a floor on the questions that set it, so a run that cannot name its corpus cannot
  // be compared with those floors at all.
  const corpus = report?.corpus;
  const pinned = baseline.corpus?.[split];
  if (corpus === undefined) {
    if (pinned !== undefined) {
      issues.push(`BIRD1: the report does not name the corpus it read, so it cannot be compared with floors pinned to ${pinned}`);
    }
  } else if (typeof corpus.digest !== 'string' || corpus.digest === '') {
    issues.push('BIRD1: the report has a corpus block with no digest in it');
  } else if (pinned !== undefined && corpus.digest !== pinned) {
    issues.push(
      `BIRD1: the report read corpus ${corpus.digest} and the floors were set on ${pinned}; the questions changed under the floors`,
    );
  }
  // A report that declares its arms is a report from a runner that also knows its corpus. The
  // exemption above is for artifacts written before the field existed, and this is what keeps
  // it an exemption rather than a hole.
  if (corpus === undefined && report?.armsRequested !== undefined) {
    issues.push('BIRD1: the report declares the arms it ran and not the corpus it read');
  }

  // Who answered — the coordinate `model` cannot supply. `model` records what the run asked for;
  // `servedModels` records the base each arm's answers named. Those are two different claims and
  // they came apart on 2026-11-08: both Mini-Dev runs asked for `deepseek-chat` and all 6,448 of
  // their answers came back named `deepseek-flash`. An alias that is re-pointed turns a re-run on
  // new weights into what looks like a re-run of the same experiment, which is the one failure a
  // floor cannot see on its own: the numbers stay plausible and the subject changed.
  const servedPin = baseline.served?.[split];
  const bases = new Set();
  let armsScored = 0;
  for (const arm of Array.isArray(report?.arms) ? report.arms : []) {
    armsScored += 1;
    for (const base of Object.keys(arm?.servedModels ?? {})) bases.add(base);
  }
  const servedNames = [...bases].sort();
  // The pin belongs to the model the floors belong to. `bird-model.yml` exists to measure *another*
  // model, and failing it for answering as itself would be a gate that forbids the experiment it was
  // written for; the accuracy floors are already switched off in that case, and this follows them.
  const floorsModel = baseline.floorModel?.[split];
  const sameModel = typeof report?.model !== 'string' || typeof floorsModel !== 'string' ? true : report.model === floorsModel;
  if (servedPin !== undefined && sameModel) {
    if (servedNames.length === 0) {
      issues.push(
        `BIRD1: the report scores ${String(armsScored)} arm(s) and cannot name the base that answered, so it cannot be compared with floors taken on ${servedPin.join(', ')}`,
      );
    } else if (servedNames.join(',') !== servedPin.join(',')) {
      issues.push(
        `BIRD1: the endpoint answered as ${servedNames.join(', ')} and the floors were taken on ${servedPin.join(', ')}; the alias was re-pointed, so these numbers are about another model`,
      );
    }
  } else if (servedNames.length > 0) {
    notes.push(
      sameModel
        ? `BIRD1: no base model is pinned for split ${split}; this run answered as ${servedNames.join(', ')}, which is recorded rather than enforced`
        : `BIRD1: the base-model pin for ${split} belongs to ${String(floorsModel)} and this run asked for ${String(report?.model)}; its base (${servedNames.join(', ')}) is recorded rather than enforced`,
    );
  }
  // The same coordinate, read from behaviour instead of from paperwork.
  //
  // `model.served` catches an alias that is re-pointed at a different *name*. It cannot catch an
  // endpoint that keeps the name and changes the weights, and that is the case every pooled reading
  // in `docs/benchmarks.md` depends on: four runs, hours apart, averaged as if one generator
  // produced all four. `eval/bird/fingerprint.ts` asks a few fixed questions twice at temperature
  // zero, and the gate compares the digest with a pin taken the same way.
  //
  // The comparison is refused rather than faked when it cannot be made, for four different
  // reasons, and each of those is a separate sentence because they call for different actions:
  // no pin (pin it), no reading (the instrument did not run), an unstable reading (the endpoint
  // samples, so a digest is a draw), or a different number of probes (two digests over different
  // questions). Only a stable digest over the same probe count that differs from the pin is a
  // failure.
  const fingerprintPin = baseline.baseFingerprint?.[split];
  const fingerprint = report?.baseFingerprint;
  const fingerprintDigest = typeof fingerprint?.digest === 'string' ? fingerprint.digest : '';
  const fingerprintProbes = typeof fingerprint?.probes === 'number' ? fingerprint.probes : 0;
  if (fingerprintPin === undefined) {
    if (fingerprintDigest !== '') {
      notes.push(
        `BIRD1: no base fingerprint is pinned for split ${split}; this run read ${fingerprintDigest} over ${String(fingerprintProbes)} probe(s), which is recorded rather than enforced`,
      );
    }
  } else if (!sameModel) {
    notes.push(
      `BIRD1: the base fingerprint pinned for ${split} belongs to ${String(floorsModel)} and this run asked for ${String(report?.model)}; its digest (${fingerprintDigest === '' ? 'none' : fingerprintDigest}) is recorded rather than enforced`,
    );
  } else if (fingerprint === undefined) {
    issues.push(
      `BIRD1: the report carries no base fingerprint and the floors were taken on ${String(fingerprintPin.digest)}; a run that cannot identify its generator cannot be compared with floors taken on one`,
    );
  } else if (fingerprintDigest === '' || fingerprintProbes === 0) {
    const why = Array.isArray(fingerprint.failures) && fingerprint.failures.length > 0 ? String(fingerprint.failures[0]) : 'every probe answered nothing';
    issues.push(
      `BIRD1: this run asked the base ${String(fingerprint.calls ?? 0)} probe question(s) and got no answer (${why}), so it cannot say which generator produced its numbers`,
    );
  } else if (fingerprint.stable !== true) {
    const which = Array.isArray(fingerprint.unstable) && fingerprint.unstable.length > 0 ? fingerprint.unstable.join(', ') : 'a probe';
    notes.push(
      `BIRD1: the endpoint answered identical probes differently (${which}), so ${fingerprintDigest} is a draw and not a fingerprint; a change of weights cannot be separated from it in this run`,
    );
  } else if (typeof fingerprintPin.probeSet === 'string' && fingerprint.probeSet !== fingerprintPin.probeSet) {
    // A pin is a claim about the questions it was taken on. Editing a probe — fixing a typo, adding
    // a fifth — changes the digest for a reason that has nothing to do with the model, so the pin
    // has to move in the same commit as the question. This is the check that makes that mandatory
    // rather than remembered.
    issues.push(
      `BIRD1: this run asked a different probe set (${String(fingerprint.probeSet ?? 'none')}) from the one the pin was taken on (${fingerprintPin.probeSet}); re-record the pin in the commit that edits the questions`,
    );
  } else if (fingerprintProbes !== fingerprintPin.probes) {
    notes.push(
      `BIRD1: this run fingerprinted ${String(fingerprintProbes)} probe(s) where the pin was taken over ${String(fingerprintPin.probes)}; the two digests are over different questions, so this one is recorded rather than compared`,
    );
  } else if (fingerprintDigest !== fingerprintPin.digest) {
    issues.push(
      `BIRD1: the base answered its fixed probes as ${fingerprintDigest} and the floors were taken on ${String(fingerprintPin.digest)}; the same name is being served by different weights, or the endpoint changed something about the request`,
    );
  }

  // Not a failure: a provider renaming its own model is not this repository's defect. It is the
  // fact a reader needs in order to know that `floorModel` names an alias, and it belongs in the
  // log of every run that hits it rather than in a footnote of a document.
  if (typeof report?.model === 'string' && servedNames.length > 0 && !bases.has(report.model)) {
    notes.push(
      `BIRD1: the run asked for ${report.model} and the endpoint named ${servedNames.join(', ')} — only the second field answered`,
    );
  }

  // Which questions a run set out to score is a fourth coordinate of a floor, after split,
  // arms and model — and it was the missing one. `bird-model.yml` took a 300-question slice
  // to compare two models on one prompt, the artifact recorded `requested: 300` and
  // `available: 500` honestly, and this tool failed the run for "the sample changed": a red
  // build about the sample the run declared. The rule is the one the arm list already
  // follows — a declaration is read, and the checks that need the full sample are switched
  // off out loud rather than guessed at. An artifact from before this field existed still
  // gets the strict check, because there is nothing to read.
  const requested = report?.selection?.requested;
  const available = report?.selection?.available;
  let declaredSubset = false;
  if (requested !== undefined) {
    if (typeof requested !== 'number' || !(requested > 0)) {
      issues.push(`BIRD1: selection.requested is ${JSON.stringify(requested)}, which is not a sample size`);
    } else if (typeof available === 'number' && requested > available) {
      issues.push(`BIRD1: the run asked for ${requested} questions and split ${split} has ${available}`);
    } else if (scored > requested) {
      issues.push(`BIRD1: the run asked for ${requested} questions and published ${scored} rows`);
    } else if (typeof available === 'number' && requested < available) {
      declaredSubset = true;
    }
  }

  // A smaller sample is a different measurement, not a worse model: comparing the
  // two would attribute a dataset change to the pipeline. The expected size is a
  // property of the split — a dev run compared against Mini-Dev's 500 would pass while
  // scoring a third of its own split.
  const expectedScored = baseline.scoredBySplit?.[split] ?? baseline.scored;
  if (declaredSubset) {
    notes.push(`BIRD1: ${scored} of ${available} ${split} questions were requested, so this is a measurement on a declared subset`);
  } else if (scored < Math.floor(expectedScored * 0.95)) {
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
  // ...but a run may deliberately score a subset. The dev list is five arms; the ablation
  // that produced `40534288883` ran six, two of them new, and this check failed the build
  // for not running two it never asked for — a red build about the arm list rather than
  // about the pipeline, on the one run whose numbers mattered. A report that states the
  // arms it requested is read as a measurement of those arms: baseline arms it did not
  // request become notes, and the declaration has to agree with the rows it published.
  const declared = armRequest(report.armsRequested, issues);
  for (const name of expectedArms) {
    if (byArm.has(name)) continue;
    if (declared === undefined) {
      issues.push(`BIRD1: arm ${name} is expected by the baseline and missing from the report`);
      continue;
    }
    notes.push(`BIRD1: ${name} is in this split's baseline and this run did not request it, so nothing was enforced for it`);
  }
  for (const name of declared ?? []) {
    if (!byArm.has(name)) {
      issues.push(`BIRD1: arm ${name} was requested and has no row in the report, so the run dropped a measurement it declared`);
    }
  }
  for (const name of byArm.keys()) {
    if (declared !== undefined && !declared.includes(name)) {
      issues.push(`BIRD1: the report carries a row for ${name}, which its arm list does not declare`);
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
  // checks that the blocks an arm depends on were actually built. The condition is that
  // the arm *ran*, not that the split expects it: a subset run on Mini-Dev that leaves
  // `inline+retrieval` out would otherwise be failed for a corpus it never needed.
  const controls = report.controls ?? {};
  if (byArm.has('inline+retrieval') && (controls.retrievedBlocks ?? 0) === 0) {
    issues.push('BIRD1: inline+retrieval ran with no retrieved block; the corpus is missing, so the arm is its parent renamed');
  }
  if (byArm.has('inline+icl') && (controls.demonstrationBlocks ?? 0) === 0) {
    issues.push('BIRD1: inline+icl ran with no demonstration block; the corpus is missing, so the arm is its parent renamed');
  }
  if (byArm.has('values') && (controls.valueMatches ?? 0) === 0) {
    issues.push('BIRD1: values ran with no matched value; the profile is missing, so the arm is its parent renamed');
  }
  // Same rule for the card-level lever: an arm that asks for samples and is handed none is
  // `inline+evidence` under a longer name, and its delta would be a delta of nothing.
  const sampledArm = (report.arms ?? []).find((arm) => String(arm.arm).includes('samples'));
  if (sampledArm !== undefined && (controls.sampledColumns ?? 0) === 0) {
    issues.push('BIRD1: an arm asked for column samples and the profile supplied none, so the arm is its parent renamed');
  }

  // A truncated schema card drops tables from the prompt, and a model cannot query a table
  // it was never shown — but the run only *reported* the truncation, so a card that lost
  // half a database looked like a hard question set. `controls.tablesInPrompts` and the
  // arms now render at the same limit, which is what makes this comparison mean anything.
  const truncated = controls.truncatedPrompts;
  if (Array.isArray(truncated) && truncated.length > 0) {
    const worst = truncated
      .slice(0, 3)
      .map((entry) => `${String(entry?.db)}: ${String(entry?.shown)}/${String(entry?.total)} tables`)
      .join(', ');
    issues.push(`BIRD1: the schema card drops tables from the prompt (${worst}), so the arm is measured on a schema it cannot query`);
  }
  if ((controls.tablesTotal ?? 0) > 0 && (controls.tablesInPrompts ?? 0) === 0) {
    issues.push('BIRD1: no table reached the prompt; every arm was asked to write SQL against an empty schema');
  }

  // A repair arm has to report its funnel, and the funnel has to add up. The runner
  // computes it from the same cases it scores, so a mismatch means the two lists
  // drifted apart — and a funnel that does not sum is worse than no funnel, because it
  // looks like a measurement.
  const repairArm = (report.arms ?? []).find((arm) => arm.arm === 'inline+repair');
  if (byArm.has('inline+repair')) {
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

  // A corpus that does not say what it left out reads as a census. The artifact names
  // the arms it truncated and the count each arm produced, so the two have to agree.
  const sample = report.failureSample;
  if (sample !== undefined) {
    for (const [name, kept] of Object.entries(report.failures ?? {})) {
      const total = sample.total?.[name];
      if (typeof total !== 'number') {
        issues.push(`BIRD1: ${name} reports ${String(kept.length)} failing statements and no count of how many it produced`);
        continue;
      }
      if (kept.length > total) {
        issues.push(`BIRD1: ${name} keeps ${String(kept.length)} failing statements out of ${String(total)}, which is more than it failed`);
      }
      const truncated = (sample.truncated ?? []).includes(name);
      if (truncated && kept.length !== sample.cap) {
        issues.push(`BIRD1: ${name} is listed as truncated at ${String(sample.cap)} and keeps ${String(kept.length)}`);
      }
      if (!truncated && kept.length !== total) {
        issues.push(`BIRD1: ${name} keeps ${String(kept.length)} of its ${String(total)} failures and does not say it truncated them`);
      }
    }
  }

  // A candidate set that lost a third of its members to endpoint errors still answers
  // every case, so nothing above notices: the ceiling simply falls, and the arm is read
  // as a worse prompt. The artifact has to say how many candidates arrived.
  for (const item of report.arms ?? []) {
    const loss = item.candidateFailures;
    if (loss === undefined) continue;
    if (typeof loss.attempted !== 'number' || loss.attempted === 0) {
      issues.push(`BIRD1: ${item.arm} reports lost candidates without the number it attempted`);
      continue;
    }
    // `engine` and `unparsed` are separate mechanisms with separate repairs, and an artifact
    // written before the split has neither -- reading its merged `other` as one of them would
    // invent which mechanism it was, so the halves count as zero here.
    const lostTotal = loss.llm + (loss.engine ?? 0) + (loss.unparsed ?? 0);
    if (lostTotal > loss.attempted) {
      issues.push(`BIRD1: ${item.arm} lost ${String(lostTotal)} of ${String(loss.attempted)} candidates, which is more than it drew`);
    }
    if (loss.engine !== undefined && loss.engine / loss.attempted > 0.5) {
      // A note, not an issue: a statement the engine refuses is the model's output quality, and
      // an arm whose statements are all unrunnable is a 0% reading rather than a broken harness.
      // It is only worth saying out loud, because accuracy and ceiling both measure the sample
      // and neither of them says so.
      notes.push(
        `BIRD1: ${item.arm} had ${String(loss.engine)} of ${String(loss.attempted)} candidates refused by the engine (${((loss.engine / loss.attempted) * 100).toFixed(1)}%); its accuracy and ceiling both measure the sample`,
      );
    }
    if (loss.llm / loss.attempted > 0.1) {
      issues.push(
        `BIRD1: ${item.arm} never received ${String(loss.llm)} of ${String(loss.attempted)} candidates (${((loss.llm / loss.attempted) * 100).toFixed(1)}%); its ceiling measures the endpoint`,
      );
    }
  }

  // A prompt that asks for a decomposition, and a model that does not write one, produce
  // the parent arm with a longer instruction. Accuracy cannot tell the two apart, so the
  // artifact has to report what the prompt actually produced — and the numbers have to be
  // possible, and the reach has to be large enough to be a measurement of the method.
  for (const item of report.arms ?? []) {
    const fired = item.decomposition;
    const declares = item.arm === 'decompose' || /\+dc$/.test(item.arm);
    if (fired === undefined) {
      if (declares) {
        issues.push(`BIRD1: ${item.arm} asks for a decomposition and reports none, so the arm is its parent with a longer prompt`);
      }
      continue;
    }
    if (typeof fired.asked !== 'number' || typeof fired.fired !== 'number' || typeof fired.share !== 'number' || typeof fired.meanSteps !== 'number') {
      issues.push(`BIRD1: ${item.arm} reports a decomposition without the counts that price it`);
      continue;
    }
    if (fired.asked > (item.total ?? 0) || fired.fired > fired.asked) {
      issues.push(`BIRD1: ${item.arm} reports steps on ${String(fired.fired)} of ${String(fired.asked)} asked cases, and ${String(item.total ?? 0)} cases ran`);
    }
    const expectedShare = fired.asked === 0 ? 0 : fired.fired / fired.asked;
    if (Math.abs(fired.share - expectedShare) > 0.001) {
      issues.push(`BIRD1: ${item.arm} reports a decomposition share of ${String(fired.share)} for ${String(fired.fired)} of ${String(fired.asked)} cases`);
    }
    // The same threshold the runner refuses on. A gate that accepts what the runner
    // rejects is half a gate, which is how the aggregate gate drifted in v9.9.
    if ((item.total ?? 0) >= 100 && (fired.share < 0.5 || fired.meanSteps < 1.5)) {
      issues.push(
        `BIRD1: ${item.arm} wrote steps on ${(fired.share * 100).toFixed(1)}% of cases at ${String(fired.meanSteps)} per case; the format was ignored, so the arm measures a longer prompt`,
      );
    }
  }

  // An empty result is the one signal on this benchmark that is exact rather than a
  // guess: no question in either split has an empty gold result, so a statement that
  // returned nothing is wrong by construction. An arm that claims the lever must show
  // what it did with it — how many candidates it removed for free, how often it spent
  // the extra turn, and how often that turn produced rows.
  for (const item of report.arms ?? []) {
    const lever = item.emptyRetry;
    if (lever === undefined) continue;
    if (lever.mode !== 'diagnosed' && lever.mode !== 'blind' && lever.mode !== 'values') {
      issues.push(`BIRD1: ${item.arm} runs an empty-result lever that does not say how it speaks: ${String(lever.mode)}`);
    }
    // `values` speaks with the columns' own values, and it has a second half that costs no call:
    // the lookup grounds a case-only mismatch and adopts the rewrite. Those adoptions are counted
    // apart from the turn because they spend nothing, so the arithmetic is over both — a run that
    // recovered more cases than it fired must have grounded the difference, and a run that claims
    // more free adoptions than groundings counted the same case twice.
    if (lever.mode === 'values') {
      for (const field of ['grounded', 'adoptedFree', 'probeQueries', 'literalGaps']) {
        if (typeof lever[field] !== 'number') {
          issues.push(`BIRD1: ${item.arm} speaks with values and does not report ${field}, so the free half of the lever cannot be priced`);
        }
      }
      if (typeof lever.adoptedFree === 'number' && typeof lever.grounded === 'number' && lever.adoptedFree > lever.grounded) {
        issues.push(`BIRD1: ${item.arm} adopts ${String(lever.adoptedFree)} grounded statements of ${String(lever.grounded)} it grounded`);
      }
    }
    if (typeof lever.fired !== 'number' || typeof lever.recovered !== 'number' || typeof lever.dropped !== 'number') {
      issues.push(`BIRD1: ${item.arm} declares an empty-result lever and does not report its funnel, so the call cannot be priced`);
      continue;
    }
    const free = typeof lever.adoptedFree === 'number' ? lever.adoptedFree : 0;
    if (lever.recovered > lever.fired + free) {
      issues.push(`BIRD1: ${item.arm} recovers ${String(lever.recovered)} of ${String(lever.fired)} retried cases, which is impossible`);
    }
    if (lever.fired > (item.total ?? 0)) {
      issues.push(`BIRD1: ${item.arm} retries ${String(lever.fired)} times on ${String(item.total ?? 0)} cases`);
    }
    // A lever that never fires produces its parent's number under its own name — the
    // same failure mode as a repair loop that never repairs, and the reason both are
    // checked instead of trusted.
    if ((item.total ?? 0) >= 100 && lever.fired + lever.dropped === 0) {
      issues.push(
        `BIRD1: ${item.arm} treats empty results as failures and neither dropped a candidate nor retried one across ${String(item.total)} cases; the lever did not run`,
      );
    }
  }

  // The reconcile funnel is four nested counts, and its last column is nested *by policy*: an arm
  // that adopts every statement it can run reports `adopted === executable`, and an arm that hands
  // restatements back reports `adopted <= novel`. Neither relationship can be asserted without the
  // policy the row now carries, because the same numbers are a correct reading on one policy and
  // arithmetic that counted something twice on the other — `41453395203` published 595 and 595 and
  // was right, and a `-novel` arm reporting the same pair would have adopted 509 paraphrases.
  for (const item of report.arms ?? []) {
    const funnel = item.reconcile;
    if (funnel === undefined) continue;
    if (funnel.policy !== 'always' && funnel.policy !== 'novel') {
      issues.push(
        `BIRD1: ${item.arm} reports a reconcile funnel without the policy it was read under, so its ${String(funnel.executable)} runnable and ${String(funnel.adopted)} adopted replies cannot be attributed`,
      );
      continue;
    }
    const nested = [
      ['returned', funnel.asked, funnel.returned],
      ['novel', funnel.returned, funnel.novel],
      ['executable', funnel.returned, funnel.executable],
      ['adopted', funnel.executable, funnel.adopted],
    ];
    for (const [column, outer, value] of nested) {
      if (typeof value !== 'number' || !(value >= 0) || value > outer) {
        issues.push(
          `BIRD1: ${item.arm} reports ${String(value)} reconcile replies as ${column} out of ${String(outer)}; the funnel's columns nest, so the artifact counted one reply twice`,
        );
      }
    }
    if (funnel.policy === 'always' && funnel.adopted !== funnel.executable) {
      issues.push(
        `BIRD1: ${item.arm} adopts every statement it can run and reports ${String(funnel.adopted)} adopted out of ${String(funnel.executable)} runnable; the score covers replies the funnel says were not scored`,
      );
    }
    if (funnel.policy === 'novel' && funnel.adopted > funnel.novel) {
      issues.push(
        `BIRD1: ${item.arm} says it scores only statements nobody wrote and reports ${String(funnel.adopted)} adopted against ${String(funnel.novel)} such statements; the restatements it declines are in its score`,
      );
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
    const pooled = typeof item.pool === 'string';
    // A mean cannot answer the question this block exists to ask. Two states produce the same number:
    // a case that fails before the selector returns and spends nothing (legitimate, and it lowers the
    // mean), and a selector call that was never counted (the defect). `41440646002` shows both faces
    // at once — four pooled arms reported one call per case and were refused by a rule that assumed
    // sampling, which on a pooled arm is the opposite of the truth (I-81), and `select-mixed-pooled`
    // reported 0.995 for the legitimate state on three cases. The row therefore carries the counts,
    // and `priced === asked > 0` is the invariant on either shape: a decision that ran spends one
    // call, because the counter increments before the request (`withCallCounter`).
    if (item.selector === 'model') {
      const spend = item.spend;
      if (spend === undefined) {
        issues.push(
          `BIRD1: ${item.arm} decides with the model and does not say how many of its decisions were priced; an uncounted selector is indistinguishable from a free one`,
        );
      } else if (!(spend.asked > 0) || spend.priced < spend.asked) {
        issues.push(
          `BIRD1: ${item.arm} needed a decision on ${String(spend.asked)} cases and priced ${String(spend.priced)} of them; the selector call is not counted`,
        );
      }
    }
    // A rule that decides in no call has two ways to be wrong about its price, and they point in
    // opposite directions: a mean above its candidate count is a call it did not make (the arm was
    // measured with a selector and published under the rule's name), and a priced decision is a
    // call it did not spend (the bill was copied from the parent's row). Both are invisible to the
    // accuracy, and the first one is the exact defect `I-96` exists to retire — a rule arm that is
    // secretly a four-call arm would report the parent's number at the child's price.
    if (typeof item.selector === 'string' && item.selector.startsWith('rule:')) {
      if (samples !== undefined && mean > samples) {
        issues.push(
          `BIRD1: ${item.arm} selects with ${item.selector} and reports ${String(mean)} calls per case against ${String(samples)} candidates; the rule spends no call, so the mean is a selector that is still being bought`,
        );
      }
      if (typeof item.spend?.priced === 'number' && item.spend.priced > 0) {
        issues.push(
          `BIRD1: ${item.arm} selects with ${item.selector} and prices ${String(item.spend.priced)} decisions; a rule buys nothing and a bill here belongs to a call the row does not admit to`,
        );
      }
      if (item.selectorRule === undefined) {
        issues.push(
          `BIRD1: ${item.arm} selects with ${item.selector} and its row carries no rule funnel; the mean equals its candidate count either way, so nothing here says the rule decided`,
        );
      }
    }
    // A pooled arm's candidates are the ones the arm it names already paid for, so it must spend
    // strictly less: an arm that regenerates them costs what its parent costs, which is the one thing
    // a shared pool exists to avoid — and it would do it while reporting the parent's candidates as
    // its own reading. This is the check a mean *can* make, and it is the reason the two live together.
    if (pooled) {
      const sourceMean = (report.arms ?? []).find((row) => row.arm === item.pool)?.calls?.mean;
      if (typeof sourceMean === 'number' && !(mean < sourceMean)) {
        issues.push(
          `BIRD1: ${item.arm} reuses the pool of ${item.pool} and spends ${String(mean)} calls per case against its ${String(sourceMean)}; the candidates were drawn twice, so the pair measures the pool's noise rather than the lever`,
        );
      }
    }
    // Only an arm whose selector is the model must spend a call on it. A majority vote reads the same
    // candidates with no model, so `calls == samples` is its correct price — the first version of this
    // check could not tell the two apart and would have failed an arm that was right. A pooled arm is
    // exempt from the *level* for the reason above: it pays for a decision and for no candidates.
    if (!pooled && samples !== undefined && item.selector === 'model' && mean <= samples) {
      issues.push(`BIRD1: ${item.arm} samples ${String(samples)} times, selects with the model, and reports ${String(mean)} calls per case; the selector call is not counted`);
    }
    if (!pooled && samples === undefined && mean < 1) {
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
  const floorSecond = baseline.floorSecondModel?.[split];
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
  // The instrument's settings, without which two runs of one configuration cannot be compared:
  // a deadline shorter than the model needs produces "model failures" that are the harness's.
  const instrument = report.run;
  if (instrument === undefined) {
    issues.push('BIRD1: the report does not record the deadline, concurrency or retry budget it ran with, so two runs cannot be compared');
  } else {
    if (!(instrument.timeoutMs >= 1000)) issues.push(`BIRD1: the report ran with a ${String(instrument.timeoutMs)}ms deadline`);
    if (!(instrument.concurrency >= 1)) issues.push(`BIRD1: the report ran at concurrency ${String(instrument.concurrency)}`);
    if (!(instrument.retries >= 1)) issues.push(`BIRD1: the report claims ${String(instrument.retries)} retries`);
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
  // A floor is a rate over the questions it was taken on. Enforcing it on 298 of 500
  // questions would read a subset's noise as a regression — and, worse, would let a subset
  // run clear a floor and be cited as a pass. Neither direction is available: the subset is
  // recorded, its accuracy is printed, and no floor is applied. This is checked before the
  // model, because it names the more fundamental reason this run is not comparable.
  if (declaredSubset) {
    notes.push(`BIRD1: the ${split} floors were taken on the full sample, so they do not apply to ${scored} of ${available} questions; no accuracy floor was enforced`);
    return { issues, notes };
  }
  if (floorModel !== undefined && model !== floorModel) {
    notes.push(`BIRD1: the floors for ${split} were taken with ${floorModel} and this run used ${model}; accuracy is a measurement across models, so only the structural checks apply`);
    return { issues, notes };
  }

  const tolerance = baseline.tolerancePp;
  // Which arms drew candidates from a second model, read from the report rather than from a
  // table in this file: the arm definitions live in `eval/bird/run.ts`, and a second copy
  // here would be a list to keep in step by hand.
  const secondArms = new Set(
    (report.mixedCandidatePrompts ?? [])
      .filter((entry) => (entry.sources ?? []).some((source) => source.endsWith('@second')))
      .map((entry) => entry.arm),
  );
  for (const [name, floor] of Object.entries(floors)) {
    const arm = byArm.get(name);
    if (arm === undefined) continue; // already reported as a missing expected arm
    // A floor on an arm that samples a second model is a claim about two models, and the
    // second one is the coordinate that was still missing: the dev floor for `select-cross`
    // was taken with `deepseek-chat` writing the `@second` candidate, and the same arm with
    // `glm-4-flash` is a different experiment. Enforcing the floor there would either fail
    // a legitimate run or, worse, pass a regression by coincidence.
    if (secondArms.has(name)) {
      if (floorSecond === undefined) {
        issues.push(`BIRD1: the floor for ${split}/${name} does not say which second model wrote its candidates, so a run that swapped that model would be judged on a number it never derived`);
        continue;
      }
      if (report.secondModel !== floorSecond) {
        notes.push(`BIRD1: the floor for ${name} was taken with ${floorSecond} as the second model and this run used ${String(report.secondModel)}; accuracy is a measurement across second models, so no floor was enforced`);
        continue;
      }
    }
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

  // The ceiling of a sampling arm, in the same table as its score.
  //
  // `candidateRecall` is the share of questions whose candidate set held an answer, and it
  // is the hard bound on accuracy: `candidateRecall − selectionLoss = passed`. The score is
  // therefore a *product* of two mechanisms, and a run can trade one for the other without
  // the product moving — a selector that gains exactly what the candidate set lost reports
  // 61% over a set that answers 5pp fewer questions, and every published number looks
  // healthy while the arm's headroom is gone. That trade is not hypothetical: on Mini-Dev
  // `select-mixed` carries a ceiling of 58.8% against `select`'s 61.6% and returns a higher
  // score (57.8% vs 56.0%), which is a deliberate purchase with a price the accuracy column
  // does not show. A floor on the ceiling is how the price stays visible.
  //
  // The floors are the minimum observed across the recent runs, exactly like the accuracy
  // floors, and they are enforced with the same tolerance: both are proportions over the
  // same questions, so the noise that made 4pp the accuracy threshold applies here too. The
  // observed run-to-run spread of the ceiling is smaller than that (0.8–2.6pp across six
  // Mini-Dev runs), so 4pp is the safe side of the measurement rather than a loosening.
  const recallFloors = baseline.recallFloors?.[split] ?? {};
  for (const [name, floor] of Object.entries(recallFloors)) {
    // A floor that names an arm this split never runs is a floor nothing will notice. The
    // accuracy table had the same defect when `select-cross` was left out of
    // `armsBySplit.dev`, and the fix was to make the arm list the authority.
    if (!expectedArms.includes(name)) {
      issues.push(`BIRD1: the ceiling floor for ${split}/${name} is on an arm this split does not run, so it is a floor nothing will notice`);
      continue;
    }
    const arm = byArm.get(name);
    if (arm === undefined) continue; // already reported as a missing expected arm
    if (secondArms.has(name) && report.secondModel !== floorSecond) {
      // The same coordinate the accuracy floor refuses to cross: the ceiling is a property
      // of *which models wrote the candidates*, so a second-model swap is a measurement
      // rather than a regression. The note is already printed by the accuracy floor.
      continue;
    }
    const recall = arm.candidateRecall;
    if (typeof recall !== 'number') {
      issues.push(
        `BIRD1: ${name} samples candidates and its row carries no ceiling, so the ${floor}% ceiling floor cannot be enforced and the score could be bought with a shrinking candidate set`,
      );
      continue;
    }
    if (typeof arm.total !== 'number' || arm.total <= 0 || recall > arm.total) {
      issues.push(`BIRD1: ${name} reports ${String(recall)} of ${String(arm.total)} cases with an answer in the candidate set`);
      continue;
    }
    const share = (recall / arm.total) * 100;
    // Two fields, one reading. The artifact writes the count and the share, and a report
    // whose share does not follow from its own count is an instrument that will be quoted
    // for whichever of the two its reader happened to look at.
    if (typeof arm.candidateRecallShare === 'number' && Math.abs(arm.candidateRecallShare * 100 - share) > 0.1) {
      issues.push(
        `BIRD1: ${name} reports a ceiling share of ${(arm.candidateRecallShare * 100).toFixed(1)}% for ${String(recall)} of ${String(arm.total)} cases, so the two fields disagree`,
      );
    }
    if (typeof floor !== 'number' || !(floor > 0)) {
      issues.push(`BIRD1: the ceiling floor for ${split}/${name} is ${JSON.stringify(floor)}, which is not a share`);
      continue;
    }
    if (share < floor - tolerance) {
      issues.push(
        `BIRD1: ${name} answers ${share.toFixed(1)}% of questions at best, below the ${String(floor)}% ceiling floor less ${String(tolerance)}pp; the score may be masking a candidate set that lost its headroom`,
      );
    }
  }
  // ...and a sampling arm with no ceiling floor is visible rather than silent. The rows that
  // report a ceiling are read from the report, not from a list in this file, so a new arm
  // arrives with its own reading instead of waiting to be added to a table here.
  for (const item of report.arms ?? []) {
    if (typeof item.candidateRecall !== 'number') continue;
    if (recallFloors[item.arm] === undefined) {
      notes.push(`BIRD1: ${item.arm} reports a ceiling of ${((item.candidateRecall / item.total) * 100).toFixed(1)}% and has no ceiling floor; its first measurement is recorded, not enforced`);
    }
  }
  return { issues, notes };
}

/**
 * The pairs a split declares, checked against what the split runs and what the run read.
 *
 * A declared pair is a promise that a delta will be measured inside one run rather than
 * reconstructed across two. Two ways to break that promise, and they fail differently: an arm the
 * split does not run means the reading can never be taken (a declaration that outlived its arm
 * list), and a pair the run did not read means it was taken somewhere else — which is exactly the
 * shape of the `+3.6pp` that two runs produced and one run contradicts.
 *
 * @returns {string[]}
 */
export function pairIssues(declarations, baseline, split, readings, requested) {
  const issues = [];
  const declared = declarations === undefined || declarations === null ? undefined : declarations[split];
  if (declared === undefined) return issues;
  if (!Array.isArray(declared)) {
    issues.push(`BIRD1: pairs.json[${split}] is not a list of pairs`);
    return issues;
  }
  const arms = new Set(baseline.armsBySplit?.[split] ?? baseline.expectedArms ?? []);
  // A run that declares a subset of arms is measured on that subset. `bird-model.yml` asks two or
  // three arms about one prompt, so a pair it never requested is not a promise it broke — the same
  // treatment the arm list and the sample size already get from a declaration.
  const asked = Array.isArray(requested) ? new Set(requested) : undefined;
  const applicable = [];
  for (const pair of declared) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((name) => typeof name !== 'string')) {
      issues.push(`BIRD1: pairs.json[${split}] carries an entry that is not a pair of arm names`);
      continue;
    }
    const [left, right] = pair;
    if (asked !== undefined && (!asked.has(left) || !asked.has(right))) continue;
    applicable.push([left, right]);
  }
  // One sentence for the whole file rather than one per pair: a run that skipped the step skipped
  // all of them, and four identical failures is a worse error message than one that counts them.
  if (applicable.length > 0 && (readings === undefined || readings === null)) {
    issues.push(
      `BIRD1: ${split} declares ${String(applicable.length)} paired reading(s) and this run wrote none; run \`pnpm bench:bird:pair --declared eval/out/bird-eval.json\` before the gate`,
    );
  }
  const read = new Map();
  for (const pair of Array.isArray(readings?.pairs) ? readings.pairs : []) read.set(`${pair.left}\u0000${pair.right}`, pair);
  for (const pair of applicable) {
    const [left, right] = pair;
    for (const arm of [left, right]) {
      if (!arms.has(arm)) {
        issues.push(`BIRD1: the pair ${left} -> ${right} is declared for ${split} and ${arm} is not in that split's arm list, so the reading it promises can never be taken`);
      }
    }
    if (readings === undefined || readings === null) continue;
    const found = read.get(`${left}\u0000${right}`);
    if (found === undefined) {
      issues.push(`BIRD1: the pair ${left} -> ${right} is declared for ${split} and this run did not read it`);
    } else if (Array.isArray(found.missing)) {
      issues.push(`BIRD1: the pair ${left} -> ${right} is declared for ${split} and this run did not score ${found.missing.join(', ')}`);
    } else if (found.examined === 0) {
      issues.push(`BIRD1: the pair ${left} -> ${right} shares no question in this run, so the reading it produced is empty`);
    }
  }
  return issues;
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
  // A row for an arm that decides with the model carries the decision counts, because a row without
  // them is refused before anything else in it is read. Fixtures that are not about this field get a
  // complete one from here; the fixtures that are about it say `spend: undefined` to omit it.
  const arm = (name, passed, total = 100, extra = {}) => ({
    arm: name,
    passed,
    total,
    calls: { mean: 1, max: 1 },
    ...(extra.selector === 'model' && !('spend' in extra) ? { spend: { asked: total, priced: total } } : {}),
    ...extra,
  });
  const run = { timeoutMs: 60000, concurrency: 8, retries: 3 };
  // Every fixture names a corpus, because a rate is about one. The fixtures that are about the
  // declaration take it away on purpose.
  const report = (arms, scored = 100, split = 'minidev', model = 'deepseek-chat') => ({
    selection: { scored, split },
    model,
    run,
    arms,
    corpus: { digest: 'aaa', rows: 500, questions: 498 },
  });
  const fail = (result, count, why) => {
    if (result.issues.length !== count) issues.push(why);
  };

  fail(compare(report([arm('names', 42), arm('inline', 47)]), baseline), 0, 'BIRD1 has no self-test: a passing run was rejected');
  fail(compare(report([arm('names', 37), arm('inline', 47)]), baseline), 0, 'BIRD1 fails a run inside the noise threshold, which is not a regression');
  fail(compare(report([arm('names', 30), arm('inline', 52)]), baseline), 1, 'BIRD1 does not catch an arm 10pp below its floor');
  fail(compare(report([arm('names', 42)]), baseline), 1, 'BIRD1 does not notice an expected arm that vanished');
  fail(compare(report([arm('names', 42), arm('inline', 51)], 60), baseline), 1, 'BIRD1 does not notice the sample shrinking');

  const empty = compare({ arms: [] }, baseline);

  const unstable = compare({ selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', run, aa: { delta: 0.085 }, arms: [arm('names', 42), arm('inline', 51)] }, baseline);
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

  // ...and the same split-scoped check has to read a declared subset. `bird-model.yml`
  // scored 298 of Mini-Dev's 500 questions to compare two models on one prompt; the artifact
  // said so in selection.requested, and the gate failed it for the sample it declared.
  const subsetReport = (extra) => ({
    selection: { scored: 298, available: 500, requested: 300, split: 'minidev' },
    model: 'deepseek-reasoner',
    run,
    armsRequested: ['inline'],
    arms: [arm('inline', 100, 298)],
    corpus: { digest: 'aaa', rows: 500, questions: 498 },
    ...extra,
  });
  // The fixture baseline above scores 100 questions; these cases are about Mini-Dev's real
  // 500, so they say so rather than reusing a scale that makes 298 look full.
  const bigSample = { ...baseline, scoredBySplit: { minidev: 500, dev: 1532 } };
  const declaredSubsetRun = compare(subsetReport({}), bigSample);
  fail(declaredSubsetRun, 0, 'BIRD1 fails a run that declared the sample it scored');
  if (!declaredSubsetRun.notes.some((note) => note.includes('declared subset'))) {
    issues.push('BIRD1 does not say that a declared subset is a subset');
  }
  // The floor must be off, not merely passed: 33.6% against a 50% floor has to raise the
  // same note and no issue, because 298 questions are not the 500 the floor was taken on.
  const weakSubset = compare(subsetReport({}), bigSample);
  if (
    weakSubset.issues.length !== 0 ||
    !weakSubset.notes.some((note) => note.includes('no accuracy floor was enforced'))
  ) {
    issues.push('BIRD1 enforces a full-sample floor on a declared subset');
  }
  // ...and the declaration cannot excuse a sample that shrank without saying so.
  const undeclaredSubset = compare(subsetReport({ selection: { scored: 298, available: 500, split: 'minidev' } }), bigSample);
  if (!undeclaredSubset.issues.some((issue) => issue.includes('sample changed'))) {
    issues.push('BIRD1 accepts 298 of 500 questions when the run declared no sample');
  }
  // A declaration is checked against the split and against the rows it published: a claim
  // of 600 questions from a 500-question split, or 400 rows from a 300-question request, is
  // a broken instrument rather than a small sample.
  const impossibleRequest = compare(subsetReport({ selection: { scored: 298, available: 500, requested: 600, split: 'minidev' } }), bigSample);
  if (!impossibleRequest.issues.some((issue) => issue.includes('has 500'))) {
    issues.push('BIRD1 accepts a request for more questions than the split holds');
  }
  const moreRowsThanAsked = compare(subsetReport({ selection: { scored: 400, available: 500, requested: 300, split: 'minidev' } }), bigSample);
  if (!moreRowsThanAsked.issues.some((issue) => issue.includes('published 400 rows'))) {
    issues.push('BIRD1 accepts more scored rows than the run asked for');
  }
  const nonNumeric = compare(subsetReport({ selection: { scored: 298, available: 500, requested: 'all', split: 'minidev' } }), bigSample);
  if (!nonNumeric.issues.some((issue) => issue.includes('not a sample size'))) {
    issues.push('BIRD1 accepts a sample declaration that is not a number');
  }

  // A report that names two splits. Every dev artifact said mini_dev_sqlite at the top
  // level while selection said dev; the field was read by nothing, so nothing noticed.
  const twoSplits = compare({ ...report([arm('names', 42), arm('inline', 51)]), split: 'mini_dev_sqlite' }, baseline);
  if (!twoSplits.issues.some((issue) => issue.includes('one of them is wrong'))) {
    issues.push('BIRD1 accepts a report whose two split fields disagree');
  }

  // The same disagreement one field over. Both directions, because the failure that produced
  // this check was the quiet one: an artifact from a 1,532-question sweep whose `dataset` said
  // `bird-mini-dev`, read by `live-summary` and printed into the summary.
  const wrongName = compare({ ...report([arm('names', 42), arm('inline', 51)]), dataset: 'bird-dev' }, baseline);
  if (!wrongName.issues.some((issue) => issue.includes('written by hand'))) {
    issues.push('BIRD1 accepts a report whose dataset name disagrees with its split');
  }
  const rightName = compare({ ...report([arm('names', 42), arm('inline', 51)]), dataset: 'bird-mini-dev' }, baseline);
  if (rightName.issues.some((issue) => issue.includes('written by hand'))) {
    issues.push('BIRD1 rejects a report whose dataset name matches its split');
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
      run,
      arms: [{ ...arm('inline+repair', 50), repair: { total: 100, firstPass: 90, ranOnceWrong: 0, repaired: 20, fixedByRepair: 5, stillFailing: 15, byClass: [] } }],
    },
    { ...baseline, expectedArms: ['inline+repair'] },
  );
  if (!otherModelBadFunnel.issues.some((issue) => issue.includes('does not add up'))) {
    issues.push('BIRD1 skips its structural checks on a run by another model, which is why bird-model ran with no gate at all');
  }

  // Provenance: a report that omits the model, a floors table that omits the model it was
  // taken on, and a cross-model arm with no second model named.
  const anonymous = compare({ selection: { scored: 100, split: 'minidev' }, run, arms: [arm('names', 42), arm('inline', 51)] }, baseline);
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
  // An unrecorded instrument is its own issue: two runs of one configuration that differ by
  // deadline are not two measurements of the same thing.
  const unrecorded = compare({ ...report([arm('names', 42), arm('inline', 51)]), run: undefined }, baseline);
  if (!unrecorded.issues.some((issue) => issue.includes('cannot be compared'))) {
    issues.push('BIRD1 accepts a report that does not record the deadline it ran with');
  }
  const shortDeadline = compare({ ...report([arm('names', 42), arm('inline', 51)]), run: { ...run, timeoutMs: 500 } }, baseline);
  if (!shortDeadline.issues.some((issue) => issue.includes('ms deadline'))) {
    issues.push('BIRD1 accepts a 500ms deadline as a measurement');
  }
  // The decomposition lever, in the three shapes it fails: not reported at all, reported
  // with a share that does not follow from its own counts, and reported honestly as a
  // format the model ignored.
  const silentDecomposition = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', run, arms: [arm('select-mixed+dc', 60, 100, { vote: 4, selector: 'model', calls: { mean: 5, max: 5 } })] },
    { ...baseline, expectedArms: ['select-mixed+dc'] },
  );
  if (!silentDecomposition.issues.some((issue) => issue.includes('reports none'))) {
    issues.push('BIRD1 accepts a decomposition arm that never says whether the model decomposed');
  }
  const mismatchedShare = compare(
    {
      selection: { scored: 100, split: 'minidev' },
      model: 'deepseek-chat',
      run,
      arms: [arm('select-mixed+dc', 60, 100, { vote: 4, selector: 'model', calls: { mean: 5, max: 5 }, decomposition: { asked: 100, fired: 80, share: 0.95, meanSteps: 3 } })],
    },
    { ...baseline, expectedArms: ['select-mixed+dc'] },
  );
  if (!mismatchedShare.issues.some((issue) => issue.includes('decomposition share'))) {
    issues.push('BIRD1 accepts a decomposition share that its own counts contradict');
  }
  const ignoredFormat = compare(
    {
      selection: { scored: 100, split: 'minidev' },
      model: 'deepseek-chat',
      run,
      arms: [arm('select-mixed+dc', 60, 100, { vote: 4, selector: 'model', calls: { mean: 5, max: 5 }, decomposition: { asked: 100, fired: 30, share: 0.3, meanSteps: 1.2 } })],
    },
    { ...baseline, expectedArms: ['select-mixed+dc'] },
  );
  if (!ignoredFormat.issues.some((issue) => issue.includes('longer prompt'))) {
    issues.push('BIRD1 accepts an arm whose decomposition prompt was ignored by the model');
  }
  const honestDecomposition = compare(
    {
      selection: { scored: 100, split: 'minidev' },
      model: 'deepseek-chat',
      run,
      arms: [arm('select-mixed+dc', 60, 100, { vote: 4, selector: 'model', calls: { mean: 5, max: 5 }, decomposition: { asked: 98, fired: 90, share: 90 / 98, meanSteps: 2.7 } })],
    },
    { ...baseline, expectedArms: ['select-mixed+dc'] },
  );
  if (honestDecomposition.issues.length !== 0) {
    issues.push(`BIRD1 rejects a decomposition arm that reports what it did (${honestDecomposition.issues.join('; ')})`);
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
      run,
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
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', run, arms: [arm('select5', 58, 100, { vote: 5, selector: 'model', calls: { mean: 5, max: 5 } })] },
    { ...baseline, expectedArms: ['select5'] },
  );
  if (!lyingSamples.issues.some((issue) => issue.includes('selector call is not counted'))) {
    issues.push('BIRD1 does not notice a sampling arm whose selector call is missing from its cost');
  }
  const lyingRepair = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', run, arms: [arm('select5', 58, 100, { vote: 5, selector: 'model', calls: { mean: 6, max: 6 }, repaired: 496 })] },
    { ...baseline, expectedArms: ['select5'] },
  );
  if (!lyingRepair.issues.some((issue) => issue.includes('no repair funnel'))) {
    issues.push('BIRD1 does not notice a repaired count on an arm that cannot repair');
  }
  // ...and the opposite mistake: a majority vote spends exactly one call per sample, so
  // an arm whose selector is not the model must not be accused of hiding a selector call.
  const majorityPriced = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', run, arms: [arm('vote', 55, 100, { vote: 3, selector: 'majority', calls: { mean: 3, max: 3 } })] },
    { ...baseline, expectedArms: ['vote'] },
  );
  if (majorityPriced.issues.length !== 0) {
    issues.push(`BIRD1 accuses a majority-vote arm of hiding a selector call (${majorityPriced.issues.join('; ')})`);
  }
  // The third shape, and the one `41440646002` was refused for: a pooled arm pays for its decision
  // and for no candidates at all, so one call per case is its price rather than its defect. The pair
  // of rows below is what the eight-arm run produced on four arms, and the rule that prices a
  // sampling arm rejected every one of them.
  const pooledArm = (overrides) => ({
    arm: 'select-cross-pooled',
    passed: 60,
    total: 100,
    vote: 3,
    selector: 'model',
    pool: 'select-cross',
    calls: { mean: 1, max: 1 },
    spend: { asked: 100, priced: 100 },
    ...overrides,
  });
  const pooledReport = (row) => ({
    selection: { scored: 100, split: 'minidev' },
    model: 'deepseek-chat',
    run,
    arms: [arm('select-cross', 60, 100, { vote: 3, selector: 'model', calls: { mean: 4, max: 4 } }), row],
  });
  const pooledPriced = compare(pooledReport(pooledArm({})), { ...baseline, expectedArms: ['select-cross', 'select-cross-pooled'] });
  if (pooledPriced.issues.length !== 0) {
    issues.push(`BIRD1 refuses a pooled arm for reporting the one call it makes (${pooledPriced.issues.join('; ')})`);
  }
  // A pooled arm whose decisions are not all priced is the defect the mean cannot see: 0.99 is
  // "three cases never reached the selector" on one arm and "the selector is not counted" on another.
  const pooledUnpriced = compare(pooledReport(pooledArm({ calls: { mean: 0.97, max: 1 }, spend: { asked: 100, priced: 97 } })), {
    ...baseline,
    expectedArms: ['select-cross', 'select-cross-pooled'],
  });
  if (!pooledUnpriced.issues.some((issue) => issue.includes('selector call is not counted'))) {
    issues.push('BIRD1 does not notice a pooled arm that leaves some of its decisions unpriced');
  }
  const pooledSilent = compare(pooledReport(pooledArm({ spend: undefined })), { ...baseline, expectedArms: ['select-cross', 'select-cross-pooled'] });
  if (!pooledSilent.issues.some((issue) => issue.includes('does not say how many of its decisions were priced'))) {
    issues.push('BIRD1 accepts a pooled arm that never says whether its selector was counted');
  }
  // ...and the failure the whole pooling exists to avoid: an arm that regenerates its candidates and
  // reports the parent's pool as its own reading.
  const pooledRedrawn = compare(pooledReport(pooledArm({ calls: { mean: 4, max: 4 } })), { ...baseline, expectedArms: ['select-cross', 'select-cross-pooled'] });
  if (!pooledRedrawn.issues.some((issue) => issue.includes('candidates were drawn twice'))) {
    issues.push('BIRD1 accepts a pooled arm that spends as many calls as the arm whose pool it claims to share');
  }
  // The same invariant on a *generating* arm, which the mean could only bound from below: `mean > vote`
  // passes with 3.5 calls on 3 samples, so half the decisions could be unpriced and the level check
  // would still be satisfied. The counts close that interval, and they are the reason the field is
  // published for every arm that decides rather than only for the pooled ones.
  const generatedUnpriced = compare(pooledReport(
    arm('select-cross', 60, 100, { vote: 3, selector: 'model', calls: { mean: 3.96, max: 4 }, spend: { asked: 100, priced: 96 } }),
  ), { ...baseline, expectedArms: ['select-cross', 'select-cross-pooled'] });
  if (!generatedUnpriced.issues.some((issue) => issue.includes('selector call is not counted'))) {
    issues.push('BIRD1 does not notice a generating arm that leaves some of its decisions unpriced');
  }
  const generatedSilent = compare(pooledReport(
    arm('select-cross', 60, 100, { vote: 3, selector: 'model', calls: { mean: 4, max: 4 }, spend: undefined }),
  ), { ...baseline, expectedArms: ['select-cross', 'select-cross-pooled'] });
  if (!generatedSilent.issues.some((issue) => issue.includes('does not say how many of its decisions were priced'))) {
    issues.push('BIRD1 accepts a generating arm that never says whether its selector was counted');
  }
  // A pooled arm with no decision to make — a majority vote over a shared pool — is free, and the
  // rule above must not demand a spent call from it.
  const pooledFree = compare(pooledReport(pooledArm({ selector: 'majority', calls: { mean: 0, max: 0 }, spend: undefined })), {
    ...baseline,
    expectedArms: ['select-cross', 'select-cross-pooled'],
  });
  if (pooledFree.issues.length !== 0) {
    issues.push(`BIRD1 demands a spent call from a pooled majority vote (${pooledFree.issues.join('; ')})`);
  }
  // The free selector, three rows: the correct one, one that pays a call it does not make, and one
  // that prices a decision it never bought. The second is the shape `I-96` spent a round arguing
  // against — a rule arm that is a four-call arm with a different name — and the third is the same
  // mistake as `41440646002` in the opposite direction.
  const ruleArm = (overrides = {}) => ({
    arm: 'select-mixed-rule',
    passed: 58,
    total: 100,
    vote: 3,
    selector: 'rule:shortest',
    calls: { mean: 3, max: 3 },
    selectorRule: { rule: 'shortest', decided: 100, eligible: 300, emptyPool: 2 },
    ...overrides,
  });
  const ruleReport = (row) => ({
    selection: { scored: 100, split: 'minidev' },
    model: 'deepseek-chat',
    run,
    arms: [arm('select-mixed', 56, 100, { vote: 3, selector: 'model', calls: { mean: 4, max: 4 } }), row],
  });
  const ruleExpected = { ...baseline, expectedArms: ['select-mixed', 'select-mixed-rule'] };
  const ruleClean = compare(ruleReport(ruleArm()), ruleExpected);
  if (ruleClean.issues.length !== 0) {
    issues.push(`BIRD1 refuses a rule arm for reporting the calls it actually made (${ruleClean.issues.join('; ')})`);
  }
  const ruleBuying = compare(ruleReport(ruleArm({ calls: { mean: 4, max: 4 } })), ruleExpected);
  if (!ruleBuying.issues.some((issue) => issue.includes('still being bought'))) {
    issues.push('BIRD1 accepts a rule arm whose cost is a call the rule does not make');
  }
  const rulePriced = compare(ruleReport(ruleArm({ spend: { asked: 100, priced: 100 } })), ruleExpected);
  if (!rulePriced.issues.some((issue) => issue.includes('buys nothing'))) {
    issues.push('BIRD1 accepts a rule arm that prices decisions it never bought');
  }
  const ruleSilent = compare(ruleReport(ruleArm({ selectorRule: undefined })), ruleExpected);
  if (!ruleSilent.issues.some((issue) => issue.includes('no rule funnel'))) {
    issues.push('BIRD1 accepts a rule arm whose row never says the rule decided');
  }

  // The reconcile funnel, whose last column is nested by policy. `41453395203` reported 595 runnable
  // and 595 adopted under `'always'` and was right; the `-novel` arm reports fewer adopted than
  // runnable *on purpose*, so the two relationships have to be checked against the policy the row
  // carries rather than against each other.
  const reconcileReport = (funnel) => ({
    selection: { scored: 100, split: 'minidev' },
    model: 'deepseek-chat',
    run,
    arms: [arm('select-cross', 60, 100, { vote: 3, selector: 'model', calls: { mean: 4, max: 4 } }), arm('reconciled', 64, 100, { vote: 3, selector: 'model', pool: 'select-cross', reconcile: funnel })],
  });
  const reconcileScope = { ...baseline, expectedArms: ['select-cross', 'reconciled'] };
  const adopting = compare(reconcileReport({ policy: 'always', asked: 100, returned: 100, novel: 14, executable: 99, adopted: 99 }), reconcileScope);
  if (adopting.issues.length !== 0) {
    issues.push(`BIRD1 refuses an arm that adopts every statement it can run (${adopting.issues.join('; ')})`);
  }
  const handingBack = compare(reconcileReport({ policy: 'novel', asked: 100, returned: 100, novel: 14, executable: 99, adopted: 12 }), reconcileScope);
  if (handingBack.issues.length !== 0) {
    issues.push(`BIRD1 refuses an arm that hands restatements back to the vote (${handingBack.issues.join('; ')})`);
  }
  const policyFree = compare(reconcileReport({ asked: 100, returned: 100, novel: 14, executable: 99, adopted: 12 }), reconcileScope);
  if (!policyFree.issues.some((issue) => issue.includes('without the policy it was read under'))) {
    issues.push('BIRD1 accepts a reconcile funnel that does not say which policy produced its adopted column');
  }
  const uncounted = compare(reconcileReport({ policy: 'always', asked: 100, returned: 100, novel: 14, executable: 120, adopted: 120 }), reconcileScope);
  if (!uncounted.issues.some((issue) => issue.includes('counted one reply twice'))) {
    issues.push('BIRD1 accepts a reconcile funnel that adopts more replies than it received');
  }
  const adoptingLess = compare(reconcileReport({ policy: 'always', asked: 100, returned: 100, novel: 14, executable: 99, adopted: 80 }), reconcileScope);
  if (!adoptingLess.issues.some((issue) => issue.includes('replies the funnel says were not scored'))) {
    issues.push('BIRD1 accepts an adopting arm whose score covers replies its funnel says it did not score');
  }
  const handingBackTooMany = compare(reconcileReport({ policy: 'novel', asked: 100, returned: 100, novel: 14, executable: 99, adopted: 40 }), reconcileScope);
  if (!handingBackTooMany.issues.some((issue) => issue.includes('restatements it declines are in its score'))) {
    issues.push('BIRD1 accepts a novel-only arm that adopted more statements than it says nobody wrote');
  }
  const harnessBroken = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', run, arms: [arm('names', 42, 100, { errors: { harness: 3, llm: 0 } })] },
    { ...baseline, expectedArms: ['names'] },
  );
  if (!harnessBroken.issues.some((issue) => issue.includes('measures a bug'))) {
    issues.push('BIRD1 accepts an arm whose cases failed inside the harness');
  }
  const unpriced = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', run, arms: [{ arm: 'names', passed: 42, total: 100 }] },
    { ...baseline, expectedArms: ['names'] },
  );
  if (!unpriced.issues.some((issue) => issue.includes('cannot be priced'))) {
    issues.push('BIRD1 does not notice an arm that reports no calls at all');
  }

  // The lever-with-no-input case: the arms are present, the blocks are not.
  // The arms have to be in the report for their blocks to be checked: the condition is that
  // the arm ran, not that the baseline lists it, so the fixture carries the rows.
  const dryLever = compare(
    {
      selection: { scored: 100, split: 'minidev' },
      model: 'deepseek-chat',
      run,
      controls: { retrievedBlocks: 0, demonstrationBlocks: 0 },
      arms: [arm('names', 42), arm('inline', 51), arm('inline+retrieval', 52), arm('inline+icl', 53)],
    },
    { ...baseline, expectedArms: ['names', 'inline', 'inline+retrieval', 'inline+icl'] },
  );
  if (dryLever.issues.filter((issue) => issue.includes('corpus is missing')).length !== 2) {
    issues.push('BIRD1 does not notice an arm whose retrieved block was never built');
  }
  // A candidate set that shrank without saying so: the case-level numbers stay healthy
  // while the ceiling measures an endpoint's quota.
  const thinCandidates = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', run, arms: [arm('select-cross', 60, 100, { vote: 3, selector: 'model', calls: { mean: 4, max: 4 }, candidateFailures: { llm: 90, engine: 0, unparsed: 0, attempted: 300 } })] },
    { ...baseline, expectedArms: ['select-cross'] },
  );
  if (!thinCandidates.issues.some((issue) => issue.includes('ceiling measures the endpoint'))) {
    issues.push('BIRD1 accepts an arm that never received a third of its candidates');
  }

  // A truncated corpus that does not say so, and one that says so and does not match.
  const silentTruncation = compare(
    {
      selection: { scored: 100, split: 'minidev' },
      model: 'deepseek-chat',
      run,
      arms: [arm('names', 42)],
      failures: { names: [{ id: '1', predicted: 'SELECT 1', reason: 'values' }] },
      failureSample: { cap: 200, total: { names: 300 }, truncated: [] },
    },
    baseline,
  );
  if (!silentTruncation.issues.some((issue) => issue.includes('does not say it truncated'))) {
    issues.push('BIRD1 accepts a failure corpus that quietly stopped at a cap');
  }
  const countedTruncation = compare(
    {
      selection: { scored: 100, split: 'minidev' },
      model: 'deepseek-chat',
      run,
      arms: [arm('names', 42)],
      failures: { names: Array.from({ length: 5 }, (_, index) => ({ id: String(index), predicted: 'SELECT 1', reason: 'values' })) },
      failureSample: { cap: 200, total: { names: 300 }, truncated: ['names'] },
    },
    baseline,
  );
  if (!countedTruncation.issues.some((issue) => issue.includes('listed as truncated'))) {
    issues.push('BIRD1 accepts a failure corpus whose truncation claim disagrees with its contents');
  }

  // The empty-result lever, in three broken shapes and one working one. An arm that
  // claims the lever without its funnel is describing a mechanism nobody can price; a
  // funnel whose recovery exceeds its reach is arithmetic that did not happen; and a
  // lever that neither dropped nor retried anything across a full split did not run.
  const unpricedLever = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', run, arms: [arm('select-mixed+empty', 60, 100, { vote: 3, selector: 'model', calls: { mean: 4, max: 5 }, emptyRetry: { mode: 'diagnosed' } })] },
    { ...baseline, expectedArms: ['select-mixed+empty'] },
  );
  if (!unpricedLever.issues.some((issue) => issue.includes('does not report its funnel'))) {
    issues.push('BIRD1 accepts an empty-result lever with no funnel behind it');
  }
  const impossibleLever = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', run, arms: [arm('select-mixed+empty', 60, 100, { vote: 3, selector: 'model', calls: { mean: 4, max: 5 }, emptyRetry: { mode: 'diagnosed', dropped: 3, fired: 2, recovered: 5 } })] },
    { ...baseline, expectedArms: ['select-mixed+empty'] },
  );
  if (!impossibleLever.issues.some((issue) => issue.includes('which is impossible'))) {
    issues.push('BIRD1 accepts a lever that recovers more cases than it retried');
  }
  const inertLever = compare(
    { selection: { scored: 498, split: 'minidev' }, model: 'deepseek-chat', run, arms: [arm('select-mixed+empty', 300, 498, { vote: 3, selector: 'model', calls: { mean: 4, max: 4 }, emptyRetry: { mode: 'diagnosed', dropped: 0, fired: 0, recovered: 0 } })] },
    { ...baseline, expectedArms: ['select-mixed+empty'] },
  );
  if (!inertLever.issues.some((issue) => issue.includes('the lever did not run'))) {
    issues.push('BIRD1 accepts an empty-result lever that never fired on a full split');
  }
  const workingLever = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', run, arms: [arm('select-mixed+empty', 62, 100, { vote: 3, selector: 'model', calls: { mean: 4.1, max: 5 }, emptyRetry: { mode: 'diagnosed', dropped: 4, fired: 3, recovered: 2 } })] },
    { ...baseline, expectedArms: ['select-mixed+empty'] },
  );
  if (workingLever.issues.length !== 0) {
    issues.push(`BIRD1 rejects an empty-result lever that reports what it did (${workingLever.issues.join('; ')})`);
  }

  // The values mode has a second half that spends nothing, and the check is arithmetic over both:
  // a run may recover more cases than it retried, but only by the number it grounded. Two shapes
  // are rejected — a claim that more statements were adopted for free than were grounded at all,
  // and a values arm that does not report the lookup, which is exactly the row `41830439625`
  // published before the mode was named here.
  const doubleCounted = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', run, arms: [arm('select-mixed+values', 62, 100, { vote: 3, selector: 'model', calls: { mean: 4, max: 5 }, emptyRetry: { mode: 'values', dropped: 4, fired: 3, recovered: 2, grounded: 1, adoptedFree: 2, probeQueries: 9, literalGaps: 3 } })] },
    { ...baseline, expectedArms: ['select-mixed+values'] },
  );
  if (!doubleCounted.issues.some((issue) => issue.includes('grounded statements'))) {
    issues.push('BIRD1 accepts a values arm that adopted more statements than it grounded');
  }
  const unpricedLookup = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', run, arms: [arm('select-mixed+values', 62, 100, { vote: 3, selector: 'model', calls: { mean: 4, max: 5 }, emptyRetry: { mode: 'values', dropped: 4, fired: 3, recovered: 2 } })] },
    { ...baseline, expectedArms: ['select-mixed+values'] },
  );
  if (!unpricedLookup.issues.some((issue) => issue.includes('does not report grounded'))) {
    issues.push('BIRD1 accepts a values arm with no lookup behind it');
  }
  const groundedRun = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', run, arms: [arm('select-mixed+values', 63, 100, { vote: 3, selector: 'model', calls: { mean: 4, max: 5 }, emptyRetry: { mode: 'values', dropped: 4, fired: 3, recovered: 4, grounded: 2, adoptedFree: 1, probeQueries: 11, literalGaps: 5 } })] },
    { ...baseline, expectedArms: ['select-mixed+values'] },
  );
  if (groundedRun.issues.length !== 0) {
    issues.push(`BIRD1 rejects a values arm that recovers four of three retried cases by grounding one (${groundedRun.issues.join('; ')})`);
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

  // A run may declare the arms it set out to score, and then it is a measurement of those
  // arms. `40534288883` ran six arms on dev — two of them new — and this gate failed it for
  // the two baseline arms it never requested: a red build about the arm list, on the one
  // run whose numbers mattered. The declaration is not a licence to lose a row, though, so
  // the two lists have to agree in both directions.
  const devBaseline = {
    ...baseline,
    armsBySplit: { dev: ['names', 'select-mixed'] },
    floors: { dev: { names: 41.5, 'select-mixed': 62.5 } },
    floorModel: { dev: 'deepseek-chat' },
  };
  const devReport = (arms, extra = {}) => ({
    selection: { scored: 1532, split: 'dev' },
    model: 'deepseek-chat',
    run,
    arms,
    corpus: { digest: 'dev-corpus', rows: 1534, questions: 1532 },
    ...extra,
  });
  const decomposed = { asked: 1532, fired: 1400, share: 0.914, meanSteps: 2.4 };
  const subset = compare(
    devReport([arm('names', 645, 1532), arm('decompose', 911, 1532, { decomposition: decomposed })], { armsRequested: ['names', 'decompose'] }),
    devBaseline,
  );
  fail(subset, 0, 'BIRD1 fails a run that declares the subset it scored');
  if (!subset.notes.some((note) => note.includes('select-mixed') && note.includes('did not request'))) {
    issues.push('BIRD1 does not say which baseline arm a declared subset left unchecked');
  }
  // ...and what was requested has to appear. Dropping a row is the failure this check
  // exists for, and a declaration must not be able to hide it.
  const droppedRow = compare(devReport([arm('names', 645, 1532)], { armsRequested: ['names', 'decompose'] }), devBaseline);
  fail(droppedRow, 1, 'BIRD1 accepts a run that requested an arm and published no row for it');
  if (!droppedRow.issues[0]?.includes('dropped a measurement')) {
    issues.push('BIRD1 reports a missing declared arm without saying the run dropped it');
  }
  // A row nobody declared is a row nobody chose to run, which is how an arm enters a report
  // without entering the plan.
  const undeclaredRow = compare(
    devReport([arm('names', 645, 1532), arm('decompose', 911, 1532, { decomposition: decomposed })], { armsRequested: ['names'] }),
    devBaseline,
  );
  fail(undeclaredRow, 1, 'BIRD1 accepts a row whose arm the report never declares');
  if (!undeclaredRow.issues[0]?.includes('does not declare')) {
    issues.push('BIRD1 reports an undeclared row without naming the declaration');
  }
  // An empty declaration claims to have run nothing. Reading it as "no declaration" would
  // fall back to the strict check and hide the claim instead of refusing it.
  const emptyDeclaration = compare(
    devReport([arm('names', 645, 1532)], { armsRequested: [] }),
    devBaseline,
  );
  if (!emptyDeclaration.issues.some((issue) => issue.includes('cannot describe'))) {
    issues.push('BIRD1 accepts an arm list that describes nothing');
  }
  // A declaration does not weaken a floor: the arms it does name are still enforced.
  const declaredRegression = compare(devReport([arm('names', 500, 1532)], { armsRequested: ['names'] }), devBaseline);
  if (!declaredRegression.issues.some((issue) => issue.includes('is below the'))) {
    issues.push('BIRD1 stops enforcing a floor once the run declares its arm set');
  }

  // A schema card that drops tables measures the model on a schema it cannot query. The
  // run has always reported the truncation and nothing ever read it, so a card that lost
  // half a database was indistinguishable from a hard question set.
  const cutCard = compare(
    {
      selection: { scored: 100, split: 'minidev' },
      model: 'deepseek-chat',
      run,
      controls: { tablesInPrompts: 40, tablesTotal: 75, truncatedPrompts: [{ db: 'california_schools', shown: 3, total: 6 }] },
      arms: [arm('names', 42)],
    },
    { ...baseline, expectedArms: ['names'] },
  );
  fail(cutCard, 1, 'BIRD1 accepts a schema card that dropped tables from the prompt');
  if (!cutCard.issues.some((issue) => issue.includes('california_schools') && issue.includes('3/6'))) {
    issues.push('BIRD1 reports a truncated card without naming the database and the loss');
  }
  // A samples arm with no sampled column is its parent renamed.
  const drySamples = compare(
    {
      selection: { scored: 100, split: 'minidev' },
      model: 'deepseek-chat',
      run,
      controls: { sampledColumns: 0, sampledValues: 0 },
      arms: [arm('names', 42), arm('inline+evidence+samples', 43)],
    },
    { ...baseline, expectedArms: ['names', 'inline+evidence+samples'] },
  );
  fail(drySamples, 1, 'BIRD1 accepts a samples arm whose profile supplied no values');

  // ...and the degenerate case: no table at all reached the prompt.
  const emptySchema = compare(
    { selection: { scored: 100, split: 'minidev' }, model: 'deepseek-chat', run, controls: { tablesInPrompts: 0, tablesTotal: 75 }, arms: [arm('names', 42)] },
    { ...baseline, expectedArms: ['names'] },
  );
  fail(emptySchema, 1, 'BIRD1 accepts a prompt with no schema in it');

  // A floor on an arm whose candidates come from a second model is a claim about two
  // models. `select-cross`'s dev floor was taken with `deepseek-chat` writing the `@second`
  // candidate; the same arm with `glm-4-flash` is a different measurement, and a gate that
  // enforced the floor anyway would either fail a legitimate experiment or pass a
  // regression by coincidence. Four cases: above the floor, below it, a different second
  // model, and a floor that never says which second model it was taken with.
  const crossBaseline = {
    ...baseline,
    armsBySplit: { dev: ['names', 'select-cross'] },
    floors: { dev: { names: 41.5, 'select-cross': 45 } },
    floorModel: { dev: 'deepseek-chat' },
    floorSecondModel: { dev: 'deepseek-chat' },
  };
  const crossArm = (passed) => ({ arm: 'select-cross', passed, total: 1532, vote: 3, selector: 'model', calls: { mean: 4, max: 4 }, spend: { asked: 1532, priced: 1532 } });
  const crossReport = (passed, secondModel) => ({
    selection: { scored: 1532, split: 'dev' },
    model: 'deepseek-chat',
    run,
    arms: [arm('names', 645, 1532), crossArm(passed)],
    mixedCandidatePrompts: [{ arm: 'select-cross', sources: ['inline@second', 'metadata', 'values'], questions: 1532, withAllDistinct: 1500, degenerate: 32, degenerateShare: 0.02 }],
    secondModel,
  });
  fail(compare(crossReport(800, 'deepseek-chat'), crossBaseline), 0, 'BIRD1 fails a cross arm above its floor');
  fail(compare(crossReport(600, 'deepseek-chat'), crossBaseline), 1, 'BIRD1 does not enforce a floor on a cross arm whose second model matches the floor');
  const otherSecond = compare(crossReport(600, 'glm-4-flash'), crossBaseline);
  fail(otherSecond, 0, 'BIRD1 enforces a floor taken with one second model on a run that used another');
  if (!otherSecond.notes.some((note) => note.includes('select-cross') && note.includes('glm-4-flash') && note.includes('deepseek-chat'))) {
    issues.push('BIRD1 drops a cross arm floor without naming both second models');
  }
  const unattributedSecond = compare(crossReport(800, 'deepseek-chat'), { ...crossBaseline, floorSecondModel: undefined });
  fail(unattributedSecond, 1, 'BIRD1 enforces a cross arm floor without saying which second model it was taken with');
  // An arm that did not draw from a second model is unaffected by the attribution: the
  // same missing field must not turn every floor in the split into an issue.
  const plainOnly = compare(
    { selection: { scored: 1532, split: 'dev' }, model: 'deepseek-chat', run, arms: [arm('names', 645, 1532)] },
    { ...crossBaseline, floorSecondModel: undefined, armsBySplit: { dev: ['names'] }, floors: { dev: { names: 41.5 } } },
  );
  fail(plainOnly, 0, 'BIRD1 demands a second-model attribution from an arm that has no second model');

  // The ceiling of a sampling arm, gated like its score.
  //
  // Accuracy is bounded by `candidateRecall`, and the two move independently: a selector
  // that improves by more than the candidate set lost reports a flat score over a set that
  // answers fewer questions. Guarding only the score leaves that trade silent — and it is
  // the exact trade a small-sample run can make by accident. Four shapes: a ceiling within
  // tolerance, a ceiling that fell while the score held, a ceiling that fell without being
  // reported at all, and a score that fell while the ceiling held (the direction the
  // accuracy floor already covered, kept here so neither check can mask the other).
  const ceilingBaseline = {
    ...baseline,
    expectedArms: ['select-cross', 'names'],
    floors: { minidev: { 'select-cross': 60, names: 40 } },
    floorModel: { minidev: 'deepseek-chat' },
    recallFloors: { minidev: { 'select-cross': 65.9 } },
  };
  const sampling = (passed, recall, extra = {}) => ({
    arm: 'select-cross',
    passed,
    total: 100,
    vote: 3,
    selector: 'model',
    calls: { mean: 4, max: 4 },
    spend: { asked: 100, priced: 100 },
    candidateRecall: recall,
    candidateRecallShare: recall / 100,
    ...extra,
  });
  const ceilingRun = (armRows) => ({
    selection: { scored: 100, split: 'minidev' },
    model: 'deepseek-chat',
    run,
    arms: [arm('names', 42), ...armRows],
  });
  const steadyCeiling = compare(ceilingRun([sampling(61, 66)]), ceilingBaseline);
  if (steadyCeiling.issues.length !== 0) {
    issues.push(`BIRD1 fails a sampling arm whose ceiling held (${steadyCeiling.issues.join('; ')})`);
  }
  // 61% recall against a 65.9% floor is a 4.9pp loss with the score still above its floor:
  // the case this check exists for.
  const lostCeiling = compare(ceilingRun([sampling(61, 61)]), ceilingBaseline);
  if (lostCeiling.issues.length !== 1 || !lostCeiling.issues[0].includes('ceiling')) {
    issues.push('BIRD1 does not notice a candidate set that answers 4.9pp fewer questions while the score holds');
  }
  const insideNoiseCeiling = compare(ceilingRun([sampling(61, 62.5)]), ceilingBaseline);
  if (insideNoiseCeiling.issues.length !== 0) {
    issues.push(`BIRD1 fails a ceiling inside the noise threshold, which is not a regression (${insideNoiseCeiling.issues.join('; ')})`);
  }
  // The instrument, not the number: a sampling arm that publishes a score and no ceiling
  // cannot be gated at all, and reporting it as "fine" is how the hole opened.
  const ceilless = compare(ceilingRun([{ ...sampling(61, 66), candidateRecall: undefined, candidateRecallShare: undefined }]), ceilingBaseline);
  if (!ceilless.issues.some((issue) => issue.includes('carries no ceiling'))) {
    issues.push('BIRD1 accepts a sampling arm with a score and no candidate ceiling');
  }
  // ...and the two ceiling fields have to agree with the sample they were taken on.
  const lyingCeiling = compare(ceilingRun([sampling(61, 66, { candidateRecallShare: 0.8 })]), ceilingBaseline);
  if (!lyingCeiling.issues.some((issue) => issue.includes('disagree'))) {
    issues.push('BIRD1 accepts a ceiling share that its own counts contradict');
  }
  // A floor that names an arm the split never runs is a floor nothing will notice.
  const orphanFloor = compare(ceilingRun([sampling(61, 66)]), {
    ...ceilingBaseline,
    recallFloors: { minidev: { 'select-cross': 65.9, 'select5': 63.8 } },
  });
  if (!orphanFloor.issues.some((issue) => issue.includes('floor nothing will notice'))) {
    issues.push('BIRD1 accepts a recall floor on an arm the split does not run');
  }
  // The other direction: the score falls and the ceiling does not move. Keeping this in the
  // ceiling block is what stops one check from being read as a pass for the pair. The floor
  // is 60% less the 4pp tolerance, so the fixture has to land below 56 rather than merely
  // below the floor: a run inside the noise threshold is not a regression.
  const lostScore = compare(ceilingRun([sampling(50, 66)]), ceilingBaseline);
  if (lostScore.issues.length !== 1 || !lostScore.issues[0].includes('is below the')) {
    issues.push('BIRD1 does not notice a score that fell while the ceiling held');
  }
  // A ceiling without a floor is measured and not enforced, and the gate says so rather
  // than reporting silence as a pass.
  const unflooredCeiling = compare(ceilingRun([sampling(61, 66)]), { ...ceilingBaseline, recallFloors: { minidev: {} } });
  if (!unflooredCeiling.notes.some((note) => note.includes('no ceiling floor'))) {
    issues.push('BIRD1 does not say that a sampling arm has no ceiling floor yet');
  }
  // Corpus identity. A rate is about a corpus, and BIRD re-annotated Mini-Dev in October 2026:
  // the same path can hold a different benchmark, so the digest has to be in the artifact and the
  // floors have to be pinned to one.
  const declaredRun = (corpus) => ({
    ...report([arm('names', 42), arm('inline', 51)]),
    armsRequested: ['names', 'inline'],
    ...(corpus === undefined ? { corpus: undefined } : { corpus }),
  });
  fail(compare(declaredRun({ digest: 'aaa' }), baseline), 0, 'BIRD1 fails a report that names the corpus it read');
  fail(compare(declaredRun(undefined), baseline), 1, 'BIRD1 does not notice a report that declares its arms and not its corpus');
  fail(compare(declaredRun({ digest: 'bbb' }), { ...baseline, corpus: { minidev: 'aaa' } }), 1, 'BIRD1 compares a run against floors pinned to a different corpus');
  fail(compare(declaredRun({}), baseline), 1, 'BIRD1 accepts a corpus block with no digest in it');

  // Who answered. The pin is the base the endpoint named, not the alias the run asked for, and
  // the two are separate fields because a provider can rename its own model under a stable alias.
  const serving = { ...baseline, served: { minidev: ['deepseek-flash'] } };
  const answered = (bases, model = 'deepseek-chat') =>
    report([arm('names', 42, 100, bases === undefined ? {} : { servedModels: bases }), arm('inline', 47, 100, bases === undefined ? {} : { servedModels: bases })], 100, 'minidev', model);
  fail(compare(answered({ 'deepseek-flash': 100 }), serving), 0, 'BIRD1 fails a run answered by the pinned base');
  const repointed = compare(answered({ 'deepseek-pro': 100 }), serving);
  if (!repointed.issues.some((issue) => issue.includes('re-pointed'))) {
    issues.push('BIRD1 accepts a run the endpoint answered with another base model');
  }
  const nameless = compare(answered(undefined), serving);
  if (!nameless.issues.some((issue) => issue.includes('cannot name the base that answered'))) {
    issues.push('BIRD1 accepts a scored run that cannot say which base answered it');
  }
  fail(compare(answered({ 'deepseek-flash': 60, 'deepseek-pro': 40 }), serving), 1, 'BIRD1 accepts a run whose base changed mid-run');
  const crossModelPin = compare(answered({ 'glm-4.6': 100 }, 'glm-4.6'), serving);
  if (crossModelPin.issues.some((issue) => issue.includes('re-pointed'))) {
    issues.push('BIRD1 fails a cross-model run on a pin that belongs to another model');
  }
  if (!crossModelPin.notes.some((note) => note.includes('belongs to deepseek-chat'))) {
    issues.push('BIRD1 does not say which model the base-model pin belongs to');
  }
  if (compare(answered(undefined), baseline).issues.some((issue) => issue.includes('base that answered'))) {
    issues.push('BIRD1 enforces a base-model pin on a split that has none');
  }
  const unpinned = compare(answered({ 'glm-4.6': 100 }), baseline);
  if (!unpinned.notes.some((note) => note.includes('no base model is pinned'))) {
    issues.push('BIRD1 records a base model on an unpinned split without saying it is unenforced');
  }
  if (!unpinned.notes.some((note) => note.includes('only the second field answered'))) {
    issues.push('BIRD1 does not record that the run asked for one model and was answered by another');
  }

  // The base model as behaviour. The pin is a digest over fixed probes, and the gate has to tell
  // five different states apart because only one of them is a failure: a digest that moved under
  // the same name, a run that read no fingerprint at all, a probe that answered nothing, an
  // endpoint that sampled its own probes, and a probe set of another size.
  const fingerprinted = { ...baseline, baseFingerprint: { minidev: { digest: 'aaa111', probes: 3, probeSet: 'aaaa0000bbbb1111' } } };
  const withReading = (reading, extra = {}) => ({ ...report([arm('names', 42), arm('inline', 47)]), ...(reading === undefined ? {} : { baseFingerprint: reading }), ...extra });
  const fingerprintRun = (reading, pinned = fingerprinted, extra = {}) => compare(withReading(reading, extra), pinned);
  const sameFingerprint = fingerprintRun({ digest: 'aaa111', probes: 3, stable: true, bases: ['deepseek-flash'], probeSet: 'aaaa0000bbbb1111' });
  if (sameFingerprint.issues.length !== 0) {
    issues.push('BIRD1 fails a run whose base answered its probes exactly as the pin did');
  }
  const movedFingerprint = fingerprintRun({ digest: 'bbb222', probes: 3, stable: true, bases: ['deepseek-flash'], probeSet: 'aaaa0000bbbb1111' });
  if (!movedFingerprint.issues.some((issue) => issue.includes('different weights'))) {
    issues.push('BIRD1 accepts a base model whose fixed probes came back different under the same name');
  }
  const absentFingerprint = compare(withReading(undefined), fingerprinted);
  if (!absentFingerprint.issues.some((issue) => issue.includes('cannot identify its generator'))) {
    issues.push('BIRD1 accepts a pinned run that never read a base fingerprint');
  }
  const silentFingerprint = fingerprintRun({ digest: '', probes: 0, stable: false, calls: 6, failures: ['letter-count: timed out'] });
  if (!silentFingerprint.issues.some((issue) => issue.includes('got no answer'))) {
    issues.push('BIRD1 accepts a fingerprint whose probes all failed as if it had read one');
  }
  const unstableFingerprint = fingerprintRun({ digest: 'ccc333', probes: 3, stable: false, unstable: ['letter-count'] });
  if (unstableFingerprint.issues.length !== 0 || !unstableFingerprint.notes.some((note) => note.includes('is a draw'))) {
    issues.push('BIRD1 either fails an endpoint for sampling or says nothing about why the digest was not compared');
  }
  const narrowerFingerprint = fingerprintRun({ digest: 'ddd444', probes: 2, stable: true, probeSet: 'aaaa0000bbbb1111' });
  if (narrowerFingerprint.issues.length !== 0 || !narrowerFingerprint.notes.some((note) => note.includes('different questions'))) {
    issues.push('BIRD1 compares two digests taken over different numbers of probes');
  }
  const editedProbes = fingerprintRun({ digest: 'aaa111', probes: 3, stable: true, probeSet: 'cccc2222dddd3333' });
  if (!editedProbes.issues.some((issue) => issue.includes('different probe set'))) {
    issues.push('BIRD1 lets a digest taken over edited probes pass as the pinned one');
  }
  const unpinnedFingerprint = compare(withReading({ digest: 'eee555', probes: 3, stable: true }), baseline);
  if (!unpinnedFingerprint.notes.some((note) => note.includes('no base fingerprint is pinned'))) {
    issues.push('BIRD1 records a fingerprint on an unpinned split without saying it is unenforced');
  }
  const otherModelFingerprint = fingerprintRun({ digest: 'fff666', probes: 3, stable: true }, fingerprinted, { model: 'glm-4.6' });
  if (otherModelFingerprint.issues.length !== 0 || !otherModelFingerprint.notes.some((note) => note.includes('recorded rather than enforced'))) {
    issues.push('BIRD1 enforces a base fingerprint on a run that was deliberately measuring another model');
  }

  // Declared pairs. A pair is a promise that a delta is read inside one run, so the gate checks
  // both halves of the promise: the split still runs the arms, and the run actually read the pair.
  const pairBase = { expectedArms: ['names', 'inline', 'audit'], armsBySplit: {} };
  const declarations = { minidev: [['inline', 'audit']] };
  const read = { pairs: [{ left: 'inline', right: 'audit', examined: 100, wins: 12, losses: 5, p: 0.05 }] };
  if (pairIssues(declarations, pairBase, 'minidev', read).length !== 0) {
    issues.push('BIRD1 rejects a declared pair that the split runs and the run read');
  }
  if (pairIssues(undefined, pairBase, 'minidev', read).length !== 0) issues.push('BIRD1 invents a pair for a repository with no declaration file');
  if (pairIssues({ dev: [] }, pairBase, 'minidev', read).length !== 0) issues.push('BIRD1 applies one split\'s pairs to another split');
  if (pairIssues({ minidev: [] }, pairBase, 'minidev', read).length !== 0) issues.push('BIRD1 treats an empty pair list as a missing one');
  const noArm = pairIssues({ minidev: [['inline', 'gone']] }, pairBase, 'minidev', read);
  if (!noArm.some((issue) => issue.includes('can never be taken'))) {
    issues.push('BIRD1 accepts a declared pair whose arm the split does not run');
  }
  const unread = pairIssues(declarations, pairBase, 'minidev', { pairs: [] });
  if (!unread.some((issue) => issue.includes('did not read it'))) {
    issues.push('BIRD1 accepts a declared pair that the run never read');
  }
  const unscored = pairIssues(declarations, pairBase, 'minidev', { pairs: [{ left: 'inline', right: 'audit', missing: ['audit'] }] });
  if (!unscored.some((issue) => issue.includes('did not score audit'))) {
    issues.push('BIRD1 accepts a declared pair whose arm the run did not score');
  }
  const noQuestion = pairIssues(declarations, pairBase, 'minidev', { pairs: [{ left: 'inline', right: 'audit', examined: 0 }] });
  if (!noQuestion.some((issue) => issue.includes('shares no question'))) {
    issues.push('BIRD1 accepts a paired reading over zero questions');
  }
  const noReadings = pairIssues({ minidev: [['inline', 'audit']] }, pairBase, 'minidev', undefined);
  if (noReadings.length !== 1 || !noReadings[0].includes('wrote none')) {
    issues.push('BIRD1 accepts a run that skipped every declared pair, or says it four times');
  }
  if (pairIssues({ minidev: [['inline', 'audit']] }, pairBase, 'minidev', { pairs: [] }, ['names']).length !== 0) {
    issues.push('BIRD1 demands a paired reading from a run that declared a subset without those arms');
  }
  if (pairIssues({ minidev: [['inline', 'audit']] }, pairBase, 'minidev', { pairs: [] }, ['inline', 'audit']).length !== 1) {
    issues.push('BIRD1 skips a declared pair the run asked for and never read');
  }
  const malformed = pairIssues({ minidev: { not: 'a list' } }, pairBase, 'minidev', read);
  if (!malformed.some((issue) => issue.includes('is not a list of pairs'))) issues.push('BIRD1 accepts a pair list that is not a list');
  const shortEntry = pairIssues({ minidev: [['inline'], ['a', 'b', 'c']] }, pairBase, 'minidev', read);
  if (shortEntry.filter((issue) => issue.includes('not a pair of arm names')).length !== 2) {
    issues.push('BIRD1 accepts a declaration entry that is not a pair');
  }
  return issues;
}

if (process.argv[2] === '--record-fingerprint') {
  // The one thing a human cannot do by hand without introducing the number they are about to
  // enforce. A pin whose digest was typed from a different run than the one it names is a pin that
  // fails the next build for a reason nobody can reproduce, and this repository has already
  // published a hand-copied number that had drifted (45.0 against 40.3). So the block is printed
  // and pasted, never composed.
  const reportPath = resolve(ROOT, 'eval/out/bird-eval.json');
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    console.error('BIRD1: eval/out/bird-eval.json is missing; run bench:bird before pinning a fingerprint');
    process.exit(1);
  }
  const split = report.selection?.split ?? 'minidev';
  const reading = report.baseFingerprint;
  const digest = typeof reading?.digest === 'string' ? reading.digest : '';
  if (reading === undefined || digest === '' || reading.stable !== true) {
    const why =
      reading === undefined
        ? 'the report carries no base fingerprint'
        : reading.stable !== true
          ? 'the endpoint answered identical probes differently, so this digest is a draw'
          : 'no probe answered';
    console.error(`BIRD1: cannot pin a fingerprint from this run — ${why}`);
    process.exit(1);
  }
  const bases = Array.isArray(reading.bases) && reading.bases.length > 0 ? reading.bases.join('+') : null;
  console.log(
    JSON.stringify(
      {
        baseFingerprint: {
          [split]: {
            digest,
            probes: reading.probes,
            total: reading.total,
            probeSet: reading.probeSet,
            served: bases,
            run: report.provenance?.run ?? null,
            at: report.generatedAt ?? null,
          },
        },
      },
      null,
      1,
    ),
  );
} else if (process.argv[2] === '--self-test') {
  const issues = selfTest();
  for (const issue of issues) console.error(issue);
  if (issues.length > 0) process.exit(1);
  console.log('BIRD floor self-test: pass, noise, regression, missing arm, shrunken sample, a dev run measured against its own sample, two split fields that disagree, a dataset name that disagrees with the split, other split, other model, unfloored arm, empty lever, a funnel that does not add up, a split-specific arm list, an uncounted selector call, a majority vote that spends exactly its samples, a pooled arm that pays for its decision and for no candidates, one that leaves a decision unpriced, one that never says whether its selector was counted, one that redrew the pool it claims to share, a pooled majority vote that costs nothing and the same two counts on a generating arm, a reconcile funnel that an adopting arm and a handing-back arm both satisfy, one that never says which policy it was read under, one that adopted more replies than it received, an adopting arm that did not score what it ran and a novel-only arm that scored a restatement, a repair count without a loop, an unpriced arm, an unnamed model, floors from an unnamed model and a cross-model arm with no second model named, a judge swap with no judge named, an arm with harness errors, a candidate set that lost a third of itself to an endpoint, a failure corpus that stopped at a cap without saying so, an empty-result lever with no funnel or an impossible yield or nothing behind it, a decomposition arm whose prompt the model ignored, an unrecorded instrument, a samples arm with no values behind it, a truncated schema card, a prompt with no table in it, a declared arm subset, a declared arm whose row was dropped, an undeclared row, an empty declaration and a floor that a declaration does not weaken, a declared sample subset, a subset that cannot clear a floor, a sample that shrank undeclared, an impossible declaration and a row count above the request, a cross-arm floor with a matching second model, a swapped one and an unattributed one, and a ceiling that held, a ceiling that fell while the score held, a ceiling inside the noise threshold, a sampling arm with no ceiling at all, a ceiling whose two fields disagree, a ceiling floor on an arm the split does not run, a score that fell while the ceiling held, a ceiling with no floor yet, a corpus that was named, unnamed, replaced under pinned floors or present without a digest, and a base model that matched the pin, answered as another one, or answered a run of another model, was never named, changed mid-run or was never pinned, and a base fingerprint that matched its pin, moved under the same name, was never read, answered nothing, came back unstable or arrived over another probe set, and a declared pair that was read, was never read, lost an arm it names, lost an arm the run skipped, spanned no question or arrived malformed, and a declared pair a subset run never asked for all behave');
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
  const pairsFile = resolve(ROOT, 'eval/baseline/pairs.json');
  let declarations;
  try {
    declarations = JSON.parse(readFileSync(pairsFile, 'utf8'));
  } catch {
    declarations = undefined;
  }
  let readings;
  try {
    readings = JSON.parse(readFileSync(resolve(ROOT, 'eval/out/bird-pairs.json'), 'utf8'));
  } catch {
    readings = undefined;
  }
  issues.push(...pairIssues(declarations, baseline, report.selection.split ?? 'minidev', readings, report.armsRequested));
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
