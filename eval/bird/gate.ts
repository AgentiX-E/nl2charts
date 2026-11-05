/**
 * Can the question alone tell us that a condition is missing?
 *
 * The attribution reading on dev puts one gap on top of every other: in 61 of the 166 questions the
 * competitor wins, their statement filters on a column ours never names — 3.98pp, the only bucket
 * above the split's 2.93pp resolution. The obvious mechanism is a second turn that shows the model
 * its own statement and asks what it left out. That mechanism has already been priced once and it
 * does not work: `inline+evidence+audit` fired on 488 cases, was answered "no omissions" 96% of the
 * time, and bought +1.01pp at p = 0.27 for +139% of characters.
 *
 * The diagnosis of that failure was not "the model cannot self-check" but "the turn had nothing to
 * check against": it asked a question the model had already answered when it wrote the statement.
 * A turn that carries a *fact* — "the question names a value your statement never compares" — is a
 * different intervention, and the fact has to be computable before the call or it costs the same as
 * the call. That is what this harness measures: for each signal that can be read from a question and
 * a statement with no model and no database, how many questions does it fire on, how much of the
 * bucket does it reach, and what share of its fires are in the bucket?
 *
 * ## The bar is the plan's, not this file's
 *
 * The pre-registration for this lever fixed one number in advance: the intervention may cost at most
 * **10% more calls per case** (④ in the plan's 8o row). At one call per case on 1,532 questions that
 * is a gate that may fire on at most 153 of them. The other half of the bar — that a gate is useless
 * if it does not reach the population — has no pre-registered threshold, so this harness prints the
 * reach and the precision and refuses to invent one: a reader can see for each signal what a repair
 * that always succeeded on its fires would be worth, which is `reached / scored`.
 *
 * ## What it found, and why the lever was not dispatched
 *
 * Every signal that reaches the bucket costs more than the budget. `named-entity` fires on 24% of the
 * dev questions and reaches 26% of the bucket, at a precision of 16%: 84% of its calls would be spent
 * on questions where the census does not even claim a missing condition. The signal that fits the
 * budget — a quoted literal missing from the statement — fires on 1.7% and reaches 2% of the bucket,
 * which is two questions. The reason both fail is the same and it is not a matter of tuning the word
 * list: surface matching cannot separate *a value written differently* (`Alameda` for "Alameda
 * County"), *a value split across two columns* (`Kacey` and `Gibson`), and *a column-ish noun that is
 * not a value at all* (`Reading`) from a value the statement never used. The three cases look
 * identical to a text matcher and are three different findings, and the census's own corrected split
 * — 41% of the bucket compares the right value on the wrong column — says so independently.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadQuestions } from './data.js';
import type { BirdQuestion } from './data.js';
import { missingGaps } from './conditions.js';
import { resolveLayout } from './run.js';
import { statementOf } from './rewrite.js';
import type { RewriteArtifact } from './rewrite.js';
import { statementShape } from './sql-shape.js';

/** Words that are capitalised for grammar rather than for a name, or that name no value. */
const NOT_A_NAME = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'with', 'without', 'from', 'to', 'for', 'in', 'on', 'of', 'by', 'as', 'at', 'per',
  'how', 'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'list', 'show', 'find', 'give', 'name', 'state',
  'count', 'tell', 'please', 'return', 'calculate', 'indicate', 'consider', 'among', 'each', 'all', 'every', 'both', 'some',
  'any', 'only', 'not', 'no', 'is', 'are', 'was', 'were', 'does', 'do', 'did', 'if', 'their', 'its', 'there', 'it', 'this',
  'that', 'these', 'those', 'than', 'also', 'what', 'average', 'total', 'number', 'many', 'much', 'first', 'last', 'next',
  'compare', 'exclude', 'include', 'provide', 'sort', 'rank', 'group', 'order', 'identify', 'determine', 'get', 'retrieve',
  'output', 'display', 'print', 'between', 'and', 'or', 'with', 'without', 'is', 'are', 'be', 'been', 'for', 'every',
]);

