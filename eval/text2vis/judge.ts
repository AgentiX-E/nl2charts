/**
 * The second half of the chart reading: what the figures are worth, asked of a model that can see.
 *
 * `profile.ts` counts whether the recommender named the corpus's label, and `render.ts` counts
 * whether the emitted source produced a PNG. Neither answers the question a chart system is for,
 * which is whether the picture says what the question asked. That question needs the pixels read,
 * and reading them is the one step in this repository's evaluation that cannot be done with a
 * counter — so it is bought, once per row, and priced.
 *
 * Three decisions are the whole design:
 *
 * 1. **Two dimensions in one call.** Correctness and readability are asked in the same prompt, as
 *    two named integers in one JSON object. Asking them in two calls would double the price of a
 *    reading to learn the same thing about the same pixels, and the plan this instrument was
 *    registered under holds it to `calls <= 1` per row.
 * 2. **Two means, never a pass rate.** A grader's score is a reading on an ordinal scale with no
 *    calibrated threshold: "7" does not mean "acceptable" any more than "0.7" does. Publishing a
 *    share of rows above some cut would invent that threshold and then report it to two decimal
 *    places, so the report carries the means and the counts and nothing that looks like an accuracy.
 * 3. **The denominator travels with the number.** A row that drew no figure has no grade; a grade
 *    averaged over the rows a model happened to answer is a mean over a set that changed with the
 *    model. So `judged`, `failed` and `skipped` are published beside the means, and the identity
 *    `judged + failed + skipped === scored` is asserted rather than assumed.
 */
import {
  createHttpProvider,
  withCallCounter,
  type ImageDialect,
  type LlmImage,
  type LlmProvider,
  type LlmUsage,
} from '@agentix-e/nl2charts-ai';
import { applyExitCode, isEntry, loadText2Vis, type LoadOptions } from './dataset.js';
import { profileInputs, type ProfileInput } from './profile.js';
import { familyOfLabel } from './rule.js';
import { chartJobs, type ChartJobs } from './render.js';

/** The two things a grader is asked, in the order the prompt names them. */
export const JUDGE_DIMENSIONS = ['chart_correctness', 'readability'] as const;

export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];

/** One chart to grade: the figure, and the two statements a grader needs to read it. */
export interface JudgeJob {
  /** The row's position in the corpus, the same name `render.ts` gives it. */
  readonly id: string;
  readonly mark: string;
  /** The corpus's label, which is the reference the form is graded against. */
  readonly label: string;
  readonly question: string;
  /** Where the PNG is. Read at send time so a missing file is a failure with a name, not a crash. */
  readonly png: string;
}

/** A row that produced no figure, and why — so the denominator can be subtracted rather than lost. */
export interface JudgeSkip {
  readonly id: string;
  readonly reason: string;
}

/** What one grading call produced. */
export interface JudgeVerdict {
  readonly id: string;
  readonly chart_correctness?: number;
  readonly readability?: number;
  /** Present when the call failed or the reply could not be read as two scores. */
  readonly error?: string;
  /**
   * Why the call or the reply failed, as a kind a report can count.
   *
   * `error` is the sentence for a reader; this is the same fact for arithmetic. A run that lost
   * 27 rows to two different causes and printed only the sentences published "27 failed" and left
   * the reader to count bullet points.
   */
  readonly failure?: JudgeFailureKind;
  /**
   * What the endpoint said this call cost, when it said anything.
   *
   * A price in calls is a price in the only unit this instrument chooses; a price in tokens is the
   * one the endpoint bills. Both belong on the row, because `1,286 calls` at two very different
   * completion lengths is two very different bills — and because the deliberation a thinking model
   * spends before writing two integers is invisible in every other column.
   */
  readonly usage?: LlmUsage;
  readonly ms?: number;
  /**
   * What the grader actually wrote, bounded.
   *
   * Added after the first reading produced `chart_correctness 1.17` and nobody could say whether the
   * parse had misread a well-formed reply or the model had really written a 1. A mean is a product of
   * a parse, and a parse over a reply nobody kept is a number no reader can audit — the same defect
   * as a percentage in prose, one layer down. `REPLY_LIMIT` characters because the whole reply is one
   * JSON object; a grader that wrote prose has already failed the instruction, and the first 240
   * characters are enough to see that it did.
   */
  readonly reply?: string;
}

/**
 * How much of a reply the report keeps.
 *
 * Long enough for the instructed object plus the commentary a model sometimes adds around it, short
 * enough that 1,286 of them fit in an artifact a person can open.
 */
export const REPLY_LIMIT = 240;

/** One mark's line: the same two means over the rows that mark answered. */
export interface MarkJudgement {
  readonly mark: string;
  readonly rows: number;
  readonly judged: number;
  /**
   * The two means, or `null` when nothing under this mark was judged.
   *
   * `null` rather than `0` because the first reading of this instrument printed `boxplot 0/1 judged,
   * correctness 0.00` — a mean over zero rows, which reads as "the one boxplot scored zero" when the
   * truth is that its single call timed out. A zero that means "no observation" is the same defect as
   * a mean with no denominator.
   */
  readonly chart_correctness: number | null;
  readonly readability: number | null;
}

/** Who graded, because a mean without an author cannot be compared with another model's mean. */
export interface JudgeGrader {
  /** The declared endpoint the run selected, or the injected provider's own id. */
  readonly endpoint: string;
  /** The model that answered. Read from the declaration, not from the reply, which may rename it. */
  readonly model: string;
}

