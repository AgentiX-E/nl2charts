/**
 * The edge of the free-rule space, priced in one reading.
 *
 * `bench:bird:consensus` answers a narrower question: which of the *shipped* rules — `first`,
 * `shortest`, `modal` — would have scored what on this artifact. That reading closed the fourth
 * call (`the fourth call buys less than the split can resolve`), and it left a question it was
 * never built to answer: **is there a rule nobody has written down that beats the one we ship?**
 * Answering that by dispatch costs a run per rule — 1,532 questions times four calls for a
 * candidate that might be worse than the one already in production.
 *
 * This harness answers it for nothing, because every rule below is a function of two fields the
 * artifact already carries: the statement text and a fingerprint of the result set.
 *
 * ## What the variants are, and why these ones
 *
 * The list is not a search over syntax; it is the closure of the three hypotheses the readings so
 * far actually support.
 *
 * - **Agreement.** The result set the most candidates returned is the answer a voting arm gives,
 *   and `modal` prices it. A pool where two of three agree is the case in which consensus should
 *   be strongest, so the family continues: `modal-then-shortest` keeps the majority group's
 *   shortest statement where a strict majority exists and falls back to the shipped rule
 *   elsewhere, and `majority-longest` takes the other side of the same tie-break.
 * - **Length.** `shortest` ranks by characters, and characters are a property of identifier
 *   naming as much as of the statement's shape: a wrong `SELECT max(x)` is shorter than a right
 *   `SELECT max("Percent (%) Eligible Free (K-12)")` for reasons that have nothing to do with
 *   which one answers the question. Six measures of the same statement test that: whitespace
 *   collapsed, tokens counted, identifiers counted, quoted spans elided, aliases elided, and the
 *   second-shortest slot. `longest` is the far end of the axis, kept because a measure that
 *   prefers the wrong end is how a reader learns the axis is the wrong axis.
 * - **Structure.** Three rules read the statements as a set instead of as a list: `central` keeps
 *   the statement with the highest total token overlap with the rest (what a pool "mostly says"),
 *   `superset` keeps the one whose tokens cover the most of the others' (which is what an omitted
 *   clause looks like from the text side), and `clauses-then-shortest` prefers the statement with
 *   the most of `join`/`where`/`group by`/`having`/`order by`/`limit` present, because the way a
 *   wrong statement is wrong is usually that a clause is missing.
 *
 * ## The criterion, written before the reading
 *
 * A variant earns a dispatch only if it clears two bars, and both are stated here so that the
 * reading cannot choose them afterwards:
 *
 * 1. **It scores above the shipped rule.** Ties are not findings: a rule that reads the same
 *    cases differently and scores the same has bought a rewrite and nothing else.
 * 2. **The paired difference survives the family.** This harness prices many variants on one
 *    artifact, so the smallest p-value across them is the one most likely to be noise. The
 *    threshold printed beside the verdict is `0.05 / variants`, the Bonferroni bound for the
 *    family, and a lead that only clears the uncorrected 0.05 is reported as unresolved rather
 *    than adopted. A tool that printed the raw p would turn a search into a discovery.
 *
 * Neither bar is a judgement about the rule's *idea*: a variant that loses here loses on this
 * artifact's pools, and a different pool can make it win. What the verdict does say is that a
 * second dispatch is not the next thing to spend on.
 *
 * ## What this harness refuses to do
 *
 * - It does not implement `shortest`, `modal` or `first`. Those three are read through
 *   `consensus.pick`, which is itself held to `chooseCandidateByRule` by a test, so a variant
 *   that outranks the shipped rule has outranked the thing the pipeline actually runs. A second
 *   copy of the three shipped rules here would be a second answer to one question — the mistake
 *   that made `shortest` pick a blank statement for a while.
 * - It does not exclude a question a variant cannot score. A variant with no input has picked
 *   nothing, and the miss is counted, so every column shares one denominator. `unavailable`
 *   reports the count beside the score, because "could not read" and "read it and got it wrong"
 *   are different findings.
 * - It does not price `model` or `oracle`. Those are the arm's own score and its ceiling, both
 *   already owned by `consensus.ts` and `pool.ts`, and a third implementation of either is a
 *   third opinion about one number.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { eligibleIndices, pair, pick } from './consensus.js';
import type { Pairing, Recorded } from './consensus.js';

/**
 * The slots a rule may choose from: the candidates that returned something.
 *
 * Read from the instrument rather than restated: "which candidates are eligible" is the one
 * predicate all sixteen rules share, and a second copy of it here would be a second answer to the
 * question that decides every score in the file.
 */
