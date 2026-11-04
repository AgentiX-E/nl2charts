import { describe, expect, it } from 'vitest';
import {
  INTENT_FUNCTIONS,
  INTENT_OPERATORS,
  compileIntent,
  parseQueryIntent,
  renderIntent,
  renderIntentExpression,
} from '../src/semantic/index.js';

/**
 * The intent renderer is the one piece of this repository that decides what a model is *allowed*
 * to say. Every test here is therefore either a sentence about the output (does this intent become
 * this statement) or a sentence about a refusal (does this reply get a name instead of a silently
 * different query).
 *
 * Two properties are load-bearing and are tested as properties rather than examples: the output is
 * a function of the intent alone (same in, same text out, no ordering surprises), and nothing that
 * is not an identifier can reach the statement.
 */

const MINIMAL = { from: 'orders', select: [{ expr: 'count(*)' }] };

describe('an intent becomes the statement it describes', () => {
  it('renders the smallest intent a question can need', () => {
    expect(renderIntent(MINIMAL)).toBe('SELECT count(*) FROM orders');
  });

  it('renders every clause in the order SQL requires, not the order the object had', () => {
    const sql = renderIntent({
      limit: 10,
      orderBy: [{ expr: 'n', direction: 'desc' }],
      having: [{ column: 'n', op: '>', value: 1 }],
      groupBy: ['c.name'],
      where: [{ column: 'o.total', op: '>=', value: 100 }],
      select: [{ expr: 'c.name', alias: 'name' }, { expr: 'count(*)', alias: 'n' }],
      joins: [{ table: 'customers', alias: 'c', on: [{ left: 'o.customer_id', right: 'c.id' }] }],
      alias: 'o',
      from: 'orders',
    });
    expect(sql).toBe(
      "SELECT c.name AS name, count(*) AS n FROM orders o INNER JOIN customers c ON o.customer_id = c.id WHERE o.total >= 100 GROUP BY c.name HAVING n > 1 ORDER BY n DESC LIMIT 10",
    );
  });

  it('keeps a left join a left join, because which side may be empty is the question', () => {
    const sql = renderIntent({
      from: 'a',
      joins: [{ table: 'b', type: 'left', on: [{ left: 'a.id', right: 'b.a_id' }] }],
      select: [{ expr: 'count(distinct b.id)' }],
    });
    expect(sql).toContain('LEFT JOIN b ON a.id = b.a_id');
  });

  it('joins on every pair it was given, and renders distinct once per call', () => {
    const sql = renderIntent({
      from: 'a',
      joins: [{ table: 'b', on: [{ left: 'a.x', right: 'b.x' }, { left: 'a.y', right: 'b.y' }] }],
      select: [{ expr: 'sum(distinct b.v)' }, { expr: 'avg(a.v)' }],
      distinct: true,
    });
    expect(sql).toBe('SELECT DISTINCT sum(distinct b.v), avg(a.v) FROM a INNER JOIN b ON a.x = b.x AND a.y = b.y');
  });

  it('renders a select of everything, which is a shape and not a wildcard bug', () => {
    expect(renderIntent({ from: 't', select: [{ expr: '*' }] })).toBe('SELECT * FROM t');
  });

  it('carries a limit of zero, which is a statement about the result and not an absent field', () => {
    expect(renderIntent({ ...MINIMAL, limit: 0 })).toBe('SELECT count(*) FROM orders LIMIT 0');
  });

  it('is a function of the intent alone: key order cannot change the statement', () => {
    const left = renderIntent({ from: 't', select: [{ expr: 'a' }], where: [{ column: 'a', op: 'in', value: [1, 2] }] });
    const right = renderIntent({ where: [{ value: [1, 2], op: 'in', column: 'a' }], select: [{ expr: 'a' }], from: 't' } as never);
    expect(left).toBe(right);
  });
});

