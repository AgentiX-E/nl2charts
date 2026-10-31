/**
 * Scoring another pipeline's predictions with this harness's executor and judge.
 *
 * Everything this repository publishes is a *paired* comparison: same questions, same model,
 * same executor, same judge, one lever apart. A competitor's published number cannot be paired
 * with ours, so the only way to compare pipelines rather than backbones is to run their code
 * here and score its output with the same two instruments we score ours with. That is what this
 * tool does with the half of the comparison that can be instrumented: their statements, our
 * `oracle.py`, our `judgeOfficial`, our question set.
 *
 * Four things it refuses to do, each because doing them is how a comparison lies:
 *
 * 1. **Quote an accuracy before the five coordinates hold.** A failing coordinate is printed
 *    with both values and the cost of the mismatch, and the run exits non-zero with no accuracy
 *    in the artifact. The answered share is still printed — that is a fact about their output.
 * 2. **Divide by the answered count.** The accuracy is over the whole question set, with a
 *    question they left blank counted wrong, because that is the denominator our own numbers use.
 * 3. **Call a difference a size when it is inside the design's resolution.** The paired delta
 *    comes with its MDE, and when the delta is smaller the line says so and prints how many
 *    cases the effect would need.
 * 4. **Read a file with no records as a run that answered nothing.** This one was learned the
 *    expensive way: the first `full` dispatch scored a zero-byte predictions file as 0% and
 *    reported a sixty-point gap as significant, because nothing in the tool distinguished "it
 *    wrote nothing" from "it wrote zeros".
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runIfEntry } from '../entry.js';
import {
  casesForEffect,
  compareArms,
  judgeOfficial,
  mcnemarExact,
  pairedResolution,
  summarise,
  wilsonInterval,
} from '@agentix-e/nl2charts-devkit';
import type { ArmResult, CaseOutcome } from '@agentix-e/nl2charts-devkit';
import { distinctQuestions, loadQuestions } from '../bird/data.js';
import type { BirdQuestion } from '../bird/data.js';
import { createOracle } from '../bird/oracle.js';
import { SHIPPED_ARM, requireArm } from '../bird/presence.js';
import { resolveLayout } from '../bird/run.js';
import type { BirdLayout } from '../bird/run.js';
import {
  coordinateViolations,
  describeRun,
  parseCoordinates,
} from './coordinates.js';
import type { ReferenceCoordinates, RunCoordinates } from './coordinates.js';
import { parsePredictions } from './predictions.js';
import type { PredictionLedger } from './predictions.js';
import { readIdMap } from './subset.js';
import type { IdMap } from './subset.js';

export interface ScoreSettings {
  readonly predictions: string;
  readonly coordinates: string;
  readonly report: string;
  readonly arm: string;
  /** The model this comparison holds fixed. Declared, never inferred, and recorded. */
  readonly model: string;
  readonly endpoint: string;
  /** The effect a future run would have to detect, in absolute accuracy. */
  readonly effect: number;
  /**
   * A question file whose order is the numbering the competitor used.
   *
   * Some pipelines number their answers by the row they were asked about rather than by the
   * dataset's own id. That is a renumbering, not a different question set, and stating it is the
   * difference between reading their answers and dropping them as unknown.
   */
  readonly idMap?: string;
  readonly out: string;
  readonly layout: BirdLayout;
}

export interface ExecutionSummary {
  readonly judged: number;
  /** Gold statements the engine refused, so no judge could score them. */
  readonly goldFailed: number;
  readonly executable: number;
  readonly passed: number;
  readonly accuracy: number;
  readonly interval: { readonly low: number; readonly high: number };
}

export interface PairedSummary {
  readonly competitorOnly: number;
  readonly oursOnly: number;
  readonly both: number;
  readonly neither: number;
  readonly delta: number;
  readonly mde: number;
  readonly p: number;
  readonly resolves: boolean;
  /** Cases a run would need to resolve `effect` at this run's discordance. */
  readonly needed: number;
}

/**
 * What this comparison is a comparison of: the split, and how much of it reached the judge.
 *
 * Every number below the coordinates is a rate over `judged` questions, and the four ways that
 * count can be smaller than the split are not the same finding: a sample was never asked, a
 * question was asked and its gold statement refused, a question was asked and the pipeline left it
 * blank, and a question was asked and no longer exists in the file. Only the first is a design, so
 * the scope carries it as a flag rather than leaving a reader to infer it from two counts that used
 * to look identical — "25 questions" and "25 of 498" printed the same line.
 */
