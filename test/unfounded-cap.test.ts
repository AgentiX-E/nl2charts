/**
 * The cap that cannot justify itself, pinned in the five ways it must decline and the one it must fire.
 *
 * The rule this file covers is the only shipped rewrite in the package that removes text from a
 * statement, so every refusal is a case the gross form of the same edit used to break. The tests are
 * therefore written as the boundary: a cap that ranks, a cap a question asked for, a cap of zero, a
 * cap with an offset, a cap inside a subquery, and a cap written as an expression. Everything else
 * fires, and the shape of the statement survives the edit.
 */
import { describe, expect, it } from 'vitest';
import { asksForRanking, clauseAt, createPipeline, stripUnfoundedCap } from '../packages/ai/src/index.js';
import type { LlmProvider, SchemaTable } from '../packages/ai/src/index.js';

const ASK = 'which items are there';

describe('stripUnfoundedCap', () => {
  it('removes a cap on an unordered statement that answers a question naming no rank', () => {
    expect(stripUnfoundedCap('select id from items limit 3', ASK)).toEqual({ sql: 'select id from items', cap: '3' });
  });

  it('keeps the statement terminator, which belongs to the statement and not to the cap', () => {
    expect(stripUnfoundedCap('select id from items limit 3;', ASK)?.sql).toBe('select id from items;');
  });

  it('gives back nothing but whitespace where the cap was', () => {
    // The diff has one reason in it: the clause that was removed. A rewrite that also re-spaced the
    // statement would be a rewrite a reviewer has to read twice.
    expect(stripUnfoundedCap('select  id  from items\n  limit 3', ASK)?.sql).toBe('select  id  from items');
  });

  it('declines on a statement that ranks its rows, because the cap is the answer', () => {
    expect(stripUnfoundedCap('select id from items order by id desc limit 3', ASK)).toBeUndefined();
  });

  it('declines when the question itself asks for a ranked subset', () => {
    // The case the shipped rule lost a point on before this condition existed: a question that
    // wanted three rows, a statement that said `limit 3` without ordering it, and a gold that says
    // the same. The cap is what made the statement right.
    expect(stripUnfoundedCap('select id from items limit 3', 'What are the top 3 items by price?')).toBeUndefined();
    expect(stripUnfoundedCap('select id from items limit 3', 'Which item has the highest price?')).toBeUndefined();
  });

  it('declines on a cap of zero, which asks for a result\'s columns and none of its rows', () => {
    expect(stripUnfoundedCap('select id from items limit 0', ASK)).toBeUndefined();
  });

  it('declines on a cap with an offset, which is a second positional claim on the same relation', () => {
    expect(stripUnfoundedCap('select id from items limit 3 offset 1', ASK)).toBeUndefined();
  });

  it('declines on a cap written as an expression, which it would have to evaluate', () => {
    expect(stripUnfoundedCap('select id from items limit 1 + 2', ASK)).toBeUndefined();
  });

  it('declines on a cap inside a subquery, which is how a top-N per group is written', () => {
    expect(stripUnfoundedCap('select id from (select id from items limit 2) d', ASK)).toBeUndefined();
  });

  it('declines on a statement with no cap at all', () => {
    expect(stripUnfoundedCap('select id from items', ASK)).toBeUndefined();
  });

  it('reads a word inside a literal as text', () => {
    // `'order by'` is a value; a scanner that read it as a clause would refuse to strip a cap that
    // has nothing to do with it — and, worse, would one day agree with a statement it should not.
    expect(stripUnfoundedCap("select id from items where name = 'order by' limit 2", ASK)?.sql).toBe(
      "select id from items where name = 'order by'",
    );
    expect(stripUnfoundedCap("select id from items where note = 'limit 3'", ASK)).toBeUndefined();
  });

  it('reads the clause a joined subquery orders as that subquery\'s', () => {
    expect(stripUnfoundedCap('select d.id from (select id from items order by price limit 2) d limit 5', ASK)?.sql).toBe(
      'select d.id from (select id from items order by price limit 2) d',
    );
  });

  it('declines when the statement continues after the cap', () => {
    // A `union` after a cap is a cap on one branch, and removing it would change a different
    // statement from the one this rule read.
    expect(stripUnfoundedCap('select id from items limit 3 union select id from items', ASK)?.sql).toBe(
      'select id from items union select id from items',
    );
  });
});