describe('a filter is a column, an operator and a value', () => {
  const render = (filter: Record<string, unknown>): string => renderIntent({ ...MINIMAL, where: [filter] });

  it('renders each comparison operator the contract allows', () => {
    expect(render({ column: 'a', op: '=', value: 1 })).toContain('WHERE a = 1');
    expect(render({ column: 'a', op: '!=', value: 1 })).toContain('WHERE a <> 1');
    expect(render({ column: 'a', op: '<>', value: 1 })).toContain('WHERE a <> 1');
    expect(render({ column: 'a', op: '>', value: 1 })).toContain('WHERE a > 1');
    expect(render({ column: 'a', op: '<', value: 1 })).toContain('WHERE a < 1');
    expect(render({ column: 'a', op: '<=', value: 1 })).toContain('WHERE a <= 1');
    expect(render({ column: 'a', op: 'like', value: '%x%' })).toContain("WHERE a LIKE '%x%'");
    expect(render({ column: 'a', op: 'not like', value: '%x%' })).toContain("WHERE a NOT LIKE '%x%'");
  });

  it('renders null tests without a value, and refuses one that carries a value', () => {
    expect(render({ column: 'a', op: 'is null' })).toContain('WHERE a IS NULL');
    expect(render({ column: 'a', op: 'is not null' })).toContain('WHERE a IS NOT NULL');
    expect(compileIntent({ ...MINIMAL, where: [{ column: 'a', op: 'is null', value: 1 }] })).toMatchObject({
      ok: false,
      reason: 'unexpected-value',
    });
  });

  it('renders an in-list as a list, and refuses an empty one', () => {
    expect(render({ column: 'a', op: 'in', value: ['x', 'y'] })).toContain("WHERE a IN ('x', 'y')");
    expect(render({ column: 'a', op: 'not in', value: [1, 2, 3] })).toContain('WHERE a NOT IN (1, 2, 3)');
    expect(compileIntent({ ...MINIMAL, where: [{ column: 'a', op: 'in', value: [] }] })).toMatchObject({
      ok: false,
      reason: 'bad-value',
    });
    expect(compileIntent({ ...MINIMAL, where: [{ column: 'a', op: 'in', value: 'x' }] })).toMatchObject({
      ok: false,
      reason: 'bad-value',
    });
  });

  it('doubles a quote instead of ending the literal', () => {
    expect(render({ column: 'name', op: '=', value: "O'Brien" })).toContain("WHERE name = 'O''Brien'");
  });

  it('renders a number as a number, so a text comparison cannot be mistaken for an index', () => {
    expect(render({ column: 'a', op: '=', value: 12 })).toContain('WHERE a = 12');
    expect(render({ column: 'a', op: '=', value: 1.5 })).toContain('WHERE a = 1.5');
    expect(render({ column: 'a', op: '=', value: null })).toContain('WHERE a = NULL');
  });

  it('renders a boolean as the integer SQLite stores, not as a word it treats as a name', () => {
    expect(render({ column: 'a', op: '=', value: true })).toContain('WHERE a = 1');
    expect(render({ column: 'a', op: '=', value: false })).toContain('WHERE a = 0');
  });

  it('accepts a qualified column and refuses anything that is not a name', () => {
    expect(render({ column: 't.a', op: '=', value: 1 })).toContain('WHERE t.a = 1');
    for (const column of ['a b', 'a;drop', '"a"', 'a.b.c', '', '1a', 'a-b']) {
      expect(compileIntent({ ...MINIMAL, where: [{ column, op: '=', value: 1 }] })).toMatchObject({
        ok: false,
        reason: 'bad-identifier',
      });
    }
  });

  it('renders a range as one predicate with two bounds, and refuses any other number of them', () => {
    expect(render({ column: 'a', op: 'between', value: [1, 10] })).toContain('WHERE a BETWEEN 1 AND 10');
    expect(render({ column: 'a', op: 'not between', value: ['2020-01-01', '2020-12-31'] })).toContain(
      "WHERE a NOT BETWEEN '2020-01-01' AND '2020-12-31'",
    );
    for (const value of [[1], [1, 2, 3], 5]) {
      expect(compileIntent({ ...MINIMAL, where: [{ column: 'a', op: 'between', value }] })).toMatchObject({
        ok: false,
        reason: 'bad-value',
      });
    }
  });

  it('refuses an operator outside the list, and names it in the message', () => {
    const refused = compileIntent({ ...MINIMAL, where: [{ column: 'a', op: 'glob', value: 'x*' }] });
    expect(refused).toMatchObject({ ok: false, reason: 'bad-operator' });
    expect(refused.ok ? '' : refused.detail).toContain('glob');
  });

  it('refuses a filter that is not an object, and a value that is not a value', () => {    expect(compileIntent({ ...MINIMAL, where: [5] })).toMatchObject({ ok: false, reason: 'bad-expression' });
    expect(compileIntent({ ...MINIMAL, where: [{ column: 'a', op: '=', value: () => 1 }] })).toMatchObject({
      ok: false,
      reason: 'bad-value',
    });
  });

  it('refuses a column that is not text, which is how a nested object reaches a filter', () => {
    expect(compileIntent({ ...MINIMAL, where: [{ column: 5, op: '=', value: 1 }] })).toMatchObject({
      ok: false,
      reason: 'bad-identifier',
    });
  });

  it('refuses a comparison with no value rather than rendering one against NULL', () => {
    expect(compileIntent({ ...MINIMAL, where: [{ column: 'a', op: '=' }] })).toMatchObject({ ok: false, reason: 'missing-value' });
  });
});

