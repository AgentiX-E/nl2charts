/**
 * Paired ablation: does question normalization change which cases pass?
 * McNemar's exact test on the discordant pairs; with n=20 the test is
 * deliberately reported as underpowered rather than dressed up as a result.
 *
 * This module used to read `eval/out/results.json` — a file the *other* script writes —
 * for a single log line, so `pnpm bench:ablate` on a clean checkout failed with ENOENT
 * even though it runs every predictor it needs itself. The count it wanted is the number
 * of arms it ran, which it already knows.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { PREDICTORS, ROOT, assertControls, runPredictor } from './run.js';
import type { RunSummary } from './run.js';

const NORMALIZED = 'template';
const RAW = 'template-raw';

export function binomialTwoSided(discordant: number, minority: number): number {
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

export interface AblationReport {
  readonly generatedAt: string;
  readonly dataset: string;
  readonly cases: number;
  readonly arms: Record<string, number>;
  readonly discordant: { readonly onlyNormalized: readonly string[]; readonly onlyRaw: readonly string[] };
  readonly deltaPp: number;
  readonly mcnemarExactP: number;
  readonly conclusion: string;
}

export interface AblationResult {
  readonly report: AblationReport;
  readonly arms: number;
  readonly outFile: string;
}

/**
 * The comparison itself: which cases only one arm got right, and what that is worth.
 *
 * Split from the measurement so the discordant branches can be exercised. On the current
 * golden set the two arms agree on all twenty cases, so the "one arm only" paths and the
 * two non-degenerate conclusions were unreachable — the kind of code that rots silently and
 * then mislabels the first real disagreement.
 */
export function compareArms(normalized: RunSummary, raw: RunSummary): AblationReport {
  const onlyNormalized: string[] = [];
  const onlyRaw: string[] = [];
  for (const entry of normalized.cases) {
    const other = raw.cases.find((candidate) => candidate.id === entry.id);
    // A case one arm never ran is not a disagreement: counting it would credit an arm for a
    // case it skipped.
    if (other === undefined) continue;
    if (entry.exact && !other.exact) onlyNormalized.push(entry.id);
    if (!entry.exact && other.exact) onlyRaw.push(entry.id);
  }
  const discordant = onlyNormalized.length + onlyRaw.length;
  const pValue = binomialTwoSided(discordant, Math.min(onlyNormalized.length, onlyRaw.length));
  const delta = normalized.accuracy - raw.accuracy;
  return {
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
}

/**
 * What the run prints.
 *
 * The delta's sign and the two id lists are the parts a reader quotes, and both used to live
 * inside one interpolated template: a negative delta and an empty list were branches no test
 * could reach, because the fixture produces a positive delta with both lists populated. As a
 * function of the report, they are inputs a test chooses.
 */
export function ablationLines(report: AblationReport, normalizedAccuracy: number, rawAccuracy: number, outFile: string): string[] {
  const { onlyNormalized, onlyRaw } = report.discordant;
  return [
    `\nablation: ${NORMALIZED} ${(normalizedAccuracy * 100).toFixed(1)}% vs ${RAW} ${(rawAccuracy * 100).toFixed(1)}%`,
    `  delta ${report.deltaPp >= 0 ? '+' : ''}${report.deltaPp}pp, discordant ${String(onlyNormalized.length + onlyRaw.length)} ` +
      `(only ${NORMALIZED}: ${onlyNormalized.join(',') || '-'} / only ${RAW}: ${onlyRaw.join(',') || '-'})`,
    `  McNemar exact p=${String(report.mcnemarExactP)}; ${report.conclusion}`,
    `  ${String(PREDICTORS.length)} arms recorded; wrote ${outFile}`,
  ];
}

export async function runAblation(options: { readonly outDir?: string; readonly log?: (line: string) => void } = {}): Promise<AblationResult> {
  const normalized = await runPredictor(NORMALIZED);
  const raw = await runPredictor(RAW);
  const oracle = await runPredictor('oracle');
  const empty = await runPredictor('empty');

  // The same two controls the harness checks, checked by the same function: an ablation
  // whose judge cannot tell the oracle from the empty predictor measures nothing.
  assertControls([normalized, raw, oracle, empty]);

  const report = compareArms(normalized, raw);

  const outDir = options.outDir ?? join(ROOT, 'eval/out');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'ablation.json');
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

  // Every line the reader sees comes from `ablationLines`: printing the arm count here as well
  // duplicated it on the terminal, which read as two runs having happened.
  for (const line of ablationLines(report, normalized.accuracy, raw.accuracy, outFile)) options.log?.(line);
  return { report, arms: PREDICTORS.length, outFile };
}

export async function main(options: { readonly outDir?: string } = {}): Promise<number> {
  await runAblation({ ...options, log: (line) => console.log(line) });
  return 0;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
