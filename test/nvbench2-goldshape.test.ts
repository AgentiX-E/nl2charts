import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  countDataRows, main, parseArgs, runsAsMain, shapeInputOf, shapeLine, shapeOf, type ShapeInput,
} from '../eval/nvbench2/goldshape.js';
import { parseSplit } from '../eval/nvbench2/check.js';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nl2charts-goldshape-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** A chart naming two fields, which is the shape almost every gold has. */
const CHART = { mark: 'bar', encoding: { x: { field: 'name' }, y: { field: 'amount', aggregate: 'mean' } } };

function input(overrides: Partial<ShapeInput> & Pick<ShapeInput, 'rows'>): ShapeInput {
  return { columns: ['name', 'amount'], counts: {}, golds: [CHART], ...overrides };
}

describe('countDataRows', () => {
  it('counts records rather than newlines, because four dev tables quote a newline', () => {
    expect(countDataRows('a,b\n1,2\n3,4\n')).toBe(2);
    // No trailing newline: the last record still ends at the end of the text.
    expect(countDataRows('a,b\n1,2')).toBe(1);
    // The case the split actually has: a quoted field holding a newline is one record, not two.
    expect(countDataRows('a,b\n1,"x\ny"\n')).toBe(1);
    expect(countDataRows('a,b\n1,"x\ny"\n3,4\n')).toBe(2);
  });

  it('treats a doubled quote as an escape, so a quoted quote cannot end a record', () => {
    expect(countDataRows('a,b\n1,"say ""hi"""\n')).toBe(1);
    expect(countDataRows('a,b\n1,"say ""hi""\nand bye"\n')).toBe(1);
  });

  it('handles the shapes a table can arrive in without inventing rows', () => {
    expect(countDataRows('')).toBe(0);
    // A header and no data is not one row of data.
    expect(countDataRows('a,b\n')).toBe(0);
    expect(countDataRows('a,b')).toBe(0);
    // CRLF: the carriage return is not content, and it is not a second record either.
    expect(countDataRows('a,b\r\n1,2\r\n')).toBe(1);
  });
});

