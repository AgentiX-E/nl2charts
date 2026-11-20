/**
 * Arbitration: which of two answers to believe, decided without looking at the label.
 *
 * ## Why this file exists
 *
 * `llm.ts` established that a model reads this corpus better than the rule table does — 857 top-1
 * against 606 on the same 1,470 rows — and that the two answers disagree on 519 of them, with the
 * product winning 134 and the model winning 385. The union, 991, is not a result: it is what a
 * selector could reach if it knew, row by row, which system was right, and knowing that *is* the
 * answer key. A number computed from the key is not a number about a product.
 *
 * So the question this file prices is the only one that can be shipped: **given the question, the
 * table's answer and the model's answer, and nothing else, how many of the 519 can a rule route
 * correctly?** Every policy below answers that with a rule a reader can check by hand, and every one
 * of them costs ¥0 because the answers are already on disk.
 *
 * ## The one guarantee that makes the table honest
 *
 * `Dispute` carries four fields: the product's answer, the mark the cue table leads with, the marks
 * the cues name, and the model's answer. The expected family is **not among them** — not by
 * convention but by type — so a policy cannot peek even by accident, and a policy that would need the
 * key to decide is a policy that does not exist. The test asserts the field list at run time, because
 * a type is erased and a field named `expected` would compile.
 *
 * ## The identity the numbers are held to
 *
 * On the rows where both systems answer the same thing, no policy can change the outcome: the two
 * answers are the same answer. Every policy is therefore a **partition of the disagreement**, and its
 * score is
 *
 * ```
 * hit === agreedHits + (rows it kept from the product that were right) + (rows it took from the model that were right)
 * ```
 *
 * That identity is asserted against the score the shared scorer (`scoreAnswers`) computes, which is
 * how a policy that returns an answer neither system gave — a hybrid, an average, a seventh mark —
 * is refused rather than credited. Two scorers disagreeing is the defect the census spent a round on;
 * here they are not two scorers, they are one scorer and one decomposition, and they must agree.
 */
import { applyExitCode, isEntry, loadText2Vis, type LoadOptions } from './dataset.js';
import { mcnemarExact, markAnswer, rosterOf, scoredRows, type ArmReport } from './llm.js';
import { profileAnswer, scoreAnswers, type ChartAnswer, type ProfileInput } from './profile.js';
import { cueMarks, familyOfLabel, type ChartFamily } from './rule.js';
import { RECOMMENDABLE_MARKS } from '@agentix-e/nl2charts-chart';
import type { RecommendableMark } from '@agentix-e/nl2charts-chart';

/**
 * What a policy may read.
 *
 * Four fields, and the absence of a fifth is the design. `product` is the pipeline's published answer
 * (`profileAnswer`: cues plus the result set's shape), `cueLead` is the mark the first cue in the
 * shipped table to fire speaks for — `rule.ts` documents that order as "strongest first" — and
 * `model` is what the arm answered, absent when the reply named nothing it was offered.
 */
export interface Dispute {
  readonly product: ChartAnswer;
  /** The question, kept for the one family claim that depends on what was asked: see `markAnswer`. */
  readonly asked: string;
  readonly cueLead: RecommendableMark | undefined;
  readonly cueNamed: readonly RecommendableMark[];
  readonly model: RecommendableMark | undefined;
}

/** One rule, stated as a choice rather than as a weight. */
export interface Policy {
  readonly name: string;
  /** What the rule believes, in the terms a reader would use to argue with it. */
  readonly note: string;
  readonly choose: (dispute: Dispute) => ChartAnswer;
}

/** The model's answer as the scorer wants it, or a refusal when it said nothing. */
function modelAnswer(dispute: Dispute): ChartAnswer {
  return dispute.model === undefined ? { mark: 'declined', families: [] } : markAnswer(dispute.model, dispute.asked);
}

/** The family an answer claims first: the one top-1 is scored on. */
function leadOf(answer: ChartAnswer): ChartFamily | undefined {
  return answer.families[0];
}

/**
 * The six policies, each a sentence about what the two systems are for.
 *
 * Two of them are the baselines, and they are policies rather than constants for the reason every
 * ablation table in this repository has: a table whose extremes are recomputed by the same code that
 * prices the middle is a table where the extremes cannot disagree with the arithmetic.
 */
