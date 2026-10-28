import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { linkSchema } from '@agentix-e/nl2charts-ai';
import type { Recaller, SchemaTable } from '@agentix-e/nl2charts-ai';
import { ROOT } from './run.js';

/**
 * Schema-linking ablation. Each arm adds one recaller; a case counts as a hit
 * only when every expected column appears in the top 3, which is the budget the
 * prompt can afford.
 */
export const SCHEMA: SchemaTable[] = [
  {
    table: 'orders',
    columns: [
      { name: 'order_id', type: 'BIGINT', aliases: ['id'] },
      { name: 'order_date', type: 'DATE', aliases: ['date'] },
      { name: 'region', type: 'VARCHAR', aliases: ['area', 'territory'], samples: ['north', 'south', 'east', 'west'] },
      { name: 'channel', type: 'VARCHAR', samples: ['web', 'store'] },
      { name: 'product', type: 'VARCHAR', samples: ['widget', 'gadget', 'gizmo'] },
      { name: 'amount', type: 'DECIMAL', aliases: ['sales', 'revenue', 'value'] },
      { name: 'quantity', type: 'INTEGER', aliases: ['units'] },
    ],
  },
  {
    table: 'customers',
    columns: [
      { name: 'customer_id', type: 'BIGINT' },
      { name: 'segment', type: 'VARCHAR', samples: ['smb', 'enterprise', 'consumer'] },
      { name: 'region', type: 'VARCHAR', samples: ['north', 'south'] },
    ],
  },
];

export interface LinkingCase {
  readonly question: string;
  readonly expected: readonly string[];
}

export const CASES: readonly LinkingCase[] = [
  { question: 'revenue by region', expected: ['orders.amount', 'orders.region'] },
  { question: 'sales by territory', expected: ['orders.amount', 'orders.region'] },
  { question: 'orders in the north', expected: ['orders.order_id', 'orders.region'] },
  { question: 'web channel orders', expected: ['orders.channel', 'orders.order_id'] },
  { question: 'widget sales', expected: ['orders.product', 'orders.amount'] },
  { question: 'units sold', expected: ['orders.quantity'] },
  { question: 'order date trend', expected: ['orders.order_date'] },
  { question: 'customer segment counts', expected: ['customers.segment', 'customers.customer_id'] },
  { question: 'enterprise customers', expected: ['customers.segment'] },
  { question: 'gizmo revenue', expected: ['orders.product', 'orders.amount'] },
  { question: 'store sales', expected: ['orders.channel', 'orders.amount'] },
  { question: 'south region quantity', expected: ['orders.region', 'orders.quantity'] },
  { question: 'east customers', expected: ['customers.region'] },
  { question: 'average order value', expected: ['orders.amount', 'orders.order_id'] },
  { question: 'date and amount', expected: ['orders.order_date', 'orders.amount'] },
  { question: 'product by area', expected: ['orders.product', 'orders.region'] },
  { question: 'revenue by channel', expected: ['orders.amount', 'orders.channel'] },
  { question: 'smb segment sales', expected: ['customers.segment', 'orders.amount'] },
  { question: 'consumer orders', expected: ['customers.segment', 'orders.order_id'] },
  { question: 'south web revenue', expected: ['orders.region', 'orders.channel', 'orders.amount'] },
  { question: 'gadget units', expected: ['orders.product', 'orders.quantity'] },
  { question: 'id and channel', expected: ['orders.order_id', 'orders.channel'] },
  { question: 'territory and date', expected: ['orders.region', 'orders.order_date'] },
  { question: 'value by segment', expected: ['orders.amount', 'customers.segment'] },
  { question: 'north store widget', expected: ['orders.region', 'orders.channel', 'orders.product'] },
];

export const ARMS: Record<string, readonly Recaller[]> = {
  name: ['name'],
  'name+alias': ['name', 'alias'],
  'name+alias+value': ['name', 'alias', 'value'],
};

export function evaluate(recallers: readonly Recaller[]): { hits: number; misses: string[] } {
  const misses: string[] = [];
  for (const testCase of CASES) {
    const top = linkSchema(testCase.question, SCHEMA, 3, recallers).map((column) => `${column.table}.${column.column}`);
    const hit = testCase.expected.every((column) => top.includes(column));
    if (!hit) misses.push(`${testCase.question} -> ${top.join(',') || '(none)'}`);
  }
  return { hits: CASES.length - misses.length, misses };
}

export interface LinkingArmRow {
  readonly arm: string;
  readonly recallers: readonly Recaller[];
  readonly hits: number;
  readonly total: number;
  readonly recallAt3: number;
  readonly misses: readonly string[];
}

export interface LinkingAblation {
  readonly arms: readonly LinkingArmRow[];
  readonly baseline: LinkingArmRow;
  readonly best: LinkingArmRow;
  /** What the value recaller adds over name-only, in percentage points. */
  readonly gainPp: number;
  readonly outFile: string;
}

/**
 * Every arm is the previous one plus a recaller, so the delta between the first and the
 * last is the contribution of alias and value evidence together — which is the number the
 * prompt budget is decided on.
 */
export function runLinkingAblation(options: { readonly outDir?: string; readonly log?: (line: string) => void } = {}): LinkingAblation {
  const arms: LinkingArmRow[] = Object.entries(ARMS).map(([arm, recallers]) => {
    const { hits, misses } = evaluate(recallers);
    return { arm, recallers, hits, total: CASES.length, recallAt3: hits / CASES.length, misses };
  });

  const baseline = arms[0];
  const best = arms[arms.length - 1];
  if (baseline === undefined || best === undefined) throw new Error('no arms evaluated');

  const outDir = options.outDir ?? join(ROOT, 'eval/out');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'linking-ablation.json');
  writeFileSync(
    outFile,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), cases: CASES.length, topK: 3, arms }, null, 2)}\n`,
  );

  const gainPp = (best.recallAt3 - baseline.recallAt3) * 100;
  for (const arm of arms) {
    options.log?.(`${arm.arm.padEnd(18)} recall@3 ${(arm.recallAt3 * 100).toFixed(1)}% (${arm.hits}/${arm.total})`);
    for (const miss of arm.misses) options.log?.(`  MISS ${miss}`);
  }
  options.log?.(`\nlinking ablation: value profiler adds ${gainPp.toFixed(1)}pp over name-only`);
  return { arms, baseline, best, gainPp, outFile };
}

export function main(options: { readonly outDir?: string } = {}): number {
  runLinkingAblation({ ...options, log: (line) => console.log(line) });
  return 0;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main();
}
