/**
 * The offline pricing table for selection policies.
 *
 * This tool exists because the alternative — one dispatch per rule — cost five runs and left the
 * question unresolved. Its own risk is the obvious one: a replay that computes a different rule
 * than the runner would price a policy nobody ships. So the vote rule is checked against the arm
 * that ran it (`verifyVote`), every policy carries `implementable`, and the tests below hold both.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ReplayCandidate, ReplayRow } from '../tools/pool-replay.d.mts';
import {
  FEATURES,
  POLICIES,
  VERIFICATIONS,
  artifactPath,
  casesOf,
  census,
  chosenMember,
  compositions,
  decidingPool,
  featureAuc,
  main,
  memberBySource,
  modalGroup,
  pricePolicies,
  resultGroups,
  shapeFeatures,
  signTest,
  trustOf,
  verifyRule,
  verifyVote,
  widestArm,
} from '../tools/pool-replay.mjs';

/** The shape the runner writes: source, verdict, statement, result fingerprint, and now shape. */
const candidate = (source: string, fingerprint: string, correct: boolean, extra = {}) => ({
  source,
  fingerprint,
  correct,
  sql: `SELECT '${source}'`,
  rows: 1,
  columns: 1,
  chosen: false,
  ...extra,
});

const row = (id: string, candidates: readonly ReplayCandidate[], extra: Record<string, unknown> = {}): ReplayRow => ({
  id,
  arm: 'select-cross',
  passed: false,
  candidates,
  ...extra,
});

/**
 * One case through one policy: `true` answered correctly, `false` answered wrongly, `undefined`
 * had no member to name. Reading it back out of the priced table rather than out of `POLICIES`
 * keeps every assertion below a statement about the number a reader sees.
 */
const outcome = (policy: string, pool: readonly ReplayCandidate[], extra: Record<string, unknown> = {}) => {
  const entry = pricePolicies([row('1', pool, extra)]).find((candidate) => candidate.policy === policy);
  if (entry === undefined) throw new Error(`no policy named ${policy}`);
  if (entry.undecided === 1) return undefined;
  return entry.passed === 1;
};

describe('the modal group, as the vote arm computes it', () => {
  it('groups by fingerprint, keeps the largest group, and reports how many results there were', () => {
    const modal = modalGroup([candidate('a', 'x', false), candidate('b', 'y', true), candidate('c', 'y', true)]);
    expect(modal.groups).toBe(2);
    expect(modal.tied).toBe(false);
    expect(modal.members.map((member) => member.source)).toEqual(['b', 'c']);
  });

  it('keeps the earliest group on a tie, and says the tie happened', () => {
    const modal = modalGroup([candidate('a', 'x', true), candidate('b', 'y', false)]);
    expect(modal.members.map((member) => member.source)).toEqual(['a']);
    expect(modal.tied).toBe(true);
  });

  it('reports unanimity as one group and not as a tie', () => {
    const modal = modalGroup([candidate('a', 'x', true), candidate('b', 'x', true)]);
    expect(modal).toMatchObject({ groups: 1, tied: false });
  });

  it('treats a pool of nothing as no groups rather than as an error', () => {
    expect(modalGroup([])).toEqual({ members: [], groups: 0, tied: false });
    expect(resultGroups([])).toEqual([]);
  });
});

describe('the pool a vote is taken over', () => {
  it('drops a candidate that returned nothing, because calling empty is a failure and not an opinion', () => {
    const pool = [candidate('a', 'x', false, { rows: 0 }), candidate('b', 'x', false, { rows: 0 }), candidate('c', 'y', true, { rows: 3 })];
    expect(decidingPool(pool).map((member) => member.source)).toEqual(['c']);
    // Two statements that returned nothing do not outvote the one that answered. This is the bug
    // the runner carried: `modal` filtered empty results through `eligibleIndices` and the vote did
    // not, so on `44897147794` the two empty statements won 9 questions and on `44889941650` 13.
    expect(outcome('vote', pool)).toBe(true);
  });

  it('keeps the whole pool when nothing answered, because there is no vote left to take', () => {
    const pool = [candidate('a', 'x', true, { rows: 0 }), candidate('b', 'y', false, { rows: 0 })];
    expect(decidingPool(pool)).toHaveLength(2);
    expect(outcome('vote', pool)).toBe(true);
  });
});

