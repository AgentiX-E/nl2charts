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
  predicateKeys,
  projectionItems,
  rewriteAliases,
  spliceWhereClause,
  statementShape,
  whereClauseSpan,
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

describe('two spellings of one condition', () => {
  // The taxonomy compares predicate lists to decide whether a failure belongs to condition
  // coverage or to a later rung. `a.id = b.id` and `b.id = a.id` are one condition, and until
  // this was named the comparison called them two — which filed a quarter of the largest rung
  // under a fix that could not have changed the answer.
  it('reads an equality in either direction as one condition', () => {
    expect(predicateKeys(['schools.cdscode = frpm.cdscode'])).toEqual(predicateKeys(['frpm.cdscode = schools.cdscode']));
  });

  it('flips a relational operator when it swaps the operands', () => {
    expect(predicateKeys(['a.x > 1'])).toEqual(predicateKeys(['1 < a.x']));
    expect(predicateKeys(['a.x >= 1'])).toEqual(predicateKeys(['1 <= a.x']));
  });

  it('does not flip an inequality, which is symmetric already', () => {
    expect(predicateKeys(['a.x != 1'])).toEqual(predicateKeys(['1 != a.x']));
    expect(predicateKeys(['a.x <> 1'])).toEqual(predicateKeys(['1 <> a.x']));
  });

  it('drops a table qualifier when the other side is a literal', () => {
    // `schools.charternum is not null` and `charternum is not null` are one condition when the
    // statement reads `schools`; the qualifier is a spelling, and the model that omitted it
    // meant the same column.
    expect(predicateKeys(['schools.charternum is not null'])).toEqual(predicateKeys(['charternum is not null']));
    expect(predicateKeys(['t.status = \'banned\''])).toEqual(predicateKeys(['status = \'banned\'']));
  });

  it('keeps qualifiers when both sides are columns, because a join is not a column test', () => {
    expect(predicateKeys(['a.id = b.id'])).not.toEqual(predicateKeys(['c.id = d.id']));
    expect(predicateKeys(['a.id = b.id'])).not.toEqual(predicateKeys(['id = id']));
  });

  it('still tells two different columns apart', () => {
    expect(predicateKeys(['a.x = 1'])).not.toEqual(predicateKeys(['a.y = 1']));
  });

  it('drops a qualifier in front of like, and keeps the pattern', () => {
    expect(predicateKeys(["t.name like 'riverside%'"])).toEqual(predicateKeys(["name like 'riverside%'"]));
    expect(predicateKeys(["t.name like 'riverside%'"])).not.toEqual(predicateKeys(["t.name like 'riverside'"]));
  });

  it('does not read an operator out of a literal that contains the word', () => {
    // `status = 'like new'` is an equality; treating it as a `like` would drop the operator and
    // make the condition compare equal to one it has nothing to do with.
    const key = predicateKeys(["t.status = 'like new'"]);
    expect(key).toEqual(["status = 'like new'"]);
    expect(key).not.toEqual(predicateKeys(["t.status like 'like new'"]));
  });

  it('reads an in-list as a set', () => {
    expect(predicateKeys(["statustype in 'active' , 'closed'"])).toEqual(predicateKeys(["statustype in 'closed' , 'active'"]));
  });

  it('reads a between clause in the order it was written, because the bounds are ordered', () => {
    expect(predicateKeys(['x between 1 and 2'])).not.toEqual(predicateKeys(['x between 2 and 1']));
  });

  it('is a set: duplicates collapse and order does not matter', () => {
    expect(predicateKeys(['a.x = 1', 'b.y = 2', '1 = a.x'])).toEqual(predicateKeys(['b.y = 2', 'a.x = 1']));
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

/**
 * Finding and replacing the `where` clause by position rather than by text.
 *
 * The ceiling that needs this splices a clause from one statement into another, and the two
 * spell the same table differently. Re-finding the clause by searching for its first predicate
 * lands in the wrong place as soon as two clauses share a word, so the span is read once and the
 * edit is a slice — the tests below are the positions that make the slice safe.
 */
describe('the where clause, as a span', () => {
  it('ends where the next clause begins, not where the statement does', () => {
    expect(whereClauseSpan('select a from t where x = 1 order by a limit 3')).toEqual({ start: 16, bodyStart: 21, bodyEnd: 28 });
  });

  it('ends at the statement when nothing follows it', () => {
    const sql = 'select a from t where x = 1';
    expect(whereClauseSpan(sql)?.bodyEnd).toBe(sql.length);
  });

  it('ignores a where inside a subquery, a literal or a comment', () => {
    // Depth and quoting, not pattern matching: the clause to replace is the statement's own, and a
    // splice into the inner query of `where x in (select ... where z = 1)` would run and answer a
    // different question.
    expect(whereClauseSpan("select a from t where b = 'where x = 1' order by a")?.bodyEnd).toBe(40);
    // A `from` subquery's filter belongs to the subquery: the statement itself has no clause, so a
    // ceiling that spliced one in would add a filter rather than replace the one it meant to.
    expect(whereClauseSpan('select a from (select b from u where c = 1) q')).toBeUndefined();
    expect(whereClauseSpan('-- where x = 1\nselect a from t')).toBeUndefined();
  });

  it('replaces the body and keeps everything after it', () => {
    expect(spliceWhereClause('select a from t where x = 1 order by a limit 3', 'y = 2')).toBe(
      'select a from t where y = 2 order by a limit 3',
    );
  });

  it('inserts the clause in front of the tail when the statement has none', () => {
    expect(spliceWhereClause('select a from t group by a', 'y = 2')).toBe('select a from t where y = 2 group by a');
    expect(spliceWhereClause('select a from t', 'y = 2')).toBe('select a from t where y = 2');
  });

  it('removes the clause when there is no body to put there', () => {
    // The `filter-wide` direction: a gold statement without a filter asks for the prediction's to
    // go, and a ceiling that could only add one would report half the bucket as unreachable.
    expect(spliceWhereClause('select a from t where x = 1 group by a', undefined)).toBe('select a from t group by a');
    expect(spliceWhereClause('select a from t', undefined)).toBe('select a from t');
  });

  it('leaves one terminator and no space in front of it', () => {
    expect(spliceWhereClause('select a from t where x = 1;', 'y = 2')).toBe('select a from t where y = 2;');
    expect(spliceWhereClause('select a from t where x = 1;', undefined)).toBe('select a from t;');
  });

  it('does not read a block comment as a clause keyword', () => {
    // A commented-out clause is text a person left behind, not a clause: treating `/* order by */`
    // as the boundary would cut the body short and leave the comment standing after the splice.
    // The comment goes with the clause it was written inside, so the *absence* of it is the proof
    // that it was not read as a boundary.
    expect(whereClauseSpan('/* where x = 1 */ select a from t')).toBeUndefined();
    expect(spliceWhereClause('select a from t where x = 1 /* order by a */', 'y = 2')).toBe('select a from t where y = 2');
  });

  it('does not read a bracketed identifier as a clause keyword', () => {
    // SQLite's and SQL Server's quoting: `[where]` is a column called `where`, and a scanner that
    // opened the clause on it would replace a select-list item instead of a filter.
    expect(whereClauseSpan('select [where] from t')).toBeUndefined();
    expect(whereClauseSpan('select [where] from t where x = 1')?.start).toBe(22);
  });

  it('survives the four ways a statement can end inside a quote, a comment or a bracket', () => {
    // A model does write these — a truncated response, a stray apostrophe — and the reader runs on
    // every statement the artifact holds. Each unterminated region has to consume the rest of the
    // text rather than throw or, worse, resume scanning inside it and open a clause on a word that
    // is not one.
    expect(whereClauseSpan('select a from t -- where x = 1')).toBeUndefined();
    expect(whereClauseSpan('select a from t /* where x = 1')).toBeUndefined();
    const openQuote = "select a from t where b = 'oops";
    expect(whereClauseSpan(openQuote)).toEqual({ start: 16, bodyStart: 21, bodyEnd: openQuote.length });
    expect(whereClauseSpan('select [where from t')).toBeUndefined();
  });
});
