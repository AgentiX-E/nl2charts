/**
 * Semantic compiler ablation.
 *
 * Arm A: optimized plan. Arm B: identical plan with the optimizer disabled.
 * A correct optimizer changes the SQL but not one row. The second measurement
 * is fan-out: what a hand-written join does to a measure, versus what the
 * compiler does when it aggregates at the metric grain first.
 *
 * The measurement is a function and the printing is the caller's, so the property this
 * file exists for — 200 of 200 result sets identical, fan-out reproduced on all three
 * segments — can be asserted in a test instead of inferred from a job log.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { canonicalRow, createRunner } from '@agentix-e/nl2charts-core';
import { compileQuery } from '@agentix-e/nl2charts-core/semantic';
import type { MetricQuery } from '@agentix-e/nl2charts-core/semantic';
import { createDuckDbEngine } from '@agentix-e/nl2charts-node';
import { ROOT } from './run.js';
import { salesModel } from './fixtures/semantic-model.js';

/** The metric and dimension vocabulary the fixture supports. Exported for the test's eye. */
export const METRIC_SETS: readonly (readonly string[])[] = [
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
export const DIMENSION_SETS: readonly (readonly string[])[] = [
  [],
  ['region'],
  ['channel'],
  ['month'],
  ['segment'],
  ['region', 'channel'],
  ['month', 'region'],
  ['status', 'region'],
];
export const FILTER_SETS: readonly (readonly { column: string; op: '=' | 'in'; value: string | readonly string[] }[])[] = [
  [],
  [{ column: 'orders.status', op: '=', value: 'completed' }],
  [{ column: 'orders.region', op: 'in', value: ['north', 'east'] }],
  [{ column: 'orders.channel', op: '=', value: 'web' }],
];

/** The query set: 200 cases, stopping at the budget the report is quoted on. */
export function buildQueries(limit = 200): MetricQuery[] {
  const queries: MetricQuery[] = [];
  for (const metrics of METRIC_SETS) {
    for (const dimensions of DIMENSION_SETS) {
      for (const filters of FILTER_SETS) {
        if (metrics.includes('ytd_revenue') && !dimensions.includes('month')) continue;
        if (queries.length < limit) queries.push({ metrics, dimensions, filters: filters as never });
      }
    }
  }
  if (queries.length !== limit) throw new Error(`expected ${String(limit)} queries, generated ${String(queries.length)}`);
  return queries;
}

function key(rows: readonly Readonly<Record<string, unknown>>[]): string {
  return rows.map((row) => JSON.stringify(canonicalRow(row))).sort().join('\n');
}

export interface SemanticReport {
  readonly generatedAt: string;
  readonly dataset: string;
  readonly cases: number;
  readonly equivalence: { readonly passed: number; readonly total: number; readonly rate: number; readonly mismatches: readonly string[] };
  readonly optimizer: { readonly averageCtesOptimized: number; readonly averageCtesUnoptimized: number; readonly reduction: number };
  readonly fanout: { readonly cases: readonly { query: string; naive: number; compiled: number; ratio: number }[]; readonly minRatio: number };
}

export interface SemanticAblation {
  readonly report: SemanticReport;
  readonly outFile: string;
}

export async function runSemanticAblation(
  options: { readonly outDir?: string; readonly log?: (line: string) => void } = {},
): Promise<SemanticAblation> {
  const model = salesModel;
  const fixture = readFileSync(join(ROOT, 'eval/fixtures/semantic.sql'), 'utf8');
  const engine = await createDuckDbEngine();
  const runner = createRunner({ engine, maxRows: 10_000 });
  try {
    for (const statement of fixture.split(';').map((part) => part.trim()).filter((part) => part.length > 0)) {
      await engine.run(statement);
    }

    const rowsOf = async (sql: string): Promise<readonly Readonly<Record<string, unknown>>[]> =>
      (await runner.sql(sql, { limit: 10_000 })).rows;

    const queries = buildQueries();
    let equivalent = 0;
    let optimizedCtes = 0;
    let plainCtes = 0;
    const mismatches: string[] = [];
    for (const query of queries) {
      const optimized = compileQuery(query, model);
      const plain = compileQuery(query, model, { optimize: false });
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
      const compiled = await rowsOf(
        compileQuery({ metrics: ['revenue'], dimensions: ['segment'], filters: [{ column: 'customers.segment', op: '=', value: segment }] }, model).sql,
      );
      const naiveTotal = naive.reduce((total, row) => total + Number(row.revenue ?? 0), 0);
      const compiledTotal = compiled.reduce((total, row) => total + (row.segment === segment ? Number(row.revenue ?? 0) : 0), 0);
      fanout.push({ query: segment, naive: naiveTotal, compiled: compiledTotal, ratio: compiledTotal === 0 ? 0 : naiveTotal / compiledTotal });
    }

    const report: SemanticReport = {
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

    const outDir = options.outDir ?? join(ROOT, 'eval/out');
    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, 'semantic-ablation.json');
    writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

    options.log?.(`\nsemantic optimizer: ${String(equivalent)}/${String(queries.length)} identical result sets`);
    options.log?.(
      `  CTEs per query: ${report.optimizer.averageCtesUnoptimized.toFixed(2)} -> ${report.optimizer.averageCtesOptimized.toFixed(2)} (${(report.optimizer.reduction * 100).toFixed(1)}% fewer)`,
    );
    for (const entry of fanout) {
      options.log?.(
        `  fan-out ${entry.query.padEnd(10)} naive ${entry.naive.toFixed(2)} vs compiled ${entry.compiled.toFixed(2)} (${entry.ratio.toFixed(2)}x)`,
      );
    }

    // The two assertions are the reason this file exists: an optimizer that changes a result
    // set is a correctness bug, and a fixture that no longer reproduces fan-out has stopped
    // testing the thing it was built to test.
    if (equivalent !== queries.length) throw new Error('optimizer changed at least one result set');
    if (report.fanout.minRatio < 2) throw new Error('fan-out fixture no longer reproduces the trap');
    return { report, outFile };
  } finally {
    await runner.close();
  }
}

export async function main(options: { readonly outDir?: string } = {}): Promise<number> {
  await runSemanticAblation({ ...options, log: (line) => console.log(line) });
  return 0;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
