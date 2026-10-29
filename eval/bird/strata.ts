/**
 * Is a two-arm delta about the lever, or about the candidates the arms happened to draw?
 *
 * `select-mixed` and `select-cross` differ in exactly one declared coordinate: the author of
 * the first of their three candidate prompts. They do not, however, run the same *number* of
 * distinct prompts. `select-mixed` builds its three from three sources, and on the dev split
 * two of those sources produce byte-identical text for 933 of 1,532 questions, so 61% of its
 * cases were decided by two prompts. `select-cross` sends its first prompt to a second model,
 * which makes it distinct by construction: 1,532 of 1,532.
 *
 * A pooled delta across those arms therefore mixes two comparisons — three prompts against
 * three, and two prompts against three — in unknown proportion. This tool separates them. It
 * joins the artifact's own `mixedCandidatePrompts.degenerateIds` with `cases`, and reports the
 * paired delta, interval, p-value and resolution inside each stratum.
 *
 * The reading that motivated it: if the cross arm's advantage came from having a third
 * *distinct* prompt, the delta should be larger where the other arm had only two. It is not.
 * The sign holds in both strata at the same magnitude, which is what makes the pooled −0.78pp
 * a statement about the second model's prompt rather than about composition.
 *
 * Nothing here calls a model: it is a second reading of an artifact that already exists, which
 * is why the question could be asked at all rather than answered by another 1,532-case run.
 */
import { casesForEffect, mcnemarExact, pairedResolution } from '@agentix-e/nl2charts-devkit';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLAIM_PP = 0.02;

/** One row of the artifact's `cases`: what one arm did on one question. */
interface CaseRow {
  readonly arm: string;
  readonly id: string;
  readonly passed: boolean;
}

interface Artifact {
  readonly split?: string;
  readonly model?: string;
  readonly secondModel?: string;
  readonly cases?: readonly CaseRow[];
  readonly arms?: readonly { readonly arm: string; readonly passed: number; readonly total: number }[];
  readonly mixedCandidatePrompts?: readonly {
    readonly arm: string;
    readonly questions: number;
    readonly withAllDistinct: number;
    readonly degenerate: number;
    readonly degenerateIds?: readonly string[];
  }[];
  readonly ablations?: Readonly<Record<string, { readonly delta?: number; readonly onlyFirst?: number; readonly onlySecond?: number }>>;
}

export type Stratum = 'all' | 'distinct' | 'degenerate';

export interface StratumRow {
  readonly stratum: Stratum;
  readonly n: number;
  readonly first: number;
  readonly second: number;
  readonly onlyFirst: number;
  readonly onlySecond: number;
  /** Against minus first, as a fraction: the runner's sign convention. */
  readonly delta: number;
  readonly ci: { readonly low: number; readonly high: number };
  readonly p: number;
  readonly mde: number;
  readonly casesForClaim: number;
}

export interface StrataReading {
  readonly arm: string;
  readonly against: string;
  readonly split: string;
  /** The same population the runner scored, so there is always one of these. */
  readonly pooled: StratumRow;
  /** `pooled` first, then one row per stratum when the split could be computed. */
  readonly rows: readonly StratumRow[];
  /** Cases only one of the two arms scored, so they cannot be paired at all. */
  readonly unpaired: readonly string[];
  /** Where the stratum boundary comes from, and whether it is usable. */
  readonly stratifier: { readonly arm: string; readonly degenerate: number; readonly questions: number; readonly complete: boolean } | undefined;
  readonly problems: readonly string[];
}

/**
 * The per-case outcomes of two arms, keyed by question.
 *
 * A case that errored on one side is dropped with its id rather than counted as a failure:
 * an arm that never answered is not an arm that answered wrongly, and silently scoring it as
 * a zero is the defect the failure corpus exists to catch.
 */
