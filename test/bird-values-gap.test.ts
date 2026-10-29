/**
 * Splitting the `values` bucket, through the classifier and through the entry.
 *
 * The unit cases pin the ladder against sentence pairs, because that is what the classifier
 * reads when the result sets are ambiguous. The end-to-end cases run a real SQLite file
 * through the real oracle subprocess, because the shapes the first three rungs are built on —
 * empty, row count, scale — are produced by the engine, and a stubbed result set would agree
 * with whatever the classifier was written to expect.
 *
 * Two properties are asserted as properties rather than as examples, because they are what
 * the tool's denominator means: a case the judge filed under `column-count` never enters the
 * split (its projection is the finding, and no clause-by-clause reading can improve on it),
 * and a statement the model never wrote is `no-statement` rather than a filter error.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aggregateCalls,
  classifyValuesGap,
  groupingColumns,
  isEntry,
  main,
  resolveValuesGapSettings,
  runValuesGap,
  tallyValues,
  valuesGapPath,
  valuesLines,
  valuesProblems,
  writeValuesArtifact,
} from '../eval/bird/values-gap.js';
import { MINI_DB, writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();

const gap = (gold: string, predicted: string, shape: Parameters<typeof classifyValuesGap>[0]['shape'] = 'values') =>
  classifyValuesGap({ gold, predicted, shape });

describe('reading the two statements', () => {
  it('collects the aggregate calls a statement makes, with `distinct` attached to its name', () => {
    expect(aggregateCalls('select count(distinct name), sum(price) from items')).toEqual(['count-distinct', 'sum']);
    expect(aggregateCalls('select COUNT(*) from items')).toEqual(['count']);
  });

  it('ignores a call inside a string literal, which is a filter and not an aggregate', () => {
    expect(aggregateCalls("select count(*) from items where name = 'sum(x)'")).toEqual(['count']);
  });

  it('reads a group by clause up to the next one, and normalises quoting and spacing', () => {
    expect(groupingColumns('select a from t group by 1')).toEqual(['1']);
    expect(groupingColumns('select a from t GROUP BY  "Name" , region order by 1')).toEqual(['name', 'region']);
    expect(groupingColumns('select a from t')).toEqual([]);
  });

  it('folds a group by that stops at having, and one that stops at the end', () => {
    expect(groupingColumns('select a from t group by a having count(*) > 1')).toEqual(['a']);
    expect(groupingColumns('select a from t group by a limit 3')).toEqual(['a']);
  });
});

describe('which fix the difference asks for', () => {
  it('reads an empty result as a filter that matched nothing', () => {
    expect(gap('select name from items', "select name from items where name = 'zzz'", 'empty')).toBe('filter-narrow');
  });

  it('reads a wrong row count as a filter that is too weak or a join that multiplied', () => {
    expect(gap('select count(*) from orders', 'select count(*) from items, orders', 'row-count')).toBe('filter-wide');
  });

  it('reads a constant multiple as an aggregation at the wrong level', () => {
    expect(gap('select qty from orders', 'select qty * 2 from orders', 'scale')).toBe('scale');
  });

  it('reads a statement the model never wrote as no statement, before spending a query on it', () => {
    // `shape` is irrelevant here: an empty statement has no result set to measure, and filing
    // it under a shape would be filing a generation failure under retrieval.
    expect(gap('select count(*) from items', '   ')).toBe('no-statement');
  });

  it('reads a value the gold names and the prediction never writes as retrieval', () => {
    expect(gap('select count(*) from orders where item_id = 1', 'select count(*) from orders where item_id = 2')).toBe(
      'literal-missing',
    );
  });

  it('reads a value written in the wrong case as its own defect', () => {
    // SQLite compares strings case-sensitively: this statement runs, looks right, and counts a
    // different set of rows. It is the one bucket whose fix is in the prompt rather than in the
    // model, which is why it is separated from a missing value.
    expect(gap("select count(*) from frpm where funding = 'Directly funded'", "select count(*) from frpm where funding = 'Directly Funded'")).toBe(
      'literal-case',
    );
  });

  it('reads a different table as a join-selection error, even though its conditions differ too', () => {
    // The extra join is the root cause: once the statement reads `frpm`, its predicates differ
    // as a consequence. Reporting the predicate would file one case under two work items.
    expect(
      gap(
        'select t2.phone from satscores t1 join schools t2 on t1.cds = t2.cdscode where t2.district = \'fresno unified\'',
        'select s.phone from schools s join satscores sat on s.cdscode = sat.cds join frpm f on s.cdscode = f.cdscode where f.district name = \'fresno unified\'',
      ),
    ).toBe('tables');
  });

  it('reads a missing condition on the same tables as condition coverage', () => {
    expect(
      gap(
        'select t2.mailstreet, t2.school from satscores t1 join schools t2 on t1.cds = t2.cdscode where t1.avgscrread is not null order by t1.avgscrread asc limit 1',
        'select schools.mailstreet, schools.school from satscores join schools on schools.cdscode = satscores.cds order by satscores.avgscrread asc limit 1',
      ),
    ).toBe('predicate');
  });

  it('reads a different aggregate function as an aggregation error', () => {
    expect(gap('select count(*) from items', 'select sum(price) from items')).toBe('aggregate');
  });

  it('reads a different grouping column at the same cardinality as a grain error', () => {
    expect(gap('select sum(price) from items group by name', 'select sum(price) from items group by price')).toBe('grain');
  });

  it('reads the same columns in a different order as a projection error', () => {
    // BIRD compares tuples, so `select a, b` and `select b, a` answer differently. Sorting the
    // select list would call this "the same question" and lose a case that a reader can fix.
    expect(gap('select name, price from items', 'select price, name from items')).toBe('projection');
  });

  it('reads a different window as a window error', () => {
    expect(gap('select name from items order by price desc limit 5', 'select name from items order by price desc limit 6')).toBe(
      'window',
    );
  });

  it('says equivalent when the statements are one statement, which is a tie and not a mistake', () => {
    expect(gap('select name from items order by price desc limit 1', 'SELECT i.name FROM items AS i ORDER BY i.price DESC LIMIT 1')).toBe(
      'equivalent',
    );
  });

  it('says unclassified when the statements differ in a part the reader has no name for', () => {
    // A join type is not one of the named parts. Leaving a case unattributed is the honest
    // reading; folding it into a neighbouring bucket would make the table agree with itself
    // and no longer describe the corpus.
    expect(gap('select a.x from a left join b on a.id = b.id', 'select a.x from a join b on a.id = b.id')).toBe('unclassified');
  });
});

describe('the tally', () => {
  it('counts every bucket and separates a named cause from a gap', () => {
    const tally = tallyValues(['filter-narrow', 'filter-narrow', 'grain', 'unclassified']);
    expect(tally.total).toBe(4);
    expect(tally.buckets['filter-narrow']).toBe(2);
    expect(tally.classified).toBe(3);
    expect(tally.coverage).toBeCloseTo(0.75, 6);
  });

  it('counts a tie and an unwritten statement as named causes, because both name what happened', () => {
    const tally = tallyValues(['equivalent', 'no-statement', 'unclassified']);
    expect(tally.classified).toBe(2);
  });

  it('reports an empty split as covered rather than dividing by zero', () => {
    expect(tallyValues([]).coverage).toBe(1);
  });
});

describe('what makes the split unpublishable', () => {
  it('refuses an artifact that retained no statement at all', () => {
    expect(valuesProblems(tallyValues([]))).toEqual([
      'VGAP: the artifact holds no statement for any no-answer case, so the values bucket cannot be split',
    ]);
  });

  it('fails a split where fewer than four fifths of the cases reach a named cause', () => {
    const tally = tallyValues(['grain', 'unclassified', 'unclassified', 'unclassified', 'unclassified']);
    const problems = valuesProblems(tally);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('1 of 5');
  });

  it('passes at the boundary', () => {
    expect(valuesProblems(tallyValues(['grain', 'grain', 'grain', 'grain', 'unclassified']))).toEqual([]);
  });
});

describe('the lines a reader sees', () => {
  it('prints every bucket with its share, grouped by the question it answers', () => {
    const lines = valuesLines(tallyValues(['grain', 'unclassified'])).join('\n');
    expect(lines).toContain('did it compute the right thing');
    expect(lines).toContain('grain');
    expect(lines).toContain('50.0%');
    expect(lines).toContain('2 cases, 1 classified (50.0%)');
  });

  it('prints every bucket name, so a bucket of zero is visible rather than absent', () => {
    const lines = valuesLines(tallyValues(['grain'])).join('\n');
    for (const bucket of ['no-statement', 'literal-case', 'tables', 'predicate', 'projection', 'window', 'equivalent']) {
      expect(lines).toContain(bucket);
    }
  });

  it('prints zero rather than nothing for an empty split', () => {
    expect(valuesLines(tallyValues([])).join('\n')).toContain('0 cases, 0 classified (100.0%)');
  });
});

describe('the entry, run the way a workflow runs it', () => {
  /** The fixture dataset plus one gold that the engine refuses. */
  function dataset(): string {
    const dir = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'vgap-')));
    const file = join(dir, 'mini_dev_sqlite.json');
    const questions = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
    questions.push(
      { question_id: 90, db_id: MINI_DB, question: 'A gold that cannot run', evidence: '', SQL: 'select nope from items', difficulty: 'simple' },
      // The one gold in the fixture that returns several rows of one numeric column, which is
      // the only shape that can carry a `scale` reading (a factor needs more than one row).
      { question_id: 91, db_id: MINI_DB, question: 'What is the quantity of every order?', evidence: '', SQL: 'select qty from orders', difficulty: 'simple' },
    );
    writeFileSync(file, JSON.stringify(questions));
    return dir;
  }

  const caseRow = (id: number, reason = 'values') => ({ arm: 'select-cross', id: String(id), passed: false, reason, candidateRecall: false });

  function report(predicted: Record<string, string>, extra: readonly (number | { id: number; reason: string })[] = []): unknown {
    return {
      split: 'minidev',
      model: 'deepseek-chat',
      arms: [{ arm: 'select-cross', candidateRecall: 0 }],
      cases: [
        ...Object.keys(predicted).map((id) => caseRow(Number(id))),
        ...extra.map((item) => (typeof item === 'number' ? caseRow(item) : caseRow(item.id, item.reason))),
      ],
      failures: {
        'select-cross': [
          ...Object.entries(predicted).map(([id, sql]) => ({ id, predicted: sql, reason: 'values' })),
          { id: '900', predicted: 'select 1', reason: 'values' },
          { id: '901', predicted: 'select 1', reason: 'column-count' },
        ],
      },
    };
  }

  function settingsFor(data: string, body: unknown): ReturnType<typeof resolveValuesGapSettings> {
    const dir = mkdtempSync(join(tmpdir(), 'vgap-report-'));
    const path = join(dir, 'bird-eval.json');
    writeFileSync(path, JSON.stringify(body));
    return resolveValuesGapSettings({ BIRD_SPLIT: 'minidev', BIRD_DATA: data }, [path, '--arm', 'select-cross'], ROOT);
  }

  it('splits the bucket end to end, counting what it had to drop', async () => {
    const data = dataset();
    // Five shapes, one case each. 5 returns three rows against a one-row gold (a filter that
    // is too weak), 3 returns none (a filter that matches nothing), 7 counts a different
    // literal, 91 doubles every value, and 2 swaps the aggregate. 90 is a gold that cannot
    // run, which is dropped and counted rather than classified.
    const settings = settingsFor(
      data,
      report(
        {
          '5': 'select name from items',
          '3': "select name from items where name = 'zzz'",
          '7': 'select count(*) from orders where item_id = 2',
          '91': 'select qty * 2 from orders',
          '2': 'select count(*) from items',
          '90': 'select count(*) from items',
        },
        [900, 1],
      ),
    );
    const outcome = await runValuesGap(settings);
    expect(outcome.tally.buckets['filter-wide']).toBe(1);
    expect(outcome.tally.buckets['filter-narrow']).toBe(1);
    expect(outcome.tally.buckets['literal-missing']).toBe(1);
    expect(outcome.tally.buckets.scale).toBe(1);
    expect(outcome.tally.buckets.aggregate).toBe(1);
    expect(outcome.tally.buckets.unclassified).toBe(0);
    // The gold that cannot run, and the case with no question, are dropped and counted.
    expect(outcome.drops.goldFailed).toBe(1);
    expect(outcome.drops.unknownQuestion).toBe(1);
    // `1` is a no-answer case with no retained statement: the artifact's loss, not the model's.
    expect(outcome.drops.unretained).toBe(1);
    expect(outcome.problems).toEqual([]);
  });

  it('leaves the column-count bucket to the tool that owns it', async () => {
    // The judge files ~a fifth of the no-answer set under `column-count`. Splitting those by
    // clause is how the first version of this tool reported 86 width errors as unclassified
    // cases: a statement whose width is wrong has a projection finding, not a clause finding.
    const data = dataset();
    const settings = settingsFor(data, report({}, [{ id: 901, reason: 'column-count' }]));
    const outcome = await runValuesGap(settings);
    expect(outcome.tally.total).toBe(0);
    expect(outcome.drops.otherBucket).toBe(0);
    // 901 is not in `failures` for a `values` reason, so it is not in the split at all: the
    // case row carries the reason the split filters on.
    expect(outcome.tally.buckets['literal-missing']).toBe(0);
  });

  it('counts a statement the engine refused as a refusal rather than a value error', async () => {
    const data = dataset();
    const settings = settingsFor(data, report({ '1': 'select nope from items' }));
    const outcome = await runValuesGap(settings);
    expect(outcome.drops.engineRefused).toBe(1);
    expect(outcome.tally.total).toBe(0);
    expect(outcome.problems[0]).toContain('no statement');
  });

  it('counts an empty statement as a bucket rather than dropping it', async () => {
    const data = dataset();
    const settings = settingsFor(data, report({ '1': '   ' }));
    const outcome = await runValuesGap(settings);
    expect(outcome.tally.buckets['no-statement']).toBe(1);
    expect(outcome.tally.total).toBe(1);
  });

  it('reports a perfect run as a zero bucket rather than as a broken artifact', async () => {
    // No case in the artifact has `candidateRecall: false`, which is what an arm that answered
    // everything looks like. A gate must not red on that.
    const data = dataset();
    const settings = settingsFor(data, { split: 'minidev', model: 'deepseek-chat', arms: [{ arm: 'select-cross', candidateRecall: 0 }] });
    const outcome = await runValuesGap(settings);
    expect(outcome.tally.total).toBe(0);
    expect(outcome.drops.unretained).toBe(0);
    expect(outcome.problems).toEqual([]);
  });

  it('reports an arm whose no-answer cases are all unreadable as a broken artifact', async () => {
    // The cases exist and say `candidateRecall: false`, but the retained corpus holds no
    // statement for any of them: the split has nothing to read, and saying so is the point.
    const data = dataset();
    const body = {
      split: 'minidev',
      model: 'deepseek-chat',
      arms: [{ arm: 'select-cross', candidateRecall: 0 }],
      cases: [caseRow(1), caseRow(2)],
      failures: { 'select-cross': [] },
    };
    const outcome = await runValuesGap(settingsFor(data, body));
    expect(outcome.tally.total).toBe(0);
    expect(outcome.drops.unretained).toBe(2);
    expect(outcome.problems).toHaveLength(1);
    expect(outcome.problems[0]).toContain('no statement');
  });

  it('resolves the arm from the flag and defaults to the cross arm, with `--strict` separated from the path', () => {
    const env = { BIRD_SPLIT: 'minidev', BIRD_DATA: '/data' };
    expect(resolveValuesGapSettings(env, ['/r.json'], ROOT)).toMatchObject({ arm: 'select-cross', report: '/r.json', strict: false });
    expect(resolveValuesGapSettings(env, ['/r.json', '--arm', 'select5'], ROOT).arm).toBe('select5');
    expect(resolveValuesGapSettings(env, ['--strict', '/r.json', '--arm', 'select5'], ROOT)).toMatchObject({ arm: 'select5', report: '/r.json', strict: true });
    // The arm name is not a path, however it is ordered.
    expect(resolveValuesGapSettings(env, ['--arm', 'select5', '/r.json'], ROOT).report).toBe('/r.json');
    expect(() => resolveValuesGapSettings({}, ['/r.json', '--arm'], ROOT)).toThrow('--arm needs a name');
    expect(() => resolveValuesGapSettings({}, [], ROOT)).toThrow('usage');
    expect(() => resolveValuesGapSettings({}, ['--strict'], ROOT)).toThrow('usage');
  });

  it('writes one artifact per arm, with the arm name safe for a path', async () => {
    const data = dataset();
    const settings = settingsFor(data, report({ '91': 'select qty * 2 from orders' }));
    const outcome = await runValuesGap(settings);
    const path = writeValuesArtifact(settings, outcome);
    expect(path).toBe(valuesGapPath(settings));
    expect(path).toContain('values-gap-select-cross.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ arm: 'select-cross', split: 'minidev' });
    const awkward = { ...settings, arm: 'select-cross@second' };
    expect(valuesGapPath(awkward)).toContain('values-gap-select-cross-second.json');
  });

  it('exits zero for a measurement and non-zero for a gate that misses its bar', async () => {
    const data = dataset();
    const env = { BIRD_SPLIT: 'minidev', BIRD_DATA: data };
    const settings = settingsFor(data, report({ '91': 'select qty * 2 from orders' }));
    expect(await main([settings.report, '--arm', 'select-cross'], ROOT, env)).toBe(0);
    // An arm whose no-answer cases carry no statement at all is a finding rather than a pass:
    // the measurement still exits zero, and the gate is the caller that turns it into a
    // failure. A perfect run is the other way round — no case to split, nothing to report.
    const unreadable = settingsFor(data, {
      split: 'minidev',
      model: 'deepseek-chat',
      arms: [{ arm: 'select-cross', candidateRecall: 0 }],
      cases: [caseRow(1), caseRow(2)],
      failures: { 'select-cross': [] },
    });
    expect(await main([unreadable.report, '--arm', 'select-cross'], ROOT, env)).toBe(0);
    expect(await main([unreadable.report, '--arm', 'select-cross', '--strict'], ROOT, env)).toBe(1);
    const perfect = settingsFor(data, report({}));
    expect(await main([perfect.report, '--arm', 'select-cross', '--strict'], ROOT, env)).toBe(0);
  });

  it('answers whether it is the program', () => {
    const own = new URL('../eval/bird/values-gap.ts', import.meta.url).href;
    expect(isEntry(new URL('../eval/bird/values-gap.ts', import.meta.url).pathname, own)).toBe(true);
    expect(isEntry(new URL('../eval/bird/gap.ts', import.meta.url).pathname, own)).toBe(false);
    expect(isEntry(undefined, own)).toBe(false);
  });
});
