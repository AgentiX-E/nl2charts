/**
 * The layer under `filter-narrow`: why the literal was not in the column it was compared with.
 *
 * `values-gap` splits the `values` bucket by the shape of the difference between two statements,
 * and one of its rungs is `filter-narrow` — the statement ran and returned no rows. Seventy-six
 * dev questions land there. The rung is a shape and not a cause, and the cause decides whether
 * the bucket contains work at all:
 *
 * - a value written in the wrong case is a repair, and this repository already ships it;
 * - a number written without the leading zeros its column stores is a repair of the same kind;
 * - a label written without the parenthetical the column appends is a repair of the same kind;
 * - a literal the column has nothing like is **not a literal problem**. The model compared the
 *   right value with the wrong column, or read a column whose meaning is not the question's, and
 *   no edit to the text of the literal can reach it.
 *
 * The four kinds are decided the way `groundLiteralCase` decides: from the column's own stored
 * values, with a unique candidate required and no guessing. The tool therefore answers the only
 * question the budget needs — *how much of `filter-narrow` is addressable by an edit that costs
 * no call* — and it answers it with a denominator the engine chose, not with a census of absences.
 *
 * ## Where the kinds come from, and what "unique" is protecting
 *
 * Every kind below is a *matching* claim, and the whole licence of the edit is that exactly one
 * stored value satisfies it. Two candidates is a guess, and the failure mode of a guess here is
 * worse than the empty result it repairs: a plausible wrong answer is not visibly empty.
 *
 * - `case` — one stored value equals the literal ignoring case. This is the shipped rule, and
 *   including it here is what makes the tool an *upper bound* rather than an alternative to it.
 * - `padding` — the literal is all digits and one stored value is all digits with the same
 *   numeric value. `CharterNum = '40'` against a column storing `'0040'` is the motivating case,
 *   and `Number` is deliberately not used across different lengths: `'400'` and `'0040'` are
 *   different numbers and the rule must not equate them.
 * - `parenthetical` — exactly one stored value begins with the literal followed by ` (`.
 *   `School Type = 'High Schools'` against `'High Schools (Public)'`. A bare prefix is not
 *   accepted, because `Continuation` is a prefix of both continuation-school labels and choosing
 *   between them is the guess this tool exists to refuse.
 * - `absent` — nothing like it. This is the bucket that is not a literal problem, and it is
 *   reported rather than dropped: a tool that printed only the repairable share would make a
 *   schema-linking failure look like a spelling one.
 *
 * ## What it does not do
 *
 * It does not repair anything. The two edits it prices beyond the shipped one are worth one case
 * each on this split, which is below what a paired test can resolve, so they are measured and not
 * adopted — the same discipline `bench:bird:rewrite` applies to every rule in this repository.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadQuestions } from './data.js';
import { ABSENCE_KINDS, classifyAbsence, createDomainReader, domainsOf } from './literal-repair.js';
import type { AbsenceKind } from './literal-repair.js';
import { createOracle } from './oracle.js';
import { resolveLayout } from './run.js';
import type { BirdLayout } from './run.js';
import { literalSites } from './statement.js';

/** The operators whose literal is a lookup key. `like` patterns are deliberately not among them. */
const LOOKUP_OPERATORS = new Set(['=', '==', '!=', '<>', 'in', 'not in', 'between']);

export interface AbsenceTally {
  readonly total: number;
  readonly kinds: Readonly<Record<AbsenceKind, number>>;
  /** Kinds an edit to the literal can reach: `case`, `padding`, `parenthetical`. */
  readonly repairable: number;
}

export function tallyAbsences(kinds: readonly AbsenceKind[]): AbsenceTally {
  const counts = ABSENCE_KINDS.reduce((acc, kind) => ({ ...acc, [kind]: 0 }), {} as Record<AbsenceKind, number>);
  for (const kind of kinds) counts[kind] += 1;
  return {
    total: kinds.length,
    kinds: counts,
    repairable: counts.case + counts.padding + counts.parenthetical,
  };
}

/** The share of one kind, as a percentage with one decimal, or `0.0` over an empty set. */
function share(count: number, total: number): string {
  return total === 0 ? '0.0' : ((count / total) * 100).toFixed(1);
}

