import { z } from 'zod';
import { ChartIRSchema } from './ir.js';

/**
 * JSON Schema for the chart contract. Generated from the same zod object that
 * validates at runtime, so the published schema cannot drift from the parser.
 *
 * The generator is zod's own since the migration to v4: the third-party bridge read the v3
 * node types, so it could not describe a v4 schema at all.
 *
 * This function used to declare draft 2020-12 in a line that the spread below overwrote, so the
 * document it published was draft-07 while the source said otherwise — and the only reason the
 * `Ajv` test passed is that a draft-07 document is what a default `Ajv` instance compiles. The
 * declaration now comes from the generator, so it cannot disagree with the content again, and the
 * `$id` — the part consumers actually resolve — is unchanged.
 */
export function chartIrJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(ChartIRSchema, {
    target: 'draft-7',
    io: 'output',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  const { $schema: declared, ...rest } = generated;
  return {
    // The generator's own declaration, and a default only for the case where it emits none: a
    // document whose `$schema` disagrees with the keywords it uses is a document that fails to
    // compile in the validator its own test uses.
    $schema: declared ?? 'http://json-schema.org/draft-07/schema#',
    $id: 'https://agentix-e.github.io/nl2charts/schema/chart-ir-3.0.json',
    ...rest,
  };
}