export interface JudgeReport {
  readonly dimensions: readonly JudgeDimension[];
  /**
   * The instrument that produced these means.
   *
   * First in the report because everything after it is relative to it: "chart_correctness 6.4" is
   * a fact about a model's reading, and the next round's floor is a comparison between two models.
   * A report that did not name its grader would be quotable as a property of the charts.
   */
  readonly grader: JudgeGrader;
  /** The rows the reading is over: the corpora rows the contract can lead with. */
  readonly scored: number;
  /** The charts the render artifact says exist, which is the population this instrument grades. */
  readonly charts: number;
  readonly judged: number;
  readonly failed: number;
  /**
   * Charts that exist and were not graded, because `--limit` stopped the run.
   *
   * Published rather than folded into `failed` or into `skipped`: a priced sample is a different
   * reading from a broken one, and a report that could not tell them apart would let a 40-row
   * sample be quoted as if 1,286 figures had been graded.
   */
  readonly notSelected: number;
  /** Rows with no figure at all: declined, refused, or failed at draw time. */
  readonly skipped: number;
  /**
   * The two means, or `null` when nothing was judged.
   *
   * `null` and not `0`: a run whose every call failed would otherwise publish "chart_correctness
   * 0.00", which is a claim about the charts made out of no readings at all.
   */
  readonly means: { readonly chart_correctness: number | null; readonly readability: number | null };
  readonly byMark: readonly MarkJudgement[];
  /** Calls actually spent. One per attempted row, and the assertion below holds it to that. */
  readonly calls: number;
  readonly callsPerRow: number;
  /**
   * The tokens the endpoint reported, summed over the rows that reported any.
   *
   * `reported` travels with the sums for the same reason `judged` travels with the means: an
   * endpoint that says nothing about usage is not an endpoint that charged nothing, and a total
   * over an unknown number of rows is a number nobody can divide.
   */
  readonly tokens: {
    readonly prompt: number;
    readonly completion: number;
    readonly reasoning: number;
    readonly reported: number;
  };
  readonly failures: readonly { readonly id: string; readonly error: string; readonly kind: JudgeFailureKind }[];
  /**
   * The failures counted by kind, so "27 failed" can be read without counting bullet points.
   *
   * The first full run published 27 failures whose causes were 24 truncated replies and 3 provider
   * refusals — one is a budget this file chooses, the other is a policy this file cannot change.
   */
  readonly failedByKind: Readonly<Record<JudgeFailureKind, number>>;
  /**
   * Every row that was attempted, with its own two scores, its price in milliseconds and what the
   * grader wrote.
   *
   * The means above are a summary of this array and nothing else: publishing them without it would
   * make a reading that cannot be re-read, which is how a parse defect survives a round.
   */
  readonly verdicts: readonly JudgeVerdict[];
  /**
   * The one call spent proving the endpoint could see, and what it answered.
   *
   * Not per row and therefore not in `calls`: this is the instrument checking itself, and a report
   * that folded it into the per-row price would make a 1,286-row run read 1.001 calls per row.
   */
  readonly probe: { readonly answer: string; readonly seen: boolean };
}

/**
 * The instruction, and the reason it is this short.
 *
 * A grader asked for prose returns prose, and a reader of prose is a parser with a tolerance for
 * numbers that were not the answer — the defect this repository has paid for twice. So the format
 * is one JSON object with two named integers, the anchors for `0` and `10` are stated so the scale
 * means the same thing on every row, and the two dimensions are told apart explicitly because a
 * grader that conflates them reports the same number twice.
 */
export const JUDGE_SYSTEM = [
  'You grade one chart drawn by a text-to-chart system. Answer with one JSON object and nothing else:',
  '{"chart_correctness": <integer 0-10>, "readability": <integer 0-10>}',
  '',
  'chart_correctness: whether the chart is the kind of chart the question asks for, and whether it',
  'plots a measure that answers the question. 10 is the form the question names, plotting the right',
  'measure. 0 is a different form from the one asked for, even when the figure is tidy. Do not reward',
  'tidiness in the wrong form, and do not punish an ugly chart that answers the question.',
  '',
  'readability: whether a reader can tell what the chart says without the question, from its title,',
  'axis labels, tick labels and legibility. 10 is self-explanatory and legible. 0 is unreadable or',
  'unlabelled.',
  '',
  'Integers only. No commentary, no markdown, no code block.',
].join('\n');

/**
 * The turn the figure arrives in.
 *
 * The label is named as the corpus's own, and as a property of the *question* rather than of the
 * answer: a grader told "the right answer is a bar chart" scores the form it was told to expect,
 * which is the reading `profile.ts` already takes with a counter and would be measuring twice.
 */
export function buildJudgePrompt(job: JudgeJob): string {
  return [
    `Question: ${job.question}`,
    `The question is labelled "${job.label}" in the corpus that collected it.`,
    'Grade the chart in the image attached to this message.',
  ].join('\n');
}

/**
 * A two-by-two figure that is entirely red, and the question only a pair of eyes can answer.
 *
 * This exists because of the one failure the contract cannot see: an endpoint *declared* able to
 * read images answers anyway when it cannot, and its answer is written from the question alone. The
 * request builder refuses an image to an endpoint that declared no vision — but a dispatch that
 * names a text-only model has *declared* it, so nothing in the request path can tell. On 1,286
 * graded figures that failure would publish two means about a model's opinion of a caption.
 *
 * So one figure is spent before the batch, its answer is checked against the only fact it can carry,
 * and a run whose grader cannot name a colour does not grade anything. Two pixels rather than one:
 * a one-pixel PNG is a file some image pipelines treat as degenerate.
 */
const PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR42mP4z8AARAwQCgAf7gP9Y167WwAAAABJRU5ErkJggg==';

export const VISION_PROBE = 'What is the dominant colour of the image attached? Answer with one word.';

/** Whether a reply could only have been written by a reader that saw red. */
export function sawRed(reply: string): boolean {
  // `红` is here because the grader is not necessarily asked in its first language: Zhipu's vision
  // models answer an English question in English, and answer it in Chinese when the prompt's own
  // wording tips them that way. A probe that refused `红色` would report a working endpoint as blind,
  // and the run would stop before grading a single figure — the expensive direction of this check.
  return /\b(red|crimson|scarlet|vermilion)\b|ff0000|#f00\b|红/i.test(reply);
}

/**
 * What the probe learned, and the difference between the two ways of learning nothing.
 *
 * `asked` is the field a real dispatch added. The first production run of this instrument answered
 * `llm returned 429` — a rate limit — and the report printed it as *"the probe answered \"llm returned
 * 429\", which does not name the red in the image"*, which reads as a verdict on the endpoint's eyes.
 * A quota is not a blindness: one of the two is a waiting problem and the other is a wrong endpoint,
 * and an instrument that says the second when it means the first sends its reader to change a model
 * that was fine. So a call that never got an answer is counted apart, and only a call that *answered*
 * and failed to name the colour is evidence that the endpoint cannot see.
 */
export interface ProbeReading {
  readonly answer: string;
  /** Whether an answer came back at all. False for a transport failure or a refusal like 429. */
  readonly asked: boolean;
  /** Whether the answer could only have been written by a reader that saw red. */
  readonly seen: boolean;
}

/**
 * Ask the endpoint to name a colour, and keep what it said.
 *
 * Never throws: a probe that could not be sent is a probe that did not see, and `seen` is the field
 * the report refuses on — an exception here would be a stack trace where a one-line reason belongs.
 * `undefined` as an answer is spelled as an empty string so the report has one shape.
 *
 * `temperature` travels with the probe because the probe is a request like any other: it used to
 * name zero, and on an endpoint whose documented range may exclude zero the check would have been
 * the first thing refused — the instrument failing on the one call it exists to spend.
 */
export async function probeVision(provider: LlmProvider, temperature: number | null = 0): Promise<ProbeReading> {
  try {
    const response = await provider.complete({
      messages: [
        { role: 'system', content: 'You answer questions about images in one word.' },
        { role: 'user', content: VISION_PROBE, images: [{ mediaType: 'image/png', data: PROBE_PNG }] },
      ],
      temperature,
      purpose: 'probe',
    });
    const answer = response.text.trim().replace(/\s+/g, ' ').slice(0, 80);
    return { answer, asked: true, seen: sawRed(answer) };
  } catch (error) {
    return { answer: error instanceof Error ? error.message : String(error), asked: false, seen: false };
  }
}

