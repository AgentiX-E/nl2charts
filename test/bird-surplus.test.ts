/**
 * The layer under `filter-wide`, through the graft and through the entry.
 *
 * `values-gap` files 102 dev questions as "the statement returned a different number of rows".
 * That is a shape, and two defects wear it: a predicate that is too weak, and a `from` that
 * multiplies rows. They need opposite levers, so the split is measured with a counterfactual —
 * replace the prediction's filter with the gold's and run it.
 *
 * The unit cases pin the graft, because the graft is the whole instrument: it rewrites an alias in
 * a clause that has to keep running, and the three ways to break that (a dot inside a literal, a
 * quoted identifier, a self-join with no role mapping) are all textual. The end-to-end case runs a
 * real SQLite file through the real oracle subprocess, because the tool's denominator is "cases the
 * engine counted differently" and a stubbed result set would agree with whatever the tool expected.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SURPLUS_ARM,
  SURPLUS_KINDS,
  graftPredicate,
  isEntry,
  main,
  nestsAQuery,
  readsSameShape,
  resolveSurplusSettings,
  retargetWhere,
  runSurplus,
  surplusLines,
  surplusPath,
  surplusProblems,
  tallySurplus,
  writeSurplusArtifact,
} from '../eval/bird/surplus.js';
import { MINI_DB, MINI_QUESTIONS, writeMiniBirdDataset } from './helpers/bird-dataset.js';

const ROOT = process.cwd();

describe('retargeting the gold filter onto the prediction aliases', () => {
  it('renames an alias the prediction spells differently', () => {
    const retargeted = retargetWhere('t1.item_id = 1', new Map([['t1', 'items']]), new Map([['items', 'i']]));
    expect(retargeted).toBe('i.item_id = 1');
  });

  it('reads a bare qualifier as a table when the gold declared no alias', () => {
    const retargeted = retargetWhere('items.price > 2', new Map([['items', 'items']]), new Map([['items', 'i']]));
    expect(retargeted).toBe('i.price > 2');
  });

  it('leaves a dot inside a string literal alone, because that dot is a value', () => {
    const retargeted = retargetWhere("t1.name = 'a.b' and t1.price > 1", new Map([['t1', 'items']]), new Map([['items', 'i']]));
    expect(retargeted).toBe("i.name = 'a.b' and i.price > 1");
  });

  it('keeps a quoted run intact, including the escaped quote inside it', () => {
    const retargeted = retargetWhere("t1.name = 'a''b.c' and t1.price > 1", new Map([['t1', 'items']]), new Map([['items', 'i']]));
    expect(retargeted).toBe("i.name = 'a''b.c' and i.price > 1");
  });

  it('keeps a bracket-quoted identifier and a comment byte for byte', () => {
    const body = '[t1].price > 1 -- t1.price is not a filter\nand t1.price < 9';
    const retargeted = retargetWhere(body, new Map([['t1', 'items']]), new Map([['items', 'i']]));
    expect(retargeted).toBe('[t1].price > 1 -- t1.price is not a filter\nand i.price < 9');
  });

  it('keeps a block comment, and a line comment that ends the body', () => {
    expect(retargetWhere('/* t1.price */ t1.price > 1', new Map([['t1', 'items']]), new Map([['items', 'i']]))).toBe(
      '/* t1.price */ i.price > 1',
    );
    // No newline after the marker: the comment runs to the end of the body, and a scanner that
    // assumed a trailing newline would append the rest of the clause to it.
    expect(retargetWhere('t1.price > 1 -- t1.price', new Map([['t1', 'items']]), new Map([['items', 'i']]))).toBe(
      'i.price > 1 -- t1.price',
    );
  });

  it('walks to the end of an unterminated quote, bracket or block comment', () => {
    // Malformed clauses reach this scanner whenever a model writes half a literal, and a scanner
    // that assumed a terminator would truncate the clause it was supposed to carry over.
    const aliases = new Map([['t1', 'items']]);
    const target = new Map([['items', 'i']]);
    expect(retargetWhere("t1.name = 'open", aliases, target)).toBe("i.name = 'open");
    expect(retargetWhere('t1.name = [open', aliases, target)).toBe('i.name = [open');
    expect(retargetWhere('t1.name = 1 /* open', aliases, target)).toBe('i.name = 1 /* open');
  });

  it('refuses when the gold compares a table the prediction never reads', () => {
    // `orders` is not in the prediction's `from`, so there is no alias to retarget onto: this is a
    // table-selection finding, and inventing an alias would produce a statement that cannot run.
    expect(retargetWhere('o.qty > 1', new Map([['o', 'orders']]), new Map([['items', 'i']]))).toBeUndefined();
  });
});

