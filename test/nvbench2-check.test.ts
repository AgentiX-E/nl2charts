import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cacheDir, casesOf, entryTail, EXPECTED, fieldsOf, looksQuantitative, main, parseSplit, patchedOf,
  problemsOf, readingOfSplit, reportLines, resolveTypes, swappedOf,
} from '../eval/nvbench2/check.js';
import type { FieldTypes } from '../eval/nvbench2/judge.js';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nl2charts-nvbench2-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) {
    // The fixtures are a few kilobytes each; leaving them behind is untidy, not unsafe.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const TABLE: FieldTypes = { amount: 'quantitative', name: 'category' };

/** A question whose gold names a measure and a dimension, and whose schema agrees with the map. */
const question = (csv: string, golds: unknown[] = [{
  mark: 'bar', encoding: { x: { field: 'name' }, y: { field: 'amount' } },
}]): Record<string, unknown> => ({
  csv_file: csv,
  nl_query: `how much per name, in ${csv}`,
  table_schema: JSON.stringify({
    table_columns: ['amount', 'name'],
    column_examples: { amount: [1, 2, 3], name: ['a', 'b', 'c'] },
    unique_value_counts: { amount: 3, name: 3 },
  }),
  gold_answer: JSON.stringify(golds),
});

/**
 * A corpus of the size the gate insists on.
 *
 * `main` compares the map against 803 tables and each split against 750 and 751 questions, so a
 * three-row fixture would only ever exercise the refusal. Building the real shape costs a few
 * milliseconds and buys the success path — which is the one a workflow depends on.
 */
function corpus(options: {
  tables?: number;
  dev?: number;
  test?: number;
  types?: Record<string, Record<string, string>>;
  questions?: (csv: string) => Record<string, unknown>;
} = {}): string {
  const dir = scratch();
  const tables = options.tables ?? EXPECTED.tables;
  const dev = options.dev ?? EXPECTED.splits.dev.questions;
  const test = options.test ?? EXPECTED.splits.test.questions;
  const types: Record<string, Record<string, string>> = options.types ?? {};
  for (let index = 0; index < tables; index += 1) types[`t${String(index)}.csv`] ??= { ...TABLE };
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({
    csv: Object.keys(types).length, digest: 'fixture', fields: { quantitative: 1, category: 1 }, types,
  }));
  const make = options.questions ?? ((csv: string) => question(csv));
  // Questions cycle over the split's own tables — 92 for dev, 87 for test — because the gate compares
  // that count, and a fixture where every question had its own table would fail it for the wrong
  // reason.
  for (const [split, count] of [['dev', dev], ['test', test]] as const) {
    const spread = EXPECTED.splits[split].tables;
    const rows = Array.from({ length: count }, (_, index) => make(`t${String(index % spread)}.csv`));
    writeFileSync(join(dir, `${split}.json`), JSON.stringify(rows));
  }
  return dir;
}

const out = (): { seen: string[]; log: (line: string) => void } => {
  const seen: string[] = [];
  return { seen, log: (line) => { seen.push(line); } };
};

describe('resolveTypes', () => {
  it('reads the payload metadata.py writes', () => {
    expect(resolveTypes({ types: { 'a.csv': TABLE } })).toEqual({ 'a.csv': TABLE });
  });

  it('reads a bare map too, because that is what the file would be without the wrapper', () => {
    expect(resolveTypes({ 'a.csv': TABLE })).toEqual({ 'a.csv': TABLE });
  });

  it('refuses a payload that is not an object', () => {
    expect(() => resolveTypes([])).toThrow(/not an object/u);
  });

  it('refuses a payload whose types is not an object', () => {
    // A bare map is accepted (that is what the file would be without its wrapper), so the refusal
    // has to be about a `types` that is present and wrong rather than absent.
    expect(() => resolveTypes({ types: 'amount' })).toThrow(/no `types` object/u);
  });

  it('refuses an entry that is not an object', () => {
    expect(() => resolveTypes({ types: { 'a.csv': 'amount' } })).toThrow(/a\.csv is not an object/u);
  });

  it('refuses a kind it does not know, because an unknown kind is silently "not quantitative"', () => {
    expect(() => resolveTypes({ types: { 'a.csv': { amount: 'numeric' } } }))
      .toThrow(/a\.csv\.amount is not a kind: numeric/u);
  });
});

