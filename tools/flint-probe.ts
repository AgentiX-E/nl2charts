/**
 * What Microsoft's deterministic chart recommender reads on our corpus.
 *
 * **Not part of the build and not run in CI.** Run it by hand:
 *
 *     mkdir -p /tmp/flint && cd /tmp/flint && npm init -y && npm i flint-chart@1.1.1
 *     ln -sfn /tmp/flint/node_modules/flint-chart <repo>/node_modules/flint-chart
 *     pnpm exec tsx eval/text2vis/flint-probe.ts
 *
 * The alternative -- `flint-chart` in `devDependencies` -- was rejected on the reading below, not on
 * taste: see the `Flint` row of `docs/benchmarks.md`. A competitor's reading is a number to keep,
 * not a test to run on every push.
 *
 * Flint (`flint-chart@1.1.1`, MIT) ships `profileData` + `recommendChartTypes`: a curated
 * heuristic ranker over a table's shape with no model call. It is the closest published
 * sibling of `recommendChart` in this repository, and the one question nobody has asked of
 * it is what it scores on the rows we already score.
 *
 * It reads *only* the table, never the question -- `profileData(data, semanticTypes)` has no
 * place to put one -- so whatever it reads here is the shape half alone. That is the point:
 * the difference between this and `profile.ts` is the price of the question.
 */
import { loadText2Vis } from '../eval/text2vis/dataset.js';
import { parseResultSet, profileAnswer, typedRows } from '../eval/text2vis/profile.js';
import { familyOfLabel } from '../eval/text2vis/rule.js';


// Imported through a variable so `tsc` does not require the package to be installed: Flint is not a
// dependency of this repository (91 packages, 163 MB, five chart backends) and is not run in CI.
// The reading it produced is recorded in `docs/benchmarks.md`; this file is how to reproduce it.
const FLINT = 'flint-chart';
let recommendChartTypes: (data: Record<string, unknown>[], types: Record<string, string>, options?: { max?: number }) => string[];
try {
  const mod = (await import(FLINT)) as { recommendChartTypes: typeof recommendChartTypes };
  recommendChartTypes = mod.recommendChartTypes;
} catch {
  console.error(`flint-chart is not installed, and this repository does not depend on it.\nSee the install block in this file's header; the reading it produces is in docs/benchmarks.md.`);
  process.exit(2);
}

const { corpus } = await loadText2Vis({});
const rows = corpus.rows;

interface Tally {
  scored: number;
  hit: number;
  oursStrict: number;
  oursShortlist: number;
  oursDeclined: number;
  paired: number;
  noTable: number;
  unmappedLabel: number;
  unmappedChoice: number;
}
const tally: Tally = { scored: 0, hit: 0, oursStrict: 0, oursShortlist: 0, oursDeclined: 0, paired: 0, noTable: 0, unmappedLabel: 0, unmappedChoice: 0 };
const confusion = new Map<string, number>();
const samples: string[] = [];

for (const row of rows) {
  const gold = familyOfLabel(row.chartType);
  if (gold === undefined) {
    tally.unmappedLabel += 1;
    continue;
  }
  const text = row.raw['Table Data'] ?? '';
  if (text.trim().length === 0) {
    tally.noTable += 1;
    continue;
  }
  let data: Record<string, unknown>[];
  try {
    data = typedRows(parseResultSet(text));
  } catch {
    tally.noTable += 1;
    continue;
  }
  if (data.length === 0) {
    tally.noTable += 1;
    continue;
  }
  const ranked = recommendChartTypes(data, {}, { max: 3 });
  const top = ranked[0];
  if (top === undefined) {
    tally.unmappedChoice += 1;
    continue;
  }
  tally.scored += 1;
  const got = familyOfLabel(top);
  if (got === undefined) {
    tally.unmappedChoice += 1;
    if (samples.length < 12) samples.push(`${gold} <= flint "${top}"`);
    continue;
  }
  // The same row, read by this repository's own instrument, so the two numbers share a denominator.
  const mine = profileAnswer(row.prompt, text);
  if (mine.mark === 'declined') tally.oursDeclined += 1;
  if (mine.families[0] === gold) tally.oursStrict += 1;
  if (mine.families.includes(gold)) tally.oursShortlist += 1;
  const flintHit = got === gold;
  if (flintHit) tally.hit += 1;
  tally.paired += 1;
  const key = `${gold} -> ${got}`;
  confusion.set(key, (confusion.get(key) ?? 0) + 1);
  if (samples.length < 12) samples.push(`${gold} <= flint "${top}" (${ranked.join('|')})`);
}

const share = (n: number, d: number): string => (d === 0 ? 'n/a' : `${n} (${((n / d) * 100).toFixed(2)}%)`);
console.log(`flint rows            ${String(rows.length)}`);
console.log(`unmapped label        ${String(tally.unmappedLabel)}`);
console.log(`no readable table     ${String(tally.noTable)}`);
console.log(`unmapped flint type   ${String(tally.unmappedChoice)}`);
console.log(`scored                ${String(tally.scored)}`);
console.log(`flint top-1           ${share(tally.hit, tally.scored)}`);
console.log(`ours  top-1 strict    ${share(tally.oursStrict, tally.scored)}  declined ${String(tally.oursDeclined)}`);
console.log(`ours  shortlist       ${share(tally.oursShortlist, tally.scored)}`);
console.log('--- top choices seen ---');
console.log(samples.join('\n'));
console.log('--- confusion (top 12) ---');
for (const [key, n] of [...confusion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`${key}\t${String(n)}`);
}