describe('an expression is parsed against a closed grammar', () => {
  it('renders arithmetic with the precedence SQL has, and parentheses where they were written', () => {
    expect(renderIntentExpression('a + b * c')).toBe('a + b * c');
    expect(renderIntentExpression('(a + b) * c')).toBe('(a + b) * c');
    expect(renderIntentExpression('a - b - c')).toBe('a - b - c');
    expect(renderIntentExpression('a / b')).toBe('a / b');
  });

  it('renders a call with its arguments in order, and distinct where it was asked for', () => {
    expect(renderIntentExpression('count(*)')).toBe('count(*)');
    expect(renderIntentExpression('count(distinct a)')).toBe('count(distinct a)');
    expect(renderIntentExpression('round(avg(a), 2)')).toBe('round(avg(a), 2)');
    expect(renderIntentExpression('coalesce(a, 0)')).toBe('coalesce(a, 0)');
    expect(renderIntentExpression('substr(a, 1, 3)')).toBe('substr(a, 1, 3)');
  });

  it('renders count() as count(*), which is what the caller meant', () => {
    expect(renderIntentExpression('count()')).toBe('count(*)');
  });

  it('keeps a string literal a literal, quotes doubled', () => {
    expect(renderIntentExpression("'a''b'")).toBe("'a''b'");
  });

  it('refuses the empty call of a function that is defined by its argument', () => {
    expect(compileIntent({ ...MINIMAL, select: [{ expr: 'sum()' }] })).toMatchObject({ ok: false, reason: 'bad-expression' });
  });

  it('refuses a function outside the set, because an unknown name is an execution error', () => {
    const refused = compileIntent({ ...MINIMAL, select: [{ expr: "json_extract(a, 'x')" }] });
    expect(refused).toMatchObject({ ok: false, reason: 'unsupported-function' });
    expect(refused.ok ? '' : refused.detail).toContain('json_extract');
  });

  it('refuses a double-quoted token, which SQLite would read as a name and MySQL as a string', () => {
    expect(compileIntent({ ...MINIMAL, select: [{ expr: '"a"' }] })).toMatchObject({ ok: false, reason: 'bad-expression' });
  });

  it('refuses a statement smuggled into an expression', () => {
    for (const expr of ["'x'; drop table t", 'a) or (1=1', 'a -- comment', 'a union select 1', 'a;b']) {
      expect(compileIntent({ ...MINIMAL, select: [{ expr }] }).ok).toBe(false);
    }
  });

  it('refuses an expression that stops early, and one that keeps going', () => {
    expect(compileIntent({ ...MINIMAL, select: [{ expr: '(a + b' }] })).toMatchObject({ ok: false, reason: 'bad-expression' });
    expect(compileIntent({ ...MINIMAL, select: [{ expr: 'a b' }] })).toMatchObject({ ok: false, reason: 'bad-expression' });
    expect(compileIntent({ ...MINIMAL, select: [{ expr: '   ' }] })).toMatchObject({ ok: false, reason: 'bad-expression' });
    expect(compileIntent({ ...MINIMAL, select: [{ expr: 'a +' }] })).toMatchObject({ ok: false, reason: 'bad-expression' });
  });

  it('refuses a comma where a value belongs and a closing paren that never opened', () => {
    expect(compileIntent({ ...MINIMAL, select: [{ expr: 'a, b' }] })).toMatchObject({ ok: false, reason: 'bad-expression' });
    expect(compileIntent({ ...MINIMAL, select: [{ expr: ')a' }] })).toMatchObject({ ok: false, reason: 'bad-expression' });
    expect(compileIntent({ ...MINIMAL, select: [{ expr: '(a, b)' }] })).toMatchObject({ ok: false, reason: 'bad-expression' });
    expect(compileIntent({ ...MINIMAL, select: [{ expr: '(a' }] })).toMatchObject({ ok: false, reason: 'bad-expression' });
  });

  it('renders a comparison, a conjunction and a concatenation in source order', () => {
    expect(renderIntentExpression('a > 1')).toBe('a > 1');
    expect(renderIntentExpression('a >= 1 and b <> 2')).toBe('a >= 1 and b <> 2');
    expect(renderIntentExpression('a = 1 or b = 2')).toBe('a = 1 or b = 2');
    expect(renderIntentExpression("a || ' ' || b")).toBe("a || ' ' || b");
    expect(renderIntentExpression('a != 1')).toBe('a <> 1');
  });

  it('renders a searched case and a simple case, with the branches in order', () => {
    expect(renderIntentExpression("case when a > 1 then 'big' else 'small' end")).toBe(
      "case when a > 1 then 'big' else 'small' end",
    );
    expect(renderIntentExpression("case a when 1 then 'one' when 2 then 'two' end")).toBe(
      "case a when 1 then 'one' when 2 then 'two' end",
    );
    expect(renderIntentExpression("case when a = 1 and b = 2 then 'x' end")).toBe(
      "case when a = 1 and b = 2 then 'x' end",
    );
  });

  it('refuses a case that is missing its branches, its then or its end', () => {
    for (const expr of ['case end', 'case when a then', 'case when a then 1', 'case when 1 then 2 else 3', 'case when a else 1 end']) {
      expect(compileIntent({ ...MINIMAL, select: [{ expr }] })).toMatchObject({ ok: false, reason: 'bad-expression' });
    }
  });

  it('refuses a comparison chain, because its associativity is the engine\'s decision and not ours', () => {
    expect(compileIntent({ ...MINIMAL, select: [{ expr: 'a = b = c' }] })).toMatchObject({
      ok: false,
      reason: 'bad-expression',
    });
  });

  it('renders an order key through the same reader, so the two cannot disagree', () => {
    expect(renderIntent({ ...MINIMAL, orderBy: [{ expr: 'count(*)' }, { expr: 'a', direction: 'asc' }] })).toContain(
      'ORDER BY count(*), a ASC',
    );
  });
});

