import { countNamedConditions } from './audit.js';
import { countSteps } from './decompose.js';
import { parseChoiceToken } from './select.js';

/**
 * What a reply looked like, as opposed to what it said.
 *
 * Every reader in this package — `extractSql`, `parseDecomposed`, `applySelection`,
 * `countNamedConditions` — makes an assumption about the shape of a reply, and every one of
 * those assumptions was calibrated on a model this repository has benchmarked. A user who
 * swaps the backbone keeps the code and loses the calibration, and the loss is silent: a
 * selector reply that says "Option 2" is not an error, it is an unanswered call, and the
 * arm falls back to candidate one while the artifact reports a lower score.
 *
 * A shape is the cheapest thing that can be observed about a reply: it costs no call, it
 * needs no label, and it is the one signal that is available on the very first request a
 * deployment makes. Counting it turns "the model may not follow the format" from a hope
 * into a number a report can carry.
 */
export interface ReplyShape {
  /** The reply carried a fenced block, which is what every statement reader looks for. */
  readonly fenced: boolean;
  /** The whole reply reduced to one decorated choice, which is what the selector reads. */
  readonly index: boolean;
  /** Step lines written, which is what the decomposition prompt asks for. */
  readonly steps: number;
  /** Omissions named, which is what the audit turn asks for. */
  readonly named: number;
}

/** One reply, read for shape. Pure text in, counts out — no provider, no candidate list. */
export function replyShape(text: string): ReplyShape {
  return {
    fenced: /```/.test(text),
    index: parseChoiceToken(text) !== null,
    steps: countSteps(text),
    named: countNamedConditions(text),
  };
}

/**
 * How reliably a dimension held across the replies that were seen.
 *
 * `sometimes` is deliberately the answer for a small sample rather than a third state
 * meaning "partly": one reply cannot distinguish a model that always fences from one that
 * fenced once, and reporting either as a rate would be a claim the evidence does not carry.
 */
export type Compliance = 'always' | 'sometimes' | 'never';

/**
 * A model's format behaviour, aggregated over the replies of one arm or one deployment.
 *
 * Carried beside the score rather than folded into it. A score is a claim about statements;
 * a profile is a claim about the channel that carries them, and the two fail differently:
 * a profile that says `fenced: never` predicts a collapse before it happens, while a score
 * can only report it afterwards.
 */
export interface FormatProfile {
  readonly replies: number;
  readonly fenced: Compliance;
  readonly index: Compliance;
  readonly steps: Compliance;
  readonly named: Compliance;
}

/**
 * Replies needed before any dimension is called `always` or `never`.
 *
 * Three, because the smallest sample that can hold a rate is the smallest sample that can
 * refute one: with two replies, "always" and "sometimes" differ by a single observation,
 * and a deployment that changed its verdict on one case would thrash between strategies.
 */
const MIN_SAMPLES = 3;

/**
 * The share of replies a dimension must hold to be called `always`.
 *
 * Nine in ten, because the cost of a false `always` is asymmetric: a selector that answers
 * three times in four looks healthy in aggregate and still leaves a quarter of the cases
 * decided by candidate order, which is the failure this instrument exists to catch.
 */
const ALWAYS_SHARE = 0.9;

function compliance(hits: number, replies: number): Compliance {
  if (replies < MIN_SAMPLES) return 'sometimes';
  if (hits === 0) return 'never';
  return hits / replies >= ALWAYS_SHARE ? 'always' : 'sometimes';
}

/**
 * Aggregate reply shapes into a profile.
 *
 * An empty sample is `sometimes` on every dimension for the same reason a small one is: the
 * honest reading of no evidence is not "the model never fences".
 */
export function formatProfile(shapes: readonly ReplyShape[]): FormatProfile {
  const replies = shapes.length;
  return {
    replies,
    fenced: compliance(shapes.filter((shape) => shape.fenced).length, replies),
    index: compliance(shapes.filter((shape) => shape.index).length, replies),
    steps: compliance(shapes.filter((shape) => shape.steps > 0).length, replies),
    named: compliance(shapes.filter((shape) => shape.named > 0).length, replies),
  };
}
