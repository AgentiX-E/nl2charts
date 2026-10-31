/**
 * The condition census: which gold condition the statement never names a column of.
 *
 * Two properties carry this instrument and both are asserted as regressions, because both were
 * live defects during its first hour:
 *
 * 1. A gold statement written in upper case must be read. `predicateAtoms` splits on lowercase
 *    keywords, and the first version handed it the raw statement — so 207 of 220 failures were
 *    compared against a gold the reader had decided had no conditions, and the census reported
 *    13 missing conditions where the truth was 80.
 * 2. An alias must not decide the reading. `t1.segment` and `customers.segment` are one column,
 *    and a reader that compared the text would report a missing condition on every case where
 *    the model chose a different alias — which is most of them.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  atomIdentifiers,
  conditionLines,
  conditionPath,
  conditionProblems,
  hasCounterpart,
  isEntry,
  ladderBuckets,
  main,
  missingConditions,
  resolveConditionSettings,
  runConditions,
  tallyConditions,
  writeConditionArtifact,
} from '../eval/bird/conditions.js';
import type { ConditionRow } from '../eval/bird/conditions.js';
import { MINI_DB, writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();

describe('reading the identifiers of one condition', () => {
  it('keeps the qualifier, because two tables can have a column of the same name', () => {
    expect(atomIdentifiers("t1.segment = 'lam'")).toEqual(['t1.segment']);
  });

  it('drops keywords and operators and keeps the column', () => {
    expect(atomIdentifiers('cast(strftime(\'%y\', pa.date) as integer) between 2013 and 2015')).toEqual([
      'strftime',
      'pa.date',
      'integer',
    ]);
  });

  it('treats a column named like a keyword as a column', () => {
    // `date` is not in the keyword list, `end` is: a column called `end` is spelled by its
    // table instead, which is why the qualifier is what this function keeps.
    expect(atomIdentifiers("t.end = 'x'")).toEqual(['t.end']);
  });
});

describe('whether a gold condition has a counterpart', () => {
  it('says yes when any written atom uses the same column', () => {
    expect(hasCounterpart("t1.segment = 'lam'", ["t1.segment = 'sme'"])).toBe(true);
  });

  it('says no when the column is filtered on nothing', () => {
    expect(hasCounterpart("t1.segment = 'lam'", ["t1.currency = 'czk'"])).toBe(false);
  });

  it('says no when the statement filters on nothing at all', () => {
    expect(hasCounterpart("t1.segment = 'lam'", [])).toBe(false);
  });
});

describe('the conditions a statement never names', () => {
  it('reads a gold statement written in upper case', () => {
    // The regression the first run of this file shipped: `WHERE`/`AND` are invisible to a
    // splitter that matches lowercase keywords, and an empty gold list is the answer "complete".
    expect(missingConditions("SELECT name FROM t WHERE T1.Segment = 'LAM' AND T1.Currency = 'CZK'", 'select name from t')).toEqual([
      "t1.currency = 'czk'",
      "t1.segment = 'lam'",
    ]);
  });

  it('does not report a condition the statement wrote against another alias', () => {
    expect(
      missingConditions('SELECT c.name FROM customers c WHERE c.segment = \'LAM\'', "select customers.name from customers where customers.segment = 'LAM'"),
    ).toEqual([]);
  });

  it('reports a value written differently as written, not as missing', () => {
    // Same column, different literal: this is the spelling family, priced elsewhere. Filing it
    // here would make the census into a count of wrong literals and hide the column-level gap.
    expect(missingConditions("select name from t where segment = 'LAM'", "select name from t where segment = 'SME'")).toEqual([]);
  });

  it('sorts the conditions, so two runs print the same list', () => {
    // `predicateAtoms` sorts, which is what lets `a and b` equal `b and a` everywhere else in
    // this directory; the census inherits that order rather than inventing a second one.
    expect(missingConditions('select a from t where x = 1 and y = 2 and z = 3', 'select a from t where y = 9')).toEqual(['x = 1', 'z = 3']);
    expect(missingConditions('select a from t where z = 3 and x = 1', 'select a from t where y = 9')).toEqual(['x = 1', 'z = 3']);
  });

  it('does not treat a literal both statements happen to share as a column', () => {
    // `segment = 'lam'` and `country = 'lam'` share a value and no column.
    expect(missingConditions("select a from t where segment = 'LAM'", "select a from t where country = 'LAM'")).toEqual(["segment = 'lam'"]);
  });

  it('reports nothing when the gold states no condition', () => {
    expect(missingConditions('select count(*) from t', 'select count(*) from t')).toEqual([]);
  });
});

describe('the tally', () => {
  const row = (missing: string[], bucket?: string): ConditionRow => ({ id: '1', missing, stated: 1, ...(bucket === undefined ? {} : { bucket }) });

  it('counts the cases that miss at least one condition and the conditions themselves', () => {
    const tally = tallyConditions([row(['a']), row([]), row(['a', 'b'])]);
    expect(tally).toMatchObject({ total: 3, missingSome: 2, missingNone: 1, atoms: 3 });
  });

  it('groups by ladder bucket when one was supplied, and lumps the rest under unknown', () => {
    const tally = tallyConditions([row(['a'], 'predicate'), row([], 'predicate'), row(['b'], 'tables'), row(['c'])]);
    expect(tally.byBucket.predicate).toEqual({ cases: 2, missing: 1 });
    expect(tally.byBucket.tables).toEqual({ cases: 1, missing: 1 });
    expect(tally.byBucket.unknown).toEqual({ cases: 1, missing: 1 });
  });

  it('reports an empty corpus as zeros', () => {
    expect(tallyConditions([])).toMatchObject({ total: 0, missingSome: 0, atoms: 0, byBucket: {} });
  });
});

describe('the ladder artifact the buckets are joined from', () => {
  it('reads ids and buckets, and ignores rows that do not carry both', () => {
    const map = ladderBuckets({ rows: [{ id: '1', bucket: 'predicate' }, { id: '2' }, { bucket: 'tables' }] });
    expect([...map.entries()]).toEqual([['1', 'predicate']]);
  });

  it('reads an artifact with no rows as an empty map rather than throwing', () => {
    expect(ladderBuckets({}).size).toBe(0);
  });
});

describe('what makes the reading unpublishable', () => {
  const none = { unknownQuestion: 0, unretained: 0, unreadableLadder: 0 };

  it('fails when a failed case names a question the split does not hold', () => {
    expect(conditionProblems({ total: 1, missingSome: 1, missingNone: 0, atoms: 1, byBucket: {} }, { ...none, unknownQuestion: 1 })[0]).toContain(
      '1 failed cases name a question',
    );
  });

  it('fails when the ladder was supplied and could not be read', () => {
    expect(conditionProblems({ total: 1, missingSome: 1, missingNone: 0, atoms: 1, byBucket: {} }, { ...none, unreadableLadder: 1 })[0]).toContain(
      'no case carries a bucket',
    );
  });

  it('fails a corpus where not one failure is missing a condition', () => {
    expect(conditionProblems({ total: 4, missingSome: 0, missingNone: 4, atoms: 0, byBucket: {} }, none)[0]).toContain(
      'not one failure is missing a condition',
    );
  });

  it('passes a corpus with a low share, because the share is the finding', () => {
    expect(conditionProblems({ total: 4, missingSome: 1, missingNone: 3, atoms: 1, byBucket: {} }, none)).toEqual([]);
  });

  it('passes an empty reading rather than dividing by zero', () => {
    expect(conditionProblems({ total: 0, missingSome: 0, missingNone: 0, atoms: 0, byBucket: {} }, none)).toEqual([]);
  });
});

describe('the lines a reader sees', () => {
  const outcome = {
    split: 'minidev',
    arm: 'inline+evidence',
    scored: 496,
    rows: [],
    tally: tallyConditions([
      { id: '1', missing: ['a'], stated: 1, bucket: 'predicate' },
      { id: '2', missing: [], stated: 1, bucket: 'tables' },
    ]),
    drops: { unknownQuestion: 0, unretained: 0, unreadableLadder: 0 },
    problems: [],
  };

  it('prints both shares, the atom count and the buckets', () => {
    const lines = conditionLines(outcome).join('\n');
    expect(lines).toContain('2 failures of 496 scored');
    expect(lines).toContain('no condition on a column the gold filters: 1  50.0%');
    expect(lines).toContain('predicate');
    expect(lines).toContain('1 cases,    1 missing a condition');
  });

  it('prints zeros rather than nothing for an empty reading', () => {
    const empty = { ...outcome, tally: tallyConditions([]) };
    expect(conditionLines(empty).join('\n')).toContain('0.0%');
  });

  it('prints a failure line for a problem', () => {
    expect(conditionLines({ ...outcome, problems: ['COND: nope'] }).join('\n')).toContain('FAILED COND: nope');
  });
});

describe('the entry, run the way a workflow runs it', () => {
  function dataset(): string {
    const dir = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'cond-')));
    const file = join(dir, 'mini_dev_sqlite.json');
    const questions = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
    questions.push(
      { question_id: 94, db_id: MINI_DB, question: 'Which pens are cheap?', evidence: '', SQL: "SELECT name FROM items WHERE name = 'pen' AND price < 2", difficulty: 'simple' },
      { question_id: 95, db_id: MINI_DB, question: 'How many orders are there?', evidence: '', SQL: 'select count(*) from orders', difficulty: 'simple' },
    );
    writeFileSync(file, JSON.stringify(questions));
    return dir;
  }

  const body = (predicted: Record<string, string>): unknown => ({
    split: 'minidev',
    model: 'deepseek-chat',
    arms: [{ arm: 'inline+evidence' }],
    cases: [
      ...Object.keys(predicted).map((id) => ({ arm: 'inline+evidence', id, passed: false, reason: 'predicate' })),
      { arm: 'inline+evidence', id: '1', passed: true, reason: 'match' },
    ],
    failures: { 'inline+evidence': Object.entries(predicted).map(([id, sql]) => ({ id, predicted: sql, reason: 'predicate' })) },
  });

  function settingsFor(data: string, reportBody: unknown, extra: readonly string[] = []): ReturnType<typeof resolveConditionSettings> {
    const dir = mkdtempSync(join(tmpdir(), 'cond-report-'));
    const path = join(dir, 'bird-eval.json');
    writeFileSync(path, JSON.stringify(reportBody));
    return resolveConditionSettings({ BIRD_SPLIT: 'minidev', BIRD_DATA: data }, [path, '--arm', 'inline+evidence', ...extra], ROOT);
  }

  it('reads every failure end to end and names the missing condition', async () => {
    const data = dataset();
    const settings = settingsFor(data, body({ '94': "select name from items where name = 'pen'" }));
    const outcome = runConditions(settings);
    expect(outcome.tally.total).toBe(1);
    expect(outcome.rows[0]?.missing).toEqual(['price < 2']);
    expect(outcome.rows[0]?.stated).toBe(2);
    expect(outcome.problems).toEqual([]);
    // A case that passed is not a failure: the census reads the failures only.
    expect(outcome.scored).toBe(2);
  });

  it('joins a ladder artifact so the reading is per bucket', async () => {
    const data = dataset();
    const ladderDir = mkdtempSync(join(tmpdir(), 'cond-ladder-'));
    const ladder = join(ladderDir, 'values-gap.json');
    writeFileSync(ladder, JSON.stringify({ rows: [{ id: '94', bucket: 'predicate' }] }));
    const outcome = runConditions(settingsFor(data, body({ '94': "select name from items where name = 'pen'" }), ['--ladder', ladder]));
    expect(outcome.rows[0]?.bucket).toBe('predicate');
    expect(outcome.tally.byBucket.predicate).toEqual({ cases: 1, missing: 1 });
  });

  it('reports an unreadable ladder rather than lumping every case under unknown', async () => {
    const data = dataset();
    const missing = join(mkdtempSync(join(tmpdir(), 'cond-ladder-')), 'nope.json');
    const outcome = runConditions(settingsFor(data, body({ '94': "select name from items where name = 'pen'" }), ['--ladder', missing]));
    expect(outcome.drops.unreadableLadder).toBe(1);
    expect(outcome.rows[0]?.bucket).toBeUndefined();
    expect(outcome.problems[0]).toContain('could not be read');
  });

  it('counts a failure whose question the split does not hold', async () => {
    const data = dataset();
    const outcome = runConditions(settingsFor(data, { ...(body({}) as object), cases: [{ arm: 'inline+evidence', id: '900', passed: false }], failures: { 'inline+evidence': [{ id: '900', predicted: 'select 1' }] } }));
    expect(outcome.drops.unknownQuestion).toBe(1);
  });

  it('counts a failure the artifact kept no statement for', async () => {
    const data = dataset();
    const outcome = runConditions(
      settingsFor(data, { ...(body({}) as object), cases: [{ arm: 'inline+evidence', id: '94', passed: false }], failures: { 'inline+evidence': [] } }),
    );
    expect(outcome.drops.unretained).toBe(1);
  });

  it('refuses an arm the artifact does not hold', () => {
    const data = dataset();
    const settings = settingsFor(data, body({}));
    expect(() => runConditions({ ...settings, arm: 'select' })).toThrow(/has no arm select/);
  });

  it('resolves the flags, and rejects one without a value', () => {
    const env = { BIRD_SPLIT: 'minidev', BIRD_DATA: '/data' };
    expect(resolveConditionSettings(env, ['/r.json'], ROOT)).toMatchObject({ arm: 'metadata+evidence', report: '/r.json', strict: false });
    expect(resolveConditionSettings(env, ['/r.json', '--ladder', '/l.json'], ROOT).ladder).toBe('/l.json');
    expect(resolveConditionSettings(env, ['--ladder', '/l.json', '/r.json'], ROOT).report).toBe('/r.json');
    expect(() => resolveConditionSettings({}, ['/r.json', '--arm'], ROOT)).toThrow('--arm needs a name');
    expect(() => resolveConditionSettings({}, ['/r.json', '--ladder'], ROOT)).toThrow('--ladder needs a path');
    expect(() => resolveConditionSettings({}, ['--strict'], ROOT)).toThrow('usage');
  });

  it('writes one artifact per arm, with a name safe for a path', () => {
    const data = dataset();
    const settings = settingsFor(data, body({ '94': "select name from items where name = 'pen'" }));
    const outcome = runConditions(settings);
    const path = writeConditionArtifact(settings, outcome);
    expect(path).toBe(conditionPath(settings));
    expect(path).toContain('conditions-inline+evidence.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ arm: 'inline+evidence', scored: 2 });
    expect(conditionPath({ ...settings, arm: 'select-cross@second' })).toContain('conditions-select-cross-second.json');
  });

  it('exits zero for a measurement and non-zero for a gate that lost its input', () => {
    const data = dataset();
    const env = { BIRD_SPLIT: 'minidev', BIRD_DATA: data };
    const settings = settingsFor(data, body({ '94': "select name from items where name = 'pen'" }));
    expect(main([settings.report, '--arm', 'inline+evidence'], ROOT, env)).toBe(0);
    const broken = settingsFor(data, {
      ...(body({}) as object),
      cases: [{ arm: 'inline+evidence', id: '900', passed: false }],
      failures: { 'inline+evidence': [{ id: '900', predicted: 'select 1' }] },
    });
    expect(main([broken.report, '--arm', 'inline+evidence'], ROOT, env)).toBe(0);
    expect(main([broken.report, '--arm', 'inline+evidence', '--strict'], ROOT, env)).toBe(1);
  });

  it('answers whether it is the program', () => {
    const own = new URL('../eval/bird/conditions.ts', import.meta.url).href;
    expect(isEntry(new URL('../eval/bird/conditions.ts', import.meta.url).pathname, own)).toBe(true);
    expect(isEntry(new URL('../eval/bird/gap.ts', import.meta.url).pathname, own)).toBe(false);
    expect(isEntry(undefined, own)).toBe(false);
  });
});
