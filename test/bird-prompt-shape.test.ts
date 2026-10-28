import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderSchemaCard } from '@agentix-e/nl2charts-ai';
import type { SchemaTable } from '@agentix-e/nl2charts-ai';
import { BIRD_CARD, BIRD_SCHEMA_LINES } from '../eval/bird/prompt-shape.js';

/**
 * The card that three call sites have to agree on.
 *
 * The runner renders it into the prompt, the coverage control counts the tables that
 * reached it, and the recall gate renders it again to check that every gold identifier is
 * visible. They disagreed: the control rendered at 2,000 lines while the arms sent 400,
 * and the gate rendered at the default 40 with no column descriptions at all. Both were
 * green. A gate that measures a prompt nobody sends is worse than no gate, because it
 * spends the reader's trust on the wrong object.
 */

/** The worst case in the dev split: `formula_1`, 13 tables and 29 join hints. */
const WORST_CASE = { tables: 13, foreignKeys: 29 };

function worstCaseSchema(): SchemaTable[] {
  const schema: SchemaTable[] = [];
  for (let index = 0; index < WORST_CASE.tables; index += 1) {
    schema.push({
      table: `table_${index}`,
      columns: [{ name: 'id', type: 'INTEGER' }, { name: `value_${index}`, type: 'TEXT' }],
      ...(index === 0
        ? { foreignKeys: Array.from({ length: WORST_CASE.foreignKeys }, (_, key) => `table_0.id = table_${key % WORST_CASE.tables}.id`) }
        : {}),
    });
  }
  return schema;
}

describe('the BIRD schema card has one shape', () => {
  it('keeps the limit and the card options in the same object', () => {
    // A second literal is how the two call sites drifted in the first place.
    expect(BIRD_CARD.schemaLines).toBe(BIRD_SCHEMA_LINES);
  });

  it('fits the largest database in the split, foreign keys included', () => {
    // Not a tautology: this is the assertion that would have caught the 2,000-versus-400
    // drift the day the limit was lowered, and the one that fails if it is lowered again
    // without re-measuring the split.
    const card = renderSchemaCard(worstCaseSchema(), BIRD_SCHEMA_LINES, BIRD_CARD);
    const shown = card.split('\n').filter((line) => !line.startsWith('  ')).length;
    expect(shown).toBe(WORST_CASE.tables);
    // The join hints have to survive too: they are the reason the limit is counted in
    // lines rather than tables.
    expect(card.split('\n').filter((line) => line.startsWith('  join: ')).length).toBe(WORST_CASE.foreignKeys);
  });

  it('drops tables below the limit, which is why the limit is checked', () => {
    // The failure mode the gate now refuses: a card shorter than the schema is silent.
    const card = renderSchemaCard(worstCaseSchema(), 5, BIRD_CARD);
    const shown = card.split('\n').filter((line) => !line.startsWith('  ')).length;
    expect(shown).toBeLessThan(WORST_CASE.tables);
  });
});

describe('no call site renders the card with its own number', () => {
  const sources = ['eval/bird/run.ts', 'eval/bird/recall.ts'];

  function source(file: string): string {
    return readFileSync(resolve(process.cwd(), file), 'utf8');
  }

  it('passes the shared constant to renderSchemaCard and to the prompt options', () => {
    for (const file of sources) {
      const text = source(file);
      // `schemaLines: 400` written out again is the exact drift this test exists for.
      const literal = /schemaLines:\s*\d/.exec(text);
      expect(literal?.[0], file).toBeUndefined();
      // `renderSchemaCard(schema, 2000, ...)` — a numeric second argument is a second limit.
      const numeric = /renderSchemaCard\([^)]*?,\s*\d/.exec(text);
      expect(numeric?.[0], file).toBeUndefined();
    }
  });

  it('renders the gate prompt with the notes the arms send', () => {
    // Without this the gate checks a sparser card: no descriptions, no join hints. The
    // dev split still passes, which is exactly why the drift went unnoticed.
    const recall = source('eval/bird/recall.ts');
    expect(recall).toContain('withNotes: true');
    expect(recall).toContain('...BIRD_CARD');
  });
});
