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
 */
import { literalSites } from './statement.js';

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
 * Ground every literal the statement compares against a column that stores it in another
 * case.
 *
 * Edits are applied from the end of the statement backwards so an earlier substitution
 * cannot move a later offset — the failure that makes offset-based rewriting look correct
 * on one edit and corrupt the statement on two.
 */
export function groundLiteralCase(sql: string, domains: readonly ColumnDomain[]): RepairResult {
  if (domains.length === 0) return { sql, substitutions: [] };
  const substitutions: Substitution[] = [];
  const edits: { start: number; end: number; text: string }[] = [];
  for (const site of literalSites(sql)) {
    if (!GROUNDING_OPERATORS.has(site.operator)) continue;
    const candidates = domainsFor(site, domains);
    if (candidates.length === 0) continue;
    // The written literal is already stored somewhere it could be read from: nothing to fix.
    if (candidates.some((domain) => domain.values.includes(site.literal.value))) continue;
    const lowered = site.literal.value.toLowerCase();
    // Every candidate column has to name exactly one spelling, and they all have to name the
    // same one. A column that cannot name it, or names two, makes the substitution a guess —
    // and an unqualified column that the engine would have rejected as ambiguous turns into a
    // statement that runs and answers the wrong question, which is the one outcome worse than
    // an error.
    const spellings = candidates.map((domain) => [...new Set(domain.values.filter((value) => value.toLowerCase() === lowered))]);
    if (!spellings.every((found) => found.length === 1)) continue;
    const agreed = (spellings[0] as string[])[0] as string;
    if (!spellings.every((found) => found[0] === agreed)) continue;
    const value = agreed;
    const owner = candidates.find((domain) => domain.values.includes(value)) as ColumnDomain;
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