describe('grafting the gold filter onto the prediction', () => {
  it('replaces the prediction filter with the gold one', () => {
    const graft = graftPredicate('select name from items', "select name from items where item_id = 1");
    expect(graft).toEqual({ sql: 'select name from items where item_id = 1' });
  });

  it('removes the predicate when the gold filters nothing', () => {
    // The other direction of the same counterfactual: a prediction that filters where the answer
    // does not is a `filter-wide` case too, and a graft that could only add filters would report
    // that half of the bucket as unreachable.
    const graft = graftPredicate('select name from items where item_id = 1', 'select name from items');
    expect(graft).toEqual({ sql: 'select name from items' });
  });

  it('replaces the clause rather than appending a second one', () => {
    const graft = graftPredicate(
      'select i.name from items i where i.price > 1',
      'select i.name from items i where i.item_id = 1',
    );
    expect(graft.sql).toBe('select i.name from items i where i.item_id = 1');
  });

  it('puts the clause before the grouping when the prediction has none', () => {
    const graft = graftPredicate(
      'select item_id, count(*) from orders group by item_id',
      'select item_id, count(*) from orders where item_id = 1 group by item_id',
    );
    expect(graft.sql).toBe('select item_id, count(*) from orders where item_id = 1 group by item_id');
  });

  it('refuses a statement that reads one table under two aliases', () => {
    // An employee and their manager: `e` and `m` are one table, so a qualifier no longer names a
    // role and the retarget has to choose. Choosing is the guess this file exists to avoid.
    const graft = graftPredicate(
      'select e.name from items e join items m on m.id = e.id where m.price > 1',
      'select e.name from items e where e.id = 1',
    );
    expect(graft).toEqual({ refused: 'selfJoin' });
  });

  it('drops the clause when the gold has one with no body at all', () => {
    // `where order by x` is not SQL a model should write, and it is SQL this scanner can read: an
    // empty body must delete the clause rather than splice a bare `where` into the statement.
    expect(graftPredicate('select name from items where id = 1', 'select name from items where order by name')).toEqual({
      sql: 'select name from items',
    });
  });

  it('refuses a statement that reads a table through a subquery', () => {
    // The clause this tool edits is the top-level one, and a qualifier inside a derived table
    // belongs to a `from` the prediction keeps one level down: retargeting it there would edit a
    // statement the tool cannot reason about.
    expect(graftPredicate('select name from (select id, name from items) d', 'select name from items where id = 1')).toEqual({
      refused: 'nested',
    });
    expect(graftPredicate('select name from items where id in (select id from items)', 'select name from items where id = 1')).toEqual({
      refused: 'nested',
    });
  });

  it('does not read the word `select` inside a literal as a nested query', () => {
    // `'select'` is a value here, and a detector that scanned the raw text would refuse the case
    // and call the corpus nested.
    expect(nestsAQuery("select name from items where name = 'select'")).toBe(false);
    expect(nestsAQuery('select name from items where id in (select id from items)')).toBe(true);
  });

  it('refuses when the gold reads a table the prediction does not', () => {
    const graft = graftPredicate(
      'select i.name from items i where i.price > 1',
      "select i.name from items i join orders o on o.item_id = i.id where o.qty > 1",
    );
    expect(graft).toEqual({ refused: 'missingTable' });
  });
});

