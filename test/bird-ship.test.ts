/**
 * The shipment instrument: the arithmetic it derives, the identity it enforces, and the self-test.
 *
 * `bench:bird:ship` is the only thing standing between "an arm won a run" and "the product sends
 * that arm's prompt", so its own failure modes are the interesting part. Three are tested here
 * because each one has already happened somewhere in this repository's history: a statistic that
 * disagreed with its counts, a check that could not fail, and a reader that accepted a file it did
 * not understand.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkShipment,
  deriveDecision,
  LEDGER_PATH,
  main,
  readLedger,
  selfTest,
} from '../eval/bird/ship.js';
import type { ShipmentRecord } from '@agentix-e/nl2charts-ai';
import type { ShipmentCheck } from '../eval/bird/ship.js';

const RECORD: ShipmentRecord = {
  run: '44991167518',
  dataset: 'bird-dev',
  incumbent: { arm: 'assembled', correct: 980, total: 1532, tokensPerCase: 587 },
  challenger: { arm: 'macsql-prompt', correct: 1010, total: 1532, tokensPerCase: 134 },
  paired: { onlyChallenger: 119, onlyIncumbent: 89 },
  note: 'the reading that put the MAC-SQL prompt in the product',
};

/** A file the reader can be pointed at, in a directory that exists for one test. */
function ledgerFile(name: string, content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'nl2charts-ship-'));
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

describe('the derived statistic', () => {
  it('takes p from the discordant counts and the interval into the gate units', () => {
    const derived = deriveDecision(RECORD);
    // The same number the reading published: 119:89 is p = 0.0441.
    expect(derived.p).toBeCloseTo(0.04408796929533684, 9);
    // Percentage points, positive when the challenger wins: +1.96pp with a lower bound above zero.
    expect(derived.ci.low).toBeCloseTo(0.113, 2);
    expect(derived.ci.high).toBeCloseTo(3.803, 2);
    expect(derived.ci.low).toBeGreaterThan(0);
    expect(derived.incumbent).toBe(RECORD.incumbent);
  });
});

describe('the check', () => {
  it('accepts a ledger whose fold is the recipe the product ships', () => {
    const checked = checkShipment([RECORD]);
    expect(checked.problems).toEqual([]);
    expect(checked.result.recipe).toBe('shipped-sql');
    expect(checked.result.steps[0]?.deltaPp).toBeCloseTo(1.958, 3);
  });

  it('fails when the product ships a recipe the ledger did not choose', () => {
    const checked = checkShipment([RECORD], 'assembled');
    expect(checked.result.recipe).toBe('shipped-sql');
    expect(checked.problems).toHaveLength(1);
    expect(checked.problems[0]).toContain("the ledger ends on 'shipped-sql' and the product ships 'assembled'");
  });

  it('carries the arithmetic problems up, prefixed with the run that produced them', () => {
    const tampered: ShipmentRecord = { ...RECORD, challenger: { ...RECORD.challenger, correct: 1009 } };
    const checked = checkShipment([tampered]);
    expect(checked.problems[0]).toContain('44991167518: the discordant counts imply 30 more correct answers, the arm totals 29');
    // The ledger still ends where it started, so the identity problem is reported as well: a build
    // should say everything that is wrong, not the first thing.
    expect(checked.problems).toHaveLength(2);
  });
});

describe('the reader', () => {
  it('reads the ledger this repository ships', () => {
    const records = readLedger(join(process.cwd(), LEDGER_PATH));
    expect(records).toHaveLength(1);
    expect(records[0]?.run).toBe('44991167518');
    expect(records[0]?.paired).toEqual({ onlyChallenger: 119, onlyIncumbent: 89 });
  });

  it.each([
    { name: 'not an object', body: '[]', message: 'not an object' },
    { name: 'a literal null', body: 'null', message: 'not an object' },
    { name: 'a string', body: '"a ledger"', message: 'not an object' },
    { name: 'a version it does not know', body: '{"schemaVersion":2,"decisions":[]}', message: 'schemaVersion 2' },
    { name: 'no decisions array', body: '{"schemaVersion":1,"decisions":{}}', message: "'decisions' is not an array" },
  ])('refuses $name rather than guessing', ({ body, message }) => {
    const path = ledgerFile('shipment.json', body);
    expect(() => readLedger(path)).toThrow(message);
  });
});

