import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRunner } from '@agentix-e/nl2charts-core';
import type { Engine, Runner } from '@agentix-e/nl2charts-core';
import { createDuckDbEngine } from '../src/index.js';
import { liveCases, liveSchema } from '../../../eval/live/cases.js';

let engine: Engine;
let runner: Runner;

beforeAll(async () => {
  engine = await createDuckDbEngine();
  const fixture = readFileSync(new URL('../../../eval/fixtures/semantic.sql', import.meta.url), 'utf8');
  for (const statement of fixture.split(';').map((part) => part.trim()).filter((part) => part.length > 0)) {
    await engine.run(statement);
  }
  runner = createRunner({ engine, maxRows: 10_000 });
});

afterAll(async () => {
  await runner.close();
});

describe('live benchmark cases', () => {
  const cases = liveCases();

  it('generates 210 cases with unique ids and 20 intents', () => {
    expect(cases).toHaveLength(210);
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(210);
    expect(new Set(cases.map((entry) => entry.intent)).size).toBe(20);
  });

  it('every gold query runs and returns rows', async () => {
    for (const testCase of cases) {
      const result = await runner.sql(testCase.goldSql, { limit: 10_000 });
      expect(result.rows.length, `${testCase.id}: ${testCase.goldSql}`).toBeGreaterThan(0);
    }
  });

  it('keeps the schema noise table and enum samples', () => {
    expect(liveSchema.map((table) => table.table)).toEqual(['orders', 'customers', 'order_items']);
    const region = liveSchema[0]?.columns.find((column) => column.name === 'region');
    expect(region?.samples).toEqual(['north', 'south', 'east', 'west']);
  });

  it('asks a question that names the parameter it filters on', () => {
    const filtered = cases.filter((entry) => entry.intent === 'revenue_for_region');
    expect(filtered.length).toBeGreaterThanOrEqual(10);
    for (const testCase of filtered) {
      const region = /where region = '(\w+)'/.exec(testCase.goldSql)?.[1] ?? '';
      expect(testCase.question.toLowerCase()).toContain(region);
    }
  });
});
