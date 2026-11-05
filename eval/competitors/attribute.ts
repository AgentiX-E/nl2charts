/**
 * Which of the competitor's wins we never had, and which we threw away.
 *
 * `score.ts` ends with four counts: cases only theirs, only ours, both, neither. The number that
 * decides the next round is not among them. A question they won and we lost has two possible
 * histories, and they call for opposite work:
 *
 *   - our candidate set held a correct statement and the selector returned another one. The answer
 *     was in the pool, the fix is selection, and this repository has already priced three free rules
 *     (`shortest`, `modal`, `first`) that decide without a call.
 *   - no candidate was correct. The statement we needed was never written, the fix is generation,
 *     and the next question is *what* the missing statement had that every one of ours lacked: a
 *     table, a filter, a different aggregate, a different grain, a wider window, a different
 *     projection, a literal, or a filter of our own that should not have been there.
 *
 * Those are different instruments. This one separates them on an existing pair of artifacts and
 * spends no model call: the competitor's statements are fixed text, our report carries every
 * candidate's statement, and the only thing left to compute is the judge's verdict on both sides —
 * which this module re-executes rather than trusts and then *reconciles against the score artifact's
 * own four counts*. A join that disagrees with the published score is refused: two readings of the
 * same pair of files must print the same four numbers, or neither reading is a reading.
 *
 * Three honest limits, printed rather than argued:
 *
 * - **The gap kinds are a decision list, not a proof.** `condition` says their statement writes a
 *   filter none of ours writes. It does not say a model given a hint would write it; that is what
 *   the model run after this one is for. The list exists to make "reproduce their decomposer" a
 *   priced claim rather than a plausible one.
 * - **The component lift is a correlation.** MAC-SQL's own output records whether its decomposer and
 *   refiner fired on a question. Comparing that rate among the questions it won with the rate among
 *   the questions it lost is free, and it is confounded by difficulty: a decomposition is more
 *   likely on a question that needs one. Both denominators are printed for that reason.
 * - **A bucket smaller than the run's resolution is not a finding.** The score publishes an MDE and
 *   a bucket of a few questions can sit inside it. The verdict line says which buckets clear it,
 *   because "8.3pp of the gap is selection" and "a 3pp bucket" are different sentences and the
 *   second one is not a reason to build anything.
 *
 * Zero model calls. Every oracle call executes a statement that was already written.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { judgeOfficial } from '@agentix-e/nl2charts-devkit';
import { loadQuestions } from '../bird/data.js';
import type { BirdQuestion } from '../bird/data.js';
import { createOracle } from '../bird/oracle.js';
import type { Oracle } from '../bird/oracle.js';
import { requireArm } from '../bird/presence.js';
import { resolveLayout } from '../bird/run.js';
import type { BirdLayout } from '../bird/run.js';
import { statementShape } from '../bird/sql-shape.js';
import { parsePredictions } from './predictions.js';
import { readIdMap } from './subset.js';

/**
 * What their winning statement has that ours never wrote.
 *
 * Each kind is one piece of work, and the list is ordered: the first kind that matches names the
 * case, so a case that differs in two ways is counted once, against the widest fix. `identical` is
 * first because it is not a pipeline difference at all — both files spell the same statement, which
 * means the report's verdict for that candidate disagrees with the execution performed here, and
 * saying so outranks every classification below it.
 */
export type GapKind =
  | 'identical' // the same statement was written on both sides, and judged two ways
  | 'table' // a table none of our candidates reads
  | 'condition' // a filter none of our candidates writes
  | 'aggregate' // an aggregate none of our candidates calls
  | 'grain' // a grouping none of our candidates groups by
  | 'window' // an ordering or limit none of our candidates applies
  | 'projection' // a column none of our candidates selects
  | 'over-filter' // every candidate filters more narrowly than the statement that worked
  | 'literal' // the same conditions, a different value inside one of them
  | 'other'; // a difference this ladder does not name

export const GAP_KINDS: readonly GapKind[] = [
  'identical',
  'table',
  'condition',
  'aggregate',
  'grain',
  'window',
  'projection',
  'over-filter',
  'literal',
  'other',
];

/** Whether the statement we needed was in our pool. A pool-held case has no gap kind to name. */
export type PoolState = 'held' | 'missed' | 'unread';

