/**
 * The zero-model differential, pinned where it can be wrong.
 *
 * Three kinds of claim are made by this instrument and each is tested separately: the tally
 * (which cases the competitor's block could reach, which need a wider sample, which need
 * nothing a prompt can hold), the cost (characters the block adds to a card), and the gate
 * (the ways the measurement can be empty). The end-to-end cases run the real oracle, the real
 * card builder and the runner's own `promptFor`, because a stubbed prompt would agree with
 * whatever this file was written to expect.
 */
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { loadTables } from '../eval/bird/data.js';
import {
  blockCharsOf,
  ceilingPoints,
  differentialLines,
  differentialPath,
  differentialProblems,
  main,
  resolveDifferentialSettings,
  runDifferential,
  storedSomewhere,
  tallyDifferential,
  writeDifferential,
} from '../eval/bird/differential.js';
import type { DifferentialOutcome, DifferentialRow, DifferentialSite, Reach } from '../eval/bird/differential.js';
import { createOracle } from '../eval/bird/oracle.js';
import { resolveArm } from '../eval/bird/run.js';
import { EXAMPLE_RULE } from '../eval/bird/value-examples.js';
import { writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();
const site = (reach: Reach, cls: Exclude<DifferentialSite['cls'], never> = 'absent'): DifferentialSite => ({
  column: 'name',
  value: 'x',
  cls,
  reach,
});
const row = (passed: boolean, sites: readonly DifferentialSite[], cls: DifferentialRow['cls'] = 'absent'): DifferentialRow => ({
  id: String(sites.length),
  passed,
  cls,
  sites,
});

describe('the block, priced in characters', () => {
  it('counts the bracket the renderer would print, not a JSON encoding', () => {
    expect(blockCharsOf([])).toBe(0);
    expect(blockCharsOf(['a'])).toBe(' [a]'.length);
    expect(blockCharsOf(['a', 'b'])).toBe(' [a|b]'.length);
    // A value with a NULL marker costs what it costs: the marker is a hint the block sends.
    expect(blockCharsOf(['NULL', 'a'])).toBe(' [NULL|a]'.length);
  });
});

describe('the tally', () => {
  it('counts a case the block reaches and the arm failed as the ceiling', () => {
    const tally = tallyDifferential([row(false, [site('block-spells')]), row(true, [site('block-spells')])]);
    expect(tally.reachableCases).toBe(2);
    // The one that already passed is reachable but not flippable: the ceiling is a count of
    // failures a perfect reader could turn, not a count of cases that mention a value.
    expect(tally.flippableCases).toBe(1);
    expect(ceilingPoints(tally)).toBe(50);
  });

  it('separates a value a wider sample reaches from one no sample reaches', () => {
    const tally = tallyDifferential([
      row(false, [site('stored-unsampled')]),
      row(false, [site('not-stored')]),
    ]);
    // Stored but outside the six: the column holds it, so a bigger sample would show it.
    expect(tally.widerCases).toBe(1);
    expect(tally.derivedCases).toBe(1);
  });

  it('does not call a case derived when the block reaches any of its values', () => {
    // One value the block spells and one it cannot: the case is reachable, and filing it under
    // "no lever reaches this" would understate what the block can do.
    const tally = tallyDifferential([row(false, [site('block-spells'), site('not-stored')])]);
    expect(tally.reachableCases).toBe(1);
    expect(tally.derivedCases).toBe(0);
    expect(tally.widerCases).toBe(0);
  });

  it('does not call a statement with no value a derived one', () => {
    // An aggregation compares against nothing, so there is no value to be missing.
    const tally = tallyDifferential([row(false, [], 'none')]);
    expect(tally.cases.none).toBe(1);
    expect(tally.derivedCases).toBe(0);
  });

  it('keeps a case with one value the block spells out of the wider bucket', () => {
    const tally = tallyDifferential([row(false, [site('block-spells'), site('stored-unsampled')])]);
    expect(tally.reachableCases).toBe(1);
    expect(tally.widerCases).toBe(0);
  });

  it('counts every literal, so a case contributes more than one site', () => {
    const tally = tallyDifferential([row(false, [site('spelled', 'spelled'), site('block-spells')])]);
    expect(tally.sites.spelled).toBe(1);
    expect(tally.sites['block-spells']).toBe(1);
  });

  it('reports zero rather than a division by zero when nothing was read', () => {
    expect(ceilingPoints(tallyDifferential([]))).toBe(0);
  });
});

describe('the gate the instrument can be', () => {
  const clean = { unknownQuestion: 0, unknownArm: 0, noExamples: 0 };
  const tally = tallyDifferential([row(false, [site('block-spells')])]);

  it('passes a measurement that priced the block', () => {
    expect(differentialProblems({ tally, drops: clean, arm: 'inline+evidence' })).toEqual([]);
  });

  it('names the arm the artifact does not carry', () => {
    const problems = differentialProblems({ tally, drops: { ...clean, unknownArm: 1 }, arm: 'select' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no cases for arm select');
  });

  it('does not restate a missing arm as an empty population', () => {
    const problems = differentialProblems({
      tally: tallyDifferential([]),
      drops: { ...clean, unknownArm: 1 },
      arm: 'select',
    });
    expect(problems).toHaveLength(1);
  });

  it('fails when nothing could be read', () => {
    const problems = differentialProblems({ tally: tallyDifferential([]), drops: clean, arm: 'inline+evidence' });
    expect(problems[0]).toContain('no case could be read');
  });

  it('fails when a case is in a database with an empty block', () => {
    const problems = differentialProblems({ tally, drops: { ...clean, noExamples: 2 }, arm: 'inline+evidence' });
    expect(problems[0]).toContain('a missing instrument');
  });
});

describe('the settings', () => {
  const withReport = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'diff-settings-'));
    const path = join(dir, 'bird-eval.json');
    writeFileSync(path, '{}');
    return path;
  };

  it('defaults to the parent of the samples lever', () => {
    const path = withReport();
    expect(resolveDifferentialSettings({ BIRD_OUT: join(path, '..', 'o.json') }, [path], ROOT).arm).toBe('inline+evidence');
  });

  it('reads --arm and --strict', () => {
    const path = withReport();
    const settings = resolveDifferentialSettings(
      { BIRD_OUT: join(path, '..', 'o.json') },
      [path, '--arm', 'select', '--strict'],
      ROOT,
    );
    expect(settings.arm).toBe('select');
    expect(settings.strict).toBe(true);
    expect(settings.armSpec.name).toBe('select');
  });

  it('refuses an arm this build does not know', () => {
    const path = withReport();
    expect(() => resolveDifferentialSettings({}, [path, '--arm', 'not-an-arm'], ROOT)).toThrow('unknown arm');
  });

  it('refuses --arm with no name after it', () => {
    expect(() => resolveDifferentialSettings({}, ['report.json', '--arm'], ROOT)).toThrow('--arm needs a name');
  });

  it('refuses to run without a report', () => {
    expect(() => resolveDifferentialSettings({}, ['--strict'], ROOT)).toThrow('usage: differential.ts');
  });
});