const eligible = eligibleIndices;

/**
 * A statement's text, or `undefined` when there is none to rank.
 *
 * Two things produce `undefined` and they are the same thing to a rule: a statement the artifact
 * did not keep, and a statement that wrote nothing. Neither can be the shortest answer — an empty
 * statement is shorter than every real one, and ranking it by its length once made `shortest` pick
 * the candidate that wrote nothing — and neither can be the longest, which is why this returns
 * `undefined` rather than a number at either end. A sentinel that meant "very long" would be a
 * second rule about blank statements hiding inside the first.
 */
function textOf(sql: string | undefined): string | undefined {
  const text = sql?.trim() ?? '';
  return text.length === 0 ? undefined : text;
}

/** The slots whose statement there is text to read. Empty when none has any. */
function rankable(candidates: readonly Recorded[], subset: readonly number[]): readonly number[] {
  return subset.filter((index) => textOf(candidates[index]?.sql) !== undefined);
}

/**
 * The slots a text rule may choose among: those with a statement, or every eligible slot when none
 * has one.
 *
 * The token rules need a set to compare, and a pool where nothing was written still has to answer:
 * every statement then has zero tokens, and the earliest slot is the only answer that does not
 * depend on an accident of iteration order.
 */
function textPool(candidates: readonly Recorded[]): readonly number[] {
  const ranked = rankable(candidates, eligible(candidates));
  return ranked.length === 0 ? eligible(candidates) : ranked;
}

const WORDS = /[A-Za-z_][A-Za-z0-9_$]*|\d+(?:\.\d+)?|[<>=!]+|[(),*;.]/g;

/** Tokens of a statement: identifiers, numbers, comparisons and punctuation. */
function tokens(text: string): readonly string[] {
  return text.match(WORDS) ?? [];
}

/** The slot with the smallest measure, earliest on a tie, skipping a statement there is no text for. */
function smallest(candidates: readonly Recorded[], subset: readonly number[], metric: (text: string) => number): number {
  if (subset.length === 0) return -1;
  let best = subset[0] as number;
  let bestValue = Number.POSITIVE_INFINITY;
  for (const index of subset) {
    const text = textOf(candidates[index]?.sql);
    if (text === undefined) continue;
    const value = metric(text);
    if (value < bestValue) {
      bestValue = value;
      best = index;
    }
  }
  return best;
}

/** The slot with the largest measure, earliest on a tie, skipping a statement there is no text for. */
function largest(candidates: readonly Recorded[], subset: readonly number[], metric: (text: string) => number): number {
  if (subset.length === 0) return -1;
  let best = subset[0] as number;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const index of subset) {
    const text = textOf(candidates[index]?.sql);
    if (text === undefined) continue;
    const value = metric(text);
    if (value > bestValue) {
      bestValue = value;
      best = index;
    }
  }
  return best;
}

/** How many candidates returned each distinct result. */
function agreement(candidates: readonly Recorded[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.fingerprint === undefined) continue;
    counts.set(candidate.fingerprint, (counts.get(candidate.fingerprint) ?? 0) + 1);
  }
  return counts;
}

/** The slots inside a result group of at least `atLeast` members, or the whole eligible set. */
function majority(candidates: readonly Recorded[], atLeast: number): readonly number[] {
  const counts = agreement(candidates);
  const group = eligible(candidates).filter((index) => {
    const fingerprint = candidates[index]?.fingerprint;
    return fingerprint !== undefined && (counts.get(fingerprint) as number) >= atLeast;
  });
  return group.length === 0 ? eligible(candidates) : group;
}