/**
 * Why a reply could not be read as two scores.
 *
 * Kept as a field rather than inferred from the sentence, because the sentence is what a reader
 * sees and the kind is what a report counts. The first full run of this instrument lost 27 of
 * 1,286 rows and published all of them as `the reply named neither score` — 24 of those replies
 * named the first score and were cut at the endpoint's token cap, so the message sent a reader
 * looking for a parser bug where there was a budget one. `truncated` and `unreadable` are two
 * different repairs.
 */
export type JudgeFailureKind = 'truncated' | 'unreadable' | 'refused' | 'unavailable' | 'invalid-response' | 'call-failed';

/** A reply that arrived but could not be read, carrying the reason as data. */
export class JudgeReplyError extends Error {
  constructor(
    readonly kind: 'partial' | 'unreadable' | 'out-of-range',
    message: string,
  ) {
    super(message);
    this.name = 'JudgeReplyError';
  }
}

/**
 * The kind of a failed row, from the structure the failure already carries.
 *
 * The provider's refusals and outages arrive as `Nl2ChartsError` with a code, and a reply that
 * could not be read arrives as `JudgeReplyError` with a kind, so this is a mapping rather than a
 * match on prose. That matters for the same reason `finish_reason` is carried instead of inferred:
 * a message is written for a reader and changed for a reader, and anything that counts must not
 * move when the wording does.
 */
export function classifyFailure(error: unknown): JudgeFailureKind {
  if (error instanceof JudgeReplyError) {
    return error.kind === 'partial' ? 'truncated' : 'unreadable';
  }
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
  if (code === 'NL2C_E_LLM_REJECTED') return 'refused';
  if (code === 'NL2C_E_LLM_UNAVAILABLE') return 'unavailable';
  if (code === 'NL2C_E_LLM_INVALID_RESPONSE') return 'invalid-response';
  return 'call-failed';
}

/** A refusal that names the reply, because the reply is the only thing that explains it. */
function unreadable(reply: string, why: string, kind: 'partial' | 'unreadable' | 'out-of-range'): Error {
  const seen = reply.trim().replace(/\s+/g, ' ');
  return new JudgeReplyError(kind, `${why}: ${seen.length === 0 ? '(empty reply)' : seen.slice(0, 160)}`);
}

/**
 * Two scores out of a reply, or an error that quotes the reply.
 *
 * JSON first, because that is what the prompt asks for. Then a labelled-number form, because a
 * small model that has been told to emit JSON will sometimes emit `chart_correctness: 8,
 * readability: 7` and that reply is not ambiguous — refusing it would price a retry to learn what
 * the sentence already said. What is never accepted is *position*: an unlabelled pair like `8 7`
 * is two numbers in an order only the prompt knows, and a reader that trusted it would swap the
 * two dimensions on some rows and never say so.
 *
 * A number outside 0..10 is refused rather than clamped. A grader that answered 87 meant something
 * the prompt did not ask for, and clamping it to 10 would publish that as the best possible chart.
 */
export function parseJudge(
  reply: string,
  finishReason?: string,
): { readonly chart_correctness: number; readonly readability: number } {
  const text = reply.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.slice(start, end + 1));
    } catch {
      parsed = undefined;
    }
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const picked = JUDGE_DIMENSIONS.map((dimension) => record[dimension]);
      if (picked.every((value) => typeof value === 'number')) {
        return scoresOf(picked[0] as number, picked[1] as number, body);
      }
    }
  }
  const labelled = JUDGE_DIMENSIONS.map((dimension) => {
    const pattern = new RegExp(`${dimension}\\D{0,8}(\\d+(?:\\.\\d+)?)`, 'i');
    return pattern.exec(body)?.[1];
  });
  if (labelled.every((value) => value !== undefined)) {
    return scoresOf(Number(labelled[0]), Number(labelled[1]), body);
  }
  // Which of the two the grader did name, and whether the endpoint said why it stopped. A reply
  // that names one score is not a reply that named neither, and at 1,286 figures the difference
  // is 24 rows a reader would otherwise chase through the parser instead of the budget.
  const named = JUDGE_DIMENSIONS.filter((_, index) => labelled[index] !== undefined);
  const cap = finishReason === 'length' ? ' (finish=length: the endpoint hit its token cap)' : '';
  if (named.length === 1) {
    const missing = JUDGE_DIMENSIONS.find((dimension) => dimension !== named[0]) as string;
    throw unreadable(body, `the reply named ${named[0]} and stopped before ${missing}${cap}`, 'partial');
  }
  throw unreadable(
    body,
    finishReason === 'length' ? `the reply stopped at the token cap before it named either score${cap}` : 'the reply named neither score',
    'unreadable',
  );
}

function scoresOf(correctness: number, readability: number, reply: string): {
  readonly chart_correctness: number;
  readonly readability: number;
} {
  for (const value of [correctness, readability]) {
    if (!Number.isFinite(value) || value < 0 || value > 10) {
      throw unreadable(reply, `a score of ${String(value)} is outside the 0-10 scale the prompt asked for`, 'out-of-range');
    }
  }
  return { chart_correctness: correctness, readability };
}

/**
 * Turn the corpus into the list of figures to grade.
 *
 * The ids are `chartJobs`'s, so the two readings join on the same name. A row that drew nothing is
 * *skipped with its reason* rather than dropped: the report subtracts it from the denominator and
 * publishes the subtraction, which is the difference between "the judge graded 1,286 charts" and
 * "the judge graded the charts that happened to work".
 */
export function judgeJobs(
  rows: readonly ProfileInput[],
  charts: ChartJobs,
  failed: readonly string[],
  pngDir: string,
): { readonly jobs: readonly JudgeJob[]; readonly skipped: readonly JudgeSkip[] } {
  const drawn = new Set(failed);
  const jobs: JudgeJob[] = [];
  const skipped: JudgeSkip[] = [];
  const declined = new Map(charts.refusals.map((refusal) => [refusal.id, refusal]));
  for (const job of charts.jobs) {
    const row = rows[Number(job.id)] as ProfileInput | undefined;
    if (row === undefined) {
      throw new Error(`judge: chart ${job.id} names a row the corpus does not have`);
    }
    if (drawn.has(job.id)) {
      skipped.push({ id: job.id, reason: 'render:failed' });
      continue;
    }
    jobs.push({
      id: job.id,
      mark: job.mark,
      label: row.label,
      question: row.prompt,
      png: `${pngDir}/${job.id}.png`,
    });
  }
  for (const refusal of declined.values()) skipped.push({ id: refusal.id, reason: refusal.code });
  // A failure named in the artifact that is not a job here would be a row this function has silently
  // dropped, and the identity below cannot see it: it would still add up because both sides lost it.
  const known = new Set([...charts.jobs.map((job) => job.id), ...declined.keys()]);
  for (const id of drawn) {
    if (!known.has(id)) throw new Error(`judge: the render artifact reports a failure for row ${id}, which drew no chart`);
  }
  const total = jobs.length + skipped.length;
  if (total !== rows.length) {
    throw new Error(`judge: ${String(jobs.length)} charts and ${String(skipped.length)} skips do not account for ${String(rows.length)} rows`);
  }
  return { jobs, skipped };
}

