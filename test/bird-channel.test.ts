import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  channelArtifact,
  channelKind,
  channelLines,
  channelProblems,
  channelTable,
  isEntry,
  main,
  resolveChannelSettings,
  runChannel,
  strictRequested,
  writeChannelArtifact,
} from '../eval/bird/channel.js';
import type { ChannelCase, ChannelReportShape } from '../eval/bird/channel.js';

/**
 * The instrument that reads a report's own taxonomy back against its own evidence.
 *
 * Every fixture below is a row from run 43262574193 or a row the artifact can hold after the fix.
 * The six that matter are the prose replies reported as `guard` with `unsupported character "?"`
 * as the reason — the report was describing a refusal that never happened.
 */
const prose = 'Let me recall: in SQLite, NULLs sort first. So the answer needs a subquery? Maybe not.';

const row = (over: Partial<ChannelCase>): ChannelCase => ({ arm: 'inline+evidence', id: '1', passed: false, ...over });

describe('what the reply was, before what was said about it', () => {
  it('reads a statement, a paragraph and nothing apart', () => {
    expect(channelKind(row({ sql: 'SELECT region FROM orders' }))).toBe('statement');
    expect(channelKind(row({ sql: prose }))).toBe('prose');
    expect(channelKind(row({ sql: '   ' }))).toBe('empty');
    expect(channelKind(row({ sql: undefined }))).toBe('empty');
  });

  it('counts a statement the guard bans as a statement', () => {
    // The bytes are a write attempt. Calling it prose would put a dangerous reply in the same
    // bucket as an unreadable one, and the two need different fixes.
    expect(channelKind(row({ sql: 'DELETE FROM orders' }))).toBe('statement');
  });
});

describe('a refusal that contradicts its own case', () => {
  it('catches the six from the pro run: guard claimed over prose', () => {
    const report: ChannelReportShape = {
      split: 'minidev',
      model: 'deepseek-v4-pro',
      cases: [row({ id: '1198', sql: prose, errorKind: 'guard', error: 'model could not produce a safe statement: guard: unclassified-statement (unsupported character "?")' })],
    };
    const [arm] = channelTable(report);
    expect(arm?.misattributed).toHaveLength(1);
    expect(arm?.misattributed[0]).toMatchObject({ id: '1198', claimed: 'guard', actual: 'prose' });
    expect(arm?.misattributed[0]?.why).toContain('prose');
  });

  it('catches a guard claim over an empty reply', () => {
    const [arm] = channelTable({ cases: [row({ sql: '', errorKind: 'guard', error: 'guard: empty-statement' })] });
    expect(arm?.misattributed[0]).toMatchObject({ claimed: 'guard', actual: 'empty' });
  });

  it('catches a shape claim over a reply that held a statement', () => {
    const [arm] = channelTable({
      cases: [row({ sql: 'SELECT region FROM orders', errorKind: 'shape', error: 'shape: the reply holds no statement (26 chars)' })],
    });
    expect(arm?.misattributed[0]).toMatchObject({ claimed: 'shape', actual: 'statement' });
  });

  it('leaves the result-shape failure alone', () => {
    // `shape: the question asks for a single value, but the statement returned 1436 rows` is a
    // legitimate shape failure of a statement that ran. It carries a statement and must not be
    // reported as a contradiction, or the instrument would demand the bug back.
    const [arm] = channelTable({
      cases: [row({ sql: 'SELECT region, count(*) FROM orders GROUP BY 1', errorKind: 'shape', error: 'shape: the question asks for a single value' })],
    });
    expect(arm?.misattributed).toEqual([]);
  });

  it('leaves a truncated statement alone when the shape claim was about the cut', () => {
    const [arm] = channelTable({
      cases: [row({ sql: 'SELECT region FROM orders', errorKind: 'shape', truncated: true, error: 'shape: the reply stopped at the token cap' })],
    });
    expect(arm?.misattributed).toEqual([]);
  });

  it('does not test claims the bytes cannot contradict', () => {
    const [arm] = channelTable({
      cases: [
        row({ sql: prose, errorKind: 'execution', error: 'execution: no such column: p.CreationDate' }),
        row({ sql: '', errorKind: 'llm', error: 'llm: 429' }),
        row({ id: 'x', sql: prose, errorKind: 'harness', error: 'harness: pool missing' }),
      ],
    });
    expect(arm?.misattributed).toEqual([]);
  });
});

