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

/** `dev_tables.json` entry, trimmed to what a prompt can use. */
export interface BirdTable {
  readonly db_id: string;
  readonly tableNames: readonly string[];
  readonly columnNames: readonly (readonly [number, string])[];
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

export function loadQuestions(file: string): BirdQuestion[] {
  return JSON.parse(readFileSync(file, 'utf8')) as BirdQuestion[];
}

export function loadTables(file: string): Map<string, BirdTable> {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    db_id: string;
    table_names: string[];
    column_names: [number, string][];
    column_types: string[];
    foreign_keys: [number, number][];
  }[];
  return new Map(
    raw.map((entry) => [
      entry.db_id,
      {
        db_id: entry.db_id,
        tableNames: entry.table_names,
        columnNames: entry.column_names,
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
  const columnsOf = (tableIndex: number): SchemaColumn[] => {
    const columns: SchemaColumn[] = [];
    table.columnNames.forEach((entry, columnIndex) => {
      const [owner, name] = entry;
      if (owner !== tableIndex || name === '*') return;
      const note = notes.get(table.tableNames[tableIndex] as string)?.get(name);
      const comment = options.withNotes && note !== undefined ? commentOf(note) : undefined;
      columns.push({
        name,
        type: sqlType(table.columnTypes[columnIndex] ?? 'text'),
        ...(comment === undefined ? {} : { comment }),
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
 * Deterministic stratified sample: round-robin over the three difficulty
 * buckets, each sorted by question id. A limit of 200 therefore keeps the
 * difficulty mix instead of taking whatever happens to be first in the file.
 */
export function stratifiedSample(questions: readonly BirdQuestion[], limit: number): BirdQuestion[] {
  if (limit >= questions.length) return [...questions];
  const buckets: Record<Difficulty, BirdQuestion[]> = { simple: [], moderate: [], challenging: [] };
  for (const question of questions) (buckets[question.difficulty] ?? buckets.moderate).push(question);
  for (const bucket of Object.values(buckets)) bucket.sort((left, right) => left.question_id - right.question_id);
  const order: Difficulty[] = ['simple', 'moderate', 'challenging'];
  const picked: BirdQuestion[] = [];
  let round = 0;
  while (picked.length < limit) {
    let progressed = false;
    for (const difficulty of order) {
      const candidate = buckets[difficulty][round];
      if (candidate === undefined) continue;
      picked.push(candidate);
      progressed = true;
      if (picked.length === limit) break;
    }
    if (!progressed) break;
    round += 1;
  }
  return picked;
}