/**
 * The phrases in a question that look like a stored value rather than a word.
 *
 * A capitalised run is split at every word that is grammar rather than name, because the run is a
 * property of English punctuation and not of the schema: "What Is The Capital Of France" is one run
 * and one name, and a reader that returned the run would fire on every question that starts with a
 * capital. Splitting is the only way to keep the name and drop the sentence.
 */
export function namedEntities(question: string): string[] {
  const phrases: string[] = [];
  const push = (words: string[]): void => {
    const phrase = words.join(' ');
    if (phrase.length >= 3) phrases.push(phrase);
  };
  for (const match of question.matchAll(/\b[A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+)*/g)) {
    let current: string[] = [];
    for (const word of match[0].split(/\s+/)) {
      if (NOT_A_NAME.has(word.toLowerCase())) {
        push(current);
        current = [];
      } else current.push(word);
    }
    push(current);
  }
  return [...new Set(phrases)];
}

/** The literals a question quotes verbatim. */
export function quotedLiterals(question: string): string[] {
  return [...question.matchAll(/'([^']{1,60})'|"([^"]{1,60})"/g)].map((match) => match[1] ?? (match[2] as string));
}

/** Comparative wording that implies a restriction, whether or not a value follows it. */
const CUE = /\b(?:more than|less than|greater than|fewer than|at least|at most|no more than|no less than|between|after|before|since|until|prior to|above|below|over|under|only|excluding|except|other than|not|top \d|highest|lowest|largest|smallest|maximum|minimum|most|least)\b/i;

export interface GateSignal {
  readonly name: string;
  /** What the signal claims, printed beside its reading. */
  readonly claim: string;
  /** The cues the signal found on one question, empty when it does not fire. */
  readonly cues: (question: string, sql: string, predicates: readonly string[]) => string[];
}

export const GATE_SIGNALS: readonly GateSignal[] = [
  {
    name: 'quoted-literal',
    claim: 'the question quotes a value the statement never mentions',
    cues: (question, sql) => {
      const text = sql.toLowerCase();
      return quotedLiterals(question).filter((literal) => !text.includes(literal.toLowerCase()));
    },
  },
  {
    name: 'named-entity',
    claim: 'the question names something the statement never mentions',
    cues: (question, sql) => {
      const text = sql.toLowerCase();
      return namedEntities(question).filter((phrase) => !text.includes(phrase.toLowerCase()));
    },
  },
  {
    name: 'no-predicate',
    claim: 'the question is a request for a row and the statement filters nothing',
    cues: (_question, _sql, predicates) => (predicates.length === 0 ? ['no predicate'] : []),
  },
  {
    name: 'cue-without-predicate',
    claim: 'the question compares something and the statement filters nothing',
    cues: (question, _sql, predicates) => {
      if (predicates.length > 0) return [];
      const found = CUE.exec(question);
      return found === null ? [] : [found[0]];
    },
  },
];

export interface GateCase {
  readonly id: string;
  readonly question: string;
  readonly sql: string;
  /** The kinds of condition gap the census files this case under, on the same statement. */
  readonly kinds: readonly string[];
}

export interface SignalReading {
  readonly signal: string;
  readonly claim: string;
  readonly fires: number;
  /** Fires whose case carries a condition gap of any kind: the population the lever is about. */
  readonly reached: number;
  /** Fires whose case carries a gap of the kind the signal claims to find. */
  readonly reachedAbsent: number;
  /** What a repair that always succeeded on the reached cases would be worth. */
  readonly ceilingPp: number;
  readonly precision: number;
  readonly costPp: number;
}

export interface GateReport {
  readonly split: string;
  readonly arm: string;
  readonly scored: number;
  readonly absent: number;
  readonly substituted: number;
  readonly unstated: number;
  readonly budgetPp: number;
  /** The split's own resolution: a ceiling below it cannot be read even if the repair works. */
  readonly resolutionPp: number;
  readonly readings: readonly SignalReading[];
  readonly problems: readonly string[];
}

/** The plan's pre-registered cost ceiling for this lever: ten percent more calls per case. */
export const COST_BUDGET_PP = 10;

/** Dev's published paired resolution (2.93pp), used when a caller does not state one. */
export const DEFAULT_RESOLUTION_PP = 2.93;