describe('whether two statements answer at the same grain', () => {
  it('accepts a pair that differ only in what they filter', () => {
    expect(readsSameShape('select id from items where price > 1', 'select id from items')).toBe(true);
  });

  it('refuses a pair where one counts and the other lists rows', () => {
    // The defect is the missing aggregate, and no filter makes a row set equal to a count.
    expect(readsSameShape('select count(*) from items', 'select id from items')).toBe(false);
  });

  it('refuses a pair that group at different levels', () => {
    expect(readsSameShape('select item_id, count(*) from orders group by item_id', 'select count(*) from orders')).toBe(false);
  });

  it('refuses a pair whose projections differ in width', () => {
    expect(readsSameShape('select id, name from items', 'select id from items')).toBe(false);
  });

  it('reads two spellings of one aggregate as one grain', () => {
    expect(readsSameShape('select count(*) from items i', 'select count(*) from items')).toBe(true);
  });
});

describe('tallying what the graft found', () => {
  it('counts each kind and reports the ceiling as the predicate kind', () => {
    const tally = tallySurplus(['predicate', 'predicate', 'elsewhere', 'tables']);
    expect(tally.total).toBe(4);
    expect(tally.kinds).toEqual({ predicate: 2, duplicates: 0, elsewhere: 1, tables: 1, selfJoin: 0, nested: 0, unreadable: 0 });
    expect(tally.reachableByPredicate).toBe(2);
  });

  it('counts a kind that never occurred as zero rather than omitting it', () => {
    const tally = tallySurplus(['predicate']);
    expect(Object.keys(tally.kinds).sort()).toEqual([...SURPLUS_KINDS].sort());
  });

  it('prints one line per kind and the ceiling, and reads 0.0 over an empty set', () => {
    const lines = surplusLines(tallySurplus([]));
    expect(lines).toHaveLength(SURPLUS_KINDS.length + 1);
    expect(lines[0]).toContain('0.0%');
    expect(lines.at(-1)).toContain('reachable by editing the predicate: 0 of 0');
  });

  it('prints the share of the ceiling when there is a denominator', () => {
    const lines = surplusLines(tallySurplus(['predicate', 'elsewhere', 'elsewhere', 'elsewhere']));
    expect(lines.at(-1)).toBe('  reachable by editing the predicate: 1 of 4 (25.0%)');
  });

  it('refuses an empty bucket, because 0 of 0 reads like a measured zero', () => {
    expect(surplusProblems(tallySurplus([]))).toEqual([
      'SURP: no case in this artifact returned a different number of rows, so there is nothing to split',
    ]);
  });

  it('does not fail a non-empty split for grafts it refuses, because a permanent red gate is not a gate', () => {
    // Eleven of fifty-four dev cases have no graft by construction. Failing on them would make
    // every future run red for a property of the corpus, and the refusals are already counted.
    expect(surplusProblems(tallySurplus(['predicate', 'nested', 'selfJoin', 'unreadable']))).toEqual([]);
  });
});

describe('the entry', () => {
  it('defaults the arm and the artifact to the run output', () => {
    const settings = resolveSurplusSettings([], ROOT, {});
    expect(settings.arm).toBe(DEFAULT_SURPLUS_ARM);
    expect(settings.artifact.endsWith('bird-eval.json')).toBe(true);
  });

  it('takes an artifact and an arm, in either order', () => {
    const first = resolveSurplusSettings(['--artifact', 'a.json', '--arm', 'names'], ROOT, {});
    const second = resolveSurplusSettings(['--arm', 'names', '--artifact', 'a.json'], ROOT, {});
    expect(first.artifact).toBe('a.json');
    expect(second.arm).toBe('names');
  });

  it('refuses an argument it does not take', () => {
    expect(() => resolveSurplusSettings(['--split', 'dev'], ROOT, {})).toThrow(/unrecognized argument --split/);
  });

  it('refuses a flag with no value, and one that swallowed the next flag', () => {
    expect(() => resolveSurplusSettings(['--arm'], ROOT, {})).toThrow(/--arm needs a value/);
    expect(() => resolveSurplusSettings(['--arm', '--artifact'], ROOT, {})).toThrow(/--arm needs a value/);
  });

  it('names the artifact after the arm so two arms do not overwrite each other', () => {
    expect(surplusPath({ root: ROOT, arm: 'metadata+evidence', split: 'dev' })).toBe(join(ROOT, 'eval', 'out', 'surplus-metadata+evidence-dev.json'));
    expect(surplusPath({ root: ROOT, arm: 'select/mixed', split: 'dev' })).toBe(join(ROOT, 'eval', 'out', 'surplus-select_mixed-dev.json'));
  });

  it('recognises its own module and nothing else', () => {
    expect(isEntry(undefined, 'file:///x')).toBe(false);
    expect(isEntry('/x', 'file:///x')).toBe(true);
  });
});

