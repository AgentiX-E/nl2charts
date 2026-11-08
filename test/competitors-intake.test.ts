/**
 * The intake table, checked the way the coordinates are: by refusing the shapes that read as a
 * conclusion but are not one.
 *
 * The cases below are mostly the four statuses and the fields each one owes. A status without its
 * fields is the failure mode this file exists for — `released` without a commit is a branch that
 * moves under a number, `partial` without a withheld list invites running a repository and calling
 * the result the system, and `paper-only` without a mechanism list turns a rebuild into an
 * invention. Each of those produces a table row rather than an error unless something checks.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  COPY_PLAN,
  COPY_PLAN_LABEL,
  INTAKE_STATUS,
  NO_LICENSE,
  assertIntake,
  copyPlan,
  intakeGaps,
  intakeLines,
  intakeProblems,
  isEntrypoint,
  main,
  parseIntake,
  todayOf,
} from '../eval/competitors/intake.js';
import type { IntakeClaim } from '../eval/competitors/intake.js';

const TODAY = '2026-11-08';
const COMMIT = '3d6e835f858d26885d21d4bc0215aeecf855efbe';

const released: IntakeClaim = {
  system: 'released-one',
  status: 'released',
  repo: 'owner/repo',
  commit: COMMIT,
  license: 'Apache-2.0',
  evidence: 'https://github.com/owner/repo',
  checkedAt: TODAY,
};

const partial: IntakeClaim = {
  system: 'partial-one',
  status: 'partial',
  repo: 'owner/partial',
  commit: COMMIT,
  license: 'Apache-2.0',
  evidence: 'https://github.com/owner/partial',
  checkedAt: TODAY,
  released: ['schema-engine'],
  withheld: ['selector'],
};

const paperOnly: IntakeClaim = {
  system: 'paper-one',
  status: 'paper-only',
  paper: 'arXiv:2505.19988',
  evidence: 'https://arxiv.org/abs/2505.19988',
  checkedAt: TODAY,
  mechanisms: ['profiling', 'linking'],
};

const unreproducible: IntakeClaim = {
  system: 'ghost-one',
  status: 'unreproducible',
  evidence: 'https://example.com/leaderboard',
  checkedAt: TODAY,
  reason: 'a leaderboard row with no submission and no paper',
};

const errorsOf = (claims: readonly IntakeClaim[], today = TODAY): readonly string[] =>
  intakeProblems(claims, today)
    .filter((problem) => problem.level === 'error')
    .map((problem) => problem.line);

describe('the four statuses and what each one owes', () => {
  it('accepts one well-formed claim per status', () => {
    expect(errorsOf([released, partial, paperOnly, unreproducible])).toEqual([]);
  });

  it('refuses a status outside the four', () => {
    const claim = { ...released, status: 'open-source' as IntakeClaim['status'] };
    expect(errorsOf([claim])).toEqual(['status "open-source" is not one of released, partial, paper-only, unreproducible']);
  });

  it('refuses evidence that is not a URL, because a status has to be checkable', () => {
    expect(errorsOf([{ ...released, evidence: 'the leaderboard' }])).toEqual([
      'evidence "the leaderboard" is not a URL, so the status cannot be checked',
    ]);
  });

  it('accepts a 40-character sha and refuses anything shorter', () => {
    expect(errorsOf([{ ...released, commit: COMMIT.slice(0, 7) }])).toEqual([
      `released: commit "${COMMIT.slice(0, 7)}" is not a 40-character sha, so the code moves under the number`,
    ]);
  });

  it('refuses a released system with no repository and no licence', () => {
    const lines = errorsOf([{ ...released, repo: undefined, license: undefined }]);
    expect(lines).toContain('released: no repository, so there is nothing to check out');
    expect(lines).toContain('released: no licence, so the copy cannot be shipped');
  });

  it('refuses a partial system that names no module it does not ship', () => {
    expect(errorsOf([{ ...partial, withheld: [] }])).toEqual([
      'partial: names no withheld module, so a reader cannot tell what is missing',
    ]);
  });

  it('refuses a partial system that names no module it ships', () => {
    expect(errorsOf([{ ...partial, released: [] }])).toEqual([
      'partial: names no released module, so it is paper-only',
    ]);
  });

  it('refuses a module claimed as both released and withheld', () => {
    expect(errorsOf([{ ...partial, withheld: ['schema-engine'] }])).toEqual([
      'partial: schema-engine is both released and withheld',
    ]);
  });

  it('refuses a partial system with no repository and no licence', () => {
    const lines = errorsOf([{ ...partial, repo: undefined, license: undefined }]);
    expect(lines).toContain('partial: no repository, so there is nothing to run');
    expect(lines).toContain('partial: no licence, so the released half cannot be shipped');
  });

  it('refuses a partial system without a pinned commit', () => {
    const lines = errorsOf([{ ...partial, commit: undefined }]);
    expect(lines).toEqual(['partial: commit "undefined" is not a 40-character sha']);
  });

  it('refuses a paper-only system with no paper, a malformed identifier, and no mechanism', () => {
    expect(errorsOf([{ ...paperOnly, paper: undefined }])).toEqual([
      'paper-only: no paper, so there is nothing to rebuild from',
    ]);
    expect(errorsOf([{ ...paperOnly, paper: 'a paper I read' }])).toEqual([
      'paper-only: paper "a paper I read" is neither arXiv:<id> nor a URL',
    ]);
    expect(errorsOf([{ ...paperOnly, mechanisms: [] }])).toEqual([
      'paper-only: names no mechanism, so a rebuild has no checklist',
    ]);
  });

  it('accepts a URL in place of an arXiv id', () => {
    expect(errorsOf([{ ...paperOnly, paper: 'https://example.com/paper.pdf' }])).toEqual([]);
  });

  it('refuses an unreproducible claim with no reason', () => {
    expect(errorsOf([{ ...unreproducible, reason: undefined }])).toEqual([
      'unreproducible: no reason, which is indistinguishable from "not looked for"',
    ]);
  });
});

describe('dates and duplication', () => {
  it('refuses a date that is not YYYY-MM-DD', () => {
    expect(errorsOf([{ ...released, checkedAt: '8 November 2026' }])).toEqual([
      'checkedAt "8 November 2026" is not YYYY-MM-DD',
    ]);
  });

  it('refuses a date after today, because a status dated by intent was not read', () => {
    expect(errorsOf([{ ...released, checkedAt: '2026-11-09' }])).toEqual([
      'checkedAt 2026-11-09 is after today (2026-11-08), so nothing was read',
    ]);
  });

  it('accepts today', () => {
    expect(errorsOf([{ ...released, checkedAt: TODAY }])).toEqual([]);
  });

  it('refuses the same system twice, because which status wins would be order', () => {
    expect(errorsOf([released, { ...paperOnly, system: 'released-one' }])).toEqual([
      'system "released-one" appears twice, so which status wins is order',
    ]);
  });
});

describe('a licence nobody wrote is a warning and not an error', () => {
  it('warns that MAC-SQL may be run and not redistributed', () => {
    const problems = intakeProblems([{ ...released, license: NO_LICENSE }], TODAY);
    expect(problems).toEqual([
      {
        level: 'warning',
        system: 'released-one',
        line: 'licence is none declared: the code may be run locally and may not be redistributed',
      },
    ]);
  });

  it('does not stop the gate', () => {
    expect(() => assertIntake([{ ...released, license: NO_LICENSE }], TODAY)).not.toThrow();
  });
});

describe('the copy plan, which is what the status is for', () => {
  it('maps every status onto exactly one verb', () => {
    expect(INTAKE_STATUS.map((status) => copyPlan({ ...released, status }))).toEqual([
      'run',
      'run-shell',
      'rebuild',
      'cite',
    ]);
    expect(new Set(COPY_PLAN).size).toBe(4);
  });

  it('labels each verb with what a table may claim', () => {
    expect(COPY_PLAN.map((plan) => COPY_PLAN_LABEL[plan])).toEqual([
      'run their code',
      'run the released half, rebuild the rest',
      'rebuild the paper’s mechanisms',
      'cite only',
    ]);
  });
});

describe('the gaps between what is claimed and what is pinned', () => {
  const pins = { 'released-one': { repo: 'owner/repo', commit: COMMIT } };

  it('reports a released system that is not pinned', () => {
    const gaps = intakeGaps([released, { ...partial, repo: 'owner/other' }], {});
    expect(gaps.unpinned).toEqual(['released-one']);
    expect(gaps.unclaimed).toEqual([]);
  });

  it('accepts a released system pinned by the same commit', () => {
    expect(intakeGaps([released], pins).unpinned).toEqual([]);
  });

  it('accepts a released system pinned under a different repository name', () => {
    const gaps = intakeGaps([{ ...released, repo: 'Owner/Repo' }], pins);
    expect(gaps.unpinned).toEqual([]);
  });

  it('reports a pin whose question was never written down', () => {
    const gaps = intakeGaps([released], { ...pins, orphan: { repo: 'owner/orphan', commit: COMMIT } });
    expect(gaps.unclaimed).toEqual(['orphan']);
  });

  it('never reports a paper-only system as unpinned, because there is nothing to pin', () => {
    expect(intakeGaps([paperOnly, unreproducible], {}).unpinned).toEqual([]);
  });
});

describe('the table', () => {
  it('says an empty intake prices nothing', () => {
    expect(intakeLines([])).toEqual(['no systems: an intake with nothing in it prices nothing']);
  });

  it('renders one row per system with its verb and its date', () => {
    const lines = intakeLines([released, partial, paperOnly, unreproducible]);
    expect(lines[0]).toBe('| system | status | what copying it produces | as of |');
    expect(lines[2]).toBe('| released-one | released | run their code | 2026-11-08 |');
    expect(lines[3]).toBe('| partial-one | partial | run the released half, rebuild the rest | 2026-11-08 |');
    expect(lines).toHaveLength(6);
  });
});

describe('reading the file', () => {
  const parse = (raw: unknown): readonly IntakeClaim[] => parseIntake(raw, 'intake.json');

  it('refuses a document that is not a list', () => {
    expect(() => parse({ system: 'one' })).toThrow('intake.json is not a list of systems');
  });

  it('refuses an empty list', () => {
    expect(() => parse([])).toThrow('intake.json is empty, so it declares no system');
  });

  it('refuses an entry that is not an object', () => {
    expect(() => parse(['released'])).toThrow('intake.json[0] is not an object');
  });

  it('names the missing field and where', () => {
    expect(() => parse([{ status: 'released' }])).toThrow('intake.json[0] is missing the system');
  });

  it('refuses a field that is present but not a list', () => {
    expect(() => parse([{ ...paperOnly, mechanisms: 'profiling' }])).toThrow(
      'intake.json[0].mechanisms is not a list of strings',
    );
  });

  it('refuses a mechanism list that is not a list of strings', () => {
    expect(() => parse([{ ...paperOnly, mechanisms: [1, 2] }])).toThrow(
      'intake.json[0].mechanisms is not a list of strings',
    );
  });

  it('keeps the optional lists it was given and leaves the rest undefined', () => {
    const [claim] = parse([partial]);
    expect(claim?.released).toEqual(['schema-engine']);
    expect(claim?.mechanisms).toBeUndefined();
  });
});

describe('the file this repository ships', () => {
  const claims = parseIntake(
    JSON.parse(readFileSync(join(process.cwd(), 'eval/competitors/intake.json'), 'utf8')),
    'intake.json',
  );
  const byName = new Map(claims.map((claim) => [claim.system, claim]));

  it('passes its own gate', () => {
    expect(() => assertIntake(claims, TODAY)).not.toThrow();
  });

  it('files AskData as a paper with five mechanisms and no release', () => {
    const askdata = byName.get('AskData');
    expect(askdata?.status).toBe('paper-only');
    expect(askdata?.mechanisms).toHaveLength(5);
    expect(askdata?.repo).toBeUndefined();
    expect(copyPlan(askdata as IntakeClaim)).toBe('rebuild');
  });

  it('files the one leader with a repository and a withheld selector as partial', () => {
    const agentar = byName.get('Agentar-Scale-SQL');
    expect(agentar?.status).toBe('partial');
    expect(agentar?.withheld).toContain('sql-selection');
    expect(copyPlan(agentar as IntakeClaim)).toBe('run-shell');
  });

  it('files the two systems this repository has actually run as released', () => {
    expect(copyPlan(byName.get('MAC-SQL') as IntakeClaim)).toBe('run');
    expect(copyPlan(byName.get('CHESS') as IntakeClaim)).toBe('run');
  });
});

describe('todayOf and the command', () => {
  it('renders a date without a time', () => {
    expect(todayOf(new Date('2026-11-08T22:05:01Z'))).toBe('2026-11-08');
  });

  it('prints the table and exits zero', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main([])).toBe(0);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('throws every error at once, naming the system and the rule', () => {
    expect(() => assertIntake([{ ...released, commit: 'deadbeef' }], TODAY)).toThrow(
      /intake refused:\n {2}released-one: released: commit "deadbeef" is not a 40-character sha/,
    );
  });

  it('exits one under --strict on a tree with a broken claim', () => {
    const root = mkdtempSync(join(tmpdir(), 'intake-'));
    mkdirSync(join(root, 'eval/competitors'), { recursive: true });
    writeFileSync(join(root, 'eval/competitors/intake.json'), JSON.stringify([{ ...released, commit: 'abc' }]));
    writeFileSync(join(root, 'eval/competitors/pins.json'), JSON.stringify({}));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main([], root)).toBe(0);
      expect(main(['--strict'], root)).toBe(1);
      expect(log.mock.calls.flat().join('\n')).toContain('released and unpinned: released-one');
      expect(main([], root)).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it('does not treat an import as a script, and does treat the entrypoint as one', () => {
    expect(isEntrypoint('file:///repo/eval/competitors/intake.ts', undefined)).toBe(false);
    expect(isEntrypoint('file:///repo/eval/competitors/intake.ts', '/repo/eval/competitors/intake.ts')).toBe(true);
    expect(isEntrypoint('file:///repo/eval/competitors/intake.ts', '/repo/other.ts')).toBe(false);
  });

  it('refuses a null entry', () => {
    expect(() => parseIntake([null], 'intake.json')).toThrow('intake.json[0] is not an object');
  });

  it('reports a released claim with no repository as unpinned, because nothing names it', () => {
    expect(intakeGaps([{ ...released, repo: undefined }], {}).unpinned).toEqual(['released-one']);
  });
});
