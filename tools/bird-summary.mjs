#!/usr/bin/env node
/**
 * Render the BIRD evaluation artifacts as Markdown for the job summary.
 * Reads only; every number comes from a run, never from this file.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

function read(name) {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'eval/out', name), 'utf8'));
  } catch {
    return null;
  }
}

// The artifact carries the path it was written to, because a run may be told to write
// somewhere else (`BIRD_OUT`); a summary that read the default path would describe a
// different run than the one that just finished. Overridable for the same reason.
const reportPath = process.env.BIRD_OUT ?? join(ROOT, 'eval/out/bird-eval.json');
const report = (() => {
  try {
    return JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    return null;
  }
})();
const portability = read('duckdb-portability.json');
const stability = read('bird-stability.json');
const adversarial = read('adversarial.json');
const lines = ['## BIRD Mini-Dev (external benchmark)', ''];

if (report === null) {
  lines.push('No evaluation artifact was produced; see the job log.', '');
} else {
  const gold = report.gold;
  const controls = report.controls;
  lines.push(
    `Model: \`${report.model ?? 'none (dry run)'}\` · split: ${report.selection.split ?? 'minidev'} · dialect: ${report.dialect} · databases: ${report.selection.databases.length} · scored: ${report.selection.scored}/${report.selection.available}`,
    '',
    `Gold queries executed before any model call: **${gold.runnable}/${gold.executed}** runnable (${(gold.runnableRate * 100).toFixed(1)}%).` +
      (gold.executed > gold.runnable
        ? ` Excluded, with the reason recorded in the artifact: ${(gold.unrunnable ?? [])
            .map((entry) => `\`${entry.id}\` (${entry.db}, ${entry.error})`)
            .join(', ')} — a gold statement that cannot be executed in the harness's step budget cannot be scored, and a run that scored it as a wrong answer would be measuring the budget.`
        : ''),
    `Controls: self-consistency **${(controls.selfConsistency * 100).toFixed(1)}%**, negative false matches **${controls.negativeFalseMatches}**, empty-gold cases excluded from the negative control: ${controls.emptyGoldExcluded}.`,
    `Structural semantics: **${controls.semanticsDatabases}/${controls.semanticsDatabaseTotal}** databases and **${controls.semanticsCases}/${report.selection.scored}** cases yield a claim; mean block ${controls.semanticsMeanChars} characters.`,
    `Synthesized definitions (written once per database, cached): **${controls.synthesizedDefinitionDatabases ?? 0}/${controls.semanticsDatabaseTotal}** databases, mean block ${controls.synthesizedDefinitionMeanChars ?? 0} characters.`,
    `Blocks actually built: retrieved **${controls.retrievedBlocks ?? 0}** cases, demonstrations **${controls.demonstrationBlocks ?? 0}**, value matches **${controls.valueMatches ?? 0}** (corpus ${controls.retrievalCorpus ?? 0} rows).`,
    `Inline placement: **${controls.inlineAttached ?? 0}** lines attached to a column, ${controls.inlineUnplaced ?? 0} left unplaced (addressability ${((controls.inlineAttached ?? 0) / Math.max(1, (controls.inlineAttached ?? 0) + (controls.inlineUnplaced ?? 0)) * 100).toFixed(1)}%); dataset subset covers ${controls.subsetComments ?? 0} columns.`,
    '',
  );
  if (Array.isArray(report.arms) && report.arms.length > 0) {
    lines.push('| arm | execution accuracy | 95% Wilson | strict (multiset) | duplicate credit | repaired | calls/question | prompt chars | simple / moderate / challenging |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const arm of report.arms) {
      const byDifficulty = ['simple', 'moderate', 'challenging']
        .map((key) => {
          const bucket = arm.byDifficulty[key];
          return bucket === undefined ? '–' : `${bucket.passed}/${bucket.total}`;
        })
        .join(' / ');
      // `repaired` exists only on an arm with a repair loop (`repairAccounting`), and
      // `calls` only where the arm spends more than one call per question. Printing a
      // bare `undefined` in either column would have been the honest failure; printing a
      // sample count under "repaired" is the dishonest one that shipped.
      lines.push(
        `| ${arm.arm} | **${(arm.accuracy * 100).toFixed(1)}%** | [${(arm.wilson.low * 100).toFixed(1)}, ${(arm.wilson.high * 100).toFixed(1)}] | ${arm.strictPassed}/${arm.total} | ${arm.duplicateCredit} | ${arm.repaired ?? '–'} | ${arm.calls?.mean ?? '–'} | ${arm.promptChars?.mean ?? '–'} | ${byDifficulty} |`,
      );
    }
    const broken = report.arms.filter((arm) => typeof arm.firstError === 'string');
    if (broken.length > 0) {
      lines.push(
        '',
        '> **A run failed before it reached the database.** First error per arm:',
        ...broken.map((arm) => `> - \`${arm.arm}\`: ${arm.firstError}`),
      );
    }
    // A selector's score says nothing on its own: what it kept is only meaningful
    // against what the candidate set contained. The ceiling is measured on the same
    // cases, so a null result can be read as "no candidate was right" (a generation
    // problem) instead of "the selector failed" (a prompt problem).
    // A mixed arm's price is what it spends; whether its sources actually differ is a
    // separate fact, measured before any model call and reported here because a
    // degenerate candidate turns three calls into two opinions.
    const mixedArms = Array.isArray(report.mixedCandidatePrompts) ? report.mixedCandidatePrompts : [];
    if (mixedArms.length > 0) {
      lines.push(
        '',
        '| mixed arm | sources | questions with every prompt distinct | degenerate (paid for a duplicate) |',
        '| --- | --- | --- | --- |',
        ...mixedArms.map(
          (entry) =>
            `| \`${entry.arm}\` | ${entry.sources.join(' + ')} | ${entry.withAllDistinct}/${entry.questions} (${((1 - entry.degenerateShare) * 100).toFixed(1)}%) | ${entry.degenerate} (${(entry.degenerateShare * 100).toFixed(1)}%) |`,
        ),
      );
    }
    const voted = report.arms.filter((arm) => typeof arm.vote === 'number');
    if (voted.length > 0) {
      lines.push(
        '',
        '### What the candidate set contained',
        '',
        '| arm | samples | mean agreement | candidate recall (the ceiling) | selection loss | kept |',
        '| --- | --- | --- | --- | --- | --- |',
        ...voted.map((arm) => {
          const ceiling = typeof arm.candidateRecallShare === 'number' ? arm.candidateRecallShare : undefined;
          const kept = ceiling === undefined || ceiling === 0 ? '–' : `${((arm.passed / arm.total / ceiling) * 100).toFixed(1)}%`;
          return `| ${arm.arm} | ${arm.vote} | ${(arm.agreement * 100).toFixed(1)}% | ${ceiling === undefined ? '–' : `**${(ceiling * 100).toFixed(1)}%**`} | ${arm.selectionLoss ?? '–'} | ${kept} |`;
        }),
      );
    }
    // The empty-result lever has two halves with different prices, so the table keeps
    // them apart: a dropped candidate costs nothing, a turn costs a call.
    const emptied = report.arms.filter((arm) => arm.emptyRetry !== undefined);
    if (emptied.length > 0) {
      lines.push(
        '',
        '### What the empty result bought',
        '',
        '| arm | message | candidates dropped | turns spent | recovered | extra calls/question |',
        '| --- | --- | --- | --- | --- | --- |',
        ...emptied.map(
          (arm) =>
            `| \`${arm.arm}\` | ${arm.emptyRetry.mode} | ${arm.emptyRetry.dropped} | ${arm.emptyRetry.fired} | ${arm.emptyRetry.recovered} | ${arm.emptyRetry.extraCallsPerCase} |`,
        ),
      );
    }
    // What the fourth prompt produced. Whether the model followed the format decides
    // whether a delta measures decomposition or a longer instruction, so it is printed
    // beside the number instead of being left in an artifact nobody opens.
    const decomposed = report.arms.filter((arm) => arm.decomposition !== undefined);
    if (decomposed.length > 0) {
      lines.push(
        '',
        '### What the decomposition prompt produced',
        '',
        '| arm | cases asked | wrote steps | share | steps per case |',
        '| --- | --- | --- | --- | --- |',
        ...decomposed.map(
          (arm) =>
            `| \`${arm.arm}\` | ${arm.decomposition.asked} | ${arm.decomposition.fired} | ${(arm.decomposition.share * 100).toFixed(1)}% | ${arm.decomposition.meanSteps} |`,
        ),
      );
    }
    // A candidate the endpoint refused is missing from the set the ceiling is taken over,
    // and no case-level count can see it.
    const lossy = report.arms.filter((arm) => arm.candidateFailures !== undefined);
    if (lossy.length > 0) {
      lines.push(
        '',
        '### Candidates that never arrived',
        '',
        '| arm | attempts | refused by the model | refused by the engine |',
        '| --- | --- | --- | --- |',
        ...lossy.map(
          (arm) =>
            `| \`${arm.arm}\` | ${arm.candidateFailures.attempted} | ${arm.candidateFailures.llm} | ${arm.candidateFailures.other} |`,
        ),
      );
    }
    if (report.aa !== undefined) {
      lines.push(
        '',
        `### The same arm twice (A/A)`,
        '',
        `\`${report.aa.arm}\` run twice in this job: **${(report.aa.delta * 100).toFixed(1)}pp** apart (${report.aa.onlyFirst} / ${report.aa.onlySecond}, McNemar p=${report.aa.p.toFixed(3)}). This is the scale every other delta should be read against.`,
      );
    }
    lines.push(
      '',
      '### Paired ablations',
      '',
      '| change | delta | only before / only after | McNemar exact p | extra calls / case | pp per extra call |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const [name, effect] of Object.entries(report.ablations ?? {})) {
      const cost = effect.cost ?? {};
      const extra = typeof cost.extraCallsPerCase === 'number' ? cost.extraCallsPerCase.toFixed(2) : '—';
      const perCall = typeof cost.ppPerExtraCall === 'number' ? cost.ppPerExtraCall.toFixed(2) : 'free';
      lines.push(
        `| ${name} | ${effect.delta >= 0 ? '+' : ''}${(effect.delta * 100).toFixed(1)}pp | ${effect.onlyFirst} / ${effect.onlySecond} | ${effect.p.toFixed(4)} | ${extra} | ${perCall} |`,
      );
    }
    lines.push('');

    // The funnel: accuracy says whether the arm is good, this says what the loop did.
    const withFunnel = (report.arms ?? []).find((entry) => entry.repair !== undefined);
    if (withFunnel !== undefined) {
      const funnel = withFunnel.repair;
      lines.push(
        '### What the repair loop bought',
        '',
        `\`${withFunnel.arm}\` answered **${funnel.firstPass}** of ${funnel.total} on the first statement (${(funnel.firstPassRate * 100).toFixed(1)}%); ` +
          `${funnel.ranOnceWrong} ran once and answered wrong, which no repair can reach. ` +
          `${funnel.repaired} cases failed at execution and needed a repair — the loop's ceiling is ${(funnel.repairableShare * 100).toFixed(1)}pp — ` +
          `**${funnel.fixedByRepair}** of those ended correct (${(funnel.repairSuccessRate * 100).toFixed(1)}%), ${funnel.stillFailing} did not. ` +
          `Mean ${funnel.meanAttempts.toFixed(2)} attempts (${funnel.extraCallsPerCase.toFixed(2)} extra calls per case).`,
        '',
      );
      if ((funnel.byClass ?? []).length > 0) {
        lines.push('| first rejection | cases | fixed | still failing |', '| --- | --- | --- | --- |');
        for (const entry of funnel.byClass) {
          lines.push(`| ${entry.failureClass} | ${entry.cases} | ${entry.fixed} | ${entry.remaining} |`);
        }
        lines.push('');
      }
    }
  }
  lines.push(
    '> Execution accuracy is BIRD\u2019s official judge: `set(predicted) == set(gold)` over tuples, so row order is ignored and duplicate rows collapse. The strict column repeats the comparison as a multiset; the difference is the number of cases the official rule credits because of duplicates.',
    '',
  );
}

if (stability !== null) {
  lines.push(
    '### Noise floor',
    '',
    `Same ${stability.cases} cases asked ${stability.repeats} times on arm \`${stability.arm}\`: **${stability.flips}** cases disagreed with themselves (${(stability.flipRate * 100).toFixed(1)}%); majority ${(stability.majorityAccuracy * 100).toFixed(1)}% vs single run ${(stability.firstRunAccuracy * 100).toFixed(1)}%.`,
    '',
  );
}

if (adversarial !== null) {
  lines.push('### Adversarial shapes (hand-written, separate from BIRD)', '');
  lines.push('| arm | accuracy | window | ratio | multi-hop | tie |', '| --- | --- | --- | --- | --- | --- |');
  for (const arm of adversarial.arms) {
    const cell = (name) => {
      const bucket = arm.byCategory[name];
      return bucket === undefined ? '–' : `${bucket.passed}/${bucket.total}`;
    };
    lines.push(
      `| ${arm.arm} | ${(arm.accuracy * 100).toFixed(1)}% (${arm.passed}/${arm.total}) | ${cell('window')} | ${cell('ratio')} | ${cell('multi-hop')} | ${cell('tie')} |`,
    );
  }
  for (const key of ['names -> definitions', 'names -> metadata']) {
    const effect = adversarial.ablations[key];
    if (effect === undefined) continue;
    lines.push('', `${key.replace(' -> ', ' → ')}: ${effect.delta >= 0 ? '+' : ''}${(effect.delta * 100).toFixed(1)}pp (only before ${effect.onlyFirst}, only after ${effect.onlySecond}, p=${effect.p.toFixed(3)}).`);
  }
  lines.push('', 'Each category has 8 cases, so a category cell moves in steps of 12.5pp.', '');
}

if (portability !== null) {
  lines.push('### DuckDB portability of the same statements', '', '| stage | runnable | taxonomy of failures |', '| --- | --- | --- |');
  for (const [stage, value] of Object.entries(portability.stages)) {
    const taxonomy = value.taxonomy.map((entry) => `${entry.kind} ${entry.count}`).join(', ') || '–';
    lines.push(`| ${stage} | ${value.runnable}/${portability.statements} (${(value.rate * 100).toFixed(1)}%) | ${taxonomy} |`);
  }
  lines.push('', '> The dataset is SQLite and the product\u2019s default engine is DuckDB. This table is the measured gap, not an opinion: two documented rewrites (backtick quoting, an `iif` macro) recover most of it, and the rest is dialect strictness that a compiler must avoid emitting.', '');
}

console.log(lines.join('\n'));
