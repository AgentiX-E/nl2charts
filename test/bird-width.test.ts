/**
 * The width instrument: reading a select list, and pricing the projection lever.
 *
 * The unit cases pin the two things a shallow splitter gets wrong — a comma inside a call and
 * a comma inside a literal — because both would miscount the width and change which subset the
 * trim search tries first. The end-to-end cases run a real SQLite file through the real oracle
 * subprocess, because the whole instrument is built on the idea that the widths come from the
 * engine rather than from a scanner's opinion, and a stubbed result set would agree with
 * whatever the scanner said.
 *
 * One property is asserted as a property rather than as an example: a statement the trim search
 * rebuilds must still be a statement the engine accepts. The first version concatenated the
 * slices without re-spacing them and produced `… AS ageFROM Player …`; every subset then failed
 * to run, every failure counted as "that did not help", and the ceiling read 1 where the truth
 * was 11.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TRIM_TRIALS,
  clauseOffsets,
  isEntry,
  keeps,
  main,
  missingItems,
  resolveWidthSettings,
  runWidth,
  selectList,
  tallyWidth,
  trimCeiling,
  widthLines,
  widthOf,
  widthPath,
  widthProblems,
  withItems,
  writeWidthArtifact,
} from '../eval/bird/width.js';
import type { WidthRow } from '../eval/bird/width.js';
import { MINI_DB, writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();

const list = (sql: string) => {
  const parsed = selectList(sql);
  if (parsed === undefined) throw new Error(`no select list in ${sql}`);
  return parsed;
};

describe('reading a select list', () => {
  it('splits on top-level commas only, so a call keeps its arguments', () => {
    expect(list('select a, coalesce(b, c) as d from t').items).toEqual(['a', 'coalesce(b, c) as d']);
  });

  it('keeps a comma inside a string literal inside the item it belongs to', () => {
    expect(list("select 'a,b', c from t").items).toEqual(["'a,b'", 'c']);
    expect(list("select 'it''s, fine', c from t").items).toEqual(["'it''s, fine'", 'c']);
  });

  it('reads the outer select of a CTE, not the body inside its parentheses', () => {
    const parsed = list('with x as (select a, b from t) select a from x');
    expect(parsed.items).toEqual(['a']);
    expect(parsed.tail).toBe('from x');
  });

  it('keeps `distinct` in the head and the from clause in the tail', () => {
    const parsed = list('SELECT DISTINCT a, b FROM t WHERE c = 1');
    expect(parsed.head.trim()).toBe('SELECT DISTINCT');
    expect(parsed.tail).toBe('FROM t WHERE c = 1');
  });

  it('reads a statement with no from clause up to its end', () => {
    const parsed = list('select 1');
    expect(parsed.items).toEqual(['1']);
    expect(parsed.tail).toBe('');
  });

  it('says nothing when there is no select at all', () => {
    expect(selectList('delete from t')).toBeUndefined();
  });

  it('finds the keywords a regex would also find inside a literal', () => {
    const offsets = clauseOffsets("select 'from select' as a from t");
    expect(offsets.selects).toHaveLength(1);
    expect(offsets.froms).toHaveLength(1);
  });
});

describe('rebuilding a statement with fewer items', () => {
  it('re-spaces both edges, because neither slice carries the space between them', () => {
    // The defect this pins: `select distinct(x)…ageFROM t`, which the engine refuses and which
    // the trim search then reports as "removing a column did not help".
    const parsed = list('SELECT DISTINCT p.name, p.age FROM Player AS p');
    expect(withItems(parsed, [1])).toBe('SELECT DISTINCT p.age FROM Player AS p');
    expect(withItems(parsed, [0])).toBe('SELECT DISTINCT p.name FROM Player AS p');
  });

  it('handles a statement with no from clause', () => {
    expect(withItems(list('select 1, 2'), [0])).toBe('select 1');
  });
});

describe('which way the width is off', () => {
  it('names the three states', () => {
    expect(widthOf(1, 2)).toBe('wide');
    expect(widthOf(2, 1)).toBe('narrow');
    expect(widthOf(2, 2)).toBe('exact');
  });
});

describe('the subsets the search tries', () => {
  it('enumerates every way to keep k of n, in a stable order', () => {
    expect(keeps(3, 1)).toEqual([[0], [1], [2]]);
    expect(keeps(3, 2)).toEqual([[0, 1], [0, 2], [1, 2]]);
    expect(keeps(2, 0)).toEqual([[]]);
  });

  it('reports the smallest deletion that fixes the answer', async () => {
    // Three items, of which keeping the first two is right. The search must find it at drop
    // count one rather than two, because the reading names the smallest edit that works.
    const parsed = list('select a, b, c from t');
    const runs: string[] = [];
    const outcome = await trimCeiling({
      list: parsed,
      goldWidth: 2,
      gold: [[1, 2]],
      run: (sql) => {
        runs.push(sql);
        return Promise.resolve(
          sql.includes('select a, b from')
            ? { ok: true, columns: ['a', 'b'], rows: [[1, 2]], ms: 1 }
            : { ok: true, columns: [], rows: [[9]], ms: 1 },
        );
      },
    });
    expect(outcome).toEqual({ recovered: true, dropped: ['c'], explored: true });
    expect(runs).toHaveLength(1);
  });

  it('keeps trying after a subset the engine refuses', async () => {
    const parsed = list('select a, b from t');
    const outcome = await trimCeiling({
      list: parsed,
      goldWidth: 1,
      gold: [[1]],
      run: (sql) =>
        Promise.resolve(
          sql.includes('select a from')
            ? { ok: true, columns: ['a'], rows: [[1]], ms: 1 }
            : { ok: false, columns: [], rows: [], error: 'boom', ms: 1 },
        ),
    });
    expect(outcome.recovered).toBe(true);
    expect(outcome.dropped).toEqual(['b']);
  });

  it('reports a case whose subsets overflow the budget as unexplored rather than as a zero', async () => {
    const parsed = list('select a, b, c, d, e, f, g from t');
    const outcome = await trimCeiling({
      list: parsed,
      goldWidth: 1,
      gold: [[1]],
      run: () => Promise.resolve({ ok: true, columns: ['a'], rows: [[9]], ms: 1 }),
      trials: 3,
    });
    expect(outcome).toEqual({ recovered: false, dropped: [], explored: false });
    expect(TRIM_TRIALS).toBeGreaterThan(3);
  });

  it('reports no recovery when every subset runs and none of them matches', async () => {
    // The loops run to the end: every attempt is accepted by the engine and none answers the
    // question, which is the ordinary case and the one that has to be distinguishable from an
    // engine that refused everything.
    const outcome = await trimCeiling({
      list: list('select a, b, c from t'),
      goldWidth: 1,
      gold: [[1]],
      run: () => Promise.resolve({ ok: true, columns: ['a'], rows: [[9]], ms: 1 }),
    });
    expect(outcome).toEqual({ recovered: false, dropped: [], explored: true });
  });

  it('does nothing when the statement is already as narrow as the answer', async () => {
    const outcome = await trimCeiling({
      list: list('select a from t'),
      goldWidth: 1,
      gold: [[1]],
      run: () => Promise.resolve({ ok: true, columns: ['a'], rows: [[1]], ms: 1 }),
    });
    expect(outcome).toEqual({ recovered: false, dropped: [], explored: true });
  });
});

describe('naming what a narrow statement never spells', () => {
  it('lists the gold items the prediction does not contain', () => {
    const gold = list('select t.name, t.price from t');
    expect(missingItems(gold, 'select name from t')).toEqual(['t.price']);
    expect(missingItems(gold, 'select T.NAME, T.PRICE from t')).toEqual([]);
    // Identifier edges, not substrings: `unit_price` is a different column.
    expect(missingItems(gold, 'select name, unit_price from t')).toEqual(['t.price']);
    // An item with no column part has no name to be missing, so it is never reported.
    expect(missingItems({ head: 'select ', items: ['t.'], tail: '' }, 'select name from t')).toEqual([]);
    expect(missingItems(undefined, 'select name from t')).toEqual([]);
  });
});

describe('the tally', () => {
  const row = (width: WidthRow['width'], recovered = false, explored = true, located = true): WidthRow => ({
    id: '1',
    goldWidth: 1,
    predictedWidth: width === 'wide' ? 2 : 1,
    width,
    recovered,
    dropped: recovered ? ['x'] : [],
    missing: [],
    located,
    explored,
  });

  it('counts each direction and quotes the ceiling against every scored case', () => {
    const tally = tallyWidth([row('wide', true), row('wide'), row('narrow')], 10);
    expect(tally).toMatchObject({ total: 3, wide: 2, narrow: 1, exact: 0, recovered: 1, unexplored: 0 });
    expect(tally.ceilingPoints).toBe(10);
  });

  it('counts a wide case with no readable select list as unlocated rather than unexplored', () => {
    expect(tallyWidth([row('wide', false, false, false)], 4).unexplored).toBe(0);
    expect(tallyWidth([row('wide', false, false)], 4).unexplored).toBe(1);
  });

  it('reports a zero ceiling rather than dividing by zero', () => {
    expect(tallyWidth([], 0).ceilingPoints).toBe(0);
  });
});

describe('what makes the reading unpublishable', () => {
  const row = (located: boolean): WidthRow => ({
    id: '1',
    goldWidth: 1,
    predictedWidth: 2,
    width: 'wide',
    recovered: false,
    dropped: [],
    missing: [],
    located,
    explored: true,
  });

  it('fails when a case names a question the split does not hold', () => {
    expect(widthProblems([], { unknownQuestion: 2, unretained: 0, engineRefused: 0, goldFailed: 0 })[0]).toContain(
      '2 cases name a question',
    );
  });

  it('fails when a wide case has no select list this reader can find', () => {
    expect(widthProblems([row(false)], { unknownQuestion: 0, unretained: 0, engineRefused: 0, goldFailed: 0 })[0]).toContain(
      '1 wide cases hold no select list',
    );
  });

  it('passes a low ceiling, because a low ceiling is the finding', () => {
    expect(widthProblems([row(true)], { unknownQuestion: 0, unretained: 1, engineRefused: 3, goldFailed: 0 })).toEqual([]);
  });
});

describe('the lines a reader sees', () => {
  const outcome = {
    split: 'minidev',
    arm: 'inline+evidence',
    scored: 496,
    rows: [
      { id: '1', goldWidth: 1, predictedWidth: 2, width: 'wide' as const, recovered: true, dropped: ['sum(x)'], missing: [], located: true, explored: true },
      { id: '2', goldWidth: 2, predictedWidth: 1, width: 'narrow' as const, recovered: false, dropped: [], missing: ['t.price'], located: true, explored: true },
      { id: '3', goldWidth: 1, predictedWidth: 2, width: 'wide' as const, recovered: false, dropped: [], missing: [], located: true, explored: false },
    ],
    tally: tallyWidth(
      [
        { id: '1', goldWidth: 1, predictedWidth: 2, width: 'wide', recovered: true, dropped: ['sum(x)'], missing: [], located: true, explored: true },
        { id: '2', goldWidth: 2, predictedWidth: 1, width: 'narrow', recovered: false, dropped: [], missing: ['t.price'], located: true, explored: true },
        { id: '3', goldWidth: 1, predictedWidth: 2, width: 'wide', recovered: false, dropped: [], missing: [], located: true, explored: false },
      ],
      496,
    ),
    drops: { unknownQuestion: 0, unretained: 0, engineRefused: 0, goldFailed: 0 },
    problems: [],
  };

  it('prints both directions, the ceiling and what was not enumerated', () => {
    const lines = widthLines(outcome).join('\n');
    expect(lines).toContain('3 column-count cases of 496 scored');
    expect(lines).toContain('wide');
    expect(lines).toContain('narrow');
    expect(lines).toContain('recovered 1 by dropping: sum(x)');
    expect(lines).toContain('narrow cases never spell t.price (1)');
    expect(lines).toContain(`more than ${String(TRIM_TRIALS)} subsets`);
  });

  it('prints a failure line for a problem', () => {
    const lines = widthLines({ ...outcome, problems: ['WIDTH: nope'] }).join('\n');
    expect(lines).toContain('FAILED WIDTH: nope');
  });

  it('prints zeros rather than nothing for an empty reading', () => {
    const empty = { ...outcome, scored: 0, rows: [], tally: tallyWidth([], 0) };
    expect(widthLines(empty).join('\n')).toContain('0 column-count cases of 0 scored');
  });
});

describe('the entry, run the way a workflow runs it', () => {
  /** The fixture plus two questions whose gold has a width the predictions can miss. */
  function dataset(): string {
    const dir = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'width-')));
    const file = join(dir, 'mini_dev_sqlite.json');
    const questions = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
    questions.push(
      { question_id: 92, db_id: MINI_DB, question: 'Which items cost more than one?', evidence: '', SQL: 'select name from items where price > 1', difficulty: 'simple' },
      { question_id: 93, db_id: MINI_DB, question: 'What do the items cost?', evidence: '', SQL: 'select name, price from items', difficulty: 'simple' },
    );
    writeFileSync(file, JSON.stringify(questions));
    return dir;
  }

  const caseRow = (id: number, reason: string) => ({ arm: 'inline+evidence', id: String(id), passed: false, reason });

  function report(predicted: Record<string, string>, extra: readonly (number | { id: number; reason: string })[] = []): unknown {
    return {
      split: 'minidev',
      model: 'deepseek-chat',
      arms: [{ arm: 'inline+evidence' }],
      cases: [
        ...Object.keys(predicted).map((id) => caseRow(Number(id), 'column-count')),
        ...extra.map((item) => (typeof item === 'number' ? caseRow(item, 'values') : caseRow(item.id, item.reason))),
        { arm: 'inline+evidence', id: '1', passed: true, reason: 'match' },
      ],
      failures: {
        'inline+evidence': Object.entries(predicted).map(([id, sql]) => ({ id, predicted: sql, reason: 'column-count' })),
      },
    };
  }

  function settingsFor(data: string, body: unknown): ReturnType<typeof resolveWidthSettings> {
    const dir = mkdtempSync(join(tmpdir(), 'width-report-'));
    const path = join(dir, 'bird-eval.json');
    writeFileSync(path, JSON.stringify(body));
    return resolveWidthSettings({ BIRD_SPLIT: 'minidev', BIRD_DATA: data }, [path, '--arm', 'inline+evidence'], ROOT);
  }

  it('measures both directions end to end and recovers the case a deletion fixes', async () => {
    const data = dataset();
    const settings = settingsFor(
      data,
      report({
        // Wide: the answer is the name, and dropping the price makes it match.
        '92': 'select name, price from items where price > 1',
        // Narrow: the answer is two columns and the statement writes one.
        '93': 'select name from items',
      }),
    );
    const outcome = await runWidth(settings);
    expect(outcome.tally.wide).toBe(1);
    expect(outcome.tally.narrow).toBe(1);
    expect(outcome.tally.recovered).toBe(1);
    expect(outcome.rows.find((row) => row.id === '92')?.dropped).toEqual(['price']);
    expect(outcome.rows.find((row) => row.id === '93')?.missing).toEqual(['price']);
    // The scored denominator counts every case, including the one that passed.
    expect(outcome.scored).toBe(3);
    expect(outcome.problems).toEqual([]);
  });

  it('reads the width from the engine, not from the select list', async () => {
    // `select *` is one item and three columns: a scanner that counted items would call this
    // case `exact` and skip the search entirely.
    const data = dataset();
    const settings = settingsFor(data, report({ '92': 'select * from items where price > 1' }));
    const outcome = await runWidth(settings);
    const row = outcome.rows[0];
    expect(row?.predictedWidth).toBe(3);
    expect(row?.width).toBe('wide');
  });

  it('counts a statement the engine refuses rather than classifying it', async () => {
    const data = dataset();
    const settings = settingsFor(data, report({ '92': 'select nope from items' }));
    const outcome = await runWidth(settings);
    expect(outcome.drops.engineRefused).toBe(1);
    expect(outcome.tally.total).toBe(0);
  });

  it('counts a case whose question the split does not hold', async () => {
    const data = dataset();
    const settings = settingsFor(data, report({}, [{ id: 900, reason: 'column-count' }]));
    const outcome = await runWidth(settings);
    expect(outcome.drops.unknownQuestion).toBe(1);
  });

  it('counts a case the artifact kept no statement for', async () => {
    const data = dataset();
    const settings = settingsFor(data, {
      ...(report({}) as object),
      cases: [{ arm: 'inline+evidence', id: '92', passed: false, reason: 'column-count' }],
      failures: { 'inline+evidence': [{ id: '92' }] },
    });
    const outcome = await runWidth(settings);
    expect(outcome.drops.unretained).toBe(1);
    expect(outcome.tally.total).toBe(0);
  });

  it('reads an artifact that carries no failures at all as unretained rather than throwing', async () => {
    const data = dataset();
    const settings = settingsFor(data, {
      ...(report({}) as object),
      cases: [{ arm: 'inline+evidence', id: '92', passed: false, reason: 'column-count' }],
      failures: undefined,
    });
    const outcome = await runWidth(settings);
    expect(outcome.drops.unretained).toBe(1);
  });

  it('counts a gold statement the engine refuses', async () => {
    const data = dataset();
    const file = join(data, 'mini_dev_sqlite.json');
    const questions = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
    questions.push({ question_id: 96, db_id: MINI_DB, question: 'A gold that cannot run', evidence: '', SQL: 'select nope from items', difficulty: 'simple' });
    writeFileSync(file, JSON.stringify(questions));
    const outcome = await runWidth(settingsFor(data, report({ '96': 'select name, price from items' })));
    expect(outcome.drops.goldFailed).toBe(1);
    expect(outcome.tally.total).toBe(0);
  });

  it('refuses an arm the artifact does not hold', async () => {
    const data = dataset();
    const settings = settingsFor(data, report({}));
    await expect(runWidth({ ...settings, arm: 'select' })).rejects.toThrow(/has no arm select/);
  });

  it('resolves the arm and the paths, and rejects a flag without a name', () => {
    const env = { BIRD_SPLIT: 'minidev', BIRD_DATA: '/data' };
    expect(resolveWidthSettings(env, ['/r.json'], ROOT)).toMatchObject({ arm: 'metadata+evidence', report: '/r.json', strict: false });
    expect(resolveWidthSettings(env, ['--strict', '/r.json', '--arm', 'select'], ROOT)).toMatchObject({ arm: 'select', strict: true });
    expect(() => resolveWidthSettings({}, ['/r.json', '--arm'], ROOT)).toThrow('--arm needs a name');
    expect(() => resolveWidthSettings({}, ['--strict'], ROOT)).toThrow('usage');
  });

  it('writes one artifact per arm, with a name safe for a path', async () => {
    const data = dataset();
    const settings = settingsFor(data, report({ '92': 'select name, price from items where price > 1' }));
    const outcome = await runWidth(settings);
    const path = writeWidthArtifact(settings, outcome);
    expect(path).toBe(widthPath(settings));
    expect(path).toContain('width-inline+evidence.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ arm: 'inline+evidence', scored: 2 });
    expect(widthPath({ ...settings, arm: 'select-cross@second' })).toContain('width-select-cross-second.json');
  });

  it('exits zero for a measurement and non-zero for a gate that cannot read a case', async () => {
    const data = dataset();
    const env = { BIRD_SPLIT: 'minidev', BIRD_DATA: data };
    const settings = settingsFor(data, report({ '92': 'select name, price from items where price > 1' }));
    expect(await main([settings.report, '--arm', 'inline+evidence'], ROOT, env)).toBe(0);
    const broken = settingsFor(data, report({}, [{ id: 900, reason: 'column-count' }]));
    expect(await main([broken.report, '--arm', 'inline+evidence'], ROOT, env)).toBe(0);
    expect(await main([broken.report, '--arm', 'inline+evidence', '--strict'], ROOT, env)).toBe(1);
  });

  it('answers whether it is the program', () => {
    const own = new URL('../eval/bird/width.ts', import.meta.url).href;
    expect(isEntry(new URL('../eval/bird/width.ts', import.meta.url).pathname, own)).toBe(true);
    expect(isEntry(new URL('../eval/bird/gap.ts', import.meta.url).pathname, own)).toBe(false);
    expect(isEntry(undefined, own)).toBe(false);
  });
});
