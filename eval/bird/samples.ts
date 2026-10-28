/**
 * Values on the card: what a categorical column actually contains, shown on its own line.
 *
 * The `values` lever puts instance knowledge in a separate block, built from the question's
 * own literals matched against the cells. That block is empty exactly when the question
 * spells a value differently from the store — which is the case it exists to fix, and it was
 * empty on 60.9% of the questions that offered it.
 *
 * This is the unconditional half: `status TEXT [Banned|Active]` is in front of the model
 * whether or not the question said "banned". It costs prompt length rather than a call, and
 * its risk is the one `renderSchemaCard` warns about — samples invite invented filters —
 * which is why it is a lever measured against its parent and not a default.
 */
import type { DatabaseProfile } from '@agentix-e/nl2charts-ai';
import type { SchemaTable } from '@agentix-e/nl2charts-ai';

/** `table.column` → the stored values, in profile order (frequency, then value). */
export function sampleValuesOf(profile: DatabaseProfile): Map<string, readonly string[]> {
  const byColumn = new Map<string, readonly string[]>();
  for (const entry of profile.columns) {
    if (entry.values === undefined || entry.values.length === 0) continue;
    byColumn.set(`${entry.table}.${entry.column}`, entry.values);
  }
  return byColumn;
}

/**
 * Return the schema with `samples` attached where a value set exists.
 *
 * A decorator, not a second schema: an arm can ask for samples *and* for inline
 * definitions, and a parallel map built from the bare schema would drop the other lever
 * without anyone editing the arm — which is the shape the single-lever test exists to
 * refuse. Columns the profile has no values for are returned unchanged rather than with an
 * empty array, so the renderer's `length > 0` test keeps meaning something.
 */
export function attachSamples(
  schema: readonly SchemaTable[],
  values: ReadonlyMap<string, readonly string[]>,
): SchemaTable[] {
  return schema.map((table) => ({
    ...table,
    columns: table.columns.map((column) => {
      const samples = values.get(`${table.table}.${column.name}`);
      return samples === undefined ? column : { ...column, samples };
    }),
  }));
}
