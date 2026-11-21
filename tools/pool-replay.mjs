#!/usr/bin/env node
/**
 * Price selection policies offline, from an artifact that already contains the pool.
 *
 * The artifact records, per case, every candidate's statement, the official judge's verdict on
 * it, and a fingerprint of its result. That is enough to answer "what would a different policy
 * have scored" without spending a single model call — and the alternative was one dispatch per
 * rule, which is how five selector arms came to cost five runs and still leave the question
 * ("which of them should ship") unresolved.
 *
 * Three properties make this a measurement rather than a simulation:
 *
 *  1. **The replayed vote is checked against the vote that ran.** `--verify-vote` compares this
 *     tool's modal rule, case by case, against the `pooled-vote` arm in the same artifact. The
 *     rules agree on 600 of 600 cases of `41453395203`; a policy table computed by a rule that
 *     cannot reproduce the arm it models is a table about the tool.
 *  2. **Every policy names whether it is implementable.** A policy that reads the judge's
 *     verdict is an upper bound and says so; a policy that reads only the result fingerprints
 *     and the order is free and also says so. Reporting them in one column without the mark is
 *     how an oracle gets adopted.
 *  3. **A tie is a case, not a rounding.** The modal rule keeps the earliest group on a tie,
 *     which on a three-candidate pool is the smallest possible majority; a policy that instead
 *     asks the selector on exactly those cases is priced here as its own row.
 *
 *   node tools/pool-replay.mjs                                    # the artifact this repo holds
 *   node tools/pool-replay.mjs eval/out/bird-eval.json --arm select-cross --json
 *   node tools/pool-replay.mjs --verify-vote
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

/** Group candidates by the judge's equality, as the runner's own vote does. */
export function resultGroups(candidates) {
  const groups = [];
  for (const candidate of candidates) {
    const group = groups.find((member) => member[0].fingerprint === candidate.fingerprint);
    if (group === undefined) groups.push([candidate]);
    else group.push(candidate);
  }
  return groups;
}

/**
 * The pool a vote is taken over: the same candidates minus the ones that returned nothing.
 *
 * The runner drops the empty result before counting (`offeredCandidates(considered, true)` in
 * `runCase`), for the reason that comment gives — no question in either BIRD split has an empty
 * gold — and this tool has to drop it too or it prices a policy nobody runs. The gap was not
 * cosmetic: on `44897147794` two statements that returned nothing outvoted one that answered on 9
 * questions, and on `44889941650` on 13 (9 of them won by the non-empty candidate), which is the
 * size of the advantage the shape rule and the tie gate appeared to hold over the vote. Calling
 * empty is a failure, and a failure is not an opinion to count.
 */
export function decidingPool(candidates) {
  const answered = candidates.filter((candidate) => (candidate.rows ?? 0) > 0);
  return answered.length === 0 ? candidates : answered;
}

/**
 * The modal group: largest first, earliest on a tie.
 *
 * `majorityResult` in `@agentix-e/nl2charts-devkit` is the shipped rule and this is its
 * statement over recorded fingerprints. It is duplicated rather than imported because a workflow
 * step runs this file before `pnpm install` in some jobs, and because the verification below is
 * what keeps the copy honest — an import would make the check compare a function with itself.
 */
export function modalGroup(candidates) {
  const groups = resultGroups(candidates);
  if (groups.length === 0) return { members: [], groups: 0, tied: false };
  let best = groups[0];
  for (const group of groups) if (group.length > best.length) best = group;
  const tied = groups.filter((group) => group.length === best.length).length > 1;
  return { members: best, groups: groups.length, tied };
}

/** Which member the arm actually answered with, from the record rather than from the source. */
export function chosenMember(candidates) {
  return candidates.find((candidate) => candidate.chosen === true);
}

/**
 * The candidate a case's `winnerSource` names, when the pool has exactly one member from it.
 *
 * This is the fallback for artifacts written before `chosen` existed, and it is deliberately
 * partial: a source that wrote two members names no member, and `undefined` is the honest answer
 * there rather than the first one.
 */
export function memberBySource(candidates, source) {
  if (source === undefined) return undefined;
  const matching = candidates.filter((candidate) => candidate.source === source);
  return matching.length === 1 ? matching[0] : undefined;
}

