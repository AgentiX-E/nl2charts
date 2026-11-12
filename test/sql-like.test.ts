import { describe, expect, it } from 'vitest';
import { buildSqlPrompt } from '../packages/ai/src/pipeline.js';
import { SQL_LIKE_RULES, parseSqlLike, renderSqlLike } from '../packages/ai/src/sql-like.js';
import { renderDemonstrationBlocks } from '../eval/bird/retrieval.js';

describe('the steps a statement records', () => {
  it('reads a projection as an intent, and a column list as rows', () => {
    expect(parseSqlLike('SELECT count(*) FROM orders')?.intent).toBe('count');
    expect(parseSqlLike('SELECT sum(amount) FROM orders')?.intent).toBe('sum');
    expect(parseSqlLike('SELECT region FROM orders')?.intent).toBe('rows');
    // `count(distinct x)` opens with the aggregate, which is what the intent is a claim about.
    expect(parseSqlLike('SELECT COUNT(DISTINCT customer_id) FROM orders')?.intent).toBe('count');
  });

  it('keeps tables without their aliases, and does not repeat one named twice', () => {
    const parsed = parseSqlLike('SELECT * FROM orders o');
    expect(parsed?.tables).toEqual(['orders']);
    expect(parseSqlLike('SELECT * FROM orders o, orders x')?.tables).toEqual(['orders']);
  });

  it('lifts an equality between two columns into joins, from ON or from WHERE', () => {
    const explicit = parseSqlLike(
      'SELECT c.region FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.status = ?',
    );
    expect(explicit?.tables).toEqual(['orders', 'customers']);
    expect(explicit?.joins).toEqual(['o.customer_id = c.id']);
    expect(explicit?.filters).toEqual(['o.status = ?']);

    // The implicit form: a comma-joined pair whose condition is written in WHERE.
    const implicit = parseSqlLike('SELECT c.region FROM orders o, customers c WHERE o.customer_id = c.id');
    expect(implicit?.tables).toEqual(['orders', 'customers']);
    expect(implicit?.joins).toEqual(['o.customer_id = c.id']);
    expect(implicit?.filters).toEqual([]);
  });

  it('keeps a disjunction whole rather than counting it as two conditions', () => {
    const parsed = parseSqlLike("SELECT * FROM t WHERE a = 1 AND (b = 2 OR b = 3) AND c = 'x'");
    expect(parsed?.filters).toEqual(['a = 1', '(b = 2 OR b = 3)', "c = 'x'"]);
  });

  it('does not split on and inside a literal, a quoted identifier or a call', () => {
    expect(parseSqlLike("SELECT * FROM t WHERE name = 'soft and hard'")?.filters).toEqual([
      "name = 'soft and hard'",
    ]);
    expect(parseSqlLike('SELECT * FROM t WHERE round(x, 2) = 1 AND y = 2')?.filters).toEqual([
      'round(x, 2) = 1',
      'y = 2',
    ]);
    expect(parseSqlLike('SELECT * FROM t WHERE "and" = 1')?.filters).toEqual(['"and" = 1']);
  });

  it('reads group, having, order and limit as their own steps', () => {
    const parsed = parseSqlLike(
      'SELECT c.region, count(*) FROM orders o JOIN customers c ON o.customer_id = c.id ' +
        'WHERE o.status = ? GROUP BY c.region HAVING count(*) > 3 ORDER BY count(*) DESC LIMIT 3',
    );
    expect(parsed?.group).toEqual(['c.region']);
    expect(parsed?.having).toEqual(['count(*) > 3']);
    expect(parsed?.order).toEqual(['count(*) DESC']);
    expect(parsed?.limit).toBe('3');
  });

  it('reads a chunk that starts at the keyword, which is what a doubled space leaves behind', () => {
    // `FROM  JOIN b` splits into an empty first chunk; the table still arrives from the second.
    expect(parseSqlLike('SELECT * FROM  JOIN b')?.tables).toEqual(['b']);
  });

  it('lets a join condition span several predicates', () => {
    const parsed = parseSqlLike('SELECT * FROM a JOIN b ON a.x = b.x AND a.y = b.y WHERE a.z > 1');
    expect(parsed?.joins).toEqual(['a.x = b.x AND a.y = b.y']);
    expect(parsed?.filters).toEqual(['a.z > 1']);
  });

  it('normalises whitespace before reading, so a line-wrapped statement reads the same', () => {
    const wrapped = parseSqlLike('SELECT   count(*)\n  FROM   orders\n  WHERE  a = 1');
    expect(wrapped).toEqual(parseSqlLike('SELECT count(*) FROM orders WHERE a = 1'));
  });
});