/** Mean to two places, and `0` for an empty set — reported beside a count that says it was empty. */
/**
 * The mean of at least one reading, to two places.
 *
 * The caller proves the array is not empty and keeps `null` for the empty case: a function that
 * answered zero would be a mean pretending to be a verdict, which is the defect this round removed
 * from two report fields. There is no guard here because there is no zero to return.
 */
function mean(values: readonly [number, ...number[]]): number {
  return Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(2));
}

/**
 * Fold the verdicts into one report.
 *
 * `scored` is passed rather than derived so the identity at the end is a statement about the corpus
 * and not a rearrangement of its own terms: `judged + failed + skipped` must equal the rows the
 * reading claims to be over, and a report that fails that check is a report where a row quietly
 * stopped existing.
 */
export function summarizeJudge(
  scored: number,
  charts: number,
  jobs: readonly JudgeJob[],
  skipped: readonly JudgeSkip[],
  verdicts: readonly JudgeVerdict[],
  calls: number,
  probe: { readonly answer: string; readonly seen: boolean },
  grader: JudgeGrader,
): JudgeReport {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const byMark = new Map<string, { rows: number; correctness: number[]; readability: number[] }>();
  const failures: { id: string; error: string; kind: JudgeFailureKind }[] = [];
  const failedByKind: Record<JudgeFailureKind, number> = {
    truncated: 0,
    unreadable: 0,
    refused: 0,
    unavailable: 0,
    'invalid-response': 0,
    'call-failed': 0,
  };
  const correctness: number[] = [];
  const readability: number[] = [];
  const tokens = { prompt: 0, completion: 0, reasoning: 0, reported: 0 };
  for (const verdict of verdicts) {
    const job = byId.get(verdict.id);
    if (job === undefined) throw new Error(`judge: verdict for row ${verdict.id} has no job`);
    const cell = byMark.get(job.mark) ?? { rows: 0, correctness: [], readability: [] };
    byMark.set(job.mark, cell);
    cell.rows += 1;
    if (verdict.error !== undefined) {
      // Only one path produces an error verdict and it always sets `failure`; the fallback is for a
      // report read back from an artifact written before the field existed, and it says so rather
      // than guessing a cause.
      const kind = verdict.failure ?? 'call-failed';
      failures.push({ id: verdict.id, error: verdict.error, kind });
      failedByKind[kind] += 1;
      continue;
    }
    if (verdict.usage !== undefined) {
      tokens.prompt += verdict.usage.promptTokens;
      tokens.completion += verdict.usage.completionTokens;
      tokens.reasoning += verdict.usage.reasoningTokens ?? 0;
      tokens.reported += 1;
    }
    const one = verdict.chart_correctness as number;
    const two = verdict.readability as number;
    correctness.push(one);
    readability.push(two);
    cell.correctness.push(one);
    cell.readability.push(two);
  }
  const judged = correctness.length;
  const report: JudgeReport = {
    dimensions: [...JUDGE_DIMENSIONS],
    grader,
    scored,
    charts,
    judged,
    failed: failures.length,
    notSelected: charts - verdicts.length,
    skipped: skipped.length,
    means: {
      chart_correctness: correctness.length === 0 ? null : mean(correctness as [number, ...number[]]),
      readability: readability.length === 0 ? null : mean(readability as [number, ...number[]]),
    },
    byMark: [...byMark.entries()]
      .map(([mark, cell]) => ({
        mark,
        rows: cell.rows,
        judged: cell.correctness.length,
        chart_correctness: cell.correctness.length === 0 ? null : mean(cell.correctness as [number, ...number[]]),
        readability: cell.readability.length === 0 ? null : mean(cell.readability as [number, ...number[]]),
      }))
      .sort((left, right) => right.rows - left.rows || left.mark.localeCompare(right.mark)),
    calls,
    // Per *attempted* row — judged plus failed — because that is what the instrument costs. Dividing
    // by `judged` alone would report two calls per row on a run that spent one call on each of two
    // rows and lost one reply to a parse, which is a ratio about the parser rather than about price.
    callsPerRow: verdicts.length === 0 ? 0 : Number((calls / verdicts.length).toFixed(3)),
    failures,
    failedByKind,
    tokens,
    // By row index, which is a number because `chartJobs` makes every id one (`String(index)`), and
    // unique because it *is* the index. A tie-break here would be code no input can reach: two
    // verdicts with the same id are the same row counted twice, which the partition check refuses.
    verdicts: [...verdicts].sort((left, right) => Number(left.id) - Number(right.id)),
    probe,
  };
  return report;
}

/**
 * What a judge report has to be true before anyone reads a mean out of it.
 *
 * The first check is the price, and it is a contract rather than a budget: two dimensions come back
 * in one call, so a run that spent more than one call per row either asked twice or retried, and both
 * of those are a different instrument from the one this file documents. The rest are the arithmetic
 * that makes the means readable — a mean with no count behind it, or a row that is in neither the
 * judged set nor the failures, is a number whose denominator nobody can check.
 */