/**
 * The policies this file prices, each as a function from a case row to a boolean.
 *
 * `implementable` is the field that decides whether a row may be adopted: `vote` and
 * `vote-unless-tie` read the pool and cost nothing, `chosen` reads a selector call the run
 * already paid for, and `oracle` reads the judge — the last one is an upper bound on every
 * policy over this pool and is never a candidate for shipping.
 */
export const POLICIES = [
  {
    name: 'chosen',
    implementable: true,
    note: 'what the arm answered, from the recorded choice (or the single member its source names)',
    decide: (row) => {
      const member = chosenMember(row.candidates) ?? memberBySource(row.candidates, row.winnerSource);
      return member === undefined ? undefined : member.correct;
    },
  },
  {
    name: 'vote',
    implementable: true,
    note: 'modal result group over the candidates that returned rows: largest, earliest on a tie, no call',
    decide: (row) => {
      const modal = modalGroup(decidingPool(row.candidates));
      return modal.members.length === 0 ? undefined : modal.members.some((member) => member.correct);
    },
  },
  {
    name: 'wider',
    implementable: true,
    note: 'the vote, except where the modal group is one row and a wider candidate stands outside it',
    decide: (row) => {
      const pool = decidingPool(row.candidates);
      const modal = modalGroup(pool);
      if (modal.members.length === 0) return undefined;
      // The group's row count is the fewest any member returned, not the first member's: a
      // fingerprint collapses duplicate tuples, so members of one group can differ in physical row
      // count while holding the same distinct rows. Reading the first member made the shipped rule
      // order-dependent, and on `44897147794` it skipped the wider candidate on 3 of 600 cases for
      // that reason alone — at no gain, since the corrected rule scores the same 387.
      const modalRows = Math.min(...modal.members.map((candidate) => candidate.rows ?? 0));
      if (modalRows > 1) return modal.members.some((candidate) => candidate.correct);
      const modalColumns = Math.min(...modal.members.map((candidate) => candidate.columns ?? 0));
      const outside = pool.filter((candidate) => !modal.members.includes(candidate) && (candidate.columns ?? 0) >= modalColumns);
      const widest = outside.reduce(
        (best, candidate) => (best === undefined || (candidate.rows ?? 0) > (best.rows ?? 0) ? candidate : best),
        undefined,
      );
      if (widest !== undefined && (widest.rows ?? 0) > modalRows) return widest.correct;
      return modal.members.some((candidate) => candidate.correct);
    },
  },
  {
    name: 'vote-unless-tie',
    implementable: true,
    note: 'the vote, except where two groups tie and the selector already decided',
    decide: (row) => {
      const modal = modalGroup(decidingPool(row.candidates));
      if (modal.members.length === 0) return undefined;
      if (modal.tied) {
        const member = chosenMember(row.candidates) ?? memberBySource(row.candidates, row.winnerSource);
        if (member !== undefined) return member.correct;
      }
      return modal.members.some((member) => member.correct);
    },
  },
  {
    name: 'vote-preferred-shape',
    implementable: true,
    note: 'the vote, except where the modal group is one row and the selector returned more',
    decide: (row) => {
      const modal = modalGroup(decidingPool(row.candidates));
      if (modal.members.length === 0) return undefined;
      const member = chosenMember(row.candidates) ?? memberBySource(row.candidates, row.winnerSource);
      const modalRows = Math.max(...modal.members.map((candidate) => candidate.rows ?? 0));
      const modalColumns = Math.min(...modal.members.map((candidate) => candidate.columns ?? 0));
      if (member !== undefined && modalRows <= 1 && (member.rows ?? 0) > modalRows && (member.columns ?? 0) >= modalColumns) {
        return member.correct;
      }
      return modal.members.some((candidate) => candidate.correct);
    },
  },
  {
    name: 'oracle{chosen,vote}',
    implementable: false,
    note: 'upper bound: either policy right counts, which needs the answer key',
    decide: (row) => {
      const modal = modalGroup(decidingPool(row.candidates));
      const member = chosenMember(row.candidates) ?? memberBySource(row.candidates, row.winnerSource);
      const byVote = modal.members.length > 0 && modal.members.some((candidate) => candidate.correct);
      const byChoice = member !== undefined && member.correct;
      return byVote || byChoice;
    },
  },
];

/** One arm's cases, as this tool reads them. */
export function casesOf(artifact, arm) {
  const rows = (artifact.cases ?? []).filter((row) => arm === undefined || row.arm === arm);
  return rows.filter((row) => Array.isArray(row.candidates) && row.candidates.length > 0);
}