/**
 * The modal result, unless the modal group answered a listing with one row.
 *
 * A port of `widerIndex` in `packages/ai/src/select.ts`, and the one variant here that cannot be
 * read from text or agreement alone: it needs how many rows each candidate returned and how wide
 * one row is. Both are recorded per candidate, which is why this rule could be priced at all — and
 * a candidate whose record predates the fields is `-1` (no input) rather than a guessed shape.
 *
 * The two facts it turns on are stated once, here, because the arm and the library have to mean
 * the same thing by them: a single-row result is what an aggregate looks like while the question
 * asked for rows, and none of `first`, `shortest` or `modal` can see that the loser of the vote
 * returned four hundred rows the winner did not. "A single row" is about the group's *distinct*
 * rows, so the thinnest member decides it — `fingerprint` collapses duplicate tuples, and a
 * fanned-out join returns the same six rows once and six times.
 */
function wider(candidates: readonly Recorded[]): number {
  const eligible = eligibleIndices(candidates);
  if (eligible.length === 0) return -1;
  if (eligible.some((index) => candidates[index]?.rows === undefined || candidates[index]?.columns === undefined)) return -1;
  const order: string[] = [];
  const members = new Map<string, number[]>();
  for (const index of eligible) {
    // Unknown is its own group rather than a shared one: two candidates whose result the artifact
    // did not fingerprint are two candidates nobody can say agree. `-1` is returned above whenever
    // any of them lacks the shape, so this only guards the fingerprint.
    const key = candidates[index]?.fingerprint ?? `unknown:${String(index)}`;
    const group = members.get(key);
    if (group === undefined) {
      members.set(key, [index]);
      order.push(key);
    } else group.push(index);
  }
  let bestKey = order[0] as string;
  for (const key of order) {
    if ((members.get(key) as number[]).length > (members.get(bestKey) as number[]).length) bestKey = key;
  }
  const modal = members.get(bestKey) as number[];
  const modalRows = Math.min(...modal.map((index) => candidates[index]?.rows as number));
  if (modalRows > 1) return modal[0] as number;
  const modalColumns = candidates[modal[0] as number]?.columns as number;
  let best = modal[0] as number;
  let bestRows = modalRows;
  for (const index of eligible) {
    if (modal.includes(index)) continue;
    const candidate = candidates[index] as Recorded;
    if ((candidate.columns as number) < modalColumns) continue;
    if ((candidate.rows as number) > bestRows) {
      bestRows = candidate.rows as number;
      best = index;
    }
  }
  return best;
}

/**
 * `first` with the sources offered in a named order.
 *
 * An ordering is the whole of what `first` reads, so a pool's *arrangement* is a lever that costs
 * nothing and had never been priced: the shipped trio names `inline+evidence` first, and the
 * template's pool names it first too, while the template was the source that answered most often.
 * Six arrangements of three sources is a reading, not a search — and one of the six reproduces the
 * shipped `first` exactly, which is the check that the arrangement costs nothing but a preference.
 *
 * A source the case did not produce is skipped rather than blocking: a pool is three prompts and a
 * question may come back with two statements, so the order is a preference over what exists.
 */
function firstBy(order: readonly string[]): (candidates: readonly Recorded[]) => number {
  return (candidates) => {
    const eligible = eligibleIndices(candidates);
    for (const source of order) {
      for (const index of eligible) if (candidates[index]?.source === source) return index;
    }
    return (eligible[0] as number) ?? -1;
  };
}

/** Every ordering of the given items, so a preference cannot be read off one arrangement. */
export function orderings(items: readonly string[]): readonly (readonly string[])[] {
  if (items.length === 0) return [[]];
  const head = items[0] as string;
  const out: (readonly string[])[] = [];
  for (const tail of orderings(items.slice(1))) {
    for (let position = 0; position <= tail.length; position += 1) {
      out.push([...tail.slice(0, position), head, ...tail.slice(position)]);
    }
  }
  return out;
}

