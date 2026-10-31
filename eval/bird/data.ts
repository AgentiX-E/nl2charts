/**
 * BIRD Mini-Dev dataset readers.
 *
 * Everything here is pure: JSON and CSV in, typed records out. The benchmark
 * runner does the I/O, so these functions can be unit tested against small
 * fixtures without a database or a model.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SchemaColumn, SchemaTable } from '@agentix-e/nl2charts-ai';

export type Difficulty = 'simple' | 'moderate' | 'challenging';

export interface BirdQuestion {
  readonly question_id: number;
  readonly db_id: string;
  readonly question: string;
  readonly evidence: string;
  readonly SQL: string;
  readonly difficulty: Difficulty;
}

/**
 * `dev_tables.json` entry, trimmed to what a prompt can use.
 *
 * `columnNames` holds the **original** identifiers, the ones the SQLite file
 * actually has. `columnNamesReadable` holds BIRD's humanised labels
 * (`client segment` for `Segment`). Using the humanised list as the schema card
 * is a measured defect: the first external run advertised 155 of 200 cases with
 * column names the database does not contain, and the model dutifully copied
 * them into `no such column` errors.
 */
export interface BirdTable {
  readonly db_id: string;
  readonly tableNames: readonly string[];
  readonly tableNamesReadable: readonly string[];
  readonly columnNames: readonly (readonly [number, string])[];
  readonly columnNamesReadable: readonly (readonly [number, string])[];
  readonly columnTypes: readonly string[];
  readonly foreignKeys: readonly (readonly [number, number])[];
}

export interface ColumnNote {
  readonly description?: string;
  readonly values?: string;
}

/** RFC 4180 parsing: quoted fields, embedded commas and newlines, doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (quoted) {
      if (character === '"') {
        if (text.charAt(index + 1) === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (character !== '\r') {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The rows a question file holds, exactly as written: no filtering, no collapse. */
export function loadQuestions(file: string): BirdQuestion[] {
  return JSON.parse(readFileSync(file, 'utf8')) as BirdQuestion[];
}

/**
 * One question id carried by more than one row.
 *
 * `positions` are zero-based row positions in file order, so a repeat can be looked up rather than
 * described. There is no `identical` flag because a repeat that is not identical is refused below:
 * every repeat this type describes is a byte-for-byte duplicate.
 */
export interface QuestionRepeat {
  readonly id: number;
  readonly positions: readonly number[];
}

/**
 * The pool a rate is computed over: one row per question id.
 *
 * A question file is a list of rows, and a list of rows is not always a list of questions.
 * Mini-Dev carries 500 rows and 498 question ids, because ids 137 and 138 each appear twice, byte
 * for byte — a fact no count in this repository had noticed until a 500-question run was paired
 * against a pipeline that numbers its answers by row, which is a renumbering that can only be
 * stated if position and question are in one-to-one correspondence.
 *
 * Every rate here is per question, so the pool is read one row per id and the repetition is
 * reported rather than absorbed: a question counted twice is a question weighted twice, and the
 * denominator then depends on a file artifact instead of on the benchmark. Measured on the twelve
 * arms of CI run 41158744927, collapsing the two repeats moves no arm by more than 0.18pp — the
 * same size as the harness's own A/A noise — but the label "498 questions" was two questions and
 * one twice.
 *
 * Two rows with one id and different content are refused: there the id names two questions, so it
 * cannot be the key a pairing is joined on, and both id-keyed readers (`predictions.ts` for a
 * competitor's answers, `caseRows` for ours) would silently keep one of them and drop the other.
 */
export interface QuestionSet {
  readonly questions: BirdQuestion[];
  readonly rows: number;
  readonly repeats: readonly QuestionRepeat[];
}

/**
 * A stable key for "is this the same record": key order in the file is not a difference.
 *
 * `Object.keys(...).sort()` is the default lexical order, so there is no comparator here to get
 * subtly wrong — the first version had a three-way comparator whose middle case (two equal keys)
 * cannot happen, and a branch that cannot happen is a line no test can reach.
 */
const recordKey = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(recordKey).join(',')}]`;
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${recordKey(record[key])}`)
    .join(',');
  return `{${body}}`;
};

/** The first field two records disagree on, for a repeat that is not a duplicate. */
const firstDifference = (left: Record<string, unknown>, right: Record<string, unknown>): string => {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const key of keys) {
    if (recordKey(left[key]) !== recordKey(right[key])) return key;
  }
  return 'no field differs';
};

