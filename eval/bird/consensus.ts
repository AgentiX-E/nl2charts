/**
 * Which selection rule wins, priced from an artifact instead of from a run.
 *
 * The previous instrument (`bench:bird:pool`) split an arm's score into its two factors — the
 * ceiling its candidates offer, and the rate at which something converts that ceiling into
 * answers — and priced only the first, because the artifact recorded *whether* a candidate was
 * right and never *what it said*. That is enough to say a selector threw away 4.7 points; it is
 * not enough to say which rule would have kept them, and every rule therefore cost a run: three
 * candidates plus a selector is four calls, and a fifth arm to try a different fourth call is
 * another 1,532 questions.
 *
 * The artifact now carries, per candidate, the statement and a fingerprint of its result set.
 * That makes the second factor measurable at zero cost, because every rule below is a function
 * of data already in the file:
 *
 * - `first` — the candidate the prompt offered first. What an arm with no selector returns.
 * - `shortest` — the fewest characters of SQL. The rule every reader believes they are using.
 * - `modal` — the result set the most candidates agree on. Consensus, and the only rule here
 *   that needs the fingerprint: agreement is a property of results, not of text, and the
 *   fingerprint is `resultKey` hashed, so two candidates agree exactly when the benchmark's own
 *   judge would call their results a match.
 * - `model` — what the arm actually returned: the recorded score. The reference, and the only
 *   rule on the list that spends a call.
 * - `oracle` — any candidate correct. Not a rule; the ceiling the others are read against.
 *
 * The criterion is written before the reading. A call-free rule that scores within the split's
 * minimum detectable effect of the selector is *the same score for one call less*, and the
 * selector should be deleted; a rule that scores below it by more than that has bought nothing
 * and the call stays. Two things this harness will not say:
 *
 * - It does not re-derive the ceiling. `pool.ts` does that, and a second implementation of it
 *   here would be a second opinion about the same number.
 * - It does not run anything, and it does not skip questions. A rule with no input on a question —
 *   no statement to measure, no fingerprint to count — is scored a miss and counted separately, so
 *   that every column shares one denominator. Excluding those questions instead made two columns
 *   incomparable (1,507 against 1,532 on the dev artifact) and printed a difference whose sign
 *   disagreed with the paired test on the same rows.
 * - It does not price a rule it cannot see the input for. When the artifact carries no
 *   fingerprint at all, the modal column is a dash with the reason, not a zero: an artifact
 *   written before this field existed would otherwise read as "consensus loses 62 points".
 * - It does not decide what counts as a difference. The margin is the caller's, and the
 *   resolution is the artifact's — computed from the discordant pairs of the very pairing the
 *   verdict is about. Both are printed, and the verdict says which one binds, because a
 *   threshold finer than the evidence turns a finding into an open question without saying so.
 *
 * The aggregate that matters most is not in the rule columns: `unanimous` counts the questions
 * where every candidate returned the same result set, and how many of those are wrong. A set
 * that agrees and is wrong is the correlated-error case, and no selection rule on any list can
 * reach it — which is the boundary between this instrument and generation work.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { mcnemarExact, pairedResolution } from '@agentix-e/nl2charts-devkit';

/** The artifact fields this harness reads. Anything else is ignored, so older artifacts join. */
export interface ConsensusArtifact {
  readonly split?: unknown;
  readonly model?: unknown;
  readonly cases?: readonly {
    readonly id?: unknown;
    readonly arm?: unknown;
    readonly passed?: unknown;
    /** Present in artifacts that attribute a passed question to the candidate it took. */
    readonly winnerSource?: unknown;
    readonly candidates?: readonly {
      readonly source?: unknown;
      readonly correct?: unknown;
      readonly sql?: unknown;
      readonly fingerprint?: unknown;
    }[];
  }[];
}

/** One candidate as this harness needs it: what it said, what it returned, and whether it won. */
export interface Recorded {
  readonly source: string;
  readonly correct: boolean;
  readonly sql?: string;
  readonly fingerprint?: string;
}

