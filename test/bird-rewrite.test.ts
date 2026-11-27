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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { judgeOfficial } from '@agentix-e/nl2charts-devkit';
import type { BirdQuestion } from '../eval/bird/data.js';
import { createOracle } from '../eval/bird/oracle.js';
import type { RewriteInput } from '../eval/bird/rewrite.js';
import {
  ORACLE_RULES,
  REWRITE_RULES,
  TRANSPLANT_LIMIT,
  main,
  priceRewrites,
  resolveRewriteSettings,
  rewriteCases,
  ledgerProblems,
  rewriteLines,
  rewriteProblems,
  statementOf,
  typeLookup,
} from '../eval/bird/rewrite.js';
import type { RewriteArtifact, RewriteCase, RewriteReading, RewriteRule } from '../eval/bird/rewrite.js';

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

/**
 * A real domain reader over the fixture table.
 *
 * Not a stub: the grounding rules are only honest if the values they ground against were read
 * from a database, so the test reads them the way the harness does — one distinct query per
 * column.
 */
function domainReader(oracle: ReturnType<typeof createOracle>) {
  return async (_db: string, table: string, column: string): Promise<readonly string[]> => {
    const result = await oracle.run('shop', `select distinct "${column}" from "${table}"`);
    return result.ok ? result.rows.map((row) => String(row[0])) : [];
  };
}

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

  it('reads the statement a passing case carries, so a rule can be caught breaking one', () => {
    // Without this branch every priced case came from the failure list: the denominator was the
    // failures, every `pp` was per-failure, and `lost` could not be non-zero on an artifact that
    // keeps statements only for the cases that went wrong.
    expect(statementOf({ id: '7', passed: true, sql: 'select 5' }, [])).toBe('select 5');
    // The rule arm still wins: the slot it chose is what ran, not the statement the row repeats.
    expect(statementOf({ id: '7', sql: 'select 6', candidates: [{ sql: 'select 7' }], selectedByRule: { index: 0 } }, [])).toBe('select 7');
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

  it('prices an artifact that recorded no failures block, because a passing arm writes none', () => {
    // `failures` is where a failed case keeps its statement; an arm that passed everything has no
    // key at all, and reading it as "no failures" is the difference between an empty list and a
    // crash on the best run of the round.
    const cases = rewriteCases({ cases: [{ id: '1', arm: 'a', passed: true, sql: 'select 1' }] }, 'a', [question({ question_id: 1 })]);
    expect(cases).toMatchObject({ unretained: 0, unknownQuestion: 0 });
    expect(cases.cases).toHaveLength(1);
  });

  it('reads an artifact that kept no cases at all as empty rather than as an error', () => {
    // A run that died before its first case uploads a report with no case array, and the pricer's
    // job is to say "nothing to price" rather than to throw on a field that is legitimately absent.
    expect(rewriteCases({}, 'a', [])).toEqual({ cases: [], unretained: 0, unknownQuestion: 0 });
  });

  it('prices a case list with no failure list beside it', () => {
    // Every case that ran correctly leaves no failure row, so an artifact whose arm passed
    // everything has `cases` and no `failures` key at all. The statement is on the case itself; a
    // reader that needed the failure list would drop the whole arm as unretained.
    const kept = rewriteCases({ cases: [{ id: '4', arm: 'a', passed: true, sql: 'select 4' }] }, 'a', [question({ question_id: 4 })]);
    expect(kept).toEqual({ cases: [{ id: '4', question: question({ question_id: 4 }), sql: 'select 4', declared: true }], unretained: 0, unknownQuestion: 0 });
  });
});

describe('REWRITE_RULES', () => {
  const rule = (name: string): RewriteRule => {
    const found = REWRITE_RULES.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`no rule ${name}`);
    return found;
  };
  // The three fields a rule may read and none of the engine rules use: stated once so a test for
  // `null-order` is not silently a test for the harvest the grounding rules need.
  const at = (sql: string, extra: Partial<RewriteInput> = {}): RewriteInput => ({
    question: '',
    sql,
    domains: [],
    empty: false,
    goldSql: '',
    passed: false,
    ...extra,
  });

  it('guards an ascending sort behind a cap and nothing else', () => {
    expect(rule('null-order').apply(at('select a from t order by a asc limit 1'))).toContain('a IS NULL');
    expect(rule('null-order').apply(at('select a from t order by a asc'))).toBeUndefined();
  });

  it('drops a row cap only when the question counts', () => {
    expect(rule('drop-limit-on-count').apply(at('select id from t limit 3', { question: 'how many items are there' }))).toBe('select id from t;');
    expect(rule('drop-limit-on-count').apply(at('select id from t limit 3', { question: 'which item' }))).toBeUndefined();
    expect(rule('drop-limit-on-count').apply(at('select count(*) from t', { question: 'how many' }))).toBeUndefined();
  });

  it('drops a cap that neither ranks its rows nor answers a question that names a rank', () => {
    // The rule the AI package ships. Every refusal below is a case the gross form of the same edit
    // used to break: an ordered cap is a top-N, a capped answer to "the highest score" is a top-N
    // the statement forgot to order, and a cap of zero asks for columns and no rows.
    const apply = (sql: string, question = 'which items are there'): unknown => rule('drop-unordered-limit').apply(at(sql, { question }));
    expect(apply('select id from t limit 3')).toBe('select id from t');
    expect(apply('select id from t limit 3;')).toBe('select id from t;');
    expect(apply('select id from t order by id limit 3')).toBeUndefined();
    expect(apply('select id from t limit 3', 'what is the top 3 by price')).toBeUndefined();
    expect(apply('select id from t limit 0')).toBeUndefined();
    expect(apply('select id from t limit 3 offset 1')).toBeUndefined();
    expect(apply('select id from (select id from t limit 2) d')).toBeUndefined();
    expect(apply('select id from t')).toBeUndefined();
    // A cap written as an arithmetic expression is not one this rule can read without evaluating it.
    expect(apply('select id from t limit 1 + 2')).toBeUndefined();
  });

  it('counts the same rows without the distinct, and changes nothing else', () => {
    const apply = (sql: string): unknown => rule('drop-count-distinct').apply(at(sql));
    expect(apply('select count(distinct t.id) from t')).toBe('select count(t.id) from t');
    // The function's own spelling is the caller's and is left alone: this rule removes one word.
    expect(apply('select COUNT(DISTINCT t.id) from t')).toBe('select COUNT(t.id) from t');
    expect(apply('select count(distinct coalesce(a, b)) from t')).toBe('select count(coalesce(a, b)) from t');
    expect(apply('select count(distinct a), count(distinct b) from t')).toBe('select count(a), count(b) from t');
    // A `distinct` on the select list is a claim about which rows come back, not about how many
    // rows a count reads, and this rule is about the second.
    expect(apply('select distinct count(distinct a) from t')).toBe('select distinct count(a) from t');
    // Statements that do not count distinct rows are not this rule's business.
    expect(apply('select count(*) from t')).toBeUndefined();
    expect(apply('select distinct a from t')).toBeUndefined();
    expect(apply('select count(a) from t')).toBeUndefined();
    // The word inside a literal is text.
    expect(apply("select count(distinct a) from t where note = 'count(distinct b)'")).toBe(
      "select count(a) from t where note = 'count(distinct b)'",
    );
  });

  it('scales an integer numerator and leaves everything else alone', () => {
    const typeOf = (name: string): string | undefined => (name === 'a' || name === 'b' ? 'INTEGER' : 'REAL');
    // A single statement in, a single statement out: this rule never proposes a second edit, and
    // the assertion is written to say so where an array would silently pass.
    const apply = (sql: string): string | undefined => {
      const out = rule('integer-division').apply(at(sql, { typeOf }));
      return typeof out === 'string' ? out : undefined;
    };
    expect(apply('select a / b from t')).toBe('select (a) * 1.0 / b from t');
    expect(apply('select sum(x) / count(*) from t')).toBe('select (sum(x)) * 1.0 / count(*) from t');
    expect(apply('select c / b from t')).toBeUndefined();
    expect(apply('select a * 1.0 / b from t')).toBeUndefined();
    // A division inside a literal is text, not arithmetic; the statement below divides nothing.
    expect(apply("select note = 'a/b' from t")).toBeUndefined();
    expect(apply('select cast(a as real) / b from t')).toBeUndefined();
    expect(rule('integer-division').apply(at('select a / b from t'))).toBeUndefined();
    // A column whose type the split does not declare is not evidence of truncation.
    expect(rule('integer-division').apply(at('select z / b from t', { typeOf: () => undefined }))).toBeUndefined();
  });
});