const chars = (text: string): number => text.length;
const nonspace = (text: string): number => text.replace(/\s+/g, '').length;
const tokenCount = (text: string): number => tokens(text).length;
const identifierCount = (text: string): number => (text.match(/[A-Za-z_][A-Za-z0-9_$]*/g) ?? []).length;
const unquotedChars = (text: string): number => text.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').length;
const unaliasedChars = (text: string): number => text.replace(/\s+as\s+[A-Za-z_][A-Za-z0-9_$]*/gi, '').length;

/** The clauses a statement carries, in the order a reader would look for them. */
const CLAUSES: readonly string[] = [' join ', ' where ', ' group by ', ' having ', ' order by ', ' limit '];

/** How many of the clauses above a statement names. */
function clauseCount(text: string): number {
  const padded = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `;
  let found = 0;
  for (const clause of CLAUSES) if (padded.includes(clause)) found += 1;
  return found;
}

/** Which hypothesis a variant belongs to. Printed as a column so a reader reads families, not names. */
export type VariantFamily = 'agreement' | 'length' | 'structure' | 'source-order';

/**
 * One rule that can be read off an artifact, and whether the pipeline ships it.
 *
 * `pick` returns a slot index, or `-1` when the variant has no input to read. The shipped three
 * are not written here: they delegate to `consensus.pick`, which is the arrangement that keeps one
 * definition of a shipped rule.
 */
export interface RuleVariant {
  readonly name: string;
  readonly family: VariantFamily;
  readonly shipped: boolean;
  /** Why this variant is on the list, in one sentence. Printed under `--why`. */
  readonly why: string;
  readonly pick: (candidates: readonly Recorded[]) => number;
}

/** Every variant the harness prices, shipped ones first. */
export const VARIANTS: readonly RuleVariant[] = [
  {
    name: 'first',
    family: 'agreement',
    shipped: true,
    why: 'what an arm with no selector returns: the slot the pool was offered in',
    pick: (candidates) => pick('first', candidates),
  },
  {
    name: 'shortest',
    family: 'length',
    shipped: true,
    why: 'the rule the pipeline ships, and the one every variant below has to beat',
    pick: (candidates) => pick('shortest', candidates),
  },
  {
    name: 'modal',
    family: 'agreement',
    shipped: true,
    why: 'the result the most candidates returned: the vote, which costs no call either',
    pick: (candidates) => pick('modal', candidates),
  },
  {
    name: 'longest',
    family: 'length',
    shipped: false,
    why: 'the far end of the length axis, kept so that a reader can see the axis has a direction',
    pick: (candidates) => largest(candidates, eligible(candidates), chars),
  },
  {
    name: 'second-shortest',
    family: 'length',
    shipped: false,
    why: 'on the questions a length rule loses, the right statement is usually second, not first',
    pick: (candidates) => {
      if (candidates.length === 0) return -1;
      const rank = rankable(candidates, eligible(candidates));
      if (rank.length === 0) return eligible(candidates)[0] as number;
      const length = (index: number): number => (textOf(candidates[index]?.sql) as string).length;
      const order = [...rank].sort((left, right) => length(left) - length(right));
      return order[Math.min(1, order.length - 1)] as number;
    },
  },
  {
    name: 'nonspace',
    family: 'length',
    shipped: false,
    why: 'whitespace is formatting, so a measure that ignores it should be at least as good',
    pick: (candidates) => smallest(candidates, eligible(candidates), nonspace),
  },
  {
    name: 'tokens',
    family: 'length',
    shipped: false,
    why: 'character length prices identifier spelling; a token count prices the statement',
    pick: (candidates) => smallest(candidates, eligible(candidates), tokenCount),
  },
  {
    name: 'identifiers',
    family: 'length',
    shipped: false,
    why: 'a statement with fewer names reads less of the schema, which is how an omission looks',
    pick: (candidates) => smallest(candidates, eligible(candidates), identifierCount),
  },
  {
    name: 'chars-no-quoted',
    family: 'length',
    shipped: false,
    why: 'a long quoted label is data, not structure, so it should not decide a length contest',
    pick: (candidates) => smallest(candidates, eligible(candidates), unquotedChars),
  },
  {
    name: 'chars-no-alias',
    family: 'length',
    shipped: false,
    why: 'an `as` alias is naming, and naming is what a model is most free to get wrong',
    pick: (candidates) => smallest(candidates, eligible(candidates), unaliasedChars),
  },
  {
    name: 'modal-then-shortest',
    family: 'agreement',
    shipped: false,
    why: 'consensus where it is strict, length where it is not — the tie-break modal leaves open',
    pick: (candidates) => smallest(candidates, majority(candidates, 2), chars),
  },
  {
    name: 'majority-longest',
    family: 'agreement',
    shipped: false,
    why: 'the same majority group, read from the other end, as a control on the tie-break',
    pick: (candidates) => largest(candidates, majority(candidates, 2), chars),
  },
  {
    name: 'central',
    family: 'structure',
    shipped: false,
    why: 'the statement the pool mostly says, which is what consensus over text means',
    pick: (candidates) => {
      const sets = candidates.map((candidate) => new Set(tokens(candidate.sql ?? '')));
      let best = -1;
      let bestScore = -1;
      for (const index of textPool(candidates)) {
        let score = 0;
        for (const [other, set] of sets.entries()) {
          if (other === index) continue;
          for (const token of sets[index] as Set<string>) if (set.has(token)) score += 1;
        }
        if (score > bestScore) {
          bestScore = score;
          best = index;
        }
      }
      return best;
    },
  },
  {
    name: 'superset',
    family: 'structure',
    shipped: false,
    why: 'an omitted clause is a token the other statements have and this one does not',
    pick: (candidates) => {
      const sets = candidates.map((candidate) => new Set(tokens(candidate.sql ?? '')));
      let best = -1;
      let bestScore = -1;
      for (const index of textPool(candidates)) {
        let covered = 0;
        for (const [other, set] of sets.entries()) {
          if (other === index) continue;
          for (const token of set) if ((sets[index] as Set<string>).has(token)) covered += 1;
        }
        if (covered > bestScore) {
          bestScore = covered;
          best = index;
        }
      }
      return best;
    },
  },
  {
    name: 'clauses-then-shortest',
    family: 'structure',
    shipped: false,
    why: 'a wrong statement is usually wrong by a missing clause, so count clauses before length',
    pick: (candidates) => {
      if (candidates.length === 0) return -1;
      const subset = eligible(candidates);
      let best = subset[0] as number;
      for (const index of subset) {
        const here = clauseCount(candidates[index]?.sql ?? '');
        const there = clauseCount(candidates[best]?.sql ?? '');
        // A statement there is no text for is not shorter than anything: the tie-break reads
        // `Infinity` so that an omission cannot win a clause contest it was never ranked in.
        const hereLength = textOf(candidates[index]?.sql)?.length ?? Number.POSITIVE_INFINITY;
        const thereLength = textOf(candidates[best]?.sql)?.length ?? Number.POSITIVE_INFINITY;
        if (here > there || (here === there && hereLength < thereLength)) best = index;
      }
      return best;
    },
  },
  {
    name: 'wider',
    family: 'structure',
    shipped: false,
    why: 'the modal group unless it answered a listing with one row — the only rule that reads how many rows a result holds',
    pick: (candidates) => wider(candidates),
  },
  {
    name: 'wider-then-shortest',
    family: 'structure',
    shipped: false,
    why: 'the same shape override with a length tie-break inside the group it chose, so the axis is isolated from the tie',
    pick: (candidates) => {
      const chosen = wider(candidates);
      if (chosen < 0) return chosen;
      const group = majority(candidates, 1).filter((index) => candidates[index]?.fingerprint === candidates[chosen]?.fingerprint);
      return group.length === 0 ? chosen : smallest(candidates, group, chars);
    },
  },
];

/** What one variant scored on one arm. */
export interface VariantScore {
  readonly name: string;
  readonly family: VariantFamily;
  readonly shipped: boolean;
  /** Why the variant is on the list, carried with the score so a report never looks it up twice. */
  readonly why: string;
  /** Questions the variant answered correctly, over every question the arm ran. */
  readonly correct: number;
  /** Questions the variant had no input for. Scored as misses, so the denominator is shared. */
  readonly unavailable: number;
}

/** One arm, and every variant's score against the shipped rule on the same questions. */
export interface ArmReading {
  readonly arm: string;
  readonly cases: number;
  readonly scores: readonly VariantScore[];
  /** Each unshipped variant paired against the shipped rule, case by case. */
  readonly against: readonly ({ readonly name: string } & Pairing)[];
}

/** The part of a run artifact this harness reads. */
export interface RulesArtifact {
  readonly split?: string;
  readonly model?: string;
  readonly cases?: readonly {
    readonly arm?: unknown;
    readonly candidates?: readonly unknown[];
  }[];
}

/** One case as this harness needs it: which arm, and the set it offered. */
export interface RulesCase {
  readonly arm: string;
  readonly candidates: readonly Recorded[];
}

/** Read a candidate record, refusing nothing: an artifact field is `unknown` until it is read. */
function readCandidate(raw: unknown): Recorded {
  const record = (raw ?? {}) as { source?: unknown; correct?: unknown; sql?: unknown; fingerprint?: unknown; rows?: unknown; columns?: unknown };
  const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);
  const rows = count(record.rows);
  const columns = count(record.columns);
  return {
    source: typeof record.source === 'string' ? record.source : '',
    correct: record.correct === true,
    ...(typeof record.sql === 'string' ? { sql: record.sql } : {}),
    ...(typeof record.fingerprint === 'string' ? { fingerprint: record.fingerprint } : {}),
    ...(rows === undefined ? {} : { rows }),
    ...(columns === undefined ? {} : { columns }),
  };
}

/** Every case in the artifact that names an arm, in the order the artifact wrote them. */
export function readCases(artifact: RulesArtifact): readonly RulesCase[] {
  const cases: RulesCase[] = [];
  for (const raw of artifact.cases ?? []) {
    const row = raw as { arm?: unknown; candidates?: readonly unknown[] };
    if (typeof row.arm !== 'string') continue;
    cases.push({ arm: row.arm, candidates: (row.candidates ?? []).map(readCandidate) });
  }
  return cases;
}

/** Score every variant on every arm, and pair each one against the shipped rule. */
export function readArtifact(artifact: RulesArtifact): readonly ArmReading[] {
  const cases = readCases(artifact);
  const arms = [...new Set(cases.map((row) => row.arm))];
  const readings: ArmReading[] = [];
  for (const arm of arms) {
    const rows = cases.filter((row) => row.arm === arm);
    const outcomes = new Map<string, boolean[]>();
    const scores: VariantScore[] = [];
    /**
     * The pool's arrangement, generated from the sources this arm actually recorded.
     *
     * A three-source pool has six orderings and a four-source pool has twenty-four; beyond that
     * the list stops, because an arrangement is a preference among prompts and a pool of nine
     * offers no preference that a reader could act on. The one ordering that reproduces the
     * recorded order is kept rather than filtered out: it is the control that says the family
     * costs nothing when it says nothing.
     */
    const sources = [...new Set(rows.flatMap((row) => row.candidates.map((candidate) => candidate.source)).filter((source) => source.length > 0))].sort();
    const arrangements: RuleVariant[] =
      sources.length < 2 || sources.length > 4
        ? []
        : orderings(sources).map((order) => ({
            name: `first:${order.map((source) => source.split('+')[0] ?? source).join('>')}`,
            family: 'source-order' as const,
            shipped: false,
            why: 'the same candidates offered in a named order: an arrangement is the whole of what `first` reads, and it costs nothing',
            pick: firstBy(order),
          }));
    for (const variant of [...VARIANTS, ...arrangements]) {
      const answers: boolean[] = [];
      let unavailable = 0;
      for (const row of rows) {
        // A question the arm kept no candidate for is a generation failure, not a rule failure,
        // and it is scored as a miss in every column so that the columns stay comparable.
        const index = row.candidates.length === 0 ? -1 : variant.pick(row.candidates);
        if (index < 0) {
          unavailable += 1;
          answers.push(false);
          continue;
        }
        answers.push(row.candidates[index]?.correct === true);
      }
      outcomes.set(variant.name, answers);
      scores.push({
        name: variant.name,
        family: variant.family,
        shipped: variant.shipped,
        why: variant.why,
        correct: answers.filter((answer) => answer).length,
        unavailable,
      });
    }
    const reference = outcomes.get('shortest') as boolean[];
    const against = [...VARIANTS, ...arrangements].filter((variant) => !variant.shipped).map((variant) => ({
      name: variant.name,
      ...pair(outcomes.get(variant.name) as boolean[], reference),
    }));
    readings.push({ arm, cases: rows.length, scores, against });
  }
  return readings;
}

/** How the harness was asked to run. */
export interface RulesSettings {
  readonly artifact: string;
  /** Whether to print the one-line reason each variant is on the list. */
  readonly why: boolean;
  readonly json: boolean;
}

/** Parse the command line, refusing an argument it does not understand before anything else. */
export function resolveRulesSettings(argv: readonly string[]): RulesSettings {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--json' || token === '--why') continue;
    if (token === '--artifact') {
      index += 1;
      continue;
    }
    throw new Error(`unrecognized argument ${token}: this harness takes --artifact <path>, --why and --json`);
  }
  const at = argv.indexOf('--artifact');
  const artifact = at === -1 ? undefined : argv[at + 1];
  if (artifact === undefined) {
    throw new Error('--artifact is required: this harness reads an artifact rather than producing one');
  }
  return { artifact, why: argv.includes('--why'), json: argv.includes('--json') };
}

/** The Bonferroni bound for the unshipped family: what a lead has to clear to be a finding. */
export function correctedThreshold(comparisons: number = VARIANTS.filter((variant) => !variant.shipped).length): number {
  return 0.05 / comparisons;
}

/** A score as a share of the arm's questions, with the count and the no-input count beside it. */
function scoreCell(score: VariantScore, cases: number): string {
  const share = ((score.correct / Math.max(1, cases)) * 100).toFixed(2);
  const missing = score.unavailable === 0 ? '' : ` [${String(score.unavailable)} no input]`;
  return `${share}% (${String(score.correct)})${missing}`;
}

/**
 * The verdict, as one sentence.
 *
 * Three outcomes are possible and each is named: no variant beats the shipped rule, one beats it
 * inside the family's corrected threshold, or one beats it only inside the uncorrected one. The
 * third is the interesting one — it is a lead this artifact cannot certify, and calling it a
 * finding is how a search becomes a discovery.
 */
export function verdict(reading: ArmReading): string {
  const leaders = reading.against.filter((entry) => entry.wins > entry.losses);
  if (leaders.length === 0) {
    return `no variant beats shortest on ${reading.arm}: the rule space is closed on this artifact, and the next lever is not a rule`;
  }
  // The comparisons this arm actually made, not the size of the static list: a pool also admits
  // every ordering of its sources, so an arm with a three-source pool made twenty comparisons
  // where a rule-only arm made fourteen, and testing both at 0.05/14 would let the orderings in
  // through a door the correction had already shut. The count in the sentence and the bound it is
  // compared against now come from the same number.
  const bound = correctedThreshold(reading.against.length);
  const named = leaders
    .map((entry) => `${entry.name} (won ${String(entry.wins)} / lost ${String(entry.losses)}, p=${entry.p.toFixed(4)})`)
    .join(', ');
  const certified = leaders.filter((entry) => entry.p < bound);
  return certified.length === 0
    ? `${named} leads shortest on ${reading.arm} inside the uncorrected 0.05 but not inside ${bound.toFixed(4)}, which is what ${String(reading.against.length)} variants cost — unresolved, and not a dispatch`
    : `${named} beats shortest on ${reading.arm} at p < ${bound.toFixed(4)}, the Bonferroni bound for ${String(reading.against.length)} variants — a dispatch is owed`;
}

/** Every line the report prints, in the order a reader needs them. */
export function reportLines(readings: readonly ArmReading[], settings: RulesSettings, artifact: RulesArtifact): string[] {
  const questions = readings[0]?.cases ?? 0;
  const where = artifact.split === undefined ? '' : ` (${artifact.split}${artifact.model === undefined ? '' : `, ${artifact.model}`})`;
  const unshipped = VARIANTS.length - VARIANTS.filter((variant) => variant.shipped).length;
  const lines = [
    `free-rule space on ${String(questions)} questions per arm${where}`,
    `${String(VARIANTS.length)} variants (${String(VARIANTS.length - unshipped)} shipped, ${String(unshipped)} unshipped), plus one ordering per pool arrangement; ` +
      `each arm's bound is 0.05 over the comparisons it made, printed beside its score`,
  ];
  for (const reading of readings) {
    const shipped = reading.scores.find((score) => score.name === 'shortest') as VariantScore;
    lines.push('');
    lines.push(
      `  ${reading.arm}: the shipped rule answers ${scoreCell(shipped, reading.cases)} of ${String(reading.cases)}; ` +
        `${String(reading.against.length)} comparisons, bound p < ${correctedThreshold(reading.against.length).toFixed(4)}`,
    );
    lines.push('  family     variant                 score');
    for (const score of reading.scores) {
      const mark = score.shipped ? '*' : ' ';
      const paired = reading.against.find((entry) => entry.name === score.name);
      const delta =
        paired === undefined
          ? ''
          : `  won ${String(paired.wins)} / lost ${String(paired.losses)} (both ${String(paired.both)}, p=${paired.p.toFixed(4)})`;
      lines.push(`  ${mark}${score.family.padEnd(10)} ${score.name.padEnd(22)} ${scoreCell(score, reading.cases)}${delta}`);
      if (settings.why) lines.push(`      ${score.why}`);
    }
    lines.push(`  verdict: ${verdict(reading)}`);
  }
  return lines;
}