/** One question as one arm ran it: the set, and what the arm did with it. */
export interface RecordedCase {
  readonly arm: string;
  readonly id: string;
  readonly passed: boolean;
  readonly candidates: readonly Recorded[];
}

export type RuleName = 'first' | 'shortest' | 'modal' | 'model' | 'oracle';

export const RULE_ORDER: readonly RuleName[] = ['first', 'shortest', 'modal', 'model', 'oracle'];

/** The rules that spend no call. `model` is what the arm paid for; `oracle` is not a rule. */
export const CALL_FREE: readonly RuleName[] = ['first', 'shortest', 'modal'];

/**
 * The index a rule picks, or -1 when the rule cannot be applied to this set.
 *
 * `-1` is a question the rule did not answer, and it is scored as a miss rather than excluded —
 * which is the second thing this file got wrong and had to fix. Excluding it made each column's
 * denominator its own, so `first` was a share of the 1,507 questions that produced candidates
 * while the selector's was a share of 1,532, and the printed difference between the two columns
 * disagreed in sign with the paired test on the same rows. Every rule now answers every question:
 * a rule that cannot pick has picked nothing.
 *
 * The count of those questions is still reported, because an artifact that cannot score a rule
 * and a rule that scores zero are different findings; what changed is that the count annotates
 * the column instead of shrinking its denominator.
 */
export function pick(rule: RuleName, candidates: readonly Recorded[]): number {
  if (candidates.length === 0) return -1;
  if (rule === 'first' || rule === 'model' || rule === 'oracle') return 0;
  if (rule === 'shortest') {
    if (!candidates.some((candidate) => candidate.sql !== undefined)) return -1;
    let best = -1;
    let bestLength = Number.POSITIVE_INFINITY;
    candidates.forEach((candidate, index) => {
      // A candidate whose statement the artifact did not keep has no length to compare, and
      // treating it as the longest is the only reading that cannot make it win by absence.
      const length = candidate.sql === undefined ? Number.POSITIVE_INFINITY : candidate.sql.length;
      if (length < bestLength) {
        bestLength = length;
        best = index;
      }
    });
    return best;
  }
  // `modal`: the most common fingerprint, ties to the earliest slot. That tie-break is the one
  // the arm's own order would have produced, so the rule differs from `first` only in what it
  // counts — not in how it resolves a question the candidates are evenly split on.
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.fingerprint === undefined) continue;
    counts.set(candidate.fingerprint, (counts.get(candidate.fingerprint) ?? 0) + 1);
  }
  if (counts.size === 0) return -1;
  let best = -1;
  let bestCount = 0;
  candidates.forEach((candidate, index) => {
    if (candidate.fingerprint === undefined) return;
    const count = counts.get(candidate.fingerprint) ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = index;
    }
  });
  return best;
}

/** What one rule scored on one arm: questions it answered correctly, and where it could not run. */
export interface RuleScore {
  readonly rule: RuleName;
  /** Questions the rule answered correctly, out of every question the arm ran. */
  readonly correct: number;
  /**
   * Questions the rule had no input for.
   *
   * These are scored as misses, so the column's denominator is the arm's case count and two
   * columns can be compared. The count is reported beside the column because "this rule had
   * nothing to read on 1,510 questions" and "this rule was wrong 1,510 times" are different
   * findings, and only one of them is about the rule.
   */
  readonly unavailable: number;
}

/**
 * Two rules read case by case: the questions only the left one answered, and only the right one.
 *
 * A rate difference is not a finding: a rule that wins twenty questions the reference also won
 * has won nothing. The pairs are counted on the same rows, so the test is McNemar's exact and
 * the two discordant counts are the whole of the evidence.
 */
export interface Pairing {
  readonly wins: number;
  readonly losses: number;
  /** Questions both answered correctly. Printed because a rule that only agrees is not a rule. */
  readonly both: number;
  readonly p: number;
}