/**
 * One case per question, with the statement the arm executed and the gaps the census files it under.
 *
 * The statement is read with `bench:bird:rewrite`'s reader so that the two instruments describe the
 * same text: a gate priced on a different statement than the repair would act on is a gate priced on
 * a question nobody asked.
 */
export function gateCases(artifact: RewriteArtifact, arm: string, questions: readonly BirdQuestion[]): GateCase[] {
  const byId = new Map(questions.map((question) => [String(question.question_id), question]));
  const failures = artifact.failures?.[arm] ?? [];
  const cases: GateCase[] = [];
  for (const row of artifact.cases ?? []) {
    if (row.arm !== arm) continue;
    const question = byId.get(String(row.id));
    if (question === undefined) continue;
    const sql = statementOf(row, failures);
    if (sql === undefined) continue;
    cases.push({
      id: String(row.id),
      question: question.question,
      sql,
      kinds: missingGaps(question.SQL, sql).map((gap) => gap.kind),
    });
  }
  return cases;
}

export function priceGate(
  cases: readonly GateCase[],
  budgetPp = COST_BUDGET_PP,
  resolutionPp = DEFAULT_RESOLUTION_PP,
): Omit<GateReport, 'split' | 'arm' | 'problems'> {
  const scored = cases.length;
  const share = (count: number): number => Number(((count / Math.max(1, scored)) * 100).toFixed(2));
  const readings = GATE_SIGNALS.map((signal) => {
    let fires = 0;
    let reached = 0;
    let reachedAbsent = 0;
    for (const item of cases) {
      const predicates = [...statementShape(item.sql).predicates];
      if (signal.cues(item.question, item.sql, predicates).length === 0) continue;
      fires += 1;
      if (item.kinds.length > 0) reached += 1;
      if (item.kinds.includes('absent')) reachedAbsent += 1;
    }
    return {
      signal: signal.name,
      claim: signal.claim,
      fires,
      reached,
      reachedAbsent,
      ceilingPp: share(reached),
      precision: fires === 0 ? 0 : Number(((reached / fires) * 100).toFixed(1)),
      costPp: share(fires),
    };
  });
  const count = (kind: string): number => cases.filter((item) => item.kinds.includes(kind)).length;
  return {
    scored,
    absent: count('absent'),
    substituted: count('substituted'),
    unstated: count('unstated'),
    budgetPp,
    resolutionPp,
    readings,
  };
}

/**
 * What stops the reading being publishable.
 *
 * Two, and both are the instrument losing its input rather than the gate being bad: a corpus with no
 * condition gap at all (the census and this harness disagree, so one of them is reading the wrong
 * split) and a signal that fires on everything (`cues` returning a constant would make every reading
 * meaningless while looking decisive).
 */
export function gateProblems(report: Omit<GateReport, 'problems'>): string[] {
  const problems: string[] = [];
  if (report.scored === 0) problems.push('GATE: no case carried a statement, so nothing was priced');
  if (report.scored > 0 && report.absent + report.substituted + report.unstated === 0) {
    problems.push('GATE: not one case carries a condition gap, which contradicts the census this gate is aimed at');
  }
  for (const reading of report.readings) {
    if (reading.fires === report.scored && report.scored > 1) problems.push(`GATE: ${reading.signal} fires on every question, so it is not a signal`);
  }
  return problems;
}