/**
 * The mini dataset, extended with a dictionary and the cases this differential needs.
 *
 * `tags.label` exists for one class: eight distinct labels with eight distinct frequencies, so
 * their six most-frequent values are `t1`..`t6` and a gold statement filtering on `t8` is a
 * value the column stores and their block does not show. Nothing else in the fixture produces
 * that class, and without it the instrument would report a ceiling with one of its three
 * buckets always empty.
 */
function dataset(): string {
  const dir = writeMiniBirdDataset(mkdtempSync(join(tmpdir(), 'diff-')));
  const db = new DatabaseSync(join(dir, 'dev_databases', 'shop', 'shop.sqlite'));
  db.exec('create table tags (label text)');
  const tag = db.prepare('insert into tags values (?)');
  for (let index = 0; index < 8; index += 1) {
    for (let row = 0; row < 12 - index; row += 1) tag.run(`t${String(index + 1)}`);
  }
  db.close();
  const tablesFile = join(dir, 'dev_tables.json');
  const tables = JSON.parse(readFileSync(tablesFile, 'utf8')) as Record<string, unknown>[];
  // Both name lists and both column lists: `loadTables` reads the `_original` pair when it is
  // present, so a table registered only in the readable one is a table the loader never sees.
  const first = tables[0] as {
    column_names: [number, string][];
    column_names_original: [number, string][];
    table_names: string[];
    table_names_original: string[];
    column_types: string[];
  };
  first.table_names = [...first.table_names, 'Tags'];
  first.table_names_original = [...first.table_names_original, 'tags'];
  first.column_names = [...first.column_names, [2, 'label']];
  first.column_names_original = [...first.column_names_original, [2, 'label']];
  first.column_types = [...first.column_types, 'text'];
  writeFileSync(tablesFile, JSON.stringify(tables));

  const file = join(dir, 'mini_dev_sqlite.json');
  const questions = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
  const extra = [
    // The store says `pen`; the gold says `Pen`. The block folds them together, our card does not.
    { question_id: 201, db_id: 'shop', question: 'How many pens are there?', evidence: '', SQL: "select count(*) from items where name = 'Pen'", difficulty: 'simple' },
    // The block spells `cup` and our card has no reason to. The question deliberately does not
    // contain the word: `information.ts` asks whether the prompt contains the literal, and
    // "cups" contains "cup", so a question that spelled it would classify as `spelled` and this
    // fixture would measure nothing.
    { question_id: 202, db_id: 'shop', question: 'How many writing tools are held in stock?', evidence: '', SQL: "select count(*) from items where name = 'cup'", difficulty: 'simple' },
    // A value the column does not store: nothing a sample can do.
    { question_id: 203, db_id: 'shop', question: 'How many striped animals are there?', evidence: '', SQL: "select count(*) from items where name = 'zebra'", difficulty: 'simple' },
    // A statement that compares against nothing.
    { question_id: 204, db_id: 'shop', question: 'How many items are there?', evidence: '', SQL: 'select count(*) from items', difficulty: 'simple' },
    // A value the block spells and the card already spelled: `pen` is in the question, so the
    // prompt carries it and the block adds nothing.
    { question_id: 205, db_id: 'shop', question: 'How many pens are in the store?', evidence: '', SQL: "select count(*) from items where name = 'pen'", difficulty: 'simple' },
    // The same value reached through an alias, so the site carries a qualifier that names no
    // table: the search widens rather than reading the alias as a missing table.
    { question_id: 206, db_id: 'shop', question: 'How many writing tools are in the store?', evidence: '', SQL: "select count(*) from items i where i.name = 'cup'", difficulty: 'simple' },
    // Stored, and outside their six: `t8` is the rarest label, so a wider sample would show it
    // and theirs does not.
    { question_id: 207, db_id: 'shop', question: 'How many of the rare labels are there?', evidence: '', SQL: "select count(*) from tags where label = 't8'", difficulty: 'simple' },
  ];
  writeFileSync(file, JSON.stringify([...questions, ...extra]));
  return dir;
}

