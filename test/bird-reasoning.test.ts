import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  armProfile,
  armReadings,
  columnLabel,
  columnOf,
  main,
  readStatement,
  readsWildcard,
  reasoningLines,
  resolveReasoningSettings,
} from '../eval/bird/reasoning.js';

/**
 * The instrument answers one question: given the statements two models wrote on the same
 * questions, what did the stronger model do differently? Every assertion below is a reading
 * that has to survive an artifact without a model call behind it.
 */
describe('reading a wildcard out of a select list', () => {
  it('recognises the three spellings a model writes', () => {
    expect(readsWildcard('select * from singer')).toBe(true);
    expect(readsWildcard('SELECT DISTINCT * FROM singer')).toBe(true);
    expect(readsWildcard('select t.* from singer t')).toBe(true);
    expect(readsWildcard('select\n  *\nfrom singer')).toBe(true);
  });

  it('does not read count(*) as a wildcard, because it is one column', () => {
    // The difference matters: `count(*)` is the narrowest possible answer to "how many",
    // and a rule that counted it here would report a wildcard rate the model never had.
    expect(readsWildcard('select count(*) from singer')).toBe(false);
    expect(readsWildcard('select count(*) as n, avg(age) from singer')).toBe(false);
  });

  it('does not read a named list as a wildcard', () => {
    expect(readsWildcard('select name, age from singer')).toBe(false);
    expect(readsWildcard('select t.name from singer t')).toBe(false);
  });
});

describe('naming the column an item carries', () => {
  it('takes the last identifier, so an aggregate is named by its argument', () => {
    expect(columnOf('count(distinct t1.name)')).toBe('name');
    expect(columnOf('sum(t.amount)')).toBe('amount');
    expect(columnOf('"Name"')).toBe('name');
  });

  it('drops arithmetic to the column it reads', () => {
    expect(columnOf('a.id + 1')).toBe('id');
    expect(columnOf('t.price * t.qty')).toBe('qty');
  });

  it('returns nothing for a constant, which names no column', () => {
    expect(columnOf('1')).toBe('');
    expect(columnOf("'x'")).toBe('');
  });
});

describe('comparing one statement with the gold', () => {
  it('names the columns a wider statement added, and where they came from', () => {
    // The failure shape this instrument exists for: the answer is right in every other
    // respect and the statement carried the grouping key out with it.
    const reading = readStatement({
      arm: 'reasoner',
      id: '7',
      reason: 'column-count',
      predicted: 'select country, count(*) from singer where age > 40 group by country',
      gold: 'select count(*) from singer where age > 40 group by country',
    });
    expect(reading.extra).toEqual(['country']);
    expect(reading.extraFromKey).toEqual(['country']);
    expect(reading.missing).toEqual([]);
    expect(reading.predicted).toBe(2);
    expect(reading.gold).toBe(1);
  });

  it('names a key column taken from a predicate as coming from the key set', () => {
    const reading = readStatement({
      arm: 'reasoner',
      id: '8',
      reason: 'column-count',
      predicted: 'select name, age from singer where age > 40',
      gold: 'select name from singer where age > 40',
    });
    expect(reading.extra).toEqual(['age']);
    // `age` is not grouped, but it is a column the statement already had to name to filter.
    // Counting it here is the difference between "the model invented a column" and "the model
    // carried a column it had already read".
    expect(reading.extraFromKey).toEqual(['age']);
  });

  it('names a column the answer needed and the statement left out', () => {
    const reading = readStatement({
      arm: 'chat',
      id: '9',
      reason: 'column-count',
      predicted: 'select name from singer',
      gold: 'select name, age from singer',
    });
    expect(reading.missing).toEqual(['age']);
    expect(reading.extra).toEqual([]);
  });

  it('records a wildcard as the widest possible answer rather than as a wide list', () => {
    const reading = readStatement({
      arm: 'reasoner',
      id: '10',
      reason: 'column-count',
      predicted: 'select * from singer',
      gold: 'select name, age from singer',
    });
    expect(reading.wildcard).toBe(true);
    // A wildcard has no item list to compare, so nothing is named as extra; the flag is the
    // reading, and inventing an item for it would put a guess in a column of measurements.
    expect(reading.extra).toEqual([]);
    expect(reading.predicted).toBe(0);
  });

  it('keeps a reply that is not a statement as an empty projection, not as a match', () => {
    const reading = readStatement({
      arm: 'reasoner',
      id: '11',
      reason: 'error',
      predicted: 'I am not able to answer this question.',
      gold: 'select name from singer',
    });
    expect(reading.predicted).toBe(0);
    expect(reading.missing).toEqual(['name']);
    expect(reading.wildcard).toBe(false);
  });

  it('qualifies nothing when both statements read one table', () => {
    // `t.name` and `name` are the same instruction; a difference the parser invented would
    // fill this instrument with formatting and hide the columns that actually moved.
    const reading = readStatement({
      arm: 'chat',
      id: '12',
      reason: 'match',
      predicted: 'select t.name, t.age from singer t',
      gold: 'select name, age from singer',
    });
    expect(reading.extra).toEqual([]);
    expect(reading.missing).toEqual([]);
  });
});