describe('parseSplit', () => {
  it('reads the fields a question has', () => {
    const rows = parseSplit(JSON.stringify([question('a.csv')]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ index: 0, csv: 'a.csv', columns: ['amount', 'name'] });
    expect(rows[0]?.question).toContain('how much');
    expect(rows[0]?.golds).toHaveLength(1);
  });

  it('refuses a split that is not a list', () => {
    expect(() => parseSplit('{}')).toThrow(/not an array/u);
  });

  it('refuses an entry that is not an object', () => {
    expect(() => parseSplit('[1]')).toThrow(/entry 0 is not an object/u);
  });

  it('names the entry that has no csv_file or no question', () => {
    expect(() => parseSplit(JSON.stringify([{ nl_query: 'x' }]))).toThrow(/entry 0 has no csv_file/u);
    expect(() => parseSplit(JSON.stringify([{ ...question('a.csv'), nl_query: '' }])))
      .toThrow(/entry 0 has no nl_query/u);
  });

  it('refuses a gold that is not a string, does not parse, or is not a list', () => {
    expect(() => parseSplit(JSON.stringify([{ ...question('a.csv'), gold_answer: [] }])))
      .toThrow(/non-string gold_answer/u);
    expect(() => parseSplit(JSON.stringify([{ ...question('a.csv'), gold_answer: 'nope' }])))
      .toThrow(/gold_answer that does not parse/u);
    expect(() => parseSplit(JSON.stringify([{ ...question('a.csv'), gold_answer: '{}' }])))
      .toThrow(/gold_answer that is not a list/u);
  });

  it('refuses a schema that is not a string, does not parse, or has no columns', () => {
    expect(() => parseSplit(JSON.stringify([{ ...question('a.csv'), table_schema: {} }])))
      .toThrow(/non-string table_schema/u);
    expect(() => parseSplit(JSON.stringify([{ ...question('a.csv'), table_schema: 'null' }])))
      .toThrow(/table_schema that is not an object/u);
    expect(() => parseSplit(JSON.stringify([{ ...question('a.csv'), table_schema: '{}' }])))
      .toThrow(/no table_columns/u);
    expect(() => parseSplit(JSON.stringify([{
      ...question('a.csv'), table_schema: JSON.stringify({ table_columns: [1] }),
    }]))).toThrow(/no table_columns/u);
    expect(() => parseSplit(JSON.stringify([{
      ...question('a.csv'), table_schema: JSON.stringify({ table_columns: [] }),
    }]))).toThrow(/no column_examples/u);
  });
});

describe('fieldsOf', () => {
  it('reads a string field, a list field and a filter field', () => {
    expect(fieldsOf({
      mark: 'bar',
      encoding: { x: { field: 'a' }, y: { field: ['b', 'c'] }, color: { field: 7 } },
      transform: [{ filter: { field: 'd', gt: 1 } }, { calculate: 'x' }],
    })).toEqual(['a', 'b', 'd']);
  });

  it('reads nothing from a chart that is not an object', () => {
    expect(fieldsOf(null)).toEqual([]);
    expect(fieldsOf({ encoding: 'x' })).toEqual([]);
  });
});

describe('looksQuantitative', () => {
  it('reads the min/median/max triple the generator writes', () => {
    expect(looksQuantitative([1, 2.5, 3])).toBe(true);
  });

  it('refuses a list of strings, a list holding a string, an empty list and a non-list', () => {
    expect(looksQuantitative(['a', 'b', 'c'])).toBe(false);
    expect(looksQuantitative([1, 'b', 3])).toBe(false);
    expect(looksQuantitative([])).toBe(false);
    expect(looksQuantitative('1')).toBe(false);
  });
});

describe('readingOfSplit', () => {
  it('counts questions, tables, golds and field references', () => {
    const rows = parseSplit(JSON.stringify([question('a.csv'), question('b.csv'), question('a.csv')]));
    const reading = readingOfSplit('dev', rows, { 'a.csv': TABLE, 'b.csv': TABLE });
    expect(reading).toMatchObject({
      split: 'dev', questions: 3, tables: 2, golds: 3, emptyGold: 0,
      fieldRefs: 6, unresolved: 0, schemaFields: 6, missingSchema: 0, typeDisagreements: 0,
    });
  });

  it('counts a field with no type, a column with no type, and a disagreement separately', () => {
    const rows = parseSplit(JSON.stringify([question('a.csv')]));
    const reading = readingOfSplit('dev', rows, { 'a.csv': { amount: 'quantitative' } });
    expect(reading.unresolved).toBe(1);
    expect(reading.missingSchema).toBe(1);
    expect(reading.typeDisagreements).toBe(0);
  });

  it('counts a type that disagrees with the shipped examples', () => {
    const rows = parseSplit(JSON.stringify([question('a.csv')]));
    const reading = readingOfSplit('dev', rows, { 'a.csv': { amount: 'category', name: 'category' } });
    expect(reading.typeDisagreements).toBe(1);
  });

  it('counts a question with no gold and one whose table is missing entirely', () => {
    const rows = parseSplit(JSON.stringify([question('a.csv', [])]));
    const reading = readingOfSplit('dev', rows, {});
    expect(reading.emptyGold).toBe(1);
    expect(reading.unresolved).toBe(0);
    expect(reading.missingSchema).toBe(2);
  });
});