export function gateLines(report: GateReport): string[] {
  const label = (text: string): string => `  ${text.padEnd(24)}`;
  const lines = [
    `question-side gate ${report.split} · ${report.arm}: ${String(report.scored)} questions`,
    `  cases carrying a gap (a case may carry more than one): ${String(report.absent)} written nowhere, ${String(report.substituted)} on another column, ${String(report.unstated)} with no literal`,
    `  budget: ${report.budgetPp.toFixed(0)}pp of calls per case — a signal may fire on ${String(Math.floor((report.scored * report.budgetPp) / 100))} of ${String(report.scored)}`,
    '',
    `${label('signal')} ${'fires'.padStart(6)} ${'cost'.padStart(7)} ${'reached'.padStart(8)} ${'absent'.padStart(7)} ${'precision'.padStart(10)} ${'ceiling'.padStart(8)}`,
  ];
  for (const reading of [...report.readings].sort((left, right) => right.reached - left.reached)) {
    lines.push(
      `${label(reading.signal)} ${String(reading.fires).padStart(6)} ${`${reading.costPp.toFixed(1)}pp`.padStart(7)} ` +
        `${String(reading.reached).padStart(8)} ${String(reading.reachedAbsent).padStart(7)} ${`${reading.precision.toFixed(0)}%`.padStart(10)} ` +
        `${`${reading.ceilingPp.toFixed(2)}pp`.padStart(8)}`,
    );
  }
  lines.push('');
  for (const reading of report.readings) lines.push(`  ${reading.signal}: ${reading.claim}`);
  const inside = report.readings.filter((reading) => reading.costPp <= report.budgetPp);
  const best = [...report.readings].sort((left, right) => right.reached - left.reached)[0];
  const widestInside = [...inside].sort((left, right) => right.reached - left.reached)[0];
  lines.push('');
  if (best !== undefined && best.costPp > report.budgetPp) {
    lines.push(
      `  the widest reach is ${best.signal}: ${String(best.reached)} cases at ${best.precision.toFixed(0)}% precision, ` +
        `for ${best.costPp.toFixed(1)}pp of calls — ${(best.costPp / report.budgetPp).toFixed(1)}× the pre-registered budget`,
    );
  }
  if (widestInside === undefined) {
    lines.push('  no signal fits the budget, so nothing here could be built within it');
  } else {
    const readable = widestInside.ceilingPp >= report.resolutionPp;
    lines.push(
      `  inside the budget the widest is ${widestInside.signal}: ${String(widestInside.reached)} cases at ${widestInside.precision.toFixed(0)}% precision, ` +
        `a ceiling of ${widestInside.ceilingPp.toFixed(2)}pp against a resolution of ${report.resolutionPp.toFixed(2)}pp`,
    );
    lines.push(
      readable
        ? `  verdict: the ceiling clears the resolution, so an arm on this gate could produce a readable result`
        : `  verdict: the ceiling is below the resolution, so even a repair that always succeeded on every case this gate finds could not be read as a gain — the lever is not dispatched`,
    );
  }
  for (const problem of report.problems) lines.push(`  FAILED ${problem}`);
  return lines;
}

export interface GateSettings {
  readonly artifact: string;
  readonly arm: string;
  readonly out: string;
  /** The split's resolution in accuracy points, which the ceiling is compared with. */
  readonly resolution: number;
}

export function resolveGateSettings(argv: readonly string[], root: string, env: Record<string, string | undefined>): GateSettings {
  const takesValue = new Set(['--artifact', '--arm', '--resolution']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (takesValue.has(token)) {
      index += 1;
      continue;
    }
    throw new Error(`unrecognized argument ${token}: this harness takes --artifact <path>, --arm <name> and --resolution <pp>`);
  }
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const artifact = flag('--artifact');
  if (artifact === undefined) throw new Error('--artifact is required: the gate is priced on a run that already happened');
  const arm = flag('--arm');
  if (arm === undefined) throw new Error('--arm is required: the gate is priced against one arm\u2019s statements');
  const raw = flag('--resolution');
  const resolution = raw === undefined ? DEFAULT_RESOLUTION_PP : Number(raw);
  if (!Number.isFinite(resolution) || resolution <= 0) throw new Error(`--resolution takes a positive number of percentage points, not ${String(raw)}`);
  return { artifact, arm, resolution, out: resolveLayout(env, root).out };
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  root = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): number {
  const settings = resolveGateSettings(argv, root, env);
  const artifact = JSON.parse(readFileSync(settings.artifact, 'utf8')) as RewriteArtifact;
  const split = artifact.split === 'dev' || artifact.split === 'minidev' ? artifact.split : undefined;
  const layout = resolveLayout(split === undefined ? env : { ...env, BIRD_SPLIT: split }, root);
  const questions = loadQuestions(layout.questionsFile);
  const priced = priceGate(gateCases(artifact, settings.arm, questions), COST_BUDGET_PP, settings.resolution);
  const report: GateReport = { split: layout.split, arm: settings.arm, ...priced, problems: [] };
  const withProblems = { ...report, problems: gateProblems(report) };
  for (const line of gateLines(withProblems)) console.log(line);
  return withProblems.problems.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main();
}
