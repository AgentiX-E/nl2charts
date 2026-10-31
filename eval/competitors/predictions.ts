/**
 * Reading a competitor's predictions, in the three shapes competitors actually emit.
 *
 * This exists because the shape of a prediction file is where a comparison quietly changes its
 * denominator. A run that answered 300 of 498 questions and got 290 of them right is 58%
 * accurate and 97% accurate depending on which denominator is used, and only one of those is
 * comparable to a number measured over all 498. So the parser does not return a list of
 * statements: it returns a ledger of what the file contained, what it left out, and what it
 * contradicted, and `score.ts` prints the answered share beside the accuracy.
 *
 * The three shapes:
 *
 * 1. `{"12": "select …\t----- bird -----\tcalifornia_schools"}` — the map CHESS writes to
 *    `-predictions.json`, keyed by question id.
 * 2. JSON Lines of records — what MAC-SQL appends, with `idx`, `query`, `db_id` and `pred`.
 * 3. `[["How many …?", "select …\t----- bird -----\tdb"]]` — the official BIRD evaluation
 *    format, keyed by question *text* because it has no id field. A wrong text in this shape
 *    silently becomes a missing answer, so the text is matched exactly and reported when it is
 *    not found rather than being fuzzy-matched into a neighbouring question.
 *
 * The `----- bird -----` payload carries a second coordinate nobody checks: the database id. A
 * statement scored against the wrong database is a wrong answer that looks like a right one, so
 * a declared database that disagrees with the question's own is recorded.
 */

/** The questions a prediction file is being read against. */
export interface PredictionQuestion {
  readonly id: number;
  /** Only the text-keyed format needs it, and only BIRD questions have one. */
  readonly question?: string;
  readonly db?: string;
}

export interface Prediction {
  readonly id: number;
  readonly sql: string;
  readonly db?: string;
}

/** Something the file contained that could not be read, with the position it was found at. */
export interface PredictionDrop {
  readonly where: string;
  readonly why: string;
}

export interface DatabaseMismatch {
  readonly id: number;
  readonly declared: string;
  readonly expected: string;
}

export interface PredictionLedger {
  readonly predictions: readonly Prediction[];
  /** How many questions the run was supposed to answer. */
  readonly declared: number;
  /** How many it answered with a non-empty statement. */
  readonly answered: number;
  /** Questions with no entry at all. */
  readonly missing: readonly number[];
  /** Questions whose entry was present and blank: the model produced nothing. */
  readonly empty: readonly number[];
  /** Ids that appear more than once; the last one is kept, because these files are appended. */
  readonly duplicates: readonly number[];
  /** Ids that are not in the question set at all. */
  readonly unknown: readonly number[];
  readonly databaseMismatch: readonly DatabaseMismatch[];
  readonly drops: readonly PredictionDrop[];
}

const BIRD_MARKER = '----- bird -----';

const ID_KEYS = ['idx', 'id', 'question_id', 'questionId'] as const;
const SQL_KEYS = ['pred', 'sql', 'predicted_sql', 'prediction', 'SQL', 'query_sql'] as const;
const DB_KEYS = ['db_id', 'db', 'database'] as const;
const TEXT_KEYS = ['query', 'question'] as const;

/**
 * A BIRD prediction payload: the statement, and — when the file uses the official separator —
 * the database it was written against.
 */
export function splitBirdPayload(raw: string): { readonly sql: string; readonly db?: string } {
  const at = raw.indexOf(BIRD_MARKER);
  if (at === -1) return { sql: raw.trim() };
  const sql = raw.slice(0, at).trim();
  const db = raw.slice(at + BIRD_MARKER.length).replace(/^[\s-]+/, '').trim();
  return db.length === 0 ? { sql } : { sql, db };
}

interface RawRecord {
  readonly where: string;
  readonly id?: number;
  readonly text?: string;
  readonly sql?: string;
  readonly db?: string;
}