describe('problemsOf', () => {
  const clean = {
    split: 'dev', questions: 750, tables: 92, golds: 1, emptyGold: 0, fieldRefs: 2, unresolved: 0,
    schemaFields: 2, missingSchema: 0, typeDisagreements: 0,
  };

  it('finds nothing wrong with a clean reading', () => {
    expect(problemsOf(clean)).toEqual([]);
  });

  it('refuses a split with no questions, and says only that', () => {
    expect(problemsOf({ ...clean, questions: 0, tables: 0, golds: 0, fieldRefs: 0, schemaFields: 0 }))
      .toEqual(['dev: the split has no questions']);
  });

  it('reports every way a corpus can be unscorable', () => {
    expect(problemsOf({ ...clean, emptyGold: 2 })).toContain('dev: 2 questions have no gold');
    expect(problemsOf({ ...clean, unresolved: 3 })).toContain('dev: 3 of 2 gold fields have no type');
    expect(problemsOf({ ...clean, missingSchema: 1 })).toContain('dev: 1 of 2 table columns have no type');
    expect(problemsOf({ ...clean, typeDisagreements: 4 })).toContain('dev: 4 of 2 field types disagree with the corpus');
  });

  it('compares the counts against the corpus, because a changed count is a changed benchmark', () => {
    expect(problemsOf({ ...clean, questions: 749 })).toContain('dev: 749 questions, the corpus has 750');
    expect(problemsOf({ ...clean, tables: 91 })).toContain('dev: 91 tables asked about, the corpus asks 92');
  });

  it('has no count to compare a split it does not know', () => {
    expect(problemsOf({ ...clean, split: 'train' })).toEqual([]);
  });
});

describe('reportLines', () => {
  it('prints four lines per split', () => {
    const lines = reportLines([{
      split: 'dev', questions: 750, tables: 92, golds: 2321, emptyGold: 0, fieldRefs: 5490,
      unresolved: 0, schemaFields: 4158, missingSchema: 0, typeDisagreements: 0,
    }]);
    expect(lines).toEqual([
      'dev: 750 questions over 92 tables',
      'dev: 2321 gold charts, 0 questions without one',
      'dev: 5490 field references, 0 untyped',
      'dev: 4158 table columns, 0 untyped, 0 disagreeing with column_examples',
    ]);
  });
});

describe('the probe predictions', () => {
  const gold = { mark: 'bar', encoding: { x: { field: 'name' }, y: { field: 'amount' } } };

  it('asks three questions of every gold, in a fixed order', () => {
    const rows = parseSplit(JSON.stringify([question('a.csv')]));
    const [item] = casesOf(rows, { 'a.csv': TABLE });
    expect(item?.predictions).toHaveLength(3);
    expect(item?.predictions[0]).toEqual(gold);
    expect(item?.types).toEqual(TABLE);
  });

  it('transposes a gold, and leaves alone one that has nothing to transpose', () => {
    expect(swappedOf(gold)).toEqual({
      mark: 'bar', encoding: { x: { field: 'amount' }, y: { field: 'name' } },
    });
    expect(swappedOf({ mark: 'bar' })).toEqual({ mark: 'bar' });
    expect(swappedOf({ mark: 'bar', encoding: 'x' })).toEqual({ mark: 'bar', encoding: 'x' });
    expect(swappedOf({ mark: 'bar', encoding: { x: { field: 'a' } } }))
      .toEqual({ mark: 'bar', encoding: { x: { field: 'a' } } });
    expect(swappedOf('nonsense')).toBe('nonsense');
  });

  it('patches one property, and leaves a non-object alone', () => {
    expect(patchedOf(gold, { mark: 'point' })).toEqual({ ...gold, mark: 'point' });
    expect(patchedOf(null, { mark: 'point' })).toBeNull();
    expect(patchedOf(gold, { mark: 'point' })).not.toBe(gold);
  });

  it('attaches an empty map when the table is unknown rather than the whole corpus', () => {
    // The mistake this guards: passing `{csv: fields}` where a table's fields belong makes every
    // lookup undefined, which switches the axis rules off without saying so.
    const rows = parseSplit(JSON.stringify([question('a.csv')]));
    expect(casesOf(rows, {})[0]?.types).toEqual({});
  });
});

