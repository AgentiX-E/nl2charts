import { describe, expect, it } from 'vitest';
import { groundLiteralCase } from '../eval/bird/literal-repair.js';
import type { ColumnDomain } from '../eval/bird/literal-repair.js';

const school: ColumnDomain = { table: 'frpm', column: 'School Type', values: ['Continuation School', 'Elementary School'] };
const status: ColumnDomain = { table: 'schools', column: 'status', values: ['Active', 'Pending'] };

describe('groundLiteralCase', () => {
  it('rewrites a literal that the column stores in another case', () => {
    const result = groundLiteralCase(`select * from frpm where "School Type" = 'continuation school'`, [school]);
    expect(result.sql).toBe(`select * from frpm where "School Type" = 'Continuation School'`);
    expect(result.substitutions).toEqual([{ literal: 'continuation school', value: 'Continuation School', table: 'frpm', column: 'School Type' }]);
  });

  it('leaves a literal the column already stores exactly', () => {
    const sql = `select * from frpm where "School Type" = 'Continuation School'`;
    expect(groundLiteralCase(sql, [school])).toEqual({ sql, substitutions: [] });
  });

  it('does not invent a value the column does not store', () => {
    const sql = "select * from frpm where \"School Type\" = 'charter'";
    expect(groundLiteralCase(sql, [school])).toEqual({ sql, substitutions: [] });
  });

  it('refuses when two stored values differ only in case', () => {
    const sql = "select * from t where s = 'pending'";
    expect(groundLiteralCase(sql, [{ table: 't', column: 's', values: ['Pending', 'PENDING'] }])).toEqual({ sql, substitutions: [] });
  });

  it('refuses when two columns with that name store different spellings', () => {
    const sql = "select * from a join b on b.id = a.id where status = 'pending'";
    const domains: ColumnDomain[] = [
      { table: 'a', column: 'status', values: ['Pending'] },
      { table: 'b', column: 'status', values: ['pending up'] },
    ];
    expect(groundLiteralCase(sql, domains).substitutions).toEqual([]);
  });

  it('fires when two columns with that name agree on the spelling', () => {
    const sql = "select * from a join b on b.id = a.id where status = 'pending'";
    const domains: ColumnDomain[] = [
      { table: 'a', column: 'status', values: ['Pending'] },
      { table: 'b', column: 'status', values: ['Pending', 'Done'] },
    ];
    expect(groundLiteralCase(sql, domains).sql).toContain("'Pending'");
  });

  it('trusts the qualifier over a same-named column in another table', () => {
    const sql = `select * from frpm f join schools s on s.cdscode = f."CDSCode" where s.status = 'pending'`;
    const result = groundLiteralCase(sql, [school, status]);
    expect(result.substitutions).toHaveLength(1);
    expect(result.substitutions[0]).toMatchObject({ table: 'schools', column: 'status', value: 'Pending' });
  });

  it('resolves an alias to its table', () => {
    const sql = `select * from frpm as f where f."School Type" = 'elementary school'`;
    expect(groundLiteralCase(sql, [school]).substitutions[0]).toMatchObject({ table: 'frpm', value: 'Elementary School' });
  });

  it('leaves a like pattern alone', () => {
    const sql = `select * from frpm where "School Type" like 'continuation school'`;
    expect(groundLiteralCase(sql, [school])).toEqual({ sql, substitutions: [] });
  });

  it('rewrites every member of an in list', () => {
    const sql = "select * from schools where status in ('active', 'pending')";
    expect(groundLiteralCase(sql, [status]).sql).toBe("select * from schools where status in ('Active', 'Pending')");
  });

  it('rewrites both members of a between', () => {
    const domain: ColumnDomain = { table: 'events', column: 'label', values: ['Alpha', 'Omega'] };
    const sql = "select * from events where label between 'alpha' and 'omega'";
    expect(groundLiteralCase(sql, [domain]).substitutions.map((row) => row.value)).toEqual(['Alpha', 'Omega']);
  });

  it('rewrites the right-hand side of not equal', () => {
    const sql = "select * from schools where status <> 'active'";
    expect(groundLiteralCase(sql, [status]).sql).toBe("select * from schools where status <> 'Active'");
  });

  it('applies several edits without moving the later offsets', () => {
    const sql = `select * from frpm f join schools s on s.cdscode = f."CDSCode" where f."School Type" = 'continuation school' and s.status = 'pending'`;
    const result = groundLiteralCase(sql, [school, status]);
    expect(result.sql).toBe(`select * from frpm f join schools s on s.cdscode = f."CDSCode" where f."School Type" = 'Continuation School' and s.status = 'Pending'`);
    expect(result.substitutions).toHaveLength(2);
  });

  it('escapes a quote in the stored value', () => {
    const domain: ColumnDomain = { table: 'people', column: 'street', values: ["O'Brien Rd"] };
    const sql = "select * from people where street = 'o''brien rd'";
    expect(groundLiteralCase(sql, [domain]).sql).toBe("select * from people where street = 'O''Brien Rd'");
  });

  it('does nothing with no domains', () => {
    const sql = "select * from t where a = 'x'";
    expect(groundLiteralCase(sql, [])).toEqual({ sql, substitutions: [] });
  });

  it('does nothing when the statement has no comparison', () => {
    const sql = 'select 1';
    expect(groundLiteralCase(sql, [school])).toEqual({ sql, substitutions: [] });
  });

  it('does nothing when the compared column is not in any domain', () => {
    const sql = "select * from t where other = 'x'";
    expect(groundLiteralCase(sql, [school])).toEqual({ sql, substitutions: [] });
  });

  it('is idempotent: a second pass finds nothing to fix', () => {
    const once = groundLiteralCase("select * from schools where status = 'pending'", [status]);
    const twice = groundLiteralCase(once.sql, [status]);
    expect(twice.substitutions).toEqual([]);
    expect(twice.sql).toBe(once.sql);
  });
});
