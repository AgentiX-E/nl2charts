/**
 * What the stronger model wrote differently, read off the statements themselves.
 *
 * The model comparison this repository published is a difference of two rates: 941 against 884
 * on the same 1,532 questions, `-3.72pp`, and a bucket that moved `column-count` 130 -> 204.
 * Every sentence after that number was an inference from *result sets*: a wider result means a
 * wider select list, and nothing more. The statements were in memory while the run happened and
 * were not written to the artifact, so "the reasoner projects too many columns" was a hypothesis
 * this codebase could not check — the same defect the failure taxonomy was built to remove, one
 * layer up: *the result set says "wrong", the statement says "why"*, and the artifact kept only
 * the first.
 *
 * This instrument closes that gap with no model call. It reads the statements the run recorded
 * and answers three questions a rate cannot:
 *
 * - **How wide is each answer, against the gold's width?** `wider`, `same`, `narrower` per arm,
 *   with `select *` counted separately because it is not a wide list but the absence of one.
 * - **Where did an extra column come from?** A column the statement had already named in its own
 *   filter, grouping or ordering is a *carried* column — the model read it, then projected it. A
 *   column named nowhere else in the statement is *invented*. The two are different repairs: the
 *   first is a projection rule, the second is a schema-linking problem.
 * - **Did the arm generate more on the cases it got wrong?** The chain of thought is not kept, but
 *   its token count is — a reasoning endpoint bills the thought as completion — and a longer
 *   generation on a wider answer is the mechanism the literature names (syntactic noise,
 *   over-thinking on easy questions) rather than a story about model quality.
 * - **Is the widening difference bigger than the run-to-run displacement?** The counts are paired
 *   by question, so the comparison is an exact McNemar test with an interval and a resolution,
 *   which is the form every other claim in this repository is held to.
 *
 * The literature says the direction is ordinary: Snowflake's ExCoT reports simple CoT *lower*
 * than direct generation on BIRD-dev, AutoThinkSQL reports CoT introducing syntactic noise and
 * hallucination that direct generation does not, and an independent small-model study finds CoT
 * on BIRD "less helpful" than on Spider. A reasoning model losing to a chat model on this
 * benchmark is not an anomaly to explain away; it is the expected shape, and the job here is to
 * say *which* mechanism is ours.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { mcnemarExact, pairedResolution, type PairedResolution } from '@agentix-e/nl2charts-devkit';

import { statementShape } from './sql-shape.js';

/** One case as the artifact files it, with the statement the arm wrote. */
export interface StatementCase {
  readonly arm: string;
  readonly id: string | number;
  readonly passed?: boolean;
  readonly reason?: string;
  /** The statement the arm returned, when the run recorded it. */
  readonly sql?: string;
  /** The gold statement for this question, when the run recorded it. */
  readonly gold?: string;
  /**
   * The provider's own count for this case, when there is one.
   *
   * `completion` is every token the endpoint generated, and on a reasoning family that includes
   * the chain of thought. A chat model's 49 against a reasoner's 500 is therefore the same
   * figure measuring the same thing on both sides, which a character count of the answer alone
   * would not be. `0` is a measurement and an absent block is the other measurement.
   */
  readonly tokens?: { readonly completion?: number };
}

/** The part of a run artifact this instrument reads. */
export interface StatementArtifact {
  readonly split?: string;
  readonly model?: string;
  readonly cases?: readonly StatementCase[];
  readonly failures?: unknown;
}

/** One question's answer compared with its gold, statement against statement. */
export interface StatementReading {
  readonly id: string;
  readonly arm: string;
  readonly reason: string;
  readonly wildcard: boolean;
  readonly predicted: number;
  readonly gold: number;
  readonly extra: readonly string[];
  readonly missing: readonly string[];
  /** Extra columns the statement had already named in its own filter, grouping or ordering. */
  readonly extraFromKey: readonly string[];
  readonly completionTokens?: number;
}

/** What one arm's statements add up to. */
export interface ArmProfile {
  readonly arm: string;
  readonly cases: number;
  readonly wildcard: number;
  readonly wider: number;
  readonly same: number;
  readonly narrower: number;
  readonly extraItems: number;
  readonly extraFromKey: number;
  readonly missingItems: number;
  readonly completionCases: number;
  readonly completionMean: number;
  readonly completionOnWrong: number;
  readonly completionOnRight: number;
}

/**
 * Whether a select list is a wildcard.
 *
 * `count(*)` is deliberately not one: it is the narrowest answer to "how many", and reading it
 * as a wildcard would credit the model with an error it did not make.
 */