/** The arm with the widest recorded pool, which is the one worth pricing when none is named. */
export function widestArm(artifact) {
  const counts = new Map();
  for (const row of artifact.cases ?? []) {
    if (!Array.isArray(row.candidates)) continue;
    counts.set(row.arm, Math.max(counts.get(row.arm) ?? 0, row.candidates.length));
  }
  let best;
  for (const [arm, count] of counts) if (best === undefined || count > best.count) best = { arm, count };
  return best?.arm;
}

/**
 * The table: for each policy, how many cases it answers correctly, and how many it leaves
 * undecided.
 *
 * Undecided is counted rather than folded into wrong: a policy with no member to name is a
 * policy that did not run on that case, and a rate that counted it as a failure would price the
 * policy's coverage as accuracy.
 */
export function pricePolicies(rows) {
  return POLICIES.map((policy) => {
    let passed = 0;
    let undecided = 0;
    for (const row of rows) {
      const outcome = policy.decide(row);
      if (outcome === undefined) undecided += 1;
      else if (outcome) passed += 1;
    }
    return {
      policy: policy.name,
      implementable: policy.implementable,
      note: policy.note,
      passed,
      scored: rows.length,
      undecided,
      accuracy: rows.length === 0 ? 0 : passed / rows.length,
    };
  });
}

/**
 * The pool census: how many distinct results each case's candidates returned, and whether the
 * group that held the answer was the modal one.
 *
 * This is the reading that decides where the next call goes. A case whose candidates all agree
 * weaves one wrong statement three times, and no selection policy over that pool can answer it —
 * the fix is a different prompt, not a different judge.
 */
export function census(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const modal = modalGroup(decidingPool(row.candidates));
    const key = modal.groups;
    const bucket = buckets.get(key) ?? { groups: key, cases: 0, recall: 0, modalCorrect: 0, tied: 0 };
    bucket.cases += 1;
    if (row.candidates.some((candidate) => candidate.correct)) bucket.recall += 1;
    if (modal.members.some((candidate) => candidate.correct)) bucket.modalCorrect += 1;
    if (modal.tied) bucket.tied += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((left, right) => left.groups - right.groups);
}

/**
 * Whether a replayed policy reproduces the arm that ran it.
 *
 * The pool is keyed by question id, and only questions the arm scored are compared: an arm that
 * dropped a case would otherwise be counted as a disagreement about a case it never held.
 *
 * A run with no such arm compares **zero** cases and reports "0 of 0 agree", which is the shape of a
 * green check that checked nothing — the first artifact this tool was pointed at after the vote arm
 * was added to the dispatch list (`44889941650`, two arms) produced exactly that line. The caller has
 * to treat an empty comparison as a refusal rather than as agreement, and `main` exits 3 for it.
 *
 * This is generic because the vote is not the only policy that runs as an arm. `wider` does too, and
 * its replay disagreed with its arm on 1 of the 600 cases of `44897147794` — one case, on a policy
 * that had been read as a +4 over the vote. The cause was worth the generalization: a fingerprint
 * collapses duplicate tuples, so the members of one group can differ in physical row count, and the
 * shipped rule was reading that count off whichever member arrived first. A check per policy turns
 * "the replay prices what ships" from a claim into a measurement.
 */
export function verifyRule(artifact, arm, policy) {
  const entry = POLICIES.find((candidate) => candidate.name === policy);
  if (entry === undefined) throw new Error(`no policy named ${policy}`);
  const byId = new Map();
  for (const row of artifact.cases ?? []) {
    if (!Array.isArray(row.candidates) || row.candidates.length === 0) continue;
    if (!byId.has(row.id)) byId.set(row.id, {});
    byId.get(row.id)[row.arm] = row;
  }
  const compared = [];
  for (const [id, arms] of byId) {
    const target = arms[arm];
    if (target === undefined) continue;
    compared.push({ id, recorded: target.passed === true, replayed: entry.decide(target) === true });
  }
  const disagreements = compared.filter((entry) => entry.recorded !== entry.replayed);
  return {
    arm,
    policy,
    compared: compared.length,
    agreements: compared.length - disagreements.length,
    disagreements,
  };
}

