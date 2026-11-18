/**
 * Two judge readings of the same rows, read as a paired difference rather than as two means.
 *
 * The sixth reading of the chart agent is `3.44` and the fifth was `3.04`, and the difference between
 * those two numbers is **not** a measurement: the fifth was over 1,414 figures and the sixth over
 * 1,418, the marks changed for 140 rows, and a mean over a changing population cannot say which rows
 * moved. What can is the pair — the same corpus row, graded before and after, one difference per row
 * — and that is what this file computes.
 *
 * Three things make the result readable:
 *
 * 1. **Only rows graded in both readings are compared.** A row that was declined before the melt and
 *    drawn after it has no "before" score, and inventing one (a refusal is not a zero) would put a
 *    change of population inside a change of quality.
 * 2. **Every group carries its own interval.** The control groups are the point: 644 bar rows kept
 *    their mark across the change, so their difference measures the instrument rather than the work.
 *    A group whose interval includes zero is a group that did not move, and saying so is the only
 *    thing that makes the moved group credible.
 * 3. **The interval is the paired one** — `1.96 · SE` of the per-row differences, not of the two
 *    means. The rows are the unit and they are the same rows, which is exactly what a paired design
 *    buys: the between-row variance of chart quality drops out.
 *
 * The `reason` a row is in a group is carried as a string from the caller, because the groups are a
 * property of the change being priced — `melted` against `kept:bar` for the reshape, and something
 * else for the next change. This file knows how to compare, not what to compare.
 */
import { readFile } from 'node:fs/promises';
import { meltWide } from '@agentix-e/nl2charts-chart';
import { applyExitCode, isEntry, loadText2Vis, type LoadOptions } from './dataset.js';
import { parseResultSet, profileInputs, typedRows } from './profile.js';
import { chartJobs, messageOf } from './render.js';
import { familyOfLabel } from './rule.js';
import type { JudgeVerdict } from './judge.js';

/** One row, graded twice: correctness and readability, before and after. */
export interface PairedVerdict {
  readonly id: string;
  readonly before: readonly [number, number];
  readonly after: readonly [number, number];
  /** Which change, or which absence of change, this row is evidence about. */
  readonly group: string;
}

/** What one group of paired rows says. */
export interface GroupReading {
  readonly group: string;
  /** Rows graded in both readings. */
  readonly n: number;
  readonly correctness: { readonly before: number; readonly after: number; readonly delta: number; readonly interval: number | null };
  readonly readability: { readonly before: number; readonly after: number; readonly delta: number; readonly interval: number | null };
}

export interface AblationReading {
  readonly groups: readonly GroupReading[];
  /** Rows graded in both readings, whatever their group. */
  readonly paired: number;
  /** Rows the first reading graded and the second did not, and the other way round. */
  readonly dropped: number;
  readonly added: number;
}

/** The mean of a non-empty list. Separate so the empty case is impossible by construction. */
function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * The half-width of the 95% interval on a mean difference, or `null` for a single row.
 *
 * `null` rather than zero: one row has no variance to estimate, and an interval of zero would read as
 * a measurement that is exactly right. Two rows is the first count with a sample variance at all.
 */
function halfWidth(differences: readonly number[]): number | null {
  if (differences.length < 2) return null;
  const centre = mean(differences);
  const variance = differences.reduce((total, value) => total + (value - centre) ** 2, 0) / (differences.length - 1);
  return 1.96 * Math.sqrt(variance / differences.length);
}

/** Two scores out of a verdict, or nothing when the row was not graded. */
export function scoresOf(verdict: Partial<JudgeVerdict>): [number, number] | undefined {
  const one = verdict.chart_correctness;
  const two = verdict.readability;
  return typeof one === 'number' && typeof two === 'number' ? [one, two] : undefined;
}

/**
 * Pair two readings and read the difference, group by group.
 *
 * `groupOf` is asked about **ids**, not about rows: the caller knows what the change did to a row and
 * this file does not. An id the caller cannot place is grouped as `unknown` rather than dropped — a
 * row that disappeared from the analysis is the failure mode this whole instrument is against.
 */