describe('the wider rule', () => {
  const shaped = (source: string, fingerprint: string, correct: boolean, rows: number, columns: number, extra = {}) =>
    candidate(source, fingerprint, correct, { rows, columns, ...extra });

  it('lets a wider candidate outside a one-row consensus take the answer', () => {
    const pool = [shaped('a', 'x', false, 1, 4, { chosen: true }), shaped('c', 'x', false, 1, 4), shaped('b', 'y', true, 6, 4)];
    expect(outcome('vote', pool)).toBe(false);
    expect(outcome('wider', pool)).toBe(true);
  });

  it('leaves a consensus of more than one row alone, however wide the outsider is', () => {
    const pool = [shaped('a', 'x', false, 4, 4), shaped('c', 'x', false, 4, 4), shaped('b', 'y', true, 9, 4)];
    expect(outcome('wider', pool)).toBe(false);
  });

  it('does not trade one row for another, so a tie still goes to the earliest group', () => {
    const pool = [shaped('a', 'x', false, 1, 4), shaped('b', 'y', true, 1, 4)];
    expect(outcome('vote', pool)).toBe(false);
    expect(outcome('wider', pool)).toBe(false);
  });

  it('does not call a candidate wider when it returned fewer columns than the consensus', () => {
    // More rows from a narrower projection is a different answer, not a more complete one.
    const pool = [shaped('a', 'x', false, 1, 6), shaped('b', 'y', true, 9, 3)];
    expect(outcome('wider', pool)).toBe(false);
  });

  it('never weighs a candidate that returned nothing', () => {
    const pool = [shaped('a', 'x', false, 1, 2), shaped('b', 'y', true, 0, 9)];
    expect(outcome('wider', pool)).toBe(false);
  });

  it('has nothing to weigh when the whole pool is one consensus', () => {
    expect(outcome('wider', [shaped('a', 'x', true, 1, 4)])).toBe(true);
    expect(outcome('wider', [shaped('a', 'x', false, 1, 4)])).toBe(false);
    expect(outcome('wider', [])).toBeUndefined();
  });

  it('reads a group by the rows it holds, not by the first member that arrived', () => {
    // A fingerprint collapses duplicate tuples, so one group can hold a member that returned the
    // same row three times. The group is a one-row answer either way, and the rule looks outside it
    // for the wider candidate — which is what the third candidate is.
    const pool = [shaped('a', 'x', false, 3, 2), shaped('b', 'x', false, 1, 2), shaped('c', 'y', true, 4, 2)];
    expect(outcome('wider', pool)).toBe(true);
    // Swapping the two consensus members changes nothing: a group's shape is a fact about the group.
    expect(outcome('wider', [shaped('b', 'x', false, 1, 2), shaped('a', 'x', false, 3, 2), shaped('c', 'y', true, 4, 2)])).toBe(true);
  });
});

describe('which member became the answer', () => {
  it('reads the record, not the source name', () => {
    const candidates = [candidate('a', 'x', false), candidate('b', 'y', true, { chosen: true })];
    expect(chosenMember(candidates)?.source).toBe('b');
  });

  it('falls back to a source that names exactly one member, and refuses one that names two', () => {
    const candidates = [candidate('a', 'x', false), candidate('b', 'y', true)];
    expect(memberBySource(candidates, 'b')?.source).toBe('b');
    const twice = [candidate('a', 'x', false), candidate('a', 'y', true)];
    // A source that wrote two members names no member: returning the first would be a guess with
    // a source's authority behind it.
    expect(memberBySource(twice, 'a')).toBeUndefined();
    expect(memberBySource(candidates, undefined)).toBeUndefined();
    expect(memberBySource(candidates, '(not recorded)')).toBeUndefined();
  });
});

