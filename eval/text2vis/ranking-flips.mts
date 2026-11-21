/**
 * What the ranking cue buys and what it costs, row by row.
 *
 * The sweep prices `no-ranking` at 669 against the shipped 664 — five rows better on the total, and
 * `+8 / −3` across the two halves, so the guard calls it fitted. A total and a fitted flag say nothing
 * about *which* rows move, and the family columns (bar −67, pie +39, line +25) say only that the cue is
 * load-bearing in both directions. This probe prints the rows, so the next narrowing is proposed from
 * what the cue is doing rather than from its net.
 */
import { profilesOf, parseResultSet } from './profile.js';
import { loadText2Vis } from './dataset.js';
import { CUE_VARIANTS, familiesOfMark, familyCue, familyOfLabel } from './rule.js';
import { censusInputs } from './census.js';
import { recommendChart } from '@agentix-e/nl2charts-chart';
import type { CueRule } from '@agentix-e/nl2charts-chart';

const variant = CUE_VARIANTS.find((entry) => entry.name === (process.argv[2] ?? 'no-ranking'));
if (variant === undefined) throw new Error('no such variant');
const { corpus } = await loadText2Vis();
const rows = censusInputs(corpus);

interface Flip {
  readonly kind: 'lost' | 'won';
  readonly expected: string;
  readonly shipped: string;
  readonly changed: string;
  readonly prompt: string;
}

const flips: Flip[] = [];
for (const row of rows) {
  const expected = familyOfLabel(row.label);
  if (expected === undefined) continue;
  const set = parseResultSet(row.tableData);
  const profiles = profilesOf(set);
  if (profiles.length === 0) continue;
  const answer = (cues?: readonly CueRule[]): string | undefined => {
    const choice = recommendChart(row.prompt, profiles, { rows: set.rows.length, ...(cues === undefined ? {} : { cues }) });
    const top = choice.recommendations[0];
    return top === undefined ? undefined : familiesOfMark(top.mark, familyCue(top.cues))[0];
  };
  const shipped = answer();
  const changed = answer(variant.cues);
  const hitShipped = shipped === expected;
  const hitChanged = changed === expected;
  if (hitShipped === hitChanged) continue;
  flips.push({
    kind: hitShipped ? 'lost' : 'won',
    expected,
    shipped: shipped ?? '-',
    changed: changed ?? '-',
    prompt: row.prompt,
  });
}

const lost = flips.filter((flip) => flip.kind === 'lost');
const won = flips.filter((flip) => flip.kind === 'won');
console.log(`${variant.name}: lost ${String(lost.length)}, won ${String(won.length)}`);
const table = (list: readonly Flip[]): string => {
  const counts = new Map<string, number>();
  for (const flip of list) {
    const key = `${flip.expected} <- ${flip.changed}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([key, n]) => `${key}:${String(n)}`)
    .join('  ');
};
console.log(`  lost by label <- answer: ${table(lost)}`);
console.log(`  won  by label <- answer: ${table(won)}`);
for (const flip of lost.slice(0, 6)) console.log(`  LOST ${flip.expected} -> ${flip.changed}: ${flip.prompt.slice(0, 150)}`);
for (const flip of won.slice(0, 6)) console.log(`  WON  ${flip.expected} <- ${flip.changed}: ${flip.prompt.slice(0, 150)}`);
