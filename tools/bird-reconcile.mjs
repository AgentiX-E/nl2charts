#!/usr/bin/env node
/**
 * What a reconcile policy is worth, case by case.
 *
 * `bench:bird:decision` splits a pair by result group, which answers "did the candidates
 * disagree here". This answers a newer question: on the cases where the arm adopted a statement,
 * was it a statement nobody wrote? The arm-level funnel counts that (`novel`), and a count cannot
 * be paired — so a delta between an adopting arm and a handing-back arm cannot be attributed to
 * the paraphrases until the cases are named.
 *
 * Three things are checked, and the checks are what make the counts readable:
 *
 *   1. **The identity.** A policy that hands restatements back scores what the vote scored on
 *      exactly those cases, so `adopted: false` must imply "the same verdict as the vote". Any
 *      case that disagrees is either a bug in the policy or a candidate set that is not the
 *      vote's, and both are worth stopping for.
 *   2. **The policy held.** The row publishes which policy produced its `adopted` column. An arm
 *      that says `'novel'` and scored a paraphrase did not run the lever it is named for.
 *   3. **The cut.** On the novel cases the arm's flips against the vote are the whole of what the
 *      turn bought; on the declined cases they are the whole of what it cost.
 *
 * Reads only. Every number comes from an artifact, and an artifact that cannot answer the
 * question says so instead of printing a zero — a zero reads as "the lever moved nothing", which
 * is a finding, and an absent record is not one.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

/** The three per-case records a reconcile arm can write, named so a fixture cannot be vague. */
const NOVEL = { returned: true, novel: true, executable: true, adopted: true };
const DECLINED = { returned: true, novel: false, executable: true, adopted: false };
const SCORED = { returned: true, novel: false, executable: true, adopted: true };