/** The report, one line per kind, then the ceiling the four kinds add up to. */
export function absenceLines(tally: AbsenceTally): string[] {
  const lines = ABSENCE_KINDS.map(
    (kind) => `  ${kind.padEnd(14)} ${String(tally.kinds[kind]).padStart(4)}  ${share(tally.kinds[kind], tally.total).padStart(5)}%`,
  );
  lines.push(
    `  repairable by an edit to the literal: ${String(tally.repairable)} of ${String(tally.total)}` +
      (tally.total === 0 ? '' : ` (${share(tally.repairable, tally.total)}%)`),
  );
  return lines;
}

/**
 * What has to be true for the split to be a reading.
 *
 * Two conditions, and both are about the denominator rather than the answer. An empty bucket
 * prints `0 of 0` as `0.0%` and reads like a measured zero; a site whose column could not be read
 * was classified against no values at all, which turns "the column stores something else" into
 * "the column stores nothing" — the one confusion this tool exists to prevent.
 */
export function absenceProblems(tally: AbsenceTally, unread: number): string[] {
  const problems: string[] = [];
  if (tally.total === 0) problems.push('LGAP: no case in this artifact returned no rows, so there is nothing to split');
  if (unread > 0) {
    problems.push(
      `LGAP: ${String(unread)} comparison site(s) could not be read against their column, so the split is over a set the caller did not choose`,
    );
  }
  return problems;
}

export interface LiteralGapSettings {
  readonly root: string;
  readonly artifact: string;
  readonly arm: string;
  readonly layout: BirdLayout;
}

export const DEFAULT_LITERAL_GAP_ARM = 'inline+evidence';

export function resolveLiteralGapSettings(
  argv: readonly string[],
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): LiteralGapSettings {
  const takesValue = new Set(['--artifact', '--arm']);
  let artifact: string | undefined;
  let arm: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!takesValue.has(token)) throw new Error(`unrecognized argument ${token}: this harness takes --artifact <path> and --arm <name>`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
    if (token === '--artifact') artifact = value;
    else arm = value;
    index += 1;
  }
  const layout = resolveLayout(env, root);
  return {
    root,
    artifact: artifact ?? layout.out,
    arm: arm ?? DEFAULT_LITERAL_GAP_ARM,
    layout,
  };
}

/** Where the artifact goes, named by the arm so two arms do not overwrite each other. */
export function literalGapPath(settings: { readonly split: string; readonly root: string; readonly arm: string }): string {
  const safe = settings.arm.replace(/[^a-z0-9+-]/gi, '_');
  return join(settings.root, 'eval', 'out', `literal-gap-${safe}.json`);
}

export interface LiteralGapDrops {
  /** Cases the arm answered: not a failure, and not a denominator entry. */
  readonly passed: number;
  /** Cases in the artifact but under another arm. */
  readonly otherArm: number;
  /** Failures the judge filed under something other than `values`. */
  readonly otherReason: number;
  /** A `values` failure with no statement retained. */
  readonly unretained: number;
  /** A case whose question the split does not hold. */
  readonly unknownQuestion: number;
  /** A case whose gold the engine refused. */
  readonly goldFailed: number;
  /** A case whose own statement the engine refused. */
  readonly engineRefused: number;
  /** A `values` failure whose statement returned rows: not `filter-narrow`. */
  readonly notEmpty: number;
}

export interface LiteralGapRow {
  readonly id: string;
  readonly db: string;
  readonly column: string;
  readonly literal: string;
  readonly kind: AbsenceKind;
}

export interface LiteralGapOutcome {
  readonly split: string;
  readonly arm: string;
  readonly tally: AbsenceTally;
  /** Comparison sites whose column could not be resolved or read. */
  readonly unread: number;
  readonly drops: LiteralGapDrops;
  readonly rows: readonly LiteralGapRow[];
  /** Cases filed as `filter-narrow`, whether or not they carried a literal to read. */
  readonly narrowCases: number;
  readonly problems: readonly string[];
}

/** The artifact this tool reads: only the fields it needs, so a wider one still validates. */
interface EvalArtifact {
  readonly split?: string;
  readonly cases: readonly {
    readonly arm: string;
    readonly id: string | number;
    readonly passed: boolean;
    readonly reason?: string;
    readonly sql?: string;
  }[];
}