/** Read the artifact, price every variant, print the report. Returns a process exit code. */
export function main(argv: readonly string[], _root: string, log: (line: string) => void = console.log): number {
  const settings = resolveRulesSettings(argv);
  const artifact = JSON.parse(readFileSync(settings.artifact, 'utf8')) as RulesArtifact;
  const readings = readArtifact(artifact);
  if (readings.length === 0) {
    throw new Error('this artifact has no case carrying an arm name, so there is no candidate set to price');
  }
  if (settings.json) {
    log(JSON.stringify({ split: artifact.split, model: artifact.model, arms: readings }, null, 2));
    return 0;
  }
  for (const line of reportLines(readings, settings, artifact)) log(line);
  return 0;
}

/**
 * Run as a script when — and only when — this file is the entry point.
 *
 * The check is split out for the reason `pool.ts`, `route.ts` and `consensus.ts` split it: an
 * inline check is unreachable from a test, and the branch it guards is the one that decides
 * whether a mistyped flag prints a sentence or a stack trace.
 */
export function dispatch(
  entry: string | undefined,
  self: string,
  argv: readonly string[],
  root: string,
  log: (line: string) => void = console.log,
  error: (line: string) => void = console.error,
  run: (argv: readonly string[], root: string, log: (line: string) => void) => number = main,
): number | undefined {
  if (entry === undefined || self !== pathToFileURL(entry).href) return undefined;
  try {
    return run(argv, root, log);
  } catch (thrown) {
    error(thrown instanceof Error ? thrown.message : String(thrown));
    return 1;
  }
}

const exit = dispatch(process.argv[1], import.meta.url, process.argv.slice(2), process.cwd());
if (exit !== undefined) process.exitCode = exit;