describe('shapeOf', () => {
  it('reports counts rather than rates, and drops a question whose table it cannot measure', () => {
    const shape = shapeOf([
      input({ rows: 10 }),
      // No row count: the question contributes nothing, and the denominator says so by staying at 1.
      input({ rows: null }),
      // A table with no columns has no gold set to describe.
      input({ rows: 10, columns: [] }),
    ]);
    expect(shape.questions).toBe(1);
    expect(shape.golds).toBe(1);
    expect(shape.fieldEncodings).toBe(2);
    expect(shape.meanCoverage).toBe(1);
  });

  it('counts an encoding on a unique-per-row column, which is the fact the ranks rule cites', () => {
    const shape = shapeOf([input({ rows: 3, counts: { name: 3, amount: 3 } })]);
    expect(shape.questionsWithUniqueColumn).toBe(1);
    expect(shape.onUniqueColumn).toBe(2);
  });

  it('takes a count as unique only when it is an integer equal to the row count', () => {
    const one = (count: unknown): number => shapeOf([input({ rows: 4, counts: { name: count } })]).onUniqueColumn;
    expect(one(4)).toBe(1);
    // A quoted count, a fraction, a negative and a count larger than the table are all not this fact.
    expect(one('4')).toBe(0);
    expect(one(4.5)).toBe(0);
    expect(one(-4)).toBe(0);
    expect(one(5)).toBe(0);
    // Zero rows is not a table, so nothing in it is unique per row.
    expect(shapeOf([input({ rows: 0, counts: { name: 0 } })]).onUniqueColumn).toBe(0);
  });

  it('counts full coverage and measures partial coverage over the columns named', () => {
    const partial = { mark: 'bar', encoding: { x: { field: 'name' } } };
    const shape = shapeOf([
      input({ rows: 5, golds: [CHART] }),
      input({ rows: 5, golds: [partial] }),
    ]);
    expect(shape.fullCoverage).toBe(1);
    expect(shape.meanCoverage).toBeCloseTo(0.75, 6);
  });

  it('reads a channel written as a bare string, and ignores a gold that is not a chart', () => {
    const bare = { mark: 'bar', encoding: { x: 'name', y: { field: 'amount' } } };
    const shape = shapeOf([input({ rows: 5, golds: [bare, 'not a chart', [CHART]] })]);
    // Two encodings from the chart that has an encoding, and nothing from the two that are not charts.
    expect(shape.fieldEncodings).toBe(2);
    expect(shape.chartsWithFields).toBe(1);
    // An entry that is not a chart is not a chart: `golds` counts the answer's charts, so a string and
    // a nested array are dropped here rather than inflating the median set size.
    expect(shape.golds).toBe(1);
  });

  it('survives a chart whose encoding is absent or is not an object', () => {
    const shape = shapeOf([input({ rows: 5, golds: [{ mark: 'bar' }, { mark: 'bar', encoding: 3 }, { mark: 'bar', encoding: [] }] })]);
    expect(shape.fieldEncodings).toBe(0);
    expect(shape.chartsWithFields).toBe(0);
  });

  it('takes the median gold-set size over an even and an odd number of questions', () => {
    const sizes = (counts: readonly number[]): number => shapeOf(counts.map((n) =>
      input({ rows: 5, golds: Array.from({ length: n }, () => CHART) }))).medianGoldSet;
    expect(sizes([1, 3])).toBe(2);
    expect(sizes([1, 2, 9])).toBe(2);
    expect(sizes([])).toBe(0);
  });

  it('reports an empty split as empty rather than dividing by zero', () => {
    const shape = shapeOf([]);
    expect(shape).toMatchObject({ questions: 0, golds: 0, fieldEncodings: 0, meanCoverage: 0, medianGoldSet: 0 });
    // The line a workflow prints has to survive that too: a run over nothing must not print NaN.
    expect(shapeLine(shape)).toBe('gold shape: 0 question(s), 0 chart(s), median 0 per question · '
      + '0 field encoding(s), 0 on a unique-per-row column (0.0%) · 0 name every column (mean coverage 0.0%)');
  });

  it('writes the line the log carries, with the share a rule would cite', () => {
    const line = shapeLine(shapeOf([input({ rows: 3, counts: { name: 3 } })]));
    expect(line).toContain('1 question(s)');
    expect(line).toContain('50.0%');
  });
});

describe('shapeInputOf', () => {
  it('takes the row count from the caller and everything else from the parsed row', () => {
    const row = {
      index: 0, csv: 'a.csv', question: 'q', golds: [CHART],
      columns: ['name', 'amount'], examples: {}, counts: { name: 3 },
    };
    expect(shapeInputOf(row, 3)).toEqual({ columns: ['name', 'amount'], counts: { name: 3 }, rows: 3, golds: [CHART] });
  });
});

