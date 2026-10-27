import type { OracleResult } from './oracle.js';

/**
 * What kind of wrong a failing statement is.
 *
 * The per-arm `errors` block already counts `values` and `columnCount`, but it is
 * computed from the judge's verdict and the arm's own bookkeeping. It cannot say whether
 * a wrong answer was *empty*, off by a factor, or one column short of the answer, and
 * those three call for different work: an empty result is a filter that matched nothing,
 * a factor is an aggregation at the wrong grain, a column short is a projection mistake.
 *
 * The taxonomy below is derived only from the two result sets, so it can be computed
 * offline from any artifact that kept its failing statements — which is what makes it
 * cheap enough to run on every failure instead of on a sample.
 */
export type FailureShape =
  | 'error' // the engine refused the statement
  | 'empty' // it ran, and returned nothing
  | 'row-count' // a different number of rows
  | 'column-count' // the right number of rows, a different number of columns
  | 'scale' // every value is a constant multiple of the gold's
  | 'values'; // same shape, different values

/** What the engine said, in the terms a fix would use. */
export type ErrorShape =
  | 'unknown-identifier'
  | 'syntax'
  | 'grouping'
  | 'ambiguous'
  | 'type'
  | 'other';

export function classifyError(message: string): ErrorShape {
  const text = message.toLowerCase();
  if (text.includes('no such column') || text.includes('no such table') || text.includes('unknown column')) return 'unknown-identifier';
  if (text.includes('ambiguous column')) return 'ambiguous';
  if (text.includes('misuse of aggregate') || text.includes('must appear in the group by') || text.includes('group by')) return 'grouping';
  if (text.includes('syntax error') || text.includes('incomplete input') || text.includes('near "')) return 'syntax';
  if (text.includes('datatype mismatch') || text.includes('cannot cast') || text.includes('no such function')) return 'type';
  return 'other';
}

/**
 * The shape of a wrong answer, from the two result sets alone.
 *
 * `scale` is checked before `values` because a fan-out join — the mistake this codebase
 * has produced more than any other — multiplies every row and leaves the ordering and the
 * column count intact, so it reads as "wrong values" to anything that only compares.
 */
export function classifyFailureShape(
  predicted: OracleResult,
  gold: readonly (readonly unknown[])[],
): { shape: FailureShape; factor?: number } {
  if (!predicted.ok) return { shape: 'error' };
  const rows = predicted.rows;
  if (rows.length === 0) {
    // An empty prediction against a non-empty gold is its own category: no threshold is
    // involved, and on this benchmark it is wrong by construction.
    return { shape: gold.length === 0 ? 'values' : 'empty' };
  }
  if (rows.length !== gold.length) return { shape: 'row-count' };
  const columns = gold[0]?.length ?? 0;
  if ((rows[0]?.length ?? 0) !== columns) return { shape: 'column-count' };
  // One numeric column, every value a constant multiple of the gold's: a grain error.
  // Two rows at least: a single wrong value is equally well explained by a factor, so a
  // one-row case has no evidence for the grain reading and is left as a value error.
  if (columns === 1 && rows.length > 1) {
    const factors = rows.map((row, index) => {
      const mine = Number(row[0]);
      const theirs = Number(gold[index]?.[0]);
      return typeof row[0] === 'number' && Number.isFinite(theirs) && theirs !== 0 ? mine / theirs : Number.NaN;
    });
    const first = factors[0];
    if (first !== undefined && Number.isFinite(first) && Math.abs(first - 1) > 1e-9 && factors.every((factor) => Math.abs(factor - first) < 1e-9)) {
      return { shape: 'scale', factor: first };
    }
  }
  return { shape: 'values' };
}

/**
 * The literals the gold statement names and the prediction does not.
 *
 * A statement can be structurally right and answer a different question because one
 * filter compares against a value the question did not spell the way the data stores it.
 * That hypothesis has a signature that costs nothing to check: the gold statement mentions
 * a literal the prediction never writes.
 *
 * Numbers are only counted when they stand alone, because `t2` and `col_3` are identifiers
 * and a detector that reads them as values would report a miss on every joined query.
 */
export function missingLiterals(goldSql: string, predictedSql: string): string[] {
  const gold = literals(goldSql);
  const predicted = new Set(literals(predictedSql).map(normalise));
  return [...gold].filter((literal) => !predicted.has(normalise(literal)));
}

function literals(sql: string): string[] {
  // Source order, so a report of missing literals reads in the order the gold wrote them.
  const found: { at: number; text: string }[] = [];
  const strings = /'([^']*)'/g;
  for (let match = strings.exec(sql); match !== null; match = strings.exec(sql)) found.push({ at: match.index, text: `'${match[1] as string}'` });
  const numbers = /(?<![\w.])(-?\d+(?:\.\d+)?)(?![\w.])/g;
  for (let match = numbers.exec(sql); match !== null; match = numbers.exec(sql)) found.push({ at: match.index, text: match[1] as string });
  return found.sort((left, right) => left.at - right.at).map((entry) => entry.text);
}

function normalise(literal: string): string {
  if (literal.startsWith("'")) return literal.toLowerCase();
  const value = Number(literal);
  return Number.isFinite(value) ? String(value) : literal.toLowerCase();
}