describe('splitting a real artifact against a real database', () => {
  /**
   * The shared fixture's golds are all aggregates, so every one of them returns exactly one row and
   * no prediction can differ from it in *count* — the fixture can show a `values` failure but never
   * a `filter-wide` one. These three questions answer with row sets instead, which is the only shape
   * this tool has a denominator for.
   */
  const QUESTIONS: readonly { id: number; sql: string; question: string }[] = [
    { id: 1, sql: 'select name from items where items.id = 1', question: 'Which item has id 1?' },
    {
      id: 2,
      sql: 'select i.name from items i join orders o on o.item_id = i.id where o.qty = 5',
      question: 'Which item was ordered at a quantity of 5?',
    },
    { id: 3, sql: 'select name from items', question: 'What are the item names?' },
  ];

  const writeQuestions = (dir: string): { data: string; artifact: string; databaseRoot: string } => {
    const data = writeMiniBirdDataset(join(dir, 'MINIDEV'));
    writeFileSync(
      join(data, 'mini_dev_sqlite.json'),
      JSON.stringify(
        QUESTIONS.map((entry) => ({
          question_id: entry.id,
          db_id: MINI_DB,
          question: entry.question,
          evidence: '',
          SQL: entry.sql,
          difficulty: 'simple',
        })),
      ),
    );
    return { data, artifact: join(dir, 'artifact.json'), databaseRoot: join(data, 'dev_databases') };
  };

  const write = (
    path: string,
    cases: readonly { id: number; passed: boolean; reason?: string; sql?: string; arm?: string }[],
  ): void => {
    writeFileSync(
      path,
      JSON.stringify({
        split: 'minidev',
        cases: cases.map((entry) => ({
          arm: entry.arm ?? DEFAULT_SURPLUS_ARM,
          id: entry.id,
          passed: entry.passed,
          ...(entry.reason === undefined ? {} : { reason: entry.reason }),
          ...(entry.sql === undefined ? {} : { sql: entry.sql }),
        })),
      }),
    );
  };

  const settingsFor = (dir: string) => {
    const built = writeQuestions(dir);
    return {
      built,
      // `root` is the fixture's directory so the write path stays inside it: a test that inherits
      // the repository root writes its artifact into `eval/out/`, where a real reading lives.
      settings: { root: dir, artifact: built.artifact, arm: DEFAULT_SURPLUS_ARM, layout: { data: built.data, databaseRoot: built.databaseRoot } as never },
    };
  };

  it('names the predicate as the cause when replacing the filter repairs the case', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surplus-'));
    const { built, settings } = settingsFor(dir);
    // Three items against a gold that asks for one: the rows are the right ones and there is no
    // filter, so the gold filter is exactly what the statement is missing.
    write(built.artifact, [{ id: 1, passed: false, reason: 'values', sql: 'select name from items' }]);
    const outcome = await runSurplus(settings);
    expect(outcome.tally.total).toBe(1);
    expect(outcome.rows[0]?.kind).toBe('predicate');
    expect(outcome.problems).toEqual([]);
  });

  it('names repeated rows as duplicates when the official judge would have credited the case', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surplus-'));
    const { built, settings } = settingsFor(dir);
    // The same filter as the gold and a fan-out: `items` joined to `orders` returns one row per
    // order for the item. BIRD's official rule compares `set()`, so this *scores* — but the case is
    // a missing `distinct`, not a weak predicate, and the strict rule is what says so.
    write(built.artifact, [
      { id: 1, passed: false, reason: 'values', sql: 'select i.name from items i join orders o on o.item_id = i.id where i.id = 1' },
    ]);
    const outcome = await runSurplus(settings);
    expect(outcome.tally.total).toBe(1);
    expect(outcome.rows[0]?.kind).toBe('duplicates');
    expect(outcome.rows[0]?.predictedRows).toBe(2);
    expect(outcome.rows[0]?.goldRows).toBe(1);
  });

  it('names the row source when the gold filter in place still answers a different question', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surplus-'));
    const { built, settings } = settingsFor(dir);
    // Both statements join the same two tables, so the filter can be retargeted; the projection is
    // still the wrong set of rows afterwards, which no edit to a condition reaches.
    write(built.artifact, [{ id: 1, passed: false, reason: 'values', sql: 'select o.qty from orders o join items i on i.id = o.item_id where o.qty > 0' }]);
    const outcome = await runSurplus(settings);
    expect(outcome.tally.total).toBe(1);
    expect(outcome.rows[0]?.kind).toBe('elsewhere');
  });

  it('files a gold filter over a table the prediction never reads as a table finding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surplus-'));
    const { built, settings } = settingsFor(dir);
    // The gold's filter compares a column of `orders`, and the prediction reads `items` only: there
    // is no alias to retarget onto, and inventing one would produce a statement that cannot run.
    write(built.artifact, [{ id: 2, passed: false, reason: 'values', sql: 'select name from items where id > 0' }]);
    const outcome = await runSurplus(settings);
    expect(outcome.tally.total).toBe(1);
    expect(outcome.rows[0]?.kind).toBe('tables');
  });

  it('repairs a prediction that filters where the answer does not, by removing the clause', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surplus-'));
    const { built, settings } = settingsFor(dir);
    // The gold has no filter at all. A graft that could only *add* a predicate would file this half
    // of `filter-wide` as unreachable, which is why the other direction is measured too.
    write(built.artifact, [{ id: 3, passed: false, reason: 'values', sql: 'select name from items where items.id = 1' }]);
    const outcome = await runSurplus(settings);
    expect(outcome.tally.total).toBe(1);
    expect(outcome.rows[0]?.kind).toBe('predicate');
    expect(outcome.rows[0]?.predictedRows).toBe(1);
    expect(outcome.rows[0]?.goldRows).toBe(3);
  });

  it('leaves a case out of the denominator when the two statements answer at different grains', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surplus-'));
    const { built, settings } = settingsFor(dir);
    // A two-column row set against a one-column gold: the projection is the defect, and the graft
    // would have reported "the predicate was not the whole story" for a case with no predicate
    // problem at all.
    write(built.artifact, [{ id: 1, passed: false, reason: 'values', sql: 'select name, price from items' }]);
    const outcome = await runSurplus(settings);
    expect(outcome.tally.total).toBe(0);
    expect(outcome.drops.otherForm).toBe(1);
    expect(outcome.drops.otherShape).toBe(0);
    expect(outcome.problems[0]).toMatch(/nothing to split/);
  });

  it('drops every case it cannot be a denominator for, and counts them separately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surplus-'));
    const { built, settings } = settingsFor(dir);
    write(built.artifact, [
      { id: 1, passed: true },
      { id: 2, passed: false, reason: 'syntax', sql: 'select 1' },
      { id: 3, passed: false, reason: 'values' },
      { id: 4, passed: false, reason: 'values', sql: 'select count(*) from items', arm: 'names' },
      { id: 999, passed: false, reason: 'values', sql: 'select count(*) from items' },
      { id: 1, passed: false, reason: 'values', sql: 'select count(*) from items' },
      { id: 1, passed: false, reason: 'values', sql: 'select count(*) from nowhere' },
    ]);
    const outcome = await runSurplus(settings);
    expect(outcome.drops).toMatchObject({
      passed: 1,
      otherReason: 1,
      otherArm: 1,
      unretained: 1,
      unknownQuestion: 1,
      engineRefused: 1,
      // One case returned the same number of rows as the gold, so it is not `filter-wide` at all:
      // the row-count test is what keeps this rung's denominator the set the bucket names.
      otherShape: 1,
      otherForm: 0,
    });
    expect(outcome.tally.total).toBe(0);
  });

  it('writes the artifact under the arm it was run for, and the entry reports it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surplus-'));
    const { built, settings } = settingsFor(dir);
    write(built.artifact, [
      { id: 1, passed: false, reason: 'values', sql: 'select name from items' },
      { id: 3, passed: false, reason: 'values', sql: 'select name from items where items.id = 1' },
    ]);
    const outcome = await runSurplus(settings);
    const path = writeSurplusArtifact(settings, outcome);
    expect(path).toBe(surplusPath({ root: settings.root, arm: DEFAULT_SURPLUS_ARM, split: 'minidev' }));
    const reread = JSON.parse(readFileSync(path, 'utf8')) as { tally: { total: number } };
    expect(reread.tally.total).toBe(2);
  });

  it('counts a statement that reads through a subquery as one it did not read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surplus-'));
    const { built, settings } = settingsFor(dir);
    // The clause the graft edits is the top-level one, and here the rows are decided one level
    // down: the case is counted as `nested` rather than edited into a statement nobody reasoned
    // about, and the tally stays whole because it is a class rather than a failure.
    write(built.artifact, [{ id: 1, passed: false, reason: 'values', sql: 'select name from items where items.id in (select id from items where id > 0)' }]);
    const outcome = await runSurplus(settings);
    expect(outcome.tally.total).toBe(1);
    expect(outcome.tally.kinds.nested).toBe(1);
    expect(outcome.rows[0]?.kind).toBe('nested');
    expect(outcome.problems).toEqual([]);
  });

  it('names a self-join rather than guessing which alias is the role', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surplus-'));
    const { built, settings } = settingsFor(dir);
    // `items` read twice: the gold's qualifier no longer names a role, so there is nothing to
    // retarget onto and the case is counted instead of repaired.
    write(built.artifact, [{ id: 1, passed: false, reason: 'values', sql: 'select e.name from items e join items m on m.id = e.id where m.price > 0' }]);
    const outcome = await runSurplus(settings);
    expect(outcome.tally.total).toBe(1);
    expect(outcome.rows[0]?.kind).toBe('selfJoin');
    expect(outcome.problems).toEqual([]);
  });

  it('fails the run when a grafted statement will not run, because that can be this tool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surplus-'));
    const { built, settings } = settingsFor(dir);
    // The gold qualifies nothing (`id = 1`) and the prediction joins two tables that both have an
    // `id`, so the grafted clause is ambiguous. Every other refusal here is a fact about the case;
    // this one can be a fact about the file, so it is not folded into a bucket.
    writeFileSync(
      join(built.data, 'mini_dev_sqlite.json'),
      JSON.stringify([{ question_id: 1, db_id: MINI_DB, question: 'Which item has id 1?', evidence: '', SQL: 'select name from items where id = 1', difficulty: 'simple' }]),
    );
    write(built.artifact, [{ id: 1, passed: false, reason: 'values', sql: 'select i.name from items i join orders o on o.item_id = i.id where o.qty > 0' }]);
    const outcome = await runSurplus(settings);
    // The case is in the bucket and is counted as one the tool could not read: the report is
    // complete about its own coverage, and the id is kept so the refusal can be audited.
    expect(outcome.unreadable).toBe(1);
    expect(outcome.unreadableIds).toEqual(['1']);
    expect(outcome.tally.kinds.unreadable).toBe(1);
    expect(outcome.tally.total).toBe(1);
    expect(outcome.problems).toEqual([]);
  });

  it('refuses a gold the engine will not run, rather than counting it as a miss', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surplus-'));
    const data = writeMiniBirdDataset(join(dir, 'MINIDEV'));
    const artifact = join(dir, 'artifact.json');
    // A questions file whose gold does not parse: the case cannot be split, and the tool says so
    // by dropping it instead of filing it under a cause.
    writeFileSync(
      join(data, 'mini_dev_sqlite.json'),
      JSON.stringify(
        MINI_QUESTIONS.map((entry) => ({ ...entry, question_id: entry.id, db_id: MINI_DB, evidence: '', SQL: entry.id === 7 ? 'select from where' : entry.sql })),
      ),
    );
    write(artifact, [{ id: 7, passed: false, reason: 'values', sql: 'select count(qty) from orders where qty > 0' }]);
    const outcome = await runSurplus({
      root: ROOT,
      artifact,
      arm: DEFAULT_SURPLUS_ARM,
      layout: { data, databaseRoot: join(data, 'dev_databases') } as never,
    });
    expect(outcome.drops.goldFailed).toBe(1);
    expect(outcome.tally.total).toBe(0);
  });
});