describe('the self-test', () => {
  it('accepts the real ledger and refuses four tampered ones', () => {
    expect(selfTest()).toEqual([]);
  });

  it('fails when the checker under test has stopped refusing anything', () => {
    // A self-test that cannot report failure is the defect it was written to catch, so the checker
    // is handed in and replaced with one that accepts everything: every probe must then be reported.
    const permissive = (): ShipmentCheck => ({ result: { steps: [], recipe: 'shipped-sql', moved: false }, problems: [] });
    const problems = selfTest(permissive);
    // Two problems a probe: it was accepted, and it ended on the wrong recipe.
    expect(problems).toHaveLength(8);
    expect(problems.filter((problem) => problem.includes('was accepted'))).toHaveLength(4);
    expect(problems.filter((problem) => problem.includes('ends on shipped-sql, not assembled'))).toHaveLength(4);
  });

  it('reports a refused reading and a fold that ended somewhere else, separately', () => {
    // The two ways the *shipped* reading can fail are different repairs: one is a count, the other
    // is a recipe. A self-test that folded them into one message would send a reader to the wrong
    // file.
    const wrong = (): ShipmentCheck => ({
      result: { steps: [], recipe: 'assembled', moved: false },
      problems: ['the discordant counts imply 30 more correct answers, the arm totals 29'],
    });
    const problems = selfTest(wrong);
    expect(problems[0]).toContain('the shipped reading was refused: the discordant counts imply');
    expect(problems[1]).toBe('the shipped reading ends on assembled');
  });
});

describe('the command', () => {
  it('prints the chain and exits zero on the ledger this repository ships', () => {
    const lines: string[] = [];
    const code = main([], (line) => lines.push(line));
    expect(code).toBe(0);
    expect(lines[0]).toContain('44991167518');
    expect(lines[0]).toContain('ship');
    expect(lines[1]).toBe('recipe: shipped-sql (moved)');
    expect(lines[2]).toContain('1 decision(s)');
  });

  it('reports the self-test as one accepted and four refused', () => {
    const lines: string[] = [];
    expect(main(['--self-test'], (line) => lines.push(line))).toBe(0);
    expect(lines.at(-1)).toBe('shipment self-test: 1 accepted, 4 refused');
  });

  it('exits non-zero when the self-test itself finds problems', () => {
    const lines: string[] = [];
    const permissive = (): ShipmentCheck => ({ result: { steps: [], recipe: 'shipped-sql', moved: false }, problems: [] });
    expect(main(['--self-test'], (line) => lines.push(line), permissive)).toBe(1);
    expect(lines.at(-1)).toBe('shipment self-test: 1 accepted, 4 refused, 8 problems');
  });

  it('runs as a command, which is how CI reads its exit code', () => {
    // The entry guard is the one branch a suite cannot reach by importing, so it is exercised the
    // way a reader would: the command, through `tsx`, in this repository.
    const result = spawnSync('npx', ['tsx', LEDGER_PATH.replace('shipment.json', 'ship.ts')], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('recipe: shipped-sql (moved)');
  });

  it('exits non-zero on a ledger whose fold is not the shipped recipe', () => {
    // The point of the command is the exit code, so the failure path is driven through the command
    // rather than through `checkShipment`: a tampered challenger count and a `--ledger` pointing at
    // it, which is the shape a future experiment would arrive in after a bad copy.
    const tampered = JSON.stringify({
      schemaVersion: 1,
      decisions: [{ ...RECORD, challenger: { ...RECORD.challenger, correct: 1009 } }],
    });
    const path = ledgerFile('tampered.json', tampered);
    const lines: string[] = [];
    expect(main(['--check', '--ledger', path], (line) => lines.push(line))).toBe(1);
    expect(lines.some((line) => line.includes('FAILED 44991167518: the discordant counts imply'))).toBe(true);
    expect(lines.some((line) => line.includes("the ledger ends on 'assembled'"))).toBe(true);
  });
});