describe('the pricing table', () => {
  const rows = [
    // A unanimous wrong pool: no policy can answer it, and the census must say so. The arm's own
    // choice is recorded the way a real artifact records it, so no policy is left undecided here.
    row('1', [candidate('a', 'x', false, { chosen: true }), candidate('b', 'x', false), candidate('c', 'x', false)]),
    // A 2:1 pool where the majority is right: the vote wins and the recorded choice lost.
    row('2', [
      candidate('a', 'p', false, { chosen: true }),
      candidate('b', 'q', true),
      candidate('c', 'q', true),
    ]),
    // A tie where the selector picked the right one: only a policy that asks it can win.
    row('3', [
      candidate('a', 'p', true, { chosen: true }),
      candidate('b', 'q', false),
      candidate('c', 'r', false),
    ]),
  ];

  it('prices each policy over the same cases and counts what it could not decide', () => {
    const table = pricePolicies(rows);
    const byName = Object.fromEntries(table.map((entry) => [entry.policy, entry]));
    // Case 3 is the shape a tie hides: the vote "wins" there only because the group it keeps first
    // happens to be the correct one, which is arrival order and not agreement. The policy that
    // knows the difference still answers it, and answers case 2 by majority, so it is the only
    // policy above 2 here — that gap is the whole argument for buying the call on a tie only.
    expect(byName.chosen?.passed).toBe(1); // case 3 only: the selector lost 1 and 2
    expect(byName.vote?.passed).toBe(2); // case 2 by majority, case 3 by the earliest group
    // Every candidate here returned exactly one row, so no one is wider than the consensus and the
    // shape rule degenerates into the vote — which is the point of pricing it as its own row: on
    // this fixture it must show no difference, and the block above shows the difference it can.
    expect(byName.wider?.passed).toBe(2);
    expect(byName['vote-unless-tie']?.passed).toBe(2); // the same two, by the right reason each
    expect(byName['oracle{chosen,vote}']?.passed).toBe(2);
    for (const entry of table) expect(entry.undecided).toBe(0);
  });

  it('marks the oracle as unshippable and the rest as implementable', () => {
    const table = pricePolicies(rows);
    expect(table.filter((entry) => !entry.implementable).map((entry) => entry.policy)).toEqual(['oracle{chosen,vote}']);
    // The list is pinned rather than counted: a policy added here changes what the published table
    // says, and that edit should have to touch this line.
    expect(table.map((entry) => entry.policy)).toEqual(['chosen', 'vote', 'wider', 'vote-unless-tie', 'vote-preferred-shape', 'oracle{chosen,vote}']);
    // Every policy is either implementable or explicitly an upper bound: a row that is neither is
    // a policy nobody can act on and no reader can discount.
    expect(table.every((entry) => typeof entry.implementable === 'boolean')).toBe(true);
    expect(POLICIES.every((policy) => policy.note.length > 0)).toBe(true);
  });

  it('counts a case with no member to name as undecided rather than as wrong', () => {
    const table = pricePolicies([row('9', [])]);
    expect(table[0]).toMatchObject({ passed: 0, scored: 1, undecided: 1 });
  });

  it('reads an empty set as a rate of zero rather than as a division by zero', () => {
    expect(pricePolicies([])[0]).toMatchObject({ passed: 0, scored: 0, accuracy: 0 });
  });
});

describe('the shape rule that reads the recorded choice', () => {
  const shaped = (source: string, fingerprint: string, correct: boolean, rows: number, columns: number, extra = {}) =>
    candidate(source, fingerprint, correct, { rows, columns, ...extra });

  it('takes the selector when it returned more rows than a one-row consensus, at no narrower a width', () => {
    const pool = [shaped('a', 'x', true, 1, 4), shaped('b', 'x', true, 1, 4), shaped('c', 'y', false, 5, 4, { chosen: true })];
    // The vote holds the consensus alone; this rule follows the recorded choice and is wrong here,
    // which is the price of it and the reason it is priced apart from the vote rather than folded in.
    expect(outcome('vote', pool)).toBe(true);
    expect(outcome('vote-preferred-shape', pool)).toBe(false);
  });

  it('takes the selector when it is right, which is the case that pays for the rule', () => {
    const pool = [shaped('a', 'x', false, 1, 4), shaped('c', 'y', true, 5, 4, { chosen: true })];
    expect(outcome('vote-preferred-shape', pool)).toBe(true);
  });

  it('leaves the consensus alone when the selector is narrower than it', () => {
    const pool = [shaped('a', 'x', false, 1, 6), shaped('c', 'y', true, 5, 3, { chosen: true })];
    expect(outcome('vote-preferred-shape', pool)).toBe(false);
  });

  it('leaves a consensus of more than one row alone, however much the selector returned', () => {
    const pool = [shaped('a', 'x', false, 3, 4), shaped('b', 'x', false, 3, 4), shaped('c', 'y', true, 9, 4, { chosen: true })];
    expect(outcome('vote-preferred-shape', pool)).toBe(false);
  });

  it('leaves the consensus alone when the selector did not return more than it', () => {
    const pool = [shaped('a', 'x', false, 1, 4), shaped('c', 'y', true, 1, 4, { chosen: true })];
    expect(outcome('vote-preferred-shape', pool)).toBe(false);
  });

  it('falls back to the vote when nothing was recorded, and reads the source when it names one member', () => {
    const unnamed = [shaped('a', 'x', true, 1, 4), shaped('c', 'y', false, 5, 4)];
    expect(outcome('vote-preferred-shape', unnamed)).toBe(true);
    const named = [shaped('a', 'x', false, 1, 4), shaped('c', 'y', true, 5, 4)];
    expect(outcome('vote-preferred-shape', named, { winnerSource: 'c' })).toBe(true);
    // A source that names two members names no member, so the fallback stays the vote.
    const ambiguous = [shaped('a', 'x', false, 1, 4), shaped('c', 'y', true, 5, 4), shaped('c', 'z', true, 6, 4)];
    expect(outcome('vote-preferred-shape', ambiguous, { winnerSource: 'c' })).toBe(false);
  });
});

