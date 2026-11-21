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
    note: 'modal result group: largest, earliest on a tie, no model call',
    decide: (row) => {
      const modal = modalGroup(row.candidates);
      return modal.members.length === 0 ? undefined : modal.members.some((member) => member.correct);
    },
  },
  {
    name: 'vote-unless-tie',
    implementable: true,
    note: 'the vote, except where two groups tie and the selector already decided',
    decide: (row) => {
      const modal = modalGroup(row.candidates);
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
      const modal = modalGroup(row.candidates);
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
      const modal = modalGroup(row.candidates);
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
    const modal = modalGroup(row.candidates);
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
 * Whether the replayed vote reproduces the arm that ran it.
 *
 * The pool is keyed by question id, and only questions both arms scored are compared: a vote arm
 * that dropped a case would otherwise be counted as a disagreement about a case it never held.
 *
 * A run with no vote arm compares **zero** cases and reports "0 of 0 agree", which is the shape of a
 * green check that checked nothing — the first artifact this tool was pointed at after that arm was
 * added to the dispatch list (`44889941650`, two arms) produced exactly that line. The caller has to
 * treat an empty comparison as a refusal rather than as agreement, and `main` exits 3 for it.
 */
export function verifyVote(artifact, voteArm = 'select-cross-pooled-vote') {
  const byId = new Map();
  for (const row of artifact.cases ?? []) {
    if (!Array.isArray(row.candidates) || row.candidates.length === 0) continue;
    if (!byId.has(row.id)) byId.set(row.id, {});
    byId.get(row.id)[row.arm] = row;
  }
  const compared = [];
  for (const [id, arms] of byId) {
    const voteRow = arms[voteArm];
    if (voteRow === undefined) continue;
    const replayed = modalGroup(voteRow.candidates).members.some((candidate) => candidate.correct);
    compared.push({ id, recorded: voteRow.passed === true, replayed });
  }
  const disagreements = compared.filter((entry) => entry.recorded !== entry.replayed);
  return {
    arm: voteArm,
    compared: compared.length,
    agreements: compared.length - disagreements.length,
    disagreements,
  };
}

function describe(artifactPath, arm, table, pool, vote) {
  const lines = [];
  lines.push(`POOL REPLAY  ${artifactPath}`);
  lines.push(`  arm ${arm}  ·  ${table[0]?.scored ?? 0} cases with a pool  ·  ${pool.length} distinct-result buckets`);
  if (vote !== undefined) {
    lines.push(
      vote.compared === 0
        ? `  vote replay vs ${vote.arm}: not in this artifact, so nothing was verified`
        : `  vote replay vs ${vote.arm}: ${vote.agreements} of ${vote.compared} agree` +
            (vote.disagreements.length === 0 ? '' : ` — ${vote.disagreements.length} DISAGREE`),
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
  return lines;
}

export async function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const verify = args.includes('--verify-vote');
  const armFlag = args.indexOf('--arm');
  const named = armFlag === -1 ? undefined : args[armFlag + 1];
  const positional = args.filter((arg, index) => !arg.startsWith('--') && (index === 0 || !args[index - 1]?.startsWith('--arm')));
  const path = positional[0] ?? resolve(ROOT, 'eval/out/bird-eval.json');
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  const arm = named ?? widestArm(artifact);
  if (arm === undefined) {
    process.stderr.write(`POOL REPLAY: ${path} holds no case with a candidate pool\n`);
    return 2;
  }
  const rows = casesOf(artifact, arm);
  const table = pricePolicies(rows);
  const pool = census(rows);
  const vote = verify ? verifyVote(artifact) : undefined;
  if (json) {
    process.stdout.write(`${JSON.stringify({ artifact: path, arm, table, pool, vote }, null, 1)}\n`);
  } else {
    for (const line of describe(path, arm, table, pool, vote)) process.stdout.write(`${line}\n`);
  }
  if (vote !== undefined && vote.compared === 0) {
    process.stderr.write(
      `POOL REPLAY: --verify-vote was asked for and ${vote.arm} is not in ${path}, so nothing was verified; ` +
        'the table above is unpriced rather than checked\n',
    );
    return 3;
  }
  if (vote !== undefined && vote.disagreements.length > 0) {
    process.stderr.write(
      `POOL REPLAY: the modal rule does not reproduce ${vote.arm} on ${vote.disagreements.length} of ${vote.compared} cases; ` +
        'every row above is a statement about this tool rather than about the policies\n',
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).then((code) => process.exit(code));
}