export interface OurCase {
  readonly id: string;
  readonly passed: boolean;
  /** Statements the arm generated, with the judge's verdict on each where the report recorded it. */
  readonly candidates: readonly { readonly source: string; readonly correct: boolean; readonly sql?: string }[];
  /** The statement the arm returned. Absent from artifacts written before the runner recorded it. */
  readonly winner?: string;
  /** Whether a correct statement was in the pool, as the report's own candidate records say. */
  readonly poolHeld: boolean;
}

/** One question exactly one side answered correctly. */
export interface AttributedCase {
  readonly id: number;
  /**
   * What our pool looked like. Absent from the questions **we** won: they wrote one statement, so
   * there is no pool of theirs to read, and a field that said `missed` there would be stating
   * something the artifact cannot support.
   */
  readonly pool?: PoolState;
  /** The kind of the gap. Absent for a pool-held case: the statement existed and was not taken. */
  readonly gap?: GapKind;
  /** Candidates that held a correct statement. Empty unless the pool held one. */
  readonly sources: readonly string[];
}

export interface KindTally {
  readonly gap: GapKind;
  readonly cases: number;
  /** The bucket in accuracy points over the judged set: the most of the gap it could explain. */
  readonly points: number;
}

/**
 * One of the competitor's own components, as a difference in win rate when it fired.
 *
 * A lift is not a cause. The flag is written by their pipeline, so it is available for every
 * question it answered; both denominators are printed because a flag that fired on nine questions
 * produces a lift dominated by whichever nine they were.
 */
export interface ComponentLift {
  readonly component: 'decomposed' | 'refined' | 'retried' | 'extracted';
  readonly on: number;
  readonly off: number;
  readonly wonOn: number;
  readonly wonOff: number;
  /**
   * The difference in win rate, or `null` when there is no contrast to take it from.
   *
   * A flag that fired on every question has no `off` half, and printing the on-rate as a lift is the
   * same error as reading a mean that is constant by construction: MAC-SQL's decomposer runs on every
   * question, so the first run of this instrument published `+11.69pp` for it, which is not a lift —
   * it is the competitor's win rate. A flag that never fired has no `on` half either. Both are
   * reported as `null` and printed as a dash with the reason, because "cannot be read here" and
   * "reads zero" are different sentences.
   */
  readonly liftPp: number | null;
}

/** The counts this run produced, so they can be held against the score's own. */
export interface Reconciled {
  readonly competitorOnly: number;
  readonly oursOnly: number;
  readonly both: number;
  readonly neither: number;
  readonly passed: number;
}

/**
 * Two component flags that split the questions the same way.
 *
 * MAC-SQL's `fixed` (the refiner rewrote the statement) and `try_times > 1` (it tried again) are
 * the same event seen twice: the refiner runs *because* the first attempt failed. On dev they fire on
 * the same 103 questions and win the same 25; on Mini-Dev on the same 26 and the same 2. A table that
 * prints both rows prints one reading under two names, which is the same defect as a lift with no
 * contrast — it looks like more evidence than it is. The flags are kept (they are the competitor's
 * own vocabulary, and a different run may separate them) and the identity is published beside them.
 */
export interface CollinearFlags {
  readonly components: readonly ComponentLift['component'][];
  readonly on: number;
  readonly off: number;
  readonly wonOn: number;
  readonly wonOff: number;
}

export interface AttributionOutcome {
  readonly competitor: string;
  readonly arm: string;
  readonly split: string;
  /** Questions both sides were judged on: the denominator of every rate below. */
  readonly judged: number;
  readonly reconciled: Reconciled;
  /** The questions they won, with what our pool looked like and what their statement had. */
  readonly theirs: readonly AttributedCase[];
  /** The questions we won, filed by what our statement had that theirs did not. */
  readonly ours: readonly AttributedCase[];
  readonly pool: { readonly held: number; readonly missed: number; readonly unread: number };
  readonly kinds: readonly KindTally[];
  readonly reverse: readonly KindTally[];
  readonly components: readonly ComponentLift[];
  /** Groups of flags that split the questions identically: one event wearing several names. */
  readonly collinear: readonly CollinearFlags[];
  /** The resolution the score published for this run, in accuracy points. */
  readonly mde: number;
  readonly problems: readonly string[];
}

export interface AttributionSettings {
  readonly layout: BirdLayout;
  /** Our own arm's report: the candidate statements and their verdicts. */
  readonly report: string;
  /** The competitor's score artifact: the four counts this run has to reproduce. */
  readonly score: string;
  /** The competitor's own output, which carries the statements and its component flags. */
  readonly predictions: string;
  /** The id map a position-numbered pipeline answered through, when the score used one. */
  readonly idMap?: string;
  readonly out?: string;
  readonly json: boolean;
}

