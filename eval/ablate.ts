import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, runPredictor } from './run.js';

/**
 * Paired ablation: does question normalization change which cases pass?
 * McNemar's exact test on the discordant pairs; with n=20 the test is
 * deliberately reported as underpowered rather than dressed up as a result.
 */
function binomialTwoSided(discordant: number, minority: number): number {
  if (discordant === 0) return 1;
  const logFactorial = (n: number): number => {
    let total = 0;
    for (let index = 2; index <= n; index += 1) total += Math.log(index);
    return total;
  };
  let tail = 0;
  for (let k = 0; k <= minority; k += 1) {
    tail += Math.exp(logFactorial(discordant) - logFactorial(k) - logFactorial(discordant - k) - discordant * Math.log(2));
  }
  return Math.min(1, 2 * tail);
}

const NORMALIZED = 'template';
const RAW = 'template-raw';

const normalized = await runPredictor(NORMALIZED);
const raw = await runPredictor(RAW);
const oracle = await runPredictor('oracle');
const empty = await runPredictor('empty');

if (oracle.accuracy !== 1 || empty.accuracy !== 0) throw new Error('controls do not hold; ablation is meaningless');

const onlyNormalized: string[] = [];
const onlyRaw: string[] = [];
for (const entry of normalized.cases) {
  const other = raw.cases.find((candidate) => candidate.id === entry.id);
  if (!other) continue;
  if (entry.exact && !other.exact) onlyNormalized.push(entry.id);
  if (!entry.exact && other.exact) onlyRaw.push(entry.id);
}
const discordant = onlyNormalized.length + onlyRaw.length;
const pValue = binomialTwoSided(discordant, Math.min(onlyNormalized.length, onlyRaw.length));

const delta = normalized.accuracy - raw.accuracy;
const report = {
  generatedAt: new Date().toISOString(),
  dataset: 'eval/golden.jsonl',
  cases: normalized.total,
  arms: {
    [NORMALIZED]: normalized.accuracy,
    [RAW]: raw.accuracy,
  },
  discordant: { onlyNormalized, onlyRaw },
  deltaPp: Number((delta * 100).toFixed(2)),
  mcnemarExactP: Number(pValue.toFixed(4)),
  conclusion:
    discordant === 0
      ? 'no discordant pairs; the arms are indistinguishable on this set'
      : pValue < 0.05
        ? 'normalization changes accuracy at the 5% level'
        : 'direction observed but not significant at this sample size; keep the ablation open',
};

mkdirSync(join(ROOT, 'eval/out'), { recursive: true });
writeFileSync(join(ROOT, 'eval/out/ablation.json'), `${JSON.stringify(report, null, 2)}\n`);

const summary = JSON.parse(readFileSync(join(ROOT, 'eval/out/results.json'), 'utf8')) as { summaries: unknown[] };
console.log(`\nablation: ${NORMALIZED} ${(normalized.accuracy * 100).toFixed(1)}% vs ${RAW} ${(raw.accuracy * 100).toFixed(1)}%`);
console.log(`  delta ${report.deltaPp >= 0 ? '+' : ''}${report.deltaPp}pp, discordant ${discordant} (only ${NORMALIZED}: ${onlyNormalized.join(',') || '-'} / only ${RAW}: ${onlyRaw.join(',') || '-'})`);
console.log(`  McNemar exact p=${report.mcnemarExactP}; ${report.conclusion}`);
console.log(`  ${summary.summaries.length} arms recorded; wrote eval/out/ablation.json`);