/** The rule with this name, from the shippable catalogue. */
function ruleOf(name: string): RewriteRule {
  const found = REWRITE_RULES.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no rule ${name}`);
  return found;
}

describe('the grounding rules', () => {
  const at = (sql: string, extra: Partial<RewriteInput> = {}): RewriteInput => ({
    question: '',
    sql,
    domains: [{ table: 'items', column: 'name', values: ['Cup', 'Lid'] }],
    empty: false,
    goldSql: '',
    passed: false,
    ...extra,
  });

  it('grounds a value the column stores in another case', () => {
    expect(ruleOf('ground-case-any').apply(at("select id from items where name = 'cup'"))).toBe(
      "select id from items where name = 'Cup'",
    );
  });

  it('leaves a value the column already stores alone', () => {
    // The whole licence of the edit is that the spelling is absent: a statement that names a
    // stored value is not a lookup miss, and rewriting it would be renaming the user's answer.
    expect(ruleOf('ground-case-any').apply(at("select id from items where name = 'Cup'"))).toBeUndefined();
  });

  it('refuses when two spellings match, because the choice would be a guess', () => {
    const ambiguous = at("select id from items where name = 'cup'", {
      domains: [{ table: 'items', column: 'name', values: ['Cup', 'CUP'] }],
    });
    expect(ruleOf('ground-case-any').apply(ambiguous)).toBeUndefined();
  });

  it('refuses a pattern, whose operand is not a value', () => {
    // `like '%cup%'` matching one stored value says nothing about which spelling was meant.
    expect(ruleOf('ground-case-any').apply(at("select id from items where name like 'cup'"))).toBeUndefined();
  });

  it('fires without a reader only when there is nothing to read', () => {
    // No domains is the state a caller with no database has: the rule cannot fire, and saying so
    // is the difference between "no gap" and "could not look".
    expect(ruleOf('ground-case-any').apply(at("select id from items where name = 'cup'", { domains: [] }))).toBeUndefined();
  });

  it('gates the shipped rule on an empty result and the second gate does not', () => {
    const sql = "select id from items where name = 'cup'";
    expect(ruleOf('ground-case-empty').apply(at(sql, { empty: true }))).toBe("select id from items where name = 'Cup'");
    expect(ruleOf('ground-case-empty').apply(at(sql, { empty: false }))).toBeUndefined();
    // The gate is the only difference between the two rules: same edit, same guard, same evidence.
    expect(ruleOf('ground-case-any').apply(at(sql, { empty: false }))).toBe("select id from items where name = 'Cup'");
  });

  /**
   * The two licences beyond `case`, priced rather than adopted.
   *
   * Both edits are the same machinery under a narrower claim, so the tests that matter are the
   * ones about the claim: a number whose value matches and whose length does not must not be
   * substituted, and a prefix with two continuations must not be completed. The shipped rule is
   * asserted to *refuse* both, because a licence that leaks is not a licence.
   */
  it('pads a number whose column stores the leading zeros, and refuses a different number', () => {
    const padded = { domains: [{ table: 'schools', column: 'CharterNum', values: ['0040', '0728'] }] };
    expect(ruleOf('ground-padding').apply(at("select id from schools where CharterNum = '40'", padded))).toBe(
      "select id from schools where CharterNum = '0040'",
    );
    // `400` and `0040` share digits and are not the same lookup key.
    expect(ruleOf('ground-padding').apply(at("select id from schools where CharterNum = '400'", padded))).toBeUndefined();
    // The shipped rule does not reach a digit string, which is why this needed its own licence.
    expect(ruleOf('ground-case-any').apply(at("select id from schools where CharterNum = '40'", padded))).toBeUndefined();
  });

  it('completes a label with the parenthetical the column appends, and refuses a bare prefix', () => {
    const labels = { domains: [{ table: 'frpm', column: 'School Type', values: ['High Schools (Public)', 'Continuation High Schools'] }] };
    expect(ruleOf('ground-parenthetical').apply(at("select id from frpm where \"School Type\" = 'High Schools'", labels))).toBe(
      "select id from frpm where \"School Type\" = 'High Schools (Public)'",
    );
    // `Continuation` begins both continuation labels; choosing one would answer another question.
    expect(ruleOf('ground-parenthetical').apply(at("select id from frpm where \"School Type\" = 'Continuation'", labels))).toBeUndefined();
    expect(ruleOf('ground-case-any').apply(at("select id from frpm where \"School Type\" = 'High Schools'", labels))).toBeUndefined();
  });
});

describe('the ceilings', () => {
  const at = (sql: string, extra: Partial<RewriteInput> = {}): RewriteInput => ({
    question: '',
    sql,
    domains: [],
    empty: false,
    goldSql: "select id from items where name = 'Cup'",
    passed: false,
    ...extra,
  });

  const transplant = ORACLE_RULES.find((entry) => entry.name === 'oracle-transplant');

  it('proposes the gold value for the same column and nothing else', () => {
    const proposed = transplant?.apply(at("select id from items where name = 'cup'"));
    expect(proposed).toEqual(["select id from items where name = 'Cup'"]);
  });

  it('does not put a value from another column where a literal sits', () => {
    // A value is compared against a column. A literal from a different column is a different
    // question, and a rule that moved it would repair statements by accident.
    expect(transplant?.apply(at("select id from items where name = 'cup'", { goldSql: "select id from items where id = 'Cup'" }))).toBeUndefined();
  });

  it('skips a literal the two statements already agree on', () => {
    // Same value in both: nothing to repair, and proposing it would count a case as fired for
    // rewriting a statement to itself.
    expect(transplant?.apply(at("select id from items where name = 'Cup'"))).toBeUndefined();
    // One column compared twice against the gold's two values produces two statements, and only
    // those two: the second site does not re-propose the first one's rewrite.
    const twice = transplant?.apply(
      at("select id from items where name in ('cup', 'lid')", { goldSql: "select id from items where name in ('Cup', 'Lid')" }),
    );
    // Every same-column value the gold names, at every site that names a different one: four
    // cross pairs, and none of them a pair the two statements already agree on. A ceiling that
    // tried only the aligned pair would understate what one substitution can do.
    expect(twice).toEqual([
      "select id from items where name in ('Cup', 'lid')",
      "select id from items where name in ('Lid', 'lid')",
      "select id from items where name in ('cup', 'Cup')",
      "select id from items where name in ('cup', 'Lid')",
    ]);
  });

  it('prices the gross form of the cap edit, which is the rule without its conditions', () => {
    // The reading that refutes "the cheapest lever": this fires on ordered caps and on questions
    // that wanted a ranking, and those are the cases it breaks.
    const gross = ORACLE_RULES.find((entry) => entry.name === 'oracle-drop-limit');
    const apply = (sql: string, goldSql = 'select id from t'): unknown => gross?.apply(at(sql, { goldSql }));
    expect(apply('select id from t limit 3')).toBe('select id from t');
    // The terminator is the statement's, so a ceiling that removed it would be a different edit
    // from the one it claims to price.
    expect(apply('select id from t limit 3;')).toBe('select id from t;');
    // The ordering is the statement's and survives: only the cap is removed, which is exactly why
    // an ordered statement stops matching its answer once the cap is gone.
    expect(apply('select id from t order by id limit 3')).toBe('select id from t order by id');
    expect(apply('select id from t limit 3', 'select id from t limit 3')).toBeUndefined();
    expect(apply('select id from t')).toBeUndefined();
    expect(gross?.oracle).toBe(true);
  });

  it('is silent on a case that already passes, because it is a ceiling and not a guess', () => {
    expect(transplant?.apply(at("select id from items where name = 'cup'", { passed: true }))).toBeUndefined();
    expect(transplant?.oracle).toBe(true);
    expect(REWRITE_RULES.some((entry) => entry.oracle === true)).toBe(false);
  });

  it('proposes one statement per value, not one per site the gold names it at', () => {
    // The gold may compare the same column against the same value twice; two sites would produce
    // the same rewritten statement, and executing it twice would charge the ceiling for a repeat.
    const proposed = transplant?.apply(
      at("select id from items where name = 'cup'", { goldSql: "select id from items where name in ('Cup', 'Cup')" }),
    );
    expect(proposed).toEqual(["select id from items where name = 'Cup'"]);
  });

  it('caps the substitutions it proposes, because a ceiling is charged per execution', () => {
    const many = Array.from({ length: 9 }, (_unused, index) => `'v${String(index)}'`).join(', ');
    const gold = `select id from items where name in (${many})`;
    const proposed = transplant?.apply(at("select id from items where name in ('x')", { goldSql: gold }));
    expect(Array.isArray(proposed)).toBe(true);
    expect((proposed as readonly string[]).length).toBe(TRANSPLANT_LIMIT);
  });

  /**
   * The second ceiling: the gold's whole filter, moved across.
   *
   * `oracle-transplant` prices one literal at a time, so it cannot answer "was the filter the whole
   * difference". Moving the clause answers it in one execution, and only on the case where both
   * statements read the same single table — everywhere else the spliced clause is valid SQL against
   * a table the prediction never read, and the ceiling would report a `tables` failure as a
   * `predicate` one.
   */
  const predicate = ORACLE_RULES.find((entry) => entry.name === 'oracle-predicate');

  it('splices the gold filter into a prediction that wrote none', () => {
    expect(predicate?.apply(at('select count(*) from items', { goldSql: "select count(*) from items where name = 'Cup'" }))).toBe(
      "select count(*) from items where name = 'Cup'",
    );
  });

  it('takes the prediction filter out when the gold has none', () => {
    // The `filter-wide` direction. A ceiling that could only add a clause would report the half of
    // the bucket where the prediction filtered and the gold did not as unreachable.
    expect(predicate?.apply(at("select id from items where name = 'cup'", { goldSql: 'select id from items' }))).toBe(
      'select id from items',
    );
  });

  it('drops the qualifier so one table under two spellings still matches', () => {
    // The gold writes `frpm.name` and the prediction writes `i.id`; both name the same table. The
    // splice is defined on the clause, so the spellings have to be reconciled first — without this
    // the clause is `frpm.name = 'Cup'` against a statement with no `frpm` in scope, and every
    // proposal would be refused instead of priced.
    //
    // The `i` declaration stays: an alias that is declared and never used is legal SQL, so removing
    // it would be a second edit on text the ceiling does not otherwise touch, and one more place to
    // be wrong about. The reading was taken with it standing.
    expect(
      predicate?.apply(at('select i.id from items i', { goldSql: "select frpm.id from items as frpm where frpm.name = 'Cup'" })),
    ).toBe("select id from items i where name = 'Cup'");
  });

  it('refuses to splice into a join, where a bare column name means two things', () => {
    // Two tables in scope: `name` is not one column any more, so the ceiling would be measuring a
    // statement nobody wrote. Silence is the reading — the report prints how much of the bucket it
    // could not reach rather than folding it into the denominator.
    expect(predicate?.apply(at('select i.id from items i join orders o on i.id = o.item_id'))).toBeUndefined();
    // And one table on one side only is the same case: the two statements are not about one schema.
    expect(
      predicate?.apply(at('select id from items', { goldSql: 'select i.id from items i join orders o on i.id = o.item_id' })),
    ).toBeUndefined();
  });

  it('proposes nothing when the splice would write the statement it was given', () => {
    // A case that passes, or one where the prediction already wrote the gold's filter: proposing it
    // would count the case as fired and charge an execution for a statement that did not change.
    expect(predicate?.apply(at("select id from items where name = 'Cup'"))).toBeUndefined();
    expect(predicate?.apply(at("select id from items where name = 'Cup'", { passed: true }))).toBeUndefined();
  });

  it('declares refusal a reading, which a shippable rule may not', () => {
    // The gold clause cannot run against a prediction that never read the gold's table, and that
    // refusal is the finding — the case is in the `tables` bucket, not a defect in the splice.
    expect(predicate?.tolerateRefusal).toBe(true);
    expect(REWRITE_RULES.some((entry) => entry.tolerateRefusal === true)).toBe(false);
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
      const priced = await priceRewrites(
        cases,
        REWRITE_RULES,
        { execute: (db, sql) => oracle.run(db, sql), judge: judgeOfficial, domain: domainReader(oracle) },
        () => undefined,
      );
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

  it('files a refused proposal as a reading when the rule declared it one, and as a defect otherwise', async () => {
    // The same proposal, twice, differing only in what the rule says a refusal means. A shipped rule
    // that writes a statement the engine refuses is wrong about something and the report fails the
    // build; the predicate ceiling's refusal says the prediction never read the gold's table, which
    // is the finding it went looking for. Counting both the same way would either fail a gate over a
    // measurement or publish a rule that breaks statements.
    const refuse = (tolerate: boolean): RewriteRule => ({
      name: tolerate ? 'ceiling' : 'rule',
      claim: 'splices a clause the statement cannot run',
      ...(tolerate ? { tolerateRefusal: true as const } : {}),
      apply: () => 'select from where',
    });
    const oracle = createOracle(resolve('eval/bird/oracle.py'), root);
    try {
      const priced = await priceRewrites(
        [rewriteCase()],
        [refuse(true), refuse(false)],
        { execute: (db, sql) => oracle.run(db, sql), judge: judgeOfficial },
        () => undefined,
      );
      expect(priced.readings[0]).toMatchObject({ fired: 1, refused: 1, broken: 0, net: 0 });
      expect(priced.readings[1]).toMatchObject({ fired: 1, refused: 0, broken: 1, net: 0 });
      // A refusal is neither a win nor a loss, so neither reading may be adopted on the strength of it.
      expect(priced.readings.every((reading) => reading.won === 0 && reading.lost === 0)).toBe(true);
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
      readings: [{ rule: 'r', claim: '', oracle: false, adoption: 'product', fired: 20, won: 1, lost: 19, kept: 0, unchangedWrong: 0, wonCases: [], broken: 0, refused: 0, net: -18, mcnemar: 0.00001, resolutionPp: 1 }],
      union: 1,
      overlap: [],
      ceiling: { cases: 0, beyondProduct: 0, rules: [] },
      problems: [],
    }).join('\n');
    expect(lines).toContain('p <0.0001');
  });

  it('counts a gold the engine refuses as unresolved rather than as a loss', async () => {
    const cases = [rewriteCase({ question: question({ SQL: 'select nope from items' }) })];
    const priced = await priceRewrites(
      cases,
      REWRITE_RULES,
      {
        execute: async (_db, sql) => (sql.includes('nope') ? { ok: false, rows: [] } : { ok: true, rows: [['cup']] }),
        judge: judgeOfficial,
        domain: async () => [],
      },
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

  it('refuses to price a grounding rule with no way to read a column', async () => {
    // A rule that needs domains and gets none is not a rule that loses: it is an instrument that
    // cannot see, and a zero there would close a real lever on a missing dependency.
    await expect(
      priceRewrites([rewriteCase()], REWRITE_RULES, { execute: async () => ({ ok: true, rows: [] }), judge: judgeOfficial }, () => undefined),
    ).rejects.toThrow(/no domain reader/);
  });

  it('does not price a statement the engine refused, and says how many it skipped', async () => {
    // Every rule would be rewriting text that never ran, and a rewrite that also fails to run
    // would be filed as a defect in the rule. The case stays in the denominator all the same.
    const base = rewriteCase();
    const priced = await priceRewrites(
      [base],
      [{ name: 'any', claim: '', apply: (input) => `${input.sql} ` }],
      { execute: async (_db, sql) => (sql === base.sql ? { ok: false, rows: [] } : { ok: true, rows: [['cup']] }), judge: judgeOfficial },
      () => undefined,
    );
    expect(priced).toMatchObject({ scored: 1, unrunnable: 1 });
    expect(priced.readings[0]).toMatchObject({ fired: 0, broken: 0 });
  });

  it('counts a case twice when two rules win it, and reports the overlap', async () => {
    // The sum of per-rule deltas is a product claim only if nothing overlapped, so the harness
    // computes the union and names the pairs rather than leaving the addition to the reader.
    //
    // Both rules declare themselves the product's, because the union is a claim about the pipeline
    // and not about arithmetic: a row that wins and is refused is not part of it.
    const one: RewriteRule = { name: 'one', claim: '', adoption: 'product', apply: (input) => `${input.sql} ` };
    const two: RewriteRule = { name: 'two', claim: '', adoption: 'product', apply: (input) => `${input.sql}  ` };
    const base = rewriteCase();
    const priced = await priceRewrites(
      [base],
      [one, two],
      {
        // The gold and both rewrites answer the question; the recorded statement does not.
        execute: async (_db, sql) => ({ ok: true, rows: sql === base.sql ? [['pen']] : [['cup']] }),
        judge: judgeOfficial,
      },
      () => undefined,
    );
    expect(priced.readings.map((reading) => reading.won)).toEqual([1, 1]);
    expect(priced.union).toBe(1);
    expect(priced.overlap).toEqual([{ left: 'one', right: 'two', cases: 1 }]);
    const text = rewriteLines({ split: 'dev', arm: 'a', scored: 1, recomputed: 0, declared: 0, agreed: 1, readings: priced.readings, union: priced.union, overlap: priced.overlap, ceiling: priced.ceiling, problems: [] }).join('\n');
    expect(text).toContain('overlap one & two: 1 case(s)');
    expect(text).toContain('union of wins across adopted rules: 1');
  });

  it('skips a rule that declines and a rule that proposes only the statement it was given', async () => {
    const base = rewriteCase();
    const declines: RewriteRule = { name: 'declines', claim: '', apply: () => undefined };
    const identity: RewriteRule = { name: 'identity', claim: '', apply: (input) => input.sql };
    const empty: RewriteRule = { name: 'empty', claim: '', apply: () => [] };
    const priced = await priceRewrites(
      [base],
      [declines, identity, empty],
      { execute: async () => ({ ok: true, rows: [['cup']] }), judge: judgeOfficial },
      () => undefined,
    );
    // Three ways of not acting, all of them the same reading: nothing fired.
    expect(priced.readings.map((reading) => reading.fired)).toEqual([0, 0, 0]);
  });

  it('carries the type lookup into the statement when the split supplies one', async () => {
    const base = rewriteCase({ sql: 'select a / b from t' });
    const seen: (string | undefined)[] = [];
    const spy: RewriteRule = {
      name: 'spy',
      claim: '',
      apply: (input) => {
        seen.push(input.typeOf?.('a'));
        return undefined;
      },
    };
    await priceRewrites(
      [base],
      [spy],
      { execute: async () => ({ ok: true, rows: [['cup']] }), judge: judgeOfficial },
      () => (name: string) => (name === 'a' ? 'INTEGER' : undefined),
    );
    expect(seen).toEqual(['INTEGER']);
  });

  it('counts a rewrite that fires and does not help as unchanged, not as a loss', async () => {
    const base = rewriteCase();
    const harmless: RewriteRule = { name: 'harmless', claim: '', apply: (input) => `${input.sql} ` };
    const priced = await priceRewrites(
      [base],
      [harmless],
      {
        // Three distinct answers: the gold's, the statement's, and the rewrite's. The rewrite is
        // neither right (a win) nor a regression from right (a loss) — it is a wrong answer that
        // stayed wrong, which is its own count.
        execute: async (_db, sql) => ({
          ok: true,
          rows: sql === base.sql ? [['cup']] : sql === base.question.SQL ? [['pen']] : [['lid']],
        }),
        judge: judgeOfficial,
      },
      () => undefined,
    );
    expect(priced.readings[0]).toMatchObject({ fired: 1, won: 0, lost: 0, unchangedWrong: 1, wonCases: [] });
  });

  it('keeps a ceiling out of the union, because a ceiling is not adopted', async () => {
    const ceiling: RewriteRule = { name: 'ceiling', claim: '', oracle: true, apply: (input) => `${input.sql} ` };
    const base = rewriteCase();
    const priced = await priceRewrites(
      [base],
      [ceiling],
      { execute: async (_db, sql) => ({ ok: true, rows: sql === base.sql ? [['pen']] : [['cup']] }), judge: judgeOfficial },
      () => undefined,
    );
    expect(priced.readings[0]?.won).toBe(1);
    expect(priced.union).toBe(0);
  });

  it('names the cases a ceiling won, so its reach over the buckets can be read at all', async () => {
    // The union must stay zero — a ceiling is not adopted — but the count alone cannot answer
    // "which bucket did this ceiling reach": the buckets are counted by the difference between two
    // statements and the wins by the shape of one, so the join needs the ids.
    const ceiling: RewriteRule = { name: 'ceiling', claim: '', oracle: true, apply: (input) => `${input.sql} ` };
    const base = rewriteCase();
    const priced = await priceRewrites(
      [base],
      [ceiling],
      { execute: async (_db, sql) => ({ ok: true, rows: sql === base.sql ? [['pen']] : [['cup']] }), judge: judgeOfficial },
      () => undefined,
    );
    expect(priced.readings[0]?.wonCases).toEqual([base.id]);
    expect(priced.union).toBe(0);
  });
});

/** One reading, with the verdict the test is about and nothing else filled in. */
function reading(overrides: Partial<RewriteReading> & { readonly rule: string }): RewriteReading {
  return {
    claim: '',
    oracle: false,
    adoption: 'product',
    fired: 0,
    won: 0,
    lost: 0,
    kept: 0,
    unchangedWrong: 0,
    wonCases: [],
    broken: 0,
    refused: 0,
    net: 0,
    mcnemar: 1,
    resolutionPp: 1,
    ...overrides,
  };
}

describe('rewriteProblems', () => {
  it('refuses a baseline that does not reproduce the score', () => {
    const problems = rewriteProblems({ split: 'dev', recomputed: 979, declared: 980, scored: 1532, readings: [] });
    expect(problems.join(' ')).toContain('the artifact claims 980');
  });

  it('refuses a rule that broke a statement', () => {
    const problems = rewriteProblems({
      split: 'dev',
      recomputed: 1,
      declared: 1,
      scored: 1,
      readings: [{ rule: 'x', claim: '', oracle: false, adoption: 'refused', reason: 'a reason', fired: 1, won: 0, lost: 0, kept: 0, unchangedWrong: 0, wonCases: [], broken: 2, refused: 0, net: 0, mcnemar: 1, resolutionPp: 1 }],
    });
    expect(problems.join(' ')).toContain('no longer run');
  });

  it('passes a report whose baseline reconciles', () => {
    expect(rewriteProblems({ split: 'dev', recomputed: 980, declared: 980, scored: 1532, readings: [] })).toEqual([]);
  });

  it('refuses a rule that was priced and never decided about', () => {
    // The state `drop-count-distinct` sat in for two rounds. A reading with no verdict is not a
    // rejection and it is not an adoption; it is a measurement nobody used, and the union used to
    // treat it as the pipeline's.
    const problems = rewriteProblems({
      split: 'dev',
      recomputed: 1,
      declared: 1,
      scored: 1,
      readings: [reading({ rule: 'undecided', adoption: 'unstated' })],
    });
    expect(problems.join(' ')).toContain('carries no verdict');
  });

  it('refuses a refusal that states no reason', () => {
    const problems = rewriteProblems({ split: 'dev', recomputed: 1, declared: 1, scored: 1, readings: [reading({ rule: 'quiet', adoption: 'refused', refusedOn: 'dev' })] });
    expect(problems.join(' ')).toContain('says no reason');
  });

  it('refuses a shipped rule that still carries a refusal reason', () => {
    // One of the two is stale, and a report that carries both is a report whose reader cannot tell
    // which one the code believes.
    const problems = rewriteProblems({
      split: 'dev',
      recomputed: 1,
      declared: 1,
      scored: 1,
      readings: [reading({ rule: 'stale', adoption: 'product', reason: 'refused in an earlier round' })],
    });
    expect(problems.join(' ')).toContain('one of the two is stale');
  });

  it('refuses a refusal that names no split, because its counts would belong to no corpus', () => {
    const problems = rewriteProblems({
      split: 'dev',
      recomputed: 1,
      declared: 1,
      scored: 1,
      readings: [reading({ rule: 'nowhere', adoption: 'refused', reason: 'a reason' })],
    });
    expect(problems.join(' ')).toContain('belong to no corpus');
  });

  it('refuses a refusal the split it was refused on now contradicts', () => {
    // A winning rule may only be refused when something that ships already collects its wins.
    const doubt: RewriteReading = reading({
      rule: 'too-good',
      adoption: 'refused',
      reason: 'it lost in an earlier round',
      refusedOn: 'dev',
      won: 9,
      lost: 1,
      net: 8,
      mcnemar: 0.011,
      wonCases: ['q1', 'q2'],
    });
    const problems = rewriteProblems({ split: 'dev', recomputed: 1, declared: 1, scored: 1, readings: [doubt] });
    expect(problems.join(' ')).toContain('and wins there');
    expect(problems.join(' ')).toContain('no shipped rule turns those cases');
  });

  it('allows a winning rule to be refused when a shipped rule already turns those cases', () => {
    // `ground-case-empty` is this row: it wins, and the gate it applies is a strict subset of the
    // edit the product ships, so refusing it gives up nothing. A check that reddened every refused
    // winner would fail on the one row it had a chance to check.
    const gated: RewriteReading = reading({ rule: 'gated', adoption: 'refused', reason: 'the gate costs it', refusedOn: 'dev', won: 3, lost: 0, net: 3, mcnemar: 0.02, wonCases: ['q1'] });
    const shipped: RewriteReading = reading({ rule: 'shipped', adoption: 'product', won: 4, lost: 0, net: 4, wonCases: ['q1', 'q2'] });
    expect(rewriteProblems({ split: 'dev', recomputed: 1, declared: 1, scored: 1, readings: [gated, shipped] })).toEqual([]);
  });

  it('does not call a Minidev artifact a contradiction of a refusal read on dev', () => {
    // The counts are the artifact's, not the refusal's. On another split the row is silent about
    // whether the refusal still holds, and a check that fired here would refuse every attempt to
    // price a rule on a corpus it was not refused on.
    const doubt: RewriteReading = reading({ rule: 'elsewhere', adoption: 'refused', reason: 'it lost on dev', refusedOn: 'dev', won: 9, lost: 1, net: 8, mcnemar: 0.011, wonCases: ['q1'] });
    expect(rewriteProblems({ split: 'minidev', recomputed: 1, declared: 1, scored: 1, readings: [doubt] })).toEqual([]);
  });
});

describe('the ceiling union', () => {
  // Two ceilings, one of which repairs everything the other does plus one more case. The union is
  // the number a plan needs — "with the gold statement in hand, how much of this corpus is even
  // about the mechanism" — and the sum of the rows is not it: 1 + 2 is a quantity no mechanism can
  // reach, and reading it as headroom is how a family gets two more rounds after it has closed.
  const seven: RewriteRule = {
    name: 'seven',
    claim: 'the one value',
    oracle: true,
    apply: () => "select name from items where score = 7",
  };
  const either: RewriteRule = {
    name: 'either',
    claim: 'either value',
    oracle: true,
    apply: () => ["select name from items where score = 7", "select name from items where score = 9"],
  };
  const nine: RewriteRule = {
    name: 'nine',
    claim: 'a rule that ships',
    adoption: 'product',
    apply: () => "select name from items where score = 9",
  };

  it('counts a case two ceilings both repair once, and subtracts what ships', async () => {
    const oracle = createOracle(resolve('eval/bird/oracle.py'), root);
    try {
      const cases = [
        rewriteCase({ id: 'a', question: question({ question_id: 1, SQL: 'select name from items where score = 7' }) }),
        rewriteCase({ id: 'b', question: question({ question_id: 2, SQL: 'select name from items where score = 9' }) }),
      ];
      const priced = await priceRewrites(
        cases,
        [seven, either, nine],
        { execute: (db, sql) => oracle.run(db, sql), judge: judgeOfficial },
        () => undefined,
      );
      // Rows: `seven` wins one, `either` wins two, `nine` ships one.
      expect(priced.readings.find((row) => row.rule === 'seven')?.won).toBe(1);
      expect(priced.readings.find((row) => row.rule === 'either')?.won).toBe(2);
      // The union is two, and so is the product's: `nine` repairs the case `either` also reaches.
      expect(priced.union).toBe(1);
      expect(priced.ceiling.cases).toBe(2);
      expect(priced.ceiling.beyondProduct).toBe(1);
      expect(priced.ceiling.rules).toEqual(['seven', 'either']);
    } finally {
      await oracle.close();
    }
  });

  it('is zero when no ceiling was priced, because a rule that reads no gold has no ceiling', async () => {
    const oracle = createOracle(resolve('eval/bird/oracle.py'), root);
    try {
      const priced = await priceRewrites(
        [rewriteCase()],
        [nine],
        { execute: (db, sql) => oracle.run(db, sql), judge: judgeOfficial },
        () => undefined,
      );
      expect(priced.ceiling).toEqual({ cases: 0, beyondProduct: 0, rules: [] });
    } finally {
      await oracle.close();
    }
  });

  it('prints the union with the subtraction, which is the only headroom a better engine could collect', () => {
    const text = rewriteLines({
      split: 'dev',
      arm: 'a',
      scored: 1532,
      recomputed: 1002,
      declared: 1002,
      agreed: 1532,
      readings: [{ rule: 'oracle-transplant', claim: 'a ceiling', oracle: true, adoption: 'ceiling', fired: 89, won: 25, lost: 0, kept: 0, unchangedWrong: 64, wonCases: [], broken: 0, refused: 0, net: 25, mcnemar: 0.0001, resolutionPp: 1 }],
      union: 18,
      overlap: [],
      ceiling: { cases: 41, beyondProduct: 23, rules: ['oracle-transplant', 'oracle-predicate'] },
      problems: [],
    }).join('\n');
    expect(text).toContain('ceiling union (oracle-transplant + oracle-predicate, gold in hand): 41 case(s)');
    expect(text).toContain('23 of them no shipped rule repairs');
    // And it is printed after the union it is read against, so the subtraction sits below the
    // number it subtracts from.
    expect(text.indexOf('union of wins across adopted rules')).toBeLessThan(text.indexOf('ceiling union'));
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
      readings: [{ rule: 'null-order', claim: 'a claim', oracle: false, adoption: 'product', fired: 80, won: 6, lost: 0, kept: 36, unchangedWrong: 38, wonCases: [], broken: 0, refused: 0, net: 6, mcnemar: 0.0313, resolutionPp: 0.4 }],
      union: 6,
      overlap: [],
      ceiling: { cases: 0, beyondProduct: 0, rules: [] },
      problems: [],
    });
    const text = lines.join('\n');
    expect(text).toContain('63.97%');
    expect(text).toContain('null-order');
    expect(text).toContain('a claim');
    expect(text).toContain('+0.39pp');
  });

  it('says which corpus a refusal was decided on, and whether these are its counts', () => {
    // The two sentences a reader needs to join a sentence to a column: a refusal read on the split
    // being priced owns the counts beside it, and one read elsewhere does not.
    const render = (split: string): string =>
      rewriteLines({
        split,
        arm: 'a',
        scored: 100,
        recomputed: 60,
        declared: 60,
        agreed: 100,
        readings: [reading({ rule: 'narrow', adoption: 'refused', reason: 'it loses', refusedOn: 'dev', won: 0, lost: 4 })],
        union: 0,
        overlap: [],
      ceiling: { cases: 0, beyondProduct: 0, rules: [] },
        problems: [],
      }).join('\n');
    expect(render('dev')).toContain('refused on dev, and these are that split\'s counts');
    expect(render('minidev')).toContain("refused on dev; the counts above are minidev's");
  });

  it('prints the refusals beside the defects, and nothing when there were none', () => {
    // A ceiling that could not splice prints how many it could not reach; a rule with no refusals
    // does not grow a column of zeroes that reads like a measurement.
    const withRefusals = rewriteLines({
      split: 'dev',
      arm: 'a',
      scored: 100,
      recomputed: 60,
      declared: 60,
      agreed: 100,
      readings: [{ rule: 'oracle-predicate', claim: 'a ceiling', oracle: true, adoption: 'ceiling', fired: 83, won: 20, lost: 0, kept: 0, unchangedWrong: 60, wonCases: [], broken: 0, refused: 3, net: 20, mcnemar: 0.0001, resolutionPp: 1 }],
      union: 0,
      overlap: [],
      ceiling: { cases: 0, beyondProduct: 0, rules: [] },
      problems: [],
    }).join('\n');
    expect(withRefusals).toMatch(/oracle-predicate\*\s+fired\s+83/);
    expect(withRefusals).toMatch(/refused\s+3/);
    const clean = rewriteLines({
      split: 'dev',
      arm: 'a',
      scored: 100,
      recomputed: 60,
      declared: 60,
      agreed: 100,
      readings: [{ rule: 'ground', claim: 'a rule', oracle: false, adoption: 'product', fired: 22, won: 14, lost: 0, kept: 0, unchangedWrong: 8, wonCases: [], broken: 0, refused: 0, net: 14, mcnemar: 0.0001, resolutionPp: 1 }],
      union: 14,
      overlap: [],
      ceiling: { cases: 0, beyondProduct: 0, rules: [] },
      problems: [],
    }).join('\n');
    expect(clean).not.toContain('refused');
  });

  it('separates a ceiling from the rules above it', () => {
    // The header is the point: a column of numbers under "oracle" that looked like the others is
    // how a ceiling gets read as a shipped rule.
    const lines = rewriteLines({
      split: 'dev',
      arm: 'a',
      scored: 100,
      recomputed: 60,
      declared: 60,
      agreed: 100,
      readings: [
        { rule: 'ground', claim: 'a rule', oracle: false, adoption: 'product', fired: 9, won: 3, lost: 0, kept: 0, unchangedWrong: 6, wonCases: [], broken: 0, refused: 0, net: 3, mcnemar: 0.25, resolutionPp: 1 },
        { rule: 'transplant', claim: 'a ceiling', oracle: true, adoption: 'ceiling', fired: 20, won: 9, lost: 0, kept: 0, unchangedWrong: 11, wonCases: [], broken: 0, refused: 0, net: 9, mcnemar: 0.004, resolutionPp: 1 },
      ],
      union: 3,
      overlap: [],
      ceiling: { cases: 0, beyondProduct: 0, rules: [] },
      problems: [],
    }).join('\n');
    expect(lines).toContain('-- ceilings: read the gold statement, cannot ship, exist to price a dispatch --');
    expect(lines).toMatch(/transplant\*\s+fired/);
    expect(lines).toMatch(/ground\s+fired/);
    expect(lines).not.toContain('union of wins');
  });

  it('says the deltas add up when two adopted rules repaired different cases', () => {
    const lines = rewriteLines({
      split: 'dev',
      arm: 'a',
      scored: 100,
      recomputed: 60,
      declared: 60,
      agreed: 100,
      readings: [
        { rule: 'one', claim: '', oracle: false, adoption: 'product', fired: 4, won: 2, lost: 0, kept: 0, unchangedWrong: 2, wonCases: [], broken: 0, refused: 0, net: 2, mcnemar: 0.5, resolutionPp: 1 },
        { rule: 'two', claim: '', oracle: false, adoption: 'product', fired: 4, won: 3, lost: 0, kept: 0, unchangedWrong: 1, wonCases: [], broken: 0, refused: 0, net: 3, mcnemar: 0.25, resolutionPp: 1 },
      ],
      union: 5,
      overlap: [],
      ceiling: { cases: 0, beyondProduct: 0, rules: [] },
      problems: [],
    }).join('\n');
    expect(lines).toContain('no two rules won the same case, so the deltas add');
    expect(lines).toContain('union of wins across adopted rules: 5 (+5.00pp)');
  });

  it('prints a refusal as a failure line', () => {
    const lines = rewriteLines({ split: 'dev', arm: 'a', scored: 1, recomputed: 0, declared: 1, agreed: 0, readings: [], union: 0, overlap: [], ceiling: { cases: 0, beyondProduct: 0, rules: [] }, problems: ['REWRITE: no'] });
    expect(lines.join('\n')).toContain('FAILED REWRITE: no');
  });
});

describe('resolveRewriteSettings', () => {
  it('reads the three flags', () => {
    expect(resolveRewriteSettings(['--artifact', 'a.json', '--arm', 'x', '--limit', '5'])).toEqual({ artifact: 'a.json', arm: 'x', oracle: false, limit: 5 });
  });

  it('prices the ceilings only when asked, because they cost executions', () => {
    expect(resolveRewriteSettings(['--artifact', 'a.json', '--arm', 'x'])?.oracle).toBe(false);
    expect(resolveRewriteSettings(['--artifact', 'a.json', '--arm', 'x', '--oracle']).oracle).toBe(true);
    expect(() => resolveRewriteSettings(['--artifact', 'a.json', '--arm', 'x', '--ceiling'])).toThrow(/unrecognized argument/);
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

  it('takes a path to write the per-case rows to, and writes nothing unless asked', () => {
    // The table this harness prints is a total. A ceiling's wins are counted by statement shape
    // and a bucket is counted by the difference between two statements, so the only way to ask
    // which bucket a ceiling reaches is to have both reports on disk.
    expect(resolveRewriteSettings(['--artifact', 'a.json', '--arm', 'x']).write).toBeUndefined();
    expect(resolveRewriteSettings(['--artifact', 'a.json', '--arm', 'x', '--write', 'out.json'])).toMatchObject({
      write: 'out.json',
    });
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

  it('prices the ceilings when asked, and reports an unrunnable statement when there is one', async () => {
    const base = layout();
    const artifact = join(base, 'artifact.json');
    writeFileSync(
      artifact,
      JSON.stringify({
        split: 'minidev',
        cases: [
          // The statement the engine refuses: counted, not scored by any rule.
          { id: '1', arm: 'a', passed: false, sql: 'select from' },
        ],
      }),
    );
    expect(await main(['--artifact', artifact, '--arm', 'a', '--oracle'], base, {})).toBe(0);
  });

  it('reads the column values it grounds against, through the same reader repair uses', async () => {
    // A statement that compares a literal is the case the domain closure exists for: without this
    // the harness would price every grounding rule against an empty column list and report zero.
    const base = layout();
    const artifact = join(base, 'artifact.json');
    writeFileSync(
      artifact,
      JSON.stringify({
        split: 'minidev',
        cases: [{ id: '1', arm: 'a', passed: false, sql: "select id from items where name = 'pen' and score = 1" }],
      }),
    );
    expect(await main(['--artifact', artifact, '--arm', 'a'], base, {})).toBe(0);
  });

  it('writes the per-case rows when asked to, so another instrument can join them', async () => {
    // Printing a total cannot be joined to anything: the buckets are counted by the difference
    // between two statements and a ceiling's wins by the shape of one, so the join only exists if
    // both reports are files.
    const base = layout();
    const artifact = join(base, 'artifact.json');
    writeFileSync(
      artifact,
      JSON.stringify({ split: 'minidev', cases: [{ id: '1', arm: 'a', passed: false, sql: "select id from items where name = 'pen'" }] }),
    );
    const out = join(base, 'rewrite.json');
    expect(await main(['--artifact', artifact, '--arm', 'a', '--write', out], base, {})).toBe(0);
    const written = JSON.parse(readFileSync(out, 'utf8')) as { arm: string; readings: { rule: string; fired: number }[] };
    expect(written.arm).toBe('a');
    expect(written.readings.length).toBeGreaterThan(0);
    expect(written.readings[0]).toHaveProperty('fired');
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

describe('the rule the pipeline ships, priced as itself', () => {
  const at = (sql: string, extra: Partial<RewriteInput> = {}): RewriteInput => ({
    question: '',
    sql,
    domains: [{ table: 'items', column: 'name', values: ['Cup', 'Lid'] }],
    empty: false,
    goldSql: '',
    passed: false,
    ...extra,
  });

  it('is the product function, not a second implementation of the same idea', () => {
    // The offline table this rule prints is the number the arm is dispatched to reproduce, so it
    // has to run `applyGrounding` and nothing else. The `in` list is the case the two scanners
    // could disagree about: the eval scanner reads `like` and `between` too, the product one does
    // not, and a difference between them here would be a difference between the claim and the code.
    expect(ruleOf('ground-shipped').apply(at("select id from items where name in ('cup', 'lid')"))).toBe(
      "select id from items where name in ('Cup', 'Lid')",
    );
  });

  it('does not fire on a pattern, because the product scanner does not read one', () => {
    expect(ruleOf('ground-shipped').apply(at("select id from items where name like 'cup'"))).toBeUndefined();
  });

  it('cannot fire without domains, and says so by returning nothing', () => {
    expect(ruleOf('ground-shipped').apply(at("select id from items where name = 'cup'", { domains: [] }))).toBeUndefined();
  });

  it('unions two tables that store the same column, as the harness reader does', () => {
    const both = at("select id from items i join lids l on l.id = i.id where name = 'cup'", {
      domains: [
        { table: 'items', column: 'name', values: ['Cup'] },
        { table: 'lids', column: 'name', values: ['Lid'] },
      ],
    });
    expect(ruleOf('ground-shipped').apply(both)).toBe("select id from items i join lids l on l.id = i.id where name = 'Cup'");
  });

  it('leaves a statement whose value is already the stored spelling alone', () => {
    expect(ruleOf('ground-shipped').apply(at("select id from items where name = 'Cup'"))).toBeUndefined();
  });
});

describe('the entry point', () => {
  it('is executable as a script, and refuses a dispatch that names no artifact', () => {
    // The guard is only exercised by a real child process: imported, `import.meta.url` is never the
    // entry, so every other test in this file leaves that branch dark. A guard that never fires is a
    // CLI nobody has run, and this one is what `bench:bird:rewrite` invokes.
    const cwd = resolve(import.meta.dirname, '..');
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(cwd, 'eval/bird/rewrite.ts')], { cwd, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--artifact is required');
  });
});

describe('the verdict a rule carries', () => {
  const rule = (name: string): RewriteRule => {
    const found = REWRITE_RULES.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`no rule ${name}`);
    return found;
  };

  it('decides about every rule it prices', () => {
    // A rule with a reading and no verdict is a measurement nobody used, which is the state
    // `drop-count-distinct` sat in for two rounds: 33 won against 18 lost, priced every round, and
    // the report's union counted its repairs as part of what the pipeline would recover.
    for (const priced of REWRITE_RULES) {
      expect(priced.adoption, `${priced.name} has no verdict`).toBeDefined();
      if (priced.adoption === 'product') expect(priced.reason, `${priced.name} ships and refuses`).toBeUndefined();
      else expect(priced.reason, `${priced.name} is ${String(priced.adoption)} and says no reason`).toBeTruthy();
    }
  });

  it('refuses every rule that names the split it was refused on', () => {
    // The counts a refusal is decided by belong to a corpus, and the columns printed beside the
    // sentence belong to whichever corpus the harness was pointed at. Naming the split is the only
    // thing that joins them — three of these sentences read "on dev" while the harness was pricing
    // Mini-Dev, and nothing failed.
    for (const priced of REWRITE_RULES) {
      if (priced.adoption !== 'refused') continue;
      expect(priced.refusedOn, `${priced.name} is refused and names no split`).toBeDefined();
    }
    expect(rule('drop-count-distinct').refusedOn).toBe('dev');
  });

  it('keeps the counts out of the sentence, because a number in prose has no reader', () => {
    // Every refusal quoted its own counts for three rounds and every one of them was stale by the
    // time a dev artifact priced it: 35 fired became 28, 17 became 10, 119 became 121. The report
    // prints the counts this run took; the sentence carries only the argument, and the corpus is
    // `refusedOn`'s job — a SQL fragment like `* 1.0` is code, not a count.
    const countsInProse = /\b\d+\b\s*(?:fired|won|lost)\b|\b(?:fired|won|lost|repairs?|cases?)\b[^.;]{0,16}\b\d+\b/i;
    for (const priced of REWRITE_RULES) {
      if (priced.reason === undefined) continue;
      expect(countsInProse.test(priced.reason), `${priced.name} quotes counts in its reason`).toBe(false);
      expect(/\b(?:minidev|dev)\b/i.test(priced.reason), `${priced.name} names a split in its reason`).toBe(false);
    }
  });

  it('agrees with the product about which edits the pipeline applies', () => {
    // The gate that makes "shipped" a fact about two files rather than a sentence in a commit
    // message. It is empty on the real table, and each way it can disagree is driven below.
    expect(ledgerProblems(REWRITE_RULES)).toEqual([]);
    expect(REWRITE_RULES.filter((entry) => entry.adoption === 'product').map((entry) => entry.name)).toEqual([
      'null-order',
      'drop-unordered-limit',
      'ground-shipped',
    ]);
  });

  it('refuses a table whose product row the ledger does not enable', () => {
    const missing = REWRITE_RULES.filter((entry) => entry.name !== 'null-order');
    expect(ledgerProblems(missing).join(' ')).toContain('enables drop-unordered-limit, ground-shipped, null-order');
  });

  it('refuses a table that ships nothing at all, and names both sides', () => {
    // The empty side is worth a test because it is the one where a message that joined an empty list
    // would read as a sentence with a hole in it: `marks  as the product's`.
    expect(ledgerProblems([]).join(' ')).toContain("marks nothing as the product's and the ledger enables drop-unordered-limit, ground-shipped, null-order");
  });

  it('refuses a table that ships an edit the ledger has never heard of', () => {
    const extra: RewriteRule = { name: 'invented', claim: '', adoption: 'product', apply: () => undefined };
    expect(ledgerProblems([...REWRITE_RULES, extra]).join(' ')).toContain('marks drop-unordered-limit, ground-shipped, invented, null-order');
  });
});