/** Cases, per arm, keyed by question id. */
export function casesOf(report, arm) {
  const rows = (report.cases ?? []).filter((row) => row.arm === arm);
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The two-sided exact test, the same one `eval/bird/decisions.ts` prints.
 *
 * Recomputed here in a dozen lines rather than shelled out to `tsx`: this file runs in a gate
 * self-test, where spawning a TypeScript process would make the test slower than the thing it
 * tests. The self-test pins it to values that can be checked by hand, so a divergence between the
 * two implementations shows up as a failing example rather than as two plausible p-values.
 */
export function exactMcNemar(wins, losses) {
  const n = wins + losses;
  if (n === 0) return 1;
  const choose = (k) => {
    let value = 1;
    for (let i = 0; i < k; i += 1) value = (value * (n - i)) / (i + 1);
    return value;
  };
  let tail = 0;
  for (let i = 0; i <= Math.min(wins, losses); i += 1) tail += choose(i);
  return Math.min(1, (2 * tail) / 2 ** n);
}

/**
 * The strata the arm's own records define.
 *
 * `adopted` is read from the record and never re-derived from `novel`: the policy decides what it
 * scores, and a tool that recomputed the rule would agree with a changed rule by construction —
 * which is the class of defect this project keeps finding in its own instruments.
 *
 * `paraphrased` is the bucket that separates the two policies: a case the arm scored although it
 * restated a candidate. Empty is the only correct answer for a `'novel'` arm, and it is the whole
 * of what an `'always'` arm does.
 */
export function strata(policyCases) {
  const novel = [];
  const declined = [];
  const paraphrased = [];
  const unscored = [];
  for (const [id, row] of policyCases) {
    const record = row.reconcile;
    if (record === undefined) {
      unscored.push(id);
    } else if (record.adopted !== true) {
      declined.push(id);
    } else if (record.novel === true) {
      novel.push(id);
    } else {
      paraphrased.push(id);
    }
  }
  return { novel, declined, paraphrased, unscored };
}

/** Flips between two arms over a set of ids. */
export function flips(left, right, ids) {
  let leftOnly = 0;
  let rightOnly = 0;
  const disagreements = [];
  for (const id of ids) {
    const a = left.get(id)?.passed === true;
    const b = right.get(id)?.passed === true;
    if (a && !b) leftOnly += 1;
    if (!a && b) rightOnly += 1;
    if (a !== b) disagreements.push(id);
  }
  return { leftOnly, rightOnly, disagreements };
}

/** Every case where a declined statement still changed the verdict. */
export function violations(policy, vote, ids) {
  return ids.filter((id) => (policy.get(id)?.passed === true) !== (vote.get(id)?.passed === true));
}

export function read({ report, policy, adopt, vote }) {
  const policyCases = casesOf(report, policy);
  if (policyCases.size === 0) {
    return [`no cases for ${policy} in this artifact, so nothing here is a reading`, { ok: false }];
  }
  const unscored = [...policyCases.values()].filter((row) => row.reconcile === undefined).length;
  if (unscored === policyCases.size) {
    // The state the fifth dispatch left: an arm-level funnel and no per-case record. Printing
    // zeroes here would read as "the policy moved nothing", which is a different finding.
    return [
      `${policy} carries no per-case reconcile record (${String(policyCases.size)} cases), so the strata cannot be cut:`,
      'this artifact can only state its funnel, not which cases were paraphrases (I-82).',
      { ok: false },
    ];
  }
  const voteCases = casesOf(report, vote);
  if (voteCases.size === 0) {
    return [`no cases for ${vote} in this artifact, so there is nothing to compare`, { ok: false }];
  }
  const row = (report.arms ?? []).find((item) => item.arm === policy);
  const declared = row?.reconcile?.policy;
  const { novel, declined, paraphrased } = strata(policyCases);
  const verdict = { ok: true };
  const lines = [`policy ${policy} against ${vote}, cut by the policy's own records`, ''];
  lines.push('stratum          n     vote  policy  flips (policy/vote)  p');
  for (const [name, ids] of [
    ['novel', novel],
    ['declined', declined],
    ['paraphrased', paraphrased],
  ]) {
    const { leftOnly, rightOnly } = flips(policyCases, voteCases, ids);
    const voteScore = ids.filter((id) => voteCases.get(id)?.passed === true).length;
    const policyScore = ids.filter((id) => policyCases.get(id)?.passed === true).length;
    lines.push(
      `${name.padEnd(16)} ${String(ids.length).padEnd(5)} ${String(voteScore).padEnd(5)} ${String(policyScore).padEnd(7)} ${String(leftOnly).padStart(4)}/${String(rightOnly).padEnd(4)}          ${exactMcNemar(leftOnly, rightOnly).toFixed(4)}`,
    );
  }
  if (declared === undefined) {
    verdict.ok = false;
    lines.push('', `the row for ${policy} does not say which policy produced its funnel, so the strata above cannot be attributed`);
  } else if (declared === 'novel' && paraphrased.length > 0) {
    verdict.ok = false;
    lines.push(
      '',
      `${String(paraphrased.length)} case(s) were scored although the reply restated a candidate, on an arm that says it scores only statements nobody wrote`,
    );
  }
  const bad = violations(policyCases, voteCases, declined);
  if (bad.length > 0) {
    verdict.ok = false;
    lines.push(
      '',
      `${String(bad.length)} case(s) changed verdict on a statement the policy declined (${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ', …' : ''}):`,
      'a handed-back reply has to leave the vote standing, or the strata above describe a category that does not hold.',
    );
  }
  if (adopt !== undefined) {
    const adoptCases = casesOf(report, adopt);
    if (adoptCases.size === 0) {
      lines.push('', `no cases for ${adopt}, so what adopting everything costs cannot be compared`);
    } else {
      // Not an invariant, a measurement: the two arms draw the reconcile reply *independently*, so
      // on the novel cases they can read a case differently without either arm being wrong. The
      // count is the pair's sampling noise on the one stratum where both arms pay for a statement,
      // and it is reported because a large one would mean the pair is being read as a lever when it
      // is being read as two runs.
      const shared = flips(adoptCases, policyCases, novel);
      // Where the two arms can differ at all: the paraphrases this policy declines. Under
      // `'always'` there are none to decline and the bucket is empty, which is why the population
      // is chosen by the declared policy rather than assumed.
      const paraphrases = declared === 'novel' ? declined : paraphrased;
      const cost = flips(adoptCases, policyCases, paraphrases);
      lines.push(
        '',
        `on the ${String(novel.length)} novel cases the two arms agree on ${String(novel.length - shared.disagreements.length)} of ${String(novel.length)}: both adopt the statement`,
        `the ${String(shared.disagreements.length)} that differ are sampling noise on that stratum, because each arm asks the model itself (${shared.disagreements.slice(0, 5).join(', ')}${shared.disagreements.length > 5 ? ', …' : ''})`,
        `on the ${String(paraphrases.length)} paraphrases ${policy} declines, ${adopt} wins ${String(cost.leftOnly)} and ${policy} wins ${String(cost.rightOnly)} — the population the policy stops paying for`,
      );
    }
  }
  return [lines.join('\n'), verdict];
}

/**
 * A synthetic artifact, so the tool can be wrong on purpose.
 *
 * Written as the runner writes it: `cases` rows with `arm`, `id`, `passed`, and — on the arm that
 * reconciles — the per-case record. Small enough that every number can be checked by hand.
 */
function fixture() {
  const row = (arm, id, passed, reconcile) => ({ arm, id, passed, ...(reconcile === undefined ? {} : { reconcile }) });
  return {
    arms: [
      { arm: 'select-cross-pooled-reconcile-novel', reconcile: { policy: 'novel' } },
      { arm: 'select-cross-pooled-reconcile', reconcile: { policy: 'always' } },
    ],
    cases: [
      // Two novel cases where the policy wins and the vote loses.
      row('select-cross-pooled-vote', '1', false),
      row('select-cross-pooled-reconcile-novel', '1', true, NOVEL),
      row('select-cross-pooled-reconcile', '1', true, SCORED),
      row('select-cross-pooled-vote', '2', false),
      row('select-cross-pooled-reconcile-novel', '2', true, NOVEL),
      row('select-cross-pooled-reconcile', '2', true, SCORED),
      // Three declined cases: the vote is right on two of them, and the adopting arm throws one
      // away — so the paraphrase costs exactly one case and the policy costs none.
      row('select-cross-pooled-vote', '3', true),
      row('select-cross-pooled-reconcile-novel', '3', true, DECLINED),
      row('select-cross-pooled-reconcile', '3', false, SCORED),
      row('select-cross-pooled-vote', '4', true),
      row('select-cross-pooled-reconcile-novel', '4', true, DECLINED),
      row('select-cross-pooled-reconcile', '4', true, SCORED),
      row('select-cross-pooled-vote', '5', false),
      row('select-cross-pooled-reconcile-novel', '5', false, DECLINED),
      row('select-cross-pooled-reconcile', '5', false, SCORED),
    ],
  };
}

function selfTest() {
  const issues = [];
  const expect = (ok, why) => {
    if (!ok) issues.push(why);
  };
  // The exact test, pinned to values that can be checked with a pencil: ten discordant pairs all
  // one way is 2/2^10, a tie is p = 1, and the test is symmetric by definition.
  expect(Math.abs(exactMcNemar(0, 10) - 2 / 1024) < 1e-12, 'the exact test does not read 2/2^10 for ten discordant pairs');
  expect(Math.abs(exactMcNemar(10, 0) - 2 / 1024) < 1e-12, 'the exact test is not symmetric');
  expect(exactMcNemar(5, 5) === 1, 'the exact test does not read p = 1 for a tie');
  const near = exactMcNemar(6, 16);
  expect(near > 0.02 && near < 0.06, `the exact test reads ${near.toFixed(4)} for six against sixteen, which is not the published 0.052`);

  const report = fixture();
  const [text, verdict] = read({
    report,
    policy: 'select-cross-pooled-reconcile-novel',
    adopt: 'select-cross-pooled-reconcile',
    vote: 'select-cross-pooled-vote',
  });
  expect(verdict.ok, `the fixture reports a violation it does not have: ${text}`);
  expect(/novel\s+2\s+0\s+2\s+2\/0/.test(text), `the novel stratum does not read 2 cases / 0 vote / 2 policy / 2 policy wins: ${text}`);
  expect(/declined\s+3\s+2\s+2\s+0\/0/.test(text), `the declined stratum does not read 3 cases / 2 vote / 2 policy / no flips: ${text}`);
  expect(/paraphrased\s+0/.test(text), `a 'novel' arm reports scored paraphrases it does not have: ${text}`);
  expect(text.includes('the two arms agree on 2 of 2'), `the two arms are not checked for agreement on the novel cases: ${text}`);
  expect(text.includes('select-cross-pooled-reconcile wins 0 and select-cross-pooled-reconcile-novel wins 1'), `the cost of adopting everything is not reported: ${text}`);

  // The identity, broken on purpose: a declined statement that changed the verdict.
  const broken = fixture();
  broken.cases = broken.cases.map((cell) =>
    cell.arm === 'select-cross-pooled-reconcile-novel' && cell.id === '3' ? { ...cell, passed: false } : cell,
  );
  const [brokenText, brokenVerdict] = read({
    report: broken,
    policy: 'select-cross-pooled-reconcile-novel',
    adopt: 'select-cross-pooled-reconcile',
    vote: 'select-cross-pooled-vote',
  });
  expect(!brokenVerdict.ok && /changed verdict on a statement the policy declined/.test(brokenText), 'a handed-back reply that changed the verdict is not reported');

  // The measurement that is not an invariant: a novel case the two arms read differently, because
  // each arm draws its own reply.
  const divergent = fixture();
  divergent.cases = divergent.cases.map((cell) =>
    cell.arm === 'select-cross-pooled-reconcile' && cell.id === '1' ? { ...cell, passed: false } : cell,
  );
  const [divergentText, divergentVerdict] = read({
    report: divergent,
    policy: 'select-cross-pooled-reconcile-novel',
    adopt: 'select-cross-pooled-reconcile',
    vote: 'select-cross-pooled-vote',
  });
  // Reported, not refused: two arms that each ask the model can read a novel case differently
  // without either being wrong. A verdict here would fail a legitimate reading of a noisy pair.
  expect(divergentVerdict.ok && /the 1 that differ are sampling noise on that stratum/.test(divergentText), 'a novel case the two arms read differently is not reported as sampling noise');

  // A policy that scored a paraphrase while claiming not to.
  const leaky = fixture();
  leaky.cases = leaky.cases.map((cell) =>
    cell.arm === 'select-cross-pooled-reconcile-novel' && cell.id === '4' ? { ...cell, reconcile: SCORED } : cell,
  );
  const [leakyText, leakyVerdict] = read({
    report: leaky,
    policy: 'select-cross-pooled-reconcile-novel',
    adopt: 'select-cross-pooled-reconcile',
    vote: 'select-cross-pooled-vote',
  });
  expect(!leakyVerdict.ok && /scored although the reply restated a candidate/.test(leakyText), 'a novel-only arm that scored a paraphrase is accepted');

  // A row that does not say which policy produced its funnel.
  const anonymous = fixture();
  anonymous.arms = [];
  const [anonymousText, anonymousVerdict] = read({ report: anonymous, policy: 'select-cross-pooled-reconcile-novel', vote: 'select-cross-pooled-vote' });
  expect(!anonymousVerdict.ok && /does not say which policy/.test(anonymousText), 'a funnel without a policy is accepted');

  // An artifact without per-case records — the state `41453395203` left — must say so rather than
  // print zeroes, because zeroes read as "the policy moved nothing".
  const blind = {
    arms: [],
    cases: [
      { arm: 'select-cross-pooled-reconcile', id: '1', passed: true },
      { arm: 'select-cross-pooled-vote', id: '1', passed: true },
    ],
  };
  const [blindText, blindVerdict] = read({ report: blind, policy: 'select-cross-pooled-reconcile', vote: 'select-cross-pooled-vote' });
  expect(!blindVerdict.ok && /carries no per-case reconcile record/.test(blindText), 'an artifact without per-case records is read as a measurement');

  // An arm that is not in the artifact at all is not a null result either.
  const [missingText, missingVerdict] = read({ report, policy: 'select-cross-pooled-unhinted', vote: 'select-cross-pooled-vote' });
  expect(!missingVerdict.ok && /no cases for/.test(missingText), 'an absent arm is read as a measurement');
  return issues;
}

if (process.argv[2] === '--self-test') {
  const issues = selfTest();
  if (issues.length > 0) {
    for (const issue of issues) console.error(`BIRD reconcile self-test: ${issue}`);
    process.exitCode = 1;
  } else {
    console.log(
      'BIRD reconcile self-test: the exact test is symmetric, reads 2/2^10 for ten discordant pairs, p = 1 for a tie and 0.052 for six against sixteen; a two-stratum fixture cuts novel from declined with the right scores and flips; an adopting arm is priced on both populations; a handed-back reply that changed the verdict, one that did not (the sampling noise on the novel cases is counted and not refused), a novel-only arm that scored a paraphrase, a funnel with no policy, an artifact with no per-case records and an arm that is absent all behave',
    );
  }
} else {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? fallback : args[at + 1];
  };
  const positional = args.filter((arg, index) => !arg.startsWith('--') && !(args[index - 1] ?? '').startsWith('--'));
  const path = positional[0] ?? process.env.BIRD_OUT ?? 'eval/out/bird-eval.json';
  const report = JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
  const [text, verdict] = read({
    report,
    policy: flag('policy', 'select-cross-pooled-reconcile-novel'),
    adopt: flag('adopt', 'select-cross-pooled-reconcile'),
    vote: flag('vote', 'select-cross-pooled-vote'),
  });
  console.log(text);
  if (!verdict.ok) process.exitCode = 1;
}