export const POLICIES: readonly Policy[] = [
  {
    name: 'product',
    note: 'the pipeline always answers: the baseline the other five are held to',
    choose: (dispute) => dispute.product,
  },
  {
    name: 'model',
    note: 'the model always answers: the reading the arm published, and what "ship the model" would score',
    choose: modelAnswer,
  },
  {
    name: 'cue-led',
    note: 'trust the product only where the cue table leads with the mark it answered: the question said that word first, so the shape did not overrule it',
    choose: (dispute) =>
      dispute.cueLead !== undefined && dispute.cueLead === dispute.product.mark ? dispute.product : modelAnswer(dispute),
  },
  {
    name: 'cue-any',
    note: 'trust the product wherever a cue named the mark it answered: weaker than `cue-led`, and it keeps the rows where a cue named the mark second',
    choose: (dispute) =>
      dispute.product.mark !== 'declined' && dispute.cueNamed.includes(dispute.product.mark) ? dispute.product : modelAnswer(dispute),
  },
  {
    name: 'product-holds',
    note: 'the product, except where it refused and the model did not: a refusal is the product saying it has nothing, so there is nothing to lose',
    choose: (dispute) => (dispute.product.mark === 'declined' ? modelAnswer(dispute) : dispute.product),
  },
  {
    name: 'model-holds',
    note: 'the model, except where its reply named nothing: an unreadable answer is not a better answer than a readable one',
    choose: (dispute) => (dispute.model === undefined ? dispute.product : modelAnswer(dispute)),
  },
];

/**
 * Refuse a name this product cannot draw, before it is carried anywhere.
 *
 * Exported because `route.ts` reads a *second* answer out of the same file, and two readers with two
 * copies of this rule is how one of them ends up accepting a mark the other refuses. The message names
 * the row, because a table with a foreign mark in it is a bug report about one line of one file.
 */
export function assertOfferedMark(row: ProfileInput, choice: string | null): void {
  if (choice !== null && !(RECOMMENDABLE_MARKS as readonly string[]).includes(choice)) {
    throw new Error(
      `text2vis arbitrate: the artifact holds ${choice} for "${row.prompt}", which is not one of the ${String(RECOMMENDABLE_MARKS.length)} marks this arm offers; the answer belongs to a different option list`,
    );
  }
}

/**
 * The product's answer, the cues and the model's answer, read off one row.
 *
 * A name outside `RECOMMENDABLE_MARKS` is refused rather than carried, because the artifact this reads
 * is an external file. The arm's `parseChoice` only ever writes a name it was offered, so a foreign
 * name means the file was edited or written by another version — and a policy handed `donut` would
 * answer "donut", whose family list is empty, which the scorer reads as *declined*. A row silently
 * reclassified as a refusal is a row the table would credit to whichever side happened to decline it,
 * and nothing downstream could tell that from a model that had nothing to say.
 */
export function disputeOf(row: ProfileInput, choice: string | null): Dispute {
  assertOfferedMark(row, choice);
  const named = cueMarks(row.prompt);
  return {
    product: profileAnswer(row.prompt, row.tableData),
    asked: row.prompt,
    cueLead: named[0],
    cueNamed: named,
    model: choice === null ? undefined : (choice as RecommendableMark),
  };
}

/** One row of the arbitration table: what a policy did with the rows both systems disagreed about. */
export interface PolicyReading {
  readonly name: string;
  readonly note: string;
  /** Top-1 hits, from `scoreAnswers` — the same scorer the product's 41.22% comes from. */
  readonly hit: number;
  readonly share: number;
  readonly shortlist: number;
  /** Rows whose top-1 answer differs from the product's, on any row. */
  readonly changed: number;
  /** Of the rows the two systems disagree about: how many the policy left to the product. */
  readonly kept: number;
  readonly keptRight: number;
  /** Of the same rows: how many it gave to the model. */
  readonly given: number;
  readonly givenRight: number;
  /** Against the product: rows it fixed and rows it broke. */
  readonly gained: number;
  readonly lost: number;
  /** Two-sided exact McNemar over `gained` against `lost`. */
  readonly p: number;
  readonly perFamily: readonly { readonly family: ChartFamily; readonly n: number; readonly hit: number }[];
}

