/**
 * The base model, as evidence rather than as a name.
 *
 * Every other coordinate in this harness is a fact about the run: the corpus is a digest of the
 * questions, the harness is three numbers, the arms are a list. The generator was the one
 * coordinate nobody could read, and it was assumed three times over.
 *
 * - `model` is the string the run asked for. On 2026-11-08 both Mini-Dev runs asked for
 *   `deepseek-chat` and all 6,448 answers came back named `deepseek-flash`.
 * - `servedModels` is the string the endpoint reported. It catches that rename, and it catches
 *   nothing else: an endpoint that keeps the name and changes the weights reports the same word,
 *   and every later run is filed as a re-measurement of a generator it has never met.
 * - The pool of four runs quoted in `docs/benchmarks.md` averages readings taken hours apart, and
 *   averaging them is only about one generator if they were one.
 *
 * So the third reading is behavioural: a handful of fixed questions, asked twice each at
 * temperature zero, hashed. Two properties make it a fingerprint rather than a screenshot:
 *
 * 1. **Asked twice.** One draw cannot tell a change of weights from a change of draw. When the two
 *    draws of a probe disagree, the endpoint is sampling on an identical request, and the digest
 *    is then a draw and not a fingerprint — `stable: false` says so, and the gate prints it
 *    instead of failing on it.
 * 2. **The probe set is hashed too.** Editing a question would change the digest for a reason that
 *    is not the model, and a pin that silently moved with the questions would be a pin that
 *    enforced nothing. `probeSet` is the digest of the probes themselves.
 *
 * What this does not claim: the digest does not name a model, and a matching digest is not a proof
 * of the same weights — two different models can agree on three short answers. It is a one-sided
 * test. A change proves something changed; no change proves nothing changed on these three
 * questions, which is the strongest statement three questions can support and infinitely stronger
 * than the assumption it replaces.
 *
 * The three questions are chosen to be short, answerable without a schema, and hard enough to
 * separate models by their *wording* even when they agree on the value: an answer of `17`, `17.`
 * and `The 7th prime is 17.` are three different fingerprints of three different generators. The
 * letter count is there because a weaker base gets it wrong, which is a capability difference
 * showing up in the digest rather than in someone's opinion of the model.
 *
 * Price: six calls of a few dozen tokens each, reported in the artifact beside every other cost.
 * A run of 1,532 questions spends 1,532 calls on one arm; this spends six, once, to be able to say
 * which generator answered the other 1,532.
 */
import { createHash } from 'node:crypto';
import { withCallCounter } from '@agentix-e/nl2charts-ai';
import type { LlmProvider } from '@agentix-e/nl2charts-ai';
import { describeError } from '../errors.js';

/** One fixed question, and the id its answer is hashed under. */
export interface FingerprintProbe {
  readonly id: string;
  readonly ask: string;
}

/**
 * The probe set.
 *
 * Ids are part of the digest and must never be renumbered to fix a typo in an id: the id is how a
 * changed digest is attributed to a probe, and renaming one turns "the model changed" into
 * "two probes changed and one is new".
 */
export const FINGERPRINT_PROBES: readonly FingerprintProbe[] = [
  {
    id: 'seventh-prime',
    ask: 'Which number is the 7th prime? Answer with the number only.',
  },
  {
    id: 'letter-count',
    ask: 'How many times does the letter s appear in the word assesses? Answer with the number only.',
  },
  {
    id: 'one-seventh',
    ask: 'Write the first eight digits after the decimal point of one seventh. Digits only, no decimal point and no spaces.',
  },
];

/**
 * What one answer of one probe carried.
 *
 * The model name travels with the text because the endpoint is allowed to answer as a different
 * base on the second draw, and that is a fact about the run rather than about the digest.
 */
export interface ProbeReply {
  readonly text: string;
  readonly model: string;
}

/** Every reply to one probe, in the order they arrived. */
export interface ProbeDraw {
  readonly id: string;
  readonly replies: readonly ProbeReply[];
}