const flagValue = (argv: readonly string[], name: string): string | undefined => {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
};

export function resolveAttributionSettings(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  root: string,
): AttributionSettings {
  const layout = resolveLayout(env, root);
  const score = flagValue(argv, '--score');
  const predictions = flagValue(argv, '--predictions');
  if (score === undefined) throw new Error('--score is required: attribution is a reading of a score, not a second opinion about one');
  if (predictions === undefined) throw new Error('--predictions is required: the gap kinds are read from the statements the pipeline wrote');
  const report = flagValue(argv, '--report') ?? layout.out;
  const idMap = flagValue(argv, '--id-map');
  const out = flagValue(argv, '--out');
  return {
    layout,
    report,
    score,
    predictions,
    ...(idMap === undefined ? {} : { idMap }),
    ...(out === undefined ? {} : { out }),
    json: argv.includes('--json'),
  };
}

const nameOf = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

/**
 * The statements our arm generated, keyed by question id.
 *
 * `passed` is the report's own verdict and `candidates[].correct` its own per-candidate verdict;
 * neither is recomputed, because the point of the reading is what the report recorded. What *is*
 * recomputed is the competitor's verdict, and that recomputation is what the reconciliation checks.
 */
export function readOurCases(report: Record<string, unknown>, arm: string, source: string): Map<string, OurCase> {
  const cases = report.cases;
  if (!Array.isArray(cases)) throw new Error(`${source} holds no cases; attribution needs our own rows too`);
  const rows = requireArm(cases as readonly { arm?: string }[], arm, source);
  const out = new Map<string, OurCase>();
  for (const row of rows as readonly {
    id?: unknown;
    passed?: unknown;
    candidates?: readonly { source?: unknown; correct?: unknown; sql?: unknown }[];
    winnerSource?: unknown;
  }[]) {
    const id = row.id === undefined || row.id === null ? undefined : String(row.id);
    if (id === undefined) continue;
    const candidates = (row.candidates ?? []).map((candidate) => {
      const sql = nameOf(candidate.sql);
      return { source: nameOf(candidate.source) ?? arm, correct: candidate.correct === true, ...(sql === undefined ? {} : { sql }) };
    });
    const winnerSource = nameOf(row.winnerSource);
    const winner = winnerSource === undefined ? undefined : candidates.find((candidate) => candidate.source === winnerSource)?.sql;
    out.set(id, {
      id,
      passed: row.passed === true,
      candidates,
      ...(winner === undefined ? {} : { winner }),
      poolHeld: candidates.some((candidate) => candidate.correct),
    });
  }
  return out;
}

/**
 * A condition with its literals replaced by a placeholder.
 *
 * `item_id = 1` and `item_id = 2` are one condition with two values, and the two failures call for
 * different work: the first is a filter we never thought of, the second is a value we got wrong,
 * and the value lever's ceiling has already been measured in this repository twice. Folding the
 * literal is what makes `condition` mean "we never wrote this filter" rather than "we wrote it with
 * a different number".
 */
export function atomSkeleton(atom: string): string {
  return atom
    .replace(/'[^']*'/g, "'?'")
    .replace(/\b\d+(?:\.\d+)?\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The condition skeletons of a statement's shape, deduplicated and sorted.
 *
 * Taken from the shape rather than from the raw statement, and that is not a style choice: the atom
 * splitter matches `where` and `and` case-sensitively, and `statementShape` is what normalises case,
 * rewrites aliases to their tables and collapses whitespace before any comparison happens. Calling
 * `predicateAtoms` on the raw statement therefore reads **no conditions at all** out of a statement
 * written in upper case — which is how the first version of this comparison filed every one of
 * MAC-SQL's filters as absent and still produced a table that looked like a reading. On the Mini-Dev
 * artifact **472 of 498** of its statements spell `WHERE` in upper case; the first run of this
 * instrument published `condition: 0` and `literal: 17` for a split on which `condition` is the
 * largest bucket. A fixture whose statements are all lower-case and alias-free cannot see this, which
 * is why there is a case for each.
 */
const skeletonsOf = (shape: { readonly predicates: readonly string[] }): string[] =>
  [...new Set(shape.predicates.map(atomSkeleton))].sort();

export function conditionSkeletons(sql: string): string[] {
  return skeletonsOf(statementShape(sql));
}

const absent = (subject: readonly string[], held: ReadonlySet<string>): string[] => subject.filter((part) => !held.has(part));

/**
 * What `subject` has that no rival has, as one name.
 *
 * The ladder is ordered by how wide its fix is: a table none of ours reads is schema linking and
 * everything downstream of it is moot; a filter we never wrote is condition coverage; a value
 * inside a filter we did write is the value lever. The reverse direction — our statement against
 * their single one — runs through the same function, which is what makes the two tallies
 * comparable: a name means the same thing on both sides.
 */
/**
 * The values a statement puts inside single quotes, in order, with their case kept.
 *
 * `statementShape().text` drops case everywhere — including inside quotes — because it exists to
 * compare *shapes*, where `'Banned'` and `'banned'` describe the same filter. Comparing *statements*
 * needs the opposite: BIRD's judge compares result rows, so a literal's case is part of the value.
 * Two dev cases were filed as `identical` on the strength of that text, and they are not
 * contradictions in the artifact — the pipeline wrote `'Banned'` where we wrote `'banned'`, and the
 * judge disagreed with the verdict rather than with itself.
 */
export function literalValues(sql: string): string[] {
  // `''` inside a span is an escaped quote, so the captured text is unescaped before it is compared:
  // two spellings of the same value must not read as two values.
  return [...sql.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[0].slice(1, -1).replaceAll("''", "'"));
}

const sameLiterals = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, at) => value === right[at]);

