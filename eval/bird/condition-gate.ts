/**
 * Which cases should pay for a second look at the conditions, decided from the question.
 *
 * The largest mechanical class in this repository's failures is a filter the statement never
 * wrote: `bench:bird:conditions` reads 80 of 197 Mini-Dev failures (40.6%) with no condition on a
 * column the gold filters, and 216 of 1,532 on dev (14.1%, ceiling +14.1pp). MAC-SQL's 4.90pp lead
 * on dev sits on the same axis — 28 of its 48 generation wins are a `condition` none of our
 * candidates writes — so this is the one lever the field's own numbers agree about.
 *
 * It has also been dispatched, ungated, and it lost: `inline+evidence+audit` fired on 1,507 of
 * 1,532 cases, named a missing condition on 30 and rewrote 43, for twice the calls. The finding is
 * not that the audit cannot work; it is that **a turn which fires on 98% of the corpus is a tax on
 * the 86% of cases that already write every condition**. The design question is the gate.
 *
 * So this tool prices gates before any of them is built. A gate is a predicate over what exists
 * *before* the call — the question, the statement the arm already produced, and the schema — and
 * never over the gold. Each candidate is scored the way a classifier would be, but the labels come
 * from the instrument that already exists (`missingConditions`), which is what makes the reading
 * honest: the rule cannot see the label, and the label is the same one the audit is trying to
 * repair.
 *
 * Three criteria are registered here, before the run, because a gate chosen after seeing the table
 * is a table fitted to its own denominator:
 *
 * - **precision ≥ 0.50** — at least half the cases it fires on must have a condition the gold
 *   states and the statement does not name. A gate below this buys calls that cannot pay.
 * - **recall ≥ 0.40** — it must reach two fifths of the population it exists to find, or the
 *   population is being found by something else.
 * - **fires on ≤ 25% of the corpus** — the whole point of a gate. +0.25 calls a case is +6% on
 *   three-call arms, inside the 10% budget `8o` set; +1.00 calls is the arm that already lost.
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { loadQuestions, loadTables } from './data.js';
import { conditionColumns, missingConditions, schemaIndex } from './conditions.js';
import { layoutForSplit, resolveLayout } from './run.js';
import type { BirdLayout } from './run.js';

/** One case, as the reading needs it: what was asked, what was answered, and what the gold states. */
export interface GateCase {
  readonly id: string;
  readonly db: string;
  readonly question: string;
  readonly evidence: string;
  readonly sql: string;
  /** Gold conditions the statement names no column of — the label, never a gate input. */
  readonly missing: number;
  /** Gold conditions in total, so a case with none is visible rather than counted as complete. */
  readonly stated: number;
}

/** The schema facts a gate may use: the columns this database declares. */
export interface GateSchema {
  /** Every column name the database declares, lowercased. */
  readonly columns: readonly string[];
}

/**
 * Words that ask for a filter in English, which is the only language BIRD's questions are in.
 *
 * Deliberately small and closed-form: this is a *gate*, so a word list that grows every time a
 * failure is examined is a gate fitted to the corpus it is scored on. The list below is the set of
 * comparison words the questions actually use to state a range, a threshold or an exclusion — the
 * three shapes a missing `where` clause is most often about.
 */
export const FILTER_CUES: readonly string[] = [
  'only',
  'at least',
  'at most',
  'more than',
  'less than',
  'fewer than',
  'greater than',
  'between',
  'excluding',
  'except',
  'other than',
  'not ',
  'after',
  'before',
  'since',
  'during',
  'than',
  'above',
  'below',
  'under',
  'over',
  'within',
];

/** The first filter cue the question carries, or `undefined`. */
export function filterCue(question: string): string | undefined {
  const text = ` ${question.toLowerCase().replace(/\s+/g, ' ')} `;
  return FILTER_CUES.find((cue) => text.includes(cue));
}