export interface ScopeSummary {
  readonly split: string;
  /** Rows in the split's question file. Not a denominator. */
  readonly rows: number;
  /** Distinct questions in the split, for the databases this run scored. */
  readonly questions: number;
  /** Ids the file carries more than once; each is counted once in `questions`. */
  readonly repeats: readonly number[];
  /** Questions both pipelines were asked. */
  readonly asked: number;
  /** Questions that reached our executor and our judge, on both sides. */
  readonly judged: number;
  /** Asked, and outside the comparison because the gold statement would not run. */
  readonly excluded: readonly { readonly id: number; readonly why: string }[];
  /** Whether `asked` is a proper part of the split rather than the whole of it. */
  readonly sampled: boolean;
}

export interface ScoreOutcome {
  readonly run: RunCoordinates;
  readonly scope: ScopeSummary;
  readonly reference: ReferenceCoordinates;
  readonly ledger: PredictionLedger;
  readonly comparable: boolean;
  readonly violations: readonly string[];
  /**
   * The numbering the competitor answered in, when it was declared.
   *
   * Carried on the outcome rather than left in the settings so the artifact records the exact map a
   * score was computed through: a score computed through a different file is a different score, and
   * the ids are the only thing that distinguishes the two.
   */
  readonly idMap?: IdMap;
  readonly execution?: ExecutionSummary;
  readonly paired?: PairedSummary;
  readonly problems: readonly string[];
}

const flagValue = (argv: readonly string[], name: string): string | undefined => {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
};

/**
 * Settings come from flags, then the environment, then the layout.
 *
 * `--model` and `--endpoint` have no default beyond the environment: the coordinate under test
 * is the model, and a hard-coded default would let a comparison declare the right answer by
 * accident on a machine where the competitor had been pointed somewhere else.
 */
