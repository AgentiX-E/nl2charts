import { describe, expect, it } from 'vitest';
import { PROBE_LITERALS, PROBE_ROWS, probeValueGaps } from '../eval/bird/value-probe.js';
import type { ProbeColumn } from '../eval/bird/value-probe.js';

/**
 * A database small enough to answer by hand, and strict enough to catch a bad statement.
 *
 * The fake refuses any statement it does not recognise, so a probe that built the wrong SQL
 * fails here instead of silently returning no rows — which is the failure mode that would make
 * every literal look `absent` against a real engine that merely choked.
 */
const DATA: Record<string, string[]> = {
  'cards.name': ['Benalish Knight (Fellwar Stone)', 'Benalish Hero', 'Black Lotus'],
  'cards.colour': ['Red', 'Blue'],
  'cards.id': ['1', '2'],
  'sets.code': ['LEA', 'LEB'],
  'prints.name': ['Red'],
};

function engine(log: string[] = []): (sql: string) => Promise<readonly (readonly unknown[])[] | undefined> {
  return async (sql: string) => {
    log.push(sql);
    const target = /select distinct "([^"]+)" from "([^"]+)"/.exec(sql);
    const pattern = /like lower\('%(.*)%'\)/i.exec(sql);
    if (target === null || pattern === null) throw new Error(`unexpected probe: ${sql}`);
    const rows = DATA[`${target[2]}.${target[1]}`];
    if (rows === undefined) return undefined;
    const needle = pattern[1] as string;
    return rows.filter((value) => value.toLowerCase().includes(needle.toLowerCase())).map((value) => [value]);
  };
}

const CARDS: readonly ProbeColumn[] = [
  { table: 'cards', column: 'name', type: 'TEXT' },
  { table: 'cards', column: 'colour', type: 'TEXT' },
  { table: 'cards', column: 'id', type: 'INTEGER' },
];

describe('looking a literal up in the column it is compared against', () => {
  it('reports the values a column holds that contain the literal', async () => {
    const probe = await probeValueGaps("select id from cards where name = 'benalish knight'", CARDS, engine());
    expect(probe.gaps).toHaveLength(1);
    expect(probe.gaps[0]?.kind).toBe('partial');
    expect(probe.gaps[0]?.column).toBe('cards.name');
    expect(probe.gaps[0]?.values).toEqual(['Benalish Knight (Fellwar Stone)']);
    expect(probe.grounded).toBeUndefined();
  });

  it('rewrites a literal whose case is the only difference, for no call', async () => {
    const sql = "select id from cards where colour = 'red'";
    const probe = await probeValueGaps(sql, CARDS, engine());
    expect(probe.probes[0]?.kind).toBe('case');
    expect(probe.grounded).toBe("select id from cards where colour = 'Red'");
  });

  it('says the value is absent when nothing in the column contains it', async () => {
    const probe = await probeValueGaps("select id from cards where name = 'atlantis'", CARDS, engine());
    expect(probe.gaps[0]).toEqual({ literal: 'atlantis', column: 'cards.name', kind: 'absent', values: [] });
  });

  it('reports nothing when the column stores the literal as written', async () => {
    const probe = await probeValueGaps("select id from cards where name = 'Benalish Hero'", CARDS, engine());
    expect(probe.probes[0]?.kind).toBe('exact');
    expect(probe.gaps).toEqual([]);
    expect(probe.grounded).toBeUndefined();
  });

  it('does not look up a pattern, which is not a value', async () => {
    const log: string[] = [];
    const probe = await probeValueGaps("select id from cards where name like '%knight%'", CARDS, engine(log));
    expect(log).toEqual([]);
    expect(probe.queries).toBe(0);
  });

  it('does not look up an empty literal', async () => {
    const log: string[] = [];
    await probeValueGaps("select id from cards where name = ''", CARDS, engine(log));
    expect(log).toEqual([]);
  });

  it('looks a repeated literal up once', async () => {
    const log: string[] = [];
    await probeValueGaps("select id from cards where name = 'atlantis' or name = 'atlantis'", CARDS, engine(log));
    expect(log).toHaveLength(1);
  });

  it('quotes a literal that carries an apostrophe', async () => {
    const log: string[] = [];
    await probeValueGaps("select id from cards where name = 'o''brien'", CARDS, engine(log));
    expect(log[0]).toContain("'%o''brien%'");
  });

  it('counts the lookups it made, and bounds the rows each one asks for', async () => {
    const log: string[] = [];
    const probe = await probeValueGaps("select id from cards where name = 'x' and colour = 'y'", CARDS, engine(log));
    expect(probe.queries).toBe(2);
    expect(log.every((sql) => sql.endsWith(`limit ${PROBE_ROWS}`))).toBe(true);
  });

  it('reads a refused lookup as no evidence rather than as absence', async () => {
    const probe = await probeValueGaps("select id from cards where name = 'x'", CARDS, async () => undefined);
    expect(probe.probes).toEqual([]);
    expect(probe.gaps).toEqual([]);
    expect(probe.queries).toBe(1);
  });

  it('drops a null the column stores among its values', async () => {
    const run = async () => [[null], ['Black Lotus']] as (readonly unknown[])[];
    const probe = await probeValueGaps("select id from cards where name = 'lotus'", CARDS, run);
    expect(probe.gaps[0]?.values).toEqual(['Black Lotus']);
  });

  it(`probes at most ${PROBE_LITERALS} literals of one statement`, async () => {
    const literals = Array.from({ length: PROBE_LITERALS + 2 }, (_unused, index) => `name = 'lit${index}'`).join(' and ');
    const log: string[] = [];
    const probe = await probeValueGaps(`select id from cards where ${literals}`, CARDS, engine(log));
    expect(probe.probes).toHaveLength(PROBE_LITERALS);
    expect(log).toHaveLength(PROBE_LITERALS);
  });
});