/** The vote arm's own check, in the shape the command line has always printed. */
export function verifyVote(artifact, voteArm = 'select-cross-pooled-vote') {
  return verifyRule(artifact, voteArm, 'vote');
}

/**
 * Which file to read: the one on the command line, or the artifact this repository holds.
 *
 * Exported because the second half of that sentence is a path into a directory that only exists
 * after a benchmark has run, so the default is worth asserting here rather than discovering by
 * pointing the tool at a machine that has never run one.
 */
export function artifactPath(positional) {
  return positional ?? resolve(ROOT, 'eval/out/bird-eval.json');
}

/**
 * What one source buys when it is consumed alone, and what a judge over the pair could reach.
 *
 * `--compositions` prices the *subsets* a pool could have been; this prices the *members*. The
 * question is the one the plan asked first: a source that looks diluted by a vote might be worth
 * more on its own, and the only way to know is to read what its own candidate scored and what it
 * does on the cases where it disagrees with the count.
 *
 * `wins` and `losses` are the whole reading. A source that wins more disagreements than it loses
 * is one a judge should listen to, and `ceiling` — the vote plus its wins — is what a perfect
 * judge over that pair would reach. When `wins < losses` the dilution story is over: the source is
 * not being outvoted, it is being outvoted correctly, and no comparison call can recover it.
 */
export function consumeOf(rows, source) {
  const out = {
    source,
    cases: 0,
    missing: 0,
    single: 0,
    vote: 0,
    disagreements: 0,
    wins: 0,
    losses: 0,
    both: 0,
    neither: 0,
    ceiling: 0,
  };
  for (const row of rows) {
    const member = (row.candidates ?? []).find((candidate) => candidate.source === source);
    if (member === undefined) {
      out.missing += 1;
      continue;
    }
    out.cases += 1;
    const modal = modalGroup(decidingPool(row.candidates ?? []));
    const voteRight = modal.members.length > 0 && modal.members.some((entry) => entry.correct === true);
    const aloneRight = member.correct === true;
    if (aloneRight) out.single += 1;
    if (voteRight) out.vote += 1;
    // Agreement is most of the corpus and is not a disagreement: a source that restates the pool's
    // answer has nothing to adjudicate, and counting it would make every pool look contested.
    if (modal.members.some((entry) => entry.fingerprint === member.fingerprint)) continue;
    out.disagreements += 1;
    if (aloneRight && !voteRight) out.wins += 1;
    else if (!aloneRight && voteRight) out.losses += 1;
    else if (aloneRight && voteRight) out.both += 1;
    else out.neither += 1;
  }
  out.ceiling = out.vote + out.wins;
  return out;
}

/**
 * What each composition of the pool buys, priced in calls and in questions.
 *
 * `pricePolicies` answers "which rule over the pool I have"; this answers "which pool should I
 * have bought", and it is the question the bill asks. The three-candidate cross trio pays three
 * generations, and on the 600-question artefact `44897147794` its third member restates the second
 * on 474 of 591 cases — so before asking whether a fourth call is worth its tokens, the honest
 * question is whether the third one is.
 *
 * Every non-empty subset of the distinct sources is priced on the same rows, so the columns are
 * comparable: `calls` is the subset's size (a source generates once, which the runner enforces),
 * `vote` is the modal result over that subset, `oracle` is the ceiling that subset reaches, and
 * `single` counts the cases where its members returned one result — the share of the bill that
 * bought agreement rather than information. `tied` is the reason a subset can be worse than one
 * of its members: with an even count, a disagreement becomes a tie, and the vote settles a tie by
 * generation order rather than by evidence.
 *
 * Subsets are enumerated only while the source count stays small. Above `limit` distinct sources
 * the enumeration stops rather than printing a truncated table: a table that is missing rows is
 * read as complete, which is the defect this repository keeps finding in its own instruments.
 */
