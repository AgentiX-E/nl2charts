/**
 * Does the result have the shape the question asked for?
 *
 * A statement can execute and still be wrong in a way the engine will never report: "how
 * many schools are in Los Angeles" answered with a list of 1,436 schools' names is a clean
 * query with the wrong shape. BIRD's judge catches it as a mismatch, but the repair loop
 * never sees it — there was no error to feed back.
 *
 * This module supplies the missing signal. It is deliberately conservative: only questions
 * that ask for one value are checked, and only when the result is not one row by one
 * column. A question that legitimately wants many rows is never touched.
 */
export type ExpectedShape = 'scalar' | 'any';

/**
 * Questions that ask for a single number, date or name.
 *
 * The patterns are anchored on the phrasing BIRD actually uses, not on a general model of
 * English: "how many", "what is the", "what percentage", "what is the ratio", "count",
 * "average", "which year/quarter". Anything else is left alone.
 */
const SCALAR_PATTERNS: readonly RegExp[] = [
  /\bhow many\b/i,
  /\bhow much\b/i,
  /\bwhat (is|was) the (number|total|average|mean|count|percentage|percent|ratio|share|rate|amount)\b/i,
  /\bwhat percentage\b/i,
  /\bwhat (is|was) the (name|id|year|date|title|price|salary|age|population|revenue|capacity)\b/i,
  /\b(percentage|proportion|ratio|share) of\b/i,
  /\b(which|what) (year|month|day|quarter)\b/i,
  /\bwhat is the (most|least|highest|lowest|largest|smallest|maximum|minimum)\b/i,
  /\baverage\b/i,
  /\btotal (number|amount|revenue|salary|cost)\b/i,
];

/** A trailing plural noun is the strongest signal that many rows are wanted. */
const PLURAL_PATTERNS: readonly RegExp[] = [
  /\b(list|show|give|find|display|return)\b.*\b(all|each|every)\b/i,
  /\bwhat are the\b/i,
  /\bwhich (are|were)\b/i,
  /\bnames? of\b/i,
  /\b(top|bottom) \d+\b/i,
];

export function expectedShape(question: string): ExpectedShape {
  // "List all the schools" beats "how many": a plural request is explicit about wanting rows.
  for (const pattern of PLURAL_PATTERNS) if (pattern.test(question)) return 'any';
  for (const pattern of SCALAR_PATTERNS) if (pattern.test(question)) return 'scalar';
  return 'any';
}

export interface ResultShape {
  readonly rows: number;
  readonly columns: number;
}

export function shapeOf(rows: readonly (readonly unknown[])[]): ResultShape {
  return { rows: rows.length, columns: rows[0]?.length ?? 0 };
}

/**
 * True when a scalar question got something a person would not read as one value.
 *
 * An empty result is not a shape error: "nothing matched" is an answer of the right shape,
 * and telling the model to aggregate differently would be advice about a question that has
 * no rows. A single row with several columns is a shape error — the model returned a
 * record where a value was asked for.
 */
export function shapeMismatch(question: string, rows: readonly (readonly unknown[])[]): boolean {
  if (expectedShape(question) !== 'scalar') return false;
  const shape = shapeOf(rows);
  if (shape.rows === 0) return false;
  return shape.rows !== 1 || shape.columns !== 1;
}

/** The message the repair loop reads; the diagnoser classifies it by its prefix. */
export function shapeFailure(rows: readonly (readonly unknown[])[]): string {
  const shape = shapeOf(rows);
  return `shape: the question asks for a single value, but the statement returned ${String(shape.rows)} row(s) and ${String(shape.columns)} column(s)`;
}
