/**
 * The one statement error the schema can prove, and the edit that fixes it.
 *
 * SQLite and PostgreSQL compare text case-sensitively, so `where status = 'banned'`
 * against a column that stores `Banned` is not a near miss — it is a statement that
 * returns nothing, and the model that wrote it had the right column and the right value
 * in mind. BIRD's dev split has six of these: the question says "directly funded", the
 * column stores `Directly Funded`, and the answer comes back empty.
 *
 * This is the narrowest possible repair, and the narrowness is the design. It fires only
 * when the column's own values contain exactly one entry that equals the literal ignoring
 * case. It does not fuzzy-match, does not stem, does not trim, and does not touch `like`
 * patterns, because every one of those turns a statement that returns nothing into a
 * statement that returns *something plausible*, and a plausible wrong answer is worse than
 * an empty one — the empty one is visibly empty.
 *
 * `docs/benchmarks.md` records what was measured. Applied to every statement, the edit
 * rewrites one gold statement in the dev split — question 640 stores `mornington` where
 * BIRD's gold says `Mornington` — and a repair that edits the reference answer can only
 * break a case that passes today. Applied only to a statement that returned nothing, it
 * edits no gold statement at all and recovers 2 of the 1,532 dev questions.
 *
 * Two is below what a paired test can resolve, so this is a measured candidate rather than
 * a pipeline step: `bench:bird:repair` is the instrument that says so, and the gate is part
 * of what it measures rather than an optimisation in the caller.
 *
 * ## The gate is a hypothesis, and `bench:bird:rewrite` prices it
 *
 * "Only when the statement returned nothing" is an assumption about where this defect shows up,
 * and an assumption is not a measurement. The same edit is worth more than two cases if the gate
 * is wrong, because a value written in the wrong case does not always return nothing: `like`
 * patterns, `in` lists and columns whose other rows match loosely all turn a wrong spelling into
 * *some* rows rather than none. So the rule is a parameter of the caller, and the harness that
 * re-executes statements prices both gates on the same 1,532 questions — one as a rewrite that
 * may be adopted, one as a ceiling that says how much the strict gate is leaving behind.
 *
 * The domain reader lives here rather than in the instrument so that both callers read values
 * the same way: one query per column, cached, and a failed read cached as *no values*, which
 * makes the rule refuse to fire rather than guess.
 */
import { literalSites, tableRefs } from './statement.js';

/** One column and the values it is known to contain. */
export interface ColumnDomain {
  readonly table: string;
  readonly column: string;
  readonly values: readonly string[];
}

/** One literal the repair replaced, and what it replaced it with. */
export interface Substitution {
  /** As written in the statement. */
  readonly literal: string;
  /** The spelling the column actually stores. */
  readonly value: string;
  readonly table: string;
  readonly column: string;
}

export interface RepairResult {
  /** The statement, with every substitution applied; unchanged when none fired. */
  readonly sql: string;
  readonly substitutions: readonly Substitution[];
}

/**
 * Operators whose right-hand literal is a value to look up.
 *
 * `like`, `glob` and `match` are excluded on purpose: their operand is a pattern, and
 * `'%funded%'` matching one stored value case-insensitively says nothing about which
 * spelling the user meant.
 */
const GROUNDING_OPERATORS = new Set(['=', '==', '!=', '<>', 'in', 'not in', 'between']);

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The domains a site could be reading.
 *
 * Matching is by column name only, because deciding *which* tables a statement reads is the
 * caller's job — it has the statement, the aliases and the schema, and it is where an
 * unresolved qualifier is dropped. What is left is the ambiguity rule below: every candidate
 * column has to name the same spelling, or nothing fires.
 */
function domainsFor(site: { readonly column: string }, domains: readonly ColumnDomain[]): ColumnDomain[] {
  const column = site.column.toLowerCase();
  return domains.filter((domain) => domain.column.toLowerCase() === column);
}

/**
 * The kinds of absence a column can explain, in the order a repair prefers them.
 *
 * `case` is the one the pipeline ships; `padding` and `parenthetical` are the two this module can
 * also prove from the column's own values; `absent` is not a repair at all — it is the statement
 * that the literal and the column do not belong together, which is a schema-linking failure and
 * not a spelling one.
 */
