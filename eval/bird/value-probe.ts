/**
 * What the columns hold, asked of the database rather than inferred from the question.
 *
 * `values-gap` established the cause of the zero-row state without a model: on BIRD's dev split
 * 18 of 19 questions whose every candidate returned nothing wrote a value the database does not
 * contain. That is a *lookup* failure — the statement names the right column and the wrong
 * spelling — and a lookup failure can be diagnosed by looking the spelling up. This module is
 * that lookup: for each literal the statement compares against a column, it asks the engine
 * which of that column's values contain the literal, ignoring case.
 *
 * Three outcomes are worth telling the model, and they are ordered by how much they settle:
 *
 * 1. `case` — the column stores exactly one spelling that matches ignoring case. This settles the
 *    question, so the statement is rewritten here, deterministically, for no call at all
 *    (`groundLiteralCase` owns the edit rule and its ambiguity guard: one column, one spelling,
 *    or nothing fires).
 * 2. `partial` — the column stores values that contain the literal (`Benalish Knight` inside
 *    `Benalish Knight (Fellwar Stone)`). Which one was meant is a judgement, so the values are
 *    quoted back and the model decides.
 * 3. `absent` — nothing in the column contains it. The model invented the value, and saying so
 *    is cheaper than letting it try the same spelling again.
 *
 * What this module deliberately does not do is fuzzy-match. No stemming, no trigram distance, no
 * "did you mean". A repair that guesses produces a statement that returns *something*, and a
 * plausible wrong answer is worse than an empty one — the empty one is visibly empty. The only
 * matches reported are ones the database itself produced.
 *
 * Cost: one query per (literal, column) pair, no model calls, and only on cases whose whole
 * candidate set returned nothing — 3.83% of the dev split.
 */
import { groundLiteralCase } from './literal-repair.js';
import { literalSites } from './statement.js';
import type { ValueGap } from '@agentix-e/nl2charts-ai';

/** A column the statement could be comparing against, from the schema the model was shown. */
export interface ProbeColumn {
  readonly table: string;
  readonly column: string;
  readonly type: string;
}

/** One value a column holds that contains the literal. */
export interface ProbeMatch {
  readonly table: string;
  readonly column: string;
  readonly value: string;
}

export type ProbeKind = 'exact' | 'case' | 'partial' | 'absent';

/** The verdict for one literal in one column. */
export interface LiteralProbe {
  readonly literal: string;
  readonly column: string;
  readonly kind: ProbeKind;
  readonly matches: readonly ProbeMatch[];
}

export interface ValueProbe {
  readonly probes: readonly LiteralProbe[];
  /** What the retry turn will quote: every probe that did not find the literal as written. */
  readonly gaps: readonly ValueGap[];
  /** The statement with its case-differing literals grounded, when that was unambiguous. */
  readonly grounded: string | undefined;
  readonly queries: number;
}

/** Rows fetched per column. Enough to see a naming convention, few enough to read. */
export const PROBE_ROWS = 8;
/** Literals probed per statement. A statement with thirty literals is not a lookup problem. */
export const PROBE_LITERALS = 6;
/** Columns searched when the statement's own column names are not in the schema. */
export const PROBE_COLUMNS = 40;

/** Types whose values are compared as text. A numeric column cannot be the one at fault. */
const TEXT_TYPES = /char|text|clob|string|enum|uuid/i;

function identifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A literal that is a pattern rather than a value says nothing about the column's contents. */
function isPattern(literal: string): boolean {
  return literal.includes('%') || literal.includes('_');
}

function isText(column: ProbeColumn): boolean {
  return column.type === '' || TEXT_TYPES.test(column.type);
}

/**
 * The columns a site could be reading: the ones the statement names, else every text column.
 *
 * The fallback exists because BIRD statements qualify columns with aliases (`t2.name`) whose
 * table is decided by a join the probe does not resolve, and because an unqualified `name` can
 * belong to four tables. Searching all of them is what found `Benalish Knight (Fellwar Stone)`
 * in the audit; the cap keeps that search bounded on a wide schema.
 *
 * A name that *is* in the schema returns every column with that name and no cap: the ambiguity
 * (two tables storing two different spellings) is the thing the repair rule needs to see, and
 * stopping at the first table would hide it.
 */
function columnsFor(site: { readonly column: string }, columns: readonly ProbeColumn[]): ProbeColumn[] {
  const named = site.column.toLowerCase();
  const matched = columns.filter((column) => column.column.toLowerCase() === named);
  if (matched.length > 0) return matched;
  return columns.filter(isText).slice(0, PROBE_COLUMNS);
}

/**
 * Look every literal up in the columns it is compared against.
 *
 * `run` returns the rows of a statement, or `undefined` when the engine refused it. A refused
 * lookup is not evidence either way — a view that does not exist, a column that is not text —
 * so it produces no probe rather than an `absent` verdict that would be a claim about data
 * nobody read.
 */
