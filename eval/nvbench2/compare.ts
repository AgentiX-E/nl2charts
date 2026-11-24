/**
 * Two arms, one corpus: whether the gap between them survives the noise.
 *
 * ## Why a mean is not a comparison
 *
 * Every reading in this repository is an average of per-question F1, and two averages cannot be
 * compared by subtraction. The standard error of a difference is driven by how many questions the two
 * arms answered *differently*, not by how far the two means are, so a 1-point gap over 250 questions
 * and a 1-point gap over 750 are not the same claim — and a gap produced by reordering three charts on
 * eleven questions is not a gap at all. The paired bootstrap answers the question that matters: if the
 * same 250 questions were drawn again, how often would the sign of the difference hold?
 *
 * Paired, not independent: both arms answered the same questions in the same order, and the vector the
 * arm writes to its artifact is aligned with the counted questions, so resampling question indices
 * once and taking both arms' values at those indices is the correct resample. Resampling each arm
 * separately would report the variance of the corpus rather than the variance of the difference, which
 * is the number that decides whether a prompt change is worth keeping.
 *
 * ## Determinism
 *
 * The resampler is a seeded PRNG, so the interval is a function of the two artifacts and nothing else:
 * two runs of this file print the same interval, which is what makes it quotable in a document. A
 * random seed would make a reported interval unreproducible, and an unreproducible interval is a
 * rhetorical device.
 *
 * ## What this cannot say
 *
 * It cannot rescue a comparison between different corpora, and it refuses to try: two artifacts carry
 * a digest of the questions they answered, and different digests are an error rather than a warning.
 * It also cannot say a change is *better for the product* — a wider ask costs more, and the cost is
 * not in the vector. The verdict is about the metric, and the price is read off the artifact's bill.
 */
import { readFileSync } from 'node:fs';
import { runIfEntry } from '../entry.js';

/** The parts of an artifact this file reads, checked one field at a time rather than cast. */
export interface ArmArtifact {
  readonly split: string;
  readonly model: string;
  readonly k: number;
  readonly ask?: number;
  readonly digest?: string;
  readonly perQuestion?: { readonly f1: Readonly<Record<string, readonly number[]>> };
  readonly cost?: { readonly yuan?: number };
}

/** A difference and the interval it was read at. */
export interface Comparison {
  readonly k: number;
  readonly base: number;
  readonly arm: number;
  readonly delta: number;
  /** The 2.5th and 97.5th percentile of the resampled difference, as fractions. */
  readonly low: number;
  readonly high: number;
  readonly questions: number;
  readonly resamples: number;
  /** True when the interval excludes zero, which is the only case this file calls a difference. */
  readonly separated: boolean;
}

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One artifact, or the sentence saying which field made it unusable.
 *
 * An artifact written before the per-question vector existed is refused rather than compared on its
 * mean: the mean is there, and reading it would silently downgrade this file to the subtraction it
 * exists to replace.
 */
export function artifactOf(raw: unknown, name: string): ArmArtifact {
  if (!isRecordLike(raw)) throw new Error(`${name} is not an artifact object`);
  const { split, model, k } = raw;
  if (typeof split !== 'string') throw new Error(`${name} names no split`);
  if (typeof model !== 'string') throw new Error(`${name} names no model`);
  if (typeof k !== 'number') throw new Error(`${name} names no scoring width`);
  const per = raw['perQuestion'];
  if (!isRecordLike(per) || !isRecordLike(per['f1'])) {
    throw new Error(`${name} carries no per-question vector, so it can only be subtracted; re-run that arm`);
  }
  const f1: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(per['f1'])) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'number')) {
      throw new Error(`${name} has a per-question vector at k=${key} that is not a list of numbers`);
    }
    f1[key] = value as number[];
  }
  const digest = raw['digest'];
  if (digest !== undefined && typeof digest !== 'string') throw new Error(`${name} has a digest that is not a string`);
  const ask = raw['ask'];
  if (ask !== undefined && typeof ask !== 'number') throw new Error(`${name} has an ask that is not a number`);
  const cost = raw['cost'];
  if (cost !== undefined && !isRecordLike(cost)) throw new Error(`${name} has a bill that is not an object`);
  const yuan = isRecordLike(cost) ? cost['yuan'] : undefined;
  if (yuan !== undefined && typeof yuan !== 'number') throw new Error(`${name} has a bill in yuan that is not a number`);
  return { split, model, k, ...(ask === undefined ? {} : { ask }), ...(digest === undefined ? {} : { digest }),
    perQuestion: { f1 }, ...(yuan === undefined ? {} : { cost: { yuan } }) };
}

/** The per-question F1 vector at one width, or the sentence saying the artifact does not have it. */
export function vectorOf(artifact: ArmArtifact, k: number, name: string): readonly number[] {
  const vector = artifact.perQuestion?.f1[String(k)];
  if (vector === undefined) throw new Error(`${name} was scored at ${Object.keys(artifact.perQuestion?.f1 ?? {}).join(', ')}, not at k=${k}`);
  return vector;
}

