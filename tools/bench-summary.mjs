#!/usr/bin/env node
/**
 * Render the benchmark artifacts as a Markdown table for the CI job summary.
 * It reads what the harness wrote; it does not recompute or embellish anything.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const read = (name) => JSON.parse(readFileSync(join(ROOT, 'eval/out', name), 'utf8'));

const results = read('results.json');
const linking = read('linking-ablation.json');
const ablation = read('ablation.json');

const lines = ['## Benchmark', '', 'Dataset: `eval/golden.jsonl` (20 questions, deterministic fixture, DuckDB).', ''];
lines.push('| predictor | exact match | unordered match | passed/total |');
lines.push('| --- | --- | --- | --- |');
for (const summary of results.summaries) {
  lines.push(
    `| ${summary.predictor} | ${(summary.accuracy * 100).toFixed(1)}% | ${(summary.unorderedAccuracy * 100).toFixed(1)}% | ${summary.passed}/${summary.total} |`,
  );
}
lines.push('', `Controls: oracle ${(results.controls.oracle * 100).toFixed(0)}%, empty ${(results.controls.empty * 100).toFixed(0)}%. A run fails if either control breaks.`, '');
lines.push('### Schema linking ablation (recall@3)', '', '| arm | recall@3 |', '| --- | --- |');
for (const arm of linking.arms) {
  lines.push(`| ${arm.arm} | ${(arm.recallAt3 * 100).toFixed(1)}% (${arm.hits}/${arm.total}) |`);
}
lines.push(
  '',
  `### Question normalization (paired)`,
  '',
  `delta ${ablation.deltaPp >= 0 ? '+' : ''}${ablation.deltaPp}pp, discordant pairs ${ablation.discordant.onlyNormalized.length + ablation.discordant.onlyRaw.length}, McNemar exact p=${ablation.mcnemarExactP}.`,
  '',
  `> ${ablation.conclusion}. These numbers describe the harness and a non-LLM baseline. They are not a text-to-SQL SOTA claim.`,
  '',
);
console.log(lines.join('\n'));