export interface ArbitrationReport {
  readonly model: string;
  readonly population: { readonly scored: number; readonly roster: string };
  readonly agreement: {
    readonly agree: number;
    readonly agreeHit: number;
    readonly disagree: number;
    /** Of the disagreement: rows the product alone got right, and rows the model alone did. */
    readonly productRight: number;
    readonly modelRight: number;
  };
  /** The union: every row either system got right. A ceiling, not a policy. */
  readonly oracle: { readonly hit: number; readonly share: number };
  readonly policies: readonly PolicyReading[];
  readonly best: string;
}

/**
 * Price every policy on one population.
 *
 * The rows are the population and their labels are the truth; the disputes are what the policies are
 * allowed to see. The two are aligned by index, and a length mismatch is refused because a row whose
 * dispute came from another row is a table with no meaning.
 *
 * The table is a parameter for the reason `recommendChart` takes a cue table: a candidate rule is
 * priced by passing it, not by editing this file and hoping the edit is the only change. It is also
 * the seam that lets the suite prove the routing guard — a policy that answers a third mark has to be
 * *refused*, and a guard no test can reach is a guard nobody knows works.
 */
export function arbitrateDisputes(
  rows: readonly ProfileInput[],
  disputes: readonly Dispute[],
  model: string,
  policies: readonly Policy[] = POLICIES,
): ArbitrationReport {
  if (rows.length !== disputes.length) {
    throw new Error(`text2vis arbitrate: ${String(rows.length)} rows and ${String(disputes.length)} disputes`);
  }
  // A share over nothing is not a reading — the rule `entryLlm` already follows. An empty population
  // would publish `0 / 0 = 0.00%` for every policy and a ceiling of zero, which reads as a broken
  // product rather than as a broken invocation.
  if (rows.length === 0) throw new Error('text2vis arbitrate: the population is empty, so there is no table to publish');
  const expected = rows.map((row) => familyOfLabel(row.label));
  const missing = expected.findIndex((family) => family === undefined);
  if (missing >= 0) {
    throw new Error(`text2vis arbitrate: row ${String(missing)} carries a label no family names, so it is not in the population`);
  }
  const truth = expected as readonly ChartFamily[];
  const productLead = disputes.map((dispute) => leadOf(dispute.product));
  const modelLead = disputes.map((dispute) => leadOf(modelAnswer(dispute)));

  let agree = 0;
  let agreeHit = 0;
  let disagree = 0;
  let productRight = 0;
  let modelRight = 0;
  const disputed: number[] = [];
  for (let index = 0; index < disputes.length; index += 1) {
    const same = productLead[index] === modelLead[index];
    const productOk = productLead[index] === truth[index];
    const modelOk = modelLead[index] === truth[index];
    if (same) {
      agree += 1;
      if (productOk) agreeHit += 1;
      continue;
    }
    disagree += 1;
    disputed.push(index);
    if (productOk) productRight += 1;
    if (modelOk) modelRight += 1;
  }

  const readings: PolicyReading[] = policies.map((policy) => {
    const answers = disputes.map((dispute) => policy.choose(dispute));
    const leads = answers.map((answer) => leadOf(answer));
    let kept = 0;
    let keptRight = 0;
    let given = 0;
    let givenRight = 0;
    for (const index of disputed) {
      const side = leads[index];
      if (side === productLead[index]) {
        kept += 1;
        if (side === truth[index]) keptRight += 1;
        continue;
      }
      if (side !== modelLead[index]) {
        throw new Error(
          `text2vis arbitrate: policy ${policy.name} answered ${String(side)} on row ${String(index)}, which neither system claimed; an arbitration may only route a row to one of the two answers`,
        );
      }
      given += 1;
      if (side === truth[index]) givenRight += 1;
    }
    let changed = 0;
    for (let index = 0; index < disputes.length; index += 1) if (leads[index] !== productLead[index]) changed += 1;
    const byRow = new Map<ProfileInput, ChartAnswer>(rows.map((row, index) => [row, answers[index] as ChartAnswer]));
    // A row with no answer is a crash rather than a refusal: a refusal is an answer, and this one never
    // happened. Defaulting to `declined` here would let a misaligned map publish as a policy that
    // refuses a fifth of the corpus.
    const scored = scoreAnswers(rows, (row) => byRow.get(row) as ChartAnswer, { variant: `policy:${policy.name}` });
    const cells = new Map<ChartFamily, { n: number; hit: number }>();
    for (let index = 0; index < disputes.length; index += 1) {
      const family = truth[index] as ChartFamily;
      const cell = cells.get(family) ?? { n: 0, hit: 0 };
      cell.n += 1;
      if (leads[index] === family) cell.hit += 1;
      cells.set(family, cell);
    }
    let gained = 0;
    let lost = 0;
    for (let index = 0; index < disputes.length; index += 1) {
      const productOk = productLead[index] === truth[index];
      const policyOk = leads[index] === truth[index];
      if (!productOk && policyOk) gained += 1;
      if (productOk && !policyOk) lost += 1;
    }
    return {
      name: policy.name,
      note: policy.note,
      hit: scored.top1,
      share: scored.top1Share,
      shortlist: scored.shortlist,
      changed,
      kept,
      keptRight,
      given,
      givenRight,
      gained,
      lost,
      p: mcnemarExact(gained, lost),
      perFamily: [...cells.entries()]
        .map(([family, cell]) => ({ family, ...cell }))
        .sort((left, right) => right.n - left.n || left.family.localeCompare(right.family)),
    };
  });

  const oracle = agreeHit + productRight + modelRight;
  // Ties are broken by how much of the product's behaviour a policy disturbs, then by name, so the
  // table reads the same way on every run — and so a policy that reaches the same score by rewriting
  // every answer does not displace one that agrees with the product wherever the model adds nothing.
  const best = [...readings].sort(
    (left, right) => right.hit - left.hit || left.changed - right.changed || left.name.localeCompare(right.name),
  )[0] as PolicyReading;

  return {
    model,
    population: { scored: disputes.length, roster: '' },
    agreement: { agree, agreeHit, disagree, productRight, modelRight },
    oracle: { hit: oracle, share: oracle / disputes.length },
    policies: readings,
    best: best.name,
  };
}

