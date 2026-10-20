import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRunner } from '@agentix-e/nl2charts-core';
import type { Runner } from '@agentix-e/nl2charts-core';
import { createDuckDbEngine } from '@agentix-e/nl2charts-node';
import type { Engine } from '@agentix-e/nl2charts-core';
import { formatReport, recordCase, runContractSuite } from '../src/index.js';

let engine: Engine;
let runner: Runner;

beforeAll(async () => {
  engine = await createDuckDbEngine();
  runner = createRunner({ engine });
  await engine.run(`create table sales as select * from (values ('north', 10), ('south', 20)) t(region, amount)`);
});

afterAll(async () => {
  await runner.close();
});

describe('contract suite', () => {
  it('records a golden case and passes it unchanged', async () => {
    const golden = await recordCase(runner, 'totals', 'select region, sum(amount) as total from sales group by 1 order by 1');
    expect(golden.expect.rowCount).toBe(2);
    const report = await runContractSuite(runner, [golden]);
    expect(report).toMatchObject({ passed: 1, failed: 0 });
    expect(report.results[0]?.actualHash).toBe(golden.expect.hash);
  });

  it('fails on a changed hash, row count or column order', async () => {
    const report = await runContractSuite(runner, [
      { name: 'hash', sql: 'select 1 as a', expect: { hash: '0000000000000000' } },
      { name: 'rows', sql: 'select 1 as a', expect: { rowCount: 2 } },
      { name: 'columns', sql: 'select 1 as a', expect: { columns: ['b'] } },
      { name: 'values', sql: 'select 1 as a', expect: { rows: [{ a: 2 }] } },
    ]);
    expect(report.failed).toBe(4);
    expect(report.results.map((result) => result.detail)).toEqual([
      expect.stringContaining('hash:'),
      expect.stringContaining('rowCount:'),
      expect.stringContaining('columns:'),
      'rows: value mismatch',
    ]);
  });

  it('reports a rejected statement as a failure instead of throwing', async () => {
    const report = await runContractSuite(runner, [{ name: 'unsafe', sql: 'drop table sales', expect: {} }]);
    expect(report.failed).toBe(1);
    expect(report.results[0]?.detail).toContain('NL2C_E_GUARD_REJECTED');
  });

  it('reports an engine error as a failure with its code', async () => {
    const report = await runContractSuite(runner, [{ name: 'missing table', sql: 'select * from ghost', expect: {} }]);
    expect(report.results[0]?.detail).toContain('NL2C_E_ENGINE_FAILED');
  });

  it('formats a human-readable report', async () => {
    const report = await runContractSuite(runner, [
      { name: 'ok', sql: 'select 1 as a', expect: { rowCount: 1 } },
      { name: 'bad', sql: 'select 1 as a', expect: { rowCount: 3 } },
    ]);
    const text = formatReport(report.results);
    expect(text).toContain('PASS ok');
    expect(text).toContain('FAIL bad — rowCount: expected 3, got 1');
  });
});