export function pairCases(cases: readonly CaseRow[], arm: string, against: string): {
  pairs: { id: string; first: boolean; second: boolean }[];
  unpaired: string[];
} {
  const first = new Map<string, boolean>();
  const second = new Map<string, boolean>();
  for (const row of cases) {
    if (row.arm === arm) first.set(row.id, row.passed);
    else if (row.arm === against) second.set(row.id, row.passed);
  }
  const pairs: { id: string; first: boolean; second: boolean }[] = [];
  const unpaired: string[] = [];
  for (const [id, passed] of first) {
    const other = second.get(id);
    if (other === undefined) unpaired.push(id);
    else pairs.push({ id, first: passed, second: other });
  }
  for (const id of second.keys()) if (!first.has(id)) unpaired.push(id);
  return { pairs, unpaired };
}

export function summariseStratum(stratum: Stratum, pairs: readonly { first: boolean; second: boolean }[]): StratumRow {
  const n = pairs.length;
  let first = 0;
  let second = 0;
  let onlyFirst = 0;
  let onlySecond = 0;
  for (const pair of pairs) {
    if (pair.first) first += 1;
    if (pair.second) second += 1;
    if (pair.first && !pair.second) onlyFirst += 1;
    if (!pair.first && pair.second) onlySecond += 1;
  }
  // A stratum with no cases has no delta. Reporting 0 would be a measurement of nothing, and
  // `pairedResolution` answers exactly that — a zero-discordance zero — so the empty stratum
  // is refused here instead of being rendered as a tie. The numbers stay unrounded: they are
  // compared with the runner's own ablation row, and rounding first would turn an agreement
  // into a disagreement of the fourth decimal.
  const resolution = n === 0 ? undefined : pairedResolution(onlyFirst, onlySecond, n);
  return {
    stratum,
    n,
    first,
    second,
    onlyFirst,
    onlySecond,
    delta: n === 0 ? Number.NaN : (second - first) / n,
    ci: resolution === undefined ? { low: Number.NaN, high: Number.NaN } : { low: resolution.low, high: resolution.high },
    p: n === 0 ? Number.NaN : mcnemarExact(onlyFirst, onlySecond),
    mde: resolution === undefined ? Number.NaN : resolution.mde,
    casesForClaim: resolution === undefined ? 0 : casesForEffect(resolution.discordantShare, CLAIM_PP),
  };
}

/**
 * Split a paired comparison by whether the first arm could build the prompts it declares.
 *
 * The stratifier is the *first* arm's degeneracy on purpose: the question is "was this arm
 * running the arm it declared", and the answer belongs to one arm. A run whose first arm
 * declares nothing in `mixedCandidatePrompts` gets one pooled row and a stated reason — an
 * absent stratum is not an empty one.
 */
export function stratify(artifact: Artifact, arm: string, against: string): StrataReading {
  const problems: string[] = [];
  const pairs = pairCases(artifact.cases ?? [], arm, against);
  const pooled = summariseStratum('all', pairs.pairs);
  const rows: StratumRow[] = [pooled];
  const entry = artifact.mixedCandidatePrompts?.find((candidate) => candidate.arm === arm);
  let stratifier: StrataReading['stratifier'];
  if (entry === undefined) {
    problems.push(`the artifact records no candidate set for ${arm}, so this comparison cannot be stratified and the pooled row is all there is`);
  } else if (entry.degenerateIds === undefined) {
    problems.push(`the artifact counts ${String(entry.degenerate)} duplicated prompts for ${arm} but does not list them, so they cannot be joined to cases`);
  } else if (entry.degenerateIds.length !== entry.degenerate) {
    // The list and the count disagreeing is the one case where a stratum would be silently
    // assembled out of part of its membership, which reads as a measurement of the whole.
    problems.push(`the artifact lists ${String(entry.degenerateIds.length)} duplicated prompts for ${arm} and counts ${String(entry.degenerate)}, so the stratum would cover part of them`);
  } else {
    const degenerate = new Set(entry.degenerateIds);
    stratifier = { arm, degenerate: entry.degenerate, questions: entry.questions, complete: true };
    rows.push(
      summariseStratum('distinct', pairs.pairs.filter((pair) => !degenerate.has(pair.id))),
      summariseStratum('degenerate', pairs.pairs.filter((pair) => degenerate.has(pair.id))),
    );
  }
  return {
    arm,
    against,
    split: artifact.split ?? 'unknown',
    pooled,
    rows,
    unpaired: pairs.unpaired,
    stratifier,
    problems,
  };
}

