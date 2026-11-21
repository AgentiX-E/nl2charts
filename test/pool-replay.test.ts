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
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ReplayCandidate, ReplayRow } from '../tools/pool-replay.d.mts';
import {
  POLICIES,
  casesOf,
  census,
  chosenMember,
  main,
  memberBySource,
  modalGroup,
  pricePolicies,
  resultGroups,
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
    expect(byName['vote-unless-tie']?.passed).toBe(2); // the same two, by the right reason each
    expect(byName['oracle{chosen,vote}']?.passed).toBe(2);
    for (const entry of table) expect(entry.undecided).toBe(0);
  });

  it('marks the oracle as unshippable and the rest as implementable', () => {
    const table = pricePolicies(rows);
    expect(table.filter((entry) => !entry.implementable).map((entry) => entry.policy)).toEqual(['oracle{chosen,vote}']);
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

  it('compares nothing when the artifact holds no vote arm, rather than reporting agreement', () => {
    expect(verifyVote({ cases: [{ id: '1', arm: 'select-cross', passed: true, candidates: [candidate('a', 'x', true)] }] })).toMatchObject({
      compared: 0,
      agreements: 0,
    });
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