/**
 * The arithmetic a reader could not reproduce, refused rather than published.
 *
 * Seven checks, and each of them is a way this table could read better than the instrument earned:
 * a policy credited with a row it did not route, a decomposition that does not add up to the
 * population, an oracle that is not the union, a `best` that is not the best, or per-family cells
 * that do not sum to their own total.
 */
export function assertArbitration(report: ArbitrationReport, baseline = 'product'): void {
  const { agree, disagree } = report.agreement;
  if (agree + disagree !== report.population.scored) {
    throw new Error(
      `text2vis arbitrate: ${String(agree)} agreed + ${String(disagree)} disagreed and the agreement does not cover the population of ${String(report.population.scored)}`,
    );
  }
  if (report.oracle.hit !== report.agreement.agreeHit + report.agreement.productRight + report.agreement.modelRight) {
    throw new Error(
      `text2vis arbitrate: the ceiling of ${String(report.oracle.hit)} is not the agreed hits plus the rows each system won alone`,
    );
  }
  // The baseline is a parameter because a table has one *row* that everything else is stated against,
  // and which answer sits in that row depends on the question: `route.ts` prices two models and holds
  // the reading to the one that does not think, so asking it for a `product` row would be asking the
  // wrong table for its own identity.
  const product = report.policies.find((reading) => reading.name === baseline);
  if (product === undefined) throw new Error(`text2vis arbitrate: the table has no ${baseline} baseline`);
  for (const reading of report.policies) {
    if (reading.kept + reading.given !== disagree) {
      throw new Error(
        `text2vis arbitrate: ${reading.name} routed ${String(reading.kept + reading.given)} of the ${String(disagree)} rows in dispute`,
      );
    }
    if (reading.hit !== report.agreement.agreeHit + reading.keptRight + reading.givenRight) {
      throw new Error(
        `text2vis arbitrate: ${reading.name} reads ${String(reading.hit)} hits, which is not the agreed hits plus the rows it routed and got right`,
      );
    }
    if (reading.gained - reading.lost !== reading.hit - product.hit) {
      throw new Error(
        `text2vis arbitrate: ${reading.name} gained ${String(reading.gained)} and lost ${String(reading.lost)}, which is not the ${String(reading.hit - product.hit)} its total moved`,
      );
    }
    const cells = reading.perFamily.reduce((sum, cell) => sum + cell.n, 0);
    if (cells !== report.population.scored) {
      throw new Error(`text2vis arbitrate: ${reading.name} has per-family cells summing to ${String(cells)} and ${String(report.population.scored)} rows`);
    }
    const perFamilyHit = reading.perFamily.reduce((sum, cell) => sum + cell.hit, 0);
    if (perFamilyHit !== reading.hit) {
      throw new Error(`text2vis arbitrate: ${reading.name} has per-family hits summing to ${String(perFamilyHit)} and ${String(reading.hit)} hits`);
    }
  }
  const top = Math.max(...report.policies.map((reading) => reading.hit));
  const named = report.policies.find((reading) => reading.name === report.best);
  if (named === undefined || named.hit !== top) {
    throw new Error(`text2vis arbitrate: ${report.best} is named the best policy and does not hold the highest reading of ${String(top)}`);
  }
}