/** Pair two rule outcomes case by case. Both arrays must describe the same questions. */
export function pair(left: readonly boolean[], right: readonly boolean[]): Pairing {
  if (left.length !== right.length) {
    throw new Error(`a pairing needs two readings of the same questions, not ${String(left.length)} and ${String(right.length)}`);
  }
  let wins = 0;
  let losses = 0;
  let both = 0;
  left.forEach((outcome, index) => {
    const other = right[index] as boolean;
    if (outcome && other) both += 1;
    else if (outcome) wins += 1;
    else if (other) losses += 1;
  });
  return { wins, losses, both, p: mcnemarExact(wins, losses) };
}

/** Everything one arm's artifact rows support. */
export interface ArmReading {
  readonly arm: string;
  readonly cases: number;
  readonly scores: readonly RuleScore[];
  /** Each call-free rule paired against the arm's own answer, on the same questions. */
  readonly against: readonly ({ readonly rule: RuleName } & Pairing)[];
  /** Questions where every candidate returned the same result set. */
  readonly unanimous: number;
  /** How many of those the arm answered wrongly — the correlated-error count. */
  readonly unanimousWrong: number;
  /**
   * Questions whose candidate set holds fewer than two records, so agreement is undefined.
   *
   * These sat outside the unanimity column without a count of their own: a one-candidate
   * question is neither unanimous nor divided, and a reader reconciling `unanimous` against the
   * arm's case count found a hole with no number in it. The count is printed so the arithmetic
   * closes — `unanimous + unmeasured + agreementSkipped` is every case, and the remainder is
   * the divided ones.
   */
  readonly agreementSkipped: number;
  /** Questions whose candidates carry no fingerprint, so agreement is unknown rather than zero. */
  readonly unmeasured: number;
  /**
   * Questions the arm answered whose record names no correct candidate.
   *
   * These are the artifact's holes, not the ceiling's edge: the judge saw a correct statement, so
   * one existed, and `pool.ts` repairs them by attributing the case to the winner's source. This
   * harness does not repair anything — `oracle` here counts recorded candidates only — so the
   * count is printed and the two instruments can be reconciled by reading it.
   */
  readonly unrecorded: number;
}

/** The corpus: every arm that kept a candidate set, over the questions they share. */
export interface Corpus {
  readonly reading: readonly ArmReading[];
  readonly ids: readonly string[];
  /** Arms in the artifact that kept one candidate and cannot be read here, named rather than dropped. */
  readonly single: readonly string[];
  /** Candidate records with a statement, so a reader can see how much of the corpus replays. */
  readonly statements: number;
  readonly fingerprints: number;
  readonly records: number;
}

const nameOf = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

/**
 * Read the candidate sets out of an artifact.
 *
 * The denominator is every question an arm ran, not every question it recorded candidates for.
 * A case whose candidates all died is a case a rule would have answered wrongly, and dropping it
 * would raise every rate at once — the same defect `pool.ts` records having fixed one layer up.
 */