/**
 * The context a reading is taken in: which probes were asked, and what they cost.
 *
 * Separate from the reading because `readFingerprint` is a pure function over text: a test that
 * wants to know what the digest of three fixed answers is should not have to build a meter, and a
 * meter that lived inside the reading could not be checked against the calls it claims.
 *
 * `probes` is here rather than derived from the answers for the reason the test that found it
 * states: a probe that failed to answer is missing from the draws, and deriving the question set
 * from what came back would publish the digest of a *smaller* set under the *standard* set's
 * fingerprint — a reading that looks comparable with the pin while being about other questions.
 */
export interface FingerprintContext {
  readonly probes?: readonly FingerprintProbe[];
  readonly calls?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  /** Answers that arrived without a usage block. */
  readonly unbilled?: number;
  readonly failures?: readonly string[];
}

/**
 * The reading.
 *
 * `digest` is `''` when no probe answered: an empty digest is not the digest of an empty answer
 * set, it is the statement that this run has no fingerprint, and every consumer treats the two the
 * same way — nothing is compared against a pin.
 */
export interface BaseFingerprint {
  readonly digest: string;
  /** Probes that produced at least one non-empty answer. A digest over 2 of 3 is about 2 questions. */
  readonly probes: number;
  /** Probes that were asked, answered or not. The denominator of `probes`, and of the sentence below. */
  readonly total: number;
  /** How many times each probe was asked. One draw is a screenshot, not a fingerprint. */
  readonly draws: number;
  /** Whether every usable probe answered identically on every draw. */
  readonly stable: boolean;
  /** Probes whose two draws disagreed — the endpoint sampled on an identical request. */
  readonly unstable: readonly string[];
  /** Probes that answered nothing at all on every draw. */
  readonly empty: readonly string[];
  /** Every base name the endpoint gave itself, sorted. More than one is a base that changed mid-probe. */
  readonly bases: readonly string[];
  /** The digest of the questions, so a changed probe is not read as a changed model. */
  readonly probeSet: string;
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly unbilled: number;
  readonly failures: readonly string[];
}

/**
 * The answer with transport noise removed and nothing else.
 *
 * Whitespace runs collapse and the ends are trimmed, because an endpoint that appends a newline
 * has answered the same thing. Case, punctuation and wording are kept: `17`, `17.` and `Seventeen`
 * are three answers, and normalising any of them away would delete the signal this file exists to
 * read.
 */