describe('asksForRanking', () => {
  it('names the words that rank a subset', () => {
    for (const question of ['What are the top 3 items?', 'Which item has the most orders?', 'What is the highest price?', 'Who placed the first order?', 'Which is the only item?']) {
      expect([question, asksForRanking(question)]).toEqual([question, true]);
    }
  });

  it('says no to a question that asks for every row that matches', () => {
    for (const question of ['What are the ids of the items?', 'How many orders were placed in 2013?', 'List the names of the singers.']) {
      expect([question, asksForRanking(question)]).toEqual([question, false]);
    }
  });

  it('is wrong in the safe direction on "at least"', () => {
    // "at least" contains `least`, and reading it as a ranking makes the rule decline. That costs a
    // repair it could have made; the other direction would let it remove a cap the question asked
    // for, which is the only way the rule can cost a credited case.
    expect(asksForRanking('How many orders had at least three units?')).toBe(true);
  });
});

describe('clauseAt', () => {
  it('finds a word at depth zero and reports where it ends', () => {
    const sql = 'select a from t limit 2';
    expect(sql.slice(0, clauseAt(sql, 'limit'))).toBe('select a from t limit');
  });

  it('ignores the same word inside parentheses and inside literals', () => {
    expect(clauseAt('select (select 1 limit 1) from t', 'limit')).toBeUndefined();
    expect(clauseAt("select 'limit' from t", 'limit')).toBeUndefined();
  });

  it('needs a word boundary, so a longer word is not a match', () => {
    expect(clauseAt('select limited from t', 'limit')).toBeUndefined();
  });

  it('searches from an offset without re-reading what came before it', () => {
    const sql = 'select a from t limit 1 offset 2';
    // The index is past the word, which is what a caller splicing a clause wants; the caller that
    // needs the word's own start subtracts its length.
    expect(sql.slice((clauseAt(sql, 'offset', clauseAt(sql, 'limit') ?? 0) ?? 0) - 'offset'.length)).toBe('offset 2');
  });
});

const schema: readonly SchemaTable[] = [{ table: 'items', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'price', type: 'REAL' }] }];

function provider(reply: string): LlmProvider {
  return { id: 'test', model: 'test-model', async complete() { return { text: reply, model: 'test-model' }; } };
}

describe('the pipeline runs the rule, and says so', () => {
  it('executes the statement without a cap the question did not ask for', async () => {
    const seen: string[] = [];
    const pipeline = createPipeline({
      provider: provider('SELECT id FROM items LIMIT 3'),
      execute: async (sql: string) => {
        seen.push(sql);
        return { rows: 4 };
      },
    });
    const result = await pipeline.ask({ question: 'which items are there', schema });
    expect(seen).toEqual(['SELECT id FROM items']);
    expect(result.sql).toBe('SELECT id FROM items');
    // The clause the model wrote is reported, so an artifact can tell a rule that fired from one
    // that had nothing to do — the same reason `grounding` reports its own counts.
    expect(result.capStripped).toBe('3');
  });

  it('leaves a ranked cap alone and reports nothing', async () => {
    const pipeline = createPipeline({ provider: provider('SELECT id FROM items ORDER BY price DESC LIMIT 1') });
    const result = await pipeline.ask({ question: 'which item is the cheapest', schema });
    expect(result.sql).toBe('SELECT id FROM items ORDER BY price DESC LIMIT 1');
    expect(result.capStripped).toBeUndefined();
  });

  it('leaves a cap the question asked for alone', async () => {
    const pipeline = createPipeline({ provider: provider('SELECT id FROM items LIMIT 3') });
    const result = await pipeline.ask({ question: 'what are the top 3 items by price', schema });
    expect(result.sql).toBe('SELECT id FROM items LIMIT 3');
    expect(result.capStripped).toBeUndefined();
  });
});
