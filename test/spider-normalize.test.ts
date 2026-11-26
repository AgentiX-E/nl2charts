/**
 * The dialect repairs, and the classification they were chosen from.
 *
 * Every rule in `normalize.ts` is a claim that a rewrite preserves meaning, and each claim is asserted
 * against the statement it was written for *and* against the neighbours it must not touch: a rule that
 * rewrites `<>` must not rewrite `'<>'` inside a literal, a rule that drops `AS teacher` must not drop
 * `AS T1`, and a rule that drops a numeric cast must not drop a cast to text. The rules were chosen by
 * a measurement — `eval/spider/residue.ts` over 45 refusals — and the last test in the first block
 * replays the invariant that measurement established: a statement the parser accepts comes back
 * byte-identical, which is why switching the repairs on cannot lower an arm's reading.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDatabase } from '../eval/spider/fetch.mjs';
import {
  REFUSAL_CLASSES,
  RULES,
  classOfReason,
  normalize,
  outsideLiterals,
  repairsOf,
  residueLines,
  residueOf,
} from '../eval/spider/normalize.js';
import { artifactOf, classify, main, resolveSettings, runsAsMain } from '../eval/spider/residue.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dirOf(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spider-residue-'));
  dirs.push(dir);
  return dir;
}

describe('notEqual', () => {
  it('rewrites the operator the reference does not have', () => {
    expect(normalize('SELECT a FROM t WHERE a <> 3')).toBe('SELECT a FROM t WHERE a != 3');
  });

  it('keeps a comparison that is already in the grammar', () => {
    const sql = 'SELECT a FROM t WHERE a >= 3 AND a <= 4 AND a != 5';
    expect(normalize(sql)).toBe(sql);
  });

  it('never rewrites inside a string literal, where <> is data', () => {
    expect(normalize("SELECT a FROM t WHERE a = '<>'")).toBe("SELECT a FROM t WHERE a = '<>'");
  });

  it('copies a literal that is never closed instead of repairing past it', () => {
    expect(outsideLiterals("SELECT a FROM t WHERE a = '<>", (segment) => segment.replace('<>', '!='))).toBe(
      "SELECT a FROM t WHERE a = '<>",
    );
  });

  it('steps over an escaped quote and keeps repairing after it', () => {
    expect(normalize("SELECT a FROM t WHERE b = 'it''s <>' AND a <> 1")).toBe(
      "SELECT a FROM t WHERE b = 'it''s <>' AND a != 1",
    );
  });
});

describe('innerJoin', () => {
  it('writes the join the FROM parser reads', () => {
    expect(normalize('SELECT * FROM a INNER JOIN b ON a.i = b.i')).toBe('SELECT * FROM a JOIN b ON a.i = b.i');
  });

  it('accepts the lowercase spelling, because a model writes both', () => {
    expect(normalize('select * from a inner   join b on a.i = b.i')).toBe('select * from a JOIN b on a.i = b.i');
  });

  it('does not touch a table whose name begins with the keyword', () => {
    const sql = 'SELECT * FROM inner_table JOIN b ON inner_table.i = b.i';
    expect(normalize(sql)).toBe(sql);
  });
});

describe('duplicateAlias', () => {
  it('drops an alias that only repeats the table it names', () => {
    expect(normalize('SELECT teacher.Name FROM teacher AS teacher JOIN course AS c ON c.id = teacher.id')).toBe(
      'SELECT teacher.Name FROM teacher JOIN course AS c ON c.id = teacher.id',
    );
  });

  it('compares the two names without case, because SQL identifiers do', () => {
    expect(normalize('SELECT * FROM VOTES AS votes')).toBe('SELECT * FROM VOTES');
  });

  it('keeps an alias that renames the table, which is what an alias is for', () => {
    const sql = 'SELECT T1.Name FROM teacher AS T1 JOIN course AS T2 ON T1.id = T2.id';
    expect(normalize(sql)).toBe(sql);
  });

  it('keeps a bare alias that has no AS, because that one is the grammar arm’s job to forbid', () => {
    const sql = 'SELECT * FROM teacher t';
    expect(normalize(sql)).toBe(sql);
  });
});

describe('cast', () => {
  it('drops a numeric cast over a bare column', () => {
    expect(normalize('SELECT a FROM t WHERE CAST(Horsepower AS INTEGER) > 150')).toBe(
      'SELECT a FROM t WHERE Horsepower > 150',
    );
  });

  it('drops it on a qualified column too', () => {
    expect(normalize('SELECT cast(t.a AS REAL) FROM t')).toBe('SELECT t.a FROM t');
  });

  it('keeps a cast to text, which changes the comparison it is in', () => {
    const sql = "SELECT a FROM t WHERE CAST(a AS TEXT) = '1'";
    expect(normalize(sql)).toBe(sql);
  });

  it('keeps a cast over an expression, which is not a column and cannot be dropped', () => {
    const sql = 'SELECT a FROM t WHERE CAST(a + b AS INT) = 1';
    expect(normalize(sql)).toBe(sql);
  });
});

describe('the repairs as a whole', () => {
  it('is idempotent, so a second pass is not a different statement', () => {
    const once = normalize('SELECT * FROM teacher AS teacher INNER JOIN c AS c ON c.id = teacher.id WHERE a <> 1');
    expect(normalize(once)).toBe(once);
  });

  it('leaves a statement the parser accepts byte-identical, which is what makes the reading monotone', () => {
    const accepted =
      'SELECT T1.Fname FROM Student AS T1 JOIN Has_Pet AS T2 ON T1.StuID = T2.StuID WHERE T1.Age = 20 GROUP BY T1.StuID';
    expect(normalize(accepted)).toBe(accepted);
    expect(repairsOf(accepted)).toEqual([]);
  });

  it('names a rule once even when it repairs three statements in one query', () => {
    const selfAliased = 'SELECT * FROM Student AS Student JOIN Has_Pet AS Has_Pet ON Student.StuID = Has_Pet.StuID';
    expect(repairsOf(selfAliased).map((repair) => repair.rule)).toEqual(['duplicateAlias']);
  });

  it('names each repair that fired, with the statement on both sides of it', () => {
    const repairs = repairsOf('SELECT * FROM a AS a INNER JOIN b AS b ON a.i = b.i WHERE a.x <> 1');
    expect(repairs.map((repair) => repair.rule)).toEqual(['notEqual', 'innerJoin', 'duplicateAlias']);
    expect(repairs[0]?.after).toContain('!=');
    expect(repairs.at(-1)?.before).toBe('SELECT * FROM a AS a JOIN b AS b ON a.i = b.i WHERE a.x != 1');
    expect(repairs.at(-1)?.after).toBe('SELECT * FROM a JOIN b ON a.i = b.i WHERE a.x != 1');
  });

  it('reports nothing for a statement that needs nothing', () => {
    expect(repairsOf('SELECT count(*) FROM singer')).toEqual([]);
  });

  it('every rule says why the reference refuses it, and no two rules share a name', () => {
    for (const rule of RULES) expect(rule.why.length).toBeGreaterThan(20);
    expect(new Set(RULES.map((rule) => rule.name)).size).toBe(RULES.length);
  });
});

describe('reading a refusal reason', () => {
  it('maps the vocabulary measured on dev', () => {
    expect(classOfReason('Error col: >')).toBe('notEqual');
    expect(classOfReason('Alias teacher has the same name in table')).toBe('duplicateAlias');
    expect(classOfReason("'inner'")).toBe('innerJoin');
    expect(classOfReason('Error col: cast')).toBe('cast');
    expect(classOfReason('Error col: ||')).toBe('concat');
    expect(classOfReason('Error col: not')).toBe('notIn');
    expect(classOfReason('Error col: select')).toBe('subqueryInColumn');
  });

  it('separates a parser that said nothing from one that said something new', () => {
    expect(classOfReason('')).toBe('unstated');
    expect(classOfReason(undefined)).toBe('unstated');
    expect(classOfReason('Error col: foo')).toBe('other');
  });

  it('answers inside the declared vocabulary, which is what makes the table add up', () => {
    for (const reason of ['', 'nonsense', 'Error col: >']) {
      expect(REFUSAL_CLASSES).toContain(classOfReason(reason));
    }
  });
});

describe('grouping the residue', () => {
  const rows = [
    { index: 1, reason: 'Error col: >', repaired: { pred: 'ok', em: 1 }, repairs: ['notEqual'] },
    { index: 2, reason: 'Error col: >', repaired: { pred: 'ok', em: 0 }, repairs: ['notEqual'] },
    { index: 3, reason: 'Error col: ||', repaired: { pred: 'error' }, repairs: [] },
  ];

  it('counts refused, readable and right per class, in the order the classes are declared', () => {
    const residue = residueOf(rows);
    expect(residue.refused).toBe(3);
    expect(residue.readable).toBe(2);
    expect(residue.exact).toBe(1);
    expect(residue.classes).toEqual([
      { refusal: 'notEqual', cases: 2, readable: 2, exact: 1 },
      { refusal: 'concat', cases: 1, readable: 0, exact: 0 },
    ]);
  });

  it('prints a class with no rule as an em dash rather than as a rule name', () => {
    const text = residueLines(residueOf(rows)).join('\n');
    expect(text).toMatch(/notEqual\s+2\s+2\s+1\s+notEqual/);
    expect(text).toMatch(/concat\s+1\s+0\s+0\s+—/);
  });

  it('names the statements a repair made readable but not right, because those are not a gain', () => {
    expect(residueLines(residueOf(rows)).join('\n')).toContain('readable, not right: #2 Error col: > [notEqual]');
  });

  it('prints a header that says what the three counts mean', () => {
    expect(residueLines(residueOf([]))[0]).toBe('residue: 0 refusal(s), 0 readable after repair, 0 also right');
  });
});

describe('the residue tool', () => {
  const ENTRY: Parameters<typeof buildDatabase>[0] = {
    db_id: 'shop',
    table_names_original: ['singer'],
    column_names_original: [[-1, '*'], [0, 'singer_id'], [0, 'name']],
    column_types: ['text', 'number', 'text'],
    primary_keys: [1],
  };

  function corpus(): { dir: string; predictions: string } {
    const dir = dirOf();
    writeFileSync(
      join(dir, 'dev.json'),
      JSON.stringify([
        { db_id: 'shop', question: 'How many singers?', query: 'SELECT count(*) FROM singer' },
        { db_id: 'shop', question: 'What are the names?', query: 'SELECT name FROM singer' },
      ]),
    );
    mkdirSync(join(dir, 'database', 'shop'), { recursive: true });
    buildDatabase(ENTRY, join(dir, 'database', 'shop', 'shop.sqlite'));
    const predictions = join(dir, 'predictions.jsonl');
    writeFileSync(predictions, '{"index":0,"sql":"SELECT count(*) FROM singer"}\n{"index":1,"sql":"SELECT name FROM singer AS singer"}\n');
    return { dir, predictions };
  }

  it('reads the flags score.ts reads, spelled the same way', () => {
    const settings = resolveSettings(['--predictions', 'p.jsonl', '--cache', 'c', '--limit', '5', '--out', 'o.json']);
    expect(settings).toEqual({ predictions: 'p.jsonl', cache: 'c', limit: 5, out: 'o.json' });
    expect(resolveSettings(['--predictions', 'p.jsonl']).limit).toBeUndefined();
  });

  it('refuses a limit that is not a positive integer', () => {
    expect(() => resolveSettings(['--limit', '0'])).toThrow('--limit must be a positive integer, got 0');
  });

  it('classifies through the judge it is given, and reports the two readings', () => {
    const { dir, predictions } = corpus();
    const lines: string[] = [];
    const out = join(dir, 'residue.json');
    const code = main(['--predictions', predictions, '--cache', dir, '--out', out], (line) => lines.push(line), {
      judge: (pairs) =>
        pairs.map((pair) => {
          if (pair.pred === 'SELECT count(*) FROM singer') return { em: 1, gold: 'ok', pred: 'ok' };
          if (pair.pred.includes('AS singer')) return { em: 0, gold: 'ok', pred: 'error', reason: 'Alias singer has the same name in table' };
          return { em: 1, gold: 'ok', pred: 'ok' };
        }),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('exact as written   1 = 50.00%');
    expect(lines.join('\n')).toContain('exact after repair 2 = 100.00% (+1)');
    expect(lines.join('\n')).toContain('duplicateAlias');
    const artifact = JSON.parse(readFileSync(out, 'utf8')) as ReturnType<typeof artifactOf>;
    expect(artifact.exactAfterRepair).toBe(2);
    expect(artifact.residue.classes).toEqual([{ refusal: 'duplicateAlias', cases: 1, readable: 1, exact: 1 }]);
  });

  it('says which flag is missing rather than scoring nothing', () => {
    const lines: string[] = [];
    expect(main([], (line) => lines.push(line))).toBe(2);
    expect(lines).toEqual(['spider residue: --predictions is required']);
  });

  it('refuses a corpus whose database is missing, naming the database', () => {
    const dir = dirOf();
    writeFileSync(join(dir, 'dev.json'), JSON.stringify([{ db_id: 'gone', question: 'q', query: 'SELECT 1' }]));
    const predictions = join(dir, 'p.jsonl');
    writeFileSync(predictions, '{"index":0,"sql":"SELECT 1"}\n');
    expect(() => main(['--predictions', predictions, '--cache', dir])).toThrow('database gone is missing');
  });

  it('refuses a judge that answers a different number of pairs than it was asked', () => {
    const { dir, predictions } = corpus();
    expect(() => classify([{ index: 0, db: 'x', pred: 'a', gold: 'b' }], () => [])).toThrow(
      'the judge answered 0 of 1 pairs',
    );
    expect(() => main(['--predictions', predictions, '--cache', dir], () => undefined, { judge: () => [] })).toThrow(
      'the judge answered 0 of 2 pairs',
    );
  });

  it('reports zero rather than a ratio when it was given no questions at all', () => {
    const artifact = artifactOf(0, 0, residueOf([]), 'p.jsonl');
    expect([artifact.exactPct, artifact.exactAfterRepairPct, artifact.asked]).toEqual([0, 0, 0]);
  });

  it('scores only the first N questions when a limit is given', () => {
    const { dir, predictions } = corpus();
    const lines: string[] = [];
    const code = main(['--predictions', predictions, '--cache', dir, '--limit', '1'], (line) => lines.push(line), {
      judge: (pairs) => pairs.map(() => ({ em: 1, gold: 'ok', pred: 'ok' })),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('1 question(s)');
  });

  it('refuses a second pass that answered a different number of repairs', () => {
    // The first pass answers both pairs; the pass over the repairs answers neither.
    let pass = 0;
    expect(() =>
      classify(
        [
          { index: 0, db: 'db', pred: 'a <> 1', gold: 'g' },
          { index: 1, db: 'db', pred: 'b <> 2', gold: 'g' },
        ],
        () => {
          pass += 1;
          return pass === 1 ? [{ pred: 'error', em: 0 }, { pred: 'error', em: 0 }] : [];
        },
      ),
    ).toThrow('the judge answered 0 of 2 repairs');
  });

  it('calls the reference judge when it is not handed one, and asks it nothing when there is nothing to ask', () => {
    // An empty predictions file is the one case where the default judge can be reached without
    // python: no pairs, no process. The branch is what a bare `tsx eval/spider/residue.ts` takes.
    const { dir } = corpus();
    const empty = join(dirOf(), 'empty.jsonl');
    writeFileSync(empty, '');
    const lines: string[] = [];
    expect(main(['--predictions', empty, '--cache', dir], (line) => lines.push(line))).toBe(0);
    expect(lines.join('\n')).toContain('0 question(s)');
  });

  it('runs as a program only when it is the program that was started', () => {
    expect(runsAsMain('eval/spider/residue.ts')).toBe(true);
    expect(runsAsMain('eval/spider/score.ts')).toBe(false);
    expect(runsAsMain(undefined)).toBe(false);
  });
});
