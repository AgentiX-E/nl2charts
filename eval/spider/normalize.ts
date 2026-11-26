/**
 * The dialect a Spider statement has to be written in, applied as repairs rather than as advice.
 *
 * ## Why this file exists, and why it is not a fifth prompt arm
 *
 * The `grammar` arm tells a model the four restrictions the reference parser enforces, and it moved
 * the reading from 57.35% to 59.77%. It also left **45 statements the parser still refuses**. Round
 * 197 wrote down the plan for a fifth arm: classify those 45, then decide whether another sentence is
 * worth ¥3. Classifying them was the cheaper experiment and it answered the question against the plan:
 * the refusals are not one missing idea, they are **eight mechanical facts about the dialect**, and
 * four of the eight are repairable *after* the model has answered, for nothing.
 *
 *   | refusal the judge prints                     | cases | repair            | exact after |
 *   | -------------------------------------------- | ----: | ----------------- | ----------: |
 *   | `Error col: >`   (`<>`, which is not `!=`)    |    21 | `notEqual`        |          13 |
 *   | `Alias teacher has the same name in table`    |    11 | `duplicateAlias`  |           4 |
 *   | `'inner'`        (`INNER JOIN`)               |     4 | `innerJoin`       |           2 |
 *   | `Error col: cast`                             |     3 | `cast`            |           3 |
 *   | `Error col: \|\|`, `not`, `select`, unstated  |     6 | — not repaired    |           0 |
 *
 * Twenty-two of those statements were **right and unreadable**. That is the opposite of the lesson the
 * 140 statements of the prompt rule taught — of those, only 25 were also right — and the difference is
 * the direction of the arrow: a prompt sentence asks a model to write differently, while a repair takes
 * a statement the model already wrote correctly and spells it the way the parser reads. The last row is
 * the line this file will not cross: `||`, `NOT IN`, a subquery in `FROM`, and a parenthesised `OR`
 * group are not spellings of something the grammar has, and rewriting them would not be a dialect fix,
 * it would be a different query. `754` is the proof — stripping its parentheses makes the statement
 * parse and it still reads wrong, so that rule would have bought 0.00pp for a meaning it changed.
 *
 * ## The invariant that makes the reading monotone
 *
 * A repair is only ever used where the parser refused. A statement that parses is never rewritten, so
 * an arm's reading **cannot go down** when this file is switched on: the accepted set is byte-identical
 * and the refused set can only trade a zero for something. That is measured rather than assumed —
 * replaying the 1,034 predictions of run `45807713388` through these rules changes **0** of the 618
 * statements the parser accepted, and turns 37 of the 45 refusals into parseable ones, 22 of which read
 * exact: 618 + 22 = 640 of 1,034, **61.90% against 59.77%**, for ¥0 in model calls.
 *
 * ## What a rule is allowed to do
 *
 * Each rule is meaning-preserving by construction, and each says so in `why`:
 *
 * - `<>` and `!=` are the same operator in SQLite; the reference's list simply has one of them.
 * - `INNER JOIN` and `JOIN` are the same join; `INNER` is not a token its `FROM` parser reads.
 * - `FROM teacher AS teacher` binds `teacher` to the table called `teacher`; dropping the alias
 *   leaves every `teacher.Name` resolving to the same column.
 * - `CAST(<bare column> AS INTEGER|REAL|INT|NUMERIC)` is the one rule carrying an assumption: the
 *   cast is dropped only when its argument is a column reference and the target type is numeric,
 *   which is exactly where SQLite's comparison does not change. It is kept last for that reason, and
 *   it is the rule a reader should look at first if a later corpus disagrees.
 *
 * Everything else — a string concatenation, a `NOT IN`, a derived table, a boolean group in
 * parentheses — is left alone. A repair that invents structure is a different answer, and a harness
 * that scores it is measuring its own rewriter.
 *
 *   tsx eval/spider/residue.ts --predictions eval/out/spider-predictions.jsonl
 */
import type { Verdict } from './check.js';

/** One repair: a name for the class of refusal it answers, the reason, and the rewrite. */
export interface Rule {
  /** The class name the judge's reason maps to, so a count and a rule are the same word. */
  readonly name: string;
  /** What the reference refuses, in its own terms. */
  readonly why: string;
  /** The rewrite. Applied only outside string literals, so a quote never becomes a repair. */
  readonly apply: (sql: string) => string;
}