function numericId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** One record from the record shapes: an object with an id, a text or both, plus a statement. */
function recordFromObject(value: Record<string, unknown>, where: string): RawRecord {
  let id: number | undefined;
  for (const key of ID_KEYS) {
    const candidate = numericId(value[key]);
    if (candidate !== undefined) {
      id = candidate;
      break;
    }
  }
  let sql: string | undefined;
  for (const key of SQL_KEYS) {
    const candidate = textValue(value[key]);
    if (candidate !== undefined) {
      sql = candidate;
      break;
    }
  }
  let db: string | undefined;
  for (const key of DB_KEYS) {
    const candidate = textValue(value[key]);
    if (candidate !== undefined) {
      db = candidate;
      break;
    }
  }
  let text: string | undefined;
  for (const key of TEXT_KEYS) {
    const candidate = textValue(value[key]);
    if (candidate !== undefined) {
      text = candidate;
      break;
    }
  }
  return {
    where,
    ...(id === undefined ? {} : { id }),
    ...(sql === undefined ? {} : { sql }),
    ...(db === undefined ? {} : { db }),
    ...(text === undefined ? {} : { text }),
  };
}


/**
 * Whether an object is a record rather than a map from question id to statement.
 *
 * The two shapes are both JSON objects, and the difference is a field name: a record carries one of
 * the id, statement or text keys. A map carries question ids as keys, so it carries none of them.
 */
function looksLikeRecord(value: Record<string, unknown>): boolean {
  const keys = [...ID_KEYS, ...SQL_KEYS, ...TEXT_KEYS];
  return keys.some((key) => key in value);
}

/** Turns the text of a predictions file into raw records, or says why it could not. */
function readRecords(text: string, drops: PredictionDrop[]): RawRecord[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    drops.push({ where: 'file', why: 'is empty' });
    return [];
  }
  let whole: unknown;
  try {
    whole = JSON.parse(trimmed);
  } catch {
    return readLines(trimmed, drops);
  }
  if (Array.isArray(whole)) return readArray(whole, drops);
  if (whole !== null && typeof whole === 'object') {
    // A one-record file is a legal JSON Lines file with one line, and its keys are field names
    // rather than question ids. Without this the map shape swallows it and reports `pred` as a
    // question id that is not a number, which is a true statement about the wrong reading.
    const record = whole as Record<string, unknown>;
    if (looksLikeRecord(record)) return [recordFromObject(record, 'record')];
    return Object.entries(record).flatMap(([key, value]) => {
      const id = numericId(key);
      if (id === undefined) {
        drops.push({ where: `key "${key}"`, why: 'is not a question id' });
        return [];
      }
      const sql = textValue(value);
      // A `null` or an empty string here is the map's way of saying "no answer", and the id is
      // still known, so it is recorded as blank rather than dropped as unreadable.
      return [{ where: `key "${key}"`, id, sql: sql ?? '' }];
    });
  }
  drops.push({ where: 'file', why: 'is JSON but neither an array nor an object' });
  return [];
}

function readLines(text: string, drops: PredictionDrop[]): RawRecord[] {
  const out: RawRecord[] = [];
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        drops.push({ where: `line ${String(index + 1)}`, why: 'is not a record' });
        return;
      }
      out.push(recordFromObject(parsed as Record<string, unknown>, `line ${String(index + 1)}`));
    } catch {
      drops.push({ where: `line ${String(index + 1)}`, why: 'is not JSON' });
    }
  });
  return out;
}

function readArray(entries: readonly unknown[], drops: PredictionDrop[]): RawRecord[] {
  const out: RawRecord[] = [];
  entries.forEach((entry, index) => {
    const where = `entry ${String(index)}`;
    if (Array.isArray(entry)) {
      const [text, payload] = entry as [unknown, unknown];
      const key = textValue(text);
      const value = textValue(payload);
      if (key === undefined || value === undefined) {
        drops.push({ where, why: 'is not a [question, prediction] pair' });
        return;
      }
      // The official format has no id, so the question text is the key. `score.ts` resolves it
      // against the question set; an unmatched text is a missing answer, not a fencepost slip.
      out.push({ where, text: key, sql: value });
      return;
    }
    if (entry !== null && typeof entry === 'object') {
      out.push(recordFromObject(entry as Record<string, unknown>, where));
      return;
    }
    drops.push({ where, why: 'is neither a pair nor a record' });
  });
  return out;
}

