import { describe, expect, it } from 'vitest';
import { readDriverError } from '../src/engine-error.js';

describe('reading a driver error', () => {
  it('keeps a PostgreSQL error to its SQLSTATE, position and hint', () => {
    const error = Object.assign(new Error('column s.schoolname does not exist'), {
      code: '42703',
      position: 40,
      hint: 'Perhaps you meant to reference the column "s.SchoolName".',
      detail: 'Failing row contains (1, null).',
    });
    expect(readDriverError(error)).toEqual({
      message: 'column s.schoolname does not exist',
      code: '42703',
      // A five-character code from PostgreSQL *is* the SQLSTATE; deriving it means a
      // caller does not have to know which driver produced the error.
      sqlState: '42703',
      position: 40,
      hint: 'Perhaps you meant to reference the column "s.SchoolName".',
      detail: 'Failing row contains (1, null).',
    });
  });

  it('reads mysql2, whose message lives in sqlMessage and whose code is not a SQLSTATE', () => {
    const error = Object.assign(new Error('ER_BAD_FIELD_ERROR: Unknown column'), {
      code: 'ER_BAD_FIELD_ERROR',
      errno: 1054,
      sqlState: '42S22',
      sqlMessage: "Unknown column 'regionn' in 'field list'",
    });
    const fields = readDriverError(error);
    expect(fields.message).toBe("Unknown column 'regionn' in 'field list'");
    expect(fields.sqlState).toBe('42S22');
    expect(fields.code).toBe('ER_BAD_FIELD_ERROR');
  });

  it('reads SQLite, which only has a message', () => {
    const error = Object.assign(new Error('no such column: regionn'), { code: 'SQLITE_ERROR' });
    const fields = readDriverError(error);
    expect(fields.message).toBe('no such column: regionn');
    // `SQLITE_ERROR` is eleven characters: calling it a SQLSTATE would invent one.
    expect(fields.sqlState).toBeUndefined();
    expect(fields.position).toBeUndefined();
  });

  it('reads an offset when that is the field the driver uses', () => {
    expect(readDriverError(Object.assign(new Error('x'), { offset: 12 })).position).toBe(12);
  });

  it('never throws on something that is not an error', () => {
    expect(readDriverError('plain').message).toBe('plain');
    expect(readDriverError(42).message).toBe('42');
    expect(readDriverError({}).message.length).toBeGreaterThan(0);
    // A zero position is not a position: PostgreSQL sends 0 for "unknown", and a caret
    // under the first character would be a claim about a place the engine never named.
    expect(readDriverError({ message: 'x', position: 0 }).position).toBeUndefined();
  });

  it('drops empty strings rather than passing them on as fields', () => {
    const fields = readDriverError({ message: 'x', code: '  ', hint: '' });
    expect(fields.code).toBeUndefined();
    expect(fields.hint).toBeUndefined();
  });
});