export const ABSENCE_KINDS = ['case', 'padding', 'parenthetical', 'absent'] as const;

export type AbsenceKind = (typeof ABSENCE_KINDS)[number];

/** The kinds an edit to the literal can reach. */
export type GroundableKind = Exclude<AbsenceKind, 'absent'>;

/** What the column's values say about one literal. */
export interface Absence {
  readonly kind: AbsenceKind;
  /** The stored value the literal should have been written as. Absent on `absent`. */
  readonly replacement?: string;
}

/**
 * Why this literal is not in this column, or nothing when it is.
 *
 * Every kind is a *matching* claim, and a claim with two candidates is a guess. The guess is worse
 * than the empty result it repairs: an empty result is visibly empty, and a plausible wrong answer
 * is not. So each branch requires exactly one stored value, and the branches are tried in the
 * order of the evidence rather than of convenience.
 *
 * `padding` compares numeric values rather than lengths on purpose: `'40'` and `'0040'` are the
 * same number and the same lookup key, while `'400'` and `'0040'` are different keys even though
 * they share four digits.
 *
 * `parenthetical` requires the literal to be followed immediately by ` (`, because a bare prefix
 * is not a label: `Continuation` is a prefix of both `Continuation School (Public)` and
 * `Continuation High Schools`, and choosing between them is exactly the guess this function
 * refuses to make.
 */
export function classifyAbsence(literal: string, values: readonly string[]): Absence | undefined {
  if (values.includes(literal)) return undefined;
  const lowered = literal.toLowerCase();
  const caseMatches = [...new Set(values.filter((value) => value.toLowerCase() === lowered))];
  if (caseMatches.length === 1) return { kind: 'case', replacement: caseMatches[0] as string };
  if (caseMatches.length > 1) return { kind: 'absent' };
  if (/^\d+$/.test(literal)) {
    const padded = [...new Set(values.filter((value) => /^\d+$/.test(value) && Number(value) === Number(literal)))];
    if (padded.length === 1) return { kind: 'padding', replacement: padded[0] as string };
    if (padded.length > 1) return { kind: 'absent' };
  }
  const stem = `${lowered} (`;
  const labelled = [...new Set(values.filter((value) => value.toLowerCase().startsWith(stem)))];
  if (labelled.length === 1) return { kind: 'parenthetical', replacement: labelled[0] as string };
  return { kind: 'absent' };
}

/**
 * Ground every literal the statement compares against a column that stores it in another form.
 *
 * Edits are applied from the end of the statement backwards so an earlier substitution
 * cannot move a later offset — the failure that makes offset-based rewriting look correct
 * on one edit and corrupt the statement on two.
 *
 * `kinds` is the licence, and it is a parameter rather than a constant because the three edits
 * have three different amounts of evidence behind them and one of them ships.
 */
export function groundLiteralAbsence(
  sql: string,
  domains: readonly ColumnDomain[],
  kinds: readonly GroundableKind[],
): RepairResult {
  if (domains.length === 0) return { sql, substitutions: [] };
  const substitutions: Substitution[] = [];
  const edits: { start: number; end: number; text: string }[] = [];
  for (const site of literalSites(sql)) {
    if (!GROUNDING_OPERATORS.has(site.operator)) continue;
    const candidates = domainsFor(site, domains);
    if (candidates.length === 0) continue;
    // A literal any candidate column already stores is a value the engine could find: nothing to
    // fix, and editing it would be a change to a lookup that already resolves.
    const verdicts = candidates.map((domain) => classifyAbsence(site.literal.value, domain.values));
    if (verdicts.some((verdict) => verdict === undefined)) continue;
    // Every candidate column has to name the same kind and the same replacement. A column that
    // cannot name it, or names another kind, makes the substitution a guess — and an unqualified
    // column the engine would have rejected as ambiguous turns into a statement that runs and
    // answers the wrong question, which is the one outcome worse than an error.
    const first = verdicts[0] as Absence;
    if (first.replacement === undefined) continue;
    if (!kinds.includes(first.kind as GroundableKind)) continue;
    if (!verdicts.every((verdict) => (verdict as Absence).kind === first.kind && (verdict as Absence).replacement === first.replacement)) {
      continue;
    }
    const value = first.replacement;
    // The owner is the first candidate by construction: `first` is the verdict computed from
    // `candidates[0]`'s own values, so that column is the one that stores the replacement. Looking
    // it up again with `find` produced a branch no input could reach — the value came out of that
    // column, so a search for the column that holds it always succeeds — and an unreachable branch
    // is a claim about safety that nothing tests.
    const owner = candidates[0] as ColumnDomain;
    const substitution: Substitution = { literal: site.literal.value, value, table: owner.table, column: owner.column };
    substitutions.push(substitution);
    edits.push({ start: site.literal.start, end: site.literal.end, text: quote(value) });
  }
  if (edits.length === 0) return { sql, substitutions: [] };
  let out = sql;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return { sql: out, substitutions };
}