describe('a pool written before the shape was recorded', () => {
  // `rows` and `columns` arrived with the shape rule; an artifact written before that has neither,
  // and every rule that reads them has to read a missing one as zero rather than as a crash or,
  // worse, as `NaN` — which compares false against every threshold and would silently make the
  // rule return the consensus forever.
  it('reads a missing row and column count as zero, and a missing verdict count as not chosen', () => {
    const shapeless = (source: string, fingerprint: string, correct: boolean) => ({ fingerprint, source, correct });
    const pool = [shapeless('a', 'x', false), shapeless('b', 'y', true)];
    expect(decidingPool(pool)).toHaveLength(2); // nothing is known to be empty, so nothing is dropped
    expect(outcome('vote', pool)).toBe(false); // 1:1, so the earliest group answers
    expect(outcome('wider', pool)).toBe(false); // an unknown width is not a wider one
    expect(outcome('vote-preferred-shape', pool)).toBe(false); // and no member is recorded
    expect(outcome('chosen', pool)).toBeUndefined();
  });
});

describe('the pool census', () => {
  it('buckets by how many distinct results the candidates returned', () => {
    const buckets = census([
      row('1', [candidate('a', 'x', false), candidate('b', 'x', false)]),
      row('2', [candidate('a', 'x', true), candidate('b', 'y', false)]),
      row('3', [candidate('a', 'x', true), candidate('b', 'y', false)]),
    ]);
    expect(buckets).toEqual([
      { groups: 1, cases: 1, recall: 0, modalCorrect: 0, tied: 0 },
      // Both two-group cases are 1:1 and therefore tied; the earliest group is the correct one in
      // both, so the modal rule "holds the answer" there for a reason that is order rather than
      // agreement — which is exactly what the `tied` column is for.
      { groups: 2, cases: 2, recall: 2, modalCorrect: 2, tied: 2 },
    ]);
  });

  it('buckets on the pool that answered, so two empty statements are not a second distinct result', () => {
    const buckets = census([row('1', [candidate('a', 'x', false, { rows: 0 }), candidate('b', 'y', true, { rows: 1 })])]);
    expect(buckets).toEqual([{ groups: 1, cases: 1, recall: 1, modalCorrect: 1, tied: 0 }]);
  });
});

describe('the vote replay check', () => {
  const voteArtifact = {
    cases: [
      // Both arms scored it, and the recorded vote says the modal group was right.
      { id: '1', arm: 'select-cross', passed: false, candidates: [candidate('a', 'x', true), candidate('b', 'y', false)] },
      { id: '1', arm: 'select-cross-pooled-vote', passed: true, candidates: [candidate('a', 'x', true), candidate('b', 'y', false)] },
      // A case only the vote arm holds is still compared against itself, because the pool is the
      // vote arm's own record.
      { id: '2', arm: 'select-cross-pooled-vote', passed: false, candidates: [candidate('a', 'x', false)] },
    ],
  };

  it('compares the replayed rule against the arm that ran it', () => {
    const check = verifyVote(voteArtifact);
    expect(check).toMatchObject({ compared: 2, agreements: 2 });
    expect(check.disagreements).toEqual([]);
  });

  it('reports the cases where the recorded arm and the replay disagree', () => {
    const check = verifyVote({
      cases: [{ id: '1', arm: 'select-cross-pooled-vote', passed: false, candidates: [candidate('a', 'x', true)] }],
    });
    expect(check.disagreements).toEqual([{ id: '1', recorded: false, replayed: true }]);
  });

  it('flags the cases an artifact recorded before the empty result was dropped, rather than agreeing with the bug', () => {
    // `44897147794` and `44889941650` were written by the arm that let two empty statements
    // outvote the one that answered. Replaying them now disagrees on exactly those cases, and a
    // check that agreed with them would be a check that certified the bug.
    const check = verifyVote({
      cases: [
        {
          id: '1',
          arm: 'select-cross-pooled-vote',
          passed: false,
          candidates: [candidate('a', 'x', false, { rows: 0 }), candidate('b', 'x', false, { rows: 0 }), candidate('c', 'y', true, { rows: 2 })],
        },
      ],
    });
    expect(check.disagreements).toEqual([{ id: '1', recorded: false, replayed: true }]);
  });

  it('checks any policy that ran as an arm, not just the vote', () => {
    // The `wider` rule reproduces its own arm on all 600 cases of `44897147794` once the group's
    // row count is read off the group rather than off its first member; the vote arm in the same
    // artifact disagrees on 8, which are exactly the cases the empty-result bug touched.
    const artifact = {
      cases: [
        {
          id: '1',
          arm: 'select-cross-pooled-wider',
          passed: true,
          candidates: [candidate('a', 'x', false, { rows: 1, columns: 2 }), candidate('b', 'y', true, { rows: 4, columns: 2 })],
        },
        {
          id: '2',
          arm: 'select-cross-pooled-wider',
          passed: true,
          candidates: [candidate('a', 'x', true, { rows: 1, columns: 2 }), candidate('b', 'y', false, { rows: 4, columns: 2 })],
        },
      ],
    };
    expect(verifyRule(artifact, 'select-cross-pooled-wider', 'wider')).toMatchObject({ compared: 2, agreements: 1 });
    expect(verifyRule(artifact, 'select-cross-pooled-wider', 'wider').disagreements).toEqual([{ id: '2', recorded: true, replayed: false }]);
  });

  it('refuses a policy name it does not price, rather than reporting agreement with nothing', () => {
    expect(() => verifyRule({ cases: [] }, 'select-cross-pooled-wider', 'wide')).toThrow('no policy named wide');
  });

  it('compares nothing when the artifact holds no vote arm, rather than reporting agreement', () => {
    expect(verifyVote({ cases: [{ id: '1', arm: 'select-cross', passed: true, candidates: [candidate('a', 'x', true)] }] })).toMatchObject({
      compared: 0,
      agreements: 0,
    });
  });

  it('skips a row with no pool and an artifact with no cases at all', () => {
    expect(verifyVote({ cases: [{ id: '1', arm: 'select-cross-pooled-vote', passed: true }] })).toMatchObject({ compared: 0 });
    expect(verifyVote({})).toMatchObject({ compared: 0, agreements: 0 });
  });
});

