import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalRow, createRunner } from '@agentix-e/nl2charts-core';
import type { Runner } from '@agentix-e/nl2charts-core';
import { compileQuery } from '@agentix-e/nl2charts-core/semantic';
import type { MetricQuery, SemanticModel } from '@agentix-e/nl2charts-core/semantic';
import { isNl2ChartsError } from '@agentix-e/nl2charts-spec';
import { createDuckDbEngine } from '../src/index.js';
import type { Engine } from '@agentix-e/nl2charts-core';
import { salesModel, secureModel } from '../../../eval/fixtures/semantic-model.js';

let engine: Engine;
let runner: Runner;

const fixture = readFileSync(new URL('../../../eval/fixtures/semantic.sql', import.meta.url), 'utf8');

beforeAll(async () => {
  engine = await createDuckDbEngine();
  for (const statement of fixture.split(';').map((part) => part.trim()).filter((part) => part.length > 0)) {
    await engine.run(statement);
  }
  runner = createRunner({ engine, maxRows: 10_000 });
});

afterAll(async () => {
  await runner.close();
});

async function rowsOf(sql: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
  return (await runner.sql(sql, { limit: 10_000 })).rows;
}

function same(left: readonly Readonly<Record<string, unknown>>[], right: readonly Readonly<Record<string, unknown>>[]): boolean {
  const key = (rows: readonly Readonly<Record<string, unknown>>[]): string =>
    rows.map((row) => JSON.stringify(canonicalRow(row))).sort().join('\n');
  return left.length === right.length && key(left) === key(right);
}

function sumOf(rows: readonly Readonly<Record<string, unknown>>[], column: string): number {
  return rows.reduce((total, row) => total + Number(row[column] ?? 0), 0);
}

const GOLD: Record<string, string> = {
  revenue_region:
    "select region, sum(amount) filter (where status = 'completed') as revenue from orders group by region order by region",
  revenue_global: "select sum(amount) filter (where status = 'completed') as revenue from orders",
  aov_region:
    "select region, sum(amount) filter (where status = 'completed') / count(order_id) as aov from orders group by region order by region",
  net_region:
    "select region, sum(amount) filter (where status = 'completed') - sum(tax) filter (where status = 'completed') as net_revenue from orders group by region order by region",
  paid_region:
    "select region, count(*) filter (where status = 'completed') / count(*) as paid_rate from orders group by region order by region",
  avg_region: 'select region, avg(amount) as avg_order from orders group by region order by region',
  segment_revenue:
    "select c.segment, sum(o.amount) filter (where o.status = 'completed') as revenue from orders o join customers c on o.customer_id = c.customer_id group by c.segment order by c.segment",
  multiple:
    "select region, sum(amount) filter (where status = 'completed') as revenue, count(order_id) as orders from orders group by region order by region",
  ytd_month:
    "with monthly as (select date_trunc('month', order_date) as month, sum(amount) filter (where status = 'completed') as revenue from orders group by 1) select month, sum(revenue) over (order by month rows between unbounded preceding and current row) as ytd_revenue from monthly order by month",
};

describe('compiled SQL against hand-written gold', () => {
  it.each([
    ['revenue by region', { metrics: ['revenue'], dimensions: ['region'] }, 'revenue_region'],
    ['revenue globally', { metrics: ['revenue'] }, 'revenue_global'],
    ['average order value', { metrics: ['aov'], dimensions: ['region'] }, 'aov_region'],
    ['derived net revenue', { metrics: ['net_revenue'], dimensions: ['region'] }, 'net_region'],
    ['conversion rate', { metrics: ['paid_rate'], dimensions: ['region'] }, 'paid_region'],
    ['non-additive average', { metrics: ['avg_order'], dimensions: ['region'] }, 'avg_region'],
    ['dimension from a joined table', { metrics: ['revenue'], dimensions: ['segment'] }, 'segment_revenue'],
    ['two metrics at once', { metrics: ['revenue', 'orders'], dimensions: ['region'] }, 'multiple'],
    ['cumulative revenue', { metrics: ['ytd_revenue'], dimensions: ['month'] }, 'ytd_month'],
  ] as const)('%s matches the gold query', async (_name, query, goldKey) => {
    const compiled = compileQuery(query as MetricQuery, salesModel);
    expect(same(await rowsOf(compiled.sql), await rowsOf(GOLD[goldKey] as string))).toBe(true);
  });

  it('applies query filters to the compiled statement', async () => {
    const compiled = compileQuery(
      { metrics: ['revenue'], dimensions: ['region'], filters: [{ column: 'orders.region', op: 'in', value: ['north', 'east'] }] },
      salesModel,
    );
    const rows = await rowsOf(compiled.sql);
    expect(rows.map((row) => row.region).sort()).toEqual(['east', 'north']);
  });

  it('uses an inner join when the dimension table is filtered', async () => {
    const compiled = compileQuery(
      { metrics: ['revenue'], dimensions: ['segment'], filters: [{ column: 'customers.segment', op: '=', value: 'consumer' }] },
      salesModel,
    );
    expect(compiled.sql).toContain('INNER JOIN');
    const rows = await rowsOf(compiled.sql);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.segment).toBe('consumer');
  });

  it('honours a limit after aggregation', async () => {
    const compiled = compileQuery({ metrics: ['revenue'], dimensions: ['region'], limit: 2 }, salesModel);
    expect(await rowsOf(compiled.sql)).toHaveLength(2);
  });
});