/**
 * Whether a question set can be keyed by text at all.
 *
 * BIRD's own conventions: two questions in a split do not share a text. When they do, a
 * predicate on the pair is a coin toss, so the ambiguity is reported instead of resolved.
 */
function textIndex(questions: readonly PredictionQuestion[]): {
  readonly byId: Map<number, PredictionQuestion>;
  readonly byText: Map<string, PredictionQuestion>;
  readonly ambiguous: Set<string>;
} {
  const byId = new Map<number, PredictionQuestion>();
  const byText = new Map<string, PredictionQuestion>();
  const ambiguous = new Set<string>();
  for (const question of questions) {
    byId.set(question.id, question);
    if (question.question === undefined) continue;
    if (byText.has(question.question)) ambiguous.add(question.question);
    else byText.set(question.question, question);
  }
  return { byId, byText, ambiguous };
}

/**
 * The ledger for one predictions file.
 *
 * `questions` is the run's whole question set, not the answered subset: the denominator of a
 * comparable accuracy is fixed by the design, and a parser that only saw answered ids could not
 * report what was left out.
 */
export function parsePredictions(
  text: string,
  questions: readonly PredictionQuestion[],
): PredictionLedger {
  const drops: PredictionDrop[] = [];
  const { byId, byText, ambiguous } = textIndex(questions);
  const records = readRecords(text, drops);

  const kept = new Map<number, Prediction>();
  const duplicates: number[] = [];
  const unknown: number[] = [];
  const empty: number[] = [];
  const databaseMismatch: DatabaseMismatch[] = [];

  for (const record of records) {
    let id = record.id;
    if (id === undefined && record.text !== undefined) {
      if (ambiguous.has(record.text)) {
        drops.push({ where: record.where, why: 'names a question text that is not unique in this split' });
        continue;
      }
      const matched = byText.get(record.text);
      if (matched === undefined) {
        drops.push({ where: record.where, why: `names a question that is not in this split: "${record.text.slice(0, 60)}"` });
        continue;
      }
      id = matched.id;
    }
    if (id === undefined) {
      drops.push({ where: record.where, why: 'names no question' });
      continue;
    }
    const question = byId.get(id);
    if (question === undefined) {
      unknown.push(id);
      continue;
    }
    const payload = splitBirdPayload(record.sql ?? '');
    const declaredDb = payload.db ?? record.db;
    const expected = question.db;
    if (declaredDb !== undefined && expected !== undefined && declaredDb !== expected) {
      databaseMismatch.push({ id, declared: declaredDb, expected });
    }
    if (payload.sql.length === 0) {
      // A retry that came back blank is the answer, not a missing one: keeping the earlier
      // statement would report a run that ends with nothing as a run that answered.
      kept.delete(id);
      empty.push(id);
      continue;
    }
    // Appended files resume rather than rewrite, so a repeated id means the later answer is the
    // one that finished. Keeping the first would report a run half-way through its retry.
    if (kept.has(id)) duplicates.push(id);
    kept.set(id, {
      id,
      sql: payload.sql,
      ...(declaredDb === undefined ? {} : { db: declaredDb }),
    });
  }

  const predictions = [...kept.values()].sort((left, right) => left.id - right.id);
  const answered = new Set(predictions.map((prediction) => prediction.id));
  const blank = new Set(empty.filter((id) => !answered.has(id)));
  const missing = questions
    .map((question) => question.id)
    .filter((id) => !answered.has(id) && !blank.has(id))
    .sort((left, right) => left - right);

  return {
    predictions,
    declared: questions.length,
    answered: predictions.length,
    missing,
    empty: [...blank].sort((left, right) => left - right),
    duplicates: [...new Set(duplicates)].sort((left, right) => left - right),
    unknown: [...new Set(unknown)].sort((left, right) => left - right),
    databaseMismatch,
    drops,
  };
}