/**
 * Two statements that are the same statement: same shape, and the same values inside it.
 *
 * Shape equality is `statementShape`'s job — quoting, aliasing, case and whitespace are spelling. The
 * literals are compared separately and case-sensitively, because that is the one place where case is
 * not spelling. Both halves are needed: without the shape half, an alias difference reads as a new
 * statement; without the literal half, a wrong value reads as the same one.
 */
export function sameStatement(left: string, right: string): boolean {
  return statementShape(left).text === statementShape(right).text && sameLiterals(literalValues(left), literalValues(right));
}

export function gapKind(subject: string, rivals: readonly string[]): GapKind {
  const their = statementShape(subject);
  const theirConditions = skeletonsOf(their);
  // One pass over the rivals: each carries its shape, its literals and its condition skeletons, so a
  // rule below reads a property instead of indexing three parallel arrays by hand.
  const rivalsShaped = rivals.map((sql) => ({
    shape: statementShape(sql),
    literals: literalValues(sql),
  }));
  const shapes = rivalsShaped.map((entry) => entry.shape);
  const conditionSets = rivalsShaped.map((entry) => skeletonsOf(entry.shape));
  const theirLiterals = literalValues(subject);
  const tables = new Set(shapes.flatMap((shape) => shape.tables));
  const aggregates = new Set(shapes.flatMap((shape) => shape.aggregates));
  const groups = new Set(shapes.flatMap((shape) => shape.groups));
  const projection = new Set(shapes.flatMap((shape) => shape.projection));
  const conditions = new Set(conditionSets.flat());
  // Spelling the same statement is not a difference between pipelines: it is the report's verdict
  // for that candidate disagreeing with an execution of that same statement. Checked first so a case
  // that is otherwise unremarkable cannot hide it — with the literals' case kept, because a value
  // that differs in case is a `literal` and the two verdicts are both right.
  if (rivalsShaped.some((entry) => entry.shape.text === their.text && sameLiterals(entry.literals, theirLiterals))) return 'identical';
  if (absent(their.tables, tables).length > 0) return 'table';
  if (absent(theirConditions, conditions).length > 0) return 'condition';
  if (absent(their.aggregates, aggregates).length > 0) return 'aggregate';
  if (absent(their.groups, groups).length > 0) return 'grain';
  if (their.window !== '' && !shapes.some((shape) => shape.window === their.window)) return 'window';
  if (absent(their.projection, projection).length > 0) return 'projection';
  // Every candidate filters more narrowly than the statement that worked: we did not miss a
  // condition, we added one. That is a different bug, and it is the one an over-eager reading of
  // "filter on the columns the question names" produces.
  const narrower =
    conditionSets.length > 0 &&
    conditionSets.every((set) => absent(theirConditions, new Set(set)).length === 0 && absent(set, new Set(theirConditions)).length > 0);
  if (narrower) return 'over-filter';
  // The same conditions on both sides, so the difference sits inside an atom: a literal.
  if (conditionSets.some((set) => set.join('&') === theirConditions.join('&'))) return 'literal';
  return 'other';
}

/** The competitor's own flags, as its output records them per question. */
export interface Traits {
  readonly decomposed: boolean;
  readonly refined: boolean;
  readonly retried: boolean;
  readonly extracted: boolean;
}