describe('main', () => {
  it('reads a corpus of the size the gate expects and exits 0', async () => {
    const log = out();
    expect(await main(['--cache', corpus()], log.log)).toBe(0);
    expect(log.seen[0]).toBe('dev: 750 questions over 92 tables');
    expect(log.seen).toHaveLength(8);
    expect(log.seen.join('\n')).not.toContain('nvbench2 corpus:');
  });

  it('names the command that builds the map when it is cold', async () => {
    const log = out();
    expect(await main(['--cache', scratch()], log.log)).toBe(2);
    expect(log.seen.join('\n')).toContain('metadata is cold');
    expect(log.seen.join('\n')).toContain('python3 eval/nvbench2/metadata.py');
  });

  it('names the command that fetches a split when it is cold', async () => {
    const dir = corpus();
    unlinkSync(join(dir, 'test.json'));
    const log = out();
    expect(await main(['--cache', dir], log.log)).toBe(2);
    expect(log.seen.join('\n')).toContain('split is cold');
  });

  it('refuses a map whose table count is not the corpus', async () => {
    const log = out();
    expect(await main(['--cache', corpus({ tables: 802 })], log.log)).toBe(1);
    expect(log.seen).toEqual(['nvbench2: the map holds 802 tables, the corpus has 803']);
  });

  it('exits 1, not 2, when the corpus is readable and unscorable', async () => {
    const dir = corpus({ types: { 't0.csv': { amount: 'quantitative' } } });
    const log = out();
    expect(await main(['--cache', dir], log.log)).toBe(1);
    // `t0.csv` is the first of dev's 92 tables and 750 questions cycle over them, so the one short
    // map is met nine times. The point of the case is the exit code and the sentence, not the count.
    expect(log.seen.join('\n')).toContain('nvbench2 corpus: dev: 9 of 1500 table columns have no type');
    expect(log.seen.join('\n')).toContain('nvbench2 corpus: dev: 9 of 1500 gold fields have no type');
  });

  it('reports a question file that is not JSON as unreadable', async () => {
    const dir = corpus();
    writeFileSync(join(dir, 'dev.json'), '{not json');
    const log = out();
    expect(await main(['--cache', dir], log.log)).toBe(2);
    expect(log.seen.join('\n')).toMatch(/nvbench2: .*JSON/u);
  });

  it('writes to stdout when no logger is injected, which is how a workflow reads it', async () => {
    // The default logger is a function nothing else calls; a run that always injected one would let
    // a broken default ship.
    expect(await main(['--cache', corpus()])).toBe(0);
  });

  it('falls back to the environment when no cache is given, and to the repository when that is unset', () => {
    const previous = process.env.NVBENCH2_CACHE;
    try {
      process.env.NVBENCH2_CACHE = '/tmp/from-the-environment';
      expect(cacheDir()).toBe('/tmp/from-the-environment');
      delete process.env.NVBENCH2_CACHE;
      expect(cacheDir()).toMatch(/eval\/\.cache\/nvbench2$/u);
      expect(cacheDir('/tmp/explicit')).toBe('/tmp/explicit');
    } finally {
      if (previous !== undefined) process.env.NVBENCH2_CACHE = previous;
    }
  });
});

describe('entryTail', () => {
  it('sets an exit code only when there is one', () => {
    const seen: number[] = [];
    entryTail(undefined, (value) => seen.push(value));
    expect(seen).toEqual([]);
    entryTail(3, (value) => seen.push(value));
    expect(seen).toEqual([3]);
  });

  it('writes to the process when no setter is given, which is how the tool runs', () => {
    const previous = process.exitCode;
    entryTail(2);
    expect(process.exitCode).toBe(2);
    entryTail(undefined);
    expect(process.exitCode).toBe(2);
    process.exitCode = previous;
  });
});

describe('the fixture on disk', () => {
  it('is what the corpus actually printed, so a reader can check this suite against it', () => {
    const fixture = JSON.parse(readFileSync('eval/nvbench2/metrics.json', 'utf8')) as {
      metadataDigest: string;
      tables: number;
      splits: Record<string, { questions: number; transposed: number; digest: string; f1: Record<string, number> }>;
    };
    expect(fixture.tables).toBe(EXPECTED.tables);
    expect(fixture.metadataDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(fixture.splits.dev?.questions).toBe(EXPECTED.splits.dev.questions);
    expect(fixture.splits.test?.questions).toBe(EXPECTED.splits.test.questions);
    // Half of dev's gold charts are transpose-equivalent under the reference's own type map, which
    // is the reading that makes the map worth rebuilding rather than approximating.
    expect(fixture.splits.dev?.transposed).toBe(381);
    expect(fixture.splits.test?.transposed).toBe(437);
  });
});