describe('reading a case row into a statement reading', () => {
  const row = (over: Record<string, unknown>) => ({
    arm: 'inline',
    id: 1,
    reason: 'values',
    sql: 'select name from t',
    gold: 'select name from t',
    ...over,
  });

  it('skips a row that recorded no statement rather than inventing an empty one', () => {
    expect(armReadings([{ arm: 'inline', id: 1, passed: false, reason: 'values' }], 'inline')).toEqual([]);
    expect(armReadings([row({ gold: undefined })], 'inline')).toEqual([]);
  });

  it('derives the reason from the verdict when the row carries none', () => {
    // `reason` is written by the judges that produce it; a pair of arms written by an older
    // artifact has only `passed`, and reading a wrong answer as `match` would flip the sign of
    // every reasoning comparison built on it.
    expect(armReadings([row({ reason: undefined, passed: true })], 'inline')[0]?.reason).toBe('match');
    expect(armReadings([row({ reason: undefined, passed: false })], 'inline')[0]?.reason).toBe('unknown');
    expect(armReadings([row({ reason: undefined })], 'inline')[0]?.reason).toBe('unknown');
  });

  it('leaves the token count absent when the row metered no completion', () => {
    expect(armReadings([row({ tokens: {} })], 'inline')[0]?.completionTokens).toBeUndefined();
    expect(armReadings([row({ tokens: { completion: 0 } })], 'inline')[0]?.completionTokens).toBe(0);
    expect(armReadings([row({})], 'inline')[0]?.completionTokens).toBeUndefined();
  });
});

describe('summarising an arm', () => {
  const rows = [
    readStatement({ arm: 'a', id: '1', reason: 'match', predicted: 'select name from t', gold: 'select name from t' }),
    readStatement({
      arm: 'a',
      id: '2',
      reason: 'column-count',
      predicted: 'select name, id from t where id > 3',
      gold: 'select name from t where id > 3',
    }),
    readStatement({ arm: 'a', id: '3', reason: 'column-count', predicted: 'select * from t', gold: 'select name, id from t' }),
    readStatement({ arm: 'b', id: '1', reason: 'match', predicted: 'select name from t', gold: 'select name from t' }),
  ];

  it('counts the directions separately, because wider and narrower are different repairs', () => {
    const profile = armProfile(rows, 'a');
    expect(profile.cases).toBe(3);
    expect(profile.wildcard).toBe(1);
    expect(profile.wider).toBe(1);
    expect(profile.same).toBe(1);
    expect(profile.narrower).toBe(0);
  });

  it('counts extra items and how many of them the statement had already read', () => {
    const profile = armProfile(rows, 'a');
    expect(profile.extraItems).toBe(1);
    expect(profile.extraFromKey).toBe(1);
    expect(profile.missingItems).toBe(2);
  });

  it('reports an arm with no rows as a zero reading rather than as an error', () => {
    const profile = armProfile(rows, 'absent');
    expect(profile.cases).toBe(0);
    expect(profile.wildcard).toBe(0);
    expect(profile.wider).toBe(0);
    // No metered case is not a mean of zero: the caller prints "not reported" from the count,
    // and the mean is only read when the count is non-zero.
    expect(profile.completionCases).toBe(0);
    expect(profile.completionMean).toBe(0);
  });
});

