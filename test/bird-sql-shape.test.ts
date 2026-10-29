/**
 * Reading a statement into the parts a fix can name.
 *
 * Every assertion here is a sentence pair, because that is the input the classifier actually
 * gets: two strings, no schema, no result set. The properties that matter are the ones a
 * taxonomy depends on — aliases must not count as a difference, order of conjuncts must not
 * count, column order must count — so those are asserted directly rather than through the
 * classifier, where a failing assertion would not say which part broke.
 */
import { describe, expect, it } from 'vitest';
import {
  aliasTable,
  normaliseSql,
  predicateAtoms,
  projectionItems,
  rewriteAliases,
  statementShape,
  windowClause,
} from '../eval/bird/sql-shape.js';

describe('one spelling for one statement', () => {
  it('drops quoting, case, spacing and a trailing semicolon', () => {
    expect(normaliseSql('  SELECT  "Name" ,\n COUNT(*)  FROM `items` ;  ')).toBe('select name , count(*) from items');
  });

  it('reads `inner join` as `join` and `left outer join` as `left join`', () => {
    // Two spellings of one join type, so a pair that differs only in spelling must compare
    // equal; otherwise the taxonomy reports style as a defect.
    expect(normaliseSql('select a from x inner join y on 1 = 1')).toBe('select a from x join y on 1 = 1');
    expect(normaliseSql('select a from x left outer join y on 1 = 1')).toBe('select a from x left join y on 1 = 1');
    expect(normaliseSql('select a from x right outer join y on 1 = 1')).toBe('select a from x right join y on 1 = 1');
  });

  it('rewrites the comma form of limit into the offset form, which is the same window', () => {
    // SQLite accepts `limit 6, 1` and `limit 1 offset 6` for the same row. A taxonomy that
    // kept the two spellings apart would report a window error on a statement that has none.
    expect(normaliseSql('select a from t limit 6, 1')).toBe('select a from t limit 1 offset 6');
    expect(normaliseSql('select a from t limit 1 offset 6')).toBe('select a from t limit 1 offset 6');
  });
});

describe('aliases', () => {
  it('maps an alias written with `as`, without it, and a table with no alias', () => {
    const map = aliasTable('select * from items as i join orders o on i.id = o.item_id join prices on prices.id = i.id');
    expect(map.get('i')).toBe('items');
    expect(map.get('o')).toBe('orders');
    expect(map.get('prices')).toBe('prices');
  });

  it('does not mistake the next clause keyword for an alias', () => {
    expect([...aliasTable('select * from items where price > 1').keys()]).toEqual(['items']);
    expect([...aliasTable('select * from items group by name').keys()]).toEqual(['items']);
    expect([...aliasTable('select * from items left join orders on 1 = 1').keys()]).toEqual(['items', 'orders']);
  });

  it('rewrites a reference through the longest alias first, so t1 cannot eat t10', () => {
    const sql = 'select t1.a, t10.b from items as t1 join prices as t10 on t1.id = t10.id';
    expect(rewriteAliases(sql)).toContain('items.a');
    expect(rewriteAliases(sql)).toContain('prices.b');
  });

  it('leaves a statement that uses no aliases alone', () => {
    const sql = 'select items.a from items join prices on items.id = prices.id';
    expect(rewriteAliases(sql)).toBe(normaliseSql(sql));
  });
});

describe('conditions', () => {
  it('collects where and on atoms, in a form where conjunct order does not matter', () => {
    const left = predicateAtoms('select * from a join b on a.id = b.id where a.x = 1 and b.y = 2');
    const right = predicateAtoms('select * from a join b on a.id = b.id where b.y = 2 and a.x = 1');
    expect(left).toEqual(right);
    expect(left).toContain('a.x = 1');
    expect(left).toContain('a.id = b.id');
  });

  it('counts one condition once, however many times it is written', () => {
    expect(predicateAtoms('select * from a where x = 1 and x = 1')).toEqual(['x = 1']);
  });

  it('reads a statement with no conditions as no atoms', () => {
    expect(predicateAtoms('select * from a')).toEqual([]);
  });

  it('stops a condition at the next clause rather than swallowing the rest of the statement', () => {
    expect(predicateAtoms('select * from a where x = 1 group by y order by 1 limit 2')).toEqual(['x = 1']);
    expect(predicateAtoms('select * from a join b on a.id = b.id join c on c.id = a.id where 1 = 1')).toHaveLength(3);
  });
});

describe('the select list', () => {
  it('keeps column order, because a tuple comparison depends on it', () => {
    expect(projectionItems('select a, b from t')).toEqual(['a', 'b']);
    expect(projectionItems('select b, a from t')).toEqual(['b', 'a']);
  });

  it('drops an alias, which never reaches the result', () => {
    expect(projectionItems('select count(*) as total, sum(x) as s from t')).toEqual(['count(*)', 'sum(x)']);
  });

  it('reads a select with no from as its own list', () => {
    expect(projectionItems('select 1')).toEqual(['1']);
  });

  it('keeps a case expression in one piece rather than splitting on its comma', () => {
    expect(projectionItems("select case when x = 1 then 'a' else 'b' end from t")).toHaveLength(1);
  });
});

describe('the window', () => {
  it('reads order by and limit together, and one without the other', () => {
    expect(windowClause('select a from t order by a desc limit 3')).toBe('order by a desc limit 3');
    expect(windowClause('select a from t order by a')).toBe('order by a');
    expect(windowClause('select a from t limit 3')).toBe('limit 3');
  });

  it('reads a statement with no window as empty', () => {
    expect(windowClause('select a from t')).toBe('');
  });

  it('reads the offset form and the comma form the same way', () => {
    expect(windowClause('select a from t order by a limit 6, 1')).toBe(windowClause('select a from t order by a limit 1 offset 6'));
  });
});

describe('the whole shape', () => {
  it('treats two spellings of one question as one statement', () => {
    const gold = 'SELECT T1.Name FROM items AS T1 WHERE T1.price > 10 ORDER BY T1.Name LIMIT 5';
    const predicted = 'select i.name from items i where i.price > 10 order by i.name limit 5';
    expect(statementShape(gold).text).toBe(statementShape(predicted).text);
  });

  it('lists the tables once each, sorted, whoever wrote them', () => {
    expect(statementShape('select 1 from orders join items on 1 = 1').tables).toEqual(['items', 'orders']);
  });

  it('keeps a difference that changes the answer even when the aliases differ', () => {
    const left = statementShape('select s.a from items s join orders o on s.id = o.item_id');
    const right = statementShape('select i.a from items i join prices p on i.id = p.item_id');
    expect(left.tables).toEqual(['items', 'orders']);
    expect(right.tables).toEqual(['items', 'prices']);
    expect(left.text).not.toBe(right.text);
  });

  it('carries the aggregate and the grouping through the rewrite', () => {
    const shape = statementShape('select t.region, count(*) from sales as t group by t.region');
    expect(shape.aggregates).toEqual(['count']);
    expect(shape.groups).toEqual(['region']);
    expect(shape.predicates).toEqual([]);
  });
});