export function assertJudgeReport(report: JudgeReport): void {
  // The price, as an equality rather than a bound: one call per attempted row, so a run that spent
  // more asked twice and a run that spent fewer counted wrong. Both are instruments other than the
  // one this file documents, and a `<=` here would report either of them as this one.
  if (report.calls !== report.judged + report.failed) {
    throw new Error(
      `judge report: ${String(report.calls)} calls for ${String(report.judged)} judged and ${String(report.failed)} failed, and this instrument spends one call per attempted row`,
    );
  }
  if (report.judged + report.failed + report.notSelected !== report.charts) {
    throw new Error(
      `judge report: ${String(report.judged)} judged, ${String(report.failed)} failed and ${String(report.notSelected)} unselected do not account for ${String(report.charts)} charts`,
    );
  }
  if (report.charts + report.skipped !== report.scored) {
    throw new Error(
      `judge report: ${String(report.charts)} charts and ${String(report.skipped)} skips do not account for ${String(report.scored)} scored rows`,
    );
  }
  if (report.failed > 0 && report.failures.length !== report.failed) {
    throw new Error(`judge report: ${String(report.failed)} failures and ${String(report.failures.length)} messages`);
  }
  if (report.callsPerRow > 1) {
    throw new Error(`judge report: ${report.callsPerRow.toFixed(3)} calls per row, and this instrument spends one`);
  }
  // The kinds must add up to the count they explain: 27 failures described as 24 truncated and 3
  // refused is a reading, and 24 and 3 beside a failed of 30 is a report whose arithmetic nobody has
  // checked. Cheap here, invisible to a reader.
  const byKind = Object.values(report.failedByKind).reduce((total, rows) => total + rows, 0);
  if (byKind !== report.failed) {
    throw new Error(
      `judge report: ${String(byKind)} failures counted by kind and ${String(report.failed)} reported as failed`,
    );
  }
  // Only a judged row can carry usage: a failed call may have been billed, but this instrument does
  // not know what it cost, and a total that silently included one would be a number with a guess in it.
  if (report.tokens.reported > report.judged) {
    throw new Error(
      `judge report: ${String(report.tokens.reported)} rows reported usage for ${String(report.judged)} judged`,
    );
  }
  if (!report.probe.seen) {
    throw new Error(
      `judge report: the endpoint did not say red to a red image (it said "${report.probe.answer}"), so these means are an opinion of the text rather than a reading of the figures`,
    );
  }
  // Two means and no author is the shape of a number that gets quoted as a property of the corpus.
  // Refused here rather than left to the reader, because the reader has no way to recover the name.
  if (report.grader.endpoint.trim() === '' || report.grader.model.trim() === '') {
    throw new Error(
      'judge report: the report names no endpoint or model, so its means cannot be compared with another grader\'s',
    );
  }
  for (const mean of [report.means.chart_correctness, report.means.readability]) {
    if (mean === null) continue;
    if (mean < 0 || mean > 10) throw new Error(`judge report: a mean of ${String(mean)} is outside the scale`);
  }
  // A row is a reading or a failure, never both and never neither: two scores without a place in the
  // mean, or an id the means were computed without, would be a row the summary silently dropped.
  if (report.verdicts.length !== report.judged + report.failed) {
    throw new Error(
      `judge report: ${String(report.verdicts.length)} rows kept for ${String(report.judged)} judged and ${String(report.failed)} failed`,
    );
  }
  for (const verdict of report.verdicts) {
    const scored = verdict.chart_correctness !== undefined && verdict.readability !== undefined;
    if (scored === (verdict.error !== undefined)) {
      throw new Error(`judge report: row ${verdict.id} is ${scored ? 'scored and also an error' : 'neither scored nor an error'}`);
    }
    if (verdict.reply === undefined && verdict.error === undefined) {
      throw new Error(`judge report: row ${verdict.id} kept no reply, so its score cannot be re-read`);
    }
    if (verdict.reply !== undefined && verdict.reply.length > REPLY_LIMIT) {
      throw new Error(`judge report: row ${verdict.id} kept ${String(verdict.reply.length)} characters of reply, over the ${String(REPLY_LIMIT)} it documents`);
    }
  }
}

/** A mean as the log prints it, with "no reading" for the bucket that has no rows behind it. */
export function score(mean: number | null): string {
  return mean === null ? 'no reading' : `${mean.toFixed(2)}/10`;
}

/** The lines the log prints, and the shape of the answer: two means and their denominators. */
export function describeJudge(report: JudgeReport): readonly string[] {
  const lines = [
    `text2vis: judged ${String(report.judged)}/${String(report.charts)} charts with ${report.grader.model} (${report.grader.endpoint})` +
      ` — ${String(report.failed)} failed, ${String(report.notSelected)} unselected, ${String(report.skipped)} skipped of ${String(report.scored)} scored`,
    `  chart_correctness ${score(report.means.chart_correctness)}, readability ${score(report.means.readability)}`,
    `  calls ${String(report.calls)}, ${report.callsPerRow.toFixed(3)} per judged row; the vision probe answered "${report.probe.answer}"`,
  ];
  if (report.failed > 0) {
    const counted = Object.entries(report.failedByKind)
      .filter(([, rows]) => rows > 0)
      .map(([kind, rows]) => `${String(rows)} ${kind}`);
    lines.push(`  why they failed: ${counted.join(', ')}`);
  }
  if (report.tokens.reported > 0) {
    const share = report.tokens.completion === 0 ? '—' : `${((report.tokens.reasoning / report.tokens.completion) * 100).toFixed(1)}%`;
    lines.push(
      `  tokens ${String(report.tokens.reported)} rows reported: prompt ${String(report.tokens.prompt)}, ` +
        `completion ${String(report.tokens.completion)} (reasoning ${String(report.tokens.reasoning)}, ${share} of it)`,
    );
  }
  for (const mark of report.byMark) {
    lines.push(
      `  ${mark.mark}: ${String(mark.judged)}/${String(mark.rows)} judged, ` +
        `correctness ${score(mark.chart_correctness)}, readability ${score(mark.readability)}`,
    );
  }
  for (const failure of report.failures) lines.push(`  FAILED row ${failure.id}: ${failure.error}`);
  // A sample is audited in the log it was taken in. On a full run the per-row lines would be 1,286
  // of them and the artifact holds every one; on a rehearsal they are the whole point, because the
  // only question a rehearsal answers is "is this grader reading these figures, and what did it say".
  if (report.notSelected > 0) {
    lines.push(`  the ${String(report.verdicts.length)} rows that were graded, with what the grader wrote:`);
    for (const verdict of report.verdicts) {
      const scores =
        verdict.error === undefined
          ? `correctness ${String(verdict.chart_correctness)}, readability ${String(verdict.readability)}`
          : `FAILED ${verdict.error}`;
      const ms = verdict.ms === undefined ? '' : `, ${String(verdict.ms)} ms`;
      lines.push(`  row ${verdict.id}: ${scores}${ms}${verdict.reply === undefined ? '' : ` — ${verdict.reply}`}`);
    }
  }
  return lines;
}

/** The media type of what the renderer writes. A PNG, and only a PNG: the worker never encodes another. */
const PNG_MEDIA = 'image/png' as const;

export interface JudgeOptions {
  readonly provider: LlmProvider;
  /**
   * The sampling temperature, in the two absences the contract distinguishes.
   *
   * `undefined` is this repository's default of zero, which is what every reading in
   * `docs/benchmarks.md` was taken at. `null` is "do not name a value", and it is the only honest
   * setting for an endpoint whose documented range may exclude zero: a grader sent a value it
   * refuses answers 400, and one sent a value it ignores reports a sampling nobody applied.
   */
  readonly temperature?: number | null;
  /** Reads one PNG as base64. Injected so the grading loop can be tested without a filesystem. */
  readonly readImage?: (path: string) => Promise<LlmImage>;
  readonly now?: () => number;
  /**
   * How many calls may be in flight at once. One by default.
   *
   * The first reading of this instrument measured **49 seconds per call** on a 1,286-chart corpus,
   * which is seventeen and a half hours in sequence — longer than any runner will hold a job. The
   * calls are independent, so the only decision is how many to overlap; what must not change is the
   * price (`one call per row`, still asserted) or the order of the artifact (rebuilt by index, so a
   * faster row does not move the report).
   */
  readonly concurrency?: number;
}