describe('the shape of the object itself', () => {
  it('refuses a value that is not an object at all', () => {
    for (const value of [null, 'from orders', 12, [1, 2]]) {
      expect(compileIntent(value)).toMatchObject({ ok: false, reason: 'not-an-object' });
    }
  });

  it('refuses a key it does not know, because a dropped clause is a silently different query', () => {
    expect(compileIntent({ ...MINIMAL, offset: 10 })).toMatchObject({ ok: false, reason: 'unknown-key' });
    expect(compileIntent({ from: 't', select: [{ expr: 'a', aggregate: 'sum' }] })).toMatchObject({
      ok: false,
      reason: 'unknown-key',
    });
    expect(compileIntent({ from: 't', select: [{ expr: 'a' }], joins: [{ table: 'u', on: [{ left: 'a', right: 'u.a' }], using: 'id' }] })).toMatchObject({
      ok: false,
      reason: 'unknown-key',
    });
  });

  it('refuses an intent with no table or no select list', () => {
    expect(compileIntent({ select: [{ expr: 'a' }] })).toMatchObject({ ok: false, reason: 'missing-from' });
    expect(compileIntent({ from: 'orders' })).toMatchObject({ ok: false, reason: 'missing-select' });
    expect(compileIntent({ from: 'orders', select: [] })).toMatchObject({ ok: false, reason: 'empty-select' });
  });

  it('refuses a join with no condition, which is a cross product written by accident', () => {
    expect(compileIntent({ ...MINIMAL, joins: [{ table: 'u', on: [] }] })).toMatchObject({ ok: false, reason: 'bad-join' });
    expect(compileIntent({ ...MINIMAL, joins: [{ table: 'u' }] })).toMatchObject({ ok: false, reason: 'bad-join' });
    expect(compileIntent({ ...MINIMAL, joins: [{ table: 'u', type: 'right', on: [{ left: 'a', right: 'u.a' }] }] })).toMatchObject({
      ok: false,
      reason: 'bad-join',
    });
  });

  it('refuses a join whose table, alias or side of a pair is not a name', () => {
    expect(compileIntent({ ...MINIMAL, joins: [{ table: 'u v', on: [{ left: 'a', right: 'u.a' }] }] })).toMatchObject({
      ok: false,
      reason: 'bad-identifier',
    });
    expect(compileIntent({ ...MINIMAL, joins: [{ table: 'u', alias: 'u v', on: [{ left: 'a', right: 'u.a' }] }] })).toMatchObject({
      ok: false,
      reason: 'bad-identifier',
    });
    expect(compileIntent({ ...MINIMAL, joins: [{ table: 'u', on: [{ left: 'a b', right: 'u.a' }] }] })).toMatchObject({
      ok: false,
      reason: 'bad-identifier',
    });
    expect(compileIntent({ ...MINIMAL, joins: [{ table: 'u', on: [{ left: 'a', right: 5 }] }] })).toMatchObject({
      ok: false,
      reason: 'bad-identifier',
    });
    expect(compileIntent({ ...MINIMAL, joins: [{ table: 'u', on: [5] }] })).toMatchObject({ ok: false, reason: 'bad-expression' });
  });

  it('refuses a from alias that is not a name, rather than emitting it', () => {
    expect(compileIntent({ from: 'orders', alias: 'o x', select: [{ expr: 'a' }] })).toMatchObject({
      ok: false,
      reason: 'bad-identifier',
    });
  });

  it('refuses a select item whose expr is not text', () => {
    expect(compileIntent({ from: 'orders', select: [{ expr: 5 }] })).toMatchObject({ ok: false, reason: 'bad-expression' });
  });

  it('refuses a limit that is not a count', () => {
    for (const limit of [-1, 1.5, '10']) {
      expect(compileIntent({ ...MINIMAL, limit })).toMatchObject({ ok: false, reason: 'bad-limit' });
    }
  });

  it('refuses a direction it cannot render, rather than defaulting to ascending', () => {
    expect(compileIntent({ ...MINIMAL, orderBy: [{ expr: 'a', direction: 'down' }] })).toMatchObject({
      ok: false,
      reason: 'bad-direction',
    });
  });

  it('refuses a group-by key that is not a column reference', () => {
    expect(compileIntent({ ...MINIMAL, groupBy: ['a b'] })).toMatchObject({ ok: false, reason: 'bad-identifier' });
    expect(compileIntent({ ...MINIMAL, groupBy: 'a' })).toMatchObject({ ok: false, reason: 'bad-identifier' });
  });

  it('refuses a non-boolean distinct rather than reading "false" as true', () => {
    expect(compileIntent({ ...MINIMAL, distinct: 'false' })).toMatchObject({ ok: false, reason: 'bad-value' });
  });

  it('refuses a select item that is not an object, or names an alias that is not one', () => {
    expect(compileIntent({ from: 't', select: ['a'] })).toMatchObject({ ok: false, reason: 'bad-expression' });
    expect(compileIntent({ from: 't', select: [{ expr: 'a', alias: 'a b' }] })).toMatchObject({ ok: false, reason: 'bad-identifier' });
  });

  it('refuses an order item without an expression', () => {
    expect(compileIntent({ ...MINIMAL, orderBy: [{ direction: 'asc' }] })).toMatchObject({ ok: false, reason: 'bad-order' });
  });
});

