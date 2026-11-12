/**
 * Three rows per table: the one input in RSL-SQL's prompt this repository never had.
 *
 * `src/configs/Instruction.py` names it five times — *the first three rows of values in the table:
 * sample data for understanding the content and data distribution of the table*. The two samplers
 * this repository ships are per column, and both were closed at a 2.22pp ceiling: a column sample
 * shows a value's **domain**. Three rows show which values occur **together** — `status='Banned'`
 * on the same line as `currency='EUR'` — and no per-column block can express a pairing.
 *
 * The block is priced before it is built: on 1,534 dev questions, three rows of the text columns of
 * every table the gold statement reads costs 1,058 characters at the mean and 483 at the median
 * (+39% and +18% against a 676-token prompt), and makes the cost tail three times longer at p90.
 * Both numbers are the reason for `budget`: the mean is affordable and the tail is not, so the rule
 * that ships is a rule with a ceiling rather than a rule without one.
 *
 * Deliberately pure. `read` is the caller's, so the renderer can be tested without a database and
 * the harness can cache one query per (database, table) instead of one per question.
 */

/** The part of a schema table this renderer reads. */
export interface RowSampleTable {
  readonly table: string;
  readonly columns: readonly { readonly name: string; readonly type: string }[];
}

export interface RowSampleOptions {
  /** Rows per table. Three is RSL-SQL's number and the one this was priced at. */
  readonly rows?: number;
  /** Characters for the whole block, newlines included. */
  readonly budget?: number;
  /** Characters for one stored value. */
  readonly maxValue?: number;
}

/** Types whose stored value can be a literal a question names. */
const TEXTUAL = new Set(['text', 'varchar', 'char', 'string', 'date', 'datetime', 'timestamp']);

/**
 * The columns worth sampling.
 *
 * A number costs characters and says nothing the card does not already say — `price` is typed
 * `real` on the card, and `1.5` is not a literal any question filters on. Dates are kept because
 * BIRD stores them as text and a question names them.
 */
export function sampleableColumns(table: RowSampleTable): { readonly name: string; readonly type: string }[] {
  return table.columns.filter((column) => {
    const type = column.type.toLowerCase();
    return TEXTUAL.has(type) || type.includes('char') || type.includes('date');
  });
}

/** One stored value as the block may print it, or nothing when it stores nothing. */
function cell(value: unknown, maxValue: number): string {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length === 0) return '';
  return text.length <= maxValue ? text : text.slice(0, maxValue);
}

/**
 * The block, or an empty string when nothing can be shown.
 *
 * Two rules are load-bearing and both are about not lying:
 *
 * 1. **A table is dropped whole, not cut.** Half a table reads as a table that stores one row, and
 *    that is a claim about the data rather than a shorter sample of it.
 * 2. **A value that is not there is not printed.** `status=NULL` describes the storage; a row that
 *    is entirely NULL disappears rather than becoming a blank line.
 */
export function renderRowSamples(
  tables: readonly RowSampleTable[],
  read: (table: string, columns: readonly string[]) => readonly (readonly unknown[])[],
  options: RowSampleOptions = {},
): string {
  const rows = options.rows ?? 3;
  const budget = options.budget ?? 800;
  const maxValue = options.maxValue ?? 40;
  const rendered: string[] = [];
  for (const table of tables) {
    const columns = sampleableColumns(table);
    if (columns.length === 0) continue;
    const names = columns.map((column) => column.name);
    const bodies: string[] = [];
    for (const row of read(table.table, names).slice(0, rows)) {
      const pairs = names
        .map((name, index) => {
          const value = cell(row[index], maxValue);
          return value === '' ? '' : `${name}=${value}`;
        })
        .filter((pair) => pair !== '');
      if (pairs.length > 0) bodies.push(pairs.join(', '));
    }
    if (bodies.length === 0) continue;
    rendered.push(`${table.table}: ${bodies.join(' | ')}`);
  }

  // From the end, because the tables arrive in card order and the first one named is the one the
  // question is most likely about.
  while (rendered.length > 0 && rendered.join('\n').length > budget) rendered.pop();
  if (rendered.length > 0) return rendered.join('\n');
  // Nothing fits: the first row of the first table is the smallest true thing this can say, and the
  // alternative — an empty block on the widest tables — withholds the rows a model can least infer.
  const first = tables.find((table) => sampleableColumns(table).length > 0);
  if (first === undefined) return '';
  const names = sampleableColumns(first).map((column) => column.name);
  const row = read(first.table, names)[0];
  if (row === undefined) return '';
  const pairs = names.map((name, index) => {
    const value = cell(row[index], maxValue);
    return value === '' ? '' : `${name}=${value}`;
  }).filter((pair) => pair !== '');
  return pairs.length === 0 ? '' : `${first.table}: ${pairs.join(', ')}`;
}
