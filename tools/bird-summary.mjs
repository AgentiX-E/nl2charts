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

const report = read('bird-eval.json');
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
    lines.push('| arm | execution accuracy | 95% Wilson | strict (multiset) | duplicate credit | repaired | prompt chars | simple / moderate / challenging |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const arm of report.arms) {
      const byDifficulty = ['simple', 'moderate', 'challenging']
        .map((key) => {
          const bucket = arm.byDifficulty[key];
          return bucket === undefined ? '–' : `${bucket.passed}/${bucket.total}`;
        })
        .join(' / ');
      lines.push(
        `| ${arm.arm} | **${(arm.accuracy * 100).toFixed(1)}%** | [${(arm.wilson.low * 100).toFixed(1)}, ${(arm.wilson.high * 100).toFixed(1)}] | ${arm.strictPassed}/${arm.total} | ${arm.duplicateCredit} | ${arm.repaired} | ${arm.promptChars?.mean ?? '–'} | ${byDifficulty} |`,
      );
    }
    const voted = report.arms.find((arm) => typeof arm.vote === 'number');
    if (voted !== undefined) {
      lines.push('', `Vote arm \`${voted.arm}\`: ${voted.vote} samples per question, mean agreement **${(voted.agreement * 100).toFixed(1)}%**, ${voted.passed}/${voted.total} correct.`);
    }
    if (report.aa !== undefined) {
      lines.push(
        '',
        `### The same arm twice (A/A)`,
        '',
        `\`${report.aa.arm}\` run twice in this job: **${(report.aa.delta * 100).toFixed(1)}pp** apart (${report.aa.onlyFirst} / ${report.aa.onlySecond}, McNemar p=${report.aa.p.toFixed(3)}). This is the scale every other delta should be read against.`,
      );
    }
    lines.push('', '### Paired ablations', '', '| change | delta | only before / only after | McNemar exact p |', '| --- | --- | --- | --- |');
    for (const [name, effect] of Object.entries(report.ablations ?? {})) {
      lines.push(
        `| ${name} | ${effect.delta >= 0 ? '+' : ''}${(effect.delta * 100).toFixed(1)}pp | ${effect.onlyFirst} / ${effect.onlySecond} | ${effect.p.toFixed(4)} |`,
      );
    }
    lines.push('');
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