describe('reading an artifact', () => {
  const artifact = {
    cases: [
      { id: '1', arm: 'select-cross', candidates: [candidate('a', 'x', true)] },
      { id: '2', arm: 'select-cross', candidates: [] },
      { id: '3', arm: 'metadata+evidence', candidates: [candidate('a', 'x', true), candidate('b', 'y', false)] },
    ],
  };

  it('keeps only the cases with a candidate pool, and only the arm asked for', () => {
    expect(casesOf(artifact, 'select-cross').map((entry) => entry.id)).toEqual(['1']);
    expect(casesOf(artifact).map((entry) => entry.id)).toEqual(['1', '3']);
  });

  it('prices the widest pool when no arm is named', () => {
    expect(widestArm(artifact)).toBe('metadata+evidence');
    expect(widestArm({ cases: [] })).toBeUndefined();
    expect(widestArm({})).toBeUndefined();
  });
});

describe('the command line', () => {
  const write = (body: unknown): { dir: string; path: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'pool-replay-'));
    const path = join(dir, 'artifact.json');
    writeFileSync(path, JSON.stringify(body));
    return { dir, path };
  };

  const artifact = {
    cases: [
      { id: '1', arm: 'select-cross', passed: true, winnerSource: 'a', candidates: [candidate('a', 'x', true), candidate('b', 'y', false)] },
      { id: '2', arm: 'select-cross', passed: false, winnerSource: 'a', candidates: [candidate('a', 'x', false), candidate('b', 'y', true)] },
      { id: '3', arm: 'select-cross-pooled-vote', passed: false, candidates: [candidate('a', 'x', false), candidate('b', 'y', true)] },
    ],
  };

  it('prints the table, and prices the widest pool when no arm is named', async () => {
    const { dir, path } = write(artifact);
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    const code = await main(['node', 'pool-replay.mjs', path, '--arm', 'select-cross']);
    spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('arm select-cross');
    expect(text).toContain('vote-unless-tie');
    expect(text).toContain('upper bound, needs the answer key and cannot ship');
  });

  it('writes the same table as JSON when asked', async () => {
    const { dir, path } = write(artifact);
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    const code = await main(['node', 'pool-replay.mjs', path, '--json']);
    spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.arm).toBe('select-cross');
    expect(parsed.table.map((entry: { policy: string }) => entry.policy)).toContain('oracle{chosen,vote}');
  });

  it('exits clean and says how many cases it compared when the replay agrees', async () => {
    // The green path of the check, which no other test walks: without it the only exercised
    // outcome of `--verify-vote` is a refusal, and a check that can only refuse is not a check.
    const agreeing = {
      cases: [
        { id: '1', arm: 'select-cross-pooled-vote', passed: true, candidates: [candidate('a', 'x', true), candidate('b', 'y', false)] },
        { id: '2', arm: 'select-cross-pooled-vote', passed: false, candidates: [candidate('a', 'x', false), candidate('b', 'y', false)] },
      ],
    };
    const { dir, path } = write(agreeing);
    const out: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    const code = await main(['node', 'pool-replay.mjs', path, '--verify-vote']);
    stdout.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out.join('')).toContain('vote replay vs select-cross-pooled-vote: 2 of 2 agree');
  });

  it('checks the shape rule against its own arm when asked for that instead', async () => {
    const artifact = {
      cases: [
        {
          id: '1',
          arm: 'select-cross-pooled-wider',
          passed: true,
          candidates: [candidate('a', 'x', false, { rows: 1, columns: 2 }), candidate('b', 'y', true, { rows: 5, columns: 2 })],
        },
      ],
    };
    const { dir, path } = write(artifact);
    const out: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    const code = await main(['node', 'pool-replay.mjs', path, '--verify-wider']);
    stdout.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out.join('')).toContain('wider replay vs select-cross-pooled-wider: 1 of 1 agree');
  });

  it('refuses when the arm it was asked to check is not in the artifact', async () => {
    const { dir, path } = write(artifact);
    const out: string[] = [];
    const err: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    });
    const code = await main(['node', 'pool-replay.mjs', path, '--verify-wider']);
    stdout.mockRestore();
    stderr.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(3);
    expect(out.join('')).toContain('wider replay vs select-cross-pooled-wider: not in this artifact');
    expect(err.join('')).toContain('--verify-wider');
  });

  it('reads the artifact this repository holds when the command line names no file', () => {
    expect(artifactPath('/tmp/x.json')).toBe('/tmp/x.json');
    expect(artifactPath(undefined)).toBe(join(resolve('.'), 'eval/out/bird-eval.json'));
  });

  it('names only policies it prices, so a flag cannot outlive the rule it checks', () => {
    const names = POLICIES.map((policy) => policy.name);
    expect(VERIFICATIONS.length).toBeGreaterThan(0);
    for (const entry of VERIFICATIONS) {
      expect(names).toContain(entry.policy);
      expect(entry.flag.startsWith('--verify-')).toBe(true);
      expect(entry.verifyArm).toMatch(/^select-cross-pooled-/);
    }
    expect(VERIFICATIONS.map((entry) => entry.policy)).toEqual(['vote', 'wider']);
  });

  it('fails the run when the replay does not reproduce the vote arm', async () => {
    const broken = {
      cases: [
        // The vote arm claims a pass its own candidates do not support: the replay disagrees, and
        // every row above that point is a statement about this tool rather than about a policy.
        { id: '1', arm: 'select-cross-pooled-vote', passed: true, candidates: [candidate('a', 'x', false)] },
      ],
    };
    const { dir, path } = write(broken);
    const out: string[] = [];
    const err: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    });
    const code = await main(['node', 'pool-replay.mjs', path, '--verify-vote']);
    stdout.mockRestore();
    stderr.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(1);
    expect(out.join('')).toContain('DISAGREE');
    expect(err.join('')).toContain('does not reproduce');
  });

  it('refuses to call a comparison it could not make a check that passed', async () => {
    // The artifact of `44889941650` holds two arms and neither of them is the vote arm, so
    // `--verify-vote` compared zero cases and printed "0 of 0 agree" — a green check that checked
    // nothing, which is the failure mode this repository has refused everywhere else. A run that
    // asked to verify and had nothing to verify is a refusal, not a pass.
    const noVoteArm = {
      cases: [
        { id: '1', arm: 'select-cross', passed: true, winnerSource: 'a', candidates: [candidate('a', 'x', true), candidate('b', 'y', false)] },
        { id: '2', arm: 'select-cross-tie', passed: false, candidates: [candidate('a', 'x', false), candidate('b', 'y', true)] },
      ],
    };
    const { dir, path } = write(noVoteArm);
    const out: string[] = [];
    const err: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    });
    const code = await main(['node', 'pool-replay.mjs', path, '--verify-vote']);
    stdout.mockRestore();
    stderr.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(3);
    expect(out.join('')).toContain('not in this artifact, so nothing was verified');
    expect(err.join('')).toContain('nothing was verified');
    expect(err.join('')).not.toContain('does not reproduce');
  });

  it('refuses an artifact with no pool at all, instead of printing an empty table', async () => {
    const { dir, path } = write({ cases: [{ id: '1', arm: 'names', passed: false }] });
    const err: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    });
    const code = await main(['node', 'pool-replay.mjs', path]);
    stderr.mockRestore();
    const text = err.join('');
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(2);
    expect(text).toContain('no case with a candidate pool');
  });

});