describe('the shapes the reader refuses', () => {
  it('refuses anything that is not a single select', () => {
    expect(parseSqlLike('')).toBeUndefined();
    expect(parseSqlLike('   ')).toBeUndefined();
    expect(parseSqlLike('DELETE FROM orders')).toBeUndefined();
    expect(parseSqlLike('INSERT INTO t VALUES (1)')).toBeUndefined();
    expect(parseSqlLike('UPDATE t SET a = 1')).toBeUndefined();
  });

  it('refuses a set operation, a CTE and a subquery', () => {
    expect(parseSqlLike('SELECT a FROM t UNION SELECT a FROM u')).toBeUndefined();
    expect(parseSqlLike('SELECT a FROM t INTERSECT SELECT a FROM u')).toBeUndefined();
    expect(parseSqlLike('SELECT a FROM t EXCEPT SELECT a FROM u')).toBeUndefined();
    expect(parseSqlLike('WITH x AS (SELECT 1) SELECT * FROM x')).toBeUndefined();
    expect(parseSqlLike('SELECT * FROM t WHERE a IN (SELECT a FROM u)')).toBeUndefined();
  });

  it('refuses a window function, whose own order is not the query order', () => {
    expect(
      parseSqlLike('SELECT region, rank() OVER (ORDER BY total DESC) FROM t'),
    ).toBeUndefined();
  });

  it('refuses a source that is not a table name, which is what a stray keyword leaves behind', () => {
    expect(parseSqlLike('SELECT * FROM 123')).toBeUndefined();
    expect(parseSqlLike('SELECT * FROM "orders"')).toBeUndefined();
  });

  it('reads a doubled quote as an escaped one, so the literal does not end inside itself', () => {
    expect(parseSqlLike("SELECT * FROM t WHERE name = 'it''s and x' AND y = 2")?.filters).toEqual([
      "name = 'it''s and x'",
      'y = 2',
    ]);
  });

  it('keeps a comparison other than equality as a filter, because it relates no two columns', () => {
    expect(parseSqlLike('SELECT * FROM a JOIN b ON a.x = b.x WHERE a.y >= 1')?.filters).toEqual(['a.y >= 1']);
    expect(parseSqlLike('SELECT * FROM a JOIN b ON a.x = b.x WHERE a.y = b.y')?.joins).toEqual([
      'a.x = b.x',
      'a.y = b.y',
    ]);
  });

  it('refuses a statement with no projection or no source', () => {
    expect(parseSqlLike('SELECT 1')).toBeUndefined();
    expect(parseSqlLike('SELECT a FROM')).toBeUndefined();
    expect(parseSqlLike('SELECT FROM t')).toBeUndefined();
  });
});

describe('the block a demonstration carries', () => {
  it('writes one line per clause the statement has', () => {
    expect(renderSqlLike('SELECT count(*) FROM orders WHERE status = ?')).toBe(
      ['Intent: count', 'Tables: orders', 'Filters: status = ?'].join('\n'),
    );
  });

  it('omits the lines the statement has no clause for', () => {
    const rendered = renderSqlLike('SELECT a FROM t') ?? '';
    expect(rendered.split('\n')).toEqual(['Intent: rows', 'Tables: t']);
  });

  it('writes the join and the filter on separate lines, which is the distinction it exists for', () => {
    const rendered = renderSqlLike('SELECT * FROM a JOIN b ON a.x = b.x WHERE a.y = 1 ORDER BY a.y LIMIT 2') ?? '';
    expect(rendered.split('\n')).toEqual([
      'Intent: rows',
      'Tables: a, b',
      'Joins: a.x = b.x',
      'Filters: a.y = 1',
      'Order: a.y',
      'Limit: 2',
    ]);
  });

  it('refuses in the same places the reader does, rather than rendering a partial block', () => {
    expect(renderSqlLike('SELECT * FROM t WHERE a IN (SELECT a FROM u)')).toBeUndefined();
    expect(renderSqlLike('not sql')).toBeUndefined();
  });
});

