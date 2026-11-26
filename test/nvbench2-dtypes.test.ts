/**
 * The channel rule may only assert what the corpus shows, and the corpus shows four absolutes.
 *
 * The `dtype` rule exists because `misplaced` — 151 of the test split's 465 field-first misses — is an
 * assignment error: the reply names a column a gold names, on a channel no gold puts it on. A rule
 * about *which* column to pick cannot reach that; what is needed is a rule about which *kind* of
 * column a channel accepts. So the rule says `color` takes a category, `size` and `theta` take a
 * measure, and `x` carries no aggregate — and this file checks those sentences against the counts in
 * `metrics.json` rather than against the paragraph that motivated them.
 *
 * The counts come from `eval/nvbench2/dtypes.ts`, which is offline and free to rebuild, so a corpus
 * that changed would fail here instead of quietly making the rule false.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildSpecPrompt } from '../eval/nvbench2/arm.js';
import { parseSplit, type SplitRow } from '../eval/nvbench2/check.js';
import type { FieldTypes } from '../eval/nvbench2/judge.js';
import {
  dtypeOf, dtypesLine, dtypesOf, main, parseArgs, runsAsMain, shareOf, type DtypeFacts,
} from '../eval/nvbench2/dtypes.js';

const metrics = JSON.parse(readFileSync(resolve(process.cwd(), 'eval/nvbench2/metrics.json'), 'utf8')) as {
  dtypes: { because: string; dev: DtypeFacts; test: DtypeFacts };
};

/** A row, as the split parser would hand it over. */
function row(csv: string, golds: readonly unknown[]): SplitRow {
  return { index: 0, csv, question: 'q', golds, columns: [], examples: {}, counts: {} };
}

/** One question file entry, in the shape `parseSplit` validates: columns and examples, as strings. */
function entry(csv: string, golds: readonly unknown[], columns: readonly string[] = ['amount', 'region']): Record<string, unknown> {
  const examples = Object.fromEntries(columns.map((column) => [column, ['x']]));
  return {
    csv_file: csv,
    nl_query: 'q',
    table_schema: JSON.stringify({ table_columns: [...columns], column_examples: examples }),
    gold_answer: JSON.stringify(golds),
  };
}

const TYPES: Readonly<Record<string, FieldTypes>> = {
  't@T.csv': { amount: 'quantitative', region: 'category', when: 'temporal', Total: 'quantitative' },
};

describe('one encoding is reduced to the three things the counts need', () => {
  it('reads a bare string channel as a field and an object channel as a field and an aggregate', () => {
    const facts = dtypesOf([
      row('t@T.csv', [
        { mark: 'bar', encoding: { x: 'region', y: { field: 'amount', aggregate: 'mean' } } },
      ]),
    ], TYPES);
    expect(facts.encodings).toBe(2);
    expect(facts.channels['x']).toEqual({ category: 1 });
    expect(facts.channels['y']).toEqual({ quantitative: 1 });
    expect(facts.aggregated).toEqual({ y: 1 });
    expect(facts.raw).toEqual({ x: 1 });
  });

  it('counts an empty aggregate as none, because `{"aggregate": ""}` names nothing', () => {
    const facts = dtypesOf([
      row('t@T.csv', [{ mark: 'bar', encoding: { y: { field: 'amount', aggregate: '' } } }]),
    ], TYPES);
    expect(facts.aggregated['y']).toBeUndefined();
    expect(facts.raw['y']).toBe(1);
  });

  it('skips a gold that is not a chart, and a chart with no encoding', () => {
    const facts = dtypesOf([
      row('t@T.csv', ['not a chart', 7, null, { mark: 'bar' }, { mark: 'bar', encoding: 'x' }, { encoding: { x: { aggregate: 'sum' } } }]),
    ], TYPES);
    expect(facts.encodings).toBe(0);
  });

  it('ignores a channel whose spec is neither a field nor an object with one', () => {
    const facts = dtypesOf([
      row('t@T.csv', [{ encoding: { x: 7, y: { field: 5 }, color: ['amount'], size: { aggregate: 'sum' } } }]),
    ], TYPES);
    expect(facts.encodings).toBe(0);
  });

  it('treats a type map entry that is not a string as untyped', () => {
    // The metadata step validates dtypes, so this is a corrupt map rather than a corpus fact; it is
    // counted as unknown instead of crashing, because a missing count is visible and a throw is not.
    const corrupt = { amount: 3 } as unknown as FieldTypes;
    expect(dtypeOf(corrupt, 'amount')).toBe('unknown');
  });

  it('counts a field the type map does not name instead of dropping it', () => {
    // Dropping it would make the shares look exact while a slice of the corpus went uncounted.
    const facts = dtypesOf([
      row('t@T.csv', [{ encoding: { x: { field: 'ghost' } } }, { encoding: { x: { field: 'amount' } } }]),
      row('absent@T.csv', [{ encoding: { x: { field: 'amount' } } }]),
    ], TYPES);
    expect(facts.encodings).toBe(3);
    expect(facts.unknown).toBe(2);
    expect(facts.channels['x']).toEqual({ unknown: 2, quantitative: 1 });
  });

  it('finds a column whose case the gold and the type map disagree about', () => {
    // The corpus writes `Total` in the type map and `total` in some golds; a case-sensitive lookup
    // would report 0 untyped here, which happens to be right, and a large number on the real split.
    expect(dtypeOf(TYPES['t@T.csv'] ?? {}, 'total')).toBe('quantitative');
    expect(dtypeOf(TYPES['t@T.csv'] ?? {}, 'amount')).toBe('quantitative');
    expect(dtypeOf({}, 'amount')).toBe('unknown');
  });

  it('reports a share of zero rather than dividing by a channel nobody used', () => {
    const facts: DtypeFacts = { encodings: 0, unknown: 0, channels: {}, aggregated: {}, raw: {} };
    expect(shareOf(facts, 'color', 'category')).toBe(0);
    expect(dtypesLine(facts)).toContain('0 encoding(s)');
  });

  it('prints the dominant kind per channel and how often that channel carries an aggregate', () => {
    const facts = dtypesOf([
      row('t@T.csv', [{ encoding: { color: { field: 'region' }, theta: { field: 'amount', aggregate: 'sum' } } }]),
    ], TYPES);
    const line = dtypesLine(facts);
    expect(line).toContain('color: category 1/1');
    expect(line).toContain('theta: quantitative 1/1, aggregate 1/1');
  });
});