export function ablateJudgePair(
  before: readonly JudgeVerdict[],
  after: readonly JudgeVerdict[],
  groupOf: (id: string) => string,
): AblationReading {
  const beforeById = new Map<string, [number, number]>();
  for (const verdict of before) {
    const scores = scoresOf(verdict);
    if (scores !== undefined) beforeById.set(verdict.id, scores);
  }
  const afterById = new Map<string, [number, number]>();
  for (const verdict of after) {
    const scores = scoresOf(verdict);
    if (scores !== undefined) afterById.set(verdict.id, scores);
  }
  const cells = new Map<string, { correctness: number[]; readability: number[]; before: number[]; after: number[]; beforeR: number[]; afterR: number[] }>();
  let paired = 0;
  for (const [id, first] of beforeById) {
    const second = afterById.get(id);
    if (second === undefined) continue;
    paired += 1;
    const group = groupOf(id);
    const cell = cells.get(group) ?? { correctness: [], readability: [], before: [], after: [], beforeR: [], afterR: [] };
    cells.set(group, cell);
    cell.correctness.push(second[0] - first[0]);
    cell.readability.push(second[1] - first[1]);
    cell.before.push(first[0]);
    cell.after.push(second[0]);
    cell.beforeR.push(first[1]);
    cell.afterR.push(second[1]);
  }
  const groups = [...cells.entries()]
    .map(([group, cell]) => ({
      group,
      n: cell.correctness.length,
      correctness: {
        before: mean(cell.before),
        after: mean(cell.after),
        delta: mean(cell.correctness),
        interval: halfWidth(cell.correctness),
      },
      readability: {
        before: mean(cell.beforeR),
        after: mean(cell.afterR),
        delta: mean(cell.readability),
        interval: halfWidth(cell.readability),
      },
    }))
    .sort((left, right) => right.n - left.n || left.group.localeCompare(right.group));
  // Counted rather than derived from the pair count: a row that only one reading saw is the one fact
  // about the two populations that a paired table cannot show.
  let dropped = 0;
  for (const id of beforeById.keys()) if (!afterById.has(id)) dropped += 1;
  let added = 0;
  for (const id of afterById.keys()) if (!beforeById.has(id)) added += 1;
  return { groups, paired, dropped, added };
}

/** The signed number a table shows, with its interval, or the words for "no interval". */
export function signed(value: number, interval: number | null): string {
  const sign = value < 0 ? '' : '+';
  const spread = interval === null ? '' : ` ± ${interval.toFixed(3)}`;
  return `${sign}${value.toFixed(3)}${spread}`;
}

/**
 * The table a log prints: one row per group, biggest first, with the intervals that license the claim.
 */
export function describeAblation(reading: AblationReading): readonly string[] {
  const lines = [
    `text2vis: ${String(reading.paired)} rows graded in both readings, ${String(reading.dropped)} only in the first, ${String(reading.added)} only in the second`,
  ];
  for (const group of reading.groups) {
    lines.push(
      `  ${group.group}: ${String(group.n)} rows, correctness ${group.correctness.before.toFixed(2)} → ${group.correctness.after.toFixed(2)} ` +
        `(${signed(group.correctness.delta, group.correctness.interval)}), readability ${group.readability.before.toFixed(2)} → ` +
        `${group.readability.after.toFixed(2)} (${signed(group.readability.delta, group.readability.interval)})`,
    );
  }
  // Said once, at the end, because it is the only sentence that turns the table into a claim. A group
  // of one row has no interval to be inside of, so it is not evidence either way and is not counted.
  const controls = reading.groups.filter(
    (group) => group.group !== 'melted' && group.group !== 'all' && group.correctness.interval !== null,
  );
  const moved = controls.filter((group) => Math.abs(group.correctness.delta) > (group.correctness.interval as number));
  const whole = reading.groups.find((group) => group.group === 'all');
  if (whole !== undefined) {
    // One population and no control: the instrument *is* the change under test, so there is nothing
    // held still to compare it against, and saying that is the honest version of the control line —
    // calling these rows a control would claim the population was unchanged by the thing being priced.
    lines.push(
      `  no control group: every paired row was changed by this comparison, so the ${String(whole.n)} rows are the population and the interval on their difference is the whole reading`,
    );
  } else {
    lines.push(
      moved.length === 0
        ? `  ${String(controls.length)} control group(s) that did not change kept their means: the instrument did not drift, so the groups that changed are the change`
        : `  ${String(moved.length)} control group(s) moved without being changed: ${moved.map((group) => group.group).join(', ')} — read that before the rest of the table`,
    );
  }
  const thin = reading.groups.filter((group) => group.correctness.interval === null);
  if (thin.length > 0) {
    lines.push(`  no interval: ${thin.map((group) => `${group.group} (${String(group.n)} row)`).join(', ')}, because a single row has no variance to estimate`);
  }
  return lines;
}

export interface AblateArgs {
  readonly before?: string;
  readonly after?: string;
  readonly artifact?: string;
  /**
   * How to cut the paired rows into groups.
   *
   * `auto` is the default and splits the rows by what the change did to them (`melted` against
   * `kept:<mark>`), which is the shape of a code change: some rows moved and the rest are the
   * control. `all` puts every paired row in one group named `all`, which is the shape of an
   * experiment that changed the *instrument* — a decode mode, a grader — because then no row was
   * left untouched and a grouped table would answer a question nobody asked.
   */
  readonly group?: 'auto' | 'all';
  readonly json: boolean;
}