/** The arbitration as a reader sees it: one line per policy, then the ceiling above them. */
export function describeArbitration(report: ArbitrationReport, model = report.model): readonly string[] {
  const share = (value: number): string => `${(value * 100).toFixed(2)}%`;
  // The sign belongs to the net, not to one of its two halves: `gained` is a count of rows won and is
  // never negative, so guarding the sign on it printed `+-2` for every losing policy.
  const signed = (value: number): string => (value >= 0 ? `+${String(value)}` : String(value));
  const lines = [
    `\n  arbitration on ${String(report.population.scored)} rows against ${model}`,
    `    ${String(report.agreement.agree)} agreed (${String(report.agreement.agreeHit)} of them right), ${String(report.agreement.disagree)} in dispute: product ${String(report.agreement.productRight)}, model ${String(report.agreement.modelRight)}`,
  ];
  for (const reading of report.policies) {
    lines.push(
      `    ${reading.name.padEnd(14)} ${String(reading.hit)} (${share(reading.share)})  kept ${String(reading.kept)}+${String(reading.keptRight)} given ${String(reading.given)}+${String(reading.givenRight)}  vs product ${signed(reading.gained - reading.lost)} (p=${reading.p.toFixed(4)})`,
    );
  }
  lines.push(
    `    ${'ceiling'.padEnd(14)} ${String(report.oracle.hit)} (${share(report.oracle.share)})  the union of the two answers, which no rule can reach without the key`,
  );
  return lines;
}

/** The population the answers were taken over. */
export interface Population {
  readonly roster: string;
}

/**
 * Arbitrate one artifact's answers on the rows they were given to.
 *
 * The roster is the whole point: an artifact from an earlier corpus, or from a `--limit` that cut a
 * different set of rows, would be a table whose answers are attached to questions they were not asked.
 * The fingerprint is recomputed here from the corpus this process loaded, so the two cannot drift —
 * which is the defect the model arm itself published twice.
 */
export function arbitrate(
  rows: readonly ProfileInput[],
  choices: readonly (string | null)[],
  model: string,
  population: Population,
): ArbitrationReport {
  if (choices.length !== rows.length) {
    throw new Error(`text2vis arbitrate: the artifact holds answers for ${String(choices.length)} rows and the corpus has ${String(rows.length)}`);
  }
  const roster = rosterOf(rows);
  if (population.roster !== roster) {
    throw new Error(
      `text2vis arbitrate: the artifact answered a different population (${population.roster.slice(0, 12)}…) than the one on disk (${roster.slice(0, 12)}…), so its answers belong to questions it was not asked`,
    );
  }
  const disputes = rows.map((row, index) => disputeOf(row, choices[index] as string | null));
  const report = arbitrateDisputes(rows, disputes, model);
  return { ...report, population: { scored: rows.length, roster } };
}

export interface ArbitrateArgs {
  readonly json: boolean;
  readonly answers: string;
  readonly artifact?: string;
  readonly model?: string;
}

