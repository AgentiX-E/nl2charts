import { describe, expect, it } from 'vitest';
import type { DatabaseProfile } from '@agentix-e/nl2charts-ai';
import {
  canonicalColumn,
  extractGoldFields,
  goldKeys,
  resolveBareColumns,
  type GoldField,
} from '../eval/bird/gold-fields.js';

/**
 * The gold a pairing pricing gate reads must come from the question's gold SQL, not from a
 * token-overlap proxy over the question text. `referencedFields` gives two shapes — qualified
 * `alias.column` pairs whose alias is resolved, and bare identifiers that still need the card.
 * This harness resolves both against the profile so the resulting keys are in the same canonical
 * `table.column` space the retrieval arms use. These tests pin the resolution, never a score.
 */

const profile: DatabaseProfile = {
  db: 'frpm',
  columns: [
    { table: 'frpm', column: 'County Name', kind: 'categorical', values: ['Alameda', 'Berkeley'] },
    { table: 'frpm', column: 'Free Meal Count (K-12)', kind: 'numeric' },
    { table: 'frpm', column: 'Enrollment (K-12)', kind: 'numeric' },
    { table: 'frpm', column: 'CDSCode', kind: 'other' },
    { table: 'sat', column: 'County Name', kind: 'categorical', values: ['Alameda'] },
    { table: 'sat', column: 'Score', kind: 'numeric' },
  ],
};

const asGold = (fields: readonly GoldField[]) => fields.map((f) => `${f.table}.${f.column}`);

describe('canonicalColumn', () => {
  it('finds the canonical table/column for a lower-cased qualified pair', () => {
    expect(canonicalColumn('frpm', 'county name', profile)).toEqual({ table: 'frpm', column: 'County Name' });
  });

  it('matches a canonical table case-insensitively', () => {
    expect(canonicalColumn('FRPM', 'enrollment (k-12)', profile)).toEqual({ table: 'frpm', column: 'Enrollment (K-12)' });
  });

  it('returns undefined when the column is not in the table', () => {
    expect(canonicalColumn('frpm', 'score', profile)).toBeUndefined();
  });

  it('never attributes a column to the wrong table', () => {
    // `Score` exists on `sat` but not `frpm`; a qualifier of `frpm` must not borrow it.
    expect(canonicalColumn('frpm', 'score', profile)).toBeUndefined();
  });
});

describe('resolveBareColumns', () => {
  it('assigns a bare column to the only table that owns it', () => {
    const out = resolveBareColumns(['score'], profile, ['sat']);
    expect(asGold(out)).toEqual(['sat.Score']);
  });

  it('drops SQL keywords that are not profile columns', () => {
    const out = resolveBareColumns(['select', 'from', 'where', 'as', 'real', 'limit'], profile, ['frpm']);
    expect(out).toEqual([]);
  });

  it('keeps only names the named tables actually own', () => {
    const out = resolveBareColumns(['county name', 'score', 'order'], profile, ['frpm']);
    // `frpm` owns County Name; `Score` belongs to `sat`, not the named table; `order` is a keyword.
    expect(asGold(out)).toEqual(['frpm.County Name']);
  });

  it('expands an ambiguous bare column across every named table that owns it', () => {
    // Both `frpm` and `sat` own `County Name`; with both tables named, neither can be dropped.
    const out = resolveBareColumns(['county name'], profile, ['frpm', 'sat']);
    expect(asGold(out)).toEqual(['frpm.County Name', 'sat.County Name']);
  });

  it('resolves across all profile tables when no table list is given', () => {
    const out = resolveBareColumns(['county name'], profile);
    expect(asGold(out)).toEqual(['frpm.County Name', 'sat.County Name']);
  });

  it('deduplicates a bare name repeated in the statement', () => {
    const out = resolveBareColumns(['county name', 'county name'], profile, ['frpm']);
    expect(asGold(out)).toEqual(['frpm.County Name']);
  });

  it('lower-cases the incoming identifier before matching', () => {
    const out = resolveBareColumns(['County Name'], profile, ['frpm']);
    expect(asGold(out)).toEqual(['frpm.County Name']);
  });

  it('deduplicates when the profile repeats the same table/column row', () => {
    // A malformed profile with a duplicate row must not duplicate a gold field.
    const duplicated: DatabaseProfile = {
      db: 'x',
      columns: [
        { table: 'frpm', column: 'County Name', kind: 'categorical' },
        { table: 'frpm', column: 'County Name', kind: 'categorical' },
      ],
    };
    expect(asGold(resolveBareColumns(['county name'], duplicated, ['frpm']))).toEqual(['frpm.County Name']);
  });
});