export function readCorpus(artifact: ConsensusArtifact): Corpus {
  const perArm = new Map<string, Map<string, RecordedCase>>();
  for (const row of artifact.cases ?? []) {
    const arm = nameOf(row.arm);
    const id = row.id === undefined ? undefined : String(row.id);
    if (arm === undefined || id === undefined) continue;
    const mine = perArm.get(arm) ?? new Map<string, RecordedCase>();
    perArm.set(arm, mine);
    const candidates: Recorded[] = [];
    for (const candidate of row.candidates ?? []) {
      candidates.push({
        // A candidate that forgot its source is filed under the arm that drew it, which is what
        // `pool.ts` does — the alternative is dropping it, and a dropped candidate makes the set
        // smaller than the one the selector saw.
        source: nameOf(candidate.source) ?? arm,
        correct: candidate.correct === true,
        ...(nameOf(candidate.sql) === undefined ? {} : { sql: candidate.sql as string }),
        ...(nameOf(candidate.fingerprint) === undefined ? {} : { fingerprint: candidate.fingerprint as string }),
      });
    }
    mine.set(id, { arm, id, passed: row.passed === true, candidates });
  }
  const withCandidates = [...perArm.entries()].filter(([, cases]) => [...cases.values()].some((entry) => entry.candidates.length > 0));
  const single = [...perArm.keys()].filter((arm) => !withCandidates.some(([name]) => name === arm)).sort((a, b) => a.localeCompare(b));
  if (withCandidates.length === 0) return { reading: [], ids: [], single, statements: 0, fingerprints: 0, records: 0 };
  let ids = [...(withCandidates[0] as [string, Map<string, RecordedCase>])[1].keys()];
  for (const [, cases] of withCandidates.slice(1)) ids = ids.filter((id) => cases.has(id));
  ids.sort((left, right) => Number(left) - Number(right));
  let statements = 0;
  let fingerprints = 0;
  let records = 0;
  const reading = withCandidates
    .map(([arm, cases]): ArmReading => {
      const rows = ids.map((id) => cases.get(id) as RecordedCase);
      // Per question, per rule: the outcome the report counts *and* the sequence the pairing
      // needs. Kept as booleans rather than re-derived from the totals, because a pairing read
      // off two counts would be an estimate of which questions the two rules disagreed on.
      const outcomes = new Map<RuleName, boolean[]>();
      const scores = RULE_ORDER.map((rule): RuleScore => {
        const outcome: boolean[] = [];
        let unavailable = 0;
        for (const row of rows) {
          // `model` and `oracle` describe the case, not a choice among candidates: the arm's
          // own answer is `passed`, and the ceiling is whether any candidate held the truth.
          if (rule === 'model') {
            outcome.push(row.passed);
            continue;
          }
          if (rule === 'oracle') {
            outcome.push(row.candidates.some((candidate) => candidate.correct));
            continue;
          }
          const index = pick(rule, row.candidates);
          if (index === -1) {
            unavailable += 1;
            outcome.push(false);
            continue;
          }
          outcome.push((row.candidates[index] as Recorded).correct);
        }
        outcomes.set(rule, outcome);
        return { rule, correct: outcome.filter(Boolean).length, unavailable };
      });
      const returned = outcomes.get('model') as boolean[];
      const against = CALL_FREE.map((rule) => {
        const score = scores.find((entry) => entry.rule === rule) as RuleScore;
        const pairing = pair(outcomes.get(rule) as boolean[], returned);
        return { rule, ...pairing, available: score.unavailable < rows.length };
      })
        .filter((entry) => entry.available)
        .map(({ rule, wins, losses, both, p }) => ({ rule, wins, losses, both, p }));
      let unanimous = 0;
      let unanimousWrong = 0;
      let unmeasured = 0;
      let agreementSkipped = 0;
      let unrecorded = 0;
      for (const row of rows) {
        for (const candidate of row.candidates) {
          records += 1;
          if (candidate.sql !== undefined) statements += 1;
          if (candidate.fingerprint !== undefined) fingerprints += 1;
        }
        if (row.passed && !row.candidates.some((candidate) => candidate.correct)) unrecorded += 1;
        if (row.candidates.length < 2) {
          agreementSkipped += 1;
          continue;
        }
        const prints = row.candidates.map((candidate) => candidate.fingerprint);
        if (prints.some((value) => value === undefined)) {
          unmeasured += 1;
          continue;
        }
        if (new Set(prints).size === 1) {
          unanimous += 1;
          if (!row.passed && !row.candidates.some((candidate) => candidate.correct)) unanimousWrong += 1;
        }
      }
      return { arm, cases: rows.length, scores, against, unanimous, unanimousWrong, unmeasured, agreementSkipped, unrecorded };
    })
    .sort((left, right) => left.arm.localeCompare(right.arm));
  return { reading, ids, single, statements, fingerprints, records };
}