export async function runLiteralGap(settings: LiteralGapSettings): Promise<LiteralGapOutcome> {
  const body = JSON.parse(readFileSync(settings.artifact, 'utf8')) as EvalArtifact;
  const split = body.split === 'dev' || body.split === 'minidev' ? body.split : settings.layout.split;
  // The artifact declares the split, and the split names the files. When the caller's environment
  // disagrees, the artifact wins — but the *paths* stay the caller's, because a harness pointed at a
  // dataset outside the repository must not fall back to `eval/.cache` and read a corpus that is not
  // the one it was given. The first version re-resolved without the caller's directories and loaded
  // a question file that did not exist.
  const layout =
    split === settings.layout.split
      ? settings.layout
      : resolveLayout(
          {
            ...process.env,
            BIRD_SPLIT: split,
            BIRD_DATA: settings.layout.data,
            BIRD_DATABASES: settings.layout.databaseRoot,
          },
          settings.root,
        );
  const questions = loadQuestions(layout.questionsFile);
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));

  const drops = {
    passed: 0,
    otherArm: 0,
    otherReason: 0,
    unretained: 0,
    unknownQuestion: 0,
    goldFailed: 0,
    engineRefused: 0,
    notEmpty: 0,
  };
  const rows: LiteralGapRow[] = [];
  let unread = 0;
  let narrowCases = 0;

  const oracle = createOracle(layout.oracleScript, layout.databaseRoot);
  const cache = new Map<string, readonly string[]>();
  try {
    for (const row of body.cases) {
      if (row.arm !== settings.arm) {
        drops.otherArm += 1;
        continue;
      }
      if (row.passed) {
        drops.passed += 1;
        continue;
      }
      if (row.reason !== 'values') {
        drops.otherReason += 1;
        continue;
      }
      if (typeof row.sql !== 'string' || row.sql.trim() === '') {
        drops.unretained += 1;
        continue;
      }
      const question = byId.get(String(row.id));
      if (question === undefined) {
        drops.unknownQuestion += 1;
        continue;
      }
      const gold = await oracle.run(question.db_id, question.SQL);
      if (!gold.ok) {
        drops.goldFailed += 1;
        continue;
      }
      const predicted = await oracle.run(question.db_id, row.sql);
      if (!predicted.ok) {
        drops.engineRefused += 1;
        continue;
      }
      // `filter-narrow` is a property of the engine's answer, not of the label: a `values` failure
      // that returned rows belongs to a different rung and must not enter this denominator.
      if (predicted.rows.length > 0) {
        drops.notEmpty += 1;
        continue;
      }
      narrowCases += 1;
      const read = createDomainReader((sql: string) => oracle.run(question.db_id, sql), question.db_id, cache);
      const domains = await domainsOf(row.sql, read);
      for (const site of literalSites(row.sql)) {
        if (!LOOKUP_OPERATORS.has(site.operator)) continue;
        const columns = domains.filter((domain) => domain.column.toLowerCase() === site.column.toLowerCase());
        if (columns.length === 0) {
          unread += 1;
          continue;
        }
        const verdict = classifyAbsence(site.literal.value, [...new Set(columns.flatMap((domain) => domain.values))]);
        if (verdict === undefined) continue;
        rows.push({ id: String(row.id), db: question.db_id, column: site.column, literal: site.literal.value, kind: verdict.kind });
      }
    }
  } finally {
    await oracle.close();
  }

  const tally = tallyAbsences(rows.map((row) => row.kind));
  return {
    split,
    arm: settings.arm,
    tally,
    unread,
    drops,
    rows,
    narrowCases,
    problems: absenceProblems(tally, unread),
  };
}

export function writeLiteralGapArtifact(settings: LiteralGapSettings, outcome: LiteralGapOutcome): string {
  const path = literalGapPath({ split: outcome.split, root: settings.root, arm: outcome.arm });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(outcome, null, 2)}\n`);
  return path;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const settings = resolveLiteralGapSettings(argv, root, env);
  const outcome = await runLiteralGap(settings);
  const path = writeLiteralGapArtifact(settings, outcome);
  console.log(`literal gap · ${outcome.arm} · ${outcome.split} · ${String(outcome.narrowCases)} case(s) returned no rows`);
  for (const line of absenceLines(outcome.tally)) console.log(line);
  console.log(
    `  dropped: ${String(outcome.drops.passed)} passed, ${String(outcome.drops.notEmpty)} returned rows, ` +
      `${String(outcome.drops.otherReason)} filed under another bucket, ${String(outcome.drops.unretained)} without a statement`,
  );
  console.log(`  written to ${path}`);
  for (const problem of outcome.problems) console.log(`  ${problem}`);
  return outcome.problems.length === 0 ? 0 : 1;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
