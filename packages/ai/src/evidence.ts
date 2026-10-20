/**
 * Evidence from data, not from the dataset.
 *
 * BIRD ships an `evidence` sentence per question. A customer database does not,
 * so a product that depends on it has not solved the problem — it has borrowed a
 * label. This module builds the same kind of hint from the data itself: which
 * values a categorical column actually contains, which range a date or number
 * covers. That is what an analyst writes in a data dictionary, and it is exactly
 * the information a question like "in 2012" or "completed orders" needs.
 *
 * The renderer is pure and testable. The profiling queries live in the harness
 * (`eval/bird/profile.ts`) because they need a database.
 */

import { words } from './text.js';

export type ProfileKind = 'categorical' | 'date' | 'numeric' | 'other';

export interface ColumnProfile {
  readonly table: string;
  readonly column: string;
  readonly kind: ProfileKind;
  /** Categorical values, already ordered by frequency then value. */
  readonly values?: readonly string[];
  readonly distinct?: number;
  readonly min?: string | number;
  readonly max?: string | number;
}

export interface DatabaseProfile {
  readonly db: string;
  readonly columns: readonly ColumnProfile[];
}

export interface EvidenceOptions {
  /** Hard character budget; the block is cut at the last complete line. */
  readonly maxChars?: number;
  /** Values shown per categorical column. */
  readonly maxValues?: number;
  /**
   * Question text. Columns whose names it mentions are rendered first, so a
   * tight budget is spent on the columns the question is actually about. Order
   * only: nothing is dropped that would otherwise fit.
   */
  readonly focus?: string;
}

const KIND_LABEL: Record<ProfileKind, string> = {
  categorical: 'values',
  date: 'dates',
  numeric: 'numbers',
  other: 'values',
};

/**
 * Dictionaries before ranges. A character budget spent on "id: numbers from 1 to
 * 25" is a budget not spent on "status: values (completed, refunded)", which is
 * the line a question actually needs.
 */
const KIND_ORDER: Record<ProfileKind, number> = { categorical: 0, date: 1, numeric: 2, other: 3 };

/** One line per informative column, nothing else. */
function lineOf(column: ColumnProfile, maxValues: number): string | undefined {
  const qualified = `${column.table}.${column.column}`;
  if (column.kind === 'categorical' && column.values !== undefined && column.values.length > 0) {
    const values = column.values.slice(0, maxValues).join(', ');
    return `${qualified}: ${column.values.length} ${KIND_LABEL.categorical} (${values})`;
  }
  if (column.kind === 'date' && column.min !== undefined && column.max !== undefined) {
    return `${qualified}: ${KIND_LABEL.date} from ${String(column.min)} to ${String(column.max)}`;
  }
  if (column.kind === 'numeric' && column.min !== undefined && column.max !== undefined) {
    return `${qualified}: ${KIND_LABEL.numeric} from ${String(column.min)} to ${String(column.max)}`;
  }
  return undefined;
}

/**
 * Stable reorder by how many of the question's words appear in the column name.
 * A stable sort keeps the kind-based order for the columns the question does not
 * mention, so the only change is that relevant lines move to the front.
 */
function prioritize(columns: readonly ColumnProfile[], focus: string): ColumnProfile[] {
  const asked = new Set(words(focus));
  const hits = (column: ColumnProfile): number =>
    [...new Set(words(column.column))].filter((word) => asked.has(word)).length;
  return [...columns].sort((left, right) => hits(right) - hits(left));
}

/**
 * Render a compact data dictionary. Columns that carry no usable signal (a
 * primary key, a free-text field, a column with thousands of distinct values) are
 * dropped by the profiler and never reach this function.
 */
export function renderEvidence(profile: DatabaseProfile, options: EvidenceOptions = {}): string {
  const maxChars = options.maxChars ?? 1200;
  const maxValues = options.maxValues ?? 8;
  const lines: string[] = [];
  let used = 'Data profile:'.length;
  const ordered = [...profile.columns].sort(
    (left, right) =>
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      left.table.localeCompare(right.table) ||
      left.column.localeCompare(right.column),
  );
  const focused = options.focus === undefined ? ordered : prioritize(ordered, options.focus);
  for (const column of focused) {
    const line = lineOf(column, maxValues);
    if (line === undefined) continue;
    if (used + line.length + 3 > maxChars) break;
    lines.push(`- ${line}`);
    used += line.length + 3;
  }
  if (lines.length === 0) return '';
  return ['Data profile:', ...lines].join('\n');
}