export const COMPONENTS = ['decomposed', 'refined', 'retried', 'extracted'] as const;

/**
 * Read the competitor's component flags out of its own file.
 *
 * The id-resolution rule is the one `parsePredictions` applies — a declared map turns a position
 * into a question — and it is repeated here rather than exported from there because the two readers
 * want different things from the same line. The repetition is safe for one reason: the caller
 * compares this id set with the ledger's and refuses the run when they differ, instead of assuming
 * they agree.
 */
export function readTraits(text: string, idMap?: readonly number[]): Map<number, Traits> {
  const out = new Map<number, Traits>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const raw = record.idx ?? record.id ?? record.question_id;
    const numeric = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(numeric)) continue;
    const id = idMap === undefined ? numeric : numeric >= 0 && numeric < idMap.length ? (idMap[numeric] as number) : undefined;
    if (id === undefined) continue;
    const pairs = record.qa_pairs;
    const decomposed = (typeof pairs === 'string' && pairs.trim() !== '') || (Array.isArray(pairs) && pairs.length > 0);
    const tries = typeof record.try_times === 'number' ? record.try_times : 0;
    const extracted = record.pruned === true || (record.extracted_schema !== undefined && Object.keys(record.extracted_schema as object).length > 0);
    out.set(id, { decomposed, refined: record.fixed === true, retried: tries > 1, extracted });
  }
  return out;
}

interface ScoreShape {
  readonly competitor?: { readonly competitor?: unknown; readonly split?: unknown };
  readonly reference?: { readonly arm?: unknown };
  readonly scope?: { readonly judged?: unknown };
  readonly execution?: { readonly passed?: unknown };
  readonly paired?: {
    readonly competitorOnly?: unknown;
    readonly oursOnly?: unknown;
    readonly both?: unknown;
    readonly neither?: unknown;
    readonly mde?: unknown;
  };
}