/**
 * The shipped edit, named for what it does rather than for the mechanism behind it.
 *
 * Kept as its own export because callers — the pipeline and the rewrite pricer — should be able
 * to say "the rule that ships" without also saying which kinds it is allowed to apply. It is the
 * case-only licence over `groundLiteralAbsence`, and the two must not diverge: the tests assert
 * the delegate, so a change to one that is not a change to the other fails.
 */
export function groundLiteralCase(sql: string, domains: readonly ColumnDomain[]): RepairResult {
  return groundLiteralAbsence(sql, domains, ['case']);
}

/** A statement runner: the oracle's `run`, narrowed to what a domain read needs. */
export type StatementRunner = (sql: string) => Promise<{ readonly ok: boolean; readonly rows: readonly (readonly unknown[])[] }>;

/** One column's stored values, by table and column. */
export type ReadDomain = (table: string, column: string) => Promise<readonly string[]>;

/**
 * One column's stored values, queried once per run.
 *
 * A read that fails is cached as no values, which makes the repair refuse to fire on that
 * column. That is the safe direction: the edit's whole licence is knowing what the column
 * stores, and a column whose contents are unknown is one where a substitution would be a
 * guess. A column reaches this function because a statement the engine accepted compares
 * against it, so in practice the read succeeds — the empty list is what happens when it does
 * not, not an alternative outcome that needs its own report.
 *
 * The cache is keyed by database as well as by table, because two databases in one split can
 * hold a table of the same name with different contents and a reader that ignored the split
 * would answer one with the other's values.
 */
export function createDomainReader(run: StatementRunner, db: string, cache: Map<string, readonly string[]>): ReadDomain {
  return async (table, column) => {
    const key = `${db}\u0000${table}\u0000${column}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const quotedTable = `"${table.replace(/"/g, '""')}"`;
    const quotedColumn = `"${column.replace(/"/g, '""')}"`;
    const result = await run(`select distinct ${quotedColumn} from ${quotedTable}`);
    if (!result.ok) return [];
    const values = [...new Set(result.rows.map((row) => String(row[0])))].filter((value) => value !== '');
    cache.set(key, values);
    return values;
  };
}

/**
 * The domains this statement's comparison sites could be reading.
 *
 * An unqualified column that exists in two joined tables yields two domains, and the repair
 * refuses to choose between them — that decision belongs in `groundLiteralCase`, which is
 * where it is tested. A qualifier that is not one of the statement's own aliases names a table
 * this reader cannot see (a comma join, a subquery), and a column guessed from it would be read
 * from the wrong table, so the site is skipped rather than resolved by elimination.
 */
export async function domainsOf(sql: string, read: ReadDomain): Promise<ColumnDomain[]> {
  const refs = tableRefs(sql);
  const aliases = new Map(refs.map((ref) => [ref.alias.toLowerCase(), ref.table.toLowerCase()]));
  const wanted = new Map<string, { table: string; column: string }>();
  for (const site of literalSites(sql)) {
    const named = site.qualifier === undefined ? undefined : aliases.get(site.qualifier.toLowerCase());
    if (site.qualifier !== undefined && named === undefined) continue;
    const tables = named === undefined ? refs.map((ref) => ref.table) : [named];
    for (const table of tables) wanted.set(`${table.toLowerCase()}\u0000${site.column.toLowerCase()}`, { table, column: site.column });
  }
  const domains: ColumnDomain[] = [];
  for (const { table, column } of wanted.values()) {
    const values = await read(table, column);
    if (values.length > 0) domains.push({ table, column, values });
  }
  return domains;
}