export function compositions(rows, limit = 3) {
  const sources = [];
  for (const row of rows) {
    for (const candidate of row.candidates ?? []) {
      if (!sources.includes(candidate.source)) sources.push(candidate.source);
    }
  }
  if (sources.length > limit) return [];
  const priced = [];
  for (let mask = 1; mask < 1 << sources.length; mask += 1) {
    const picked = sources.filter((_, index) => ((mask >> index) & 1) === 1);
    let cases = 0;
    let vote = 0;
    let oracle = 0;
    let single = 0;
    let tied = 0;
    for (const row of rows) {
      const members = (row.candidates ?? []).filter((candidate) => picked.includes(candidate.source));
      if (members.length === 0) continue;
      cases += 1;
      const pool = decidingPool(members);
      const modal = modalGroup(pool);
      if (modal.members.some((candidate) => candidate.correct)) vote += 1;
      if (members.some((candidate) => candidate.correct)) oracle += 1;
      if (resultGroups(members).length === 1) single += 1;
      if (modal.tied) tied += 1;
    }
    priced.push({ sources: picked, calls: picked.length, cases, vote, oracle, single, tied });
  }
  return priced.sort(
    (left, right) => left.calls - right.calls || left.sources.join('+').localeCompare(right.sources.join('+')),
  );
}

/**
 * The features a router could read without a model, a database or the answer key.
 *
 * They are all facts about the pool the run already holds: how many distinct results it found, how
 * large the modal group is, whether it is tied, how many members returned nothing, the shape the
 * modal group returned, and the two SQL keywords whose presence changes what a result means
 * (`DISTINCT` and an aggregate, which turn a row set into a number).
 *
 * Nothing here reads the question. That is not a design choice but a fact about the artifact: no
 * case this repository has ever written carried the question, so a question-side router — the one
 * `bench:bird:route` priced and the one the literature builds — could not be tested at all. The
 * record now carries `asked`, and this list is what is available until an artifact written with it
 * exists.
 */
export function shapeFeatures(row) {
  const candidates = row.candidates ?? [];
  const pool = decidingPool(candidates);
  const modal = modalGroup(pool);
  const representative = modal.members[0] ?? {};
  const rowsOf = modal.members.map((candidate) => candidate.rows ?? 0);
  const columnsOf = modal.members.map((candidate) => candidate.columns ?? 0);
  const sql = typeof representative.sql === 'string' ? representative.sql : '';
  return {
    distinct: resultGroups(pool).length,
    modalSize: modal.members.length,
    tied: modal.tied ? 1 : 0,
    emptyResults: candidates.filter((candidate) => (candidate.rows ?? 0) === 0).length,
    modalRows: rowsOf.length === 0 ? 0 : Math.min(...rowsOf),
    modalColumns: columnsOf.length === 0 ? 0 : Math.min(...columnsOf),
    distinctKeyword: /\bdistinct\b/i.test(sql) ? 1 : 0,
    aggregate: /\b(count|sum|avg|min|max)\s*\(/i.test(sql) ? 1 : 0,
  };
}

/** Every feature name `shapeFeatures` produces, in a stable order. */
export const FEATURES = /** @type {const} */ ([
  'distinct',
  'modalSize',
  'tied',
  'emptyResults',
  'modalRows',
  'modalColumns',
  'distinctKeyword',
  'aggregate',
]);

/** The area under the ROC curve of one feature, with ties counted as half a win. */
export function featureAuc(rows, name) {
  const positives = rows.filter((row) => row.other && !row.vote);
  const negatives = rows.filter((row) => row.vote && !row.other);
  if (positives.length === 0 || negatives.length === 0) return undefined;
  let score = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      const left = positive.features[name];
      const right = negative.features[name];
      score += left > right ? 1 : left === right ? 0.5 : 0;
    }
  }
  return score / (positives.length * negatives.length);
}