describe('why a count cannot be conditioned on the data', () => {
  /**
   * The premise of `drop-count-distinct`'s refusal, run rather than argued.
   *
   * The rule loses 18 of 1,532 dev questions because removing `distinct` can only over-count when a
   * statement's rows repeat — a join that multiplies a parent row, a column that is not unique. And
   * it wins 33 for the same reason: the gold counts plain rows over a join the statement invented.
   * Both readings therefore live in the same place, which is why every condition the database can
   * express selects the cases where the edit is a no-op.
   *
   * Two tables below are the whole proof. `multiplied` repeats its rows, so the two counts differ
   * and the edit changes the answer — a condition that admits it admits a win and a loss
   * indistinguishably. `unique` does not repeat them, so the counts agree and the edit changes
   * nothing at all.
   */
  const count = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { c: number }).c);

  it('changes the answer exactly when the rows repeat', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('create table multiplied (id integer, kind text)');
    db.exec("insert into multiplied values (1, 'a'), (1, 'b'), (2, 'b')");
    expect(count(db, 'select count(distinct id) as c from multiplied')).toBe(2);
    expect(count(db, 'select count(id) as c from multiplied')).toBe(3);
    db.close();
  });

  it('changes nothing when they do not, which is the only condition the data can express', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('create table unique_rows (id integer primary key)');
    db.exec('insert into unique_rows values (1), (2)');
    // Equal counts are what "drop the distinct only when it does not change the count" would test
    // for, and on this table the edit returns the identical number — so the condition is satisfied
    // precisely where the rule has nothing to give.
    expect(count(db, 'select count(distinct id) as c from unique_rows')).toBe(
      count(db, 'select count(id) as c from unique_rows'),
    );
    db.close();
  });
});

describe('the union is the pipeline, not the arithmetic', () => {
  it('leaves out a refused rule that won its case', async () => {
    // The defect this replaced: the union was computed over `net > 0`, so a rule that won and was
    // refused for breaking others contributed its repairs to the number a product claim quotes.
    const winner: RewriteRule = { name: 'winner', claim: '', adoption: 'product', apply: (input) => `${input.sql} ` };
    const refused: RewriteRule = {
      name: 'refused',
      claim: '',
      adoption: 'refused',
      reason: 'wins and breaks in equal measure',
      apply: (input) => `${input.sql}  `,
    };
    const base = rewriteCase();
    const priced = await priceRewrites(
      [base],
      [winner, refused],
      { execute: async (_db, sql) => ({ ok: true, rows: sql === base.sql ? [['pen']] : [['cup']] }), judge: judgeOfficial },
      () => undefined,
    );
    expect(priced.readings.map((reading) => reading.won)).toEqual([1, 1]);
    expect(priced.union).toBe(1);
    expect(priced.overlap).toEqual([]);
  });
});