const numberAt = (value: unknown, where: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${where} is not a number, so this run cannot be reconciled`);
  return value;
};

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/**
 * Attribute a paired comparison to a pool state and a gap kind, on the artifacts it came from.
 *
 * The competitor's verdicts are recomputed here and the score's own counts are then required to
 * match. The order matters: recomputing without checking would be a second opinion nobody asked
 * for, and checking without recomputing would leave the id join unverified. The check is what makes
 * the join admissible, and it is the discipline `consensus.ts` applies to a rule arm's artifact.
 */
export async function runAttribution(settings: AttributionSettings, oracle: Oracle): Promise<AttributionOutcome> {
  const score = readJson<ScoreShape>(settings.score);
  const arm = nameOf(score.reference?.arm);
  if (arm === undefined) throw new Error(`${settings.score} names no reference arm, so there is nothing to attribute the competitor's wins to`);
  const paired = score.paired;
  if (paired === undefined) throw new Error(`${settings.score} carries no paired block; a comparison without one cannot say which questions each side won`);
  const split = nameOf(score.competitor?.split) ?? settings.layout.split;
  const competitor = nameOf(score.competitor?.competitor) ?? 'competitor';
  const mine = readOurCases(readJson<Record<string, unknown>>(settings.report), arm, settings.report);

  const questions = loadQuestions(settings.layout.questionsFile);
  const byId = new Map<string, BirdQuestion>(questions.map((question) => [String(question.question_id), question]));
  // The map is read by the same function the score read it with, so a position resolves the same
  // way in both readings: two numbering rules would make the join a second guess about the file.
  const idMap = settings.idMap === undefined ? undefined : readIdMap(settings.idMap).ids;
  const text = readFileSync(settings.predictions, 'utf8');
  const ledger = parsePredictions(text, questions.map((question) => ({ id: question.question_id, question: question.question, db: question.db_id })), idMap);
  const written = new Map<string, string>(ledger.predictions.map((prediction) => [String(prediction.id), prediction.sql]));
  const traits = readTraits(text, idMap);
  const stray = [...traits.keys()].filter((id) => !written.has(String(id)));
  if (stray.length > 0) {
    throw new Error(
      `the component flags name ${String(stray.length)} question(s) the prediction ledger does not hold (${stray.slice(0, 3).join(', ')}), ` +
        'so the flags and the statements were read through different numbering',
    );
  }

  const theirs: AttributedCase[] = [];
  const ours: AttributedCase[] = [];
  const wins = new Set<string>();
  let both = 0;
  let neither = 0;
  let passedByThem = 0;
  let judged = 0;
  for (const [id, record] of mine) {
    const question = byId.get(id);
    if (question === undefined) continue;
    const gold = await oracle.run(question.db_id, question.SQL);
    // A gold that will not run is outside both denominators, exactly as `score.ts` treats it: the
    // judge has nothing to compare against, so counting it as a loss would be an accusation.
    if (!gold.ok) continue;
    judged += 1;
    const theirSql = written.get(id);
    const result = theirSql === undefined ? undefined : await oracle.run(question.db_id, theirSql);
    const theirPass = result !== undefined && result.ok && judgeOfficial(gold.rows, result.rows) === 'match';
    if (theirPass) passedByThem += 1;
    if (theirPass && record.passed) {
      both += 1;
      continue;
    }
    if (theirPass) {
      wins.add(id);
      const rivals = record.candidates.flatMap((candidate) => (candidate.sql === undefined ? [] : [candidate.sql]));
      const sources = record.candidates.filter((candidate) => candidate.correct).map((candidate) => candidate.source);
      const pool: PoolState = rivals.length === 0 ? 'unread' : record.poolHeld ? 'held' : 'missed';
      theirs.push({
        id: question.question_id,
        pool,
        ...(pool === 'missed' ? { gap: gapKind(theirSql as string, rivals) } : {}),
        sources,
      });
      continue;
    }
    if (record.passed) {
      const gap = record.winner === undefined || theirSql === undefined ? undefined : gapKind(record.winner, [theirSql]);
      ours.push({ id: question.question_id, ...(gap === undefined ? {} : { gap }), sources: [] });
      continue;
    }
    neither += 1;
  }

  const reconciled: Reconciled = { competitorOnly: theirs.length, oursOnly: ours.length, both, neither, passed: passedByThem };
  const published = {
    competitorOnly: numberAt(paired.competitorOnly, `${settings.score} paired.competitorOnly`),
    oursOnly: numberAt(paired.oursOnly, `${settings.score} paired.oursOnly`),
    both: numberAt(paired.both, `${settings.score} paired.both`),
    neither: numberAt(paired.neither, `${settings.score} paired.neither`),
  };
  const drift = (['competitorOnly', 'oursOnly', 'both', 'neither'] as const).filter((key) => published[key] !== reconciled[key]);
  if (drift.length > 0) {
    throw new Error(
      `this run's join disagrees with ${settings.score} on ${drift
        .map((key) => `${key} (${String(reconciled[key])} here, ${String(published[key])} published)`)
        .join(', ')}; two readings of the same pair of files must print the same counts, so neither is a reading`,
    );
  }

  const problems: string[] = [];
  const publishedPassed = typeof score.execution?.passed === 'number' ? score.execution.passed : undefined;
  if (publishedPassed !== undefined && publishedPassed !== passedByThem) {
    problems.push(`${settings.score} published ${String(publishedPassed)} correct statement(s) and this run executed ${String(passedByThem)}`);
  }
  const publishedJudged = typeof score.scope?.judged === 'number' ? score.scope.judged : undefined;
  if (publishedJudged !== undefined && publishedJudged !== judged) {
    problems.push(
      `${settings.score} judged ${String(publishedJudged)} question(s) and this run executed ${String(judged)}; the four counts agree, so the difference sits outside the pairing`,
    );
  }

  const points = (cases: number): number => Number(((cases / Math.max(1, judged)) * 100).toFixed(2));
  const tally = (entries: readonly AttributedCase[]): KindTally[] =>
    GAP_KINDS.map((gap) => ({ gap, list: entries.filter((entry) => entry.gap === gap) }))
      .filter((entry) => entry.list.length > 0)
      .map((entry) => ({ gap: entry.gap, cases: entry.list.length, points: points(entry.list.length) }))
      .sort((left, right) => right.cases - left.cases || GAP_KINDS.indexOf(left.gap) - GAP_KINDS.indexOf(right.gap));

  const components: ComponentLift[] = COMPONENTS.map((component) => {
    let on = 0;
    let wonOn = 0;
    let off = 0;
    let wonOff = 0;
    for (const id of mine.keys()) {
      const flag = traits.get(Number(id));
      if (flag === undefined) continue;
      if (flag[component]) {
        on += 1;
        if (wins.has(id)) wonOn += 1;
      } else {
        off += 1;
        if (wins.has(id)) wonOff += 1;
      }
    }
    // No contrast, no lift: a flag that fired on every question or on none of them has one half
    // missing, and the difference of a rate with an empty denominator is the rate.
    const liftPp = on === 0 || off === 0 ? null : Number((((wonOn / on) - (wonOff / off)) * 100).toFixed(2));
    return { component, on, off, wonOn, wonOff, liftPp };
  });

  // One event, several names: grouped by **which questions** the flag fired on, not by how many.
  // Two flags can fire on the same number of questions and on different ones, and grouping by counts
  // would merge two unrelated readings — the first version of this did exactly that on the test
  // fixture, where the refiner fired on one question and the extractor on another and both were
  // reported as one event. A lift is a function of the set, so the set is the key.
  const firedOn: Record<ComponentLift['component'], number[]> = { decomposed: [], refined: [], retried: [], extracted: [] };
  for (const component of COMPONENTS) {
    firedOn[component] = [...mine.keys()]
      .map(Number)
      .filter((id) => traits.get(id)?.[component] === true)
      .sort((left, right) => left - right);
  }
  const byPartition = new Map<string, ComponentLift[]>();
  for (const entry of components) {
    const key = firedOn[entry.component].join(',');
    byPartition.set(key, [...(byPartition.get(key) ?? []), entry]);
  }
  const collinear: CollinearFlags[] = [...byPartition.values()].flatMap((group) => {
    const first = group[0];
    if (first === undefined || group.length < 2) return [];
    return [
      {
        components: group.map((entry) => entry.component),
        on: first.on,
        off: first.off,
        wonOn: first.wonOn,
        wonOff: first.wonOff,
      },
    ];
  });

  return {
    competitor,
    arm,
    split,
    judged,
    reconciled,
    theirs,
    ours,
    pool: {
      held: theirs.filter((entry) => entry.pool === 'held').length,
      missed: theirs.filter((entry) => entry.pool === 'missed').length,
      unread: theirs.filter((entry) => entry.pool === 'unread').length,
    },
    kinds: tally(theirs.filter((entry) => entry.pool === 'missed')),
    reverse: tally(ours),
    components,
    collinear,
    mde: typeof paired.mde === 'number' ? Number((paired.mde * 100).toFixed(2)) : 0,
    problems,
  };
}

