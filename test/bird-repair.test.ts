/**
 * The repair probe, pinned on two things: the verdict arithmetic, and the gate.
 *
 * The end-to-end cases run a real SQLite file through the real oracle, because the whole
 * claim is about result sets — a stubbed execution would agree with whatever the probe was
 * written to expect. The fixture reproduces the shape that killed the ungated version of this
 * lever: a statement whose literal differs from the store only in case, and a gold answer that
 * is empty because of it.
 */
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isEntry,
  main,
  repairGapPath,
  repairLines,
  repairProblems,
  resolveRepairSettings,
  runRepair,
  tallyRepairs,
} from '../eval/bird/repair.js';
import type { RepairRow } from '../eval/bird/repair.js';
import { writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();

function dataset(extra: readonly Record<string, unknown>[] = []): string {
  const dir = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'repair-')));
  const file = join(dir, 'mini_dev_sqlite.json');
  const questions = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
  writeFileSync(file, JSON.stringify([...questions, ...extra]));
  return dir;
}

function settingsFor(data: string, body: unknown, argv: readonly string[] = []): ReturnType<typeof resolveRepairSettings> {
  const dir = mkdtempSync(join(tmpdir(), 'repair-report-'));
  const path = join(dir, 'bird-eval.json');
  writeFileSync(path, JSON.stringify(body));
  return resolveRepairSettings({ BIRD_SPLIT: 'minidev', BIRD_DATA: data }, [path, '--arm', 'select-cross', ...argv], ROOT);
}

/** A gold whose literal is spelled the way the table stores it, so a repaired statement can match. */
const caseGold = { question_id: 902, db_id: 'shop', question: 'Which items are pens?', evidence: '', SQL: "select name from items where name = 'pen'", difficulty: 'simple' };
/** A gold whose own literal is in the wrong case: the shape that killed the ungated repair. */
const brokenGold = { question_id: 900, db_id: 'shop', question: 'Which items are Pens?', evidence: '', SQL: "select name from items where name = 'Pen'", difficulty: 'simple' };
/** The statement the model wrote: same query, the value in the question's case rather than the store's. */
const emptyFailure = { id: '902', predicted: "select name from items where name = 'Pen'", reason: 'values' };

function report(failures: readonly { id: string; predicted: string; reason?: string }[], cases: readonly unknown[]): unknown {
  return {
    split: 'minidev',
    model: 'deepseek-chat',
    arms: [{ arm: 'select-cross', candidateRecall: 0 }],
    cases,
    failures: { 'select-cross': failures.map((entry) => ({ ...entry, reason: entry.reason ?? 'values' })) },
  };
}

const noAnswer = (id: string) => ({ arm: 'select-cross', id, passed: false, reason: 'values', candidateRecall: false });

describe('tallyRepairs', () => {
  it('counts one row per verdict', () => {
    const rows: RepairRow[] = [
      { id: 'a', substitutions: 1, verdict: 'fixed' },
      { id: 'b', substitutions: 2, verdict: 'fixed' },
      { id: 'c', substitutions: 1, verdict: 'still-wrong' },
      { id: 'd', substitutions: 1, verdict: 'still-wrong' },
    ];
    expect(tallyRepairs(rows)).toEqual({ fixed: 2, 'still-wrong': 2 });
  });

  it('counts nothing for an empty run', () => {
    expect(tallyRepairs([])).toEqual({ fixed: 0, 'still-wrong': 0 });
  });
});

