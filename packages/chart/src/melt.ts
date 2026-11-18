/**
 * A table that is wide in time, read as the picture its shape states.
 *
 * The corpus contains tables shaped like this: one row per entity, one *column per period*, every
 * cell a number — `Oman | 1,203 | 1,180 | 1,164 …` across seven year columns. Nothing in the
 * contract could hold that shape, so the recommender had no picture for it. The census priced that
 * at 44 tables that no admission rule could chart; the first run after this predicate reports
 * **111** tables wide, and 107 of those were not refused at all — they were being drawn as the
 * wrong mark, five years read as the `min, q1, median, q3, max` of a boxplot the table never
 * stated. The refusal was honest — a chart of one row with seven measures is not a chart — but the
 * table is not one row: it is one row per entity per period, written sideways.
 *
 * Melting is the standard reshape (Wickham's `pivot_longer`): the period columns become one period
 * column and one value column, and the entity is repeated on every row it owns. The result is the
 * shape the `series` channel was added to the contract for, and both emitters now draw it as one
 * line per entity.
 *
 * The predicate is deliberately narrow, because a wrong melt is worse than a refusal: it would
 * rewrite a table that is not wide into one that is, and every reader downstream would be reading a
 * table the query did not return. Five conditions, each of them a real table this must not touch:
 *
 * 1. three period columns at least — two period columns are a pair, and a pair is not a timeline;
 * 2. exactly one column that is not a period, and that is the entity: two of them is a table with a
 *    label beside its entity, which this cannot melt without deciding which one to keep;
 * 3. every period column name reads as a period (`2019`, `2019-01`), not merely as four digits;
 * 4. every cell under them is a finite number or absent — a text cell means the column is a label
 *    that happens to be headed by a year, and `Number("n/a")` is not a measurement;
 * 5. every entity appears once. A repeated entity would melt into two series with the same name,
 *    which a legend cannot distinguish and a reader would read as one line drawn twice.
 *
 * The two names the melt invents are `Year` (or `Period`, when the columns are months) and `Value`.
 * A table whose entity column is already called one of them is declined rather than renamed: the
 * column names are the only thing downstream a reader can check the picture against.
 */

/** A column name that reads as a period: a year, or a year and a month. */
const PERIOD_COLUMN = /^(?:19|20)\d{2}(?:[-/](?:0?[1-9]|1[0-2]))?$/;

/** A column name that is a year on its own, which is what makes the axis a year axis. */
const BARE_YEAR = /^(?:19|20)\d{2}$/;

/** The column the melted measure lives in. */
const VALUE_NAME = 'Value';

/** A table read sideways, melted into the long form a series chart reads. */
export interface WideTable {
  /** One row per (entity, period) pair the table holds a number for. */
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  /** The column that names the entity — the first column of the table, unchanged. */
  readonly entity: string;
  /** The column the period moved into: `Year` or `Period`. */
  readonly period: string;
  /** The column the measure moved into. */
  readonly value: string;
}

/**
 * The long form of a wide table, or nothing when the table is not one.
 *
 * `columns` is the order the caller named, because `Object.keys` puts integer-like keys first and a
 * table `{ 2019: …, 2020: … }` would otherwise arrive with its periods before its entity.
 */
export function meltWide(
  rows: readonly Readonly<Record<string, unknown>>[],
  columns?: readonly string[],
): WideTable | undefined {
  const first = rows[0];
  if (first === undefined) return undefined;
  const names = columns ?? Object.keys(first);
  // The entity is the one column that is not a period, and there has to be exactly one. Position is
  // not the test, because position is not available: the language puts integer-like keys first, so a
  // table whose periods are named `2019` enumerates with every period ahead of the column that names
  // the entity. "One column is not a period, the rest are, and there are at least three of them" is
  // the same claim as "the first column is the entity" without depending on a property order that a
  // driver, a serializer or a language version can each change.
  const periods = names.filter((name) => PERIOD_COLUMN.test(name));
  const labels = names.filter((name) => !PERIOD_COLUMN.test(name));
  if (periods.length < 3 || labels.length !== 1) return undefined;
  const entity = labels[0] as string;
  // The name the period column will take, decided before anything is measured: a table of bare years
  // gets a year axis, and a table of months gets a period axis rather than a year it does not have.
  const periodName = periods.every((name) => BARE_YEAR.test(name)) ? 'Year' : 'Period';
  if (entity === periodName || entity === VALUE_NAME) return undefined;

  const cells = new Map<string, number>();
  const entities: string[] = [];
  for (const row of rows) {
    const name = row[entity];
    if (name === null || name === undefined) return undefined;
    const key = String(name);
    // A repeated entity is two rows about one thing: one of them would win silently.
    if (entities.includes(key)) return undefined;
    entities.push(key);
    for (const period of periods) {
      const cell = row[period];
      if (cell === null || cell === undefined) continue;
      if (typeof cell !== 'number' || !Number.isFinite(cell)) return undefined;
      cells.set(`${key}\u0000${period}`, cell);
    }
  }
  // A period column with no number anywhere is a column the table does not measure, which makes the
  // header a claim rather than a dimension.
  if (periods.some((period) => !entities.some((name) => cells.has(`${name}\u0000${period}`)))) return undefined;

  const melted: Record<string, unknown>[] = [];
  for (const name of entities) {
    for (const period of periods) {
      const cell = cells.get(`${name}\u0000${period}`);
      // An absent cell is not a zero: the row is not written, and the series chart draws the gap the
      // table states.
      if (cell !== undefined) melted.push({ [entity]: name, [periodName]: period, [VALUE_NAME]: cell });
    }
  }
  return { rows: melted, entity, period: periodName, value: VALUE_NAME };
}
