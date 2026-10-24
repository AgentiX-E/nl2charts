import { describe, expect, it } from 'vitest';
import { diagnoseFailure, readEngineError } from '../src/diagnose.js';
import type { SchemaTable } from '../src/linking.js';

const schema: SchemaTable[] = [
  {
    table: 'students',
    columns: [
      { name: 'StudentID', type: 'INTEGER' },
      { name: 'StudentName', type: 'TEXT' },
      { name: 'Class', type: 'TEXT' },
      { name: 'SchoolName', type: 'TEXT' },
    ],
  },
  {
    table: 'schools',
    columns: [
      { name: 'SchoolID', type: 'INTEGER' },
      { name: 'SchoolName', type: 'TEXT' },
      { name: 'District', type: 'TEXT' },
    ],
  },
];

const sql = "SELECT s.StudentID FROM students s WHERE s.Schoolname = 'x'";

describe('reading what the driver actually said', () => {
  it('prefers the structured fields an adapter preserved', () => {
    const error = Object.assign(new Error('wrapped'), {
      details: {
        engine: 'postgres',
        engineError: {
          message: 'column s.schoolname does not exist',
          code: '42703',
          sqlState: '42703',
          position: 40,
          hint: 'Perhaps you meant to reference the column "s.SchoolName".',
        },
      },
    });
    const fields = readEngineError(error);
    expect(fields.message).toContain('does not exist');
    expect(fields.sqlState).toBe('42703');
    expect(fields.position).toBe(40);
    expect(fields.hint).toContain('Perhaps');
  });

  it('reads a bare driver error, which is what most callers pass', () => {
    const error = Object.assign(new Error('no such column: x'), { code: 'SQLITE_ERROR', sqliteErrorCode: 1 });
    const fields = readEngineError(error);
    expect(fields.message).toBe('no such column: x');
    // `code` is not a SQLSTATE here, and pretending it is would put a five-letter
    // SQLSTATE into a message about SQLite.
    expect(fields.sqlState).toBeUndefined();
    expect(fields.code).toBe('SQLITE_ERROR');
  });

  it('never throws on a value that is not an error at all', () => {
    expect(readEngineError('plain string').message).toBe('plain string');
    expect(readEngineError(undefined).message.length).toBeGreaterThan(0);
  });
});

describe('classifying the failure', () => {
  const kind = (message: string, extra: Record<string, unknown> = {}): string =>
    diagnoseFailure({ sql, schema, dialect: 'SQLite', error: Object.assign(new Error(message), extra) }).failureClass;

  it('separates a binding failure from a syntax failure', () => {
    expect(kind('no such column: s.Schoolname')).toBe('binding');
    expect(kind('no such table: studnets')).toBe('binding');
    expect(kind('near "WHERE": syntax error')).toBe('syntax');
    expect(kind('Parser Error: syntax error at or near ")"')).toBe('syntax');
  });

  it('separates the failure classes whose fixes differ', () => {
    expect(kind('ambiguous column name: SchoolName')).toBe('ambiguity');
    expect(kind('misuse of aggregate: count()')).toBe('grouping');
    expect(kind('column "students.Class" must appear in the GROUP BY clause')).toBe('grouping');
    expect(kind('operator does not exist: text + integer')).toBe('type');
    expect(kind('attempt to write a readonly database')).toBe('permission');
    expect(kind('interrupted')).toBe('timeout');
    expect(kind('something nobody has seen before')).toBe('unknown');
  });

  it('classifies a guard refusal as a guard, not as an engine error', () => {
    const diagnosis = diagnoseFailure({
      sql,
      schema,
      dialect: 'SQLite',
      guard: { reason: 'banned-keyword', detail: '"delete" is not allowed' },
    });
    expect(diagnosis.failureClass).toBe('guard');
    expect(diagnosis.feedback).toContain('banned-keyword');
    expect(diagnosis.feedback).toContain('read-only');
  });
});