/**
 * Cross-check the pooled row against the runner's own ablation for the same pair.
 *
 * Two readers of one artifact that disagree mean one of them is wrong, and the fix is to fail
 * rather than to print both and let the reader pick. The runner's row is authoritative for the
 * pooled numbers; this tool recomputes them from cases, so agreement is evidence that the join
 * is the same population the runner scored.
 */
export function checkAgainstAblation(reading: StrataReading, artifact: Artifact): string[] {
  const key = `${reading.arm} -> ${reading.against}`;
  const row = artifact.ablations?.[key];
  if (row === undefined) return [`the artifact carries no ablation row for ${key}, so the pooled row is unaudited`];
  const { pooled } = reading;
  // An artifact with no paired cases has nothing to compare: the pooled row's counts are
  // zero because nothing happened, not because the readers disagree. Saying so is the
  // difference between an unaudited row and a contradicted one.
  if (pooled.n === 0) return [`${key} has no paired cases in this artifact, so there is no pooled row to audit`];
  const problems: string[] = [];
  const expected = [
    ['delta', row.delta, pooled.delta],
    ['onlyFirst', row.onlyFirst, pooled.onlyFirst],
    ['onlySecond', row.onlySecond, pooled.onlySecond],
  ] as const;
  for (const [field, runs, here] of expected) {
    if (runs === undefined) continue;
    // An empty pooled row has no delta to disagree about; NaN here would read as a mismatch
    // between two readers when there is only one number, from the artifact, and no cases.
    if (typeof here === 'number' && Number.isNaN(here)) continue;
    const same = field === 'delta' ? Math.abs(runs - (here as number)) < 1e-9 : runs === here;
    if (!same) problems.push(`${key} carries ${field} ${String(runs)} in the artifact and ${String(here)} from its cases, so the two readers disagree`);
  }
  return problems;
}

const percent = (fraction: number): string => `${(fraction * 100).toFixed(1)}pp`;
/**
 * Interval bounds keep two decimals and an explicit sign.
 *
 * At one decimal a bound of +0.02pp renders as `0.0pp`, which reads as "exactly zero" — the
 * same mistake the A/A line used to make by printing 0.0pp and letting it pass for a fact.
 */
const bound = (fraction: number): string => `${fraction >= 0 ? '+' : ''}${(fraction * 100).toFixed(2)}pp`;
/** Only called for a stratum that has cases; an empty one is dashed before it gets here. */
const share = (count: number, total: number): string => `${((count / total) * 100).toFixed(1)}%`;

/**
 * Whether the strata point the same way, stated as what it means for the pooled number.
 *
 * A single stratum is not evidence of consistency, and a stratum too small to resolve its own
 * delta cannot disagree with anything — so the sentence names the resolutions rather than
 * asserting a verdict the sample cannot carry.
 */
export function conclusion(reading: StrataReading): string {
  const distinct = reading.rows.find((row) => row.stratum === 'distinct');
  const degenerate = reading.rows.find((row) => row.stratum === 'degenerate');
  if (distinct === undefined || degenerate === undefined) {
    return 'No stratum was available, so whether the delta survives a change in candidate independence is unanswered.';
  }
  // A stratum whose delta is exactly zero is not a third sign; it is a stratum that measured
  // no difference, and it therefore cannot corroborate a pooled number either way.
  if (distinct.delta === 0 || degenerate.delta === 0) {
    const flat = distinct.delta === 0 ? 'all prompts distinct' : 'the first arm duplicated a prompt';
    const other = distinct.delta === 0 ? degenerate : distinct;
    const otherName = distinct.delta === 0 ? 'with a duplicated prompt' : 'with 3 distinct prompts';
    return `There is no difference at all in one stratum (${flat}: 0.0pp) and ${percent(other.delta)} ${otherName} in the other, so the pooled delta is carried by half the cases alone — a stratum that measured no difference cannot corroborate or contradict it.`;
  }
  const sameSign = Math.sign(distinct.delta) === Math.sign(degenerate.delta);
  const largest = Math.max(distinct.mde, degenerate.mde);
  const shape = `${percent(distinct.delta)} with 3 distinct prompts, ${percent(degenerate.delta)} with a duplicated one`;
  return sameSign
    ? `The delta has the same sign in both strata (${shape}), so it is not a composition effect — but neither stratum resolves better than ${percent(largest)} on its own, which is why the pooled row carries the claim.`
    : `The delta has opposite signs in the two strata (${shape}), so the pooled number is a weighted average of two populations and describes neither.`;
}

