/**
 * The rewrite pricer, tested against a real SQLite file.
 *
 * The rule under test decides whether a *user's* statement is executed as written or with a guard
 * in front of its sort key, so the only test that says anything is one that runs the statement.
 * `node:sqlite` writes a two-row table here, the oracle reads it through the same python process
 * the benchmark uses, and the judge is the benchmark's own — no stub stands in for any of them.
 *
 * Two failures this file exists to prevent:
 *
 * - **A rule that breaks statements.** The first `null-order` rewrite emitted `ASCLIMIT` on every
 *   case it fired. The instrument counted 80 broken statements and refused to publish, which is
 *   what the `broken` field is for; the assertion below is the same defect caught in a second.
 * - **A baseline that is not the judge.** A rewrite is priced as "this many flipped" against the
 *   arm's own score. If re-execution cannot reproduce that score, the delta is between two
 *   instruments. `rewriteProblems` refuses, and the test drives it with an artifact that lies.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { judgeOfficial } from '@agentix-e/nl2charts-devkit';
import type { BirdQuestion } from '../eval/bird/data.js';
import { createOracle } from '../eval/bird/oracle.js';
import {
  REWRITE_RULES,
  main,
  priceRewrites,
  resolveRewriteSettings,
  rewriteCases,
  rewriteLines,
  rewriteProblems,
  statementOf,
  typeLookup,
} from '../eval/bird/rewrite.js';
import type { RewriteArtifact, RewriteCase, RewriteRule } from '../eval/bird/rewrite.js';

const root = mkdtempSync(join(tmpdir(), 'nl2charts-rewrite-'));
mkdirSync(join(root, 'shop'), { recursive: true });
const writer = new DatabaseSync(join(root, 'shop', 'shop.sqlite'));
writer.exec(`
  create table items (id integer, name text, score integer);
  insert into items values (1, 'pen', null);
  insert into items values (2, 'cup', 7);
  insert into items values (3, 'lid', 9);
`);
writer.close();

function question(overrides: Partial<BirdQuestion> = {}): BirdQuestion {
  return { question_id: 1, db_id: 'shop', question: 'which item has the lowest score', evidence: '', SQL: '', difficulty: 'simple', ...overrides };
}

function rewriteCase(overrides: Partial<RewriteCase> = {}): RewriteCase {
  return {
    id: '1',
    question: question({ SQL: 'select name from items where score is not null order by score asc limit 1' }),
    sql: 'select name from items order by score asc limit 1',
    declared: false,
    ...overrides,
  };
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('statementOf', () => {
  it('reads the slot a rule arm chose', () => {
    const row = { id: '7', candidates: [{ sql: 'select 1' }, { sql: 'select 2' }], selectedByRule: { index: 1 } };
    expect(statementOf(row, [])).toBe('select 2');
  });

  it('reads the statement a single-call arm recorded on the row', () => {
    expect(statementOf({ id: '7', predicted: 'select 3' }, [])).toBe('select 3');
  });

  it('falls back to the failure row, which is where a passing case never writes one', () => {
    expect(statementOf({ id: '7' }, [{ id: '7', predicted: 'select 4' }])).toBe('select 4');
  });

  it('reports nothing when the artifact kept no statement at all', () => {
    expect(statementOf({ id: '7' }, [])).toBeUndefined();
    expect(statementOf({ id: '7', selectedByRule: { index: 4 }, candidates: [] }, [])).toBeUndefined();
  });
});

describe('rewriteCases', () => {
  const artifact: RewriteArtifact = {
    cases: [
      { id: '1', arm: 'a', passed: true, candidates: [{ sql: 'select 1' }], selectedByRule: { index: 0 } },
      { id: '2', arm: 'a', passed: false, candidates: [{ sql: 'select 2' }], selectedByRule: { index: 0 } },
      { id: '3', arm: 'a', passed: false },
      { id: '4', arm: 'a', passed: true },
      { id: '9', arm: 'a', passed: true, predicted: 'select 9' },
      { id: '1', arm: 'b', passed: true, predicted: 'select b' },
    ],
  };

  it('keeps only the arm asked for, with its own verdict', () => {
    const kept = rewriteCases(artifact, 'a', [question({ question_id: 1 }), question({ question_id: 2 }), question({ question_id: 3 })]);
    expect(kept.cases.map((entry) => entry.id)).toEqual(['1', '2']);
    expect(kept.cases.map((entry) => entry.declared)).toEqual([true, false]);
    // One case kept no statement and two name questions the split does not hold — the two absences
    // are counted apart, because one is a hole in the artifact and the other is the wrong split.
    expect(kept.unretained).toBe(1);
    expect(kept.unknownQuestion).toBe(2);
  });
});

describe('REWRITE_RULES', () => {
  const rule = (name: string): RewriteRule => {
    const found = REWRITE_RULES.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`no rule ${name}`);
    return found;
  };

  it('guards an ascending sort behind a cap and nothing else', () => {
    expect(rule('null-order').apply({ question: '', sql: 'select a from t order by a asc limit 1' })).toContain('a IS NULL');
    expect(rule('null-order').apply({ question: '', sql: 'select a from t order by a asc' })).toBeUndefined();
  });

  it('drops a row cap only when the question counts', () => {
    expect(rule('drop-limit-on-count').apply({ question: 'how many items are there', sql: 'select id from t limit 3' })).toBe('select id from t;');
    expect(rule('drop-limit-on-count').apply({ question: 'which item', sql: 'select id from t limit 3' })).toBeUndefined();
    expect(rule('drop-limit-on-count').apply({ question: 'how many', sql: 'select count(*) from t' })).toBeUndefined();
  });

  it('scales an integer numerator and leaves everything else alone', () => {
    const typeOf = (name: string): string | undefined => (name === 'a' || name === 'b' ? 'INTEGER' : 'REAL');
    const apply = (sql: string): string | undefined => rule('integer-division').apply({ question: '', sql, typeOf });
    expect(apply('select a / b from t')).toBe('select (a) * 1.0 / b from t');
    expect(apply('select sum(x) / count(*) from t')).toBe('select (sum(x)) * 1.0 / count(*) from t');
    expect(apply('select c / b from t')).toBeUndefined();
    expect(apply('select a * 1.0 / b from t')).toBeUndefined();
    // A division inside a literal is text, not arithmetic; the statement below divides nothing.
    expect(apply("select note = 'a/b' from t")).toBeUndefined();
    expect(apply('select cast(a as real) / b from t')).toBeUndefined();
    expect(rule('integer-division').apply({ question: '', sql: 'select a / b from t' })).toBeUndefined();
    // A column whose type the split does not declare is not evidence of truncation.
    expect(rule('integer-division').apply({ question: '', sql: 'select z / b from t', typeOf: () => undefined })).toBeUndefined();
  });
});

describe('priceRewrites', () => {
  it('prices a rewrite by executing it, and reconciles the baseline', async () => {
    const oracle = createOracle(resolve('eval/bird/oracle.py'), root);
    try {
      const cases = [
        // The NULL-first answer is wrong; the guard picks the lowest real score.
        rewriteCase(),
        // Correct already, and the guard leaves it correct.
        rewriteCase({ id: '2', question: question({ question_id: 2, SQL: 'select name from items where score is not null order by score asc limit 1' }), sql: 'select name from items where score is not null order by score asc limit 1', declared: true }),
      ];
      const priced = await priceRewrites(cases, REWRITE_RULES, { execute: (db, sql) => oracle.run(db, sql), judge: judgeOfficial }, () => undefined);
      expect(priced.recomputed).toBe(1);
      expect(priced.declared).toBe(1);
      expect(priced.agreed).toBe(2);
      const nullOrder = priced.readings.find((reading) => reading.rule === 'null-order');
      expect(nullOrder).toMatchObject({ fired: 2, won: 1, lost: 0, broken: 0, net: 1 });
      // One discordant pair is one coin flip: the exact test reports 1 no matter which way it fell,
      // which is the reason a single flip is never a reading.
      expect(nullOrder?.mcnemar).toBe(1);
      expect(nullOrder?.resolutionPp).toBeGreaterThan(0);
    } finally {
      await oracle.close();
    }
  });

  it('counts a rewrite that changes a right answer as a loss', async () => {
    const lossy: RewriteRule = { name: 'lossy', claim: 'replaces the answer', apply: () => 'select name from items where score is null' };
    const oracle = createOracle(resolve('eval/bird/oracle.py'), root);
    try {
      const priced = await priceRewrites(
        [rewriteCase({ sql: 'select name from items where score is not null order by score asc limit 1', declared: true })],
        [lossy],
        { execute: (db, sql) => oracle.run(db, sql), judge: judgeOfficial },
        () => undefined,
      );
      expect(priced.readings[0]).toMatchObject({ fired: 1, lost: 1, won: 0 });
    } finally {
      await oracle.close();
    }
  });

  it('prints a p below one in ten thousand as such', () => {
    const lines = rewriteLines({
      split: 'dev',
      arm: 'a',
      scored: 100,
      recomputed: 50,
      declared: 50,
      agreed: 100,
      readings: [{ rule: 'r', claim: '', fired: 20, won: 1, lost: 19, kept: 0, unchangedWrong: 0, broken: 0, net: -18, mcnemar: 0.00001, resolutionPp: 1 }],
      problems: [],
    }).join('\n');
    expect(lines).toContain('p <0.0001');
  });

  it('counts a gold the engine refuses as unresolved rather than as a loss', async () => {
    const cases = [rewriteCase({ question: question({ SQL: 'select nope from items' }) })];
    const priced = await priceRewrites(
      cases,
      REWRITE_RULES,
      { execute: async (_db, sql) => (sql.includes('nope') ? { ok: false, rows: [] } : { ok: true, rows: [['cup']] }), judge: judgeOfficial },
      () => undefined,
    );
    expect(priced.scored).toBe(1);
    expect(priced.unresolved).toBe(1);
    expect(priced.readings.every((reading) => reading.fired === 0)).toBe(true);
  });

  it('counts a rewrite the engine refuses as broken', async () => {
    const broken: RewriteRule = { name: 'always-bad', claim: 'writes a statement that does not run', apply: () => 'select from' };
    const priced = await priceRewrites(
      [rewriteCase()],
      [broken],
      { execute: async (_db, sql) => (sql === 'select from' ? { ok: false, rows: [] } : { ok: true, rows: [['cup']] }), judge: judgeOfficial },
      () => undefined,
    );
    expect(priced.readings[0]).toMatchObject({ fired: 1, broken: 1, won: 0, lost: 0 });
  });
});

describe('rewriteProblems', () => {
  it('refuses a baseline that does not reproduce the score', () => {
    const problems = rewriteProblems({ recomputed: 979, declared: 980, scored: 1532, readings: [] });
    expect(problems.join(' ')).toContain('the artifact claims 980');
  });

  it('refuses a rule that broke a statement', () => {
    const problems = rewriteProblems({
      recomputed: 1,
      declared: 1,
      scored: 1,
      readings: [{ rule: 'x', claim: '', fired: 1, won: 0, lost: 0, kept: 0, unchangedWrong: 0, broken: 2, net: 0, mcnemar: 1, resolutionPp: 1 }],
    });
    expect(problems.join(' ')).toContain('no longer run');
  });

  it('passes a report whose baseline reconciles', () => {
    expect(rewriteProblems({ recomputed: 980, declared: 980, scored: 1532, readings: [] })).toEqual([]);
  });
});

describe('rewriteLines', () => {
  it('prints every rule with its claim and the reconciliation', () => {
    const lines = rewriteLines({
      split: 'dev',
      arm: 'select-mixed-rule',
      scored: 1532,
      recomputed: 980,
      declared: 980,
      agreed: 1532,
      readings: [{ rule: 'null-order', claim: 'a claim', fired: 80, won: 6, lost: 0, kept: 36, unchangedWrong: 38, broken: 0, net: 6, mcnemar: 0.0313, resolutionPp: 0.4 }],
      problems: [],
    });
    const text = lines.join('\n');
    expect(text).toContain('63.97%');
    expect(text).toContain('null-order');
    expect(text).toContain('a claim');
    expect(text).toContain('+0.39pp');
  });

  it('prints a refusal as a failure line', () => {
    const lines = rewriteLines({ split: 'dev', arm: 'a', scored: 1, recomputed: 0, declared: 1, agreed: 0, readings: [], problems: ['REWRITE: no'] });
    expect(lines.join('\n')).toContain('FAILED REWRITE: no');
  });
});

describe('resolveRewriteSettings', () => {
  it('reads the three flags', () => {
    expect(resolveRewriteSettings(['--artifact', 'a.json', '--arm', 'x', '--limit', '5'])).toEqual({ artifact: 'a.json', arm: 'x', limit: 5 });
  });

  it('requires the artifact and the arm', () => {
    expect(() => resolveRewriteSettings([])).toThrow(/--artifact is required/);
    expect(() => resolveRewriteSettings(['--artifact', 'a.json'])).toThrow(/--arm is required/);
  });

  it('refuses a limit that is not a positive whole number', () => {
    expect(() => resolveRewriteSettings(['--artifact', 'a', '--arm', 'x', '--limit', '0'])).toThrow(/positive whole number/);
    expect(() => resolveRewriteSettings(['--artifact', 'a', '--arm', 'x', '--limit', 'two'])).toThrow(/positive whole number/);
  });

  it('refuses an argument it does not know', () => {
    expect(() => resolveRewriteSettings(['--artefact', 'a'])).toThrow(/unrecognized argument/);
  });
});

describe('typeLookup', () => {
  it('answers with the engine types the split declares', () => {
    const file = join(root, 'tables.json');
    writeFileSync(
      join(root, 'short.json'),
      JSON.stringify([{ db_id: 'short', table_names: ['t'], column_names: [[0, 'a'], [0, 'b']], column_types: ['integer'], foreign_keys: [] }]),
    );
    expect(typeLookup(join(root, 'short.json'))('short')?.('b')).toBe('');
    writeFileSync(
      file,
      JSON.stringify([
        {
          db_id: 'shop',
          table_names: ['items'],
          table_names_original: ['items'],
          column_names: [
            [-1, '*'],
            [0, 'id'],
            [0, 'name'],
          ],
          column_names_original: [
            [-1, '*'],
            [0, 'id'],
            [0, 'name'],
          ],
          column_types: ['text', 'integer', 'text'],
          foreign_keys: [],
        },
      ]),
    );
    const lookup = typeLookup(file)('shop');
    expect(lookup?.('id')).toBe('INTEGER');
    expect(lookup?.('items.id')).toBe('INTEGER');
    expect(lookup?.('name')).toBe('TEXT');
    expect(lookup?.('missing')).toBeUndefined();
    expect(typeLookup(file)('other')).toBeUndefined();
    // The second call is served from the cache the first one filled.
    const cached = typeLookup(file);
    expect(cached('shop')?.('id')).toBe('INTEGER');
    expect(cached('shop')?.('id')).toBe('INTEGER');
  });

  it('answers nothing when the split has no table file', () => {
    expect(typeLookup(join(root, 'absent.json'))('shop')).toBeUndefined();
  });
});

describe('main', () => {
  function layout(): string {
    const base = mkdtempSync(join(tmpdir(), 'nl2charts-rewrite-main-'));
    const data = join(base, 'eval/.cache/bird/minidev/MINIDEV');
    mkdirSync(join(data, 'dev_databases'), { recursive: true });
    // The oracle opens `<databaseRoot>/<db_id>/<db_id>.sqlite`, so the fixture is copied there.
    mkdirSync(join(data, 'dev_databases', 'shop'), { recursive: true });
    const copy = new DatabaseSync(join(data, 'dev_databases', 'shop', 'shop.sqlite'));
    copy.exec(`
      create table items (id integer, name text, score integer);
      insert into items values (1, 'pen', null);
      insert into items values (2, 'cup', 7);
      insert into items values (3, 'lid', 9);
    `);
    copy.close();
    writeFileSync(
      join(data, 'mini_dev_sqlite.json'),
      JSON.stringify([
        { question_id: 1, db_id: 'shop', question: 'which item has the lowest score', evidence: '', SQL: 'select name from items where score is not null order by score asc limit 1', difficulty: 'simple' },
      ]),
    );
    writeFileSync(join(data, 'dev_tables.json'), JSON.stringify([]));
    return base;
  }

  it('prices a manifest end to end and exits zero when it reconciles', async () => {
    const base = layout();
    const artifact = join(base, 'artifact.json');
    writeFileSync(
      artifact,
      JSON.stringify({
        split: 'minidev',
        cases: [{ id: '1', arm: 'a', passed: false, predicted: 'select name from items order by score asc limit 1' }],
      }),
    );
    const code = await main(['--artifact', artifact, '--arm', 'a'], base, {});
    expect(code).toBe(0);
  });

  it('exits non-zero when the baseline cannot reproduce the artifact', async () => {
    const base = layout();
    const artifact = join(base, 'artifact.json');
    writeFileSync(
      artifact,
      JSON.stringify({
        split: 'minidev',
        cases: [{ id: '1', arm: 'a', passed: true, predicted: 'select name from items order by score asc limit 1' }],
      }),
    );
    expect(await main(['--artifact', artifact, '--arm', 'a'], base, {})).toBe(1);
  });

  it('takes the split from the environment when the artifact names none', async () => {
    const base = layout();
    const artifact = join(base, 'artifact.json');
    writeFileSync(artifact, JSON.stringify({ cases: [{ id: '1', arm: 'a', passed: false, predicted: 'select name from items order by score asc limit 1' }] }));
    expect(await main(['--artifact', artifact, '--arm', 'a', '--limit', '1'], base, { BIRD_SPLIT: 'minidev' })).toBe(0);
  });

  it('exits non-zero when a gold statement cannot run', async () => {
    const base = layout();
    const data = join(base, 'eval/.cache/bird/minidev/MINIDEV');
    writeFileSync(
      join(data, 'mini_dev_sqlite.json'),
      JSON.stringify([{ question_id: 1, db_id: 'shop', question: 'q', evidence: '', SQL: 'select nope from items', difficulty: 'simple' }]),
    );
    const artifact = join(base, 'artifact.json');
    writeFileSync(artifact, JSON.stringify({ split: 'minidev', cases: [{ id: '1', arm: 'a', passed: false, predicted: 'select name from items' }] }));
    expect(await main(['--artifact', artifact, '--arm', 'a'], base, {})).toBe(1);
  });

  it('exits non-zero when a case has no statement to re-execute', async () => {
    const base = layout();
    const artifact = join(base, 'artifact.json');
    writeFileSync(artifact, JSON.stringify({ split: 'minidev', cases: [{ id: '1', arm: 'a', passed: false }] }));
    expect(await main(['--artifact', artifact, '--arm', 'a'], base, {})).toBe(1);
  });
});