/** Every line the reading prints, in the order a reader needs them. */
export function attributeLines(outcome: AttributionOutcome): string[] {
  const { judged } = outcome;
  const pp = (cases: number): string => `${((cases / Math.max(1, judged)) * 100).toFixed(2)}pp`;
  const share = (cases: number, whole: number): string => (whole === 0 ? '—' : `${((cases / whole) * 100).toFixed(1)}%`);
  const label = (text: string): string => `  ${text.padEnd(38)}`;
  const won = outcome.theirs.length;
  const lines = [
    `attribution on ${String(judged)} judged question(s) — ${outcome.competitor} against ${outcome.arm}, ${outcome.split}`,
    `  reconciled with the score: ${String(outcome.reconciled.competitorOnly)} only theirs, ${String(outcome.reconciled.oursOnly)} only ours, ` +
      `${String(outcome.reconciled.both)} both, ${String(outcome.reconciled.neither)} neither`,
    '',
    `${label('questions they won and we did not')} ${String(won).padStart(4)}  ${pp(won).padStart(8)}`,
    `${label('  our pool held a correct statement')} ${String(outcome.pool.held).padStart(4)}  ${pp(outcome.pool.held).padStart(8)}  ${share(outcome.pool.held, won)} of them — selection`,
    `${label('  our pool held none')} ${String(outcome.pool.missed).padStart(4)}  ${pp(outcome.pool.missed).padStart(8)}  ${share(outcome.pool.missed, won)} of them — generation`,
  ];
  if (outcome.pool.unread > 0) {
    lines.push(
      `${label('  no candidate statement recorded')} ${String(outcome.pool.unread).padStart(4)}  ${pp(outcome.pool.unread).padStart(8)}  — pool unreadable`,
    );
  }
  lines.push('');
  lines.push('  what their winning statement had that none of our candidates had:');
  for (const entry of outcome.kinds) {
    lines.push(`${label(`  ${entry.gap}`)} ${String(entry.cases).padStart(4)}  ${`${entry.points.toFixed(2)}pp`.padStart(8)}`);
  }
  if (outcome.kinds.length === 0) lines.push('    (nothing: every pool miss is unreadable, which is a gap in the report rather than in the pipeline)');
  lines.push('');
  lines.push(`${label('questions we won and they did not')} ${String(outcome.ours.length).padStart(4)}  ${pp(outcome.ours.length).padStart(8)}`);
  for (const entry of outcome.reverse) {
    lines.push(`${label(`  ${entry.gap}`)} ${String(entry.cases).padStart(4)}  ${`${entry.points.toFixed(2)}pp`.padStart(8)}`);
  }
  lines.push('');
  lines.push('  their components, as a lift on winning (a correlation: a flag fires on the questions that need it):');
  for (const component of outcome.components) {
    const lift =
      component.liftPp === null
        ? `${'—'.padStart(9)}  no contrast: it fired on ${component.on === 0 ? 'no question' : 'every question'}`
        : `${`${component.liftPp >= 0 ? '+' : ''}${component.liftPp.toFixed(2)}pp`.padStart(9)}`;
    lines.push(
      `${label(`  ${component.component}`)} ${`${String(component.wonOn)}/${String(component.on)}`.padStart(9)} on  ` +
        `${`${String(component.wonOff)}/${String(component.off)}`.padStart(9)} off  ${lift}`,
    );
  }
  for (const group of outcome.collinear) {
    const names = group.components.length === 2 ? `${group.components[0]} and ${group.components[1]}` : `${group.components.slice(0, -1).join(', ')} and ${String(group.components.at(-1))}`;
    lines.push(
      `${label('  note')} ${names} split the questions identically (${String(group.wonOn)} of ${String(group.on)} won when it fired) — one event, ${String(group.components.length)} names`,
    );
  }
  lines.push('');
  lines.push(`  resolution: this run resolves ${outcome.mde.toFixed(2)}pp`);
  const selectionPoints = (outcome.pool.held / Math.max(1, judged)) * 100;
  const widest = [...outcome.kinds].sort((left, right) => right.points - left.points)[0];
  const verdicts: string[] = [];
  if (outcome.pool.held > 0) {
    verdicts.push(
      selectionPoints >= outcome.mde
        ? `the selection share (${selectionPoints.toFixed(2)}pp) clears the resolution`
        : `the selection share (${selectionPoints.toFixed(2)}pp) is inside the resolution, so this run cannot price it`,
    );
  }
  if (widest !== undefined) {
    verdicts.push(
      widest.points >= outcome.mde
        ? `the widest kind, ${widest.gap}, is ${widest.points.toFixed(2)}pp and clears it`
        : `no gap kind clears it: the widest, ${widest.gap}, is ${widest.points.toFixed(2)}pp`,
    );
  }
  lines.push(`  verdict: ${verdicts.length === 0 ? 'nothing could be attributed' : verdicts.join('; ')}`);
  for (const problem of outcome.problems) lines.push(`  problem: ${problem}`);
  return lines;
}