describe('row-level security and masking', () => {
  it('injects the row predicate into every read and restricts results', async () => {
    const compiled = compileQuery({ metrics: ['revenue'], dimensions: ['region'] }, secureModel);
    expect(compiled.sql).toContain('"region" = \'north\'');
    const rows = await rowsOf(compiled.sql);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.region === 'north')).toBe(true);
  });

  it('cannot be escaped by a contradictory query filter', async () => {
    const compiled = compileQuery(
      { metrics: ['revenue'], dimensions: ['region'], filters: [{ column: 'orders.region', op: '=', value: 'south' }] },
      secureModel,
    );
    expect(await rowsOf(compiled.sql)).toHaveLength(0);
  });

  it('refuses a masked dimension', () => {
    try {
      compileQuery({ metrics: ['revenue'], dimensions: ['email'] }, salesModel);
      throw new Error('expected a rejection');
    } catch (error) {
      expect(isNl2ChartsError(error) && error.details.code).toBe('MASKED_COLUMN');
    }
  });
});

describe('fan-out protection', () => {
  it('never joins a one-to-many table unless a dimension needs it', async () => {
    const compiled = compileQuery({ metrics: ['revenue'], dimensions: ['segment'] }, salesModel);
    expect(compiled.sql).not.toContain('order_items');
    expect(same(await rowsOf(compiled.sql), await rowsOf(GOLD.segment_revenue as string))).toBe(true);
  });

  it('a naive join inflates the number and the compiler does not', async () => {
    const naive = await rowsOf(
      "select c.segment, sum(o.amount) filter (where o.status = 'completed') as revenue from orders o join order_items i on i.order_id = o.order_id join customers c on o.customer_id = c.customer_id group by 1",
    );
    const compiled = await rowsOf(compileQuery({ metrics: ['revenue'], dimensions: ['segment'] }, salesModel).sql);
    const ratio = sumOf(naive, 'revenue') / sumOf(compiled, 'revenue');
    expect(ratio).toBeGreaterThan(2);
    expect(same(compiled, await rowsOf(GOLD.segment_revenue as string))).toBe(true);
  });
});

describe('optimizer equivalence over generated queries', () => {
  const metricSets: readonly (readonly string[])[] = [
    ['revenue'],
    ['orders'],
    ['aov'],
    ['net_revenue'],
    ['paid_rate'],
    ['avg_order'],
    ['tax'],
    ['ytd_revenue'],
    ['revenue', 'orders'],
  ];
  const dimensionSets: readonly (readonly string[])[] = [
    [],
    ['region'],
    ['channel'],
    ['month'],
    ['segment'],
    ['region', 'channel'],
    ['month', 'region'],
    ['status', 'region'],
  ];
  const filterSets: readonly (readonly { column: string; op: '=' | 'in'; value: string | readonly string[] }[])[] = [
    [],
    [{ column: 'orders.status', op: '=', value: 'completed' }],
    [{ column: 'orders.region', op: 'in', value: ['north', 'east'] }],
    [{ column: 'orders.channel', op: '=', value: 'web' }],
  ];

  function cases(): MetricQuery[] {
    const output: MetricQuery[] = [];
    for (const metrics of metricSets) {
      for (const dimensions of dimensionSets) {
        for (const filters of filterSets) {
          for (const limit of [undefined, 5] as const) {
            if (metrics.includes('ytd_revenue') && !dimensions.includes('month')) continue;
            output.push({ metrics, dimensions, filters: filters as never, ...(limit === undefined ? {} : { limit }) });
          }
        }
      }
    }
    return output;
  }

  it('produces 200 cases and every one survives optimization unchanged', async () => {
    const all = cases();
    expect(all.length).toBeGreaterThanOrEqual(200);
    const selected = all.slice(0, 200);
    for (const query of selected) {
      const optimized = compileQuery(query, salesModel);
      const plain = compileQuery(query, salesModel, { optimize: false });
      const [left, right] = await Promise.all([rowsOf(optimized.sql), rowsOf(plain.sql)]);
      expect(same(left, right), `${JSON.stringify(query)}\n${optimized.sql}`).toBe(true);
    }
  });

  it('deduplicates reads for a ratio while preserving rows', async () => {
    const optimized = compileQuery({ metrics: ['aov'], dimensions: ['region'] }, salesModel);
    const plain = compileQuery({ metrics: ['aov'], dimensions: ['region'] }, salesModel, { optimize: false });
    expect(optimized.sqlPlan.ctes.length).toBeLessThan(plain.sqlPlan.ctes.length);
    expect(same(await rowsOf(optimized.sql), await rowsOf(plain.sql))).toBe(true);
  });
});

describe('plan shape', () => {
  it('keeps metric semantics visible in the plan', () => {
    const model: SemanticModel = salesModel;
    const compiled = compileQuery({ metrics: ['ytd_revenue'], dimensions: ['month'] }, model);
    const serialized = JSON.stringify(compiled.optimizedPlan);
    expect(serialized).toContain('"kind":"window"');
    expect(serialized).toContain('unbounded preceding');
  });
});
