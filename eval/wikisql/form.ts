/**
 * WikiSQL's logical form, and the statement it denotes.
 *
 * WikiSQL does not ask a system for SQL. It asks for a *logical form* — `{sel, agg, conds}` over
 * column indices — and the reference judge turns both sides into the same `SELECT … AS result`
 * template before comparing result sets. That choice is why the corpus can be scored with one
 * single-table, single-condition query per question and still be a benchmark: the template removes
 * every degree of freedom except the three the annotation records.
 *
 * This file is the template, and it is deliberately a re-implementation rather than a wrapper: the
 * reference `lib/dbengine.py` binds condition values as parameters through `records`, and the
 * oracle this repository executes through takes one statement string. A literal is therefore
 * inlined where the reference passes a bound parameter. That is safe for the same reason SQLite's
 * column affinity exists: `col0 = '1998'` and `col0 = ?` bound to `'1998'` reach the same comparison,
 * because affinity is applied to the literal before the comparison is made. It is not safe for a
 * literal containing a quote, so the escaping below is the load-bearing part of this file.
 *
 * Two behaviours are reproduced because a judge that quietly improves on the reference produces a
 * number nobody else can reproduce:
 *
 * - `lower=True` lower-cases *string* condition values on both sides. It is applied to the gold and
 *   the prediction alike, so it cannot favour either — but a port that dropped it would disagree
 *   with every published WikiSQL number on questions whose condition differs only in case.
 * - A condition on a `real` column is converted to a number before comparison, because the corpus
 *   stores `"1,234.5"` as text and the reference parses it. Values that cannot be parsed at all are
 *   an error rather than a fallback: the reference raises, and a port that silently kept the string
 *   would score a question neither implementation can answer.
 */

/** Aggregators, indexed by the `agg` field. Index 0 is "none", not `COUNT`. */
export const AGG_OPS = ['', 'MAX', 'MIN', 'COUNT', 'SUM', 'AVG'] as const;

/**
 * Condition operators, indexed by the middle element of a `conds` triple.
 *
 * Index 3 is the literal string `OP`, which the corpus's own vocabulary defines and the annotations
 * never use. It is kept at its index rather than dropped, because the index is what the annotations
 * carry and a shortened list would silently shift every operator after it.
 */
export const COND_OPS = ['=', '>', '<', 'OP'] as const;

export type CondOp = (typeof COND_OPS)[number];

/**
 * One annotation, as `{split}.jsonl` stores it.
 *
 * `conds` is a list of `[column_index, operator_index, value]`. The value is always text in the
 * file, including the ones that will be compared against a `real` column.
 */
export interface LogicForm {
  readonly sel: number;
  readonly agg: number;
  readonly conds: readonly (readonly [number, number, string])[];
}

/** What a table's columns are called and what SQLite says their types are. */
export interface TableShape {
  /** The name in the database, already prefixed — `table_1_10007452_3`. */
  readonly name: string;
  /** SQLite's declared type per column, in `col0, col1, …` order. */
  readonly types: readonly string[];
}

/**
 * The table name a `table_id` refers to.
 *
 * The corpus writes `1-10007452-3`; the databases name it `table_1_10007452_3`. The reference does
 * this rewrite with `str.replace('-', '_')`, which in Python replaces every occurrence — a port that
 * used `replace` with a string argument in JavaScript would replace only the first and look up a
 * table that does not exist.
 */
export function tableNameOf(tableId: string): string {
  return tableId.startsWith('table') ? tableId : `table_${tableId.replace(/-/g, '_')}`;
}

/** A value that cannot be compared at all, named rather than coerced. */
export class LogicFormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogicFormError';
  }
}

/**
 * The SQL literal for one condition value.
 *
 * `type` is SQLite's declared type for the column, because the reference reads it from
 * `sqlite_master` rather than from the corpus's own `tables.jsonl` — the two agree today and the
 * database is the one that decides how the comparison will actually behave.
 */
export function literalOf(value: string, type: string): string {
  if (type.toLowerCase() !== 'real') return `'${value.replace(/'/g, "''")}'`;
  // `parse_decimal` in the reference accepts a leading sign and thousands separators; `num_re`
  // accepts the first decimal run anywhere in the string. Both are reproduced in that order, so a
  // value like `"about 3.5"` parses where `"three"` fails.
  const grouped = Number(value.replace(/,/g, ''));
  if (Number.isFinite(grouped)) return String(grouped);
  const found = /[-+]?\d*\.\d+|\d+/.exec(value);
  if (found === null) {
    throw new LogicFormError(`condition value ${JSON.stringify(value)} is not a number and the column is real`);
  }
  return String(Number(found[0]));
}

/**
 * The statement a logical form denotes, as one string the oracle can execute.
 *
 * The shape is the reference's, character for character: `SELECT <agg>(colN) AS result FROM <t>
 * [WHERE colI <op> <literal> AND …]`. Two things are checked that the reference lets fail late:
 * every index is inside the table it names, and the operator is one of the four the corpus defines.
 * A judge that throws `IndexError` halfway through a split has already produced half a number.
 */
export function statementOf(form: LogicForm, table: TableShape, options?: { lower?: boolean }): string {
  const lower = options?.lower !== false;
  const aggregator = AGG_OPS[form.agg];
  if (aggregator === undefined) throw new LogicFormError(`no aggregator at index ${String(form.agg)}`);
  if (!Number.isInteger(form.sel) || form.sel < 0 || form.sel >= table.types.length) {
    throw new LogicFormError(`select index ${String(form.sel)} is outside ${table.name} (${String(table.types.length)} columns)`);
  }
  const selected = aggregator === '' ? `col${String(form.sel)}` : `${aggregator}(col${String(form.sel)})`;
  const clauses = form.conds.map(([column, operator, value]) => {
    const op = COND_OPS[operator];
    if (op === undefined) throw new LogicFormError(`no operator at index ${String(operator)}`);
    if (!Number.isInteger(column) || column < 0 || column >= table.types.length) {
      throw new LogicFormError(`condition column ${String(column)} is outside ${table.name} (${String(table.types.length)} columns)`);
    }
    const text = lower ? value.toLowerCase() : value;
    return `col${String(column)} ${op} ${literalOf(text, table.types[column] as string)}`;
  });
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
  return `SELECT ${selected} AS result FROM ${table.name}${where}`;
}

/**
 * Whether two result sets are the same answer.
 *
 * The reference compares `cursor.fetchall()` tuples with `==`, which is **ordered**: `SELECT col0`
 * with no `ORDER BY` returns rows in whatever order SQLite's scan produced, and two logically equal
 * statements can disagree. That is a property of the reference judge, not a bug this port should
 * fix — every published WikiSQL number was produced with it, and a port that sorted would report a
 * rate nobody else reports.
 *
 * The comparison is value-wise rather than serialised, because JSON would call `1` and `1.0`
 * different answers where Python calls them equal.
 */
export function sameResults(
  gold: readonly (readonly unknown[])[],
  pred: readonly (readonly unknown[])[],
): boolean {
  if (gold.length !== pred.length) return false;
  return gold.every((row, index) => {
    const other = pred[index];
    if (other === undefined || row.length !== other.length) return false;
    return row.every((value, cell) => sameValue(value, other[cell]));
  });
}

/** Python's `==` over the scalar types SQLite returns. */
function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' && typeof right === 'number') return left === right;
  if (left === null || right === null) return left === right;
  if (typeof left === 'string' && typeof right === 'string') return left === right;
  return false;
}
