/**
 * The competitor's card rule, at the granularity its selector actually uses.
 *
 * `columns.ts` prices one application of a model's reading: keep what it named, drop everything
 * else, and let a table vanish when none of its columns were named. On Mini-Dev that measured
 * −5.65pp (250/496 = 50.40% against a parent's 56.05%, p=0.0020, MDE 4.99pp), and the reading
 * that number supports was the wrong one: MAC-SQL's selector does not decide per column, it
 * decides per table, and its `drop_all` **keeps a table's first six columns**. Their cut is
 * milder than the one this repository priced, so "the selector lever is worth −5.65pp" is a
 * statement about *our* application rule and not about theirs.
 *
 * This module is their rule, transcribed from `macsql_agents.py::_get_db_desc_str`
 * (pinned `mac-sql@31a9df5e`), and it differs from `applyColumnChoice` in exactly one place —
 * what is done with a table the model did not name:
 *
 * | | `applyColumnChoice` | `applyDenseChoice` |
 * | --- | --- | --- |
 * | table with ≥1 named column | keeps the named columns and the join keys between surviving tables | keeps the named columns, the keys, and pads back to six when the table is wider than six |
 * | table with no named column | **dropped** | **kept with its first six columns** |
 * | a card's join still writable | only between the tables that survived | always, because every table survives |
 *
 * Three properties of their rule are load-bearing and none of them is a detail:
 *
 * 1. **No table is ever removed.** `drop_all` is a column cut, not a table cut. A schema card is
 *    the only place a foreign key is declared, so a dropped table is a join the model cannot see
 *    it can make — and the column-level arm's loss is the size of that mistake.
 * 2. **Six is a floor, not a target.** A table narrower than six columns loses nothing under
 *    `drop_all` (`columns[:6]` is the whole table), and a table the model chose from is padded
 *    back to six in declared order when its choice came in short. The rule compresses wide
 *    tables only.
 * 3. **A table the model never mentions is decided by the fallback.** Their `_get_db_desc_str`
 *    reads `extracted_schema.get(table_name, '')` and `''` lands in the `keep_all` branch. This
 *    module cannot reproduce that branch, because our prompt asks for a list of columns rather
 *    than a decision per table: a table with no named column is *unreachable as keep_all* and is
 *    therefore read as `drop_all`. That is the aggressive reading, it is the one that differs
 *    from `columns.ts`, and it is what the arm is for — sending six columns of a table the model
 *    did not name is the safety net, and the net's size is what the run reports as `restored`.
 *
 * One thing this rule cannot carry: `important_keys` is `primary_keys + foreign_keys`, and the
 * schema card here has no primary-key marker (the card is built from `PRAGMA table_info` without
 * the `pk` flag). The keys this module always keeps are therefore the foreign keys the card
 * declares, which is the half of their rule the card can express. A card with no foreign keys
 * gets no key retention at all, and that is reported rather than papered over.
 */
import type { SchemaTable } from '@agentix-e/nl2charts-ai';
import type { ColumnApplication, ColumnChoice } from './columns.js';

/**
 * The columns a table keeps when the model named none of them.
 *
 * Six, because their `drop_all` branch is `deepcopy(columns_desc[:6])` and their padding loop
 * stops at six (`if len(append_col_names) >= 6: break`). It is one constant rather than two
 * because the two uses are the same sentence: a table is never shown with fewer than six
 * columns, and never with fewer than it needs.
 */
export const DENSE_FLOOR = 6;

/** A card after the dense rule, with the size of its safety net. */
export interface DenseApplication extends ColumnApplication {
  /**
   * Columns kept that the model did not name: the floor and the declared foreign keys.
   *
   * This is the mechanism's own size. An arm whose `restored` is zero is `columns.ts` under
   * another name, and an arm whose `restored` is most of the card is a card that never shrank —
   * the two ways a rule like this can silently measure nothing.
   */
  readonly restored: number;
}

const lower = (value: string): string => value.toLowerCase();

/** The columns of one table that its own join hints name, lower-cased. */
function keyColumns(table: SchemaTable): Set<string> {
  const keys = new Set<string>();
  for (const hint of table.foreignKeys ?? []) {
    for (const side of hint.split('=')) {
      const [tablePart, columnPart] = side.trim().split('.');
      if (tablePart === undefined || columnPart === undefined) continue;
      if (lower(tablePart) !== lower(table.table)) continue;
      keys.add(lower(columnPart));
    }
  }
  return keys;
}

/**
 * Send the card with every table kept, six columns deep where the choice did not reach.
 *
 * Column order is the card's own, for the reason `prune` and `columns` both state: the renderer's
 * order is part of the prompt, and re-sorting by choice would move columns for a reason that is
 * not the lever. Their padding loop appends in declared order, so declared order is also their
 * answer — this is not a place where the two rules disagree.
 *
 * An undecided choice returns the whole card, the same fallback `applyColumnChoice` uses, and
 * for the same reason: a card built from a reply that resolved nothing is a card that says
 * nothing, which is the one failure no wording can repair. The fallback is about the link
 * between reply and card, not about the rule, so both arms share it and neither pays for it in
 * the comparison.
 */
export function applyDenseChoice(schema: readonly SchemaTable[], choice: ColumnChoice): DenseApplication {
  const total = schema.reduce((count, table) => count + table.columns.length, 0);
  if (!choice.decided) {
    return { schema, kept: total, total, keptTables: schema.map((table) => table.table), restored: 0 };
  }
  const chosen = new Map<string, Set<string>>();
  for (const entry of choice.named) {
    const key = lower(entry.table);
    const names = chosen.get(key) ?? new Set<string>();
    names.add(lower(entry.column));
    chosen.set(key, names);
  }
  let kept = 0;
  const keptTables: string[] = [];
  const pruned = schema.map((table) => {
    const named = chosen.get(lower(table.table));
    let keep: Set<string>;
    if (named === undefined) {
      // `drop_all`: the first six columns, in the card's order. A table narrower than the floor
      // keeps all of them, which is why the rule only compresses wide tables.
      keep = new Set(table.columns.slice(0, DENSE_FLOOR).map((column) => lower(column.name)));
    } else {
      const keys = keyColumns(table);
      keep = new Set(
        table.columns
          .filter((column) => keys.has(lower(column.name)) || named.has(lower(column.name)))
          .map((column) => lower(column.name)),
      );
      if (table.columns.length > DENSE_FLOOR && keep.size < DENSE_FLOOR) {
        for (const column of table.columns) {
          if (keep.size >= DENSE_FLOOR) break;
          keep.add(lower(column.name));
        }
      }
    }
    const columns = table.columns.filter((column) => keep.has(lower(column.name)));
    kept += columns.length;
    keptTables.push(table.table);
    return { ...table, columns };
  });
  return { schema: pruned, kept, total, keptTables, restored: kept - choice.named.length };
}