/**
 * Grade every job, one call each, in order.
 *
 * A failed call is a failed *row*, not a failed run: an endpoint that rate-limits one row out of
 * forty should cost that row's grade and nothing else, and a batch that aborts on the first 429
 * reports an accuracy over the rows that happened to arrive before the limit. The error is kept
 * with the row's id so the report can print which figure nobody graded.
 */
export async function judgeJobsWith(jobs: readonly JudgeJob[], options: JudgeOptions): Promise<readonly JudgeVerdict[]> {
  const { readFile } = await import('node:fs/promises');
  const read = options.readImage ?? (async (path: string) => ({ mediaType: PNG_MEDIA, data: (await readFile(path)).toString('base64') }));
  const now = options.now ?? (() => Date.now());
  const temperature = options.temperature === undefined ? 0 : options.temperature;
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`judge: --concurrency must be a whole number of at least 1, not ${String(concurrency)}`);
  }
  const verdicts: JudgeVerdict[] = new Array<JudgeVerdict>(jobs.length);
  const one = async (job: JudgeJob, index: number): Promise<void> => {
    const started = now();
    try {
      const image = await read(job.png);
      const response = await options.provider.complete({
        messages: [
          { role: 'system', content: JUDGE_SYSTEM },
          { role: 'user', content: buildJudgePrompt(job), images: [image] },
        ],
        temperature,
        purpose: 'compare',
      });
      const scores = parseJudge(response.text, response.finishReason);
      verdicts[index] = {
        id: job.id,
        ...scores,
        ...(response.usage === undefined ? {} : { usage: response.usage }),
        reply: response.text.trim().slice(0, REPLY_LIMIT),
        ms: now() - started,
      };
    } catch (error) {
      // A row that never got an answer has no reply to keep: the error *is* what was learned, and a
      // fabricated empty reply would read as a grader that answered with nothing.
      verdicts[index] = {
        id: job.id,
        error: error instanceof Error ? error.message : String(error),
        failure: classifyFailure(error),
        ms: now() - started,
      };
    }
  };
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const job = jobs[index];
      if (job === undefined) return;
      await one(job, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length === 0 ? 1 : jobs.length) }, worker));
  return verdicts;
}

export interface JudgeArgs {
  readonly artifact?: string;
  readonly render?: string;
  readonly png: string;
  readonly limit?: number;
  readonly json: boolean;
  /** The endpoint row to grade with, when the caller wants one other than the default. */
  readonly endpoint?: string;
  /** Ask the endpoint one question about one image and stop: the whole run, priced at one call. */
  readonly probeOnly: boolean;
  /** How many calls the run keeps in flight. Absent means one. */
  readonly concurrency?: number;
}

export function parseJudgeArgs(argv: readonly string[]): JudgeArgs {
  let artifact: string | undefined;
  let render: string | undefined;
  let png = 'eval/.cache/text2vis/png';
  let limit: number | undefined;
  let json = false;
  let endpoint: string | undefined;
  let probeOnly = false;
  let concurrency: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--probe-only') {
      probeOnly = true;
      continue;
    }
    if (
      flag === '--artifact' ||
      flag === '--render' ||
      flag === '--png' ||
      flag === '--limit' ||
      flag === '--endpoint' ||
      flag === '--concurrency'
    ) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      if (flag === '--limit') {
        if (!/^\d+$/.test(value) || Number(value) === 0) throw new Error(`--limit needs a positive whole number, not ${value}`);
        limit = Number(value);
      } else if (flag === '--concurrency') {
        if (!/^\d+$/.test(value) || Number(value) === 0) throw new Error(`--concurrency needs a positive whole number, not ${value}`);
        concurrency = Number(value);
      } else if (flag === '--artifact') artifact = value;
      else if (flag === '--render') render = value;
      else if (flag === '--endpoint') endpoint = value;
      else png = value;
      index += 1;
      continue;
    }
    throw new Error(
      `unknown argument ${flag}: this command grades the charts the renderer drew, and takes --json, --png <dir>, ` +
        `--render <path>, --artifact <path>, --limit <n>, --endpoint <name>, --concurrency <n> and --probe-only`,
    );
  }
  return {
    png,
    json,
    probeOnly,
    ...(artifact === undefined ? {} : { artifact }),
    ...(render === undefined ? {} : { render }),
    ...(limit === undefined ? {} : { limit }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(concurrency === undefined ? {} : { concurrency }),
  };
}

/**
 * Read the render artifact, and be strict about it.
 *
 * The judge's denominator comes from a file another process wrote, so every way that file can be
 * wrong is a way this reading could grade a population that does not exist: no artifact means the
 * caller has to run the renderer first, and an artifact whose own counts do not add up is a defect
 * in the renderer that this instrument must not launder into a mean.
 */
export async function readRender(path: string): Promise<{ readonly failed: readonly string[]; readonly rendered: number }> {
  const { readFile } = await import('node:fs/promises');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`judge: no render artifact at ${path}: run the renderer with --keep first`);
  }
  const parsed = JSON.parse(text) as { readonly rendered?: unknown; readonly failed?: unknown; readonly failures?: readonly { readonly id?: unknown }[] };
  if (typeof parsed.rendered !== 'number' || typeof parsed.failed !== 'number' || !Array.isArray(parsed.failures)) {
    throw new Error(`judge: ${path} is not a render report: it has no rendered/failed/failures`);
  }
  const failed = parsed.failures.map((failure) => String(failure.id));
  if (failed.length !== parsed.failed) throw new Error(`judge: ${path} reports ${String(parsed.failed)} failures and lists ${String(failed.length)}`);
  return { failed, rendered: parsed.rendered };
}

/**
 * An endpoint that can see, as a declaration a person made and one call will check.
 *
 * The previous draft of this file had a `defaultJudgeProvider` that named DeepSeek's base url,
 * DeepSeek's model and `vision: true`. Two of those three were wrong in the same way: DeepSeek's
 * chat models are text-only, so the declaration was a claim about an endpoint that could not keep
 * it, and the only thing standing between that claim and 1,286 means about captions was the probe.
 * A default is the wrong shape for this decision. What an endpoint *is* — its url, its model, how it
 * spells an image, what it does with a temperature — is a fact about a vendor, and facts belong in a
 * table a reader can check rather than in a fallback nobody reads.
 *
 * So each row is one endpoint, every field is one fact that differs between vendors, and adding a
 * vendor is one row. `zhipu` is the only row with evidence behind it, which is why it is the only
 * row: a second row that guessed would be the same defect one line down.
 */