describe('the parsed intent is the contract a caller can keep', () => {
  it('returns only the keys the reply carried, so an absent clause stays absent', () => {
    expect(parseQueryIntent(MINIMAL)).toEqual({ from: 'orders', select: [{ expr: 'count(*)' }] });
  });

  it('carries every optional clause through unchanged', () => {
    const intent = {
      from: 't',
      alias: 't',
      joins: [{ table: 'u', alias: 'u', type: 'left' as const, on: [{ left: 't.id', right: 'u.id' }] }],
      select: [{ expr: 'a', alias: 'x' }],
      where: [{ column: 't.a', op: '=' as const, value: 1 }],
      groupBy: ['a'],
      having: [{ column: 'x', op: '>' as const, value: 0 }],
      orderBy: [{ expr: 'x', direction: 'desc' as const }],
      limit: 5,
      distinct: true,
    };
    expect(parseQueryIntent(intent)).toEqual(intent);
  });

  it('copies an in-list, so a caller cannot mutate the value it was parsed from', () => {
    const value = [1, 2];
    const parsed = parseQueryIntent({ ...MINIMAL, where: [{ column: 'a', op: 'in', value }] });
    expect(parsed.where?.[0]?.value).not.toBe(value);
    expect(parsed.where?.[0]?.value).toEqual([1, 2]);
  });
});