describe('extractGoldFields', () => {
  it('extracts canonical fields from a quoted, unqualified BIRD-style statement', () => {
    // This is the shape that defeated the token-overlap proxy: every column is a quoted bare
    // identifier, and `referencedFields` reports them only in `bare`.
    const sql = 'SELECT `Free Meal Count (K-12)` / `Enrollment (K-12)` FROM frpm WHERE `County Name` = \'Alameda\'';
    const out = asGold(extractGoldFields(sql, profile));
    expect(out).toEqual([
      'frpm.County Name',
      'frpm.Enrollment (K-12)',
      'frpm.Free Meal Count (K-12)',
    ]);
  });

  it('extracts a qualified pair through its resolved alias', () => {
    const sql = 'SELECT f.`County Name` FROM frpm AS f JOIN sat s ON s.`County Name` = f.`County Name`';
    const out = asGold(extractGoldFields(sql, profile));
    expect(out).toContain('frpm.County Name');
    expect(out).toContain('sat.County Name');
  });

  it('unions qualified and bare fields without duplicating a field found both ways', () => {
    const sql = 'SELECT f.`County Name`, `Free Meal Count (K-12)` FROM frpm f';
    const out = asGold(extractGoldFields(sql, profile));
    expect(out).toEqual(['frpm.County Name', 'frpm.Free Meal Count (K-12)']);
  });

  it('deduplicates a field written once qualified and once bare', () => {
    // The same column appears as `f.\u0060County Name\u0060` and as a bare `\u0060County Name\u0060`.
    const sql = 'SELECT f.`County Name` FROM frpm f WHERE `County Name` = \'Alameda\'';
    const out = asGold(extractGoldFields(sql, profile));
    expect(out).toEqual(['frpm.County Name']);
  });

  it('keeps an unresolvable qualified pair lower-cased rather than dropping it', () => {
    // A CTE column has no profile row. Dropping it would understate gold coverage; inventing a
    // canonical name would be worse. The stable lower-cased key is the honest middle.
    const sql = 'WITH t AS (SELECT 1 AS x) SELECT c.x FROM t c';
    const out = asGold(extractGoldFields(sql, profile));
    expect(out).toContain('t.x');
  });

  it('returns no fields for an empty statement', () => {
    expect(extractGoldFields('', profile)).toEqual([]);
  });

  it('returns no fields for a statement naming only keywords', () => {
    expect(extractGoldFields('SELECT 1', profile)).toEqual([]);
  });

  it('is stable and deduplicated across repeated runs', () => {
    const sql = 'SELECT `County Name`, `County Name` FROM frpm';
    const first = asGold(extractGoldFields(sql, profile));
    const second = asGold(extractGoldFields(sql, profile));
    expect(first).toEqual(second);
    expect(first).toEqual(['frpm.County Name']);
  });
});

describe('goldKeys', () => {
  it('returns the same keys as extractGoldFields in a Set', () => {
    const sql = 'SELECT `County Name` FROM frpm';
    expect([...goldKeys(sql, profile)]).toEqual(asGold(extractGoldFields(sql, profile)));
  });

  it('is empty for a statement with no resolvable fields', () => {
    expect(goldKeys('SELECT 1', profile).size).toBe(0);
  });
});