describe('the entry point as a process', () => {
  it('exits non-zero when the split is empty, so a silent zero cannot ship', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surplus-'));
    const data = writeMiniBirdDataset(join(dir, 'MINIDEV'));
    const artifact = join(dir, 'artifact.json');
    writeFileSync(artifact, JSON.stringify({ split: 'minidev', cases: [] }));
    const code = await main(['--artifact', artifact], dir, {
      BIRD_SPLIT: 'minidev',
      BIRD_DATA: data,
      BIRD_DATABASES: join(data, 'dev_databases'),
    });
    expect(code).toBe(1);
  });

  it('exits zero on a split it can report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surplus-'));
    const data = writeMiniBirdDataset(join(dir, 'MINIDEV'));
    writeFileSync(
      join(data, 'mini_dev_sqlite.json'),
      JSON.stringify([{ question_id: 3, db_id: MINI_DB, question: 'What are the item names?', evidence: '', SQL: 'select name from items', difficulty: 'simple' }]),
    );
    const artifact = join(dir, 'artifact.json');
    writeFileSync(
      artifact,
      JSON.stringify({
        split: 'minidev',
        cases: [{ arm: DEFAULT_SURPLUS_ARM, id: 3, passed: false, reason: 'values', sql: 'select name from items where items.id = 1' }],
      }),
    );
    const code = await main(['--artifact', artifact], dir, {
      BIRD_SPLIT: 'minidev',
      BIRD_DATA: data,
      BIRD_DATABASES: join(data, 'dev_databases'),
    });
    expect(code).toBe(0);
  });
});