export interface JudgeEndpoint {
  /** The name `--endpoint` selects. */
  readonly name: string;
  /** The chat-completions base url, without `/chat/completions`. */
  readonly baseUrl: string;
  readonly model: string;
  /**
   * The environment variables that may hold this endpoint's key, tried in order.
   *
   * More than one because the same endpoint is reached two ways in this repository: the workflow
   * passes the org secret by its vendor name, and a developer's shell exports the conventional
   * `LLM_API_KEY` that every other job reads. Both are the same key, and requiring the caller to
   * spell it one way is the kind of rule that gets worked around by pasting the key into a file.
   */
  readonly apiKeyEnv: readonly string[];
  /** How this vendor spells an image in a request body. */
  readonly imageDialect: ImageDialect;
  /** The temperature to name, or `null` for "name none and let the endpoint decide". */
  readonly temperature: number | null;
  /** The answer budget the first request carries. */
  readonly maxOutputTokens: number;
  /** The largest budget an escalation may name. */
  readonly answerBudgetCeiling: number;
  /**
   * How long one grading call may take before it is a failed row.
   *
   * A fact about the model, like the temperature. The first reading of this instrument ran on the
   * provider's 60-second default and lost **2 of 8 rows to `llm call timed out`** while the six that
   * answered averaged 49 seconds each: a default chosen for a chat turn is shorter than a vision
   * model that reasons about a figure before writing two integers. Named here rather than raised
   * everywhere, because the text jobs' 60 seconds is correct for them.
   */
  readonly timeoutMs: number;
}

/**
 * The endpoints this instrument knows how to talk to.
 *
 * `zhipu` and its reasons, field by field — the model is `glm-4.5v`, the current vision model on
 * `open.bigmodel.cn` with a documented 16,384-token answer cap, not `glm-4v-plus`, whose name points
 * at a 2024 release. The image is sent as bare base64 because that is what the vendor's own sample
 * sends: `{"url": img_base}` with no `data:` prefix, while this repository's default spelling is
 * OpenAI's `data:image/png;base64,…`. One of the two is refused by any given endpoint and neither
 * failure says which spelling was wrong, so the spelling is declared rather than assumed.
 *
 * `temperature: null` is a statement about evidence, not about taste. The endpoint documents a
 * default of 0.8 and a range this repository has not verified includes 0, and a value outside the
 * range is a 400 on every row. `null` is the one answer that cannot be refused; if a probe run
 * shows the endpoint accepts 0, the row changes in one place and the readings say so.
 *
 * The budget is 1,024 rather than the model's 16,384 because the reply is one JSON object with two
 * integers: a ceiling that large is not a decision anyone made, and `max_tokens` is a limit the
 * escalation can still raise to 16,384 if a reply is ever cut.
 */
export const JUDGE_ENDPOINTS: readonly JudgeEndpoint[] = [
  {
    name: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.5v',
    apiKeyEnv: ['ZHIPU_API_KEY', 'LLM_API_KEY'],
    imageDialect: 'bare-base64',
    temperature: null,
    // 4,096 and not 1,024, which is what the first full run was given. On this model the chain of
    // thought is billed inside `max_tokens`, so a cap sized for two integers is a cap on the
    // deliberation that precedes them: run 43979969822 lost 24 of 1,286 rows to replies that ended
    // mid-object at `{"chart_correctness": 2, "readability":`. A cap is a limit and not a
    // reservation — the endpoint bills what it writes, not what it may write — so raising it costs
    // nothing on the rows that never needed it and buys back the 1.9% that did.
    maxOutputTokens: 4096,
    answerBudgetCeiling: 16384,
    // Measured, not guessed: the six rows that answered took 49 s on average and two crossed 60 s.
    // Three minutes leaves room for the tail without making a stuck row cost a quarter of an hour.
    timeoutMs: 180_000,
  },
];

/** What a run needs to know about its grader: the provider, who it is, and how it is sampled. */
export interface JudgeResolved {
  readonly provider: LlmProvider;
  readonly grader: JudgeGrader;
  readonly temperature: number | null;
  /** Where the calls go, for the log line a dispatch reads before it pays for anything. */
  readonly baseUrl: string;
  readonly imageDialect: ImageDialect;
  /**
   * How long one call may take, when the row said.
   *
   * Absent for an injected provider: a fixture has no timeout of its own, and printing a number the
   * run is not using would be worse than printing that the provider's own default applies.
   */
  readonly timeoutMs?: number;
}

/**
 * The endpoint a run grades with.
 *
 * Resolution order is fixed and short: the name the caller asked for, then `JUDGE_ENDPOINT`, then
 * `zhipu`. `LLM_BASE_URL` and `LLM_MODEL` override the row rather than replacing it, because a
 * dispatch that points at a mirror or a differently named alias is asking about the same vendor,
 * and every other fact in the row — the image spelling, the temperature, the budget — still applies.
 *
 * A missing key is an error naming both variables rather than an empty `Authorization` header: the
 * header's failure is a 401 whose message is about the key, and the caller who forgot to export one
 * reads it as "the key is wrong". A local endpoint with no key is not a case this table serves, and
 * saying so is better than a row that pretends.
 */
export function resolveJudge(env: Record<string, string | undefined>, name?: string): JudgeResolved {
  const chosen = name ?? env.JUDGE_ENDPOINT ?? 'zhipu';
  const row = JUDGE_ENDPOINTS.find((endpoint) => endpoint.name === chosen);
  if (row === undefined) {
    throw new Error(
      `judge: no endpoint named "${chosen}": this repository declares ${JUDGE_ENDPOINTS.map((endpoint) => endpoint.name).join(', ')}`,
    );
  }
  const value = (variable: string): string | undefined => {
    const raw = env[variable];
    return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
  };
  const apiKey = row.apiKeyEnv.map(value).find((candidate) => candidate !== undefined);
  if (apiKey === undefined) {
    throw new Error(`judge: no key for the ${row.name} endpoint: set ${row.apiKeyEnv.join(' or ')}`);
  }
  const baseUrl = value('LLM_BASE_URL') ?? row.baseUrl;
  const model = value('LLM_MODEL') ?? row.model;
  const provider = createHttpProvider({
    baseUrl,
    model,
    apiKey,
    imageDialect: row.imageDialect,
    // The declaration the probe is about to check. Declared per row rather than asserted by the
    // dispatch, so that a row added without a vision model is a row nobody can add quietly.
    capabilities: {
      vision: true,
      maxOutputTokens: row.maxOutputTokens,
      answerBudgetCeiling: row.answerBudgetCeiling,
    },
    // A 429 on row 700 of 1,286 is a row that lost its grade, not an arm that lost its reading —
    // and this endpoint's key is the one whose quota this repository has already exhausted once.
    // A retry inside the provider is still one call to the meter, so `callsPerRow` stays one.
    retries: 3,
    retryDelayMs: 1000,
    timeoutMs: row.timeoutMs,
  });
  return {
    provider,
    grader: { endpoint: row.name, model },
    temperature: row.temperature,
    baseUrl,
    imageDialect: row.imageDialect,
    timeoutMs: row.timeoutMs,
  };
}