export function normaliseAnswer(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 16 hex characters, the same width as the corpus digest, for the same reason: it is read by eye. */
function shortDigest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * The digest of the questions themselves.
 *
 * Not the digest of `FINGERPRINT_PROBES` as JSON: that would move if the list were ever widened
 * with a field that does not reach the endpoint, and a probe set that changes for a reason nobody
 * sent to a model is the failure this field exists to prevent.
 */
export function probeSetDigest(probes: readonly FingerprintProbe[] = FINGERPRINT_PROBES): string {
  return shortDigest(probes.map((probe) => `${probe.id}\u0000${probe.ask}`));
}

/**
 * The reading, from replies alone.
 *
 * Sorting by id makes the digest independent of the order the probes were asked in, because the
 * order is an implementation detail of the loop and the digest is a claim about the endpoint.
 */
export function readFingerprint(draws: readonly ProbeDraw[], context: FingerprintContext = {}): BaseFingerprint {
  const ordered = [...draws].sort((left, right) => left.id.localeCompare(right.id));
  const lines: string[] = [];
  const unstable: string[] = [];
  const empty: string[] = [];
  const bases = new Set<string>();
  let probes = 0;
  let widest = 0;
  for (const draw of ordered) {
    widest = Math.max(widest, draw.replies.length);
    const answers = draw.replies.map((reply) => normaliseAnswer(reply.text));
    const usable = answers.filter((answer) => answer !== '');
    if (usable.length === 0) {
      empty.push(draw.id);
      continue;
    }
    probes += 1;
    // The first non-empty answer is what the digest hashes. The empty ones are not hashed and are
    // not ignored either: a probe that answered on one draw and not the next is unstable below.
    lines.push(`${draw.id}=${usable[0] as string}`);
    if (answers.some((answer) => answer !== answers[0])) unstable.push(draw.id);
    for (const reply of draw.replies) if (normaliseAnswer(reply.text) !== '') bases.add(reply.model);
  }
  return {
    digest: lines.length === 0 ? '' : shortDigest(lines),
    probes,
    total: (context.probes ?? FINGERPRINT_PROBES).length,
    draws: widest,
    stable: unstable.length === 0 && probes > 0,
    unstable,
    empty,
    bases: [...bases].sort(),
    probeSet: probeSetDigest(context.probes ?? FINGERPRINT_PROBES),
    calls: context.calls ?? 0,
    promptTokens: context.promptTokens ?? 0,
    completionTokens: context.completionTokens ?? 0,
    unbilled: context.unbilled ?? 0,
    failures: [...(context.failures ?? [])],
  };
}

export interface ProbeOptions {
  /** Draws per probe. Below two there is nothing to check the first draw against. */
  readonly draws?: number;
  readonly probes?: readonly FingerprintProbe[];
}

/**
 * Ask the probe set, twice each, and read the answers.
 *
 * No token cap, deliberately. A reasoning model spends its budget thinking and answers a capped
 * request with an empty string and `finish_reason: length`; a preflight already learned that a cap
 * reports a working endpoint as a broken one, and here it would report a working model as an empty
 * probe. Six uncapped calls of a three-line question is the honest price.
 *
 * A failed call is recorded and the rest of the probes are still asked: the fingerprint is one
 * sentence in an artifact that took an hour to produce, and an outage on the second draw must not
 * turn a run into a stack trace. The failure reaches the gate through `failures` and `probes`.
 */
export async function probeBase(provider: LlmProvider, options: ProbeOptions = {}): Promise<BaseFingerprint> {
  const draws = Math.max(1, Math.floor(options.draws ?? 2));
  const probes = options.probes ?? FINGERPRINT_PROBES;
  const counter = withCallCounter(provider);
  const failures: string[] = [];
  const collected: ProbeDraw[] = [];
  for (const probe of probes) {
    const replies: ProbeReply[] = [];
    for (let draw = 0; draw < draws; draw += 1) {
      try {
        const reply = await counter.provider.complete({
          messages: [{ role: 'user', content: probe.ask }],
          temperature: 0,
          purpose: 'probe',
        });
        replies.push({ text: reply.text, model: reply.model });
      } catch (error) {
        failures.push(`${probe.id}: ${describeError(error)}`);
      }
    }
    collected.push({ id: probe.id, replies });
  }
  const usage = counter.usage();
  return readFingerprint(collected, {
    probes,
    calls: counter.calls(),
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    unbilled: usage.unbilled,
    failures,
  });
}

/**
 * One line for the run log.
 *
 * Written as a sentence about what happened rather than as a key and a value, because the failure
 * this field exists to prevent was invisible: a run that printed `model: deepseek-chat` and a
 * digest nobody read is exactly the state that produced 6,448 answers from another base.
 */
export function fingerprintLine(fingerprint: BaseFingerprint): string {
  const base = fingerprint.bases.length === 0 ? 'no base named' : fingerprint.bases.join('+');
  if (fingerprint.probes === 0) {
    const why = fingerprint.failures.length === 0 ? 'every probe answered nothing' : fingerprint.failures[0] as string;
    return `base fingerprint: none — 0 of ${String(fingerprint.total)} probes answered (${why})`;
  }
  const state =
    fingerprint.unstable.length === 0
      ? 'stable'
      : `unstable on ${fingerprint.unstable.join(', ')}, so this digest is a draw and not a fingerprint`;
  return (
    `base fingerprint: ${fingerprint.digest} over ${String(fingerprint.probes)} probe(s) x ${String(fingerprint.draws)} draws, ` +
    `${fingerprint.probes === fingerprint.total ? '' : `of ${String(fingerprint.total)} `}${state}, ` +
    `served by ${base}, ${String(fingerprint.calls)} calls`
  );
}