describe('main', () => {
  const split = (dir: string, entries: readonly unknown[]): void => {
    writeFileSync(join(dir, 'dev.json'), JSON.stringify(entries));
    mkdirSync(join(dir, 'database_csv'), { recursive: true });
  };
  const entry = (csv: string, columns: readonly string[], counts: Record<string, number>): unknown => ({
    csv_file: csv,
    nl_query: 'q',
    gold_answer: JSON.stringify([{ mark: 'bar', encoding: { x: { field: columns[0] } } }]),
    table_schema: JSON.stringify({ table_columns: columns, column_examples: {}, unique_value_counts: counts }),
    steps: [],
  });

  it('reads the split and the tables it names, and prints one line', () => {
    const dir = scratch();
    split(dir, [entry('a.csv', ['code'], { code: 2 })]);
    writeFileSync(join(dir, 'database_csv', 'a.csv'), 'code\n1\n2\n');
    const lines: string[] = [];
    expect(main(['--cache', dir], { log: (line) => lines.push(line) })).toBe(0);
    // Two rows, two distinct values: the one column of the table is unique per row.
    expect(lines[0]).toContain('1 on a unique-per-row column (100.0%)');
    expect(lines[1]).toBe('unique-per-row columns appear in 1 of 1 question(s)');
  });

  it('drops a question whose table is missing instead of guessing its size', () => {
    const dir = scratch();
    split(dir, [entry('a.csv', ['code'], { code: 2 }), entry('gone.csv', ['code'], { code: 2 })]);
    writeFileSync(join(dir, 'database_csv', 'a.csv'), 'code\n1\n2\n');
    const lines: string[] = [];
    main(['--cache', dir], { log: (line) => lines.push(line) });
    expect(lines[0]).toContain('1 question(s)');
  });

  it('says how to get the corpus rather than throwing a bare ENOENT', () => {
    const dir = scratch();
    expect(() => main(['--cache', dir], { log: () => { /* nothing */ } })).toThrow(/fetch\.mjs/);
  });

  it('prints to stdout when nobody injects a logger, which is how the workflow runs it', () => {
    const dir = scratch();
    split(dir, [entry('a.csv', ['code'], { code: 2 })]);
    writeFileSync(join(dir, 'database_csv', 'a.csv'), 'code\n1\n2\n');
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    });
    try {
      expect(main(['--cache', dir])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(written.join('')).toContain('gold shape: 1 question(s)');
  });

  it('knows whether it was run or imported, so the entry never fires inside a test', () => {
    expect(runsAsMain('/repo/eval/nvbench2/goldshape.ts')).toBe(true);
    expect(runsAsMain('/repo/dist/goldshape.js')).toBe(true);
    expect(runsAsMain('/repo/node_modules/vitest/vitest.mjs')).toBe(false);
    expect(runsAsMain(undefined)).toBe(false);
  });

  it('reads --split and --cache, and defaults to dev in the checked-in cache', () => {
    expect(parseArgs([])).toEqual({ split: 'dev', cache: 'eval/.cache/nvbench2' });
    expect(parseArgs(['--split', 'test', '--cache', 'c'])).toEqual({ split: 'test', cache: 'c' });
  });

  it('reads through the injected reader, so a caller can supply a corpus it already has', () => {
    const dir = scratch();
    split(dir, [entry('a.csv', ['code'], { code: 2 })]);
    const seen: string[] = [];
    const lines: string[] = [];
    main(['--cache', dir], {
      log: (line) => lines.push(line),
      readText: (path) => {
        seen.push(path);
        return path.endsWith('dev.json') ? readFileSync(path, 'utf8') : 'code\n1\n2\n';
      },
    });
    expect(seen.some((path) => path.endsWith(join('database_csv', 'a.csv')))).toBe(true);
    expect(lines[0]).toContain('1 question(s)');
  });
});

/**
 * What the checked-in corpus actually says, when it is on this machine.
 *
 * The numbers are the ones the `ranks` rule cites, so they are asserted rather than remembered: a
 * rule that claims the golds avoid unique columns has to fail here, and a corpus that changes its
 * construction has to fail here too, instead of quietly making an old sentence false.
 */
const cache = 'eval/.cache/nvbench2';
const warm = ((): boolean => {
  try {
    readFileSync(join(cache, 'dev.json'));
    readFileSync(join(cache, 'database_csv', 'icfp_1@Authorship.csv'));
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!warm)('the dev split, as it is checked in', () => {
  it('builds its gold sets from the columns, including the ones that are unique per row', () => {
    const rows = parseSplit(readFileSync(join(cache, 'dev.json'), 'utf8'));
    const inputs = rows.map((row) => {
      let rowCount: number | null;
      try {
        rowCount = countDataRows(readFileSync(join(cache, 'database_csv', row.csv), 'utf8'));
      } catch {
        rowCount = null;
      }
      return shapeInputOf(row, rowCount);
    });
    const shape = shapeOf(inputs);
    expect(shape.questions).toBe(750);
    // 43.5% of field encodings name a column that is unique per row. This is the number that refuted
    // the first draft of the `ranks` rule; it is asserted so the refutation cannot be forgotten.
    expect(shape.fieldEncodings).toBe(4567);
    expect(shape.onUniqueColumn).toBe(1987);
    expect(shape.onUniqueColumn / shape.fieldEncodings).toBeCloseTo(0.435, 3);
    // And a third of the questions name every column of their table, which is the other half of the
    // same statement: the set is the columns, not the columns that sound like data.
    expect(shape.fullCoverage).toBe(248);
    expect(shape.medianGoldSet).toBe(3);
  });
});