export interface JudgeEntryOptions {
  readonly argv?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly load?: LoadOptions;
  readonly provider?: LlmProvider;
  readonly temperature?: number | null;
  readonly readImage?: (path: string) => Promise<LlmImage>;
}

/**
 * The grader a run uses: the endpoint it declared, or the provider a caller handed over.
 *
 * An injected provider is named by its own `id` and `model` rather than by an endpoint row, because
 * that is what it is — the artifact then says `http`/`grade` and a reader can tell a run driven by a
 * caller from one driven by the table. It samples at zero, the value every fixture in this suite was
 * written at, unless the caller says otherwise.
 */
function gradeWith(options: JudgeEntryOptions, args: JudgeArgs): JudgeResolved {
  const injected = options.provider;
  if (injected !== undefined) {
    return {
      provider: injected,
      grader: { endpoint: injected.id, model: injected.model },
      temperature: options.temperature === undefined ? 0 : options.temperature,
      baseUrl: '',
      imageDialect: 'data-url',
    };
  }
  return resolveJudge(options.env ?? process.env, args.endpoint);
}

/**
 * Why a probe stopped the run, in the words that send the reader to the right place.
 *
 * Two refusals, deliberately not one. A call that never got an answer is a quota, a key scope or a
 * url, and the repair is to wait or to fix the deployment; a call that answered and did not name the
 * colour is an endpoint that cannot see, and the repair is another model. Reporting the first as the
 * second is how a 429 becomes "your vision model is blind".
 */
function probeRefusal(probe: ProbeReading): string | undefined {
  if (!probe.asked) {
    return `the endpoint never answered (${probe.answer}): that is a quota, a key scope or a url, not a verdict on what it can see`;
  }
  if (!probe.seen) {
    return `the endpoint did not see the probe image (it answered "${probe.answer}"), so it cannot grade a chart`;
  }
  return undefined;
}

/** The one line a dispatch reads before it pays for a render: who grades, and how it is sampled. */
function describeGrader(resolved: JudgeResolved): string {
  const where = resolved.baseUrl === '' ? '' : ` at ${resolved.baseUrl}`;
  const temperature = resolved.temperature === null ? 'unset' : String(resolved.temperature);
  // The timeout is on this line because it is the number the run is budgeted against: the first
  // reading lost two rows of eight to a 60-second default, and "how long may one call take" is the
  // first thing a reader of a timed-out row needs to know.
  const timeout = resolved.timeoutMs === undefined ? 'provider default' : `${String(resolved.timeoutMs / 1000)}s`;
  return (
    `text2vis: grading with ${resolved.grader.model} (${resolved.grader.endpoint})${where}, ` +
    `images ${resolved.imageDialect}, temperature ${temperature}, timeout ${timeout}`
  );
}

export async function entryJudge(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  options: JudgeEntryOptions = {},
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  try {
    const args = parseJudgeArgs(options.argv ?? []);
    const resolved = gradeWith(options, args);
    log(describeGrader(resolved));
    // Before the render artifact is even read, and before the meter: one call that proves the
    // endpoint can see. `--probe-only` exists so that a dispatch can spend that one call on its own,
    // which is the difference between learning in a minute that a base url or an image spelling is
    // wrong and learning it after 1,286 figures have been drawn.
    const probe = await probeVision(resolved.provider, resolved.temperature);
    const refusal = probeRefusal(probe);
    if (args.probeOnly) {
      log(
        refusal === undefined
          ? `text2vis: the probe answered "${probe.answer}", so this endpoint can see; nothing was graded`
          : `text2vis: ${refusal}; nothing was graded`,
      );
      return refusal === undefined ? 0 : 1;
    }
    if (refusal !== undefined) {
      log(`text2vis: ${refusal}`);
      return 1;
    }
    // The denominator comes from a render report, so a run without one has nothing to divide by —
    // but only after the probe, so that a misconfigured endpoint is reported as one on the cheapest
    // possible call rather than as a missing file.
    if (args.render === undefined) throw new Error('judge: --render <path> is required: the denominator comes from the render artifact');
    const render = await readRender(args.render);
    const metered = withCallCounter(resolved.provider);
    const { corpus, source, path } = await loadText2Vis(options.load);
    log(`text2vis: ${source} ${path}`);
    const inputs = profileInputs(corpus).filter((input) => familyOfLabel(input.label) !== undefined);
    const charts = chartJobs(inputs);
    const { jobs, skipped } = judgeJobs(inputs, charts, render.failed, args.png);
    // Two routes to one number: the artifact counted what its worker drew, and the corpus says which
    // rows this contract can lead with. A disagreement means one of them is about a different row
    // set, and grading either one would publish a mean over a population nobody can name.
    if (render.rendered !== jobs.length) {
      throw new Error(
        `judge: the render artifact counted ${String(render.rendered)} charts and this corpus produces ${String(jobs.length)}: they are not the same row set`,
      );
    }
    const selected = args.limit === undefined ? jobs : jobs.slice(0, args.limit);
    log(`text2vis: ${String(selected.length)} of ${String(jobs.length)} charts selected for grading (${String(render.rendered)} rendered)`);
    const verdicts = await judgeJobsWith(selected, {
      provider: metered.provider,
      temperature: resolved.temperature,
      ...(args.concurrency === undefined ? {} : { concurrency: args.concurrency }),
      ...(options.readImage === undefined ? {} : { readImage: options.readImage }),
    });
    const report = summarizeJudge(inputs.length, jobs.length, jobs, skipped, verdicts, metered.calls(), probe, resolved.grader);
    assertJudgeReport(report);
    if (args.json) log(JSON.stringify(report, null, 2));
    else for (const line of describeJudge(report)) log(line);
    if (args.artifact !== undefined) {
      const { mkdir, writeFile, rename } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(args.artifact), { recursive: true });
      await writeFile(`${args.artifact}.part`, `${JSON.stringify(report, null, 2)}\n`);
      await rename(`${args.artifact}.part`, args.artifact);
      log(`text2vis: wrote ${args.artifact}`);
    }
    return report.failed === 0 ? 0 : 1;
  } catch (error) {
    log(`text2vis: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

void entryJudge(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`), {
  argv: process.argv.slice(2),
}).then((code) => applyExitCode(code, process));
