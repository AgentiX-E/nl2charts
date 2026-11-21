/**
 * List the rows of one family the product misses, with the words they use.
 *
 * A reading aid rather than a gate: it answers "which rows, and what do they say", and the number it
 * exists for (`uncued 40`) is already in the census. It is a `.mts` on purpose — the eval coverage
 * ledger measures the TypeScript files under `eval/`, and a probe with no branches should not lower a
 * number that a gate reads.
 *
 * The reading is 50 of 90. The 50 are the rows whose question says "histogram"; the 40 name the
 * distribution some other way. This probe prints them, so the next cue widening is proposed from
 * their words rather than from a guess.
 */
import { loadText2Vis } from './dataset.js';
import { classify, censusInputs } from './census.js';

const { corpus } = await loadText2Vis();
const inputs = censusInputs(corpus);
const misses: string[] = [];
const hits: string[] = [];
for (const input of inputs) {
  if (input.label !== (process.argv[2] ?? 'Histogram')) continue;
  const row = classify(input);
  if (row.outcome === 'hit') hits.push(input.prompt);
  else misses.push(`${row.outcome}\t${'answered' in row ? String(row.answered) : '-'}\t${input.prompt}`);
}
console.log(`rows: ${String(hits.length + misses.length)}, hit ${String(hits.length)}, miss ${String(misses.length)}`);
console.log('--- misses ---');
for (const line of misses) console.log(line);
console.log('--- hits (first 12) ---');
for (const line of hits.slice(0, 12)) console.log(line);
const words = new Map<string, number>();
for (const line of misses) {
  for (const word of line.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []) {
    words.set(word, (words.get(word) ?? 0) + 1);
  }
}
console.log('--- frequent words in the misses ---');
console.log(
  [...words.entries()]
    .filter(([, n]) => n >= 2)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 40)
    .map(([word, n]) => `${word}:${String(n)}`)
    .join(' '),
);
