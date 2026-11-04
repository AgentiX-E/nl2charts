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
    // A scalar is the one-element list it obviously means: a reply that writes `x in 'a'` has
    // answered the question and lost nothing by spelling the list without brackets.
    expect(render({ column: 'a', op: 'in', value: 'x' })).toContain("WHERE a IN ('x')");
    expect(compileIntent({ ...MINIMAL, where: [{ column: 'a', op: 'in', value: {} }] })).toMatchObject({
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

  it('accepts a qualified column, quotes a name that needs it, and refuses one that cannot be a name', () => {
    expect(render({ column: 't.a', op: '=', value: 1 })).toContain('WHERE t.a = 1');
    // The corpus does not spell every column with word characters: BIRD's `california_schools` holds
    // `County Name` and `Charter School (Y/N)`. A grammar that only accepted bare words could not
    // name them, and the refusal would read as a model that cannot spell.
    expect(render({ column: 'frpm.County Name', op: '=', value: 'Fresno' })).toContain('WHERE frpm."County Name" = \'Fresno\'');
    expect(render({ column: 'Charter School (Y/N)', op: '=', value: 1 })).toContain('WHERE "Charter School (Y/N)" = 1');
    for (const column of ['a;drop', 'a.b.c', '', ' a', 'a ', 'a--b', 'a/*b', 'a`b', 'a\u0000b']) {
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

  it('reads a double-quoted token as a name, which is the only way an expression can spell one', () => {
    // The alternative was refusing it, and refusing it made a column the corpus spells `County Name`
    // unnameable inside any expression at all. Double quotes are the identifier syntax in every
    // engine BIRD runs on, so `"County Name"` is a column reference and `'County Name'` is a string —
    // the two spellings mean different things here, exactly as they do to the engine.
    expect(renderIntentExpression('"County Name"')).toBe('"County Name"');
    expect(renderIntentExpression("'County Name'")).toBe("'County Name'");
    expect(renderIntentExpression('lower("County Name")')).toBe('lower("County Name")');
    expect(renderIntentExpression('"a""b"')).toBe('"a""b"');
    // An unterminated quote is still not a name, and it is refused where it is read.
    expect(compileIntent({ ...MINIMAL, select: [{ expr: '"a' }] })).toMatchObject({ ok: false, reason: 'bad-expression' });
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

  it('quotes a join name that needs it, and refuses one that cannot be a name', () => {
    expect(renderIntent({ ...MINIMAL, joins: [{ table: 'u v', on: [{ left: 'a', right: 'u.a' }] }] })).toContain('JOIN "u v" ON');
    expect(renderIntent({ ...MINIMAL, joins: [{ table: 'u', alias: 'u v', on: [{ left: 'a b', right: 'u.a' }] }] })).toContain(
      'JOIN u "u v" ON "a b" = u.a',
    );
    for (const join of [
      { table: 'u;v', on: [{ left: 'a', right: 'u.a' }] },
      { table: 'u', alias: 'u`v', on: [{ left: 'a', right: 'u.a' }] },
      { table: 'u', on: [{ left: 'a--b', right: 'u.a' }] },
      { table: 'u', on: [{ left: 'a', right: 5 }] },
    ]) {
      expect(compileIntent({ ...MINIMAL, joins: [join] })).toMatchObject({ ok: false, reason: 'bad-identifier' });
    }
    expect(compileIntent({ ...MINIMAL, joins: [{ table: 'u', on: [5] }] })).toMatchObject({ ok: false, reason: 'bad-expression' });
  });

  it('quotes a from alias that needs it, and refuses one that cannot be a name', () => {
    expect(renderIntent({ from: 'orders', alias: 'o x', select: [{ expr: 'a' }] })).toBe('SELECT a FROM orders "o x"');
    expect(compileIntent({ from: 'orders', alias: 'o;x', select: [{ expr: 'a' }] })).toMatchObject({
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

  it('quotes a group-by key that needs it, and refuses one that cannot be a column reference', () => {
    expect(renderIntent({ ...MINIMAL, groupBy: ['a b', 'c'] })).toBe('SELECT count(*) FROM orders GROUP BY "a b", c');
    expect(compileIntent({ ...MINIMAL, groupBy: ['a;b'] })).toMatchObject({ ok: false, reason: 'bad-identifier' });
    expect(compileIntent({ ...MINIMAL, groupBy: 'a' })).toMatchObject({ ok: false, reason: 'bad-identifier' });
  });

  it('refuses a non-boolean distinct rather than reading "false" as true', () => {
    expect(compileIntent({ ...MINIMAL, distinct: 'false' })).toMatchObject({ ok: false, reason: 'bad-value' });
  });

  it('refuses a select item that is not an object, or names an alias that is not one', () => {
    expect(compileIntent({ from: 't', select: ['a'] })).toMatchObject({ ok: false, reason: 'bad-expression' });
    expect(renderIntent({ from: 't', select: [{ expr: 'a', alias: 'a b' }] })).toBe('SELECT a AS "a b" FROM t');
    expect(compileIntent({ from: 't', select: [{ expr: 'a', alias: 'a;b' }] })).toMatchObject({ ok: false, reason: 'bad-identifier' });
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

describe('a name is quoted when it needs quoting, and checked against the schema when there is one', () => {
  const COLUMNS = ['frpm.County Name', 'frpm.CDSCode', 'County Name', 'CDSCode', 'n'];

  it('treats a quoted spelling and a bare spelling as the same name', () => {
    const bare = { ...MINIMAL, where: [{ column: 'County Name', op: '=', value: 'Fresno' }] };
    const quoted = { ...MINIMAL, where: [{ column: '"County Name"', op: '=', value: 'Fresno' }] };
    // The two spellings a model can produce for one column have to reach the engine as one text, or
    // two candidates that mean the same thing stop being comparable and the pool counts them twice.
    expect(renderIntent(bare)).toBe(renderIntent(quoted));
    expect(renderIntent(quoted)).toContain('WHERE "County Name" = \'Fresno\'');
    // A quote inside a name is doubled, which is the only escape SQLite's identifier syntax has.
    expect(renderIntent({ ...MINIMAL, where: [{ column: '"a""b"', op: '=', value: 1 }] })).toContain('WHERE "a""b" = 1');
  });

  it('refuses a column the schema does not have, which quoting would otherwise hide', () => {
    // The reason this check exists is SQLite's own behaviour: `"County Nam" = 1` is not an error, it
    // is a column compared to a *string literal*, and it returns a clean wrong answer. A renderer
    // that quotes has to be handed the schema or it trades a syntax defect for a silent one.
    const misspelled = { ...MINIMAL, where: [{ column: 'frpm.County Nam', op: '=', value: 1 }] };
    expect(compileIntent(misspelled, { columns: COLUMNS })).toMatchObject({ ok: false, reason: 'unknown-identifier' });
    expect(compileIntent(misspelled)).toMatchObject({ ok: true });
  });

  it('accepts the qualified and the bare spelling of a column it knows', () => {
    const intent = { ...MINIMAL, where: [{ column: 'frpm.County Name', op: '=', value: 1 }], groupBy: ['frpm.CDSCode'] };
    expect(compileIntent(intent, { columns: COLUMNS })).toMatchObject({ ok: true });
    expect(compileIntent({ ...intent, where: [{ column: 'County Name', op: '=', value: 1 }] }, { columns: COLUMNS })).toMatchObject({ ok: true });
  });

  it('compares names the way the engine does, which is without case', () => {
    expect(compileIntent({ ...MINIMAL, where: [{ column: 'cdscode', op: '=', value: 1 }] }, { columns: ['CDSCode'] })).toMatchObject({ ok: true });
  });

  it('checks every clause a name can appear in, not only the select list', () => {
    const columns = ['orders.id', 'orders.total', 'customers.name'];
    expect(compileIntent({ from: 'orders', select: [{ expr: 'nope' }] }, { columns })).toMatchObject({ ok: false, reason: 'unknown-identifier' });
    expect(
      compileIntent({ from: 'orders', select: [{ expr: 'orders.id' }], where: [{ column: 'orders.nope', op: '=', value: 1 }] }, { columns }),
    ).toMatchObject({ ok: false, reason: 'unknown-identifier' });
    expect(
      compileIntent({ from: 'orders', select: [{ expr: 'orders.id' }], groupBy: ['orders.nope'] }, { columns }),
    ).toMatchObject({ ok: false, reason: 'unknown-identifier' });
    expect(
      compileIntent({ from: 'orders', select: [{ expr: 'orders.id' }], orderBy: [{ expr: 'nope' }] }, { columns }),
    ).toMatchObject({ ok: false, reason: 'unknown-identifier' });
    expect(
      compileIntent(
        { from: 'orders', select: [{ expr: 'orders.id' }], joins: [{ table: 'customers', on: [{ left: 'orders.id', right: 'customers.nope' }] }] },
        { columns },
      ),
    ).toMatchObject({ ok: false, reason: 'unknown-identifier' });
    expect(
      compileIntent({ from: 'orders', select: [{ expr: 'orders.id' }], having: [{ column: 'nope', op: '>', value: 1 }] }, { columns }),
    ).toMatchObject({ ok: false, reason: 'unknown-identifier' });
  });

  it('refuses a numeric spelling, which three engines read three ways', () => {
    // `1` as a group-by key is a position in Postgres, a constant in SQL, and the string '1' once
    // quoted — three meanings for one token and none of them is "this column". The contract names
    // columns, so the spelling is refused rather than resolved the wrong way.
    expect(compileIntent({ ...MINIMAL, groupBy: ['1'] })).toMatchObject({ ok: false, reason: 'bad-identifier' });
    expect(compileIntent({ ...MINIMAL, where: [{ column: '2', op: '=', value: 1 }] })).toMatchObject({ ok: false, reason: 'bad-identifier' });
    // An order item is an expression, and a number there is a number: `ORDER BY 2` already means the
    // constant, and the renderer keeps it as one rather than quoting it into a string.
    expect(renderIntent({ ...MINIMAL, orderBy: [{ expr: '2' }] })).toBe('SELECT count(*) FROM orders ORDER BY 2');
  });

  it('does not refuse a name it cannot resolve because the alias, not the schema, owns it', () => {
    // `o` is a name this statement invented; the column after the dot is the part the schema owns,
    // which is the whole of what a flat column list can check without a join graph.
    expect(
      compileIntent(
        { from: 'orders', alias: 'o', select: [{ expr: 'o.id' }], where: [{ column: 'o.total', op: '>', value: 1 }] },
        { columns: ['orders.id', 'orders.total'] },
      ),
    ).toMatchObject({ ok: true });
  });
});

describe('the left side of a condition is a name or an expression, and says which', () => {
  it('renders an aggregate on the left of a having, under its own key', () => {
    // `column` cannot carry this: a column name may itself contain a space and a parenthesis, so
    // nothing about the text tells `Charter School (Y/N)` from `count(p.Id)`. The explicit key is
    // what keeps both expressible, and the test above keeps the name form working.
    expect(
      renderIntent({
        from: 'orders',
        select: [{ expr: 'orders.customer_id' }],
        groupBy: ['orders.customer_id'],
        having: [{ expr: 'count(orders.id)', op: '>', value: 5 }],
      }),
    ).toBe('SELECT orders.customer_id FROM orders GROUP BY orders.customer_id HAVING count(orders.id) > 5');
  });

  it('refuses a filter that names both forms, or neither', () => {
    expect(compileIntent({ ...MINIMAL, where: [{ column: 'a', expr: 'b', op: '=', value: 1 }] })).toMatchObject({
      ok: false,
      reason: 'bad-identifier',
    });
    expect(compileIntent({ ...MINIMAL, where: [{ op: '=', value: 1 }] })).toMatchObject({ ok: false, reason: 'bad-identifier' });
  });

  it('refuses an expression on the left that the grammar does not have', () => {
    expect(compileIntent({ ...MINIMAL, having: [{ expr: 'median(a)', op: '>', value: 1 }] })).toMatchObject({
      ok: false,
      reason: 'unsupported-function',
    });
  });

  it('checks the columns an expression on the left names', () => {
    expect(
      compileIntent({ from: 'orders', select: [{ expr: 'orders.id' }], having: [{ expr: 'count(nope)', op: '>', value: 1 }] }, { columns: ['orders.id'] }),
    ).toMatchObject({ ok: false, reason: 'unknown-identifier' });
    expect(
      compileIntent({ from: 'orders', select: [{ expr: 'orders.id' }], having: [{ expr: 'count(orders.id)', op: '>', value: 1 }] }, { columns: ['orders.id'] }),
    ).toMatchObject({ ok: true });
  });
});

describe('a qualified name with a space in it is expressible inside an expression', () => {
  it('renders f."School Name" as the reference it is', () => {
    // The mixture of a bare qualifier and a quoted column is not exotic: it is what every join in
    // BIRD's `california_schools` looks like, and it used to be refused as "contains a dot".
    expect(renderIntentExpression('f."School Name"')).toBe('f."School Name"');
    expect(renderIntentExpression('lower(f."School Name")')).toBe('lower(f."School Name")');
    // Quoting is applied where it is needed and dropped where it is not, so the two spellings of a
    // name that needs no quoting render to one text — which is what keeps candidates comparable.
    expect(renderIntentExpression('"a"."b"')).toBe('a.b');
  });

  it('refuses a qualifier chain that is not two parts', () => {
    expect(compileIntent({ ...MINIMAL, select: [{ expr: 'a.b.c' }] })).toMatchObject({ ok: false, reason: 'bad-expression' });
  });

  it('resolves such a name against the schema by its column part', () => {
    expect(
      compileIntent({ from: 'frpm', select: [{ expr: 'f."School Name"' }] }, { columns: ['frpm.School Name'] }),
    ).toMatchObject({ ok: true });
    expect(
      compileIntent({ from: 'frpm', select: [{ expr: 'f."School Nam"' }] }, { columns: ['frpm.School Name'] }),
    ).toMatchObject({ ok: false, reason: 'unknown-identifier' });
  });
});

describe('two spellings the corpus uses are read rather than refused', () => {
  it('matches an operator without case, because `IS NULL` and `is null` are one predicate', () => {
    expect(renderIntent({ ...MINIMAL, where: [{ column: 'a', op: 'IS NULL' as never }] })).toContain('WHERE a IS NULL');
    expect(renderIntent({ ...MINIMAL, where: [{ column: 'a', op: 'NOT IN' as never, value: [1] }] })).toContain('WHERE a NOT IN (1)');
  });

  it('reads a null value on `is null` as "no value", which is what JSON has for that', () => {
    expect(renderIntent({ ...MINIMAL, where: [{ column: 'a', op: 'is null', value: null }] })).toContain('WHERE a IS NULL');
    expect(compileIntent({ ...MINIMAL, where: [{ column: 'a', op: 'is null', value: 1 }] })).toMatchObject({
      ok: false,
      reason: 'unexpected-value',
    });
  });

  it('lets a select alias be used where SQL allows it', () => {
    // `select: [{expr: 'count(*)', alias: 'n'}]` followed by `having: [{column: 'n'}]` is the shape a
    // grouped question takes; looking `n` up in the schema refused a statement that is correct.
    expect(
      compileIntent(
        { from: 'orders', select: [{ expr: 'count(*)', alias: 'n' }], having: [{ column: 'n', op: '>', value: 1 }] },
        { columns: ['orders.id'] },
      ),
    ).toMatchObject({ ok: true });
  });
});