export function distinctQuestions(rows: readonly BirdQuestion[]): QuestionSet {
  const kept: BirdQuestion[] = [];
  const firstAt = new Map<number, number>();
  const positions = new Map<number, number[]>();
  for (const [index, row] of rows.entries()) {
    const at = firstAt.get(row.question_id);
    if (at === undefined) {
      firstAt.set(row.question_id, kept.length);
      kept.push(row);
    } else if (recordKey(kept[at]) !== recordKey(row)) {
      const first = kept[at] as unknown as Record<string, unknown>;
      const again = row as unknown as Record<string, unknown>;
      throw new Error(
        `question ${String(row.question_id)} appears at rows ${String(positions.get(row.question_id)?.[0])} and ` +
          `${String(index)} with different content (${firstDifference(first, again)}), so the id names two questions ` +
          'and cannot be the key a pairing is joined on',
      );
    }
    const seen = positions.get(row.question_id);
    if (seen === undefined) positions.set(row.question_id, [index]);
    else seen.push(index);
  }
  const repeats: QuestionRepeat[] = [];
  for (const [id, at] of positions) {
    if (at.length > 1) repeats.push({ id, positions: at });
  }
  repeats.sort((left, right) => left.id - right.id);
  return { questions: kept, rows: rows.length, repeats };
}

/**
 * The line that states the pool above the rates computed from it.
 *
 * Identical wording wherever a question set is read, so the two pipelines in a comparison cannot
 * describe the same file differently.
 */
export function describeQuestionSet(set: QuestionSet, split: string): string {
  const repeats = set.repeats.map((repeat) => String(repeat.id));
  return (
    `${split}: ${String(set.rows)} row(s), ${String(set.questions.length)} question(s)` +
    (repeats.length === 0
      ? ''
      : ` — ${repeats.join(', ')} repeat${repeats.length === 1 ? 's' : ''} byte-for-byte and ${repeats.length === 1 ? 'is' : 'are'} counted once`)
  );
}

/** A question file read as a pool: rows in, one row per question id out. */
export function loadQuestionSet(file: string): QuestionSet {
  return distinctQuestions(loadQuestions(file));
}

export function loadTables(file: string): Map<string, BirdTable> {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    db_id: string;
    table_names: string[];
    table_names_original?: string[];
    column_names: [number, string][];
    column_names_original?: [number, string][];
    column_types: string[];
    foreign_keys: [number, number][];
  }[];
  return new Map(
    raw.map((entry) => [
      entry.db_id,
      {
        db_id: entry.db_id,
        tableNames: entry.table_names_original ?? entry.table_names,
        tableNamesReadable: entry.table_names,
        columnNames: entry.column_names_original ?? entry.column_names,
        columnNamesReadable: entry.column_names,
        columnTypes: entry.column_types,
        foreignKeys: entry.foreign_keys,
      },
    ]),
  );
}

const TYPES: Record<string, string> = { text: 'VARCHAR', integer: 'BIGINT', real: 'DOUBLE', number: 'DOUBLE' };

export function sqlType(native: string): string {
  return TYPES[native.toLowerCase()] ?? native.toUpperCase();
}

/**
 * Read `<db>/database_description/*.csv` into a per-column note. The first row is
 * the header; every file describes one table. Unknown columns are ignored.
 */
export function loadDescriptions(directory: string, tableNames: readonly string[]): Map<string, Map<string, ColumnNote>> {
  const notes = new Map<string, Map<string, ColumnNote>>();
  for (const table of tableNames) {
    let text: string;
    try {
      text = readFileSync(join(directory, `${table}.csv`), 'utf8');
    } catch {
      continue;
    }
    const [header, ...rows] = parseCsv(text);
    if (header === undefined) continue;
    const nameAt = header.findIndex((cell) => cell.trim() === 'original_column_name');
    const descriptionAt = header.findIndex((cell) => cell.trim() === 'column_description');
    const valuesAt = header.findIndex((cell) => cell.trim() === 'value_description');
    const columns = new Map<string, ColumnNote>();
    for (const row of rows) {
      const name = row[nameAt]?.trim();
      if (name === undefined || name.length === 0) continue;
      const description = clean(row[descriptionAt]);
      const values = clean(row[valuesAt]);
      if (description === undefined && values === undefined) continue;
      columns.set(name, {
        ...(description === undefined ? {} : { description }),
        ...(values === undefined ? {} : { values }),
      });
    }
    notes.set(table, columns);
  }
  return notes;
}

/** Dataset descriptions embed newlines and markdown; a prompt needs one line. */
function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return undefined;
  return flat.length > 180 ? `${flat.slice(0, 177)}...` : flat;
}

/**
 * Turn one database into the schema card input.
 *
 * `withNotes` decides whether column comments and join hints are attached, which
 * is exactly the ablation under test: the same questions, the same model, and
 * only the metadata differs.
 */
