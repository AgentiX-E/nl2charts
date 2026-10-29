/**
 * Splitting the `values` bucket, through the classifier and through the entry.
 *
 * The unit cases pin the taxonomy against sentences, because that is what the classifier
 * reads when the result sets are ambiguous. The end-to-end case runs a real SQLite file
 * through the real oracle subprocess, because the shapes it classifies on — empty, row
 * count, scale — are produced by the engine and a stubbed result set would agree with
 * whatever the classifier was written to expect.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyValuesGap, aggregateCalls, groupingColumns, isEntry, main, resolveValuesGapSettings, runValuesGap, tallyValues, valuesGapPath, valuesLines, valuesProblems, writeValuesArtifact } from '../eval/bird/values-gap.js';
import { MINI_DB, writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();

const gap = (gold: string, predicted: string, shape: Parameters<typeof classifyValuesGap>[0]['shape']) =>
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

  it('reads a replaced literal before it reads the aggregation', () => {
    // Both statements count rows and neither groups; the only difference the reader can see
    // is which value the filter compares against, and that is the more actionable fact.
    expect(gap('select count(*) from orders where item_id = 1', 'select count(*) from orders where item_id = 2', 'values')).toBe(
      'missing-literal',
    );
  });

  it('reads a different aggregate function as an aggregation error', () => {
    expect(gap('select count(*) from items', 'select sum(price) from items', 'values')).toBe('aggregate');
  });

  it('reads a different grouping column at the same cardinality as a grain error', () => {
    expect(gap('select sum(price) from items group by name', 'select sum(price) from items group by price', 'values')).toBe('grain');
  });

  it('says unclassified when neither statement explains the difference', () => {
    expect(gap('select sum(price) from items', 'select sum(price) from items', 'values')).toBe('unclassified');
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
  it('prints every bucket with its share, then the total', () => {
    const lines = valuesLines(tallyValues(['grain', 'unclassified'])).join('\n');
    expect(lines).toContain('grain');
    expect(lines).toContain('50.0%');
    expect(lines).toContain('2 cases, 1 classified (50.0%)');
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

  const caseRow = (id: number) => ({ arm: 'select-cross', id: String(id), passed: false, reason: 'values', candidateRecall: false });

  function report(predicted: Record<string, string>, extra: readonly number[] = []): unknown {
    return {
      split: 'minidev',
      model: 'deepseek-chat',
      arms: [{ arm: 'select-cross', candidateRecall: 0 }],
      cases: [...Object.keys(predicted).map((id) => caseRow(Number(id))), ...extra.map(caseRow)],
      failures: {
        'select-cross': [
          ...Object.entries(predicted).map(([id, sql]) => ({ id, predicted: sql, reason: 'values' })),
          { id: '900', predicted: 'select 1', reason: 'values' },
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
      report({
        '5': 'select name from items',
        '3': "select name from items where name = 'zzz'",
        '7': 'select count(*) from orders where item_id = 2',
        '91': 'select qty * 2 from orders',
        '2': 'select count(*) from items',
        '90': 'select count(*) from items',
      }, [900, 1]),
    );
    const outcome = await runValuesGap(settings);
    expect(outcome.tally.buckets['filter-wide']).toBe(1);
    expect(outcome.tally.buckets['filter-narrow']).toBe(1);
    expect(outcome.tally.buckets['missing-literal']).toBe(1);
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

  it('names the gold it could not run and the prediction the engine refused', async () => {
    const data = dataset();
    const settings = settingsFor(data, report({ '1': 'select nope from items' }));
    const outcome = await runValuesGap(settings);
    expect(outcome.drops.predictionFailed).toBe(1);
    expect(outcome.tally.total).toBe(0);
    expect(outcome.problems[0]).toContain('no statement');
  });

  it('counts an empty statement as empty rather than running it', async () => {
    const data = dataset();
    const settings = settingsFor(data, report({ '1': '   ' }));
    const outcome = await runValuesGap(settings);
    expect(outcome.drops.emptyPrediction).toBe(1);
  });

  it('reads an artifact with no cases and no failures for this arm as nothing to classify', async () => {
    // Both absences are legal in an artifact from before the field existed, and neither is a
    // reason to throw: the tool reports zero and says why.
    const data = dataset();
    const settings = settingsFor(data, { split: 'minidev', model: 'deepseek-chat', arms: [{ arm: 'select-cross', candidateRecall: 0 }] });
    const outcome = await runValuesGap(settings);
    expect(outcome.tally.total).toBe(0);
    expect(outcome.drops.unretained).toBe(0);
    expect(outcome.problems).toHaveLength(1);
  });

  it('resolves the arm from the flag and defaults to the cross arm', () => {
    expect(resolveValuesGapSettings({ BIRD_SPLIT: 'minidev', BIRD_DATA: '/data' }, ['/r.json'], ROOT).arm).toBe('select-cross');
    expect(resolveValuesGapSettings({ BIRD_SPLIT: 'minidev', BIRD_DATA: '/data' }, ['/r.json', '--arm', 'select5'], ROOT).arm).toBe('select5');
    expect(() => resolveValuesGapSettings({}, ['/r.json', '--arm'], ROOT)).toThrow('--arm needs a name');
    expect(() => resolveValuesGapSettings({}, [], ROOT)).toThrow('usage');
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

  it('runs as a program and reports its exit code', async () => {
    const data = dataset();
    const settings = settingsFor(data, report({ '91': 'select qty * 2 from orders' }));
    expect(await main([settings.report, '--arm', 'select-cross'], ROOT, { BIRD_SPLIT: 'minidev', BIRD_DATA: data })).toBe(0);
    const empty = settingsFor(data, report({}));
    expect(await main([empty.report, '--arm', 'select-cross'], ROOT, { BIRD_SPLIT: 'minidev', BIRD_DATA: data })).toBe(1);
  });

  it('answers whether it is the program', () => {
    const own = new URL('../eval/bird/values-gap.ts', import.meta.url).href;
    expect(isEntry(new URL('../eval/bird/values-gap.ts', import.meta.url).pathname, own)).toBe(true);
    expect(isEntry(new URL('../eval/bird/gap.ts', import.meta.url).pathname, own)).toBe(false);
    expect(isEntry(undefined, own)).toBe(false);
  });
});