/**
 * The schema columns a question names, matched on words rather than on substrings.
 *
 * `county` must not match `country`, and `school` must not match `schools` when the schema has
 * both — the match is on whole tokens after underscores become spaces, with the plural accepted
 * because BIRD's questions write "how many schools" for a column called `School`.
 */
export function namedColumns(question: string, schema: GateSchema): string[] {
  const text = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ')} `;
  const found: string[] = [];
  for (const column of schema.columns) {
    const spaced = ` ${column.replace(/_/g, ' ')} `;
    if (text.includes(spaced)) {
      found.push(column);
      continue;
    }
    // A plural question about a singular column: `schools` for `school`, `counties` for `county`.
    // Only the plural is accepted — the singular of a plural column would match its own stem in
    // words like `status` for `statu`, which is the class of false positive this rule avoids. The
    // `y` form is not decoration: `county` is a column on two of BIRD's eleven databases and the
    // questions write it as `counties` more often than as `county`.
    const stem = spaced.trim();
    const plurals = [stem.endsWith('y') ? `${stem.slice(0, -1)}ies` : `${stem}s`, `${stem}s`];
    if (plurals.some((plural) => text.includes(` ${plural} `))) found.push(column);
  }
  return found;
}

/** A gate: a name, a sentence a reader can check, and a predicate over the three inputs. */
export interface Gate {
  readonly name: string;
  readonly note: string;
  readonly fires: (one: GateInputs) => boolean;
}

/** Everything a gate may read. `labels` exists so a test can prove the gate never reads it. */
export interface GateInputs {
  readonly question: string;
  readonly sql: string;
  readonly schema: GateSchema;
  readonly conditionColumns: readonly string[];
  readonly named: readonly string[];
}

export function gateInputs(one: GateCase, schema: GateSchema): GateInputs {
  return {
    question: one.question,
    sql: one.sql,
    schema,
    conditionColumns: conditionColumns(one.sql),
    named: namedColumns(one.question, schema),
  };
}

/**
 * The candidate gates, cheapest first.
 *
 * Each is a different answer to "what does a statement that dropped a condition look like from
 * outside". `no-where` is the crudest and fires only on statements with no filter at all;
 * `named` is the most generous, because most questions name a column they do not filter on (a
 * projection) and the audit cannot tell those apart without asking.
 */
export const GATES: readonly Gate[] = [
  {
    name: 'no-where',
    note: 'the statement filters on nothing at all',
    fires: (one) => one.conditionColumns.length === 0,
  },
  {
    name: 'cue',
    note: 'the question compares something ("at least", "between", "only")',
    fires: (one) => filterCue(one.question) !== undefined,
  },
  {
    name: 'named',
    note: 'the question names a column the statement does not filter on',
    fires: (one) => one.named.some((column) => !one.conditionColumns.includes(column)),
  },
  {
    name: 'cue-and-named',
    note: 'both of the above: a comparison word and an unfiltered column it could be about',
    fires: (one) =>
      filterCue(one.question) !== undefined && one.named.some((column) => !one.conditionColumns.includes(column)),
  },
  {
    name: 'no-where-or-cue',
    note: 'a statement with no filter, or a question that states a comparison',
    fires: (one) => one.conditionColumns.length === 0 || filterCue(one.question) !== undefined,
  },
  {
    name: 'no-where-or-named',
    note: 'a statement with no filter, or a named column the statement never filters on',
    fires: (one) => one.conditionColumns.length === 0 || one.named.some((column) => !one.conditionColumns.includes(column)),
  },
];

/** What one gate did on the corpus. */
export interface GateScore {
  readonly name: string;
  readonly note: string;
  /** Cases the gate would send to the audit. */
  readonly fired: number;
  /** Of those, cases whose gold states a condition the statement names no column of. */
  readonly hit: number;
  /** `hit / fired`, and zero when the gate never fires — not a NaN and not a one. */
  readonly precision: number;
  /** `hit / labelled`: the share of the population this gate reaches. */
  readonly recall: number;
  /** Precision per database, so a gate that works on one corpus is visible as such. */
  readonly folds: readonly { readonly db: string; readonly fired: number; readonly hit: number }[];
  /** The smallest per-database precision among folds that fired at least once. */
  readonly worstFold: number;
}