const body = (ids: readonly number[], passed: readonly boolean[] = ids.map(() => false)): unknown => ({
  split: 'minidev',
  cases: ids.map((id, index) => ({ arm: 'inline+evidence', id: String(id), passed: passed[index] === true, candidateRecall: true })),
  controls: { synthesizedDefinitions: { shop: 'items.name: the label the store sells under.' } },
});

const settingsFor = (data: string, report: unknown, extra: readonly string[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'diff-report-'));
  const path = join(dir, 'bird-eval.json');
  writeFileSync(path, JSON.stringify(report));
  return resolveDifferentialSettings(
    { BIRD_SPLIT: 'minidev', BIRD_DATA: data, BIRD_OUT: join(dir, 'out.json') },
    [path, '--arm', 'inline+evidence', ...extra],
    ROOT,
  );
};

describe('one corpus, read through the oracle', () => {
  const data = dataset();
  const oracle = createOracle(resolve('eval/bird/oracle.py'), join(data, 'dev_databases'));
  afterAll(async () => {
    await oracle.close();
  });

  it('asks the database whether a column stores a value', async () => {
    const table = loadTables(join(data, 'dev_tables.json')).get('shop');
    expect(table).toBeDefined();
    expect(await storedSomewhere(oracle, 'shop', table as never, 'name', 'pen', undefined)).toBe(true);
    expect(await storedSomewhere(oracle, 'shop', table as never, 'name', 'zebra', undefined)).toBe(false);
    expect(await storedSomewhere(oracle, 'shop', table as never, 'name', 'pen', 'items')).toBe(true);
    // A qualifier that names no table owning the column is treated as an alias and the search
    // widens. The alternative — reading "no such table" as "not stored" — would file a case
    // under "no prompt-side lever reaches this" on the strength of an unresolved alias.
    expect(await storedSomewhere(oracle, 'shop', table as never, 'name', 'pen', 'some_alias')).toBe(true);
  });

  it('prices the block on the cases the artifact records', async () => {
    const settings = settingsFor(data, body([201, 202, 203, 204]));
    const outcome = await runDifferential(settings, oracle);
    expect(outcome.problems).toEqual([]);
    expect(outcome.rows).toHaveLength(4);
    // `Pen` and `pen` are one value in another case, and the block is the only place our card
    // would ever show it; `cup` is spelled by the block and not by the card; `zebra` is
    // nowhere, because the column does not hold it; the count compares against nothing.
    const byId = new Map(outcome.rows.map((entry) => [entry.id, entry]));
    expect(byId.get('201')?.cls).toBe('casing');
    expect(byId.get('201')?.sites[0]?.reach).toBe('block-spells');
    expect(byId.get('202')?.cls).toBe('absent');
    expect(byId.get('202')?.sites[0]?.reach).toBe('block-spells');
    expect(byId.get('203')?.sites[0]?.reach).toBe('not-stored');
    expect(byId.get('204')?.cls).toBe('none');
    expect(byId.get('204')?.sites).toHaveLength(0);
    // Three cases the block reaches, two of which the artifact records as failures; the count
    // statement is neither reachable nor derived.
    expect(outcome.tally.reachableCases).toBe(2);
    expect(outcome.tally.flippableCases).toBe(2);
    expect(outcome.tally.derivedCases).toBe(1);
    expect(ceilingPoints(outcome.tally)).toBe(50);
    // Four columns, not one: their rule shows a small numeric dictionary (`price` with two
    // distinct values, `qty` with three), which our profiler calls a measure and never shows,
    // and `tags.label`, whose eight distinct labels make it a dictionary too. That difference
    // *is* the mechanism being priced, so it is asserted rather than noted.
    expect(outcome.cost.columnsPerDb).toBe(4);
    expect(outcome.cost.valuesPerColumn).toBeCloseTo(13 / 4, 5);
    expect(outcome.cost.charsPerCase).toBeGreaterThan(0);
    expect(outcome.cost.cardCharsPerCase).toBeGreaterThan(0);
    expect(outcome.cost.shareOfCard).toBeGreaterThan(0);
    expect(outcome.cost.shareOfCard).toBeLessThan(1);
  });

  it('files a value the card already spells, and one only a wider sample would show', async () => {
    const settings = settingsFor(data, body([205, 206, 207]));
    const outcome = await runDifferential(settings, oracle);
    const byId = new Map(outcome.rows.map((entry) => [entry.id, entry]));
    // `pen` is in the question, so the prompt carries it and the block adds nothing.
    expect(byId.get('205')?.cls).toBe('spelled');
    expect(byId.get('205')?.sites[0]?.reach).toBe('spelled');
    // `cup` through an alias: the qualifier names no table, and the value is still the block's.
    expect(byId.get('206')?.sites[0]?.reach).toBe('block-spells');
    // `t8` is stored and rarest, so their six miss it and a wider sample would not.
    expect(byId.get('207')?.sites[0]?.reach).toBe('stored-unsampled');
    expect(outcome.tally.sites['stored-unsampled']).toBe(1);
    expect(outcome.tally.widerCases).toBe(1);
    expect(outcome.tally.reachableCases).toBe(1);
    // The ceiling counts the reachable failure and not the case a wider sample would need.
    expect(ceilingPoints(outcome.tally)).toBeCloseTo(100 / 3, 5);
  });

  it('reads a report that carries no cases and no controls as empty rather than as an error', async () => {
    // Both fields are optional in the artifact shape, and a missing one has to behave like an
    // empty one: the settings reader already tolerated it, so a measurement that threw here
    // would be the second opinion this file's sibling warns about.
    const settings = settingsFor(data, { split: 'minidev' });
    const outcome = await runDifferential(settings, oracle);
    expect(outcome.drops.unknownArm).toBe(1);
    expect(outcome.rows).toEqual([]);
    // A report with cases but no `controls` renders the prompt with no definitions block.
    const bare = settingsFor(data, { split: 'minidev', cases: body === undefined ? [] : (body([205]) as { cases: unknown[] }).cases });
    const priced = await runDifferential(bare, oracle);
    expect(priced.rows).toHaveLength(1);
    expect(priced.rows[0]?.cls).toBe('spelled');
  });

  it('counts the failures, not the cases, so a passing case is not a ceiling', async () => {
    const settings = settingsFor(data, body([201, 202], [true, false]));
    const outcome = await runDifferential(settings, oracle);
    expect(outcome.tally.reachableCases).toBe(2);
    expect(outcome.tally.flippableCases).toBe(1);
    expect(ceilingPoints(outcome.tally)).toBe(50);
  });

  it('drops a case it cannot place instead of pricing it as zero', async () => {
    const settings = settingsFor(data, body([999]));
    const outcome = await runDifferential(settings, oracle);
    expect(outcome.drops.unknownQuestion).toBe(1);
    expect(outcome.rows).toHaveLength(0);
    // ...and the gate says so rather than reporting a block that adds nothing.
    expect(outcome.problems.length).toBeGreaterThan(0);
  });

  it('names a case in a database whose block is empty instead of pricing it as zero', async () => {
    // An empty block is the parent renamed. The cache is the seam: a set recorded under this
    // rule with no columns is exactly what a database without dictionaries produces, and
    // reaching it through a run would need a database the runner refuses several steps earlier.
    const dir = mkdtempSync(join(tmpdir(), 'diff-empty-'));
    const stats = statSync(join(data, 'dev_databases', 'shop', 'shop.sqlite'));
    writeFileSync(
      join(dir, 'shop.json'),
      JSON.stringify({
        db: 'shop',
        rule: EXAMPLE_RULE,
        // The entry has to describe the file in front of it or the cache is a miss: a set
        // without a fingerprint is the answer to some other database's question.
        source: { bytes: stats.size, mtimeMs: Math.round(stats.mtimeMs) },
        columns: [],
        capped: [],
        typeQuirks: 0,
      }),
    );
    const settings = settingsFor(data, body([201]));
    const outcome = await runDifferential(
      { ...settings, layout: { ...settings.layout, exampleCache: dir } },
      oracle,
    );
    expect(outcome.drops.noExamples).toBe(1);
    expect(outcome.rows).toHaveLength(0);
    expect(outcome.problems[0]).toContain('a missing instrument');
  });

  it('drops a case whose database it has no tables for', async () => {
    // The tables file is the only place a question's schema comes from; a question it does not
    // carry cannot be rendered, and rendering it anyway would price a card nobody sends.
    const bare = dataset();
    writeFileSync(join(bare, 'dev_tables.json'), '[]');
    const settings = settingsFor(bare, body([201]));
    const outcome = await runDifferential(settings, oracle);
    expect(outcome.drops.unknownQuestion).toBe(1);
    expect(outcome.rows).toHaveLength(0);
  });

  it('refuses to price an arm the artifact does not carry', async () => {
    const settings = settingsFor(data, { split: 'minidev', cases: [{ arm: 'select', id: '201', passed: false }] });
    const outcome = await runDifferential(settings, oracle);
    expect(outcome.drops.unknownArm).toBe(1);
    expect(outcome.problems[0]).toContain('no cases for arm inline+evidence');
  });

  it('writes an artifact named after the arm and prints the ceiling', async () => {
    const settings = settingsFor(data, body([201, 202, 203, 204]));
    const outcome = await runDifferential(settings, oracle);
    expect(differentialPath(settings).endsWith('differential-inline+evidence.json')).toBe(true);
    expect(writeDifferential(settings, outcome).endsWith('differential-inline+evidence.json')).toBe(true);
    const printed = differentialLines(outcome).join('\n');
    expect(printed).toContain('stored nowhere in the column: 1 case(s)');
    expect(printed).toContain('so the ceiling is 50.00pp');
    expect(printed).toContain('characters a case');
  });

  it('exits zero on a clean measurement and one under --strict when the instrument failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diff-main-'));
    const path = join(dir, 'bird-eval.json');
    const env = { BIRD_SPLIT: 'minidev', BIRD_DATA: data, BIRD_OUT: join(dir, 'out.json') };
    writeFileSync(path, JSON.stringify(body([201, 202])));
    expect(await main([path, '--arm', 'inline+evidence'], ROOT, env)).toBe(0);
    writeFileSync(path, JSON.stringify({ split: 'minidev', cases: [] }));
    expect(await main([path, '--arm', 'inline+evidence'], ROOT, env)).toBe(0);
    expect(await main([path, '--arm', 'inline+evidence', '--strict'], ROOT, env)).toBe(1);
  });

  it('prints a cost line even when nothing was measured', () => {
    const outcome: DifferentialOutcome = {
      split: 'minidev',
      arm: 'inline+evidence',
      rows: [],
      tally: tallyDifferential([]),
      cost: { charsPerCase: 0, cardCharsPerCase: 0, shareOfCard: 0, columnsPerDb: 0, valuesPerColumn: 0 },
      drops: { unknownQuestion: 0, unknownArm: 0, noExamples: 0 },
      problems: [],
    };
    const printed = differentialLines(outcome).join('\n');
    expect(printed).toContain('0.0%');
    expect(printed).toContain('0 characters a case');
  });

  it('knows when it is the program being run', async () => {
    const module = new URL('../eval/bird/differential.ts', import.meta.url);
    const { isEntry } = await import('../eval/bird/differential.js');
    expect(isEntry(module.pathname, module.href)).toBe(true);
    expect(isEntry(undefined, 'file:///x')).toBe(false);
  });

  it('resolves the arm it measures from the arms table, not from a copy', () => {
    const settings = settingsFor(data, body([201]));
    expect(settings.armSpec).toEqual(resolveArm('inline+evidence'));
  });

  it('keeps its cache with the dataset it describes, not in the repository', async () => {
    // One directory for every dataset meant a fixture's `shop` and a corpus `shop` were the
    // same entry: the fixture's three-column set was served to the corpus, and to the next
    // fixture, because both name a database `shop` and neither names a file.
    const fresh = dataset();
    const settings = settingsFor(fresh, body([202]));
    expect(settings.layout.exampleCache.startsWith(fresh)).toBe(true);
    const outcome = await runDifferential(settings, oracle);
    expect(outcome.rows).toHaveLength(1);
    expect(existsSync(join(fresh, '.value-examples', 'shop.json'))).toBe(true);
  });
});