describe('what a pool composition buys', () => {
  it('prices every subset of the sources, and states the calls each one costs', () => {
    // Two prompts that disagree on both cases. One call reaches the answer on one of them, two
    // calls reach it on both — and the pair's vote still answers one, because a one-all tie is
    // settled by generation order and not by evidence. That combination is the reading: the
    // ceiling doubles and the answer does not move.
    const rows = [
      row('1', [candidate('a', 'x', true), candidate('b', 'y', false)]),
      row('2', [candidate('a', 'x', false), candidate('b', 'y', true)]),
    ];
    const table = compositions(rows);
    expect(table.map((entry) => [entry.sources.join('+'), entry.calls])).toEqual([
      ['a', 1],
      ['b', 1],
      ['a+b', 2],
    ]);
    const pair = table[2] as { vote: number; oracle: number; tied: number };
    expect(pair.vote).toBe(1);
    expect(pair.oracle).toBe(2);
    expect(pair.tied).toBe(2);
    expect(table[0]?.oracle).toBe(1);
  });

  it('counts the cases where the whole subset returned one result', () => {
    // The third call's value is not only its information: on this pool it is the copy that makes
    // two prompts agree. `single` is how a reader tells "three calls, one opinion" from "three
    // calls, three opinions" without re-reading the candidates.
    const rows = [row('1', [candidate('a', 'x', true), candidate('b', 'x', false)])];
    const pair = compositions(rows).find((entry) => entry.calls === 2);
    expect(pair).toMatchObject({ single: 1, oracle: 1, tied: 0, vote: 1 });
  });

  it('prices a subset on every case it can speak to, including the ones it half covers', () => {
    // A source that did not run on a case is not a wrong answer on that case: the subset still
    // holds one member and can still answer. Dropping those cases would make a subset look better
    // than it is by shrinking its denominator, which is the flattering direction.
    const rows = [
      row('1', [candidate('a', 'x', true), candidate('b', 'y', false)]),
      row('2', [candidate('a', 'x', true)]),
    ];
    const pair = compositions(rows).find((entry) => entry.calls === 2);
    expect(pair).toMatchObject({ cases: 2, vote: 2, single: 1 });
    const solo = compositions(rows).find((entry) => entry.sources[0] === 'a');
    expect(solo?.cases).toBe(2);
  });

  it('stops rather than printing a table whose rows are missing', () => {
    const rows = [
      row('1', [
        candidate('a', 'x', true),
        candidate('b', 'y', false),
        candidate('c', 'z', false),
        candidate('d', 'w', false),
      ]),
    ];
    expect(compositions(rows)).toEqual([]);
    expect(compositions(rows, 4)).toHaveLength(15);
  });
});