export function writeAttribution(settings: AttributionSettings, outcome: AttributionOutcome): string {
  const path = settings.out ?? settings.score.replace(/-score\.json$/, '-attribution.json');
  writeFileSync(path, `${JSON.stringify(outcome, null, 2)}\n`);
  return path;
}

/**
 * Read, print, and write the attribution — refusing rather than printing a number it cannot join.
 *
 * The refusals are caught here instead of escaping as a stack trace: the sentence that says which
 * two files disagreed is the whole value of the check, and eighteen lines of `at runAttribution
 * (…)` above it bury it. Every path through this function is reachable from a test, which is why the
 * try/catch lives in it rather than at the entry point.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = console.log,
  error: (line: string) => void = console.error,
): Promise<number> {
  let oracle: Oracle | undefined;
  try {
    const settings = resolveAttributionSettings(env, argv, root);
    oracle = createOracle(settings.layout.oracleScript, settings.layout.databaseRoot);
    const outcome = await runAttribution(settings, oracle);
    const lines = attributeLines(outcome);
    if (settings.json) {
      log(JSON.stringify({ ...outcome, lines }, null, 2));
      return 0;
    }
    for (const line of lines) log(line);
    log(`\nwrote ${writeAttribution(settings, outcome)}`);
    for (const problem of outcome.problems) error(problem);
    return 0;
  } catch (thrown) {
    error(messageOf(thrown));
    return 1;
  } finally {
    await oracle?.close();
  }
}

/**
 * One line for whatever was thrown.
 *
 * A refusal is thrown as an `Error` and printed as a sentence, and a helper is what lets the
 * sentence be tested: the ternary inline in a `catch` is a branch no test can reach with a
 * non-`Error`, and a repository that only ever catches `Error` reports a thrown string as
 * `[object Object]` on the day one appears.
 */
export function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