export function readsWildcard(sql: string): boolean {
  return /\bselect\s+(?:distinct\s+)?(?:\w+\s*\.\s*)?\*/i.test(sql);
}

/**
 * The column an item reads, for comparing an item against the clauses of its own statement.
 *
 * The last identifier wins, so `count(distinct t.name)` is named by `name` and `a.id + 1` by
 * `id`. A constant names nothing, and returning an empty string rather than the literal keeps
 * `1` from matching a column called `1`.
 */
export function columnOf(item: string): string {
  const cleaned = item.replace(/'([^']|'')*'/g, ' ').replace(/"[^"]*"/g, (match) => match.slice(1, -1));
  const named = [...cleaned.toLowerCase().matchAll(/[a-z_][a-z0-9_]*/g)].map((match) => match[0]);
  const keywords = new Set(['distinct', 'as', 'cast', 'integer', 'real', 'text', 'null', 'case', 'when', 'then', 'else', 'end']);
  const columns = named.filter((name) => !keywords.has(name));
  return columns.length === 0 ? '' : (columns[columns.length - 1] as string);
}

/**
 * The columns a statement names anywhere other than its select list.
 *
 * A column that appears here was read by the statement already. That is the distinction the
 * instrument needs: projecting a column you already filtered on is a different mistake from
 * projecting a column you invented, and only the first is addressable by a projection rule.
 */
function keyColumns(sql: string): Set<string> {
  const shape = statementShape(sql);
  const text = [...shape.predicates, ...shape.groups, shape.window].join(' ');
  const named = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z_][a-z0-9_]*/g)) named.add(match[0]);
  return named;
}

/**
 * The start of the outermost `select`, on a statement that may open with a CTE.
 *
 * `with a as (select ...) select ...` has two select lists, and the answer's projection is the
 * second one. The clause reader anchors at `select ... from`, so a statement that opens with
 * `with` matched nothing and fell through to "everything after the keyword is one item" — which
 * read a four-column answer as a one-column answer. That is not a hypothetical: on the
 * 1,532-question split the reasoning model wrote a CTE on 24 cases and the chat model on none, so
 * the misreading would have landed entirely on one side of the comparison it was built for.
 *
 * The scan is by parenthesis depth, so a `select` inside a subquery or a CTE does not qualify,
 * and a `select` inside a string literal does not either.
 */
export function outerSelect(sql: string): string {
  let depth = 0;
  let quote: string | undefined;
  let start = -1;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index] as string;
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (depth === 0 && /^select\b/i.test(sql.slice(index, index + 6)) && !/[a-z0-9_]/i.test(sql[index - 1] ?? '')) {
      start = index;
    }
  }
  return start === -1 ? sql : sql.slice(start);
}

export interface ReadInput {
  readonly arm: string;
  readonly id: string | number;
  readonly reason: string;
  readonly predicted: string;
  readonly gold: string;
  readonly completionTokens?: number;
}

/**
 * One statement against its gold.
 *
 * A wildcard is recorded as a flag and not as a wide list, because a wildcard has no item list
 * to compare: inventing one would put a guess in a column of measurements.
 */
export function readStatement(input: ReadInput): StatementReading {
  // A reply that is not a statement has no select list, and the parser in `sql-shape` treats
  // everything after a missing `select` as one item — which read a prose apology as a
  // one-column answer. That is the same mistake as "an endpoint that said nothing" filed as
  // "said zero": the reply did not answer, so its projection is empty and the whole gold is
  // missing, and saying so is the measurement.
  const isStatement = /^\s*(?:select|with)\b/i.test(input.predicted);
  // The wildcard, like the projection, is a property of the outermost statement: a CTE that
  // reads `select *` to feed a named answer is not a wildcard answer.
  const wildcard = isStatement && readsWildcard(outerSelect(input.predicted));
  const mine = !isStatement || wildcard ? [] : statementShape(outerSelect(input.predicted)).projection;
  const theirs = statementShape(outerSelect(input.gold)).projection;
  const goldSet = new Set(theirs);
  const mineSet = new Set(mine);
  const extra = wildcard ? [] : mine.filter((item) => !goldSet.has(item));
  const missing = theirs.filter((item) => !mineSet.has(item));
  const keys = keyColumns(outerSelect(input.predicted));
  return {
    id: String(input.id),
    arm: input.arm,
    reason: input.reason,
    wildcard,
    predicted: mine.length,
    gold: theirs.length,
    extra,
    missing,
    extraFromKey: extra.filter((item) => {
      const column = columnOf(item);
      return column !== '' && keys.has(column);
    }),
    ...(input.completionTokens === undefined ? {} : { completionTokens: input.completionTokens }),
  };
}

