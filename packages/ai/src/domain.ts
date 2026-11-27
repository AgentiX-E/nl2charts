/**
 * What a column stores, read from the engine, for the one rewrite the data can prove.
 *
 * `ground.ts` performs the edit — a literal compared with a column, spelled in the wrong case,
 * replaced with the spelling the column stores — and it needs one thing from outside the library:
 * the values. This module is that lookup. It is here rather than in the harness because the
 * rewrite is shipped: `ask_question` runs the same rule on the customer's own database, and a
 * product that read domains differently from the experiment would be shipping a rule nobody
 * priced.
 *
 * ## Two layers, because they answer two different questions
 *
 * `createDomainReader` answers "what does this table's column hold" and knows nothing about
 * statements. `createGroundingReader` answers "what does the column in *this* statement hold",
 * which needs the statement's own names for its tables — `t1.status` is `orders.status` only
 * because the statement said so. The split matters because the first layer is the one with a
 * failure mode: a read that did not finish is `undefined`, never `[]`.
 *
 * ## Why an unfinished read is refused rather than approximated
 *
 * The edit's whole licence is knowing the set of values: exactly one of them equal to the literal
 * ignoring case is a substitution, two is a judgement the rule declines to make. A read that
 * stopped early therefore cannot be used to *narrow* the set — a truncated domain that happens to
 * hold one match looks exactly like a complete one, and the substitution it authorises is a guess.
 * Callers report truncation (the runner marks a statement it capped), and this module turns it
 * into `undefined`: "I did not look", which `ground.ts` reports as `unknown` and refuses.
 *
 * That distinction is also why the cache stores `undefined`. A failed read that were cached as an
 * empty list would make the rule silently inert on a broken connection while reporting the literal
 * as *absent* — a claim about the data nobody made.
 */
import type { ColumnQuery, ColumnValues } from './ground.js';
import { tableRefs } from './sql-lex.js';

/** What a domain read needs from a statement runner. */
export interface DomainRunner {
  (
    sql: string,
  ): Promise<{
    readonly ok: boolean;
    readonly rows: readonly (readonly unknown[])[];
    /** `true` when the runner capped the statement, which makes the answer partial. */
    readonly truncated?: boolean;
  }>;
}

/** One column's stored values, by table and column, or `undefined` when it could not be read. */
export type ReadDomain = (table: string, column: string) => Promise<readonly string[] | undefined>;

export interface DomainReaderOptions {
  /**
   * The answers already known, so two sites in one statement read a column once.
   *
   * Owned by the caller because only the caller knows the lifetime: the harness empties it per
   * question, and the product empties it per asked question.
   */
  readonly cache?: Map<string, readonly string[] | undefined>;
  /**
   * A prefix for the cache key, for a caller reading several databases in one process.
   *
   * Two databases in one split can hold a table of the same name with different contents, and a
   * reader that ignored the split would answer one with the other's values.
   */
  readonly namespace?: string;
}

/**
 * Quote an identifier for the read.
 *
 * Doubling the quote is the only escape every engine here agrees on, and the read is built from a
 * name the statement wrote rather than from user text, so there is nothing else to defend against.
 */
function quoted(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * One column's stored values, queried once per run.
 *
 * The read is `select distinct`, so the answer is the set the rewrite compares against rather than
 * the table's rows: a column with a million rows but three values costs one query and three
 * strings.
 *
 * Two things are dropped, and the first one is a bug this move found. `select distinct` returns
 * the NULL group as a row, and the version of this reader that lived in the harness converted every
 * row with `String(row[0])` — which turns an unknown value into the four-character string `null`.
 * A nullable column therefore answered with a spelling it does not contain, and a statement that
 * wrote `'null'` (or a column storing `NULL` beside it) met a second spelling that does not exist.
 * NULL is not a value the rewrite can substitute, so it is skipped where it enters. The second is
 * the empty string: a stored value no literal in a question means to name.
 */
export function createDomainReader(run: DomainRunner, options: DomainReaderOptions = {}): ReadDomain {
  const cache = options.cache ?? new Map<string, readonly string[] | undefined>();
  const namespace = options.namespace ?? '';
  return async (table, column) => {
    const key = `${namespace}\u0000${table}\u0000${column}`;
    if (cache.has(key)) return cache.get(key);
    const result = await run(`select distinct ${quoted(column)} from ${quoted(table)}`);
    const values: readonly string[] | undefined =
      !result.ok || result.truncated === true
        ? undefined
        : [
            ...new Set(
              result.rows
                .map((row) => row[0])
                .filter((value) => value !== null && value !== undefined)
                .map((value) => String(value)),
            ),
          ].filter((value) => value !== '');
    cache.set(key, values);
    return values;
  };
}

/**
 * The values behind the column references in one statement.
 *
 * A qualifier is resolved through the statement's own `from`/`join` aliases, and one that names
 * neither an alias nor a table is refused rather than guessed: a column read out of the wrong
 * table is a substitution made on a set of values the statement never sees, which is the failure
 * mode the ambiguity check inside `ground.ts` cannot catch. An unqualified column is read from
 * every table the statement reads, which is what makes two tables holding the same column name
 * produce two spellings and therefore a refusal.
 */
export function createGroundingReader(run: DomainRunner, options: DomainReaderOptions = {}): ColumnValues {
  const read = createDomainReader(run, options);
  return async (query: ColumnQuery) => {
    const refs = tableRefs(query.sql);
    const aliases = new Map(refs.map((ref) => [ref.alias.toLowerCase(), ref.table]));
    const named =
      query.qualifier === undefined
        ? undefined
        : (aliases.get(query.qualifier.toLowerCase()) ??
          refs.find((ref) => ref.table.toLowerCase() === query.qualifier?.toLowerCase())?.table);
    if (query.qualifier !== undefined && named === undefined) return undefined;
    const tables = [...new Set(named === undefined ? refs.map((ref) => ref.table) : [named])];
    if (tables.length === 0) return undefined;
    const values: string[] = [];
    let answered = 0;
    for (const table of tables) {
      const held = await read(table, query.column);
      if (held === undefined) continue;
      answered += 1;
      values.push(...held);
    }
    // Every table that could hold the column failed to answer: nothing is known, and `[]` would be
    // a claim that the column stores nothing.
    return answered === 0 ? undefined : values;
  };
}
