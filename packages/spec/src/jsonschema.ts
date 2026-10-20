import { zodToJsonSchema } from 'zod-to-json-schema';
import { ChartIRSchema } from './ir.js';

/**
 * JSON Schema for the chart contract. Generated from the same zod object that
 * validates at runtime, so the published schema cannot drift from the parser.
 */
export function chartIrJsonSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(ChartIRSchema, {
    name: 'ChartIR',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://agentix-e.github.io/nl2charts/schema/chart-ir-3.0.json',
    ...schema,
  };
}