/** Every reading one arm's cases produce, skipping the cases that recorded no statement. */
export function armReadings(cases: readonly StatementCase[], arm: string): StatementReading[] {
  return cases
    .filter((row) => row.arm === arm && typeof row.sql === 'string' && typeof row.gold === 'string')
    .map((row) =>
      readStatement({
        arm,
        id: row.id,
        reason: row.reason ?? (row.passed === true ? 'match' : 'unknown'),
        predicted: row.sql as string,
        gold: row.gold as string,
        ...(row.tokens?.completion === undefined ? {} : { completionTokens: row.tokens.completion }),
      }),
    );
}

export function armProfile(readings: readonly StatementReading[], arm: string): ArmProfile {
  const own = readings.filter((row) => row.arm === arm);
  const counted = own.filter((row) => !row.wildcard);
  const metered = own.filter((row) => row.completionTokens !== undefined);
  const mean = (rows: readonly StatementReading[]): number =>
    rows.length === 0 ? 0 : rows.reduce((total, row) => total + (row.completionTokens ?? 0), 0) / rows.length;
  return {
    arm,
    cases: own.length,
    wildcard: own.filter((row) => row.wildcard).length,
    wider: counted.filter((row) => row.predicted > row.gold).length,
    same: counted.filter((row) => row.predicted === row.gold).length,
    narrower: counted.filter((row) => row.predicted < row.gold).length,
    extraItems: own.reduce((total, row) => total + row.extra.length, 0),
    extraFromKey: own.reduce((total, row) => total + row.extraFromKey.length, 0),
    missingItems: own.reduce((total, row) => total + row.missing.length, 0),
    completionCases: metered.length,
    completionMean: mean(metered),
    completionOnWrong: mean(metered.filter((row) => row.reason !== 'match')),
    completionOnRight: mean(metered.filter((row) => row.reason === 'match')),
  };
}

function share(count: number, total: number): string {
  return total === 0 ? '  -  ' : `${((count / total) * 100).toFixed(1)}%`;
}

/**
 * The same widening, paired question by question, with a test on it.
 *
 * The table above is two descriptions. The sentence it is asked to support — *the stronger model
 * widens more* — is a difference of two rates measured on the same questions, and the counts
 * `100` against `183` are published nowhere with an interval. That is the defect this repository
 * already named for accuracy (`pairedResolution` exists because a bare delta cannot say whether a
 * design could have seen it), one bucket over: on paired data only the discordant questions carry
 * information, and a difference of two marginal counts is not a paired difference.
 *
 * A case is paired only when both sides produced a projection to compare. A wildcard on either
 * side is skipped and counted: it has no item list, so filing it as "not wider" would put a zero
 * in the discordance the model never asserted, and filing it as "wider" would credit the model
 * with a list it did not write.
 *
 * The paired denominator is the intersection, not either arm's own scorable set, so the rates here
 * can differ from the table's by a tenth of a point. That is not an inconsistency: the table counts
 * each arm against everything it answered, and this counts both arms against the questions they
 * both projected.
 */
export interface WidthPair {
  readonly left: string;
  readonly right: string;
  /** Questions with a comparable projection on both sides. */
  readonly paired: number;
  /** Questions dropped because one side answered with a wildcard. */
  readonly skipped: number;
  readonly widerLeftOnly: number;
  readonly widerRightOnly: number;
  readonly widerBoth: number;
  readonly widerNeither: number;
  readonly leftRate: number;
  readonly rightRate: number;
  readonly p: number;
  readonly test: PairedResolution;
}

export function pairWidths(
  readings: readonly StatementReading[],
  left: string,
  right: string,
): WidthPair | undefined {
  const index = (label: string): Map<string, StatementReading> => {
    const rows = new Map<string, StatementReading>();
    // Later duplicates win, because a re-scored case is the later one.
    for (const row of readings) if (row.arm === label) rows.set(row.id, row);
    return rows;
  };
  const leftRows = index(left);
  const rightRows = index(right);
  let paired = 0;
  let skipped = 0;
  let widerLeftOnly = 0;
  let widerRightOnly = 0;
  let widerBoth = 0;
  let widerNeither = 0;
  for (const [id, one] of leftRows) {
    const two = rightRows.get(id);
    if (two === undefined) continue;
    if (one.wildcard || two.wildcard) {
      skipped += 1;
      continue;
    }
    paired += 1;
    const wideLeft = one.predicted > one.gold;
    const wideRight = two.predicted > two.gold;
    if (wideLeft && wideRight) widerBoth += 1;
    else if (!wideLeft && !wideRight) widerNeither += 1;
    else if (wideLeft) widerLeftOnly += 1;
    else widerRightOnly += 1;
  }
  if (paired === 0) return undefined;
  return {
    left,
    right,
    paired,
    skipped,
    widerLeftOnly,
    widerRightOnly,
    widerBoth,
    widerNeither,
    leftRate: (widerLeftOnly + widerBoth) / paired,
    rightRate: (widerRightOnly + widerBoth) / paired,
    p: mcnemarExact(widerLeftOnly, widerRightOnly),
    test: pairedResolution(widerLeftOnly, widerRightOnly, paired),
  };
}