export function resolveScoreSettings(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  root: string,
): ScoreSettings {
  const layout = resolveLayout(env, root);
  const predictions = flagValue(argv, '--predictions');
  const coordinates = flagValue(argv, '--coordinates');
  if (predictions === undefined || coordinates === undefined) {
    throw new Error(
      'usage: score.ts --predictions <file> --coordinates <file> [--report <file>] [--arm <name>] [--model <name>] [--endpoint <url>] [--effect 0.02] [--id-map <questions.json>] [--out <file>]',
    );
  }
  const model = flagValue(argv, '--model') ?? env.LLM_MODEL;
  const endpoint = flagValue(argv, '--endpoint') ?? env.LLM_BASE_URL;
  if (model === undefined || model.length === 0) throw new Error('--model (or LLM_MODEL) names the coordinate under test');
  if (endpoint === undefined || endpoint.length === 0) {
    throw new Error('--endpoint (or LLM_BASE_URL) names the host that served the calls');
  }
  const effect = Number(flagValue(argv, '--effect') ?? '0.02');
  if (!Number.isFinite(effect) || effect <= 0) throw new Error('--effect must be a positive accuracy difference');
  const competitor = predictions.replace(/^.*\//, '').replace(/\.[a-z]+$/, '');
  const idMap = flagValue(argv, '--id-map');
  return {
    predictions,
    coordinates,
    report: flagValue(argv, '--report') ?? layout.out,
    arm: flagValue(argv, '--arm') ?? SHIPPED_ARM,
    model,
    endpoint,
    effect,
    ...(idMap === undefined ? {} : { idMap }),
    out:
      flagValue(argv, '--out') ??
      `${dirname(layout.out)}/competitors/${competitor}.json`,
    layout,
  };
}

/** Our own rows for one arm, as outcomes the paired statistic understands. */
export function armOutcomes(
  report: Record<string, unknown>,
  arm: string,
  source: string,
): readonly CaseOutcome[] {
  const cases = report.cases;
  if (!Array.isArray(cases)) throw new Error(`${source} holds no cases; a comparison needs our own rows too`);
  const rows = requireArm(cases as readonly { arm?: string; id?: string; passed?: boolean }[], arm, source);
  return rows.map((row) => ({ id: String(row.id), passed: row.passed === true }));
}

/**
 * Why nothing landed on a question, when nothing did.
 *
 * A file with no records, a file whose statements are numbered outside the question set, and a file
 * whose records name questions this split does not hold all read the same in every count a score is
 * built from: no answer, no blank answer, every question missing, an accuracy of zero over the whole
 * set. They are not the same finding and none of them is a measurement. Only one zero is: the run
 * that *answered* blank, which has an entry per question — which is why a non-empty `empty` ends this
 * check rather than raising it.
 *
 * The first `full` dispatch of `competitors.yml` published the first of these as a rate: a green job,
 * a zero-byte predictions file and a sixty-point gap read as significant (p = 6.1e-05).
 */
export function silentRun(ledger: PredictionLedger): string | undefined {
  // Nothing was asked, so nothing can be silent. That case is reported by the caller, which knows
  // the question set is empty rather than the answers.
  if (ledger.declared === 0 || ledger.answered > 0 || ledger.empty.length > 0) return undefined;
  if (ledger.drops.some((drop) => drop.where === 'file')) {
    return 'holds no records at all: the pipeline wrote nothing, so this is a missing input rather than a measurement of zero';
  }
  if (ledger.unknown.length > 0) {
    return `holds ${String(ledger.unknown.length)} statement(s) and not one names a question in this set: the numbering does not match, so a rate from it would be a rate about nothing`;
  }
  return 'holds nothing that could be attributed to a question in this set, so there is nothing to measure';
}

/**
 * Scores one predictions file against the gold in the split.
 *
 * The gold is executed once per question and reused, so a comparison costs one query per case
 * more than a run of ours does — but the statements being compared are then judged against the
 * same rows, which is the only way two accuracy figures mean the same thing.
 */
export async function scoreRun(settings: ScoreSettings): Promise<ScoreOutcome> {
  const problems: string[] = [];
  const report = JSON.parse(readFileSync(settings.report, 'utf8')) as Record<string, unknown>;
  const ours = armOutcomes(report, settings.arm, settings.report);
  const declaredModel = typeof report.model === 'string' ? report.model : undefined;
  if (declaredModel !== undefined && declaredModel !== settings.model) {
    problems.push(
      `${settings.report} was produced by ${declaredModel}, and this comparison declares ${settings.model} — the report and the coordinate disagree about the model`,
    );
  }
  const split = typeof report.split === 'string' ? report.split : settings.layout.split;
  // The pool: one row per question id, for the databases this run scored. `distinctQuestions`
  // refuses a file whose id names two different questions, so everything below may join on ids.
  const shape = distinctQuestions(loadQuestions(settings.layout.questionsFile));
  const poolDbs = poolDatabases(report);
  const pool = poolDbs === undefined ? shape.questions : shape.questions.filter((question) => poolDbs.includes(question.db_id));

  // Judged, asked, and the difference. Our own run's report says which questions it asked and
  // could not judge, and why — so a question whose gold statement refused is *excluded* rather
  // than counted as the competitor naming an id that does not exist. Before this, the reference
  // declared only the judged ids as its question set, the coordinate check then compared 496
  // against the 498 the competitor was given, and a comparison on the full split could never have
  // been called comparable for a reason that has nothing to do with either pipeline.
  const judgedIds = new Set(ours.map((outcome) => Number(outcome.id)));
  const excluded = refusedGold(report);
  const askedIds = new Set<number>([...judgedIds, ...excluded.map((entry) => entry.id)]);
  const set = pool.filter((question) => judgedIds.has(question.question_id));
  const asked = pool.filter((question) => askedIds.has(question.question_id));

  const questionIds = asked.map((question) => question.question_id);
  const reference: ReferenceCoordinates = {
    arm: settings.arm,
    split,
    questionIds,
    model: settings.model,
    endpoint: settings.endpoint,
  };
  const run = parseCoordinates(readFileSync(settings.coordinates, 'utf8'), settings.coordinates);

  const scopeBase = {
    split,
    rows: shape.rows,
    questions: pool.length,
    repeats: shape.repeats.map((repeat) => repeat.id),
    asked: asked.length,
    excluded: excluded.filter((entry) => !judgedIds.has(entry.id)),
    sampled: asked.length < pool.length,
  };
  const idMap = settings.idMap === undefined ? undefined : readIdMap(settings.idMap);
  // Parsed against the asked set, not the judged one: a statement about a question whose gold
  // refused is an answer to a question, and calling it an unknown id would be a false accusation
  // about the competitor's numbering.
  const ledger = parsePredictions(
    readFileSync(settings.predictions, 'utf8'),
    asked.map((question) => ({ id: question.question_id, question: question.question, db: question.db_id })),
    idMap?.ids,
  );
  const numbering = idMap === undefined ? {} : { idMap };
  const violations = coordinateViolations(run, reference);
  if (violations.length > 0) {
    return { run, scope: { ...scopeBase, judged: 0 }, reference, ledger, comparable: false, violations, problems, ...numbering };
  }
  const silence = silentRun(ledger);
  if (silence !== undefined) {
    problems.push(`${settings.predictions} ${silence}`);
    return { run, scope: { ...scopeBase, judged: 0 }, reference, ledger, comparable: true, violations, problems, ...numbering };
  }

  const byId = new Map<string, BirdQuestion>(set.map((question) => [String(question.question_id), question]));
  const answered = new Map(ledger.predictions.map((prediction) => [String(prediction.id), prediction]));
  const oracle = createOracle(settings.layout.oracleScript, settings.layout.databaseRoot);
  const competitorOutcomes: CaseOutcome[] = [];
  let goldFailed = 0;
  let executable = 0;
  let passed = 0;
  try {
    for (const question of set) {
      const id = String(question.question_id);
      const gold = await oracle.run(question.db_id, question.SQL);
      if (!gold.ok) {
        // Not a competitor failure and not ours: the judge has nothing to compare against, so
        // the case leaves both denominators rather than being counted against one of them.
        goldFailed += 1;
        continue;
      }
      // The same negative control the runner uses: a judge for which the gold matches an empty
      // result is not a judge, and every accuracy it produces afterwards is a zero.
      if (judgeOfficial(gold.rows, []) === 'match') {
        problems.push(`${id}: the judge calls the gold a match for an empty result, so no accuracy from this run means anything`);
      }
      const prediction = answered.get(id);
      if (prediction === undefined) {
        competitorOutcomes.push({ id, passed: false });
        continue;
      }
      const result = await oracle.run(question.db_id, prediction.sql);
      if (result.ok) executable += 1;
      const correct = result.ok && judgeOfficial(gold.rows, result.rows) === 'match';
      if (correct) passed += 1;
      competitorOutcomes.push({ id, passed: correct });
    }
  } finally {
    await oracle.close();
  }

  const judged = competitorOutcomes.length;
  if (judged === 0) {
    problems.push('no question could be judged: every gold statement failed to run');
    return { run, scope: { ...scopeBase, judged }, reference, ledger, comparable: true, violations, problems, ...numbering };
  }
  const accuracy = passed / judged;
  const interval = wilsonInterval(passed, judged);
  const execution: ExecutionSummary = {
    judged,
    goldFailed,
    executable,
    passed,
    accuracy,
    interval,
  };

  const keptIds = new Set(competitorOutcomes.map((outcome) => outcome.id));
  const oursPaired = ours.filter((outcome) => keptIds.has(outcome.id) && byId.has(outcome.id));
  const competitorResult: ArmResult = summarise(run.competitor, competitorOutcomes);
  const oursResult: ArmResult = summarise(settings.arm, oursPaired);
  const comparison = compareArms(competitorResult, oursResult);
  const resolution = pairedResolution(comparison.onlyFirst, comparison.onlySecond, judged);
  const paired: PairedSummary = {
    competitorOnly: comparison.onlyFirst,
    oursOnly: comparison.onlySecond,
    both: comparison.both,
    neither: comparison.neither,
    delta: resolution.delta,
    mde: resolution.mde,
    p: mcnemarExact(comparison.onlyFirst, comparison.onlySecond),
    resolves: Math.abs(resolution.delta) >= resolution.mde,
    needed: casesForEffect(resolution.discordantShare, settings.effect),
  };

  return {
    run,
    scope: { ...scopeBase, judged },
    reference,
    ledger,
    comparable: true,
    violations,
    execution,
    paired,
    problems,
    ...numbering,
  };
}

/**
 * The questions our own run asked and could not judge, as its report records them.
 *
 * The report is the only place this fact exists: `selection.scored` says how many were judged, and
 * `gold.unrunnable` says which and why. A comparison that dropped the second list would turn every
 * refused gold into a question the competitor answered an id for that the file does not hold.
 */
export function refusedGold(report: Record<string, unknown>): readonly { id: number; why: string }[] {
  const gold = report.gold as { unrunnable?: unknown } | undefined;
  if (!Array.isArray(gold?.unrunnable)) return [];
  const out: { id: number; why: string }[] = [];
  for (const entry of gold.unrunnable) {
    const record = entry as { id?: unknown; error?: unknown };
    if (typeof record.id !== 'number' || !Number.isInteger(record.id)) continue;
    out.push({
      id: record.id,
      why: typeof record.error === 'string' && record.error.length > 0 ? record.error : 'the gold statement did not run',
    });
  }
  return out;
}

/** The databases our own run's pool covered, when its report says. */
export function poolDatabases(report: Record<string, unknown>): readonly string[] | undefined {
  const selection = report.selection as { availableDatabases?: unknown } | undefined;
  const dbs = selection?.availableDatabases;
  if (!Array.isArray(dbs)) return undefined;
  return dbs.filter((db): db is string => typeof db === 'string');
}

/**
 * What the rate below is a rate about.
 *
 * Printed before the answered count and above the accuracy, because the count that a reader needs
 * first is the denominator: "25 questions" and "25 of 498" were the same line for four rounds, and
 * the only thing that distinguished them was a number the artifact did not carry.
 */
export function scopeLine(scope: ScopeSummary): string {
  const repeats =
    scope.repeats.length === 0
      ? ''
      : `; ${scope.repeats.join(', ')} ${scope.repeats.length === 1 ? 'appears' : 'appear'} twice and ${scope.repeats.length === 1 ? 'is' : 'are'} counted once`;
  const rows = `, ${String(scope.rows)} row(s) in the file${repeats}`;
  const excluded =
    scope.excluded.length === 0
      ? ''
      : `; ${String(scope.excluded.length)} outside the comparison because the gold statement would not run (` +
        scope.excluded
          .slice(0, 3)
          .map((entry) => `${String(entry.id)}: ${entry.why}`)
          .join(', ') +
        (scope.excluded.length > 3 ? ', …' : '') +
        ')';
  if (scope.sampled) {
    return (
      `  scope: ${String(scope.asked)} of the ${scope.split} split's ${String(scope.questions)} question(s)${rows}` +
      ` — a sample: every rate below is a rate about these ${String(scope.asked)}${excluded}`
    );
  }
  return (
    `  scope: the whole ${scope.split} split — ${String(scope.asked)} of ${String(scope.questions)} question(s)${rows}, ` +
    `${String(scope.judged)} judged${excluded}`
  );
}

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;

/**
 * The reading, in the order a reader needs it.
 *
 * The coordinate block comes first and the accuracy second, because a number printed above its
 * own provenance is a number that gets quoted without it.
 */
export function scoreLines(outcome: ScoreOutcome): readonly string[] {
  const lines: string[] = ['', ...describeRun(outcome.run)];
  lines.push(
    `  reference: arm ${outcome.reference.arm}, ${outcome.reference.split}, ${String(outcome.reference.questionIds.length)} questions`,
  );
  lines.push(scopeLine(outcome.scope));
  if (outcome.idMap !== undefined) {
    lines.push(
      `  numbering: read through ${outcome.idMap.path}, ${String(outcome.idMap.ids.length)} positions` +
        ` (${String(outcome.ledger.renumbered.length)} statement(s) resolved by position)`,
    );
  }
  for (const violation of outcome.violations) lines.push(`  NOT COMPARABLE  ${violation}`);
  const { ledger } = outcome;
  lines.push(
    `  answered: ${String(ledger.answered)}/${String(ledger.declared)} (${pct(ledger.declared === 0 ? 0 : ledger.answered / ledger.declared)})` +
      `${ledger.empty.length === 0 ? '' : `, ${String(ledger.empty.length)} blank`}` +
      `${ledger.missing.length === 0 ? '' : `, ${String(ledger.missing.length)} absent`}` +
      `${ledger.unknown.length === 0 ? '' : `, ${String(ledger.unknown.length)} unknown id`}` +
      `${ledger.duplicates.length === 0 ? '' : `, ${String(ledger.duplicates.length)} repeated (last kept)`}`,
  );
  if (ledger.databaseMismatch.length > 0) {
    const sample = ledger.databaseMismatch
      .slice(0, 3)
      .map((row) => `${String(row.id)}:${row.declared}≠${row.expected}`)
      .join(', ');
    lines.push(`  declared database disagrees with the question on ${String(ledger.databaseMismatch.length)} cases (${sample})`);
  }
  for (const drop of ledger.drops.slice(0, 5)) lines.push(`  unreadable ${drop.where}: ${drop.why}`);
  // Problems are printed before the verdict, not after the accuracy. Every branch below can return
  // early, and a problem that is only printed on the way out of the happy path is a problem the
  // reader never sees: the second `full` dispatch printed "nothing was judged" with no line saying
  // that all twenty-five questions had failed to open their database.
  for (const problem of outcome.problems) lines.push(`  PROBLEM  ${problem}`);
  if (!outcome.comparable) {
    lines.push('', '  no accuracy: the coordinates above do not hold, and a rate from this run would be a rate about something else.');
    return lines;
  }
  const execution = outcome.execution;
  const paired = outcome.paired;
  if (execution === undefined || paired === undefined) {
    lines.push('', '  no accuracy: nothing was judged.');
    return lines;
  }
  lines.push(
    '',
    `  executed: ${String(execution.executable)}/${String(outcome.ledger.answered)} answered statements ran` +
      `${execution.goldFailed === 0 ? '' : `, ${String(execution.goldFailed)} gold statements refused`}`,
    `  accuracy: ${pct(execution.accuracy)} on ${String(execution.judged)} questions` +
      ` [${pct(execution.interval.low)}, ${pct(execution.interval.high)}]  (${String(execution.passed)} correct, unanswered counted wrong)`,
    '',
    `  paired against ${outcome.reference.arm}: ${String(paired.competitorOnly)} case(s) only theirs, ${String(paired.oursOnly)} only ours,` +
      ` ${String(paired.both)} both, ${String(paired.neither)} neither`,
    `  delta: ${(paired.delta * 100).toFixed(2)}pp (positive means ${outcome.reference.arm} is ahead), McNemar p = ${paired.p.toFixed(4)}, MDE ${(paired.mde * 100).toFixed(2)}pp`,
    paired.resolves
      ? `  this delta is outside the design's resolution, so it has a size: ${(Math.abs(paired.delta) * 100).toFixed(2)}pp`
      : `  inside the MDE: this run reads a sign, not a size — resolving ${(paired.mde * 100).toFixed(2)}pp at this discordance needs ${String(paired.needed)} questions, and it has ${String(execution.judged)}`,
  );
  return lines;
}

export function writeScoreArtifact(settings: ScoreSettings, outcome: ScoreOutcome): string {
  mkdirSync(dirname(settings.out), { recursive: true });
  const body = {
    generatedAt: new Date().toISOString(),
    competitor: outcome.run,
    reference: outcome.reference,
    comparable: outcome.comparable,
    violations: outcome.violations,
    scope: outcome.scope,
    idMap: outcome.idMap ?? null,
    ledger: {
      declared: outcome.ledger.declared,
      answered: outcome.ledger.answered,
      missing: outcome.ledger.missing,
      empty: outcome.ledger.empty,
      duplicates: outcome.ledger.duplicates,
      unknown: outcome.ledger.unknown,
      renumbered: outcome.ledger.renumbered,
      databaseMismatch: outcome.ledger.databaseMismatch,
      drops: outcome.ledger.drops,
    },
    execution: outcome.execution ?? null,
    paired: outcome.paired ?? null,
    problems: outcome.problems,
  };
  writeFileSync(settings.out, `${JSON.stringify(body, null, 2)}\n`);
  return settings.out;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const settings = resolveScoreSettings(env, argv, root);
  const outcome = await scoreRun(settings);
  for (const line of scoreLines(outcome)) console.log(line);
  console.log(`\nwrote ${writeScoreArtifact(settings, outcome)}`);
  if (!outcome.comparable) return 1;
  return outcome.problems.length === 0 ? 0 : 1;
}

// The guard is a value, so importing this module cannot start a scoring run and the answer to
// "was this the entry point" is a call a test can make. `await`, because `main` is asynchronous:
// the assignment is the last statement either way.
process.exitCode = await runIfEntry(process.argv[1], import.meta.url, () => main());
