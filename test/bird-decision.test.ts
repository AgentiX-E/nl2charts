/**
 * The decision ledger, computed from case records without a model or a database.
 *
 * Every fixture here is a real shape from `eval/out/bird-eval.json`: a case carries its
 * candidates and each candidate carries the hash of the result it returned. The arithmetic
 * under test is the one the archived readings were read with, so the same numbers have to
 * come out of the same records.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decisionLedger,
  decisionLedgers,
  decisionLines,
  dispatch,
  main,
  modalGroup,
  readDecisionReport,
  resolveDecisionSettings,
  resultGroups,
} from '../eval/bird/decision.js';
import type { DecidedCase } from '../eval/bird/decision.js';

const candidate = (fingerprint: string, correct: boolean) => ({ fingerprint, correct });
const dispute = (id: string, passed: boolean, candidates: readonly { fingerprint: string; correct: boolean }[]): DecidedCase => ({
  id,
  arm: 'select-cross',
  passed,
  candidates,
});

describe('the opinions a candidate set contains', () => {
  it('splits on the result hash and keeps the drawing order, which the tie-break reads', () => {
    const groups = resultGroups([candidate('a', false), candidate('b', true), candidate('a', false)]);
    expect(groups).toEqual([
      { fingerprint: 'a', members: 2, correct: false, first: 1 },
      { fingerprint: 'b', members: 1, correct: true, first: 2 },
    ]);
  });

  it('credits a group as correct when any of its members matched, because they are one answer', () => {
    const groups = resultGroups([candidate('a', true), candidate('a', false)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ members: 2, correct: true });
  });

  it('reports no group for no candidate, which is a prompt that produced nothing', () => {
    expect(resultGroups([])).toEqual([]);
    expect(modalGroup([])).toBeUndefined();
  });

  it('returns the earliest group when two are the same size, as `majorityResult` does', () => {
    const groups = resultGroups([candidate('x', false), candidate('y', false), candidate('z', false)]);
    expect(modalGroup(groups)?.fingerprint).toBe('x');
  });

  it('returns the largest group even when it was drawn last', () => {
    const groups = resultGroups([candidate('x', false), candidate('y', true), candidate('y', true)]);
    expect(modalGroup(groups)?.fingerprint).toBe('y');
  });
});

describe('the ledger', () => {
  it('counts a case with no candidate apart instead of scoring it as a decision', () => {
    const ledger = decisionLedger([{ id: '1', arm: 'a', passed: false, candidates: [] }]);
    expect(ledger.unreadable).toBe(1);
    expect(ledger.disputed).toBe(0);
    expect(ledger.net).toBe(0);
  });

  it('treats one distinct result as free: both decisions return the same rows, pass or fail', () => {
    const ledger = decisionLedger([
      dispute('1', true, [candidate('a', true), candidate('a', true)]),
      dispute('2', false, [candidate('a', false), candidate('a', false)]),
    ]);
    expect(ledger.unanimous).toBe(2);
    expect(ledger.disputed).toBe(0);
    // A unanimous case contributes no discordant pair, so the test has nothing to reject.
    expect(ledger.p).toBe(1);
  });

  it('files the four outcomes of a disputed case, and only a disputed case can be discordant', () => {
    const ledger = decisionLedger([
      // Both right: two groups, the modal one correct and the selector correct.
      dispute('1', true, [candidate('a', true), candidate('b', false), candidate('a', true)]),
      // Only the selector right: it chose the one-member group.
      dispute('2', true, [candidate('a', false), candidate('b', true), candidate('a', false)]),
      // Only the modal group right: the selector chose the dissent.
      dispute('3', false, [candidate('a', true), candidate('b', false), candidate('a', true)]),
      // Neither right.
      dispute('4', false, [candidate('a', false), candidate('b', false)]),
    ]);
    expect(ledger).toMatchObject({
      cases: 4,
      disputed: 4,
      reachable: 3,
      both: 1,
      selectorOnly: 1,
      modalOnly: 1,
      neither: 1,
      net: 0,
    });
    // One discordant pair on each side is a coin-flip, so the exact test cannot reject.
    expect(ledger.p).toBe(1);
  });

  it('reports how often a 1:1:1 tie, not the count, decided the case', () => {
    const ledger = decisionLedger([
      dispute('1', true, [candidate('a', true), candidate('b', false), candidate('c', false)]),
      dispute('2', false, [candidate('a', false), candidate('b', false), candidate('c', true)]),
    ]);
    expect(ledger.ties).toBe(2);
    // The earliest group wins both ties: the first case is right for both decisions, the
    // second is wrong for both, so neither tie shows up as a discordant pair.
    expect(ledger).toMatchObject({ both: 1, neither: 1, selectorOnly: 0, modalOnly: 0 });
  });

  it('names the arm from the records, and quotes the net over every case in it', () => {
    const cases: DecidedCase[] = [
      ...Array.from({ length: 6 }, (_, index) =>
        dispute(String(index), false, [candidate('a', true), candidate('b', false), candidate('a', true)]),
      ),
      dispute('9', true, [candidate('a', true), candidate('b', false)]),
    ];
    const ledger = decisionLedger(cases);
    expect(ledger.arm).toBe('select-cross');
    expect(ledger.modalOnly).toBe(6);
    expect(ledger.net).toBe(6);
    expect(ledger.netShare).toBeCloseTo(6 / 7, 10);
    // Six against zero is the smallest disagreement a two-sided exact test calls at 5%.
    expect(ledger.p).toBeLessThan(0.05);
  });

  it('has no share to report when there is nothing to read', () => {
    const ledger = decisionLedger([], 'empty');
    expect(ledger).toMatchObject({ arm: 'empty', cases: 0, net: 0, netShare: 0, p: 1 });
  });

  it('takes the arm from the first record, and says nothing when there is no record', () => {
    expect(decisionLedger([dispute('1', true, [candidate('a', true)])]).arm).toBe('select-cross');
    expect(decisionLedger([]).arm).toBe('');
  });

  it('reads a case with no candidate field as a case with no candidate', () => {
    // A record written by an older harness has no `candidates` key at all, and treating that
    // as a dispute would invent an opinion the run never produced.
    const ledger = decisionLedger([{ id: '1', arm: 'a', passed: false }]);
    expect(ledger.unreadable).toBe(1);
  });
});

describe('every arm in a report', () => {
  it('groups by the arm the case records name, in the order they appear', () => {
    const ledgers = decisionLedgers({
      cases: [
        { id: '1', arm: 'a', passed: true, candidates: [candidate('x', true)] },
        { id: '2', arm: 'b', passed: true, candidates: [candidate('y', true)] },
        { id: '3', arm: 'a', passed: false, candidates: [candidate('x', false)] },
      ],
    });
    expect(ledgers.map((ledger) => ledger.arm)).toEqual(['a', 'b']);
    expect(ledgers[0]?.cases).toBe(2);
    expect(ledgers[1]?.cases).toBe(1);
  });

  it('reads a report with no cases as no arms rather than as one empty arm', () => {
    expect(decisionLedgers({})).toEqual([]);
  });
});

describe('the printed ledger', () => {
  const lines = (ledger: ReturnType<typeof decisionLedger>): string => decisionLines(ledger).join('\n');

  it('prints a p-value in plain decimals when it is readable', () => {
    const ledger = decisionLedger([dispute('1', false, [candidate('a', true), candidate('b', false), candidate('a', true)])]);
    const printed = decisionLines(ledger).find((line) => line.includes('exact McNemar'));
    // No discordant pair to reject: the exact test reports 1, not a rounded zero.
    expect(printed).toBe('  exact McNemar p                    1.0000');
  });

  it('prints a p-value in exponent form when decimals would round it to zero', () => {
    const cases = Array.from({ length: 17 }, (_, index) =>
      dispute(String(index), false, [candidate('a', true), candidate('b', false), candidate('a', true)]),
    );
    const ledger = decisionLedger(cases);
    expect(ledger.p).toBeLessThan(1e-4);
    expect(decisionLines(ledger).find((line) => line.includes('exact McNemar'))).toMatch(/e-5/);
  });

  it('states the net in cases and in points of the arm', () => {
    const ledger = decisionLedger([
      dispute('1', false, [candidate('a', true), candidate('b', false), candidate('a', true)]),
      dispute('2', true, [candidate('x', true)]),
    ]);
    expect(lines(ledger)).toContain('1 cases (50.00pp)');
  });
});

describe('the command line', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
    vi.restoreAllMocks();
  });

  const report = (path: string): void => {
    const body = {
      cases: [
        { id: '1', arm: 'select-cross', passed: true, candidates: [candidate('a', true)] },
        { id: '2', arm: 'vote-cross', passed: false, candidates: [candidate('b', false)] },
      ],
    };
    writeFileSync(path, JSON.stringify(body));
  };

  it('reads one arm when asked for one', () => {
    root = mkdtempSync(join(tmpdir(), 'decision-'));
    const path = join(root, 'report.json');
    report(path);
    const printed: string[] = [];
    expect(main([path, '--arm', 'vote-cross'], (line) => printed.push(line))).toBe(0);
    expect(printed.join('\n')).toContain('vote-cross');
    expect(printed.join('\n')).not.toContain('select-cross');
  });

  it('reads every arm when the flag is absent', () => {
    root = mkdtempSync(join(tmpdir(), 'decision-'));
    const path = join(root, 'report.json');
    report(path);
    const printed: string[] = [];
    expect(main([path], (line) => printed.push(line))).toBe(0);
    expect(printed.join('\n')).toContain('select-cross');
    expect(printed.join('\n')).toContain('vote-cross');
  });

  it('refuses an arm the report does not carry, rather than printing nothing', () => {
    root = mkdtempSync(join(tmpdir(), 'decision-'));
    const path = join(root, 'report.json');
    report(path);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(main([path, '--arm', 'missing'])).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain('no arm named missing');
  });

  it('names the missing argument instead of reading a file called `--arm`', () => {
    expect(() => resolveDecisionSettings(['report.json', '--arm'])).toThrow(/--arm needs a name/);
    expect(() => resolveDecisionSettings([])).toThrow(/usage: decision\.ts/);
  });

  it('resolves a path and an arm from argv', () => {
    expect(resolveDecisionSettings(['r.json'])).toEqual({ reportPath: 'r.json', arm: undefined });
    expect(resolveDecisionSettings(['--arm', 'x', 'r.json'])).toEqual({ reportPath: 'r.json', arm: 'x' });
  });

  it('reads a report from disk', () => {
    root = mkdtempSync(join(tmpdir(), 'decision-'));
    const path = join(root, 'report.json');
    report(path);
    expect(readDecisionReport(path).cases).toHaveLength(2);
  });

});

describe('the entry point', () => {
  it('does nothing when the program is another file', () => {
    expect(dispatch(undefined, 'file:///x.js', [])).toBeUndefined();
    expect(dispatch('/tmp/other.js', 'file:///tmp/x.js', [])).toBeUndefined();
  });

  it('runs when the program is this file, and returns what the run returned', () => {
    expect(dispatch('/tmp/x.js', 'file:///tmp/x.js', [], () => undefined, () => undefined, () => 7)).toBe(7);
  });

  it('reports a thrown message instead of a stack trace, and fails the process', () => {
    const printed: string[] = [];
    const code = dispatch(
      '/tmp/x.js',
      'file:///tmp/x.js',
      [],
      () => undefined,
      (line) => printed.push(line),
      () => {
        throw new Error('bad report');
      },
    );
    expect(code).toBe(1);
    expect(printed).toEqual(['bad report']);
  });

  it('prints a thrown non-Error as its own text', () => {
    const printed: string[] = [];
    expect(
      dispatch(
        '/tmp/x.js',
        'file:///tmp/x.js',
        [],
        () => undefined,
        (line) => printed.push(line),
        () => {
          throw 'plain';
        },
      ),
    ).toBe(1);
    expect(printed).toEqual(['plain']);
  });
});