describe('the table, and what makes it unpublishable', () => {
  const rowsOf = (cases: readonly ChannelCase[]) => channelTable({ split: 'minidev', model: 'm', cases });

  it('counts the failures by the kind the report published', () => {
    const [arm] = rowsOf([
      row({ id: '1', sql: 'SELECT 1', passed: true }),
      row({ id: '2', sql: prose, errorKind: 'shape', error: 'shape: the reply holds no statement' }),
      row({ id: '3', sql: 'SELECT 1', errorKind: 'execution', error: 'execution: boom' }),
      row({ id: '4', sql: 'SELECT 1', truncated: true, passed: true }),
    ]);
    expect(arm).toMatchObject({ scored: 4, failed: 2, attributed: 2, truncated: 1 });
    expect(arm?.byKind).toEqual({ shape: 1, execution: 1 });
  });

  it('refuses a taxonomy that does not add up to the score', () => {
    // A failed case with neither an error nor a kind leaves the column silently, and a column with
    // a silent exit cannot be summed. The pro artifact's `reason` was absent on exactly these rows.
    const problems = channelProblems(rowsOf([row({ id: '1', sql: prose })]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('1 failed cases with no kind');
  });

  it('names the case, the claim and the bytes', () => {
    const problems = channelProblems(rowsOf([row({ id: '1198', sql: prose, errorKind: 'guard', error: 'guard: unclassified-statement' })]));
    expect(problems.some((line) => line.includes('case 1198 is reported as guard but its reply is prose'))).toBe(true);
  });

  it('says nothing when every refusal agrees with its reply', () => {
    const rows = rowsOf([
      row({ id: '1', sql: 'DROP TABLE t', errorKind: 'guard', error: 'guard: unclassified-statement' }),
      row({ id: '2', sql: prose, errorKind: 'shape', error: 'shape: the reply holds no statement' }),
    ]);
    expect(channelProblems(rows)).toEqual([]);
    expect(channelLines(rows).at(-1)).toBe('every refusal agrees with the reply behind it');
  });

  it('summarises the disagreements rather than leaving them in the rows', () => {
    const lines = channelLines(rowsOf([row({ id: '9', sql: prose, errorKind: 'guard', error: 'guard: x' })]));
    expect(lines.at(-1)).toContain('1 refusal(s) name a cause the bytes do not support');
  });

  it('reads a row whose fields are not the shapes the type promises', () => {
    // The artifact is JSON: a field can arrive as a number, and a case can arrive with no id at
    // all. Both are things a reader has to survive rather than assert about — an instrument that
    // throws on one malformed row reports nothing about the other 6,447.
    const rows = channelTable({
      cases: [
        { arm: 'a', id: '1', passed: false, sql: 'SELECT 1', errorKind: 7 as unknown as string, reason: 'values' },
        { arm: 'a', passed: false, sql: prose, errorKind: 'guard', error: 'guard: x' },
      ],
    });
    expect(rows[0]?.attributed).toBe(2);
    expect(rows[0]?.misattributed.map((entry) => entry.id)).toEqual(['?']);
    expect(channelProblems(rows)).toHaveLength(1);
  });

  it('counts a result reason as an attribution, which is what the pro run showed', () => {
    // 215 of 496 pro cases failed: five carried `errorKind`, 210 carried `reason: values|column-count`.
    // A rule that counted only the channel kinds reported 210 unexplained failures on a report that
    // had explained every one of them — the instrument inventing the defect it hunts.
    const [arm] = rowsOf([row({ id: '1', sql: 'SELECT 1', reason: 'values' })]);
    expect(arm?.attributed).toBe(1);
    expect(channelProblems([arm!])).toEqual([]);
  });

  it('tests the truncation claim against its own message', () => {
    // `truncated` is the one bucket whose repair is a number, so its message has to carry the fact
    // that makes a number the repair. Published without it, the reader is sent to the endpoint —
    // which is what the report did for 50 of 366 calls under the old single code.
    const named = rowsOf([
      row({ id: '1', sql: '', errorKind: 'truncated', error: 'cut at the answer budget (finish_reason=length, budgets tried: 4096 -> 8192)' }),
    ]);
    expect(channelProblems(named)).toEqual([]);
    const anonymous = rowsOf([row({ id: '2', sql: '', errorKind: 'truncated', error: 'llm response is empty' })]);
    expect(channelProblems(anonymous)[0]).toContain('truncated names a reply cut at the answer budget');
    // ...and the reverse, because a budget cut filed under the outage bucket is the defect this
    // instrument was extended for.
    const misfiled = rowsOf([row({ id: '3', sql: '', errorKind: 'llm', error: 'llm response was cut (finish_reason=length)' })]);
    expect(channelProblems(misfiled)[0]).toContain('the message is a budget cut');
  });

  it('keeps arms apart', () => {
    const rows = channelTable({
      cases: [
        row({ arm: 'a', id: '1', sql: 'SELECT 1', errorKind: 'execution', error: 'execution: x' }),
        row({ arm: 'b', id: '2', sql: prose, errorKind: 'guard', error: 'guard: x' }),
      ],
    });
    expect(rows.map((entry) => entry.arm)).toEqual(['a', 'b']);
    expect(rows[0]?.misattributed).toEqual([]);
    expect(rows[1]?.misattributed).toHaveLength(1);
  });
});

describe('reading a file', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'nl2charts-channel-'));

  it('takes the artifact path and writes its own file', () => {
    const root = dir();
    const report = join(root, 'in.json');
    writeFileSync(report, JSON.stringify({ split: 'minidev', model: 'm', cases: [row({ id: '1', sql: 'SELECT 1', errorKind: 'execution', error: 'execution: x' })] }));
    const settings = resolveChannelSettings([report], root);
    const { artifact } = runChannel(settings);
    expect(artifact.split).toBe('minidev');
    expect(JSON.parse(readFileSync(settings.out, 'utf8'))).toMatchObject({ split: 'minidev' });
  });

  it('defaults to the committed artifact and a named output', () => {
    expect(resolveChannelSettings([], '/r')).toMatchObject({ report: '/r/eval/bird/out/bird-eval.json', out: '/r/eval/out/bird-channel.json' });
    expect(resolveChannelSettings(['--arm', 'select'], '/r')).toMatchObject({ arm: 'select', out: '/r/eval/out/bird-channel-select.json' });
  });

  it('refuses an --arm with no name', () => {
    expect(() => resolveChannelSettings(['--arm'], '/r')).toThrow(/needs a name/);
  });

  it('writes the artifact it returns', () => {
    const root = dir();
    const settings = resolveChannelSettings([join(root, 'x.json')], root);
    writeFileSync(settings.report, JSON.stringify({ cases: [] }));
    const artifact = channelArtifact({ split: 'dev' }, { ...settings, arm: 'select' }, [], []);
    const written = writeChannelArtifact(settings, artifact);
    expect(JSON.parse(readFileSync(written, 'utf8'))).toMatchObject({ split: 'dev', arm: 'select' });
  });

  it('reports a contradiction without failing on a historical artifact', async () => {
    // The committed dev artifact holds three rows this instrument flags. A reading that exits
    // non-zero on a file it did not write teaches its reader to add `|| true`, and `|| true` is
    // how a gate becomes a comment.
    const root = dir();
    const dirty = join(root, 'dirty.json');
    writeFileSync(dirty, JSON.stringify({ cases: [row({ id: '1', sql: prose, errorKind: 'guard', error: 'guard: x' })] }));
    const quiet = { GITHUB_STEP_SUMMARY: '' };
    await expect(main([dirty], root, quiet)).resolves.toBe(0);
  });

  it('judges the same file when asked to, which is what a fresh run does', async () => {
    const root = dir();
    const dirty = join(root, 'dirty.json');
    writeFileSync(dirty, JSON.stringify({ cases: [row({ id: '1', sql: prose, errorKind: 'guard', error: 'guard: x' })] }));
    const clean = join(root, 'clean.json');
    writeFileSync(clean, JSON.stringify({ cases: [row({ id: '1', sql: 'SELECT 1', errorKind: 'execution', error: 'execution: x' })] }));
    const quiet = { GITHUB_STEP_SUMMARY: '' };
    await expect(main([dirty, '--strict'], root, quiet)).resolves.toBe(1);
    await expect(main([clean, '--strict'], root, quiet)).resolves.toBe(0);
    expect(strictRequested(['--strict'])).toBe(true);
    expect(strictRequested([])).toBe(false);
  });

  it('appends to the step summary when one is set', async () => {
    const root = dir();
    const report = join(root, 'in.json');
    writeFileSync(report, JSON.stringify({ cases: [] }));
    const summary = join(root, 'summary.md');
    writeFileSync(summary, '');
    await expect(main([report], root, { GITHUB_STEP_SUMMARY: summary })).resolves.toBe(0);
    expect(readFileSync(summary, 'utf8')).toContain('Whether each refusal matched the reply behind it');
  });

  it('reports without a step summary at all, which is how it runs locally', async () => {
    // `env` is the whole environment here, so this is the path a developer's terminal takes. The
    // branch exists because appending to an unset variable would write a file named "undefined".
    const root = dir();
    const report = join(root, 'in.json');
    writeFileSync(report, JSON.stringify({ cases: [] }));
    await expect(main([report], root, {})).resolves.toBe(0);
  });

  it('is not the program inside a test', () => {
    expect(isEntry(undefined, import.meta.url)).toBe(false);
    expect(isEntry('/somewhere/else.js', import.meta.url)).toBe(false);
    expect(isEntry(new URL('../eval/bird/channel.ts', import.meta.url).pathname, import.meta.url)).toBe(false);
  });
});