describe('the flags, the entry and the file it reads', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dtypes-'));
  afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

  it('defaults to dev in the repository cache and takes both flags', () => {
    expect(parseArgs([])).toEqual({ split: 'dev', cache: 'eval/.cache/nvbench2' });
    expect(parseArgs(['--split', 'test', '--cache', '/tmp/x'])).toEqual({ split: 'test', cache: '/tmp/x' });
  });

  it('recognises itself as the entry point and nothing else', () => {
    expect(runsAsMain('/x/dtypes.ts')).toBe(true);
    expect(runsAsMain('/x/dtypes.js')).toBe(true);
    expect(runsAsMain('/x/goldshape.ts')).toBe(false);
    expect(runsAsMain(undefined)).toBe(false);
  });

  it('prints the line and the JSON a reader can paste into metrics.json', () => {
    writeFileSync(join(scratch, 'dev.json'), JSON.stringify([
      entry('t@T.csv', [{ mark: 'bar', encoding: { x: 'region', y: { field: 'amount', aggregate: 'mean' } } }]),
    ]));
    writeFileSync(join(scratch, 'metadata.json'), JSON.stringify({ types: TYPES }));
    const lines: string[] = [];
    expect(main(['--cache', scratch], { log: (line) => lines.push(line) })).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('gold channels: 2 encoding(s)');
    expect(JSON.parse(lines[1] as string).encodings).toBe(2);
  });

  it('writes to stdout when it is given no logger, because that is how the CLI is run', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(main(['--cache', scratch])).toBe(0);
      expect(write.mock.calls.length).toBeGreaterThan(1);
    } finally {
      write.mockRestore();
    }
  });

  it('refuses a split it cannot open, naming the fetcher that would have written it', () => {
    expect(() => main(['--cache', join(scratch, 'empty')], { log: () => {} })).toThrow(/fetch\.mjs/);
  });

  it('refuses a missing type map, naming the step that builds it', () => {
    // The split is present and the types are not, which is the state a fresh checkout is in after the
    // fetcher and before the metadata step.
    const bare = mkdtempSync(join(tmpdir(), 'dtypes-bare-'));
    try {
      writeFileSync(join(bare, 'dev.json'), readFileSync(join(scratch, 'dev.json')));
      expect(() => main(['--cache', bare], { log: () => {} })).toThrow(/metadata/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('exits 2 when the split names no encoding at all, because 0 of 0 is not a table', () => {
    writeFileSync(join(scratch, 'blank.json'), JSON.stringify([entry('t@T.csv', [])]));
    expect(main(['--cache', scratch, '--split', 'blank'], { log: () => {} })).toBe(2);
  });
});

describe('the rule states four invariants and the corpus holds all four', () => {
  const pooled = (): DtypeFacts => {
    const sum = (parts: readonly DtypeFacts[]): DtypeFacts => {
      const channels: Record<string, Record<string, number>> = {};
      const aggregated: Record<string, number> = {};
      const raw: Record<string, number> = {};
      let encodings = 0;
      let unknown = 0;
      for (const part of parts) {
        encodings += part.encodings;
        unknown += part.unknown;
        for (const [channel, byDtype] of Object.entries(part.channels)) {
          const target = (channels[channel] ??= {});
          for (const [dtype, count] of Object.entries(byDtype)) target[dtype] = (target[dtype] ?? 0) + count;
        }
        for (const [channel, count] of Object.entries(part.aggregated)) aggregated[channel] = (aggregated[channel] ?? 0) + count;
        for (const [channel, count] of Object.entries(part.raw)) raw[channel] = (raw[channel] ?? 0) + count;
      }
      return { encodings, unknown, channels, aggregated, raw };
    };
    return sum([metrics.dtypes.dev, metrics.dtypes.test]);
  };

  it('records the counts with their denominator and their reason', () => {
    expect(metrics.dtypes.because).toContain('color');
    for (const split of [metrics.dtypes.dev, metrics.dtypes.test]) {
      expect(split.encodings).toBeGreaterThan(4000);
      expect(split.unknown).toBe(0);
    }
  });

  it('holds color to a category, in every encoding of both splits', () => {
    // "color takes a category and nothing else" — the strongest sentence in the rule, and the one the
    // golds never break: a measure on color is not a disagreement with the golds, it is a category
    // error, which is why the rule can state it without a hedge.
    const facts = pooled();
    expect(Object.keys(facts.channels['color'] ?? {})).toEqual(['category']);
    expect(facts.channels['color']?.['category']).toBe(2583);
    expect(facts.aggregated['color']).toBeUndefined();
  });

  it('holds theta and size to a measure, and size to an aggregate', () => {
    const facts = pooled();
    expect(Object.keys(facts.channels['theta'] ?? {})).toEqual(['quantitative']);
    expect(Object.keys(facts.channels['size'] ?? {})).toEqual(['quantitative']);
    expect(facts.channels['theta']?.['quantitative']).toBe(521);
    expect(facts.channels['size']?.['quantitative']).toBe(156);
    expect(facts.aggregated['size']).toBe(156);
  });

  it('holds x to no aggregate and to a category in four encodings of five', () => {
    // The rule says x carries no aggregate; it does not say x is always categorical, because it is
    // not — 1,055 of 3,530 x encodings are quantitative, and a rule that said otherwise would be
    // telling the arm to drop the columns its own golds put on the axis.
    const facts = pooled();
    expect(facts.aggregated['x']).toBeUndefined();
    const x = facts.channels['x'] ?? {};
    const total = Object.values(x).reduce((a, b) => a + b, 0);
    expect(total).toBe(3530);
    expect((x['category'] ?? 0) / total).toBeGreaterThan(0.79);
    expect((x['category'] ?? 0) / total).toBeLessThan(0.8);
  });

  it('counts 9,076 encodings and leaves none of them untyped', () => {
    // An untyped encoding is a rule about string comparison wearing the clothes of a rule about the
    // corpus, so zero is the only acceptable value here.
    expect(pooled().encodings).toBe(9076);
  });

  it('sends the rule when it is asked for, and names the channels it constrains', () => {
    const [system] = buildSpecPrompt(
      { question: 'average amount per region', columns: ['amount', 'region'] },
      TYPES['t@T.csv'] ?? {},
      3,
      ['dtype'],
    );
    for (const channel of ['color', 'theta', 'size']) expect(system).toContain(channel);
    expect(system).toContain('never takes x');
    // And it is not in the product path until an arm separates on it: a rule that ships on prose is
    // the defect `spread` was retired for.
    const [withoutDtype] = buildSpecPrompt({ question: 'q', columns: ['amount'] }, TYPES['t@T.csv'] ?? {}, 3);
    expect(withoutDtype).not.toContain('never takes x');
  });
});

describe('the split parser hands this file the same rows every other tool sees', () => {
  it('accepts a parsed split rather than a private shape', () => {
    const rows = parseSplit(JSON.stringify([
      entry('t@T.csv', [{ mark: 'bar', encoding: { y: { field: 'amount', aggregate: 'sum' } } }], ['amount']),
    ]));
    expect(dtypesOf(rows, TYPES).aggregated['y']).toBe(1);
  });
});