describe('repairProblems', () => {
  it('passes when the repair is inert on gold and something was measured', () => {
    expect(repairProblems({ gold: { statements: 1534, changed: [] }, cases: { offered: 40, repaired: 10 } })).toEqual([]);
  });

  it('fails when the repair edits a gold statement', () => {
    const problems = repairProblems({ gold: { statements: 1534, changed: ['640'] }, cases: { offered: 1, repaired: 1 } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('1 of 1534');
    expect(problems[0]).toContain('640');
  });

  it('fails when no no-answer statement could be read', () => {
    expect(repairProblems({ gold: { statements: 10, changed: [] }, cases: { offered: 7, repaired: 0 } })).toEqual([
      'no no-answer statement could be read, so nothing was measured',
    ]);
  });

  it('passes a perfect run, where no statement was offered at all', () => {
    expect(repairProblems({ gold: { statements: 10, changed: [] }, cases: { offered: 0, repaired: 0 } })).toEqual([]);
  });
});

describe('the lines a reader sees', () => {
  const outcome = {
    split: 'dev',
    arm: 'select-cross',
    gold: { statements: 1534, empty: 0, changed: [] },
    cases: { offered: 40, repaired: 12, gated: 475 },
    rows: [],
    tally: { fixed: 6, 'still-wrong': 6 } as Record<'fixed' | 'still-wrong', number>,
    drops: { unretained: 0, unknownQuestion: 0, goldFailed: 0 },
    problems: [],
  };

  it('prints the gate, the repairs and the verdicts', () => {
    const lines = repairLines(outcome).join('\n');
    expect(lines).toContain('dev, arm select-cross');
    expect(lines).toContain('gold with no rows (gate)  0');
    expect(lines).toContain('failures with rows (gate) 475');
    expect(lines).toContain('failures with no rows     40');
    expect(lines).toContain('it rewrote                12');
    expect(lines).toContain('fixed                     6');
    expect(lines).toContain('still wrong               6');
  });
});

describe('the artifact path', () => {
  it('names the file after the arm', () => {
    const settings = resolveRepairSettings({}, ['report.json', '--arm', 'select-cross'], '/tmp/root');
    expect(repairGapPath(settings)).toBe(join('/tmp/root', 'eval', 'out', 'repair-select-cross.json'));
  });

  it('replaces the characters a shell would eat', () => {
    const settings = resolveRepairSettings({}, ['report.json', '--arm', 'select-mixed+dc'], '/tmp/root');
    expect(repairGapPath(settings)).toBe(join('/tmp/root', 'eval', 'out', 'repair-select-mixed+dc.json'));
  });
});

describe('resolveRepairSettings', () => {
  it('defaults the arm to select', () => {
    const settings = resolveRepairSettings({}, ['report.json'], '/tmp/root');
    expect(settings.arm).toBe('select');
    expect(settings.strict).toBe(false);
  });

  it('reads flags in either order', () => {
    const settings = resolveRepairSettings({}, ['--strict', 'report.json', '--arm', 'vote'], '/tmp/root');
    expect(settings.reportPath).toBe('report.json');
    expect(settings.arm).toBe('vote');
    expect(settings.strict).toBe(true);
  });

  it('refuses an arm flag with no name', () => {
    expect(() => resolveRepairSettings({}, ['report.json', '--arm'], '/tmp/root')).toThrow('--arm needs a name');
  });

  it('refuses to run without a report', () => {
    expect(() => resolveRepairSettings({}, ['--strict'], '/tmp/root')).toThrow('usage: repair.ts');
  });
});

describe('the entry, run the way a workflow runs it', () => {
  it('recovers a statement whose only error is the case of a stored value', async () => {
    const data = dataset([caseGold]);
    const settings = settingsFor(data, report([emptyFailure], [noAnswer('902')]));
    const outcome = await runRepair(settings);
    expect(outcome.gold.changed).toEqual([]);
    expect(outcome.gold.statements).toBeGreaterThan(0);
    expect(outcome.cases).toMatchObject({ offered: 1, repaired: 1 });
    expect(outcome.tally.fixed).toBe(1);
    expect(outcome.problems).toEqual([]);
  });

  it('leaves a statement that returned rows alone', async () => {
    const data = dataset([caseGold]);
    const settings = settingsFor(data, report([{ id: '902', predicted: 'select name from items' }], [noAnswer('902')]));
    const outcome = await runRepair(settings);
    expect(outcome.cases).toMatchObject({ offered: 0, repaired: 0, gated: 1 });
    expect(outcome.tally.fixed).toBe(0);
    // Nothing was offered and nothing was rewritten, which is not the same as "nothing measured".
    expect(outcome.problems).toEqual([]);
  });

  it('reports a gold statement that the gate offers and the repair edits', async () => {
    const data = dataset([brokenGold]);
    const settings = settingsFor(data, report([emptyFailure], [noAnswer('902')]));
    const outcome = await runRepair(settings);
    // The gold returns nothing because its own literal is in the wrong case, so the gate
    // offers it and the repair rewrites it: this is the measured reason the gate exists.
    expect(outcome.gold).toMatchObject({ empty: 1, changed: ['900'] });
    expect(outcome.problems[0]).toContain('900');
  });

  it('counts a case whose question is not in the split', async () => {
    const data = dataset([caseGold]);
    const settings = settingsFor(data, report([], [noAnswer('999')]));
    const outcome = await runRepair(settings);
    expect(outcome.drops.unknownQuestion).toBe(1);
  });

  it('counts a no-answer case whose statement was not retained', async () => {
    const data = dataset([caseGold]);
    const settings = settingsFor(data, report([], [noAnswer('902')]));
    const outcome = await runRepair(settings);
    expect(outcome.drops.unretained).toBe(1);
  });

  it('counts a case whose gold cannot run', async () => {
    const data = dataset([
      { question_id: 901, db_id: 'shop', question: 'A gold that cannot run', evidence: '', SQL: 'select nope from items', difficulty: 'simple' },
    ]);
    const settings = settingsFor(data, report([{ id: '901', predicted: "select name from items where name = 'Pen'" }], [noAnswer('901')]));
    const outcome = await runRepair(settings);
    expect(outcome.drops.goldFailed).toBe(1);
    expect(outcome.cases.repaired).toBe(1);
  });

  it('counts a statement the engine refuses rather than repairing it', async () => {
    const data = dataset([caseGold]);
    const settings = settingsFor(data, report([{ id: '902', predicted: 'select nope from items' }], [noAnswer('902')]));
    const outcome = await runRepair(settings);
    expect(outcome.cases).toMatchObject({ offered: 0, repaired: 0, gated: 1 });
  });

  it('counts a failure entry with no statement text', async () => {
    const data = dataset([caseGold]);
    const settings = settingsFor(data, report([{ id: '902', predicted: undefined as unknown as string }], [noAnswer('902')]));
    expect((await runRepair(settings)).drops.unretained).toBe(1);
  });

  it('grounds a qualified column through the table its alias names', async () => {
    const data = dataset([caseGold]);
    const settings = settingsFor(data, report([{ id: '902', predicted: `select f.name from items f where f.name = 'Pen'` }], [noAnswer('902')]));
    const outcome = await runRepair(settings);
    expect(outcome.cases.repaired).toBe(1);
    expect(outcome.tally.fixed).toBe(1);
  });

  it('does not repair a statement the engine would not run in the first place', async () => {
    const data = dataset([caseGold]);
    const settings = settingsFor(data, report([{ id: '902', predicted: `select name from items where nope = 'Pen'` }], [noAnswer('902')]));
    // `nope` is not a column of `items`, so the statement never returned "no rows" — it never
    // ran, and a domain read for a column that does not exist would be a second failure to
    // report as if it were a finding.
    expect((await runRepair(settings)).cases).toMatchObject({ offered: 0, repaired: 0, gated: 1 });
  });

  it('asks for a column once when two questions read it', async () => {
    const data = dataset([
      caseGold,
      { question_id: 905, db_id: 'shop', question: 'Which items are cups?', evidence: '', SQL: "select name from items where name = 'cup'", difficulty: 'simple' },
    ]);
    const settings = settingsFor(
      data,
      report(
        [
          { id: '902', predicted: `select name from items where name = 'Pen'` },
          { id: '905', predicted: `select name from items where name = 'Cup'` },
        ],
        [noAnswer('902'), noAnswer('905')],
      ),
    );
    const outcome = await runRepair(settings);
    // The second read of `items.name` comes from the cache: one `select distinct` serves both.
    expect(outcome.cases.repaired).toBe(2);
    expect(outcome.tally.fixed).toBe(2);
  });

  it('skips a qualifier that is not one of the statement aliases', async () => {
    const data = dataset([caseGold]);
    const settings = settingsFor(
      data,
      report([{ id: '902', predicted: `select i.name from items i, orders o where o.item_id = 1 and i.name = 'Pen'` }], [noAnswer('902')]),
    );
    // `orders` is a comma join, which `tableRefs` does not read, so `o.` names a table the
    // reader cannot resolve. The unqualified `i.name` site still grounds.
    const outcome = await runRepair(settings);
    expect(outcome.cases.repaired).toBe(1);
  });

  it('offers a statement whose literal is already stored, and changes nothing', async () => {
    const data = dataset([caseGold]);
    const settings = settingsFor(data, report([{ id: '902', predicted: 'select name from items where id = 999' }], [noAnswer('902')]));
    const outcome = await runRepair(settings);
    expect(outcome.cases).toMatchObject({ offered: 1, repaired: 0 });
  });

  it('refuses an artifact that holds no cases', async () => {
    // The other half of the same rule: an artifact that predates the `cases` field has nothing
    // to offer, and a repair loop that reports "nothing to repair" about it is reporting a run
    // that did not happen.
    const data = dataset([caseGold]);
    const settings = settingsFor(data, { split: 'minidev', model: 'deepseek-chat', failures: { 'select-cross': [] } });
    await expect(runRepair(settings)).rejects.toThrow(/holds no cases, so arm select-cross cannot be measured/);
  });

  it('refuses an arm the artifact does not hold', async () => {
    // The corpus below names `select-cross`; asking for `select` used to build an empty
    // offered set and report a repair loop that had nothing to do, which is a claim about a
    // run that did not happen.
    const data = dataset([caseGold]);
    const settings = settingsFor(data, report([emptyFailure], [noAnswer('902')]));
    await expect(runRepair({ ...settings, arm: 'select' })).rejects.toThrow(
      /has no arm select; it holds select-cross/,
    );
  });

  it('reads a run in which nothing failed', async () => {
    // The artifact of a run where every case passed: the cases are there and `failures` is
    // empty. A report with no cases at all is a different state and is refused before here.
    const data = dataset([caseGold]);
    const settings = settingsFor(data, { split: 'minidev', model: 'deepseek-chat', cases: [{ arm: 'select-cross', id: '901', passed: true }] });
    const outcome = await runRepair(settings);
    expect(outcome.cases).toMatchObject({ offered: 0, repaired: 0, gated: 0 });
    expect(outcome.problems).toEqual([]);
  });

  it('compares a null cell without turning it into the word null', async () => {
    const data = dataset([
      { question_id: 903, db_id: 'shop', question: 'The largest price above 100', evidence: '', SQL: 'select max(price) from items where price > 100', difficulty: 'simple' },
    ]);
    const settings = settingsFor(data, report([{ id: '903', predicted: `select name from items where name = 'Pen'` }], [noAnswer('903')]));
    const outcome = await runRepair(settings);
    expect(outcome.rows).toEqual([{ id: '903', substitutions: 1, verdict: 'still-wrong' }]);
  });

  it('offers a gold with no comparison but nothing to ground', async () => {
    const data = dataset([
      { question_id: 904, db_id: 'shop', question: 'A gold that returns nothing', evidence: '', SQL: 'select name from items where 0', difficulty: 'simple' },
    ]);
    // A run whose every case passed: the rows are there so the arm is in the artifact, and the
    // offered set is empty. A report with no rows at all is refused before here.
    const settings = settingsFor(data, report([], [{ arm: 'select-cross', id: '904', passed: true }]));
    const outcome = await runRepair(settings);
    expect(outcome.gold).toMatchObject({ empty: 1, changed: [] });
  });

  it('exits zero on a run with nothing to report', async () => {
    const data = dataset([caseGold]);
    const settings = settingsFor(data, report([emptyFailure], [noAnswer('902')]));
    expect(await main([settings.reportPath, '--arm', 'select-cross', '--strict'], ROOT, { BIRD_SPLIT: 'minidev', BIRD_DATA: data })).toBe(0);
  });

  it('exits zero without --strict and one with it when a gold statement was edited', async () => {
    const data = dataset([brokenGold]);
    const settings = settingsFor(data, report([emptyFailure], [noAnswer('902')]));
    const env = { BIRD_SPLIT: 'minidev', BIRD_DATA: data };
    expect(await main([settings.reportPath, '--arm', 'select-cross'], ROOT, env)).toBe(0);
    expect(await main([settings.reportPath, '--arm', 'select-cross', '--strict'], ROOT, env)).toBe(1);
  });
});

describe('isEntry', () => {
  it('recognises the module it was started as', () => {
    expect(isEntry('/tmp/repair.ts', 'file:///tmp/repair.ts')).toBe(true);
    expect(isEntry('/tmp/other.ts', 'file:///tmp/repair.ts')).toBe(false);
    expect(isEntry(undefined, 'file:///tmp/repair.ts')).toBe(false);
  });
});

describe('the fixture itself', () => {
  it('keeps a copy of the questions file so a later case cannot edit it in place', () => {
    const data = dataset();
    const copy = join(mkdtempSync(join(tmpdir(), 'repair-copy-')), 'questions.json');
    copyFileSync(join(data, 'mini_dev_sqlite.json'), copy);
    expect(JSON.parse(readFileSync(copy, 'utf8'))).toBeInstanceOf(Array);
  });
});