/** The exact two-sided sign test on a paired comparison, capped at 1. */
export function signTest(wins, losses) {
  const n = wins + losses;
  if (n === 0) return 1;
  let tail = 0;
  for (let k = 0; k <= Math.min(wins, losses); k += 1) {
    let choose = 1;
    for (let i = 1; i <= k; i += 1) choose = (choose * (n - i + 1)) / i;
    tail += choose;
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

/**
 * Two ways of answering the same pool, compared on the questions where they disagree.
 *
 * The four counts are the whole argument. `both` and `neither` are questions no router can move;
 * `otherOnly` is the prize and `voteOnly` is its price, and a policy that fires everywhere pays
 * `voteOnly` in full to collect `otherOnly` — which is exactly the arithmetic that made the
 * selector lose to the free vote by eight questions on this pool.
 *
 * The features are scored **on the discordant pairs only**, because that is the population a
 * router would act on: telling a pair apart on questions where both sides agree would be a
 * classifier for a decision nobody makes. An AUC near 0.5 says the pool's own shape does not know
 * which side is right, and that is a reading worth writing down rather than a number to tune: it
 * is the difference between "no router has been built" and "no router can be built from this".
 */
export function trustOf(artifact, otherArm, voteArm = 'select-cross-pooled-vote') {
  const byId = new Map();
  for (const row of artifact.cases ?? []) {
    if (!Array.isArray(row.candidates) || row.candidates.length === 0) continue;
    if (!byId.has(row.id)) byId.set(row.id, {});
    byId.get(row.id)[row.arm] = row;
  }
  const pairs = [];
  for (const [id, arms] of byId) {
    const voteRow = arms[voteArm];
    const otherRow = arms[otherArm];
    if (voteRow === undefined || otherRow === undefined) continue;
    pairs.push({
      id,
      vote: voteRow.passed === true,
      other: otherRow.passed === true,
      features: shapeFeatures(voteRow),
    });
  }
  const tally = { both: 0, voteOnly: 0, otherOnly: 0, neither: 0 };
  for (const pair of pairs) {
    if (pair.vote && pair.other) tally.both += 1;
    else if (pair.vote) tally.voteOnly += 1;
    else if (pair.other) tally.otherOnly += 1;
    else tally.neither += 1;
  }
  const features = FEATURES.map((name) => ({ name, auc: featureAuc(pairs, name) }))
    .filter((entry) => entry.auc !== undefined)
    .sort((left, right) => Math.abs(right.auc - 0.5) - Math.abs(left.auc - 0.5));
  return {
    voteArm,
    otherArm,
    cases: pairs.length,
    ...tally,
    p: signTest(tally.otherOnly, tally.voteOnly),
    features,
  };
}

function describe(file, arm, table, pool, checks, extra = {}) {
  const cases = pool.reduce((sum, bucket) => sum + bucket.cases, 0);
  const lines = [];
  lines.push(`POOL REPLAY  ${file}`);
  lines.push(`  arm ${arm}  ·  ${cases} cases with a pool  ·  ${pool.length} distinct-result buckets`);
  for (const check of checks) {
    lines.push(
      check.compared === 0
        ? `  ${check.policy} replay vs ${check.arm}: not in this artifact, so nothing was verified`
        : `  ${check.policy} replay vs ${check.arm}: ${check.agreements} of ${check.compared} agree` +
            (check.disagreements.length === 0 ? '' : ` — ${check.disagreements.length} DISAGREE`),
    );
  }
  for (const bucket of pool) {
    lines.push(
      `  ${String(bucket.groups)} distinct result${bucket.groups === 1 ? '' : 's'}: ` +
        `${bucket.cases} cases, pool holds the answer ${bucket.recall}, ` +
        `modal group holds it ${bucket.modalCorrect}, tied ${bucket.tied}`,
    );
  }
  for (const row of table) {
    const mark = row.implementable ? ' ' : '~';
    lines.push(
      ` ${mark} ${row.policy.padEnd(22)} ${String(row.passed).padStart(4)}/${String(row.scored).padEnd(4)}` +
        ` ${(row.accuracy * 100).toFixed(2).padStart(6)}%` +
        (row.undecided === 0 ? '' : `  (${row.undecided} undecided)`) +
        `  ${row.note}`,
    );
  }
  lines.push('  ~ = upper bound, needs the answer key and cannot ship');
  if (extra.compositions !== undefined) {
    lines.push('  pool composition: what each subset of the pool buys');
    if (extra.compositions.length === 0) lines.push('    too many distinct sources to enumerate; no table is printed rather than a partial one');
    for (const row of extra.compositions) {
      lines.push(
        `    ${String(row.calls)} call${row.calls === 1 ? ' ' : 's'}  ${row.sources.join('+').padEnd(46)}` +
          ` vote ${String(row.vote).padStart(4)}/${row.cases}` +
          `  ceiling ${String(row.oracle).padStart(4)}` +
          `  one opinion ${String(row.single).padStart(4)}` +
          `  tied ${String(row.tied).padStart(3)}`,
      );
    }
  }
  if (extra.consume !== undefined) {
    const one = extra.consume;
    lines.push(
      `  consuming ${one.source} alone: ${one.single}/${one.cases} (${((one.single / Math.max(one.cases, 1)) * 100).toFixed(2)}%)` +
        ` against the vote's ${one.vote}; on ${one.disagreements} disagreements it wins ${one.wins}, loses ${one.losses},` +
        ` both ${one.both}, neither ${one.neither} — a perfect judge over the pair reaches ${one.ceiling}`,
    );
    if (one.missing > 0) lines.push(`    ${one.missing} cases hold no ${one.source} candidate and are not in the denominator`);
  }
  if (extra.trust !== undefined) {
    const trust = extra.trust;
    lines.push(
      `  vote vs ${trust.voteArm} → ${trust.otherArm}: ${trust.cases} paired cases` +
        `, both right ${trust.both}, vote only ${trust.voteOnly}, other only ${trust.otherOnly},` +
        ` neither ${trust.neither} (sign test p = ${trust.p.toFixed(4)})`,
    );
    for (const feature of trust.features) {
      lines.push(`    the pool's ${feature.name.padEnd(15)} AUC ${feature.auc.toFixed(3)}`);
    }
  }
  return lines;
}

/**
 * The arms this tool can check itself against, one flag each.
 *
 * A policy earns a row here by having run as an arm: the check compares the rule over an arm's own
 * recorded pool against the verdict that arm wrote down, which is the only evidence that offline
 * pricing and shipping behaviour are the same rule.
 */
export const VERIFICATIONS = [
  { flag: '--verify-vote', verifyArm: 'select-cross-pooled-vote', policy: 'vote' },
  { flag: '--verify-wider', verifyArm: 'select-cross-pooled-wider', policy: 'wider' },
];

export async function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const withCompositions = args.includes('--compositions');
  const trustFlag = args.indexOf('--trust');
  const trustArm = trustFlag === -1 ? undefined : args[trustFlag + 1];
  const consumeFlag = args.indexOf('--consume');
  const consumeSource = consumeFlag === -1 ? undefined : args[consumeFlag + 1];
  const checks = VERIFICATIONS.filter((entry) => args.includes(entry.flag));
  const armFlag = args.indexOf('--arm');
  const named = armFlag === -1 ? undefined : args[armFlag + 1];
  const positional = args.filter(
    (arg, index) =>
      !arg.startsWith('--') &&
      (index === 0 || (args[index - 1] !== '--arm' && args[index - 1] !== '--trust' && args[index - 1] !== '--consume')),
  );
  const path = artifactPath(positional[0]);
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  const arm = named ?? widestArm(artifact);
  if (arm === undefined) {
    process.stderr.write(`POOL REPLAY: ${path} holds no case with a candidate pool\n`);
    return 2;
  }
  const rows = casesOf(artifact, arm);
  const table = pricePolicies(rows);
  const pool = census(rows);
  const verifications = checks.map(({ verifyArm, policy }) => verifyRule(artifact, verifyArm, policy));
  const compositionsTable = withCompositions ? compositions(rows) : undefined;
  const trust = trustArm === undefined ? undefined : trustOf(artifact, trustArm);
  const consume = consumeSource === undefined ? undefined : consumeOf(rows, consumeSource);
  const extra = {
    ...(compositionsTable === undefined ? {} : { compositions: compositionsTable }),
    ...(trust === undefined ? {} : { trust }),
    ...(consume === undefined ? {} : { consume }),
  };
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ artifact: path, arm, table, pool, vote: verifications[0], verifications, ...extra }, null, 1)}\n`,
    );
  } else {
    for (const line of describe(path, arm, table, pool, verifications, extra)) process.stdout.write(`${line}\n`);
  }
  const unverified = verifications.filter((check) => check.compared === 0);
  if (unverified.length > 0) {
    const flags = checks.filter((_, index) => unverified.includes(verifications[index])).map((entry) => entry.flag);
    process.stderr.write(
      `POOL REPLAY: ${flags.join(' and ')} was asked for and ${unverified.map((check) => check.arm).join(', ')} is not in ${path}, so nothing was verified; ` +
        'the table above is unpriced rather than checked\n',
    );
    return 3;
  }
  const disagreed = verifications.filter((check) => check.disagreements.length > 0);
  if (disagreed.length > 0) {
    process.stderr.write(
      `POOL REPLAY: ${disagreed.map((check) => `the ${check.policy} rule does not reproduce ${check.arm} on ${check.disagreements.length} of ${check.compared} cases`).join('; ')}; ` +
        'every row above is a statement about this tool rather than about the policies\n',
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).then((code) => process.exit(code));
}