/** Parse the command line, refusing anything it does not use — the reason `parseLlmArgs` gives. */
export function parseArbitrateArgs(argv: readonly string[]): ArbitrateArgs {
  let json = false;
  let answers: string | undefined;
  let artifact: string | undefined;
  let model: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--answers' || flag === '--artifact' || flag === '--model') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a path or a name`);
      if (flag === '--answers') answers = value;
      else if (flag === '--artifact') artifact = value;
      else model = value;
      index += 1;
      continue;
    }
    throw new Error(
      `unknown argument ${flag}: this command asks nothing to a model and prices the answers already on disk, so it takes --json, --answers <path>, --artifact <path> and --model <name>`,
    );
  }
  // `--answers` is required rather than defaulted. A command whose entire input is an artifact must
  // not guess which artifact: a default path is how a reading gets priced against last week's file,
  // and the fingerprint would then report a mysterious population mismatch instead of a missing flag.
  if (answers === undefined) throw new Error('--answers is required: this command prices the answers an arm already wrote, and takes the path to them');
  return { json, answers, ...(artifact === undefined ? {} : { artifact }), ...(model === undefined ? {} : { model }) };
}

/** The shape this command reads out of `llm.ts`'s artifact, checked rather than trusted. */
interface Reading {
  readonly corpus?: { readonly roster?: unknown; readonly asked?: unknown };
  readonly arms?: readonly (Partial<ArmReport> & { readonly choices?: unknown })[];
}

export interface ArbitrateEntryOptions {
  readonly argv?: readonly string[];
  readonly load?: LoadOptions;
}

/**
 * The command.
 *
 * Exit 1 for anything that would publish a table about the wrong population or the wrong answers: no
 * mark arm, no fingerprint, a fingerprint that does not match, an answer list that is not one per row.
 */
export async function entryArbitrate(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  options: ArbitrateEntryOptions = {},
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  try {
    const args = parseArbitrateArgs(options.argv ?? []);
    const answersPath = args.answers;
    const { corpus, source, path } = await loadText2Vis(options.load ?? {});
    log(`text2vis: ${source} ${path}`);
    const { rows: scored, dropped } = scoredRows(corpus);
    if (dropped > 0) log(`text2vis arbitrate: ${String(dropped)} rows carry a label no family names and are not part of any population`);
    const { readFile } = await import('node:fs/promises');
    const reading = JSON.parse(await readFile(answersPath, 'utf8')) as Reading;
    const roster = reading.corpus?.roster;
    if (typeof roster !== 'string') {
      throw new Error(`${answersPath} carries no corpus.roster, so the rows its answers were given to cannot be identified; re-run the arm that wrote it`);
    }
    const asked = typeof reading.corpus?.asked === 'number' ? reading.corpus.asked : undefined;
    const rows = asked === undefined ? scored : scored.slice(0, asked);
    const arms = reading.arms ?? [];
    const marks = arms.filter((arm) => arm.scale === 'mark');
    if (marks.length === 0) throw new Error(`${answersPath} has no mark-scale arm, so there are not two answers to arbitrate between`);
    const arm = args.model === undefined ? (marks[0] as Partial<ArmReport>) : marks.find((candidate) => candidate.model === args.model);
    if (arm === undefined) throw new Error(`${answersPath} has no ${String(args.model)} mark arm`);
    const choices = arm.choices;
    if (!Array.isArray(choices) || !choices.every((choice) => choice === null || typeof choice === 'string')) {
      throw new Error(`${answersPath} carries no per-row choices for ${String(arm.model)}, so the rows it answered cannot be routed; re-run the arm that wrote it`);
    }
    const report = arbitrate(rows, choices as readonly (string | null)[], String(arm.model), { roster });
    assertArbitration(report);
    for (const line of describeArbitration(report)) log(line);
    if (args.json) log(JSON.stringify(report, null, 2));
    if (args.artifact !== undefined) {
      const { mkdir, writeFile, rename } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(args.artifact), { recursive: true });
      await writeFile(`${args.artifact}.part`, `${JSON.stringify(report, null, 2)}\n`);
      await rename(`${args.artifact}.part`, args.artifact);
      log(`text2vis: wrote ${args.artifact}`);
    }
    return 0;
  } catch (error) {
    log(`text2vis: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

void entryArbitrate(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`), {
  argv: process.argv.slice(2),
}).then((code) => applyExitCode(code, process));
