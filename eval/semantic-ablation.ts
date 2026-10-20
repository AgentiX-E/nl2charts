import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalRow, createRunner } from '@agentix-e/nl2charts-core';
import { compileQuery } from '@agentix-e/nl2charts-core/semantic';
import type { MetricQuery } from '@agentix-e/nl2charts-core/semantic';
import { createDuckDbEngine } from '@agentix-e/nl2charts-node';
import { ROOT } from './run.js';
import { salesModel } from './fixtures/semantic-model.js';

/**
 * Semantic compiler ablation.
 *
 * Arm A: optimized plan. Arm B: identical plan with the optimizer disabled.
 * A correct optimizer changes the SQL but not one row. The second measurement
 * is fan-out: what a hand-written join does to a measure, versus what the
 * compiler does when it aggregates at the metric grain first.
 */
const fixture = readFileSync(join(ROOT, 'eval/fixtures/semantic.sql'), 'utf8');
const engine = await createDuckDbEngine();
for (const statement of fixture.split(';').map((part) => part.trim()).filter((part) => part.length > 0)) {
  await engine.run(statement);
}
const runner = createRunner({ engine, maxRows: 10_000 });

function key(rows: readonly Readonly<Record<string, unknown>>[]): string {
  return rows.map((row) => JSON.stringify(canonicalRow(row))).sort().join('\n');
}

const metricSets: readonly (readonly string[])[] = [
  ['revenue'],
  ['orders'],
  ['aov'],
  ['net_revenue'],
  ['paid_rate'],
  ['avg_order'],
  ['tax'],
  ['revenue', 'orders'],
  ['ytd_revenue'],
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

const queries: MetricQuery[] = [];
for (const metrics of metricSets) {
  for (const dimensions of dimensionSets) {
    for (const filters of filterSets) {
      if (metrics.includes('ytd_revenue') && !dimensions.includes('month')) continue;
      if (queries.length < 200) queries.push({ metrics, dimensions, filters: filters as never });
    }
  }
}
if (queries.length !== 200) throw new Error(`expected 200 queries, generated ${queries.length}`);

const rowsOf = async (sql: string): Promise<readonly Readonly<Record<string, unknown>>[]> =>
  (await runner.sql(sql, { limit: 10_000 })).rows;

let equivalent = 0;
let optimizedCtes = 0;
let plainCtes = 0;
const mismatches: string[] = [];
for (const query of queries) {
  const optimized = compileQuery(query, salesModel);
  const plain = compileQuery(query, salesModel, { optimize: false });
  optimizedCtes += optimized.sqlPlan.ctes.length;
  plainCtes += plain.sqlPlan.ctes.length;
  const [left, right] = await Promise.all([rowsOf(optimized.sql), rowsOf(plain.sql)]);
  if (key(left) === key(right) && left.length === right.length) equivalent += 1;
  else mismatches.push(JSON.stringify(query));
}

const fanout: { query: string; naive: number; compiled: number; ratio: number }[] = [];
for (const segment of ['smb', 'enterprise', 'consumer']) {
  const naive = await rowsOf(
    `select c.segment, sum(o.amount) filter (where o.status = 'completed') as revenue from orders o join order_items i on i.order_id = o.order_id join customers c on o.customer_id = c.customer_id where c.segment = '${segment}' group by 1`,
  );
  const compiled = await rowsOf(compileQuery({ metrics: ['revenue'], dimensions: ['segment'], filters: [{ column: 'customers.segment', op: '=', value: segment }] }, salesModel).sql);
  const naiveTotal = naive.reduce((total, row) => total + Number(row.revenue ?? 0), 0);
  const compiledTotal = compiled.reduce((total, row) => total + (row.segment === segment ? Number(row.revenue ?? 0) : 0), 0);
  fanout.push({ query: segment, naive: naiveTotal, compiled: compiledTotal, ratio: compiledTotal === 0 ? 0 : naiveTotal / compiledTotal });
}

const report = {
  generatedAt: new Date().toISOString(),
  dataset: 'eval/fixtures/semantic.sql',
  cases: queries.length,
  equivalence: { passed: equivalent, total: queries.length, rate: equivalent / queries.length, mismatches },
  optimizer: {
    averageCtesOptimized: optimizedCtes / queries.length,
    averageCtesUnoptimized: plainCtes / queries.length,
    reduction: 1 - optimizedCtes / plainCtes,
  },
  fanout: { cases: fanout, minRatio: Math.min(...fanout.map((entry) => entry.ratio)) },
};

mkdirSync(join(ROOT, 'eval/out'), { recursive: true });
writeFileSync(join(ROOT, 'eval/out/semantic-ablation.json'), `${JSON.stringify(report, null, 2)}\n`);

console.log(`\nsemantic optimizer: ${equivalent}/${queries.length} identical result sets`);
console.log(`  CTEs per query: ${report.optimizer.averageCtesUnoptimized.toFixed(2)} -> ${report.optimizer.averageCtesOptimized.toFixed(2)} (${(report.optimizer.reduction * 100).toFixed(1)}% fewer)`);
for (const entry of fanout) {
  console.log(`  fan-out ${entry.query.padEnd(10)} naive ${entry.naive.toFixed(2)} vs compiled ${entry.compiled.toFixed(2)} (${entry.ratio.toFixed(2)}x)`);
}
if (equivalent !== queries.length) throw new Error('optimizer changed at least one result set');
if (report.fanout.minRatio < 2) throw new Error('fan-out fixture no longer reproduces the trap');
await runner.close();