export function scoreGate(gate: Gate, cases: readonly GateCase[], schemas: ReadonlyMap<string, GateSchema>): GateScore {
  const labelled = cases.filter((one) => one.missing > 0).length;
  let fired = 0;
  let hit = 0;
  const folds = new Map<string, { fired: number; hit: number }>();
  for (const one of cases) {
    const schema = schemas.get(one.db.toLowerCase());
    if (schema === undefined) continue;
    if (!gate.fires(gateInputs(one, schema))) continue;
    fired += 1;
    const fold = folds.get(one.db) ?? { fired: 0, hit: 0 };
    fold.fired += 1;
    if (one.missing > 0) {
      hit += 1;
      fold.hit += 1;
    }
    folds.set(one.db, fold);
  }
  const listed = [...folds.entries()]
    .map(([db, fold]) => ({ db, fired: fold.fired, hit: fold.hit }))
    .sort((left, right) => right.fired - left.fired);
  const worstFold = listed
    .filter((fold) => fold.fired > 0)
    .reduce((worst, fold) => Math.min(worst, fold.hit / fold.fired), 1);
  return {
    name: gate.name,
    note: gate.note,
    fired,
    hit,
    precision: fired === 0 ? 0 : hit / fired,
    recall: labelled === 0 ? 0 : hit / labelled,
    folds: listed,
    worstFold,
  };
}

/** The bars, as the header states them. Exported so a test can pin them rather than trust them. */
export const REQUIRED_PRECISION = 0.5;
export const REQUIRED_RECALL = 0.4;
export const MAX_FIRE_SHARE = 0.25;

/** Whether one gate clears all three bars at once. */
export function clears(score: GateScore, total: number): boolean {
  return (
    score.precision >= REQUIRED_PRECISION &&
    score.recall >= REQUIRED_RECALL &&
    total > 0 &&
    score.fired / total <= MAX_FIRE_SHARE
  );
}

/**
 * The artifact fields this harness reads.
 *
 * `sql` and `asked` are the two the runner started writing for exactly this kind of analysis:
 * without them the gate's inputs would have to be re-derived by joining the corpus and re-prompting,
 * which is the cost this tool exists to avoid.
 */
export interface ArtifactShape {
  readonly split?: unknown;
  readonly model?: unknown;
  readonly cases?: readonly {
    readonly arm?: unknown;
    readonly id?: unknown;
    readonly sql?: unknown;
    readonly asked?: unknown;
  }[];
}

/** Join the artifact's answers to the split's gold, keeping only the cases a gate can see. */
export function gateCases(
  artifact: ArtifactShape,
  arm: string,
  gold: ReadonlyMap<string, { readonly SQL: string; readonly db: string; readonly question: string; readonly evidence: string }>,
): { cases: GateCase[]; missingSql: number; missingAsked: number; unknownQuestion: number } {
  let missingSql = 0;
  let missingAsked = 0;
  let unknownQuestion = 0;
  const cases: GateCase[] = [];
  const seen = new Set<string>();
  for (const row of artifact.cases ?? []) {
    if (row.arm !== arm) continue;
    if (typeof row.id !== 'string' || seen.has(row.id)) continue;
    const asked = row.asked as { readonly db?: unknown; readonly question?: unknown; readonly evidence?: unknown } | undefined;
    if (asked === undefined || typeof asked.question !== 'string') {
      missingAsked += 1;
      continue;
    }
    if (typeof row.sql !== 'string' || row.sql === '') {
      missingSql += 1;
      continue;
    }
    const question = gold.get(row.id);
    if (question === undefined) {
      unknownQuestion += 1;
      continue;
    }
    seen.add(row.id);
    cases.push({
      id: row.id,
      db: typeof asked.db === 'string' ? asked.db : question.db,
      question: asked.question,
      evidence: typeof asked.evidence === 'string' ? asked.evidence : question.evidence,
      sql: row.sql,
      missing: missingConditions(question.SQL, row.sql).length,
      stated: conditionColumns(question.SQL).length,
    });
  }
  return { cases, missingSql, missingAsked, unknownQuestion };
}

