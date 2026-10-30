/**
 * What the prompt would have had to say.
 *
 * The plan's last open entry is the prompt-coverage ablation: measure what the prompt shows
 * the model against what the gold statement needs, and price each prompt-side lever by the
 * cases it could reach. The first half of that was measured and is saturated — `bench:bird:recall`
 * reports 500 of 500 questions and 3820 of 3820 identifiers visible — so a coverage axis built
 * on *identifiers* has no variance left to explain, and an ablation on it would compare a
 * hundred per cent with a hundred per cent.
 *
 * The axis that does vary is values. The schema card carries column names, our synthesized
 * definitions and the dataset's evidence; it carries no stored values, so whether a filter the
 * gold statement compares against is even spelled somewhere in the prompt is a real question
 * with a real distribution behind it, and it costs nothing to answer: the prompt is rendered
 * from the artifact and the question file, with no model call, no database and no oracle.
 *
 * A case lands in one of five classes, in the order of how much information is missing:
 *
 * 1. `spelled` — every filter value the gold compares against appears verbatim in the prompt.
 *    The model was told what it needed; whatever went wrong is not an information deficit, and
 *    no prompt-side lever can add information that is already there.
 * 2. `casing` — a value appears in another case. SQLite compares strings case-sensitively, so
 *    this is the class a stored-value sample closes, and it is measured rather than assumed.
 * 3. `notation` — a value appears in another notation: `2012/8/25` for `2012-08-25`, a permuted
 *    date, a grade span spelled out. The information is in the prompt but not in the form the
 *    column stores, which is again what a sample shows.
 * 4. `absent` — at least one value is not in the prompt in any form the reader can align. The
 *    model could only have guessed it, and a sample would reveal it if the column holds it.
 * 5. `none` — the gold statement compares against no string value at all, so this axis does not
 *    apply to the case. Counted, because a taxonomy that quietly drops a third of its input
 *    reports its own scope as its own result.
 *
 * The classes are not a score. `spelled` is not "the model should have passed" — it is "the
 * prompt was not the reason it failed" — and the report says so with the number attached.
 *
 * Three kinds of literal are deliberately out of scope, because none of them is a stored value:
 * the right-hand side of `like`/`glob`/`match` (a pattern the statement derives from the
 * question), anything containing `%` (a strftime mask or a pattern), and numbers (`18` may be
 * computed from the question — "underage" — rather than retrieved). Each exclusion narrows what
 * the classes mean and each is stated in the report rather than left for a reader to discover.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachDefinitions, buildSqlPrompt } from '@agentix-e/nl2charts-ai';
import type { SchemaTable } from '@agentix-e/nl2charts-ai';
import { buildSchema, loadQuestions, loadTables } from './data.js';
import type { BirdQuestion, BirdTable } from './data.js';
import type { CaseRecord } from './gap.js';
import { promptFor, resolveArm, resolveLayout } from './run.js';
import type { Arm, BirdLayout } from './run.js';
import { literalSites } from './statement.js';

/** The classes, in the order of how much information is missing. */
export const INFO_CLASSES = ['spelled', 'casing', 'notation', 'absent', 'none'] as const;
export type InfoClass = (typeof INFO_CLASSES)[number];

/** How much information a class says is missing; a case takes its worst value's class. */
const SEVERITY: Readonly<Record<InfoClass, number>> = { none: 0, spelled: 1, casing: 2, notation: 3, absent: 4 };

/** Operators whose right-hand side is a pattern the statement writes, not a value it matches. */
const PATTERN_OPERATORS = new Set(['like', 'not like', 'glob', 'match']);

/** The digit runs in a text, as numbers, so `08` and `8` are one run. */
export function digitRuns(text: string): number[] {
  return (text.match(/\d+/g) ?? []).map(Number);
}

/** The letters and digits of a text, lower-cased: `K-9` and `k 9` share one skeleton. */
export function skeleton(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Whether `needle` appears as a consecutive run in `haystack`. */
function hasRun(haystack: readonly number[], needle: readonly number[]): boolean {
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((value, index) => haystack[start + index] === value)) return true;
  }
  return false;
}

/** One gold filter value, and how the prompt spells it. */
export interface InfoValue {
  readonly column: string;
  readonly value: string;
  readonly cls: Exclude<InfoClass, 'none'>;
}

export interface InfoVerdict {
  readonly cls: InfoClass;
  readonly values: readonly InfoValue[];
}

