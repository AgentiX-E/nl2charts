#!/usr/bin/env node
/**
 * Render the BIRD evaluation artifacts as Markdown for the job summary.
 * Reads only; every number comes from a run, never from this file.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  // A subset run is a stated sample, not a shrunken one. The reader who sees "298/500" alone
  // will read a lost measurement; a run that asked for less than the split holds says so in
  // words, and says that no floor applies, because the floors were taken on the full sample.
  const selection = report.selection;
  const subset =
    typeof selection.requested === 'number' && typeof selection.available === 'number' && selection.requested < selection.available;
  const subsetNote = subset ? ` · requested: **${selection.requested}** (declared subset — no accuracy floor applies)` : '';
  // What a subset is made of decides whether its accuracy is an estimate of the split. The
  // sampler allocated one case per difficulty bucket and consumed the buckets in file order,
  // so 120 dev questions came back 40/40/40 from a split that is 60/30/10 and drawn from 2 of
  // its 11 databases — and every number in this summary described a harder population. Both
  // axes are in the artifact now; printing them is what makes "50.8% on dev" readable.
  const sampledDatabases = Array.isArray(selection.databases) ? selection.databases.length : 0;
  const availableDatabases = Array.isArray(selection.availableDatabases) ? selection.availableDatabases.length : undefined;
  const databasesCell = availableDatabases === undefined ? `databases: ${sampledDatabases}` : `databases: ${sampledDatabases}/${availableDatabases}`;
  const sampleLine = (() => {
    if (subset === false) return undefined;
    const parts = [];
    const mix = selection.mix;
    if (mix !== undefined) {
      const keys = ['simple', 'moderate', 'challenging'];
      const sampled = keys.map((key) => mix.sample?.[key] ?? 0);
      const split = keys.map((key) => mix.available?.[key] ?? 0);
      const sampledTotal = sampled.reduce((sum, value) => sum + value, 0);
      const splitTotal = split.reduce((sum, value) => sum + value, 0);
      if (sampledTotal > 0 && splitTotal > 0) {
        const worst = keys
          .map((key, index) => ({ key, gap: (sampled[index] / sampledTotal - split[index] / splitTotal) * 100 }))
          .sort((left, right) => Math.abs(right.gap) - Math.abs(left.gap))[0];
        const shape = `sample **${sampled.join(' / ')}** against the split's ${split.join(' / ')}`;
        parts.push(
          Math.abs(worst.gap) > 5
            ? `${shape} — ${worst.gap > 0 ? 'over' : 'under'}-weights \`${worst.key}\` by **${Math.abs(worst.gap).toFixed(0)}pp**, so this accuracy describes that sample, not the split`
            : `${shape} — proportional, so the accuracy estimates the split`,
        );
      }
    }
    if (availableDatabases !== undefined && sampledDatabases < availableDatabases) {
      parts.push(`covers **${sampledDatabases} of ${availableDatabases}** databases, and a sample that skips one is not an estimate of the split`);
    }
    return parts.length === 0 ? undefined : `Sample: ${parts.join('; ')}.`;
  })();
  lines.push(
    `Model: \`${report.model ?? 'none (dry run)'}\` · split: ${selection.split ?? 'minidev'} · dialect: ${report.dialect} · ${databasesCell} · scored: ${selection.scored}/${selection.available}${subsetNote}`,
    ...(sampleLine === undefined ? [] : [sampleLine]),
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
        '| arm | attempts | endpoint did not answer | engine refused | no usable statement |',
        '| --- | --- | --- | --- | --- |',
        ...lossy.map(
          (arm) =>
            `| \`${arm.arm}\` | ${arm.candidateFailures.attempted} | ${arm.candidateFailures.llm} | ${arm.candidateFailures.engine ?? 0} | ${arm.candidateFailures.unparsed ?? 0} |`,
        ),
      );
      // `candidateFailures` says how many candidates were lost; this says whose. On a cross arm
      // they are different findings: a second endpoint that refused its candidate is a vendor
      // problem, a prompt that never parsed is ours.
      const sourced = lossy.filter((arm) => arm.candidateSurvival !== undefined && Object.keys(arm.candidateSurvival).length > 0);
      for (const arm of sourced) {
        lines.push(
          '',
          `#### \`${arm.arm}\`: which source lost its candidate`,
          '',
          '| source | asked | arrived | share |',
          '| --- | --- | --- | --- |',
          ...Object.entries(arm.candidateSurvival)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([source, count]) => {
              const share = count.generated === 0 ? 0 : count.survived / count.generated;
              return `| \`${source}\` | ${count.generated} | ${count.survived} | ${(share * 100).toFixed(1)}% |`;
            }),
        );
      }
    }
    if (report.aa !== undefined) {
      const aa = report.aa;
      // "0.0pp apart" is the most misread line this summary can print: two runs of the same
      // arm have not shown the harness is exact, they have shown it cannot resolve anything
      // smaller than `mde`. The number belongs in the sentence, not in the artifact only.
      const resolution =
        typeof aa.mde === 'number'
          ? ` The same cases could not have separated anything smaller than **${(aa.mde * 100).toFixed(1)}pp** at 80% power, so that is the smallest delta this job can call non-zero.`
          : '';
      lines.push(
        '',
        `### The same arm twice (A/A)`,
        '',
        `\`${aa.arm}\` run twice in this job: **${(aa.delta * 100).toFixed(1)}pp** apart (${aa.onlyFirst} / ${aa.onlySecond}, McNemar p=${aa.p.toFixed(3)}).${resolution} This is the scale every other delta should be read against.`,
      );
    }
    lines.push(
      '',
      '### Paired ablations',
      '',
      '| change | delta (95% CI) | only before / only after | McNemar exact p | resolves (80% power) | extra calls / case | pp per extra call |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const [name, effect] of Object.entries(report.ablations ?? {})) {
      const cost = effect.cost ?? {};
      const extra = typeof cost.extraCallsPerCase === 'number' ? cost.extraCallsPerCase.toFixed(2) : '—';
      const perCall = typeof cost.ppPerExtraCall === 'number' ? cost.ppPerExtraCall.toFixed(2) : 'free';
      // An artifact written before this column existed has no interval and no resolution.
      // Printing a dash is the honest answer; printing 0.0 would claim the design was exact.
      const interval =
        effect.ci === undefined
          ? ''
          : ` [${(effect.ci.low * 100).toFixed(1)}, ${(effect.ci.high * 100).toFixed(1)}]`;
      const resolves = typeof effect.mde === 'number' ? `${(effect.mde * 100).toFixed(1)}pp` : '—';
      // The same arithmetic run forwards: how many cases a 2pp claim would need at the
      // discordance this pair actually showed. A reader who sees "resolves 5.2pp" is
      // owed the number that says what it would take to resolve less.
      const needed = typeof effect.casesForClaim === 'number' ? ` · ${effect.casesForClaim} for 2pp` : '';
      lines.push(
        `| ${name} | ${effect.delta >= 0 ? '+' : ''}${(effect.delta * 100).toFixed(1)}pp${interval} | ${effect.onlyFirst} / ${effect.onlySecond} | ${effect.p.toFixed(4)} | ${resolves}${needed} | ${extra} | ${perCall} |`,
      );
    }
    lines.push(
      '',
      '> `resolves` is the smallest difference the same cases could have detected at 80% power, from the share of cases the two arms disagreed on. A delta inside it is not a small effect, it is an unmeasured one — whichever way it points.',
    );

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

/**
 * The one thing a human reads from CI, and until now it had no test.
 *
 * Every column in this file is a formatter, and a formatter that prints the wrong field
 * looks exactly like a run that measured the wrong thing. The cases below are the ones
 * that were wrong or would have been: an artifact from before the resolution columns
 * existed must render dashes rather than zeros, a delta must carry its interval, and the
 * A/A sentence must state what the harness could not have seen.
 */