describe('the features a router would read', () => {
  const shaped = (source: string, fingerprint: string, correct: boolean, rows_: number, columns: number, sql = 'SELECT 1') =>
    candidate(source, fingerprint, correct, { rows: rows_, columns, sql });

  it('reads the pool and not the answer: every feature is a fact about what ran', () => {
    const features = shapeFeatures(
      row('1', [shaped('a', 'x', true, 1, 1, 'SELECT DISTINCT count(*) FROM t'), shaped('b', 'y', false, 3, 2)]),
    );
    // The declared feature list is the one the router ranks: a name that `shapeFeatures` invents
    // and `FEATURES` does not list would be computed and never scored, which reads as a feature
    // that cannot separate rather than as one that was never asked.
    expect(Object.keys(features).sort()).toEqual([...FEATURES].sort());
    expect(features).toMatchObject({
      distinct: 2,
      modalSize: 1,
      tied: 1,
      emptyResults: 0,
      modalRows: 1,
      modalColumns: 1,
      distinctKeyword: 1,
      aggregate: 1,
    });
  });

  it('ignores a candidate that returned nothing when it sizes the pool', () => {
    // The vote ignores empty candidates, so a feature that counted them would be reading a
    // population the policy never sees.
    const features = shapeFeatures(
      row('1', [shaped('a', 'x', true, 0, 0), shaped('b', 'y', false, 2, 3), shaped('c', 'y', false, 2, 3)]),
    );
    expect(features).toMatchObject({ distinct: 1, modalSize: 2, emptyResults: 1, modalRows: 2, modalColumns: 3 });
  });

  it('scores a feature over the cases the two answers disagree on, and nowhere else', () => {
    const pairs = [
      { vote: true, other: false, features: { shape: 1 } },
      { vote: false, other: true, features: { shape: 9 } },
      { vote: true, other: true, features: { shape: 100 } },
    ];
    expect(featureAuc(pairs, 'shape')).toBe(1);
    expect(featureAuc(pairs.map((pair) => ({ ...pair, features: { shape: -pair.features.shape } })), 'shape')).toBe(0);
  });

  it('counts a tie as half a win, because a feature that cannot separate has said nothing', () => {
    const pairs = [
      { vote: true, other: false, features: { shape: 5 } },
      { vote: false, other: true, features: { shape: 5 } },
    ];
    expect(featureAuc(pairs, 'shape')).toBe(0.5);
  });

  it('reports nothing rather than half a curve when no case disagrees', () => {
    expect(featureAuc([{ vote: true, other: true, features: { shape: 1 } }], 'shape')).toBeUndefined();
  });
});