/**
 * Whether a value is in the prompt under another notation.
 *
 * Two tests, both required to be narrow enough to explain in a sentence. The first is the
 * literal's digit runs appearing consecutively, which covers a date written with separators the
 * prompt does not use. The second is every number in the literal appearing somewhere in the
 * *question* — a permuted date, `9/9/2019` against `2019-09-09` — and it is checked against the
 * question and not against the whole prompt, because a prompt holds hundreds of numbers and a
 * containment test over all of them would report almost any date as present.
 */
function inAnotherNotation(value: string, question: string, prompt: string): boolean {
  const digits = digitRuns(value);
  if (digits.length >= 2 && hasRun(digitRuns(prompt), digits)) return true;
  if (digits.length >= 2) {
    const asked = new Set(digitRuns(question));
    if (digits.every((number) => asked.has(number))) return true;
  }
  const letters = skeleton(value);
  return letters.length >= 4 && skeleton(prompt).includes(letters);
}

/**
 * Classify one gold statement's filter values against the prompt it was sent with.
 *
 * `none` means the statement compares against no string value: an aggregation, a join, a
 * `between` over integers. It is a reading of the case, not a failure of the reader.
 */
export function classifyInformation(prompt: string, question: string, goldSql: string): InfoVerdict {
  const folded = prompt.toLowerCase();
  const values: InfoValue[] = [];
  for (const site of literalSites(goldSql)) {
    const value = site.literal.value;
    if (value.trim() === '') continue;
    if (PATTERN_OPERATORS.has(site.operator)) continue;
    if (value.includes('%')) continue;
    const cls: Exclude<InfoClass, 'none'> = prompt.includes(value)
      ? 'spelled'
      : folded.includes(value.toLowerCase())
        ? 'casing'
        : inAnotherNotation(value, question, prompt)
          ? 'notation'
          : 'absent';
    values.push({ column: site.column, value, cls });
  }
  if (values.length === 0) return { cls: 'none', values };
  const cls = values.reduce<InfoClass>(
    (worst, entry) => (SEVERITY[entry.cls] > SEVERITY[worst] ? entry.cls : worst),
    'spelled',
  );
  return { cls, values };
}

export interface InfoTally {
  readonly total: number;
  /** Cases whose gold statement compares against a string value at all. */
  readonly examined: number;
  readonly classes: Readonly<Record<InfoClass, number>>;
}

export function tallyInformation(rows: readonly InfoClass[]): InfoTally {
  const classes = INFO_CLASSES.reduce((acc, cls) => ({ ...acc, [cls]: 0 }), {} as Record<InfoClass, number>);
  for (const row of rows) classes[row] += 1;
  return { total: rows.length, examined: rows.length - classes.none, classes };
}

/**
 * The lines a reader sees.
 *
 * The first three rows are the ones a prompt-side lever can move, and the block says how many
 * cases that is in absolute terms, because "9.8%" of a bucket is not a work item until it is a
 * number of questions.
 */
export function informationLines(tally: InfoTally): string[] {
  const share = (count: number): string => (tally.total === 0 ? '0.0%' : `${((count / tally.total) * 100).toFixed(1)}%`);
  const out = ['what the prompt would have had to say', ''];
  out.push('  the value is in the prompt as the gold spells it');
  out.push(`  ${'spelled'.padEnd(10)} ${String(tally.classes.spelled).padStart(4)}  ${share(tally.classes.spelled)}`);
  out.push('');
  out.push('  the value is in the prompt in another form');
  out.push(`  ${'casing'.padEnd(10)} ${String(tally.classes.casing).padStart(4)}  ${share(tally.classes.casing)}`);
  out.push(`  ${'notation'.padEnd(10)} ${String(tally.classes.notation).padStart(4)}  ${share(tally.classes.notation)}`);
  out.push('');
  out.push('  the value is not in the prompt at all');
  out.push(`  ${'absent'.padEnd(10)} ${String(tally.classes.absent).padStart(4)}  ${share(tally.classes.absent)}`);
  out.push('');
  out.push('  the question does not come down to a string value');
  out.push(`  ${'none'.padEnd(10)} ${String(tally.classes.none).padStart(4)}  ${share(tally.classes.none)}`);
  out.push('');
  out.push(`  ${String(tally.total)} cases, ${String(tally.examined)} compare against a string value`);
  const reachable = tally.classes.casing + tally.classes.notation + tally.classes.absent;
  out.push(`  a stored-value sample can reach at most ${String(reachable)} of them (${share(reachable)})`);
  return out;
}