describe('the script as a process', () => {
  it('runs under tsx and prints the split it can read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surplus-'));
    const data = writeMiniBirdDataset(join(dir, 'MINIDEV'));
    writeFileSync(
      join(data, 'mini_dev_sqlite.json'),
      JSON.stringify([{ question_id: 3, db_id: MINI_DB, question: 'What are the item names?', evidence: '', SQL: 'select name from items', difficulty: 'simple' }]),
    );
    const artifact = join(dir, 'artifact.json');
    writeFileSync(
      artifact,
      JSON.stringify({
        split: 'minidev',
        cases: [{ arm: DEFAULT_SURPLUS_ARM, id: 3, passed: false, reason: 'values', sql: 'select name from items where items.id = 1' }],
      }),
    );
    // The loader is named by its resolved URL rather than by package name: the child's working
    // directory is the fixture's, and a bare `tsx` would be looked for there and not found.
    const out = execFileSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), join(ROOT, 'eval/bird/surplus.ts'), '--artifact', artifact], {
      // The working directory is the fixture's, so the artifact this run writes lands beside the
      // fixture rather than in `eval/out/` on top of a reading that took a model to produce.
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, BIRD_SPLIT: 'minidev', BIRD_DATA: data, BIRD_DATABASES: join(data, 'dev_databases') },
    });
    expect(out).toContain('surplus split · metadata+evidence · minidev · 1 case(s) returned a different number of rows');
    expect(out).toContain('reachable by editing the predicate: 1 of 1 (100.0%)');
    expect(out).toContain('dropped: 0 passed');
  });
});

describe('the fixture the end-to-end cases lean on', () => {
  it('writes a database whose orders outnumber the gold count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surplus-'));
    const data = writeMiniBirdDataset(join(dir, 'MINIDEV'));
    const reader = new DatabaseSync(join(data, 'dev_databases', MINI_DB, `${MINI_DB}.sqlite`), { readOnly: true });
    try {
      expect((reader.prepare('select count(*) as n from orders').get() as { n: number }).n).toBe(3);
      expect((reader.prepare('select count(*) as n from items').get() as { n: number }).n).toBe(3);
    } finally {
      reader.close();
    }
  });
});