describe('a column the schema does not name', () => {
  it('sweeps the text columns and stops at the first table that holds anything', async () => {
    const log: string[] = [];
    const probe = await probeValueGaps(
      "select id from cards where title = 'knight'",
      [...CARDS, { table: 'sets', column: 'code', type: 'VARCHAR(3)' }],
      engine(log),
    );
    expect(probe.queries).toBe(1);
    expect(probe.gaps[0]?.column).toBe('cards.name');
    expect(probe.gaps[0]?.kind).toBe('partial');
  });

  it('never sweeps a numeric column, which cannot be the one at fault', async () => {
    const log: string[] = [];
    await probeValueGaps("select id from cards where title = 'zzz'", CARDS, engine(log));
    expect(log.some((sql) => sql.includes('"id"'))).toBe(false);
  });

  it('sweeps on when a table has nothing to offer', async () => {
    const log: string[] = [];
    const probe = await probeValueGaps(
      "select id from cards where title = 'lea'",
      [{ table: 'cards', column: 'name', type: 'TEXT' }, { table: 'sets', column: 'code', type: 'TEXT' }],
      engine(log),
    );
    expect(probe.queries).toBe(2);
    expect(probe.gaps[0]?.column).toBe('sets.code');
  });
});

describe('a literal two tables spell differently', () => {
  it('is left to the model, because one spelling would be a guess', async () => {
    const probe = await probeValueGaps(
      "select id from cards join prints on cards.id = prints.id where name = 'red'",
      [
        { table: 'cards', column: 'name', type: 'TEXT' },
        { table: 'prints', column: 'name', type: 'TEXT' },
      ],
      engine(),
    );
    expect(probe.probes.map((one) => one.kind)).toEqual(['absent', 'case']);
    expect(probe.grounded).toBeUndefined();
    // One line per literal: the first column that answered decided the message.
    expect(probe.gaps).toHaveLength(1);
  });

  it('is left to the model when a second table stores the literal as written', async () => {
    const run = async (sql: string) =>
      (sql.includes('"cards"') ? [['Red']] : [['red']]) as (readonly unknown[])[];
    const probe = await probeValueGaps(
      "select id from cards join prints on cards.id = prints.id where name = 'red'",
      [
        { table: 'cards', column: 'name', type: 'TEXT' },
        { table: 'prints', column: 'name', type: 'TEXT' },
      ],
      run,
    );
    expect(probe.probes.map((one) => one.kind)).toEqual(['case', 'exact']);
    expect(probe.grounded).toBeUndefined();
  });

  it('grounds the literal when both tables store the same one spelling', async () => {
    const run = async () => [['Red']] as (readonly unknown[])[];
    const sql = "select id from cards join prints on cards.id = prints.id where name = 'red'";
    const probe = await probeValueGaps(
      sql,
      [
        { table: 'cards', column: 'name', type: 'TEXT' },
        { table: 'prints', column: 'name', type: 'TEXT' },
      ],
      run,
    );
    expect(probe.grounded).toBe("select id from cards join prints on cards.id = prints.id where name = 'Red'");
  });
});