/**
 * Whether the measurement is worth publishing.
 *
 * There is no target share here, because there is no target: a run in which every case is
 * `spelled` is a run with no prompt-side work left, and a run in which a third is `absent` is a
 * run that needs retrieval — both are readings. What can be wrong is the *instrument*, and it
 * can be wrong in exactly two ways, both absolute:
 *
 * 1. Nothing was read. An empty denominator, or an artifact whose `cases` predate the field.
 * 2. The prompt rendered here is not the prompt that was sent. The arm's definitions live in the
 *    artifact; an arm that carries them inline over a database whose text the artifact dropped
 *    would be measured against a card with the definitions missing, and a class computed from
 *    that would be reported as if it were about the prompt the model saw.
 */
export function informationProblems(input: {
  readonly tally: InfoTally;
  readonly definitionGap: number;
  readonly unrenderable: number;
}): string[] {
  const problems: string[] = [];
  if (input.tally.total === 0) {
    problems.push('INFO: no no-answer case could be read, so nothing about the prompt was measured');
  }
  if (input.definitionGap > 0) {
    problems.push(
      `INFO: ${String(input.definitionGap)} case(s) are in a database whose synthesized definitions the artifact does not carry, so the card rendered for them is not the card that was sent`,
    );
  }
  if (input.unrenderable > 0) {
    problems.push(
      `INFO: ${String(input.unrenderable)} case(s) belong to an arm whose prompt needs a block the artifact does not keep, so the prompt this tool renders is not the one that was sent`,
    );
  }
  return problems;
}

/** Where a measurement reads and writes. */
export interface InfoSettings {
  readonly report: string;
  readonly layout: BirdLayout;
  readonly arm: string;
  readonly out: string;
  /** Exit non-zero when the instrument could not measure the prompt it claims to. */
  readonly strict: boolean;
}

export function resolveInfoSettings(
  env: Record<string, string | undefined>,
  argv: readonly string[],
  root: string,
): InfoSettings {
  const flag = argv.indexOf('--arm');
  const named = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && named === undefined) throw new Error('--arm needs a name');
  const consumed = flag === -1 ? [] : [flag, flag + 1];
  const path = argv.find((item, index) => !item.startsWith('--') && !consumed.includes(index));
  if (path === undefined) throw new Error('usage: information.ts <report.json> [--arm <name>] [--strict]');
  const layout = resolveLayout(env, root);
  return { report: path, layout, arm: named ?? 'select-cross', out: dirname(layout.out), strict: argv.includes('--strict') };
}

/** A case as this instrument records it, with the values behind the class. */
export interface InfoRow {
  readonly id: string;
  readonly reason: string | undefined;
  readonly cls: InfoClass;
  readonly values: readonly InfoValue[];
}

export interface InfoDrops {
  readonly unknownQuestion: number;
  readonly unknownArm: number;
  readonly definitionGap: number;
  readonly unrenderable: number;
}

export interface InfoOutcome {
  readonly split: string;
  readonly arm: string;
  readonly rows: readonly InfoRow[];
  readonly tally: InfoTally;
  readonly drops: InfoDrops;
  readonly problems: readonly string[];
}

/** A report as this instrument reads it: the cases, and the text the prompt was built from. */
export interface InfoReportShape {
  readonly split?: string;
  readonly cases?: readonly CaseRecord[];
  readonly controls?: { readonly synthesizedDefinitions?: Readonly<Record<string, string>> };
}

/**
 * The gate that this instrument can be a gate at all.
 *
 * The prompt an arm sends is the card plus whatever blocks it asked for, and the artifact keeps
 * only one of them. An arm that draws its prompt from a block the artifact does not carry — a
 * data profile, retrieved neighbours, matched values — cannot be measured here without inventing
 * text, and inventing text is how a benchmark ends up reporting a prompt nobody sent. Such an
 * arm is refused by name instead.
 */
export function renderableArm(arm: Arm): boolean {
  return arm.evidence !== 'synthetic' && arm.values !== true && arm.demonstrations !== true && arm.decompose !== true;
}

