#!/usr/bin/env node
/** Render the live evaluation artifact as Markdown. Reads only; never recomputes. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
let report;
try {
  report = JSON.parse(readFileSync(join(ROOT, 'eval/out/live-eval.json'), 'utf8'));
} catch {
  console.log('## Live NL to SQL evaluation\n\nNo artifact was produced; see the job log.');
  process.exit(0);
}

const lines = [
  '## Live NL to SQL evaluation',
  '',
  `Model: \`${report.model}\` · cases: ${report.cases} · repeats: ${report.arms[0]?.repeats ?? 1} · dataset: \`${report.dataset}\``,
  '',
  '| arm | exact | 95% Wilson | passed/total | repeat flips |',
  '| --- | --- | --- | --- | --- |',
];
for (const arm of report.arms) {
  lines.push(
    `| ${arm.arm} | ${(arm.accuracy * 100).toFixed(1)}% | [${(arm.wilson.low * 100).toFixed(1)}, ${(arm.wilson.high * 100).toFixed(1)}] | ${arm.passed}/${arm.total} | ${arm.flips ?? 0} |`,
  );
}
lines.push('', '### Paired ablations', '', '| change | delta | discordant (only before / only after) | McNemar exact p |', '| --- | --- | --- | --- |');
for (const [name, effect] of Object.entries(report.ablations)) {
  lines.push(
    `| ${name} | ${effect.delta >= 0 ? '+' : ''}${(effect.delta * 100).toFixed(1)}pp | ${effect.onlyFirst} / ${effect.onlySecond} | ${effect.p} |`,
  );
}
lines.push('', '> Execution accuracy compares result sets, order-insensitive. Questions are generated from the schema; gold queries are executed before any model call. This is a module-level measurement, not a SOTA claim.', '');
console.log(lines.join('\n'));