/** `FROM teacher AS teacher` → `FROM teacher`; the alias names the table it already names. */
const SELF_ALIAS = /\b(FROM|JOIN)\s+([A-Za-z_][\w$]*)\s+AS\s+([A-Za-z_][\w$]*)/gi;

/** `CAST(x AS INTEGER)` → `x`; only a bare column, and only to a numeric type. */
const NUMERIC_CAST = /\bCAST\s*\(\s*([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)\s+AS\s+(?:REAL|INTEGER|INT|NUMERIC)\s*\)/gi;

/** The rules, in the order they are applied. Order is also the order a report lists them. */
export const RULES: readonly Rule[] = [
  {
    name: 'notEqual',
    why: "the reference's operator list has `!=` and not `<>`, so it reads `<` then stops at `>`",
    apply: (sql) => sql.replace(/<>/g, '!='),
  },
  {
    name: 'innerJoin',
    why: '`INNER` is not a token the FROM parser reads; `JOIN` and `LEFT JOIN` are',
    apply: (sql) => sql.replace(/\bINNER\s+JOIN\b/gi, 'JOIN'),
  },
  {
    name: 'duplicateAlias',
    why: 'an alias with the same name as a table in the query is refused as ambiguous',
    apply: (sql) =>
      sql.replace(SELF_ALIAS, (whole, keyword: string, table: string, alias: string) =>
        table.toLowerCase() === alias.toLowerCase() ? `${keyword} ${table}` : whole,
      ),
  },
  {
    name: 'cast',
    why: 'CAST is not in the grammar, and a numeric cast over a bare column changes no comparison',
    apply: (sql) => sql.replace(NUMERIC_CAST, (_whole, column: string) => column),
  },
];

/**
 * Apply a rewrite to the parts of a statement that are not string literals.
 *
 * A repair is a rewrite of SQL, and `'<>'` is a string a model may legitimately be looking for. The
 * scanner walks the statement once, handing each unquoted segment to `rewrite` and copying each
 * literal through untouched, doubled quotes (`''`) included.
 */
export function outsideLiterals(sql: string, rewrite: (segment: string) => string): string {
  let out = '';
  let index = 0;
  while (index < sql.length) {
    const quote = sql.indexOf("'", index);
    if (quote === -1) return out + rewrite(sql.slice(index));
    out += rewrite(sql.slice(index, quote));
    let cursor = quote + 1;
    let closed = false;
    while (cursor < sql.length) {
      if (sql[cursor] !== "'") {
        cursor += 1;
      } else if (sql[cursor + 1] === "'") {
        cursor += 2;
      } else {
        cursor += 1;
        closed = true;
        break;
      }
    }
    out += sql.slice(quote, cursor);
    // An unterminated literal is not a statement this file can repair; it is copied to the end.
    if (!closed) return out;
    index = cursor;
  }
  return out;
}

/** One repair that fired, so a reading can say which rule bought it. */
export interface Repair {
  readonly rule: string;
  readonly before: string;
  readonly after: string;
}

/** The statement as the reference's grammar reads it. Idempotent: a repair is not a cycle. */
export function normalize(sql: string): string {
  let current = sql;
  for (const rule of RULES) current = outsideLiterals(current, rule.apply);
  return current;
}

/** Which rules fired, in order, with the two statements around each. Empty when nothing was wrong. */
export function repairsOf(sql: string): readonly Repair[] {
  const repairs: Repair[] = [];
  let current = sql;
  for (const rule of RULES) {
    const next = outsideLiterals(current, rule.apply);
    if (next !== current) repairs.push({ rule: rule.name, before: current, after: next });
    current = next;
  }
  return repairs;
}

/** The refusal classes the judge's reasons name, including the ones this file cannot repair. */
export const REFUSAL_CLASSES = [
  'notEqual',
  'innerJoin',
  'duplicateAlias',
  'cast',
  'concat',
  'notIn',
  'subqueryInColumn',
  'unstated',
  'other',
] as const;

export type RefusalClass = (typeof REFUSAL_CLASSES)[number];

/**
 * The class of a judge refusal, read from the sentence the parser prints.
 *
 * The vocabulary is the one measured on Spider's dev split, not a guess: `Error col: >` is what `<>`
 * leaves behind, `Alias x has the same name in table` is the self-alias, `'inner'` is a `KeyError` on
 * the keyword, and an empty reason is a `raise` with no message — kept as its own class rather than
 * folded into `other`, because "the parser did not say" and "the parser said something new" are
 * different instructions to the next reader.
 */
export function classOfReason(reason: string | undefined): RefusalClass {
  if (reason === undefined) return 'unstated';
  if (reason === '') return 'unstated';
  if (/^Error col: >$/.test(reason)) return 'notEqual';
  if (/^Alias .+ has the same name in table$/.test(reason)) return 'duplicateAlias';
  if (/^'inner'$/.test(reason)) return 'innerJoin';
  if (/^Error col: cast$/i.test(reason)) return 'cast';
  if (/^Error col: \|\|$/.test(reason)) return 'concat';
  if (/^Error col: not$/i.test(reason)) return 'notIn';
  if (/^Error col: select$/i.test(reason)) return 'subqueryInColumn';
  return 'other';
}

/** What one refusal cost, and what the repairs bought back. */
export interface RefusalRow {
  readonly index: number;
  readonly reason: string;
  readonly refusal: RefusalClass;
  /** True when the normalized statement parses. */
  readonly readable: boolean;
  /** True when it parses *and* reads exact match against the gold. */
  readonly exact: boolean;
  readonly repairs: readonly string[];
}

/** One class, as a line of the report. */
export interface ClassRow {
  readonly refusal: RefusalClass;
  readonly cases: number;
  readonly readable: number;
  readonly exact: number;
}

/** The residue of one reading: every refusal, grouped by the parser's own reason. */
export interface Residue {
  readonly refused: number;
  readonly readable: number;
  readonly exact: number;
  readonly classes: readonly ClassRow[];
  readonly rows: readonly RefusalRow[];
}

/**
 * Group the refusals of one reading by class, with what the repairs recovered from each.
 *
 * `repaired` is the judge's verdict on `normalize(prediction)` and is only consulted for pairs the
 * first judge refused; a statement that parses is never replaced, which is what keeps the reading
 * monotone. The totals are asserted against the row count before they are returned: a class that is
 * counted twice, or a refusal that is counted in no class, is a report that cannot be added up.
 */
export function residueOf(
  refused: readonly {
    readonly index: number;
    readonly reason: string | undefined;
    readonly repaired: Verdict;
    readonly repairs: readonly string[];
  }[],
): Residue {
  const rows: RefusalRow[] = refused.map((entry) => ({
    index: entry.index,
    reason: entry.reason ?? '',
    refusal: classOfReason(entry.reason),
    readable: entry.repaired.pred === 'ok',
    exact: entry.repaired.em === 1,
    repairs: entry.repairs,
  }));
  const classes = REFUSAL_CLASSES.map((refusal) => ({
    refusal,
    cases: rows.filter((row) => row.refusal === refusal).length,
    readable: rows.filter((row) => row.refusal === refusal && row.readable).length,
    exact: rows.filter((row) => row.refusal === refusal && row.exact).length,
  })).filter((row) => row.cases > 0);
  const counted = classes.reduce((total, row) => total + row.cases, 0);
  if (counted !== rows.length) {
    throw new Error(`residue: ${String(counted)} of ${String(rows.length)} refusals were classified`);
  }
  return {
    refused: rows.length,
    readable: rows.filter((row) => row.readable).length,
    exact: rows.filter((row) => row.exact).length,
    classes,
    rows,
  };
}

/** The report, as lines. A class with no rule is printed as `—`, which is the point of the table. */
export function residueLines(residue: Residue): readonly string[] {
  const repairable = new Set(RULES.map((rule) => rule.name));
  const lines = [
    `residue: ${String(residue.refused)} refusal(s), ${String(residue.readable)} readable after repair, ${String(residue.exact)} also right`,
    '  class              cases  readable  exact  rule',
  ];
  for (const row of residue.classes) {
    lines.push(
      `  ${row.refusal.padEnd(18)}${String(row.cases).padStart(5)}${String(row.readable).padStart(10)}${String(row.exact).padStart(7)}  ${
        repairable.has(row.refusal) ? row.refusal : '—'
      }`,
    );
  }
  for (const row of residue.rows.filter((entry) => entry.readable && !entry.exact).slice(0, 5)) {
    lines.push(`  readable, not right: #${String(row.index)} ${row.reason} [${row.repairs.join(',') || 'no rule'}]`);
  }
  return lines;
}