/** Points, printed with their sign, so a negative delta is not read as a typo. */
function points(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}pp`;
}

/**
 * A p-value, without the `0.0000` that reads as "zero".
 *
 * `toFixed(4)` on a result 20 orders of magnitude below 1 prints a zero, and a zero p-value is not
 * a quantity — the exact test has no mass there. The threshold is the one the rest of this
 * repository's prose already uses (`p < 0.0001`), written as an inequality instead of rounded away.
 */
function pValue(p: number): string {
  return p < 0.0001 ? '< 0.0001' : p.toFixed(4);
}

export function pairedWidthLines(pair: WidthPair): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(
    `  wider than gold, paired: ${pair.left} -> ${pair.right}, ${String(pair.paired)} question(s) projected on both sides`,
  );
  lines.push(
    `  wider only left ${String(pair.widerLeftOnly)}  only right ${String(pair.widerRightOnly)}  wide in both ${String(pair.widerBoth)}  wide in neither ${String(pair.widerNeither)}`,
  );
  lines.push(
    `  ${(pair.leftRate * 100).toFixed(1)}% -> ${(pair.rightRate * 100).toFixed(1)}%  ${points(pair.test.delta)}  95% CI [${points(pair.test.low)}, ${points(pair.test.high)}]  exact McNemar p = ${pValue(pair.p)}`,
  );
  lines.push(
    `  this design resolves ${(pair.test.mde * 100).toFixed(2)}pp at ${(pair.test.discordantShare * 100).toFixed(1)}% discordance`,
  );
  if (pair.skipped > 0) {
    lines.push(`  ${String(pair.skipped)} case(s) skipped: a wildcard on one side has no item list to compare`);
  }
  return lines;
}

/**
 * One line per quantity, both arms side by side.
 *
 * Side by side rather than one block per arm because the only question this prints is a
 * comparison: a reader who has to scroll between two blocks is reading two descriptions instead
 * of one difference.
 */
export function reasoningLines(profiles: readonly ArmProfile[]): string[] {
  const lines: string[] = [];
  const heads = profiles.map((profile) => profile.arm.padEnd(32));
  lines.push(`  ${' '.repeat(26)}${heads.join('')}`);
  const row = (label: string, values: readonly string[]): void => {
    lines.push(`  ${label.padEnd(26)}${values.map((value) => value.padEnd(32)).join('')}`);
  };
  row('scored statements', profiles.map((profile) => String(profile.cases)));
  row('select *', profiles.map((profile) => `${String(profile.wildcard)}  ${share(profile.wildcard, profile.cases)}`));
  row('wider than gold', profiles.map((profile) => `${String(profile.wider)}  ${share(profile.wider, profile.cases)}`));
  row('the same width', profiles.map((profile) => `${String(profile.same)}  ${share(profile.same, profile.cases)}`));
  row('narrower than gold', profiles.map((profile) => `${String(profile.narrower)}  ${share(profile.narrower, profile.cases)}`));
  row('extra items', profiles.map((profile) => String(profile.extraItems)));
  row('  of which carried', profiles.map((profile) => `${String(profile.extraFromKey)}  ${share(profile.extraFromKey, profile.extraItems)}`));
  row('missing items', profiles.map((profile) => String(profile.missingItems)));
  row(
    'generated tokens: mean',
    profiles.map((profile) => (profile.completionCases === 0 ? 'not reported' : `${profile.completionMean.toFixed(0)}`)),
  );
  row(
    '  on wrong answers',
    profiles.map((profile) => (profile.completionCases === 0 ? 'not reported' : `${profile.completionOnWrong.toFixed(0)}`)),
  );
  row(
    '  on right answers',
    profiles.map((profile) => (profile.completionCases === 0 ? 'not reported' : `${profile.completionOnRight.toFixed(0)}`)),
  );
  lines.push('');
  lines.push('  an extra item is `carried` when the statement already named that column in its own');
  lines.push('  filter, grouping or ordering: it read the column, then projected it. The rest are');
  lines.push('  invented, which is a schema-linking problem rather than a projection one.');
  return lines;
}

export interface ReasoningSettings {
  /**
   * One or more artifacts, in the order they should be read.
   *
   * Two models on one benchmark are two dispatches, because the endpoint is chosen per run and
   * not per arm. Refusing the second file would make this instrument unable to answer the only
   * question it was built for, so it reads both and labels each column by the model the artifact
   * itself recorded — the pairing is by question id, and the run-to-run displacement is the one
   * the A/A copies measure, not one this file invents.
   */
  readonly reports: readonly string[];
  readonly arms: readonly string[];
}

export function resolveReasoningSettings(argv: readonly string[], root: string): ReasoningSettings {
  const consumed = new Set<number>();
  argv.forEach((item, index) => {
    if (item.startsWith('--')) consumed.add(index).add(index + 1);
  });
  const paths = argv.filter((item, index) => !item.startsWith('--') && !consumed.has(index));
  if (paths.length === 0) throw new Error('usage: reasoning.ts <artifact.json> [more.json...] --arms <a>[,<b>]');
  const flag = argv.indexOf('--arms');
  if (flag === -1) throw new Error('reasoning.ts needs --arms <a>[,<b>], because a profile of no arm is a table of nothing');
  const arms = (argv[flag + 1] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (arms.length === 0) throw new Error('--arms needs at least one arm name');
  return { reports: paths.map((path) => resolve(root, path)), arms };
}

/**
 * What a column is called, when the answer is "which model wrote these statements".
 *
 * One artifact keeps the arm name: there is nothing to disambiguate. Two artifacts are two
 * models by construction, and the artifact recorded which, so the label is the record rather
 * than the file name — a reader comparing `deepseek-chat` with `deepseek-reasoner` should see
 * those names, not two paths.
 */
export function columnLabel(artifact: StatementArtifact, path: string, arm: string, several: boolean): string {
  if (!several) return arm;
  const model = artifact.model ?? relative(process.cwd(), path);
  return `${model} ${arm}`;
}

export function main(argv: readonly string[] = process.argv.slice(2), root = process.cwd()): number {
  const settings = resolveReasoningSettings(argv, root);
  const loaded = settings.reports.map((path) => ({
    path,
    artifact: JSON.parse(readFileSync(path, 'utf8')) as StatementArtifact,
  }));
  const several = loaded.length > 1;
  const readings = loaded.flatMap((entry) =>
    settings.arms.flatMap((arm) =>
      armReadings(entry.artifact.cases ?? [], arm).map((reading) => ({
        ...reading,
        arm: columnLabel(entry.artifact, entry.path, arm, several),
      })),
    ),
  );
  const labels = loaded.flatMap((entry) =>
    settings.arms.map((arm) => columnLabel(entry.artifact, entry.path, arm, several)),
  );
  const profiles = labels.map((label) => armProfile(readings, label));
  for (const entry of loaded) {
    console.log(`  ${relative(root, entry.path)}${entry.artifact.split === undefined ? '' : ` (${entry.artifact.split}${entry.artifact.model === undefined ? '' : `, ${entry.artifact.model}`})`}`);
  }
  if (readings.length === 0) {
    // An artifact without statements is the state this instrument was built for, so it says
    // which state it is in rather than printing a table of zeros that reads like a measurement.
    console.error('REASONING: no case in this artifact recorded a statement; nothing about the statements was measured');
    return 1;
  }
  for (const line of reasoningLines(profiles)) console.log(line);
  // The paired read is a difference between two columns, so it is printed when there are exactly
  // two. With more, the pair is a choice this file would be making for the reader.
  if (labels.length === 2) {
    const [left, right] = labels as [string, string];
    const pair = pairWidths(readings, left, right);
    if (pair === undefined) {
      console.log('');
      console.log(
        `  wider than gold, paired: ${left} and ${right} share no question projected by both, so there is no paired difference to test`,
      );
    } else {
      for (const line of pairedWidthLines(pair)) console.log(line);
    }
  } else if (labels.length > 2) {
    console.log('');
    console.log(`  wider than gold, paired: needs exactly two columns, and this read has ${String(labels.length)}`);
  }
  const empty = profiles.filter((profile) => profile.cases === 0).map((profile) => profile.arm);
  if (empty.length > 0) console.error(`REASONING: no recorded statement for ${empty.join(', ')}`);
  return empty.length === 0 ? 0 : 1;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