function selfTest() {
  const issues = [];
  const script = fileURLToPath(import.meta.url);
  const base = {
    dataset: 'bird-mini-dev',
    split: 'dev',
    dialect: 'SQLite',
    model: 'deepseek-chat',
    selection: { split: 'dev', databases: ['a'], available: 1534, requested: 1534, scored: 1534 },
    gold: { executed: 100, runnable: 100, runnableRate: 1, unrunnable: [] },
    controls: {
      selfConsistency: 1,
      negativeFalseMatches: 0,
      emptyGoldExcluded: 0,
      semanticsDatabases: 1,
      semanticsDatabaseTotal: 1,
      semanticsCases: 100,
      semanticsMeanChars: 700,
      retrievedBlocks: 0,
      demonstrationBlocks: 0,
      valueMatches: 0,
      retrievalCorpus: 0,
      inlineAttached: 0,
      inlineUnplaced: 0,
      subsetComments: 0,
    },
    arms: [
      {
        arm: 'names',
        accuracy: 0.5,
        wilson: { low: 0.4, high: 0.6 },
        strictPassed: 50,
        total: 100,
        duplicateCredit: 0,
        byDifficulty: {},
      },
    ],
  };
  const render = (report) => {
    const dir = mkdtempSync(join(tmpdir(), 'bird-summary-'));
    const path = join(dir, 'bird-eval.json');
    writeFileSync(path, JSON.stringify(report));
    const run = spawnSync(process.execPath, [script], { env: { ...process.env, BIRD_OUT: path }, encoding: 'utf8' });
    if (run.status !== 0) issues.push(`the summary exited ${String(run.status)} on an artifact it must render: ${run.stderr}`);
    return run.stdout ?? '';
  };

  const resolved = render({
    ...base,
    aa: { arm: 'names', delta: 0, onlyFirst: 0, onlySecond: 0, p: 1, ci: { low: -0.02, high: 0.02 }, mde: 0.0404, discordantShare: 0.025 },
    ablations: {
      'names -> metadata': {
        delta: 0.025,
        onlyFirst: 1,
        onlySecond: 4,
        p: 0.375,
        ci: { low: -0.02, high: 0.07 },
        mde: 0.0522,
        discordantShare: 0.0417,
        casesForClaim: 818,
        cost: { extraCallsPerCase: 0.25, ppPerExtraCall: 10 },
      },
    },
  });
  if (!resolved.includes('+2.5pp [-2.0, 7.0]')) issues.push('the ablation row does not print the delta with its interval');
  if (!resolved.includes('| 5.2pp · 818 for 2pp |')) {
    issues.push('the ablation row does not print the resolution the delta is read against, or the cases a 2pp claim needs');
  }
  if (!resolved.includes('could not have separated anything smaller than **4.0pp**')) {
    issues.push('the A/A sentence does not state what the same cases could have detected');
  }

  // An artifact written before the resolution columns existed still has to render: a dash
  // in the column says "not measured", while a zero would say "measured as exact".
  const legacy = render({
    ...base,
    aa: { arm: 'names', delta: 0, onlyFirst: 0, onlySecond: 0, p: 1 },
    ablations: { 'names -> metadata': { delta: 0.025, onlyFirst: 1, onlySecond: 4, p: 0.375, cost: { extraCallsPerCase: 0.25 } } },
  });
  if (!legacy.includes('| +2.5pp |')) issues.push('a delta without an interval did not render as a bare delta');
  if (!legacy.includes('| — |')) issues.push('a comparison without a resolution did not render as a dash');
  if (legacy.includes('could not have separated')) issues.push('an artifact without a resolution claimed one in the A/A sentence');
  if (legacy.includes('Sample:')) issues.push('an artifact without a sample mix claimed one');

  // A subset's mix is the difference between "50.8% on dev" and "50.8% on a sample with a
  // third of its questions challenging", and the summary has to say which one it is printing.
  const elevenDatabases = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
  const skewed = render({
    ...base,
    selection: {
      split: 'dev',
      databases: ['california_schools', 'toxicology'],
      availableDatabases: elevenDatabases,
      available: 1534,
      requested: 120,
      scored: 120,
      mix: { sample: { simple: 40, moderate: 40, challenging: 40 }, available: { simple: 925, moderate: 464, challenging: 145 } },
    },
  });
  if (!skewed.includes('under-weights `simple` by **27pp**')) {
    issues.push('a subset whose mix over-weights the hard buckets is not reported as distorting the easiest one');
  }
  if (!skewed.includes('covers **2 of 11** databases')) {
    issues.push('a subset that scored 2 of the split\'s 11 databases is not reported as covering two of them');
  }
  const proportional = render({
    ...base,
    selection: {
      split: 'dev',
      databases: elevenDatabases,
      availableDatabases: elevenDatabases,
      available: 1534,
      requested: 120,
      scored: 120,
      mix: { sample: { simple: 73, moderate: 36, challenging: 11 }, available: { simple: 925, moderate: 464, challenging: 145 } },
    },
  });
  if (!proportional.includes('proportional, so the accuracy estimates the split')) {
    issues.push('a proportionally sampled subset is not reported as an estimate of the split');
  }
  if (proportional.includes('covers **11 of 11**')) {
    issues.push('a sample that covers every database is reported as skipping one');
  }

  // A run that scored nothing still has to render: the summary prints its header and skips
  // the arm tables, instead of failing the step that reports the failure.
  const noArms = render({ ...base, arms: [] });
  if (!noArms.includes('Model: `deepseek-chat`')) issues.push('an artifact with no arms did not render its header');
  if (noArms.includes('### Paired ablations')) issues.push('an artifact with no arms printed an ablation table');

  return issues;
}

if (process.argv[2] === '--self-test') {
  const issues = selfTest();
  for (const issue of issues) console.error(issue);
  if (issues.length > 0) process.exit(1);
  console.log('BIRD summary self-test: a delta with its interval, a resolution column, an A/A sentence that says what it could not see, a subset mix that over-weights the hard buckets, a proportional one, an artifact from before those columns, and an artifact with no arms all render');
} else {
  console.log(lines.join('\n'));
}
