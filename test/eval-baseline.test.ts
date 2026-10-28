/**
 * The deterministic baseline is the harness's scale: the oracle at 100%, the empty
 * predictor at 0%, and two template arms between them. Nothing here calls a model, which is
 * the point — if the template arms and the judge disagree with the fixture, the disagreement
 * is in this repository, not in somebody's endpoint.
 *
 * The template compiler is the part worth testing word by word: it is a rule set over
 * English, and every rule it gets wrong becomes a "MISS" that a later ablation reads as a
 * finding about normalization rather than a bug in the matcher.
 */
import { describe, expect, it } from 'vitest';
import { normalizeQuestion, predict, templateSql } from '../eval/baseline.js';

describe('question normalization', () => {
  it('folds synonyms onto column vocabulary', () => {
    expect(normalizeQuestion('Sales by area')).toBe('revenue by region');
    expect(normalizeQuestion('units per territory')).toBe('quantity by region');
  });

  it('strips punctuation and collapses whitespace', () => {
    expect(normalizeQuestion('  Revenue,   by REGION? ')).toBe('revenue by region');
  });
});

describe('template compiler', () => {
  it('counts orders with no dimension', () => {
    expect(templateSql('how many orders', true)).toBe('select count(*) as orders from orders');
  });

  it('groups by region and channel when both are named together', () => {
    expect(templateSql('revenue by region and channel', true)).toBe(
      'select region, channel, sum(amount) as total from orders group by 1, 2 order by 1',
    );
  });

  it('groups by a single dimension named separately', () => {
    expect(templateSql('revenue by channel', true)).toBe('select channel, sum(amount) as total from orders group by 1 order by 1');
    expect(templateSql('revenue by product', true)).toBe('select product, sum(amount) as total from orders group by 1 order by 1');
  });

  it('turns a month into a date_trunc, because a month is not a column', () => {
    expect(templateSql('revenue by month', true)).toBe(
      "select date_trunc('month', order_date) as month, sum(amount) as total from orders group by 1 order by 1",
    );
  });

  it('reads a top-N as an ordering and a limit', () => {
    expect(templateSql('top 5 products by revenue', true)).toBe(
      'select product, sum(amount) as total from orders group by 1 order by sum(amount) desc limit 5',
    );
  });

  it('puts a named region in a where clause rather than a group by', () => {
    expect(templateSql('revenue in the north', true)).toBe("select sum(amount) as total from orders where region = 'north'");
    expect(templateSql('web sales', true)).toBe("select sum(amount) as total from orders where channel = 'web'");
  });

  it('joins customers for a segment question and rewrites the measure to the join alias', () => {
    expect(templateSql('revenue by segment', true)).toBe(
      'select c.segment, sum(o.amount) as total from orders o join customers c on o.order_id = c.customer_id group by c.segment order by c.segment',
    );
  });

  it('answers a customer count from the customers table', () => {
    expect(templateSql('how many customers', true)).toBe('select segment, count(*) as customers from customers group by segment order by segment');
  });

  it('chooses a measure per phrase, and refuses the ones it has no measure for', () => {
    expect(templateSql('how many distinct products', true)).toBe(
      'select count(distinct product) as products from orders',
    );
    expect(templateSql('average order value', true)).toBe('select avg(amount) as aov from orders');
    expect(templateSql('average quantity', true)).toBe('select avg(quantity) as avg_quantity from orders');
    expect(templateSql('max revenue', true)).toBe('select max(amount) as max_amount from orders');
    expect(templateSql('min revenue', true)).toBe('select min(amount) as min_amount from orders');
    expect(templateSql('total quantity', true)).toBe('select sum(quantity) as units from orders');
    // A median is not in the measure table: returning a plausible SQL here would score a
    // miss as a modelling result instead of as a missing rule.
    expect(templateSql('median revenue', true)).toBeUndefined();
    expect(templateSql('what is the weather', true)).toBeUndefined();
  });

  it('reads the raw arm without the synonym fold, which is the ablation', () => {
    // "sales" is not a column; only normalization makes it one. This is the difference the
    // paired test measures, so it has to exist at the compiler level.
    expect(templateSql('sales by region', true)).toBe('select region, sum(amount) as total from orders group by 1 order by 1');
    expect(templateSql('sales by region', false)).toBeUndefined();
  });
});

describe('predictors', () => {
  const testCase = { id: 'q1', question: 'revenue by region', goldSql: 'select region, sum(amount) from orders group by 1', tags: ['group'] };

  it('brackets the scale with the oracle and the empty predictor', () => {
    expect(predict('oracle', testCase)).toBe(testCase.goldSql);
    expect(predict('empty', testCase)).toBe('select 1 as nothing where false');
  });

  it('falls back to the empty statement when the template cannot compile', () => {
    const unparseable = { ...testCase, question: 'median revenue' };
    expect(predict('template', unparseable)).toBe('select 1 as nothing where false');
    expect(predict('template-raw', unparseable)).toBe('select 1 as nothing where false');
  });

  it('compiles through both template arms when it can', () => {
    expect(predict('template', testCase)).toContain('sum(amount)');
    expect(predict('template-raw', testCase)).toContain('sum(amount)');
  });
});