export function buildSchema(
  table: BirdTable,
  notes: Map<string, Map<string, ColumnNote>>,
  options: { readonly withNotes: boolean },
): SchemaTable[] {
  const readableName = (columnIndex: number): string | undefined => {
    const entry = table.columnNamesReadable[columnIndex];
    const candidate = entry?.[1];
    const original = table.columnNames[columnIndex]?.[1];
    return candidate === undefined || candidate === original ? undefined : candidate;
  };

  const columnsOf = (tableIndex: number): SchemaColumn[] => {
    const columns: SchemaColumn[] = [];
    table.columnNames.forEach((entry, columnIndex) => {
      const [owner, name] = entry;
      if (owner !== tableIndex || name === '*') return;
      const note = notes.get(table.tableNames[tableIndex] as string)?.get(name);
      const label = readableName(columnIndex);
      const parts = [
        ...(options.withNotes && label !== undefined ? [label] : []),
        ...(options.withNotes && note !== undefined ? [commentOf(note) as string] : []),
      ];
      columns.push({
        name,
        type: sqlType(table.columnTypes[columnIndex] ?? 'text'),
        ...(parts.length === 0 ? {} : { comment: parts.join(' - ') }),
      });
    });
    return columns;
  };

  return table.tableNames.map((name, tableIndex) => {
    const hints = options.withNotes
      ? table.foreignKeys
          .filter(([from]) => table.columnNames[from]?.[0] === tableIndex)
          .map(([from, to]) => {
            const left = table.columnNames[from] as readonly [number, string];
            const right = table.columnNames[to] as readonly [number, string];
            return `${name}.${left[1]} = ${table.tableNames[right[0]] as string}.${right[1]}`;
          })
      : [];
    return {
      table: name,
      columns: columnsOf(tableIndex),
      ...(hints.length === 0 ? {} : { foreignKeys: hints }),
    };
  });
}

function commentOf(note: ColumnNote): string | undefined {
  if (note.description === undefined) return note.values;
  if (note.values === undefined) return note.description;
  return `${note.description} (${note.values})`;
}

/**
 * A stable 32-bit mix of one integer (the finalizer murmur3 uses).
 *
 * The sample has to be a function of the question id alone — same input, same sample, on any
 * machine, forever — while being uncorrelated with the id itself, and ascending ids are not that.
 * BIRD's dev file is grouped by database, so "the first 73 simple questions" is "the first
 * databases": the 120-question runs of this benchmark scored **2 of 11 databases**, with
 * `california_schools` at 74% of the sample against 5.8% of the split. FNV-1a over the decimal id
 * fails the same test more subtly — a contiguous block of ids keeps neighbouring hashes, which
 * put 45 of 73 simple picks in one database — so the order is this mixer, which avalanches.
 */
function mix32(value: number): number {
  let hash = (value + 0x9e3779b9) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97) >>> 0;
  return (hash ^ (hash >>> 15)) >>> 0;
}

/**
 * Deterministic sample that keeps the split's difficulty mix and does not take the head of the file.
 *
 * Two biases lived here, and the second was the larger one:
 *
 * 1. **Allocation.** Quotas are proportional to each difficulty's share, floored, with the
 *    leftover slots going to the largest fractional parts. Equal allocation — one case per bucket,
 *    round after round — is what this function used to do while its comment claimed the mix was
 *    kept: on dev (60.3% simple, 30.2% moderate, 9.5% challenging) it made 120 questions 40/40/40,
 *    over-weighting the hardest bucket by 3.5x.
 * 2. **Order within a bucket.** The buckets were consumed in ascending id, and dev's file is grouped
 *    by database, so a sample was a prefix of the file: 2 of 11 databases, `california_schools` at
 *    74% against 5.8%. That is why a 120-question run reported 49.2% where the full split reports
 *    63.0%. The order is now `mix32(question_id)`, which keeps determinism and drops the
 *    correlation: a 120-question dev sample covers 11 of 11 databases within 2.1pp of their shares.
 *
 * The remainder pass also covers the two edge cases the round-robin needed care for: a bucket
 * smaller than its quota gives the surplus to the others, and a difficulty value this build does
 * not know files with the moderates instead of being dropped.
 */
export function stratifiedSample(questions: readonly BirdQuestion[], limit: number): BirdQuestion[] {
  if (limit >= questions.length) return [...questions];
  const buckets: Record<Difficulty, BirdQuestion[]> = { simple: [], moderate: [], challenging: [] };
  for (const question of questions) (buckets[question.difficulty] ?? buckets.moderate).push(question);
  for (const bucket of Object.values(buckets)) {
    bucket.sort((left, right) => mix32(left.question_id) - mix32(right.question_id) || left.question_id - right.question_id);
  }
  const order: Difficulty[] = ['simple', 'moderate', 'challenging'];
  const ideal: Record<Difficulty, number> = { simple: 0, moderate: 0, challenging: 0 };
  const counts: Record<Difficulty, number> = { simple: 0, moderate: 0, challenging: 0 };
  for (const difficulty of order) ideal[difficulty] = (limit * buckets[difficulty].length) / questions.length;
  for (const difficulty of order) counts[difficulty] = Math.floor(ideal[difficulty]);
  let leftover = limit - (counts.simple + counts.moderate + counts.challenging);
  const byFraction = [...order].sort(
    (left, right) =>
      ideal[right] - counts[right] - (ideal[left] - counts[left]) || order.indexOf(left) - order.indexOf(right),
  );
  for (const difficulty of byFraction) {
    if (leftover <= 0) break;
    const room = buckets[difficulty].length - counts[difficulty];
    const give = Math.min(room, leftover);
    counts[difficulty] += give;
    leftover -= give;
  }
  return order
    .flatMap((difficulty) => buckets[difficulty].slice(0, counts[difficulty]))
    .sort((left, right) => left.question_id - right.question_id);
}