/** A seeded PRNG (mulberry32): the interval has to be the same tomorrow to be worth quoting. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (values: readonly number[], at?: readonly number[]): number => {
  const length = at === undefined ? values.length : at.length;
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += values[at === undefined ? index : at[index]!] as number;
  }
  return length === 0 ? 0 : sum / length;
};

/**
 * The paired bootstrap: resample the questions, keep the pairing, and look at the sign.
 *
 * Percentile interval rather than a normal approximation, because per-question F1 is bounded, clumped
 * at zero for the questions nobody got, and not remotely normal. With 2,000 resamples the percentile
 * interval is stable to about a tenth of a point, which is finer than any difference this repository
 * has acted on.
 */
export function compare(base: readonly number[], arm: readonly number[], options: {
  readonly k: number;
  readonly resamples?: number;
  readonly seed?: number;
}): Comparison {
  if (base.length !== arm.length) {
    // Almost always a failed row: an arm that lost calls to a deadline scores the questions it did
    // answer and counts the rest, so its vector is shorter and a paired difference would divide the
    // two arms by different denominators. The fix is not arithmetic, it is the re-dispatch — the
    // answers already bought are replayed from the store, and only the failures are paid for again.
    throw new Error(`the vectors are ${String(base.length)} and ${String(arm.length)} questions: an arm `
      + 'that failed to answer some rows scores the rest and counts the failures, so the two arms are '
      + 'divided by different denominators and no question is paired — re-dispatch the short arm, where '
      + 'the answers already bought are replayed and only the failed rows are paid for');
  }
  if (base.length === 0) throw new Error('the vectors are empty, so there is nothing to compare');
  const resamples = options.resamples ?? 2000;
  if (!Number.isInteger(resamples) || resamples < 100) throw new Error(`resamples ${String(resamples)} is not a whole number of at least 100`);
  const baseMean = mean(base);
  const armMean = mean(arm);
  const random = seeded(options.seed ?? 20261124);
  const indexes = new Array<number>(base.length);
  const deltas: number[] = [];
  for (let draw = 0; draw < resamples; draw += 1) {
    for (let at = 0; at < indexes.length; at += 1) {
      indexes[at] = Math.floor(random() * base.length);
    }
    deltas.push(mean(arm, indexes) - mean(base, indexes));
  }
  deltas.sort((left, right) => left - right);
  const at = (quantile: number): number => deltas[Math.min(deltas.length - 1, Math.floor(quantile * deltas.length))] as number;
  const low = at(0.025);
  const high = at(0.975);
  return {
    k: options.k,
    base: baseMean,
    arm: armMean,
    delta: armMean - baseMean,
    low,
    high,
    questions: base.length,
    resamples,
    separated: low > 0 || high < 0,
  };
}

/** The comparison as a line a log or a document can quote. */
export function comparisonLine(comparison: Comparison): string {
  const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
  const interval = `[${percent(comparison.low)}, ${percent(comparison.high)}]`;
  const verdict = comparison.separated ? 'separated from zero' : 'inside the noise';
  return `F1@${String(comparison.k)}: ${percent(comparison.base)} → ${percent(comparison.arm)} `
    + `(${comparison.delta >= 0 ? '+' : ''}${percent(comparison.delta)}, 95% ${interval}, ${verdict}) `
    + `over ${String(comparison.questions)} paired questions, ${String(comparison.resamples)} resamples`;
}

/**
 * Both artifacts, or the sentence saying why they cannot be paired.
 *
 * The digest check is here rather than in `compare` because the vectors alone cannot tell a
 * reordering from a different corpus: 250 numbers in the wrong order are still 250 numbers.
 */
export function pairOf(baseRaw: unknown, armRaw: unknown, k: number, options: {
  readonly resamples?: number;
  readonly seed?: number;
} = {}): Comparison {
  const base = artifactOf(baseRaw, 'the base artifact');
  const arm = artifactOf(armRaw, 'the arm artifact');
  if (base.digest !== undefined && arm.digest !== undefined && base.digest !== arm.digest) {
    throw new Error(`the artifacts answered different questions (${base.digest.slice(0, 12)} vs ${arm.digest.slice(0, 12)}), so no question is paired`);
  }
  if (base.split !== arm.split) {
    throw new Error(`the artifacts name different splits (${base.split} vs ${arm.split})`);
  }
  return compare(vectorOf(base, k, 'the base artifact'), vectorOf(arm, k, 'the arm artifact'), {
    k,
    ...(options.resamples === undefined ? {} : { resamples: options.resamples }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
}

/** Read two artifacts and say whether the difference is one. */
export function main(argv: readonly string[]): number {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const basePath = value('--base');
  const armPath = value('--arm');
  if (basePath === undefined || armPath === undefined) throw new Error('--base and --arm name the two artifacts to compare');
  const k = Number(value('--k') ?? '3');
  if (!Number.isInteger(k) || k <= 0) throw new Error(`--k ${String(value('--k'))} is not a positive whole number`);
  const resamples = value('--resamples') === undefined ? undefined : Number(value('--resamples'));
  const base = JSON.parse(readFileSync(basePath, 'utf8')) as unknown;
  const arm = JSON.parse(readFileSync(armPath, 'utf8')) as unknown;
  const comparison = pairOf(base, arm, k, resamples === undefined ? {} : { resamples });
  process.stdout.write(`${comparisonLine(comparison)}\n`);
  // Exit zero either way: a difference that does not survive the interval is a *finding*, not a
  // failure, and a tool that exits 1 for a normal result is a tool that stops being read.
  return 0;
}

runIfEntry(process.argv[1], import.meta.url, () => main(process.argv.slice(2)));