/** Every line the report prints. */
export function reportLines(
  cases: readonly GateCase[],
  scores: readonly GateScore[],
  artifact: ArtifactShape,
  arm: string,
  dropped: { missingSql: number; missingAsked: number; unknownQuestion: number },
): string[] {
  const total = cases.length;
  const labelled = cases.filter((one) => one.missing > 0).length;
  const baseRate = total === 0 ? 0 : labelled / total;
  const cued = cases.filter((one) => one.missing > 0 && filterCue(one.question) !== undefined).length;
  const lines = [
    `gating the condition audit for ${arm} on ${String(total)} cases ` +
      `(${String(artifact.split ?? 'unknown')}, ${String(artifact.model ?? 'unknown')})`,
    `  cases whose statement names no column of a gold condition: ${String(labelled)} (${(baseRate * 100).toFixed(1)}%)`,
    // Whether the population is even visible in the text. A gate cannot be blamed for missing a
    // condition the question never states, and the split between the two is what says whether the
    // lever is "look harder" or "there was nothing to look at".
    `  of those, ${String(cued)} state a comparison word (${(labelled === 0 ? 0 : (cued / labelled) * 100).toFixed(1)}%)`,
    `  dropped ${String(dropped.missingAsked)} without asked, ${String(dropped.missingSql)} without sql, ` +
      `${String(dropped.unknownQuestion)} the split does not hold`,
    '',
    '  gate                 fires  hit   precision  recall   worst db   calls/case',
  ];
  for (const score of scores) {
    lines.push(
      `    ${score.name.padEnd(18)} ${String(score.fired).padStart(4)} ${String(score.hit).padStart(4)}   ` +
        `${(score.precision * 100).toFixed(1).padStart(6)}% ${(score.recall * 100).toFixed(1).padStart(6)}%   ` +
        `${(score.worstFold * 100).toFixed(1).padStart(5)}%   ${(score.fired / Math.max(total, 1)).toFixed(2).padStart(6)}`,
    );
  }
  if (total === 0) {
    lines.push('', 'verdict: no case carried the fields a gate needs, so nothing can be gated');
    return lines;
  }
  lines.push('', `  bars, registered before the run: precision >= ${(REQUIRED_PRECISION * 100).toFixed(0)}%, ` +
    `recall >= ${(REQUIRED_RECALL * 100).toFixed(0)}%, fires on <= ${(MAX_FIRE_SHARE * 100).toFixed(0)}% of the corpus`);
  const passing = scores.filter((score) => clears(score, total));
  if (passing.length === 0) {
    // `GATES` is a constant with six rows and every one of them is scored before this point, so the
    // best row exists; a `?? 'none'` here would print "no gates were considered" for a run that
    // considered six, which is the kind of sentence that hides a bug.
    const best = [...scores].sort((left, right) => right.precision * right.recall - left.precision * left.recall)[0] as GateScore;
    lines.push(
      `verdict: no gate clears all three bars, so the audit stays unpriced rather than dispatched ` +
        `(best ${best.name} at ${(best.precision * 100).toFixed(1)}% precision, ` +
        `${(best.recall * 100).toFixed(1)}% recall, firing ${((best.fired / Math.max(total, 1)) * 100).toFixed(1)}%)`,
    );
    return lines;
  }
  const chosen = passing[0] as GateScore;
  lines.push(
    `verdict: ${chosen.name} clears all three — ${(chosen.precision * 100).toFixed(1)}% of its ${String(chosen.fired)} fires are ` +
      `a real gap, it reaches ${(chosen.recall * 100).toFixed(1)}% of the ${String(labelled)} cases, and it buys ` +
      `${((chosen.fired / total) * 100).toFixed(1)}% of the corpus — so the audit can be dispatched behind it`,
  );
  return lines;
}