describe('printing the comparison', () => {
  const rows = [
    readStatement({
      arm: 'chat',
      id: '1',
      reason: 'column-count',
      predicted: 'select name from t where age > 3',
      gold: 'select name, age from t where age > 3',
      completionTokens: 49,
    }),
    readStatement({
      arm: 'reasoner',
      id: '1',
      reason: 'column-count',
      predicted: 'select name, age from t where age > 3',
      gold: 'select name, age from t where age > 3',
      completionTokens: 500,
    }),
  ];

  it('puts both arms on one line per quantity so a reader compares, not scrolls', () => {
    const lines = reasoningLines([armProfile(rows, 'chat'), armProfile(rows, 'reasoner')]);
    // The arms are named once, in the header, and every row below carries both values in that
    // order — a reader compares across a line instead of scrolling between two blocks.
    expect(lines[0]).toContain('chat');
    expect(lines[0]).toContain('reasoner');
    const width = lines.find((line) => line.includes('wider than gold'));
    expect(width?.match(/\d+ +\d+\.\d%/g)?.length).toBe(2);
  });

  it('says so when an arm carries no reasoning figure instead of printing zero', () => {
    // `0` and "the endpoint does not report a chain of thought" are different measurements,
    // and this repository has published one as the other before.
    const silent = readStatement({
      arm: 'chat',
      id: '2',
      reason: 'match',
      predicted: 'select name from t',
      gold: 'select name from t',
    });
    const lines = reasoningLines([armProfile([silent], 'chat')]);
    expect(lines.some((line) => line.includes('generated tokens: mean') && line.includes('not reported'))).toBe(true);
  });
});

