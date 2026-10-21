import { describe, expect, it } from 'vitest';
import { CONNECTORS, connectorFor, describeConnector, redactConnection, requiresWrite } from '../src/connectors.js';

/**
 * A connector is a promise about a remote system, and the promise has to be
 * testable without that system. These tests pin the parts that must hold for
 * every engine: identifiers are quoted the way the engine quotes them, a
 * read-only connection refuses writes, and a credential never reaches a log.
 */
describe('the six connectors', () => {
  it('covers the engines a customer will actually point at', () => {
    expect(Object.keys(CONNECTORS).sort()).toEqual(['bigquery', 'duckdb', 'mysql', 'postgres', 'snowflake', 'sqlite']);
  });

  it('quotes identifiers the way each engine does', () => {
    expect(connectorFor('postgres').quote('order date')).toBe('"order date"');
    expect(connectorFor('mysql').quote('order date')).toBe('`order date`');
    expect(connectorFor('snowflake').quote('order date')).toBe('"order date"');
    expect(connectorFor('bigquery').quote('order date')).toBe('`order date`');
    expect(connectorFor('sqlite').quote('order date')).toBe('"order date"');
    expect(connectorFor('duckdb').quote('order date')).toBe('"order date"');
  });

  it('escapes the quote character instead of rejecting the name', () => {
    expect(connectorFor('postgres').quote('we"ird')).toBe('"we""ird"');
    expect(connectorFor('mysql').quote('we`ird')).toBe('`we``ird`');
  });

  it('caps rows with the syntax every engine supports', () => {
    for (const kind of Object.keys(CONNECTORS) as (keyof typeof CONNECTORS)[]) {
      expect(connectorFor(kind).limit('select 1', 10), kind).toBe('select 1 limit 10');
    }
  });

  it('states whether the engine can attach another database file', () => {
    expect(connectorFor('duckdb').attach).toBe(true);
    expect(connectorFor('sqlite').attach).toBe(true);
    expect(connectorFor('postgres').attach).toBe(false);
    expect(connectorFor('mysql').attach).toBe(false);
  });

  it('rejects an unknown engine instead of guessing', () => {
    expect(() => connectorFor('oracle' as never)).toThrow(/unknown connector/);
  });
});

describe('read-only enforcement', () => {
  it('recognises the statements that write', () => {
    for (const sql of ['insert into t values (1)', 'update t set a = 1', 'delete from t', 'create table x (a int)', 'drop table t', 'truncate t']) {
      expect(requiresWrite(sql), sql).toBe(true);
    }
  });

  it('accepts a select, including one that starts with a comment', () => {
    expect(requiresWrite('select 1')).toBe(false);
    expect(requiresWrite('  -- note\n select 1')).toBe(false);
    expect(requiresWrite('with x as (select 1) select * from x')).toBe(false);
  });
});

describe('credentials', () => {
  it('removes a password from a connection string', () => {
    expect(redactConnection('postgres://analyst:s3cret@db.internal:5432/sales')).toBe('postgres://analyst:***@db.internal:5432/sales');
  });

  it('leaves a credential-free string alone', () => {
    expect(redactConnection('postgres://db.internal:5432/sales')).toBe('postgres://db.internal:5432/sales');
  });

  it('never prints a token that arrives as a query parameter', () => {
    expect(redactConnection('postgres://db/sales?user=a&password=s3cret')).toBe('postgres://db/sales?user=a&password=***');
  });

  it('describes a connector without its credentials', () => {
    const text = describeConnector('postgres', 'postgres://analyst:s3cret@db:5432/sales');
    expect(text).toBe('postgres (postgres://analyst:***@db:5432/sales), read-only');
    expect(text).not.toContain('s3cret');
  });

  it('states read-only in the description for every connector', () => {
    for (const kind of Object.keys(CONNECTORS) as (keyof typeof CONNECTORS)[]) {
      expect(describeConnector(kind, 'x')).toContain('read-only');
    }
  });
});