export async function probeValueGaps(
  sql: string,
  columns: readonly ProbeColumn[],
  run: (statement: string) => Promise<readonly (readonly unknown[])[] | undefined>,
): Promise<ValueProbe> {
  const probes: LiteralProbe[] = [];
  const seen = new Set<string>();
  let queries = 0;
  let literals = 0;
  for (const site of literalSites(sql)) {
    if (literals >= PROBE_LITERALS) break;
    const literal = site.literal.value.trim();
    if (literal === '' || isPattern(literal)) continue;
    const key = `${site.column.toLowerCase()}\u0000${literal}`;
    // Two sites can compare the same literal with the same column — `id in ('a', 'a')`, or an
    // equality repeated in two `or` branches. One lookup answers both.
    if (seen.has(key)) continue;
    seen.add(key);
    literals += 1;
    const named = columns.some((column) => column.column.toLowerCase() === site.column.toLowerCase());
    for (const column of columnsFor(site, columns)) {
      queries += 1;
      const rows = await run(
        `select distinct ${identifier(column.column)} from ${identifier(column.table)} ` +
          `where lower(${identifier(column.column)}) like lower('%${literal.replace(/'/g, "''")}%') limit ${PROBE_ROWS}`,
      );
      if (rows === undefined) continue;
      const matches: ProbeMatch[] = [];
      for (const row of rows) {
        const value = row[0];
        if (value === null || value === undefined) continue;
        matches.push({ table: column.table, column: column.column, value: String(value) });
      }
      const lowered = literal.toLowerCase();
      const kind: ProbeKind = matches.some((match) => match.value === literal)
        ? 'exact'
        : matches.some((match) => match.value.toLowerCase() === lowered)
          ? 'case'
          : matches.length > 0
            ? 'partial'
            : 'absent';
      probes.push({ literal, column: `${column.table}.${column.column}`, kind, matches });
      // The statement did not name a column this schema knows, so the search is a sweep: the
      // first table holding anything is the only lead worth having, and continuing would turn
      // one literal into forty queries on the cases that already cost the most.
      if (!named && matches.length > 0) break;
    }
  }
  return { probes, gaps: gapsOf(probes), grounded: ground(sql, probes), queries };
}

/**
 * One line per literal, not one per column that holds it.
 *
 * A literal compared against an unqualified `name` is looked up in every table that has one, and
 * an `absent` verdict from three tables is three ways of saying the same thing. The most
 * informative probe wins — a column that spells the value differently outweighs a column that
 * never had it, because the first is the answer and the second is only the absence of one — and
 * ties keep statement order so the message stays deterministic.
 */
function gapsOf(probes: readonly LiteralProbe[]): ValueGap[] {
  const best = new Map<string, LiteralProbe>();
  const rank = { case: 0, partial: 1, absent: 2, exact: 3 } as const;
  for (const probe of probes) {
    if (probe.kind === 'exact') continue;
    const held = best.get(probe.literal);
    if (held === undefined || rank[probe.kind] < rank[held.kind]) best.set(probe.literal, probe);
  }
  return [...best.values()].map((probe) => ({
    literal: probe.literal,
    column: probe.column,
    kind: probe.kind as 'case' | 'partial' | 'absent',
    values: probe.kind === 'absent' ? [] : probe.matches.map((match) => match.value),
  }));
}

/**
 * The case-only repair, applied to the probes rather than to a profile of the whole column.
 *
 * `groundLiteralCase` needs to know that the column stores exactly one spelling that matches
 * ignoring case; the probe already read back the values that contain the literal, so a `case`
 * probe with exactly one distinct spelling outside the literal satisfies that condition by
 * construction. Two spellings do not, and are left to the model.
 *
 * Every probe of the literal has to agree, and every one of them has to be a `case` probe. A
 * literal that another table stores exactly as written is not a case problem — the statement is
 * empty for some other reason — and substituting on the strength of one table's spelling while
 * another table holds the literal verbatim would be a guess dressed as a lookup.
 */
function ground(sql: string, probes: readonly LiteralProbe[]): string | undefined {
  const byLiteral = new Map<string, LiteralProbe[]>();
  for (const probe of probes) {
    const group = byLiteral.get(probe.literal);
    if (group === undefined) byLiteral.set(probe.literal, [probe]);
    else group.push(probe);
  }
  const domains: { table: string; column: string; values: string[] }[] = [];
  for (const [literal, group] of byLiteral) {
    if (group.some((probe) => probe.kind !== 'case')) continue;
    const lowered = literal.toLowerCase();
    const spellings = group.map((probe) => [...new Set(probe.matches.filter((m) => m.value.toLowerCase() === lowered).map((m) => m.value))]);
    if (!spellings.every((found) => found.length === 1)) continue;
    const agreed = (spellings[0] as string[])[0] as string;
    if (!spellings.every((found) => found[0] === agreed)) continue;
    for (const probe of group) {
      const match = probe.matches.find((m) => m.value === agreed) as ProbeMatch;
      domains.push({ table: match.table, column: match.column, values: [agreed] });
    }
  }
  if (domains.length === 0) return undefined;
  const repaired = groundLiteralCase(sql, domains);
  return repaired.substitutions.length === 0 ? undefined : repaired.sql;
}