export interface ConsensusSettings {
  readonly artifact: string;
  /** The smallest difference the caller is willing to call a difference, in percentage points. */
  readonly margin: number;
  /** Restrict the reading to one arm. */
  readonly arm?: string;
  readonly json: boolean;
}

/**
 * The dev split's published MDE, used when a caller does not state one.
 *
 * It is a *pre-registered* number, and the artifact does not know it: 2.30pp is what the full
 * 1,532-question dev split resolves, so a 600-question sample judged against it is judged by a
 * threshold twice as fine as its own. The report therefore prints the resolution the artifact
 * computes from its own discordant pairs beside this line, and the verdict says which of the two
 * is binding rather than quietly taking the smaller one.
 */
export const DEFAULT_MARGIN_PP = 2.3;
export function resolveConsensusSettings(argv: readonly string[]): ConsensusSettings {
  // Unknown arguments are refused, and refused *first*, for the reason `pool.ts` records: CI ran
  // that harness with the path as a bare positional, the flag was dropped, and the step failed
  // with a message about a missing flag the caller had clearly supplied.
  const takesValue = new Set(['--artifact', '--margin', '--arm']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--json') continue;
    if (takesValue.has(token)) {
      index += 1;
      continue;
    }
    throw new Error(`unrecognized argument ${token}: this harness takes --artifact <path>, --margin <pp>, --arm <name> and --json`);
  }
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const artifact = flag('--artifact');
  if (artifact === undefined) throw new Error('--artifact is required: this harness reads an artifact rather than producing one');
  const raw = flag('--margin');
  const margin = raw === undefined ? DEFAULT_MARGIN_PP : Number(raw);
  if (!Number.isFinite(margin) || margin <= 0) throw new Error(`--margin takes a positive number of percentage points, not ${String(raw)}`);
  const arm = flag('--arm');
  if (arm !== undefined && arm.length === 0) throw new Error('--arm takes an arm name, not an empty string');
  return { artifact, margin, ...(arm === undefined ? {} : { arm }), json: argv.includes('--json') };
}

/**
 * The published dev numbers this harness has to reproduce if it is to be believed.
 *
 * `vote-mixed` is the same three candidates with the fourth call removed and the modal result
 * substituted, and it measured 61.5% against `select-mixed`'s 63.3% on run `40409600418`. The
 * modal column here is a *different* implementation of that rule — one that reads fingerprints
 * instead of rows — so the two numbers are a check on each other rather than a repetition.
 */
export const RECORDED = { 'select-mixed': 63.3, 'vote-mixed': 61.5 } as const;