describe('the instruction the model reads', () => {
  it('names every step the renderer emits, so an example and an instruction cannot disagree', () => {
    const rendered = renderSqlLike('SELECT count(*) FROM a JOIN b ON a.x = b.x WHERE a.y = 1 GROUP BY a.z HAVING count(*) > 1 ORDER BY a.z LIMIT 1') ?? '';
    const labels = rendered
      .split('\n')
      .map((line) => line.split(':')[0] as string)
      .filter((label) => label !== 'Tables' || true);
    for (const label of labels) {
      expect(SQL_LIKE_RULES.some((rule) => rule.startsWith(`${label}:`))).toBe(true);
    }
  });

  it('says the notes are not executed, because a reader that treats them as statements fails the guard', () => {
    expect(SQL_LIKE_RULES.join('\n')).toMatch(/not executed/i);
  });

  it('asks for every condition before deciding how to combine them', () => {
    expect(SQL_LIKE_RULES.join('\n')).toMatch(/every condition the question states/i);
  });
});

const SCHEMA = [{ table: 'orders', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'status', type: 'TEXT' }] }];

describe('the reasoning shape in the prompt', () => {
  it('replaces the one-statement rule rather than adding a second one beside it', () => {
    const plain = buildSqlPrompt('how many orders', SCHEMA, false);
    const shaped = buildSqlPrompt('how many orders', SCHEMA, { reasoning: 'sql-like' });
    expect(plain).toContain('one statement, no comments');
    expect(shaped).not.toContain('one statement, no comments');
    expect(shaped).toContain('working notes and are not executed');
  });

  it('puts the format instruction after every other rule, and before the schema', () => {
    // A note about window functions appended after the shape instruction reads as the ending,
    // and the model follows the ending. The rule list is the only place this ordering is
    // decided, so it is the only place a test can hold it.
    const shaped = buildSqlPrompt('how many orders', SCHEMA, {
      reasoning: 'sql-like',
      dialect: 'SQLite',
      notes: ['Use a window function when the question names a rank.'],
    });
    const at = shaped.indexOf('Then write the statement');
    expect(at).toBeGreaterThan(shaped.indexOf('Write SQLite SQL'));
    expect(at).toBeGreaterThan(shaped.indexOf('window function'));
    expect(at).toBeLessThan(shaped.indexOf('Schema:'));
  });

  it('says nothing about steps when the switch is off', () => {
    expect(buildSqlPrompt('how many orders', SCHEMA, false)).not.toContain('Intent:');
    expect(buildSqlPrompt('how many orders', SCHEMA, { decompose: true })).not.toContain('Intent: rows|count');
  });
});

describe('a demonstration that carries its steps', () => {
  const hits = [
    {
      question: 'How many orders are refunded?',
      evidence: 'A refunded order has status refunded.',
      score: 2,
      sql: 'SELECT count(*) FROM orders WHERE status = ?',
    },
    {
      question: 'Which region has the most customers?',
      evidence: '',
      score: 1,
      sql: 'SELECT region FROM customers GROUP BY region ORDER BY count(*) DESC LIMIT 1',
    },
  ];

  it('writes the steps between the evidence and the statement, which is where a reader looks', () => {
    const [block] = renderDemonstrationBlocks(hits, { reasoning: renderSqlLike });
    expect(block?.split('\n')).toEqual([
      'Question: How many orders are refunded?',
      'Evidence: A refunded order has status refunded.',
      'Reasoning:',
      'Intent: count',
      'Tables: orders',
      'Filters: status = ?',
      'SQL: SELECT count(*) FROM orders WHERE status = ?',
    ]);
  });

  it('skips the neighbour whose statement it cannot decompose rather than rendering half a block', () => {
    const blocks = renderDemonstrationBlocks(hits, { reasoning: (sql) => (sql.includes('GROUP BY') ? undefined : renderSqlLike(sql)) });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('How many orders are refunded?');
  });

  it('returns nothing when every neighbour was skipped, so the arm cannot send its parent prompt', () => {
    expect(renderDemonstrationBlocks(hits, { reasoning: () => undefined })).toEqual([]);
  });

  it('renders the plain block when no reader is supplied', () => {
    const [block] = renderDemonstrationBlocks(hits);
    expect(block).not.toContain('Reasoning:');
    expect(block).toContain('SQL: SELECT count(*) FROM orders WHERE status = ?');
  });

  it('reads the steps from the statement as written, not from the masked one', () => {
    const [block] = renderDemonstrationBlocks(hits, {
      statement: () => 'SELECT count(*) FROM t1 WHERE c1 = ?',
      reasoning: renderSqlLike,
    });
    expect(block).toContain('Tables: orders');
    expect(block).toContain('SQL: SELECT count(*) FROM t1 WHERE c1 = ?');
  });
});