export function reportLines(reading: StrataReading): string[] {
  const lines = [
    `${reading.arm} vs ${reading.against} on ${reading.split}: ${String(reading.pooled.n)} paired cases`,
    '',
    '| stratum | n | first | against | delta | 95% CI | p | resolves (80%) | cases for 2pp |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of reading.rows) {
    const label =
      row.stratum === 'all' ? 'all cases' : row.stratum === 'distinct' ? 'all prompts distinct' : 'first arm duplicated a prompt';
    // An empty stratum is stated as empty rather than as a 0.0pp tie between two arms that
    // never met on a single question.
    lines.push(
      row.n === 0
        ? `| ${label} | 0 | — | — | — | — | — | — | — |`
        : `| ${label} | ${String(row.n)} | ${share(row.first, row.n)} | ${share(row.second, row.n)} | ${percent(row.delta)} | ` +
            `[${bound(row.ci.low)}, ${bound(row.ci.high)}] | ${row.p.toFixed(3)} | ${percent(row.mde)} | ${String(row.casesForClaim)} |`,
    );
  }
  if (reading.stratifier !== undefined) {
    lines.push(
      '',
      `Stratified by \`${reading.stratifier.arm}\`: ${String(reading.stratifier.degenerate)} of ${String(reading.stratifier.questions)} questions could not build the declared number of distinct prompts.`,
    );
  }
  if (reading.unpaired.length > 0) {
    lines.push(`Dropped ${String(reading.unpaired.length)} cases one arm never scored (${reading.unpaired.slice(0, 5).join(', ')}), which are not failures.`);
  }
  lines.push('', conclusion(reading));
  for (const problem of reading.problems) lines.push(`  note: ${problem}`);
  return lines;
}

export interface StrataSettings {
  readonly reportPath: string;
  readonly arm: string;
  readonly against: string;
}

export function resolveStrataSettings(argv: readonly string[], env: Record<string, string | undefined>, root: string): StrataSettings {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const reportPath = resolve(root, value('--report') ?? env.BIRD_REPORT ?? 'eval/out/bird-eval.json');
  const arm = value('--arm');
  const against = value('--against');
  if (arm === undefined || against === undefined || arm === against) {
    throw new Error('usage: strata.ts --arm <first arm> --against <second arm> [--report <artifact>]');
  }
  return { reportPath, arm, against };
}

export function readArtifact(path: string): Artifact {
  return JSON.parse(readFileSync(path, 'utf8')) as Artifact;
}

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

/**
 * Read one artifact and print the strata. No model, no database, no network.
 *
 * It throws after printing when the artifact and the cases disagree, because a tool whose
 * output contradicts the file it read should not exit 0 with a table nobody can trust.
 */
export async function main(argv: readonly string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env, root: string = ROOT): Promise<void> {
  const settings = resolveStrataSettings(argv, env, root);
  const artifact = readArtifact(settings.reportPath);
  const reading = stratify(artifact, settings.arm, settings.against);
  for (const line of reportLines(reading)) console.log(line);
  const audit = checkAgainstAblation(reading, artifact);
  for (const note of audit) console.log(`  note: ${note}`);
  if (audit.some((note) => note.includes('disagree'))) throw new Error(audit.join('; '));
}

/**
 * Whether this module is the process entry point.
 *
 * A value rather than an inline guard: `process.argv[1]` is never the entry inside a test
 * process, so an inline `argv[1] !== undefined && …` leaves its first half permanently dark
 * and a guard nobody has executed is a CLI nobody has run.
 */
export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  await main();
}