describe('the sign test', () => {
  it('is the exact two-sided binomial on the discordant pairs', () => {
    expect(signTest(3, 1)).toBeCloseTo(0.625, 10);
    expect(signTest(9, 0)).toBeCloseTo(2 / 512, 10);
    expect(signTest(0, 0)).toBe(1);
    expect(signTest(1, 1)).toBe(1);
  });
});

describe('two ways of answering one pool', () => {
  const arm = (id: string, name: string, passed: boolean, pool: readonly ReplayCandidate[]) => ({ id, arm: name, passed, candidates: pool });
  const pool = (right: boolean) => [candidate('a', 'x', right), candidate('b', 'y', !right)];

  it('puts every paired case in exactly one of four cells', () => {
    const artifact = {
      cases: [
        arm('1', 'select-cross-pooled-vote', true, pool(true)),
        arm('1', 'select-cross', true, pool(true)),
        arm('2', 'select-cross-pooled-vote', true, pool(true)),
        arm('2', 'select-cross', false, pool(true)),
        arm('3', 'select-cross-pooled-vote', false, pool(true)),
        arm('3', 'select-cross', true, pool(true)),
        arm('4', 'select-cross-pooled-vote', false, pool(false)),
        arm('4', 'select-cross', false, pool(false)),
      ],
    };
    expect(trustOf(artifact, 'select-cross')).toMatchObject({
      cases: 4,
      both: 1,
      voteOnly: 1,
      otherOnly: 1,
      neither: 1,
      p: 1,
    });
  });

  it('compares only the questions both arms scored', () => {
    // An arm that dropped a case would otherwise be counted as a disagreement about a case it
    // never held — the same defect `verifyRule` refuses one call up.
    const artifact = {
      cases: [
        arm('1', 'select-cross-pooled-vote', true, pool(true)),
        arm('1', 'select-cross', false, pool(true)),
        arm('2', 'select-cross-pooled-vote', true, pool(true)),
      ],
    };
    expect(trustOf(artifact, 'select-cross')).toMatchObject({ cases: 1, voteOnly: 1, otherOnly: 0, both: 0 });
  });

  it('ranks the features that could act on the disagreement, most separable first', () => {
    const reading = trustOf(
      {
        cases: [
          // Where the other arm is right, the pool found three results; where the vote is right,
          // one. A router reading `distinct` would see the difference perfectly on this sample.
          arm('1', 'select-cross-pooled-vote', false, [candidate('a', 'x', true), candidate('b', 'y', false), candidate('c', 'z', false)]),
          arm('1', 'select-cross', true, [candidate('a', 'x', true), candidate('b', 'y', false), candidate('c', 'z', false)]),
          arm('2', 'select-cross-pooled-vote', true, [candidate('a', 'x', true), candidate('b', 'x', false), candidate('c', 'x', false)]),
          arm('2', 'select-cross', false, [candidate('a', 'x', true), candidate('b', 'x', false), candidate('c', 'x', false)]),
        ],
      },
      'select-cross',
    );
    expect(reading.features[0]).toEqual({ name: 'distinct', auc: 1 });
    expect(reading.features.every((entry) => entry.auc >= 0 && entry.auc <= 1)).toBe(true);
  });
});

describe('the command line reading a composition and a pair', () => {
  const capture = async (argv: readonly string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'pool-replay-'));
    const path = join(dir, 'artifact.json');
    writeFileSync(
      path,
      JSON.stringify({
        cases: [
          { id: '1', arm: 'select-cross-pooled-vote', passed: true, candidates: [candidate('a', 'x', true), candidate('b', 'y', false)] },
          { id: '1', arm: 'select-cross', passed: false, candidates: [candidate('a', 'x', true), candidate('b', 'y', false)] },
        ],
      }),
    );
    const out: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    const code = await main(['node', 'pool-replay.mjs', path, ...argv]);
    stdout.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    return { code, text: out.join('') };
  };

  it('prints the composition table only when it is asked for', async () => {
    expect((await capture([])).text).not.toContain('pool composition');
    const withTable = await capture(['--compositions']);
    expect(withTable.text).toContain('pool composition: what each subset of the pool buys');
    expect(withTable.text).toContain('2 calls  a+b');
  });

  it('prints the 2x2 and the feature ranking when a second arm is named', async () => {
    const { code, text } = await capture(['--trust', 'select-cross']);
    expect(code).toBe(0);
    expect(text).toContain('vote vs select-cross-pooled-vote → select-cross: 1 paired cases');
    expect(text).toContain('vote only 1');
  });

  it('reads no artifact path from the value of --trust', async () => {
    // The arm name is a value, not a file: a parser that treated it as positional would try to
    // open a file called `select-cross` and the run would fail on the wrong thing.
    const { code } = await capture(['--trust', 'select-cross', '--arm', 'select-cross']);
    expect(code).toBe(0);
  });
});