/** Every line the report prints, in the order a reader needs them. */
export function reportLines(corpus: Corpus, settings: ConsensusSettings, artifact: ConsensusArtifact): string[] {
  const total = corpus.ids.length;
  const share = (part: number, whole = total): string => `${((part / Math.max(1, whole)) * 100).toFixed(2)}%`;
  const points = (part: number): string => `${((part / Math.max(1, total)) * 100).toFixed(2)}pp`;
  const lines = [
    `selection rules on ${String(total)} questions (${String(artifact.split ?? 'unknown')}, ${String(artifact.model ?? 'unknown')})`,
    corpus.single.length === 0
      ? 'every arm in this artifact kept a candidate set'
      : `${String(corpus.single.length)} arm(s) kept one candidate and cannot be read here: ${corpus.single.join(', ')}`,
    `candidate records: ${String(corpus.records)}, with a statement ${String(corpus.statements)}, with a result fingerprint ${String(corpus.fingerprints)}`,
    '',
  ];
  const header =
    `  ${'arm'.padEnd(24)} ${'cases'.padStart(6)} ` +
    `${CALL_FREE.map((rule) => rule.padStart(9)).join('')} ${'model'.padStart(9)} ${'oracle'.padStart(8)} ${'unanimous'.padStart(10)}`;
  lines.push(header);
  for (const arm of corpus.reading) {
    const score = (rule: RuleName): string => {
      const found = arm.scores.find((entry) => entry.rule === rule) as RuleScore;
      // A rule with no input on *every* question prints a dash rather than a zero, and a rule with
      // no input on some prints its share over the whole corpus with the shortfall named below.
      return found.unavailable === arm.cases ? '—'.padStart(9) : share(found.correct).padStart(9);
    };
    lines.push(
      `  ${arm.arm.padEnd(24)} ${String(arm.cases).padStart(6)} ` +
        `${CALL_FREE.map(score).join('')} ${score('model')} ${score('oracle')} ` +
        `${`${String(arm.unanimous)} (${share(arm.unanimousWrong, Math.max(1, arm.unanimous))} wrong)`.padStart(10)}`,
    );
  }
  lines.push('');
  for (const arm of corpus.reading) {
    const byRule = (rule: RuleName): RuleScore => arm.scores.find((entry) => entry.rule === rule) as RuleScore;
    const model = byRule('model');
    const oracle = byRule('oracle');
    lines.push(
      `  ${arm.arm}: the ceiling is ${share(oracle.correct)}, the arm returned ${share(model.correct)}, ` +
        `so its selector lost ${points(oracle.correct - model.correct)}`,
    );
    if (arm.unrecorded > 0) {
      lines.push(
        `    ${String(arm.unrecorded)} answered question(s) name no correct candidate in their record, so \`oracle\` reads ` +
          `${String(arm.unrecorded)} low here and \`pool.ts\` repairs them by source`,
      );
    }
    for (const rule of CALL_FREE) {
      const score = byRule(rule);
      const pairing = arm.against.find((entry) => entry.rule === rule);
      if (pairing === undefined) {
        lines.push(`    ${rule.padEnd(9)} cannot be scored: the artifact carries no ${rule === 'shortest' ? 'statements' : 'result fingerprints'} for this arm`);
        continue;
      }
      lines.push(
        `    ${rule.padEnd(9)} ${share(score.correct)} against the selector: ` +
          `won ${String(pairing.wins)} / lost ${String(pairing.losses)} (both ${String(pairing.both)}, p=${pairing.p.toFixed(4)})` +
          (score.unavailable === 0 ? '' : `, ${String(score.unavailable)} of them counted as misses for want of input`),
      );
    }
    if (arm.unmeasured > 0) {
      lines.push(`    agreement unmeasured on ${String(arm.unmeasured)} question(s): a candidate there carries no fingerprint`);
    }
    if (arm.agreementSkipped > 0) {
      // Printed because the unanimity column is read against the arm's case count, and a question
      // with one candidate is neither unanimous nor divided: without this line the difference is a
      // hole a reader has to guess at. `bird-dev`'s 600-case artifact had 5 of them on `select-mixed`.
      lines.push(
        `    agreement not applicable on ${String(arm.agreementSkipped)} question(s): fewer than two candidates, so there is nothing to agree`,
      );
    }
  }
  lines.push('');
  const ranked = corpus.reading
    .flatMap((arm) => {
      const model = (arm.scores.find((entry) => entry.rule === 'model') as RuleScore).correct;
      return CALL_FREE.map((rule) => arm.scores.find((entry) => entry.rule === rule) as RuleScore)
        .filter((score) => score.unavailable < arm.cases)
        .map((score) => ({ arm: arm.arm, rule: score.rule, model, correct: score.correct }));
    })
    .sort((left, right) => right.correct - left.correct || left.arm.localeCompare(right.arm) || left.rule.localeCompare(right.rule));
  // `first` needs nothing but a candidate list, and every arm in `reading` kept one on at least
  // one question — that is what put it in the reading — so this list is never empty. The cast says
  // that rather than a fallback branch no bank could reach honestly.
  const best = ranked[0] as { readonly arm: string; readonly rule: RuleName; readonly model: number; readonly correct: number };
  const gap = ((best.model - best.correct) / Math.max(1, total)) * 100;
  // A rule that is *ahead* of the selector is the interesting case, and "-0.33pp behind" is not a
  // sentence: the sign is stated rather than assumed, because the artifact this was first run on
  // put `first` in front of the selector on `select`.
  const standing = gap >= 0 ? `${gap.toFixed(2)}pp behind` : `${Math.abs(gap).toFixed(2)}pp ahead of`;
  // What this artifact can resolve, from its own discordant pairs on the very pairing the verdict
  // is about. The two filters above and in `readCorpus` are the same one — a rule whose input is
  // missing on every question — so a rule the ranking named always has a pairing here.
  const bestArm = corpus.reading.find((arm) => arm.arm === best.arm) as ArmReading;
  const bestPairing = bestArm.against.find((entry) => entry.rule === best.rule) as Pairing;
  const resolution = pairedResolution(bestPairing.wins, bestPairing.losses, total).mde * 100;
  // The margin is stated by the caller and the resolution is computed by the artifact, and until
  // the second was printed beside the first, a 600-case dev sample was judged against a 2.30pp
  // line derived from 1,532 questions. The verdict now says which of the two is binding: a margin
  // finer than the evidence turns the sentence from a finding into an open question, in both
  // directions — the artifact cannot say the call is worthless, and cannot say it is worth it.
  lines.push(
    `  criterion: a call-free rule replaces the selector when it scores within ${settings.margin.toFixed(2)}pp of it` +
      ` (this artifact's own pairing on ${best.arm} resolves ${resolution.toFixed(2)}pp)`,
  );
  if (gap <= settings.margin) {
    lines.push(
      resolution <= settings.margin
        ? `  verdict: ${best.rule} is within ${settings.margin.toFixed(2)}pp of the selector on ${best.arm} (${standing} it), and ${resolution.toFixed(2)}pp is what this artifact resolves — the fourth call buys less than the split can resolve`
        : `  verdict: ${best.rule} is inside the ${settings.margin.toFixed(2)}pp line on ${best.arm} (${standing} it), but this artifact resolves only ${resolution.toFixed(2)}pp — the stated margin is finer than the evidence, so this run does not measure what the call is worth`,
    );
  } else {
    lines.push(
      resolution <= gap
        ? `  verdict: ${best.rule} is ${standing} the selector on ${best.arm}, beyond the ${resolution.toFixed(2)}pp this artifact resolves — the fourth call is earning its price`
        : `  verdict: ${best.rule} is ${standing} the selector on ${best.arm} by more than the ${settings.margin.toFixed(2)}pp line, but this artifact resolves only ${resolution.toFixed(2)}pp — the size of that lead is not measured by this run`,
    );
  }
  return lines;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function main(argv: readonly string[], _root: string, log: (line: string) => void = console.log): number {
  const settings = resolveConsensusSettings(argv);
  const artifact = readJson<ConsensusArtifact>(settings.artifact);
  const corpus = readCorpus(artifact);
  const reading =
    settings.arm === undefined
      ? corpus
      : { ...corpus, reading: corpus.reading.filter((entry) => entry.arm === settings.arm) };
  if (reading.reading.length === 0) {
    throw new Error(
      settings.arm === undefined
        ? 'this artifact keeps no candidate set, so there is no selection rule to price'
        : `this artifact has no candidate set for arm ${settings.arm}`,
    );
  }
  const lines = reportLines(reading, settings, artifact);
  if (settings.json) {
    log(JSON.stringify({ cases: reading.ids.length, arms: reading.reading, lines }, null, 2));
  } else {
    for (const line of lines) log(line);
  }
  return 0;
}

/**
 * Run as a script when — and only when — this file is the entry point.
 *
 * Split out for the same reason `pool.ts` and `route.ts` split it: an entry check written inline
 * is unreachable from a test, and the branch it guards is the one that decides whether a mistyped
 * flag prints a sentence or a stack trace.
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