describe('what the model is told the second time', () => {
  it('quotes the column that does not exist and the one that does', () => {
    const diagnosis = diagnoseFailure({ sql, schema, dialect: 'SQLite', error: new Error('no such column: s.Schoolname') });
    expect(diagnosis.suggestions).toContain('students.SchoolName');
    expect(diagnosis.feedback).toContain('Schoolname');
    expect(diagnosis.feedback).toContain('students.SchoolName');
    // The instruction is about the failure, not about trying again.
    expect(diagnosis.feedback).not.toMatch(/try again/i);
  });

  it('prefers the table the statement qualified, not a same-named column elsewhere', () => {
    const diagnosis = diagnoseFailure({
      sql: "SELECT s.StudentID FROM students s WHERE s.Schoolname = 'x'",
      schema,
      dialect: 'SQLite',
      error: new Error('no such column: s.Schoolname'),
    });
    // Both tables have SchoolName; the qualifier `s` was bound to students, and a
    // suggestion from `schools` would send the repair to the wrong relation.
    expect(diagnosis.suggestions[0]).toBe('students.SchoolName');
  });

  it('lists the columns of the table it could not read', () => {
    const diagnosis = diagnoseFailure({ sql, schema, dialect: 'SQLite', error: new Error('no such column: students.Nickname') });
    expect(diagnosis.feedback).toContain('StudentName');
    expect(diagnosis.feedback).toContain('Class');
  });

  it('says there is no close match instead of offering a bad one', () => {
    const diagnosis = diagnoseFailure({ sql, schema, dialect: 'SQLite', error: new Error('no such column: students.Zzzzzzzz') });
    expect(diagnosis.suggestions).toEqual([]);
    expect(diagnosis.feedback).toMatch(/no column .* is close/i);
  });

  it('shows the statement with a caret under the position the engine reported', () => {
    const error = Object.assign(new Error('syntax error at or near "FROM"'), { position: 17 });
    const diagnosis = diagnoseFailure({ sql: 'SELECT COUNT(*) FROM students', schema, dialect: 'PostgreSQL', error });
    expect(diagnosis.feedback).toContain('FROM');
    expect(diagnosis.feedback).toMatch(/\n\s*\^/);
    // The caret is placed by the reported position, not by the first occurrence.
    const caret = diagnosis.feedback.split('\n').find((line) => line.trim().startsWith('^')) as string;
    expect(caret.indexOf('^')).toBe(16);
  });

  it('carries the SQLSTATE and the engine hint through', () => {
    const error = Object.assign(new Error('column s.schoolname does not exist'), {
      code: '42703',
      sqlState: '42703',
      hint: 'Perhaps you meant to reference the column "s.SchoolName".',
    });
    const diagnosis = diagnoseFailure({ sql, schema, dialect: 'PostgreSQL', error });
    expect(diagnosis.feedback).toContain('42703');
    expect(diagnosis.feedback).toContain('Perhaps you meant');
    expect(diagnosis.sqlState).toBe('42703');
  });

  it('keeps the feedback bounded even when the schema is enormous', () => {
    const wide: SchemaTable[] = [
      {
        table: 'wide',
        columns: Array.from({ length: 400 }, (_, index) => ({ name: `column_${String(index)}`, type: 'TEXT' })),
      },
    ];
    const diagnosis = diagnoseFailure({ sql, schema: wide, dialect: 'SQLite', error: new Error('no such column: wide.column_399x') });
    expect(diagnosis.feedback.length).toBeLessThanOrEqual(900);
    expect(diagnosis.feedback).not.toContain('undefined');
  });

  it('is deterministic, so a snapshot of the feedback means something', () => {
    const once = diagnoseFailure({ sql, schema, dialect: 'SQLite', error: new Error('no such column: s.Schoolname') });
    const twice = diagnoseFailure({ sql, schema, dialect: 'SQLite', error: new Error('no such column: s.Schoolname') });
    expect(once.feedback).toBe(twice.feedback);
  });

  it('gives each class an instruction that matches the class', () => {
    const grouping = diagnoseFailure({
      sql,
      schema,
      dialect: 'MySQL',
      error: new Error('Expression #2 of SELECT list is not in GROUP BY clause'),
    });
    expect(grouping.feedback).toMatch(/GROUP BY/);
    const timeout = diagnoseFailure({ sql, schema, dialect: 'SQLite', error: new Error('interrupted') });
    expect(timeout.feedback).toMatch(/filter|aggregate/i);
  });
});