describe('compileIntent is total, and every refusal has a name', () => {
  it('reports success with the statement and the parsed intent together', () => {
    const compiled = compileIntent(MINIMAL);
    expect(compiled.ok).toBe(true);
    expect(compiled.ok ? compiled.sql : '').toBe('SELECT count(*) FROM orders');
    expect(compiled.ok ? compiled.intent.from : '').toBe('orders');
  });

  it('turns an exception that is not a refusal into a refusal, so a caller never has to catch', () => {
    const hostile = Object.defineProperty({}, 'from', {
      enumerable: true,
      get() {
        throw new Error('property threw');
      },
    });
    const compiled = compileIntent(hostile);
    expect(compiled).toMatchObject({ ok: false, reason: 'bad-expression' });
    expect(compiled.ok ? '' : compiled.detail).toContain('property threw');
  });

  it('reports a non-finite number as a value it cannot render', () => {
    expect(compileIntent({ ...MINIMAL, where: [{ column: 'a', op: '=', value: Number.POSITIVE_INFINITY }] })).toMatchObject({
      ok: false,
      reason: 'bad-value',
    });
  });

  it('refuses a value that is an object, which is how a nested clause arrives in the wrong place', () => {
    expect(compileIntent({ ...MINIMAL, where: [{ column: 'a', op: '=', value: { b: 1 } }] })).toMatchObject({
      ok: false,
      reason: 'bad-value',
    });
    const refused = compileIntent({ ...MINIMAL, where: [{ column: 'a', op: '=', value: [1] }] });
    expect(refused).toMatchObject({ ok: false, reason: 'bad-value' });
    expect(refused.ok ? '' : refused.detail).toContain('an array');
  });

  it('reports a thrown non-error as a refusal detail rather than losing it', () => {
    const hostile = Object.defineProperty({}, 'from', {
      enumerable: true,
      get() {
        throw 'thrown as a string';
      },
    });
    const compiled = compileIntent(hostile);
    expect(compiled.ok).toBe(false);
    expect(compiled.ok ? '' : compiled.detail).toContain('thrown as a string');
  });
});

describe('the two closed lists are the contract, and they are readable', () => {
  it('names every operator a filter may carry', () => {
    expect([...INTENT_OPERATORS]).toEqual([
      '=',
      '<>',
      '!=',
      '>',
      '>=',
      '<',
      '<=',
      'like',
      'not like',
      'in',
      'not in',
      'between',
      'not between',
      'is null',
      'is not null',
    ]);
  });

  it('names the functions an expression may call, and every one of them renders', () => {
    for (const name of INTENT_FUNCTIONS) {
      expect(renderIntentExpression(`${name}(a)`)).toBe(`${name}(a)`);
    }
  });
});
