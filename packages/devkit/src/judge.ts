/**
 * Execution judges for external text-to-SQL benchmarks.
 *
 * BIRD's official `calculate_ex` is `set(predicted_res) == set(ground_truth_res)`
 * over `cursor.fetchall()` tuples (mini_dev `evaluation/evaluation_ex.py`). That
 * means: column count and column order matter, row order does not, aliases are
 * irrelevant because tuples carry no names, and **duplicate rows collapse**.
 * The last part is a loophole: a four-row answer containing one duplicate can
 * equal a three-row gold answer. We implement the official rule for
 * comparability and a strict multiset rule beside it, so the loophole is
 * measured instead of hidden.
 */

/** One result row, already projected onto column order. */
export type Tuple = readonly unknown[];

export interface SqlResultSet {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}

export type MatchReason = 'match' | 'column-count' | 'values';

/** Project named rows onto ordered tuples: order and duplicates survive. */
export function toTuples(result: SqlResultSet): readonly Tuple[] {
  return result.rows.map((row) => result.columns.map((column) => row[column] ?? null));
}

function normalise(value: unknown): string {
  if (value === null || value === undefined) return '\u0000null';
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? `n:${Number(value)}` : `n:${value.toString()}`;
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'n:NaN';
    // -0 and 0 are the same value in SQL arithmetic; Python's set() agrees.
    return `n:${Object.is(value, -0) ? 0 : value}`;
  }
  if (typeof value === 'boolean') return `b:${value}`;
  if (value instanceof Uint8Array) return `x:${Buffer.from(value).toString('base64')}`;
  return `s:${String(value)}`;
}

function keyOf(tuple: Tuple): string {
  return tuple.map(normalise).join('\u0001');
}

/**
 * Column width is only observable through a row, so an empty result is compared
 * by cardinality alone — which is exactly what the official `set()` comparison
 * does: two empty results are equal whatever their columns.
 */
function shapeDiffers(gold: readonly Tuple[], predicted: readonly Tuple[]): MatchReason | undefined {
  if (gold.length === 0 || predicted.length === 0) {
    return gold.length === predicted.length ? undefined : 'values';
  }
  return gold[0]?.length === predicted[0]?.length ? undefined : 'column-count';
}

/**
 * BIRD official execution accuracy: `set(...)` on both sides.
 */
export function judgeOfficial(gold: readonly Tuple[], predicted: readonly Tuple[]): MatchReason {
  const shape = shapeDiffers(gold, predicted);
  if (shape !== undefined) return shape;
  const goldSet = new Set(gold.map(keyOf));
  const predictedSet = new Set(predicted.map(keyOf));
  if (goldSet.size !== predictedSet.size) return 'values';
  for (const key of goldSet) if (!predictedSet.has(key)) return 'values';
  return 'match';
}

/**
 * Multiset execution accuracy: same tuples, same multiplicities. Not the
 * official rule; it is the rule a careful reader would write, and the gap
 * between the two is exactly the number of cases the official judge credits
 * because of collapsed duplicates.
 */
export function judgeStrict(gold: readonly Tuple[], predicted: readonly Tuple[]): MatchReason {
  const shape = shapeDiffers(gold, predicted);
  if (shape !== undefined) return shape;
  const counts = (rows: readonly Tuple[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const tuple of rows) {
      const key = keyOf(tuple);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  };
  const goldCounts = counts(gold);
  const predictedCounts = counts(predicted);
  if (goldCounts.size !== predictedCounts.size) return 'values';
  for (const [key, expected] of goldCounts) {
    if (predictedCounts.get(key) !== expected) return 'values';
  }
  return 'match';
}

/** Convenience wrappers for in-process engines that return named rows. */
export function judgeOfficialResult(gold: SqlResultSet, predicted: SqlResultSet): MatchReason {
  return judgeOfficial(toTuples(gold), toTuples(predicted));
}

export function judgeStrictResult(gold: SqlResultSet, predicted: SqlResultSet): MatchReason {
  return judgeStrict(toTuples(gold), toTuples(predicted));
}