export interface GateSettings {
  readonly artifact: string;
  readonly arm: string;
  readonly root: string;
  readonly json: boolean;
}

export function resolveSettings(argv: readonly string[], root = process.cwd()): GateSettings {
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const consumed = new Set<number>();
  for (const name of ['--artifact', '--arm']) {
    const at = argv.indexOf(name);
    if (at !== -1) consumed.add(at + 1);
  }
  const raw = flag('--artifact') ?? argv.find((item, index) => !item.startsWith('--') && !consumed.has(index));
  if (raw === undefined) throw new Error('--artifact is required: this harness reads an artifact rather than producing one');
  const arm = flag('--arm');
  if (arm === undefined) throw new Error('--arm is required: the gate is read against one arm\'s answers');
  return { artifact: resolvePath(root, raw), arm, root, json: argv.includes('--json') };
}

export function schemasFor(layout: BirdLayout): Map<string, GateSchema> {
  const tables = loadTables(layout.tablesFile);
  const index = schemaIndex(tables);
  const out = new Map<string, GateSchema>();
  for (const [db, entry] of index) out.set(db, { columns: [...entry.owners.keys()] });
  return out;
}

export function main(argv: readonly string[], root: string, log: (line: string) => void = console.log): number {
  const settings = resolveSettings(argv, root);
  const artifact = JSON.parse(readFileSync(settings.artifact, 'utf8')) as ArtifactShape;
  // The base layout comes from the environment, and `layoutForSplit` only changes the split when the
  // artifact names one — the artifact decides what it scored, the environment decides where files
  // live, and mixing the two silently scores one split's answers against another's questions.
  const named = typeof artifact.split === 'string' ? artifact.split : undefined;
  const layout = layoutForSplit(named, resolveLayout({}, settings.root), settings.root);
  const questions = loadQuestions(layout.questionsFile);
  const gold = new Map(
    questions.map((question) => [
      String(question.question_id),
      { SQL: question.SQL, db: question.db_id, question: question.question, evidence: question.evidence },
    ]),
  );
  const { cases, missingSql, missingAsked, unknownQuestion } = gateCases(artifact, settings.arm, gold);
  if (cases.length === 0) {
    throw new Error(`no case in ${settings.artifact} carries both sql and asked for ${settings.arm}, so there is nothing to gate`);
  }
  const schemas = schemasFor(layout);
  const scores = GATES.map((gate) => scoreGate(gate, cases, schemas));
  if (settings.json) {
    log(JSON.stringify({ cases: cases.length, arm: settings.arm, scores, lines: reportLines(cases, scores, artifact, settings.arm, { missingSql, missingAsked, unknownQuestion }) }, null, 2));
  } else {
    for (const line of reportLines(cases, scores, artifact, settings.arm, { missingSql, missingAsked, unknownQuestion })) log(line);
  }
  return 0;
}

/** Run as a script when — and only when — this file is the entry point, for the reason `route.ts` gives. */
export function dispatch(
  entry: string | undefined,
  self: string,
  argv: readonly string[],
  root: string,
  log: (line: string) => void = console.log,
  error: (line: string) => void = console.error,
  run: (argv: readonly string[], root: string, log: (line: string) => void) => number = main,
): number | undefined {
  if (entry === undefined || self !== `file://${entry}`) return undefined;
  try {
    return run(argv, root, log);
  } catch (thrown) {
    error(thrown instanceof Error ? thrown.message : String(thrown));
    return 1;
  }
}

const exit = dispatch(process.argv[1], import.meta.url, process.argv.slice(2), process.cwd());
if (exit !== undefined) process.exitCode = exit;