describe('the command line', () => {
  it('needs an artifact and at least one arm', () => {
    expect(() => resolveReasoningSettings(['--arms', 'a'], '/root')).toThrow(/usage: reasoning.ts/);
    expect(() => resolveReasoningSettings(['x.json'], '/root')).toThrow(/needs --arms/);
    expect(() => resolveReasoningSettings(['x.json', '--arms', ''], '/root')).toThrow(/at least one arm/);
  });

  it('refuses an --arms flag with nothing after it', () => {
    expect(() => resolveReasoningSettings(['x.json', '--arms'], '/root')).toThrow(/at least one arm/);
  });

  it('reads one path and the arm list', () => {
    const settings = resolveReasoningSettings(['x.json', '--arms', 'chat,reasoner'], '/root');
    expect(settings.reports).toEqual(['/root/x.json']);
    expect(settings.arms).toEqual(['chat', 'reasoner']);
  });

  it('reads more than one artifact, because two models are two dispatches', () => {
    // The endpoint is chosen per run, so chat and reasoner are always two files. Refusing the
    // second would make this instrument unable to answer the question it exists for.
    const settings = resolveReasoningSettings(['a.json', 'b.json', '--arms', 'inline'], '/root');
    expect(settings.reports).toEqual(['/root/a.json', '/root/b.json']);
  });

  it('labels a column by the model the artifact recorded, not by the file name', () => {
    expect(columnLabel({ model: 'deepseek-reasoner' }, '/tmp/b.json', 'inline', true)).toBe('deepseek-reasoner inline');
    // One artifact has nothing to disambiguate, so it keeps the arm name it always printed.
    expect(columnLabel({ model: 'deepseek-reasoner' }, '/tmp/b.json', 'inline', false)).toBe('inline');
    // An artifact that recorded no model falls back to the path, which is a fact about the file.
    const fallback = columnLabel({}, '/tmp/nowhere/b.json', 'inline', true);
    expect(fallback.endsWith('inline')).toBe(true);
  });

  const run = (args: readonly string[]) =>
    spawnSync(join('node_modules', '.bin', 'tsx'), ['eval/bird/reasoning.ts', ...args], {
      cwd: join(import.meta.dirname, '..'),
      encoding: 'utf8',
    });

  const artifactFile = (dir: string, name: string, model: string, rows: readonly unknown[]): string => {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify({ split: 'dev', model, cases: rows }));
    return file;
  };

  it('runs as a command and puts the two models on one table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reasoning-cli-'));
    const chat = artifactFile(dir, 'chat.json', 'deepseek-chat', [
      { arm: 'inline', id: 1, passed: false, reason: 'column-count', sql: 'select name from t', gold: 'select name, age from t', tokens: { completion: 49 } },
    ]);
    const reasoner = artifactFile(dir, 'reasoner.json', 'deepseek-reasoner', [
      { arm: 'inline', id: 1, passed: false, reason: 'column-count', sql: 'select name, age, id from t', gold: 'select name, age from t', tokens: { completion: 500 } },
    ]);
    const out = run([chat, reasoner, '--arms', 'inline']);
    expect(out.status).toBe(0);
    // The column is named by the model the artifact recorded, because that is the comparison.
    expect(out.stdout).toContain('deepseek-chat inline');
    expect(out.stdout).toContain('deepseek-reasoner inline');
    expect(out.stdout).toContain('wider than gold');
  });

  it('exits non-zero and says which state it is in when no statement was recorded', () => {
    // This is the state every artifact written before this round is in, so the instrument has
    // to name it rather than print a table of zeros that reads like a measurement.
    const dir = mkdtempSync(join(tmpdir(), 'reasoning-empty-'));
    const file = artifactFile(dir, 'old.json', 'deepseek-chat', [{ arm: 'inline', id: 1, passed: false, reason: 'values' }]);
    const errors: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation((line: unknown) => void errors.push(String(line)));
    expect(main([file, '--arms', 'inline'])).toBe(1);
    expect(errors.join('\n')).toContain('no case in this artifact recorded a statement');
    log.mockRestore();
    err.mockRestore();
  });

  it('exits non-zero and names the arm when one side has no recorded statement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reasoning-half-'));
    const file = artifactFile(dir, 'one.json', 'deepseek-chat', [
      { arm: 'inline', id: 1, passed: true, reason: 'match', sql: 'select name from t', gold: 'select name from t', tokens: { completion: 40 } },
    ]);
    const errors: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation((line: unknown) => void errors.push(String(line)));
    expect(main([file, '--arms', 'inline,absent'])).toBe(1);
    expect(errors.join('\n')).toContain('no recorded statement for absent');
    log.mockRestore();
    err.mockRestore();
  });

  it('prints a header for an artifact that recorded neither a split nor a model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reasoning-bare-'));
    const file = join(dir, 'bare.json');
    writeFileSync(
      file,
      JSON.stringify({ cases: [{ arm: 'inline', id: 1, passed: true, sql: 'select name from t', gold: 'select name from t' }] }),
    );
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    expect(main([file, '--arms', 'inline'])).toBe(0);
    expect(lines[0]).toContain('bare.json');
    expect(lines[0]).not.toContain('(');
    log.mockRestore();
  });

  it('returns zero and prints the comparison when every arm recorded a statement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reasoning-ok-'));
    const file = artifactFile(dir, 'both.json', 'deepseek-reasoner', [
      { arm: 'inline', id: 1, passed: false, reason: 'column-count', sql: 'select name, age, id from t where id > 2', gold: 'select name, age from t where id > 2', tokens: { completion: 500 } },
      { arm: 'inline', id: 2, passed: true, reason: 'match', sql: 'select name from t', gold: 'select name from t', tokens: { completion: 300 } },
    ]);
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    expect(main([file, '--arms', 'inline'])).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('wider than gold');
    // The one extra item on the wider statement came from the statement's own filter, and the
    // instrument says so rather than counting it as invented.
    expect(text).toContain('of which carried');
    log.mockRestore();
  });
});