export function parseAblateArgs(argv: readonly string[]): AblateArgs {
  let before: string | undefined;
  let after: string | undefined;
  let artifact: string | undefined;
  let group: 'auto' | 'all' | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--before' || flag === '--after' || flag === '--artifact' || flag === '--group') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      if (flag === '--before') before = value;
      else if (flag === '--after') after = value;
      else if (flag === '--artifact') artifact = value;
      else if (value === 'auto' || value === 'all') group = value;
      else throw new Error(`--group takes auto or all, not ${value}: a change to some rows is grouped by what it did to them, and a change to the instrument is one population`);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${flag}: this command pairs two judge readings, and takes --before <path>, --after <path>, --artifact <path>, --group <auto|all> and --json`);
  }
  return {
    json,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    ...(artifact === undefined ? {} : { artifact }),
    ...(group === undefined ? {} : { group }),
  };
}

export interface AblateEntryOptions {
  /** The arguments, always named: the caller that omits them is a caller with no command line. */
  readonly argv: readonly string[];
  readonly load?: LoadOptions;
}

/**
 * The grouping a code change is read with: what the change did to each row.
 *
 * The corpus is read for the grouping rather than for a score, and it is read through the same
 * `chartJobs` the renderer uses — so "which mark did this row end up as" and "did this table melt"
 * are answered by the code under test and not by a second copy of its rules in this file.
 */
async function autoGrouping(load: LoadOptions | undefined): Promise<(id: string) => string> {
  const { corpus } = await loadText2Vis(load);
  const inputs = profileInputs(corpus).filter((input) => familyOfLabel(input.label) !== undefined);
  const { jobs, refusals } = chartJobs(inputs);
  const marks = new Map<string, string>();
  for (const one of jobs) marks.set(one.id, one.mark);
  for (const one of refusals) marks.set(one.id, one.mark);
  const melted = new Set<string>();
  inputs.forEach((row, index) => {
    const set = parseResultSet(row.tableData);
    if (meltWide(typedRows(set), set.columns) !== undefined) melted.add(String(index));
  });
  // An id the corpus cannot place is grouped as `kept:unrendered` rather than dropped: a row that
  // leaves the table is the failure this instrument exists to prevent.
  return (id) => (melted.has(id) ? 'melted' : `kept:${marks.get(id) ?? 'unrendered'}`);
}

/**
 * The command: two artifacts and the corpus in, one paired table out.
 *
 * `--group auto` (the default) reads the rows by what the change did to them; `--group all` reads
 * them as one population, for an experiment that changed the instrument rather than some rows.
 */
export async function entryAblate(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  options: AblateEntryOptions,
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  try {
    const args = parseAblateArgs(options.argv);
    if (args.before === undefined || args.after === undefined) throw new Error('ablate: --before and --after are both required');
    const read = async (path: string): Promise<{ readonly verdicts: readonly JudgeVerdict[] }> => {
      const text = await readFile(path, 'utf8');
      const parsed = JSON.parse(text) as { readonly verdicts?: readonly JudgeVerdict[] };
      if (!Array.isArray(parsed.verdicts)) throw new Error(`ablate: ${path} has no verdicts, so it is not a judge reading`);
      return { verdicts: parsed.verdicts };
    };
    const before = await read(args.before);
    const after = await read(args.after);
    // The corpus is what `auto` needs and what `all` deliberately does not: a population reading is
    // about every row that was graded twice, and reading 6 MB of tables to answer "how many" would
    // make the cheap question as expensive as the expensive one.
    const groupOf =
      args.group === 'all'
        ? (): string => 'all'
        : await autoGrouping(options.load);
    const reading = ablateJudgePair(before.verdicts, after.verdicts, groupOf);
    if (args.json) log(JSON.stringify(reading, null, 2));
    else for (const line of describeAblation(reading)) log(line);
    if (args.artifact !== undefined) {
      const { mkdir, writeFile, rename } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(args.artifact), { recursive: true });
      await writeFile(`${args.artifact}.part`, `${JSON.stringify(reading, null, 2)}\n`);
      await rename(`${args.artifact}.part`, args.artifact);
      log(`text2vis: wrote ${args.artifact}`);
    }
    return 0;
  } catch (error) {
    log(`text2vis: ${messageOf(error)}`);
    return 1;
  }
}

void entryAblate(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`), {
  argv: process.argv.slice(2),
}).then((code) => applyExitCode(code, process));