/**
 * Render the prompt one arm would send for one question, from the artifact's own text.
 *
 * Both halves are the runner's: `buildSchema` with `withNotes: false` produces the bare card the
 * inline arm is built on, `attachDefinitions` places the synthesized text, and `promptFor` is the
 * very function the run calls. Reimplementing any of the three would make this instrument a
 * measurement of its own copy of the prompt.
 */
export function promptForCase(arm: Arm, question: BirdQuestion, definitions: string, tables: BirdTable): string {
  const card = attachDefinitions(buildSchema(tables, new Map(), { withNotes: false }), definitions);
  return buildSqlPrompt(question.question, card.schema as SchemaTable[], promptFor(arm, question, {}));
}

export async function runInformation(settings: InfoSettings): Promise<InfoOutcome> {
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as InfoReportShape;
  const arm = resolveArm(settings.arm);
  const questions = loadQuestions(settings.layout.questionsFile);
  const tables = loadTables(settings.layout.tablesFile);
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));
  const definitions = report.controls?.synthesizedDefinitions ?? {};
  const rows: InfoRow[] = [];
  const drops = { unknownQuestion: 0, unknownArm: 0, definitionGap: 0, unrenderable: 0 };
  const noAnswer = (report.cases ?? []).filter((row) => row.arm === settings.arm && row.candidateRecall === false);
  if (arm === undefined) {
    drops.unknownArm = noAnswer.length;
  } else if (!renderableArm(arm)) {
    drops.unrenderable = noAnswer.length;
  } else {
    for (const row of noAnswer) {
      const id = String(row.id);
      const question = byId.get(id);
      if (question === undefined) {
        drops.unknownQuestion += 1;
        continue;
      }
      const table = tables.get(question.db_id);
      const text = definitions[question.db_id];
      // An inline arm's definitions are part of the card. Without them the card is a different
      // card, so the case is dropped and the drop is what fails the gate.
      if (table === undefined || (text === undefined && arm.definitions === 'inline')) {
        drops.definitionGap += 1;
        continue;
      }
      const prompt = promptForCase(arm, question, text ?? '', table);
      const verdict = classifyInformation(prompt, question.question, question.SQL);
      rows.push({ id, reason: row.reason, cls: verdict.cls, values: verdict.values });
    }
  }
  const tally = tallyInformation(rows.map((row) => row.cls));
  const problems = informationProblems({
    tally,
    definitionGap: drops.definitionGap,
    unrenderable: drops.unrenderable + drops.unknownArm,
  });
  return { split: settings.layout.split, arm: settings.arm, rows, tally, drops, problems };
}

export function informationPath(settings: InfoSettings): string {
  return join(settings.out, `information-${settings.arm.replace(/[^a-z0-9+_-]/gi, '-')}.json`);
}

export function writeInformationArtifact(settings: InfoSettings, outcome: InfoOutcome): string {
  const path = informationPath(settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(outcome, null, 2));
  return path;
}

/** One line per case that is not `spelled`, so the report names what it counted. */
export function informationExamples(outcome: InfoOutcome, limit = 5): string[] {
  const named = outcome.rows.filter((row) => row.cls === 'casing' || row.cls === 'notation' || row.cls === 'absent');
  const out: string[] = [];
  for (const cls of ['casing', 'notation', 'absent'] as const) {
    const rows = named.filter((row) => row.cls === cls).slice(0, limit);
    for (const row of rows) {
      const values = row.values.filter((value) => value.cls === cls).map((value) => `${value.column}=${value.value}`);
      out.push(`  ${cls.padEnd(8)} ${row.id.padStart(4)} ${values.join(' ')}`);
    }
  }
  return out;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const settings = resolveInfoSettings(env, argv, root);
  const outcome = await runInformation(settings);
  for (const line of informationLines(outcome.tally)) console.log(line);
  const examples = informationExamples(outcome);
  if (examples.length > 0) {
    console.log('');
    console.log('  a value the prompt does not spell, by case');
    for (const line of examples) console.log(line);
  }
  console.log(
    `\n  dropped: ${String(outcome.drops.unknownQuestion)} unknown question, ${String(outcome.drops.definitionGap)} without definitions, ` +
      `${String(outcome.drops.unrenderable)} unrenderable arm, ${String(outcome.drops.unknownArm)} unknown arm`,
  );
  const path = writeInformationArtifact(settings, outcome);
  console.log(`\nwrote ${path}`);
  for (const problem of outcome.problems) console.error(problem);
  if (outcome.problems.length === 0) return 0;
  return settings.strict ? 1 : 0;
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