describe('the shapes a driver actually sends', () => {
  it('reads mysql2, where the sentence is in sqlMessage and the code is not a SQLSTATE', () => {
    const error = Object.assign(new Error("ER_BAD_FIELD_ERROR: Unknown column 'regionn' in 'field list'"), {
      code: 'ER_BAD_FIELD_ERROR',
      sqlState: '42S22',
      sqlMessage: "Unknown column 'regionn' in 'field list'",
    });
    const diagnosis = diagnoseFailure({ sql, schema, dialect: 'MySQL', error });
    expect(diagnosis.failureClass).toBe('binding');
    expect(diagnosis.feedback).toContain('42S22');
    expect(diagnosis.feedback).toContain('regionn');
  });

  it('carries the engine detail line when there is one', () => {
    const error = Object.assign(new Error('column s.schoolname does not exist'), { detail: 'Failing row contains (1, null).' });
    expect(diagnoseFailure({ sql, schema, dialect: 'PostgreSQL', error }).feedback).toContain('Failing row contains');
  });

  it('places no caret when the reported position is past the statement', () => {
    const error = Object.assign(new Error('syntax error'), { position: 500 });
    const diagnosis = diagnoseFailure({ sql, schema, dialect: 'PostgreSQL', error });
    expect(diagnosis.feedback).not.toMatch(/\n\s*\^/);
  });

  it('suggests a table when the table is what is missing', () => {
    const diagnosis = diagnoseFailure({ sql, schema, dialect: 'SQLite', error: new Error('no such table: studnets') });
    expect(diagnosis.suggestions).toContain('students');
  });

  it('names the dialect when a function does not exist there', () => {
    const diagnosis = diagnoseFailure({ sql, schema, dialect: 'SQLite', error: new Error('no such function: COUNTIF') });
    expect(diagnosis.feedback).toContain('COUNTIF');
    expect(diagnosis.feedback).toContain('SQLite has no function');
  });

  it('says nothing about identifiers when the message names none', () => {
    const diagnosis = diagnoseFailure({ sql, schema, dialect: 'DuckDB', error: new Error('Binder Error: no matching function') });
    expect(diagnosis.suggestions).toEqual([]);
    expect(diagnosis.feedback).not.toContain('No column');
  });

  it('does not treat a clause keyword as an alias', () => {
    // `FROM students WHERE ...` must not bind `where` to `students`, or the suggestion
    // scope would be wrong in exactly the statements that have no alias.
    const diagnosis = diagnoseFailure({
      sql: 'SELECT Schoolname FROM students WHERE id = 1',
      schema,
      dialect: 'SQLite',
      error: new Error('no such column: students.Schoolname'),
    });
    expect(diagnosis.suggestions).toContain('students.SchoolName');
  });

  it('falls back to the whole schema when the qualifier is not a table', () => {
    const diagnosis = diagnoseFailure({
      sql: 'SELECT x.Schoolname FROM students',
      schema,
      dialect: 'SQLite',
      error: new Error('no such column: x.Schoolname'),
    });
    expect(diagnosis.suggestions.length).toBeGreaterThan(0);
  });

  it('does not dump the whole schema when the failure named no table', () => {
    // On a real database this produced `The schema has: id, alignment, id,
    // attribute_name, …` — eight names from five tables, which competes with the
    // question and identifies nothing.
    const diagnosis = diagnoseFailure({ sql, schema, dialect: 'SQLite', error: new Error('no such column: Schoolname') });
    expect(diagnosis.feedback).not.toContain('The schema has:');
    expect(diagnosis.suggestions.length).toBeGreaterThan(0);
  });

  it('scopes to the one relation the statement reads', () => {
    const diagnosis = diagnoseFailure({
      sql: 'SELECT StudentID FROM students WHERE Nickname = 1',
      schema,
      dialect: 'SQLite',
      error: new Error('no such column: Nickname'),
    });
    expect(diagnosis.feedback).toContain('`students` has:');
  });

  it('does not scope when the statement joins two relations', () => {
    // With two relations, a bare column name could belong to either, and picking one
    // would be a guess dressed as a diagnosis.
    const diagnosis = diagnoseFailure({
      sql: 'SELECT s.StudentID FROM students s JOIN schools c ON s.SchoolName = c.SchoolName WHERE Nickname = 1',
      schema,
      dialect: 'SQLite',
      error: new Error('no such column: Nickname'),
    });
    expect(diagnosis.feedback).not.toContain('has:');
  });

  it('never suggests the name the engine just rejected', () => {
    // `no such table: hero_attribute` used to answer "closest identifier:
    // hero_attribute" — the same word, offered back as the fix.
    const diagnosis = diagnoseFailure({ sql, schema, dialect: 'SQLite', error: new Error('no such table: students') });
    expect(diagnosis.suggestions).not.toContain('students');
    // And it says so, instead of leaving the model to guess whether a near spelling
    // exists.
    expect(diagnosis.feedback).toMatch(/No table .* is close/);
  });
});

describe('the raw baseline', () => {
  const fields = { message: 'no such column: s.Schoolname', sqlState: '42703' };
  const error = Object.assign(new Error(fields.message), { code: fields.sqlState, sqlState: fields.sqlState });

  it('sends the engine sentence and nothing else', () => {
    const raw = diagnoseFailure({ sql, schema, dialect: 'PostgreSQL', error, mode: 'raw' });
    // Verbatim, including the SQLSTATE the engine attached: the raw mode exists to be
    // the control, so it must not quietly include any of the diagnosis.
    expect(raw.feedback).toBe('42703: no such column: s.Schoolname');
    expect(raw.suggestions).toEqual([]);
    expect(raw.feedback).not.toMatch(/Closest identifier|Use only tables|Fix exactly/);
  });

  it('still classifies, because the artifact is compared per class either way', () => {
    expect(diagnoseFailure({ sql, schema, dialect: 'PostgreSQL', error, mode: 'raw' }).failureClass).toBe('binding');
  });

  it('is bounded like the diagnosed form', () => {
    const long = Object.assign(new Error('x'.repeat(5000)), {});
    expect(diagnoseFailure({ sql, schema, dialect: 'SQLite', error: long, mode: 'raw' }).feedback.length).toBeLessThanOrEqual(900);
  });

  it('is strictly shorter than the diagnosed form on the same failure', () => {
    const diagnosed = diagnoseFailure({ sql, schema, dialect: 'PostgreSQL', error });
    const raw = diagnoseFailure({ sql, schema, dialect: 'PostgreSQL', error, mode: 'raw' });
    expect(raw.feedback.length).toBeLessThan(diagnosed.feedback.length);
    expect(diagnosed.feedback).toContain(fields.message);
  });
});
